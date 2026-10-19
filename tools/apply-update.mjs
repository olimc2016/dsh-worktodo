#!/usr/bin/env node
/**
 * dsh-worktodo 独立安装器（detached 子进程）。
 *
 * 为什么要有这个文件：
 *   0.2.9 的安装是「在正在运行的 profile 里跑 pnpm update / pnpm add / dsh plugin」。
 *   pnpm 会重写整个 node_modules，正在运行的 DSH 自己的模块被替换/裁剪 → 面板黑屏。
 *   修法不是「把 pnpm 放后台」，而是**不在应用运行中改动 live profile 的依赖树**：
 *   宿主只负责下载 + 校验 + 解包，然后把这个单文件安装器以 detached 方式拉起；
 *   安装器只做一件事 —— 把我们自己的包目录（node_modules/dsh-worktodo）整目录替换。
 *
 * 安全边界（硬约束，代码里逐条可查）：
 *   1. **绝不**跑 pnpm / npm / dsh CLI；**绝不**改 package.json / pnpm-lock.yaml；
 *      **绝不**碰别人的包。整个文件只 import `node:` 内置模块，不 require 仓库里的其它模块
 *      （半更新状态下也能独立运行）。
 *   2. 目标必须是 `<...>/node_modules/dsh-worktodo`；真实路径用 realpath 解析（pnpm 下会落到
 *      `.pnpm/dsh-worktodo@x.y.z/node_modules/dsh-worktodo`），并且只替换这一个目录。
 *   3. 替换前先把旧目录 rename 成同级 `.worktodo-backup-<ts>`；新目录先 copy 到同级
 *      `.worktodo-new-<ts>` 再 rename 成目标名。任何一步失败都从备份恢复，并如实写 failed。
 *   4. 幂等：目标里已经是目标版本 → 直接成功（重复运行/宿主重试不会二次搬目录）。
 *
 * 参数（宿主 lib/index.js 的 buildApplyInstallerSpec 逐字构造）：
 *   --staged <dir>   新版本解包目录（含 package.json/lib/src/cordis.patch.yml）
 *   --target <dir>   <profile>/node_modules/dsh-worktodo
 *   --version <v>    期望版本（必须与 --staged/package.json 一致）
 *   --state <file>   $DSH_HOME/worktodo/update-state.json（结果文件写它同级的 apply-result.json，
 *                    并顺手把 lastApply 合并进去；节流字段 attempted 原样保留）
 *   --log <file>     $DSH_HOME/worktodo/updates/apply-<ts>.log
 *
 * 测试缝（只影响测试，生产不设置）：
 *   WORKTODO_APPLY_FAIL_STEP=rename-target|backup|copy  在指定步骤注入一次失败（验证回滚）
 *   WORKTODO_APPLY_RENAME_FAILS=<n>                    前 n 次 rename 以 EPERM 失败（验证退避重试）
 *   WORKTODO_APPLY_DELAY_MS=<ms>                       开工前等待（验证宿主不等待、detached 继续跑）
 */

import {
  appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const PACKAGE_NAME = 'dsh-worktodo';
const BACKUP_PREFIX = '.worktodo-backup-';
const NEW_PREFIX = '.worktodo-new-';
const BROKEN_PREFIX = '.worktodo-broken-';
const RESULT_FILENAME = 'apply-result.json';
const RENAME_ATTEMPTS = 10;
const LOG_TAIL_LINES = 40;

/** 解析 `--key value`；未知参数忽略（宿主/未来版本多传一个参数不该让安装失败）。 */
function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      out[key] = '';
      continue;
    }
    out[key] = value;
    index += 1;
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

