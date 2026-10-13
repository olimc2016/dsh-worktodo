/**
 * 待办存储：两条后端，一套接口。
 *
 * 为什么是两条：
 *   1. 首选官方 `ctx.storageDomain`（dsh-base 默认挂载 storage + storage-json + storage-domain，
 *      数据落在 $DSH_HOME/storages）。这是官方给「插件自有、跨重启保留、不进会话事件」的
 *      数据的指定位置——写会话事件需要 ignoble 标记（`ignorable: true`）而 Session.append
 *      设不了，所以自造事件类型会让会话打不开，绝不能走那条路。
 *   2. 回退到 JSON 文件（$DSH_HOME/worktodo/todos.json）。storage 服务在某些精简组合里可能
 *      没挂载，此时插件必须照样能用；文件还是人能直接打开、能手改、能进 git 的形态，
 *      对一个「归人所有的工作待办」来说本身也是优点。
 *
 * 两条后端共用 schema.mjs 的 repairRecord 校验，行为一致：
 * 缺 title 的单条坏记录用占位标题保留（而不是跳过），只有完全不是对象的垃圾条目才被跳过。
 *
 * ⚠️ 后端选择的三条铁律（0.2.0 审计 F1 的教训：真机上两处数据 id 交集为 0）：
 *   1. **稳定且可纠正**：`storageDomain` 晚注册时，下一次请求/服务就绪事件里升级到 domain 后端，
 *      不是 apply 时一锤定音；
 *   2. **绝不静默切换**：当前后端与首选后端不一致、或两处都有数据时，在日志与 /health 里明确报出来；
 *   3. **合并而不是二选一**：升级时把两处记录按 id 取并集（同 id 取 updatedAt 较新者）写回首选后端，
 *      动手前把两个落盘文件都复制成 `.bak-<时间>` 备份。
 *   4. **升级成功后回退文件退役**（0.2.1 复审 R1）：改名成 `<path>.migrated-<时间>`，
 *      此后既不读它也不镜像它 —— 只写一次的「快照镜像」会让用户已删除的待办在下一次合并时复活。
 */

import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { repairRecord, repairStoreDocument } from './schema.mjs';

/** storage-domain 的领域名与表名（必须匹配后端的 UNIT_NAME_RE）。 */
const DOMAIN_NAME = 'worktodo';
const TABLE_NAME = 'todos';

/** 后端升级失败后的重试节流（同一个服务对象）：避免每个请求都重试 + 刷日志。 */
const UPGRADE_RETRY_MS = 5000;

/**
 * 挂载路径上等待官方 storage 打开的上限（S1-2，第四轮审计）：
 * `storageDomain.open()` 永不 resolve 时，`apply()` 也永不返回 —— 面板 404、工具全无，
 * 而且没有任何超时/告警。超过这个时间就按「官方存储暂不可用」降级到回退文件并告警。
 * 官方 open 正常是本地文件 IO（毫秒级），3 秒对正常路径毫无影响。
 * 测试可用 `WORKTODO_UPGRADE_TIMEOUT_MS` 覆盖（与 WORKTODO_TEST_FAULT 同一类测试缝）。
 */
const UPGRADE_TIMEOUT_MS = 3000;

/** 实际生效的超时（测试可注入更短的值；非法值一律回落到默认）。 */
function upgradeTimeoutMs() {
  const injected = Number(process.env.WORKTODO_UPGRADE_TIMEOUT_MS);
  return Number.isFinite(injected) && injected > 0 ? injected : UPGRADE_TIMEOUT_MS;
}

/** 每个回退文件最多保留几份 `.bak-`（超出的老备份会被清掉，复审 0.2.2 F9）。 */
const MAX_BACKUPS = 2;

/** 统一的错误消息取值（模块级：createDomainBackend 的 open 后清理也用它）。 */
function messageOf(error) {
  return String(error?.message ?? error);
}

/**
 * 解析 DSH 家目录：优先官方 @deepseek-ai/dsh-home-paths（与整个 harness 同一套规则：
 * 显式配置 > $DSH_HOME > ~/.dsh，空白环境变量视为未设置），拿不到就用等价实现。
 * 与 dsh-token-meter-panel 的 resolveSessionsRoot 同一策略，保持行为可预期。
 * @returns {Promise<string>}
 */
export async function resolveDshHome() {
  try {
    const official = await import('@deepseek-ai/dsh-home-paths');
    if (typeof official?.dshHomePath === 'function') {
      const p = official.dshHomePath();
      if (typeof p === 'string' && p) return p;
    }
    if (typeof official?.resolveDshHome === 'function') {
      const p = official.resolveDshHome();
      if (typeof p === 'string' && p) return p;
    }
  } catch {
    /* 老版本或未安装该库：走下面的等价实现 */
  }
  const raw = process.env.DSH_HOME;
  if (raw && raw.trim()) return raw.trim().replace(/^~(?=$|[/\\])/, homedir());
  return join(homedir(), '.dsh');
}

