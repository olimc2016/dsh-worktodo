# 事故总账（L01–L12）—— 2026-10 这一批真实事故

> 用途：把 2026-10-18 / 10-19 这一串真实事故**逐条归档**，每条都回答同一个问题：**下次同样的事，是哪条断言/哪道闸门把它拦住？**
> 答不出来的事故 = 还没沉淀完；只能写"注意点"的，不算防线。
>
> 与规范的关系：本文件是**全文档案**；`docs/process/development-standard.md` v1.2 的 §6.3 是**索引**，正文条款用 §x.y 指回来。
> 记录规则：新增事故先在这里开一节（编号单调递增，不复用），再改规范、再加断言。**先有防线，才算闭环。**
>
> 隐私：本文件会被推到公开仓库，路径一律写 `~/…`，不写任何真实用户名 / 邮箱 / 机器名。

---

## 0. 一页总表

| 编号 | 症状（用户可见的） | 根因（技术） | 影响面 | 怎么发现的 | 修复 | 对应的自动防线（文件 / 断言） | 报告 |
|---|---|---|---|---|---|---|---|
| **L01** | 插件装上了，工具和面板都不出现 | 源码 import 了宿主平台包，清单里没声明 → 解析失败 | 本插件全不可用 | 用户报「插件启动失败」；工具调用报 `unknown tool`；stderr 是 `ERR_MODULE_NOT_FOUND` | 0.1.1 把三个平台包移进 `dependencies`（**这一修引出 L02**） | `verify-submission`：动态 import 集合必须等于 peer 声明；`smoke-host`：平台包全不可解析时 `apply` 不抛并输出 `RESILIENT_OK` | `../verification.md`「只声明 peerDependencies 是错的（0.1.1 修复）」节；`duplicate-platform-packages.md` §6 |
| **L02** | **DSH 桌面版双击即退出**，GUI 报启动失败（最严重） | `dependencies` 带 `@deepseek-ai/*` → profile（`nodeLinker=hoisted`）摊平出第二份旧版 core 包 → 0.2.1 兼容性闸门把 `tools` / `storage-domain` 两行 **disable** → 服务缺失 → 14 个插件等待 → required 的 `agent-loop` 失败；**被 disable 的行不进 pending 名单，日志看不出真因** | 桌面版完全起不来；所有装 0.2.5–0.2.7 的桌面用户 | 用户反馈 + 根因报告；直跑 host 拿 stderr 才看到 `disabling profile plugin row …`；profile 模拟复现「带 / 不带 dependencies 解析到两份不同版本」 | 0.2.8：三个平台包改 optional peer + `devDependencies`（测试夹具），`dependencies: {}`，全部函数内动态 import + 失败降级；升级指引先 `pnpm remove` 再装 | `verify-submission` 四条 + 反向自检 + `prepublishOnly`；`smoke-host` 平台包不可解析仍降级；§4.1 profile 模拟（**仍手工**） | `duplicate-platform-packages.md`；仓库外私有材料 `~/Downloads/dsh-cj-kf/桌面版启动失败_根因报告_20261018.md` |
| **L03** | 用户觉得「待办全没了」：一部分待办消失 | 官方 storage 打不开时**静默回退** JSON 文件，两处都写、谁也不报 → 数据分裂 | 数据「看起来丢了」（实际分成两份）；信任受损 | 真机核对两个存储文件：官方 store 6 条 + 回退文件 4 条，**id 交集 0**（只看结构与计数，不引用内容） | 单一真源 + 回退文件退役 + 按 id 并集合并（合并后 10 条、同 id 冲突 0、丢失 0）+ 降级原因进 `/health` 与 `/list` | `verify-store` F1 / 「两处都有数据且 id 不一致时明确报出来」/「domain open 失败不静默」；`smoke-client` 告警必须真渲染 | `audit-0.2.0.md` §F1、§真机存储核对 |
| **L04** | 坏文件被覆盖写；**已删待办复活** | 迁移缺三件事：**写前备份**（坏文件被当空列表写回）、**退役**（回退文件升级后仍被当数据源参与并集）、**墓碑**（并集合并无法区分「删除」与「只在另一侧存在」） | 数据丢失 / 复活；用户无法解释 | 审计复现（F2/F3）+ 升级后删一条再重开（第二次合并复活） | 写前备份（`.bak-`，上限 2 份）+ 原子写 + 合并事务回滚 + 退役（`.retired` 哨兵 / `.migrated-*`）+ 缺 `title` 记录保留 | `verify-store` F1/F2/F3/S4-4 + 「升级后删掉一条再重开不会复活」+「坏文件 + 一次写入先备份」+「缺 title 记录不被永久删除」 | `audit-0.2.0.md` §F2/F3；`stability-audit.md` §R1 |
| **L05** | 面板**黑屏 / 整块白**，什么都看不到 | 渲染期引用了**未定义的标识符**（本仓库是 `dayKey` 一类；token 面板是轴标签 `map` 少 `index`）→ `ReferenceError`；假渲染到不了该分支、也不真重渲染 | 面板不可用；用户以为插件坏了 | 用户报白屏 + 审计用一个「会真重渲染的迷你 React」补测 21 种载荷 | 错误边界（中文兜底 + `console.error` 完整堆栈，堆栈不进 DOM）+ 真渲染一次「有数据」的完整面板 + 反向验证 | `smoke-client`：「主面板与侧栏入口都注册在错误边界里（摘掉边界必红）」「边界捕获子组件抛错」「主面板首屏渲染不抛异常」 | `audit-0.2.0.md` 第 16 / 252 行；v1.2 §3.2.10 |
| **L06** | CI **假绿 / 假红**：本地绿 CI 红、发版即假红 | ①测试不先 build，测的是旧产物 ②夹具/断言写死版本号 ③ESM 静态 import 提升让 `process.env` 在模块求值时失效（`WORKTODO_NO_UPDATE_CHECK` 被读成 false）④锁文件冻结：本地解析参数只在命令行、CI 用 `--frozen-lockfile` + 本机从未验证过的 `npm install` | 门禁不可信；可能发出没测过的产物 | CI publish job 8/10 + 本机同版本 Node 复现 + ESM 提升最小实验 + 干净环境 `env -i` | `verify-all` 先 build 失败即红；版本从 `package.json` 派生 + 元测试；开关**调用时读** + 父进程 spawn 前注入 + 慢 registry 时序用例；`pnpm-workspace.yaml` 固化 `autoInstallPeers` / `scriptsPrependNodePath`；CI 只用 pnpm；双环境 + 显式退出码 | `verify-all` build 一步 + `process.exit(failed?1:0)`；`smoke-host` 版本元测试 / 时序用例；`smoke-client` 产物一致性；`verify-workflows` 锁文件安装顺序、禁 `npm install` | `ci-fix-0.2.6.md`；`version-fixture-refactor.md` |
| **L07** | Windows 点更新，**版本永远不换**（重启也没用） | 自带 pnpm 路径少一层 `<runtime-name>/dependencies` → 永远裸 `spawn('pnpm')` → Windows 的 `pnpm.cmd` 在无 shell 下 `ENOENT` → 版本永远不换；CLI 还可能退出码 0 但 `added 0` | Windows 用户自更新 100% 失效，且只表现为「版本没变」 | 对照官方启动器与隔壁插件；在真实 DSH 安装目录核对 `pnpm.mjs` 路径；真机只跑 `--version` | 执行器优先 `node + pnpm.mjs`（无 shell）、兜底 `pnpm.cmd + shell` 并逐字引号；`fileURLToPath` 路径解析；CLI 按 `app.asar` 定位；**落盘版本变了才算成功**；失败诊断可见 | `smoke-host`：「Windows 执行器：pnpm 必须走 node(pnpm.mjs) 或 pnpm.cmd+shell，绝不裸 spawn("pnpm")」「Windows 路径…」「Windows 假成功护栏：落盘版本没变绝不算升级成功」 | `windows-update-fix.md` |
| **L08** | ①**profile 的 `package.json` 消失**（最严重）②回滚漏 lockfile ③装不干净 / 杀不干净 ④启动即自动安装 ⑤改错 profile | ①win32 `unlink → rename` 回退二次失败会删掉目标 ②`createProfileJournal` 只快照 `package.json` ③超时只 `child.kill()`（孙进程存活）、dispose 不取消在飞任务、无跨进程锁（5 轮重载累积 5 个子进程）④`autoInstall` 默认 `true`，`apply` 返回约 27ms 后约 50ms 就起子进程 ⑤`profileDirFromModuleUrl` 取第一个匹配而非最后一个 | 写坏用户环境，可能直接起不来；孤儿进程继续写盘 | 0.2.7 稳定性审查：注入 `rename` 失败、真起孙进程、5 轮 `ps` 计数、假 pnpm 写 lockfile | 备份/恢复（绝不先删目标，二次失败从内存 / `.bak` 恢复）；lockfile 进同一事务；`detached` + `kill(-pid)` / `taskkill /T /F` + dispose 取消 + `open('wx')` 跨进程锁；默认改 `manual` + 启动检查延后 25s；路径取最后一段且必须有 `package.json` | `smoke-host`：`C1（严重）`二次 rename 失败目标仍在 / `B1/B3` 独立进程组 / `B3` 跨进程锁纯函数 / lockfile「绝不许被改写」/ `C6` 取最后一段 / 默认值用例 | `stability-0.2.7.md` §3.1–§3.3、§修复状态 1–5；`update-mode-settings.md` |
| **L09** | 已是最新，面板却红字报「检查更新失败：the operation was aborted due to timeout」 | 单次查询写死 8s（国内访问常见 10s+）+ 把 `AbortError` 原文拼进面板 + 失败映射成红色 `failed`（与安装失败共用徽标）+ 失败也写 `at` → 6 小时才重试 | 高频误报；用户以为插件坏了 | 用户反馈 + 用只监听回环的慢 registry 复现 | 20s 单次 + 3s 重试 1 次 + 25s 总预算；`check-failed` 温和态（muted、无按钮、无原始串）；指数退避 30→600s；成功后复位；`/list` 不阻塞 | `smoke-host`「20s / 重试 1 次 / 25s 预算 / 指数退避」「慢响应 → check-failed」「第二次成功」；`smoke-client`「温和态、不暴露 aborted/timeout」 | `update-check-timeout.md` |
| **L10** | 本地 `link:` 开发安装，点更新报红色「更新失败：反推不出 profile…」 | `resolveOwnProfileDir` 只认两种精确信号；`link:` 被 ESM realpath 成仓库路径 → `null` → 直接 `failed`（本地协议守卫在定位之后才执行） | 开发者被错误告知「插件坏了」；安全行为本身没错（零写盘） | 复审 + 用例；审查用户可见文案 | 新增 `unsupported`（`link-install` / `profile-undetermined`）：提前只读预判、`state` 映射回 `idle`、muted、无 action、零写盘零子进程；pnpm `.pnpm` 内部 symlink 不误判 | `smoke-host` link / symlink / 预判 / 反误判四条；`smoke-client`「unsupported 是温和态」；反向：映射回 failed 必红 | `update-unsupported-state.md` |
| **L11** | 点「安装」后**面板黑屏 / 页面消失** | 在**运行中的 profile 上跑 pnpm** → pnpm 重写整个 `node_modules` → 正在运行的宿主自己的模块被替换 / 裁剪 / 短暂消失 → 页面按新 / 半新依赖树加载失败 | 安装动作本身把应用弄崩（最伤信任） | 用户反馈 + 代码路径审查 + 对照官方 detached 安装器 | 下载 → 解包 → **detached 单文件安装器只原子替换本插件目录**（不跑 pnpm、不碰 lockfile）→ 失败逐字节回滚、日志尾部进诊断 → 提示重启 | `smoke-host`「独立安装器（核心）：零 pnpm/CLI、版本替换、其它文件逐字节不变」「detached 规格」「回滚」「幂等 + rename 退避」「dispose 后继续装完」；`verify-privacy` 放行 `tools/apply-update.mjs` | `detached-installer.md`；`update-mode-settings.md` §3 |
| **L12** | 流程/工程失误合集（详见 §L12） | ①元测试注释自撞 ②门禁 9/10 就 commit + tag + push（`\| tail` 吞了退出码）③同一文件被两个 agent 并发修改 ④隐私闸门误报 ⑤`files: ["docs"]` 把内部审查报告打进 npm 包 ⑥发布 workflow 直接 `npm publish` / `npm@latest` 位置错 / Allowed actions 不匹配 | 门禁结论不可信；内部材料外泄；发布不可逆且无人类闸门 | 各自见 §L12 | 见 §L12 | `smoke-host` 元测试；`verify-all` 显式退出码；`verify-privacy`；`verify-workflows`；§3.2.11–§3.2.14、§5.8 | 见 §L12 |

