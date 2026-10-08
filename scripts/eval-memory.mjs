// Context-fidelity micro-pilot only. Running without --dry-run uses the configured
// Model Hub account. No CLI, filesystem work, or hours-long task is benchmarked.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadConfig, redact, ROOT } from "../electron/config.mjs";
import {
  createModelClient,
  modelRequestOptions,
} from "../electron/model-client.mjs";
import { selectReportExcerpts } from "../electron/task-memory.mjs";

const MODES = ["full", "head_only", "llm_summary", "evidence_memory"];
const TOKEN_LIMIT = 60_000;
const REQUEST_TIMEOUT_MS = 45_000;
const DECISION_MAX_TOKENS = 450;
const SUMMARY_MAX_TOKENS = 900;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const args = process.argv.slice(2);
let repeats = 1;
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dry-run") dryRun = true;
  else if (args[i] === "--repeats") repeats = Number(args[++i]);
  else throw new Error(`Unknown argument: ${args[i]}`);
}
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20)
  throw new Error("--repeats must be an integer from 1 to 20");

const event = (id, kind, text, data = {}) => ({ id, kind, text, ...data });
const sourceLine = (record) => JSON.stringify(record);

// All conditions receive transformations of this exact common source. The
// structured condition only projects fields present in these original events;
// neither the selector nor its input has access to expected answers.
function makeFixture({ id, goal, question, opening, ending, expected }) {
  const records = [event(`${id}-goal`, "goal", goal), ...opening];
  const observations = [
    "Reviewed ordinary fixture names, confirmed the local development command, and preserved the existing public interface. This note records activity only; it does not certify the complete deliverable.",
    "Compared the helper layout with the repository conventions. Several exploratory examples were inspected without changing the final requirement. The result of this inspection is not an acceptance test.",
    "Collected diagnostic output for the next worker. No user-facing behavior was approved in this entry. A later event can supersede the assumptions discussed here, so read the remaining timeline before deciding.",
    "Checked naming consistency and recorded an intermediate implementation note. The worker has not yet made a final delivery decision. Historical progress should not be treated as proof of the current workspace state.",
  ];
  let index = 0;
  while (records.map(sourceLine).join("\n").length < 7_000) {
    records.push(
      event(
        `${id}-activity-${++index}`,
        "activity",
        observations[(index - 1) % observations.length],
        { step: index },
      ),
    );
  }
  records.push(...ending);
  const report = records.map(sourceLine).join("\n");
  if (report.length < 6_000 || report.length > 10_000)
    throw new Error(`Fixture size out of bounds: ${id} (${report.length})`);
  return { id, goal, question, records, report, expected };
}