/** 时间戳（文件名安全）：20261013-171717。 */
function fileStamp(now = Date.now()) {
  const date = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * 备份一个文件（复制，原文件保留）：`<path>.bak-<时间>`。
 * 文件不存在时返回 null（没什么可备份的，不是错误）。
 * @param {string} path
 * @param {object} [logger]
 * @returns {string|null}
 */
function backupFile(path, logger) {
  if (!existsSync(path)) return null;
  // 同秒内的第二次备份不能覆盖第一次（退役时的备份会盖掉「合并前」那份，见复审 R1）
  const dest = uniqueSibling(`${path}.bak-${fileStamp()}`);
  try {
    copyFileSync(path, dest);
    return dest;
  } catch (error) {
    logger?.warn?.(`备份 ${path} 失败：${error?.message ?? error}`);
    return null;
  }
}

/**
 * 列出某个文件的所有 `.bak-<时间>` 备份（按文件名＝时间递增排序）。
 * @param {string} path
 * @returns {string[]} 绝对/相对路径列表
 */
function listBackups(path) {
  try {
    return readdirSync(dirname(path))
      .filter((name) => name.startsWith(`${basename(path)}.bak-`))
      .sort()
      .map((name) => join(dirname(path), name));
  } catch {
    return [];
  }
}

/**
 * 只保留最近 `keep` 份 `.bak-` 备份（复审 0.2.2 F9：失败重试 + 面板 30s 轮询会无限堆积）。
 * 删除失败只记日志，绝不影响合并/退役流程。
 * @param {string} path
 * @param {object} [logger]
 * @param {number} [keep]
 */
function pruneBackups(path, logger, keep = MAX_BACKUPS) {
  const backups = listBackups(path);
  for (const stale of backups.slice(0, Math.max(0, backups.length - keep))) {
    try {
      rmSync(stale, { force: true });
    } catch (error) {
      logger?.warn?.(`清理旧备份 ${stale} 失败：${error?.message ?? error}`);
    }
  }
}

/**
 * 把一个坏文件改名隔离（原始路径腾出来写新内容）：`<path>.corrupt-<时间>.bak`。
 * 用改名而不是复制：原内容仍完整保存在备份里，新文件不会覆盖它。
 * @param {string} path
 * @param {object} [logger]
 * @returns {string|null}
 */
function quarantineFile(path, logger) {
  if (!existsSync(path)) return null;
  let dest = `${path}.corrupt-${fileStamp()}.bak`;
  let n = 1;
  while (existsSync(dest)) dest = `${path}.corrupt-${fileStamp()}-${n++}.bak`;
  try {
    renameSync(path, dest);
    return dest;
  } catch (error) {
    logger?.warn?.(`备份坏文件 ${path} 失败：${error?.message ?? error}`);
    return null;
  }
}

/**
 * 找一个不冲突的兄弟路径（同秒内重复退役时用）：`<path>`、`<path>-1`、`<path>-2`…
 * @param {string} path
 * @returns {string}
 */
function uniqueSibling(path) {
  if (!existsSync(path)) return path;
  let n = 1;
  let dest = `${path}-${n}`;
  while (existsSync(dest)) dest = `${path}-${++n}`;
  return dest;
}

/**
 * 把无法解析的条目另存为 `<path>.dropped-<时间>.json`。
 * @param {string} path
 * @param {{index: number, reason: string, raw: unknown}[]} dropped
 * @param {object} [logger]
 * @returns {string|null}
 */
function writeDroppedBackup(path, dropped, logger) {
  const dest = `${path}.dropped-${fileStamp()}.json`;
  try {
    writeFileSync(dest, `${JSON.stringify({ at: Date.now(), source: path, dropped }, null, 2)}\n`, 'utf8');
    return dest;
  } catch (error) {
    logger?.warn?.(`备份被跳过的记录失败：${error?.message ?? error}`);
    return null;
  }
}

/**
 * 文件的原子写：先写同目录临时文件，再 rename 覆盖。
 * 直接 writeFileSync 到目标路径时，进程被杀或磁盘满会留下半个 JSON，
 * 用户的待办就全丢了；rename 在同一文件系统上是原子的。
 * @param {string} path
 * @param {string} text
 */
function writeAtomic(path, text) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

/** 落盘格式固定为「给人看」的形状：只写 version/updatedAt/todos，不把内部字段写进文件。 */
function serializeDoc(doc) {
  return `${JSON.stringify({ version: 1, updatedAt: doc.updatedAt, todos: doc.todos }, null, 2)}\n`;
}

/**
 * JSON 文件后端。
 * @param {object} options
 * @param {string} options.path 存储文件绝对路径
 * @param {object} [options.logger]
 */
function createFileBackend({ path, logger }) {
  // 写入串行化：并发写会让后一次覆盖前一次，这里排成一条链
  let chain = Promise.resolve();
  const enqueue = (job) => {
    const run = chain.then(job);
    // 链尾吞掉异常，避免一次失败毒化后续所有写入（错误仍由调用方那次拿到）
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  const emptyDoc = () => ({ version: 1, updatedAt: Date.now(), todos: [] });

  /**
   * 读整个文档，并把「文件不存在/空」（正常）与「文件读坏了」（damaged）区分开。
   * 读坏时返回 `damaged: true` + 空文档：**读**路径容忍坏文件，
   * 但**写**路径（put/remove/replaceAll）必须先备份原文件，绝不直接覆盖。
   */
  function readDoc() {
    if (!existsSync(path)) return { doc: emptyDoc(), damaged: false, dropped: [] };
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      const reason = `读取失败：${error?.message ?? error}`;
      logger?.warn?.(`待办文件读不出来（${reason}）；本次读取按空列表处理。写入时会先把原文件改名备份成 ${path}.corrupt-<时间>.bak 再写新内容，不会覆盖它`);
      return { doc: emptyDoc(), damaged: true, dropped: [], reason };
    }
    if (!text.trim()) return { doc: emptyDoc(), damaged: false, dropped: [] };
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      const reason = `解析失败：${error?.message ?? error}`;
      logger?.warn?.(`待办文件不是合法 JSON（${reason}）；本次读取按空列表处理。写入时会先把原文件改名备份成 ${path}.corrupt-<时间>.bak 再写新内容，原内容不会丢`);
      return { doc: emptyDoc(), damaged: true, dropped: [], reason };
    }
    const repaired = repairStoreDocument(parsed);
    if (repaired.dropped?.length) {
      logger?.warn?.(`待办文件里有 ${repaired.dropped.length} 条记录无法解析；写入时会先备份到 ${path}.dropped-<时间>.json`);
    }
    return { doc: repaired, damaged: false, dropped: repaired.dropped ?? [] };
  }

  /**
   * 写入前的数据保护：
   *   - 坏文件先改名隔离（`.corrupt-<时间>.bak`），新内容写到干净的路径上；
   *   - 被跳过的垃圾条目另存 `.dropped-<时间>.json`。
   * 返回备份路径，供日志/自检报告。
   */
  function protectBeforeWrite(read) {
    const backups = { corrupt: null, dropped: null };
    if (read.damaged) {
      backups.corrupt = quarantineFile(path, logger);
      if (backups.corrupt) {
        logger?.warn?.(`原待办文件已备份为 ${backups.corrupt}；接下来写的是新文件，原内容仍可从备份恢复`);
      }
    }
    if (read.dropped?.length) backups.dropped = writeDroppedBackup(path, read.dropped, logger);
    return backups;
  }

  return {
    kind: 'file',
    location: path,
    async load() {
      return readDoc().doc.todos;
    },
    async put(record) {
      return enqueue(() => {
        const read = readDoc();
        protectBeforeWrite(read);
        const doc = read.damaged ? emptyDoc() : read.doc;
        const index = doc.todos.findIndex((t) => t.id === record.id);
        if (index >= 0) doc.todos[index] = record;
        else doc.todos.push(record);
        doc.updatedAt = Date.now();
        writeAtomic(path, serializeDoc(doc));
      });
    },
    async remove(id) {
      return enqueue(() => {
        const read = readDoc();
        const doc = read.damaged ? emptyDoc() : read.doc;
        const next = doc.todos.filter((t) => t.id !== id);
        // 坏文件时列表按空处理：没有任何东西可删，此时**不动磁盘**（也就不会白白隔离原文件）
        if (next.length === doc.todos.length) return false;
        protectBeforeWrite(read);
        doc.todos = next;
        doc.updatedAt = Date.now();
        writeAtomic(path, serializeDoc(doc));
        return true;
      });
    },
    /**
     * 只改 `order` 的批量写（S3-1/S3-2/S4-1）。
     *
     * 为什么必须单独有这个方法：旧 `reorder` 逐条 `put(整条旧记录)`，每次 `put` 都要
     * 读整个文件 + 原子重写整个文件 —— 1000 条就是 1000 次整文件读 + 1000 次整文件写
     *（实测 3.9s / 404 MiB，事件循环全程冻结），而且写的是**读时刻的快照**，
     * 会静默覆盖拖拽期间另一窗口改的 title/priority。
     *
     * 这里在一个写队列任务里只读一次、只写一次，并且**基于刚读到的最新记录**只 patch
     * `order` 一个字段：并发写入的其它字段原样保留；没有任何 order 需要改时完全不碰磁盘。
     * @param {string[]} ids 新的完整顺序（ids[i] 的记录得到 order=i）
     * @returns {Promise<{updated: number}>}
     */
    async updateOrder(ids) {
      return enqueue(() => {
        const position = new Map((ids ?? []).map((id, index) => [id, index]));
        if (!position.size) return { updated: 0 };
        const read = readDoc();
        const doc = read.damaged ? emptyDoc() : read.doc;
        let updated = 0;
        const todos = doc.todos.map((record) => {
          if (!record?.id || !position.has(record.id)) return record;
          const order = position.get(record.id);
          if (record.order === order) return record;
          updated += 1;
          return { ...record, order }; // 只 patch order，绝不整条覆盖
        });
        if (!updated) return { updated: 0 };
        protectBeforeWrite(read);
        doc.todos = todos;
        doc.updatedAt = Date.now();
        writeAtomic(path, serializeDoc(doc)); // 整批一次原子写（读 1 次 / 写 1 次）
        return { updated };
      });
    },
    /** 整份替换：合并两处数据后把回退文件同步成同一份并集（保证再次降级也不会看到旧数据）。 */
    async replaceAll(records) {
      return enqueue(() => {
        const read = readDoc();
        protectBeforeWrite(read);
        const todos = records.map((record) => repairRecord(record));
        writeAtomic(path, serializeDoc({ version: 1, updatedAt: Date.now(), todos }));
      });
    },
    /** 文件后端没有变更事件，返回一个空注销函数保持接口一致。 */
    onChanged() {
      return () => {};
    },
    async close() {
      await chain;
    },
  };
}

