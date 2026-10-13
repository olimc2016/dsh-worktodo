# dsh-worktodo 0.2.1 复审（审「修复本身」）

**结论一句话：可以放行，但有 1 条必须先修 —— F1 的合并只把回退文件镜像写一次（快照），升级之后 domain 侧的删除/新增不再同步到回退文件，已实跑证明「用户删掉的待办会在下一次合并时复活」。**

- 复审对象：`9246dd3`（父提交 `6e9aee7`），工作区 `git status` 干净、`lib/client.js` 与 `src/client/index.js` 同步（重建后哈希一致）。
- 复审方式：先读 `git show 9246dd3` 与当前工作区，再**实跑**交错/竞态/备份/回退实验（脚本写在 `/tmp`，未改仓库文件；`src/*` 只在「临时回退验证」时改过，每次都用 `shasum` 校验恢复）。
- 全量测试：`WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs` → **9/9 通过，exit 0（约 1.0s）**。
- 报告里的路径一律写 `~/...`。

---

## 复审结论摘要

| # | 严重级别 | 一句话 | 证据类型 |
| --- | --- | --- | --- |
| **R1** | **高（新引入 / F1 修复不完整）** | 合并只把回退文件镜像成**当时快照**，升级后 domain 侧的删除不会同步过去 → 下一次合并**复活已删待办** | **实跑**（exp8） |
| **R2** | **中（新引入）** | 升级、以及「卸载后立刻重载」时会短暂降级回退文件，并撞官方 `already-open`，此时**面板可能读到空列表** | **实跑**（exp4/exp7） |
| **R3** | 中（新引入，测试缺口） | `verify-all.mjs` 不重建 `lib/client.js`，客户端 src 的改动在没有 build 时**完全测不到**（F6/F7 的用例会被假绿） | **实跑**（R6/R8 对比） |
| **R4** | 低（新引入） | `ctx.inject(['storageDomain'], …)` 里 `store.refreshBackend` 是 fire-and-forget，**卸载/重载与升级可以重叠**，会泄漏未释放的领域句柄 | 静态推断 + exp4 佐证 |
| **R5** | 低（修复宣称与实现不符） | `describe().split/mismatch/merge` 虽然传给客户端，但面板**没有任何渲染**；审计报告里「面板给出显眼的不一致告警」并未实现 | **实跑**（grep + 渲染路径） |
| **R6** | 低（F8 判断复核） | F8（`try/catch` 包 hook）维持「低」是合理的，不是被低估的白屏项 | 静态推断 |
| **R7** | 低（F16 维持） | F16（`/health` 读失败显示 `count: 0`）维持「低」；但它是**唯一**能反映「数据读不出来」的面板可见信号，建议顺手带上 `error` | 静态推断 |

**F1/F2/F3/F5/F6/F7 的修复方向本身是对的，主要用例也真的会被回退打红**（见下面「C. 测试牙齿」）。问题集中在 F1 的**合并后同步**与**重载时序**两处细节。

---

## A. F1「可纠正句柄 + 按 id 合并」的正确性

### R1（高）合并把回退文件镜像成「快照」，升级后的删除不会被同步 → 删除复活

**位置**
- `src/store.mjs:514-545`（`mergeInto`：`const sourceRecords = await source.load()` 取的是**时刻快照**；只有末尾 `await source.replaceAll(todos)` 这一次镜像写）
- `src/store.mjs:537-545`（镜像条件 `source.kind === 'file' && sourceRecords.length`）
- `src/store.mjs:604-611`（`put/remove` 先 `await refreshBackend()`，**不会**在升级期间把写路由到文件）

**现象**
`mergeInto` 的流程是「读快照 → 逐条写进 domain → 用**同一个快照**把回退文件整体覆盖」。升级完成之后，`current` 变成 domain，`put/remove` 全部落在 domain；**回退文件从此再也不会被更新**，永远停在升级那一刻的内容。于是：

- domain 里**新增**的记录 → 回退文件里没有；
- domain 里**删除**的记录 → 回退文件里还留着；
- 下一次以回退文件为 source 的合并（重载、卸载后重载、domain 重新打开）走 `unionById(target=domain, incoming=file)`，而 `unionById` **只做并集、没有墓碑（tombstone）**：file 里那条「用户已经删掉」的记录会被当成 `added` 补回 domain。

**证据（实跑）** `/tmp` 脚本（假 facility 复刻官方 `open`/`table.entries/put/delete`/`already-open` 语义，真文件 IO）：

```
### exp7：升级窗口里任何一次走公开接口的写入，镜像都跟不上（10/10）
delay=  0ms  store.kind=domain  file=["wt-C","wt-A"]  domain=["wt-C","wt-A","wt-X"]  X 两边都有? false
delay=  5ms  ... 同样
...
delay=130ms  ... 同样
不一致 10/10

### exp8：回退文件里的旧拷贝让「已删除」的记录复活
升级后 file = [ 'wt-C', 'wt-A' ]  domain = [ 'wt-C', 'wt-A' ]
用户删除 C（走公开接口，写 domain）
删除后 file = [ 'wt-C', 'wt-A' ]  domain = [ 'wt-A' ]     ← 镜像里还留着 C
第二次合并后 ids = [ 'wt-A', 'wt-C' ]
>> 用户删掉的 wt-C 复活了吗 = true
```

