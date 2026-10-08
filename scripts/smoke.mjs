import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
const root = path.resolve(import.meta.dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-desktop-smoke-"));
const work = path.join(root, "work");
fs.mkdirSync(work, { recursive: true });
const envFile = path.join(temporary, ".env");
const fakeCli = path.join(temporary, "fake-agent.cjs");
fs.writeFileSync(
  fakeCli,
  `#!/usr/bin/env node\nlet input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{if(input.includes('WAIT'))return setTimeout(()=>process.exit(0),20000); console.log(JSON.stringify({type:'thread.started',thread_id:'smoke-session'})); setTimeout(()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'已完成：这是本地测试 Agent 返回的真实进程结果。'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:8}}));},350);});\n`,
  { mode: 0o700 },
);
let requestCount = 0;
const provider = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    requestCount++;
    const input = JSON.parse(body);
    const hasOutput = input.input.some(
      (item) => item.type === "function_call_output",
    );
    const output = hasOutput
      ? [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "已经交给 Codex 了，结果会出现在任务面板。",
                annotations: [],
              },
            ],
          },
        ]
      : [
          {
            type: "function_call",
            call_id: "smoke-call",
            name: "dispatch_task",
            arguments: JSON.stringify({
              agent: "codex",
              title: "对话派发测试",
              prompt: "请返回一条测试结果。",
            }),
          },
        ];
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: `resp_smoke_${requestCount}`,
        object: "response",
        status: "completed",
        model: input.model,
        output,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
    );
  });
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const port = provider.address().port;
fs.writeFileSync(
  envFile,
  `OPENAI_API_KEY=sk-smoke-fake-local-only\nOPENAI_MODEL=gpt-5.6-sol\nOPENAI_BASE_URL=http://127.0.0.1:${port}/v1\nBOBO_CODEX_PATH=${fakeCli}\nBOBO_CLAUDE_PATH=${fakeCli}\nBOBO_WORKSPACE=${temporary}\n`,
);
const env = {
  ...process.env,
  BOBO_TEST: "1",
  BOBO_DATA_DIR: path.join(temporary, "data"),
  BOBO_ENV_PATH: envFile,
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.BOBO_DEV_URL;
let desktop;
const errors = [];
try {
  desktop = await electron.launch({
    executablePath: electronPath,
    args: [root],
    env,
  });
  const pet = await desktop.firstWindow();
  pet.setDefaultTimeout(10000);
  pet.on("pageerror", (error) => errors.push(error.message));
  await expect(pet.locator(".pet-name")).toContainText("Bobo");
  expect(desktop.windows().length).toBe(1);
  expect(
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getSize(),
    ),
  ).toEqual([300, 340]);
  expect(
    await pet.evaluate(
      () => getComputedStyle(document.documentElement).backgroundColor,
    ),
  ).toBe("rgba(0, 0, 0, 0)");
  const initial = await pet.evaluate(() => window.bobo.getState());
  if (JSON.stringify(initial).includes("sk-smoke"))
    throw new Error("Key leaked to renderer");
  // Click painted pixels of the seed's pot. This also exercises pointer capture.
  await pet.locator(".pet-drag").click({ position: { x: 115, y: 181 } });
  await expect(
    pet.getByRole("region", { name: "Bobo 对话气泡" }),
  ).toBeVisible();
  expect(
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getSize(),
    ),
  ).toEqual([400, 650]);
  await pet.getByRole("button", { name: "打开操作菜单" }).click();
  await pet.getByRole("button", { name: "预览成年形象" }).click();
  await expect(pet.locator(".bobo-plush.adult")).toBeVisible();
  await expect(pet.locator(".pet-actions-menu")).toHaveCount(0);
  const ageDuringPreview = (await pet.evaluate(() => window.bobo.getState()))
    .pet.companionMs;
  expect(ageDuringPreview).toBeLessThan(60000);
  const hit = await pet.locator(".pet-drag").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      outside: Boolean(
        document.elementFromPoint(r.x + 3, r.y + 3)?.closest(".pet-hit"),
      ),
      inside: Boolean(
        document
          .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
          ?.closest(".pet-hit"),
      ),
    };
  });
  expect(hit).toEqual({ outside: false, inside: true });
  await pet.getByRole("button", { name: "和 Bobo 说话", exact: true }).click();
  await expect(pet.locator(".pet-conversation")).toHaveCount(0);
  await pet.getByRole("button", { name: "和 Bobo 说话", exact: true }).click();
  await pet
    .getByRole("button", { name: "成年预览 · 返回当前", exact: true })
    .click();
  await expect(pet.locator(".bobo-plush")).toHaveCount(0);
  await pet.getByRole("button", { name: "打开操作菜单" }).click();
  await pet.getByRole("button", { name: "浇水", exact: true }).click();
  const watered = await pet.evaluate(() => window.bobo.getState());
  expect(watered.pet.hydration).toBeGreaterThan(initial.pet.hydration);
  await expect(pet.getByRole("status")).toContainText("喝饱了");
  await pet
    .getByRole("textbox", { name: "告诉 Bobo" })
    .fill("请交给 Codex 返回一条测试结果。");
  await pet.getByRole("button", { name: "发送消息" }).click();
  await expect(pet.locator(".bubble-message.assistant").last()).toContainText(
    "已经交给 Codex",
    { timeout: 15000 },
  );
  expect(requestCount).toBe(2);
  await pet.getByRole("button", { name: "查看任务", exact: true }).click();
  await expect(pet.locator(".bubble-task-row").first()).toContainText(
    "执行结束",
  );
  await pet.locator(".bubble-task-row").first().click();
  await expect(pet.locator(".bubble-task-detail")).toContainText(
    "本地测试 Agent 返回",
  );
  await pet.screenshot({
    path: path.join(work, "pet-chat.png"),
    omitBackground: true,
  });
  await pet.getByRole("button", { name: "查看任务", exact: true }).click();
  await pet.getByRole("button", { name: "打开操作菜单" }).click();
  await pet.getByLabel("交互方式").selectOption("codex");
  await pet.getByRole("textbox", { name: "告诉 Bobo" }).fill("直接派发测试");
  await pet.getByRole("button", { name: "发送消息" }).click();
  await expect(pet.locator(".bubble-task-detail")).toContainText("执行结束");
  await pet.getByRole("button", { name: "查看任务", exact: true }).click();
  await pet.getByRole("button", { name: "打开操作菜单" }).click();
  await pet.getByLabel("交互方式").selectOption("doubao");
  await pet
    .getByRole("textbox", { name: "告诉 Bobo" })
    .fill("想三个胡萝卜名字");
  await pet.getByRole("button", { name: "发送消息" }).click();
  await expect(pet.locator(".bubble-task-detail")).toContainText("待手动转交");
  await pet.getByRole("textbox", { name: "豆包结果" }).fill("小萝、圆圆、叶叶");
  await pet.getByRole("button", { name: "记录完成" }).click();
  await expect(pet.locator(".bubble-task-detail")).toContainText(
    "小萝、圆圆、叶叶",
  );
  const stopped = await pet.evaluate(() =>
    window.bobo.dispatch("codex", "停止测试", "WAIT"),
  );
  await pet.evaluate((id) => window.bobo.openPetChat(id), stopped.id);
  await pet.getByRole("button", { name: "停止任务" }).click();
  await expect(pet.locator(".bubble-task-detail")).toContainText("已停止");
  await pet.getByRole("button", { name: "查看任务", exact: true }).click();
  await pet.getByRole("textbox", { name: "告诉 Bobo" }).fill("还没发送的草稿");
  await pet.getByRole("button", { name: "收起对话气泡" }).click();
  await expect(pet.locator(".pet-conversation")).toHaveCount(0);
  expect(
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getSize(),
    ),
  ).toEqual([300, 340]);
  await pet.locator(".pet-drag").click({ position: { x: 115, y: 181 } });
  await expect(pet.getByRole("textbox", { name: "告诉 Bobo" })).toHaveValue(
    "还没发送的草稿",
  );
  expect(desktop.windows().length).toBe(1);
  await pet.evaluate((id) => window.bobo.openPetChat(id), stopped.id);
  await expect(pet.locator(".bubble-task-detail")).toContainText("已停止");
  await pet.getByRole("button", { name: "查看任务", exact: true }).click();
  await pet.evaluate((id) => window.bobo.openPetChat(id), stopped.id);
  await expect(pet.locator(".bubble-task-detail")).toContainText("已停止");
  await pet.evaluate(() => window.bobo.openPetChat());
  await expect(pet.getByRole("textbox", { name: "告诉 Bobo" })).toBeVisible();
  const homePromise = desktop.waitForEvent("window");
  await pet.getByRole("button", { name: "打开操作菜单" }).click();
  await pet.getByRole("button", { name: "打开偏好设置" }).click();
  const home = await homePromise;
  home.on("pageerror", (error) => errors.push(error.message));
  await expect(
    home.getByRole("heading", { name: "Bobo 的大脑" }),
  ).toBeVisible();
  await expect(home.locator(".chat-panel")).toHaveCount(0);
  await expect(home.locator(".usage-grid")).toContainText("20");
  await home.getByRole("switch", { name: "安静模式" }).click();
  await pet.evaluate(() => window.bobo.openHome("agents"));
  await expect(home.getByRole("heading", { name: "Agent 记录" })).toBeVisible();
  await home.getByRole("button", { name: "记录 Codex 额度" }).click();
  await home.getByRole("spinbutton").fill("65");
  await home.getByRole("button", { name: "记下来", exact: true }).click();
  await expect(home.locator(".agent-card.codex")).toContainText("65%");
  await pet.evaluate(() => window.bobo.openHome("diary"));
  await expect(home.locator(".diary-timeline")).toContainText("今天的第一口水");
  await home.locator(".nav-item").filter({ hasText: "成长档案" }).click();
  await home.getByRole("button", { name: /老年期/ }).click();
  await expect(home.locator(".growth-preview")).toContainText("老年期");
  await home.evaluate(() => window.bobo.closeWindow());
  expect(
    await desktop.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
    ),
  ).toBe(1);
  const final = await pet.evaluate(() => window.bobo.getState());
  expect(final.tasks.filter((t) => t.status === "completed").length).toBe(3);
  expect(errors).toEqual([]);
  console.log(
    "PASS: desktop-only startup, painted pet click, bubble resizing, care, conversation and tool dispatch, direct CLI task, inline results, handoff, cancellation, draft preservation, lazy settings and records, shared state; no renderer errors.",
  );
  await desktop.close();
  desktop = null;
  desktop = await electron.launch({
    executablePath: electronPath,
    args: [root],
    env,
  });
  const second = await desktop.firstWindow();
  await expect(second.locator(".pet-name")).toContainText("Bobo");
  expect(desktop.windows().length).toBe(1);
  const restored = await second.evaluate(() => window.bobo.getState());
  expect(restored.tasks.length).toBe(4);
  expect(restored.quotas.codex.remainingPercent).toBe(65);
  expect(restored.pet.careCounts.water).toBe(1);
  expect(restored.settings.quiet).toBe(true);
  expect(restored.messages.length).toBe(2);
  expect(restored.petUI.expanded).toBe(false);
  console.log(
    "PASS: pet, conversation, tasks, quota and preferences survive restart; bubble starts collapsed.",
  );
} finally {
  await desktop?.close();
  await new Promise((resolve) => provider.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
}
