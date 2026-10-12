# 更新日志

> 本文提到的 `tools/`、`docs/` 等路径都在**仓库**里，不在 npm 发布包内：<https://github.com/olimc2016/dsh-worktodo>

## 0.2.0

> 这一版是**五轮设计评审后的定稿实现**：快速添加按「两行布局 + 边说边解析」重做，参考滴答清单的成熟做法。

### 新增

- **两行布局的快速添加**：第一行「待办内容 + 添加」；第二行**更小**，放「日期 / 时间 / 优先级」三项——
  显示的是**当前值**（如 `2026-10-13`、`15:00`、`优先级 · 无`），点开才出选择器。没有加号，输入框始终在。
- **自然语言日期**（`src/parse-due.mjs`，**人类面板与 `worktodo_*` 工具共用同一份实现**，零依赖）：
  - `今天 / 明天 / 后天 / 大后天`、`周X / 周1 / 星期一 / 礼拜一 / 下周一`、`3天后 / +3d / 五天后`、
    `10月20日 / 2026-10-20`、`今晚 / 明早 / 中午 / 下午`（带默认钟点）、`下午3点 / 3点半 / 15:00 / 上午10点`；
  - **只选时间＝今天**；**识别不到就不设日期**（不硬塞"今天"）；
  - 识别结果**从标题里摘掉**（"交周报 明天下午3点" → 标题「交周报」），并在第二行标 **· 识别**，可点 ✕ 撤销；
  - **保守优先**：`买3个苹果`、`发 2 封邮件` 一律不识别（宁漏不误吞）；
  - 多个星期几取**最后**一个（`周一例会改到周三` → 周三，标题留「周一例会改到」）。
- **四档优先级**：高 / 中 / 低 / **无**（**新建默认「无」**）；排序 高 → 中 → 低 → 无（未定优先级排在最后，但仍在「已完成」之前）。
- **列表行优先级呈现**：高＝红色左缘 + 实心红旗；中＝琥珀旗；低＝灰旗；**无＝什么都不显示**（默认档不制造噪音）。

### 数据模型

- 新增可选字段 `dueTime`（`HH:MM`，必须配 `due`；清掉日期会连带清掉时间）；
- `priority` 新增 `none`；**现有记录（`normal`）保持"中"不变**，不擅自改用户既有语义。

### 说明

- 0.1.6 的「通栏大加号 + 常展开表单」**不是定稿设计，不发布**（留在 npm 暂存队列里未批准）。

## 0.1.6

### 新增

- **大加号 + 日历/时钟 + 彩色小红旗**：新增待办改成「一个大加号按钮」，平时只占一行，点开才展开表单：
  标题、**原生日历选日期**（`type=date`，点一下就是日历）、**原生时钟选时间**（`type=time`，需先选日期）、
  **三个不同颜色的小红旗**选优先级（高=红、普通=琥珀、低=灰），外加「添加 / 取消」两个按钮。
- **截止时间（数据模型）**：新增可选字段 `dueTime`（`HH:MM`），与 `due` 配套：
  - `normalizeDueTime` 接受 `14:30` / `9:05` / `1430` / `14`，非法值显式报错；
  - **没有日期就没有时间**——清掉截止日期会连带清掉时间，避免出现"有时间没日期"的怪状态；
  - 同一天内按时间排序（有时间的在前，没时间的垫后）；
  - 行内编辑也支持时间；`worktodo_add` / `worktodo_add_many` / `worktodo_update` 与工具文本都带上它。

## 0.1.5

### 新增

- **面板角落的版本信息**：页脚显示当前安装的版本（`版本 v0.1.5`）；若有新版，旁边同时出现
  「有新版本 vX.Y.Z」，鼠标悬停给出更新命令。版本由宿主提供（`/worktodo/list` 载荷的 `version` 字段），
  客户端不自己猜。
