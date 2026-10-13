# dsh-worktodo 0.2.0 可靠性审计（会不会炸 / 会不会丢数据）

审计对象：仓库工作区里的 `dsh-worktodo`（`package.json` version = 0.2.0，git HEAD = `6e9aee7`）。
它当前以 `link:` 方式装在 `~/.dsh/profiles/desktop/node_modules/dsh-worktodo`，浏览器侧产物 `lib/client.js` 与 `src/client/index.js` 逐项一致（本次审计逐条比对过关键路径）。

审计方式：**先读全部宿主/客户端源码，再动手做实验**。所有"实跑"结论都注明了复现方式；纯推断的标注为"读代码推断"。
报告里的家目录一律写成 `~/...`。

---

## 结论摘要

- **有 2 条会让用户认为"待办全没了"的致命问题**，其中一条在**这台真机上有直接物证**：官方 storage 领域文件里躺着 6 条、JSON 回退文件里躺着另外 4 条，**零重叠**（两次写入日期不同天）。
- **有 1 条会让手改坏的文件在下次写入时被整份清空。**
- 宿主侧**没有**残留"未 inject 就直接访问服务"的写法（历史事故的那一类），我用真 cordis 插件 fiber 复现过守卫抛错，确认现在不会踩。
- 客户端**没有** `dayKey` 那类未定义标识符，也没有无限渲染循环；我用一个会真重渲染的迷你 React 跑了 21 种载荷（含数据落地、畸形数据、投影抛错、网络失败），全部 0 异常。
- 客户端有 2 个真实的静默数据变形：**新建待办时丢掉用户选的时间**、**编辑 `priority: none` 的条目会把它改成 `normal`**。

严重级别统计：致命 2 / 高 1 / 中 5 / 低 8。

---

## 致命

### F1（致命）存储后端会静默切换，用户待办"整体消失"，数据分裂在两处

**位置**
- `lib/index.js:32`（`export const inject = []`）、`lib/index.js:161`（`await openWorkTodoStore(...)`）
- `src/store.mjs:215`（`ctx?.get?.('storageDomain')` 探测）、`src/store.mjs:217-227`（失败即回退另一个位置）
- `src/store.mjs:184-190`（`close()` 定义了却没人调）

**现象**
存储位置是在 `apply()` **最开头同步**决定的，而插件 `inject` 为空、对 `storageDomain` 没有任何依赖声明——所以"官方 storage 是否可见"取决于 fiber 激活顺序，是个竞态。一旦那一刻拿不到，插件**永久**改用 `~/.dsh/worktodo/todos.json`，而且在同一个进程里**永远不会纠正**：

- 官方 storage 里已有的待办，面板一条都看不到（用户视角 = "我的待办全没了"）；
- 反过来也一样：下次进程重启、竞态赢了走官方 storage 时，JSON 文件里的那批又看不见；
- 两边都还能正常写入，于是数据**永久劈成两份**，谁都不知道还有另一份。

除了竞态，**存储域任何一次 `open()` 失败都会走到同一条静默降级路径**：`already-open`（同一进程内二次挂载时必然发生，因为插件从不调 `store.close()`）、`version-mismatch`（以后把领域 `version` 从 1 提到 2 就会踩）、`backend-not-found`、`malformed-medium`、`invalid-record`（无 backup 能力时）。插件的日志只有一行 `warn`。

**证据（实跑）**
1. **真机上确实已经分裂**（只统计条数，不看内容）：
   - `~/.dsh/storages/worktodo.json`：`unit.tables.todos` 6 条，mtime `2026-10-11`；
   - `~/.dsh/worktodo/todos.json`：4 条，mtime `2026-10-12`；
   - 两份 **id 交集 = 0**。字段差异：domain 侧没有 `order`/`dueTime`（是更早写进去的），file 侧有。
2. **竞态端到端复现**：真 cordis `Context` + 假 `webServer`，把 `/worktodo/health` 的 handler 取出来调：
   - 阶段 1（apply 时 storageDomain 未注册）：`store = {"kind":"file","location":"$DSH_HOME/worktodo/todos.json"}`；
   - 阶段 2（稍后 `provide('storageDomain')`）：`storageDomainService: true`，但 **store 仍然是 file** —— 服务明明可用了，插件照样把数据写在回退文件里。
3. **`already-open` 降级复现**：直接调 `openWorkTodoStore` 两次（假 facility 复刻官方"第二次 open 抛 already-open"语义）→ 第一次 `kind=domain`，第二次 `kind=file`，日志只有 `官方 storage 不可用，回退 JSON 文件：domain 'worktodo' is already open`。
4. **`close()` 从不被调用**：同样的假 facility 计数 → `open()` 调用 1 次、`close()` 调用 **0 次**；`grep -rn "\.close()" lib/index.js src/*.mjs` 只命中测试文件，宿主侧一次都没有。
5. `inject` 为空是写在注释里的"设计取舍"（`lib/index.js:26-32`），但 `src/store.mjs:210-214` 的注释假设"dsh-base 的层序一定在 profile 组合之前"——这个假设没有机制保证，真机数据就是它不成立的物证。

