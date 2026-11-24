import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectCaveman, opencodeConfigDir, resolveCaveman } from "../src/lib/caveman.js";
import { SYSTEM_GUIDANCE, SYSTEM_GUIDANCE_CAVEMAN } from "../src/options.js";

let root: string;
let config: string;
let project: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "opencode-memory-caveman-"));
  config = join(root, "config");
  project = join(root, "project");
  mkdirSync(config, { recursive: true });
  mkdirSync(join(project, ".opencode"), { recursive: true });
  env = { OPENCODE_CONFIG_DIR: config, HOME: root };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("opencodeConfigDir", () => {
  it("follows OPENCODE_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config", () => {
    expect(opencodeConfigDir({ OPENCODE_CONFIG_DIR: "/x/oc" })).toBe("/x/oc");
    expect(opencodeConfigDir({ OPENCODE_CONFIG_DIR: " ", XDG_CONFIG_HOME: "/xdg" })).toBe(
      "/xdg/opencode",
    );
    expect(opencodeConfigDir({ HOME: "/home/u" })).toBe("/home/u/.config/opencode");
  });
});

describe("detectCaveman", () => {
  it("is false on a clean setup", () => {
    writeFileSync(join(config, "opencode.json"), '{"plugin":["@log0u7/opencode-memory"]}');
    expect(detectCaveman(project, env)).toBe(false);
  });

  it("detects the upstream mode flag", () => {
    writeFileSync(join(config, ".caveman-active"), "full");
    expect(detectCaveman(project, env)).toBe(true);
  });

  it("detects the upstream always-on block in the global or project AGENTS.md", () => {
    writeFileSync(
      join(config, "AGENTS.md"),
      "x\n<!-- caveman-begin -->\nrules\n<!-- caveman-end -->\n",
    );
    expect(detectCaveman(undefined, env)).toBe(true);
    rmSync(join(config, "AGENTS.md"));
    writeFileSync(join(project, ".opencode", "AGENTS.md"), "<!-- caveman-begin -->");
    expect(detectCaveman(project, env)).toBe(true);
  });

  it("detects a plugin entry naming caveman or one of its ports", () => {
    for (const entry of [
      "./plugins/caveman",
      "opencode-caveman",
      "@mumme-it/opencode-caveman",
      "caveopen",
    ]) {
      writeFileSync(join(config, "opencode.jsonc"), `{ // c\n "plugin": ["${entry}"] }`);
      expect(detectCaveman(project, env)).toBe(true);
    }
  });
});

describe("resolveCaveman", () => {
  it("lets true/false override detection, anything else detects", () => {
    expect(resolveCaveman(true, project, env)).toBe(true);
    writeFileSync(join(config, ".caveman-active"), "full");
    expect(resolveCaveman(false, project, env)).toBe(false);
    expect(resolveCaveman("auto", project, env)).toBe(true);
    expect(resolveCaveman(undefined, project, env)).toBe(true);
  });
});

describe("guidance variants", () => {
  it("only the caveman variant mentions caveman, and it is shorter", () => {
    expect(SYSTEM_GUIDANCE).not.toMatch(/caveman/i);
    expect(SYSTEM_GUIDANCE_CAVEMAN).toMatch(/caveman-terse/);
    expect(SYSTEM_GUIDANCE_CAVEMAN.length).toBeLessThan(SYSTEM_GUIDANCE.length);
  });
});
