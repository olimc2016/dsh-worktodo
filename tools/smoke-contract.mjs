// 单元测试不打网络：关掉插件的更新检查（它默认会查一次 npm registry）
process.env.WORKTODO_NO_UPDATE_CHECK = '1';
/**
 * 客户端 ↔ 宿主契约测试。
 *
 * 为什么需要它：`smoke-client.mjs` 只验到「面板首屏会去拉列表」，面板**按钮的写路径**从未被端到端验过。
 * 而这里最容易出的错是**静默错**——客户端把字段名打错（`titel` / `duedate`）时，
 * 宿主不会报错，只是那个字段永远不生效：用户填了截止日期却永远不保存，而没有任何红灯。
 *
 * 做法分两层：
 *   1. **静态提取**：从 src/client/index.js 里抽出它实际请求的路径与字段名，
 *      与宿主 apply() 真正注册的路由、真正消费的字段做比对。客户端以后改坏了会立刻失败。
 *   2. **行为验证**：用客户端**字面上的报文形状**去打真实路由（含两处清空约定：
 *      create 用 `due: null`、update 用 `due: ''` / `project: ''`），断言端到端结果。
 *
 * 说明：这是行为契约测试，不是视觉验证——面板长什么样仍然只能由人眼看。
 */
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { apply } from '../lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, '..', 'src', 'client', 'index.js'), 'utf8');

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

/* ------------------------------------------------------------------ *
 * 静态提取：客户端到底请求了什么
 * ------------------------------------------------------------------ */

/**
 * 从源码里抽 `postJson('<path>', { ... })` 的路径与对象字面量文本。
 * 需要做花括号配对（请求体是多行的），所以不能只用正则。
 * @returns {{path: string, keys: string[]}[]}
 */
function extractClientPosts() {
  const out = [];
  const marker = 'postJson(';
  let index = clientSource.indexOf(marker);
  while (index !== -1) {
    const after = clientSource.slice(index + marker.length);
    const pathMatch = /^\s*'([^']+)'\s*,\s*\{/.exec(after);
    if (pathMatch) {
      const bodyStart = index + marker.length + pathMatch[0].length - 1;
      // 花括号配对，跳过字符串里的括号
      let depth = 0;
      let inString = null;
      let end = bodyStart;
      for (let i = bodyStart; i < clientSource.length; i += 1) {
        const ch = clientSource[i];
        if (inString) {
          if (ch === '\\') i += 1;
          else if (ch === inString) inString = null;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue; }
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) { end = i; break; }
        }
      }
      out.push({ path: pathMatch[1], keys: topLevelKeys(clientSource.slice(bodyStart + 1, end)) });
    }
    index = clientSource.indexOf(marker, index + marker.length);
  }
  return out;
}

/**
 * 抽对象字面量的顶层键（忽略嵌套与值）。
 *
 * 关键点：字面量是多行且带三元表达式的，例如
 *   `{ title, due: input?.due ? String(input.due) : null, priority: input?.priority ?? 'normal' }`
 * 键只能出现在 `{` 或 `,` 之后（简写键后面跟 `,`/`}`），所以不能用「任意位置出现标识符」的正则——
 * 那会把 `: null` 里的 null 也当成键（第一次跑就踩了这个）。
 * `...patch` 这类展开单独识别，它代表「行内编辑提交的字段集合」。
 * @param {string} literalText
 * @returns {string[]}
 */
function topLevelKeys(literalText) {
  const keys = [];
  for (const m of literalText.matchAll(/(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*(?=[,:}\n])/g)) {
    if (!keys.includes(m[1])) keys.push(m[1]);
  }
  if (/\.\.\.\s*patch/.test(literalText)) keys.push('...patch');
  return keys;
}

/** 行内编辑真正会写进 patch 的字段（从 TodoRow 的 `patch.xxx =` 赋值里提取）。 */
function extractPatchFields() {
  const found = new Set();
  for (const m of clientSource.matchAll(/patch\.([A-Za-z_$][\w$]*)\s*=/g)) found.add(m[1]);
  return [...found].sort();
}

const clientPosts = extractClientPosts();
const patchFields = extractPatchFields();

