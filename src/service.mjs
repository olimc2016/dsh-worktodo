/**
 * 待办服务：**一份逻辑，两个调用方**。
 *
 * 官方《user-actions》的要求是「实现一次作为宿主服务方法，UI 动作与 agent 工具都调它，
 * 不要各写一套」——面板的按钮和 worktodo_* 工具在这里汇合，
 * 所以「面板点完成」和「agent 调工具完成」在数据上的行为逐字一致（含失败原因）。
 *
 * 约定：所有公开方法都不抛异常，而是返回显式状态：
 *   成功 { ok: true, ... }
 *   失败 { ok: false, reason: '<稳定原因码>', message: '<给人看的话>' }
 * 这样路由层与工具层都不需要 try/catch 复制品，失败原因也能原样透给用户/模型。
 */

import {
  WorkTodoError,
  adoptSessionTodos,
  createRecord,
  dayKey,
  filterRecords,
  groupByProject,
  groupRecords,
  patchRecord,
  resolveRef,
  sortForView,
  statsOf,
} from './records.mjs';

/**
 * 把可能抛 WorkTodoError 的同步动作包成显式状态。
 * @param {() => any} job
 * @returns {{ok: true, value: any}|{ok: false, reason: string, message: string}}
 */
function attempt(job) {
  try {
    return { ok: true, value: job() };
  } catch (error) {
    if (error instanceof WorkTodoError) return { ok: false, reason: error.reason, message: error.message };
    return { ok: false, reason: 'internal', message: String(error?.message ?? error) };
  }
}

/**
 * 建服务。
 * @param {object} options
 * @param {object} options.store openWorkTodoStore 返回的存储句柄
 * @param {() => number} [options.clock] 可注入时钟（测试用）
 * @param {object} [options.logger]
 * @returns {object} 服务句柄
 */
