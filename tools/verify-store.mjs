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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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
  const calls = { open: 0, close: 0, update: 0 };
  /** 测试开关：模拟「domain 突然读不出来」（复审 R1 第 3 条：不能静默换回退役文件）。 */
  const control = { failLoad: false, failId: null, failIds: null, failCount: 0 };
  let open = false;
  return {
    records,
    calls,
    control,
    /** 领域是否还开着（S2-1：open 成功后抛错必须 close，不能留下已开的句柄）。 */
    isOpen: () => open,
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
            // 复审 0.2.2 F2/F3 的注入点：让指定记录的写入失败（模拟半截合并）
            control.failCount += 1;
            if (control.failId === key || (Array.isArray(control.failIds) && control.failIds.includes(key))) {
              throw new Error(`写入 ${key} 失败（注入）`);
            }
            records.set(key, spec.tables[name].valueSchema.parse(value));
          },
          // 官方 KvTableImpl.update(key, fn)：在领域写链里「读当前值 → 变换 → 写回」。
          // store.mjs 的 updateOrder 优先用它（S3-1/S4-1：只改 order、不覆盖并发字段）。
          update: async (key, fn) => {
            calls.update += 1;
            if (!records.has(key)) {
              throw new Error(`domain 'worktodo' table 'todos' has no record '${key}' to update`);
            }
            const next = spec.tables[name].valueSchema.parse(fn(records.get(key)));
            records.set(key, next);
            return next;
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
    await store.close();

    // 反过来：回退文件里的更新，则保留文件里的。
    // ⚠️ 必须换一个干净的 home：上面这次升级已经把这个 home 的回退文件退役了，
    // 新句柄会正确地拒绝再读它（复审 0.2.2 F1/F3）。
    await withTempHome(async () => {
      const holder2 = serviceHolder(null);
      const store2 = await openWorkTodoStore({ ctx: holder2.ctx, config: {}, logger: silent });
      await store2.put({ ...createRecord({ title: '文件里更新' }, { now: NOW, id: 'wt-same2' }), updatedAt: NOW + 9000 });
      holder2.current = makeFakeFacility([
        { ...createRecord({ title: '官方里更旧' }, { now: NOW, id: 'wt-same2' }), updatedAt: NOW },
      ]);
      const merged2 = await store2.load();
      eq(merged2[0].title, '文件里更新');
      await store2.close();
    });
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

/* ------------------------------------------------------------------ *
 * 复审 0.2.2（第三轮）：F1 退役后 domain 不可用、F2 半截合并复活、F3 退役失败
 * ------------------------------------------------------------------ */

await test('F1：回退文件已退役 + 官方存储不可用 → 绝不静默返回空列表，且 describe()/日志明确报错', async () => {
  await withTempHome(async (home) => {
    const facility = makeFakeFacility();
    const holder = serviceHolder(null);
    const first = await openWorkTodoStore({ ctx: holder.ctx, config: {}, logger: silent });
    await first.put(createRecord({ title: 'A' }, { now: NOW, id: 'wt-a' }));
    // 服务就绪 → 合并 + 退役（真机上的真实状态：只剩下 .migrated-*）
    holder.current = facility;
    eq((await first.load()).map((r) => r.id), ['wt-a']);
    await first.close();
    eq(existsSync(join(home, 'worktodo', 'todos.json')), false, '前置：回退文件必须已退役：');
    eq(existsSync(join(home, 'worktodo', 'todos.json.retired')), true, '退役必须留下哨兵（下次启动据此判断）：');

    // 重开：storageDomain 不在组合里（插件文档写明「精简组合里可能没挂载」是设计内场景）
    const logs = [];
    const store = await openWorkTodoStore({ ctx: serviceHolder(null).ctx, config: {}, logger: logTo(logs) });
    let loadError = null;
    let loaded;
    try {
      loaded = await store.load();
    } catch (error) {
      loadError = error;
    }
    eq(loaded ?? null, null, '绝不能静默返回空列表（那就是「用户以为待办没了」）：');
    eq(Boolean(loadError), true, '必须抛出显式错误，走既有失败路径：');
    eq(String(loadError?.message).includes('退役'), true, `错误要说清「已退役」：${loadError?.message}`);
    eq(loadError?.code, 'RETIRED_FALLBACK_UNAVAILABLE', '错误要带稳定 code，便于上层区分：');

    const described = store.describe();
    eq(described.preferred, 'domain', 'describe() 要写明首选后端：');
    eq(described.domainUnavailable, true, 'describe() 要能让面板一眼判定「官方存储不可用」：');
    eq(typeof described.backendError, 'string', 'describe() 必须有明确错误：');
    eq(described.backendError.includes('退役'), true, `backendError 要说清退役事实：${described.backendError}`);
    eq(described.retired?.alreadyRetired, true, '退役事实要持久化（重启后仍知道）：');
    eq(typeof described.retired?.at, 'number', '退役时间要能报出来：');
    eq(logs.some((line) => line.startsWith('warn') && line.includes('退役')), true, '必须有高优先级告警日志（不静默）：');
    await store.close();
  });
});

await test('F1：没有哨兵时（旧版本退役）也能从 .migrated-* 认出已退役，domain 不可用同样不静默', async () => {
  await withTempHome(async (home) => {
    const dir = join(home, 'worktodo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'todos.json.migrated-20261013-220627'), JSON.stringify({
      version: 1,
      updatedAt: NOW,
      todos: [{ id: 'wt-old', title: '旧数据', status: 'pending' }],
    }), 'utf8');
    // 官方 storage 落盘文件里也有数据（真机正是这种形态）
    mkdirSync(join(home, 'storages'), { recursive: true });
    writeFileSync(join(home, 'storages', 'worktodo.json'), JSON.stringify({
      unit: { name: 'worktodo', version: 1 },
      global: null,
      tables: { todos: { 'wt-dom': { id: 'wt-dom', title: '官方里的' } } },
    }), 'utf8');

    const logs = [];
    const store = await openWorkTodoStore({ ctx: serviceHolder(null).ctx, config: {}, logger: logTo(logs) });
    let error = null;
    try {
      await store.load();
    } catch (caught) {
      error = caught;
    }
    eq(Boolean(error), true, '只有 .migrated-* 时同样不能静默给空列表：');
    const described = store.describe();
    eq(described.retired?.alreadyRetired, true, '要认出「此前已退役」：');
    eq(String(described.retired?.movedTo).includes('.migrated-'), true, '要报出退役档案：');
    // 不能因为本地列表为空就早退（空 ≠ 健康）：官方 storage 里有 1 条必须报出来
    eq(typeof described.split, 'string', 'detectSplit 不能因为本地为空就闭嘴：');
    eq(described.split.includes('官方独有 1'), true, `要报出「官方独有 1 条」：${described.split}`);
    eq(logs.some((line) => line.startsWith('warn') && line.includes('退役')), true, '要有告警日志：');
    await store.close();
  });
});

