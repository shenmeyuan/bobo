// Real Electron + isolated local child processes. No paid model/CLI calls.
import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { executeTool } from "../electron/brain.mjs";

const root = path.resolve(import.meta.dirname, "..");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-memory-ui-"));
const workspace = path.join(directory, "workspace");
const dataDirectory = path.join(directory, "data");
const stateFile = path.join(dataDirectory, "state.json");
const envFile = path.join(directory, ".env");
const previousEnvPath = process.env.BOBO_ENV_PATH;
const correction = "保留原始文件名，不生成 delivery-2.txt；恢复后重新检查。";
const blocker =
  "BLOCKER_AT_REPORT_TAIL: 必须核查当前文件版本，不能沿用旧检查。";
fs.mkdirSync(workspace);

const childScript = path.join(directory, "memory-agent.cjs");
fs.writeFileSync(
  childScript,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  try {
    if (process.argv.includes('-p')) {
      fs.writeFileSync('resume-prompt.txt', prompt);
      const start = prompt.indexOf('{"schema_version"');
      assert.ok(start >= 0, 'structured memory packet is required');
      const packet = JSON.parse(prompt.slice(start));
      const source = packet.reports.find(report => report.archive);
      assert.ok(source, 'archived public report is required');
      const allowed = path.resolve(process.cwd(), '../data/task-memory') + path.sep;
      assert.ok(source.archive.path.startsWith(allowed), 'archive must be inside this isolated test');
      // Read the referenced archive, rather than accepting the injected excerpt.
      const document = JSON.parse(fs.readFileSync(source.archive.path, 'utf8'));
      const observedHash = createHash('sha256').update(document.text).digest('hex');
      assert.equal(observedHash, source.archive.sha256);
      assert.equal(observedHash, document.sha256);
      assert.ok(document.text.length > 16000);
      assert.ok(document.text.endsWith(${JSON.stringify(blocker)}));
      assert.equal(packet.verification.status, 'stale');
      assert.ok(packet.user_corrections.some(item => item.text === ${JSON.stringify(correction)}));
      fs.writeFileSync('archive-proof.json', JSON.stringify({
        archiveId: source.archive.id, chars: document.text.length,
        hashMatches: true, tailFound: true, staleCheckObserved: true,
        correctionKept: true,
      }));
      fs.writeFileSync('delivery.txt', 'done');
      console.log(JSON.stringify({ type: 'result', result: '已读取完整报告、核对哈希并重新交付 delivery.txt。', usage: { input_tokens: 25, output_tokens: 10 } }));
    } else {
      fs.writeFileSync('delivery.txt', 'done');
      const report = '已交付 delivery.txt。公开工作报告：\\n' + '过程记录，仅作为未经独立确认的 Agent 自报。\\n'.repeat(1400) + ${JSON.stringify(blocker)};
      console.log(JSON.stringify({ type: 'thread.started', thread_id: 'memory-smoke-original' }));
      console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: report } }));
      console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 8 } }));
    }
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  }
});
`,
  { mode: 0o700 },
);
fs.writeFileSync(
  envFile,
  `OPENAI_API_KEY=sk-memory-test-local-only\nOPENAI_BASE_URL=http://127.0.0.1:1/v1\nBOBO_CODEX_PATH=${childScript}\nBOBO_CLAUDE_PATH=${childScript}\nBOBO_WORKSPACE=${workspace}\n`,
  { mode: 0o600 },
);
// executeTool runs in this test process; it must use the isolated configuration,
// just like the Electron child, without opening or changing the user's env file.
process.env.BOBO_ENV_PATH = envFile;
const environment = {
  ...process.env,
  BOBO_ENV_PATH: envFile,
  BOBO_DATA_DIR: dataDirectory,
  BOBO_TEST: "1",
};
for (const key of [
  "ELECTRON_RUN_AS_NODE",
  "BOBO_DEV_URL",
  "OPENAI_API_KEY",
  "MODEL_HUB_AK",
  "OPENAI_BASE_URL",
  "MODEL_HUB_BASE_URL",
  "MODEL_HUB_URL",
])
  delete environment[key];

