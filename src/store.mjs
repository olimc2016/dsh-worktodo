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

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { repairRecord, repairStoreDocument } from './schema.mjs';

/** storage-domain 的领域名与表名（必须匹配后端的 UNIT_NAME_RE）。 */
const DOMAIN_NAME = 'worktodo';
const TABLE_NAME = 'todos';

/** 后端升级失败后的重试节流（同一个服务对象）：避免每个请求都重试 + 刷日志。 */
const UPGRADE_RETRY_MS = 5000;

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
  const table = domain.table(TABLE_NAME);
  logger?.info?.(`待办数据使用官方 storage（领域 ${DOMAIN_NAME}）`);

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
    // 当前后端最近一次读/写失败的原因（复审 R1 第 3 条：出错要显式报，不静默换源）
    backendError: null,
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
  const messageOf = (error) => String(error?.message ?? error);

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
   * 退役失败（极少见：目录权限等）只报警告：官方 storage 里的数据是安全的，
   * 但要提醒用户手动处理，否则那个文件仍可能在下一次合并时把已删项补回来。
   */
  function retireFallbackFile() {
    if (state.retired) return state.retired;
    const path = ownedFile?.location;
    if (!path) return null;

    if (!existsSync(path)) {
      // 文件本来就不存在（全新安装，或上一次运行已经退役过）：只做信息性报告
      let movedTo = null;
      try {
        const siblings = readdirSync(dirname(path))
          .filter((entry) => entry.startsWith(`${basename(path)}.migrated-`))
          .sort();
        if (siblings.length) movedTo = join(dirname(path), siblings[siblings.length - 1]);
      } catch { /* 目录读不到就不报这条信息，不影响升级 */ }
      if (movedTo) {
        state.retired = {
          at: Date.now(),
          path,
          movedTo,
          backup: null,
          alreadyRetired: true,
          note: `回退文件此前已迁移并退役，路径=${movedTo}；当前数据只以官方 storage 为准`,
        };
      }
      return state.retired;
    }

    // 合并时已经备份过这个文件（内容是镜像前的原样），直接复用，避免同秒内再复制一份
    // 把「合并前」的备份盖掉；`.migrated-` 改名本身也会把整份文件保留下来。
    const backup = state.merge?.backups?.find((p) => p.startsWith(`${path}.bak-`))
      ?? backupFile(path, logger);
    const dest = uniqueSibling(`${path}.migrated-${fileStamp()}`);
    try {
      renameSync(path, dest);
      state.retired = {
        at: Date.now(),
        path,
        movedTo: dest,
        backup,
        alreadyRetired: false,
        note: `已把回退文件迁移并退役，路径=${dest}`,
      };
      logger?.info?.(`${state.retired.note}${backup ? `（退役前备份：${backup}）` : ''}；`
        + '此后待办数据只以官方 storage 为准，这个文件不会再被读写作数据源');
    } catch (error) {
      state.retired = {
        at: Date.now(),
        path,
        movedTo: null,
        backup,
        error: messageOf(error),
        note: `回退文件退役失败（${messageOf(error)}）：${path} 仍然存在`,
      };
      logger?.warn?.(`⚠️ ${state.retired.note}；官方 storage 里的数据不受影响，`
        + '但请手动把该文件改名或删除，否则下一次合并可能把已删除的待办补回来');
    }
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
      entry = await acquireDomain({ storageDomain: service, ctx, logger });
    } catch (error) {
      state.mismatch = `首选官方 storage（领域 ${DOMAIN_NAME}）但打开失败：${messageOf(error)}；当前仍在使用 JSON 文件 ${ownedFile?.location ?? '?'}`;
      logger?.warn?.(`⚠️ ${state.mismatch}`);
      return false;
    }

    try {
      await mergeInto(entry.backend);
    } catch (error) {
      state.mismatch = `官方 storage 已就绪，但合并两处数据失败：${messageOf(error)}；当前仍在使用 JSON 文件 ${ownedFile?.location ?? '?'}`;
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
        ? `；回退文件已在升级时退役（${state.retired.movedTo ?? state.retired.path}），不会静默改用它`
        : '');
    logger?.warn?.(`⚠️ ${state.backendError}`);
  }

  /** 所有公开读/写都先确保后端就绪，再执行；成功清掉错误标记，失败显式上报。 */
  async function currentOp(operation, run) {
    await refreshBackend();
    try {
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
   */
  async function mergeInto(target) {
    const source = current;
    const sourceRecords = (await source.load()) ?? [];
    const targetRecords = (await target.load()) ?? [];

    // 备份两个后端的落盘文件（存在才备份，原文件不动）
    const backups = [];
    const seen = new Set();
    for (const candidate of [ownedFile?.location, await officialPath()]) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      const backup = backupFile(candidate, logger);
      if (backup) backups.push(backup);
    }

    const { todos, conflicts, added } = unionById(targetRecords, sourceRecords);
    for (const record of todos) await target.put(record);

    // 退役前把回退文件写成同一份并集：这样 `.migrated-<时间>` 里留下的是一份
    // **完整的迁移存档**（用户随时能查/能恢复），而不是升级那一刻的半截快照。
    // 写完之后这个文件就被 `retireFallbackFile()` 改名退役，不会再被当作数据源。
    // 同步失败不影响官方 storage 里已经写好的数据，只记一行并继续升级。
    let mirror = null;
    let mirrorError = null;
    if (source.kind === 'file' && sourceRecords.length) {
      try {
        await source.replaceAll(todos);
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
      merged: todos.length,
      conflicts,
      added,
      backups,
      mirror,
      mirrorError,
    };
    logger?.info?.(`已按 id 合并两处待办（${source.kind} → ${target.kind}）：合并后 ${todos.length} 条`
      + `（同 id 冲突 ${conflicts} 条取 updatedAt 较新者；从另一处补入 ${added} 条）`
      + (backups.length ? `；备份：${backups.join('、')}` : '；无需备份'));
    return state.merge;
  }

  /** 当前用回退文件、但官方 storage 文件里已有数据 → 明确报出「两处数据不一致」。 */
  async function detectSplit() {
    const official = await officialPath();
    const officialIds = readStoredIds(official);
    if (!officialIds || !officialIds.size) return;
    let local = [];
    try {
      local = (await ownedFile.load()) ?? [];
    } catch {
      return;
    }
    const localIds = new Set(local.map((record) => record.id));
    if (!localIds.size) return;
    const onlyOfficial = [...officialIds].filter((id) => !localIds.has(id));
    const onlyLocal = [...localIds].filter((id) => !officialIds.has(id));
    if (!onlyOfficial.length && !onlyLocal.length) return;
    state.split = `官方 storage 文件里 ${officialIds.size} 条、回退文件里 ${localIds.size} 条；`
      + `官方独有 ${onlyOfficial.length} 条、文件独有 ${onlyLocal.length} 条（两处 id 不完全一致）`;
    logger?.warn?.(`⚠️ 检测到两处待办数据不一致：${state.split}。`
      + 'storageDomain 服务就绪后会自动按 id 合并，不会丢记录；在此之前面板只显示回退文件里的那部分');
  }

  async function init() {
    const path = await fallbackPath();
    ownedFile = createFileBackend({ path, logger });
    adopt(ownedFile);
    const upgraded = await tryUpgrade({ force: true });
    if (!upgraded) {
      logger?.info?.(`待办数据使用 JSON 文件：${path}`);
      await detectSplit();
    }
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
