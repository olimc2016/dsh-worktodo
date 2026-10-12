import React from 'react';

/**
 * worktodo 浏览器半侧：DSH 侧栏入口 + 中栏「工作待办」面板。
 *
 * 数据来源只有一处：同源的 /worktodo/* 路由（宿主半侧 lib/index.js 注册）。
 * 所有路由都返回 HTTP 200，成功与否看 body 里的 `ok` 字段——所以判定条件写在
 * `!body.ok` 上，而不是 `response.ok`：只看 HTTP 状态码会把「标题为空」这类
 * 业务失败当成网络故障，用户就看不到真正的原因了。
 *
 * 为什么会话待办要单独拆一个子组件：
 * 官方会话 todos 来自 `props.useProjection('todos')`，而 useProjection 是 hook——
 * 面板注册在 root scope，某些组合下 props 里根本没有它。hook 的调用次数在组件实例
 * 生命周期内必须恒定，所以「有没有 useProjection」这个条件只能决定**整块要不要挂载**，
 * 不能写在同一个组件内部。见 SessionAdopt。
 *
 * 样式：只用 DSH 自己的 --dsw-* 主题变量（不写任何颜色字面量），
 * 所以深浅主题、以及以后换主题皮肤时都天然跟着走。类名统一 wt- 前缀，
 * 样式表跟着面板一起渲染（挂在面板自己那棵 DOM 里的 style 节点，不碰面板之外的页面）。
 */

const PKG_NAME = typeof __DSH_PLUGIN_NAME__ === 'string' ? __DSH_PLUGIN_NAME__ : 'dsh-worktodo';
/**
 * 宿主半侧的 name / 路由前缀是写死的 'worktodo'（lib/index.js），而侧栏 slot id 又必须与
 * main 面板的 key 同名，否则点了侧栏打不开面板。所以短名以包名派生为主，
 * 但一旦派生值不是宿主认的那个名字就退回 'worktodo'——包名带后缀时宁可面板能开。
 */
const DERIVED_NAME = PKG_NAME.replace(/^dsh-/, '');
const SHORT_NAME = DERIVED_NAME === 'worktodo' ? DERIVED_NAME : 'worktodo';
const SLOT_ID = SHORT_NAME;
const ROUTE_BASE = `/${SHORT_NAME}`;
const LOCALE_NS = SHORT_NAME;
const ROUTE_LIST = `${ROUTE_BASE}/list`;

/* ------------------------------------------------------------------ *
 * 文案：zh / en 两份 key 必须一一对应（宿主按 key 取词，缺 key 会显示 key 本身）
 * ------------------------------------------------------------------ */
const zh = {
  'nav': '待办',
  'title': '工作待办',
  'statOpen': '未完成',
  'statOverdue': '逾期',
  'statToday': '今天',
  'statDoing': '进行中',
  'statDoneToday': '今日完成',
  'refresh': '刷新',
  'loading': '读取待办…',
  'failed': '读取失败',
  'retry': '重试',
  'dismiss': '关闭',
  'storeAt': '存储位置',
  'storeDomain': '官方 storage',
  'storeFile': 'JSON 文件',
  'addPlaceholder': '加一件要做的事，回车保存',
  'add': '添加',
  'dueLabel': '截止',
  'priorityLabel': '优先级',
  'prioHigh': '高',
  'prioNormal': '普通',
  'prioLow': '低',
  'groupOverdue': '逾期',
  'groupToday': '今天',
  'groupWeek': '本周',
  'groupLater': '以后',
  'groupCompleted': '已完成',
  'viewDue': '按截止',
  'viewProject': '按项目',
  'noProject': '未归类',
  'sortLabel': '排序',
  'sortManual': '手动',
  'sortPriority': '优先级',
  'sortCreated': '创建时间',
  'dragHint': '拖动调整顺序（会自动切到手动排序）',
  'expand': '展开',
  'collapse': '收起',
  'empty': '还没有待办',
  'emptyHint': '在上面输入框加第一件事',
  'overdueTag': '逾期',
  'sourceAgent': 'AI',
  'sourceSession': '会话',
  'markDone': '标为完成',
  'unmarkDone': '取消完成',
  'editHint': '点击标题可编辑',
  'deleteBtn': '删除',
  'confirmDelete': '确认删除？',
  'save': '保存',
  'cancel': '取消',
  'projectLabel': '项目',
  'projectPlaceholder': '项目名（可选）',
  'titlePlaceholder': '待办标题',
  'notesLabel': '备注',
  'notesPlaceholder': '备注（可选）',
  'notesAdd': '加备注',
  'notesHide': '收起备注',
  'adoptPre': '把本会话的',
  'adoptPost': '条待办提升为工作待办',
  'adoptHint': '这是模型在本会话里列的待办。提升后归你所有：跨会话保留，还能加优先级和截止日期。',
  'adoptPending': '待完成',
  'adoptDone': '已提升',
  'adoptSkipped': '跳过',
  'titleEmpty': '请先写点什么',
  'untitled': '（无标题）',
};