/** 客户端发送的 GET 路径（列表）。 */
const clientGetPaths = [...clientSource.matchAll(/fetch\(`\$\{ROUTE_LIST\}([^`]*)`/g)].map((m) => `/list${m[1]}`);

console.log('静态提取');

await test('能从客户端源码里抽出全部写请求', () => {
  const paths = clientPosts.map((p) => p.path).sort();
  eq(paths, ['/adopt', '/create', '/remove', '/reorder', '/status', '/update']);
});

await test('能抽出列表 GET 路径与行内编辑字段', () => {
  // 客户端现在会带上排序参数（sort=manual|priority|created），所以断言前缀而不是整串——
  // 断言整串会让每次调整 URL 都假红，前缀断言仍能抓住「不再拉 /list」这种真问题
  eq(clientGetPaths.length, 1, '应当只有一个列表 GET：');
  eq(clientGetPaths[0].startsWith('/list?filter=all'), true, `列表路径前缀不对：${clientGetPaths[0]}`);
  eq(patchFields, ['due', 'dueTime', 'notes', 'priority', 'project', 'title']);
});

/* ------------------------------------------------------------------ *
 * 宿主：真实 apply()，拿到真实路由
 * ------------------------------------------------------------------ */

const root = mkdtempSync(join(tmpdir(), 'worktodo-contract-'));
const routes = new Map();
const logs = [];
const ctx = {
  logger: () => ({ info: (m) => logs.push(m), warn: (m) => logs.push(m) }),
  get: () => undefined,
  inject: (deps, callback) => { callback(ctx); return () => {}; },
  effect: (callback) => { const dispose = callback(); return { dispose: dispose ?? (() => {}) }; },
  webServer: {
    register: ({ path, handler }) => { routes.set(path, handler); return () => routes.delete(path); },
  },
  tools: { register: () => () => {} },
};
await apply(ctx, { storePath: join(root, 'todos.json') });

/** 假请求/响应，与 smoke-host 同构。 */
function makeRequest({ method = 'GET', url, body } = {}) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = url;
  if (body !== undefined) req.push(typeof body === 'string' ? body : JSON.stringify(body));
  req.push(null);
  return req;
}

/**
 * 打一个真实路由。
 * @param {string} path
 * @param {{method?: string, url?: string, body?: object}} options
 * @returns {Promise<object>} 解析后的 JSON 体
 */
async function hit(path, options = {}) {
  // 路由是按不含查询串的路径注册的，查询串由 handler 自己从 request.url 解析
  const handler = routes.get(path.split('?')[0]);
  if (!handler) throw new Error(`路由不存在：${path}`);
  const response = {
    statusCode: null, text: '',
    writeHead(status) { this.statusCode = status; },
    end(text) { this.text = text ?? ''; },
  };
  await handler(makeRequest({ method: 'GET', url: path, ...options }), response);
  return response.text ? JSON.parse(response.text) : null;
}

console.log('契约：客户端请求的路径必须真实存在');

await test('每个写请求路径都在宿主注册的路由里', () => {
  const missing = clientPosts
    .map((p) => `/worktodo${p.path}`)
    .filter((full) => !routes.has(full));
  eq(missing, [], '客户端请求了宿主没有的路由（路径写错）：');
});

await test('列表 GET 路径存在', () => {
  for (const suffix of clientGetPaths) {
    const full = `/worktodo${suffix.split('?')[0]}`;
    eq(routes.has(full), true, `${full} 未注册：`);
  }
});

console.log('契约：客户端发的字段必须被宿主真正消费');

/** 各路由接受的字段（镜像 lib/index.js 的 handler 与 service 的输入）。 */
const ACCEPTED = {
  '/create': ['title', 'notes', 'priority', 'due', 'dueTime', 'project', 'status'],
  '/update': ['ref', 'id', 'title', 'notes', 'priority', 'due', 'dueTime', 'project', 'status', '...patch'],
  '/status': ['ref', 'id', 'status', 'toggle'],
  '/remove': ['ref', 'id'],
  '/adopt': ['todos'],
};

await test('每个请求体字段都在该路由接受范围内（防字段名打错导致的静默失效）', () => {
  const problems = [];
  for (const post of clientPosts) {
    const allowed = ACCEPTED[post.path] ?? [];
    for (const key of post.keys) {
      if (!allowed.includes(key)) problems.push(`${post.path} 发了宿主不认的字段 ${key}`);
    }
  }
  eq(problems, []);
});

await test('行内编辑提交的字段都在 /update 接受范围内', () => {
  const allowed = ACCEPTED['/update'];
  const problems = patchFields.filter((key) => !allowed.includes(key));
  eq(problems, [], '编辑提交了宿主不认的字段：');
});

console.log('契约：客户端字面报文形状端到端可用');

await test('create 的报文（无截止日期时 due:null）能落库', async () => {
  // 与 src/client/index.js 的 handleAdd 完全同形
  const body = await hit('/worktodo/create', {
    method: 'POST',
    url: '/worktodo/create',
    body: { title: '契约测试：写周报', due: null, priority: 'high' },
  });
  eq(body.ok, true);
  eq(body.data.todo.due, null);
  eq(body.data.todo.priority, 'high');
  eq(body.data.todo.status, 'pending');
});

await test('update 的空串约定能清空截止日期与项目（面板就靠这个）', async () => {
  const list = await hit('/worktodo/list?filter=all');
  const id = list.data.todos[0].id;

  // 先设上
  const set = await hit('/worktodo/update', {
    method: 'POST', url: '/worktodo/update',
    body: { ref: id, due: '2026-11-01', project: 'demo' },
  });
  eq(set.data.todo.due, '2026-11-01');
  eq(set.data.todo.project, 'demo');

  // 再按面板的行内编辑形状清空：due 与 project 都是空串
  const cleared = await hit('/worktodo/update', {
    method: 'POST', url: '/worktodo/update',
    body: { ref: id, due: '', project: '' },
  });
  eq(cleared.ok, true);
  eq(cleared.data.todo.due, null, '空串应清空截止日期：');
  eq(cleared.data.todo.project, null, '空串应清空项目：');
});

await test('status 的 toggle 约定（勾选框）可用', async () => {
  const list = await hit('/worktodo/list?filter=all');
  const id = list.data.todos[0].id;
  const done = await hit('/worktodo/status', { method: 'POST', url: '/worktodo/status', body: { ref: id, toggle: true } });
  eq(done.data.todo.status, 'completed');
  const undone = await hit('/worktodo/status', { method: 'POST', url: '/worktodo/status', body: { ref: id, toggle: true } });
  eq(undone.data.todo.status, 'pending');
});

await test('adopt 的报文（todos 数组）可用，且面板拿到的字段够渲染', async () => {
  const body = await hit('/worktodo/adopt', {
    method: 'POST', url: '/worktodo/adopt',
    body: { todos: [{ content: '契约测试：发 npm', status: 'pending' }] },
  });
  eq(body.ok, true);
  eq(body.data.created.length, 1);
  // 面板渲染一行需要这些字段：id/title/status/priority/due/project/source
  const created = body.data.created[0];
  for (const key of ['id', 'title', 'status', 'priority', 'due', 'project', 'source', 'createdAt', 'updatedAt', 'completedAt']) {
    eq(key in created, true, `面板需要的字段 ${key} 缺失：`);
  }
});

await test('remove 的报文（ref）可用', async () => {
  const list = await hit('/worktodo/list?filter=all');
  const id = list.data.todos[0].id;
  const removed = await hit('/worktodo/remove', { method: 'POST', url: '/worktodo/remove', body: { ref: id } });
  eq(removed.ok, true);
});

await test('list 返回面板首屏需要的全部字段与五个分组', async () => {
  const body = await hit('/worktodo/list?filter=all');
  eq(body.ok, true);
  for (const key of ['todos', 'groups', 'stats', 'today', 'store', 'projects']) {
    eq(key in body.data, true, `面板需要的字段 ${key} 缺失：`);
  }
  eq(Object.keys(body.data.groups).sort(), ['completed', 'later', 'overdue', 'today', 'week']);
  eq(typeof body.data.store.kind, 'string');
  eq(typeof body.data.store.location, 'string');
});

try {
  rmSync(root, { recursive: true, force: true });
} catch { /* 清理失败不影响结论 */ }

console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error?.stack ?? f.error}`);
  process.exit(1);
}