**为什么现有用例抓不到**：`tools/verify-store.mjs:246-248` 只断言「**升级刚结束时**回退文件 == 并集」；没有任何用例在升级**之后**再改 domain，然后做第二次合并。也就是说这条正好落在 `verify-store.mjs` 的「镜像」断言与「二次挂载」断言之间的空档。

**最小修复建议（任选其一，建议 A）**
- **A（推荐）**：升级完成后，把回退文件当作**只读迁移源**：要么删掉它（或改名成 `todos.json.migrated-<时间>`），要么在 `describe()` 之外明确标注「此文件已停用」。不要再让它有机会当 source。
- **B**：让镜像真正同步 —— 每次 `put/remove` 成功后都 `replaceAll` 一次回退文件（成本 O(n)，但 n 很小）。这样 file 永远等于 domain，`unionById` 的「并集」语义才成立。
- **C（最省事但语义弱）**：给合并加墓碑判断 —— 若 file 里的记录 `updatedAt` **早于**本次升级时间且 domain 里没有，就不补回（会漏掉「升级期间真的新增」的记录，不推荐）。
- 无论选哪个，都要补一条用例：**升级 → 在 domain 删除一条 → 触发第二次合并 → 断言它没复活**。

### A1. 并发/竞态：会不会写丢/写重/两边各写一份？

**结论：走公开接口（路由 / `worktodo_*` 工具）的写入不会丢**，因为 `put/remove/load` 第一件事就是 `await refreshBackend()`（`src/store.mjs:600-611`），它会 `await` 同一个 `upgrading` promise，所以写入一定落在**升级完成之后**的后端。

**但有一个真实的不一致**：升级完成前/中的写入会让**回退文件与 domain 长期不一致**（= R1 的触发条件）。exp7 的 10/10 就是这么来的 —— 记录没丢（在 domain 里），但回退文件永远少一条，下一次合并就会把别的东西补回来/复活。

另外 `mergeInto` 内部逐条 `await target.put(record)`（`src/store.mjs:530`），这一步**没有** `enqueue` 之类的串行化，也没有去重；好在该循环只在单次升级里跑一次，且 `upgrading` 去重了并发升级，所以不会写重。

### A2. 幂等性：升级/合并重复执行会不会重复插入或丢记录？

- **同一个服务对象**上重复升级：`acquireDomain` 用模块级 `WeakMap` 缓存同一个 `promise`（`src/store.mjs:337-357`），`open()` 只调一次；`current.kind === 'domain'` 之后 `tryUpgrade` 直接返回（`src/store.mjs:463`）。**幂等，实跑确认**（exp4：`open 次数 = 1`）。
- **`open()` 失败后重试**：`acquireDomain` 的 catch 会把坏 promise 从 WeakMap 里删掉（`src/store.mjs:348-356`），所以下一次是**重新 open**，不会永远拿到失败结果。
- **按 id 合并**：`unionById` 用 `Map` 按 id 去重（`src/store.mjs:374-393`），同 id 不会变成两条 —— **幂等**。
- **但**「两边各保留一份」的写法在 R1 的场景下不幂等：每做一次以 file 为 source 的合并，被删掉的记录就复活一次。这是 R1，不是重复插入。

### A3. `ctx.effect(() => store.close())` + WeakMap 引用计数

**结论：引用计数本身是对的；但「一个实例 close 掉另一个正在用的句柄」这条没有复现，反而是「卸载后立刻重载」会降级。**

**实跑（exp4）**
```
== (a) 两个实例共享同一服务，实例 A 关闭 ==
A.kind = domain  B.kind = domain  open 次数 = 1
A.close() 之后：B.kind = domain  close 次数 = 0   ← 正确：B 还在用，句柄没被关
B 还能读吗 = [ 'wt-D' ]
B.close() 之后：close 次数 = 1                    ← 正确：最后一个使用者才关
```
引用计数在异常路径上也没有观察到泄漏：`tryUpgrade` 里 `mergeInto` 失败会 `await releaseDomain(entry)`（`src/store.mjs:487`）；`close()` 里 `releaseDomain` 用 `Math.max(0, refs-1)` 兜底（`src/store.mjs:362`），不会变负数。

**但（R2，见下）`close()` 不 await、`refreshBackend` fire-and-forget 会让「卸载 → 重载」撞 already-open。** 另外 `close()` 里 `domainEntry` 与 `upgrade` 的重叠有理论泄漏窗口（R4）。

### R2（中）卸载后立刻重载：撞 `already-open` → 短暂降级到回退文件

**位置** `lib/index.js:170-176`（`ctx.effect(() => () => { Promise.resolve().then(() => store.close()) })`，**不 await**）、`lib/index.js:179-188`（inject 回调里 `void Promise.resolve().then(() => store.refreshBackend())`）、`src/store.mjs:360-366`（`releaseDomain` 先 `registry.delete` 再 `await backend.close()`）

**现象**
卸载和重载是两件事、可以重叠。旧实例的 `close()` 是在微任务里跑的，且 `releaseDomain` **先删注册表项、再 await `domain.close()`**。新实例在这中间 `open()`，就会撞官方 `already-open` → 走 `state.mismatch` 分支 → **停留在 file 后端**（不是崩溃，但会读回退文件；若回退文件是空的/没有，用户视角就是"待办全没了"，正是 F1 的原始症状）。

**证据（实跑，exp4 (b)）**
```
C.kind = domain open = 1
[warn] ⚠️ 首选官方 storage（领域 worktodo）但打开失败：domain 'worktodo' is already open；当前仍在使用 JSON 文件 ...
D.kind = file   open 调用序列 = ["enter","enter","enter","REJECT already-open"]
稍等之后 D.kind = file  ← 重试节流 5s，不会立刻自愈
```