**最小修复建议**
1. 把存储依赖显式化：`export const inject = ['storageDomain']`（或 `await ctx.inject(['storageDomain'], cb)` 后再建 store），让"服务可见性"由 cordis 保证而不是靠层序。
2. **绝不静默换位置**：把"选中的后端 + 位置"记下来；当选中 file 但检测到（a）同一 `DSH_HOME` 下存在 official storage 领域文件，或（b）本进程此前打开过 domain，则**不要**直接降级——要么报错并保留面板只读，要么一次性迁移并在面板上明确提示。
3. `apply()` 里补 `ctx.effect(() => () => store.close())`，让重载/卸载释放领域句柄（顺带解决 `already-open`）。
4. `/health` 与面板页脚把"当前后端 + 完整位置"做成显眼的**不一致警告**（现在只是一行小字），并提供"从另一个位置导入 N 条"的入口。

---

### F2（致命）文件被手改坏之后，**任何一次写入都会把整份待办清空**

**位置** `src/store.mjs:83-94`（`readDoc` 解析失败 → 返回空文档）、`src/store.mjs:103-110`（`put` 内 `readDoc()` → `writeAtomic` 覆盖）、`src/store.mjs:91`（那句不成立的告警文案）

**现象**
`readDoc()` 把"文件不存在/空"和"JSON 坏了"当成同一件事，都返回 `{todos: []}`。读路径上这没问题（他们的测试就是这么测的），但**写路径是读-改-写**：`put()` 先 `readDoc()` 拿到空列表，再 `writeAtomic` 把"空列表 + 这一条"写回去——原文件当场被覆盖，用户手改坏的文件连同里面所有还能救的待办一起没了。告警文案还写着"按空列表继续（原文件未被覆盖）"，与实际行为相反，排查时会误导。

**证据（实跑）**
```
### 实验 A：文件被手改坏（JSON 语法错误）后再写一条
  原文件还在吗: 已被覆盖
  覆盖后内容: { "version": 1, "updatedAt": ..., "todos": [ { "id": "new1", ... } ] }   ← 只剩刚写的那一条
  warn: 待办文件解析失败，按空列表继续（原文件未被覆盖）：Expected ',' or '}' ...
```
他们自己的用例 `tools/verify-store.mjs:183-191`（"坏文件不该被自动清空"）**只调了 `load()`**，没调 `put()`，所以这条缺口没被测到。

**最小修复建议**
`readDoc()` 返回 `{ doc, damaged }`；`put()`/`remove()` 在 `damaged` 时**拒绝写入并抛错**（上层已能转成 `store-write-failed` 正常响应），同时把坏文件另存为 `todos.json.corrupt-<ts>` 供用户抢救；或者至少"写入前先备份原文件"。告警文案也要改成事实描述。

---

## 高

### F3（高）缺 `title` 的坏记录会在下一次写入时被**永久删除**，且无任何日志

**位置** `src/schema.mjs:130-146`（`repairStoreDocument` 静默跳过坏记录）、`src/store.mjs:104-109`（整份文档写回）

**现象**
JSON 后端是"给人看、给人改"的形态，用户很容易手改出漏字段的记录。`repairStoreDocument` 会跳过它（"单条坏记录不能拖垮整个列表"），但下一次 `put()` 把这个"修好的文档"整份写回磁盘时，被跳过的记录就**从文件里消失了**——不是"看不见"，是**真的没了**。用户不会收到任何提示。

**证据（实跑）**
```
### 实验 B：一条记录缺 title
  写之前条数: 2
  写之后条数: 2  ids= ["ok1","new1"]      ← bad1 永久消失
  再读一次:      ["ok1","new1"]           ← 不会恢复
```

**最小修复建议**
`repairStoreDocument` 返回丢弃清单（`{ todos, dropped: [{index, reason}] }`）；写回前若有 `dropped` 则先备份原文件并 `warn`，面板上给一条"有 N 条记录无法解析，已备份到 X"的提示。宁可写入失败，也不要静默丢用户的条目。

---

## 中

### F4（中）缺 `id` 的手改记录每次读都被分配**新的随机 id**

**位置** `src/schema.mjs:64`（`const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : newId();`）

**现象**
读路径做 repair 时顺带生成 id，于是同一条记录每次 `load()` 都是新 id。写路径不会因此重复（`put` 是整份重写），但**任何跨越一次写入的引用都会失效**：面板上刚渲染出的行、agent 刚 `worktodo_list` 拿到的 id，在下一次任何写入之后点"完成"就会得到 `not-found`。手改文件删掉 id 是很自然的操作（尤其想重新排序时）。

**证据（实跑）**
```
### 实验 C：一条记录缺 id
  连续两次读到的 id: ["wt-mv6gmhkm-nm2s"] ["wt-mv6gmhkm-mb1s"]   相同？ false
```

