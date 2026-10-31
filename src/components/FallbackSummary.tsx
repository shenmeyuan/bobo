import type { State } from "../lib/types";
import { agentNames } from "../lib/api";

export function FallbackSummary({ state }: { state: State }) {
  const allowed =
    state.settings.fallbackPolicy?.source === "user_ui"
      ? state.settings.fallbackAgents
      : [];
  return (
    <p className="workflow-muted" aria-label="新任务接手政策">
      {state.settings.superviseTasks
        ? `新任务最多尝试 3 次；${allowed.length ? `允许接手：${allowed.map((id) => agentNames[id]).join("、")}` : "仅原工具自动恢复，未授权跨工具接手"}。`
        : "新任务自动照看已关闭。"}
    </p>
  );
}
