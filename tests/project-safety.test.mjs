import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Store, createState } from "../electron/store.mjs";
import { Brain, executeTool } from "../electron/brain.mjs";
import { AgentManager } from "../electron/agents.mjs";
import { Supervisor } from "../electron/supervisor.mjs";
import { policy, automaticAgentAllowed } from "../electron/fallback-policy.mjs";
import {
  assertConversationScope,
  assertRequestContext,
  conversationContext,
} from "../electron/conversation-scope.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-project-safety-"));
  const previous = process.env.BOBO_ENV_PATH,
    previousWorkspace = process.env.BOBO_WORKSPACE;
  process.env.BOBO_ENV_PATH = path.join(dir, ".env");
  delete process.env.BOBO_WORKSPACE;
  const envFile = process.env.BOBO_ENV_PATH;
  fs.writeFileSync(
    envFile,
    `OPENAI_API_KEY=sk-fake-scope-only\nBOBO_CODEX_PATH=${process.execPath}\nBOBO_CLAUDE_PATH=${process.execPath}\nBOBO_TRAE_PATH=${process.execPath}\n`,
  );
  const a = path.join(dir, "worktree-A"),
    b = path.join(dir, "worktree-B");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const store = new Store(path.join(dir, "data"));
  store.state.settings.workspace = a;
  store.newConversation();
  let now = Date.now();
  const children = [];
  const manager = new AgentManager(
    store,
    () => {},
    () => {
      const child = new EventEmitter();
      Object.assign(child, {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill() {},
      });
      child.stdin.resume();
      children.push(child);
      return child;
    },
  );
  manager.supervisor = new Supervisor(manager, {
    now: () => now,
    retryDelayMs: 1,
  });
  manager.supervisor.start({ interval: false });
  t.after(() => {
    manager.stopAll();
    for (const c of children) c.emit("close", 1);
    if (previous === undefined) delete process.env.BOBO_ENV_PATH;
    else process.env.BOBO_ENV_PATH = previous;
    if (previousWorkspace === undefined) delete process.env.BOBO_WORKSPACE;
    else process.env.BOBO_WORKSPACE = previousWorkspace;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    envFile,
    a,
    b,
    store,
    manager,
    children,
    advance() {
      now += 2;
      manager.supervisor.tick();
    },
    fail(index, message) {
      children[index].stdout.write(
        JSON.stringify({ type: "turn.failed", error: { message } }) + "\n",
      );
      children[index].emit("close", 1);
    },
  };
}

test("legacy fallback lists and cross-tool queues migrate once without authorizing other executors", (t) => {
  const f = fixture(t),
    legacy = createState();
  delete legacy.settings.fallbackPolicy;
  legacy.settings.fallbackAgents = ["codex", "claude", "trae"];
  legacy.tasks = [
    {
      id: "legacy-root",
      agent: "codex",
      status: "running",
      supervision: {
        enabled: true,
        allowedAgents: ["codex", "claude"],
        pending: { target: "claude", taskId: "legacy-root", at: 1 },
        events: [],
      },
    },
  ];
  const data = path.join(f.dir, "legacy");
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, "state.json"), JSON.stringify(legacy));
  const migrated = new Store(data);
  assert.deepEqual(migrated.state.settings.fallbackAgents, []);
  assert.deepEqual(migrated.state.settings.fallbackMigration.previousAgents, [
    "codex",
    "claude",
    "trae",
  ]);
  const root = migrated.state.tasks[0];
  assert.deepEqual(root.supervision.allowedAgents, ["codex"]);
  assert.equal(root.supervision.pending, null);
  assert.equal(automaticAgentAllowed(root, "claude"), false);
  root.supervision.allowedAgents.push("claude");
  assert.equal(automaticAgentAllowed(root, "claude"), false); // A version marker alone is not consent.
  assert.equal(root.status, "interrupted"); // Existing restart behavior; no process is started or killed.
  migrated.save();
  const migration = JSON.stringify(migrated.state.settings.fallbackMigration);
  const restarted = new Store(data);
  assert.equal(
    JSON.stringify(restarted.state.settings.fallbackMigration),
    migration,
  );
  assert.equal(restarted.state.tasks.length, 1);
});

