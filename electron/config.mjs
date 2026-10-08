import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function loadConfig() {
  const envPath = process.env.BOBO_ENV_PATH || path.join(ROOT, ".env");
  const file = fs.existsSync(envPath)
    ? dotenv.parse(fs.readFileSync(envPath))
    : {};
  const read = (key, fallback = "") =>
    file[key] || process.env[key] || fallback;
  const openaiKey = read("OPENAI_API_KEY"),
    hubKey = read("MODEL_HUB_AK");
  const provider = !openaiKey && hubKey ? "model-hub" : "openai";
  const requestedHubURL =
    read("MODEL_HUB_BASE_URL") ||
    read("MODEL_HUB_URL") ||
    read("OPENAI_BASE_URL");
  let hubURL = "";
  if (requestedHubURL) {
    try {
      const url = new URL(requestedHubURL);
      if (
        ["http:", "https:"].includes(url.protocol) &&
        url.hostname !== "api.openai.com"
      )
        hubURL = requestedHubURL;
    } catch {
      /* Keep invalid configuration local; never send a credential to an inferred endpoint. */
    }
  }
  const protocol =
    provider === "model-hub" ? read("MODEL_HUB_PROTOCOL", "openai") : "openai";
  const configurationIssue =
    provider === "model-hub" && !hubURL
      ? "MODEL_HUB_AK 已读取，还需要在 .env 填写 MODEL_HUB_BASE_URL（Model Hub 接口地址）。"
      : !["openai", "azure"].includes(protocol)
        ? "MODEL_HUB_PROTOCOL 需要填写 azure 或 openai。"
        : "";
  return {
    key: openaiKey || hubKey,
    redactionKeys: [openaiKey, hubKey].filter(Boolean),
    provider,
    protocol,
    apiVersion: read("MODEL_HUB_API_VERSION", "2024-02-01"),
    configurationIssue,
    model:
      provider === "model-hub"
        ? read("MODEL_HUB_MODEL") || read("OPENAI_MODEL", "gpt-5.6-sol")
        : read("OPENAI_MODEL", "gpt-5.6-sol"),
    baseURL:
      provider === "model-hub"
        ? hubURL
        : read("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    mode:
      protocol === "azure"
        ? "chat"
        : provider === "model-hub"
          ? read("MODEL_HUB_API_MODE") || read("OPENAI_API_MODE", "chat")
          : read("OPENAI_API_MODE", "responses"),
    effort:
      provider === "model-hub"
        ? read("MODEL_HUB_REASONING_EFFORT")
        : read("OPENAI_REASONING_EFFORT", "medium"),
    maxOutputTokens: Math.max(
      128,
      Math.min(
        8192,
        Math.floor(Number(read("BOBO_MAX_OUTPUT_TOKENS", "2048")) || 2048),
      ),
    ),
    codexPath: read("BOBO_CODEX_PATH"),
    traePath: read("BOBO_TRAE_PATH"),
    claudePath: read("BOBO_CLAUDE_PATH"),
    claudeModel: read("BOBO_CLAUDE_MODEL"),
    workspace: read("BOBO_WORKSPACE"),
    envPath,
  };
}
export function publicConfig(config = loadConfig()) {
  return {
    configured: Boolean(config.key) && !config.configurationIssue,
    provider: config.provider,
    configurationIssue: config.configurationIssue,
    model: config.model,
    mode: config.mode,
    envPath: config.envPath,
  };
}
export function redact(text) {
  let result = String(text ?? "");
  for (const key of loadConfig().redactionKeys)
    result = result.split(key).join("[已隐藏]");
  return result
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[已隐藏]")
    .slice(0, 16000);
}
