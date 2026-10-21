/**
 * 文档不漂移门禁：文档里承诺的路径 / 命令必须真的存在，两仓共享正文必须逐字节一致。
 *
 * 为什么需要它：规范里「自动防线在这」的承诺最容易过期——脚本改名、文件挪走、命令换了
 * 写法，文档照旧写着，读者（尤其下一位 agent / 新维护者）照着做就踩空。这类漂移不会让
 * 任何业务测试变红，所以必须有一条脚本替人盯着。
 *
 * 两道检查：
 *   ① 引用存在性：扫 AGENTS.md / docs/process/*.md / docs/specs/*.md 的反引号内容，
 *      把「看起来像本仓相对路径」的引用、以及 `node <path>` / `npm run <script>` 命令，
 *      解析成真实路径 / package.json 脚本，断言存在。
 *   ② 跨仓同步：docs/process/development-standard.md 与兄弟仓（同父目录下另一个
 *      带同名文件的仓库）的 `<!-- shared:begin -->` … `<!-- shared:end -->` 段
 *      必须**逐字节**一致（文件头版本记录允许不同；兄弟仓不在时跳过——CI 单仓场景）。
 *
 * README 刻意不扫：本仓库常有未提交的 README 改动，扫它会让门禁被别人正在写的内容误红。
 *
 * 引用判定是「防误报」优先的窄口径：只认反引号里**首段是本仓顶层目录**
 * （tools / docs / lib / src / locale / .github）或以已知根文件结尾的 token。
 * 仓库坐标（`olimc2016/dsh-worktodo`）、profile 路径（`profile/node_modules/...`）、
 * scoped 包名（`@deepseek-ai/...`）、系统路径（`Contents/Resources/app.asar`）都不算
 * 本仓引用——把它们当路径会制造一堆假红，反而让人关掉门禁。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, relative } from 'node:path';

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

/* ---------------------------------------------------------------- 仓库清单 */

/** 递归遍历仓库（跳过 node_modules / .git），得到「相对仓库根的 posix 路径」集合。 */
function listRepoEntries() {
  const IGNORED = new Set(['node_modules', '.git']);
  const files = new Set();
  const dirs = new Set();
  const walk = (absDir, relDir) => {
    for (const name of readdirSync(absDir)) {
      if (IGNORED.has(name)) continue;
      const abs = join(absDir, name);
      const rel = relDir === '' ? name : `${relDir}/${name}`;
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        dirs.add(`${rel}/`);
        walk(abs, rel);
      } else if (stat.isFile()) {
        files.add(rel);
      }
    }
  };
  walk(root, '');
  return { files, dirs };
}

const repoEntries = listRepoEntries();

const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};

/* ------------------------------------------------------------------ 文档集 */

const DOC_DIRS = ['docs/process', 'docs/specs'];

/** 扫描范围：AGENTS.md + docs/process/*.md + docs/specs/*.md（README 不扫，见文件头）。 */
function scannedDocs() {
  const out = [];
  if (existsSync(join(root, 'AGENTS.md'))) out.push('AGENTS.md');
  for (const relDir of DOC_DIRS) {
    const absDir = join(root, ...relDir.split('/'));
    if (!existsSync(absDir)) continue;
    for (const name of readdirSync(absDir).sort()) {
      if (name.endsWith('.md')) out.push(`${relDir}/${name}`);
    }
  }
  return out.sort();
}

const docFiles = scannedDocs();

/* -------------------------------------------------------------- 引用判定规则 */

/** 本仓顶层目录：引用首段在这里才当「仓库路径」检查。 */
const REPO_ROOT_DIRS = ['tools', 'docs', 'lib', 'src', 'locale', '.github'];

/** 本仓根文件名：token 恰好等于它们时也检查。 */
const REPO_ROOT_FILES = new Set([
  'package.json',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'LICENSE',
  'AGENTS.md',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.gitattributes',
  '.gitignore',
]);

/**
 * 显式白名单：确实不该 / 不能在本仓存在，逐个登记理由。
 * 这里是「允许跳过」，不是「忽略检查」——每次跳过都会在输出里列出来，方便审计。
 */
