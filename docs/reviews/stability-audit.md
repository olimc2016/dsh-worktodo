# dsh-worktodo 稳定性审计（第四轮 · 只审稳定性）

**一句话结论：长期运行「数据上」是安全的（挂载/卸载循环干净、并发写不丢、坏盘不损坏文件），但「负载与异常」下不安全——待办涨到 1000 条以上之后，一次拖拽重排会让整个 DSH node 进程冻结 3.9 秒并写盘 404 MiB（5000 条时 98 秒 / 10 GiB）；服务组合异常时会留下不可自愈的挂载失败与泄漏（只能重启 DSH）。**

本轮只审稳定性（S1–S6），不重复数据安全结论。前三轮的 F11（同步 IO）、F8（无错误边界）、轮询放大三条在第四节统一复核。

---

## 0. 审计时的代码状态（快照，必须与结论一起看）

```
$ git status --porcelain            # 审计开始时
 M lib/client.js
 M lib/client.js.map
 M lib/index.js
 M src/client/index.js
 M src/store.mjs
 M tools/smoke-client.mjs
 M tools/verify-all.mjs
 M tools/verify-store.mjs
?? docs/reviews/audit-0.2.2-third-pass.md
```

```
$ git status --porcelain            # 审计结束时（README 两个文件是被并发修改的，见下）
 M README.en.md
 M README.md
 M lib/client.js
 M lib/client.js.map
 M lib/index.js
 M src/client/index.js
 M src/store.mjs
 M tools/smoke-client.mjs
 M tools/verify-all.mjs
 M tools/verify-store.mjs
?? docs/reviews/audit-0.2.2-third-pass.md
```

- HEAD = `9c02f53`（`fix(data): 复审修复 —— 回退文件升级后退役…`）。
- **审计对象哈希**（sha256 前 16 位，审计全程复核过两次，未变）：
  `src/store.mjs = 5f54e67e3dcd6c8c`、`lib/index.js = dc0f38d076a33514`、
  `src/client/index.js = be09394a638c1cf7`、`lib/client.js = 19d8ea1ef5fea4ec`。
  下面所有 `文件:行号` 都对应这个状态。
- ⚠️ **审计期间工作区在被并发编辑**（另一路修复）：`README.md`/`README.en.md` 在我开始审计后才变成 M；
  `tools/smoke-client.mjs` 也在我第一次跑测试的同一分钟内被改过。四个被审计的源码文件哈希始终未变，结论仍可追溯。
  这条也解释了一次**假红**：第一次跑 `node tools/verify-all.mjs` 时 `verify-store`/`verify-privacy` 报错
  （家目录路径规则命中），几分钟后同样命令连续 3 次全绿 —— 那次是读到了**半写**的文件，不是真失败。
  在并发编辑期间跑门禁会得到不可信的结论，建议改完一轮再跑。
  审计结束前又完整跑了一次，**10/10 全绿**（`WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs`）。
- 环境：Node `v24.21.0`（`~/​.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`），macOS。
  所有实跑都在 `/tmp` 的临时 `DSH_HOME` 或临时目录里，**没有读也没有碰** `~/.dsh/storages/worktodo.json`、
  `~/.dsh/worktodo/*`（含 `.bak-*`/`.migrated-*`）。故障注入全部在 `/tmp` 的假 ctx / 假服务里做，**未修改仓库源码**。
- 复现脚本放在 `/tmp/wt-*.mjs`（见各条「证据」）；它们只用 `lib/index.js`、`src/store.mjs`、`src/service.mjs` 与一个假 cordis ctx。

---

## 1. S1 挂载稳定性

### S1-1（高）`webServer` 注入回调体内任何一次 `register` 抛错 → 插件完全挂不上，且已注册的路由**泄漏且没有 disposer**，之后每次挂载都必失败（只能重启 DSH）

- **文件**：`lib/index.js:374-493`（`webCtx.effect(() => { const disposers = [ … 8 个 register … ]; return () => {…} })`）
- **现象（会自我放大）**：
  1. `const disposers = [ ... ]` 是**数组字面量**：第 N 个 `register` 抛错时，前 N-1 条已经进了 webServer 的
     **服务级**路由表（不是 ctx 级），而清理函数**从来没被返回**（effect 回调中途抛出）→ 那些路由永久残留。
  2. 抛出的异常一路冒到 `apply()` → apply reject → 按 cordis 语义整个插件不挂载：**8 条路由全没、7 个工具全没**，
     面板 404，工具消失。
  3. 因为路由表是服务级的、残留又没人清，**下一次挂载（哪怕完全正常）会在第 1 条就撞
     `duplicate exact route`** → 失败 → 再残留 7 条 …… 直到进程重启。这就是「退避到永不恢复」的形态。
- **证据（实跑，含真实 DSH 语义）**：
  - 真实实现（从 DSH app.asar 里读出来的 `@deepseek-ai/dsh-host-webserver/lib/index.js`）：
    ```js
    register(route) {
      const table = route.kind === "exact" ? this.exact : this.prefixes;
      if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
      …
    }
    ```
    → 重复路径是**抛错**，不是幂等。
  - `/tmp/wt-b2-partial.mjs`（让第 3 / 第 8 次 register 抛错）：
    ```
    failAt=3: apply REJECT ｜ 泄漏路由 2 条 ["/worktodo/list","/worktodo/reorder"]
    failAt=8: apply REJECT ｜ 泄漏路由 7 条 [ …7 条… ]
    路由 effect 的 disposer=未注册（回调抛出，cleanup 从未返回）
    ```
  - `/tmp/wt-c-duproute.mjs`（复刻服务级 duplicate 语义）：
    ```
    场景2：带故障的 apply（第 8 条注册抛错）→ apply 抛出，webServer 里残留 7 条
          随后一次完全正常的 apply（新 ctx）→ 也抛出 duplicate exact route "/worktodo/list"
    ```
- **最小修复建议**：把注册改成「逐个注册、逐个入栈」，并把异常挡在路由单元内：
  ```js
  webCtx.effect(() => {
    const disposers = [];
    const add = (route) => { try { disposers.push(webCtx.webServer.register(route)); }
                             catch (e) { logger?.warn?.(`路由 ${route.path} 注册失败：${e?.message ?? e}`); } };
    add({ kind:'exact', path:`${ROUTE_BASE}/list`, handler: … });
    …
    return () => { for (const d of disposers) { try { d?.(); } catch {} } };
  }, 'worktodo: http routes');
  ```
  这样：单条路由失败只丢那一条（面板其余功能还在），且**回调一定返回清理函数**，不会泄漏、不会毒化后续挂载。
  另外建议在注册前用 `ctx.get('webServer')` 探测同名路径/维持「路径唯一」约定，或至少把 duplicate 当成可降级事件而不是致命事件。

### S1-2（中）挂载路径上的 `await` 没有超时：`storageDomain.open()` 不 resolve，`apply()` 就永远不 resolve

- **文件**：`lib/index.js:168`（`await openWorkTodoStore`）→ `src/store.mjs:1146`（`await tryUpgrade({force:true})`）→ `src/store.mjs:906/455`（`await acquireDomain` / `await entry.promise`）
- **现象**：存储升级在**挂载路径上**同步等待。官方 `open()` 正常是本地文件 IO（毫秒级），但只要它变慢或挂住
  （存储后端实现问题、$DSH_HOME 挂在网络盘/NFS、domain 内部死锁），`apply()` 就一直不返回：
  **面板永远 404、工具永远不出现**，而且没有任何超时/告警——`/worktodo/health` 本身也没挂上。
- **证据（实跑）**：`/tmp/wt-b-mountfail.mjs`
  ```
  HANG  | routes= 0 tools= 0 sec=0 ms= 2501 | storageDomain.open 永不 resolve（挂载是否被卡住）
  ok    | routes= 8 tools= 7 sec=1 ms= 3003 | storageDomain.open 慢 3 秒（挂载被推迟 3003ms）
  ```
  同一矩阵里其余 12 格（DSH_HOME 是普通文件、DSH_HOME 只读、open 抛 already-open、domain 缺 open、
  domain 打开成功但 entries() 抛错、webServer/tools/systemPrompt 服务缺失、register 抛错、
  requestRejection 抛错、storePath 在只读目录、HOME 为空）都是 **ok**：`apply()` 不抛，8 条路由照常注册
  （唯一 THROW 的那格就是 S1-1）。也就是说 S1 的降级设计整体是好的，**只剩「不许挂」的超时缺口**。
