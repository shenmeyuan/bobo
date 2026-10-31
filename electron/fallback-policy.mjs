const AGENTS = ["codex", "claude", "trae"];
export function consentRequired(message) {
  return Object.assign(new Error(message), {
    code: "CROSS_AGENT_CONSENT_REQUIRED",
  });
}
export const policy = (source = "default") => ({
  version: 1,
  source,
  updatedAt: Date.now(),
});
const known = (value) =>
  value?.version === 1 &&
  ["default", "user_ui", "model", "legacy_reset"].includes(value.source);

export function globalFallbackAgents(settings) {
  return settings.fallbackPolicy?.version === 1 &&
    settings.fallbackPolicy.source === "user_ui"
    ? (settings.fallbackAgents || []).filter((id) => AGENTS.includes(id))
    : [];
}

export function automaticAgentAllowed(root, agent) {
  const supervision = root.supervision;
  if (!known(supervision?.policy)) return false;
  if (agent === root.agent) return true;
  return (
    ["user_ui", "model"].includes(supervision.policy.source) &&
    supervision.allowedAgents?.includes(agent)
  );
}

// Inspect the raw saved markers: fresh defaults must never bless a legacy list.
export function migrateFallbackPolicy(state, saved) {
  const oldGlobal = saved?.settings;
  let reset = false;
  if (
    saved &&
    !(
      oldGlobal?.fallbackPolicy?.version === 1 &&
      ["default", "user_ui", "legacy_reset"].includes(
        oldGlobal.fallbackPolicy.source,
      )
    )
  ) {
    state.settings.fallbackAgents = [];
    state.settings.fallbackPolicy = policy("legacy_reset");
    state.settings.fallbackMigration = {
      previousAgents: oldGlobal?.fallbackAgents || [],
      resetTasks: 0,
      at: Date.now(),
      dismissed: false,
    };
    reset = true;
  }
  for (const task of state.tasks) {
    if (!task.supervision || known(task.supervision.policy)) continue;
    const supervision = task.supervision;
    supervision.policy = {
      ...policy("legacy_reset"),
      previousAgents: supervision.allowedAgents || [],
    };
    supervision.allowedAgents = AGENTS.includes(task.agent) ? [task.agent] : [];
    if (supervision.pending && supervision.pending.target !== task.agent) {
      supervision.pending = null;
      supervision.state = "attention";
      supervision.reason = "旧接手名单缺少明确授权记录，跨工具恢复已暂停。";
    }
    state.settings.fallbackMigration ||= {
      previousAgents: [],
      resetTasks: 0,
      at: Date.now(),
      dismissed: false,
    };
    state.settings.fallbackMigration.resetTasks++;
    reset = true;
  }
  return reset;
}
