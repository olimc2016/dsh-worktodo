/**
 * dsh-worktodo — 工作待办（宿主半侧）
 *
 * 职责：
 *   1. 存储：优先官方 ctx.storageDomain（$DSH_HOME/storages），缺失时回退 JSON 文件
 *   2. 服务：把增删改查实现一次（service.mjs），供浏览器面板与 agent 工具共用——
 *      官方《user-actions》要求「一份逻辑两个调用方」，面板的按钮和 worktodo_* 工具不会各写一套
 *   3. 工具：注册 worktodo_add / list / update / done / remove / adopt 给模型
 *   4. 供数：通过 ctx.webServer 暴露读写路由给浏览器半侧面板
 *
 * 与官方 @deepseek-ai/dsh-tool-todo（todo_write）的关系：
 *   官方那份是**单个 agent 会话**的计划：整表替换、只有三态、明确不支持跨 agent 共享。
 *   本插件是**人**的工作待办：跨会话持久、有优先级/截止日期/项目/备注、可逐项编辑。
 *   两者互补，不是替代——worktodo_adopt 就是把前者里值得留下的条目提升到后者的桥。
 *
 * 浏览器半侧（侧栏入口 + 面板）在 lib/client.js，按 package.json 的 dsh.client 组成 bundle。
 */
import { readFileSync, appendFileSync } from 'node:fs';

// ⚠️ 临时诊断（排查"插件没挂载"用）：写进 /tmp，排查完即删
const BOOT_LOG = '/tmp/dsh-worktodo-boot.log';
const bootLog = (m) => { try { appendFileSync(BOOT_LOG, `${new Date().toISOString()} ${m}\n`); } catch { /* 诊断失败不影响插件 */ } };
bootLog(`module imported (pid ${process.pid})`);
import { createWorkTodoService } from '../src/service.mjs';
import { openWorkTodoStore } from '../src/store.mjs';

/** 插件短名：同时用作行 id、日志标签、面板 slot id 与路由前缀（与 package.json 保持一致）。 */
export const name = 'worktodo';

/**
 * 只声明真正必须的服务。
 * webServer 与 tools 用 ctx.inject 命令式挂载：这样在缺任一服务的精简组合里，
 * 插件仍然能以「少一半能力」的形态活着，而不是整包不激活。
 * storageDomain 由 store.mjs 内部探测（有则用官方 storage，无则回退 JSON 文件）。
 */
export const inject = [];

/**
 * 从自家 package.json 读版本号。
 *
 * 为什么要读：插件以 `link:` 装进 profile 时，源码改动**不会**热更新到已加载的模块
 *（官方文档：已安装包换新代码需要重启，否则仍是旧的模块 generation——本轮真机上就撞到了：
 * 修好的 tools.mjs 在运行中的插件里没生效）。排查「我改的代码到底生效了没」时，
 * 第一件要知道的事就是运行中是哪一版、工具注册了几个，所以把它报在 /worktodo/health 里。
 */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? null;
  } catch {
    return null; // 读不到就不报版本，绝不影响功能
  }
})();

/** 请求体大小上限：待办是很小的 JSON，超过这个数一定是走错了。 */
const BODY_LIMIT = 256 * 1024;

/** 路由前缀。 */
const ROUTE_BASE = '/worktodo';

/**
 * 发 JSON。
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {object} body
 */
function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // 面板与宿主同源，但显式禁止被当成文档解析，降低误用面
    'x-content-type-options': 'nosniff',
  });
  response.end(text);
}

