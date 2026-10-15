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
  SORT_MODES,
  applyManualOrder,
  filterRecords,
  groupByProject,
  groupRecords,
  listProjects,
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
 * `/list` 允许选择只回哪几份形状（S3-3，第四轮审计）。
 *
 * 为什么需要：`/list` 原来一次把 `todos` + `groups` + `projectGroups` 三份同样大小的数据
 * 塞进同一个响应（5000 条 = 4.28 MiB/次，三份各 1249 KiB）。面板只需要其中一部分时，
 * 让调用方用 `shapes=todos`（或 `groups` / `projectGroups` / 逗号组合 / `both`）明确说，
 * 就能把载荷降到约 1/3。默认 `both` 保持旧面板（它读 groups/projectGroups）不变。
 */
const LIST_SHAPES = ['todos', 'groups', 'projectGroups'];

/** 没显式指定 shapes 且记录数超过这个量时，在载荷里给一句「可以只取一种形状」的提示。 */
const LIST_PAYLOAD_WARN_ROWS = 2000;

/**
 * 解析 `shapes`：`todos|groups|projectGroups` 的逗号组合，`both`/`all`/缺省 = 三份都回。
 * 非法值一律回落到「三份都回」——宁可多给，不可少给（少给会让面板出现空白区）。
 * @param {string|string[]} [value]
 * @returns {Set<string>}
 */