**最小修复建议**
生成 id 只属于 create 路径；读路径缺 id 时用**稳定派生值**（如 `wt-recovered-<文件内下标>` 或内容 hash）或干脆把该条标记为 `id: null` 并在面板上提示"这条缺少 id，请补上"。

---

### F5（中）面板新建待办时，用户选的"时间"被丢掉

**位置** `src/client/index.js:1099-1103`（`handleAdd` 只发 `title`/`due`/`priority`）；对照 `src/client/index.js:570-574`（`QuickAdd` 明明准备了 `dueTime`）；`lib/client.js:1223-1227` 同样如此。

**现象**
`QuickAdd` 会把标题里的时间词**从标题里摘掉**（`payloadTitle = result.title`），然后 `handleAdd` 却只发 `title/due/priority`。于是"明天下午3点交报告"在面板里录入后变成：标题"交报告"、截止=明天、**时间没了**——摘掉的信息没有通过任何渠道送出。用户完全看不出丢在哪。注意编辑表单里时间字段是好用的，所以只有"新建"这一条路径坏。

**证据** 读代码推断（`src` 与 `lib/client.js` 逐字一致，两处都已核对）。他们的 `tools/smoke-contract.mjs:218` 只断言宿主**接受** `/create` 的 `dueTime`，没有断言客户端**发送**它，所以测不出来。

**最小修复建议**
```js
return runWrite(() => postJson('/create', {
  title,
  due: input?.due ? String(input.due) : null,
  dueTime: input?.dueTime ? String(input.dueTime) : null,   // ← 补这一行
  priority: input?.priority ?? 'normal',
})).then((result) => result.ok);
```
并给 `smoke-contract.mjs` 补一条"客户端真的发了 `dueTime`"的断言。

---

### F6（中）编辑一条 `priority: none` 的待办，会把优先级悄悄改成 `normal`

**位置** `src/client/index.js:727`（`beginEdit` 把 `none` 映射成 `normal`）、`src/client/index.js:754-755`（`submit` 因此必写 `patch.priority`）；`lib/client.js:861,885-886` 同。

**现象**
编辑表单的 `select` 只有 high/normal/low 三项，`beginEdit` 把 `none` 兜底成 `normal`，于是 `priority !== row.priority` 恒成立 → **打开编辑器、什么都不改、点保存**就会把这条的优先级从"无"改成"普通"。`worktodo_update` 工具的 enum 也没有 `none`（`src/tools.mjs:295`），所以一旦被改过去，面板和 agent 都再也回不到"无优先级"。

**证据** 读代码推断（`src` 与 `lib` 一致）。

**最小修复建议** `draft.priority` 原样保留 `'none'`，`select` 里加一项"无"（文案已有 `prioNone`），并在计算 patch 时排除"未改动"的情况。

---

### F7（中）面板不会跟随 agent 的改动刷新（`onChanged` / `onChange` 是死代码）

**位置** `src/store.mjs:124`（file 后端返回空注销函数）、`src/store.mjs:173-183`（domain 后端订阅 `domain/changed`）、`src/service.mjs:310-313`（`onChange`）；`lib/index.js` 里**从未调用**任何一个。

**现象**
`onChanged` / `onChange` 只有定义（`src/store.mjs:124`、`src/store.mjs:173`、`src/service.mjs:310`）、**没有任何调用点**：`grep -rn "onChanged\|onChange(" lib/index.js src/tools.mjs src/service.mjs` 在宿主接线与工具侧 0 命中（唯一命中就是 `service.mjs:310` 那个定义本身）。面板只在挂载、切排序、点刷新、以及**自己**写操作之后重新拉取。所以 agent 通过 `worktodo_add` 加了一条、用户在面板上等着看——不按刷新就永远看不到。文件里那段"面板可以据此刷新"的注释与实现不符。

**证据（实跑）** 全仓 grep 0 命中 + 阅读 `useList` 的请求触发条件（`[tick, sort]`）。这条是覆盖缺口，不是崩溃。

**最小修复建议** 在 `apply()` 里 `ctx.effect(() => store.onChanged(() => 广播给面板))`（或至少让面板在可见时以 5–10 秒间隔轮询），把 `service.onChange` 真正接上。

---

### F8（中）`SessionAdopt` 在 `try/catch` 里调用 hook

**位置** `src/client/index.js:1002-1009`

**现象**
```js
try { projected = useProjection('todos'); } catch { projected = null; }
```
作者这么写是因为"投影可能尚未就绪"。但这违反 React 的 Hooks 规则：一旦 `useProjection` **内部已经注册了 hook 再抛错**，被 catch 吞掉后组件会带着少一个 hook 的状态继续渲染，下次重渲染就可能报 `Rendered fewer/more hooks than expected`，而 slot entry 一抛异常就是**整块白屏**（正是上次事故的失败模式）。当前该子组件里只有这一个 hook（所以风险比一般情况小），但这是靠巧合成立。

