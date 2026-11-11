import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { SubagentProgressNode, WorkflowToolDetails } from "../types.ts";
import { formatDuration } from "./subagent-render.ts";

const MAX_TASKS = 24;
const MAX_HISTORY = 24;
const MAX_TEXT = 240;

type TaskStatus = SubagentProgressNode["status"] | WorkflowToolDetails["status"];

export type MonitorTask =
  | { id: string; kind: "agent"; createdAt: number; status: TaskStatus; progress: SubagentProgressNode }
  | { id: string; kind: "workflow"; createdAt: number; status: TaskStatus; workflow: WorkflowToolDetails };

function bounded(value: string | undefined): string {
  return (value ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f\x1b]/g, " ").replace(/\s+/g, " ").slice(0, MAX_TEXT);
}

function active(status: TaskStatus): boolean {
  return status === "running" || status === "queued";
}

export class FlowMonitor {
  private tasks = new Map<string, MonitorTask>();
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private store(task: MonitorTask): void {
    this.tasks.set(task.id, task);
    if (this.tasks.size > MAX_TASKS) {
      const terminal = [...this.tasks.values()].find((item) => !active(item.status) && item.id !== task.id);
      const oldest = terminal ?? [...this.tasks.values()].find((item) => item.id !== task.id);
      if (oldest) this.tasks.delete(oldest.id);
    }
    this.notify();
  }

  updateAgent(id: string, progress: SubagentProgressNode): void {
    const prior = this.tasks.get(id);
    this.store({
      id,
      kind: "agent",
      createdAt: prior?.createdAt ?? Date.now(),
      status: progress.status,
      progress: {
        ...progress,
        label: bounded(progress.label),
        error: bounded(progress.error),
        result: undefined,
        activity: progress.activity.slice(-MAX_HISTORY).map(bounded),
      },
    });
  }

  updateWorkflow(id: string, workflow: WorkflowToolDetails): void {
    const prior = this.tasks.get(id);
    this.store({
      id,
      kind: "workflow",
      createdAt: prior?.createdAt ?? Date.now(),
      status: workflow.status,
      workflow: {
        ...workflow,
        name: bounded(workflow.name),
        currentPhase: bounded(workflow.currentPhase),
        error: bounded(workflow.error),
        result: undefined,
        phases: [],
        phaseSummaries: [],
        plannedPhases: undefined,
        logs: workflow.logs.slice(-MAX_HISTORY).map(bounded),
        subagents: workflow.subagents.slice(-MAX_TASKS).map((child) => ({
          ...child,
          label: bounded(child.label),
          error: bounded(child.error),
          result: undefined,
          sessionKey: undefined,
          activity: child.activity?.slice(-MAX_HISTORY).map(bounded),
        })),
      },
    });
  }

  list(): MonitorTask[] {
    return [...this.tasks.values()].sort((a, b) =>
      Number(active(b.status)) - Number(active(a.status)) || b.createdAt - a.createdAt);
  }

  clear(): void {
    this.tasks.clear();
    this.notify();
  }
}

function monitorLines(tasks: MonitorTask[], selectedId: string | undefined, offset: number, now: number): string[] {
  const running = tasks.filter((item) => active(item.status)).length;
  const lines = [
    `PiFlow | ${running} active / ${tasks.length} retained`,
    " /flow-panel: hide | next / prev | up / down",
    "─".repeat(36),
  ];
  if (tasks.length === 0) return [...lines, " No subagent or workflow activity yet."];

  const selected = tasks.find((item) => item.id === selectedId) ?? tasks[0];
  const position = tasks.findIndex((item) => item.id === selected.id) + 1;
  const label = selected.kind === "agent" ? selected.progress.label : selected.workflow.name;
  lines.push(` ${position}/${tasks.length} · ${selected.kind} · ${selected.status}`);
  lines.push(` ${label}`);

  if (selected.kind === "agent") {
    const p = selected.progress;
    lines.push(` ${p.backend ?? "pi"} / ${p.profile} · ${formatDuration(Math.max(0, now - p.startedAt))}`);
    if (p.toolsCompleted !== undefined) {
      lines.push(` Tools ${p.toolsCompleted} · failed ${p.toolsFailed ?? 0}` +
        (p.repeatedFailureCount ? ` · repeated ${p.repeatedFailureCount}` : ""));
    }
    if (p.lastToolFinishedAt) lines.push(` Last tool ${formatDuration(Math.max(0, now - p.lastToolFinishedAt))} ago`);
    if (p.wrapUpRequestedAt) lines.push(" Safe handoff requested; awaiting final result");
    if (p.error) lines.push(` ERROR ${bounded(p.error)}`);
    const total = p.activityCount || p.activity.length;
    lines.push(` Activity (${p.activity.length} retained / ${total} observed)`);
    const activity = p.activity.slice(0, Math.max(0, p.activity.length - offset));
    lines.push(...activity.slice(-12).map((item) => `  ${item}`));
  } else {
    const w = selected.workflow;
    if (w.currentPhase) lines.push(` Phase: ${w.currentPhase}`);
    const counts = w.subagentStatusCounts;
    lines.push(` Agents ${w.subagentCount} · running ${counts.running} · done ${counts.done} · failed ${counts.error}`);
    if (w.error) lines.push(` ERROR ${bounded(w.error)}`);
    for (const child of w.subagents.slice(-8)) {
      lines.push(`  ${child.status === "done" ? "✓" : child.status === "error" ? "!" : "·"} ${child.label} (${child.status})`);
      if (child.error) lines.push(`   ERROR ${bounded(child.error)}`);
    }
    lines.push(` Workflow events (${w.logs.length} retained / ${w.logCount} observed)`);
    lines.push(...w.logs.slice(0, Math.max(0, w.logs.length - offset)).slice(-8).map((line) => `  ${line}`));
  }
  return lines;
}