/** 全流程日志：时间戳 + 每一步；写不了日志绝不影响安装本身。 */
function createLogger(file) {
  let ready = false;
  const write = (level, message) => {
    const line = `[${nowIso()}] [${level}] ${message}`;
    try {
      if (!ready) {
        mkdirSync(dirname(file), { recursive: true });
        ready = true;
      }
      appendFileSync(file, `${line}\n`);
    } catch {
      /* 日志只是可观测性：写不了就算了 */
    }
    return line;
  };
  return {
    file,
    step: (message) => write('STEP', message),
    info: (message) => write('INFO', message),
    warn: (message) => write('WARN', message),
    error: (message) => write('ERROR', message),
    tail(lines = LOG_TAIL_LINES) {
      try {
        return readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim()).slice(-lines);
      } catch {
        return [];
      }
    },
  };
}

/** 原子写一个 JSON 文件（同目录临时名 + rename；Windows 上目标被占用时退避重试）。 */
async function writeJsonAtomic(file, value, log) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  await renameWithRetry(temp, file, log, { attempts: 4, label: 'write-result' });
}

/**
 * rename 的退避重试：Windows 上杀毒/索引/句柄占用会短暂 EPERM/EBUSY。
 * 只重试这些「可能自己消失」的错误码；其它错误立刻抛出。
 */
async function renameWithRetry(from, to, log, { attempts = RENAME_ATTEMPTS, label = 'rename' } = {}) {
  let lastError = null;
  const failBudget = Number(process.env.WORKTODO_APPLY_RENAME_FAILS) || 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (failBudget >= attempt) {
        const error = new Error(`EPERM: injected rename failure (attempt ${attempt})`);
        error.code = 'EPERM';
        throw error;
      }
      renameSync(from, to);
      if (attempt > 1) log.step(`${label} 第 ${attempt} 次重试成功：${from} → ${to}`);
      return;
    } catch (error) {
      lastError = error;
      const code = String(error?.code ?? '');
      const retriable = ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EMFILE', 'ENFILE'].includes(code);
      if (!retriable || attempt >= attempts) break;
      const waitMs = Math.min(1000, 60 * (2 ** (attempt - 1)));
      log.warn(`${label} 失败（${code || error?.message}），${waitMs}ms 后第 ${attempt + 1}/${attempts} 次重试`);
      await delay(waitMs);
    }
  }
  throw lastError ?? new Error(`${label} 失败`);
}

/** 读取目录里的 package.json；读不到/坏 JSON 返回 null。 */
function readPackage(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function versionOf(dir) {
  return readPackage(dir)?.version ?? null;
}

/**
 * 校验暂存目录：name/version 必须与期望一致（防止被换成别的包/别的版本）。
 * 只读，不写盘。
 */
function validateStaged(stagedDir, version) {
  if (!existsSync(stagedDir) || !lstatSync(stagedDir).isDirectory()) {
    return { ok: false, reason: 'staged-missing', error: `暂存目录不存在或不是目录：${stagedDir}` };
  }
  const pkg = readPackage(stagedDir);
  if (!pkg) {
    return { ok: false, reason: 'staged-manifest-invalid', error: `暂存目录里没有可解析的 package.json：${stagedDir}` };
  }
  if (pkg.name !== PACKAGE_NAME) {
    return { ok: false, reason: 'staged-name-mismatch', error: `暂存包名 ${JSON.stringify(pkg.name)} ≠ ${PACKAGE_NAME}` };
  }
  if (String(pkg.version) !== String(version)) {
    return { ok: false, reason: 'staged-version-mismatch', error: `暂存版本 ${JSON.stringify(pkg.version)} ≠ ${version}` };
  }
  if (!existsSync(join(stagedDir, 'lib', 'index.js'))) {
    return { ok: false, reason: 'staged-incomplete', error: `暂存目录缺少 lib/index.js：${stagedDir}` };
  }
  return { ok: true, package: pkg };
}

/**
 * 解析真实目标目录（symlink-aware）。
 *
 * pnpm：`<profile>/node_modules/dsh-worktodo` 是指向
 * `<profile>/node_modules/.pnpm/dsh-worktodo@x.y.z/node_modules/dsh-worktodo` 的 symlink；
 * 这里必须替换**真实目录**，否则 rename 掉的是链接本身，profile 的依赖树并没有更新。
 * 目标不存在也允许（首次安装）：用绝对路径，稍后由 rename 创建。
 */
function resolveTarget(targetArg) {
  const absolute = resolve(targetArg);
  if (existsSync(absolute)) {
    const real = realpathSync(absolute);
    const stat = statSync(real);
    if (!stat.isDirectory()) return { ok: false, reason: 'target-not-directory', error: `目标不是目录：${real}` };
    return { ok: true, target: real, existed: true };
  }
  return { ok: true, target: absolute, existed: false };
}

/**
 * 只允许替换「node_modules/dsh-worktodo」。
 *
 * pnpm 的真实路径是 `.../node_modules/.pnpm/<pkg>@<ver>/node_modules/dsh-worktodo`；
 * hoisted/npm 是 `<profile>/node_modules/dsh-worktodo`。两者都以
 * `node_modules/dsh-worktodo` 结尾。任何别的形状都拒绝，避免配置错误时误删别人的目录。
 */
function assertSafeTarget(target) {
  const normalized = normalize(target);
  const expectedTail = `${sep}node_modules${sep}${PACKAGE_NAME}`;
  if (!normalized.endsWith(expectedTail)) {
    return {
      ok: false,
      reason: 'unsafe-target',
      error: `拒绝替换非 ${PACKAGE_NAME} 的 node_modules 目录：${normalized}`,
    };
  }
  return { ok: true };
}

function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    force: true,
    dereference: false,
    preserveTimestamps: true,
  });
}

