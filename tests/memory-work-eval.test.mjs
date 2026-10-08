import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  memoryWorkCases,
  judgeMemoryWork,
} from "../scripts/lib/memory-work-cases.mjs";
function fixture(c) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-judge-"));
  for (const [name, data] of Object.entries({
    ...c.files,
    ...c.externalChanges,
  })) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
  return dir;
}
for (const c of memoryWorkCases())
  test(`external judge rejects unfinished ${c.id}`, async () => {
    const dir = fixture(c);
    try {
      const result = await judgeMemoryWork(c, dir);
      assert.equal(result.passed, false);
      assert.ok(result.checks.some((v) => !v.passed));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
test("external judge accepts an accurate JSON export and detects source tampering", async () => {
  const c = memoryWorkCases().find((c) => c.id === "export-correction"),
    dir = fixture(c);
  try {
    fs.writeFileSync(
      path.join(dir, "src/export.mjs"),
      `export function buildExport(rows){return rows.map(({id,amount})=>{const m=/^(-?)(\\d+)(?:\\.(\\d*))?$/.exec(amount);if(!m||/[^0]/.test((m[3]||'').slice(2)))throw Error('invalid');return{id,amountCents:(m[1]?-1:1)*(Number(m[2])*100+Number((m[3]||'').padEnd(2,'0').slice(0,2)))};});}`,
    );
    fs.writeFileSync(
      path.join(dir, "export.json"),
      '[{"id":"a","amountCents":110},{"id":"b","amountCents":-29},{"id":"c","amountCents":1234}]',
    );
    fs.writeFileSync(
      path.join(dir, "notes.md"),
      "本接口生成 JSON 数组，金额按十进制转换为整数分，不进行浮点金额四舍五入。",
    );
    assert.equal((await judgeMemoryWork(c, dir)).passed, true);
    fs.writeFileSync(path.join(dir, "data/transactions.json"), "[]");
    const bad = await judgeMemoryWork(c, dir);
    assert.equal(bad.passed, false);
    assert.ok(
      bad.checks.some((v) => v.name === "source unchanged" && !v.passed),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
