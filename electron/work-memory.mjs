import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { redact } from "./config.mjs";
import { estimateTokens } from "./context-budget.mjs";

const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function projectScope(workspace) {
  if (!workspace) return null;
  let worktree;
  try {
    worktree = fs.realpathSync(workspace);
  } catch {
    return null;
  }
  let repository = worktree;
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: worktree,
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const commonPath = fs.realpathSync(path.resolve(worktree, common));
    // A normal repository keeps the same identity when git is initialized in
    // an existing project; linked worktrees resolve to this same root.
    repository =
      path.basename(commonPath) === ".git"
        ? path.dirname(commonPath)
        : commonPath;
  } catch {
    /* A non-git workspace has its own scope. */
  }
  const scope = { repository: digest(repository), worktree: digest(worktree) };
  return scope;
}

export function ensureWorkMemory(state) {
  if (!state.workMemory)
    state.workMemory = {
      version: 1,
      sequence: 0,
      records: {},
      project: [],
      cursors: {},
    };
  const memory = state.workMemory;
  if (
    memory.version !== 1 ||
    !Number.isSafeInteger(memory.sequence) ||
    memory.sequence < 0 ||
    !memory.records ||
    typeof memory.records !== "object" ||
    Array.isArray(memory.records) ||
    !Array.isArray(memory.project) ||
    !memory.cursors ||
    typeof memory.cursors !== "object" ||
    Array.isArray(memory.cursors) ||
    Object.values(memory.records).some(
      (r) =>
        !r ||
        !r.scope ||
        typeof r.scope.task !== "string" ||
        !Number.isSafeInteger(r.revision) ||
        r.revision < 1 ||
        !Number.isSafeInteger(r.sequence) ||
        r.sequence < 1 ||
        !Array.isArray(r.history),
    ) ||
    memory.project.some(
      (m) =>
        !m ||
        !m.scope ||
        typeof m.scope.repository !== "string" ||
        typeof m.text !== "string" ||
        !["active", "revoked"].includes(m.status) ||
        !["feedback", "preference", "reference"].includes(m.kind) ||
        !Array.isArray(m.history),
    )
  )
    throw new Error("工作记忆格式无法读取；原存档已保留。");
  return memory;
}

function upsert(memory, key, data) {
  const fingerprint = digest(data),
    previous = memory.records[key];
  if (previous?.fingerprint === fingerprint) return false;
  const sequence = ++memory.sequence;
  memory.records[key] = {
    id: key,
    revision: (previous?.revision || 0) + 1,
    sequence,
    updatedAt: Date.now(),
    fingerprint,
    ...data,
    // Changes are infrequent canonical events, not animation ticks or tool chatter.
    history: [
      ...(previous?.history || []),
      ...(previous
        ? [
            {
              revision: previous.revision,
              sequence: previous.sequence,
              updatedAt: previous.updatedAt,
              status: previous.status,
              content: previous.content,
              source: previous.source,
            },
          ]
        : []),
    ],
  };
  return true;
}

export function syncWorkMemory(store, task, verification) {
  const memory = ensureWorkMemory(store.state);
  const root =
    store.state.tasks.find((t) => t.id === (task.rootId || task.id)) || task;
  const scope = { ...projectScope(root.workspace), task: root.id };
  let changed = false;
  const put = (key, type, status, content, source) => {
    changed =
      upsert(memory, key, { scope, type, status, content, source }) || changed;
  };
  put(
    `${root.id}:request`,
    "requirement",
    "active",
    {
      goal: redact(root.prompt || ""),
      original: redact(root.originalRequest?.content || root.prompt || ""),
    },
    {
      kind: root.originalRequest?.source || "direct_user",
      messageId: root.originalRequest?.id || null,
    },
  );
  put(
    `${root.id}:acceptance`,
    "acceptance",
    "active",
    root.contract?.checks || [],
    { kind: "user_contract" },
  );
  for (const correction of root.corrections || [])
    put(
      `${root.id}:correction:${correction.id}`,
      "correction",
      correction.active ? "active" : "revoked",
      {
        text: redact(correction.text),
        at: correction.at,
        revokedAt: correction.revokedAt || null,
      },
      { kind: correction.source || "user_correction" },
    );
  const lineage = store.state.tasks
    .filter((t) => (t.rootId || t.id) === root.id)
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const attempt of lineage) {
    put(
      `${root.id}:attempt:${attempt.id}`,
      "checkpoint",
      attempt.status,
      {
        agent: attempt.agent,
        sessionId: attempt.sessionId || null,
        blocker: redact(attempt.error || ""),
        report: attempt.reportMemory
          ? {
              id: attempt.reportMemory.id,
              sha256: attempt.reportMemory.sha256,
              truncated: attempt.reportMemory.truncated,
            }
          : null,
      },
      { kind: "executor_event", attemptId: attempt.id },
    );
  }
  if (verification)
    put(
      `${root.id}:evidence:${task.id}`,
      "evidence",
      verification.status,
      verification,
      { kind: "local_file_check", attemptId: task.id, at: verification.at },
    );
  const records = Object.values(memory.records).filter(
    (r) => r.scope.task === root.id,
  );
  const processedThrough = Math.max(0, ...records.map((r) => r.sequence));
  memory.cursors[root.id] = processedThrough;
  return {
    changed,
    summary: {
      revision: Math.max(1, ...records.map((r) => r.revision)),
      processedThrough,
      requirements:
        records.filter(
          (r) =>
            ["requirement", "correction"].includes(r.type) &&
            r.status === "active",
        ).length +
        records
          .filter((r) => r.type === "acceptance" && r.status === "active")
          .reduce((n, r) => n + r.content.length, 0),
      records: records.map(
        ({ id, revision, sequence, type, status, source }) => ({
          id,
          revision,
          sequence,
          type,
          status,
          source,
        }),
      ),
    },
  };
}

