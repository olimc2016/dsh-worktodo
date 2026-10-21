/**
 * 发布面审计：保证"会被公开发布的东西"既不泄露隐私，也不会让读者踩空。
 * （历史名与文件名保留 privacy，因为它最初只为隐私而建；范围后来扩到发布包文档的可用性。）
 *
 * 两个面都要查，因为它们是两条独立的泄露路径：
 *   ① npm 发布包 —— `package.json` 的 `files` 字段 + `package.json` 本身（这些会被上传到公开 registry）
 *   ② git 跟踪的文件 —— 推到公开仓库后，全世界都能看到
 *
 * 为什么要有这个文件：构建产物（尤其 source map）与文档示例极容易把**构建机的家目录、用户名**
 * 带出去；这类泄露不会让测试变红、也不会让程序出错，只会静默地公开出去。所以必须有一道门禁。
 *
 * 检测用**运行时的真实用户名**（`os.userInfo().username`），因此本文件本身不含任何人的名字，
 * 换台机器跑同样有效。
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import { userInfo } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const me = userInfo().username;
// "当前用户名"这条规则只在**开发者本机**跑：CI 上的用户名是通用词（GitHub 是 `runner`），
// 会与文档里正常的英文词（例如 "ubuntu runner"）误撞；而 CI 本来就无从得知开发者本机的用户名。
// 与用户名无关、CI 也能查的那条（家目录绝对路径）在任何环境都保留。
const inCi = Boolean(process.env.CI);

let passed = 0;
let failed = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    process.stdout.write(`  ✓ ${label}\n`);
  } else {
    failed += 1;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    process.stdout.write(`  ✗ ${label}${detail ? `  → ${detail}` : ''}\n`);
  }
}

/* ---------------------------------------------------------------- 文件集合 */

/** npm 发布包会包含的文件：`files` 里每个条目（目录递归展开）+ package.json。 */
function publishedFiles() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const out = new Set(['package.json']);
  const walk = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const entry of readdirSync(abs)) walk(join(rel, entry));
    } else {
      out.add(rel);
    }
  };
  for (const entry of pkg.files ?? []) walk(entry);
  return [...out].sort();
}

/** git 跟踪的文件（推上去就公开）。 */
function trackedFiles() {
  const run = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  if (run.status !== 0) return [];
  return run.stdout.split('\n').filter(Boolean).sort();
}

/**
 * 发布包边界违规项。
 *
 * tools/ 默认不上传（构建与测试脚本）；**唯一例外**是运行时独立安装器：
 * 宿主在安装时必须 spawn 本包自带的 tools/apply-update.mjs，所以它必须进发布包。
 * 两个方向都要查：多出别的 tools/* 要红；少了安装器同样要红。
 *
 * 返回数组而不是直接抛错，是为了让下面的「反向自检」能拿一份故意改坏的清单
 * 验证这套判定真的会红——没有反向验证的测试不算测试。
 * @param {string[]} files
 * @returns {string[]}
 */
function publishBoundaryViolations(files) {
  const violations = [];
  for (const file of files.filter((f) => f.startsWith('tools/'))) {
    if (file !== 'tools/apply-update.mjs') violations.push(`多余的 tools 文件：${file}`);
  }
  if (!files.includes('tools/apply-update.mjs')) violations.push('缺少运行时安装器：tools/apply-update.mjs');
  return violations;
}

/* ------------------------------------------------------------------- 规则 */

/** 允许出现的 IPv4：本地回环与 RFC 5737 文档示例段（192.0.2.0/24、198.51.100.0/24、203.0.113.0/24）。 */
const OK_IPV4_PREFIX = ['127.', '0.0.0.0', '1.2.3.4', '192.0.2.', '198.51.100.', '203.0.113.'];

