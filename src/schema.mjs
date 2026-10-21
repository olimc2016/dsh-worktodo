/**
 * 持久化记录的校验与修复，以及给 storage-domain 用的「zod 兼容」schema 适配层。
 *
 * 为什么不直接依赖 zod：
 *   1. storage-domain 的 domainTable 只要求一个带 `parse(raw)`（读取时校验已存记录）
 *      与 `safeParse(raw).success`（校验 global 是否为 null）的对象，接口面极小。
 *   2. 本插件的头号卖点是「装得上、无外部依赖」——少一个依赖就少一类安装失败。
 *      官方 @deepseek-ai/dsh-tool-todo 用 zod，但那是官方包的取舍；我们这里用不到
 *      zod 的类型推导（纯 JS），只需校验语义。
 *   schema.js 的 parse 同时被 JSON 文件回退存储复用，两条存储路径共用同一套校验，
 *   不会出现「domain 里能存、文件里读不出」这种分裂。
 */

import {
  PRIORITIES,
  SOURCES,
  STATUSES,
  SUBTASK_MAX,
  SUBTASK_TITLE_MAX,
  WorkTodoError,
  dayKey,
  newId,
  normalizeDue,
  normalizeDueTime,
  normalizePriority,
  normalizeStatus,
} from './records.mjs';

/**
 * 把「可能是人手工写的」值归一化，失败就用兜底值。
 * 文件后端的存储是给人看、给人改的，所以这里接受同义词（done/高/tomorrow 之类），
 * 而不是像官方 zod 那样一有意外就整条记录报废。
 * @template T
 * @param {() => T} job
 * @param {T} fallback
 * @returns {T}
 */
function coerce(job, fallback) {
  try {
    const value = job();
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/**
 * 读盘时的子待办修复：**宽容但不整条丢**。
 *
 * 磁盘上的数据可能来自手改、旧版本或坏写入，所以这里不像写入路径那样整批拒绝：
 *   - 非数组 / null → []；
 *   - 数组里非对象、标题为空 → 丢弃该项（其余保留）；
 *   - 标题超长 → 截到上限（读盘宽容；写入仍明确报错）；
 *   - done 只有严格 true 才算完成；order 非法用数组下标；
 *   - id 缺失/重复 → 用「文件内位置」派生稳定 id；
 *   - 超过 50 条 → 按 order/数组顺序保留前 50 条。
 * @param {unknown} raw
 * @returns {{id: string, title: string, done: boolean, order: number}[]}
 */
export function repairSubtasks(raw) {
  if (!Array.isArray(raw)) return [];
  const used = new Set();
  const items = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    let title = typeof item.title === 'string' ? item.title.trim() : '';
    if (!title) return;
    if (title.length > SUBTASK_TITLE_MAX) title = title.slice(0, SUBTASK_TITLE_MAX);
    let id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id || used.has(id)) {
      let base = `st-recovered-${index + 1}`;
      let n = 1;
      id = base;
      while (used.has(id)) id = `${base}-${n++}`;
    }
    used.add(id);
    items.push({
      id,
      title,
      done: item.done === true,
      order: Number.isFinite(item.order) ? Number(item.order) : index,
    });
  });
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.order - b.item.order) || (a.index - b.index))
    .slice(0, SUBTASK_MAX)
    .map(({ item }, order) => ({ ...item, order }));
}

/**
 * 把一条「可能来自磁盘/可能来自旧版本/可能是手改坏的」记录修复成合法记录。
 *
 * 修复策略：
 *   - 结构性字段（id、title）缺失或非法 → 抛错（由上层决定跳过或上抛）；
 *   - 可补的字段（status/priority/notes/subtasks/project/source/时间戳）→ 用默认值补齐，
 *     这样旧版本写入或手改漏字段的记录不会让整个领域打不开。
 *
 * @param {unknown} raw 待校验的值
 * @returns {object} 规范化后的纯 JSON 记录
 * @throws {WorkTodoError} 记录无法修复时
 */
