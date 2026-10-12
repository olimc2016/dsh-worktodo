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
 * 单条坏记录被跳过而不是让整个列表读不出来。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { repairRecord, repairStoreDocument } from './schema.mjs';

/** storage-domain 的领域名与表名（必须匹配后端的 UNIT_NAME_RE）。 */
const DOMAIN_NAME = 'worktodo';
const TABLE_NAME = 'todos';

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

  /** 读整个文档；文件不存在或 JSON 坏了都返回空文档并告警，绝不抛给上层。 */
  function readDoc() {
    if (!existsSync(path)) return { version: 1, updatedAt: Date.now(), todos: [] };
    try {
      const text = readFileSync(path, 'utf8');
      if (!text.trim()) return { version: 1, updatedAt: Date.now(), todos: [] };
      const doc = repairStoreDocument(JSON.parse(text));
      return doc;
    } catch (error) {
      logger?.warn?.(`待办文件解析失败，按空列表继续（原文件未被覆盖）：${error?.message ?? error}`);
      return { version: 1, updatedAt: Date.now(), todos: [] };
    }
  }

  return {
    kind: 'file',
    location: path,
    async load() {
      return readDoc().todos;
    },
    async put(record) {
      return enqueue(() => {
        const doc = readDoc();
        const index = doc.todos.findIndex((t) => t.id === record.id);
        if (index >= 0) doc.todos[index] = record;
        else doc.todos.push(record);
        doc.updatedAt = Date.now();
        writeAtomic(path, `${JSON.stringify(doc, null, 2)}\n`);
      });
    },
    async remove(id) {
      return enqueue(() => {
        const doc = readDoc();
        const next = doc.todos.filter((t) => t.id !== id);
        if (next.length === doc.todos.length) return false;
        doc.todos = next;
        doc.updatedAt = Date.now();
        writeAtomic(path, `${JSON.stringify(doc, null, 2)}\n`);
        return true;
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

/**
 * 打开待办存储：能用官方 storage 就用，否则回退 JSON 文件。
 * @param {object} options
 * @param {object} [options.ctx] cordis 上下文（用于探测服务与订阅事件）
 * @param {object} [options.config] 组合配置（可用 storePath 指定文件位置）
 * @param {object} [options.logger]
 * @returns {Promise<object>} 存储句柄
 */
export async function openWorkTodoStore({ ctx, config = {}, logger } = {}) {
  const loggerLike = logger ?? (typeof ctx?.logger === 'function' ? ctx.logger('worktodo') : ctx?.logger);

  // ---- 手动指定了路径就尊重用户：文件后端只在显式指定时才会被选中 ----
  const explicitPath = typeof config?.storePath === 'string' && config.storePath.trim()
    ? config.storePath.trim().replace(/^~(?=$|[/\\])/, homedir())
    : null;

  // ctx.get 对未提供的服务返回 undefined，不抛错；storage 服务可能晚于本插件注册，
  // 但 dsh-base 的层序在 profile 组合之前，所以这里探测到不存在时才回退。
  // ⚠️ 只用 ctx.get 探测，**绝不**退回 `ctx.storageDomain`：直接访问未在 inject 里声明的服务
  // 会被 cordis 守卫抛错（"cannot get property … without inject"），而那个异常会让整个插件挂载失败——
  // 实测插件「时好时坏」就是这里（服务尚未注册时 ctx.get 返回 undefined，兜底访问随即抛错）
  const storageDomain = explicitPath ? undefined : ctx?.get?.('storageDomain');

  if (storageDomain && typeof storageDomain.open === 'function') {
    try {
      return await createDomainBackend({ storageDomain, ctx, logger: loggerLike });
    } catch (error) {
      loggerLike?.warn?.(`官方 storage 不可用，回退 JSON 文件：${error?.message ?? error}`);
    }
  }

  const path = explicitPath ?? join(await resolveDshHome(), 'worktodo', 'todos.json');
  loggerLike?.info?.(`待办数据使用 JSON 文件：${path}`);
  return createFileBackend({ path, logger: loggerLike });
}
