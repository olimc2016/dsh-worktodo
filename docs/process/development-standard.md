# DSH 插件开发 / 测试 / 验证 / 发布规范

> 版本：**v1.1 · 2026-10-18**
> 变更（v1.0 → v1.1）：§2.7 从"一条规则"扩成完整机制；新增 §2.8 宿主版本对齐、§2.9 自更新事务、§2.10 启动期纪律、§2.11 错误隔离、§2.12 可观测性；§3 补双环境/元测试/跨平台/真渲染；§4 补 profile 与宿主升级模拟、长跑；§5 补发布硬门禁、"暂存 ≠ 发布"、坏版本处置；原 §7 事故表升级为 **§6 事故档案**（8 条，每条都写"怎么自动拦住"），环境与工具链顺延为 §7。
> 来源：`dsh-token-meter-panel`（= `dsh-token-mb`）、`dsh-worktodo` 两个插件的完整实践，含踩过的真实事故；v1.1 主要沉淀 2026-10-18 桌面版启动失败（重复平台包）与 0.2.5–0.2.8 期间的自更新/CI 事故。
> 适用：DSH（DeepSeek Harness）宿主插件 / 客户端插件的开发与发版。
> 原则：**能自动拦住的错误绝不靠人眼**；**看起来全绿 ≠ 真的测过**；**公开仓库里不放任何账号/凭据材料**。

---

## 0. 一页速查（三张清单）

### 改动前
- [ ] 先跑一遍 `node tools/verify-all.mjs`，确认基线是绿的，**并且看退出码**（不绿就别动，否则分不清是谁弄坏的）
- [ ] 确认构建工具链可用：`npm run build` 真的产出了新文件（见 §7 的坑）
- [ ] 改宿主半侧 → 记住「必须重启 DSH 才生效」；只改客户端 → 必须重新构建 `lib/client.js`
- [ ] 插件"装完起不来"/宿主启动失败时，**先查 profile 里有没有第二份平台包**，别先怀疑业务代码（§2.7、§7.5）

### 提交前
- [ ] **双环境门禁**：本机 + 干净环境（`env -i HOME=… CI=true`），两套都 `10/10`，且**显式 `echo exit=$?` = 0**
- [ ] 不看 `| tail` 的结果 —— 管道返回的是 `tail` 的退出码，`9/10` 的失败会被吞掉（§3.2.6）
- [ ] 新增/修改了判定逻辑 → 做一次**反向验证**（故意破坏，确认测试变红，记下哪条用例红了，再恢复）
- [ ] 防回归元测试仍在守：当前版本号字面量、`dependencies` 里的 `@deepseek-ai/*`、顶层静态 import（§3.2.7）
- [ ] `git status` 干净，产物（`lib/client.js`、`.map`）与源码同一提交
- [ ] 没把 token / 邮箱 / 账号找回材料写进任何被提交的文件（隐私闸门扫的是 **git 跟踪文件**）

### 发布前
- [ ] `package.json` 版本号 + `CHANGELOG.md` 条目（写"用户可感知的变化"）
- [ ] `npm pack --dry-run` 检查打包白名单（不能含 node_modules、私有文档、截图）
- [ ] `node tools/verify-submission.mjs` 绿：**平台包仍是 optional peer、`dependencies` 里没有 `@deepseek-ai/*`、顶层无静态 import**
- [ ] **profile 模拟安装**（§4.1）：插件目录内没有 `node_modules/@deepseek-ai`，解析到顶层宿主那份
- [ ] 宿主刚升过大版本 → **宿主升级模拟**（§4.2）必做
- [ ] 长跑/多窗口/大数据抽查（§4.3）：轮询、载荷、卸载零泄漏
- [ ] 走暂存发布时，**批准前** §4 全部做完（暂存 ≠ 已发布，§5.4）
- [ ] tag 与 npm 产物同一 commit；发布后核验 `dist-tags` 与"从 npm 真装一次"（§5.5）
- [ ] 真机重启 + 面板实际数据对账一次（§4）

---

## 1. 项目结构约定

```
<plugin>/
  package.json          # name / version / dsh.client / dsh.bundle.patch / files 白名单
  cordis.patch.yml      # 插槽行（id 必须唯一，多包名时各自不同）
  lib/
    index.js            # 宿主半侧入口：export name / inject / apply(ctx, config)
    client.js           # 浏览器半侧【构建产物，必须入库】
    client.js.map
  src/
    core.mjs            # 与宿主/客户端共享的纯逻辑（可单测）
    client/index.js     # 浏览器半侧源码（React.createElement，无 JSX）
    chrome-storage.mjs 等
  tools/
    build-client.mjs    # esbuild 打包 lib/client.js（构建期注入包名等常量）
    setup-modules.mjs   # 链接 DSH 本体依赖（@deepseek-ai/*）+ esbuild
    verify-*.mjs        # 纯逻辑回归
    smoke-host.mjs      # 宿主烟测（假 ctx）
    smoke-client.mjs    # 客户端烟测（桩 React）
    make-twin.mjs       # 生成孪生包（多包名）
    verify-twin.mjs     # 双包名互不冲突的守护
    preview.mjs         # 真数据 + 真 bundle 的页面预览（截图/看版式）
  docs/                 # 设计稿、规格（不含账号材料）
  README.md / README.en.md / CHANGELOG.md / LICENSE / THIRD-PARTY-NOTICES.md
```

**硬约定**
1. `lib/client.js` **入库**：用户从 npm/GitHub 安装时不能现场构建。CI 需能重建出同样内容。
2. `files` 白名单显式列出（`lib`、`src`、`cordis.patch.yml`、文档、LICENSE），避免打包垃圾。
3. 一个仓库只维护**一份源码**。多包名用生成器（`make-twin`），**禁止复制分叉**。

---

## 2. 开发规范

### 2.1 宿主与渲染分离

