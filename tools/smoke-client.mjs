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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

/**
 * 严格同一性断言。`eq` 走 JSON.stringify，对函数会双双变成 undefined —— 用它比较组件
 * 类型等于没比，所以「注册处包的确实是这个边界类」必须走这里。
 */
function same(actual, expected, hint = '') {
  if (actual !== expected) {
    const name = (value) => (typeof value === 'function' ? (value.name || 'anonymous') : String(value));
    throw new Error(`${hint}期望 ${name(expected)}，实际 ${name(actual)}`);
  }
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

/**
 * 用 `React.memo` 包过的组件类型（替身 memo 会把它们登记在这里）。
 *
 * S3-3 的「行组件在父级重渲染时不重渲染」要能真的量出来，所以替身 memo 必须
 * 复刻真 React 的两件事：**浅比较 props**、**跳过整个子树**。
 * 缓存的粒度是「元素在树里的位置」（真 React 是按 fiber，位置/key 决定身份）。
 */
const memoizedTypes = [];

/**
 * 打开后 useState/useCallback/useMemo 按「同一位置的同一个组件」跨渲染保留
 *（= 真 React 的实例级状态）。默认关闭：既有用例依赖「每次 render 都是一次全新挂载」。
 */
let stableHooks = false;
/** 关掉 memo 的浅比较 = **改前**的行为（只用于量「改前/改后」的渲染次数）。 */
const memoBailoutOff = process.env.WORKTODO_TEST_MEMO === 'off';
const hookCache = new Map();
const memoStores = new Map();
let hookPath = 'root';
let hookIndex = 0;

/** 当前 hook 调用点的稳定 id（路径 + 组件内序号）。 */
function hookSlotId() {
  return `${hookPath}#${hookIndex++}`;
}

/** 真 React 的浅比较（`React.memo` 默认的比较函数）。 */
function shallowEqualProps(a, b) {
  const left = a ?? {};
  const right = b ?? {};
  const ka = Object.keys(left);
  const kb = Object.keys(right);
  if (ka.length !== kb.length) return false;
  return ka.every((key) => Object.is(left[key], right[key]));
}

/** 首屏渲染时真正执行的 effect 数量（React 里首次数据请求通常在 useEffect 里发起）。 */
const effectRuns = [];
/** effect 返回的清理函数，收起来验证面板确实做了回收。 */
const effectCleanups = [];
/** 组件请求过的状态更新：`{slot, next}`，slot 用于区分「刷新 tick」与其他 setState。 */
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

/** 类组件的基类替身：错误边界要 `extends React.Component` 并调 setState。 */
class StubComponent {
  constructor(props) {
    this.props = props ?? {};
    this.state = {};
    this.context = {};
  }

  setState(patch) {
    const next = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...(this.state ?? {}), ...(next ?? {}) };
  }

  forceUpdate() {}
}

/** 极简 React 替身：让首屏渲染与首次请求真的跑起来；memo/浅比较由迷你渲染器实现。 */
const stubReact = {
  createElement(type, props, ...children) {
    rendered.push(typeof type === 'string' ? type : (type?.name ?? 'component'));
    // 与 React 对齐：children 同时进 props.children（错误边界读 this.props.children）
    const merged = { ...(props ?? {}) };
    if (children.length) merged.children = children.length === 1 ? children[0] : children;
    return { type, props: merged, children };
  },
  Component: StubComponent,
  Fragment: 'Fragment',
  /**
   * memo 替身：真 React 的语义在迷你渲染器里实现（按位置浅比较 + 跳过子树）。
   * 这里只登记元数据，供测试量「body 真的跑了几次 / 跳过几次」。
   */
  memo: (component, compare) => {
    const wrapped = function MemoWrapper(props) { return component(props); };
    wrapped.__isMemo = true;
    wrapped.__memoComponent = component;
    wrapped.__memoCompare = compare;
    wrapped.__meta = { renders: 0, bailouts: 0, lastNode: null };
    memoizedTypes.push(wrapped);
    return wrapped;
  },
  forwardRef: (c) => c,
  useState: (init) => {
    const id = hookSlotId();
    if (stableHooks) {
      if (!hookCache.has(id)) hookCache.set(id, { value: typeof init === 'function' ? init() : init });
      const slot = hookCache.get(id);
      return [slot.value, (next) => {
        stateUpdates.push({ slot: id, next });
        slot.value = typeof next === 'function' ? next(slot.value) : next;
      }];
    }
    return [typeof init === 'function' ? init() : init, (next) => { stateUpdates.push({ slot: id, next }); }];
  },
  useReducer: (reducer, init) => {
    const id = hookSlotId();
    return [typeof init === 'function' ? init() : init, (next) => { stateUpdates.push({ slot: id, next }); }];
  },
  // 真的执行 effect：否则「组件挂载后去拉列表」这条最关键的路径根本不会被测到
  useEffect(fn) {
    hookSlotId();
    effectRuns.push('useEffect');
    const cleanup = fn();
    if (typeof cleanup === 'function') effectCleanups.push(cleanup);
  },
  useLayoutEffect(fn) {
    hookSlotId();
    effectRuns.push('useLayoutEffect');
    const cleanup = fn();
    if (typeof cleanup === 'function') effectCleanups.push(cleanup);
  },
  useMemo: (fn) => {
    const id = hookSlotId();
    if (!stableHooks) return fn();
    if (!hookCache.has(id)) hookCache.set(id, { value: fn() });
    return hookCache.get(id).value;
  },
  useCallback: (fn) => {
    const id = hookSlotId();
    if (!stableHooks) return fn;
    if (!hookCache.has(id)) hookCache.set(id, { value: fn });
    return hookCache.get(id).value;
  },
  useRef: (value) => { hookSlotId(); return { current: value }; },
  useSyncExternalStore: (_subscribe, getSnapshot) => (typeof getSnapshot === 'function' ? getSnapshot() : undefined),
  useTransition: () => [false, (fn) => fn?.()],
  useId: () => 'stub-id',
};

/** 开一段「同一实例被反复渲染」的窗口：状态/回调/memo 缓存按位置保留，计数从 0 起。 */
function withStableHooks(run) {
  resetStableWindow();
  stableHooks = true;
  try {
    return run();
  } finally {
    stableHooks = false;
  }
}

/**
 * 异步版：写操作要等 fetch/微任务落地才能看到 setState/定时器，
 * 而同步版会在第一个 await 处就把 stableHooks 关掉。
 */
async function withStableHooksAsync(run) {
  resetStableWindow();
  stableHooks = true;
  try {
    return await run();
  } finally {
    stableHooks = false;
  }
}

/** 清掉上一条用例留下的 hook/memo 缓存（窗口之间互不串味）。 */
function resetStableWindow() {
  hookCache.clear();
  memoStores.clear();
  for (const type of memoizedTypes) {
    type.__meta.renders = 0;
    type.__meta.bailouts = 0;
    type.__meta.lastNode = null;
  }
}

/* ------------------------------------------------------------------ *
 * 迷你渲染器
 *
 * 替身 React 只做 createElement：以前测试靠**直接调用**函数组件来渲染。
 * 但错误边界的前提是「父组件在渲染期捕获子组件抛错」，这件事只有真的把树渲染
 * 一遍才验证得了，所以这里补一个最小渲染器：函数组件直接调用；类组件 new 出来
 * 调 render；子渲染抛错时按 React 的语义走 getDerivedStateFromError →
 * componentDidCatch → 用兜底 UI 重渲染。它只服务测试，不进 bundle。
 * ------------------------------------------------------------------ */
function renderInstance(instance, path = 'root') {
  const type = instance.constructor;
  try {
    return renderNode(instance.render(), path);
  } catch (error) {
    if (typeof type.getDerivedStateFromError !== 'function') throw error;
    instance.state = { ...(instance.state ?? {}), ...(type.getDerivedStateFromError(error) ?? {}) };
    if (typeof instance.componentDidCatch === 'function') {
      instance.componentDidCatch(error, { componentStack: 'stub-component-stack' });
    }
    return renderNode(instance.render(), path);
  }
}

/**
 * 迷你渲染器。
 *
 * `path` 是元素在树里的位置（`root>0>2` 这样），它替代真 React 的 fiber：
 *   - memo 的缓存与「props 浅比较后跳过整个子树」按位置生效；
 *   - hook 的稳定 id 也是「位置 + 组件内序号」，供 useCallback/useMemo/useState 的稳定模式用。
 * 字符串/number 子节点不参与路径（它们不可能是组件）。
 */
