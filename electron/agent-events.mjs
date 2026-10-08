// Only typed public tool results; assistant prose and quoted logs are not permission events.
export function permissionDeniedEvent(event) {
  const roots = [
    event,
    event.tool_call_output,
    event.content,
    event.message,
    event.message?.message,
    event.message?.content,
    event.message?.message?.content,
  ];
  const candidates = [];
  for (const root of roots) {
    if (Array.isArray(root)) candidates.push(...root);
    else if (root && typeof root === "object") {
      candidates.push(root);
      if (root.tool_call_output) candidates.push(root.tool_call_output);
      if (Array.isArray(root.content)) candidates.push(...root.content);
    }
  }
  for (const item of candidates) {
    const result =
      item.output ||
      (item.content &&
      !Array.isArray(item.content) &&
      typeof item.content === "object" &&
      Array.isArray(item.content.content)
        ? item.content
        : item);
    const typed =
      item.type === "tool_result" ||
      (item.type === "user" && item.subtype === "tool_result") ||
      Boolean(item.tool_call_id && item.tool_info) ||
      Boolean(item.tool_use_id);
    if (!typed) continue;
    const content = result.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((v) => v.type === "text")
              .map((v) => v.text || "")
              .join("\n")
          : "";
    const tool = item.tool_info?.name || item.tool_name || item.name || "tool";
    if (!result.is_error && !item.is_error) continue;
    if (
      /permission denied|not allowed to (?:execute|use)|权限.*(?:拒绝|不足)|没有.*权限/i.test(
        text,
      )
    )
      return {
        tool,
        message: "工具权限被拒绝，已停止本次执行，避免重复尝试。",
      };
  }
  return null;
}