- **更新检查**（自动更新的可见部分）：宿主在启动后、以及缓存过期时（默认 6 小时）后台查询 npm registry 的
  `dist-tags.latest`；结果**只用于提示**，不下载也不安装，失败静默、绝不阻塞任何请求。
  单元测试用 `WORKTODO_NO_UPDATE_CHECK=1` 完全关掉它（测试不该打网络）。
  自动执行升级（发现新版后后台跑 `dsh plugin add`，重启生效）是下一步。

### 测试

- `smoke-host` 新增 1 例：`/list` 载荷的 `version`/`update` 字段齐全且 `hasUpdate` 在关闭检查时为 false。

## 0.1.4

### 修复（重要）

- **插件时好时坏地加载失败**：`src/store.mjs` 里探测官方存储服务的写法是

  ```js
  ctx.get('storageDomain') ?? ctx.storageDomain   // ← 错
  ```

  当 `storageDomain` **尚未注册**时，`ctx.get()` 返回 `undefined`，于是落到 `ctx.storageDomain`——
  而直接访问未在 `inject` 里声明的服务会被 cordis 守卫**抛错**（`cannot get property "storageDomain" without inject`）。
  异常一路冒到 `apply`，**整个插件挂载失败**：工具消失、路由全 404。
  因为服务注册与服务初始化存在竞态，表现就是「有时能起来、有时起不来」，重启也不一定好。

  现在只保留安全的 `ctx.get('storageDomain')`（探测不到就回退 JSON 文件），并补了回归用例
  ——它用一个「访问 `storageDomain` 就抛错」的假 ctx 模拟 cordis 守卫，**旧写法下这条测试必红**。

## 0.1.3

### 新增

- **排序模式**：面板顶部新增「手动 / 优先级 / 创建时间」三档排序（`worktodo_list` 也开放了同样的 `sort` 参数）。
  - `manual`（默认）：尊重你拖动过的顺序；**没拖过的条目自动退回**优先级 → 截止日期 → 创建时间，所以一上手看到的顺序依然合理；
  - `priority`：高优先级在前，同优先级按截止日期，无日期垫底；
  - `created`：最近添加的在前。
  三种模式都保持「已完成永远沉底」。
- **拖动排序**：按住任意一行拖到目标位置即可调整顺序。拖动时会**自动切到手动模式**（否则松手后看起来"没生效"）；
  落序由宿主在校验后写盘（`POST /worktodo/reorder`，收到完整 id 顺序，只写真正变了的记录）；
  传了不存在的 id 会**显式失败**（`not-found`），不会静默改一半。

### 测试

- `verify-records` 新增 2 例：三种排序模式的顺序、`applyManualOrder` 的纯函数语义（含"没拖过的垫后"）；
- `smoke-host` 新增 2 例：`/list?sort=created` 的顺序、`POST /reorder` 落盘并在 manual 模式生效（含坏 id 的显式失败）。

## 0.1.2

### 新增

- **按项目管理待办**：面板顶部新增「**按截止 / 按项目**」视图切换。
  「按项目」视图里每个项目是一个可折叠分组，标题显示「未完成/总数 · 逾期 N」；
  没写项目的记录归入「未归类」并**永远排在最后**。
  排序规则：未完成多的项目在前 → 未完成里最早截止日期更早的在前 → 名字字典序。
  宿主侧 `/worktodo/list` 新增 `projectGroups` 字段（`groupByProject`），且**不受 `project` 参数收窄**——
  这样面板一次就能拿到全部项目用于切换。

### AI 友好

- **给模型的用法指引**：通过官方 `ctx.systemPrompt.section()` 贡献一段提示（段名 `worktodo:guidance`，
  `order` 取 3050——官方内置工具段是 1000–3000、`MCP_SERVERS` 是 3100，插在两者之间）。
  内容讲清三件事：什么时候该用（用户说出承诺/截止日期，或发现超出本会话、仍需人跟进的待办）、
  什么时候**不该**用（当前任务的步骤拆解属于会话内的 `todo_write`，两者互补）、
  以及「加之前先查重」「做完用 `worktodo_done`」「标题写成祈使句」等约定。
- **批量登记**：新增 `worktodo_add_many`，一次调用登记多条；某条不合法只跳过那一条并把原因回传，
  不影响其余条目（用户一口气说好几件事时省调用）。

