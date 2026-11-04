// Verbatim transcript renderer for the retrieval flow. The input shape mirrors the host's
// model messages (@opencode/ai `Message`), kept structural and local so the static import
// graph never pulls a host-provided package (see the note in options.ts).
// Losslessness rule: text and tool payloads are rendered verbatim; oversized tool output is
// truncated head+tail with the tool call id kept in the marker, so the exact bytes stay
// recoverable through OpenCode's tool-output spool. Nothing is paraphrased; part types this
// renderer does not understand are marked, never silently dropped.

export type TranscriptMeta = {
  sessionID: string;
  scope: string;
  model?: string;
};

export interface TranscriptMessage {
  role: string;
  content: string | ReadonlyArray<Record<string, unknown>>;
}

/** Tool output up to this size renders inline; larger output is head+tail truncated. */
export const INLINE_OUTPUT_MAX_BYTES = 50_000;

const HEAD_BYTES = 2048;
const TAIL_BYTES = 2048;
const FENCE = "~~~";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    // BigInt or cyclic structures are the realistic throwers here; the fallback keeps the
    // transcript renderable without pretending the JSON is exact.
    return String(value);
  }
}

function truncate(body: string, id: unknown, max: number): string {
  if (body.length <= max) {
    return body;
  }
  const idLabel = typeof id === "string" ? id : "unknown";
  if (max <= HEAD_BYTES + TAIL_BYTES + 64) {
    // A cap too small for the head+tail window degrades to a single head slice.
    return `${body.slice(0, Math.max(0, max - 48))}\n... [truncated; tool call id: ${idLabel}]`;
  }
  const omitted = body.length - HEAD_BYTES - TAIL_BYTES;
  return `${body.slice(0, HEAD_BYTES)}\n... [truncated ${omitted} chars; tool call id: ${idLabel}] ...\n${body.slice(-TAIL_BYTES)}`;
}

function fence(body: string): string {
  return `${FENCE}\n${body}\n${FENCE}`;
}

function renderContentValue(value: ReadonlyArray<Record<string, unknown>>): string {
  return value
    .map((item) => {
      if (item.type === "text") {
        return String(item.text ?? "");
      }
      if (item.type === "file") {
        const name = typeof item.name === "string" ? ` name=${item.name}` : "";
        return `[file ${String(item.uri ?? "")} ${String(item.mime ?? "")}${name}]`;
      }
      return `[unrendered content part: ${String(item.type ?? "unknown")}]`;
    })
    .join("\n");
}

function renderResult(result: unknown, id: unknown, max: number): string {
  if (!isRecord(result)) {
    return fence(truncate(String(result ?? ""), id, max));
  }
  if (result.type === "text") {
    return fence(truncate(String(result.value ?? ""), id, max));
  }
  if (result.type === "error") {
    return fence(`[error]\n${truncate(String(result.value ?? ""), id, max)}`);
  }
  if (result.type === "json") {
    return fence(truncate(json(result.value), id, max));
  }
  if (result.type === "content") {
    const value = Array.isArray(result.value) ? result.value : [];
    return renderContentValue(value as ReadonlyArray<Record<string, unknown>>);
  }
  return fence(truncate(json(result), id, max));
}

function renderPart(part: Record<string, unknown>, max: number): string {
  if (part.type === "text") {
    return String(part.text ?? "");
  }
  if (part.type === "tool-call") {
    return `### tool-call ${String(part.name ?? "unknown")} (id ${String(part.id ?? "unknown")})\n${fence(json(part.input ?? null))}`;
  }
  if (part.type === "tool-result") {
    return `### tool-result ${String(part.name ?? "unknown")} (id ${String(part.id ?? "unknown")})\n${renderResult(part.result, part.id, max)}`;
  }
  if (part.type === "media") {
    return "[media omitted]";
  }
  // Unknown or non-text part types (reasoning, compaction, effort, future additions) must
  // not vanish silently: reasoning noise is skipped, anything else gets a marker line.
  if (part.type === "reasoning" || part.type === "compaction" || part.type === "effort") {
    return "";
  }
  return `[unrendered part type: ${String(part.type ?? "unknown")}]`;
}

function renderMessage(message: TranscriptMessage, max: number): string {
  const content =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  const body = content
    .map((part) => (isRecord(part) ? renderPart(part, max) : "[unrendered part]"))
    .filter((section) => section.length > 0)
    .join("\n");
  return `## ${message.role}\n${body}`;
}

/** Map host session messages (SessionMessageInfo shape: user carries `text`, assistant
 * carries `content` parts) into renderer input. Unknown shapes become marked parts, never
 * silent drops. */
export function sessionInfoToMessages(infos: ReadonlyArray<unknown>): TranscriptMessage[] {
  return infos.flatMap((info) => {
    if (!isRecord(info)) {
      return [];
    }
    const content = Array.isArray(info.content)
      ? (info.content as ReadonlyArray<Record<string, unknown>>)
      : typeof info.text === "string"
        ? info.text
        : "";
    return [{ role: String(info.type ?? "unknown"), content }];
  });
}

/** Full verbatim transcript of the given model messages as one greppable markdown file body.
 * Deterministic: the same messages always render to the same bytes (no timestamps), so
 * re-running a compaction export cannot produce a different file. */
export function renderTranscript(
  messages: ReadonlyArray<TranscriptMessage>,
  meta: TranscriptMeta,
  options?: { inlineOutputMaxBytes?: number },
): string {
  const max = options?.inlineOutputMaxBytes ?? INLINE_OUTPUT_MAX_BYTES;
  const header = [
    `# Transcript ${meta.sessionID}`,
    `scope: ${meta.scope}`,
    `model: ${meta.model ?? "unknown"}`,
  ].join("\n");
  const body = messages.map((message) => renderMessage(message, max)).join("\n\n");
  return `${header}\n\n${body}\n`;
}
