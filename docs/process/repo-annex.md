# 仓库 annex — dsh-worktodo

> 对应共享正文：`docs/process/development-standard.md`（v1.3，两仓逐字节一致，由文档门禁跨仓校验）。
> 本文件只放**本仓特有的事实**：目录、套件、命令、CI 现状、领域规则、事故索引。与正文冲突时以正文规则为准；本文件描述现状与差异。
> 维护：目录 / 套件 / 命令 / CI / 领域规则变化时同步改这里；文档门禁会校验本文件引用的路径与脚本真实存在。

## 1. 这个仓库是什么

DSH（DeepSeek Harness）的**工作待办**插件：归用户所有、跨会话持久的工作清单（优先级 / 截止日期 / 项目 / 已过期与本周视图），agent 通过 `worktodo_*` 工具读写同一份列表。官方 `todo_write` 属于单个会话且只能整表替换，这份列表属于人。

- npm 包名：`dsh-worktodo`，发布账号 `olimc2026`（npm），仓库 `olimc2016/dsh-worktodo`（GitHub）。
- 单包名仓库 → 正文 §2.2（多包名）**不适用**。
- 版本与发布记录：`CHANGELOG.md`、`docs/releasing.md`。

## 2. 目录与文件地图

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 宿主半侧：服务注册、webServer 路由、设置、与 DSH 存储 / 工具对接 |
| `lib/client.js` / `lib/client.js.map` | **构建产物，必须入库**；改 `src/client/**` 必须重新构建 |
| `src/service.mjs` | 业务服务：待办 CRUD、视图查询、状态流转 |
| `src/store.mjs` | 持久化（基于 `@deepseek-ai/dsh-storage-domain`）；改 schema 必须考虑迁移 |
| `src/records.mjs` / `src/schema.mjs` | 记录模型与校验 |
| `src/parse-due.mjs` | 截止日期解析（自然语言 → 时间） |
| `src/tools.mjs` | 暴露给 agent 的工具定义 |
| `src/client/index.js` | 浏览器半侧源码（`React.createElement`，无 JSX） |
| `locale/zh.json` / `locale/en.json` | 中英文案，改文案两边同步 |
| `tools/apply-update.mjs` | 运行时独立安装器（**唯一进发布包的 tools 文件**） |
| `tools/build-client.mjs` | esbuild 打包 `lib/client.js` |
| `tools/verify-all.mjs` | 全量自检入口：先构建，再按顺序跑全部 suite |
| `tools/verify-records.mjs` / `verify-service.mjs` / `verify-store.mjs` | 纯逻辑回归：数据模型 / 服务层 / 存储层（含迁移与备份） |
| `tools/smoke-host.mjs` | 宿主烟测：路由、设置、工具、自升级、跨平台模拟 |
| `tools/smoke-contract.mjs` | 客户端 ↔ 宿主契约 |
| `tools/smoke-client.mjs` | 客户端 bundle 烟测（桩 React + 迷你渲染器） |
| `tools/verify-workflows.mjs` | CI workflow 契约 |
| `tools/verify-privacy.mjs` | 发布面审计（隐私 + 发布包边界） |
| `tools/verify-submission.mjs` | 发布面断言（平台包 / 依赖面 / import 形态 / 收录条目） |
| `tools/verify-docs.mjs` | 文档引用存在性 + 跨仓共享正文同步 |
| `tools/verify-meta.mjs` | 版本字面量元测试（含边界自测与反向自测） |
| `tools/preflight.mjs` | 发版前一键：全量自检 + 发布面 + 人工清单 |
| `docs/releasing.md` | 发版手册（OIDC / 暂存发布 / 2FA） |
| `docs/postmortems/incident-ledger.md` | 事故总账（L01–L12 全文） |
| `docs/reviews/` | 每次评审 / 复盘的记录 |
| `docs/specs/_template.md` | 需求规格模板（何时必须写见正文 §7.2） |

定位技巧：`grep -n "<关键字>" <文件>`，只读 ±20 行；不要整读 `lib/index.js` 或 `tools/smoke-*.mjs`。

## 3. 命令表

`node` / `npm` 不在 PATH 时（DSH 桌面端常态）：

```bash
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
```

