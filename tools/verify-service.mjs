/**
 * service.mjs 测试：显式状态、引用定位、完成语义、提升去重。
 *
 * 这里用内存假存储，不碰磁盘——因为要验的是「服务的判断」，不是存储的 IO
 *（存储在 verify-store.mjs 里用真实文件与官方领域契约验证）。
 *
 * 为什么值得单独测：面板的按钮与 agent 的工具**共用**这一层，
 * 所以这里的行为错了，两条路径会一起错。
 */
import { createWorkTodoService } from '../src/service.mjs';
import { PROJECT_LIST_LIMIT } from '../src/records.mjs';

let passed = 0;
const failures = [];

/**
 * @param {string} label
 * @param {() => any} run
 */
async function test(label, run) {
  try {
    await run();
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

/** 内存假存储：与 store.mjs 暴露的接口一致。 */
function fakeStore() {
  const map = new Map();
  return {
    kind: 'domain',
    location: 'storage:worktodo/todos',
    // 测试直接看盘上的原始记录（用来断言「非法输入一个字节都不写」）
    map,
    async load() {
      return [...map.values()];
    },
    async put(record) {
      map.set(record.id, record);
    },
    async remove(id) {
      return map.delete(id);
    },
  };
}

const NOW = new Date(2026, 9, 14, 10, 30, 0, 0).getTime();
/** 造一个时钟可控的服务实例。 */
function makeService() {
  let tick = 0;
  return createWorkTodoService({
    store: fakeStore(),
    clock: () => NOW + tick++,
    logger: { warn() {}, info() {} },
  });
}

console.log('新增');

await test('新增成功后能读回来，且带默认值', async () => {
  const s = makeService();
  const created = await s.create({ title: '写周报', due: 'tomorrow', priority: '高' });
  eq(created.ok, true);
  eq(created.todo.title, '写周报');
  eq(created.todo.priority, 'high');
  eq(created.todo.due, '2026-10-15');
  eq(created.todo.status, 'pending');
  eq(created.todo.source, 'human');

  const list = await s.list({ filter: 'open' });
  eq(list.ok, true);
  eq(list.todos.map((t) => t.title), ['写周报']);
  eq(list.store.kind, 'domain');
});

await test('标题为空时返回显式失败而不是抛异常', async () => {
  const s = makeService();
  const failed = await s.create({ title: '   ' });
  eq(failed.ok, false);
  eq(failed.reason, 'empty-title');
  eq(typeof failed.message, 'string');
});

await test('来源可以是 agent', async () => {
  const s = makeService();
  const created = await s.create({ title: '等对方回复' }, { source: 'agent' });
  eq(created.todo.source, 'agent');
});

console.log('修改与引用');

await test('按标题定位修改，未提及的字段不变', async () => {
  const s = makeService();
  await s.create({ title: '写周报', project: 'p1', priority: 'high' });
  const updated = await s.update('写周报', { due: '2026-10-20' });
  eq(updated.ok, true);
  eq(updated.todo.due, '2026-10-20');
  eq(updated.todo.project, 'p1', '未提及的字段 ');
  eq(updated.todo.priority, 'high');
});

await test('定位不到时给 not-found，歧义时给 ambiguous-ref', async () => {
  const s = makeService();
  await s.create({ title: '写周报' });
  await s.create({ title: '写发布说明' });
  eq((await s.update('不存在', { priority: 'high' })).reason, 'not-found');
  eq((await s.update('写', { priority: 'high' })).reason, 'ambiguous-ref');
});

await test('空补丁被拒绝，避免「看起来成功了其实没改」', async () => {
  const s = makeService();
  await s.create({ title: '写周报' });
  const result = await s.update('写周报', {});
  eq(result.ok, false);
  eq(result.reason, 'empty-patch');
});

await test('清空截止日期与项目用 null', async () => {
  const s = makeService();
  await s.create({ title: '写周报', due: '2026-10-20', project: 'p1' });
  const cleared = await s.update('写周报', { due: null, project: null });
  eq(cleared.todo.due, null);
  eq(cleared.todo.project, null);
});

console.log('完成语义');

await test('toggle 在完成与未完成之间来回，且维护 completedAt', async () => {
  const s = makeService();
  const created = await s.create({ title: '写周报' });
  const id = created.todo.id;

  const done = await s.toggle(id);
  eq(done.ok, true);
  eq(done.todo.status, 'completed');
  eq(typeof done.todo.completedAt, 'number');

  const reopened = await s.toggle(id);
  eq(reopened.todo.status, 'pending');
  eq(reopened.todo.completedAt, null, '取消完成后 ');
});

await test('setStatus 也走同一份逻辑（进度态）', async () => {
  const s = makeService();
  const created = await s.create({ title: '写周报' });
  const doing = await s.setStatus(created.todo.id, 'in_progress');
  eq(doing.todo.status, 'in_progress');
  const list = await s.list({ filter: 'doing' });
  eq(list.todos.map((t) => t.id), [created.todo.id]);
});

console.log('删除');

await test('删除后列表里不再出现，重复删除给 not-found', async () => {
  const s = makeService();
  const created = await s.create({ title: '写周报' });
  const removed = await s.remove(created.todo.id);
  eq(removed.ok, true);
  eq(removed.removed.title, '写周报');
  eq((await s.list({ filter: 'all' })).todos.length, 0);
  eq((await s.remove(created.todo.id)).reason, 'not-found');
});

console.log('列表与统计');

await test('统计基于全部记录，不随筛选变化', async () => {
  const s = makeService();
  await s.create({ title: '已过期', due: '2026-10-10' });
  await s.create({ title: '今天', due: 'today' });
  await s.create({ title: '以后', due: '2026-11-01' });
  const done = await s.create({ title: '做完的' });
  await s.toggle(done.todo.id);

  const openOnly = await s.list({ filter: 'open' });
  eq(openOnly.todos.length, 3);
  eq(openOnly.stats.total, 4, '统计口径 ');
  eq(openOnly.stats.overdue, 1);
  eq(openOnly.stats.today, 1);
  eq(openOnly.stats.completed, 1);
  eq(openOnly.stats.completedToday, 1);

  const completedOnly = await s.list({ filter: 'completed' });
  eq(completedOnly.todos.length, 1);
  eq(completedOnly.stats.total, 4, '切到已完成页时总数不该变 ');
});

await test('按项目与关键词过滤，并给出项目清单', async () => {
  const s = makeService();
  await s.create({ title: '写周报', project: 'ops' });
  await s.create({ title: '改 bug', project: 'dev', notes: '复现步骤见 issue 12' });
  const byProject = await s.list({ filter: 'open', project: 'dev' });
  eq(byProject.todos.map((t) => t.title), ['改 bug']);
  const byQuery = await s.list({ filter: 'open', query: 'issue 12' });
  eq(byQuery.todos.map((t) => t.title), ['改 bug'], '备注也要能被搜到：');
  const all = await s.list({ filter: 'open' });
  eq(all.projects, ['dev', 'ops']);
});

await test('分组结果与筛选结果同时可用（面板一次请求拿全）', async () => {
  const s = makeService();
  await s.create({ title: '已过期', due: '2026-10-10' });
  await s.create({ title: '今天', due: 'today' });
  await s.create({ title: '明天', due: 'tomorrow' });
  await s.create({ title: '无期' });
  const view = await s.list({ filter: 'open' });
  eq(view.groups.overdue.map((t) => t.title), ['已过期']);
  eq(view.groups.today.map((t) => t.title), ['今天']);
  eq(view.groups.tomorrow.map((t) => t.title), ['明天']);
  eq(view.groups.week.map((t) => t.title), [], '明天不能再落进本周：');
  eq(view.groups.later.map((t) => t.title), ['无期']);
  eq(view.today, '2026-10-14');
  eq(view.stats.tomorrow, 1, 'stats 顺带给出明天条数：');
});

console.log('会话待办提升');

await test('提升去重并统计跳过数', async () => {
  const s = makeService();
  await s.create({ title: '已有的事' });
  const result = await s.adopt([
    { content: '已有的事', status: 'pending' },
    { content: '新的事', status: 'in_progress' },
  ]);
  eq(result.ok, true);
  eq(result.created.map((t) => t.title), ['新的事']);
  eq(result.created[0].source, 'session');
  eq(result.skipped, 1);
  eq((await s.list({ filter: 'all' })).todos.length, 2);
});

await test('没有可提升的条目时明确返回空', async () => {
  const s = makeService();
  const result = await s.adopt([{ content: '   ', status: 'pending' }]);
  eq(result.ok, true);
  eq(result.created.length, 0);
  eq(result.skipped, 1);
});

console.log('列表载荷形状（S3-3：只回所需，不再三份）');

await test('shapes=todos 时只回一份 todos，不再带 groups/projectGroups', async () => {
  const s = makeService();
  await s.create({ title: 'a', project: 'p' });
  await s.create({ title: 'b' });
  const only = await s.list({ filter: 'all', shapes: 'todos' });
  eq(only.ok, true);
  eq('todos' in only, true);
  eq('groups' in only, false, '只要 todos 时不该再带 groups（那正是 3 倍载荷的来源）：');
  eq('projectGroups' in only, false, '也不该带 projectGroups：');
  eq(only.shapes, ['todos']);
  eq(only.todos.length, 2);
  // 面板仍需的小字段必须还在（换成 shapes 不能把统计/诊断/项目清单也省掉）
  eq(typeof only.stats.total, 'number');
  eq(typeof only.store.kind, 'string');
  eq(only.projects, ['p']);
  eq(only.today, '2026-10-14');
});

await test('shapes 可取 groups / projectGroups / 组合；缺省与非法值都保持三份（旧面板合同不变）', async () => {
  const s = makeService();
  await s.create({ title: 'a', project: 'p' });
  const groups = await s.list({ filter: 'all', shapes: 'groups' });
  eq('groups' in groups, true);
  eq('todos' in groups, false);
  eq('projectGroups' in groups, false);

  const buckets = await s.list({ filter: 'all', shapes: 'projectGroups' });
  eq('projectGroups' in buckets, true);
  eq('todos' in buckets, false);
  eq('groups' in buckets, false);

  const combo = await s.list({ filter: 'all', shapes: 'todos,groups' });
  eq(combo.shapes, ['todos', 'groups']);
  eq('projectGroups' in combo, false);

  const both = await s.list({ filter: 'all' });
  eq([['todos' in both, 'groups' in both, 'projectGroups' in both]], [[true, true, true]], '缺省必须保持旧面板读得到的三个字段：');
  eq(both.shapes, ['todos', 'groups', 'projectGroups']);
  eq((await s.list({ filter: 'all', shapes: 'both' })).shapes, ['todos', 'groups', 'projectGroups']);
  // 非法值回落到三份：宁可多给，不可少给（少给会让面板出现空白区）
  eq((await s.list({ filter: 'all', shapes: '乱写' })).shapes, ['todos', 'groups', 'projectGroups']);
});

await test('S3-3：记录多且未指定 shapes 时给出体量提示；指定 shapes 后不再提示', async () => {
  const s = makeService();
  await Promise.all(Array.from({ length: 2001 }, (_, i) => s.create({ title: `条目 ${i}` })));
  const full = await s.list({ filter: 'all' });
  eq(typeof full.payloadWarning, 'string', '超过阈值（2000 条）要给「可以只要一种形状」的提示：');
  eq(full.payloadWarning.includes('shapes'), true, `提示要给出可执行的参数：${full.payloadWarning}`);
  const picked = await s.list({ filter: 'all', shapes: 'todos' });
  eq('payloadWarning' in picked, false, '显式挑了形状就不该再提示：');
  eq(picked.todos.length, 2001);
});

console.log('已知项目清单（/list 的 projects：面板「项目」选择器的数据来源）');

await test('/list 在任何 shapes 下都带 projects / projectsTruncated（空清单时是 [] / false）', async () => {
  const s = makeService();
  for (const shapes of [undefined, 'todos', 'groups', 'projectGroups', 'todos,groups']) {
    const view = await s.list({ filter: 'all', shapes });
    eq(Array.isArray(view.projects), true, `shapes=${shapes} 时 projects 必须是数组：`);
    eq(view.projects, [], `shapes=${shapes} 时的空清单：`);
    // 面板要靠它决定「是否提示只显示常用项目」，所以任何形状下都必须是布尔
    eq(view.projectsTruncated, false, `shapes=${shapes} 时 projectsTruncated：`);
  }
});

await test('/list 的 projects：按出现次数降序 → 名称升序；来自全量而非当前筛选（去掉空值）', async () => {
  const s = makeService();
  await s.create({ title: 'z1', project: 'zeta' });
  await s.create({ title: 'z2', project: 'zeta' });
  await s.create({ title: 'a1', project: 'alpha' });
  await s.create({ title: 'b1', project: 'beta' });
  await s.create({ title: '未归类' });

  const all = await s.list({ filter: 'all' });
  // 次数 zeta 2 > beta 1 = alpha 1 → 次数相同时按名称升序（alpha 在 beta 前）
  // 旧的 `[...new Set(...)].sort()` 会给出 ['alpha','beta','zeta'] —— 这条断言正是那个靶子
  eq(all.projects, ['zeta', 'alpha', 'beta']);

  // 清单来自**全部**记录：切到「已完成」（这里一条都没有）也不能把可选项目清空
  const completedOnly = await s.list({ filter: 'completed' });
  eq(completedOnly.projects, ['zeta', 'alpha', 'beta'], '筛选不该影响项目清单：');

  // 按项目收窄时也一样：否则面板切进某个项目后就再也列不出别的项目
  const scoped = await s.list({ filter: 'open', project: 'alpha' });
  eq(scoped.todos.map((t) => t.title), ['a1']);
  eq(scoped.projects, ['zeta', 'alpha', 'beta'], 'project 收窄不该影响项目清单：');
});

await test('/list 的 projects 超过上限时只回前 50 个并置 projectsTruncated（任何 shapes 都截断）', async () => {
  const s = makeService();
  for (let i = 0; i < 60; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await s.create({ title: `项目条目 ${i}`, project: `p${String(i).padStart(2, '0')}` });
  }
  for (const shapes of [undefined, 'groups', 'projectGroups']) {
    const view = await s.list({ filter: 'all', shapes });
    eq(view.projects.length, PROJECT_LIST_LIMIT, `shapes=${shapes} 时回前 ${PROJECT_LIST_LIMIT} 个：`);
    eq(view.projectsTruncated, true, `shapes=${shapes} 时 projectsTruncated：`);
    eq(view.projects[0], 'p00', '取的必须是排序后的前 N 个：');
  }
});

await test('B3：清单里给出的项目名原样拿去 /list?project= 必须命中（口径一致，不 trim 输出）', async () => {
  // 直改存储 / 迁移才可能产生带首尾空白的项目名（正常写入路径 normalizeProject 会 trim），
  // 这里就模拟这种存量数据：清单显示什么值，过滤就必须用什么值命中。
  const seeded = {
    id: 'legacy-1', title: '带空白的存量项目', status: 'pending', priority: 'normal',
    due: null, dueTime: null, notes: '', project: ' beta ', source: 'human',
    createdAt: NOW, updatedAt: NOW, completedAt: null, order: null,
  };
  const store = fakeStore();
  await store.put(seeded);
  const s = createWorkTodoService({ store, clock: () => NOW, logger: { warn() {}, info() {} } });

  const all = await s.list({ filter: 'all', shapes: 'projectGroups' });
  // (a) 清单里就是存储里的原名（不 trim），且与「按项目」桶名逐字一致
  eq(all.projects, [' beta '], '/list 的 projects 必须原样给出：');
  eq(all.projectGroups.map((bucket) => bucket.project), [' beta '], '桶名与清单名必须是同一个字符串：');
  // (b) 核心断言：拿清单里给出的值去过滤，必须命中那条记录（以前 trim 后是 0 条）
  const picked = await s.list({ filter: 'all', project: all.projects[0] });
  eq(picked.todos.map((t) => t.id), ['legacy-1'], '用清单里的值过滤必须命中该记录：');
  // 选择器已经把值 trim 过（面板显示 beta）：去掉首尾空白的形态同样要命中同一条
  const trimmed = await s.list({ filter: 'all', project: 'beta' });
  eq(trimmed.todos.map((t) => t.id), ['legacy-1'], 'trim 过的选择器值也要命中同一条：');

  // 逐项校验每一条清单值都能命中（面板点谁就筛谁）；两种存量写法（带空白 / 不带空白）算同一个项目
  const store2 = fakeStore();
  await store2.put(seeded);
  await store2.put({ ...seeded, id: 'legacy-2', title: '同项目的另一种写法', project: 'beta' });
  const s2 = createWorkTodoService({ store: store2, clock: () => NOW, logger: { warn() {}, info() {} } });
  const both = await s2.list({ filter: 'all', project: 'beta' });
  eq([...both.todos.map((t) => t.id)].sort(), ['legacy-1', 'legacy-2'], '忽略首尾空白：两种写法是同一条目：');
  // 已知遗留：清单本身只按「逐字」去重（大小写/首尾空白仍是两个条目）——这本轮不动，
  // 但每个条目都能命中（下面逐条验证），所以「选了却 0 条」不会发生。
  const names = (await s2.list({ filter: 'all' })).projects;
  eq([...names].sort(), [' beta ', 'beta'], '清单逐字去重（已知遗留，与 groupByProject 一致）：');
  for (const name of names) {
    const hit = await s2.list({ filter: 'all', project: name });
    eq(hit.todos.length > 0, true, `清单值 ${JSON.stringify(name)} 命中 0 条：`);
  }
});

await test('B2：宿主侧把近似重名归一到已有项目名（忽略大小写 + 去首尾空白）', async () => {
  const s = makeService();
  await s.create({ title: '第一条', project: 'Beta' });
  // agent / 行内编辑直接写大小写变体：必须归一到已有名，否则「按项目」视图裂成三个桶
  const lower = await s.create({ title: '第二条', project: 'beta' });
  eq(lower.todo.project, 'Beta', 'create 的近似重名要归一到已有原名：');
  const messy = await s.create({ title: '第三条', project: '  BEta  ' });
  eq(messy.todo.project, 'Beta', '首尾空白 + 大小写都要归一：');

  const view = await s.list({ filter: 'all', shapes: 'projectGroups' });
  eq(view.projects, ['Beta'], '清单只能有一个项目：');
  eq(view.projectGroups.map((bucket) => bucket.project), ['Beta'], '「按项目」只能有一个桶：');

  // update 同样归一（换项目也要沿用已有名）
  const other = await s.create({ title: '第四条', project: 'Ops' });
  const otherId = other.todo.id;
  const renamed = await s.update(otherId, { project: 'oPS' });
  eq(renamed.todo.project, 'Ops', 'update 的近似重名要归一到已有原名：');
  eq((await s.list({ filter: 'all' })).projects.sort(), ['Beta', 'Ops'], '归一后不该多出第三个项目：');

  // 全新项目名（没有近似重名）必须是**原样保留**，不能被乱改大小写
  const fresh = await s.create({ title: '第五条', project: 'NewThing' });
  eq(fresh.todo.project, 'NewThing', '没有近似重名时原样保留：');

  // 排除自己：把「第四条」从 Ops 改名到 Beta 的变体时要命中 **Beta**（不是留在自己身上）
  const moved = await s.update(otherId, { project: 'betA' });
  eq(moved.todo.project, 'Beta', '改名要命中别的项目，不能匹配到自己：');
  eq((await s.list({ filter: 'all' })).projects.sort(), ['Beta', 'NewThing'], '旧项目名不该被自己留住：');
});

await test('create / update 带 project 能落库，并被 /list 的 projects 反映（含 project:null 清空）', async () => {
  const s = makeService();
  const made = await s.create({ title: '选择器新建的项目', project: 'picker-a' });
  eq(made.ok, true);
  eq(made.todo.project, 'picker-a');
  eq((await s.list({ filter: 'all' })).projects, ['picker-a'], 'create 的项目要进清单：');

  const renamed = await s.update(made.todo.id, { project: 'picker-b' });
  eq(renamed.ok, true);
  eq(renamed.todo.project, 'picker-b');
  eq((await s.list({ filter: 'all' })).projects, ['picker-b'], '改名后旧名不该留在清单里：');

  const cleared = await s.update(made.todo.id, { project: null });
  eq(cleared.ok, true);
  eq(cleared.todo.project, null, 'project: null 必须清空：');
  eq((await s.list({ filter: 'all' })).projects, [], '清空后清单里不该再有它：');

  // 面板的「未归类」是 project=null；把「空白串」也当清空（宿主已在路由层做，服务层同样成立）
  await s.update(made.todo.id, { project: 'picker-c' });
  const blank = await s.update(made.todo.id, { project: '   ' });
  eq(blank.todo.project, null, '空白串等于未归类：');
});

console.log('拖动排序（S3-1 / S3-2 / S4-1）');

/**
 * 带计数的假存储：复刻「批量写只 patch order，且基于最新记录」的真实契约，
 * 并在批量写落地前模拟另一窗口的并发写（S4-1 的丢失更新场景）。
 */
function instrumentedStore() {
  const map = new Map();
  const calls = { put: 0, updateOrder: 0 };
  const store = {
    map,
    calls,
    /** 批量写落地前被「另一窗口」改名的记录 id。 */
    concurrentId: null,
    kind: 'file',
    location: '/tmp/verify-service.json',
    async load() { return [...map.values()].map((record) => ({ ...record })); },
    async put(record) { calls.put += 1; map.set(record.id, { ...record }); },
    async remove(id) { return map.delete(id); },
    async updateOrder(ids) {
      calls.updateOrder += 1;
      // 并发写先落地（真实场景：拖拽开始后、整批写之前）
      const other = map.get(store.concurrentId);
      if (other) map.set(store.concurrentId, { ...other, title: '并发改的', priority: 'high', updatedAt: NOW + 5000 });
      const position = new Map(ids.map((id, index) => [id, index]));
      let updated = 0;
      for (const [id, record] of map) {
        if (!position.has(id)) continue;
        const order = position.get(id);
        if (record.order === order) continue;
        map.set(id, { ...record, order }); // 只 patch order，绝不整条覆盖
        updated += 1;
      }
      return { updated };
    },
  };
  return store;
}

await test('S3-1/S4-1：reorder 只调一次 updateOrder（不再逐条 put 整条旧记录）且保留并发改动', async () => {
  const store = instrumentedStore();
  const s = createWorkTodoService({ store, clock: () => NOW, logger: { warn() {}, info() {} } });
  const a = await s.create({ title: '一' });
  const b = await s.create({ title: '二' });
  const c = await s.create({ title: '三' });
  eq(store.calls.put, 3, '前三条是 create 写进去的：');

  store.concurrentId = b.todo.id;
  const result = await s.reorder({ ids: [c.todo.id, b.todo.id, a.todo.id] });
  eq(result.ok, true);
  eq(result.updated, 3);
  eq(store.calls.put, 3, 'reorder 绝不能再逐条 put（改前每条都 put 一次，用的是拖拽开始时的快照）：');
  eq(store.calls.updateOrder, 1, '整次拖拽只允许一次批量写：');

  const listed = (await s.list({ filter: 'all' })).todos;
  const two = listed.find((record) => record.id === b.todo.id);
  eq(two.title, '并发改的', '并发改的 title 不能被排序写覆盖：');
  eq(two.priority, 'high');
  eq(listed.filter((record) => Number.isFinite(record.order)).length, 3, '三条都应拿到 order：');
  eq(listed.find((record) => record.id === c.todo.id).order, 0);
  eq(listed.find((record) => record.id === a.todo.id).order, 2);
});

await test('S3-1：空的/未知的 ids 仍然显式失败，且不会调用批量写', async () => {
  const store = instrumentedStore();
  const s = createWorkTodoService({ store, clock: () => NOW, logger: { warn() {}, info() {} } });
  await s.create({ title: '一' });
  eq((await s.reorder({})).reason, 'empty-order');
  eq((await s.reorder({ ids: ['wt-不存在'] })).reason, 'not-found');
  eq(store.calls.updateOrder, 0, '校验失败时不该动存储：');
});

await test('存储不支持批量写时 reorder 退回「只 patch order」的逐条写（兼容路径）', async () => {
  const map = new Map();
  const puts = [];
  const legacy = {
    kind: 'file',
    location: '/tmp/legacy.json',
    async load() { return [...map.values()]; },
    async put(record) { puts.push(record); map.set(record.id, record); },
    async remove(id) { return map.delete(id); },
  };
  const s = createWorkTodoService({ store: legacy, clock: () => NOW, logger: { warn() {}, info() {} } });
  const a = await s.create({ title: '一' });
  const b = await s.create({ title: '二' });
  const snapshot = await legacy.load();
  const putsBefore = puts.length;
  const result = await s.reorder({ ids: [b.todo.id, a.todo.id] });
  eq(result.ok, true, '没有 updateOrder 的第三方存储仍要能用：');
  const written = puts.slice(putsBefore);
  eq(written.length, 2, '兼容路径逐条写：');
  for (const record of written) {
    const before = snapshot.find((item) => item.id === record.id);
    const changed = Object.keys(record).filter((key) => JSON.stringify(record[key]) !== JSON.stringify(before[key]));
    eq(changed, ['order'], '兼容路径也只能改 order，不能拿旧快照整条覆盖：');
  }
  eq((await s.list({ filter: 'all' })).todos.every((record) => Number.isFinite(record.order)), true);
});

console.log('变更通知');

await test('写操作会通知监听者（面板/日志将来接这里）', async () => {
  const s = makeService();
  const seen = [];
  s.onChange((change) => seen.push(change.operation));
  await s.create({ title: 'a' });
  await s.adopt([{ content: 'b', status: 'pending' }]);
  eq(seen, ['create', 'adopt']);
});

await test('外部变更（domain/changed）经 notifyStoreChange 广播给监听者', async () => {
  // 审计 F7：store.onChanged 与 service.onChange 原来都是死代码，
  // 宿主现在把存储层事件经这个方法转给服务监听者（面板刷新 / health 计数）。
  const s = makeService();
  const seen = [];
  s.onChange((change) => seen.push(change.operation));
  s.notifyStoreChange({ operation: 'external-write' });
  eq(seen, ['external-write']);
  const unsubscribe = s.onChange(() => { throw new Error('不该被调用'); });
  unsubscribe();
  s.notifyStoreChange({ operation: 'external-write-2' });
  eq(seen, ['external-write', 'external-write-2'], '注销后不该再收到：');
});

console.log('存储故障');

await test('存储读失败时不抛，返回 store-unreadable', async () => {
  const s = createWorkTodoService({
    store: {
      kind: 'file',
      location: '/tmp/x.json',
      load: async () => { throw new Error('磁盘炸了'); },
      put: async () => {},
      remove: async () => {},
    },
    clock: () => NOW,
    logger: { warn() {}, info() {} },
  });
  const list = await s.list({});
  eq(list.ok, false);
  eq(list.reason, 'store-unreadable');
  eq(list.message.includes('磁盘炸了'), true, '原因要原样带上：');
});

await test('存储写失败时不抛，返回 store-write-failed', async () => {
  const s = createWorkTodoService({
    store: {
      kind: 'file',
      location: '/tmp/x.json',
      load: async () => [],
      put: async () => { throw new Error('只读文件系统'); },
      remove: async () => {},
    },
    clock: () => NOW,
    logger: { warn() {}, info() {} },
  });
  const created = await s.create({ title: 'a' });
  eq(created.ok, false);
  eq(created.reason, 'store-write-failed');
});

console.log('子待办与备注');

await test('新增带 subtasks/notes：/list 原样带回（含独立 id、order、备注换行）', async () => {
  const s = makeService();
  const created = await s.create({
    title: '整理评审意见',
    notes: '第一行\n第二行',
    subtasks: [
      { title: '整理会议记录', done: true },
      { title: '汇总争议', done: false },
    ],
  });
  eq(created.ok, true);
  eq(created.todo.notes, '第一行\n第二行');
  eq(created.todo.subtasks.map((item) => item.title), ['整理会议记录', '汇总争议']);
  eq(created.todo.subtasks.map((item) => item.order), [0, 1]);
  eq(created.todo.subtasks.every((item) => typeof item.id === 'string' && item.id.length > 0), true,
    '每条子待办必须有独立 id：');
  eq(new Set(created.todo.subtasks.map((item) => item.id)).size, 2);

  const list = await s.list({ filter: 'open', shapes: 'todos' });
  eq(list.todos[0].notes, '第一行\n第二行');
  eq(list.todos[0].subtasks.length, 2);
});

await test('update：子待办增 / 改 / 删 / 排序，备注可改可清空', async () => {
  const s = makeService();
  const created = await s.create({ title: '清单', subtasks: [{ id: 'a', title: '一' }, { id: 'b', title: '二' }] });
  const id = created.todo.id;

  const added = await s.update(id, {
    subtasks: [
      { id: 'a', title: '一', done: true, order: 0 },
      { id: 'b', title: '二改', done: false, order: 1 },
      { id: 'c', title: '三', done: false, order: 2 },
    ],
    notes: '新备注',
  });
  eq(added.ok, true);
  eq(added.todo.subtasks.map((item) => item.title), ['一', '二改', '三']);
  eq(added.todo.notes, '新备注');

  const reordered = await s.update(id, {
    subtasks: [
      { id: 'c', title: '三', done: false, order: 0 },
      { id: 'a', title: '一', done: true, order: 1 },
    ],
  });
  eq(reordered.todo.subtasks.map((item) => item.id), ['c', 'a'], '删掉 b 并按 order 重排：');
  eq(reordered.todo.subtasks.map((item) => item.order), [0, 1]);
  eq((await s.list({ filter: 'open', shapes: 'todos' })).todos[0].subtasks.length, 2, '必须真的落盘：');

  const cleared = await s.update(id, { notes: null });
  eq(cleared.todo.notes, null);
});

await test('联动：勾父项 → 子项全 done；取消父项 → 只取消父项；勾完最后一个子项不自动完成父项', async () => {
  const s = makeService();
  const created = await s.create({
    title: '父项',
    subtasks: [{ id: 'a', title: '一' }, { id: 'b', title: '二' }],
  });
  const id = created.todo.id;

  const done = await s.toggle(id);
  eq(done.todo.status, 'completed');
  eq(done.todo.subtasks.map((item) => item.done), [true, true], '勾父项必须级联：');

  const reopened = await s.toggle(id);
  eq(reopened.todo.status, 'pending');
  eq(reopened.todo.subtasks.map((item) => item.done), [true, true], '取消父项不能回滚子项：');

  const parent = await s.create({
    title: '另一个父项',
    subtasks: [{ id: 'c', title: '一' }, { id: 'd', title: '二' }],
  });
  const lastSub = await s.update(parent.todo.id, {
    subtasks: [
      { id: 'c', title: '一', done: true },
      { id: 'd', title: '二', done: true },
    ],
  });
  eq(lastSub.todo.status, 'pending', '勾完最后一个子项，父项必须仍未完成：');
});

await test('非法 subtasks/notes 整批拒绝：200 语义 + 记录一个字节都不变', async () => {
  const store = fakeStore();
  const s = createWorkTodoService({ store, clock: () => NOW, logger: { warn() {}, info() {} } });
  const created = await s.create({
    title: '校验基准',
    notes: '原备注',
    subtasks: [{ id: 'a', title: '一', done: false, order: 0 }],
  });
  const id = created.todo.id;
  const before = JSON.stringify(store.map.get(id));

  const cases = [
    [{ subtasks: '不是数组' }, 'bad-subtasks'],
    [{ subtasks: Array.from({ length: 51 }, (_, i) => ({ title: `第 ${i} 条` })) }, 'subtasks-too-many'],
    [{ subtasks: [null] }, 'bad-subtask'],
    [{ subtasks: [{ title: '   ' }] }, 'empty-subtask-title'],
    [{ subtasks: [{ title: 'x'.repeat(201) }] }, 'subtask-title-too-long'],
    [{ subtasks: [{ title: 'ok', done: 1 }] }, 'bad-subtask-done'],
    [{ subtasks: [{ title: 'ok', order: '先' }] }, 'bad-subtask-order'],
    [{ notes: 42 }, 'bad-notes'],
    [{ notes: 'x'.repeat(4001) }, 'notes-too-long'],
  ];
  for (const [patch, reason] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const failed = await s.update(id, patch);
    eq(failed.ok, false, `${JSON.stringify(patch).slice(0, 60)} 必须被拒：`);
    eq(failed.reason, reason, `${JSON.stringify(patch).slice(0, 60)} 的原因码：`);
    eq(typeof failed.message, 'string');
    eq(JSON.stringify(store.map.get(id)), before, '被拒的补丁不能写盘（逐字节不变）：');
  }
});

console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error?.stack ?? f.error}`);
  process.exit(1);
}
