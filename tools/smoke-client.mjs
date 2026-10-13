/**
 * 客户端 bundle 烟测：在没有浏览器的环境里模拟 DSH 的模块加载器与 React，
 * 验证四件事：
 *   1. lib/client.js 是合法的「惰性 CJS factory」包装，id 等于包名；
 *   2. apply() 把侧栏入口与主面板注册到正确的 slot（id/key 写错的话侧栏点不开）；
 *   3. locale 字典 zh/en 键一一对应，且都注册在包名派生的命名空间上；
 *   4. **首屏渲染不抛异常**——官方文档说得很清楚：slot entry 抛异常会让整个入口白屏
 *      （控制台出现 `slot entry crashed in '<slot>'`），这是最致命的失败模式。
 *
 * 额外的硬性检查：bundle 的 require 只允许解析 react 系列。官方规范禁止插件
 * import 任何 @deepseek-ai/dsh-client-* 包（它们不保证兼容、会随时改），
 * 所以这里把「require 了别的东西」直接判为失败，而不是默默放行。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
const code = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

let passed = 0;
const failures = [];

/**
 * @param {string} label
 * @param {() => any} run
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

/** 少数用例需要等一个真实微/宏任务（例如首屏 fetch 落地后再重渲染）。 */
async function testAsync(label, run) {
  try {
    await run();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  ✗ ${label}\n      ${error?.message ?? error}`);
  }
}

/** 把 React 替身造出来的树摊平，便于按 className 找节点。 */
function flattenTree(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) flattenTree(child, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  flattenTree(node.children, out);
  return out;
}

/** 取一个替身节点的纯文本（children 里可能是嵌套数组/节点）。 */
function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object') return textOf(node.children);
  return node === null || node === undefined ? '' : String(node);
}

/* ------------------------------------------------------------------ *
 * 模拟外壳：window.__ModuleLoader__ + 基座模块表
 * ------------------------------------------------------------------ */

let captured = null;
/** window 上注册的事件监听（面板的「重新聚焦就刷新」走这里，复审 R4）。 */
const windowListeners = new Map();
globalThis.window = {
  __ModuleLoader__: {
    load(entry) { captured = entry; },
  },
  addEventListener: (event, handler) => {
    if (!windowListeners.has(event)) windowListeners.set(event, new Set());
    windowListeners.get(event).add(handler);
  },
  removeEventListener: (event, handler) => windowListeners.get(event)?.delete(handler),
};

/** document 替身：面板只在这里注册 visibilitychange（复审 R4）。 */
const documentListeners = new Map();
globalThis.document = {
  visibilityState: 'visible',
  addEventListener: (event, handler) => {
    if (!documentListeners.has(event)) documentListeners.set(event, new Set());
    documentListeners.get(event).add(handler);
  },
  removeEventListener: (event, handler) => documentListeners.get(event)?.delete(handler),
};

/** 记录组件树里出现过的元素类型，方便断言「渲染确实发生了」。 */
const rendered = [];

/** 首屏渲染时真正执行的 effect 数量（React 里首次数据请求通常在 useEffect 里发起）。 */
const effectRuns = [];
/** effect 返回的清理函数，收起来验证面板确实做了回收。 */
const effectCleanups = [];
/** 组件请求过的状态更新（setter 是空实现，只记录「刷新被请求过」）。 */
const stateUpdates = [];

/* 定时器替身：记录面板注册的自动刷新定时器，验证「有轮询且卸载时清掉」。 */
const intervals = [];
const clearedIntervals = [];
globalThis.setInterval = (fn, ms) => {
  const handle = { fn, ms, unref() {} };
  intervals.push(handle);
  return handle;
};
globalThis.clearInterval = (handle) => { clearedIntervals.push(handle); };

/** 极简 React 替身：让首屏渲染与首次请求真的跑起来，但不做重渲染。 */
const stubReact = {
  createElement(type, props, ...children) {
    rendered.push(typeof type === 'string' ? type : (type?.name ?? 'component'));
    return { type, props: props ?? {}, children };
  },
  Fragment: 'Fragment',
  memo: (c) => c,
  forwardRef: (c) => c,
  useState: (init) => [typeof init === 'function' ? init() : init, (next) => { stateUpdates.push(next); }],
  useReducer: (reducer, init) => [typeof init === 'function' ? init() : init, (next) => { stateUpdates.push(next); }],
  // 真的执行 effect：否则「组件挂载后去拉列表」这条最关键的路径根本不会被测到
  useEffect(fn) {
    effectRuns.push('useEffect');
    const cleanup = fn();
    if (typeof cleanup === 'function') effectCleanups.push(cleanup);
  },
  useLayoutEffect(fn) {
    effectRuns.push('useLayoutEffect');
    const cleanup = fn();
    if (typeof cleanup === 'function') effectCleanups.push(cleanup);
  },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => (typeof getSnapshot === 'function' ? getSnapshot() : undefined),
  useTransition: () => [false, (fn) => fn?.()],
  useId: () => 'stub-id',
};

/** 记录 fetch 调用，并给面板一份可用的假数据。 */
const fetchCalls = [];
const fakeListPayload = {
  ok: true,
  data: {
    todos: [
      {
        id: 'wt-1', title: '写 README', notes: '', status: 'pending', priority: 'high',
        due: '2026-10-20', project: 'dsh-worktodo', source: 'human',
        createdAt: 1, updatedAt: 1, completedAt: null,
      },
      {
        id: 'wt-2', title: '发 npm', notes: '', status: 'completed', priority: 'normal',
        due: null, project: null, source: 'agent',
        createdAt: 2, updatedAt: 2, completedAt: 2,
      },
    ],
    groups: {
      overdue: [],
      today: [],
      week: [],
      later: [{
        id: 'wt-1', title: '写 README', notes: '', status: 'pending', priority: 'high',
        due: '2026-10-20', project: 'dsh-worktodo', source: 'human',
        createdAt: 1, updatedAt: 1, completedAt: null,
      }],
      completed: [{
        id: 'wt-2', title: '发 npm', notes: '', status: 'completed', priority: 'normal',
        due: null, project: null, source: 'agent',
        createdAt: 2, updatedAt: 2, completedAt: 2,
      }],
    },
    stats: { total: 2, open: 1, overdue: 0, today: 0, doing: 0, completed: 1, completedToday: 1 },
    today: '2026-10-14',
    store: { kind: 'domain', location: 'storage:worktodo/todos' },
    projects: ['dsh-worktodo'],
  },
};

/**
 * fetch 替身：记录调用并回一份合法响应。
 * @param {string} url
 * @param {object} [options]
 */
function fakeFetch(url, options) {
  fetchCalls.push({ url: String(url), options });
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(fakeListPayload),
    text: () => Promise.resolve(JSON.stringify(fakeListPayload)),
  });
}

// 组件可能调全局 fetch，也可能调 window.fetch：两处都装上替身
globalThis.fetch = fakeFetch;
globalThis.window.fetch = fakeFetch;

/** require 替身：只放行 react 系列，其它一律失败（见文件头说明）。 */
const requiredModules = [];
const requireStub = (name) => {
  requiredModules.push(name);
  if (name === 'react') return stubReact;
  if (name === 'react/jsx-runtime') {
    return {
      jsx: (type, props) => stubReact.createElement(type, props),
      jsxs: (type, props) => stubReact.createElement(type, props),
      Fragment: stubReact.Fragment,
    };
  }
  throw new Error(`客户端 bundle 不允许 require「${name}」——官方规范禁止插件依赖 Harness 客户端包`);
};

/* ------------------------------------------------------------------ *
 * 加载与注册
 * ------------------------------------------------------------------ */

console.log('bundle 格式');

test('bundle 会调用 window.__ModuleLoader__.load', () => {
  // eslint-disable-next-line no-new-func
  new Function(code)();
  if (!captured) throw new Error('没有调用 load');
});

test('注册 id 等于包名（loader 用它匹配 dsh.client）', () => {
  eq(captured.id, pkg.name);
  eq(typeof captured.factory, 'function');
});

const mod = captured.factory(requireStub);

test('factory 返回可用的插件体', () => {
  eq(typeof mod.apply, 'function', 'apply 必须是函数：');
  eq(mod.inject, ['slots', 'locale']);
});

test('bundle 只 require react（没有偷偷依赖 Harness 客户端包）', () => {
  const unexpected = requiredModules.filter((name) => name !== 'react' && name !== 'react/jsx-runtime');
  eq(unexpected, []);
});

test('bundle 是这个 src/client 的产物（改了 src 忘了 build 必须红，复审 R3）', () => {
  // `verify-all.mjs` 会先 build，所以正常路径下这里必然相等；
  // 但直接跑 `node tools/smoke-client.mjs`（或 build 失败被忽略）时，这条断言会立刻抓出
  // 「浏览器里跑的其实是旧 bundle」——那是审计里最危险的假绿状态。
  const map = JSON.parse(readFileSync(join(here, '..', 'lib', 'client.js.map'), 'utf8'));
  const names = ['src/client/index.js', 'src/parse-due.mjs'];
  eq(Array.isArray(map.sourcesContent), true, 'bundle 必须带 sourcesContent（构建配置的一部分）：');
  for (const name of names) {
    const index = map.sources.findIndex((source) => source.replace(/\\/g, '/').endsWith(name));
    eq(index >= 0, true, `sourcemap 里缺 ${name}：`);
    eq(map.sourcesContent[index], readFileSync(join(here, '..', name), 'utf8'),
      `${name} 与 bundle 里的副本不一致 —— 请重新构建（node tools/build-client.mjs）：`);
  }
});

console.log('slot 注册');

const registrations = [];
const localeRegistrations = [];
const effects = [];
const ctx = {
  slots: {
    inject(key, callback) {
      registrations.push({ kind: 'inject', key });
      callback();
      return () => {};
    },
    register(spec, component) {
      registrations.push({ kind: 'register', spec, component });
      return () => {};
    },
  },
  locale: {
    register(namespace, dictionaries) {
      localeRegistrations.push({ namespace, dictionaries });
      return () => {};
    },
  },
  effect(callback, label) {
    const dispose = callback();
    effects.push({ label, dispose });
    return { dispose() {} };
  },
};

mod.apply(ctx);

const registered = registrations.filter((r) => r.kind === 'register');
const sidebar = registered.find((r) => r.spec.name === 'sidebar.panellist');
const main = registered.find((r) => r.spec.name === 'main');

test('侧栏入口与主面板各注册一次', () => {
  eq(registered.length, 2, '注册数量：');
  eq(Boolean(sidebar), true, '缺 sidebar.panellist：');
  eq(Boolean(main), true, '缺 main：');
});

test('侧栏 id 与主面板 key 同名（否则点侧栏打不开面板）', () => {
  eq(sidebar.spec.id, 'worktodo');
  eq(main.spec.key, 'worktodo');
  eq(sidebar.spec.id, main.spec.key);
});

test('侧栏入口有 order 与 label，locale 命名空间一致', () => {
  eq(typeof sidebar.spec.order, 'number');
  eq(typeof sidebar.spec.label, 'function');
  eq(sidebar.spec.locale, 'worktodo');
  eq(main.spec.locale, 'worktodo');
});

test('locale 字典 zh/en 都注册且键一一对应', () => {
  eq(localeRegistrations.length, 1, '字典注册次数：');
  const { namespace, dictionaries } = localeRegistrations[0];
  eq(namespace, 'worktodo');
  const zhKeys = Object.keys(dictionaries.zh ?? {}).sort();
  const enKeys = Object.keys(dictionaries.en ?? {}).sort();
  eq(zhKeys.length > 0, true, '中文文案不能为空：');
  eq(zhKeys, enKeys, 'zh/en 键必须完全对应：');
});

test('字典注册挂在 effect 上（卸载时会回收）', () => {
  eq(effects.length >= 1, true);
  eq(effects.every((e) => typeof e.dispose === 'function' || e.dispose === undefined), true);
});

console.log('首屏渲染（白屏是这里唯一不可接受的失败）');

test('主面板首屏渲染不抛异常', () => {
  rendered.length = 0;
  const tree = main.component({});
  if (!tree) throw new Error('渲染返回了空值');
  eq(rendered.length > 0, true, '应该创建出元素：');
});

test('主面板在没有 props（没有 useProjection）时也能渲染', () => {
  main.component({ useProjection: undefined });
  main.component({});
});

test('主面板对 useProjection 返回空值时安全', () => {
  // 会话没有 todos 时必须只是隐藏「提升」入口，而不是崩
  main.component({ useProjection: () => null });
  main.component({ useProjection: () => [] });
});

test('侧栏图标渲染不抛异常（active 与非 active）', () => {
  const render = typeof sidebar.component === 'function' ? sidebar.component : null;
  eq(Boolean(render), true, '侧栏入口必须是可渲染函数：');
  render({ size: 16, active: true });
  render({ size: 16, active: false });
  render({});
});

test('渲染后确实去拉了 /worktodo/list', () => {
  eq(fetchCalls.length > 0, true, '首屏应该发起一次列表请求：');
  eq(fetchCalls.some((c) => c.url.includes('/worktodo/list')), true, '请求路径：');
});

console.log('静默数据变形回归（审计 F5 / F6 / F7）');

test('编辑草稿原样保留 priority:none，且下拉里有「无」这一档（审计 F6）', () => {
  // 原来 beginEdit 用 `|| 'normal'` 兜底、下拉里又没有 none：
  // 「打开编辑器 → 什么都不改 → 保存」就会把这条的优先级永久改成普通
  eq(Array.isArray(mod.EDIT_PRIORITY_OPTIONS), true, '应当导出编辑表单的优先级档位：');
  eq(mod.EDIT_PRIORITY_OPTIONS.includes('none'), true, `下拉必须含 none：${JSON.stringify(mod.EDIT_PRIORITY_OPTIONS)}`);
  eq(mod.buildEditDraft({ id: 'x', title: 't', priority: 'none' }).priority, 'none', '打开编辑器不能把 none 改成 normal：');
  eq(mod.buildEditDraft({ priority: 'high' }).priority, 'high');
  eq(mod.buildEditDraft({ priority: 'low' }).priority, 'low');
  eq(mod.buildEditDraft({}).priority, 'normal', '只有缺省/非法值才回退 normal：');
});

test('面板注册了自动刷新定时器，间隔 30s（审计 F7 / 复审 R4）', () => {
  eq(intervals.length > 0, true, '面板必须注册自动刷新定时器：');
  // 找出「触发时会请求刷新（setTick）」的那一个，而不是只看定时器数量
  let poll = null;
  for (const handle of [...intervals].reverse()) {
    const before = stateUpdates.length;
    handle.fn();
    if (stateUpdates.length > before) { poll = handle; break; }
  }
  eq(Boolean(poll), true, '定时器触发时必须真的请求刷新（走 refresh）：');
  // 复审 R4：轮询放宽到 30 秒（每次轮询都是一次全量 load），不能又变回 10 秒
  eq(mod.CHANGE_POLL_MS, 30000, '轮询间隔必须放宽到 30 秒：');
  eq(poll.ms, mod.CHANGE_POLL_MS, '定时器要真的按这个间隔注册：');
});

test('窗口重新聚焦 / 重新可见时会立刻刷新（复审 R4：轮询放宽后的新鲜度靠这条路）', () => {
  const focus = [...(windowListeners.get('focus') ?? [])];
  eq(focus.length > 0, true, '面板必须监听窗口 focus：');
  const before = stateUpdates.length;
  for (const handler of focus) handler();
  eq(stateUpdates.length > before, true, '窗口重新聚焦时必须请求刷新：');
  const visible = [...(documentListeners.get('visibilitychange') ?? [])];
  eq(visible.length > 0, true, '面板必须监听 visibilitychange：');
  const beforeVisible = stateUpdates.length;
  for (const handler of visible) handler();
  eq(stateUpdates.length > beforeVisible, true, '重新可见时必须请求刷新：');
});

test('数据不一致告警必须在面板上渲染出来，不能只躺在 /health 的 JSON 里（复审 R4/R5）', () => {
  // describe() 的告警 → 面板页脚的真文字
  eq(typeof mod.storeAlerts, 'function', '面板应当导出告警整理函数：');
  const t = (key) => (key === 'storeMergeNote'
    ? '已按 id 合并两处数据：{merged} 条（同 id 冲突 {conflicts}，补入 {added}）'
    : key);
  const clean = mod.storeAlerts({ kind: 'domain', location: 'storage:worktodo/todos', mismatch: null, split: null, merge: null }, t);
  eq(clean, [], '一切正常时不该有告警：');
  const alerts = mod.storeAlerts({
    kind: 'file',
    location: '/tmp/todos.json',
    mismatch: '首选官方 storage 但打开失败：already open',
    split: '官方 6 条 / 文件 4 条（两处 id 不完全一致）',
    backendError: '当前后端（domain）读取失败：boom；回退文件已在升级时退役',
    retired: { movedTo: '/tmp/todos.json.migrated-20261013-193439' },
    merge: { merged: 3, conflicts: 1, added: 2 },
  }, t);
  const keys = alerts.map((a) => a.key);
  eq(keys, ['mismatch', 'split', 'backendError', 'retired', 'merge'], `五条告警都要在：${JSON.stringify(keys)}`);
  eq(alerts.filter((a) => a.tone === 'warn').length, 3, 'mismatch/split/backendError 是警告级：');
  eq(alerts.some((a) => a.text.includes('already open')), true, '告警要带上原始原因：');
  const mergeText = alerts.find((a) => a.key === 'merge').text;
  eq(mergeText.includes('3 条') && mergeText.includes('冲突 1') && mergeText.includes('补入 2'), true, `合并报告要填上占位符：${mergeText}`);
  eq(mergeText.includes('{merged}'), false, '占位符不能原样显示给用户：');
  // 只有 retired 也必须能报出来（用户在面板上看得见「数据被搬去哪了」）
  eq(mod.storeAlerts({ retired: { path: '/tmp/todos.json' } }, t).some((a) => a.text.includes('/tmp/todos.json')), true);
});

test('卸载时清掉定时器与窗口监听（审计 F7：面板切走后不能一直打宿主）', () => {
  // 清理函数（挂在 useEffect 上）必须清掉定时器
  for (const cleanup of [...effectCleanups]) {
    try {
      cleanup();
    } catch { /* 单个清理失败不影响结论 */ }
  }
  eq(intervals.every((handle) => clearedIntervals.includes(handle)), true, '卸载时必须 clearInterval：');
  eq([...windowListeners.values()].every((set) => set.size === 0), true, '卸载时必须移除窗口监听：');
  eq([...documentListeners.values()].every((set) => set.size === 0), true, '卸载时必须移除 visibilitychange 监听：');
});

await testAsync('真渲染一次带告警的面板：页脚里确实出现了告警节点（复审 R4/R5，不只是有个函数）', async () => {
  // 首屏 fetch 是异步的：等它落地，`lastList` 才有数据，下一次渲染才是「ready」态
  await new Promise((resolve) => setTimeout(resolve, 0));
  const store = fakeListPayload.data.store;
  store.mismatch = '首选官方 storage 但打开失败：already open';
  store.split = '官方 2 条 / 文件 1 条（两处 id 不完全一致）';
  store.retired = { movedTo: '/tmp/todos.json.migrated-20261013-193439' };
  store.merge = { merged: 3, conflicts: 1, added: 2 };
  const tree = main.component({});
  const nodes = flattenTree(tree);
  const warns = nodes.filter((n) => String(n.props?.className ?? '').includes('wt-store-alert-warn'));
  eq(warns.length, 2, `mismatch 与 split 必须各渲染一行告警：${warns.length}`);
  const allText = nodes.map(textOf).join('\n');
  eq(allText.includes('already open'), true, '页脚要显示不一致的原始原因：');
  eq(allText.includes('.migrated-'), true, '页脚要显示退役文件路径（数据被搬去哪了）：');
  eq(allText.includes('{merged}'), false, '页脚不能出现未替换的占位符：');
});

console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error?.stack ?? f.error}`);
  process.exit(1);
}
