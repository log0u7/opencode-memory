import { describe, expect, it } from "vitest";

import { INLINE_OUTPUT_MAX_BYTES, renderTranscript } from "../src/transcripts.js";

const meta = {
  sessionID: "ses_123",
  scope: "/home/u/project",
  model: "openrouter/z-ai/glm-5.3-flash",
};

describe("renderTranscript", () => {
  it("writes a header with sessionID, scope and model", () => {
    const out = renderTranscript([], meta);
    expect(out).toContain("# Transcript ses_123");
    expect(out).toContain("scope: /home/u/project");
    expect(out).toContain("model: openrouter/z-ai/glm-5.3-flash");
  });

  it("renders user text verbatim", () => {
    const out = renderTranscript(
      [{ role: "user", content: [{ type: "text", text: "Fix the login bug" }] }],
      meta,
    );
    expect(out).toContain("## user\nFix the login bug");
  });

  it("accepts plain string content", () => {
    const out = renderTranscript([{ role: "user", content: "plain string" }], meta);
    expect(out).toContain("## user\nplain string");
  });

  it("renders assistant text and tool calls with exact args", () => {
    const out = renderTranscript(
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me look." },
            {
              type: "tool-call",
              id: "call_1",
              name: "read",
              input: { path: "/etc/hosts" },
            },
          ],
        },
      ],
      meta,
    );
    expect(out).toContain("## assistant\nLet me look.");
    expect(out).toContain("### tool-call read (id call_1)");
    expect(out).toContain('{\n  "path": "/etc/hosts"\n}');
  });

  it("renders tool results inline verbatim", () => {
    const out = renderTranscript(
      [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "call_1",
              name: "read",
              result: { type: "text", value: "127.0.0.1 localhost" },
            },
          ],
        },
      ],
      meta,
    );
    expect(out).toContain("### tool-result read (id call_1)");
    expect(out).toContain("127.0.0.1 localhost");
  });

  it("marks error results", () => {
    const out = renderTranscript(
      [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "call_2",
              name: "shell",
              result: { type: "error", value: "exit code 1" },
            },
          ],
        },
      ],
      meta,
    );
    expect(out).toContain("[error]");
    expect(out).toContain("exit code 1");
  });

  it("renders file parts of content results as reference lines", () => {
    const out = renderTranscript(
      [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "call_3",
              name: "gen",
              result: {
                type: "content",
                value: [{ type: "file", uri: "file:///tmp/a.png", mime: "image/png" }],
              },
            },
          ],
        },
      ],
      meta,
    );
    expect(out).toContain("[file file:///tmp/a.png image/png]");
  });

  it("truncates oversized tool output with the tool call id", () => {
    const big = "x".repeat(INLINE_OUTPUT_MAX_BYTES + 1000);
    const out = renderTranscript(
      [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "call_big",
              name: "shell",
              result: { type: "text", value: big },
            },
          ],
        },
      ],
      meta,
    );
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain(`[truncated ${big.length - 4096} chars; tool call id: call_big]`);
    expect(out).toContain(`${"x".repeat(2048)}`);
  });

  it("respects a cap smaller than the head+tail window", () => {
    const big = "y".repeat(5000);
    const out = renderTranscript(
      [
        {
          role: "tool",
          content: [
            { type: "tool-result", id: "c", name: "t", result: { type: "text", value: big } },
          ],
        },
      ],
      meta,
      { inlineOutputMaxBytes: 1000 },
    );
    expect(out.length).toBeLessThan(1500);
    expect(out).toContain("[truncated; tool call id: c]");
  });

  it("skips reasoning, compaction and effort parts", () => {
    const out = renderTranscript(
      [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "internal thoughts" },
            { type: "compaction", provider: "anthropic", text: "summary" },
            { type: "effort" },
            { type: "text", text: "visible" },
          ],
        },
      ],
      meta,
    );
    expect(out).not.toContain("internal thoughts");
    expect(out).not.toContain("summary");
    expect(out).toContain("visible");
  });

  it("marks media parts as omitted instead of dropping them silently", () => {
    const out = renderTranscript(
      [
        {
          role: "user",
          content: [
            { type: "media", media: { source: { type: "url", data: "https://x/y.png" } } },
            { type: "text", text: "look at this" },
          ],
        },
      ],
      meta,
    );
    expect(out).toContain("[media omitted]");
    expect(out).toContain("look at this");
  });

  it("is idempotent: same messages render byte-identically", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "hi" },
          { type: "tool-call", id: "c", name: "t", input: { a: 1 } },
        ],
      },
    ];
    expect(renderTranscript(messages, meta)).toBe(renderTranscript(messages, meta));
  });

  it("renders json tool results as JSON", () => {
    const out = renderTranscript(
      [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "c",
              name: "t",
              result: { type: "json", value: { ok: true } },
            },
          ],
        },
      ],
      meta,
    );
    expect(out).toContain('"ok": true');
  });

  it("falls back to JSON for unknown result types instead of dropping them", () => {
    const out = renderTranscript(
      [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "c",
              name: "t",
              result: { type: "future-kind", value: 42 },
            },
          ],
        },
      ],
      meta,
    );
    expect(out).toContain('"future-kind"');
    expect(out).toContain("42");
  });

  it("falls back to a plain string for non-record results", () => {
    const out = renderTranscript(
      [
        {
          role: "tool",
          content: [{ type: "tool-result", id: "c", name: "t", result: "raw string" }],
        },
      ],
      meta,
    );
    expect(out).toContain("raw string");
  });

  it("marks unknown content parts and keeps file names", () => {
    const out = renderTranscript(
      [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "c",
              name: "t",
              result: {
                type: "content",
                value: [
                  { type: "file", uri: "file:///a.txt", mime: "text/plain", name: "a.txt" },
                  { type: "holo", value: 1 },
                ],
              },
            },
          ],
        },
      ],
      meta,
    );
    expect(out).toContain("[file file:///a.txt text/plain name=a.txt]");
    expect(out).toContain("[unrendered content part: holo]");
  });

  it("marks unknown part types with a marker line", () => {
    const out = renderTranscript(
      [{ role: "assistant", content: [{ type: "hologram", text: "?" }] }],
      meta,
    );
    expect(out).toContain("[unrendered part type: hologram]");
  });

  it("marks non-record parts instead of crashing", () => {
    const out = renderTranscript(
      [{ role: "user", content: [42, { type: "text", text: "ok" }] }],
      meta,
    );
    expect(out).toContain("[unrendered part]");
    expect(out).toContain("ok");
  });

  it("survives cyclic tool input via the JSON fallback", () => {
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    const out = renderTranscript(
      [{ role: "assistant", content: [{ type: "tool-call", id: "c", name: "t", input: cyclic }] }],
      meta,
    );
    expect(out).toContain("[object Object]");
  });

  it("labels a non-string tool id as unknown in truncation markers", () => {
    const big = "z".repeat(INLINE_OUTPUT_MAX_BYTES + 10);
    const out = renderTranscript(
      [
        {
          role: "tool",
          content: [
            { type: "tool-result", id: 42, name: "t", result: { type: "text", value: big } },
          ],
        },
      ],
      meta,
    );
    expect(out).toContain("tool call id: unknown]");
  });

  it("renders an empty content array as an empty body", () => {
    const out = renderTranscript([{ role: "user", content: [] }], meta);
    expect(out).toContain("## user\n");
  });
});
