import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["reflect-metadata"],
    include: ["test/**/*.test.ts", "examples/**/test/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    // The pool-reset stress test intentionally hammers a small pool with
    // lots of concurrent async work; keep it from being parallelized away
    // against the other DB-using suites to avoid pool exhaustion noise.
    fileParallelism: false,
  },
});
