// Publishable screenshots from an isolated demo. Never load real env or userData.
import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../electron/store.mjs";
import { DAY } from "../electron/pet.mjs";
import { saveProjectMemory } from "../electron/work-memory.mjs";

const root = path.resolve(import.meta.dirname, "..");
const output =
  process.env.BOBO_PRODUCT_IMAGES || path.join(root, "docs", "images");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-product-demo-"));
const data = path.join(temp, "data"),
  workspace = path.join(temp, "workspace");
const envFile = path.join(temp, ".env"),
  cli = path.join(temp, "demo-agent.cjs");
const previousEnv = process.env.BOBO_ENV_PATH;
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(workspace);
fs.writeFileSync(
  path.join(workspace, "input.csv"),
  "name,amount_cents\nAlice,1200\nBob,2400\n",
);
fs.writeFileSync(
  cli,
  `#!/usr/bin/env node
const fs=require('fs');process.stdin.resume();process.stdin.on('end',()=>{
fs.writeFileSync('summary.json',JSON.stringify({rows:2,total_cents:3600}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'本地演示执行器生成 summary.json。文件条件已由 Bobo 独立核查；此为界面演示，不代表真实模型能力评测。'}}));
});
`,
  { mode: 0o700 },
);
fs.writeFileSync(
  envFile,
  `OPENAI_API_KEY=\nMODEL_HUB_AK=\nBOBO_CODEX_PATH=${cli}\nBOBO_WORKSPACE=${workspace}\n`,
  { mode: 0o600 },
);
process.env.BOBO_ENV_PATH = envFile;
const store = new Store(data);
store.state.pet.companionMs = 40 * DAY;
store.state.pet.bornAt -= 40 * DAY;
store.state.settings.workspace = workspace;
store.state.settings.superviseTasks = false;
store.message("user", "Bobo，今天一起做个小项目吧。");
store.message(
  "assistant",
  "好呀，我在这里陪你 🥕\n需要帮忙时把任务交给我；休息一下，也可以点「＋」浇水、摸摸我。",
);
saveProjectMemory(store, workspace, {
  text: "保留原始数据；导出的金额统一使用整数分。",
  kind: "feedback",
  source: { kind: "user_ui" },
});
const env = {
  ...process.env,
  BOBO_TEST: "1",
  BOBO_DATA_DIR: data,
  BOBO_ENV_PATH: envFile,
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
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [root],
    env,
  });
  const errors = [];
  app.on("window", (page) =>
    page.on("pageerror", (error) => errors.push(error.message)),
  );
  const pet = await app.firstWindow();
  await expect(pet.locator(".bobo-art.adult")).toBeVisible();
  await pet.screenshot({
    path: path.join(output, "desktop-idle.png"),
    omitBackground: true,
  });
  await pet.evaluate(() => window.bobo.openPetChat());
  await expect(
    pet.getByRole("region", { name: "Bobo 对话气泡" }),
  ).toBeVisible();
  await expect(pet.locator(".bubble-message.assistant")).toContainText(
    "我在这里陪你",
  );
  await pet.screenshot({
    path: path.join(output, "desktop-chat.png"),
    omitBackground: true,
  });

  const job = await pet.evaluate(() =>
    window.bobo.dispatch(
      "codex",
      "CSV 汇总 · 演示任务",
      "汇总 input.csv，交付 summary.json；保留原始数据，金额使用整数分。",
      {
        checks: [
          {
            kind: "json",
            path: "summary.json",
            expected: "",
            dependencies: ["input.csv"],
          },
        ],
        maxAttempts: 3,
        tokenLimit: null,
      },
    ),
  );
  await expect
    .poll(
      async () =>
        (await pet.evaluate(() => window.bobo.getState())).tasks.find(
          (t) => t.id === job.id,
        )?.status,
    )
    .toBe("completed");
  fs.appendFileSync(path.join(workspace, "input.csv"), "Carol,600\n");
  await pet.evaluate((id) => window.bobo.getWorkflow(id), job.id);
  await pet.evaluate((id) => window.bobo.openPetChat(id), job.id);
  const panel = pet.getByRole("region", { name: "接续与验收" });
  await expect(panel).toContainText("文件有变动，旧检查已过期");
  await panel.getByText("这项工作的记忆", { exact: true }).click();
  await panel.getByText(/本地估算.*Token \/ 交接预算/).scrollIntoViewIfNeeded();
  await pet.screenshot({
    path: path.join(output, "task-memory.png"),
    omitBackground: true,
  });
  await panel
    .getByText("文件有变动，旧检查已过期", { exact: true })
    .scrollIntoViewIfNeeded();
  await pet.screenshot({
    path: path.join(output, "task-verification.png"),
    omitBackground: true,
  });

  const homeReady = app.waitForEvent("window");
  await pet.evaluate(() => window.bobo.openHome("growth"));
  const home = await homeReady;
  await expect(home.locator(".growth-road")).toBeVisible();
  await home
    .locator(".growth-road button")
    .filter({ hasText: "成年期" })
    .click();
  await home.screenshot({ path: path.join(output, "growth.png") });
  await pet.evaluate(() => window.bobo.openHome("settings"));
  const memory = home.getByRole("region", { name: "项目记忆" });
  await expect(memory).toContainText("保留原始数据");
  await memory.screenshot({ path: path.join(output, "project-memory.png") });
  expect(errors).toEqual([]);
  console.log(
    "Saved six actual app screenshots with isolated demo data; no real configuration, account usage or model calls.",
  );
} finally {
  await app?.close();
  if (previousEnv === undefined) delete process.env.BOBO_ENV_PATH;
  else process.env.BOBO_ENV_PATH = previousEnv;
  fs.rmSync(temp, { recursive: true, force: true });
}
