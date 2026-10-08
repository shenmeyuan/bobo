import { useEffect, useState } from "react";
import { api, agentNames, taskStatuses } from "../lib/api";
import type { Task, TaskContract, WorkflowReport, AgentId } from "../lib/types";

export function TaskWorkflow({
  task,
  onOpen,
}: {
  task: Task;
  onOpen?: (id: string) => void;
}) {
  const [report, setReport] = useState<WorkflowReport | null>(null);
  const [contract, setContract] = useState<TaskContract>({
    checks: [],
    maxAttempts: 3,
    tokenLimit: null,
  });
  const [target, setTarget] = useState<AgentId>(
    task.agent === "codex" ? "claude" : "codex",
  );
  const [note, setNote] = useState("");
  const [correction, setCorrection] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      .getWorkflow(task.id)
      .then((value) => {
        if (active) {
          setReport(value);
          if (!dirty) setContract(value.contract);
        }
      })
      .catch((e) => {
        if (active) setError(String(e.message));
      });
    return () => {
      active = false;
    };
  }, [task, dirty]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      setReport(await api.getWorkflow(task.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const edit = (value: TaskContract) => {
    setContract(value);
    setDirty(true);
  };
  const terminal = !["running", "queued", "handoff"].includes(task.status);
  return (
    <section className="task-workflow" aria-label="接续与验收">
      <div className="workflow-heading">
        <strong>接续与验收</strong>
        <span>{report?.attempts.length || 1} 次尝试</span>
      </div>
      {report && (
        <>
          <div
            className={`workflow-supervision ${report.supervision?.state || "paused"}`}
          >
            <div className="workflow-heading">
              <strong>
                {
                  (
                    {
                      watching: "Bobo 正在照看",
                      recovering: "Bobo 正在恢复",
                      attention: "需要你决定",
                      paused: "自动恢复已暂停",
                      done: "执行已结束",
                    } as Record<string, string>
                  )[report.supervision?.state || "paused"]
                }
              </strong>
              {task.agent !== "doubao" && (
                <button
                  className="outline small"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      api.setSupervision(
                        task.id,
                        !report.supervision?.enabled,
                        report.supervision?.allowedAgents || [task.agent],
                      ),
                    )
                  }
                >
                  {report.supervision?.enabled ? "暂停照看" : "开启照看"}
                </button>
              )}
            </div>
            <p>
              {report.supervision?.reason || "这项历史任务未开启自动照看。"}
            </p>
            {task.quiet && task.status === "running" && (
              <p className="workflow-muted">
                暂时没有新输出，原进程仍在；Bobo 没有重复启动任务。
              </p>
            )}
            {task.resumeMode === "native" && (
              <p className="workflow-muted">本次接续沿用原 Agent 会话。</p>
            )}
            <p className="workflow-muted">
              确认故障才恢复，默认最多 3 次尝试；你停止任务后不会自动重启。
            </p>
            {report.supervision && (
              <details>
                <summary>照看规则与记录</summary>
                <p className="workflow-muted">
                  限额时按名单顺序接手；原 Agent
                  的暂时故障先原地恢复。暂停照看不会停止正在运行的进程。
                </p>
                <div className="workflow-agent-options">
                  {(["codex", "claude", "trae"] as AgentId[]).map((id) => (
                    <label key={id}>
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={report.supervision!.allowedAgents.includes(id)}
                        onChange={() =>
                          void act(() =>
                            api.setSupervision(
                              task.id,
                              report.supervision!.enabled,
                              report.supervision!.allowedAgents.includes(id)
                                ? report.supervision!.allowedAgents.filter(
                                    (a) => a !== id,
                                  )
                                : [...report.supervision!.allowedAgents, id],
                            ),
                          )
                        }
                      />
                      {agentNames[id]}
                    </label>
                  ))}
                </div>
                {report.supervision.events.slice(-8).map((event, i) => (
                  <p className="workflow-muted" key={i}>
                    {new Date(event.at).toLocaleTimeString()} · {event.text}
                  </p>
                ))}
              </details>
            )}
          </div>
          <details>
            <summary>这项工作的记忆</summary>
            <p className="workflow-muted">
              用户原话、有效纠正和检查条件单独保存；报告摘录可以回查原文，不作为已证实的事实。
            </p>
            <p className="workflow-muted">
              版本 {report.memory.revision} · {report.memory.archivedReports}{" "}
              份本地报告档案
            </p>
            {report.memory.ledger && (
              <p className="workflow-muted">
                {report.memory.ledger.requirements} 项有效要求 ·{" "}
                {report.memory.ledger.records.length} 条有来源记录 ·
                记忆事件序号 {report.memory.ledger.processedThrough}
              </p>
            )}
            {report.memory.assembly && (
              <p className="workflow-muted">
                本次接续内容约{" "}
                {(
                  report.memory.assembly.transmittedChars ??
                  report.memory.assembly.totalChars ??
                  0
                ).toLocaleString()}{" "}
                字符；保留{" "}
                {report.memory.assembly.selectedReportChars.toLocaleString()}{" "}
                字符报告摘录。字符数不等于 Token。
              </p>
            )}
            {report.memory.assembly?.estimatedTokens !== undefined && (
              <p className="workflow-muted">
                本地估算{" "}
                {report.memory.assembly.estimatedTokens.toLocaleString()} Token
                / 交接预算{" "}
                {report.memory.assembly.targetTokens?.toLocaleString()}。
                仅计算传入文本，不含原生会话历史；实际用量由执行器回报。
              </p>
            )}
            {report.memory.assembly?.nativeReportReplaySkipped && (
              <p className="workflow-muted">
                沿用原会话，跳过重复报告，仍带上用户要求。
              </p>
            )}
            {report.memory.assembly?.overTarget && (
              <p className="workflow-muted">
                硬性要求超过目标长度，已完整保留；没有静默删减。
              </p>
            )}
            {report.memory.truncatedArchives > 0 && (
              <p className="workflow-muted">
                有报告达到 128,000 字符存储上限，档案不完整。
              </p>
            )}
            {report.memory.warning && (
              <p className="workflow-muted">{report.memory.warning}</p>
            )}
            <details>
              <summary>最初的用户要求</summary>
              <p className="workflow-file">
                {report.memory.originalRequest.content}
              </p>
            </details>
          </details>
          <details>
            <summary>记住这项工作的纠正</summary>
            <p className="workflow-muted">
              下一次接续时带上，换工具也不会丢。正在执行的 Agent
              不会立即收到修改。
            </p>
            {report.corrections
              .filter((c) => c.active)
              .map((c) => (
                <div className="workflow-correction" key={c.id}>
                  <p>{c.text}</p>
                  <button
                    className="outline small"
                    disabled={busy}
                    onClick={() =>
                      void act(() => api.recordCorrection(task.id, "", c.id))
                    }
                  >
                    撤下
                  </button>
                  <button
                    className="outline small"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        api.saveProjectMemory(c.text, "feedback", task.id),
                      )
                    }
                  >
                    记为项目规则
                  </button>
                </div>
              ))}
            <textarea
              aria-label="任务纠正"
              value={correction}
              maxLength={2000}
              placeholder="例如：保留原始数据，只调整展示格式。"
              onChange={(e) => setCorrection(e.target.value)}
            />
            <button
              className="outline small"
              disabled={busy || !correction.trim()}
              onClick={() =>
                void act(async () => {
                  await api.recordCorrection(task.id, correction);
                  setCorrection("");
                })
              }
            >
              记住要求
            </button>
          </details>
          <p className="workflow-muted">
            已回报 {report.usage.total.toLocaleString()} Token · 执行{" "}
            {(report.usage.input + report.usage.output).toLocaleString()} ·
            关联调度{" "}
            {(
              report.usage.brainInput + report.usage.brainOutput
            ).toLocaleString()}
          </p>
          <p className="workflow-muted">
            未关联任务的闲聊不计入；该用量不等于订阅剩余额度。
          </p>
          {(report.usage.unknownAttempts > 0 ||
            report.usage.unknownBrainCalls > 0) && (
            <p className="workflow-muted">部分用量未回报，以上不是完整总量。</p>
          )}
          {report.usage.sharedBrainCalls > 0 && (
            <p className="workflow-muted">
              包含服务多个任务的共享调度消耗；跨任务相加会重复计算。
            </p>
          )}
          <p className="workflow-muted">
            {report.usage.unknownPrices
              ? "价格信息不全，暂不估算总费用。"
              : `已回报执行费用 $${report.usage.knownWorkerCost.toFixed(4)}`}
          </p>
          {report.verification && (
            <div
              className={`workflow-verification ${report.verification.status}`}
            >
              <strong>
                {report.verification.status === "passed"
                  ? "所列检查通过"
                  : report.verification.status === "failed"
                    ? "有检查未通过"
                    : report.verification.status === "stale"
                      ? "文件有变动，旧检查已过期"
                      : report.verification.status === "needs_recheck"
                        ? "有检查未通过，需重新核查"
                        : "尚未设置检查条件"}
              </strong>
              <p className="workflow-muted">
                {report.verification.scope} ·{" "}
                {new Date(report.verification.at).toLocaleString()}
              </p>
              {report.verification.checks.map((c, i) => (
                <p key={i}>
                  {c.passed ? "✓" : "×"} {c.path} · {c.detail}
                  {!!c.dependencies?.length && (
                    <small className="workflow-file">
                      {" "}
                      · 输入依赖：
                      {c.dependencies
                        .map(
                          (d) =>
                            d.path +
                            (d.freshness === "stale" ? "（已变化）" : ""),
                        )
                        .join("、")}
                    </small>
                  )}
                </p>
              ))}
            </div>
          )}
          <details>
            <summary>尝试记录与产物变动</summary>
            {report.attempts.map((a, i) => (
              <button
                className="workflow-attempt"
                key={a.id}
                onClick={() =>
                  onOpen ? onOpen(a.id) : void api.openPetChat(a.id)
                }
              >
                {i + 1}. {agentNames[a.agent]} · {taskStatuses[a.status]}
                {a.id === task.id ? " · 当前" : ""}
              </button>
            ))}
            {report.checkpoint?.changes.slice(0, 30).map((c) => (
              <p className="workflow-file" key={c.path}>
                {c.after ? (c.before ? "修改" : "新增") : "不在当前清单"} ·{" "}
                {c.path}
              </p>
            ))}
            <p className="workflow-muted">
              {report.checkpoint?.inventory.scope || "执行结束后记录文件指纹。"}
              ；清单不代表完整工作目录。指纹不证明内容正确。
            </p>
          </details>
        </>
      )}
      <details>
        <summary>检查条件与接续预算</summary>
        <p className="workflow-muted">
          填写工作目录内的相对路径。保存条件不会执行命令或消耗模型 Token。
        </p>
        {contract.checks.map((c, i) => (
          <div className="workflow-check" key={i}>
            <input
              aria-label={`产物路径 ${i + 1}`}
              placeholder="例如 outputs/report.json"
              value={c.path}
              onChange={(e) =>
                edit({
                  ...contract,
                  checks: contract.checks.map((v, j) =>
                    j === i ? { ...v, path: e.target.value } : v,
                  ),
                })
              }
            />
            <select
              aria-label={`检查类型 ${i + 1}`}
              value={c.kind}
              onChange={(e) =>
                edit({
                  ...contract,
                  checks: contract.checks.map((v, j) =>
                    j === i
                      ? { ...v, kind: e.target.value as typeof c.kind }
                      : v,
                  ),
                })
              }
            >
              <option value="exists">文件存在</option>
              <option value="contains">包含指定内容</option>
              <option value="json">JSON 可解析</option>
            </select>
            {c.kind === "contains" && (
              <input
                aria-label={`预期内容 ${i + 1}`}
                placeholder="需要包含的文字"
                value={c.expected}
                onChange={(e) =>
                  edit({
                    ...contract,
                    checks: contract.checks.map((v, j) =>
                      j === i ? { ...v, expected: e.target.value } : v,
                    ),
                  })
                }
              />
            )}
            <button
              className="outline small"
              onClick={() =>
                edit({
                  ...contract,
                  checks: contract.checks.filter((_, j) => j !== i),
                })
              }
            >
              移除
            </button>
            <textarea
              aria-label={`输入依赖 ${i + 1}`}
              placeholder="关联输入文件（可选，每行一个相对路径）"
              value={(c.dependencies || []).join("\n")}
              onChange={(e) =>
                edit({
                  ...contract,
                  checks: contract.checks.map((v, j) =>
                    j === i
                      ? {
                          ...v,
                          dependencies: e.target.value.split("\n"),
                        }
                      : v,
                  ),
                })
              }
            />
          </div>
        ))}
        <button
          className="outline small"
          disabled={contract.checks.length >= 12}
          onClick={() =>
            edit({
              ...contract,
              checks: [
                ...contract.checks,
                { path: "", kind: "exists", expected: "" },
              ],
            })
          }
        >
          添加文件检查
        </button>
        <label>
          最多尝试次数
          <input
            aria-label="最多尝试次数"
            type="number"
            min="1"
            max="10"
            value={contract.maxAttempts}
            onChange={(e) =>
              edit({ ...contract, maxAttempts: Number(e.target.value) })
            }
          />
        </label>
        <label>
          接续前 Token 阈值（可留空）
          <input
            aria-label="接续 Token 阈值"
            type="number"
            min="1"
            value={contract.tokenLimit ?? ""}
            onChange={(e) =>
              edit({
                ...contract,
                tokenLimit: e.target.value ? Number(e.target.value) : null,
              })
            }
          />
        </label>
        <p className="workflow-muted">
          含本次在内；阈值只拦截下一次尝试，不是运行期间硬上限。设置阈值后，用量未知时会暂停接续。
        </p>
        <label>
          交接上下文预算（本地估算 Token）
          <input
            aria-label="交接上下文预算"
            type="number"
            min="512"
            max="32000"
            value={contract.contextTokenBudget ?? 8000}
            onChange={(e) =>
              edit({ ...contract, contextTokenBudget: Number(e.target.value) })
            }
          />
        </label>
        <p className="workflow-muted">
          先完整保留有效要求和必要证据，再选择报告摘录。必要内容超预算时暂停派发，请拆分任务或调整预算。
        </p>
        <button
          className="outline small"
          disabled={busy || !terminal || !dirty}
          onClick={() =>
            void act(async () => {
              await api.setContract(task.id, contract);
              setDirty(false);
            })
          }
        >
          保存检查与预算
        </button>
      </details>
      {terminal && (
        <>
          <button
            className="outline small"
            disabled={busy || dirty}
            onClick={() => void act(() => api.verifyTask(task.id))}
          >
            核查当前产物
          </button>
          {report?.childId ? (
            <button
              className="outline small"
              onClick={() =>
                onOpen
                  ? onOpen(report.childId!)
                  : void api.openPetChat(report.childId!)
              }
            >
              查看后续尝试
            </button>
          ) : (
            <details>
              <summary>让另一个 Agent 接着做</summary>
              <select
                aria-label="接续 Agent"
                value={target}
                onChange={(e) => setTarget(e.target.value as AgentId)}
              >
                <option value="codex">Codex</option>
                <option value="claude">Claude Code</option>
                <option value="trae">Trae / Coco</option>
              </select>
              <textarea
                aria-label="接续说明"
                placeholder="下一步或需要修正的问题（可选）"
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <p className="workflow-muted">
                保留原始需求、已有文件和检查条件；使用原工作目录，不扩大写入权限。
              </p>
              <button
                className="primary small"
                disabled={busy || dirty}
                onClick={() =>
                  void act(async () => {
                    const next = await api.resumeTask(task.id, target, note);
                    if (onOpen) onOpen(next.id);
                    else await api.openPetChat(next.id);
                  })
                }
              >
                带着进展接续
              </button>
            </details>
          )}
        </>
      )}
      {dirty && (
        <p className="workflow-muted">条件已修改，保存后才能检查或接续。</p>
      )}
      {error && (
        <p role="alert" className="bubble-error">
          {error}
        </p>
      )}
    </section>
  );
}
