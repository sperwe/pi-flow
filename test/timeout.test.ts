import { describe, expect, it, vi } from "vitest";
import { createSafeWrapUpTimer, markSubagentTimedOut } from "../src/core/timeout.ts";
import type { SubagentToolDetails } from "../src/types.ts";

describe("subagent timeout helpers", () => {
  it("treats a late successful result as timed out once the timeout has fired", () => {
    const details: SubagentToolDetails = {
      label: "Late child",
      profile: "general-purpose",
      backend: "pi",
      status: "done",
      result: "late success after timeout",
      progress: {
        label: "Late child",
        profile: "general-purpose",
        backend: "pi",
        status: "done",
        startedAt: 1,
        endedAt: 2,
        activity: [],
        activityCount: 0,
        result: "late success after timeout",
      },
    };

    const timedOut = markSubagentTimedOut(details, 20);

    expect(timedOut.status).toBe("aborted");
    expect(timedOut.error).toBe("Subagent timed out after 20ms");
    expect(timedOut.result).toBeUndefined();
    expect(timedOut.progress?.status).toBe("aborted");
    expect(timedOut.progress?.error).toBe("Subagent timed out after 20ms");
    expect(timedOut.progress?.result).toBeUndefined();
  });
});

describe("safe wrap-up before the hard timeout", () => {
  it("requests one graceful handoff five minutes before a two-hour limit without changing the hard deadline", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn();
      const timer = createSafeWrapUpTimer(2 * 60 * 60 * 1000, undefined, request);
      timer.start();
      await vi.advanceTimersByTimeAsync(115 * 60 * 1000 - 1);
      expect(request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(request).toHaveBeenCalledTimes(1);
      timer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never requests a handoff after task completion or cancellation", async () => {
    vi.useFakeTimers();
    try {
      const completed = vi.fn();
      const cancelled = vi.fn();
      const control = new AbortController();
      const doneTimer = createSafeWrapUpTimer(2 * 60 * 60 * 1000, undefined, completed);
      const abortedTimer = createSafeWrapUpTimer(2 * 60 * 60 * 1000, control.signal, cancelled);
      doneTimer.start();
      abortedTimer.start();
      doneTimer.stop();
      control.abort();
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      expect(completed).not.toHaveBeenCalled();
      expect(cancelled).not.toHaveBeenCalled();
      abortedTimer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not add an extra steering step for short or disabled timeouts", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn();
      const short = createSafeWrapUpTimer(20, undefined, request);
      const unlimited = createSafeWrapUpTimer(0, undefined, request);
      short.start();
      unlimited.start();
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(request).not.toHaveBeenCalled();
      short.stop();
      unlimited.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reserves ten percent for a ten-minute task and keeps the final deadline unchanged", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn();
      const timer = createSafeWrapUpTimer(10 * 60_000, undefined, request);
      timer.start();
      await vi.advanceTimersByTimeAsync(9 * 60_000 - 1);
      expect(request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(1);
      timer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the original hard deadline even if Pi initialization was slow", async () => {
    vi.useFakeTimers();
    try {
      const deadlineAt = Date.now() + 2 * 60 * 60_000;
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      const request = vi.fn();
      const timer = createSafeWrapUpTimer(2 * 60 * 60_000, undefined, request, deadlineAt);
      timer.start();
      await vi.advanceTimersByTimeAsync(113 * 60_000 - 1);
      expect(request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(1);
      timer.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