const fixtures = [
  makeFixture({
    id: "late-blocker",
    goal: "Finish the CSV importer in src/import.ts. Quoted fields may contain embedded newlines. Delivery requires the full acceptance suite to pass.",
    question:
      "The previous worker stopped. Decide the next action using the latest evidence: deliver, repair, or reverify. If repair is needed, identify the file and requirement. Return JSON with decision, target, requirement, and supporting_event_ids. Use requirement identifiers preserve_embedded_newlines, delivery_ready, or rerun_acceptance.",
    opening: [
      event("csv-local-pass", "evidence", "The small smoke fixture passed.", {
        check: "simple_csv_smoke",
        status: "passed",
        scope: "ordinary one-line cells only",
      }),
    ],
    ending: [
      event(
        "csv-final-failure",
        "evidence",
        "BLOCKER: full acceptance failed. Embedded newlines inside a quoted cell are split into separate records in src/import.ts. Preserve embedded newlines before delivery.",
        {
          check: "full_acceptance",
          status: "failed",
          file: "src/import.ts",
          errorCode: "CSV_EMBEDDED_NEWLINE",
        },
      ),
    ],
    expected: {
      decision: "repair",
      target: "src/import.ts",
      requirement: "preserve_embedded_newlines",
      supportingEvent: "csv-final-failure",
    },
  }),
  makeFixture({
    id: "late-correction",
    goal: "Produce the transaction export. The initial requested format is a CSV table named export.csv with amount values rounded to two decimals.",
    question:
      "Resume the export using the latest explicit user requirement. Return JSON with decision='continue', target set to the output filename, requirement set to one of csv_two_decimals, json_array_integer_cents, or json_object_decimal_values, and supporting_event_ids. Earlier implementation choices must not override a later user correction.",
    opening: [
      event(
        "export-original-plan",
        "decision",
        "The worker planned a CSV writer for export.csv and formatted amounts to two decimals.",
        { source: "agent" },
      ),
    ],
    ending: [
      event(
        "export-user-correction",
        "correction",
        "User correction: replace the old export specification. Output export.json as a JSON array. Each amount must be integer cents. Do not write export.csv or decimal currency values.",
        { source: "user", supersedes: "export-original-plan" },
      ),
    ],
    expected: {
      decision: "continue",
      target: "export.json",
      requirement: "json_array_integer_cents",
      supportingEvent: "export-user-correction",
    },
  }),
  makeFixture({
    id: "stale-verification",
    goal: "Deliver output/summary.json only after its current file contents pass schema_check. A past check applies only to the exact file hash that was checked.",
    question:
      "The previous worker claims the summary is ready. Using the file versions and check evidence, choose deliver, repair, or reverify. Return JSON with decision, target, requirement (delivery_ready, rerun_after_file_change, or fix_schema_error), and supporting_event_ids. A changed file is not automatically wrong, but an old passing check cannot certify it.",
    opening: [
      event("summary-check-old", "evidence", "schema_check passed.", {
        file: "output/summary.json",
        sha256: "a".repeat(64),
        check: "schema_check",
        status: "passed",
        sequence: 1,
      }),
    ],
    ending: [
      event(
        "summary-current-file",
        "evidence",
        "A later workspace observation found the file contents changed. No schema_check has been recorded for this version.",
        {
          file: "output/summary.json",
          sha256: "b".repeat(64),
          check: "file_observation",
          status: "observed",
          sequence: 2,
        },
      ),
    ],
    expected: {
      decision: "reverify",
      target: "output/summary.json",
      requirement: "rerun_after_file_change",
      supportingEvent: "summary-current-file",
    },
  }),
];

const systemPrompt =
  "You are deciding the next step at a paused task boundary. Only supplied source records are evidence. Do not invent missing results or claim to have executed work. Respect the latest explicit user correction and the scope/version of verification. Return one pure JSON object, without markdown or surrounding text, using only the requested fields. supporting_event_ids must be an array of identifiers from the supplied source. When evidence is insufficient, use decision='insufficient_evidence', empty target/requirement, and an empty supporting_event_ids array. No tools are available.";
const summaryPrompt =
  "Compress the supplied source for the next worker. Preserve the user goal, explicit corrections (including what they supersede), unresolved blockers, failed checks, file-version/check relationships, and source event IDs. Distinguish a reported conclusion from verified evidence. Remove redundant activity notes. Do not decide the final answer, add facts, or invent evidence. Return concise source-grounded notes only.";

function sharedUser(fixture, context) {
  return [
    `USER GOAL (may be amended by later user events):\n${fixture.goal}`,
    `AVAILABLE SOURCE CONTEXT:\n${context}`,
    `CURRENT QUESTION:\n${fixture.question}`,
  ].join("\n\n");
}

function evidenceContext(fixture) {
  const selected = selectReportExcerpts(
    fixture.report,
    `${fixture.goal}\n${fixture.question}`,
    1800,
  );
  // This schema is available in every full source line, and projection is based
  // solely on event type. No case-specific answer, suffix, or oracle is used.
  const fields = {
    goal: fixture.records.filter((record) => record.kind === "goal"),
    corrections: fixture.records.filter(
      (record) => record.kind === "correction",
    ),
    evidence: fixture.records.filter((record) => record.kind === "evidence"),
  };
  return {
    context: [
      `SOURCE FIELD PROJECTION:\n${JSON.stringify(fields)}`,
      "SELECTED VERBATIM REPORT EXCERPTS (character offsets):",
      ...selected.excerpts.map(
        (part) => `[${part.start}, ${part.end})\n${part.text}`,
      ),
    ].join("\n"),
    selector: {
      budgetChars: 1800,
      ...selected,
      fieldsAreExactSourceProjection: true,
    },
  };
}

