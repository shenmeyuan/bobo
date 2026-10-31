import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findBinary } from "./agents.mjs";
import { loadConfig, redact } from "./config.mjs";
import { quotaEnvironment } from "./quota.mjs";

const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
];
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const writeJSON = (file, value) => {
  fs.writeFileSync(file + ".bobo-tmp", JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(file + ".bobo-tmp", file);
};
export function configureClaudeHooks(
  dataDir,
  enabled,
  { home = os.homedir(), executable = process.execPath, configDirectory } = {},
) {
  if (process.platform === "win32")
    throw new Error("CC 状态 Hooks 暂仅支持 macOS / Linux。");
  const configDir =
    configDirectory ||
    (home === os.homedir() ? process.env.CLAUDE_CONFIG_DIR : "") ||
    path.join(home, ".claude");
  const settingsFile = path.join(configDir, "settings.json");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const settings = fs.existsSync(settingsFile)
    ? JSON.parse(fs.readFileSync(settingsFile, "utf8"))
    : {};
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("Claude 设置格式无效，未修改。");
  if (
    settings.hooks &&
    (typeof settings.hooks !== "object" || Array.isArray(settings.hooks))
  )
    throw new Error("Claude Hooks 设置格式无效，未修改。");
  const script = path.join(dataDir, "bobo-session-observer.cjs");
  const command = `ELECTRON_RUN_AS_NODE=1 ${quote(executable)} ${quote(script)} ${quote(path.join(dataDir, "session-events"))}`;
  const markerFile = path.join(dataDir, "observer-command.json");
  const previous = fs.existsSync(markerFile)
    ? JSON.parse(fs.readFileSync(markerFile, "utf8")).command
    : command;
  const hooks = { ...settings.hooks };
  for (const event of EVENTS) {
    if (hooks[event] && !Array.isArray(hooks[event]))
      throw new Error("Claude Hooks 事件格式无效，未修改。");
    hooks[event] = (hooks[event] || [])
      .map((group) => ({
        ...group,
        hooks: (group.hooks || []).filter(
          (h) => h.command !== previous && h.command !== command,
        ),
      }))
      .filter((g) => g.hooks.length);
    if (enabled)
      hooks[event].push({
        matcher: "",
        hooks: [{ type: "command", command, timeout: 2 }],
      });
    if (!hooks[event].length) delete hooks[event];
  }
  if (enabled) {
    fs.copyFileSync(
      fileURLToPath(new URL("./claude-observer-hook.cjs", import.meta.url)),
      script,
    );
    fs.chmodSync(script, 0o600);
  }
  if (fs.existsSync(settingsFile))
    fs.copyFileSync(settingsFile, settingsFile + `.bobo-backup-${Date.now()}`);
  writeJSON(settingsFile, { ...settings, hooks });
  writeJSON(markerFile, { command });
  return { enabled, settingsFile };
}

export function normalizeClaudeEvent(event, now = Date.now()) {
  if (
    !event ||
    !/^[a-zA-Z0-9_-]{1,160}$/.test(event.session_id) ||
    !EVENTS.includes(event.hook_event_name) ||
    typeof event.cwd !== "string" ||
    event.cwd.length > 2000 ||
    !path.isAbsolute(event.cwd) ||
    !Number.isFinite(event.at) ||
    event.at > now + 60000
  )
    return null;
  const kind = event.hook_event_name;
  const status =
    kind === "SessionEnd"
      ? "ended"
      : kind === "Stop"
        ? "idle"
        : kind === "PreCompact"
          ? "compacting"
          : kind === "PostCompact" || kind === "SessionStart"
            ? "observed"
            : kind === "Notification"
              ? event.notification_type === "permission_prompt"
                ? "waiting"
                : "observed"
              : "working";
  return {
    id: `claude:${event.session_id}`,
    sessionId: event.session_id,
    agent: "claude",
    title: `CC · ${path.basename(event.cwd)}`,
    workspace: event.cwd,
    status,
    source: "claude-hooks",
    updatedAt: event.at,
    checkedAt: now,
    order: /^\d{1,30}$/.test(event.order || "") ? event.order : "0",
    event: kind,
  };
}
export function normalizeCodexThreads(data, now = Date.now()) {
  if (!Array.isArray(data)) throw new Error("Codex 未返回有效会话列表。");
  return data
    .slice(0, 40)
    .filter(
      (t) => /^[a-zA-Z0-9_-]{1,160}$/.test(t.id) && typeof t.cwd === "string",
    )
    .map((t) => ({
      id: `codex:${t.id}`,
      sessionId: t.id,
      agent: "codex",
      title:
        typeof t.name === "string" && t.name
          ? redact(t.name).slice(0, 100)
          : `Codex · ${path.basename(t.cwd)}`,
      workspace: t.cwd,
      status:
        t.status?.type === "active"
          ? t.status.activeFlags?.includes("waitingOnApproval") ||
            t.status.activeFlags?.includes("waitingOnUserInput")
            ? "waiting"
            : "working"
          : t.status?.type === "idle"
            ? "idle"
            : "observed",
      source: "codex-app-server",
      updatedAt: Number.isFinite(t.updatedAt) ? t.updatedAt * 1000 : now,
      checkedAt: now,
    }));
}
export async function readCodexSessions(
  binary,
  workspace,
  { spawnProcess = spawn, timeoutMs = 12000, signal } = {},
) {
  if (!binary) throw new Error("未找到 Codex CLI；请先配置路径。");
  if (signal?.aborted) throw new Error("会话观察已停止。");
  const child = spawnProcess(binary, ["app-server"], {
    shell: false,
    env: quotaEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let pending = "",
    total = 0,
    timer;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.stdin.end();
      child.kill();
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new Error("会话观察已停止。"));
    signal?.addEventListener("abort", abort, { once: true });
    const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
    child.on("error", () => finish(new Error("Codex 会话读取进程无法启动。")));
    child.on("close", () => finish(new Error("Codex 会话读取提前退出。")));
    child.stdin.on("error", () => finish(new Error("Codex 会话连接已关闭。")));
    child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk) => {
      total += chunk.length;
      pending += chunk.toString();
      if (total > 2000000)
        return finish(new Error("Codex 会话列表超过读取上限。"));
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (![1, 2].includes(msg.id)) continue;
        if (msg.error)
          return finish(new Error("Codex 当前版本不支持此会话读取请求。"));
        if (msg.id === 1) {
          send({ method: "initialized", params: {} });
          send({
            id: 2,
            method: "thread/list",
            params: {
              limit: 40,
              archived: false,
              ...(workspace ? { cwd: workspace } : {}),
            },
          });
        }
        if (msg.id === 2) {
          try {
            finish(null, normalizeCodexThreads(msg.result?.data));
          } catch (e) {
            finish(e);
          }
        }
      }
    });
    timer = setTimeout(
      () => finish(new Error("Codex 会话读取超时。")),
      timeoutMs,
    );
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "bobo_observer",
          title: "Bobo Observer",
          version: "0.2.0",
        },
      },
    });
  });
}