- **最小修复建议**：给升级加超时，超时后按「官方存储暂不可用」降级（继续用文件后端并记 `mismatch`），
  不要让它阻塞 `apply()`：
  ```js
  upgraded = await Promise.race([
    tryUpgrade({ force: true }),
    new Promise((r) => setTimeout(() => r(false), 3000)),
  ]);
  ```
  （更彻底的做法是把首次升级挪出挂载路径，改成后台任务 + 就绪后触发 `refreshBackend()`。）

### S1-3（信息，已复核通过）反复 `apply → dispose → apply` 不增长、不残留 `already-open`

- **证据（实跑）**：`/tmp/wt-a-mount.mjs`
  - 20 轮（domain 后端，每轮 30ms 落地后再卸载）：
    ```
    累计：routeReg=160 routeDispose=160 / toolReg=140 toolDispose=140 / secReg=20 secDispose=20 / lisAdd=20 lisRemove=20
    末轮残留：routes=0 tools=0 evtListeners=0 effectsNotDisposed=0
    domain：open=20 close=20 stillOpen=false
    未处理：rejection=0 uncaught=0
    ```
  - 30 轮 + **apply 后立刻 dispose**（压动态 import 竞态）：`toolReg=210 toolDispose=210`、`open=30 close=30 stillOpen=false`、
    残留 0 —— 晚到的工具注册被 `cancelled` 分支正确回收，`store.close()` 返回的 promise 被 await（R2 的修复有效）。
  - 结论：**注册表、监听器、句柄、effect 都不单调增长**；`already-open` 降级残留的常规路径已被修掉（残留的那个口子在 S2-1）。

---

## 2. S2 长期泄漏与资源

### S2-1（中）`storageDomain.open()` **成功之后**再抛错 → 领域句柄泄漏且永不释放；该进程此后永远停在回退文件后端（`already-open`），`store.close()` 也救不回来

- **文件**：`src/store.mjs:377-379`（`const domain = await storageDomain.open(spec); const table = domain.table(TABLE_NAME);`）
  与 `src/store.mjs:454-460`（`acquireDomain` 失败时只 `domainRegistry.delete(entry)`，**不 close 已经打开的 domain**）
- **现象**：`open()` 与 `return` 之间任何一次抛错（`domain.table()` 抛、`logger.info` 抛）都会让那个已经打开的领域句柄
  变成孤儿：`acquireDomain` 把注册表项删了，`tryUpgrade` 走 catch，`domainEntry` 从未被赋值 → `store.close()`
  里 `releaseDomain(null)` 什么也不做。之后每次升级重试（5 秒节流）都撞官方 `already-open`，
  **promise 上永远挂着 mismatch、永远降级到 JSON 文件**，而那个领域一直开着，直到进程退出。
- **证据（实跑）**：`/tmp/wt-j-leak.mjs`（A 段，`table()` 注入抛错；用时间偏移代替真实等待 5s 节流）
  ```
  启动后：open=2 close=0 stillOpen=true
  失败重试 4 次后：open=6 close=0 stillOpen=true
  最后一次 mismatch：…打开失败：domain 'worktodo' is already open…
  把 table() 修好后再试：仍然失败 → kind=file（永远停在回退文件后端，只能重启进程）
  close() 之后：close=0 stillOpen=true      ← 句柄泄漏，close 根本够不着它
  ```
- **最小修复建议**：`open()` 之后的步骤全部纳入 try，失败时把刚拿到的句柄关掉再抛：
  ```js
  const domain = await storageDomain.open(spec);
  let table;
  try { table = domain.table(TABLE_NAME); }
  catch (error) { await domain.close().catch(() => {}); throw error; }
  ```
  （或在 `createDomainBackend` 里把 `domain` 挂到 entry 上，让 `acquireDomain` 的失败分支能关它。）

### S2-2（低，F9 复核：**堆积已修，复制量还在**）合并持续失败时 `.bak-` 不再无限增长，但每 5 秒仍复制一份整文件备份

- **文件**：`src/store.mjs:41`（`BACKUP_REUSE_MS = 5000`）、`44`（`MAX_BACKUPS = 2`）、`162-168`、`682-699`
- **现象**：工作区里的复用 + 轮转修复**确实生效**：`.bak-` 份数不再单调增长。
  但 `BACKUP_REUSE_MS(5000)` 与 `UPGRADE_RETRY_MS(5000)` **恰好相等**，重试周期常常刚好落在复用窗口之外，
  于是每一轮失败重试仍然 `copyFileSync` 一整份文件（复制完马上被轮转删掉）。读/写/日志三样都是每 5 秒一轮，
  由「面板轮询 + 任何工具调用」驱动，可以无限跑到进程结束。
- **证据（实跑）**：
  - 堆积复核（`/tmp/wt-j-leak.mjs` B 段，2000 条 / 863 KiB 回退文件，连续 6 轮都真的重试）：
    ```
    .bak- 份数变化 1 → 2 → 2 → 2 → 2 → 2 → 2   （轮转上限生效）
    ```
  - 单轮代价（`/tmp/wt-k-retry.mjs`，每轮带 fs 字节计数）：
    ```
    第 1 次：12.5ms ｜ 读 2 次 1726 KiB ｜ 复制备份 2 次 863 KiB ｜ warn 2 条
    第 5 次： 9.3ms ｜ 读 2 次 1726 KiB ｜ 复制备份 2 次 863 KiB ｜ warn 2 条
    .bak- 份数：2（轮转上限 2）
    按 5 秒节流推算：每小时 ≈ 720 轮 → 1214 MiB 读、607 MiB 备份复制、1440 条 warn
    ```
- **最小修复建议**：备份去重别用「5 秒窗口」，改成「同路径 + 同 size + 同 mtime 就不再复制」或直接对
  失败态做**指数退避**（5s → 30s → 5min，上限），别让一次持续性故障按固定 5 秒永久重试。

### S2-3（低，复核通过）客户端定时器/监听器在卸载路径上确实被清掉

- **证据**：`src/client/index.js:1223-1235`（`clearInterval` + `removeEventListener('focus')` +
  `removeEventListener('visibilitychange')` 都在同一个 `useEffect` 的清理函数里），
  且 `tools/smoke-client.mjs:541-550` 是**全称断言**（`intervals.every(handle => cleared.includes(handle))`、
  两个监听器表 size 归零），不是恒真断言；该套件在当前工作区跑绿。
- **残留观察（不是泄漏，是策略）**：`setInterval(() => refresh(), 30000)` **不判断窗口是否可见** ——
  窗口被切到后台/最小化时仍然每 30 秒全量拉一次（`visibilitychange` 只是「变可见时额外补一次」）。
  见 S3-3 的放大数字。

---

## 3. S3 性能与放大（本轮数字最硬的一节）

### S3-1（高）`service.reorder()` 逐条 `put`，而文件后端每次 `put` = 整文件读 + 整文件原子写 → **O(n²)**；一次拖拽 = 1000 次全文件重写（404 MiB），5000 次时 10 GiB / 98 秒

- **文件**：`src/service.mjs:189-199`（`for (… ) { await store.put(next[index]) }`）、
  `src/store.mjs:315-326`（`put` 里 `readDoc()` + `writeAtomic(serializeDoc(整个文档))`）、
  `src/records.mjs:399-402`（`applyManualOrder` 对**每个** id 都造新对象 → 引用比较 `next[index] === records[index]` 恒为 false → 全量写）
- **现象（随待办数量二次方恶化）**：拖一下列表，插件会把**每一条**待办按整条记录重写一遍，
  每次重写都要把整个 JSON 文件读完、序列化、原子替换一次。
