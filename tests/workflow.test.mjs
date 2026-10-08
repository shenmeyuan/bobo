import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Store } from "../electron/store.mjs";
import { AgentManager } from "../electron/agents.mjs";
import { safeFile, inventory, runVerification } from "../electron/workflow.mjs";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-workflow-")),
    work = path.join(dir, "workspace");
  fs.mkdirSync(work);
  const previous = process.env.BOBO_ENV_PATH;
  process.env.BOBO_ENV_PATH = path.join(dir, ".env");
  fs.writeFileSync(
    process.env.BOBO_ENV_PATH,
    `BOBO_CODEX_PATH=${process.execPath}\nBOBO_CLAUDE_PATH=${process.execPath}\n`,
  );
  const store = new Store(path.join(dir, "data"));
  store.state.settings.workspace = work;
  const children = [],
    inputs = [];
  const manager = new AgentManager(
    store,
    () => {},
    () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      let input = "";
      child.stdin.on("data", (chunk) => {
        input += chunk;
        inputs[children.indexOf(child)] = input;
      });
      children.push(child);
      return child;
    },
  );
  t.after(() => {
    manager.stopAll();
    for (const child of children) child.emit("close", 1);
    if (previous === undefined) delete process.env.BOBO_ENV_PATH;
    else process.env.BOBO_ENV_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const finish = (
    index,
    result = "Agent 自报完成",
    usage = { input_tokens: 10, output_tokens: 5 },
  ) => {
    const child = children[index];
    child.stdout.write(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: result },
      }) + "\n",
    );
    if (usage)
      child.stdout.write(
        JSON.stringify({ type: "turn.completed", usage }) + "\n",
      );
    child.emit("close", 0);
  };
  return { dir, work, store, manager, children, inputs, finish };
}
test("continuation preserves goal, contract, artifact changes and permissions; duplicate click reuses child", (t) => {
  const f = fixture(t);
  const contract = {
    checks: [{ kind: "contains", path: "report.txt", expected: "完整" }],
    maxAttempts: 3,
    tokenLimit: null,
  };
  const first = f.manager.dispatch(
    "codex",
    "报告",
    "保留所有原文；交付中文报告",
    { contract },
  );
  fs.writeFileSync(path.join(f.work, "report.txt"), "部分内容");
  f.finish(0, "仅完成资料收集");
  fs.writeFileSync(path.join(f.work, "report.txt"), "用户修改");
  f.store.state.settings.allowEdits = true;
  const next = f.manager.resume(first.id, "claude", "继续未完成章节");
  const packet = JSON.parse(
    f.inputs[1].slice(f.inputs[1].indexOf('{"schema_version"')),
  );
  assert.equal(packet.goal, "保留所有原文；交付中文报告");
  assert.equal(packet.acceptance[0].expected, "完整");
  assert.equal(packet.changed_since_checkpoint[0].path, "report.txt");
  assert.equal(f.manager.task(next.id).allowEdits, false);
  assert.equal(f.manager.task(next.id).parentId, first.id);
  assert.equal(f.manager.resume(first.id, "claude").id, next.id);
  assert.equal(f.children.length, 2);
});
test("cancel waits for actual process close before continuation and before another writer", (t) => {
  const f = fixture(t);
  f.store.state.settings.allowEdits = true;
  const first = f.manager.dispatch("codex", "编辑", "编辑文件");
  f.manager.cancel(first.id);
  assert.throws(() => f.manager.resume(first.id, "claude"), /退出/);
  assert.throws(
    () => f.manager.dispatch("codex", "另一个", "编辑"),
    /执行进程/,
  );
  f.children[0].emit("close", 1);
  assert.equal(f.manager.resume(first.id, "claude").status, "running");
});
test("verification catches missing and incorrect output despite agent claiming completion", (t) => {
  const f = fixture(t);
  const first = f.manager.dispatch("codex", "报告", "报告");
  f.finish(0);
  f.manager.setContract(first.id, {
    checks: [
      { kind: "contains", path: "report.txt", expected: "正确" },
      { kind: "json", path: "data.json", expected: "" },
    ],
    maxAttempts: 3,
    tokenLimit: null,
  });
  assert.equal(f.manager.verify(first.id).status, "failed");
  fs.writeFileSync(path.join(f.work, "report.txt"), "正确");
  fs.writeFileSync(path.join(f.work, "data.json"), '{"ok":true}');
  assert.equal(f.manager.verify(first.id).status, "passed");
  fs.writeFileSync(path.join(f.work, "data.json"), "broken");
  assert.equal(f.manager.verify(first.id).status, "failed");
  assert.equal(f.manager.task(first.id).status, "completed");
});
test("budget gates account for failed attempts and coordination, unknown consumption blocks bounded continuation", (t) => {
  const f = fixture(t);
  const first = f.manager.dispatch("codex", "工作", "工作");
  f.finish(0);
  f.store.state.coordinationUsage.push({
    rootIds: [first.id],
    input: 4,
    output: 1,
    calls: 1,
    unknown: false,
  });
  f.manager.setContract(first.id, {
    checks: [],
    maxAttempts: 3,
    tokenLimit: 20,
  });
  assert.equal(f.manager.report(first.id).usage.total, 20);
  assert.throws(() => f.manager.resume(first.id, "claude"), /阈值/);
  f.manager.task(first.id).usage = null;
  assert.throws(() => f.manager.resume(first.id, "claude"), /未回报/);
  f.manager.setContract(first.id, {
    checks: [],
    maxAttempts: 1,
    tokenLimit: null,
  });
  assert.throws(() => f.manager.resume(first.id, "claude"), /次数/);
});
test("lineage, contract and verification survive restart, workspace switching cannot redirect continuation", (t) => {
  const f = fixture(t);
  const first = f.manager.dispatch("codex", "工作", "原始需求");
  f.finish(0);
  f.manager.setContract(first.id, {
    checks: [],
    maxAttempts: 2,
    tokenLimit: null,
  });
  const next = f.manager.resume(first.id, "claude");
  f.manager.cancel(next.id);
  f.children[1].emit("close", 1);
  const restored = new Store(path.join(f.dir, "data"));
  const manager = new AgentManager(restored);
  assert.equal(manager.report(next.id).attempts.length, 2);
  assert.equal(manager.report(next.id).contract.maxAttempts, 2);
  f.store.state.settings.workspace = f.dir;
  assert.throws(() => f.manager.resume(next.id, "codex"), /原工作目录/);
});
test("file checks reject traversal, symlinks outside workspace, and aliases of sensitive files", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, "outside.txt"), "outside");
  fs.writeFileSync(path.join(f.work, ".env"), "secret");
  fs.symlinkSync(
    path.join(f.dir, "outside.txt"),
    path.join(f.work, "outside-link"),
  );
  fs.symlinkSync(path.join(f.work, ".env"), path.join(f.work, "hidden-link"));
  assert.throws(() => safeFile(f.work, "../outside.txt"));
  assert.throws(() => safeFile(f.work, "outside-link"));
  assert.throws(() => safeFile(f.work, "hidden-link"));
  assert.equal(Object.keys(inventory(f.work).files).length, 0);
  const result = runVerification(
    { workspace: f.work },
    { checks: [{ kind: "exists", path: "outside-link", expected: "" }] },
  );
  assert.equal(result.status, "failed");
});
test("predeclared delivery checks run automatically after process exit", (t) => {
  const f = fixture(t);
  const task = f.manager.dispatch("codex", "交付", "交付文件", {
    contract: {
      checks: [{ kind: "exists", path: "missing.txt", expected: "" }],
      maxAttempts: 3,
      tokenLimit: null,
    },
  });
  f.finish(0, "全部完成了");
  assert.equal(f.manager.task(task.id).verification.status, "failed");
  assert.match(f.manager.task(task.id).progress, /未通过/);
});