const REF_WHITELIST = new Map([
  ['publish-checklist.local.md', '私有文件，刻意不入库（AGENTS.md 守卫 6）'],
  ['docs/marketplace-research.md', '邻仓的私有调研文档，不在本仓库'],
  ['docs/design-vX.md', '规范里的占位路径（设计稿命名模板）'],
  ['tools/verify-profile.mjs', '§3.3 明确标注的「下一版该补」缺口，尚未落地'],
  ['tools/preview.mjs', '邻仓（token 面板）的版式预览工具；repo-annex §6 明确本仓没有'],
]);

/**
 * 命令类白名单：规范里拿来做**反例演示**的命令，不是本仓真脚本。
 * 与路径白名单分开登记，避免把「演示写法」误当成「文档承诺存在的脚本」。
 */
const COMMAND_WHITELIST = new Map([
  ['node tools/x.mjs', '规范 §3.2 演示「管道吞退出码」的示意命令，不是真实脚本'],
]);

/** 明显不是本仓相对路径的形状：URL / 家目录 / scoped 包名 / 占位符 / 绝对路径。 */
const SKIP_PREFIXES = ['http://', 'https://', 'mailto:', 'file:', 'git:', 'github:', '~', '@', '<', '$', '#', '/', '..', '\\'];
const WINDOWS_ABS = /^[A-Za-z]:[\\/]/;

function normalizeRef(raw) {
  return raw.trim().replace(/^\.\//, '');
}

/** 这个 token 看起来像不像「本仓相对路径」。 */
function isRepoRef(raw) {
  if (SKIP_PREFIXES.some((prefix) => raw.startsWith(prefix))) return false;
  if (WINDOWS_ABS.test(raw)) return false;
  const ref = normalizeRef(raw);
  if (REPO_ROOT_FILES.has(ref)) return true;
  return REPO_ROOT_DIRS.includes(ref.split('/')[0]);
}

/** 反引号 token 去掉句尾标点（不影响结尾的 `/` 与 `*`）。 */
function trimToken(raw) {
  return raw.trim().replace(/[),;:。]+$/, '');
}

/** 把 `*` / `**` glob 转成正则。 */
function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else if ('\\^$.|+()[]{}?'.includes(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * 引用现在在仓库里是什么状态。
 * @returns {{kind:'ok'|'missing'|'whitelist'|'placeholder', reason?:string, detail?:string}}
 */
function refStatus(ref) {
  if (REF_WHITELIST.has(ref)) return { kind: 'whitelist', reason: REF_WHITELIST.get(ref) };
  if (/<[^>]*>/.test(ref) || ref.includes('${')) return { kind: 'placeholder', reason: '占位符' };
  if (ref.includes('*')) {
    const matcher = globToRegExp(ref);
    const hits = [...repoEntries.files, ...repoEntries.dirs].filter((entry) => matcher.test(entry));
    return hits.length > 0 ? { kind: 'ok', detail: `匹配 ${hits.length} 项` } : { kind: 'missing' };
  }
  const abs = join(root, ...ref.split('/'));
  return existsSync(abs) ? { kind: 'ok' } : { kind: 'missing' };
}

/** `node <path>`：只认指向本仓脚本的命令。 */
function parseNodeCommand(raw) {
  const match = raw.match(/^node\s+(\S+)/);
  if (!match) return null;
  const arg = normalizeRef(trimToken(match[1]));
  if (!isRepoRef(arg) || !/\.(mjs|js|cjs)$/.test(arg)) return null;
  return { type: 'node', target: arg };
}

/** `npm run <script>`：只认包脚本。 */
function parseNpmRun(raw) {
  const match = raw.match(/^npm\s+run\s+([A-Za-z0-9:_-]+)/);
  return match ? { type: 'npm', target: match[1] } : null;
}

/* ------------------------------------------------------------------ 提取引用 */

/** @type {Map<string, Set<string>>} */
const pathRefs = new Map();
/** @type {Map<string, Set<string>>} */
const nodeCommands = new Map();
/** @type {Map<string, Set<string>>} */
const npmCommands = new Map();

function remember(map, key, where) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(where);
}

for (const file of docFiles) {
  const lines = readFileSync(join(root, ...file.split('/')), 'utf8').split('\n');
  lines.forEach((line, index) => {
    const where = `${file}:${index + 1}`;
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const raw = match[1].trim();
      if (raw === '') continue;
      const nodeCommand = parseNodeCommand(raw);
      if (nodeCommand) {
        remember(nodeCommands, nodeCommand.target, where);
        continue;
      }
      const npmCommand = parseNpmRun(raw);
      if (npmCommand) {
        remember(npmCommands, npmCommand.target, where);
        continue;
      }
      const ref = trimToken(raw);
      if (isRepoRef(ref)) remember(pathRefs, normalizeRef(ref), where);
    }
  });
}

