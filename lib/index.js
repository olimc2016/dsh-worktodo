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
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
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
 * 升级相关配置的归一化（导出供单测）。
 *
 * `autoUpdate` 默认 **true**：用户明确要求「装的插件默认就要能自己更新」，所以不配置也自动升级；
 * 只有**字面量** `autoUpdate: false` 才完全关掉（`undefined`/`'no'`/`0` 一律按默认开——
 * 配置里一个手滑的 falsy 值不该静默关掉用户要的自动更新）。`link:` 安装永远不自动动，
 * 所以默认开不会拆掉开发工作流（见 startUpdate 里的 linked 分支）。
 * registry 默认官方源、超时给一个有限值；非法值一律回落，绝不让 bad config 把路由打崩。
 * @param {object} [config] cordis 组合配置
 */
export function normalizeUpdateConfig(config) {
  const autoUpdate = config?.autoUpdate !== false;
  const rawRegistry = typeof config?.updateRegistry === 'string' ? config.updateRegistry.trim() : '';
  const updateRegistry = rawRegistry || OFFICIAL_REGISTRY;
  const rawTimeout = Number(config?.updateTimeoutMs);
  // 下限 100ms：再小的值连 spawn 都来不及，只会制造「永远是超时」的假故障
  const updateTimeoutMs = Number.isFinite(rawTimeout) && rawTimeout >= 100
    ? Math.min(rawTimeout, 3600000)
    : DEFAULT_UPDATE_TIMEOUT_MS;
  return { autoUpdate, updateRegistry, updateTimeoutMs };
}

/**
 * 面板相关配置的归一化。
 *
 * `celebrate` 默认 **true**（勾选完成时的短动效）；只有用户显式写 `celebrate: false`
 * 才关掉。默认开是刻意的：动效本身很短且可被 `prefers-reduced-motion` 跳过，
 * 而「默认关」会让绝大多数人根本不知道有这个开关。
 *
 * 归一化只回布尔，非法值一律回落 true —— bad config 绝不能让面板渲染出错。
 * @param {object} [config] cordis 组合配置
 * @returns {{celebrate: boolean}}
 */
export function normalizePanelConfig(config) {
  return { celebrate: config?.celebrate !== false };
}

/** profile 清单里可能放本包依赖的两个段位（dependencies 优先，与旧口径一致）。 */
const DEP_SECTIONS = ['dependencies', 'devDependencies'];

/** 异常消息的稳定文本（各处 error 文案都用它）。 */
function messageOf(error) {
  return String(error?.message ?? error);
}

/** 读文件，失败返回 null（用于「只探测、不写盘」的比较）。 */
function tryReadFile(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 文件权限位（拿不到就 null，交给 writeFileAtomicSync 用默认值）。 */
function fileMode(file) {
  try {
    return statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

/**
 * 原子写一个文本文件：同目录临时文件 → `write` → `fsync` → `rename`。
 *
 * 为什么必须这样（独立审查 A1）：`writeFileSync(file, text)` 先 `O_TRUNC` 再写，
 * 中途失败（磁盘满 `ENOSPC` / 超出 `RLIMIT_FSIZE` / 进程被杀）会留下**半个文件**——
 * 实测在 `ulimit -f 1` 下 profile `package.json` 2183 → 1024 字节，
 * `JSON.parse` 报 `Unterminated string`，**下一次 DSH 启动解析该 profile 直接失败**。
 *
 * 这里保证：任何失败都只影响临时文件（写完 `rename` 之前原文件一个字节都不动），
 * `rename(2)` 在同一目录内是原子的，所以目标文件要么是旧内容、要么是新内容，绝不半截。
 * 失败时清理临时文件并向上抛，由调用方决定怎么报告。
 * @param {string} file 目标文件
 * @param {string} text 完整内容
 * @param {{mode?: number|null}} [options] 目标权限（默认沿用现有文件的 mode）
 */
export function writeFileAtomicSync(file, text, { mode = null } = {}) {
  const dir = dirname(file);
  const tmp = join(dir, `.${basename(file)}.worktodo-tmp-${process.pid.toString(36)}-${Date.now().toString(36)}`);
  const targetMode = mode ?? fileMode(file);
  let fd = null;
  try {
    fd = openSync(tmp, 'wx', targetMode ?? 0o644);
    const buffer = Buffer.from(String(text), 'utf8');
    let written = 0;
    while (written < buffer.length) {
      // `fs.writeSync(fd, string)` 只做**一次** write(2) 且返回实际写入的字节数：
      // 磁盘满 / 超出 RLIMIT_FSIZE 时它会「成功地」只写一半（本机 ulimit -f 1 实测返回 1024/2003
      // 且不抛错）。所以必须自己循环并校验进度，否则 rename 上去的是一份**被截断的文件** ——
      // 那正是 A1 要防的事故。
      const n = writeSync(fd, buffer, written, buffer.length - written);
      if (!(n > 0)) throw new Error(`写入中止（已写 ${written}/${buffer.length} 字节）`);
      written += n;
    }
    fsyncSync(fd); // 先落盘再 rename：否则崩溃后可能 rename 了一个内容还在页缓存里的空文件
    closeSync(fd);
    fd = null;
    if (targetMode !== null) {
      try { chmodSync(tmp, targetMode); } catch { /* 权限收紧失败不影响内容正确性 */ }
    }
    renameSync(tmp, file);
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* 已关闭 */ }
    }
    try { unlinkSync(tmp); } catch { /* 临时文件可能根本没建出来 */ }
    throw error;
  }
}

/**
 * 读 profile 清单的**原始文本**（不写盘）。
 *
 * A1 的硬前提：**读不到或解析不出合法 JSON 时，绝不允许任何写操作**。
 * 旧实现 `readFileSync → JSON.parse → writeFileSync(同一路径)` 在解析失败时直接抛给调用方，
 * 调用方只记一个 `pin-failed`；而写失败时用户的清单已经被截断。
 *
 * `kind` 区分「读不到」与「不是合法 JSON」（问题 2）：上层要按**真实原因**说话，
 * 绝不能把这两种都报成「没有 dsh-worktodo 依赖」。
 * @returns {{ok: boolean, kind: 'unreadable'|'invalid-json'|null, file: string, text: string|null, pkg: object|null, error: string|null}}
 */
function readProfileManifest(profileDir) {
  const file = join(profileDir, 'package.json');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, kind: 'unreadable', file, text: null, pkg: null, error: `读不到 ${file}：${messageOf(error)}` };
  }
  try {
    return { ok: true, kind: null, file, text, pkg: JSON.parse(text), error: null };
  } catch (error) {
    return { ok: false, kind: 'invalid-json', file, text: null, pkg: null, error: `${file} 不是合法 JSON：${messageOf(error)}` };
  }
}