test("manual continuation notes survive repeated handoffs, automatic retry instructions do not become user corrections", (t) => {
  const f = fixture(t),
    a = f.manager.dispatch("codex", "memory", "保留每行数据", {
      contract: { checks: [], maxAttempts: 5, tokenLimit: null },
    });
  f.finish(0, "阶段一");
  const b = f.manager.resume(a.id, "codex", "金额按分保存");
  f.finish(1, "阶段二");
  const c = f.manager.resume(b.id, "claude", "恢复自动指令", {
    automatic: true,
  });
  const packet = f.manager.task(c.id).handoff;
  assert.ok(packet.user_corrections.some((c) => c.text === "金额按分保存"));
  assert.ok(!packet.user_corrections.some((c) => c.text === "恢复自动指令"));
  const correction = f.manager
    .report(c.id)
    .corrections.find((c) => c.text === "金额按分保存");
  f.manager.recordCorrection(c.id, "", correction.id);
  assert.equal(
    f.manager.report(c.id).corrections.filter((c) => c.active).length,
    0,
  );
});
test("a previously passed file check is stale after the artifact changes or disappears", (t) => {
  const f = fixture(t),
    a = f.manager.dispatch("codex", "memory", "交付 done", {
      contract: {
        checks: [{ kind: "contains", path: "result.txt", expected: "done" }],
        maxAttempts: 4,
        tokenLimit: null,
      },
    });
  fs.writeFileSync(path.join(f.work, "result.txt"), "done");
  f.finish(0);
  assert.equal(f.manager.task(a.id).verification.status, "passed");
  fs.writeFileSync(path.join(f.work, "result.txt"), "partial");
  const b = f.manager.resume(a.id, "claude");
  const packet = f.manager.task(b.id).handoff;
  assert.equal(packet.verification.status, "stale");
  assert.equal(packet.verification.recorded_status, "passed");
  assert.equal(packet.verification.checks[0].freshness, "stale");
});
test("long public reports remain retrievable beyond the old 16000-character display limit, with tail excerpts", (t) => {
  const f = fixture(t),
    a = f.manager.dispatch("codex", "memory", "完成工作");
  const report =
    "普通日志\n".repeat(4200) + "\n未完成：需要处理 FINAL_BLOCKER_982";
  f.finish(0, report);
  assert.ok(f.manager.task(a.id).result.length <= 16000);
  assert.ok(f.manager.task(a.id).reportMemory.chars > 16000);
  const b = f.manager.resume(a.id, "claude");
  const packet = f.manager.task(b.id).handoff;
  assert.ok(
    packet.reports[0].excerpts.some((e) =>
      e.text.includes("FINAL_BLOCKER_982"),
    ),
  );
  assert.ok(packet.context_budget.omittedReportChars > 0);
  assert.ok(fs.existsSync(packet.reports[0].archive.path));
});
test("native resume skips duplicate reports but keeps hard requirements, original user request and corrections", (t) => {
  const f = fixture(t),
    a = f.manager.dispatch("codex", "memory", "调度模型转述", {
      sourceMessage: {
        id: "message1",
        at: 1,
        content: "用户原话：不得删除表格",
      },
      contract: { checks: [], maxAttempts: 4, tokenLimit: null },
    });
  f.children[0].stdout.write(
    JSON.stringify({ type: "thread.started", thread_id: "session-memory" }) +
      "\n",
  );
  f.finish(0, "大量报告".repeat(2000));
  const b = f.manager.resume(a.id, "codex", "保留原始格式");
  const packet = f.manager.task(b.id).handoff;
  assert.equal(packet.continuation_mode, "native_session");
  assert.equal(packet.context_budget.selectedReportChars, 0);
  assert.equal(packet.original_user_request.content, "用户原话：不得删除表格");
  assert.ok(packet.user_corrections.some((c) => c.text === "保留原始格式"));
});
test("mandatory context overflow blocks continuation; raising budget preserves exact requirements", (t) => {
  const f = fixture(t),
    goal = "原始约束".repeat(3500),
    a = f.manager.dispatch("codex", "memory", goal, {
      contract: { checks: [], contextTokenBudget: 32000 },
    });
  f.finish(0);
  f.manager.recordCorrection(a.id, "每条记录都保留");
  f.manager.setContract(a.id, { checks: [], contextTokenBudget: 512 });
  assert.throws(() => f.manager.resume(a.id, "claude"), /预算/);
  assert.equal(f.children.length, 1);
  assert.equal(f.manager.task(a.id).childId, undefined);
  f.manager.setContract(a.id, { checks: [], contextTokenBudget: 32000 });
  const b = f.manager.resume(a.id, "claude");
  const packet = f.manager.task(b.id).handoff;
  assert.equal(packet.goal, goal);
  assert.equal(packet.context_budget.overTarget, true);
  assert.equal(packet.context_budget.overTokenTarget, false);
  assert.ok(packet.user_corrections.some((c) => c.text === "每条记录都保留"));
});

