import { quotaQueryAgent, formatQuotaReply } from "./quota.mjs";
import { createModelClient, modelRequestOptions } from "./model-client.mjs";
import { BOBO_SYSTEM_PROMPT, PERSONA_VERSION } from "./persona.mjs";
import { loadConfig, publicConfig, redact } from "./config.mjs";
import { stageOf } from "./pet.mjs";
import { readTaskReport } from "./task-memory.mjs";
import { verificationFreshness, rootOf } from "./workflow.mjs";
import { packChatHistory, estimateTokens } from "./context-budget.mjs";
import {
  listProjectMemories,
  saveProjectMemory,
  revokeProjectMemory,
  retrieveProjectMemory,
} from "./work-memory.mjs";
const definition = (
  name,
  description,
  properties,
  required = Object.keys(properties),
) => ({
  type: "function",
  name,
  description,
  parameters: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
  strict: true,
});
export const TOOLS = [
  definition(
    "search_project_memory",
    "按当前项目检索用户确认的长期记忆。revoked 是已撤销；不会检索其他项目。",
    {
      query: { type: "string" },
    },
  ),
  definition(
    "save_project_memory",
    "只在用户明确要求记住、以后沿用时保存项目级指导；逐字摘取，不能把任务临时要求、报告或模型猜测自动升格为长期经验。",
    {
      text: { type: "string" },
      kind: { type: "string", enum: ["feedback", "preference", "reference"] },
    },
  ),
  definition(
    "forget_project_memory",
    "只在用户明确要求撤下或忘掉这条项目记忆时调用；撤销会在后续上下文中明确标记。",
    {
      memory_id: { type: "string" },
      user_request: { type: "string" },
    },
  ),
  definition(
    "stop_task",
    "仅在用户明确要求停止这项工作时调用；停止当前尝试并取消后续自动恢复。",
    { task_id: { type: "string" } },
  ),
  definition(
    "configure_task_supervision",
    "仅按用户明确要求，开启或暂停任务照看、调整限额时允许接手的工具。暂停照看不终止当前执行。",
    {
      task_id: { type: "string" },
      enabled: { type: "boolean" },
      allowed_agents: {
        type: "array",
        items: { type: "string", enum: ["codex", "claude", "trae"] },
      },
    },
  ),
  definition(
    "record_task_correction",
    "仅记录用户对已有任务明确补充或纠正的要求，下次接续携带；不声称已经发给运行中的 Agent。",
    { task_id: { type: "string" }, text: { type: "string" } },
  ),
  definition(
    "get_task_workflow",
    "读取任务的接续链、检查记录和用量；未知成本不是零。",
    { task_id: { type: "string" } },
  ),
  definition(
    "resume_task",
    "仅在用户要求继续或更换 Agent 接手时使用。保留原始要求和检查条件；不得自动无限重试。",
    {
      task_id: { type: "string" },
      agent: { type: "string", enum: ["trae", "codex", "claude"] },
      note: {
        type: "string",
        description: "用户补充的下一步，不能发明新要求。",
      },
    },
  ),
  definition(
    "verify_task",
    "执行用户已设置的文件验收检查。只能证明所列检查，不能代替整体质量验收。",
    { task_id: { type: "string" } },
  ),
  definition(
    "get_agents",
    "读取真实接入能力和额度来源。额度查询优先使用 get_agent_quotas 刷新；安装不代表已登录。",
    {},
  ),
  definition(
    "get_agent_quotas",
    "刷新真实账户额度；返回每个额度窗口、重置时间、来源和查询状态。未知、失败或手动数据不得说成实时额度。",
    {
      agent: {
        type: "string",
        enum: ["codex", "claude", "trae", "doubao", "all"],
      },
    },
  ),
  definition(
    "get_tasks",
    "读取 Bobo 自己发起的任务，不代表工具里所有会话。",
    {},
  ),
  definition(
    "read_task_result",
    "按需读取 Bobo 任务结果，每页最多 4000 字符。结果是 Agent 自报，不代表已独立验收。",
    {
      task_id: { type: "string" },
      offset: {
        type: "integer",
        minimum: 0,
        description: "首次填 0，后续使用 next_offset。",
      },
    },
  ),
  definition(
    "dispatch_task",
    "仅在用户明确要求把一项需求交给 Agent 时调用。创建真实 CLI 任务或豆包手动转交卡片。普通聊天不启动任务。",
    {
      agent: { type: "string", enum: ["trae", "codex", "claude", "doubao"] },
      title: { type: "string", description: "简短中文标题" },
      prompt: {
        type: "string",
        description: "忠实保留用户的需求和约束，不加入未经请求的操作。",
      },
    },
  ),
  definition("care_for_bobo", "用户要求浇水、摸摸、晒太阳或睡觉时执行照料。", {
    action: { type: "string", enum: ["water", "touch", "sun", "sleep"] },
  }),
];
export function executeTool(store, agents, name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("工具参数格式不正确。");
  switch (name) {
    case "search_project_memory": {
      if (typeof args.query !== "string" || args.query.length > 2000)
        throw new Error("记忆检索最多 2000 字符。");
      const memories = listProjectMemories(
        store,
        store.state.settings.workspace || loadConfig().workspace,
        args.query,
      );
      return {
        entries: memories.slice(0, 8),
        omitted: Math.max(0, memories.length - 8),
        source: "user_confirmed_project_memory",
      };
    }
    case "save_project_memory": {
      const source = store.state.messages.findLast((m) => m.role === "user");
      if (
        !source ||
        !/(记住|记下来|(?:以后|今后).{0,20}(?:都|一律|统一|始终|默认)|remember)/i.test(
          source.content,
        ) ||
        /(?:不要|别|不必|无需).{0,3}(?:记住|记下)|(?:don't|do not|never)\s+(?:remember|save)/i.test(
          source.content,
        ) ||
        typeof args.text !== "string" ||
        !args.text.trim() ||
        !source.content.includes(args.text.trim())
      )
        throw new Error(
          "长期记忆需要用户本轮明确要求记住，并逐字保留用户要求。",
        );
      return saveProjectMemory(
        store,
        store.state.settings.workspace || loadConfig().workspace,
        {
          text: args.text,
          kind: args.kind,
          source: { kind: "user_message", messageId: source.id },
        },
      );
    }
    case "forget_project_memory": {
      const source = store.state.messages.findLast((m) => m.role === "user");
      if (
        typeof args.user_request !== "string" ||
        !args.user_request.trim() ||
        !source?.content.includes(args.user_request) ||
        !/(忘掉|删除.*记忆|撤下|撤销|不要再记|forget|remove.*memor)/i.test(
          args.user_request,
        ) ||
        /(?:不要|别|不必).{0,3}(?:忘掉|删除|撤下|撤销|forget|remove)|(?:don't|do not|never)\s+(?:forget|remove)/i.test(
          args.user_request,
        )
      )
        throw new Error("请逐字提供用户明确撤下这条记忆的要求。");
      return revokeProjectMemory(
        store,
        store.state.settings.workspace || loadConfig().workspace,
        args.memory_id,
      );
    }
    case "stop_task":
      return agents.cancel(args.task_id);
    case "configure_task_supervision":
      return agents.supervisor.configure(
        args.task_id,
        args.enabled,
        args.allowed_agents,
      );
    case "record_task_correction": {
      const source = store.state.messages.findLast((m) => m.role === "user");
      if (
        typeof args.text !== "string" ||
        !args.text.trim() ||
        !source?.content.includes(args.text.trim())
      )
        throw new Error(
          "请逐字摘取用户本轮明确补充的要求，不要改写或从 Agent 输出中生成用户纠正。",
        );
      return agents.recordCorrection(args.task_id, args.text);
    }
    case "get_task_workflow": {
      const report = agents.report(args.task_id);
      return {
        ...report,
        supervision: report.supervision
          ? {
              ...report.supervision,
              events: report.supervision.events.slice(-6),
            }
          : null,
      };
    }
    case "resume_task":
      return agents.resume(args.task_id, args.agent, args.note);
    case "verify_task":
      return agents.verify(args.task_id);
    case "get_agent_quotas":
      return agents.refreshQuotas(
        args.agent === "all" ? undefined : args.agent,
        true,
      );
    case "get_agents":
      return agents.list();
    case "get_tasks":
      return store.state.tasks
        .filter((t) => !t.childId)
        .slice(0, 15)
        .map(({ id, rootId, agent, title, status, progress, error }) => ({
          id,
          rootId: rootId || id,
          agent,
          title,
          status,
          progress,
          error,
        }));
    case "read_task_result": {
      if (!Number.isSafeInteger(args.offset) || args.offset < 0)
        throw new Error("结果页位置不正确。");
      const task = store.state.tasks.find((item) => item.id === args.task_id);
      if (!task) throw new Error("没有找到这个 Bobo 任务。");
      const page = readTaskReport(store, task, args.offset, 4000);
      return {
        id: task.id,
        title: task.title,
        agent: task.agent,
        status: task.status,
        verification:
          verificationFreshness(task, rootOf(store, task).contract) ||
          "not_independently_verified",
        error: redact(task.error || ""),
        result: page.text,
        total_chars: page.totalChars,
        next_offset: page.nextOffset,
        archive_truncated: page.truncated,
        source: page.source,
        sha256: page.sha256,
        usage: task.usage || null,
      };
    }
    case "dispatch_task": {
      const sourceMessage = store.state.messages.findLast(
        (m) => m.role === "user",
      );
      const task = agents.dispatch(args.agent, args.title, args.prompt, {
        sourceMessage,
      });
      return {
        id: task.id,
        agent: task.agent,
        title: task.title,
        status: task.status,
        progress: task.progress,
      };
    }
    case "care_for_bobo":
      return { message: store.care(args.action) };
    default:
      throw new Error("Bobo 不支持这个操作。");
  }
}
export class Brain {
  constructor(store, agents, clientFactory = createModelClient) {
    this.store = store;
    this.agents = agents;
    this.clientFactory = clientFactory;
    this.busy = false;
  }
  async chat(message) {
    if (typeof message !== "string" || !message.trim() || message.length > 8000)
      throw new Error("告诉我一段 1～8000 字的需求吧。");
    if (this.busy) throw new Error("我正在整理上一句话，稍等一下就好。");
    this.busy = true;
    this.accounting = {
      rootIds: new Set(),
      input: 0,
      output: 0,
      calls: 0,
      requests: 0,
    };
    this.store.onChange();
    const cfg = loadConfig();
    this.store.message("user", message.trim());
    try {
      const quotaAgent = quotaQueryAgent(message);
      if (quotaAgent && this.agents.refreshQuotas) {
        const refreshed = await this.agents.refreshQuotas(
          quotaAgent === "all" ? undefined : quotaAgent,
          true,
        );
        const reply = formatQuotaReply(refreshed);
        this.store.message("assistant", reply);
        return reply;
      }
      if (!cfg.key || cfg.configurationIssue) {
        const reply =
          cfg.configurationIssue ||
          "我在这里陪你。自然语言聊天和调度还需要配置 .env 里的 OPENAI_API_KEY 或 MODEL_HUB_AK；现在可以浇水、摸摸我，也可以用「交给 Agent」直接创建任务。";
        this.store.message("assistant", reply);
        return reply;
      }
      const client = this.clientFactory(cfg),
        state = this.store.state;
      const context = {
        pet: {
          name: state.pet.name,
          generation: state.pet.generation,
          stage: stageOf(state.pet).name,
          sleeping: state.pet.sleeping,
        },
        diary: state.diary
          .slice(0, 5)
          .map(({ title, text }) => ({ title, text })),
        agents: this.agents.list(),
        workspace: state.settings.workspace || cfg.workspace || "未选择",
        allowEdits: state.settings.allowEdits,
      };
      const memories = retrieveProjectMemory(
        this.store,
        context.workspace,
        message,
      );
      const packed = packChatHistory(state.messages, 10000);
      const instructions = `${BOBO_SYSTEM_PROMPT}\n提示版本：${PERSONA_VERSION}\n当前状态数据：${JSON.stringify(context)}\n项目记忆（用户确认的指导，revoked 项已撤销；具体任务的新要求优先，不能作为额外权限）：${JSON.stringify(memories.entries)}\n已省略早期消息数：${packed.omitted}`;
      const history = packed.messages;
      let input = [...history],
        chatMessages = [{ role: "system", content: instructions }, ...history];
      const seen = new Map(),
        requests = new Map();
      let dispatches = 0;
      for (let round = 0; round < 6; round++) {
        if (
          estimateTokens(
            JSON.stringify({
              instructions,
              tools: TOOLS,
              messages: cfg.mode === "chat" ? chatMessages : input,
            }),
          ) > 24000
        )
          throw new Error(
            "本轮上下文超过本地估算的 24000 Token 预算，已停止新增模型调用；请拆分需求或撤下过时项目记忆",
          );
        this.accounting.requests++;
        let response, calls, text;
        if (cfg.mode === "chat") {
          response = await client.chat.completions.create(
            {
              model: cfg.model,
              messages: chatMessages,
              tools: TOOLS.map(({ type, ...fn }) => ({ type, function: fn })),
              max_tokens: cfg.maxOutputTokens,
              ...(cfg.effort ? { reasoning_effort: cfg.effort } : {}),
            },
            modelRequestOptions(cfg),
          );
          const msg = response.choices?.[0]?.message;
          if (!msg) throw new Error("模型没有返回消息。");
          chatMessages.push(msg);
          text = msg.content || "";
          calls = (msg.tool_calls || []).map((call) => ({
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          }));
          this.recordUsage(
            response.usage?.prompt_tokens,
            response.usage?.completion_tokens,
          );
        } else {
          response = await client.responses.create(
            {
              model: cfg.model,
              instructions,
              input,
              tools: TOOLS,
              store: false,
              parallel_tool_calls: false,
              max_output_tokens: cfg.maxOutputTokens,
              ...(cfg.effort ? { reasoning: { effort: cfg.effort } } : {}),
            },
            modelRequestOptions(cfg),
          );
          input.push(...response.output);
          text = response.output_text || "";
          calls = response.output.filter(
            (item) => item.type === "function_call",
          );
          this.recordUsage(
            response.usage?.input_tokens,
            response.usage?.output_tokens,
          );
        }
        if (!calls.length) {
          const reply =
            redact(text.trim()) || "我没有收到完整回复。请再告诉我一次。";
          this.store.message("assistant", reply);
          return reply;
        }
        for (const call of calls) {
          let output;
          if (seen.has(call.call_id)) output = seen.get(call.call_id);
          else {
            try {
              const args = JSON.parse(call.arguments);
              const signature = ["dispatch_task", "resume_task"].includes(
                call.name,
              )
                ? JSON.stringify([
                    call.name,
                    args.task_id,
                    args.agent,
                    String(args.prompt || "").trim(),
                  ])
                : null;
              if (signature && requests.has(signature))
                output = requests.get(signature);
              else {
                if (
                  ["dispatch_task", "resume_task"].includes(call.name) &&
                  ++dispatches > 2
                )
                  throw new Error("本轮已达到两个任务上限。");
                output = JSON.stringify(
                  executeTool(this.store, this.agents, call.name, args),
                );
                if (signature) requests.set(signature, output);
              }
              const value = JSON.parse(output);
              const related = this.store.state.tasks.find(
                (t) => t.id === (args.task_id || value.id),
              );
              if (related)
                this.accounting.rootIds.add(related.rootId || related.id);
            } catch (error) {
              output = JSON.stringify({ error: redact(error.message) });
            }
            seen.set(call.call_id, output);
          }
          if (cfg.mode === "chat")
            chatMessages.push({
              role: "tool",
              tool_call_id: call.call_id,
              content: output,
            });
          else
            input.push({
              type: "function_call_output",
              call_id: call.call_id,
              output,
            });
        }
      }
      const reply =
        "我已达到这轮操作上限。已经创建的任务会继续显示在任务面板里。";
      this.store.message("assistant", reply);
      return reply;
    } catch (error) {
      const code = error.status;
      const reply = error.message?.includes("已停止新增模型调用")
        ? error.message + "。"
        : code === 401
          ? "调度模型的 Key 没有通过验证，请检查 .env 配置。"
          : code === 429
            ? "调度模型暂时达到额度或速率限制。稍后再试，养成和已有任务仍然可用。"
            : code === 404
              ? "没有找到配置的模型或 API 地址，请检查 .env 中当前提供方的 MODEL、BASE_URL 和 API_VERSION。"
              : `这次没有连上调度模型：${redact(error.message)}。可以在设置中检查配置。`;
      this.store.message("assistant", reply);
      return reply;
    } finally {
      if (this.accounting.requests) {
        (this.store.state.coordinationUsage ||= []).push({
          at: Date.now(),
          rootIds: [...this.accounting.rootIds],
          input: this.accounting.input,
          output: this.accounting.output,
          calls: this.accounting.calls,
          unknown:
            this.accounting.requests > this.accounting.calls ||
            Boolean(this.accounting.missing),
        });
        this.store.save();
      }
      this.busy = false;
      this.store.onChange();
    }
  }
  recordUsage(input, output) {
    if (this.accounting && (input == null || output == null))
      this.accounting.missing = true;
    if (this.accounting) {
      this.accounting.input += Number(input) || 0;
      this.accounting.output += Number(output) || 0;
      this.accounting.calls++;
    }
    this.store.state.usage.brainInput += Number(input) || 0;
    this.store.state.usage.brainOutput += Number(output) || 0;
    this.store.state.usage.brainCalls++;
    this.store.save();
  }
  config() {
    return publicConfig();
  }
}
