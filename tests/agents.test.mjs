import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Store } from "../electron/store.mjs";
import { AgentManager, parseAgentEvent } from "../electron/agents.mjs";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-agent-"));
  const previous = process.env.BOBO_ENV_PATH;
  process.env.BOBO_ENV_PATH = path.join(dir, ".env");
  fs.writeFileSync(
    process.env.BOBO_ENV_PATH,
    `OPENAI_API_KEY=sk-test-secret-scheduler\nBOBO_CODEX_PATH=${process.execPath}\nBOBO_CLAUDE_PATH=${process.execPath}\n`,
  );
  t.after(() => {
    manager.stopAll();
    if (previous === undefined) delete process.env.BOBO_ENV_PATH;
    else process.env.BOBO_ENV_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new Store(path.join(dir, "data"));
  store.state.settings.workspace = dir;
  let child,
    options,
    args,
    input = "";
  const manager = new AgentManager(
    store,
    () => {},
    (_binary, argv, opts) => {
      args = argv;
      options = opts;
      child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        child.killed = true;
      };
      child.stdin.on("data", (data) => {
        input += data;
      });
      return child;
    },
  );
  return {
    store,
    manager,
    get child() {
      return child;
    },
    get options() {
      return options;
    },
    get args() {
      return args;
    },
    get input() {
      return input;
    },
  };
}
test("fresh exhausted shared quota blocks dispatch; model-specific and manual quotas do not", t => {
  const f = fixture(t), future = new Date(Date.now() + 60000).toISOString();
  f.store.state.quotas.codex = {source:"codex-app-server", status:"fresh", updatedAt:Date.now(), windows:[{limitId:"codex",label:"codex",remainingPercent:0,resetAt:future}]};
  assert.throws(() => f.manager.dispatch("codex","额度检查","做一件事"), /额度窗口已耗尽/);
  assert.equal(f.child, undefined);
  f.store.state.quotas.codex.windows[0].limitId = "unrelated-model";
  const task = f.manager.dispatch("codex","模型额度","做一件事");
  assert.ok(task.id);
  f.child.emit("close", 1);
  f.store.state.quotas.codex.source = "manual";
  f.store.state.quotas.codex.status = "manual";
  f.store.state.quotas.codex.windows[0].limitId = "codex";
  assert.ok(f.manager.dispatch("codex","手动信息","做一件事").id);
  f.child.emit("close", 1);
});
test("dispatch uses argv and stdin, strips scheduler credentials, and waits for a real result", (t) => {
  const previousHubKey = process.env.MODEL_HUB_AK;
  process.env.MODEL_HUB_AK = "scheduler-hub-secret";
  t.after(() => {
    if (previousHubKey === undefined) delete process.env.MODEL_HUB_AK;
    else process.env.MODEL_HUB_AK = previousHubKey;
  });
  const f = fixture(t),
    prompt = "literal $(touch /tmp/should-not-run) `echo x`";
  const { id } = f.manager.dispatch("codex", "任务", prompt);
  assert.equal(f.options.shell, false);
  assert.equal(
    f.options.cwd,
    fs.realpathSync(f.store.state.settings.workspace),
  );
  assert.equal(f.options.env.OPENAI_API_KEY, undefined);
  assert.equal(f.options.env.MODEL_HUB_AK, undefined);
  assert.equal(f.input, prompt);
  assert.ok(!f.args.includes(prompt));
  assert.ok(f.args.includes("read-only"));
  const events = [
    { type: "thread.started", thread_id: "session" },
    { type: "item.completed", item: { type: "agent_message", text: "done" } },
    { type: "turn.completed", usage: { input_tokens: 20, output_tokens: 10 } },
  ];
  const lines = events.map((e) => JSON.stringify(e)).join("\n");
  f.child.stdout.write(lines.slice(0, 25));
  f.child.stdout.write(lines.slice(25));
  f.child.emit("close", 0);
  const task = f.store.state.tasks.find((t) => t.id === id);
  assert.equal(task.status, "completed");
  assert.equal(task.result, "done");
  assert.deepEqual(task.usage, { input: 20, output: 10 });
  assert.equal(f.manager.running.size, 0);
});
test("exit code zero with no result is a failure; API error text is redacted", (t) => {
  const f = fixture(t);
  f.manager.dispatch("codex", "任务", "hello");
  f.child.stderr.write("failed sk-test-secret-scheduler");
  f.child.emit("close", 0);
  assert.equal(f.store.state.tasks[0].status, "failed");
  assert.ok(!f.store.state.tasks[0].error.includes("sk-test-secret-scheduler"));
});
test("cancellation remains cancelled even when a process later reports success", (t) => {
  const f = fixture(t);
  const { id } = f.manager.dispatch("claude", "任务", "hello");
  f.manager.cancel(id);
  f.child.emit("close", 0);
  assert.equal(f.store.state.tasks[0].status, "cancelled");
  assert.equal(f.child.killed, true);
});
test("permission denials become attention, rather than false completion", (t) => {
  const f = fixture(t);
  f.manager.dispatch("claude", "任务", "hello");
  f.child.stdout.write(
    JSON.stringify({
      type: "result",
      result: "read done; edit denied",
      permission_denials: [{ tool_name: "Edit" }],
      usage: { input_tokens: 4, output_tokens: 5 },
    }),
  );
  f.child.emit("close", 0);
  assert.equal(f.store.state.tasks[0].status, "attention");
});
test("Doubao is only a handoff and never starts a fake subprocess", (t) => {
  const f = fixture(t);
  const task = f.manager.dispatch("doubao", "灵感", "帮我想名字");
  assert.equal(task.status, "handoff");
  assert.equal(f.child, undefined);
});
test("Codex turn errors and Claude result errors are detected", () => {
  assert.equal(
    parseAgentEvent("codex", {
      type: "turn.failed",
      error: { message: "denied" },
    }).error,
    "denied",
  );
  assert.equal(
    parseAgentEvent("claude", {
      type: "result",
      is_error: true,
      result: "bad auth",
    }).error,
    "bad auth",
  );
});
test("Claude input usage includes cache reads and cache creation", () => {
  const event = parseAgentEvent("claude", {
    type: "result",
    result: "done",
    usage: {
      input_tokens: 3,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
      output_tokens: 4,
    },
  });
  assert.equal(event.usage.input, 123);
});
test("missing usage stays unknown rather than becoming zero", () => {
  assert.equal(
    parseAgentEvent("codex", { type: "turn.completed" }).usage,
    null,
  );
  assert.equal(
    parseAgentEvent("claude", { type: "result", result: "done" }).usage,
    null,
  );
});
test("typed streaming permission denial stops execution before a final report", (t) => {
  const f = fixture(t);
  f.store.state.settings.superviseTasks = true;
  f.manager.supervisor.start({ interval: false });
  f.manager.dispatch("claude", "编辑", "更新文件");
  f.child.stdout.write(
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "edit-1",
            is_error: true,
            content: "Permission denied to execute this tool",
          },
        ],
      },
    }) + "\n",
  );
  assert.equal(f.child.killed, true);
  assert.equal(f.store.state.tasks[0].status, "attention");
  assert.equal(f.store.state.tasks[0].supervision.pending, null);
  f.child.emit("close", 0);
  assert.equal(f.store.state.tasks.length, 1);
});
test("permission wording in assistant prose is not a tool rejection", () => {
  assert.equal(
    parseAgentEvent("trae", {
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "The README quotes Permission denied to execute this tool",
          },
        ],
      },
    }).needsAttention,
    undefined,
  );
});
test("Coco typed output permission errors are recognized, ordinary tool failures are not", () => {
  const event = {
    type: "user",
    content: {
      tool_call_output: {
        tool_call_id: "t",
        tool_info: { name: "ApplyPatch" },
        output: {
          is_error: true,
          content: [
            { type: "text", text: "Permission denied to execute this tool" },
          ],
        },
      },
    },
  };
  assert.equal(parseAgentEvent("trae", event).permissionDenied, true);
  event.content.tool_call_output.output.content[0].text = "File does not exist";
  assert.equal(parseAgentEvent("trae", event).permissionDenied, undefined);
});
test("Trae allows its GPT patch tool only with editing enabled and denies delegation", async () => {
  const { taskCommand } = await import("../electron/agents.mjs");
  const cfg = { traePath: process.execPath };
  const writable = taskCommand("trae", cfg, true),
    readonly = taskCommand("trae", cfg, false);
  assert.ok(
    writable.args[writable.args.indexOf("--allowed-tool") + 1]
      .split(",")
      .includes("ApplyPatch"),
  );
  const denied =
    readonly.args[readonly.args.indexOf("--disallowed-tool") + 1].split(",");
  assert.ok(denied.includes("ApplyPatch"));
  assert.ok(denied.includes("Agent"));
  assert.ok(
    writable.args[writable.args.indexOf("--disallowed-tool") + 1]
      .split(",")
      .includes("Agent"),
  );
});
test("actual Coco top-level tool-result event triggers permission attention", () => {
  const event = {
    type: "user",
    subtype: "tool_result",
    session_id: "s",
    tool_use_id: "patch-1",
    tool_name: "ApplyPatch",
    is_error: true,
    content: "Permission denied to execute this tool",
  };
  assert.equal(parseAgentEvent("trae", event).permissionDenied, true);
  assert.equal(
    parseAgentEvent("trae", { ...event, is_error: false }).permissionDenied,
    undefined,
  );
});
test("actual Coco wrapped-content denial stops; quoted successful reads do not", () => {
  const content = {
    content: [{ type: "text", text: "Permission denied to execute this tool" }],
    structured_content: null,
    is_error: true,
  };
  const event = {
    type: "user",
    subtype: "tool_result",
    tool_name: "ApplyPatch",
    tool_use_id: "patch-1",
    is_error: true,
    content,
  };
  assert.equal(parseAgentEvent("trae", event).permissionDenied, true);
  assert.equal(
    parseAgentEvent("trae", {
      ...event,
      tool_name: "Read",
      is_error: false,
      content: { ...content, is_error: false },
    }).permissionDenied,
    undefined,
  );
});