> 说明：L01 与 L02 是同一个坑的两面 —— **不声明 → 跑不起来；声明成硬依赖 → 宿主起不来**。正确位置只有一处：**optional peer + 函数内动态 import + 失败降级**。
> L08 的 ① 与 L11 是「写用户环境」这条路径上的两次不同事故：0.2.7 是**写得不对**（原子写丢文件），0.2.10 是**根本不该那么写**（在 live profile 跑包管理器）。

---

## 1. 逐条档案

### L01 插件装了跑不起来：平台包未声明

**症状（用户可见）**：插件装上了，但 `worktodo_*` 工具全都不存在，面板也不出现。用户自己的工具调用直接报 `unknown tool "worktodo_list"`。

**根因（技术）**：源码在运行期 `import` 了宿主提供的平台包（`@deepseek-ai/dsh-tools` / `dsh-storage-domain` / `dsh-home-paths`），但 manifest 里**一个都没声明**。宿主不替插件提供这些包（当时的 DSH 版本），于是模块解析失败：

```text
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'
  imported from <profile>/node_modules/dsh-worktodo/
```

**影响面**：只影响本插件（插件整个不激活，工具与面板全没）。当时还没意识到：如果平台包是在**模块顶层静态 import**，这种失败会发生在「加载插件模块」阶段，能把宿主一起拖下水（这条后来由 L02 证实）。

**怎么发现的**：用户报「插件启动失败」；复现时插件日志里是 `ERR_MODULE_NOT_FOUND`，且 profile 根目录的 `@deepseek-ai/` 是空的。

**修复**：0.1.1 把这三个包从 `peerDependencies` 移进 `dependencies` —— 在当时的 DSH 版本上这是**能装上**的修法，但它让 pnpm 把平台包装进 profile，**直接引出 L02**。0.2.8 才是正确形态。

**以后用什么自动拦住**

| 防线 | 具体断言 / 闸门 | 现状 |
|---|---|---|
| 声明与使用对齐 | `tools/verify-submission.mjs`：「平台包只能是可选 peer…」断言**运行期动态 import 的 bare 包集合 == `peerDependencies` 集合**；少声明一个就红 | ✅ 自动（`prepublishOnly` / CI） |
| 缺包也不连累宿主 | `tools/smoke-host.mjs`：「平台包全部不可解析：apply 不抛、只降级（工具/官方存储失败，宿主不受影响）」，成功后输出 `RESILIENT_OK` | ✅ 自动 |
| 错误形态正确 | `verify-submission` 断言「服务端源码顶层不得静态 import 非 `node:` 包」——缺包时是**降级**而不是模块求值失败 | ✅ 自动 |

**素材 / 报告**：`../verification.md`「❌→✅ 插件启动失败：只声明 `peerDependencies` 是错的（0.1.1 修复）」节（含 0.2.7 更正）；`../reviews/duplicate-platform-packages.md` §6。

---

### L02 DSH 桌面版启动失败（最严重）

**症状（用户可见）**：双击桌面版即退出，GUI 报启动失败。crash 日志只有下游症状：

```text
DesktopHostFatalError: dsh: startup failed: 1 required plugin did not activate

Plugins waiting for services (14):
  agent-loop (required)      tools
  workspace                  storageDomain
  session-controller         workspaceRegistry
  …
```

同机 `dsh web` 正常（web profile 没装社区插件），所以一开始被误判成「插件代码写错了」。

**根因（技术）**：五步链条，缺一步都不成立：

1. 插件 manifest 把三个 `@deepseek-ai/dsh-*` 写进 `dependencies`（L01 的修法）→ pnpm 把平台包**当普通依赖**装。
2. profile 的 `nodeLinker=hoisted` → 平台包被**摊平进 profile 顶层**，现场是 **7 个 `0.2.0-rc.2` 副本**。
3. 宿主解析顺序是「**profile 层先于 installation 层**」→ 从 profile 发出的 bare import 命中旧副本，宿主自带的那份被绕过。
4. DSH 0.2.1 新增**兼容性闸门**：旧副本被判与 `dsh 0.2.1-rc.2` 不兼容，`tools` / `storage-domain` **两行被 disable**：

```text
dsh: disabling profile plugin row "tools":
  Plugin @deepseek-ai/dsh-tools@0.2.0-rc.2 is incompatible with dsh 0.2.1-rc.2: …
```

5. **被 disable 的行不会出现在 pending 名单里** → 两个服务的提供者凭空消失，下游 14 个插件（含 required 的 `agent-loop`）只能干等。crash 日志里既没有 `Failed plugins` 段、也没有 disable 行，**从用户能拿到的日志看不出真因**。

**影响面**：桌面版**完全起不来**，是这批事故里唯一「让宿主整体不可用」的一条；所有装 0.2.5–0.2.7 的桌面用户都中招。`dsh web` 不受影响，所以问题被隐藏了一段时间。

**怎么发现的**：

- 用户主动反馈 + 自己写的根因报告（仓库外私有材料）；
- 关键一步是**绕过 Electron 直接跑 host**（`ELECTRON_RUN_AS_NODE=1` + host 入口 + profile 路径 + runtime 路径），拿到 stderr 里的 `disabling profile plugin row …` 与完整 `StartupError`；
- 再用真实 tarball 做 profile 模拟：带 `dependencies` 时插件解析到 **profile 内的 0.2.0-rc.2**，不带时解析到**宿主层 0.2.1-rc.2** —— 证明「多一份」会**真的**抢在宿主前面被解析到，不是理论推断。

