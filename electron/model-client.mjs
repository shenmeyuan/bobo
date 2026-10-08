import OpenAI, { AzureOpenAI } from "openai";
import { randomUUID } from "node:crypto";

export function createModelClient(cfg, overrides = {}) {
  const options = {
    apiKey: cfg.key,
    timeout: 90_000,
    maxRetries: 0,
    ...overrides,
  };
  if (cfg.protocol === "azure") {
    // Explicit baseURL avoids an unrelated OPENAI_BASE_URL inherited by the SDK.
    return new AzureOpenAI({
      ...options,
      baseURL: `${cfg.baseURL.replace(/\/+$/, "")}/openai`,
      apiVersion: cfg.apiVersion,
    });
  }
  return new OpenAI({ ...options, baseURL: cfg.baseURL });
}

export function modelRequestOptions(cfg) {
  return cfg.provider === "model-hub"
    ? { headers: { "X-TT-LOGID": randomUUID().replaceAll("-", "") } }
    : {};
}
