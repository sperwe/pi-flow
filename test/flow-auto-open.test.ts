import { describe, expect, it, vi } from "vitest";
import { createSubagentExtension } from "../src/pi-subagent.ts";

function harness(workflow = true, interactive = true) {
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const flags = new Map<string, string | boolean>();
  const requests: string[] = [];
  const rendered: string[] = [];
  const ui = {
    custom: vi.fn((factory: any, _options: any) => {
      const mockTui = { terminal: { columns: 140, rows: 36 }, requestRender: vi.fn() };
      const theme = { fg: (_color: string, text: string) => text };
      const component = factory(mockTui, theme, {}, () => {});
      rendered.splice(0, rendered.length, ...component.render(68));
      return new Promise<void>(() => {});
    }),
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
  };
  createSubagentExtension({ workflow })({
    registerTool: (tool: { name: string }) => requests.push(tool.name),
    registerCommand: () => {},
    registerFlag: (name: string, options: { default?: string | boolean }) => {
      if (options.default !== undefined) flags.set(name, options.default);
    },
    getFlag: (name: string) => flags.get(name),
    on: (name: string, handler: any) => handlers.set(name, handler),
    getThinkingLevel: () => "high",
  } as never);
  const ctx = { mode: interactive ? "tui" : "rpc", hasUI: interactive, ui };
  const start = (toolCallId: string, toolName: string, args: Record<string, string>) =>
    handlers.get("tool_execution_start")?.({ toolCallId, toolName, args }, ctx);
  return { handlers, ctx, start, rendered, ui, requests };
}

describe("PiFlow panel auto-open on task execution", () => {
  it("opens without a slash command when run_agent starts, and never opens for normal tools", () => {
    const test = harness();
    test.start("read-1", "read", {});
    expect(test.ui.custom).not.toHaveBeenCalled();
    test.start("a1", "run_agent", { label: "Validate release", profile: "general-purpose" });
    expect(test.ui.custom).toHaveBeenCalledTimes(1);
    expect(test.ui.custom.mock.calls[0][1]).toMatchObject({ overlay: true });
    expect(test.rendered.join("\n")).toContain("Validate release");
    expect(test.rendered.join("\n")).toContain("1 active / 1 retained");
    test.start("a2", "run_agent", { label: "Second task" });
    expect(test.ui.custom).toHaveBeenCalledTimes(1);
  });

  it("opens on run_workflow and shows its initial task even before the first progress event", () => {
    const test = harness();
    test.start("wf1", "run_workflow", { name: "Prepare package" });
    expect(test.ui.custom).toHaveBeenCalledTimes(1);
    expect(test.rendered.join("\n")).toContain("Prepare package");
    expect(test.rendered.join("\n")).toContain("workflow · running");
  });

  it("does not open for disabled workflows or noninteractive modes", () => {
    const disabled = harness(false);
    disabled.start("wf1", "run_workflow", { name: "Disabled" });
    expect(disabled.ui.custom).not.toHaveBeenCalled();
    const headless = harness(true, false);
    headless.start("a1", "run_agent", { label: "Headless job" });
    expect(headless.ui.custom).not.toHaveBeenCalled();
  });

  it("session transitions cleanly dismiss an automatically opened panel", () => {
    const test = harness();
    test.start("a1", "run_agent", { label: "First task" });
    const onTree = test.handlers.get("session_tree");
    expect(onTree).toBeTypeOf("function");
    // No active jobs are running; a separate Pi session starts clean.
    onTree?.({}, test.ctx);
    test.start("a2", "run_agent", { label: "Second task" });
    expect(test.ui.custom).toHaveBeenCalledTimes(2);
  });

  it("never interrupts a delegated task if the UI refuses to create an overlay", () => {
    const test = harness();
    test.ui.custom.mockImplementationOnce(() => { throw new Error("display unavailable"); });
    expect(() => test.start("a1", "run_agent", { label: "Test without UI" })).not.toThrow();
    expect(test.ui.notify).toHaveBeenCalledWith("Unable to show PiFlow panel", "warning");
    test.start("a2", "run_agent", { label: "Retry panel" });
    expect(test.ui.custom).toHaveBeenCalledTimes(2);
  });
});