### 测试

- `verify-records` 新增 4 例覆盖 `groupByProject`（未归类最后、未完成多者在前、桶内 total/open/overdue、空输入）；
- `smoke-host` 新增 1 例断言 `/list` 载荷确实带 `projectGroups` 且形状正确。

## 0.1.1

### 修复（重要）

- **装出来的插件根本无法启动**：0.1.0 把运行期真正 import 的三个官方平台包（`@deepseek-ai/dsh-tools`、
  `@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-home-paths`）只声明为 `peerDependencies`，
  于是从 npm / GitHub 装出来的包**没有任何可解析的平台包**，DSH 启动时该插件直接加载失败
  （实测：工具全部消失，`worktodo_list` 报 `unknown tool`）。现在改为 `dependencies`——
  实测从 GitHub 安装后，从插件自身位置三个包都能解析。
- **npm 包页面没有 README**：0.1.0 是经「暂存发布」（staged publishing）上线的，而实测那条路径**不会写入 registry 的 `readme` 字段**
  （同机对照：普通 `publish` 的包 `readme` 有 8193 字符，本包 0 字符），于是包页面没有 README。
  本版改为**直接发布**——OIDC 下同样不需要人类 2FA，所以并没有牺牲自动化。

### 文档

- 三份文档（README 中英、CHANGELOG）里补了**绝对仓库地址**的说明：提到 `docs/`、`tools/` 等目录时指向仓库
  （这些文件不在 npm 包内）。npm 页面上的读者因此能找到出处，而不会撞上够不着的路径。
- `publish.yml` 的默认发布方式改为**直接发布**，同时保留手动「暂存 + 网页批准」入口。

## 0.1.0

首个可用版本。

### 核心

- **人机共享的工作待办**：一份逻辑（`src/service.mjs`）同时供侧栏面板与 agent 工具调用，
  所以「面板点完成」和「agent 调 `worktodo_done`」在数据上的行为完全一致。
- **富字段**：优先级（高/普通/低）、截止日期、项目、备注——补上官方 `todo_write`
  只有「内容 + 三态」的空缺。
- **逐项编辑**：按 id、完整标题或唯一标题前缀定位单条修改，不像 `todo_write` 那样整表替换。
- **跨会话持久**：数据不属于任何会话，重启、换会话、换项目都还在。
- **分组视图**：逾期 / 今天 / 本周 / 以后 / 已完成，含统计（未完成 / 逾期 / 今天 / 进行中 / 今日完成）。

### agent 工具

- `worktodo_add` / `worktodo_list` / `worktodo_update` / `worktodo_done` / `worktodo_remove`
- `worktodo_adopt`：把本会话 `todo_write` 的条目提升为工作待办（按标题去重），
  桥接官方会话计划与人的长期列表。

### 存储

- 优先官方 `ctx.storageDomain`（`$DSH_HOME/storages`）：跨重启保留但不进会话事件日志。
- 回退 JSON 文件（`$DSH_HOME/worktodo/todos.json`）：**原子写**（临时文件 + rename）、
  写入串行化、坏文件不静默清空、单条坏记录跳过；文件是人能直接打开手改、能进 git 的形态。
- 支持 `storePath` 配置固定位置；`~` 会展开。

### 兼容与降级

- 目标 **DSH 0.2.x**（0.2.0-rc.2 实测），Node ≥ 22.19.0，`dependencies` 为空。
- 平台包全部声明为**可选 peer**：`tools` 或 `webServer` 缺失时，插件以「少一半能力」的形态继续工作；
  `@deepseek-ai/dsh-tools` 解析不到时只失去工具能力，面板照常可用（日志写明原因）。

### 修复（发布前真机回归发现）

- **工具返回值必须是 lossless JSON**：`worktodo_add` 在不传截止日期时返回了
  `due: undefined`，被 DSH 的返回值校验判为无效，**整次调用被拒**——而「加一条没有截止日期的
  待办」正是最常见的用法（`worktodo_update` 清空截止日期后同理）。已改为可选字段缺席时**删键**
  而不是留 `undefined`。真机重试后暴露的第二个现象见 `docs/verification.md`：
  以 `link:` 安装的插件，源码改动需要**重启**才会换模块 generation。
