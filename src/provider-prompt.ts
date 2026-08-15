const FLOW_PROMPT_MARKER = "# PiFlow delegation";
const FLOW_TOOL_NAMES = new Set(["run_agent", "run_workflow"]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.name === "string") return value.name;
  if (isRecord(value.function) && typeof value.function.name === "string") return value.function.name;
  if (isRecord(value.custom) && typeof value.custom.name === "string") return value.custom.name;
  return undefined;
}

function hasFlowTool(payload: UnknownRecord): boolean {
  if (!Array.isArray(payload.tools)) return false;
  return payload.tools.some((tool) => {
    const name = toolName(tool);
    return name !== undefined && FLOW_TOOL_NAMES.has(name);
  });
}

function stripFlowPromptText(text: string): string {
  const appendedMarker = `\n\n${FLOW_PROMPT_MARKER}`;
  const appendedIndex = text.indexOf(appendedMarker);
  if (appendedIndex >= 0) return text.slice(0, appendedIndex);
  if (text.startsWith(FLOW_PROMPT_MARKER)) return "";

  const markerIndex = text.indexOf(FLOW_PROMPT_MARKER);
  return markerIndex >= 0 ? text.slice(0, markerIndex).trimEnd() : text;
}

function stripTextBlocks(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const stripped = stripFlowPromptText(value);
    return { value: stripped, changed: stripped !== value };
  }
  if (!Array.isArray(value)) return { value, changed: false };

  let changed = false;
  const next = value.map((block) => {
    if (!isRecord(block) || typeof block.text !== "string") return block;
    const text = stripFlowPromptText(block.text);
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return { value: changed ? next : value, changed };
}

function stripMessagePrompts(messages: unknown): { value: unknown; changed: boolean } {
  if (!Array.isArray(messages)) return { value: messages, changed: false };

  let changed = false;
  const next = messages.map((message) => {
    if (!isRecord(message) || (message.role !== "system" && message.role !== "developer")) return message;
    const content = stripTextBlocks(message.content);
    if (!content.changed) return message;
    changed = true;
    return { ...message, content: content.value };
  });
  return { value: changed ? next : messages, changed };
}

function stripSystemInstruction(value: unknown): { value: unknown; changed: boolean } {
  if (!isRecord(value) || !Array.isArray(value.parts)) return { value, changed: false };
  const parts = stripTextBlocks(value.parts);
  if (!parts.changed) return { value, changed: false };
  return { value: { ...value, parts: parts.value }, changed: true };
}

export function stripInactiveFlowPromptFromProviderPayload(payload: unknown): unknown {
  if (!isRecord(payload) || hasFlowTool(payload)) return payload;

  let changed = false;
  const next: UnknownRecord = { ...payload };

  for (const key of ["instructions", "system"] as const) {
    const result = stripTextBlocks(payload[key]);
    if (!result.changed) continue;
    next[key] = result.value;
    changed = true;
  }

  const messages = stripMessagePrompts(payload.messages);
  if (messages.changed) {
    next.messages = messages.value;
    changed = true;
  }

  for (const key of ["systemInstruction", "system_instruction"] as const) {
    const result = stripSystemInstruction(payload[key]);
    if (!result.changed) continue;
    next[key] = result.value;
    changed = true;
  }

  return changed ? next : payload;
}
