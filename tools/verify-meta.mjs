/**
 * 元测试：源码里不得残留「当前版本号」字面量。
 *
 * 为什么需要它：测试夹具 / 注释里写死版本号，每次发版要么假红（得手工改断言），
 * 要么更糟——有人为了让红变绿去改断言，防线就退化了。版本号一律从 `package.json`
 * 派生（构建期注入 / 运行时读取），源码只认派生值。
 *
 * 扫描范围：`lib/` `src/` `tools/` `locale/` + `cordis.patch.yml`；
 * 排除 `docs/`、`CHANGELOG.md`、`package.json`（这三处本来就该写版本号）。
 * 边界正则 `(?<![\d.])<ver>(?![\d.])`：`0.2.1` 不能命中 `0.2.10` 里的前缀，
 * 也不能被 `10.2.1` 这种更长前缀误伤；补丁号后紧跟数字（不带点号）同样不算命中。
 * 命中报 `文件:行` + 该行内容。
 *
 * 自带两类自测（规范 §3.2.12 要求，扫描器自己也会错）：
 *   ① 边界自测：`0.2.1` / `0.2.10` 样本不互相误伤；注释行也会被扫。
 *   ② 反向自测：合成内容塞当前版本字面量必须报红。
 * 本文件自身也在扫描范围内，所以**源码里不许写当前版本字面量**——样本版本号用拼接构造。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

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

/* ------------------------------------------------------------------ 版本来源 */

const PKG_VERSION = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

/**
 * 版本号里的正则元字符要转义（当前版本号本身干净，但别假设永远如此）。
 * 注意：这条注释原来写了版本字面量，被本脚本自己的扫描抓红过——即「注释也会被扫」
 * 的活例（§3.2.12），所以这类说明一律说「当前版本号」，不写具体数字。
 */
