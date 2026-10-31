import test from "node:test";
import assert from "node:assert/strict";
import { usageLedger } from "../electron/usage-ledger.mjs";
test("ledger preserves failed attempts and unknown usage, cache is not counted twice and shared calls are explicit", () => {
  const result = usageLedger(
    [
      {
        id: "first",
        agent: "codex",
        status: "failed",
        createdAt: 1000,
        finishedAt: 4000,
        usage: { input: 100, output: 20, cacheRead: 70, cost: 0 },
      },
      {
        id: "retry",
        agent: "claude",
        status: "running",
        createdAt: 5000,
        usage: null,
      },
    ],
    [{ rootIds: ["one", "two"], input: 10, output: 2, calls: 1 }],
    9000,
  );
  assert.equal(result.entries[0].input, 100);
  assert.equal(result.cacheRead, 70);
  assert.equal(result.entries[1].reported, false);
  assert.equal(result.entries[1].reportedCost, null);
  assert.equal(result.entries[0].reportedCost, 0);
  assert.equal(result.entries[2].shared, true);
  assert.equal(result.complete, false);
  assert.equal(result.elapsedMs, 8000);
});
