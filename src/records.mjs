/**
 * worktodo 数据模型（纯函数，零依赖，不碰 IO）。
 *
 * 设计取舍：
 *   1. 官方 @deepseek-ai/dsh-tool-todo（todo_write）是**整表替换 + 只有三态 + 归属于单个 agent 会话**：
 *      没有优先级、没有截止日期、没有项目、没有逐项编辑，也明确不支持跨 agent / 跨会话共享。
 *      本插件的差异化就是补上这块：列表归**人**所有，字段富、可逐项改、跨会话持久。
 *   2. 状态值与官方保持一致（pending / in_progress / completed），这样「把会话 todos 提升为工作待办」
 *      不需要任何映射表，用户看到的词也是同一套。
 *   3. 所有记录都是**纯 JSON 数据**（不可变、无 class、无 Date 实例），因为 storage-domain 的
 *      记录要能原样 JSON 往返；时间统一存毫秒时间戳，日期类字段存 'YYYY-MM-DD' 字符串。
 *   4. 这里只放可测的纯逻辑：校验、归一化、引用解析、分组、统计、排序、格式化。
 *      持久化在 store.mjs，编排在 service.mjs，宿主接线在 lib/index.js。
 */

/** 状态：与官方 todo_write 同名同义，便于互相提升。 */
export const STATUSES = ['pending', 'in_progress', 'completed'];
/** 优先级：只留三档，避免用户在选择上犹豫。 */
export const PRIORITIES = ['high', 'normal', 'low', 'none'];
/** 来源：人加的 / agent 加的 / 从会话 todos 提升的。 */
export const SOURCES = ['human', 'agent', 'session'];

/** 一天的毫秒数。 */
const DAY_MS = 24 * 60 * 60 * 1000;
/** 标题长度上限：够写清一件事，又不至于把面板撑爆。 */
const TITLE_MAX = 200;
/** 备注长度上限。 */
const NOTES_MAX = 2000;
/** 项目名长度上限。 */
const PROJECT_MAX = 60;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 补齐两位。 */
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 本地时区的 'YYYY-MM-DD'。
 * 用本地时间而不是 UTC：用户说的「今天」永远是墙上时钟的今天。
 * @param {number|Date} value 毫秒时间戳或 Date
 * @returns {string}
 */
export function dayKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 把 'YYYY-MM-DD' 解析成本地当天 00:00 的毫秒时间戳。
 * @param {string} key
 * @returns {number} 解析失败返回 NaN
 */
export function dayStart(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  if (!m) return Number.NaN;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0);
  // 反查一次，挡掉 2026-02-31 这种「格式对但日期不存在」的输入
  if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d)) {
    return Number.NaN;
  }
  return date.getTime();
}

/**
 * 本周一的 'YYYY-MM-DD'（中国习惯以周一为一周之始）。
 * @param {number} now 毫秒时间戳
 * @returns {string}
 */
export function weekStartKey(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  // getDay(): 0=周日，1=周一 … 6=周六；周一为 0 天前、周日为 6 天前
  const offset = (d.getDay() + 6) % 7;
  return dayKey(d.getTime() - offset * DAY_MS);
}

/**
 * 某个 'YYYY-MM-DD' 往后 n 天的 'YYYY-MM-DD'。
 *
 * 用日历运算（`Date#setDate`）而不是 `dayStart(key) + n * DAY_MS`：
 * 有夏令时的时区里一天可能是 23/25 小时，固定加 24h 会算错日期。
 * 跨月、跨年、闰日都由 Date 自己处理。
 * @param {string} key
 * @param {number} days
 * @returns {string}
 */
function addDaysKey(key, days) {
  const d = new Date(dayStart(key));
  d.setDate(d.getDate() + days);
  return dayKey(d);
}

/** 是否形如 'YYYY-MM-DD' 且是真实存在的日期。 */
export function isDayKey(value) {
  return typeof value === 'string' && !Number.isNaN(dayStart(value));
}

/* ------------------------------------------------------------------ *
 * 校验与归一化（所有写入路径的唯一入口）
 * ------------------------------------------------------------------ */

