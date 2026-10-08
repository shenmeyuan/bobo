import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const runFile = promisify(execFile);

export function quotaQueryAgent(message) {
  if (
    message.length > 160 ||
    !/(额度|限额|quota|usage limit)/i.test(message) ||
    !/(多少|剩|查询|查看|刷新|用量|quota|usage)/i.test(message) ||
    /(派发|执行|编写|调度|根据|代码)/.test(message)
  )
    return null;
  const names = [
    ["codex", /codex/i],
    ["claude", /claude|\bcc\b/i],
    ["trae", /trae|coco/i],
    ["doubao", /豆包|doubao/i],
  ];
  const matches = names.filter(([, pattern]) => pattern.test(message));
  return matches.length === 1 ? matches[0][0] : "all";
}

export function formatQuotaReply(agents) {
  return agents
    .map((agent) => {
      const q = agent.quota;
      if (!q || q.status === "unavailable" || q.status === "stale")
        return (
          agent.name +
          "：本次无法读取额度。" +
          (q?.note || "尚未接入额度读取。")
        );
      if (q.source === "manual")
        return (
          agent.name +
          "：手动记录剩余 " +
          (q.remainingPercent ?? "未知") +
          "%，不是实时账号额度。" +
          (q.note || "")
        );
      const windows = (q.windows || []).map((w) => {
        const minutes = w.windowDurationMins;
        const label =
          minutes === 10080
            ? "7 天窗口"
            : minutes === 300
              ? "5 小时窗口"
              : minutes
                ? minutes + " 分钟窗口"
                : "额度窗口";
        return (
          label +
          (w.limitId !== "codex" ? "（" + w.label + "）" : "") +
          "剩余 " +
          w.remainingPercent +
          "%（已用 " +
          w.usedPercent +
          "%）" +
          (w.resetAt
            ? "，重置：" +
              new Date(w.resetAt).toLocaleString("zh-CN", {
                timeZone: "Asia/Shanghai",
                hour12: false,
              }) +
              "（北京时间）"
            : "，重置时间未返回")
        );
      });
      return (
        agent.name +
        "：\n" +
        windows.join("\n") +
        "\n来源：" +
        (q.source === "codex-app-server"
          ? "本机 Codex 登录账号的官方额度接口"
          : "Claude Code 订阅用量接口") +
        "；查询于 " +
        new Date(q.checkedAt).toLocaleTimeString("zh-CN", {
          timeZone: "Asia/Shanghai",
          hour12: false,
        }) +
        "。"
      );
    })
    .join("\n\n");
}

