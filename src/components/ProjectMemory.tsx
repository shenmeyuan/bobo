import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ProjectMemoryEntry } from "../lib/types";

export function ProjectMemory({ workspace }: { workspace: string }) {
  const [entries, setEntries] = useState<ProjectMemoryEntry[]>([]);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<ProjectMemoryEntry["kind"]>("feedback");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setEntries([]);
    setError("");
    setText("");
    setQuery("");
    let alive = true;
    const refresh = () =>
      api
        .getProjectMemory()
        .then((value) => {
          if (alive) setEntries(value);
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    void refresh();
    const unsubscribe = api.onChange(() => void refresh());
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [workspace]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      setEntries(await api.getProjectMemory());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-card task-workflow" aria-label="项目记忆">
      <div className="workflow-heading">
        <strong>项目记忆</strong>
        <span>
          {entries.filter((m) => m.status === "active").length} 条有效
        </span>
      </div>
      <p className="workflow-muted">
        只用于当前项目。保存你确认的长期指导，新对话和换智能体时可复用；任务的临时要求留在任务里。
      </p>
      <input
        aria-label="搜索项目记忆"
        value={query}
        placeholder="搜索记忆"
        onChange={(e) => setQuery(e.target.value)}
      />
      {entries
        .filter(
          (m) => !query || m.text.toLowerCase().includes(query.toLowerCase()),
        )
        .map((m) => (
          <article className={`project-memory-entry ${m.status}`} key={m.id}>
            <p>{m.text}</p>
            <div className="project-memory-meta">
              <p className="workflow-muted">
                {m.status === "revoked"
                  ? "已撤下"
                  : {
                      feedback: "工作规则",
                      preference: "偏好",
                      reference: "参考位置",
                    }[m.kind]}{" "}
                · 版本 {m.revision} ·{" "}
                {m.source.kind === "user_message"
                  ? "来自你的聊天要求"
                  : "由你保存"}{" "}
                · {new Date(m.updatedAt).toLocaleString()}
              </p>
              {m.status === "active" && (
                <button
                  className="outline small"
                  disabled={busy}
                  onClick={() => void act(() => api.revokeProjectMemory(m.id))}
                >
                  撤下记忆
                </button>
              )}
            </div>
          </article>
        ))}
      <textarea
        aria-label="新的项目记忆"
        maxLength={2000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="例如：这个项目的金额统一使用整数分。"
      />
      <select
        aria-label="项目记忆类型"
        value={kind}
        onChange={(e) => setKind(e.target.value as ProjectMemoryEntry["kind"])}
      >
        <option value="feedback">工作规则</option>
        <option value="preference">偏好</option>
        <option value="reference">参考位置</option>
      </select>
      <button
        className="outline small"
        disabled={busy || !workspace || !text.trim()}
        onClick={() =>
          void act(async () => {
            await api.saveProjectMemory(text, kind);
            setText("");
          })
        }
      >
        保存项目记忆
      </button>
      {error && (
        <p role="alert" className="workflow-muted">
          {error}
        </p>
      )}
    </section>
  );
}