const en = {
  'nav': 'To-dos',
  'title': 'Work to-dos',
  'statOpen': 'Open',
  'statOverdue': 'Overdue',
  'statToday': 'Today',
  'statDoing': 'In progress',
  'statDoneToday': 'Done today',
  'refresh': 'Refresh',
  'loading': 'Loading to-dos…',
  'failed': 'Failed to load',
  'retry': 'Retry',
  'dismiss': 'Dismiss',
  'storeAt': 'Stored at',
  'storeDomain': 'official storage',
  'storeFile': 'JSON file',
  'addPlaceholder': 'Add something to do — Enter saves',
  'add': 'Add',
  'dueLabel': 'Due',
  'priorityLabel': 'Priority',
  'prioHigh': 'High',
  'prioNormal': 'Normal',
  'prioLow': 'Low',
  'groupOverdue': 'Overdue',
  'groupToday': 'Today',
  'groupWeek': 'This week',
  'groupLater': 'Later',
  'groupCompleted': 'Completed',
  'viewDue': 'By due',
  'viewProject': 'By project',
  'noProject': 'Uncategorized',
  'sortLabel': 'Sort',
  'sortManual': 'Manual',
  'sortPriority': 'Priority',
  'sortCreated': 'Created',
  'dragHint': 'Drag to reorder (switches to manual sort)',
  'expand': 'Expand',
  'collapse': 'Collapse',
  'empty': 'No to-dos yet',
  'emptyHint': 'Add your first one in the box above',
  'overdueTag': 'overdue',
  'sourceAgent': 'AI',
  'sourceSession': 'Session',
  'markDone': 'Mark as done',
  'unmarkDone': 'Mark as not done',
  'editHint': 'Click the title to edit',
  'deleteBtn': 'Delete',
  'confirmDelete': 'Delete?',
  'save': 'Save',
  'cancel': 'Cancel',
  'projectLabel': 'Project',
  'projectPlaceholder': 'project (optional)',
  'titlePlaceholder': 'To-do title',
  'notesLabel': 'Notes',
  'notesPlaceholder': 'Notes (optional)',
  'notesAdd': 'Add notes',
  'notesHide': 'Hide notes',
  'adoptPre': "Promote this session's ",
  'adoptPost': ' to-dos into your work list',
  'adoptHint': 'These are the to-dos the model listed in this session. Promoting makes them yours: they survive across sessions and take priorities and due dates.',
  'adoptPending': 'open',
  'adoptDone': 'Promoted',
  'adoptSkipped': 'skipped',
  'titleEmpty': 'Type something first',
  'untitled': '(untitled)',
};

/* ------------------------------------------------------------------ *
 * 颜色：只取 DSH 主题变量。
 * 不写任何颜色字面量兜底——兜底值等于写死某一种主题下的颜色，另一套主题就花了。
 * 需要「淡淡的底色」时用 color-mix 把语义色混进 transparent，仍然是变量驱动。
 * ------------------------------------------------------------------ */
const C = {
  label: 'var(--dsw-alias-label-primary)',
  label2: 'var(--dsw-alias-label-secondary)',
  label3: 'var(--dsw-alias-label-tertiary)',
  border: 'var(--dsw-alias-border-l2)',
  border1: 'var(--dsw-alias-border-l1)',
  layer1: 'var(--dsw-alias-bg-layer-1)',
  hover: 'var(--dsw-alias-interactive-bg-hover)',
  brand: 'var(--dsw-alias-brand-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
  ok: 'var(--dsw-alias-state-success-primary)',
};
/** 语义色的淡底/淡边：pct 是混入比例 */
const tint = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

/** 面板自带样式表：几何字面量（间距/字号/圆角）写死，颜色全部走变量。 */
const STYLE_TEXT = `
@keyframes wt-spin { to { transform: rotate(360deg); } }
.wt-root {
  height: 100%; overflow: auto; padding: 16px 18px 40px; box-sizing: border-box;
  color: ${C.label}; font-family: var(--dsw-font-family, system-ui, sans-serif); font-size: 13px;
}
.wt-input {
  min-width: 0; font-family: inherit; font-size: 12px; line-height: 1.5; padding: 4px 8px;
  border-radius: 8px; border: 1px solid ${C.border}; background: transparent; color: ${C.label};
  color-scheme: light dark;
}
.wt-input::placeholder { color: ${C.label3}; }
.wt-input:focus {
  outline: none; border-color: ${C.brand};
  box-shadow: 0 0 0 2px ${tint(C.brand, 22)};
}
.wt-btn {
  display: inline-flex; align-items: center; gap: 4px; font-family: inherit; font-size: 12px;
  line-height: 1.6; padding: 3px 10px; border-radius: 8px; cursor: pointer; user-select: none;
  border: 1px solid ${C.border}; background: transparent; color: ${C.label2}; white-space: nowrap;
}
.wt-btn:hover { background: ${C.hover}; color: ${C.label}; }
.wt-btn:disabled { opacity: .55; cursor: default; }
.wt-btn:disabled:hover { background: transparent; color: ${C.label2}; }
.wt-btn-primary {
  border-color: ${tint(C.brand, 50)}; color: ${C.brand}; background: ${tint(C.brand, 10)};
}
.wt-btn-primary:hover { background: ${tint(C.brand, 18)}; color: ${C.brand}; }
.wt-btn-primary:disabled:hover { background: ${tint(C.brand, 10)}; color: ${C.brand}; }
.wt-btn-danger { color: ${C.error}; border-color: ${tint(C.error, 45)}; }
.wt-btn-danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); color: ${C.error}; }
.wt-icon-btn {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 22px; height: 22px; padding: 0; border: none; border-radius: 6px;
  background: transparent; color: ${C.label3}; cursor: pointer;
}
.wt-icon-btn:hover { background: ${C.hover}; color: ${C.label}; }
.wt-icon-btn-danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); color: ${C.error}; }
.wt-check {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 17px; height: 17px; margin-top: 1px; padding: 0; border-radius: 5px;
  border: 1px solid ${C.border}; background: transparent; color: transparent; cursor: pointer;
}
.wt-check:hover { border-color: ${C.brand}; }
.wt-check-done {
  border-color: ${tint(C.ok, 55)}; background: ${tint(C.ok, 14)}; color: ${C.ok};
}
.wt-row { display: flex; align-items: flex-start; gap: 8px; padding: 5px 8px; border-radius: 10px; }
.wt-row:hover { background: ${C.hover}; }
.wt-row-edit {
  flex-direction: column; align-items: stretch; gap: 6px;
  border: 1px solid ${C.border1}; background: ${C.layer1};
}
.wt-seg {
  display: inline-flex; align-items: center; border-radius: 8px; overflow: hidden;
  border: 1px solid ${C.border}; background: ${C.bg2};
}
.wt-seg-btn {
  appearance: none; border: 0; background: transparent; color: ${C.label2};
  font: inherit; font-size: 11.5px; line-height: 1; padding: 5px 9px; cursor: pointer;
}
.wt-seg-btn.is-on { background: ${C.hover}; color: ${C.label}; font-weight: 600; }
.wt-seg-btn:hover { color: ${C.label}; }
.wt-row[draggable="true"] { cursor: grab; }
.wt-row[draggable="true"]:active { cursor: grabbing; }
.wt-group-head {
  display: flex; align-items: center; gap: 7px; padding: 3px 8px; border-radius: 8px;
  cursor: pointer; user-select: none; color: ${C.label2};
}
.wt-group-head:hover { background: ${C.hover}; }
.wt-chip {
  display: inline-flex; align-items: baseline; gap: 4px; font-size: 11px; line-height: 1.7;
  padding: 0 8px; border-radius: 999px; border: 1px solid ${C.border1}; color: ${C.label3};
  white-space: nowrap;
}
.wt-tag {
  display: inline-flex; align-items: center; gap: 3px; font-size: 10.5px; line-height: 1.6;
  padding: 0 6px; border-radius: 999px; border: 1px solid ${C.border1}; color: ${C.label3};
  white-space: nowrap;
}
.wt-link { cursor: pointer; user-select: none; color: var(--dsw-alias-link); font-size: 11px; }
.wt-link:hover { text-decoration: underline; }
.wt-title { cursor: pointer; word-break: break-word; }
.wt-title:hover { text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px; }
.wt-spin {
  display: inline-block; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid ${C.border}; border-top-color: ${C.brand}; animation: wt-spin .8s linear infinite;
}
`;