function grade(fixture, text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { passed: false, checks: { validJson: false }, parsed: null };
  }
  const object =
    value !== null && typeof value === "object" && !Array.isArray(value);
  const expected = fixture.expected;
  const checks = {
    validJson: true,
    object,
    exactFields:
      object &&
      Object.keys(value).sort().join(",") ===
        "decision,requirement,supporting_event_ids,target",
    decision: object && value.decision === expected.decision,
    target: object && value.target === expected.target,
    requirement: object && value.requirement === expected.requirement,
    evidenceCitation:
      object &&
      Array.isArray(value.supporting_event_ids) &&
      value.supporting_event_ids.includes(expected.supportingEvent) &&
      value.supporting_event_ids.every((id) =>
        fixture.records.some((record) => record.id === id),
      ),
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    parsed: value,
  };
}

const runs = [];
for (let repeat = 0; repeat < repeats; repeat++) {
  for (const [caseIndex, fixture] of fixtures.entries()) {
    const shift = (caseIndex + repeat) % MODES.length;
    const order = [...MODES.slice(shift), ...MODES.slice(0, shift)];
    for (const mode of order)
      runs.push({
        repeat: repeat + 1,
        case: fixture.id,
        mode,
        sourceSha256: sha256(fixture.report),
        status: "not_started",
        calls: [],
        success: false,
        error: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        summaryTokens: 0,
        elapsedMs: 0,
      });
  }
}

