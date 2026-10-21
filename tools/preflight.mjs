/**
 * 发版前一键门禁：能自动查的全跑一遍，不能自动查的**明确列出来**。
 *
 * 为什么需要它：发版不可逆（§5.6）。现状是「记得跑 verify-all、记得 pack 看一眼、
 * 记得做 profile 模拟」——全靠人记得，迟早漏一项。这个脚本把**能自动的**串成一条命令，
 * 把**只能人判断的**打印成清单并标明「未自动检查」，避免「跑完脚本就以为全验过了」。
 *
 * 顺序（前一步失败也继续跑，最后统一退出码，便于一次看全）：
 *   ① tools/verify-all.mjs       —— 构建 + 全部 11 个 suite（12 步，1–2 分钟）
 *   ② tools/verify-submission.mjs —— 发布面断言（平台包 / 依赖面 / import 形态 / 收录条目）
 *   ③ tools/verify-privacy.mjs    —— 隐私与发布包边界
 *   ④ 按 package.json 的 files 计算发布文件清单，断言必需文件在、内部目录不在
 *
 * 只依赖 node 自身（process.execPath + spawnSync），不要求 PATH 上有 npm / pnpm——
 * DSH 桌面端环境里往往只有 node。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

let passed = 0;
const failures = [];

/** @param {string} label @param {() => void} run */
function test(label, run) {
  try {
    run();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  ✗ ${label}\n      ${error?.message ?? error}`);
  }
}

function eq(actual, expected, hint = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${hint}期望 ${b}，实际 ${a}`);
}

/* --------------------------------------------------------------- 自动步骤 */

/** 顺序很重要：verify-all 里有构建与全部 suite，先跑它。 */
const STEPS = [
  ['verify-all.mjs', '全量自检（构建 + 11 个 suite = 12 步）'],
  ['verify-submission.mjs', '发布面断言（平台包 / 依赖面 / import 形态 / 收录条目）'],
  ['verify-privacy.mjs', '隐私与发布包边界'],
];

const stepResults = [];

for (const [file, label] of STEPS) {
  process.stdout.write(`\n${'='.repeat(60)}\n${label}（${file}）\n${'='.repeat(60)}\n`);
  const run = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit', cwd: root });
  const ok = run.status === 0;
  if (run.error) console.log(`  ✗ 子进程启动失败：${run.error.message}`);
  stepResults.push({ file, label, ok });
}

/* ------------------------------------------------------------ 发布文件清单 */

/** npm 发布包会包含的文件：`files` 里每个条目（目录递归展开）+ package.json。 */
function publishedFiles() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const out = new Set(['package.json']);
  const walk = (rel) => {
    const abs = join(root, ...rel.split('/'));
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const entry of readdirSync(abs)) walk(`${rel}/${entry}`);
    } else {
      out.add(rel);
    }
  };
  for (const entry of pkg.files ?? []) walk(entry.replace(/^\.\//, ''));
  return [...out].sort();
}

/** 发布包必须带的文件（少了任何一个：装上去缺宿主半侧 / 缺面板 / 缺安装器）。 */
const REQUIRED = [
  'lib/index.js', // 宿主半侧入口
  'lib/client.js', // 浏览器半侧构建产物
  'lib/client.js.map', // 产物 source map（与产物同批）
  'cordis.patch.yml', // 插槽行
  'icon.svg', // 列表页图标
  'tools/apply-update.mjs', // 运行时独立安装器（宿主安装时必须 spawn）
];

/** 发布包里绝不允许出现的前缀（内部文档 / CI 配置 / 依赖目录）。 */
const FORBIDDEN_PREFIXES = ['node_modules/', 'docs/', '.github/'];

/**
 * 发布清单违规项。返回数组而不是直接抛错，好让「反向自检」拿合成清单证明它真的会红。
 * @param {string[]} files
 * @returns {string[]}
 */
function manifestViolations(files) {
  const violations = [];
  for (const file of REQUIRED) {
    if (!files.includes(file)) violations.push(`缺少必需发布文件：${file}`);
  }
  for (const file of files) {
    if (FORBIDDEN_PREFIXES.some((prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix))) {
      violations.push(`不该进发布包：${file}`);
    }
    if (file.startsWith('tools/') && file !== 'tools/apply-update.mjs') {
      violations.push(`tools/ 只允许 tools/apply-update.mjs，多出：${file}`);
    }
  }
  return violations;
}

console.log(`\n${'='.repeat(60)}\n发布文件清单（按 package.json 的 files 计算）\n${'='.repeat(60)}`);
const dist = publishedFiles();
for (const file of dist) console.log(`  ${file}`);

console.log('\n发布包断言');
test(`发布清单包含 ${REQUIRED.length} 个必需文件`, () => {
  const violations = manifestViolations(dist);
  eq(violations, [], '发布清单不合规：');
});
test('发布清单不含 node_modules/ docs/ .github/ 与多余 tools/*', () => {
  eq(
    dist.filter((file) => FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix))),
    [],
    '内部目录进了发布包：',
  );
  eq(dist.filter((file) => file.startsWith('tools/') && file !== 'tools/apply-update.mjs'), [], '多余的 tools 文件：');
});

