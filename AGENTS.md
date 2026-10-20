# AGENTS.md — dsh-worktodo

> 给编码 agent 的**路由层**：只写「权威文档在哪」和「容易做错的动作」。
> 规则细节看 `docs/process/development-standard.md`。本文件保持 ≤100 行。

## 这个项目是什么
DSH（DeepSeek Harness）的**工作待办**插件：归用户所有、跨会话持久的工作清单（优先级 / 截止 / 项目 / 已过期与本周视图），并与 agent 工具联动。
npm 包名：`dsh-worktodo`（维护者 `olimc2026`，可正常发版）。

## 文件地图（改之前先看这里，别整读大文件）
| 文件 | 职责 |
|---|---|
| `lib/index.js` | 宿主半侧：服务注册、webServer 路由、设置、与 DSH 存储 / 工具对接 |
| `src/service.mjs` | 业务服务：待办 CRUD、视图查询、状态流转 |
| `src/store.mjs` | 持久化（基于 `@deepseek-ai/dsh-storage-domain`），改 schema 要考虑数据迁移 |
| `src/records.mjs` / `src/schema.mjs` | 记录模型与校验 |
| `src/parse-due.mjs` | 截止日期解析（自然语言 → 时间） |
| `src/tools.mjs` | 暴露给 agent 的工具定义 |
| `src/client/**` | 浏览器半侧源码（`React.createElement`，无 JSX） |
| `lib/client.js` | **构建产物，必须入库** |
| `locale/` | 中英文案，改文案要两边同步 |
| `tools/*.mjs` | 构建 + 自检（`verify-all.mjs` 是总入口） |

定位技巧：`grep -n "<关键字>" <文件>`，只读 ±20 行；禁止整读大文件。

## 常用命令
```bash
pnpm install        # 依赖（本仓库用 pnpm workspace；registry 可能是镜像，必要时加 --registry=https://registry.npmjs.org/）
npm run build       # 构建 lib/client.js
npm test            # node tools/verify-all.mjs（含 smoke-host / smoke-client / smoke-contract）
```

## 守卫（这些做错会真的坏）
1. **构建失败必须硬失败**：确认 build 真的产出了新 `lib/client.js`；否则烟测会测旧产物（假绿）。
2. **改了判定逻辑必须反向验证**：故意破坏一次，确认测试变红，再恢复；没验证过的测试不入库。
3. **产物与源码同一次提交**：`lib/client.js` + `.map` 与 `src/` 同 commit。
4. **宿主改动必须重启 DSH 才生效**；只改客户端也要重新 build。
5. **本仓库常有未提交的产物改动**：提交前先 `git status`，**只 `git add` 自己改的文件**，别整仓提交。
6. **公开仓库禁止出现**：账号 / 邮箱 / token / 账号找回材料 / 内部笔记（`publish-checklist.local.md` 是刻意不入库的）。
7. **改存储 schema 必须考虑迁移**：已有用户数据不能丢；不兼容变更要有迁移脚本 + 说明。
8. **文案中英双语同步**：`locale/` 下两份一起改。
9. **webServer 路由写在数组里**：每项结尾是 `}),` 不是 `});`。
10. **发布不可逆**：先 `npm pack --dry-run` 看白名单；发版流程见 `docs/releasing.md`。

## token 预算（单次任务）
≤3 个文件、≤200 行改动；构建 + 全套测试 **1 次**；真机验证 **1 次**（攒批做）；设计稿 ≤2 轮；外部调研 0~1 次。

## 权威文档
- 发版（含 OIDC / staged publish、2FA 说明）：`docs/releasing.md`
- 工程规范：`docs/process/development-standard.md`
- 需求规格模板：`docs/specs/_template.md`
- 设计记录：`docs/design/`；评审记录：`docs/reviews/`
