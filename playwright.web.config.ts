import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/local_web",
  testMatch: "*.spec.ts",
  timeout: 30000,
  workers: 1,
  use: { viewport: { width: 1180, height: 800 }, reducedMotion: "reduce" },
  outputDir: "artifacts/local-web-tests",
  reporter: "list",
});
