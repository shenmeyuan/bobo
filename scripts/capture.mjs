import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import electronPath from "electron";
import { createState } from "../electron/state.mjs";
import { DAY } from "../electron/pet.mjs";
const root = path.resolve(import.meta.dirname, "..");
const sourceMode = process.env.BOBO_CAPTURE_SOURCE === "1";
const packagedExecutable = path.join(
  root,
  "release/mac-arm64/Bobo.app/Contents/MacOS/Bobo",
);
const executable = sourceMode ? electronPath : packagedExecutable;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-package-check-"));
const previewState = createState();
previewState.pet.companionMs = 21 * DAY;
fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(previewState));
const env = {
  ...process.env,
  BOBO_TEST: "1",
  BOBO_DATA_DIR: dir,
  BOBO_ENV_PATH: path.join(root, ".env"),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.BOBO_DEV_URL;
let desktop;
try {
  desktop = await electron.launch({
    executablePath: executable,
    args: sourceMode ? [root] : [],
    env,
  });
  const pet = await desktop.firstWindow();
  pet.setDefaultTimeout(10000);
  const errors = [];
  pet.on("pageerror", (error) => errors.push(error.message));
  await expect(pet.locator(".pet-name")).toContainText("Bobo");
  expect(desktop.windows().length).toBe(1);
  const state = await pet.evaluate(() => window.bobo.getState());
  expect(state.brain.model).toBeTruthy();
  expect(state.tasks.length).toBe(0);
  const output =
    process.env.BOBO_CAPTURE_OUTPUT ||
    path.join(root, "work/package-preview.png");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await pet.screenshot({
    path: output.replace(/\.png$/, "-compact.png"),
    omitBackground: true,
  });
  await pet.locator(".pet-drag").click({ position: { x: 115, y: 181 } });
  await expect(
    pet.getByRole("region", { name: "Bobo 对话气泡" }),
  ).toBeVisible();
  await pet.waitForFunction(() => innerWidth === 400 && innerHeight === 650);
  await pet.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await pet.locator(".pet-drag svg").screenshot({
    path: path.join(root, "work/pet-art-check.png"),
    omitBackground: true,
  });
  await pet.screenshot({
    path: output,
    omitBackground: true,
    clip: { x: 0, y: 300, width: 400, height: 350 },
  });
  const homePromise = desktop.waitForEvent("window");
  await pet.getByRole("button", { name: "打开操作菜单" }).click();
  await pet.getByRole("button", { name: "打开偏好设置" }).click();
  const home = await homePromise;
  home.on("pageerror", (error) => errors.push(error.message));
  await expect(
    home.getByRole("heading", { name: "Bobo 的大脑" }),
  ).toBeVisible();
  await expect(home.locator(".chat-panel")).toHaveCount(0);
  await home.screenshot({ path: output.replace(/\.png$/, "-settings.png") });
  await pet.evaluate(() => window.bobo.openHome("home"));
  await expect(home.getByRole("heading", { name: "历史概览" })).toBeVisible();
  await home.screenshot({ path: output.replace(/\.png$/, "-records.png") });
  expect(await desktop.evaluate(({ app }) => app.isPackaged)).toBe(!sourceMode);
  expect(errors).toEqual([]);
  console.log(
    "PASS: packaged app starts with one transparent pet; click opens chat bubble; records/settings open lazily without permanent chat. No live model or agent calls made.",
  );
} finally {
  await desktop?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