test("new fallback defaults are empty and explicit future-task and chain grants survive restart", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.store.state.settings.fallbackAgents, []);
  const first = f.manager.dispatch("codex", "one", "check");
  assert.deepEqual(f.manager.task(first.id).supervision.allowedAgents, [
    "codex",
  ]);
  f.fail(0, "429 quota exceeded");
  f.advance();
  assert.equal(f.children.length, 1);
  Object.assign(f.store.state.settings, {
    fallbackAgents: ["claude"],
    fallbackPolicy: policy("user_ui"),
  });
  const next = f.manager.dispatch("codex", "two", "check");
  assert.deepEqual(f.manager.task(next.id).supervision.allowedAgents, [
    "codex",
    "claude",
  ]);
  assert.deepEqual(f.manager.task(first.id).supervision.allowedAgents, [
    "codex",
  ]);
  const restarted = new Store(path.dirname(f.store.file));
  assert.deepEqual(restarted.state.settings.fallbackAgents, ["claude"]);
  assert.equal(
    automaticAgentAllowed(
      restarted.state.tasks.find((r) => r.id === next.id),
      "claude",
    ),
    true,
  );
});

test("model cannot expand policies or resume across tools; revoking a queued target prevents execution", (t) => {
  const f = fixture(t),
    first = f.manager.dispatch("codex", "check", "check");
  assert.throws(
    () =>
      executeTool(f.store, f.manager, "configure_task_supervision", {
        task_id: first.id,
        enabled: true,
        allowed_agents: ["codex", "claude"],
        source: "user_ui",
      }),
    { code: "CROSS_AGENT_CONSENT_REQUIRED" },
  );
  f.fail(0, "429 quota exceeded");
  assert.throws(
    () =>
      executeTool(f.store, f.manager, "resume_task", {
        task_id: first.id,
        agent: "claude",
        note: "continue",
        source: "user_ui",
      }),
    { code: "CROSS_AGENT_CONSENT_REQUIRED" },
  );
  f.manager.supervisor.configure(first.id, true, ["codex", "claude"], {
    source: "user_ui",
  });
  const root = f.manager.task(first.id);
  assert.equal(root.supervision.pending.target, "claude");
  // Simulate the authorization changing after enqueue; tick must recheck it.
  root.supervision.allowedAgents = ["codex"];
  f.advance();
  assert.equal(f.children.length, 1);
  assert.equal(root.supervision.pending, null);
  assert.match(root.supervision.reason, /授权已改变/);
});

test("a single manual cross-tool continuation does not grant future automatic retries", (t) => {
  const f = fixture(t),
    first = f.manager.dispatch("codex", "check", "check");
  f.fail(0, "unknown failure");
  const next = f.manager.resume(first.id, "claude", "continue once", {
    source: "user_ui",
  });
  assert.equal(next.status, "running");
  assert.deepEqual(f.manager.task(first.id).supervision.allowedAgents, [
    "codex",
  ]);
  f.children[1].stderr.write("ECONNRESET");
  f.children[1].emit("close", 1);
  f.advance();
  assert.equal(f.children.length, 2);
  assert.equal(f.manager.task(first.id).supervision.state, "attention");
});

for (const blocked of ["configure_task_supervision", "resume_task"]) {
  test(`denied ${blocked} ends the model tool phase before a later fresh dispatch`, async (t) => {
    const f = fixture(t),
      first = f.manager.dispatch("codex", "check", "check");
    f.fail(0, "unknown failure");
    let requests = 0;
    const args =
      blocked === "resume_task"
        ? { task_id: first.id, agent: "claude", note: "" }
        : {
            task_id: first.id,
            enabled: true,
            allowed_agents: ["codex", "claude"],
          };
    const brain = new Brain(f.store, f.manager, () => ({
      responses: {
        create: async () => {
          requests++;
          return {
            output: [
              {
                type: "function_call",
                call_id: "denied",
                name: blocked,
                arguments: JSON.stringify(args),
              },
              {
                type: "function_call",
                call_id: "bypass",
                name: "dispatch_task",
                arguments: JSON.stringify({
                  agent: "claude",
                  title: "bypass",
                  prompt: "continue",
                }),
              },
            ],
          };
        },
      },
    }));
    assert.match(await brain.chat("continue"), /照看规则/);
    assert.equal(requests, 1);
    assert.equal(f.children.length, 1);
    assert.equal(f.store.state.tasks.length, 1);
  });
}

