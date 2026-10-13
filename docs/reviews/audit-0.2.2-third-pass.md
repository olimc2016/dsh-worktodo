# 第三轮独立审查：0.2.2「修复的修复」（commit `9c02f53`）

**一句话结论：不能直接放行。** R1 的「退役」主路径是对的（实跑确认：先把并集写进 domain、确认写成功后，才 rename；写失败时回退文件一条不少、界面照常可读），R2/R3/R4 也基本成立；但**退役把「唯一一份本地数据」从默认路径搬走**，于是有三条必须修的路径：

1. **F1（高）**：退役之后只要 `storageDomain` 不在这套组合里（或 open 失败），面板就是**空列表 + 零告警** —— 用户会以为待办没了；而**用户真机上这个前提已经成立**（`~/.dsh/worktodo/todos.json` 已在 22:06 被退役）。
2. **F2（中）**：合并**中途**失败会在 domain 留下半截数据；并集没有墓碑，用户随后删掉的那条会在下一次合并**复活**（R1 的同类 bug 换了入口）。
3. **F3（中）**：退役 rename 失败时只有一行日志，**面板反而显示「回退文件已迁移并退役」**（假信息），而那个文件仍然是合并源 —— 已删项照样复活。

---

## 审查范围与方法

- 静态：`git show 9c02f53` 全量 diff + 当前工作区；官方 `@deepseek-ai/dsh-storage-domain`（`lib/index.js:94-208`，写链「先落盘、后改内存」）、`@deepseek-ai/dsh-storage`、`@deepseek-ai/cordis`（`lib/index.js:963-966 / 1229-1238 / 1372-1392`）的实现都读了。
- 实跑：仓库全量 `node tools/verify-all.mjs` **10/10 绿**（构建产物 rebuild 后 shasum 与提交版**逐字节一致**）；另在 `/tmp` 临时副本里做了 8 组注入实验（含真 cordis、真文件 IO、只读目录、EISDIR、故障注入的假 facility）。**未改动仓库源码**（临时副本里回退验证后已核对 `cmp` 与 shasum；仓库 `git status` 干净，只有本报告是新文件）。
- 用户真实数据**只读**检查：`~/.dsh/worktodo/todos.json.migrated-20261013-220627` 与 `~/.dsh/storages/worktodo.json`、`~/.dsh/worktodo/todos.json.bak-20261013-220626` 三份都是 **10 条、id 与 title 完全一致** —— 22:06 那次真实迁移没有丢数据；同时 **`~/.dsh/worktodo/todos.json` 已经不存在**（已退役），F1 的前提在真机上已经生效。

---

## 发现

### F1（高）退役之后 domain 不可用 → 面板空列表、`describe()` 三条告警全空、`storeAlerts()` 一行都不显示

- 位置：`src/store.mjs:592-596`（服务不在组合里 → `state.mismatch = null`）、`src/store.mjs:737`（`detectSplit` 在本地列表为空时**直接 return**）、`src/store.mjs:529-549`（「已退役」只在**升级/合并成功之后**才被识别）、`src/client/index.js:1110-1133`（`storeAlerts`）。
- 现象：升级 + 退役成功后，如果新进程里 `ctx.get('storageDomain')` 是 `undefined`（插件自己在文件头写明「storage 在某些精简组合里可能没挂载」是**设计内**场景），则：
  - `store.load()` → `[]`：面板显示「还没有待办」；
  - `describe()` = `{mismatch:null, split:null, retired:null, backendError:null, merge:null}`；
  - `storeAlerts(...)` = `[]` → 面板页脚只有一行「存储位置 · JSON 文件 · `~/.dsh/worktodo/todos.json`」（**一个不存在的路径**），没有任何警告；
  - 连 `storages/worktodo.json` 里有数据这件事也不会被报出来（`detectSplit` 因为 `localIds.size === 0` 早退）。
- 证据（实跑，`/tmp` 临时 home）：
  ```
  === 3.1 storageDomain 服务不在组合里 ===
  kind = file  location = .../worktodo/todos.json
  load() = []
  describe() = {"mismatch":null,"split":null,"retired":null,"backendError":null,"merge":null}
  面板告警行 = []
  ```
  对照真机：`~/.dsh/worktodo/todos.json` 已退役，数据只在 `~/.dsh/storages/worktodo.json`（10 条）。也就是说**只要换一个没挂 storage 的组合启动，用户就会看到一个空的待办面板，且没有任何提示**。