- `inject` **只写必需**服务（通常 `['webServer']`）。可选服务（`settings`、`deepseekAccount`）用 `ctx.inject([...], cb)` 探测，缺失时降级而不是整体加载失败。
- 取服务用 `ctx.get?.('name') ?? ctx.name` 双通道，兼容不同组合与测试桩。
- 浏览器半侧只做展示与交互；一切数据/写操作都经宿主的 HTTP 路由（客户端不能直接碰文件、凭据、设置）。

### 2.2 多包名（同源码不同名）

所有会撞车的标识**一律由包名派生**，不要让两个名字共用：

| 标识 | 派生方式 | 撞车后果 |
|---|---|---|
| 插件 `name` | 包名去 `dsh-` 前缀 | 加载器重复 |
| webServer 路由前缀 | `/${短名}` | 第二个插件 register 抛错 |
| settings 命名空间 | `/${短名}` 同源 | 配置互相覆盖 |
| 浏览器 slot id | 短名（主包可保留历史值） | 侧栏重复注册 |
| locale 命名空间 | 短名 | 词典互相覆盖 |
| cordis 插槽行 id | 写在各自 `cordis.patch.yml` | 加载器报重复行 |

> 实测：两个包同时装进一个 profile 也不冲突 —— 但前提是上表全部做到。`verify-twin` 就是守这条的。

### 2.3 数据源与口径（最容易出"用户不信"的地方）

**优先级**：官方账号会话 → 官方网页登录态 → 本地数据兜底。降级必须知道"为什么降级"并给出可执行指引。

**鉴权不可混用**（实测）：

| 接口族 | 账号会话 token | 网页 userToken |
|---|---|---|
| `/api/v0/users/*`（余额、累计消费） | ✅ `x-dsh-auth-token` | ✅ Bearer |
| `/api/v0/usage/by_api_key/*`（按天用量） | ✅ `x-dsh-auth-token` | ✅ Bearer |
| 同一接口换另一种头 | ❌ `Authorization Failed` / `INVALID_PARAM` | ❌ |

- 账号会话路径要带官方那 5 个客户端头：`x-client-bundle-id`（故意为空）、`x-client-platform`、`x-client-version`、`x-client-locale`、`x-client-timezone-offset`。
- **时间窗口必须对齐**（如北京零点）：`start`/`end` 不对齐 → `INVALID_PARAM`。窗口跨度决定桶粒度（长窗口按天、当天按小时）。

**口径纪律**
- **同一张表只放同一口径的数字**。官方金额与本地推算混排 → 用户会发现"加不上"，信任瞬间归零（真实事故）。
- 估算值必须标注"估算 / 允许几分差异"，并在脚注写明算式与四舍五入。
- 金额用**十进制字符串**相加（避免 `0.1+0.2`）；展示固定小数位（小额至少 4 位）。
- 每个派生数字都要能回答："它来自哪、怎么算的、和官方差多少是正常的"。

### 2.4 配置与凭据

- 设置项全部走 schemastery schema，`description` 写中文；默认值单点定义在 `DEFAULTS`，schema 与代码共用。
- 凭据**只存引用**（`role('credential-ref')`），永不写日志、永不回显。
- 面板内可改设置 → 宿主提供 `POST /<prefix>/settings`，服务端校验（非负/范围）后 `settings.update(ns, patch)`，清缓存让下一次 `/summary` 立即生效。
- 设置写接口必须做：**字段白名单 + 类型/范围校验 + 体积上限**。

### 2.5 UI 约定

- **同一排的卡片必须同一 surface**（同圆角、同阴影、同底色），否则视觉"不在一个平面"（真实事故：18px vs 16px、`0 14px 40px` vs `0 10px 32px`）。
- 窄栏用 `flex-wrap` + `minmax(180px, 1fr)`，**不要**用固定网格让某一列被挤成一字一行。
- 数字：`font-variant-numeric: tabular-nums` + `white-space: nowrap`；表格用 `colSpan` 时**不要**加 `tableLayout: fixed`（会折行）。
- 文案：正文一句话，解释放 `title`/tooltip；中英双语同步维护。
- 图表：柱上只留一个主标签（值或占比，别叠加）；x 轴标签过密要抽稀。

### 2.6 安全与隐私（硬红线）

- **公开仓库不得出现**：任何账号名+邮箱组合、token、`.npmrc` 内容、账号找回/客服沟通材料、内部绝对路径、用户会话截图。
- token 只以「临时 npmrc + `chmod 600`」形式存在于内存/临时目录，**用完立即删除**；不得写进仓库、脚本、命令行历史。
- 账号/凭据类文档只放**仓库外的私有目录**（如 `~/Documents/...`），或只在对话中给出。
- 撤回公开内容要**快**：发现已推送 → 立刻 `git reset` 撤回本地提交；若已推送，改中性文案并考虑历史清理（force-push 会影响他人克隆，需先确认）。

---

### 2.7 宿主平台包：只能 optional peer，且不得多带一份（2026-10-18 启动失败事故）

**规则（四条）**

1. `@deepseek-ai/*` 这类**宿主提供的平台包**（`dsh-tools`、`dsh-storage-domain`、`dsh-home-paths` 等）**只能**声明为
   `peerDependencies` + `peerDependenciesMeta: { optional: true }`；**`dependencies` 里不得出现任何 `@deepseek-ai/*`**（应为空）。
2. **不得在模块顶层静态 import 平台包** → 必须在函数内**动态 import + 失败降级**。
3. 版本声明用**宽松范围**（如 `^0.2.0-rc.2`；宿主闸门按 `includePrerelease` 判 peer），不得写死当前运行时的精确版本（见 §2.8）。
4. 平台包缺失/版本不符时**只允许降级本插件**（工具不注册、回退 JSON 存储），**绝不连累宿主启动**（见 §2.11）。

**机制：一份硬依赖如何拖垮整个宿主（本次事故链）**

profile 的 `nodeLinker=hoisted`：

1. **任何硬依赖都会被摊平进 profile 顶层** ✗ —— 插件声明 `dependencies`，pnpm 就把平台包装成 `profile/node_modules/@deepseek-ai/*`（而且可能解析到旧版）。
2. **profile 层解析优先于宿主安装层** ✗ —— 从 profile 发出的 bare import 先命中本层副本，宿主自带的那份被绕过。
3. **宿主有兼容性闸门** ✗ —— app 升级后，profile 里的旧版 core 包被判 incompatible，**整行被 disable**。
4. **被 disable 的行不出现在 pending 名单里** ✗ —— 服务提供者凭空消失，下游全部等待：

