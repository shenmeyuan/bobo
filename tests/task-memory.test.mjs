import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  archiveTaskReport,
  readTaskReport,
  selectReportExcerpts,
} from "../electron/task-memory.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-task-memory-"));
  const previous = process.env.BOBO_ENV_PATH;
  process.env.BOBO_ENV_PATH = path.join(directory, ".env");
  fs.writeFileSync(
    process.env.BOBO_ENV_PATH,
    "OPENAI_API_KEY=test-openai-secret\nMODEL_HUB_AK=test-modelhub-secret\n",
  );
  const store = { file: path.join(directory, "state.json") };
  const task = { id: "task-123", result: "old display result" };
  t.after(() => {
    if (previous === undefined) delete process.env.BOBO_ENV_PATH;
    else process.env.BOBO_ENV_PATH = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, task };
}

test("report archive redacts configured and sk keys without the old 16k display truncation", (t) => {
  const f = fixture(t);
  const text = `${"内容 ".repeat(9000)}test-openai-secret test-modelhub-secret sk-example-long-secret 尾部未完成：发布`;
  const metadata = archiveTaskReport(f.store, f.task, text);
  f.task.reportMemory = metadata;
  assert.equal(metadata.id, "task-report:task-123");
  assert.equal(metadata.source, "agent_report");
  assert.equal(metadata.truncated, false);
  assert.ok(metadata.chars > 16000);
  const raw = fs.readFileSync(metadata.path, "utf8");
  assert.doesNotMatch(
    raw,
    /test-openai-secret|test-modelhub-secret|sk-example-long-secret/,
  );
  const document = JSON.parse(raw);
  assert.equal(document.untrusted, true);
  assert.equal(document.text.split("[已隐藏]").length - 1, 3);
  assert.match(document.text, /尾部未完成：发布$/);
  assert.equal(readTaskReport(f.store, f.task, 0, 128000).text, document.text);
  assert.equal(fs.statSync(metadata.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(metadata.path)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(metadata.path)), [
    "task-123.json",
  ]);
  let restored = "";
  let offset = 0;
  do {
    const page = readTaskReport(f.store, f.task, offset);
    assert.ok(page.text.length <= 4000);
    assert.equal(page.sha256, metadata.sha256);
    restored += page.text;
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(restored, document.text);
});

test("archive bound is explicit and replaces atomically with a verifiable next version", (t) => {
  const f = fixture(t);
  const first = archiveTaskReport(f.store, f.task, "一".repeat(128005));
  assert.equal(first.chars, 128000);
  assert.equal(first.truncated, true);
  f.task.reportMemory = first;
  const tail = readTaskReport(f.store, f.task, 127990);
  assert.equal(tail.text.length, 10);
  assert.equal(tail.nextOffset, null);
  assert.equal(tail.truncated, true);
  const second = archiveTaskReport(f.store, f.task, "新报告");
  assert.throws(() => readTaskReport(f.store, f.task), /哈希/);
  f.task.reportMemory = second;
  assert.equal(readTaskReport(f.store, f.task).text, "新报告");
  assert.notEqual(first.sha256, second.sha256);
  assert.deepEqual(fs.readdirSync(path.dirname(second.path)), [
    "task-123.json",
  ]);
});

test("archive bound does not end on half a surrogate pair", (t) => {
  const f = fixture(t);
  const metadata = archiveTaskReport(
    f.store,
    f.task,
    `${"x".repeat(127999)}🥕`,
  );
  assert.equal(metadata.chars, 127999);
  assert.equal(metadata.truncated, true);
  assert.equal(readTaskReport(f.store, f.task, 127998).text, "x");
});

test("report ids reject path traversal and read ignores metadata paths", (t) => {
  const f = fixture(t);
  for (const id of [
    "../outside",
    "/tmp/file",
    "a/b",
    "a\\b",
    ".",
    "",
    123,
    "x".repeat(161),
  ]) {
    assert.throws(() => archiveTaskReport(f.store, { id }, "text"), /标识/);
    assert.throws(() => readTaskReport(f.store, { id }), /标识/);
  }
  const metadata = archiveTaskReport(f.store, f.task, "正确的档案");
  const outside = path.join(f.directory, "outside.json");
  fs.writeFileSync(outside, "不能读取这个文件");
  f.task.reportMemory = { ...metadata, path: outside };
  const page = readTaskReport(f.store, f.task);
  assert.equal(page.text, "正确的档案");
  assert.equal(page.path, metadata.path);
  assert.equal(page.id, metadata.id);
});

test("symbolic-link report and directory are rejected without following their targets", (t) => {
  const f = fixture(t);
  const outside = path.join(f.directory, "outside");
  fs.mkdirSync(outside);
  const memory = path.join(f.directory, "task-memory");
  fs.symlinkSync(outside, memory);
  assert.throws(() => archiveTaskReport(f.store, f.task, "text"), /符号链接/);
  assert.throws(() => readTaskReport(f.store, f.task), /符号链接/);
  fs.unlinkSync(memory);
  fs.mkdirSync(memory);
  const outsideFile = path.join(outside, "report.json");
  fs.writeFileSync(outsideFile, "untouched");
  fs.symlinkSync(outsideFile, path.join(memory, "task-123.json"));
  assert.throws(() => archiveTaskReport(f.store, f.task, "text"), /符号链接/);
  assert.throws(() => readTaskReport(f.store, f.task), /符号链接/);
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "untouched");
});

