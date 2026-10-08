import { rootOf } from "./workflow.mjs";

export const EXECUTORS = ["trae", "codex", "claude"];
export function failureKind(task) {
  if (task.status === "cancelled") return "cancelled";
  if (task.contextMemory?.overTokenTarget) return "context_budget";
  if (task.status === "attention") return "permission";
  const error = String(task.error || "");
  if (
    /permission|denied|unauthori[sz]ed|forbidden|authenticat|log[ -]?in|sign[ -]?in|401|403|权限|登录|认证/i.test(
      error,
    )
  )
    return "permission";
  if (
    /session.*(?:not found|missing|invalid)|会话.*(?:不存在|找不到)/i.test(
      error,
    )
  )
    return "session";
  if (
    /quota|rate.?limit|429|credit|usage limit|额度|限流|限额|余额/i.test(error)
  )
    return "quota";
  if (
    /ECONN|ENET|ETIMEDOUT|fetch failed|connection|network|socket|502|503|504|temporar|网络|连接|超时|超过 30 分钟|timeout/i.test(
      error,
    )
  )
    return "transient";
  if (task.status === "completed" && task.verification?.status === "failed")
    return "verification";
  if (task.status === "interrupted") return "interrupted";
  return "unknown";
}

// No LLM polling. Only confirmed terminal events can trigger recovery.
export class Supervisor {
  constructor(manager, { now = () => Date.now(), retryDelayMs = 10000 } = {}) {
    this.manager = manager;
    this.store = manager.store;
    this.now = now;
    this.delay = retryDelayMs;
    this.started = false;
    this.timer = null;
  }
  start({ interval = true } = {}) {
    if (this.started) return;
    this.started = true;
    if (interval) {
      this.timer = setInterval(() => this.tick(), 2000);
      this.timer.unref();
    }
    // Resume only explicitly supervised unfinished chains, never historical ordinary tasks.
    for (const task of this.store.state.tasks) {
      const root = rootOf(this.store, task);
      if (
        root.supervision?.enabled &&
        ["interrupted", "failed", "attention", "completed"].includes(
          task.status,
        ) &&
        !task.childId &&
        !root.supervision.pending
      )
        this.settle(task);
    }
  }
  stop() {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  event(root, task, kind, text) {
    const state = root.supervision;
    state.events ||= [];
    state.events.push({ at: this.now(), taskId: task.id, kind, text });
    state.events = state.events.slice(-80);
  }
  attention(root, task, text) {
    root.supervision.state = "attention";
    root.supervision.pending = null;
    root.supervision.reason = text;
    this.event(root, task, "attention", text);
    this.store.save();
    this.manager.onComplete(task, text);
  }
  settle(task) {
    const root = rootOf(this.store, task),
      state = root.supervision;
    if (
      !this.started ||
      !state?.enabled ||
      !this.store.state.settings.superviseTasks ||
      task.childId
    )
      return false;
    if (state.pending?.taskId === task.id || state.handledAttempt === task.id)
      return true;
    state.handledAttempt = task.id;
    if (task.status === "cancelled") {
      state.state = "paused";
      state.pending = null;
      state.reason = "你停止了任务，Bobo 不会自动重启。";
      this.event(root, task, "paused", state.reason);
      this.store.save();
      return false;
    }
    if (task.status === "completed" && task.verification?.status !== "failed") {
      state.state = "done";
      state.pending = null;
      state.reason =
        task.verification?.status === "passed"
          ? "所列检查通过。"
          : "执行结束；没有配置完整验收条件。";
      this.event(root, task, "done", state.reason);
      this.store.save();
      return false;
    }
    const kind = failureKind(task),
      report = this.manager.report(task.id);
    task.failureKind = kind;
    if (kind === "permission" || kind === "unknown" || kind === "context_budget") {
      this.attention(
        root,
        task,
        kind === "context_budget"
          ? "上下文预算不足，执行器尚未启动；请拆分任务或调整交接上下文预算。"
          : kind === "permission"
          ? "任务需要登录、权限或你的决定；Bobo 已停止自动恢复。"
          : "任务停止，但原因尚不明确；Bobo 没有盲目重试。",
      );
      return true;
    }
    if (report.attempts.length >= report.contract.maxAttempts) {
      this.attention(root, task, "已达到尝试次数上限，Bobo 停下来等你决定。");
      return true;
    }
    const lineage = this.store.state.tasks.filter(
      (t) => (t.rootId || t.id) === root.id,
    );
    if (
      lineage.filter((t) => t.failureKind === kind).length >= 2 &&
      kind !== "quota"
    ) {
      this.attention(root, task, "同类问题再次出现，Bobo 停止重复尝试。");
      return true;
    }
    let target = task.agent;
    if (kind === "quota") {
      const available = this.manager
        .list()
        .filter((a) => a.capability === "cli" && a.installed)
        .map((a) => a.id);
      const exhausted = new Set(
        lineage.filter((t) => t.failureKind === "quota").map((t) => t.agent),
      );
      target = state.allowedAgents.find(
        (id) => available.includes(id) && !exhausted.has(id),
      );
      if (!target) {
        this.attention(
          root,
          task,
          "可用且获准接手的 Agent 都无法继续，Bobo 等你调整额度或接手名单。",
        );
        return true;
      }
    }
    const reason =
      kind === "quota"
        ? `当前 Agent 报告限额，准备交给 ${target}。`
        : kind === "verification"
          ? "产物检查没有通过，准备带着失败条件修正一次。"
          : "检测到可恢复中断，等待原进程退出后继续。";
    state.state = "recovering";
    state.reason = reason;
    state.pending = {
      taskId: task.id,
      target,
      kind,
      at: this.now() + this.delay,
    };
    this.event(root, task, "scheduled", reason);
    this.store.save();
    return true;
  }
  tick() {
    if (!this.started) return;
    let changed = false;
    for (const task of this.store.state.tasks) {
      if (task.status === "running" && this.manager.running.has(task.id)) {
        const quiet =
          this.now() - (task.lastActivityAt || task.createdAt) > 180000;
        if (Boolean(task.quiet) !== quiet) {
          task.quiet = quiet;
          changed = true;
        }
      }
    }
    if (changed) this.store.save();
    for (const root of [...this.store.state.tasks]) {
      const state = root.supervision,
        pending = state?.pending;
      if (
        !pending ||
        !state.enabled ||
        !this.store.state.settings.superviseTasks ||
        pending.at > this.now()
      )
        continue;
      const task = this.manager.task(pending.taskId);
      if (task.childId) {
        state.pending = null;
        state.state = "watching";
        this.store.save();
        continue;
      }
      if (this.manager.isProcessRunning(task)) {
        if (this.now() - pending.at > 60000)
          this.attention(
            root,
            task,
            "原执行进程仍未退出，Bobo 没有启动重复任务。",
          );
        continue;
      }
      try {
        // Persist dequeue before dispatch; handledAttempt makes replay idempotent.
        state.pending = null;
        const note =
          pending.kind === "verification"
            ? `修复这些未通过的检查，不改变原始要求：${JSON.stringify(task.verification.checks.filter((c) => !c.passed).map(({ kind, path }) => ({ kind, path }))).slice(0, 1800)}`
            : "Bobo 检测到中断，请从已有进展继续，避免重复执行已完成的操作。";
        const next = this.manager.resume(task.id, pending.target, note, {
          automatic: true,
          forceFresh: pending.kind === "session",
        });
        if (this.manager.task(next.id).status !== "running") continue;
        state.state = "watching";
        state.reason = `已由 ${pending.target} 自动接续。`;
        this.event(root, this.manager.task(next.id), "resumed", state.reason);
        this.store.save();
      } catch (error) {
        this.attention(root, task, `自动恢复暂停：${error.message}`);
      }
    }
  }
  configure(id, enabled, allowedAgents) {
    const task = this.manager.task(id),
      root = rootOf(this.store, task);
    if (enabled && !this.store.state.settings.superviseTasks)
      throw new Error("请先在设置中打开自动照看。");
    if (task.agent === "doubao")
      throw new Error("豆包手动转交尚不支持自动照看。");
    if (
      typeof enabled !== "boolean" ||
      !Array.isArray(allowedAgents) ||
      !allowedAgents.length ||
      allowedAgents.some((a) => !EXECUTORS.includes(a))
    )
      throw new Error("请选择可以接手的 Agent。");
    root.supervision ||= { events: [] };
    Object.assign(root.supervision, {
      enabled,
      allowedAgents: [...new Set(allowedAgents)],
      pending: null,
      state: enabled ? "watching" : "paused",
      reason: enabled ? "Bobo 正在照看这项工作。" : "已暂停自动恢复。",
    });
    root.supervision.handledAttempt = null;
    this.event(
      root,
      task,
      enabled ? "enabled" : "paused",
      root.supervision.reason,
    );
    this.store.save();
    const latest = this.store.state.tasks.find(
      (t) => (t.rootId || t.id) === root.id && !t.childId,
    );
    if (
      enabled &&
      latest &&
      !["running", "handoff", "queued", "cancelled"].includes(latest.status)
    )
      this.settle(latest);
    return this.manager.report(id);
  }
}
