// Copied to local userData when observation is enabled. Never emit hook decisions.
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (input.length > 1000000) process.exit(0);
});
process.stdin.on("end", () => {
  try {
    const event = JSON.parse(input),
      dir = process.argv[2];
    if (!dir || !/^[a-zA-Z0-9_-]{1,160}$/.test(event.session_id)) return;
    // Deliberately omit prompt, transcript path, tool input/output and summaries.
    const data = {
      session_id: event.session_id,
      cwd: event.cwd,
      hook_event_name: event.hook_event_name,
      notification_type: event.notification_type,
      at: Date.now(),
      order: process.hrtime.bigint().toString(),
    };
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.readdirSync(dir).length >= 1000) return;
    const file = path.join(
      dir,
      `${data.at}-${data.order}-${crypto.randomUUID()}.json`,
    );
    fs.writeFileSync(file + ".tmp", JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  } catch {
    /* Observer failures must never prevent the user's agent from working. */
  }
});