test("missing or corrupted declared archives fail explicitly, never fall back to a partial result", (t) => {
  const f = fixture(t);
  f.task.reportMemory = archiveTaskReport(f.store, f.task, "原报告");
  fs.unlinkSync(f.task.reportMemory.path);
  assert.throws(() => readTaskReport(f.store, f.task), /读取失败/);
  fs.writeFileSync(f.task.reportMemory.path, "{ broken json }");
  assert.throws(() => readTaskReport(f.store, f.task), /读取失败/);
});

test("hash tampering is rejected, including content rehashed inside an archive", (t) => {
  const f = fixture(t);
  f.task.reportMemory = archiveTaskReport(f.store, f.task, "原报告");
  const document = JSON.parse(
    fs.readFileSync(f.task.reportMemory.path, "utf8"),
  );
  document.text = "新报告";
  fs.writeFileSync(f.task.reportMemory.path, JSON.stringify(document));
  assert.throws(() => readTaskReport(f.store, f.task), /哈希/);
  document.sha256 = createHash("sha256").update(document.text).digest("hex");
  fs.writeFileSync(f.task.reportMemory.path, JSON.stringify(document));
  assert.throws(() => readTaskReport(f.store, f.task), /哈希/);
});

test("legacy fallback redacts text, pages it, and identifies the legacy source limit", (t) => {
  const f = fixture(t);
  f.task.result = `test-modelhub-secret${"原文".repeat(3000)}`;
  const first = readTaskReport(f.store, f.task, 0, 10);
  assert.equal(first.legacy, true);
  assert.equal(first.path, null);
  assert.equal(first.truncationKnown, false);
  assert.equal(first.nextOffset, 10);
  assert.match(first.text, /^\[已隐藏\]/);
  const end = readTaskReport(f.store, f.task, 99999);
  assert.equal(end.text, "");
  assert.equal(end.nextOffset, null);
  for (const [offset, limit] of [
    [-1, 5],
    [0.5, 5],
    [0, 0],
    [0, 128001],
    [0, NaN],
  ])
    assert.throws(
      () => readTaskReport(f.store, f.task, offset, limit),
      /报告页/,
    );
});

function assertExcerpts(text, query, budget) {
  const result = selectReportExcerpts(text, query, budget);
  let end = -1;
  for (const excerpt of result.excerpts) {
    assert.ok(
      excerpt.start > end,
      "ranges must be disjoint and already merged",
    );
    assert.equal(excerpt.text, text.slice(excerpt.start, excerpt.end));
    assert.doesNotMatch(excerpt.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    end = excerpt.end;
  }
  assert.equal(
    result.selectedChars,
    result.excerpts.reduce((n, e) => n + e.text.length, 0),
  );
  assert.ok(result.selectedChars <= budget);
  assert.equal(result.totalChars, text.length);
  assert.equal(result.omittedChars, text.length - result.selectedChars);
  assert.deepEqual(result, selectReportExcerpts(text, query, budget));
  return result;
}

test("excerpts retain beginning, query matches and final blockers from a long single Chinese line", () => {
  const text = `任务原始要求：保持中文。${"普通过程信息".repeat(500)}缓存迁移决策：保留用户数据。${"其他无关过程".repeat(500)}最后未完成：需要取得权限。`;
  const result = assertExcerpts(text, "缓存迁移", 500);
  const selected = result.excerpts.map((e) => e.text).join("\n");
  assert.match(selected, /任务原始要求/);
  assert.match(selected, /缓存迁移决策：保留用户数据/);
  assert.match(selected, /最后未完成：需要取得权限/);
});

test("excerpt ranges preserve source offsets, merge overlap and prioritize important lines", () => {
  const text = `Header\r\n${"noise\n".repeat(40)}Decision: keep cache\r\nBlocked: permission denied\r\n${"noise\n".repeat(40)}Next: verify results\n${"noise\n".repeat(10)}End`;
  const result = assertExcerpts(text, "cache permission", 250);
  const selected = result.excerpts.map((e) => e.text).join("\n");
  assert.match(selected, /keep cache/);
  assert.match(selected, /permission denied/);
  assert.match(selected, /Next: verify results/);
});

test("excerpt budgets cover empty text, zero/tiny limits, unicode and unusual query characters", () => {
  assert.deepEqual(selectReportExcerpts("", "anything"), {
    excerpts: [],
    selectedChars: 0,
    omittedChars: 0,
    totalChars: 0,
  });
  const text = `🥕${"中文İstanbul 🥕\n".repeat(100)}最后决定：完成🥕`;
  for (const budget of [0, 1, 2, 3, 10, 19, 180, 1000, 10000])
    assertExcerpts(text, "İstanbul 中文 .* []", budget);
  assert.throws(() => selectReportExcerpts("x", "", -1), /预算/);
  assert.throws(() => selectReportExcerpts("x", "", 1.2), /预算/);
});
