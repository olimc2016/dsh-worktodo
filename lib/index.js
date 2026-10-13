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
import { readFileSync } from 'node:fs';

import { createWorkTodoService } from '../src/service.mjs';
import { openWorkTodoStore } from '../src/store.mjs';

/** 插件短名：同时用作行 id、日志标签、面板 slot id 与路由前缀（与 package.json 保持一致）。 */
export const name = 'worktodo';

/**
 * 只声明真正必须的服务。
 * webServer 与 tools 用 ctx.inject 命令式挂载：这样在缺任一服务的精简组合里，
 * 插件仍然能以「少一半能力」的形态活着，而不是整包不激活。
 * storageDomain 也走命令式注入：服务晚注册时在注入回调里升级到官方 storage
 * （store.mjs 另外在每次请求上复查一次），避免「apply 时先到先用」的竞态。
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
/**
 * 版本与更新提示。
 *
 * 只查 npm registry 的 dist-tags.latest（不下载、不安装），结果缓存 6 小时，失败静默——
 * 面板角落显示「当前版本」与「有新版本 vX.Y.Z」，绝不让网络问题影响面板。
 * 测试里设 WORKTODO_NO_UPDATE_CHECK=1 可完全关掉（单元测试不该打网络）。
 */
const UPDATE_CHECK_OFF = process.env.WORKTODO_NO_UPDATE_CHECK === '1';
const UPDATE_TTL_MS = 6 * 3600 * 1000;
const PACKAGE_NAME = 'dsh-worktodo';