- 最小修复：
  1. `detectSplit()` 里把「本地为空」和「本地读不出来」分开：本地列表为空**但**官方 storage 文件里有 id 时，明确置 `state.split`（例如「回退文件已退役/为空，官方 storage 里有 N 条；当前后端是 JSON 文件，本次列表为空」），也要在 `state.mismatch` 里说清「不是在使用那个文件」；
  2. 让「退役」这个事实可以不依赖成功合并就被发现：在 rename **之前**先落一个哨兵文件 `<path>.retired`（内容记 `movedTo`/时间），`init()` 见到哨兵就知道「我的回退源已退役」，据此报 warn；
  3. 面板侧给这个状态一个 warn 行（复用 `storeAlerts`，新增一个 key）。

### F2（中）合并中途失败留下的 domain 半截数据 + 无墓碑并集 → 用户删掉的待办复活

- 位置：`src/store.mjs:690`（`for (const record of todos) await target.put(record)`，逐条写、失败不回滚）、`src/store.mjs:611-616`（失败后只是 release + 记 mismatch，domain 里已写入的部分**保留**）。
- 现象：`file=[A,B,C]`、`domain=[]`，合并时 put A 成功、put B 失败 → 回到 file 后端（domain 里留下 A）→ 用户在「当前后端＝文件」上删掉 A → domain 恢复后下一次合并是**并集** → A 复活。
- 证据（实跑）：
  ```
  第一阶段：kind=file  domain 里有 wt-a  回退文件里 wt-a,wt-b,wt-c
  第二阶段：remove('wt-a') → 回退文件 wt-b,wt-c；domain 里仍有 wt-a
  第三阶段：合并后 id = ["wt-a","wt-b","wt-c"]   ← 已删除的 wt-a 复活
  ```
  触发条件是一次**部分失败**的 domain 写（磁盘满、写链被 close/dispose 打断等都算）；这与 R1 的根因（并集无墓碑）同源，退役只堵住了「文件这一侧」，没堵住「domain 这一侧」。
- 最小修复：合并前先 `todos.map(repairRecord)` 全量校验（把「schema 拒绝」这类确定性失败挡在写之前）；写循环记录本次**新增**的 key，失败时把这些 key 尽力删掉（回滚），保证失败合并对目标端是「全有或全无」。

### F3（中）退役 rename 失败只在日志里；面板把它显示成「已迁移并退役」；文件仍是合并源 → 已删项复活

- 位置：`src/store.mjs:568-579`（失败只 `state.retired.error` + `logger.warn`）、`src/store.mjs:624-627`（失败也照样 `adopt(domain)`，不回退）、`src/client/index.js:1118-1119`（`store.retired?.movedTo ?? store.retired?.path` 一律当成功信息渲染）。
- 现象与证据（两条真实注入 + 源码注入，都实跑）：
  - 只读目录（备份/镜像/rename 都失败）：`kind=domain`，`retired.error=EACCES…`、`movedTo=null`，回退文件仍在 `wt-a,wt-b`；在 domain 删掉 `wt-a` 后**重开 → `["wt-a","wt-b","wt-dom-d"]`：已删除的 wt-a 复活**。
  - 只让 rename 失败（临时副本注入 EPERM，备份+镜像都成功）：同样 `["wt-a","wt-b","wt-dom-d"]` 复活。
  - 面板文案：`storeAlerts({retired:{path:'/tmp/todos.json',movedTo:null,error:'EPERM…'}})` → `info: storeRetired：/tmp/todos.json` —— **说「已迁移并退役」，且把错误原因丢了**。
- 最小修复：
  1. `storeAlerts` 按 `retired.error` 分支：warn 级 + 原文错误 + 「文件仍在 `<path>`，请手动改名或删除」；只有 `movedTo` 存在时才说「已退役」；
  2. 更根本的是 F1 建议里的哨兵：rename 前先写 `<path>.retired`，下次启动即使 rename 一直失败也不会再把那个文件当 source（消掉复活链），rename 可以顺带重试。

### F4（中低）open 失败时的 mismatch 文案把「已退役、不存在的文件」说成当前数据源

- 位置：`src/store.mjs:604`（`…当前仍在使用 JSON 文件 ${ownedFile?.location ?? '?'}`）。
- 现象与证据（实跑 3.2）：domain 服务在但 open 抛错 → `kind=file`、`load()=[]`、`mismatch="…当前仍在使用 JSON 文件 …/worktodo/todos.json"`，而那个文件**已被退役、不存在**。用户看到的组合是「空列表 + 一条指向不存在文件的警告」，排查会被带偏。
- 最小修复：拼这条消息时先 `existsSync(ownedFile.location)`（或看 `state.retired`）；不存在就写「回退文件已退役且为空，本次列表为空；官方 storage 里仍有 N 条（tryUpgrade/open 失败原因：…）」。

