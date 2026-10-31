import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { State } from "../lib/types";

export function ObservedSessions({
  state,
  settings = false,
}: {
  state: State;
  settings?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const observer = state.observer;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="observed-sessions" aria-label="外部会话观察">
      <div className="workflow-heading">
        <strong>其他窗口的工作</strong>
        <button
          className="outline small"
          disabled={busy || !state.desktop}
          onClick={() => void act(() => api.refreshObserver())}
        >
          {busy ? "读取中…" : "刷新会话"}
        </button>
      </div>
      <p className="workflow-muted">
        仅保留会话状态，不保存提示词或工具内容，也不自动接管。需要继续工作或处理权限时，请回原工具。
      </p>
      {settings ? (
        <>
          <p className="workflow-muted">
            开启 CC 会在本机 Claude 设置里加入 Bobo 的状态
            Hooks，并备份原设置。后续会话或恢复后生效；关闭只移除 Bobo 的
            Hooks。
          </p>
          {(["claude", "codex"] as const).map((agent) => (
            <label className="observer-toggle" key={agent}>
              <span>
                {agent === "claude"
                  ? "观察 Claude Code（本机各项目）"
                  : "读取 Codex 已有会话（当前项目）"}
              </span>
              <input
                type="checkbox"
                aria-label={
                  agent === "claude" ? "观察 Claude Code" : "观察 Codex"
                }
                checked={Boolean(observer?.[`${agent}Enabled`])}
                disabled={busy || !state.desktop}
                onChange={(e) =>
                  void act(() => api.configureObserver(agent, e.target.checked))
                }
              />
            </label>
          ))}
        </>
      ) : (
        !observer?.claudeEnabled &&
        !observer?.codexEnabled && (
          <button
            className="outline small"
            onClick={() => void api.openHome("settings")}
          >
            在偏好设置中开启观察
          </button>
        )
      )}
      {Object.entries(observer?.errors || {}).map(([agent, message]) => (
        <p className="bubble-error" key={agent}>
          {agent}：{message}
        </p>
      ))}
      {(observer?.sessions || []).slice(0, settings ? 20 : 6).map((session) => {
        const old =
          now - session.checkedAt >
          (session.agent === "claude" ? 300000 : 120000);
        const status =
          old && !["ended", "idle"].includes(session.status)
            ? "状态待刷新"
            : (
                {
                  working: "工作中",
                  waiting: "等待你处理",
                  idle: "本轮已结束",
                  ended: "会话已关闭",
                  compacting: "整理上下文",
                  observed: "已有会话记录 · 实时状态未知",
                } as Record<string, string>
              )[session.status] || "状态未知";
        return (
          <article className="observed-session" key={session.id}>
            <div>
              <strong>{session.title}</strong>
              <span
                className={
                  session.status === "waiting" && !old
                    ? "observer-attention"
                    : ""
                }
              >
                {status}
              </span>
            </div>
            <small>{session.workspace}</small>
            <small>
              {session.source === "claude-hooks"
                ? "CC 状态事件"
                : "Codex 官方本地接口"}{" "}
              · 更新于 {new Date(session.updatedAt).toLocaleTimeString()} ·
              仅观察
            </small>
          </article>
        );
      })}
      {error && (
        <p className="bubble-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