function renderNode(node, path = 'root') {
  if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${path}>${index}`));
  if (!node || typeof node !== 'object') return node;
  const type = node.type;
  const props = node.props ?? {};
  if (typeof type === 'function') {
    const isClass = Boolean(type.prototype && typeof type.prototype.render === 'function');
    if (isClass) return renderInstance(new type(props), path);
    if (type.__isMemo) {
      const store = memoStores.get(path);
      const compare = type.__memoCompare ?? shallowEqualProps;
      const canBail = Boolean(store) && !memoBailoutOff && compare(store.props, props);
      if (canBail) {
        // 真 React 语义：props 浅相等 → 连子树一起跳过（下面的子组件不会再跑一次）
        type.__meta.bailouts += 1;
        return store.rendered;
      }
      type.__meta.renders += 1;
      hookPath = path;
      hookIndex = 0;
      const produced = type.__memoComponent(props);
      type.__meta.lastNode = produced;
      const renderedNode = renderNode(produced, path);
      memoStores.set(path, { props, rendered: renderedNode });
      return renderedNode;
    }
    hookPath = path;
    hookIndex = 0;
    return renderNode(type(props), path);
  }
  // 宿主元素 / Fragment：继续往下渲染子节点（子级里的组件元素也要真的渲染出来）
  const children = Array.isArray(node.children)
    ? node.children.map((child, index) => renderNode(child, `${path}>${index}`))
    : renderNode(node.children, `${path}>c`);
  return { ...node, children };
}

/**
 * 渲染一个注册入口。注册处返回的是「错误边界包住的面板」，渲染后拿到的
 * 仍然是原来那棵面板 DOM 树 —— 后面的断言与以前完全一致。
 *
 * 关键：兜底 UI 一旦出现就说明成功路径其实崩了。错误边界在生产环境负责「不白屏」，
 * 但绝不能把烟测也一起兜绿，所以这里直接抛错（反向验证正是靠它 + same() 变红）。
 * @param {Function} component 注册处给 slot 的组件
 */
function renderRegistered(component, props = {}) {
  const tree = renderNode(component(props));
  const nodes = flattenTree(tree);
  if (nodes.some((n) => String(n.props?.className ?? '').includes('wt-crash'))) {
    throw new Error(`注册组件渲染时抛错（已被错误边界兜住）：${nodes.map(textOf).join(' ').slice(0, 200)}`);
  }
  return tree;
}

/** 渲染主面板（= 错误边界 + WorkTodoPanel）。 */
function renderPanel(props = {}) {
  return renderRegistered(main.component, props);
}

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
    // 「按项目」视图的形状：面板切成按项目时会用 shapes=projectGroups 单独取它
    projectGroups: [
      {
        project: 'dsh-worktodo', key: 'dsh-worktodo', total: 1, open: 1, overdue: 0,
        todos: [{
          id: 'wt-1', title: '写 README', notes: '', status: 'pending', priority: 'high',
          due: '2026-10-20', project: 'dsh-worktodo', source: 'human',
          createdAt: 1, updatedAt: 1, completedAt: null,
        }],
      },
    ],
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

test('bundle 是这个 src 的产物（改了 src 忘了 build 必须红，复审 R3）', () => {
  // `verify-all.mjs` 会先 build，所以正常路径下这里必然相等；
  // 但直接跑 `node tools/smoke-client.mjs`（或 build 失败被忽略）时，这条断言会立刻抓出
  // 「浏览器里跑的其实是旧 bundle」——那是审计里最危险的假绿状态。
  //
  // 复审 0.2.2 F6：**不能只比对两个写死的文件**。新增 `src/client/helper.js` 后只改它、
  // 不 build，写死名单照样全绿，而浏览器里跑的是旧代码。这里改成遍历 sourcemap 里的
  // **全部 `src/**` 源文件**（bundle 里有两个以上源文件，源都在 src 下），逐一比对，
  // 并反向检查「src/client 下的文件都在 bundle 里」。
  const root = join(here, '..');
  const map = JSON.parse(readFileSync(join(root, 'lib', 'client.js.map'), 'utf8'));
  eq(Array.isArray(map.sourcesContent), true, 'bundle 必须带 sourcesContent（构建配置的一部分）：');
  eq(map.sources.length, map.sourcesContent.length, 'sources 与 sourcesContent 长度必须一致：');

  const sourceFiles = [];
  map.sources.forEach((source, index) => {
    const normalized = String(source).replace(/\\/g, '/');
    const match = normalized.match(/(?:^|\/)(src\/.+)$/);
    if (!match) return;
    sourceFiles.push({ index, rel: match[1] });
  });
  eq(sourceFiles.length >= 2, true, `sourcemap 里应当包含多个 src 源文件，实际 ${sourceFiles.length} 个：`);

  for (const { index, rel } of sourceFiles) {
    const abs = join(root, rel);
    eq(existsSync(abs), true, `sourcemap 指向的源文件不存在 ${rel}：`);
    eq(map.sourcesContent[index], readFileSync(abs, 'utf8'),
      `${rel} 与 bundle 里的副本不一致 —— 请重新构建（node tools/build-client.mjs）：`);
  }

  // 反向：src/client 下的每个源文件都必须出现在 bundle 里（新增文件没 import 也要能发现）
  for (const name of readdirSync(join(root, 'src', 'client'))) {
    if (!name.endsWith('.js')) continue;
    const rel = `src/client/${name}`;
    eq(sourceFiles.some((entry) => entry.rel === rel), true, `${rel} 没有被打进 bundle：`);
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
  // 注册处现在多包了一层错误边界，这里真的渲染一遍（成功路径的产物不变）
  const tree = renderPanel({});
  if (!tree) throw new Error('渲染返回了空值');
  eq(rendered.length > 0, true, '应该创建出元素：');
});

test('主面板在没有 props（没有 useProjection）时也能渲染', () => {
  renderPanel({ useProjection: undefined });
  renderPanel({});
});

test('主面板对 useProjection 返回空值时安全', () => {
  // 会话没有 todos 时必须只是隐藏「提升」入口，而不是崩
  renderPanel({ useProjection: () => null });
  renderPanel({ useProjection: () => [] });
});

test('侧栏图标渲染不抛异常（active 与非 active）', () => {
  const render = typeof sidebar.component === 'function' ? sidebar.component : null;
  eq(Boolean(render), true, '侧栏入口必须是可渲染函数：');
  renderRegistered(render, { size: 16, active: true });
  renderRegistered(render, { size: 16, active: false });
  renderRegistered(render, {});
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
  eq(keys, ['mismatch', 'split', 'backendError', 'retired', 'retiredUnavailable', 'merge'],
    `六条告警都要在：${JSON.stringify(keys)}`);
  eq(alerts.filter((a) => a.tone === 'warn').length, 4, 'mismatch/split/backendError/退役+存储不可用 是警告级：');
  eq(alerts.some((a) => a.text.includes('already open')), true, '告警要带上原始原因：');
  const mergeText = alerts.find((a) => a.key === 'merge').text;
  eq(mergeText.includes('3 条') && mergeText.includes('冲突 1') && mergeText.includes('补入 2'), true, `合并报告要填上占位符：${mergeText}`);
  eq(mergeText.includes('{merged}'), false, '占位符不能原样显示给用户：');
  // 只有 retired、且官方存储仍在（kind=domain）→ 信息性一行，不报「不可用」
  const healthyRetired = mod.storeAlerts({ kind: 'domain', retired: { path: '/tmp/todos.json' } }, t);
  eq(healthyRetired.length, 0, '退役但官方存储可用时不该报警（原路径只在 path 字段里，不是展示位置）：');
  // 复审 0.2.2 F1：退役 + 官方存储不可用 → 必须有一条 warn，把退役时间与档案写清楚
  const unavailable = mod.storeAlerts({
    kind: 'file',
    location: '/tmp/todos.json',
    domainUnavailable: true,
    retired: { at: new Date(2026, 9, 13, 22, 6, 27).getTime(), path: '/tmp/todos.json', movedTo: null, error: null },
  }, t);
  eq(unavailable.map((a) => a.key), ['retiredUnavailable']);
  eq(unavailable[0].tone, 'warn', '退役 + 官方存储不可用必须是警告级：');
  eq(unavailable[0].text.includes('storeRetiredUnavailableHint'), true, `文案要带处理建议：${unavailable[0].text}`);
  eq(unavailable[0].text.includes('{when}') || unavailable[0].text.includes('{archive}'), false,
    '占位符必须被替换掉：');
  // 复审 0.2.2 F3：rename 失败必须是「失败 + 原因 + 建议」，绝不能说「已迁移并退役」
  const failed = mod.storeAlerts({
    kind: 'domain',
    retired: { path: '/tmp/todos.json', movedTo: null, error: 'EPERM: operation not permitted, rename' },
  }, t);
  eq(failed.map((a) => a.key), ['retiredFailed']);
  eq(failed[0].tone, 'warn', '退役失败必须是警告级：');
  eq(failed[0].text.includes('EPERM'), true, `原始错误不能丢：${failed[0].text}`);
  eq(failed[0].text.includes('storeRetiredFailedHint'), true, '要给出「文件仍在，请手动改名或删除」的建议：');
  eq(failed.some((a) => a.key === 'retired'), false, '失败时绝不能再说「已迁移并退役」：');
  // 合并被中止（已回滚）也要有 warn
  const aborted = mod.storeAlerts({ kind: 'file', merge: { merged: 0, aborted: true, writeError: 'wt-b：disk full' } }, t);
  eq(aborted.map((a) => a.key), ['mergeAborted']);
  eq(aborted[0].tone, 'warn', '半截合并被中止必须是警告级：');
  eq(aborted[0].text.includes('disk full'), true, '中止原因要显示出来：');
});

test('页脚存储位置：已退役时不得把不存在的回退文件当存储位置（复审 0.2.2 F1/F3）', () => {
  eq(typeof mod.storeLocationLabel, 'function', '面板应当导出存储位置文案函数：');
  const t = (key) => key;
  // 正常：官方 storage
  const domain = mod.storeLocationLabel({ kind: 'domain', location: 'storage:worktodo/todos' }, t);
  eq(domain.includes('storage:worktodo/todos'), true, `官方后端要显示位置：${domain}`);
  // 正常：JSON 文件
  const file = mod.storeLocationLabel({ kind: 'file', location: '/tmp/todos.json' }, t);
  eq(file.includes('/tmp/todos.json'), true, `文件后端要显示位置：${file}`);
  // 已退役 + 官方存储可用：说「数据在官方存储」，把档案当附注，**不**把原路径当存储位置
  const retired = mod.storeLocationLabel({
    kind: 'domain',
    domainUnavailable: false,
    retired: { at: Date.now(), path: '/tmp/todos.json', movedTo: '/tmp/todos.json.migrated-20261013-220627' },
  }, t);
  eq(retired.includes('storeDomain'), true, `要说明数据在官方存储：${retired}`);
  eq(retired.includes('storeUnavailable'), false, '官方存储可用时不能说不可用：');
  eq(retired.includes('/tmp/todos.json.migrated-20261013-220627'), true, `要显示退役档案路径：${retired}`);
  // 已退役 + 官方存储不可用：明确说「不可用」
  const down = mod.storeLocationLabel({
    kind: 'file',
    location: '/tmp/todos.json',
    domainUnavailable: true,
    retired: { at: Date.now(), path: '/tmp/todos.json', movedTo: null, marker: '/tmp/todos.json.retired' },
  }, t);
  eq(down.includes('storeUnavailable'), true, `官方存储不可用必须写出来：${down}`);
  eq(down.includes('/tmp/todos.json.retired'), true, `要给出确认存在的哨兵路径：${down}`);
  // 退役失败（没有 movedTo / marker）时，不能把原路径当存储位置显示
  const failedLabel = mod.storeLocationLabel({
    kind: 'domain',
    location: '/tmp/todos.json',
    domainUnavailable: false,
    retired: { at: Date.now(), path: '/tmp/todos.json', movedTo: null, error: 'EPERM' },
  }, t);
  eq(failedLabel.includes('/tmp/todos.json'), false, `退役失败时不能把原路径当存储位置：${failedLabel}`);
  // 什么都没有时返回 null（不渲染这一行）
  eq(mod.storeLocationLabel({ kind: 'domain', location: null }, t), null);
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
  const tree = renderPanel();
  const nodes = flattenTree(tree);
  const warns = nodes.filter((n) => String(n.props?.className ?? '').includes('wt-store-alert-warn'));
  eq(warns.length, 2, `mismatch 与 split 必须各渲染一行告警：${warns.length}`);
  const allText = nodes.map(textOf).join('\n');
  eq(allText.includes('already open'), true, '页脚要显示不一致的原始原因：');
  eq(allText.includes('.migrated-'), true, '页脚要显示退役文件路径（数据被搬去哪了）：');
  eq(allText.includes('{merged}'), false, '页脚不能出现未替换的占位符：');
});

await testAsync('退役 + 官方存储不可用：面板页脚必须渲染出警告与「数据在官方存储」（复审 0.2.2 F1）', async () => {
  const store = fakeListPayload.data.store;
  // 模拟宿主 describe()：回退文件已退役，官方存储不可用，列表为空
  store.kind = 'file';
  store.location = '/tmp/wt-local/worktodo/todos.json';
  store.domainUnavailable = true;
  store.mismatch = '官方存储不可用，且回退文件已于 2026-10-13T14:06:27.000Z 退役';
  store.split = null;
  store.backendError = '当前后端（file）读取失败：官方存储不可用';
  store.retired = {
    at: new Date(2026, 9, 13, 22, 6, 27).getTime(),
    path: '/tmp/wt-local/worktodo/todos.json',
    movedTo: null,
    marker: '/tmp/wt-local/worktodo/todos.json.retired',
    error: null,
  };
  store.merge = null;
  const tree = renderPanel();
  const nodes = flattenTree(tree);
  const warns = nodes.filter((n) => String(n.props?.className ?? '').includes('wt-store-alert-warn'));
  eq(warns.length >= 2, true, `mismatch/backendError 与「退役 + 存储不可用」都要有 warn：${warns.length}`);
  const allText = nodes.map(textOf).join('\n');
  eq(allText.includes('官方存储不可用，且回退文件已退役'), true, `页脚必须出现「退役 + 官方存储不可用」告警：${allText}`);
  eq(allText.includes('不可用'), true, '页脚存储位置要写「官方 storage · 不可用」：');
  eq(allText.includes('/tmp/wt-local/worktodo/todos.json '), false,
    '页脚不能把不存在的回退文件当存储位置：');
  eq(allText.includes('/tmp/wt-local/worktodo/todos.json.retired'), true, '页脚要给出退役哨兵/档案路径：');
  // 收尾：恢复 fixture，避免影响别的用例
  store.kind = 'domain';
  store.location = 'storage:worktodo/todos';
  store.domainUnavailable = false;
  store.mismatch = null;
  store.backendError = null;
  store.retired = null;
  store.split = null;
});

console.log('错误边界（渲染抛错不能再整块白屏）');

test('主面板与侧栏入口都注册在错误边界里（摘掉边界这条必红）', () => {
  same(typeof mod.WorkTodoErrorBoundary, 'function', '应当导出错误边界类组件：');
  const panelEntry = main.component({});
  same(panelEntry?.type, mod.WorkTodoErrorBoundary, '主面板注册处必须被错误边界包住：');
  same(typeof panelEntry?.props?.children?.type, 'function', '边界里包的应当是可渲染的面板组件：');
  const sidebarEntry = sidebar.component({ size: 16, active: true });
  same(sidebarEntry?.type, mod.WorkTodoErrorBoundary, '侧栏入口注册处必须被错误边界包住：');
});

test('边界捕获子组件抛错：中文兜底 + error.message 摘要，且堆栈绝不进 DOM', () => {
  // 构造一个「渲染必定抛错」的子组件，塞进注册处同一个位置的错误边界里
  let explode = true;
  function ExplodingPanelChild() {
    if (explode) {
      const boom = new Error('子组件渲染时抛错（测试用消息）');
      boom.name = 'ExplodingPanelChildError';
      throw boom;
    }
    return stubReact.createElement('div', { className: 'wt-recovered' }, '恢复成功');
  }

  const logged = [];
  const originalError = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    const entry = main.component({});
    same(entry?.type, mod.WorkTodoErrorBoundary, '注册处必须被错误边界包住：');
    const boundary = new mod.WorkTodoErrorBoundary({
      ...entry.props,
      children: stubReact.createElement(ExplodingPanelChild),
    });

    // --- 捕获后：显示中文兜底 ---
    const fallbackTree = renderInstance(boundary);
    const fallbackText = flattenTree(fallbackTree).map(textOf).join('\n');
    eq(fallbackText.includes('出错了'), true, `兜底文案必须含「出错了」：${fallbackText}`);
    eq(fallbackText.includes('子组件渲染时抛错'), true, `必须显示 error.message 摘要：${fallbackText}`);
    // 堆栈只能进 console：DOM 里既没有函数名，也没有堆栈帧
    eq(fallbackText.includes('ExplodingPanelChild'), false, `DOM 里不能出现堆栈里的函数名：${fallbackText}`);
    eq(fallbackText.includes('at '), false, `DOM 里不能出现堆栈帧：${fallbackText}`);
    // 原始 error（含 stack）必须打到 console，不能因为兜底就把 bug 藏起来
    eq(logged.length > 0, true, '必须留下控制台记录：');
    eq(logged.some((args) => args.some((arg) => arg instanceof Error
      && String(arg.stack).includes('ExplodingPanelChild'))), true,
    'componentDidCatch 必须 console.error 原始错误（含完整堆栈）：');

    // --- 点「重试」：清错误 + 换 key → 子树重新挂载 ---
    const retry = flattenTree(fallbackTree).find((n) => n.type === 'button' && textOf(n).includes('重试'));
    eq(Boolean(retry), true, '兜底 UI 必须有「重试」按钮：');
    explode = false;
    retry.props.onClick();
    eq(boundary.state?.error ?? null, null, '重试必须清掉错误状态：');
    eq(boundary.state?.attempt, 1, '重试必须让 attempt +1（key 变化 → 子树重新挂载）：');
    const recoveredText = flattenTree(renderInstance(boundary)).map(textOf).join('\n');
    eq(recoveredText.includes('恢复成功'), true, `重试后必须重新挂载并渲染成功：${recoveredText}`);
    eq(recoveredText.includes('出错了'), false, '重试成功后不能再显示兜底 UI：');
  } finally {
    console.error = originalError;
  }
});

test('边界优先用注入的 t()；拿不到 t 时退回中文 + 一行英文', () => {
  const failed = () => {
    const instance = new mod.WorkTodoErrorBoundary({ t: undefined, children: null });
    instance.state = { error: new Error('boom'), attempt: 0 };
    return flattenTree(renderInstance(instance)).map(textOf).join('\n');
  };
  const zhText = failed();
  eq(zhText.includes('工作待办面板出错了'), true, `拿不到 t 时用中文兜底：${zhText}`);
  eq(zhText.includes('Work to-dos panel crashed'), true, '拿不到 t 时补一行英文：');

  const localized = new mod.WorkTodoErrorBoundary({ t: (key) => `[${key}]`, children: null });
  localized.state = { error: new Error('boom'), attempt: 0 };
  const localizedText = flattenTree(renderInstance(localized)).map(textOf).join('\n');
  eq(localizedText.includes('[panelCrashTitle]'), true, `有 t 时必须走 t() 文案：${localizedText}`);
  eq(localizedText.includes('[retry]'), true, '「重试」按钮文案也要走 t()：');
  eq(localizedText.includes('Work to-dos panel crashed'), false, '有 t 时不该再塞硬编码英文行：');
});

test('错误信息只走文本子节点：bundle 里不存在 innerHTML', () => {
  eq(code.includes('innerHTML'), false, '绝不能把 error.message 拼进 innerHTML：');
});

/* ------------------------------------------------------------------ *
 * S3-3（客户端侧，第四轮审计残留项）
 *
 * 宿主侧上一轮已经支持 `/list?shapes=todos|groups|projectGroups`，但面板**完全没用**：
 * 每次 30 秒轮询都拿三份同样大小的数据（5000 条 = 4.28 MiB/次）。
 * 这里补三件事：按视图只取所需形状、窗口隐藏时停轮询、行组件 memo。
 * ------------------------------------------------------------------ */

console.log('S3-3 客户端：形状收敛 / 隐藏停轮询 / 行组件 memo');

await testAsync('S3-3 客户端：面板按当前视图只请求所需形状（按截止=groups、按项目=projectGroups）', async () => {
  await new Promise((resolve) => setTimeout(resolve, 0)); // 先让此前所有在飞的 fetch 落地，计数才干净

  eq(mod.shapesForView('due'), 'groups');
  eq(mod.shapesForView('project'), 'projectGroups');
  eq(mod.shapesForView('未定义视图'), 'groups', '未知视图必须回落到默认视图的形状：');

  document.visibilityState = 'visible';
  const t = (key) => `[${key}]`;
  const fetchFrom = fetchCalls.length;
  let dueUrl = '';
  let projectUrl = '';
  let projectApplied = false;

  withStableHooks(() => {
    // 第一遍：「按截止」视图
    const tree = renderPanel({ t });
    dueUrl = fetchCalls[fetchCalls.length - 1]?.url ?? '';
    // 点「按项目」：稳定 hook 模式下 setState 会真的改状态，再渲染一次就是切视图后的请求
    const button = flattenTree(tree).find((n) => n.type === 'button' && n.props?.title === '[viewProject]');
    eq(Boolean(button), true, '面板上必须有「按项目」切换按钮：');
    button.props.onClick();
    renderPanel({ t });
    projectUrl = fetchCalls[fetchCalls.length - 1]?.url ?? '';
    projectApplied = true;
  });

  eq(dueUrl.includes('/worktodo/list?filter=all'), true, `列表路径前缀不能变（旧契约）：${dueUrl}`);
  eq(dueUrl.includes('shapes=groups'), true, `「按截止」必须只取 groups：${dueUrl}`);
  eq(/shapes=projectGroups/.test(dueUrl), false, '「按截止」不该顺带取 projectGroups：');
  eq(projectApplied, true);
  eq(projectUrl.includes('shapes=projectGroups'), true, `切到「按项目」必须只取 projectGroups：${projectUrl}`);
  eq(/[?&]shapes=groups(&|$)/.test(projectUrl), false, '「按项目」不该再取 groups：');
  eq(fetchCalls.length - fetchFrom >= 2, true, '两种视图各请求一次：');
  console.log(`      [shapes] 按截止 → ${dueUrl.split('&').pop()} ｜ 按项目 → ${projectUrl.split('&').pop()}`);
});

await test('S3-3 客户端：行组件用 React.memo —— 父级重渲染时 6 行不再整列表重渲染', () => {
  // 让这一组真的有 6 行（原来 later 组只有 1 行，量不出「整列表」的效果）
  const bucket = fakeListPayload.data.groups.later;
  const added = [];
  for (let i = 0; i < 5; i += 1) {
    const row = { ...bucket[0], id: `wt-memo-${i}`, title: `memo 行 ${i}` };
    bucket.push(row);
    added.push(row);
  }

  try {
    document.visibilityState = 'visible';
    const t = (key) => `[${key}]`;
    const report = withStableHooks(() => {
      renderPanel({ t }); // 第一遍：把 6 行渲染出来
      const rowType = memoizedTypes.find((type) => type.__meta.renders > 0
        && flattenTree(type.__meta.lastNode).some((n) => String(n.props?.className ?? '').includes('wt-row')));
      eq(Boolean(rowType), true,
        '面板的列表行必须用 React.memo 包住（否则每次父级重渲染都会 reconcile 整张列表）：');
      const first = { renders: rowType.__meta.renders, bailouts: rowType.__meta.bailouts };
      // 再渲染两次（= 父级因为折叠分组/错误条/计数等与数据无关的原因重渲染）
      renderPanel({ t });
      renderPanel({ t });
      return { first, now: { renders: rowType.__meta.renders, bailouts: rowType.__meta.bailouts } };
    });

    console.log(`      [memo] 6 行 × 3 次父级渲染：行 body 实际渲染 ${report.now.renders} 次`
      + `（第一遍 ${report.first.renders}）、被 memo 跳过 ${report.now.bailouts} 次`);
    eq(report.first.renders >= 6, true, `第一遍必须真的渲染出每一行（实际 ${report.first.renders}）：`);
    eq(report.now.renders, report.first.renders,
      `父级重渲染时行 body 不许再跑（memo 失效会变成 ${report.first.renders * 3} 次）：`);
    eq(report.now.bailouts - report.first.bailouts >= 12, true,
      `两次父级重渲染 × 6 行都要走 memo 跳过：${report.now.bailouts - report.first.bailouts}`);
  } finally {
    for (const row of added) {
      const index = bucket.indexOf(row);
      if (index !== -1) bucket.splice(index, 1);
    }
  }
});

await testAsync('S3-3 客户端：窗口隐藏时停轮询，重新可见时恰好补一次', async () => {
  await new Promise((resolve) => setTimeout(resolve, 0)); // 先让在飞的 fetch 落地，避免污染计数
  document.visibilityState = 'visible';
  const listenersBefore = new Set(documentListeners.get('visibilitychange') ?? []);
  renderPanel({});
  const poll = intervals[intervals.length - 1];
  eq(Boolean(poll), true, '最近一次渲染必须注册轮询定时器：');
  eq(poll.ms, mod.CHANGE_POLL_MS, '轮询间隔仍是 30 秒：');

  // 隐藏 60 秒 = 两个轮询周期：一次宿主都不打
  document.visibilityState = 'hidden';
  const hiddenFrom = stateUpdates.length;
  const fetchFrom = fetchCalls.length;
  poll.fn();
  poll.fn();
  const hiddenRefreshes = stateUpdates.length - hiddenFrom;
  eq(hiddenRefreshes, 0, `隐藏 60 秒内必须 0 次刷新（改前是 2 次）：实际 ${hiddenRefreshes}`);
  eq(fetchCalls.length - fetchFrom, 0, '隐藏时一次请求都不该发出：');

  // 可见：同样两个周期 → 2 次（证明守卫只挡隐藏，不是把轮询关死了）
  document.visibilityState = 'visible';
  const visibleFrom = stateUpdates.length;
  poll.fn();
  poll.fn();
  const visibleRefreshes = stateUpdates.length - visibleFrom;
  eq(visibleRefreshes, 2, `可见时两个周期必须各刷一次：实际 ${visibleRefreshes}`);

  // 重新可见：恰好补一次新鲜度
  document.visibilityState = 'hidden';
  const backFrom = stateUpdates.length;
  document.visibilityState = 'visible';
  const fresh = [...(documentListeners.get('visibilitychange') ?? [])].filter((h) => !listenersBefore.has(h));
  eq(fresh.length > 0, true, '当前面板必须注册 visibilitychange：');
  for (const handler of fresh) handler();
  eq(stateUpdates.length - backFrom, 1, `重新可见必须恰好补一次（实际 ${stateUpdates.length - backFrom}）：`);

  console.log(`      [poll] 60 秒窗口：隐藏 ${hiddenRefreshes} 次刷新 / 可见 ${visibleRefreshes} 次；重新可见 +1 次`);
  document.visibilityState = 'visible';
});

test('S3-3 客户端：只取分组形状时，拖拽仍能算出完整顺序（payloadRecordIds）', () => {
  eq(typeof mod.payloadRecordIds, 'function', '面板应当导出载荷 → id 顺序的纯函数：');
  // 有 todos 就用 todos（真·全局顺序）
  eq(mod.payloadRecordIds({ todos: [{ id: 'a' }, { id: 'b' }], groups: { later: [{ id: 'z' }] } }),
    ['a', 'b'], '有 todos 时以 todos 为准：');
  // 只取了 groups：按面板展示的桶顺序摊平（overdue → today → week → later → completed）
  eq(mod.payloadRecordIds({
    groups: {
      overdue: [{ id: 'x' }], today: [], week: [{ id: 'w' }], later: [{ id: 'y' }], completed: [{ id: 'z' }],
    },
  }), ['x', 'w', 'y', 'z'], '只有 groups 时必须按展示顺序摊平：');
  // 只取了 projectGroups
  eq(mod.payloadRecordIds({ projectGroups: [{ todos: [{ id: 'p1' }] }, { todos: [{ id: 'p2' }] }] }),
    ['p1', 'p2'], '只有 projectGroups 时按桶顺序摊平：');
  // 脏数据不能抛
  eq(mod.payloadRecordIds(null), []);
  eq(mod.payloadRecordIds({ groups: { later: [null, {}, { id: 'ok' }] } }), ['ok'], '坏行只跳过自己：');
});

test('S6-2：客户端重复注册只降级那一条，不能让 apply 把面板整体带崩', () => {
  // 官方 slots.register / locale.register 对重复注册是**抛错**（S6-2 引用的宿主语义）
  const injected = [];
  const registeredSpecs = [];
  const dupCtx = {
    slots: {
      inject(key, callback) { injected.push(key); callback(); return () => {}; },
      register(spec) { registeredSpecs.push(spec); throw new Error(`single slot "${spec?.id ?? spec?.key}" already has a registration`); },
    },
    locale: { register() { throw new Error('locale namespace "worktodo" already has locale "zh"'); } },
    effect(callback, label) { const dispose = callback(); return { dispose: dispose ?? (() => {}) }; },
  };

  const logged = [];
  const originalWarn = console.warn;
  console.warn = (...args) => logged.push(args.join(' '));
  let error = null;
  try {
    mod.apply(dupCtx);
  } catch (applyError) {
    error = applyError;
  } finally {
    console.warn = originalWarn;
  }

  eq(error, null, '重复注册不能让客户端 apply 抛错（改前会抛，面板整体消失、只能刷新页面）：');
  eq(injected.sort(), ['main', 'sidebar.panellist'], '两个 slot 的注入回调都必须被调用到：');
  eq(registeredSpecs.length, 2, '两条注册都要被尝试：');
  eq(logged.length >= 3, true, `重复注册必须留下可排查的 warn（locale + 两个 slot）：实际 ${logged.length} 条`);
  eq(logged.some((line) => line.includes('already has')), true, `warn 要带原始原因：${JSON.stringify(logged)}`);

  // 单条失败不影响另一条：侧栏 slot 被占用时，main 面板照常注册
  const mainOnly = [];
  const partialCtx = {
    slots: {
      inject(key, callback) { callback(); return () => {}; },
      register(spec) {
        if (spec.name === 'sidebar.panellist') throw new Error('single slot "worktodo" already has a registration');
        mainOnly.push(spec);
        return () => {};
      },
    },
    locale: { register: () => () => {} },
    effect(callback) { const dispose = callback(); return { dispose: dispose ?? (() => {}) }; },
  };
  console.warn = () => {};
  try {
    mod.apply(partialCtx);
  } finally {
    console.warn = originalWarn;
  }
  eq(mainOnly.map((spec) => spec.key), ['worktodo'], '侧栏被占用时 main 面板必须照常注册：');
});

console.log('自升级（客户端）：只读提示变成可点的「立即更新」');

test('updateBadgeState：有新版=可下载；装好待重启=只报重启、绝不再报「有新版本」', () => {
  eq(typeof mod.updateBadgeState, 'function', '面板应当导出升级徽标状态函数：');
  // 只给带占位符的文案真身，其余返回 key，便于断言
  const t = (key) => ({
    updatedRestart: '已更新到 {version}，重启 DSH 生效',
    updateInstalledManual: '已安装 {version}，请手动重启 DSH',
  }[key] ?? key);

  const idle = mod.updateBadgeState({ state: 'idle' }, { hasUpdate: true, latest: '0.2.4' }, t);
  eq(idle.action, 'download', '有新版时必须给「下载」按钮（照 DSH：第一步只下载）：');
  eq(idle.disabled, false);
  eq(idle.text.includes('0.2.4'), true, `要显示新版本号：${idle.text}`);
  eq(idle.text.includes('updateDownload'), true, `要明确写「下载」：${idle.text}`);

  // 核心回归：后台已经装好（落盘版本 > 运行版本），hasUpdate 仍按 runningVersion 为 true；
  // 此时必须只显示「重启生效」，不能还挂着「有新版本」和可点的更新入口。
  const restart = mod.updateBadgeState(
    { state: 'idle' },
    { hasUpdate: true, latest: '0.2.7', restartRequired: true, installedVersion: '0.2.7' },
    t,
  );
  eq(restart.text, '已更新到 v0.2.7，重启 DSH 生效', `装好待重启时文案要报出落盘版本：${restart.text}`);
  eq(restart.text.includes('updateAvailable'), false, `装好待重启时不能再出现「有新版本」：${restart.text}`);
  eq(restart.action, null, '已经装好了，不该再给「立即更新」（没有可做的事）：');
  eq(restart.disabled, true);
  eq(restart.tone, 'ok', '醒目但不用红色警告：');

  // 老宿主只给 installed（没有 installedVersion）时也要能报出版本号
  const legacy = mod.updateBadgeState(null, { hasUpdate: true, latest: '0.2.6', restartRequired: true, installed: '0.2.6' }, t);
  eq(legacy.text, '已更新到 v0.2.6，重启 DSH 生效', `落盘版本字段缺失时要回落到 installed：${legacy.text}`);
  eq(legacy.action, null);

  // 落盘版本号读不到：仍要提示重启，但不编造版本号
  const restartNoVersion = mod.updateBadgeState(null, { hasUpdate: true, latest: '0.2.7', restartRequired: true }, t);
  eq(restartNoVersion.text, 'updateRestartHint', '没有落盘版本号时用「已更新完成」的兜底文案：');
  eq(restartNoVersion.action, null);

  const running = mod.updateBadgeState({ state: 'running', to: '0.2.4', command: 'pnpm add dsh-worktodo@latest' }, null, t);
  eq(running.disabled, true, '更新中不可点（防连点出第二个子进程）：');
  eq(running.action, null);
  eq(running.tone, 'busy');
  eq(running.text.includes('updating'), true, `更新中要显示进行时文案：${running.text}`);

  const done = mod.updateBadgeState({ state: 'done', to: '0.2.4' }, null, t);
  eq(done.text.includes('{version}'), false, '不能留下未替换的占位符：');
  eq(done.text.includes('0.2.4'), true, `完成态要报出升级到的版本：${done.text}`);
  eq(done.disabled, true);

  const linked = mod.updateBadgeState({ state: 'failed', reason: 'linked', error: 'link: 安装' }, null, t);
  eq(linked.text, 'updateLinked', 'linked 要用「本地链接安装」的专门说明（那不是故障）：');
  eq(linked.action, null, 'linked 不该给「重试」（重试一百次也一样）：');

  const failed = mod.updateBadgeState({ state: 'failed', reason: 'exit-nonzero', error: '安装命令退出码 3' }, null, t);
  // 什么都没下载过 → 重试的第一步必须是「下载」，不能直接点安装（那条路会被宿主拒绝）
  eq(failed.action, 'download', '失败必须能重试（没下载过时先重试下载）：');
  eq(failed.text.includes('安装命令退出码 3'), true, `失败原因要显示出来：${failed.text}`);

  eq(mod.updateBadgeState({ state: 'idle' }, { hasUpdate: false }, t), null, '没新版、没在升级时不该渲染这一格：');
  eq(mod.updateBadgeState({ state: 'idle' }, { hasUpdate: false, restartRequired: false }, t), null, 'restartRequired:false 时也不该渲染：');
  eq(mod.updateBadgeState(null, null, t), null);
});

test('页脚：有新版时渲染成可点的按钮；进行中是只读状态（不是按钮）', () => {
  const t = (key) => key;
  const previous = fakeListPayload.data.update;
  const updateNodes = () => flattenTree(renderPanel({ t }))
    .filter((n) => String(n.props?.className ?? '').includes('wt-update'));
  try {
    fakeListPayload.data.update = { current: '0.2.0', latest: '0.2.4', hasUpdate: true, run: { state: 'idle' } };
    const ready = updateNodes().filter((n) => n.type === 'button');
    eq(ready.length, 1, `页脚必须渲染恰好一个升级按钮：${ready.length}`);
    eq(typeof ready[0].props.onClick, 'function', '升级按钮必须真的挂了点击处理：');
    eq(ready[0].props.disabled, false, '有新版时可点：');
    eq(typeof ready[0].props['aria-label'], 'string', '升级按钮要有 aria-label：');
    eq(textOf(ready[0]).includes('0.2.4'), true, `徽标要显示新版本：${textOf(ready[0])}`);
    eq(textOf(ready[0]).includes('updateDownload'), true, `要写「下载」（第一步）：${textOf(ready[0])}`);

    fakeListPayload.data.update = { current: '0.2.0', latest: '0.2.4', hasUpdate: true, run: { state: 'running', to: '0.2.4' } };
    const busy = updateNodes();
    eq(busy.length, 1, `进行中也只占一格：${busy.length}`);
    eq(busy[0].type, 'span', '进行中是状态文本，不该渲染成可点按钮：');
    eq(busy[0].props.role, 'status', '只读状态要标 role=status：');
    eq(busy[0].props['aria-label'], 'updating v0.2.4', '状态徽标也要有 aria-label：');
    eq(textOf(busy[0]).includes('updating'), true, `进行中要变成「正在更新…」：${textOf(busy[0])}`);
  } finally {
    fakeListPayload.data.update = previous;
  }
});

test('页脚：restartRequired 时只显示「已更新到 vX，重启 DSH 生效」，且没有任何可点的更新按钮', () => {
  const t = (key) => (key === 'updatedRestart' ? '已更新到 {version}，重启 DSH 生效' : key);
  const previous = fakeListPayload.data.update;
  try {
    // 与宿主真实载荷一致：hasUpdate 仍为 true（latest vs 运行版本），restartRequired 也为 true
    fakeListPayload.data.update = {
      current: '0.2.5', runningVersion: '0.2.5', latest: '0.2.7',
      hasUpdate: true, restartRequired: true, installedVersion: '0.2.7',
      run: { state: 'idle' },
    };
    const nodes = flattenTree(renderPanel({ t }));
    const chips = nodes.filter((n) => String(n.props?.className ?? '').includes('wt-update'));
    eq(chips.length, 1, `已装好待重启只该占页脚一格：${chips.length}`);
    const chip = chips[0];
    eq(chip.type, 'span', '已装好待重启是纯状态，不能渲染成按钮：');
    eq(chip.props.role, 'status');
    eq(typeof chip.props.onClick, 'undefined', '纯状态不该有点击处理：');
    eq(chip.props['aria-label'], '已更新到 v0.2.7，重启 DSH 生效', '徽标要有 aria-label：');
    const text = textOf(chip);
    eq(text, '已更新到 v0.2.7，重启 DSH 生效', `文案要报出落盘版本：${text}`);
    eq(text.includes('有新版本'), false, `装好待重启时不能再出现「有新版本」：${text}`);
    eq(text.includes('立即更新'), false, `装好待重启时不该再出现「立即更新」：${text}`);

    // 全页扫描：不允许出现任何可点的更新按钮（button.wt-update）
    const clickable = nodes.filter((n) => n.type === 'button' && String(n.props?.className ?? '').includes('wt-update'));
    eq(clickable.length, 0, `已装好待重启时不该有可点的更新按钮：${clickable.length}`);

    // 反向对照：同一个载荷把 restartRequired 变成 false，才回到「有新版本」+ 可点按钮
    fakeListPayload.data.update = {
      current: '0.2.5', runningVersion: '0.2.5', latest: '0.2.7',
      hasUpdate: true, restartRequired: false, installedVersion: '0.2.5', run: { state: 'idle' },
    };
    const updateNodes = flattenTree(renderPanel({ t }))
      .filter((n) => String(n.props?.className ?? '').includes('wt-update'));
    eq(updateNodes.length, 1);
    eq(updateNodes[0].type, 'button', '真正「有新版本（还没装）」时才是可点按钮：');
    eq(textOf(updateNodes[0]).includes('updateAvailable'), true, `要回到「有新版本」文案：${textOf(updateNodes[0])}`);
  } finally {
    fakeListPayload.data.update = previous;
  }
});

console.log('自升级（客户端）：两阶段交互 —— 下载 → 进度 → 安装并重启 → 已安装待重启');

/** 带占位符真身的 t，其余返回 key（便于断言「用的是哪个 key」而不是被文案细节缠住）。 */
const updateT = (key) => ({
  updatedRestart: '已更新到 {version}，重启 DSH 生效',
  updateInstalledManual: '已安装 {version}，请手动重启 DSH',
  updateInstalledManualHint: 'DSH 没有向插件暴露重启入口',
  updateDownloading: '下载中 {percent}%',
  updateDownloadingBytes: '下载中 · 已收到 {bytes}',
  updateInstallHint: '应用已下载的 {version}，然后请求重启 DSH',
  updateDownloadedState: '已下载 {version}',
}[key] ?? key);

test('updateBadgeState：阶段驱动（available→downloading→downloaded→installing→installed→restarting）', () => {
  const badge = (run, update) => mod.updateBadgeState(run, update, updateT);

  // 1) 可下载：给的是「下载」按钮，不是「立即更新」
  const available = badge({ phase: 'available', version: '0.2.7' }, { hasUpdate: true, latest: '0.2.7' });
  eq(available.action, 'download', 'available 阶段必须给「下载」：');
  eq(available.disabled, false);
  eq(available.text.includes('0.2.7'), true, `要报出目标版本：${available.text}`);

  // 2) 下载中：进度来自宿主，前端不编造；不可点
  const downloading = badge({ phase: 'downloading', version: '0.2.7', percent: 42 }, null);
  eq(downloading.action, null, '下载中不该给任何可点动作（防连点起第二次下载）：');
  eq(downloading.disabled, true);
  eq(downloading.tone, 'busy');
  eq(downloading.text.includes('42'), true, `必须显示进度百分比：${downloading.text}`);
  // 没有 content-length（percent:null）时只报已收到字节数，不能编一个 0% 或 100%
  const noLength = badge({ phase: 'downloading', version: '0.2.7', percent: null, download: { bytes: 2048 } }, null);
  eq(noLength.text.includes('已收到'), true, `没有百分比时要报已下载量：${noLength.text}`);
  eq(noLength.text.includes('2.0 KB'), true, `字节数要人类可读：${noLength.text}`);

  // 3) 校验中：DSH 在这一步是 verifying（下完了但还不能装）
  const verifying = badge({ phase: 'verifying', version: '0.2.7', percent: 100 }, null);
  eq(verifying.action, null, '校验中不该给可点动作：');
  eq(verifying.text, 'updateVerifying');

  // 4) 已下载：第二步才出现「安装并重启」
  const downloaded = badge({ phase: 'downloaded', version: '0.2.7', percent: 100, download: { version: '0.2.7' } }, null);
  eq(downloaded.action, 'install', '已下载后必须给「安装并重启」：');
  eq(downloaded.disabled, false);
  eq(downloaded.text.includes('updateInstallRestart'), true, `按钮文案要是「安装并重启」：${downloaded.text}`);

  // 5) 安装中：不可点
  const installing = badge({ phase: 'installing', version: '0.2.7' }, null);
  eq(installing.action, null);
  eq(installing.tone, 'busy');
  eq(installing.text, 'updateInstalling');

  // 6) 已安装 + 重启不可用：诚实提示「请手动重启」，绝不给「重启」按钮假装能重启
  const installedManual = badge({
    phase: 'installed', version: '0.2.7',
    restart: { supported: false, ok: false, reason: 'no-plugin-restart-ipc', error: 'DSH 没有向插件暴露重启入口' },
  }, { restartSupported: false, installedVersion: '0.2.7' });
  eq(installedManual.action, null, '重启不可用时不该给可点按钮：');
  eq(installedManual.disabled, true);
  eq(installedManual.text, '已安装 v0.2.7，请手动重启 DSH');
  eq(installedManual.title.includes('没有向插件暴露重启入口'), true, `要把原因写在 title 里：${installedManual.title}`);
  eq(installedManual.tone, 'ok', '装好了不是故障，不要用红色：');

  // 7) 已安装 + 用户配了重启命令：这时才给「重启 DSH」
  const installedRestartable = badge({
    phase: 'installed', version: '0.2.7',
    restart: { supported: true, ok: null, kind: 'command' },
  }, { restartSupported: true });
  eq(installedRestartable.action, 'restart', '配了 restartCommand 才允许给「重启 DSH」：');
  eq(installedRestartable.text.includes('updateRestart'), true);

  // 8) 重启中
  const restarting = badge({ phase: 'restarting', version: '0.2.7', restart: { supported: true } }, null);
  eq(restarting.action, null);
  eq(restarting.tone, 'busy');
  eq(restarting.text, 'updateRestarting');

  // 9) 下载失败：重试的是「下载」，不是「安装」
  const downloadFailed = badge({ phase: 'failed', version: '0.2.7', failedOperation: 'download', failure: 'download-network', error: 'HTTP 503' }, null);
  eq(downloadFailed.action, 'download', '下载失败的重试必须回到下载这一步：');
  eq(downloadFailed.tone, 'error');
  eq(downloadFailed.text.includes('HTTP 503'), true, `失败原因要显示出来：${downloadFailed.text}`);
  eq(downloadFailed.text.includes('updateDownloadFailed'), true, `要说明是「下载失败」而不是笼统「更新失败」：${downloadFailed.text}`);

  // 10) 安装失败但下载物还在：重试的是安装
  const installFailed = badge({
    phase: 'failed', version: '0.2.7', failedOperation: 'install', failure: 'install',
    error: '安装命令退出码 3', download: { version: '0.2.7' },
  }, null);
  eq(installFailed.action, 'retry', '下载物还在时重试安装：');

  // 11) 校验/落盘坏了：必须回到下载（安装一个坏包没有意义）
  const corrupt = badge({
    phase: 'failed', version: '0.2.7', failedOperation: 'install', failure: 'download-corrupt',
    error: '校验不通过', download: { version: '0.2.7' },
  }, null);
  eq(corrupt.action, 'download', '下载物坏了要重新下载：');

  // 12) linked 仍然不是故障：不给重试
  const linked = badge({ phase: 'failed', state: 'idle', reason: 'linked', failure: 'linked', error: 'link: 安装' }, null);
  eq(linked.action, null, 'linked 不该给重试（重试一百次也一样）：');
  eq(linked.text, 'updateLinked');
});

test('页脚：下载中渲染成只读状态 + aria 进度；已下载渲染成「安装并重启」按钮', () => {
  const previous = fakeListPayload.data.update;
  const nodes = () => flattenTree(renderPanel({ t: updateT }))
    .filter((n) => String(n.props?.className ?? '').includes('wt-update'));
  try {
    // 下载中：只读、role=progressbar、aria-valuenow 就是宿主给的百分比
    fakeListPayload.data.update = {
      current: '0.2.5', latest: '0.2.7', hasUpdate: true, restartSupported: false,
      run: { phase: 'downloading', state: 'running', version: '0.2.7', percent: 37 },
    };
    const busy = nodes();
    eq(busy.length, 1, '下载中只占页脚一格：');
    eq(busy[0].type, 'span', '下载中是状态文本，不该渲染成按钮：');
    eq(busy[0].props.role, 'progressbar', '下载中要标 role=progressbar：');
    eq(busy[0].props['aria-valuenow'], 37, 'aria-valuenow 必须是宿主报的百分比：');
    eq(busy[0].props['aria-label'].includes('37'), true, `可读名里也要有百分比：${busy[0].props['aria-label']}`);

    // 已下载：可点的「安装并重启」
    fakeListPayload.data.update = {
      current: '0.2.5', latest: '0.2.7', hasUpdate: true, restartSupported: false,
      run: { phase: 'downloaded', state: 'idle', version: '0.2.7', percent: 100, download: { version: '0.2.7' } },
    };
    const ready = nodes();
    eq(ready.length, 1);
    eq(ready[0].type, 'button', '已下载后必须是按钮：');
    eq(typeof ready[0].props.onClick, 'function');
    eq(ready[0].props.disabled, false);
    eq(ready[0].props['aria-label'].includes('updateInstallRestart'), true, `aria-label 要说清「安装并重启」：${ready[0].props['aria-label']}`);
    eq(String(textOf(ready[0])).includes('0.2.7'), true, `要报出版本：${textOf(ready[0])}`);

    // 已安装、重启不可用：只读 + 诚实文案 + 全页没有可点的更新按钮
    fakeListPayload.data.update = {
      current: '0.2.5', latest: '0.2.7', hasUpdate: false, restartSupported: false,
      run: { phase: 'installed', state: 'done', version: '0.2.7', restart: { supported: false, ok: false, error: 'DSH 没有向插件暴露重启入口' } },
    };
    const installed = nodes();
    eq(installed.length, 1);
    eq(installed[0].type, 'span', '已安装待重启是纯状态：');
    eq(installed[0].props['aria-label'], '已安装 v0.2.7，请手动重启 DSH');
    const clickable = flattenTree(renderPanel({ t: updateT }))
      .filter((n) => n.type === 'button' && String(n.props?.className ?? '').includes('wt-update'));
    eq(clickable.length, 0, '重启不可用时绝不能出现可点的更新按钮（不假装能重启）：');
  } finally {
    fakeListPayload.data.update = previous;
  }
});

test('轮询：只有下载/安装进行中才注册 2s 轮询（不常驻），且卸载时清掉', () => {
  const previous = fakeListPayload.data.update;
  const pollsDuring = (update) => {
    fakeListPayload.data.update = update;
    const before = intervals.length;
    for (const cleanup of [...effectCleanups]) {
      try { cleanup(); } catch { /* 上一轮的清理失败不影响本轮 */ }
    }
    effectCleanups.length = 0;
    try {
      renderPanel({ t: updateT });
      return intervals.slice(before).filter((handle) => handle.ms === mod.UPDATE_POLL_MS);
    } finally {
      fakeListPayload.data.update = previous;
    }
  };
  try {
    eq(pollsDuring({ current: '0.2.5', latest: '0.2.7', hasUpdate: true, run: { phase: 'idle', state: 'idle' } }).length, 0,
      '空闲时绝不能有 2s 轮询（常驻定时器会让「省着打宿主」失效）：');
    eq(pollsDuring({ current: '0.2.5', latest: '0.2.7', hasUpdate: true, run: { phase: 'downloading', state: 'running', percent: 10 } }).length, 1,
      '下载中必须有一个 2s 轮询：');
    eq(pollsDuring({ current: '0.2.5', latest: '0.2.7', run: { phase: 'installed', state: 'done' } }).length, 0,
      '安装收口后必须立刻停掉轮询：');
    // 清理：把还活着的 effect 清理函数都跑一遍，所有 interval 都必须被 clear
    for (const cleanup of [...effectCleanups]) {
      try { cleanup(); } catch { /* 单个清理失败不影响结论 */ }
    }
    eq(intervals.every((handle) => clearedIntervals.includes(handle)), true, '卸载时必须 clearInterval：');
  } finally {
    fakeListPayload.data.update = previous;
  }
});

/* ------------------------------------------------------------------ *
 * 项目选择器（快速添加第二行的第四项）
 *
 * 面板此前**没有任何项目选择 UI**，第二行只有 日期 / 时间 / 优先级。
 * 这里补的四件事：项目项排在优先级之后、弹层能列已有项目、能新建（重名自动选中已有）、
 * 「未归类」把 project 清成显式 null（undefined 会被宿主的无损 JSON 校验拒掉）。
 * ------------------------------------------------------------------ */

console.log('项目选择器（快速添加第二行：日期 → 时间 → 优先级 → 项目）');

/** 等一次宏任务：让面板首屏 fetch 落地（列表缓存写好）之后，QuickAdd 才会被渲染。 */
const settleList = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 假定时器：只接管 setTimeout / clearTimeout，记录面板排的定时器，由用例显式推进。
 * `flush` 用**真实** setTimeout 等一次宏任务，把 fetch/await 链放完（不受假定时器影响）。
 * setInterval 在文件顶部早已被全局替身接管，不受这里影响。
 */
function installFakeTimers() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = (fn, ms) => {
    const handle = { fn, ms, cleared: false, unref() {} };
    timers.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => { if (handle) handle.cleared = true; };
  return {
    timers,
    flush: () => new Promise((resolve) => realSetTimeout(resolve, 0)),
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

/**
 * 点一下顶部「刷新」按钮，从它产生的唯一一次 setState 反推出 tick 状态槽 id。
 * 有了槽 id，就能把「刷新发生了几次」和 setPending / 乐观态等其他 setState 区分开。
 */
function tickSlotId(tree) {
  const button = allNodes(tree).find((n) => n.type === 'button' && n.props?.title === '[refresh]');
  eq(Boolean(button), true, '面板顶部必须有刷新按钮（用它定位 tick 状态槽）：');
  const before = stateUpdates.length;
  button.props.onClick();
  const record = stateUpdates[before];
  eq(Boolean(record) && typeof record.slot === 'string', true, '刷新按钮必须只触发一次 tick 状态更新：');
  return record.slot;
}

/** 某个状态槽被更新过几次（用来数「刷新发生了几次」）。 */
const slotUpdateCount = (slot) => stateUpdates.filter((update) => update?.slot === slot).length;

/**
 * 统一的取节点列表：传渲染树（对象）就摊平，传已经摊平过的数组就原样用。
 * 直接用 flattenTree(array) 会把每个节点连同它的后代再数一遍（深度重复），踩过一次。
 */
const allNodes = (value) => (Array.isArray(value) ? value : flattenTree(value));

/** 在渲染树/节点列表里按 data-wt-field 找第二行的某个 chip。 */
const chipOf = (tree, field) => allNodes(tree).find((n) => n.props?.['data-wt-field'] === field);

/** 弹层里的「已有项目」按钮（按宿主给的顺序）。 */
const projectOptionNames = (tree) => allNodes(tree)
  .filter((n) => typeof n.props?.['data-wt-project'] === 'string')
  .map((n) => n.props['data-wt-project']);

/** 找第一行标题输入框 / 「添加」按钮（提交路径与手动操作完全一致）。 */
const titleInputOf = (tree) => allNodes(tree)
  .find((n) => n.type === 'input' && n.props?.placeholder === '[addPlaceholder]');
const addButtonOf = (tree) => allNodes(tree)
  .find((n) => n.type === 'button' && textOf(n) === '[add]');

/** 填标题 → 点添加 → 取出这次同步发出的 /create 报文。 */
function submitAndReadCreate(t) {
  const input = titleInputOf(renderPanel({ t }));
  input.props.onChange({ target: { value: '写周报' } });
  const add = addButtonOf(renderPanel({ t }));
  const before = fetchCalls.length;
  add.props.onClick();
  const post = fetchCalls.slice(before).find((call) => call.url.includes('/create'));
  return post ? JSON.parse(post.options.body) : null;
}

await testAsync('第二行的四个 chip 顺序是 日期→时间→优先级→项目，且项目项显示「项目 · 未归类」', async () => {
  document.visibilityState = 'visible';
  const t = (key) => `[${key}]`;
  renderPanel({ t });
  await settleList(); // 第一次渲染只是发起请求；缓存落地后 QuickAdd 才在树里
  const tree = renderPanel({ t });

  const fields = flattenTree(tree)
    .map((n) => n.props?.['data-wt-field'])
    .filter((value) => typeof value === 'string');
  eq(fields, ['due', 'time', 'priority', 'project'], `第二行四个 chip 的顺序：${JSON.stringify(fields)}`);

  const chip = chipOf(tree, 'project');
  eq(Boolean(chip), true, '第二行必须有「项目」chip：');
  eq(textOf(chip), '[projectLabel] · [noProject]', '未设置时的文案：');
  eq(chip.props.style?.color, 'var(--dsw-alias-label-tertiary)', '未设置时用灰色（label3）：');
  // 无障碍：可读名称 + 折叠态
  eq(chip.props['aria-label'], '[projectLabel]', 'chip 要有 aria-label：');
  eq(chip.props['aria-expanded'], false, '关闭时 aria-expanded=false：');
  eq(chip.props['aria-haspopup'], 'true');
});

await testAsync('项目弹层列出已有项目；点选后 chip 变项目名、当前项高亮，提交报文带该项目名', async () => {
  document.visibilityState = 'visible';
  const t = (key) => `[${key}]`;
  const saved = fakeListPayload.data.projects;
  fakeListPayload.data.projects = ['dsh-worktodo', 'alpha', 'beta'];
  try {
    renderPanel({ t });
    await settleList();
    const body = withStableHooks(() => {
      const chip = chipOf(renderPanel({ t }), 'project');
      eq(Boolean(chip), true, '必须有「项目」chip：');
      chip.props.onClick();

      const opened = flattenTree(renderPanel({ t }));
      eq(projectOptionNames(opened), ['dsh-worktodo', 'alpha', 'beta'], '已有项目要按宿主的顺序一行一个：');
      eq(Boolean(opened.find((n) => n.props?.['data-wt-project-clear'] === 'true')), true, '要有「未归类」一键清除：');
      eq(Boolean(opened.find((n) => n.props?.['data-wt-project-create'] === 'true')), true, '要有「新建」按钮：');
      eq(Boolean(opened.find((n) => n.type === 'input' && n.props?.placeholder === '[projectNewPlaceholder]')), true,
        '要有「新项目名」输入框：');
      eq(chipOf(opened, 'project').props['aria-expanded'], true, '打开后 aria-expanded=true：');

      // 点选 alpha：当前项要高亮（aria-pressed 给读屏与测试同一个信号）
      const alpha = opened.find((n) => n.props?.['data-wt-project'] === 'alpha');
      alpha.props.onClick();
      const picked = flattenTree(renderPanel({ t }));
      const chip2 = chipOf(picked, 'project');
      eq(textOf(chip2), 'alpha', '选完 chip 要显示项目名：');
      eq(chip2.props.style?.color, 'var(--dsw-alias-label-primary)', '已设置用正常色（label）：');
      eq(chip2.props['aria-expanded'], false, '选完要收起弹层：');

      // 重新打开：被选中的那一项必须是高亮态，其余不是
      chip2.props.onClick();
      const reopened = flattenTree(renderPanel({ t }));
      const pressed = reopened
        .filter((n) => typeof n.props?.['data-wt-project'] === 'string')
        .map((n) => [n.props['data-wt-project'], n.props['aria-pressed']]);
      eq(pressed, [['dsh-worktodo', false], ['alpha', true], ['beta', false]], '当前选中的项目要高亮：');
      // 收起弹层后填标题提交（点 chip 收起，避免弹层挡住按钮的语义）
      chipOf(renderPanel({ t }), 'project').props.onClick();

      return submitAndReadCreate(t);
    });
    eq(body !== null, true, '必须真的发出 /create：');
    eq(body.project, 'alpha', '提交报文要带所选项目名：');
    eq(body.title, '写周报');
  } finally {
    fakeListPayload.data.projects = saved;
  }
});

await testAsync('B7：清单被截断（projectsTruncated）时弹层出现提示文案，且 {count} 已替换成实际条数', async () => {
  document.visibilityState = 'visible';
  const saved = fakeListPayload.data.projects;
  const savedFlag = fakeListPayload.data.projectsTruncated;
  fakeListPayload.data.projects = ['dsh-worktodo', 'alpha', 'beta'];
  fakeListPayload.data.projectsTruncated = true;
  try {
    // 不注入 t：走模块级 FALLBACK_T（中文表），这样断言的是真实文案而不是 [key] 占位
    renderPanel();
    await settleList();

    // 先验正例：宿主说「还有更多」，面板必须告诉用户，且把 {count} 填成实际展示条数
    const hintText = withStableHooks(() => {
      chipOf(renderPanel(), 'project').props.onClick();
      const opened = flattenTree(renderPanel());
      // 只认「文本就是这句提示」的那个节点（父容器/样式节点会把更多文本拼进来）
      const hint = opened.find((n) => textOf(n).includes('项目较多') && !textOf(n).includes('dsh-worktodo'));
      eq(Boolean(hint), true, '截断时必须出现提示文案：');
      // 断言模板已展开成真实文案、{count} 不再是裸占位符
      eq(textOf(hint).includes('{count}'), false, '提示里的 {count} 必须被替换（不能留裸模板）：');
      eq(textOf(hint), `项目较多，只显示最常用的 ${projectOptionNames(opened).length} 个`, '提示要带上实际展示条数：');
      chipOf(opened, 'project').props.onClick(); // 收起
      return textOf(hint);
    });
    eq(hintText.includes('3'), true, '这里是 3 个项目：');

    // 反例（证明断言不是恒真）：宿主说没截断时不应出现这句提示
    fakeListPayload.data.projectsTruncated = false;
    renderPanel();
    await settleList();
    withStableHooks(() => {
      chipOf(renderPanel(), 'project').props.onClick();
      const opened = flattenTree(renderPanel());
      eq(opened.some((n) => textOf(n).includes('项目较多') && !textOf(n).includes('dsh-worktodo')), false,
        '未截断时不该出现截断提示：');
      chipOf(opened, 'project').props.onClick(); // 收起
    });
  } finally {
    fakeListPayload.data.projects = saved;
    fakeListPayload.data.projectsTruncated = savedFlag;
  }
});

await testAsync('新建项目：输入新名字回车 → chip 变新名字，提交报文带新名字（且不由本地塞进「已有」清单）', async () => {  document.visibilityState = 'visible';
  const t = (key) => `[${key}]`;
  const saved = fakeListPayload.data.projects;
  fakeListPayload.data.projects = ['dsh-worktodo', 'beta'];
  try {
    renderPanel({ t });
    await settleList();
    const body = withStableHooks(() => {
      chipOf(renderPanel({ t }), 'project').props.onClick();
      const opened = flattenTree(renderPanel({ t }));
      const input = opened.find((n) => n.type === 'input' && n.props?.placeholder === '[projectNewPlaceholder]');
      eq(Boolean(input), true, '弹层里要有「新项目名」输入框：');
      eq(input.props.value, '', '输入框初始为空：');
      input.props.onChange({ target: { value: 'gamma' } });
      const typed = flattenTree(renderPanel({ t }));
      const input2 = typed.find((n) => n.type === 'input' && n.props?.placeholder === '[projectNewPlaceholder]');
      eq(input2.props.value, 'gamma', '输入框受控：');
      input2.props.onKeyDown({ key: 'Enter' }); // 回车即新建
      const afterCreate = flattenTree(renderPanel({ t }));
      const chipNew = chipOf(afterCreate, 'project');
      eq(textOf(chipNew), 'gamma', '新建后 chip 要显示新项目名：');
      eq(chipNew.props['aria-expanded'], false, '新建后收起弹层：');
      // 清单来自宿主：本地新建不会凭空多出一行"已有项目"
      chipNew.props.onClick(); // 重新打开看一眼清单
      const listed = flattenTree(renderPanel({ t }));
      eq(projectOptionNames(listed), ['dsh-worktodo', 'beta'], '新建的项目不由本地塞进「已有」清单：');
      chipOf(listed, 'project').props.onClick(); // 收起，回到干净状态

      const created = submitAndReadCreate(t);
      return created;
    });
    eq(body !== null, true, '必须真的发出 /create：');
    eq(body.project, 'gamma', '提交报文要带新项目名：');
  } finally {
    fakeListPayload.data.projects = saved;
  }
});

await testAsync('新建项目重名（大小写/首尾空白不同）→ 选中已有项目的原名，不产生第二份', async () => {
  document.visibilityState = 'visible';
  const t = (key) => `[${key}]`;
  const saved = fakeListPayload.data.projects;
  fakeListPayload.data.projects = ['dsh-worktodo', 'beta'];
  try {
    renderPanel({ t });
    await settleList();
    const body = withStableHooks(() => {
      chipOf(renderPanel({ t }), 'project').props.onClick();
      const opened = flattenTree(renderPanel({ t }));
      const input = opened.find((n) => n.type === 'input' && n.props?.placeholder === '[projectNewPlaceholder]');
      input.props.onChange({ target: { value: '  BETA  ' } });
      const typed = flattenTree(renderPanel({ t }));
      const createBtn = typed.find((n) => n.props?.['data-wt-project-create'] === 'true');
      eq(Boolean(createBtn), true, '「新建」按钮要在：');
      createBtn.props.onClick();
      const afterDup = flattenTree(renderPanel({ t }));
      const chipDup = chipOf(afterDup, 'project');
      eq(textOf(chipDup), 'beta', '重名（忽略大小写/首尾空白）要选中已有项目的原名：');
      eq(chipDup.props['aria-expanded'], false, '选中后收起弹层：');
      // 重新打开：清单里仍然只有两条，没有因为重名多出一行
      chipDup.props.onClick();
      const listedDup = flattenTree(renderPanel({ t }));
      eq(projectOptionNames(listedDup), ['dsh-worktodo', 'beta'], '重名不能让「已有项目」多出一行：');
      chipOf(listedDup, 'project').props.onClick(); // 收起

      return submitAndReadCreate(t);
    });
    eq(body !== null, true, '必须真的发出 /create：');
    eq(body.project, 'beta', '重名时提交的是已有项目的原名（不是一个只差大小写的新项目）：');
  } finally {
    fakeListPayload.data.projects = saved;
  }
});

await testAsync('选「未归类」→ chip 回到未归类，提交报文的 project 是显式 null（不是缺键 / undefined）', async () => {
  document.visibilityState = 'visible';
  const t = (key) => `[${key}]`;
  const saved = fakeListPayload.data.projects;
  fakeListPayload.data.projects = ['alpha'];
  try {
    renderPanel({ t });
    await settleList();
    const body = withStableHooks(() => {
      // 先选上 alpha，证明「未归类」是一次真实的状态变化（不是初始态）
      chipOf(renderPanel({ t }), 'project').props.onClick();
      const opened = flattenTree(renderPanel({ t }));
      opened.find((n) => n.props?.['data-wt-project'] === 'alpha').props.onClick();
      const picked = flattenTree(renderPanel({ t }));
      eq(textOf(chipOf(picked, 'project')), 'alpha', '先选中一个项目：');

      chipOf(picked, 'project').props.onClick();
      const reopened = flattenTree(renderPanel({ t }));
      const clear = reopened.find((n) => n.props?.['data-wt-project-clear'] === 'true');
      eq(Boolean(clear), true, '「未归类」按钮要在：');
      clear.props.onClick();
      const cleared = flattenTree(renderPanel({ t }));
      eq(textOf(chipOf(cleared, 'project')), '[projectLabel] · [noProject]', '清除后回到「项目 · 未归类」：');

      return submitAndReadCreate(t);
    });
    eq(body !== null, true, '必须真的发出 /create：');
    eq(Object.prototype.hasOwnProperty.call(body, 'project'), true,
      'project 键必须存在 —— 缺键会让宿主以为「不改项目」，显式 null 才是清空：');
    eq(body.project, null, '未归类必须是显式 null：');
  } finally {
    fakeListPayload.data.projects = saved;
  }
});

await testAsync('项目弹层的键盘可达性：Esc 关闭（chip 与弹层都能关）、Enter 新建、未归类在弹层里', async () => {
  document.visibilityState = 'visible';
  const t = (key) => `[${key}]`;
  const saved = fakeListPayload.data.projects;
  fakeListPayload.data.projects = ['alpha'];
  try {
    renderPanel({ t });
    await settleList();
    const report = withStableHooks(() => {
      const chip = chipOf(renderPanel({ t }), 'project');
      chip.props.onClick();
      const opened = flattenTree(renderPanel({ t }));
      const pop = opened.find((n) => n.props?.role === 'group' && n.props?.['aria-label'] === '[projectLabel]');
      eq(Boolean(pop), true, '弹层要有 role=group + aria-label（读屏能认出这是一组选择）：');
      eq(typeof pop.props.onKeyDown, 'function', '弹层要能接键盘事件（子元素冒泡进来的 Esc）：');

      // Esc 从弹层冒泡上来 → 关闭
      pop.props.onKeyDown({ key: 'Escape' });
      let closed = flattenTree(renderPanel({ t }));
      eq(chipOf(closed, 'project').props['aria-expanded'], false, 'Esc 要能关闭弹层：');
      eq(Boolean(closed.find((n) => n.props?.['data-wt-project-clear'])), false, '关闭后弹层内容不该再渲染：');

      // Esc 从 chip 上按（焦点停在 chip 时）
      const chip2 = chipOf(renderPanel({ t }), 'project');
      chip2.props.onClick();
      const reopened = flattenTree(renderPanel({ t }));
      const pop2 = reopened.find((n) => n.props?.role === 'group' && n.props?.['aria-label'] === '[projectLabel]');
      eq(typeof chipOf(reopened, 'project').props.onKeyDown, 'function', 'chip 自己也要能接 Esc：');
      pop2.props.onKeyDown({ key: 'Escape' });
      const closed2 = flattenTree(renderPanel({ t }));
      eq(Boolean(closed2.find((n) => n.props?.['data-wt-project'])), false, 'Esc 之后弹层要关掉：');

      // 输入框里按 Esc 也关；按 Enter 则新建
      chipOf(closed2, 'project').props.onClick();
      const opened3 = flattenTree(renderPanel({ t }));
      const input = opened3.find((n) => n.type === 'input' && n.props?.placeholder === '[projectNewPlaceholder]');
      eq(typeof input.props.onKeyDown, 'function', '输入框要能接键盘：');
      input.props.onKeyDown({ key: 'Escape' });
      eq(Boolean(flattenTree(renderPanel({ t })).find((n) => n.props?.['data-wt-project'])), false,
        '输入框里的 Esc 也要关闭弹层：');

      chipOf(renderPanel({ t }), 'project').props.onClick();
      const opened4 = flattenTree(renderPanel({ t }));
      const input4 = opened4.find((n) => n.type === 'input' && n.props?.placeholder === '[projectNewPlaceholder]');
      input4.props.onChange({ target: { value: 'delta' } });
      const typed = flattenTree(renderPanel({ t }));
      typed.find((n) => n.type === 'input' && n.props?.placeholder === '[projectNewPlaceholder]')
        .props.onKeyDown({ key: 'Enter' });
      const done = flattenTree(renderPanel({ t }));
      return { field: textOf(chipOf(done, 'project')) };
    });
    eq(report.field, 'delta', 'Enter 要能新建：');
  } finally {
    fakeListPayload.data.projects = saved;
  }
});

/* ------------------------------------------------------------------ *
 * 行内四旗优先级 / 勾选完成动效 / 更大的勾选框
 *
 * 三件事的验收标准都在这里：旗子是可点的按钮且「无优先级」时靠组件状态才现身、
 * 点选后发出准确的 /worktodo/update 报文、勾选完成挂动效而取消完成不挂、
 * 勾选框的视觉尺寸与实际可点区域都达标记。
 * ------------------------------------------------------------------ */

console.log('行内旗子 / 勾选动效 / 勾选框尺寸');

/**
 * 每次渲染换一个 `t` 身份。
 *
 * 真 React 里「行内 setState」会让被 memo 包住的行自己重渲染；替身渲染器只按键位做
 * props 浅比较，props 没变就整棵子树跳过。换成新身份等价于告诉它「这一轮必须重跑行 body」，
 * 于是 hover / 展开 / 勾选这些行内状态才量得出来。
 */
const mkT = () => (key) => `[${key}]`;

/** 按 data-wt-row 找一行。 */
const rowNode = (tree, id) => allNodes(tree).find((n) => n.props?.['data-wt-row'] === id);

/** 找一行里的旗子按钮（每行都有：无优先级时是 opacity:0 的 ghost）。 */
const flagOf = (tree, id) => {
  const row = rowNode(tree, id);
  return row ? allNodes(row).find((n) => n.props?.['data-wt-priority-btn'] === 'true') : null;
};

/** 找一行里的勾选框（用 data 属性定位，避免误命中 wt-check-mark 的 svg）。 */
const checkOf = (tree, id) => {
  const row = rowNode(tree, id);
  return row ? allNodes(row).find((n) => n.props?.['data-wt-check-hit'] !== undefined) : null;
};

/** 找一行里的子节点（按 className 精确匹配某一个类）。 */
const inRow = (tree, id, className) => {
  const row = rowNode(tree, id);
  return row ? allNodes(row).find((n) => String(n.props?.className ?? '').split(' ').includes(className)) : null;
};

/** 四旗弹层里的四个按钮值（按渲染顺序）。 */
const priorityOptionValues = (tree) => allNodes(tree)
  .filter((n) => typeof n.props?.['data-wt-priority'] === 'string')
  .map((n) => n.props['data-wt-priority']);

/** 打开某个固定分组的「已完成」组（默认是折叠的，不打开就看不到里面的行）。 */
function openCompletedGroup(t) {
  const head = allNodes(renderPanel({ t }))
    .find((n) => String(n.props?.className ?? '').includes('wt-group-head') && textOf(n).includes('[groupCompleted]'));
  eq(Boolean(head), true, '面板上必须有「已完成」分组头：');
  head.props.onClick();
  return renderPanel({ t });
}

await test('四旗 UI 只有一份：快速添加与行内旗子共用同一个弹层实现（防两份漂移）', () => {
  const source = readFileSync(join(here, '..', 'src', 'client', 'index.js'), 'utf8');
  eq((source.match(/data-wt-priority-pop/g) ?? []).length, 1,
    '四旗弹层只允许有一处渲染实现（第二处 = 两份 UI 开始漂移）：');
  eq((source.match(/React\.createElement\(PriorityFlagsPopover/g) ?? []).length, 2,
    '快速添加 + 行内旗子各一处调用同一个组件：');
  eq(typeof mod.priorityFlagOptions, 'function', '四旗清单必须是可复用的纯函数：');
  eq(typeof mod.priorityColor, 'function');
  const t = mkT();
  eq(mod.priorityFlagOptions(t).map((f) => f.value), ['none', 'high', 'normal', 'low'], '四档顺序必须是 无/高/中/低：');
  eq(mod.priorityFlagOptions(t).map((f) => f.label), ['[prioNone]', '[prioHigh]', '[prioNormal]', '[prioLow]']);
  eq(mod.priorityColor('high') === mod.priorityColor('normal'), false, '高/中必须是两种颜色：');
  eq(mod.priorityColor('low'), mod.priorityColor('none'), '低/无同色（都是灰）：');
});

await testAsync('行内旗子：无优先级行默认 ghost，hover/focus 才淡出（组件状态），点开是四旗', async () => {
  document.visibilityState = 'visible';
  await settleList();
  const saved = fakeListPayload.data.groups.later[0].priority;
  // 把 wt-1 临时降成「无优先级」：这正是要验的那一档（默认不常显旗子）
  fakeListPayload.data.groups.later[0].priority = 'none';
  try {
    withStableHooks(() => {
      let tree = renderPanel({ t: mkT() });
      eq(rowNode(tree, 'wt-1')?.props['data-wt-row-priority'], 'none', '这一行现在是无优先级：');
      const ghost = flagOf(tree, 'wt-1');
      eq(Boolean(ghost), true, '无优先级的行也必须渲染旗子按钮（否则键盘 Tab 永远够不着它）：');
      eq(ghost.props['data-wt-ghost'], 'true', '默认是 ghost（不常显）：');
      eq(ghost.props.style?.opacity, 0, 'ghost 的旗子必须完全透明：');
      eq(String(ghost.props.className).includes('is-ghost'), true);
      eq(ghost.props['aria-expanded'], false, '收起时 aria-expanded=false：');

      // 鼠标悬停该行 → 出淡色空心旗（组件状态驱动的可见性）
      rowNode(tree, 'wt-1').props.onMouseEnter();
      tree = renderPanel({ t: mkT() });
      const hovered = flagOf(tree, 'wt-1');
      eq(hovered.props['data-wt-ghost'], undefined, '悬停该行时旗子必须现身：');
      eq(hovered.props.style?.opacity > 0 && hovered.props.style?.opacity < 1, true,
        `悬停现身的是「淡色」空心旗（opacity 应介于 0~1，实际 ${hovered.props.style?.opacity}）：`);

      // 移开 → 收回；纯键盘 focus 该行 → 同样现身（键盘可达）
      rowNode(tree, 'wt-1').props.onMouseLeave();
      tree = renderPanel({ t: mkT() });
      eq(flagOf(tree, 'wt-1').props['data-wt-ghost'], 'true', '鼠标移开后收回：');
      rowNode(tree, 'wt-1').props.onFocus();
      tree = renderPanel({ t: mkT() });
      eq(flagOf(tree, 'wt-1').props['data-wt-ghost'], undefined, 'focus 该行时旗子必须现身（纯键盘够得着）：');

      // 点开四旗
      flagOf(tree, 'wt-1').props.onClick();
      tree = renderPanel({ t: mkT() });
      const pop = allNodes(tree).find((n) => n.props?.['data-wt-priority-pop'] === 'true');
      eq(Boolean(pop), true, '点旗子必须弹出四旗选择器：');
      eq(priorityOptionValues(tree), ['none', 'high', 'normal', 'low'], '弹层里就是那四档：');
      eq(flagOf(tree, 'wt-1').props['aria-expanded'], true, '展开后 aria-expanded=true：');
      // Esc 关闭：弹层与旗子按钮两条路都要能关
      pop.props.onKeyDown({ key: 'Escape' });
      tree = renderPanel({ t: mkT() });
      eq(flagOf(tree, 'wt-1').props['aria-expanded'], false, '弹层上的 Esc 要能关闭：');
      eq(Boolean(allNodes(tree).find((n) => n.props?.['data-wt-priority-pop'] === 'true')), false, '关闭后弹层不该再渲染：');
      flagOf(tree, 'wt-1').props.onClick();
      tree = renderPanel({ t: mkT() });
      flagOf(tree, 'wt-1').props.onKeyDown({ key: 'Escape' });
      tree = renderPanel({ t: mkT() });
      eq(flagOf(tree, 'wt-1').props['aria-expanded'], false, '旗子按钮上的 Esc 也要能关闭：');
    });
  } finally {
    fakeListPayload.data.groups.later[0].priority = saved;
  }
});

await testAsync('行内旗子选「高」/「无」：发出 POST /worktodo/update，body 恰好是 {ref, priority}', async () => {
  document.visibilityState = 'visible';
  await settleList();
  const report = withStableHooks(() => {
    // 选「高」
    let tree = renderPanel({ t: mkT() });
    flagOf(tree, 'wt-1').props.onClick();
    tree = renderPanel({ t: mkT() });
    let before = fetchCalls.length;
    allNodes(tree).find((n) => n.props?.['data-wt-priority'] === 'high').props.onClick();
    const highPost = fetchCalls.slice(before).filter((c) => c.url.includes('/worktodo/update'));
    // 选完弹层要收起来
    tree = renderPanel({ t: mkT() });
    const popoverAfterPick = Boolean(allNodes(tree).find((n) => n.props?.['data-wt-priority-pop'] === 'true'));
    const expandedAfterPick = flagOf(tree, 'wt-1').props['aria-expanded'];

    // 再选「无」
    flagOf(tree, 'wt-1').props.onClick();
    tree = renderPanel({ t: mkT() });
    before = fetchCalls.length;
    allNodes(tree).find((n) => n.props?.['data-wt-priority'] === 'none').props.onClick();
    const nonePost = fetchCalls.slice(before).filter((c) => c.url.includes('/worktodo/update'));
    return {
      high: highPost.map((c) => JSON.parse(c.options.body)),
      none: nonePost.map((c) => JSON.parse(c.options.body)),
      highUrl: highPost[0]?.url ?? '',
      noneUrl: nonePost[0]?.url ?? '',
      popoverAfterPick,
      expandedAfterPick,
    };
  });
  eq(report.highUrl, '/worktodo/update', `必须 POST 到 /worktodo/update（不能整页刷新）：${report.highUrl}`);
  eq(report.high, [{ ref: 'wt-1', priority: 'high' }], '选「高」的报文：');
  eq(report.noneUrl, '/worktodo/update');
  eq(report.none, [{ ref: 'wt-1', priority: 'none' }], '选「无」的报文（none 必须原样发出去）：');
  eq(report.popoverAfterPick, false, '选中之后弹层必须关闭（不整页刷新，走 refresh 机制）：');
  eq(report.expandedAfterPick, false, '选中之后 aria-expanded 要回到 false：');
});

await testAsync('勾选框：视觉 26px、可点区域 ≥40×40、有 aria-label，点击仍走 onToggle（POST /status）', async () => {
  document.visibilityState = 'visible';
  await settleList();
  const report = withStableHooks(() => {
    const tree = renderPanel({ t: mkT() });
    const check = checkOf(tree, 'wt-1');
    eq(Boolean(check), true, '每行必须有勾选框：');
    const before = fetchCalls.length;
    check.props.onClick();
    const posts = fetchCalls.slice(before).filter((c) => c.url.includes('/worktodo/status'));
    return {
      size: check.props['data-wt-check-size'],
      hit: check.props['data-wt-check-hit'],
      label: check.props['aria-label'],
      type: check.type,
      posts: posts.map((c) => JSON.parse(c.options.body)),
      statusUrl: posts[0]?.url ?? '',
    };
  });
  // 尺寸来自同一处常量：渲染出来的属性、导出的常量、样式表三者必须一致
  eq(mod.CHECK_SIZE_PX, 26, '视觉尺寸应当是 26px：');
  eq(mod.CHECK_HIT_PX, 40, '可点区域必须 ≥40×40：');
  eq(report.size, 26, '渲染出来的勾选框尺寸：');
  eq(report.hit, 40, '渲染出来的可点区域：');
  eq(report.hit >= 40, true, '可点区域不得小于 40×40：');
  eq(report.type, 'button', '勾选框仍是原生 button（键盘可达）：');
  eq(typeof report.label === 'string' && report.label.length > 0, true, `必须有 aria-label：${report.label}`);
  // 样式表必须真的把这两个数字用上（不是只在节点上挂个属性）
  eq(mod.STYLE_TEXT.includes('width: 26px') && mod.STYLE_TEXT.includes('height: 26px'), true,
    '样式表里的勾选框尺寸必须与常量一致：');
  eq(mod.STYLE_TEXT.includes('inset: -7px'), true, '伪元素必须向外扩 7px（26+7×2=40）以满足可点区域：');
  eq(mod.STYLE_TEXT.includes('.wt-check:focus-visible'), true, '必须有可见的 focus ring：');
  eq(report.statusUrl, '/worktodo/status', `点击勾选框仍要触发 onToggle：${report.statusUrl}`);
  eq(report.posts, [{ ref: 'wt-1', toggle: true }], '勾选报文：');
});

/**
 * 从 STYLE_TEXT 里抠出某个选择器的声明块原文（B1 的几何护栏要用**真实 CSS 数值**，不是常量复述）。
 * @param {string} selector
 * @returns {string}
 */
function cssRule(selector) {
  const index = mod.STYLE_TEXT.indexOf(`${selector} {`);
  if (index === -1) throw new Error(`样式表里找不到 ${selector} 规则`);
  const end = mod.STYLE_TEXT.indexOf('}', index);
  return mod.STYLE_TEXT.slice(index, end);
}

/** 从声明块里取一个 px 数值（例如 min-height: 44px → 44）。 */
function cssPx(block, property) {
  const match = new RegExp(`${property}\\s*:\\s*(-?[\\d.]+)px`).exec(block);
  if (!match) throw new Error(`规则里找不到 ${property}: …px`);
  return Number(match[1]);
}

await test('B1（护栏）：行高 ≥ 命中盒高度，相邻两行的勾选框命中盒零重叠 —— 数值从**样式表原文**解析', () => {
  // 审查实跑几何：命中盒 40px、行高 33px → 相邻行命中盒重叠 7px，且下一行在上层 →
  // 点偏几像素就改错条目。So 这里不比对常量，而是解析 CSS 里的真实数字重算一遍：
  // 把 .wt-row 的 min-height 改回 33px 会立刻让 overlap > 0 → 用例变红。
  const rowBlock = cssRule('.wt-row');
  const checkBlock = cssRule('.wt-check');
  const beforeBlock = cssRule('.wt-check::before');
  const minHeight = cssPx(rowBlock, 'min-height');
  const paddingY = cssPx(rowBlock, 'padding');
  const marginTop = cssPx(checkBlock, 'margin');
  const size = cssPx(checkBlock, 'width');
  const inset = Math.abs(cssPx(beforeBlock, 'inset'));
  const hitHeight = size + inset * 2;
  const visualTop = paddingY + marginTop;
  const hitTop = visualTop - inset;
  const hitBottom = visualTop + size + inset;
  const nextHitTop = minHeight + hitTop;
  const overlap = Math.max(0, hitBottom - nextHitTop);
  const geometry = mod.checkHitGeometry();

  eq(size, mod.CHECK_SIZE_PX, '视觉尺寸要与常量一致：');
  eq(hitHeight >= 40, true, `命中盒高度必须 ≥40px（实际 ${hitHeight}）：`);
  eq(minHeight >= hitHeight, true, `B1：行高（${minHeight}）必须 ≥ 命中盒高度（${hitHeight}）：`);
  eq(overlap, 0, `B1：相邻两行的命中盒不许重叠（本行命中盒 y=[${hitTop},${hitBottom}]，下一行上沿 ${nextHitTop}）：`);
  eq(nextHitTop > hitBottom, true, `B1：相邻命中盒之间要有正间隙（实际 ${nextHitTop - hitBottom}px）：`);
  // 导出的几何助手必须与解析出来的 CSS 数值一致（否则护栏自己会和样式表漂移）
  eq(geometry.rowHeight, minHeight, 'checkHitGeometry 的行高要与样式表一致：');
  eq(geometry.hitHeight, hitHeight, 'checkHitGeometry 的命中盒高度要与样式表一致：');
  eq(geometry.overlap, 0, 'checkHitGeometry 也必须是零重叠：');
  console.log(`      [B1] 行高 ${minHeight}px / 视觉盒 ${size}px / 命中盒 ${size + inset * 2}×${hitHeight}px（y=[${hitTop},${hitBottom}]）`
    + ` / 下一行命中盒上沿 ${nextHitTop} / 重叠 ${overlap}px / 间隙 ${nextHitTop - hitBottom}px`);
});

await testAsync('勾选完成的动效：挂 is-celebrating / wt-check-celebrate / 对勾描边，动画结束自己摘掉', async () => {
  document.visibilityState = 'visible';
  await settleList();
  const report = withStableHooks(() => {
    let tree = renderPanel({ t: mkT() });
    const idle = inRow(tree, 'wt-1', 'is-celebrating');
    eq(Boolean(idle), false, '没勾之前不该有庆祝类：');
    eq(Boolean(inRow(tree, 'wt-1', 'wt-check-celebrate')), false);

    checkOf(tree, 'wt-1').props.onClick(); // 勾选 → 变为完成
    tree = renderPanel({ t: mkT() });
    const row = rowNode(tree, 'wt-1');
    const marked = inRow(tree, 'wt-1', 'wt-check-celebrate');
    const markedDone = inRow(tree, 'wt-1', 'wt-check-done');
    const markSvg = inRow(tree, 'wt-1', 'wt-check-mark');
    // B3：子元素（勾选框的 wt-check-pop / 描边）动画结束会**冒泡**到行；
    // 只认 currentTarget 的话，这类事件不得摘掉行的高亮类。
    const afterChildEnd = (() => {
      row.props.onAnimationEnd({
        target: marked ?? row, currentTarget: row, animationName: 'wt-check-pop',
      });
      return inRow(renderPanel({ t: mkT() }), 'wt-1', 'is-celebrating');
    })();
    // 没有事件对象的裸调用（防御性）同样不许当成「行自己的动画结束」
    const afterNoEvent = (() => {
      row.props.onAnimationEnd();
      return inRow(renderPanel({ t: mkT() }), 'wt-1', 'is-celebrating');
    })();
    const afterEnd = (() => {
      // 行自己的动画结束（还是同一个数据对象 → 乐观态有效）→ 摘类
      row.props.onAnimationEnd({ target: row, currentTarget: row, animationName: 'wt-row-celebrate' });
      const next = renderPanel({ t: mkT() });
      return inRow(next, 'wt-1', 'is-celebrating');
    })();
    return {
      celebrating: String(row.props.className).includes('is-celebrating'),
      dataFlag: row.props['data-wt-celebrating'],
      checkClass: marked ? String(marked.props.className) : '',
      done: Boolean(markedDone),
      hasMark: Boolean(markSvg),
      afterChildEnd: Boolean(afterChildEnd),
      afterNoEvent: Boolean(afterNoEvent),
      afterEnd: Boolean(afterEnd),
    };
  });
  eq(report.celebrating, true, '勾选完成时行上必须挂 is-celebrating：');
  eq(report.dataFlag, 'true', '动效状态要能被断言到（data-wt-celebrating）：');
  eq(report.checkClass.includes('wt-check-celebrate'), true, `勾选框要挂弹跳类：${report.checkClass}`);
  eq(report.done, true, '勾上时要立刻按已完成渲染（对勾才看得见描边动画）：');
  eq(report.hasMark, true, '对勾 svg 要带 wt-check-mark（描边动画挂在它上面）：');
  eq(report.afterChildEnd, true, 'B3：子元素（勾选框/描边）的 animationend 冒泡上来时，行的高亮类绝不能被提前摘掉：');
  eq(report.afterNoEvent, true, 'B3：没有事件对象的调用也不得摘类：');
  eq(report.afterEnd, false, '行自己的动画结束后必须自己摘掉类（不靠 JS 定时器）：');
});

await testAsync('B2：乐观完成态在服务端数据回来后必须回收（引用一变即失效），数据为 pending 时点击方向是「完成」', async () => {
  document.visibilityState = 'visible';
  await settleList();
  const savedLater = fakeListPayload.data.groups.later;
  try {
    const report = withStableHooks(() => {
      let tree = renderPanel({ t: mkT() });
      eq(checkOf(tree, 'wt-1').props['aria-label'], '[markDone]', '前提：wt-1 初始是 pending（语义 = 标记完成）：');

      checkOf(tree, 'wt-1').props.onClick(); // 勾上 → 乐观完成
      tree = renderPanel({ t: mkT() });
      const optimisticDone = Boolean(inRow(tree, 'wt-1', 'wt-check-done'));
      const optimisticCelebrate = Boolean(inRow(tree, 'wt-1', 'wt-check-celebrate'));

      // refresh/轮询把**新的**数据对象拿回来，而服务端状态仍是 pending
      fakeListPayload.data.groups.later = [{ ...savedLater[0], status: 'pending', updatedAt: 99, completedAt: null }];
      tree = renderPanel({ t: mkT() });
      const stillDone = Boolean(inRow(tree, 'wt-1', 'wt-check-done'));
      // 动效类与乐观态是两回事：560ms 的短动画可以继续跑完（B3 要求别提前摘），
      // 但「已完成」这个**状态**必须以服务端数据为准。
      const stillCelebrating = Boolean(inRow(tree, 'wt-1', 'is-celebrating'));
      const label = checkOf(tree, 'wt-1')?.props['aria-label'];

      const before = fetchCalls.length;
      checkOf(tree, 'wt-1').props.onClick();
      const posts = fetchCalls.slice(before).filter((c) => c.url.includes('/worktodo/status'))
        .map((c) => JSON.parse(c.options.body));
      // 行自己的动画跑完后，动效类必须自己摘掉（与乐观态无关）
      rowNode(tree, 'wt-1').props.onAnimationEnd({ target: rowNode(tree, 'wt-1'), currentTarget: rowNode(tree, 'wt-1'), animationName: 'wt-row-celebrate' });
      const afterAnimation = Boolean(inRow(renderPanel({ t: mkT() }), 'wt-1', 'is-celebrating'));
      return { optimisticDone, optimisticCelebrate, stillDone, stillCelebrating, label, posts, afterAnimation };
    });
    eq(report.optimisticDone, true, '点下去要立刻按已完成渲染（对勾/描边动画才看得到）：');
    eq(report.optimisticCelebrate, true, '同时也挂弹跳类：');
    eq(report.stillDone, false, 'B2：数据回来后必须清除乐观态（以服务端 pending 为准），不得一直显示为已完成：');
    eq(report.stillCelebrating, true, 'B2/B3：短动效可以跑完（不因数据回来被提前摘掉），回收的是「状态」而不是动画：');
    eq(report.afterAnimation, false, '动效跑完后行要自己摘类：');
    eq(report.label, '[markDone]', 'B2：显示为 pending 时语义必须是「标记完成」，点击方向才是 completed：');
    eq(report.posts, [{ ref: 'wt-1', toggle: true }], 'B2：点击发的是 toggle（服务端 pending → completed，方向正确）：');
  } finally {
    fakeListPayload.data.groups.later = savedLater;
  }
});

await testAsync('取消完成（completed → pending）绝不播庆祝动画', async () => {
  document.visibilityState = 'visible';
  await settleList();
  const report = withStableHooks(() => {
    let tree = openCompletedGroup(mkT()); // 「已完成」默认折叠，先展开
    const doneRow = rowNode(tree, 'wt-2');
    eq(Boolean(doneRow), true, '展开后必须看得到已完成的行：');
    const before = String(doneRow.props.className);
    checkOf(tree, 'wt-2').props.onClick(); // 取消完成
    tree = renderPanel({ t: mkT() });
    const after = rowNode(tree, 'wt-2');
    return {
      before,
      checking: String(after.props.className).includes('is-celebrating'),
      dataFlag: after.props['data-wt-celebrating'],
      checkClass: String(checkOf(tree, 'wt-2')?.props?.className ?? ''),
    };
  });
  eq(report.before.includes('is-celebrating'), false, '取消之前本来就不该有动效类：');
  eq(report.checking, false, '取消完成时不许挂 is-celebrating：');
  eq(report.dataFlag, undefined, '取消完成时 data-wt-celebrating 不该出现：');
  eq(report.checkClass.includes('wt-check-celebrate'), false, '取消完成时勾选框不许挂弹跳类：');
});

await testAsync('config.celebrate === false：勾选完成只做状态切换，一点动效都不挂', async () => {
  document.visibilityState = 'visible';
  await settleList();
  const savedPanel = fakeListPayload.data.panel;
  fakeListPayload.data.panel = { celebrate: false };
  try {
    eq(mod.shouldCelebrate({ celebrate: false }), false, '显式 false 必须关掉：');
    eq(mod.shouldCelebrate({}), true, '缺省 = 开（老宿主/精简载荷不该把行为悄悄关掉）：');
    eq(mod.shouldCelebrate(undefined), true);
    const report = withStableHooks(() => {
      let tree = renderPanel({ t: mkT() });
      checkOf(tree, 'wt-1').props.onClick();
      tree = renderPanel({ t: mkT() });
      const row = rowNode(tree, 'wt-1');
      return {
        className: String(row.props.className),
        dataFlag: row.props['data-wt-celebrating'],
        checkClass: String(checkOf(tree, 'wt-1')?.props?.className ?? ''),
        done: String(checkOf(tree, 'wt-1')?.props?.className ?? '').includes('wt-check-done'),
      };
    });
    eq(report.className.includes('is-celebrating'), false, '关掉后不许挂行级动效类：');
    eq(report.dataFlag, undefined, '关掉后 data-wt-celebrating 不该出现：');
    eq(report.checkClass.includes('wt-check-celebrate'), false, '关掉后不许挂勾选框动效类：');
    eq(report.done, false, '关掉后连乐观勾选态都不挂（行为与改动前完全一致）：');
  } finally {
    fakeListPayload.data.panel = savedPanel;
  }
});

await testAsync('prefers-reduced-motion: 系统要求减少动效时连动效类都不挂（CSS 侧另有兜底）', async () => {
  document.visibilityState = 'visible';
  await settleList();
  const savedMatchMedia = globalThis.window.matchMedia;
  globalThis.window.matchMedia = () => ({ matches: true });
  try {
    eq(mod.prefersReducedMotion(), true, 'matchMedia 命中时应当是 true：');
    const report = withStableHooks(() => {
      let tree = renderPanel({ t: mkT() });
      checkOf(tree, 'wt-1').props.onClick();
      tree = renderPanel({ t: mkT() });
      return {
        className: String(rowNode(tree, 'wt-1').props.className),
        checkClass: String(checkOf(tree, 'wt-1')?.props?.className ?? ''),
      };
    });
    eq(report.className.includes('is-celebrating'), false, '减少动效时不许挂行级动效类：');
    eq(report.checkClass.includes('wt-check-celebrate'), false, '减少动效时不许挂勾选框动效类：');
    // CSS 侧的第二道保险：@media (prefers-reduced-motion: reduce) 里把动画全部关掉
    eq(mod.STYLE_TEXT.includes('@media (prefers-reduced-motion: reduce)'), true, 'CSS 必须有 reduced-motion 降级：');
    eq(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/.test(mod.STYLE_TEXT), true,
      '降级块里必须真的把 animation 关掉：');
    // 动效总时长必须「从容但不拖沓」：1.1–1.3s，且刷新排在动画之后
    eq(mod.CELEBRATE_MS >= 1100 && mod.CELEBRATE_MS <= 1300, true,
      `庆祝动效总时长必须落在 1.1–1.3s（实际 ${mod.CELEBRATE_MS}ms）：`);
    eq(mod.CELEBRATE_REFRESH_MS > mod.CELEBRATE_MS, true,
      '刷新必须排在动画结束之后（早一帧都会把最后一帧截掉）：');
    eq(mod.STYLE_TEXT.includes(`${mod.CHECK_POP_MS}ms`), true, '勾选框时长要写死在样式表里（便于审计）：');
    eq(mod.STYLE_TEXT.includes('stroke-dashoffset'), true, '对勾必须是描边出现（stroke-dashoffset 动画）：');
    eq(mod.STYLE_TEXT.includes('stroke-dasharray'), true);
  } finally {
    globalThis.window.matchMedia = savedMatchMedia;
  }
});

/* ------------------------------------------------------------------ *
 * 完成动效的「从容」调校（本轮）
 *
 * 旧实现：勾选框 320ms 弹跳 / 描边 300ms / 整行 560ms，且写成功立刻 refresh，
 * 动画还没播完行就被重新归组 —— 观感就是「一闪而过」。
 * 这里钉住三件事：节拍常量、刷新被延后、降级路径仍然立即刷新。
 * 反向验证：把 620ms 改回 320ms → 第一节变红；把延后刷新改回立即 → 第二节变红。
 * ------------------------------------------------------------------ */

console.log('完成动效调校：节拍 / 延迟刷新 / 降级立即刷新 / 清理');

await testAsync('完成动效节拍：勾选框 600–700ms、对勾 480–560ms 且 delay>0、整行 1000–1300ms', async () => {
  const style = mod.STYLE_TEXT;
  const pop = /\.wt-check-celebrate \{ animation: wt-check-pop (\d+)ms ([^;]+); \}/.exec(style);
  const mark = /animation: wt-mark-draw (\d+)ms ([^\s;]+) (\d+)ms/.exec(style);
  const row = /animation: wt-row-celebrate (\d+)ms ([^\s;]+) (\d+)ms/.exec(style);
  const title = /animation: wt-title-settle (\d+)ms ([^\s;]+) (\d+)ms/.exec(style);

  eq(Boolean(pop), true, '样式表里必须找得到 wt-check-pop 的 animation 声明：');
  eq(Boolean(mark), true, '样式表里必须找得到 wt-mark-draw 的 animation 声明：');
  eq(Boolean(row), true, '样式表里必须找得到 wt-row-celebrate 的 animation 声明：');
  eq(Boolean(title), true, '样式表里必须找得到 wt-title-settle 的 animation 声明：');

  const popMs = Number(pop[1]);
  const markMs = Number(mark[1]);
  const markDelay = Number(mark[3]);
  const rowMs = Number(row[1]);
  const rowDelay = Number(row[3]);
  const titleMs = Number(title[1]);

  eq(popMs >= 600 && popMs <= 700, true, `勾选框时长必须在 600–700ms（实际 ${popMs}ms）：`);
  eq(popMs, mod.CHECK_POP_MS, '样式表与导出的 CHECK_POP_MS 必须一致：');
  eq(markMs >= 480 && markMs <= 560, true, `对勾描边时长必须在 480–560ms（实际 ${markMs}ms）：`);
  eq(markMs, mod.MARK_DRAW_MS, '样式表与导出的 MARK_DRAW_MS 必须一致：');
  eq(markDelay > 0, true, `对勾必须有正延迟（实际 ${markDelay}ms）：`);
  eq(markDelay, mod.MARK_DRAW_DELAY_MS, '样式表与导出的 MARK_DRAW_DELAY_MS 必须一致：');
  eq(rowMs >= 1000 && rowMs <= 1300, true, `整行过渡时长必须在 1000–1300ms（实际 ${rowMs}ms）：`);
  eq(rowMs, mod.ROW_CELEBRATE_MS, '样式表与导出的 ROW_CELEBRATE_MS 必须一致：');
  eq(rowDelay, mod.ROW_CELEBRATE_DELAY_MS, '整行延迟必须来自常量：');
  eq(titleMs, mod.TITLE_SETTLE_MS, '标题变灰时长必须来自常量：');
  eq(mod.CELEBRATE_MS, rowDelay + rowMs, 'CELEBRATE_MS 必须是「整行 delay + duration」：');
  eq(mod.CELEBRATE_REFRESH_MS > mod.CELEBRATE_MS, true, '刷新延迟必须晚于动画结束：');
  eq(mod.CELEBRATE_REFRESH_MS <= mod.CELEBRATE_MS + 200, true, '刷新延迟不能拖得太久（落位要跟手）：');

  // 缓动：柔和收尾，不许再有回弹过冲
  eq(pop[2].includes('cubic-bezier(0.22, 0.61, 0.36, 1)') || pop[2].includes('ease-out'), true,
    `勾选框缓动必须柔和（实际 ${pop[2]}）：`);
  eq(/1\.56/.test(pop[2]), false, `勾选框缓动不许带过冲回弹（实际 ${pop[2]}）：`);
  eq(style.includes('scale(1.06)'), true, '勾选框只做 1 → 1.06 → 1 的轻微呼吸：');
  eq(style.includes('scale(1.32)'), false, '不许再出现 1.32 那种弹跳：');
  // 整行背景必须缓慢淡出，标题颜色走主题里的柔和灰
  eq(/wt-row-celebrate[\s\S]*?100% \{ background: transparent; \}/.test(style), true,
    '整行背景必须淡出到透明（不能一眼就没）：');
  eq(/wt-title-settle[\s\S]*?to \{ color: var\(--dsw-alias-label-tertiary\); \}/.test(style), true,
    '标题必须过渡到主题的 label-tertiary：');
  eq(mod.STYLE_TEXT.includes('stroke-dashoffset'), true, '对勾必须是 stroke-dashoffset 描边动画：');
});

await testAsync('刷新被延后：完成动效播完前不刷新，假定时器推进后恰好刷新一次', async () => {
  document.visibilityState = 'visible';
  await settleList();
  const clock = installFakeTimers();
  try {
    await withStableHooksAsync(async () => {
      const t = mkT();
      const tree = renderPanel({ t });
      const tickSlot = tickSlotId(tree);
      const before = slotUpdateCount(tickSlot);
      const statusBefore = fetchCalls.filter((call) => call.url.includes('/worktodo/status')).length;

      checkOf(tree, 'wt-1').props.onClick(); // 勾选完成 → 播动效
      await clock.flush();

      const statusPosts = fetchCalls.filter((call) => call.url.includes('/worktodo/status'))
        .slice(statusBefore);
      eq(statusPosts.length, 1, `写请求必须只发一次（实际 ${statusPosts.length}）：`);
      eq(JSON.parse(statusPosts[0].options.body), { ref: 'wt-1', toggle: true }, '写报文必须仍是 toggle：');

      const pending = clock.timers.filter((handle) => !handle.cleared);
      eq(clock.timers.length, 1, `完成写入后只该排一个待刷新定时器（实际 ${clock.timers.length}）：`);
      eq(pending.length, 1, '动画播完前定时器必须还挂着（绝不许写成功就刷新）：');
      eq(pending[0].ms, mod.CELEBRATE_REFRESH_MS, '延后时长必须是 CELEBRATE_REFRESH_MS：');
      eq(pending[0].ms >= mod.CELEBRATE_MS, true, '刷新不得早于动画总时长：');
      eq(slotUpdateCount(tickSlot) - before, 0,
        `动画结束前刷新发生了 ${slotUpdateCount(tickSlot) - before} 次（必须为 0）：`);

      pending[0].fn(); // 假定时器推进到「动画播完」
      await clock.flush();
      eq(pending[0].cleared, false, '触发后的定时器不应再被当成待清理：');
      eq(slotUpdateCount(tickSlot) - before, 1, '假定时器推进后必须恰好刷新一次：');
    });
  } finally {
    clock.restore();
  }
});

await testAsync('reduced-motion / celebrate:false：不排延迟定时器，写完立即刷新', async () => {
  document.visibilityState = 'visible';
  await settleList();
  const savedMatchMedia = globalThis.window.matchMedia;
  const savedPanel = fakeListPayload.data.panel;

  // 1) 系统要求减少动态效果
  globalThis.window.matchMedia = () => ({ matches: true });
  const reduceClock = installFakeTimers();
  try {
    await withStableHooksAsync(async () => {
      const t = mkT();
      renderPanel({ t });
      await reduceClock.flush();
      const tree = renderPanel({ t });
      const tickSlot = tickSlotId(tree);
      const before = slotUpdateCount(tickSlot);
      checkOf(tree, 'wt-1').props.onClick();
      await reduceClock.flush();
      eq(reduceClock.timers.length, 0, 'reduced-motion 不许排延迟刷新定时器：');
      eq(slotUpdateCount(tickSlot) - before, 1, 'reduced-motion 必须写完立即刷新一次：');
      const after = renderPanel({ t: mkT() });
      eq(Boolean(inRow(after, 'wt-1', 'is-celebrating')), false, 'reduced-motion 不许挂动效类：');
    });
  } finally {
    reduceClock.restore();
    globalThis.window.matchMedia = savedMatchMedia;
  }

  // 2) config.celebrate = false
  fakeListPayload.data.panel = { celebrate: false };
  const quietClock = installFakeTimers();
  try {
    await withStableHooksAsync(async () => {
      const t = mkT();
      renderPanel({ t });
      await quietClock.flush();
      const tree = renderPanel({ t });
      const tickSlot = tickSlotId(tree);
      const before = slotUpdateCount(tickSlot);
      checkOf(tree, 'wt-1').props.onClick();
      await quietClock.flush();
      eq(quietClock.timers.length, 0, 'celebrate:false 不许排延迟刷新定时器：');
      eq(slotUpdateCount(tickSlot) - before, 1, 'celebrate:false 必须写完立即刷新一次：');
    });
  } finally {
    quietClock.restore();
    fakeListPayload.data.panel = savedPanel;
  }
});

await testAsync('连续点击：第二次点击取消上一段待刷新，并立即刷新', async () => {
  document.visibilityState = 'visible';
  await settleList();
  const clock = installFakeTimers();
  try {
    await withStableHooksAsync(async () => {
      const t = mkT();
      let tree = renderPanel({ t });
      const tickSlot = tickSlotId(tree);
      const before = slotUpdateCount(tickSlot);

      checkOf(tree, 'wt-1').props.onClick(); // 第一次：完成 → 延迟刷新
      await clock.flush();
      eq(clock.timers.filter((handle) => !handle.cleared).length, 1, '前提：第一次完成已经排了一个待刷新：');

      // 换一个 t 身份强制行 body 重跑（memo 浅比较否则会直接复用点击前的树）
      tree = renderPanel({ t: mkT() }); // 乐观完成态生效，第二次点击语义变成「取消完成」
      eq(checkOf(tree, 'wt-1').props['aria-label'], '[unmarkDone]', '前提：第二次点击是取消完成：');
      checkOf(tree, 'wt-1').props.onClick();
      await clock.flush();

      eq(clock.timers[0].cleared, true, '第二次点击必须取消第一次的待刷新定时器：');
      eq(clock.timers.filter((handle) => !handle.cleared).length, 0, '取消完成不排新的延迟刷新：');
      eq(slotUpdateCount(tickSlot) - before, 1, '取消完成必须立即刷新一次（不等动画）：');
    });
  } finally {
    clock.restore();
  }
});

await testAsync('写失败：取消延迟刷新并立即刷新，不留在假完成态', async () => {
  document.visibilityState = 'visible';
  await settleList();
  const clock = installFakeTimers();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    if (String(url).includes('/worktodo/status')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: false, error: 'boom' }),
      });
    }
    return realFetch(url, options);
  };
  globalThis.window.fetch = globalThis.fetch;
  try {
    await withStableHooksAsync(async () => {
      const t = mkT();
      const tree = renderPanel({ t });
      const tickSlot = tickSlotId(tree);
      const before = slotUpdateCount(tickSlot);
      checkOf(tree, 'wt-1').props.onClick();
      await clock.flush();

      eq(clock.timers.length, 0, '写失败不许留下延迟刷新定时器：');
      eq(slotUpdateCount(tickSlot) - before, 1, '写失败必须立即刷新一次：');
      const after = renderPanel({ t: mkT() });
      eq(Boolean(inRow(after, 'wt-1', 'is-celebrating')), false, '写失败必须摘掉动效类：');
    });
  } finally {
    clock.restore();
    globalThis.fetch = realFetch;
    globalThis.window.fetch = realFetch;
  }
});

await testAsync('卸载：待刷新定时器会被清理（不留悬空回调）', async () => {
  document.visibilityState = 'visible';
  await settleList();
  const clock = installFakeTimers();
  try {
    await withStableHooksAsync(async () => {
      const t = mkT();
      const tree = renderPanel({ t });
      checkOf(tree, 'wt-1').props.onClick();
      await clock.flush();
      eq(clock.timers.filter((handle) => !handle.cleared).length, 1, '前提：完成写入后排了一个待刷新：');

      // React 卸载时会调用每个 effect 的清理函数；这里把收集到的清理函数跑一遍
      for (const cleanup of [...effectCleanups]) {
        try { cleanup(); } catch { /* 单个清理失败不影响结论 */ }
      }
      eq(clock.timers[0].cleared, true, '卸载必须 clearTimeout 掉待刷新定时器：');
      eq(clock.timers.filter((handle) => !handle.cleared).length, 0, '卸载后不许再有活着的待刷新定时器：');
    });
  } finally {
    clock.restore();
  }
});

console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error?.stack ?? f.error}`);
  process.exit(1);
}
