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
      // start = 对象字面量开括号的位置（C3 的 extractArgExpression 从这里往后找键）
      out.push({ path: pathMatch[1], keys: topLevelKeys(clientSource.slice(bodyStart + 1, end)), start: bodyStart });
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
  // 先剥掉行注释：注释会挡在 `,` 与下一个键之间，让键抽不出来（`dueTime` 就踩过这个）
  const text = literalText.replace(/\/\/[^\n]*/g, '');
  const keys = [];
  for (const m of text.matchAll(/(?:^|[,{])\s*([A-Za-z_$][\w$]*)\s*(?=[,:}\n])/g)) {
    if (!keys.includes(m[1])) keys.push(m[1]);
  }
  if (/\.\.\.\s*patch/.test(text)) keys.push('...patch');
  return keys;
}

/** 行内编辑真正会写进 patch 的字段（从 TodoRow 的 `patch.xxx =` 赋值里提取）。 */
function extractPatchFields() {
  const found = new Set();
  for (const m of clientSource.matchAll(/patch\.([A-Za-z_$][\w$]*)\s*=/g)) found.add(m[1]);
  return [...found].sort();
}

/**
 * 剥掉 JS 源码里的行注释（保留换行、**不碰字符串里的 `//`**，例如 `'https://…'`）。
 * @param {string} text
 * @returns {string}
 */
function stripLineComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] ?? ''; i += 1; }
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n'; // 保留换行：键与逗号之间的注释被删掉后，定位仍然跨行
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 客户端传给 `/create` 的某个字段值是怎么算出来的（用于「空值必须显式 null」这类结构+行为断言）。
 *
 * C3：`extractArgExpression` 抽出表达式的**原文**；这里只管两种输入下的实际值：
 *   （a）没给值（undefined）→ 必须是 null（缺键/undefined 会被宿主当成「没有这个键」）；
 *   （b）给了值 → 必须等于给定的期望值（顺带证明表达式不是恒 null）。
 * 抽出来的表达式只依赖 `input` 与 `String`，在独立作用域里求值是安全的；
 * 顺序断言（先判空）让「条件写反」这种逻辑错误在（a）里就暴露。
 * @param {{path: string, keys: string[], start: number}} post
 * @param {string} key
 * @param {unknown} givenValue 表单里给的值（模拟 QuickAdd 传来的 input）
 * @param {unknown} expectedGiven 期望的报文字段值
 * @returns {unknown} undefined 输入时该字段的值
 */
function evaluateCreateArg(post, key, givenValue, expectedGiven) {
  const expr = extractArgExpression(post, key);
  // eslint-disable-next-line no-new-func
  const evaluate = new Function('input', `return (${expr});`);
  const empty = evaluate(undefined);
  eq(empty, null, `${key}：未给值时必须发 null（undefined 会被宿主当成缺键），实际 ${JSON.stringify(empty)}，表达式 ${expr}`);
  const given = evaluate({ [key]: givenValue });
  eq(given, expectedGiven, `${key}：给了 ${JSON.stringify(givenValue)} 时应当发 ${JSON.stringify(expectedGiven)}，实际 ${JSON.stringify(given)}，表达式 ${expr}`);
  return { expr, empty, given };
}

/**
 * 从 `/create` 的字面报文里取某个键的表达式原文（深度感知，换成别的写法也不会假红）。
 *
 * C3：原先用整串正则匹配 `project:\s*input\?\.project\s*\?\s*String\(…\)\.trim\(\)\s*:\s*null`，
 * 把变量名/抽取方式绑死在源码文本上——等价重构成
 * `project: (() => { const raw = input?.project; return typeof raw === 'string' ? raw.trim() : null; })()`
 * 会假红（已实测），而把条件写成 `!input?.project ? … : null`（逻辑反了）它照样通过（也实测过）。
 * 这里只抽**表达式**，交给 `evaluateCreateArg` 用真实输入求值——
 * 写法变了不红，语义反了/空值分支不是 null 才红。
 * @param {{path: string, keys: string[], start: number}} post
 * @param {string} key
 * @returns {string|null}
 */