**修复**（0.2.8）：三个平台包改 `peerDependencies` + `peerDependenciesMeta.optional: true`，同时进 `devDependencies`（只是测试夹具，不随发布包出去）；`dependencies` 清空；所有平台包 import 改成**函数内动态 import + catch**；升级指引先 `pnpm remove` 清掉旧副本再装。

**以后用什么自动拦住**

| 防线 | 具体断言 / 闸门 | 现状 |
|---|---|---|
| 清单形态 | `verify-submission`：`dependencies` 里出现任何 `@deepseek-ai/*` 即红；三个平台包必须是 optional peer | ✅ 自动 |
| import 形态 | `verify-submission`：顶层不得静态 import 非 `node:` 包；动态 import 集合 == peer 声明 | ✅ 自动 |
| 断言有牙齿 | `verify-submission`「反向自检：把平台包塞回 dependencies，上面的校验必须变红」（两个方向：塞回 `dependencies` / 从 peer 移走） | ✅ 自动 |
| 发布前必跑 | `package.json` 的 `prepublishOnly` + `pnpm test` + CI 三步都会跑 `verify-submission`；违反即发不出去 | ✅ 自动 |
| **装出来的形状** | §4.1 profile 模拟四条断言（profile 顶层只有本插件 / 插件目录内无 `node_modules/@deepseek-ai` / 平台包解析到宿主层 / 反向样本变红） | ⚠️ **手工 checklist** |
| 宿主升级回归 | §4.2 宿主升级模拟（旧平台包 → 新平台包，插件不动） | ⚠️ **手工** |
| 诊断自解释 | 插件侧：`/health` + `GET /<prefix>/update` 带降级原因；**宿主侧**「disable 行不进 pending」只能靠宿主修，或用 §7.5 的「直跑 host」排障法 | ❌ 宿主行为，插件拦不住 |

**残留风险（诚实写）**：静态断言证明不了「装出来只有一份」，所以 §4.1 的 profile 模拟是这条事故**唯一**能证明发布形态的验收动作；它一天不脚本化，就一天靠人记得（§3.3 已列为缺口）。

**素材 / 报告**：`../reviews/duplicate-platform-packages.md`（结论、证据链、profile 模拟结果、门禁与反向验证）；仓库外私有材料 `~/Downloads/dsh-cj-kf/桌面版启动失败_根因报告_20261018.md`（宿主侧视角、最小复现、5 条给宿主的建议）；规范 §2.7 / §4.1 / §4.2 / §6.1 行 2。

---

### L03 存储后端静默降级 → 待办数据分裂

**症状（用户可见）**：用户觉得「待办全没了」——打开面板只剩一部分，另一部分消失；过几天又反过来。

**根因（技术）**：官方 `storageDomain` 打不开时，插件**静默回退**到 JSON 文件后端；两个后端都继续写，谁也不报「现在有两份」。真机物证：

- `~/.dsh/storages/worktodo.json`：`unit.tables.todos` **6 条**（mtime 较早）；
- `~/.dsh/worktodo/todos.json`：**4 条**（mtime 较晚）；
- 两份 **id 交集 = 0**，字段集合也不同（domain 侧没有 `order` / `dueTime`）。

**影响面**：数据「看起来丢了」（实际是分裂成两份）；用户对插件的信任直接归零。这是本仓库第一次「数据安全」级事故。

**怎么发现的**：真机核对两个存储文件的条数、id 交集、字段集合与 mtime（**只看结构与计数，不引用任何待办内容**）；再用 `unionById` 按 id 取并集验证合并不丢数据。

**修复**：

- 单一真源：能开官方 domain 就以它为真源；
- 回退文件**退役**（升级成功后改名 `.migrated-<时间>`，并写 `.retired` 哨兵）；
- 降级必须可查：`store.kind` / `mismatch` 进 `/health` 与 `/list`，面板真的把告警渲染出来；
- 真机合并：按 id 并集 → **10 条，同 id 冲突 0，丢失 0**，两处 id 集合从此一致。

**以后用什么自动拦住**

| 防线 | 具体断言 / 闸门 | 现状 |
|---|---|---|
| 退役后不静默 | `tools/verify-store.mjs`：「F1：回退文件已退役 + 官方存储不可用 → 绝不静默返回空列表，且 `describe()` / 日志明确报错」 | ✅ 自动 |
| 分裂必须报出来 | `verify-store`：「两处都有数据且 id 不一致时明确报出来（不静默）」「`storageDomain` 可用但 `open` 失败：留在文件后端但明确报出不一致」 | ✅ 自动 |
| 告警要给人看 | `tools/smoke-client.mjs`：「数据不一致告警必须在面板上渲染出来，不能只躺在 `/health` 的 JSON 里」 | ✅ 自动 |
| 重挂载不降级 | `smoke-host`：「apply 两次（同一 storageDomain）不降级、不丢数据」 | ✅ 自动 |
| 合并正确性 | `verify-store`：`unionById` / 同 id 取 `updatedAt` 较新者 / 合并失败回滚 | ✅ 自动 |

**残留**：合并是**并集语义**、没有墓碑（见 L04）；如果退役文件被重新当成数据源，已删条目仍可能被拉回 —— 现在靠「哨兵 + 退役」阻止，而不是靠删除标记。

**素材 / 报告**：`../reviews/audit-0.2.0.md` §F1、§真机存储核对（6 条 / 4 条 / 交集 0）；`../reviews/stability-audit.md` §R1。

---

### L04 坏文件覆盖 / 已删待办复活：迁移缺「写前备份 + 退役 + 墓碑」

**症状（用户可见）**：①手动改坏（或半写）了存储文件后，**下一次任意写入把整份待办清空**；②明明删掉的待办，重启 / 升级后又回来了。

**根因（技术）**：迁移与写入路径缺三样东西：

- **写前备份**：`put()` 直接覆盖写；坏文件被判成「空列表」后，空列表被写回，原文件没了（F2，致命）。
- **退役**：升级到官方存储后，回退文件**没有被退役**，下一次以文件为 source 的合并把旧记录再拉回来（R1）。
- **墓碑**：合并是**并集**，没有「这条被删了」的删除标记 —— 无法区分「在另一侧不存在」与「被删除了」。`src/store.mjs` 的注释里明确写了这一点（「合并是并集（没有墓碑）」）。

**影响面**：数据丢失 / 复活；用户无法解释「我删了它怎么又回来了」。

**怎么发现的**：审计逐条复现（F2：坏文件 + 一次写入 = 整份清空；F3：缺 `title` 记录被永久删除）；复审又发现「升级后删一条再重开，第二次合并把它拉回来」。

**修复**：

- 写前备份（`.bak-<时间>`，同一轮复用、上限 2 份，防 `.bak` 无限增长）；
- 原子写 + 合并事务回滚（半截 domain 不留下）；
- 退役：先写 `.retired` 哨兵，再改名 `.migrated-<时间>`；即使改名失败，下次启动也知道「这个文件已不是真源」；
- 缺 `title` 的坏记录用占位标题读出并**保留**，不再被永久删除。

**以后用什么自动拦住**

| 防线 | 具体断言 / 闸门 | 现状 |
|---|---|---|
| 写前备份 | `verify-store`：「坏文件 + 一次写入：原文件先被改名备份，新文件只含新记录」 | ✅ 自动 |
| 坏记录不消失 | `verify-store`：「缺 title 的坏记录在下次写入后仍然在文件里（不再被永久删除）」 | ✅ 自动 |
| 合并回滚 | `verify-store`：「F2：合并中途失败必须回滚，不留下半截 domain（否则用户删掉的待办会复活）」 | ✅ 自动 |
| 退役失败不冒充成功 | `verify-store`：「F3：退役 rename 失败 → 显示失败原因（不是「已迁移并退役」），且该文件不再当合并源（不复活）」 | ✅ 自动 |
| 删除不复活 | `verify-store`：「升级后删掉一条再重开（第二次合并）不会复活」 | ✅ 自动 |
| 写失败不留残留 | `verify-store`：「S4-4：写失败（ENOSPC）不留 `*.tmp-<pid>` 残留，原始错误照原样抛出」 | ✅ 自动 |
| 反向验证 | 去掉备份 / 去掉退役，上述用例必须变红（报告里有逐条记录） | ✅ 人工做过一次 |

**残留**：**没有墓碑**。并集合并能保证不丢，但不能表达删除；目前靠「退役 + 哨兵」让旧文件退场，从而避免复活。若未来要支持「两个真源长期共存」，必须补删除标记（tombstone），否则 L04 会以另一种形态回来。

**素材 / 报告**：`../reviews/audit-0.2.0.md` §F2/F3；`../reviews/stability-audit.md` §R1；`src/store.mjs` 头部注释（退役与哨兵的设计理由）。

---

### L05 面板黑屏：客户端用了未定义的标识符

**症状（用户可见）**：面板整块白 / 黑，没有任何报错提示；侧栏入口点进去也一样。

