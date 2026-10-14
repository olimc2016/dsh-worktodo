/**
 * dsh-worktodo — 工作待办（宿主半侧）
 *
 * 职责：
 *   1. 存储：优先官方 ctx.storageDomain（$DSH_HOME/storages），缺失时回退 JSON 文件
 *   2. 服务：把增删改查实现一次（service.mjs），供浏览器面板与 agent 工具共用——
 *      官方《user-actions》要求「一份逻辑两个调用方」，面板的按钮和 worktodo_* 工具不会各写一套
 *   3. 工具：注册 worktodo_add / list / update / done / remove / adopt 给模型
 *   4. 供数：通过 ctx.webServer 暴露读写路由给浏览器半侧面板
 *
 * 与官方 @deepseek-ai/dsh-tool-todo（todo_write）的关系：
 *   官方那份是**单个 agent 会话**的计划：整表替换、只有三态、明确不支持跨 agent 共享。
 *   本插件是**人**的工作待办：跨会话持久、有优先级/截止日期/项目/备注、可逐项编辑。
 *   两者互补，不是替代——worktodo_adopt 就是把前者里值得留下的条目提升到后者的桥。
 *
 * 浏览器半侧（侧栏入口 + 面板）在 lib/client.js，按 package.json 的 dsh.client 组成 bundle。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWorkTodoService } from '../src/service.mjs';
import { openWorkTodoStore, resolveDshHome } from '../src/store.mjs';

/** 插件短名：同时用作行 id、日志标签、面板 slot id 与路由前缀（与 package.json 保持一致）。 */
export const name = 'worktodo';

/**
 * 只声明真正必须的服务。
 * webServer 与 tools 用 ctx.inject 命令式挂载：这样在缺任一服务的精简组合里，
 * 插件仍然能以「少一半能力」的形态活着，而不是整包不激活。
 * storageDomain 也走命令式注入：服务晚注册时在注入回调里升级到官方 storage
 * （store.mjs 另外在每次请求上复查一次），避免「apply 时先到先用」的竞态。
 */
export const inject = [];

/**
 * 从自家 package.json 读版本号。
 *
 * 为什么要读：插件以 `link:` 装进 profile 时，源码改动**不会**热更新到已加载的模块
 *（官方文档：已安装包换新代码需要重启，否则仍是旧的模块 generation——本轮真机上就撞到了：
 * 修好的 tools.mjs 在运行中的插件里没生效）。排查「我改的代码到底生效了没」时，
 * 第一件要知道的事就是运行中是哪一版、工具注册了几个，所以把它报在 /worktodo/health 里。
 */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? null;
  } catch {
    return null; // 读不到就不报版本，绝不影响功能
  }
})();

/** 请求体大小上限：待办是很小的 JSON，超过这个数一定是走错了。 */
const BODY_LIMIT = 256 * 1024;

/**
 * 请求体读取的时间上限（S4-2，第四轮审计）。
 *
 * 为什么必须有：`readJsonBody` 原来只监听 data/end/error，`BODY_LIMIT` 只管**大小**。
 * 客户端声明了 `Content-Length: 5000` 却只发 9 字节、并且**不关 socket** 时，
 * 这个请求永远不会 settle，handler 一直被占住（审计实测挂住 >45 秒），
 * 只能靠 Node 默认 300 秒的 `requestTimeout` 兜底。
 *
 * 5 秒对正常调用（同源面板、本机、几百字节 JSON）毫无影响，但能把慢客户端挡在门外。
 * 测试可用 `WORKTODO_BODY_TIMEOUT_MS` 覆盖（与 WORKTODO_UPGRADE_TIMEOUT_MS 同一类测试缝）。
 */
const BODY_TIMEOUT_MS = 5000;

/** 实际生效的请求体超时（非法注入值一律回落到默认）。 */
function bodyTimeoutMs() {
  const injected = Number(process.env.WORKTODO_BODY_TIMEOUT_MS);
  return Number.isFinite(injected) && injected > 0 ? injected : BODY_TIMEOUT_MS;
}

/**
 * 带 HTTP 状态码的请求体错误：路由层据此回**明确的 4xx + 原因**，
 * 而不是把连接掐断让调用方只看到 ECONNRESET（S4-3）。
 * 没有 `statusCode` 的错误沿用既有约定（200 + `{ok:false, reason:'internal'}`）。
 * @param {number} statusCode
 * @param {string} reason 稳定的原因码
 * @param {string} message 给人看的原因
 */
function bodyError(statusCode, reason, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.reason = reason;
  return error;
}

/** 路由前缀。 */
const ROUTE_BASE = '/worktodo';

/**
 * 发 JSON。
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {object} body
 */
function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // 面板与宿主同源，但显式禁止被当成文档解析，降低误用面
    'x-content-type-options': 'nosniff',
  });
  response.end(text);
}

/**
 * 读请求体并解析 JSON。
 *
 * 三个上限/终止条件缺一不可（S4-2/S4-3）：
 *   - 大小（BODY_LIMIT）：超了先 `pause()` 停止读，再回明确的 413（**不再**先 destroy —— 那会让
 *     调用方只看到 ECONNRESET，看不到「请求体过大」）；
 *   - 时间（bodyTimeoutMs()）：慢客户端（不关 socket 也不发完）超时回 408，handler 绝不悬挂；
 *   - 连接（close）：请求还没读完就断了 → 立刻 settle，不留悬挂 promise。
 * 只有「解析失败」这类业务错误保持旧约定（无 statusCode → 路由回 200 + ok:false）。
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<object>} 解析失败抛错
 */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let timer = null;

    /** 幂等收口：settle 一次、清定时器、摘监听（超时后迟到的事件不再重复 settle）。 */
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', onError);
      request.removeListener('close', onClose);
      settle(value);
    };

    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        // 停止继续读：调用方还会继续写，但我们不再吃进内存；未读完的请求由 Node 在响应结束后收掉
        try { request.pause?.(); } catch { /* 假 request 流没有 pause 也不影响 */ }
        finish(reject, bodyError(413, 'body-too-large', `请求体过大（上限 ${BODY_LIMIT} 字节）`));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        finish(resolve, {});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          finish(reject, new Error('请求体必须是 JSON 对象'));
          return;
        }
        finish(resolve, parsed);
      } catch (error) {
        finish(reject, new Error(`请求体不是合法 JSON：${error?.message ?? error}`));
      }
    };
    const onError = (error) => finish(reject, error);
    const onClose = () => finish(reject, bodyError(400, 'body-incomplete', '请求在读完之前就被关闭'));

    timer = setTimeout(() => {
      try { request.pause?.(); } catch { /* 同上 */ }
      finish(reject, bodyError(408, 'body-timeout',
        `读取请求体超时（${bodyTimeoutMs()}ms 内没有收到完整请求体）`));
    }, bodyTimeoutMs());
    // Node（测试环境）里不要因为这个定时器挂住事件循环
    timer?.unref?.();

    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
    request.on('close', onClose);
  });
}

