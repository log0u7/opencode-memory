import { describe, expect, it } from "vitest";

import { INLINE_OUTPUT_MAX_BYTES } from "../src/transcripts.js";
import { parseRetrievalConfig } from "../src/options.js";

describe("parseRetrievalConfig", () => {
  it("defaults to enabled with the plugin data dir and the inline cap", () => {
    const config = parseRetrievalConfig({});
    expect(config.enabled).toBe(true);
    expect(config.dir).toMatch(/opencode-memory\/transcripts$/);
    expect(config.inlineOutputMaxBytes).toBe(INLINE_OUTPUT_MAX_BYTES);
  });

  it("honours explicit options", () => {
    const config = parseRetrievalConfig({
      retrieval: { enabled: false, dir: "/tmp/t", inlineOutputMaxBytes: 1000 },
    });
    expect(config.enabled).toBe(false);
    expect(config.dir).toBe("/tmp/t");
    expect(config.inlineOutputMaxBytes).toBe(1000);
  });

  it("falls back to defaults for invalid values", () => {
    const config = parseRetrievalConfig({
      retrieval: { dir: "", inlineOutputMaxBytes: -5 },
    });
    expect(config.dir).toMatch(/opencode-memory\/transcripts$/);
    expect(config.inlineOutputMaxBytes).toBe(INLINE_OUTPUT_MAX_BYTES);
  });
});