**根因（技术）**：渲染期抛 `ReferenceError` —— 客户端代码引用了**未定义的标识符**：

- 本仓库是 `dayKey` 一类（「上次 `dayKey` 白屏事故」）；
- 同源 token 面板是轴标签 `map` 少传 `index`。

原来的客户端烟测用的是一个**不真重渲染**的 React 替身：`useState` 的 setter 是空函数，所以「loading → 数据落地 → 用真数据渲染」这条**正是事故所在的路径** 0 覆盖，测试全绿。

**影响面**：面板不可用；错误被 React 的 slot 边界或宿主吞掉时，用户只看到一块白，没有任何可执行提示。

**怎么发现的**：用户报白屏；审计时另写了一个**会真重渲染的迷你 React**，跑 21 种载荷（数据落地、畸形数据、投影抛错、网络失败），确认不再抛；同时把「渲染期抛错」变成一条可断言的行为。

**修复**：

- 面板与侧栏入口都套错误边界：中文兜底 + `console.error` 留完整堆栈，**堆栈绝不进 DOM**；
- 真渲染一次「有数据」的完整面板（函数组件真调用、类组件真 `render`、边界按 React 语义走）；
- 反向验证：摘掉边界 / 改坏渲染分支，测试必须红。

**以后用什么自动拦住**

| 防线 | 具体断言 / 闸门 | 现状 |
|---|---|---|
| 真渲染 | `tools/smoke-client.mjs`：「主面板首屏渲染不抛异常」「渲染后确实去拉了 `/worktodo/list`」 | ✅ 自动（迷你渲染器） |
| 错误边界 | `smoke-client`：「主面板与侧栏入口都注册在错误边界里（摘掉边界这条必红）」「边界捕获子组件抛错：中文兜底 + `error.message` 摘要，且堆栈绝不进 DOM」 | ✅ 自动 |
| 只走文本节点 | `smoke-client`：「错误信息只走文本子节点：bundle 里不存在 `innerHTML`」 | ✅ 自动 |
| 反向验证 | 摘掉边界 / 改坏渲染分支 → 必须红（§3.2.2 的 mutation check） | ✅ 流程要求 |

**缺口**：仍是迷你渲染器，**没有真 React + DOM、没有 `setState` 重渲染**（§3.3 已写死验收标准：改坏 `setState` 分支该测试必须 FAIL）。L05 的防线是半自动。

**素材 / 报告**：`../reviews/audit-0.2.0.md` 第 16 行（21 种载荷）、第 252 行（`dayKey` 白屏路径的覆盖缺口）；规范 §3.2.10、§3.3。

---

### L06 CI 假绿 / 假红

**症状（用户可见）**：对用户不直接可见，但后果可见 —— 发出去的版本其实没被测过；或者代码没问题 CI 却红。

**根因（技术）**：四条独立原因，被同一轮 CI 暴露：

1. **测试不先 build**：`smoke-client` 读的是构建产物 `lib/client.js`，但 `verify-all` 直接跑测试 → 「改了 `src/client` 忘了 build」这个最危险的状态在测试里是绿的（测的是上一版代码）。更早还有一次 `esbuild` 装在被系统清理的临时目录，构建**静默失败**，烟测加载旧产物，全绿。
2. **测试写死版本号**：升级 0.2.7 时批量替换 `'0.2.7'` → 没改全（5 处漏改 + 1 处把生成脚本改坏），「模拟升级」的新版本恰好等于真实版本，断言与代码对不上，**发版即假红**。
3. **ESM 静态 import 提升**：测试文件顶部写 `process.env.WORKTODO_NO_UPDATE_CHECK = '1'`，下一行才是静态 `import` —— ESM 会先求值被 import 的模块，于是 `lib/index.js` 顶层读到的仍是 `undefined`（`UPDATE_CHECK_OFF=false`），`apply()` 真的去 `fetch` registry；检查在飞时 `phase='checking'` 又被当成「安装进行中」，`link:` / 自动更新 / 下载护栏全部被静默绕过。所谓「本地全绿」只是 registry 查询恰好在测试发请求前完成的**时序运气**。
4. **锁文件冻结 / 解析路径不一致**：本地一直用命令行参数 `--config.auto-install-peers=false` 装依赖，该设置**没写进配置文件**；CI 上一条普通的 `pnpm install --frozen-lockfile` 会得到不同解析结果、甚至直接失败。同时 CI 原本用 `npm install`，而本机从没走过这条解析路径（`@deepseek-ai/dsh-tools` 带 11 个 peer，npm 默认自动装 peer）。

**影响面**：门禁不可信 —— 假绿会放过没测过的产物，假红会让人开始忽略门禁（比假绿更危险）。

**怎么发现的**：

- CI 日志：publish job 的失败汇总写着「8/10 个步骤通过」，失败的是宿主管线与契约两个 suite；
- 用与 CI 同版本的 Node 22.23.3 与本机 Node 24.21.0 分别复现，失败集合完全一致 → 排除 Node 版本差异；
- 写了一个**独立的最小 ESM 提升实验**，证明「imported module saw: undefined / main module later sees: 1」；
- 干净环境 `env -i HOME=… CI=true` 复现，证明不是本机环境污染。

**修复**（原则：测试假设错了改测试，代码行为不对改代码，**没有放宽任何断言**）：

- `verify-all` 第一步先 build，失败即整体判红；`smoke-client` 增加「bundle 是这个 src 的产物（改了 src 忘了 build 必须红）」；
- 模拟版本全部从 `package.json` 派生（`PKG_VERSION` / `FAKE_NEXT_VERSION`），加元测试扫全文（含注释）；
- `UPDATE_CHECK_OFF` 常量 → `updateCheckOff()` 函数（**调用时读**）；`verify-all` 在 spawn 子进程**之前**把 `WORKTODO_NO_UPDATE_CHECK=1` 放进环境，让每个 suite 从第一行就继承；
- 新增「启动检查在飞时点升级不能被『已在运行』吞掉，且检查晚到不许冲掉结论」的时序用例（只监听回环的 400ms 慢 registry）；
- `pnpm-workspace.yaml` 固化 `autoInstallPeers: false` 与 `scriptsPrependNodePath: true`；CI 切到 pnpm，禁 `npm install`。

**以后用什么自动拦住**

| 防线 | 具体断言 / 闸门 | 现状 |
|---|---|---|
| 先 build | `tools/verify-all.mjs` 第一行就是 build，非 0 直接 `failed = true`；最后 `process.exit(failed ? 1 : 0)` | ✅ 自动 |
| 产物新鲜度 | `smoke-client`「bundle 是这个 src 的产物（改了 src 忘了 build 必须红）」 | ✅ 自动 |
| 版本派生 | `smoke-host` 元测试「模拟版本全部从 `package.json` 派生，源码里没有当前版本号字面量」，命中报行号 | ✅ 自动 |
| 开关调用时读 | `smoke-host`「启动检查在飞时点升级…」时序用例；`verify-all` 父进程注入 | ⚠️ 半自动（无法静态证明所有开关都调用时读） |
| 锁文件 / CI 一致 | `verify-workflows`：`pnpm install --frozen-lockfile` → `pnpm test` → `pnpm run build` 顺序；禁 `npm install` | ✅ 自动（workflow 文本层） |
| 双环境 + 退出码 | §3.2.6 / §4 第 1 项：本机 + `env -i` 两套都 10/10 且 `echo exit=$?` = 0 | ⚠️ **靠人按清单执行** |

**缺口**：「环境变量在调用时读」没有静态检查；双环境没有脚本（属 §3.3 缺口）。

**素材 / 报告**：`../reviews/ci-fix-0.2.6.md`（完整复现与修复、反向验证、两套环境结果）；`../reviews/version-fixture-refactor.md`（夹具集中化 + 元测试）。

---

### L07 Windows 自更新无效：版本永远不换

**症状（用户可见）**：Windows 上点「更新」，进度走完、重启，版本号还是旧的；再点还是一样。

**根因（技术）**：自带 pnpm 的路径少了一层 `<runtime-name>/dependencies`：

```text
找：<resources>/runtime/pnpm/bin/pnpm.mjs                      ← 不存在
实：<resources>/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs
```

于是永远回退到 PATH 上的裸 `spawn('pnpm')`。Windows 上 `pnpm` 实际是 `pnpm.cmd`，而 Node 在 `shell: false` 下用 `CreateProcess`，**不会按 PATHEXT 解析 `.cmd`** → 直接 `ENOENT` / `spawnFailed`。pnpm 两步全跳过；CLI 那一步若 no-op（真机出现过退出码 0 但 `added 0`），就没有任何一步能改 `node_modules` —— 版本当然一直是旧版。

**影响面**：Windows 用户自更新 100% 失效；而且失败只表现为「版本没变」，看不出是命令根本没起来。

