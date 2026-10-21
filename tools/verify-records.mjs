/**
 * records.mjs 单元测试（零依赖，直接 node tools/verify-records.mjs）。
 *
 * 覆盖的是「改了就会让面板显示错」的地方：日期归一化、完成时间维护、
 * 引用解析（id / 标题 / 前缀 / 歧义）、分组边界（本周日 vs 下周一）、统计口径。
 * 时间一律注入固定基准，避免测试在午夜或跨周时随机变红。
 */
import {
  NOTES_MAX,
  PRIORITIES,
  PROJECT_LIST_LIMIT,
  STATUSES,
  SUBTASK_MAX,
  SUBTASK_TITLE_MAX,
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
  listProjects,
  normalizeDue,
  normalizeNotes,
  normalizePriority,
  normalizeStatus,
  normalizeSubtasks,
  patchRecord,
  resolveRef,
  sortForView,
  statsOf,
  subtaskProgress,
  weekStartKey,
} from '../src/records.mjs';
import { MISSING_TITLE_PLACEHOLDER, repairRecord, repairStoreDocument } from '../src/schema.mjs';

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

import { parseNaturalDue } from '../src/parse-due.mjs';

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

test('优先级接受高中低无与 p0/p1/p2（无＝不设优先级，也是新建默认）', () => {
  eq(normalizePriority('高'), 'high');
  eq(normalizePriority('P0'), 'high');
  eq(normalizePriority('medium'), 'normal');
  eq(PRIORITIES.length, 4); // 高/中/低/无
  eq(normalizePriority('无'), 'none');
  eq(normalizePriority('none'), 'none');
  eq(normalizePriority('不设'), 'none');
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
  eq(open.priority, 'none', '新建默认「无」：');
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
  mk({ title: '已过期事', due: '2026-10-10', priority: 'high' }, 'a'),
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

test('已完成的已过期事不再算已过期', () => {
  const g = groupRecords(records, NOW);
  eq(g.overdue.some((r) => r.id === 'f'), false);
});

test('分桶：昨天/今天/明天/后天/下个月 → 已过期/今天/明天/本周/以后（明天不再进本周）', () => {
  const five = [
    mk({ title: '昨天', due: '2026-10-13' }, 'y'),
    mk({ title: '今天', due: TODAY }, 't'),
    mk({ title: '明天', due: '2026-10-15' }, 'm'),
    mk({ title: '后天', due: '2026-10-16' }, 'a'),
    mk({ title: '下个月', due: '2026-11-20' }, 'n'),
  ];
  const g = groupRecords(five, NOW);
  eq(g.overdue.map((r) => r.id), ['y'], '昨天 ');
  eq(g.today.map((r) => r.id), ['t'], '今天 ');
  eq(g.tomorrow.map((r) => r.id), ['m'], '明天 ');
  eq(g.week.map((r) => r.id), ['a'], '后天 ');
  eq(g.later.map((r) => r.id), ['n'], '下个月 ');
  eq(g.week.some((r) => r.id === 'm'), false, '明天不能再出现在本周：');
});

test('明天边界：跨月 / 跨年 / 闰日按本地日历推进', () => {
  // 2026-10-31（周六）→ 明天 11-01，同时是本周日；明天优先，故本周桶为空
  const monthEnd = new Date(2026, 9, 31, 10, 30, 0, 0).getTime();
  const crossMonth = groupRecords([
    mk({ title: '明天', due: '2026-11-01' }, 'cm'),
    mk({ title: '后天', due: '2026-11-02' }, 'cm2'),
  ], monthEnd);
  eq(crossMonth.tomorrow.map((r) => r.id), ['cm'], '跨月明天 ');
  eq(crossMonth.week, [], '11-01 是明天（也正好是本周日），必须进明天桶而不是本周：');

  // 2026-12-31（周四）→ 明天 2027-01-01；2027-01-02 才是本周
  const yearEnd = new Date(2026, 11, 31, 23, 50, 0, 0).getTime();
  const crossYear = groupRecords([
    mk({ title: '明天', due: '2027-01-01' }, 'cy'),
    mk({ title: '后天', due: '2027-01-02' }, 'cy2'),
  ], yearEnd);
  eq(crossYear.tomorrow.map((r) => r.id), ['cy'], '跨年明天 ');
  eq(crossYear.week.map((r) => r.id), ['cy2'], '跨年后天仍在本周：');

  // 2028-02-28（周一，闰年）→ 明天 02-29
  const leap = new Date(2028, 1, 28, 9, 0, 0, 0).getTime();
  const leapDay = groupRecords([mk({ title: '明天', due: '2028-02-29' }, 'leap')], leap);
  eq(leapDay.tomorrow.map((r) => r.id), ['leap'], '闰日明天 ');

  // 非闰年 2027-02-28 → 明天 03-01
  const nonLeap = new Date(2027, 1, 28, 9, 0, 0, 0).getTime();
  const march = groupRecords([mk({ title: '明天', due: '2027-03-01' }, 'nl')], nonLeap);
  eq(march.tomorrow.map((r) => r.id), ['nl'], '非闰年跨月明天 ');
});

test('统计口径：明天单独计数，不再混入今天/已过期', () => {
  const s = statsOf([
    mk({ title: '昨天', due: '2026-10-13' }, 'y'),
    mk({ title: '今天', due: TODAY }, 't'),
    mk({ title: '明天', due: '2026-10-15' }, 'm'),
  ], NOW);
  eq(s.overdue, 1);
  eq(s.today, 1);
  eq(s.tomorrow, 1);
});

test('统计口径：已过期/今天/未完成/今日完成', () => {
  const s = statsOf(records, NOW);
  eq(s.total, 6);
  eq(s.open, 5);
  eq(s.overdue, 1);
  eq(s.today, 1);
  eq(s.tomorrow, 0);
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

console.log('已知项目清单（面板第二行的「项目」选择器）');

test('listProjects：空清单 / 去重 / 忽略空值与脏数据，且不凭空造项目', () => {
  eq(listProjects([]), { projects: [], truncated: false }, '空清单：');
  eq(
    listProjects([mk({ title: '无项目' }, 'n1'), mk({ title: '空串', project: '' }, 'n2'), mk({ title: '空白', project: '   ' }, 'n3')]),
    { projects: [], truncated: false },
    '未归类不是项目：',
  );
  // 非文本 / null 记录只跳过自己，不能抛
  eq(listProjects([{ id: 'x', project: 42 }, { id: 'y', project: 'dev' }, null]).projects, ['dev']);
  eq(listProjects(undefined).projects, [], '非数组输入也不能抛：');
  // B3：项目名**原样返回**（不 trim）——与 groupByProject 的桶名、与 /list?project= 的过滤同一口径。
  // 选择器给什么值，过滤就用什么值命中；这里若 trim，手改数据里的 ' beta ' 会显示成 beta 却 0 条命中。
  // 注意：mk() 走 createRecord → normalizeProject 会 trim，所以这里必须直接造**原始记录**
  //（带空白的项目名只有直改存储 / 迁移才可能出现）。
  const raw = { id: 'w1', title: 'x', project: ' beta ' };
  eq(listProjects([raw]).projects, [' beta '], '清单必须原样给出存储里的项目名：');
  eq(groupByProject([raw]).map((b) => b.project), [' beta '], '清单名与「按项目」桶名必须是同一个字符串：');
});

test('listProjects：忽略全空白名（未归类），但保留带首尾空白的真实项目名', () => {
  const rows = [
    { id: 's1', title: 'a', project: '   ' },
    { id: 's2', title: 'b', project: '\t' },
    { id: 's3', title: 'c', project: ' beta ' },
    { id: 's4', title: 'd', project: 'dev' },
    { id: 's5', title: 'e', project: 'dev' },
  ];
  eq(listProjects(rows), { projects: ['dev', ' beta '], truncated: false },
    '全空白跳过；出现次数降序（dev×2 > " beta "×1）：');
});

test('listProjects：出现次数降序 → 次数相同按名称升序（不是纯字典序）', () => {
  const rows = [
    mk({ title: 'z1', project: 'zeta' }, 'r1'),
    mk({ title: 'a1', project: 'alpha' }, 'r2'),
    mk({ title: 'b1', project: 'beta' }, 'r3'),
    mk({ title: 'z2', project: 'zeta' }, 'r4'),
    mk({ title: 'z3', project: 'zeta' }, 'r5'),
    mk({ title: 'b2', project: 'beta' }, 'r6'),
  ];
  // zeta×3 > beta×2 > alpha×1（纯字典序会得到 alpha, beta, zeta —— 这条正是反向验证的靶子）
  eq(listProjects(rows).projects, ['zeta', 'beta', 'alpha']);
  // 次数相同 → 名称升序
  eq(listProjects([mk({ title: 'b', project: 'beta' }, 't1'), mk({ title: 'a', project: 'alpha' }, 't2')]).projects,
    ['alpha', 'beta']);
});

test('listProjects：超过上限只回前 N 个并置 truncated；恰好等于上限不算截断', () => {
  eq(PROJECT_LIST_LIMIT, 50, '面板选择器的上限（改大改小都要有意识）：');
  const many = Array.from({ length: 60 }, (_, i) => mk({ title: `t${i}`, project: `p${String(i).padStart(2, '0')}` }, `m${i}`));
  const cut = listProjects(many);
  eq(cut.projects.length, PROJECT_LIST_LIMIT);
  eq(cut.truncated, true);
  eq(cut.projects[0], 'p00', '取前 N 个前要先按同一套规则排序：');
  eq(listProjects(many.slice(0, PROJECT_LIST_LIMIT)).truncated, false, '恰好等于上限不算截断：');
  eq(listProjects(many, 2), { projects: ['p00', 'p01'], truncated: true }, '上限可注入（测试/未来面板用）：');
  eq(listProjects(many, 0), { projects: [], truncated: true });
});

test('listProjects：非法 limit 明确回落默认 50；数字字符串可用；Infinity/负值不能绕过截断', () => {
  const many = Array.from({ length: 60 }, (_, i) => mk({ title: `t${i}`, project: `p${String(i).padStart(2, '0')}` }, `m${i}`));
  // B6：以前 -1 / "2" / NaN 都静默回落 50（字符串数字不认），Infinity 反而绕过截断
  eq(listProjects(many, -1).projects.length, PROJECT_LIST_LIMIT, '负值回落默认：');
  eq(listProjects(many, -1).truncated, true);
  eq(listProjects(many, '2'), { projects: ['p00', 'p01'], truncated: true }, '数字字符串当数字用：');
  eq(listProjects(many, NaN).projects.length, PROJECT_LIST_LIMIT, 'NaN 回落默认：');
  eq(listProjects(many, Infinity).projects.length, PROJECT_LIST_LIMIT, 'Infinity 不能绕过截断：');
  eq(listProjects(many, '乱写').projects.length, PROJECT_LIST_LIMIT, '乱码回落默认：');
  eq(listProjects(many, undefined).projects.length, PROJECT_LIST_LIMIT, '不传 = 默认：');
  eq(listProjects(many, 2.7).projects.length, 2, '小数向下取整：');
  eq(listProjects(many, '2.9').projects.length, 2, '字符串小数同样向下取整：');
});

console.log('持久化校验');

test('缺 title 的记录用占位标题保留（不再静默丢弃），垃圾条目进 dropped', () => {
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
  // 审计 F3：以前 {} / 缺 title 的记录被静默跳过，下一次任何写入就从磁盘上永久消失。
  // 现在给可见的占位标题并保留位置；只有完全不是对象的垃圾条目才被跳过（并通过 dropped 备份）。
  eq(doc.todos.map((t) => t.id), ['ok', 'wt-recovered-2', 'partial']);
  eq(doc.todos[1].title, MISSING_TITLE_PLACEHOLDER, '缺 title 要留占位标题：');
  eq(doc.todos[2].status, 'pending', '未知状态回退到 pending ');
  eq(doc.todos[2].priority, 'none', '缺字段补「无」：');
  eq(doc.todos[2].due, null);
  eq(doc.dropped.map((d) => d.index), [2, 3], '只有非对象条目该被跳过：');
  eq(doc.dropped[0].reason.includes('不是对象'), true);
});

test('缺 id 的记录用文件内位置派生稳定 id（同一条记录不会每次读都换身份）', () => {
  const raw = { version: 1, todos: [{ title: '没有 id 的记录' }] };
  const first = repairStoreDocument(raw).todos[0];
  const second = repairStoreDocument(raw).todos[0];
  eq(first.id, 'wt-recovered-1');
  eq(first.id, second.id, '两次读必须是同一个 id：');
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

test('行文本包含状态框、id、截止与已过期标记', () => {
  const line = formatLine(mk({ title: '已过期事', due: '2026-10-10' }, 'a'), NOW);
  eq(line.includes('[ ]'), true);
  eq(line.includes('a'), true);
  eq(line.includes('已已过期 2026-10-10'), true);
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
    createRecord({ title: 'x', project: 'alpha', due: '2026-10-01' }, { now, id: 'x' }),      // 已过期
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

// ---- 子待办（subtasks）与备注（notes）：数据、上限、联动、读盘修复 ----

test('老记录缺 subtasks / notes → 默认 [] / null；新建记录也带这两个字段', () => {
  const record = createRecord({ title: '老样子' }, { now: NOW });
  eq(record.subtasks, []);
  eq(record.notes, null);
  const repaired = repairRecord({ id: 'old-1', title: '旧版记录', status: 'pending' });
  eq(repaired.subtasks, [], '老记录没有 subtasks 时补空数组：');
  eq(repaired.notes, null, '老记录没有 notes 时补 null：');
});

test('子待办：只有 title/done/order/id，按 order 稳定排序并重编号；id 缺失/重复自动补且唯一', () => {
  const list = normalizeSubtasks([
    { id: 'a', title: '  第二条  ', done: false, order: 5, due: '2026-01-01', project: 'x' },
    { title: '第一条', done: true, order: 1 },
    { id: 'a', title: '第三条' },
  ]);
  eq(list.map((item) => item.title), ['第一条', '第三条', '第二条'], '按 order 排（缺省 order 用数组下标）：');
  eq(list.map((item) => item.order), [0, 1, 2], 'order 重编号为 0..n-1：');
  eq(list.map((item) => item.done), [true, false, false], 'done 缺省补 false：');
  eq(list.every((item) => Object.keys(item).sort().join(',') === 'done,id,order,title'), true,
    '只保留 id/title/done/order（子项不许有自己的日期/项目）：');
  eq(new Set(list.map((item) => item.id)).size, 3, 'id 必须唯一：');
  eq(list.filter((item) => item.id === 'a').length, 1, '重复 id 只保留第一个：');
  eq(list[1].id !== 'a', true, '重复 id 必须换成新的独立 id：');
});

test('子待办上限 50；第 51 条、非数组、坏项 / 空标题 / 超长 / 非布尔 done / 非数字 order 全部整批拒绝', () => {
  const many = Array.from({ length: SUBTASK_MAX }, (_, i) => ({ id: `s${i}`, title: `条目 ${i}`, done: false }));
  eq(normalizeSubtasks(many).length, SUBTASK_MAX);
  throwsWith(() => normalizeSubtasks([...many, { title: '第 51 条' }]), 'subtasks-too-many');
  throwsWith(() => normalizeSubtasks({ title: '不是数组' }), 'bad-subtasks');
  throwsWith(() => normalizeSubtasks([null]), 'bad-subtask');
  throwsWith(() => normalizeSubtasks([{ title: '   ' }]), 'empty-subtask-title');
  throwsWith(() => normalizeSubtasks([{ title: 'x'.repeat(SUBTASK_TITLE_MAX + 1) }]), 'subtask-title-too-long');
  throwsWith(() => normalizeSubtasks([{ title: 'ok', done: 'yes' }]), 'bad-subtask-done');
  throwsWith(() => normalizeSubtasks([{ title: 'ok', order: '第一' }]), 'bad-subtask-order');
});

test('备注：null/空串 = 没有备注；保留内部换行；4000 字可写、4001 明确报错（不截断）', () => {
  eq(normalizeNotes(null), null);
  eq(normalizeNotes('   '), null);
  eq(normalizeNotes('第一行\n第二行').includes('\n'), true, '内部换行必须保留：');
  eq(normalizeNotes('x'.repeat(NOTES_MAX)).length, NOTES_MAX);
  throwsWith(() => normalizeNotes('x'.repeat(NOTES_MAX + 1)), 'notes-too-long');
  throwsWith(() => normalizeNotes(42), 'bad-notes');
  eq(NOTES_MAX, 4000, '备注上限按用户拍板是 4000：');
});

test('patchRecord：subtasks/notes 可整组替换、null 清空；未给出的字段不动', () => {
  const base = createRecord({
    title: '目标',
    notes: '第一版',
    subtasks: [{ id: 'a', title: '第一步', done: true }, { id: 'b', title: '第二步' }],
  }, { now: NOW });
  const updated = patchRecord(base, {
    notes: '第二版\n第二行',
    subtasks: [{ id: 'b', title: '第二步', done: true, order: 0 }, { id: 'a', title: '第一步', done: true, order: 1 }],
  }, NOW + 1);
  eq(updated.notes, '第二版\n第二行');
  eq(updated.subtasks.map((item) => item.id), ['b', 'a'], '整组替换并按 order 落位：');
  eq(updated.subtasks.map((item) => item.order), [0, 1]);
  eq(updated.title, '目标', '未给出的标题不动：');
  const cleared = patchRecord(updated, { notes: null, subtasks: null }, NOW + 2);
  eq(cleared.notes, null);
  eq(cleared.subtasks, []);
});

test('联动：勾父项（status=completed）→ 子项全部完成；取消父项 → 只取消父项；只改子项不自动完成父项', () => {
  const base = createRecord({
    title: '父项',
    subtasks: [{ id: 'a', title: '一', done: false }, { id: 'b', title: '二', done: true }],
  }, { now: NOW });
  const completed = patchRecord(base, { status: 'completed' }, NOW + 1);
  eq(completed.subtasks.map((item) => item.done), [true, true], '勾父项必须级联勾子项：');
  const reopened = patchRecord(completed, { status: 'pending' }, NOW + 2);
  eq(reopened.subtasks.map((item) => item.done), [true, true], '取消父项不能回滚子项：');
  const allSubsDone = patchRecord(base, {
    subtasks: base.subtasks.map((item) => ({ ...item, done: true })),
  }, NOW + 3);
  eq(allSubsDone.status, 'pending', '勾完子项不自动完成父项：');
  eq(subtaskProgress(allSubsDone), { total: 2, done: 2, allDone: true });
  eq(subtaskProgress(base), { total: 2, done: 1, allDone: false });
  eq(subtaskProgress({}), { total: 0, done: 0, allDone: false }, '空清单不算全部完成：');
});

test('读盘修复：坏 subtasks 只丢坏项/截断，不丢整条记录；notes 超长不静默截断', () => {
  const repaired = repairRecord({
    id: 'bad-1',
    title: '坏数据也要留下',
    notes: 42,
    subtasks: '不是数组',
  });
  eq(repaired.title, '坏数据也要留下');
  eq(repaired.subtasks, []);
  eq(repaired.notes, null);

  const items = [
    null,
    { id: 'a', title: '保留', done: 'yes', order: 'x' },
    { title: '   ' },
    { id: 'a', title: '  重复 id  ', done: true, order: 2 },
    { id: 'b', title: 'x'.repeat(SUBTASK_TITLE_MAX + 20) },
  ];
  const many = Array.from({ length: SUBTASK_MAX + 5 }, (_, i) => ({ id: `m${i}`, title: `条目 ${i}`, order: i }));
  const badOnly = repairRecord({ id: 'bad-2a', title: '只修坏项', subtasks: items });
  eq(badOnly.subtasks[0].title, '保留');
  eq(badOnly.subtasks[0].done, false, '非 true 的 done 一律当 false：');
  eq(badOnly.subtasks[0].order, 0, '非法 order 用数组下标后再重排序：');
  eq(new Set(badOnly.subtasks.map((item) => item.id)).size, badOnly.subtasks.length, '修复后 id 仍唯一：');
  eq(badOnly.subtasks.every((item) => item.title.length <= SUBTASK_TITLE_MAX), true, '读盘超长标题截断到上限：');
  eq(badOnly.subtasks.some((item) => item.title === ''), false, '空标题项丢弃：');

  const merged = repairRecord({ id: 'bad-2', title: '修复', subtasks: [...items, ...many] });
  eq(merged.subtasks.length, SUBTASK_MAX, '超过 50 条只保留前 50 条（不丢整条记录）：');

  const longNotes = 'x'.repeat(NOTES_MAX + 50);
  const kept = repairRecord({ id: 'bad-3', title: '长备注', notes: longNotes });
  eq(kept.notes.length, NOTES_MAX + 50, '读盘不截断备注（不静默丢用户文字）：');

  const doc = repairStoreDocument({
    todos: [
      { id: 'keep', title: '坏字段但可读', subtasks: [null, { title: '好项' }] },
      { title: '缺 id 也保留', subtasks: 'bad' },
    ],
  });
  eq(doc.todos.length, 2, '坏 subtasks 绝不能导致整条记录被丢：');
  eq(doc.todos[0].subtasks.map((item) => item.title), ['好项']);
  eq(doc.todos[1].subtasks, []);
});

// ---- 自然语言日期解析（人类面板与 worktodo_* 工具共用同一份） ----

test('parseNaturalDue：认日期/时间，并把认出来的词从标题里摘掉', () => {
  const now = Date.parse('2026-10-12T10:00:00+08:00'); // 2026-10-12 是周一
  const table = [
    // 输入, 期望标题, 期望 due, 期望 dueTime
    ['交周报 明天下午3点', '交周报', '2026-10-13', '15:00'],
    ['买菜 明天', '买菜', '2026-10-13', null],
    ['等对方回复报价', '等对方回复报价', null, null],
    ['给客户回电话 15:00', '给客户回电话', '2026-10-12', '15:00'],
    ['下午3点半 开会', '开会', '2026-10-12', '15:30'],
    ['买菜 后天', '买菜', '2026-10-14', null],
    ['开评审会 下周一上午10点', '开评审会', '2026-10-19', '10:00'],
    ['周一例会改到周三', '周一例会改到', '2026-10-14', null],
    ['周1 对齐进度', '对齐进度', '2026-10-12', null],
    ['10月20日 交材料', '交材料', '2026-10-20', null],
    ['2026-11-01 交报告', '交报告', '2026-11-01', null],
    ['3天后 回访客户', '回访客户', '2026-10-15', null],
    ['+3d 复诊', '复诊', '2026-10-15', null],
    ['今晚 跟客户吃饭', '跟客户吃饭', '2026-10-12', '20:00'],
    // 保守性：普通数字不能被当成日期（宁可漏，不可误吞）
    ['买3个苹果', '买3个苹果', null, null],
    ['发 2 封邮件', '发 2 封邮件', null, null],
  ];
  for (const [input, title, due, dueTime] of table) {
    const r = parseNaturalDue(input, now);
    eq(r.title, title, `标题（"${input}"）：`);
    eq(r.due, due, `日期（"${input}"）：`);
    eq(r.dueTime, dueTime, `时间（"${input}"）：`);
  }
  // 摘掉的词要能追溯到原文片段（面板据此显示"从标题识别"）
  eq(parseNaturalDue('交周报 明天下午3点', now).matched, ['明天', '下午', '3点']);
});

console.log(`\n${passed} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error?.stack ?? f.error}`);
  process.exit(1);
}