test("oversized first dispatch never spawns a worker and can continue after budget adjustment", (t) => {
  const f = fixture(t);
  f.store.state.settings.superviseTasks = true;
  f.manager.supervisor.start({ interval: false });
  const a = f.manager.dispatch("codex", "预算", "必须保留的原话".repeat(150), {
    contract: { checks: [], contextTokenBudget: 512 },
  });
  assert.equal(a.status, "attention");
  assert.equal(f.children.length, 0);
  assert.match(f.manager.task(a.id).progress, /尚未启动/);
  assert.match(f.manager.task(a.id).supervision.reason, /上下文预算不足/);
  f.manager.setContract(a.id, { checks: [], contextTokenBudget: 8000 });
  const next = f.manager.resume(a.id, "codex");
  assert.equal(next.status, "running");
  assert.equal(f.children.length, 1);
});

test("input changes invalidate evidence without discarding original passed results", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.work, "input.txt"), "v1");
  const checks = [
    {
      kind: "contains",
      path: "report.txt",
      expected: "done",
      dependencies: ["input.txt", ""],
    },
  ];
  const a = f.manager.dispatch("codex", "依赖", "报告", {
    contract: { checks },
  });
  fs.writeFileSync(path.join(f.work, "report.txt"), "done");
  f.finish(0);
  assert.equal(f.manager.report(a.id).verification.status, "passed");
  const recorded = structuredClone(f.manager.task(a.id).verification);
  fs.writeFileSync(path.join(f.work, "input.txt"), "v2");
  const stale = f.manager.report(a.id);
  assert.equal(stale.verification.status, "stale");
  assert.equal(stale.verification.checks[0].dependencies[0].freshness, "stale");
  assert.deepEqual(f.manager.task(a.id).verification, recorded);
  assert.equal(f.manager.verify(a.id).status, "passed");
  f.manager.setContract(a.id, { checks, contextTokenBudget: 10000 });
  assert.equal(f.manager.report(a.id).verification.status, "passed");
  f.manager.setContract(a.id, {
    checks: [{ ...checks[0], expected: "new content" }],
  });
  assert.equal(f.manager.report(a.id).verification.status, "stale");
  const ledger = f.store.state.workMemory.records[`${a.id}:evidence:${a.id}`];
  assert.equal(ledger.status, "stale");
  assert.ok(ledger.history.some((r) => r.status === "passed"));
});