**怎么发现的**：先看官方桌面版与隔壁插件怎么定位 CLI / pnpm（官方用 `ELECTRON_RUN_AS_NODE=1` + `--expose-internals` + asar 内 `cli.js`；隔壁插件检查 `app.asar` **归档文件**是否存在，而不是 asar 内部路径）；再在真实 DSH 安装目录里核对 `pnpm.mjs` 实际路径，并用真机二进制只跑 `--version` 验证执行器可执行（`11.28.5`、退出码 0、无第二个 GUI 进程）。

**修复**：

- 执行器优先级：**同进程 node + 自带 `pnpm.mjs`**（无 shell、`windowsHide`）→ 找不到才 `pnpm.cmd` + `shell: true`（每个参数逐字加引号）→ **绝不裸 `spawn('pnpm')`**；
- CLI 定位对齐官方：`DSH_DESKTOP_NODE_EXECUTABLE` 优先，检查 `app.asar` 归档存在即用，兼容 `app` / `app.asar.unpacked`；
- 路径解析改 `fileURLToPath`，同时认 `/` 与 `\`、盘符大小写、`%20`、UNC；
- **「成功」只认落盘版本变了**，不认退出码；失败诊断带 `step` / `command` / `argv` / `exitCode` / `target` / `installedVersion` / `logTail`，面板可看。

**以后用什么自动拦住**

| 防线 | 具体断言 / 闸门 | 现状 |
|---|---|---|
| 执行器形状 | `smoke-host`：「Windows 执行器：pnpm 必须走 node(pnpm.mjs) 或 pnpm.cmd+shell，绝不裸 spawn("pnpm")；CLI 拼 `app.asar\...\cli.js`」（`WORKTODO_PLATFORM=win32` 模拟） | ✅ 自动（模拟） |
| 路径形状 | `smoke-host`：「Windows 路径：`file:///C:/...` → `C:\...\profiles\desktop`（反斜杠 / 盘符大小写 / `%20` / UNC 都认）」 | ✅ 自动（模拟） |
| 假成功 | `smoke-host`：「Windows 假成功护栏：落盘版本没变（含 null）绝不算升级成功；变了才算」 | ✅ 自动 |
| 原子写三态 | `smoke-host`：「Windows 原子写：rename 覆盖失败 → 先删目标再 rename；仍失败 → 明确报错且不留半文件」 | ✅ 自动（注入） |
| 真机 | 无 | ❌ **没有真机 Windows** |

**重要说明**：0.2.10 起安装路径**不再调用 pnpm / CLI**（见 L11），上面的执行器断言保留为「历史路径 / 导出测试缝」的护栏；只要这些函数还在、还被导出，就不许退回裸 `spawn('pnpm')`。

**素材 / 报告**：`../reviews/windows-update-fix.md`（根因候选逐条判断、修法、测试与反向验证、真机 Windows 限制）。

---

### L08 自更新写坏 / 杀不干净（五条）

**症状（用户可见）**：

1. 一次失败的自动升级 + Windows 上两次 `rename` 失败 → **profile 的 `package.json` 消失**（最严重，可能直接起不来）；
2. 回滚看起来成功了，但 `pnpm-lock.yaml` 留在新规格 → 清单 / 锁文件 / `node_modules` 三方不一致；
3. 面板已报失败、事务已回滚，后台的 pnpm 还在写；插件卸载后仍会起子进程改 profile；连续 5 轮重载累积 5 个子进程；
4. 用户没点任何东西，启动后约 50ms 就自动开始安装；
5. 嵌套 `node_modules` 布局下，profile 路径推导指到了外层目录（改错 profile）。

**根因（技术）**：

1. `writeFileAtomicSync` 的 win32 回退是 `unlink(target)` → `rename(tmp, target)`：第二次 `rename` 仍失败时，**目标已经被删了**，临时文件也在外层 `catch` 里被删 —— 磁盘上既没有旧文件也没有新文件。这条路径正好用在 `journal.rollback()` 上，目标就是 profile 的 `package.json`。
2. `createProfileJournal` 只快照 / 还原 `package.json`，没有 `pnpm-lock.yaml`。
3. 超时只 `child.kill('SIGKILL')` 杀直接子进程（孙进程被 reparent 后继续写）；整个更新子系统没有 `ctx.effect` 清理与 `AbortController`，dispose 不取消在飞任务；只有实例内 `phase` 守卫，**没有跨进程锁**。
4. `autoInstall` 默认 `true`；`apply()` 末尾 `void refreshUpdate()`，查到新版后自动下载 + 安装；实测 `apply` 返回 26.9ms、约 50ms 后捕获到安装子进程。
5. 0.2.6 用 `lastIndexOf`（最后一个匹配），0.2.7 改成 `exec`（第一个匹配）；嵌套布局下会切到外层。

**影响面**：写坏用户环境（①最严重）；孤儿进程在用户不知情时改 profile；「启动即安装」把安装风暴带进宿主启动路径。

**怎么发现的**：0.2.7 稳定性审查逐条实跑 —— 在 macOS 上注入 win32 的 `rename`（真实 fs 语义）、真起一个派生孙进程并测心跳、5 轮 `apply → 起子进程 → dispose` 用 `ps` 精确计数、假 pnpm 同时写 `package.json` + `pnpm-lock.yaml` 但不动 `node_modules`。

**修复**：

- **原子写**：首选直接 `rename`；只有明确的可重试错误才进回退，且**先把目标读进内存并落一份同目录 `.bak`**，再删、再 rename；二次失败从内存 / `.bak` 恢复（用与 rename 无关的 `open('w')` + 写循环 + `fsync`），恢复不了就**保留 `.bak` 并把路径写进错误**；外层不再无条件删临时文件。
- **同一事务**：journal 同时快照 `package.json` + `pnpm-lock.yaml`，逐字节还原；原本不存在而被 pnpm 新建的，回滚时删掉。
- **杀进程树**：POSIX `detached: true` + `process.kill(-pid, 'SIGKILL')`；Windows `taskkill /pid <pid> /T /F`；超时后连 stdout / stderr 一起 `destroy`。
- **dispose 取消**：实例级 `lifecycle` 登记在飞子进程 / 定时器 / `AbortController` / 锁；卸载时置 `disposed`、abort、杀树、放锁；所有异步收口先看 `disposed`，卸载后**连回滚也不写**（状态记 `skipped: 'disposed'`）。
- **跨进程锁**：`$DSH_HOME/worktodo/update.lock`，`open(..., 'wx')` 原子创建；拿不到即 `busy`，不重试；stale 只回收一次；只删自己 token 的锁。
- **默认保守**：`autoInstall` 默认 `false`，启动检查延后 25s（可取消、`unref`）；0.2.10 起折叠成三档 `off` / `manual`（默认）/ `auto`（见 §2.15）。
- **路径推导**：`matchAll` 取**最后一个** `node_modules/<包名>` 段，切出的目录必须有 `package.json`，否则 `null`（零写盘失败）。

**以后用什么自动拦住**

| 防线 | 具体断言 / 闸门 | 现状 |
|---|---|---|
| 原子写不丢文件 | `smoke-host`：「C1（严重）：win32 二次 rename 失败 → 目标仍存在且内容等于原值（从备份恢复，绝不消失）」；反向：把备份改成 `null` 必须红 | ✅ 自动（注入） |
| 进程树 | `smoke-host`：「B1/B3：killProcessTree 在 POSIX 用独立进程组（负 pid），不会退回只杀直接子进程」；反向：改回 `child.kill` 必须红 | ✅ 自动 |
| dispose 零写盘 | `smoke-host`：「detached：宿主 dispose（插件卸载）后，已在跑的安装器仍然把新版本装完」+ 安装路径零 pnpm | ✅ 自动 |
| 跨进程锁 | `smoke-host`：「B3：跨进程锁纯函数 —— 第二次 busy、>10min 可回收、release 只删自己的锁」 | ✅ 自动 |
| lockfile 不被写 | `smoke-host` 独立安装器核心用例：「lockfile 绝不许被改写」 | ✅ 自动 |
| 默认最保守 | `smoke-host`：「A1/A2（高）：默认更新方式 = manual —— 只检查，不下载、不安装、不写盘」「A1：启动检查默认延后 20–30s」；反向：改回默认 true 必红 | ✅ 自动 |
| 路径推导 | `smoke-host`：「C6：嵌套 `node_modules/dsh-worktodo` 取最后一段 —— 推不出就 null，绝不指到外层 profile」 | ✅ 自动 |
| **C2 事务回滚** | 0.2.7 有过「`package.json` + `pnpm-lock.yaml` 都逐字节还原」的用例；0.2.10 安装路径不再写这两个文件，该用例已随旧路径退场 | ⚠️ **用例已删**；若重新引入写 profile 的路径，必须恢复 |

**残留**：没有真机 Windows（`MoveFileEx` / `taskkill /T /F` / 杀软占用只做了形状测试 + 注入）；dispose 若发生在 pnpm 已经改写 profile **之后**，本实现选择「不再写盘（不回滚）」，那次运行可能留下被改写的规格（已记 `skipped: 'disposed'`）。

**素材 / 报告**：`../reviews/stability-0.2.7.md` §3.1–§3.3 与「修复状态 1–5」「6」；`../reviews/update-mode-settings.md`（三档默认值）。

---

