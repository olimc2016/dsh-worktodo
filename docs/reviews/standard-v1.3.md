# 开发规范 v1.2 → v1.3 审计与改动记录

- 日期：2026-10-21
- 触发：维护者提问「现在的开发规范是怎样的，需不需要优化」
- 结论：**需要优化，不需要重写**。规范底子好（事故驱动、自动闸门、缺口自曝），问题集中在「文档写的」与「代码/CI 实际做的」之间的漂移、两份规范分叉、以及几处只能靠人的门禁。
- 方法：两路只读审计（工具链防线 / 两仓文档对比）+ 维护重新复核；未跑 build / 全量自检（避免重写已入库产物），只跑只读校验与新增门禁。

## 一、审计发现（按风险排序）

### P0 文实漂移（文档写了，代码/CI 没有）

| # | 发现 | 证据 |
|---|---|---|
| 1 | §3.4 要求 CI ubuntu + windows 双跑，实际只有 ubuntu | `.github/workflows/test.yml` 只有 `runs-on: ubuntu-latest`（另一个插件仓才有双平台） |
| 2 | §3.1 分层表与 §1 目录树列了一批本仓不存在的工具 | `verify-core / verify-generations / verify-zstd / verify-rates / verify-storage / verify-twin / make-twin / preview` 在本仓均不存在；§4.5 的预览命令是死命令 |
| 3 | §3.2.7 称版本字面量元测试「扫全文」，实际只扫 `smoke-host.mjs` 自身 | `readFileSync(fileURLToPath(import.meta.url))` |
| 4 | `docs/specs/` 只有模板，没有任何真实 spec ——「新功能先写 spec」规则事实上没被执行 | `docs/specs/` 目录内容 |
| 5 | 规范自称「在线插件通用标准」，但混入另一插件的领域内容（鉴权矩阵 / 北京零点 / 金额对账 / 用量事故行） | 原 §2.3、§4.6、§6.2 |

### P0 两份规范分叉

- `dsh-worktodo` v1.2（734 行）vs `dsh-token-meter-panel` v1.0（299 行）；后者缺平台包 optional peer、安装离运行态、三档更新、双环境门禁、发布物审查等 8 条。
- 而 token 仓 0.6.7 恰恰刚踩平台包事故（CHANGELOG 自述），`autoUpdate` 仍默认 `true`。
- 共享条款靠手工复制 → 必漂。

### P1 防线状态与事故记录

- 事故记录三处并存（§6.1 八条 / §6.3 L01–L12 / 66KB 总账），✅/⚠️/❌ 人写，脚本改名不会变红；规范自己承认缺「机器可读汇总」。
- 新发现（规范未披露）：`verify-privacy` 对运行时安装器只有「只允许」单向检查（tools 为空时恒真），没有「必须存在」的正向断言；CI 打包检查也不含它 → 误删后全绿，用户升级时才炸。
- `verify-submission` 的平台包断言只覆盖 3 个 dsh-* 包，`cordis` 去掉 optional 仍会过闸。

### P1 已披露缺口仍是手工

profile 模拟 / 宿主升级模拟、双环境门禁、`npm@latest` 行序、元测试边界自测 —— 恰好压在事故密度最高的 L02 / L06 / L11 / L12 上。

### P2 约束与实际不符

- 「≤3 个文件、≤200 行改动」：实际一次功能改动常涉及 10 个文件（含测试与构建产物）。
- 命令写 `npm test`，但 DSH 环境 `node` / `npm` 都不在 PATH，照抄会 `command not found`。

## 二、本次改动

### 1. 规范拆成「共享正文 + 仓库 annex」

- `docs/process/development-standard.md` → **v1.3 共享正文**（§0–§7），两份仓库逐字节一致；`<!-- shared:begin -->` / `<!-- shared:end -->` 标记。
- `docs/process/repo-annex.md` → **本仓事实**：文件地图、命令表、领域规则、CI 现状、已知缺口、事故索引（八条主事故 + L01–L12）。
- 共享正文做适用性收敛：多包名、鉴权矩阵、口径对账等仓库特有内容移入 annex；通用纪律保留并去重。