/**
 * 读请求体并解析 JSON。
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<object>} 解析失败抛错
 */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error(`请求体过大（上限 ${BODY_LIMIT} 字节）`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('请求体必须是 JSON 对象'));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error?.message ?? error}`));
      }
    });
    request.on('error', reject);
  });
}

/**
 * 插件主体。
 * @param {object} ctx cordis 上下文
 * @param {object} [config] 组合配置（cordis.patch.yml 的 config）
 */
/**
 * 给模型的用法指引（AI 推荐接口）。
 *
 * 为什么要有它：工具描述只讲「这个工具做什么」，而模型真正需要的是「什么时候该用哪个」——
 * 尤其是本插件与官方 todo_write 的分工（会话内的步骤拆解 vs 人拥有的跨会话工作）。
 * 通过 Host 的 systemPrompt.section() 贡献一段提示，是官方 practices 文档给的推荐做法。
 * order 取 3050：官方 SECTION_ORDERS 里内置工具段是 1000–3000、MCP_SERVERS 是 3100，
 * 插在两者之间读起来就是「插件工具的使用说明」。
 */
const GUIDANCE_TEXT = [
  '工作待办（worktodo_*）：属于用户、跨会话持久的工作清单；侧栏面板与这些工具读写同一份数据。',
  '- 该用：用户说出要办的事、承诺或截止日期（「下周要交」「等对方回复」「记一下」），或你在工作中发现超出本会话、仍需人跟进的待办 → worktodo_add。',
  '- 不该用：当前这次任务的步骤拆解与你自己的执行顺序 → 那是会话内的 todo_write（整表替换、只属于本会话）。两者互补：todo_write 说「这一步怎么走」，工作待办说「这件事还欠着」。',
  '- 动手前先看：worktodo_list({ filter: "today" }) 或 "overdue"；按项目看：worktodo_list({ project: "<项目>" })。用户问「今天要做什么」时先查再答，不要凭记忆。',
  '- 加之前先查重：worktodo_list({ query: "<关键词>" })，同一条不要登记两次。',
  '- 做完了 / 状态变了：worktodo_done（ref 可给 id 或标题）；改标题、截止、优先级、项目用 worktodo_update。',
  '- 约定：标题写成一句简短的祈使句；project 用仓库名或产品名；priority 只在「真的卡住别人」时给 high；链接、背景与验收标准放 notes。',
].join('\n');

export async function apply(ctx, config = {}) {
  bootLog('apply start');
  const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger;

  // ---- 存储与服务：与任何服务依赖无关，先建起来 ----
  const store = await openWorkTodoStore({ ctx, config, logger });
  bootLog(`store opened: ${store.kind} -> ${store.location}`);
  const service = createWorkTodoService({ store, logger });

  // 存储后端选择只记一行日志，方便装完排查「我的数据到底存哪了」
  logger?.info?.(`待办数据：${store.kind} → ${store.location}`);

  // ---- agent 工具（可选服务）----
  // 工具注册的结果记在这里，并报给 /worktodo/health：工具是最容易「静默失败」的一环
  //（平台包解析不到、schema 被拒、模块 generation 过期），没有这个字段就只能靠猜。
  const toolState = { status: 'pending', registered: 0, names: [], error: null };
  ctx.inject(['tools'], (toolCtx) => {
    bootLog('inject[tools] fired');
    toolCtx.effect(() => {
      let dispose = () => {};
      let cancelled = false;
      // 动态导入：@deepseek-ai/dsh-tools 解析不到时只失去工具能力，面板照常工作
      import('../src/tools.mjs')
        .then((mod) => mod.registerWorkTodoTools({ ctx: toolCtx, service, logger }))
        .then((registered) => {
          const disposeTools = registered?.dispose;
          if (cancelled) {
            disposeTools?.();
            return;
          }
          dispose = disposeTools ?? (() => {});
          toolState.status = 'registered';
          toolState.names = registered?.names ?? [];
          toolState.registered = toolState.names.length;
        })
        .catch((error) => {
          toolState.status = 'failed';
          toolState.error = String(error?.message ?? error);
          logger?.warn?.(`worktodo 工具未注册（仅面板可用）：${toolState.error}`);
          bootLog(`tools failed: ${toolState.error}`);
        });
      return () => {
        cancelled = true;
        try {
          dispose?.();
        } catch { /* 卸载期清理失败不应打断取消流程 */ }
      };
    }, 'worktodo: agent tools');
  });

  bootLog('apply end (no throw)');

  // ---- 给模型的用法指引（可选服务；缺 systemPrompt 时静默跳过）----
  ctx.inject(['systemPrompt'], (spCtx) => {
    spCtx.effect(() => {
      if (typeof spCtx.systemPrompt?.section !== 'function') return () => {};
      let disposeSection = () => {};
      try {
        disposeSection = spCtx.systemPrompt.section({
          name: 'worktodo:guidance',
          order: 3050,
          text: GUIDANCE_TEXT,
        }) ?? (() => {});
        logger?.info?.('已注册给模型的用法指引（systemPrompt.section）');
      } catch (error) {
        // 段落注册失败不影响工具与面板；只记一行，方便排查
        logger?.warn?.(`用法指引注册失败：${error?.message ?? error}`);
      }
      return () => { try { disposeSection?.(); } catch { /* 卸载清理失败不打断 */ } };
    }, 'worktodo: system prompt guidance');
  });

  // ---- HTTP 路由（可选服务）----
  ctx.inject(['webServer'], (webCtx) => {
    bootLog('inject[webServer] fired');
    /**
     * 路由准入：webServer 自身不做鉴权，复用 connection 的 Host/Origin 围栏 + 浏览器认证。
     * 本插件有写操作，这道围栏是必须的（与 dsh-token-meter-panel 同一策略）。
     */
    const guarded = (handler) => async (request, response) => {
      const connection = ctx.get?.('connection');
      let rejection;
      try {
        rejection = connection?.requestRejection?.(request);
      } catch {
        rejection = undefined;
      }
      if (rejection !== undefined) {
        response.writeHead(rejection);
        response.end();
        return;
      }
      return handler(request, response);
    };

    /** 只接受指定方法的包装。 */
    const method = (verb, handler) => guarded(async (request, response) => {
      if (request.method !== verb) {
        response.writeHead(405, { allow: verb });
        response.end();
        return;
      }
      try {
        await handler(request, response);
      } catch (error) {
        logger?.warn?.(`${verb} ${request.url} 失败：${error?.stack ?? error}`);
        sendJson(response, 200, { ok: false, reason: 'internal', error: String(error?.message ?? error) });
      }
    });

    /** 把服务的显式状态原样交给前端：ok=false 也走 200，让面板能显示原因。 */
    const reply = (response, result) => {
      if (result?.ok) sendJson(response, 200, { ok: true, data: result });
      else sendJson(response, 200, { ok: false, reason: result?.reason ?? 'unknown', error: result?.message ?? '操作失败' });
    };

    // 「先做后清」：注册与清理挂在同一个 effect 上，中途失败也不会泄漏路由
    webCtx.effect(() => {
    const disposers = [
      // 读：列表 + 分组 + 统计
      webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/list`,
        handler: method('GET', async (request, response) => {
          const url = new URL(request.url ?? ROUTE_BASE, 'http://localhost');
          const result = await service.list({
            filter: url.searchParams.get('filter') ?? 'open',
            project: url.searchParams.get('project') ?? undefined,
            query: url.searchParams.get('query') ?? undefined,
          });
          reply(response, result);
        }),
      }),
      // 写：新增
      webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/create`,
        handler: method('POST', async (request, response) => {
          const body = await readJsonBody(request);
          reply(response, await service.create(body, { source: 'human' }));
        }),
      }),
      // 写：修改（只覆盖给出的字段）
      webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/update`,
        handler: method('POST', async (request, response) => {
          const body = await readJsonBody(request);
          const { ref, id, ...patch } = body;
          // 清空语义：due/project 传空串或 null 都表示「不要截止日期 / 去掉项目」
          for (const key of ['due', 'project']) {
            if (patch[key] === '' || patch[key] === null) patch[key] = null;
          }
          reply(response, await service.update(ref ?? id, patch));
        }),
      }),
      // 写：状态（勾选框）
      webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/status`,
        handler: method('POST', async (request, response) => {
          const body = await readJsonBody(request);
          if (body.toggle) reply(response, await service.toggle(body.ref ?? body.id));
          else reply(response, await service.setStatus(body.ref ?? body.id, body.status));
        }),
      }),
      // 写：删除
      webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/remove`,
        handler: method('POST', async (request, response) => {
          const body = await readJsonBody(request);
          reply(response, await service.remove(body.ref ?? body.id));
        }),
      }),
      // 写：把当前会话的 todos 提升为工作待办（面板读 todos 投影后把内容发过来）
      webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/adopt`,
        handler: method('POST', async (request, response) => {
          const body = await readJsonBody(request);
          reply(response, await service.adopt(body.todos ?? []));
        }),
      }),
      // 自检：装完用它确认宿主半侧真的活着、数据落在哪、工具注册上了没有
      webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/health`,
        handler: method('GET', async (_request, response) => {
          const all = await service.all().catch(() => []);
          sendJson(response, 200, {
            ok: true,
            plugin: name,
            // 运行中的实际版本：排查「我改的代码生效了没」时看这里
            //（link: 安装的源码改动需要重启才会换模块 generation）
            version: PLUGIN_VERSION,
            store: service.describe(),
            // 工具是最容易静默失败的一环，所以把注册结果显式报出来
            tools: toolState,
            count: all.length,
            toolsService: Boolean(ctx.get?.('tools')),
            webServerService: Boolean(ctx.get?.('webServer')),
            storageDomainService: Boolean(ctx.get?.('storageDomain')),
          });
        }),
      }),
    ];

    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch { /* 卸载期清理失败不应打断取消流程 */ }
      }
    };
    }, 'worktodo: http routes');
  });

  logger?.info?.(`mounted (store=${store.kind})`);
}