export class SessionObserver {
  constructor(
    store,
    {
      now = () => Date.now(),
      readCodex = readCodexSessions,
      hookOptions = {},
      onNotice = () => {},
    } = {},
  ) {
    this.store = store;
    this.now = now;
    this.readCodex = readCodex;
    this.hookOptions = hookOptions;
    this.onNotice = onNotice;
    this.dir = path.dirname(store.file);
    this.queue = path.join(this.dir, "session-events");
    store.state.observer ||= {
      claudeEnabled: false,
      codexEnabled: false,
      sessions: [],
      errors: {},
    };
  }
  start() {
    this.timer = setInterval(() => {
      try {
        this.drain();
      } catch {
        /* do not interrupt agents */
      }
    }, 2000);
    this.timer.unref();
    this.scanTimer = setInterval(() => {
      if (this.store.state.observer.codexEnabled) void this.refresh();
    }, 60000);
    this.scanTimer.unref();
  }
  stop() {
    this.refreshController?.abort();
    clearInterval(this.timer);
    clearInterval(this.scanTimer);
  }
  async configure(agent, enabled) {
    if (!["claude", "codex"].includes(agent) || typeof enabled !== "boolean")
      throw new Error("会话观察设置无效。");
    if (
      agent === "codex" &&
      enabled &&
      !(this.store.state.settings.workspace || loadConfig().workspace)
    )
      throw new Error("请先选择项目目录，再开启 Codex 会话观察。");
    if (agent === "claude")
      configureClaudeHooks(this.dir, enabled, this.hookOptions);
    const state = this.store.state.observer;
    state[`${agent}Enabled`] = enabled;
    if (!enabled) {
      state.sessions = state.sessions.filter((s) => s.agent !== agent);
      delete state.errors[agent];
    }
    this.store.save();
    if (agent === "codex" && enabled) await this.refresh();
  }
  merge(session) {
    const state = this.store.state.observer;
    if (
      this.store.state.tasks.some(
        (t) => t.sessionId === session.sessionId && t.agent === session.agent,
      )
    ) {
      state.sessions = state.sessions.filter((s) => s.id !== session.id);
      return;
    }
    const old = state.sessions.find((s) => s.id === session.id);
    if (
      old &&
      (old.updatedAt > session.updatedAt ||
        (session.agent === "claude" &&
          old.updatedAt === session.updatedAt &&
          BigInt(old.order || "0") > BigInt(session.order || "0")))
    )
      return;
    state.sessions = [
      session,
      ...state.sessions.filter((s) => s.id !== session.id),
    ]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 100);
    if ((!old || old.status !== session.status) && session.status === "waiting")
      this.onNotice(session);
  }
  drain() {
    if (!fs.existsSync(this.queue)) return;
    let changed = false;
    for (const name of fs
      .readdirSync(this.queue)
      .filter((n) => /^[0-9]+-[a-f0-9-]+\.json$/.test(n))
      .sort()
      .slice(0, 200)) {
      const file = path.join(this.queue, name);
      try {
        if (
          fs.lstatSync(file).isSymbolicLink() ||
          fs.statSync(file).size > 8000
        )
          continue;
        const session = normalizeClaudeEvent(
          JSON.parse(fs.readFileSync(file, "utf8")),
          this.now(),
        );
        if (session && this.store.state.observer.claudeEnabled) {
          this.merge(session);
          changed = true;
        }
      } catch {
        /* malformed local event */
      } finally {
        fs.unlinkSync(file);
      }
    }
    if (changed) this.store.save();
  }
  async refresh() {
    if (this.refreshing || !this.store.state.observer.codexEnabled) return;
    this.refreshing = true;
    this.refreshController = new AbortController();
    try {
      const cfg = loadConfig();
      const binary =
        findBinary("codex", cfg.codexPath) ||
        [
          "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
          "/Applications/Codex.app/Contents/Resources/codex",
        ].find((p) => fs.existsSync(p));
      const workspace = this.store.state.settings.workspace || cfg.workspace;
      const sessions = await this.readCodex(binary, workspace, {
        signal: this.refreshController.signal,
      });
      if (
        (this.store.state.settings.workspace || loadConfig().workspace) !==
        workspace
      )
        return;
      const sameProject = sessions.filter(
        (s) =>
          !workspace || path.resolve(s.workspace) === path.resolve(workspace),
      );
      if (this.store.state.observer.codexEnabled) {
        const currentIds = new Set(sameProject.map((s) => s.id));
        this.store.state.observer.sessions =
          this.store.state.observer.sessions.filter(
            (s) => s.agent !== "codex" || currentIds.has(s.id),
          );
        for (const session of sameProject) this.merge(session);
        delete this.store.state.observer.errors.codex;
      }
    } catch (e) {
      this.store.state.observer.errors.codex = redact(e.message);
    } finally {
      this.refreshing = false;
      this.store.save();
    }
  }
}