- **证据（实跑）**：`/tmp/wt-d3-perf.mjs`（真实文件后端，patch `node:fs` 后 `syncBuiltinESMExports()` 才数得到字节）
  ```
  n=1000（413 KiB）：
    put(新增 1 条) 5.5ms ｜ 读 1 次 413 KiB、写 1 次 414 KiB = 整文件×1.00、rename 1
    service.update() 7.5ms ｜ 读 828 KiB、写 414 KiB
    service.list(all) 5.6ms ｜ 读 414 KiB            ← 面板一次 30s 轮询的宿主成本
    service.reorder() 3.94s ｜ 读 1001 次 404.4 MiB、写 1000 次 404.0 MiB = 整文件×1002、rename 1000
  n=5000（2075 KiB）：
    put(新增 1 条) 19.2ms ｜ 读 2075 KiB、写 2081 KiB = 整文件×1.00
    service.list(all) 16.0ms
    service.reorder() 97.93s ｜ 读 5001 次 10159 MiB、写 5000 次 10156.9 MiB = 整文件×5012、rename 5000
  ```
  即：**一次拖拽的写放大量 = 待办条数 ×2**（1000 条 → 404 MiB；5000 条 → 10 GiB）。
- **最小修复建议**：
  1. `reorder` 只提交**真正变了 order 的那些**（现在全量提交），并且只带 `{id, order, updatedAt}`；
  2. 更根本的是给存储加一个**批量写**（一次 `readDoc()` → 改完所有 order → 一次 `writeAtomic`），
     这样一次拖拽从 N 次整文件写降到 1 次。`replaceAll` 已经存在，扩展成 `replaceAll(records)` 或新增 `patchMany` 即可。

### S3-2（中，F11 复核升级）同步 IO 串在「已 resolve 的 promise 链」上，整段 reorder 期间事件循环**一个 macrotask 都没有** → 整个 DSH 进程被冻结

- **文件**：`src/store.mjs:251-256`（`const run = chain.then(job); chain = run.then(...)` —— `chain` 已 resolve，
  于是每一次 `await` 只让出微任务队列，永远轮不到定时器/IO 回调）、`src/store.mjs:229-235`（同步读写）
- **现象**：拖拽期间（1000 条 3.9 秒 / 5000 条 98 秒）DSH 的 node 进程无法处理任何其它请求、定时器或流事件。
  面板自己的 30 秒轮询、工具调用、其它插件的请求全部排队；HTTP 层会表现为请求超时。
- **证据（实跑）**：
  - `/tmp/wt-d3-perf.mjs` 用 `monitorEventLoopDelay` 监控：整段 reorder 内**一次采样都没有**（`h.max` 仍是 0），
    这本身就是「没有 macrotask 可跑」的直接证据（我的 10ms `setInterval` 探测同样一次都没触发）。
  - 与 F11 的关系：F11 当年是「请求路径上有 `readFileSync`/`writeFileSync`」，量级是单次几毫秒；
    **本轮实测把它放大成了 98 秒的连续阻塞**，触发条件是负载（条数）而不是异常。**F11 仍然成立且已明显变严重。**
- **最小修复建议**：同 S3-1（批量写把 N 次同步 IO 降成 1 次）+ 长期考虑异步 IO（`node:fs/promises` + 写队列），
  至少在 batch 前后 `await new Promise(setImmediate)` 让出一次宏任务，避免长时间独占事件循环。

### S3-3（中）面板每次轮询的载荷是同一批数据的 **3 倍**，且不可见时仍轮询、多窗口线性翻倍

- **文件**：`src/service.mjs:130-148`（`todos` + `groups` + `projectGroups` 三份都塞进同一个响应）、
  `src/client/index.js:521`（每次 `fetch('/list?filter=all')`）、`src/client/index.js:1223-1235`（30s `setInterval` 不看可见性）
- **证据（实跑）**：`/tmp/wt-i-poll.mjs`（真实路由 handler，量响应字节）
  ```
  n=1000：/list 主机 9.2ms ｜ 响应体 850 KiB
          载荷构成：todos 247 KiB + groups 247 KiB（同一批记录再发一遍）+ projectGroups 248 KiB（又一遍）
  n=5000：/list 主机 33.7ms ｜ 响应体 4284 KiB ｜ 浏览器 JSON.parse 14.8ms
          载荷构成：todos 1249 KiB + groups 1249 KiB + projectGroups 1249 KiB
          4 个窗口同时开 = 每 30s 4 次请求 = 17135 KiB / 30s，主机侧 135ms 同步 IO
  ```
  另外每次轮询都会 `setState({status,data})` 换掉新对象引用，面板**没有任何 memo** → 5000 行全部重新 reconcile
  （这一段是静态推断，仓库里没有真 React，无法实测帧耗时）。
- **最小修复建议**：只发一份（面板需要分组就在前端用同一份 `todos` 分组，或只发「分组 → id 列表」）；
  轮询加 `document.visibilityState !== 'hidden'` 守卫（不可见时不打宿主，靠 `focus`/`visibilitychange` 补新鲜度）；
  行组件用 `React.memo`。

---

## 4. S4 错误处理与脏状态

### S4-1（中）拖拽的整批写会**静默覆盖**另一窗口 / agent 在拖拽期间的写（丢失更新）

- **文件**：`src/service.mjs:189-199`（写的是**读时刻的整条旧记录**，没有任何并发检查）
- **现象**：`reorder` 先读全量、算出顺序、再逐条把**旧记录对象**写回。它与任何并发写构成「后写覆盖前写」，
  而覆盖窗口 = 整个 reorder 时长（1000 条 3.9 秒、5000 条 98 秒，见 S3-1）。两边都会返回 `ok: true`，
  用户看到「保存成功」但改动消失。
- **证据（实跑）**：`/tmp/wt-g-concurrency.mjs`
  ```
  == 4) 拖拽重排（/reorder 整批写）与另一窗口 update 同一条并发 ==
     reorder ok=true updated=60；update ok=true
     最终 title="条目 59" priority=none
     → ✦ 另一窗口的标题修改被拖拽整批写覆盖掉了（丢失更新）
  == 5) reorder 期间另一窗口 create ==      中途新建 3 条，落盘后还在 3 条 → 不丢
  ```
- **最小修复建议**：`reorder` 只 patch `order` 字段（而不是整条替换）；写入前比对「读到的 `updatedAt`」与磁盘上的
  `updatedAt`，不一致就跳过该条或整体重试（乐观并发）。这一条与 S3-1 的最小修复是同一处改动。
- **顺带（低）**：同一条记录上的两个并发 `update`（如勾选框 + 编辑保存）是后写覆盖前写，实测
  `title` 改动会被 `status` 的写入吃掉（`/tmp/wt-g-concurrency.mjs` 场景 3）。窗口内属正常语义，但面板/工具同时操作同一行时会出现。

### S4-2（低）`readJsonBody` 只有大小上限、没有时间上限：慢客户端会一直占住 handler

- **文件**：`lib/index.js:79-111`（只监听 `data`/`end`/`error`，`BODY_LIMIT` 只管大小）
- **证据（实跑）**：
  - `/tmp/wt-e-http.mjs`：客户端声明 `Content-Length: 5000` 但只发 9 字节并保持连接 →
    这个请求**一直没有响应、handler 一直没有 settle**，我的测试进程卡在这一步 >45 秒（最后手动杀掉）。
  - `/tmp/wt-f-halfbody.mjs`：客户端**真的断开**时行为是正确的 —— `started=32 settled=32 pending=0`，
    32 次半包全部 settle、无悬挂 promise、无未处理 rejection、之后的 `/list` 仍然 200。也就是说泄漏只发生在
    「socket 一直不关」的慢客户端上，靠 server 的 `requestTimeout`（默认 300s）兜底。
- **最小修复建议**：给 `readJsonBody` 加超时（如 `setTimeout(reject, 30_000)`）并监听 `request.on('close')`；
  或在依赖 DSH 的 `requestTimeout` 时明确记录这个前提。
- **结论**：坏 JSON / 非对象 JSON / `null` / 空 body / 方法不符 / 超大 body / 半包 / 客户端 RST
  这 8 类**都不会让插件崩或留下坏状态**，异常都被 `method()` 的 try/catch 转成了正常 200（或 405），
  乱打一通之后 `/list` 与 `/create` 仍正常（`/tmp/wt-e-http.mjs` 的全部用例），全程 0 未处理 rejection。

### S4-3（低）超限请求被 `request.destroy()` 掐断 → 客户端看到 ECONNRESET 而不是「请求体过大」

- **文件**：`lib/index.js:85-89`（`reject(...); request.destroy();`）
- **证据（实跑）**：`/tmp/wt-e-http.mjs` → `{"error":"ECONNRESET socket hang up"}`。
  插件自己那侧是好的（异常被捕获、日志有原因），但**用户/调用方看不到原因**，面板只会显示网络错误。
