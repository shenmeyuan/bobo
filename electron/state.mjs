import { newPet } from "./pet.mjs";
const randomUUID = () => globalThis.crypto.randomUUID();
export function createState(now = Date.now()) {
  return {
    version: 1,
    pet: { ...newPet(1, now), moments: 1 },
    archives: [],
    diary: [
      {
        id: randomUUID(),
        at: now,
        kind: "growth",
        title: "我们的第一天",
        text: "一颗胡萝卜种子住进了你的桌面。慢慢长大，也慢慢熟悉你。",
        generation: 1,
      },
    ],
    tasks: [],
    messages: [],
    quotas: {},
    usage: { brainInput: 0, brainOutput: 0, brainCalls: 0 },
    coordinationUsage: [],
    settings: {
      workspace: "",
      allowEdits: false,
      superviseTasks: true,
      fallbackAgents: ["codex", "claude", "trae"],
      quiet: false,
      alwaysOnTop: true,
      petVisible: true,
    },
  };
}
