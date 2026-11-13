import { test } from "node:test";
import assert from "node:assert/strict";
import { createAntigravityUsageProvider, quotaSnapshotToUsageReport } from "../extension/usage-report.ts";
import type { AntigravityQuotaSnapshot } from "../extension/usage-accounting.ts";

test("quotaSnapshotToUsageReport maps quota pools, windows, percentages, reset timestamps, and statuses", () => {
  const snapshot: AntigravityQuotaSnapshot = {
    at: Date.UTC(2026, 10, 13, 7, 0, 0),
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { window: "5h", remainingFraction: 0.98, resetTime: "2026-11-13T12:00:00.000Z" },
          { window: "weekly", remainingFraction: 0.08, resetTime: "2026-11-20T00:00:00.000Z" },
        ],
      },
      {
        displayName: "Gemini 4 Argon",
        buckets: [
          { window: "weekly", remainingFraction: 0 },
        ],
      },
    ],
  };

  const report = quotaSnapshotToUsageReport(snapshot, { email: "user@example.com", accountId: "acct-1" });
  assert.equal(report.provider, "antigravity-acp");
  assert.equal(report.fetchedAt, snapshot.at);
  assert.deepEqual(report.metadata, { email: "user@example.com", accountId: "acct-1" });
  assert.equal(report.limits.length, 3);

  assert.deepEqual(report.limits[0], {
    id: "antigravity-acp:gemini-models:5h",
    label: "Gemini Models",
    scope: { provider: "antigravity-acp", windowId: "5h", accountId: "acct-1" },
    window: { id: "5h", label: "5h", durationMs: 5 * 3_600_000, resetsAt: Date.parse("2026-11-13T12:00:00.000Z") },
    amount: { unit: "percent", remainingFraction: 0.98, usedFraction: 0.02, remaining: 98, used: 2, limit: 100 },
    status: "ok",
  });

  assert.equal(report.limits[1]!.id, "antigravity-acp:gemini-models:weekly");
  assert.equal(report.limits[1]!.window?.label, "Weekly");
  assert.equal(report.limits[1]!.window?.durationMs, 7 * 86_400_000);
  assert.equal(report.limits[1]!.status, "warning");

  assert.equal(report.limits[2]!.id, "antigravity-acp:gemini-4-argon:weekly");
  assert.equal(report.limits[2]!.amount.remainingFraction, 0);
  assert.equal(report.limits[2]!.amount.usedFraction, 1);
  assert.equal(report.limits[2]!.status, "exhausted");
});

test("createAntigravityUsageProvider supports fallback api_key and oauth, respects authReady, and handles abort", async () => {
  let signedIn = false;
  let quotaCalls = 0;
  const snapshot: AntigravityQuotaSnapshot = {
    at: 1_794_552_000_000,
    groups: [{ displayName: "Claude and GPT models", buckets: [{ window: "5h", remainingFraction: 1 }] }],
  };
  const provider = createAntigravityUsageProvider({
    authReady: async () => signedIn,
    fetchQuota: async signal => {
      quotaCalls++;
      if (signal?.aborted) throw new Error("aborted");
      return snapshot;
    },
    getAccountEmail: () => "pool@example.com",
  });

  assert.equal(provider.supports({ provider: "antigravity-acp", credential: { type: "api_key" } }), true);
  assert.equal(provider.supports({ provider: "antigravity-acp", credential: { type: "oauth" } }), true);
  assert.equal(provider.supports({ provider: "google-antigravity", credential: { type: "oauth" } }), false);

  assert.equal(await provider.fetchUsage({ provider: "antigravity-acp", credential: { type: "api_key" } }), null);
  assert.equal(quotaCalls, 0);

  signedIn = true;
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await provider.fetchUsage({ provider: "antigravity-acp", credential: { type: "api_key" }, signal: controller.signal }),
    null,
  );
  assert.equal(quotaCalls, 0);

  const report = await provider.fetchUsage({ provider: "antigravity-acp", credential: { type: "api_key" } });
  assert.ok(report);
  assert.equal(quotaCalls, 1);
  assert.equal(report.metadata?.email, "pool@example.com");
  assert.equal(report.limits[0]?.label, "Claude and GPT models");
});
