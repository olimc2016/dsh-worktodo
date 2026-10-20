import { parseNaturalDue } from './parse-due.mjs';

/**
 * 面向模型的 worktodo_* 工具。
 *
 * 与官方 `todo_write` 的分工（这是本插件存在的理由，也是工具描述里必须讲清的话）：
 *   - `todo_write` 是**当前 agent 会话**的计划，整表替换，只有 pending/in_progress/completed，
 *     只归那一个会话，会话结束就翻篇。
 *   - `worktodo_*` 操作的是**人**的工作待办列表：跨会话、跨项目持久，有优先级、截止日期、
 *     项目与备注，可逐项增删改。agent 在这里登记的事，用户明天打开 DSH 还看得到。
 *
 * 本模块被 lib/index.js **动态导入**：@deepseek-ai/dsh-tools 在某些组合里可能解析不到，
 * 那种情况下插件仍要以「只有面板」的形态可用，所以加载失败必须被上层吞掉，不能拖垮整个包。
 */

/**
 * 本插件注册的全部工具名。
 *
 * 这是给宿主自检（`/worktodo/health` 的 `tools` 字段）用的报告清单：
 * 「工具到底注册上了没有」是最容易静默失败的一环（平台包解析不到、schema 被官方拒、
 * 跑的是过期的模块 generation），必须能从外面查，而不是靠猜。
 * 它必须与下面每个 `defineTool({ name })` 一致——`tools/smoke-host.mjs` 里有一条断言
 * 拿实际注册结果与这份清单对比，漂移了会立刻红灯。
 */
export const TOOL_NAMES = Object.freeze([
  'worktodo_add',
  'worktodo_add_many',
  'worktodo_list',
  'worktodo_update',
  'worktodo_done',
  'worktodo_remove',
  'worktodo_adopt',
]);

/**
 * 注册全部工具。
 * @param {object} options
 * @param {object} options.ctx cordis 上下文（需带 tools 服务）
 * @param {object} options.service 待办服务
 * @param {object} [options.logger]
 * @returns {Promise<{dispose: () => void, names: readonly string[]}>} 注销函数与注册到的工具名
 */
