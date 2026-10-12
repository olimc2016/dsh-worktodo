# 更新日志

> 本文提到的 `tools/`、`docs/` 等路径都在**仓库**里，不在 npm 发布包内：<https://github.com/olimc2016/dsh-worktodo>

## 0.1.2

### 新增

- **按项目管理待办**：面板顶部新增「**按截止 / 按项目**」视图切换。
  「按项目」视图里每个项目是一个可折叠分组，标题显示「未完成/总数 · 逾期 N」；
  没写项目的记录归入「未归类」并**永远排在最后**。
  排序规则：未完成多的项目在前 → 未完成里最早截止日期更早的在前 → 名字字典序。
  宿主侧 `/worktodo/list` 新增 `projectGroups` 字段（`groupByProject`），且**不受 `project` 参数收窄**——
  这样面板一次就能拿到全部项目用于切换。

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

### 测试（166 例，均不需要启动 DSH）

- `tools/verify-records.mjs`（22）：日期归一化与相对日期、状态/优先级同义词、完成时间维护、
  引用解析（id / 标题 / 前缀 / 歧义）、分组边界（本周日 vs 下周一）、统计口径、筛选、坏记录修复。
- `tools/verify-store.mjs`（11）：官方 `defineDomain` 契约、领域名合法、记录 schema 与官方读取路径一致、
  domain 后端增删改查、文件后端原子写与并发写、坏文件与坏记录容忍、`~` 展开。
- `tools/verify-service.mjs`（18）：显式状态（`empty-title` / `not-found` / `ambiguous-ref` /
  `empty-patch` / `store-unreadable` / `store-write-failed`）、完成与取消完成的 `completedAt` 语义、
  统计不随筛选变化、提升去重、变更通知。
- `tools/smoke-host.mjs`（26）：假 ctx 里跑通 `apply` → 7 条路由 → 服务 → 存储的完整增删改查，
  方法围栏与 `connection` 准入，失败路径（空标题、坏 JSON、未知 filter），health 自检字段，
  6 个工具经**官方 `defineTool`** 校验注册并真实执行，以及 5 条「工具返回值必须无损」的断言——
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
