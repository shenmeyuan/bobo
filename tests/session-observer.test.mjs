import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Store } from "../electron/store.mjs";
import {
  configureClaudeHooks,
  normalizeClaudeEvent,
  normalizeCodexThreads,
  readCodexSessions,
  SessionObserver,
} from "../electron/session-observer.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-observer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, "data"));
  return { dir, store };
}
test("CC hook installation preserves other hooks and settings; repeat installation and removal are exact", (t) => {
  const { dir, store } = fixture(t),
    home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const settingsFile = path.join(home, ".claude/settings.json");
  const original = {
    permissions: { allow: ["Read"] },
    env: { CUSTOM: "keep" },
    hooks: {
      Stop: [
        { matcher: "", hooks: [{ type: "command", command: "existing-hook" }] },
      ],
    },
  };
  fs.writeFileSync(settingsFile, JSON.stringify(original));
  const options = { home, executable: process.execPath };
  configureClaudeHooks(path.dirname(store.file), true, options);
  configureClaudeHooks(path.dirname(store.file), true, options);
  const enabled = JSON.parse(fs.readFileSync(settingsFile));
  assert.equal(enabled.hooks.Stop.length, 2);
  assert.deepEqual(enabled.permissions, original.permissions);
  assert.deepEqual(enabled.env, original.env);
  configureClaudeHooks(path.dirname(store.file), false, options);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile)), original);
  assert.ok(
    fs
      .readdirSync(path.dirname(settingsFile))
      .some((n) => n.includes("bobo-backup")),
  );
  fs.writeFileSync(settingsFile, "broken");
  assert.throws(() =>
    configureClaudeHooks(path.dirname(store.file), true, options),
  );
  assert.equal(fs.readFileSync(settingsFile, "utf8"), "broken");
});
test("actual CC hook process saves only metadata; drain deduplicates alerts and excludes owned sessions", async (t) => {
  const { dir, store } = fixture(t),
    dataDir = path.dirname(store.file),
    notices = [];
  configureClaudeHooks(dataDir, true, { home: path.join(dir, "home") });
  const observer = new SessionObserver(store, {
    onNotice: (s) => notices.push(s),
  });
  store.state.observer.claudeEnabled = true;
  const body = {
    session_id: "external-1",
    cwd: dir,
    hook_event_name: "Notification",
    notification_type: "permission_prompt",
    prompt: "do-not-record-prompt",
    tool_input: { key: "do-not-record-secret" },
    transcript_path: "do-not-record-path",
  };
  const emit = async (event) => {
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.join(dataDir, "bobo-session-observer.cjs"), observer.queue],
        { stdio: ["pipe", "ignore", "pipe"] },
      );
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error("hook failed")),
      );
      child.stdin.end(JSON.stringify(event));
    });
  };
  await emit(body);
  const saved = fs.readFileSync(
    path.join(observer.queue, fs.readdirSync(observer.queue)[0]),
    "utf8",
  );
  assert.doesNotMatch(saved, /do-not-record/);
  observer.drain();
  assert.equal(store.state.observer.sessions[0].status, "waiting");
  assert.equal(notices.length, 1);
  await emit(body);
  observer.drain();
  assert.equal(notices.length, 1);
  store.state.tasks.push({ sessionId: "owned", agent: "claude" });
  await emit({ ...body, session_id: "owned" });
  observer.drain();
  assert.equal(store.state.observer.sessions.length, 1);
  assert.equal(fs.readdirSync(observer.queue).length, 0);
  const restored = new Store(dataDir);
  assert.equal(restored.state.observer.sessions[0].sessionId, "external-1");
});
test("unknown and stale protocol data cannot become running or completed tasks", () => {
  assert.equal(normalizeClaudeEvent({ session_id: "../x" }), null);
  const sessions = normalizeCodexThreads(
    [
      {
        id: "abc",
        cwd: "/tmp/project",
        preview: "private prompt",
        status: { type: "notLoaded" },
        updatedAt: 100,
      },
    ],
    100000,
  );
  assert.equal(sessions[0].status, "observed");
  assert.equal(sessions[0].updatedAt, 100000);
  assert.doesNotMatch(JSON.stringify(sessions), /private prompt/);
  assert.throws(() => normalizeCodexThreads(null));
});
test("Codex observer uses only initialize and thread/list, no turns or model calls; errors retain stale records", async (t) => {
  const { dir, store } = fixture(t),
    cli = path.join(dir, "codex.cjs");
  const requests = path.join(dir, "requests.jsonl");
  fs.writeFileSync(
    cli,
    `const fs=require('fs'), readline=require('readline'); readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(requests)},line+'\\n');if(m.id) console.log(JSON.stringify({id:m.id,result:m.id===1?{}:{data:[{id:'known-session',cwd:${JSON.stringify(dir)},status:{type:'notLoaded'},updatedAt:100}]}}));});`,
  );
  const sessions = await readCodexSessions(process.execPath, dir, {
    spawnProcess: (_bin, _args, options) =>
      spawn(process.execPath, [cli], options),
  });
  assert.equal(sessions[0].status, "observed");
  const methods = fs
    .readFileSync(requests, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).method);
  assert.deepEqual(methods, ["initialize", "initialized", "thread/list"]);
  const observer = new SessionObserver(store, {
    readCodex: async () => {
      throw new Error("offline");
    },
  });
  store.state.observer.codexEnabled = true;
  store.state.observer.sessions = sessions;
  await observer.refresh();
  assert.equal(store.state.observer.sessions[0].id, sessions[0].id);
  assert.match(store.state.observer.errors.codex, /offline/);
});
