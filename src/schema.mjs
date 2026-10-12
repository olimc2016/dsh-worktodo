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
  WorkTodoError,
  dayKey,
  newId,
  normalizeDue,
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
 * 把一条「可能来自磁盘/可能来自旧版本/可能是手改坏的」记录修复成合法记录。
 *
 * 修复策略：
 *   - 结构性字段（id、title）缺失或非法 → 抛错（由上层决定跳过或上抛）；
 *   - 可补的字段（status/priority/notes/project/source/时间戳）→ 用默认值补齐，
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
  const priority = PRIORITIES.includes(raw.priority) ? raw.priority : coerce(() => normalizePriority(raw.priority), 'normal');
  const source = SOURCES.includes(raw.source) ? raw.source : 'human';
  const createdAt = Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now();
  const updatedAt = Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : createdAt;
  // 手动排序位置：只有拖过的记录才有；null 表示「按优先级/截止/创建时间自动排」
  const order = Number.isFinite(raw.order) ? Number(raw.order) : null;
  const completedAt = status === 'completed'
    ? (Number.isFinite(raw.completedAt) ? Number(raw.completedAt) : updatedAt)
    : null;

  return {
    id,
    title,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    status,
    priority,
    // 相对日期（today/+3d）按「读到的这一刻」折算：手改文件的人想的当然是今天
    due: typeof raw.due === 'string' ? coerce(() => normalizeDue(raw.due, Date.now()), null) : null,
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

/** 整个领域文件（JSON 回退存储用）的形状校验。 */
/**
 * @param {unknown} raw
 * @returns {{version: number, updatedAt: number, todos: object[]}}
 */
export function repairStoreDocument(raw) {
  const doc = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const list = Array.isArray(doc.todos) ? doc.todos : [];
  const todos = [];
  for (const item of list) {
    try {
      todos.push(repairRecord(item));
    } catch {
      // 单条坏记录不能拖垮整个列表：跳过它，其余照常读出
    }
  }
  return {
    version: 1,
    updatedAt: Number.isFinite(doc.updatedAt) ? Number(doc.updatedAt) : Date.now(),
    todos,
  };
}

/** 供日志/自检显示的时间戳格式（本地时间，秒级）。 */
export function stamp(now = Date.now()) {
  return `${dayKey(now)} ${new Date(now).toTimeString().slice(0, 8)}`;
}
