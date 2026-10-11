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

/* ------------------------------------------------------------------ *
 * 模拟外壳：window.__ModuleLoader__ + 基座模块表
 * ------------------------------------------------------------------ */

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(entry) { captured = entry; },
  },
};

/** 记录组件树里出现过的元素类型，方便断言「渲染确实发生了」。 */
const rendered = [];

/** 首屏渲染时真正执行的 effect 数量（React 里首次数据请求通常在 useEffect 里发起）。 */
const effectRuns = [];
/** effect 返回的清理函数，收起来验证面板确实做了回收。 */
const effectCleanups = [];

/** 极简 React 替身：让首屏渲染与首次请求真的跑起来，但不做重渲染。 */
const stubReact = {
  createElement(type, props, ...children) {
    rendered.push(typeof type === 'string' ? type : (type?.name ?? 'component'));
    return { type, props: props ?? {}, children };
  },
  Fragment: 'Fragment',
  memo: (c) => c,
  forwardRef: (c) => c,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useReducer: (reducer, init) => [typeof init === 'function' ? init() : init, () => {}],
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

console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error?.stack ?? f.error}`);
  process.exit(1);
}
