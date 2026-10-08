// Explicit invocation consumes the local Trae account. Temporary files only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Store } from "../electron/store.mjs";
import { AgentManager } from "../electron/agents.mjs";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-trae-adapter-")),
  workspace = path.join(dir, "workspace");
fs.mkdirSync(workspace);
const store = new Store(path.join(dir, "data"));
store.state.settings.workspace = workspace;
store.state.settings.allowEdits = true;
store.state.settings.superviseTasks = false;
const shapes = [],
  marker = randomUUID();
let buffer = "";
const simulateLegacyDenial = process.argv.includes("--legacy-denial");
const manager = new AgentManager(
  store,
  () => {},
  (binary, args, options) => {
    const probeArgs = args.map((v) =>
      simulateLegacyDenial &&
      v === "Read,Glob,Grep,LS,Edit,Write,Replace,ApplyPatch"
        ? "Read,Glob,Grep,LS,Edit,Write,Replace"
        : v,
    );
    const child = spawn(
      binary,
      [
        ...probeArgs.slice(0, -2),
        "--query-timeout",
        "75s",
        ...probeArgs.slice(-2),
      ],
      options,
    );
    child.stdout.on("data", (data) => {
      buffer += data;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (e.type === "system")
            shapes.push({
              type: e.type,
              model: e.model,
              permission: e.permission_mode,
              tools: e.tools,
            });
          else if (e.type === "user" || e.type === "assistant") {
            const m = e.message;
            shapes.push({
              type: e.type,
              eventKeys: Object.keys(e),
              subtype: e.subtype,
              toolName: e.tool_name,
              toolUseId: e.tool_use_id,
              isError: e.is_error,
              eventContentType: typeof e.content,
              publicToolResult: e.subtype === "tool_result" ? e.content : null,
              contentKeys:
                e.content && typeof e.content === "object"
                  ? Object.keys(e.content)
                  : null,
              toolOutputKeys: e.content?.output
                ? Object.keys(e.content.output)
                : null,
              messageKeys: Object.keys(m || {}),
              contentType: typeof m?.content,
              nestedKeys: m?.message ? Object.keys(m.message) : null,
              contentKeys:
                m?.content &&
                typeof m.content === "object" &&
                !Array.isArray(m.content)
                  ? Object.keys(m.content)
                  : null,
            });
          }
        } catch {}
      }
    });
    return child;
  },
);
let timeout;
try {
  const first = manager.dispatch(
    "trae",
    "写入适配验证",
    `这是一项单步临时文件验证。用 ApplyPatch 创建 probe.txt，其全部内容为 ${marker}。只创建这一个文件，不调用 Bash 或 Agent，不做计划、不添加额外文件。完成后仅回复 ready。`,
    {
      contract: {
        checks: [{ kind: "contains", path: "probe.txt", expected: marker }],
        maxAttempts: 1,
        tokenLimit: null,
      },
    },
  );
  const deadline = Date.now() + 85000;
  while (manager.running.size && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 200));
  if (manager.running.size) {
    manager.cancel(first.id);
    await new Promise((r) => setTimeout(r, 2500));
  }
  const task = manager.task(first.id),
    passed = simulateLegacyDenial
      ? task.status === "attention"
      : task.status === "completed" && task.verification?.status === "passed";
  const result = {
    date: new Date().toISOString(),
    type: simulateLegacyDenial
      ? "real_trae_legacy_permission_denial_probe"
      : "real_trae_applypatch_write_probe",
    passed,
    status: task.status,
    verification: task.verification?.status || null,
    usage: task.usage,
    usageRaw: task.usageRaw,
    error: task.error,
    shapes,
    scope: "one temporary file; no user project touched",
  };
  fs.mkdirSync("work", { recursive: true });
  fs.writeFileSync(
    simulateLegacyDenial
      ? "work/trae-adapter-denial-live.json"
      : "work/trae-adapter-live.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ ...result, shapes: shapes.slice(0, 4) }));
  if (!passed) process.exitCode = 1;
} finally {
  manager.stopAll();
  fs.rmSync(dir, { recursive: true, force: true });
}
