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
        stateUpdates.push(next);
        slot.value = typeof next === 'function' ? next(slot.value) : next;
      }];
    }
    return [typeof init === 'function' ? init() : init, (next) => { stateUpdates.push(next); }];
  },
  useReducer: (reducer, init) => {
    hookSlotId();
    return [typeof init === 'function' ? init() : init, (next) => { stateUpdates.push(next); }];
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
  hookCache.clear();
  memoStores.clear();
  for (const type of memoizedTypes) {
    type.__meta.renders = 0;
    type.__meta.bailouts = 0;
    type.__meta.lastNode = null;
  }
  stableHooks = true;
  try {
    return run();
  } finally {
    stableHooks = false;
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

test('updateBadgeState：有新版=可点，进行中/已完成/失败/linked 各有正确形态', () => {
  eq(typeof mod.updateBadgeState, 'function', '面板应当导出升级徽标状态函数：');
  // 只给「已更新到 {version}」这个带占位符的文案真身，其余返回 key，便于断言
  const t = (key) => (key === 'updatedRestart' ? '已更新到 {version}，重启 DSH 生效' : key);

  const idle = mod.updateBadgeState({ state: 'idle' }, { hasUpdate: true, latest: '0.2.4' }, t);
  eq(idle.action, 'update', '有新版必须可点：');
  eq(idle.disabled, false);
  eq(idle.text.includes('0.2.4'), true, `要显示新版本号：${idle.text}`);
  eq(idle.text.includes('updateNow'), true, `要明确写「立即更新」：${idle.text}`);

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
  eq(failed.action, 'retry', '失败必须能重试：');
  eq(failed.text.includes('安装命令退出码 3'), true, `失败原因要显示出来：${failed.text}`);

  eq(mod.updateBadgeState({ state: 'idle' }, { hasUpdate: false }, t), null, '没新版、没在升级时不该渲染这一格：');
  eq(mod.updateBadgeState(null, null, t), null);
});

test('页脚：有新版时渲染成可点的按钮（不是只读 span），进行中则禁用并改文案', () => {
  const t = (key) => key;
  const previous = fakeListPayload.data.update;
  try {
    fakeListPayload.data.update = { current: '0.2.0', latest: '0.2.4', hasUpdate: true, run: { state: 'idle' } };
    const ready = flattenTree(renderPanel({ t }))
      .filter((n) => n.type === 'button' && String(n.props?.className ?? '').includes('wt-update'));
    eq(ready.length, 1, `页脚必须渲染恰好一个升级按钮：${ready.length}`);
    eq(typeof ready[0].props.onClick, 'function', '升级按钮必须真的挂了点击处理：');
    eq(ready[0].props.disabled, false, '有新版时可点：');
    eq(textOf(ready[0]).includes('0.2.4'), true, `徽标要显示新版本：${textOf(ready[0])}`);
    eq(textOf(ready[0]).includes('updateNow'), true, `要写「立即更新」：${textOf(ready[0])}`);

    fakeListPayload.data.update = { current: '0.2.0', latest: '0.2.4', hasUpdate: true, run: { state: 'running', to: '0.2.4' } };
    const busy = flattenTree(renderPanel({ t }))
      .filter((n) => n.type === 'button' && String(n.props?.className ?? '').includes('wt-update'));
    eq(busy.length, 1);
    eq(busy[0].props.disabled, true, '更新中必须禁用按钮：');
    eq(textOf(busy[0]).includes('updating'), true, `更新中要变成「正在更新…」：${textOf(busy[0])}`);
  } finally {
    fakeListPayload.data.update = previous;
  }
});

console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error?.stack ?? f.error}`);
  process.exit(1);
}