**证据** 读代码推断为主；我用迷你 React 跑了 6 种投影形态（`undefined`/`null`/裸数组/`{todos}`/垃圾元素/直接 throw）**都没炸**——但迷你 React 不校验 hook 顺序，所以这条只能算"静态推断，未复现"。真机上 React 未安装，无法做更真的验证。

**最小修复建议** 用错误边界（class component）或"先查投影注册表是否可用、再决定要不要挂载子组件"的方式替代 `try/catch` 包 hook。

---

## 低

### F9（低）`.wt-seg` 的背景色渲染成 `background: undefined;`

**位置** `src/client/index.js:282`（`background: ${C.bg2};`，而 `C` 里没有 `bg2` 键）；`lib/client.js:409` 同。
**现象** CSS 里多出一条无效声明会被浏览器丢弃，分段控件（排序/视图切换）没有底色。**不会抛错**，因为访问对象上不存在的属性得到 `undefined` 而不是异常——但如果哪天这个位置写的是标识符而不是属性，就是白屏级别的 bug。
**证据（实跑）** 加载 `lib/client.js`、渲染 loading 分支、取出 `<style>` 文本：含 `undefined` 的行 = `[[55,"...border: 1px solid var(--dsw-alias-border-l2); background: undefined;"]]`。
**修复** 删掉该声明，或补成真实变量（如 `--dsw-alias-bg-layer-2`）。

### F10（低）超过 256KB 的请求体被直接断连，客户端只看到网络错误

**位置** `lib/index.js:78-110`（`reject(...)` 之后 `request.destroy()`）
**现象** handler 的 catch 仍会尝试 `sendJson(200, {ok:false})`，但 socket 已被销毁，响应发不出去。
**证据（实跑）** 用同样的代码起本地 http server，300KB POST → 客户端 `fetch failed`；进程**没有崩溃、没有未捕获异常**（`uncaughtException`/`unhandledRejection` 都未触发）。正常体、非法 JSON、数组体、空体都安全地回 200 `{ok:false, reason:'internal', ...}`。
**修复** 先回 413/200 `{ok:false, reason:'body-too-large'}` 再结束；若一定要断连，也先把请求流 `resume()` 排空。

### F11（低）请求路径上的同步文件 IO（`readFileSync`/`writeFileSync`）

**位置** `src/store.mjs:86`（每次 `load` 全量读）、`src/store.mjs:62/109/119`（写）、`src/store.mjs:60`（`mkdirSync`）
**现象** `/worktodo/list`、`worktodo_list` 每个请求都同步读整个文件；`service.reorder` 对每条变动的记录各做一次"读全量 + 写全量"（O(n²)）。待办规模小的时候无感，但文件被手写大（或磁盘慢/网络盘）时**会阻塞 DSH 的事件循环**，连带拖慢整个宿主。
**证据** 读代码推断（规模小，实测无感知问题）。
**修复** 大文件场景换异步 IO + 内存缓存；`reorder` 合并成一次写。

### F12（低）`renameSync` 覆盖在 Windows 上可能瞬时失败，临时文件不清理

**位置** `src/store.mjs:58-64`
**现象** 杀毒/索引器持有目标文件时 Windows 的 rename 可能 `EPERM/EBUSY`；抛错会让这次写入失败（数据不丢，用户看到写失败）。进程被杀会留下 `${path}.tmp-<pid>` 永久残留。
**证据** 读代码推断（未在 Windows 验证）。
**修复** rename 加重试（几十毫秒退避）；启动时清理同目录的历史 `*.tmp-*`。

### F13（低）接口与面板会把用户的绝对家目录路径吐给浏览器

**位置** `lib/index.js:315`（`/list` 回包里带 `store.location`）、`lib/index.js:391`（`/health`）、`src/client/index.js:1397-1402`（页脚直接显示）
**现象** 响应内容与页面上会出现 `~/<用户名>/.dsh/worktodo/todos.json` 这种绝对路径。功能上是有意为之（排查"我的待办存哪了"），但截图/投屏会泄露用户名与本机目录结构。
**证据** 实跑 `openWorkTodoStore` 后 `store.location` 即绝对路径；`/health` 也返回同一字段。
**修复** 展示层统一压缩成 `~/.dsh/...`；需要完整路径时放在只有本机 agent 能读的地方。

### F14（低）更新检查在**请求路径**上打 npm registry

**位置** `lib/index.js:307`（`/list` 里 `void refreshUpdate()`）、`lib/index.js:211-214`（`fetch` + 8s 超时）、`lib/index.js:233`（启动时一次）
**现象** 装完插件后，只要打开过面板，DSH 进程就会访问 `registry.npmjs.org`。**不会阻塞响应**（fire-and-forget + TTL 6h + 失败静默，设计是对的），但它让"只是打开一个本地待办面板"产生了外网请求，对隐私敏感的用户是意外行为。
**证据** 实跑（用 `WORKTODO_NO_UPDATE_CHECK=1` 关掉后全部测试才不联网，验证了开关有效）。
**修复** 保持现状即可，或在面板/配置里加显式开关与首启提示。