/** 清理我们自己的旧临时/备份目录：备份至少保留最近一份（当前这份不动）。 */
function cleanupOldBackups(parentDir, currentBackup, log) {
  let entries = [];
  try {
    entries = readdirSync(parentDir);
  } catch {
    return;
  }
  const backups = entries
    .filter((name) => name.startsWith(BACKUP_PREFIX))
    .map((name) => ({ name, path: join(parentDir, name) }))
    .filter((entry) => entry.path !== currentBackup)
    .map((entry) => ({ ...entry, at: (() => { try { return statSync(entry.path).mtimeMs; } catch { return 0; } })() }))
    .sort((a, b) => b.at - a.at);
  // 当前备份之外，只保留最新的一份；其余删掉（避免每次升级都在 .pnpm 里留一份整包）。
  for (const entry of backups.slice(1)) {
    try {
      rmSync(entry.path, { recursive: true, force: true });
      log.info(`清理旧备份：${entry.path}`);
    } catch (error) {
      log.warn(`清理旧备份失败（忽略）：${entry.path}：${error?.message ?? error}`);
    }
  }
}

/** 清理本次失败留下的临时目录（只碰我们自己的前缀）。 */
function cleanupTemp(parentDir, paths, log) {
  for (const path of paths) {
    if (!path) continue;
    try {
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    } catch (error) {
      log.warn(`清理临时目录失败（忽略）：${path}：${error?.message ?? error}`);
    }
  }
}

/**
 * 回滚：把备份恢复到目标。
 *
 * 顺序刻意如此：
 *   1. 如果目标存在（新目录已经 rename 过去但校验失败），先挪到 `.worktodo-broken-<ts>`，
 *      绝不直接 rm（失败现场保留，便于人工判断）；
 *   2. rename 备份 → 目标（原子恢复）；
 *   3. 再把恢复后的目标 copy 回备份路径，**保留最近一份备份**（事后可人工对比/回退）；
 *   4. 删掉 broken 临时目录。
 * 任何一步失败都如实返回 rollback ok:false，绝不声称已恢复。
 */
