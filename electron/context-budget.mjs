import { getEncoding } from "js-tiktoken";

// Model Hub aliases and non-OpenAI executors may use a different tokenizer.
// This measures the transmitted text, not hidden native history or server billing.
let encoding;
const chunkCounts = new Map();
export const TOKEN_ESTIMATOR = "o200k_base_chunked_local_estimate";
export function estimateTokens(text) {
  encoding ||= getEncoding("o200k_base");
  // Bound BPE work on long unbroken CJK/repeated text. Chunk edges may change
  // tokenization slightly; this is a local estimate, never a billing count.
  const chars = Array.from(String(text ?? ""));
  let count = 0;
  for (let i = 0; i < chars.length; i += 256) {
    const chunk = chars.slice(i, i + 256).join("");
    if (!chunkCounts.has(chunk)) {
      if (chunkCounts.size >= 128)
        chunkCounts.delete(chunkCounts.keys().next().value);
      chunkCounts.set(chunk, encoding.encode(chunk, [], []).length);
    }
    count += chunkCounts.get(chunk);
  }
  return count;
}

export function packChatHistory(messages, budget = 10000) {
  const selected = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!["user", "assistant"].includes(message.role)) continue;
    const candidate = [
      { role: message.role, content: message.content },
      ...selected,
    ];
    if (selected.length && estimateTokens(JSON.stringify(candidate)) > budget)
      break;
    selected.unshift(candidate[0]);
  }
  while (selected[0]?.role === "assistant") selected.shift();
  const estimatedTokens = estimateTokens(JSON.stringify(selected));
  return {
    messages: selected,
    omitted: messages.length - selected.length,
    estimatedTokens,
    overBudget: estimatedTokens > budget,
    estimator: TOKEN_ESTIMATOR,
  };
}

// Optional entries are kept whole; mandatory content is never truncated.
export function fitContext(base, optional, render, budget) {
  let value = structuredClone(base);
  const mandatoryTokens = estimateTokens(render(value));
  let selected = 0;
  for (const item of optional) {
    const candidate = item.apply(structuredClone(value));
    if (estimateTokens(render(candidate)) <= budget) {
      value = candidate;
      selected++;
    }
  }
  const tokens = estimateTokens(render(value));
  return {
    value,
    budget: {
      estimator: TOKEN_ESTIMATOR,
      targetTokens: budget,
      mandatoryTokens,
      estimatedTokens: tokens,
      selectedOptional: selected,
      omittedOptional: optional.length - selected,
      overTokenTarget: tokens > budget,
    },
  };
}