/** 把出现位置集合压成「首次位置（共 N 处）」。 */
function whereLabel(locations) {
  const all = [...locations];
  return all.length === 1 ? all[0] : `${all[0]} 等 ${all.length} 处`;
}

/* ------------------------------------------------------------------ ① 引用 */

console.log(`扫描范围（${docFiles.length} 份文档，README 不扫）`);
for (const file of docFiles) console.log(`  · ${file}`);

console.log('\n仓库路径引用');

const whitelistedRefs = [];
const placeholderRefs = [];

for (const ref of [...pathRefs.keys()].sort()) {
  const where = whereLabel(pathRefs.get(ref));
  const status = refStatus(ref);
  if (status.kind === 'ok') {
    test(`引用存在：${ref}${status.detail ? `（${status.detail}）` : ''}  ← ${where}`, () => {});
  } else if (status.kind === 'whitelist') {
    skipped += 1;
    whitelistedRefs.push(`${ref} ← ${where}：${status.reason}`);
  } else if (status.kind === 'placeholder') {
    skipped += 1;
    placeholderRefs.push(`${ref} ← ${where}`);
  } else {
    test(`引用存在：${ref}  ← ${where}`, () => {
      throw new Error('仓库里没有这个路径（文档写的文件被改名 / 挪走了？）');
    });
  }
}

console.log('\n命令引用');

for (const target of [...nodeCommands.keys()].sort()) {
  const where = whereLabel(nodeCommands.get(target));
  if (COMMAND_WHITELIST.has(`node ${target}`)) {
    skipped += 1;
    whitelistedRefs.push(`node ${target} ← ${where}：${COMMAND_WHITELIST.get(`node ${target}`)}`);
    continue;
  }
  test(`命令脚本存在：node ${target}  ← ${where}`, () => {
    eq(refStatus(target).kind === 'ok', true, '仓库里没有这个脚本：');
  });
}

for (const target of [...npmCommands.keys()].sort()) {
  const where = whereLabel(npmCommands.get(target));
  test(`包脚本存在：npm run ${target}  ← ${where}`, () => {
    eq(Object.hasOwn(scripts, target), true, `package.json 的 scripts 里没有 ${target}：`);
  });
}

// 白名单 / 占位符统一在这里打印：命令白名单是在上面的循环里登记的，必须等两段都跑完再汇总，
// 否则「已跳过的命令」不会出现在输出里，等于悄悄放过。
if (whitelistedRefs.length) {
  console.log('\n显式白名单（允许不存在，逐条登记了理由）');
  for (const item of whitelistedRefs) console.log(`  - ${item}`);
}
if (placeholderRefs.length) {
  console.log(`\n占位符跳过（含 <...> / \${...}，不是真实路径）：${placeholderRefs.join('、')}`);
}

/* ------------------------------------------------------ ② 跨仓共享段同步 */

const SHARED_BEGIN = '<!-- shared:begin -->';
const SHARED_END = '<!-- shared:end -->';

/**
 * 取出共享段。**不 trim、不做换行归一**——两仓要的就是逐字节一致。
 * @returns {{content?:string, startLine?:number, error?:string}}
 */
