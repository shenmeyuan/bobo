import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = path.resolve(import.meta.dirname, ".."),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-auto-ui-")),
  work = path.join(dir, "work");
fs.mkdirSync(work);
const cli = path.join(dir, "agent.cjs");
fs.writeFileSync(
  cli,
  `#!/usr/bin/env node
const fs=require('fs');let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
 if(process.argv.includes('-p')){
  const kept=prompt.includes('保留全部原始数据');fs.writeFileSync('delivery.json',JSON.stringify({status:kept?'done':'lost correction'}));
  console.log(JSON.stringify({type:'result',result:'delivery.json 已交付',usage:{input_tokens:25,output_tokens:10}}));
 }else{console.log(JSON.stringify({type:'thread.started',thread_id:'original-session'}));console.log(JSON.stringify({type:'turn.failed',error:{message:'429 rate limit exceeded'}}));process.exitCode=1;}
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
  BOBO_TEST: "1",
  BOBO_DATA_DIR: path.join(dir, "data"),
  BOBO_ENV_PATH: envFile,
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
  await page.evaluate(() =>
    window.bobo.setSettings({
      allowEdits: true,
      fallbackAgents: ["codex", "claude"],
    }),
  );
  const first = await page.evaluate(() =>
    window.bobo.dispatch(
      "codex",
      "自动照看实测",
      "交付 delivery.json，status 为 done。",
      {
        checks: [{ kind: "contains", path: "delivery.json", expected: "done" }],
        maxAttempts: 3,
        tokenLimit: null,
      },
    ),
  );
  await page.evaluate((id) => window.bobo.openPetChat(id), first.id);
  const panel = page.getByRole("region", { name: "接续与验收" });
  await expect(panel).toBeVisible();
  await panel.getByText("记住这项工作的纠正", { exact: true }).click();
  await panel.getByLabel("任务纠正").fill("保留全部原始数据");
  await panel.getByRole("button", { name: "记住要求" }).click();
  await expect(panel).toContainText("保留全部原始数据");
  await expect(panel).toContainText("Bobo 正在恢复");
  expect(
    (await page.evaluate(() => window.bobo.getState())).petUI.notice,
  ).toBeNull();
  await expect
    .poll(
      async () => {
        const r = await page.evaluate(
          (id) => window.bobo.getWorkflow(id),
          first.id,
        );
        return r.supervision.state;
      },
      { timeout: 20000 },
    )
    .toBe("done");
  const state = await page.evaluate(() => window.bobo.getState()),
    latest = state.tasks[0];
  expect(state.tasks.length).toBe(2);
  expect(latest.agent).toBe("claude");
  expect(latest.status).toBe("completed");
  expect(state.petUI.notice.taskId).toBe(latest.id);
  await page.evaluate((id) => window.bobo.openPetChat(id), latest.id);
  await expect(panel).toContainText("所列检查通过");
  await expect(panel).toContainText("2 次尝试");
  expect(
    JSON.parse(fs.readFileSync(path.join(work, "delivery.json"))).status,
  ).toBe("done");
  await panel.getByText("照看规则与记录", { exact: true }).click();
  fs.mkdirSync(path.join(root, "work"), { recursive: true });
  await page.screenshot({
    path: path.join(root, "work", "supervisor-smoke.png"),
  });
  const stopped = await page.evaluate(() =>
    window.bobo.dispatch("codex", "停止后不要重启", "无操作"),
  );
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.bobo.getWorkflow(id), stopped.id))
          .supervision.state,
    )
    .toBe("recovering");
  await page.evaluate((id) => window.bobo.cancelTask(id), stopped.id);
  // Poll past the actual scheduler's 10-second retry delay; never ask the worker to resume.
  const until = Date.now() + 12000;
  await expect
    .poll(() => Date.now() >= until, { timeout: 15000, intervals: [1000] })
    .toBe(true);
  expect((await page.evaluate(() => window.bobo.getState())).tasks.length).toBe(
    3,
  );
  expect(errors).toEqual([]);
  console.log(
    "PASS: real CLI subprocess rate limit → automatic cross-agent recovery with saved user correction → deterministic acceptance → one final pet notice; manual stop cancels pending retry; no user resume call and no renderer errors.",
  );
} finally {
  if (app) await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