**缓解（已存在的、不算全无）**：`UPGRADE_RETRY_MS = 5000` 的重试节流（`src/store.mjs:34,470`）会在 5 秒后自愈 —— 实跑确认（exp6 第 2 段：等待 5.1s 后 `kind = domain`）。但**降级窗口内 `/list` 会读回退文件**，而回退文件在 R1 下是过期的。

**为什么现有用例抓不到**：`tools/smoke-host.mjs:628-676` 是**先 `apply` 两次、再 dispose**，从来没有「dispose 之后（不 await）立刻再 apply」；而且假 ctx 的 `inject` 是**同步立即回调**（`tools/smoke-host.mjs:119-123`），连「服务晚注册」都测不到真实时序。

**最小修复建议**
- `close()` 别用 fire-and-forget：`ctx.effect` 的 dispose 支持返回 Promise 时，把 `store.close()` 直接返回（让 cordis 等它）。
- `releaseDomain` 改成 **先 `await backend.close()` 再删注册表项**；或者保留一个「正在关闭」的哨兵，让新实例 `await` 旧关闭完成再 `open`。
- 在 `acquireDomain` 的 catch 里加一次**短延迟重试**（例如 50ms 后再试一次），把「卸载/重载重叠」这种瞬时 already-open 吃掉，而不是立刻降级。

### A4. merge 方向：同 id 冲突真的会保留更新的那条吗？

**会。** `unionById` 用 `Number.isFinite(updatedAt) ? updatedAt : 0` 比较（`src/store.mjs:388-390`），**双向都取新的**（`tools/verify-store.mjs:253-278` 两个方向都有断言）。实跑（exp12）：

```
改名后：domain wt-A.title = 用户改过的新标题 （updatedAt=999999）
改名后：file   wt-A.title = 原标题 （updatedAt=1000）     ← 镜像落后
再合并后 domain 里的 wt-A.title = 用户改过的新标题  updatedAt = 999999
>> 用户的改名被旧镜像盖回去了吗 = false
```

即「官方侧优先」只在 `updatedAt` **相同**时生效（`src/store.mjs:390` 用 `>` 而不是 `>=`），符合报告描述。

**注意**：「两边都保留一份」的写法在**写到一半抛错**时**不会**产生重复（同 id 永远走 `Map.set`），但会留下 R1 那种长期不一致。

### A5. 可纠正句柄失败时的降级：会不会无限重试 / 每次请求都重试？

**不会，节流是有效的。** 实跑（exp6）：

```
== (1) open 一直失败：每次请求都重试吗？（节流 5s）
   8 次 load() 之后 facility.open 调用次数 = 1   ← 没有每请求重试
   warn 次数 = 1  同一条反复刷吗 = 1            ← 没有刷日志
== (2) open 恢复可用：5.1s 后 kind = domain    ← 能自愈
```

`lastAttempt = { service, at }` 以**服务对象**为键（`src/store.mjs:432,470`），同一个坏服务 5 秒内只试一次。唯一的小瑕疵：服务对象换了（重载后是新对象）就会立刻再试一次，这正是 R2 里那条 already-open 日志产生的地方 —— 属于「合理但会降级」的取舍，不是无限重试。

**会不会把已有数据写坏？** 不会。降级期间写的是回退文件（`put` 走读-改-写 + `writeAtomic`），domain 侧一个字都没动；等 `open()` 成功后才合并。真正的问题是 R1 的镜像不同步。

---

## B. 新代码会不会让插件/DSH 出问题

### B1. `apply()` / `ctx.inject` 回调里有没有能抛异常的地方？

- `apply` 里新增的三段（`ctx.effect` 生命周期、`ctx.inject(['storageDomain'], …)`、store/service 事件接线）**都不会同步抛**：`ctx.effect` 回调体只返回一个闭包；inject 回调体里 `tryUpgrade` 的失败已经被 `tryUpgrade` 自己 catch（`src/store.mjs:474-489`），外层还套了 `.catch()`（`lib/index.js:181-186`）。
- 唯一没有 catch 的是 `store.onChanged?.((change) => { service.notifyStoreChange?.(change); })`（`lib/index.js:190-193`）—— 但 `emit` 内部对每个 listener 都 `try/catch`（`src/store.mjs:441-449`），`service.notifyStoreChange` 也只是 `emit` 的转发（`src/service.mjs:309-313`），所以这条链不会把异常抛回 apply。
- **结论：不会因为新增代码导致 apply 抛错、插件挂载失败。** 需要留意的是 `acquireDomain` 在 `ctx.inject` 回调触发时会**真的**在 `open()` 里做校验（官方会对每条记录跑 `valueSchema.parse`），如果某条存盘记录被判 invalid 且 `invalidRecords` 语义变化，异常会被上面那两层 catch 吃掉并留在 file 后端（不崩）。

### B2. 面板 10s 轮询：会不会堆积？`clearInterval` 在所有卸载路径都执行吗？

