import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../electron/store.mjs";
import { createState } from "../electron/state.mjs";

test("legacy messages and tasks migrate; new chats isolate context and survive restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-conversations-"));
  try {
    const legacy = createState();
    legacy.messages.push({
      id: "old",
      role: "user",
      content: "以前的 SQL 需求",
      at: 1,
    });
    legacy.tasks.push({ id: "task", status: "completed" });
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(legacy));
    const store = new Store(dir);
    const first = store.state.activeConversationId;
    assert.equal(store.state.tasks[0].conversationId, first);
    const second = store.newConversation();
    assert.notEqual(second, first);
    assert.deepEqual(store.state.messages, []);
    store.message("user", "第二段独立需求");
    store.message("assistant", "第二段回复");
    store.selectConversation(first);
    assert.deepEqual(
      store.state.messages.map((m) => m.content),
      ["以前的 SQL 需求"],
    );
    for (let i = 0; i < 120; i++) store.message("assistant", "历史消息 " + i);
    assert.equal(store.state.messages.length, 121);
    assert.throws(() => store.selectConversation("missing"), /不存在/);
    const restored = new Store(dir);
    assert.equal(restored.state.activeConversationId, first);
    assert.equal(restored.state.conversations.length, 2);
    restored.selectConversation(second);
    assert.deepEqual(
      restored.state.messages.map((m) => m.content),
      ["第二段独立需求", "第二段回复"],
    );
    assert.equal(
      restored.state.conversations.find((c) => c.id === second).title,
      "第二段独立需求",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
