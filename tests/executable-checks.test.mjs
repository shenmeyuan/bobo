import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runNodeTest,
  runExecutableVerification,
} from "../electron/executable-checks.mjs";
import {
  validateContract,
  runVerification,
  verificationFreshness,
} from "../electron/workflow.mjs";

function fixture(t) {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "bobo-executable-check-"),
  );
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const task = { workspace };
  const contract = validateContract({
    checks: [
      {
        kind: "node_test",
        path: "delivery.test.mjs",
        expected: "",
        dependencies: ["input.json"],
      },
    ],
  });
  fs.writeFileSync(path.join(workspace, "input.json"), "{}");
  return { task, contract, workspace };
}
test("saving or automatic verification never executes tests; explicit execution validates assertions and dependencies", async (t) => {
  const f = fixture(t),
    marker = path.join(f.workspace, "ran");
  fs.writeFileSync(
    path.join(f.workspace, "delivery.test.mjs"),
    `import fs from 'node:fs'; import assert from 'node:assert/strict'; fs.writeFileSync('ran','yes'); assert.equal(process.env.MODEL_HUB_AK,undefined); assert.equal(process.env.OPENAI_API_KEY,undefined);`,
  );
  assert.equal(runVerification(f.task, f.contract).status, "needs_recheck");
  assert.equal(fs.existsSync(marker), false);
  f.task.verification = await runExecutableVerification(f.task, f.contract);
  assert.equal(f.task.verification.status, "passed");
  assert.equal(fs.readFileSync(marker, "utf8"), "yes");
  assert.equal(verificationFreshness(f.task, f.contract).status, "passed");
  fs.writeFileSync(path.join(f.workspace, "input.json"), '{"changed":true}');
  assert.equal(verificationFreshness(f.task, f.contract).status, "stale");
  fs.writeFileSync(
    path.join(f.workspace, "delivery.test.mjs"),
    "throw new Error('broken requirement');",
  );
  const failed = await runExecutableVerification(f.task, f.contract);
  assert.equal(failed.status, "failed");
  assert.match(failed.checks[0].detail, /broken requirement/);
});
test("tests cannot silently change declared inputs and retain a current passing result", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.workspace, "delivery.test.mjs"),
    "import fs from 'node:fs'; fs.writeFileSync('input.json','changed');",
  );
  f.task.verification = await runExecutableVerification(f.task, f.contract);
  assert.equal(verificationFreshness(f.task, f.contract).status, "stale");
});
test("executable checks reject traversal and unlisted executable types; timeout kills a real test process", async (t) => {
  const f = fixture(t);
  assert.throws(() =>
    validateContract({
      checks: [
        { kind: "node_test", path: "../outside.test.mjs", expected: "" },
      ],
    }),
  );
  assert.throws(() =>
    validateContract({
      checks: [{ kind: "node_test", path: "script.sh", expected: "" }],
    }),
  );
  fs.writeFileSync(
    path.join(f.workspace, "delivery.test.mjs"),
    "setInterval(()=>{},1000);",
  );
  const result = await runNodeTest(f.workspace, "delivery.test.mjs", {
    timeoutMs: 400,
  });
  assert.equal(result.passed, false);
  assert.match(result.detail, /超时/);
});