- **不会堆积成灾，但也不是没有代价。** `useList` 的取数 effect 用 `alive` 标志位而不是 `AbortController`（`src/client/index.js:487-513`）：旧的 fetch **不会被中止**，只是丢弃结果。所以宿主慢的时候，10 秒一次可能叠加 2–3 个在途请求。待办规模小、本地请求快，实际影响低。
- **清理是干净的**：`clearInterval(timer)` + `window.removeEventListener('focus')` + `document.removeEventListener('visibilitychange')` 都写在同一个 `React.useEffect` 的清理函数里（`src/client/index.js:1095-1109`），依赖 `[refresh]`，而 `refresh` 是 `useCallback(..., [])`（`src/client/index.js:515`）→ **effect 只注册一次、cleanup 只跑一次**，没有「每次渲染重挂定时器」的问题。
- **两条小提醒**：`visibilitychange` 在**变成隐藏时也会触发** `refresh()`（没按 `document.visibilityState` 过滤），比"重新聚焦才刷"多打一次宿主；另外轮询不管面板当前是否可见都在跑（侧栏面板切走后 React 通常会卸载，但如果宿主用 `display:none` 隐藏而不卸载，就会一直拉）。
- 定时器替身只在测试里被调用（`tools/smoke-client.mjs:75-80`），`unref?.()` 让 Node 测试不被挂住，不会影响浏览器。

### B3. 新增备份文件会不会无上限增长 / 写到 DSH_HOME 之外？

- **都在同一个目录、同一个 basename 族里**：`quarantineFile` → `<path>.corrupt-<时间>.bak`（`src/store.mjs:94-106`）、`writeDroppedBackup` → `<path>.dropped-<时间>.json`（`src/store.mjs:115-124`）、`backupFile` → `<path>.bak-<时间>`（`src/store.mjs:75-85`）。`<path>` 只会是 `$DSH_HOME/worktodo/todos.json` 或用户显式配置的 `storePath`，**没有逃出 DSH_HOME 的路径**。
- **增长是「按事件」而不是「按写入」**：实跑（exp10）证明 `.dropped-*` 只在**第一次**发现垃圾条目并写回时产生一份（写回后垃圾就从文件里消失了），`.corrupt-*` 是**每次重新把文件改坏**才多一份：

```
(b) 文件里有一条垃圾条目 + 连续 3 次写入（文件本身合法）
   .dropped-* 个数 = 1        ← 只一份，之后文件已干净
   .bak-* 个数 = 0
(a) 坏 JSON 文件 + 连续 3 次写入 → .corrupt-* 个数 = 3   （每次都是我重新改坏一次）
```
- 所以**不算无上限增长**；但 `fileStamp()` 只到**秒**（`src/store.mjs:62-66`），同一秒内两次 `put` 命中坏文件时 `quarantineFile` 靠 `-1/-2` 序号避让（`src/store.mjs:96-98`），而 `writeDroppedBackup`（`src/store.mjs:116`）**没有避让**，同秒第二次会覆盖第一份。属于低。

### B4. `store.onChanged → service.notifyStoreChange → 面板刷新` 有没有反馈环？

**没有反馈环。** 链路是 `domain/changed`（由**别的写入者**触发）→ `emit`（`src/store.mjs:305-313`）→ `service.notifyStoreChange` → `emit` 给 `service.onChange` 的监听者（`src/service.mjs:309-313`）。宿主对 `service.onChange` 只做**计数**，不改数据（`lib/index.js:194-197`）；面板收到变更后只是重新 `GET /list`（读操作）。所以不存在「刷新 → 触发变更 → 再刷新」的环。实跑佐证：`smoke-host.mjs:655-665` 的 `changes.count` 每次手动 `emit` 只 +1，注销后不再增长。

**但有一个**漏事件 **的窗口**：`tryUpgrade` 里 `mergeInto` 是在 `onChanged` 订阅**之前**做的（`src/store.mjs:482-493`：先 `mergeInto`、后 `entry.backend.onChanged?.(emit)`）。合并过程中的 `domain/changed` 事件不会被广播，面板要等下一次轮询（≤10s）才看到。低。

---

## C. 测试是否真的抓得住（不是「通过了就算」）

### C1. 逐条回退验证（我重跑了一遍作者的反向验证表）

方法：改回旧写法 → `node tools/verify-all.mjs` → 记录红项 → 立刻恢复并 `shasum` 校验。

| 回退点 | 我的结果 | 与作者声明是否一致 |
| --- | --- | --- |
| F1 `tryUpgrade()` 直接 `return false` | `verify-store.mjs` **5 红** | ✅ 一致 |
| F1 去掉回退文件镜像（`replaceAll`） | `verify-store.mjs` **1 红**（"晚注册→升级并合并"） | ✅ 一致 |
| F2 `put()` 去掉 `protectBeforeWrite` | `verify-store.mjs` **2 红**（坏文件备份 + F3 那条连带） | ✅ 一致 |
| F3 去掉缺 title 的占位标题 | `verify-records.mjs` **1 红** + `verify-store.mjs` **2 红** | ✅ 一致 |
| F5 删掉 `/create` 的 `dueTime` | `smoke-contract.mjs` **1 红** | ✅ 一致 |
| F6 `EDIT_PRIORITY_OPTIONS` 去掉 `none` | `smoke-client.mjs` **1 红** —— **但必须先重建 bundle**（见 R3） | ⚠️ 需附加条件 |
| F7（宿主）摘掉 `store.onChanged` 接线 | `smoke-host.mjs` **1 红** | ✅ 一致 |
| F7（客户端）删掉轮询 effect | `smoke-client.mjs` **1 红** —— **同样必须先重建 bundle** | ⚠️ 需附加条件 |

**F1/F2/F3 各挑一条关键用例，回退后确实变红**（上面表里的前三行就是实跑结论）：

