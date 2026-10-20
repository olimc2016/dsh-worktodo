# 工作待办 · dsh-worktodo

**归你所有、跨会话持久的工作待办。** DSH 侧栏一个独立面板，agent 通过 `worktodo_*` 工具读写**同一份**列表。

> 兼容 **DSH 0.2.x**（0.2.0-rc.2 实测）· 运行期只依赖 **3 个官方平台包**（无任何第三方依赖）· 社区插件，非官方

> **关于本文里的路径**：提到 `docs/`、`tools/` 等目录时，指的是**仓库**里的文件——它们不在 npm 发布包内。
> 仓库地址：<https://github.com/olimc2016/dsh-worktodo>

---

## 它解决什么问题

DSH 自带的 `todo_write` 是**当前这个 agent 会话**的计划：整表替换、只有 `pending / in_progress / completed` 三态、**只属于那一个会话**。官方文档写得很直白——「任务列表属于创建它的那一个 agent 会话……不存在跨 agent 共享列表的方式」，而且**没有优先级、没有截止日期、没有项目、没有逐项编辑**。会话一关，那份计划就翻篇了。

于是真实工作里那些「明天还得接着办」的事没有地方放：等对方回复、等评审、下周要交的东西、这个月要跟的活。

**这份列表是给人的**：有优先级、截止日期、项目和备注，跨会话、跨项目一直在；agent 能读能写，但真源在你手里。

| | 官方 `todo_write` | **dsh-worktodo** |
|---|---|---|
| 归属 | 单个 agent 会话 | **你**（跨会话、跨项目） |
| 更新方式 | 整表替换 | **逐项增删改** |
| 字段 | 内容 + 三态 | 内容 + **优先级 + 截止日期 + 项目 + 备注** |
| 跨 agent 共享 | ❌ 官方明确不支持 | ✅ 同一份列表，人与 agent 都读写 |
| 视图 | 会话内清单 | **已过期 / 今天 / 明天 / 本周 / 以后 / 已完成** 分组 + 统计 |
| 数据位置 | 会话事件日志 | `$DSH_HOME/storages`（官方 storage）或 `~/.dsh/worktodo/todos.json` |

两者不冲突：`worktodo_adopt` 可以把你这个会话的 `todo_write` 里值得留下的条目**一键提升**成工作待办。

## 安装

**方式一：直接从 GitHub 装**（不依赖 npm 上的包；装完重启 DSH）

```bash
dsh plugin --profile desktop add github:olimc2016/dsh-worktodo
```

这条路是实测过的（见 `docs/verification.md`）：仓库里提交了浏览器半侧的构建产物 `lib/client.js`，
包内没有 `prepare`/`install` 这类构建脚本，所以 **git 安装不需要任何构建授权**，也不会把开发依赖装进来
——实测（从 GitHub 安装）：顶层只解析 **1 个包**（本插件本身），三个官方平台包由 DSH 运行时从安装目录提供、
不会在 profile 里再装一份；包内含已构建的 `lib/client.js`，**无需构建授权**。

> **为什么平台包是 optional peer 而不是 `dependencies`**：0.1.0 只声明 peer 时，旧版 DSH（0.2.1 之前）
> 没有 installation 拦截层，装出来解析不到平台包、插件整个加载失败（工具全部消失）；0.1.1 因此改成了
> `dependencies`。但 0.2.1 起宿主自己提供这些包，插件再带一份就会在 profile 里装出**第二份**、与宿主版本
> 混用（2026-10-17 桌面版「required plugin did not activate」正是它）。0.2.7 起改回 **optional peer**：
> 平台包从 DSH 安装目录解析，解析不到时只降级成「只有面板」，不会连累宿主
> （三个平台包全部是函数内动态 import + catch，模块求值阶段不碰它们）。
> 证据与实测见 `docs/reviews/duplicate-platform-packages.md`。

**方式二：从 npm 装**（包发布后可用）

```bash
dsh plugin --profile desktop add dsh-worktodo
```

**方式三**：在 DSH 侧栏「插件 → 添加插件」里填 `dsh-worktodo` 或仓库地址。

装好后侧栏会多一个**「待办」**入口，设置 → 插件里也能看到它。

## 用起来

**面板**：顶部是统计（未完成 / 已过期 / 今天 / 进行中 / 今日完成），中间是快速添加框（标题 + 截止日期 + 优先级，回车即存），下面是分组列表。每行可以直接勾完成、点标题行内改、删除（二次确认）。