| 目的 | 命令 |
|---|---|
| 全量自检（**12 步** = 构建 + 11 个 suite） | `"$NODE" tools/verify-all.mjs; echo "exit=$?"` 或 `npm test` |
| 只构建客户端 bundle | `npm run build` |
| 发版前一键（全量 + 发布面 + 人工清单） | `npm run preflight; echo "exit=$?"` |
| 发布面断言（平台包 / 依赖面 / import 形态 / 安装器在包里） | `"$NODE" tools/verify-submission.mjs; echo "exit=$?"` |
| 发布包隐私与边界 | `"$NODE" tools/verify-privacy.mjs; echo "exit=$?"` |
| CI workflow 契约 | `"$NODE" tools/verify-workflows.mjs; echo "exit=$?"` |
| 文档引用 / 跨仓同步 | `"$NODE" tools/verify-docs.mjs; echo "exit=$?"` |
| 版本字面量元测试 | `"$NODE" tools/verify-meta.mjs; echo "exit=$?"` |

suite 顺序：`verify-records` → `verify-service` → `verify-store` → `smoke-host` → `smoke-contract` → `smoke-client` → `verify-docs` → `verify-meta` → `verify-workflows` → `verify-privacy` → `verify-submission`。

> 全量自检**不联网**：`verify-all` 在 spawn 前注入 `WORKTODO_NO_UPDATE_CHECK=1`，各 suite 不得真实出网。

## 4. 领域规则（正文 §2.3 的本仓落地）

- **存储单一真源**：官方 storage 打不开时**不再静默回退文件写入**；回退文件已退役（哨兵 / `movedTo`），`store.kind` / `mismatch` 必须进 `/health` 与 `/list`。
- **写路径**：写前备份 + 原子写 + 合并事务回滚 + 退役标记；删除后第二次合并不许「复活」。
- **schema 变更**：已有用户数据不能丢；不兼容变更要有迁移脚本 + 说明 + 迁移测试。
- **待办语义**：优先级 / 截止日期 / 项目 / 已过期与本周视图；agent 通过 `worktodo_*` 工具读写同一份数据。
- **UI**：行内编辑（日期 / 标题 / 项目）用乐观更新 + 失败回滚 + 温和提示；布局固定列宽避免跳动（历史事故见 `docs/reviews/`）。
- **webServer 路由写在数组里**：每项结尾是 `}),` 不是 `});`（写错整文件语法错误）。
- **文案中英双语**：`locale/zh.json` 与 `locale/en.json` 一起改。

## 5. CI 现状

- `.github/workflows/test.yml`：ubuntu-latest，Node 22 / 24 矩阵；步骤 = 安装 → 构建 → 全量自检 → 打包清单检查。
- **Windows 观测 job**：`continue-on-error: true`（允许失败），只跑 `verify-docs` / `verify-meta` / `verify-workflows` 三个纯文本 / 结构 suite。转正条件：全量 suite 在 Windows 连续绿 N 次后去掉 `continue-on-error`（正文 §3.3 已登记为缺口）。
- `.github/workflows/publish.yml`：推 tag 默认走**暂存发布**（`npm stage publish`），批准在 npm 网页完成；`npm install -g npm@latest` 必须在 `setup-node` 之后（由 `verify-workflows` 断言）。

## 6. 本仓已知缺口（补充正文 §3.3）

- **没有版式预览工具**（另一个插件仓有 `tools/preview.mjs`）：版式改动靠真机截图 + 真机重启验证。
- **真 React + DOM 未落地**：`smoke-client` 用自写迷你渲染器（含错误边界与位置化 hook），不覆盖 `setState` 重渲染。
- **profile / 宿主升级模拟仍手工**：`npm run preflight` 会打印这两项人工清单，不会替你跑。
- **发布包文件数区间**：`verify-privacy` 要求 >10 且 <40；新增发布文件时先看清单（正文 §5.8）。

## 7. 事故索引（本仓相关）

> 全文（症状 / 根因 / 影响面 / 怎么发现 / 修复 / 防线 / 报告链接）：`docs/postmortems/incident-ledger.md`。**新事故先写总账，再改正文，再加断言**；编号递增、不复用。

### 7.1 八条主事故（症状 → 根因 → 怎么自动拦住）

