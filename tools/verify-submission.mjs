/**
 * 收录提交门禁校验（本地先跑一遍上游会跑的那些规则）。
 *
 * 为什么需要它：deepseek1024.com 的收录是往 `imsai-sh/awesome-deepseek-harness-plugins`
 * 提一个只含 `catalog/plugins/<id>.json` 的 PR，而那个 PR 的静态门禁会**读我的仓库**逐条核对
 * （字段、文件名、分类、日期、`dsh.bundle.patch` 是否存在且已提交）。
 * 提一个会被自动拒的 PR 是纯浪费（还会让维护者看到一次失败），所以在本地先把这些规则跑一遍。
 *
 * 它还覆盖两个「只在 GitHub 分发路径下才会致命」的点：
 *   1. git 安装只拿到**被 git 跟踪**的文件——所以 `main`、`dsh.bundle.patch`、
 *      以及 git 安装时不再构建的 `lib/client.js` 必须都在 `git ls-files` 里；
 *   2. patch 里那一行的 `name` 必须等于包名，否则新用户装上去 Loader 解析不到插件。
 * 这两条一旦破了：npm 发布照样成功，但 GitHub 安装会静默失效——这正是本项目的主路径。
 *
 * 规则出处：
 *   - 收录规则：imsai-sh/awesome-deepseek-harness-plugins 的 CONTRIBUTING.md
 *   - 字段约束：该仓库 catalog/schema/plugin.schema.json
 *   - 法定分类：该仓库 README 的分节标题（11 个）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import path from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let passed = 0;
const failures = [];

/**
 * @param {string} label
 * @param {() => void} run
 */
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

/**
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} [hint]
 */