### F5（低）`verify-all` 新增的 build 步骤依赖 cwd（R3 引入的新回归）

- 位置：`tools/verify-all.mjs:39`（`spawnSync(process.execPath, [join(here,'build-client.mjs')], { stdio:'inherit' })` 没有 `cwd`）、`tools/build-client.mjs:40-41`（`entryPoints: ['src/client/index.js']`、`outfile: 'lib/client.js'` 都是相对 cwd）。
- 证据（实跑）：在空目录里 `node /tmp/…/repo/tools/build-client.mjs` → `exit=1`，`✘ [ERROR] Could not resolve "src/client/index.js"`，且**没有**在空目录里留下任何垃圾文件。改这个提交之前，`verify-all` 从任意 cwd 都能跑（各 suite 都用 `import.meta.url` 锚定路径），现在会误报构建失败。
- 最小修复：`spawnSync(..., { cwd: join(here, '..'), stdio: 'inherit' })`；或让 `build-client.mjs` 用 `new URL('../src/client/index.js', import.meta.url)` / `fileURLToPath` 锚定入口与输出。

### F6（低）「bundle 是 src 的产物」只覆盖两个写死的文件

- 位置：`tools/smoke-client.mjs:268`（`const names = ['src/client/index.js','src/parse-due.mjs']`）。
- 证据（实跑）：在临时副本里加一个 `src/client/helper.js` 并从 `index.js` 引用（`map.sources` 里确实出现 `../src/client/helper.js`），build 一次后**只改 helper.js 不重新 build**，直接跑 `smoke-client` → **21 通过 0 失败（绿）**，浏览器里跑的却是旧 bundle。（今天只有两个客户端源文件，所以还不是活 bug，是「以后加文件就漏」的坑。）
- 最小修复：遍历 `map.sources` 里所有以 `/src/` 结尾（或 `../src/` 开头）的条目逐一比对，而不是写死列表。

### F7（低）构建产物是非原子写；失败时旧包保留（已确认当前无害）

- 位置：`tools/build-client.mjs:51-59`（esbuild `outfile` 直接写 `lib/client.js`，没有 tmp+rename）。
- 证据（实跑）：源码注入语法错误 → `build exit=1`，`lib/client.js` **shasum 与内容完全没变**（esbuild 编译失败不落盘）；此时直接跑 `smoke-client` → `exit=1`（`sourcesContent` 断言抓住「改了 src 没 build」）；删掉 `lib/client.js.map` → 也是 `exit=1`。也就是说 verify-all 是 fail-closed（构建失败即整体红），**唯一的残余风险**是「写盘阶段中途失败（ENOSPC/被杀）」会留下截断的 bundle；有 `sourcesContent` 断言兜底。
- 最小修复（可选）：build 到临时文件再 rename；或在 build 前后校验产物 JSON/长度。

### F8（低）退役**成功**之后发生在 try 里的异常会被误报成「退役失败」

- 位置：`src/store.mjs:556-579` —— 成功分支的 `state.retired = {…}` 与 `logger?.info?.(…)`（566-567）和 `renameSync` 在**同一个 try** 里，`catch` 的文案是「退役失败…仍然存在」。
- 证据（实跑注入）：让 `logger.info` 在「迁移并退役」这句抛错 → 文件**已经**被 rename 成功（原路径不存在、目录里有 `todos.json.migrated-…`），但
  `describe().retired = {movedTo:null, error:'logger.info 抛错（注入）', note:'回退文件退役失败…：<path> 仍然存在'}`，`merge.fallbackRetiredTo=null` —— 面板/health 反过来告诉用户「文件还在，请手动处理」。
- 最小修复：把 `renameSync` 单独包一层 try（只捕获 rename 失败），成功分支的记账与日志放到这个 try 之外。

### F9（低）每次合并失败都新复制一份 `.bak-`（无上限），配合 30s 轮询会持续堆积