- 新增可观测性：`/worktodo/health` 现在报告运行中的实际 `version` 与
  `tools: { status, registered, names, error }`——工具静默没注册这类问题不用再翻日志猜。

### 测试（175 例，均不需要启动 DSH）

- `tools/verify-records.mjs`（22）：日期归一化与相对日期、状态/优先级同义词、完成时间维护、
  引用解析（id / 标题 / 前缀 / 歧义）、分组边界（本周日 vs 下周一）、统计口径、筛选、坏记录修复。
- `tools/verify-store.mjs`（11）：官方 `defineDomain` 契约、领域名合法、记录 schema 与官方读取路径一致、
  domain 后端增删改查、文件后端原子写与并发写、坏文件与坏记录容忍、`~` 展开。
- `tools/verify-service.mjs`（18）：显式状态（`empty-title` / `not-found` / `ambiguous-ref` /
  `empty-patch` / `store-unreadable` / `store-write-failed`）、完成与取消完成的 `completedAt` 语义、
  统计不随筛选变化、提升去重、变更通知。
- `tools/smoke-host.mjs`（26）：假 ctx 里跑通 `apply` → 7 条路由 → 服务 → 存储的完整增删改查，
  方法围栏与 `connection` 准入，失败路径（空标题、坏 JSON、未知 filter），health 自检字段，
  7 个工具经**官方 `defineTool`** 校验注册并真实执行，以及 5 条「工具返回值必须无损」的断言——
  判定用的是 **DSH 自己的校验器** `snapshotJsonValue`（来自 `@deepseek-ai/dsh-util-values`，
  就是 `@deepseek-ai/dsh-tools` 报 "value is not lossless JSON" 时用的那一个函数），
  并有一条专门断言「旧写法 `due: undefined` 必须被它拒绝」，用来证明这条守卫确实有牙齿。
- `tools/smoke-contract.mjs`（12）：**客户端 ↔ 宿主契约**。从 `src/client/index.js` 静态提取它实际请求的
  路径与字段名，与宿主真实注册的路由、真正消费的字段比对——防「字段名打错 → 那个功能永远静默失效」
  （例如截止日期永远存不上，而没有任何红灯）；再用客户端字面上的报文形状打真实路由，验证两处清空约定
  （create 用 `due: null`，行内编辑用 `due: ''` / `project: ''`）以及 toggle / adopt / remove / list 的字段完整性。
  已做变异验证：路径改成 `/statuss` 会红 3 条，字段 `due` 改成 `duedate` 会红 1 条。
- `tools/smoke-client.mjs`（14）：客户端 bundle 的模块加载器格式（id 必须等于包名）、
  bundle 只允许 require react（官方规范禁止依赖 Harness 客户端包）、侧栏与主面板注册到正确的 slot
  且 id/key 同名、locale 字典 zh/en 键一一对应、**首屏渲染不抛异常**（白屏是最致命的失败模式）、
  挂载后确实发起 `/worktodo/list` 请求、`useProjection` 缺失或返回空值时安全。
- `tools/verify-submission.mjs`（13）：**收录 PR 的本地门禁**。上游（deepseek1024.com 的目录仓）
  会对提交的 `catalog/plugins/*.json` 跑静态审查并**读仓库核对**，所以先在本地把这些规则跑一遍，
  免得提一个必被拒的 PR：字段集合与 schema 一致、id 与文件名派生规则、`repository`/`name` 与
  `package.json` 一致、`category` 在 11 个法定分类内、`added` 是合法日期、描述里没有最上级措辞。
  另外两条只在 **GitHub 分发路径**下才致命、npm 发布看不出来的检查：`main` / `cordis.patch.yml` /
  `lib/client.js` 等**必须都在 `git ls-files` 里**（git 安装只拿跟踪文件、且不跑构建），
  以及 patch 里那一行的 `name` **必须等于包名**（否则新用户装上去 Loader 解析不到插件）。