/** 统一的输入错误：带 reason，方便 UI 与工具把「为什么失败」原样告诉用户/模型。 */
export class WorkTodoError extends Error {
  /**
   * @param {string} reason 稳定的失败原因码
   * @param {string} message 给人看的话
   */
  constructor(reason, message) {
    super(message);
    this.name = 'WorkTodoError';
    this.reason = reason;
  }
}

/** 标题：去空白、非空、限长。 */
export function normalizeTitle(value) {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title) throw new WorkTodoError('empty-title', '待办标题不能为空');
  if (title.length > TITLE_MAX) throw new WorkTodoError('title-too-long', `待办标题过长（上限 ${TITLE_MAX} 字）`);
  return title;
}

/** 备注：允许空；允许 undefined（表示不改）。 */
export function normalizeNotes(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new WorkTodoError('bad-notes', '备注必须是文本');
  const notes = value.trim();
  if (notes.length > NOTES_MAX) throw new WorkTodoError('notes-too-long', `备注过长（上限 ${NOTES_MAX} 字）`);
  return notes;
}

/** 项目：允许空；去空白。 */
export function normalizeProject(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new WorkTodoError('bad-project', '项目名必须是文本');
  const project = value.trim();
  if (!project) return null;
  if (project.length > PROJECT_MAX) throw new WorkTodoError('project-too-long', `项目名过长（上限 ${PROJECT_MAX} 字）`);
  return project;
}

/** 状态：必须是三态之一。 */
export function normalizeStatus(value) {
  if (value === undefined || value === null) return null;
  const status = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  // 常见同义词：agent 和用户都不会严格按枚举写字
  const alias = { doing: 'in_progress', doing_ing: 'in_progress', wip: 'in_progress', inprogress: 'in_progress', done: 'completed', complete: 'completed', finished: 'completed', todo: 'pending', open: 'pending' };
  const resolved = alias[status] ?? status;
  if (!STATUSES.includes(resolved)) {
    throw new WorkTodoError('bad-status', `状态只能是 ${STATUSES.join(' / ')}，收到 ${JSON.stringify(value)}`);
  }
  return resolved;
}

/** 优先级：三档，接受 high/normal/low 与 p0/p1/p2、高中低。 */
export function normalizePriority(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim().toLowerCase();
  const alias = {
    p0: 'high', urgent: 'high', high: 'high', 高: 'high', 紧急: 'high', 重要: 'high',
    p1: 'normal', normal: 'normal', medium: 'normal', mid: 'normal', 中: 'normal', 普通: 'normal',
    p2: 'low', low: 'low', 低: 'low', 次要: 'low',
    none: 'none', no: 'none', 无: 'none', 不设: 'none', 无优先级: 'none',
  };
  const resolved = alias[raw];
  if (!resolved) throw new WorkTodoError('bad-priority', `优先级只能是 ${PRIORITIES.join(' / ')}，收到 ${JSON.stringify(value)}`);
  return resolved;
}

/**
 * 截止日期：接受 'YYYY-MM-DD'、'today'、'tomorrow'、'yesterday'、'+3d' / '-1d'、以及 'YYYY/MM/DD'。
 * @param {string|null|undefined} value 输入
 * @param {number} now 毫秒时间戳，作为相对日期的基准
 * @returns {string|null} 'YYYY-MM-DD' 或 null（清空）
 */
export function normalizeDue(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new WorkTodoError('bad-due', '截止日期必须是文本');
  const raw = value.trim().toLowerCase();
  if (!raw || raw === 'none' || raw === 'null' || raw === 'clear') return null;
  const today = dayKey(now);
  const relative = {
    today: 0, 今天: 0,
    tomorrow: 1, 明天: 1,
    yesterday: -1, 昨天: -1,
    '本周': 'week',
  };
  if (raw in relative) {
    const offset = relative[raw];
    if (offset === 'week') return weekStartKey(now + 7 * DAY_MS);
    return dayKey(now + offset * DAY_MS);
  }
  const plus = /^([+-])(\d{1,4})\s*d(ay)?s?$/.exec(raw);
  if (plus) {
    const delta = Number(plus[2]) * (plus[1] === '-' ? -1 : 1);
    return dayKey(now + delta * DAY_MS);
  }
  // 容错：手机/表格里常见的 2026/10/15 与 2026.10.15
  const loose = raw.replace(/[/.]/g, '-');
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(loose);
  if (m) {
    const key = `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`;
    if (isDayKey(key)) return key;
    throw new WorkTodoError('bad-due', `日期不存在：${value}`);
  }
  throw new WorkTodoError('bad-due', `看不懂的日期 ${JSON.stringify(value)}，请用 YYYY-MM-DD、today、tomorrow 或 +3d`);
}