function extractArgExpression(post, key) {
  // 先剥掉行注释（保留换行）：注释会挡在 `,` 与键之间，让「键只能跟在 { 或 , 之后」的定位失败
  //（`project` 与 `dueTime` 前面都有一段说明注释，第一次跑就踩了这个）。
  const literal = stripLineComments(clientSource.slice(post.start));
  const marker = new RegExp(`(?:^|[{,])\\s*${key}\\s*:`).exec(literal);
  if (!marker) return null;
  const valueStart = marker.index + marker[0].length;
  const open = '{([';
  const close = '})]';
  let depth = 0;
  let quote = null;
  let end = literal.length;
  for (let i = valueStart; i < literal.length; i += 1) {
    const ch = literal[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (open.includes(ch)) depth += 1;
    else if (close.includes(ch)) {
      if (depth === 0) { end = i; break; }
      depth -= 1;
    } else if (ch === ',' && depth === 0) { end = i; break; }
  }
  return literal.slice(valueStart, end).trim();
}

const clientPosts = extractClientPosts();
const patchFields = extractPatchFields();

/** 客户端发送的 GET 路径（列表）。 */
const clientGetPaths = [...clientSource.matchAll(/fetch\(`\$\{ROUTE_LIST\}([^`]*)`/g)].map((m) => `/list${m[1]}`);

console.log('静态提取');

await test('能从客户端源码里抽出全部写请求', () => {
  // 去重：`/update` 现在有两个调用点（改待办 + 自升级 `{action:'plugin-update'}`），
  // 但它们是同一个路由；断言的是「路径集合」而不是「调用点个数」。
  const paths = [...new Set(clientPosts.map((p) => p.path))].sort();
  eq(paths, ['/adopt', '/create', '/remove', '/reorder', '/settings', '/status', '/update']);
});

await test('能抽出列表 GET 路径与行内编辑字段', () => {
  // 客户端现在会带上排序参数（sort=manual|priority|created），所以断言前缀而不是整串——
  // 断言整串会让每次调整 URL 都假红，前缀断言仍能抓住「不再拉 /list」这种真问题
  eq(clientGetPaths.length, 1, '应当只有一个列表 GET：');
  eq(clientGetPaths[0].startsWith('/list?filter=all'), true, `列表路径前缀不对：${clientGetPaths[0]}`);
  eq(patchFields, ['due', 'dueTime', 'notes', 'priority', 'project', 'title']);
});

await test('客户端新建待办必须把 dueTime 一起发出去（否则用户选的时间被静默丢弃，审计 F5）', () => {
  const create = clientPosts.find((p) => p.path === '/create');
  eq(Boolean(create), true, '没有从客户端源码抽出 /create 的报文：');
  eq(create.keys.includes('dueTime'), true, `/create 报文缺 dueTime：${JSON.stringify(create.keys)}`);
  // 空值必须是 null（不是 undefined）：undefined 会被宿主当成「没有这个键」，
  // 而 QuickAdd 已经把时间词从标题里摘掉了，丢了就找不回来。
  // C3：不绑源码文本，直接拿抽出来的表达式求值（未给值 → null；给了值 → 原样发出）。
  evaluateCreateArg(create, 'dueTime', '15:30', '15:30');
});

await test('客户端新建待办必须把 project 一起发出去，且空值分支是 null（项目选择器字段）', () => {
  const create = clientPosts.find((p) => p.path === '/create');
  eq(Boolean(create), true, '没有从客户端源码抽出 /create 的报文：');
  eq(create.keys.includes('project'), true, `/create 报文缺 project：${JSON.stringify(create.keys)}`);
  // undefined 会被宿主当成「没有这个键」（甚至触发无损 JSON 校验失败），
  // 所以「未归类」必须显式发 null —— 与 due/dueTime 同一条约定。
  // C3：不绑源码文本，直接拿抽出来的表达式求值：未给值 → null，给了值 → trim 后原样发出。
  //      条件写反（`!input?.project ? … : null`）会让空值分支变成 `String(undefined)`，这条立刻红。
  evaluateCreateArg(create, 'project', '  beta  ', 'beta');
  // 行内编辑那条路径用的是空串清空（/update），两种约定都要保留
  eq(patchFields.includes('project'), true, '行内编辑仍要能改项目：');
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
  // `action:'plugin-update'` 是自升级开关（同一个路径两个动词/两种语义，见 lib/index.js 的 /update）
  '/update': ['action', 'ref', 'id', 'title', 'notes', 'priority', 'due', 'dueTime', 'project', 'status', '...patch'],
  '/status': ['ref', 'id', 'status', 'toggle'],
  '/remove': ['ref', 'id'],
  '/adopt': ['todos'],
  // 更新方式设置：只接受 {updateMode}，非法值 400
  '/settings': ['updateMode'],
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
    body: { title: '契约测试：写周报', due: null, dueTime: null, priority: 'high' },
  });
  eq(body.ok, true);
  eq(body.data.todo.due, null);
  eq(body.data.todo.dueTime, null);
  eq(body.data.todo.priority, 'high');
  eq(body.data.todo.status, 'pending');
});

await test('create 带 dueTime 的报文能落库（面板新加的字段宿主真的消费）', async () => {
  const body = await hit('/worktodo/create', {
    method: 'POST',
    url: '/worktodo/create',
    body: { title: '契约测试：下午三点交报告', due: '2026-11-02', dueTime: '15:00', priority: 'normal' },
  });
  eq(body.ok, true);
  eq(body.data.todo.due, '2026-11-02');
  eq(body.data.todo.dueTime, '15:00', '用户选的时间必须真的存下来：');
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

await test('create 带 project 的报文能落库，并被 /list 的 projects 反映（任何 shapes 都带清单）', async () => {
  const body = await hit('/worktodo/create', {
    method: 'POST',
    url: '/worktodo/create',
    // 与 src/client/index.js 的 handleAdd 完全同形（未归类时 project: null）
    body: { title: '契约测试：选一个项目', due: null, dueTime: null, priority: 'none', project: 'contract-proj' },
  });
  eq(body.ok, true);
  eq(body.data.todo.project, 'contract-proj', '面板选的项目必须真的存下来：');

  // 面板停在「按截止」（shapes=groups）时也会用项目选择器 —— 清单必须在这个形状下就有
  for (const shapes of ['groups', 'projectGroups', 'todos']) {
    const list = await hit(`/worktodo/list?filter=all&shapes=${shapes}`);
    eq(Array.isArray(list.data.projects), true, `shapes=${shapes} 时 projects 必须是数组：`);
    eq(list.data.projects.includes('contract-proj'), true, `shapes=${shapes} 时清单要含刚建的项目：`);
    eq(typeof list.data.projectsTruncated, 'boolean', `shapes=${shapes} 时 projectsTruncated 必须是布尔：`);
  }
});

await test('update 用 project:null 也能清空（面板的「未归类」走这条）', async () => {
  const list = await hit('/worktodo/list?filter=all');
  const target = list.data.todos.find((todo) => todo.project === 'contract-proj');
  eq(Boolean(target), true, '先得有一条带项目的记录：');
  const cleared = await hit('/worktodo/update', {
    method: 'POST', url: '/worktodo/update', body: { ref: target.id, project: null },
  });
  eq(cleared.ok, true);
  eq(cleared.data.todo.project, null, 'project:null 必须清空：');
  const after = await hit('/worktodo/list?filter=all&shapes=todos');
  eq(after.data.projects.includes('contract-proj'), false, '清空后清单里不该再有它：');
});

await test('C3：create/update 两条路径的空值语义（显式 null 与空串）落到宿主都不产生空项目', async () => {
  // 与 src/client/index.js 的 handleAdd 完全同形（未归类时 project/dueTime 显式给 null）。
  // 行为断言：报文里键在、值为 null → 宿主落 null，且清单里不会多出一个空项目。
  const body = await hit('/worktodo/create', {
    method: 'POST',
    url: '/worktodo/create',
    body: { title: '契约测试：未归类（显式 null）', due: null, dueTime: null, priority: 'none', project: null },
  });
  eq(body.ok, true);
  eq(body.data.todo.project, null, 'project:null 必须落成 null：');
  eq(body.data.todo.dueTime, null, 'dueTime:null 必须落成 null：');

  const list = await hit('/worktodo/list?filter=all&shapes=todos');
  const stored = list.data.todos.find((todo) => todo.id === body.data.todo.id);
  eq(Boolean(stored), true, '刚建的记录要能读回来：');
  eq(Object.prototype.hasOwnProperty.call(stored, 'project'), true, '记录里必须有 project 键：');
  eq(stored.project, null, '未归类的记录 project 必须是显式 null：');
  eq(list.data.projects.includes('') === false && list.data.projects.includes(null) === false, true,
    `未归类不该进项目清单：${JSON.stringify(list.data.projects)}`);

  // 行内编辑那条路径（/update + project:null）同样不能留下空项目
  const set = await hit('/worktodo/update', { method: 'POST', url: '/worktodo/update', body: { ref: body.data.todo.id, project: 'c3-proj' } });
  eq(set.data.todo.project, 'c3-proj');
  const back = await hit('/worktodo/update', { method: 'POST', url: '/worktodo/update', body: { ref: body.data.todo.id, project: null } });
  eq(back.data.todo.project, null, 'update 的 project:null 必须清空：');
  const after = await hit('/worktodo/list?filter=all&shapes=todos');
  eq(after.data.projects.includes('c3-proj'), false, '清空后不该留在清单里：');
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
  for (const key of ['todos', 'groups', 'stats', 'today', 'store', 'projects', 'projectsTruncated', 'panel']) {
    eq(key in body.data, true, `面板需要的字段 ${key} 缺失：`);
  }
  eq(Object.keys(body.data.groups).sort(), ['completed', 'later', 'overdue', 'today', 'week']);
  eq(typeof body.data.store.kind, 'string');
  eq(typeof body.data.store.location, 'string');
  // 面板配置块：勾选完成动效的开关（宿主 config.celebrate → 面板 config.celebrate）
  eq(body.data.panel.celebrate, true, '没配 celebrate 时必须是开（缺省 = 开）：');
});

console.log('契约：自升级的「两步」动作与状态字段（客户端 ↔ 宿主）');

/**
 * 从客户端源码里抽出它真的会发的 action 词（不手抄，改坏了立刻红）。
 * `plugin-update` 是「一次到位」的旧兜底，会被过滤掉：它真的会去改 profile，
 * 只在 smoke-host 里用假 profile 跑（这里的宿主没有临时 profile，绝不能碰真实安装）。
 */
function clientUpdateActions() {
  const found = new Set();
  for (const match of clientSource.matchAll(/postUpdateAction\(['"]([a-z-]+)['"]/gu)) found.add(match[1]);
  return [...found].sort();
}

// 安全围栏：这组用例里的宿主不该反推出任何真实 profile；指到一个不存在的临时路径，
// 万一哪条路径真的走到 profile 解析，也只会得到 profile-not-found，绝不会动真实安装。
process.env.WORKTODO_PROFILE_DIR = join(root, 'no-such-profile');

await test('两步护栏：没下载就发「安装并重启」→ 宿主明确拒绝（not-downloaded），不是静默成功', async () => {
  const body = await hit('/worktodo/update', { method: 'POST', url: '/worktodo/update', body: { action: 'plugin-update-install' } });
  eq(body.ok, false, '没下载时安装必须被拒绝：');
  eq(body.reason, 'not-downloaded', `拒绝原因要是 not-downloaded（实际 ${body.reason}）：`);
  eq(String(body.error).includes('下载'), true, `要说清「先去下载」：${body.error}`);
  // 被拒绝的安装绝不能把阶段改成 installing/installed（那是「假装在装」）
  const status = await hit('/worktodo/update?x=1');
  eq(['idle', 'available', 'downloaded'].includes(status.data.phase), true,
    `被拒绝的安装不许改动阶段（实际 ${status.data.phase}）：`);
});

await test('客户端发的每个自升级 action，宿主都按「升级」而不是「改待办」处理', async () => {
  const actions = clientUpdateActions();
  eq(actions.includes('plugin-update'), true, `客户端必须保留「一次到位」的旧兜底 action：${JSON.stringify(actions)}`);
  for (const action of actions.filter((entry) => entry !== 'plugin-update')) {
    const body = await hit('/worktodo/update', { method: 'POST', url: '/worktodo/update', body: { action } });
    // 升级语义的响应一定带 ok + 稳定 reason（或状态）；「改待办」会因为没有 ref 报 unknown-ref
    eq(typeof body?.ok, 'boolean', `${action} 的响应不可识别：${JSON.stringify(body)}`);
    if (/ref|待办/u.test(String(body?.error ?? body?.reason ?? ''))) {
      throw new Error(`${action} 被当成「改待办」处理了：${JSON.stringify(body)}`);
    }
    if (action === 'plugin-update-check') {
      // 「检查更新」没有失败时是成功收口（返回状态），不是「没有前提」的拒绝；
      // 测试环境用 WORKTODO_NO_UPDATE_CHECK=1 关掉了网络，所以它安全地什么都不做。
      eq(typeof body?.data?.phase, 'string', `plugin-update-check 必须返回稳定的阶段（实际 ${JSON.stringify(body)}）：`);
      continue;
    }
    // 没注入 latest、也没下载物：这几条都必须安全地什么都不做
    eq(['no-target', 'not-downloaded', 'restart-unavailable'].includes(body.reason), true,
      `${action} 在没有前提时应当给出稳定原因（实际 ${body.reason}）：`);
  }
});

await test('GET /worktodo/update 带齐面板需要的阶段字段（phase/percent/version/autoInstall/restartSupported）', async () => {
  const body = await hit('/worktodo/update?x=1');
  eq(body.ok, true, 'GET 必须是 ok:true（ok:false 会让面板整块显示失败）：');
  for (const key of ['state', 'phase', 'percent', 'version', 'failedOperation', 'failure', 'download', 'restart', 'autoUpdate', 'autoInstall', 'restartSupported', 'registry', 'timeoutMs']) {
    eq(key in body.data, true, `状态里缺少面板需要的字段 ${key}：`);
  }
  eq(typeof body.data.autoInstall, 'boolean', 'autoInstall 必须是布尔（面板据此解释「后台会不会自己装」）：');
  eq(body.data.restartSupported, false, '没配 restartCommand 时 restartSupported 必须是 false（面板据此显示「请手动重启」）：');
  eq(body.data.phase, 'idle', `没有新版本时阶段必须是 idle（实际 ${body.data.phase}）：`);
  eq(body.data.percent, null, '没在下载时 percent 必须是 null（不是 0）：');
});

await test('/list 载荷里的 update 块也带阶段与重启能力（面板首屏就靠它，不用等轮询）', async () => {
  const body = await hit('/worktodo/list?filter=all');
  const block = body.data.update;
  eq(typeof block === 'object' && block !== null, true, '/list 必须带 update 块：');
  for (const key of ['phase', 'percent', 'version', 'autoInstall', 'restartSupported', 'run']) {
    eq(key in block, true, `/list 的 update 块缺少 ${key}：`);
  }
  eq(block.run.phase, 'idle', 'update.run 也要有 phase：');
  eq(block.phase, block.run.phase, '两个 phase 必须一致（面板两处都读）：');
});

delete process.env.WORKTODO_PROFILE_DIR;

try {
  rmSync(root, { recursive: true, force: true });
} catch { /* 清理失败不影响结论 */ }

console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error?.stack ?? f.error}`);
  process.exit(1);
}
