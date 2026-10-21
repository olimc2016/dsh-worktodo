/**
 * CI workflow 契约检查。
 *
 * 为什么需要它：`.github/workflows/` 是**唯一无法在本地执行**的部分——
 * 它的错误只有在推 tag 之后才会暴露（甚至更糟：YAML 坏了 → workflow 静默不触发，
 * 而你会以为是 npm 或绑定出了问题）。所以这里用不依赖解析器的结构断言把它钉住：
 * 关键触发条件、OIDC 权限、发布命令、测试与构建步骤、矩阵版本、以及"不许出现 tab"。
 *
 * 如果本机有 ruby，还会额外用它真正**解析**一遍 YAML（比字符串断言强）；没有就跳过并说明。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let passed = 0;
const failures = [];
let skipped = 0;

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

const publishPath = join(root, '.github', 'workflows', 'publish.yml');
const testPath = join(root, '.github', 'workflows', 'test.yml');
const publish = readFileSync(publishPath, 'utf8');
const testYml = readFileSync(testPath, 'utf8');

console.log('文件与格式');

test('两个 workflow 都存在且非空', () => {
  eq(existsSync(publishPath) && publish.trim().length > 0, true, 'publish.yml 缺失或为空：');
  eq(existsSync(testPath) && testYml.trim().length > 0, true, 'test.yml 缺失或为空：');
});

test('没有 tab 缩进（YAML 会把 tab 当语法错误）', () => {
  for (const [name, text] of [['publish.yml', publish], ['test.yml', testYml]]) {
    const line = text.split('\n').findIndex((l) => /^\t/.test(l));
    eq(line, -1, `${name} 第 ${line + 1} 行用了 tab：`);
  }
});

test('本机有 ruby 时，真正解析一遍 YAML（没有就跳过）', () => {
  try {
    const out = execFileSync('ruby', ['-ryaml', '-e', 'ARGV.each { |f| YAML.load_file(f) }', publishPath, testPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    eq(out.trim(), '', 'ruby 解析没有输出才算通过：');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      skipped += 1;
      console.log('      （本机没有 ruby，跳过解析检查；结构断言仍已执行）');
      return;
    }
    throw new Error(`YAML 解析失败：${error?.stderr ?? error?.message ?? error}`);
  }
});

console.log('publish.yml 的发布契约');

test('认证走 OIDC：声明了 id-token: write', () => {
  // 少了这一行，Trusted Publishing 拿不到 OIDC token，发布会以 401/403 失败
  eq(/id-token:\s*write/.test(publish), true, 'publish.yml 没有 id-token: write：');
  eq(/permissions:/.test(publish), true, 'publish.yml 没有 permissions 段：');
});

test('触发条件：推 v* tag，且支持手动触发', () => {
  eq(/on:/.test(publish), true, '没有 on: 段：');
  eq(/tags:/.test(publish) && /'v\*'/.test(publish), true, "tags 过滤器应当包含 'v*'：");
  eq(/workflow_dispatch:/.test(publish), true, '缺少 workflow_dispatch：');
});

test('推 tag 默认走暂存，且保留直接发布的分支', () => {
  // 必须匹配“步骤里的命令”，否则文件头注释里的同名文字会让断言假通过
  eq(/run:\s*npm stage publish/.test(publish), true, '缺少 `run: npm stage publish` 步骤：');
  eq(/run:\s*npm publish/.test(publish), true, '缺少 `run: npm publish` 步骤：');
  eq(/inputs\.mode == 'stage'/.test(publish), true, 'stage 分支没有引用 inputs.mode：');
  eq(/inputs\.mode == 'publish'/.test(publish), true, 'publish 分支没有引用 inputs.mode：');
});

test('发布前先锁文件安装、跑测试、构建客户端', () => {
  eq(/pnpm install --frozen-lockfile/.test(publish), true, '缺少 pnpm install --frozen-lockfile：');
  eq(/pnpm test/.test(publish), true, '缺少 pnpm test：');
  eq(/pnpm run build/.test(publish), true, '缺少 pnpm run build：');
  // 顺序：安装 → 测试 → 构建 → 发布
  const order = ['run: pnpm install --frozen-lockfile', 'run: pnpm test', 'run: pnpm run build', 'run: npm stage publish']
    .map((needle) => publish.indexOf(needle));
  eq(order.every((i, idx) => i !== -1 && (idx === 0 || i > order[idx - 1])), true, `步骤顺序不对：${order}`);
});

test('npm install -g npm@latest 必须在 actions/setup-node 之后，且只出现一次', () => {
  // `npm stage publish` 需要 npm ≥ 11.15，而 node 22 自带 npm 10.x。
  // 若把这行放在 setup-node **之前**，setup-node 装的 node / npm 会把它覆盖掉，
  // 症状是 `npm stage` 未知命令（L12-⑥）。用行号索引比较，不靠字符串包含。
  const lines = publish.split('\n');
  const setupLine = lines.findIndex((line) => /uses:\s*actions\/setup-node@/.test(line)) + 1;
  const npmLines = lines
    .map((line, index) => (line.includes('npm install -g npm@latest') ? index + 1 : 0))
    .filter((line) => line > 0);
  eq(setupLine > 0, true, 'publish.yml 里找不到 uses: actions/setup-node：');
  eq(npmLines.length, 1, `npm install -g npm@latest 必须恰好出现一次，实际在 ${JSON.stringify(npmLines)} 行：`);
  eq(npmLines[0] > setupLine, true, `npm install -g npm@latest（第 ${npmLines[0]} 行）必须在 setup-node（第 ${setupLine} 行）之后：`);
});

test('所有 action 都固定在大版本 tag（不用浮动分支）', () => {
  const uses = [...publish.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]);
  eq(uses.length > 0, true, '没有找到 uses：');
  const bad = uses.filter((u) => !/^[^@]+@v\d+(\.\d+)*$/.test(u));
  eq(bad, [], '这些 action 没有固定大版本 tag：');
});

console.log('test.yml 的测试契约');

test('矩阵覆盖 node 22 与 24', () => {
  eq(/22/.test(testYml), true, '矩阵里没有 node 22：');
  eq(/24/.test(testYml), true, '矩阵里没有 node 24：');
  eq(/matrix/.test(testYml), true, '没有矩阵：');
});

test('CI 用 pnpm（本仓库唯一验证过的工具链）而不是 npm install', () => {
  eq(/pnpm\/action-setup/.test(testYml), true, '缺少 pnpm/action-setup：');
  eq(/pnpm install/.test(testYml), true, '缺少 pnpm install：');
  eq(/\bnpm install\b/.test(testYml), false, 'CI 里出现了未验证的 npm install：');
});

test('CI 会跑测试并检查打包产物', () => {
  eq(/pnpm test/.test(testYml), true, '缺少 pnpm test：');
  eq(/pack/.test(testYml), true, '缺少打包检查：');
});

console.log(`\n${passed} 通过，${failures.length} 失败${skipped ? `，${skipped} 跳过` : ''}`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error?.stack ?? f.error}`);
  process.exit(1);
}
