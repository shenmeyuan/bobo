import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCodexLimits,
  normalizeClaudeLimits,
  quotaEnvironment,
  quotaQueryAgent,
  formatQuotaReply,
  readClaudeQuota,
} from "../electron/quota.mjs";
const now = Date.now(),
  future = Math.floor(now / 1000) + 3600;
test("Codex uses multi-bucket windows, preserves unknown and clamps over-limit values", () => {
  const quota = normalizeCodexLimits(
    {
      rateLimits: { primary: { usedPercent: 99 } },
      rateLimitsByLimitId: {
        codex: {
          primary: {
            usedPercent: 17,
            windowDurationMins: 10080,
            resetsAt: future,
          },
          secondary: {
            usedPercent: 20,
            windowDurationMins: 300,
            resetsAt: future,
          },
        },
        other: { primary: { usedPercent: null } },
      },
    },
    now,
  );
  assert.equal(quota.remainingPercent, 80);
  assert.equal(quota.windows.length, 2);
  assert.equal(
    normalizeCodexLimits(
      { rateLimits: { primary: { usedPercent: null } } },
      now,
    ).remainingPercent,
    null,
  );
  assert.equal(
    normalizeCodexLimits({ rateLimits: { primary: { usedPercent: 104 } } }, now)
      .remainingPercent,
    0,
  );
  assert.equal(
    normalizeCodexLimits(
      { rateLimits: { primary: { usedPercent: 80, resetsAt: future - 7200 } } },
      now,
    ).status,
    "unavailable",
  );
});
test("Claude windows retain individual resets; credentials never appear in output", async () => {
  const quota = await readClaudeQuota({
    credentialLoader: async () => ({
      claudeAiOauth: { accessToken: "private-token", expiresAt: now + 100000 },
    }),
    fetchUsage: async (url, options) => {
      assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
      assert.equal(options.headers.Authorization, "Bearer private-token");
      return {
        ok: true,
        json: async () => ({
          five_hour: {
            utilization: 12,
            resets_at: new Date(future * 1000).toISOString(),
          },
          seven_day: {
            utilization: 30,
            resets_at: new Date(future * 1000).toISOString(),
          },
        }),
      };
    },
  });
  assert.equal(quota.remainingPercent, 70);
  assert.equal(JSON.stringify(quota).includes("private-token"), false);
  assert.equal(
    normalizeClaudeLimits({ five_hour: { utilization: null } }).status,
    "unavailable",
  );
});
test("quota queries bypass models without intercepting work requests; sources remain explicit", () => {
  assert.equal(quotaQueryAgent("我codex还有多少额度啊？"), "codex");
  assert.equal(quotaQueryAgent("查询cc剩余额度"), "claude");
  assert.equal(quotaQueryAgent("查看所有智能体额度"), "all");
  assert.equal(quotaQueryAgent("根据额度帮我调度任务"), null);
  const q = normalizeCodexLimits(
    {
      rateLimits: {
        primary: {
          usedPercent: 17,
          windowDurationMins: 10080,
          resetsAt: future,
        },
      },
    },
    now,
  );
  const reply = formatQuotaReply([{ name: "Codex", quota: q }]);
  assert.match(reply, /剩余 83%/);
  assert.match(reply, /7 天/);
  assert.match(reply, /重置/);
  assert.match(reply, /来源/);
  const env = quotaEnvironment({
    MODEL_HUB_AK: "secret",
    OPENAI_API_KEY: "secret",
    PATH: "/bin",
    HOME: "/home",
  });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home" });
});
