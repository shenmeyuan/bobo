import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const output =
  process.env.BOBO_SCREENSHOT_DIR || path.join(root, "work", "screenshots");
fs.mkdirSync(output, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-art-"));
const envFile = path.join(temporary, ".env");
fs.writeFileSync(envFile, "OPENAI_API_KEY=\n");
const env = {
  ...process.env,
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
  await expect(pet.locator(".bobo-art.seed")).toBeVisible();
  await pet.screenshot({
    path: path.join(output, "Bobo-新种子桌宠.png"),
    omitBackground: true,
  });
  const homeReady = app.waitForEvent("window");
  await pet.evaluate(() => window.bobo.openHome("growth"));
  const home = await homeReady;
  const stages = [
    ["seed", "种子期"],
    ["sprout", "发芽期"],
    ["young", "幼年期"],
    ["adult", "成年期"],
    ["elder", "老年期"],
    ["memory", "回忆期"],
  ];
  const sprites = [];
  for (const [stage, name] of stages) {
    await home.locator(".growth-road button").filter({ hasText: name }).click();
    const art = home.locator(".growth-preview-art .bobo-art");
    await expect(art).toHaveClass(new RegExp(stage));
    const source = await art.locator("image").getAttribute("href");
    const alpha = await home.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      return {
        corner: ctx.getImageData(0, 0, 1, 1).data[3],
        center: ctx.getImageData(image.width / 2, image.height * 0.6, 1, 1)
          .data[3],
      };
    }, source);
    expect(alpha.corner).toBe(0);
    expect(alpha.center).toBeGreaterThan(0);
    sprites.push({ stage, name, source });
    if (stage === "young")
      await home.screenshot({ path: path.join(output, "Bobo-成长页新版.png") });
  }
  await app.evaluate(({ BrowserWindow }) => {
    const home = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes("view=home"),
    );
    (home || BrowserWindow.getAllWindows().at(-1)).setSize(1400, 780);
  });
  await home.evaluate((sprites) => {
    document.body.innerHTML =
      '<main style="padding:44px 48px;color:#eee;background:#111214;height:100vh;box-sizing:border-box;font-family:system-ui"><small style="letter-spacing:4px;color:#929497">BOBO · A LIFE TOGETHER</small><h1 style="font-weight:500;font-size:30px;margin:16px 0 8px">同一个 Bobo，慢慢长大。</h1><p style="color:#999;font-size:14px">细腻绒面 · 陶土花盆 · 柔和光照</p><section id="art-sheet" style="display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-top:58px"></section><p style="margin-top:64px;color:#777;font-size:13px">成年保留原形象，其余阶段采用同一角色与材质方向。</p></main>';
    const sheet = document.getElementById("art-sheet");
    for (const sprite of sprites) {
      const card = document.createElement("div");
      card.innerHTML =
        '<img style="width:100%;aspect-ratio:1;object-fit:contain" src="' +
        sprite.source +
        '"><p style="text-align:center;margin-top:24px;font-size:15px">' +
        sprite.name +
        "</p>";
      sheet.appendChild(card);
    }
  }, sprites);
  await home.evaluate(
    async () => await Promise.all([...document.images].map((i) => i.decode())),
  );
  await home.screenshot({ path: path.join(output, "Bobo-生命周期新版.png") });
  console.log(
    "PASS: six lifecycle sprites rendered in growth preview; real alpha verified; gallery and desktop screenshots saved.",
  );
} finally {
  await app?.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