/**
 * 官方 storage-domain 后端。
 * @param {object} options
 * @param {object} options.storageDomain ctx.storageDomain 服务
 * @param {object} [options.ctx] 用于订阅 domain/changed 的 cordis 上下文
 * @param {object} [options.logger]
 */
async function createDomainBackend({ storageDomain, ctx, logger }) {
  const { defineDomain, domainTable } = await import('@deepseek-ai/dsh-storage-domain');
  const { todoRecordSchema } = await import('./schema.mjs');
  const spec = defineDomain({
    name: DOMAIN_NAME,
    version: 1,
    tables: { todos: domainTable(todoRecordSchema) },
    // 单条记录坏掉时备份并跳过，而不是让整个领域打不开（用户宁可看到少一条，也不想面板全空）
    invalidRecords: 'backup-and-skip',
  });
  const domain = await storageDomain.open(spec);
  // ⚠️ S2-1（第四轮审计）：open() 成功之后的任何一步抛出（`table()` 抛、日志抛、
  // 构造后端时抛）都会让这个已经打开的领域句柄变成孤儿——`acquireDomain` 会把注册表项
  // 删掉，`domainEntry` 从未被赋值，`store.close()` 里 `releaseDomain(null)` 什么也不做。
  // 此后每次升级都撞官方 `already-open`，进程永远停在回退文件后端。
  // 所以 open 之后的所有步骤都必须包在 try 里，失败先 close 再抛。
  let table;
  let backend;
  try {
    table = domain.table(TABLE_NAME);
    logger?.info?.(`待办数据使用官方 storage（领域 ${DOMAIN_NAME}）`);
    backend = createDomainHandle({ domain, table, ctx, logger });
  } catch (error) {
    try {
      await domain.close();
      logger?.warn?.(`官方 storage 领域 ${DOMAIN_NAME} 打开后又失败，已释放句柄（不会留下 already-open）：${messageOf(error)}`);
    } catch (closeError) {
      logger?.warn?.(`释放打不开的领域 ${DOMAIN_NAME} 句柄失败：${messageOf(closeError)}`);
    }
    throw error;
  }
  return backend;
}

/**
 * 由已打开的官方领域句柄构造后端对象（独立出来是为了让 `createDomainBackend` 里
 * 「open 之后的步骤」都能被同一个 try/catch 罩住，见 S2-1）。
 * @param {object} options
 * @param {object} options.domain 官方 open() 返回的句柄
 * @param {object} options.table 领域表句柄
 * @param {object} [options.ctx]
 * @param {object} [options.logger]
 */
