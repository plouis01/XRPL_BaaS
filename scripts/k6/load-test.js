// k6 load test for RailForge API.
// Run: k6 run scripts/k6/load-test.js
//
// Requires:
//   K6_API_KEY — a valid rf_test_ API key
//   K6_API_BASE — API base URL (default: http://localhost:3000)
//
// Targets from PLAN.md §8: 500 tx/second submission rate on testnet.
// This script tests API throughput (not XRPL submission throughput).

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

const API_BASE = __ENV.K6_API_BASE || "http://localhost:3000";
const API_KEY = __ENV.K6_API_KEY || "rf_test_missing_key";

// Custom metrics
const errorRate = new Rate("errors");
const createAccountDuration = new Trend("create_account_duration");
const getAccountDuration = new Trend("get_account_duration");
const healthCheckDuration = new Trend("health_check_duration");
const rateLimited = new Counter("rate_limited");

// Stages: ramp up, sustain, ramp down
export const options = {
  stages: [
    { duration: "30s", target: 20 }, // ramp up to 20 VUs
    { duration: "1m", target: 50 }, // ramp to 50 VUs
    { duration: "2m", target: 50 }, // sustain 50 VUs
    { duration: "30s", target: 100 }, // spike to 100 VUs
    { duration: "1m", target: 100 }, // sustain spike
    { duration: "30s", target: 0 }, // ramp down
  ],
  thresholds: {
    http_req_duration: ["p(95)<500", "p(99)<1000"], // 95th < 500ms, 99th < 1s
    errors: ["rate<0.1"], // <10% error rate
    rate_limited: ["count<100"], // fewer than 100 rate-limited responses
  },
};

const headers = {
  "X-Api-Key": API_KEY,
  "Content-Type": "application/json",
};

// Health check (no auth)
function healthCheck() {
  const res = http.get(`${API_BASE}/health`);
  healthCheckDuration.add(res.timings.duration);
  check(res, {
    "health: status 200": (r) => r.status === 200,
  });
}

// Create account (POST, requires auth + idempotency)
function createAccount() {
  const idempotencyKey = `k6-${__VU}-${__ITER}-${Date.now()}`;
  const res = http.post(
    `${API_BASE}/v1/accounts`,
    JSON.stringify({ label: `k6-test-${__VU}-${__ITER}` }),
    {
      headers: { ...headers, "Idempotency-Key": idempotencyKey },
    },
  );
  createAccountDuration.add(res.timings.duration);

  if (res.status === 429) {
    rateLimited.add(1);
  }

  const ok = check(res, {
    "create: status 201 or 429": (r) => r.status === 201 || r.status === 429,
  });
  errorRate.add(!ok);

  // Return address for subsequent reads
  if (res.status === 201) {
    try {
      return JSON.parse(res.body).address;
    } catch {
      return null;
    }
  }
  return null;
}

// Get account (GET, requires auth)
function getAccount(address) {
  if (!address) return;
  const res = http.get(`${API_BASE}/v1/accounts/${address}`, { headers });
  getAccountDuration.add(res.timings.duration);

  if (res.status === 429) {
    rateLimited.add(1);
  }

  const ok = check(res, {
    "get: status 200 or 429": (r) => r.status === 200 || r.status === 429,
  });
  errorRate.add(!ok);
}

// Main scenario: mix of operations
export default function () {
  // 40% health checks (lightweight, tests throughput ceiling)
  // 30% account creation (heavy, tests DB + queue)
  // 30% account reads (medium, tests DB reads)
  const roll = Math.random();

  if (roll < 0.4) {
    healthCheck();
  } else if (roll < 0.7) {
    const address = createAccount();
    if (address) {
      sleep(0.1);
      getAccount(address);
    }
  } else {
    // Read a well-known test account (or handle 404 gracefully)
    getAccount("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh");
  }

  sleep(0.1); // small pause between iterations
}
