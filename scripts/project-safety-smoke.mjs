// One isolated UI flow: synthetic legacy state, no keys and no executor processes.
import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createState } from "../electron/state.mjs";
const root = path.resolve(import.meta.dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-project-safety-ui-"));
const a = path.join(dir, "A"),
  b = path.join(dir, "B"),
  data = path.join(dir, "data");
for (const folder of [a, b, data]) fs.mkdirSync(folder);
const envFile = path.join(dir, ".env");
fs.writeFileSync(envFile, "OPENAI_API_KEY=\nMODEL_HUB_AK=\nBOBO_WORKSPACE=\n");
const state = createState();
state.settings.workspace = a;
state.settings.fallbackAgents = ["codex", "claude", "trae"];
delete state.settings.fallbackPolicy;
state.messages = [
  { id: "mixed-legacy", role: "user", content: "旧 A/B 混合历史", at: 1 },
];
fs.writeFileSync(path.join(data, "state.json"), JSON.stringify(state));
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
  "BOBO_WORKSPACE",
  "OPENAI_BASE_URL",
  "MODEL_HUB_BASE_URL",
  "MODEL_HUB_URL",
])
  delete env[key];
let app;
const errors = [];
async function launch() {
  app = await electron.launch({
    executablePath: electronPath,
    args: [root],
    env,
  });
  app.on("window", (page) =>
    page.on("pageerror", (e) => errors.push(e.message)),
  );
  const pet = await app.firstWindow();
  pet.on("pageerror", (e) => errors.push(e.message));
  await expect(pet.locator(".bobo-art")).toBeVisible();
  await pet.evaluate(() => window.bobo.openPetChat());
  return pet;
}
try {
  let pet = await launch();
  const legacyId = (await pet.evaluate(() => window.bobo.getState()))
    .activeConversationId;
  await expect(pet.getByRole("textbox", { name: "告诉 Bobo" })).toBeDisabled();
  await expect(pet.locator(".bubble-messages")).toContainText(
    "旧 A/B 混合历史",
  );
  await pet.evaluate(() => window.bobo.openHome("settings"));
  await expect.poll(() => app.windows().length).toBe(2);
  const home = app.windows().find((p) => p !== pet);
  const policyCard = home
    .locator(".settings-card")
    .filter({ has: home.getByRole("heading", { name: "让 Bobo 照看工作" }) });
  await expect(policyCard).toContainText("旧接手名单缺少明确授权记录");
  const checkboxes = policyCard.getByRole("checkbox");
  await expect(checkboxes).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(checkboxes.nth(i)).not.toBeChecked();
  await expect(policyCard.getByLabel("新任务接手政策")).toContainText(
    "仅原工具",
  );
  await policyCard.getByLabel("Claude Code", { exact: true }).click();
  await expect(policyCard.getByLabel("Claude Code", { exact: true })).toBeChecked();
  await expect
    .poll(
      async () =>
        (await pet.evaluate(() => window.bobo.getState())).settings
          .fallbackPolicy.source,
    )
    .toBe("user_ui");
  await policyCard.getByRole("button", { name: "知道了" }).click();
  await pet.getByRole("button", { name: "打开操作菜单", exact: true }).click();
  await pet.getByLabel("交互方式").selectOption("codex");
  await expect(pet.getByLabel("新任务接手政策")).toContainText("Claude Code");
  await pet.getByRole("button", { name: "打开操作菜单", exact: true }).click();
  await pet.getByLabel("交互方式").selectOption("chat");
  await pet
    .getByRole("button", { name: "在当前项目新建对话", exact: true })
    .click();
  const input = pet.getByRole("textbox", { name: "告诉 Bobo" });
  await expect(input).toBeEnabled();
  await input.fill("A-only-request");
  await pet.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(pet.locator(".bubble-message.assistant")).toHaveCount(1);
  const aId = (await pet.evaluate(() => window.bobo.getState()))
    .activeConversationId;
  const staleContext = await pet.evaluate(async () => {
    const s = await window.bobo.getState();
    return {
      conversationId: s.activeConversationId,
      scope: s.conversationContext.scope,
      allowEdits: s.settings.allowEdits,
    };
  });
  await input.fill("A-unsent-draft");
  const chooseWorkspace = async (workspace) => {
    await app.evaluate(({ dialog }, workspace) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [workspace],
      });
    }, workspace);
    await home.evaluate(() => window.bobo.pickWorkspace());
  };
  await chooseWorkspace(b);
  await expect(input).toHaveValue("");
  await expect(pet.locator(".bubble-message.user")).toHaveCount(0);
  await input.fill("B-only-request");
  await pet.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(pet.locator(".bubble-message.user")).toContainText(
    "B-only-request",
  );
  const stale = await pet.evaluate(async (context) => {
    const errors = [];
    for (const call of [
      () => window.bobo.chat("stale A input", context),
      () =>
        window.bobo.dispatch(
          "codex",
          "stale",
          "stale A work",
          undefined,
          context,
        ),
    ]) {
      try {
        await call();
        errors.push("unexpected success");
      } catch (e) {
        errors.push(e.message);
      }
    }
    return { errors, state: await window.bobo.getState() };
  }, staleContext);
  expect(stale.errors.every((message) => message.includes("已改变"))).toBe(
    true,
  );
  expect(stale.state.tasks).toHaveLength(0);
  expect(stale.state.messages.map((m) => m.content).join("\n")).not.toContain(
    "stale A",
  );
  await pet.getByRole("button", { name: "历史会话", exact: true }).click();
  const aHistory = pet
    .locator(".bubble-conversation-row")
    .filter({ hasText: "A-only-request" });
  await expect(aHistory).toContainText(a);
  await aHistory.click();
  await expect(input).toBeDisabled();
  await expect(input).toHaveValue("A-unsent-draft");
  await expect(pet.locator(".bubble-messages")).not.toContainText(
    "B-only-request",
  );
  expect((await pet.evaluate(() => window.bobo.getState())).workspace).toBe(b);
  await chooseWorkspace(a);
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("A-unsent-draft");
  expect(
    (await pet.evaluate(() => window.bobo.getState())).activeConversationId,
  ).toBe(aId);
  // Delay an isolated transport failure so the renderer changes projects in flight.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("bobo:chat");
    ipcMain.handle("bobo:chat", async () => {
      await new Promise((resolve) => {
        globalThis.releaseChatFailure = resolve;
      });
      throw new Error("mock A send failed");
    });
  });
  await input.fill("A-delayed-failure-draft");
  await pet.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect
    .poll(() => app.evaluate(() => Boolean(globalThis.releaseChatFailure)))
    .toBe(true);
  await chooseWorkspace(b);
  await expect(input).toHaveValue("");
  await input.fill("B-preserved-draft");
  await app.evaluate(() => globalThis.releaseChatFailure());
  await expect(
    pet.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeEnabled();
  await expect(input).toHaveValue("B-preserved-draft");
  await expect(pet.locator(".bubble-error").filter({ hasText: "mock A send failed" })).toHaveCount(0);
  await chooseWorkspace(a);
  await expect(input).toHaveValue("A-delayed-failure-draft");
  await chooseWorkspace(b);
  await expect(input).toHaveValue("B-preserved-draft");
  await chooseWorkspace(a);
  await app.close();
  app = null;
  pet = await launch();
  const restored = await pet.evaluate(() => window.bobo.getState());
  expect(restored.settings.fallbackAgents).toEqual(["claude"]);
  expect(restored.settings.fallbackPolicy.source).toBe("user_ui");
  expect(restored.settings.fallbackMigration.dismissed).toBe(true);
  expect(restored.activeConversationId).toBe(aId);
  await pet.evaluate((id) => window.bobo.selectConversation(id), legacyId);
  await expect(pet.getByRole("textbox", { name: "告诉 Bobo" })).toBeDisabled();
  await expect(pet.locator(".bubble-messages")).toContainText(
    "旧 A/B 混合历史",
  );
  expect(errors).toEqual([]);
  console.log(
    "PASS: legacy policies reset with dismissible notice → explicit UI grant survives restart; legacy history read-only → new scoped A chat → directory B starts clean → A history remains read-only in B → returning to A restores isolated draft; no model or executor calls, no renderer errors.",
  );
} finally {
  await app?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
