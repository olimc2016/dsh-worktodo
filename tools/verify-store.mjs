/**
 * store.mjs 测试：真实文件 IO + 官方领域契约校验。
 *
 * 三件事必须被测到，因为它们是「装了之后数据会不会丢」的全部：
 *   1. 文件后端：原子写、坏文件先备份再写、缺 title 的记录用占位标题保留、删除后不再出现；
 *   2. domain 后端：我们的领域声明必须能被官方 @deepseek-ai/dsh-storage-domain 的
 *      defineDomain 接受，且记录要经得起它读取时的 valueSchema.parse；
 *   3. **后端选择**（0.2.0 审计 F1）：storageDomain 晚注册时要能升级并合并两处数据、
 *      open 失败/两处数据不一致时绝不静默、二次挂载不降级也不丢数据。
 *
 * domain 路径不启 cordis：官方 facility 真正的价值就是「校验 + 写链 + 事件」，
 * 这里用等价的假 facility 走通 store.mjs 的调用序列（open → table.put/delete/entries），
 * 完整运行时验证留给装进 profile 后的 health 路由。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkTodoStore, unionById } from '../src/store.mjs';
import { MISSING_TITLE_PLACEHOLDER, repairRecord, todoRecordSchema } from '../src/schema.mjs';
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

const silent = { warn() {}, info() {} };

/** 收集日志的 logger（断言「不静默」用）。 */
function logTo(bucket) {
  return { info: (m) => bucket.push(`info ${m}`), warn: (m) => bucket.push(`warn ${m}`) };
}

/**
 * 把 DSH_HOME 指到临时目录：不传 storePath 时后端选择会读写它，
 * 绝不能碰用户真实的 ~/.dsh（审计前后都踩过一次）。
 * @param {(home: string) => Promise<any>} run
 */
async function withTempHome(run) {
  const previous = process.env.DSH_HOME;
  const home = newRoot();
  process.env.DSH_HOME = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
}

/**
 * 模拟 cordis 服务「晚一步注册」：ctx.get 读的是可变持有者的当前值。
 * @param {object|null} initial
 */
function serviceHolder(initial = null) {
  const holder = { current: initial };
  holder.ctx = {
    get: (name) => (name === 'storageDomain' ? holder.current : undefined),
    on: () => () => {},
  };
  return holder;
}

/**
 * 复刻官方 storage-domain facility 的可观察契约：
 *   - open 时对每条已存记录跑 valueSchema.parse；
 *   - 同名领域第二次 open 抛 `already-open`（官方语义，二次挂载的坑就在这里）；
 *   - table 提供 get/entries/size/put/delete。
 * @param {object[]} [initial]
 */
function makeFakeFacility(initial = []) {
  const records = new Map(initial.map((record) => [record.id, record]));
  const calls = { open: 0, close: 0 };
  /** 测试开关：模拟「domain 突然读不出来」（复审 R1 第 3 条：不能静默换回退役文件）。 */
  const control = { failLoad: false };
  let open = false;
  return {
    records,
    calls,
    control,
    async open(spec) {
      calls.open += 1;
      if (open) throw new Error("domain 'worktodo' is already open");
      open = true;
      const tableName = Object.keys(spec.tables)[0];
      // 官方会在这里对每条记录跑 valueSchema.parse
      for (const [key, value] of records) records.set(key, spec.tables[tableName].valueSchema.parse(value));
      return {
        table: (name) => ({
          get: (key) => records.get(key),
          entries: () => {
            if (control.failLoad) throw new Error('领域读不出来（模拟 domain 不可用）');
            return [...records.entries()][Symbol.iterator]();
          },
          size: records.size,
          put: async (key, value) => {
            records.set(key, spec.tables[name].valueSchema.parse(value));
          },
          delete: async (key) => records.delete(key),
        }),
        close: async () => {
          calls.close += 1;
          open = false;
        },
      };
    },
  };
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
  eq(parsed.priority, 'none', '缺字段要补默认值（无优先级）：');
  eq(parsed.due, null);
});

