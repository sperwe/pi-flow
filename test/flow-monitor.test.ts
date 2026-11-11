import { describe, expect, it, vi } from "vitest";
import { FlowMonitor, FlowMonitorPanel, FlowPanelController } from "../src/core/flow-monitor.ts";
import type { SubagentProgressNode } from "../src/types.ts";

function agent(label: string, status: SubagentProgressNode["status"] = "running"): SubagentProgressNode {
  return {
    label,
    profile: "general-purpose",
    backend: "pi",
    status,
    startedAt: Date.now() - 50_000,
    activity: ["Opened source", "Fixed startup behavior", "Tests passed"],
    activityCount: 60,
    toolsCompleted: 31,
    toolsFailed: 2,
    repeatedFailureCount: 1,
  };
}

function mockUi() {
  const requestRender = vi.fn();
  const tui = { requestRender, terminal: { columns: 140, rows: 45 } } as never;
  const theme = { fg: (_color: string, text: string) => text } as never;
  return { tui, theme, requestRender };
}

describe("PiFlow monitor", () => {
  it("preserves terminal status and bounded activity without implying task acceptance", () => {
    const store = new FlowMonitor();
    const updates = vi.fn();
    const unsubscribe = store.subscribe(updates);
    store.updateAgent("agent-1", agent("Source revision"));
    const completed = agent("Source revision", "done");
    completed.activity = Array.from({ length: 70 }, (_, i) => `event-${i}`);
    completed.result = "Code compiled";
    store.updateAgent("agent-1", completed);
    expect(updates).toHaveBeenCalledTimes(2);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].status).toBe("done");
    const saved = store.list()[0];
    expect(saved.kind).toBe("agent");
    if (saved.kind === "agent") expect(saved.progress.result).toBeUndefined();
    const { tui, theme } = mockUi();
    const panel = new FlowMonitorPanel(store, tui, theme);
    const rendered = panel.render(72).join("\n");
    expect(rendered).toContain("0 active / 1 retained");
    expect(rendered).toContain("31 · failed 2 · repeated 1");
    expect(rendered).toContain("24 retained / 60 observed");
    expect(rendered).not.toContain("event-1");
    expect(rendered).not.toContain("verified delivery");
    panel.dispose();
    unsubscribe();
  });

  it("can change tasks and scroll without acquiring the editor's focus", () => {
    const store = new FlowMonitor();
    store.updateAgent("a", agent("First task", "done"));
    store.updateAgent("b", agent("Second task", "running"));
    const { tui, theme, requestRender } = mockUi();
    const panel = new FlowMonitorPanel(store, tui, theme);
    expect(panel.render(60).join("\n")).toContain("Second task");
    panel.select(1);
    expect(panel.render(60).join("\n")).toContain("First task");
    panel.scroll(1);
    expect(requestRender).toHaveBeenCalledTimes(2);
    panel.dispose();
    store.updateAgent("c", agent("Third task"));
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it("exposes a non-capturing terminal overlay with a reversible toggle", async () => {
    const store = new FlowMonitor();
    const controller = new FlowPanelController(store);
    const { tui, theme } = mockUi();
    const done = vi.fn();
    let overlayOptions: (() => Record<string, unknown>) | undefined;
    let resolveCustom: (() => void) | undefined;
    const custom = vi.fn((factory, options) => {
      overlayOptions = options.overlayOptions;
      const promise = new Promise<void>((resolve) => { resolveCustom = resolve; });
      factory(tui, theme, {}, () => { done(); resolveCustom?.(); });
      return promise;
    });
    const ctx = { hasUI: true, mode: "tui", ui: { custom, notify: vi.fn() } } as never;
    controller.command("open", ctx);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(overlayOptions?.()).toMatchObject({ nonCapturing: true, anchor: "top-right", width: "45%" });
    controller.command("next", ctx);
    controller.command("close", ctx);
    await Promise.resolve();
    expect(done).toHaveBeenCalledTimes(1);
    controller.command("open", ctx);
    expect(custom).toHaveBeenCalledTimes(2);
    controller.close();
  });

  it("bounds retention and clears on session changes", () => {
    const store = new FlowMonitor();
    for (let i = 0; i < 45; i++) store.updateAgent(String(i), agent(`Task ${i}`, "done"));
    expect(store.list().length).toBeLessThanOrEqual(24);
    store.clear();
    expect(store.list()).toHaveLength(0);
  });

  it("tracks workflow phases and child errors without retaining full child results", () => {
    const store = new FlowMonitor();
    store.updateWorkflow("workflow-1", {
      name: "Production check",
      status: "running",
      currentPhase: "Verification",
      subagentCount: 2,
      subagentStatusCounts: { queued: 0, running: 1, done: 0, error: 1, aborted: 0 },
      phaseCount: 1,
      phases: ["Verification"],
      phaseSummaries: [],
      subagents: [
        { index: 1, label: "Builder", profile: "general-purpose", status: "running", result: "large private output" },
        { index: 2, label: "Reviewer", profile: "general-purpose", status: "error", error: "test failed" },
      ],
      logCount: 12,
      logs: ["Started verification", "Review failed"],
      result: "large workflow result",
    });
    const saved = store.list()[0];
    expect(saved.kind).toBe("workflow");
    if (saved.kind !== "workflow") return;
    expect(saved.workflow.result).toBeUndefined();
    expect(saved.workflow.subagents[0].result).toBeUndefined();
    const { tui, theme } = mockUi();
    const panel = new FlowMonitorPanel(store, tui, theme);
    const view = panel.render(75).join("\n");
    expect(view).toContain("Phase: Verification");
    expect(view).toContain("failed 1");
    expect(view).toContain("ERROR test failed");
    expect(view).toContain("Review failed");
    panel.dispose();
  });
});