- F1 关键用例：`storageDomain 晚注册：后续请求升级到 domain，并把两处数据按 id 合并`（`tools/verify-store.mjs:215-251`）→ 回退 `tryUpgrade` 变红。
- F2 关键用例：`坏文件 + 一次写入：原文件先被改名备份，新文件只含新记录`（`tools/verify-store.mjs:390-404`）→ 去掉 `protectBeforeWrite` 变红。
- F3 关键用例：`缺 title 的坏记录在下次写入后仍然在文件里`（`tools/verify-store.mjs` 内）→ 去掉占位标题变红。

**没有发现恒真断言/自己骗自己**的用例：`tools/verify-store.mjs:244` 断言的是「备份内容 == 合并前的记录」，是真的读了备份文件；`verify-store.mjs:246-248` 断言镜像 == 并集，也是真读文件。测试质量整体是好的。

### R3（中）客户端改动的"牙齿"依赖于「先 build」——而 `verify-all` 不 build

**位置** `tools/smoke-client.mjs:20`（`readFileSync(join(here, '..', 'lib', 'client.js'))`）、`tools/verify-all.mjs:20-31`（SUITES 里只有测试脚本，**没有 build 步骤**）、`package.json` 的 `prepublishOnly` 才有 `build && verify-all`。

**现象**：`smoke-client.mjs` 读的是**构建产物** `lib/client.js`，不是 `src/client/index.js`。我第一次做回退验证时只改了 `src/`（没 build），F6/F7 两条回退**都是绿的**：

```
=== R6: EDIT_PRIORITY_OPTIONS 去掉 none（只改 src，不 build）===
  ✓ 编辑草稿原样保留 priority:none，且下拉里有「无」这一档（审计 F6）
16 通过，0 失败
=== R8: 删掉轮询 effect（只改 src，不 build）===
  ✓ 面板注册了自动刷新定时器，且卸载时清掉
16 通过，0 失败
```

**build 之后立刻变红**：
```
=== R6b: ... + 重建 bundle ===   ✗ ...（审计 F6）   15 通过，1 失败
=== R8b: ... + 重建 bundle ===   ✗ ...（审计 F7）   15 通过，1 失败
```

**影响**：日常 `npm test` 不会因为「改了 src 忘了 build」而失败 —— 于是「浏览器里跑的其实是旧 bundle」这个最危险的状态**恰好不会被测出来**。本次提交是同步的（我重建后 `lib/client.js` 哈希与提交一致，`git diff` 干净，这条没问题），但流程上是个陷阱。

**最小修复建议**：把 `node tools/build-client.mjs` 加进 `verify-all.mjs` 的**第一步**（或让 `smoke-client.mjs` 在跑之前先比对 `lastList`/bundle 与 src 的一致性并显式报错）。顺带可以加一条「bundle 是 src 的产物」的断言。

---

## D. F8–F16 复核：有没有被低估的？

| 项 | 原文级别 | 我的复核 | 依据 |
| --- | --- | --- | --- |
| F8 `try/catch` 包 hook | 中 | **不算被低估**：`SessionAdopt` 里 `useProjection('todos')` 是**唯一**的 hook 且无条件调用（`src/client/index.js:1033-1040`），组件也只在 `typeof props.useProjection === 'function'` 时才挂载（`src/client/index.js:1388-1392`）。要出「hook 数量变化」得宿主 hook 自己先注册再抛错 —— 本机 DSH checkout 里没有这个 hook 的实现（`grep useProjection` 在核心代码里 0 命中，只有别的插件）。维持「低」合理，但建议按原文用错误边界替掉 `try/catch`。 | 静态推断 |
| F9 `C.bg2` → `background: undefined` | 低 | 维持低（浏览器会丢这条声明，不抛错）。 | 静态 |
| F10 超大请求体 | 低 | 维持低。 | 未复跑 |
| F11 同步 IO / 阻塞事件循环 | 低 | 维持低，但**新增的 10s 轮询放大了它**：每次轮询都会走一遍 `load()`，domain 路径是 `for (const [, value] of table.entries())`（`src/store.mjs:290`）全表复制。待办小的时候无感，文件大了就是每 10 秒一次全量同步读。建议顺手给 `load()` 加内存缓存或改异步。 | 静态推断 |
| F12 Windows rename | 低 | 维持低。 | 未复跑 |
| F13 绝对路径进浏览器 | 低 | 维持低，且**修复没动它**：`lib/index.js:430` 仍然把 `service.describe()`（含绝对 `location`）发给 `/list`、`/health`，面板页脚照旧打印完整路径（`src/client/index.js:1449-1454`）。 | 实跑 |
| F14 更新检查打外网 | 低 | 维持低。 | 未复跑 |
| F15 工具描述/enum | 低 | 维持低。注意 **F6 修好之后**，`worktodo_update` 的 enum 仍缺 `none`（`src/tools.mjs`），所以「agent 把优先级改回无」还是做不到（面板可以了）。建议顺手补 enum。 | 静态推断 |
| F16 `/health` 读失败 `count: 0` | 低 | **维持低，但值得顺手修**：`const all = await service.all().catch(() => [])`（`lib/index.js:423`）在存储读不出来时报 `count: 0`，而 `count` 是面板之外唯一能反映"数据读不出来"的信号；配合 R1/R2 的降级路径，用户/排查者最容易在这里误判「我的待办真的没了」。建议 `count: null` + `error` 字段。 | 静态推断 |