console.log('domain 后端（假 facility，真调用序列）');

await test('storageDomain 可用时选中 domain 后端并完成增删查', async () => {
  await withTempHome(async () => {
    const facility = makeFakeFacility();
    const store = await openWorkTodoStore({ ctx: serviceHolder(facility).ctx, config: {}, logger: silent });
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
});

console.log('后端选择：可纠正、不静默、合并而不二选一（审计 F1）');

await test('unionById：按 id 取并集，同 id 取 updatedAt 较新者', async () => {
  const older = { id: 'x', title: '旧', updatedAt: 100 };
  const newer = { id: 'x', title: '新', updatedAt: 200 };
  const forward = unionById([older], [newer]);
  eq(forward.todos[0].title, '新', 'incoming 较新时应当覆盖：');
  eq(forward.conflicts, 1);
  eq(forward.added, 0);
  const backward = unionById([newer], [older]);
  eq(backward.todos[0].title, '新', 'preferred 较新时不该被旧数据覆盖：');
  const disjoint = unionById([older], [{ id: 'y', title: '只有另一边有', updatedAt: 1 }]);
  eq(disjoint.todos.length, 2);
  eq(disjoint.added, 1, '并集要把另一处的记录补进来：');
});

await test('storageDomain 晚注册：后续请求升级到 domain，并把两处数据按 id 合并', async () => {
  await withTempHome(async (home) => {
    const logs = [];
    const holder = serviceHolder(null); // 阶段 1：服务还没注册
    const store = await openWorkTodoStore({ ctx: holder.ctx, config: {}, logger: logTo(logs) });
    eq(store.kind, 'file', '服务未注册时先用回退文件：');

    const a = createRecord({ title: '文件里的 A' }, { now: NOW, id: 'wt-file-a' });
    const b = createRecord({ title: '文件里的 B' }, { now: NOW, id: 'wt-file-b' });
    await store.put(a);
    await store.put(b);

    // 阶段 2：服务注册，官方 storage 里预置了一条只有它才有的记录
    holder.current = makeFakeFacility([
      { ...createRecord({ title: '官方里的 C' }, { now: NOW, id: 'wt-dom-c' }), updatedAt: NOW + 1000 },
    ]);

    // 阶段 3：下一次请求（load）触发升级
    const records = await store.load();
    eq(store.kind, 'domain', '服务就绪后的下一次请求应当升级到 domain：');
    eq(records.map((r) => r.id).sort(), ['wt-dom-c', 'wt-file-a', 'wt-file-b'], '合并后一条都不能少：');
    const described = store.describe();
    eq(described.mismatch, null, '升级成功后不该再报不一致：');
    eq(described.merge.merged, 3);
    eq(described.merge.added, 2, '回退文件里的两条要补进 domain：');
    eq(described.merge.conflicts, 0);
    eq(described.merge.backups.length >= 1, true, '合并前必须留下 .bak- 备份：');
    eq(described.merge.backups.every((p) => p.includes('.bak-')), true, `备份命名不对：${described.merge.backups}`);
    // 备份内容就是合并前的回退文件
    const backupText = readFileSync(described.merge.backups[0], 'utf8');
    eq(JSON.parse(backupText).todos.map((t) => t.id).sort(), ['wt-file-a', 'wt-file-b']);
    // 复审 R1：升级成功后回退文件**退役**（改名成 .migrated-<时间>），原路径不再存在
    eq(described.retired?.movedTo?.includes('.migrated-'), true, `升级后必须退役回退文件：${JSON.stringify(described.retired)}`);
    eq(existsSync(join(home, 'worktodo', 'todos.json')), false, '退役后原路径不该还留着待办文件：');
    eq(described.retired.note.includes('已把回退文件迁移并退役'), true, 'describe() 必须能报出「已退役」：');
    // 退役文件里留的是一份完整存档（合并后的并集），用户随时能查/能恢复
    const migrated = JSON.parse(readFileSync(described.retired.movedTo, 'utf8'));
    eq(migrated.todos.map((t) => t.id).sort(), ['wt-dom-c', 'wt-file-a', 'wt-file-b']);
    await store.close();
  });
});

await test('合并同 id 冲突时以 updatedAt 较新的那条为准', async () => {
  await withTempHome(async () => {
    const holder = serviceHolder(null);
    const store = await openWorkTodoStore({ ctx: holder.ctx, config: {}, logger: silent });
    await store.put({ ...createRecord({ title: '文件里的旧标题' }, { now: NOW, id: 'wt-same' }), updatedAt: NOW });
    holder.current = makeFakeFacility([
      { ...createRecord({ title: '官方里的新标题' }, { now: NOW, id: 'wt-same' }), updatedAt: NOW + 5000 },
    ]);
    const merged = await store.load();
    eq(merged.length, 1, '同 id 不该变成两条：');
    eq(merged[0].title, '官方里的新标题', '应当取 updatedAt 较新的那条：');
    eq(store.describe().merge.conflicts, 1);

    // 反过来：回退文件里的更新，则保留文件里的
    const holder2 = serviceHolder(null);
    const store2 = await openWorkTodoStore({ ctx: holder2.ctx, config: {}, logger: silent });
    await store2.put({ ...createRecord({ title: '文件里更新' }, { now: NOW, id: 'wt-same2' }), updatedAt: NOW + 9000 });
    holder2.current = makeFakeFacility([
      { ...createRecord({ title: '官方里更旧' }, { now: NOW, id: 'wt-same2' }), updatedAt: NOW },
    ]);
    const merged2 = await store2.load();
    eq(merged2[0].title, '文件里更新');
    await store.close();
    await store2.close();
  });
});

console.log('回退文件退役：升级后单一真源（0.2.1 复审 R1）');

await test('升级后删掉一条再重开（第二次合并）不会复活，新增的也不会重复（复审 R1 / 实跑 exp8）', async () => {
  await withTempHome(async (home) => {
    const facility = makeFakeFacility();
    const holder = serviceHolder(null); // 先只有回退文件
    const first = await openWorkTodoStore({ ctx: holder.ctx, config: {}, logger: silent });
    for (const [id, title] of [['wt-a', 'A'], ['wt-b', 'B'], ['wt-c', 'C']]) {
      await first.put(createRecord({ title }, { now: NOW, id }));
    }
    // 服务就绪：升级、合并、退役回退文件
    holder.current = facility;
    eq((await first.load()).map((r) => r.id).sort(), ['wt-a', 'wt-b', 'wt-c']);
    eq(first.kind, 'domain');
    eq(existsSync(join(home, 'worktodo', 'todos.json')), false, '升级后回退文件必须退役：');

    // 用户在 domain 侧删除一条（旧的「快照镜像」修法就是在这里留下腐肉）
    await first.remove('wt-c');
    // 再新增一条，用于验证「再次合并不重复」
    await first.put(createRecord({ title: 'D' }, { now: NOW, id: 'wt-d' }));
    await first.close();

    // 「重载」：新的句柄会重新走一次 init → 以回退文件为 source 的合并
    const reloaded = await openWorkTodoStore({ ctx: serviceHolder(facility).ctx, config: {}, logger: silent });
    eq(reloaded.kind, 'domain');
    const ids = (await reloaded.load()).map((r) => r.id).sort();
    eq(ids.includes('wt-c'), false, '已删除的待办不能复活：');
    eq(ids, ['wt-a', 'wt-b', 'wt-d'], '既不能复活已删项，也不能重复：');
    eq(facility.records.has('wt-c'), false, 'domain 里也不该有 wt-c：');
    eq(existsSync(join(home, 'worktodo', 'todos.json')), false, '重载后也不该把回退文件复活：');
    eq(reloaded.describe().retired?.alreadyRetired, true, '已经退役过的文件要被识别出来（信息性报告）：');

    // 再增一条 → 再重载 → 仍然不重复、不复活
    await reloaded.put(createRecord({ title: 'E' }, { now: NOW, id: 'wt-e' }));
    await reloaded.close();
    const third = await openWorkTodoStore({ ctx: serviceHolder(facility).ctx, config: {}, logger: silent });
    eq((await third.load()).map((r) => r.id).sort(), ['wt-a', 'wt-b', 'wt-d', 'wt-e'], '第三次合并也不能重复：');
    await third.close();
    // 整个过程只有一个「已退役」存档，不会再生成新的回退文件
    eq(readdirSync(join(home, 'worktodo')).filter((n) => n.includes('.migrated-')).length, 1);
  });
});

await test('升级后 domain 读失败：显式报错并保持 domain 句柄，绝不静默读回退役的回退文件（复审 R1 第 3 条）', async () => {
  await withTempHome(async (home) => {
    const facility = makeFakeFacility();
    const holder = serviceHolder(null);
    const store = await openWorkTodoStore({ ctx: holder.ctx, config: {}, logger: silent });
    await store.put(createRecord({ title: '只存在于回退文件' }, { now: NOW, id: 'wt-only-file' }));
    holder.current = facility;
    await store.load(); // 升级 + 合并 + 退役
    eq(store.kind, 'domain');
    const migrated = store.describe().retired.movedTo;
    eq(existsSync(migrated), true, '退役存档要留着（用户可以手动查/恢复）：');

    facility.control.failLoad = true; // domain 突然不可用
    let error = null;
    try {
      await store.load();
    } catch (caught) {
      error = caught;
    }
    eq(Boolean(error), true, 'domain 读不出来时必须显式失败，而不是换源：');
    eq(store.kind, 'domain', '出错不能改变当前后端：');
    const described = store.describe();
    eq(typeof described.backendError, 'string', '错误必须进 describe()/health：');
    eq(described.backendError.includes('不会静默改用它'), true, `要让用户看到「没有静默换源」：${described.backendError}`);
    eq(described.retired.movedTo, migrated, '退役记录不该被清掉：');
    // 退役文件本身没被读过、也没被改写：内容还在（只是不再当数据源）
    eq(JSON.parse(readFileSync(migrated, 'utf8')).todos.map((t) => t.id), ['wt-only-file']);
    eq(existsSync(join(home, 'worktodo', 'todos.json')), false, '不能把退役文件重新变回回退文件：');
    await store.close();
  });
});

await test('两处都有数据且 id 不一致时明确报出来（不静默）', async () => {
  await withTempHome(async (home) => {
    // 预置官方 storage 落盘文件：模拟真实设备上「官方 6 条 / 回退 4 条、id 交集为 0」
    mkdirSync(join(home, 'storages'), { recursive: true });
    mkdirSync(join(home, 'worktodo'), { recursive: true });
    writeFileSync(join(home, 'storages', 'worktodo.json'), JSON.stringify({
      unit: { name: 'worktodo', version: 1 },
      global: null,
      tables: { todos: { 'wt-official-1': { id: 'wt-official-1', title: '官方那边的记录' } } },
    }), 'utf8');
    writeFileSync(join(home, 'worktodo', 'todos.json'), JSON.stringify({
      version: 1,
      updatedAt: NOW,
      todos: [{ id: 'wt-file-1', title: '回退文件里的记录', status: 'pending' }],
    }), 'utf8');

    const logs = [];
    const store = await openWorkTodoStore({ ctx: serviceHolder(null).ctx, config: {}, logger: logTo(logs) });
    eq(store.kind, 'file');
    eq(store.describe().preferred, 'domain');
    eq(typeof store.describe().split, 'string', '两处 id 不一致必须记录在 describe() 里：');
    eq(store.describe().split.includes('wt-official-1') || store.describe().split.includes('官方独有 1'), true);
    eq(logs.some((line) => line.startsWith('warn') && line.includes('两处待办数据不一致')), true, '必须打警告日志：');
    await store.close();
  });
});

await test('storageDomain 可用但 open 失败：留在文件后端但明确报出不一致，不静默', async () => {
  await withTempHome(async () => {
    const logs = [];
    const failing = { async open() { throw new Error("domain 'worktodo' is already open"); } };
    const store = await openWorkTodoStore({ ctx: serviceHolder(failing).ctx, config: {}, logger: logTo(logs) });
    eq(store.kind, 'file', '打不开 domain 时仍要能用（回退文件）：');
    eq(store.describe().mismatch.includes('already open'), true, '不一致原因要报给 health：');
    eq(logs.some((line) => line.startsWith('warn') && line.includes('官方 storage')), true, '必须打警告日志：');
    await store.close();
  });
});

await test('二次挂载（同一 storageDomain 服务上再开一次）不降级、不丢数据、不重复 open', async () => {
  await withTempHome(async () => {
    const facility = makeFakeFacility();
    const ctx = serviceHolder(facility).ctx;
    const first = await openWorkTodoStore({ ctx, config: {}, logger: silent });
    eq(first.kind, 'domain');
    await first.put(createRecord({ title: '共享的一条' }, { now: NOW, id: 'wt-shared' }));

    // 二次挂载：官方对同名领域的第二次 open 会抛 already-open（0.2.0 就是这样静默降级到文件的）
    const second = await openWorkTodoStore({ ctx, config: {}, logger: silent });
    eq(second.kind, 'domain', '二次挂载不能降级到回退文件：');
    eq((await second.load()).map((r) => r.id), ['wt-shared'], '数据不能丢：');
    eq(facility.calls.open, 1, '同一服务上只应打开一次领域：');

    await second.close();
    // 还有使用者时不该把领域提前关掉
    eq((await first.load()).map((r) => r.id), ['wt-shared']);
    await first.close();
    eq(facility.calls.close, 1, '所有使用者都关闭后才真的关领域：');
  });
});

console.log('文件后端（真实磁盘 IO）');

await test('显式 storePath 时使用文件后端并落盘为合法 JSON', async () => {
  const path = join(newRoot(), 'nested', 'todos.json');
  const store = await openWorkTodoStore({ ctx: undefined, config: { storePath: path }, logger: silent });
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
  const store = await openWorkTodoStore({ ctx: undefined, config: { storePath: path }, logger: silent });
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
  const store = await openWorkTodoStore({ ctx: undefined, config: { storePath: path }, logger: silent });
  eq(await store.load(), []);
  // 读路径不该动磁盘：用户手改坏了，修回来还能救
  eq(readFileSync(path, 'utf8').includes('这不是 JSON'), true, '只读时不该改动坏文件：');
  await store.close();
});

await test('坏文件 + 一次写入：原文件先被改名备份，新文件只含新记录（审计 F2）', async () => {
  const dir = newRoot();
  const path = join(dir, 'todos.json');
  const broken = '{ 这不是 JSON，但里面可能有用户手写的待办';
  writeFileSync(path, broken, 'utf8');

  const logs = [];
  const store = await openWorkTodoStore({ ctx: undefined, config: { storePath: path }, logger: logTo(logs) });
  await store.put(createRecord({ title: '新记录' }, { now: NOW, id: 'new1' }));

  const backups = readdirSync(dir).filter((name) => name.includes('.corrupt-') && name.endsWith('.bak'));
  eq(backups.length, 1, '坏文件必须先被改名备份（.corrupt-<时间>.bak）：');
  eq(readFileSync(join(dir, backups[0]), 'utf8'), broken, '备份内容必须与原坏文件逐字一致：');
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  eq(doc.todos.map((t) => t.id), ['new1'], '新文件只含新记录，原内容在备份里：');
  eq(logs.some((line) => line.startsWith('warn') && line.includes('corrupt-')), true, '告警要说明备份位置：');
  // 旧文案与事实相反（「原文件未被覆盖」）——不能再出现
  eq(logs.some((line) => line.includes('原文件未被覆盖')), false, '告警文案必须与真实行为一致：');
  await store.close();
});

await test('缺 title 的单条坏记录用占位标题读出，垃圾条目不影响其它记录', async () => {
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
  const store = await openWorkTodoStore({ ctx: undefined, config: { storePath: path }, logger: silent });
  const loaded = await store.load();
  eq(loaded.map((t) => t.id).sort(), ['bad', 'ok']);
  eq(loaded.find((t) => t.id === 'bad').title, MISSING_TITLE_PLACEHOLDER);
  await store.close();
});

await test('缺 title 的坏记录在下次写入后仍然在文件里（不再被永久删除，审计 F3）', async () => {
  const dir = newRoot();
  const path = join(dir, 'todos.json');
  writeFileSync(path, JSON.stringify({
    version: 1,
    updatedAt: NOW,
    todos: [
      { id: 'ok1', title: '好的', status: 'pending' },
      { id: 'bad1', notes: '手写时漏了标题' },
      '不是对象',
    ],
  }), 'utf8');

  const logs = [];
  const store = await openWorkTodoStore({ ctx: undefined, config: { storePath: path }, logger: logTo(logs) });
  await store.put(createRecord({ title: '新增' }, { now: NOW, id: 'new1' }));

  const doc = JSON.parse(readFileSync(path, 'utf8'));
  eq(doc.todos.map((t) => t.id).sort(), ['bad1', 'new1', 'ok1'], '缺 title 的记录写回后必须还在：');
  eq(doc.todos.find((t) => t.id === 'bad1').notes, '手写时漏了标题', '其它字段要保留：');
  // 完全不是对象的垃圾条目另存备份（写路径上备份，读路径只告警）
  const dropped = readdirSync(dir).filter((name) => name.includes('.dropped-') && name.endsWith('.json'));
  eq(dropped.length, 1, '被跳过的垃圾条目要另存 .dropped-<时间>.json：');
  const droppedDoc = JSON.parse(readFileSync(join(dir, dropped[0]), 'utf8'));
  eq(droppedDoc.dropped.length, 1);
  eq(logs.some((line) => line.startsWith('warn')), true);
  await store.close();
});

await test('并发写不丢数据（写入串行化）', async () => {
  const path = join(newRoot(), 'todos.json');
  const store = await openWorkTodoStore({ ctx: undefined, config: { storePath: path }, logger: silent });
  const many = Array.from({ length: 12 }, (_, i) => createRecord({ title: `第 ${i} 条` }, { now: NOW, id: `wt-${i}` }));
  // 不 await 逐个写：并发触发写入链
  await Promise.all(many.map((record) => store.put(record)));
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  eq(doc.todos.length, 12, '并发写必须全部保住：');
  await store.close();
});

await test('~ 开头的 storePath 会展开到家目录', async () => {
  const store = await openWorkTodoStore({ ctx: undefined, config: { storePath: '~/worktodo-verify-should-not-exist.json' }, logger: silent });
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

await test('storageDomain 尚未注册时不抛错（cordis 守卫会抛，必须只用 ctx.get 探测）', async () => {
  // 回归用例：曾经写成 `ctx.get('storageDomain') ?? ctx.storageDomain`——
  // 服务尚未注册时那个兜底访问会被 cordis 守卫抛错，异常一路冒到 apply，导致**整个插件挂载失败**
  // （实测表现：插件时好时坏，工具与路由全都不在）。
  await withTempHome(async () => {
    const ctx = {
      get: () => undefined, // 服务还没注册
      get storageDomain() {
        throw new Error('cannot get property "storageDomain" without inject');
      },
    };
    const store = await openWorkTodoStore({ ctx, config: {}, logger: null });
    eq(store.kind, 'file', '应当回退到文件后端而不是抛错：');
    eq(store.describe().mismatch, null, '服务本来就没有：不算「后端不一致」：');
    await store.close();
  });
});

console.log(`
${passed + 1} 通过，${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.error(`- ${f.label}: ${f.error?.stack ?? f.error}`);
  process.exit(1);
}