- **最小修复建议**：先 `sendJson(response, 413, { ok:false, reason:'body-too-large', … })` 再断，或改为读完丢弃。

### S4-4（低）磁盘写满时 `writeAtomic` 不清临时文件；只读/满盘时插件「报错但仍可用」

- **文件**：`src/store.mjs:229-235`（`writeFileSync(tmp)` 失败后 `tmp` 留在原处）
- **证据（实跑）**：`/tmp/wt-h2-full.mjs`（真的用 `hdiutil` 造了 2 MiB 临时卷并写满）
  ```
  写满前成功 1698 条，耗时 5.9s（文件 933 KiB）
  第一次失败：reason=store-write-failed  message=保存待办失败：ENOSPC: no space left on device, write
  满盘后连续 5 次 create：store-write-failed ×5（不崩、不刷屏）
  满盘后 list：ok（1698 条） ← 报错但仍可用；update/remove：store-write-failed
  盘上文件仍是合法 JSON（1698 条）—— 原子写没有留下半个文件
  写满后目录里的 .tmp 残留：todos.json.tmp-29313
  ```
- **只读目录**（`/tmp/wt-h-disk.mjs`）：3 次 `create` 全部返回
  `store-write-failed / EACCES: permission denied, open '…/todos.json'`，日志 **0 条 warn**（不放大），
  `list` 仍能读到数据 → **降级行为是正确的**。
- **最小修复建议**：`writeAtomic` 里 try/catch 包住并 `rmSync(tmp, {force:true})`（临时文件名固定为
  `.tmp-<pid>`，最多残留一个，但在满盘场景下它恰好占着最需要的那点空间）。
- **重试策略复核**：升级失败按 5 秒节流（`src/store.mjs:901`），不会每个请求都重试；
  但节流本身就是 S2-2 的放大源（每 5 秒一轮完整读+备份）。

---

## 5. S5 并发

写入串行化（`src/store.mjs:249-256` 的 promise 链）**成立**，没有发现死锁或覆盖式丢数据：

| 场景（`/tmp/wt-g-concurrency.mjs`） | 结果 |
| --- | --- |
| 20 个并发 `create`（两个独立 store 实例指向同一文件） | 20/20 落盘，**不丢** |
| 并发 `update` 两条不同记录 | 两条都保住，**不丢** |
| 20 个并发 `remove` + 20 个并发 `put` | 40/40 成功，剩余 20 条、改过的 20 条，**一致** |
| `reorder` 期间另一窗口 `create` | 3/3 保留，**不丢** |
| `reorder` 与另一窗口 `update` 同一条 | **丢失更新**（见 S4-1） |
| 同一条上并发两个 `update` | 后写覆盖前写（窗口内正常，但会吃掉另一个字段的改动） |

「升级/合并在线写入并发」复核：`tryUpgrade` 有 `upgrading` 去重 + `releaseDomain` 的 `closing` 哨兵，
20/30 轮 apply/dispose 实测 `open == close`、无 `already-open`，**没有看到死循环或长阻塞**；
唯一的永久坏状态来自 S2-1（open 成功后抛错）而不是并发。

---

## 6. S6 与 DSH 集成的稳定性

### S6-1（低，F8 复核：**结论要改**）宿主**已经**有 per-entry 错误边界，不会整窗白屏；但崩溃的 entry 会被「退役」，面板本会话消失

- **证据（静态，从 DSH app.asar 读源码）**：`@deepseek-ai/dsh-client-ui-renderer/lib/client.js` 里有
  `SlotErrorBoundary`：
  ```js
  static getDerivedStateFromError(error) { if (error instanceof SlotAssemblyError) throw error; return { failed: true }; }
  componentDidCatch(error) { console.error(`slot entry crashed in '${this.props.slotKey}':`, error); this.props.onEntryError(error); }
  render() { if (this.state.failed) return <div data-slot-error={this.props.slotKey} />; return this.props.children; }
  ```
  注释明确：*"Per-entry isolation: one registrant crashing must not take down siblings … for shadowing kinds the report
  abdicates the entry, the outlet re-renders onto the cell's next survivor, and this boundary's crash face only shows
  until that re-render lands (permanently once the cell is dry)."*
- **对 F8 的修正**：原判断「插件没有错误边界 → 可能整块白屏」**高估了**：宿主给每个 slot entry 都套了边界，
  崩溃被限制在插件的格子内，不会白屏整页。**但**后果换了形态：entry 被 **abdicate（退役）**，
  面板在本会话里消失（空位 + `data-slot-error`），一次**瞬时**渲染错误也会让用户到下次刷新前都看不到待办。
- **建议**：插件自己在面板顶层加一个自绘错误边界（崩溃时显示「面板出错 + 重试」按钮），
  并保证渲染路径对脏数据防御（`storeAlerts`/`asArray`/`num` 已有，但 `groups[group.key]`、`row.title` 这类仍需兜底）。

### S6-2（低）重复注册一律「抛错」而不是幂等，这是 S1-1 的根因面（复核）

- **证据（静态，DSH 源码）**：
  - `webServer.register` → `throw new Error('webserver: duplicate exact route "…"')`（已在上文引用）；
  - `slots.register` → `single slot "…" already has a registration` / `list slot "…" already has an entry with id "…"`；
    `slots.registerFactory` → `slot factory "…" already has a definition`；
  - `locale.register` → `locale namespace "…" already has locale "…"`；
  - `systemPrompt.section` → 只要求 `order` 是有限数（插件的 3050 合法），同层重名才抛 —— 插件的调用点
    `lib/index.js:315-327` 有 try/catch 兜底（实测 `systemPrompt.section 抛错` 时 apply 仍 ok、8 路由 7 工具都在）。
- **插件侧现状**：`systemPrompt` 有兜底、`tools` 的注册有 `.catch` 兜底（失败会报在 `/worktodo/health` 的 `tools` 字段）、
  `webServer` **没有兜底**（S1-1）；客户端 `ctx.slots.inject(name, () => ctx.slots.register(…))` 的写法与官方
  `dsh-client-locale`/`dsh-client-ui-plugin-manager` **完全一致**（不是自创用法），失败会冒到客户端 apply
  （面板消失），但没有服务级的残留物泄漏。

### S6-3（低，复核通过）客户端 bundle 只用宿主 React

- **证据**：`lib/client.js` 里只有 `require("react")`，**没有**打包 react/react-dom（`createRoot`/`__SECRET_INTERNALS` 命中 0）；
  用到的 hooks 是 `useState/useEffect/useCallback/useMemo/useRef`（自 16.8 起稳定），
  且 `SessionAdopt` 的 hook 条件是「整块组件挂不挂载」，调用次数恒定 → 宿主升级 React 版本风险低。

---

## 7. 顺带发现（非稳定性，不计入结论）

- `src/client/index.js:1611` 侧栏标签硬编码中文 `label: () => '待办'`，而 locale 字典里有 `nav` 词条
  （英文界面会显示「待办」）。属 i18n 小瑕疵。
- `node tools/verify-all.mjs` 会先跑 `build-client.mjs`，**会重写 `lib/client.js`**（工作区里本来就是 M）。
  我验证过连跑两次产物哈希完全一致（`19d8ea1e…`），所以不是不确定性来源，但要知道它**不是只读验证命令**。

---

## 8. 严重级别汇总