```text
startup failed: 1 required plugin did not activate

Plugins waiting for services (14):
  agent-loop (required)      tools
  workspace                  storageDomain
  …

dsh: disabling profile plugin row "tools":
  … is incompatible with dsh <宿主版本> …
```

**crash 日志里既没有 `Failed plugins` 段、也没有 disable 行**，所以从用户能拿到的日志**看不出真因**。
排查要走宿主 stderr（直跑 host，见 §7.5），诊断自解释是插件侧义务（§2.12）。

**自动防线（已固化，发布阻断）**：`tools/verify-submission.mjs` 断言四条 ——
①`dependencies` 无 `@deepseek-ai/*`；②三个平台包为 optional peer；③服务端源码顶层无静态 import 非 `node:` 包；④动态 import 集合等于这三个包。
并带**反向自检**：把包塞回 `dependencies`、或从 peer 移走，校验器必须报错。`prepublishOnly` / `pnpm test` / CI 都会跑 —— **违反即发不出去**。

**静态断言证明不了"装出来只有一份"**：必须再做一次 §4.1 的 profile 模拟（`pnpm pack` → 假 profile → 断言插件目录内无平台包、解析到顶层宿主那份）。

### 2.8 宿主版本对齐（升级模拟是发版前置，不是可选项）

- **插件不得写死宿主包版本**：`peerDependencies` 用能覆盖未来补丁/预发布的宽松范围；不要在 `peer`/`dependencies` 里写运行时精确版本。
  `devDependencies` 的精确版本只是**测试夹具**（仓库要能 import 它们跑测试），宿主升级后随之更新，且不随发布包出去。
- **宿主升级 = 插件的回归事件**：升级会同时改变平台包版本、profile 解析与兼容性闸门。插件"一行没改"也可能装坏宿主——2026-10-18 就是宿主先升级、插件后安装。
- 因此：**宿主大版本升级后，必须重做 §4.1 + §4.2 再发版**，并在 CHANGELOG 写明"已对 DSH x.y 验证"。
- 不得在运行时"顺手"安装/升级平台包：profile 属于用户与宿主，插件写它就是越权（§2.9）。

### 2.9 自更新 / 自升级：写用户环境必须是事务（0.2.7 六条稳定性事故）

自更新是插件里唯一会**改用户环境**的代码路径，默认假设它会失败。

**默认保守**
- 后台只**下载**；**安装由用户触发**（`autoInstall` 默认 `false`，只有字面量 `true` 才开）。
- 启动期不安装：版本检查延后到宿主 idle（秒级定时器、可取消），启动后 N 秒内不写 profile。

**事务**
- 写用户环境必须 **原子 + 快照 + 回滚 + 跨进程锁**：
  - **原子**：临时文件 + `fsync` + `rename`；**win32 回退不得先删目标** —— 先落 `.bak`、再删、再 rename；二次失败从内存/备份恢复；恢复不了就**保留 `.bak` 并把路径写进错误**（0.2.7 事故：回退先删目标，两次 rename 失败后原文件彻底消失）。
  - **快照**：`package.json` 与 `pnpm-lock.yaml` 属**同一事务**，逐字节快照与还原；本次新建的文件要删掉（回滚漏 lockfile = 用户下次装到一半）。
  - **锁**：`open(..., 'wx')` 原子建锁，内容带 pid/host/at/token；拿不到即 `busy`，**不重试**；stale 只回收一次；只删自己 token 的锁（0.2.7 实测：无锁时 5 个 pnpm 同时写同一 profile）。