- 位置：`src/store.mjs:680-687`（备份在 `mergeInto` 开头，**任何**一次尝试都做）、`src/store.mjs:35-36,597`（失败重试节流 5s）。
- 证据（实跑）：domain 永远写不进去（`put` 必失败）时，初始化 1 份 `.bak-`，之后每次跨过 5s 节流的重试都 +1 份：`1 → 2 → 3 → 4`，`put` 尝试次数同步递增。面板开着时轮询 30s 一次 → 持续失败即**每 30s 新增一份约 7KB 的备份**，直到手动清理。
- 最小修复：备份前先比较（大小 + mtime，或内容 hash）与「上一次备份」是否一致，一致就复用；或对 `.bak-` 做轮转上限（保留最近 N 份）。

### F10（低 / 说明）R2 的测试只钉住「清理返回 promise」，没有钉住它声称的行为后果

- 位置：`tools/smoke-host.mjs`（`卸载后立刻重载…` 用例）、`lib/index.js:172-174`。
- 证据（实跑，两件事）：
  1. 把 `lib/index.js` 回退成 fire-and-forget（删除返回值）→ `smoke-host` 变成 1 条失败，失败断言是**「清理函数必须返回可 await 的 promise」**（结构断言），不是行为断言；
  2. 在临时副本里 **同时**回退 close 顺序**并**停掉那条结构断言 → `smoke-host` **35 通过 0 失败**（「立刻重载仍是 domain / 不撞 already-open / 不丢数据」全绿）。即：这套 harness 复现不出 R2 描述的降级，行为断言对修复与否不敏感。
  - 另外我用**真 cordis**（仓库里的 4.0.4）跑了 3 组场景（顺序 apply→dispose ×3、dispose 不 await 就重挂 ×3、连续 5 轮不等 dispose 的重载）+ 41 个微任务偏移采样，修复前后都是 `alreadyOpen=0`、open/close 平衡 —— 复现不出降级，因为 store 自己的 `entry.closing` 等待 + 引用计数已经兜住了绝大多数交错。
- 结论与建议：R2 的改动**方向正确且应该保留**（我确认 cordis `finalizeDisposal` 会把 disposer 的 promise 记为 inFlight，`_unload` 通过 `runDisposable` await 它，所以「返回 promise」确实让卸载等到 close 落地）；但要把测试的定位说清楚（结构守卫），或者用一个真能制造窗口的 harness（例如让 `table.put` 在卸载期间拒绝）来钉住行为。

### F11（说明 / 静态推断，未复现）`acquireDomain` 的 closing 检查与 `refs++` 之间有 1 个微任务的窗口

- 位置：`src/store.mjs:357-383`：`if (entry?.closing)` 判断之后是 `await entry.promise`（resolved 但仍让出 1 个微任务），随后才 `entry.refs += 1`。若 releaseDomain 恰好在这个微任务里把 refs 减到 0 并开始 close，新实例会拿着「正在关闭」的领域句柄。
- 我做了 41 个微任务偏移的采样（`exp4` 第 4 组）**没有复现**（B 走到检查点要经过 `resolveDshHome` 的若干 await，通常晚于 releaseDomain，所以总能看见 `closing`）。按静态推断列出，作为可选加固：把 `refs += 1` 提到 `await entry.promise` **之前**，或在 `await` 之后重新检查 `entry.closing` 并重试。

### F12（nit）

- `src/store.mjs:116-122`（`uniqueSibling`）与 `97-109`（`quarantineFile`）都是 check-then-act：两个进程可能选到同一个目标名，`renameSync`/`copyFileSync` 会**静默覆盖**已有存档。概率极低。顺带说：本次把 `backupFile` 改成走 `uniqueSibling` 是对的（修掉了「同秒第二次备份盖掉第一次」）。
- `src/store.mjs:689-690`：源为空（文件不存在/已退役）时仍会把并集**逐条重写**进 domain；每次启动都对全表做一遍无意义写。建议 `if (!sourceRecords.length) skip`。
- `src/store.mjs:658-668`：`currentOp` 的 `await refreshBackend()` 在 `try` **之外**，`retireFallbackFile` 之后的任何异常（见 F8）不会被记进 `state.backendError`，而是直接冒给调用方；`init()` 里 `await tryUpgrade({force:true})` 也没有兜底，所以「首次升级时抛异常」会让 `openWorkTodoStore` reject → `apply()` 挂载失败（工具与路由全无）。建议把 upgrade 包在 try 里，失败降级为 `mismatch`/`backendError` 而不是让整个插件挂不上。
- 退役档案 `.migrated-*` 在路径不存在、也没有任何 `.migrated-*` 兄弟时不会被报告（`state.retired` 保持 `null`）：用户手工删过那个文件的话，面板不会提「这里曾经搬走过一个文件」。可接受，但配合 F1 的哨兵会更好。