/** 语义化版本比较：a > b 返回正数。 */
function compareVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

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
  const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger;

  // ---- 存储与服务：与任何服务依赖无关，先建起来 ----
  // 复审 0.2.2 F12：打开存储**绝不能**让整个插件挂不上。历史上「服务尚未注册时的兜底访问」
  // 就把异常一路冒到 apply，结果是工具与路由全都没有（插件时好时坏）。
  // 这里失败也降级成「能挂载、能报错」的形态：面板与 /health 看得见原因，工具照常注册。
  let store = null;
  let storeOpenError = null;
  try {
    store = await openWorkTodoStore({ ctx, config, logger });
  } catch (error) {
    storeOpenError = String(error?.message ?? error);
    logger?.warn?.(`⚠️ 打开待办存储失败（面板会显示错误而不是空列表）：${storeOpenError}`);
    store = {
      kind: 'unavailable',
      location: null,
      async load() { throw new Error(`待办存储不可用：${storeOpenError}`); },
      async put() { throw new Error(`待办存储不可用：${storeOpenError}`); },
      async remove() { throw new Error(`待办存储不可用：${storeOpenError}`); },
      // 与真实存储句柄接口一致（S3-1）：reorder 走 updateOrder，不可用时同样显式失败
      async updateOrder() { throw new Error(`待办存储不可用：${storeOpenError}`); },
      onChanged() { return () => {}; },
      refreshBackend() { return Promise.resolve(false); },
      init() { return Promise.resolve(); },
      describe() {
        return {
          kind: 'unavailable',
          location: null,
          preferred: 'domain',
          mismatch: null,
          split: null,
          merge: null,
          upgrades: 0,
          retired: null,
          backendError: `打开待办存储失败：${storeOpenError}`,
          backendUsable: null,
          domainUnavailable: false,
        };
      },
      async close() {},
    };
  }
  const service = createWorkTodoService({ store, logger });

  // 存储后端选择只记一行日志，方便装完排查「我的数据到底存哪了」
  logger?.info?.(`待办数据：${store.kind} → ${store.location}`);

  // ---- 存储生命周期（卸载/重载时释放领域句柄，避免二次挂载撞 already-open）----
  // 审计 F1：`close()` 定义了却从没人调，二次挂载必然 already-open → 静默降级到回退文件。
  // 复审 R2：清理必须**返回**这个 close 的 promise（cordis 会 await 它）。原来是
  // fire-and-forget，卸载后立刻重载会在「句柄还没关完」的窗口里撞 already-open 并降级到文件。
  ctx.effect(() => () => Promise.resolve()
    .then(() => store.close?.())
    .catch((error) => logger?.warn?.(`关闭待办存储失败：${error?.message ?? error}`)), 'worktodo: store lifecycle');

  // ---- 后端升级：storageDomain 晚注册时，服务就绪事件里立刻升级并合并两处数据 ----
  // 审计 F1：后端选择不能在 apply 开头一锤定音。这里用正确声明的注入（ctx.inject）
  // 保证「服务可见性」由 cordis 决定；即使没走到这一步，每次请求也会复查一遍。
  ctx.inject(['storageDomain'], (domainCtx) => {
    domainCtx.effect(() => {
      void Promise.resolve()
        .then(() => store.refreshBackend?.())
        .catch((error) => logger?.warn?.(`待办存储升级检查失败：${error?.message ?? error}`));
      return () => {};
    }, 'worktodo: storage domain upgrade');
  });

  // ---- 变更通知：store → service → 面板/日志（原来 onChanged/onChange 都是死代码）----
  const changes = { count: 0, lastAt: null };
  const disposeStoreEvents = store.onChanged?.((change) => {
    service.notifyStoreChange?.(change);
  }) ?? (() => {});
  const disposeServiceEvents = service.onChange(() => {
    changes.count += 1;
    changes.lastAt = Date.now();
  });
  ctx.effect(() => () => {
    try {
      disposeStoreEvents();
    } catch { /* 卸载期清理失败不应打断取消流程 */ }
    try {
      disposeServiceEvents();
    } catch { /* 同上 */ }
  }, 'worktodo: store change events');

  // ---- agent 工具（可选服务）----
  // 工具注册的结果记在这里，并报给 /worktodo/health：工具是最容易「静默失败」的一环
  //（平台包解析不到、schema 被拒、模块 generation 过期），没有这个字段就只能靠猜。
  const toolState = { status: 'pending', registered: 0, names: [], error: null };
  ctx.inject(['tools'], (toolCtx) => {
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
        });
      return () => {
        cancelled = true;
        try {
          dispose?.();
        } catch { /* 卸载期清理失败不应打断取消流程 */ }
      };
    }, 'worktodo: agent tools');
  });

  // ---- 版本与更新（后台、不阻塞任何请求）----
  let updateState = { at: 0, latest: null, error: null };
  const refreshUpdate = async () => {
    if (UPDATE_CHECK_OFF) return updateState;
    const now = Date.now();
    if (updateState.at && now - updateState.at < UPDATE_TTL_MS) return updateState;
    updateState = { ...updateState, at: now }; // 先占位，避免并发重复请求
    try {
      const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const latest = String(body?.['dist-tags']?.latest ?? '');
      updateState = { at: now, latest: /^\d+\.\d+\.\d+$/.test(latest) ? latest : null, error: null };
    } catch (error) {
      updateState = { at: now, latest: null, error: String(error?.message ?? error) };
    }
    return updateState;
  };
  const updatePayload = () => {
    const latest = updateState.latest;
    return {
      current: PLUGIN_VERSION,
      latest: latest ?? undefined,
      hasUpdate: Boolean(latest) && !UPDATE_CHECK_OFF && compareVersion(latest, PLUGIN_VERSION) > 0,
      page: `https://www.npmjs.com/package/${PACKAGE_NAME}`,
    };
  };
  if (!UPDATE_CHECK_OFF) void refreshUpdate(); // 启动时后台查一次（失败静默）

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

    // S1-1（第四轮审计）：**逐条注册、成功一条就立刻把 disposer 入栈**。
    //
    // 旧写法是 `const disposers = [ register(a), register(b), … ]` 一个数组字面量：
    // 第 N 条 register 抛错时，前 N-1 条已经进了 webServer 的**服务级**路由表，
    // 而 effect 回调中途抛出 → 清理函数从未返回 → 那些路由永久残留、没有 disposer；
    // 紧接着 apply reject（工具与路由全没），此后**每一次挂载**（哪怕完全正常）
    // 都会在第 1 条就撞真实 DSH 的 `duplicate exact route` → 只能重启 DSH 才能恢复。
    //
    // 现在：单条注册失败只记一行 warn、丢这一条；回调**一定**返回清理函数；
    // 任何情况下都不会让 apply 因为路由注册失败而 reject。
    const disposers = [];

    /** 幂等清理：effect 卸载与 inject 回调返回的 disposer 都会走这里（splice 保证只跑一次）。 */
    const disposeRoutes = () => {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose?.();
        } catch { /* 卸载期清理失败不应打断取消流程 */ }
      }
    };

    /** 注册一条路由；成功即入栈，失败只降级丢这一条。 */
    const addRoute = (route) => {
      try {
        const dispose = webCtx.webServer.register(route);
        if (typeof dispose === 'function') disposers.push(dispose);
        else if (dispose && typeof dispose.dispose === 'function') disposers.push(() => dispose.dispose());
      } catch (error) {
        logger?.warn?.(`路由 ${route?.path} 注册失败（只丢这一条，面板其余功能与工具不受影响）：${error?.message ?? error}`);
      }
    };

    try {
      webCtx.effect(() => {
        // 读：列表 + 分组 + 统计
        addRoute({
          kind: 'exact',
          path: `${ROUTE_BASE}/list`,
          handler: method('GET', async (request, response) => {
            const url = new URL(request.url ?? ROUTE_BASE, 'http://localhost');
            if (!UPDATE_CHECK_OFF && Date.now() - updateState.at >= UPDATE_TTL_MS) void refreshUpdate();
            const result = await service.list({
              filter: url.searchParams.get('filter') ?? 'open',
              project: url.searchParams.get('project') ?? undefined,
              query: url.searchParams.get('query') ?? undefined,
              sort: url.searchParams.get('sort') ?? undefined,
              // S3-3：面板可选择只要一种视图（shapes=todos|groups|projectGroups|both）
              shapes: url.searchParams.get('shapes') ?? undefined,
            });
            reply(response, result.ok
              ? { ...result, version: PLUGIN_VERSION, update: updatePayload() }
              : result);
          }),
        });
        // 写：手动排序（拖动）。body: { ids: [待办 id，按新顺序排列] }
        addRoute({
          kind: 'exact',
          path: `${ROUTE_BASE}/reorder`,
          handler: method('POST', async (request, response) => {
            const body = await readJsonBody(request);
            reply(response, await service.reorder(body));
          }),
        });
        // 写：新增
        addRoute({
          kind: 'exact',
          path: `${ROUTE_BASE}/create`,
          handler: method('POST', async (request, response) => {
            const body = await readJsonBody(request);
            reply(response, await service.create(body, { source: 'human' }));
          }),
        });
        // 写：修改（只覆盖给出的字段）
        addRoute({
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
        });
        // 写：状态（勾选框）
        addRoute({
          kind: 'exact',
          path: `${ROUTE_BASE}/status`,
          handler: method('POST', async (request, response) => {
            const body = await readJsonBody(request);
            if (body.toggle) reply(response, await service.toggle(body.ref ?? body.id));
            else reply(response, await service.setStatus(body.ref ?? body.id, body.status));
          }),
        });
        // 写：删除
        addRoute({
          kind: 'exact',
          path: `${ROUTE_BASE}/remove`,
          handler: method('POST', async (request, response) => {
            const body = await readJsonBody(request);
            reply(response, await service.remove(body.ref ?? body.id));
          }),
        });
        // 写：把当前会话的 todos 提升为工作待办（面板读 todos 投影后把内容发过来）
        addRoute({
          kind: 'exact',
          path: `${ROUTE_BASE}/adopt`,
          handler: method('POST', async (request, response) => {
            const body = await readJsonBody(request);
            reply(response, await service.adopt(body.todos ?? []));
          }),
        });
        // 自检：装完用它确认宿主半侧真的活着、数据落在哪、工具注册上了没有
        addRoute({
          kind: 'exact',
          path: `${ROUTE_BASE}/health`,
          handler: method('GET', async (_request, response) => {
            // 读不出来时**不能**报 count: 0 —— 那是「你的待办真的没了」的错误信号（复审 R4 / F16）。
            // 显式给 count: null + countError，让排查者一眼分清「空列表」与「存储读失败」。
            const snapshot = await service.all()
              .then((todos) => ({ todos, error: null }))
              .catch((error) => ({ todos: null, error: String(error?.message ?? error) }));
            sendJson(response, 200, {
              ok: true,
              plugin: name,
              // 运行中的实际版本：排查「我改的代码生效了没」时看这里
              //（link: 安装的源码改动需要重启才会换模块 generation）
              version: PLUGIN_VERSION,
              store: service.describe(),
              // 变更通知是否真的接通了（原来 onChanged/onChange 是死代码，面板不刷新）
              changes: { count: changes.count, lastAt: changes.lastAt },
              // 工具是最容易静默失败的一环，所以把注册结果显式报出来
              tools: toolState,
              // count 为 null = 读失败（不是 0 条）；原因在 countError 里
              count: snapshot.todos ? snapshot.todos.length : null,
              countError: snapshot.error,
              toolsService: Boolean(ctx.get?.('tools')),
              webServerService: Boolean(ctx.get?.('webServer')),
              storageDomainService: Boolean(ctx.get?.('storageDomain')),
            });
          }),
        });
        // 回调**必须**返回清理函数：这样单条注册中途失败也不会留下没有 disposer 的服务级路由
        return disposeRoutes;
      }, 'worktodo: http routes');
    } catch (error) {
      // 连 effect 都没挂上（例如 effect 实现本身抛错）：把已经注册成功的那几条立刻收干净，
      // 绝不留服务级残留去毒化下一次挂载；同时绝不让这个异常冒到 apply。
      logger?.warn?.(`HTTP 路由注册整体失败（面板不可用，工具不受影响）：${error?.message ?? error}`);
      disposeRoutes();
    }

    // cordis 的 `inject` 回调（plugin apply）返回值同样会被收集成 disposer —— 再兜一层。
    return disposeRoutes;
  });

  logger?.info?.(`mounted (store=${store.kind})`);
}