test("correction ledger is incremental and revocations survive restarting the store", (t) => {
  const f = fixture(t);
  const a = f.manager.dispatch("codex", "记忆", "不得删行");
  f.finish(0);
  f.manager.recordCorrection(a.id, "金额用整数分");
  const root = f.manager.task(a.id),
    correction = root.corrections[0];
  const key = `${a.id}:correction:${correction.id}`;
  assert.equal(f.store.state.workMemory.records[key].status, "active");
  const sequence = f.manager.report(a.id).memory.ledger.processedThrough;
  assert.equal(f.manager.report(a.id).memory.ledger.processedThrough, sequence);
  f.manager.recordCorrection(a.id, "", correction.id);
  const restarted = new Store(path.dirname(f.store.file));
  assert.equal(restarted.state.workMemory.records[key].status, "revoked");
  assert.equal(restarted.state.workMemory.records[key].revision, 2);
  assert.equal(
    restarted.state.workMemory.records[key].history[0].content.text,
    "金额用整数分",
  );
});

test("first dispatch includes original user constraints and revoked corrections are explicit in native continuation", (t) => {
  const f = fixture(t),
    a = f.manager.dispatch("codex", "memory", "整理数据", {
      sourceMessage: { id: "m1", content: "严禁删除任何行", at: 1 },
    });
  assert.match(f.inputs[0], /严禁删除任何行/);
  f.children[0].stdout.write(
    JSON.stringify({ type: "thread.started", thread_id: "session-one" }) + "\n",
  );
  f.finish(0);
  f.manager.recordCorrection(a.id, "输出英文");
  const correction = f.manager.report(a.id).corrections[0];
  f.manager.recordCorrection(a.id, "", correction.id);
  const b = f.manager.resume(a.id, "codex");
  assert.equal(
    f.manager.task(b.id).handoff.revoked_corrections[0].text,
    "输出英文",
  );
  assert.equal(f.manager.task(b.id).handoff.user_corrections.length, 0);
});
test("overflowing progress does not hide the newest terminal report and incomplete archive is labelled", (t) => {
  const f = fixture(t),
    a = f.manager.dispatch("codex", "memory", "工作");
  f.children[0].stdout.write(
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "x".repeat(130000) },
    }) + "\n",
  );
  f.finish(0, "未完成 FINAL_CRITICAL");
  const b = f.manager.resume(a.id, "claude");
  const report = f.manager.task(b.id).handoff.reports[0];
  assert.equal(report.archive.truncated, true);
  assert.ok(report.excerpts.some((e) => e.text.includes("FINAL_CRITICAL")));
});
test("retargeting a workspace symlink cannot move a resumed task into a different project", (t) => {
  const f = fixture(t),
    link = path.join(f.dir, "work-link"),
    other = path.join(f.dir, "other");
  fs.mkdirSync(other);
  fs.symlinkSync(f.work, link);
  f.store.state.settings.workspace = link;
  const a = f.manager.dispatch("codex", "memory", "work");
  assert.equal(f.manager.task(a.id).workspace, fs.realpathSync(f.work));
  f.finish(0);
  fs.unlinkSync(link);
  fs.symlinkSync(other, link);
  assert.throws(() => f.manager.resume(a.id, "claude"), /原工作目录/);
});
test("execution envelope retains actionable evidence and constraints while local accounting stays out of model input", async (t) => {
  const { handoffPacket, continuationPrompt, executionMemory } =
    await import("../electron/workflow.mjs");
  const f = fixture(t),
    first = f.manager.dispatch("codex", "memory", "不能改动输入，交付文件");
  f.finish(0, "公开报告：下一步完成交付。");
  f.manager.recordCorrection(first.id, "金额必须是整数分");
  const full = handoffPacket(
    f.store,
    f.manager.task(first.id),
    "继续",
    inventory(f.work),
  );
  const slim = executionMemory(full),
    prompt = continuationPrompt(full);
  assert.equal(slim.goal, full.goal);
  assert.deepEqual(slim.user_corrections, full.user_corrections);
  assert.deepEqual(slim.verification, full.verification);
  assert.deepEqual(slim.reports[0].archive, full.reports[0].archive);
  assert.deepEqual(slim.reports[0].excerpts, full.reports[0].excerpts);
  assert.equal(slim.usage, undefined);
  assert.equal(slim.context_budget, undefined);
  assert.ok(JSON.stringify(slim).length < JSON.stringify(full).length);
  assert.equal(full.context_budget.transmittedChars, prompt.length);
});