/**
 * profile 里所有段位的 `{section, key, rawValue}` 三元组（A3）。
 *
 * 为什么是三元组而不是一个 `originalSpec`：旧代码把「第一个命中字段的原值」同时写回
 * `dependencies` 与 `devDependencies`，于是 `devDependencies.dsh-worktodo = "link:…"`
 * 被静默冲成 `"^0.2.0"`（实测复现）。回滚必须按原键位原样还原。
 */
export function readProfileSpecEntries(profileDir) {
  const manifest = readProfileManifest(profileDir);
  if (!manifest.ok) return [];
  return specEntriesFromPkg(manifest.pkg);
}

/** 纯函数：从已解析的清单里取出所有段位的 `{section, key, rawValue}`（避免二次读盘 / TOCTOU）。 */
export function specEntriesFromPkg(pkg) {
  const entries = [];
  for (const section of DEP_SECTIONS) {
    const deps = pkg?.[section];
    if (deps && typeof deps === 'object' && Object.prototype.hasOwnProperty.call(deps, PACKAGE_NAME)) {
      entries.push({ section, key: PACKAGE_NAME, rawValue: deps[PACKAGE_NAME] });
    }
  }
  return entries;
}

/**
 * `pnpm add` 是否要带 `--save-dev`（问题 3：**按原段位**写回）。
 *
 * 若某个 profile 只把本包放在 `devDependencies`，不带 `--save-dev` 的 `pnpm add` 会把它
 * **迁到 `dependencies`**（段位迁移）。两处都有时优先 `dependencies`（运行期依赖），
 * 即不加 `--save-dev`，并在报告里说明这一取舍。
 * @param {Array<{section: string}>} entries
 * @returns {boolean}
 */
export function shouldSaveDev(entries) {
  const sections = new Set((entries ?? []).map((entry) => entry.section));
  return sections.has('devDependencies') && !sections.has('dependencies');
}

/** 直接读一个 profile 目录里 `dsh-worktodo` 的依赖规格（没有就返回 null）。 */
export function readProfileDependency(profileDir) {
  const entries = readProfileSpecEntries(profileDir);
  const found = entries.find((entry) => typeof entry.rawValue === 'string' && entry.rawValue.trim());
  return found ? found.rawValue.trim() : null;
}

/**
 * 本地协议规格（`link:` / `file:` / `workspace:`）：这是开发工作流，升级命令会把它换成
 * registry 上的包。**任一**段位出现本地协议就整体不自动升级（A3：旧守卫只看第一个命中的字段，
 * `devDependencies` 里的 `link:` 根本拦不住）。
 */
export function isLocalSpec(value) {
  return typeof value === 'string' && /^(link:|file:|workspace:)/.test(value.trim());
}

/**
 * 读 profile 里**已落盘**的插件版本（升级成功后用它判断版本到底换没换，而不是靠「命令没报错」）。
 *
 * 读盘失败（没有 profile / 还没装 / 权限 / 半写 / JSON 坏）一律返回 `null`：
 * 这个值会进 `/list` 载荷，任何异常都不许把面板的列表请求带崩。
 * @param {string|null|undefined} profileDir
 * @returns {string|null}
 */
