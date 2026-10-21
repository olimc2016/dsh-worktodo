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

/**
 * 所有子进程都显式用仓库根做 cwd（复审 0.2.2 F5）。
 *
 * `build-client.mjs` 的入口/产物是相对 cwd 的（`src/client/index.js` → `lib/client.js`），
 * 不指定 cwd 时从仓库外调用会得到 `Could not resolve "src/client/index.js"` 的假失败。
 */
const repoRoot = join(here, '..');

/**
 * 全量测试不联网：在 spawn 之前把测试缝放进**子进程环境**。
 *
 * 为什么必须在这里设：各测试文件顶部虽然也写了同一行，但 ESM 的静态 import 会被提升到
 * 模块体之前执行，`lib/index.js` 求值时那行还没跑。CI（干净环境、registry 较慢）因此会
 * 真的发一次 registry 请求，phase 停在 `checking`，自升级用例被「已在运行」守卫静默吞掉。
 * 这里设进父进程环境后，所有 suite 子进程从**第一行**就带着它。
 */
process.env.WORKTODO_NO_UPDATE_CHECK = '1';

/** 顺序很重要：后面的烟测依赖前面模块的行为。 */
const SUITES = [
  ['verify-records.mjs', '数据模型'],
  ['verify-service.mjs', '服务层'],
  ['verify-store.mjs', '存储层'],
  ['smoke-host.mjs', '宿主接线与工具'],
  ['smoke-contract.mjs', '客户端↔宿主契约'],
  ['smoke-client.mjs', '客户端 bundle'],
  ['verify-docs.mjs', '文档引用与跨仓同步'],
  ['verify-meta.mjs', '版本字面量元测试'],
  ['verify-workflows.mjs', 'CI workflow 契约'],
  ['verify-privacy.mjs', '发布面审计（隐私与文档完整性）'],
  ['verify-submission.mjs', '收录提交门禁'],
];

const results = [];
let failed = false;

/**
 * 先构建客户端 bundle（复审 R3）。
 *
 * 为什么必须先构建：`smoke-client.mjs` 读的是**构建产物** `lib/client.js`，
 * 而这里原来直接跑测试 —— 于是「改了 `src/client` 忘了 build」这个最危险的状态
 * （浏览器里跑的其实是旧 bundle）在测试里是**绿的**。构建失败或产物过期必须让整体变红。
 */
process.stdout.write(`${'='.repeat(60)}\n构建客户端 bundle（build-client.mjs）\n${'='.repeat(60)}\n`);
const build = spawnSync(process.execPath, [join(here, 'build-client.mjs')], { stdio: 'inherit', cwd: repoRoot });
if (build.status !== 0) {
  failed = true;
  process.stdout.write('\n✗ 客户端 bundle 构建失败 —— 后面的测试与浏览器里跑的代码都不可信，直接判失败\n');
}
results.push({ label: '客户端 bundle 构建', file: 'build-client.mjs', ok: build.status === 0, status: build.status });

for (const [file, label] of SUITES) {
  process.stdout.write(`\n${'='.repeat(60)}\n${label}（${file}）\n${'='.repeat(60)}\n`);
  const run = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit', cwd: repoRoot });
  const ok = run.status === 0;
  if (!ok) failed = true;
  results.push({ label, file, ok, status: run.status });
}

process.stdout.write(`\n${'='.repeat(60)}\n汇总\n${'='.repeat(60)}\n`);
for (const r of results) {
  process.stdout.write(`${r.ok ? '  ✓' : '  ✗'} ${r.label}  (${r.file})\n`);
}
const passedCount = results.filter((r) => r.ok).length;
process.stdout.write(`\n${passedCount}/${results.length} 个步骤通过（含构建）\n`);

process.exit(failed ? 1 : 0);