function eq(actual, expected, hint = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${hint}期望 ${b}，实际 ${a}`);
}

/** git 跟踪的文件清单（git 安装能拿到的就是这些）。 */
function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * 以下三个函数是**照抄上游审核器**的判定逻辑（scripts/review-plugin-submission.mjs
 * 的 declaredEntryPoint / resolvePatchPath / classifyGitInstall，以及
 * scripts/lib/catalog-entry.mjs 的字段规则）。抄它们的意义是：本地判绿就必须绿，
 * 不能出现"我这边过了、上游拒了"的偏差。
 * ------------------------------------------------------------------ */

/** 清单声明的入口：exports["."] 优先，其次 main。 */
function declaredEntryPoint(manifest) {
  const exported = manifest.exports;
  if (typeof exported === 'string') return exported;
  if (exported && typeof exported === 'object') {
    const rootExport = exported['.'];
    if (typeof rootExport === 'string') return rootExport;
    if (rootExport && typeof rootExport === 'object') {
      for (const condition of ['default', 'import', 'node', 'require']) {
        if (typeof rootExport[condition] === 'string') return rootExport[condition];
      }
    }
  }
  return typeof manifest.main === 'string' ? manifest.main : undefined;
}

/** 相对清单解析路径，并要求结果落在仓库内（上游对此直接抛错）。 */
function resolveWithinRepo(fromFile, target) {
  if (path.posix.isAbsolute(target) || target.includes('\\')) {
    throw new Error(`路径非法（不得绝对、不得含反斜杠）：${target}`);
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), target));
  if (resolved === '..' || resolved.startsWith('../')) {
    throw new Error(`路径逃出了仓库：${target}`);
  }
  return resolved;
}

/** 上游对 git 安装的可加载性分类（LABEL 不是准入条件，但判错说明仓库形态不对）。 */
function classifyGitInstall(manifest, files) {
  const prepare = manifest.scripts?.prepare;
  const requiresBuildAllowance = typeof prepare === 'string' && prepare.trim().length > 0;
  const entry = declaredEntryPoint(manifest);
  if (entry === undefined) return { code: 'no_entry_declared', requiresBuildAllowance };
  let resolved;
  try {
    resolved = resolveWithinRepo('package.json', entry);
  } catch {
    return { code: 'entry_outside_repository', requiresBuildAllowance };
  }
  if (files.includes(resolved)) return { code: 'entry_committed', requiresBuildAllowance };
  return { code: requiresBuildAllowance ? 'prepare_builds_entry' : 'entry_missing_no_prepare', requiresBuildAllowance };
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const entryPath = join(root, 'docs', 'submission', 'olimc2016--dsh-worktodo.json');
const entry = JSON.parse(readFileSync(entryPath, 'utf8'));
const tracked = trackedFiles();

/** 上游 README 分节标题里的法定分类（不是我编的，是从目录 README 的锚点读出来的）。 */
const CATEGORIES = ['ui', 'theme', 'session', 'memory', 'tools', 'skill', 'workflow', 'notify', 'model', 'dev', 'fun'];

console.log('收录条目字段（对照上游 schema）');

test('必填字段集合完全等于 schema 要求（additionalProperties: false）', () => {
  eq(Object.keys(entry).sort(), ['$schema', 'added', 'category', 'description', 'id', 'name', 'repository'].sort());
  eq(entry.$schema, '../schema/plugin.schema.json');
});

test('id 合法且没有 . / .. 段', () => {
  eq(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(entry.id), true, 'id 正则不匹配：');
  eq(entry.id.length <= 201, true, 'id 超长：');
  const segments = entry.id.split('/');
  eq(segments.some((s) => s === '.' || s === '..'), false, 'id 段不得是 . 或 ..：');
});

test('文件名由 id 按上游规则推导而来', () => {
  // 每个 `/` 段小写、非字母数字连续段换成 `-`，段间用 `--`
  const expected = entry.id
    .split('/')
    .map((segment) => segment.toLowerCase().replace(/[^a-z0-9]+/g, '-'))
    .join('--');
  const actual = entryPath.split('/').pop().replace(/\.json$/, '');
  eq(actual, expected, '文件名应当是 id 派生值：');
});

test('repository 合法，且与 package.json 的 repository / 本地包名一致', () => {
  eq(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.repository), true, '仓库 URL 正则不匹配：');
  const fromPkg = (pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
  eq(entry.repository, fromPkg, '收录条目与 package.json 的仓库地址不一致：');
  eq(entry.name, pkg.name, '收录条目的 name 应等于包名：');
  eq(entry.id, `${entry.repository.replace('https://github.com/', '')}`, 'id 应当是 owner/repo：');
});

test('category 在法定分类里', () => {
  eq(CATEGORIES.includes(entry.category), true, `category=${entry.category} 不在法定列表：`);
});

test('description 中英齐全且长度合规', () => {
  eq(Object.keys(entry.description).sort(), ['en', 'zh']);
  for (const [lang, text] of Object.entries(entry.description)) {
    eq(typeof text === 'string' && text.length >= 1 && text.length <= 1000, true, `${lang} 描述长度不合规：`);
  }
});

test('added 是合法日期且不是未来', () => {
  eq(/^\d{4}-\d{2}-\d{2}$/.test(entry.added), true, 'added 格式应为 YYYY-MM-DD：');
  const time = Date.parse(`${entry.added}T00:00:00Z`);
  eq(Number.isNaN(time), false, 'added 不是真实日期：');
  eq(time <= Date.now() + 24 * 60 * 60 * 1000, true, 'added 不能是未来：');
});

test('描述里没有明显的最上级/行动号召（上游明确要求避免）', () => {
  const banned = ['最好用', '最强', '第一名', '必装', '立即安装', '点击这里', 'best ', 'greatest', '#1', 'must-have', 'click here'];
  const hits = banned.filter((word) => Object.values(entry.description).some((text) => text.toLowerCase().includes(word)));
  eq(hits, [], '描述里出现了不该有的措辞：');
});

console.log('上游门禁会读仓库核对的部分');

test('package.json 声明了非空的 dsh.bundle.patch，且该文件已被 git 跟踪', () => {
  const patch = pkg.dsh?.bundle?.patch;
  eq(typeof patch === 'string' && patch.trim().length > 0, true, 'dsh.bundle.patch 为空：');
  eq(existsSync(join(root, patch)), true, `patch 文件不存在：${patch}`);
  eq(tracked.includes(patch.replace(/^\.\//, '')), true, `patch 文件未被 git 跟踪（git 安装拿不到）：${patch}`);
});

test('patch 里那一行的 name 等于包名（否则新用户装上去解析不到插件）', () => {
  const text = readFileSync(join(root, pkg.dsh.bundle.patch), 'utf8');
  const names = [...text.matchAll(/^\s*name:\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)].map((m) => m[1].trim());
  eq(names.length > 0, true, 'patch 里没有 name 行：');
  eq(names.includes(pkg.name), true, `patch 的 name=${JSON.stringify(names)} 里没有包名 ${pkg.name}：`);
});

test('git 安装必需的文件都在 git 跟踪清单里（npm 发布看不出的坑）', () => {
  // git 安装不跑构建：产物必须入库，否则用户拿到的是没有面板的半成品
  const required = [
    pkg.main,                    // lib/index.js —— 宿主半侧入口
    'lib/client.js',             // 浏览器半侧构建产物
    'src/client/index.js',       // 面板源码（可读性/审计）
    'cordis.patch.yml',
    'locale/zh.json',
    'locale/en.json',
    'icon.svg',
  ];
  const missing = required.filter((file) => !tracked.includes(file));
  eq(missing, [], '这些文件没被 git 跟踪，git 安装会缺东西：');
});

test('dsh.client 声明完整（缺了面板不会被组合进 bundle）', () => {
  eq(pkg.dsh?.client?.platform, 'web');
  eq(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0, true, 'dsh.client.inject 为空：');
});

test('运行期依赖必须且只能是被 import 的平台包', () => {
  // 这条曾经断言"零运行期依赖"——那个设计是错的：只声明 peer 时，npm/git 装出来的插件
  // 解析不到平台包，DSH 启动时会直接加载失败（实测：unknown tool "worktodo_list"）。
  const required = ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/dsh-home-paths'];
  const deps = Object.keys(pkg.dependencies ?? {});
  eq(required.filter((d) => !deps.includes(d)), [], '缺少运行期 import 的平台包（装出来会启动失败）：');
  eq(deps.filter((d) => !required.includes(d)), [], '出现了非平台包的运行期依赖（应当为零）：');
});

test('git 安装分类与上游一致：入口已提交、且不需要构建授权', () => {
  // 上游 classifyGitInstall：入口在仓库里 → entry_committed；有 prepare → 安装时要授权。
  const verdict = classifyGitInstall(pkg, tracked);
  eq(verdict.code, 'entry_committed', `上游会把本仓库判成 ${verdict.code}：`);
  eq(verdict.requiresBuildAllowance, false, '仓库里出现了 prepare 脚本，git 安装会要求用户先授权构建：');
});

test('package.json 的路径解析与上游一致（仓库内、不逃逸）', () => {
  // 上游 resolvePatchPath：绝对路径 / 反斜杠 / 逃出仓库 都会直接报错
  const patch = pkg.dsh.bundle.patch.trim();
  const resolved = resolveWithinRepo('package.json', patch);
  eq(resolved, patch.replace(/^\.\//, ''), 'patch 路径应当就是仓库内的相对路径：');
  const entry = declaredEntryPoint(pkg);
  resolveWithinRepo('package.json', entry); // 抛错即失败
});

test('提交指引里内嵌的 JSON 与条目文件一致（防止网页路径粘到过时内容）', () => {
  // docs/submission.md 为了"纯浏览器提交"内嵌了一份全文；它是副本，会和源文件飘移。
  const doc = readFileSync(join(root, 'docs', 'submission.md'), 'utf8');
  const match = doc.match(/```json\n([\s\S]*?)\n```/);
  eq(match !== null, true, '提交指引里找不到内嵌的 json 代码块：');
  eq(JSON.parse(match[1]), entry, '内嵌条目与 docs/submission/ 下的文件不一致：');
});

test('仓库里没有会被上游优先挑中的其它 manifest（浅层优先规则）', () => {
  // 上游按"目录层级更浅优先、同层字典序"挑第一个声明了 dsh.bundle 的 package.json。
  // 多一个子包 manifest 就可能让它挑错，进而把 patch / 入口判到别处。
  const manifests = tracked.filter((f) => f === 'package.json' || f.endsWith('/package.json'));
  eq(manifests, ['package.json'], '出现额外的 package.json：');
});

console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error?.stack ?? f.error}`);
  process.exit(1);
}
