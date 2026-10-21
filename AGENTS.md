# AGENTS.md — dsh-worktodo

> 给编码 agent 的**路由层**：只写「权威文档在哪」和「容易做错的动作」。
> 规则细节看 `docs/process/development-standard.md`（共享正文，两仓同步）+ `docs/process/repo-annex.md`（本仓事实）。本文件保持 ≤100 行。

## 这个项目是什么
DSH（DeepSeek Harness）的**工作待办**插件：归用户所有、跨会话持久的工作清单（优先级 / 截止日期 / 项目 / 已过期与本周视图），agent 通过 `worktodo_*` 工具读写同一份列表。
npm 包名 `dsh-worktodo`（npm 账号 `olimc2026`，GitHub `olimc2016/dsh-worktodo`）。单包名仓库。

## 文件地图（改之前先看这里，别整读大文件）
| 文件 | 职责 |
|---|---|
| `lib/index.js` | 宿主半侧：服务注册、webServer 路由、设置、与 DSH 存储 / 工具对接 |
| `src/service.mjs` | 业务服务：待办 CRUD、视图查询、状态流转 |
| `src/store.mjs` | 持久化（`@deepseek-ai/dsh-storage-domain`）；改 schema 要考虑迁移 |
| `src/records.mjs` / `src/schema.mjs` | 记录模型与校验 |
| `src/parse-due.mjs` | 截止日期解析（自然语言 → 时间） |
| `src/tools.mjs` | 暴露给 agent 的工具定义 |
| `src/client/index.js` | 浏览器半侧源码（`React.createElement`，无 JSX） |
| `lib/client.js` (+ `.map`) | **构建产物，必须入库**；改客户端必须重新构建 |
| `locale/` | 中英文案，改文案两边同步 |
| `tools/apply-update.mjs` | 运行时独立安装器（**唯一进发布包的 tools 文件**） |
| `tools/*.mjs` | 构建 + 自检（`verify-all.mjs` 是总入口，12 步） |

定位技巧：`grep -n "<关键字>" <文件>`，只读 ±20 行；禁止整读 `lib/index.js` / `tools/smoke-*.mjs`。

## 常用命令
`node` / `npm` 可能不在 PATH（DSH 桌面端常态）：

```bash
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node

"$NODE" tools/verify-all.mjs; echo "exit=$?"   # 全量：构建 + 11 个 suite = 12 步，看退出码
npm test                                       # 等价（npm 可用时）
npm run preflight                              # 发版前一键（全量 + 发布面 + 人工清单）
npm run build                                  # 只构建 lib/client.js
"$NODE" tools/verify-docs.mjs; echo "exit=$?"  # 文档引用 + 跨仓同步（改文档后必跑）
```

## 守卫（这些做错会真的坏）
1. **构建失败必须硬失败**：确认 build 真的产出了新 `lib/client.js`；否则烟测在测旧产物（假绿）。
2. **改了判定逻辑必须反向验证**：故意破坏一次，确认测试变红，再恢复；没验证过的测试不入库。
3. **产物与源码同一次提交**：`lib/client.js` + `.map` 与 `src/` 同 commit。
4. **宿主改动必须重启 DSH 才生效**；只改客户端也要重新 build。
5. **本仓库常有未提交的产物改动**：提交前先 `git status`，**只 `git add` 自己改的文件**，别整仓提交。
6. **公开仓库禁止出现**：账号 / 邮箱 / token / 账号找回材料 / 内部笔记（`publish-checklist.local.md` 是刻意不入库的）。
7. **改存储 schema 必须考虑迁移**：已有用户数据不能丢；不兼容变更要有迁移脚本 + 说明。
8. **文案中英双语同步**：`locale/` 下两份一起改。
9. **webServer 路由写在数组里**：每项结尾是 `}),` 不是 `});`。
10. **发布不可逆**：先 `npm pack --dry-run` 逐条看白名单；发版走暂存 + 网页 Approve（`docs/releasing.md`）。
11. **文档引用必须真实存在**：文档里的路径 / 脚本 / 命令写之前先确认存在；改共享正文必须两仓同改，否则 `verify-docs` 变红。
12. **spec 政策**：跨会话数据 / schema / 安装升级 / 发布流程 / 口径类改动必须先写一页 spec（`docs/specs/_template.md`）；纯 UI 微调可只写 review。

## token 预算（单次任务）
一个功能点或一个 bug；**代码改动 ≤200 行**（测试、文档、构建产物不计）；构建 + 全套自检 **1 次**；真机验证 **1 次**（攒批做）；设计稿 ≤2 轮；外部调研 0~1 次。

## 权威文档
- 工程规范（共享正文）：`docs/process/development-standard.md`
- 本仓 annex（目录 / 套件 / 命令 / CI / 领域规则 / 事故索引）：`docs/process/repo-annex.md`
- 发版手册：`docs/releasing.md`
- 需求规格模板：`docs/specs/_template.md`
- 事故总账：`docs/postmortems/incident-ledger.md`；评审记录：`docs/reviews/`