async function rollback({ backup, target, stamp, log }) {
  const parent = dirname(target);
  const broken = join(parent, `${BROKEN_PREFIX}${stamp}`);
  if (!backup || !existsSync(backup)) {
    return { ok: false, restored: false, error: `备份不存在，无法恢复（${backup ?? '未创建备份'}）` };
  }
  if (existsSync(target)) {
    try {
      await renameWithRetry(target, broken, log, { attempts: 4, label: 'rollback-aside' });
    } catch (error) {
      log.warn(`无法把失败的新目录挪开（${error?.message ?? error}），尝试直接删除`);
      try {
        rmSync(target, { recursive: true, force: true });
      } catch (removeError) {
        return { ok: false, restored: false, error: `无法移开/删除失败的新目录：${removeError?.message ?? removeError}` };
      }
    }
  }
  try {
    await renameWithRetry(backup, target, log, { label: 'rollback-restore' });
  } catch (error) {
    return { ok: false, restored: false, error: `从备份恢复失败：${error?.message ?? error}` };
  }
  // 保留一份备份副本（失败后用户/支持人员仍能拿到旧目录）
  try {
    copyTree(target, backup);
  } catch (error) {
    log.warn(`恢复成功但备份副本未能保留（不影响旧版本已恢复）：${error?.message ?? error}`);
  }
  try {
    if (existsSync(broken)) rmSync(broken, { recursive: true, force: true });
  } catch (error) {
    log.warn(`清理 broken 目录失败（忽略）：${error?.message ?? error}`);
  }
  return { ok: true, restored: true, backup };
}

/**
 * 主替换流程。不抛异常：所有结局都通过返回值 + result 文件 + 日志收口。
 * @returns {Promise<object>} result
 */