/* ------------------------------------------------------------------ *
 * 记录构造与修改
 * ------------------------------------------------------------------ */

/**
 * 生成记录 id。
 * 形如 wt-<base36 时间>-<4 位随机>：可读、可排序、无需依赖 crypto，同毫秒内也不易撞。
 * @param {number} now
 * @returns {string}
 */
/**
 * 截止时间（可选，只有配了截止日期才有意义）：接受 "14:30" / "9:05" / "1430" / "14"。
 * 空值（undefined/null/''/none）返回 null；写坏了抛错，别悄悄丢掉用户填的时间。
 * @param {unknown} value
 * @returns {string|null} HH:MM
 */
export function normalizeDueTime(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new WorkTodoError('bad-due-time', '截止时间必须是文本');
  const raw = value.trim().toLowerCase();
  if (!raw || raw === 'none' || raw === 'null' || raw === 'clear') return null;
  const m = /^(\d{1,2})(?::?(\d{2}))?$/.exec(raw);
  if (!m) throw new WorkTodoError('bad-due-time', '截止时间要写成 HH:MM（例如 14:30）');
  const hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  if (hour > 23 || minute > 59) throw new WorkTodoError('bad-due-time', '截止时间超出范围（00:00–23:59）');
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function newId(now = Date.now(), rand = Math.random) {
  const t = Math.floor(now).toString(36);
  const r = Math.floor(rand() * 36 ** 4).toString(36).padStart(4, '0');
  return `wt-${t}-${r}`;
}

/**
 * 造一条新记录。
 * @param {object} input 用户/模型输入
 * @param {object} [options]
 * @param {number} [options.now] 毫秒时间戳
 * @param {string} [options.source] human / agent / session
 * @param {string} [options.id] 指定 id（测试与提升用）
 * @returns {object} 纯 JSON 记录
 */
export function createRecord(input = {}, { now = Date.now(), source = 'human', id } = {}) {
  if (!SOURCES.includes(source)) throw new WorkTodoError('bad-source', `来源只能是 ${SOURCES.join(' / ')}`);
  const status = normalizeStatus(input.status) ?? 'pending';
  const due = normalizeDue(input.due, now);
  const record = {
    id: id ?? newId(now),
    title: normalizeTitle(input.title),
    notes: normalizeNotes(input.notes),
    status,
    priority: normalizePriority(input.priority) ?? 'none',
    due,
    // 没有截止日期就没有截止时间（避免出现「有时间没日期」的怪状态）
    dueTime: due ? normalizeDueTime(input.dueTime) : null,
    project: normalizeProject(input.project),
    order: null,
    source,
    createdAt: now,
    updatedAt: now,
    completedAt: status === 'completed' ? now : null,
  };
  return record;
}

/**
 * 打补丁：只覆盖显式给出的字段，其余原样保留。
 * 关键语义：状态在 pending/in_progress 与 completed 之间移动时，维护 completedAt。
 * @param {object} record 原记录
 * @param {object} patch 变更
 * @param {number} [now]
 * @returns {object} 新记录（不改原对象）
 */
export function patchRecord(record, patch = {}, now = Date.now()) {
  const next = { ...record };
  let touched = false;
  const take = (key) => Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined;

  if (take('title')) { next.title = normalizeTitle(patch.title); touched = true; }
  if (take('notes')) { next.notes = normalizeNotes(patch.notes); touched = true; }
  if (take('project')) { next.project = normalizeProject(patch.project); touched = true; }
  if (take('priority')) { next.priority = normalizePriority(patch.priority) ?? next.priority; touched = true; }
  if (take('due')) {
    next.due = normalizeDue(patch.due, now);
    if (!next.due) next.dueTime = null; // 清掉日期时时间一并清掉
    touched = true;
  }
  if (take('dueTime')) {
    // 只给时间不给日期是无效的：没有日期就存 null
    next.dueTime = next.due ? normalizeDueTime(patch.dueTime) : null;
    touched = true;
  }

  const status = normalizeStatus(patch.status);
  if (status && status !== next.status) {
    next.status = status;
    next.completedAt = status === 'completed' ? now : null;
    touched = true;
  } else if (status) {
    // 状态没变也要算「被指定过」，否则纯 status 的调用会被当成空 patch
    touched = true;
  }

  if (!touched) throw new WorkTodoError('empty-patch', '没有要修改的字段');
  next.updatedAt = now;
  return next;
}

/* ------------------------------------------------------------------ *
 * 引用解析：id、完整标题、唯一标题前缀都能定位一条
 * ------------------------------------------------------------------ */

/**
 * 按引用找记录。人类只会说「把写周报标完成」，agent 也常拿标题当句柄，
 * 所以 id 之外还要支持标题精确匹配与唯一前缀匹配。
 * @param {object[]} records
 * @param {string} ref id 或标题
 * @returns {object} 命中的记录
 * @throws {WorkTodoError} 找不到或多义时抛出，并说明候选
 */
export function resolveRef(records, ref) {
  const key = typeof ref === 'string' ? ref.trim() : '';
  if (!key) throw new WorkTodoError('missing-ref', '需要给出待办的 id 或标题');
  const byId = records.find((r) => r.id === key);
  if (byId) return byId;
  const lower = key.toLowerCase();
  const exact = records.filter((r) => r.title.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new WorkTodoError('ambiguous-ref', `有 ${exact.length} 条待办标题都叫「${key}」，请用 id 指定`);
  const prefixed = records.filter((r) => r.title.toLowerCase().startsWith(lower));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    const names = prefixed.slice(0, 5).map((r) => `「${r.title}」`).join('、');
    throw new WorkTodoError('ambiguous-ref', `「${key}」匹配到多条待办：${names}，请说得更具体或用 id`);
  }
  throw new WorkTodoError('not-found', `找不到待办「${key}」`);
}

/* ------------------------------------------------------------------ *
 * 视图：排序、分组、统计
 * ------------------------------------------------------------------ */

/** 优先级权重，用于排序（高的在前）。 */
// 「无」排在最后（未定优先级的不该挡在已定优先级的前面），但仍排在「已完成」之前
const PRIORITY_WEIGHT = { high: 0, normal: 1, low: 2, none: 3 };

/**
 * 视图排序：未完成在前；同组内 优先级 → 截止日期（无日期排最后）→ 创建时间。
 * @param {object[]} records
 * @returns {object[]} 新数组
 */
export const SORT_MODES = ['manual', 'priority', 'created'];

/**
 * 视图排序。三种模式共用同一套「已完成永远沉底」的规则：
 *   - `priority`（默认）：优先级 → 截止日期 → 创建时间（早的在前）
 *   - `created`：创建时间**倒序**（刚加的在前）
 *   - `manual`：拖过顺序的（`order` 是有限数）按 order 升序在前；没拖过的按 priority 规则排在后面
 * @param {object[]} records
 * @param {'manual'|'priority'|'created'} [mode]
 */
export function sortForView(records, mode = 'priority') {
  const rank = (r) => (r.status === 'completed' ? 1 : 0);
  const byFallback = (a, b) => {
    const pa = PRIORITY_WEIGHT[a.priority] ?? 1;
    const pb = PRIORITY_WEIGHT[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
    if (a.due === b.due) {
      const ta = a.dueTime ?? '99:99'; // 同一天：有时间的在前，没时间的垫后
      const tb = b.dueTime ?? '99:99';
      if (ta !== tb) return ta < tb ? -1 : 1;
    }
    if (a.due && !b.due) return -1;
    if (!a.due && b.due) return 1;
    return a.createdAt - b.createdAt;
  };
  const manualRank = (r) => (Number.isFinite(r.order) ? 0 : 1);
  return [...records].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.status === 'completed' && b.status === 'completed') {
      // 已完成按完成时间倒序：最近做完的先看到
      return (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt);
    }
    if (mode === 'created') return b.createdAt - a.createdAt;
    if (mode === 'manual') {
      if (manualRank(a) !== manualRank(b)) return manualRank(a) - manualRank(b);
      if (manualRank(a) === 0 && a.order !== b.order) return a.order - b.order;
      return byFallback(a, b);
    }
    return byFallback(a, b);
  });
}

