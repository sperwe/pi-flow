import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createBashYieldExtension, type BashYieldOptions } from "../src/pi-bash-yield.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;

function textOf(result: any): string {
  return result.content?.map((part: any) => (part.type === "text" ? part.text : "")).join("") ?? "";
}

function command(script: string): string {
  return `node -e ${JSON.stringify(script)}`;
}

function createHarness(options: BashYieldOptions = {}) {
  const tools = new Map<string, ToolDefinition<any, any>>();
  const handlers = new Map<string, Handler[]>();
  const messages: Array<{ message: any; options: any }> = [];

  const pi = {
    registerTool(tool: ToolDefinition<any, any>) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: Handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    sendMessage(message: any, sendOptions: any) {
      messages.push({ message, options: sendOptions });
    },
  } as unknown as ExtensionAPI;

  createBashYieldExtension(options)(pi);

  const ctx = {
    mode: "tui",
    cwd: process.cwd(),
    model: undefined,
    thinkingLevel: undefined,
    sessionManager: {
      getSessionId: () => "test-session",
      getSessionFile: () => undefined,
    },
  } as unknown as ExtensionContext;

  async function emit(event: string) {
    for (const handler of handlers.get(event) ?? []) {
      await handler({ type: event }, ctx);
    }
  }

  function tool(name: string): any {
    const value = tools.get(name);
    if (!value) throw new Error(`missing tool ${name}`);
    return value;
  }

  return { tool, emit, messages, ctx };
}

describe("pi bash yield extension", () => {
  it("keeps short bash commands in the foreground", async () => {
    const harness = createHarness({ foregroundMs: 100, wakeOnCompletion: false });
    const result = await harness.tool("bash").execute(
      "call-1",
      { command: command('process.stdout.write("fast")') },
      undefined,
      undefined,
      harness.ctx,
    );

    expect(textOf(result)).toContain("fast");
    expect(result.details.status).toBe("succeeded");

    const list = await harness.tool("task_list").execute(
      "list-1",
      {},
      undefined,
      undefined,
      harness.ctx,
    );
    expect(textOf(list)).toBe("No background shell tasks.");
  });

  it("automatically yields a long ordinary bash command and wakes after it finishes", async () => {
    const harness = createHarness({ foregroundMs: 20, wakeOnCompletion: true });
    await harness.emit("agent_start");

    const started = Date.now();
    const result = await harness.tool("bash").execute(
      "call-2",
      { command: command('setTimeout(() => process.stdout.write("done"), 120)') },
      undefined,
      undefined,
      harness.ctx,
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(100);
    expect(result.details.taskId).toMatch(/^bash_\d+$/);
    expect(textOf(result)).toContain("moved to the background");

    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(harness.messages).toHaveLength(0);

    await harness.emit("agent_settled");
    await new Promise((resolve) => setTimeout(resolve, 90));

    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0].options).toMatchObject({ triggerTurn: true, deliverAs: "followUp" });
    expect(harness.messages[0].message.content).toContain("done");
    expect(harness.messages[0].message.content).toContain("Background shell work finished");
  });

  it("supports explicit immediate background execution and one blocking collection", async () => {
    const harness = createHarness({ foregroundMs: 5_000, wakeOnCompletion: false });
    const result = await harness.tool("bash").execute(
      "call-3",
      {
        command: command('setTimeout(() => process.stdout.write("collected"), 80)'),
        run_in_background: true,
      },
      undefined,
      undefined,
      harness.ctx,
    );

    const taskId = result.details.taskId;
    expect(taskId).toMatch(/^bash_\d+$/);

    const collected = await harness.tool("task_output").execute(
      "output-1",
      { task_id: taskId, wait: true, wait_timeout: 1 },
      undefined,
      undefined,
      harness.ctx,
    );
    expect(collected.details.status).toBe("succeeded");
    expect(textOf(collected)).toContain("collected");
  });

  it("does not send a redundant completion wake after the task was collected", async () => {
    const harness = createHarness({ foregroundMs: 10, wakeOnCompletion: true });
    await harness.emit("agent_start");

    const result = await harness.tool("bash").execute(
      "call-4",
      { command: command('setTimeout(() => process.stdout.write("ready"), 60)') },
      undefined,
      undefined,
      harness.ctx,
    );

    const collected = await harness.tool("task_output").execute(
      "output-2",
      { task_id: result.details.taskId, wait: true, wait_timeout: 1 },
      undefined,
      undefined,
      harness.ctx,
    );
    expect(collected.details.status).toBe("succeeded");

    await harness.emit("agent_settled");
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(harness.messages).toHaveLength(0);
  });

  it("stops the whole background task instead of leaving it orphaned", async () => {
    const harness = createHarness({ foregroundMs: 5_000, wakeOnCompletion: false });
    const result = await harness.tool("bash").execute(
      "call-5",
      {
        command: command('setTimeout(() => process.stdout.write("late"), 5_000)'),
        run_in_background: true,
      },
      undefined,
      undefined,
      harness.ctx,
    );

    const stopped = await harness.tool("task_stop").execute(
      "stop-1",
      { task_id: result.details.taskId },
      undefined,
      undefined,
      harness.ctx,
    );
    expect(["stopped", "running"]).toContain(stopped.details.status);

    if (stopped.details.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const status = await harness.tool("task_output").execute(
        "output-3",
        { task_id: result.details.taskId },
        undefined,
        undefined,
        harness.ctx,
      );
      expect(status.details.status).toBe("stopped");
    }
  });

  it("preserves foreground failures as tool errors", async () => {
    const harness = createHarness({ foregroundMs: 1_000, wakeOnCompletion: false });
    await expect(
      harness.tool("bash").execute(
        "call-6",
        { command: command("process.exit(7)") },
        undefined,
        undefined,
        harness.ctx,
      ),
    ).rejects.toThrow("Command exited with code 7");
  });
});
