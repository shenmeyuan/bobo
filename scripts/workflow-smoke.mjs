import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = path.resolve(import.meta.dirname, ".."),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-flow-ui-"));
const work = path.join(dir, "workspace");
fs.mkdirSync(work);
const cli = path.join(dir, "agent.cjs");
fs.writeFileSync(
  cli,
  `#!/usr/bin/env node
const fs=require('fs');let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{
 const resume=prompt.includes('schema_version');
 fs.writeFileSync('delivery.json',JSON.stringify({status:resume?'done':'partial'}));
 if(process.argv.includes('-p')) console.log(JSON.stringify({type:'result',result:'已接续并交付 delivery.json',usage:{input_tokens:20,output_tokens:10}}));
 else {console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'已有 delivery.json，尚未完成。'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:8}}));}
 process.exit(resume?0:1);
});`,
  { mode: 0o700 },
);
const envFile = path.join(dir, ".env");
fs.writeFileSync(
  envFile,
  `BOBO_CODEX_PATH=${cli}\nBOBO_CLAUDE_PATH=${cli}\nBOBO_WORKSPACE=${work}\n`,
);
const env = {
  ...process.env,
  BOBO_ENV_PATH: envFile,
  BOBO_DATA_DIR: path.join(dir, "data"),
  BOBO_TEST: "1",
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.BOBO_DEV_URL;
let app;
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [root],
    env,
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".pet-name")).toContainText("Bobo");
  const first = await page.evaluate(() =>
    window.bobo.dispatch(
      "codex",
      "交接与验收测试",
      "完成 delivery.json，status 必须为 done。",
    ),
  );
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.bobo.getState())).tasks.find(
          (t) => t.id === first.id,
        )?.status,
    )
    .toBe("failed");
  await page.evaluate((id) => window.bobo.openPetChat(id), first.id);
  const panel = page.getByRole("region", { name: "接续与验收" }); // section with accessible name
  await expect(panel).toBeVisible();
  await panel.getByText("检查条件与接续预算", { exact: true }).click();
  await panel.getByRole("button", { name: "添加文件检查" }).click();
  await panel.getByLabel("产物路径 1").fill("delivery.json");
  await panel.getByLabel("检查类型 1").selectOption("contains");
  await panel.getByLabel("预期内容 1").fill("done");
  await panel.getByRole("button", { name: "保存检查与预算" }).click();
  await panel.getByRole("button", { name: "核查当前产物" }).click();
  await expect(panel).toContainText("有检查未通过");
  await panel.getByText("让另一个 Agent 接着做", { exact: true }).click();
  await panel.getByLabel("接续 Agent").selectOption("claude");
  await panel.getByLabel("接续说明").fill("继续处理尚未完成的 status 字段。");
  await panel.getByRole("button", { name: "带着进展接续" }).click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.bobo.getState())).tasks[0]?.status,
    )
    .toBe("completed");
  await expect(panel).toContainText("2 次尝试");
  await panel.getByRole("button", { name: "核查当前产物" }).click();
  await expect(panel).toContainText("所列检查通过");
  await expect(panel).toContainText("50 Token");
  const state = await page.evaluate(() => window.bobo.getState());
  const report = await page.evaluate(
    (id) => window.bobo.getWorkflow(id),
    state.tasks[0].id,
  );
  expect(report.attempts.length).toBe(2);
  expect(report.verification.checks[0].sha256).toBeTruthy();
  expect(state.tasks[0].allowEdits).toBe(false);
  expect(errors).toEqual([]);
  const dest =
    process.env.BOBO_WORKFLOW_SCREENSHOT ||
    path.join(root, "work", "workflow-smoke.png");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await page.screenshot({ path: dest });
  await app.close();
  app = null;
  app = await electron.launch({
    executablePath: electronPath,
    args: [root],
    env,
  });
  const reopened = await app.firstWindow();
  await expect(reopened.locator(".pet-name")).toContainText("Bobo");
  const persisted = await reopened.evaluate(
    (id) => window.bobo.getWorkflow(id),
    state.tasks[0].id,
  );
  expect(persisted.usage.total).toBe(50);
  expect(persisted.verification.status).toBe("passed");
  console.log(
    "PASS: actual subprocess failure → Codex-to-Claude handoff → file verification failure/pass → 50-token attempt total → restart persistence; no renderer errors.",
  );
} finally {
  if (app) await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