function extractShared(text) {
  const countBegin = text.split(SHARED_BEGIN).length - 1;
  const countEnd = text.split(SHARED_END).length - 1;
  if (countBegin !== 1 || countEnd !== 1) {
    return { error: `共享段标记必须各出现一次（begin=${countBegin}, end=${countEnd}）` };
  }
  const start = text.indexOf(SHARED_BEGIN) + SHARED_BEGIN.length;
  const end = text.indexOf(SHARED_END);
  if (end <= start) return { error: '共享段标记顺序不对：shared:end 出现在 shared:begin 之前' };
  return {
    content: text.slice(start, end),
    startLine: text.slice(0, start).split('\n').length,
  };
}

/** 逐行比较，返回第一处不一致的 1-based 行号；完全一致返回 0。 */
function firstDiffLine(left, right) {
  const a = left.split('\n');
  const b = right.split('\n');
  const total = Math.max(a.length, b.length);
  for (let i = 0; i < total; i += 1) {
    if (a[i] !== b[i]) return i + 1;
  }
  return 0;
}

/** 第一处差异上下各 2 行，两侧对照，方便直接改。 */
function diffReport(left, right, leftStartLine) {
  const a = left.split('\n');
  const b = right.split('\n');
  const line = firstDiffLine(left, right);
  const total = Math.max(a.length, b.length);
  const from = Math.max(1, line - 2);
  const to = Math.min(total, line + 2);
  const out = [`共享段第 ${line} 行起不一致（本仓文件第 ${leftStartLine + line - 1} 行）`];
  for (let i = from; i <= to; i += 1) {
    const mark = i === line ? '≠' : ' ';
    out.push(`${mark} 本仓 ${String(i).padStart(4)} | ${a[i - 1] ?? '<无此行>'}`);
    out.push(`${mark} 邻仓 ${String(i).padStart(4)} | ${b[i - 1] ?? '<无此行>'}`);
  }
  return out.join('\n      ');
}

console.log('\n跨仓共享段同步');

const OWN_STANDARD = 'docs/process/development-standard.md';
const parentDir = join(root, '..');

/**
 * 自动发现兄弟仓：同父目录下、另一个带 `docs/process/development-standard.md` 的仓库。
 * 不写死仓库名——两个仓库互相是对方的兄弟仓，写死就容易把「自己比自己」当成通过。
 */
