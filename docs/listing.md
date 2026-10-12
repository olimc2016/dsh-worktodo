# 上架文案（0.1.0）

市场收录一般抓 `package.json` 的 `description` 与仓库 README 首屏。下面两段是给目录源/表单用的简短文案，按需复制。

> 2026-10 观察：DSH 主线进入 0.2.x 后，一批同类插件被版本闸门拒绝；同期有人在大批「占名」
> （npm 上 `dsh-planner`、`dsh-focus`、`dsh-checklist`、`dsh-standup`、`dsh-tasks`、`dsh-workdesk`
> 全是 v0.0.1 且描述写着 "Name reserved; first release in development"）。
> 所以文案把「兼容 0.2.x / 运行期只依赖 3 个官方平台包 / 归人所有而非属于会话」这三条提到最前面——它们是当前最有效的差异点。

---

## 中文

**名称**：工作待办（dsh-worktodo）

**一句话**：兼容 DSH 0.2.x、运行期只依赖 3 个官方平台包的工作待办面板——优先级、截止日期、项目、逾期与本周视图，agent 通过 `worktodo_*` 工具读写**同一份**列表。

**简介（约 150 字）**：
官方 `todo_write` 是**单个 agent 会话**的计划：整表替换、只有三态、官方明说「不存在跨会话共享列表的方式」，
也没有优先级和截止日期。那些「明天还得接着办」的事因此没有地方放。
`dsh-worktodo` 补的就是这块：侧栏独立面板 + 一组 agent 工具，**列表归人所有**，
跨会话、跨项目一直在，字段有优先级 / 截止日期 / 项目 / 备注，
视图按**逾期 / 今天 / 本周 / 以后 / 已完成**分组并给出统计。
装得上：**兼容 DSH 0.2.x**、`dependencies` 为空、平台包全是可选 peer，
`dsh-tools` 解析不到时降级成「只有面板」而不是加载失败。
数据优先落官方 `ctx.storageDomain`，缺失时回退**可读的 JSON 文件**（原子写、能手改、能进 git）。

**分类**：任务管理 / 侧栏面板 / Web UI

**安装**（两条；GitHub 那条**已实测**可用，见 `docs/verification.md`——顶层 1 个包 + 3 个官方平台包、约 12 MB、无需构建授权）：

```bash
dsh plugin --profile desktop add github:olimc2016/dsh-worktodo   # 不依赖 npm 包
dsh plugin --profile desktop add dsh-worktodo                    # npm 包发布后
```

**亮点**：
1. **装得上**：兼容 DSH 0.2.x（0.2.0-rc.2 实测）；同类插件不少仍锁在 0.1.x 会被版本闸门拒绝
2. **运行期只依赖 3 个官方平台包**（`@deepseek-ai/dsh-tools` / `dsh-storage-domain` / `dsh-home-paths`），**无任何第三方依赖**
3. **归人所有**：跨会话、跨项目持久，重启与换会话都还在——与「会话一关就翻篇」的 `todo_write` 互补
4. **逐项编辑**：按 id / 完整标题 / 唯一标题前缀定位单条修改，不会像整表替换那样动到其他条目
5. **富字段**：优先级（高/普通/低）、截止日期（支持 `today` / `tomorrow` / `+3d` 这类相对写法）、项目、备注
6. **逾期与本周视图**：分组 + 统计（未完成 / 逾期 / 今天 / 进行中 / 今日完成）
7. **一份逻辑两个调用方**：面板按钮与 agent 工具共用同一套服务方法，行为与失败原因完全一致
8. **数据你能直接看**：优先官方 storage；回退时是缩进过的 JSON，坏文件不静默清空、单条坏记录跳过
9. **降级而非崩溃**：缺 `tools` / `webServer` / storage 的组合里照常工作，日志写明原因
10. **可被验证**：166 个用例不用启动 DSH 就能跑（含官方 `defineDomain` 契约与官方 `defineTool` 的工具 schema 校验）

**关键词**：待办、工作待办、todo、task、优先级、截止日期、逾期、项目、面板、DSH 0.2、跨会话、agent 工具

---

## English

**Name**: Work Todo (dsh-worktodo)

**One-liner**: A DSH 0.2.x-compatible, zero-dependency work todo panel — priorities, due dates, projects, overdue/this-week views, with `worktodo_*` tools so your agent reads and writes the **same** list.

**Summary (~110 words)**:
DSH's `todo_write` is one agent session's plan: whole-list replacement, three states, and officially no way to share a list across agents — no priority, no due date. So the work that must survive the session has nowhere to live.
`dsh-worktodo` is the human-owned counterpart: a sidebar panel plus agent tools over one persistent, cross-session, cross-project list with priorities, due dates, projects and notes, grouped into overdue / today / this week / later / done with stats.
It installs: DSH 0.2.x, empty `dependencies`, all platform packages optional peers, and it degrades to panel-only instead of failing to load. Data goes to the official `ctx.storageDomain`, or a readable JSON file (atomic writes, hand-editable, git-friendly) when storage is absent.

**Categories**: Task management / Sidebar panel / Web UI

**Highlights**:
1. Installs on DSH 0.2.x (tested on 0.2.0-rc.2); many peers are still pinned to 0.1.x and rejected by the version gate
2. No runtime npm dependencies at all
3. Human-owned: persists across sessions and projects, unlike a per-session plan
4. Per-item edits — touching one todo never rewrites the others
5. Priorities, due dates (including `today` / `tomorrow` / `+3d`), projects, notes
6. Overdue and this-week views with live stats
7. One implementation, two callers: the panel and the agent tools share the same service methods
8. Your data is inspectable; a corrupted file is never silently wiped
9. Degrades instead of crashing when a service is missing
10. 166 test cases run without launching DSH, including a genuine `defineDomain` contract check, tool schemas validated by the official `defineTool`, and a local gate for the catalog submission

**Keywords**: todo, todo list, task, work todo, priority, due date, deadline, overdue, project, panel, DSH 0.2, cross-session, agent tools

---

## 提交清单（发布后核对）

- [ ] `npm publish` 成功，`npm view dsh-worktodo version` 返回 0.1.0
- [ ] GitHub 仓库公开，README 首屏有**真机截图**（安装后在面板上截，不要用模拟图）
- [ ] 仓库打 tag `v0.1.0` 并建 Release（正文用 CHANGELOG 的 0.1.0 段落）
- [ ] 仓库加 GitHub 话题 **`dsh-plugin`**（这是官方唯一的「收录」机制，没有表单、没有审核）
- [ ] 在 npm 包设置里绑定 Trusted Publisher（olimc2016 / dsh-worktodo / publish.yml），之后推 tag 即可自动发版
- [ ] 向目标目录源提交条目：deepseek1024.com 的提交入口、dsh-plugin.org 的 `/zh/submit`，
      以及 star 较多的 awesome 清单仓库（各家的收录要求与表单地址不同，逐个看 README）
- [ ] 用干净环境验证一次安装：`dsh plugin --profile <新 profile> add dsh-worktodo` + 重启