/**
 * 把「新的完整顺序」落到记录上：ids[i] 的记录得到 order=i。
 * 不在 ids 里的记录保持原样（order 为 null 的继续按自动规则排）。
 * 纯函数：返回新数组，不改入参。
 * @param {object[]} records
 * @param {string[]} ids
 */
export function applyManualOrder(records, ids) {
  const position = new Map(ids.map((id, index) => [id, index]));
  return records.map((record) => (position.has(record.id) ? { ...record, order: position.get(record.id) } : record));
}

/**
 * 分组成面板的六个区。
 * 「明天」= 今天 + 1 天（本地时区，与 dayKey 同语义）；
 * 「本周」= 明天之后到本周日（**不含**明天，今天与明天都已单独立栏）；
 * 无截止日期的进「以后」。
 * @param {object[]} records
 * @param {number} [now]
 * @returns {{overdue: object[], today: object[], tomorrow: object[], week: object[], later: object[], completed: object[]}}
 */
export function groupRecords(records, now = Date.now(), mode = 'priority') {
  const today = dayKey(now);
  const tomorrow = addDaysKey(today, 1);
  const weekEnd = dayKey(dayStart(weekStartKey(now)) + 6 * DAY_MS);
  const groups = { overdue: [], today: [], tomorrow: [], week: [], later: [], completed: [] };
  for (const record of records) {
    if (record.status === 'completed') { groups.completed.push(record); continue; }
    const due = record.due;
    if (!due) { groups.later.push(record); continue; }
    if (due < today) { groups.overdue.push(record); continue; }
    if (due === today) { groups.today.push(record); continue; }
    if (due === tomorrow) { groups.tomorrow.push(record); continue; }
    // 走到这里 due > tomorrow，因此本周天然排除了今天与明天；
    // 边界仍沿用原来的「到本周日为止」。
    if (due <= weekEnd) { groups.week.push(record); continue; }
    groups.later.push(record);
  }
  for (const key of Object.keys(groups)) groups[key] = sortForView(groups[key], mode);
  return groups;
}