export async function registerWorkTodoTools({ ctx, service, logger }) {
  const { defineTool } = await import('@deepseek-ai/dsh-tools');

  /** 统一的显式状态 → 工具返回值转换：失败也要让模型看懂原因，而不是静默丢。 */
  const unwrap = (result) => {
    if (result?.ok) return result;
    const reason = result?.reason ?? 'unknown';
    const hint = {
      'not-found': '没找到这条待办，先用 worktodo_list 看看现有条目和 id。',
      'ambiguous-ref': '标题有歧义，改用列表里的 id。',
      'empty-title': '标题不能为空。',
      'bad-due': '日期格式不对，用 YYYY-MM-DD 或 today / tomorrow / +3d。',
      'bad-priority': '优先级只支持 high / normal / low。',
      'bad-status': '状态只支持 pending / in_progress / completed。',
      'store-write-failed': '写入存储失败，请把错误原文告诉用户。',
      'store-unreadable': '读取存储失败，请把错误原文告诉用户。',
    }[reason];
    throw new Error(`${result?.message ?? '操作失败'}${hint ? ` ${hint}` : ''}`);
  };

  /**
   * 删掉值为 undefined 的键。
   *
   * 这不是洁癖：DSH 会校验工具返回值必须是 **lossless JSON**，而 `{ due: undefined }`
   * 过不了这道校验——整个工具调用会被判为无效（真机上踩过：不传截止日期时
   * worktodo_add 直接失败，而「加一条没有截止日期的待办」恰恰是最常见的用法）。
   * 可选字段一律用这里剔除，而不是留一个 undefined 占位。
   * @param {object} value
   * @returns {object}
   */
  const compact = (value) => Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );

  /** 工具结果里统一附上统计，模型不用再调一次 list 就知道全局。 */
  const withStats = async (payload = {}) => {
    const view = await service.list({ filter: 'open' });
    return { ...payload, stats: view.ok ? view.stats : null };
  };

  const disposers = [];

  // ---- 新增 ----
  disposers.push(ctx.tools.register(defineTool({
    name: 'worktodo_add',
    description:
      '把一件事登记进用户的「工作待办」列表（跨会话、跨项目持久，归用户所有；与只属于本会话的 todo_write 不同）。'
      + '当用户说出要做的事、或你在工作中发现一件需要人跟进的事（等确认、等回复、等部署、要交的活）时用它。'
      + '标题要短而具体（一件可执行的事），不要写成一整段话。',
    parameters: {
      title: { type: 'string', required: true, description: '待办内容，一句简短的祈使句，例如「把 v0.1.0 发到 npm」。' },
      due: { type: 'string', description: '截止日期：YYYY-MM-DD / today / tomorrow / +3d。省略表示没有截止日期。' },
      dueTime: { type: 'string', description: '截止时间 HH:MM（可选，只有给了 due 才有意义；例如 14:30）。' },
      priority: { type: 'string', enum: ['high', 'normal', 'low'], description: '优先级，默认 normal。真正卡住别人的事才给 high。' },
      project: {
        type: 'string',
        description: '项目或领域标签，例如 dsh-worktodo。省略表示不归类。'
          + '项目名请与既有项目保持一致（复用一个已有名，别写只差大小写/空白的变体，否则「按项目」视图会裂成多个桶）；'
          + '不确定就先调 worktodo_list 看 projects 清单，从里面挑。',
      },
      notes: { type: 'string', description: '补充说明：背景、链接、验收标准。默认空。' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '初始状态，默认 pending。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          due: { type: 'string' },
          dueTime: { type: 'string' },
          priority: { type: 'string', required: true },
          project: { type: 'string' },
          status: { type: 'string', required: true },
          stats: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已记入工作待办：${value.title}（${value.id}${value.due ? `，截止 ${value.due}${value.dueTime ? ` ${value.dueTime}` : ''}` : ''}）`
          + (value.stats ? `｜当前未完成 ${value.stats.open} 条，已过期 ${value.stats.overdue} 条` : ''),
      }],
    },
    execute(args) {
      return service.create(withParsedDue(args), { source: 'agent' }).then(unwrap).then((result) => withStats(compact({
        id: result.todo.id,
        title: result.todo.title,
        due: result.todo.due ?? undefined,
        dueTime: result.todo.dueTime ?? undefined,
        priority: result.todo.priority,
        project: result.todo.project ?? undefined,
        status: result.todo.status,
      })));
    },
    presentCall: (args) => ({ card: 'generic', title: '登记工作待办', kind: 'other', rawInput: args.title }),
  })));

  // ---- 批量新增（AI 友好：一口气登记多条）----
  disposers.push(ctx.tools.register(defineTool({
    name: 'worktodo_add_many',
    description:
      '一次登记多条工作待办（用户一口气说了好几件事、或你整理出一串要跟进的活时用它；分开一条条调 worktodo_add 也行，但这样更省调用）。'
      + '某条不合法只跳过那一条并把原因回传，不影响其余条目。',
    parameters: {
      items: {
        type: 'array',
        required: true,
        description: '要登记的事；每项至少给 title。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: '待办内容（一句简短的祈使句）。' },
            due: { type: 'string', description: '截止日期：YYYY-MM-DD / today / tomorrow / +3d。' },
            dueTime: { type: 'string', description: '截止时间 HH:MM（可选）。' },
            priority: { type: 'string', enum: ['high', 'normal', 'low'], description: '默认 normal。' },
            project: {
              type: 'string',
              description: '项目或领域标签。项目名请复用已有项目名（不确定先调 worktodo_list 看 projects 清单），别写只差大小写/空白的变体。',
            },
            notes: { type: 'string', description: '背景、链接、验收标准。' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '默认 pending。' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          created: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                due: { type: 'string' },
                dueTime: { type: 'string' },
                priority: { type: 'string', required: true },
                project: { type: 'string' },
                status: { type: 'string', required: true },
              },
            },
          },
          skipped: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'number', required: true },
                title: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          stats: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已记入工作待办 ${value.count} 条`
          + (value.skipped.length ? `，跳过 ${value.skipped.length} 条（${value.skipped.map((entry) => `#${entry.index} ${entry.reason}`).join('；')}）` : '')
          + (value.stats ? `｜当前未完成 ${value.stats.open} 条，已过期 ${value.stats.overdue} 条` : ''),
      }],
    },
    async execute(args) {
      const created = [];
      const skipped = [];
      const items = Array.isArray(args.items) ? args.items : [];
      for (const [index, item] of items.entries()) {
        try {
          const result = unwrap(await service.create(withParsedDue(item ?? {}), { source: 'agent' }));
          created.push(compact({
            id: result.todo.id,
            title: result.todo.title,
            due: result.todo.due ?? undefined,
            dueTime: result.todo.dueTime ?? undefined,
            priority: result.todo.priority,
            project: result.todo.project ?? undefined,
            status: result.todo.status,
          }));
        } catch (error) {
          skipped.push({
            index,
            title: typeof item?.title === 'string' ? item.title : '',
            reason: String(error?.message ?? error),
          });
        }
      }
      return withStats(compact({ count: created.length, created, skipped }));
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `登记 ${Array.isArray(args.items) ? args.items.length : 0} 条工作待办`,
      kind: 'other',
      rawInput: '',
    }),
  })));

  // ---- 查询 ----
  disposers.push(ctx.tools.register(defineTool({
    name: 'worktodo_list',
    description:
      '查看用户的「工作待办」列表，含优先级、截止日期、项目与已过期情况。'
      + '在开始一轮工作前、或用户问「我今天要做什么 / 有什么没做完」时先调它，避免重复登记同一件事。'
      + '默认只看未完成；completed 才看已完成的。',
    parameters: {
      filter: { type: 'string', enum: ['open', 'today', 'overdue', 'week', 'doing', 'completed', 'all'], description: '默认 open（未完成）。' },
      project: { type: 'string', description: '只看某个项目标签。' },
      query: { type: 'string', description: '按标题或备注里的关键词过滤。' },
      sort: { type: 'string', enum: ['manual', 'priority', 'created'], description: '排序：manual=尊重用户拖动过的顺序（默认，用户看到的顺序）；priority=高优先级在前；created=最近添加的在前。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lines: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          stats: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.lines }],
    },
    execute(args) {
      return service.list(args).then(unwrap).then((result) => ({
        lines: result.todos.length
          ? result.todos.map((t) => {
            const box = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
            const bits = [t.priority === 'high' ? '高' : t.priority === 'low' ? '低' : null, t.due ? `${t.due}${t.dueTime ? ` ${t.dueTime}` : ''}${t.due < result.today && t.status !== 'completed' ? '(已过期)' : ''}` : null, t.project ? `#${t.project}` : null].filter(Boolean);
            return `${box} ${t.id}  ${t.title}${bits.length ? `  (${bits.join(', ')})` : ''}`;
          }).join('\n')
          : '（没有符合条件的待办）',
        count: result.todos.length,
        stats: result.stats,
      }));
    },
    presentCall: (args) => ({ card: 'generic', title: '查看工作待办', kind: 'other', rawInput: args }),
  })));

  // ---- 修改 ----
  disposers.push(ctx.tools.register(defineTool({
    name: 'worktodo_update',
    description:
      '修改一条工作待办：改标题、补截止日期、调优先级、加备注、换项目。'
      + '只传要改的字段，其余保持不变（与整表替换的 todo_write 不同，这里不会动其他条目）。'
      + '用 id 或标题定位；标题必须能唯一匹配。',
    parameters: {
      ref: { type: 'string', required: true, description: '待办的 id（推荐）或标题。' },
      title: { type: 'string', description: '新标题。' },
      due: { type: 'string', description: '新截止日期；传 none 清空（清空日期会一并清掉时间）。' },
      dueTime: { type: 'string', description: '新截止时间 HH:MM；传 none 清空。' },
      priority: { type: 'string', enum: ['high', 'normal', 'low'] },
      project: {
        type: 'string',
        description: '新项目标签；传 none 清空。换项目时请复用已有项目名'
          + '（不确定先调 worktodo_list 看 projects 清单），别写只差大小写/空白的变体。',
      },
      notes: { type: 'string', description: '新备注。' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          status: { type: 'string', required: true },
          due: { type: 'string' },
          priority: { type: 'string', required: true },
          stats: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已更新：${value.title}（${value.status}${value.due ? `，截止 ${value.due}` : ''}）` }],
    },
    execute(args) {
      const { ref, ...patch } = args;
      // 显式传 none 表示清空：转成 null 让 records.normalizeXxx 走清空分支
      for (const key of ['due', 'project']) {
        if (typeof patch[key] === 'string' && /^(none|null|clear|清空)$/i.test(patch[key].trim())) patch[key] = null;
      }
      return service.update(ref, patch).then(unwrap).then((result) => withStats(compact({
        id: result.todo.id,
        title: result.todo.title,
        status: result.todo.status,
        due: result.todo.due ?? undefined,
        priority: result.todo.priority,
      })));
    },
    presentCall: (args) => ({ card: 'generic', title: '更新工作待办', kind: 'other', rawInput: args }),
  })));

  // ---- 完成 / 改状态 ----
  disposers.push(ctx.tools.register(defineTool({
    name: 'worktodo_done',
    description:
      '把一条工作待办标记为已完成（默认），也可以标回 in_progress 或 pending。'
      + '你替用户做完一件事、或用户说「那个弄好了」时用它——注意只有确实完成了才标 completed。',
    parameters: {
      ref: { type: 'string', required: true, description: '待办的 id 或标题。' },
      status: { type: 'string', enum: ['completed', 'in_progress', 'pending'], description: '默认 completed。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          status: { type: 'string', required: true },
          stats: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'completed'
          ? `已完成：${value.title}`
          : `已把「${value.title}」改为 ${value.status}`,
      }],
    },
    execute(args) {
      return service.setStatus(args.ref, args.status ?? 'completed').then(unwrap).then((result) => withStats({
        id: result.todo.id,
        title: result.todo.title,
        status: result.todo.status,
      }));
    },
    presentCall: (args) => ({ card: 'generic', title: '完成工作待办', kind: 'other', rawInput: args.ref }),
  })));

  // ---- 删除 ----
  disposers.push(ctx.tools.register(defineTool({
    name: 'worktodo_remove',
    description:
      '从工作待办列表里删掉一条（不是标记完成）。'
      + '只在用户明确说「删掉 / 不用做了 / 这条是错的」时用；做完了请用 worktodo_done 保留记录。',
    parameters: {
      ref: { type: 'string', required: true, description: '待办的 id 或标题。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          stats: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已删除：${value.title}` }],
    },
    execute(args) {
      return service.remove(args.ref).then(unwrap).then((result) => withStats({
        id: result.removed.id,
        title: result.removed.title,
      }));
    },
    presentCall: (args) => ({ card: 'generic', title: '删除工作待办', kind: 'other', rawInput: args.ref }),
  })));

  // ---- 把会话 todos 提升为工作待办 ----
  disposers.push(ctx.tools.register(defineTool({
    name: 'worktodo_adopt',
    description:
      '把本会话 todo_write 列表里的条目提升为用户的工作待办（跨会话保留、可加优先级和截止日期）。'
      + '当你这个会话排出的计划里有事后仍需人跟进的事（交付、评审、部署、等回复）时，用它把该留的那几条留下来。'
      + '按标题去重，已经存在的不会重复登记。',
    parameters: {
      todos: {
        type: 'array',
        required: true,
        description: '要提升的条目，直接把你当前 todo 列表里该留下的部分抄进来。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            content: { type: 'string', required: true, description: '任务内容。' },
            status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed'] },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          created: { type: 'integer', required: true },
          skipped: { type: 'integer', required: true },
          lines: { type: 'string', required: true },
          stats: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.lines }],
    },
    execute(args) {
      return service.adopt(args.todos).then(unwrap).then((result) => withStats({
        created: result.created.length,
        skipped: result.skipped,
        lines: result.created.length
          ? `已提升 ${result.created.length} 条到工作待办：\n${result.created.map((t) => `- ${t.title}`).join('\n')}`
          : '没有新的条目需要提升（都已在工作待办里）。',
      }));
    },
    presentCall: (args) => ({ card: 'generic', title: '提升会话待办', kind: 'other', rawInput: args.todos }),
  })));

  logger?.info?.(`registered ${disposers.length} worktodo tools`);
  // 注销函数 + 注册到的工具名：后者给 /worktodo/health 自检用（见 TOOL_NAMES 的说明）
  return {
    names: TOOL_NAMES,
    dispose: () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch { /* 卸载期清理失败不应打断取消流程 */ }
      }
    },
  };
}/**
 * 让工具也能"说人话"：标题里写了「明天下午三点」这类说法时，交给与面板**同一份**解析器
 * （`src/parse-due.mjs`）。显式传了 `due` 就以显式为准，绝不被标题覆盖。
 * @param {object} input
 * @returns {object} 落库用的参数（标题里的日期词会被摘掉）
 */
export function withParsedDue(input = {}) {
  const explicit = input.due !== undefined && input.due !== null && input.due !== '';
  if (explicit) return input;
  const parsed = parseNaturalDue(String(input.title ?? ''), Date.now());
  if (!parsed.matched.length) return input;
  return {
    ...input,
    title: parsed.title,
    due: parsed.due ?? undefined,
    dueTime: input.dueTime ?? parsed.dueTime ?? undefined,
  };
}