---

## 修得对的地方（都有实跑证据）

| 主张 | 结论 | 证据 |
| --- | --- | --- |
| 退役顺序：读回退文件 → 合并写 domain → 写成功 → 才 rename | **成立** | 日志顺序（合并 → 退役）、`domain.put ≥ 1`；`@deepseek-ai/dsh-storage-domain` 的 `put` = `enqueue(async () => await unit.putRecord(...))`，注释明确「awaits backend durability FIRST」 |
| domain 写入失败时不会丢数据 | **成立** | 注入第 2 次 put 失败：`kind=file`、回退文件 3 条原样、无 `.migrated-`、`.bak-` 在、`load()` 返回 3 条、`mismatch` 明说「合并两处数据失败」；等 5.1s 重试后 file→domain 合并出 4 条（A/B/C + domain 独有的 D），**一条不丢** |
| 失败时 domain 句柄不泄漏 | **成立** | 合并失败后 `facility.calls = {open:1, close:1, put:2}`、`isOpen=false` |
| 跨设备/跨卷 rename 风险 | **不成立**（无此风险） | retire 目标 `uniqueSibling('<path>.migrated-<stamp>')` 是**同目录兄弟**；全链路只有单个 `renameSync`，没有「先 remove 再 write」；文件写入是 `writeAtomic`（tmp + rename） |
| 幂等：第二次启动时只有 `.migrated-*` | **成立** | 仓库用例绿 + 我这边 3 轮重载：`alreadyRetired=true`、不生成新的 `.migrated-`、数据不变；`open/close` 每轮各一次 |
| domain 读失败不会静默换源 | **成立** | `service.list()` → `{ok:false, reason:'store-unreadable'}`；面板走 `failed` 全屏或错误条（`src/client/index.js:1299-1310 / 1398-1420`），不是空列表 |
| R2：cordis 真的会 await 清理 | **成立**（静态读实现 + 真 cordis 实跑） | `cordis/lib/index.js:1229-1238`（thenable 记 `inFlight`）、`963-966`（`runDisposable` 返回 inFlight）、`1372-1383`（`_unload` await）；真 cordis 3 组场景 `alreadyOpen=0`、open/close 平衡、结束后领域关闭 |
| R3：先 build + 产物一致性断言 | **有牙齿**（对「改了 src 忘了 build」有效） | 语法错误 build → 旧包逐字节不变 → 直接跑 smoke-client **红**（`sourcesContent` 不一致）；删 sourcemap → **红**；verify-all 构建失败即整体 `exit 1` |
| R4：面板告警的 DOM 注入面 | **安全** | 全文件无 `innerHTML/dangerouslySetInnerHTML/insertAdjacentHTML/outerHTML`；告警用 `React.createElement` 文本子节点，`className` 只由固定的 `'warn'|'info'` 拼 |
| R4：30s 轮询卸载后停止 | **成立** | `clearInterval` + `focus`/`visibilitychange` 的 `removeEventListener` 都在同一个 effect 的清理里（`src/client/index.js:1147-1159`）；`document` 在注册前已判空，handler 里读 `document.visibilityState` 不会在无 `document` 环境抛错；smoke-client 的清理断言是对**所有**已注册 handle 的全称断言，去掉 `clearInterval` 会红（非恒真） |
| 真机数据在 22:06 的迁移 | **没丢** | 只读比对：domain/`.migrated-`/合并前 `.bak-` 三份都是 10 条，id 与 title 完全一致 |

## 建议补的测试（对应上面的缺口）

1. **退役 + domain 服务缺失**：断言 `describe()` 必须报出「回退源已退役/官方 storage 里有 N 条」，`load()` 为空时不得静默（F1）。
2. **合并中途失败后再删一条再合并**：断言不复活（F2）。
3. **rename 失败**（`WT_FAULT`/预置目录名冲突/只读目录）：断言面板文案是 warn + 含错误原因，且下一次合并不复活（F3/F4）。
4. `storeAlerts` 增补 `retired:{path, movedTo:null, error}` 这一形状（现在只测了成功形状与「只有 path」的形状）。
5. `verify-all` 从仓库外 cwd 调用（F5）；`map.sources` 全量比对（F6）。

## 复现命令（都在 `/tmp` 临时树里，`DSH_HOME` 指向临时目录）