export function saveProjectMemory(
  store,
  workspace,
  { text, kind = "feedback", source, taskId = null },
) {
  const scope = projectScope(workspace);
  if (!scope) throw new Error("先选择项目目录，再保存项目记忆。");
  if (typeof text !== "string" || !text.trim() || text.length > 2000)
    throw new Error("项目记忆需为 1～2000 字符。");
  if (
    !["feedback", "preference", "reference"].includes(kind) ||
    !["user_ui", "user_message"].includes(source?.kind)
  )
    throw new Error("记忆类型或用户来源无效。");
  const memory = ensureWorkMemory(store.state),
    content = redact(text.trim());
  const existing = memory.project.find(
    (m) =>
      m.scope.repository === scope.repository &&
      m.text === content &&
      m.status === "active",
  );
  if (existing) return existing;
  if (
    memory.project.filter(
      (m) => m.scope.repository === scope.repository && m.status === "active",
    ).length >= 100
  )
    throw new Error("这个项目已有 100 条记忆，请先撤下过时内容。");
  const entry = {
    id: randomUUID(),
    revision: 1,
    scope: { repository: scope.repository },
    kind,
    text: content,
    status: "active",
    source,
    taskId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    trust: "user_confirmed",
    history: [],
  };
  memory.project.push(entry);
  store.save();
  return entry;
}

export function revokeProjectMemory(store, workspace, id) {
  const scope = projectScope(workspace),
    memory = ensureWorkMemory(store.state);
  const entry = memory.project.find(
    (m) => m.id === id && m.scope.repository === scope?.repository,
  );
  if (!entry) throw new Error("这条记忆不属于当前项目。");
  if (entry.status !== "revoked") {
    entry.history.push({
      revision: entry.revision,
      text: entry.text,
      status: entry.status,
      updatedAt: entry.updatedAt,
    });
    entry.status = "revoked";
    entry.revision++;
    entry.updatedAt = Date.now();
    store.save();
  }
  return entry;
}

export function listProjectMemories(store, workspace, query = "") {
  const scope = projectScope(workspace);
  if (!scope) return [];
  const terms = [
    ...new Set(
      String(query)
        .toLowerCase()
        .match(/[a-z0-9_-]{2,}|[\p{Script=Han}]{2,}/gu) || [],
    ),
  ];
  // Add Chinese bigrams so a full sentence isn't treated as one exact keyword.
  for (const term of [...terms])
    if (/\p{Script=Han}/u.test(term))
      for (let i = 0; i < term.length - 1 && terms.length < 80; i++)
        terms.push(term.slice(i, i + 2));
  return ensureWorkMemory(store.state)
    .project.filter((m) => m.scope.repository === scope.repository)
    .map((m) => ({
      ...m,
      score: terms.filter((t) => m.text.toLowerCase().includes(t)).length,
    }))
    .filter((m) => !query || m.score > 0 || m.kind !== "reference")
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
}

export function retrieveProjectMemory(store, workspace, query, budget = 1200) {
  const entries = listProjectMemories(store, workspace, query);
  const pinned = entries.filter((m) => m.kind !== "reference");
  const encode = (m) => ({
    id: m.id,
    revision: m.revision,
    kind: m.kind,
    status: m.status,
    text: m.text,
    trust: m.trust,
    source: m.source,
    taskId: m.taskId,
  });
  // Explicit revocations are included: a native session may still contain the old guidance.
  const selected = pinned.map(encode);
  const mandatoryTokens = estimateTokens(JSON.stringify(selected));
  let omitted = 0;
  for (const item of entries.filter((m) => m.kind === "reference")) {
    const candidate = [...selected, encode(item)];
    if (estimateTokens(JSON.stringify(candidate)) <= budget)
      selected.push(encode(item));
    else omitted++;
  }
  return {
    entries: selected,
    mandatoryTokens,
    estimatedTokens: estimateTokens(JSON.stringify(selected)),
    overBudget: mandatoryTokens > budget,
    omitted,
    retrieval: "scope_and_keyword_no_model",
  };
}
