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
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// DSH 判定「工具返回值是否 lossless JSON」用的就是这一个函数（见 assertLossless 的说明）
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values';
import { apply } from '../lib/index.js';

// 版本断言从 package.json 动态读：硬编码会让每次发版都变红
// （0.1.0 → 0.1.1 时正是这样被自己抓到的）
const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

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

await test('注册出 8 条路由', () => {
  eq([...routes.keys()].sort(), [
    '/worktodo/adopt',
    '/worktodo/create',
    '/worktodo/health',
    '/worktodo/list',
    '/worktodo/remove',
    '/worktodo/reorder',
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
  eq(body.version, pkgVersion);
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
  eq(Object.keys(body.data.groups).sort(), ['completed', 'later', 'overdue', 'today', 'week']);
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
  const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  eq(payload.version, pkgVersion, '载荷里的版本应等于 package.json：');
  eq(typeof payload.update, 'object', 'update 应当是个对象：');
  eq(payload.update.current, pkgVersion);
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
    for (const failAt of [1, 3, 8]) {
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
      eq(server.table.size, 7, `只有失败的那一条该缺失，实际路由表：${[...server.table.keys()]}`);
      eq(server.table.has(server.calls.failed[0]), false, `失败的那条不该进路由表：${server.calls.failed[0]}`);
      eq(server.calls.register, 8, `8 条都要被尝试注册（失败一条不影响其余）：实际尝试 ${server.calls.register} 次`);
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
      eq(server.table.size, 8, '正常挂载应当 8 条路由都在：');
      for (const effect of good.effects.filter((e) => e.label === 'worktodo: http routes')) await effect.dispose?.();
      eq(server.table.size, 0, '正常挂载卸载后同样不留残留：');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('S1-2：storageDomain.open 永不 resolve → 超时后 apply 仍然返回并完整挂载（8 路由 / 7 工具）', async () => {
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
    eq(host.routes.size, 8, '超时后 8 条路由照常注册（面板可用）：');
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
    eq(host.routes.size, 8, `工具失败时 8 条路由照常在（实际 ${host.routes.size}）：`);
    const health = (await call(host.routes.get('/worktodo/health').handler, { method: 'GET', url: '/worktodo/health' })).json();
    eq(health.ok, true);
    eq(health.tools.status, 'failed', '工具注册失败必须显式报出来（不静默）：');
    eq(String(health.tools.error).includes('already has a registration'), true, `要带原始原因：${health.tools.error}`);
    eq(health.tools.registered, 0, '当前实现下一条失败会整批不算数（已记进报告的未修项）：');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error?.stack ?? f.error}`);
  process.exit(1);
}
