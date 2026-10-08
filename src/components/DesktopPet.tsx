import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  ArrowUp,
  BookHeart,
  Check,
  ClipboardList,
  Droplets,
  Hand,
  History,
  Gauge,
  LoaderCircle,
  MessageCircle,
  Moon,
  Plus,
  Settings2,
  Sun,
  X,
} from "lucide-react";
import { Bobo } from "./Bobo";
import { api, agentNames, stageNames, taskStatuses } from "../lib/api";
import { TaskWorkflow } from "./TaskWorkflow";
import { stageOf } from "../../electron/pet.mjs";
import type { AgentId, CareAction, Stage, State } from "../lib/types";

export function DesktopPet({
  state,
  care,
  reaction,
  toast,
  tell,
}: {
  state: State;
  care: (action: CareAction) => void;
  reaction: string;
  toast: string;
  tell: (message: string) => void;
}) {
  const expanded = state.petUI?.expanded ?? false;
  const [hover, setHover] = useState(false),
    [menuOpen, setMenuOpen] = useState(false),
    [preview, setPreview] = useState(false),
    [draft, setDraft] = useState(""),
    [mode, setMode] = useState<"chat" | AgentId>("chat"),
    [sending, setSending] = useState(false),
    [error, setError] = useState(""),
    [view, setView] = useState<"chat" | "tasks" | "conversations" | "quotas">(
      "chat",
    ),
    [taskId, setTaskId] = useState<string | null>(null),
    [handoffResult, setHandoffResult] = useState(""),
    [historySearch, setHistorySearch] = useState(""),
    [speaking, setSpeaking] = useState(false),
    [refreshingQuota, setRefreshingQuota] = useState(false);
  const showQuotas = async () => {
    setView("quotas");
    setMenuOpen(false);
    setRefreshingQuota(true);
    await action(() => api.refreshQuotas());
    setRefreshingQuota(false);
  };
  const lastReply = useRef(state.messages.at(-1)?.id);
  useEffect(() => {
    const message = state.messages.at(-1);
    if (message?.id === lastReply.current) return;
    lastReply.current = message?.id;
    if (message?.role !== "assistant" || Date.now() - message.at > 8000) {
      setSpeaking(false);
      return;
    }
    setSpeaking(true);
    const timer = setTimeout(() => setSpeaking(false), 2600);
    return () => clearTimeout(timer);
  }, [state.messages.at(-1)?.id]);
  const drafts = useRef<Record<string, string>>({});
  const changeConversation = async (id?: string) => {
    if (busy) return;
    await action(async () => {
      drafts.current[state.activeConversationId || "legacy"] = draft;
      if (id) await api.selectConversation(id);
      else id = await api.newConversation();
      setDraft(drafts.current[id!] || "");
      setView("chat");
      setMenuOpen(false);
      setTaskId(null);
      setError("");
    });
  };
  const pointer = useRef<{ x: number; y: number; distance: number } | null>(
      null,
    ),
    moved = useRef(false),
    input = useRef<HTMLTextAreaElement>(null),
    end = useRef<HTMLDivElement>(null);
  const task = state.tasks.find((t) => t.id === taskId),
    running = state.tasks.filter((t) =>
      ["running", "queued"].includes(t.status),
    ),
    busy = sending || state.brain.busy;
  useEffect(() => {
    if (state.petUI?.request) {
      setTaskId(state.petUI.taskId);
      setView(state.petUI.taskId ? "tasks" : "chat");
    }
  }, [state.petUI?.request]);
  useEffect(() => {
    if (expanded && view === "chat") input.current?.focus();
  }, [expanded, view]);
  useEffect(() => {
    const match =
      historySearch &&
      state.messages.find((m) => m.content.includes(historySearch));
    if (view === "chat" && match)
      document
        .getElementById("message-" + match.id)
        ?.scrollIntoView({ block: "center" });
    else end.current?.scrollIntoView({ block: "end" });
  }, [state.messages, expanded, busy, view]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        void api.setPetExpanded(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    let interactive = false;
    const update = (event: MouseEvent) => {
      const next = Boolean(
        pointer.current ||
        (event.target instanceof Element && event.target.closest(".pet-hit")),
      );
      if (next !== interactive) {
        interactive = next;
        void api.setPetInteractive(next);
      }
    };
    const leave = () => {
      if (!pointer.current) {
        interactive = false;
        void api.setPetInteractive(false);
      }
    };
    window.addEventListener("mousemove", update);
    window.addEventListener("mouseleave", leave);
    return () => {
      window.removeEventListener("mousemove", update);
      window.removeEventListener("mouseleave", leave);
    };
  }, []);
  useEffect(() => {
    if (!expanded) setMenuOpen(false);
  }, [expanded]);
  const action = async (fn: () => Promise<unknown>) => {
    try {
      setError("");
      await fn();
    } catch (e) {
      setError(
        (e as Error).message.replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      );
    }
  };
  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setView("chat");
    setMenuOpen(false);
    setSending(true);
    setError("");
    setDraft("");
    try {
      if (mode === "chat") await api.chat(text);
      else {
        const created = await api.dispatch(mode, "", text);
        setTaskId(created.id);
        setView("tasks");
      }
    } catch (e) {
      setDraft(text);
      setError(
        (e as Error).message.replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      );
    } finally {
      setSending(false);
    }
  };
  const showNotice = () => {
    if (state.petUI?.notice) {
      void api.openPetChat(state.petUI.notice.taskId);
      void api.dismissPetNotice();
    }
  };
  const stage = preview ? "adult" : (stageOf(state.pet).id as Stage);
  const hasThread =
    state.messages.length > 0 || busy || Boolean(error) || view !== "chat";
  return (
    <div
      className="pet-surface"
      onPointerDown={(e) => {
        if (
          menuOpen &&
          e.target instanceof Element &&
          !e.target.closest(".pet-actions-menu,.composer-plus")
        )
          setMenuOpen(false);
      }}
    >
      {expanded && (
        <section className="pet-conversation" aria-label="Bobo 对话气泡">
          <AnimatePresence>
            {hasThread && (
              <motion.div
                key="thread"
                className="bubble-thread pet-hit"
                initial={{ opacity: 0, y: 8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.98 }}
                transition={{ type: "spring", bounce: 0, duration: 0.25 }}
              >
                <header className="bubble-heading">
                  <div>
                    <strong>
                      {view === "conversations"
                        ? "对话记录"
                        : view === "quotas"
                          ? "智能体额度"
                          : "Bobo"}
                    </strong>
                    <small>
                      {busy ? "正在想…" : view === "tasks" ? "任务与结果" : ""}
                    </small>
                  </div>
                  <button
                    aria-label="新建对话"
                    title="新建对话"
                    disabled={busy}
                    onClick={() => void changeConversation()}
                  >
                    <Plus size={15} />
                  </button>
                  <button
                    aria-label="历史会话"
                    title="历史会话"
                    onClick={() =>
                      setView(
                        view === "conversations" ? "chat" : "conversations",
                      )
                    }
                  >
                    <History size={15} />
                  </button>
                  <button
                    aria-label="智能体额度"
                    title="智能体额度"
                    onClick={() => void showQuotas()}
                  >
                    <Gauge size={15} />
                  </button>
                  <button
                    aria-label="查看任务"
                    title="任务与结果"
                    onClick={() => {
                      setTaskId(null);
                      setView(view === "tasks" ? "chat" : "tasks");
                    }}
                  >
                    <ClipboardList size={15} />
                  </button>
                  <button
                    aria-label="收起对话气泡"
                    title="收起 · Esc"
                    onClick={() => void api.setPetExpanded(false)}
                  >
                    <X size={15} />
                  </button>
                </header>
                {view === "quotas" ? (
                  <div className="bubble-tasks bubble-quotas">
                    <button
                      className="bubble-back"
                      disabled={refreshingQuota}
                      onClick={() => void showQuotas()}
                    >
                      {refreshingQuota ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        <Gauge size={14} />
                      )}{" "}
                      {refreshingQuota ? "正在读取账户额度…" : "刷新额度"}
                    </button>
                    {[...state.agents]
                      .sort(
                        (a, b) =>
                          Number(b.quota?.status === "fresh") -
                          Number(a.quota?.status === "fresh"),
                      )
                      .map((agent) => (
                        <article className="quota-window-card" key={agent.id}>
                          <strong>
                            {agent.name}
                            <span>
                              {agent.quota?.source === "manual"
                                ? "手动记录"
                                : agent.quota?.status === "fresh"
                                  ? "自动读取"
                                  : "暂不可读"}
                            </span>
                          </strong>
                          {(agent.quota?.windows || []).map((w, i) => (
                            <div key={i}>
                              <p>
                                {w.windowDurationMins === 10080
                                  ? "7 天"
                                  : w.windowDurationMins === 300
                                    ? "5 小时"
                                    : (w.windowDurationMins || "未知") +
                                      " 分钟"}{" "}
                                · {w.label} <b>剩余 {w.remainingPercent}%</b>
                              </p>
                              <progress max="100" value={w.remainingPercent} />
                              <small>
                                {w.resetAt
                                  ? "重置 " +
                                    new Date(w.resetAt).toLocaleString("zh-CN")
                                  : "重置时间未返回"}
                              </small>
                            </div>
                          ))}
                          <p>{agent.quota?.note || "等待查询"}</p>
                          <small>
                            {agent.quota?.checkedAt
                              ? "本次查询 " +
                                new Date(
                                  agent.quota.checkedAt,
                                ).toLocaleTimeString("zh-CN")
                              : "尚未查询"}
                          </small>
                        </article>
                      ))}
                  </div>
                ) : view === "conversations" ? (
                  <div className="bubble-tasks bubble-conversations">
                    <input
                      className="conversation-search"
                      aria-label="搜索历史会话"
                      placeholder="搜索标题或消息…"
                      value={historySearch}
                      onChange={(e) => setHistorySearch(e.target.value)}
                    />
                    {[...(state.conversations || [])]
                      .sort((a, b) => b.updatedAt - a.updatedAt)
                      .filter(
                        (c) =>
                          !historySearch ||
                          c.title.includes(historySearch) ||
                          c.messages.some((m) =>
                            m.content.includes(historySearch),
                          ),
                      )
                      .map((c) => (
                        <button
                          key={c.id}
                          className={`bubble-conversation-row ${c.id === state.activeConversationId ? "selected" : ""}`}
                          disabled={busy}
                          onClick={() => void changeConversation(c.id)}
                        >
                          <strong>{c.title}</strong>
                          <span>
                            {(historySearch
                              ? c.messages.find((m) =>
                                  m.content.includes(historySearch),
                                )?.content
                              : c.messages.at(-1)?.content) || "还没有消息"}
                          </span>
                          <small>
                            {c.messages.length} 条消息 ·{" "}
                            {
                              state.tasks.filter(
                                (t) => t.conversationId === c.id,
                              ).length
                            }{" "}
                            个任务
                            {c.id === state.activeConversationId
                              ? " · 当前"
                              : ""}
                          </small>
                        </button>
                      ))}
                    <button
                      className="bubble-back"
                      onClick={() => setView("chat")}
                    >
                      <ArrowLeft size={14} />
                      回到对话
                    </button>
                  </div>
                ) : view === "chat" ? (
                  <div className="bubble-messages" aria-live="polite">
                    {state.messages.map((message) => (
                      <div
                        key={message.id}
                        id={"message-" + message.id}
                        className={`bubble-message ${message.role} ${historySearch && message.content.includes(historySearch) ? "search-match" : ""}`}
                      >
                        <small>{message.role === "user" ? "你" : "Bobo"}</small>
                        <p>{message.content}</p>
                      </div>
                    ))}
                    {busy && (
                      <div className="bubble-thinking">
                        <LoaderCircle size={13} className="spin" />
                        正在想…
                      </div>
                    )}
                    <div ref={end} />
                  </div>
                ) : (
                  <div className="bubble-tasks">
                    <button
                      className="bubble-back"
                      onClick={() => {
                        task ? setTaskId(null) : setView("chat");
                        setHandoffResult("");
                      }}
                    >
                      <ArrowLeft size={14} />
                      {task ? "所有任务" : "回到对话"}
                    </button>
                    {task ? (
                      <article className="bubble-task-detail">
                        <div className="bubble-task-meta">
                          {agentNames[task.agent]} · {taskStatuses[task.status]}
                        </div>
                        <h3>{task.title}</h3>
                        <p>{task.progress}</p>
                        {task.result && <pre>{task.result}</pre>}
                        {task.error && (
                          <p className="bubble-error">{task.error}</p>
                        )}
                        <TaskWorkflow
                          key={task.id}
                          task={task}
                          onOpen={setTaskId}
                        />
                        <details>
                          <summary>查看原始需求</summary>
                          <p>{task.prompt}</p>
                        </details>
                        {["running", "queued"].includes(task.status) && (
                          <button
                            className="outline small"
                            onClick={() =>
                              void action(() => api.cancelTask(task.id))
                            }
                          >
                            停止任务
                          </button>
                        )}
                        {task.status === "handoff" && (
                          <div className="bubble-handoff">
                            <p>
                              豆包需要你粘贴发送，完成后可以在这里记下回复。
                            </p>
                            <button
                              className="outline small"
                              onClick={() =>
                                void action(() => api.handoff(task.id))
                              }
                            >
                              复制需求并打开豆包
                            </button>
                            <textarea
                              aria-label="豆包结果"
                              placeholder="粘贴豆包的回复…"
                              value={handoffResult}
                              onChange={(e) => setHandoffResult(e.target.value)}
                            />
                            <button
                              className="primary small"
                              disabled={!handoffResult.trim()}
                              onClick={() =>
                                void action(async () => {
                                  await api.completeHandoff(
                                    task.id,
                                    handoffResult,
                                  );
                                  setHandoffResult("");
                                })
                              }
                            >
                              <Check size={14} />
                              记录完成
                            </button>
                          </div>
                        )}
                      </article>
                    ) : (
                      <>
                        {state.tasks.length === 0 && (
                          <p className="bubble-empty">
                            还没有任务。和我说说想做什么吧。
                          </p>
                        )}
                        {state.tasks.map((t) => (
                          <button
                            key={t.id}
                            className="bubble-task-row"
                            onClick={() => {
                              setTaskId(t.id);
                              setHandoffResult("");
                            }}
                          >
                            <strong>{t.title}</strong>
                            <small>
                              {agentNames[t.agent]} · {taskStatuses[t.status]}
                            </small>
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                )}
                {error && (
                  <div role="alert" className="bubble-error">
                    {error}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
          <motion.form
            className="bubble-composer pet-hit"
            initial={{ opacity: 0, scale: 0.96, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ type: "spring", bounce: 0, duration: 0.25 }}
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <button
              type="button"
              className={`composer-plus ${menuOpen ? "active" : ""}`}
              aria-label="打开操作菜单"
              aria-expanded={menuOpen}
              title="照料、任务和设置"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              {menuOpen ? <X size={20} /> : <Plus size={22} />}
            </button>
            <textarea
              ref={input}
              aria-label="告诉 Bobo"
              placeholder={
                mode === "chat"
                  ? state.messages.length
                    ? "说点什么…"
                    : "开始新聊天"
                  : `交给 ${agentNames[mode]}…`
              }
              value={draft}
              maxLength={8000}
              onChange={(e) => setDraft(e.target.value)}
              rows={1}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button
              className="composer-send"
              type="submit"
              aria-label="发送消息"
              disabled={busy || !draft.trim()}
            >
              {busy ? (
                <LoaderCircle size={19} className="spin" />
              ) : (
                <ArrowUp size={21} />
              )}
            </button>
          </motion.form>
          <AnimatePresence>
            {menuOpen && (
              <motion.div
                className="pet-actions-menu pet-hit"
                initial={{ opacity: 0, y: 8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.96 }}
                transition={{ type: "spring", bounce: 0, duration: 0.22 }}
              >
                <div className="menu-care">
                  {[
                    { id: "water", label: "浇水", icon: Droplets },
                    { id: "touch", label: "摸摸", icon: Hand },
                    { id: "sun", label: "晒太阳", icon: Sun },
                    {
                      id: "sleep",
                      label: state.pet.sleeping ? "醒来" : "休息",
                      icon: Moon,
                    },
                  ].map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      onClick={() => {
                        care(id as CareAction);
                        setMenuOpen(false);
                      }}
                    >
                      <Icon size={17} />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
                <button
                  disabled={busy}
                  onClick={() => void changeConversation()}
                >
                  <Plus size={16} />
                  新建对话
                </button>
                <button
                  onClick={() => {
                    setView("conversations");
                    setMenuOpen(false);
                  }}
                >
                  <History size={16} />
                  历史会话
                </button>
                <button onClick={() => void showQuotas()}>
                  <Gauge size={16} />
                  智能体额度
                </button>
                <label className="menu-agent">
                  <span>交互方式</span>
                  <select
                    aria-label="交互方式"
                    value={mode}
                    onChange={(e) => {
                      setMode(e.target.value as typeof mode);
                      setView("chat");
                      setMenuOpen(false);
                      input.current?.focus();
                    }}
                  >
                    <option value="chat">和 Bobo 聊聊</option>
                    <option value="codex">交给 Codex</option>
                    <option value="claude">交给 Claude Code</option>
                    <option value="trae">交给 Trae / Coco</option>
                    <option value="doubao">转交豆包</option>
                  </select>
                </label>
                <button
                  onClick={() => {
                    setTaskId(null);
                    setView("tasks");
                    setMenuOpen(false);
                  }}
                >
                  <ClipboardList size={16} />
                  任务与结果
                  {running.length > 0 && <small>{running.length}</small>}
                </button>
                <button
                  onClick={() => {
                    void api.openHome("home");
                    setMenuOpen(false);
                  }}
                >
                  <BookHeart size={16} />
                  打开历史记录
                </button>
                <button
                  onClick={() => {
                    void api.openHome("settings");
                    setMenuOpen(false);
                  }}
                >
                  <Settings2 size={16} />
                  打开偏好设置
                </button>
                <button
                  onClick={() => {
                    setPreview(!preview);
                    setMenuOpen(false);
                  }}
                >
                  <Sun size={16} />
                  {preview ? "返回当前形态" : "预览成年形象"}
                </button>
                <button
                  aria-label="收起对话气泡"
                  onClick={() => {
                    setMenuOpen(false);
                    void api.setPetExpanded(false);
                  }}
                >
                  <X size={16} />
                  收起气泡
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      )}
      {preview && (
        <button
          className="pet-preview-label pet-hit"
          onClick={() => setPreview(false)}
        >
          成年预览 · 返回当前
        </button>
      )}
      {expanded &&
        !toast &&
        state.petUI?.notice &&
        !(view === "tasks" && task?.id === state.petUI.notice.taskId) && (
          <button
            className="pet-care-toast pet-result-toast pet-hit"
            onClick={showNotice}
          >
            {state.petUI.notice.message}
            <span>查看 →</span>
          </button>
        )}
      {expanded && toast && (
        <div role="status" className="pet-care-toast pet-hit">
          {toast}
        </div>
      )}
      <div
        className={`floating-pet ${expanded ? "with-composer" : ""}`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {!expanded && (toast || state.petUI?.notice || running.length > 0) && (
          <div className="pet-speech pet-hit">
            {toast ? (
              <p role="status">{toast}</p>
            ) : state.petUI?.notice ? (
              <div className="pet-notice">
                <button onClick={showNotice}>
                  {state.petUI.notice.message}
                  <small>点我看看 →</small>
                </button>
                <button
                  aria-label="忽略任务提醒"
                  onClick={() => void api.dismissPetNotice()}
                >
                  <X size={13} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  setTaskId(null);
                  setView("tasks");
                  void api.setPetExpanded(true);
                }}
              >
                {running.length} 件小事正在进行…
              </button>
            )}
          </div>
        )}
        <div
          className="pet-drag pet-hit"
          title="点击聊天 · 双击摸摸 · 右键照料 · 拖动移动"
          onDoubleClick={() => care("touch")}
          onContextMenu={(e) => {
            e.preventDefault();
            void api.setPetExpanded(true);
            setMenuOpen(true);
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !moved.current) {
              setView("chat");
              void api.setPetExpanded(!expanded);
            }
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            pointer.current = { x: e.screenX, y: e.screenY, distance: 0 };
            moved.current = false;
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!pointer.current) return;
            const dx = e.screenX - pointer.current.x,
              dy = e.screenY - pointer.current.y;
            pointer.current.distance += Math.abs(dx) + Math.abs(dy);
            if (pointer.current.distance > 4) {
              moved.current = true;
              void api.movePet(dx, dy);
            }
            pointer.current.x = e.screenX;
            pointer.current.y = e.screenY;
          }}
          onPointerUp={() => {
            pointer.current = null;
          }}
          onPointerCancel={() => {
            pointer.current = null;
          }}
        >
          <Bobo
            stage={stage}
            sleeping={state.pet.sleeping}
            reaction={reaction}
            activity={
              busy
                ? "thinking"
                : speaking
                  ? "speaking"
                  : running.length
                    ? "working"
                    : "idle"
            }
            interactionLabel="和 Bobo 说话"
            onTouch={() => {
              if (!moved.current) {
                setView("chat");
                void api.setPetExpanded(!expanded);
              }
            }}
          />
        </div>
        <div
          className={`pet-toolbar pet-hit ${!expanded && (hover || toast) ? "visible" : ""}`}
        >
          <button
            className="icon-button"
            aria-label="给 Bobo 浇水"
            title="浇水"
            onClick={() => care("water")}
          >
            <Droplets size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="摸摸 Bobo"
            title="摸摸"
            onClick={() => care("touch")}
          >
            <Hand size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="陪 Bobo 晒太阳"
            title="晒太阳"
            onClick={() => care("sun")}
          >
            <Sun size={17} />
          </button>
          <button
            className="icon-button"
            aria-label={state.pet.sleeping ? "叫醒 Bobo" : "让 Bobo 休息"}
            title="休息 / 醒来"
            onClick={() => care("sleep")}
          >
            <Moon size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="展开对话气泡"
            title="说句话"
            onClick={() => {
              setView("chat");
              void api.setPetExpanded(!expanded);
            }}
          >
            <MessageCircle size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="收起桌宠"
            title="收起桌宠"
            onClick={() => {
              void api.togglePet(false);
              tell("可以从菜单栏叫我回来。");
            }}
          >
            <X size={17} />
          </button>
        </div>
        <div className="pet-name">
          Bobo <span>·</span> {stageNames[stage]}
        </div>
      </div>
    </div>
  );
}
