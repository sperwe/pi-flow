import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, constants, openSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  getShellConfig,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_FOREGROUND_MS = 10_000;
const DEFAULT_MAX_BACKGROUND_TASKS = 4;
const DEFAULT_TASK_WAIT_MS = 30_000;
const MAX_TASK_WAIT_MS = 60_000;
const MAX_PROCESS_TIMEOUT_MS = 2_147_483_647;
const MAX_TAIL_BYTES = 64 * 1024;
const MAX_WAKE_TEXT = 12_000;
const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
const COMPLETED_TASK_RETENTION_MS = 60 * 60 * 1000;
const PROMPT_GATE_MAX_MS = 2 * 60 * 1000;

type TaskStatus = "running" | "succeeded" | "failed" | "timed_out" | "stopped" | "aborted";

export interface BashYieldOptions {
  foregroundMs?: number;
  maxBackgroundTasks?: number;
  wakeOnCompletion?: boolean;
  taskWaitMs?: number;
}

interface BashTask {
  id: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  startedAt: number;
  detachedAt?: number;
  endedAt?: number;
  status: TaskStatus;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  timedOut: boolean;
  stopRequested: boolean;
  abortRequested: boolean;
  detached: boolean;
  collected: boolean;
  logPath: string;
  logFd: number;
  tailChunks: Buffer[];
  tailBytes: number;
  totalBytes: number;
  timeoutHandle?: NodeJS.Timeout;
  forceKillHandle?: NodeJS.Timeout;
  cleanupHandle?: NodeJS.Timeout;
  done: Promise<void>;
  resolveDone: () => void;
}

interface BashYieldDetails {
  taskId?: string;
  status?: TaskStatus;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  logPath?: string;
  totalBytes?: number;
  elapsedMs?: number;
}

const bashParameters = Type.Object(
  {
    command: Type.String({ description: "Shell command to execute" }),
    timeout: Type.Optional(
      Type.Number({
        minimum: 0.001,
        description: "Hard runtime limit in seconds. The process tree is stopped if the limit is reached.",
      }),
    ),
    run_in_background: Type.Optional(
      Type.Boolean({
        description:
          "Start in the background immediately. Usually omit this: ordinary long-running commands automatically yield to the background.",
      }),
    ),
  },
  { additionalProperties: false },
);

const taskOutputParameters = Type.Object(
  {
    task_id: Type.String({ minLength: 1, description: "Background task id returned by bash." }),
    wait: Type.Optional(
      Type.Boolean({
        description:
          "Wait once for completion when a dependent step needs the result. Do not poll repeatedly.",
      }),
    ),
    wait_timeout: Type.Optional(
      Type.Number({
        minimum: 0.001,
        maximum: MAX_TASK_WAIT_MS / 1000,
        description: `Maximum seconds to wait when wait=true (max ${MAX_TASK_WAIT_MS / 1000}).`,
      }),
    ),
  },
  { additionalProperties: false },
);

const taskStopParameters = Type.Object(
  {
    task_id: Type.String({ minLength: 1, description: "Background task id to stop." }),
  },
  { additionalProperties: false },
);

const taskListParameters = Type.Object({}, { additionalProperties: false });

function normalizePositiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function normalizeWaitMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const ms = value * 1000;
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_TASK_WAIT_MS) {
    throw new Error(`wait_timeout must be > 0 and <= ${MAX_TASK_WAIT_MS / 1000} seconds`);
  }
  return ms;
}

function sanitizeOutput(text: string): string {
  return Array.from(text)
    .filter((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (code <= 0x1f) return false;
      if (code >= 0xfff9 && code <= 0xfffb) return false;
      return true;
    })
    .join("");
}

function pushTail(task: BashTask, data: Buffer): void {
  task.totalBytes += data.byteLength;
  task.tailChunks.push(Buffer.from(data));
  task.tailBytes += data.byteLength;
  while (task.tailBytes > MAX_TAIL_BYTES && task.tailChunks.length > 0) {
    const first = task.tailChunks[0];
    const excess = task.tailBytes - MAX_TAIL_BYTES;
    if (first.byteLength <= excess) {
      task.tailChunks.shift();
      task.tailBytes -= first.byteLength;
    } else {
      task.tailChunks[0] = first.subarray(excess);
      task.tailBytes -= excess;
    }
  }
  try {
    writeSync(task.logFd, data);
  } catch {
    // The in-memory tail remains available if the temp log becomes unwritable.
  }
}