### L09 检查更新超时误报「失败」

**症状（用户可见）**：已经是最新版，面板却挂着红色徽标：**「检查更新失败：the operation was aborted due to timeout」**，还带一个「重试」。用户以为插件坏了。

**根因（技术）**：

- `refreshUpdate()` 只发一次 `fetch`，超时写死 `AbortSignal.timeout(8000)`；国内访问 `registry.npmjs.org` 常见 10s+，一次抖动必然超时；
- 失败被映射成 `phase: 'failed'` + `failedOperation: 'check'`，与**下载 / 安装失败**共用红色徽标；
- 原始错误串被直接拼进面板文案；
- 失败时 `updateState.at` 也被写成当前时间，而自动检查只看 6 小时 TTL → 失败后要等 6 小时才重试。

**影响面**：高频误报；用户对「更新」这个功能的信任被消耗；明明只是没查到版本。

**怎么发现的**：用户反馈后，用只监听回环的假 registry（25s 才回）复现；断言**真的重试了**（假 registry 收到 2 次请求）。

**修复**：

- 单次 20s → 失败等 3s 用**新的 `AbortController`** 重试 1 次 → 整次检查预算 25s（最坏约 25s，不是 20+3+20）；
- 失败改为温和的 `check-failed`（`state` 映射回 `idle`），`checkError {reason, at, retriable, attempt, nextRetryAt, retryInMs}`，**原始异常只进 `diagnostics`**；
- 面板：muted 色、无重试按钮、不显示原始串；中英文案「暂时无法检查更新，稍后自动重试」/「Couldn't check for updates right now, will retry automatically」；
- 指数退避 30s → 60s → 120s … 上限 10 分钟，由下一轮 `/list` 轮询触发；成功即复位；
- `/list` 仍只 `void refreshUpdate()`，检查全程异步（慢 registry 在飞时首屏实测 0ms，断言 <100ms）。

**以后用什么自动拦住**

| 防线 | 具体断言 / 闸门 | 现状 |
|---|---|---|
| 超时 / 重试 / 预算 | `smoke-host`：「自升级：检查更新 20s / 重试 1 次 / 25s 预算 / 指数退避 30→60→120…上限 10 分钟」 | ✅ 自动 |
| 慢 registry 不阻塞 | `smoke-host`：「registry 慢响应超时 → check-failed 温和态（不是 failed），/list 首屏 <100ms、hasUpdate=false」 | ✅ 自动 |
| 真的重试 | 同一用例断言假 registry 收到 2 次请求；「第二次成功 → 退避后重试拿到版本，`checkError` 复位」 | ✅ 自动 |
| 面板不吓人 | `smoke-client`：「检查更新失败是温和态（muted），不亮红、不暴露 aborted / timeout 原始错误」；反向：改回红色 `failureBadge` 必红 | ✅ 自动 |

**残留**：真实 20s 墙钟没有在测试里真等（用测试缝压到 300ms 走同一路径）；HTTP 4xx 也会重试一次（确定性错误多打一次请求，代价小）。

**素材 / 报告**：`../reviews/update-check-timeout.md`（根因、修法、反向验证、门禁结果）。

---

### L10 `link:` 安装报「更新失败」：把预期内的不适用当成错误

**症状（用户可见）**：本地开发用 `link:` 装插件，点「安装 / 更新」得到红色**「更新失败：反推不出本实例自己所在的 profile 目录…」**，并给一个「重试」。开发者以为插件坏了。

**根因（技术）**：`resolveOwnProfileDir()` 只有两条精确信号 —— 显式 `WORKTODO_PROFILE_DIR`，或从 `import.meta.url` 反推 `.../profiles/<name>/node_modules/dsh-worktodo/lib/index.js`。`link:` 安装时 Node 的 ESM 默认把软链接解析成**仓库真实路径**，路径里没有 `node_modules/dsh-worktodo` 段 → 返回 `null` → `startInstall()` 直接以 `profile-not-found` 收口成 `failed`。更关键的是：原来的 `isLocalSpec()` / `linked` 守卫在**定位 profile 之后**才执行，所以 link 安装往往根本走不到那条守卫。

安全行为本身一直是对的：没有猜 `$DSH_HOME/profiles/*`、没有写 profile、没有起子进程。错的只是**状态分类与文案**。

**影响面**：开发者（以及用 symlink / 非标准布局的用户）被错误告知「插件坏了」；对比「什么都不做、只提示原因」的正确形态，这是纯粹的信誉损失。

**怎么发现的**：复审状态机时发现「`failed` 里混进了预期内的不适用」；审查用户可见文案；补用例时确认「判定发生在下载 / 锁 / 子进程之前」才是真正的零写盘。

**修复**：

- 新增 `phase: 'unsupported'` + 稳定种类 `updateUnsupported: 'link-install' | 'profile-undetermined'`；
- `state` 映射回 `idle`，`failure` / `failedOperation` 都是 `null`（**不是失败**）；`hasUpdate` 语义不变；
- 提前只读预判 `detectUnsupportedInstall()`，在**下载 / 锁 / 子进程之前**调用：profile 清单里本包依赖是 `link:` / `file:` / `workspace:`（任一段位），或 `node_modules/<包>` 是 symlink 且 `realpath` 落在 profile 自己的 `node_modules` **之外**；
- 刻意排除 pnpm 的正常安装（`.pnpm` 内部 symlink 目标在 profile 内，不误判）；
- 面板：muted、无 action、不显示原始异常串；技术细节只进 `diagnostics`。

**以后用什么自动拦住**

| 防线 | 具体断言 / 闸门 | 现状 |
|---|---|---|
| link / symlink 判定 | `smoke-host`：「自升级：`link:` 安装 → unsupported/link-install；别下载/别安装、零写盘、零子进程」「node_modules/dsh-worktodo 指向仓库的 symlink → unsupported」 | ✅ 自动 |
| 预判齐全 | `smoke-host`：「预判：`link:` / `file:` / `workspace:` 都算本地链接安装；pnpm 的 `.pnpm` 内部 symlink 不算（不误伤正常安装）」 | ✅ 自动 |
| 推不出 profile | `smoke-host`：「A5：反推不出本实例 profile → unsupported/profile-undetermined，零写盘、绝不猜别的 profile」 | ✅ 自动 |
| 面板温和 | `smoke-client`：「unsupported 是温和态（muted），两种文案中英齐全、不亮红、不给重试、不暴露技术串」；反向：映射回 `failed` 必红 | ✅ 自动 |

**残留**：真实 `link:` 且没有 `WORKTODO_PROFILE_DIR` 时，模块 URL 已被 realpath 成仓库路径，只能报 `profile-undetermined`（文案不是「本地链接安装」）；pnpm 把 virtual store 配到 profile 之外时，正常安装会被判 `link-install`（安全方向：不写盘、不升级，但用户看不到自更新）。

**素材 / 报告**：`../reviews/update-unsupported-state.md`（现状、分类、零写盘证据、反向验证）。

---

### L11 点安装后黑屏：在运行中的 profile 上跑 pnpm

**症状（用户可见）**：点「安装」后面板黑屏 / 页面消失，应用像被关掉。

**根因（技术）**：不是「pnpm 太慢」，而是**在应用运行中改动了 live profile 的依赖树**：

1. 旧安装路径在宿主进程里执行 `dsh plugin … add` / `pnpm update` / `pnpm add`；
2. pnpm 会重写整个 `<profile>/node_modules`（以及 `package.json` / `pnpm-lock.yaml`）；
3. 正在运行的 DSH 自己也在同一个 `node_modules` 里解析模块；重写过程中，正在被加载 / 被引用的模块文件被替换、裁剪或短暂消失；
4. 页面随后按新 / 半新依赖树加载失败 → 黑屏。

所以「把 pnpm 放到后台跑」不能解决：**只要还在 live profile 的依赖树上跑包管理器，窗口期就存在**。

**影响面**：安装动作本身把应用弄崩 —— 这是最伤信任的一类 bug（用户只是想升级一下）。

**怎么发现的**：用户反馈 + 代码路径审查（确认 pnpm 写的是整个 `node_modules`）+ 对照官方桌面版的安装形态（官方用独立安装器 / `install_bundle`，不在 live 进程里跑包管理器）。

**修复**（0.2.10）：