```
# 全量基线（构建产物 rebuild 后与提交版逐字节一致，10/10 绿）
WORKTODO_NO_UPDATE_CHECK=1 DSH_HOME=/tmp/wt-review/home-guard node tools/verify-all.mjs

# A1 顺序 / domain 写失败注入            → /tmp/wt-review/exp/exp1-a1-domain-write-fail.mjs
# A1 附带：半截合并导致复活              → /tmp/wt-review/exp/exp1b-partial-merge-resurrect.mjs
# A2 退役 rename 失败（只读目录 / EPERM 注入）→ /tmp/wt-review/exp/exp2-a2-retire-failure.mjs
# A4/A5 退役后 domain 不可用的可见性      → /tmp/wt-review/exp/exp3-a4-a5-downgrade-diagnostics.mjs
# B1 微任务采样（store 层）               → /tmp/wt-review/exp/exp4-b1-r2-concurrency.mjs
# B1 真 cordis apply/dispose 多轮         → /tmp/wt-review/exp/exp5-b1-cordis-rounds.mjs
# C 新增代码的异常路径 / 备份堆积          → /tmp/wt-review/exp/exp6-c-new-issues.mjs
# 回退验证：去掉退役调用 → verify-store 3 条红；close 改回 fire-and-forget → smoke-host 1 条红
```

---

# 修复状态（F1–F3 + 顺手项）

**修复范围**：`src/store.mjs`、`src/client/index.js`、`lib/index.js`（宿主兜底）、`tools/verify-store.mjs`、`tools/smoke-client.mjs`、`tools/verify-all.mjs`、`README.md`/`README.en.md`（补一段退役行为说明）；构建产物 `lib/client.js(.map)` 已随之重建。
**未做**：未 commit/push，未改 `.github/`、版本号、CHANGELOG 版本段落；测试文件仍是 **9 个**（没有新增文件）；**未触碰** `~/.dsh/worktodo/todos.json*` 与 `~/.dsh/storages/worktodo.json`（全部实验在 `/tmp` 或临时 `DSH_HOME`）。

## F1（高）退役后 domain 不可用 → 空列表且零告警 —— 已修

**修法**（`src/store.mjs`）：

1. **退役事实持久化 + 启动即识别**：新增退役哨兵 `<path>.retired`（JSON，含 `at/path/movedTo/backup/error/note`，`writeRetiredMarker`/`readRetiredMarker`）。`retireFallbackFile()` 现在是「**先落哨兵 → 再 rename**」；`init()` 在 `tryUpgrade` **之前**调用 `detectRetiredState(path)`，所以「本进程刚退役」和「上次退役/只有 `.migrated-*`」两种来源都能认出来。全新安装（既无文件也无 `.migrated-*`）仍然 `retired === null`，不会误报。
2. **退役 + 官方存储不可用 → 绝不静默空列表**：新增 `state.backendUsable`（显式记录当前后端是 `file` 还是 `domain`，不再靠 `retired` 是否存在推断）与 `ensureRetiredFallbackReadable()`；`currentOp()` 在任何读/写前调用它，命中就抛 `Error(code='RETIRED_FALLBACK_UNAVAILABLE')`。`load()` 因此走**既有失败路径**（面板 `failed` + 重试），不是空列表。`describe()` 新增 `preferred: 'domain'`（原有）、`backendError`、`backendUsable`、`domainUnavailable` 四个字段，`backendError` 里明确写「官方存储不可用，且回退文件已于 &lt;ISO 时间&gt; 退役（&lt;path&gt;）…档案：&lt;migrated/marker&gt;」。
3. **`detectSplit` 不再因本地为空早退**：删掉 `if (!localIds.size) return;`，并区分「文件不存在/已退役」「文件在但为空」「文件读不出来」三种形态；空列表照样告警。
4. **面板页脚**：`storeAlerts()`（导出）在 `domainUnavailable` 时产出 warn 级 `retiredUnavailable`（文案含退役时间、档案路径与处理建议）；新增导出 `storeLocationLabel()`，已退役时**不再**把（可能不存在的）回退文件路径当存储位置，而是显示「官方 storage · 回退文件已迁移并退役 · 退役档案 &lt;movedTo/marker&gt;」，官方存储不可用时额外写「不可用」。哨兵路径只有在**确认存在**时才会进入 `retired.marker`，所以不会展示幽灵路径。

**测试**（`tools/verify-store.mjs`，2 条新增）：