export async function readClaudeQuota({
  fetchUsage = fetch,
  credentialLoader,
} = {}) {
  if (!credentialLoader) {
    let settings = {};
    try {
      settings = JSON.parse(
        await fs.readFile(
          path.join(os.homedir(), ".claude", "settings.json"),
          "utf8",
        ),
      );
    } catch {}
    const endpoint =
      process.env.ANTHROPIC_BASE_URL || settings.env?.ANTHROPIC_BASE_URL;
    if (endpoint) {
      let official = false;
      try {
        official = new URL(endpoint).hostname === "api.anthropic.com";
      } catch {}
      if (!official)
        throw new Error(
          "本机 Claude Code 使用自定义 API 网关，消费计入该网关，不能读取为 Claude 官方订阅额度；网关账户限额接口尚未接入。",
        );
    }
  }
  let credential;
  try {
    credential = credentialLoader
      ? await credentialLoader()
      : process.platform === "darwin"
        ? JSON.parse(
            (
              await runFile(
                "/usr/bin/security",
                [
                  "find-generic-password",
                  "-s",
                  "Claude Code-credentials",
                  "-w",
                ],
                { timeout: 5000, maxBuffer: 100000 },
              )
            ).stdout,
          )
        : JSON.parse(
            await fs.readFile(
              path.join(os.homedir(), ".claude", ".credentials.json"),
              "utf8",
            ),
          );
  } catch {
    throw new Error(
      "无法读取 Claude Code 的订阅登录凭据；登录可能使用企业网关或不同配置目录。",
    );
  }
  const oauth = credential.claudeAiOauth;
  if (!oauth?.accessToken)
    throw new Error("Claude Code 未提供订阅 OAuth 凭据，无法查询订阅窗口。");
  if (oauth.expiresAt && oauth.expiresAt < Date.now())
    throw new Error(
      "Claude Code 登录凭据已过期，请在 Claude Code 中重新登录。",
    );
  const response = await fetchUsage(
    "https://api.anthropic.com/api/oauth/usage",
    {
      headers: {
        Authorization: "Bearer " + oauth.accessToken,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok)
    throw new Error(
      "Claude 额度服务返回 HTTP " +
        response.status +
        "；请检查订阅登录及访问权限。",
    );
  return normalizeClaudeLimits(await response.json());
}

export function normalizeClaudeLimits(data, now = Date.now()) {
  const durations = {
    five_hour: 300,
    seven_day: 10080,
    seven_day_opus: 10080,
    seven_day_sonnet: 10080,
  };
  const windows = [];
  for (const [id, duration] of Object.entries(durations)) {
    const w = data[id];
    if (
      !w ||
      typeof w.utilization !== "number" ||
      !Number.isFinite(w.utilization) ||
      w.utilization < 0
    )
      continue;
    windows.push({
      limitId: id,
      label: id,
      kind: id,
      usedPercent: w.utilization,
      remainingPercent: Math.max(0, Math.min(100, 100 - w.utilization)),
      windowDurationMins: duration,
      resetAt:
        w.resets_at && Number.isFinite(Date.parse(w.resets_at))
          ? new Date(w.resets_at).toISOString()
          : null,
    });
  }
  const current = windows.filter(
    (w) => !w.resetAt || Date.parse(w.resetAt) > now,
  );
  const remaining = current.length
    ? Math.min(...current.map((w) => w.remainingPercent))
    : null;
  return {
    source: "claude-oauth-usage",
    status: current.length ? "fresh" : "unavailable",
    remainingPercent: remaining,
    resetAt:
      current.find((w) => w.remainingPercent === remaining)?.resetAt || null,
    updatedAt: now,
    checkedAt: now,
    windows: current,
    note: current.length
      ? "Claude Code 订阅账号；5 小时、7 天与模型窗口分别计量。"
      : "服务没有返回有效订阅额度窗口。",
  };
}

export function quotaEnvironment(env = process.env) {
  const clean = { ...env };
  for (const key of Object.keys(clean))
    if (
      /^(MODEL_HUB_|OPENAI_|AZURE_OPENAI_|BOBO_)/.test(key) ||
      key === "ELECTRON_RUN_AS_NODE"
    )
      delete clean[key];
  return clean;
}

export function normalizeCodexLimits(result, now = Date.now()) {
  const buckets =
    result.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
      ? Object.entries(result.rateLimitsByLimitId)
      : [["codex", result.rateLimits]];
  const windows = [];
  for (const [id, bucket] of buckets) {
    if (!bucket) continue;
    for (const kind of ["primary", "secondary"]) {
      const w = bucket[kind];
      if (
        !w ||
        typeof w.usedPercent !== "number" ||
        !Number.isFinite(w.usedPercent) ||
        w.usedPercent < 0
      )
        continue;
      const resetAt =
        Number.isFinite(w.resetsAt) && w.resetsAt > 0
          ? new Date(w.resetsAt * 1000).toISOString()
          : null;
      windows.push({
        limitId: id,
        label: bucket.limitName || id,
        kind,
        usedPercent: w.usedPercent,
        remainingPercent: Math.max(0, Math.min(100, 100 - w.usedPercent)),
        windowDurationMins: w.windowDurationMins ?? null,
        resetAt,
      });
    }
  }
  const current = windows.filter(
    (w) => !w.resetAt || Date.parse(w.resetAt) > now,
  );
  const remaining = current.length
    ? Math.min(...current.map((w) => w.remainingPercent))
    : null;
  const limiting = current.find((w) => w.remainingPercent === remaining);
  return {
    source: "codex-app-server",
    status: current.length ? "fresh" : "unavailable",
    remainingPercent: remaining,
    resetAt: limiting?.resetAt || null,
    windows: current,
    updatedAt: now,
    checkedAt: now,
    note: current.length
      ? "本机 Codex CLI 登录账号；不同窗口分别计量，汇总取最低剩余值。"
      : "接口未返回有效额度窗口。",
  };
}

export async function readCodexQuota(
  binary,
  { spawnProcess = spawn, timeoutMs = 12000 } = {},
) {
  if (!binary) throw new Error("未检测到 Codex CLI，请先安装或设置路径。");
  const child = spawnProcess(binary, ["app-server"], {
    env: quotaEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  let buffer = "",
    seq = 0;
  const pending = new Map();
  const fail = () => {
    for (const p of pending.values())
      p.reject(new Error("Codex 额度进程提前退出。"));
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", fail);
  child.stdin.on("error", fail);
  child.stderr.on("data", () => {});
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    if (buffer.length > 1_000_000) {
      fail();
      child.kill();
      return;
    }
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let data;
      try {
        data = JSON.parse(line);
      } catch {
        continue;
      }
      const waiting = pending.get(data.id);
      if (waiting) {
        pending.delete(data.id);
        if (data.error)
          waiting.reject(
            new Error(
              "Codex 额度读取失败：" +
                String(data.error.message || "未知错误").slice(0, 250),
            ),
          );
        else waiting.resolve(data.result);
      }
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      child.stdin.write(
        JSON.stringify({ id, method, ...(params ? { params } : {}) }) + "\n",
      );
    });
  const timeout = setTimeout(() => {
    for (const p of pending.values())
      p.reject(new Error("读取 Codex 额度超时，请检查登录和网络。"));
    pending.clear();
    child.kill();
  }, timeoutMs);
  try {
    await request("initialize", {
      clientInfo: { name: "bobo", title: "Bobo", version: "0.1.0" },
    });
    child.stdin.write(
      JSON.stringify({ method: "initialized", params: {} }) + "\n",
    );
    const account = await request("account/read", { refreshToken: false });
    if (!account?.account)
      throw new Error("Codex CLI 未登录；请运行 codex login。");
    if (account.account.type !== "chatgpt")
      throw new Error(
        "本机 Codex CLI 使用 " +
          account.account.type +
          " 认证，无法读取 ChatGPT 订阅额度。",
      );
    const result = await request("account/rateLimits/read");
    return {
      ...normalizeCodexLimits(result),
      planType: result.rateLimits?.planType || account.account.planType || null,
    };
  } finally {
    clearTimeout(timeout);
    child.stdin.end();
    child.kill();
    pending.clear();
  }
}
