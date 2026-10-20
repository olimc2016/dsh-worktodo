// 单元测试不打网络：关掉插件的更新检查（它默认会查一次 npm registry）
process.env.WORKTODO_NO_UPDATE_CHECK = '1';
/**
 * 宿主半侧烟测：在**不启动 DSH** 的情况下走通「apply → 路由 → 服务 → 存储」与
 * 「apply → 工具注册 → 工具执行 → 服务」两条链路。
 *
 * 这是安装到 profile 之前唯一能抓出接线错误的地方：
 *   - 路由路径写错、方法围栏失效、connection 准入没接上
 *   - 工具 schema 不合官方 defineTool 的规范（会在注册时直接抛）
 *   - 工具执行后返回/渲染的文本不对
 *   - 请求体坏掉时是否变成 500（应该是有原因的 200，面板要能显示原因）
 *
 * 存储指向临时目录，绝不碰用户真实的 ~/.dsh。
 */
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, renameSync, rmSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { gzipSync } from 'node:zlib';
// DSH 判定「工具返回值是否 lossless JSON」用的就是这一个函数（见 assertLossless 的说明）
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { apply, shouldAutoUpdate, profileDirFromModuleUrl, resolveOwnProfileDir, detectUnsupportedInstall, normalizePanelConfig, normalizeUpdateConfig, buildUpdateSteps, resolveUpdateStatePath, resolveUpdateStageDir, buildTarballUrl, resolveRestartRequester, writeFileAtomicSync, readProfileSpecEntries, shouldSaveDev, resolveCliUpdater, resolvePnpmUpdater, bundledPnpmCandidates, installedVersionChanged, resolveUpdateLockPath, resolveStartupCheckDelayMs, acquireUpdateLock, releaseUpdateLock, classifyCliFailure, killProcessTree, resolveApplyResultPath, resolveApplyLogPath, resolveApplyTimeoutMs, resolveApplyUpdatePath, buildApplyInstallerSpec, extractTarballToDir, UPDATE_CHECK_TIMEOUT_MS, UPDATE_CHECK_RETRY_DELAY_MS, UPDATE_CHECK_TOTAL_BUDGET_MS, UPDATE_CHECK_BACKOFF_BASE_MS, UPDATE_CHECK_BACKOFF_MAX_MS, resolveCheckTimeoutMs, resolveCheckRetryDelayMs, resolveCheckBackoffMs, UPDATE_MODES, DEFAULT_UPDATE_MODE, normalizeUpdateMode, defaultUpdateModeFromConfig, effectiveUpdatePolicy, resolveSettingsPath, parseUpdateSettings, readUpdateSettings, writeUpdateSettings } from '../lib/index.js';

/**
 * 「模拟版本」的**唯一**来源：全部从 package.json 派生；本文件里不许再出现当前版本号的字面量。
 *
 * 为什么：夹具里写死版本号，发版那天就会变成假红 —— 写死的「新版本」恰好等于刚发布的真实版本，
 * 于是「模拟升级」其实没升级（旧 == 新），或者断言里的 `dsh-worktodo@x.y.z` 与代码实际用的
 * 目标版本对不上。最近这次发版正是这么红的。规则：
 *   - 「已装的老版本」用 `'0.2.0'` 这类**远低于当前版本**的历史值（与当前版本无关，永不过期）；
 *   - 「升级目标 / 新版本」一律用 `FAKE_NEXT_VERSION`（= 当前版本 patch + 1）；
 *   - 拼进命令 / 清单 / 动态生成的脚本时也用 `FAKE_NEXT_VERSION` 插值，不要粘贴具体数字。
 * 本文件末尾有一条元测试：源码里一旦重新出现「当前版本号字面量」就判红。
 */
const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
/** 「当前装着的版本」的显式别名（断言里一眼看出是当前版本，而不是模拟的新版本）。 */
const FAKE_CURRENT_VERSION = PKG_VERSION;
/** 模拟的「registry 上的新版本」：必须严格大于当前版本，否则自升级用例会失去意义。 */
const FAKE_NEXT_VERSION = bumpPatch(PKG_VERSION, 1);

/**
 * 自动升级的跨重启节流状态文件默认落在 `$DSH_HOME/worktodo/update-state.json`（A4），
 * 而这里的更新用例未必都把 `$DSH_HOME` 指到临时目录 —— 全局兜一个测试专用路径，
 * 保证**测试永远不会碰真实 `~/.dsh`**（要用持久化的用例会在 withEnv 里覆盖它）。
 */
process.env.WORKTODO_UPDATE_STATE_PATH = join(mkdtempSync(join(tmpdir(), 'worktodo-update-state-')), 'update-state.json');

/**
 * 启动检查默认延后 25s（稳定性复审 A1/A2）。测试要的是「apply 后很快就能观察到检查结果」，
 * 所以这里统一把延后设成 0；专门的「延后」用例会在 withEnv 里覆盖成真实时长，
 * 用来钉住「apply 返回后不会立刻抢跑」。
 */
process.env.WORKTODO_STARTUP_CHECK_DELAY_MS = '0';

/**
 * 造一个**合法的 npm tarball**（gzip + ustar，条目以 `package/` 开头）。
 *
 * 为什么要真的造 tar：下载这一步现在要解包成「完整包目录」再交给安装器；
 * 只回一段随机字节只能测到「下载完成」，测不到解包、包身份校验与真实文件替换。
 */
function tarHeader(name, size, { mode = 0o644, type = '0' } = {}) {
  const buffer = Buffer.alloc(512);
  buffer.write(name, 0, 100, 'utf8');
  buffer.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
  buffer.write('0000000\0', 108, 8, 'ascii');
  buffer.write('0000000\0', 116, 8, 'ascii');
  buffer.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  buffer.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
  buffer.write('        ', 148, 8, 'ascii');
  buffer.write(type, 156, 1, 'ascii');
  buffer.write('ustar\0', 257, 6, 'ascii');
  buffer.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of buffer) sum += byte;
  buffer.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return buffer;
}

function buildFakeTarball(version, { marker = null } = {}) {
  const packageJson = JSON.stringify({
    name: 'dsh-worktodo',
    version,
    type: 'module',
    main: 'lib/index.js',
    '//': marker ?? `staged-${version}`,
  }, null, 2);
  const entries = [
    ['package/package.json', Buffer.from(packageJson)],
    ['package/lib/index.js', Buffer.from(`export const APPLIED = ${JSON.stringify(version)};\n`)],
    ['package/lib/client.js', Buffer.from(`// client ${version}\n`)],
    ['package/src/client/index.js', Buffer.from(`// src client ${version}\n`)],
    ['package/cordis.patch.yml', Buffer.from(`# patch ${version}\n`)],
    ['package/locale/zh.json', Buffer.from('{"name":"工作待办"}\n')],
    ['package/CHANGELOG.md', Buffer.from(`# ${version}\n`)],
    ['package/README.md', Buffer.from('# dsh-worktodo\n')],
    ['package/icon.svg', Buffer.from('<svg></svg>\n')],
    ['package/assets/blob.bin', Buffer.from([0, 1, 2, 3, 254, 255])],
  ];
  const blocks = [];
  for (const [name, data] of entries) {
    blocks.push(tarHeader(name, data.length));
    blocks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/**
 * 假的 tarball 分发源：按 npm registry 的路径约定返回**合法 tarball**。
 * 需要注入下载失败的用例会自己再起一个坏服务去覆盖 `WORKTODO_UPDATE_TARBALL_BASE`。
 */
const fakeTarballCache = new Map();
function fakeTarballFor(version) {
  if (!fakeTarballCache.has(version)) fakeTarballCache.set(version, buildFakeTarball(version));
  return fakeTarballCache.get(version);
}
const tarballServer = createServer((request, response) => {
  const match = /dsh-worktodo-(\d+\.\d+\.\d+)\.tgz/.exec(String(request.url ?? ''));
  const body = fakeTarballFor(match?.[1] ?? FAKE_NEXT_VERSION);
  response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
  response.end(body);
});
await new Promise((resolve) => tarballServer.listen(0, '127.0.0.1', resolve));
tarballServer.unref();
process.env.WORKTODO_UPDATE_TARBALL_BASE = `http://127.0.0.1:${tarballServer.address().port}/`;

/**
 * 最近一次从 GET /worktodo/update 读到的阶段 / 重启记录（轮询式断言用）。
 * 必须在这里（文件顶部）声明：本文件还有「用 argv 重新 spawn 自己」的 A1 子场景，
 * 它在第 190 行左右就调用 readUpdateState —— 声明晚了会撞 TDZ。
 */
let lastPhase = null;
let lastRestart = null;

/**
 * A1 的写失败注入必须跑在**真实 fs 失败**下（`ulimit -f`，等价 ENOSPC）。
 *
 * 整份烟测自己也要写盘（fixture、store、capture），不能整体套 ulimit，所以把要注入的子场景
 * 放进同一个文件的 argv 分支里：父用例用 `sh -c 'ulimit -f 1; exec node <本文件> --…-child'`
 * 重新 spawn 一次，那个进程里**任何**超过 1024 字节的单文件写入都会得到 EFBIG。
 * 这样「原子写 vs 裸 writeFileSync」在同一个真实失败点上被区分开，而不是靠打桩。
 *
 * 分支本体在 `makeCtx` 之后（见那里的说明）：它闭包引用的 `systemPromptSections` 是 const，
 * 必须已初始化，否则会撞 TDZ。
 */

// 版本断言统一从顶部 PKG_VERSION / FAKE_NEXT_VERSION 派生
let passed = 0;
const failures = [];

/**
 * @param {string} label
 * @param {() => any} run
 */
async function test(label, run) {
  try {
    await run();
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
// 记录插件注册给模型的提示段落（供下方断言）
const systemPromptSections = [];

function eq(actual, expected, hint = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${hint}期望 ${b}，实际 ${a}`);
}

/** 假请求：一个最小可读流，带上 method / url。 */
function makeRequest({ method = 'GET', url, body } = {}) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = url;
  if (body !== undefined) req.push(typeof body === 'string' ? body : JSON.stringify(body));
  req.push(null);
  return req;
}

/** 假响应：记录状态码与响应体。 */
function makeResponse() {
  return {
    statusCode: null,
    headers: null,
    text: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers ?? null;
    },
    end(text) {
      this.text = text ?? '';
    },
    /** @returns {object} 解析后的 JSON 体 */
    json() {
      return this.text ? JSON.parse(this.text) : null;
    },
  };
}

/** 调用一个路由 handler 并等它跑完。 */
async function call(handler, options) {
  const response = makeResponse();
  await handler(makeRequest(options), response);
  return response;
}

/** 组装一个假 cordis 上下文，收集注册出来的路由与工具。 */
function makeCtx({ rejection, storageDomain, webServer } = {}) {
  const routes = new Map();
  const tools = [];
  const effects = [];
  const logs = [];
  // 事件总线：domain/changed 这类领域事件走这里（F7 的变更通知）
  const listeners = new Map();
  const ctx = {
    logger: () => ({ info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`) }),
    get: (name) => {
      if (name === 'storageDomain') return storageDomain;
      if (name === 'connection' && rejection) return { requestRejection: rejection };
      return undefined;
    },
    on: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    },
    emit: (event, payload) => {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
    },
    inject: (deps, callback) => {
      // 只回放本烟测真正关心的服务；缺服务的情况由 store/service 自己降级
      callback(ctx);
      return () => {};
    },
    effect: (callback, label) => {
      const dispose = callback();
      effects.push({ label, dispose });
      return { dispose() {} };
    },
    systemPrompt: {
      section: (section) => {
        systemPromptSections.push(section);
        return () => {};
      },
    },
    webServer: webServer ?? {
      register: ({ kind, path, handler }) => {
        routes.set(path, { kind, handler });
        return () => routes.delete(path);
      },
    },
    tools: {
      register: (definition) => {
        tools.push(definition);
        return () => {};
      },
    },
  };
  return { ctx, routes, tools, effects, logs, listeners, systemPromptSections };
}

// 子场景入口：所有 const 都已初始化，可以安全地只跑这一个场景然后退出（见文件顶部说明）。
if (process.argv.includes('--selfupdate-writefail-child')) {
  await runWriteFailChild();
}

/**
 * 假 storageDomain facility：复刻官方 open/table 契约 + 「第二次 open 抛 already-open」语义。
 * 用来在宿主层验证「二次挂载不降级」（审计 F1）与「domain/changed 事件真的接通」（审计 F7）。
 * @param {object[]} [initial]
 */
function makeFakeDomainFacility(initial = []) {
  const records = new Map(initial.map((record) => [record.id, record]));
  const calls = { open: 0, close: 0 };
  /** 测试开关：模拟「领域突然读不出来」（复审 R4/F16：/health 必须报 count: null 而不是 0）。 */
  const control = { failLoad: false };
  let open = false;
  return {
    records,
    calls,
    control,
    async open(spec) {
      calls.open += 1;
      if (open) throw new Error("domain 'worktodo' is already open");
      open = true;
      return {
        table: (name) => ({
          get: (key) => records.get(key),
          entries: () => {
            if (control.failLoad) throw new Error('领域读不出来（模拟 domain 不可用）');
            return [...records.entries()][Symbol.iterator]();
          },
          size: records.size,
          put: async (key, value) => {
            records.set(key, spec.tables[name].valueSchema.parse(value));
          },
          delete: async (key) => records.delete(key),
        }),
        close: async () => {
          calls.close += 1;
          // 官方领域关闭是**异步**的（要等落盘/释放）；这里用一次宏任务模拟。
          // 少了这个延迟，「卸载后立刻重载」的 already-open 窗口在测试里根本不存在（复审 R2）。
          await new Promise((resolve) => setTimeout(resolve, 5));
          open = false;
        },
      };
    },
  };
}

/**
 * 假 webServer：复刻真实 DSH 的**服务级**路由表语义（S1-1 的复现条件）——
 * 路由表不属于某个 ctx，重复路径**抛错**而不是幂等；`register` 返回删除该路由的 disposer。
 * @param {object} [options]
 * @param {number} [options.failAt] 第 N 次 register（1 起）抛「duplicate exact route」
 */
function makeServerLevelWebServer({ failAt } = {}) {
  const table = new Map();
  const calls = { register: 0, dispose: 0, failed: [] };
  return {
    table,
    calls,
    register({ kind, path, handler }) {
      calls.register += 1;
      if (failAt && calls.register === failAt) {
        calls.failed.push(path);
        throw new Error(`webserver: duplicate exact route "${path}"（注入第 ${failAt} 条注册失败）`);
      }
      if (table.has(path)) throw new Error(`webserver: duplicate ${kind} route "${path}"`);
      table.set(path, { kind, handler });
      return () => {
        calls.dispose += 1;
        table.delete(path);
      };
    },
  };
}

const root = mkdtempSync(join(tmpdir(), 'worktodo-smoke-'));
const storePath = join(root, 'todos.json');

const { ctx, routes, tools, logs } = makeCtx();
await apply(ctx, { storePath });

// 工具注册是动态导入 + promise，给它一个宏任务窗口落地
await new Promise((resolve) => setTimeout(resolve, 50));

console.log('接线');

await test('apply 完成且不抛（假 ctx 里没有 storage/tools 也不该崩）', () => {
  eq(logs.some((line) => line.startsWith('info') && line.includes('待办数据')), true, '应有存储位置日志：');
});

await test('注册出 9 条路由', () => {
  eq([...routes.keys()].sort(), [
    '/worktodo/adopt',
    '/worktodo/create',
    '/worktodo/health',
    '/worktodo/list',
    '/worktodo/remove',
    '/worktodo/reorder',
    '/worktodo/settings',
    '/worktodo/status',
    '/worktodo/update',
  ]);
});

await test('注册出 7 个 worktodo_* 工具（schema 过官方 defineTool 校验）', () => {
  eq(tools.map((t) => t.name).sort(), [
    'worktodo_add',
    'worktodo_add_many',
    'worktodo_adopt',
    'worktodo_done',
    'worktodo_list',
    'worktodo_remove',
    'worktodo_update',
  ]);
  // defineTool 会把 parameters 规范成 JSON Schema；能被规范说明我们的声明合法
  const add = tools.find((t) => t.name === 'worktodo_add');
  eq(add.parameters.type, 'object');
  eq(add.parameters.required.includes('title'), true, 'title 必填：');
});

await test('TOOL_NAMES 报告清单与实际注册的工具一致（防漂移）', async () => {
  // /worktodo/health 会用 TOOL_NAMES 报告「注册了哪些工具」，
  // 所以它必须等于实际注册结果，否则自检会撒谎
  const { TOOL_NAMES } = await import('../src/tools.mjs');
  eq([...TOOL_NAMES].sort(), tools.map((t) => t.name).sort());
});

await test('B2：登记/修改项目的工具描述必须提醒「复用已有项目名」（防止以后被删）', () => {
  const add = tools.find((t) => t.name === 'worktodo_add');
  eq(/复用|既有|保持一致/.test(add.parameters.properties.project.description), true,
    `worktodo_add 的 project 描述要提醒复用已有项目名：${add.parameters.properties.project.description}`);
  eq(add.parameters.properties.project.description.includes('worktodo_list'), true, '要给出自查方式（先看 projects 清单）：');

  const many = tools.find((t) => t.name === 'worktodo_add_many');
  eq(/复用|既有|保持一致/.test(many.parameters.properties.items.items.properties.project.description), true,
    `worktodo_add_many 的 project 描述要提醒复用已有项目名：${many.parameters.properties.items.items.properties.project.description}`);

  const update = tools.find((t) => t.name === 'worktodo_update');
  eq(/复用|既有|保持一致/.test(update.parameters.properties.project.description), true,
    `worktodo_update 的 project 描述要提醒复用已有项目名：${update.parameters.properties.project.description}`);
});

console.log('路由与准入');

await test('health 自检报告存储位置、版本与工具注册结果', async () => {
  const response = await call(routes.get('/worktodo/health').handler, { method: 'GET', url: '/worktodo/health' });
  eq(response.statusCode, 200);
  const body = response.json();
  eq(body.ok, true);
  eq(body.plugin, 'worktodo');
  eq(body.store.kind, 'file');
  eq(body.count, 0);
  // 版本与工具注册结果：排查「源码改动生效了没 / 工具静默没注册」就看这两个字段
  eq(body.version, PKG_VERSION);
  eq(body.tools.status, 'registered');
  eq(body.tools.registered, 7);
  eq(body.tools.names.includes('worktodo_add'), true);
});

await test('方法围栏：对 /create 发 GET 得到 405', async () => {
  const response = await call(routes.get('/worktodo/create').handler, { method: 'GET', url: '/worktodo/create' });
  eq(response.statusCode, 405);
  eq(response.headers.allow, 'POST');
});