function tailText(task: BashTask): string {
  return sanitizeOutput(Buffer.concat(task.tailChunks, task.tailBytes).toString("utf8"));
}

function formatElapsed(task: BashTask): string {
  const end = task.endedAt ?? Date.now();
  const seconds = Math.max(0, end - task.startedAt) / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

function statusLabel(task: BashTask): string {
  if (task.status === "running") return "running";
  if (task.status === "succeeded") return "completed";
  if (task.status === "failed") return `failed${task.exitCode === undefined ? "" : ` (exit ${task.exitCode})`}`;
  if (task.status === "timed_out") return "timed out";
  if (task.status === "stopped") return "stopped";
  return "aborted";
}

async function waitForTask(task: BashTask, timeoutMs: number): Promise<boolean> {
  if (task.status !== "running") return true;
  let timer: NodeJS.Timeout | undefined;
  const completed = await Promise.race([
    task.done.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return completed;
}

function createLogFile(id: string): { path: string; fd: number } {
  const path = join(tmpdir(), `pi-bash-yield-${id}-${randomUUID()}.log`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  return { path, fd };
}

function scheduleLogCleanup(path: string): void {
  const timer = setTimeout(() => {
    try {
      unlinkSync(path);
    } catch {
      // Already removed or unavailable.
    }
  }, LOG_RETENTION_MS);
  timer.unref?.();
}

function makeEnvironment(ctx: ExtensionContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile) env.PI_SESSION_FILE = sessionFile;
  if (ctx.model) {
    env.PI_PROVIDER = ctx.model.provider;
    env.PI_MODEL = ctx.model.id;
  }
  if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
  return env;
}

function killProcessTree(task: BashTask, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = task.child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      task.child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      task.child.kill(signal);
    } catch {
      // Process may already have exited.
    }
  }
}

function boundedCommand(command: string): string {
  const oneLine = command.replace(/\s+/g, " ").trim();
  return oneLine.length <= 220 ? oneLine : `${oneLine.slice(0, 217)}...`;
}

function taskSnapshot(task: BashTask, includeOutput = true): string {
  const output = includeOutput ? tailText(task).trimEnd() : "";
  const truncation =
    task.totalBytes > task.tailBytes
      ? `\n[Showing last ${task.tailBytes} bytes of ${task.totalBytes}. Full output: ${task.logPath}]`
      : task.logPath
        ? `\n[Full output: ${task.logPath}]`
        : "";
  const header = `[${task.id}] ${statusLabel(task)} after ${formatElapsed(task)} — ${boundedCommand(task.command)}`;
  if (!includeOutput || !output) return `${header}${truncation}`;
  return `${header}\n${output}${truncation}`;
}

function backgroundStartResult(task: BashTask, reason: "explicit" | "yield", foregroundMs: number) {
  const output = tailText(task).trimEnd();
  const reasonText =
    reason === "explicit"
      ? "started in the background"
      : `still running after ${(foregroundMs / 1000).toFixed(foregroundMs % 1000 === 0 ? 0 : 1)}s and was moved to the background`;
  const prefix = output ? `${output}\n\n` : "";
  return {
    content: [
      {
        type: "text" as const,
        text:
          `${prefix}[${task.id}] Command ${reasonText}. Continue independent work instead of waiting or polling. ` +
          `Use task_output with wait=true only when a later step actually depends on this result. Full output: ${task.logPath}`,
      },
    ],
    details: {
      taskId: task.id,
      status: task.status,
      logPath: task.logPath,
      totalBytes: task.totalBytes,
      elapsedMs: Date.now() - task.startedAt,
    } satisfies BashYieldDetails,
  };
}

function terminalToolResult(task: BashTask) {
  return {
    content: [{ type: "text" as const, text: taskSnapshot(task) }],
    details: {
      taskId: task.id,
      status: task.status,
      exitCode: task.exitCode,
      signal: task.signal,
      logPath: task.logPath,
      totalBytes: task.totalBytes,
      elapsedMs: (task.endedAt ?? Date.now()) - task.startedAt,
    } satisfies BashYieldDetails,
  };
}

function foregroundResultOrThrow(task: BashTask) {
  const output = tailText(task).trimEnd();
  const truncation =
    task.totalBytes > task.tailBytes ? `\n\n[Full output: ${task.logPath}]` : "";
  if (task.status === "succeeded") {
    return {
      content: [{ type: "text" as const, text: `${output || "(no output)"}${truncation}` }],
      details: {
        status: task.status,
        exitCode: task.exitCode,
        logPath: task.totalBytes > task.tailBytes ? task.logPath : undefined,
        totalBytes: task.totalBytes,
        elapsedMs: (task.endedAt ?? Date.now()) - task.startedAt,
      } satisfies BashYieldDetails,
    };
  }

  const prefix = output ? `${output}\n\n` : "";
  if (task.status === "timed_out") {
    throw new Error(`${prefix}Command timed out${truncation}`);
  }
  if (task.status === "aborted") {
    throw new Error(`${prefix}Command aborted${truncation}`);
  }
  if (task.status === "stopped") {
    throw new Error(`${prefix}Command stopped${truncation}`);
  }
  if (task.error) {
    throw new Error(`${prefix}${task.error}${truncation}`);
  }
  throw new Error(
    `${prefix}Command exited with code ${task.exitCode ?? "unknown"}${task.signal ? ` (${task.signal})` : ""}${truncation}`,
  );
}

export function createBashYieldExtension(options: BashYieldOptions = {}) {
  const foregroundMs = normalizeNonNegativeInteger(
    options.foregroundMs,
    DEFAULT_FOREGROUND_MS,
    "foregroundMs",
  );
  const maxBackgroundTasks = normalizePositiveInteger(
    options.maxBackgroundTasks,
    DEFAULT_MAX_BACKGROUND_TASKS,
    "maxBackgroundTasks",
  );
  const taskWaitMs = normalizePositiveInteger(options.taskWaitMs, DEFAULT_TASK_WAIT_MS, "taskWaitMs");
  if (taskWaitMs > MAX_TASK_WAIT_MS) {
    throw new Error(`taskWaitMs must be <= ${MAX_TASK_WAIT_MS}`);
  }
  const wakeOnCompletion = options.wakeOnCompletion ?? true;

  return function bashYieldExtension(pi: ExtensionAPI): void {
    const tasks = new Map<string, BashTask>();
    const pendingWakeIds = new Set<string>();
    let nextTask = 1;
    let agentBusy = false;
    let promptPending = false;
    let promptPendingSince = 0;
    let promptGateTimer: NodeJS.Timeout | undefined;
    let compacting = false;
    let shuttingDown = false;
    let wakeTimer: NodeJS.Timeout | undefined;

    const clearPromptGateTimer = () => {
      if (!promptGateTimer) return;
      clearTimeout(promptGateTimer);
      promptGateTimer = undefined;
    };

    const openPromptGate = () => {
      promptPending = false;
      promptPendingSince = 0;
      clearPromptGateTimer();
    };

    const armPromptGateTimer = () => {
      clearPromptGateTimer();
      promptGateTimer = setTimeout(() => {
        promptGateTimer = undefined;
        if (!promptPending || compacting || agentBusy) return;
        if (Date.now() - promptPendingSince < PROMPT_GATE_MAX_MS) {
          armPromptGateTimer();
          return;
        }
        promptPending = false;
        promptPendingSince = 0;
        scheduleWake();
      }, PROMPT_GATE_MAX_MS);
      promptGateTimer.unref?.();
    };

    const activeBackgroundCount = () =>
      [...tasks.values()].filter((task) => task.detached && task.status === "running").length;

    const cancelWake = (taskId: string) => {
      pendingWakeIds.delete(taskId);
    };

    const sendPendingWake = () => {
      wakeTimer = undefined;
      if (
        shuttingDown ||
        !wakeOnCompletion ||
        agentBusy ||
        promptPending ||
        compacting ||
        pendingWakeIds.size === 0
      ) {
        return;
      }

      const ready: BashTask[] = [];
      for (const id of pendingWakeIds) {
        const task = tasks.get(id);
        if (!task || task.collected || task.stopRequested || task.status === "running") {
          pendingWakeIds.delete(id);
          continue;
        }
        ready.push(task);
      }
      if (ready.length === 0) return;

      for (const task of ready) pendingWakeIds.delete(task.id);
      let content = ready.map((task) => taskSnapshot(task)).join("\n\n");
      if (content.length > MAX_WAKE_TEXT) {
        content = `${content.slice(0, MAX_WAKE_TEXT)}\n\n[Completion notice truncated; use task_output for exact task output.]`;
      }
      pi.sendMessage(
        {
          customType: "pi-bash-yield",
          content:
            `Background shell work finished. Continue any dependent work now; do not rerun completed commands unless needed.\n\n${content}`,
          display: true,
          details: { taskIds: ready.map((task) => task.id) },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    };

    const scheduleWake = () => {
      if (!wakeOnCompletion || wakeTimer || shuttingDown) return;
      wakeTimer = setTimeout(sendPendingWake, 50);
      wakeTimer.unref?.();
    };

    const queueCompletionWake = (task: BashTask) => {
      if (!task.detached || task.collected || task.stopRequested || shuttingDown) return;
      pendingWakeIds.add(task.id);
      scheduleWake();
    };

    const finalizeTask = (
      task: BashTask,
      result: { exitCode?: number | null; signal?: NodeJS.Signals | null; error?: string },
    ) => {
      if (task.status !== "running") return;
      task.endedAt = Date.now();
      task.exitCode = result.exitCode;
      task.signal = result.signal;
      task.error = result.error;

      if (task.timedOut) task.status = "timed_out";
      else if (task.stopRequested) task.status = "stopped";
      else if (task.abortRequested) task.status = "aborted";
      else if (result.error) task.status = "failed";
      else if (result.exitCode === 0 && !result.signal) task.status = "succeeded";
      else task.status = "failed";

      if (task.timeoutHandle) clearTimeout(task.timeoutHandle);
      if (task.forceKillHandle) clearTimeout(task.forceKillHandle);
      try {
        closeSync(task.logFd);
      } catch {
        // Already closed.
      }
      scheduleLogCleanup(task.logPath);
      task.resolveDone();
      queueCompletionWake(task);

      task.cleanupHandle = setTimeout(() => {
        if (task.status !== "running") tasks.delete(task.id);
      }, COMPLETED_TASK_RETENTION_MS);
      task.cleanupHandle.unref?.();
    };

    const requestKill = (task: BashTask) => {
      if (task.status !== "running") return;
      killProcessTree(task, "SIGTERM");
      if (task.forceKillHandle) return;
      task.forceKillHandle = setTimeout(() => {
        if (task.status === "running") killProcessTree(task, "SIGKILL");
      }, 2_000);
      task.forceKillHandle.unref?.();
    };

    const spawnTask = (
      command: string,
      timeoutSeconds: number | undefined,
      ctx: ExtensionContext,
    ): BashTask => {
      if (!command.trim()) throw new Error("command must not be empty");
      if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
        throw new Error("timeout must be a positive number of seconds");
      }
      if (timeoutSeconds !== undefined && timeoutSeconds * 1000 > MAX_PROCESS_TIMEOUT_MS) {
        throw new Error(`timeout must be <= ${MAX_PROCESS_TIMEOUT_MS / 1000} seconds`);
      }

      const id = `bash_${nextTask++}`;
      const shell = getShellConfig();
      const commandFromStdin = shell.commandTransport === "stdin";
      const log = createLogFile(id);
      let child: ChildProcess;
      try {
        child = spawn(shell.shell, commandFromStdin ? shell.args : [...shell.args, command], {
          cwd: ctx.cwd,
          detached: process.platform !== "win32",
          env: makeEnvironment(ctx),
          stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        closeSync(log.fd);
        try {
          unlinkSync(log.path);
        } catch {
          // Ignore cleanup races.
        }
        throw error;
      }
      if (commandFromStdin) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(command);
      }

      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const task: BashTask = {
        id,
        command,
        cwd: ctx.cwd,
        child,
        startedAt: Date.now(),
        status: "running",
        timedOut: false,
        stopRequested: false,
        abortRequested: false,
        detached: false,
        collected: false,
        logPath: log.path,
        logFd: log.fd,
        tailChunks: [],
        tailBytes: 0,
        totalBytes: 0,
        done,
        resolveDone,
      };
      tasks.set(id, task);

      child.stdout?.on("data", (data: Buffer) => pushTail(task, data));
      child.stderr?.on("data", (data: Buffer) => pushTail(task, data));
      child.once("error", (error) => finalizeTask(task, { error: error.message }));
      child.once("close", (exitCode, signal) => finalizeTask(task, { exitCode, signal }));

      if (timeoutSeconds !== undefined) {
        const timeoutMs = timeoutSeconds * 1000;
        task.timeoutHandle = setTimeout(() => {
          if (task.status !== "running") return;
          task.timedOut = true;
          requestKill(task);
        }, timeoutMs);
        task.timeoutHandle.unref?.();
      }

      return task;
    };

    const detachTask = (task: BashTask): void => {
      if (task.detached) return;
      task.detached = true;
      task.detachedAt = Date.now();
    };

    const stopAll = () => {
      shuttingDown = true;
      if (wakeTimer) clearTimeout(wakeTimer);
      clearPromptGateTimer();
      for (const task of tasks.values()) {
        cancelWake(task.id);
        if (task.status === "running") {
          task.stopRequested = true;
          requestKill(task);
        }
      }
    };

    const bashTool: ToolDefinition<typeof bashParameters, BashYieldDetails | undefined> = {
      name: "bash",
      label: "bash",
      description:
        "Execute a bash command in the current working directory. Short commands return normally. Long-running commands automatically yield to a background task so you can keep working. Use run_in_background only for intentionally independent work.",
      promptSnippet: "Execute bash commands; long-running commands yield to background automatically",
      promptGuidelines: [
        "When bash yields a background task, continue independent work. Do not poll it. Use task_output with wait=true once only when a dependent step needs the result; completion also wakes the agent automatically.",
      ],
      parameters: bashParameters,
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        if (signal?.aborted) throw new Error("Command aborted");
        if (params.run_in_background && activeBackgroundCount() >= maxBackgroundTasks) {
          throw new Error("Too many background shell tasks are already running; collect or stop one first.");
        }

        const task = spawnTask(params.command, params.timeout, ctx);
        let updateTimer: NodeJS.Timeout | undefined;
        let updateDirty = false;
        let lastUpdateAt = 0;

        const emitUpdate = () => {
          if (!onUpdate || !updateDirty || task.detached || task.status !== "running") return;
          updateDirty = false;
          lastUpdateAt = Date.now();
          onUpdate({
            content: [{ type: "text", text: tailText(task) }],
            details: {
              status: task.status,
              logPath: task.logPath,
              totalBytes: task.totalBytes,
              elapsedMs: Date.now() - task.startedAt,
            },
          });
        };
        const scheduleUpdate = () => {
          if (!onUpdate || task.detached || task.status !== "running") return;
          updateDirty = true;
          const delay = Math.max(0, 100 - (Date.now() - lastUpdateAt));
          if (delay === 0) {
            emitUpdate();
          } else if (!updateTimer) {
            updateTimer = setTimeout(() => {
              updateTimer = undefined;
              emitUpdate();
            }, delay);
          }
        };
        const dataListener = () => scheduleUpdate();
        task.child.stdout?.on("data", dataListener);
        task.child.stderr?.on("data", dataListener);

        const abortListener = () => {
          if (task.detached || task.status !== "running") return;
          task.abortRequested = true;
          requestKill(task);
        };
        signal?.addEventListener("abort", abortListener, { once: true });

        try {
          if (params.run_in_background) {
            detachTask(task);
            signal?.removeEventListener("abort", abortListener);
            return backgroundStartResult(task, "explicit", foregroundMs);
          }

          if (ctx.mode !== "tui") {
            await task.done;
            tasks.delete(task.id);
            return foregroundResultOrThrow(task);
          }

          const completedInForeground =
            foregroundMs > 0 ? await waitForTask(task, foregroundMs) : false;

          if (completedInForeground || task.status !== "running") {
            tasks.delete(task.id);
            return foregroundResultOrThrow(task);
          }

          if (activeBackgroundCount() >= maxBackgroundTasks) {
            await task.done;
            tasks.delete(task.id);
            return foregroundResultOrThrow(task);
          }

          detachTask(task);
          signal?.removeEventListener("abort", abortListener);
          return backgroundStartResult(task, "yield", foregroundMs);
        } finally {
          if (updateTimer) clearTimeout(updateTimer);
          task.child.stdout?.off("data", dataListener);
          task.child.stderr?.off("data", dataListener);
          if (!task.detached) signal?.removeEventListener("abort", abortListener);
        }
      },
    };

    const taskOutputTool: ToolDefinition<typeof taskOutputParameters, BashYieldDetails | undefined> = {
      name: "task_output",
      label: "background shell",
      description:
        "Read one background shell task. Set wait=true only when the next step depends on completion; otherwise read current status without blocking.",
      parameters: taskOutputParameters,
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      async execute(_toolCallId, params) {
        const task = tasks.get(params.task_id);
        if (!task) throw new Error(`Unknown background task: ${params.task_id}`);

        if (params.wait && task.status === "running") {
          const waitMs = normalizeWaitMs(params.wait_timeout, taskWaitMs);
          await waitForTask(task, waitMs);
        }

        if (task.status !== "running") {
          task.collected = true;
          cancelWake(task.id);
        }
        return terminalToolResult(task);
      },
    };

    const taskStopTool: ToolDefinition<typeof taskStopParameters, BashYieldDetails | undefined> = {
      name: "task_stop",
      label: "stop background shell",
      description: "Stop a background shell task and its process tree.",
      parameters: taskStopParameters,
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      async execute(_toolCallId, params) {
        const task = tasks.get(params.task_id);
        if (!task) throw new Error(`Unknown background task: ${params.task_id}`);
        cancelWake(task.id);
        task.collected = true;
        if (task.status === "running") {
          task.stopRequested = true;
          requestKill(task);
          await waitForTask(task, 3_000);
        }
        return terminalToolResult(task);
      },
    };

    const taskListTool: ToolDefinition<typeof taskListParameters, { count: number }> = {
      name: "task_list",
      label: "background shells",
      description: "List running and recently completed background shell tasks.",
      parameters: taskListParameters,
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      async execute() {
        const all = [...tasks.values()].filter((task) => task.detached);
        const text =
          all.length === 0
            ? "No background shell tasks."
            : all
                .map(
                  (task) =>
                    `[${task.id}] ${statusLabel(task)} · ${formatElapsed(task)} · ${boundedCommand(task.command)}`,
                )
                .join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: { count: all.length },
        };
      },
    };

    pi.registerTool(bashTool);
    pi.registerTool(taskOutputTool);
    pi.registerTool(taskStopTool);
    pi.registerTool(taskListTool);

    pi.on("input", () => {
      promptPending = true;
      promptPendingSince = Date.now();
      armPromptGateTimer();
      return undefined;
    });
    pi.on("agent_start", () => {
      agentBusy = true;
      openPromptGate();
      return undefined;
    });
    pi.on("agent_settled", () => {
      agentBusy = false;
      openPromptGate();
      compacting = false;
      scheduleWake();
      return undefined;
    });
    pi.on("session_before_compact", () => {
      compacting = true;
      return undefined;
    });
    pi.on("session_shutdown", () => {
      stopAll();
      return undefined;
    });
  };
}

export default createBashYieldExtension();
