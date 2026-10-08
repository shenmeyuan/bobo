import { randomUUID } from "node:crypto";

export function ensureConversations(state) {
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
    });
    for (const task of state.tasks || [])
      task.conversationId ||= state.activeConversationId;
  }
  const current =
    state.conversations.find((c) => c.id === state.activeConversationId) ||
    state.conversations[0];
  state.activeConversationId = current.id;
  state.messages = current.messages;
}

export function syncConversation(state) {
  ensureConversations(state);
  const current = state.conversations.find(
    (c) => c.id === state.activeConversationId,
  );
  current.messages = state.messages;
  current.title =
    state.messages.find((m) => m.role === "user")?.content.slice(0, 32) ||
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

export function newConversation(state) {
  ensureConversations(state);
  const now = Date.now(),
    id = randomUUID();
  state.conversations.push({
    id,
    title: "新对话",
    createdAt: now,
    updatedAt: now,
    messages: [],
  });
  return selectConversation(state, id);
}