- **不手写 profile 的 JSON**：能走宿主 CLI 就走；CLI 明确拒绝（`active-run` / `incompatible`）必须 **failed 并停止序列**，**绝不降级到 pnpm** 绕过宿主保护；只有 `cli-unavailable` 才允许降级。
- **profile 定位只从模块自身路径推**：`fileURLToPath` 后取**最后一个** `node_modules/<包名>` 段（嵌套布局要么命中内层，要么 `null`），输出统一成 `path.win32.normalize` 的 `C:\…` 形状；同时认 `/` 与 `\`、盘符大小写、`%20`、UNC。**推不出就零写盘失败**，绝不按"第一个匹配"指到外层 profile（0.2.7 事故：取第一个匹配会改错 profile）。

**生命周期**
- 杀进程要**杀整棵树**：POSIX `detached: true` + `kill(-pid)`；Windows `taskkill /pid <pid> /T /F`；超时后连 stdout/stderr 一起 `destroy`（只杀直接子进程，孙进程会继续写 profile）。
- **卸载后零写盘、零子进程**：`disposed` 在每个异步收口前检查；`ctx.effect` 清理里 abort 所有 fetch、清定时器、杀树、放锁；卸载后连回滚也不写（状态记 `skipped: 'disposed'`）。

**失败必须自解释**
- 诊断固定字段：`step` / `command` / `executable` / `argv` / `exitCode` / `signal` / `timedOut` / `spawnError` / `logTail` / `target` / `currentVersion` / `installedVersion` / `profileDir` / `platform` / `updater` / `pnpm`。
- "成功"只认**落盘版本变了**，不认退出码（真机出现过 CLI 退出码 0 但 `added 0`）。
- 面板要看得见：失败徽标下给一行详情，`title` 放全文，只用文本节点，绝不 `innerHTML`。

### 2.10 启动期纪律（apply 是宿主启动路径上的代码）

- **apply 不阻塞**：不 `await` 网络、子进程、大文件、profile 读写；目标 <50ms，且任何可能慢的 IO 都要有上限（本次实现：`storageDomain.open` 3s 超时）。
- **网络/子进程/写盘延迟且可取消**：定时器登记进生命周期并 `unref()`；fetch 用 `AbortController`；插件卸载/重载即取消。
- **任何"自动修改用户环境"的动作默认关闭**，或必须用户显式开启；默认值要能一句话说清（`autoInstall: false`）。
- 每个 `void promise` / `.then()` 必须有 `.catch` —— 宿主进程里 unhandled rejection 就是一次未捕获异常（0.2.7 A4）。
- 启动期不读热路径上的 profile / `node_modules` 清单：面板轮询会把开销放大（0.2.7 D1）。

### 2.11 错误不连累宿主（只降级本插件）

- 平台包缺失、`storageDomain` 打不开、工具注册失败、路由重复 → **只降级本插件**，`apply()` 正常返回而不抛。
- 降级必须**显式可查**：`store.kind = 'unavailable'`、`toolState.status = 'failed'`、`/health` 带原因；不许"看起来正常但少了能力"。
- ESM 不允许 `try { import } catch` 包住静态 import —— 所以**只能**在函数内动态 import（§2.7 规则 2；`verify-submission` 直接扫源码）。
- 已知边界：插件模块本身语法错 / JSON 坏，插件侧兜不住 → 靠 §3 的"加载真产物"与 §4.1 的 profile 模拟拦在发布前。

### 2.12 可观测性（关键动作不能只写日志）

- 升级、迁移、存储切换这类**改变用户环境或数据位置**的动作，必须有**可查的状态与诊断**：状态文件（`$DSH_HOME/<plugin>/…`，原子写）+ HTTP 诊断接口（`GET /<prefix>/update`）+ `/health`。
- **不要把关键信息只写进会被丢弃的日志**：本次事故里 crash 日志只留了 `StartupError.message`，把真正的原因行（`disabling profile plugin row …`）丢掉了，用户与支持工程师都无法自助定位。诊断要能**离开日志独立存活**。
- 诊断进面板时只用文本节点；日志尾部限长（数行），不写凭据、不写待办内容。
- 状态要能跨重启讲清"上次做到哪一步、为什么失败"（`failedOperation` / `attemptedSteps` / `reason`）。

## 3. 测试规范

### 3.1 分层（每层职责单一）

| 层 | 文件 | 覆盖 | 要求 |
|---|---|---|---|
| 纯逻辑回归 | `verify-core` / `verify-generations` / `verify-zstd` / `verify-rates` / `verify-storage` | 聚合、去重、解析、计价 | 不依赖个人路径；找不到数据**跳过**而不是失败 |
| 宿主烟测 | `smoke-host` | 路由、设置、余额/用量、工具、自升级、跨平台模拟 | **假 ctx**，网络一律打桩（`globalThis.fetch`），不允许真出网 |
| 客户端烟测 | `smoke-client` | bundle 能注册、slot id/包名派生一致、首屏、错误边界、**真渲染一次** | 桩 React / 迷你渲染器，无浏览器 |
| 契约测试 | `smoke-contract` | 客户端请求的路径/字段 ↔ 宿主真的消费 | 静态提取 + 端到端报文，防"字段名打错静默失效" |
| 双包名守护 | `verify-twin` | 生成孪生包 + 标识互不相同 + 在孪生包内跑它自己的烟测 | 必须真跑，不能只看字符串 |
| 元测试 | `smoke-host` / `verify-submission` | 版本字面量、依赖面、import 形态 | **扫全文**，不用位置白名单 |
| 发布面 | `verify-privacy` / `verify-submission` | 隐私、打包白名单、收录条目 | 两个面都查：npm 发布包 + git 跟踪文件 |

### 3.2 铁律（血泪教训）

1. **测试必须跑"刚构建的产物"**。
   事故：`node_modules/esbuild` 是指向 `/tmp` 的软链，系统清理 `/tmp` 后构建**静默失败**，而烟测加载的是**旧** `lib/client.js` → 全绿，但测的是上一版代码。
   规范：
   - 构建脚本失败必须**非零退出**，CI/本地都要 `set -e`；
   - `npm test` 的第一步应校验产物新鲜度（构建后比较 mtime/hash，或构建前删产物）；
   - 任何"改完代码结果一模一样"的现象，先怀疑构建。

2. **反向验证（mutation check）**：新增或修改判定逻辑后，**故意破坏一次**，确认测试 FAIL，再恢复；并**记下是哪条用例红的**。
   没有通过反向验证的测试**不许入库** —— 假测试比没测试更危险（给人虚假安全感）。
   真实案例：一个"用有数据状态遍历对象树"的假渲染测试，故意把 bug 塞回去仍然 PASS → 已撤，不入库。

3. **断言"会撞车的事实"**，不要断言实现细节：行 id、路由前缀、命名空间、slot id、窗口对齐、口径一致、金额自洽。

4. **回归样例要能离开这台机器跑**：禁止硬编码家目录绝对路径（一律 `~/…` 或 fixture / 环境变量）；缺失则跳过。

5. **网络全部打桩**：烟测里出现真实 fetch 就是缺陷（会偶发失败、泄露 token、拖慢 CI）。

6. **双环境门禁 + 显式退出码**（2026-10-18 真实教训）。
   本机一套、干净环境一套（`env -i HOME=… CI=true`，不继承 `DSH_HOME` 等），**两套都要 10/10 且退出码 0**。
   关键在**显式检查退出码**：`node tools/verify-all.mjs | tail -20` 的 `$?` 是 `tail` 的，基线 9/10 的失败会被整段吞掉。
   ```bash
   "$NODE" tools/verify-all.mjs; echo "exit=$?"          # ✓
   set -o pipefail; "$NODE" tools/verify-all.mjs | tail  # 至少要有 pipefail
   ```

7. **防回归元测试**（这次事故的产物，必须留着）：
   - **"源码里不得残留当前版本号字面量"**：从 `package.json` 派生 `PKG_VERSION` / `FAKE_NEXT_VERSION`，再扫全文找孤立字面量（边界正则 `(?<![\d.])<ver>(?![\d.])`），命中报行号。夹具写死版本号 = 每次发版都假红（`version-fixture-refactor`）。
   - **"`dependencies` 不得出现 `@deepseek-ai/*`"**：还要带**反向自检**——把包塞回 `dependencies`、或从 peer 移走，校验器必须报错（只写断言不自检，很容易写出永远绿的断言）。
   - 元测试要**扫全文**：这次的假红正是"漏改的字符串"造成的，只盯已知位置或白名单必然还会漏。

8. **CI 与本地必须一致；"本地碰巧绿"也是缺陷**。
   ESM 的静态 import 会在模块体之前求值：测试文件顶部写 `process.env.X='1'` 再静态 import 被测模块，**模块求值时就看不到它**（`ci-fix-0.2.6`：本地"全绿"只是 registry 查询恰好没抢在测试前完成）。
   - 环境变量/开关一律**调用时读**（`updateCheckOff()`，不是模块级常量）；
   - 测试开关由**父进程 spawn 前**注入，让每个 suite 从第一行就继承；
   - 专门造一条**时序用例**（如只监听 127.0.0.1 的 400ms 慢 registry）证明"检查在飞时行为仍正确"，否则"假绿"永远发现不了。

9. **跨平台要有模拟测试**，不能只靠"代码里写了 win32 分支"：路径（`file:///C:/…`、反斜杠、盘符大小写、`%20`、UNC）、执行器（`node + pnpm.mjs` 优先、`pnpm.cmd + shell` 兜底、**绝不裸 `spawn('pnpm')`**）、`rename` 三态（成功 / 先删后成功 / 删不掉必须报错且不留半文件）、进程树（真起孙进程，超时后必须死）。平台用测试缝注入（如 `WORKTODO_PLATFORM`），不改真实 fs 语义。

10. **客户端要有"真渲染"路径的测试**。
    React 替身如果不重渲染/不走渲染期，就会漏掉"黑屏"类 bug（轴标签 `map` 缺 `index` → `ReferenceError` → 整块白屏）。
    最低要求：把面板树**真渲染一遍**（函数组件真调用、类组件 `render`、错误边界按 React 语义走），并至少覆盖一次"有数据"的完整面板。
    现状：本仓库有自写迷你渲染器（含错误边界与位置化 hook），但**没有真 React + DOM，也没有 `setState` 重渲染** —— 见 §3.3。

### 3.3 已知缺口（必须补，验收标准写死）

- **真 React + DOM 挂载仍未落地**。现在的迷你渲染器能抓"渲染期抛错 / 边界兜底"，但不覆盖 `setState` 重渲染、并发渲染、浏览器 API 差异。
  正确做法：真 React + 最小 DOM（happy-dom / linkedom / 自写 createElement→HTML）**真挂载**一次"有数据"的完整面板，并点一次会触发状态更新的交互。
  验收：**故意去掉 `params` 里的 `index`、或改坏一次 `setState` 分支时，该测试必须 FAIL**。
- **profile 模拟 / 宿主升级模拟仍是手工**（§4.1 / §4.2）。没有脚本 = 每次发版都靠人记得，建议下一版做成 `tools/verify-profile.mjs`：临时目录 + 假宿主层 + 真 tarball，一条命令给出四条断言。
- **没有真机 Windows**：`MoveFileEx` 覆盖、`taskkill /T /F`、杀软/索引器占用导致二次 `rename` 失败都只是形状测试 + 注入失败模拟。
- **"环境变量提升"类缺陷只能靠约定 + 一条时序用例**，没有静态检查能证明"所有开关都在调用时读"。

### 3.4 跨平台

- CI 必须 ubuntu + windows 双跑（路径分隔符、权限、换行、大小写、行尾差异）。
- 不要依赖系统 `PATH`：DSH 桌面端进程的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`；调用 CLI 用包内入口 + `ELECTRON_RUN_AS_NODE=1`。
- 平台差异（macOS `Contents/Resources/app.asar`、Windows `resources/app.asar`）要有单元用例覆盖。
- **Windows 上不要 shell 猜路径**：自带 pnpm 用 `node + pnpm.mjs`（argv 数组、无 shell）；只有找不到自带 pnpm 才 `pnpm.cmd` + `shell: true`，并把每个参数逐字加引号。
- **杀进程树**是跨平台的两套实现（POSIX 进程组 / `taskkill /T /F`），两边都要有"孙进程必须死"的可执行用例，不能只断言调用参数。

---

## 4. 验证规范（发版前必须做的）

> 前 4 项是**硬门禁**（全过才允许进 §5），其余是发版前必做的验证。**任何一项没有"退出码 0"的证据，都算没过。**

1. **双环境全绿，且显式退出码**：本机 + 干净环境，两套都 `10/10`（含构建）。干净环境不继承 `DSH_HOME`、`HOME` 指向临时目录、`CI=true`。

   ```bash
   NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
   WORKTODO_NO_UPDATE_CHECK=1 "$NODE" tools/verify-all.mjs; echo "exit=$?"

   rm -rf /tmp/cihome && mkdir -p /tmp/cihome
   env -i HOME=/tmp/cihome PATH="$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin" CI=true \
     "$NODE" tools/verify-all.mjs; echo "exit=$?"
   ```

   **不要用 `| tail` 看结果**：管道返回的是 `tail` 的退出码，曾把基线 `9/10` 的失败整段吞掉（§3.2.6）。

2. **产物与源码一致**：重新构建后 `git status` 无差异（证明入库产物可重建）。

3. **profile 模拟安装**（§4.1）：证明"装出来只有一份平台包，且解析到宿主那份"。

4. **宿主升级模拟**（§4.2）：宿主刚升过大版本时**必做**。

5. **双端验证**：
   - 版式：`node tools/preview.mjs --open`（真 bundle + 本机真数据，看布局/换行/折行）；
   - 真机：**完全退出 DSH 再启动** → 打开面板 → 核对数据。插件是启动时加载的，改宿主必须重启。

6. **数据对账**（不能只看"有数"）：
   - 今日金额 vs 官方网页金额；
   - 30 天窗口总金额 vs 官方；
   - 分档合计 vs 明细行相加；
   - 四个窗口（今日/7天/30天/本月）互相自洽。

7. **长跑 / 多窗口 / 大数据**（§4.3）。

8. **异常路径验证**：断网、未登录、无凭据、只有本地数据、浏览器 token 过期、平台包缺失、`storageDomain` 打不开 → 面板必须给出可执行提示，不能白屏/空转。

9. **回归截图存档**：每次发布留一张真机截图（存私有目录，不入公开仓库）。

### 4.1 profile 模拟安装（平台包事故的验收动作）

目标**不是"能装上"**，而是**装出来只有一份平台包，且解析到宿主那份**。静态断言（§2.7）只能证明清单/import 形态对，证明不了装出来的形状。

```bash
# 0) 打真实 tarball
"$NODE" "$PNPM_CJS" pack --pack-destination /tmp/wt-pack

# 1) 假 profile（两层，与 DSH 的 installation/profile 解析同形）：
#    /tmp/wt-sim/profiles/{package.json, node_modules/@deepseek-ai/…}   ← 顶层 = 宿主安装层替身
#    /tmp/wt-sim/profiles/desktop/package.json                          ← 只依赖上面那个 tarball
cd /tmp/wt-sim/profiles/desktop && "$NODE" "$PNPM_CJS" add /tmp/wt-pack/<pkg>-<版本>.tgz
```

四条断言（全过才算过）：

- [ ] `profiles/desktop/node_modules` 顶层**只有本插件**，没有 `@deepseek-ai/*`
- [ ] 插件目录内**不存在** `node_modules/@deepseek-ai`（hoisted 会摊到 profile 顶层，这条查的是"插件自带副本"）
- [ ] 从插件入口解析平台包 → 落在 `profiles/node_modules/@deepseek-ai/*`（宿主层），版本 = 宿主版本
- [ ] **反向样本**：把平台包塞回 `dependencies` 再 pack 装一遍 → 第 1、3 条必须变红（第 2 条在两种形态下都可能成立，不能只靠它判别）

> 这一步目前是**手工**（没有脚本），所以更要按 checklist 做。自动化是下一版该补的缺口（§3.3）。

### 4.2 宿主升级模拟

模拟"宿主从旧版升到新版、插件一行没改"：

1. 假 profile 里先装**旧版**平台包 + 本插件 → 能启动；
2. 把顶层平台包换成**新版**（等价于 app 自动更新），profile 里的插件不动；
3. 启动并看诊断。

断言：

- 不出现 `disabling profile plugin row …`、`Plugins waiting for services`、`1 required plugin did not activate`；
- 插件 `/health` 里工具/官方存储是"可用"还是"已降级"，降级原因必须可读；
- 面板能打开、能读数据。

> 平台包跨版本最容易在**预发布号**上出事：`^0.2.0-rc.2` 对 `0.2.1-rc.2` 是满足的，所以闸门不会因 peer 范围拒；真正的风险是**副本抢先解析**。核心不是范围，是 §4.1 的"只有一份"。

### 4.3 长跑 / 多窗口 / 大数据

- **`apply → dispose` 10 轮**：进程/句柄/定时器/子进程**零增长**；卸载后零写盘、零 spawn。
- **多窗口**：两个面板同时开；2s 轮询只在下载/安装进行中存在，30s 轮询在后台标签页要停。
- **大数据**：1000 条待办时 `/list` 的字节数与渲染耗时；`shapes` 收敛后不得回退成三份；单文件写入 ≤ 32MiB。
- **泄漏**：完成动效的定时器、窗口监听、`setInterval` 卸载时全部清掉（smoke-client 已有断言，新代码别绕开）。
- **并发**：两个实例/两个进程同时触发写操作 → 锁必须让其中一个 `busy`，且它零写盘。

---

## 5. 发布规范

### 5.1 版本与提交

- 语义化版本；`package.json` + `CHANGELOG.md` 同一次提交更新。
- **tag 与 npm 产物必须是同一 commit**（先 bump → 提交 → tag → 发布，避免 tag 指旧代码）。
- 提交信息写"为什么改"，不写"改了啥"。

### 5.2 npm 发布方式（优先级从高到低）

1. **Trusted Publisher（OIDC，推荐）**
   - 绑定：包页 → Trusted Publisher → GitHub Actions → `<org-or-user>` / `<repo>` / `<workflow 文件名>` / Environment 留空。
   - **跨账号可绑**：包属于 npm 账号 A、仓库属于 GitHub 账号 B，完全合法（绑的是"仓库+工作流"）。
   - 工作流：`id-token: write` + `npm publish --provenance --access public`，全程无 token。
2. **临时 token（次选，仅应急）**
   - 临时 npmrc：`printf '//registry.npmjs.org/:_authToken=%s\n' "$T" > "$TMP/.npmrc"; chmod 600`，用 `NPM_CONFIG_USERCONFIG` 指向它。
   - 指定官方源：`--registry=https://registry.npmjs.org/`（本机 pnpm 默认源可能是镜像）。
   - **发布后立即删除临时 npmrc，并撤销该 token**（尤其 token 曾出现在聊天/日志里时）。

### 5.3 发布前硬门禁（缺一不发）

```bash
"$NODE" tools/verify-all.mjs; echo "exit=$?"          # ① 本机 10/10
env -i HOME=/tmp/cihome PATH="$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin" CI=true \
  "$NODE" tools/verify-all.mjs; echo "exit=$?"        # ② 干净环境 10/10
node tools/verify-submission.mjs; echo "exit=$?"      # ③ 发布面断言（平台包/收录条目）
npm pack --dry-run                                    # ④ 白名单
```

- **① ② 必须都是 `10/10` 且退出码 0**（§3.2.6、§4 第 1 项）；
- **③ 发布面断言**：`dependencies` 无 `@deepseek-ai/*`、平台包为 optional peer、顶层无静态 import；
- **④ `npm pack --dry-run` 白名单**：只含 `lib/`、`src/`、`cordis.patch.yml`、README/CHANGELOG/LICENSE；**不含** `node_modules`、截图、内部笔记、任何 `.npmrc`/凭据；
- **⑤ profile 模拟安装**（§4.1）四条断言全过；宿主刚升级过 → 加做 §4.2；
- 产物与源码同一 commit（`lib/client.js` 必须真的在 tarball 里）。


### 5.4 暂存 ≠ 发布（staged publish）

- `npm stage publish` 只把版本推进**暂存区**，`latest` **不动**；必须维护者在网页上 **Approve**（完成 2FA/WebAuthn）才真正上线。
- **批准前必须完成 §4 全部验证**：暂存区不是"先占位、后补验证"的地方。CI 通过只代表"可以给人看"。
- **批准是人做的事**：不要在 CI 里自动批准、也不要用 token 绕过 2FA；自动批准等于放弃这道闸门。
- 实测副作用：暂存发布**不写 registry 的 `readme` 字段**（包页面会没有 README，tarball 里是齐的）。要页面 README 就走直接发布，或发布后按 §5.5 补查。

### 5.5 发布后核验

```bash
npm view <pkg> dist-tags versions --registry=https://registry.npmjs.org/
npm view <pkg>@<ver> version dependencies peerDependencies
curl -s -o /tmp/p.tgz "<tarball-url>" && tar tzf /tmp/p.tgz | head -20   # 文件清单
```

- `latest` 指向新版本、版本号正确、`repository`/`description` 正常、tarball 内含 `lib/index.js` 与 `lib/client.js`。
- **从 npm 真装一次**（不是装本地 tarball）：临时 profile / 临时目录里 `pnpm add <pkg>@<ver>`，确认
  ① 装出来的 `dependencies` 为空（无 `@deepseek-ai/*`）；② 插件目录内无 `node_modules/@deepseek-ai`；③ 平台包解析到顶层宿主那份。
- 任何一项不对 → 立刻按 §5.6 止血，别等用户报障。

### 5.6 坏版本处置（本次实战）

**止血顺序不能反**：

1. **先 `npm dist-tag add <pkg>@<good> latest`** —— 用户的自动更新（唯一依据是 `latest`）立刻停止拿到坏版本；
2. 再决定撤版本还是发补丁。

| 时机 | 动作 | 说明 |
|---|---|---|
| 发布后 **72 小时内** | `npm unpublish <pkg>@<ver>` | npm 允许的撤回窗口；同一版本号**不可重发**，撤了必须换版本号 |
| 超过 72 小时 | `npm deprecate "<pkg>@<range>" "原因 + 替代版本"` | 装上的人会看到警告；同时尽快发补丁版 |
| 任意时刻 | `npm dist-tag add <pkg>@<good> latest` | 止血第一步，先做 |

- **只撤单个版本**，不要 `unpublish` 整个包（会连带撤掉所有版本与安装记录）。
- **`latest` 是自动更新的唯一依据**：不发新版本、只改 `latest` 也能立刻止住扩散；反之只发版本不动 `latest`，老用户永远收不到。
- 事后必须写 `docs/reviews/<topic>.md`：症状、根因、防线（对应 §6 哪一行）、还差什么。

**包名所属账号不可用**时（真实事故）：

- 用可控账号下的**新包名**继续发布（同源码，`make-twin` 生成）；
- README 只写事实与替代安装方式，**不写账号原因**；
- 已装旧名用户走 GitHub tag 更新路径（`github:<owner>/<repo>#vX`），不要留死路。

### 5.7 账号与凭据治理

- 2FA **必须备份恢复码**；记录在密码管理器里。
- 账号找回材料（工单、身份验证、客服往返）只存私有文件，**绝不入公开仓库**。
- 身份验证正路：GitHub 侧提供的 secret gist（含指定暗号）+ 另一可控账号的关联证据（同仓库、同代码、同维护者链路）。

---

## 6. 事故档案（症状 → 根因 → 防线）

> 每条都必须能回答：**"下次同样的事，是哪条断言/哪道闸门把它拦住？"** 答不出来的事故 = 还没沉淀完。
> 最后一列写的是**自动拦**（脚本/断言/门禁）；只写"注意点"的不算防线。

### 6.1 八条主事故

| # | 事故（症状） | 根因 | 怎么自动拦住（对应断言 / 闸门） |
|---|---|---|---|
| 1 | 插件装了**跑不起来**：工具/面板不出现 | 代码 import 了平台包，但清单里没声明 → 解析失败 | `verify-submission` 断言「运行期动态 import 的 bare 包集合 == peer 声明」；`smoke-host` 在父目录无平台包的子进程里跑 `apply()`，必须不抛并输出 `RESILIENT_OK`（**声明与使用对齐**） |
| 2 | **宿主启动失败**：`1 required plugin did not activate` + 十几个插件 waiting（2026-10-18） | `dependencies` 装出第二份平台包 → hoisted 摊平到 profile 顶层 → 旧副本抢先解析 → 兼容性闸门 disable 关键行；且 **disable 行不进 pending**，日志看不出真因 | `verify-submission` 四条 + **反向自检**（塞回 dependencies 必须红）+ `prepublishOnly`；发版前 **§4.1 profile 模拟**（第二份必须不存在）；宿主升级后 **§4.2** |
| 3 | 存储后端**静默降级** → 待办"分裂"成两份 | 官方 storage 打不开时静默回退文件，两处都写，谁也不报 | 单一真源 + 回退文件**退役**（哨兵/`movedTo`）+ `store.kind`/`mismatch` 进 `/health` 与 `/list`；`verify-store` 断言"退役后不复活、不静默读回"；`smoke-client` 断言告警**真的渲染出来**（不是只躺在 JSON 里） |
| 4 | 坏文件被写入覆盖 / **已删待办复活** | 直接覆盖写；合并中途失败无回滚；回退文件还被当数据源 | 写前备份 + 原子写 + 合并事务回滚 + 退役标记；`smoke-host` C1（去掉备份必须红）、`verify-store` F2/F3（合并失败回滚、退役后不再合并） |
| 5 | 面板**黑屏**（整块白） | 渲染期 `ReferenceError`（轴标签 `map` 少 `index`），假渲染到不了该分支 | 真渲染一次 + 错误边界（中文兜底 + `console.error` 留完整堆栈，堆栈不进 DOM）；反向验证：摘掉边界 / 改坏渲染分支必须红（§3.2.10） |
| 6 | CI **假绿 / 假红** | ①不 build 就测旧产物 ②夹具写死版本号，发版即假红 ③ESM 静态 import 提升让 `process.env` 在模块求值时失效 | `verify-all` **先 build，失败即红**；版本从 `package.json` 派生 + 元测试扫字面量；环境开关**调用时读** + 父进程 spawn 前注入 + 慢 registry 时序用例；**显式退出码** + 双环境（§3.2.6–3.2.8） |
| 7 | Windows 自更新**无效**（版本一直不变） | 裸 `spawn('pnpm')`（不认 `.cmd`）+ 自带 pnpm 路径只猜一处 + CLI 指 asar 内部路径；CLI 还可能退出码 0 但 `added 0` | 执行器优先 `node + pnpm.mjs`、兜底 `pnpm.cmd + shell`（`WORKTODO_PLATFORM=win32` 模拟用例）；**"落盘版本变了才算成功"**；失败诊断带 argv/退出码/日志（§2.9） |
| 8 | 自更新**写坏 profile** / 装到一半 | 非原子写（win32 回退先删目标）、回滚漏 lockfile、卸载后仍起子进程、超时只杀直接子进程、启动期自动安装 | 不手写 profile JSON + 原子写（备份/恢复）+ `package.json` 与 `pnpm-lock.yaml` **同事务快照** + 跨进程锁 + 杀进程树 + `disposed` 零写盘；`smoke-host` B1/B2/B3/C1/C2 各自反向验证（§2.9） |

> 事故 1 与 2 是同一个坑的两面：**不声明 → 跑不起来；声明成硬依赖 → 宿主起不来**。
> 正确位置只有一处：**optional peer + 函数内动态 import + 失败降级**。

### 6.2 其它已归档（产品 / 口径 / 流程）

| 现象 | 根因 | 条款 |
|---|---|---|
| 自检"全绿"但改了代码没生效 | esbuild 悬空 → 构建静默失败 → 测旧产物 | §3.2.1、§7.2 |
| 官方用量一直「未连接」 | 只支持浏览器 `userToken`，桌面端账号会话应用 `x-dsh-auth-token` | §2.3 鉴权矩阵 |
| 接口返回 `INVALID_PARAM` | 时间窗口未对齐（非北京零点） | §2.3 窗口对齐 |
| 表里金额"加不上" | 官方金额与本地推算混在同一张表 | §2.3 口径纪律 |
| 三栏像不在一个平面 | 两个 surface（圆角/阴影不同） | §2.5 |
| 窄栏文字一字一行 | 固定网格 + `auto` 列抢宽 | §2.5 flex-wrap |
| npm 发布 E404 | Trusted Publisher 未绑定（且包名账号不可用） | §5.2、§5.6 |
| 账号材料进了公开仓库 | 未区分"公开文档"与"私密材料" | §2.6 硬红线 |
| 发布后 tag 与 npm 内容不一致 | 先 tag 后 bump | §5.1 |

---

## 7. 环境与工具链规范（本机踩过的坑）

1. **pnpm registry 可能是镜像**
   本机实测指向 `https://repo.harmonyos.com/npm/` → 装 `esbuild` 报 `is not in the npm registry / No authorization header`。
   规范：装包显式 `--registry=https://registry.npmjs.org/`；CI 用官方源。

2. **esbuild 禁止装 `/tmp`**
   系统会清理 `/tmp`，软链悬空后构建失败而烟测测旧产物。
   规范：统一装在持久目录（如 `~/.dsh/tools/esb`），`npm run setup` 负责链接；`build` 失败必须显式报错。

3. **`pnpm add/install` 会清掉手工链接的 `@deepseek-ai/*`**
   `schemastery` / `dsh-home-paths` 来自 DSH 本体，不在公共 registry 的同一位置。
   规范：任何 `pnpm add` 之后**必须**再跑一次 `npm run setup`，否则 `verify-*` 会报「设置 schema 加载失败」。

4. **github.com 网络不稳**：push 失败（`Empty reply` / HTTP2 framing）时改用 `git -c http.version=HTTP/1.1` + 重试；`api.github.com` 通常可用。

5. **看到 `disabling profile plugin row` 的正确解读**（2026-10-18）
   profile 里出现旧版 `@deepseek-ai/*` 副本时，宿主闸门会 disable 关键行，但**报错只说下游 waiting**。处置顺序：
   ① 直跑 host 拿 stderr（`ELECTRON_RUN_AS_NODE=1` + host 入口），**别只看 crash 日志**（它只留 `StartupError.message`）；
   ② 看 profile 顶层有没有 `@deepseek-ai/*`；
   ③ 有 → 某个插件带了硬依赖（§2.7），修正或卸载它；
   ④ 临时把版本对齐只能止血，**不修插件下次还会复发**。

---

## 8. 文档与留痕

- `README`：面向用户（是什么、装什么、怎么用、不同点）。
- `docs/design-vX.md`：面向自己（设计定稿、取舍过程）。
- `CHANGELOG`：面向升级用户（可感知变化 + 迁移提示）。
- 内部调查笔记（竞品、账号、排查过程）→ **私有目录**，不入公开仓库。
- 每次发布在私有目录留一份"版本 + 关键数据截图 + 对账结果"的存档，便于回溯。

---

## 9. 附：两个参考实现

| 插件 | 仓库 | 值得参考的点 |
|---|---|---|
| Token 面板 | `olimc2016/dsh-token-meter-panel`（npm: `dsh-token-mb`） | 多包名派生、官方免登录取数、口径分离、真机预览工具、低余额提醒、面板内改设置 |
| 工作待办 | `olimc2016/dsh-worktodo` | 跨会话持久数据、优先级/截止/项目视图、与 agent 工具联动 |

> 两个插件共同的结论：**把"能自动验证的"都做成脚本**，把"只能人判断的"写成清单；**发版前必须真机看一眼**。