| 级别 | 编号 | 一句话 |
| --- | --- | --- |
| **高** | S3-1 | 一次拖拽重排 = O(n²) 整文件重写：1000 条 3.9s/404 MiB，5000 条 97.9s/10.2 GiB |
| **高** | S1-1 | 路由注册抛错 → 插件挂不上 + 已注册路由泄漏无 disposer → 之后每次挂载必失败，只能重启 |
| **中** | S4-1 | 拖拽整批写静默覆盖另一窗口/agent 的写（两窗口都报成功） |
| **中** | S2-1 | `open()` 成功后抛错 → 领域句柄永久泄漏 + 永久降级到文件后端（`close()` 也救不回） |
| **中** | S1-2 | 挂载路径无超时：`storageDomain.open()` 挂住 → `apply()` 永不返回，面板/工具全无 |
| **中** | S3-3 | 每次轮询载荷 = 同一批数据的 3 倍；5000 条时 4.28 MiB/次、不可见仍轮询、多窗口线性翻倍 |
| **中** | S3-2 | 整段 reorder 期间事件循环零 macrotask → 整个 DSH 进程冻结（F11 的量级升级） |
| **低** | S2-2 | F9 复核：`.bak-` 不再堆积，但每 5 秒仍复制整份备份 + 1214 MiB/小时读 + 1440 条 warn/小时 |
| **低** | S4-2 | `readJsonBody` 无超时：慢客户端（不关 socket）会一直占住 handler（真断开时正常） |
| **低** | S4-3 | 超限请求被 destroy → 客户端只看到 ECONNRESET，看不到「请求体过大」 |
| **低** | S4-4 | ENOSPC 时 `writeAtomic` 残留 `*.tmp-<pid>`；只读/满盘整体「报错但仍可用」✅ |
| **低** | S6-1 | F8 复核：宿主有 per-entry 错误边界（不白屏），但崩溃 entry 会被退役 → 面板本会话消失 |
| 信息 | S1-3 / S2-3 / S5 / S6-2 / S6-3 | 20–30 轮 apply/dispose 零增长、open==close；客户端卸载清理齐全；并发写不丢（除 S4-1）；bundle 只用宿主 React |

## 9. 前三轮已有结论的复核结论

| 已有结论 | 复核结果 |
| --- | --- |
| **F11** 请求路径上的同步 IO | **仍然成立，而且明显变严重**：单次 put 依旧是整文件同步读+写（实测 n=5000 时 19.2ms / 整文件×1.00），但真正的危害来自 `reorder` 把它串成了 1000–5000 次连续同步 IO：3.9s–97.9s 的事件循环完全冻结（`monitorEventLoopDelay` 全程零采样）。建议从「低」上调，并优先做批量写。 |
| **F8** 无错误边界（可能白屏） | **结论要修正为更轻但不同**：宿主的 `SlotErrorBoundary` 已经把崩溃限制在单个 slot entry 内，不会整页白屏；代价是崩溃的 entry 被 **abdicate（退役）**，面板本会话消失。插件仍应自加错误边界（+重试按钮）。 |
| **轮询放大**（R4：10s→30s） | **方向对，但没解决根因**：间隔放宽到 30s ✅、`visibilitychange` 只在变可见时刷 ✅、卸载时清理 ✅；但**不可见时仍在轮询**、**多窗口线性翻倍**、每次载荷是同一批数据的 **3 倍**（5000 条时 4.28 MiB/次）。建议：载荷去重（只发一份）+ 不可见即停。 |

---

## 10. 建议的修复顺序

1. **S3-1 + S3-2 + S4-1（同一处改动）**：`reorder` 只 patch `order` 字段 + 一次批量原子写（N 次整文件写 → 1 次），
   顺带消掉拖拽覆盖并发写与 98 秒冻结。收益最大、风险最低。
2. **S1-1**：路由注册逐个入栈 + 单条失败降级 + 回调必定返回清理函数（根除「挂载失败 + 路由泄漏 + 不可自愈」）。
3. **S2-1 + S1-2**：`open()` 之后失败要 close 句柄；首次升级加 3 秒超时并移出挂载关键路径。
4. **S2-2**：备份去重改成「内容/大小+mtime」或指数退避，别让持续故障按 5 秒永久重试。
5. **S3-3**：`/list` 载荷去重 + 不可见停轮询（纯前端 + 一处响应结构，改动小）。
6. **S6-1**：面板顶层错误边界。

---

## 11. 修复状态（S1-1 / S1-2 / S2-1 / S2-2 / S3-1 / S3-2 / S3-3 / S4-1）

本轮修复只动四个文件：`src/store.mjs`、`src/service.mjs`、`lib/index.js`、以及测试
（`tools/verify-store.mjs`、`tools/verify-service.mjs`、`tools/smoke-host.mjs`）。
**没有**改 `src/client/index.js` / `lib/client.js` / `tools/smoke-client.mjs`（另一路修复的写域），
没有改 `.github/`、版本号、CHANGELOG，也没有提交 git。

### 11.1 逐条修法

| 编号 | 修法（文件） | 覆盖测试 |
| --- | --- | --- |
| **S1-1** | `lib/index.js` 路由注册改成「逐个 `addRoute(route)`」：内层 `try/catch` 包住每次 `webServer.register`，成功一个就 `disposers.push(disposer)`，失败只 warn 丢这一条；`webCtx.effect` 回调**一定**返回幂等 `disposeRoutes`；外层再包一层 try/catch 并在 `inject` 回调里 `return disposeRoutes`（cordis 的 `_execute` 会把 apply 返回值 collect 成 disposer）。任何路径都不会让 `apply` reject。 | `tools/smoke-host.mjs`：`makeServerLevelWebServer`（复刻「服务级路由表 + duplicate 抛错」语义），对 failAt=1/3/8 断言 apply 不 reject、8 条都被尝试、只有失败的那条缺失、工具 7 个照常、卸载后路由表归零、随后一次正常挂载 8 条且不撞 duplicate |
| **S3-1 + S3-2 + S4-1** | 新增「只改排序字段」的批量写：`store.updateOrder(ids)`。文件后端 = **一次读 + 一次原子写**，在一个写队列任务里基于刚读到的最新记录只 patch `order`（不改 `updatedAt`、不动其它字段）；domain 后端优先用官方 `table.update(key, fn)`（领域写链内读-改-写），老版本退化为 `get + put`。`service.reorder()` 只把「新顺序」交给 `store.updateOrder`，不再逐条 `put(整条快照)`；没有 `updateOrder` 的第三方句柄退化为「逐条只写 order」并注明仍有并发窗口。 | `tools/verify-store.mjs`：patch `node:fs` + `syncBuiltinESMExports()` 数次数与字节（n=1000 断言写 1 次 / rename 1 次 / 读 ≤2 次 / 写字节 ≤2 份文件）；只改 order（并发 title/priority/updatedAt 全保留，逐字段 diff 只剩 `order`）；domain 后端同样只 patch order 且走 `table.update`；顺序没变时写 0 次。`tools/verify-service.mjs`：reorder 只调一次 `updateOrder`、`put` 调用数不变（改前 6）、空/未知 ids 不碰存储、兼容路径只 patch order |
| **S2-1** | `src/store.mjs`：`storageDomain.open()` 成功之后的全部步骤（`table()`、日志、构造句柄）收进同一个 `try`，失败先 `await domain.close()` 再抛（句柄构造拆成 `createDomainHandle`）。`acquireDomain` 失败时照旧摘注册表，因此不存在「已打开但没人认领」的领域。 | `tools/verify-store.mjs`：注入「第一次 `open` 成功但 `table()` 抛错」的假 facility，断言 `close` 恰好 1 次、句柄不再 open、`mismatch` 带原始错误、故障消失后**还能**打开成 domain 并读写 |
| **S1-2** | `src/store.mjs` 新增 `acquireDomainWithTimeout`：`acquireDomain` 与 `setTimeout(UPGRADE_TIMEOUT_MS=3000)` 竞速（测试可用 `WORKTODO_UPGRADE_TIMEOUT_MS` 覆盖）。超时抛 `code='STORAGE_OPEN_TIMEOUT'`，`tryUpgrade` 据此把 mismatch 写成「打开超时…降级用回退文件」并 warn。**竞态安全**：超时之后那个 open 才成功时，晚到的 entry 立刻 `releaseDomain`（close + 摘注册表），不会把注册表毒化成永久 `already-open`。 | `tools/verify-store.mjs`：永不 resolve 的 `open` → 默认 3 秒（实测 2900–6000ms 窗口）降级、warn、之后照常读写；晚到 300ms 成功的 open（超时 100ms）→ `close=1`、句柄归还、同一服务再次打开仍是 domain。`tools/smoke-host.mjs`：挂载路径上 `open` 永不 resolve → `apply` 被超时兜住并完整挂载（8 路由 / 7 工具 / health 报 file + 超时原因） |
| **S2-2** | `src/store.mjs`：备份复用从「5 秒时间窗 + 大小」改成「**同一次故障只备份一次**」——`state.backupFault[slot]` 标记故障轮次，故障期间路径与大小不变就复用第一份；合并成功 / 退役成功才复位。删掉 `BACKUP_REUSE_MS` / `findReusableBackup` / `backupFileRotated`。 | `tools/verify-store.mjs`（F9 用例加强）：同一场合并失败重试 3 次 + **跨过 5 秒节流**再失败一次，`.bak-` 始终恰好 1 份（改前跨过窗口会变 2 份） |
| **S3-3** | `src/service.mjs` + `lib/index.js`：`/list` 支持 `shapes=todos\|groups\|projectGroups`（逗号组合 / `both` / `all`），只算、只回所选的那几份；响应回显 `shapes`；未显式指定且记录数 > 2000 时附 `payloadWarning` 提示可以只取一种形状。`groups` 与 `stats`/`store`/`projects` 等小字段不受影响。 | `tools/verify-service.mjs`：`shapes=todos` 时 `groups`/`projectGroups` 字段**不存在**、只有一个 `todos`；`groups`/`projectGroups`/组合/非法值/缺省（三份，旧面板合同不变）；>2000 条给提示、指定 shapes 后不提示。`tools/smoke-host.mjs`：真实 `/list?shapes=todos` 路由只回一份 |

