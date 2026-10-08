// Replay the actual Coco wrapped error using a real local child process. No paid calls.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { Store } from "../electron/store.mjs";
import { AgentManager } from "../electron/agents.mjs";
const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "bobo-permission-replay-"),
  ),
  before = process.env.BOBO_ENV_PATH;
const childScript = path.join(directory, "agent.cjs");
fs.writeFileSync(
  childScript,
  `#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'user',subtype:'tool_result',tool_name:'ApplyPatch',tool_use_id:'patch-1',is_error:true,content:{content:[{type:'text',text:'Permission denied to execute this tool'}],structured_content:null,is_error:true}}));\nsetInterval(()=>{},100);\n`,
  { mode: 0o700 },
);
process.env.BOBO_ENV_PATH = path.join(directory, ".env");
fs.writeFileSync(process.env.BOBO_ENV_PATH, `BOBO_TRAE_PATH=${childScript}\n`);
const store = new Store(path.join(directory, "data"));
store.state.settings.workspace = directory;
store.state.settings.allowEdits = true;
store.state.settings.superviseTasks = true;
let notifications = 0;
const manager = new AgentManager(store, () => notifications++);
manager.supervisor.start();
try {
  const first = manager.dispatch("trae", "权限回放", "改文件");
  const deadline = Date.now() + 5000;
  while (manager.running.size && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  const task = manager.task(first.id);
  assert.equal(manager.running.size, 0);
  assert.equal(task.status, "attention");
  assert.equal(task.supervision.state, "attention");
  assert.equal(task.supervision.pending, null);
  assert.equal(task.usage, null);
  assert.equal(notifications, 1);
  manager.supervisor.tick();
  assert.equal(store.state.tasks.length, 1);
  console.log(
    "PASS: actual Coco wrapped denial replay → real child terminates → attention, unknown final usage, one notice, no automatic retry.",
  );
} finally {
  manager.stopAll();
  if (before === undefined) delete process.env.BOBO_ENV_PATH;
  else process.env.BOBO_ENV_PATH = before;
  fs.rmSync(directory, { recursive: true, force: true });
}
