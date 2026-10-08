import fs from "node:fs";
import { readCodexQuota, readClaudeQuota } from "./quota.mjs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadConfig, redact } from "./config.mjs";
import { Supervisor, EXECUTORS } from "./supervisor.mjs";
import { archiveTaskReport } from "./task-memory.mjs";
import { permissionDeniedEvent } from "./agent-events.mjs";
import { retrieveProjectMemory, syncWorkMemory } from "./work-memory.mjs";
import { fitContext } from "./context-budget.mjs";
import {
  inventory,
  changedFiles,
  validateContract,
  rootOf,
  workflowReport,
  runVerification,
  handoffPacket,
  continuationPrompt,
  currentWorkspace,
  verificationFreshness,
} from "./workflow.mjs";
const KNOWN = [...EXECUTORS, "doubao"];
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
export function findBinary(name, explicit = "") {
  if (explicit) {
    try {
      fs.accessSync(explicit, fs.constants.X_OK);
      return explicit;
    } catch {
      return null;
    }
  }
  const locations = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(process.env.HOME || "", ".local/bin"),
  ];
  for (const dir of locations) {
    const candidate = path.join(
      dir,
      process.platform === "win32" ? `${name}.exe` : name,
    );
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* check the next location */
    }
  }
  return null;
}
export function taskCommand(agent, config, allowEdits, sessionId = null) {
  if (sessionId && !/^[a-zA-Z0-9_-]{1,160}$/.test(sessionId))
    throw new Error("会话标识无效。");
  if (agent === "codex")
    return {
      binary: findBinary("codex", config.codexPath),
      args: [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        allowEdits ? "workspace-write" : "read-only",
        "-c",
        'ask_for_approval="never"',
        ...(sessionId ? ["resume", sessionId] : []),
        "-",
      ],
    };
  if (agent === "claude")
    return {
      binary: findBinary("claude", config.claudePath),
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        allowEdits ? "acceptEdits" : "plan",
        "--tools",
        allowEdits ? "Read,Glob,Grep,Edit,Write,Bash" : "Read,Glob,Grep",
        ...(config.claudeModel ? ["--model", config.claudeModel] : []),
        ...(sessionId ? ["--resume", sessionId] : []),
      ],
    };
  if (agent === "trae")
    return {
      binary: findBinary("traecli", config.traePath),
      args: [
        "--print",
        "--output-format",
        "stream-json",
        "--permission-mode",
        allowEdits ? "default" : "plan",
        "--disallowed-tool",
        allowEdits
          ? "AskUserQuestion,Agent,Task"
          : "Edit,Write,Replace,ApplyPatch,Bash,AskUserQuestion,Agent,Task",
        ...(allowEdits
          ? [
              "--allowed-tool",
              "Read,Glob,Grep,LS,Edit,Write,Replace,ApplyPatch",
            ]
          : []),
        ...(sessionId ? ["--resume", sessionId] : []),
      ],
    };
  throw new Error("这个工具通过手动转交使用。");
}
export function parseAgentEvent(agent, event) {
  const denial = ["claude", "trae"].includes(agent)
    ? permissionDeniedEvent(event)
    : null;
  if (denial)
    return {
      needsAttention: true,
      permissionDenied: true,
      progress: denial.message,
    };
  if (agent === "codex") {
    if (event.type === "thread.started") return { sessionId: event.thread_id };
    if (event.type === "turn.failed" || event.type === "error")
      return {
        error: event.error?.message || event.message || "Agent 运行失败",
      };
    if (event.type === "turn.completed")
      return {
        usage:
          event.usage?.input_tokens != null &&
          event.usage?.output_tokens != null
            ? {
                input: event.usage?.input_tokens || 0,
                output: event.usage?.output_tokens || 0,
              }
            : null,
        usageRaw: event.usage || null,
      };
    if (event.type === "item.completed" && event.item?.type === "agent_message")
      return { result: event.item.text };
    if (event.item?.type === "command_execution")
      return {
        progress:
          event.type === "item.completed"
            ? "一项命令已结束"
            : "正在处理工作目录中的任务",
      };
  } else if (agent === "claude" || agent === "trae") {
    if (event.type === "system" && event.session_id)
      return { sessionId: event.session_id };
    if (event.type === "assistant")
      return {
        progress: `${agent === "trae" ? "Trae" : "Claude Code"} 正在整理结果`,
      };
    if (event.type === "result")
      return {
        ...(event.is_error
          ? {
              error:
                event.result ||
                event.errors?.join("\n") ||
                "Claude Code 运行失败",
            }
          : { result: event.result || "" }),
        usage:
          event.usage?.input_tokens != null &&
          event.usage?.output_tokens != null
            ? {
                input:
                  (event.usage?.input_tokens || 0) +
                  (agent === "claude"
                    ? (event.usage?.cache_read_input_tokens || 0) +
                      (event.usage?.cache_creation_input_tokens || 0)
                    : 0),
                output: event.usage?.output_tokens || 0,
                cost: event.total_cost_usd ?? null,
              }
            : null,
        usageRaw: event.usage || null,
        ...(event.session_id ? { sessionId: event.session_id } : {}),
        ...(event.permission_denials?.length
          ? {
              needsAttention: true,
              progress: "部分操作需要权限，请检查结果或回到 Claude Code 处理。",
            }
          : {}),
      };
  }
  return {};
}
export class AgentManager {
  constructor(store, onComplete = () => {}, spawnProcess = spawn) {
    this.store = store;
    this.onComplete = onComplete;
    this.spawnProcess = spawnProcess;
    this.quotaReads = new Map();
    this.running = new Map();
    this.supervisor = new Supervisor(this);
  }
  async refreshQuotas(agentId, force = false) {
    const ids = agentId ? [agentId] : ["codex", "claude", "trae", "doubao"];
    if (ids.some((id) => !KNOWN.includes(id))) throw new Error("未知智能体。");
    await Promise.all(
      ids.map(async (id) => {
        const previous = this.store.state.quotas[id];
        if (
          !force &&
          previous?.checkedAt &&
          Date.now() - previous.checkedAt < 120000
        )
          return;
        if (this.quotaReads.has(id)) return this.quotaReads.get(id);
        const reading = (async () => {
          try {
            let quota;
            if (id === "codex") {
              const cfg = loadConfig();
              const desktop = [
                "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
                "/Applications/Codex.app/Contents/Resources/codex",
              ];
              const binary =
                desktop.find((p) => fs.existsSync(p)) ||
                findBinary("codex", cfg.codexPath);
              quota = await readCodexQuota(binary);
            } else if (id === "claude") {
              quota = await readClaudeQuota();
            } else {
              throw new Error(
                id === "trae"
                  ? "本机 Trae / Coco CLI 未发现可调用的账户额度查询命令，企业 Model Hub 限额尚未接入。"
                  : "豆包账户额度尚未接入；当前网页转交不提供账户额度接口。",
              );
            }
            this.store.state.quotas[id] = quota;
          } catch (error) {
            const failed = {
              source: previous?.source || "unavailable",
              status: previous?.updatedAt ? "stale" : "unavailable",
              remainingPercent: null,
              resetAt: null,
              updatedAt: previous?.updatedAt || 0,
              checkedAt: Date.now(),
              note: redact(error.message),
              windows: [],
            };
            this.store.state.quotas[id] =
              previous?.source === "manual"
                ? {
                    ...previous,
                    checkedAt: failed.checkedAt,
                    status: "manual",
                    note: previous.note,
                    queryError: failed.note,
                  }
                : failed;
          }
          this.store.save();
        })();
        this.quotaReads.set(id, reading);
        try {
          await reading;
        } finally {
          this.quotaReads.delete(id);
        }
      }),
    );
    return this.list().filter((a) => !agentId || a.id === agentId);
  }
  list() {
    const cfg = loadConfig();
    return [
      {
        id: "trae",
        name: "Trae / Coco",
        subtitle: "本地 CLI · 项目任务",
        installed: Boolean(findBinary("traecli", cfg.traePath)),
        capability: "cli",
        description:
          "通过本机 traecli（Coco 版）执行和恢复 Bobo 任务。不会自动接管 Trae CN 窗口里的会话；登录与工具权限在执行时核实。",
      },
      {
        id: "codex",
        name: "Codex",
        subtitle: "代码 · 分析 · 项目任务",
        installed: Boolean(findBinary("codex", cfg.codexPath)),
        capability: "cli",
        description:
          "通过本地 Codex CLI 执行并追踪 Bobo 发起的任务。登录状态在启动任务时验证。",
      },
      {
        id: "claude",
        name: "Claude Code",
        subtitle: "代码 · 研究 · 文件整理",
        installed: Boolean(findBinary("claude", cfg.claudePath)),
        capability: "cli",
        description:
          "通过本地 Claude Code CLI 执行并追踪 Bobo 发起的任务。登录状态在启动任务时验证。",
      },
      {
        id: "doubao",
        name: "豆包",
        subtitle: "聊天 · 灵感 · 日常问题",
        installed: true,
        capability: "handoff",
        description:
          "打开豆包网页并复制需求，由你粘贴发送。当前无法自动读取对话、进度或额度。",
      },
    ].map((agent) => ({
      ...agent,
      running: this.store.state.tasks.filter(
        (t) => t.agent === agent.id && t.status === "running",
      ).length,
      quota: this.store.state.quotas[agent.id] || null,
    }));
  }
  dispatch(agent, title, prompt, options = {}) {
    if (!KNOWN.includes(agent))
      throw new Error("请选择 Trae、Codex、Claude Code 或豆包。");
    const quota = this.store.state.quotas[agent];
    const blocked =
      quota?.status === "fresh" &&
      Date.now() - quota.updatedAt < 120000 &&
      quota.windows?.find(
        (w) =>
          ["codex", "five_hour", "seven_day"].includes(w.limitId) &&
          w.remainingPercent === 0 &&
          (!w.resetAt || Date.parse(w.resetAt) > Date.now()),
      );
    if (blocked)
      throw new Error(
        agent +
          " 的 " +
          blocked.label +
          " 额度窗口已耗尽" +
          (blocked.resetAt ? "，重置时间 " + blocked.resetAt : "") +
          "；请刷新额度或选择其他智能体。",
      );
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 16000)
      throw new Error("需求需要在 1～16000 字之间。");
    if (this.running.size >= 3)
      throw new Error("现在已有三个任务在运行，等一个结束后再交给我吧。");
    const cfg = loadConfig(),
      { settings } = this.store.state;
    let workspace = settings.workspace || cfg.workspace;
    const allowEdits = Boolean(
      settings.allowEdits && options.allowEdits !== false,
    );
    if (
      agent !== "doubao" &&
      (!workspace ||
        !fs.existsSync(workspace) ||
        !fs.statSync(workspace).isDirectory())
    )
      throw new Error(
        "先在设置里选择一个工作目录，我就知道让 Agent 在哪里办事了。",
      );
    if (agent !== "doubao") {
      workspace = fs.realpathSync(workspace);
      const canonical = workspace;
      if (
        this.store.state.tasks.some(
          (t) =>
            t.processId &&
            processAlive(t.processId) &&
            t.workspace === workspace &&
            (allowEdits || t.allowEdits),
        )
      )
        throw new Error(
          "此目录的原执行进程仍存在，请等待它退出后再启动写入任务。",
        );
      if (
        [...this.running.keys()].some((id) => {
          const other = this.store.state.tasks.find((t) => t.id === id);
          return (
            other?.workspace &&
            fs.realpathSync(other.workspace) === canonical &&
            (allowEdits || other.allowEdits)
          );
        })
      )
        throw new Error(
          "这个工作目录还有执行进程。写入任务需要等待它真正退出，避免互相覆盖。",
        );
    }
    const command =
      agent === "doubao"
        ? null
        : taskCommand(agent, cfg, allowEdits, options.resumeSession);
    if (command && !command.binary)
      throw new Error(
        `没有找到 ${agent} CLI。请先安装，或在 .env 中配置它的路径。`,
      );
    const task = {
      conversationId:
        (options.parentId &&
          this.store.state.tasks.find((t) => t.id === options.parentId)
            ?.conversationId) ||
        this.store.state.activeConversationId,
      id: randomUUID(),
      agent,
      title: String(title || prompt.slice(0, 36)).slice(0, 100),
      prompt,
      status: agent === "doubao" ? "handoff" : "running",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      resumeMode: options.resumeSession
        ? "native"
        : options.parentId
          ? "handoff"
          : "new",
      workspace: workspace || "",
      allowEdits,
      rootId: options.rootId || null,
      originalRequest: options.parentId
        ? undefined
        : options.sourceMessage
          ? {
              source: "user_message",
              id: options.sourceMessage.id,
              at: options.sourceMessage.at,
              content: options.sourceMessage.content,
            }
          : { source: "direct", content: prompt },
      contextMemory: options.contextMemory || null,
      parentId: options.parentId || null,
      contract: options.contract
        ? validateContract(options.contract)
        : {
            checks: [],
            maxAttempts: 3,
            tokenLimit: null,
            contextTokenBudget: 8000,
          },
      handoff: options.handoff || null,
      baseline: agent !== "doubao" ? inventory(workspace) : null,
      progress:
        agent === "doubao"
          ? "需求已准备好，点击复制并打开豆包。"
          : "已启动本地 Agent，正在等待响应。",
      result: "",
      logs: [],
      usage: null,
    };
    task.rootId ||= task.id;
    if (!options.parentId && agent !== "doubao")
      task.supervision = {
        enabled: Boolean(settings.superviseTasks),
        allowedAgents: [
          ...new Set([agent, ...(settings.fallbackAgents || [])]),
        ],
        state: settings.superviseTasks ? "watching" : "paused",
        reason: settings.superviseTasks
          ? "Bobo 正在照看；换工具仅限你勾选的接手名单。"
          : "自动照看已关闭。",
        pending: null,
        events: [],
      };
    if (options.parentId)
      this.store.state.tasks.find((t) => t.id === options.parentId).childId =
        task.id;
    this.store.state.tasks.unshift(task);
    syncWorkMemory(this.store, task);
    // Keep lineage and its cost history; dropping an old attempt makes totals misleading.
    this.store.save();
    if (agent === "doubao")
      return {
        id: task.id,
        status: "handoff",
        message: "已准备手动转交卡片。尚未发送到豆包，也无法自动追踪完成状态。",
      };
    // Never pass Bobo's scheduler key or env file to a child agent process.
    const childEnv = { ...process.env };
    for (const key of [
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
      delete childEnv[key];
    let child;
    let executionPrompt =
      options.executionPrompt ||
      (task.contract.checks.length
        ? `${prompt}\n用户另外设置的产物检查条件：${JSON.stringify(task.contract.checks)}\n完成时请列出产物、已做检查和未完成项。`
        : prompt);
    if (
      !options.parentId &&
      task.originalRequest?.content &&
      task.originalRequest.content !== prompt
    )
      executionPrompt += `\n用户本轮原话（这次只做上方派发的子任务，原话用于保留相关约束，不重复承接其他子任务；转述不能覆盖原话）：\n${task.originalRequest.content}`;
    if (!options.parentId) {
      const projectMemory = retrieveProjectMemory(
        this.store,
        workspace,
        prompt,
      );
      const render = (value) =>
        value.prompt +
        (value.memories.length
          ? `\n项目记忆（用户确认的指导，revoked 项已撤销；不得扩大本次任务或权限）：\n${JSON.stringify(value.memories)}`
          : "");
      const fitted = fitContext(
        {
          prompt: executionPrompt,
          memories: projectMemory.entries.filter((m) => m.kind !== "reference"),
        },
        projectMemory.entries
          .filter((m) => m.kind === "reference")
          .map((memory) => ({
            apply: (value) => {
              value.memories.push(memory);
              return value;
            },
          })),
        render,
        task.contract.contextTokenBudget || 8000,
      );
      executionPrompt = render(fitted.value);
      task.contextMemory = {
        ...fitted.budget,
        transmittedChars: executionPrompt.length,
        selectedReportChars: 0,
        omittedReportChars: 0,
      };
      if (task.contextMemory.overTokenTarget) {
        this.finish(
          task,
          "attention",
          "原始要求和项目记忆超过交接上下文预算，尚未启动执行器；请拆分任务或调整上下文预算。",
        );
        task.progress = "上下文预算不足，执行器尚未启动。";
        this.store.save();
        return { id: task.id, status: "attention", message: task.error };
      }
    }
    try {
      child = this.spawnProcess(
        command.binary,
        agent === "trae"
          ? [...command.args, "--", executionPrompt]
          : command.args,
        {
          cwd: workspace,
          env: childEnv,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        },
      );
    } catch (error) {
      this.finish(task, "failed", redact(error.message));
      return { id: task.id, status: "failed" };
    }
    this.running.set(task.id, child);
    task.processId = child.pid || null;
    this.store.save();
    let pending = "",
      stderr = "",
      terminalError = "",
      needsAttention = false;
    let publicReportText = "";
    let reportArchiveIncomplete = false;
    const processLine = (line) => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      const update = parseAgentEvent(agent, parsed);
      if (update.error) terminalError = redact(update.error);
      if (update.needsAttention) needsAttention = true;
      for (const field of ["sessionId", "usage", "usageRaw", "progress"])
        if (update[field] !== undefined) task[field] = update[field];
      if (update.result !== undefined) {
        task.result = redact(update.result);
        // Archive only public reports, never provider reasoning fields or arbitrary tool traffic.
        publicReportText =
          publicReportText +
          (publicReportText ? "\n\n---\n\n" : "") +
          String(update.result);
        if (publicReportText.length > 128000) {
          publicReportText =
            publicReportText.slice(0, 16000) +
            "\n\n[较早报告的中间部分超过存储上限，已省略；末尾保留最新输出]\n\n" +
            publicReportText.slice(-110000);
          reportArchiveIncomplete = true;
        }
        try {
          task.reportMemory = archiveTaskReport(
            this.store,
            task,
            publicReportText,
            { sourceIncomplete: reportArchiveIncomplete },
          );
        } catch (error) {
          task.memoryError = redact(`报告档案写入失败：${error.message}`);
        }
      }
      task.logs.push({
        at: Date.now(),
        type: String(parsed.type || "event").slice(0, 80),
      });
      task.logs = task.logs.slice(-80);
      if (Object.keys(update).length) {
        if (update.sessionId || update.result !== undefined || update.error)
          syncWorkMemory(this.store, task);
        this.store.save();
      }
      if (update.permissionDenied && task.status === "running") {
        this.kill(child);
        this.finish(task, "attention", update.progress);
      }
    };
    child.stdout.on("data", (chunk) => {
      task.lastActivityAt = Date.now();
      task.quiet = false;
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines) processLine(line);
      if (pending.length > 2_000_000) {
        terminalError = "Agent 输出过大，任务已停止。";
        this.kill(child);
        pending = "";
      }
    });
    child.stderr.on("data", (chunk) => {
      task.lastActivityAt = Date.now();
      task.quiet = false;
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.on("error", (error) =>
      this.finish(task, "failed", redact(error.message)),
    );
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      child.boboClosed = true;
      task.processId = null;
      if (child.boboKillTimeout) clearTimeout(child.boboKillTimeout);
      this.running.delete(task.id);
      if (child.boboTimeout) clearTimeout(child.boboTimeout);
      if (pending.trim()) processLine(pending);
      if (task.status !== "running") {
        this.checkpoint(task);
        this.store.save();
        return;
      }
      if (code === 0 && !terminalError && task.result)
        this.finish(task, needsAttention ? "attention" : "completed");
      else
        this.finish(
          task,
          "failed",
          terminalError ||
            redact(stderr) ||
            `Agent 退出（${code}），没有返回可确认的结果。`,
        );
    });
    child.stdin.end(agent === "trae" ? undefined : executionPrompt);
    task.timeout = setTimeout(() => {
      if (task.status === "running") {
        this.kill(child);
        this.finish(
          task,
          "failed",
          "任务超过 30 分钟，已请求停止；等待原进程退出。",
        );
      }
    }, 30 * 60_000);
    // Timers belong to the process map, not the persistent JSON state.
    const timeout = task.timeout;
    delete task.timeout;
    child.boboTimeout = timeout;
    return {
      id: task.id,
      status: "running",
      message: "任务已启动。Bobo 会关注这次任务的进度。",
    };
  }
  kill(child) {
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      /* already stopped */
    }
    if (!child.boboKillTimeout) {
      child.boboKillTimeout = setTimeout(() => {
        if (child.boboClosed) return;
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* already stopped */
        }
      }, 2000);
      child.boboKillTimeout.unref();
    }
  }
  finish(task, status, error = "") {
    if (task.status !== "running") return;
    const child = this.running.get(task.id);
    if (child?.boboTimeout) clearTimeout(child.boboTimeout);
    if (!child || child.boboClosed) this.running.delete(task.id);
    task.status = status;
    task.finishedAt = Date.now();
    task.error = error;
    task.progress = {
      completed: "执行已结束，等待检查交付结果。",
      attention: "结果已返回，部分操作需要你处理。",
      failed: "任务没有完成，点击查看原因。",
      cancelled: "任务已停止。",
    }[status];
    if (status === "completed")
      this.store.moment(
        "帮你带回了一份结果",
        `${task.agent === "codex" ? "Codex" : task.agent === "trae" ? "Trae" : "Claude Code"} 返回了「${task.title}」的结果，尚待验收。`,
        "work",
      );
    if (!child || child.boboClosed) this.checkpoint(task);
    const contract = rootOf(this.store, task).contract;
    if (
      status === "completed" &&
      contract?.checks?.length &&
      ![...this.running.keys()].some(
        (id) => this.task(id).workspace === task.workspace,
      )
    ) {
      task.verification = runVerification(task, contract);
      task.progress =
        task.verification.status === "passed"
          ? "执行结束，所列文件检查通过。"
          : "执行结束，但有文件检查未通过。";
    }
    syncWorkMemory(this.store, task, verificationFreshness(task, contract));
    this.store.save();
    if (!this.supervisor.settle(task)) this.onComplete(task);
  }
  checkpoint(task) {
    if (!task.workspace || task.agent === "doubao") return;
    const after = inventory(task.workspace);
    task.checkpoint = {
      at: Date.now(),
      inventory: after,
      changes: changedFiles(task.baseline, after),
      source: "filesystem",
    };
  }
  task(id) {
    const task = this.store.state.tasks.find((t) => t.id === id);
    if (!task) throw new Error("没有找到这项任务。");
    return task;
  }
  report(id) {
    return workflowReport(this.store, this.task(id));
  }
  setContract(id, value) {
    const task = this.task(id),
      root = rootOf(this.store, task);
    const contract = validateContract(value);
    if (
      this.store.state.tasks.some(
        (t) => (t.rootId || t.id) === root.id && this.running.has(t.id),
      )
    )
      throw new Error("请等执行进程退出，再调整检查条件和接续预算。");
    root.contract = contract;
    root.memoryRevision = (root.memoryRevision || 1) + 1;
    // Preserve historical evidence; a changed contract makes it stale on read.
    this.store.save();
    return this.report(id);
  }
  verify(id) {
    const task = this.task(id),
      workspace = currentWorkspace(this.store);
    if (processAlive(task.processId)) throw new Error("原执行进程尚未退出。");
    if (
      !workspace ||
      !task.workspace ||
      fs.realpathSync(workspace) !== fs.realpathSync(task.workspace)
    )
      throw new Error("请在设置中选择这项任务原来的工作目录。");
    if (
      [...this.running.keys()].some(
        (key) => this.task(key).workspace === task.workspace,
      )
    )
      throw new Error("请等这个工作目录的执行进程退出，再核查产物。");
    task.verification = runVerification(task, this.report(id).contract);
    syncWorkMemory(
      this.store,
      task,
      verificationFreshness(task, rootOf(this.store, task).contract),
    );
    this.store.save();
    return task.verification;
  }
  isProcessRunning(task) {
    return this.running.has(task.id) || processAlive(task.processId);
  }
  recordCorrection(id, text, correctionId = null, source = "user_correction") {
    const root = rootOf(this.store, this.task(id));
    root.corrections ||= [];
    if (correctionId) {
      const item = root.corrections.find((c) => c.id === correctionId);
      if (!item) throw new Error("找不到这条纠正。");
      item.active = false;
      item.revokedAt = Date.now();
    } else {
      if (typeof text !== "string" || !text.trim() || text.length > 2000)
        throw new Error("纠正要求需要在 1～2000 字之间。");
      if (root.corrections.filter((c) => c.active).length >= 20)
        throw new Error("最多保留 20 条有效纠正，请先撤下过期要求。");
      root.corrections.push({
        id: randomUUID(),
        text: text.trim(),
        at: Date.now(),
        active: true,
        source,
      });
    }
    root.memoryRevision = (root.memoryRevision || 1) + 1;
    syncWorkMemory(this.store, root);
    this.store.save();
    return {
      corrections: root.corrections,
      message: "已记录，下一次接续时生效。运行中的 Agent 尚未收到这条修改。",
    };
  }
  resume(id, agent, note = "", options = {}) {
    const task = this.task(id),
      root = rootOf(this.store, task);
    if (task.childId)
      return {
        id: task.childId,
        status: this.task(task.childId).status,
        reused: true,
      };
    if (!EXECUTORS.includes(agent))
      throw new Error(
        "自动接续支持 Trae、Codex 和 Claude Code；豆包仍需手动转交。",
      );
    if (
      ["running", "queued", "handoff"].includes(task.status) ||
      this.running.has(id) ||
      processAlive(task.processId)
    )
      throw new Error("请先停止任务，并等待原进程退出后再接续。");
    if (typeof note !== "string" || note.length > 2000)
      throw new Error("下一步说明最多 2000 字符。");
    const workspace = currentWorkspace(this.store);
    if (
      !workspace ||
      !task.workspace ||
      fs.realpathSync(workspace) !== fs.realpathSync(task.workspace)
    )
      throw new Error("接续需使用原工作目录，请先在设置中选回该目录。");
    const report = this.report(id);
    if (report.attempts.length >= report.contract.maxAttempts)
      throw new Error(
        "已达到这项工作的尝试次数上限。请先检查原因，或调整接续预算。",
      );
    if (
      report.contract.tokenLimit !== null &&
      (report.usage.unknownAttempts || report.usage.unknownBrainCalls)
    )
      throw new Error(
        "有未回报的 Token 用量，无法确认预算。请核查，或明确取消 Token 阈值后接续。",
      );
    if (
      report.contract.tokenLimit !== null &&
      report.usage.total >= report.contract.tokenLimit
    )
      throw new Error("已回报的用量达到接续阈值，停止创建下一次尝试。");
    // A user's continuation note is durable; an automatic retry instruction is not a user requirement.
    if (
      !options.automatic &&
      note.trim() &&
      !(root.corrections || []).some((c) => c.active && c.text === note.trim())
    )
      this.recordCorrection(id, note, null, "user_continuation_note");
    const resumeSession =
      !options.forceFresh && agent === task.agent ? task.sessionId : null;
    const packet = handoffPacket(this.store, task, note, inventory(workspace), {
      native: Boolean(resumeSession),
    });
    if (packet.context_budget.overTokenTarget)
      throw new Error(
        "有效要求和必要证据超过交接上下文预算，未创建新尝试。请拆分任务，或在检查与预算中提高上下文预算。",
      );
    const next = this.dispatch(agent, task.title, root.prompt, {
      rootId: root.id,
      parentId: task.id,
      allowEdits: task.allowEdits,
      contract: report.contract,
      handoff: packet,
      contextMemory: packet.context_budget,
      executionPrompt: continuationPrompt(packet),
      resumeSession,
    });
    if (root.supervision) {
      if (this.task(next.id).status === "running") {
        root.supervision.pending = null;
        root.supervision.state = root.supervision.enabled
          ? "watching"
          : "paused";
        root.supervision.reason = root.supervision.enabled
          ? "已接续，Bobo 继续照看。"
          : "已手动接续，自动恢复仍暂停。";
      }
      if (!root.supervision.allowedAgents.includes(agent))
        root.supervision.allowedAgents.push(agent);
      this.store.save();
    }
    return next;
  }
  cancel(id) {
    const root = rootOf(this.store, this.task(id));
    if (root.supervision) {
      root.supervision.enabled = false;
      root.supervision.pending = null;
      root.supervision.state = "paused";
      root.supervision.reason = "你已停止这项工作，Bobo 不会自动重启。";
      this.store.save();
    }
    const latest =
      this.store.state.tasks.find(
        (t) => (t.rootId || t.id) === root.id && !t.childId,
      ) || this.task(id);
    const child = this.running.get(latest.id);
    if (!child)
      return {
        message: processAlive(latest.processId)
          ? "自动恢复已取消；原进程仍存在且不受当前 Bobo 实例管理，需要回原工具处理。"
          : "已取消自动恢复，当前没有 Bobo 执行进程。",
      };
    this.kill(child);
    this.finish(latest, "cancelled");
    return { message: "已请求停止当前进程，取消后续自动恢复。" };
  }
  stopAll() {
    this.supervisor.stop();
    for (const id of [...this.running.keys()]) this.cancel(id);
  }
}