await test('F2：合并中途失败必须回滚，不留下半截 domain（否则用户删掉的待办会复活）', async () => {
  await withTempHome(async () => {
    const facility = makeFakeFacility();
    const holder = serviceHolder(null);
    const store = await openWorkTodoStore({ ctx: holder.ctx, config: {}, logger: silent });
    for (const [id, title] of [['wt-a', 'A'], ['wt-b', 'B'], ['wt-c', 'C']]) {
      await store.put(createRecord({ title }, { now: NOW, id }));
    }

    // 注入：合并时 wt-b 写入失败（A 已写入 → 旧实现会在 domain 留下半截）
    facility.control.failId = 'wt-b';
    holder.current = facility;
    const loaded = await store.load();
    eq(store.kind, 'file', '合并失败必须留在文件后端：');
    eq(facility.records.has('wt-a'), false, '已写入的 wt-a 必须被回滚掉（不留半截）：');
    eq(facility.records.size, 0, '目标端必须回到合并前状态：');
    const described = store.describe();
    eq(described.merge?.aborted, true, '必须把「本次合并被中止」记进 describe()：');
    eq(String(described.merge?.writeError).includes('wt-b'), true, `中止原因要指向失败的那条：${described.merge?.writeError}`);
    eq(described.retired, null, '合并失败不能退役回退文件：');

    // 用户在当前后端（文件）上删掉 A
    await store.remove('wt-a');
    eq(loaded.length, 3, '合并失败时读到的仍是文件里的三条：');

    // domain 恢复 → 再合并：绝不能把已删除的 wt-a 复活
    facility.control.failId = null;
    await new Promise((resolve) => setTimeout(resolve, 5100)); // 跨过升级重试节流
    await store.refreshBackend();
    eq(store.kind, 'domain', '恢复后应当升级成功：');
    const ids = (await store.load()).map((r) => r.id).sort();
    eq(ids, ['wt-b', 'wt-c'], `已删除的 wt-a 不能复活：${JSON.stringify(ids)}`);
    eq(facility.records.has('wt-a'), false, 'domain 里不该有 wt-a：');
    await store.close();
  });
});