/**
 * 面板顶部的统计。
 * `tomorrow` 与分组同口径（本地时区今天 + 1 天）；面板 chip 暂不展示，留给调用方按需使用。
 * @param {object[]} records
 * @param {number} [now]
 * @returns {{total: number, open: number, overdue: number, today: number, tomorrow: number, doing: number, completed: number, completedToday: number}}
 */
/**
 * 按项目分组：面板的「按项目」视图。
 *
 * 规则：
 *   - 没写 project 的记录归入「未归类」桶（project 为 null，永远排在最后）；
 *   - 桶的排序：未完成条数多的在前 → 未完成里最早的截止日期更早的在前 → 名字字典序；
 *   - 桶内沿用 sortForView（未完成在前、高优先级在前、临近截止在前）；
 *   - 每个桶附 total / open / overdue，面板可直接显示「项目名 · 未完成/总数」。
 *
 * @param {object[]} records
 * @param {number} [now]
 * @returns {{project: string|null, key: string, todos: object[], total: number, open: number, overdue: number}[]}
 */
export function groupByProject(records, now = Date.now(), mode = 'priority') {
  const today = dayKey(now);
  const buckets = new Map();
  for (const record of records) {
    const project = record.project ?? null;
    const key = project ?? '';
    if (!buckets.has(key)) buckets.set(key, { project, key, todos: [], total: 0, open: 0, overdue: 0 });
    const bucket = buckets.get(key);
    bucket.todos.push(record);
    bucket.total += 1;
    if (record.status !== 'completed') {
      bucket.open += 1;
      if (record.due && record.due < today) bucket.overdue += 1;
    }
  }
  const list = [...buckets.values()];
  for (const bucket of list) bucket.todos = sortForView(bucket.todos, mode);
  const earliestOpenDue = (bucket) =>
    bucket.todos.filter((t) => t.status !== 'completed' && t.due).map((t) => t.due).sort()[0] ?? '9999-99-99';
  return list.sort((a, b) => {
    // 未归类永远最后：它不是一个真正的项目
    if ((a.project === null) !== (b.project === null)) return a.project === null ? 1 : -1;
    if (a.open !== b.open) return b.open - a.open;
    const da = earliestOpenDue(a);
    const db = earliestOpenDue(b);
    if (da !== db) return da < db ? -1 : 1;
    return (a.project ?? '').localeCompare(b.project ?? '');
  });
}

