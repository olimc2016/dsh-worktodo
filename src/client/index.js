import React from 'react';
// 与宿主共用同一份解析器：人机一致，且零依赖（会被 esbuild 内联进 bundle）
import { parseNaturalDue } from '../parse-due.mjs';

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

/**
 * 拿不到宿主注入的 t 时的兜底字典。
 * 必须是**模块级常量**：写成组件里的箭头函数会让每次渲染都换一个函数身份，
 * 面板传给每一行的 `t` 就不再浅相等 —— `React.memo` 会因此永远不生效（S3-3）。
 */
const FALLBACK_T = (key) => zh[key] ?? key;

/**
 * 面板自动刷新间隔：agent 通过 worktodo_* 工具改了列表时宿主不会推送，
 * 面板只能自己定期拉一次（以及窗口重新获得焦点时拉一次），否则用户得手点刷新才看得到。
 *
 * 复审 R4：从 10 秒放宽到 30 秒 —— 每次轮询都是一次全量 `load()`（domain 路径要遍历整张表），
 * 10 秒一次在待办多起来时是纯浪费；用户重新聚焦窗口时那条路径会立刻补上新鲜度。
 * 卸载时定时器与监听都会被清掉。
 *
 * S3-3（第四轮审计，客户端侧）：窗口不可见（`document.visibilityState === 'hidden'`）时
 * **一次请求都不打** —— 多窗口/切到后台的场景下，原来的定时器每 30 秒仍然全量拉一次。
 * 重新可见时由 `visibilitychange` 那条路径立刻补一次新鲜度。
 */
export const CHANGE_POLL_MS = 30000;

/**
 * 自升级进行中的状态轮询间隔（2 秒）。
 *
 * 关键约束：**只在升级进行中轮询** —— 面板挂载本身不注册这个定时器；点了「立即更新」、
 * 或者宿主报告 `state === 'running'` 时才注册，一旦状态不再是 running 立刻清掉。
 * 常驻一个 2 秒的定时器会让「省着打宿主」这件事前功尽弃（见 CHANGE_POLL_MS 的说明）。
 */
export const UPDATE_POLL_MS = 2000;

/**
 * 窗口是否不可见。
 *
 * 抽成纯函数有两个原因：SSR/无 document 环境（测试）里要安全；以及行为可以直接单测。
 * `document` 缺失时按「可见」处理：没有浏览器上下文就没有「后台窗口」这回事。
 * @param {Document|undefined} [doc]
 * @returns {boolean}
 */
export function isWindowHidden(doc = typeof document !== 'undefined' ? document : undefined) {
  return Boolean(doc && doc.visibilityState === 'hidden');
}

/**
 * 编辑表单的优先级档位。`none` 必须在里面：它代表「不设优先级」这个真实状态，
 * 缺了它（或把 `none` 兜底成 `normal`）会让用户打开编辑器、什么都不改、点保存
 * 就把这条记录永久改成「普通」（审计 F6，且宿主工具侧曾无法改回 none）。
 */
export const EDIT_PRIORITY_OPTIONS = ['high', 'normal', 'low', 'none'];

/** 优先级 → 文案 key。 */
const PRIORITY_LABEL_KEYS = {
  high: 'prioHigh', normal: 'prioNormal', low: 'prioLow', none: 'prioNone',
};

/**
 * 从一行待办构造编辑草稿。
 *
 * 抽成纯函数有两个原因：面板与测试用同一份逻辑（不是测试里再抄一遍），
 * 以及 `none` 必须**原样保留**而不是被 `|| 'normal'` 之类兜底改掉。
 * @param {object} row
 * @returns {{title: string, due: string, priority: string, project: string, dueTime: string, notes: string}}
 */
export function buildEditDraft(row = {}) {
  return {
    title: typeof row.title === 'string' ? row.title : '',
    due: typeof row.due === 'string' ? row.due : '',
    priority: EDIT_PRIORITY_OPTIONS.includes(row.priority) ? row.priority : 'normal',
    project: typeof row.project === 'string' ? row.project : '',
    dueTime: typeof row.dueTime === 'string' ? row.dueTime : '',
    notes: typeof row.notes === 'string' ? row.notes : '',
  };
}

/* ------------------------------------------------------------------ *
 * 文案：zh / en 两份 key 必须一一对应（宿主按 key 取词，缺 key 会显示 key 本身）
 * ------------------------------------------------------------------ */
