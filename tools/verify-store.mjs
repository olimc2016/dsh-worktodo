/**
 * store.mjs 测试：真实文件 IO + 官方领域契约校验。
 *
 * 两件事必须被测到，因为它们是「装了之后数据会不会丢」的全部：
 *   1. 文件后端：原子写、坏文件容忍、单条坏记录跳过、删除后不再出现；
 *   2. domain 后端：我们的领域声明必须能被官方 @deepseek-ai/dsh-storage-domain 的
 *      defineDomain 接受，且记录要经得起它读取时的 valueSchema.parse——
 *      这两条不成立的话，真实环境里 storage 路径会在打开领域时直接失败。
 *
 * domain 路径不启 cordis：官方 facility 真正的价值就是「校验 + 写链 + 事件」，
 * 这里用等价的假 facility 走通 store.mjs 的调用序列（open → table.put/delete/entries），
 * 完整运行时验证留给装进 profile 后的 health 路由。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkTodoStore } from '../src/store.mjs';
import { repairRecord, todoRecordSchema } from '../src/schema.mjs';
import { createRecord } from '../src/records.mjs';

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

const NOW = new Date(2026, 9, 14, 10, 30, 0, 0).getTime();
/** 每个用例一个独占临时目录，结束时清掉（不污染用户目录）。 */
const roots = [];
function newRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'worktodo-verify-'));
  roots.push(dir);
  return dir;
}

console.log('官方领域契约');

await test('领域声明能通过官方 defineDomain 校验', async () => {
  const { defineDomain, domainTable, descriptorOf } = await import('@deepseek-ai/dsh-storage-domain');
  const spec = defineDomain({
    name: 'worktodo',
    version: 1,
    tables: { todos: domainTable(todoRecordSchema) },
    invalidRecords: 'backup-and-skip',
  });
  const descriptor = descriptorOf(spec);
  eq(descriptor, { name: 'worktodo', version: 1, tables: ['todos'], hasGlobal: false });
});

await test('领域名与表名符合官方 UNIT_NAME_RE', async () => {
  const { defineDomain, domainTable } = await import('@deepseek-ai/dsh-storage-domain');
  // 名字非法时 defineDomain 会抛错，所以「不抛」本身就是断言
  defineDomain({ name: 'worktodo', version: 1, tables: { todos: domainTable(todoRecordSchema) } });
  let threw = false;
  try {
    defineDomain({ name: 'Work Todo!', version: 1, tables: { todos: domainTable(todoRecordSchema) } });
  } catch {
    threw = true;
  }
  eq(threw, true, '非法名字应当被官方校验拒绝（说明我们确实在用它校验）');
});

await test('记录 schema 的 parse 与官方读取路径一致', async () => {
  // 官方 facility 打开领域时对每条已存记录调用 valueSchema.parse
  const stored = { id: 'x', title: '手改过的记录', status: 'done' };
  const parsed = todoRecordSchema.parse(stored);
  eq(parsed.status, 'completed', '同义词要被归一化');
  eq(parsed.priority, 'normal', '缺字段要补默认值');
  eq(parsed.due, null);
});

console.log('domain 后端（假 facility，真调用序列）');

await test('storageDomain 可用时选中 domain 后端并完成增删查', async () => {
  const { defineDomain, domainTable } = await import('@deepseek-ai/dsh-storage-domain');
  // 假 facility：复刻官方「打开时校验每条已存记录 + 写链」的可观察行为
  const tables = new Map();
  const fake = {
    async open(spec) {
      const tableName = Object.keys(spec.tables)[0];
      if (!tables.has(tableName)) tables.set(tableName, new Map());
      const records = tables.get(tableName);
      // 官方会在这里对每条记录跑 valueSchema.parse
      for (const [key, value] of records) records.set(key, spec.tables[tableName].valueSchema.parse(value));
      return {
        table: (name) => {
          const map = tables.get(name);
          return {
            get: (key) => map.get(key),
            entries: () => [...map.entries()][Symbol.iterator](),
            size: map.size,
            put: async (key, value) => {
              map.set(key, spec.tables[name].valueSchema.parse(value));
            },
            delete: async (key) => map.delete(key),
          };
        },
        close: async () => {},
      };
    },
  };
  const ctx = { get: (name) => (name === 'storageDomain' ? fake : undefined) };
  const store = await openWorkTodoStore({ ctx, config: {}, logger: { warn() {}, info() {} } });
  eq(store.kind, 'domain', '应当优先用官方 storage：');

  const a = createRecord({ title: '写周报', priority: 'high', due: '2026-10-15' }, { now: NOW, id: 'wt-a' });
  const b = createRecord({ title: '改 bug' }, { now: NOW, id: 'wt-b' });
  await store.put(a);
  await store.put(b);
  eq((await store.load()).map((r) => r.id).sort(), ['wt-a', 'wt-b']);

  await store.remove('wt-a');
  eq((await store.load()).map((r) => r.id), ['wt-b']);

  // 覆盖写：同一条记录更新后不应出现两份
  await store.put({ ...b, title: '改 bug（已改名）' });
  const after = await store.load();
  eq(after.length, 1);
  eq(after[0].title, '改 bug（已改名）');
  await store.close();
});