/**
 * 插件主体。
 * @param {object} ctx cordis 上下文
 * @param {object} [config] 组合配置（cordis.patch.yml 的 config）
 */
/**
 * 给模型的用法指引（AI 推荐接口）。
 *
 * 为什么要有它：工具描述只讲「这个工具做什么」，而模型真正需要的是「什么时候该用哪个」——
 * 尤其是本插件与官方 todo_write 的分工（会话内的步骤拆解 vs 人拥有的跨会话工作）。
 * 通过 Host 的 systemPrompt.section() 贡献一段提示，是官方 practices 文档给的推荐做法。
 * order 取 3050：官方 SECTION_ORDERS 里内置工具段是 1000–3000、MCP_SERVERS 是 3100，
 * 插在两者之间读起来就是「插件工具的使用说明」。
 */
/**
 * 版本与更新提示。
 *
 * 只查 npm registry 的 dist-tags.latest（不下载、不安装），结果缓存 6 小时，失败静默——
 * 面板角落显示「当前版本」与「有新版本 vX.Y.Z」，绝不让网络问题影响面板。
 * 测试里设 WORKTODO_NO_UPDATE_CHECK=1 可完全关掉（单元测试不该打网络）。
 */
const UPDATE_CHECK_OFF = process.env.WORKTODO_NO_UPDATE_CHECK === '1';
const UPDATE_TTL_MS = 6 * 3600 * 1000;
const PACKAGE_NAME = 'dsh-worktodo';

/** 语义化版本比较：a > b 返回正数。 */
function compareVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/* ------------------------------------------------------------------ *
 * 自升级（自己升级自己）
 *
 * 为什么需要：只有「有新版本 vX」的提示是不够的 —— 用户那台机器上提示亮了、面板却
 * 一直跑旧代码，因为升级这条路上有三个静默陷阱：
 *   1. profile 里 pin 死了旧版本规格（`"dsh-worktodo": "0.2.0"`）→ 装完还是旧版；
 *   2. npm/pnpm 被镜像源与 6 小时元数据缓存挡住 → 拿到的是镜像里的旧包；
 *   3. 根本没人去执行安装（只提示、不动作）。
 * 所以这里的关键是**显式 `@latest` + 显式官方 registry**，并且把整件事做成一条可查的
 * 状态机（idle/running/done/failed），而不是发一条命令就不管了。
 * ------------------------------------------------------------------ */

/** 官方源。写死默认值而不是信任任何继承来的 npm 配置（那正是被镜像挡住的原因）。 */
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/';
/** 升级子进程的默认上限：pnpm 首次装包要解依赖+下载，180s 足够，又不至于挂死。 */
const DEFAULT_UPDATE_TIMEOUT_MS = 180000;
/** 回传日志的规模上限：只留尾部，避免把整包安装日志塞进状态接口。 */
const UPDATE_LOG_TAIL_LINES = 40;
const UPDATE_LOG_TAIL_CHARS = 4000;
/** 桌面端 CLI 在安装目录里的相对位置（与 runtime/cli/bin/dsh 里那行保持一致）。 */
const DESKTOP_CLI_RELATIVE = ['app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'];

/**
 * 升级相关配置的归一化。
 *
 * 三个默认值都必须**安全**：`autoUpdate` 默认 false（绝不替用户做决定）、
 * registry 默认官方源、超时给一个有限值。非法配置一律回落，绝不让 bad config 把路由打崩。
 * @param {object} [config] cordis 组合配置
 */
function normalizeUpdateConfig(config) {
  const autoUpdate = config?.autoUpdate === true;
  const rawRegistry = typeof config?.updateRegistry === 'string' ? config.updateRegistry.trim() : '';
  const updateRegistry = rawRegistry || OFFICIAL_REGISTRY;
  const rawTimeout = Number(config?.updateTimeoutMs);
  // 下限 100ms：再小的值连 spawn 都来不及，只会制造「永远是超时」的假故障
  const updateTimeoutMs = Number.isFinite(rawTimeout) && rawTimeout >= 100
    ? Math.min(rawTimeout, 3600000)
    : DEFAULT_UPDATE_TIMEOUT_MS;
  return { autoUpdate, updateRegistry, updateTimeoutMs };
}

/** 直接读一个 profile 目录里 `dsh-worktodo` 的依赖规格（没有就返回 null）。 */
function readProfileDependency(profileDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    const spec = pkg?.dependencies?.[PACKAGE_NAME] ?? pkg?.devDependencies?.[PACKAGE_NAME];
    return typeof spec === 'string' && spec.trim() ? spec.trim() : null;
  } catch {
    return null;
  }
}

