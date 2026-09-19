import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Run in the main thread to keep the suite hermetic in restricted CI/sandbox
    // environments that block worker/process spawning.
    pool: "threads",
    // @ts-expect-error vitest runtime accepts singleThread, but bundled types lag behind.
    singleThread: true,
    isolate: false,
    fileParallelism: false,
  },
});
