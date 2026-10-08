// Controlled protocol pilot: same model/tools/files, forwarded goal vs structured checkpoint.
// Explicit invocation uses the configured Model Hub account. No production files/CLI sessions.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadConfig, redact } from "../electron/config.mjs";
import {
  createModelClient,
  modelRequestOptions,
} from "../electron/model-client.mjs";
const cfg = loadConfig();
if (!cfg.key || cfg.configurationIssue) throw new Error("需要有效的模型配置");
const client = createModelClient(cfg, { timeout: 45000 }),
  runs = [];
let spent = 0;
const tools = [
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
for (const [index, values] of [
  [3, 5, 7],
  [0, -2, 10],
  [11, 13, 17],
].entries()) {
  const sum = values.reduce((a, b) => a + b, 0),
    summary = JSON.stringify({ count: values.length, sum });
  const goal =
    "读取 source.json 中的 values，交付 summary.json，严格使用 count 和 sum 两个数字字段；另写 report.md，内容必须包含“记录数：N”和“合计：S”（N/S 替换为实际数字）。检查现有产物，只做必要工作。";
  for (const mode of index % 2
    ? ["checkpoint", "forward"]
    : ["forward", "checkpoint"]) {
    if (spent >= 30000) break;
    const files = {
        "source.json": JSON.stringify({ values }),
        "summary.json": summary,
      },
      writes = [],
      reads = [];
    const user =
      mode === "forward"
        ? goal
        : `${goal}\n交接记录：${JSON.stringify({ schema_version: 1, goal, previous_status: "interrupted", observations: [{ file: "summary.json", sha256: createHash("sha256").update(summary).digest("hex"), check: "count/sum 已由确定性检查核对通过", count: values.length, sum }], next_action: "report.md 尚未交付；核对已有文件后继续。" })}`;
    const messages = [
      {
        role: "system",
        content:
          "在这个隔离工作区完成用户任务。文件工具是唯一执行途径。先检查已有产物，避免不必要的重写。所有模式使用相同规则。不要提出问题，完成后简短说明。",
      },
      { role: "user", content: user },
    ];
    const run = {
      case: index + 1,
      mode,
      input: 0,
      output: 0,
      calls: 0,
      reads,
      writes,
      success: false,
      error: null,
      elapsedMs: 0,
    };
    const start = Date.now();
    try {
      for (let round = 0; round < 6 && spent < 30000; round++) {
        const r = await client.chat.completions.create(
          { model: cfg.model, messages, tools, max_tokens: 900 },
          modelRequestOptions(cfg),
        );
        run.calls++;
        run.model = r.model;
        run.input += r.usage?.prompt_tokens || 0;
        run.output += r.usage?.completion_tokens || 0;
        spent +=
          (r.usage?.prompt_tokens || 0) + (r.usage?.completion_tokens || 0);
        if (!r.usage) run.unknownUsage = true;
        const message = r.choices?.[0]?.message;
        if (!message) throw new Error("empty model response");
        messages.push(message);
        if (!message.tool_calls?.length) break;
        for (const call of message.tool_calls) {
          let result;
          try {
            const args = JSON.parse(call.function.arguments);
            if (call.function.name === "list_files")
              result = Object.keys(files);
            else if (
              !["source.json", "summary.json", "report.md"].includes(args.path)
            )
              throw new Error("path outside test fixture");
            else if (call.function.name === "read_file") {
              reads.push(args.path);
              result = files[args.path] ?? "file missing";
            } else if (call.function.name === "write_file") {
              if (
                args.path === "source.json" ||
                typeof args.content !== "string" ||
                args.content.length > 8000
              )
                throw new Error("invalid write");
              writes.push(args.path);
              files[args.path] = args.content;
              result = "written";
            } else throw new Error("unknown tool");
          } catch (e) {
            result = { error: e.message };
          }
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }
      }
      const value = JSON.parse(files["summary.json"]);
      run.success =
        (value.count === values.length &&
          value.sum === sum &&
          Object.keys(value).sort().join(",") === "count,sum" &&
          files["report.md"]?.includes(`记录数：${values.length}`) &&
          files["report.md"]?.includes(`合计：${sum}`)) ||
        false;
    } catch (e) {
      run.error = redact(e.message);
    }
    run.elapsedMs = Date.now() - start;
    run.redundantWrites = writes.filter((p) => p === "summary.json").length;
    run.total = run.input + run.output;
    runs.push(run);
    console.log(JSON.stringify(run));
  }
}
const result = {
  date: "2026-10-04",
  type: "controlled_same_model_protocol_pilot",
  configuredModel: cfg.model,
  knownTotalTokens: spent,
  runs,
  limits: [
    "3 fixtures, one run per condition; no significance claim",
    "Same model; not a real Codex/Claude Code comparison or human baseline",
    "Pre-seeded checkpoint; its upstream creation cost is identical and excluded in both conditions",
    "Includes checkpoint text tokens, all model/tool rounds; no paid summarizer",
    "Filesystem tools operate only on an in-memory isolated fixture; no real CLI benchmark",
    "30,000 known-token soft stop checked between API requests; in-flight request can exceed threshold",
  ],
};
const output =
  process.env.BOBO_EVAL_OUTPUT || path.resolve("work/handoff-pilot.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(`Saved ${output}`);
