import type { BoboAPI, State } from "./types";
import { createState } from "../../electron/state.mjs";
import { advancePet, careFor, stageOf } from "../../electron/pet.mjs";
const key = "bobo-browser-preview-v1";
function initial(): State {
  const base = createState();
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    saved = null;
  }
  return {
    ...base,
    ...(saved || {}),
    settings: { ...base.settings, ...saved?.settings },
    agents: [
      {
        id: "trae",
        name: "Trae / Coco",
        subtitle: "本地 CLI · 项目任务",
        installed: false,
        capability: "cli",
        description:
          "连接本机 traecli（Coco 版）；桌面应用中核实安装与登录状态。",
        running: 0,
        quota: null,
      },
      {
        id: "codex",
        name: "Codex",
        subtitle: "代码 · 分析 · 项目任务",
        installed: false,
        capability: "cli",
        description: "请在桌面应用中接入本地 Codex CLI。",
        running: 0,
        quota: null,
      },
      {
        id: "claude",
        name: "Claude Code",
        subtitle: "代码 · 研究 · 文件整理",
        installed: false,
        capability: "cli",
        description: "请在桌面应用中接入本地 Claude Code CLI。",
        running: 0,
        quota: null,
      },
      {
        id: "doubao",
        name: "豆包",
        subtitle: "聊天 · 灵感 · 日常问题",
        installed: true,
        capability: "handoff",
        description: "桌面应用支持复制需求并打开豆包。",
        running: 0,
        quota: null,
      },
    ],
    brain: {
      configured: false,
      model: "gpt-5.6-sol",
      mode: "responses",
      envPath: ".env",
    },
    desktop: false,
    workspace: "",
  } as State;
}
function previewAPI(): BoboAPI {
  let state = initial();
  const change = () => {
    localStorage.setItem(key, JSON.stringify(state));
    window.dispatchEvent(new Event("bobo-preview-changed"));
  };
  const unavailable = async (): Promise<never> => {
    throw new Error("这是浏览器预览，请在 Bobo 桌面应用中使用这个功能。");
  };
  return {
    async getState() {
      state.pet = advancePet(state.pet);
      state.agents = state.agents.map((a) => ({
        ...a,
        quota: state.quotas[a.id] || null,
      }));
      return structuredClone(state);
    },
    async care(action) {
      const result = careFor(state.pet, action);
      state.pet = result.pet;
      if (
        result.changed &&
        action !== "sleep" &&
        result.pet.careCounts[action] === 1
      )
        state.diary.unshift({
          id: crypto.randomUUID(),
          at: Date.now(),
          kind: "life",
          title: {
            water: "今天的第一口水",
            touch: "被温柔地摸了摸",
            sun: "一起晒了太阳",
          }[action],
          text: result.text,
          generation: state.pet.generation,
        });
      change();
      return result.text;
    },
    refreshQuotas: unavailable,
    async newConversation() {
      state.conversations ||= [
        {
          id: crypto.randomUUID(),
          title: "之前的对话",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: state.messages,
        },
      ];
      const id = crypto.randomUUID();
      state.conversations.push({
        id,
        title: "新对话",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      });
      state.activeConversationId = id;
      state.messages = [];
      change();
      return id;
    },
    async selectConversation(id) {
      const next = state.conversations?.find((c) => c.id === id);
      if (!next) throw new Error("这段对话不存在。");
      state.activeConversationId = id;
      state.messages = next.messages;
      change();
    },
    async chat(content) {
      const answer =
        "这里是小屋的浏览器预览。桌面应用配置 Key 后，我就能和你聊天、帮你调度 Agent。现在也可以摸摸我、浇一点水。";
      state.messages.push(
        { id: crypto.randomUUID(), role: "user", content, at: Date.now() },
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: answer,
          at: Date.now(),
        },
      );
      const current = state.conversations?.find(
        (c) => c.id === state.activeConversationId,
      );
      if (current) {
        current.messages = state.messages;
        current.title =
          state.messages.find((m) => m.role === "user")?.content.slice(0, 32) ||
          "新对话";
        current.updatedAt = Date.now();
      }
      change();
      return answer;
    },
    dispatch: unavailable,
    cancelTask: unavailable,
    getWorkflow: unavailable,
    getProjectMemory: unavailable,
    saveProjectMemory: unavailable,
    revokeProjectMemory: unavailable,
    setContract: unavailable,
    resumeTask: unavailable,
    setSupervision: unavailable,
    recordCorrection: unavailable,
    verifyTask: unavailable,
    handoff: unavailable,
    completeHandoff: unavailable,
    pickWorkspace: unavailable,
    pickEnvFile: unavailable,
    async setSettings(settings) {
      state.settings = { ...state.settings, ...settings };
      change();
    },
    async setQuota(agent, quota) {
      state.quotas[agent] = {
        remainingPercent: quota.remainingPercent ?? null,
        resetAt: quota.resetAt || null,
        note: quota.note || "",
        source: "manual",
        updatedAt: Date.now(),
      };
      change();
    },
    async nextGeneration() {
      if (stageOf(state.pet).id !== "memory")
        throw new Error("Bobo 还在长大。");
      await unavailable();
    },
    togglePet: unavailable,
    async openHome() {},
    openPetChat: unavailable,
    async setPetExpanded() {},
    async dismissPetNotice() {},
    onNavigate() {
      return () => {};
    },
    async closeWindow() {},
    async movePet() {},
    async setPetInteractive() {},
    onChange(callback) {
      window.addEventListener("bobo-preview-changed", callback);
      return () => window.removeEventListener("bobo-preview-changed", callback);
    },
    onPetMessage() {
      return () => {};
    },
  };
}
export const api = window.bobo || previewAPI();
export const stageNames = {
  seed: "种子期",
  sprout: "发芽期",
  young: "幼年期",
  adult: "成年期",
  elder: "老年期",
  memory: "回忆期",
};
export const agentNames = {
  trae: "Trae / Coco",
  codex: "Codex",
  claude: "Claude Code",
  doubao: "豆包",
};
export const taskStatuses = {
  running: "进行中",
  queued: "排队中",
  handoff: "待手动转交",
  completed: "执行结束",
  attention: "需要处理",
  failed: "未完成",
  cancelled: "已停止",
  interrupted: "已中断",
};
export const dateText = (time: number) =>
  new Date(time).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
export const timeText = (time: number) =>
  new Date(time).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