/* ------------------------------------------------------------------ *
 * 图标：纯 React.createElement('svg', ...) 自绘，颜色一律 currentColor，
 * 这样同一个图标在勾选框里是绿色、在按钮里是次级文字色，不需要第二套画法。
 * ------------------------------------------------------------------ */
function WorkTodoIcon({ size = 16, active }) {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
    style: { opacity: active ? 1 : 0.82 },
  }, [
    React.createElement('rect', { key: 'a', x: '2.7', y: '3.1', width: '10.6', height: '10.4', rx: '2' }),
    React.createElement('path', { key: 'b', d: 'M5.6 1.7h4.8v2.7H5.6z' }),
    React.createElement('path', { key: 'c', d: 'M5.7 9.3l1.7 1.7 3.1-3.5' }),
  ]);
}

function IconCheck({ size = 11 }) {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 12 12', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, React.createElement('path', { d: 'M2 6.3 4.6 8.9 10 3.1' }));
}

function IconChevron({ open, size = 10 }) {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 14 14', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
    // 收起时把「向下」的箭头转成「向右」：比画两个图标便宜，也不会因为尺寸不同而跳一下
    style: { flex: 'none', transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .15s ease' },
  }, React.createElement('path', { d: 'm3.4 5.2 3.6 3.6 3.6-3.6' }));
}

function IconTrash({ size = 13 }) {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, [
    React.createElement('path', { key: 'a', d: 'M2.8 4.4h10.4' }),
    React.createElement('path', { key: 'b', d: 'M6.4 4.4V2.9h3.2v1.5' }),
    React.createElement('path', { key: 'c', d: 'M4.5 4.4l.7 8.4h5.6l.7-8.4' }),
    React.createElement('path', { key: 'd', d: 'M6.9 6.8v3.9M9.1 6.8v3.9' }),
  ]);
}

function IconClose({ size = 11 }) {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 12 12', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
  }, [
    React.createElement('path', { key: 'a', d: 'M3 3l6 6' }),
    React.createElement('path', { key: 'b', d: 'M9 3l-6 6' }),
  ]);
}

function IconRefresh({ size = 12 }) {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, [
    React.createElement('path', { key: 'a', d: 'M2.6 8a5.4 5.4 0 0 1 9.1-3.9' }),
    React.createElement('path', { key: 'b', d: 'M13.4 8a5.4 5.4 0 0 1-9.1 3.9' }),
    React.createElement('path', { key: 'c', d: 'M12.3 1.9v2.6H9.7' }),
    React.createElement('path', { key: 'd', d: 'M3.7 14.1v-2.6h2.6' }),
  ]);
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
/** 本地「今天」。只在该字段缺失时兜底（宿主的 today 是权威值，且与本机时区一致）。 */
function localToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const asArray = (value) => (Array.isArray(value) ? value : []);

/**
 * 面板上的写操作统一走这里。
 * 约定：宿主所有路由都回 200，成败看 `ok`；失败时把宿主的 error 原文抛出去，
 * 由面板顶部的错误条原样显示——绝不吞掉原因（用户要看到「标题过长」这种具体话）。
 * @param {string} path 相对路由前缀的路径，如 '/create'
 * @param {object} body
 * @returns {Promise<object>} 成功时返回 data
 */