**没有被低估成「严重」的项**：F8 是唯一有白屏形态的，但它当前靠「只有一个 hook + 条件挂载」成立，且核心包未提供该 hook，判「低/中」可以接受。

---

## 顺手发现（不改变放行结论）

- **R5（低）**：`describe()` 的 `mismatch/split/merge/upgrades` 只在 `/list`、`/health` 的 JSON 里（`lib/index.js:430`、`lib/index.js:432`），**面板一个都没渲染**（`grep mismatch\|split src/client/index.js` → 0 命中；页脚只打 `kind` 与 `location`）。审计报告写的「面板/health 里明确报出来」只有 health 那半句成立。真机上那条「两处数据不一致」的 warn 只会进日志。
- **R4（低）**：`ctx.inject` 回调里 `void Promise.resolve().then(() => store.refreshBackend())`（`lib/index.js:179-186`）是 fire-and-forget；inject 回调的注销函数是空函数（`return () => {}`）。如果在升级进行中发生卸载，`close()` 可能在 `domainEntry` 赋值之前跑完 → 那个 `entry.refs` 停在 1、领域句柄泄漏（进程内后续 `open` 会一直撞 already-open）。窗口很窄，实跑只在「卸载后立刻重载」里看到症状（R2），没单独复现泄漏。
- **观察（非本轮引入）**：`repairRecord` 是白名单字段重建（`src/schema.mjs` 的 `repairRecord`），手改文件里的未知字段（如 `tags`/`done`/自定义中文键）会在**任何一次写回**（含合并）时被抹掉。实跑（exp9）确认：`load` 出来的记录已只剩规范字段，写回后文件里 `tags`/`done` 全没了。旧版本也是这个行为，但合并会把它应用到**官方 storage** 侧，值得单列一条。
- **观察（好）**：`detectSplit` 的文件格式假设是**对的** —— 真机 `~/.dsh/storages/worktodo.json` 的顶层键是 `unit/global/tables`，`readStoredIds` 读的 `doc.tables.todos`（`src/store.mjs:403`）命中；构造分裂场景后 `describe().split` 与 warn 都正确出现（exp11），两条 id 集合的对比数也对。
- **真机现状核对（只统计条数/id 集合，不看内容）**：`~/.dsh/storages/worktodo.json` 与 `~/.dsh/worktodo/todos.json` 现均为 **10 条且 id 集合一致**，说明本轮离线合并是成功的；`~/.dsh/storages/worktodo.json.bak-20261013-193439` 是 19:34:39 那次镜像/合并留下的备份。**但按 R1，这份一致性只在「此后再没人在 domain 侧删除过记录」的前提下成立** —— 真机 19:34:51 还有一次 domain 写入，请优先按 R1 的修法处理，并核对两处 id 集合是否仍然一致。

---

## 放行建议

1. **必须先修 R1**（回退文件快照导致删除复活）——这是唯一一条会让用户"删掉的待办自己回来"的数据完整性缺陷，且是真机正在运行的路径。建议采用「迁移后把回退文件停用/删除」的方案 A。
2. **建议同批修 R2**（卸载后立刻重载撞 already-open → 降级读空），至少让 `close()` 可 await + `releaseDomain` 先关后删。
3. **建议补 R3**（`verify-all` 加 build）——否则客户端修复的回归防线形同虚设。
4. R4/R5、F11/F13/F15/F16 可以排到 0.2.2；F8 建议顺手换成错误边界。

在 R1 修好之前，本修复**不建议视为完成**；除此之外的 F2/F3/F5/F6/F7 修复我认为是**正确且可接受的**。

---

# 修复状态（R1–R4）

**修复者说明**：本节的改动全部在 `9246dd3` 之上、**未提交**（按约定不 commit / 不 push、不动 `.github/`、版本号与 CHANGELOG 版本段落）。
仓库根 = `~/Documents/deepseek-harness/default-workspace/dsh-worktodo`，下文用仓库内相对路径。

- 全量测试：`WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs` → **10/10 步通过（含新增的构建步）、9 个测试文件 0 失败，exit 0**。
- 新增用例 **9 条**，全部加进现有文件（测试文件总数仍是 **9** 个）：`tools/verify-store.mjs` +2、`tools/smoke-host.mjs` +2、`tools/smoke-client.mjs` +5。
- 反向验证方法与上一轮一致：逐点把修复改回旧写法 → 跑对应套件 → 记录红项 → 立刻恢复并用 `shasum -c` 校验。**所有回退点都变红了**（明细见每条的「反向验证」表）。
- 没有触碰真实数据文件：本轮所有实验都在临时 `DSH_HOME`（`mkdtemp`）或 `/tmp` 里跑；真机 `~/.dsh/storages/worktodo.json`、`~/.dsh/worktodo/todos.json` 只有只读核对（见文末），**没有**产生新的 `.bak-` / `.migrated-` / `.corrupt-`。因此本次也不需要给真实文件做备份。

## R1（高）升级后退役回退文件 —— 采用「方案 A：退役」

**修法**（`src/store.mjs`）：