/**
 * 面板「项目」选择器要显示的**已知项目清单**上限。
 *
 * 为什么要有上限：项目是自由文本，理论上可以无限多；下拉里放几百个既点不动，
 * 每次轮询也要白带一份长数组。取前 50 个最常用的（面板另用 `projectsTruncated`
 * 告诉用户「只展示了常用的这些」）。
 */
export const PROJECT_LIST_LIMIT = 50;

/**
 * 从**全部记录**里汇总项目清单（面板第二行的「项目」选择器用）。
 *
 * 规则：
 *   - 去重、忽略空值/空白/非文本（未归类不是项目）；
 *   - **项目名原样返回，不做 trim**（B3 口径一致）：清单里给出的值必须能原样拿去
 *     `/list?project=<值>` 命中 —— 过滤侧是「trim 后忽略大小写比较」，`groupByProject`
 *     的桶名也是原样字符串。这里若输出 trim 过的名字，存储里手改出来的 `' beta '`
 *     会显示成 `beta`、点选却 0 条命中（选择器给什么值，过滤就用什么值）；
 *   - 排序：**出现次数降序**（常用的靠前）→ 次数相同按名称升序；
 *   - 超过 `limit` 时只回前 `limit` 个，并把 `truncated` 置 true。
 *
 * 抽成纯函数：它同时被 `/list` 载荷与单测使用，不是「测试里再抄一遍排序」。
 * @param {object[]} records 全量记录
 * @param {number|string} [limit] 上限（默认 PROJECT_LIST_LIMIT）；数字字符串可用，非法/负值回落默认
 * @returns {{projects: string[], truncated: boolean}}
 */
export function listProjects(records, limit = PROJECT_LIST_LIMIT) {
  const counts = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    // 原样保留，只用 trim 判断「是不是空」：与 groupByProject / ?project= 过滤同一口径
    const name = typeof record?.project === 'string' ? record.project : '';
    if (!name.trim()) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const all = [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([name]) => name);
  // B6：`-1` / `NaN` / 乱码回落默认 50；数字字符串（"2"）当数字用；`Infinity` 也回落默认
  // （否则它绕过截断，属防御性缺口）
  const wanted = Number(limit);
  const cap = Number.isFinite(wanted) && wanted >= 0 ? Math.floor(wanted) : PROJECT_LIST_LIMIT;
  const projects = all.slice(0, cap);
  return { projects, truncated: projects.length < all.length };
}

export function statsOf(records, now = Date.now()) {
  const today = dayKey(now);
  const tomorrow = addDaysKey(today, 1);
  const stats = { total: records.length, open: 0, overdue: 0, today: 0, tomorrow: 0, doing: 0, completed: 0, completedToday: 0 };
  for (const record of records) {
    if (record.status === 'completed') {
      stats.completed += 1;
      if (record.completedAt && dayKey(record.completedAt) === today) stats.completedToday += 1;
      continue;
    }
    stats.open += 1;
    if (record.status === 'in_progress') stats.doing += 1;
    if (record.due) {
      if (record.due < today) stats.overdue += 1;
      else if (record.due === today) stats.today += 1;
      else if (record.due === tomorrow) stats.tomorrow += 1;
    }
  }
  return stats;
}

/**
 * 按过滤器取子集，供 worktodo_list 工具与面板筛选使用。
 *
 * 注意 week 与 groupRecords 的 `week` 桶**语义不同**，这是有意的：
 *   - 这里（查询）是「今天起、到本周日为止」的**累计**视图——用户问「本周有什么事」时
 *     当然要看到今天的事，否则还得再查一次 today；
 *   - groupRecords 的桶是给面板**分栏**用的，今天与明天已经各立一栏，再放进本周栏就是重复。
 * @param {object[]} records
 * @param {string} [filter] open / today / overdue / week / doing / completed / all
 * @param {number} [now]
 * @returns {object[]}
 */
