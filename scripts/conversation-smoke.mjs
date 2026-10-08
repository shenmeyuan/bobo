import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const output =
  process.env.BOBO_SCREENSHOT_DIR || path.join(root, "work", "screenshots");
fs.mkdirSync(output, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-chats-"));
const envFile = path.join(temporary, ".env");
fs.writeFileSync(envFile, "OPENAI_API_KEY=\nMODEL_HUB_AK=\n");
const env = {
  ...process.env,
  OPENAI_API_KEY: "",
  MODEL_HUB_AK: "",
  BOBO_TEST: "1",
  BOBO_DATA_DIR: path.join(temporary, "data"),
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
  const pet = await app.firstWindow();
  await expect(pet.locator(".bobo-art")).toBeVisible();
  expect(
    (await pet.evaluate(() => window.bobo.getState())).brain.configured,
  ).toBe(false);
  await pet.evaluate(() => window.bobo.openPetChat());
  await pet
    .getByRole("textbox", { name: "告诉 Bobo" })
    .fill("第一段：检查 SQL");
  await pet.getByRole("button", { name: "发送消息" }).click();
  await expect(pet.locator(".bubble-message.assistant")).toHaveCount(1);
  await expect(pet.locator(".bobo-art")).toHaveAttribute(
    "data-activity",
    "speaking",
  );
  const first = (await pet.evaluate(() => window.bobo.getState()))
    .activeConversationId;
  await pet
    .getByRole("textbox", { name: "告诉 Bobo" })
    .fill("第一段未发送的草稿");
  await pet.getByRole("button", { name: "新建对话", exact: true }).click();
  await expect(pet.getByRole("textbox", { name: "告诉 Bobo" })).toHaveValue("");
  await pet
    .getByRole("textbox", { name: "告诉 Bobo" })
    .fill("第二段：整理周报");
  await pet.getByRole("button", { name: "发送消息" }).click();
  await expect(pet.locator(".bubble-message.user")).toHaveCount(1);
  await pet.getByRole("button", { name: "历史会话", exact: true }).click();
  await expect(pet.locator(".bubble-conversation-row")).toHaveCount(2);
  await pet.getByRole("textbox", { name: "搜索历史会话" }).fill("SQL");
  await expect(pet.locator(".bubble-conversation-row")).toHaveCount(1);
  await pet.screenshot({
    path: path.join(output, "Bobo-历史会话.png"),
    omitBackground: true,
  });
  await pet.locator(".bubble-conversation-row").click();
  await expect(pet.getByRole("textbox", { name: "告诉 Bobo" })).toHaveValue(
    "第一段未发送的草稿",
  );
  await expect(pet.locator(".bubble-message.user")).toContainText("检查 SQL");
  expect(
    (await pet.evaluate(() => window.bobo.getState())).activeConversationId,
  ).toBe(first);
  const leaves = pet.locator(".bobo-leaf-motion");
  const before = await leaves.getAttribute("style");
  await pet.waitForTimeout(300);
  expect(await leaves.getAttribute("style")).not.toBe(before);
  await pet.evaluate(() => window.bobo.care("sleep"));
  await expect(pet.locator(".bobo-art")).toHaveAttribute(
    "data-activity",
    "sleeping",
  );
  await pet.waitForTimeout(350);
  const lids = await pet
    .locator(".bobo-eyelid")
    .evaluateAll((els) => els.map((e) => e.style.transform));
  expect(lids.every((s) => !s.includes("scaleY(0)"))).toBe(true);
  await pet.screenshot({
    path: path.join(output, "Bobo-睡眠状态.png"),
    omitBackground: true,
  });
  await pet.evaluate(() => window.bobo.care("sleep"));
  await pet
    .locator(".pet-drag")
    .click({ button: "right", position: { x: 115, y: 181 } });
  await expect(pet.locator(".pet-actions-menu")).toBeVisible();
  await app.close();
  app = null;
  app = await electron.launch({
    executablePath: electronPath,
    args: [root],
    env,
  });
  const restored = await app.firstWindow();
  await expect(restored.locator(".bobo-art")).toBeVisible();
  const state = await restored.evaluate(() => window.bobo.getState());
  expect(state.conversations.length).toBe(2);
  expect(state.activeConversationId).toBe(first);
  expect(state.messages[0].content).toContain("检查 SQL");
  console.log(
    "PASS: new conversations isolate visible messages, history search and drafts restore, leaf animation changes, sleep state reacts, right-click care menu, restart restores active conversation. No model calls.",
  );
} finally {
  await app?.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