async function postJson(path, body) {
  const response = await fetch(`${ROUTE_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    credentials: 'same-origin',
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const parsed = await response.json().catch(() => null);
  if (!parsed) throw new Error('响应不是 JSON');
  if (!parsed.ok) throw new Error(parsed.error ?? parsed.reason ?? '未知错误');
  return parsed.data ?? {};
}

/* ------------------------------------------------------------------ *
 * 数据获取
 * ------------------------------------------------------------------ */
/**
 * 模块级缓存：面板被切走再切回来时 React 会重新挂载，有上次结果就先渲染、后台再刷新
 * （stale-while-revalidate）。侧栏来回点的时候不该每次都转圈。
 */
let lastList = null;
// 排序模式跨「切走再切回」保持；manual = 尊重拖动顺序
let lastSort = 'manual';

function useList(sort) {
  const [state, setState] = React.useState(() => (lastList
    ? { status: 'ready', data: lastList, error: null }
    : { status: 'loading', data: null, error: null }));
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    /**
     * filter=all 而不是 open：面板是「按分组展示」的，宿主的分组是在**筛选后的子集**上算的，
     * 用 open 时 groups.completed 恒为空，「已完成」那一组就永远出不来（也就没法折叠/展开）。
     * 统计 stats 不受 filter 影响（宿主按全量算），所以顶部数字仍然是全局口径。
     */
    fetch(`${ROUTE_LIST}?filter=all&sort=${encodeURIComponent(sort || 'manual')}`, { cache: 'no-store', credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json().catch(() => null);
        if (!body?.ok) throw new Error(body?.error ?? body?.reason ?? '未知错误');
        lastList = body.data;
        if (alive) setState({ status: 'ready', data: body.data, error: null });
      })
      .catch((error) => {
        // 已经有数据时只标记错误，不清空面板：一次抖动不该让人看不到自己的待办
        if (alive) {
          setState((prev) => ({
            ...prev,
            status: prev.data ? 'ready' : 'failed',
            error: String(error?.message ?? error),
          }));
        }
      });
    return () => { alive = false; };
  }, [tick, sort]);

  const refresh = React.useCallback(() => setTick((n) => n + 1), []);
  return { ...state, refresh };
}

/* ------------------------------------------------------------------ *
 * 快速添加
 * ------------------------------------------------------------------ */
function QuickAdd({ t, onAdd, busy }) {
  const [title, setTitle] = React.useState('');
  const [due, setDue] = React.useState('');
  const [priority, setPriority] = React.useState('normal');

  const submit = () => {
    if (busy) return;
    // 截止日期与优先级是「这一批」的选择，加完保留：同一天连着加几件事时不用反复填
    Promise.resolve(onAdd({ title, due, priority })).then((ok) => {
      if (ok !== false) setTitle('');
    }).catch(() => { /* onAdd 内部已经吞掉错误并显示在错误条上 */ });
  };

  return React.createElement('div', {
    style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10 },
  }, [
    React.createElement('input', {
      key: 'ti',
      className: 'wt-input',
      style: { flex: '1 1 200px', fontSize: 12.5, padding: '5px 9px' },
      value: title,
      placeholder: t('addPlaceholder'),
      'aria-label': t('addPlaceholder'),
      onChange: (event) => setTitle(event.target.value),
      onKeyDown: (event) => { if (event.key === 'Enter') submit(); },
    }),
    React.createElement('label', {
      key: 'due',
      title: t('dueLabel'),
      style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: C.label3 },
    }, [
      t('dueLabel'),
      React.createElement('input', {
        key: 'i',
        className: 'wt-input',
        type: 'date',
        value: due,
        'aria-label': t('dueLabel'),
        onChange: (event) => setDue(event.target.value),
      }),
    ]),
    React.createElement('label', {
      key: 'prio',
      title: t('priorityLabel'),
      style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: C.label3 },
    }, [
      t('priorityLabel'),
      React.createElement('select', {
        key: 's',
        className: 'wt-input',
        value: priority,
        'aria-label': t('priorityLabel'),
        onChange: (event) => setPriority(event.target.value),
      }, [
        React.createElement('option', { key: 'high', value: 'high' }, t('prioHigh')),
        React.createElement('option', { key: 'normal', value: 'normal' }, t('prioNormal')),
        React.createElement('option', { key: 'low', value: 'low' }, t('prioLow')),
      ]),
    ]),
    React.createElement('button', {
      key: 'add',
      type: 'button',
      className: 'wt-btn wt-btn-primary',
      disabled: Boolean(busy),
      onClick: submit,
    }, t('add')),
  ]);
}

/* ------------------------------------------------------------------ *
 * 单行：查看 / 行内编辑 / 二次确认删除
 * 状态都留在这一行内部，所以在别的行上敲字、或者列表刷新，都不会把正在编辑的内容冲掉。
 * ------------------------------------------------------------------ */
function TodoRow({ todo, today, t, onToggle, onRemove, onSave, drag }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(null);
  const [notesOpen, setNotesOpen] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);

  // 二次确认要能自己失效：点了删除又改主意的人，不该在几分钟后误触一次就真删掉
  React.useEffect(() => {
    if (!confirming) return undefined;
    const id = setTimeout(() => setConfirming(false), 5000);
    return () => clearTimeout(id);
  }, [confirming]);

  const row = todo ?? {};
  const done = row.status === 'completed';
  const due = typeof row.due === 'string' ? row.due : '';
  const overdue = !done && Boolean(due) && Boolean(today) && due < today;

  const beginEdit = () => {
    setDraft({
      title: typeof row.title === 'string' ? row.title : '',
      due,
      priority: row.priority === 'high' || row.priority === 'low' ? row.priority : 'normal',
      project: typeof row.project === 'string' ? row.project : '',
      notes: typeof row.notes === 'string' ? row.notes : '',
    });
    setNotesOpen(Boolean(row.notes));
    setEditing(true);
  };

  const stopEdit = () => { setEditing(false); setDraft(null); };

  /**
   * 保存时只发改动过的字段：宿主对空 patch 会回 empty-patch 错误，
   * 而「打开又原样关掉」显然不该报错，所以这里先自己比对一遍。
   */
  const submit = () => {
    if (!draft) return;
    const patch = {};
    const title = String(draft.title ?? '').trim();
    if (title !== (row.title ?? '')) patch.title = title;
    const nextDue = draft.due || '';
    if (nextDue !== due) patch.due = nextDue; // 空串 = 清空截止日期
    const priority = draft.priority || 'normal';
    if (priority !== (row.priority ?? 'normal')) patch.priority = priority;
    const project = String(draft.project ?? '').trim();
    if (project !== (row.project ?? '')) patch.project = project; // 空串 = 去掉项目
    const notes = String(draft.notes ?? '').trim();
    if (notes !== (row.notes ?? '')) patch.notes = notes;
    stopEdit();
    if (!Object.keys(patch).length) return;
    Promise.resolve(onSave(row.id, patch)).catch(() => { /* 已在错误条上显示 */ });
  };

  const inputStyle = { fontSize: 12, padding: '3px 7px' };

  if (editing && draft) {
    const field = (key, label, control) => React.createElement('label', {
      key,
      style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: C.label3 },
    }, [label, control]);

    return React.createElement('div', { className: 'wt-row wt-row-edit' }, [
      React.createElement('div', { key: 'top', style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
        React.createElement('input', {
          key: 'ti',
          className: 'wt-input',
          style: { ...inputStyle, flex: 1, minWidth: 0 },
          value: draft.title,
          autoFocus: true,
          placeholder: t('titlePlaceholder'),
          'aria-label': t('titlePlaceholder'),
          onChange: (event) => setDraft((prev) => ({ ...prev, title: event.target.value })),
          onKeyDown: (event) => {
            if (event.key === 'Enter') submit();
            if (event.key === 'Escape') stopEdit();
          },
        }),
        React.createElement('button', {
          key: 'save', type: 'button', className: 'wt-btn wt-btn-primary', onClick: submit,
        }, t('save')),
        React.createElement('button', {
          key: 'cancel', type: 'button', className: 'wt-btn', onClick: stopEdit,
        }, t('cancel')),
      ]),
      React.createElement('div', {
        key: 'fields',
        style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' },
      }, [
        field('due', t('dueLabel'), React.createElement('input', {
          className: 'wt-input', style: inputStyle, type: 'date', value: draft.due,
          'aria-label': t('dueLabel'),
          onChange: (event) => setDraft((prev) => ({ ...prev, due: event.target.value })),
        })),
        field('prio', t('priorityLabel'), React.createElement('select', {
          className: 'wt-input', style: inputStyle, value: draft.priority,
          'aria-label': t('priorityLabel'),
          onChange: (event) => setDraft((prev) => ({ ...prev, priority: event.target.value })),
        }, [
          React.createElement('option', { key: 'high', value: 'high' }, t('prioHigh')),
          React.createElement('option', { key: 'normal', value: 'normal' }, t('prioNormal')),
          React.createElement('option', { key: 'low', value: 'low' }, t('prioLow')),
        ])),
        field('project', t('projectLabel'), React.createElement('input', {
          className: 'wt-input', style: { ...inputStyle, width: 130 }, value: draft.project,
          placeholder: t('projectPlaceholder'),
          'aria-label': t('projectPlaceholder'),
          onChange: (event) => setDraft((prev) => ({ ...prev, project: event.target.value })),
        })),
      ]),
      React.createElement('div', { key: 'notes' }, [
        notesOpen
          ? React.createElement('div', { key: 'box', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
            React.createElement('textarea', {
              key: 'ta',
              className: 'wt-input',
              style: { width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: 54 },
              rows: 3,
              value: draft.notes,
              placeholder: t('notesPlaceholder'),
              'aria-label': t('notesLabel'),
              onChange: (event) => setDraft((prev) => ({ ...prev, notes: event.target.value })),
              // textarea 里回车要换行，所以保存用 Ctrl/Cmd+Enter
              onKeyDown: (event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
                if (event.key === 'Escape') stopEdit();
              },
            }),
            React.createElement('span', {
              key: 'hide', className: 'wt-link', onClick: () => setNotesOpen(false),
            }, t('notesHide')),
          ])
          : React.createElement('span', {
            key: 'add', className: 'wt-link', onClick: () => setNotesOpen(true),
          }, t('notesAdd')),
      ]),
    ]);
  }

  const meta = [];
  if (row.priority === 'high') {
    meta.push(React.createElement('span', {
      key: 'p',
      className: 'wt-tag',
      style: { color: C.warn, borderColor: tint(C.warn, 50), background: tint(C.warn, 12), fontWeight: 600 },
    }, t('prioHigh')));
  } else if (row.priority === 'low') {
    meta.push(React.createElement('span', { key: 'p', className: 'wt-tag' }, t('prioLow')));
  }
  if (due) {
    meta.push(React.createElement('span', {
      key: 'd',
      style: { color: overdue ? C.warn : C.label3, fontSize: 11 },
    }, overdue ? `${t('overdueTag')} ${due}` : due));
  }
  if (row.project) {
    meta.push(React.createElement('span', { key: 'j', className: 'wt-tag' }, `#${row.project}`));
  }
  // 来源标记：让用户一眼看出这条是模型加的、还是从会话提升来的（人自己加的不用标）
  if (row.source === 'agent' || row.source === 'session') {
    meta.push(React.createElement('span', {
      key: 's',
      className: 'wt-tag',
      title: row.source === 'agent' ? t('sourceAgent') : t('sourceSession'),
    }, row.source === 'agent' ? t('sourceAgent') : t('sourceSession')));
  }

  // 拖动属性：只有父级给了 drag 才可拖（未启用时行为与以前完全一致）
  const dragAttrs = drag
    ? {
      draggable: true,
      onDragStart: (event) => {
        try {
          event.dataTransfer?.setData('text/plain', row.id ?? '');
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        } catch { /* 少数环境不允许写 dataTransfer，忽略即可 */ }
        drag.onStart?.(row.id);
      },
      onDragOver: (event) => { event.preventDefault(); drag.onOver?.(row.id); },
      onDrop: (event) => { event.preventDefault(); drag.onDrop?.(row.id); },
      onDragEnd: () => drag.onEnd?.(),
      title: drag.hint,
      style: drag.dragging ? { opacity: 0.45 } : undefined,
    }
    : {};
  return React.createElement('div', { className: 'wt-row', ...dragAttrs }, [
    React.createElement('button', {
      key: 'check',
      type: 'button',
      className: `wt-check${done ? ' wt-check-done' : ''}`,
      'aria-label': done ? t('unmarkDone') : t('markDone'),
      title: done ? t('unmarkDone') : t('markDone'),
      onClick: () => { Promise.resolve(onToggle(row.id)).catch(() => { /* 已在错误条上显示 */ }); },
    }, done ? React.createElement(IconCheck, { key: 'i' }) : null),
    React.createElement('div', { key: 'main', style: { flex: 1, minWidth: 0 } }, [
      React.createElement('div', {
        key: 'title',
        className: 'wt-title',
        title: t('editHint'),
        onClick: beginEdit,
        style: {
          color: done ? C.label3 : C.label,
          textDecoration: done ? 'line-through' : 'none',
          fontWeight: row.priority === 'high' && !done ? 650 : 400,
        },
      }, typeof row.title === 'string' && row.title ? row.title : t('untitled')),
      meta.length
        ? React.createElement('div', {
          key: 'meta',
          style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 2 },
        }, meta)
        : null,
    ]),
    React.createElement('button', {
      key: 'del',
      type: 'button',
      className: confirming ? 'wt-btn wt-btn-danger' : 'wt-icon-btn wt-icon-btn-danger',
      title: confirming ? t('confirmDelete') : t('deleteBtn'),
      'aria-label': t('deleteBtn'),
      onClick: () => {
        if (!confirming) { setConfirming(true); return; }
        setConfirming(false);
        Promise.resolve(onRemove(row.id)).catch(() => { /* 已在错误条上显示 */ });
      },
    }, confirming ? t('confirmDelete') : React.createElement(IconTrash, { key: 'i' })),
  ]);
}