### 11.2 性能实测（改前 / 改后，同一脚本 `/tmp/wt-perf.mjs`，patch `node:fs` 数次数与字节）

真机 Node v24.21.0（macOS），真实文件后端，一次 `reorder`（顺序完全反转，1000/5000 条都变）：

| 指标（n=1000，文件 333 KiB） | 改前 | 改后 | 变化 |
| --- | --- | --- | --- |
| 耗时 | **3479.5 ms** | **6.0 ms** | ÷580 |
| 读 | 1001 次 / 332698 KiB | 2 次 / 666 KiB | ÷500 次数 |
| 写 | 1000 次 / 332364 KiB | **1 次 / 332 KiB** | ÷1000 |
| rename | 1000 | 1 | ÷1000 |
| 写放大量 | 998.5 份文件 | **1.00 份文件** | — |
| 事件循环 | 整段 3.5s 内 0 个 macrotask（10ms 定时器 0 触发） | 阻塞段 = 一次批量写（~6ms）；结构上仍是同步 IO，但不再有秒级独占 | — |

| 指标（n=5000，文件 1673 KiB） | 改前（审计实测） | 改后（本次实测） |
| --- | --- | --- |
| 耗时 | **97.93 s** | **25.5 ms** |
| 读 | 5001 次 / 10159 MiB | 2 次 / 3345 KiB |
| 写 | 5000 次 / 10156.9 MiB | 1 次 / 1672 KiB |
| rename | 5000 | 1 |

测试套件内也留了一份带阈值的护栏（`tools/verify-store.mjs` 的 S3-1 用例，n=1000）：
断言 `write===1`、`rename===1`、`read<=2`、写入字节 ≤ 2 份文件、耗时 <1500ms；
机器无关的硬断言是写次数/字节量，时间只做量级护栏。跑测试时它自己会打印实测值，
全量门禁（10/10，跑了两次）里的那一行分别是：
`[perf] n=1000（文件 333 KiB）reorder 8.8ms ｜ 读 1 次 333 KiB、写 1 次 332 KiB、rename 1` 与 `reorder 8.6ms`（同一台机器上 6–10ms 波动）。

**S3-2 的残留**：`updateOrder` 仍然在一条同步 IO 路径上（文件后端没有换成 `fs/promises`），
所以「整段 reorder 期间一个 macrotask 都没有」在**单次批量写内部**依然成立 —— 只是窗口从
3.5s / 98s 缩到约 6ms / 25ms（一次整文件读 + 一次原子写）。F11（请求路径上的同步 IO）因此
降级回「单次毫秒级」，不再是「秒级冻结」。

### 11.3 反向验证（回退修复 → 测试必须变红）

做法：备份源文件 → 用字面替换精确回退该处修复 → 跑对应测试（永挂场景用 `perl alarm` 限时）→ 还原并核对 sha256。

| 反向验证 | 回退内容 | 结果 |
| --- | --- | --- |
| S1-1 | `lib/index.js`：`addRoute` 去掉 try/catch（恢复数组式语义）、外层 catch 直接 rethrow | ✗ 红：`第 1 条失败时 apply 绝不能 reject：期望 null，实际 {}`（`smoke-host` 37/1） |
| S2-1 | `src/store.mjs`：恢复 `const table = domain.table(...)`（open 后不关句柄） | ✗ 红：`open 成功之后抛错必须把领域句柄 close：期望 1，实际 0` |
| S1-2 | `src/store.mjs`：改回 `await acquireDomain(...)`（无超时） | ✗ 红：进程被 `alarm` 杀掉（exit≠0），Node 报 `Detected unsettled top-level await … S1-2：storageDomain.open 永不 resolve`，0 条输出「通过」 |
| S3-1/S3-2（存储侧） | `src/store.mjs`：文件后端的 `updateOrder` 改回「逐条整文件重写」 | ✗ 红：`整批只允许一次整文件写（改前是 1000 次）：期望 1，实际 1000` |
| S3-1/S4-1（服务侧） | `src/service.mjs`：`reorder` 改回逐条 `store.put(next[index])`（整条旧记录） | ✗ 红：`reorder 绝不能再逐条 put：期望 3，实际 6` |

还原后三个源码文件哈希均回到回退前值（`src/store.mjs=b3594c98…`、`src/service.mjs=bc90ac1b…`、`lib/index.js=0a3c27f4…`）；
此后 `src/service.mjs` 只又改了一处 JSDoc（`reorder` 的说明），不影响任何断言。

### 11.4 全量门禁

```
$ WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs
  ✓ 客户端 bundle 构建  (build-client.mjs)
  ✓ 数据模型 / 服务层 / 存储层 / 宿主接线与工具 / 客户端↔宿主契约 /
    客户端 bundle / CI workflow 契约 / 发布面审计 / 收录提交门禁
10/10 个步骤通过（含构建）
```

测试文件数保持 **9 个**（新增用例全部加进既有套件）。

### 11.5 未修项与取舍

- **S3-3 只做了「载荷去重 + 体量提示」，没做「不可见停轮询 / 多窗口节流 / React.memo」**：
  - `visibilitychange` 守卫、`React.memo` 都在 `src/client/index.js`，本轮是**别的 agent 的写域**，按约束不碰；
  - 「宿主侧按 session 节流」没有做：`/list` 是 `ctx.webServer` 上的无状态路由，请求里**没有 session 身份**
    （面板与宿主同源、不带会话头），按时间窗缓存响应会返回陈旧数据、按来源 IP 节流会把同机多面板一起误伤。
    权衡后选了「让调用方只取所需形状」这条**零语义风险**的杠杆：`shapes=todos` 时 5000 条的载荷从
    4.28 MiB/次降到约 1/3（单份 1249 KiB），且多窗口各自轮询时总载荷同比例下降。
  - 缺省仍是三份（旧面板兼容）；把面板改成默认只请求一种形状需要动客户端，留给客户端那一路。
- **S3-2 未做**：文件后端仍是同步 `fs`（`writeFileSync`/`renameSync`），只是从「N 次」降到「1 次」。
  要彻底消除那 ~6ms/25ms 的同步段需要把后端改成 `fs/promises` + 写队列（F11 的完整形态），本轮未做。
- **S4-2**（`readJsonBody` 无时间上限）、**S4-3**（超限被 `destroy` → 客户端只见 ECONNRESET）、
  **S4-4**（ENOSPC 残留 `*.tmp-<pid>`）、**S6-1/S6-2**（宿主/客户端错误边界与幂等注册）、
  **S1-3/S2-3/S5/S6-3**（信息项）本轮**未动**：不在必修清单里。
- S2-2 的修法是「同一次故障只备份一次」而不是指数退避：升级重试节流仍是固定 5 秒
  （持续故障仍会每 5 秒重试一轮，只是不再复制备份、不再刷 warn）。若要进一步收敛，需按 S2-2 建议做指数退避。

---

## 12. 残留项收口（第五轮：S3-3 客户端侧 / S4-2 / S4-3 / S4-4 / S2-2 / S6-2）

§11 留下的是中/低级别的残留项（两条高优先级 S3-1、S1-1 上一轮已修完）。本轮把它们收口。

