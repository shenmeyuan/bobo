import { spawn } from "node:child_process";
import path from "node:path";
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const root = path.resolve(import.meta.dirname, "..");
const child = spawn(path.join(root, "node_modules/.bin/electron"), [root], {
  stdio: "inherit",
  env,
});
child.on("exit", (code) => process.exit(code || 0));
process.on("SIGINT", () => child.kill());
process.on("SIGTERM", () => child.kill());