/* ------------------------------------------------------------------ *
 * 分组：空组整块不渲染，避免五个空标题堆在面板上
 * ------------------------------------------------------------------ */
function Group({ label, items, meta, closed, t, today, onToggleOpen, onToggleTodo, onRemove, onSave, drag }) {
  const list = asArray(items);
  if (!list.length) return null;
  return React.createElement('div', { style: { marginTop: 6 } }, [
    React.createElement('div', {
      key: 'head',
      className: 'wt-group-head',
      onClick: onToggleOpen,
      title: closed ? t('expand') : t('collapse'),
      role: 'button',
      'aria-expanded': !closed,
    }, [
      React.createElement(IconChevron, { key: 'c', open: !closed }),
      React.createElement('span', { key: 'l', style: { fontWeight: 600, fontSize: 12 } }, label),
      React.createElement('span', { key: 'n', style: { fontSize: 11, color: C.label3 } }, meta || String(list.length)),
      React.createElement('span', { key: 'sp', style: { flex: 1 } }),
      React.createElement('span', { key: 'h', style: { fontSize: 11, color: C.label3 } }, closed ? t('expand') : t('collapse')),
    ]),
    closed ? null : React.createElement('div', { key: 'body' }, list.map((todo, index) => React.createElement(TodoRow, {
      key: (todo && todo.id) || `row-${index}`,
      todo,
      today,
      t,
      onToggle: onToggleTodo,
      onRemove,
      onSave,
        drag: drag ? {
          dragging: drag.dragId === todo?.id,
          hint: drag.hint,
          onStart: drag.onStart,
          onOver: drag.onOver,
          onDrop: drag.onDrop,
          onEnd: drag.onEnd,
        } : undefined,
    }))),
  ]);
}