export function filterRecords(records, filter = 'open', now = Date.now()) {
  const key = String(filter ?? 'open').trim().toLowerCase() || 'open';
  const today = dayKey(now);
  const weekEnd = dayKey(dayStart(weekStartKey(now)) + 6 * DAY_MS);
  switch (key) {
    case 'all': return sortForView(records);
    case 'open': case 'todo': return sortForView(records.filter((r) => r.status !== 'completed'));
    case 'doing': case 'in_progress': return sortForView(records.filter((r) => r.status === 'in_progress'));
    case 'completed': case 'done': return sortForView(records.filter((r) => r.status === 'completed'));
    case 'overdue': return sortForView(records.filter((r) => r.status !== 'completed' && r.due && r.due < today));
    case 'today': return sortForView(records.filter((r) => r.status !== 'completed' && r.due === today));
    case 'week': return sortForView(records.filter((r) => r.status !== 'completed' && r.due && r.due >= today && r.due <= weekEnd));
    default:
      throw new WorkTodoError('bad-filter', `不支持的筛选 ${JSON.stringify(filter)}，可用：all / open / today / overdue / week / doing / completed`);
  }
}

/* ------------------------------------------------------------------ *
 * 给模型看的行文本
 * ------------------------------------------------------------------ */

/** 优先级在文本里的记号：让模型一眼看出轻重，且不占多少 token。 */
const PRIORITY_MARK = { high: '!', normal: '', low: '·', none: '' };

/**
 * 把一条记录渲染成单行文本，例如：
 *   [ ] wt-abc-1234 写周报  (高, 截止 2026-10-13, 项目 dsh-worktodo)
 * @param {object} record
 * @param {number} [now]
 * @returns {string}
 */
export function formatLine(record, now = Date.now()) {
  const today = dayKey(now);
  const box = record.status === 'completed' ? '[x]' : record.status === 'in_progress' ? '[~]' : '[ ]';
  const bits = [];
  if (record.priority === 'high') bits.push('高');
  else if (record.priority === 'normal') bits.push('中');
  else if (record.priority === 'low') bits.push('低');
  if (record.due) {
    const overdue = record.status !== 'completed' && record.due < today;
    bits.push(`${overdue ? '已已过期 ' : '截止 '}${record.due}${record.dueTime ? ` ${record.dueTime}` : ''}`);
  }
  if (record.project) bits.push(`#${record.project}`);
  const suffix = bits.length ? `  (${bits.join(', ')})` : '';
  const mark = PRIORITY_MARK[record.priority] ?? '';
  return `${box} ${mark}${record.id}  ${record.title}${suffix}`;
}

/**
 * 把一组记录渲染成多行文本；空集时给一句明确的空状态。
 * @param {object[]} records
 * @param {number} [now]
 * @param {string} [emptyText]
 * @returns {string}
 */
export function formatLines(records, now = Date.now(), emptyText = '（没有符合条件的待办）') {
  if (!records.length) return emptyText;
  return records.map((r) => formatLine(r, now)).join('\n');
}

/**
 * 把官方会话 todos（{content,status}）转成本插件的记录输入。
 * 这是差异化功能「把 agent 的计划提升为我的工作待办」的唯一映射点：
 * 官方只有 content/status，提升时按标题去重，避免同一件事在列表里堆两遍。
 * @param {{content: string, status: string}[]} sessionTodos
 * @param {object[]} existing 现有记录，用于按标题去重
 * @param {number} [now]
 * @returns {{title: string, status: string, notes: string, source: string}[]} 待创建的输入
 */
export function adoptSessionTodos(sessionTodos, existing = [], now = Date.now()) {
  const seen = new Set(existing.map((r) => r.title.trim().toLowerCase()));
  const out = [];
  for (const item of Array.isArray(sessionTodos) ? sessionTodos : []) {
    const title = typeof item?.content === 'string' ? item.content.trim() : '';
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      status: normalizeStatus(item?.status) ?? 'pending',
      notes: '',
      source: 'session',
    });
  }
  void now;
  return out;
}
