import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../electron/store.mjs";
import { Brain, executeTool } from "../electron/brain.mjs";
import {
  projectScope,
  saveProjectMemory,
  revokeProjectMemory,
  retrieveProjectMemory,
  listProjectMemories,
  ensureWorkMemory,
} from "../electron/work-memory.mjs";
import {
  estimateTokens,
  fitContext,
  packChatHistory,
} from "../electron/context-budget.mjs";
import {
  validateContract,
  runVerification,
  verificationFreshness,
} from "../electron/workflow.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-work-memory-"));
  const work = path.join(dir, "project"),
    other = path.join(dir, "other");
  fs.mkdirSync(work);
  fs.mkdirSync(other);
  const store = new Store(path.join(dir, "data"));
  store.state.settings.workspace = work;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, work, other, store };
}
const userSource = { kind: "user_ui" };

test("project memory deduplicates, isolates projects, and persists explicit revocation", (t) => {
  const f = fixture(t);
  const m = saveProjectMemory(f.store, f.work, {
    text: "金额采用整数分",
    source: userSource,
  });
  assert.equal(
    saveProjectMemory(f.store, f.work, { text: m.text, source: userSource }).id,
    m.id,
  );
  assert.equal(listProjectMemories(f.store, f.other).length, 0);
  assert.throws(() => revokeProjectMemory(f.store, f.other, m.id), /不属于/);
  assert.throws(
    () =>
      saveProjectMemory(f.store, f.work, {
        text: "报告声称全部成功",
        source: { kind: "agent_report" },
      }),
    /来源/,
  );
  revokeProjectMemory(f.store, f.work, m.id);
  const restarted = new Store(path.dirname(f.store.file));
  const recalled = retrieveProjectMemory(restarted, f.work, "新需求")
    .entries[0];
  assert.equal(recalled.status, "revoked");
  assert.equal(recalled.revision, 2);
  assert.equal(recalled.text, m.text);
  assert.equal(
    listProjectMemories(restarted, f.work)[0].history[0].status,
    "active",
  );
});

