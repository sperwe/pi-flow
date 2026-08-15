import { describe, expect, it } from "vitest";
import { stripInactiveFlowPromptFromProviderPayload } from "../src/provider-prompt.ts";

const FLOW = "# PiFlow delegation\n\n## Workflow authoring\nGuide";
const BASE = "Base system prompt";

function withFlow(text = BASE): string {
  return `${text}\n\n${FLOW}`;
}

describe("provider prompt gating", () => {
  it("removes PiFlow instructions from Anthropic payloads when flow tools are inactive", () => {
    const payload = {
      system: [{ type: "text", text: withFlow() }],
      tools: [{ name: "read" }, { name: "search_tools" }],
    };

    expect(stripInactiveFlowPromptFromProviderPayload(payload)).toEqual({
      system: [{ type: "text", text: BASE }],
      tools: payload.tools,
    });
  });

  it("removes PiFlow instructions from OpenAI Responses payloads when flow tools are inactive", () => {
    const payload = {
      instructions: withFlow(),
      tools: [{ type: "function", name: "read" }],
    };

    expect(stripInactiveFlowPromptFromProviderPayload(payload)).toEqual({
      instructions: BASE,
      tools: payload.tools,
    });
  });

  it("preserves the full prompt once run_agent is active", () => {
    const payload = {
      instructions: withFlow(),
      tools: [{ type: "function", name: "run_agent" }],
    };

    expect(stripInactiveFlowPromptFromProviderPayload(payload)).toBe(payload);
  });

  it("preserves the full prompt once run_workflow is active in a nested function shape", () => {
    const payload = {
      system: withFlow(),
      tools: [{ type: "function", function: { name: "run_workflow" } }],
    };

    expect(stripInactiveFlowPromptFromProviderPayload(payload)).toBe(payload);
  });

  it("strips system and developer messages for chat-style payloads", () => {
    const payload = {
      messages: [
        { role: "system", content: withFlow() },
        { role: "user", content: FLOW },
      ],
      tools: [{ type: "function", function: { name: "read" } }],
    };

    expect(stripInactiveFlowPromptFromProviderPayload(payload)).toEqual({
      messages: [
        { role: "system", content: BASE },
        { role: "user", content: FLOW },
      ],
      tools: payload.tools,
    });
  });

  it("strips Google-style systemInstruction parts", () => {
    const payload = {
      systemInstruction: { role: "system", parts: [{ text: withFlow() }] },
      tools: [],
    };

    expect(stripInactiveFlowPromptFromProviderPayload(payload)).toEqual({
      systemInstruction: { role: "system", parts: [{ text: BASE }] },
      tools: [],
    });
  });

  it("returns untouched payloads when no flow prompt is present", () => {
    const payload = { instructions: BASE, tools: [{ name: "read" }] };
    expect(stripInactiveFlowPromptFromProviderPayload(payload)).toBe(payload);
  });
});
