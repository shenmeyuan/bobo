import { spawn } from "node:child_process";
import { safeFile, runVerification } from "./workflow.mjs";
import { redact } from "./config.mjs";

// Explicit UI action only. Test code has the user's OS file permissions;
// shell:false and a minimal environment are not a filesystem sandbox.
export function runNodeTest(
  workspace,
  relative,
  { timeoutMs = 30000, spawnProcess = spawn, signal } = {},
) {
  const file = safeFile(workspace, relative);
  if (!/\.test\.(?:mjs|cjs|js)$/.test(relative))
    throw new Error("请选择 .test.js / .test.mjs / .test.cjs 测试文件。");
  const env = { ELECTRON_RUN_AS_NODE: "1" };
  for (const key of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
  ])
    if (process.env[key]) env[key] = process.env[key];
  return new Promise((resolve) => {
    let child,
      timer,
      escalation,
      output = "",
      stopped = false,
      resolved = false,
      abort,
      stop;
    const done = (passed, detail) => {
      if (resolved) return;
      resolved = true;
      if (stopped) stop?.("SIGKILL");
      signal?.removeEventListener("abort", abort);
      clearTimeout(timer);
      clearTimeout(escalation);
      resolve({ passed, detail: redact(detail).slice(-2400) });
    };
    try {
      if (signal?.aborted) return done(false, "测试已取消。");
      child = spawnProcess(process.execPath, ["--test", file], {
        cwd: workspace,
        env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      stop = (signal) => {
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          /* exited */
        }
      };
      const terminate = () => {
        if (stopped) return;
        stopped = true;
        stop("SIGTERM");
        escalation = setTimeout(() => stop("SIGKILL"), 1000);
      };
      const capture = (chunk) => {
        output += chunk.toString();
        if (output.length > 64000) {
          output = output.slice(-64000);
          terminate();
        }
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.on("error", (e) => done(false, e.message));
      child.on("close", (code) =>
        done(
          !stopped && code === 0,
          stopped
            ? "测试超时或输出超过上限，已停止；未确认通过。"
            : `退出码 ${code}\n${output}`,
        ),
      );
      abort = () => {
        terminate();
        stop("SIGKILL");
      };
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(terminate, timeoutMs);
    } catch (e) {
      done(false, e.message);
    }
  });
}

export async function runExecutableVerification(task, contract, options = {}) {
  const result = runVerification(task, contract);
  for (const check of result.checks) {
    if (check.kind !== "node_test") continue;
    if (options.signal?.aborted) {
      check.pendingExecutable = false;
      check.passed = false;
      check.detail = "测试已取消。";
      continue;
    }
    if (!check.pendingExecutable || check.dependencies.some((d) => !d.sha256))
      continue;
    try {
      Object.assign(
        check,
        await runNodeTest(task.workspace, check.path, options),
        { pendingExecutable: false },
      );
    } catch (e) {
      check.passed = false;
      check.pendingExecutable = false;
      check.detail = redact(e.message);
    }
  }
  result.at = Date.now();
  result.status = result.checks.length
    ? result.checks.every((c) => c.passed)
      ? "passed"
      : "failed"
    : "not_configured";
  result.scope =
    "仅代表所列文件与显式运行的 Node 测试；未声明的依赖或环境变化仍需复核。";
  return result;
}
