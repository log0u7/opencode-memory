import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    // The sqlite adapter test flips process.versions.bun for one test, so test files must
    // not share a process. Forks is the default; this pins it against a switch to threads,
    // where a concurrent file opening the store would read the flipped version.
    pool: "forks",
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 80,
      },
    },
  },
});