/** 读 profile 里**已落盘**的插件版本（升级成功后用它判断 hasUpdate，而不是靠「命令没报错」）。 */
function readInstalledVersion(profileDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'node_modules', PACKAGE_NAME, 'package.json'), 'utf8'));
    return typeof pkg?.version === 'string' && pkg.version.trim() ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 从「本插件自己被加载的模块 URL」反推出 profile 目录。纯函数（导出供单测）。
 *
 * registry 安装时本模块的路径就是
 * `.../profiles/<name>/node_modules/dsh-worktodo/lib/index.js`，往前切到 `node_modules` 之前即 profile 目录。
 * 这是**最精确**的信号：多 profile 时不会选错。`link:` 安装时 ESM 会把软链接解析成真实路径
 *（仓库源码路径，不含 profile 的 node_modules 段），于是返回 null，交给后面的扫描/兜底。
 * @param {string} moduleUrl
 * @returns {string|null}
 */
export function profileDirFromModuleUrl(moduleUrl) {
  try {
    const filePath = fileURLToPath(moduleUrl);
    const marker = `${sep}node_modules${sep}${PACKAGE_NAME}${sep}`;
    const index = filePath.lastIndexOf(marker);
    if (index === -1) return null;
    const dir = filePath.slice(0, index);
    return existsSync(join(dir, 'package.json')) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * 找到要升级的那个 profile 目录。
 *
 * 顺序：显式注入（测试缝）→ 模块自身路径（精确）→ `$DSH_HOME/profiles/*` 里依赖了本包的那一个
 * → `desktop`（Electron 桌面端固定用这个名字）。**找不到就明确失败**，绝不猜一个目录去写。
 * @returns {Promise<string|null>}
 */
async function findProfileDir() {
  const injected = process.env.WORKTODO_PROFILE_DIR;
  if (injected && injected.trim()) return resolve(injected.trim().replace(/^~(?=$|[/\\])/, homedir()));

  const fromSelf = profileDirFromModuleUrl(import.meta.url);
  if (fromSelf) return fromSelf;

  let home;
  try {
    home = await resolveDshHome();
  } catch {
    return null;
  }
  const profilesRoot = join(home, 'profiles');
  let names = [];
  try {
    names = readdirSync(profilesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
  for (const name of names) {
    const dir = join(profilesRoot, name);
    if (readProfileDependency(dir) !== null) return dir;
  }
  const desktop = join(profilesRoot, 'desktop');
  if (existsSync(join(desktop, 'package.json'))) return desktop;
  return null;
}

/**
 * 选定升级执行器。
 *
 * 首选官方 CLI：它自带 Desktop 的 pnpm 与 profile 管理语义（`dsh plugin --profile X add ...`），
 * 路径从宿主进程自身推导（Electron：`process.resourcesPath` / `process.execPath` 旁的
 * `Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`）。
 * 拿不到 CLI（非 Electron 宿主、CLI 文件缺失）才退回在 profile 目录直接跑 pnpm。
 *
 * 两个测试缝：`WORKTODO_UPDATE_CLI`（强制 CLI 脚本路径）与 `WORKTODO_PNPM_PATH`（强制 pnpm 可执行文件）。
 */
function resolveUpdater() {
  const cliOverride = process.env.WORKTODO_UPDATE_CLI;
  if (cliOverride && cliOverride.trim()) {
    return { kind: 'cli', command: process.execPath, args: [cliOverride.trim()], env: {}, label: 'dsh plugin' };
  }
  const resources = typeof process.resourcesPath === 'string' ? process.resourcesPath : null;
  const candidates = [];
  if (resources) candidates.push(join(resources, ...DESKTOP_CLI_RELATIVE));
  // execPath 在 macOS 上是 Contents/MacOS/<App>，Resources 就在它旁边
  candidates.push(join(dirname(process.execPath), '..', 'Resources', ...DESKTOP_CLI_RELATIVE));
  const cli = candidates.find((candidate) => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (cli) {
    return {
      kind: 'cli',
      // ELECTRON_RUN_AS_NODE：Electron 二进制要按 Node 跑脚本（与 runtime/cli/bin/dsh 同款）
      command: process.execPath,
      args: ['--expose-internals', cli],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      label: 'dsh plugin',
    };
  }
  const pnpmOverride = process.env.WORKTODO_PNPM_PATH;
  if (pnpmOverride && pnpmOverride.trim()) {
    return { kind: 'pnpm', command: pnpmOverride.trim(), args: [], env: {}, label: 'pnpm' };
  }
  if (resources) {
    const bundled = join(resources, 'runtime', 'pnpm', 'bin', 'pnpm.mjs');
    if (existsSync(bundled)) {
      return {
        kind: 'pnpm',
        command: process.execPath,
        args: [bundled],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        label: 'pnpm',
      };
    }
  }
  // 最后退回 PATH 上的 pnpm（测试就是从这里注入假 pnpm 的）
  return { kind: 'pnpm', command: 'pnpm', args: [], env: {}, label: 'pnpm' };
}

/**
 * 拼出真正要执行的 argv 与给人看的命令串。
 *
 * 两处硬要求：规格必须是 `@latest`（否则被 profile 里 pin 的旧版规格挡住），
 * 且必须显式带 `--registry <官方源>`（否则被镜像/缓存挡住）。
 * @param {{kind: 'cli'|'pnpm', args: string[]}} updater resolveUpdater() 的结果
 * @param {string} profileName profile 目录名
 * @param {string} registry 生效的 registry
 */
function buildUpdateCommand(updater, profileName, registry) {
  const spec = `${PACKAGE_NAME}@latest`;
  if (updater.kind === 'cli') {
    const args = [...updater.args, 'plugin', '--profile', profileName, 'add', spec, '--registry', registry];
    return { args, display: `dsh plugin --profile ${profileName} add ${spec} --registry ${registry}` };
  }
  const args = [...updater.args, 'add', spec, '--registry', registry];
  return { args, display: `pnpm add ${spec} --registry ${registry}` };
}

/** 判定一个 POST /worktodo/update 请求体是「升级」还是「改待办」。 */
function isPluginUpdateRequest(body) {
  if (!body || typeof body !== 'object') return true; // 空体 = 显式要求升级
  if (typeof body.action === 'string') return body.action === 'plugin-update';
  if (body.action !== undefined) return false;
  // 只要带任何一个「改待办」字段就按老语义走；一个都没有（例如 `{}`）说明是在调升级
  const todoKeys = ['ref', 'id', 'title', 'notes', 'priority', 'due', 'dueTime', 'project', 'status'];
  return !todoKeys.some((key) => key in body);
}

/**
 * 是否该自动升级 —— 纯函数，导出供单测。
 *
 * 默认 `enabled === false`（只有用户显式把 config.autoUpdate 设成 true 才可能为 true）：
 * 没让用户点过就动他的安装，是比「不升级」更糟的失败模式。
 * 另外三条都为了「不打扰」：没有新版不跑、正在跑不重入、同一个版本只自动试一次。
 * @param {{enabled: boolean, latest: string|null|undefined, current: string|null, runState: string, attempted: string|null}} input
 * @returns {boolean}
 */
export function shouldAutoUpdate({ enabled, latest, current, runState, attempted }) {
  if (enabled !== true) return false;
  if (!latest) return false;
  if (compareVersion(latest, current ?? '0.0.0') <= 0) return false;
  if (runState === 'running') return false;
  if (attempted === latest) return false;
  return true;
}

const GUIDANCE_TEXT = [
  '工作待办（worktodo_*）：属于用户、跨会话持久的工作清单；侧栏面板与这些工具读写同一份数据。',
  '- 该用：用户说出要办的事、承诺或截止日期（「下周要交」「等对方回复」「记一下」），或你在工作中发现超出本会话、仍需人跟进的待办 → worktodo_add。',
  '- 不该用：当前这次任务的步骤拆解与你自己的执行顺序 → 那是会话内的 todo_write（整表替换、只属于本会话）。两者互补：todo_write 说「这一步怎么走」，工作待办说「这件事还欠着」。',
  '- 动手前先看：worktodo_list({ filter: "today" }) 或 "overdue"；按项目看：worktodo_list({ project: "<项目>" })。用户问「今天要做什么」时先查再答，不要凭记忆。',
  '- 加之前先查重：worktodo_list({ query: "<关键词>" })，同一条不要登记两次。',
  '- 做完了 / 状态变了：worktodo_done（ref 可给 id 或标题）；改标题、截止、优先级、项目用 worktodo_update。',
  '- 约定：标题写成一句简短的祈使句；project 用仓库名或产品名；priority 只在「真的卡住别人」时给 high；链接、背景与验收标准放 notes。',
].join('\n');

export async function apply(ctx, config = {}) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger;

  // ---- 存储与服务：与任何服务依赖无关，先建起来 ----
  // 复审 0.2.2 F12：打开存储**绝不能**让整个插件挂不上。历史上「服务尚未注册时的兜底访问」
  // 就把异常一路冒到 apply，结果是工具与路由全都没有（插件时好时坏）。
  // 这里失败也降级成「能挂载、能报错」的形态：面板与 /health 看得见原因，工具照常注册。
  let store = null;
  let storeOpenError = null;
  try {
    store = await openWorkTodoStore({ ctx, config, logger });
  } catch (error) {
    storeOpenError = String(error?.message ?? error);
    logger?.warn?.(`⚠️ 打开待办存储失败（面板会显示错误而不是空列表）：${storeOpenError}`);
    store = {
      kind: 'unavailable',
      location: null,
      async load() { throw new Error(`待办存储不可用：${storeOpenError}`); },
      async put() { throw new Error(`待办存储不可用：${storeOpenError}`); },
      async remove() { throw new Error(`待办存储不可用：${storeOpenError}`); },
      // 与真实存储句柄接口一致（S3-1）：reorder 走 updateOrder，不可用时同样显式失败
      async updateOrder() { throw new Error(`待办存储不可用：${storeOpenError}`); },
      onChanged() { return () => {}; },
      refreshBackend() { return Promise.resolve(false); },
      init() { return Promise.resolve(); },
      describe() {
        return {
          kind: 'unavailable',
          location: null,
          preferred: 'domain',
          mismatch: null,
          split: null,
          merge: null,
          upgrades: 0,
          retired: null,
          backendError: `打开待办存储失败：${storeOpenError}`,
          backendUsable: null,
          domainUnavailable: false,
        };
      },
      async close() {},
    };
  }
  const service = createWorkTodoService({ store, logger });

  // 存储后端选择只记一行日志，方便装完排查「我的数据到底存哪了」
  logger?.info?.(`待办数据：${store.kind} → ${store.location}`);

  // ---- 存储生命周期（卸载/重载时释放领域句柄，避免二次挂载撞 already-open）----
  // 审计 F1：`close()` 定义了却从没人调，二次挂载必然 already-open → 静默降级到回退文件。
  // 复审 R2：清理必须**返回**这个 close 的 promise（cordis 会 await 它）。原来是
  // fire-and-forget，卸载后立刻重载会在「句柄还没关完」的窗口里撞 already-open 并降级到文件。
  ctx.effect(() => () => Promise.resolve()
    .then(() => store.close?.())
    .catch((error) => logger?.warn?.(`关闭待办存储失败：${error?.message ?? error}`)), 'worktodo: store lifecycle');

  // ---- 后端升级：storageDomain 晚注册时，服务就绪事件里立刻升级并合并两处数据 ----
  // 审计 F1：后端选择不能在 apply 开头一锤定音。这里用正确声明的注入（ctx.inject）
  // 保证「服务可见性」由 cordis 决定；即使没走到这一步，每次请求也会复查一遍。
  ctx.inject(['storageDomain'], (domainCtx) => {
    domainCtx.effect(() => {
      void Promise.resolve()
        .then(() => store.refreshBackend?.())
        .catch((error) => logger?.warn?.(`待办存储升级检查失败：${error?.message ?? error}`));
      return () => {};
    }, 'worktodo: storage domain upgrade');
  });

  // ---- 变更通知：store → service → 面板/日志（原来 onChanged/onChange 都是死代码）----
  const changes = { count: 0, lastAt: null };
  const disposeStoreEvents = store.onChanged?.((change) => {
    service.notifyStoreChange?.(change);
  }) ?? (() => {});
  const disposeServiceEvents = service.onChange(() => {
    changes.count += 1;
    changes.lastAt = Date.now();
  });
  ctx.effect(() => () => {
    try {
      disposeStoreEvents();
    } catch { /* 卸载期清理失败不应打断取消流程 */ }
    try {
      disposeServiceEvents();
    } catch { /* 同上 */ }
  }, 'worktodo: store change events');

  // ---- agent 工具（可选服务）----
  // 工具注册的结果记在这里，并报给 /worktodo/health：工具是最容易「静默失败」的一环
  //（平台包解析不到、schema 被拒、模块 generation 过期），没有这个字段就只能靠猜。
  const toolState = { status: 'pending', registered: 0, names: [], error: null };
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      let dispose = () => {};
      let cancelled = false;
      // 动态导入：@deepseek-ai/dsh-tools 解析不到时只失去工具能力，面板照常工作
      import('../src/tools.mjs')
        .then((mod) => mod.registerWorkTodoTools({ ctx: toolCtx, service, logger }))
        .then((registered) => {
          const disposeTools = registered?.dispose;
          if (cancelled) {
            disposeTools?.();
            return;
          }
          dispose = disposeTools ?? (() => {});
          toolState.status = 'registered';
          toolState.names = registered?.names ?? [];
          toolState.registered = toolState.names.length;
        })
        .catch((error) => {
          toolState.status = 'failed';
          toolState.error = String(error?.message ?? error);
          logger?.warn?.(`worktodo 工具未注册（仅面板可用）：${toolState.error}`);
        });
      return () => {
        cancelled = true;
        try {
          dispose?.();
        } catch { /* 卸载期清理失败不应打断取消流程 */ }
      };
    }, 'worktodo: agent tools');
  });

  // ---- 版本与更新（后台、不阻塞任何请求）----
  const updateConfig = normalizeUpdateConfig(config);
  let updateState = { at: 0, latest: null, error: null };
  /** 已落盘、但当前进程还没加载的版本（成功升级后填；用于「重启 DSH 生效」与 hasUpdate 重算）。 */
  let installedVersion = null;
  /**
   * 自升级状态机。为什么要有状态而不是「promise 一把梭」：
   * 面板要能轮询进度、要能查上次为什么失败、要能在多标签页/连点下**只跑一次**。
   */
  const updateRun = {
    state: 'idle', from: PLUGIN_VERSION, to: null, startedAt: null, finishedAt: null,
    command: null, logTail: [], error: null, reason: null,
  };
  /** 自动升级防重入：同一个 latest 版本只自动尝试一次（失败也不反复打扰）。 */
  let autoAttempted = null;

  /** 完整状态（GET /worktodo/update 用；含日志尾部）。 */
  const updateStatus = () => ({
    state: updateRun.state,
    from: updateRun.from,
    to: updateRun.to,
    startedAt: updateRun.startedAt,
    finishedAt: updateRun.finishedAt,
    command: updateRun.command,
    logTail: [...updateRun.logTail],
    error: updateRun.error,
    reason: updateRun.reason,
    installed: installedVersion,
    autoUpdate: updateConfig.autoUpdate,
    registry: updateConfig.updateRegistry,
    timeoutMs: updateConfig.updateTimeoutMs,
  });
  /** 摘要（放进 /list 载荷）：列表是高频轮询，日志尾部只走 GET /worktodo/update。 */
  const updateRunSummary = () => ({
    state: updateRun.state,
    from: updateRun.from,
    to: updateRun.to,
    startedAt: updateRun.startedAt,
    finishedAt: updateRun.finishedAt,
    error: updateRun.error,
    reason: updateRun.reason,
    installed: installedVersion,
  });

  /**
   * 收子进程输出到日志尾部。
   * 只留最后 40 行 / 4000 字符：安装日志可以很长，而这个状态接口会被面板轮询。
   */
  const pushUpdateLog = (chunk) => {
    const text = String(chunk ?? '');
    if (!text) return;
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) updateRun.logTail.push(line.slice(0, 500));
    }
    if (updateRun.logTail.length > UPDATE_LOG_TAIL_LINES) {
      updateRun.logTail.splice(0, updateRun.logTail.length - UPDATE_LOG_TAIL_LINES);
    }
    let total = updateRun.logTail.reduce((sum, line) => sum + line.length, 0);
    while (total > UPDATE_LOG_TAIL_CHARS && updateRun.logTail.length > 1) {
      total -= updateRun.logTail.shift().length;
    }
  };

  /**
   * 查 registry 最新版。缓存 6 小时；`force` 用于升级成功后立刻重算 hasUpdate。
   * 失败静默（只记 error 字段），绝不让网络问题影响面板。
   */
  const refreshUpdate = async ({ force = false } = {}) => {
    if (UPDATE_CHECK_OFF) return updateState;
    const now = Date.now();
    if (!force && updateState.at && now - updateState.at < UPDATE_TTL_MS) return updateState;
    updateState = { ...updateState, at: now }; // 先占位，避免并发重复请求
    try {
      const base = updateConfig.updateRegistry.replace(/\/+$/, '');
      const res = await fetch(`${base}/${PACKAGE_NAME}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const latest = String(body?.['dist-tags']?.latest ?? '');
      updateState = { at: now, latest: /^\d+\.\d+\.\d+$/.test(latest) ? latest : null, error: null };
    } catch (error) {
      updateState = { at: now, latest: null, error: String(error?.message ?? error) };
    }
    maybeAutoUpdate();
    return updateState;
  };

  /**
   * 执行一次升级。**不并发**：已经在跑就直接返回 running。
   * 所有失败都带稳定 reason 返回，不抛异常（路由与自动升级都靠它）。
   */
  const startUpdate = async () => {
    if (updateRun.state === 'running') return { ok: true, running: true, ...updateStatus() };

    const profileDir = await findProfileDir().catch(() => null);
    if (!profileDir) {
      updateRun.state = 'failed';
      updateRun.finishedAt = Date.now();
      updateRun.reason = 'profile-not-found';
      updateRun.error = '找不到 DSH profile 目录（$DSH_HOME/profiles），无法确定要升级哪一份安装';
      return { ok: false, reason: 'profile-not-found', message: updateRun.error };
    }
    const spec = readProfileDependency(profileDir);
    if (spec === null) {
      updateRun.state = 'failed';
      updateRun.finishedAt = Date.now();
      updateRun.reason = 'not-installed';
      updateRun.error = `该 profile 的 package.json 里没有 ${PACKAGE_NAME} 依赖（${profileDir}）`;
      return { ok: false, reason: 'not-installed', message: updateRun.error };
    }
    // `link:` 是本地链接安装（开发场景）：升级命令会把它换成 registry 上的包，
    // 等于把开发工作流拆掉。**一个子进程都不许起**，直接把原因交回面板。
    if (spec.startsWith('link:')) {
      updateRun.state = 'idle';
      updateRun.reason = 'linked';
      updateRun.error = '这是本地链接安装（link:），请在仓库里用 git/pnpm 工作流更新，不要用自动升级';
      return { ok: false, reason: 'linked', message: updateRun.error };
    }

    const updater = resolveUpdater();
    const profileName = basename(profileDir);
    const command = buildUpdateCommand(updater, profileName, updateConfig.updateRegistry);

    updateRun.state = 'running';
    updateRun.from = PLUGIN_VERSION;
    updateRun.to = updateState.latest ?? null;
    updateRun.startedAt = Date.now();
    updateRun.finishedAt = null;
    updateRun.command = command.display;
    updateRun.logTail = [];
    updateRun.error = null;
    updateRun.reason = null;

    /** 幂等收口：超时与退出会竞争，只认第一个结论。 */
    const finish = (state, extra = {}) => {
      if (updateRun.state !== 'running') return;
      updateRun.state = state;
      updateRun.finishedAt = Date.now();
      if (extra.reason) updateRun.reason = extra.reason;
      if (extra.error !== undefined) updateRun.error = extra.error;
      if (state === 'done') {
        // 用**落盘的版本**而不是「退出码 0」判断：profile 里 pin 死规格时命令也可能「成功」却没升上去
        const installed = readInstalledVersion(profileDir) ?? updateState.latest ?? null;
        if (installed) installedVersion = installed;
        updateRun.to = installed ?? updateRun.to;
        updateRun.error = null;
        updateRun.reason = null;
        if (!UPDATE_CHECK_OFF) void refreshUpdate({ force: true });
      }
    };

    let child = null;
    try {
      child = spawn(updater.command, command.args, {
        cwd: profileDir,
        env: { ...process.env, ...updater.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish('failed', { reason: 'spawn-failed', error: `无法启动升级命令：${String(error?.message ?? error)}` });
      return { ok: false, reason: 'spawn-failed', message: updateRun.error };
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // 先杀进程再落状态：不杀的话用户会看到「失败」而那个 pnpm 还在后台改 node_modules
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      finish('failed', { reason: 'timeout', error: `升级超时（${updateConfig.updateTimeoutMs}ms）已终止` });
    }, updateConfig.updateTimeoutMs);
    timer?.unref?.(); // 测试环境里不要因为这个定时器挂住事件循环

    child.stdout?.on('data', pushUpdateLog);
    child.stderr?.on('data', pushUpdateLog);
    child.on('error', (error) => {
      clearTimeout(timer);
      finish('failed', { reason: 'spawn-failed', error: `无法启动升级命令：${String(error?.message ?? error)}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return; // 结论已由超时路径给出
      if (code === 0) finish('done');
      else {
        finish('failed', {
          reason: 'exit-nonzero',
          error: `安装命令退出码 ${code ?? 'null'}${signal ? `（信号 ${signal}）` : ''}`,
        });
      }
    });

    return { ok: true, running: true, ...updateStatus() };
  };

  /**
   * 自动升级（仅当用户显式把 config.autoUpdate 设为 true）。
   *
   * 三条纪律：后台异步（`void`，绝不阻塞请求）、同一个版本只试一次、失败只记日志。
   * 默认 false —— 没让用户点过就动他的安装，是比「不升级」更糟的失败模式。
   */
  const maybeAutoUpdate = () => {
    if (UPDATE_CHECK_OFF) return;
    const latest = updateState.latest;
    // 触发条件抽成纯函数（shouldAutoUpdate），好让「默认不开 / 不重入 / 同版本只试一次」可单测
    if (!shouldAutoUpdate({
      enabled: updateConfig.autoUpdate,
      latest,
      current: installedVersion ?? PLUGIN_VERSION,
      runState: updateRun.state,
      attempted: autoAttempted,
    })) return;
    autoAttempted = latest;
    void startUpdate()
      .then((result) => {
        if (result?.ok === false) {
          logger?.warn?.(`自动升级未执行（只记日志，不打扰用户）：${result.reason} ${result.message ?? ''}`);
        }
      })
      .catch((error) => logger?.warn?.(`自动升级失败（只记日志，不打扰用户）：${error?.message ?? error}`));
  };

  const updatePayload = () => {
    const latest = updateState.latest;
    // hasUpdate 以**实际安装的版本**为准：升级完成（0.2.4 已落盘但进程里还是 0.2.0）后
    // 不该再亮「有新版本」，而应该提示「重启 DSH 生效」。
    const current = installedVersion ?? PLUGIN_VERSION;
    return {
      current: PLUGIN_VERSION,
      latest: latest ?? undefined,
      hasUpdate: Boolean(latest) && !UPDATE_CHECK_OFF && compareVersion(latest, current) > 0,
      restartRequired: Boolean(installedVersion) && compareVersion(installedVersion, PLUGIN_VERSION) > 0,
      installed: installedVersion ?? undefined,
      page: `https://www.npmjs.com/package/${PACKAGE_NAME}`,
      run: updateRunSummary(),
    };
  };
  if (!UPDATE_CHECK_OFF) void refreshUpdate(); // 启动时后台查一次（失败静默）

  // ---- 给模型的用法指引（可选服务；缺 systemPrompt 时静默跳过）----
  ctx.inject(['systemPrompt'], (spCtx) => {
    spCtx.effect(() => {
      if (typeof spCtx.systemPrompt?.section !== 'function') return () => {};
      let disposeSection = () => {};
      try {
        disposeSection = spCtx.systemPrompt.section({
          name: 'worktodo:guidance',
          order: 3050,
          text: GUIDANCE_TEXT,
        }) ?? (() => {});
        logger?.info?.('已注册给模型的用法指引（systemPrompt.section）');
      } catch (error) {
        // 段落注册失败不影响工具与面板；只记一行，方便排查
        logger?.warn?.(`用法指引注册失败：${error?.message ?? error}`);
      }
      return () => { try { disposeSection?.(); } catch { /* 卸载清理失败不打断 */ } };
    }, 'worktodo: system prompt guidance');
  });

  // ---- HTTP 路由（可选服务）----
  ctx.inject(['webServer'], (webCtx) => {
    /**
     * 路由准入：webServer 自身不做鉴权，复用 connection 的 Host/Origin 围栏 + 浏览器认证。
     * 本插件有写操作，这道围栏是必须的（与 dsh-token-meter-panel 同一策略）。
     */
    const guarded = (handler) => async (request, response) => {
      const connection = ctx.get?.('connection');
      let rejection;
      try {
        rejection = connection?.requestRejection?.(request);
      } catch {
        rejection = undefined;
      }
      if (rejection !== undefined) {
        response.writeHead(rejection);
        response.end();
        return;
      }
      return handler(request, response);
    };

    /**
     * 业务执行 + 统一错误收口（从 method() 里抽出来，供「一个路径两个动词」的路由复用）。
     * @param {string} label 日志用的一句话
     * @param {(request: any, response: any) => Promise<any>} handler
     */
    const attempt = (label, handler) => async (request, response) => {
      try {
        await handler(request, response);
      } catch (error) {
        logger?.warn?.(`${label} 失败：${error?.stack ?? error}`);
        // S4-2/S4-3：请求体读取失败（超时 408 / 过大 413 / 未读完 400）必须给调用方一个
        // **明确的状态码与原因**。旧行为是 `request.destroy()` 直接掐断 → 客户端只看到
        // ECONNRESET，用户/面板看不到「请求体过大」这种具体话。
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 200;
        if (status !== 200 && !response.headersSent) {
          sendJson(response, status, {
            ok: false,
            reason: error?.reason ?? 'bad-request',
            error: String(error?.message ?? error),
          });
          return;
        }
        sendJson(response, 200, { ok: false, reason: 'internal', error: String(error?.message ?? error) });
      }
    };

    /** 只接受指定方法的包装。 */
    const method = (verb, handler) => guarded(async (request, response) => {
      if (request.method !== verb) {
        response.writeHead(405, { allow: verb });
        response.end();
        return;
      }
      return attempt(`${verb} ${request.url}`, handler)(request, response);
    });

    /**
     * 一个路径接受多个动词的包装（只有自升级路由需要：GET 查状态、POST 触发）。
     * 405 的 allow 头把两个动词都列出来，调用方不用猜。
     */
    const anyMethod = (verbs, handler) => guarded(async (request, response) => {
      if (!verbs.includes(request.method)) {
        response.writeHead(405, { allow: verbs.join(', ') });
        response.end();
        return;
      }
      return attempt(`${request.method} ${request.url}`, handler)(request, response);
    });

    /** 把服务的显式状态原样交给前端：ok=false 也走 200，让面板能显示原因。 */
    const reply = (response, result) => {
      if (result?.ok) sendJson(response, 200, { ok: true, data: result });
      else sendJson(response, 200, { ok: false, reason: result?.reason ?? 'unknown', error: result?.message ?? '操作失败' });
    };

    // S1-1（第四轮审计）：**逐条注册、成功一条就立刻把 disposer 入栈**。
    //
    // 旧写法是 `const disposers = [ register(a), register(b), … ]` 一个数组字面量：
    // 第 N 条 register 抛错时，前 N-1 条已经进了 webServer 的**服务级**路由表，
    // 而 effect 回调中途抛出 → 清理函数从未返回 → 那些路由永久残留、没有 disposer；
    // 紧接着 apply reject（工具与路由全没），此后**每一次挂载**（哪怕完全正常）
    // 都会在第 1 条就撞真实 DSH 的 `duplicate exact route` → 只能重启 DSH 才能恢复。
    //
    // 现在：单条注册失败只记一行 warn、丢这一条；回调**一定**返回清理函数；
    // 任何情况下都不会让 apply 因为路由注册失败而 reject。
    const disposers = [];

    /** 幂等清理：effect 卸载与 inject 回调返回的 disposer 都会走这里（splice 保证只跑一次）。 */
    const disposeRoutes = () => {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose?.();
        } catch { /* 卸载期清理失败不应打断取消流程 */ }
      }
    };

    /** 注册一条路由；成功即入栈，失败只降级丢这一条。 */
    const addRoute = (route) => {
      try {
        const dispose = webCtx.webServer.register(route);
        if (typeof dispose === 'function') disposers.push(dispose);
        else if (dispose && typeof dispose.dispose === 'function') disposers.push(() => dispose.dispose());
      } catch (error) {
        logger?.warn?.(`路由 ${route?.path} 注册失败（只丢这一条，面板其余功能与工具不受影响）：${error?.message ?? error}`);
      }
    };

    try {
      webCtx.effect(() => {
        // 读：列表 + 分组 + 统计
        addRoute({
          kind: 'exact',
          path: `${ROUTE_BASE}/list`,
          handler: method('GET', async (request, response) => {
            const url = new URL(request.url ?? ROUTE_BASE, 'http://localhost');
            if (!UPDATE_CHECK_OFF && Date.now() - updateState.at >= UPDATE_TTL_MS) void refreshUpdate();
            const result = await service.list({
              filter: url.searchParams.get('filter') ?? 'open',
              project: url.searchParams.get('project') ?? undefined,
              query: url.searchParams.get('query') ?? undefined,
              sort: url.searchParams.get('sort') ?? undefined,
              // S3-3：面板可选择只要一种视图（shapes=todos|groups|projectGroups|both）
              shapes: url.searchParams.get('shapes') ?? undefined,
            });
            reply(response, result.ok
              ? { ...result, version: PLUGIN_VERSION, update: updatePayload() }
              : result);
          }),
        });
        // 写：手动排序（拖动）。body: { ids: [待办 id，按新顺序排列] }
        addRoute({
          kind: 'exact',
          path: `${ROUTE_BASE}/reorder`,
          handler: method('POST', async (request, response) => {
            const body = await readJsonBody(request);
            reply(response, await service.reorder(body));
          }),
        });
        // 写：新增
        addRoute({
          kind: 'exact',
          path: `${ROUTE_BASE}/create`,
          handler: method('POST', async (request, response) => {
            const body = await readJsonBody(request);
            reply(response, await service.create(body, { source: 'human' }));
          }),
        });
        // 一个路径两个动词（**不新增路由**，否则会与既有的「改待办」撞 duplicate route）：
        //   GET  /worktodo/update → 自升级状态（idle/running/done/failed）
        //   POST /worktodo/update → 要么触发自升级（`{}` 或 `{action:'plugin-update'}`），
        //                          要么按老语义改一条待办（带 ref/id/任何 patch 字段）
        // 为什么不做成两个路径：老客户端与文档里 POST /worktodo/update 已经是「改待办」，
        // 改路径会静默打断它；同名路径重复注册在真实 webServer 上会直接抛 duplicate route。
        addRoute({
          kind: 'exact',
          path: `${ROUTE_BASE}/update`,
          handler: anyMethod(['GET', 'POST'], async (request, response) => {
            if (request.method === 'GET') {
              sendJson(response, 200, { ok: true, data: updateStatus() });
              return;
            }
            const body = await readJsonBody(request);
            if (isPluginUpdateRequest(body)) {
              reply(response, await startUpdate());
              return;
            }
            const { ref, id, ...patch } = body;
            // 清空语义：due/project 传空串或 null 都表示「不要截止日期 / 去掉项目」
            for (const key of ['due', 'project']) {
              if (patch[key] === '' || patch[key] === null) patch[key] = null;
            }
            reply(response, await service.update(ref ?? id, patch));
          }),
        });
        // 写：状态（勾选框）
        addRoute({
          kind: 'exact',
          path: `${ROUTE_BASE}/status`,
          handler: method('POST', async (request, response) => {
            const body = await readJsonBody(request);
            if (body.toggle) reply(response, await service.toggle(body.ref ?? body.id));
            else reply(response, await service.setStatus(body.ref ?? body.id, body.status));
          }),
        });
        // 写：删除
        addRoute({
          kind: 'exact',
          path: `${ROUTE_BASE}/remove`,
          handler: method('POST', async (request, response) => {
            const body = await readJsonBody(request);
            reply(response, await service.remove(body.ref ?? body.id));
          }),
        });
        // 写：把当前会话的 todos 提升为工作待办（面板读 todos 投影后把内容发过来）
        addRoute({
          kind: 'exact',
          path: `${ROUTE_BASE}/adopt`,
          handler: method('POST', async (request, response) => {
            const body = await readJsonBody(request);
            reply(response, await service.adopt(body.todos ?? []));
          }),
        });
        // 自检：装完用它确认宿主半侧真的活着、数据落在哪、工具注册上了没有
        addRoute({
          kind: 'exact',
          path: `${ROUTE_BASE}/health`,
          handler: method('GET', async (_request, response) => {
            // 读不出来时**不能**报 count: 0 —— 那是「你的待办真的没了」的错误信号（复审 R4 / F16）。
            // 显式给 count: null + countError，让排查者一眼分清「空列表」与「存储读失败」。
            const snapshot = await service.all()
              .then((todos) => ({ todos, error: null }))
              .catch((error) => ({ todos: null, error: String(error?.message ?? error) }));
            sendJson(response, 200, {
              ok: true,
              plugin: name,
              // 运行中的实际版本：排查「我改的代码生效了没」时看这里
              //（link: 安装的源码改动需要重启才会换模块 generation）
              version: PLUGIN_VERSION,
              store: service.describe(),
              // 变更通知是否真的接通了（原来 onChanged/onChange 是死代码，面板不刷新）
              changes: { count: changes.count, lastAt: changes.lastAt },
              // 工具是最容易静默失败的一环，所以把注册结果显式报出来
              tools: toolState,
              // count 为 null = 读失败（不是 0 条）；原因在 countError 里
              count: snapshot.todos ? snapshot.todos.length : null,
              countError: snapshot.error,
              toolsService: Boolean(ctx.get?.('tools')),
              webServerService: Boolean(ctx.get?.('webServer')),
              storageDomainService: Boolean(ctx.get?.('storageDomain')),
            });
          }),
        });
        // 回调**必须**返回清理函数：这样单条注册中途失败也不会留下没有 disposer 的服务级路由
        return disposeRoutes;
      }, 'worktodo: http routes');
    } catch (error) {
      // 连 effect 都没挂上（例如 effect 实现本身抛错）：把已经注册成功的那几条立刻收干净，
      // 绝不留服务级残留去毒化下一次挂载；同时绝不让这个异常冒到 apply。
      logger?.warn?.(`HTTP 路由注册整体失败（面板不可用，工具不受影响）：${error?.message ?? error}`);
      disposeRoutes();
    }

    // cordis 的 `inject` 回调（plugin apply）返回值同样会被收集成 disposer —— 再兜一层。
    return disposeRoutes;
  });

  logger?.info?.(`mounted (store=${store.kind})`);
}