### 2. 修文实漂移

- 删除对本仓不存在工具 / 路径的引用；把「10/10」改成「按 annex 登记的全量自检步数」（本仓 12 步 = 构建 + 11 suite）。
- §3.4 改为「CI 矩阵见 annex」；本仓 annex 如实写：主 job 仅 ubuntu，Windows 为观测 job。
- §3.2.7 的元测试描述改为「扫源码全文」，由新脚本实现，不再只扫单个文件。
- spec 政策写成可判定规则（跨会话数据 / schema / 安装升级 / 发布流程 / 口径必须写 spec；纯 UI 微调可只写 review）。
- AGENTS.md 补 `NODE` 绝对路径、改 token 预算口径（代码 ≤200 行，测试 / 文档 / 产物不计）。

### 3. 新增「让文档不漂移」的门禁

- `tools/verify-docs.mjs`：扫 `AGENTS.md` / `docs/process/*.md` / `docs/specs/*.md` 里引用的仓库路径与命令，断言真实存在；跨仓比较共享段逐字节一致性（邻仓不存在时跳过并说明）；带反向自检（引用不存在的路径必须红、合成差异必须报行号、缺标记必须报错）。
- `tools/verify-meta.mjs`：从 `package.json` 派生版本号，扫 `lib/` `src/` `tools/` `locale/` `cordis.patch.yml` 源码全文找当前版本字面量；带边界自测（`0.2.1` vs `0.2.10`、注释行也扫）与反向自测。
- `tools/preflight.mjs` + `npm run preflight`：发版前一键串起全量自检、发布面断言、发布包形状检查，并打印人工闸门清单（profile 模拟、宿主升级、真机、截图、只批最新）。
- 全量自检：9 suite → 11 suite（构建 + 11 = 12 步）。

### 4. 加固三处发布面断言

- `verify-privacy`：新增「发布包必须包含运行时安装器」正向断言 + 反向自检。
- `verify-submission`：新增「所有 `@deepseek-ai/*` peer 必须 optional（含 cordis）」+ 反向自检。
- `verify-workflows`：新增「`npm install -g npm@latest` 必须在 `setup-node` 之后」断言。

### 5. token 仓同步

- `docs/process/development-standard.md` 同步为 v1.3（共享段逐字节一致，跨仓门禁校验）；新增本仓 annex；AGENTS / runbook 事实修正（10 项自检、暂存发布、72h 撤版本）。
- token 仓新增 `tools/verify-docs.mjs`（自动发现兄弟仓，避免「自己比自己」），并接入 `npm test` 链；`docs/marketplace-research.md` 的隐私说法按实际跟踪状态修正。
- token 仓**如实登记**更新机制缺口：仍是运行态跑 `dsh plugin add`、`autoUpdate` 默认 true，未达共享正文 §2.12–§2.14；改造前不发布带自动安装的版本。
- **仍需人工确认**：npm registry 实况（0.6.7 是否已发出）、Trusted Publisher 绑定目标（双 remote）、绑定页 Allowed actions。

## 三、仍未解决（人工闸门 / 下一版）

- profile 模拟、宿主升级模拟仍无脚本（preflight 只打印清单）。
- Windows 只有观测 job（`continue-on-error`），全套 suite 转正前不算跨平台验证完成。
- 绑定页 Allowed actions、「暂存区只批最新」只能人工核对。
- token 仓仍无发布面独立断言 / 版本元测试 / preflight（文档门禁已落地）；全量自检 = `npm test` 的 10 项 + `tools/verify-twin.mjs`。
- 防线状态表（✅/⚠️/❌）仍人写，文档门禁只保证「引用的脚本存在」，保证不了「状态标注正确」。

## 四、复跑方式

```bash
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
"$NODE" tools/verify-docs.mjs; echo "exit=$?"
"$NODE" tools/verify-meta.mjs; echo "exit=$?"
"$NODE" tools/verify-all.mjs; echo "exit=$?"   # 会重新构建 lib/client.js
npm run preflight; echo "exit=$?"              # 发版前
```
