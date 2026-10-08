import { spawn } from "node:child_process";
import process from "node:process";
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const vite = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
  { stdio: "inherit", env },
);
let electron;
async function launch() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (vite.exitCode != null) throw new Error("Vite 没有启动。");
    try {
      const response = await fetch("http://127.0.0.1:5173");
      if (response.ok) break;
    } catch {
      /* waiting for the dev server */
    }
    if (attempt === 59) throw new Error("开发界面启动超时。");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  electron = spawn("node_modules/.bin/electron", ["."], {
    stdio: "inherit",
    env: { ...env, BOBO_DEV_URL: "http://127.0.0.1:5173" },
  });
  electron.on("exit", (code) => {
    vite.kill();
    process.exit(code || 0);
  });
}
const stop = () => {
  electron?.kill();
  vite.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
vite.on("exit", (code) => {
  if (code && !electron) process.exit(code);
});
launch().catch((error) => {
  console.error(error.message);
  stop();
  process.exit(1);
});
