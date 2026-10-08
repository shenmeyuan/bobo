import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, publicConfig, redact } from "../electron/config.mjs";
import { Brain } from "../electron/brain.mjs";
import { Store } from "../electron/store.mjs";
import {
  createModelClient,
  modelRequestOptions,
} from "../electron/model-client.mjs";
function fixture(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-hub-"));
  const names = [
    "BOBO_ENV_PATH",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "MODEL_HUB_AK",
    "MODEL_HUB_BASE_URL",
    "MODEL_HUB_URL",
    "MODEL_HUB_MODEL",
    "MODEL_HUB_API_MODE",
    "OPENAI_API_MODE",
    "MODEL_HUB_PROTOCOL",
    "MODEL_HUB_API_VERSION",
    "MODEL_HUB_REASONING_EFFORT",
  ];
  const previous = Object.fromEntries(
    names.map((key) => [key, process.env[key]]),
  );
  names.forEach((key) => delete process.env[key]);
  process.env.BOBO_ENV_PATH = path.join(dir, ".env");
  fs.writeFileSync(process.env.BOBO_ENV_PATH, content);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
test("Model Hub uses its explicit endpoint and deployment name without exposing AK", (t) => {
  fixture(
    t,
    "MODEL_HUB_AK=hub-test-credential\nMODEL_HUB_BASE_URL=https://hub.example.test/v1\nMODEL_HUB_MODEL=my-gpt-deployment\nMODEL_HUB_API_MODE=chat\n",
  );
  const cfg = loadConfig();
  assert.equal(cfg.key, "hub-test-credential");
  assert.equal(cfg.baseURL, "https://hub.example.test/v1");
  assert.equal(cfg.model, "my-gpt-deployment");
  assert.equal(cfg.mode, "chat");
  assert.equal(publicConfig().configured, true);
  assert.equal(publicConfig().provider, "model-hub");
  assert.ok(!JSON.stringify(publicConfig()).includes(cfg.key));
  assert.equal(redact("oops hub-test-credential"), "oops [已隐藏]");
});
test("Azure gateway uses deployment path, api-key auth, API version and fresh trace IDs", async (t) => {
  fixture(
    t,
    "MODEL_HUB_AK=hub-test-credential\nMODEL_HUB_BASE_URL=https://hub.example.test/api/modelhub/online/v2/crawl/\nMODEL_HUB_PROTOCOL=azure\nMODEL_HUB_API_VERSION=2024-02-01\nMODEL_HUB_MODEL=gpt-5.6-sol\nOPENAI_API_MODE=responses\n",
  );
  // Also defend against the SDK's inherited baseURL default.
  process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
  const cfg = loadConfig();
  assert.equal(cfg.mode, "chat");
  assert.equal(cfg.model, "gpt-5.6-sol");
  assert.equal(cfg.effort, "");
  const traces = [];
  const client = createModelClient(cfg, {
    fetch: async (url, init) => {
      const endpoint = new URL(url);
      assert.equal(endpoint.origin, "https://hub.example.test");
      assert.equal(
        endpoint.pathname,
        "/api/modelhub/online/v2/crawl/openai/deployments/gpt-5.6-sol/chat/completions",
      );
      assert.equal(endpoint.searchParams.get("api-version"), "2024-02-01");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("api-key"), "hub-test-credential");
      assert.equal(headers.get("authorization"), null);
      traces.push(headers.get("X-TT-LOGID"));
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "2" } }],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  for (let i = 0; i < 2; i++)
    await client.chat.completions.create(
      {
        model: cfg.model,
        messages: [{ role: "user", content: "1+1" }],
        max_tokens: 500,
      },
      modelRequestOptions(cfg),
    );
  assert.ok(traces.every(Boolean));
  assert.notEqual(traces[0], traces[1]);
});
test("Model Hub AK never goes to the template OpenAI endpoint when its URL is missing", async (t) => {
  const dir = fixture(
    t,
    "MODEL_HUB_AK=hub-test-credential\nOPENAI_BASE_URL=https://api.openai.com/v1/\n",
  );
  assert.equal(loadConfig().baseURL, "");
  assert.equal(publicConfig().configured, false);
  const store = new Store(path.join(dir, "data"));
  const brain = new Brain(
    store,
    {
      list: () => [],
      dispatch: () => {
        throw new Error("must not dispatch");
      },
    },
    () => {
      throw new Error("must not call a provider");
    },
  );
  assert.match(await brain.chat("你好"), /MODEL_HUB_BASE_URL/);
  assert.equal(store.state.usage.brainCalls, 0);
});
test("OpenAI credentials take precedence and both secret values are redacted", (t) => {
  fixture(
    t,
    "OPENAI_API_KEY=openai-test-credential\nMODEL_HUB_AK=hub-test-credential\nOPENAI_MODEL=explicit-openai-model\nMODEL_HUB_MODEL=other-deployment\n",
  );
  assert.equal(loadConfig().provider, "openai");
  assert.equal(loadConfig().model, "explicit-openai-model");
  assert.equal(loadConfig().baseURL, "https://api.openai.com/v1");
  assert.equal(
    redact("openai-test-credential hub-test-credential"),
    "[已隐藏] [已隐藏]",
  );
});