| # | 事故（症状） | 根因 | 怎么自动拦住（对应断言 / 闸门） |
|---|---|---|---|
| 1 | 插件装了**跑不起来**：工具 / 面板不出现 | 代码 import 了平台包，但清单里没声明 → 解析失败 | `verify-submission`：动态 import 的 bare 包集合 == peer 声明；`smoke-host`：无平台包时 `apply()` 不抛并输出 `RESILIENT_OK` |
| 2 | **宿主启动失败**：`1 required plugin did not activate` + 多个插件 waiting | `dependencies` 装出第二份平台包 → hoisted 摊平 → 旧副本抢先解析 → 兼容性闸门 disable 关键行 | `verify-submission` 四条 + 反向自检 + `prepublishOnly`；发版前 §4.1 profile 模拟；宿主升级后 §4.2 |
| 3 | 存储后端**静默降级** → 待办「分裂」成两份 | 官方 storage 打不开时静默回退文件，两处都写，谁也不报 | 单一真源 + 回退文件退役 + `store.kind` 进 `/health` / `/list`；`verify-store`：退役后不复活、不静默读回；`smoke-client`：告警真的渲染出来 |
| 4 | 坏文件被写入覆盖 / **已删待办复活** | 直接覆盖写；合并中途失败无回滚；回退文件还被当数据源 | 写前备份 + 原子写 + 合并事务回滚 + 退役标记；`verify-store` 四个用例 + 反向验证 |
| 5 | 面板**黑屏**（整块白） | 渲染期 `ReferenceError`（轴标签 `map` 缺参数），假渲染到不了该分支 | 真渲染一次 + 错误边界（中文兜底 + 堆栈只进 console）；反向验证：摘掉边界必须红 |
| 6 | CI **假绿 / 假红** | ①不 build 就测旧产物 ②夹具写死版本号 ③ESM import 提升让环境变量失效 ④锁文件 / 解析参数没固化 | `verify-all` 先 build、失败即红；版本常量派生 + 元测试扫源码 + 边界自测；环境开关调用时读 + 父进程注入 + 慢 registry 时序用例；显式退出码 + 双环境 |
| 7 | Windows 自更新**无效**（版本一直不变） | 裸 `spawn` 不认 `.cmd` + 自带 pnpm 路径猜错 + CLI 退出码 0 但 `added 0` | 执行器优先 `node + 脚本`、兜底 `.cmd + shell`（平台模拟用例）；「落盘版本变了才算成功」；失败诊断带 argv / 退出码 / 日志 |
| 8 | 自更新**写坏 profile** / 装到一半 | 非原子写、回滚漏 lockfile、卸载后仍起子进程、超时只杀直接子进程、启动期自动安装 | 独立安装器 + 原子替换 + 失败回滚 + 树杀 + `disposed` 零写盘；`smoke-host` 相关用例 + 反向验证 |

> 事故 1 与 2 是同一个坑的两面：**不声明 → 跑不起来；声明成硬依赖 → 宿主起不来**。正确位置只有一处：**optional peer + 函数内动态 import + 失败降级**。

### 7.2 2026-10 批次总账索引（L01–L12）

| 编号 | 一句话 | 条款 | 主防线现状 |
|---|---|---|---|
| L01 | 平台包未声明 → 插件装了跑不起来 | §2.7、7.1 行 1 | ✅ 自动 |
| L02 | 平台包进 `dependencies` → hoisted 第二份 → 闸门 disable → **桌面版起不来** | §2.7、§4.1、§4.2、7.1 行 2 | ⚠️ 静态断言自动 + profile / 升级模拟手工 |
| L03 | 存储静默降级 → 待办数据分裂 | §2.10、7.1 行 3 | ✅ 自动 |
| L04 | 坏文件覆盖 / 已删待办复活 | §2.12、7.1 行 4 | ✅ 自动（无墓碑，见总账残留） |
| L05 | 未定义标识符 → 面板黑屏 | §3.2.10、§3.3、7.1 行 5 | ⚠️ 迷你渲染器 + 边界；无真 React / `setState` |
| L06 | CI 假绿 / 假红 | §3.2.6–§3.2.8、7.1 行 6 | ⚠️ 自动化强，双环境靠人 |
| L07 | Windows 自更新无效 | §2.12、§3.4、7.1 行 7 | ⚠️ 模拟自动，无真机 Windows |
| L08 | 自更新写坏 / 杀不干净 | §2.12、7.1 行 8 | ✅ 自动（模拟）；旧事务用例随旧路径退场 |
| L09 | 检查更新超时误报「失败」+ 原始异常怼到面板 | §2.14、7.1 行 6 | ✅ 自动 |
| L10 | `link:` 安装报「更新失败」 | §2.13 | ✅ 自动 |
| L11 | 点安装后黑屏（在 live profile 跑 pnpm） | §2.12、§4.4 | ✅ 自动（假 profile）；无真机 Windows |
| L12 | 流程 / 工程失误六条（元测试自撞、9/10 发布、并发写、隐私误报、docs 进包、发布流水线） | §3.2.11–§3.2.15、§5.8 | ⚠️ 部分；并发写与部分发布约束仍是人工 |

> 图例：✅ 自动（有断言且做过反向验证）/ ⚠️ 半自动或手工 checklist / ❌ 缺口。**手工 checklist 不许写成「已拦住」。**