await test('F3：退役 rename 失败 → 显示失败原因（不是「已迁移并退役」），且该文件不再当合并源（不复活）', async () => {
  await withTempHome(async (home) => {
    const facility = makeFakeFacility([createRecord({ title: 'D' }, { now: NOW, id: 'wt-dom-d' })]);
    const holder = serviceHolder(null);
    const logs = [];
    const store = await openWorkTodoStore({ ctx: holder.ctx, config: {}, logger: logTo(logs) });
    for (const [id, title] of [['wt-a', 'A'], ['wt-b', 'B']]) {
      await store.put(createRecord({ title }, { now: NOW, id }));
    }

    // 注入：只让退役改名失败（备份与哨兵照常），模拟 EACCES/EPERM。
    // ESM 的 fs 命名空间是冻结的，测试里无法替换 renameSync，所以源码留了一个
    // 显式的测试故障注入点（`WORKTODO_TEST_FAULT=retire-rename`，只在设置时生效）。
    const previousFault = process.env.WORKTODO_TEST_FAULT;
    process.env.WORKTODO_TEST_FAULT = 'retire-rename';
    try {
      holder.current = facility;
      await store.load();
    } finally {
      if (previousFault === undefined) delete process.env.WORKTODO_TEST_FAULT;
      else process.env.WORKTODO_TEST_FAULT = previousFault;
    }
    eq(store.kind, 'domain', '改名失败不影响已经合并好的 domain：');
    eq(existsSync(join(home, 'worktodo', 'todos.json')), true, '改名失败时文件仍在原地：');
    eq(existsSync(join(home, 'worktodo', 'todos.json.retired')), true, '失败也要落哨兵（下次启动据此排除）：');
    const described = store.describe();
    eq(typeof described.retired?.error, 'string', 'describe() 必须带上原始错误：');
    eq(described.retired.error.includes('EACCES') || described.retired.error.includes('EPERM'),
      true, `原始错误不能丢：${described.retired.error}`);
    eq(described.retired.movedTo, null, '失败时不能报「已迁移」：');
    eq(String(described.retired.note).includes('仍然存在'), true, `文案要说清文件还在：${described.retired.note}`);
    // 面板/日志必须是「失败 + 原因 + 建议」，绝不能是「已迁移并退役」（复审 0.2.2 F3）
    eq(logs.some((line) => line.startsWith('warn')
      && line.includes('退役失败')
      && line.includes('已被排除在合并源之外')
      && line.includes('手动改名或删除')), true, `必须报失败原因与建议：${JSON.stringify(logs)}`);
    eq(logs.some((line) => line.startsWith('info') && line.includes('已把回退文件迁移并退役')), false,
      '改名失败时绝不能打「已迁移并退役」的成功日志：');
    // domain 侧删掉 A，然后重开：文件仍是旧的 [A,B]，但已不是合并源 → 不能复活
    await store.remove('wt-a');
    await store.close();
    const reloaded = await openWorkTodoStore({ ctx: serviceHolder(facility).ctx, config: {}, logger: silent });
    const ids = (await reloaded.load()).map((r) => r.id).sort();
    eq(ids.includes('wt-a'), false, `已删除的 wt-a 不能复活（退役文件不得再当合并源）：${JSON.stringify(ids)}`);
    eq(ids, ['wt-b', 'wt-dom-d']);
    eq(reloaded.describe().retired?.alreadyRetired, true, '重开后仍要认得这个哨兵：');
    await reloaded.close();
  });
});

