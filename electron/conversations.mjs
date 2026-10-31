import { randomUUID } from "node:crypto";

export function ensureConversations(state, initialScope = { kind: "legacy" }) {
  state.conversations ||= [];
  if (!state.conversations.length) {
    const now = Date.now();
    state.activeConversationId = randomUUID();
    state.conversations.push({
      id: state.activeConversationId,
      title:
        state.messages?.find((m) => m.role === "user")?.content.slice(0, 32) ||
        "新对话",
      createdAt: now,
      updatedAt: now,
      messages: state.messages || [],
      scope: initialScope,
    });
    for (const task of state.tasks || [])
      task.conversationId ||= state.activeConversationId;
  }
  for (const conversation of state.conversations)
    if (
      !conversation.scope ||
      !["general", "workspace", "legacy"].includes(conversation.scope.kind) ||
      (conversation.scope.kind === "workspace" &&
        typeof conversation.scope.path !== "string")
    )
      conversation.scope = { kind: "legacy" };
  const current =
    state.conversations.find((c) => c.id === state.activeConversationId) ||
    state.conversations[0];
  state.activeConversationId = current.id;
  state.messages = current.messages;
}

export function syncConversation(state, id = state.activeConversationId) {
  ensureConversations(state);
  const current = state.conversations.find((c) => c.id === id);
  if (id === state.activeConversationId) current.messages = state.messages;
  current.title =
    current.messages.find((m) => m.role === "user")?.content.slice(0, 32) ||
    "新对话";
  current.updatedAt = Date.now();
}

export function selectConversation(state, id) {
  ensureConversations(state);
  const current = state.conversations.find((c) => c.id === id);
  if (!current) throw new Error("这段对话不存在。");
  state.activeConversationId = id;
  state.messages = current.messages;
  return id;
}

export function newConversation(state, scope = { kind: "general" }) {
  ensureConversations(state);
  const now = Date.now(),
    id = randomUUID();
  state.conversations.push({
    id,
    title: "新对话",
    createdAt: now,
    updatedAt: now,
    messages: [],
    scope,
  });
  return selectConversation(state, id);
}
