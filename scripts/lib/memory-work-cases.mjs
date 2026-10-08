import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
export function memoryWorkCases() {
  return [
    {
      id: "csv-parser",
      goal: "修复 src/csv.mjs 的 parseCSV(text) 与 stringifyCSV(rows) 并交付 notes.md。CSV 必须支持逗号、双引号转义、引号内换行、CRLF、空单元格；空输入返回 []，记录末尾单个换行不产生额外记录。保留命名导出、输入源文件与既有文件名，不新增依赖。notes.md 说明支持的行为和仍有限制。",
      correction: null,
      files: {
        "package.json": '{"type":"module"}\n',
        "README.md":
          "现有 CSV 工具。src/csv.mjs 是未完成的初版；examples/sample.csv 是输入，请保留。\n",
        "src/csv.mjs":
          'export function parseCSV(text) { return text.split("\\n").map(line => line.split(",")); }\nexport function stringifyCSV(rows) { return rows.map(row => row.join(",")).join("\\n"); }\n',
        "examples/sample.csv": 'name,note\nAda,"hello, world"\n',
      },
      checks: [{ kind: "exists", path: "notes.md", expected: "" }],
      protectedFiles: ["examples/sample.csv", "package.json"],
    },
    {
      id: "export-correction",
      goal: "完善 src/export.mjs 的 buildExport(rows)，原要求生成 CSV 文本，amount 为两位小数。保留输入 data/transactions.json，不引入依赖；另生成最终产物并写 notes.md 说明接口。",
      correction:
        "撤销 CSV 要求。buildExport(rows) 现在返回 JSON 数组，每项仅有 id 与 amountCents；amountCents 是整数分，金额字符串按十进制准确转换，支持负数和多余尾零，拒绝非零的第三位小数及无效金额。最终产物为 export.json，不生成 export.csv，不改输入。",
      files: {
        "package.json": '{"type":"module"}\n',
        "README.md":
          "交易导出工具初版，输入金额是十进制字符串。data/transactions.json 保留。\n",
        "src/export.mjs":
          'export function buildExport(rows) { return "id,amount\\n" + rows.map(r => `${r.id},${Number(r.amount).toFixed(2)}`).join("\\n"); }\n',
        "data/transactions.json":
          '[{"id":"a","amount":"1.10"},{"id":"b","amount":"-0.29"},{"id":"c","amount":"12.3400"}]\n',
      },
      checks: [
        { kind: "json", path: "export.json", expected: "" },
        { kind: "exists", path: "notes.md", expected: "" },
      ],
      protectedFiles: ["data/transactions.json", "package.json"],
    },
    {
      id: "external-file-change",
      goal: '维护 src/schedule.mjs 的 plan(jobs)，返回按依赖拓扑排序的 job id 数组。依赖缺失或有环要抛错，同层选择按 id 字典序，不能修改传入对象。根据 data/jobs.json 更新 plan.json，保留字段格式 {"order":[...]}。保留数据输入，不引入依赖。',
      correction: null,
      files: {
        "package.json": '{"type":"module"}\n',
        "README.md":
          "任务排序：job = {id, dependsOn: string[]}。旧版本仅按 id 排序，plan.json 为旧产物。\n",
        "src/schedule.mjs":
          "export function plan(jobs) { return jobs.map(j => j.id).sort(); }\n",
        "data/jobs.json":
          '[{"id":"a","dependsOn":[]},{"id":"b","dependsOn":["a"]}]\n',
        "plan.json": '{"order":["a","b"]}\n',
      },
      externalChanges: {
        "data/jobs.json":
          '[{"id":"a","dependsOn":["c"]},{"id":"b","dependsOn":[]},{"id":"c","dependsOn":["b"]}]\n',
      },
      checks: [{ kind: "contains", path: "plan.json", expected: '"a"' }],
      protectedFiles: ["data/jobs.json", "package.json"],
    },
  ];
}
const checks = {
  "csv-parser": `const {parseCSV:p,stringifyCSV:s}=await import('./src/csv.mjs');
 test('empty',()=>assert.deepEqual(p(''),[]));
 test('trailing and CRLF',()=>assert.deepEqual(p('a,b\\r\\nc,d\\r\\n'),[['a','b'],['c','d']]));
 test('quoted newline and comma',()=>assert.deepEqual(p('x,"a,b\\nc"\\n'),[['x','a,b\\nc']]));
 test('quote escape and empty',()=>assert.deepEqual(p('"a""b",,z\\n'),[['a"b','','z']]));
 test('round trip',()=>{const a=[['a,b','x"y','n\\nr',''],['普通','1','2','3']];assert.deepEqual(p(s(a)),a);});
 test('source preserved',()=>assert.equal(fs.readFileSync('examples/sample.csv','utf8'),'name,note\\nAda,"hello, world"\\n'));
 test('notes delivered',()=>assert.ok(fs.readFileSync('notes.md','utf8').trim().length>20));`,
  "export-correction": `const {buildExport:b}=await import('./src/export.mjs');
 test('integer cents and fields',()=>assert.deepEqual(b([{id:'x',amount:'1.10'},{id:'y',amount:'-0.29'},{id:'z',amount:'12.3400'}]),[{id:'x',amountCents:110},{id:'y',amountCents:-29},{id:'z',amountCents:1234}]));
 test('decimal exactness',()=>assert.equal(b([{id:'a',amount:'0.29'}])[0].amountCents,29));
 test('reject invalid',()=>{for(const amount of ['0.001','abc','1x',''])assert.throws(()=>b([{id:'a',amount}]));});
 test('source unchanged',()=>assert.equal(fs.readFileSync('data/transactions.json','utf8'),'[{"id":"a","amount":"1.10"},{"id":"b","amount":"-0.29"},{"id":"c","amount":"12.3400"}]\\n'));
 test('artifact',()=>assert.deepEqual(JSON.parse(fs.readFileSync('export.json','utf8')),[{id:'a',amountCents:110},{id:'b',amountCents:-29},{id:'c',amountCents:1234}]));
 test('no obsolete artifact',()=>assert.equal(fs.existsSync('export.csv'),false));
 test('notes delivered',()=>assert.ok(fs.readFileSync('notes.md','utf8').trim().length>20));`,
  "external-file-change": `const {plan:p}=await import('./src/schedule.mjs');
 test('latest artifact',()=>assert.deepEqual(JSON.parse(fs.readFileSync('plan.json','utf8')),{order:['b','c','a']}));
 test('dependencies',()=>assert.deepEqual(p([{id:'a',dependsOn:['c']},{id:'b',dependsOn:[]},{id:'c',dependsOn:['b']}]),['b','c','a']));
 test('deterministic ready queue',()=>assert.deepEqual(p([{id:'z',dependsOn:[]},{id:'a',dependsOn:[]},{id:'b',dependsOn:['a']}]),['a','b','z']));
 test('cycle',()=>assert.throws(()=>p([{id:'a',dependsOn:['b']},{id:'b',dependsOn:['a']}])));
 test('missing',()=>assert.throws(()=>p([{id:'a',dependsOn:['x']}])));
 test('no input mutation',()=>{const a=[{id:'z',dependsOn:[]},{id:'a',dependsOn:[]}],old=JSON.stringify(a);p(a);assert.equal(JSON.stringify(a),old);});
 test('changed source preserved',()=>assert.equal(fs.readFileSync('data/jobs.json','utf8'),'[{"id":"a","dependsOn":["c"]},{"id":"b","dependsOn":[]},{"id":"c","dependsOn":["b"]}]\\n'));`,
};
export async function judgeMemoryWork(c, workspace) {
  // External driver is sent after the agent exits; it is never stored in its project.
  const source = `import assert from 'node:assert/strict';import fs from 'node:fs';const checks=[];function test(name,fn){try{fn();checks.push({name,passed:true});}catch(e){checks.push({name,passed:false,error:String(e.message).slice(0,800)});}}\ntry{${checks[c.id]}}catch(e){checks.push({name:'module loading',passed:false,error:String(e.message).slice(0,800)});}\nconsole.log(JSON.stringify({passed:checks.length>0&&checks.every(c=>c.passed),checks}));`;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", source],
    {
      cwd: workspace,
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "",
    timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 5000);
  child.stdout.on("data", (s) => (stdout += s));
  child.stderr.on("data", (s) => (stderr = (stderr + s).slice(-2000)));
  await new Promise((resolve) => {
    child.on("error", (e) => {
      stderr = e.message;
      resolve();
    });
    child.on("close", resolve);
  });
  clearTimeout(timer);
  if (timedOut)
    return {
      passed: false,
      checks: [{ name: "judge timeout", passed: false }],
    };
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return {
      passed: false,
      checks: [
        {
          name: "judge process",
          passed: false,
          error: stderr || "invalid output",
        },
      ],
    };
  }
}