- `F1：回退文件已退役 + 官方存储不可用 → 绝不静默返回空列表，且 describe()/日志明确报错`：先真实升级+退役，再以 `ctx.get('storageDomain') === undefined` 重开；断言 `load()` 抛错（`loaded === null`）、`code='RETIRED_FALLBACK_UNAVAILABLE'`、`describe().preferred='domain'`、`domainUnavailable=true`、`backendError` 含「退役」、`retired.alreadyRetired=true`、有 warn 日志。另断言**哨兵存在**。
- `F1：没有哨兵时（旧版本退役）也能从 .migrated-* 认出已退役，domain 不可用同样不静默`：手工只留 `.migrated-20261013-220627` + 预置 `storages/worktodo.json`（= 真机形态），断言不返回空、`retired.movedTo` 命中 `.migrated-`，且 `split` 必须报出「官方独有 1」。
- 面板侧（`tools/smoke-client.mjs`）：`退役 + 官方存储不可用：面板页脚必须渲染出警告与「数据在官方存储」`（真渲染 DOM，断言 warn 节点、告警文案、`不可用`、档案路径，且不出现原路径）；`页脚存储位置：已退役时不得把不存在的回退文件当存储位置`。

**反向验证**（`/tmp/wt-reverse` 副本，逐条回退）：把 `ensureRetiredFallbackReadable` 改成 `return false`、`detectRetiredState` 不再从 `.migrated-*` 推导、`init()` 不识别退役、`detectSplit` 恢复 `if (!localIds.size) return;` 之后：
`✗ F1：回退文件已退役…`（`期望 null，实际 []` 之前先撞 `load()` 不抛错）、`✗ F1：没有哨兵时…`、附带 `✗ 升级后删掉一条再重开（复审 R1）`（该用例也依赖 `alreadyRetired`）→ **23 通过，4 失败**。
面板侧回退（`retiredUnavailable` 分支与 `storeLocationLabel` 短路）：`✗ 数据不一致告警…`、`✗ 页脚存储位置…`、`✗ 退役 + 官方存储不可用…` → **20 通过，3 失败**。

## F2（中）合并中途失败 → domain 半截、并集复活已删项 —— 已修

**修法**（`src/store.mjs` 的 `mergeInto`）：合并对目标端做成「全有或全无」：
1. 写之前全量 `repairRecord`（schema 类确定性失败挡在写之前）；
2. 记下每个 key 合并前的值（`previous` Map）；
3. 逐条 `put` 失败即 `break`，然后**逐条回滚**（合并前存在的写回原值、本次新增的 `remove`）；
4. 失败时 `state.merge = { …, aborted: true, writeError, rollbackError }` 并抛错 → `tryUpgrade` 记 `mismatch`、release domain、留在文件后端；回滚本身失败也会写进 `rollbackError`，不吞原始错误。
5. 归并成一条：`state.merge` 失败时也带 `merged: 0`，`storeAlerts` 据此报 warn `mergeAborted`（用户能看见「已回滚」）。

**测试**：`F2：合并中途失败必须回滚，不留下半截 domain（否则用户删掉的待办会复活）`——注入第 2 条 `put` 失败；断言 domain 里**没有**已写入的 `wt-a`、`records.size === 0`、`merge.aborted=true` 且 `writeError` 指向 `wt-b`、文件未退役；随后用户在文件侧删 `wt-a`、解除注入、跨过 5s 节流再合并，断言 `ids === ['wt-b','wt-c']`（**已删除的 wt-a 不复活**）且 domain 里没有 `wt-a`。

**反向验证**：把守卫写循环+回滚整段换回 `for (const record of todos) await target.put(record);` → `✗ F2：…已写入的 wt-a 必须被回滚掉（不留半截）：期望 false，实际 true`（**26 通过，1 失败**，其它用例全绿）。

## F3（中）rename 失败只告警、面板反报成功 —— 已修

**修法**：
1. **先写哨兵再改名**：rename 失败也留下 `<path>.retired`，下次启动据此把该文件排除在合并源之外；`tryUpgrade` 里 `if (!state.retired) await mergeInto(...)`，已退役（含改名失败）的文件**不再被并进 domain** → 已删除项不会复活。
2. **面板必须显示失败 + 原因 + 建议**：`storeAlerts` 优先判 `retired.error`，产出 warn `retiredFailed`（原文错误 + 「文件仍在 &lt;path&gt;：请手动改名或删除，否则它可能让已删除的待办复活」），且**不再**输出 info 的「已迁移并退役」；只有 `movedTo` 存在时才报成功。
3. **F8 一并修掉**：只有 `renameRetireFile(path, dest)` 在 try 内，成功分支的记账/日志在 try 之外（日志抛错不会再把成功误报成失败）。
4. 为可测试性留了**显式故障注入点** `WORKTODO_TEST_FAULT=retire-rename`（仅在设置时生效）——ESM 的 `node:fs` 命名空间是冻结的，测试无法替换 `renameSync`，没有这个注入点就只能靠不可靠的路径技巧。