**写域与边界**：只改了 `src/client/index.js`、`src/store.mjs`、`lib/index.js`、`tools/*`
（`tools/smoke-client.mjs`、`tools/smoke-host.mjs`、`tools/verify-store.mjs`）与本报告；
`lib/client.js` / `lib/client.js.map` 是 `verify-all` 会重建的产物。
**没有**改 `.github/`、版本号、CHANGELOG 版本段，**没有** git commit/push；
测试套件仍是 **9 个**（新用例全部加进既有套件）；所有实验都在 `/tmp` 的临时 `DSH_HOME`/临时目录里，
没有读写 `~/.dsh/storages/worktodo.json` 与 `~/.dsh/worktodo/*`。

收口后的文件哈希（sha256 前 16 位）：
`src/client/index.js = d280f544ceecb1b5`、`src/store.mjs = d6e73792eb7f4ad1`、
`lib/index.js = 3abae1a63470971c`、`lib/client.js = cc1a591bc3d7de6b`。

### 12.1 逐条修法

| 编号 | 修法（文件） | 覆盖测试 |
| --- | --- | --- |
| **S3-3 客户端侧** | `src/client/index.js`：① 新增 `VIEW_SHAPES = {due:'groups', project:'projectGroups'}` 与 `shapesForView()`，`useList(sort, shapes)` 把 `shapes` 拼进**唯一**那个列表 GET（`/list?filter=all&sort=…&shapes=…`，前缀合同不变），并按形状分开缓存（`lastListByShapes`），切视图不会先拿另一种形状的旧载荷渲染；② `hasViewShape()`：切视图后新载荷还没到时按「加载中」渲染，不闪一下空列表；③ `isWindowHidden()` + 定时器守卫：`document.visibilityState === 'hidden'` 时轮询直接 return（一次都不打宿主），`visibilitychange` 只在变可见时补一次；④ `TodoRow` 用 `React.memo` 包住；为让**浅比较真的生效**：兜底 `t` 从「每次渲染新建的箭头函数」改成模块级常量 `FALLBACK_T`、`Group` 传**共享**的 `drag` 对象 + 布尔 `dragging`（不再每行每次渲染各造一个 drag 对象）、`onToggle/onRemove/onSave` 保持 `useCallback`；⑤ 拖拽顺序改用 `payloadRecordIds(data)`（有 `todos` 用 `todos`，只有分组形状时按面板展示的桶顺序摊平），所以「按截止」只取 `groups` 也能正常拖动；⑥ `postJson` 在 HTTP 非 200 时先读宿主的 `{reason,error}`（配合 S4-3，用户看得到「请求体过大」而不是「HTTP 413」）。<br>兼容：宿主缺省（不带 `shapes`）仍是三份；旧宿主会忽略这个参数（多给一份而不是少给），旧面板不传参数也照常。 | `tools/smoke-client.mjs` 新增 4 条：按视图只取一种形状（含切换后重新请求）、隐藏停轮询 / 重新可见补一次、`React.memo` 行重渲染计数、`payloadRecordIds` 纯函数（含只有 groups/projectGroups 与脏数据）。为量出「父级重渲染」给迷你渲染器补了 memo 语义：**按元素位置浅比较 props、相等就跳过整棵子树**，并加了「实例级稳定 hook」（`useState/useCallback/useMemo` 一个窗口内按位置保留）——只有新用例打开，既有用例行为不变 |
| **S4-2** | `lib/index.js`：`readJsonBody` 改成幂等 settle + 清定时器/摘监听的收口结构；加**时间上限**（默认 `5000ms`，`WORKTODO_BODY_TIMEOUT_MS` 可注入）+ 监听 `close`。超时/未读完时 `request.pause()` 后 reject 带 `statusCode`/`reason` 的错误；`method()` 的 catch 对带状态码的错误回 **408/413/400 + JSON 原因**（没有状态码的仍走既有「200 + `{ok:false,reason:'internal'}`」合同）。 | `tools/smoke-host.mjs`：半包/不结束的请求（`Readable` 只 push 不 end）在注入 120ms 超时后必须 settle 且回 408 + `body-timeout` + 中文原因，之后 `/list` 照常；用例自带 2 秒安全网（改前是「一直不 settle」，安全网把它变成明确红灯而不是挂死） |
| **S4-3** | `lib/index.js`：超限不再 `request.destroy()`（那会让调用方只看到 ECONNRESET）。改成 `pause()` 停止读 + 回 **413 `{reason:'body-too-large'}`**，未读完的请求由 Node 在响应结束后收掉。客户端 `postJson` 优先显示宿主给的原文。 | `tools/smoke-host.mjs` 两条：真 `http.Server` + 裸 socket（发 300 KiB 后**不结束**请求）断言客户端读到 `HTTP/1.1 413` 且响应体含 `body-too-large`、不含 `ECONNRESET`；另一条用假 request 流断言同一 chunk 就超时也回 413（不是 200/internal） |
| **S4-4** | `src/store.mjs`：`writeAtomic` 的「写临时文件 → rename」整段包进 try/catch，失败先 `rmSync(tmp,{force:true})` 再**原样抛出**（绝不盖掉原始错误）。新增注入点 `WORKTODO_TEST_FAULT=write-atomic-fail`：临时文件真实写出来后抛 `ENOSPC`（复刻满盘）。 | `tools/verify-store.mjs`：注入失败 → 目录里**不再有** `*.tmp-*`、错误里仍是 `ENOSPC`、盘上文件仍是完整合法 JSON（只有失败前那一条）、故障消失后照常写入且仍无残留 |
| **S2-2** | `src/store.mjs`：新增纯函数 `upgradeRetryDelayMs(failures) = min(基数 × 2^(n-1), 300000)`（基数默认 `5000ms`，`WORKTODO_UPGRADE_RETRY_MS` 可注入），导出以便直接验序列。`tryUpgrade` 的节流状态从 `{service, at}` 换成 `{service, failures, nextAt}`：失败时 `failures+1` 并算出下一次允许时间（连续失败 5s→10s→20s→40s→80s→160s→**封顶 5 分钟**），换 `storageDomain` 服务重新计数，**升级成功后复位**。「同一次故障只备份一次」（`backupFault`）原样保留。 | `tools/verify-store.mjs` 两条：退避序列（含封顶与基数注入）；把基数缩到 50ms 后开一个 800ms 窗口反复驱动 `refreshBackend()`，断言尝试次数远少于固定节流、且相邻间隔必须明显递增（改前 16 次） |
| **S6-2** | **客户端侧补兜底**（`src/client/index.js`）：新增 `safeRegister(label, run)`，包住 `locale.register` 与两个 `slots.register`。官方对重复注册是抛错（`already has a registration`），改前会一路抛到客户端 `apply` → **面板整体消失、只能刷新页面**；现在只丢这一条 + 一行 `console.warn`（带原始原因），main 面板照常注册。**宿主侧只补断言**（`src/tools.mjs` 不在本轮写域）。 | `tools/smoke-client.mjs` 两条：两个 slot 都被占用 + locale 重复 → `apply` 不抛、两个 slot 注入回调都被调用、3 条 warn 带原始原因；侧栏 slot 失败时 main 面板照常注册。`tools/smoke-host.mjs` 一条：同名工具重复注册 → `apply` 不 reject、8 条路由照常、`/health` 明确报 `tools.status='failed'` + 原始错误 |

### 12.2 实测数字（改前 / 改后）

**S3-3 载荷**（`/tmp/wt-shapes-measure.mjs`：5000 条、文件 1393 KiB，走**真实路由 handler**，量响应文本字节）

| 请求 | 响应体 | 说明 |
| --- | --- | --- |
| 改前（面板旧行为，不带 `shapes`） | **4181.1 KiB**（≈4.08 MiB） | `todos` + `groups` + `projectGroups` 三份同样大的数据 |
| 改后「按截止」`shapes=groups` | **1393.9 KiB** | **÷3.00**（−66.7%） |
| 改后「按项目」`shapes=projectGroups` | **1394.1 KiB** | **÷3.00** |
| 参考 `shapes=todos` | 1393.8 KiB | 单份形状的大小 |

一次轮询的载荷 ÷3；4 个窗口同时开时每 30 秒从 **16.3 MiB 降到 5.4 MiB**；窗口隐藏时**整段为 0**。

**S3-3 隐藏窗口 60 秒内的请求次数**（`tools/smoke-client.mjs` 实测打印 `[poll]`）

