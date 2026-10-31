// Reported counters only. Cache tokens are a subset of input, never added twice.
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
export function usageLedger(attempts, calls = [], now = Date.now()) {
  const entries = attempts.map((t, i) => ({
    id: t.id,
    kind: i ? "retry" : "execution",
    agent: t.agent,
    status: t.status,
    input: count(t.usage?.input),
    output: count(t.usage?.output),
    cacheRead: count(t.usage?.cacheRead),
    cacheWrite: count(t.usage?.cacheWrite),
    reported: Boolean(t.usage),
    reportedCost:
      Number.isFinite(t.usage?.cost) && t.usage.cost >= 0 ? t.usage.cost : null,
    durationMs: Math.max(0, (t.finishedAt || now) - t.createdAt),
  }));
  const coordination = calls.map((c, i) => ({
    id: `coordination-${i}`,
    kind: "coordination",
    agent: "bobo",
    input: count(c.input),
    output: count(c.output),
    reported: !c.unknown,
    shared: c.rootIds.length > 1,
    calls: count(c.calls),
    reportedCost: null,
  }));
  return {
    entries: [...entries, ...coordination],
    retryTokens: entries
      .filter((e) => e.kind === "retry")
      .reduce((n, e) => n + e.input + e.output, 0),
    cacheRead: entries.reduce((n, e) => n + e.cacheRead, 0),
    cacheWrite: entries.reduce((n, e) => n + e.cacheWrite, 0),
    elapsedMs: attempts.length
      ? Math.max(
          0,
          Math.max(...attempts.map((t) => t.finishedAt || now)) -
            Math.min(...attempts.map((t) => t.createdAt)),
        )
      : 0,
    complete:
      entries.every((e) => e.reported) && coordination.every((e) => e.reported),
  };
}