/* ------------------------------------------------------------------ *
 * 会话待办：提升为工作待办
 *
 * 官方会话 todos 只能通过 useProjection hook 拿到，而 hook 不能在组件里「有条件地调用」。
 * 所以这里拆成独立子组件：父组件只在 props.useProjection 确实是函数时才挂载它，
 * 一旦挂载，这一份实例里 hook 的调用次数就是恒定的 —— 不违反 hooks 规则。
 * 投影为空（这个会话没列过待办）时整块返回 null，面板上不会多出一行没用的按钮。
 * ------------------------------------------------------------------ */
function SessionAdopt({ useProjection, t, onAdopt, busy }) {
  let projected;
  try {
    projected = useProjection('todos');
  } catch {
    // 投影尚未就绪 / 宿主版本没有这个投影：当作没有会话待办
    projected = null;
  }
  // 投影可能是裸数组，也可能是 { todos: [...] } 包一层——两种形状都认
  const raw = Array.isArray(projected) ? projected : asArray(projected?.todos);
  const items = raw.map((item) => ({
    content: typeof item?.content === 'string' ? item.content
      : (typeof item?.title === 'string' ? item.title : ''),
    status: typeof item?.status === 'string' ? item.status : 'pending',
  })).filter((item) => item.content.trim());
  if (!items.length) return null;
  const openCount = items.filter((item) => item.status !== 'completed').length;

  return React.createElement('div', {
    style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 },
  }, [
    React.createElement('button', {
      key: 'b',
      type: 'button',
      className: 'wt-btn wt-btn-primary',
      disabled: Boolean(busy),
      title: t('adoptHint'),
      onClick: () => { Promise.resolve(onAdopt(items)).catch(() => { /* 已在错误条上显示 */ }); },
    }, `${t('adoptPre')}${items.length}${t('adoptPost')}`),
    React.createElement('span', {
      key: 'h',
      title: t('adoptHint'),
      style: { fontSize: 11, color: C.label3 },
    }, `${t('adoptPending')} ${openCount}`),
  ]);
}

/* ------------------------------------------------------------------ *
 * 面板主体
 * ------------------------------------------------------------------ */
const GROUPS = [
  { key: 'overdue', label: 'groupOverdue' },
  { key: 'today', label: 'groupToday' },
  { key: 'week', label: 'groupWeek' },
  { key: 'later', label: 'groupLater' },
  { key: 'completed', label: 'groupCompleted' },
];