export class FlowMonitorPanel implements Component {
  private selectedId: string | undefined;
  private offset = 0;
  private unsubscribe: () => void;

  constructor(private store: FlowMonitor, private tui: TUI, private theme: Theme) {
    this.unsubscribe = store.subscribe(() => tui.requestRender());
  }

  select(direction: number): void {
    const tasks = this.store.list();
    if (!tasks.length) return;
    const index = tasks.findIndex((task) => task.id === this.selectedId);
    this.selectedId = tasks[((index < 0 ? 0 : index) + direction + tasks.length) % tasks.length].id;
    this.offset = 0;
    this.tui.requestRender();
  }

  scroll(direction: number): void {
    this.offset = Math.max(0, Math.min(MAX_HISTORY - 1, this.offset + direction));
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const tasks = this.store.list();
    const now = Date.now();
    const lines = monitorLines(tasks, this.selectedId, this.offset, now);
    const maxRows = Math.max(6, Math.min(this.tui.terminal.rows - 3, 26));
    const headingRows = Math.min(5, maxRows - 2);
    const trailingRows = maxRows - headingRows - 1;
    const display = lines.length > maxRows
      ? [
          ...lines.slice(0, headingRows),
          ` ... ${lines.length - maxRows + 1} additional lines not visible`,
          ...lines.slice(-trailingRows),
        ]
      : lines;
    return display.map((line, index) => {
      const themed = index === 0 ? this.theme.fg("accent", line) :
        line.includes("ERROR") ? this.theme.fg("error", line) :
        index <= 2 ? this.theme.fg("muted", line) : line;
      return truncateToWidth(themed, Math.max(4, width), "…", true);
    });
  }

  invalidate(): void {}
  dispose(): void { this.unsubscribe(); }
}

export class FlowPanelController {
  private panel: FlowMonitorPanel | undefined;
  private closePanel: (() => void) | undefined;
  private generation = 0;

  constructor(private store: FlowMonitor) {}

  close(): void {
    this.generation++;
    const close = this.closePanel;
    this.closePanel = undefined;
    this.panel?.dispose();
    this.panel = undefined;
    close?.();
  }

  command(args: string, ctx: ExtensionCommandContext): void {
    const action = args.trim().toLowerCase();
    if (action === "close" || (!action && this.closePanel)) {
      this.close();
      return;
    }
    if (action === "next" || action === "prev") {
      this.panel?.select(action === "next" ? 1 : -1);
      return;
    }
    if (action === "up" || action === "down") {
      this.panel?.scroll(action === "up" ? 1 : -1);
      return;
    }
    if (action && action !== "open") {
      ctx.ui.notify("Usage: /flow-panel [open|close|next|prev|up|down]", "info");
      return;
    }
    if (this.closePanel) return;
    if (!ctx.hasUI || ctx.mode !== "tui") {
      ctx.ui.notify("PiFlow panel requires interactive terminal mode", "warning");
      return;
    }

    const token = ++this.generation;
    let terminal: TUI | undefined;
    void ctx.ui.custom<void>((tui, theme, _keys, done) => {
      terminal = tui;
      this.panel = new FlowMonitorPanel(this.store, tui, theme);
      this.closePanel = () => done();
      return this.panel;
    }, {
      overlay: true,
      overlayOptions: () => ({
        anchor: "top-right",
        width: (terminal?.terminal.columns ?? 120) < 95 ? "92%" : "45%",
        minWidth: (terminal?.terminal.columns ?? 120) < 95 ? 28 : 44,
        maxHeight: "90%",
        margin: { top: 1, right: 1 },
        nonCapturing: true,
      }),
    }).catch(() => {
      ctx.ui.notify("Unable to show PiFlow panel", "warning");
    }).finally(() => {
      if (token !== this.generation) return;
      this.panel?.dispose();
      this.panel = undefined;
      this.closePanel = undefined;
    });
  }
}