**agent 工具**：模型可以自己登记、查询、推进和归档工作待办，不需要你转述。

| 工具 | 用途 |
|---|---|
| `worktodo_add` | 登记一件事（可带截止日期、优先级、项目、备注） |
| `worktodo_list` | 查列表：`open` / `today` / `overdue` / `week` / `doing` / `completed` / `all`，可按项目或关键词过滤 |
| `worktodo_update` | 逐项修改（不会像整表替换那样动到别的条目） |
| `worktodo_done` | 标完成，或标回进行中 / 待办 |
| `worktodo_remove` | 删除（做完的事请用 `worktodo_done` 留痕） |
| `worktodo_adopt` | 把本会话 `todo_write` 的条目提升为工作待办，按标题去重 |

给 agent 的一句话就能用起来：

> 「把今天要跟进的三件事记到工作待办里，明天上午的标高优先级。」

## 数据存在哪

按优先级自动选择，`/worktodo/health` 与面板底部都会显示当前实际位置：

1. **官方 storage**（`ctx.storageDomain`，DSH 默认挂载）——数据落在 `$DSH_HOME/storages`。
   这是官方给「插件自有、跨重启保留、不进会话事件」的数据指定位置：几十条待办不必变成会话历史。
2. **JSON 文件回退**——`$DSH_HOME/worktodo/todos.json`。storage 服务缺失的精简组合里自动走这条路；
   这个文件**是人能直接打开、手改、进 git** 的形态，写坏了也不会被静默清空（单条坏记录跳过，其余照常读出）。

想在 `cordis.patch.yml` 里固定路径（例如放进自己的笔记仓库）：

```yaml
- id: worktodo
  name: 'dsh-worktodo'
  config:
    storePath: /Users/me/notes/worktodo.json
```

**升级后回退文件会退役**：一旦数据成功合并进官方 storage，`$DSH_HOME/worktodo/todos.json` 会被改名成
`todos.json.migrated-<时间>`（完整存档，可随时手动查看/恢复），同目录另留一个 `todos.json.retired` 哨兵。
退役之后官方 storage 是唯一真源：如果那套组合里没有 `storageDomain`，面板会**明确报错**（不会显示空列表冒充
「还没有待办」），页脚也会写清「官方存储不可用 · 回退文件已退役」。

## 兼容

- **DSH 0.2.x**（官方版本闸门会把锁在旧版本的插件拒掉，本插件按 0.2.0-rc.2 的 API 编写并实测）
- **Node ≥ 22.19.0**
- `dependencies` 为空：不装任何运行期 npm 包。平台包（`@deepseek-ai/dsh-tools`、
  `dsh-storage-domain`、`dsh-home-paths`）都声明为**可选 peer**——DSH 自带这些包，从安装目录解析；
  真解析不到时插件会降级成「只有面板」而不是加载失败（日志里会写一行原因）。

## 开发

```bash
pnpm install            # esbuild 用预编译二进制，无需 approve-builds
pnpm run build          # 打 lib/client.js（浏览器半侧）
pnpm test               # 155 个用例：数据模型 / 存储 / 服务 / 宿主接线与工具 / 客户端↔宿主契约 / 客户端 bundle / CI 契约 / 隐私门禁 / 收录门禁
pnpm run watch          # 改客户端时增量构建
```

发版流程（Trusted Publishing + 暂存批准）见仓库里的 `docs/releasing.md`：

```bash
```

测试策略：不用启动 DSH 就能跑完——
`verify-records`（纯数据）、`verify-store`（真实文件 IO + **官方 `defineDomain` 契约校验**）、
`verify-service`（显式状态与边界）、`smoke-host`（假 ctx 里跑通 apply → 路由 → 服务 → 存储，
以及工具注册与执行，工具 schema 由**官方 `defineTool`** 校验）、
`smoke-contract`（从客户端源码提取它实际发的路径与字段，与宿主真实路由比对——防字段名打错导致的
静默失效，例如截止日期永远存不上）、`smoke-client`（bundle 格式、slot 注册、首屏渲染不抛异常）、`verify-submission`
（收录 PR 的本地门禁：字段/文件名/分类/日期 + 「git 安装必需的文件是否都已入库」这类只在 GitHub
分发路径下才致命的检查）。

## License

MIT © 2026 oli20
