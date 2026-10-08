import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../electron/store.mjs";
import { Brain, executeTool } from "../electron/brain.mjs";
import { publicConfig, loadConfig } from "../electron/config.mjs";
import { boundedHistory, PERSONA_VERSION } from "../electron/persona.mjs";
function fixture(t, key = "sk-not-a-real-key") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-brain-")),
    prev = process.env.BOBO_ENV_PATH,
    prevKey = process.env.OPENAI_API_KEY;
  process.env.BOBO_ENV_PATH = path.join(dir, ".env");
  delete process.env.OPENAI_API_KEY;
  fs.writeFileSync(
    process.env.BOBO_ENV_PATH,
    `OPENAI_API_KEY=${key}\nOPENAI_MODEL=gpt-5.6-sol\n`,
  );
  t.after(() => {
    if (prev === undefined) delete process.env.BOBO_ENV_PATH;
    else process.env.BOBO_ENV_PATH = prev;
    if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new Store(path.join(dir, "data"));
  let count = 0;
  const agents = {
    list: () => [{ id: "codex", installed: true }],
    dispatch: () => {
      count++;
      return { id: "job", status: "running" };
    },
  };
  return {
    store,
    agents,
    get dispatches() {
      return count;
    },
  };
}
test("Responses tool loop returns actual action results and tracks real API usage", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const brain = new Brain(f.store, f.agents, () => ({
    responses: {
      create: async (request) => {
        calls++;
        assert.equal(request.model, "gpt-5.6-sol");
        assert.equal(request.store, false);
        if (calls === 1)
          return {
            output: [
              {
                type: "function_call",
                call_id: "one",
                name: "dispatch_task",
                arguments: JSON.stringify({
                  agent: "codex",
                  title: "检查说明",
                  prompt: "检查 README",
                }),
              },
            ],
            usage: { input_tokens: 12, output_tokens: 3 },
          };
        assert.ok(
          request.input.some(
            (i) =>
              i.type === "function_call_output" &&
              JSON.parse(i.output).id === "job",
          ),
        );
        return {
          output: [],
          output_text: "已经交给 Codex 了。",
          usage: { input_tokens: 13, output_tokens: 4 },
        };
      },
    },
  }));
  assert.equal(
    await brain.chat("交给 Codex 检查 README"),
    "已经交给 Codex 了。",
  );
  assert.equal(f.dispatches, 1);
  assert.deepEqual(f.store.state.usage, {
    brainInput: 25,
    brainOutput: 7,
    brainCalls: 2,
  });
  assert.equal(brain.busy, false);
});
test("missing key is an explicit offline response and never calls a model", async (t) => {
  const f = fixture(t, "");
  const brain = new Brain(f.store, f.agents, () => {
    throw new Error("must not call");
  });
  assert.match(await brain.chat("hello"), /OPENAI_API_KEY/);
  assert.equal(f.dispatches, 0);
});
test("API errors preserve the conversation and redact credentials", async (t) => {
  const f = fixture(t);
  const brain = new Brain(f.store, f.agents, () => ({
    responses: {
      create: async () => {
        throw new Error("endpoint failed sk-not-a-real-key");
      },
    },
  }));
  const answer = await brain.chat("hello");
  assert.ok(!answer.includes("sk-not-a-real-key"));
  assert.equal(f.store.state.messages.length, 2);
  assert.equal(brain.busy, false);
});
test("tool boundary rejects arbitrary commands and private config excludes keys", (t) => {
  const f = fixture(t);
  assert.throws(() =>
    executeTool(f.store, f.agents, "shell", { command: "rm" }),
  );
  assert.ok(!JSON.stringify(publicConfig()).includes("sk-not-a-real-key"));
  fs.writeFileSync(
    process.env.BOBO_ENV_PATH,
    "OPENAI_MODEL=my-exact-deployment\n",
  );
  assert.equal(loadConfig().model, "my-exact-deployment");
});
test("repeated identical dispatch calls create one task, even with different call IDs", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const args = JSON.stringify({
    agent: "codex",
    title: "一件事",
    prompt: "检查 README",
  });
  const brain = new Brain(f.store, f.agents, () => ({
    responses: {
      create: async () =>
        ++calls < 3
          ? {
              output: [
                {
                  type: "function_call",
                  call_id: `call-${calls}`,
                  name: "dispatch_task",
                  arguments: args,
                },
              ],
            }
          : { output: [], output_text: "已经派发。" },
    },
  }));
  await brain.chat("交给 Codex 检查 README");
  assert.equal(f.dispatches, 1);
});
test("concurrent messages cannot mix two tool loops", async (t) => {
  const f = fixture(t);
  let resolveRequest;
  const pending = new Promise((resolve) => {
    resolveRequest = resolve;
  });
  const brain = new Brain(f.store, f.agents, () => ({
    responses: { create: () => pending },
  }));
  const first = brain.chat("hello");
  await assert.rejects(() => brain.chat("another"), /上一句话/);
  resolveRequest({ output: [], output_text: "hello" });
  await first;
  assert.equal(brain.busy, false);
});
test("Chat tool loop reads result on demand, preserves tool IDs and caps output", async (t) => {
  const f = fixture(t);
  fs.appendFileSync(process.env.BOBO_ENV_PATH, "OPENAI_API_MODE=chat\n");
  f.store.state.tasks.push({
    id: "result-task",
    status: "completed",
    result: "a".repeat(4500),
    agent: "codex",
    title: "检查",
  });
  let requests = 0;
  const brain = new Brain(f.store, f.agents, () => ({
    chat: {
      completions: {
        create: async (request) => {
          requests++;
          assert.equal(request.max_tokens, 2048);
          assert.ok(request.messages[0].content.includes(PERSONA_VERSION));
          if (requests === 1) {
            assert.ok(
              !JSON.stringify(request.messages).includes("a".repeat(100)),
            );
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "read-1",
                        type: "function",
                        function: {
                          name: "read_task_result",
                          arguments: JSON.stringify({
                            task_id: "result-task",
                            offset: 0,
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 20, completion_tokens: 4 },
            };
          }
          const tool = request.messages.find((m) => m.role === "tool");
          assert.equal(tool.tool_call_id, "read-1");
          const value = JSON.parse(tool.content);
          assert.equal(value.result.length, 4000);
          assert.equal(value.next_offset, 4000);
          assert.equal(value.verification, "not_independently_verified");
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "任务已返回结果，尚未独立验收。",
                },
              },
            ],
            usage: { prompt_tokens: 30, completion_tokens: 5 },
          };
        },
      },
    },
  }));
  assert.match(await brain.chat("解释刚才任务的结果"), /尚未独立验收/);
  assert.equal(f.store.state.usage.brainCalls, 2);
  assert.deepEqual(f.store.state.coordinationUsage[0].rootIds, ["result-task"]);
  assert.equal(f.store.state.coordinationUsage[0].input, 50);
  assert.equal(f.store.state.coordinationUsage[0].output, 9);
  const tail = executeTool(f.store, f.agents, "read_task_result", {
    task_id: "result-task",
    offset: 4000,
  });
  assert.equal(tail.result.length, 500);
  assert.equal(tail.next_offset, null);
  assert.throws(() =>
    executeTool(f.store, f.agents, "read_task_result", {
      task_id: "result-task",
      offset: -1,
    }),
  );
  assert.throws(() =>
    executeTool(f.store, f.agents, "read_task_result", {
      task_id: "missing",
      offset: 0,
    }),
  );
});
test("history bounds whole messages, preserves latest request, reports forgotten context", () => {
  const history = [
    { role: "user", content: "old".repeat(5000) },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "new".repeat(2000) },
  ];
  const packed = boundedHistory(history);
  assert.deepEqual(packed.messages, [history[2]]);
  assert.equal(packed.omitted, 2);
});