console.log('\n反向自检（证明清单断言真的会红）');
test('反向：合成清单删掉 tools/apply-update.mjs 必须报红', () => {
  const shadow = dist.filter((file) => file !== 'tools/apply-update.mjs');
  eq(
    manifestViolations(shadow).some((item) => item.includes('tools/apply-update.mjs')),
    true,
    '删掉运行时安装器却没被抓住：',
  );
});
test('反向：合成清单塞进 docs/ 必须报红', () => {
  eq(manifestViolations([...dist, 'docs/releasing.md']).some((item) => item.includes('docs/')), true, 'docs/ 进包没被抓住：');
});
test('反向：合成清单删掉 lib/client.js 必须报红', () => {
  eq(
    manifestViolations(dist.filter((file) => file !== 'lib/client.js')).some((item) => item.includes('lib/client.js')),
    true,
    '缺浏览器半侧却没被抓住：',
  );
});

/* -------------------------------------------------------------- 人工闸门 */

const MANUAL_GATES = [
  ['profile 模拟安装（§4.1）', '临时目录 + 真 tarball：断言只有一份平台包、解析到宿主那份；反向样本也要变红'],
  ['宿主升级模拟（§4.2）', '顶层平台包换新版、插件不动：不出现 disabling profile plugin row / waiting for services'],
  ['真机重启', '完全退出 DSH 再启动：面板能打开、数据在、升级提示正确'],
  ['回归截图存档', '真机截图存私有目录（不入公开仓库），发布后对账一次'],
  ['暂存只批最新（§5.4）', '暂存区有多个版本时只 Approve 最新那个；批准前 §4 必须已做完'],
];

console.log(`\n${'='.repeat(60)}\n人工闸门（以下 5 项【未自动检查】，必须人工确认）\n${'='.repeat(60)}`);
MANUAL_GATES.forEach(([name, detail], index) => {
  console.log(`  ${index + 1}. ☐ ${name}`);
  console.log(`       ${detail}`);
});
console.log('\n  脚本只证明「自动门禁全绿」，不替代这 5 项；任一项没做 = 这次发版没验过。');

/* ------------------------------------------------------------------ 汇总 */

const stepPassed = stepResults.filter((result) => result.ok).length;
console.log(`\n${'='.repeat(60)}\n汇总\n${'='.repeat(60)}`);
for (const result of stepResults) console.log(`  ${result.ok ? '✓' : '✗'} ${result.label}（${result.file}）`);
console.log(`  自动步骤：${stepPassed}/${stepResults.length} 通过`);
console.log(`  发布清单断言：${passed} 通过，${failures.length} 失败`);

const failed = stepPassed !== stepResults.length || failures.length > 0;
if (failed) {
  console.log('\n✗ 自动门禁未全绿 —— 不要 commit / tag / 发布（人工 5 项也不必做，先修红）。');
  for (const failure of failures) console.error(`- ${failure.label}: ${failure.error?.stack ?? failure.error}`);
  process.exit(1);
}

console.log('\n✓ 自动门禁全绿。接下来必须人工完成上面 5 项，再走暂存发布。');
process.exit(0);