### F15（低）工具描述与实现不一致，且 agent 无法把优先级清回 `none`

**位置** `src/tools.mjs:96`（描述写"优先级，默认 normal"）vs `src/records.mjs:249`（实现默认 `'none'`）；`src/tools.mjs:295`（`worktodo_update` 的 enum 缺 `none`）
**现象** 模型按描述以为默认是 normal，实际存的是 none；也没法通过工具清空优先级（配合 F6 就变成单向不可逆）。
**证据** 读代码推断。
**修复** 描述改成"默认不设"；`priority` 的 enum 增加 `none`（`normalizePriority` 本来就支持）。

### F16（低）`store.kind`/`location` 之外，`/health` 的 `count` 在存储读失败时静默显示 0

**位置** `lib/index.js:384`（`await service.all().catch(() => [])`）
**现象** 存储读不出来时 `/health` 报 `count: 0`，看上去像"用户没有任何待办"，而不是"读取失败"——排查时容易误判（尤其配合 F1 时，用户会以为数据真的没了）。
**证据** 读代码推断。
**修复** 区分 `count: null` + `error` 字段。

---

## 测试覆盖缺口（这轮"侥幸没被测出来"的地方）

| 缺口 | 位置 | 后果 |
| --- | --- | --- |
| 客户端 React 替身 `useState` 的 setter 是空函数、且**从不重渲染** | `tools/smoke-client.mjs:79-86` | "loading → 数据落地 → 用真数据渲染"这条路径 **0 覆盖**，正是上次 `dayKey` 白屏事故所在的路径。我另写了一个会真重渲染的迷你 React 补测（21 种载荷全过）。 |
| 坏文件用例**只测 `load()`**，不测 `put()` | `tools/verify-store.mjs:183-191` | 漏掉 F2（一次写入清空整份文件）。 |
| 契约用例只断言宿主**接受**哪些字段，不断言客户端**发送**哪些字段 | `tools/smoke-contract.mjs:218` | 漏掉 F5（客户端丢 `dueTime`）。 |
| 存储后端只测"一次成功打开"，没有多挂载/服务晚注册/打开失败的用例 | `tools/verify-store.mjs:97-144` | 漏掉 F1（静默换位置 + `close()` 从不调用 + `already-open`）。 |

---

## 我实际跑了什么（原样可复现）

1. `WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs` → **9/9 套件通过，exit 0**（未设该变量会打网络）。
2. **真 cordis 守卫复现**（`node_modules/@deepseek-ai/cordis/lib/index.js` 真包 + 真插件 fiber）：
   - `ctx.storageDomain` → `cannot get property "storageDomain" without inject`（历史事故的守卫，确认现在没有代码这么写）；
   - `ctx.logger`、`ctx.on`、`ctx.get`、`ctx.inject` → 都不抛（`logger` 是 `Context` 的自有属性，`on/get` 是根上下文的 mixin，`Reflect.has` 为真）。
3. **真 cordis + 真 `lib/index.js` 的 `apply()`**：无服务时 apply 不抛错；`ctx.get('storageDomain')` 返回 `undefined` 且**不抛**；`webServer.register` 抛错时 apply 也**不抛**（异常被注入 fiber 吞掉，表现为路由消失而不是整包挂载失败）；正常时注册 **8 条路由**（路径清单已核对）。
4. **存储后端选择实验**：假 `storageDomain` 计数 → `open()` 1 次、`close()` **0 次**；第二次打开（already-open）→ 静默 `kind=file`。
5. **端到端竞态实验**：真 cordis + 假 `webServer`，直接调 `/worktodo/health` 的 handler → 阶段 1 `store.kind=file`；阶段 2（补上 storageDomain）`storageDomainService: true` 但 `store.kind` 仍是 `file`。
6. **文件后端数据安全实验 A–E**：坏文件 + 写 → 原文件被覆盖（只剩新记录）；缺 `title` 记录 + 写 → 永久消失；缺 `id` 记录 → 每次读换新 id；未知字段（`tags`/`done`）写盘后被抹掉；`order`/`dueTime`/`priority` **能**被读路径保留（这一条是好消息）。
7. **HTTP 健壮性实验**：正常体 / 非法 JSON / 数组体 / 空体 / 300–400KB 超大体的行为逐一实测（无崩溃、无未捕获异常；超大体验证为断连）。
8. **客户端深测**（自写迷你 React：真重渲染、真 deps 比较、真清理，超过 25 轮即判"疑似死循环"）：首屏 loading → 数据落地重渲染；10 种畸形/缺失载荷；6 种 `useProjection` 形态；4 种网络失败形态 → **21 项全部通过，每例 2 轮收敛**（没有无限渲染循环，没有渲染期异常）。
9. **客户端标识符核对**：正则扫描 + **逐行人工阅读全部 1431 行**；唯一"没有定义就被用"的东西是属性访问 `C.bg2`（取值 `undefined`，不抛错），用实跑取 `<style>` 文本确认。
10. **真机存储核对**：比对 `~/.dsh/storages/worktodo.json` 与 `~/.dsh/worktodo/todos.json` 的条数、id 交集、字段集合、mtime（**只看结构与计数，不引用任何待办内容**）。