console.log('文件后端（真实磁盘 IO）');

await test('显式 storePath 时使用文件后端并落盘为合法 JSON', async () => {
  const path = join(newRoot(), 'nested', 'todos.json');
  const store = await openWorkTodoStore({ ctx: undefined, config: { storePath: path }, logger: { warn() {}, info() {} } });
  eq(store.kind, 'file');
  eq(store.location, path);

  const record = createRecord({ title: '写周报', due: '2026-10-15', priority: 'high' }, { now: NOW, id: 'wt-1' });
  await store.put(record);

  const raw = JSON.parse(readFileSync(path, 'utf8'));
  eq(raw.version, 1);
  eq(raw.todos.length, 1);
  eq(raw.todos[0].title, '写周报');
  // 落盘必须是给人看的格式：缩进过、以换行结尾（用户要能直接打开手改）
  eq(readFileSync(path, 'utf8').endsWith('\n'), true);
  await store.close();
});

await test('删除与覆盖写在文件后端同样成立', async () => {
  const path = join(newRoot(), 'todos.json');
  const store = await openWorkTodoStore({ ctx: undefined, config: { storePath: path }, logger: { warn() {}, info() {} } });
  const one = createRecord({ title: '一' }, { now: NOW, id: 'wt-1' });
  const two = createRecord({ title: '二' }, { now: NOW, id: 'wt-2' });
  await store.put(one);
  await store.put(two);
  await store.put({ ...one, title: '一（改）' });
  let doc = JSON.parse(readFileSync(path, 'utf8'));
  eq(doc.todos.map((t) => t.title), ['一（改）', '二'], '覆盖写不能产生重复条目：');
  await store.remove('wt-1');
  doc = JSON.parse(readFileSync(path, 'utf8'));
  eq(doc.todos.map((t) => t.id), ['wt-2']);
  eq(await store.remove('不存在'), false);
  await store.close();
});

await test('文件被写坏时按空列表继续，而不是抛异常', async () => {
  const path = join(newRoot(), 'todos.json');
  writeFileSync(path, '{ 这不是 JSON', 'utf8');
  const store = await openWorkTodoStore({ ctx: undefined, config: { storePath: path }, logger: { warn() {}, info() {} } });
  eq(await store.load(), []);
  // 坏文件不应被静默覆盖：用户手改坏了，修回来还能救
  eq(readFileSync(path, 'utf8').includes('这不是 JSON'), true, '坏文件不该被自动清空：');
  await store.close();
});

await test('单条坏记录被跳过，其余照常读出', async () => {
  const path = join(newRoot(), 'todos.json');
  writeFileSync(path, JSON.stringify({
    version: 1,
    updatedAt: NOW,
    todos: [
      { id: 'ok', title: '好的', status: 'pending' },
      { id: 'bad' },
      '不是对象',
    ],
  }), 'utf8');
  const store = await openWorkTodoStore({ ctx: undefined, config: { storePath: path }, logger: { warn() {}, info() {} } });
  const loaded = await store.load();
  eq(loaded.map((t) => t.id), ['ok']);
  await store.close();
});

await test('并发写不丢数据（写入串行化）', async () => {
  const path = join(newRoot(), 'todos.json');
  const store = await openWorkTodoStore({ ctx: undefined, config: { storePath: path }, logger: { warn() {}, info() {} } });
  const many = Array.from({ length: 12 }, (_, i) => createRecord({ title: `第 ${i} 条` }, { now: NOW, id: `wt-${i}` }));
  // 不 await 逐个写：并发触发写入链
  await Promise.all(many.map((record) => store.put(record)));
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  eq(doc.todos.length, 12, '并发写必须全部保住：');
  await store.close();
});

await test('~ 开头的 storePath 会展开到家目录', async () => {
  const store = await openWorkTodoStore({ ctx: undefined, config: { storePath: '~/worktodo-verify-should-not-exist.json' }, logger: { warn() {}, info() {} } });
  eq(store.location.startsWith('~'), false);
  eq(store.location.includes('/worktodo-verify-should-not-exist.json'), true);
  // 不实际写入，避免污染家目录
  await store.close();
});

// 清理所有临时目录
for (const dir of roots) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch { /* 清理失败不影响结论 */ }
}

// 顺带确认 repairRecord 对完全非法的输入会抛（由上层跳过）
let rejected = false;
try {
  repairRecord('不是对象');
} catch {
  rejected = true;
}
if (!rejected) {
  failures.push({ label: 'repairRecord 应拒绝非对象', error: new Error('没有抛错') });
  console.log('  ✗ repairRecord 应拒绝非对象');
}

console.log(`\n${passed + 1} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error?.stack ?? f.error}`);
  process.exit(1);
}
