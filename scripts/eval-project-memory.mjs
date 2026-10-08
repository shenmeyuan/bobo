// Real files/tools with one fixed Model Hub model. Not a native Codex/CC/Trae benchmark.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { loadConfig, redact } from "../electron/config.mjs";
import {
  createModelClient,
  modelRequestOptions,
} from "../electron/model-client.mjs";
import { Store } from "../electron/store.mjs";
import {
  inventory,
  runVerification,
  handoffPacket,
  continuationPrompt,
} from "../electron/workflow.mjs";
import { archiveTaskReport } from "../electron/task-memory.mjs";
import { memoryWorkCases, judgeMemoryWork } from "./lib/memory-work-cases.mjs";
let live = false,
  repeats = 1,
  limit = 150000;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--run") live = true;
  else if (args[i] === "--repeats") repeats = Number(args[++i]);
  else if (args[i] === "--token-limit") limit = Number(args[++i]);
  else throw Error(`Unknown argument: ${args[i]}`);
}
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3)
  throw Error("repeats must be 1..3");
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000000)
  throw Error("token-limit must be 1..1000000");
const cfg = loadConfig(),
  client = live
    ? createModelClient(cfg, { timeout: 45000, maxRetries: 0 })
    : null;
const output = path.resolve("work/project-memory-pilot.json"),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-fixed-project-"));
const modes = ["session_history", "full_report", "bobo_memory"],
  maxOutput = 4000;
