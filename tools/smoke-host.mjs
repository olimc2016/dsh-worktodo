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
function makeCtx({ rejection } = {}) {
  const routes = new Map();
  const tools = [];
  const effects = [];
  const logs = [];
  const ctx = {
    logger: () => ({ info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`) }),
    get: (name) => (name === 'connection' && rejection ? { requestRejection: rejection } : undefined),
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
    webServer: {
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
  return { ctx, routes, tools, effects, logs };
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

await test('注册出 7 条路由', () => {
  eq([...routes.keys()].sort(), [
    '/worktodo/adopt',
    '/worktodo/create',
    '/worktodo/health',
    '/worktodo/list',
    '/worktodo/remove',
    '/worktodo/status',
    '/worktodo/update',
  ]);
});

await test('注册出 6 个 worktodo_* 工具（schema 过官方 defineTool 校验）', () => {
  eq(tools.map((t) => t.name).sort(), [
    'worktodo_add',
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
  eq(body.tools.registered, 6);
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

console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error?.stack ?? f.error}`);
  process.exit(1);
}
