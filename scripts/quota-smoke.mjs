import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const output =
  process.env.BOBO_SCREENSHOT_DIR || path.join(root, "work", "screenshots");
fs.mkdirSync(output, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-quota-"));
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
  await pet.evaluate(() => window.bobo.openPetChat());
  await pet
    .getByRole("textbox", { name: "告诉 Bobo" })
    .fill("我codex还有多少额度啊？");
  await pet.getByRole("button", { name: "发送消息" }).click();
  await expect(pet.locator(".bubble-message.assistant")).toContainText(
    "7 天窗口",
    { timeout: 20000 },
  );
  await expect(pet.locator(".bubble-message.assistant")).toContainText("来源");
  const state = await pet.evaluate(() => window.bobo.getState());
  expect(state.quotas.codex.source).toBe("codex-app-server");
  expect(state.quotas.codex.status).toBe("fresh");
  expect(state.quotas.codex.remainingPercent).toBeGreaterThanOrEqual(0);
  expect(state.usage.brainCalls).toBe(0);
  await pet.screenshot({
    path: path.join(output, "quota-reply.png"),
    omitBackground: true,
  });
  await pet.getByRole("button", { name: "智能体额度", exact: true }).click();
  await expect(
    pet.locator(".quota-window-card").filter({ hasText: "Codex" }),
  ).toContainText("剩余", { timeout: 20000 });
  await expect(
    pet.getByRole("button", { name: "刷新额度", exact: true }),
  ).toBeEnabled({ timeout: 20000 });
  await pet.screenshot({
    path: path.join(output, "quota-panel.png"),
    omitBackground: true,
  });
  console.log(
    JSON.stringify({
      status: "PASS",
      source: state.quotas.codex.source,
      remaining: state.quotas.codex.remainingPercent,
      windows: state.quotas.codex.windows.length,
      modelCalls: state.usage.brainCalls,
    }),
  );
} finally {
  await app?.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