const result = {
  meta: {
    type: "actual_files_fixed_model_harness_pilot",
    configuredModel: cfg.model,
    provider: cfg.provider,
    startedAt: new Date().toISOString(),
    repeats,
    tokenAdmissionThreshold: limit,
    executor: "minimal local file-tool harness",
    outputAllowance: maxOutput,
    memoryPolicy: "compact execution envelope",
    limits: [
      "Small prepared partial projects, not hours-long production trajectories or native executor compaction.",
      "session_history is this minimal harness conversation, not the native history of Codex/CC/Trae.",
      "One common seed per case is reused without mutation; each branch has identical files and a copied seed history.",
      "Real filesystem reads/writes, no shell/network/subagents. Agent cannot see the external acceptance driver.",
      "Bobo uses its production archive and handoff assembly, not an idealized summary. No paid summarizer.",
      "All model/tool rounds and common seed preparation are counted; unknown usage stops new paid calls.",
      "No human baseline: zero rescue actions is recorded, not a measured saving in human minutes.",
      "Three repetitions on three purpose-built projects have limited generality and no superiority significance claim.",
      "File-tool harness has less overhead and different capabilities than external CLIs; do not combine the two results into one ranking.",
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
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
}
const defs = [
  ["list_files", {}],
  ["read_file", { path: { type: "string" } }],
  ["write_file", { path: { type: "string" }, content: { type: "string" } }],
].map(([name, properties]) => ({
  type: "function",
  function: {
    name,
    description: name,
    parameters: {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
    strict: true,
  },
}));
const system =
  "在这个本地隔离项目完成用户任务。文件工具是唯一执行途径，不委派，不访问网络。需求变更以最新用户纠正为准。先看已有文件，避免重复改写。报告是未经独立验收的自报。不要提出问题；信息缺失时说明。最终简短列出交付与限制。";
function restore(workspace, files) {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const p = path.join(workspace, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
}
function snapshot(workspace) {
  const files = {};
  function walk(dir, prefix = "") {
    for (const e of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix + e.name;
      if (e.isSymbolicLink()) throw Error("symlink");
      if (e.isDirectory()) walk(path.join(dir, e.name), rel + "/");
      else files[rel] = fs.readFileSync(path.join(dir, e.name), "utf8");
    }
  }
  walk(workspace);
  return files;
}
const digest = (files) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest("hex");
function filePath(workspace, name) {
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 200 ||
    path.isAbsolute(name) ||
    name.split(/[\\/]/).some((p) => !p || p === ".." || p.startsWith(".")) ||
    (!["src/", "data/", "examples/"].some((p) => name.startsWith(p)) &&
      ![
        "README.md",
        "package.json",
        "notes.md",
        "plan.json",
        "export.json",
        "export.csv",
      ].includes(name))
  )
    throw Error("path outside fixture");
  return path.join(workspace, name);
}
async function execute(workspace, initial, { seed = false } = {}) {
  const messages = structuredClone(initial),
    tools = [],
    start = Date.now();
  const run = {
    input: 0,
    output: 0,
    calls: 0,
    tools,
    publicReport: "",
    status: "completed",
    error: null,
    model: null,
    elapsedMs: 0,
  };
  try {
    for (let round = 0; round < 9; round++) {
      const request = {
        model: cfg.model,
        messages,
        tools: seed ? defs.slice(0, 2) : defs,
        max_tokens: maxOutput,
      };
      const reservation =
        Buffer.byteLength(JSON.stringify(request), "utf8") + maxOutput + 2048;
      if (
        result.unknownUsage ||
        result.knownTotalTokens + reservation > limit
      ) {
        result.stoppedReason = result.unknownUsage
          ? "unknown model usage"
          : "token admission threshold";
        throw Error(result.stoppedReason);
      }
      const response = await client.chat.completions.create(
        request,
        modelRequestOptions(cfg),
      );
      run.calls++;
      run.model = response.model;
      (run.finishReasons ||= []).push(
        response.choices?.[0]?.finish_reason || null,
      );
      if (
        !response.usage ||
        !Number.isFinite(response.usage.prompt_tokens) ||
        !Number.isFinite(response.usage.completion_tokens)
      ) {
        result.unknownUsage = true;
        throw Error("unknown usage");
      }
      const { prompt_tokens: i, completion_tokens: o } = response.usage;
      run.input += i;
      run.output += o;
      result.knownTotalTokens += i + o;
      const raw = response.choices?.[0]?.message;
      if (!raw) throw Error("empty response");
      // Only public content and explicit tool calls. Never retain reasoning fields.
      const message = {
        role: "assistant",
        content: raw.content || null,
        ...(raw.tool_calls?.length ? { tool_calls: raw.tool_calls } : {}),
      };
      messages.push(message);
      if (!message.tool_calls?.length) {
        run.publicReport = redact(message.content || "");
        break;
      }
      for (const call of message.tool_calls) {
        let value;
        try {
          const a = JSON.parse(call.function.arguments),
            name = call.function.name;
          const observed = { name, path: a.path || null };
          tools.push(observed);
          if (name === "list_files") value = Object.keys(snapshot(workspace));
          else if (name === "read_file") {
            const p = filePath(workspace, a.path);
            value = fs.existsSync(p)
              ? fs.readFileSync(p, "utf8")
              : "file missing";
            if (value.length > 16000) throw Error("read limit");
          } else if (name === "write_file" && !seed) {
            const p = filePath(workspace, a.path);
            if (typeof a.content !== "string" || a.content.length > 16000)
              throw Error("write limit");
            const before = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
            observed.unchangedWrite = before === a.content;
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, a.content);
            value = "written";
          } else throw Error("unknown or disabled tool");
        } catch (e) {
          value = { error: e.message };
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(value),
        });
      }
    }
    if (!run.publicReport)
      throw Error("no final public report within round limit");
  } catch (e) {
    run.status = "failed";
    run.error = redact(e.message);
  }
  run.elapsedMs = Date.now() - start;
  return { run, messages };
}
try {
  const cases = memoryWorkCases();
  if (!live)
    console.log(
      JSON.stringify({
        dryRun: true,
        cases: cases.map((c) => c.id),
        modes,
        repeats,
        tokenAdmissionThreshold: limit,
      }),
    );
  else {
    // Prepare all seeds before branches; cycle cases first so the budget does not select only one case.
    const prepared = [];
    for (const c of cases) {
      const base = path.join(dir, c.id),
        workspace = path.join(base, "workspace");
      restore(workspace, c.files);
      console.log(JSON.stringify({ phase: "seed", case: c.id }));
      const seed = await execute(
        workspace,
        [
          { role: "system", content: system },
          {
            role: "user",
            content: `完整任务：${c.goal}\n本轮只读取已有实现和 README.md，报告状态和未完成项，然后停下，不实施。下一轮实施。`,
          },
        ],
        { seed: true },
      );
      result.seeds.push({ case: c.id, ...seed.run });
      save();
      if (
        seed.run.status !== "completed" ||
        digest(snapshot(workspace)) !== digest(c.files)
      ) {
        result.stoppedReason = "seed failed or changed fixture";
        break;
      }
      const store = new Store(path.join(base, "data"));
      store.state.settings.workspace = workspace;
      const task = {
        id: randomUUID(),
        agent: "local-file-harness",
        workspace,
        prompt: c.goal,
        originalRequest: { source: "user_message", content: c.goal },
        status: "interrupted",
        createdAt: Date.now(),
        result: seed.run.publicReport,
        usage: { input: seed.run.input, output: seed.run.output },
        contract: { checks: c.checks, maxAttempts: 10, tokenLimit: null },
        checkpoint: {
          at: Date.now(),
          inventory: inventory(workspace),
          changes: [],
        },
      };
      task.rootId = task.id;
      task.verification = runVerification(task, task.contract);
      task.reportMemory = archiveTaskReport(store, task, seed.run.publicReport);
      task.corrections = c.correction
        ? [
            {
              id: randomUUID(),
              text: c.correction,
              source: "user_correction",
              active: true,
              at: Date.now(),
            },
          ]
        : [];
      store.state.tasks = [task];
      store.save();
      prepared.push({ c, workspace, seed, store, task });
    }
    outer: for (let repeat = 0; repeat < repeats; repeat++)
      for (const [
        caseIndex,
        { c, workspace, seed, store, task },
      ] of prepared.entries()) {
        if (result.stoppedReason) break outer;
        const order = modes
          .slice((repeat + caseIndex) % 3)
          .concat(modes.slice(0, (repeat + caseIndex) % 3));
        for (const mode of order) {
          if (result.stoppedReason) break outer;
          const initial = { ...c.files, ...c.externalChanges };
          restore(workspace, initial);
          const common = `继续实施，只完成剩余工作，交付真实文件。${c.correction ? "用户最新纠正：" + c.correction : ""}`;
          const messages =
            mode === "session_history"
              ? structuredClone(seed.messages)
              : [{ role: "system", content: system }];
          let prompt = common;
          if (mode === "full_report")
            prompt += `\n原始需求：${c.goal}\n公开进度报告：${seed.run.publicReport}\n所列验收：${JSON.stringify(c.checks)}`;
          if (mode === "bobo_memory")
            prompt +=
              "\n" +
              continuationPrompt(
                handoffPacket(
                  store,
                  task,
                  "从阶段停点继续实施",
                  inventory(workspace),
                ),
              );
          messages.push({ role: "user", content: prompt });
          console.log(
            JSON.stringify({
              phase: "continuation",
              case: c.id,
              repeat: repeat + 1,
              mode,
              knownTokens: result.knownTotalTokens,
            }),
          );
          const { run } = await execute(workspace, messages),
            acceptance = await judgeMemoryWork(c, workspace);
          const artifactFiles = snapshot(workspace);
          const row = {
            case: c.id,
            repeat: repeat + 1,
            mode,
            startHash: digest(initial),
            ...run,
            acceptance,
            success: run.status === "completed" && acceptance.passed,
            manualInterventions: 0,
            unchangedWrites: run.tools.filter((t) => t.unchangedWrite).length,
            protectedFileWriteAttempts: run.tools.filter(
              (t) =>
                t.name === "write_file" && c.protectedFiles.includes(t.path),
            ).length,
            seedTokens: seed.run.input + seed.run.output,
            standaloneTokens:
              seed.run.input + seed.run.output + run.input + run.output,
            artifactFiles,
          };
          result.runs.push(row);
          save();
          console.log(
            JSON.stringify({
              phase: "result",
              case: c.id,
              repeat: repeat + 1,
              mode,
              success: row.success,
              input: run.input,
              output: run.output,
              checks: acceptance.checks,
            }),
          );
        }
      }
  }
} finally {
  result.meta.finishedAt = new Date().toISOString();
  if (live) {
    result.summary = Object.fromEntries(
      modes.map((mode) => {
        const rows = result.runs.filter((r) => r.mode === mode);
        return [
          mode,
          {
            runs: rows.length,
            passed: rows.filter((r) => r.success).length,
            tokens: rows.reduce((n, r) => n + r.input + r.output, 0),
            elapsedMs: rows.reduce((n, r) => n + r.elapsedMs, 0),
            unchangedWrites: rows.reduce((n, r) => n + r.unchangedWrites, 0),
            protectedFileWriteAttempts: rows.reduce(
              (n, r) => n + r.protectedFileWriteAttempts,
              0,
            ),
          },
        ];
      }),
    );
    save();
    console.log(`Saved ${output}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
