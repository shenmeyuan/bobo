// Isolated desktop workflow: local fake CLI, real Node tests, no model requests.
import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createState } from "../electron/state.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-keeper-ui-"));
const workspace = path.join(dir, "workspace"),
  data = path.join(dir, "data"),
  claude = path.join(dir, "claude");
for (const file of [workspace, data, claude]) fs.mkdirSync(file);
const cli = path.join(dir, "codex.cjs");
fs.writeFileSync(
  cli,
  `#!/usr/bin/env node
const readline=require('readline');
if(process.argv.includes('app-server')) readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===1) console.log(JSON.stringify({id:1,result:{}}));if(m.id===2) console.log(JSON.stringify({id:2,result:{data:[{id:'external-codex',name:'界面回归示例会话',cwd:${JSON.stringify(workspace)},status:{type:'notLoaded'},updatedAt:Math.floor(Date.now()/1000)}]}}));});
else {process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'owned-codex'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'交付完成，等待独立测试'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:40,output_tokens:10,cached_input_tokens:25}}));});}
`,
  { mode: 0o700 },
);
fs.writeFileSync(
  path.join(workspace, "delivery.test.mjs"),
  "import assert from 'node:assert/strict'; import fs from 'node:fs'; fs.writeFileSync('test-ran.txt','yes'); assert.equal(2+2,4);",
);
const original = {
  permissions: { allow: ["Read"] },
  hooks: { Stop: [{ hooks: [{ type: "command", command: "echo existing" }] }] },
};
fs.writeFileSync(path.join(claude, "settings.json"), JSON.stringify(original));
const state = createState();
state.settings.workspace = workspace;
fs.writeFileSync(path.join(data, "state.json"), JSON.stringify(state));
const envFile = path.join(dir, ".env");
fs.writeFileSync(
  envFile,
  `BOBO_CODEX_PATH=${cli}\nBOBO_WORKSPACE=${workspace}\n`,
);
const env = {
  ...process.env,
  BOBO_TEST: "1",
  BOBO_ENV_PATH: envFile,
  BOBO_DATA_DIR: data,
  CLAUDE_CONFIG_DIR: claude,
};
for (const key of Object.keys(env))
  if (
    /^(?:OPENAI_|MODEL_HUB_|AZURE_OPENAI_)/.test(key) ||
    ["ELECTRON_RUN_AS_NODE", "BOBO_DEV_URL"].includes(key)
  )
    delete env[key];