1. `mergeInto()` 仍然把并集写回回退文件，但目的变了：留下的是一份**完整的迁移存档**（用户随时能查/能恢复），而不是用来当镜像。
2. 新增 `retireFallbackFile()`：升级合并成功后立刻把回退文件**退役** ——
   - 先备份：复用 `mergeInto` 刚做好的那份「合并前原样」的 `<path>.bak-<时间>`（避免同秒再复制一份把它盖掉），拿不到才现做；
   - 再 `renameSync()` 成 `<path>.migrated-<时间>`（同秒冲突自动让到 `-1`/`-2`）；
   - 句柄里记下 `state.retired`，`describe().retired` 报出 `{path, movedTo, backup, note: '已把回退文件迁移并退役，路径=…'}`。
3. 退役后 domain 是**唯一真源**：同句柄里 `current.kind === 'domain'` 让 `tryUpgrade()` 直接返回；重载/重开的新句柄看到原路径不存在，只在 `describe().retired.alreadyRetired = true` 里做信息性报告，**不会**再把那个文件当 source 或镜像 —— 复活与「镜像永久落后」两个问题一起消失。
4. 退役失败（目录权限等）只告警 + 写进 `describe()`：domain 里的数据是安全的，但明确提示「请手动改名/删除该文件，否则下一次合并可能把已删项补回来」。
5. **绝不静默换源**：`load/put/remove` 统一走新的 `currentOp()`，当前后端出错时只记 `describe().backendError` + 打 `⚠️` 日志，然后**原样抛出**；`current` 不动，也不会回头去读那个已退役的文件。
6. 顺手实跑发现的次级 bug：`backupFile()` 原来同秒内第二次备份会覆盖第一次 —— 退役时的备份正好会盖掉「合并前」那份。已改为用 `uniqueSibling()` 避让。

**覆盖测试**（`tools/verify-store.mjs`）：

- 更新「storageDomain 晚注册 → 升级并合并」：断言 `.migrated-` 存在、原路径消失、`describe().retired.note` 有「已把回退文件迁移并退役」、`.migrated-` 里是合并后的完整存档。
- 新增「升级后删掉一条再重开（第二次合并）不会复活，新增的也不会重复」：升级 → 删 `wt-c` → 加 `wt-d` → close/重开 → 断言 `wt-c` 不复活、`wt-d` 不重复；再 `wt-e` → 第三次重开仍不重复。**这就是复审 exp8 的回归用例**。
- 新增「升级后 domain 读失败：显式报错并保持 domain 句柄，绝不静默读回退役的回退文件」。
- 假 facility 增加 `control.failLoad` 开关来模拟「domain 突然读不出来」。

**反向验证（实跑）**：

| 回退点 | 结果 |
| --- | --- |
| 摘掉 `retireFallbackFile()` 调用（保留旧的快照镜像） | `verify-store.mjs` **3 红**：晚注册合并、删一条重开、domain 读失败 |
| 同上，并临时删掉「回退文件必须退役」这条早期断言以便走到后面 | **`已删除的待办不能复活：期望 false，实际 true`** —— 与复审 exp8 的 `true` 完全一致 |
| 把 `currentOp()` 的 try/catch 换回 `return run(current)` | `verify-store.mjs` **1 红**（`backendError` 那条） |

**结论：被删项不再复活 = 已实跑验证**（正向用例 + 反向变红两侧都有）。

## R2（中）卸载后立刻重载撞 `already-open`

**修法**：

- `lib/index.js`：`ctx.effect` 的生命周期清理**返回** `store.close()` 的 promise（cordis 会 await 它），不再 fire-and-forget。
- `src/store.mjs` `releaseDomain()`：改成 **先 `await backend.close()`、在 `finally` 里再摘注册表**；并发 close 复用同一个 `entry.closing`；关闭失败也摘（否则坏句柄永远挡住后续挂载）并记一条日志。
- `src/store.mjs` `acquireDomain()`：遇到 `entry.closing` 先等它落地，再决定「复用」还是「从零重开」，绝不复用半关闭的句柄。
- `store.close()`：加 `closed` 标志（关闭后 `tryUpgrade/refreshBackend` 直接不做事），并 `await upgrading`，堵住复审 R4 那条「升级飞行中卸载 → 领域句柄泄漏」。

**覆盖测试**（`tools/smoke-host.mjs`）：新增「卸载后立刻重载：清理可 await，新句柄仍是 domain（不撞 already-open 降级到 file）」。假 facility 的 `close()` 现在真的异步（5ms 宏任务）—— 官方领域关闭本来就是异步的，不模拟这个窗口，这类竞态在测试里根本不存在。

**反向验证（实跑）**：

| 回退点 | 结果 |
| --- | --- |
| 只回退 `lib/index.js`（清理函数不返回 promise） | 1 红：`清理函数必须返回可 await 的 promise（不能在飞行中返回）` |
| 只回退 `releaseDomain` 顺序 + 去掉 closing 哨兵（`lib/index.js` 保持修复） | 1 红：**`立刻重载也必须仍然是 domain（不能停在 file 后端）：期望 "domain"，实际 "file"`** —— 与复审 exp4 的 `D.kind = file` 一致 |

## R3（中）verify-all 不 build → 客户端改动假绿

**修法**：

- `tools/verify-all.mjs` 的**第一步**执行 `node tools/build-client.mjs`；构建失败直接判整体失败（汇总里多一行「客户端 bundle 构建」，尾行改为「N/N 个步骤通过（含构建）」）。
- 额外在 `tools/smoke-client.mjs` 加一条独立断言「bundle 是这个 src/client 的产物」：读 `lib/client.js.map` 的 `sourcesContent`，与磁盘上的 `src/client/index.js`、`src/parse-due.mjs` **逐字**比较。这样即使有人绕过 `verify-all` 直接跑 `node tools/smoke-client.mjs`，陈旧 bundle 也会立刻红。