export function repairRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WorkTodoError('invalid-record', '记录不是对象');
  }
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) throw new WorkTodoError('invalid-record', '记录缺少标题');

  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : newId();
  // 状态/优先级/日期都过一遍同义词归一：手改成 done / 高 / 2026/10/20 也要能懂
  const status = STATUSES.includes(raw.status) ? raw.status : coerce(() => normalizeStatus(raw.status), 'pending');
  const priority = PRIORITIES.includes(raw.priority) ? raw.priority : coerce(() => normalizePriority(raw.priority), 'none');
  const source = SOURCES.includes(raw.source) ? raw.source : 'human';
  const createdAt = Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now();
  const updatedAt = Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : createdAt;
  // 手动排序位置：只有拖过的记录才有；null 表示「按优先级/截止/创建时间自动排」
  const order = Number.isFinite(raw.order) ? Number(raw.order) : null;
  const completedAt = status === 'completed'
    ? (Number.isFinite(raw.completedAt) ? Number(raw.completedAt) : updatedAt)
    : null;
  // 备注：旧记录没有该字段 / 空字符串 / 非字符串 → null；超长**不截断**（不静默丢用户文字）
  const notes = typeof raw.notes === 'string' && raw.notes.trim() ? raw.notes : null;

  return {
    id,
    title,
    notes,
    subtasks: repairSubtasks(raw.subtasks),
    status,
    priority,
    // 相对日期（today/+3d）按「读到的这一刻」折算：手改文件的人想的当然是今天
    due: typeof raw.due === 'string' ? coerce(() => normalizeDue(raw.due, Date.now()), null) : null,
    // 时间只在有日期时保留（同 createRecord/patchRecord 的约定）
    dueTime: typeof raw.dueTime === 'string' && typeof raw.due === 'string'
      ? coerce(() => normalizeDueTime(raw.dueTime), null)
      : null,
    project: typeof raw.project === 'string' && raw.project.trim() ? raw.project.trim() : null,
    order,
    source,
    createdAt,
    updatedAt,
    completedAt,
  };
}

/**
 * 给 storage-domain `domainTable()` 用的 schema：接口与 zod 一致（parse / safeParse），
 * 但语义是本插件自己的修复策略。
 */
export const todoRecordSchema = {
  /**
   * 校验并返回规范化记录；失败抛错（domain 打开或写入时由 facility 转成 DomainError）。
   * @param {unknown} raw
   * @returns {object}
   */
  parse(raw) {
    return repairRecord(raw);
  },
  /**
   * 与 zod 同形的安全解析。
   * @param {unknown} raw
   * @returns {{success: true, data: object}|{success: false, error: Error}}
   */
  safeParse(raw) {
    try {
      return { success: true, data: repairRecord(raw) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  },
};

/**
 * 缺标题的记录用的占位标题。
 *
 * 为什么不直接丢弃：文件后端是「给人看、给人改」的形态，写路径又是读-改-写，
 * 被跳过的记录会在下一次任何写入时从磁盘上**永久消失**（用户不会收到任何提示）。
 * 宁可让用户看到一条「(无标题记录)」并自己补上，也不能静默删掉他手写的内容。
 */
export const MISSING_TITLE_PLACEHOLDER = '(无标题记录)';

/**
 * 修复一份存盘文档（JSON 回退存储的整个领域文件）。
 *
 * 与 `repairRecord` 的差别：这里**不丢弃可修复的记录**——
 *   - 缺 title → 用 `MISSING_TITLE_PLACEHOLDER` 占位并保留 id/其它字段；
 *   - 缺 id → 用「文件内位置」派生稳定 id（不是每次读都换一个随机 id），
 *     否则这些记录每次读都是新身份，写回磁盘还会不断累积重复条目；
 *   - 完全不是对象的垃圾条目才记入 `dropped`，由调用方在写入前另存备份。
 * @param {unknown} raw
 * @returns {{version: number, updatedAt: number, todos: object[], dropped: {index: number, reason: string, raw: unknown}[]}}
 */
export function repairStoreDocument(raw) {
  const doc = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const list = Array.isArray(doc.todos) ? doc.todos : [];
  const todos = [];
  const dropped = [];
  const usedIds = new Set();
  // 先把文件里本来就有的 id 全部登记，避免派生 id 撞上后面的记录
  for (const item of list) {
    if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.id === 'string' && item.id.trim()) {
      usedIds.add(item.id.trim());
    }
  }
  list.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      dropped.push({ index, reason: '记录不是对象', raw: item });
      return;
    }
    try {
      let candidate = item;
      if (!(typeof item.id === 'string' && item.id.trim())) {
        let id = `wt-recovered-${index + 1}`;
        let n = 1;
        while (usedIds.has(id)) id = `wt-recovered-${index + 1}-${n++}`;
        candidate = { ...candidate, id };
      }
      if (!(typeof item.title === 'string' && item.title.trim())) {
        candidate = { ...candidate, title: MISSING_TITLE_PLACEHOLDER };
      }
      const repaired = repairRecord(candidate);
      usedIds.add(repaired.id);
      todos.push(repaired);
    } catch (error) {
      dropped.push({ index, reason: String(error?.message ?? error), raw: item });
    }
  });
  return {
    version: 1,
    updatedAt: Number.isFinite(doc.updatedAt) ? Number(doc.updatedAt) : Date.now(),
    todos,
    dropped,
  };
}

/** 供日志/自检显示的时间戳格式（本地时间，秒级）。 */
export function stamp(now = Date.now()) {
  return `${dayKey(now)} ${new Date(now).toTimeString().slice(0, 8)}`;
}