await test('F9：合并反复失败不会每次新增 .bak-（同一轮复用 + 轮转上限）', async () => {
  await withTempHome(async (home) => {
    const facility = makeFakeFacility();
    const holder = serviceHolder(null);
    const store = await openWorkTodoStore({ ctx: holder.ctx, config: {}, logger: silent });
    for (const [id, title] of [['wt-a', 'A'], ['wt-b', 'B']]) {
      await store.put(createRecord({ title }, { now: NOW, id }));
    }
    const path = join(home, 'worktodo', 'todos.json');
    const backups = () => readdirSync(join(home, 'worktodo')).filter((name) => name.includes('.bak-'));
    eq(backups().length, 0, '还没合并过，不该有备份：');

    facility.control.failId = 'wt-a';
    holder.current = facility;
    await store.load();
    eq(backups().length, 1, '第一次失败留一份备份：');
    eq(facility.control.failCount > 0, true, '注入应当命中：');
    // 再失败两次（同一轮、5 秒内）：不得每次都 +1
    await store.refreshBackend();
    await store.refreshBackend();
    eq(backups().length, 1, `同一轮内必须复用，不能堆积：${JSON.stringify(backups())}`);
    // S2-2：跨过升级重试节流（5s）再失败一次 —— 仍然是同一场故障，**不许**再复制一份整文件备份。
    // 改前用的是 5 秒复用时间窗，而重试节流恰好也是 5 秒 → 每轮重试都复制一份（warn 与 IO 一起放大）。
    await new Promise((resolve) => setTimeout(resolve, 5100));
    await store.refreshBackend();
    eq(facility.control.failCount > 0, true, '节流之后应当真的又重试了一次：');
    eq(backups().length, 1, `同一次故障跨过节流也只允许一份备份：${JSON.stringify(backups())}`);
    // 轮转上限依然在（备份永远不超过 MAX=2 份）
    eq(backups().length <= 2, true, `备份要有上限（最多 2 份）：${JSON.stringify(backups())}`);
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

/* ------------------------------------------------------------------ *
 * 第四轮稳定性审计：S3-1 / S3-2 / S4-1（reorder 批量写）、S2-1（句柄泄漏）、
 * S2-2（备份去重）、S1-2（打开超时）
 * ------------------------------------------------------------------ */

/**
 * 在窗口内统计真实文件 IO：patch `node:fs` 后调 `syncBuiltinESMExports()`，
 * store.mjs 里 `import { readFileSync } from 'node:fs'` 的绑定会跟着换成计数版本
 *（审计的 wt-d3-perf.mjs 用的就是这一招，否则 ESM 命名导入数不到字节）。
 * @param {() => Promise<any>} run
 * @returns {Promise<{stats: object, value: any}>}
 */
async function withFsCounter(run) {
  const real = { read: fs.readFileSync, write: fs.writeFileSync, rename: fs.renameSync };
  const stats = { read: 0, readBytes: 0, write: 0, writeBytes: 0, rename: 0 };
  fs.readFileSync = (target, ...rest) => {
    const out = real.read(target, ...rest);
    stats.read += 1;
    stats.readBytes += typeof out === 'string' ? Buffer.byteLength(out) : out.length;
    return out;
  };
  fs.writeFileSync = (target, data, ...rest) => {
    stats.write += 1;
    stats.writeBytes += typeof data === 'string' ? Buffer.byteLength(data) : data.length;
    return real.write(target, data, ...rest);
  };
  fs.renameSync = (...args) => {
    stats.rename += 1;
    return real.rename(...args);
  };
  syncBuiltinESMExports();
  try {
    const value = await run();
    return { stats, value };
  } finally {
    fs.readFileSync = real.read;
    fs.writeFileSync = real.write;
    fs.renameSync = real.rename;
    syncBuiltinESMExports();
  }
}

/** 造 n 条合法记录并直接把文件写成落盘格式（绕过 n 次 put 的 O(n²) 准备时间）。 */
function seedFile(path, n) {
  const records = Array.from({ length: n }, (_, i) => createRecord({ title: `条目 ${i}` }, { now: NOW + i, id: `wt-${i}` }));
  writeFileSync(path, `${JSON.stringify({ version: 1, updatedAt: NOW + n, todos: records }, null, 2)}\n`, 'utf8');
  return records;
}

console.log('S3-1 / S3-2 / S4-1：reorder 的批量原子写（第四轮审计）');

await test('S3-1/S3-2：1000 条 reorder 只发生「读 2 次 / 写 1 次 / rename 1 次」，不再是 N 次整文件重写', async () => {
  const dir = newRoot();
  const path = join(dir, 'todos.json');
  const n = 1000;
  const records = seedFile(path, n);
  const store = await openWorkTodoStore({ ctx: undefined, config: { storePath: path }, logger: silent });
  const fileSize = statSync(path).size;
  const ids = records.map((record) => record.id).reverse();

  const { stats, value } = await withFsCounter(async () => {
    const t0 = process.hrtime.bigint();
    const result = await store.updateOrder(ids);
    return { result, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  });
  const { result, ms } = value;
  eq(result.updated, n);
  eq(stats.write, 1, '整批只允许一次整文件写（改前是 1000 次）：');
  eq(stats.rename, 1, '原子写只允许一次 rename（改前是 1000 次）：');
  eq(stats.read <= 2, true, `最多读两次（调用前读一次 + 批量写内部 readDoc 一次），实际 ${stats.read} 次：`);
  eq(stats.writeBytes <= fileSize * 2, true,
    `写入字节量必须只在「一份文件」量级（改前 ${(fileSize * n / 1024).toFixed(0)} KiB）：实际 ${(stats.writeBytes / 1024).toFixed(0)} KiB`);
  // 时间只做量级护栏（改前 3.9s，改后毫秒级），不是基准测试：真正与机器无关的断言是上面的写次数/字节量
  eq(ms < 1500, true, `1000 条 reorder 应当是毫秒级（阈值 1500ms，实际 ${ms.toFixed(1)}ms）：`);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  eq(doc.todos.every((todo) => todo.order === ids.indexOf(todo.id)), true, 'order 要正确落盘：');
  console.log(`      [perf] n=${n}（文件 ${(fileSize / 1024).toFixed(0)} KiB）reorder ${ms.toFixed(1)}ms`
    + ` ｜ 读 ${stats.read} 次 ${(stats.readBytes / 1024).toFixed(0)} KiB、写 ${stats.write} 次 ${(stats.writeBytes / 1024).toFixed(0)} KiB、rename ${stats.rename}`);
  await store.close();
});

await test('S3-1：只改 order —— 拖拽期间另一窗口改的 title/priority/updatedAt 全都不被覆盖', async () => {
  const path = join(newRoot(), 'todos.json');
  const store = await openWorkTodoStore({ ctx: undefined, config: { storePath: path }, logger: silent });
  const a = createRecord({ title: 'A' }, { now: NOW, id: 'wt-a' });
  const b = createRecord({ title: 'B', priority: 'low' }, { now: NOW, id: 'wt-b' });
  const c = createRecord({ title: 'C' }, { now: NOW, id: 'wt-c' });
  for (const record of [a, b, c]) await store.put(record);
  // 「拖拽开始后、批量写落地前」另一窗口改了 wt-b（复审 S4-1 的丢失更新场景）
  await store.put({ ...b, title: '并发改的标题', priority: 'high', updatedAt: NOW + 1000 });
  const snapshot = (await store.load()).find((record) => record.id === 'wt-b');

  const result = await store.updateOrder(['wt-c', 'wt-b', 'wt-a']);
  eq(result.updated, 3);
  const after = (await store.load()).find((record) => record.id === 'wt-b');
  eq(after.title, '并发改的标题', '并发改的 title 不能被排序写覆盖：');
  eq(after.priority, 'high', '并发改的 priority 不能被排序写覆盖：');
  eq(after.updatedAt, NOW + 1000, '排序写不该改 updatedAt：');
  eq(after.order, 1, 'order 要按新顺序落盘：');
  const changed = Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(snapshot[key]));
  eq(changed, ['order'], '一次排序只允许改 order 这一个字段：');
  await store.close();
});

await test('S3-1：domain 后端 updateOrder 走官方 table.update（写链内读-改-写），并发字段保留', async () => {
  await withTempHome(async () => {
    const facility = makeFakeFacility();
    const store = await openWorkTodoStore({ ctx: serviceHolder(facility).ctx, config: {}, logger: silent });
    eq(store.kind, 'domain');
    await store.put(createRecord({ title: 'A' }, { now: NOW, id: 'wt-a' }));
    await store.put(createRecord({ title: 'B', priority: 'high' }, { now: NOW, id: 'wt-b' }));
    // 拖拽期间另一窗口改了 wt-b
    await store.put({ ...createRecord({ title: '并发改的', priority: 'high' }, { now: NOW, id: 'wt-b' }), updatedAt: NOW + 1000 });
    const snapshot = (await store.load()).find((record) => record.id === 'wt-b');

    const result = await store.updateOrder(['wt-b', 'wt-a']);
    eq(result.updated, 2);
    const after = (await store.load()).find((record) => record.id === 'wt-b');
    eq(after.title, '并发改的', 'domain 后端的排序也不能覆盖并发改的 title：');
    eq(after.priority, 'high');
    eq(after.order, 0);
    eq(after.updatedAt, NOW + 1000, 'order 之外的字段都不该动：');
    const changed = Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(snapshot[key]));
    eq(changed, ['order'], 'domain 后端同样只 patch order：');
    eq((await store.load()).find((record) => record.id === 'wt-a').order, 1);
    eq(facility.calls.update, 2, '优先用官方 table.update（在领域写链里完成读-改-写）：');
    await store.close();
  });
});

await test('S3-1：没有任何 order 需要改时完全不碰磁盘（写 0 次）', async () => {
  const path = join(newRoot(), 'todos.json');
  seedFile(path, 5);
  const store = await openWorkTodoStore({ ctx: undefined, config: { storePath: path }, logger: silent });
  await store.updateOrder(['wt-0', 'wt-1', 'wt-2', 'wt-3', 'wt-4']);
  const { stats, value } = await withFsCounter(() => store.updateOrder(['wt-0', 'wt-1', 'wt-2', 'wt-3', 'wt-4']));
  eq(value.updated, 0);
  eq(stats.write, 0, '顺序没变时不该有任何写入：');
  eq(stats.rename, 0);
  await store.close();
});

console.log('S2-1：open() 成功后再抛错不许泄漏领域句柄');

await test('S2-1：table() 抛错 → 刚打开的句柄被 close、注册表摘除，故障消失后仍能正常打开', async () => {
  await withTempHome(async () => {
    const facility = makeFakeFacility();
    const originalOpen = facility.open;
    let failTableOnce = true;
    facility.open = async (spec) => {
      const domain = await originalOpen(spec);
      if (!failTableOnce) return domain;
      failTableOnce = false;
      return { ...domain, table() { throw new Error('table() 注入抛错'); } };
    };

    const first = await openWorkTodoStore({ ctx: serviceHolder(facility).ctx, config: {}, logger: silent });
    eq(first.kind, 'file', '打不开官方存储要降级到回退文件，而不是让插件挂不上：');
    eq(facility.calls.open, 1);
    eq(facility.calls.close, 1, 'open 成功之后抛错必须把领域句柄 close（改前 close=0 → 永久泄漏）：');
    eq(facility.isOpen(), false, '句柄不能还开着：');
    eq(String(first.describe().mismatch).includes('table()'), true,
      `describe() 要报出打开失败的原因：${first.describe().mismatch}`);
    await first.close();

    const second = await openWorkTodoStore({ ctx: serviceHolder(facility).ctx, config: {}, logger: silent });
    eq(second.kind, 'domain', '故障消失后必须还能打开（改前会永远撞 already-open，只能重启进程）：');
    await second.put(createRecord({ title: '修好之后' }, { now: NOW, id: 'wt-fixed' }));
    eq((await second.load()).map((r) => r.id), ['wt-fixed']);
    await second.close();
  });
});

console.log('S1-2：挂载路径上的打开必须有超时');

await test('S1-2：storageDomain.open 永不 resolve → 默认 3 秒超时降级并告警，绝不让 apply 无限等待', async () => {
  await withTempHome(async () => {
    const hanging = { open: () => new Promise(() => {}) };
    const logs = [];
    const t0 = process.hrtime.bigint();
    const store = await openWorkTodoStore({ ctx: serviceHolder(hanging).ctx, config: {}, logger: logTo(logs) });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    eq(store.kind, 'file', '超时后必须降级到回退文件：');
    eq(String(store.describe().mismatch).includes('超时'), true, `要把「打开超时」报给 health/面板：${store.describe().mismatch}`);
    eq(logs.some((line) => line.startsWith('warn') && line.includes('超时')), true, '超时必须告警（不静默）：');
    // 默认超时 3s：证明真的加上了上限，而不是碰巧没挂住
    eq(ms >= 2900 && ms < 6000, true, `默认超时应当是 3 秒左右（实际 ${ms.toFixed(0)}ms）：`);
    // 超时之后插件照常可用（这条路径在 apply 上就是「仍然挂载成功」）
    await store.put(createRecord({ title: '超时后的写入' }, { now: NOW, id: 'wt-after-timeout' }));
    eq((await store.load()).map((r) => r.id), ['wt-after-timeout']);
    await store.close();
  });
});

await test('S1-2：超时后那个 open 才成功 → 晚到的句柄会被归还，后续挂载不会再撞 already-open', async () => {
  await withTempHome(async () => {
    const facility = makeFakeFacility();
    const originalOpen = facility.open;
    let delayNext = true;
    facility.open = async (spec) => {
      if (delayNext) {
        delayNext = false;
        await new Promise((resolve) => setTimeout(resolve, 300)); // 晚于 100ms 超时
      }
      return originalOpen(spec);
    };
    const previous = process.env.WORKTODO_UPGRADE_TIMEOUT_MS;
    process.env.WORKTODO_UPGRADE_TIMEOUT_MS = '100';
    try {
      const store = await openWorkTodoStore({ ctx: serviceHolder(facility).ctx, config: {}, logger: silent });
      eq(store.kind, 'file', '超时后先用回退文件：');
      await new Promise((resolve) => setTimeout(resolve, 500)); // 等那个迟到的 open 落地
      eq(facility.calls.open, 1);
      eq(facility.calls.close, 1, '晚到的领域句柄必须被归还（close + 摘注册表），否则就是 S2-1 的泄漏再版：');
      eq(facility.isOpen(), false);
      // 注册表没被毒化：同一个服务上再打开一次必须成功
      const second = await openWorkTodoStore({ ctx: serviceHolder(facility).ctx, config: {}, logger: silent });
      eq(second.kind, 'domain', '超时不能把注册表毒化成永久 already-open：');
      await second.close();
      await store.close();
    } finally {
      if (previous === undefined) delete process.env.WORKTODO_UPGRADE_TIMEOUT_MS;
      else process.env.WORKTODO_UPGRADE_TIMEOUT_MS = previous;
    }
  });
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
