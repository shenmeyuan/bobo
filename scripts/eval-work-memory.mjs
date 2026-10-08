// Actual local CLI tasks at a controlled pause. --run consumes the CLI account.
// This is an exploratory benchmark, not a production-success or human-time claim.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { Store } from "../electron/store.mjs";
import { loadConfig, redact } from "../electron/config.mjs";
import { taskCommand, parseAgentEvent } from "../electron/agents.mjs";
import { archiveTaskReport } from "../electron/task-memory.mjs";
import {
  inventory,
  changedFiles,
  runVerification,
  handoffPacket,
  continuationPrompt,
} from "../electron/workflow.mjs";
import { memoryWorkCases, judgeMemoryWork } from "./lib/memory-work-cases.mjs";

const args = process.argv.slice(2);
let live = false,
  repeats = 1,
  only = null,
  limit = 650000;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--run") live = true;
  else if (args[i] === "--repeats") repeats = Number(args[++i]);
  else if (args[i] === "--case") only = args[++i];
  else if (args[i] === "--token-limit") limit = Number(args[++i]);
  else throw new Error(`Unknown argument: ${args[i]}`);
}
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3)
  throw new Error("repeats must be 1..3");
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000000)
  throw new Error("token-limit must be 1..2000000");
const cases = memoryWorkCases().filter((c) => !only || c.id === only);
if (!cases.length) throw new Error("Unknown case");
const modes = ["native", "full_report", "bobo_memory"];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-real-memory-"));
const cfg = loadConfig();
const output = path.resolve("work/real-memory-pilot.json");
const results = {
  meta: {
    type: "actual_cli_controlled_pause_pilot",
    startedAt: new Date().toISOString(),
    executor: "trae",
    repeats,
    tokenAdmissionThreshold: limit,
    perQueryTimeoutMs: 180000,
    manualRescues: false,
    executionPermissions:
      "Read/Glob/Grep/LS/Edit/Write/Replace/ApplyPatch; Bash, network and Agent tools denied",
    limits: [
      "Small purpose-built Node projects, not hours-long production trajectories or a benchmark of native compaction.",
      "Native keeps private executor history; fresh arms only see public reports and user facts. That visibility difference is intentional.",
      "Each repeat has its own real seed session. All arms restore the same workspace path and exact file bytes before continuation.",
      "One branch per seed uses native resume; native session is not reused across branches or repeats.",
      "Write readiness check is performed once before task branches; failed readiness stops the experiment. Its usage is included globally and reported separately.",
      "Seed cost is common upstream cost; report it separately and also include it once per hypothetical standalone arm.",
      "No Bobo brain/summarizer call: continuation assembly and checks are deterministic.",
      "CLI token counts and usage schema are provider-reported; zero cost fields do not establish free service.",
      "Token threshold is an admission gate between CLI queries, not a hard in-flight token cap. Unknown usage stops subsequent paid runs.",
      "Tools are real CLI filesystem tools; the external judge is never visible to the agent. No live human comparison; rescue count is not human minutes.",
      "Preparation creates a controlled partial project; seed reads it and reports at the planned boundary. This is not a random real-world crash.",
    ],
  },
  seeds: [],
  runs: [],
  knownTotalTokens: 0,
  unknownUsage: false,
  stoppedReason: null,
};
function save() {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(results, null, 2));
}
function restore(workspace, files) {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    const file = path.join(workspace, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
}
function snapshot(workspace) {
  const result = {};
  function walk(dir, prefix = "") {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) throw new Error("Unexpected fixture symlink");
      if (e.name.startsWith(".")) continue;
      const rel = prefix + e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel + "/");
      else result[rel] = fs.readFileSync(path.join(dir, e.name), "utf8");
    }
  }
  walk(workspace);
  return result;
}
function admission() {
  if (results.unknownUsage) return "unknown CLI usage";
  if (results.knownTotalTokens >= limit)
    return "reported token admission threshold reached";
  return null;
}
const active = new Set();
function kill(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 2000);
  timer.unref();
  return timer;
}
process.on("SIGINT", () => {
  results.stoppedReason = "interrupted by operator";
  save();
  for (const p of active) kill(p);
});
async function cli(workspace, prompt, sessionId = null, readOnly = false) {
  const command = taskCommand("trae", cfg, !readOnly, sessionId);
  if (!command.binary) throw new Error("Trae CLI not installed");
  const env = { ...process.env };
  for (const k of [
    "OPENAI_API_KEY",
    "MODEL_HUB_AK",
    "MODEL_HUB_BASE_URL",
    "MODEL_HUB_URL",
    "OPENAI_BASE_URL",
    "BOBO_ENV_PATH",
    "BOBO_DATA_DIR",
    "ELECTRON_RUN_AS_NODE",
    "BOBO_DEV_URL",
  ])
    delete env[k];
  // Same tool restrictions on all arms, and no arbitrary shell/network execution.
  const disallowed = "Bash,AskUserQuestion,WebFetch,WebSearch";
  const actualArgs = [
    ...command.args,
    "--disallowed-tool",
    disallowed,
    "--query-timeout",
    "180s",
    "--",
    prompt,
  ];
  const start = Date.now(),
    tools = [],
    publicReports = [];
  let usage = null,
    usageRaw = null,
    session = null,
    error = "",
    buffer = "",
    bytes = 0,
    closed = false,
    timedOut = false,
    model = null;
  const eventShapes = {};
  const child = spawn(command.binary, actualArgs, {
    cwd: workspace,
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  active.add(child);
  fs.writeFileSync(
    path.resolve("work/memory-eval-active.json"),
    JSON.stringify({ pid: child.pid, workspace }),
  );
  const timeout = setTimeout(() => {
    timedOut = true;
    kill(child);
  }, 190000);
  function line(value) {
    let e;
    try {
      e = JSON.parse(value);
    } catch {
      return;
    }
    eventShapes[e.type || "unknown"] ||= {
      keys: Object.keys(e),
      contentKeys:
        e.content && typeof e.content === "object" && !Array.isArray(e.content)
          ? Object.keys(e.content)
          : null,
    };
    const parsed = parseAgentEvent("trae", e);
    if (parsed.sessionId) session = parsed.sessionId;
    if (parsed.error) error = redact(parsed.error);
    if (parsed.permissionDenied) {
      error = parsed.progress;
      kill(child);
    }
    if (parsed.result !== undefined) publicReports.push(String(parsed.result));
    if (parsed.usage) {
      usage = parsed.usage;
      usageRaw = parsed.usageRaw;
    }
    if (e.type === "system") model = e.model || model;
    for (const call of e.message?.tool_calls || []) {
      const name = call.function?.name || call.tool_info?.name;
      let input =
        call.function?.arguments || call.input?.structured_input || {};
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          input = {};
        }
      }
      const file = input.file_path || input.path || null;
      if (name)
        tools.push({
          name,
          path:
            typeof file === "string"
              ? file.replaceAll(workspace + "/", "")
              : null,
        });
    }
    for (const block of Array.isArray(e.message?.content)
      ? e.message.content
      : Array.isArray(e.content)
        ? e.content
        : []) {
      if (block.type !== "tool_use") continue;
      const input = block.input || {};
      const file = input.file_path || input.path || null;
      tools.push({
        name: block.name,
        path:
          typeof file === "string"
            ? file.replaceAll(workspace + "/", "")
            : null,
      });
    }
  }
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 4000000) {
      error = "CLI output limit reached";
      kill(child);
      return;
    }
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const value of lines) line(value);
  });
  let stderr = "";
  child.stderr.on(
    "data",
    (chunk) => (stderr = (stderr + chunk.toString()).slice(-4000)),
  );
  await new Promise((resolve) => {
    child.on("error", (e) => {
      error = redact(e.message);
      resolve();
    });
    child.on("close", (code) => {
      closed = true;
      if (buffer.trim()) line(buffer);
      if (code !== 0 && !error) error = redact(stderr || `CLI exit ${code}`);
      resolve();
    });
  });
  clearTimeout(timeout);
  active.delete(child);
  fs.rmSync(path.resolve("work/memory-eval-active.json"), { force: true });
  if (!closed) kill(child);
  const run = {
    eventShapes,
    sessionId: session,
    model,
    status: error || timedOut ? "failed" : "completed",
    error: timedOut ? "query timeout" : error,
    input: usage?.input ?? null,
    output: usage?.output ?? null,
    reportedCost: usage?.cost ?? null,
    usageRaw,
    tools,
    publicReport: redact(publicReports.join("\n\n")),
    elapsedMs: Date.now() - start,
    promptChars: prompt.length,
  };
  // Archive source can exceed the UI-redaction cap; no raw hidden reasoning is collected.
  run.archiveSource = publicReports.join("\n\n");
  if (!usage) {
    results.unknownUsage = true;
  } else results.knownTotalTokens += usage.input + usage.output;
  return run;
}
try {
  if (live) {
    const preflightWorkspace = path.join(directory, "write-preflight"),
      sentinel = randomUUID();
    restore(preflightWorkspace, {});
    console.log(JSON.stringify({ phase: "write_preflight" }));
    const probe = await cli(
      preflightWorkspace,
      `单步能力检查：用 ApplyPatch 创建 ready.txt，全部内容为 ${sentinel}。只做这一项，不做计划，不调用 Bash 或 Agent，完成后仅回复 ready。`,
    );
    delete probe.archiveSource;
    const readyFile = path.join(preflightWorkspace, "ready.txt");
    const passed =
      probe.status === "completed" &&
      fs.existsSync(readyFile) &&
      fs.readFileSync(readyFile, "utf8").trim() === sentinel;
    results.preflight = { ...probe, passed };
    if (!passed)
      results.stoppedReason =
        "write preflight failed; no task branches launched";
    save();
  }
  if (!live) {
    console.log(
      JSON.stringify({
        dryRun: true,
        cases: cases.map((c) => ({
          id: c.id,
          files: Object.keys(c.files),
          goal: c.goal,
          correction: c.correction,
        })),
        modes,
        repeats,
        plannedQueries: 1 + cases.length * repeats * 4,
        writePreflight: true,
        tokenAdmissionThreshold: limit,
      }),
    );
  } else
    outer: for (let repeat = 0; repeat < repeats; repeat++)
      for (const [caseIndex, c] of cases.entries()) {
        if (results.stoppedReason || admission()) {
          results.stoppedReason ||= admission();
          break outer;
        }
        const base = path.join(directory, `${c.id}-${repeat}`),
          workspace = path.join(base, "workspace");
        restore(workspace, c.files);
        const before = inventory(workspace);
        const seedPrompt = `用户的完整任务：${c.goal}\n这是一次明确的阶段停点：这轮只读取 README.md 和相关已有实现，检查当前进展，不修改任何文件。用公开报告记录你确认的状态、未完成项和下次需要做的工作，然后结束；下一轮才实施。`;
        console.log(
          JSON.stringify({ phase: "seed", case: c.id, repeat: repeat + 1 }),
        );
        const seed = await cli(workspace, seedPrompt, null, true);
        const seedSource = seed.archiveSource;
        delete seed.archiveSource;
        results.seeds.push({ case: c.id, repeat: repeat + 1, ...seed });
        save();
        if (seed.status !== "completed" || !seed.sessionId || !seedSource) {
          results.stoppedReason =
            "seed failed or no native session/public report";
          break outer;
        }
        const stopped = snapshot(workspace);
        if (canonicalFiles(stopped) !== canonicalFiles(c.files)) {
          results.stoppedReason = "read-only seed changed fixture";
          break outer;
        }
        const initialHash = createHash("sha256")
          .update(canonicalFiles(stopped))
          .digest("hex");
        const store = new Store(path.join(base, "data"));
        store.state.settings.workspace = workspace;
        const task = {
          id: randomUUID(),
          rootId: null,
          agent: "trae",
          workspace,
          title: c.id,
          prompt: c.goal,
          originalRequest: { source: "user_message", content: c.goal },
          status: "interrupted",
          createdAt: Date.now(),
          result: seed.publicReport,
          usage: {
            input: seed.input,
            output: seed.output,
            cost: seed.reportedCost,
          },
          sessionId: seed.sessionId,
          contract: { checks: c.checks, maxAttempts: 3, tokenLimit: null },
          baseline: before,
          checkpoint: {
            at: Date.now(),
            inventory: inventory(workspace),
            changes: changedFiles(before, inventory(workspace)),
          },
        };
        task.rootId = task.id;
        task.verification = runVerification(task, task.contract);
        task.reportMemory = archiveTaskReport(store, task, seedSource);
        task.corrections = c.correction
          ? [
              {
                id: randomUUID(),
                text: c.correction,
                active: true,
                source: "user_correction",
                at: Date.now(),
              },
            ]
          : [];
        store.state.tasks = [task];
        store.save();
        // Identical external change after the checkpoint, if this case requires it.
        const resumedFiles = { ...stopped, ...(c.externalChanges || {}) };
        const order = modes
          .slice((caseIndex + repeat) % 3)
          .concat(modes.slice(0, (caseIndex + repeat) % 3));
        for (const mode of order) {
          if (admission()) {
            results.stoppedReason = admission();
            break outer;
          }
          restore(workspace, resumedFiles);
          const branchHash = createHash("sha256")
            .update(canonicalFiles(snapshot(workspace)))
            .digest("hex");
          const common = `继续用户任务，只完成未完成的部分。${c.correction ? `用户最新纠正（覆盖冲突的旧要求）：${c.correction}` : ""}\n这轮需要实际修改项目文件并交付。仅使用 Read/Glob/Grep/Edit/Write/Replace；不使用子 Agent、网络或 Bash。完成时说明产物、检查方法与遗留问题。`;
          let prompt;
          if (mode === "native") prompt = common;
          else if (mode === "full_report")
            prompt = `${common}\n原始需求：${c.goal}\n上一轮公开报告（自报，需检查当前文件）：\n${seedSource}\n所列验收：${JSON.stringify(c.checks)}`;
          else
            prompt =
              common +
              "\n" +
              continuationPrompt(
                handoffPacket(
                  store,
                  task,
                  "从阶段停点继续实施",
                  inventory(workspace),
                ),
              );
          console.log(
            JSON.stringify({
              phase: "continuation",
              case: c.id,
              repeat: repeat + 1,
              mode,
              knownTokens: results.knownTotalTokens,
              promptChars: prompt.length,
            }),
          );
          const observed = await cli(
            workspace,
            prompt,
            mode === "native" ? seed.sessionId : null,
          );
          delete observed.archiveSource;
          const judged = await judgeMemoryWork(c, workspace);
          const after = inventory(workspace),
            changes = changedFiles(inventoryFromFiles(resumedFiles), after);
          const run = {
            case: c.id,
            repeat: repeat + 1,
            mode,
            seedHash: initialHash,
            startHash: branchHash,
            ...observed,
            acceptance: judged,
            success: observed.status === "completed" && judged.passed,
            changedFiles: changes.map((v) => v.path),
            seedTokens: seed.input + seed.output,
            standaloneKnownTokens:
              observed.input === null
                ? null
                : seed.input + seed.output + observed.input + observed.output,
            manualInterventions: 0,
            duplicateWritesProxy: observed.tools.filter(
              (t) =>
                ["Edit", "Write", "Replace"].includes(t.name) &&
                c.protectedFiles.includes(t.path),
            ).length,
          };
          results.runs.push(run);
          save();
          console.log(
            JSON.stringify({
              phase: "result",
              case: c.id,
              repeat: repeat + 1,
              mode,
              success: run.success,
              input: run.input,
              output: run.output,
              elapsedMs: run.elapsedMs,
              checks: judged.checks,
            }),
          );
        }
      }
} finally {
  for (const child of active) kill(child);
  results.meta.finishedAt = new Date().toISOString();
  if (live) {
    results.summary = Object.fromEntries(
      modes.map((mode) => {
        const rows = results.runs.filter((r) => r.mode === mode);
        return [
          mode,
          {
            runs: rows.length,
            passed: rows.filter((r) => r.success).length,
            knownTokens: rows.reduce(
              (n, r) => n + (r.input || 0) + (r.output || 0),
              0,
            ),
            elapsedMs: rows.reduce((n, r) => n + r.elapsedMs, 0),
            reportedInterventions: rows.reduce(
              (n, r) => n + r.manualInterventions,
              0,
            ),
            duplicateWritesProxy: rows.reduce(
              (n, r) => n + r.duplicateWritesProxy,
              0,
            ),
          },
        ];
      }),
    );
    save();
    console.log(`Saved ${output}`);
  }
  fs.rmSync(directory, { recursive: true, force: true });
}
function canonicalFiles(files) {
  return JSON.stringify(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  );
}
function inventoryFromFiles(files) {
  return {
    files: Object.fromEntries(
      Object.entries(files).map(([name, text]) => [
        name,
        {
          sha256: createHash("sha256").update(text).digest("hex"),
          size: Buffer.byteLength(text),
        },
      ]),
    ),
  };
}