export function createWorkTodoService({ store, clock = () => Date.now(), logger }) {
  /** 变更监听者（宿主用它做日志/未来的推送）。 */
  const listeners = new Set();
  const emit = (change) => {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch (error) {
        logger?.warn?.(`待办变更监听失败：${error?.message ?? error}`);
      }
    }
  };

  /** 读全量（每次读都从存储取，保证手改文件后能立刻看到）。 */
  async function all() {
    const records = await store.load();
    return records.map((r) => ({ ...r }));
  }

  /**
   * 列表 + 分组 + 统计：面板首屏与 worktodo_list 工具共用。
   *
   * 口径要分清（这里踩过一次坑）：
   *   - `todos` 与 `groups` 都基于**筛选后**的子集；
   *   - `stats` 基于**全量**记录——面板顶部的「逾期 3 条」不该因为切到「已完成」标签就变 0。
   * 因此想要完整五个分组的面板请求 `filter: 'all'`，而不是 `open`
   * （否则 `groups.completed` 恒为空，「已完成」那一栏永远出不来）。
   * @param {object} [options]
   * @param {string} [options.filter] all / open / today / overdue / week / doing / completed
   * @param {string} [options.project] 只看某个项目
   * @param {string} [options.query] 标题/备注里的关键词
   * @returns {Promise<object>} 显式状态
   */
  async function list({ filter = 'open', project, query } = {}) {
    const now = clock();
    let records;
    try {
      records = await all();
    } catch (error) {
      return { ok: false, reason: 'store-unreadable', message: `读取待办失败：${error?.message ?? error}` };
    }
    const picked = attempt(() => {
      let subset = records;
      if (project) {
        const wanted = String(project).trim().toLowerCase();
        subset = subset.filter((r) => (r.project ?? '').toLowerCase() === wanted);
      }
      if (query) {
        const needle = String(query).trim().toLowerCase();
        subset = subset.filter((r) => r.title.toLowerCase().includes(needle) || (r.notes ?? '').toLowerCase().includes(needle));
      }
      return filterRecords(subset, filter, now);
    });
    if (!picked.ok) return picked;

    // 项目视图用的分组：**不套 project 收窄**，否则面板上只剩当前项目、没法切到别处
    const forProjects = attempt(() => {
      let subset = records;
      if (query) {
        const needle = String(query).trim().toLowerCase();
        subset = subset.filter((r) => r.title.toLowerCase().includes(needle) || (r.notes ?? '').toLowerCase().includes(needle));
      }
      return filterRecords(subset, filter, now);
    });
    if (!forProjects.ok) return forProjects;

    return {
      ok: true,
      todos: picked.value,
      groups: groupRecords(picked.value, now),
      // 「按项目」视图：每个项目一个桶，附 total/open/overdue
      projectGroups: groupByProject(forProjects.value, now),
      // 统计基于**全部**记录，而不是当前筛选结果：面板顶部的「逾期 3 条」不该因为
      // 用户切到「已完成」标签就变成 0
      stats: statsOf(records, now),
      today: dayKey(now),
      store: { kind: store.kind, location: store.location },
      projects: [...new Set(records.map((r) => r.project).filter(Boolean))].sort(),
    };
  }

  /**
   * 新增一条。
   * @param {object} input { title, notes?, priority?, due?, project?, status? }
   * @param {object} [options]
   * @param {string} [options.source] human / agent / session
   * @returns {Promise<object>}
   */
  async function create(input, { source = 'human' } = {}) {
    const now = clock();
    const built = attempt(() => createRecord(input ?? {}, { now, source }));
    if (!built.ok) return built;
    try {
      await store.put(built.value);
    } catch (error) {
      return { ok: false, reason: 'store-write-failed', message: `保存待办失败：${error?.message ?? error}` };
    }
    emit({ operation: 'create', todo: built.value });
    return { ok: true, todo: built.value };
  }

  /**
   * 改一条：按引用定位，只覆盖显式给出的字段。
   * @param {string} ref id 或标题
   * @param {object} patch
   * @returns {Promise<object>}
   */
  async function update(ref, patch) {
    const now = clock();
    let target;
    try {
      target = resolveRef(await all(), ref);
    } catch (error) {
      if (error instanceof WorkTodoError) return { ok: false, reason: error.reason, message: error.message };
      return { ok: false, reason: 'store-unreadable', message: `读取待办失败：${error?.message ?? error}` };
    }
    const next = attempt(() => patchRecord(target, patch ?? {}, now));
    if (!next.ok) return next;
    try {
      await store.put(next.value);
    } catch (error) {
      return { ok: false, reason: 'store-write-failed', message: `保存待办失败：${error?.message ?? error}` };
    }
    emit({ operation: 'update', todo: next.value });
    return { ok: true, todo: next.value };
  }

  /**
   * 设置状态（面板勾选框与 worktodo_done 都走这里）。
   * @param {string} ref
   * @param {string} status pending / in_progress / completed
   * @returns {Promise<object>}
   */
  function setStatus(ref, status) {
    return update(ref, { status });
  }

  /**
   * 勾选/取消勾选：已完成 → 回到 pending，否则 → 完成。
   * @param {string} ref
   * @returns {Promise<object>}
   */
  async function toggle(ref) {
    let target;
    try {
      target = resolveRef(await all(), ref);
    } catch (error) {
      if (error instanceof WorkTodoError) return { ok: false, reason: error.reason, message: error.message };
      return { ok: false, reason: 'store-unreadable', message: `读取待办失败：${error?.message ?? error}` };
    }
    return setStatus(ref, target.status === 'completed' ? 'pending' : 'completed');
  }

  /**
   * 删除一条。
   * @param {string} ref
   * @returns {Promise<object>}
   */
  async function remove(ref) {
    let target;
    try {
      target = resolveRef(await all(), ref);
    } catch (error) {
      if (error instanceof WorkTodoError) return { ok: false, reason: error.reason, message: error.message };
      return { ok: false, reason: 'store-unreadable', message: `读取待办失败：${error?.message ?? error}` };
    }
    try {
      await store.remove(target.id);
    } catch (error) {
      return { ok: false, reason: 'store-write-failed', message: `删除待办失败：${error?.message ?? error}` };
    }
    emit({ operation: 'remove', todo: target });
    return { ok: true, removed: { id: target.id, title: target.title } };
  }

  /**
   * 把官方会话 todos 提升为工作待办（差异化功能）。
   * 官方列表是整表替换、只归一个 agent 会话所有；提升之后这件事就进了**人**的列表，
   * 跨会话还在，可以加优先级和截止日期。按标题去重，已存在的不重复导入。
   * @param {{content: string, status: string}[]} sessionTodos
   * @returns {Promise<object>}
   */
  async function adopt(sessionTodos) {
    const now = clock();
    let existing;
    try {
      existing = await all();
    } catch (error) {
      return { ok: false, reason: 'store-unreadable', message: `读取待办失败：${error?.message ?? error}` };
    }
    const wanted = adoptSessionTodos(sessionTodos, existing, now);
    if (!wanted.length) return { ok: true, created: [], skipped: Array.isArray(sessionTodos) ? sessionTodos.length : 0 };

    const created = [];
    for (const input of wanted) {
      const built = attempt(() => createRecord(input, { now, source: 'session' }));
      if (!built.ok) continue;
      try {
        await store.put(built.value);
        created.push(built.value);
      } catch (error) {
        logger?.warn?.(`提升待办失败「${input.title}」：${error?.message ?? error}`);
      }
    }
    if (created.length) emit({ operation: 'adopt', todos: created });
    return { ok: true, created, skipped: (Array.isArray(sessionTodos) ? sessionTodos.length : 0) - created.length };
  }

  return {
    list,
    create,
    update,
    setStatus,
    toggle,
    remove,
    adopt,
    all,
    sortForView,
    /** 订阅变更，返回注销函数。 */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 存储自检信息，health 路由与 README 排查都用它。 */
    describe() {
      return { kind: store.kind, location: store.location };
    },
  };
}