async function apply({ stagedDir, targetArg, version, resultFile, stateFile, log }) {
  const startedAt = Date.now();
  const stamp = `${startedAt}-${process.pid}`;
  const steps = [];
  const step = (name, ok, detail = null) => {
    steps.push({ step: name, ok, detail });
    log.step(`${ok ? 'OK' : 'FAIL'} ${name}${detail ? `：${detail}` : ''}`);
  };

  // 0) 测试缝：延迟开工（证明宿主不等待、detached 继续跑）
  const delayMs = Number(process.env.WORKTODO_APPLY_DELAY_MS) || 0;
  if (delayMs > 0) {
    log.info(`测试缝：开工前等待 ${delayMs}ms`);
    await delay(delayMs);
  }

  // 1) 目标解析（symlink-aware）+ 目标形状校验
  const resolved = resolveTarget(targetArg);
  if (!resolved.ok) {
    step('resolve-target', false, resolved.error);
    return { ok: false, phase: 'failed', reason: resolved.reason, error: resolved.error, steps };
  }
  const safe = assertSafeTarget(resolved.target);
  if (!safe.ok) {
    step('assert-safe-target', false, safe.error);
    return { ok: false, phase: 'failed', reason: safe.reason, error: safe.error, steps };
  }
  const target = resolved.target;
  const parent = dirname(target);
  step('resolve-target', true, `${targetArg} → ${target}${resolved.existed ? '' : '（目标不存在，将新建）'}`);

  // 2) 幂等：目标已经是目标版本 → 直接成功，不动任何文件
  const currentVersion = versionOf(target);
  if (resolved.existed && currentVersion === String(version)) {
    step('idempotent-check', true, `已安装 ${currentVersion}，无需重复替换`);
    return {
      ok: true,
      phase: 'installed',
      alreadyInstalled: true,
      version: String(version),
      target,
      steps,
      backup: null,
    };
  }

  // 3) 暂存目录校验（步骤顺序与规格一致：校验 name/version）
  const staged = validateStaged(stagedDir, version);
  if (!staged.ok) {
    step('validate-staged', false, staged.error);
    return { ok: false, phase: 'failed', reason: staged.reason, error: staged.error, steps };
  }
  step('validate-staged', true, `${PACKAGE_NAME}@${version}`);

  const backup = resolved.existed ? join(parent, `${BACKUP_PREFIX}${stamp}`) : null;
  const temp = join(parent, `${NEW_PREFIX}${stamp}`);
  let backedUp = false;
  let installed = false;

  // 4) 先把新目录 copy 到同级临时名（copy 失败时目标完全没动）
  try {
    if (process.env.WORKTODO_APPLY_FAIL_STEP === 'copy') {
      const error = new Error('injected copy failure');
      error.code = 'EINJECTED';
      throw error;
    }
    copyTree(stagedDir, temp);
    step('copy-staged', true, `${stagedDir} → ${temp}`);
  } catch (error) {
    step('copy-staged', false, String(error?.message ?? error));
    cleanupTemp(parent, [temp], log);
    return { ok: false, phase: 'failed', reason: 'copy-failed', error: `复制新版本目录失败：${error?.message ?? error}`, steps };
  }

  try {
    // 5) 备份：旧目录 rename 成同级 .worktodo-backup-<ts>
    if (resolved.existed) {
      if (process.env.WORKTODO_APPLY_FAIL_STEP === 'backup') {
        const error = new Error('injected backup failure');
        error.code = 'EINJECTED';
        throw error;
      }
      await renameWithRetry(target, backup, log, { label: 'backup' });
      backedUp = true;
      step('backup-target', true, `${target} → ${backup}`);
    } else {
      step('backup-target', true, '目标原本不存在，无需备份');
    }

    // 6) 原子替换：临时目录 rename 成目标名
    if (process.env.WORKTODO_APPLY_FAIL_STEP === 'rename-target') {
      const error = new Error('injected rename-target failure');
      error.code = 'EINJECTED';
      throw error;
    }
    await renameWithRetry(temp, target, log, { label: 'rename-target' });
    installed = true;
    step('rename-target', true, `${temp} → ${target}`);

    // 7) 校验落盘版本
    const landed = versionOf(target);
    if (landed !== String(version)) {
      throw Object.assign(new Error(`落盘版本 ${JSON.stringify(landed)} ≠ ${version}`), { code: 'EVERSION' });
    }
    step('verify-version', true, `${landed}`);

    // 8) 成功：保留最近一份备份，清理更老的
    if (backup) {
      step('keep-backup', true, backup);
      cleanupOldBackups(parent, backup, log);
    }
    return {
      ok: true,
      phase: 'installed',
      alreadyInstalled: false,
      version: String(version),
      previousVersion: currentVersion,
      target,
      backup,
      steps,
    };
  } catch (error) {
    const reason = error?.code === 'EVERSION' ? 'version-mismatch' : 'replace-failed';
    log.error(`替换失败（${reason}）：${error?.stack ?? error}`);
    step('replace', false, String(error?.message ?? error));
    // 只有真的动过目标（backedUp 或 installed）才需要回滚
    let restored = { ok: true, restored: false };
    if (backedUp || installed) {
      log.warn('开始从备份回滚');
      restored = await rollback({ backup, target, stamp, log });
      step('rollback', restored.ok, restored.ok
        ? (restored.restored ? `已恢复旧目录：${backup}` : '未改动目标，无需恢复')
        : restored.error);
    } else {
      step('rollback', true, '目标未被改动，无需回滚');
    }
    cleanupTemp(parent, [temp], log);
    const rollbackNote = restored.ok
      ? (restored.restored ? `；已从备份恢复旧版本（备份保留在 ${backup}）` : '；目标未被改动')
      : `；回滚失败：${restored.error}`;
    return {
      ok: false,
      phase: 'failed',
      reason: restored.ok ? reason : 'rollback-failed',
      error: `替换 ${PACKAGE_NAME} 失败：${error?.message ?? error}${rollbackNote}`,
      version: String(version),
      previousVersion: currentVersion,
      target,
      backup,
      restored: restored.ok && restored.restored === true,
      rollbackFailed: !restored.ok,
      steps,
    };
  }
}

