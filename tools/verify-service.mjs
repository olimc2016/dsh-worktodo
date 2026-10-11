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
  await s.create({ title: '逾期', due: '2026-10-10' });
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
  await s.create({ title: '逾期', due: '2026-10-10' });
  await s.create({ title: '今天', due: 'today' });
  await s.create({ title: '无期' });
  const view = await s.list({ filter: 'open' });
  eq(view.groups.overdue.map((t) => t.title), ['逾期']);
  eq(view.groups.today.map((t) => t.title), ['今天']);
  eq(view.groups.later.map((t) => t.title), ['无期']);
  eq(view.today, '2026-10-14');
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

console.log('变更通知');

await test('写操作会通知监听者（面板/日志将来接这里）', async () => {
  const s = makeService();
  const seen = [];
  s.onChange((change) => seen.push(change.operation));
  await s.create({ title: 'a' });
  await s.adopt([{ content: 'b', status: 'pending' }]);
  eq(seen, ['create', 'adopt']);
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

console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error?.stack ?? f.error}`);
  process.exit(1);
}
