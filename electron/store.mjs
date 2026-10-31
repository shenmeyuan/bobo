import fs from "node:fs";
import {
  ensureConversations,
  syncConversation,
  selectConversation,
  newConversation,
} from "./conversations.mjs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { newPet, advancePet, stageOf, careFor } from "./pet.mjs";
import { createState } from "./state.mjs";
import { ensureWorkMemory } from "./work-memory.mjs";
import {
  effectiveConversationScope,
  sameConversationScope,
} from "./conversation-scope.mjs";
import { migrateFallbackPolicy } from "./fallback-policy.mjs";
export { createState } from "./state.mjs";
export class Store {
  constructor(dir, onChange = () => {}) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, "state.json");
    this.onChange = onChange;
    this.state = createState();
    let saved;
    if (fs.existsSync(this.file)) {
      saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (
        saved.version !== 1 ||
        !saved.pet ||
        !Array.isArray(saved.tasks) ||
        !Array.isArray(saved.diary)
      )
        throw new Error("Bobo 的存档格式无法读取；原文件已保留。");
      this.state = {
        ...this.state,
        ...saved,
        settings: { ...this.state.settings, ...saved.settings },
        usage: { ...this.state.usage, ...saved.usage },
      };
    }
    let initialScope = { kind: "legacy" };
    if (!saved) {
      try {
        initialScope = effectiveConversationScope(this.state);
      } catch {
        /* Invalid directories stay read-only. */
      }
    }
    ensureConversations(this.state, initialScope);
    migrateFallbackPolicy(this.state, saved);
    ensureWorkMemory(this.state);
    this.state.pet = advancePet(this.state.pet);
    // A detached child may survive a crash; the supervisor checks its PID before recovery.
    for (const task of this.state.tasks)
      if (["running", "queued"].includes(task.status)) {
        task.status = "interrupted";
        task.finishedAt = Date.now();
        task.error = "应用已重新启动，原任务状态失联，等待核对原进程。";
      }
    this.save();
  }
  save() {
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(temporary, this.file);
    this.onChange();
  }
  moment(title, text, kind = "life") {
    this.state.diary.unshift({
      id: randomUUID(),
      at: Date.now(),
      title,
      text,
      kind,
      generation: this.state.pet.generation,
    });
    this.state.pet.moments++;
  }
  tick() {
    const before = stageOf(this.state.pet).id;
    this.state.pet = advancePet(this.state.pet);
    if (stageOf(this.state.pet).id !== before)
      this.moment(
        `长到了${stageOf(this.state.pet).name}`,
        stageOf(this.state.pet).description,
        "growth",
      );
    this.save();
  }
  care(action) {
    const result = careFor(this.state.pet, action);
    this.state.pet = result.pet;
    if (
      result.changed &&
      action !== "sleep" &&
      result.pet.careCounts[action] === 1
    ) {
      this.moment(
        {
          water: "今天的第一口水",
          touch: "被温柔地摸了摸",
          sun: "一起晒了太阳",
        }[action],
        result.text,
      );
    }
    this.save();
    return result.text;
  }
  nextGeneration() {
    if (stageOf(this.state.pet).id !== "memory")
      throw new Error("Bobo 还在陪你长大。新的种子会在这段旅程结束后准备好。");
    this.state.archives.unshift({ ...this.state.pet, endedAt: Date.now() });
    this.state.pet = newPet(this.state.pet.generation + 1);
    this.moment(
      "下一颗种子，新的相遇",
      "旧 Bobo 的相册和纪念物留在这里。新的小伙伴，会有自己的故事。",
      "growth",
    );
    this.save();
  }
  newConversation(scope = effectiveConversationScope(this.state)) {
    const id = newConversation(this.state, scope);
    this.save();
    return id;
  }
  alignConversation() {
    const scope = effectiveConversationScope(this.state);
    const current = this.state.conversations.find(
      (c) => c.id === this.state.activeConversationId,
    );
    if (sameConversationScope(current?.scope, scope)) return current.id;
    const existing = [...this.state.conversations]
      .filter((c) => sameConversationScope(c.scope, scope))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!existing) return this.newConversation(scope);
    this.selectConversation(existing.id);
    return existing.id;
  }
  selectConversation(id) {
    selectConversation(this.state, id);
    this.save();
  }
  message(role, content, conversationId = this.state.activeConversationId) {
    const conversation = this.state.conversations.find(
      (c) => c.id === conversationId,
    );
    if (!conversation) throw new Error("这段对话不存在。");
    conversation.messages.push({
      id: randomUUID(),
      role,
      content: content.slice(0, 16000),
      at: Date.now(),
    });
    if (conversationId === this.state.activeConversationId)
      this.state.messages = conversation.messages;
    syncConversation(this.state, conversationId);
    this.save();
  }
}