function findSiblingStandard() {
  let entries;
  try {
    entries = readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === basename(root)) continue;
    const candidate = join(parentDir, entry.name, ...OWN_STANDARD.split('/'));
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const siblingPath = findSiblingStandard();
const siblingLabel = siblingPath ? `../${relative(parentDir, siblingPath)}` : null;

const ownText = readFileSync(join(root, ...OWN_STANDARD.split('/')), 'utf8');
const ownShared = extractShared(ownText);

test('本仓规范带 shared:begin / shared:end 标记', () => {
  eq(ownShared.error, undefined, `${OWN_STANDARD} ${ownShared.error ?? ''}：`);
});

if (!siblingPath) {
  skipped += 1;
  console.log('  跨仓同步：跳过（单仓环境）—— 同父目录下找不到另一个带 docs/process/development-standard.md 的仓库');
} else {
  console.log(`  邻仓：${siblingLabel}`);
  const siblingText = readFileSync(siblingPath, 'utf8');
  const siblingShared = extractShared(siblingText);
  test('邻仓规范带 shared:begin / shared:end 标记', () => {
    eq(siblingShared.error, undefined, `${siblingLabel} ${siblingShared.error ?? ''}：`);
  });
  if (!ownShared.error && !siblingShared.error) {
    test('两仓共享段逐字节一致（不 trim、不做换行归一）', () => {
      if (ownShared.content === siblingShared.content) return;
      throw new Error(diffReport(ownShared.content, siblingShared.content, ownShared.startLine));
    });
  }
}

/* ------------------------------------------------------- 反向自检（证明会红） */

console.log('\n反向自检（证明这套判定真的会红，不是永远绿）');

test('引用形态判定：仓库路径算引用，仓库坐标 / 包名 / URL / 家目录不算', () => {
  eq(isRepoRef('tools/verify-all.mjs'), true, 'tools/ 下的路径应当算引用：');
  eq(isRepoRef('package.json'), true, '已知根文件应当算引用：');
  eq(isRepoRef('@deepseek-ai/dsh-tools'), false, 'scoped 包名不是本仓路径：');
  eq(isRepoRef('https://github.com/olimc2016/dsh-worktodo'), false, 'URL 不是本仓路径：');
  eq(isRepoRef('~/Documents/...'), false, '家目录不是本仓路径：');
  eq(isRepoRef('olimc2016/dsh-worktodo'), false, '仓库坐标不是本仓路径：');
  eq(isRepoRef('profile/node_modules/@deepseek-ai/*'), false, 'profile 路径不是本仓路径：');
});

test('glob 判定：tools/*.mjs 命中真实脚本，tools/nope-*.mjs 不命中', () => {
  eq(refStatus('tools/*.mjs').kind, 'ok', 'tools/*.mjs 应当命中：');
  eq(refStatus('tools/nope-*.mjs').kind, 'missing', '不存在的 glob 必须判红：');
});

test('反向：引用一个不存在的仓库路径必须判红', () => {
  eq(refStatus('tools/not-exist-xyz.mjs').kind, 'missing', '不存在的路径必须报 missing：');
});

test('反向：node 命令指向不存在的脚本必须判红', () => {
  const command = parseNodeCommand('node tools/not-exist-xyz.mjs');
  eq(command, { type: 'node', target: 'tools/not-exist-xyz.mjs' }, 'node 命令没被解析出来：');
  eq(refStatus(command.target).kind, 'missing', '不存在的脚本必须报 missing：');
});

test('反向：不存在的包脚本必须判红', () => {
  const command = parseNpmRun('npm run not-a-script');
  eq(command, { type: 'npm', target: 'not-a-script' }, 'npm run 没被解析出来：');
  eq(Object.hasOwn(scripts, 'not-a-script'), false, '不存在的包脚本不该被判存在：');
});

test('白名单是显式的：占位文件被跳过，但它在仓库里确实不存在', () => {
  eq(refStatus('docs/design-vX.md').kind, 'whitelist', '占位路径应当走白名单：');
  eq(existsSync(join(root, 'docs', 'design-vX.md')), false, '白名单项不该真的存在（存在就该删掉白名单）：');
});

test('共享段：内容相同 → 没有差异；不 trim / 不归一换行', () => {
  eq(firstDiffLine('第一行\n第二行\n', '第一行\n第二行\n'), 0, '相同内容不该报差异：');
  eq(firstDiffLine('第一行\n第二行  \n', '第一行\n第二行\n'), 2, '行尾空格必须算差异（证明没有 trim）：');
  eq(firstDiffLine('第一行\r\n第二行\n', '第一行\n第二行\n'), 1, 'CRLF 必须算差异（证明没有做换行归一）：');
});

test('共享段：合成不一致能指出第一处差异行号', () => {
  eq(firstDiffLine('a\nb\nc', 'a\nB\nc'), 2, '第一处差异行号不对：');
  eq(firstDiffLine('a\nb', 'a\nb\nc'), 3, '行数不同也要能报出差异：');
});

test('共享段：缺标记 / 标记重复必须报错', () => {
  eq(typeof extractShared('没有标记的正文').error, 'string', '缺标记必须报错：');
  eq(typeof extractShared(`${SHARED_BEGIN}\n正文\n${SHARED_END}\n${SHARED_END}`).error, 'string', '标记重复必须报错：');
  eq(typeof extractShared(`${SHARED_BEGIN}\n正文\n${SHARED_END}`).content, 'string', '正常标记应当能取出正文：');
});

/* ------------------------------------------------------------------ 汇总 */

console.log(`\n${'='.repeat(60)}`);
console.log(`${passed} 通过，${failures.length} 失败${skipped ? `，${skipped} 跳过` : ''}`);
if (failures.length) {
  console.error('文档门禁未通过：');
  for (const f of failures) console.error(`- ${f.label}: ${f.error?.stack ?? f.error}`);
  process.exit(1);
}