const zh = {
  'nav': '待办',
  'title': '工作待办',
  'panelCrashTitle': '工作待办面板出错了',
  'panelCrashHint': '渲染这块面板时抛了异常，已在这里兜住，待办数据本身没丢。点「重试」可以重新挂载，无需重启 DSH；若反复出现，请把控制台里的完整报错发出来。',
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
  'storeMismatch': '存储后端不一致',
  'storeSplit': '两处数据不一致',
  'storeError': '存储读写失败',
  'storeRetired': '回退文件已迁移并退役',
  'storeRetiredArchive': '退役档案',
  'storeUnavailable': '不可用',
  'storeRetiredUnavailable': '官方存储不可用，且回退文件已退役',
  'storeRetiredUnavailableHint': '回退文件已于 {when} 退役，本次读不到待办；档案：{archive}。请在带 storage 的组合里启动，或手动恢复该文件',
  'storeRetiredFailed': '回退文件退役失败（文件仍在，已被排除在合并源之外）',
  'storeRetiredFailedHint': '文件仍在 {path}：请手动改名或删除，否则它可能让已删除的待办复活',
  'storeMergeAborted': '合并两处数据失败（已回滚，未留下半截数据）',
  'storeMergeNote': '已按 id 合并两处数据：{merged} 条（同 id 冲突 {conflicts}，补入 {added}）',
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
  'versionLabel': '版本',
  'versionHint': '当前安装的 dsh-worktodo 版本',
  'updateAvailable': '有新版本',
  'updateHint': '点击立即更新（升级到最新版；装好后重启 DSH 生效）',
  'updateNow': '立即更新',
  'updating': '正在更新…',
  'updatedRestart': '已更新到 {version}，重启 DSH 生效',
  'updateRestartHint': '已更新完成，重启 DSH 生效',
  'updateFailed': '更新失败',
  'updateLinked': '这是本地链接安装（link:），请在仓库里用 git/pnpm 工作流更新',
  'updateRetry': '重试',
  'updateRetryHint': '点击重试',
  'addOpen': '新增待办',
  'addCancel': '取消',
  'prioNone': '无',
  'dateUnset': '日期 · 未设',
  'timeUnset': '时间 · 未设',
  'todayWord': '今天',
  'fromParsed': '识别',
  'dueTimeLabel': '时间',
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
  'projectNew': '新建',
  'projectNewPlaceholder': '新项目名',
  'projectListTruncated': '项目较多，只显示最常用的 {count} 个',
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
  'panelCrashTitle': 'Work to-dos panel crashed',
  'panelCrashHint': 'Rendering this panel threw an exception; it is caught here and your to-dos are safe. Click Retry to remount it without restarting DSH — if it keeps happening, please share the full console error.',
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
  'storeMismatch': 'Storage backend mismatch',
  'storeSplit': 'Data split across two locations',
  'storeError': 'Storage read/write failed',
  'storeRetired': 'Legacy file migrated and retired',
  'storeRetiredArchive': 'archive',
  'storeUnavailable': 'unavailable',
  'storeRetiredUnavailable': 'Official storage unavailable and the legacy file was retired',
  'storeRetiredUnavailableHint': 'the legacy file was retired at {when}, so to-dos cannot be read now; archive: {archive}. Start with the storage service, or restore that file manually',
  'storeRetiredFailed': 'Retiring the legacy file failed (it still exists and is excluded as a merge source)',
  'storeRetiredFailedHint': 'the file is still at {path}: rename or delete it manually, otherwise it may resurrect deleted to-dos',
  'storeMergeAborted': 'Merging the two copies failed (rolled back, nothing half-written)',
  'storeMergeNote': 'Merged both copies by id: {merged} items ({conflicts} id conflicts, {added} added)',
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
  'versionLabel': 'Version',
  'versionHint': 'Installed dsh-worktodo version',
  'updateAvailable': 'Update available',
  'updateHint': 'Click to update now (installs the latest version; restart DSH to apply)',
  'updateNow': 'Update now',
  'updating': 'Updating…',
  'updatedRestart': 'Updated to {version} — restart DSH to apply',
  'updateRestartHint': 'Update finished — restart DSH to apply',
  'updateFailed': 'Update failed',
  'updateLinked': 'This is a local link: install — update it with the git/pnpm workflow',
  'updateRetry': 'Retry',
  'updateRetryHint': 'Click to retry',
  'addOpen': 'New todo',
  'addCancel': 'Cancel',
  'prioNone': 'None',
  'dateUnset': 'Date · unset',
  'timeUnset': 'Time · unset',
  'todayWord': 'Today',
  'fromParsed': 'parsed',
  'dueTimeLabel': 'Time',
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
  'projectNew': 'Create',
  'projectNewPlaceholder': 'New project name',
  'projectListTruncated': 'Many projects — showing the {count} most used',
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
/** 本地时区的 YYYY-MM-DD（面板里判断"今天 / 逾期"用；与宿主 records.mjs 的 dayKey 同语义）。 */
function dayKey(stamp) {
  const d = new Date(stamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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

/** 页面底部「自升级」那一格的配色（走主题变量，不写死颜色）。 */
const UPDATE_TONE_STYLE = {
  ok: { color: C.ok, borderColor: tint(C.ok, 50), background: tint(C.ok, 12) },
  busy: { color: C.label2, borderColor: tint(C.label2, 40), background: tint(C.label2, 10) },
  warn: { color: C.warn, borderColor: tint(C.warn, 50), background: tint(C.warn, 12) },
  error: { color: C.error, borderColor: tint(C.error, 50), background: tint(C.error, 12) },
};

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
.wt-plus {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 12px 14px; margin-bottom: 10px; cursor: pointer; font: inherit; font-size: 13.5px; font-weight: 600;
  color: ${C.label2}; background: ${C.layer1};
  border: 1px dashed ${C.border}; border-radius: 12px;
}
.wt-plus:hover { color: ${C.label}; border-color: ${C.brand}; background: ${tint(C.brand, 8)}; }
.wt-plus-mark { font-size: 24px; line-height: 1; font-weight: 400; color: ${C.brand}; }
.wt-flag-btn {
  appearance: none; display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
  font: inherit; font-size: 11.5px; padding: 5px 9px; border-radius: 9px;
  background: transparent; border: 1px solid ${C.border}; color: ${C.label2};
}
.wt-flag-btn.is-on { border-color: currentColor; background: color-mix(in srgb, currentColor 12%, transparent); color: inherit; }
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
/* 自升级那一格：本身是 <button>（可点），但外观必须与旁边的 chip 一致 */
.wt-update { font: inherit; cursor: pointer; background: transparent; appearance: none; }
.wt-update:hover { text-decoration: underline; }
.wt-update:disabled { cursor: default; opacity: .7; }
.wt-update:disabled:hover { text-decoration: none; }
.wt-title { cursor: pointer; word-break: break-word; }
.wt-title:hover { text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px; }
.wt-spin {
  display: inline-block; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid ${C.border}; border-top-color: ${C.brand}; animation: wt-spin .8s linear infinite;
}
`;

/* ------------------------------------------------------------------ *
 * 错误边界
 *
 * 为什么必须补：slot entry 在渲染期抛异常 = 整块面板白屏/黑屏，用户只会以为插件坏了
 * （0.2.x 就出过一次：面板里调了当时还不存在的 dayKey）。React 的错误边界是唯一能在
 * 运行期兜住**子组件渲染抛错**的机制，所以这里加一个类组件：
 *   - getDerivedStateFromError：把 error 收进 state，下一帧渲染兜底 UI；
 *   - componentDidCatch：把**原始 error 和组件栈**照原样打到 console，绝不吞错（不能因为
 *     兜了底就把真实 bug 藏起来）；
 *   - 「重试」：清掉 error 并把 attempt+1，keyed Fragment 换 key → 子树整体重新挂载，
 *     用户不必重启 DSH。
 * DOM 里只放 error.message（纯文本子节点，React 负责转义；**绝不用 innerHTML**），
 * 堆栈只进控制台。样式全部走 --dsw-alias-* 变量，且不依赖面板那张样式表 ——
 * 面板自己崩掉时 STYLE_TEXT 很可能根本没渲染出来。
 * ------------------------------------------------------------------ */
export class WorkTodoErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, attempt: 0 };
    this.handleRetry = this.handleRetry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // 不掩盖 bug：原始 error（含 stack）与组件栈原样输出，排查时一眼能看到真凶
    console.error(`[${SHORT_NAME}] 面板渲染出错（已兜底，未白屏）：`, error, info?.componentStack ?? '');
  }

  /** 清掉错误状态 + 换 key：把子树整个重新挂载一次。 */
  handleRetry() {
    this.setState((prev) => ({ error: null, attempt: (prev?.attempt ?? 0) + 1 }));
  }

  render() {
    const state = this.state ?? {};
    if (!state.error) {
      // key 变化 → React 卸载旧子树、按新实例挂载（重试走的就是这条路）
      return React.createElement(
        React.Fragment,
        { key: `wt-eb-${state.attempt ?? 0}` },
        this.props?.children ?? null,
      );
    }
    // 拿不到宿主注入的 t 时退回本模块的 zh 字典（同一份文案），再不行才显示 key 本身
    const injected = typeof this.props?.t === 'function' ? this.props.t : null;
    const t = injected ?? ((key) => zh[key] ?? key);
    // 只取摘要：error 可能是任何东西，message 缺失就留空，绝不 String(error) 把堆栈带进 DOM
    const detail = state.error?.message
      ? String(state.error.message)
      : (typeof state.error === 'string' ? state.error : '');
    return React.createElement('div', {
      className: 'wt-root wt-crash',
      role: 'alert',
      style: {
        height: '100%', overflow: 'auto', boxSizing: 'border-box',
        padding: '18px 18px 32px', color: C.label, fontSize: 13, lineHeight: 1.7,
        fontFamily: 'var(--dsw-font-family, system-ui, sans-serif)',
      },
    }, [
      React.createElement('div', {
        key: 'title',
        style: { fontWeight: 650, fontSize: 14, color: C.error, wordBreak: 'break-word' },
      }, t('panelCrashTitle')),
      detail
        ? React.createElement('div', {
          key: 'detail',
          style: {
            marginTop: 8, padding: '6px 9px', borderRadius: 8, fontSize: 12,
            color: C.label2, wordBreak: 'break-word',
            border: `1px solid ${tint(C.error, 45)}`, background: tint(C.error, 12),
          },
        }, detail)
        : null,
      React.createElement('div', {
        key: 'hint',
        style: { marginTop: 8, fontSize: 11.5, color: C.label3 },
      }, t('panelCrashHint')),
      injected
        ? null
        : React.createElement('div', {
          key: 'en',
          style: { marginTop: 4, fontSize: 11, color: C.label3 },
        }, 'Work to-dos panel crashed — click Retry to remount it.'),
      React.createElement('button', {
        key: 'retry',
        type: 'button',
        className: 'wt-btn wt-btn-primary',
        style: {
          marginTop: 12, font: 'inherit', fontSize: 12, lineHeight: 1.6, padding: '4px 12px',
          borderRadius: 8, cursor: 'pointer',
          border: `1px solid ${tint(C.brand, 50)}`, color: C.brand, background: tint(C.brand, 10),
        },
        onClick: this.handleRetry,
      }, t('retry')),
    ]);
  }
}

/**
 * 把一个 slot 组件包进错误边界。
 *
 * 选在 `apply()` 注册处包（而不是改组件内部）：面板与侧栏两个入口一处收口，
 * 组件本体保持纯净、不新增嵌套层级，测试里也还能直接拿到「未包的组件」做反向验证；
 * 这是侵入最小的做法。`t` 从 slot props 透传给边界，让兜底文案跟随宿主语言。
 */
function withErrorBoundary(Component) {
  return function WorkTodoEntry(props) {
    return React.createElement(WorkTodoErrorBoundary, { t: props?.t }, React.createElement(Component, props));
  };
}

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
 *
 * `reason` 会**挂在 Error 上**一起抛出去：有些失败的原因码本身就是给用户看的分类
 *（自升级的 `linked` 要换成「本地链接安装」的专门文案），只有 message 是分不出来的。
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
  if (!response.ok) {
    // S4-3：宿主对请求体超时/超限回的是 4xx + `{reason, error}`（以前直接掐断连接，
    // 客户端只能看到 ECONNRESET）。这里优先把宿主的原文取出来，用户才看得到「请求体过大」。
    const detail = await response.json().catch(() => null);
    const error = new Error(detail?.error ?? detail?.reason ?? `HTTP ${response.status}`);
    if (detail?.reason) error.reason = detail.reason;
    throw error;
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed) throw new Error('响应不是 JSON');
  if (!parsed.ok) {
    const error = new Error(parsed.error ?? parsed.reason ?? '未知错误');
    if (parsed.reason) error.reason = parsed.reason;
    throw error;
  }
  return parsed.data ?? {};
}

/**
 * GET /worktodo/update：自升级进度。
 * 只在 `state === 'running'` 时被轮询调用（见 UPDATE_POLL_MS），不做任何缓存。
 * @returns {Promise<object|null>} 宿主的升级状态
 */
async function fetchUpdateRun() {
  const response = await fetch(`${ROUTE_BASE}/update`, { cache: 'no-store', credentials: 'same-origin' });
  const parsed = await response.json().catch(() => null);
  if (!response.ok || !parsed?.ok) {
    throw new Error(parsed?.error ?? parsed?.reason ?? `HTTP ${response.status}`);
  }
  return parsed.data ?? null;
}

/* ------------------------------------------------------------------ *
 * 数据获取
 * ------------------------------------------------------------------ */
/**
 * 模块级缓存：面板被切走再切回来时 React 会重新挂载，有上次结果就先渲染、后台再刷新
 * （stale-while-revalidate）。侧栏来回点的时候不该每次都转圈。
 *
 * S3-3：缓存必须**按形状分开**。面板现在只请求当前视图需要的那一种形状（见 shapesForView），
 * 如果还共用一份缓存，切到「按项目」时会先拿「按截止」的旧载荷去渲染 → 短暂显示空列表。
 */
const lastListByShapes = new Map();
// 排序模式跨「切走再切回」保持；manual = 尊重拖动顺序
let lastSort = 'manual';

function useList(sort, shapes) {
  const [state, setState] = React.useState(() => {
    const cached = lastListByShapes.get(shapes);
    return cached
      ? { status: 'ready', data: cached, error: null }
      : { status: 'loading', data: null, error: null };
  });
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    /**
     * filter=all 而不是 open：面板是「按分组展示」的，宿主的分组是在**筛选后的子集**上算的，
     * 用 open 时 groups.completed 恒为空，「已完成」那一组就永远出不来（也就没法折叠/展开）。
     * 统计 stats 不受 filter 影响（宿主按全量算），所以顶部数字仍然是全局口径。
     *
     * S3-3：shapes 明确只取当前视图需要的一种 —— 缺省（不发 shapes）宿主会回三份同样大小的数据
     *（5000 条 = 4.28 MiB/次），而面板一次只用得上其中一份。
     */
    fetch(`${ROUTE_LIST}?filter=all&sort=${encodeURIComponent(sort || 'manual')}&shapes=${encodeURIComponent(shapes)}`, { cache: 'no-store', credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json().catch(() => null);
        if (!body?.ok) throw new Error(body?.error ?? body?.reason ?? '未知错误');
        lastListByShapes.set(shapes, body.data);
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
  }, [tick, sort, shapes]);

  const refresh = React.useCallback(() => setTick((n) => n + 1), []);
  return { ...state, refresh };
}

/* ------------------------------------------------------------------ *
 * 快速添加
 * ------------------------------------------------------------------ */
/** 小红旗图标：填充与描边都用 currentColor，颜色由按钮的 color 决定。 */

/**
 * 新增待办：平时只是一个**大加号**，点开才展开表单。
 * 日期用原生日历（`type=date`）、时间用原生时钟（`type=time`），
 * 优先级用三个不同颜色的**小红旗**表示（高=红、普通=琥珀、低=灰）。
 */

/** 小红旗图标：颜色由父级 color 决定；filled=选中档位。 */
function IconFlag({ filled, dashed }) {
  return React.createElement('svg', { width: 13, height: 13, viewBox: '0 0 16 16', 'aria-hidden': 'true' }, [
    React.createElement('path', {
      key: 'pole', d: 'M3.6 1.6v13', stroke: 'currentColor', strokeWidth: 1.6,
      strokeLinecap: 'round', fill: 'none', strokeDasharray: dashed ? '1.5 1.5' : undefined,
    }),
    React.createElement('path', {
      key: 'cloth', d: 'M5.2 2.4h7.4L11 5.2l1.6 2.8H5.2z',
      fill: filled ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 1.3,
      strokeLinejoin: 'round', strokeDasharray: dashed ? '1.5 1.5' : undefined,
    }),
  ]);
}

const IconCal = () => React.createElement('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': 'true' }, [
  React.createElement('rect', { key: 'r', x: 2.2, y: 3.4, width: 11.6, height: 10.4, rx: 2 }),
  React.createElement('path', { key: 'p', d: 'M2.2 6.6h11.6M5.4 2.2v2.4M10.6 2.2v2.4' }),
]);
const IconClock = () => React.createElement('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': 'true' }, [
  React.createElement('circle', { key: 'c', cx: 8, cy: 8, r: 5.8 }),
  React.createElement('path', { key: 'p', d: 'M8 4.9V8l2.2 1.4' }),
]);
/** 文件夹：第二行「项目」那一项的前缀图标（与日期/时间/优先级同一种画法）。 */
const IconFolder = () => React.createElement('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': 'true' }, [
  React.createElement('path', { key: 'f', d: 'M1.8 4.4a1.4 1.4 0 0 1 1.4-1.4h2.6l1.4 1.7h5a1.4 1.4 0 0 1 1.4 1.4v5.5a1.4 1.4 0 0 1-1.4 1.4H3.2a1.4 1.4 0 0 1-1.4-1.4z' }),
]);

/**
 * 「项目」选择器弹层里的查重：把用户输入对齐到已有项目。
 *
 * 重名不能报错、也不能造一个只差大小写/首尾空白的第二份（那会让「按项目」视图
 * 立刻裂成两个桶）。命中已有项目时返回**它在清单里的原名**，否则返回 null。
 * @param {string[]} options 已知项目（宿主 /list 的 projects）
 * @param {string} input 用户输入
 * @returns {string|null}
 */
export function matchExistingProject(options, input) {
  const name = String(input ?? '').trim();
  if (!name) return null;
  const key = name.toLowerCase();
  const found = asArray(options).find((option) => typeof option === 'string' && option.trim().toLowerCase() === key);
  return found ? found.trim() : null;
}


/**
 * 快速添加：两行布局（设计稿 v5）。
 *   第一行：待办内容 + 添加；
 *   第二行（更小）：日期 / 时间 / 优先级——显示**当前值**，点开才选。
 * 标题里写了「明天下午3点」这类说法会被实时解析：第二行自动点亮并标"· 识别"，
 * 且日期词会从标题里摘掉。**手动改过就不再被自动覆盖**（手动优先）。
 */
function QuickAdd({ t, onAdd, busy, projects, projectsTruncated }) {
  const [title, setTitle] = React.useState('');
  const [due, setDue] = React.useState('');
  const [dueTime, setDueTime] = React.useState('');
  const [priority, setPriority] = React.useState('none');
  // 项目：null = 未归类。它是**纯手动**字段（标题里没有"项目词"可解析），
  // 所以不存在"自动识别覆盖手动选择"的问题，只要求改标题不动它。
  const [project, setProject] = React.useState(null);
  const [parsed, setParsed] = React.useState(null);
  const [manual, setManual] = React.useState(false); // 用户手动改过日期/时间
  const [flagOpen, setFlagOpen] = React.useState(false);
  const [projectOpen, setProjectOpen] = React.useState(false);
  const [projectDraft, setProjectDraft] = React.useState('');
  // 点"整块胶囊"都要弹出选择器：Safari 里带值的 date/time 输入光靠点击只会聚焦，
  // 所以统一主动调 showPicker()（不可用时退回 focus+click）
  const dateRef = React.useRef(null);
  const timeRef = React.useRef(null);
  const openPicker = (ref) => {
    const el = ref.current;
    if (!el) return;
    if (typeof el.showPicker === 'function') {
      try { el.showPicker(); return; } catch { /* 某些环境不允许，走下面的兜底 */ }
    }
    el.focus();
    try { el.click(); } catch { /* 忽略 */ }
  };

  // 输入防抖 300ms 再解析（每按一键就解析会闪烁）
  React.useEffect(() => {
    if (manual) return undefined;
    const text = title;
    if (!text || !text.trim()) { setParsed(null); return undefined; }
    const timer = setTimeout(() => {
      const result = parseNaturalDue(text, Date.now());
      if (result.matched.length) {
        setParsed(result);
        setDue(result.due ?? '');
        setDueTime(result.dueTime ?? '');
      } else {
        setParsed(null);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [title, manual]);

  const submit = () => {
    if (busy) return;
    let payloadTitle = title;
    if (!manual) {
      const result = parseNaturalDue(title, Date.now());
      if (result.matched.length) payloadTitle = result.title; // 日期词摘掉
    }
    Promise.resolve(onAdd({
      title: payloadTitle,
      due: due || null,
      dueTime: dueTime || null,
      priority,
      // 空值显式给 null（不是 undefined）：宿主对请求体做「无损 JSON」校验，
      // undefined 会被当成缺键，甚至让整次调用被拒（与 due/dueTime 同一条约定）。
      project: project ?? null,
    })).then((ok) => {
      if (ok !== false) {
        setTitle('');
        setParsed(null);
        setManual(false);
        setFlagOpen(false);
        setProjectOpen(false);
        // 日期/时间/优先级/项目保留：连着录同一批事（同项目、同一天）不用重设
      }
    }).catch(() => { /* onAdd 内部已显示错误 */ });
  };

  const today = dayKey(Date.now());
  const dateLabel = due
    ? (due === today ? t('todayWord') : `${due.slice(5).replace('-', '-')}`)
    : t('dateUnset');
  const timeLabel = dueTime || t('timeUnset');
  const prioLabel = priority === 'high' ? t('prioHigh') : priority === 'normal' ? t('prioNormal') : priority === 'low' ? t('prioLow') : t('prioNone');
  const prioColor = priority === 'high' ? C.error : priority === 'normal' ? C.warn : C.label3;

  const flags = [
    { value: 'none', label: t('prioNone'), color: C.label3, dashed: true },
    { value: 'high', label: t('prioHigh'), color: C.error },
    { value: 'normal', label: t('prioNormal'), color: C.warn },
    { value: 'low', label: t('prioLow'), color: C.label3 },
  ];

  const setDate = (value) => {
    setManual(true);
    setDue(value);
    if (!value) setDueTime(''); // 没日期就没时间
    setFlagOpen(false);
  };
  const setTime = (value) => {
    setManual(true);
    if (value && !due) setDue(dayKey(Date.now())); // 只选时间＝今天
    setDueTime(value);
  };

  /** 已知项目（宿主 /list 的 projects 字段，任何 shapes 下都有）。 */
  const projectOptions = asArray(projects)
    .map((name) => (typeof name === 'string' ? name.trim() : ''))
    .filter(Boolean);

  /** Esc 关闭项目弹层（chip 与弹层都挂，键盘从哪儿进来都能关）。 */
  const closeProjectOnEscape = (event) => {
    if (event?.key === 'Escape') setProjectOpen(false);
  };

  /**
   * 弹层里的「新建」（点按钮或输入框回车）：
   * 重名（忽略大小写与首尾空白）时**直接选中已有项目**——不报错，也不造一份近重复项
   * （那会让「按项目」视图立刻裂成两个桶）；否则就用输入的名字。
   */
  const createProject = () => {
    const name = String(projectDraft ?? '').trim();
    if (!name) return; // 空输入：什么都不做（不建空项目，也不关弹层）
    setProject(matchExistingProject(projectOptions, name) ?? name);
    setProjectDraft('');
    setProjectOpen(false);
  };

  return React.createElement('div', { key: 'qa', style: { marginBottom: 12 } }, [
    // ---- 第一行：内容 + 添加 ----
    React.createElement('div', { key: 'l1', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
      React.createElement('input', {
        key: 'ti',
        className: 'wt-input',
        style: { flex: '1 1 auto', fontSize: 13, padding: '7px 10px' },
        value: title,
        placeholder: t('addPlaceholder'),
        'aria-label': t('addPlaceholder'),
        onChange: (event) => {
          const next = event.target.value;
          setTitle(next);
          // 手动优先，但把标题清空＝重新开始：交回给自动识别
          if (!next.trim()) { setManual(false); setParsed(null); }
        },
        onKeyDown: (event) => { if (event.key === 'Enter') submit(); },
      }),
      React.createElement('button', {
        key: 'add', type: 'button', className: 'wt-btn wt-btn-primary',
        disabled: Boolean(busy), onClick: submit,
      }, t('add')),
    ]),

    // ---- 第二行（更小）：日期 / 时间 / 优先级 / 项目 ----
    React.createElement('div', { key: 'l2', style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, fontSize: 11.5, flexWrap: 'wrap' } }, [
      // 日期：label 里套一个透明的原生 date 输入，点它即弹系统日历
      React.createElement('label', {
        key: 'due',
        className: `wt-chip${parsed && parsed.due ? ' is-parsed' : ''}`,
        'data-wt-field': 'due',
        title: t('dueLabel'),
        onClick: (event) => { event.preventDefault(); openPicker(dateRef); },
        style: { position: 'relative', cursor: 'pointer', color: due ? C.label : C.label3, borderColor: parsed && parsed.due ? C.brand : undefined },
      }, [
        React.createElement(IconCal, { key: 'i' }),
        React.createElement('span', { key: 'v' }, due ? `${today === due ? t('todayWord') : due}${parsed && parsed.due ? ` · ${t('fromParsed')}` : ''}` : t('dateUnset')),
        React.createElement('input', {
          key: 'in', ref: dateRef, type: 'date', value: due, 'aria-label': t('dueLabel'),
          style: { position: 'absolute', inset: 0, opacity: 0, border: 0, padding: 0, width: '100%', height: '100%', cursor: 'pointer' },
          onChange: (event) => setDate(event.target.value),
        }),
      ]),
      // 时间：同样用原生 time 输入；只选时间时自动补今天
      React.createElement('label', {
        key: 'time',
        className: `wt-chip${parsed && parsed.dueTime ? ' is-parsed' : ''}`,
        'data-wt-field': 'time',
        title: t('dueTimeLabel'),
        onClick: (event) => { event.preventDefault(); openPicker(timeRef); },
        style: { position: 'relative', cursor: 'pointer', color: dueTime ? C.label : C.label3, borderColor: parsed && parsed.dueTime ? C.brand : undefined },
      }, [
        React.createElement(IconClock, { key: 'i' }),
        React.createElement('span', { key: 'v' }, `${timeLabel}${parsed && parsed.dueTime ? ` · ${t('fromParsed')}` : ''}`),
        React.createElement('input', {
          key: 'in', ref: timeRef, type: 'time', value: dueTime, lang: 'zh-CN', 'aria-label': t('dueTimeLabel'),
          style: { position: 'absolute', inset: 0, opacity: 0, border: 0, padding: 0, width: '100%', height: '100%', cursor: 'pointer' },
          onChange: (event) => setTime(event.target.value),
        }),
      ]),
      // 优先级：点开四个小旗
      React.createElement('span', { key: 'prio', style: { position: 'relative' } }, [
        React.createElement('button', {
          key: 'btn', type: 'button', className: 'wt-chip', 'data-wt-field': 'priority',
          style: { color: prioColor, cursor: 'pointer', font: 'inherit', fontSize: 11.5 },
          title: t('priorityLabel'), 'aria-label': t('priorityLabel'), 'aria-expanded': flagOpen,
          onClick: () => setFlagOpen((open) => !open),
        }, [
          React.createElement(IconFlag, { key: 'f', dashed: priority === 'none', filled: priority !== 'none' }),
          React.createElement('span', { key: 'v' }, `${t('priorityLabel')} · ${prioLabel}`),
        ]),
        flagOpen ? React.createElement('div', {
          key: 'pop',
          style: {
            position: 'absolute', top: '100%', left: 0, zIndex: 5, marginTop: 4, padding: 6, display: 'flex', gap: 4,
            background: C.layer1, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.12)',
          },
        }, flags.map((flag) => React.createElement('button', {
          key: flag.value, type: 'button', className: 'wt-chip',
          style: { color: flag.color, font: 'inherit', fontSize: 11.5, cursor: 'pointer', borderColor: priority === flag.value ? flag.color : undefined },
          title: flag.label,
          onClick: () => { setPriority(flag.value); setFlagOpen(false); },
        }, [
          React.createElement(IconFlag, { key: 'f', filled: priority === flag.value, dashed: flag.value === 'none' }),
          React.createElement('span', { key: 'v' }, flag.label),
        ]))) : null,
      ]),
      // 项目：**排在优先级之后**（顺序：日期 → 时间 → 优先级 → 项目）。
      // 点开一个与优先级同风格的小弹层：已有项目（点选）→ 新建（输入 + 新建）→ 未归类（清除）。
      React.createElement('span', { key: 'project', style: { position: 'relative' } }, [
        React.createElement('button', {
          key: 'btn', type: 'button', className: 'wt-chip', 'data-wt-field': 'project',
          style: { color: project ? C.label : C.label3, cursor: 'pointer', font: 'inherit', fontSize: 11.5 },
          title: t('projectLabel'),
          'aria-label': t('projectLabel'),
          'aria-expanded': projectOpen,
          'aria-haspopup': 'true',
          onClick: () => setProjectOpen((open) => !open),
          onKeyDown: closeProjectOnEscape,
        }, [
          React.createElement(IconFolder, { key: 'i' }),
          React.createElement('span', { key: 'v' }, project ? project : `${t('projectLabel')} · ${t('noProject')}`),
        ]),
        projectOpen ? React.createElement('div', {
          key: 'pop',
          role: 'group',
          'aria-label': t('projectLabel'),
          onKeyDown: closeProjectOnEscape,
          style: {
            position: 'absolute', top: '100%', left: 0, zIndex: 5, marginTop: 4, padding: 6,
            display: 'flex', flexDirection: 'column', gap: 4, minWidth: 176, maxWidth: 260,
            background: C.layer1, border: `1px solid ${C.border}`, borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,.12)',
          },
        }, [
          // 已有项目：一行一个，当前选中的高亮（aria-pressed 供读屏与测试识别）
          ...projectOptions.map((name) => React.createElement('button', {
            key: `p:${name}`, type: 'button', className: 'wt-chip', 'data-wt-project': name,
            title: name, 'aria-pressed': project === name,
            style: {
              color: project === name ? C.label : C.label2, font: 'inherit', fontSize: 11.5,
              cursor: 'pointer', justifyContent: 'flex-start',
              borderColor: project === name ? C.brand : undefined,
            },
            onClick: () => { setProject(name); setProjectOpen(false); },
          }, React.createElement('span', { key: 'v' }, name))),
          // 未归类：一键清除（等价 project = null）
          React.createElement('button', {
            key: 'none', type: 'button', className: 'wt-chip', 'data-wt-project-clear': 'true',
            title: t('noProject'), 'aria-pressed': project === null,
            style: {
              color: project === null ? C.label : C.label3, font: 'inherit', fontSize: 11.5,
              cursor: 'pointer', justifyContent: 'flex-start',
              borderColor: project === null ? C.brand : undefined,
            },
            onClick: () => { setProject(null); setProjectOpen(false); },
          }, React.createElement('span', { key: 'v' }, t('noProject'))),
          // 新建：文本输入 + 「新建」（回车即新建）
          React.createElement('div', {
            key: 'new', style: { display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 },
          }, [
            React.createElement('input', {
              key: 'in', className: 'wt-input', value: projectDraft,
              placeholder: t('projectNewPlaceholder'),
              'aria-label': t('projectNewPlaceholder'),
              onChange: (event) => setProjectDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') createProject();
                else if (event.key === 'Escape') setProjectOpen(false);
              },
              style: { flex: '1 1 auto', minWidth: 0, fontSize: 11.5 },
            }),
            React.createElement('button', {
              key: 'go', type: 'button', className: 'wt-btn', 'data-wt-project-create': 'true',
              title: t('projectNew'), onClick: createProject,
            }, t('projectNew')),
          ]),
          projectsTruncated
            ? React.createElement('div', {
              key: 'more', style: { fontSize: 10.5, color: C.label3 },
            }, fillTemplate(t('projectListTruncated'), { count: projectOptions.length }))
            : null,
        ]) : null,
      ]),
    ]),
  ]);
}

/* ------------------------------------------------------------------ *
 * 单行：查看 / 行内编辑 / 二次确认删除
 * 状态都留在这一行内部，所以在别的行上敲字、或者列表刷新，都不会把正在编辑的内容冲掉。
 *
 * S3-3（客户端侧）：外面包一层 `React.memo`（默认浅比较）。5000 条时每一次
 * 「与数据无关」的父级重渲染（折叠分组、错误条、pending 计数、拖动开始/结束…）
 * 都会把整张列表 reconcile 一遍；memo 让只有 props 真的变了的那些行重渲染。
 * 为了让浅比较真的起作用，父级传下来的必须是稳定引用：
 *   - `t`：拿不到宿主注入时用模块级 FALLBACK_T，不再是每次渲染新建的箭头函数；
 *   - `onToggle/onRemove/onSave`：useCallback（面板里已保证）；
 *   - `drag`：共享的 dragHandlers 对象（useMemo），每一行不再各造一个新对象；
 *     每一行与拖动相关的差异只有布尔 `dragging`。
 * ------------------------------------------------------------------ */
const TodoRow = React.memo(function TodoRow({ todo, today, t, onToggle, onRemove, onSave, drag, dragging }) {
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
    setDraft(buildEditDraft(row));
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
    if (nextDue !== due) {
      patch.due = nextDue; // 空串 = 清空截止日期
      if (!nextDue) patch.dueTime = 'none'; // 没有日期就没有时间
    }
    const nextDueTime = String(draft.dueTime ?? '').trim();
    if (nextDue && nextDueTime !== (row.dueTime ?? '')) patch.dueTime = nextDueTime === '' ? 'none' : nextDueTime;
    const priority = draft.priority || row.priority || 'none';
    if (priority !== (row.priority ?? 'none')) patch.priority = priority;
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
        field('tm', t('dueTimeLabel'), React.createElement('input', {
          className: 'wt-input', style: inputStyle, type: 'time', value: draft.dueTime, disabled: !draft.due,
          'aria-label': t('dueTimeLabel'),
          onChange: (event) => setDraft((prev) => ({ ...prev, dueTime: event.target.value })),
        })),
        field('prio', t('priorityLabel'), React.createElement('select', {
          className: 'wt-input', style: inputStyle, value: draft.priority,
          'aria-label': t('priorityLabel'),
          onChange: (event) => setDraft((prev) => ({ ...prev, priority: event.target.value })),
        }, EDIT_PRIORITY_OPTIONS.map((value) => React.createElement(
          'option',
          { key: value, value },
          t(PRIORITY_LABEL_KEYS[value]),
        )))),
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
      style: dragging ? { opacity: 0.45 } : undefined,
    }
    : {};
  return React.createElement('div', { className: 'wt-row', ...dragAttrs, style: row.priority === 'high' ? { borderLeft: `2px solid ${C.error}`, paddingLeft: 8 } : undefined }, [
    /* 优先级呈现（设计稿 v5）：高＝红色左缘 + 实心红旗；中＝琥珀；低＝灰；无＝什么都不显示 */
    row.priority && row.priority !== 'none' ? React.createElement('span', {
      key: 'prio-flag',
      title: row.priority === 'high' ? t('prioHigh') : row.priority === 'normal' ? t('prioNormal') : t('prioLow'),
      style: {
        display: 'inline-flex', flex: '0 0 auto',
        color: row.priority === 'high' ? C.error : row.priority === 'normal' ? C.warn : C.label3,
      },
    }, React.createElement(IconFlag, { filled: row.priority === 'high' })) : null,
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
});

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
      // S3-3：共享同一个 drag 对象（引用稳定），每行只有布尔 dragging 不同 ——
      // 否则每一行每次父级重渲染都会收到一个新的 drag 对象，memo 的浅比较必然失效
      drag,
      dragging: Boolean(drag) && drag.dragId === todo?.id,
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

/**
 * 视图 → 需要向宿主索取的数据形状（S3-3 客户端侧）。
 *
 * 宿主 `/list` 支持 `shapes=todos|groups|projectGroups`，但面板原来**完全没用**：
 * 每次轮询都拿三份同样大小的数据（5000 条 = 4.28 MiB/次），而面板一次只用得上其中一份。
 *   - 「按截止」渲染 `groups`；
 *   - 「按项目」渲染 `projectGroups`；
 *   - `todos`（平铺顺序）只在没有分组时的兼容路径上用得到，见 payloadRecordIds()。
 * 缺省（不带 shapes）仍然合法 —— 这是宿主侧的兼容合同，别的地方照旧能用。
 */
export const VIEW_SHAPES = { due: 'groups', project: 'projectGroups' };

/** 某个视图需要哪一份形状（未知视图按默认的「按截止」处理）。 */
export function shapesForView(view) {
  return VIEW_SHAPES[view] ?? VIEW_SHAPES.due;
}

/**
 * 当前载荷里有这个视图渲染所需的形状吗？
 *
 * 切视图时会立刻按新形状重新请求，但数据要等一个 RTT 才到；这期间如果沿用旧载荷，
 * `groups`（或 `projectGroups`）缺失会被当成「一条都没有」而闪一下空列表。
 * 有数据但缺形状时按「还在加载」渲染，等新载荷落地。
 * @param {object|null} data
 * @param {string} view
 */
export function hasViewShape(data, view) {
  if (!data) return false;
  return shapesForView(view) === 'projectGroups'
    ? Array.isArray(data.projectGroups)
    : Boolean(data.groups && typeof data.groups === 'object');
}

/**
 * 从当前载荷里取出一份「完整且有序」的记录 id 列表 —— 拖拽重排用它算新顺序。
 *
 * 优先用 `todos`（真·全局顺序）；只取了分组形状时把当前视图的桶摊平：用户看到的就是
 * 这个顺序，桶内顺序由宿主按当前 sort 排好，所以拖拽结果与屏幕上看到的一致。
 * 只取了 `groups` 时不再为拖拽多发一次请求（拖拽是低频的用户动作，多一次全量拉并不划算）。
 * @param {object|null} data
 * @returns {string[]}
 */
export function payloadRecordIds(data) {
  const flat = asArray(data?.todos).map((todo) => todo?.id).filter(Boolean);
  if (flat.length) return flat;
  const merged = [];
  const groups = data?.groups;
  if (groups && typeof groups === 'object') {
    for (const group of GROUPS) merged.push(...asArray(groups[group.key]));
  }
  for (const bucket of asArray(data?.projectGroups)) merged.push(...asArray(bucket?.todos));
  return merged.map((todo) => todo?.id).filter(Boolean);
}

/** 极简占位符替换：`{name}` → vars[name]（面板文案的少量插值，不引第三方库）。 */
function fillTemplate(text, vars) {
  return String(text).replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

/**
 * 把 `describe()` 里的存储告警整理成面板上真的能看见的几行（复审 R4/R5）。
 *
 * `mismatch`（后端不一致）、`split`（两处数据不一致）、`backendError`（当前后端读写失败）
 * 是**必须让用户看见**的三条：它们意味着「你看到的可能不是全部数据」。
 * `retired`（回退文件已退役）与 `merge`（最近一次合并）正常情况下是信息性的，
 * 但有两种形态必须升级成 warn（复审 0.2.2 F1/F3）：
 *   - 已退役 **且** 官方存储不可用：面板此时看不到任何待办，这条告警是唯一的解释；
 *   - 退役改名失败（`retired.error`）：必须显示失败原因与处理建议，绝不能说「已迁移并退役」。
 *
 * @param {object} store `/list` 载荷里的 store（= 宿主的 describe()）
 * @param {(key: string) => string} t 文案函数
 * @returns {{key: string, tone: 'warn'|'info', text: string}[]}
 */
export function storeAlerts(store, t) {
  if (!store || typeof store !== 'object') return [];
  const alerts = [];
  const retired = store.retired;
  const retiredKnown = Boolean(retired?.path || retired?.movedTo);
  if (store.mismatch) alerts.push({ key: 'mismatch', tone: 'warn', text: `${t('storeMismatch')}：${store.mismatch}` });
  if (store.split) alerts.push({ key: 'split', tone: 'warn', text: `${t('storeSplit')}：${store.split}` });
  if (store.backendError) alerts.push({ key: 'backendError', tone: 'warn', text: `${t('storeError')}：${store.backendError}` });
  // 复审 0.2.2 F3：rename 失败时**只**能说「失败 + 原因 + 建议」，且原错误不能丢
  if (retired?.error) {
    alerts.push({
      key: 'retiredFailed',
      tone: 'warn',
      text: `${t('storeRetiredFailed')}：${retired.error}。`
        + fillTemplate(t('storeRetiredFailedHint'), { path: retired.path ?? '' }),
    });
  } else if (retired?.movedTo) {
    alerts.push({ key: 'retired', tone: 'info', text: `${t('storeRetired')}：${retired.movedTo}` });
  }
  // 复审 0.2.2 F1：退役 + 官方存储不可用 = 看不到待办；面板此时**只**剩下这条解释。
  // 放在最后，保证 `retiredUnavailable` 是这一组里最醒目的一行。
  const domainUnavailable = Boolean(retiredKnown
    && (typeof store.domainUnavailable === 'boolean' ? store.domainUnavailable : store.kind !== 'domain'));
  if (domainUnavailable) {
    const when = Number.isFinite(retired?.at) ? new Date(retired.at).toLocaleString() : '此前';
    const archive = retired.movedTo ?? retired.marker ?? retired.path ?? '';
    alerts.push({
      key: 'retiredUnavailable',
      tone: 'warn',
      text: `${t('storeRetiredUnavailable')}：${fillTemplate(t('storeRetiredUnavailableHint'), { when, archive })}`,
    });
  }
  const merge = store.merge;
  if (merge && Number.isFinite(merge.merged)) {
    if (merge.aborted) {
      // 合并中途失败并已回滚：这是必须让用户看见的失败，不是信息
      alerts.push({ key: 'mergeAborted', tone: 'warn', text: `${t('storeMergeAborted')}：${merge.writeError ?? ''}` });
    } else {
      alerts.push({
        key: 'merge',
        tone: 'info',
        text: fillTemplate(t('storeMergeNote'), {
          merged: merge.merged, conflicts: merge.conflicts ?? 0, added: merge.added ?? 0,
        }),
      });
    }
  }
  return alerts;
}

/**
 * 页脚「存储位置」那一行要显示什么。
 *
 * 复审 0.2.2 F1/F3：只要句柄知道回退文件已退役，就**不能**把那个路径当作存储位置显示
 * （它可能根本不存在）。此时数据在官方存储：
 *   - 官方后端可用 → 「官方 storage · 回退文件已迁移并退役 · 档案 <movedTo>」；
 *   - 官方后端不可用 → 额外写「不可用」，与 warn 告警互相印证。
 * 退役失败（文件还在原地）时只显示**确认存在**的哨兵路径，不显示那个半退役的原文件。
 * @param {object} store
 * @param {(key: string) => string} t
 * @returns {string|null}
 */
export function storeLocationLabel(store, t) {
  if (!store || typeof store !== 'object') return null;
  const retired = store.retired;
  const retiredKnown = Boolean(retired?.path || retired?.movedTo);
  if (retiredKnown) {
    const domainReady = typeof store.domainUnavailable === 'boolean'
      ? !store.domainUnavailable
      : store.kind === 'domain';
    const confirmed = retired.movedTo ?? retired.marker;
    const archive = confirmed ? ` · ${t('storeRetiredArchive')} ${confirmed}` : '';
    const state = domainReady ? t('storeDomain') : `${t('storeDomain')} · ${t('storeUnavailable')}`;
    return `${t('storeAt')} · ${state} · ${t('storeRetired')}${archive}`;
  }
  if (!store.location) return null;
  const kind = store.kind === 'domain' ? t('storeDomain') : t('storeFile');
  return `${t('storeAt')} · ${kind} · ${store.location}`;
}

/**
 * 页脚「版本」旁边那一格该显示什么 —— 纯函数（导出供单测），不碰 DOM、不用 innerHTML。
 *
 * 状态优先级（升级过程本身比「有新版本」更重要）：
 *   running → 正在更新…（不可点）
 *   done    → 已更新到 vX，重启 DSH 生效
 *   failed  → 失败原因（`linked` 换成「本地链接安装」的专门说明，那不是一个故障）
 *   idle + hasUpdate → 「有新版本 vX · 立即更新」（可点）
 *
 * @param {object|null} run 宿主 /worktodo/update 的状态（或 /list 载荷里的摘要）
 * @param {object|null} update /list 载荷里的 update 字段
 * @param {(key: string) => string} t 文案函数
 * @returns {{text: string, title: string, tone: 'ok'|'busy'|'warn'|'error', action: 'update'|'retry'|null, disabled: boolean}|null}
 */
export function updateBadgeState(run, update, t) {
  const state = run?.state ?? 'idle';
  if (state === 'running') {
    const to = run?.to ? ` v${run.to}` : '';
    return {
      text: `${t('updating')}${to}`,
      title: run?.command ? String(run.command) : t('updating'),
      tone: 'busy',
      action: null,
      disabled: true,
    };
  }
  if (state === 'done') {
    const to = run?.to ?? update?.installed ?? update?.latest;
    return {
      text: to ? t('updatedRestart').replace('{version}', `v${to}`) : t('updateRestartHint'),
      title: to ? `v${to}` : '',
      tone: 'ok',
      action: null,
      disabled: true,
    };
  }
  if (state === 'failed') {
    const reason = run?.reason;
    if (reason === 'linked') {
      return { text: t('updateLinked'), title: t('updateLinked'), tone: 'warn', action: null, disabled: true };
    }
    const detail = String(run?.error ?? reason ?? '');
    return {
      // 失败要能重试：用户可能只是网络抖了一下
      text: `${t('updateFailed')}：${detail}`,
      title: `${t('updateRetryHint')}${detail ? ` — ${detail}` : ''}`,
      tone: 'error',
      action: 'retry',
      disabled: false,
    };
  }
  if (update?.hasUpdate) {
    return {
      text: `${t('updateAvailable')} v${update.latest} · ${t('updateNow')}`,
      title: t('updateHint'),
      tone: 'ok',
      action: 'update',
      disabled: false,
    };
  }
  return null;
}

function WorkTodoPanel(props) {
  // t 由 locale 服务通过 slot props 注入；拿不到时退回中文，至少不显示裸 key。
  // 兜底必须是模块级常量（FALLBACK_T）：每次渲染新建箭头函数会让 TodoRow 的 memo 永远失效。
  const t = typeof props?.t === 'function' ? props.t : FALLBACK_T;
  // 排序：manual（默认，尊重拖动）/ priority / created
  const [sort, setSortState] = React.useState(lastSort);
  const setSort = React.useCallback((next) => { lastSort = next; setSortState(next); }, []);
  const [dragId, setDragId] = React.useState(null);
  // 视图：按截止（默认）或按项目。必须在 useList 之前声明 —— 视图决定要请求哪种形状（S3-3）。
  const [view, setView] = React.useState('due');
  const shapes = shapesForView(view);
  const { status, data, error, refresh } = useList(sort, shapes);

  // 版本与自升级状态必须在**任何依赖它们的 hook 之前**解析：
  // hook 的依赖数组是在渲染期求值的，放到后面（早退分支之后）会踩 TDZ。
  const version = typeof data?.version === 'string' ? data.version : '';
  const update = data?.update ?? null;

  /**
   * 跟随外部改动刷新（审计 F7：宿主的 onChanged/onChange 原来是死代码，面板只在
   * 挂载 / 切排序 / 点刷新 / 自己写操作后才拉数据，agent 用工具加了一条用户看不到）。
   * 这里定期 + 窗口重新聚焦 / 重新可见时拉一次；清理函数里清掉定时器与监听，卸载后不留活动引用。
   * 复审 R4：轮询已放宽到 CHANGE_POLL_MS（30s），「重新聚焦」那条路径负责补新鲜度。
   * S3-3（客户端侧）：窗口隐藏时**停轮询**（一次都不打宿主）；重新可见时立刻补一次。
   */
  React.useEffect(() => {
    const timer = setInterval(() => {
      if (isWindowHidden()) return; // 后台/最小化的窗口不再每 30 秒白打一次宿主
      refresh();
    }, CHANGE_POLL_MS);
    timer?.unref?.(); // Node（测试环境）里不要因为这个定时器挂住事件循环
    const onActive = () => refresh();
    const onVisible = () => { if (!isWindowHidden()) refresh(); };
    window?.addEventListener?.('focus', onActive);
    if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window?.removeEventListener?.('focus', onActive);
      if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', onVisible);
    };
  }, [refresh]);

  /**
   * 自升级的本地状态：点下「立即更新」后，到轮询结束前的状态由它渲染。
   * `null` 表示「跟随 /list 载荷里的 update.run」（例如刚刷新页面时宿主还在跑）。
   */
  const [updateRun, setUpdateRun] = React.useState(null);
  const run = updateRun ?? update?.run ?? null;
  const runState = run?.state ?? 'idle';

  /**
   * 升级进度轮询：**只在 running 时存在**，一离开 running 立刻停（依赖数组里就是 runState）。
   * 常驻定时器会让「不打无用请求」这条约束作废，所以这里刻意不做成固定间隔的常驻 effect。
   */
  React.useEffect(() => {
    if (runState !== 'running') return undefined;
    let alive = true;
    const timer = setInterval(() => {
      if (isWindowHidden()) return; // 后台窗口不轮询；重新可见时由 visibilitychange 补
      fetchUpdateRun()
        .then((next) => {
          if (!alive || !next) return;
          if (next.state !== 'running') {
            setUpdateRun(next);
            refresh(); // 升级落盘后列表/版本信息要重取一次
          }
        })
        .catch(() => { /* 单次轮询失败不改状态，下一次再试；升级子进程不受影响 */ });
    }, UPDATE_POLL_MS);
    timer?.unref?.(); // Node（测试环境）里不要因为这个定时器挂住事件循环
    return () => { alive = false; clearInterval(timer); };
  }, [runState, refresh]);

  // 写操作的错误条；readError 是拉取错误（用户关掉之后，只有换成新错误才再弹）
  const [barError, setBarError] = React.useState(null);
  const [dismissedReadError, setDismissedReadError] = React.useState(null);
  const readError = error && error !== dismissedReadError ? error : null;
  const shownError = barError ?? readError;

  const [notice, setNotice] = React.useState(null);
  const [pending, setPending] = React.useState(0);
  // 「已完成」默认折叠（做完的事不用占满屏幕），其余默认展开
  const [closed, setClosed] = React.useState({ completed: true });

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

  /**
   * 「立即更新」：POST 触发升级 → 立刻把本地状态设成 running（按钮马上变成「正在更新…」），
   * 之后由上面那个 2 秒轮询接管，直到 done/failed。
   *
   * 刻意**不走 runWrite**：升级不是待办写操作，失败原因（尤其 `linked`）要留在页脚那一格，
   * 而不是弹到面板顶部的写错误条上。
   */
  const handleUpdate = React.useCallback(() => {
    if (runState === 'running') return Promise.resolve(false);
    setUpdateRun({ state: 'running', from: version || null, to: update?.latest ?? null });
    return postJson('/update', { action: 'plugin-update' })
      .then((next) => {
        // 宿主可能同步就给结论（linked / profile-not-found），也可能给 running
        if (next && typeof next === 'object' && next.state) setUpdateRun(next);
        else setUpdateRun({ state: 'done', to: update?.latest ?? null });
        refresh();
        return true;
      })
      .catch((updateError) => {
        setUpdateRun({
          state: 'failed',
          reason: updateError?.reason ?? null,
          error: String(updateError?.message ?? updateError),
        });
        return false;
      });
  }, [runState, version, update?.latest, refresh]);

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
      // 必须一起发：QuickAdd 已经把「下午3点」这类时间词从标题里摘掉了，
      // 这里漏掉就等于用户输入的时间被永久丢弃（审计 F5）。空值统一给 null，别给 undefined。
      dueTime: input?.dueTime ? String(input.dueTime) : null,
      priority: input?.priority ?? 'normal',
      // 项目：来自 QuickAdd 的项目选择器。空值同样必须显式 null——
      // 宿主对请求体做无损 JSON 校验，undefined 会变成「没有这个键」甚至整次调用被拒。
      project: input?.project ? String(input.project).trim() : null,
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

    // S3-3：面板现在只取当前视图需要的形状（按截止=groups、按项目=projectGroups），
    // 载荷里不一定有 todos —— 从当前视图的桶摊平出完整顺序（见 payloadRecordIds）。
    const ids = payloadRecordIds(data);

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

  // S3-3：切视图会按新形状立刻重新请求，但新载荷要等一个 RTT。这期间若沿用旧载荷，
  // 缺少的形状会被当成「一条都没有」而闪一下空列表；按「还在加载」渲染，等数据落地。
  if (data && !hasViewShape(data, view)) {
    return React.createElement('div', {
      className: 'wt-root',
      style: { ...rootStyle, display: 'flex', alignItems: 'center', gap: 8, color: C.label3, padding: 28 },
    }, [
      React.createElement('style', { key: 'css' }, STYLE_TEXT),
      React.createElement('span', { key: 'sp', className: 'wt-spin' }),
      React.createElement('span', { key: 't' }, t('loading')),
    ]);
  }

  const groups = data?.groups ?? {};
  const stats = data?.stats ?? {};
  const today = typeof data?.today === 'string' && data.today ? data.today : localToday();
  const store = data?.store ?? null;
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  // 页脚「升级」那一格：纯函数决定文案/配色/是否可点（见 updateBadgeState）
  const updateBadge = updateBadgeState(run, update, t);
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

    React.createElement(QuickAdd, {
      key: 'quick',
      t,
      busy: pending > 0,
      onAdd: handleAdd,
      // 已知项目：宿主 /list 的 projects 在**任何 shapes 下都有**（见 service.list），
      // 所以面板无论停在「按截止」还是「按项目」，选择器都能列出已有项目。
      projects: asArray(data?.projects).filter((name) => typeof name === 'string' && name.trim()),
      projectsTruncated: Boolean(data?.projectsTruncated),
    }),

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
    }, [
      /* 角落信息：装了哪一版 + 有没有新版（一眼可见，不占主区） */
      React.createElement('div', {
        key: 'ver',
        style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 2 },
      }, [
        React.createElement('span', {
          key: 'v',
          title: t('versionHint'),
          style: { color: C.label3 },
        }, `${t('versionLabel')} ${version ? `v${version}` : '—'}`),
        updateBadge
          ? React.createElement('button', {
            key: 'u',
            type: 'button',
            className: 'wt-chip wt-update',
            // 升级进行中或面板还有写操作在飞时不可点，避免连点出第二个子进程
            disabled: updateBadge.disabled || pending > 0,
            onClick: updateBadge.action ? handleUpdate : undefined,
            title: updateBadge.title,
            style: { fontSize: 10, ...UPDATE_TONE_STYLE[updateBadge.tone] },
          }, updateBadge.text)
          : null,
      ]),
      storeLocationLabel(store, t)
        ? React.createElement('div', {
          key: 'store',
          title: storeLocationLabel(store, t),
          style: { wordBreak: 'break-all' },
        }, storeLocationLabel(store, t))
        : null,
      /* 复审 R4/R5：describe() 里的告警必须在面板上**看得见**，不能只躺在 /health 的 JSON 里 */
      ...storeAlerts(store, t).map((alert) => React.createElement('div', {
        key: `alert-${alert.key}`,
        className: `wt-store-alert wt-store-alert-${alert.tone}`,
        title: alert.text,
        style: alert.tone === 'warn'
          ? { color: C.warn, wordBreak: 'break-word' }
          : { color: C.label3, wordBreak: 'break-word' },
      }, alert.text)),
    ]),
  ]);
}

/* ------------------------------------------------------------------ *
 * 插件体
 * ------------------------------------------------------------------ */
export const inject = ['slots', 'locale'];

/**
 * 幂等注册（S6-2）。
 *
 * 官方 `slots.register` / `locale.register` 对重复注册是**抛错**而不是幂等
 *（`single slot "…" already has a registration` / `locale namespace "…" already has locale "…"`）。
 * 而客户端 `apply()` 里这两处原来都没有兜底：同一 ctx 上第二次 apply（或与别的插件撞了 slot id）
 * 会一路抛到客户端 apply → **面板整体消失**，用户只能刷新页面。
 * 这里把「注册失败」降级成「丢这一条 + 控制台一行 warn」：面板的主入口（main slot）继续注册，
 * 最坏情况只是少了侧栏入口或某个语言字典 —— 绝不整块挂不上。
 *
 * 与宿主半侧同一条策略：`lib/index.js` 的路由注册（S1-1）与工具注册都是「单条失败只降级」。
 * @param {string} label 给日志用的一句话
 * @param {() => any} run
 * @returns {any} 注册结果（失败时给一个空 disposer）
 */
function safeRegister(label, run) {
  try {
    return run();
  } catch (error) {
    // 不吞错：原始原因照原样打出来（排查「面板为什么没出现」时第一眼要看这个）
    console.warn(`[${SHORT_NAME}] ${label}失败（跳过这一条，其余照常）：${error?.message ?? error}`);
    return () => {};
  }
}

export function apply(ctx) {
  ctx.effect(
    () => safeRegister('locale 字典注册', () => ctx.locale.register(LOCALE_NS, { zh, en })),
    `${LOCALE_NS}: dictionaries`,
  );

  // 侧栏入口（id 必须与 main 面板的 key 同名，sidebar 用它去选中面板）
  // 同样包错误边界：图标渲染抛错也不该把整个 sidebar 入口打崩
  ctx.slots.inject('sidebar.panellist', () => safeRegister('sidebar.panellist 注册', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: SLOT_ID,
    order: 88,
    label: () => '待办',
    locale: LOCALE_NS,
  }, withErrorBoundary((props) => React.createElement(WorkTodoIcon, { size: props?.size ?? 16, active: props?.active })))));

  // 中栏独立面板（外面包一层错误边界：渲染抛错时给中文兜底 + 重试，而不是整块白屏）
  ctx.slots.inject('main', () => safeRegister('main 面板注册', () => ctx.slots.register({
    name: 'main',
    key: SLOT_ID,
    locale: LOCALE_NS,
  }, withErrorBoundary(WorkTodoPanel))));
}