/** 结果里只放可复现事实；宿主会把 logTail 放进 diagnostics。 */
function buildResult(result, { stagedDir, targetArg, version, log, startedAt }) {
  return {
    ...result,
    name: PACKAGE_NAME,
    version: result.version ?? String(version),
    staged: stagedDir,
    target: result.target ?? targetArg,
    log: log.file,
    startedAt,
    finishedAt: Date.now(),
    pid: process.pid,
    platform: process.platform,
    node: process.version,
    logTail: log.tail(LOG_TAIL_LINES),
  };
}

/** 把 lastApply 合并进 update-state.json，保留宿主写的 attempted/at 等节流字段。 */
async function mergeState(stateFile, result, log) {
  if (!stateFile) return;
  let existing = {};
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch {
    /* 缺失/损坏：从空对象开始；宿主的结果文件才是权威 */
  }
  const next = {
    ...existing,
    lastApply: {
      ok: result.ok === true,
      phase: result.phase,
      version: result.version ?? null,
      at: result.finishedAt ?? Date.now(),
      ...(result.ok ? {} : { reason: result.reason ?? 'apply-failed', error: result.error ?? null }),
    },
  };
  try {
    await writeJsonAtomic(stateFile, next, log);
    log.info(`已合并 lastApply 到状态文件：${stateFile}`);
  } catch (error) {
    log.warn(`写状态文件失败（不影响安装结论）：${error?.message ?? error}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stagedDir = args.staged ? resolve(args.staged) : '';
  const targetArg = args.target ? resolve(args.target) : '';
  const version = String(args.version ?? '').trim();
  const stateFile = args.state ? resolve(args.state) : '';
  const logFile = args.log ? resolve(args.log) : join(dirname(stateFile || process.cwd()), 'apply.log');
  const resultFile = stateFile ? join(dirname(stateFile), RESULT_FILENAME) : join(process.cwd(), RESULT_FILENAME);
  const log = createLogger(logFile);
  const startedAt = Date.now();
  log.step(`安装器启动 pid=${process.pid} version=${version || '（缺失）'}`);
  log.step(`staged=${stagedDir || '（缺失）'}`);
  log.step(`target=${targetArg || '（缺失）'}`);
  log.step(`state=${stateFile || '（缺失）'} result=${resultFile}`);

  let result;
  if (!stagedDir || !targetArg || !version || !stateFile) {
    result = {
      ok: false,
      phase: 'failed',
      reason: 'bad-args',
      error: '缺少必需参数：--staged / --target / --version / --state',
      steps: [],
    };
  } else {
    try {
      result = await apply({ stagedDir, targetArg, version, resultFile, stateFile, log });
    } catch (error) {
      log.error(`安装器未捕获异常：${error?.stack ?? error}`);
      result = {
        ok: false,
        phase: 'failed',
        reason: 'internal',
        error: `安装器内部错误：${error?.message ?? error}`,
        steps: [],
      };
    }
  }

  const payload = buildResult(result, { stagedDir, targetArg, version, log, startedAt });
  try {
    await writeJsonAtomic(resultFile, payload, log);
    log.step(`结果已写入 ${resultFile}`);
  } catch (error) {
    log.error(`写结果文件失败：${error?.message ?? error}`);
  }
  await mergeState(stateFile, payload, log);
  log.step(payload.ok ? `安装完成：${payload.version}` : `安装失败：${payload.reason}`);
  process.exit(payload.ok ? 0 : 1);
}

main().catch((error) => {
  // 连 main 都崩了：尽力写一行日志；没有 result 文件时宿主会以 apply-exited 收口。
  try {
    process.stderr.write(`[apply-update] fatal: ${error?.stack ?? error}\n`);
  } catch { /* ignore */ }
  process.exit(1);
});