let app;
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [root],
    env: environment,
  });
  const rendererErrors = [];
  const observedPages = new Set();
  const observe = (page) => {
    if (observedPages.has(page)) return;
    observedPages.add(page);
    page.on("pageerror", (error) => rendererErrors.push(error.message));
  };
  app.on("window", observe);
  const page = await app.firstWindow();
  observe(page);
  page.setDefaultTimeout(10000);
  await expect(page.locator(".pet-name")).toContainText("Bobo");
  await page.evaluate(() =>
    window.bobo.setSettings({
      allowEdits: true,
      fallbackAgents: ["codex", "claude"],
    }),
  );
  const first = await page.evaluate(() =>
    window.bobo.dispatch(
      "codex",
      "长报告与版本记忆测试",
      "交付 delivery.txt，内容必须为 done；保留既有文件名。",
      {
        checks: [{ kind: "contains", path: "delivery.txt", expected: "done" }],
        maxAttempts: 3,
        tokenLimit: null,
      },
    ),
  );
  await expect
    .poll(async () => {
      const state = await page.evaluate(() => window.bobo.getState());
      return state.tasks.find((task) => task.id === first.id)?.status;
    })
    .toBe("completed");
  const firstReport = await page.evaluate(
    (id) => window.bobo.getWorkflow(id),
    first.id,
  );
  expect(firstReport.memory.archivedReports).toBe(1);
  expect(firstReport.verification.status).toBe("passed");

  const snapshot = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const firstTask = snapshot.tasks.find((task) => task.id === first.id);
  expect(firstTask.result.length).toBeLessThanOrEqual(16000);
  expect(firstTask.result).not.toContain(blocker);
  expect(firstTask.reportMemory.chars).toBeGreaterThan(16000);
  const archived = JSON.parse(
    fs.readFileSync(firstTask.reportMemory.path, "utf8"),
  );
  expect(archived.text.endsWith(blocker)).toBe(true);
  expect(createHash("sha256").update(archived.text).digest("hex")).toBe(
    firstTask.reportMemory.sha256,
  );
  // There is no renderer read-report IPC. Exercise the actual Brain tool entry
  // directly against a read-only snapshot; this does not create a model request.
  const resultPage = executeTool(
    { file: stateFile, state: snapshot },
    null,
    "read_task_result",
    { task_id: first.id, offset: archived.text.length - blocker.length - 30 },
  );
  expect(resultPage.result).toContain(blocker);
  expect(resultPage.total_chars).toBe(archived.text.length);
  expect(resultPage.next_offset).toBeNull();

  await page.evaluate((id) => window.bobo.openPetChat(id), first.id);
  const panel = page.getByRole("region", { name: "接续与验收" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("所列检查通过");
  fs.writeFileSync(path.join(workspace, "delivery.txt"), "partial");
  const changed = await page.evaluate(
    (id) => window.bobo.getWorkflow(id),
    first.id,
  );
  expect(changed.verification.status).toBe("stale");
  // Reopening refreshes the task view; do not rerun acceptance and overwrite
  // the history whose stale state this assertion is intended to exercise.
  await page.evaluate((id) => window.bobo.openPetChat(id), first.id);
  await expect(panel).toContainText("文件有变动，旧检查已过期");

  const next = await page.evaluate(
    ({ id, note }) => window.bobo.resumeTask(id, "claude", note),
    { id: first.id, note: correction },
  );
  await expect
    .poll(async () => {
      const state = await page.evaluate(() => window.bobo.getState());
      const latest = state.tasks.find((task) => task.id === next.id);
      if (latest?.status === "failed")
        throw new Error(`Isolated continuation failed: ${latest.error}`);
      return latest?.status;
    })
    .toBe("completed");
  expect(fs.readFileSync(path.join(workspace, "delivery.txt"), "utf8")).toBe(
    "done",
  );
  const proof = JSON.parse(
    fs.readFileSync(path.join(workspace, "archive-proof.json"), "utf8"),
  );
  expect(proof).toMatchObject({
    archiveId: `task-report:${first.id}`,
    hashMatches: true,
    tailFound: true,
    staleCheckObserved: true,
    correctionKept: true,
  });
  const latestReport = await page.evaluate(
    (id) => window.bobo.getWorkflow(id),
    next.id,
  );
  expect(latestReport.memory.archivedReports).toBe(2);
  expect(latestReport.memory.assembly.totalChars).toBeGreaterThan(0);
  expect(latestReport.memory.assembly.selectedReportChars).toBeGreaterThan(0);
  expect(latestReport.memory.assembly.omittedReportChars).toBeGreaterThan(0);
  expect(latestReport.verification.status).toBe("passed");
  expect(latestReport.corrections).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        text: correction,
        active: true,
        source: "user_continuation_note",
      }),
    ]),
  );
  await page.evaluate((id) => window.bobo.openPetChat(id), next.id);
  await expect(panel).toContainText("2 次尝试");
  await expect(panel).toContainText("所列检查通过");
  const memorySummary = panel.getByText("这项工作的记忆", { exact: true });
  await memorySummary.click();
  const memoryDetails = memorySummary.locator("..");
  await expect(memoryDetails).toContainText(/2\s*份本地报告档案/);
  await expect(memoryDetails).toContainText("本次接续内容约");
  await expect(memoryDetails).toContainText("字符数不等于 Token");
  await memorySummary.scrollIntoViewIfNeeded();
  expect(rendererErrors).toEqual([]);
  const screenshot = path.join(root, "work", "memory-smoke.png");
  fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot });
  console.log(
    "PASS: real Electron/local child process long public report archive → Brain tail pagination → stale file verification/UI → cross-agent archive read + hash check + persistent user correction → renewed acceptance + memory counters; no paid model calls and no renderer errors.",
  );
} finally {
  try {
    if (app) await app.close();
  } finally {
    if (previousEnvPath === undefined) delete process.env.BOBO_ENV_PATH;
    else process.env.BOBO_ENV_PATH = previousEnvPath;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
