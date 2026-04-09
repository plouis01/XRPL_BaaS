import { defineConfig } from "vitest/config";

// Integration-test config for apps/worker.
//
// Integration tests hit the real XRPL testnet (via faucet-funded accounts)
// and the real Redis. They are SLOW and use testnet faucet credits.
//
// Run with: RAILFORGE_TEST_NETWORK=testnet bun run --filter @railforge/worker test:integration
//
// If RAILFORGE_TEST_NETWORK is not set, the test file skips itself so CI
// and local dev don't burn testnet credits on every save.

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    environment: "node",
    globals: false,
    reporters: ["default"],
    // Integration tests talk to the internet — give them room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