- **下载**：沿用原有护栏（流式、32 MiB 上限、sha1、落盘回读校验、失败零残留），暂存目录在插件自己的 `$DSH_HOME/<plugin>/updates/`；
- **解包**：自写 gzip + ustar（只 import `node:`），只接受 `package/` 前缀的普通文件 / 目录，**拒绝绝对路径、`..`、符号链接、硬链接**；解包后再校验 `name` / `version`；解包总量 128 MiB 上限（防压缩炸弹）；失败把 tarball / 清单 / 解包目录一起清掉；
- **detached 安装器**：宿主以 `spawn(nodeExec, [applyUpdatePath, …], { detached: true, stdio: 'ignore', windowsHide: true })` + `unref()` 拉起**单文件** `tools/apply-update.mjs`；它只做一件事 —— 替换 `<profile>/node_modules/<包名>` 这一个目录：校验 staged → `realpath(target)` → 幂等 → copy 新目录到同级 `.worktodo-new-<ts>` → 旧目录 rename 成 `.worktodo-backup-<ts>` → 新目录 rename 成目标 → 读 `package.json` 校验落盘版本；
- **失败回滚**：从备份 rename 回目标，恢复成功再留一份备份供人工回退；结果写 `apply-result.json`，并把 `lastApply` 合并进 `update-state.json`；
- **日志**：`apply-<YYYYMMDD-HHmmss-SSS>.log`，时间戳 + 每一步 + 失败堆栈；宿主把日志尾部（≤40 行）放进 `diagnostics.logTail`；
- **不阻塞**：`startInstall` 立即返回 `installing`（实测 <10ms，断言 **<500ms**），后台轮询 `apply-result.json`，上限 120s；
- **提示重启**：装好停在 `installed` + `restartRequired:true`，面板显示「已更新到 vX，请重启 DSH 生效」，**从不自动重启**。

**为什么这样不会再黑屏**：安装路径不再执行 pnpm / npm / CLI（测试用**绊线 bin** 钉死调用数为 0）；不改 `package.json`、不改 `pnpm-lock.yaml`、不重写 `node_modules`；只替换本插件自己的一个目录；正在运行的宿主模块仍在内存里，替换磁盘文件不会让当前页面重新解析模块；即使失败，旧目录还在备份里。

**以后用什么自动拦住**

| 防线 | 具体断言 / 闸门 | 现状 |
|---|---|---|
| 零包管理器 | `smoke-host`：「独立安装器（核心）：下载→解包→detached 安装；**零 pnpm/CLI**、版本替换、其它文件逐字节不变」（绊线 `pnpm` / `npm` / `pnpm.cmd` / `npm.cmd` / 假 CLI 全为 0） | ✅ 自动 |
| 只碰自己的目录 | 同一用例：`snapshotOutsideOwnPackage(profile)` 逐字节比对；「profile 除本包目录外必须逐字节不变」「lockfile 绝不许被改写」 | ✅ 自动 |
| detached 证据 | `smoke-host`：「独立安装器：spawn 规格必须是 detached + stdio ignore + unref；结果/日志/超时路径纯函数」；「注入 700ms 延迟时，宿主 POST 安装 <500ms 就返回 installing」 | ✅ 自动 |
| 失败回滚 | `smoke-host`：「rename 目标失败 → 从备份回滚旧版本、failed + 原因、备份可用、日志尾部进 diagnostics」；反向：回滚分支改恒不执行必红 | ✅ 自动 |
| 幂等 / Windows 退避 | `smoke-host`：「幂等（已达标直接成功）+ Windows rename 占用退避重试」 | ✅ 自动（注入） |
| 宿主卸载不影响 | `smoke-host`：「detached：宿主 dispose（插件卸载）后，已在跑的安装器仍然把新版本装完」 | ✅ 自动 |
| 发布包带安装器 | `verify-privacy`：「发布包里 `tools/` 只允许运行时安装器 `tools/apply-update.mjs`」 | ✅ 自动 |

**缺口**：没有真机 Windows 的目录占用实测；没有在真实 profile 里点过真实安装（按约束只用 `/tmp` 假 profile + 本地假 tarball）；备份会多占一份包目录的磁盘空间。

**素材 / 报告**：`../reviews/detached-installer.md`（黑屏根因、新架构、安全边界、测试与反向验证）；`../reviews/update-mode-settings.md` §3（面板重启提示）。

---

### L12 流程 / 工程失误（六条）

这一条不是单个 bug，而是六次「让门禁或发布失去可信度」的流程失误。共同点：**都不是代码写错，而是「怎么验证、怎么发布、谁在写」出了错。**

#### L12-① 元测试自身误伤：注释里出现版本字面量

| 项 | 内容 |
|---|---|
| 症状 | 发 0.2.10 时门禁红，报「源码里出现了当前版本 `0.2.10` 的字面量」，但代码与断言都没问题 |
| 根因 | 元测试**扫全文（含注释）**是刻意设计（只盯已知位置必然漏）；加元测试时（`version-fixture-refactor`）在注释里写了「避免将来 `0.2.10` 被 `0.2.1` 误伤」——把版本字面量又写回了注释；当前版本升到 `0.2.10` 后，这条注释自己命中 |
| 影响面 | 发版卡在门禁；容易让人误以为「元测试太严」而放宽它 |
| 怎么发现 | 发版时 `verify-all` 红；元测试报出**具体行号**，一眼看到是注释 |
| 修复 | 注释改成「补丁号进位 / 前缀相同的历史版本」，**不再写数字**（commit `bb8e0c8`） |
| 自动防线 | `smoke-host` 元测试「模拟版本全部从 `package.json` 派生，源码里没有当前版本号字面量」：扫全文 + 边界正则 `(?<![\d.])<ver>(?![\d.])` + 报行号 |
| 缺口 | 没有一条「造 `0.2.1` / `0.2.10` 样本，证明前缀不互相误伤、注释行也会被扫」的**边界自测** —— v1.2 §3.2.12 已要求补 |

#### L12-② 门禁 9/10 就 commit + tag + push

| 项 | 内容 |
|---|---|
| 症状 | tag 指向的那次提交，门禁其实是 **9/10**；事后无法用「门禁绿」自证 |
| 根因 | `node tools/verify-all.mjs \| tail` 的 `$?` 是 **`tail` 的**，`verify-all` 的退出码被整段吞掉；基线本来就红（隐私闸门误报 / 夹具漏改），于是「看到最后几行是绿的」就提交了 |
| 影响面 | 发布物对应未全绿的 commit；开了「9/10 也能发」的坏先例 |
| 怎么发现 | 单独跑 `verify-all` 并显式 `echo exit=$?` 才暴露 9/10（`duplicate-platform-packages` 的基线、`version-fixture-refactor` 的 9/10 都是这样抓到的） |
| 修复 | 先修红（隐私规则边界 / 夹具派生）→ 双环境都 10/10 且 `EXIT=0` → 才提交 / tag |
| 自动防线 | `verify-all` 自己以 `process.exit(failed ? 1 : 0)` 正确退出；§3.2.6 与 v1.2 §3.2.11 把「显式退出码 / `\| tail` 不算证据 / 红绝不提交」写成铁律 |
| 缺口 | 「先绿再 commit」没有机械钩子（可加 pre-push hook 或分支保护）；当前靠人 |

#### L12-③ 同一个文件被两个 agent 并发修改

| 项 | 内容 |
|---|---|
| 症状 | 审计 / 门禁结果不可信：第一次跑 `verify-all` 红（`verify-store` / `verify-privacy` 家目录规则命中），几分钟后同一条命令连续 3 次全绿；`README.md` / `README.en.md` 在审计中途变成 `M`，`smoke-client` 也在同一分钟被改过 |
| 根因 | 两路 agent 同时改同一个工作区，**没有写域声明、没有串行**；门禁读到**半写**的文件 → 假红；也可能互相覆盖 → 假绿 |
| 影响面 | 结论无法追溯；审计报告可能对着一个已经不存在的代码状态写结论 |
| 怎么发现 | 审计报告 §0 记录「审计开始 / 结束」的 `git status`，发现文件在审计期间被并发改动；被审源码的 sha256 全程未变，结论才可追溯 |
| 修复 | 审计结论只对**记录下来的哈希**负责；「改完一轮再跑门禁」，不在并发编辑期间下结论 |
| 自动防线 | 目前**没有**自动闸门。可执行的做法：v1.2 §3.2.13「同一文件同一时间只允许一个写者」；多 agent 先声明**写域（文件清单）**并串行；`git status` 快照 + 文件哈希进报告；`AGENTS.md` 守卫「只 `git add` 自己改的文件」 |
| 缺口 | 没有工具能阻止两个进程写同一文件；只能靠流程与写域声明 |

#### L12-④ 隐私闸门误报

| 项 | 内容 |
|---|---|
| 症状 | 门禁红，但文件里没有任何真实隐私：①报告里引用了 CI 日志的**文件名**，形状是 `<动作名>@v<数字>.txt`，被「私人邮箱」规则命中；②临时目录里一个普通的 `home` 子目录路径，被「家目录绝对路径」规则命中 |
| 根因 | 两道规则都按**形状**匹配，而这些形状在正常技术文本里也会出现；误报会诱使人「把规则放宽」，那才是真风险 |
| 影响面 | 门禁基线红 → 有人开始忽略隐私闸门（比漏报更危险）；或错误地放宽规则，真的泄露就拦不住了 |
| 怎么发现 | 跑门禁时命中 → 逐条看命中位置，确认是误报 |
| 修复 | ①**先改写法**：把日志文件名改成不含 `@` 的表述（commit `b6c74e5`），规则不动；②只有「规则边界真错」才改规则：家目录规则前面加路径边界 `(?<![\w.~-])`，`/Users/<名字>`、`/home/<名字>` 仍然抓，**占位写法放行**（`duplicate-platform-packages` §5.1）；③CI 上跳过「当前用户名」规则（CI 用户名是通用词，会与文档里正常的英文词误撞），与用户名无关的家目录规则照查 |
| 自动防线 | `tools/verify-privacy.mjs`：10 类规则 × 两个面（npm 发布包 + git 跟踪文件）；占位白名单 `isPlaceholderPath`；CI 跳过当前用户名；改规则必须做**反向投毒验证**（真实路径仍红） |
| 缺口 | 规则是形状匹配，边界情况仍可能误报；新增规则必须带正 / 反样本 |