**反向验证（实跑）**：

| 场景 | 结果 |
| --- | --- |
| 完全回退（去掉 build 步 + 去掉新鲜度断言），只改 `src/client/index.js`（去掉 `EDIT_PRIORITY_OPTIONS` 的 `none`）且不 build | `verify-all.mjs` **9/9 全绿** —— 复现复审 R6/R8 的假绿 |
| 修复在位，同样只改 src 且不 build | **红**：`✗ 编辑草稿原样保留 priority:none，且下拉里有「无」这一档（审计 F6）`（verify-all 先 build，再被 smoke-client 抓到） |
| 只去掉 build 步（保留新鲜度断言），同样只改 src 且不 build | **红**：`✗ bundle 是这个 src/client 的产物（改了 src 忘了 build 必须红，复审 R3）` |

## R4 / 收尾

**修法**：

- `src/service.mjs`：`/list` 载荷里的 `store` 从 `{kind, location}` 换成**完整的 `describe()`**。这是复审没点到但必须一起修的一环：**面板只能看到 `/list` 载荷**，诊断字段以前根本到不了浏览器，光加渲染也没用（原来的「面板 grep 0 命中」有一半是断在这里）。
- `src/client/index.js`：
  - 新增 `storeAlerts(store, t)`，页脚真的渲染 `mismatch / split / backendError`（警告色）与 `retired / merge`（信息色）五行，并给它们 `wt-store-alert-*` class；zh/en 文案都补齐（`storeMismatch / storeSplit / storeError / storeRetired / storeMergeNote`，合并报告用 `{merged}/{conflicts}/{added}` 插值，不会把占位符原样显示给用户）。
  - 轮询 `10s → 30s`（`export const CHANGE_POLL_MS = 30000`）：每次轮询都是一次全量 `load()`，30 秒一次 + `focus` 立刻刷新是复审建议的折中；`visibilitychange` 顺手改成只在**变成可见**时刷新（原来隐藏时也白打一次宿主）。
- `lib/index.js`：`/health` 读失败从 `count: 0` 改成 **`count: null` + `countError`**（审计 F16 / 复审 R7）；`: null` 表示「读不出来」，`0` 才是「空列表」。

**覆盖测试**：

- `tools/smoke-client.mjs`（+5）：`storeAlerts` 五条告警齐全 + 合并报告占位符替换；**真渲染一次带告警的面板**并按 `className` 找到告警节点（不只是「有个函数」）；`focus` / `visibilitychange` 会触发刷新；清理时定时器 + 窗口/文档监听都移除；以及 R3 的 bundle 新鲜度断言。另把 F7 那条钉到 `CHANGE_POLL_MS === 30000`。
- `tools/smoke-host.mjs`（+2）：`/health` 读失败 → `count: null` + `countError`、`describe().backendError` 有内容、后端不换、恢复后清零；并断言 `/list` 的 `store` 带 `mismatch/split/merge/retired/backendError` 全部字段。

**反向验证（实跑）**：

| 回退点 | 结果 |
| --- | --- |
| 去掉页脚告警渲染（只留 `storeAlerts`） | `smoke-client.mjs` 1 红：`mismatch 与 split 必须各渲染一行告警：0期望 2，实际 0` |
| `CHANGE_POLL_MS` 改回 `10000` | `smoke-client.mjs` 1 红：`轮询间隔必须放宽到 30 秒：期望 30000，实际 10000` |
| `/health` 改回 `.catch(() => [])` | `smoke-host.mjs` 1 红：`读不出来时必须 count:null —— 报 0 会让人以为待办真的没了：期望 null，实际 0` |
| `/list` 的 `store` 改回 `{kind, location}` | `smoke-host.mjs` 1 红：`/list 的 store 必须带 mismatch（面板页脚要渲染这些告警）` |

## 没能修 / 不确定

- **F13（绝对路径进浏览器）没动**：`describe().location`、`retired.movedTo`、`merge.backups` 仍是绝对路径，这次为了「数据在哪 / 搬到哪了」还多显示了一处路径。是否脱敏属于产品取舍，留给 0.2.2。
- **F8（`try/catch` 包 hook）维持低**：按复审意见没换成错误边界。
- **退役不是 100% 有保证的**：目录权限/文件被占用导致 `renameSync` 失败时，只能告警 + `describe().retired.error`，此时下一次合并**仍可能**复活已删项（日志与面板都会明说「请手动处理」）。没有做「墓碑 + 每次写入同步镜像」的备选方案，因此也不存在「并发下重复插入」的问题。
- **`writeDroppedBackup` 同秒覆盖**（复审 B3 的低项）没单独特修；只修了会破坏「合并前备份」的 `backupFile`。
- **F11（同步 IO / 全量 load）只做了一半**：轮询放宽到 30s + 聚焦刷新，`load()` 本身没加内存缓存。
- **真机现状（只读核对，未改动任何文件）**：`~/.dsh/storages/worktodo.json` 与 `~/.dsh/worktodo/todos.json` 均 **10 条、id 集合一致**。本修复落地后第一次成功升级会把后者退役成 `~/.dsh/worktodo/todos.json.migrated-<时间>`，并保留 `~/.dsh/worktodo/todos.json.bak-<时间>` —— 两份都留着，可人工恢复。
- 未做（按约定）：git commit / push、`.github/`、版本号、CHANGELOG 版本段落。
