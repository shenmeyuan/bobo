// Inspect Git's index, not untracked files. Never print secret values.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "dotenv";
const root = path.resolve(import.meta.dirname, "..");
const files = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], { cwd: root }).toString().split("\0").filter(Boolean);
if (!files.length) throw new Error("No staged files to audit. Stage the intended publish set first.");
const localEnv = fs.existsSync(path.join(root, ".env")) ? parse(fs.readFileSync(path.join(root, ".env"))) : {};
const secrets = Object.entries({ ...process.env, ...localEnv }).filter(([key, value]) =>
  /(?:KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|AK)$/.test(key) && typeof value === "string" && value.length >= 8);
const findings = [];
const blocked = /(?:^|\/)(?:node_modules|dist|release|work|task-memory|test-results|playwright-report)(?:\/|$)|(?:^|\/)state(?:-[^/]*)?\.json$|\.(?:log|pem|key|p12|pfx|sqlite3?|db|bak|zip|dmg)$/i;
let bytes = 0;
for (const file of files) {
  if (blocked.test(file) || (/(?:^|\/)\.env(?:\..*)?$/.test(file) && file !== ".env.example")) findings.push({ file, reason: "private_or_generated_path" });
  const data = execFileSync("git", ["show", `:${file}`], { cwd: root, maxBuffer: 30 * 1024 * 1024 });
  bytes += data.length;
  for (const [key, value] of secrets) if (data.includes(Buffer.from(value))) findings.push({ file, reason: "local_secret_match", variable: key });
  if (!/\.(?:png|jpe?g|webp|ico)$/i.test(file)) {
    const text = data.toString("utf8");
    if (/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{25,}|sk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(text)) findings.push({ file, reason: "credential_pattern" });
    if (/\/Users\/[^/\s]+\//.test(text) || /https?:\/\/[^\s/]*(?:byteintl|tiktok-row)\./.test(text)) findings.push({ file, reason: "personal_path_or_internal_host" });
  }
  if (file === ".env.example") {
    for (const [key, value] of Object.entries(parse(data))) if (/(?:KEY|TOKEN|PASSWORD|SECRET|AK)$/.test(key) && value) findings.push({ file, reason: "template_secret_not_empty", variable: key });
  }
}
console.log(JSON.stringify({ files: files.length, bytes, findings }, null, 2));
if (findings.length) process.exitCode = 1;