function parseShapes(value) {
  const text = (Array.isArray(value) ? value.join(',') : String(value ?? '')).trim();
  if (!text || text === 'both' || text === 'all') return new Set(LIST_SHAPES);
  const picked = new Set();
  for (const part of text.split(',').map((piece) => piece.trim()).filter(Boolean)) {
    if (part === 'both' || part === 'all') return new Set(LIST_SHAPES);
    if (LIST_SHAPES.includes(part)) picked.add(part);
  }
  return picked.size ? picked : new Set(LIST_SHAPES);
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

  /**
   * 把刚落库的项目名对齐到**已有项目名**（B2：宿主侧便宜的查重一半）。
   *
   * 为什么：项目名是自由文本，面板侧早就用「忽略大小写 + 去首尾空白」查重
   * （`src/client/index.js` 的 `matchExistingProject`），但 agent 工具与行内编辑
   * 仍能直接写入 `Beta` / `beta` / `  BEta  ` → `/list.projects` 与「按项目」视图
   * 立刻裂成多个只差大小写的桶。这里用**完全相同**的规则对齐到已有原名：
   *   归一化键 = `normalizeProject` 的 trim + `toLowerCase()`；
   *   命中已有项目时**存已有原名**（与客户端把原名回显给用户一致），否则原样保留
   *   —— 所以「没有近似重名时的大小写」永远不会被改写。
   *
   * 代价（已知取舍）：若用户**特意**要把某条改成只差大小写的另一个名字（`Beta` → `beta`），
   * 这次会留在已有名上；面板本来也只会给出已有名，属可接受的收敛。
   *
   * @param {object[]|null} records 当前全量记录（读失败时传 null，此时不改写）
   * @param {string|null} normalized `normalizeProject` 的结果
   * @returns {string|null} 对齐后的项目名
   */
  const alignProject = (records, normalized) => {
    if (!normalized || !Array.isArray(records)) return normalized ?? null;
    const key = normalized.toLowerCase();
    for (const record of records) {
      if (typeof record?.project !== 'string') continue;
      if (record.project.toLowerCase() === key) return record.project; // 存已有原名
    }
    return normalized;
  };

  /** 读当前全量记录，只用于落库前的项目名对齐；读失败返回 null（不改写，宁可忠实落库）。 */
  const snapshotForAlign = async () => {
    try {
      const records = await store.load();
      return Array.isArray(records) ? records : [];
    } catch {
      return null;
    }
  };

  /**
   * 存储自检信息：health 路由、`/list` 载荷（面板页脚要渲染这些告警）与 README 排查都用它。
   * 可纠正的存储句柄会额外报出首选后端、不一致/分裂警告、最近一次合并报告与回退文件退役状态。
   */
  const describe = () => {
    const base = { kind: store.kind, location: store.location };
    return typeof store.describe === 'function' ? { ...base, ...store.describe() } : base;
  };

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
   * @param {string} [options.shapes] 只回所需形状（S3-3）：todos / groups / projectGroups 的任意组合，
   *   `both`（默认）= 三份都回（保持旧面板兼容）。只要 `shapes=todos` 时响应里不再出现
   *   groups/projectGroups —— 5000 条时这一项就把 4.28 MiB/次的轮询载荷降到约 1/3。
   * @returns {Promise<object>} 显式状态
   */
  async function list({ filter = 'open', project, query, sort, shapes } = {}) {
    // 默认 both：老面板（另一个 agent 在改，本分支不动客户端）读的是 groups/projectGroups
    const shapeSet = parseShapes(shapes);
    const explicitShapes = shapes !== undefined && shapes !== null && String(shapes).trim() !== '';
    // 默认 manual：拖过的顺序优先，没拖过的自动退回优先级/截止/创建时间（所以初看依然合理）
    const mode = SORT_MODES.includes(sort) ? sort : 'manual';
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
        // B3：过滤键与 `listProjects` 给出的清单值必须同一口径——两边都 trim 后忽略大小写比较。
        // 记录侧不 trim 的话，清单里的 `' beta '` 会被 trim 成 `beta` 去比，永远 0 条命中。
        const wanted = String(project).trim().toLowerCase();
        subset = subset.filter((r) => (r.project ?? '').trim().toLowerCase() === wanted);
      }
      if (query) {
        const needle = String(query).trim().toLowerCase();
        subset = subset.filter((r) => r.title.toLowerCase().includes(needle) || (r.notes ?? '').toLowerCase().includes(needle));
      }
      return filterRecords(subset, filter, now);
    });
    if (!picked.ok) return picked;

    // 项目视图用的分组：**不套 project 收窄**，否则面板上只剩当前项目、没法切到别处。
    // S3-3：只有真的要 projectGroups 时才做这次「全量再筛一遍 + 分桶」。
    let forProjects = null;
    if (shapeSet.has('projectGroups')) {
      const computed = attempt(() => {
        let subset = records;
        if (query) {
          const needle = String(query).trim().toLowerCase();
          subset = subset.filter((r) => r.title.toLowerCase().includes(needle) || (r.notes ?? '').toLowerCase().includes(needle));
        }
        return filterRecords(subset, filter, now);
      });
      if (!computed.ok) return computed;
      forProjects = computed.value;
    }

    // 已知项目清单（面板第二行的「项目」选择器 + 新建时的查重都靠它）。
    // **不受 shapes 影响**：它是个小数组，而「按截止」视图（shapes=groups）下
    // 面板同样要能点开项目选择器；只有 projectGroups 才带项目信息是不够的。
    // 来源是全部记录（不是筛选后的子集）：切到「已完成」也不该丢掉可选项目。
    const projectInventory = listProjects(records);

    const payload = {
      ok: true,
      // 回显实际给出的形状，调用方/测试能一眼看出这次拿了几份
      shapes: LIST_SHAPES.filter((shape) => shapeSet.has(shape)),
      // 统计基于**全部**记录，而不是当前筛选结果：面板顶部的「逾期 3 条」不该因为
      // 用户切到「已完成」标签就变成 0
      sort: mode,
      stats: statsOf(records, now),
      today: dayKey(now),
      // 复审 R4/R5：面板只能看到 /list 载荷，给它的必须是**完整的** describe()——
      // 只给 {kind, location} 的话，mismatch/split/backendError/retired/merge 这些告警
      // 永远到不了面板页脚（「数据不一致必须让用户看得见」就是断在这里的）。
      store: describe(),
      // 排序：出现次数降序 → 次数相同按名称升序；超过上限只回前 N 个并置 projectsTruncated
      projects: projectInventory.projects,
      projectsTruncated: projectInventory.truncated,
    };
    // filterRecords 内部按优先级排过序；这里按当前模式再排一次，
    // 否则「平铺列表」会和「分组」用两套顺序（sort=created/manual 时最明显）
    if (shapeSet.has('todos')) payload.todos = sortForView(picked.value, mode);
    if (shapeSet.has('groups')) payload.groups = groupRecords(picked.value, now, mode);
    // 「按项目」视图：每个项目一个桶，附 total/open/overdue
    if (shapeSet.has('projectGroups')) payload.projectGroups = groupByProject(forProjects, now, mode);
    // 载荷体量提示（S3-3）：没显式挑形状、记录又多时，告诉调用方可以只要所需的那一份
    if (!explicitShapes && records.length > LIST_PAYLOAD_WARN_ROWS) {
      payload.payloadWarning = `本次返回 ${payload.shapes.join('+')} 三份视图（${records.length} 条）；`
        + '如需降低轮询载荷，请用 shapes=todos|groups|projectGroups 只取所需形状';
    }
    return payload;
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
    // B2：落库前把近似重名的项目名对齐到已有原名（与客户端 matchExistingProject 同一规则）
    const aligned = alignProject(await snapshotForAlign(), built.value.project);
    if (aligned !== built.value.project) built.value.project = aligned;
    try {
      await store.put(built.value);
    } catch (error) {
      return { ok: false, reason: 'store-write-failed', message: `保存待办失败：${error?.message ?? error}` };
    }
    emit({ operation: 'create', todo: built.value });
    return { ok: true, todo: built.value };
  }

  /**
   * 手动排序：ids 是「新的完整顺序」，ids[i] 的记录得到 order=i。
   * 不在 ids 里的记录保持原样（order 仍为 null，继续按自动规则排）。
   * 只把「新顺序」交给存储的批量接口（`store.updateOrder`）：那里在一次读-改-写里只 patch
   * `order` 字段，既不做 N 次整文件重写（S3-1/S3-2），也不会用旧快照覆盖并发改动（S4-1）。
   * @param {{ids?: string[]}} [input]
   */
  async function reorder({ ids } = {}) {
    const order = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id.trim()) : [];
    if (!order.length) return { ok: false, reason: 'empty-order', message: '需要给出待办 id 的顺序数组' };
    let records;
    try {
      records = await all();
    } catch (error) {
      return { ok: false, reason: 'store-unreadable', message: `读取待办失败：${error?.message ?? error}` };
    }
    const known = new Set(records.map((record) => record.id));
    const unknownIds = order.filter((id) => !known.has(id));
    if (unknownIds.length) return { ok: false, reason: 'not-found', message: `这些 id 不存在：${unknownIds.join('、')}` };

    // S3-1/S3-2/S4-1：**不**再逐条 put(整条旧记录)。
    //   - put 整条 = 文件后端每次整文件重写 → O(n²)（1000 条 3.9s/404 MiB），且事件循环被占满；
    //   - 整条写的是「调用开始时的快照」→ 会静默覆盖拖拽期间另一窗口改的 title/priority。
    // 改成把「新顺序」交给存储的只改 order 批量接口：一次读-改-写，只 patch order 字段。
    let updated = 0;
    if (typeof store.updateOrder === 'function') {
      try {
        const result = await store.updateOrder(order);
        updated = result?.updated ?? 0;
      } catch (error) {
        return { ok: false, reason: 'store-write-failed', message: `保存顺序失败：${error?.message ?? error}` };
      }
    } else {
      // 兼容没有 updateOrder 的旧/第三方句柄：仍然只 patch order（相对本次读到的最新快照），
      // 但拿不到「存储侧一次读-改-写」，所以并发窗口里改的其它字段仍有被快照覆盖的可能。
      // 真实的两条后端（文件 / 官方 domain）与 lib/index.js 的不可用占位都实现了 updateOrder，
      // 这条路径只是不把第三方句柄直接判死。
      const next = applyManualOrder(records, order);
      for (let index = 0; index < next.length; index += 1) {
        if (next[index] === records[index]) continue;
        try {
          await store.put({ ...(records[index] ?? {}), order: next[index].order });
          updated += 1;
        } catch (error) {
          return { ok: false, reason: 'store-write-failed', message: `保存顺序失败：${error?.message ?? error}` };
        }
      }
    }
    emit({ operation: 'reorder', updated });
    return { ok: true, updated, order };
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
    // B2：换项目时同样对齐到已有原名。
    // 候选池 = 除自己外的全部记录 + 自己**当前**的那条记录（target）：
    //   - 「改到别的项目的大小写变体」要命中**别人**已有的原名（`Ops` → `beta` 命中 `Beta`）；
    //   - 「只是改了自己项目的大小写」要留在自己的原名上（`Ops` → `oPS` 仍是 `Ops`），
    //     但仍要排除自己原本的**旧名**——否则改名时会匹配到自己、白白放过真正的重名。
    if (Object.prototype.hasOwnProperty.call(patch ?? {}, 'project')) {
      const inventory = await snapshotForAlign();
      const candidates = Array.isArray(inventory)
        ? [...inventory.filter((record) => record?.id !== target.id), target]
        : null;
      const aligned = alignProject(candidates, next.value.project);
      if (aligned !== next.value.project) next.value.project = aligned;
    }
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
    reorder,
    create,
    update,
    setStatus,
    toggle,
    remove,
    adopt,
    all,
    sortForView,
    /**
     * 外部（官方 storage 的 domain/changed 事件、别的进程/插件实例）产生的变更，
     * 由宿主原样广播给 `onChange` 的监听者——面板刷新与 /health 的变更计数都接这里。
     */
    notifyStoreChange(change) {
      emit(change);
    },
    /** 订阅变更，返回注销函数。 */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 存储自检信息，health 路由与 README 排查都用它。 */
    describe,
  };
}