#### L12-⑤ `files: ["docs"]` 把内部审查报告打进 npm 包

| 项 | 内容 |
|---|---|
| 症状 | `docs/reviews/` 的内部审查报告（含排障细节、账号语境、失败现场）出现在 npm 发布包里；包体积变大 |
| 根因 | 把 `docs` 写进 `files` 白名单（或干脆不开白名单），npm 就把整个 `docs` 目录打包；而 `docs/` 里是**过程材料**，不是给用户看的运行时文件 |
| 影响面 | 内部过程材料公开（不可撤回）；发布物边界失守 |
| 怎么发现 | `npm pack --dry-run` / `tar tzf` **逐条看清单**时发现 `docs/reviews/*.md` 在包里 |
| 修复 | `package.json` 的 `files` 改成显式白名单：只含 `lib` / `src` / `locale` / `cordis.patch.yml` / `icon.svg` / 三份面向用户的文档 / `LICENSE`（+ 运行时安装器 `tools/apply-update.mjs`）；`docs` 与 `.github` 不进包 |
| 自动防线 | `verify-privacy`：「发布包里没有 `docs/` 与 `.github/`（内部文档与 CI 配置不该上传）」「发布包里 `tools/` 只允许运行时安装器 `tools/apply-update.mjs`」「发布包文件数在合理范围（>10 且 <40）」；`verify-submission` 校验 git 安装必需文件；发布前 `npm pack --dry-run` 逐条看 |
| 缺口 | 白名单是「允许列表」，往 `lib` / `src` 里新塞敏感文件仍需人看清单 |

#### L12-⑥ 发布 workflow：直接发布 / `npm@latest` 位置错 / Allowed actions 不匹配

| 项 | 内容 |
|---|---|
| 症状 | ①推 tag 直接上线，没有暂存、没有人工批准；②CI 报 `npm stage` 未知命令；③发布被 npm 以 `404 … is not in this registry` 拒绝 |
| 根因 | ①workflow 默认 `npm publish`（把「自动化」当成「不用人把关」），发布不可逆却零人类闸门；②`npm install -g npm@latest` 放在 `setup-node` **之前** → setup-node 装的 node / npm 把它覆盖 → npm 仍是 10.x，不认识 `npm stage`；③Trusted Publisher 绑定页的 **Allowed actions 与 workflow 分支不一致**（默认走暂存却没允许 `npm stage publish`，或直接发布却没允许 `npm publish`）→ npm 不认这次 OIDC 身份 |
| 影响面 | 不可逆发布没有人类闸门；或发布直接失败、白等一轮 CI |
| 怎么发现 | 首次真跑 publish job 的日志（404 + 18 个文件已打包、provenance 已签名，但认证没被认）；邻仓发布流水线日志（`npm stage` 未知命令）；逐字核对绑定页 |
| 修复 | 默认走**暂存**（`npm stage publish`）+ 维护者在 npmjs.com Approve；`npm install -g npm@latest` 挪到 `setup-node` **之后**（同源 token 面板仓库 commit `4b3c218`）；绑定页允许动作与 workflow 分支保持一致 |
| 自动防线 | `verify-workflows`：「推 tag 默认走暂存，且保留直接发布的分支」（断言 `run: npm stage publish` / `run: npm publish` / `inputs.mode`）「发布前先锁文件安装、跑测试、构建客户端」顺序「认证走 OIDC（`id-token: write`）」「所有 action 固定大版本 tag」「无 tab」+ 有 ruby 时真解析 YAML；§5.4 暂存 ≠ 发布；v1.2 §5.8 |
| 缺口 | `verify-workflows` 目前**没有**断言「`npm install -g npm@latest` 必须在 `setup-node` 之后」；也没有断言 Allowed actions（绑定在 npm 网页，本地无法验证）；「暂存多版本只批最新」没有机械检查 |

**L12 的自动防线汇总**

| 子项 | 防线 | 现状 |
|---|---|---|
| ① 元测试自撞 | `smoke-host` 元测试（扫全文 + 边界正则 + 报行号） | ✅ 自动（边界自测待补） |
| ② 9/10 就发布 | `verify-all` 正确退出码 + §3.2.11 铁律 | ⚠️ 靠人执行 |
| ③ 并发写 | 写域声明 + 串行 + 哈希留痕（§3.2.13） | ❌ 无自动闸门 |
| ④ 隐私误报 | `verify-privacy` 规则 + 占位白名单 + 反向投毒 | ✅ 自动 |
| ⑤ docs 进包 | `verify-privacy` 发布包边界 + `npm pack --dry-run` | ✅ 自动 |
| ⑥ 发布流水线 | `verify-workflows` 契约 + §5.8 | ⚠️ 部分（npm 版本顺序、Allowed actions 未断言） |

**素材 / 报告**：`../reviews/ci-fix-0.2.6.md`（含被改写的日志文件名）；`../reviews/version-fixture-refactor.md`（元测试）；`../reviews/stability-audit.md` §0（并发编辑）；`../reviews/duplicate-platform-packages.md` §5.1（隐私规则边界）；`../reviews/standard-v1.1.md` §5（防线现状）；`../verification.md`（0.1.0 的 pack 记录、CI 首次真跑、CI workflow 契约测试、锁文件与 pnpm 配置）。

---

## 2. 附：同一批次里「不是事故」的配套改动

这些改动没有独立事故编号，但属于同一批工作，且各自有自动防线 —— 记在这里，避免下次改回去。

| 改动 | 为什么做 | 防线 |
|---|---|---|
| 更新设置入口：太阳图标 → 真齿轮，顶部 → **页脚版本号右侧**，浮层向上弹 | 图标语义错（放射线像太阳）、顶部入口与面板层级不搭；页脚入口更靠近「版本 / 更新」语境 | `smoke-client`：入口在页脚且是版本号的相邻兄弟、`<svg>` 齿轮几何、Escape / 点外部关闭、三档 `role="radio"` + `aria-checked`、无 `innerHTML`（反向：挪回顶部 / 换文字符号必红） |
| 更新方式三档 `off` / `manual`（默认）/ `auto` | 把「要不要联网 / 要不要自动装」变成用户可理解的三个选项；默认最保守 | `smoke-host`：三档纯函数与持久化、`off` 零网络、`manual` 不自动装、`auto` 全自动 + `restartRequired`、非法值 400 不写盘、损坏回退 `manual`；`smoke-client`：`off` 无徽标、重启提示 |
| 设置持久化 `$DSH_HOME/<plugin>/settings.json`（原子写） | 面板设置要跨重启、且不能写坏 | 原子写 + 无 `.tmp` / `.bak` 残留 + 非法值不写盘 + 损坏回退默认 |
| `link:` 温和态（L10） | 见 L10 | 见 L10 |

---

## 3. 怎么用这份总账

1. **新事故**：先开一节（编号递增），写清「症状 / 根因 / 影响面 / 怎么发现 / 修复 / 自动防线」；
2. **答不出「下次是哪条断言拦住」= 没闭环**：要么补断言，要么把缺口写进 §3.3 / §5.8 的「还没覆盖」；
3. **改规范**：条款里引用编号（如「L11 → §2.13」），不要只写「注意不要在 live profile 跑 pnpm」；
4. **防线现状用三档**：✅ 自动 / ⚠️ 半自动或手工 / ❌ 缺口。**不要把手工 checklist 写成「已拦住」。**

---

## 证据补正：L12-⑤（发布物把内部报告打进包）

该事故发生在**孪生插件仓库**（`dsh-token-mb` 的源码仓库），不在本仓库的 git 历史里，因此在本仓库查不到 `files` 含 `docs` 的提交 —— 属**跨仓库**证据，现补正：

- 该仓库 `package.json` 的 `files` 白名单原先包含整个 `docs`，会把 `docs/reviews/**` 等**内部材料**一并打进 npm 发布物。
- 发布 0.6.7 前已改为 `"docs/*.png"`：实测 tarball 由 32 个文件降到 23 个，`docs/` 下只保留 9 张 README 用图，内部审查报告 0 个；解包后敏感扫描（家目录 / 邮箱 / token 形状）0 命中。
- 变更随 0.6.7 发版提交进入该仓库（提交 `8e549fd`），并已在 `docs/releasing-0.6.7.md` 记录。

**结论**：这条事故是真实的 ✓，自动化防线为 `verify-privacy.mjs` 的"发布包文件清单 + 敏感形状"三条断言 ✓；**建议下一版**再加一条"发布物不得包含 `docs/reviews/`、`docs/postmortems/` 等内部目录"的显式断言 ✓。