**没做到 / 只能推断的**
- **没能访问运行中的 HTTP 接口**：`http://127.0.0.1:19387/worktodo/health` 一律 401（补了 `Origin`/`Host` 也不行），所以**无法确认当前这个正在跑的进程到底持有哪个后端**；F1 的"真机已分裂"是文件证据 + 代码路径推出来的，不是从活进程读出来的。
- 没有在 Windows 上验证 F12；本地没有真 React（插件只把 react 当外部依赖，仓库里没装），F8 只能算静态推断。
- 没有启真实的 `@deepseek-ai/dsh-storage-domain` facility（需要 `ctx.storage.backend`），F1 的实验用"复刻官方 open/table 语义的假 facility"完成；官方实现的读法（`open` / `table.entries()` / `table.put` / `table.delete` / `already-open` / `version-mismatch`）是**逐行读它的 `lib/index.js` 核对过**的。

---

## 必须在上线前修（按顺序）

1. **F1** —— 存储位置静默切换导致待办"整体消失"/数据分裂。真机已有物证。至少要：`inject` 声明存储依赖、失败不换位置、`apply` 里 `store.close()`、面板给出显眼的存储不一致告警。（致命）
2. **F2** —— 坏文件 + 一次写入 = 整份待办清空，且告警文案与事实相反。（致命）
3. **F3** —— 缺 `title` 的记录在下一次写入时被永久删除、无日志。（高）
4. **F5 / F4** —— 面板丢 `dueTime`（用户输入静默丢失）；缺 id 的记录 id 每次读都变（跨写入引用全失效）。（中）
5. **F6** —— 编辑即把 `priority: none` 改成 `normal`（不可逆的数据变形）。（中）
6. **F7** —— agent 改了列表面板不刷新：与文件里承诺的行为不符，属于"看起来没生效"的典型报障来源。（中）
7. **测试** —— 给 `smoke-client` 换成会重渲染的 React 替身；坏文件用例补 `put()`；契约用例补"客户端真的发了哪些字段"；存储用例补"二次挂载 / 服务晚注册 / open 失败"。（防复发）

F8–F16 可以排到 0.2.1：都不影响"能不能用"，其中 F9 是纯视觉、F10 只影响超大请求体、F11–F12 是规模化/跨平台隐患、F13–F15 是隐私/一致性/文案。

---

## 修复状态（0.2.0 修复轮）

修复范围：本轮要求修的 **F1 / F2 / F3 / F5 / F6 / F7**，外加 **F4 的稳定 id**（在 F3 的读路径修复里顺带解决）。F8–F16 未动（不在本轮范围）。
改动文件：`src/store.mjs`、`src/schema.mjs`、`src/service.mjs`、`lib/index.js`、`src/client/index.js`（并重建了 `lib/client.js`）。
测试文件总数仍是 **9** 个（`node tools/verify-all.mjs` 的 9 套件），新增用例全部加进现有文件；所有走默认存储路径的用例都把 `DSH_HOME` 指到临时目录，**测试不再接触真实 `~/.dsh`**。

### F1（致命）存储后端静默切换 / 数据分裂 —— 已修

**修复方式**
1. **可纠正的后端选择**（`src/store.mjs`）：未显式给 `storePath` 时不再在 `apply()` 开头一锤定音，而是返回一个可纠正的句柄——先按回退文件（`$DSH_HOME/worktodo/todos.json`）活着，之后每次 `load/put/remove` 都复查 `ctx.get('storageDomain')`；服务就绪即升级到 domain 后端。
2. **正确声明的注入**（`lib/index.js`）：新增 `ctx.inject(['storageDomain'], …)`，服务注册/重载时就地触发升级检查——「服务可见性」由 cordis 保证，不再依赖层序（静态 `inject` 仍为空，保留「缺服务也能少一半能力活着」的设计）。
3. **二次挂载不降级**：模块级 `WeakMap` 按 `storageDomain` 服务对象共享同一个领域句柄并引用计数；第二次 `open` 不会再撞官方 `already-open`，最后一个使用者关闭时才真正 `domain.close()`。
4. **释放句柄**：`apply()` 补 `ctx.effect(() => () => store.close())`（原来 `close()` 定义了却从没人调）。
5. **绝不静默**：`store.describe()` 报告 `preferred / mismatch / split / merge / upgrades`，`/worktodo/health` 的 `store` 字段带上它们；后端与首选不一致、domain `open` 失败、两处 id 不一致都会 `warn`（`split` 单独给出「官方 N 条 / 回退 M 条、官方独有 X、文件独有 Y」）。
6. **合并而不是二选一**：升级时把两处记录按 id 取并集（同 id 取 `updatedAt` 较新者，官方侧优先保留），写回官方 storage；回退文件同步成同一份并集（以后再降级不会看到旧数据、也不会复活已删条目）。动手前把两个落盘文件各复制成 `<path>.bak-<时间>`；合并报告（条数 / 冲突数 / 从另一处补入数 / 备份路径 / 回退文件镜像）写进 `describe().merge` 与日志。