```
[poll] 60 秒窗口：隐藏 0 次刷新 / 可见 2 次；重新可见 +1 次
```

改前：隐藏与可见都是 2 次（不可见时白打宿主，多窗口线性翻倍）。

**S3-3 `React.memo` 渲染次数**（6 行 × 3 次父级渲染；同一台机器、同一个渲染替身）

```
改后：[memo] 6 行 × 3 次父级渲染：行 body 实际渲染 6 次（第一遍 6）、被 memo 跳过 12 次
改前：行 body 实际渲染 18 次（每次父级重渲染都 6 行全跑；`WORKTODO_TEST_MEMO=off` 复现改前语义）
```

**S4-2 / S4-3**

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| 半包 + 不关 socket（`Content-Length: 5000` 只发 9 字节） | handler **永不 settle**（测试等到 2001ms 仍在挂，实际靠 Node 300s `requestTimeout` 兜底） | 注入 120ms 超时 → **约 130ms** 返回 `408 {reason:'body-timeout'}`（生产默认 5s） |
| 请求体 300 KiB（上限 256 KiB）后不结束 | 客户端拿到**空响应**（socket 被 RST；fetch 侧表现为 `ECONNRESET socket hang up`） | **`HTTP/1.1 413` + `body-too-large`**，连接由 Node 在响应结束后收掉 |

**S4-4 满盘残留**（注入 `WORKTODO_TEST_FAULT=write-atomic-fail`）

```
改前：写失败后目录 = ["todos.json","todos.json.tmp-15910"]   ← 残留自己刚写的临时文件
改后：写失败后目录 = ["todos.json"]                          ← 无 *.tmp-*，文件仍是完整 JSON
```

**S2-2 退避**（verify-store 实测打印 `[backoff]`；把基数缩到 50ms 以便在 800ms 窗口内观察）

```
退避序列（failures=1..8,20）：5000 → 10000 → 20000 → 40000 → 80000 → 160000 → 300000（封顶）→ 300000 → 300000 ms
改后：[backoff] 800ms 内 5 次尝试｜间隔 52ms → 104ms → 204ms → 403ms
改前：[backoff] 同样条件 800ms 内 16 次尝试（固定 5 秒节流缩到 50ms 后就是固定 50ms 一轮）
```

即：持续故障下重试频率从「每 5 秒一轮、永不收敛」变成「5s→10s→20s…封顶 5 分钟」，第一次重试仍是 5 秒
（偶发失败/服务晚注册的恢复速度不变），成功后复位。

### 12.3 反向验证（回退修复 → 对应测试必须变红）

做法：备份源文件 → 用字面替换精确回退该处修复 → （客户端改动先 `build-client.mjs` 重建）→ 跑对应套件 →
还原并核对 sha256 与回退前一致。8 条全部变红：

| 反向验证 | 回退内容 | 结果 |
| --- | --- | --- |
| S3-3 形状 | `src/client/index.js`：列表 URL 去掉 `&shapes=…`（改回「一次拿三份」） | ✗ 红：`「按截止」必须只取 groups：/worktodo/list?filter=all&sort=manual 期望 true，实际 false`（30/1） |
| S3-3 停轮询 | `src/client/index.js`：定时器回调去掉 `isWindowHidden()` 守卫 | ✗ 红：`隐藏 60 秒内必须 0 次刷新（改前是 2 次）：实际 2`（30/1） |
| S3-3 memo | `src/client/index.js`：`TodoRow` 去掉 `React.memo(...)` 包装 | ✗ 红：`面板的列表行必须用 React.memo 包住…期望 true，实际 false`（30/1）；另用 `WORKTODO_TEST_MEMO=off` 复现改前比较语义 → `期望 6，实际 18` |
| S4-2 超时 | `lib/index.js`：`readJsonBody` 去掉 `setTimeout` 超时（改回只监听 data/end/error） | ✗ 红：`handler 必须在超时后 settle（改前会挂住不返回；已等 2001ms）：期望 true，实际 false`（41/1） |
| S4-3 状态码 | `lib/index.js`：超限改回 `reject(...); request.destroy();` | ✗ 红两条：真 socket 用例 `客户端必须拿到明确的 413…期望 true，实际 false`（客户端实测拿到空响应）；假流用例 `超限必须回 413（实际 200）`（40/2） |
| S4-4 残留 | `src/store.mjs`：`writeAtomic` 的 catch 去掉 `rmSync(tmp)` | ✗ 红：`写失败后不许留下 *.tmp-*…["todos.json.tmp-15910"] 期望 []`（36/1） |
| S2-2 退避 | `src/store.mjs`：`upgradeRetryDelayMs` 改回恒返回基数（= 固定节流） | ✗ 红两条：序列实际 `[5000,5000,…]`；`800ms 内不许像固定 50ms 节流那样重试十几次（改前约 15 次，实际 16 次）`（35/2） |
| S6-2 幂等 | `src/client/index.js`：main slot 与 locale 改回直接 `register` | ✗ 红：`重复注册不能让客户端 apply 抛错…期望 null，实际 {}`（30/1） |

还原后四个被改源码文件的 sha256 全部回到回退前值（见 12 开头哈希），随后全量门禁重跑 10/10。

### 12.4 全量门禁（含构建）

```
$ WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs
  ✓ 客户端 bundle 构建  (build-client.mjs)
  ✓ 数据模型 / 服务层 / 存储层 / 宿主接线与工具 / 客户端↔宿主契约 /
    客户端 bundle / CI workflow 契约 / 发布面审计 / 收录提交门禁
10/10 个步骤通过（含构建）
```

套件内逐条的用例数（本轮新增后）：`verify-store` 37、`smoke-host` 42、`smoke-client` 32，
其余套件未改动、照常全绿。测试套件数仍是 **9 个**。

### 12.5 未做项与原因

- **S3-2 残留（同步 IO）**：文件后端仍是 `writeFileSync`/`renameSync`。本轮只做到「一次拖拽 = 一次整文件写」
  （§11.2 的 ÷1000），要把那 ~6–25ms 的同步段也消掉得把后端换成 `fs/promises` + 写队列（F11 的完整形态）。
  不在本轮清单里，且改动面比其余残留项大一个量级。
- **S6-2 宿主侧工具注册仍是「一条失败 → 整批不算数」**：`src/tools.mjs` 里 7 次 `ctx.tools.register` 是
  顺序调用 + 一个 `disposers` 数组，第 N 条抛错会让 `registerWorkTodoTools` 整体 reject（`lib/index.js`
  捕获后 `tools.status='failed'`、`registered=0`）。**`src/tools.mjs` 不在本轮写域**，所以只补了断言把现状钉住
  （`smoke-host` 那条明确断言 `health.tools.registered === 0`）。要修的话与 §11 的 S1-1 同一手法（逐条注册、
  逐条降级），是下一轮最小的一处改动。
- **S6-1（面板错误边界）**：复核后**本来就有**——面板与侧栏入口都包在 `WorkTodoErrorBoundary` 里
  （中文兜底 + `error.message` 摘要 + 「重试」换 key 重挂载 + 原始 error 进 console），`smoke-client` 已有
  4 条断言覆盖（含「堆栈绝不进 DOM」）。本轮没有新增改动，只把它与 S4 的状态码路径串起来：
  现在 4xx 的具体原因也会经 `postJson` 显示在面板错误条上。
- **宿主侧按 session 节流未做**：`/list` 是无状态路由、请求里没有 session 身份，按时间窗缓存会返回陈旧数据、
  按 IP 节流会误伤同机多窗口（§11.5 的取舍不变）。本轮把「多窗口/不可见」的成本从**客户端**这一侧收掉了
  （隐藏即 0、每次只取 1/3），比在宿主侧猜来源更安全。
- **S1-3 / S2-3 / S5 / S6-3**（信息项）与 **多窗口节流**未动：不在清单里。
- 一处**行为说明**（不是缺陷）：「按截止」视图只取 `groups` 后，拖拽顺序改由 `payloadRecordIds()` 从当前
  展示的桶摊平得到。面板本来就是分组展示，桶内顺序由宿主按当前 sort 排好，所以拖拽结果与用户看到的一致；
  代价是「跨组的全局位次」不再来自 `todos`（分组视图下这个位次本来就不可见）。`smoke-client` 的
  `payloadRecordIds` 用例把这条语义钉住了。
