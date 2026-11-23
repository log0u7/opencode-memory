/**
 * Optional end-of-turn reflection: distills durable lessons from a session tail with
 * one bounded LLM call and saves them as `lesson` entries. Best-effort by design:
 * a disabled config wires nothing, a failing run is swallowed, and each session is
 * reflected at most once.
 */

export type ReflectionConfig = {
  enabled: boolean;
  model?: string | undefined;
  transcriptChars: number;
  timeoutMs: number;
};

/** The inference-only reflection loop: a standing directive (the current model distills
 * lessons itself, no separate call). On by default; `reflection: false` — or an object
 * config without `enabled: true` — switches the loop off. */
export type ReflectionActivation = {
  enabled: boolean;
};

export function parseReflectionActivation(raw: unknown): ReflectionActivation {
  if (raw === false) {
    return { enabled: false };
  }
  if (raw !== null && typeof raw === "object") {
    return { enabled: (raw as { enabled?: unknown }).enabled === true };
  }
  return { enabled: true };
}

/** The trigger injected next to the standing memory guidance: the agent distills the
 * lesson itself — the current model holds the correction's context, so no separate
 * model call is needed. The anti-spam work is the quality bar below plus the store's
 * replace-by-title dedup and the sweep, not a per-day cap: a burst (fresh install,
 * new model) legitimately produces many lessons at once, and a capped one is lost
 * for good. */
export function reflectionGuidance(): string {
  return (
    "Reflect in-context when corrected or when an approach fails: distill the lesson yourself — " +
    "(1) the error, (2) the rule that prevents it — and save it with " +
    "memory_save(kind=lesson, paths=[the files involved]). " +
    "A lesson is a non-obvious approach that clearly failed or clearly succeeded, and why; " +
    "refine an existing lesson (same title) instead of stacking a new one."
  );
}

export type ReflectionDeps = {
  isSubagent: (sessionID: string) => Promise<boolean>;
  transcript: (sessionID: string) => Promise<string>;
  generate: (prompt: string, sessionID: string, signal: AbortSignal) => Promise<string>;
  saveLesson: (title: string, body: string) => void;
};

/** One reflection distills a bounded handful of lessons: a per-call cap on what the
 * model may return, not a per-day budget (bursts are legitimate knowledge). */
const MAX_LESSONS_PER_REFLECTION = 3;
const TRANSCRIPT_CHARS_DEFAULT = 8000;
const TRANSCRIPT_CHARS_MIN = 500;
const TRANSCRIPT_CHARS_MAX = 50000;
const TIMEOUT_MS_DEFAULT = 60000;
const TIMEOUT_MS_MIN = 1000;
const TIMEOUT_MS_MAX = 600000;
/** Below this much transcript there is nothing to distill; saves the LLM call. */
const TRANSCRIPT_MIN_CHARS = 256;
const MAX_TRACKED = 512;

export function parseReflectionConfig(raw: unknown): ReflectionConfig | null {
  if (raw === null || typeof raw !== "object" || (raw as { enabled?: unknown }).enabled !== true) {
    return null;
  }
  const rawConfig = raw as {
    model?: unknown;
    transcriptChars?: unknown;
    timeoutMs?: unknown;
  };
  return {
    enabled: true,
    model:
      typeof rawConfig.model === "string" && rawConfig.model.includes("/")
        ? rawConfig.model
        : undefined,
    transcriptChars: clamp(
      rawConfig.transcriptChars,
      TRANSCRIPT_CHARS_MIN,
      TRANSCRIPT_CHARS_MAX,
      TRANSCRIPT_CHARS_DEFAULT,
    ),
    timeoutMs: clamp(rawConfig.timeoutMs, TIMEOUT_MS_MIN, TIMEOUT_MS_MAX, TIMEOUT_MS_DEFAULT),
  };
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function distillPrompt(transcript: string, maxLessons: number): string {
  return (
    `You are the persistent-memory reflection for this project's OpenCode sessions. Below is the tail of one ` +
    `coding session transcript. Extract at most ${maxLessons} durable, reusable lessons: non-obvious approaches ` +
    `that clearly failed and why, non-obvious approaches that clearly worked and why, or constraints discovered ` +
    `the hard way. Exclude anything trivially re-derivable from the code, anything session-specific, and any ` +
    `credential. Reply with ONLY a JSON array, no markdown fences and no prose: ` +
    `[{"title": "max 120 chars", "body": "the lesson, max 8000 chars"}]. Reply [] when nothing qualifies.\n\n` +
    `SESSION TRANSCRIPT:\n${transcript}`
  );
}

export function parseLessons(text: string, max: number): Array<{ title: string; body: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const fenced = text
      .replace(/^```(?:json)?/m, "")
      .replace(/```$/m, "")
      .trim();
    try {
      parsed = JSON.parse(fenced);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const lessons: Array<{ title: string; body: string }> = [];
  for (const item of parsed.slice(0, max)) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const { title, body } = item as { title?: unknown; body?: unknown };
    if (typeof title !== "string" || typeof body !== "string" || !title.trim() || !body.trim()) {
      continue;
    }
    lessons.push({ title: title.slice(0, 120), body: body.slice(0, 8000) });
  }
  return lessons;
}

export function createReflection(
  config: ReflectionConfig,
  deps: ReflectionDeps,
): (sessionID: string | undefined) => void {
  const done = new Set<string>();
  const inFlight = new Set<string>();

  const run = async (sessionID: string) => {
    // Only a session we actually tried to reflect is marked done. A too-short
    // transcript leaves it unsettled, so a later, longer idle can still reflect it
    // once: idle fires at the end of every turn, not once per session.
    let settled = false;
    try {
      if (await deps.isSubagent(sessionID)) {
        settled = true;
        return;
      }
      const tail = (await deps.transcript(sessionID)).slice(-config.transcriptChars);
      if (tail.length < Math.min(TRANSCRIPT_MIN_CHARS, config.transcriptChars)) {
        return;
      }
      settled = true;
      // Bound the LLM call: a hung provider must not wedge a session forever. The
      // hosts forward this signal to the SDK, so the abort also unblocks their own
      // cleanup (the v1 host deletes the ephemeral child session in its `finally`).
      const reply = await deps.generate(
        distillPrompt(tail, MAX_LESSONS_PER_REFLECTION),
        sessionID,
        AbortSignal.timeout(config.timeoutMs),
      );
      for (const lesson of parseLessons(reply, MAX_LESSONS_PER_REFLECTION)) {
        deps.saveLesson(lesson.title, lesson.body);
      }
    } catch {
      // Reflection is best-effort: never surface a failure to the host. A failed
      // attempt still settles the session so a broken pipeline is not retried forever.
      settled = true;
    } finally {
      inFlight.delete(sessionID);
      if (settled) {
        done.add(sessionID);
        if (done.size > MAX_TRACKED) {
          done.clear();
        }
      }
    }
  };

  return (sessionID) => {
    if (!sessionID || !config.enabled || done.has(sessionID) || inFlight.has(sessionID)) {
      return;
    }
    inFlight.add(sessionID);
    void run(sessionID);
  };
}