**新增/修改的测试**
- `tools/verify-store.mjs`：`unionById` 语义；storageDomain 晚注册 → 下一次 `load()` 升级到 domain 且合并后 3 条一条不少、`.bak-<时间>` 备份内容 = 合并前的回退文件、回退文件被同步成并集；同 id 冲突双向都取 `updatedAt` 较新者；两处 id 不一致 → `describe().split` + warn；domain `open` 失败 → 留在文件后端但 `describe().mismatch` + warn；二次挂载只 `open` 一次、数据不丢、引用计数最后才 close。
- `tools/smoke-host.mjs`：同一 ctx `apply()` 两次（不传 `storePath`）→ `store.kind` 仍为 `domain`、假 facility `open` 只 1 次、数据还在；卸载 effect 触发 `domain.close()`。

**反向验证**：把 `tryUpgrade()` 改成直接 `return false`（等价于恢复「apply 时一锤定音」）→ `verify-store.mjs` **5 条红**、`smoke-host.mjs` **1 条红**；恢复修复后全绿。

**真机数据合并（本轮实际执行）**：合并前 `~/.dsh/storages/worktodo.json` 6 条、`~/.dsh/worktodo/todos.json` 4 条、**id 交集 0**；按 id 取并集后 **10 条，同 id 冲突 0，丢失 0**，并集同时写回官方 storage 与回退文件（两处 id 集合现已完全一致）。
备份（动手前复制，原文件保留）：
- `~/.dsh/storages/worktodo.json.bak-20261013-172245`（合并前的 6 条）
- `~/.dsh/worktodo/todos.json.bak-20261013-172245`（合并前的 4 条）
- 另有一份更早的开工前备份 `~/.dsh/storages/worktodo.json.bak-20261013-171717`、`~/.dsh/worktodo/todos.json.bak-20261013-171717`。

### F2（致命）坏文件被写入时覆盖为空列表 —— 已修

**修复方式**（`src/store.mjs`）：`readDoc()` 返回 `{ doc, damaged, dropped }`，把「文件不存在/为空」与「读坏了」区分开。`put()`/`replaceAll()` 写入前先 `protectBeforeWrite()`：坏文件**改名**为 `<path>.corrupt-<时间>.bak`（原始内容完整保留、新内容写到干净路径），被跳过的垃圾条目另存 `<path>.dropped-<时间>.json`。告警文案改成事实描述（「写入时会先把原文件改名备份成 …，原内容不会丢」），删掉了与事实相反的「原文件未被覆盖」。

**新增/修改的测试**（`tools/verify-store.mjs`）：坏文件 + `put()` → `.corrupt-<时间>.bak` 存在且与原坏文件逐字一致、新文件只含新记录、warn 提到 `corrupt-`、不再出现「原文件未被覆盖」；只读路径（`load()`）仍然不动磁盘。

**反向验证**：把 `put()` 里的 `protectBeforeWrite(read)` 去掉 → 该用例 **红**（无备份、原文件被覆盖）；恢复后全绿。

### F3（高）缺 title 的坏记录在下次写入时被永久删除 —— 已修

**修复方式**（`src/schema.mjs`）：`repairStoreDocument()` 不再「跳过」可修复的记录——缺 `title` 给占位标题 `(无标题记录)` 并保留 id/其它字段；只有完全不是对象的垃圾条目才进 `dropped` 清单（由写入路径备份成 `.dropped-<时间>.json`）。顺带把读路径缺 `id` 的记录改成**按文件内位置派生稳定 id**（`wt-recovered-<下标>`），不再每次读都生成新随机 id（F4）。

**新增/修改的测试**：`tools/verify-records.mjs`（占位标题 + `dropped` 下标 + 稳定 id 两次读一致）；`tools/verify-store.mjs`（缺 title 记录 `load()` 用占位标题读出；`put()` 之后该记录与其它字段仍在文件里，垃圾条目进了 `.dropped-*.json`）。

**反向验证**：去掉占位标题那段逻辑（恢复「抛错即跳过」）→ `verify-records.mjs` **1 条红**、`verify-store.mjs` **2 条红**；恢复后全绿。

### F5（中）面板新建待办丢掉 dueTime —— 已修

**修复方式**（`src/client/index.js`）：`handleAdd` 的 `/create` 报文补上 `dueTime: input?.dueTime ? String(input.dueTime) : null`（空值显式 `null`，不是 `undefined`）；重建 `lib/client.js`。

