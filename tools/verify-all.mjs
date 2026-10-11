/**
 * 顺序跑完全部测试，并给一份汇总。
 *
 * 为什么要有这个文件：`package.json` 的 test / prepublishOnly 里如果写
 * `npm run build && npm test` 这种互相调用的链，就会强依赖发布者终端 PATH 上有 npm；
 * 而 DSH 自带 node 的环境里往往只有 node 没有 npm，发布会在钩子处莫名失败。
 * 这里只用 node 自身（spawnSync(process.execPath)），npm / pnpm / yarn 都能跑。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** 顺序很重要：后面的烟测依赖前面模块的行为。 */
const SUITES = [
  ['verify-records.mjs', '数据模型'],
  ['verify-service.mjs', '服务层'],
  ['verify-store.mjs', '存储层'],
  ['smoke-host.mjs', '宿主接线与工具'],
  ['smoke-contract.mjs', '客户端↔宿主契约'],
  ['smoke-client.mjs', '客户端 bundle'],
  ['verify-workflows.mjs', 'CI workflow 契约'],
  ['verify-privacy.mjs', '发布面审计（隐私与文档完整性）'],
  ['verify-submission.mjs', '收录提交门禁'],
];

const results = [];
let failed = false;

for (const [file, label] of SUITES) {
  process.stdout.write(`\n${'='.repeat(60)}\n${label}（${file}）\n${'='.repeat(60)}\n`);
  const run = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit' });
  const ok = run.status === 0;
  if (!ok) failed = true;
  results.push({ label, file, ok, status: run.status });
}

process.stdout.write(`\n${'='.repeat(60)}\n汇总\n${'='.repeat(60)}\n`);
for (const r of results) {
  process.stdout.write(`${r.ok ? '  ✓' : '  ✗'} ${r.label}  (${r.file})\n`);
}
const passedCount = results.filter((r) => r.ok).length;
process.stdout.write(`\n${passedCount}/${results.length} 个测试文件通过\n`);

process.exit(failed ? 1 : 0);