function readInstalledVersion(profileDir) {
  if (!profileDir) return null;
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
 * 同步解析「本实例自己所在的 profile 目录」（返回 null 表示反推不出来）。
 *
 * 与 findProfileDir 同一套口径，只是同步：`/list` 的 update 载荷要**每次**都读一眼落盘版本
 * （用户可能在 DSH 运行期间手动装了新版，或后台升级刚写完盘），不能为一次小文件读盘
 * 把整个列表请求改成异步。这里只做纯字符串切分与一次性注入读取，不写盘、不猜别的 profile。
 * @returns {string|null}
 */
function resolveOwnProfileDir() {
  const injected = process.env.WORKTODO_PROFILE_DIR;
  if (injected && injected.trim()) return resolve(injected.trim().replace(/^~(?=$|[/\\])/, homedir()));
  return profileDirFromModuleUrl(import.meta.url);
}

/**
 * 找到要升级的那个 profile 目录 —— **只认「本实例自己所在的 profile」**。
 *
 * 顺序：显式注入（`WORKTODO_PROFILE_DIR`，测试缝 + 高级用户覆盖）→ 本模块自身的路径
 * `.../profiles/<name>/node_modules/dsh-worktodo/lib/index.js`（registry 安装时最精确）。
 *
 * 为什么删掉了旧的「扫 `$DSH_HOME/profiles/*` 取字典序第一个依赖了本包的 profile」与
 * `desktop` 兜底（独立审查 A5）：升级会**改写那份 profile 的 package.json 并跑 pnpm install**，
 * 而反推不出 profile 时（典型是 `link:` 装载的开发实例）扫描会挑到**别人的** profile ——
 * 实测 `$DSH_HOME/profiles/{aaa,zzz}` 场景下被改写的是 `aaa`，运行中的 `zzz` 反而没被碰。
 * 现在：反推不出来就返回 null，上层以 `profile-not-found` 收口，**零写盘、零子进程**。
 * @returns {Promise<string|null>}
 */
async function findProfileDir() {
  // 保持 async 签名（调用方 await，且将来可能换实现），解析逻辑复用同一份同步口径
  return resolveOwnProfileDir();
}

/**
 * 选定 CLI 执行器（拿不到返回 null）。
 *
 * 首选官方 CLI：它自带 Desktop 的 pnpm 与 profile 管理语义（`dsh plugin --profile X add ...`），
 * 路径从宿主进程自身推导（Electron：`process.resourcesPath` / `process.execPath` 旁的
 * `Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`）。
 * 测试缝：`WORKTODO_UPDATE_CLI`（强制 CLI 脚本路径）。
 */
function resolveCliUpdater() {
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
  if (!cli) return null;
  return {
    kind: 'cli',
    // ELECTRON_RUN_AS_NODE：Electron 二进制要按 Node 跑脚本（与 runtime/cli/bin/dsh 同款）
    command: process.execPath,
    args: ['--expose-internals', cli],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    label: 'dsh plugin',
  };
}

/**
 * 选定 pnpm 执行器（**始终**返回一个，绝不返回 null）。
 *
 * 为什么单独抽出来：升级序列的第 2/3 步要用 pnpm（用户实测有效的是在 profile 目录里
 * `pnpm update`，以及由 pnpm 自己改写规格的 `pnpm add <pkg>@<精确版本> --save-exact`），
 * 即使第 1 步优先走了 CLI。测试缝：`WORKTODO_PNPM_PATH`。
 */
function resolvePnpmUpdater() {
  const pnpmOverride = process.env.WORKTODO_PNPM_PATH;
  if (pnpmOverride && pnpmOverride.trim()) {
    return { kind: 'pnpm', command: pnpmOverride.trim(), args: [], env: {}, label: 'pnpm' };
  }
  const resources = typeof process.resourcesPath === 'string' ? process.resourcesPath : null;
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

/** 升级首选执行器：官方 CLI 优先，拿不到才退回 pnpm（既有行为不变）。 */
function resolveUpdater() {
  return resolveCliUpdater() ?? resolvePnpmUpdater();
}

/**
 * 测试缝：注入「已知最新版」，让自动更新与精确改写不必真打 registry。
 *
 * 为什么需要：全量测试按约定带 `WORKTODO_NO_UPDATE_CHECK=1`（单元测试不该联网），
 * 而「第 3 步让 pnpm 装 registry 上的精确版本」需要一个 latest。这个缝只在**显式设置**时生效，
 * 不设就完全走生产路径（真实查询），所以不会在生产里制造第二种行为。
 * 非法值（空、非 semver）一律忽略。
 * @returns {string|null}
 */
function injectedLatest() {
  const raw = process.env.WORKTODO_UPDATE_LATEST;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const version = raw.trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

/**
 * 升级是否**真的**发生了：看落盘的 node_modules 版本，而不是命令的退出码。
 * 真机上 `dsh plugin add dsh-worktodo@0.2.5` 退出码 0、却什么都没换，所以这里必须比版本。
 */
function installedVersionChanged(before, after) {
  if (!after) return false; // 读不到落盘版本 = 不能声称升级成功
  if (!before) return true; // 原来根本没装，现在装上了
  return compareVersion(after, before) !== 0;
}

/**
 * 自动升级「跨重启节流」状态文件的位置（A4）。纯函数，导出供单测。
 *
 * 默认 `$DSH_HOME/worktodo/update-state.json` —— 放在**插件自己的目录**里，
 * 绝不写进用户待办数据文件（`storages/worktodo.json`、`worktodo/todos.json`）。
 * 测试缝 `WORKTODO_UPDATE_STATE_PATH` 可以指到临时文件，避免测试碰真实 `~/.dsh`。
 * @param {{env?: object, home?: string|null}} [options]
 * @returns {string|null}
 */
export function resolveUpdateStatePath({ env = process.env, home = null } = {}) {
  const override = typeof env?.WORKTODO_UPDATE_STATE_PATH === 'string' ? env.WORKTODO_UPDATE_STATE_PATH.trim() : '';
  if (override) return override;
  return home ? join(home, 'worktodo', 'update-state.json') : null;
}

/** 读「已经自动试过的 latest」。文件缺失/损坏一律安全地当作「没试过」。 */
function readPersistedAttempt(file) {
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const attempted = typeof parsed?.attempted === 'string' ? parsed.attempted.trim() : '';
    return attempted || null;
  } catch {
    return null; // 损坏/缺失 = 当作没试过（宁可多试一次，也不要因为状态文件坏了永远不升级）
  }
}

/** 写状态文件（原子写、失败静默）：它只管节流，坏了也绝不能影响面板、升级本身或 DSH 启动。 */
function persistAttempt(file, payload) {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomicSync(file, `${JSON.stringify(payload)}\n`);
  } catch {
    /* 写不了 = 退化成旧的「只在内存里节流」，不是错误 */
  }
}

/**
 * profile 清单事务（独立审查 A1/A2/A3 的统一收口）。
 *
 * 设计要点：
 *   1. **不再手写 profile JSON**：规格改写由 pnpm `add <pkg>@<精确版本> --save-exact` 完成
 *      （包管理器自己有成熟的原子写与格式处理）。这里只负责「万一盘上被改过，就逐字节还原」。
 *   2. 事务只记**原始字节**（不是 `{section, key, value}` 的集合）——还原即原始文件本身，
 *      所以 `dependencies`/`devDependencies` 的段位、`link:` 协议值、缩进、CRLF、键序全都原样回来
 *      （A3：旧实现把第一个字段的原值写回所有字段，`devDependencies` 里的 `link:` 被冲掉）。
 *   3. 还原也走 `writeFileAtomicSync`：**写失败绝不截断原文件**（A1），失败时明确报「请人工检查」。
 *   4. 读不到 / 解析不出合法 JSON 时 `ok=false`，调用方**零写盘**（A1 的硬前提）。
 * @param {string} profileDir
 */
function createProfileJournal(profileDir) {
  const manifest = readProfileManifest(profileDir);
  const original = manifest.ok ? manifest.text : null;
  const file = manifest.file;
  return {
    ok: manifest.ok,
    kind: manifest.kind,
    file,
    error: manifest.error,
    original,
    /** 盘上内容是否已被本次运行（或外部命令）改过。只读探测，不写盘。 */
    dirty() {
      if (!manifest.ok) return false;
      return tryReadFile(file) !== original;
    },
    /** 盘上内容是否已经不是合法 JSON —— 即便是 done 也要救回来，绝不留非法清单给下次启动。 */
    corrupt() {
      if (!manifest.ok) return false;
      const current = tryReadFile(file);
      if (current === null || current === original) return false;
      try {
        JSON.parse(current);
        return false;
      } catch {
        return true;
      }
    },
    /**
     * 逐字节还原原始清单。未改动时**零写盘**。
     * @returns {{ok: boolean, wrote: boolean, note: string}}
     */
    rollback() {
      if (!manifest.ok) {
        return { ok: true, wrote: false, note: `未改写 profile 清单（读不到内容，按设计不做任何写操作）：${manifest.error}` };
      }
      const current = tryReadFile(file);
      if (current === original) {
        return { ok: true, wrote: false, note: '' };
      }
      try {
        writeFileAtomicSync(file, original, { mode: fileMode(file) });
        // 写后自检：还原必须逐字节一致，否则宁可明确报错也不能声称成功
        if (tryReadFile(file) !== original) throw new Error('还原后内容与原文件不一致');
        return { ok: true, wrote: true, note: `已回滚 profile 规格（逐字节还原 ${basename(file)}）` };
      } catch (error) {
        return { ok: false, wrote: true, note: `回滚失败，请人工检查 ${file}：${messageOf(error)}` };
      }
    },
  };
}

/**
 * 构造升级步骤序列（纯函数，导出供单测）。
 *
 * 顺序（每一步之后都要读落盘版本校验，见 runUpdateSequence）：
 *   1. 有官方 CLI 就先走 CLI（保留既有的「CLI 优先」）；
 *   2. `pnpm update dsh-worktodo --registry <源>`（用户真机实测有效的一条）；
 *   3. 若版本没变 → `pnpm add dsh-worktodo@<精确版本> --save-exact --registry <源>`。
 *
 * 第 3 步为什么是 `add` 而不是「自己改写规格 + install」（A1 首选方案）：
 * 让 pnpm 去维护用户的 `package.json` —— 它有自己的原子写与格式处理，
 * 插件不再需要把「猜测出来的 JSON」写回用户 profile，A1/A3 的整类事故从根上消失。
 * 所有命令都显式带 `--registry`（默认官方源，可 config 覆盖），否则会被镜像/缓存挡住。
 * @param {object} input
 * @param {{args: string[]}|null} input.cli 官方 CLI 执行器（拿不到就 null）
 * @param {{args: string[]}} input.pnpm pnpm 执行器
 * @param {string} input.profileName profile 目录名
 * @param {string} input.registry 生效的 registry
 * @param {string|null} input.target 精确目标版本（registry 的 dist-tags.latest）
 * @param {boolean} [input.saveDev] 规格原本在 `devDependencies` → `pnpm add` 必须带 `--save-dev`，
 *   否则 pnpm 默认会把这个包迁到 `dependencies`（问题 3：段位迁移）
 * @returns {Array<{kind: string, display: string, args: string[], requiresTarget?: boolean}>}
 */
export function buildUpdateSteps({ cli, pnpm, profileName, registry, target, saveDev = false }) {
  const steps = [];
  if (cli) {
    steps.push({
      kind: 'cli-add-latest',
      args: [...cli.args, 'plugin', '--profile', profileName, 'add', `${PACKAGE_NAME}@latest`, '--registry', registry],
      display: `dsh plugin --profile ${profileName} add ${PACKAGE_NAME}@latest --registry ${registry}`,
    });
  }
  steps.push({
    kind: 'pnpm-update',
    args: [...pnpm.args, 'update', PACKAGE_NAME, '--registry', registry],
    display: `pnpm update ${PACKAGE_NAME} --registry ${registry}`,
  });
  // 问题 3：`--save-dev` 必须紧跟 `--save-exact`、都在 `--registry` 之前
  //（位置与 pnpm 的解析无关，但测试要能逐字断言这条命令）
  const addArgs = [...pnpm.args, 'add', `${PACKAGE_NAME}@${target ?? 'latest'}`, '--save-exact'];
  if (saveDev) addArgs.push('--save-dev');
  addArgs.push('--registry', registry);
  const addNote = saveDev ? '（规格改写交给 pnpm；原在 devDependencies，按原段位带 --save-dev）' : '（规格改写交给 pnpm）';
  steps.push({
    kind: 'pnpm-add-exact',
    requiresTarget: true,
    args: addArgs,
    display: `pnpm add ${PACKAGE_NAME}@${target ?? 'latest'} --save-exact${saveDev ? ' --save-dev' : ''} --registry ${registry}${target ? addNote : ''}`,
  });
  return steps;
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
 * `enabled` 由 `normalizeUpdateConfig` 给出（默认 true，字面 false 才关）。
 * 另外三条都为了「不打扰」：没有新版不跑、正在跑不重入、同一个版本只自动试一次。
 * `link:` 安装不在这里拦（那是 startUpdate 的 linked 分支，且一个子进程都不起）。
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
  // 面板配置（勾选完成的庆祝动效开关）随 /list 载荷下发：面板是浏览器半侧，
  // 拿不到 cordis 的组合配置，必须由宿主显式转达。
  const panelConfig = normalizePanelConfig(config);
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
    /** 本次升级依次尝试过的步骤（kind/命令/退出码/是否跳过）：面板与排查都靠它看清「卡在哪一步」。 */
    steps: [],
  };
  /** 自动升级防重入：同一个 latest 版本只自动尝试一次（失败也不反复打扰）。 */
  let autoAttempted = null;
  /**
   * 跨重启节流状态（A4）：`attempted` = 已经自动试过的 latest，`file` = 状态文件路径。
   * 内存里的 `autoAttempted` 只覆盖本次进程；`persistState` 覆盖重启。
   */
  const persistState = { file: null, attempted: null };

  /** 完整状态（GET /worktodo/update 用；含日志尾部）。 */
  const updateStatus = () => ({
    state: updateRun.state,
    from: updateRun.from,
    to: updateRun.to,
    startedAt: updateRun.startedAt,
    finishedAt: updateRun.finishedAt,
    command: updateRun.command,
    logTail: [...updateRun.logTail],
    steps: updateRun.steps.map((step) => ({ ...step })),
    error: updateRun.error,
    reason: updateRun.reason,
    installed: installedVersion,
    // 让用户/面板一眼看出「自动更新已开启」（默认 true；只有字面 false 才关）
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
   *
   * 测试缝 `WORKTODO_UPDATE_LATEST` 存在时直接当成本次查到的最新版（不联网），
   * 这样「检测到新版 → 后台自动装」这条链路在离线测试里也能被端到端钉住。
   */
  const refreshUpdate = async ({ force = false } = {}) => {
    const injected = injectedLatest();
    if (injected) {
      updateState = { at: Date.now(), latest: injected, error: null };
      maybeAutoUpdate();
      return updateState;
    }
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

  /** 幂等收口：超时 / 子进程退出 / 序列结束互相竞争时，只认第一个结论。 */
  const finishRun = (state, extra = {}) => {
    if (updateRun.state !== 'running') return;
    updateRun.state = state;
    updateRun.finishedAt = Date.now();
    if (extra.reason) updateRun.reason = extra.reason;
    if (extra.error !== undefined) updateRun.error = extra.error;
    if (state === 'done') {
      // 用**落盘的版本**而不是「退出码 0」判断：profile 里 pin 死规格时命令也可能「成功」却没升上去
      const installed = extra.installed ?? updateState.latest ?? null;
      if (installed) installedVersion = installed;
      updateRun.to = installed ?? updateRun.to;
      updateRun.error = null;
      updateRun.reason = null;
      // 立刻重算 hasUpdate（有最新版就按落盘版本比，没有就静默返回）
      void refreshUpdate({ force: true });
    }
  };

  /**
   * 跑一条升级命令。用**整条升级序列共享的 deadline**：180s 是「整个自升级」的上限，
   * 不是每一步各 180s（否则三步最坏 540s，面板会长时间停在 running）。
   * 不抛异常，所有结局都通过 resolve 的字段返回。
   */
  const runUpdateStep = (step, { profileDir, updater, deadline }) => new Promise((resolve) => {
    let child;
    try {
      child = spawn(updater.command, step.args, {
        cwd: profileDir,
        env: { ...process.env, ...updater.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ spawnFailed: true, error: String(error?.message ?? error) });
      return;
    }
    let settled = false;
    let timer = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      // 先杀进程再落状态：不杀的话用户会看到「失败」而那个 pnpm 还在后台改 node_modules
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      finishRun('failed', { reason: 'timeout', error: `升级超时（${updateConfig.updateTimeoutMs}ms）已终止` });
      settle({ timedOut: true });
    }, Math.max(1, deadline - Date.now()));
    timer?.unref?.(); // 测试环境里不要因为这个定时器挂住事件循环

    child.stdout?.on('data', pushUpdateLog);
    child.stderr?.on('data', pushUpdateLog);
    child.on('error', (error) => settle({ spawnFailed: true, error: String(error?.message ?? error) }));
    child.on('close', (code, signal) => settle({ code, signal }));
  });

  /**
   * 升级序列：逐条命令执行，**每一步之后都读落盘的 node_modules 版本校验**，只有版本真的变了才算成功。
   *
   * 为什么是一条序列而不是一条命令：真机实测 `dsh plugin add dsh-worktodo@0.2.5` 退出码 0
   * 却什么都不换（输出 `added 0`，规格仍是 `^0.2.0`）。所以：
   *   1) 有官方 CLI 先走 `dsh plugin … add …@latest`（保留「CLI 优先」）；
   *   2) `pnpm update dsh-worktodo`（用户实测有效的一条）；
   *   3) 版本还没变 → `pnpm add dsh-worktodo@<registry 上的精确版本> --save-exact`，
   *      **规格改写交给 pnpm 自己**（A1 首选方案：插件不再手写用户 profile 的 JSON）；
   *   4) 仍然没变 → `failed`，error 说明「命令执行成功但落盘版本未变（可能是镜像缓存/规格锁定）」
   *      —— 绝不允许把「命令没报错」报成 `done`；任何非 done 的出口都由 `finally` 的事务收尾
   *      把被改过的清单**逐字节还原**，免得留下一个镜像里根本不存在的精确版本把用户下一次安装卡死。
   */
  const runUpdateSequence = async ({ profileDir, profileName, updater, pnpm, saveDev = false, onSettled = null }) => {
    const before = readInstalledVersion(profileDir);
    // A1/A2/A3：整个序列包在一个「profile 清单事务」里。诊断先于写盘：
    // 读不到 / 解析不出合法 JSON 时立刻失败，**一个字节都不写**（旧实现在这里会写坏用户 profile）。
    const journal = createProfileJournal(profileDir);
    if (!journal.ok) {
      // 问题 2：与 startUpdate 同一套口径 —— 「读不到」和「不是合法 JSON」要分开说，
      // 不能与「没有依赖」混用。（正常路径在 startUpdate 就读过清单了；这里是收窄竞态窗口的兜底。）
      const invalidJson = journal.kind === 'invalid-json';
      finishRun('failed', {
        reason: invalidJson ? 'profile-manifest-invalid' : 'profile-manifest-unreadable',
        error: invalidJson
          ? `profile 清单不是合法 JSON（${journal.file}），已跳过安装与写盘；请人工检查该文件`
          : `读不到 profile 清单（${journal.file}），已跳过安装与写盘；请人工检查该文件`,
      });
      return;
    }
    const deadline = Date.now() + updateConfig.updateTimeoutMs;    // 第 3 步要用 registry 的 dist-tags.latest；查不到就跳过那一步并在失败原因里说明
    let target = injectedLatest() ?? updateState.latest ?? null;
    if (!target && !UPDATE_CHECK_OFF) {
      // 生产里缓存缺失（例如启动那次查询失败）时补查一次；测试环境（UPDATE_CHECK_OFF）绝不打网络
      target = (await refreshUpdate({ force: true }))?.latest ?? null;
    }
    const steps = buildUpdateSteps({
      cli: updater.kind === 'cli' ? updater : null,
      pnpm,
      profileName,
      registry: updateConfig.updateRegistry,
      target,
      saveDev,
    });

    /** 每一步之后的统一校验：版本变了就立刻收 done。 */
    const doneIfChanged = () => {
      const after = readInstalledVersion(profileDir);
      if (!installedVersionChanged(before, after)) return false;
      finishRun('done', { installed: after });
      return true;
    };

    /**
     * 事务收尾（唯一出口）：只要**没有成功**，或盘上的清单已经**不是合法 JSON**，
     * 就把原始字节还原回去，并把结论写进 `steps[]` 与 `error`。
     *
     * 为什么放在 finally 而不是正常流程末尾（A2）：超时路径在 `runUpdateStep` 的定时器里
     * 就把状态收口成 failed/timeout 了，正常流程会在 `if (result.timedOut) return` 处直接返回，
     * 永远走不到回滚代码 —— 于是规格留在精确版本、node_modules 还是旧版本，用户下一次安装直接失败。
     */
    const settleTransaction = () => {
      const changed = journal.dirty();
      const broken = journal.corrupt();
      if (updateRun.state === 'done' && !broken) {
        if (!changed) return;
        // 升级成功且清单仍然合法：这是 pnpm 正常写下的新规格，保留（不回滚）。
        updateRun.steps.push({ kind: 'profile-manifest', note: '规格由 pnpm 原子改写并保留（版本已真的换掉）' });
        return;
      }
      if (!changed && !broken) {
        // 本次压根没改过盘（例如 pnpm add 是 no-op）：零写盘，也要显式说明「无需回滚」
        updateRun.steps.push({ kind: 'rollback-profile-spec', skipped: 'not-modified', note: '未改写 profile 规格，无需回滚' });
        return;
      }
      const result = journal.rollback();
      updateRun.steps.push({
        kind: 'rollback-profile-spec',
        ok: result.ok,
        skipped: result.wrote ? undefined : 'not-modified',
        note: result.note || 'profile 规格未变，无需回滚',
      });
      const suffix = result.note || 'profile 规格未变';
      updateRun.error = `${updateRun.error ? `${updateRun.error}；` : ''}${suffix}`;
      if (broken) {
        // 盘上的清单被写成了**非法 JSON**（不是本插件写的，但下次 DSH 启动会因此起不来）：
        // 无论这次命令算不算成功，状态都必须如实报失败，让用户去看一眼。
        updateRun.state = 'failed';
        updateRun.reason = result.ok ? 'manifest-corrupted' : 'rollback-failed';
        updateRun.finishedAt = updateRun.finishedAt ?? Date.now();
        updateRun.error = `profile 清单曾不是合法 JSON，${result.ok ? '已逐字节还原原始清单' : `还原失败：${suffix}`}`;
        return;
      }
      if (!result.ok && updateRun.state === 'done') {
        // 还原都失败时，状态必须是 failed（哪怕这次命令本来「成功」了）：清单不可信
        updateRun.state = 'failed';
        updateRun.reason = 'rollback-failed';
        updateRun.finishedAt = updateRun.finishedAt ?? Date.now();
      }
    };

    let lastFailure = null;
    try {
      for (const step of steps) {
        if (updateRun.state !== 'running') return; // 已被超时/其它路径收口（finally 仍会回滚）
        updateRun.command = step.display;
        if (step.requiresTarget && !target) {
          updateRun.steps.push({ kind: step.kind, display: step.display, skipped: 'unknown-target' });
          lastFailure = lastFailure ?? {
            reason: 'unknown-target',
            error: '拿不到 registry 上的最新版本，无法把依赖规格改写成精确版本',
          };
          continue;
        }
        const result = await runUpdateStep(step, { profileDir, updater, deadline });
        updateRun.steps.push({
          kind: step.kind,
          display: step.display,
          exitCode: result.code ?? null,
          timedOut: Boolean(result.timedOut),
        });
        if (doneIfChanged()) return;
        if (result.timedOut) return; // 结论已由超时路径给出（failed/timeout），finally 负责回滚
        if (result.spawnFailed) {
          lastFailure = { reason: 'spawn-failed', error: `无法启动升级命令：${result.error}` };
          continue;
        }
        if (result.code !== 0) {
          lastFailure = {
            reason: 'exit-nonzero',
            error: `安装命令退出码 ${result.code ?? 'null'}${result.signal ? `（信号 ${result.signal}）` : ''}`,
          };
          continue;
        }
      }

      if (doneIfChanged()) return;
      const after = readInstalledVersion(profileDir);
      // 这条措辞是硬要求：用户必须能从 failed 里看出「命令没报错 ≠ 升上去了」
      const unchangedHint = `${PACKAGE_NAME} 落盘版本未变（可能是镜像缓存/规格锁定）`;
      if (lastFailure) {
        finishRun('failed', { reason: lastFailure.reason, error: `${lastFailure.error}；且 ${unchangedHint}` });
        return;
      }
      finishRun('failed', {
        reason: 'version-unchanged',
        error: `命令执行成功但 ${unchangedHint}：已依次尝试 ${steps.map((step) => step.kind).join(' → ')}，当前落盘版本仍是 ${after ?? '未知'}`,
      });
    } catch (error) {
      finishRun('failed', { reason: 'internal', error: `升级过程内部错误：${messageOf(error)}` });
    } finally {
      settleTransaction();
      // 问题 1：真实结论只能在**所有出口都收口之后**回写（含超时、清单被写坏、回滚失败）。
      // 回写失败绝不能影响升级本身的结论，所以这里吞掉异常。
      try {
        onSettled?.();
      } catch { /* 状态文件只是可观测性，写不了就算了 */ }
    }
  };

  /**
   * 触发一次升级。**不并发**：已经在跑就直接返回 running。
   *
   * 只做「定位 profile → 读规格 → 排除 link: → 起后台序列」并**立刻**返回 running；
   * 多条升级命令在后台异步跑（`void runUpdateSequence`），所以面板轮询与 /list 永不被阻塞。
   * 所有失败都通过状态机（含稳定 reason）回传，不抛异常。
   *
   * @param {{attempt?: {version: string, at: number}|null}} [options]
   *   `attempt` 非空表示这是**自动**升级的一次尝试（A4 跨重启节流记录）。
   *   问题 1：`startUpdate` 只等序列**起步**就 resolve，所以「这次尝试到底成没成」必须由
   *   它自己在每个出口如实写回状态文件 —— 否则调用方只能把「过了守卫」记成 `done`。
   */
  const startUpdate = async ({ attempt = null } = {}) => {
    let outcomeWritten = false;
    /**
     * 把这次尝试的**真实结论**写进状态文件：只可能是 `done` / `failed`（+ 稳定 reason、尝试时间）。
     * 每个出口最多写一次（超时、回滚、守卫拒绝互相竞争时只认第一个结论）。
     */
    const writeAttemptOutcome = (result, reason = null) => {
      if (!attempt || outcomeWritten) return;
      outcomeWritten = true;
      persistAttempt(persistState.file, {
        attempted: attempt.version,
        at: attempt.at,
        finishedAt: Date.now(),
        result,
        ...(reason ? { reason } : {}),
      });
    };

    if (updateRun.state === 'running') return { ok: true, running: true, ...updateStatus() };

    const profileDir = await findProfileDir().catch(() => null);
    if (!profileDir) {
      updateRun.state = 'failed';
      updateRun.finishedAt = Date.now();
      updateRun.reason = 'profile-not-found';
      updateRun.error = '反推不出本实例自己所在的 profile 目录（link: 装载或非标准布局），为避免改写别的 profile，已放弃升级且未做任何写操作';
      writeAttemptOutcome('failed', 'profile-not-found');
      return { ok: false, reason: 'profile-not-found', message: updateRun.error };
    }
    // 问题 2：读不到 / 不是合法 JSON 必须**按真实原因**报，不能与「没有依赖」混用。
    // 行为保持 A1 的硬前提：任何写操作与子进程都不发生。
    const manifest = readProfileManifest(profileDir);
    if (!manifest.ok) {
      const invalidJson = manifest.kind === 'invalid-json';
      const reason = invalidJson ? 'profile-manifest-invalid' : 'profile-manifest-unreadable';
      updateRun.state = 'failed';
      updateRun.finishedAt = Date.now();
      updateRun.reason = reason;
      updateRun.error = invalidJson
        ? `profile 清单不是合法 JSON（${manifest.file}），已跳过安装与写盘；请人工检查该文件`
        : `读不到 profile 清单（${manifest.file}），已跳过安装与写盘；请人工检查该文件`;
      writeAttemptOutcome('failed', reason);
      return { ok: false, reason, message: updateRun.error };
    }
    const entries = specEntriesFromPkg(manifest.pkg);
    const spec = entries.find((entry) => typeof entry.rawValue === 'string' && entry.rawValue.trim())?.rawValue?.trim() ?? null;
    if (spec === null) {
      updateRun.state = 'failed';
      updateRun.finishedAt = Date.now();
      updateRun.reason = 'not-installed';
      updateRun.error = `该 profile 的 package.json 里没有 ${PACKAGE_NAME} 依赖（${profileDir}）`;
      writeAttemptOutcome('failed', 'not-installed');
      return { ok: false, reason: 'not-installed', message: updateRun.error };
    }
    // 本地协议（`link:` / `file:` / `workspace:`）是开发工作流：升级命令会把它换成 registry 上的包，
    // 等于把开发工作流拆掉。**任一**段位命中就整体跳过（A3：旧守卫只看第一个命中的字段，
    // `devDependencies` 里的 `link:` 拦不住，会被回滚逻辑静默冲成 registry 范围）。
    // **一个子进程都不许起**（自动更新也一样），直接把原因交回面板。
    const localSections = entries.filter((entry) => isLocalSpec(entry.rawValue)).map((entry) => entry.section);
    if (localSections.length) {
      updateRun.state = 'idle';
      updateRun.reason = 'linked';
      updateRun.error = `这是本地安装（${localSections.join(' / ')}：${entries
        .filter((entry) => isLocalSpec(entry.rawValue))
        .map((entry) => `${entry.section}.${PACKAGE_NAME}=${entry.rawValue}`)
        .join('，')}），请在仓库里用 git/pnpm 工作流更新，不要用自动升级`;
      writeAttemptOutcome('failed', 'linked');
      return { ok: false, reason: 'linked', message: updateRun.error };
    }

    const updater = resolveUpdater();
    // 序列的后半段（改写精确规格 + install）始终用 pnpm：那是用户真机实测有效的路径
    const pnpm = resolvePnpmUpdater();
    const profileName = basename(profileDir);
    // 问题 3：规格原本在 devDependencies → `pnpm add` 必须带 `--save-dev`，否则会被迁到 dependencies
    const saveDev = shouldSaveDev(entries);

    updateRun.state = 'running';
    updateRun.from = PLUGIN_VERSION;
    updateRun.to = injectedLatest() ?? updateState.latest ?? null;
    updateRun.startedAt = Date.now();
    updateRun.finishedAt = null;
    updateRun.command = null;
    updateRun.logTail = [];
    updateRun.steps = [];
    updateRun.error = null;
    updateRun.reason = null;

    void runUpdateSequence({
      profileDir, profileName, updater, pnpm, saveDev,
      // 问题 1：序列收尾（含超时 / 回滚收口之后）时写真实结论
      onSettled: () => writeAttemptOutcome(
        updateRun.state === 'done' ? 'done' : 'failed',
        updateRun.state === 'done' ? null : (updateRun.reason ?? 'unknown'),
      ),
    }).catch((error) => {
      finishRun('failed', { reason: 'internal', error: `升级过程内部错误：${String(error?.message ?? error)}` });
      writeAttemptOutcome('failed', 'internal');
    });

    return { ok: true, running: true, ...updateStatus() };
  };

  /**
   * 自动升级（`autoUpdate` 默认 **true**；只有字面 `false` 才完全关）。
   *
   * 三条纪律：后台异步（`void`，绝不阻塞请求）、同一个 latest 只自动试一次、失败只记日志不打扰用户。
   *
   * 「只试一次」**跨重启**（A4）：旧实现只有一个 `apply()` 闭包变量 `autoAttempted`，
   * 进程一重启就忘了 —— 只要 registry 仍比落盘版本新、而升级始终失败（镜像/规格原因），
   * **每次 DSH 启动**都会重跑整条序列并改写真实 profile（实测两次启动、子进程 2→4、mtime 两次变化）。
   * 现在把「已试过的 latest」原子写到插件自己的状态文件（见 maybeAutoUpdate 里的 persistAttempt）。
   * `link:` 安装由 startUpdate 的 linked 分支拦住，**一个子进程都不起**。
   */
  const maybeAutoUpdate = () => {
    const injected = injectedLatest();
    // 显式关掉版本查询（测试）且没有注入 latest 时，绝不动安装
    if (UPDATE_CHECK_OFF && !injected) return;
    const latest = injected ?? updateState.latest;
    // 触发条件抽成纯函数（shouldAutoUpdate），好让「默认开 / 不重入 / 同版本只试一次」可单测。
    // attempted 同时看内存与持久化状态：内存管本次进程，状态文件管跨重启。
    const attempted = autoAttempted ?? persistState.attempted;
    if (!shouldAutoUpdate({
      enabled: updateConfig.autoUpdate,
      latest,
      current: installedVersion ?? PLUGIN_VERSION,
      runState: updateRun.state,
      attempted,
    })) return;
    autoAttempted = latest;
    // 先落盘再动手：这样进程被杀/崩溃也不会在下次启动时重试同一个版本（那正是 A1/A2 的窗口）
    persistState.attempted = latest;
    const attempt = { version: latest, at: Date.now() };
    persistAttempt(persistState.file, { attempted: latest, at: attempt.at, result: 'started' });
    // 问题 1：这里**不再**在序列刚起步时就记 done —— startUpdate 会带上 attempt 自己在
    // 每个出口回写真实结论（守卫拒绝 → failed+reason；序列收尾 → done / failed+reason）。
    void startUpdate({ attempt })
      .then((result) => {
        if (result?.ok === false) {
          logger?.warn?.(`自动升级未执行（只记日志，不打扰用户）：${result.reason} ${result.message ?? ''}`);
        }
      })
      .catch((error) => {
        logger?.warn?.(`自动升级失败（只记日志，不打扰用户）：${error?.message ?? error}`);
      });
  };

  /**
   * `/list` 载荷里的 update 摘要。
   *
   * 两类状态必须分清楚（本轮修复的核心）：
   *   - `hasUpdate`：registry 的 latest 比**本进程正在跑的**版本新 —— 语义保持不变，老面板照旧能用；
   *   - `restartRequired`：node_modules 里**已落盘**的版本比运行版本新 —— 后台已经装好了，
   *     用户在等重启，面板该说「已更新，重启生效」而不是继续喊「有新版本」。
   *
   * `installedVersion` 每次请求都重新读盘（小文件）：这样「DSH 运行期间用户自己装了新版」
   * 「后台升级刚写完盘」「另一个进程装好了」都能被看见。读不到（没 profile / 半写 / 坏 JSON）
   * 就是 `null`，绝不影响 `/list`（readInstalledVersion 自己吞异常）。
   */
  const updatePayload = () => {
    const latest = injectedLatest() ?? updateState.latest;
    const runningVersion = PLUGIN_VERSION;
    const installedVersionOnDisk = readInstalledVersion(resolveOwnProfileDir());
    // 只有两边都是已知版本时才比较；未知版本不能凭空声称「该重启」。
    const restartRequired = Boolean(installedVersionOnDisk && runningVersion)
      && compareVersion(installedVersionOnDisk, runningVersion) > 0;
    return {
      // 老字段：`current` 一直是运行版本（旧面板读它），保留
      current: runningVersion,
      runningVersion,
      latest: latest ?? undefined,
      // 语义固定：latest vs **runningVersion**（不是落盘版本）。装好待重启时它仍是 true，
      // 客户端必须先判 restartRequired 再判 hasUpdate，两者不会同时被展示成两个结论。
      hasUpdate: Boolean(latest && runningVersion) && compareVersion(latest, runningVersion) > 0,
      restartRequired,
      // 契约：读不到给 null（老字段 `installed` 继续给 undefined，旧面板不受影响）
      installedVersion: installedVersionOnDisk,
      installed: installedVersionOnDisk ?? undefined,
      page: `https://www.npmjs.com/package/${PACKAGE_NAME}`,
      run: updateRunSummary(),
    };
  };
  // 启动时后台查一次（失败静默）。测试环境（UPDATE_CHECK_OFF）或无网络时它会立刻返回：
  // 有 WORKTODO_UPDATE_LATEST 注入时按「已知最新版」处理并顺带触发自动更新。
  //
  // A4：先把跨重启节流状态读回来 —— 必须在这行 tick **之前**完成，否则启动那次 tick 看不到
  // 上一次留下的「已试过 X」记录，会立刻再重跑一遍整条序列（正是要修的「每次启动重写 profile」）。
  let stateHome = null;
  try {
    stateHome = await resolveDshHome();
  } catch {
    stateHome = null;
  }
  persistState.file = resolveUpdateStatePath({ env: process.env, home: stateHome });
  persistState.attempted = readPersistedAttempt(persistState.file);
  void refreshUpdate();

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
            // 过期就在后台刷新一次；注入 latest 的测试环境下每次 /list 都算一次 tick，
            // 用来钉住「同一个新版本只自动触发一次」的节流。
            if (injectedLatest() || (!UPDATE_CHECK_OFF && Date.now() - updateState.at >= UPDATE_TTL_MS)) void refreshUpdate();
            const result = await service.list({
              filter: url.searchParams.get('filter') ?? 'open',
              project: url.searchParams.get('project') ?? undefined,
              query: url.searchParams.get('query') ?? undefined,
              sort: url.searchParams.get('sort') ?? undefined,
              // S3-3：面板可选择只要一种视图（shapes=todos|groups|projectGroups|both）
              shapes: url.searchParams.get('shapes') ?? undefined,
            });
            reply(response, result.ok
              ? { ...result, version: PLUGIN_VERSION, update: updatePayload(), panel: panelConfig }
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