**新增/修改的测试**：`tools/smoke-contract.mjs` 新增「客户端必须发 `dueTime` 且空值为 `null`」（静态提取 `postJson('/create', {...})` 的键 + 正则校验 `: null`），并把 create 报文用例改成含 `dueTime: null`；新增「带 `dueTime` 的报文能落库」。顺带修了静态提取器：匹配键之前先剥掉行注释（注释会挡住 `,` 导致 `dueTime` 抽不出来）。

**反向验证**：删掉 `dueTime` 那一行 → `smoke-contract.mjs` **1 条红**；恢复后全绿。

### F6（中）编辑 `priority: none` 静默变成 normal —— 已修

**修复方式**（`src/client/index.js`）：编辑草稿抽成导出的纯函数 `buildEditDraft(row)`，`none` 原样保留；下拉选项抽成 `EDIT_PRIORITY_OPTIONS = ['high','normal','low','none']`（含「无」），提交时用 `draft.priority || row.priority || 'none'` 且与 `row.priority` 比对，不再用 `|| 'normal'` 兜底。

**新增/修改的测试**：`tools/smoke-client.mjs` 直接调 `mod.buildEditDraft` 断言 `none/high/low` 保留、只有缺省/非法值回退 `normal`，并断言 `EDIT_PRIORITY_OPTIONS` 含 `none`。

**反向验证**：把 `EDIT_PRIORITY_OPTIONS` 里的 `'none'` 去掉 → **1 条红**；恢复后全绿。

### F7（中）面板不因 agent 改动刷新（onChanged/onChange 死代码）—— 已修

**修复方式**
- 宿主（`lib/index.js`）：`ctx.effect` 里把 `store.onChanged` 接到 `service.notifyStoreChange`，让 storage 的 `domain/changed`（别的写入者）真正广播给 `service.onChange` 的监听者；`/worktodo/health` 增加 `changes: { count, lastAt }` 作为可观测证据，注销函数挂在 `ctx.effect` 上。
- 服务（`src/service.mjs`）：导出 `notifyStoreChange(change)`（走内部 `emit`）；`describe()` 合并 `store.describe()` 的字段。
- 面板（`src/client/index.js`）：新增 10 秒轮询 + 窗口重新聚焦/可见性变化时 `refresh()`，清理函数 `clearInterval` 并移除监听（Node 环境 `unref` 防止测试挂住），重建 `lib/client.js`。

**新增/修改的测试**：`tools/smoke-host.mjs`（`domain/changed` → health 的 `changes.count` +1；注销 effect 后不再增长）；`tools/verify-service.mjs`（`notifyStoreChange` 广播 + 注销后不再收到）；`tools/smoke-client.mjs`（拦截 `setInterval`/`clearInterval`：面板必须注册会触发 `refresh` 的定时器，且 effect 清理时被 `clearInterval`）。

**反向验证**：去掉客户端轮询 effect → `smoke-client.mjs` **1 条红**；把宿主 `store.onChanged` 接线摘掉 → `smoke-host.mjs` **1 条红**；恢复后全绿。

### 反向验证汇总（把修复回退，测试必须变红）

| 回退的修复 | 变红的用例 |
| --- | --- |
| F1：`tryUpgrade()` 直接 `return false` | `verify-store.mjs` 5 条、`smoke-host.mjs` 1 条 |
| F2：`put()` 不再先 `protectBeforeWrite()` | `verify-store.mjs` 1 条（坏文件备份）+ 1 条（`.dropped` 备份，连带红） |
| F3：去掉缺 title 的占位标题 | `verify-records.mjs` 1 条、`verify-store.mjs` 2 条 |
| F5：删掉 `/create` 的 `dueTime` | `smoke-contract.mjs` 1 条 |
| F6：`EDIT_PRIORITY_OPTIONS` 去掉 `none` | `smoke-client.mjs` 1 条 |
| F7（客户端）：删掉轮询 effect | `smoke-client.mjs` 1 条 |
| F7（宿主）：摘掉 `store.onChanged` 接线 | `smoke-host.mjs` 1 条 |

### 仍然没修 / 不确定的

- **F4 只算部分修复**：读路径缺 `id` 的记录现在有稳定派生 id（同一次文件内容两次读一致），但派生值依赖文件内下标——手改文件调整行序后 id 会变。要彻底解决得把「缺 id」当成显式的待补状态（面板提示用户补 id）。
- **F8–F16 未动**（不在本轮范围）：尤其 F16（`/health` 的 `count` 在存储读失败时显示 0）与 F1 的合并信息叠加时仍可能让人误判——`describe()` 已带 `mismatch`，但 `count` 仍然是 `.catch(() => [])`。
- **真机合并依赖「运行中的进程」**：合并是在插件进程之外离线做的（备份已留）。如果运行中的旧实例仍持有 domain 句柄并在之后写盘，可能以它内存里的旧快照覆盖这次合并；重启后会按 union 自动再合并一次（幂等），但重启前建议别再让旧实例写。真机物证（6/4、id 交集 0）已按 id 并集合并为 10 条。
- 反向验证是「按修复点逐条回退」，不是用 git revert；结论以本机实跑为准（`WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs` → 9/9 通过）。