if (dryRun) {
  for (const fixture of fixtures) {
    const selected = evidenceContext(fixture);
    console.log(
      JSON.stringify({
        case: fixture.id,
        sourceChars: fixture.report.length,
        sourceSha256: sha256(fixture.report),
        projectedChars: selected.context.length,
        selectedChars: selected.selector.selectedChars,
      }),
    );
    if (
      !grade(
        fixture,
        JSON.stringify({
          decision: fixture.expected.decision,
          target: fixture.expected.target,
          requirement: fixture.expected.requirement,
          supporting_event_ids: [fixture.expected.supportingEvent],
        }),
      ).passed ||
      grade(fixture, "{}").passed
    )
      throw new Error("Deterministic scorer sanity check failed");
  }
  console.log(
    JSON.stringify({
      dryRun: true,
      modelCalls: 0,
      repeats,
      plannedDecisions: runs.length,
      plannedSummaryCalls: fixtures.length * repeats,
      modeOrder: runs.map((run) => `${run.case}:${run.mode}`),
    }),
  );
} else {
  const cfg = loadConfig();
  if (!cfg.key || cfg.configurationIssue)
    throw new Error("A valid configured Model Hub account is required");
  if (cfg.provider !== "model-hub" || cfg.model !== "gpt-5.6-sol")
    throw new Error("This pilot requires Model Hub with model gpt-5.6-sol");
  const client = createModelClient(cfg, {
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 0,
  });
  const output = path.join(ROOT, "work", "memory-pilot.json");
  let knownTotalTokens = 0;
  let stoppedReason = null;
  let usageUnknown = false;
  const result = {
    meta: {
      type: "synthetic_context_fidelity_micro_pilot",
      startedAt: new Date().toISOString(),
      configuredModel: cfg.model,
      provider: cfg.provider,
      repeats,
      knownTokenLimit: TOKEN_LIMIT,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      sdkRetries: 0,
      tools: [],
      decisionMaxTokens: DECISION_MAX_TOKENS,
      summaryMaxTokens: SUMMARY_MAX_TOKENS,
      responseFormatEnforcedByPromptOnly: true,
      pricing:
        "No price table configured; token usage is not a monetary cost estimate.",
      limits: [
        "Three synthetic, deliberately lossy breakpoints; not representative real agent trajectories.",
        "No real tools, native agent compression, hidden reasoning, CLI resume, or hours-long task completion is tested.",
        "Cannot establish improved real long-running completion rate, human time, or total work cost.",
        "Every arm transforms the same source records and uses the same goal, question, model and decision parameters.",
        "Evidence memory projects structured source fields available to every arm; it never receives expected answers.",
        "Structured event labels are supplied synthetic inputs. This does not measure whether an agent or adapter can extract trustworthy facts from real unstructured logs; source collection cost is common and excluded.",
        "head_only keeps the first 4000 characters; evidence selector uses its production 1800-character budget. Character budgets are not token budgets.",
        "The LLM summary call and its usage/latency are charged to the llm_summary arm; all decision calls are charged to their arm.",
        "Failures and invalid JSON remain failed observations; no selective reruns. Default one repeat has no statistical significance.",
        "Modes run sequentially in rotating order. Shared provider caches may still influence latency and billed usage.",
        "Budget admission reserves UTF-8 request bytes + max output tokens + 2048 envelope tokens against reported known usage. Provider-added hidden overhead is not controllable; unknown usage stops all further calls.",
      ],
      prompts: { systemPrompt, summaryPrompt },
    },
    fixtures: fixtures.map((fixture) => ({
      ...fixture,
      reportChars: fixture.report.length,
      sourceSha256: sha256(fixture.report),
    })),
    runs,
    knownTotalTokens,
    usageUnknown,
    stoppedReason,
  };

  function save() {
    result.knownTotalTokens = knownTotalTokens;
    result.usageUnknown = usageUnknown;
    result.stoppedReason = stoppedReason;
    result.updatedAt = new Date().toISOString();
    result.summary = Object.fromEntries(
      MODES.map((mode) => {
        const modeRuns = runs.filter((run) => run.mode === mode);
        const attempted = modeRuns.filter((run) => run.calls.length > 0);
        return [
          mode,
          {
            scheduled: modeRuns.length,
            attempted: attempted.length,
            passed: attempted.filter((run) => run.success).length,
            failed: attempted.filter((run) => !run.success).length,
            notExecuted: modeRuns.filter((run) => run.calls.length === 0)
              .length,
            knownTokens: modeRuns.reduce(
              (sum, run) => sum + run.totalTokens,
              0,
            ),
            summaryTokens: modeRuns.reduce(
              (sum, run) => sum + run.summaryTokens,
              0,
            ),
            knownModelCostUSD: null,
            elapsedMs: modeRuns.reduce((sum, run) => sum + run.elapsedMs, 0),
          },
        ];
      }),
    );
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const temporary = `${output}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(temporary, output);
  }

  async function request(run, stage, messages, maxTokens) {
    const parameters = {
      model: cfg.model,
      messages,
      max_tokens: maxTokens,
      stream: false,
    };
    const reservedTokens =
      Buffer.byteLength(JSON.stringify(parameters), "utf8") + maxTokens + 2048;
    if (knownTotalTokens + reservedTokens > TOKEN_LIMIT) {
      stoppedReason = "known_token_budget_admission_stop";
      throw new Error(
        "Insufficient remaining token budget for the next request",
      );
    }
    const call = {
      stage,
      requestedModel: cfg.model,
      model: null,
      maxTokens,
      startedAt: new Date().toISOString(),
      elapsedMs: 0,
      sourcePromptSha256: sha256(JSON.stringify(messages)),
      inputChars: messages.reduce(
        (sum, message) => sum + message.content.length,
        0,
      ),
      reservedTokens,
      usage: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      finishReason: null,
      response: null,
      error: null,
    };
    run.calls.push(call);
    save();
    const start = Date.now();
    try {
      const response = await client.chat.completions.create(
        parameters,
        modelRequestOptions(cfg),
      );
      call.model = response.model ?? null;
      call.usage = response.usage ?? null;
      call.finishReason = response.choices?.[0]?.finish_reason ?? null;
      call.response = response.choices?.[0]?.message?.content ?? null;
      const input = response.usage?.prompt_tokens;
      const generated = response.usage?.completion_tokens;
      const reported = response.usage?.total_tokens;
      if (
        !Number.isSafeInteger(input) ||
        input < 0 ||
        !Number.isSafeInteger(generated) ||
        generated < 0
      ) {
        usageUnknown = true;
        stoppedReason = "unknown_usage";
        throw new Error(
          "Missing or invalid token usage; further calls stopped",
        );
      }
      call.inputTokens = input;
      call.outputTokens = generated;
      call.totalTokens =
        Number.isSafeInteger(reported) && reported >= input + generated
          ? reported
          : input + generated;
      knownTotalTokens += call.totalTokens;
      run.inputTokens += input;
      run.outputTokens += generated;
      run.totalTokens += call.totalTokens;
      if (stage === "summary") run.summaryTokens += call.totalTokens;
      if (knownTotalTokens >= TOKEN_LIMIT)
        stoppedReason = "known_token_limit_reached";
      if (typeof call.response !== "string" || !call.response.trim())
        throw new Error("Empty model response");
      if (call.finishReason !== "stop")
        throw new Error(`Non-final model response: ${call.finishReason}`);
      return call.response;
    } catch (error) {
      call.error = redact(error?.message ?? error);
      if (call.totalTokens === null) {
        // Transport/timeouts may already have been billed. Continuing would
        // pretend unknown spend is zero, so stop even for a failed request.
        usageUnknown = true;
        stoppedReason ||= "unknown_usage_after_request_error";
      }
      throw error;
    } finally {
      call.elapsedMs = Date.now() - start;
      save();
    }
  }

  save();
  for (const run of runs) {
    if (stoppedReason) {
      run.status = "not_executed";
      run.error = stoppedReason;
      save();
      continue;
    }
    const fixture = fixtures.find((item) => item.id === run.case);
    const started = Date.now();
    run.status = "running";
    try {
      let context;
      if (run.mode === "full") context = fixture.report;
      else if (run.mode === "head_only")
        context = fixture.report.slice(0, 4000);
      else if (run.mode === "evidence_memory") {
        const selected = evidenceContext(fixture);
        context = selected.context;
        run.selection = selected.selector;
      } else {
        context = await request(
          run,
          "summary",
          [
            { role: "system", content: summaryPrompt },
            { role: "user", content: sharedUser(fixture, fixture.report) },
          ],
          SUMMARY_MAX_TOKENS,
        );
        if (stoppedReason) throw new Error(stoppedReason);
      }
      run.context = context;
      run.contextChars = context.length;
      const response = await request(
        run,
        "decision",
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: sharedUser(fixture, context) },
        ],
        DECISION_MAX_TOKENS,
      );
      run.result = response;
      run.grading = grade(fixture, response);
      run.success = run.grading.passed;
      run.status = run.success ? "passed" : "failed";
    } catch (error) {
      run.error = redact(error?.message ?? error);
      run.success = false;
      run.status = run.calls.length ? "failed" : "not_executed";
    } finally {
      run.elapsedMs = Date.now() - started;
      save();
      console.log(
        JSON.stringify({
          repeat: run.repeat,
          case: run.case,
          mode: run.mode,
          status: run.status,
          knownTokens: run.totalTokens,
          summaryTokens: run.summaryTokens,
          elapsedMs: run.elapsedMs,
          error: run.error,
        }),
      );
    }
  }
  result.meta.finishedAt = new Date().toISOString();
  save();
  console.log(`Saved ${output}`);
  console.log(
    JSON.stringify({ knownTotalTokens, usageUnknown, stoppedReason }),
  );
}
