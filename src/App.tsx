import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  BookHeart,
  Check,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  Clock3,
  Code2,
  ExternalLink,
  Flower2,
  FolderOpen,
  Heart,
  House,
  Leaf,
  LoaderCircle,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Power,
  Settings2,
  Sparkles,
  Sprout,
  Terminal,
  Volume2,
  VolumeX,
  X,
  type LucideIcon,
} from "lucide-react";
import { DesktopPet } from "./components/DesktopPet";
import { Bobo } from "./components/Bobo";
import { TaskWorkflow } from "./components/TaskWorkflow";
import { ProjectMemory } from "./components/ProjectMemory";
import {
  api,
  agentNames,
  dateText,
  stageNames,
  taskStatuses,
  timeText,
} from "./lib/api";
import { DAY, STAGES, stageOf } from "../electron/pet.mjs";
import type {
  Agent,
  AgentId,
  CareAction,
  Quota,
  Stage,
  State,
  Task,
} from "./lib/types";
type Page = "home" | "agents" | "diary" | "growth" | "settings";
const spring = { type: "spring" as const, bounce: 0, duration: 0.3 };
const formatNumber = (n: number) => n.toLocaleString("zh-CN");
const names: Record<Page, string> = {
  home: "历史概览",
  agents: "Agent 记录",
  diary: "陪伴日记",
  growth: "成长档案",
  settings: "偏好设置",
};
function IconButton({
  icon: Icon,
  label,
  onClick,
  className = "",
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      className={`icon-button ${className}`}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <Icon size={18} />
    </button>
  );
}
function Badge({
  children,
  color = "green",
}: {
  children: ReactNode;
  color?: string;
}) {
  return (
    <span className={`badge ${color}`}>
      <i />
      {children}
    </span>
  );
}
function Modal({
  title,
  description,
  children,
  close,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null),
    previous = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previous.current = document.activeElement as HTMLElement;
    const panel = ref.current;
    panel?.querySelector<HTMLElement>("input,textarea,button,select")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "Tab" && panel) {
        const items = [
          ...panel.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input,textarea,select,[tabindex="0"]',
          ),
        ];
        const first = items[0],
          last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous.current?.focus();
    };
  }, [close]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <motion.div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal"
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={spring}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton icon={X} label="关闭弹窗" onClick={close} />
        </div>
        {children}
      </motion.div>
    </div>
  );
}
export default function App() {
  const [state, setState] = useState<State | null>(null),
    [fatal, setFatal] = useState("");
  const [page, setPage] = useState<Page>(() => {
      const requested = new URLSearchParams(location.search).get("page");
      return requested && requested in names ? (requested as Page) : "home";
    }),
    [toast, setToast] = useState(""),
    [reaction, setReaction] = useState("");
  const [dispatchAgent, setDispatchAgent] = useState<AgentId | "auto" | null>(
      null,
    ),
    [quotaAgent, setQuotaAgent] = useState<Agent | null>(null),
    [task, setTask] = useState<Task | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    reactionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const floating = new URLSearchParams(location.search).get("view") === "pet";
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api
        .getState()
        .then((next) => {
          if (alive) {
            setState(next);
            setTask((current) =>
              current
                ? next.tasks.find((t) => t.id === current.id) || current
                : null,
            );
          }
        })
        .catch((error) => {
          if (alive) setFatal(String(error.message));
        });
    refresh();
    const unsubscribe = api.onChange(refresh);
    const timer = setInterval(refresh, 60_000);
    return () => {
      alive = false;
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
  useEffect(
    () =>
      api.onNavigate((next) => {
        if (next in names) setPage(next as Page);
      }),
    [],
  );
  useEffect(() => {
    document.body.classList.toggle("floating-body", floating);
    document.documentElement.classList.toggle("floating-body", floating);
    return () => {
      document.body.classList.remove("floating-body");
      document.documentElement.classList.remove("floating-body");
    };
  }, [floating]);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (reactionTimer.current) clearTimeout(reactionTimer.current);
    },
    [],
  );
  const tell = (text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4500);
  };
  const perform = async (fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn();
      if (success) tell(success);
    } catch (error) {
      tell(
        (error as Error).message.replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      );
    }
  };
  const care = async (action: CareAction) => {
    setReaction(action);
    if (reactionTimer.current) clearTimeout(reactionTimer.current);
    reactionTimer.current = setTimeout(() => setReaction(""), 1400);
    try {
      tell(await api.care(action));
    } catch (error) {
      tell((error as Error).message);
    }
  };
  if (fatal)
    return (
      <div className="loading-screen">
        <Sprout size={32} />
        <h2>小屋暂时没打开</h2>
        <p>{fatal}</p>
        <button className="primary" onClick={() => location.reload()}>
          重新打开
        </button>
      </div>
    );
  if (!state)
    return (
      <div className="loading-screen">
        <Sprout size={32} />
        <p>给小屋开一盏灯…</p>
      </div>
    );
  if (floating)
    return (
      <DesktopPet
        state={state}
        care={care}
        reaction={reaction}
        toast={toast}
        tell={tell}
      />
    );
  const stage = stageOf(state.pet).id as Stage;
  const running = state.tasks.filter((t) => t.status === "running").length;
  const today = new Date();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="window-drag-space" />
        <div className="brand">
          <Bobo className="brand-pet" />
          <div>
            <strong>bobo</strong>
            <small>DESKTOP COMPANION</small>
          </div>
        </div>
        <div className="nav-label">记录与设置</div>
        <nav>
          {(
            [
              { id: "home", icon: House },
              { id: "agents", icon: ClipboardList },
              { id: "diary", icon: BookHeart },
              { id: "growth", icon: Sprout },
            ] as { id: Page; icon: LucideIcon }[]
          ).map(({ id, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "active" : ""}`}
              onClick={() => setPage(id)}
            >
              <Icon size={19} />
              <span>{names[id]}</span>
              {id === "agents" && running > 0 && <em>{running}</em>}
              {page === id && <i />}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <div className="tiny-orbit">
            <Leaf size={18} />
            <span />
          </div>
          <p>
            一点陪伴，
            <br />
            也能长成很大的事。
          </p>
          <small>TAKE IT SLOW, TOGETHER.</small>
        </div>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            onClick={() => setPage("settings")}
          >
            <Settings2 size={19} />
            <span>偏好设置</span>
          </button>
          <div className="profile">
            <div className="profile-avatar">
              <Leaf size={18} />
            </div>
            <div>
              <strong>Bobo 的照料员</strong>
              <small>
                第 {state.pet.generation} 代 · 相遇第{" "}
                {Math.floor(state.pet.companionMs / DAY) + 1} 天
              </small>
            </div>
            <span className="profile-dot" />
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Bobo</span>
            <ChevronRight size={13} />
            <strong>{names[page]}</strong>
          </div>
          <div className="top-actions">
            <span className="date-label">
              {today.toLocaleDateString("zh-CN", {
                month: "long",
                day: "numeric",
                weekday: "short",
              })}
            </span>
            <div className="separator" />
            <button
              className={`desktop-toggle ${state.settings.petVisible ? "on" : ""}`}
              onClick={() =>
                perform(() => api.togglePet(!state.settings.petVisible))
              }
            >
              <Sprout size={16} />
              <span>桌面陪伴</span>
              <i />
            </button>
            <IconButton
              icon={state.settings.quiet ? VolumeX : Volume2}
              label={state.settings.quiet ? "开启通知" : "安静模式"}
              onClick={() =>
                perform(() => api.setSettings({ quiet: !state.settings.quiet }))
              }
            />
          </div>
        </header>
        {!state.desktop && (
          <div className="preview-notice">
            <CircleHelp size={14} />
            记录与设置预览 · 日常互动在桌面上的 Bobo 气泡中进行。
          </div>
        )}
        <main className="main-grid">
          <div className="main-content">
            <div className="page-heading">
              <div>
                <div className="eyebrow">
                  {page === "home"
                    ? "A LITTLE COMPANY, EVERY DAY"
                    : "SMALL THINGS, SHARED STORIES"}
                </div>
                <h1>
                  {
                    {
                      home: "历史概览",
                      agents: "Agent 记录",
                      diary: "陪伴日记",
                      growth: "成长档案",
                      settings: "偏好设置",
                    }[page]
                  }
                </h1>
                <p>
                  {
                    {
                      home: "回顾任务与一起度过的日子。",
                      agents: "连接的工具、已发生的用量和任务记录。",
                      diary: "照料、成长和日常陪伴的记录。",
                      growth: "从种子到老胡萝卜，慢慢度过一生。",
                      settings: "模型连接、Agent 工作目录与桌面偏好。",
                    }[page]
                  }
                </p>
              </div>
              {page !== "settings" && (
                <button
                  className="outline small"
                  onClick={() => setPage("growth")}
                >
                  <Leaf size={15} />第 {state.pet.generation} 代
                </button>
              )}
            </div>
            {page === "home" && (
              <>
                <section className="history-recap">
                  <div>
                    <Bobo stage={stage} className="history-pet" />
                    <div>
                      <small>
                        第 {state.pet.generation} 代 · {stageNames[stage]}
                      </small>
                      <h3>
                        已经相伴 {Math.floor(state.pet.companionMs / DAY) + 1}{" "}
                        天
                      </h3>
                      <p>
                        {state.diary.length} 段回忆 · {state.tasks.length}{" "}
                        件任务
                      </p>
                    </div>
                  </div>
                  <button
                    className="outline small"
                    onClick={() => perform(() => api.openPetChat())}
                  >
                    <MessageCircle size={16} />
                    回到桌面聊天
                  </button>
                </section>
                <section className="history-moments">
                  {state.diary.slice(0, 3).map((moment) => (
                    <article key={moment.id}>
                      <small>{dateText(moment.at)}</small>
                      <h3>{moment.title}</h3>
                      <p>{moment.text}</p>
                    </article>
                  ))}
                </section>
                <TasksSection
                  state={state}
                  openTask={setTask}
                  dispatch={() => setDispatchAgent("auto")}
                />
              </>
            )}
            {page === "agents" && (
              <>
                <div className="keeper-summary">
                  <div className="keeper-icon">
                    <ClipboardList size={23} />
                  </div>
                  <div>
                    <h3>
                      {running
                        ? `${running} 项任务正在进行`
                        : "今天的值班室很安静"}
                    </h3>
                    <p>这里记录 Bobo 发起的任务。豆包通过卡片手动转交。</p>
                  </div>
                  <button
                    className="primary"
                    onClick={() => setDispatchAgent("auto")}
                  >
                    <Plus size={16} />
                    交给 Agent
                  </button>
                </div>
                <AgentsSection
                  state={state}
                  dispatch={setDispatchAgent}
                  quota={setQuotaAgent}
                />
                <TasksSection
                  state={state}
                  openTask={setTask}
                  dispatch={() => setDispatchAgent("auto")}
                  expanded
                />
              </>
            )}
            {page === "diary" && <Diary state={state} />}
            {page === "growth" && (
              <Growth state={state} stage={stage} perform={perform} />
            )}
            {page === "settings" && (
              <Settings
                state={state}
                perform={perform}
                refresh={() => api.getState().then(setState)}
              />
            )}
            <footer className="page-footer">
              <Sprout size={13} />
              <span>桌面上的小伙伴。</span>
              <span>BOBO · 0.1</span>
            </footer>
          </div>
        </main>
      </div>
      <AnimatePresence>
        {toast && (
          <motion.div
            role="status"
            className="toast"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={spring}
          >
            <Leaf size={17} />
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
      {dispatchAgent && (
        <DispatchModal
          initial={dispatchAgent}
          state={state}
          close={() => setDispatchAgent(null)}
          perform={perform}
        />
      )}
      {quotaAgent && (
        <QuotaModal
          agent={quotaAgent}
          close={() => setQuotaAgent(null)}
          perform={perform}
        />
      )}
      {task && (
        <TaskModal task={task} close={() => setTask(null)} perform={perform} />
      )}
    </div>
  );
}
function AgentLogo({ id }: { id: AgentId }) {
  return (
    <div className={`agent-logo ${id}`}>
      {id === "codex" ? (
        <Code2 size={23} />
      ) : id === "claude" ? (
        <span>✳</span>
      ) : id === "trae" ? (
        <span>T</span>
      ) : (
        <span className="doubao-face">豆</span>
      )}
    </div>
  );
}
function AgentsSection({
  state,
  dispatch,
  quota,
}: {
  state: State;
  dispatch: (id: AgentId) => void;
  quota: (agent: Agent) => void;
}) {
  return (
    <section className="agents-section">
      <div className="section-heading">
        <h2>
          <span className="section-dot" />
          我的 Agent 伙伴
        </h2>
        <span className="muted tiny">
          {state.agents.filter((a) => a.installed).length} 个可用入口
        </span>
      </div>
      <div className="agent-grid">
        {state.agents.map((agent) => (
          <article key={agent.id} className={`agent-card ${agent.id}`}>
            <div className="agent-card-top">
              <AgentLogo id={agent.id} />
              <span className="agent-kind">
                {agent.capability === "cli" ? "本地 CLI" : "手动转交"}
              </span>
              <IconButton
                icon={MoreHorizontal}
                label={`记录 ${agent.name} 额度`}
                onClick={() => quota(agent)}
              />
            </div>
            <h3>{agent.name}</h3>
            <p>{agent.subtitle}</p>
            <div className="agent-status">
              <i
                className={
                  agent.running ? "busy" : agent.installed ? "" : "unavailable"
                }
              />
              {agent.running
                ? `${agent.running} 项任务进行中`
                : agent.capability === "handoff"
                  ? "复制需求后打开网页"
                  : agent.installed
                    ? "已检测 · 登录待验证"
                    : "未检测到 CLI"}
            </div>
            <div className="agent-card-bottom">
              <button className="quota-label" onClick={() => quota(agent)}>
                {agent.quota?.remainingPercent != null ? (
                  <>
                    <strong>{agent.quota.remainingPercent}%</strong>
                    <span>
                      {agent.quota?.source === "manual"
                        ? "剩余 · 手动记录"
                        : "剩余 · 自动读取"}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="quota-dash">—</span>
                    <span>
                      {agent.quota?.status === "stale"
                        ? "本次读取失败"
                        : "额度暂不可读"}
                    </span>
                  </>
                )}
              </button>
              <button
                className="agent-go"
                title={`交给 ${agent.name}`}
                aria-label={`交给 ${agent.name}`}
                onClick={() => dispatch(agent.id)}
              >
                <ArrowUp size={16} />
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
function TasksSection({
  state,
  openTask,
  dispatch,
  expanded = false,
}: {
  state: State;
  openTask: (task: Task) => void;
  dispatch: () => void;
  expanded?: boolean;
}) {
  const [filter, setFilter] = useState("all");
  const filtered = state.tasks.filter(
    (t) =>
      filter === "all" ||
      (filter === "running"
        ? t.status === "running" || t.status === "handoff"
        : t.status === "completed"),
  );
  return (
    <section className={`tasks-section ${expanded ? "expanded" : ""}`}>
      <div className="section-heading">
        <h2>
          <span className="section-dot" />
          替你照看的小事
        </h2>
        <button className="text-button" onClick={dispatch}>
          <Plus size={14} />
          交给 Agent
        </button>
      </div>
      <div className="task-list">
        <div className="task-tabs">
          {[
            { id: "all", text: "全部", n: state.tasks.length },
            {
              id: "running",
              text: "待办",
              n: state.tasks.filter((t) =>
                ["running", "handoff"].includes(t.status),
              ).length,
            },
            {
              id: "completed",
              text: "已完成",
              n: state.tasks.filter((t) => t.status === "completed").length,
            },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setFilter(tab.id)}
              className={filter === tab.id ? "selected" : ""}
            >
              {tab.text}
              <span>{tab.n}</span>
            </button>
          ))}
          <span className="task-scope">Bobo 发起的任务</span>
        </div>
        {filtered.length ? (
          filtered.slice(0, expanded ? 100 : 4).map((t) => (
            <button className="task-row" key={t.id} onClick={() => openTask(t)}>
              <span className={`task-symbol ${t.status}`}>
                {t.status === "running" ? (
                  <LoaderCircle size={17} className="spin" />
                ) : t.status === "completed" ? (
                  <Check size={17} />
                ) : (
                  <ClipboardList size={17} />
                )}
              </span>
              <div>
                <strong>{t.title}</strong>
                <small>
                  {agentNames[t.agent]}
                  <span>·</span>
                  {timeText(t.createdAt)}
                </small>
              </div>
              <span className={`task-status ${t.status}`}>
                {taskStatuses[t.status]}
              </span>
              <ChevronRight size={16} />
            </button>
          ))
        ) : (
          <div className="empty-tasks">
            <div className="empty-task-art">
              <ClipboardList size={25} />
              <span>✦</span>
            </div>
            <div>
              <h3>
                {filter === "all" ? "把一件小事交给我吧" : "这里还没有任务"}
              </h3>
              <p>
                {filter === "all"
                  ? "你专心做自己的事，结果到了我来告诉你。"
                  : "新的进展会出现在这里。"}
              </p>
            </div>
            <button className="outline small" onClick={dispatch}>
              创建任务
              <ArrowRight size={14} />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
function Diary({ state }: { state: State }) {
  const [filter, setFilter] = useState("all");
  const moments = state.diary.filter(
    (m) => filter === "all" || m.kind === filter,
  );
  return (
    <section className="diary-section">
      <div className="diary-banner">
        <BookHeart size={24} />
        <div>
          <h3>这是我们一起生活过的证明。</h3>
          <p>
            {state.diary.length} 段记录，{state.pet.generation}{" "}
            次相遇。每一代的故事都留在这里。
          </p>
        </div>
      </div>
      <div className="filter-pills">
        {[
          { id: "all", text: "全部回忆" },
          { id: "life", text: "日常照料" },
          { id: "growth", text: "成长时刻" },
          { id: "work", text: "一起办的小事" },
        ].map((item) => (
          <button
            key={item.id}
            className={filter === item.id ? "selected" : ""}
            onClick={() => setFilter(item.id)}
          >
            {item.text}
          </button>
        ))}
      </div>
      <div className="diary-timeline">
        {moments.map((moment) => (
          <article key={moment.id} className="diary-entry">
            <span className={`diary-icon ${moment.kind}`}>
              {moment.kind === "growth" ? (
                <Sprout size={18} />
              ) : moment.kind === "work" ? (
                <Check size={18} />
              ) : (
                <Heart size={18} />
              )}
            </span>
            <div>
              <div className="diary-entry-meta">
                {dateText(moment.at)} · {timeText(moment.at)}
                <span>第 {moment.generation} 代</span>
              </div>
              <h3>{moment.title}</h3>
              <p>{moment.text}</p>
            </div>
          </article>
        ))}
        {!moments.length && (
          <p className="empty-note">这一页还空着，我们慢慢把它写满。</p>
        )}
      </div>
    </section>
  );
}
function Growth({
  state,
  stage,
  perform,
}: {
  state: State;
  stage: Stage;
  perform: (fn: () => Promise<unknown>, success?: string) => void;
}) {
  const [preview, setPreview] = useState<Stage>(stage);
  const age = Math.floor(state.pet.companionMs / DAY);
  return (
    <section className="growth-section">
      <div className="growth-preview">
        <div className="growth-preview-art">
          <Bobo stage={preview} />
        </div>
        <div>
          <div className="eyebrow">A LIFE, AT ITS OWN PACE</div>
          <h2>{stageNames[preview]}</h2>
          <p>{STAGES.find((s) => s.id === preview)?.description}</p>
          <Badge color="sage">
            {preview === stage ? "现在的 Bobo" : "形态预览 · 存档不会改变"}
          </Badge>
          <small>
            相遇 {age + 1} 天 · 第 {state.pet.generation} 代
          </small>
        </div>
      </div>
      <div className="growth-road">
        {STAGES.map((s) => (
          <button
            key={s.id}
            className={`${preview === s.id ? "selected" : ""} ${stage === s.id ? "current" : ""}`}
            onClick={() => setPreview(s.id as Stage)}
          >
            <span className="growth-node">
              {s.id === "seed" ? (
                <span>•</span>
              ) : s.id === "memory" ? (
                <Flower2 size={17} />
              ) : (
                <Leaf size={17} />
              )}
            </span>
            <strong>{s.name}</strong>
            <small>
              {s.id === "seed"
                ? "第一天"
                : s.id === "memory"
                  ? "约半年以后"
                  : `第 ${s.from + 1} 天起`}
            </small>
            {stage === s.id && <em>现在</em>}
          </button>
        ))}
      </div>
      <div className="growth-notes">
        <article>
          <Clock3 size={20} />
          <h3>成长有自己的时间</h3>
          <p>
            按陪伴时间慢慢长大。长时间没打开电脑，Bobo
            会在两天后进入休眠，等待你回来。
          </p>
        </article>
        <article>
          <Heart size={20} />
          <h3>照料是相处，不是打卡</h3>
          <p>
            每天一点水、摸摸头，留下共同的记忆。离开时安心休息，回来时继续生活。
          </p>
        </article>
        <article>
          <Flower2 size={20} />
          <h3>告别以后，故事还在</h3>
          <p>
            约半年后，这代 Bobo
            的日记留下来。你可以种下新的种子，开始下一段相遇。
          </p>
        </article>
      </div>
      {stage === "memory" && (
        <div className="generation-action">
          <div>
            <h3>下一颗种子，已经准备好。</h3>
            <p>这代 Bobo 的日记会保留在小屋里。</p>
          </div>
          <button
            className="primary"
            onClick={() =>
              perform(() => api.nextGeneration(), "新的种子住进小屋啦。")
            }
          >
            <Sprout size={17} />
            培育下一代
          </button>
        </div>
      )}
      {state.archives.length > 0 && (
        <div className="archives">
          <h3>曾经住在这里的小伙伴</h3>
          {state.archives.map((pet) => (
            <div key={pet.id}>
              <Flower2 size={19} />
              <strong>
                {pet.name} · 第 {pet.generation} 代
              </strong>
              <span>
                {dateText(pet.bornAt)} — {dateText(pet.endedAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
function Settings({
  state,
  perform,
  refresh,
}: {
  state: State;
  perform: (fn: () => Promise<unknown>, success?: string) => void;
  refresh: () => Promise<unknown>;
}) {
  return (
    <div className="settings-content">
      {state.desktop && <ProjectMemory workspace={state.workspace} />}
      <section className="settings-card">
        <div className="settings-title">
          <Sparkles size={20} />
          <h2>Bobo 的大脑</h2>
          <Badge color={state.brain.configured ? "green" : "amber"}>
            {state.brain.configured
              ? "已配置"
              : state.brain.configurationIssue
                ? "需要接口地址"
                : "等待配置"}
          </Badge>
        </div>
        <p>自然语言交互与任务调度使用你的模型。日常动画和成长在本地运行。</p>
        <div className="config-line">
          <span>调度模型</span>
          <code>{state.brain.model}</code>
        </div>
        <div className="config-line">
          <span>API 模式</span>
          <code>{state.brain.mode}</code>
        </div>
        <div className="env-path">
          <span>配置文件</span>
          <code>{state.brain.envPath}</code>
        </div>
        {state.brain.configurationIssue && (
          <p className="configuration-issue">
            {state.brain.configurationIssue}
          </p>
        )}
        <pre>
          {state.brain.provider === "model-hub" ? (
            "MODEL_HUB_AK=已在本地配置\nMODEL_HUB_BASE_URL=接口地址\nMODEL_HUB_MODEL=gpt-5.6-sol\n# Azure 兼容接口\nMODEL_HUB_PROTOCOL=azure\nMODEL_HUB_API_VERSION=2024-02-01"
          ) : (
            <>
              OPENAI_API_KEY=你的 Key{"\n"}OPENAI_MODEL=gpt-5.6-sol{"\n"}
              OPENAI_API_MODE=responses
            </>
          )}
        </pre>
        <div className="setting-bottom">
          <button
            className="outline small"
            onClick={() => perform(() => api.pickEnvFile(), "配置文件已切换。")}
          >
            {" "}
            <FolderOpen size={14} />
            选择配置文件
          </button>
          <span>Key 只在本地主进程读取，不发送到界面。</span>
          <button
            className="outline small"
            onClick={() => perform(refresh, "已经重新读取配置。")}
          >
            <ArrowDownToLine size={14} />
            重新读取
          </button>
        </div>
      </section>
      <section className="settings-card">
        <div className="settings-title">
          <FolderOpen size={20} />
          <h2>Agent 的工作目录</h2>
        </div>
        <p>
          Trae、Codex 和 Claude Code 在这里执行任务。选择你要处理的项目目录。
        </p>
        <div className="workspace-path">
          {state.workspace || "还没有选择工作目录"}
        </div>
        <button
          className="outline small"
          onClick={() => perform(() => api.pickWorkspace())}
        >
          <FolderOpen size={15} />
          选择目录
        </button>
        <div className="setting-toggle">
          <div>
            <strong>允许在工作目录中修改文件</strong>
            <p>
              Codex 使用 workspace-write；CC 自动接受文件编辑；Trae
              允许文件编辑，其他操作沿用其权限机制。
            </p>
          </div>
          <Toggle
            label="允许修改文件"
            checked={state.settings.allowEdits}
            onChange={() =>
              perform(() =>
                api.setSettings({ allowEdits: !state.settings.allowEdits }),
              )
            }
          />
        </div>
        <p className="settings-footnote">
          关闭时 Codex 只读运行，CC 和 Trae
          使用计划模式；它们的工具权限不等于系统级沙箱。这里只追踪 Bobo
          发起的任务。
        </p>
      </section>
      <section className="settings-card">
        <div className="settings-title">
          <h2>让 Bobo 照看工作</h2>
        </div>
        <div className="setting-toggle">
          <div>
            <strong>新任务自动照看</strong>
            <p>
              确认中断后有限恢复，遇到权限、未知错误或重复失败再通知你。关闭时也会暂停现有任务的自动恢复。
            </p>
          </div>
          <Toggle
            label="自动照看"
            checked={state.settings.superviseTasks}
            onChange={() =>
              perform(() =>
                api.setSettings({
                  superviseTasks: !state.settings.superviseTasks,
                }),
              )
            }
          />
        </div>
        <p>限额时允许哪些工具接手新任务</p>
        <div className="workflow-agent-options">
          {state.agents
            .filter((a) => a.capability === "cli")
            .map((a) => (
              <label key={a.id}>
                <input
                  type="checkbox"
                  checked={state.settings.fallbackAgents.includes(a.id)}
                  onChange={() =>
                    perform(() =>
                      api.setSettings({
                        fallbackAgents: state.settings.fallbackAgents.includes(
                          a.id,
                        )
                          ? state.settings.fallbackAgents.filter(
                              (id) => id !== a.id,
                            )
                          : [...state.settings.fallbackAgents, a.id],
                      }),
                    )
                  }
                />
                {a.name}
              </label>
            ))}
        </div>
        <p className="settings-footnote">
          默认最多 3
          次尝试，含首次；每项任务可单独调整。后台监听不调用模型；恢复执行本身会产生用量。只照看
          Bobo 发起的任务，关闭应用后不继续监控。
        </p>
      </section>
      <section className="settings-card">
        <div className="settings-title">
          <Leaf size={20} />
          <h2>桌面上的陪伴</h2>
        </div>
        {[
          {
            key: "petVisible" as const,
            title: "显示桌宠",
            note: "关闭记录窗口后，Bobo 继续留在桌面。",
          },
          {
            key: "alwaysOnTop" as const,
            title: "宠物保持在最前面",
            note: "方便随时看看它，也可以关闭。",
          },
          {
            key: "quiet" as const,
            title: "安静模式",
            note: "关闭系统通知，任务结果仍保留在面板。",
          },
        ].map((item) => (
          <div key={item.key} className="setting-toggle">
            <div>
              <strong>{item.title}</strong>
              <p>{item.note}</p>
            </div>
            <Toggle
              label={item.title}
              checked={state.settings[item.key]}
              onChange={() =>
                perform(() =>
                  item.key === "petVisible"
                    ? api.togglePet(!state.settings.petVisible)
                    : api.setSettings({
                        [item.key]: !state.settings[item.key],
                      }),
                )
              }
            />
          </div>
        ))}
      </section>
      <section className="settings-card">
        <div className="settings-title">
          <Terminal size={20} />
          <h2>用量小账本</h2>
        </div>
        <p>
          只统计 Bobo 调度大脑实际返回的 Token。Agent
          自己的用量在任务结果里记录。
        </p>
        <div className="usage-grid">
          <div>
            <strong>{formatNumber(state.usage.brainCalls)}</strong>
            <span>模型调用</span>
          </div>
          <div>
            <strong>{formatNumber(state.usage.brainInput)}</strong>
            <span>输入 Token</span>
          </div>
          <div>
            <strong>{formatNumber(state.usage.brainOutput)}</strong>
            <span>输出 Token</span>
          </div>
        </div>
      </section>
      <section className="settings-card roadmap">
        <div className="settings-title">
          <Flower2 size={20} />
          <h2>下一段小小计划</h2>
          <span className="muted tiny">尚未开放</span>
        </div>
        <p>
          好友串门、共同照片和花盆装饰会在后续版本加入。这一版先把陪伴与小管理员的日常做好。
        </p>
      </section>
    </div>
  );
}
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle ${checked ? "checked" : ""}`}
      onClick={onChange}
    >
      <span />
    </button>
  );
}
function DispatchModal({
  initial,
  state,
  close,
  perform,
}: {
  initial: AgentId | "auto";
  state: State;
  close: () => void;
  perform: (fn: () => Promise<unknown>, success?: string) => void;
}) {
  const [agent, setAgent] = useState<AgentId>(
    initial === "auto"
      ? state.agents.find((a) => a.installed && a.capability === "cli")?.id ||
          "doubao"
      : initial,
  );
  const [prompt, setPrompt] = useState(""),
    [title, setTitle] = useState(""),
    [artifactPath, setArtifactPath] = useState(""),
    [busy, setBusy] = useState(false);
  const submit = () => {
    setBusy(true);
    perform(
      async () => {
        await api.dispatch(
          agent,
          title,
          prompt,
          artifactPath.trim()
            ? {
                checks: [
                  { kind: "exists", path: artifactPath.trim(), expected: "" },
                ],
                maxAttempts: 3,
                tokenLimit: null,
              }
            : undefined,
        );
        close();
      },
      agent === "doubao"
        ? "转交卡片准备好了，点击任务打开豆包。"
        : "任务交出去了，我替你关注进度。",
    );
    setTimeout(() => setBusy(false), 500);
  };
  return (
    <Modal
      title="交给 Agent 一件小事"
      description="需求原样转交，你可以在任务面板查看进展。"
      close={close}
    >
      <div className="agent-picker">
        {state.agents.map((a) => (
          <button
            key={a.id}
            className={agent === a.id ? "selected" : ""}
            onClick={() => setAgent(a.id)}
          >
            <AgentLogo id={a.id} />
            <strong>{a.name}</strong>
            <small>
              {a.capability === "handoff"
                ? "手动转交"
                : a.installed
                  ? "本地 CLI"
                  : "未安装"}
            </small>
          </button>
        ))}
      </div>
      <label className="field">
        小事的名字 <span>可选</span>
        <input
          placeholder="例如：整理这个项目的说明文档"
          maxLength={100}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="field">
        告诉它要做什么
        <textarea
          aria-label="任务需求"
          placeholder="写下目标、相关信息和你希望得到的结果…"
          maxLength={16000}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
        />
      </label>
      {agent !== "doubao" && (
        <label className="field">
          需要交付的文件 <span>可选，工作目录内相对路径</span>
          <input
            aria-label="交付文件路径"
            placeholder="例如 outputs/report.md"
            value={artifactPath}
            onChange={(e) => setArtifactPath(e.target.value)}
          />
        </label>
      )}
      <div className="dispatch-context">
        <FolderOpen size={15} />
        {agent === "doubao" ? (
          "生成转交卡片；你复制后粘贴到豆包。"
        ) : (
          <span>
            {state.workspace || "还没有工作目录，请先到设置选择"}
            <small>
              {state.settings.allowEdits ? "允许文件编辑" : "只读 / 计划模式"}
            </small>
          </span>
        )}
      </div>
      <div className="modal-actions">
        <button className="outline" onClick={close}>
          再想想
        </button>
        <button
          className="primary"
          disabled={!prompt.trim() || busy}
          onClick={submit}
        >
          {busy ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <ArrowUp size={16} />
          )}
          交给 {agentNames[agent]}
        </button>
      </div>
    </Modal>
  );
}
function QuotaModal({
  agent,
  close,
  perform,
}: {
  agent: Agent;
  close: () => void;
  perform: (fn: () => Promise<unknown>, success?: string) => void;
}) {
  const [remaining, setRemaining] = useState(
      agent.quota?.remainingPercent?.toString() || "",
    ),
    [reset, setReset] = useState(""),
    [note, setNote] = useState(agent.quota?.note || "");
  return (
    <Modal
      title={`${agent.name} 的额度小记`}
      description="目前手动记录，以工具自身显示的额度为准。Token 用量不等于订阅剩余额度。"
      close={close}
    >
      <label className="field">
        剩余额度 <span>不知道可以留空</span>
        <div className="percent-input">
          <input
            type="number"
            min="0"
            max="100"
            value={remaining}
            onChange={(e) => setRemaining(e.target.value)}
            placeholder="例如 60"
          />
          <span>%</span>
        </div>
      </label>
      <label className="field">
        额度重置时间 <span>可选</span>
        <input
          type="datetime-local"
          value={reset}
          onChange={(e) => setReset(e.target.value)}
        />
      </label>
      <label className="field">
        备注
        <input
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
          placeholder="例如：五小时窗口 / 本周额度"
        />
      </label>
      {agent.quota && (
        <p className="muted tiny">
          上次记录：{dateText(agent.quota.updatedAt)}{" "}
          {timeText(agent.quota.updatedAt)}
        </p>
      )}
      <div className="modal-actions">
        <button className="outline" onClick={close}>
          取消
        </button>
        <button
          className="primary"
          onClick={() =>
            perform(async () => {
              await api.setQuota(agent.id, {
                remainingPercent: remaining === "" ? null : Number(remaining),
                resetAt: reset
                  ? new Date(reset).toISOString()
                  : agent.quota?.resetAt || null,
                note,
              });
              close();
            }, "额度已经记下来了。")
          }
        >
          <Check size={16} />
          记下来
        </button>
      </div>
    </Modal>
  );
}
function TaskModal({
  task,
  close,
  perform,
}: {
  task: Task;
  close: () => void;
  perform: (fn: () => Promise<unknown>, success?: string) => void;
}) {
  const [manualResult, setManualResult] = useState("");
  return (
    <Modal
      title={task.title}
      description={`${agentNames[task.agent]} · ${dateText(task.createdAt)} ${timeText(task.createdAt)}`}
      close={close}
    >
      <div className="task-detail-status">
        <Badge
          color={
            task.status === "failed"
              ? "rose"
              : task.status === "running"
                ? "amber"
                : "sage"
          }
        >
          {taskStatuses[task.status]}
        </Badge>
        <span>{task.progress}</span>
      </div>
      <div className="task-detail-block">
        <h3>交给它的需求</h3>
        <p>{task.prompt}</p>
      </div>
      {task.result && (
        <div className="task-detail-block result">
          <h3>
            {task.resultSource === "manual"
              ? "你记录的结果"
              : "Agent 返回的结果"}
          </h3>
          <p>{task.result}</p>
        </div>
      )}
      {task.error && (
        <div className="task-error">
          <h3>这次没能完成</h3>
          <p>{task.error}</p>
        </div>
      )}
      {task.usage && (
        <div className="task-usage">
          输入 {formatNumber(task.usage.input)} · 输出{" "}
          {formatNumber(task.usage.output)} Token
          {task.usage.cost != null && (
            <> · CLI 估算 ${task.usage.cost.toFixed(4)}</>
          )}
        </div>
      )}
      <TaskWorkflow key={task.id} task={task} />
      {task.status === "handoff" && (
        <>
          <button
            className="primary full"
            onClick={() =>
              perform(
                () => api.handoff(task.id),
                "需求已复制，请在豆包中粘贴发送。",
              )
            }
          >
            <ExternalLink size={16} />
            复制需求并打开豆包
          </button>
          <label className="field">
            拿到结果后，记在这里
            <textarea
              rows={3}
              value={manualResult}
              onChange={(e) => setManualResult(e.target.value)}
              placeholder="粘贴豆包的回复，或写下结果摘要…"
            />
          </label>
        </>
      )}
      <div className="modal-actions">
        <button className="outline" onClick={close}>
          关闭详情
        </button>
        {task.status === "running" && (
          <button
            className="outline danger"
            onClick={() =>
              perform(() => api.cancelTask(task.id), "已经停止这项任务。")
            }
          >
            <Power size={14} />
            停止任务
          </button>
        )}
        {task.status === "handoff" && (
          <button
            className="primary"
            disabled={!manualResult.trim()}
            onClick={() =>
              perform(async () => {
                await api.completeHandoff(task.id, manualResult);
                close();
              }, "结果记下来了。")
            }
          >
            <Check size={16} />
            记录完成
          </button>
        )}
      </div>
    </Modal>
  );
}
