/**
 * records.mjs 单元测试（零依赖，直接 node tools/verify-records.mjs）。
 *
 * 覆盖的是「改了就会让面板显示错」的地方：日期归一化、完成时间维护、
 * 引用解析（id / 标题 / 前缀 / 歧义）、分组边界（本周日 vs 下周一）、统计口径。
 * 时间一律注入固定基准，避免测试在午夜或跨周时随机变红。
 */
import {
  PRIORITIES,
  STATUSES,
  WorkTodoError,
  adoptSessionTodos,
  createRecord,
  groupByProject,
  applyManualOrder,
  dayKey,
  dayStart,
  filterRecords,
  formatLine,
  groupRecords,
  normalizeDue,
  normalizePriority,
  normalizeStatus,
  patchRecord,
  resolveRef,
  sortForView,
  statsOf,
  weekStartKey,
} from '../src/records.mjs';
import { repairRecord, repairStoreDocument } from '../src/schema.mjs';

let passed = 0;
const failures = [];

/**
 * @param {string} label 用例名
 * @param {() => void} run 断言体
 */
function test(label, run) {
  try {
    run();
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

/**
 * @param {() => unknown} run
 * @param {string} reason 期望的失败原因码
 */
function throwsWith(run, reason) {
  try {
    run();
  } catch (error) {
    if (error instanceof WorkTodoError && error.reason === reason) return;
    throw new Error(`期望 reason=${reason}，实际 ${error?.reason ?? error?.message ?? error}`);
  }
  throw new Error(`期望抛出 ${reason}，但没有抛`);
}

// 固定基准：2026-10-14 是周三，本地时间 10:30
const NOW = new Date(2026, 9, 14, 10, 30, 0, 0).getTime();
const TODAY = '2026-10-14';

/** 造一条测试记录：id 走 options（createRecord 的 id 是内部参数，不接受用户输入）。 */
const mk = (input, id) => createRecord(input, { now: NOW, id });

console.log('日期工具');

test('dayKey 用本地时区而不是 UTC', () => {
  // 本地 00:30 的 UTC 日期在前一天（东八区），必须是本地日期
  const t = new Date(2026, 9, 14, 0, 30, 0).getTime();
  eq(dayKey(t), '2026-10-14');
});

test('weekStartKey 以周一为一周之始', () => {
  // 2026-10-14 是周三 → 本周一 2026-10-12；周日 2026-10-18 仍属于本周
  eq(weekStartKey(NOW), '2026-10-12');
  eq(weekStartKey(new Date(2026, 9, 18, 23, 0, 0).getTime()), '2026-10-12');
  eq(weekStartKey(new Date(2026, 9, 19, 1, 0, 0).getTime()), '2026-10-19');
});

test('dayStart 挡掉不存在的日期', () => {
  eq(Number.isNaN(dayStart('2026-02-31')), true, '2 月 31 日 ');
  eq(dayStart('2026-02-28') > 0, true);
});

console.log('归一化');

test('标题去空白且不能为空', () => {
  eq(createRecord({ title: '  写周报  ' }, { now: NOW }).title, '写周报');
  throwsWith(() => createRecord({ title: '   ' }, { now: NOW }), 'empty-title');
});

test('状态接受同义词并落回三态', () => {
  eq(normalizeStatus('doing'), 'in_progress');
  eq(normalizeStatus('DONE'), 'completed');
  eq(normalizeStatus('in-progress'), 'in_progress');
  eq(STATUSES.includes(normalizeStatus('pending')), true);
  throwsWith(() => normalizeStatus('finished-ish'), 'bad-status');
});

test('优先级接受高中低与 p0/p1/p2', () => {
  eq(normalizePriority('高'), 'high');
  eq(normalizePriority('P0'), 'high');
  eq(normalizePriority('medium'), 'normal');
  eq(PRIORITIES.length, 3);
  throwsWith(() => normalizePriority('urgent-ish'), 'bad-priority');
});

test('相对日期按注入的基准算', () => {
  eq(normalizeDue('today', NOW), TODAY);
  eq(normalizeDue('明天', NOW), '2026-10-15');
  eq(normalizeDue('+3d', NOW), '2026-10-17');
  eq(normalizeDue('-2d', NOW), '2026-10-12');
  eq(normalizeDue('2026/10/20', NOW), '2026-10-20');
  eq(normalizeDue('2026-10-5', NOW), '2026-10-05');
  eq(normalizeDue('none', NOW), null);
  throwsWith(() => normalizeDue('下周三', NOW), 'bad-due');
  throwsWith(() => normalizeDue('2026-13-01', NOW), 'bad-due');
});

test('创建时完成态会写入 completedAt', () => {
  const open = createRecord({ title: 'a' }, { now: NOW });
  eq(open.completedAt, null);
  eq(open.priority, 'normal');
  eq(open.status, 'pending');
  const done = createRecord({ title: 'b', status: 'completed' }, { now: NOW });
  eq(done.completedAt, NOW);
});

test('打补丁只改给定字段，并维护 completedAt', () => {
  const base = createRecord({ title: 'a', project: 'p1' }, { now: NOW });
  const later = NOW + 60_000;
  const done = patchRecord(base, { status: 'completed' }, later);
  eq(done.completedAt, later);
  eq(done.project, 'p1', '未提及的字段 ');
  eq(done.createdAt, NOW, '创建时间 ');
  eq(done.updatedAt, later);
  // 回到未完成必须清掉完成时间，否则「今日完成」统计会把旧记录算进来
  const reopened = patchRecord(done, { status: 'pending' }, later + 1000);
  eq(reopened.completedAt, null);
  throwsWith(() => patchRecord(base, {}, later), 'empty-patch');
});

console.log('引用解析');

const sample = [
  mk({ title: '写周报' }, 'wt-1'),
  mk({ title: '写发布说明' }, 'wt-2'),
  mk({ title: '改 bug' }, 'wt-3'),
];

test('按 id 命中', () => {
  eq(resolveRef(sample, 'wt-2').title, '写发布说明');
});

test('按完整标题命中（忽略大小写）', () => {
  eq(resolveRef(sample, '改 BUG').id, 'wt-3');
});

test('按唯一前缀命中', () => {
  eq(resolveRef(sample, '改').id, 'wt-3');
});

test('歧义与找不到都给出明确原因', () => {
  throwsWith(() => resolveRef(sample, '写'), 'ambiguous-ref');
  throwsWith(() => resolveRef(sample, '不存在的事'), 'not-found');
  throwsWith(() => resolveRef(sample, '   '), 'missing-ref');
});

console.log('分组与统计');

const records = [
  mk({ title: '逾期事', due: '2026-10-10', priority: 'high' }, 'a'),
  mk({ title: '今天事', due: TODAY }, 'b'),
  mk({ title: '本周事', due: '2026-10-18' }, 'c'),
  mk({ title: '下周事', due: '2026-10-19' }, 'd'),
  mk({ title: '无期事' }, 'e'),
  mk({ title: '做完事', status: 'completed', due: '2026-10-01' }, 'f'),
];

test('分组边界：本周日算本周、下周一算以后、已完成单独一组', () => {
  const g = groupRecords(records, NOW);
  eq(g.overdue.map((r) => r.id), ['a']);
  eq(g.today.map((r) => r.id), ['b']);
  eq(g.week.map((r) => r.id), ['c']);
  eq(g.later.map((r) => r.id), ['d', 'e']);
  eq(g.completed.map((r) => r.id), ['f']);
});

test('已完成的逾期事不再算逾期', () => {
  const g = groupRecords(records, NOW);
  eq(g.overdue.some((r) => r.id === 'f'), false);
});

test('统计口径：逾期/今天/未完成/今日完成', () => {
  const s = statsOf(records, NOW);
  eq(s.total, 6);
  eq(s.open, 5);
  eq(s.overdue, 1);
  eq(s.today, 1);
  eq(s.completed, 1);
  eq(s.completedToday, 1);
});

test('筛选：overdue / today / week / open / completed', () => {
  const ids = (list) => list.map((r) => r.id);
  eq(ids(filterRecords(records, 'overdue', NOW)), ['a']);
  eq(ids(filterRecords(records, 'today', NOW)), ['b']);
  // week 是查询语义：今天起累计到本周日（与面板分组桶不同，见 records.mjs 的注释）
  eq(ids(filterRecords(records, 'week', NOW)), ['b', 'c']);
  eq(ids(filterRecords(records, 'completed', NOW)), ['f']);
  eq(ids(filterRecords(records, 'open', NOW)), ['a', 'b', 'c', 'd', 'e']);
  throwsWith(() => filterRecords(records, '随便', NOW), 'bad-filter');
});

test('排序：高优先级在前，同优先级按截止日期，无日期垫底', () => {
  const ordered = sortForView([
    mk({ title: 'x', due: '2026-10-20' }, 'x'),
    mk({ title: 'y', priority: 'high', due: '2026-10-25' }, 'y'),
    mk({ title: 'z', due: '2026-10-16' }, 'z'),
  ]).map((r) => r.id);
  eq(ordered, ['y', 'z', 'x']);
});

console.log('持久化校验');

test('坏记录被跳过而不是让整个列表读不出来', () => {
  const doc = repairStoreDocument({
    version: 1,
    todos: [
      { id: 'ok', title: '好的', status: 'pending' },
      { title: '' },
      null,
      '不是对象',
      { id: 'partial', title: '缺字段', status: '奇怪的' },
    ],
  });
  eq(doc.todos.map((t) => t.id), ['ok', 'partial']);
  eq(doc.todos[1].status, 'pending', '未知状态回退到 pending ');
  eq(doc.todos[1].priority, 'normal');
  eq(doc.todos[1].due, null);
});

test('手改的记录按同义词归一，真正乱写的日期才丢掉', () => {
  const loose = repairRecord({ id: 'x', title: 'x', due: '2026/10/20', status: 'done', priority: '高' });
  eq(loose.due, '2026-10-20', '斜杠日期要能懂：');
  eq(loose.status, 'completed', 'done 要映射成 completed：');
  eq(loose.priority, 'high', '「高」要映射成 high：');
  const broken = repairRecord({ id: 'y', title: 'y', due: '下周三', status: '莫名其妙' });
  eq(broken.due, null);
  eq(broken.status, 'pending');
});

console.log('会话 todos 提升');

test('提升时按标题去重、忽略空条目', () => {
  const existing = [mk({ title: '已有的事' }, 'existing')];
  const wanted = adoptSessionTodos([
    { content: '已有的事', status: 'pending' },
    { content: '新的事', status: 'in_progress' },
    { content: '   ', status: 'pending' },
    { content: '再一件事', status: 'done' },
  ], existing, NOW);
  eq(wanted.map((w) => w.title), ['新的事', '再一件事']);
  eq(wanted[0].status, 'in_progress');
  eq(wanted[1].status, 'completed', 'done 要映射成 completed ');
  eq(wanted.every((w) => w.source === 'session'), true);
});

console.log('文本渲染');

test('行文本包含状态框、id、截止与逾期标记', () => {
  const line = formatLine(mk({ title: '逾期事', due: '2026-10-10' }, 'a'), NOW);
  eq(line.includes('[ ]'), true);
  eq(line.includes('a'), true);
  eq(line.includes('已逾期 2026-10-10'), true);
});

// ---- 按项目分组（面板的「按项目」视图）----

test('groupByProject：未归类永远排在最后，且 project 为 null', () => {
  const now = Date.parse('2026-10-11T09:00:00+08:00');
  const records = [
    createRecord({ title: 'A', project: 'alpha' }, { now, id: 'a' }),
    createRecord({ title: 'C' }, { now, id: 'c' }),
  ];
  const buckets = groupByProject(records, now);
  eq(buckets.length, 2);
  eq(buckets[0].project, 'alpha');
  eq(buckets[buckets.length - 1].project, null);
  eq(buckets[buckets.length - 1].key, '');
});

test('groupByProject：未完成多的项目排前面', () => {
  const now = Date.parse('2026-10-11T09:00:00+08:00');
  const records = [
    createRecord({ title: 'a1', project: 'alpha' }, { now, id: 'a1' }),
    createRecord({ title: 'a2', project: 'alpha' }, { now, id: 'a2' }),
    createRecord({ title: 'b1', project: 'beta' }, { now, id: 'b1' }),
  ];
  const buckets = groupByProject(records, now);
  eq(buckets.map((b) => b.project), ['alpha', 'beta']);
  eq(buckets[0].open, 2);
  eq(buckets[1].open, 1);
});

test('groupByProject：桶内统计 total/open/overdue，且已完成不计入 open', () => {
  const now = Date.parse('2026-10-11T09:00:00+08:00');
  const records = [
    createRecord({ title: 'x', project: 'alpha', due: '2026-10-01' }, { now, id: 'x' }),      // 逾期
    createRecord({ title: 'y', project: 'alpha' }, { now, id: 'y' }),
    createRecord({ title: 'z', project: 'alpha', status: 'completed' }, { now, id: 'z' }),
  ];
  const [alpha] = groupByProject(records, now);
  eq(alpha.total, 3);
  eq(alpha.open, 2);
  eq(alpha.overdue, 1);
  // 桶内仍是视图排序：未完成在前
  eq(alpha.todos[alpha.todos.length - 1].status, 'completed');
});

test('groupByProject：空输入得到空数组，不凭空造桶', () => {
  eq(groupByProject([], Date.now()), []);
});

// ---- 排序模式与手动顺序 ----

test('sortForView 支持三种模式：priority / created / manual', () => {
  const now = Date.parse('2026-10-12T10:00:00+08:00');
  const a = createRecord({ title: '旧-低', priority: 'low' }, { now, id: 'a' });
  const b = createRecord({ title: '新-高', priority: 'high' }, { now: now + 5000, id: 'b' });
  const c = createRecord({ title: '中-普通', priority: 'normal' }, { now: now + 2000, id: 'c' });
  const records = [a, b, c];
  eq(sortForView(records, 'priority').map((r) => r.title), ['新-高', '中-普通', '旧-低']);
  eq(sortForView(records, 'created').map((r) => r.title), ['新-高', '中-普通', '旧-低']);
  // 默认仍是 priority（老调用点不受影响）
  eq(sortForView(records).map((r) => r.title), ['新-高', '中-普通', '旧-低']);
});

test('applyManualOrder 与 manual 排序：拖过的在前且按 order 升序，没拖过的按自动规则垫后', () => {
  const now = Date.parse('2026-10-12T10:00:00+08:00');
  const a = createRecord({ title: 'A', priority: 'low' }, { now, id: 'a' });
  const b = createRecord({ title: 'B', priority: 'high' }, { now: now + 1000, id: 'b' });
  const c = createRecord({ title: 'C', priority: 'normal' }, { now: now + 2000, id: 'c' });
  const placed = applyManualOrder([a, b, c], ['c', 'a']); // C 第一、A 第二；B 没拖过
  const order = sortForView(placed, 'manual').map((r) => r.title);
  eq(order[0], 'C');
  eq(order[1], 'A');
  eq(order[2], 'B', '没拖过的按自动规则垫后：');
  // 纯函数：不改入参
  eq(a.order, null, 'applyManualOrder 不应修改入参：');
});

console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error?.stack ?? f.error}`);
  process.exit(1);
}
