import { describe, expect, it, vi } from "vitest";

import {
  createReflection,
  distillPrompt,
  parseLessons,
  parseReflectionConfig,
  type ReflectionDeps,
} from "../src/lib/reflection.js";

const TRANSCRIPT = [
  "user: migrate the postgres tables",
  "assistant: first attempt fired one giant UPDATE and hit lock contention for 40s.",
  "assistant: retry with batches of 1000 rows: clean run. batching by 1000 avoided lock contention.",
  "user: good, apply that everywhere",
  "assistant: applied the same batch size to the cleanup query, no contention since.",
].join("\n");

function deps(
  overrides: Partial<ReflectionDeps> = {},
): ReflectionDeps & Record<string, ReturnType<typeof vi.fn>> {
  return {
    isSubagent: vi.fn(async () => false),
    transcript: vi.fn(async () => TRANSCRIPT),
    generate: vi.fn(async () =>
      JSON.stringify([{ title: "batch first", body: "batching by 1000 avoided lock contention" }]),
    ),
    saveLesson: vi.fn(),
    ...overrides,
  };
}

function enabled(overrides: Record<string, unknown> = {}) {
  return { enabled: true, maxLessons: 3, transcriptChars: 8000, ...overrides };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("parseReflectionConfig", () => {
  it("is null unless explicitly enabled", () => {
    expect(parseReflectionConfig(undefined)).toBeNull();
    expect(parseReflectionConfig({})).toBeNull();
    expect(parseReflectionConfig({ enabled: false })).toBeNull();
  });

  it("keeps options and clamps ranges", () => {
    const config = parseReflectionConfig({
      enabled: true,
      model: "zhip/glm",
      maxLessons: 99,
      transcriptChars: 1,
    });
    expect(config).toEqual({
      enabled: true,
      model: "zhip/glm",
      maxLessons: 10,
      transcriptChars: 500,
    });
    expect(parseReflectionConfig({ enabled: true })).toEqual({
      enabled: true,
      model: undefined,
      maxLessons: 3,
      transcriptChars: 8000,
    });
  });
});

describe("parseLessons", () => {
  it("reads a plain array and caps it", () => {
    const lessons = parseLessons(
      JSON.stringify([
        { title: "a", body: "b" },
        { title: "c", body: "d" },
      ]),
      1,
    );
    expect(lessons).toEqual([{ title: "a", body: "b" }]);
  });

  it("reads a markdown-fenced array", () => {
    const lessons = parseLessons('```json\n[{"title": "a", "body": "b"}]\n```', 3);
    expect(lessons).toEqual([{ title: "a", body: "b" }]);
  });

  it("returns nothing for malformed replies", () => {
    expect(parseLessons("no json here", 3)).toEqual([]);
    expect(parseLessons('{"title": "a"}', 3)).toEqual([]);
    expect(parseLessons('[{"title": 1, "body": "b"}]', 3)).toEqual([]);
    expect(parseLessons('[{"title": "  ", "body": "b"}]', 3)).toEqual([]);
  });

  it("enforces the store caps on title and body", () => {
    const lessons = parseLessons(
      JSON.stringify([{ title: "t".repeat(200), body: "b".repeat(9000) }]),
      3,
    );
    expect(lessons[0]?.title).toHaveLength(120);
    expect(lessons[0]?.body).toHaveLength(8000);
  });
});

describe("distillPrompt", () => {
  it("embeds the transcript and the lesson budget", () => {
    const prompt = distillPrompt(TRANSCRIPT, 3);
    expect(prompt).toContain("SESSION TRANSCRIPT");
    expect(prompt).toContain(TRANSCRIPT);
    expect(prompt).toContain("3");
  });
});

describe("createReflection", () => {
  it("does nothing when disabled", async () => {
    const d = deps();
    const onIdle = createReflection({ enabled: false, maxLessons: 3, transcriptChars: 8000 }, d);
    onIdle("s1");
    await flush();
    expect(d.generate).not.toHaveBeenCalled();
  });

  it("distills the transcript and saves lessons with the given budget", async () => {
    const d = deps();
    const onIdle = createReflection(enabled({ maxLessons: 2 }), d);
    onIdle("s1");
    await vi.waitFor(() => expect(d.saveLesson).toHaveBeenCalled());
    expect(d.transcript).toHaveBeenCalledWith("s1");
    expect(d.saveLesson).toHaveBeenCalledWith(
      "batch first",
      "batching by 1000 avoided lock contention",
    );
    expect(d.generate).toHaveBeenCalledWith(expect.any(String), "s1");
  });

  it("reflects at most once per session", async () => {
    const d = deps();
    const onIdle = createReflection(enabled(), d);
    onIdle("s1");
    await vi.waitFor(() => expect(d.saveLesson).toHaveBeenCalled());
    onIdle("s1");
    await flush();
    expect(d.generate).toHaveBeenCalledTimes(1);
  });

  it("skips subagent sessions for good", async () => {
    const d = deps({ isSubagent: vi.fn(async () => true) });
    const onIdle = createReflection(enabled(), d);
    onIdle("s1");
    await vi.waitFor(() => expect(d.isSubagent).toHaveBeenCalled());
    onIdle("s1");
    await flush();
    expect(d.generate).not.toHaveBeenCalled();
  });

  it("sends only the transcript tail within the char budget", async () => {
    const long = TRANSCRIPT + "\n" + "padding line for the tail test\n".repeat(40);
    const d = deps({ transcript: vi.fn(async () => long) });
    const onIdle = createReflection(enabled({ transcriptChars: 100 }), d);
    onIdle("s1");
    await vi.waitFor(() => expect(d.generate).toHaveBeenCalled());
    expect(String(d.generate.mock.calls[0]?.[0]).endsWith(long.slice(-100))).toBe(true);
  });

  it("skips sessions without a usable transcript", async () => {
    const d = deps({ transcript: vi.fn(async () => "too short") });
    const onIdle = createReflection(enabled(), d);
    onIdle("s1");
    await flush();
    expect(d.generate).not.toHaveBeenCalled();
  });

  it("retries after a too-short first idle instead of poisoning the session", async () => {
    let calls = 0;
    const d = deps({
      transcript: vi.fn(async () => {
        calls += 1;
        return calls === 1 ? "too short" : TRANSCRIPT;
      }),
    });
    const onIdle = createReflection(enabled(), d);
    onIdle("s1");
    await flush();
    expect(d.generate).not.toHaveBeenCalled();
    onIdle("s1");
    await vi.waitFor(() => expect(d.generate).toHaveBeenCalledTimes(1));
    expect(d.saveLesson).toHaveBeenCalledWith(
      "batch first",
      "batching by 1000 avoided lock contention",
    );
  });

  it("ignores malformed model replies without throwing", async () => {
    const d = deps({ generate: vi.fn(async () => "absolute garbage") });
    const onIdle = createReflection(enabled(), d);
    onIdle("s1");
    await vi.waitFor(() => expect(d.generate).toHaveBeenCalled());
    expect(d.saveLesson).not.toHaveBeenCalled();
  });

  it("collapses concurrent idle events into one reflection", async () => {
    let release: ((text: string) => void) | undefined;
    const d = deps({ generate: vi.fn(() => new Promise<string>((r) => (release = r))) });
    const onIdle = createReflection(enabled(), d);
    onIdle("s1");
    await flush();
    expect(d.generate).toHaveBeenCalledTimes(1);
    onIdle("s1");
    await flush();
    release?.(JSON.stringify([{ title: "t", body: "b" }]));
    await flush();
    expect(d.generate).toHaveBeenCalledTimes(1);
    expect(d.saveLesson).toHaveBeenCalledWith("t", "b");
  });

  it("keeps a crashed reflection from crashing the host", async () => {
    const d = deps({
      transcript: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const onIdle = createReflection(enabled(), d);
    expect(() => onIdle("s1")).not.toThrow();
    await flush();
    expect(d.generate).not.toHaveBeenCalled();
  });

  it("settles the session after a failed attempt, so it is not retried", async () => {
    const d = deps({
      generate: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const onIdle = createReflection(enabled(), d);
    onIdle("s1");
    await vi.waitFor(() => expect(d.generate).toHaveBeenCalledTimes(1));
    onIdle("s1");
    await flush();
    expect(d.generate).toHaveBeenCalledTimes(1);
  });

  it("drops an idle landing during an unsettled run, then retries once", async () => {
    let release: ((text: string) => void) | undefined;
    const d = deps({
      transcript: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      ),
    });
    const onIdle = createReflection(enabled(), d);
    onIdle("s1");
    await flush();
    expect(d.transcript).toHaveBeenCalledTimes(1);
    onIdle("s1");
    await flush();
    expect(d.transcript).toHaveBeenCalledTimes(1);
    release?.("too short");
    await flush();
    onIdle("s1");
    await flush();
    expect(d.transcript).toHaveBeenCalledTimes(2);
    release?.("too short");
    await flush();
    expect(d.generate).not.toHaveBeenCalled();
  });
});
