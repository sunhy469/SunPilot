import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["agent/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      GOLDEN_TASKS_ENABLED: "true",
    },
  },
});