**测试**：`F3：退役 rename 失败 → 显示失败原因（不是「已迁移并退役」），且该文件不再当合并源（不复活）`——注入 EACCES；断言 `retired.error` 有原文、`movedTo === null`、note 含「仍然存在」、warn 日志含「退役失败/已被排除在合并源之外/手动改名或删除」且**没有**成功 info；随后 domain 删 `wt-a` → 重开，断言 `ids === ['wt-b','wt-dom-d']`（**不复活**）、重开仍认得哨兵。

**反向验证**：把哨兵写入去掉、失败分支改成 `error: null` + `note: '回退文件已迁移并退役'` → `✗ F3：…失败也要落哨兵（下次启动据此排除）：期望 true，实际 false`（**25 通过，2 失败**；另一条红是 F1 用例的哨兵断言，说明两个修复共用同一机制）。

## 顺手项

| 项 | 状态 | 修法 / 测试 |
| --- | --- | --- |
| **F4** 文案把已退役/不存在的文件说成「当前仍在使用」 | ✅ | `acquireDomain` 失败与 `mergeInto` 失败两处 `mismatch` 都改为按 `existsSync(ownedFile.location)` 分流：存在才说「当前仍在使用 JSON 文件 …」，否则说「回退文件已退役/不存在，本次列表为空（官方 storage 里仍有数据…）」；`detectSplit` 也按「不存在/已退役/在但为空/读不出来」区分。既有 open-失败用例仍绿。 |
| **F5** `verify-all.mjs` build 未指定 cwd | ✅ | `const repoRoot = join(here, '..')`，build 与全部 suite 的 `spawnSync` 都显式 `cwd: repoRoot`。 |
| **F6** `smoke-client` 只比对两个写死文件 | ✅ | 改为遍历 `map.sources` 里**全部** `src/**` 条目逐一双向比对（源文件必须存在 + `sourcesContent` 逐字相等），并反向断言 `src/client/*.js` 每个文件都在 bundle 里。 |
| **F8** 成功分支日志在 try 内 | ✅ | 见 F3 第 3 点；成功日志包在自己的 try 里，且只在 rename 成功后执行。 |
| **F9** 每次合并失败都新增一份 `.bak-` | ✅ | 新增 `recordBackup(slot, path)`：同路径 + 5s 内 + 大小一致 → 复用；否则复制一份并 `pruneBackups` 只保留最近 2 份。新增用例 `F9：合并反复失败不会每次新增 .bak-（同一轮复用 + 轮转上限）`（1 次失败 → 1 份；同轮再失败 2 次 → 仍 1 份；跨窗口后再失败 → ≤2 份）。 |
| **F12** `refreshBackend` 在 try 外 + init 无兜底 | ✅ | `currentOp` 把 `refreshBackend()` 纳入同一个 try 并保证 `current` 非空（`待办存储未初始化完成（后端不可用）`）；`init()` 的首次 `tryUpgrade` 包 try，失败降级成 `mismatch`/`backendError`；`lib/index.js` 的 `openWorkTodoStore` 也包 try，失败时注入一个「能挂载、能报错」的降级 store（`kind:'unavailable'`，读写抛错，`describe()` 带 `backendError`），确保任何异常都不会阻止插件挂载（工具与路由照常注册，面板看到错误而不是空白）。 |
| **F10 / F11 / F7 / F12 其余 nit** | ⏸ 未改 | 与「必修」路线无关，且 F10/F11 复审自己判定为「复现不出 / 说明性」。本轮不动，避免扩大改动面（如需可下一轮单独做）。 |

## 全量结果

`WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs` → **10/10 个步骤通过（含构建）**；`verify-store.mjs` **27 通过，0 失败**；`smoke-client.mjs` **23 通过，0 失败**。

## 真实文件

全程**只读**：没有对 `~/.dsh/worktodo/todos.json*`（含 `.migrated-20261013-220627`、`.bak-*`）或 `~/.dsh/storages/worktodo.json` 做过任何写入/改名/删除；所有实验都在 `/tmp` 临时树或 `mkdtemp` 出来的临时 `DSH_HOME` 里跑，测试结束即清理。