function versionPattern(version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`, 'g');
}

/**
 * 扫一段文本，返回版本字面量命中（行号从 1 开始）。
 * @param {string} text
 * @param {string} version
 * @returns {{line:number, column:number, text:string}[]}
 */
function scanText(text, version) {
  const pattern = versionPattern(version);
  const hits = [];
  text.split('\n').forEach((line, index) => {
    pattern.lastIndex = 0;
    for (const match of line.matchAll(pattern)) {
      hits.push({ line: index + 1, column: match.index + 1, text: line.trim().slice(0, 160) });
    }
  });
  return hits;
}

/* ------------------------------------------------------------------ 扫描范围 */

const SCAN_DIRS = ['lib', 'src', 'tools', 'locale'];
const SCAN_FILES = ['cordis.patch.yml'];
const EXCLUDED = ['docs/', 'CHANGELOG.md', 'package.json'];

/** 递归收集扫描文件（相对仓库根的 posix 路径，结果稳定排序）。 */
function collectSourceFiles() {
  const files = [];
  const walk = (absDir, relDir) => {
    for (const name of readdirSync(absDir).sort()) {
      if (name === 'node_modules' || name === '.git') continue;
      const abs = join(absDir, name);
      const rel = `${relDir}/${name}`;
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(abs, rel);
      else if (stat.isFile()) files.push(rel);
    }
  };
  for (const dir of SCAN_DIRS) {
    const absDir = join(root, dir);
    if (existsSync(absDir)) walk(absDir, dir);
  }
  for (const file of SCAN_FILES) {
    if (existsSync(join(root, file))) files.push(file);
  }
  return files.filter((file) => !EXCLUDED.some((prefix) => file === prefix || file.startsWith(prefix))).sort();
}

const sourceFiles = collectSourceFiles();

/** 扫全部文件；二进制（含 NUL）跳过。 */
function scanFiles(version) {
  const hits = [];
  let scanned = 0;
  let bytes = 0;
  for (const file of sourceFiles) {
    let text;
    try {
      text = readFileSync(join(root, ...file.split('/')), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue; // 二进制
    scanned += 1;
    bytes += Buffer.byteLength(text);
    for (const hit of scanText(text, version)) hits.push({ file, ...hit });
  }
  return { hits, scanned, bytes };
}

/* ------------------------------------------------------------------ 检查 ① */

console.log(`当前版本（来自 package.json）：${PKG_VERSION}`);
console.log(`扫描范围：${sourceFiles.length} 个文件（${SCAN_DIRS.map((d) => `${d}/`).join(' ')} + ${SCAN_FILES.join(' ')}）`);

console.log('\n扫描范围自证');
test('覆盖 lib/ src/ tools/ locale/ 与 cordis.patch.yml', () => {
  eq(sourceFiles.length > 0, true, '扫描清单为空：');
  for (const dir of SCAN_DIRS) eq(sourceFiles.some((file) => file.startsWith(`${dir}/`)), true, `扫描清单里没有 ${dir}/：`);
  eq(sourceFiles.includes(SCAN_FILES[0]), true, `扫描清单里没有 ${SCAN_FILES[0]}：`);
});
test('排除 docs/ CHANGELOG.md package.json（这三处本来就该出现版本号）', () => {
  eq(
    sourceFiles.some((file) => EXCLUDED.some((prefix) => file === prefix || file.startsWith(prefix))),
    false,
    '扫描清单里混进了不该扫的路径：',
  );
});
test('本文件自身也在扫描范围内（「扫全文」的自我证明）', () => {
  eq(sourceFiles.includes('tools/verify-meta.mjs'), true, '扫描清单里没有本文件：');
});

console.log('\n当前版本字面量');
const { hits, scanned, bytes } = scanFiles(PKG_VERSION);
test(`源码里没有当前版本号字面量（扫了 ${scanned} 个文本文件 / ${Math.round(bytes / 1024)} KiB）`, () => {
  if (hits.length === 0) return;
  throw new Error(
    `${hits.length} 处命中（版本常量要从 package.json 派生，别写死）：\n` +
      hits.map((hit) => `      ${hit.file}:${hit.line}  ${hit.text}`).join('\n'),
  );
});
if (hits.length > 0) {
  console.log('\n命中清单（文件:行 → 行内容）');
  for (const hit of hits) console.log(`  ${hit.file}:${hit.line}:${hit.column}  ${hit.text}`);
}

/* -------------------------------------------------- ② 边界自测 / 反向自测 */

// 样本版本号用拼接构造：本文件也在扫描范围内，写死版本形态会在下次发版时变成假红（L12-①）。
const SAMPLE_SHORT = [0, 2, 1].join('.');
const SAMPLE_LONG = [0, 2, 10].join('.');

console.log('\n边界自测（0.2.1 vs 0.2.10 是前缀关系，不能互相误伤）');

test(`边界：${SAMPLE_SHORT} 的边界正则不命中 ${SAMPLE_LONG}`, () => {
  eq(scanText(`版本 ${SAMPLE_LONG}`, SAMPLE_SHORT).length, 0, `${SAMPLE_SHORT} 不应命中 ${SAMPLE_LONG} 的前缀：`);
});
test(`边界：${SAMPLE_LONG} 的边界正则不命中 ${SAMPLE_SHORT}`, () => {
  eq(scanText(`版本 ${SAMPLE_SHORT}`, SAMPLE_LONG).length, 0, `${SAMPLE_LONG} 不应命中 ${SAMPLE_SHORT}：`);
});
test('边界：前后紧贴数字 / 点号都不命中，独立出现才命中', () => {
  eq(scanText(`版本 1${SAMPLE_SHORT}`, SAMPLE_SHORT).length, 0, '前面紧贴数字不应命中：');
  eq(scanText(`版本 1.0.${SAMPLE_SHORT}`, SAMPLE_SHORT).length, 0, '前面紧贴点号不应命中：');
  eq(scanText(`版本 ${SAMPLE_SHORT}1`, SAMPLE_SHORT).length, 0, '后面紧贴数字不应命中：');
  eq(scanText(`版本 ${SAMPLE_SHORT}.1`, SAMPLE_SHORT).length, 0, '后面紧贴点号不应命中：');
  eq(scanText(`版本 ${SAMPLE_SHORT}。`, SAMPLE_SHORT).length, 1, '独立出现的版本号必须命中：');
});
test('边界：注释行也会被扫描（修元测试时别把字面量写回注释）', () => {
  const commentHits = scanText(`// 版本 ${SAMPLE_SHORT}`, SAMPLE_SHORT);
  eq(commentHits.length, 1, '注释里的版本字面量也必须命中：');
  eq(commentHits[0].line, 1, '行号不对：');
});

console.log('\n反向自测（合成内容塞字面量必须报红）');

test('反向：合成内容里的当前版本字面量必须被抓住并报行号', () => {
  const synthetic = `第一行\nconst VERSION = '${PKG_VERSION}';\n// 版本 ${PKG_VERSION}\n`;
  const syntheticHits = scanText(synthetic, PKG_VERSION);
  eq(syntheticHits.length, 2, '合成内容里的当前版本字面量没被抓住：');
  eq(syntheticHits.map((hit) => hit.line), [2, 3], '命中行号不对：');
});

test('反向：合成「干净」内容必须 0 命中（证明不会恒红）', () => {
  const clean = `const VERSION = readPackageVersion();\n// 版本从 package.json 派生\n`;
  eq(scanText(clean, PKG_VERSION).length, 0, '干净内容被误判：');
});

/* ------------------------------------------------------------------ 汇总 */

console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const failure of failures) console.error(`- ${failure.label}: ${failure.error?.stack ?? failure.error}`);
  process.exit(1);
}