await test('connection 准入：被拒绝时直接按拒绝码返回，不进入业务', async () => {
  const guarded = makeCtx({ rejection: () => 403 });
  await apply(guarded.ctx, { storePath: join(root, 'guarded.json') });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const response = await call(guarded.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' });
  eq(response.statusCode, 403);
});

console.log('路由行为（完整增删改查）');

await test('POST /create 建一条并回传记录', async () => {
  const response = await call(routes.get('/worktodo/create').handler, {
    method: 'POST',
    url: '/worktodo/create',
    body: { title: '写 v0.1.0 的 README', priority: 'high', due: '2026-10-20', project: 'dsh-worktodo' },
  });
  eq(response.statusCode, 200);
  const body = response.json();
  eq(body.ok, true);
  eq(body.data.todo.title, '写 v0.1.0 的 README');
  eq(body.data.todo.priority, 'high');
  eq(body.data.todo.id.startsWith('wt-'), true, 'id 前缀：');
});

await test('GET /list 能读到刚建的条目，含分组与统计', async () => {
  const response = await call(routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list?filter=open' });
  const body = response.json();
  eq(body.ok, true);
  eq(body.data.todos.length, 1);
  eq(body.data.stats.open, 1);
  eq(Object.keys(body.data.groups).sort(), ['completed', 'later', 'overdue', 'today', 'tomorrow', 'week']);
});

await test('POST /status 勾选完成后再取消', async () => {
  const list = (await call(routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list?filter=all' })).json();
  const id = list.data.todos[0].id;

  const done = await call(routes.get('/worktodo/status').handler, { method: 'POST', url: '/worktodo/status', body: { ref: id, toggle: true } });
  eq(done.json().data.todo.status, 'completed');

  const undone = await call(routes.get('/worktodo/status').handler, { method: 'POST', url: '/worktodo/status', body: { ref: id, toggle: true } });
  eq(undone.json().data.todo.status, 'pending');
});

await test('POST /update 改字段，空串表示清空', async () => {
  const list = (await call(routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list?filter=all' })).json();
  const id = list.data.todos[0].id;
  const response = await call(routes.get('/worktodo/update').handler, {
    method: 'POST',
    url: '/worktodo/update',
    body: { ref: id, due: '', title: '写 README（改名）' },
  });
  const body = response.json();
  eq(body.ok, true);
  eq(body.data.todo.due, null, '空串应清空截止日期：');
  eq(body.data.todo.title, '写 README（改名）');
});

await test('POST /adopt 提升会话条目并去重', async () => {
  const response = await call(routes.get('/worktodo/adopt').handler, {
    method: 'POST',
    url: '/worktodo/adopt',
    body: { todos: [{ content: '写 README（改名）', status: 'pending' }, { content: '发 npm', status: 'pending' }] },
  });
  const body = response.json();
  eq(body.ok, true);
  eq(body.data.created.map((t) => t.title), ['发 npm']);
  eq(body.data.skipped, 1);
});

await test('POST /remove 删除，再删同一条给 not-found', async () => {
  const list = (await call(routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list?filter=all' })).json();
  const id = list.data.todos[0].id;
  const removed = await call(routes.get('/worktodo/remove').handler, { method: 'POST', url: '/worktodo/remove', body: { ref: id } });
  eq(removed.json().ok, true);
  const again = await call(routes.get('/worktodo/remove').handler, { method: 'POST', url: '/worktodo/remove', body: { ref: id } });
  const body = again.json();
  eq(body.ok, false);
  eq(body.reason, 'not-found');
});

console.log('失败路径');

await test('标题为空 → 200 且 ok=false 带原因（面板要能显示）', async () => {
  const response = await call(routes.get('/worktodo/create').handler, { method: 'POST', url: '/worktodo/create', body: { title: '  ' } });
  eq(response.statusCode, 200);
  const body = response.json();
  eq(body.ok, false);
  eq(body.reason, 'empty-title');
  eq(typeof body.error, 'string');
});

await test('POST /update 的 title/project 校验：空白/超长/非字符串被拒且记录不变；合法值 trim 后落库', async () => {
  const created = await call(routes.get('/worktodo/create').handler, {
    method: 'POST', url: '/worktodo/create',
    body: { title: '校验基准', project: 'base-proj' },
  });
  const id = created.json().data.todo.id;
  const readRecord = async () => {
    const list = (await call(routes.get('/worktodo/list').handler, {
      method: 'GET', url: '/worktodo/list?filter=all&shapes=todos',
    })).json();
    return list.data.todos.find((todo) => todo.id === id);
  };

  // 非法输入：沿用既有约定「200 + ok:false + reason」，且**一个字节都不写**。
  const cases = [
    [{ title: '   ' }, 'empty-title'],
    [{ title: 'x'.repeat(201) }, 'title-too-long'],
    [{ title: 123 }, 'empty-title'],
    [{ project: 'p'.repeat(61) }, 'project-too-long'],
    [{ project: 42 }, 'bad-project'],
  ];
  for (const [patch, reason] of cases) {
    const response = await call(routes.get('/worktodo/update').handler, {
      method: 'POST', url: '/worktodo/update', body: { ref: id, ...patch },
    });
    eq(response.statusCode, 200, '输入错误沿用既有「200 + ok:false」约定：');
    const body = response.json();
    eq(body.ok, false, `${JSON.stringify(patch)} 必须被拒：`);
    eq(body.reason, reason, `${JSON.stringify(patch)} 的原因码：`);
    const record = await readRecord();
    eq(record.title, '校验基准', '被拒的标题补丁不能写进记录：');
    eq(record.project, 'base-proj', '被拒的项目补丁不能写进记录：');
  }

  // 合法输入：trim 后落库（与 createRecord 的归一化口径一致）。
  const ok = await call(routes.get('/worktodo/update').handler, {
    method: 'POST', url: '/worktodo/update', body: { ref: id, title: '  新名字  ', project: '  新项目  ' },
  });
  eq(ok.json().ok, true);
  eq(ok.json().data.todo.title, '新名字', 'title 必须 trim 后落库：');
  eq(ok.json().data.todo.project, '新项目', 'project 必须 trim 后落库：');
});

await test('请求体不是 JSON → 明确报错而不是崩', async () => {
  const response = await call(routes.get('/worktodo/create').handler, { method: 'POST', url: '/worktodo/create', body: '{ 坏 JSON' });
  eq(response.statusCode, 200);
  const body = response.json();
  eq(body.ok, false);
  eq(body.reason, 'internal');
  eq(body.error.includes('JSON'), true, '错误里要说明是 JSON 问题：');
});

await test('未知 filter → bad-filter', async () => {
  const response = await call(routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list?filter=乱写' });
  const body = response.json();
  eq(body.ok, false);
  eq(body.reason, 'bad-filter');
});

console.log('工具执行');

await test('worktodo_add 工具写进同一份列表，并按 schema 渲染文本', async () => {
  const add = tools.find((t) => t.name === 'worktodo_add');
  const value = await add.execute({ title: '用工具加的', due: 'tomorrow' }, {});
  eq(value.title, '用工具加的');
  eq(typeof value.stats.open, 'number', '工具返回要带统计：');
  const rendered = add.output.render({ title: '用工具加的' }, value);
  eq(Array.isArray(rendered), true);
  eq(rendered[0].type, 'text');
  eq(rendered[0].text.includes('用工具加的'), true);
});

await test('worktodo_list 工具能读到工具自己刚加的那条', async () => {
  const list = tools.find((t) => t.name === 'worktodo_list');
  const value = await list.execute({ filter: 'open' }, {});
  eq(value.lines.includes('用工具加的'), true);
  eq(value.count >= 1, true);
});

await test('worktodo_done 工具完成一条，列表里落到 completed', async () => {
  const done = tools.find((t) => t.name === 'worktodo_done');
  const value = await done.execute({ ref: '用工具加的' }, {});
  eq(value.status, 'completed');
  const list = await tools.find((t) => t.name === 'worktodo_list').execute({ filter: 'completed' }, {});
  eq(list.lines.includes('用工具加的'), true);
});

await test('工具失败时抛带指引的错误（模型看得懂怎么补救）', async () => {
  const done = tools.find((t) => t.name === 'worktodo_done');
  let message = null;
  try {
    await done.execute({ ref: '根本不存在的待办' }, {});
  } catch (error) {
    message = String(error?.message ?? error);
  }
  eq(typeof message, 'string');
  eq(message.includes('worktodo_list'), true, '错误里要提示下一步该查列表：');
});

await test('工具入参不合法时被官方校验挡下（不是悄悄写进去）', async () => {
  const add = tools.find((t) => t.name === 'worktodo_add');
  let threw = false;
  try {
    await add.execute({}, {});
  } catch {
    threw = true;
  }
  eq(threw, true, '缺 title 应当被拒绝：');
});

console.log('工具返回值必须是 lossless JSON');

/**
 * 结构化深比较：JSON 往返丢掉的键（例如值为 undefined 的可选字段）会让这里不相等。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join('\u0000') !== kb.join('\u0000')) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

/**
 * 断言工具返回值能被 JSON 无损往返——**用 DSH 自己的校验器**。
 *
 * 真机上踩过的坑：`{ due: undefined }` 会被判为「value is not lossless JSON」，整次工具调用被拒，
 * 而「加一条没有截止日期的待办」是最常见的用法。
 *
 * 这里不自己写近似实现，而是直接调用判定这件事的那一个函数：
 * `@deepseek-ai/dsh-tools` 在 registry 里就是这样做的（其 lib/index.js 的
 * `snapshotToolValue()`：`const detached = snapshotJsonValue(candidate); if (detached === void 0) throw new ToolOutputError(toolName, ["value is not lossless JSON"])`），
 * 而 `snapshotJsonValue` 来自 `@deepseek-ai/dsh-util-values`。用同一个函数，测的就是同一条判定。
 * 结构化深比较留作第二道：它能指出具体是哪个键丢了。
 * @param {unknown} value
 * @param {string} label
 */
function assertLossless(value, label) {
  const real = snapshotJsonValue(value);
  if (real === undefined) {
    throw new Error(`${label} 被 DSH 真实校验器判为非 lossless JSON（snapshotJsonValue 返回 undefined）`);
  }
  const roundTripped = JSON.parse(JSON.stringify(value));
  if (!deepEqual(value, roundTripped)) {
    const dropped = Object.keys(value ?? {}).filter((k) => !(k in (roundTripped ?? {})));
    throw new Error(`${label} 的返回值在 JSON 往返中丢键${dropped.length ? `：${dropped.join(', ')}` : ''}`);
  }
}

await test('守卫本身有牙齿：DSH 真校验器确实拒绝旧写法（due: undefined）', () => {
  // 这条把「当初真机为什么失败」钉死成可复现的断言：
  // 旧代码返回 { due: undefined }，snapshotJsonValue 返回 undefined → 整次调用被拒
  eq(snapshotJsonValue({ id: 'x', due: undefined }), undefined, 'undefined 值必须被拒：');
  eq(snapshotJsonValue({ id: 'x', due: null }) !== undefined, true, 'null 是合法值：');
  eq(snapshotJsonValue({ n: Number.NaN }), undefined, 'NaN 必须被拒：');
});

await test('worktodo_add 不传截止日期/项目时返回值仍然无损（可选键必须缺席而不是 undefined）', async () => {
  const add = tools.find((t) => t.name === 'worktodo_add');
  const value = await add.execute({ title: '没有截止日期的事' }, {});
  assertLossless(value, 'worktodo_add');
  eq('due' in value, false, 'due 应当缺席：');
  eq('project' in value, false, 'project 应当缺席：');
  // 渲染也不能因为缺字段而崩
  const rendered = add.output.render({ title: '没有截止日期的事' }, value);
  eq(rendered[0].text.includes('没有截止日期的事'), true);
});

await test('worktodo_update 清空截止日期后返回值仍然无损', async () => {
  const add = tools.find((t) => t.name === 'worktodo_add');
  const created = await add.execute({ title: '有截止日期的事', due: 'tomorrow' }, {});
  const update = tools.find((t) => t.name === 'worktodo_update');
  const cleared = await update.execute({ ref: created.id, due: 'none' }, {});
  assertLossless(cleared, 'worktodo_update');
  eq('due' in cleared, false, '清空后 due 应当缺席：');
});

await test('其余工具的返回值逐个无损（含删除这类只回 id/title 的）', async () => {
  const add = tools.find((t) => t.name === 'worktodo_add');
  const created = await add.execute({ title: '待删除的事' }, {});

  const list = tools.find((t) => t.name === 'worktodo_list');
  assertLossless(await list.execute({ filter: 'open' }, {}), 'worktodo_list');
  assertLossless(await list.execute({ filter: 'all', project: '不存在的项目' }, {}), 'worktodo_list(空结果)');

  const done = tools.find((t) => t.name === 'worktodo_done');
  assertLossless(await done.execute({ ref: created.id }, {}), 'worktodo_done');
  assertLossless(await done.execute({ ref: created.id, status: 'pending' }, {}), 'worktodo_done(pending)');

  const adopt = tools.find((t) => t.name === 'worktodo_adopt');
  assertLossless(await adopt.execute({ todos: [{ content: '从会话提升的事', status: 'pending' }] }, {}), 'worktodo_adopt');
  assertLossless(await adopt.execute({ todos: [{ content: '从会话提升的事', status: 'pending' }] }, {}), 'worktodo_adopt(全部重复)');

  const remove = tools.find((t) => t.name === 'worktodo_remove');
  assertLossless(await remove.execute({ ref: created.id }, {}), 'worktodo_remove');
});

await test('每个工具的输出 schema 都不把可选字段写成必填', () => {
  for (const tool of tools) {
    const required = tool.output?.schema?.required ?? [];
    for (const optional of ['due', 'project', 'notes', 'stats']) {
      eq(required.includes(optional), false, `${tool.name} 的 ${optional} 不应必填：`);
    }
  }
});

// 清理
try {
  rmSync(root, { recursive: true, force: true });
} catch { /* 清理失败不影响结论 */ }

await test('GET /list 的载荷带 projectGroups（面板「按项目」视图所需）', async () => {
  // 先自建两条（含项目与未归类），再断言分桶——前面的用例已经把存储清空了
  await call(routes.get('/worktodo/create').handler, {
    method: 'POST', url: '/worktodo/create',
    body: { title: '按项目分组 A', project: 'alpha' },
  });
  await call(routes.get('/worktodo/create').handler, {
    method: 'POST', url: '/worktodo/create',
    body: { title: '按项目分组 B' },
  });
  const response = await call(routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list?filter=all' });
  eq(response.statusCode, 200);
  const buckets = response.json()?.data?.projectGroups;
  eq(Array.isArray(buckets), true, 'projectGroups 应当是数组：');
  eq(buckets.some((b) => b.project === 'alpha'), true, '应当有 alpha 桶：');
  eq(buckets.some((b) => b.project === null), true, '应当有未归类桶（project 为 null）：');
  for (const bucket of buckets) {
    eq(typeof bucket.total, 'number');
    eq(typeof bucket.open, 'number');
    eq(typeof bucket.overdue, 'number');
    eq(Array.isArray(bucket.todos), true);
  }
  eq(buckets[buckets.length - 1].project, null, '未归类必须在最后一个桶：');
});

await test('S3-3：/list?shapes=todos 只回一份（不再是同一批数据的 3 倍）；缺省仍是三份（旧面板兼容）', async () => {
  const only = await call(routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list?filter=all&shapes=todos' });
  eq(only.statusCode, 200);
  const data = only.json()?.data;
  eq('todos' in data, true);
  eq('groups' in data, false, '只要 todos 时不该再返回 groups：');
  eq('projectGroups' in data, false, '也不该返回 projectGroups：');
  eq(data.shapes, ['todos']);
  eq(Array.isArray(data.todos), true);
  eq(typeof data.stats.total, 'number', '统计/诊断这些小字段不能一起被省掉：');
  eq(typeof data.store.kind, 'string');

  const groupsOnly = await call(routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list?filter=all&shapes=groups' });
  eq('groups' in groupsOnly.json().data, true);
  eq('todos' in groupsOnly.json().data, false);

  const full = await call(routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list?filter=all' });
  const fullData = full.json().data;
  eq([['todos' in fullData, 'groups' in fullData, 'projectGroups' in fullData]], [[true, true, true]],
    '缺省必须保持旧面板读到三个字段：');
  eq(fullData.shapes, ['todos', 'groups', 'projectGroups']);
});

// ---- 面板第二行的「项目」选择器（/list 提供清单，/create 落库） ----

await test('GET /list 在任何 shapes 下都带 projects / projectsTruncated（面板项目选择器的数据来源）', async () => {
  // 前面的用例已经建过 project='alpha' 的记录；这里只验「字段在不在、内容对不对」
  for (const shapes of [null, 'todos', 'groups', 'projectGroups', 'todos,groups']) {
    const suffix = shapes ? `&shapes=${shapes}` : '';
    const response = await call(routes.get('/worktodo/list').handler, {
      method: 'GET', url: `/worktodo/list?filter=all${suffix}`,
    });
    eq(response.statusCode, 200);
    const data = response.json()?.data;
    eq(Array.isArray(data.projects), true, `shapes=${shapes} 时 projects 必须是数组：`);
    eq(typeof data.projectsTruncated, 'boolean', `shapes=${shapes} 时 projectsTruncated 必须是布尔：`);
    eq(data.projects.includes('alpha'), true, `shapes=${shapes} 时清单要含 alpha：`);
    // 小字段不受 shapes 影响：只要 todos 时也不能把它们一起省掉（面板任何视图都要用）
    eq(typeof data.stats.total, 'number', `shapes=${shapes} 时 stats 不能丢：`);
  }
});

await test('GET /list 的 projects 按出现次数降序（不是字典序），次数相同按名称升序', async () => {
  const create = (title, project) => call(routes.get('/worktodo/create').handler, {
    method: 'POST', url: '/worktodo/create', body: { title, project },
  });
  // zzz-sort 造 3 次、aaa-sort 造 1 次：字典序会把 aaa-sort 排前面，次数降序不会
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await create(`排序用例 z${i}`, 'zzz-sort');
  }
  await create('排序用例 a', 'aaa-sort');

  const data = (await call(routes.get('/worktodo/list').handler, {
    method: 'GET', url: '/worktodo/list?filter=all&shapes=groups',
  })).json().data;
  const z = data.projects.indexOf('zzz-sort');
  const a = data.projects.indexOf('aaa-sort');
  eq(z !== -1 && a !== -1, true, `两个项目都要在清单里：${JSON.stringify(data.projects)}`);
  eq(z < a, true, `常用的（3 次）必须排在只用过 1 次的前面：${JSON.stringify(data.projects)}`);

  // 次数相同 → 名称升序：aaa-tie / bbb-tie 各 1 次
  await create('平局 a', 'aaa-tie');
  await create('平局 b', 'bbb-tie');
  const tie = (await call(routes.get('/worktodo/list').handler, {
    method: 'GET', url: '/worktodo/list?filter=all&shapes=todos',
  })).json().data.projects;
  eq(tie.indexOf('aaa-tie') < tie.indexOf('bbb-tie'), true, `次数相同按名称升序：${JSON.stringify(tie)}`);
});

await test('POST /create 带 project 落库并被 /list 的 projects 反映；POST /update 可改可清空（project:null）', async () => {
  const created = await call(routes.get('/worktodo/create').handler, {
    method: 'POST', url: '/worktodo/create',
    body: { title: '项目选择器落库', project: 'picker-proj' },
  });
  eq(created.json().data.todo.project, 'picker-proj');
  const afterCreate = (await call(routes.get('/worktodo/list').handler, {
    method: 'GET', url: '/worktodo/list?filter=all&shapes=groups',
  })).json().data;
  eq(afterCreate.projects.includes('picker-proj'), true, 'create 的项目要进 /list 的 projects：');

  const id = created.json().data.todo.id;
  const changed = await call(routes.get('/worktodo/update').handler, {
    method: 'POST', url: '/worktodo/update', body: { ref: id, project: 'picker-proj-2' },
  });
  eq(changed.json().data.todo.project, 'picker-proj-2');
  const afterUpdate = (await call(routes.get('/worktodo/list').handler, {
    method: 'GET', url: '/worktodo/list?filter=all&shapes=todos',
  })).json().data;
  eq(afterUpdate.projects.includes('picker-proj-2'), true, 'update 改过的项目要进清单：');
  eq(afterUpdate.projects.includes('picker-proj'), false, '旧项目名不该继续留在清单里（除非还有别条在用）：');

  // 面板的「未归类」= project: null（空串也走同一条清空语义）
  const cleared = await call(routes.get('/worktodo/update').handler, {
    method: 'POST', url: '/worktodo/update', body: { ref: id, project: null },
  });
  eq(cleared.json().data.todo.project, null, 'project:null 必须清空：');
  const afterClear = (await call(routes.get('/worktodo/list').handler, {
    method: 'GET', url: '/worktodo/list?filter=all&shapes=projectGroups',
  })).json().data;
  eq(afterClear.projects.includes('picker-proj-2'), false, '清空后项目不该再出现在清单里：');
});

await test('GET /list 的 projects 超过 50 个时截断并置 projectsTruncated=true（面板据此提示「只显示常用项」）', async () => {
  for (let i = 0; i < 60; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await call(routes.get('/worktodo/create').handler, {
      method: 'POST', url: '/worktodo/create',
      body: { title: `截断用例 ${i}`, project: `bulk-${String(i).padStart(2, '0')}` },
    });
  }
  const data = (await call(routes.get('/worktodo/list').handler, {
    method: 'GET', url: '/worktodo/list?filter=all&shapes=projectGroups',
  })).json().data;
  eq(data.projects.length, 50, '只回前 50 个：');
  eq(data.projectsTruncated, true, '截断时必须显式置 true：');
});

// ---- AI 友好：批量登记 + 给模型的用法指引 ----

await test('worktodo_add_many 一次登记多条，坏的那条只跳过它自己', async () => {
  const many = tools.find((t) => t.name === 'worktodo_add_many');
  const value = await many.execute({
    items: [
      { title: '批量 A', project: 'alpha', priority: 'high' },
      { title: '批量 B', due: 'tomorrow' },
      { title: '   ' }, // 空标题：应当被跳过并给出原因
    ],
  }, {});
  eq(value.count, 2);
  eq(value.created.length, 2);
  eq(value.skipped.length, 1);
  eq(value.skipped[0].index, 2);
  eq(typeof value.skipped[0].reason === 'string' && value.skipped[0].reason.length > 0, true, '跳过要带原因：');
  eq(value.created[0].title, '批量 A');
  eq(value.created[0].priority, 'high');
});

await test('注册了给模型的用法指引（systemPrompt.section，order 在工具段之后）', () => {
  const section = systemPromptSections.find((item) => item?.name === 'worktodo:guidance');
  eq(Boolean(section), true, '没有注册 worktodo:guidance 段落：');
  eq(Number.isFinite(section.order), true, 'order 必须是有限数：');
  eq(section.order > 3000, true, 'order 应排在官方内置工具段（1000–3000）之后：');
  for (const needle of ['worktodo_add', 'worktodo_list', 'todo_write']) {
    eq(section.text.includes(needle), true, `指引里应当提到 ${needle}：`);
  }
});

// ---- 排序与手动拖动 ----

await test('GET /list?sort=created 按创建时间倒序（新加的在前）', async () => {
  await call(routes.get('/worktodo/create').handler, { method: 'POST', url: '/worktodo/create', body: { title: '排序·较旧', project: 'sortcase' } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await call(routes.get('/worktodo/create').handler, { method: 'POST', url: '/worktodo/create', body: { title: '排序·较新', project: 'sortcase' } });
  const response = await call(routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list?filter=all&sort=created&project=sortcase' });
  eq(response.statusCode, 200);
  const payload = response.json()?.data;
  eq(payload.sort, 'created');
  eq(payload.todos.map((t) => t.title), ['排序·较新', '排序·较旧']);
});

await test('POST /reorder 落盘手动顺序，并在 manual 模式下生效', async () => {
  const created = [];
  for (const title of ['拖动 A', '拖动 B', '拖动 C']) {
    const res = await call(routes.get('/worktodo/create').handler, { method: 'POST', url: '/worktodo/create', body: { title, project: 'dragcase' } });
    created.push(res.json().data.todo.id);
  }
  // 反转顺序：C, B, A
  const reversed = [...created].reverse();
  const reorder = await call(routes.get('/worktodo/reorder').handler, { method: 'POST', url: '/worktodo/reorder', body: { ids: reversed } });
  eq(reorder.statusCode, 200);
  eq(reorder.json().data.updated >= 1, true, '至少应更新一条：');
  const listed = await call(routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list?filter=all&sort=manual&project=dragcase' });
  eq(listed.json().data.todos.map((t) => t.title), ['拖动 C', '拖动 B', '拖动 A']);
  // 坏输入：不存在的 id 必须显式失败，而不是静默改一半
  const bad = await call(routes.get('/worktodo/reorder').handler, { method: 'POST', url: '/worktodo/reorder', body: { ids: ['不存在的-id'] } });
  eq(bad.json().ok, false);
  eq(bad.json().reason, 'not-found');
});

await test('GET /list 的载荷带 version 与 update（面板角落的版本信息）', async () => {
  const response = await call(routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list?filter=all' });
  const payload = response.json()?.data;
  eq(payload.version, PKG_VERSION, '载荷里的版本应等于 package.json：');
  eq(typeof payload.update, 'object', 'update 应当是个对象：');
  eq(payload.update.current, PKG_VERSION);
  eq(typeof payload.update.page === 'string' && payload.update.page.includes('npmjs.com'), true, 'update.page 应指向 npm 页面：');
  // 关了更新检查时不该声称有新版本
  eq(payload.update.hasUpdate, false);
});

console.log('存储后端与变更通知（审计 F1 / F7）');

await test('apply 两次（同一 storageDomain）不降级、不丢数据，domain/changed 真的接到 health', async () => {
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'worktodo-host-home-'));
  process.env.DSH_HOME = home; // 不传 storePath 时会读写 DSH_HOME，绝不能碰真实 ~/.dsh
  try {
    const facility = makeFakeDomainFacility();
    const host = makeCtx({ storageDomain: facility });
    await apply(host.ctx, {});
    await new Promise((resolve) => setTimeout(resolve, 30));

    const healthA = (await call(host.routes.get('/worktodo/health').handler, { method: 'GET', url: '/worktodo/health' })).json();
    eq(healthA.store.kind, 'domain', 'storageDomain 可用时应选 domain 后端：');

    const created = await call(host.routes.get('/worktodo/create').handler, {
      method: 'POST', url: '/worktodo/create', body: { title: '共享的数据' },
    });
    eq(created.json().ok, true);

    // 二次挂载：官方对同名领域的第二次 open 抛 already-open——0.2.0 就是在这里静默降级到文件的
    await apply(host.ctx, {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    eq(facility.calls.open, 1, '同一服务上只应打开一次领域：');
    const listed = await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list?filter=all' });
    eq(listed.json().data.todos.map((t) => t.title), ['共享的数据'], '二次挂载不能丢数据：');
    const healthB = (await call(host.routes.get('/worktodo/health').handler, { method: 'GET', url: '/worktodo/health' })).json();
    eq(healthB.store.kind, 'domain', '二次挂载不能降级到回退文件：');

    // F7：别的写入者发的 domain/changed → store.onChanged → service.onChange → health 计数
    const before = healthB.changes.count;
    host.ctx.emit('domain/changed', { domain: 'worktodo' });
    const after = (await call(host.routes.get('/worktodo/health').handler, { method: 'GET', url: '/worktodo/health' })).json().changes.count;
    eq(after, before + 1, '外部变更必须通知到服务监听者（原来 onChanged/onChange 是死代码）：');

    // 注销函数挂在 ctx.effect 上：注销后不该继续收到变更（不泄漏）
    for (const effect of host.effects.filter((e) => e.label === 'worktodo: store change events')) effect.dispose?.();
    host.ctx.emit('domain/changed', { domain: 'worktodo' });
    const still = (await call(host.routes.get('/worktodo/health').handler, { method: 'GET', url: '/worktodo/health' })).json().changes.count;
    eq(still, after, '注销后不该再收到变更：');

    // 卸载释放领域句柄（close 挂在 effect 上，否则二次挂载会撞 already-open）
    for (const effect of host.effects.filter((e) => e.label === 'worktodo: store lifecycle')) effect.dispose?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    eq(facility.calls.close >= 1, true, '卸载时应释放领域句柄：');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

await test('卸载后立刻重载：清理可 await，新句柄仍是 domain（不撞 already-open 降级到 file，复审 R2）', async () => {
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'worktodo-host-reload-'));
  process.env.DSH_HOME = home;
  try {
    const facility = makeFakeDomainFacility();
    const host = makeCtx({ storageDomain: facility });
    await apply(host.ctx, {});
    const healthA = (await call(host.routes.get('/worktodo/health').handler, { method: 'GET', url: '/worktodo/health' })).json();
    eq(healthA.store.kind, 'domain');
    await call(host.routes.get('/worktodo/create').handler, { method: 'POST', url: '/worktodo/create', body: { title: '卸载前的数据' } });

    // 卸载：生命周期清理必须**返回** close 的 promise（cordis 会 await 它）。
    // 原来是 fire-and-forget，卸载与重载重叠时会在「注册表已摘、领域还没关完」的窗口里撞 already-open。
    const lifecycle = host.effects.filter((e) => e.label === 'worktodo: store lifecycle');
    const closing = lifecycle.map((effect) => effect.dispose?.());
    eq(closing.some((p) => p && typeof p.then === 'function'), true, '清理函数必须返回可 await 的 promise（不能在飞行中返回）：');
    host.logs.length = 0;

    // 立刻重载：不等关闭完成
    await apply(host.ctx, {});
    const healthB = (await call(host.routes.get('/worktodo/health').handler, { method: 'GET', url: '/worktodo/health' })).json();
    eq(healthB.store.kind, 'domain', '立刻重载也必须仍然是 domain（不能停在 file 后端）：');
    eq(healthB.store.mismatch, null, '不该留下「后端不一致」：');
    eq(host.logs.some((line) => line.includes('already open')), false, `不能撞官方 already-open：${host.logs.filter((l) => l.includes('storage')).join(' | ')}`);
    const listed = await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list?filter=all' });
    eq(listed.json().data.todos.map((t) => t.title), ['卸载前的数据'], '重载不能丢数据：');
    eq(facility.records.size, 1);
    await Promise.all(closing);
    // 收尾：把新实例的句柄也放掉
    for (const effect of host.effects.filter((e) => e.label === 'worktodo: store lifecycle')) await effect.dispose?.();
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

await test('数据读不出来时 /health 报 count:null + countError，而不是假装 count:0（复审 R4 / 审计 F16）', async () => {
  const previousHome = process.env.DSH_HOME;
  const home = mkdtempSync(join(tmpdir(), 'worktodo-host-health-'));
  process.env.DSH_HOME = home;
  try {
    const facility = makeFakeDomainFacility();
    const host = makeCtx({ storageDomain: facility });
    await apply(host.ctx, {});
    await call(host.routes.get('/worktodo/create').handler, { method: 'POST', url: '/worktodo/create', body: { title: '先存一条' } });

    const ok = (await call(host.routes.get('/worktodo/health').handler, { method: 'GET', url: '/worktodo/health' })).json();
    eq(ok.count, 1, '正常时 count 是个数：');
    eq(ok.countError, null);

    // 复审 R4/R5：面板只能看到 /list 载荷 —— 诊断字段必须真的在它里面，否则页脚无从渲染
    const listOk = (await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list?filter=all' })).json();
    eq(listOk.ok, true);
    for (const key of ['mismatch', 'split', 'merge', 'retired', 'backendError']) {
      eq(key in listOk.data.store, true, `/list 的 store 必须带 ${key}（面板页脚要渲染这些告警）：`);
    }

    facility.control.failLoad = true;
    const bad = (await call(host.routes.get('/worktodo/health').handler, { method: 'GET', url: '/worktodo/health' })).json();
    eq(bad.ok, true, 'health 路由本身不该 500：');
    eq(bad.count, null, '读不出来时必须 count:null —— 报 0 会让人以为待办真的没了：');
    eq(typeof bad.countError === 'string' && bad.countError.includes('领域读不出来'), true, `要给失败原因：${bad.countError}`);
    eq(bad.store.kind, 'domain', '后端不该因为读失败就换：');
    eq(typeof bad.store.backendError, 'string', 'describe() 里也要有这条错误：');
    eq(bad.store.backendError.includes('domain') && bad.store.backendError.includes('读取失败'), true, `错误要说清是哪个后端的什么操作：${bad.store.backendError}`);

    facility.control.failLoad = false;
    const back = (await call(host.routes.get('/worktodo/health').handler, { method: 'GET', url: '/worktodo/health' })).json();
    eq(back.count, 1, '恢复后 count 要回到真实条数：');
    eq(back.countError, null, '恢复后错误要清掉：');
    eq(back.store.backendError, null);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

console.log('S1-1：路由注册失败只能降级那一条（不泄漏、不毒化后续挂载）');

await test('S1-1：第 N 条路由注册抛错 → apply 不 reject、其余路由照常且卸载时清干净、随后正常挂载不撞 duplicate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worktodo-host-routefail-'));
  try {
    for (const failAt of [1, 3, 8, 9]) {
      // 服务级路由表在 apply 之间共享（真实 DSH 就是这样：路由进了服务，不属于某个 ctx）
      const server = makeServerLevelWebServer({ failAt });
      const bad = makeCtx({ webServer: server });
      let applyError = null;
      try {
        await apply(bad.ctx, { storePath: join(dir, `bad-${failAt}.json`) });
      } catch (error) {
        applyError = error;
      }
      eq(applyError, null, `第 ${failAt} 条失败时 apply 绝不能 reject（改前工具与路由一起消失）：`);
      // 单条失败只丢那一条，其余照常（改前是「回调中途抛出 → 前 N-1 条泄漏 + 后面全没」）
      eq(server.table.size, 8, `只有失败的那一条该缺失，实际路由表：${[...server.table.keys()]}`);
      eq(server.table.has(server.calls.failed[0]), false, `失败的那条不该进路由表：${server.calls.failed[0]}`);
      eq(server.calls.register, 9, `9 条都要被尝试注册（失败一条不影响其余）：实际尝试 ${server.calls.register} 次`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      eq(bad.tools.length, 7, `第 ${failAt} 条失败不能连累工具注册（改前 7 个工具全没）：`);

      // 卸载：那些已经注册成功的必须被 disposer 清掉，绝不留服务级残留
      for (const effect of bad.effects.filter((e) => e.label === 'worktodo: http routes')) await effect.dispose?.();
      eq(server.table.size, 0, `卸载后不许留下任何服务级路由（改前残留 ${failAt - 1} 条 → 只能重启 DSH）：`);

      // 随后一次完全正常的挂载：不能撞 duplicate exact route
      const good = makeCtx({ webServer: server });
      let goodError = null;
      try {
        await apply(good.ctx, { storePath: join(dir, `good-${failAt}.json`) });
      } catch (error) {
        goodError = error;
      }
      eq(goodError, null, `第 ${failAt} 条失败后，下一次正常挂载不该撞 duplicate exact route（改前必须重启 DSH）：`);
      eq(server.table.size, 9, '正常挂载应当 9 条路由都在：');
      for (const effect of good.effects.filter((e) => e.label === 'worktodo: http routes')) await effect.dispose?.();
      eq(server.table.size, 0, '正常挂载卸载后同样不留残留：');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('S1-2：storageDomain.open 永不 resolve → 超时后 apply 仍然返回并完整挂载（9 路由 / 7 工具）', async () => {
  const previousHome = process.env.DSH_HOME;
  const previousTimeout = process.env.WORKTODO_UPGRADE_TIMEOUT_MS;
  const dir = mkdtempSync(join(tmpdir(), 'worktodo-host-hang-'));
  process.env.DSH_HOME = dir;
  process.env.WORKTODO_UPGRADE_TIMEOUT_MS = '120'; // 测试里把默认 3s 缩短（同一类测试缝）
  try {
    const hanging = { open: () => new Promise(() => {}) }; // 永不 resolve
    const host = makeCtx({ storageDomain: hanging });
    const t0 = process.hrtime.bigint();
    let applyError = null;
    try {
      await apply(host.ctx, {});
    } catch (error) {
      applyError = error;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    eq(applyError, null, 'open 挂住时 apply 也不能抛（要降级，而不是半死）：');
    eq(ms < 2000, true, `apply 必须被超时兜住（改前永不返回；实际 ${ms.toFixed(0)}ms）：`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    eq(host.routes.size, 9, '超时后 9 条路由照常注册（面板可用）：');
    eq(host.tools.length, 7, '超时后 7 个工具照常注册：');
    eq(host.logs.some((line) => line.startsWith('warn') && line.includes('超时')), true,
      `超时必须告警（不静默）：${host.logs.filter((l) => l.includes('storage')).join(' | ')}`);
    const health = (await call(host.routes.get('/worktodo/health').handler, { method: 'GET', url: '/worktodo/health' })).json();
    eq(health.store.kind, 'file', '超时后要降级到回退文件：');
    eq(String(health.store.mismatch).includes('超时'), true, `health/面板要能看见超时原因：${health.store.mismatch}`);
    const listed = await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list?filter=all' });
    eq(listed.json().ok, true, '超时后业务路由照常工作：');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousTimeout === undefined) delete process.env.WORKTODO_UPGRADE_TIMEOUT_MS;
    else process.env.WORKTODO_UPGRADE_TIMEOUT_MS = previousTimeout;
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log('S4-2 / S4-3：请求体读取必须有时间上限，失败必须给明确状态码');

/**
 * 半包请求：声明了 body 却**永远不 end**（慢客户端 / 不关 socket）。
 * 审计 S4-2 的复现条件：旧实现只监听 data/end/error，这个请求永远不会 settle。
 * @param {{method?: string, url?: string, body?: string, [key: string]: any}} [options]
 */
function makeHalfOpenRequest({ method = 'POST', url, body = '{"title":"半包' } = {}) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = url;
  req.push(body); // 注意：不 push(null) → 'end' 永远不来
  return req;
}

await test('S4-2：半包/不结束的请求在超时后回 408 + 原因，handler 绝不悬挂', async () => {
  const previousTimeout = process.env.WORKTODO_BODY_TIMEOUT_MS;
  process.env.WORKTODO_BODY_TIMEOUT_MS = '120'; // 测试里把默认 5s 缩短（同一类测试缝）
  const dir = mkdtempSync(join(tmpdir(), 'worktodo-host-body-'));
  try {
    const host = makeCtx();
    await apply(host.ctx, { storePath: join(dir, 'todos.json') });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const response = makeResponse();
    const started = Date.now();
    const settled = await Promise.race([
      host.routes.get('/worktodo/create').handler(makeHalfOpenRequest({ url: '/worktodo/create' }), response)
        .then(() => true),
      // 反向验证的安全网：改前这里会一直挂着（靠 Node 默认 300s 的 requestTimeout 兜底）
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    const ms = Date.now() - started;

    eq(settled, true, `handler 必须在超时后 settle（改前会挂住不返回；已等 ${ms}ms）：`);
    eq(response.statusCode, 408, `超时必须回 408（实际 ${response.statusCode}）：`);
    const body = response.json();
    eq(body.ok, false);
    eq(body.reason, 'body-timeout');
    eq(String(body.error).includes('超时'), true, `要说明是超时：${body.error}`);
    eq(ms < 1500, true, `要在超时值附近就返回（实际 ${ms}ms）：`);

    // 之后的请求照常，坏请求没有留下任何坏状态
    const after = await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' });
    eq(after.statusCode, 200);
    eq(after.json().ok, true, '超时请求之后业务必须照常：');
  } finally {
    if (previousTimeout === undefined) delete process.env.WORKTODO_BODY_TIMEOUT_MS;
    else process.env.WORKTODO_BODY_TIMEOUT_MS = previousTimeout;
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('S4-3：超限请求体先回明确的 413 + 原因再关连接（客户端不再只看到 ECONNRESET）', async () => {
  const http = await import('node:http');
  const net = await import('node:net');
  const dir = mkdtempSync(join(tmpdir(), 'worktodo-host-413-'));
  let server = null;
  try {
    const host = makeCtx();
    await apply(host.ctx, { storePath: join(dir, 'todos.json') });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const handler = host.routes.get('/worktodo/create').handler;
    // 真 http.Server + 裸 socket：只有真连接才验证得了「客户端到底看到什么」
    server = http.createServer((req, res) => { void handler(req, res); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const raw = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('POST /worktodo/create HTTP/1.1\r\nHost: localhost\r\n'
          + 'Content-Type: application/json\r\nContent-Length: 900000\r\n\r\n');
        // 只发 300 KiB（> 256 KiB 上限），然后**不结束**请求：超限必须立刻被挡下
        socket.write(`{"title":"${'x'.repeat(300 * 1024)}`);
      });
      let text = '';
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try { socket.destroy(); } catch { /* 已关 */ }
        resolve(text);
      };
      socket.on('data', (chunk) => { text += chunk.toString('utf8'); });
      socket.on('error', (error) => { text += `[ERR ${error.code}]`; finish(); });
      socket.on('close', finish);
      setTimeout(finish, 3000);
    });

    eq(raw.includes('413'), true, `客户端必须拿到明确的 413（改前只有 ECONNRESET socket hang up）：${raw.split('\r\n')[0] ?? raw}`);
    eq(raw.includes('body-too-large'), true, `响应体要带稳定的原因码：${raw.slice(-160)}`);
    eq(raw.includes('ECONNRESET'), false, `不该是连接被掐断：${raw.slice(-160)}`);
  } finally {
    try { server?.close(); } catch { /* 已关 */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('S4-3：超限（同一 chunk 就超）在假 request 流上同样回 413，而不是 200/internal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worktodo-host-413b-'));
  try {
    const host = makeCtx();
    await apply(host.ctx, { storePath: join(dir, 'todos.json') });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const response = await call(host.routes.get('/worktodo/create').handler, {
      method: 'POST',
      url: '/worktodo/create',
      body: `{"title":"${'x'.repeat(300 * 1024)}"}`, // 一次就超过 256 KiB
    });
    eq(response.statusCode, 413, `超限必须回 413（实际 ${response.statusCode}）：`);
    eq(response.json().reason, 'body-too-large');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log('S6-2：重复注册只能降级那一条（补断言钉住宿主/插件已有的兜底）');

await test('S6-2：同名工具重复注册 → apply 不崩、面板照常，health 明确报 tools.status=failed（不静默）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worktodo-host-duptool-'));
  try {
    const host = makeCtx();
    let registered = 0;
    // 复刻官方 tools.register 对重名工具抛错的语义（S6-2）
    host.ctx.tools = {
      register() {
        registered += 1;
        if (registered === 2) throw new Error('tool "worktodo_add_many" already has a registration');
        return () => {};
      },
    };

    let applyError = null;
    try {
      await apply(host.ctx, { storePath: join(dir, 'todos.json') });
    } catch (error) {
      applyError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    eq(applyError, null, '工具注册抛错不能冒到 apply（面板与路由必须照常挂上）：');
    eq(host.routes.size, 9, `工具失败时 9 条路由照常在（实际 ${host.routes.size}）：`);
    const health = (await call(host.routes.get('/worktodo/health').handler, { method: 'GET', url: '/worktodo/health' })).json();
    eq(health.ok, true);
    eq(health.tools.status, 'failed', '工具注册失败必须显式报出来（不静默）：');
    eq(String(health.tools.error).includes('already has a registration'), true, `要带原始原因：${health.tools.error}`);
    eq(health.tools.registered, 0, '当前实现下一条失败会整批不算数（已记进报告的未修项）：');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log('\n自升级（自己升级自己）：link 跳过 / 下载解包 / detached 安装器 / 回滚 / 零 pnpm/CLI / 不阻塞请求');

/**
 * 自升级测试的隔离根目录。
 *
 * 这里解决的是用户真机上的那个问题：面板提示「有新版本 v0.2.4」但装完还是 0.2.0。
 * 所有 profile 都是**临时假目录**，绝不碰用户真实 `~/.dsh`；「子进程」是一个假 pnpm
 *脚本（PATH 注入），它把 argv 写进文件，于是「到底执行了什么命令」可以被逐字断言。
 */
const selfUpdateRoot = mkdtempSync(join(tmpdir(), 'worktodo-selfupdate-'));

/** 建一个假 profile：只有 package.json 里那条 dsh-worktodo 规格是我们在意的。 */
function makeFakeProfile(name, spec) {
  const dir = join(selfUpdateRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: { 'dsh-worktodo': spec },
  }, null, 2));
  return dir;
}

/**
 * 目录快照：逐文件记录**原始字节**（base64）、权限与符号链接目标。
 *
 * 为什么不用 mtime：同一毫秒内的覆盖写可能骗过 mtime；「零写盘」必须逐字节证明。
 * 只读、不跟随符号链接（链接本身也算一项，防止安装过程偷偷改链接）。
 * @param {string} root
 * @returns {Record<string, string>}
 */
function snapshotTree(root) {
  const entries = {};
  const walk = (dir, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      const absolute = join(dir, name);
      const relativeName = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        entries[relativeName] = `symlink:${readlinkSync(absolute)}`;
      } else if (stat.isDirectory()) {
        entries[relativeName] = 'dir';
        walk(absolute, relativeName);
      } else {
        entries[relativeName] = `file:${readFileSync(absolute).toString('base64')}:${stat.mode & 0o777}`;
      }
    }
  };
  walk(root);
  return entries;
}

/**
 * 快照 profile，但**排除本包自己的目录**与安装器留下的备份/临时目录。
 *
 * 安装会替换 `node_modules/dsh-worktodo`（pnpm 下是 `.pnpm/.../node_modules/dsh-worktodo`），
 * 这些本来就要变；其余文件/目录必须逐字节不变，用来证明「只碰自己的目录」。
 * @param {string} root
 * @param {string[]} [extraExcludes] 额外的相对路径前缀
 */
function snapshotOutsideOwnPackage(root, extraExcludes = []) {
  const all = snapshotTree(root);
  const excluded = [
    'node_modules/dsh-worktodo',
    'node_modules/.worktodo-backup-',
    'node_modules/.worktodo-new-',
    'node_modules/.worktodo-broken-',
    ...extraExcludes,
  ];
  const out = {};
  for (const [key, value] of Object.entries(all)) {
    if (excluded.some((prefix) => key === prefix || key.startsWith(prefix))) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 写一组「绊线」可执行文件：pnpm / npm / dsh CLI 一旦被启动就写 capture。
 * 安装路径的硬要求是 capture 必须为 0（零 pnpm/CLI）。
 * @param {string} dir
 * @param {string[]} names
 * @param {string} capture
 */
function writeTripwires(dir, names, capture) {
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const file = join(dir, name);
    writeFileSync(file, [
      '#!/bin/sh',
      `printf 'INVOKE\\n' >> ${shQuote(capture)}`,
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
  }
}

/** 在假 profile 里放一份「已落盘」的安装版本（模拟升级后 node_modules 里的真版本）。 */
function seedInstalledVersion(profileDir, version) {
  const dir = join(profileDir, 'node_modules', 'dsh-worktodo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-worktodo', version }, null, 2));
}

/**
 * 造一个比当前版本新/旧的版本号（只服务测试，不参与生产逻辑）。
 * 从当前版本推而不是硬编码：以后升版本时「更新/更旧」的关系不会因字面量过期而反转。
 */
function bumpPatch(version, delta) {
  const parts = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  parts[2] = Math.max(0, (parts[2] ?? 0) + delta);
  return parts.join('.');
}

/** shell 单引号转义（capture 路径里可能有空格）。 */
function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * 写一个假 pnpm：把每次调用的 argv 追加进 capture 文件（首行是一次 `INVOKE` 标记，
 * 便于数「到底启动了几次」），可指定 sleep 与退出码。
 *
 * `installVersion` 是给「版本到底换没换」用的：设了它，假 pnpm 就会在 `install`
 * （或 `installOn` 指定的子命令）时改写 `<installProfile>/node_modules/dsh-worktodo/package.json`
 * —— 于是同一个假 pnpm 既能演「命令成功但什么都没换」，也能演「真的换版本了」。
 *
 * `specDir` 则是给「命令执行时规格长什么样」用的：每次调用都把当时的 profile `package.json`
 * 抄成 `<specDir>/<子命令>.spec.json`，这样「install 之前规格是否已改写」可以被直接断言。
 *
 * `addSpecText` 模拟**真实的 pnpm `add`**：升级序列的第 3 步现在是
 * `pnpm add dsh-worktodo@<精确版本> --save-exact`（规格改写交给包管理器，插件不再手写 profile JSON），
 * 所以假 pnpm 必须在 `add` 时自己把规格写进清单，才能演「规格被 pnpm 改了」。
 * `addSleepSec` 让 `add` 挂起，用来钉「第 3 步超时也必须回滚规格」。
 * @returns {string} 假 pnpm 的路径（测试把它所在目录塞进 PATH）
 */
function writeFakePnpm(binDir, {
  capture, sleepSec = 0, exitCode = 0, stderrText = '',
  installVersion = null, installProfile = null, installOn = 'install',
  specDir = null, specProfile = null,
  addSpecText = null, addSpecProfile = null, addSleepSec = 0,
  addLockText = null, addLockProfile = null,
}) {
  mkdirSync(binDir, { recursive: true });
  const file = join(binDir, 'pnpm');
  const swap = [];
  if (installVersion) {
    const pkgDir = join(installProfile, 'node_modules', 'dsh-worktodo');
    const condition = installOn === 'any' ? ':' : `[ "$1" = "${installOn}" ]`;
    swap.push(
      `if ${condition}; then`,
      `  mkdir -p ${shQuote(pkgDir)}`,
      `  printf '%s\\n' ${shQuote(JSON.stringify({ name: 'dsh-worktodo', version: installVersion }))} > ${shQuote(join(pkgDir, 'package.json'))}`,
      'fi',
    );
  }
  const rewrite = [];
  if (addSpecText && (addSpecProfile ?? specProfile)) {
    const target = join(addSpecProfile ?? specProfile, 'package.json');
    rewrite.push(`if [ "$1" = "add" ]; then printf '%s' ${shQuote(addSpecText)} > ${shQuote(target)}; fi`);
  }
  // 真实的 pnpm add 会同时改写 package.json 与 pnpm-lock.yaml（C2：回滚必须成对）
  if (addLockText && (addLockProfile ?? addSpecProfile ?? specProfile)) {
    const target = join(addLockProfile ?? addSpecProfile ?? specProfile, 'pnpm-lock.yaml');
    rewrite.push(`if [ "$1" = "add" ]; then printf '%s' ${shQuote(addLockText)} > ${shQuote(target)}; fi`);
  }
  const addSleep = addSleepSec > 0 ? [`if [ "$1" = "add" ]; then sleep ${addSleepSec}; fi`] : [];
  const lines = [
    '#!/bin/sh',
    `printf 'INVOKE\\n' >> ${shQuote(capture)}`,
    `printf '%s\\n' "$@" >> ${shQuote(capture)}`,
    ...(specDir && specProfile ? [
      `mkdir -p ${shQuote(specDir)}`,
      `[ -f ${shQuote(join(specProfile, 'package.json'))} ] && cp ${shQuote(join(specProfile, 'package.json'))} ${shQuote(specDir)}/"$1".spec.json`,
    ] : []),
    ...rewrite,
    ...addSleep,
    stderrText ? `printf '%s\\n' ${shQuote(stderrText)} 1>&2` : ':',
    ...swap,
    sleepSec > 0 ? `sleep ${sleepSec}` : ':',
    `exit ${exitCode}`,
    '',
  ];
  writeFileSync(file, lines.join('\n'), { mode: 0o755 });
  return file;
}

/**
 * 写一个**用 node 直接跑**的假 pnpm（`pnpm.mjs`），服务 Windows 模拟：
 * 真机 Windows 上 `spawn('pnpm')` 会 ENOENT（可执行文件是 `pnpm.cmd`），
 * 修复后首选 `node <pnpm.mjs>`。这个假脚本能证明「子进程真的是 node + pnpm.mjs」：
 * 它被跑起来才会写 capture；旧的裸 `pnpm` 路径在 macOS 模拟里根本不会执行到这里。
 *
 * @param {string} file `.mjs` 路径（WORKTODO_PNPM_PATH）
 * @param {{capture: string, installVersion?: string|null, installProfile?: string|null}} options
 * @returns {string}
 */
function writeFakePnpmMjs(file, { capture, installVersion = null, installProfile = null }) {
  mkdirSync(dirname(file), { recursive: true });
  const lines = [
    "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(capture)}, 'INVOKE\\n' + process.argv.slice(2).join('\\n') + '\\n');`,
  ];
  if (installVersion && installProfile) {
    const pkgDir = join(installProfile, 'node_modules', 'dsh-worktodo');
    lines.push(
      `if (process.argv[2] === 'add') {`,
      `  mkdirSync(${JSON.stringify(pkgDir)}, { recursive: true });`,
      `  writeFileSync(${JSON.stringify(join(pkgDir, 'package.json'))}, ${JSON.stringify(JSON.stringify({ name: 'dsh-worktodo', version: installVersion }, null, 2))});`,
      '}',
    );
  }
  lines.push('', '');
  writeFileSync(file, lines.join('\n'));
  return file;
}

/** 进程是否还活着（进程树用例用它断言孙进程真的没了）。 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return String(error?.code ?? '') !== 'ESRCH';
  }
}

/**
 * 假 pnpm：派生一个**长命孙进程**（每 50ms 往心跳文件追加一个字节），自己再睡很久。
 *
 * 服务 B1：旧实现只 `child.kill()` 直接子进程，孙进程会活下来继续写；修复后
 * `detached:true` + `process.kill(-pid)` 必须把整组杀掉。心跳文件用来证明「不是恰好退出了」。
 */
function writeFakeTreePnpm(file, { capture, heartbeat, pidFile }) {
  mkdirSync(dirname(file), { recursive: true });
  // 孙进程用独立的 .cjs，避免把 JS 源码塞进 shell 的引号里（跨平台/转义都更稳）
  const grandchild = join(dirname(file), 'grandchild.cjs');
  writeFileSync(grandchild, [
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(heartbeat)}, 'x');`,
    `setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, 'x'), 50);`,
    '',
  ].join('\n'));
  const script = [
    '#!/bin/sh',
    `printf 'INVOKE\\n' >> ${shQuote(capture)}`,
    `"${process.execPath}" ${shQuote(grandchild)} &`,
    `echo $! > ${shQuote(pidFile)}`,
    'sleep 30',
    '',
  ].join('\n');
  writeFileSync(file, script, { mode: 0o755 });
  return file;
}

/**
 * 假 pnpm：写下自己的 pid → 睡一段时间 → 改写 profile 并留下 WROTE 标记。
 *
 * 服务 B2：dispose 必须在「睡醒之前」把整棵树杀掉，否则 1.2s 后它就会继续写 profile。
 */
function writeSlowWritingPnpm(file, { capture, pidFile, profile, marker, newSpec, sleepSec = 1.2 }) {
  mkdirSync(dirname(file), { recursive: true });
  const pkg = JSON.stringify({ name: 'dsh-profile-slow-writer', private: true, dependencies: { 'dsh-worktodo': newSpec } });
  const script = [
    '#!/bin/sh',
    `printf 'INVOKE\n' >> ${shQuote(capture)}`,
    `echo $$ > ${shQuote(pidFile)}`,
    `sleep ${sleepSec}`,
    `printf '%s' ${shQuote(pkg)} > ${shQuote(join(profile, 'package.json'))}`,
    `printf 'WROTE\n' >> ${shQuote(marker)}`,
    '',
  ].join('\n');
  writeFileSync(file, script, { mode: 0o755 });
  return file;
}

/**
 * A1 的 ulimit 子场景（父用例 spawn 本文件时带 `--selfupdate-writefail-child`）。
 *
 * 只做一件事：在「写盘必然失败（EFBIG）」的进程里跑一次完整升级序列，然后把状态机原样打印出来。
 * 序列会失败（版本未变）→ 事务收尾要还原被 pnpm 改过的清单 → 那一次还原写盘命中 EFBIG。
 * 父用例检查**盘上文件**：原子写必须保证它仍是合法 JSON 且未被截断。
 */
async function runWriteFailChild() {
  const host = makeCtx();
  await apply(host.ctx, { storePath: process.env.WORKTODO_CHILD_STORE, autoUpdate: false });
  await triggerUpdate(host);
  const status = await waitForUpdateEnd(host, 8000);
  process.stdout.write(`\nA1CHILD_STATUS ${JSON.stringify(status)}\n`);
  process.exit(0);
}

/** 最多等 timeoutMs：每 25ms 查一次条件，命中返回 true。 */
async function waitFor(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * 读假 pnpm/假 CLI 的调用记录：返回**每次调用**的 argv 数组。
 * capture 文件里每遇到一次 `INVOKE` 标记就是一次新调用 —— 于是「启动了几个子进程」
 * 与「每个子进程收到了什么参数」可以分别断言。
 */
function readInvocations(capture) {
  if (!existsSync(capture)) return [];
  const invocations = [];
  for (const line of readFileSync(capture, 'utf8').split('\n')) {
    if (line === 'INVOKE') invocations.push([]);
    else if (line && invocations.length) invocations[invocations.length - 1].push(line);
  }
  return invocations;
}

/** 读假 profile 里 `dsh-worktodo` 的依赖规格（用来钉住「第 2 步真的改写了规格」）。 */
function readProfileSpec(profileDir) {
  const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  return pkg?.dependencies?.['dsh-worktodo'] ?? pkg?.devDependencies?.['dsh-worktodo'] ?? null;
}

/** 读假 pnpm 在某个子命令**执行当时**抄下来的 profile package.json 里的规格。 */
function readSpecFromSpecDir(specDir, subcommand) {
  const file = join(specDir, `${subcommand}.spec.json`);
  if (!existsSync(file)) return null;
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  return pkg?.dependencies?.['dsh-worktodo'] ?? pkg?.devDependencies?.['dsh-worktodo'] ?? null;
}

/** 子进程调用总次数。 */
function invokeCount(capture) {
  return readInvocations(capture).length;
}

/** 临时改环境变量（跑完一定恢复，避免污染其它用例）。 */
async function withEnv(vars, run) {
  const saved = new Map();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** 起一个只用于自升级用例的宿主（独立临时 store，独立配置）。 */
async function makeUpdateHost(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'worktodo-updatehost-'));
  const host = makeCtx();
  await apply(host.ctx, { storePath: join(dir, 'todos.json'), ...config });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { host, dir };
}

/** POST 一次「触发升级」。 */
function triggerUpdate(host, body = { action: 'plugin-update' }) {
  return call(host.routes.get('/worktodo/update').handler, {
    method: 'POST',
    url: '/worktodo/update',
    body,
  });
}

/** GET 一次升级状态（顺便记下阶段/重启记录，方便轮询式断言）。 */
function readUpdateState(host) {
  const response = call(host.routes.get('/worktodo/update').handler, { method: 'GET', url: '/worktodo/update' });
  return response.then((value) => {
    const data = value.json()?.data;
    if (data) {
      lastPhase = data.phase ?? null;
      lastRestart = data.restart ?? null;
    }
    return value;
  });
}

/**
 * 轮询 GET /worktodo/update 直到谓词成立（或超时），返回**最后读到的状态**。
 * 为什么不用 waitFor(() => 某个全局变量)：那个全局只在 readUpdateState 里更新，
 * 条件函数本身不重新读，永远等不到新值（踩过一次）。
 * @param {object} host
 * @param {(state: object) => boolean} predicate
 * @param {number} [timeoutMs]
 */
async function waitForUpdatePhase(host, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = (await readUpdateState(host)).json().data ?? last;
    if (last && predicate(last)) return last;
    if (Date.now() > deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 读「落盘的插件版本」文本（装配假 pnpm 之后用它确认真的换了版本）。 */
function readInstalledVersionText(profileDir) {
  try {
    return readFileSync(join(profileDir, 'node_modules', 'dsh-worktodo', 'package.json'), 'utf8');
  } catch {
    return '';
  }
}

/** 轮询状态接口，直到升级不再是 running（或超时）。 */
async function waitForUpdateEnd(host, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await readUpdateState(host);
    last = response.json().data ?? null;
    if (last && last.state !== 'running') return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return last;
}

/**
 * 等**自动**升级真正收口：只认 done/failed。
 * 为什么不能用 waitForUpdateEnd：自动升级是 apply 里 `void` 起的后台活，
 * 刚挂载完 GET 到的是 idle（还没走到状态机的 running），会被误判成「已经结束」。
 */
async function waitForUpdateSettled(host, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await readUpdateState(host)).json().data ?? null;
    if (last && (last.state === 'done' || last.state === 'failed')) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return last;
}

await test('自升级：link: 安装 → unsupported/link-install；别下载/别安装、零写盘、零子进程', async () => {
  const profile = makeFakeProfile('linked', 'link:/tmp/fake/dsh-worktodo');
  const before = snapshotTree(profile);
  const capture = join(selfUpdateRoot, 'capture-linked.txt');
  const bin = join(selfUpdateRoot, 'bin-linked');
  const stageDir = join(selfUpdateRoot, 'stage-linked');
  writeFakePnpm(bin, { capture });
  const { host, dir } = await makeUpdateHost({ autoUpdate: false });
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile,
      PATH: `${bin}:${process.env.PATH}`,
      WORKTODO_PNPM_PATH: undefined,
      WORKTODO_UPDATE_LATEST: FAKE_NEXT_VERSION,
      WORKTODO_UPDATE_STATE_PATH: join(selfUpdateRoot, 'state-linked.json'),
      WORKTODO_UPDATE_STAGE_DIR: stageDir,
    }, async () => {
      // 1) 面板「下载」：必须在**发起下载之前**就收口成 unsupported（连暂存区都不建）
      const download = await triggerUpdate(host, { action: 'plugin-update-download', version: FAKE_NEXT_VERSION });
      eq(download.statusCode, 200);
      const downloaded = download.json();
      eq(downloaded.ok, false, 'link: 不适用自更新，不是「装成功了」：');
      eq(downloaded.reason, 'link-install', `POST 的稳定原因要是 link-install：${JSON.stringify(downloaded)}`);
      // POST 的回包沿用旧契约（ok/reason/error），阶段读 GET /worktodo/update（面板也是这么做的）。
      const downloadState = (await readUpdateState(host)).json().data;
      eq(downloadState.phase, 'unsupported', `下载前就必须判成 unsupported（实际 ${downloadState.phase}）：`);
      eq(downloadState.updateUnsupported, 'link-install', '要给出稳定的不适用种类：');
      eq(downloadState.state, 'idle', '兼容层：老面板看到的仍是 idle（不亮红）：');
      eq(downloadState.failure, null, 'unsupported 不是 failure：');
      eq(downloadState.failedOperation, null, 'unsupported 没有「失败发生在哪一步」：');
      eq(/失败/.test(String(downloadState.error)), false, `文案不能出现「失败」：${downloadState.error}`);
      eq(String(downloadState.error).includes('git/pnpm'), true, `要说清该走哪条更新工作流：${downloadState.error}`);
      eq(String(downloadState.diagnostics?.detail).includes('link:'), true,
        `技术细节（link: 规格）只能进 diagnostics：${JSON.stringify(downloadState.diagnostics)}`);
      eq(existsSync(stageDir), false, '判定发生在下载之前：暂存区都不该被创建：');
      eq(invokeCount(capture), 0, `link: 场景一个子进程都不许起（实际 ${invokeCount(capture)}）：`);
      eq(snapshotTree(profile), before, '零写盘：profile 目录逐字节不变：');

      // 2) 旧接口「一次到位」：同样在 install 流程之前收口，不改盘、不起子进程
      const response = await triggerUpdate(host);
      eq(response.statusCode, 200);
      const body = response.json();
      eq(body.ok, false, 'link: 安装必须被拒绝，而不是照装：');
      eq(body.reason, 'link-install');
      const installedState = (await readUpdateState(host)).json().data;
      eq(installedState.phase, 'unsupported', `旧接口也要走 unsupported（实际 ${installedState.phase}）：`);
      eq(installedState.updateUnsupported, 'link-install');
      eq(installedState.state, 'idle');
      await new Promise((resolve) => setTimeout(resolve, 200));
      eq(invokeCount(capture), 0, `link: 场景绝不允许执行任何子进程（实际 ${invokeCount(capture)}）：`);
      eq(snapshotTree(profile), before, '零写盘：旧接口路径也必须逐字节不变：');

      // 3) 兼容语义不变：hasUpdate 仍按「运行版本 vs latest」算（不是按不适用状态算）
      const list = (await call(host.routes.get('/worktodo/list').handler, {
        method: 'GET', url: '/worktodo/list',
      })).json();
      eq(list.data.update.hasUpdate, true, `hasUpdate 必须照旧按运行版本算：${JSON.stringify(list.data.update)}`);
      eq(list.data.update.run.phase, 'unsupported', '/list 摘要也要带 unsupported 阶段：');
      eq(list.data.update.run.updateUnsupported, 'link-install');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('自升级：node_modules/dsh-worktodo 指向仓库的 symlink → unsupported/link-install；零写盘、零子进程', async () => {
  // pnpm 的 registry 安装本来就是链接到 profile 自己的 node_modules/.pnpm；这里刻意让链接
  // 指向 profile **之外**的源码目录（等价 `link:`/`file:`/`workspace:`），必须在 install 前识别。
  const profile = makeFakeProfile('symlinked', '^0.2.0');
  const linkedRepo = join(selfUpdateRoot, 'symlink-repo');
  mkdirSync(linkedRepo, { recursive: true });
  writeFileSync(join(linkedRepo, 'package.json'), JSON.stringify({ name: 'dsh-worktodo', version: '0.2.0' }, null, 2));
  mkdirSync(join(profile, 'node_modules'), { recursive: true });
  symlinkSync(linkedRepo, join(profile, 'node_modules', 'dsh-worktodo'), 'dir');
  const profileBefore = snapshotTree(profile);
  const repoBefore = snapshotTree(linkedRepo);
  const capture = join(selfUpdateRoot, 'capture-symlink.txt');
  const bin = join(selfUpdateRoot, 'bin-symlink');
  const stageDir = join(selfUpdateRoot, 'stage-symlink');
  writeFakePnpm(bin, { capture });
  const { host, dir } = await makeUpdateHost({ autoUpdate: false });
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile,
      PATH: `${bin}:${process.env.PATH}`,
      WORKTODO_PNPM_PATH: undefined,
      WORKTODO_UPDATE_LATEST: FAKE_NEXT_VERSION,
      WORKTODO_UPDATE_STATE_PATH: join(selfUpdateRoot, 'state-symlink.json'),
      WORKTODO_UPDATE_STAGE_DIR: stageDir,
    }, async () => {
      const response = await triggerUpdate(host);
      eq(response.statusCode, 200);
      eq(response.json().reason, 'link-install');
      const body = (await readUpdateState(host)).json().data;
      eq(body.phase, 'unsupported', `symlink 安装也要在 install 前判成 unsupported（实际 ${body.phase}）：`);
      eq(body.updateUnsupported, 'link-install', 'symlink 指向 profile 之外 = 本地链接安装：');
      eq(body.state, 'idle', '兼容层保持 idle：');
      eq(body.diagnostics?.evidence, 'node-modules-symlink', `诊断要说明命中的是 symlink：${JSON.stringify(body.diagnostics)}`);
      eq(String(body.diagnostics?.detail).includes(linkedRepo), true, '诊断里要有链接目标（只进 diagnostics）：');
      eq(existsSync(stageDir), false, '没有下载，暂存区不该出现：');
      await new Promise((resolve) => setTimeout(resolve, 150));
      eq(invokeCount(capture), 0, `symlink 场景一个子进程都不许起（实际 ${invokeCount(capture)}）：`);
      eq(snapshotTree(profile), profileBefore, '零写盘：profile（含链接本身）逐字节不变：');
      eq(snapshotTree(linkedRepo), repoBefore, '零写盘：链接目标仓库也一个字节都不许动：');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('预判：link:/file:/workspace: 都算本地链接安装；pnpm 的 .pnpm 内部 symlink 不算（不误伤正常安装）', () => {
  for (const [label, spec] of [
    ['link', 'link:../../default-workspace/dsh-worktodo'],
    ['file', 'file:../dsh-worktodo'],
    ['workspace', 'workspace:*'],
  ]) {
    const profile = makeFakeProfile(`preflight-${label}`, spec);
    const detected = detectUnsupportedInstall({ profileDir: profile });
    eq(detected?.kind, 'link-install', `${label}: 本地协议必须判成 link-install：${JSON.stringify(detected)}`);
    eq(detected?.evidence, 'local-spec', `${label}: 证据要是 local-spec：`);
    eq(String(detected?.detail).includes(spec), true, `${label}: diagnostics 要带原始规格：${detected?.detail}`);
  }

  // pnpm 的 registry 安装：node_modules/dsh-worktodo → node_modules/.pnpm/... 也是 symlink，
  // 但目标在 profile 自己的 node_modules 内，不能误判成开发安装（否则正常用户永远升不了级）。
  const pnpmProfile = makeFakeProfile('preflight-pnpm', '^0.2.0');
  const storePkg = join(pnpmProfile, 'node_modules', '.pnpm', 'dsh-worktodo@0.2.0', 'node_modules', 'dsh-worktodo');
  mkdirSync(storePkg, { recursive: true });
  writeFileSync(join(storePkg, 'package.json'), JSON.stringify({ name: 'dsh-worktodo', version: '0.2.0' }, null, 2));
  symlinkSync(storePkg, join(pnpmProfile, 'node_modules', 'dsh-worktodo'), 'dir');
  eq(detectUnsupportedInstall({ profileDir: pnpmProfile }), null,
    '正常 pnpm 安装（链接指向自己的 .pnpm 目录）必须返回 null，交给正常升级流程：');
});

/* ------------------------------------------------------------------ *
 * 独立安装器（本轮核心）：下载 → 解包 → detached 安装器替换自己的目录
 *
 * 这些用例替代旧的「在 live profile 里跑 pnpm/CLI」路径。按约束：
 *   - 假 profile / 临时 DSH_HOME / 本地假 tarball，不碰真实数据、不联网；
 *   - 绊线 bin（pnpm/npm/dsh CLI）任何一次调用都记为红灯；
 *   - 安装后对 profile「除本包目录外」做逐字节快照比对。
 * ------------------------------------------------------------------ */

await test('独立安装器（核心）：下载→解包→detached 安装；零 pnpm/CLI、版本替换、其它文件逐字节不变', async () => {
  const profile = makeFakeProfile('installer-core', '^0.2.0');
  seedInstalledVersion(profile, '0.2.0');
  mkdirSync(join(profile, 'node_modules', 'dsh-worktodo', 'lib'), { recursive: true });
  writeFileSync(join(profile, 'node_modules', 'dsh-worktodo', 'lib', 'old-marker.txt'), 'OLD\n');
  const manifestBytes = readFileSync(join(profile, 'package.json'), 'utf8');
  const lockBytes = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      dsh-worktodo:\n        specifier: ^0.2.0\n        version: 0.2.0\n";
  writeFileSync(join(profile, 'pnpm-lock.yaml'), lockBytes);
  const outsideBefore = snapshotOutsideOwnPackage(profile);

  const capture = join(selfUpdateRoot, 'capture-installer-core.txt');
  const bin = join(selfUpdateRoot, 'bin-installer-core');
  writeTripwires(bin, ['pnpm', 'npm', 'pnpm.cmd', 'npm.cmd'], capture);
  const fakeCli = join(selfUpdateRoot, 'trip-cli-core.mjs');
  writeFileSync(fakeCli, [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(capture)}, 'INVOKE cli\\n');`,
    '',
  ].join('\n'));

  const stageDir = join(selfUpdateRoot, 'stage-installer-core');
  const statePath = join(selfUpdateRoot, 'update-state-installer-core.json');
  const tarball = await startTarballServer({ version: FAKE_NEXT_VERSION, chunks: 4, delayMs: 25 });
  let host;
  let dir;
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile,
      PATH: `${bin}:${process.env.PATH}`,
      WORKTODO_PNPM_PATH: join(bin, 'pnpm'),
      WORKTODO_UPDATE_CLI: fakeCli,
      WORKTODO_UPDATE_LATEST: FAKE_NEXT_VERSION,
      WORKTODO_UPDATE_TARBALL_BASE: tarball.base,
      WORKTODO_UPDATE_STAGE_DIR: stageDir,
      WORKTODO_UPDATE_STATE_PATH: statePath,
      // 安装器开工前等 700ms：宿主必须立刻返回 installing，而不是等它退出
      WORKTODO_APPLY_DELAY_MS: '700',
    }, async () => {
      host = await makeUpdateHost({ autoUpdate: false });
      dir = host.dir;

      // —— 第 1 步：下载 + 解包（只落暂存区，不动 profile） ——
      const download = await triggerUpdate(host.host, { action: 'plugin-update-download' });
      eq(download.json().ok, true, `下载应当成功：${JSON.stringify(download.json())}`);
      const downloaded = await waitForUpdatePhase(host.host, (state) => state.phase === 'downloaded', 5000);
      eq(downloaded?.phase, 'downloaded', `下载后必须到 downloaded（实际 ${downloaded?.phase}，error=${downloaded?.error}）：`);
      eq(downloaded?.download?.version, FAKE_NEXT_VERSION);
      eq(existsSync(downloaded.download.stagedDir), true, `必须落成解包后的完整包目录：${downloaded.download.stagedDir}`);
      const stagedPkg = JSON.parse(readFileSync(join(downloaded.download.stagedDir, 'package.json'), 'utf8'));
      eq(stagedPkg.version, FAKE_NEXT_VERSION, '解包目录里的 package.json 必须已经是新版本：');
      eq(existsSync(join(downloaded.download.stagedDir, 'lib', 'index.js')), true, '解包目录必须含 lib/index.js：');
      eq(existsSync(join(downloaded.download.stagedDir, 'src', 'client', 'index.js')), true, '解包目录必须含 src/client：');
      eq(existsSync(join(downloaded.download.stagedDir, 'cordis.patch.yml')), true, '解包目录必须含 cordis.patch.yml：');
      eq(invokeCount(capture), 0, `下载阶段绝不允许碰 pnpm/CLI（实际 ${invokeCount(capture)} 次）：`);

      // —— 第 2 步：安装。宿主只负责 spawn detached，立即返回；安装器在后台干活 ——
      const startedAt = Date.now();
      const install = await triggerUpdate(host.host, { action: 'plugin-update-install' });
      const elapsed = Date.now() - startedAt;
      eq(install.json().ok, true, `安装应当被接受：${JSON.stringify(install.json())}`);
      eq(elapsed < 500, true, `宿主绝不许等安装器退出（实际 ${elapsed}ms；旧实现会等整条 pnpm 序列）：`);
      eq(install.json().data.phase, 'installing', `返回时必须已经是 installing（实际 ${install.json().data.phase}）：`);

      const settled = await waitForUpdateSettled(host.host, 8000);
      eq(settled?.phase, 'installed', `安装器成功后必须落在 installed（实际 ${settled?.phase}，error=${settled?.error}）：`);
      eq(settled?.state, 'done', '老字段 state 也要是 done：');
      eq(settled?.installed, FAKE_NEXT_VERSION, '要报出落盘的新版本：');
      eq(readInstalledVersionText(profile).includes(FAKE_NEXT_VERSION), true, 'node_modules 里的版本必须真的换了：');
      eq(existsSync(join(profile, 'node_modules', 'dsh-worktodo', 'lib', 'old-marker.txt')), false,
        '旧目录必须被新目录整体替换（旧文件不该残留在新包里）：');

      // 零 pnpm/CLI：绊线一次都不许响
      eq(invokeCount(capture), 0,
        `安装路径必须零 pnpm/npm/CLI 调用（实际 ${invokeCount(capture)} 次）：${existsSync(capture) ? readFileSync(capture, 'utf8') : '（capture 不存在 = 零调用）'}`);

      // 只碰自己的目录：profile 其余文件逐字节不变
      eq(snapshotOutsideOwnPackage(profile), outsideBefore, 'profile 除本包目录外必须逐字节不变：');
      eq(readFileSync(join(profile, 'package.json'), 'utf8'), manifestBytes, 'profile 清单绝不许被改写：');
      eq(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8'), lockBytes, 'lockfile 绝不许被改写：');

      // 安装器结果与日志：诊断可查
      const resultFile = resolveApplyResultPath(statePath);
      const result = JSON.parse(readFileSync(resultFile, 'utf8'));
      eq(result.ok, true, `安装器结果必须是 ok：${JSON.stringify(result)}`);
      eq(result.phase, 'installed');
      eq(typeof result.pid, 'number', '结果里要有安装器 pid（证明真的起了一个独立进程）：');
      eq(existsSync(result.log) || existsSync(downloaded.download.manifestFile), true, '安装日志/清单应当可查：');
      const backups = readdirSync(join(profile, 'node_modules')).filter((name) => name.startsWith('.worktodo-backup-'));
      eq(backups.length >= 1, true, `成功后至少保留一份备份：${JSON.stringify(backups)}`);
    });
  } finally {
    await tarball.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    rmSync(stageDir, { recursive: true, force: true });
  }
});

await test('独立安装器：pnpm 的 .pnpm symlink 布局 → 替换真实目录，symlink 本身与其它文件不变', async () => {
  const profile = makeFakeProfile('installer-symlink', '^0.2.0');
  const storeDir = join(profile, 'node_modules', '.pnpm', 'dsh-worktodo@0.2.0', 'node_modules', 'dsh-worktodo');
  mkdirSync(join(storeDir, 'lib'), { recursive: true });
  writeFileSync(join(storeDir, 'package.json'), JSON.stringify({ name: 'dsh-worktodo', version: '0.2.0' }, null, 2));
  writeFileSync(join(storeDir, 'lib', 'old.js'), 'OLD\n');
  symlinkSync('.pnpm/dsh-worktodo@0.2.0/node_modules/dsh-worktodo', join(profile, 'node_modules', 'dsh-worktodo'), 'dir');
  const manifestBytes = readFileSync(join(profile, 'package.json'), 'utf8');
  const outsideBefore = snapshotOutsideOwnPackage(profile, [
    'node_modules/.pnpm/dsh-worktodo@0.2.0/node_modules/dsh-worktodo',
    'node_modules/.pnpm/dsh-worktodo@0.2.0/node_modules/.worktodo-backup-',
    'node_modules/.pnpm/dsh-worktodo@0.2.0/node_modules/.worktodo-new-',
    'node_modules/.pnpm/dsh-worktodo@0.2.0/node_modules/.worktodo-broken-',
  ]);
  const linkBefore = readlinkSync(join(profile, 'node_modules', 'dsh-worktodo'));
  const stageDir = join(selfUpdateRoot, 'stage-installer-symlink');
  const statePath = join(selfUpdateRoot, 'update-state-installer-symlink.json');
  const tarball = await startTarballServer({ version: FAKE_NEXT_VERSION, chunks: 2 });
  let host;
  let dir;
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile,
      WORKTODO_UPDATE_LATEST: FAKE_NEXT_VERSION,
      WORKTODO_UPDATE_TARBALL_BASE: tarball.base,
      WORKTODO_UPDATE_STAGE_DIR: stageDir,
      WORKTODO_UPDATE_STATE_PATH: statePath,
    }, async () => {
      host = await makeUpdateHost({ autoUpdate: false });
      dir = host.dir;
      eq((await triggerUpdate(host.host, { action: 'plugin-update-download' })).json().ok, true);
      await waitForUpdatePhase(host.host, (state) => state.phase === 'downloaded', 5000);
      eq((await triggerUpdate(host.host, { action: 'plugin-update-install' })).json().ok, true);
      const settled = await waitForUpdateSettled(host.host, 8000);
      eq(settled?.phase, 'installed', `symlink 布局也必须装成功（实际 ${settled?.phase}，error=${settled?.error}）：`);
      // 替换的是 realpath 指向的真实目录；profile 里的 symlink 原样保留
      eq(readlinkSync(join(profile, 'node_modules', 'dsh-worktodo')), linkBefore, 'symlink 本身绝不许被替换/改指向：');
      eq(JSON.parse(readFileSync(join(storeDir, 'package.json'), 'utf8')).version, FAKE_NEXT_VERSION,
        '真实目录（.pnpm/...）里的版本必须换成新版本：');
      eq(existsSync(join(storeDir, 'lib', 'old.js')), false, '真实目录里的旧文件必须被整体替换：');
      eq(snapshotOutsideOwnPackage(profile, [
        'node_modules/.pnpm/dsh-worktodo@0.2.0/node_modules/dsh-worktodo',
        'node_modules/.pnpm/dsh-worktodo@0.2.0/node_modules/.worktodo-backup-',
        'node_modules/.pnpm/dsh-worktodo@0.2.0/node_modules/.worktodo-new-',
        'node_modules/.pnpm/dsh-worktodo@0.2.0/node_modules/.worktodo-broken-',
      ]), outsideBefore, '除本包真实目录外，profile 必须逐字节不变：');
      eq(readFileSync(join(profile, 'package.json'), 'utf8'), manifestBytes, '清单不变：');
    });
  } finally {
    await tarball.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    rmSync(stageDir, { recursive: true, force: true });
  }
});

await test('独立安装器：rename 目标失败 → 从备份回滚旧版本、failed + 原因、备份可用、日志尾部进 diagnostics', async () => {
  const profile = makeFakeProfile('installer-rollback', '^0.2.0');
  seedInstalledVersion(profile, '0.2.0');
  const target = join(profile, 'node_modules', 'dsh-worktodo');
  mkdirSync(join(target, 'lib'), { recursive: true });
  writeFileSync(join(target, 'lib', 'old-marker.txt'), 'KEEP-ME\n');
  const oldPkg = readFileSync(join(target, 'package.json'), 'utf8');
  const manifestBytes = readFileSync(join(profile, 'package.json'), 'utf8');
  const stageDir = join(selfUpdateRoot, 'stage-installer-rollback');
  const statePath = join(selfUpdateRoot, 'update-state-installer-rollback.json');
  const tarball = await startTarballServer({ version: FAKE_NEXT_VERSION, chunks: 1 });
  let host;
  let dir;
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile,
      WORKTODO_UPDATE_LATEST: FAKE_NEXT_VERSION,
      WORKTODO_UPDATE_TARBALL_BASE: tarball.base,
      WORKTODO_UPDATE_STAGE_DIR: stageDir,
      WORKTODO_UPDATE_STATE_PATH: statePath,
      // 注入：备份完成后、把新目录 rename 成目标时失败
      WORKTODO_APPLY_FAIL_STEP: 'rename-target',
    }, async () => {
      host = await makeUpdateHost({ autoUpdate: false });
      dir = host.dir;
      eq((await triggerUpdate(host.host, { action: 'plugin-update-download' })).json().ok, true);
      await waitForUpdatePhase(host.host, (state) => state.phase === 'downloaded', 5000);
      eq((await triggerUpdate(host.host, { action: 'plugin-update-install' })).json().ok, true);
      const settled = await waitForUpdateSettled(host.host, 8000);
      eq(settled?.phase, 'failed', `注入 rename 失败必须 failed（实际 ${settled?.phase}）：`);
      eq(settled?.reason, 'replace-failed', `失败原因要是 replace-failed（实际 ${settled?.reason}）：`);
      eq(String(settled?.error).includes('已从备份恢复'), true, `错误必须说明已从备份恢复：${settled?.error}`);
      eq(settled?.installed, '0.2.0', `回滚后落盘版本必须还是旧版（实际 ${settled?.installed}）：`);
      eq(readFileSync(join(target, 'package.json'), 'utf8'), oldPkg, '目标 package.json 必须逐字节恢复：');
      eq(readFileSync(join(target, 'lib', 'old-marker.txt'), 'utf8'), 'KEEP-ME\n', '旧目录里的文件也必须回来：');
      eq(readFileSync(join(profile, 'package.json'), 'utf8'), manifestBytes, 'profile 清单绝不许变：');
      const backups = readdirSync(join(profile, 'node_modules')).filter((name) => name.startsWith('.worktodo-backup-'));
      eq(backups.length >= 1, true, `回滚后必须保留一份可用备份：${JSON.stringify(backups)}`);
      const backupPkg = JSON.parse(readFileSync(join(profile, 'node_modules', backups[0], 'package.json'), 'utf8'));
      eq(backupPkg.version, '0.2.0', '备份里必须是旧版本（可用于人工回退）：');
      eq(Array.isArray(settled?.diagnostics?.logTail), true, '失败必须有日志尾部：');
      eq(settled.diagnostics.logTail.length > 0, true, '日志尾部不能为空：');
      eq(settled.diagnostics.logTail.length <= 40, true, `日志尾部最多 40 行（实际 ${settled.diagnostics.logTail.length}）：`);
      eq(settled.diagnostics.logTail.some((line) => String(line).includes('injected rename-target')), true,
        `日志尾部必须含失败原因：${JSON.stringify(settled.diagnostics.logTail)}`);
      eq(settled?.steps?.some((step) => step.step === 'rollback' && step.ok === true), true,
        `steps 里必须留下回滚成功的记录：${JSON.stringify(settled?.steps)}`);
      // 安装器退出码非 0，但宿主已经通过结果文件收口
      eq(existsSync(resolveApplyResultPath(statePath)), true, '结果文件必须落盘（宿主靠它收口）：');
    });
  } finally {
    await tarball.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    rmSync(stageDir, { recursive: true, force: true });
  }
});

await test('独立安装器：幂等（已达标直接成功）+ Windows rename 占用退避重试', async () => {
  const runInstaller = (profile, stagedVersion, env = {}) => {
    const node = process.execPath;
    const apply = resolveApplyUpdatePath({ env: {} });
    const statePath = join(selfUpdateRoot, `state-direct-${Math.random().toString(16).slice(2)}.json`);
    const logPath = join(selfUpdateRoot, `apply-direct-${Math.random().toString(16).slice(2)}.log`);
    const result = spawnSync(node, [
      apply,
      '--staged', stagedVersion,
      '--target', join(profile, 'node_modules', 'dsh-worktodo'),
      '--version', FAKE_NEXT_VERSION,
      '--state', statePath,
      '--log', logPath,
    ], { env: { ...process.env, ...env }, encoding: 'utf8' });
    return { status: result.status, stderr: result.stderr, stdout: result.stdout, statePath, logPath };
  };

  // 直接调安装器需要一份「解包后的 staged 目录」：用临时目录 + 最小合法包
  const staged = join(selfUpdateRoot, 'staged-direct');
  mkdirSync(join(staged, 'lib'), { recursive: true });
  writeFileSync(join(staged, 'package.json'), JSON.stringify({ name: 'dsh-worktodo', version: FAKE_NEXT_VERSION }, null, 2));
  writeFileSync(join(staged, 'lib', 'index.js'), 'export default 1;\n');
  writeFileSync(join(staged, 'cordis.patch.yml'), '# patch\n');

  const profile = makeFakeProfile('installer-idempotent', '^0.2.0');
  seedInstalledVersion(profile, '0.2.0');
  const first = runInstaller(profile, staged);
  eq(first.status, 0, `第一次直接运行安装器应当成功（stderr=${String(first.stderr).slice(-300)}）：`);
  let result = JSON.parse(readFileSync(join(dirname(first.statePath), 'apply-result.json'), 'utf8'));
  eq(result.ok, true);
  eq(result.alreadyInstalled, false);
  eq(JSON.parse(readFileSync(join(profile, 'node_modules', 'dsh-worktodo', 'package.json'), 'utf8')).version, FAKE_NEXT_VERSION);

  const beforeSecond = snapshotTree(join(profile, 'node_modules', 'dsh-worktodo'));
  const second = runInstaller(profile, staged);
  eq(second.status, 0, `重复运行必须幂等成功（stderr=${String(second.stderr).slice(-300)}）：`);
  result = JSON.parse(readFileSync(join(dirname(second.statePath), 'apply-result.json'), 'utf8'));
  eq(result.ok, true);
  eq(result.alreadyInstalled, true, '第二次必须识别出「已达标」而不是再搬一次目录：');
  eq(snapshotTree(join(profile, 'node_modules', 'dsh-worktodo')), beforeSecond, '幂等路径不许改动目标目录：');

  // Windows 占用模拟：前两次 rename 以 EPERM 失败 → 退避重试后成功
  const retryProfile = makeFakeProfile('installer-rename-retry', '^0.2.0');
  seedInstalledVersion(retryProfile, '0.2.0');
  const retried = runInstaller(retryProfile, staged, { WORKTODO_APPLY_RENAME_FAILS: '2' });
  eq(retried.status, 0, `rename 短暂失败必须退避重试成功（stderr=${String(retried.stderr).slice(-300)}）：`);
  const retryResult = JSON.parse(readFileSync(join(dirname(retried.statePath), 'apply-result.json'), 'utf8'));
  eq(retryResult.ok, true);
  eq(JSON.parse(readFileSync(join(retryProfile, 'node_modules', 'dsh-worktodo', 'package.json'), 'utf8')).version, FAKE_NEXT_VERSION);
  eq(readFileSync(retried.logPath, 'utf8').includes('重试'), true, '日志里必须留下 rename 重试记录：');
});

await test('独立安装器：spawn 规格必须是 detached + stdio ignore + unref；结果/日志/超时路径纯函数', () => {
  const statePath = '/tmp/fake-home/worktodo/update-state.json';
  eq(resolveApplyResultPath(statePath), '/tmp/fake-home/worktodo/apply-result.json', '结果文件固定在状态文件同目录：');
  eq(resolveApplyResultPath(null), null, '没有状态文件时宁可不写：');
  eq(resolveApplyTimeoutMs({ env: {} }), 120000, '默认超时 120s：');
  eq(resolveApplyTimeoutMs({ env: { WORKTODO_APPLY_TIMEOUT_MS: '1500' } }), 1500, '测试缝可覆盖：');
  eq(resolveApplyTimeoutMs({ env: { WORKTODO_APPLY_TIMEOUT_MS: '-1' } }), 120000, '非法值回落默认：');
  eq(/apply-\d{8}-\d{6}-\d{3}\.log$/.test(resolveApplyLogPath({ stageDir: '/tmp/fake-home/worktodo/updates' })), true,
    `日志文件名必须是 apply-<ts>.log：${resolveApplyLogPath({ stageDir: '/tmp/x' })}`);
  eq(resolveApplyLogPath({ stageDir: null }), null);
  eq(existsSync(resolveApplyUpdatePath({ env: {} })), true, '默认安装器必须真的在包里（package.json files 要包含它）：');

  const spec = buildApplyInstallerSpec({
    stagedDir: '/tmp/staged/1.2.3',
    targetDir: '/tmp/profile/node_modules/dsh-worktodo',
    version: '1.2.3',
    statePath,
    logPath: '/tmp/fake-home/worktodo/updates/apply-x.log',
    env: {},
    execPath: '/usr/local/bin/node',
  });
  eq(spec.options.detached, true, '必须 detached（真正脱离宿主）：');
  eq(spec.options.stdio, 'ignore', '必须 stdio:ignore（不继承宿主管道）：');
  eq(spec.unref, true, '必须显式 unref（宿主不等待它退出）：');
  eq(spec.options.windowsHide, true, 'Windows 上不弹窗：');
  eq(spec.command, '/usr/local/bin/node', '用 node 可执行文件跑安装器：');
  eq(spec.args[0], resolveApplyUpdatePath({ env: {} }), '第一个参数是我们自己的安装器脚本：');
  for (const key of ['--staged', '--target', '--version', '--state', '--log']) {
    eq(spec.args.includes(key), true, `参数必须包含 ${key}：${JSON.stringify(spec.args)}`);
  }
  eq(spec.resultPath, '/tmp/fake-home/worktodo/apply-result.json', 'spawn 规格里也要带结果路径：');
});

await test('自升级：启动检查在飞时点升级不能被「已在运行」吞掉，且检查晚到不许冲掉结论', async () => {
  // 直接复现 CI 的失败形态：apply() 的启动检查还在等 registry（慢），用户这时点了升级。
  // 旧实现把 phase=checking 当成「已在安装」，回 ok:true running 却一个子进程都不起；
  // 更糟的是检查晚到后会用 await 之前的 idleBefore 快照把阶段改回 available/idle。
  const profile = makeFakeProfile('linked-during-check', 'link:/tmp/fake/dsh-worktodo');
  let sawCheck;
  const checkArrived = new Promise((resolve) => { sawCheck = resolve; });
  const slowRegistry = createServer((request, response) => {
    sawCheck();
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ 'dist-tags': { latest: bumpPatch(PKG_VERSION, 1) }, versions: {} }));
    }, 400);
  });
  await new Promise((resolve) => slowRegistry.listen(0, '127.0.0.1', resolve));
  slowRegistry.unref();
  try {
    await withEnv({
      WORKTODO_NO_UPDATE_CHECK: undefined,
      WORKTODO_UPDATE_LATEST: undefined,
      WORKTODO_PROFILE_DIR: profile,
    }, async () => {
      const { host, dir } = await makeUpdateHost({
        autoUpdate: false,
        updateRegistry: `http://127.0.0.1:${slowRegistry.address().port}/`,
      });
      try {
        eq((await readUpdateState(host)).json().data.phase, 'checking',
          '前置条件：启动检查必须真的在飞（否则这条用例没有牙齿）：');
        const body = (await triggerUpdate(host)).json();
        eq(body.ok, false, '检查在飞不是「已在安装」：手动升级必须继续走守卫，link: 要拒绝：');
        eq(body.reason, 'link-install', `link: 的稳定原因不能被吞成 running（实际 ${body.reason}）：`);
        const posted = (await readUpdateState(host)).json().data;
        eq(posted.phase, 'unsupported', `link: 在 install 前就该判成 unsupported（实际 ${posted.phase}）：`);
        await checkArrived;
        await new Promise((resolve) => setTimeout(resolve, 500)); // 等检查真的返回并收口
        const status = (await readUpdateState(host)).json().data;
        eq(status.phase, 'unsupported', `检查晚到不许把已定论的 link: 冲成 available/idle（实际 ${status.phase}）：`);
        eq(status.reason, 'link-install', `结论仍必须是 link-install（实际 ${status.reason}）：`);
        eq(status.updateUnsupported, 'link-install');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  } finally {
    slowRegistry.closeAllConnections?.();
    slowRegistry.close();
  }
});

await test('A3：任一段位是 link:/file:/workspace: 就整体跳过 —— 零子进程、零写盘、zero 字节改动', async () => {
  const profile = join(selfUpdateRoot, 'dev-linked');
  mkdirSync(profile, { recursive: true });
  const bytes = `${JSON.stringify({
    name: 'dsh-profile-dev-linked',
    private: true,
    dependencies: { 'dsh-worktodo': '^0.2.0' },
    devDependencies: { 'dsh-worktodo': 'link:../../default-workspace/dsh-worktodo' },
  }, null, 2)}\n`;
  writeFileSync(join(profile, 'package.json'), bytes);
  const capture = join(selfUpdateRoot, 'capture-dev-linked.txt');
  const bin = join(selfUpdateRoot, 'bin-dev-linked');
  writeFakePnpm(bin, { capture, installVersion: '9.9.9', installProfile: profile, installOn: 'any' });
  const { host, dir } = await makeUpdateHost({ autoUpdate: false });
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile, PATH: `${bin}:${process.env.PATH}`,
      WORKTODO_PNPM_PATH: undefined, WORKTODO_UPDATE_LATEST: '9.9.9',
    }, async () => {
      const response = await triggerUpdate(host);
      eq(response.json().ok, false, '本地协议必须被拒绝：');
      const body = (await readUpdateState(host)).json().data;
      eq(body.phase, 'unsupported', `本地协议是预期内的不适用（实际 ${body.phase}）：`);
      eq(body.updateUnsupported, 'link-install', `种类要是 link-install：${JSON.stringify(body)}`);
      eq(String(body.diagnostics?.detail).includes('devDependencies'), true,
        `diagnostics 要说清是哪个段位命中的（旧守卫只看 dependencies）：${JSON.stringify(body.diagnostics)}`);
      eq(/失败/.test(String(body.error)), false, `文案不能出现「失败」：${body.error}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      eq(invokeCount(capture), 0, `本地协议场景一个子进程都不许起（实际 ${invokeCount(capture)}）：`);
      eq(readFileSync(join(profile, 'package.json'), 'utf8') === bytes, true, '零写盘：清单逐字节不变：');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('安装态 vs 运行态：落盘版本比运行版本新 → restartRequired:true，hasUpdate 仍按运行版本', async () => {
  const newer = bumpPatch(PKG_VERSION, 1);
  const profile = makeFakeProfile('state-installed-newer', '^0.2.0');
  seedInstalledVersion(profile, newer);
  const { host, dir } = await makeUpdateHost({ autoUpdate: false });
  try {
    await withEnv({ WORKTODO_PROFILE_DIR: profile, WORKTODO_UPDATE_LATEST: newer }, async () => {
      const response = await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' });
      eq(response.statusCode, 200, '安装态探测再怪也不能让 /list 失败：');
      const update = response.json().data.update;
      eq(update.installedVersion, newer, '要报出 node_modules 里落盘的版本：');
      eq(update.runningVersion, PKG_VERSION, '要报出本进程正在运行的版本：');
      eq(update.restartRequired, true, '落盘版本 > 运行版本 → 只差重启：');
      // 老字段保持：旧面板读 current / installed 不受影响
      eq(update.installed, newer, '老字段 installed 继续保留（兼容旧面板）：');
      eq(update.current, PKG_VERSION, '老字段 current 仍是运行版本：');
      // hasUpdate 语义不变：latest vs **运行版本**。即使盘上已经是最新，它仍为 true；
      // 面板必须先看 restartRequired（smoke-client 有对应的「只显示重启」用例）。
      eq(update.hasUpdate, true, `hasUpdate 仍按 runningVersion 比较（装好 ≠ 已生效）：${JSON.stringify(update)}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('安装态 vs 运行态：落盘版本不高于运行版本 → restartRequired:false（旧版本/同版本都不报重启）', async () => {
  const profile = makeFakeProfile('state-installed-older', '^0.2.0');
  seedInstalledVersion(profile, '0.0.1');
  const { host, dir } = await makeUpdateHost({ autoUpdate: false });
  try {
    await withEnv({ WORKTODO_PROFILE_DIR: profile, WORKTODO_UPDATE_LATEST: undefined }, async () => {
      const readUpdate = async () => {
        const response = await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' });
        eq(response.statusCode, 200);
        return response.json().data.update;
      };
      const older = await readUpdate();
      eq(older.installedVersion, '0.0.1');
      eq(older.restartRequired, false, '落盘版本 < 运行版本 → 不需要重启：');

      seedInstalledVersion(profile, PKG_VERSION);
      const same = await readUpdate();
      eq(same.installedVersion, PKG_VERSION);
      eq(same.restartRequired, false, '落盘版本 == 运行版本 → 不需要重启：');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('安装态 vs 运行态：落盘清单读不到/坏 JSON → installedVersion:null、restartRequired:false，/list 照常返回', async () => {
  const profile = makeFakeProfile('state-installed-unreadable', '^0.2.0');
  const pkgDir = join(profile, 'node_modules', 'dsh-worktodo');
  const { host, dir } = await makeUpdateHost({ autoUpdate: false });
  try {
    await withEnv({ WORKTODO_PROFILE_DIR: profile, WORKTODO_UPDATE_LATEST: undefined }, async () => {
      const readPayload = async (label) => {
        const response = await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' });
        eq(response.statusCode, 200, `${label}：/list 不能被读盘失败带崩：`);
        const payload = response.json();
        eq(payload.ok, true, `${label}：/list 仍要正常返回数据：`);
        eq(Array.isArray(payload.data.todos), true, `${label}：列表数据不能丢：`);
        return payload.data.update;
      };

      // 1) node_modules 里还没有本包
      const missing = await readPayload('还没装');
      eq(missing.installedVersion, null, '读不到落盘清单 → installedVersion 给 null（不是 undefined/抛错）：');
      eq(missing.restartRequired, false, '读不到落盘版本就不能声称需要重启：');
      eq(missing.runningVersion, PKG_VERSION, '运行版本仍要照常报出：');

      // 2) 清单存在但不是合法 JSON（半写/损坏）
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'package.json'), '{ not json');
      const broken = await readPayload('坏 JSON');
      eq(broken.installedVersion, null);
      eq(broken.restartRequired, false);

      // 3) 合法 JSON 但没有 version 字段
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-worktodo' }));
      const noVersion = await readPayload('没有版本字段');
      eq(noVersion.installedVersion, null);
      eq(noVersion.restartRequired, false);

      // 4) profile 目录根本不存在（反推失败 / 被删掉）
      await withEnv({ WORKTODO_PROFILE_DIR: join(profile, 'does-not-exist') }, async () => {
        const noProfile = await readPayload('profile 不存在');
        eq(noProfile.installedVersion, null);
        eq(noProfile.restartRequired, false);
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('hasUpdate 语义不变：latest 比 runningVersion 新，而不是比落盘版本新', async () => {
  const profile = makeFakeProfile('state-hasupdate-semantics', '^0.2.0');
  const { host, dir } = await makeUpdateHost({ autoUpdate: false });
  try {
    // 落盘比运行旧、latest 落在两者之间：按 running 比较应为 false；
    // 若误改成 compare(latest, installedVersion) 就会误报 true（反向验证就抓这个）。
    seedInstalledVersion(profile, '0.0.1');
    await withEnv({ WORKTODO_PROFILE_DIR: profile, WORKTODO_UPDATE_LATEST: '0.0.2' }, async () => {
      const update = (await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' })).json().data.update;
      eq(update.hasUpdate, false, `latest 0.0.2 低于运行版本 ${PKG_VERSION} → 不该提示有新版本：${JSON.stringify(update)}`);
      eq(update.restartRequired, false);
    });

    // 落盘比运行新、latest 也比运行新但低于落盘：按 running 比较应为 true；
    // 若误用 installedVersion 比较会得到 false。
    seedInstalledVersion(profile, bumpPatch(PKG_VERSION, 2));
    await withEnv({ WORKTODO_PROFILE_DIR: profile, WORKTODO_UPDATE_LATEST: bumpPatch(PKG_VERSION, 1) }, async () => {
      const update = (await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' })).json().data.update;
      eq(update.hasUpdate, true, `latest 高于运行版本 → 仍要提示有新版本（与落盘版本无关）：${JSON.stringify(update)}`);
      eq(update.restartRequired, true, '落盘版本更高 → 同时要求重启，客户端按优先级只显示重启：');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('B3：跨进程锁纯函数 —— 第二次 busy、>10min 可回收、release 只删自己的锁', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worktodo-lock-'));
  const file = join(dir, 'update.lock');
  const t0 = Date.now();
  try {
    eq(resolveUpdateLockPath({ env: {}, home: '/tmp/fake-home' }), '/tmp/fake-home/worktodo/update.lock',
      'B3：默认锁路径必须是 $DSH_HOME/worktodo/update.lock：');
    eq(resolveUpdateLockPath({ env: { WORKTODO_UPDATE_STATE_PATH: '/tmp/x/state.json' }, home: null }), '/tmp/x/update.lock',
      'B3：测试缝覆盖状态文件时，锁跟着走（绝不写真实 ~/.dsh）：');

    const first = acquireUpdateLock({ file, now: t0 });
    eq(first.ok, true, 'B3：第一次必须拿到锁：');
    const second = acquireUpdateLock({ file, now: t0 + 1000 });
    eq(second.ok, false, 'B3：第二个实例必须 busy：');
    eq(second.reason, 'busy', 'B3：busy 原因码：');
    eq(second.owner?.token, first.token, 'B3：busy 要能报出持有者 token：');
    eq(releaseUpdateLock({ file, token: 'not-ours' }), false, 'B3：release 绝不删别人的锁：');
    eq(existsSync(file), true, 'B3：错误的 release 不许删锁：');
    eq(releaseUpdateLock({ file, token: first.token }), true, 'B3：自己的锁必须能释放：');
    eq(existsSync(file), false, 'B3：释放后锁文件消失：');

    // stale：超过 10 分钟 → 可以直接回收
    const old = acquireUpdateLock({ file, now: t0 });
    eq(old.ok, true, 'B3：重新拿锁：');
    const reclaimed = acquireUpdateLock({ file, now: t0 + 11 * 60 * 1000 });
    eq(reclaimed.ok, true, 'B3：>10min 的 stale 锁必须被回收，不能永久堵住更新：');
    eq(reclaimed.reclaimed, true, 'B3：要标记这是一次回收：');
    releaseUpdateLock({ file, token: reclaimed.token });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('B1/B3：killProcessTree 在 POSIX 用独立进程组（负 pid），不会退回只杀直接子进程', async () => {
  // 纯函数层钉一下：传一个真实 spawn 的 shell，确认返回 mode=process-group
  if (process.platform === 'win32') return;
  const proc = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore', detached: true });
  try {
    eq(Number.isInteger(proc.pid), true, '前置条件：子进程要有 pid：');
    const result = killProcessTree(proc);
    eq(result.killed, true, 'B1：杀进程树必须报告成功：');
    eq(result.mode, 'process-group', `B1：POSIX 必须走 process.kill(-pid) 杀整组（实际 ${result.mode}）：`);
    eq(await waitFor(() => !isPidAlive(proc.pid), 2000), true, 'B1：直接子进程也必须真的退出：');
  } finally {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* 已退出 */ }
  }
});

await test('自升级：从模块自身路径精确反推 profile（多个 profile 时不会选错）', () => {
  // registry 安装布局：<profile>/node_modules/dsh-worktodo/lib/index.js
  const profile = join(selfUpdateRoot, 'by-module-url');
  const libDir = join(profile, 'node_modules', 'dsh-worktodo', 'lib');
  mkdirSync(libDir, { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-bymodule', private: true, dependencies: { 'dsh-worktodo': '^0.2.0' },
  }));
  writeFileSync(join(libDir, 'index.js'), '// fake module');
  const url = pathToFileURL(join(libDir, 'index.js')).href;
  eq(profileDirFromModuleUrl(url), profile, '应当精确切出 profile 目录：');

  // link: 安装：ESM 把软链接解析成仓库真实路径，不含 profile 的 node_modules 段 → null（交给后续扫描）
  eq(profileDirFromModuleUrl(pathToFileURL(join(selfUpdateRoot, 'repo', 'lib', 'index.js')).href), null,
    'link/仓库路径场景必须返回 null（后面还有环境变量与扫描兜底）：');

  // 形状对但 profile 目录里没有 package.json：不能当成 profile
  const empty = join(selfUpdateRoot, 'no-manifest');
  const emptyLib = join(empty, 'node_modules', 'dsh-worktodo', 'lib');
  mkdirSync(emptyLib, { recursive: true });
  eq(profileDirFromModuleUrl(pathToFileURL(join(emptyLib, 'index.js')).href), null, '缺 package.json 不算 profile：');

  eq(profileDirFromModuleUrl('not a url'), null, '坏输入不能抛：');
});

await test('C6：嵌套 node_modules/dsh-worktodo 取最后一段 —— 推不出就 null，绝不指到外层 profile', () => {
  // 稳定性审查：旧改动把 lastIndexOf 换成了 exec（第一个匹配），嵌套布局会切到外层、把别人的 profile
  // 当自己的。这里钉住「取最后一段 + 内层没有 package.json 就 null」。
  const outer = join(selfUpdateRoot, 'nested-outer');
  const outerPkg = join(outer, 'node_modules', 'dsh-worktodo', 'x');
  const libDir = join(outerPkg, 'node_modules', 'dsh-worktodo', 'lib');
  mkdirSync(libDir, { recursive: true });
  // 外层 profile 有 package.json（旧实现会错误地指向它）；内层先不放
  writeFileSync(join(outer, 'package.json'), JSON.stringify({
    name: 'dsh-profile-outer', private: true, dependencies: { 'dsh-worktodo': '^0.2.0' },
  }));
  writeFileSync(join(libDir, 'index.js'), '// fake nested module');
  const url = pathToFileURL(join(libDir, 'index.js')).href;

  eq(profileDirFromModuleUrl(url), null,
    'C6：内层没有 package.json 时必须返回 null（零写盘失败），绝不能指到外层 profile：');

  // 内层是真正的包根（有 package.json）→ 必须返回内层，而不是外层
  writeFileSync(join(outerPkg, 'package.json'), JSON.stringify({ name: 'dsh-worktodo', version: '0.2.0' }));
  eq(profileDirFromModuleUrl(url), outerPkg,
    `C6：嵌套布局必须取最后一段（内层 ${outerPkg}），不是外层 ${outer}：`);

  // 反过来：外层没有 package.json、内层有 → 仍然只认内层
  rmSync(join(outer, 'package.json'), { force: true });
  eq(profileDirFromModuleUrl(url), outerPkg, 'C6：外层没有清单也不影响内层判定：');
});

await test('Windows 路径：file:///C:/... → C:\\...\\profiles\\desktop（反斜杠/盘符大小写/%20/UNC 都认）', () => {
  // 1) 最常见的 Windows registry 安装布局（用户名用变量拼，避免 CI 隐私闸门把示例当真实家目录）
  const user = 'u';
  const winUrl = `file:///C:/Users/${user}/.dsh/profiles/desktop/node_modules/dsh-worktodo/lib/index.js`;
  const winProfile = win32.join('C:\\Users\\u\\.dsh\\profiles\\desktop');
  eq(profileDirFromModuleUrl(winUrl, { platform: 'win32', exists: () => true }), winProfile,
    'Windows file URL 必须切出 C:\\...\\profiles\\desktop：');
  eq(profileDirFromModuleUrl(winUrl, { platform: 'win32', exists: () => true }).includes('/'), false,
    '返回的目录必须是 Windows 分隔符（不能混进 /）：');

  // 2) 盘符小写：Windows 路径大小写不敏感，返回值按路径形状保留，但比较时必须等价
  const lower = profileDirFromModuleUrl(
    `file:///c:/users/${user}/.dsh/profiles/desktop/node_modules/dsh-worktodo/lib/index.js`,
    { platform: 'win32', exists: () => true },
  );
  eq(lower.toLowerCase(), winProfile.toLowerCase(), '盘符/目录大小写不同也必须等价：');

  // 3) %20：fileURLToPath 负责解码，绝不能把 %20 当目录名
  const spaced = profileDirFromModuleUrl(
    `file:///C:/Users/${user}/My%20Profile/profiles/desktop/node_modules/dsh-worktodo/lib/index.js`,
    { platform: 'win32', exists: () => true },
  );
  eq(spaced, win32.join('C:\\Users\\u\\My Profile\\profiles\\desktop'), '%20 必须解码成空格：');

  // 4) UNC：\\server\share\... 不能崩，也不能丢掉服务器名
  const unc = profileDirFromModuleUrl(
    'file://server/share/profiles/desktop/node_modules/dsh-worktodo/lib/index.js',
    { platform: 'win32', exists: () => true },
  );
  eq(unc, '\\\\server\\share\\profiles\\desktop', 'UNC 路径必须原样保留 \\\\server\\share：');

  // 5) 反斜杠写法（WORKTODO_PROFILE_DIR 注入）与 URL 推导等价
  const injected = resolveOwnProfileDir({
    platform: 'win32',
    env: { WORKTODO_PROFILE_DIR: 'C:\\Users\\u\\.dsh\\profiles\\desktop' },
  });
  eq(injected, winProfile, '显式注入的反斜杠 profile 路径必须原样 resolve：');
  eq(resolveOwnProfileDir({
    platform: 'win32',
    env: { WORKTODO_PROFILE_DIR: `C:/Users/${user}/.dsh/profiles/desktop` },
  }), winProfile, '注入路径用正斜杠时也要归一成 Windows 形状：');

  // 6) 目录里没有 package.json → 不算 profile（与 POSIX 同一规则）
  eq(profileDirFromModuleUrl(winUrl, { platform: 'win32', exists: () => false }), null,
    'Windows 路径也必须检查 profile 目录里的 package.json：');
  eq(profileDirFromModuleUrl('file:///C:/C:/not-a-profile/lib/index.js', { platform: 'win32', exists: () => true }), null,
    '没有 node_modules/dsh-worktodo 段时必须是 null（绝不猜目录）：');
});

await test('Windows 执行器：pnpm 必须走 node(pnpm.mjs) 或 pnpm.cmd+shell，绝不裸 spawn("pnpm")；CLI 拼 app.asar\\...\\cli.js', () => {
  const resources = 'C:\\Users\\u\\AppData\\Local\\Programs\\DeepSeek Harness\\resources';
  const execPath = 'C:\\Users\\u\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe';
  const bundledPnpm = win32.join(resources, 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs');
  const cliPath = win32.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  const archivePath = win32.join(resources, 'app.asar');
  // pnpm 看的是 pnpm.mjs 本体；CLI 看的是 **app.asar 归档文件**（asar 内部路径普通 fs 看不见）
  const pnpmExists = (candidate) => candidate === bundledPnpm;
  const cliExists = (candidate) => candidate === archivePath;

  // 1) 首选：同一进程的 node + 自带 pnpm.mjs（无 shell，argv 里带空格的路径不会被拆开）
  const pnpm = resolvePnpmUpdater({ platform: 'win32', resourcesPath: resources, execPath, exists: pnpmExists, env: {} });
  eq(pnpm.command, execPath, '自带 pnpm 必须用 process.execPath 跑，而不是 PATH 上的 pnpm：');
  eq(pnpm.args, [bundledPnpm], 'pnpm.mjs 必须作为一个完整 argv 传入（路径含空格也不能拆）：');
  eq(pnpm.env.ELECTRON_RUN_AS_NODE, '1', 'Electron 下必须带 ELECTRON_RUN_AS_NODE=1：');
  eq(pnpm.shell, false, '首选路径绝不经 shell（绕开 Windows 引号/空格问题）：');
  eq(pnpm.windowsHide, true, '所有 spawn 都必须 windowsHide: true：');
  eq(pnpm.command === 'pnpm', false, 'Windows 上绝不能裸 spawn("pnpm")（它是 pnpm.cmd，CreateProcess 解析不到）：');
  eq(bundledPnpmCandidates({ platform: 'win32', resourcesPath: resources, execPath }).includes(bundledPnpm), true,
    '候选路径必须包含 runtime/<name>/dependencies/pnpm/bin/pnpm.mjs 这一真实布局：');
  const steps = buildUpdateSteps({ cli: null, pnpm, profileName: 'desktop', registry: 'https://registry.npmjs.org/', target: FAKE_NEXT_VERSION });
  eq(steps[0].args[0], bundledPnpm, 'pnpm 步骤的第一个 argv 必须是完整的 pnpm.mjs 路径：');

  // 2) 找不到自带 pnpm.mjs：Windows 兜底必须是 pnpm.cmd + shell（仍带 windowsHide）
  const fallback = resolvePnpmUpdater({ platform: 'win32', resourcesPath: null, execPath, exists: () => false, env: {} });
  eq(fallback.command, 'pnpm.cmd', 'Windows 兜底命令必须是 pnpm.cmd：');
  eq(fallback.command === 'pnpm', false, '兜底也绝不能是裸 pnpm：');
  eq(fallback.shell, true, 'pnpm.cmd 必须配 shell: true，否则 cmd 脚本起不来：');
  eq(fallback.windowsHide, true, '兜底 spawn 也要 windowsHide: true：');

  // 3) POSIX 保持原样（回归：别把 Windows 修复带成 macOS/Linux 的回归）
  const posix = resolvePnpmUpdater({ platform: 'darwin', resourcesPath: null, execPath: '/usr/local/bin/node', exists: () => false, env: {} });
  eq(posix.command, 'pnpm', 'POSIX 仍用 PATH 上的 pnpm：');
  eq(posix.shell, false, 'POSIX 不需要 shell：');
  eq(posix.windowsHide, true, 'POSIX 也统一带 windowsHide（无害）：');

  // 4) CLI：Windows resourcesPath 必须拼成 resources\app.asar\...\cli.js
  const cli = resolveCliUpdater({ platform: 'win32', resourcesPath: resources, execPath, exists: cliExists });
  eq(cli.command, execPath, 'CLI 也必须用官方 node 可执行文件（Electron 二进制）：');
  eq(cli.args[0], '--expose-internals', 'CLI 启动参数要保留 --expose-internals：');
  eq(cli.args[1], cliPath, 'Windows 上必须拼出 resources\\app.asar\\...\\cli.js：');
  eq(cli.args[1].includes('app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js'), true,
    'CLI 路径必须是 Windows 反斜杠形状：');
  eq(cli.env.ELECTRON_RUN_AS_NODE, '1', '跑 asar 内 CLI 必须 ELECTRON_RUN_AS_NODE=1：');
  eq(cli.env.DSH_DESKTOP_NODE_EXECUTABLE, execPath, 'CLI 必须带上官方启动器同款 DSH_DESKTOP_NODE_EXECUTABLE：');
  const cliViaEnv = resolveCliUpdater({
    platform: 'win32', resourcesPath: resources, execPath: 'C:\\stale\\electron.exe', exists: cliExists,
    env: { DSH_DESKTOP_NODE_EXECUTABLE: execPath },
  });
  eq(cliViaEnv.command, execPath, 'DSH_DESKTOP_NODE_EXECUTABLE 必须优先于 process.execPath：');
  eq(cli.shell, false, 'CLI 不经 shell：');
  eq(cli.windowsHide, true, 'CLI spawn 也要 windowsHide: true：');
  eq(resolveCliUpdater({ platform: 'win32', resourcesPath: resources, execPath, exists: () => false }), null,
    '拿不到 CLI 必须返回 null，交给 pnpm 兜底（不能瞎猜一个不存在的路径）：');
});

await test('Windows 原子写：rename 覆盖失败 → 先删目标再 rename；仍失败 → 明确报错且不留半文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worktodo-win-atomic-'));
  const file = join(dir, 'package.json');
  // 同时盯临时文件与 win32 回退的 .bak：成功/失败收口后都不许把内部文件留在用户目录里
  const tmpFiles = () => readdirSync(dir).filter((name) => name.includes('.worktodo-'));
  try {
    writeFileSync(file, 'old-content');

    // 1) 第一次 rename 抛 EPERM（目标被占用/只读）→ 先删目标，再 rename 成功
    let renameCalls = 0;
    const renameFirstFails = (from, to) => {
      renameCalls += 1;
      if (renameCalls === 1) {
        const error = new Error('EPERM: operation not permitted, rename');
        error.code = 'EPERM';
        throw error;
      }
      renameSync(from, to);
    };
    writeFileAtomicSync(file, 'new-content', { platform: 'win32', rename: renameFirstFails });
    eq(readFileSync(file, 'utf8'), 'new-content', 'Windows rename 失败后必须先删目标、再 rename 成功：');
    eq(renameCalls, 2, '应当恰好重试一次 rename：');
    eq(tmpFiles(), [], '成功后不能留下临时文件：');

    // 2) 目标被占用且删不掉 → 必须明确报 Windows 原子写失败，原文件一个字节都不动，临时文件清掉
    writeFileSync(file, 'keep-me');
    let threw = null;
    try {
      writeFileAtomicSync(file, 'must-not-land', {
        platform: 'win32',
        rename: () => { const error = new Error('EBUSY'); error.code = 'EBUSY'; throw error; },
        unlink: (target) => {
          if (target === file) { const error = new Error('EPERM: locked'); error.code = 'EPERM'; throw error; }
          unlinkSync(target); // 清理临时文件必须还能成功
        },
      });
    } catch (error) {
      threw = error;
    }
    eq(Boolean(threw), true, '连目标都删不掉时必须抛错（不能假装写成功）：');
    eq(String(threw?.message).includes('Windows 原子写失败'), true, `错误必须是明确的 Windows 原子写失败：${threw?.message}`);
    eq(readFileSync(file, 'utf8'), 'keep-me', '失败时原文件必须保持旧内容（绝不半写）：');
    eq(tmpFiles(), [], '失败后也不能留下临时文件：');

    // 3) 非 Windows：rename 失败不吞、不删目标（保持原行为）
    writeFileSync(file, 'posix-old');
    let posixError = null;
    try {
      writeFileAtomicSync(file, 'posix-new', {
        platform: 'darwin',
        rename: () => { const error = new Error('EPERM'); error.code = 'EPERM'; throw error; },
      });
    } catch (error) {
      posixError = error;
    }
    eq(Boolean(posixError), true, 'POSIX rename 失败也必须抛：');
    eq(String(posixError?.message).includes('Windows 原子写失败'), false, 'POSIX 不该走 Windows 专用错误文案：');
    eq(readFileSync(file, 'utf8'), 'posix-old', 'POSIX 失败时原文件不动：');
    eq(tmpFiles(), [], 'POSIX 失败后也要清临时文件：');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('C1（严重）：win32 二次 rename 失败 → 目标仍存在且内容等于原值（从备份恢复，绝不消失）', () => {
  // 审查实跑过的数据丢失路径：旧实现「先 unlink 目标、再 rename」，第二次 rename 失败时
  // 目标已经被删、临时文件也被外层 catch 清掉 → targetExists=false。
  // 修复后：删目标前必须已有同目录 .bak；二次失败必须从备份恢复，最后才报错。
  const dir = mkdtempSync(join(tmpdir(), 'worktodo-win-atomic-restore-'));
  const file = join(dir, 'package.json');
  const original = `${JSON.stringify({ name: 'profile', dependencies: { 'dsh-worktodo': `^${PKG_VERSION}` } })}\n`;
  try {
    writeFileSync(file, original);
    let backupAtUnlink = false;
    let unlinkTargetCalls = 0;
    let threw = null;
    try {
      writeFileAtomicSync(file, 'NEW-CONTENT', {
        platform: 'win32',
        // 两次 rename 都失败：第一次触发回退，第二次触发「从备份恢复」
        rename: () => { const error = new Error('EPERM: operation not permitted, rename'); error.code = 'EPERM'; throw error; },
        unlink: (target) => {
          if (target === file) {
            unlinkTargetCalls += 1;
            // 删目标的那一刻，同目录必须已经有完整的 .bak
            backupAtUnlink = readdirSync(dir).some((name) => name.includes('.worktodo-bak-'));
          }
          unlinkSync(target);
        },
      });
    } catch (error) {
      threw = error;
    }
    eq(Boolean(threw), true, '两次 rename 都失败时必须抛错（不能假装写成功）：');
    eq(unlinkTargetCalls, 1, '回退只应删除目标一次：');
    eq(backupAtUnlink, true, 'C1：删除目标之前必须已经在同目录写好 .bak 备份（任何瞬间都不许「目标不存在且没有备份」）：');
    eq(existsSync(file), true, 'C1：二次 rename 失败后目标文件必须仍然存在（旧实现会把它删没）：');
    eq(readFileSync(file, 'utf8'), original, 'C1：目标内容必须逐字节等于原值：');
    eq(String(threw?.message).includes('已从备份恢复目标原内容'), true,
      `C1：错误必须说明已从备份恢复（实际：${threw?.message}）：`);
    eq(readdirSync(dir), ['package.json'], 'C1：恢复成功后不许留下临时文件或 .bak：');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('Windows 假成功护栏：落盘版本没变（含 null）绝不算升级成功；变了才算', () => {
  eq(installedVersionChanged('0.2.5', '0.2.5'), false, '版本没变必须判失败（退出码 0 不算数）：');
  eq(installedVersionChanged('0.2.5', '0.2.6'), true, '版本真的变了才算成功：');
  eq(installedVersionChanged('0.2.5', null), false, '读不到落盘版本 = 不能声称成功：');
  eq(installedVersionChanged(null, '0.2.6'), true, '原来没装、现在装上了：');
  eq(installedVersionChanged('0.2.5', '0.2.4'), true, '版本变了（即使是降级）也要如实判定「变了」，由上层比对目标：');
});

await test('自升级：配置默认值——autoUpdate 默认 true / autoInstall 默认 false、官方源、180s，非法值一律回落', async () => {
  // 纯函数层先钉死：autoUpdate 默认开（只查+下载）；autoInstall 默认关（安装必须用户点）。
  // 稳定性复审 A1/A2：默认 autoInstall:true 会让新用户第一次启动就被后台改 profile。
  eq(normalizeUpdateConfig(undefined), {
    autoUpdate: true,
    autoInstall: false,
    updateRegistry: 'https://registry.npmjs.org/',
    updateTimeoutMs: 180000,
    restartCommand: '',
  }, '无配置时必须默认自动更新，但**不**自动安装：');
  eq(normalizeUpdateConfig({}).autoUpdate, true, '空配置也必须默认自动更新：');
  eq(normalizeUpdateConfig({ autoUpdate: false }).autoUpdate, false, '显式 false 必须完全关掉：');
  eq(normalizeUpdateConfig({ autoUpdate: 'yes' }).autoUpdate, true, '只有**字面量** false 才关（配置里一个手滑的 falsy 值不该静默关掉用户要的自动更新）：');
  eq(normalizeUpdateConfig({ autoUpdate: 'false' }).autoUpdate, true, '字符串 "false" 不是字面量 false：');
  eq(normalizeUpdateConfig({ autoUpdate: 0 }).autoUpdate, true, '数字 0 不是字面量 false：');
  // autoInstall：默认 false = 后台只下到「已下载」，安装必须用户点；只有字面 true 才自动安装
  eq(normalizeUpdateConfig(undefined).autoInstall, false, 'autoInstall 默认必须 false（后台不许自动改 profile）：');
  eq(normalizeUpdateConfig({ autoInstall: true }).autoInstall, true, '显式 true 才恢复「后台下完就装」：');
  eq(normalizeUpdateConfig({ autoInstall: 'yes' }).autoInstall, false, '非布尔真值不算开启（与 autoUpdate 同一把口径）：');
  eq(normalizeUpdateConfig({ autoInstall: 1 }).autoInstall, false, '数字 1 不算开启：');
  // restartCommand 是显式 opt-in：不配就是空串（= 没有重启能力）
  eq(normalizeUpdateConfig(undefined).restartCommand, '', '没配 restartCommand 时必须是空串（不能凭空造一个重启命令）：');
  eq(normalizeUpdateConfig({ restartCommand: '  open -a DSH  ' }).restartCommand, 'open -a DSH', 'restartCommand 要 trim：');
  eq(normalizeUpdateConfig({ updateRegistry: '   ', updateTimeoutMs: -1 }).updateRegistry, 'https://registry.npmjs.org/', '空白 registry 回落官方源：');
  eq(normalizeUpdateConfig({ updateRegistry: '   ', updateTimeoutMs: -1 }).updateTimeoutMs, 180000, '非法超时回落默认：');

  const { host, dir } = await makeUpdateHost();
  try {
    // 只用 GET（POST 会去找真实 profile；这条用例只验默认值，绝不能碰真实安装）
    const defaults = (await readUpdateState(host)).json().data;
    // 面板/GET 状态要能看出「自动更新已开启」，否则用户没法解释「它怎么自己升级了」
    eq(defaults.autoUpdate, true, 'GET /worktodo/update 必须报出 autoUpdate: true：');
    eq(defaults.autoInstall, false, 'GET 状态必须报出 autoInstall: false（默认不自动安装）：');
    eq(defaults.restartSupported, false, 'DSH 没给插件留重启入口 → 默认必须报 restartSupported: false（不假装能重启）：');
    // 没注入 latest 且关掉了查询：阶段就是 idle（available 由下面的注入用例钉）
    eq(defaults.phase, 'idle', `没有可用新版本时阶段必须是 idle（实际 ${defaults.phase}）：`);
    eq(defaults.registry, 'https://registry.npmjs.org/', 'registry 默认必须是官方源：');
    eq(defaults.timeoutMs, 180000, '超时默认 180s：');
    eq(Array.isArray(defaults.steps), true, '状态里要有 steps 数组，能看出升级卡在哪一步：');

    const off = await makeUpdateHost({ autoUpdate: false });
    try {
      const explicit = (await readUpdateState(off.host)).json().data;
      eq(explicit.autoUpdate, false, '显式 false 必须原样报给面板（行为与旧版一致：完全不自动）：');
    } finally {
      rmSync(off.dir, { recursive: true, force: true });
    }

    const bad = await makeUpdateHost({ autoUpdate: 'yes', updateRegistry: '   ', updateTimeoutMs: -1 });
    try {
      const fallback = (await readUpdateState(bad.host)).json().data;
      eq(fallback.autoUpdate, true, `非字面 false 的 autoUpdate 回落默认开：${fallback.autoUpdate}`);
      eq(fallback.registry, 'https://registry.npmjs.org/', '空白 registry 必须回落官方源：');
      eq(fallback.timeoutMs, 180000, '非法超时必须回落默认值：');
    } finally {
      rmSync(bad.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('自升级：检查更新 20s / 重试 1 次 / 25s 预算 / 指数退避 30→60→120…上限 10 分钟', () => {
  // 这一条是「超时太短」的反向闸门：把常量改回 8s（或删掉重试预算）这里必须变红。
  eq(UPDATE_CHECK_TIMEOUT_MS, 20000, '单次检查超时必须是 20s（国内 npm registry 常见 10s+）：');
  eq(UPDATE_CHECK_RETRY_DELAY_MS, 3000, '失败后等 3s 再试一次：');
  eq(UPDATE_CHECK_TOTAL_BUDGET_MS, 25000, '整次检查预算约 25s（重试只用剩余预算）：');
  eq(resolveCheckTimeoutMs({}), 20000, '没有 env 覆盖时用 20s：');
  eq(resolveCheckTimeoutMs({ WORKTODO_CHECK_TIMEOUT_MS: '45000' }), 45000, 'WORKTODO_CHECK_TIMEOUT_MS 必须能覆盖（测试缝）：');
  eq(resolveCheckTimeoutMs({ WORKTODO_CHECK_TIMEOUT_MS: 'nope' }), 20000, '非法 env 回落 20s：');
  eq(resolveCheckRetryDelayMs({}), 3000);
  eq(resolveCheckRetryDelayMs({ WORKTODO_CHECK_RETRY_DELAY_MS: '0' }), 0, '测试缝允许把重试间隔设成 0：');
  eq(resolveCheckRetryDelayMs({ WORKTODO_CHECK_RETRY_DELAY_MS: 'nope' }), 3000);
  eq(resolveCheckBackoffMs(1), 30000, '第一次失败后 30s：');
  eq(resolveCheckBackoffMs(2), 60000, '第二次失败后 60s：');
  eq(resolveCheckBackoffMs(3), 120000, '第三次失败后 120s：');
  eq(resolveCheckBackoffMs(4), 240000);
  eq(resolveCheckBackoffMs(5), 480000);
  eq(resolveCheckBackoffMs(6), 600000, '上限 10 分钟：');
  eq(resolveCheckBackoffMs(99), 600000, '再多次失败也不超过 10 分钟：');
  eq(UPDATE_CHECK_BACKOFF_BASE_MS, 30000);
  eq(UPDATE_CHECK_BACKOFF_MAX_MS, 600000);
});

await test('自升级：registry 慢响应超时 → check-failed 温和态（不是 failed），/list 首屏 <100ms、hasUpdate=false', async () => {
  const requests = [];
  const pendingTimers = new Set();
  const slowRegistry = createServer((request, response) => {
    requests.push(Date.now());
    // 25s 后才回：模拟「国内访问 npm registry 10s+」的真实慢响应。
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      try {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ 'dist-tags': { latest: FAKE_NEXT_VERSION }, versions: {} }));
      } catch { /* 测试已结束/连接已断 */ }
    }, 25000);
    timer.unref?.();
    pendingTimers.add(timer);
  });
  await new Promise((resolve) => slowRegistry.listen(0, '127.0.0.1', resolve));
  slowRegistry.unref();
  try {
    await withEnv({
      WORKTODO_NO_UPDATE_CHECK: undefined,
      WORKTODO_UPDATE_LATEST: undefined,
      // 测试缝：把 20s/3s 压到 300ms/50ms，但走的仍是同一条「超时 → 新 AbortController 重试」路径。
      WORKTODO_CHECK_TIMEOUT_MS: '300',
      WORKTODO_CHECK_RETRY_DELAY_MS: '50',
    }, async () => {
      const { host, dir } = await makeUpdateHost({
        autoUpdate: false,
        updateRegistry: `http://127.0.0.1:${slowRegistry.address().port}/`,
      });
      try {
        // 前置：检查必须真的在飞，否则下面的 /list 计时没有牙齿。
        const during = (await readUpdateState(host)).json().data;
        eq(during.phase, 'checking', `前置条件：启动检查应当正在飞（实际 ${during.phase}）：`);

        const startedAt = Date.now();
        const list = await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' });
        const elapsed = Date.now() - startedAt;
        eq(list.statusCode, 200);
        eq(list.json().ok, true);
        eq(elapsed < 100, true, `/list 首屏不能被检查超时拖慢（实际 ${elapsed}ms，要求 <100ms）：`);
        console.log(`      [check] 慢 registry 检查在飞时 /list 首屏 ${elapsed}ms（要求 <100ms）`);
        eq(list.json().data.update.hasUpdate, false, '还没查到时不能声称有更新：');

        const status = await waitForUpdatePhase(host, (state) => state.phase === 'check-failed', 5000);
        eq(status?.phase, 'check-failed', `超时后必须落在温和的 check-failed（实际 ${status?.phase}）：`);
        eq(status?.state, 'idle', '兼容 state 必须是 idle，老面板不会亮红色 failed：');
        eq(status?.checkError?.reason, 'timeout', `失败原因要稳定归类成 timeout（实际 ${status?.checkError?.reason}）：`);
        eq(status?.checkError?.retriable, true, '要告诉面板这是可重试的：');
        eq(status?.checkError?.attempt, 2, '超时后必须自动重试一次（attempt=2）：');
        eq(status?.checkError?.retryInMs, 30000, '第一次失败后按 30s 退避：');
        eq(status?.failedOperation, null, '检查失败不是下载/安装失败：');
        eq(status?.failure, null, '检查失败不能塞进 failure（那是下载/安装的稳定失败种类）：');
        eq(status?.error, null, '原始错误不能出现在面板读的 error 字段：');
        eq(requests.length, 2, `失败后必须用新请求重试一次（假 registry 实际收到 ${requests.length} 次）：`);

        // 列表摘要同样温和：phase/checkError 有，raw error 不在；hasUpdate 仍 false。
        const listed = (await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' })).json().data;
        eq(listed.update.hasUpdate, false, '检查失败后 hasUpdate 必须是 false（没查到 = 不知道/无更新）：');
        eq(listed.update.run.phase, 'check-failed');
        eq(listed.update.run.checkError?.reason, 'timeout');
        eq(listed.update.run.error, null, '列表摘要不能带原始网络错误：');

        // 手动点检查失败：仍然温和（不是 failed 红态），且连续失败按 60s 退避。
        const manual = (await triggerUpdate(host, { action: 'plugin-update-check' })).json();
        eq(manual.ok, true, 'check 路由本身要走 200 data（不是请求失败）：');
        eq(manual.data.phase, 'check-failed', '手动检查失败也必须是温和态：');
        eq(manual.data.failedOperation, null);
        eq(manual.data.checkError?.retryInMs, 60000, `连续第二次失败要退避到 60s（实际 ${manual.data.checkError?.retryInMs}）：`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  } finally {
    for (const timer of pendingTimers) clearTimeout(timer);
    slowRegistry.closeAllConnections?.();
    slowRegistry.close();
  }
});

await test('自升级：第一次超时、第二次立即成功 → 退避后重试拿到版本，checkError 复位', async () => {
  let hits = 0;
  const pendingTimers = new Set();
  const registry = createServer((request, response) => {
    hits += 1;
    if (hits === 1) {
      // 第一次故意超过 200ms 超时；被 abort 后第二次请求立即成功。
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        try {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ 'dist-tags': { latest: FAKE_NEXT_VERSION }, versions: {} }));
        } catch { /* 已断开 */ }
      }, 5000);
      timer.unref?.();
      pendingTimers.add(timer);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ 'dist-tags': { latest: FAKE_NEXT_VERSION }, versions: {} }));
  });
  await new Promise((resolve) => registry.listen(0, '127.0.0.1', resolve));
  registry.unref();
  try {
    await withEnv({
      WORKTODO_NO_UPDATE_CHECK: undefined,
      WORKTODO_UPDATE_LATEST: undefined,
      WORKTODO_CHECK_TIMEOUT_MS: '200',
      WORKTODO_CHECK_RETRY_DELAY_MS: '50',
    }, async () => {
      const { host, dir } = await makeUpdateHost({
        autoUpdate: false,
        updateRegistry: `http://127.0.0.1:${registry.address().port}/`,
      });
      try {
        const available = await waitForUpdatePhase(host, (state) => state.phase === 'available', 5000);
        eq(available?.phase, 'available', `第二次成功后必须落到 available（实际 ${available?.phase}，reason=${available?.checkError?.reason}）：`);
        eq(available?.checkError, null, '成功后 checkError 必须复位：');
        eq(available?.to, FAKE_NEXT_VERSION, '必须拿到第二次请求返回的新版本：');
        eq(hits, 2, `必须真的重试了一次（实际请求 ${hits} 次）：`);
        const listed = (await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' })).json().data;
        eq(listed.update.hasUpdate, true, '重试成功后列表要看到新版本：');
        eq(listed.update.run.checkError, null, '成功后 /list 摘要里的 checkError 也要清掉：');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  } finally {
    for (const timer of pendingTimers) clearTimeout(timer);
    registry.closeAllConnections?.();
    registry.close();
  }
});

await test('自升级：shouldAutoUpdate 只在开启、有新版、不重入、且这个 latest 没试过时为 true', () => {
  const base = { enabled: true, latest: '0.2.4', current: '0.2.0', runState: 'idle', attempted: null };
  eq(shouldAutoUpdate(base), true, '默认开启 + 有新版 → 该自动升级：');
  eq(shouldAutoUpdate({ ...base, enabled: false }), false, '显式关闭后一次都不跑：');
  eq(shouldAutoUpdate({ ...base, enabled: 'true' }), false, '非布尔真值不算开启：');
  eq(shouldAutoUpdate({ ...base, latest: null }), false, '没查到新版不跑：');
  eq(shouldAutoUpdate({ ...base, latest: '0.2.0' }), false, '没有新版可比不算：');
  eq(shouldAutoUpdate({ ...base, runState: 'running' }), false, '正在跑不重入：');
  eq(shouldAutoUpdate({ ...base, attempted: '0.2.4' }), false, '同一个版本只自动试一次：');
  eq(shouldAutoUpdate({ ...base, attempted: '0.2.3' }), true, '换了一个新版本可以再试：');
  // 已经升级完成（落盘 0.2.4）时不该再自动装一次
  eq(shouldAutoUpdate({ ...base, current: '0.2.4' }), false, '已是最新就不该再跑：');
});

await test('自升级：buildUpdateSteps 的步骤顺序——CLI 优先，再 pnpm update，最后交 pnpm add 精确版本', () => {
  const cli = { args: ['/tmp/fake-cli.mjs'] };
  const pnpm = { args: [] };
  const withCli = buildUpdateSteps({ cli, pnpm, profileName: 'desktop', registry: 'https://registry.npmjs.org/', target: FAKE_NEXT_VERSION });
  eq(withCli.map((step) => step.kind), ['cli-add-latest', 'pnpm-update', 'pnpm-add-exact'], 'CLI 可用时三步都要有且顺序固定：');
  eq(withCli[0].args.join(' '), `/tmp/fake-cli.mjs plugin --profile desktop add dsh-worktodo@latest --registry https://registry.npmjs.org/`);
  eq(withCli[1].args.join(' '), 'update dsh-worktodo --registry https://registry.npmjs.org/');
  eq(withCli[2].args.join(' '), `add dsh-worktodo@${FAKE_NEXT_VERSION} --save-exact --registry https://registry.npmjs.org/`,
    'A1 首选方案：第 3 步必须让 pnpm 自己去改规格（add --save-exact），插件不再手写 profile JSON：');
  eq(withCli[2].requiresTarget, true, '第 3 步必须依赖 registry 的精确版本：');
  eq(withCli[2].prepare, undefined, '第 3 步绝不允许再有「自己改写 profile」的 prepare 副作用：');

  const pnpmOnly = buildUpdateSteps({ cli: null, pnpm, profileName: 'p', registry: 'https://r.example/', target: null });
  eq(pnpmOnly.map((step) => step.kind), ['pnpm-update', 'pnpm-add-exact'], '拿不到 CLI 时退回 pnpm 两步：');
  eq(pnpmOnly[1].requiresTarget, true, '没有目标版本时这一步会被 requiresTarget 跳过（绝不写 latest 之外的猜值）：');
  // 每条命令都要显式带 --registry（默认官方源，可 config 覆盖）
  const custom = buildUpdateSteps({ cli: null, pnpm, profileName: 'p', registry: 'https://mirror.example/', target: '1.0.0' });
  for (const step of custom) {
    eq(step.args.includes('--registry') && step.args.includes('https://mirror.example/'), true, `自定义源也要显式带 --registry：${step.args.join(' ')}`);
  }
});

await test('自动更新：显式 autoUpdate:false → 有新版本（已注入）也零子进程', async () => {
  const profile = makeFakeProfile('auto-off', '^0.2.0');
  seedInstalledVersion(profile, '0.2.0');
  const capture = join(selfUpdateRoot, 'capture-auto-off.txt');
  const bin = join(selfUpdateRoot, 'bin-auto-off');
  writeFakePnpm(bin, { capture, installVersion: '9.9.9', installProfile: profile, installOn: 'any' });
  const dir = mkdtempSync(join(tmpdir(), 'worktodo-autohost-'));
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile, PATH: `${bin}:${process.env.PATH}`,
      WORKTODO_PNPM_PATH: undefined, WORKTODO_UPDATE_LATEST: '9.9.9',
      WORKTODO_UPDATE_STATE_PATH: join(selfUpdateRoot, 'update-state-auto-off.json'),
    }, async () => {
      const host = makeCtx();
      await apply(host.ctx, { storePath: join(dir, 'todos.json'), autoUpdate: false });
      await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' });
      await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      eq(invokeCount(capture), 0, `显式关闭后绝不允许起任何子进程（实际 ${invokeCount(capture)}）：`);
      const status = (await readUpdateState(host)).json().data;
      eq(status.autoUpdate, false, '状态要原样报 false：');
      eq(status.state, 'idle', `关闭后不该有任何升级动作（实际 ${status.state}）：`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('自动更新：link: 安装即使默认开启也一个子进程都不起（不拆开发工作流）', async () => {
  const profile = makeFakeProfile('auto-linked', 'link:/tmp/fake/dsh-worktodo');
  const capture = join(selfUpdateRoot, 'capture-auto-linked.txt');
  const bin = join(selfUpdateRoot, 'bin-auto-linked');
  writeFakePnpm(bin, { capture, installVersion: '9.9.9', installProfile: profile, installOn: 'any' });
  const dir = mkdtempSync(join(tmpdir(), 'worktodo-autohost-'));
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile, PATH: `${bin}:${process.env.PATH}`,
      WORKTODO_PNPM_PATH: undefined, WORKTODO_UPDATE_LATEST: '9.9.9',
      WORKTODO_UPDATE_STATE_PATH: join(selfUpdateRoot, 'update-state-auto-linked.json'),
    }, async () => {
      const host = makeCtx();
      // autoUpdate 默认 true；显式 autoInstall:true 才会走到 install 预判
      await apply(host.ctx, { storePath: join(dir, 'todos.json'), autoInstall: true });
      await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      eq(invokeCount(capture), 0, `link: 场景自动更新也必须零子进程（实际 ${invokeCount(capture)}）：`);
      const status = (await readUpdateState(host)).json().data;
      eq(status.phase, 'unsupported', `自动更新也要提前判成 unsupported（实际 ${status.phase}）：`);
      eq(status.updateUnsupported, 'link-install', `要明确回报 link-install：${JSON.stringify(status)}`);
      eq(status.state, 'idle', '兼容层保持 idle：');
      eq(String(status.error).includes('git/pnpm'), true, `要说清该走哪条更新工作流：${status.error}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('A1：启动检查默认延后 20–30s（绝不是 apply 后立刻抢跑），测试缝可设 0', () => {
  const fallback = resolveStartupCheckDelayMs({});
  eq(fallback >= 20000 && fallback <= 30000, true,
    `默认延后必须落在 20–30s（实际 ${fallback}ms）：`);
  eq(resolveStartupCheckDelayMs({ WORKTODO_STARTUP_CHECK_DELAY_MS: '0' }), 0,
    '测试缝 0 = 立刻检查：');
  eq(resolveStartupCheckDelayMs({ WORKTODO_STARTUP_CHECK_DELAY_MS: 'abc' }), fallback,
    '非法值必须回落默认：');
  eq(resolveStartupCheckDelayMs({ WORKTODO_STARTUP_CHECK_DELAY_MS: '-5' }), fallback,
    '负数必须回落默认：');
});

await test('A1/A2（高）：默认更新方式 = manual —— 只检查，不下载、不安装、不写盘', async () => {
  // 安全默认是 manual：后台**只检查**，绝不自动下载/安装（auto 必须由用户显式选）。
  // 这里用默认配置 + 注入 latest，证明「看到新版本」也不会下、不会装、不会写任何东西。
  const profile = makeFakeProfile('startup-default', '^0.2.0');
  seedInstalledVersion(profile, '0.2.0');
  const manifest = join(profile, 'package.json');
  const originalBytes = readFileSync(manifest, 'utf8');
  const mtime = statSync(manifest).mtimeMs;
  const capture = join(selfUpdateRoot, 'capture-startup-default.txt');
  const bin = join(selfUpdateRoot, 'bin-startup-default');
  writeFakePnpm(bin, { capture, installVersion: FAKE_NEXT_VERSION, installProfile: profile, installOn: 'any' });
  const stageDir = join(selfUpdateRoot, 'stage-startup-default');
  const statePath = join(selfUpdateRoot, 'update-state-startup-default.json');
  let host;
  let dir;
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile, PATH: `${bin}:${process.env.PATH}`,
      WORKTODO_PNPM_PATH: undefined, WORKTODO_UPDATE_LATEST: FAKE_NEXT_VERSION,
      WORKTODO_UPDATE_STAGE_DIR: stageDir, WORKTODO_UPDATE_STATE_PATH: statePath,
    }, async () => {
      ({ host, dir } = await makeUpdateHost()); // 不传任何配置 = 默认值（必须在上面的 env 里 apply）
      const status = await waitForUpdatePhase(host, (state) => state.phase === 'available', 5000);
      eq(status?.phase, 'available', `默认 manual 只该检查到 available（实际 ${status?.phase}，error=${status?.error}）：`);
      eq(status?.updateMode, 'manual', '默认更新方式必须是 manual（安全默认）：');
      eq(status?.effective?.autoCheck, true, 'manual 仍然要检查（不是 off）：');
      eq(status?.effective?.autoInstall, false, 'manual 绝不自动安装：');
      await new Promise((resolve) => setTimeout(resolve, 300));
      eq(invokeCount(capture), 0,
        `A1：manual 下绝不允许起任何下载/安装子进程（实际起了 ${invokeCount(capture)} 个 pnpm 子进程）：`);
      eq(readFileSync(manifest, 'utf8'), originalBytes, 'A1：manual 下 profile 清单必须逐字节不变：');
      eq(statSync(manifest).mtimeMs, mtime, 'A1：连 mtime 都不许变（= 零写盘）：');
      eq(existsSync(stageDir), false, 'A1：manual 绝不自动下载（暂存区不该出现）：');
      eq(existsSync(statePath), false, 'A1：manual 不产生任何自动更新节流状态（零写盘）：');
    });
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
    rmSync(stageDir, { recursive: true, force: true });
  }
});

await test('A1/A2：启动检查确实延后 —— apply 返回后先 idle，延时到了才 available', async () => {
  const profile = makeFakeProfile('startup-delayed', '^0.2.0');
  seedInstalledVersion(profile, '0.2.0');
  const statePath = join(selfUpdateRoot, 'update-state-startup-delayed.json');
  const started = Date.now();
  let host;
  let dir;
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile, WORKTODO_UPDATE_LATEST: FAKE_NEXT_VERSION,
      WORKTODO_STARTUP_CHECK_DELAY_MS: '350', WORKTODO_UPDATE_STATE_PATH: statePath,
    }, async () => {
      ({ host, dir } = await makeUpdateHost({ autoUpdate: false }));
      const immediate = (await readUpdateState(host)).json().data;
      eq(immediate.phase, 'idle',
        `A1：apply 刚返回时检查必须还没跑（实际 ${immediate.phase}）；旧实现约 50ms 就抢跑：`);
      await new Promise((resolve) => setTimeout(resolve, 120));
      eq((await readUpdateState(host)).json().data.phase, 'idle',
        'A1：延后窗口内阶段必须仍是 idle：');
      const arrived = await waitForUpdatePhase(host, (state) => state.phase === 'available', 3000);
      eq(arrived?.phase, 'available', `A1：延时到了必须真的检查（实际 ${arrived?.phase}）：`);
      const elapsed = Date.now() - started;
      eq(elapsed >= 300, true, `A1：检查必须被延后（实际 ${elapsed}ms，配置 350ms）：`);
    });
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

await test('A4：节流状态文件默认落在 $DSH_HOME/worktodo/update-state.json（插件自己的目录，不是待办数据文件）', () => {
  eq(resolveUpdateStatePath({ env: {}, home: '/tmp/fake-home' }), '/tmp/fake-home/worktodo/update-state.json');
  eq(resolveUpdateStatePath({ env: { WORKTODO_UPDATE_STATE_PATH: ' /tmp/x.json ' }, home: '/tmp/fake-home' }), '/tmp/x.json',
    '测试缝要能覆盖成临时文件（否则测试会去写真实 ~/.dsh）：');
  eq(resolveUpdateStatePath({ env: {}, home: null }), null, '拿不到家目录时宁可不写状态文件：');
  const p = resolveUpdateStatePath({ env: {}, home: '/tmp/fake-home' });
  eq(/storages|todos\.json/.test(p), false, 'A4：绝不能把节流状态写进用户待办数据文件：');
});

await test('A1：writeFileAtomicSync 失败不动原文件 / 成功无残留 / 保留权限（裸 writeFileSync 会在这里被抓住）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worktodo-atomic-'));
  const file = join(dir, 'package.json');
  try {
    writeFileSync(file, '{"a":1}\n', { mode: 0o600 });
    writeFileAtomicSync(file, '{"a":2}\n');
    eq(readFileSync(file, 'utf8'), '{"a":2}\n', '成功时内容要替换：');
    eq(statSync(file).mode & 0o777, 0o600, '要保留原文件权限（profile 里可能是 0600）：');
    eq(readdirSync(dir), ['package.json'], '不许留下临时文件：');
    // 目标目录只读 → 临时文件建不出来：原文件必须一个字节都不动。
    // 注意：这个场景**只有原子写**能过 —— 裸 writeFileSync 写的是已存在的文件，
    // 不需要目录写权限，会把内容改掉（用例因此在那是红的）。
    chmodSync(dir, 0o500);
    let threw = null;
    try {
      writeFileAtomicSync(file, '{"a":3}\n');
    } catch (error) {
      threw = error;
    }
    eq(Boolean(threw), true, `目录不可写时必须抛错：${JSON.stringify(threw)}`);
    eq(readFileSync(file, 'utf8'), '{"a":2}\n', 'A1：失败时原文件必须保持原样：');
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('A5：反推不出本实例 profile → unsupported/profile-undetermined，零写盘、绝不猜别的 profile', async () => {
  const home = mkdtempSync(join(tmpdir(), 'worktodo-a5-home-'));
  const aaa = join(home, 'profiles', 'aaa');
  const zzz = join(home, 'profiles', 'zzz');
  mkdirSync(aaa, { recursive: true });
  mkdirSync(zzz, { recursive: true });
  const aaaBytes = `${JSON.stringify({ name: 'dsh-profile-aaa', private: true, dependencies: { 'dsh-worktodo': '^0.2.0' } }, null, 2)}\n`;
  const zzzBytes = `${JSON.stringify({ name: 'dsh-profile-zzz', private: true, dependencies: { 'dsh-worktodo': 'link:../../default-workspace/dsh-worktodo' } }, null, 2)}\n`;
  writeFileSync(join(aaa, 'package.json'), aaaBytes);
  writeFileSync(join(zzz, 'package.json'), zzzBytes);
  const aaaMtime = statSync(join(aaa, 'package.json')).mtimeMs;
  const homeBefore = snapshotTree(home);
  const capture = join(selfUpdateRoot, 'capture-a5.txt');
  const bin = join(selfUpdateRoot, 'bin-a5');
  // 假 pnpm 会在 aaa 里换版本 —— 如果插件去猜 profile，aaa 就会被改写（审查实跑的结果）
  writeFakePnpm(bin, { capture, installVersion: '9.9.9', installProfile: aaa, installOn: 'any' });
  const { host, dir } = await makeUpdateHost({ autoUpdate: false });
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: undefined, DSH_HOME: home,
      PATH: `${bin}:${process.env.PATH}`, WORKTODO_PNPM_PATH: undefined,
      WORKTODO_UPDATE_LATEST: '9.9.9', WORKTODO_UPDATE_STATE_PATH: join(home, 'update-state.json'),
    }, async () => {
      const response = await triggerUpdate(host);
      eq(response.json().ok, false, '反推不出 profile 时必须拒绝，而不是猜一个：');
      eq(response.json().reason, 'profile-undetermined');
      const body = (await readUpdateState(host)).json().data;
      eq(body.phase, 'unsupported', `推不出 profile 是预期内的不适用（实际 ${body.phase}）：`);
      eq(body.updateUnsupported, 'profile-undetermined', `种类要是 profile-undetermined：${JSON.stringify(body)}`);
      eq(body.state, 'idle', '兼容层保持 idle（不亮红）：');
      eq(body.failure, null, '不是 failure：');
      eq(/失败/.test(String(body.error)), false, `文案不能出现「失败」：${body.error}`);
      eq(/反推不出/.test(String(body.error)), false, `技术串不许上面板：${body.error}`);
      eq(String(body.diagnostics?.detail).includes('profiles'), true,
        `技术细节只进 diagnostics：${JSON.stringify(body.diagnostics)}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      eq(invokeCount(capture), 0, `A5：一个子进程都不许起（实际 ${invokeCount(capture)}）：`);
      eq(readFileSync(join(aaa, 'package.json'), 'utf8') === aaaBytes, true, 'A5：字典序第一个 profile（aaa）一个字节都不许动：');
      eq(readFileSync(join(zzz, 'package.json'), 'utf8') === zzzBytes, true, 'A5：link: 的 zzz 也不许动：');
      eq(statSync(join(aaa, 'package.json')).mtimeMs, aaaMtime, 'A5：aaa 的 mtime 也不许变（零写盘）：');
      eq(snapshotTree(home), homeBefore, 'A5：整个 $DSH_HOME 逐字节不变（没有新文件）：');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

await test('小问题 2：profile 清单不是合法 JSON → 文案说准原因（不是「没有依赖」），零子进程零写盘', async () => {
  const profile = join(selfUpdateRoot, 'manifest-invalid');
  mkdirSync(profile, { recursive: true });
  // 带 `//` 注释的清单：JSON.parse 必然失败（用户手改 profile 时很常见）
  const bytes = `{\n  "name": "dsh-profile-invalid",\n  "private": true,\n  // 注释不是合法 JSON\n  "dependencies": { "dsh-worktodo": "^0.2.0" }\n}\n`;
  const manifest = join(profile, 'package.json');
  writeFileSync(manifest, bytes);
  const mtime = statSync(manifest).mtimeMs;
  const capture = join(selfUpdateRoot, 'capture-manifest-invalid.txt');
  const bin = join(selfUpdateRoot, 'bin-manifest-invalid');
  writeFakePnpm(bin, { capture, installVersion: '9.9.9', installProfile: profile, installOn: 'any' });
  const { host, dir } = await makeUpdateHost({ autoUpdate: false });
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile, PATH: `${bin}:${process.env.PATH}`,
      WORKTODO_PNPM_PATH: undefined, WORKTODO_UPDATE_LATEST: '9.9.9',
    }, async () => {
      const body = (await triggerUpdate(host)).json();
      eq(body.ok, false, `非法清单必须被拒绝：${JSON.stringify(body)}`);
      eq(body.reason, 'profile-manifest-invalid', `问题 2：测试要能区分「清单坏了」与「没有依赖」：${JSON.stringify(body)}`);
      eq(String(body.error).includes('不是合法 JSON'), true, `问题 2：文案必须说「不是合法 JSON」：${body.error}`);
      eq(String(body.error).includes(manifest), true, `问题 2：文案要给出具体路径：${body.error}`);
      eq(String(body.error).includes('已跳过安装与写盘'), true, `问题 2：要说明「零写盘」的行为：${body.error}`);
      eq(String(body.error).includes('没有 dsh-worktodo 依赖'), false, `问题 2：绝不能报成「没有依赖」（误导）：${body.error}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      eq(invokeCount(capture), 0, `问题 2：非法清单一个子进程都不许起（实际 ${invokeCount(capture)}）：`);
      eq(readFileSync(manifest, 'utf8') === bytes, true, '问题 2：零写盘，清单逐字节不变：');
      eq(statSync(manifest).mtimeMs, mtime, '问题 2：连 mtime 都不许变：');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('小问题 2：profile 清单读不到 → 说的是「读不到」，同样零子进程零写盘', async () => {
  const profile = join(selfUpdateRoot, 'manifest-missing');
  mkdirSync(profile, { recursive: true });
  const capture = join(selfUpdateRoot, 'capture-manifest-missing.txt');
  const bin = join(selfUpdateRoot, 'bin-manifest-missing');
  writeFakePnpm(bin, { capture, installVersion: '9.9.9', installProfile: profile, installOn: 'any' });
  const { host, dir } = await makeUpdateHost({ autoUpdate: false });
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile, PATH: `${bin}:${process.env.PATH}`,
      WORKTODO_PNPM_PATH: undefined, WORKTODO_UPDATE_LATEST: '9.9.9',
    }, async () => {
      const body = (await triggerUpdate(host)).json();
      eq(body.ok, false, `读不到清单必须被拒绝：${JSON.stringify(body)}`);
      eq(body.reason, 'profile-manifest-unreadable', `问题 2：「读不到」要有自己的 reason：${JSON.stringify(body)}`);
      eq(String(body.error).includes('读不到 profile 清单'), true, `问题 2：文案要说「读不到 profile 清单」：${body.error}`);
      eq(String(body.error).includes('没有'), false, `问题 2：不能与「没有依赖」混用：${body.error}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      eq(invokeCount(capture), 0, `问题 2：一个子进程都不许起（实际 ${invokeCount(capture)}）：`);
      eq(existsSync(join(profile, 'package.json')), false, '问题 2：零写盘 —— 不许凭空创建清单文件：');
      eq(readdirSync(profile).length, 0, `问题 2：目录里不该多出任何文件：${readdirSync(profile).join(', ')}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('自升级：带 ref 的 POST /update 仍是「改待办」，不会被升级劫持', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worktodo-update-edit-'));
  try {
    const host = makeCtx();
    await apply(host.ctx, { storePath: join(dir, 'todos.json') });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const created = await call(host.routes.get('/worktodo/create').handler, {
      method: 'POST', url: '/worktodo/create', body: { title: '别把我当成升级' },
    });
    const id = created.json().data.todo.id;
    const edited = await call(host.routes.get('/worktodo/update').handler, {
      method: 'POST', url: '/worktodo/update', body: { ref: id, title: '改过的标题' },
    });
    eq(edited.json().ok, true, `改待办的老语义必须保留：${JSON.stringify(edited.json())}`);
    eq(edited.json().data.todo.title, '改过的标题');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(selfUpdateRoot, { recursive: true, force: true });
  }
});

/**
 * 起一个只用于「面板配置下发」用例的宿主（独立临时 store，独立配置）。
 * 为什么不能复用主宿主：config 在 apply 时一次性归一化，改了要重新挂载。
 */
async function makePanelConfigHost(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'worktodo-panelcfg-'));
  const host = makeCtx();
  await apply(host.ctx, { storePath: join(dir, 'todos.json'), ...config });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { host, dir };
}

/* ------------------------------------------------------------------ *
 * 自升级的「两步」交互（照 DSH 桌面版更新器：下载 → 安装并重启）
 *
 * 为什么这些用例必须在**真网络流**上跑：`downloadUpdate` 走的是 fetch + 流式读，
 * 用 mock 替掉 fetch 就等于不测进度、不测截断、不测校验。这里起一个只监听 127.0.0.1 的
 * 一次性 HTTP 服务当假 registry，真的把字节传过来。
 * ------------------------------------------------------------------ */

/**
 * 起一个一次性的假 tarball 分发源。
 * @param {{chunks?: number, chunkSize?: number, delayMs?: number, status?: number}} [options]
 * @returns {Promise<{base: string, body: Buffer, close: () => Promise<void>}>}
 */
async function startTarballServer({ version = FAKE_NEXT_VERSION, chunks = 4, delayMs = 0, status = 200 } = {}) {
  // 合法 tarball（解包后是完整包目录）；按请求 URL 里的版本生成，按 chunks 切片发送，
  // 让「下载中」的进度可见。
  const stats = { hits: 0 };
  const server = createServer(async (request, response) => {
    stats.hits += 1;
    if (status !== 200) {
      response.writeHead(status, { 'content-length': '0' });
      response.end();
      return;
    }
    const match = /dsh-worktodo-(\d+\.\d+\.\d+)\.tgz/.exec(String(request.url ?? ''));
    const body = buildFakeTarball(match?.[1] ?? version);
    const slice = Math.max(1, Math.ceil(body.length / Math.max(1, chunks)));
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
    for (let offset = 0; offset < body.length; offset += slice) {
      response.write(body.subarray(offset, Math.min(body.length, offset + slice)));
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}/`,
    stats,
    get hits() { return stats.hits; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 造一个「能真的换掉落盘版本」的假 pnpm（安装链路的正向路径）。 */
function makeInstallingPnpm(tag, profile) {
  const capture = join(selfUpdateRoot, `capture-${tag}.txt`);
  const bin = join(selfUpdateRoot, `bin-${tag}`);
  writeFakePnpm(bin, { capture, installVersion: '9.9.9', installProfile: profile, installOn: 'any' });
  return { capture, bin };
}

await test('自升级（两步）：下载失败 → failed + failedOperation:download（不落半个文件），换好源后重试成功', async () => {
  const profile = makeFakeProfile('flow-download-fail', '^0.2.0');
  seedInstalledVersion(profile, '0.2.0');
  const { capture, bin } = makeInstallingPnpm('flow-download-fail', profile);
  const broken = await startTarballServer({ status: 503 });
  const good = await startTarballServer({ chunks: 1, chunkSize: 1024 });
  const stageDir = join(selfUpdateRoot, 'stage-download-fail');
  let host;
  let dir;
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile, PATH: `${bin}:${process.env.PATH}`,
      WORKTODO_PNPM_PATH: undefined, WORKTODO_UPDATE_LATEST: '9.9.9',
      WORKTODO_UPDATE_TARBALL_BASE: broken.base, WORKTODO_UPDATE_STAGE_DIR: stageDir,
    }, async () => {
      ({ host, dir } = await makeUpdateHost({ autoUpdate: false }));
      const failed = (await triggerUpdate(host, { action: 'plugin-update-download' })).json();
      eq(failed.ok, false, '源返回 503 时下载必须失败（不是悄悄成功）：');
      eq(failed.reason, 'download-failed', `失败原因要是稳定的 download-failed：${failed.reason}`);
      eq(String(failed.error).includes('503'), true, `错误里要带上网关状态：${failed.error}`);
      const status = (await readUpdateState(host)).json().data;
      eq(status.phase, 'failed', `下载失败必须落到 failed：${status.phase}`);
      eq(status.state, 'failed', '老字段 state 也要是 failed：');
      eq(status.failedOperation, 'download', 'failedOperation 必须指明是下载这一步：');
      eq(['download', 'download-network'].includes(status.failure), true, `要给出稳定的失败种类：${status.failure}`);
      eq(status.percent, null, '失败后不能再挂着一个百分比：');
      eq(status.download, null, '失败时不该有「已下载」记录：');
      // 不落半个文件
      const leftover = [];
      try {
        for (const name of readdirSync(join(stageDir, '9.9.9'))) leftover.push(name);
      } catch { /* 目录压根没建 = 更好 */ }
      eq(leftover.length, 0, `下载失败绝不能留下半个文件：${JSON.stringify(leftover)}`);
      eq(invokeCount(capture), 0, '下载失败不许触发安装：');

      // 换一个好源 → 重试必须能成功（失败可重试，不是死局）
      process.env.WORKTODO_UPDATE_TARBALL_BASE = good.base;
      const retried = (await triggerUpdate(host, { action: 'plugin-update-download' })).json();
      eq(retried.ok, true, `换好源后重试应当成功：${JSON.stringify(retried)}`);
      const done = await waitForUpdatePhase(host, (state) => state.phase === 'downloaded', 4000);
      eq(done?.phase, 'downloaded', `重试后应当到 downloaded（实际 ${done?.phase}，error=${done?.error}）：`);
    });
  } finally {
    await broken.close();
    await good.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(stageDir, { recursive: true, force: true });
  }
});

await test('自升级（两步）护栏：没下载就点「安装并重启」→ 拒绝（not-downloaded），一个子进程都不起', async () => {
  const profile = makeFakeProfile('guard-not-downloaded', '^0.2.0');
  seedInstalledVersion(profile, '0.2.0');
  const { capture, bin } = makeInstallingPnpm('guard-not-downloaded', profile);
  let host;
  let dir;
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile, PATH: `${bin}:${process.env.PATH}`,
      WORKTODO_PNPM_PATH: undefined, WORKTODO_UPDATE_LATEST: '9.9.9',
      // 独立状态/暂存目录：全局状态文件是共享的，别让别的用例下好的 9.9.9 被 restoreDownloaded 认回来
      WORKTODO_UPDATE_STATE_PATH: join(selfUpdateRoot, 'update-state-guard-not-downloaded.json'),
      WORKTODO_UPDATE_STAGE_DIR: join(selfUpdateRoot, 'stage-guard-not-downloaded'),
    }, async () => {
      ({ host, dir } = await makeUpdateHost({ autoUpdate: false }));
      // 只有 available、没有下载物
      const response = await triggerUpdate(host, { action: 'plugin-update-install' });
      const body = response.json();
      eq(body.ok, false, '下载没完成时必须拒绝安装：');
      eq(body.reason, 'not-downloaded', `原因要是稳定的 not-downloaded（实际 ${body.reason}）：`);
      eq(String(body.error).includes('下载'), true, `要说清「先去下载」：${body.error}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      eq(invokeCount(capture), 0, '被拒绝的安装绝不允许起子进程：');
      const status = (await readUpdateState(host)).json().data;
      eq(status.phase, 'available', `拒绝后阶段不该被改成别的东西（实际 ${status.phase}）：`);
      eq(status.state, 'idle', '老字段 state 仍然是 idle：');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('自升级（两步）护栏：下载物被删 / 被写坏 → 安装当场拒绝（download-missing / download-corrupt）', async () => {
  const profile = makeFakeProfile('guard-corrupt', '^0.2.0');
  seedInstalledVersion(profile, '0.2.0');
  const { capture, bin } = makeInstallingPnpm('guard-corrupt', profile);
  const tarball = await startTarballServer({ chunks: 1, chunkSize: 1024 });
  const stageDir = join(selfUpdateRoot, 'stage-guard-corrupt');
  let host;
  let dir;
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile, PATH: `${bin}:${process.env.PATH}`,
      WORKTODO_PNPM_PATH: undefined, WORKTODO_UPDATE_LATEST: '9.9.9',
      WORKTODO_UPDATE_TARBALL_BASE: tarball.base, WORKTODO_UPDATE_STAGE_DIR: stageDir,
    }, async () => {
      ({ host, dir } = await makeUpdateHost({ autoUpdate: false }));
      const downloaded = (await triggerUpdate(host, { action: 'plugin-update-download' })).json();
      eq(downloaded.ok, true, `先正常下载：${JSON.stringify(downloaded)}`);
      const artifact = (await readUpdateState(host)).json().data.download.artifact;

      // ① 下载物被删（用户清缓存 / 换目录）
      rmSync(artifact, { force: true });
      const missing = (await triggerUpdate(host, { action: 'plugin-update-install' })).json();
      eq(missing.ok, false, '下载物不在了必须拒绝安装：');
      eq(missing.reason, 'download-missing', `原因要是 download-missing（实际 ${missing.reason}）：`);
      eq(String(missing.error).includes('重新下载'), true, `要让用户重新下载：${missing.error}`);
      let status = (await readUpdateState(host)).json().data;
      eq(status.phase, 'failed', '拒绝后必须是 failed（不是悄悄继续）：');
      eq(status.failedOperation, 'install', 'failedOperation 要指明安装这一步：');
      eq(status.failure, 'download-corrupt', `失败种类要是 download-corrupt（实际 ${status.failure}）：`);

      // ② 重新下载，然后把内容改坏（模拟写坏/半截文件）
      eq((await triggerUpdate(host, { action: 'plugin-update-download' })).json().ok, true);
      writeFileSync(artifact, '这不是一个 tarball');
      const corrupt = (await triggerUpdate(host, { action: 'plugin-update-install' })).json();
      eq(corrupt.ok, false, '内容被改坏必须拒绝安装：');
      eq(corrupt.reason, 'download-corrupt', `原因要是 download-corrupt（实际 ${corrupt.reason}）：`);
      status = (await readUpdateState(host)).json().data;
      eq(String(status.error).includes('校验不通过') || String(status.error).includes('大小不对'), true,
        `要说明是校验/大小的问题：${status.error}`);
      // 两次拒绝都不许真的去装
      eq(invokeCount(capture), 0, `被拒绝的安装绝不允许起子进程（实际 ${invokeCount(capture)}）：`);
    });
  } finally {
    await tarball.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(stageDir, { recursive: true, force: true });
  }
});

await test('自升级（两步）：下好了但没安装就「重启」→ 新实例启动即认回「已下载」，不用重下第二遍', async () => {
  const profile = makeFakeProfile('resume-downloaded', '^0.2.0');
  seedInstalledVersion(profile, '0.2.0');
  const { capture, bin } = makeInstallingPnpm('resume-downloaded', profile);
  const tarball = await startTarballServer({ chunks: 1, chunkSize: 1024 });
  const stageDir = join(selfUpdateRoot, 'stage-resume');
  const statePath = join(selfUpdateRoot, 'update-state-resume.json');
  let first;
  let second;
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile, PATH: `${bin}:${process.env.PATH}`,
      WORKTODO_PNPM_PATH: undefined, WORKTODO_UPDATE_LATEST: '9.9.9',
      WORKTODO_UPDATE_TARBALL_BASE: tarball.base, WORKTODO_UPDATE_STAGE_DIR: stageDir,
      WORKTODO_UPDATE_STATE_PATH: statePath,
    }, async () => {
      // 第一个实例：只下载，不安装
      first = await makeUpdateHost({ autoUpdate: false });
      eq((await triggerUpdate(first.host, { action: 'plugin-update-download' })).json().ok, true);
      const downloaded = await waitForUpdatePhase(first.host, (state) => state.phase === 'downloaded', 4000);
      eq(downloaded?.phase, 'downloaded', `先把它下好（实际 ${downloaded?.phase}）：`);

      // 「重启」：新的 apply（新进程生命周期的替身）
      second = await makeUpdateHost({ autoUpdate: false });
      const resumed = (await readUpdateState(second.host)).json().data;
      eq(resumed.phase, 'downloaded', `重启后必须直接认回「已下载」（实际 ${resumed.phase}）：`);
      eq(resumed.download?.version, '9.9.9', '认回的必须是同一版下载物：');
      eq(invokeCount(capture), 0, '认回下载物不该起任何安装子进程：');
      // 认回之后照常能装（不用重下一遍）
      eq((await triggerUpdate(second.host, { action: 'plugin-update-install' })).json().ok, true);
      const settled = await waitForUpdateSettled(second.host, 6000);
      eq(settled?.phase, 'installed', `认回后应当能装上（实际 ${settled?.phase}）：`);
    });
  } finally {
    await tarball.close();
    if (first?.dir) rmSync(first.dir, { recursive: true, force: true });
    if (second?.dir) rmSync(second.dir, { recursive: true, force: true });
    rmSync(stageDir, { recursive: true, force: true });
  }
});

console.log('\n更新方式（off / manual / auto）：持久化 / 零网络 / 不自动装 / 全自动 + 重启提醒 / unsupported 零写盘');

await test('更新方式：三档纯函数 + settings 持久化（POST/GET 一致、原子写无残留、非法值 400 不写盘、损坏回退 manual）', async () => {
  eq([...UPDATE_MODES], ['off', 'manual', 'auto'], '三档顺序固定：');
  eq(DEFAULT_UPDATE_MODE, 'manual', '安全默认必须是 manual：');
  eq(normalizeUpdateMode('auto'), 'auto');
  eq(normalizeUpdateMode('off'), 'off');
  eq(normalizeUpdateMode('manual'), 'manual');
  eq(normalizeUpdateMode('sometimes'), null, '非法档位必须被拒绝：');
  eq(normalizeUpdateMode(undefined), null);
  eq(defaultUpdateModeFromConfig({}), 'manual', '空配置 = manual：');
  eq(defaultUpdateModeFromConfig({ autoUpdate: false }), 'manual', 'autoUpdate:false 是旧语义「不自动升级」，不是 off：');
  eq(defaultUpdateModeFromConfig({ autoInstall: true }), 'auto', 'autoInstall:true 是显式 opt-in 的 auto：');
  eq(effectiveUpdatePolicy('off'), { autoCheck: false, autoInstall: false });
  eq(effectiveUpdatePolicy('manual'), { autoCheck: true, autoInstall: false });
  eq(effectiveUpdatePolicy('auto'), { autoCheck: true, autoInstall: true });
  eq(resolveSettingsPath({ env: {}, home: '/tmp/fake-home' }), '/tmp/fake-home/worktodo/settings.json');
  eq(resolveSettingsPath({ env: { WORKTODO_SETTINGS_PATH: ' /tmp/x.json ' }, home: '/tmp/fake-home' }), '/tmp/x.json',
    '测试缝要能覆盖到临时文件：');
  eq(parseUpdateSettings('{"updateMode":"auto"}').updateMode, 'auto');
  eq(parseUpdateSettings('{"updateMode":"nope"}'), null, '非法值 = 损坏：');
  eq(parseUpdateSettings('{ 不是 JSON'), null);

  const settingsDir = mkdtempSync(join(tmpdir(), 'worktodo-settings-'));
  const settingsFile = join(settingsDir, 'settings.json');
  const statePath = join(settingsDir, 'update-state.json');
  const getSettings = (host) => call(host.routes.get('/worktodo/settings').handler, {
    method: 'GET', url: '/worktodo/settings',
  }).then((response) => response.json());
  const postSettings = (host, body) => call(host.routes.get('/worktodo/settings').handler, {
    method: 'POST', url: '/worktodo/settings', body,
  });
  try {
    await withEnv({
      WORKTODO_SETTINGS_PATH: settingsFile,
      WORKTODO_UPDATE_STATE_PATH: statePath,
      WORKTODO_NO_UPDATE_CHECK: '1',
    }, async () => {
      const { host, dir } = await makeUpdateHost();
      try {
        const initial = await getSettings(host);
        eq(initial.ok, true);
        eq(initial.data.updateMode, 'manual', '没有 settings.json 时按 config 默认 → manual：');
        eq(initial.data.effective, { autoCheck: true, autoInstall: false });

        // 三档都 POST 一次，每次 GET 都要一致；文件只存 {updateMode, updatedAt}
        for (const mode of ['off', 'auto', 'manual']) {
          const posted = await postSettings(host, { updateMode: mode });
          eq(posted.statusCode, 200, `POST ${mode} 必须成功：`);
          eq(posted.json().data.updateMode, mode);
          const readBack = await getSettings(host);
          eq(readBack.data.updateMode, mode, `GET 必须回读 ${mode}：`);
          const saved = JSON.parse(readFileSync(settingsFile, 'utf8'));
          eq(Object.keys(saved).sort(), ['updateMode', 'updatedAt'], `settings.json 只允许这两个键：${JSON.stringify(saved)}`);
          eq(saved.updateMode, mode);
          eq(typeof saved.updatedAt, 'string', '必须记录 updatedAt：');
        }
        eq(readdirSync(settingsDir).sort(), ['settings.json'], '原子写不许留下 .tmp/.bak 残留：');

        // /list 与 /update 都要带 updateMode
        const list = (await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' })).json();
        eq(list.data.update.updateMode, 'manual', '/list 必须带 updateMode：');
        eq(list.data.update.effective, { autoCheck: true, autoInstall: false });
        const status = (await readUpdateState(host)).json().data;
        eq(status.updateMode, 'manual', '/update 必须带 updateMode：');
        eq(status.effective, { autoCheck: true, autoInstall: false });

        // 非法值：400，且文件一个字节都不动
        const beforeInvalid = readFileSync(settingsFile, 'utf8');
        const invalid = await postSettings(host, { updateMode: 'sometimes' });
        eq(invalid.statusCode, 400, '非法值必须回 400：');
        eq(invalid.json().reason, 'invalid-update-mode');
        eq(readFileSync(settingsFile, 'utf8'), beforeInvalid, '非法值绝不许写盘：');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // 损坏的 settings.json → manual + 告警，不崩
    writeFileSync(settingsFile, '{ 这不是 JSON');
    await withEnv({
      WORKTODO_SETTINGS_PATH: settingsFile,
      WORKTODO_UPDATE_STATE_PATH: statePath,
      WORKTODO_NO_UPDATE_CHECK: '1',
    }, async () => {
      const { host, dir } = await makeUpdateHost();
      try {
        const settings = await getSettings(host);
        eq(settings.data.updateMode, 'manual', '损坏必须回退 manual：');
        eq(host.logs.some((line) => line.startsWith('warn') && line.includes('settings.json')), true,
          `损坏要留下可排查的告警：${JSON.stringify(host.logs)}`);
        const list = (await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' })).json();
        eq(list.ok, true, '损坏设置不能影响 /list：');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  } finally {
    rmSync(settingsDir, { recursive: true, force: true });
  }
});

await test('更新方式 off：零网络请求、面板无「新版本/检查失败」提示；切 off 会中止在飞检查且不再重试', async () => {
  const requests = [];
  const pending = new Set();
  const registry = createServer((_request, response) => {
    requests.push(Date.now());
    const timer = setTimeout(() => {
      pending.delete(timer);
      try {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ 'dist-tags': { latest: FAKE_NEXT_VERSION }, versions: {} }));
      } catch { /* 已被 abort */ }
    }, 150);
    timer.unref?.();
    pending.add(timer);
  });
  await new Promise((resolve) => registry.listen(0, '127.0.0.1', resolve));
  registry.unref();
  const settingsDir = mkdtempSync(join(tmpdir(), 'worktodo-off-'));
  const settingsFile = join(settingsDir, 'settings.json');
  writeFileSync(settingsFile, `${JSON.stringify({ updateMode: 'off', updatedAt: new Date().toISOString() })}\n`);
  try {
    await withEnv({
      WORKTODO_SETTINGS_PATH: settingsFile,
      WORKTODO_UPDATE_STATE_PATH: join(settingsDir, 'update-state.json'),
      WORKTODO_NO_UPDATE_CHECK: undefined,
      WORKTODO_UPDATE_LATEST: undefined,
      WORKTODO_STARTUP_CHECK_DELAY_MS: '0',
    }, async () => {
      const { host, dir } = await makeUpdateHost({ updateRegistry: `http://127.0.0.1:${registry.address().port}/` });
      try {
        await new Promise((resolve) => setTimeout(resolve, 350));
        eq(requests.length, 0, `off：启动检查必须零请求（实际 ${requests.length}）：`);
        // /list 的轮询也不许打网络
        const list = (await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' })).json();
        eq(requests.length, 0, 'off：/list 轮询也必须零请求：');
        eq(list.data.update.updateMode, 'off');
        eq(list.data.update.hasUpdate, false, 'off：不许报「有新版本」：');
        eq(list.data.update.latest, null, 'off：不显示新版本号：');
        eq(list.data.update.checkError, null, 'off：不许报「检查失败」：');
        eq(list.data.update.run.phase, 'idle', 'off：阶段保持 idle：');

        // 切到 manual：会立刻补一次检查（请求在飞）
        const toManual = await call(host.routes.get('/worktodo/settings').handler, {
          method: 'POST', url: '/worktodo/settings', body: { updateMode: 'manual' },
        });
        eq(toManual.statusCode, 200);
        eq(await waitFor(() => requests.length === 1, 2000), true, '切到 manual 后要补一次检查：');
        // 立刻切回 off：在飞请求被 abort，且绝不再触发第二次
        const toOff = await call(host.routes.get('/worktodo/settings').handler, {
          method: 'POST', url: '/worktodo/settings', body: { updateMode: 'off' },
        });
        eq(toOff.statusCode, 200);
        await new Promise((resolve) => setTimeout(resolve, 500));
        eq(requests.length, 1, `切到 off 后不许再发起新的检查（实际 ${requests.length}）：`);
        const status = (await readUpdateState(host)).json().data;
        eq(status.updateMode, 'off');
        eq(status.phase, 'idle', `在飞检查被中止后必须回到 idle（实际 ${status.phase}）：`);
        eq(status.error, null, '不许把 abort 当成错误：');
        eq(status.checkError, null);
        const after = (await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' })).json();
        eq(after.data.update.hasUpdate, false, 'off：面板不能有新版本提示：');
        eq(after.data.update.run.phase, 'idle');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  } finally {
    for (const timer of pending) clearTimeout(timer);
    registry.closeAllConnections?.();
    registry.close();
    rmSync(settingsDir, { recursive: true, force: true });
  }
});

await test('更新方式 manual：有新版本只提示，绝不自动下载/安装（假 pnpm 0 次、暂存区不存在）', async () => {
  const profile = makeFakeProfile('mode-manual', '^0.2.0');
  seedInstalledVersion(profile, '0.2.0');
  const capture = join(selfUpdateRoot, 'capture-mode-manual.txt');
  const bin = join(selfUpdateRoot, 'bin-mode-manual');
  writeFakePnpm(bin, { capture, installVersion: FAKE_NEXT_VERSION, installProfile: profile, installOn: 'any' });
  const settingsDir = mkdtempSync(join(tmpdir(), 'worktodo-manual-'));
  const settingsFile = join(settingsDir, 'settings.json');
  writeFileSync(settingsFile, `${JSON.stringify({ updateMode: 'manual', updatedAt: new Date().toISOString() })}\n`);
  const stageDir = join(settingsDir, 'updates');
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile, PATH: `${bin}:${process.env.PATH}`,
      WORKTODO_PNPM_PATH: undefined, WORKTODO_UPDATE_LATEST: FAKE_NEXT_VERSION,
      WORKTODO_SETTINGS_PATH: settingsFile,
      WORKTODO_UPDATE_STATE_PATH: join(settingsDir, 'update-state.json'),
      WORKTODO_UPDATE_STAGE_DIR: stageDir,
    }, async () => {
      const { host, dir } = await makeUpdateHost();
      try {
        const status = await waitForUpdatePhase(host, (state) => state.phase === 'available', 5000);
        eq(status?.phase, 'available', `manual 只该检查到 available（实际 ${status?.phase}）：`);
        eq(status?.updateMode, 'manual');
        eq(status?.to, FAKE_NEXT_VERSION, '面板要拿到新版本号：');
        await new Promise((resolve) => setTimeout(resolve, 350));
        eq(invokeCount(capture), 0, `manual 绝不许自动安装（实际 ${invokeCount(capture)} 次）：`);
        eq(existsSync(stageDir), false, 'manual 绝不许自动下载（暂存区不该出现）：');
        const list = (await call(host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' })).json();
        eq(list.data.update.hasUpdate, true, 'manual 仍要在面板提示有新版本：');
        eq(list.data.update.latest, FAKE_NEXT_VERSION);
        eq(list.data.update.updateMode, 'manual');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  } finally {
    rmSync(settingsDir, { recursive: true, force: true });
  }
});

await test('detached：宿主 dispose（插件卸载）后，已在跑的安装器仍然把新版本装完', async () => {
  const profile = makeFakeProfile('installer-detached-dispose', '^0.2.0');
  seedInstalledVersion(profile, '0.2.0');
  const stageDir = join(selfUpdateRoot, 'stage-installer-detached-dispose');
  const statePath = join(selfUpdateRoot, 'update-state-installer-detached-dispose.json');
  const tarball = await startTarballServer({ version: FAKE_NEXT_VERSION, chunks: 2 });
  let host;
  let dir;
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile,
      WORKTODO_UPDATE_LATEST: FAKE_NEXT_VERSION,
      WORKTODO_UPDATE_TARBALL_BASE: tarball.base,
      WORKTODO_UPDATE_STAGE_DIR: stageDir,
      WORKTODO_UPDATE_STATE_PATH: statePath,
      // 开工前等 500ms：保证 dispose 发生在安装器「还没开始替换」的时候
      WORKTODO_APPLY_DELAY_MS: '500',
    }, async () => {
      host = await makeUpdateHost({ autoUpdate: false });
      dir = host.dir;
      eq((await triggerUpdate(host.host, { action: 'plugin-update-download' })).json().ok, true);
      await waitForUpdatePhase(host.host, (state) => state.phase === 'downloaded', 5000);
      eq((await triggerUpdate(host.host, { action: 'plugin-update-install' })).json().ok, true);
      // 模拟插件卸载 / 面板会话结束：宿主不再等这个安装
      for (const effect of [...host.host.effects].reverse()) {
        try { await effect.dispose?.(); } catch { /* 单个清理失败不打断 */ }
      }
      // 宿主已经卸载，但 detached 安装器应当继续，并最终写下 installed 结果
      const resultFile = resolveApplyResultPath(statePath);
      const finished = await waitFor(() => {
        try {
          const result = JSON.parse(readFileSync(resultFile, 'utf8'));
          return result?.ok === true && result.phase === 'installed';
        } catch {
          return false;
        }
      }, 8000);
      eq(finished, true, '宿主 dispose 后安装器必须继续跑完（detached 的硬证据）：');
      eq(JSON.parse(readFileSync(join(profile, 'node_modules', 'dsh-worktodo', 'package.json'), 'utf8')).version,
        FAKE_NEXT_VERSION, '安装器真的替换了目标目录：');
    });
  } finally {
    await tarball.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    rmSync(stageDir, { recursive: true, force: true });
  }
});

await test('更新方式 auto：自动下载 + detached 安装各一次；装好 restartRequired:true，且绝不自动重启', async () => {
  const profile = makeFakeProfile('mode-auto', '^0.2.0');
  seedInstalledVersion(profile, '0.2.0');
  const capture = join(selfUpdateRoot, 'capture-mode-auto.txt');
  const bin = join(selfUpdateRoot, 'bin-mode-auto');
  writeTripwires(bin, ['pnpm', 'npm', 'pnpm.cmd', 'npm.cmd'], capture);
  const tarball = await startTarballServer({ version: FAKE_NEXT_VERSION, chunks: 2, delayMs: 10 });
  const settingsDir = mkdtempSync(join(tmpdir(), 'worktodo-auto-'));
  const settingsFile = join(settingsDir, 'settings.json');
  writeFileSync(settingsFile, `${JSON.stringify({ updateMode: 'auto', updatedAt: new Date().toISOString() })}\n`);
  const stageDir = join(settingsDir, 'updates');
  let host;
  let dir;
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile,
      PATH: `${bin}:${process.env.PATH}`,
      WORKTODO_PNPM_PATH: join(bin, 'pnpm'),
      WORKTODO_UPDATE_LATEST: FAKE_NEXT_VERSION,
      WORKTODO_UPDATE_TARBALL_BASE: tarball.base,
      WORKTODO_SETTINGS_PATH: settingsFile,
      WORKTODO_UPDATE_STATE_PATH: join(settingsDir, 'update-state.json'),
      WORKTODO_UPDATE_STAGE_DIR: stageDir,
    }, async () => {
      host = await makeUpdateHost();
      dir = host.dir;
      const settled = await waitForUpdateSettled(host.host, 10000);
      eq(settled?.phase, 'installed', `auto 要一路装完（实际 ${settled?.phase}，error=${settled?.error}）：`);
      eq(settled?.state, 'done');
      eq(settled?.updateMode, 'auto');
      eq(settled?.effective, { autoCheck: true, autoInstall: true });
      eq(settled?.restartRequired, true, '装好必须报 restartRequired:true：');
      eq(settled?.restart, null, 'auto 也不许自动请求重启（没有插件重启入口）：');
      eq(tarball.hits, 1, `自动下载必须恰好一次（实际 ${tarball.hits}）：`);
      eq(readInstalledVersionText(profile).includes(FAKE_NEXT_VERSION), true, '落盘版本必须真的变了：');
      eq(invokeCount(capture), 0, `auto 安装也必须零 pnpm/CLI（实际 ${invokeCount(capture)}）：`);
      const list = (await call(host.host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' })).json();
      eq(list.data.update.restartRequired, true, '/list 也要报 restartRequired:true：');
      eq(list.data.update.installedVersion, FAKE_NEXT_VERSION);
      eq(list.data.update.updateMode, 'auto');
    });
  } finally {
    await tarball.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
  }
});

await test('config 默认值映射：autoInstall:false=manual（用户点才下/装）；true=auto（全自动）', async () => {
  // —— autoInstall:false → manual：后台只检查，下载/安装都必须用户点 ——
  const profileOff = makeFakeProfile('autoinstall-off', '^0.2.0');
  seedInstalledVersion(profileOff, '0.2.0');
  const tarballOff = await startTarballServer({ version: FAKE_NEXT_VERSION, chunks: 1 });
  const stageOff = join(selfUpdateRoot, 'stage-autoinstall-off');
  let off;
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profileOff,
      WORKTODO_UPDATE_LATEST: FAKE_NEXT_VERSION,
      WORKTODO_UPDATE_TARBALL_BASE: tarballOff.base,
      WORKTODO_UPDATE_STAGE_DIR: stageOff,
      WORKTODO_UPDATE_STATE_PATH: join(selfUpdateRoot, 'update-state-autoinstall-off.json'),
    }, async () => {
      off = await makeUpdateHost({ autoInstall: false });
      const status = await waitForUpdatePhase(off.host, (state) => state.phase === 'available', 5000);
      eq(status?.phase, 'available', `autoInstall:false 映射成 manual，只该检查到 available（实际 ${status?.phase}，error=${status?.error}）：`);
      eq(status.updateMode, 'manual', 'config.autoInstall:false 时默认档位是 manual：');
      eq(status.autoInstall, false, 'GET 状态要如实报出 autoInstall:false：');
      eq(existsSync(stageOff), false, 'manual 绝不自动下载（暂存区不该出现）：');
      // 用户点「下载」→「安装并重启」之后才动 profile
      eq((await triggerUpdate(off.host, { action: 'plugin-update-download' })).json().ok, true);
      const downloaded = await waitForUpdatePhase(off.host, (state) => state.phase === 'downloaded', 5000);
      eq(downloaded?.phase, 'downloaded', `用户点了下载之后要能下好（实际 ${downloaded?.phase}）：`);
      eq((await triggerUpdate(off.host, { action: 'plugin-update-install' })).json().ok, true);
      const settled = await waitForUpdateSettled(off.host, 8000);
      eq(settled?.phase, 'installed', `用户点了之后要能装上（实际 ${settled?.phase}）：`);
    });
  } finally {
    await tarballOff.close();
    if (off?.dir) rmSync(off.dir, { recursive: true, force: true });
    rmSync(stageOff, { recursive: true, force: true });
  }

  // —— 显式 autoInstall:true → auto：后台检查到新版后下载 + 安装全自动 ——
  const profileOn = makeFakeProfile('autoinstall-default', '^0.2.0');
  seedInstalledVersion(profileOn, '0.2.0');
  const tarballOn = await startTarballServer({ version: FAKE_NEXT_VERSION, chunks: 1 });
  const stageOn = join(selfUpdateRoot, 'stage-autoinstall-default');
  let on;
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profileOn,
      WORKTODO_UPDATE_LATEST: FAKE_NEXT_VERSION,
      WORKTODO_UPDATE_TARBALL_BASE: tarballOn.base,
      WORKTODO_UPDATE_STAGE_DIR: stageOn,
      // 专用节流文件：否则前面用例留下的「已试过」会把这次自动更新节流掉
      WORKTODO_UPDATE_STATE_PATH: join(selfUpdateRoot, 'update-state-autoinstall-default.json'),
    }, async () => {
      on = await makeUpdateHost({ autoInstall: true });
      const settled = await waitForUpdateSettled(on.host, 10000);
      eq(settled?.phase, 'installed', `显式 autoInstall:true 后台要一路装完（实际 ${settled?.phase}，error=${settled?.error}）：`);
      eq(settled?.updateMode, 'auto', 'config.autoInstall:true 时默认档位是 auto：');
      eq(settled?.autoInstall, true, 'GET 状态要如实报出 autoInstall:true：');
      // 后台自动装完**不**会自动请求重启：重启永远是用户动作
      eq(settled?.restart, null, '后台自动安装不许自己请求重启（重启只能由用户点）：');
    });
  } finally {
    await tarballOn.close();
    if (on?.dir) rmSync(on.dir, { recursive: true, force: true });
    rmSync(stageOn, { recursive: true, force: true });
  }
});

await test('A4：跨重启节流 —— 第一次自动安装失败后，第二次启动不再起安装器/不再写 profile', async () => {
  const profile = makeFakeProfile('auto-persist', '^0.2.0');
  seedInstalledVersion(profile, '0.2.0');
  const manifest = join(profile, 'package.json');
  const tarball = await startTarballServer({ version: FAKE_NEXT_VERSION, chunks: 1 });
  const stageDir = join(selfUpdateRoot, 'stage-auto-persist');
  const statePath = join(selfUpdateRoot, 'update-state-auto-persist.json');
  const storeDir = mkdtempSync(join(tmpdir(), 'worktodo-autopersist-'));
  let first;
  let second;
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile,
      WORKTODO_UPDATE_LATEST: FAKE_NEXT_VERSION,
      WORKTODO_UPDATE_TARBALL_BASE: tarball.base,
      WORKTODO_UPDATE_STAGE_DIR: stageDir,
      WORKTODO_UPDATE_STATE_PATH: statePath,
      // 让第一次自动安装必然失败（回滚后版本仍是旧的），这样第二次「什么都不做」
      // 只可能是持久化节流挡住的，而不是「已经升上去了」。
      WORKTODO_APPLY_FAIL_STEP: 'rename-target',
    }, async () => {
      // —— 第 1 次「启动」——
      first = await makeUpdateHost({ autoInstall: true });
      const firstStatus = await waitForUpdateSettled(first.host, 10000);
      eq(firstStatus?.state, 'failed', `第一次启动必须真的尝试过（实际 ${firstStatus?.state}）：`);
      eq(firstStatus?.reason, 'replace-failed', `失败原因是安装器回滚（实际 ${firstStatus?.reason}）：`);
      eq(existsSync(statePath), true, 'A4：节流状态必须持久化（旧实现只在内存里，重启就忘）：');
      eq(JSON.parse(readFileSync(statePath, 'utf8')).attempted, FAKE_NEXT_VERSION, 'A4：要记下已经试过的 latest：');
      const applyLogsAfterFirst = readdirSync(stageDir).filter((name) => name.startsWith('apply-') && name.endsWith('.log'));
      eq(applyLogsAfterFirst.length, 1, `一次自动尝试只该起一个安装器（实际 ${applyLogsAfterFirst.length}）：`);
      const bytesAfterFirst = readFileSync(manifest, 'utf8');
      const mtimeAfterFirst = statSync(manifest).mtimeMs;
      rmSync(first.dir, { recursive: true, force: true });
      first = null;

      // —— 第 2 次「启动」（新的 apply = 新的进程生命周期）——
      second = await makeUpdateHost({ autoInstall: true });
      await call(second.host.routes.get('/worktodo/list').handler, { method: 'GET', url: '/worktodo/list' });
      await new Promise((resolve) => setTimeout(resolve, 600));
      const applyLogsAfterSecond = readdirSync(stageDir).filter((name) => name.startsWith('apply-') && name.endsWith('.log'));
      eq(applyLogsAfterSecond.length, applyLogsAfterFirst.length,
        `A4：第二次启动不许再起安装器（${applyLogsAfterFirst.length} → ${applyLogsAfterSecond.length}）：`);
      eq(readFileSync(manifest, 'utf8'), bytesAfterFirst, 'A4：第二次启动不许再写 profile 清单：');
      eq(statSync(manifest).mtimeMs, mtimeAfterFirst, 'A4：连 mtime 都不许变（= 零写盘）：');
      const secondStatus = (await readUpdateState(second.host)).json().data;
      eq(secondStatus.state, 'idle', `A4：第二次启动不该有任何升级动作（实际 ${secondStatus.state}）：`);
    });
  } finally {
    await tarball.close();
    if (first?.dir) rmSync(first.dir, { recursive: true, force: true });
    if (second?.dir) rmSync(second.dir, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
    rmSync(stageDir, { recursive: true, force: true });
  }
});

await test('小问题 1：自动升级失败/成功都如实写状态文件（failed+reason / done）', async () => {
  // —— 失败：安装器回滚 → result=failed + reason ——
  const failProfile = makeFakeProfile('state-result-failed', '^0.2.0');
  seedInstalledVersion(failProfile, '0.2.0');
  const failState = join(selfUpdateRoot, 'update-state-result-failed.json');
  const failStage = join(selfUpdateRoot, 'stage-result-failed');
  const tarball = await startTarballServer({ version: FAKE_NEXT_VERSION, chunks: 1 });
  let failHost;
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: failProfile,
      WORKTODO_UPDATE_LATEST: FAKE_NEXT_VERSION,
      WORKTODO_UPDATE_TARBALL_BASE: tarball.base,
      WORKTODO_UPDATE_STAGE_DIR: failStage,
      WORKTODO_UPDATE_STATE_PATH: failState,
      WORKTODO_APPLY_FAIL_STEP: 'rename-target',
    }, async () => {
      failHost = await makeUpdateHost({ autoInstall: true });
      const status = await waitForUpdateSettled(failHost.host, 10000);
      eq(status?.state, 'failed', `这次尝试其实是失败（实际 ${status?.state}）：`);
      eq(status?.reason, 'replace-failed', `失败原因是安装器回滚：${status?.reason}`);
      const wrote = await waitFor(() => {
        try {
          const persisted = JSON.parse(readFileSync(failState, 'utf8'));
          return persisted.result === 'failed' && persisted.reason === 'replace-failed';
        } catch {
          return false;
        }
      }, 3000);
      eq(wrote, true, `状态文件必须写成 failed + reason：${existsSync(failState) ? readFileSync(failState, 'utf8') : '（文件不存在）'}`);
      const persisted = JSON.parse(readFileSync(failState, 'utf8'));
      eq(persisted.attempted, FAKE_NEXT_VERSION, 'A4 的节流字段 attempted 必须保留：');
      eq(typeof persisted.at === 'number' && typeof persisted.finishedAt === 'number', true,
        `要记尝试时间（at / finishedAt）：${JSON.stringify(persisted)}`);
    });
  } finally {
    await tarball.close();
    if (failHost?.dir) rmSync(failHost.dir, { recursive: true, force: true });
    rmSync(failStage, { recursive: true, force: true });
  }

  // —— 成功：安装器替换成功 → result=done（且不带 reason）——
  const okProfile = makeFakeProfile('state-result-done', '^0.2.0');
  seedInstalledVersion(okProfile, '0.2.0');
  const okState = join(selfUpdateRoot, 'update-state-result-done.json');
  const okStage = join(selfUpdateRoot, 'stage-result-done');
  const tarball2 = await startTarballServer({ version: FAKE_NEXT_VERSION, chunks: 1 });
  let okHost;
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: okProfile,
      WORKTODO_UPDATE_LATEST: FAKE_NEXT_VERSION,
      WORKTODO_UPDATE_TARBALL_BASE: tarball2.base,
      WORKTODO_UPDATE_STAGE_DIR: okStage,
      WORKTODO_UPDATE_STATE_PATH: okState,
      WORKTODO_APPLY_FAIL_STEP: undefined,
    }, async () => {
      okHost = await makeUpdateHost({ autoInstall: true });
      const status = await waitForUpdateSettled(okHost.host, 10000);
      eq(status?.state, 'done', `安装器成功就该 done（实际 ${status?.state}，error=${status?.error}）：`);
      const wrote = await waitFor(() => {
        try {
          return JSON.parse(readFileSync(okState, 'utf8')).result === 'done';
        } catch {
          return false;
        }
      }, 3000);
      eq(wrote, true, `成功也要写 done（而不是停在 started）：${existsSync(okState) ? readFileSync(okState, 'utf8') : '（文件不存在）'}`);
      const persisted = JSON.parse(readFileSync(okState, 'utf8'));
      eq(persisted.result, 'done', '成功 → result=done：');
      eq(persisted.reason, undefined, `done 不该再有 reason：${JSON.stringify(persisted)}`);
      eq(persisted.attempted, FAKE_NEXT_VERSION, 'A4 的节流字段 attempted 必须保留：');
    });
  } finally {
    await tarball2.close();
    if (okHost?.dir) rmSync(okHost.dir, { recursive: true, force: true });
    rmSync(okStage, { recursive: true, force: true });
  }
});

await test('重启：没配 restartCommand 就诚实说「请手动重启」；配了才真的跑那条命令', async () => {
  // —— 不可用：绝不假装能重启 ——
  const profile = makeFakeProfile('restart-unavailable', '^0.2.0');
  seedInstalledVersion(profile, '0.2.0');
  const tarball = await startTarballServer({ version: FAKE_NEXT_VERSION, chunks: 1 });
  const stageDir = join(selfUpdateRoot, 'stage-restart-unavailable');
  let host;
  let dir;
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile,
      WORKTODO_UPDATE_LATEST: FAKE_NEXT_VERSION,
      WORKTODO_UPDATE_TARBALL_BASE: tarball.base,
      WORKTODO_UPDATE_STAGE_DIR: stageDir,
      WORKTODO_UPDATE_STATE_PATH: join(selfUpdateRoot, 'update-state-restart-unavailable.json'),
      WORKTODO_RESTART_COMMAND: undefined,
    }, async () => {
      host = await makeUpdateHost({ autoUpdate: false });
      dir = host.dir;
      eq((await triggerUpdate(host.host, { action: 'plugin-update-download' })).json().ok, true);
      eq((await triggerUpdate(host.host, { action: 'plugin-update-install' })).json().ok, true);
      const settled = await waitForUpdateSettled(host.host, 8000);
      eq(settled?.phase, 'installed', `装完必须停在 installed（实际 ${settled?.phase}）：`);
      const afterInstall = await waitForUpdatePhase(host.host, (state) => state.restart !== null, 4000);
      eq(afterInstall?.restart?.supported, false, '没配命令时必须 supported:false：');
      eq(afterInstall?.restart?.reason, 'no-plugin-restart-ipc', `原因码要稳定（实际 ${afterInstall?.restart?.reason}）：`);
      eq(String(afterInstall?.restart?.error).includes('手动'), true, `必须明确请用户手动重启：${afterInstall?.restart?.error}`);
      // 单独点「重启」也必须是同一个诚实结论（不是抛错、不是假装成功）
      const again = (await triggerUpdate(host.host, { action: 'plugin-update-restart' })).json();
      eq(again.ok, false, '重启不可用时单独点重启也必须如实失败：');
      eq(again.reason, 'restart-unavailable', `原因要是 restart-unavailable（实际 ${again.reason}）：`);
      eq((await readUpdateState(host.host)).json().data.phase, 'installed', '失败的重启请求不能把「已安装」改成别的阶段：');
    });
  } finally {
    await tarball.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    rmSync(stageDir, { recursive: true, force: true });
  }

  // —— 可用：用户显式配置重启命令后，「安装并重启」真的会执行那条命令 ——
  const profile2 = makeFakeProfile('restart-available', '^0.2.0');
  seedInstalledVersion(profile2, '0.2.0');
  const tarball2 = await startTarballServer({ version: FAKE_NEXT_VERSION, chunks: 1 });
  const stageDir2 = join(selfUpdateRoot, 'stage-restart-available');
  const marker = join(selfUpdateRoot, 'restart-marker.txt');
  const script = join(selfUpdateRoot, 'restart-cmd.mjs');
  writeFileSync(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'restarted');\n`);
  let host2;
  let dir2;
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile2,
      WORKTODO_UPDATE_LATEST: FAKE_NEXT_VERSION,
      WORKTODO_UPDATE_TARBALL_BASE: tarball2.base,
      WORKTODO_UPDATE_STAGE_DIR: stageDir2,
      WORKTODO_UPDATE_STATE_PATH: join(selfUpdateRoot, 'update-state-restart-available.json'),
      WORKTODO_RESTART_COMMAND: undefined,
    }, async () => {
      host2 = await makeUpdateHost({ autoUpdate: false, restartCommand: `${process.execPath} ${script}` });
      dir2 = host2.dir;
      eq((await triggerUpdate(host2.host, { action: 'plugin-update-download' })).json().ok, true);
      const before = (await readUpdateState(host2.host)).json().data;
      eq(before.restartSupported, true, '配了 restartCommand 后 restartSupported 必须变成 true：');
      eq((await triggerUpdate(host2.host, { action: 'plugin-update-install' })).json().ok, true);
      // 重启命令真的跑了（marker 落盘）
      const ran = await waitFor(() => existsSync(marker), 8000);
      eq(ran, true, '配置了重启命令时，「安装并重启」必须真的执行它：');
      eq(readFileSync(marker, 'utf8'), 'restarted', '跑的是我们配置的那条命令：');
      const afterRestart = await waitForUpdatePhase(host2.host, (state) => state.restart !== null, 4000);
      eq(afterRestart?.restart?.supported, true, '可用时记录里要写 supported:true：');
      eq(afterRestart?.restart?.kind, 'command', '要记录实现方式（command）：');
    });
  } finally {
    await tarball2.close();
    if (dir2) rmSync(dir2, { recursive: true, force: true });
    rmSync(stageDir2, { recursive: true, force: true });
  }
});

await test('更新方式 auto + unsupported（link:）：不下载、不安装、零写盘，面板拿到温和原因', async () => {
  const profile = makeFakeProfile('mode-auto-linked', 'link:/tmp/fake/dsh-worktodo');
  const before = snapshotTree(profile);
  const capture = join(selfUpdateRoot, 'capture-mode-auto-linked.txt');
  const bin = join(selfUpdateRoot, 'bin-mode-auto-linked');
  writeFakePnpm(bin, { capture, installVersion: '9.9.9', installProfile: profile, installOn: 'any' });
  const settingsDir = mkdtempSync(join(tmpdir(), 'worktodo-auto-link-'));
  const settingsFile = join(settingsDir, 'settings.json');
  const settingsBytes = `${JSON.stringify({ updateMode: 'auto', updatedAt: new Date().toISOString() })}\n`;
  writeFileSync(settingsFile, settingsBytes);
  const stageDir = join(settingsDir, 'updates');
  const statePath = join(settingsDir, 'update-state.json');
  try {
    await withEnv({
      WORKTODO_PROFILE_DIR: profile, PATH: `${bin}:${process.env.PATH}`,
      WORKTODO_PNPM_PATH: undefined, WORKTODO_UPDATE_LATEST: FAKE_NEXT_VERSION,
      WORKTODO_SETTINGS_PATH: settingsFile,
      WORKTODO_UPDATE_STATE_PATH: statePath,
      WORKTODO_UPDATE_STAGE_DIR: stageDir,
    }, async () => {
      const { host, dir } = await makeUpdateHost();
      try {
        const status = await waitForUpdatePhase(host, (state) => state.phase === 'unsupported', 5000);
        eq(status?.phase, 'unsupported', `link: 必须是 unsupported（实际 ${status?.phase}）：`);
        eq(status?.updateUnsupported, 'link-install');
        eq(status?.state, 'idle', '不是失败：兼容层 idle：');
        eq(status?.failure, null);
        eq(status?.failedOperation, null);
        eq(status?.updateMode, 'auto', '档位不受影响：');
        await new Promise((resolve) => setTimeout(resolve, 300));
        eq(invokeCount(capture), 0, `unsupported 绝不许起安装子进程（实际 ${invokeCount(capture)}）：`);
        eq(existsSync(stageDir), false, 'unsupported 连暂存区都不建：');
        eq(existsSync(statePath), false, 'unsupported 必须零写盘（连节流状态都不写）：');
        eq(snapshotTree(profile), before, 'profile 必须逐字节不变：');
        eq(readFileSync(settingsFile, 'utf8'), settingsBytes, 'settings.json 也不该被改写：');
        eq(String(status?.error).includes('git/pnpm'), true, `面板/API 要给温和且可执行的说明：${status?.error}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  } finally {
    rmSync(settingsDir, { recursive: true, force: true });
  }
});

await test('纯函数：tarball 地址 / 下载暂存目录 / 重启能力探测（都不许猜、不许碰真实目录）', () => {
  // tarball 地址：npm registry 的约定，registry 末尾有没有斜杠都要拼对
  eq(buildTarballUrl({ registry: 'https://registry.npmjs.org/', version: '1.2.3', env: {} }),
    'https://registry.npmjs.org/dsh-worktodo/-/dsh-worktodo-1.2.3.tgz');
  eq(buildTarballUrl({ registry: 'https://mirror.example', version: '1.2.3', env: {} }),
    'https://mirror.example/dsh-worktodo/-/dsh-worktodo-1.2.3.tgz');
  eq(buildTarballUrl({ registry: 'https://r.example/', version: '1.2.3', env: { WORKTODO_UPDATE_TARBALL_BASE: ' http://127.0.0.1:9/x/ ' } }),
    'http://127.0.0.1:9/x/dsh-worktodo-1.2.3.tgz', '测试缝要能整体换掉分发源（否则离线测不了下载）：');

  // 暂存目录：默认在插件自己的目录；状态文件被指到临时目录时暂存区跟着走
  eq(resolveUpdateStageDir({ env: {}, home: '/tmp/fake-home' }), '/tmp/fake-home/worktodo/updates');
  eq(resolveUpdateStageDir({ env: { WORKTODO_UPDATE_STATE_PATH: '/tmp/x/update-state.json' }, home: '/tmp/fake-home' }),
    '/tmp/x/updates', '状态文件指到临时目录时，暂存区必须跟着走（测试绝不碰真实 ~/.dsh）：');
  eq(resolveUpdateStageDir({ env: { WORKTODO_UPDATE_STAGE_DIR: ' /tmp/stage ' }, home: '/tmp/fake-home' }), '/tmp/stage',
    '显式测试缝优先：');
  eq(resolveUpdateStageDir({ env: {}, home: null }), null, '拿不到家目录时宁可不下载：');

  // 重启能力：默认不可用（DSH 没给插件留入口），只有显式配置才有
  const none = resolveRestartRequester({ env: {}, config: {} });
  eq(none.available, false, '默认必须报不可用（不假装能重启）：');
  eq(none.reason, 'no-plugin-restart-ipc', `默认原因码要稳定（实际 ${none.reason}）：`);
  eq(none.command, null);
  const fromConfig = resolveRestartRequester({ env: {}, config: { restartCommand: ' open -a DSH ' } });
  eq(fromConfig.available, true, '显式配置了重启命令才可用：');
  eq(fromConfig.command, 'open -a DSH', '命令要 trim 后原样使用：');
  eq(fromConfig.kind, 'command');
  const fromEnv = resolveRestartRequester({ env: { WORKTODO_RESTART_COMMAND: 'pkill -f DSH' }, config: {} });
  eq(fromEnv.available, true, '环境变量也能提供重启命令（测试缝）：');
  eq(fromEnv.command, 'pkill -f DSH');
});

await test('面板配置 normalizePanelConfig：celebrate 默认 true，只有显式 false 才关', () => {
  eq(normalizePanelConfig({}), { celebrate: true }, '缺省必须是开：');
  eq(normalizePanelConfig(undefined), { celebrate: true });
  eq(normalizePanelConfig(null), { celebrate: true });
  eq(normalizePanelConfig({ celebrate: true }), { celebrate: true });
  eq(normalizePanelConfig({ celebrate: false }), { celebrate: false }, '显式 false 才关：');
  eq(normalizePanelConfig({ celebrate: 'no' }), { celebrate: true }, '非布尔 false 一律回落 true（bad config 不打崩）：');
  eq(normalizePanelConfig({ celebrate: 0 }), { celebrate: true });
});

await test('面板配置随 /list 载荷下发：默认 celebrate:true，config.celebrate:false 时原样传达给面板', async () => {
  const on = await makePanelConfigHost();
  const off = await makePanelConfigHost({ celebrate: false });
  try {
    const read = (host) => call(host.routes.get('/worktodo/list').handler, {
      method: 'GET', url: '/worktodo/list?filter=all&shapes=groups',
    });
    const onBody = (await read(on.host)).json();
    const offBody = (await read(off.host)).json();
    eq(onBody.ok, true);
    eq(typeof onBody.data.panel, 'object', '/list 载荷必须带 panel 配置块（面板是浏览器半侧，拿不到组合配置）：');
    eq(onBody.data.panel, { celebrate: true }, '默认必须是开：');
    eq(offBody.data.panel, { celebrate: false }, '显式关闭必须原样传达：');
    // 老面板不看新字段、新面板不依赖老宿主：多一个键不该动别的字段
    eq(Array.isArray(onBody.data.projects), true, '新增 panel 不能挤掉既有字段：');
    eq(typeof onBody.data.today, 'string');
  } finally {
    rmSync(on.dir, { recursive: true, force: true });
    rmSync(off.dir, { recursive: true, force: true });
  }
});

await test('平台包全部不可解析：apply 不抛、只降级（工具/官方存储失败，宿主不受影响）', () => {
  // 真实场景：插件在 profile 里，但 @deepseek-ai/dsh-tools / dsh-storage-domain 解析不到
  // （宿主版本太旧、拦截层没提供、profile 装坏了）。这时**不能**让 apply 抛异常——
  // 插件是 bundle 里的一层，apply 抛会被宿主记成「required plugin did not activate」。
  //
  // 做法：把插件源码复制到没有 node_modules 的 /tmp 目录，父目录链上也没有平台包；
  // 子进程里用假 ctx 走一遍 apply。这是**真实解析失败**，不是打桩。
  const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const copyDir = mkdtempSync(join(tmpdir(), 'worktodo-no-platform-'));
  try {
    for (const entry of ['lib', 'src', 'package.json']) {
      cpSync(join(pluginRoot, entry), join(copyDir, entry), { recursive: true });
    }
    const childSource = String.raw`import { apply } from './lib/index.js';

const logs = [];
const services = {
  storageDomain: { async open() { throw new Error('平台包缺失时不应走到 open'); } },
  tools: { register() { return () => {}; } },
};
const ctx = {
  logger: () => ({ info: (message) => logs.push('info ' + message), warn: (message) => logs.push('warn ' + message) }),
  get: (name) => services[name],
  on: () => () => {},
  emit: () => {},
  inject: (deps, callback) => {
    if (deps.every((dep) => services[dep])) callback(ctx);
    return () => {};
  },
  effect: (callback) => { callback(); return { dispose() {} }; },
  systemPrompt: { section: () => () => {} },
};

let thrown = null;
try {
  await apply(ctx, { autoUpdate: false });
} catch (error) {
  thrown = error;
}
await new Promise((resolve) => setTimeout(resolve, 300));

if (thrown) {
  console.error('APPLY_THREW ' + (thrown && thrown.stack ? thrown.stack : thrown));
  process.exit(2);
}
const text = logs.join('\n');
const checks = [
  ['工具未注册降级', text.includes('工具未注册')],
  ['官方存储打开失败', text.includes('打开失败')],
  ['回退到 JSON 文件', text.includes('待办数据使用 JSON 文件')],
];
const missing = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (missing.length) {
  console.error('MISSING_LOGS ' + missing.join(',') + '\n' + text);
  process.exit(3);
}
console.log('RESILIENT_OK');
`;
    writeFileSync(join(copyDir, 'child.mjs'), childSource);
    const run = spawnSync(process.execPath, [join(copyDir, 'child.mjs')], {
      cwd: copyDir,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        DSH_HOME: join(copyDir, 'home'),
        WORKTODO_NO_UPDATE_CHECK: '1',
        WORKTODO_STARTUP_CHECK_DELAY_MS: '0',
      },
    });
    eq(run.error, undefined, `子进程启动失败：${run.error}`);
    eq(run.status, 0, `应正常退出（实际 ${run.status}）\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    eq(run.stdout.includes('RESILIENT_OK'), true, `缺少成功标记\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  } finally {
    rmSync(copyDir, { recursive: true, force: true });
  }
});

await test('元测试：模拟版本全部从 package.json 派生，源码里没有当前版本号字面量（防发版假红回归）', () => {
  // 1) 派生关系本身要成立：它必须严格新于当前版本、且形如 x.y.z
  eq(FAKE_CURRENT_VERSION, PKG_VERSION, 'FAKE_CURRENT_VERSION 必须就是 package.json 的版本：');
  eq(FAKE_NEXT_VERSION === PKG_VERSION, false, '模拟的新版本不能等于当前版本（否则「升级」其实没升级）：');
  eq(/^\d+\.\d+\.\d+$/.test(FAKE_NEXT_VERSION), true, `模拟新版本必须是 x.y.z：${FAKE_NEXT_VERSION}`);
  eq(bumpPatch(FAKE_NEXT_VERSION, -1), PKG_VERSION, 'FAKE_NEXT_VERSION 必须是当前版本 patch + 1：');

  // 2) 源码里不许再出现当前版本号的字面量 —— 夹具/断言/假 pnpm/生成脚本都必须引用常量。
  //    为什么扫全文：这次假红正是「漏改」了几处字符串（断言、生成脚本、清单片段），
  //    只盯某几行或列白名单还会再漏。历史夹具用的老版本（0.2.0 等）远低于当前版本，
  //    且版本号单调递增，不会与当前版本撞车；边界用「前后不能是数字或点」判定，
  //    避免将来「补丁号进位」时被「前缀相同的历史版本」误伤这类子串问题（不在注释里写版本字面量）。
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const escaped = PKG_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fixated = new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`);
  const offenders = source.split('\n')
    .map((line, index) => ({ index: index + 1, line: line.trim() }))
    .filter(({ line }) => fixated.test(line));
  if (offenders.length) {
    throw new Error(`源码里出现了当前版本 ${PKG_VERSION} 的字面量（发版后会变成假红），`
      + `请改用 PKG_VERSION / FAKE_NEXT_VERSION 派生：\n`
      + offenders.map(({ index, line }) => `  第 ${index} 行：${line}`).join('\n'));
  }
});

console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error?.stack ?? f.error}`);
  process.exit(1);
}
