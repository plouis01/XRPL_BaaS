import { defineConfig } from "vitest/config";

// Integration-test config for apps/api.
//
// Mirrors apps/worker/vitest.integration.config.ts. Currently no api-side
// integration tests exist (Sprint 3 added the treasury test in apps/worker
// because the worker holds the signer). When api integration tests land —
// e.g. an end-to-end POST /v1/accounts → DB → enqueue → response check —
// they go in src/**/*.integration.test.ts and pick up this config
// automatically.
//
// --passWithNoTests on the script means CI doesn't fail on the empty case.

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    environment: "node",
    globals: false,
    reporters: ["default"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