test("legacy mixed messages remain read-only and unassigned to the current project", async (t) => {
  const f = fixture(t),
    legacy = createState();
  legacy.settings.workspace = f.a;
  legacy.messages = [
    { id: "mixed", role: "user", content: "A and B mixed history", at: 1 },
  ];
  legacy.tasks = [
    { id: "a", workspace: f.a, status: "completed" },
    { id: "b", workspace: f.b, status: "completed" },
  ];
  const data = path.join(f.dir, "legacy-chat");
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, "state.json"), JSON.stringify(legacy));
  const store = new Store(data),
    id = store.state.activeConversationId;
  assert.equal(store.state.conversations[0].scope.kind, "legacy");
  let calls = 0;
  const brain = new Brain(store, {}, () => {
    calls++;
    throw new Error("must not create client");
  });
  await assert.rejects(() => brain.chat("continue"), /仅供查看/);
  assert.equal(store.state.messages.length, 1);
  assert.equal(calls, 0);
  store.alignConversation();
  assert.deepEqual(store.state.messages, []);
  store.selectConversation(id);
  assert.equal(store.state.messages[0].content, "A and B mixed history");
  assert.equal(conversationContext(store.state).canSend, false);
});

test("canonical worktree conversations isolate history; selecting history never changes the workspace", async (t) => {
  const f = fixture(t),
    aId = f.store.state.activeConversationId;
  f.store.message("user", "A-only request");
  f.store.state.settings.workspace = f.b;
  f.store.alignConversation();
  const bId = f.store.state.activeConversationId;
  assert.notEqual(aId, bId);
  assert.deepEqual(f.store.state.messages, []);
  f.store.message("user", "B-only request");
  f.store.selectConversation(aId);
  assert.equal(f.store.state.settings.workspace, f.b);
  assert.throws(
    () => f.manager.dispatch("codex", "wrong", "wrong"),
    /仅供查看/,
  );
  const brain = new Brain(f.store, f.manager, () => {
    throw new Error("must not call");
  });
  await assert.rejects(() => brain.chat("wrong"), /仅供查看/);
  assert.deepEqual(
    f.store.state.messages.map((m) => m.content),
    ["A-only request"],
  );
  f.store.state.settings.workspace = f.a;
  f.store.alignConversation();
  assert.equal(f.store.state.activeConversationId, aId);
  const link = path.join(f.dir, "current");
  fs.symlinkSync(f.a, link);
  f.store.state.settings.workspace = link;
  assert.equal(
    assertConversationScope(f.store.state).path,
    fs.realpathSync(f.a),
  );
  fs.unlinkSync(link);
  fs.symlinkSync(f.b, link);
  assert.throws(() => assertConversationScope(f.store.state), /仅供查看/);
  fs.unlinkSync(link);
  assert.throws(() => f.store.newConversation(), /无法访问/);
});

test("general scope stays separate from env-selected projects and invalid paths fail closed", (t) => {
  const f = fixture(t);
  f.store.state.settings.workspace = "";
  const id = f.store.newConversation();
  assert.equal(assertConversationScope(f.store.state).kind, "general");
  fs.appendFileSync(f.envFile, `BOBO_WORKSPACE=${f.a}\n`);
  assert.throws(() => assertConversationScope(f.store.state), /仅供查看/);
  f.store.alignConversation();
  assert.notEqual(f.store.state.activeConversationId, id);
  assert.equal(
    f.store.state.conversations.find((c) => c.id === id).scope.kind,
    "general",
  );
  fs.appendFileSync(
    f.envFile,
    `BOBO_WORKSPACE=${path.join(f.dir, "missing")}\n`,
  );
  assert.throws(() => f.store.alignConversation(), /无法访问/);
});

