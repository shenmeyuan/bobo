import fs from "node:fs";
import { loadConfig } from "./config.mjs";

export function effectiveConversationScope(state) {
  const workspace = state.settings.workspace || loadConfig().workspace;
  if (!workspace) return { kind: "general" };
  try {
    const canonical = fs.realpathSync(workspace);
    if (!fs.statSync(canonical).isDirectory())
      throw new Error("not a directory");
    fs.accessSync(canonical, fs.constants.R_OK);
    return { kind: "workspace", path: canonical };
  } catch {
    throw new Error("当前项目目录无法访问，请重新选择目录后新建对话。");
  }
}

export function sameConversationScope(a, b) {
  return (
    a?.kind === b?.kind &&
    (a.kind === "general" || (a.kind === "workspace" && a.path === b.path))
  );
}

export function conversationContext(state) {
  const current = state.conversations?.find(
    (c) => c.id === state.activeConversationId,
  );
  try {
    const scope = effectiveConversationScope(state);
    const canSend = sameConversationScope(current?.scope, scope);
    return {
      scope,
      canSend,
      reason: canSend ? "" : "仅查看；请在当前项目新建对话。",
    };
  } catch (error) {
    return { scope: null, canSend: false, reason: error.message };
  }
}

export function assertConversationScope(
  state,
  id = state.activeConversationId,
) {
  const scope = effectiveConversationScope(state);
  const conversation = state.conversations?.find((c) => c.id === id);
  if (!sameConversationScope(conversation?.scope, scope))
    throw new Error("这段历史仅供查看；请在当前项目新建对话。");
  return scope;
}

export function assertRequestContext(state, context) {
  if (
    !context ||
    context.conversationId !== state.activeConversationId ||
    context.allowEdits !== Boolean(state.settings.allowEdits) ||
    !sameConversationScope(context.scope, effectiveConversationScope(state))
  )
    throw new Error("项目、对话或权限已改变，请在当前项目重新发起。");
}

export function taskInCurrentScope(state, task) {
  const scope = effectiveConversationScope(state);
  if (task.workspace) {
    try {
      return (
        scope.kind === "workspace" &&
        fs.realpathSync(task.workspace) === scope.path
      );
    } catch {
      return false;
    }
  }
  const conversation = state.conversations?.find(
    (c) => c.id === task.conversationId,
  );
  return scope.kind === "general" && conversation?.scope?.kind === "general";
}
