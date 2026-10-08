import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Store } from "../electron/store.mjs";
import { AgentManager, parseAgentEvent } from "../electron/agents.mjs";
import { Supervisor } from "../electron/supervisor.mjs";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-supervise-")),
    work = path.join(dir, "work");
  fs.mkdirSync(work);
  const prev = process.env.BOBO_ENV_PATH;
  process.env.BOBO_ENV_PATH = path.join(dir, ".env");
  fs.writeFileSync(
    process.env.BOBO_ENV_PATH,
    `BOBO_CODEX_PATH=${process.execPath}\nBOBO_CLAUDE_PATH=${process.execPath}\nBOBO_TRAE_PATH=${process.execPath}\n`,
  );
  const store = new Store(path.join(dir, "data"));
  store.state.settings.workspace = work;
  const children = [],
    notices = [];
  let now = Date.now();
  const spawn = (_bin, args) => {
    const child = new EventEmitter();
    Object.assign(child, {
      args,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {},
    });
    child.input = "";
    child.stdin.on("data", (d) => (child.input += d));
    children.push(child);
    return child;
  };
  const manager = new AgentManager(
    store,
    (task, reason) => notices.push({ id: task.id, reason }),
    spawn,
  );
  manager.supervisor = new Supervisor(manager, {
    now: () => now,
    retryDelayMs: 10,
  });
  manager.supervisor.start({ interval: false });
  t.after(() => {
    manager.stopAll();
    for (const c of children) c.emit("close", 1);
    if (prev === undefined) delete process.env.BOBO_ENV_PATH;
    else process.env.BOBO_ENV_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const event = (i, e) => children[i].stdout.write(JSON.stringify(e) + "\n");
  return {
    dir,
    work,
    store,
    manager,
    children,
    notices,
    spawn,
    event,
    advance(ms = 11) {
      now += ms;
      manager.supervisor.tick();
    },
    fail(i, error) {
      event(i, { type: "turn.failed", error: { message: error } });
      children[i].emit("close", 1);
    },
    success(i) {
      event(i, {
        type: "item.completed",
        item: { type: "agent_message", text: "done" },
      });
      event(i, {
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      children[i].emit("close", 0);
    },
  };
}
test("temporary error resumes exact native session without asking user; repeated error stops", (t) => {
  const f = fixture(t),
    first = f.manager.dispatch("codex", "work", "original");
  f.event(0, { type: "thread.started", thread_id: "session-123" });
  f.fail(0, "ECONNRESET");
  assert.equal(f.notices.length, 0);
  f.advance();
  assert.equal(f.children.length, 2);
  assert.ok(f.children[1].args.includes("session-123"));
  assert.ok(f.children[1].args.includes("read-only"));
  assert.equal(f.manager.task(first.id).childId, f.store.state.tasks[0].id);
  f.fail(1, "ECONNRESET");
  f.advance();
  assert.equal(f.children.length, 2);
  assert.equal(f.notices.length, 1);
  assert.equal(f.manager.report(first.id).supervision.state, "attention");
});
test("quota fallback uses allowed list, carries corrections and has one completion notification", (t) => {
  const f = fixture(t),
    first = f.manager.dispatch("codex", "work", "preserve all data");
  f.manager.supervisor.configure(first.id, true, ["codex", "claude"]);
  const correction = f.manager.recordCorrection(first.id, "只改展示，不改数据");
  assert.match(correction.message, /尚未收到/);
  f.fail(0, "429 rate limit exceeded");
  f.advance();
  assert.ok(f.children[1].args.includes("-p"));
  assert.match(f.children[1].input, /只改展示/);
  assert.match(f.children[1].input, /preserve all data/);
  f.event(1, {
    type: "result",
    result: "done",
    usage: { input_tokens: 2, output_tokens: 3 },
  });
  f.children[1].emit("close", 0);
  assert.equal(f.notices.length, 1);
  assert.equal(f.manager.report(first.id).supervision.state, "done");
  f.advance();
  assert.equal(f.children.length, 2);
});
test("manual stop cancels pending recovery and stopping an old attempt stops its live successor", (t) => {
  const f = fixture(t),
    first = f.manager.dispatch("codex", "work", "go");
  f.fail(0, "503 temporarily unavailable");
  f.manager.cancel(first.id);
  f.advance();
  assert.equal(f.children.length, 1);
  assert.equal(f.manager.report(first.id).supervision.enabled, false);
  const next = f.manager.resume(first.id, "codex");
  f.manager.cancel(first.id);
  assert.equal(f.manager.task(next.id).status, "cancelled");
});
test("quiet output and live old process never trigger a duplicate", (t) => {
  const f = fixture(t),
    first = f.manager.dispatch("codex", "work", "go");
  f.advance(190000);
  assert.equal(f.manager.task(first.id).quiet, true);
  assert.equal(f.children.length, 1);
  f.manager.finish(f.manager.task(first.id), "failed", "connection reset");
  f.advance();
  assert.equal(f.children.length, 1);
  f.children[0].emit("close", 1);
  f.advance();
  assert.equal(f.children.length, 2);
});
test("unknown errors and login failures stop without retry or changing tool", (t) => {
  for (const error of ["unrecognized task failure", "401 unauthorized"]) {
    const f = fixture(t);
    f.manager.dispatch("codex", "work", "go");
    f.fail(0, error);
    f.advance();
    assert.equal(f.children.length, 1);
    assert.equal(f.notices.length, 1);
  }
});
test("unknown token usage with threshold and a changed workspace both block automatic continuation", (t) => {
  const f = fixture(t),
    first = f.manager.dispatch("codex", "work", "go", {
      contract: { checks: [], maxAttempts: 3, tokenLimit: 100 },
    });
  f.fail(0, "503 temporary");
  f.advance();
  assert.equal(f.children.length, 1);
  assert.match(f.manager.report(first.id).supervision.reason, /用量/);
  const g = fixture(t),
    next = g.manager.dispatch("codex", "work", "go");
  g.fail(0, "503 temporary");
  g.store.state.settings.workspace = g.dir;
  g.advance();
  assert.equal(g.children.length, 1);
  assert.match(g.manager.report(next.id).supervision.reason, /原工作目录/);
});
test("failed acceptance gets one repair then stops if still wrong", (t) => {
  const f = fixture(t),
    first = f.manager.dispatch("codex", "work", "create file", {
      contract: {
        checks: [{ path: "report.json", kind: "json", expected: "" }],
        maxAttempts: 5,
        tokenLimit: null,
      },
    });
  f.success(0);
  f.advance();
  assert.equal(f.children.length, 2);
  assert.match(f.children[1].input, /report.json/);
  f.success(1);
  f.advance();
  assert.equal(f.children.length, 2);
  assert.equal(f.manager.report(first.id).supervision.state, "attention");
});
test("pending recovery survives restart exactly once; unsupervised history is left alone", (t) => {
  const f = fixture(t),
    first = f.manager.dispatch("codex", "work", "go");
  f.fail(0, "503 temporary");
  f.manager.supervisor.stop();
  const restored = new Store(path.join(f.dir, "data"));
  restored.state.tasks.push({
    id: "old",
    rootId: "old",
    status: "interrupted",
    agent: "codex",
  });
  const next = new AgentManager(restored, () => {}, f.spawn);
  next.supervisor = new Supervisor(next, {
    now: () => Date.now() + 10000,
    retryDelayMs: 0,
  });
  next.supervisor.start({ interval: false });
  next.supervisor.tick();
  next.supervisor.tick();
  assert.equal(f.children.length, 2);
  assert.equal(next.report(first.id).attempts.length, 2);
  assert.equal(
    restored.state.tasks.find((t) => t.id === "old").childId,
    undefined,
  );
  next.stopAll();
});
test("Coco usage already includes cache reads and prompt is an argv value, never shell code", (t) => {
  assert.equal(
    parseAgentEvent("trae", {
      type: "result",
      result: "done",
      session_id: "s",
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 80,
        output_tokens: 4,
      },
    }).usage.input,
    100,
  );
  const f = fixture(t);
  f.manager.dispatch("trae", "work", "literal $(touch no)");
  assert.equal(f.children[0].args.at(-1), "literal $(touch no)");
  assert.ok(f.children[0].args.includes("plan"));
  assert.equal(f.children[0].input, "");
});