const RULES = [
  // 前面必须是「路径开头」的边界（不能紧跟单词字符），否则 `/tmp/x/home/.dsh` 这种
  // 普通子目录会被误判成 `/home/<用户>`（真实误报：docs/reviews/stability-0.2.7.md）。
  ['家目录绝对路径', /(?<![\w.~-])\/Users\/(?!me\/)[^/\s"')]+|(?<![\w.~-])\/home\/(?!me\/)[^/\s"')]+/g],
  // 真实用户名只在够长时才查，避免 'me' / 'ci' 这类短名噪音。
  // 注意：CI 环境下这条会被**跳过**（见下方 inCi 判定），但规则仍保留在此，好让两侧的检查条数一致。
  ...(me.length >= 4 ? [[`当前用户名（${'*'.repeat(me.length)}）`, new RegExp(`\\b${me}\\b`, 'g')]] : []),
  ['npm token 形状', /npm_[A-Za-z0-9]{20,}/g],
  // 要求等号后跟一段像凭据的值：这样文档里单纯提到 `_authToken=` 不会误报
  ['_authToken 赋值', /_authToken\s*=\s*[A-Za-z0-9_\-.]{8,}/g],
  ['GitHub token 形状', /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g],
  ['云厂商密钥形状', /AKIA[0-9A-Z]{16}/g],
  ['私钥块', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['私人邮箱（noreply 除外）', /[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com|example\.(com|org))[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['真实 IP（文档示例段除外）', /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g],
  ['会话 id 形状', /session-[0-9a-f]{8,}/g],
];

/** 家目录路径里的占位写法（`/Users/<名字>`、`/Users/$USER`、`/Users/me`）不算泄露。 */
const isPlaceholderPath = (value) => /^\/(Users|home)\/(me|[<{$])/.test(value);

/** 扫一个文件集合，返回 "规则 → 命中" 的映射。二进制文件跳过。 */
function scan(files) {
  const hits = new Map(RULES.map(([name]) => [name, []]));
  for (const rel of files) {
    const abs = join(root, rel);
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue; // 二进制
    for (const [name, re] of RULES) {
      re.lastIndex = 0;
      for (const match of text.matchAll(re)) {
        const value = match[0];
        if (name.startsWith('真实 IP') && OK_IPV4_PREFIX.some((p) => value.startsWith(p))) continue;
        if (name.startsWith('家目录') && isPlaceholderPath(value)) continue;
        const line = text.slice(0, match.index).split('\n').length;
        hits.get(name).push(`${rel}:${line}  「${value.length > 40 ? `${value.slice(0, 40)}…` : value}」`);
      }
    }
  }
  return hits;
}

/* ------------------------------------------------------------------- 执行 */

const dist = publishedFiles();
const tracked = trackedFiles();

process.stdout.write(`\n目标 ① npm 发布包（${dist.length} 个文件）\n`);
process.stdout.write(`目标 ② git 跟踪文件（${tracked.length} 个文件）\n\n`);

process.stdout.write('发布包内容边界\n');
// tools/ 默认不上传（构建与测试脚本）；**唯一例外**是运行时独立安装器：
// 宿主在安装时必须 spawn 本包自带的 tools/apply-update.mjs，所以它必须进发布包。
// 这里不放宽成「允许 tools/」：除这一个文件外出现任何 tools/* 仍然判红。
check(
  '发布包里 tools/ 只允许运行时安装器 tools/apply-update.mjs',
  publishBoundaryViolations(dist).length === 0,
  publishBoundaryViolations(dist).join(', '),
);
check(
  '发布包必须包含 tools/apply-update.mjs（宿主安装时要 spawn 它）',
  dist.includes('tools/apply-update.mjs'),
  '缺了它，宿主在安装 / 升级时会找不到独立安装器',
);
check(
  '反向自检：合成清单删掉 tools/apply-update.mjs，上面的校验必须变红',
  publishBoundaryViolations(dist.filter((f) => f !== 'tools/apply-update.mjs')).some((item) => item.includes('apply-update')),
  '删掉安装器却没被抓住',
);
check(
  '反向自检：合成清单塞进 tools/build-client.mjs，上面的校验必须变红',
  publishBoundaryViolations([...dist, 'tools/build-client.mjs']).some((item) => item.includes('build-client')),
  '多出构建脚本却没被抓住',
);
check(
  '发布包里没有 docs/ 与 .github/（内部文档与 CI 配置不该上传）',
  !dist.some((f) => f.startsWith('docs/') || f.startsWith('.github/')),
);
check(
  '个人清单没有被跟踪（publish-checklist.local.md / .npmrc）',
  !tracked.some((f) => f.includes('publish-checklist') || f === '.npmrc' || f.endsWith('/.npmrc')),
);
check('发布包文件数在合理范围（>10 且 <40）', dist.length > 10 && dist.length < 40, `实际 ${dist.length}`);

process.stdout.write('\n逐规则扫描\n');
const distHits = scan(dist);
const trackedHits = scan(tracked);
for (const [name] of RULES) {
  // CI 上跳过"当前用户名"这条：CI 的用户名是通用词（GitHub 是 `runner`），会与文档里正常的英文词误撞；
  // 而 CI 本来就无从得知开发者本机的用户名。与用户名无关的家目录路径规则在任何环境都照查。
  const skip = inCi && name.startsWith('当前用户名');
  for (const [surface, hits] of [['npm 发布包', distHits], ['git 跟踪文件', trackedHits]]) {
    const found = skip ? [] : hits.get(name);
    check(`${surface}：${name}`, found.length === 0, found.slice(0, 3).join(' | '));
  }
}
if (inCi) process.stdout.write('  （CI 环境：已跳过「当前用户名」规则——它只在开发者本机有意义）\n');

process.stdout.write('\n发布包文档完整性（npm 页面上读者只看得到包内文件）\n');

/** 发布包里的 markdown 文档。 */
const DOCS = dist.filter((f) => f.endsWith('.md'));
const REPO_URL = 'https://github.com/olimc2016/dsh-worktodo';

test_docs: {
  // ① 相对链接 / 图片必须指向包内文件，否则 npm 页面上是 404
  for (const doc of DOCS) {
    const text = readFileSync(join(root, doc), 'utf8');
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0].trim();
      if (target === '' || /^[a-z]+:\/\//i.test(target) || target.startsWith('mailto:')) continue;
      const resolved = target.replace(/^\.\//, '');
      check(`${doc} 的相对链接指向包内文件：${target}`, dist.includes(resolved), '包内没有这个文件，npm 页面上会 404');
    }
  }
  // ② 提到包外目录时，必须同时给出仓库地址（否则 npm 页面的读者无从查找）
  const outsideDirs = ['docs/', 'tools/', '.github/'];
  for (const doc of DOCS) {
    const text = readFileSync(join(root, doc), 'utf8');
    const mentions = outsideDirs.filter((d) => text.includes(d));
    if (mentions.length === 0) continue;
    check(`${doc} 提到包外路径时给出了仓库地址`, text.includes(REPO_URL), `提到 ${mentions.join(' ')} 但没有绝对仓库 URL`);
  }
  // ③ 三份文档都含绝对仓库 URL，便于 npm 页面上回访
  for (const doc of ['README.md', 'README.en.md', 'CHANGELOG.md']) {
    if (!dist.includes(doc)) continue;
    check(`${doc} 含绝对仓库 URL`, readFileSync(join(root, doc), 'utf8').includes(REPO_URL));
  }
}

/* ------------------------------------------------------------------ 汇总 */

process.stdout.write(`\n${'='.repeat(60)}\n`);
if (failed === 0) {
  process.stdout.write(`通过 ${passed} 项发布面检查：无个人 / 机密信息，且发布包文档对 npm 页面的读者自洽\n`);
  process.exit(0);
}
process.stdout.write(`✗ ${failed} 项发布面检查未通过（共 ${passed + failed} 项）：\n`);
for (const f of failures) process.stdout.write(`   - ${f}\n`);
process.exit(1);
