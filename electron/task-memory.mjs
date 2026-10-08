import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { loadConfig } from "./config.mjs";

const MAX_REPORT_CHARS = 128000;
const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// Reports remain untrusted source data. Only this module's derived local path is
// read: a path or instruction inside a report (or task metadata) is never followed.
function reportLocation(store, task, create = false) {
  if (
    !task ||
    typeof task.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,160}$/.test(task.id)
  )
    throw new Error("任务报告标识无效。");
  if (typeof store?.file !== "string" || !store.file)
    throw new Error("任务存档位置无效。");
  const base = fs.realpathSync(path.dirname(path.resolve(store.file)));
  const directory = path.join(base, "task-memory");
  let info;
  try {
    info = fs.lstatSync(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (create) {
      fs.mkdirSync(directory, { mode: 0o700 });
      info = fs.lstatSync(directory);
    }
  }
  if (info && (info.isSymbolicLink() || !info.isDirectory()))
    throw new Error("任务记忆目录不能是符号链接或普通文件。");
  if (info && create) fs.chmodSync(directory, 0o700);
  const file = path.join(directory, `${task.id}.json`);
  try {
    const existing = fs.lstatSync(file);
    if (existing.isSymbolicLink() || !existing.isFile())
      throw new Error("任务报告不能是符号链接或非普通文件。");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { directory, file };
}

function redactReport(value) {
  let text = String(value ?? "");
  // Deliberately do not use config.redact(), whose display limit is 16000 chars.
  for (const key of loadConfig().redactionKeys)
    text = text.split(key).join("[已隐藏]");
  return text.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[已隐藏]");
}

function safeEnd(text, end) {
  // Do not leave half an emoji at the end of a bounded excerpt or archive.
  if (
    end > 0 &&
    end < text.length &&
    /[\uD800-\uDBFF]/.test(text[end - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[end])
  )
    return end - 1;
  return end;
}

export function archiveTaskReport(
  store,
  task,
  text,
  { sourceIncomplete = false } = {},
) {
  const { file } = reportLocation(store, task, true);
  const redacted = redactReport(text);
  const content = redacted.slice(
    0,
    safeEnd(redacted, Math.min(redacted.length, MAX_REPORT_CHARS)),
  );
  const metadata = {
    id: `task-report:${task.id}`,
    path: file,
    chars: content.length,
    sha256: hash(content),
    truncated: sourceIncomplete || content.length < redacted.length,
    source: "agent_report",
  };
  const document = {
    schemaVersion: 1,
    id: metadata.id,
    source: metadata.source,
    untrusted: true,
    chars: metadata.chars,
    sha256: metadata.sha256,
    truncated: metadata.truncated,
    text: content,
  };
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(document, null, 2), "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return metadata;
}

export function readTaskReport(store, task, offset = 0, limit = 4000) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_REPORT_CHARS
  )
    throw new Error("报告页位置需为非负整数，读取长度需为 1～128000 字符。");
  const { file } = reportLocation(store, task);
  let document;
  let legacy = false;
  let descriptor;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.size > 1100000)
      throw new Error("任务报告文件类型或大小无效。");
    document = JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && !task.reportMemory) {
      const text = redactReport(task.result || "");
      legacy = true;
      document = {
        schemaVersion: 1,
        id: `task-report:${task.id}`,
        source: "agent_report",
        text,
        chars: text.length,
        sha256: hash(text),
        // Legacy storage cannot reveal whether its old display limit lost text.
        truncated: false,
      };
    } else {
      throw new Error(`任务报告读取失败：${error.message}`);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  if (
    document?.schemaVersion !== 1 ||
    document.id !== `task-report:${task.id}` ||
    document.source !== "agent_report" ||
    typeof document.text !== "string" ||
    typeof document.truncated !== "boolean" ||
    document.chars !== document.text.length ||
    (!legacy && document.text.length > MAX_REPORT_CHARS) ||
    hash(document.text) !== document.sha256 ||
    (task.reportMemory?.sha256 && task.reportMemory.sha256 !== document.sha256)
  )
    throw new Error(
      "任务报告格式或哈希校验失败，不能将它作为已保存的原报告读取。",
    );
  const end = Math.min(offset + limit, document.text.length);
  return {
    id: `task-report:${task.id}`,
    path: legacy ? null : file,
    text: document.text.slice(offset, end),
    totalChars: document.text.length,
    nextOffset: end < document.text.length ? end : null,
    sha256: document.sha256,
    truncated: document.truncated,
    source: "agent_report",
    ...(legacy ? { legacy: true, truncationKnown: false } : {}),
  };
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// This selects exact source spans; it never asks a model to invent a summary.
// All offsets and budgets count JavaScript UTF-16 characters, not model tokens.
export function selectReportExcerpts(text, query, budgetChars = 1800) {
  text = String(text ?? "");
  if (!Number.isSafeInteger(budgetChars) || budgetChars < 0)
    throw new Error("报告片段预算需为非负整数。");
  const budget = Math.min(budgetChars, text.length);
  let ranges = [];
  const used = () =>
    ranges.reduce((n, range) => n + range.end - range.start, 0);
  const add = (start, end, anchor = start) => {
    start = Math.max(0, start);
    end = Math.min(text.length, end);
    let parts = [{ start, end }];
    for (const existing of ranges)
      parts = parts.flatMap((part) => {
        if (existing.end <= part.start || existing.start >= part.end)
          return [part];
        const result = [];
        if (part.start < existing.start)
          result.push({ start: part.start, end: existing.start });
        if (part.end > existing.end)
          result.push({ start: existing.end, end: part.end });
        return result;
      });
    parts.sort(
      (a, b) =>
        Math.max(a.start - anchor, anchor - a.end, 0) -
        Math.max(b.start - anchor, anchor - b.end, 0),
    );
    for (const part of parts) {
      const remaining = budget - used();
      if (!remaining) break;
      if (part.end - part.start > remaining) {
        part.start = Math.max(
          part.start,
          Math.min(anchor - Math.floor(remaining / 2), part.end - remaining),
        );
        part.end = part.start + remaining;
      }
      if (/[\uDC00-\uDFFF]/.test(text[part.start] || "")) part.start++;
      part.end = safeEnd(text, part.end);
      if (part.end > part.start) ranges.push(part);
      ranges.sort((a, b) => a.start - b.start);
      ranges = ranges.reduce((merged, range) => {
        const previous = merged.at(-1);
        if (previous && range.start <= previous.end)
          previous.end = Math.max(previous.end, range.end);
        else merged.push({ ...range });
        return merged;
      }, []);
    }
  };
  if (text.length <= budget) add(0, text.length);
  else if (budget) {
    // Reserve both ends before relevance selection; conclusions often occur at
    // the end of a single long line, which line-only selection would lose.
    const head = Math.floor(budget * 0.2);
    const tail = Math.max(1, Math.floor(budget * 0.3));
    add(0, head);
    add(text.length - tail, text.length, text.length);
    const candidates = [];
    const terms = [
      ...new Set(String(query ?? "").match(/[\p{L}\p{N}_-]{2,64}/gu) || []),
    ].slice(0, 32);
    for (const term of terms) {
      const expression = new RegExp(escapeRegExp(term), "giu");
      let match;
      let count = 0;
      while ((match = expression.exec(text)) && count++ < 8)
        candidates.push({
          at: match.index,
          length: match[0].length,
          priority: 2,
        });
    }
    const important =
      /阻塞|阻碍|失败|未完成|待办|下一步|尚未|未解决|风险|结论|决定|决策|\b(?:blocked|blocker|failed|failure|unfinished|todo|next|decision|pending|remaining|error)\b/giu;
    let match;
    while ((match = important.exec(text)) && candidates.length < 320)
      candidates.push({
        at: match.index,
        length: match[0].length,
        priority: 1,
      });
    candidates.sort((a, b) => b.priority - a.priority || b.at - a.at);
    for (const candidate of candidates) {
      if (used() >= budget) break;
      const span = Math.min(360, Math.max(40, Math.floor(budget * 0.25)));
      const lineStart = text.lastIndexOf("\n", candidate.at - 1) + 1;
      const newline = text.indexOf("\n", candidate.at);
      const lineEnd = newline < 0 ? text.length : newline + 1;
      if (lineEnd - lineStart <= span) add(lineStart, lineEnd, candidate.at);
      else {
        const start = Math.max(lineStart, candidate.at - Math.floor(span / 3));
        add(start, Math.min(lineEnd, start + span), candidate.at);
      }
    }
    // Fill unused space with additional ending and opening context, not padding.
    if (used() < budget) add(text.length - budget, text.length, text.length);
    if (used() < budget) add(0, budget);
  }
  const selectedChars = used();
  return {
    excerpts: ranges.map(({ start, end }) => ({
      start,
      end,
      text: text.slice(start, end),
    })),
    selectedChars,
    omittedChars: text.length - selectedChars,
    totalChars: text.length,
  };
}