function WorkTodoPanel(props) {
  // t 由 locale 服务通过 slot props 注入；拿不到时退回中文，至少不显示裸 key
  const t = typeof props?.t === 'function' ? props.t : (key) => zh[key] ?? key;
  // 排序：manual（默认，尊重拖动）/ priority / created；必须在 useList(sort) 之前声明
  const [sort, setSortState] = React.useState(lastSort);
  const setSort = React.useCallback((next) => { lastSort = next; setSortState(next); }, []);
  const [dragId, setDragId] = React.useState(null);
  const { status, data, error, refresh } = useList(sort);

  // 写操作的错误条；readError 是拉取错误（用户关掉之后，只有换成新错误才再弹）
  const [barError, setBarError] = React.useState(null);
  const [dismissedReadError, setDismissedReadError] = React.useState(null);
  const readError = error && error !== dismissedReadError ? error : null;
  const shownError = barError ?? readError;

  const [notice, setNotice] = React.useState(null);
  const [pending, setPending] = React.useState(0);
  // 「已完成」默认折叠（做完的事不用占满屏幕），其余默认展开
  const [closed, setClosed] = React.useState({ completed: true });
  // 视图：按截止（默认）或按项目
  const [view, setView] = React.useState('due');

  /**
   * 所有写操作的统一外壳：成功清掉错误条，失败把宿主的 error 原文放上去，
   * 无论成败最后都重新拉一次列表（避免本地状态和磁盘上的真相对不上）。
   * @returns {Promise<{ok: boolean, data: object}>} data 是宿主返回的 data（失败时为空对象）
   */
  const runWrite = React.useCallback(async (job) => {
    setPending((n) => n + 1);
    try {
      const data = await job();
      setBarError(null);
      return { ok: true, data: data ?? {} };
    } catch (writeError) {
      setBarError(String(writeError?.message ?? writeError));
      return { ok: false, data: {} };
    } finally {
      setPending((n) => Math.max(0, n - 1));
      refresh();
    }
  }, [refresh]);

  const handleAdd = React.useCallback((input) => {
    const title = String(input?.title ?? '').trim();
    // 空标题先在本地拦下：这条文案要走 t()，而宿主的报错是中文的，两个都显示会更乱
    if (!title) {
      setBarError(t('titleEmpty'));
      return Promise.resolve(false);
    }
    return runWrite(() => postJson('/create', {
      title,
      due: input?.due ? String(input.due) : null,
      priority: input?.priority ?? 'normal',
    })).then((result) => result.ok);
  }, [runWrite, t]);

  const handleToggle = React.useCallback((ref) => runWrite(() => postJson('/status', { ref, toggle: true })), [runWrite]);
  const handleRemove = React.useCallback((ref) => runWrite(() => postJson('/remove', { ref })), [runWrite]);
  const handleSave = React.useCallback((ref, patch) => runWrite(() => postJson('/update', { ref, ...patch })), [runWrite]);

  /** 把 dragId 挪到目标之前，得到新的完整顺序并落盘（manual 模式生效） */

  const handleDropOn = React.useCallback((targetId) => {

    const dragging = dragId;

    setDragId(null);

    if (!dragging || !targetId || dragging === targetId) return Promise.resolve(false);

    const ids = asArray(data?.todos).map((todo) => todo?.id).filter(Boolean);

    const from = ids.indexOf(dragging);

    if (from === -1) return Promise.resolve(false);

    ids.splice(from, 1);

    const to = ids.indexOf(targetId);

    ids.splice(to === -1 ? ids.length : to, 0, dragging);

    return runWrite(() => postJson('/reorder', { ids })).then((result) => result.ok);

  }, [dragId, data, runWrite]);

  

  const dragHandlers = React.useMemo(() => ({

    dragId,

    hint: t('dragHint'),

    onStart: (id) => {

      setDragId(id);

      // 拖了就说明想自己定顺序：自动切到手动，否则松手后看起来「没生效」

      if (sort !== 'manual') setSort('manual');

    },

    onOver: () => {},

    onDrop: (id) => handleDropOn(id),

    onEnd: () => setDragId(null),

  }), [dragId, sort, t, setSort, handleDropOn]);

  

  const handleAdopt = React.useCallback((sessionTodos) => runWrite(() => postJson('/adopt', { todos: sessionTodos }))
    .then((result) => {
      // runWrite 已经刷新过列表，这里补一句「提升了几条、跳过几条」的回执，否则点完像没反应
      if (result.ok) {
        const created = Array.isArray(result.data?.created) ? result.data.created.length : 0;
        const skipped = Number.isFinite(Number(result.data?.skipped)) ? Number(result.data.skipped) : 0;
        setNotice(`${t('adoptDone')} ${created} · ${t('adoptSkipped')} ${skipped}`);
      }
      return result.ok;
    }), [runWrite, t]);

  // hooks 规则：这里只是取用，不调用。真正的调用在 SessionAdopt 里（按条件挂载整个子组件）
  const useProjection = typeof props?.useProjection === 'function' ? props.useProjection : undefined;

  const rootStyle = {
    height: '100%', overflow: 'auto', padding: '16px 18px 40px', boxSizing: 'border-box',
    color: C.label, fontFamily: 'var(--dsw-font-family, system-ui, sans-serif)', fontSize: 13,
  };

  if (status === 'loading' && !data) {
    return React.createElement('div', {
      className: 'wt-root',
      style: { ...rootStyle, display: 'flex', alignItems: 'center', gap: 8, color: C.label3, padding: 28 },
    }, [
      React.createElement('style', { key: 'css' }, STYLE_TEXT),
      React.createElement('span', { key: 'sp', className: 'wt-spin' }),
      React.createElement('span', { key: 't' }, t('loading')),
    ]);
  }

  if (status === 'failed' && !data) {
    return React.createElement('div', {
      className: 'wt-root',
      style: { ...rootStyle, padding: 28, color: C.error },
    }, [
      React.createElement('style', { key: 'css' }, STYLE_TEXT),
      React.createElement('div', { key: 'm' }, `${t('failed')}：${error ?? ''}`),
      React.createElement('button', {
        key: 'r', type: 'button', className: 'wt-btn', style: { marginTop: 10 }, onClick: refresh,
      }, t('retry')),
    ]);
  }

  const groups = data?.groups ?? {};
  const stats = data?.stats ?? {};
  const today = typeof data?.today === 'string' && data.today ? data.today : localToday();
  const store = data?.store ?? null;
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const overdueCount = num(stats.overdue);
  // 视图分桶：按截止（原有 GROUPS）或按项目（宿主给的 projectGroups，附 未完成/总数/逾期）
  const projectGroups = asArray(data?.projectGroups);
  const viewGroups = view === 'project'
    ? projectGroups.map((bucket) => ({
      key: `p:${bucket?.key ?? ''}`,
      label: bucket?.project ? String(bucket.project) : t('noProject'),
      meta: `${num(bucket?.open)}/${num(bucket?.total)}${num(bucket?.overdue) ? ` · ${t('statOverdue')} ${num(bucket.overdue)}` : ''}`,
      items: bucket?.todos,
    }))
    : GROUPS.map((group) => ({ key: group.key, label: t(group.label), items: groups[group.key] }));
  const totalVisible = viewGroups.reduce((sum, group) => sum + asArray(group.items).length, 0);

  const chips = [
    { key: 'open', label: t('statOpen'), value: num(stats.open) },
    { key: 'overdue', label: t('statOverdue'), value: overdueCount, alert: overdueCount > 0 },
    { key: 'today', label: t('statToday'), value: num(stats.today) },
    { key: 'doing', label: t('statDoing'), value: num(stats.doing) },
    { key: 'done', label: t('statDoneToday'), value: num(stats.completedToday) },
  ];

  return React.createElement('div', { className: 'wt-root', style: rootStyle }, [
    React.createElement('style', { key: 'css' }, STYLE_TEXT),

    /* 顶部：标题 + 统计 + 刷新 */
    React.createElement('div', {
      key: 'head',
      style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 },
    }, [
      React.createElement('div', { key: 'ti', style: { fontWeight: 700, fontSize: 15 } }, t('title')),
      ...chips.map((chip) => React.createElement('span', {
        key: chip.key,
        className: 'wt-chip',
        style: chip.alert
          ? { color: C.warn, borderColor: tint(C.warn, 50), background: tint(C.warn, 12) }
          : undefined,
      }, [
        React.createElement('span', { key: 'l', style: { color: C.label3 } }, chip.label),
        React.createElement('b', { key: 'v', style: { fontWeight: 650 } }, String(chip.value)),
      ])),
      React.createElement('span', { key: 'sort', className: 'wt-seg', title: t('sortLabel') }, [
        ...['manual', 'priority', 'created'].map((mode) => React.createElement('button', {
          key: mode,
          type: 'button',
          className: `wt-seg-btn${sort === mode ? ' is-on' : ''}`,
          title: mode === 'manual' ? t('dragHint') : `${t('sortLabel')}：${t(`sort${mode === 'manual' ? 'Manual' : mode === 'priority' ? 'Priority' : 'Created'}`)}`,
          onClick: () => setSort(mode),
        }, t(`sort${mode === 'manual' ? 'Manual' : mode === 'priority' ? 'Priority' : 'Created'}`))),
      ]),
      React.createElement('span', { key: 'view', className: 'wt-seg' }, [
        React.createElement('button', {
          key: 'due',
          type: 'button',
          className: `wt-seg-btn${view === 'due' ? ' is-on' : ''}`,
          title: t('viewDue'),
          onClick: () => setView('due'),
        }, t('viewDue')),
        React.createElement('button', {
          key: 'proj',
          type: 'button',
          className: `wt-seg-btn${view === 'project' ? ' is-on' : ''}`,
          title: t('viewProject'),
          onClick: () => setView('project'),
        }, t('viewProject')),
      ]),
      React.createElement('span', { key: 'sp', style: { flex: 1 } }),
      React.createElement('button', {
        key: 'rf',
        type: 'button',
        className: 'wt-btn',
        disabled: status === 'loading' || pending > 0,
        title: t('refresh'),
        onClick: refresh,
      }, [
        React.createElement(IconRefresh, { key: 'i' }),
        t('refresh'),
      ]),
    ]),

    /* 错误条：宿主的 error 原文照贴，绝不吞掉 */
    shownError
      ? React.createElement('div', {
        key: 'err',
        style: {
          display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10, padding: '6px 9px',
          borderRadius: 8, border: `1px solid ${tint(C.error, 45)}`, background: tint(C.error, 12),
          color: C.error, fontSize: 12, lineHeight: 1.6,
        },
      }, [
        React.createElement('span', {
          key: 'm',
          style: { flex: 1, minWidth: 0, wordBreak: 'break-word' },
        }, `${t('failed')}：${shownError}`),
        React.createElement('button', {
          key: 'x',
          type: 'button',
          className: 'wt-icon-btn',
          style: { width: 18, height: 18, color: C.error },
          title: t('dismiss'),
          'aria-label': t('dismiss'),
          onClick: () => { setBarError(null); setDismissedReadError(error ?? null); },
        }, React.createElement(IconClose, { key: 'i' })),
      ])
      : null,

    /* 提升结果提示：点完按钮要有个回执 */
    notice
      ? React.createElement('div', {
        key: 'notice',
        style: {
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '5px 9px',
          borderRadius: 8, border: `1px solid ${tint(C.ok, 40)}`, background: tint(C.ok, 10),
          color: C.label2, fontSize: 11.5,
        },
      }, [
        React.createElement('span', { key: 'm', style: { flex: 1 } }, notice),
        React.createElement('span', {
          key: 'x', className: 'wt-link', onClick: () => setNotice(null),
        }, t('dismiss')),
      ])
      : null,

    /* 会话待办：只在拿得到 useProjection 时挂载（见 SessionAdopt 的说明） */
    useProjection
      ? React.createElement(SessionAdopt, {
        key: 'adopt',
        useProjection,
        t,
        busy: pending > 0,
        onAdopt: handleAdopt,
      })
      : null,

    React.createElement(QuickAdd, { key: 'quick', t, busy: pending > 0, onAdd: handleAdd }),

    /* 分组列表 */
    totalVisible
      ? React.createElement('div', { key: 'groups' }, viewGroups.map((group) => React.createElement(Group, {
        key: group.key,
        label: group.label,
        meta: group.meta,
        items: group.items,
        closed: Boolean(closed[group.key]),
        t,
        today,
        onToggleOpen: () => setClosed((prev) => ({ ...prev, [group.key]: !prev[group.key] })),
        onToggleTodo: handleToggle,
        onRemove: handleRemove,
        onSave: handleSave,
        drag: dragHandlers,
      })))
      : React.createElement('div', {
        key: 'empty',
        style: { padding: '22px 12px', textAlign: 'center', color: C.label3 },
      }, [
        React.createElement('div', { key: 'a', style: { fontSize: 13, color: C.label2 } }, t('empty')),
        React.createElement('div', { key: 'b', style: { fontSize: 11.5, marginTop: 4 } }, t('emptyHint')),
      ]),

    /* 底部：数据到底存在哪（排查「我的待办不见了」时第一眼要看的东西） */
    React.createElement('div', {
      key: 'foot',
      style: { marginTop: 14, paddingTop: 8, borderTop: `1px solid ${C.border1}`, fontSize: 10.5, color: C.label3, lineHeight: 1.7 },
    }, store && store.location
      ? React.createElement('div', {
        key: 'store',
        title: `${t('storeAt')}：${store.location}`,
        style: { wordBreak: 'break-all' },
      }, `${t('storeAt')} · ${store.kind === 'domain' ? t('storeDomain') : t('storeFile')} · ${store.location}`)
      : null),
  ]);
}

/* ------------------------------------------------------------------ *
 * 插件体
 * ------------------------------------------------------------------ */
export const inject = ['slots', 'locale'];

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), `${LOCALE_NS}: dictionaries`);

  // 侧栏入口（id 必须与 main 面板的 key 同名，sidebar 用它去选中面板）
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: SLOT_ID,
    order: 88,
    label: () => '待办',
    locale: LOCALE_NS,
  }, (props) => React.createElement(WorkTodoIcon, { size: props?.size ?? 16, active: props?.active })));

  // 中栏独立面板
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: SLOT_ID,
    locale: LOCALE_NS,
  }, WorkTodoPanel));
}