test("stale renderer conversation, scope and permission snapshots reject before model or dispatch", async (t) => {
  const f = fixture(t);
  const context = {
    conversationId: f.store.state.activeConversationId,
    scope: assertConversationScope(f.store.state),
    allowEdits: false,
  };
  let modelCalls = 0;
  const brain = new Brain(f.store, f.manager, () => {
    modelCalls++;
    throw new Error("must not create client");
  });
  f.store.state.settings.workspace = f.b;
  await assert.rejects(() => brain.chat("stale A input", context), /已改变/);
  assert.throws(() => assertRequestContext(f.store.state, context), /已改变/);
  f.store.alignConversation();
  await assert.rejects(() => brain.chat("stale A input", context), /已改变/);
  assert.equal(f.store.state.messages.length, 0);
  f.store.state.settings.workspace = f.a;
  f.store.alignConversation();
  f.store.state.settings.allowEdits = true;
  assert.throws(
    () => assertRequestContext(f.store.state, context),
    /权限已改变/,
  );
  assert.throws(() => assertRequestContext(f.store.state, undefined), /已改变/);
  assert.equal(modelCalls, 0);
  assert.equal(f.children.length, 0);
});

for (const withTool of [false, true]) {
  test(`an in-flight A response is written only to A after switching to B (tool=${withTool})`, async (t) => {
    const f = fixture(t),
      aId = f.store.state.activeConversationId;
    let resolve, ready;
    const pending = new Promise((r) => {
      resolve = r;
    });
    const received = new Promise((r) => {
      ready = r;
    });
    const brain = new Brain(f.store, f.manager, () => ({
      responses: {
        create: () => {
          ready();
          return pending;
        },
      },
    }));
    const chat = brain.chat("A request");
    await received;
    f.store.state.settings.workspace = f.b;
    f.store.alignConversation();
    const bId = f.store.state.activeConversationId;
    resolve(
      withTool
        ? {
            output: [
              {
                type: "function_call",
                call_id: "late",
                name: "dispatch_task",
                arguments: JSON.stringify({
                  agent: "codex",
                  title: "late",
                  prompt: "A work",
                }),
              },
            ],
          }
        : { output: [], output_text: "A answer" },
    );
    await chat;
    assert.equal(f.store.state.activeConversationId, bId);
    assert.deepEqual(f.store.state.messages, []);
    assert.equal(f.children.length, 0);
    const aMessages = f.store.state.conversations.find(
      (c) => c.id === aId,
    ).messages;
    assert.equal(aMessages[0].content, "A request");
    assert.match(
      aMessages.at(-1).content,
      withTool ? /项目或权限已改变/ : /A answer/,
    );
  });
}

test("model task tools, observed sessions and work diary cannot expose another project", async (t) => {
  const f = fixture(t);
  f.store.state.tasks = [
    { id: "a", workspace: f.a, status: "completed", result: "A report" },
    {
      id: "b",
      workspace: f.b,
      status: "completed",
      result: "B-PRIVATE-REPORT",
    },
  ];
  f.store.state.observer = {
    sessions: [
      { id: "sa", workspace: f.a },
      { id: "sb", workspace: f.b },
    ],
  };
  f.store.state.diary.unshift({
    kind: "work",
    title: "B-PRIVATE-WORK",
    text: "B private title",
  });
  assert.deepEqual(
    executeTool(f.store, f.manager, "get_tasks", {}).map((r) => r.id),
    ["a"],
  );
  assert.deepEqual(
    executeTool(f.store, f.manager, "get_observed_sessions", {}).sessions.map(
      (r) => r.id,
    ),
    ["sa"],
  );
  for (const name of [
    "read_task_result",
    "get_task_workflow",
    "record_task_correction",
    "resume_task",
    "verify_task",
    "configure_task_supervision",
    "stop_task",
  ])
    assert.throws(
      () => executeTool(f.store, f.manager, name, { task_id: "b", offset: 0 }),
      /不属于当前项目/,
    );
  const brain = new Brain(f.store, f.manager, () => ({
    responses: {
      create: async (request) => {
        assert.ok(!request.instructions.includes("B-PRIVATE-WORK"));
        return { output: [], output_text: "ok" };
      },
    },
  }));
  assert.equal(await brain.chat("check A"), "ok");
});