function createDomainHandle({ domain, table, ctx, logger }) {
  return {
    kind: 'domain',
    location: `storage:${DOMAIN_NAME}/${TABLE_NAME}`,
    async load() {
      const out = [];
      for (const [, value] of table.entries()) out.push(value);
      return out;
    },
    async put(record) {
      await table.put(record.id, repairRecord(record));
    },
    async remove(id) {
      return Boolean(await table.delete(id));
    },
    /**
     * 只改 `order` 的批量写（S3-1/S3-2/S4-1）：对每条记录做「读当前值 → 只 patch order → 写回」，
     * 绝不整条覆盖，所以并发窗口里改动的 title/priority/其它字段都会保留。
     * 优先用官方 KvTableImpl.update(key, fn)（在领域自己的写链内完成读-改-写）；
     * 老版本没有它时退化为 get + put（仍有极小窗口，但只影响顺序，不会丢字段）。
     */
    async updateOrder(ids) {
      const position = new Map((ids ?? []).map((id, index) => [id, index]));
      if (!position.size) return { updated: 0 };
      const keys = new Set();
      for (const [key] of table.entries()) keys.add(key);
      let updated = 0;
      for (const key of keys) {
        if (!position.has(key)) continue;
        const order = position.get(key);
        const current = typeof table.get === 'function' ? table.get(key) : undefined;
        if (!current || current.order === order) continue;
        if (typeof table.update === 'function') {
          try {
            await table.update(key, (record) => ({ ...record, order }));
          } catch (error) {
            // 并发删除：这一条跳过，其余照常（不因为一条消失就让整次拖拽失败）
            if (String(error?.message ?? error).includes('has no record')) continue;
            throw error;
          }
        } else {
          await table.put(key, repairRecord({ ...current, order }));
        }
        updated += 1;
      }
      return { updated };
    },
    /**
     * 订阅领域变更：agent 通过工具改了列表，面板可以据此刷新。
     * @param {(change: object) => void} listener
     * @returns {() => void} 注销函数
     */
    onChanged(listener) {
      const wrapped = (change) => {
        if (change?.domain !== DOMAIN_NAME) return;
        try {
          listener(change);
        } catch (error) {
          logger?.warn?.(`待办变更回调失败：${error?.message ?? error}`);
        }
      };
      return ctx?.on ? ctx.on('domain/changed', wrapped) : () => {};
    },
    async close() {
      try {
        await domain.close();
      } catch (error) {
        logger?.warn?.(`关闭待办领域失败：${error?.message ?? error}`);
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * 后端句柄共享：同一个 storageDomain 服务上领域只能 open 一次
 * （官方语义是第二次 open 抛 `already-open`）。
 * 0.2.0 审计里「二次挂载 → already-open → 静默降级到 JSON 文件」就是这里出的事：
 * 进程内多个插件实例共享同一份句柄，就不会再降级。
 * ------------------------------------------------------------------ */
const domainRegistry = new WeakMap();

/**
 * 取得（必要时打开）某个 storageDomain 服务上的待办领域，引用计数 +1。
 *
 * 「正在关闭」的哨兵（复审 R2）：卸载 → 立刻重载时，旧实例的 `close()` 可能还没跑完，
 * 此时**不能**直接复用那个半关闭的句柄（会写到正在关闭的领域上），也**不能**立刻
 * `open` 一个新的（会撞官方 `already-open`）。这里先等关闭落地，再从零打开。
 * @returns {Promise<{service: object, refs: number, backend: object|null}>}
 */
async function acquireDomain({ storageDomain, ctx, logger }) {
  let entry = domainRegistry.get(storageDomain);
  if (entry?.closing) {
    await entry.closing.catch(() => {});
    entry = domainRegistry.get(storageDomain);
  }
  if (!entry) {
    entry = {
      service: storageDomain,
      refs: 0,
      backend: null,
      closing: null,
      logger,
      promise: createDomainBackend({ storageDomain, ctx, logger }),
    };
    domainRegistry.set(storageDomain, entry);
  }
  try {
    entry.backend = await entry.promise;
  } catch (error) {
    // 打开失败不要把坏 promise 留在表里，否则后续实例会一直拿到同一个失败
    if (domainRegistry.get(storageDomain) === entry) domainRegistry.delete(storageDomain);
    throw error;
  }
  entry.refs += 1;
  return entry;
}

/**
 * 释放引用；最后一个使用者关闭时才真的关领域。
 *
 * ⚠️ 顺序很重要（复审 R2）：**先 await 关闭、再摘注册表**。反过来的话，
 * 「卸载后立刻重载」会在「已删注册表、还没关完」的窗口里撞官方 `already-open`，
 * 从而静默降级到回退文件（用户视角就是待办全没了）。关闭失败也必须摘，
 * 否则一个坏句柄会永远留在表里挡住后续挂载；失败只记日志，不影响卸载流程。
 * @param {{service: object, refs: number, backend: object|null, closing: Promise<void>|null, logger?: object}} entry
 */
async function releaseDomain(entry) {
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0) return;
  // 并发 close（多个实例同时卸载）：共用同一次关闭，不要重复关
  if (entry.closing) return entry.closing;
  let closeError = null;
  entry.closing = (async () => {
    try {
      await entry.backend?.close();
    } catch (error) {
      closeError = error;
    } finally {
      if (domainRegistry.get(entry.service) === entry) domainRegistry.delete(entry.service);
      entry.closing = null;
    }
  })();
  await entry.closing;
  if (closeError) {
    entry.logger?.warn?.(`关闭待办领域失败（已从注册表摘除，后续挂载会重新打开）：${closeError?.message ?? closeError}`);
  }
}

/**
 * 带超时地取得领域句柄（S1-2，第四轮审计）。
 *
 * 为什么必须有超时：官方 `open()` 正常是本地文件 IO（毫秒级），但只要它变慢或挂住
 *（后端实现问题、$DSH_HOME 在 NFS/网络盘、domain 内部死锁），`apply()` 就永远不返回 ——
 * 面板永远 404、工具永远不出现，而且没有任何超时/告警。`openWorkTodoStore` 是在
 * **挂载路径**上 await 它的，所以这里必须兜住。
 *
 * 竞态安全：超时后如果那个 open 又成功了，句柄不能泄漏（否则后续挂载永远撞 `already-open`，
 * 这正是 S2-1 的形态）。所以晚到的 entry 会立刻 `releaseDomain` 归还（close + 摘注册表）。
 * @param {{storageDomain: object, ctx?: object, logger?: object}} options
 * @returns {Promise<object>} entry
 */
async function acquireDomainWithTimeout(options) {
  const timeoutMs = upgradeTimeoutMs();
  let timedOut = false;
  const pending = acquireDomain(options).then(
    (entry) => {
      if (!timedOut) return entry;
      // 超时之后才打开成功：立刻归还句柄，绝不留在注册表里毒化后续挂载
      void releaseDomain(entry).catch(() => {});
      return null;
    },
    (error) => {
      // 超时之后才失败：错误已经作为超时上报过，这里必须吞掉，否则是未处理 rejection
      if (timedOut) return null;
      throw error;
    },
  );
  let timer = null;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, timeoutMs);
  });
  try {
    const entry = await Promise.race([pending, expired]);
    if (timedOut || !entry) {
      const error = new Error(`打开官方 storage 超过 ${timeoutMs}ms 仍未完成（open 可能挂住）`);
      error.code = 'STORAGE_OPEN_TIMEOUT';
      throw error;
    }
    return entry;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把回退文件改名退役（唯一一处真正会动的文件操作），带一个显式的测试故障注入点。
 *
 * 为什么要留注入点（复审 0.2.2 F3）：ESM 的 `node:fs` 命名空间是冻结的，测试无法替换
 * `renameSync`，而「改名失败」正是必须保证「不显示成功、不复活已删项」的那条路径。
 * 注入只在显式设置 `WORKTODO_TEST_FAULT=retire-rename` 时生效，生产路径零影响。
 * @param {string} from
 * @param {string} to
 */
function renameRetireFile(from, to) {
  if (process.env.WORKTODO_TEST_FAULT === 'retire-rename') {
    const error = new Error(`EACCES: permission denied, rename '${from}' -> '${to}'（注入）`);
    error.code = 'EACCES';
    throw error;
  }
  renameSync(from, to);
}

/**
 * 退役哨兵文件路径：`<回退文件>.retired`。
 *
 * 为什么需要它（复审 0.2.2 F1/F3）：
 *   1. 「回退文件已退役」是**持久事实**，不能只在「本进程成功合并 + 成功改名」之后才知道。
 *      旧实现里 rename 失败 → 下次启动完全不知道这个文件已经不该再当数据源，
 *      已删除的待办会随下一次并集复活；而「已退役 + 官方存储不在组合里」时
 *      面板还会显示空列表 + 零告警（用户真机上文件已经退役，这是真实场景）。
 *   2. rename **之前**先写哨兵：即使改名一直失败，下次启动也会知道「这个文件已不是真源」。
 * @param {string} path 回退文件路径
 */
function retiredMarkerPath(path) {
  return `${path}.retired`;
}

/**
 * 写退役哨兵（JSON，人能直接看）。失败只记日志：哨兵丢了还有 `.migrated-*` 兄弟文件兜底。
 * @param {string} path
 * @param {{at: number, path: string, movedTo: string|null, backup: string|null, error: string|null, alreadyRetired: boolean, note: string}} info
 * @param {object} [logger]
 * @returns {string|null} 哨兵路径；写失败返回 null
 */
function writeRetiredMarker(path, info, logger) {
  const marker = retiredMarkerPath(path);
  const { alreadyRetired, ...rest } = info;
  try {
    writeAtomic(marker, `${JSON.stringify({ version: 1, retiredFile: path, ...rest, alreadyRetired: true }, null, 2)}\n`);
    return marker;
  } catch (error) {
    logger?.warn?.(`写退役标记 ${marker} 失败：${error?.message ?? error}`);
    return null;
  }
}

/**
 * 读退役哨兵；没有就返回 null。
 * @param {string} path
 * @returns {object|null}
 */
function readRetiredMarker(path) {
  const marker = retiredMarkerPath(path);
  if (!existsSync(marker)) return null;
  try {
    const parsed = JSON.parse(readFileSync(marker, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    // 哨兵坏了也等于「这里曾经退役过」：数据在官方存储，绝不能把这个文件当数据源
    return {};
  }
}

/**
 * 从「目录里只有 `.migrated-*`，没有回退文件」推断退役事实（旧版本退役后没有哨兵）。
 * @param {string} path
 * @returns {string|null} 最新的 `.migrated-*` 路径；没找到返回 null
 */
function findMigratedSibling(path) {
  try {
    const siblings = readdirSync(dirname(path))
      .filter((entry) => entry.startsWith(`${basename(path)}.migrated-`))
      .sort();
    return siblings.length ? join(dirname(path), siblings[siblings.length - 1]) : null;
  } catch {
    return null;
  }
}

/**
 * 按 id 取并集：同 id 取 `updatedAt` 较新的那条；时间相同则保留 preferred 里的那条。
 * @param {object[]} preferred 首选后端里的记录
 * @param {object[]} incoming 另一处后端里的记录
 * @returns {{todos: object[], conflicts: number, added: number}}
 */
export function unionById(preferred = [], incoming = []) {
  const map = new Map();
  for (const record of preferred) if (record?.id) map.set(record.id, record);
  let conflicts = 0;
  let added = 0;
  for (const record of incoming) {
    if (!record?.id) continue;
    const previous = map.get(record.id);
    if (!previous) {
      map.set(record.id, record);
      added += 1;
      continue;
    }
    conflicts += 1;
    const previousAt = Number.isFinite(previous.updatedAt) ? previous.updatedAt : 0;
    const nextAt = Number.isFinite(record.updatedAt) ? record.updatedAt : 0;
    if (nextAt > previousAt) map.set(record.id, record);
  }
  return { todos: [...map.values()], conflicts, added };
}

/**
 * 尽力读取官方 storage 落盘文件里的待办 id（只用于「两处数据是否分裂」的检测，不解析记录内容）。
 * @returns {Set<string>|null} null 表示读不出来（不据此下结论）
 */
function readStoredIds(path) {
  try {
    if (!existsSync(path)) return null;
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    const table = doc?.tables?.[TABLE_NAME];
    if (!table || typeof table !== 'object') return new Set();
    return new Set(Object.values(table)
      .map((record) => (record && typeof record === 'object' && typeof record.id === 'string' ? record.id : null))
      .filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * 可纠正的存储句柄：默认先用 JSON 文件活着，storageDomain 一就绪就升级到官方 storage，
 * 并把两处数据按 id 合并；不一致/分裂状态一路记在 `describe()` 里，绝不静默。
 */
function createResilientStore({ ctx, logger }) {
  const listeners = new Set();
  const state = {
    preferred: 'domain',
    kind: 'file',
    location: null,
    mismatch: null,
    split: null,
    merge: null,
    upgrades: 0,
    // 升级成功后回退文件的退役信息（复审 R1：退役后它既不是数据源也不是镜像）
    retired: null,
    // 当前用的是哪个后端（'file' | 'domain' | null）—— 必须显式记，
    // 不能靠 `state.retired` 是否存在来推断（复审 0.2.2 F1：退役 + 官方存储不可用
    // 时，旧写法会让面板显示空列表且零告警）
    backendUsable: 'file',
    // 当前后端最近一次读/写失败的原因（复审 R1 第 3 条：出错要显式报，不静默换源）
    backendError: null,
    // 同一个「故障轮次」里已经备份过的文件（S2-2：同一次故障只复制一份，
    // 不再靠 5 秒时间窗——那个窗口与 UPGRADE_RETRY_MS 相等，重试常常刚好落在窗外）
    backups: {
      merge: { path: null, dest: null, at: 0, size: -1 },
      retire: { path: null, dest: null, at: 0, size: -1 },
    },
    // 每个 slot 是否处在「一次尚未恢复的故障」里：成功一次就复位
    backupFault: { merge: false, retire: false },
  };
  let current = null;
  let ownedFile = null;
  let domainEntry = null;
  let domainUnsubscribe = null;
  let lastAttempt = { service: undefined, at: 0 };
  let upgrading = null;
  let homePromise = null;
  let closed = false;

  const home = async () => (homePromise ??= resolveDshHome());
  const fallbackPath = async () => join(await home(), 'worktodo', 'todos.json');
  const officialPath = async () => join(await home(), 'storages', `${DOMAIN_NAME}.json`);

  const emit = (change) => {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch (error) {
        logger?.warn?.(`待办变更监听失败：${messageOf(error)}`);
      }
    }
  };

  function adopt(backend) {
    current = backend;
    state.kind = backend.kind;
    state.location = backend.location;
    state.backendUsable = backend.kind;
  }

  /**
   * 备份一个文件，并记住「哪个文件 → 哪份备份 → 多大」。
   *
   * **同一次故障只备份一次**（S2-2，第四轮审计）：`state.backupFault[slot]` 标记
   * 「这个 slot 正处在一次尚未恢复的故障里」——只要还在故障里，且路径与大小都没变，
   * 就复用第一份备份；只有成功一次（合并成功 / 退役成功）才复位，下一次独立故障才重新备份。
   *
   * 为什么把时间窗换掉：旧实现用 `BACKUP_REUSE_MS(5000)` 时间窗，而升级重试节流
   * `UPGRADE_RETRY_MS` 也是 5000 —— 重试周期常常刚好落在复用窗口之外，于是每一轮失败重试
   * 都 `copyFileSync` 一整份文件（复制完马上被轮转删掉）：持续故障下每小时约 1214 MiB 读、
   * 607 MiB 备份复制、1440 条 warn。故障轮次标记与时间无关，不会漏。
   *
   * 文件大小变了仍然重新备份（真正的数据保护：备份必须对应那一刻的内容），
   * 并顺手把超过 MAX_BACKUPS 的老备份清掉。
   * @param {'merge'|'retire'} slot
   * @param {string} path
   * @returns {string|null}
   */
  function recordBackup(slot, path) {
    if (!path || !existsSync(path)) return null;
    let size = -1;
    try {
      size = statSync(path).size;
    } catch {
      size = -1;
    }
    const previous = state.backups[slot];
    if (state.backupFault[slot]
      && previous.path === path
      && previous.dest
      && previous.size === size
      && size >= 0
      && existsSync(previous.dest)) {
      return previous.dest;
    }
    const dest = backupFile(path, logger);
    state.backups[slot] = { path, dest, at: Date.now(), size };
    state.backupFault[slot] = true;
    if (dest) pruneBackups(path, logger);
    return dest;
  }

  /** 故障恢复：下一次独立故障可以重新备份（S2-2）。 */
  function clearBackupFault(slot) {
    state.backupFault[slot] = false;
  }

  /**
   * 启动时判断「回退文件是否已经退役」（只看磁盘，不写任何东西）。
   *
   * 两个来源（复审 0.2.2 F1）：
   *   1. 退役哨兵 `<path>.retired`：进程内退役或上次退役时写的，是**权威**事实；
   *   2. 旧版本只留下 `.migrated-*` 兄弟、原路径不存在：同样说明「数据在官方存储」。
   *
   * `hadFile` 用于区分「全新安装，什么都没有」和「曾经有文件、后来退役了」——
   * 前者不是退役，面板说什么都不合适。
   * @param {string} path
   * @returns {{retired: object|null, hadFile: boolean}}
   */
  function detectRetiredState(path) {
    const hadFile = existsSync(path);
    const markerPath = retiredMarkerPath(path);
    const markerExists = existsSync(markerPath);
    const marker = readRetiredMarker(path);

    if (marker) {
      return {
        hadFile,
        retired: {
          at: Number(marker.at) || Date.now(),
          path,
          movedTo: typeof marker.movedTo === 'string' ? marker.movedTo : null,
          backup: typeof marker.backup === 'string' ? marker.backup : null,
          error: typeof marker.error === 'string' ? marker.error : null,
          // 走到这里就说明「是上一次运行退役的」：不要再被哨兵里 pending 时的 false 覆盖
          alreadyRetired: true,
          marker: markerExists ? markerPath : null,
          note: typeof marker.note === 'string' && marker.note
            ? marker.note
            : `回退文件已退役；当前数据只以官方 storage 为准`,
        },
      };
    }

    if (!hadFile) {
      const movedTo = findMigratedSibling(path);
      if (movedTo) {
        return {
          hadFile: false,
          retired: {
            at: Date.now(),
            path,
            movedTo,
            backup: null,
            error: null,
            alreadyRetired: true,
            marker: null,
            note: `回退文件此前已迁移并退役，路径=${movedTo}；当前数据只以官方 storage 为准`,
          },
        };
      }
    }

    return { retired: null, hadFile };
  }

  /**
   * 退役后的唯一真源是官方 storage。官方领域服务不在组合里（或打开失败）时，
   * **绝不能**静默返回空列表 —— 那会让用户以为待办全没了（复审 0.2.2 F1，真机上文件已退役）。
   *
   * 返回 true = 当前状态不可用，本实例只应报错、不应读那个已退役的文件。
   * 注意：文件因为改名失败还在原地时，也走这条路径 —— 它已经**不是**真源，
   * 再拿它当合并源正是「已删除的待办复活」的入口（复审 0.2.2 F3）。
   */
  function ensureRetiredFallbackReadable() {
    if (!state.retired || state.backendUsable === 'domain') return false;
    const when = new Date(state.retired.at).toISOString();
    const archive = state.retired.movedTo ?? state.retired.marker ?? state.retired.path;
    // 先记进 state（describe/health 立刻可见），再抛给调用方走既有失败路径
    state.mismatch = `官方存储不可用，且回退文件已于 ${when} 退役（${state.retired.path}）`
      + `；本次无法读取待办（档案：${archive}）。请在带 storage 的组合里启动，或手动恢复这个文件`;
    if (!state.backendError) {
      state.backendError = state.mismatch;
      logger?.warn?.(`⚠️ ${state.mismatch}`);
    }
    return true;
  }

  /** 退役 + 官方存储不可用时的统一错误（load/put/remove 都走这条失败路径）。 */
  function retiredUnavailableError() {
    const error = new Error(state.mismatch ?? '官方存储不可用，且回退文件已退役');
    error.code = 'RETIRED_FALLBACK_UNAVAILABLE';
    return error;
  }

  /**
   * 升级成功后把回退文件**退役**：先备份（`.bak-<时间>`），再改名成 `.migrated-<时间>`。
   *
   * 为什么必须退役（0.2.1 复审 R1，实跑 exp8）：
   *   `mergeInto` 只用「升级那一刻的快照」覆盖回退文件，之后 `put/remove` 全部落在 domain，
   *   回退文件从此不再更新；而合并是**并集**（没有墓碑），于是下一次以文件为 source 的
   *   合并（重载 / domain 重开）会把用户**已经删掉的待办复活**。
   *   退役后 domain 是唯一真源，文件不再有机会当 source，也不会长期落后。
   *
   * 文件名带时间戳，等于同时保留了「迁移时的完整存档」，用户可以手动查看/恢复。
   *
   * 复审 0.2.2 的两条修正：
   *   F3：**先把退役哨兵写下来**再改名。rename 失败时文件虽然还在原地，但它已经
   *       「被判定退役」——下次启动不会再把它当合并源，已删除的待办也就不会复活；
   *       面板文案是 warn + 原始错误 + 处理建议，绝不说「已迁移并退役」。
   *   F8：只有 `renameSync` 在 try 里。成功分支的记账/日志放到 try 外面，
   *       免得 `logger.info` 之类抛错被 catch 误报成「退役失败」。
   */
  function retireFallbackFile() {
    if (state.retired) return state.retired;
    const path = ownedFile?.location;
    if (!path) return null;

    const hadFile = existsSync(path);
    const marker = retiredMarkerPath(path);

    if (!hadFile) {
      // 文件本来就不存在：识别「此前已退役」（`.migrated-*` 兄弟）并顺手补一个哨兵。
      // 全新安装什么都不留，state.retired 保持 null。
      const found = findMigratedSibling(path);
      if (!found) return state.retired;
      const info = {
        at: Date.now(),
        path,
        movedTo: found,
        backup: null,
        error: null,
        alreadyRetired: true,
        note: `回退文件此前已迁移并退役，路径=${found}；当前数据只以官方 storage 为准`,
      };
      if (!existsSync(marker)) writeRetiredMarker(path, info, logger);
      state.retired = { ...info, marker: existsSync(marker) ? marker : null };
      return state.retired;
    }

    const backup = recordBackup('retire', path);
    const dest = uniqueSibling(`${path}.migrated-${fileStamp()}`);

    // 1. 先落哨兵：从这一刻起这个文件不再是数据源（即使下面 rename 失败）
    const pending = {
      at: Date.now(),
      path,
      movedTo: null,
      backup,
      error: null,
      alreadyRetired: false,
      note: `回退文件已判定退役，等待改名到 ${dest}`,
    };
    writeRetiredMarker(path, pending, logger);

    // 2. 再改名。只有这一步的失败才算「退役失败」
    let renameError = null;
    try {
      renameRetireFile(path, dest);
    } catch (error) {
      renameError = error;
    }

    if (renameError) {
      state.retired = {
        ...pending,
        error: messageOf(renameError),
        marker: existsSync(marker) ? marker : null,
        note: `回退文件退役失败（${messageOf(renameError)}）：${path} 仍然存在`,
      };
      // 也把失败写进哨兵：下次启动照样知道它不是数据源
      writeRetiredMarker(path, state.retired, logger);
      logger?.warn?.(`⚠️ ${state.retired.note}；官方 storage 里的数据不受影响；`
        + `该文件已被排除在合并源之外（不会把已删除的待办补回来），请手动改名或删除它`
        + (backup ? `；退役前备份：${backup}` : ''));
      return state.retired;
    }

    state.retired = {
      ...pending,
      movedTo: dest,
      note: `已把回退文件迁移并退役，路径=${dest}`,
      marker: existsSync(marker) ? marker : null,
    };
    writeRetiredMarker(path, state.retired, logger);
    clearBackupFault('retire'); // 退役成功（S2-2）：下一次独立故障可以重新备份
    // 日志在 try 之外（F8）：日志抛错也不能把「退役成功」说成失败
    try {
      logger?.info?.(`${state.retired.note}${backup ? `（退役前备份：${backup}）` : ''}；`
        + '此后待办数据只以官方 storage 为准，这个文件不会再被读写作数据源');
    } catch { /* 日志不该影响数据路径 */ }
    return state.retired;
  }

  /**
   * 升级到官方 storage，并把两处记录合并过去。任何一步失败都只记录不一致状态，
   * **不改变当前后端**（继续用回退文件活着，但 health/日志里明确报出来）。
   */
  async function tryUpgrade({ force = false } = {}) {
    if (closed) return false;
    if (state.preferred !== 'domain') return false;
    if (current?.kind === 'domain') return false;
    const service = ctx?.get?.('storageDomain');
    if (!service || typeof service.open !== 'function') {
      // 服务确实不在这个组合里：回退文件是设计内的，不算「后端不一致」
      state.mismatch = null;
      return false;
    }
    if (!force && lastAttempt.service === service && Date.now() - lastAttempt.at < UPGRADE_RETRY_MS) return false;
    lastAttempt = { service, at: Date.now() };

    let entry;
    try {
      entry = await acquireDomainWithTimeout({ storageDomain: service, ctx, logger });
    } catch (error) {
      const timedOut = error?.code === 'STORAGE_OPEN_TIMEOUT';
      state.mismatch = timedOut
        ? `首选官方 storage（领域 ${DOMAIN_NAME}）但打开超时（>${upgradeTimeoutMs()}ms）：官方存储暂不可用，本次降级用回退文件；`
          + (existsSync(ownedFile?.location ?? '')
            ? `当前仍在使用 JSON 文件 ${ownedFile?.location ?? '?'}`
            : `回退文件已退役/不存在，本次列表为空（官方 storage 里仍有数据，稍后会自动重试打开）`)
        : `首选官方 storage（领域 ${DOMAIN_NAME}）但打开失败：${messageOf(error)}；`
          + (existsSync(ownedFile?.location ?? '')
            ? `当前仍在使用 JSON 文件 ${ownedFile?.location ?? '?'}`
            : `回退文件已退役/不存在，本次列表为空（官方 storage 里仍有数据，打开失败原因见上）`);
      logger?.warn?.(`⚠️ ${state.mismatch}`);
      return false;
    }

    try {
      // 回退文件已退役（含 rename 失败但已写哨兵的情况）：它**不是**数据源，
      // 绝不能把它并进 domain —— 那个文件可能落后，并集会把用户已删除的待办复活（复审 0.2.2 F3）。
      if (!state.retired) await mergeInto(entry.backend);
    } catch (error) {
      state.mismatch = `官方 storage 已就绪，但合并两处数据失败：${messageOf(error)}；`
        + (existsSync(ownedFile?.location ?? '')
          ? `当前仍在使用 JSON 文件 ${ownedFile?.location ?? '?'}`
          : `回退文件已退役/不存在，本次列表为空`);
      logger?.warn?.(`⚠️ ${state.mismatch}`);
      await releaseDomain(entry);
      return false;
    }

    domainEntry = entry;
    domainUnsubscribe?.();
    domainUnsubscribe = entry.backend.onChanged?.(emit) ?? null;
    // 合并成功 = 数据已经在 domain 里了：退役回退文件，让 domain 成为唯一真源（复审 R1）
    const sourceWasFile = current?.kind === 'file';
    adopt(entry.backend);
    if (sourceWasFile) {
      const retired = retireFallbackFile();
      if (retired && state.merge) state.merge.fallbackRetiredTo = retired.movedTo ?? null;
    }
    state.mismatch = null;
    state.split = null;
    state.upgrades += 1;
    logger?.info?.(`待办数据已升级到官方 storage（${entry.backend.location}）`);
    return true;
  }

  /** 升级失败后的重试节流 + 并发去重。 */
  function refreshBackend() {
    if (closed) return Promise.resolve(false);
    if (state.preferred !== 'domain' || current?.kind === 'domain') return Promise.resolve(false);
    if (upgrading) return upgrading;
    upgrading = tryUpgrade().finally(() => { upgrading = null; });
    return upgrading;
  }

  /**
   * 当前后端读/写失败时的统一处理：记进 `describe()`/health 并打日志，然后**原样抛出**。
   * 绝不因为 domain 出错就静默改用回退文件 —— 升级后那个文件已经退役（复审 R1 第 3 条），
   * 「静默换源」正是「待办看着没了 / 已删除的又回来」的根源。
   */
  function reportBackendError(operation, error) {
    state.backendError = `当前后端（${current?.kind ?? '?'}）${operation}失败：${messageOf(error)}`
      + (state.retired
        ? `；回退文件已退役（${state.retired.movedTo ?? state.retired.path}），不会静默改用它`
        : '');
    logger?.warn?.(`⚠️ ${state.backendError}`);
  }

  /**
   * 所有公开读/写都先确保后端就绪，再执行；成功清掉错误标记，失败显式上报。
   *
   * 复审 0.2.2 F12：升级检查（`refreshBackend`）原来在 try 之外，它抛出的任何异常
   * 会绕开 `backendError` 直接冒给调用方（`init()` 里没有兜底 → `apply()` 挂载失败，
   * 工具与路由全没）。这里把「确保就绪」也纳入同一个 try，并保证 `current` 一定有值：
   * 任何异常都变成显式错误状态，而不是让插件挂不上。
   */
  async function currentOp(operation, run) {
    try {
      await refreshBackend();
      if (!current) throw new Error('待办存储未初始化完成（后端不可用）');
      if (ensureRetiredFallbackReadable()) throw retiredUnavailableError();
      const result = await run(current);
      state.backendError = null;
      return result;
    } catch (error) {
      reportBackendError(operation, error);
      throw error;
    }
  }

  /**
   * 把当前后端（正常是 JSON 文件）里的记录与官方 storage 里的记录按 id 合并，
   * 写回官方 storage；动手前备份两个落盘文件。
   *
   * 复审 0.2.2 F2：合并必须对目标端「全有或全无」。旧实现逐条 `put`，中途失败就
   * 在 domain 留下半截数据；用户随后在文件侧删掉的那条，会在 domain 恢复后
   * 被下一次并集**复活**。这里的做法是：
   *   1. 写之前先把所有记录过一遍 `repairRecord`（schema 类确定性失败挡在写之前）；
   *   2. 记下每条 key 合并前的值（不存在 = undefined）；
   *   3. 中途失败 → 逐条恢复到「合并前」（新增的删掉、覆盖过的写回原值），
   *      并把失败原因一并报出来（回滚本身失败也不吞掉原始错误）。
   */
  async function mergeInto(target) {
    const source = current;
    const sourceRecords = (await source.load()) ?? [];
    const targetRecords = (await target.load()) ?? [];

    // 备份两个后端的落盘文件（存在才备份，原文件不动；同一轮内复用，复审 F9）
    const backups = [];
    const seen = new Set();
    for (const candidate of [ownedFile?.location, await officialPath()]) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      const backup = recordBackup('merge', candidate);
      if (backup) backups.push(backup);
    }

    const { todos, conflicts, added } = unionById(targetRecords, sourceRecords);
    // 1. 全量校验：schema 拒绝之类的确定性失败绝不能留下半截写入
    const records = todos.map((record) => repairRecord(record));

    // 2. 逐条写，同时记住合并前的值，失败时全部还原
    const previous = new Map(targetRecords.filter((record) => record?.id).map((record) => [record.id, record]));
    const writeErrors = [];
    for (const record of records) {
      try {
        await target.put(record);
      } catch (error) {
        writeErrors.push(`${record.id}：${messageOf(error)}`);
        break;
      }
    }

    if (writeErrors.length) {
      const rollbackErrors = [];
      for (const record of records) {
        try {
          if (previous.has(record.id)) await target.put(previous.get(record.id));
          else await target.remove(record.id);
        } catch (error) {
          rollbackErrors.push(`${record.id}：${messageOf(error)}`);
        }
      }
      state.merge = {
        at: Date.now(),
        from: source.kind,
        into: target.kind,
        merged: 0,
        conflicts,
        added,
        backups,
        mirror: null,
        mirrorError: null,
        aborted: true,
        writeError: writeErrors.join('；'),
        rollbackError: rollbackErrors.length ? rollbackErrors.join('；') : null,
      };
      const rollbackNote = rollbackErrors.length
        ? `；回滚也有 ${rollbackErrors.length} 条失败（${rollbackErrors.join('；')}），目标端可能仍有本次残留`
        : '；已回滚到合并前状态（目标端没有留下半截数据）';
      logger?.warn?.(`⚠️ 合并两处待办失败：${state.merge.writeError}${rollbackNote}`);
      throw new Error(`合并写入失败：${state.merge.writeError}${rollbackNote}`);
    }

    // 退役前把回退文件写成同一份并集：这样 `.migrated-<时间>` 里留下的是一份
    // **完整的迁移存档**（用户随时能查/能恢复），而不是升级那一刻的半截快照。
    // 写完之后这个文件就被 `retireFallbackFile()` 改名退役，不会再被当作数据源。
    // 同步失败不影响官方 storage 里已经写好的数据，只记一行并继续升级。
    let mirror = null;
    let mirrorError = null;
    if (source.kind === 'file' && sourceRecords.length) {
      try {
        await source.replaceAll(records);
        mirror = source.location;
      } catch (error) {
        mirrorError = String(error?.message ?? error);
        logger?.warn?.(`回退文件同步失败（官方 storage 里的数据已合并好，不受影响）：${mirrorError}`);
      }
    }

    state.merge = {
      at: Date.now(),
      from: source.kind,
      into: target.kind,
      merged: records.length,
      conflicts,
      added,
      backups,
      mirror,
      mirrorError,
    };
    clearBackupFault('merge'); // 故障恢复（S2-2）：下一次独立故障可以重新备份
    logger?.info?.(`已按 id 合并两处待办（${source.kind} → ${target.kind}）：合并后 ${records.length} 条`
      + `（同 id 冲突 ${conflicts} 条取 updatedAt 较新者；从另一处补入 ${added} 条）`
      + (backups.length ? `；备份：${backups.join('、')}` : '；无需备份'));
    return state.merge;
  }

  /**
   * 当前用回退文件、但官方 storage 文件里已有数据 → 明确报出「两处数据不一致」。
   *
   * 复审 0.2.2 F1：**本地为空不等于健康**。旧实现在 `localIds.size === 0` 时直接 return，
   * 于是「回退文件已退役（或被清空）而官方 storage 里有 N 条」这种最需要告警的状态
   * 反而零输出。现在空列表照样报告，并且区分「文件不存在/已退役」与「文件在但为空」。
   */
  async function detectSplit() {
    const official = await officialPath();
    const officialIds = readStoredIds(official);
    if (!officialIds || !officialIds.size) return;
    let local = [];
    let localError = null;
    try {
      local = (await ownedFile.load()) ?? [];
    } catch (error) {
      localError = messageOf(error);
    }
    const localIds = new Set(local.map((record) => record.id));
    const onlyOfficial = [...officialIds].filter((id) => !localIds.has(id));
    const onlyLocal = [...localIds].filter((id) => !officialIds.has(id));
    const fileExists = existsSync(ownedFile?.location ?? '');
    if (localIds.size && !onlyOfficial.length && !onlyLocal.length) return;
    const localState = localError
      ? `回退文件读不出来（${localError}）`
      : (fileExists
        ? `回退文件里 ${localIds.size} 条`
        : (state.retired
          ? `回退文件已于 ${new Date(state.retired.at).toISOString()} 退役，原路径不存在`
          : '回退文件不存在'));
    state.split = `官方 storage 文件里 ${officialIds.size} 条、${localState}；`
      + `官方独有 ${onlyOfficial.length} 条、文件独有 ${onlyLocal.length} 条（本次列表为空/不完整）`;
    logger?.warn?.(`⚠️ 检测到两处待办数据不一致：${state.split}。`
      + 'storageDomain 服务就绪后会自动按 id 合并，不会丢记录；在此之前面板只显示回退文件里的那部分');
  }

  async function init() {
    const path = await fallbackPath();
    ownedFile = createFileBackend({ path, logger });
    // 先认「这个文件是否已经退役」（只看磁盘）：这一步必须在 tryUpgrade 之前，
    // 因为退役事实决定了「官方存储不可用时能不能读这个文件」（复审 0.2.2 F1）
    const { retired } = detectRetiredState(path);
    if (retired) state.retired = retired;
    adopt(ownedFile);
    // F12：init 里的升级必须有兜底 —— 「首次升级抛异常」原来会让 openWorkTodoStore
    // reject，进而让 apply() 挂载失败（工具与路由全没，历史事故类别）。失败降级为显式状态。
    let upgraded = false;
    try {
      upgraded = await tryUpgrade({ force: true });
    } catch (error) {
      state.mismatch = `启动时升级官方 storage 失败：${messageOf(error)}；本次先用 JSON 文件 ${path}`;
      state.backendError = state.mismatch;
      logger?.warn?.(`⚠️ ${state.mismatch}`);
    }
    if (!upgraded) {
      logger?.info?.(`待办数据使用 JSON 文件：${path}`);
      await detectSplit();
    }
    // 退役 + 官方存储不可用：这里就把状态摆明（面板页脚与 /health 都要能看见）
    ensureRetiredFallbackReadable();
  }

  return {
    get kind() { return current?.kind ?? state.kind; },
    get location() { return current?.location ?? state.location; },
    async load() {
      return currentOp('读取', (backend) => backend.load());
    },
    async put(record) {
      return currentOp('写入', (backend) => backend.put(record));
    },
    async remove(id) {
      return currentOp('删除', (backend) => backend.remove(id));
    },
    /**
     * 只改 `order` 的批量写（S3-1/S3-2/S4-1）：交给当前后端在一次读-改-写周期里完成，
     * 文件后端 = 读 1 次 + 原子写 1 次（不再是 N 次整文件重写），domain 后端 = 逐条在写链里 patch。
     * 取消/加载失败走与其它写操作一致的显式错误路径。
     * @param {string[]} ids 新的完整顺序
     * @returns {Promise<{updated: number}>}
     */
    async updateOrder(ids) {
      return currentOp('排序', (backend) => {
        if (typeof backend.updateOrder !== 'function') {
          const error = new Error('当前存储后端不支持只改排序字段的批量写');
          error.code = 'ORDER_UNSUPPORTED';
          throw error;
        }
        return backend.updateOrder(ids);
      });
    },
    /** 变更订阅：文件后端下没有事件（永远不触发）；升级到 domain 后由领域事件驱动。 */
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 供 apply 的 `ctx.inject(['storageDomain'])` 回调与测试主动触发升级。 */
    refreshBackend,
    init,
    /** 存储自检：后端、位置、首选后端、不一致/分裂警告、最近一次合并报告、回退文件退役状态。 */
    describe() {
      return {
        kind: current?.kind ?? state.kind,
        location: current?.location ?? state.location,
        preferred: state.preferred,
        mismatch: state.mismatch,
        split: state.split,
        merge: state.merge,
        upgrades: state.upgrades,
        // 复审 R1：升级后回退文件已退役，health/面板必须能看见这件事
        retired: state.retired,
        // 复审 R1：当前后端出错时显式上报（不再有「静默换源」这种可能）
        backendError: state.backendError,
        // 复审 0.2.2 F1：退役 + 官方存储不可用必须能被面板一眼判定
        backendUsable: state.backendUsable,
        domainUnavailable: Boolean(state.retired) && state.backendUsable !== 'domain',
      };
    },
    async close() {
      closed = true;
      domainUnsubscribe?.();
      domainUnsubscribe = null;
      try {
        await ownedFile?.close();
      } catch { /* 关闭失败不应打断卸载 */ }
      // 升级可能在飞行中：等它落地再释放，否则 releaseDomain 拿不到 entry、
      // 领域句柄会泄漏，后续挂载一直撞 already-open（复审 R4/R2）
      try {
        await upgrading;
      } catch { /* 升级失败的异常已经由 tryUpgrade 自己记录 */ }
      const entry = domainEntry;
      domainEntry = null;
      await releaseDomain(entry);
    },
  };
}

/**
 * 打开待办存储：能用官方 storage 就用，否则回退 JSON 文件。
 *
 * 显式 `storePath` 时直接返回文件后端（尊重用户选择，不做任何探测/升级）；
 * 否则返回一个可纠正的句柄：storageDomain 晚注册时会在后续请求/服务就绪事件里升级并合并数据。
 * @param {object} options
 * @param {object} [options.ctx] cordis 上下文（用于探测服务与订阅事件）
 * @param {object} [options.config] 组合配置（可用 storePath 指定文件位置）
 * @param {object} [options.logger]
 * @returns {Promise<object>} 存储句柄
 */
export async function openWorkTodoStore({ ctx, config = {}, logger } = {}) {
  const loggerLike = logger ?? (typeof ctx?.logger === 'function' ? ctx.logger('worktodo') : ctx?.logger);

  // ---- 手动指定了路径就尊重用户：只走文件后端，不探测、不升级 ----
  const explicitPath = typeof config?.storePath === 'string' && config.storePath.trim()
    ? config.storePath.trim().replace(/^~(?=$|[/\\])/, homedir())
    : null;

  if (explicitPath) {
    loggerLike?.info?.(`待办数据使用 JSON 文件：${explicitPath}`);
    return createFileBackend({ path: explicitPath, logger: loggerLike });
  }

  // ctx.get 对未提供的服务返回 undefined，不抛错；storageDomain 可能晚注册，
  // 所以这里只是**首次探测**，之后每次请求与 inject 回调都会再检查一遍。
  // ⚠️ 只用 ctx.get 探测，**绝不**退回 `ctx.storageDomain`：直接访问未在 inject 里声明的服务
  // 会被 cordis 守卫抛错（"cannot get property … without inject"），而那个异常会让整个插件挂载失败——
  // 实测插件「时好时坏」就是这里（服务尚未注册时 ctx.get 返回 undefined，兜底访问随即抛错）
  const store = createResilientStore({ ctx, logger: loggerLike });
  await store.init();
  return store;
}
