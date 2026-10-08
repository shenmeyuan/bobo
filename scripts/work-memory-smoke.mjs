// Isolated Electron, UI interactions and real local child processes; no model requests.
import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-work-memory-ui-"));
const workspace = path.join(dir, "workspace");
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, "input.txt"), "v1");
const rule = "金额必须采用整数分，不能使用浮点数。".repeat(12);
const cli = path.join(dir, "agent.cjs");
fs.writeFileSync(
  cli,
  `#!/usr/bin/env node
const fs=require('fs'), assert=require('node:assert/strict'); let prompt='';
process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{try {
 fs.appendFileSync('invocations.jsonl', JSON.stringify({prompt})+'\\n');
 if(process.argv.includes('-p')) {
  const packet=JSON.parse(prompt.slice(prompt.indexOf('{"schema_version"')));
  assert.equal(packet.verification.status,'stale');
  assert.equal(packet.verification.checks[0].dependencies[0].freshness,'stale');
  assert.ok(packet.project_memory.some(m=>m.text===${JSON.stringify(rule)} && m.status==='active'));
  assert.ok(packet.memory_checkpoint.processedThrough>0);
 }
 fs.writeFileSync('delivery.txt','done');
 if(process.argv.includes('-p')) console.log(JSON.stringify({type:'result',result:'重新核查输入并交付',usage:{input_tokens:20,output_tokens:10}}));
 else {console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'已交付 delivery.txt'}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:8}}));}
} catch(e){console.error(e.stack);process.exitCode=1;}});
`,
  { mode: 0o700 },
);
const envFile = path.join(dir, ".env");
fs.writeFileSync(
  envFile,
  `BOBO_CODEX_PATH=${cli}\nBOBO_CLAUDE_PATH=${cli}\nBOBO_WORKSPACE=${workspace}\n`,
  { mode: 0o600 },
);
const env = {
  ...process.env,
  BOBO_TEST: "1",
  BOBO_ENV_PATH: envFile,
  BOBO_DATA_DIR: path.join(dir, "data"),
};
for (const key of [
  "ELECTRON_RUN_AS_NODE",
  "BOBO_DEV_URL",
  "OPENAI_API_KEY",
  "MODEL_HUB_AK",
  "OPENAI_BASE_URL",
  "MODEL_HUB_BASE_URL",
  "MODEL_HUB_URL",
])
  delete env[key];
let app;
const errors = [];
const launch = async () => {
  app = await electron.launch({
    executablePath: process.env.BOBO_SMOKE_EXECUTABLE || electronPath,
    args: process.env.BOBO_SMOKE_EXECUTABLE ? [] : [root],
    env,
  });
  app.on("window", (page) =>
    page.on("pageerror", (e) => errors.push(e.message)),
  );
  const page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".pet-name")).toContainText("Bobo");
  return page;
};
try {
  let page = await launch();
  await page.evaluate(() => window.bobo.openHome("settings"));
  await expect.poll(() => app.windows().length).toBe(2);
  const home = app.windows().find((p) => p !== page);
  const memory = home.getByRole("region", { name: "项目记忆" });
  await expect(memory).toBeVisible();
  await memory.getByLabel("新的项目记忆").fill(rule);
  await memory.getByRole("button", { name: "保存项目记忆" }).click();
  await expect(memory).toContainText("1 条有效");
  await page.evaluate(() => window.bobo.newConversation());
  const first = await page.evaluate(() =>
    window.bobo.dispatch(
      "codex",
      "输入依赖测试",
      "交付 delivery.txt，内容必须为 done。",
      {
        checks: [{ kind: "contains", path: "delivery.txt", expected: "done" }],
        maxAttempts: 3,
        tokenLimit: null,
      },
    ),
  );
  const status = (id) =>
    page.evaluate(
      async (id) =>
        (await window.bobo.getState()).tasks.find((t) => t.id === id)?.status,
      id,
    );
  await expect.poll(() => status(first.id)).toBe("completed");
  const invocations = () =>
    fs
      .readFileSync(path.join(workspace, "invocations.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
  expect(invocations()[0].prompt).toContain(rule);
  await page.evaluate((id) => window.bobo.openPetChat(id), first.id);
  const panel = page.getByRole("region", { name: "接续与验收" });
  await expect(panel).toBeVisible();
  await panel.getByText("检查条件与接续预算", { exact: true }).click();
  await panel.getByLabel("输入依赖 1").fill("input.txt\n");
  await panel.getByLabel("交接上下文预算").fill("512");
  await panel.getByRole("button", { name: "保存检查与预算" }).click();
  await panel.getByRole("button", { name: "核查当前产物" }).click();
  await expect(panel).toContainText("所列检查通过");
  fs.writeFileSync(path.join(workspace, "input.txt"), "v2");
  const stale = await page.evaluate(
    (id) => window.bobo.getWorkflow(id),
    first.id,
  );
  expect(stale.verification.status).toBe("stale");
  expect(fs.readFileSync(path.join(workspace, "delivery.txt"), "utf8")).toBe(
    "done",
  );
  await page.evaluate((id) => window.bobo.openPetChat(id), first.id);
  await panel.getByText("让另一个 Agent 接着做", { exact: true }).click();
  await panel.getByLabel("接续 Agent").selectOption("claude");
  await panel.getByRole("button", { name: "带着进展接续" }).click();
  await expect(panel.getByRole("alert")).toContainText("超过交接上下文预算");
  expect(invocations().length).toBe(1);
  await panel.getByLabel("交接上下文预算").fill("8000");
  await panel.getByRole("button", { name: "保存检查与预算" }).click();
  await panel.getByRole("button", { name: "带着进展接续" }).click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.bobo.getState())).tasks[0].status,
    )
    .toBe("completed");
  const latest = (await page.evaluate(() => window.bobo.getState())).tasks[0];
  const report = await page.evaluate(
    (id) => window.bobo.getWorkflow(id),
    latest.id,
  );
  expect(report.verification.status).toBe("passed");
  expect(report.memory.assembly.overTokenTarget).toBe(false);
  await panel.getByText("这项工作的记忆", { exact: true }).click();
  await expect(panel).toContainText("本地估算");
  await expect(panel).toContainText("记忆事件序号");
  await panel.getByText(/本地估算.*Token \/ 交接预算/).scrollIntoViewIfNeeded();
  const screenshot = path.join(root, "work", "work-memory-smoke.png");
  fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot });
  await memory.getByRole("button", { name: "撤下记忆" }).click();
  await expect(memory).toContainText("已撤下");
  await home.screenshot({
    path: path.join(root, "work", "project-memory-smoke.png"),
  });
  await app.close();
  app = null;
  page = await launch();
  const persisted = await page.evaluate(() => window.bobo.getProjectMemory());
  expect(persisted[0].status).toBe("revoked");
  expect(persisted[0].revision).toBe(2);
  await page.evaluate(() => window.bobo.newConversation());
  const next = await page.evaluate(() =>
    window.bobo.dispatch("codex", "新会话", "检查新任务"),
  );
  await expect.poll(() => status(next.id)).toBe("completed");
  expect(invocations().at(-1).prompt).toContain('"status":"revoked"');
  expect(errors).toEqual([]);
  console.log(
    "PASS: project memory UI save → new conversation/local CLI reuse → input-only change invalidates evidence → UI budget prevents spawn → larger budget cross-agent continuation → UI revoke → restart/new task sees revocation; no model calls or renderer errors.",
  );
} finally {
  if (app) await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