let app;
const errors = [];
try {
  app = await electron.launch({
    executablePath: process.env.BOBO_SMOKE_EXECUTABLE || electronPath,
    args: process.env.BOBO_SMOKE_EXECUTABLE ? [] : [root],
    env,
  });
  app.on("window", (p) => p.on("pageerror", (e) => errors.push(e.message)));
  const pet = await app.firstWindow();
  pet.on("pageerror", (e) => errors.push(e.message));
  await expect(pet.locator(".pet-name")).toContainText("Bobo");
  await pet.evaluate(() => window.bobo.openHome("settings"));
  await expect.poll(() => app.windows().length).toBe(2);
  const home = app.windows().find((p) => p !== pet);
  const observer = home.getByRole("region", { name: "外部会话观察" });
  await expect(observer).toBeVisible();
  await observer.getByLabel("观察 Codex", { exact: true }).click();
  await expect(
    observer.getByLabel("观察 Codex", { exact: true }),
  ).toBeChecked();
  await expect(observer).toContainText("界面回归示例会话");
  await expect(observer).toContainText("实时状态未知");
  await observer.getByLabel("观察 Claude Code", { exact: true }).click();
  await expect(
    observer.getByLabel("观察 Claude Code", { exact: true }),
  ).toBeChecked();
  await expect
    .poll(
      () =>
        JSON.parse(fs.readFileSync(path.join(claude, "settings.json"))).hooks
          .Stop.length,
    )
    .toBe(2);
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(data, "bobo-session-observer.cjs"),
        path.join(data, "session-events"),
      ],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error("hook failed")),
    );
    child.stdin.end(
      JSON.stringify({
        session_id: "external-cc",
        cwd: workspace,
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
        prompt: "must-not-be-stored",
      }),
    );
  });
  await expect(observer).toContainText("等待你处理");
  if (process.env.BOBO_KEEPER_CAPTURE_DIR) {
    fs.mkdirSync(process.env.BOBO_KEEPER_CAPTURE_DIR, { recursive: true });
    await observer.screenshot({
      path: path.join(process.env.BOBO_KEEPER_CAPTURE_DIR, "bobo-observer.png"),
    });
  }
  const task = await pet.evaluate(() =>
    window.bobo.getState().then((requestState) =>
      window.bobo.dispatch(
        "codex",
        "可执行验收示例",
        "交付已有的 delivery.test.mjs",
        {
          checks: [
            { kind: "node_test", path: "delivery.test.mjs", expected: "" },
          ],
          tokenLimit: null,
          maxAttempts: 3,
          maxDurationMinutes: 10,
        },
        {
          conversationId: requestState.activeConversationId,
          scope: requestState.conversationContext.scope,
          allowEdits: requestState.settings.allowEdits,
        },
      ),
    ),
  );
  await expect
    .poll(
      async () =>
        (await pet.evaluate((id) => window.bobo.getWorkflow(id), task.id))
          .verification?.status,
    )
    .toBe("needs_recheck");
  if (fs.existsSync(path.join(workspace, "test-ran.txt")))
    throw new Error("automatic checks executed code");
  await pet.evaluate((id) => window.bobo.openPetChat(id), task.id);
  const workflow = pet.getByRole("region", { name: "接续与验收" });
  await expect(workflow).toBeVisible();
  await workflow
    .getByRole("button", { name: "运行所列测试（执行项目代码）" })
    .click();
  await expect(workflow).toContainText("所列检查通过");
  if (fs.readFileSync(path.join(workspace, "test-ran.txt"), "utf8") !== "yes")
    throw new Error("test did not execute");
  await workflow.getByText("任务用量账本", { exact: true }).click();
  await expect(workflow).toContainText("40 输入 + 10 输出 Token");
  await expect(workflow).toContainText("缓存读取 25");
  if (process.env.BOBO_KEEPER_CAPTURE_DIR) {
    await pet.evaluate(() => window.bobo.openHome("agents"));
    await home
      .locator(".task-row")
      .filter({ hasText: "可执行验收示例" })
      .click();
    const detail = home.getByRole("region", { name: "接续与验收" });
    await detail.getByText("任务用量账本", { exact: true }).click();
    await detail.locator(".usage-ledger-row").scrollIntoViewIfNeeded();
    await home.screenshot({
      path: path.join(
        process.env.BOBO_KEEPER_CAPTURE_DIR,
        "bobo-task-ledger.png",
      ),
    });
    await home.getByRole("button", { name: "关闭弹窗" }).click();
    await pet.evaluate(() => window.bobo.openHome("settings"));
  }
  await observer.getByLabel("观察 Claude Code", { exact: true }).click();
  await expect(
    observer.getByLabel("观察 Claude Code", { exact: true }),
  ).not.toBeChecked();
  await expect
    .poll(() =>
      JSON.stringify(
        JSON.parse(fs.readFileSync(path.join(claude, "settings.json"))),
      ),
    )
    .toBe(JSON.stringify(original));
  const saved = JSON.stringify(
    JSON.parse(fs.readFileSync(path.join(data, "state.json"))),
  );
  if (saved.includes("must-not-be-stored"))
    throw new Error("private hook content persisted");
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "PASS: observer settings and cleanup, protocol-only Codex discovery, CC metadata and waiting state, manual real Node tests, task ledger, no model calls",
  );
} finally {
  if (app) await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