test("Git worktrees share confirmed project guidance but retain distinct worktree identities", (t) => {
  const f = fixture(t);
  const beforeInit = projectScope(f.work);
  saveProjectMemory(f.store, f.work, {
    text: "先保存，再初始化仓库",
    source: userSource,
  });
  const git = (args) =>
    execFileSync("git", args, { cwd: f.work, stdio: "ignore" });
  git(["init"]);
  git([
    "-c",
    "user.name=Bobo Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  const worktree = path.join(f.dir, "linked");
  git(["worktree", "add", "--detach", worktree]);
  const a = projectScope(f.work),
    b = projectScope(worktree);
  assert.equal(a.repository, beforeInit.repository);
  assert.equal(a.repository, b.repository);
  assert.notEqual(a.worktree, b.worktree);
  saveProjectMemory(f.store, f.work, {
    text: "这个仓库使用 pnpm",
    source: userSource,
  });
  assert.equal(
    retrieveProjectMemory(f.store, worktree, "安装依赖").entries.length,
    2,
  );
});

test("bounded retrieval drops optional references and never silently truncates confirmed rules", (t) => {
  const f = fixture(t);
  const rule = saveProjectMemory(f.store, f.work, {
    text: "精确要求".repeat(300),
    source: userSource,
  });
  saveProjectMemory(f.store, f.work, {
    text: "参考 SQL 文档 abc.md",
    kind: "reference",
    source: userSource,
  });
  const packet = retrieveProjectMemory(f.store, f.work, "SQL", 20);
  assert.equal(packet.overBudget, true);
  assert.equal(packet.entries.length, 1);
  assert.equal(packet.entries[0].text, rule.text);
  assert.equal(packet.omitted, 1);
});

test("new conversations receive project guidance and revocations through the actual Brain request", async (t) => {
  const f = fixture(t),
    previous = process.env.BOBO_ENV_PATH;
  process.env.BOBO_ENV_PATH = path.join(f.dir, ".env");
  fs.writeFileSync(
    process.env.BOBO_ENV_PATH,
    "OPENAI_API_KEY=sk-local-fixture\n",
  );
  t.after(() => {
    if (previous === undefined) delete process.env.BOBO_ENV_PATH;
    else process.env.BOBO_ENV_PATH = previous;
  });
  const m = saveProjectMemory(f.store, f.work, {
    text: "保留中文名称",
    source: userSource,
  });
  const requests = [];
  const brain = new Brain(f.store, { list: () => [] }, () => ({
    responses: {
      create: async (request) => {
        requests.push(request);
        return {
          output: [],
          output_text: "收到",
          usage: { input_tokens: 10, output_tokens: 2 },
        };
      },
    },
  }));
  f.store.newConversation();
  await brain.chat("开始下一份报告");
  assert.match(requests[0].instructions, /保留中文名称/);
  revokeProjectMemory(f.store, f.work, m.id);
  f.store.newConversation();
  await brain.chat("继续工作");
  assert.match(requests[1].instructions, /"status":"revoked"/);
  f.store.state.settings.workspace = f.other;
  f.store.newConversation();
  await brain.chat("另一项目");
  assert.ok(!requests[2].instructions.includes("保留中文名称"));
});

test("memory tools require explicit exact user instruction and reject negative requests", (t) => {
  const f = fixture(t);
  f.store.message("user", "普通任务：检查金额");
  assert.throws(
    () =>
      executeTool(f.store, null, "save_project_memory", {
        text: "检查金额",
        kind: "feedback",
      }),
    /明确/,
  );
  f.store.message("user", "以后还能查看金额吗？");
  assert.throws(
    () =>
      executeTool(f.store, null, "save_project_memory", {
        text: "查看金额",
        kind: "feedback",
      }),
    /明确/,
  );
  f.store.message("user", "记住：金额采用整数分");
  assert.throws(
    () =>
      executeTool(f.store, null, "save_project_memory", {
        text: "金额使用浮点数",
        kind: "feedback",
      }),
    /逐字/,
  );
  const m = executeTool(f.store, null, "save_project_memory", {
    text: "金额采用整数分",
    kind: "feedback",
  });
  f.store.message("user", "don't forget this memory");
  assert.throws(
    () =>
      executeTool(f.store, null, "forget_project_memory", {
        memory_id: m.id,
        user_request: "don't forget this memory",
      }),
    /明确/,
  );
  f.store.message("user", "撤下这条金额记忆");
  executeTool(f.store, null, "forget_project_memory", {
    memory_id: m.id,
    user_request: "撤下这条金额记忆",
  });
  assert.equal(listProjectMemories(f.store, f.work)[0].status, "revoked");
});

test("Brain stops over-budget model input with a truthful local explanation and no model request", async (t) => {
  const f = fixture(t),
    previous = process.env.BOBO_ENV_PATH;
  process.env.BOBO_ENV_PATH = path.join(f.dir, ".env");
  fs.writeFileSync(
    process.env.BOBO_ENV_PATH,
    "OPENAI_API_KEY=sk-local-fixture\n",
  );
  t.after(() => {
    if (previous === undefined) delete process.env.BOBO_ENV_PATH;
    else process.env.BOBO_ENV_PATH = previous;
  });
  let calls = 0;
  const brain = new Brain(f.store, { list: () => [] }, () => ({
    responses: {
      create: async () => {
        calls++;
        throw new Error("must not call");
      },
    },
  }));
  for (let i = 0; i < 20; i++)
    saveProjectMemory(f.store, f.work, {
      text: `${i}:` + "必须保留原话".repeat(330),
      source: userSource,
    });
  const reply = await brain.chat("开始新任务");
  assert.equal(calls, 0);
  assert.match(reply, /已停止新增模型调用/);
  assert.ok(!reply.includes("没有连上"));
});

test("input dependency failures cannot pass; unsafe dependencies are rejected", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.work, "out.txt"), "done");
  const contract = validateContract({
    checks: [
      {
        kind: "contains",
        path: "out.txt",
        expected: "done",
        dependencies: ["missing.txt", ""],
      },
    ],
  });
  assert.deepEqual(contract.checks[0].dependencies, ["missing.txt"]);
  const task = { workspace: f.work };
  task.verification = runVerification(task, contract);
  assert.equal(task.verification.status, "failed");
  assert.equal(verificationFreshness(task, contract).status, "needs_recheck");
  for (const dependency of ["../secret", ".env", "/tmp/input"])
    assert.throws(
      () =>
        validateContract({
          checks: [
            {
              kind: "exists",
              path: "out.txt",
              expected: "",
              dependencies: [dependency],
            },
          ],
        }),
      /输入文件/,
    );
  const legacy = {
    ...task,
    verification: { ...task.verification, contractSignature: undefined },
  };
  const changed = validateContract({
    checks: [{ kind: "exists", path: "out.txt", expected: "" }],
  });
  assert.equal(verificationFreshness(legacy, changed).status, "stale");
});

test("Unicode token estimation and whole-item packing preserve required content", () => {
  assert.ok(estimateTokens("中文🥕") > 0);
  const base = { required: "逐字要求🥕" },
    budget = estimateTokens(JSON.stringify(base)) + 2;
  const fitted = fitContext(
    base,
    [{ apply: (p) => ({ ...p, report: "长报告".repeat(100) }) }],
    JSON.stringify,
    budget,
  );
  assert.deepEqual(fitted.value, base);
  assert.equal(fitted.budget.omittedOptional, 1);
  const overflow = fitContext(base, [], JSON.stringify, 1);
  assert.equal(overflow.value.required, base.required);
  assert.equal(overflow.budget.overTokenTarget, true);
  const packed = packChatHistory(
    [
      { role: "user", content: "旧话".repeat(200) },
      { role: "assistant", content: "回复" },
      { role: "user", content: "新要求" },
    ],
    20,
  );
  assert.equal(packed.messages.at(-1).content, "新要求");
  assert.ok(packed.omitted > 0);
});

test("malformed memory migration refuses to overwrite saved state", () => {
  assert.throws(
    () =>
      ensureWorkMemory({
        workMemory: {
          version: 1,
          sequence: 0,
          records: [],
          project: [],
          cursors: {},
        },
      }),
    /原存档已保留/,
  );
});
