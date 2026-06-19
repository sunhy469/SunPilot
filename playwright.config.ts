import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000, // skill calls can take a while (LLM + external APIs)
  expect: { timeout: 30_000 },
  fullyParallel: false, // run sequentially to avoid API rate limits
  retries: 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3737",
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
