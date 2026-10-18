# 插件目录收录：物料与步骤

> 前提：**把仓库公开、给仓库加 `dsh-plugin` 话题**（收录源的静态门禁会去 GitHub 读你的 `package.json` 与 patch 文件）。
> 发到 npm **不是**前提——目录明确接受「只有仓库、没有 npm 包」的条目，只是显示成**只看不装**并链到仓库。
> 这种状态下依然可以被安装，只是要走 git：
>
> ```bash
> dsh plugin --profile desktop add github:olimc2016/dsh-worktodo
> ```
>
> 这条路已实测（见 `docs/verification.md`：顶层只有本插件 1 个包、平台包由 DSH 提供、无需构建授权）。
> 等 npm 那关过了，同一个条目会自动变成可一键安装——install 命令取自 npm 包，不取自仓库。

---

## 一、deepseek1024.com / DSH 1024Store（最值得先做）

爬完他们的文档后有个关键事实：**deepseek1024.com 的收录不在自己的仓库里做**，
而是要往目录仓 [`imsai-sh/awesome-deepseek-harness-plugins`](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) 提一个 PR。

规则（照官方 CONTRIBUTING 摘要，逐条都对应自动校验）：

| 要求 | 说明 |
|---|---|
| 只改一个文件 | 每个插件一个 `catalog/plugins/<id>.json`；**PR 里不能碰任何其他路径**（README、workflow、脚本都不行），否则静态门禁直接拒 |
| 文件名 | id 的每个 `/` 段小写、非字母数字连续段换成 `-`，段间用 `--` 连接：`olimc2016/dsh-worktodo` → **`olimc2016--dsh-worktodo.json`** |
| 必填字段 | `$schema` / `id` / `name` / `repository` / `category` / `description.en` / `description.zh` / `added` |
| `category` | 枚举之一（法定分类见下），不是自由文本 |
| `dsh.bundle.patch` | 你的 `package.json` 必须声明了非空的 `dsh.bundle.patch`，且被引用文件已提交 |
| 描述口吻 | 事实、中性、具体；**不要最高级、不要行动号召、不要无支撑的宣称** |
| `added` | 提交当天日期 |
| 自动合并 | 只新增一个条目 + 静态检查变绿的非草稿 PR 会被**自动 squash 合并**，之后自动同步到站点并重建两份 README，无需人工 |

**法定分类**（从目录 README 的分节标题读出，共 11 个）：
`ui`(2621) · `theme`(496) · `session`(862) · `memory`(433) · `tools`(3968) ·
`skill`(1045) · `workflow`(771) · `notify`(498) · `model`(818) · `dev`(1626) · `fun`(560)

**本插件选 `ui`**：同类待办插件里面板型的（`dsh-todo-panel`、`dsh-todo-dock`、`dsh-todo-float-ball`、
`dsh-calendar-todo`、`dsh-plugin-better-plan`）都归在 `ui`；本插件的首要产物也是侧栏面板。
若维护者偏好，`tools` 是合理备选（`dsh-tool-todo-tree`、`dsh-todo-list`、`dsh-todolist` 都在 `tools`）。

### 提交步骤

```bash
# 1. fork + clone 目录仓
gh repo fork imsai-sh/awesome-deepseek-harness-plugins --clone
cd awesome-deepseek-harness-plugins
git checkout -b add-dsh-worktodo

# 2. 只放这一个文件（内容见本目录的 olimc2016--dsh-worktodo.json）
cp /path/to/dsh-worktodo/docs/submission/olimc2016--dsh-worktodo.json \
   catalog/plugins/olimc2016--dsh-worktodo.json

# 3. 确认只动了这一个文件
git status --short          # 只应有 ?? catalog/plugins/olimc2016--dsh-worktodo.json
git add catalog/plugins/olimc2016--dsh-worktodo.json
git commit -m "Add dsh-worktodo"
git push -u origin add-dsh-worktodo

# 4. 提 PR 后等 "Plugin submission review / static-review" 变绿；非草稿状态会被自动合并
```

### 提交步骤（另一条路：**纯浏览器，不需要任何本地凭据**）

如果不想折腾 PAT / 终端，GitHub 网页本身就能走完。只需要先让插件仓库存在（下面 A），
再在网页上提一个只含 1 个文件的 PR（下面 B）。

**A. 让插件仓库存在**（二选一）

| 方式 | 做法 | 代价 |
|---|---|---|
| 有 PAT（推荐） | 我推送：历史、CI、话题、完整文件树都齐 | 需要建一个 fine-grained token |
| 纯浏览器 | <https://github.com/new> 建 **Public** 仓库（不勾任何初始化文件），再用仓库页的 **Add file → Upload files** 拖文件 | 浏览器上传**会跳过隐藏文件**（`.github/`、`.gitignore`），也可能把 `node_modules` 一起传上去（几百 MB、容易失败）——拖之前先把 `node_modules` 删掉或改名。审核器只需要 `package.json`、`cordis.patch.yml`、`lib/`，这三样别漏 |

**B. 在网页上提 PR（只加 1 个文件）**

1. 打开 <https://github.com/imsai-sh/awesome-deepseek-harness-plugins> → 右上 **Fork** → **Create fork**
2. 在你自己的 fork 里确认分支是 `main`，进入 `catalog/plugins/` → **Add file → Create new file**
3. 文件名**逐字**填 `olimc2016--dsh-worktodo.json`（上游用文件名反查 id，错一个字就被拒）
4. 内容粘贴下面这段（就是本目录 `olimc2016--dsh-worktodo.json` 的全文）：

```json
{
  "$schema": "../schema/plugin.schema.json",
  "id": "olimc2016/dsh-worktodo",
  "name": "dsh-worktodo",
  "repository": "https://github.com/olimc2016/dsh-worktodo",
  "category": "ui",
  "description": {
    "en": "A sidebar work todo panel with priorities, due dates, projects, overdue and this-week views. Todos persist across sessions in the Harness storage layer, and worktodo_* tools let the agent read and write the same list as the user.",
    "zh": "侧栏工作待办面板：优先级、截止日期、项目、逾期与本周视图。待办跨会话持久保存在 Harness 存储层，并提供 worktodo_* 工具，让 agent 与用户读写同一份列表。"
  },
  "added": "2026-10-11"
}
```

5. Commit message 填 `Add dsh-worktodo`，直接提交到 `main`
6. 回到上游仓库页面 → **Contribute → Open pull request**（或 Compare & pull request）
   - 标题：`Add dsh-worktodo (work todo panel + worktodo_* agent tools)`
   - 正文可用：

```text
Adds one catalog entry: catalog/plugins/olimc2016--dsh-worktodo.json

- Plugin: dsh-worktodo — sidebar work todo panel (priorities, due dates, projects, overdue / this-week views)
  plus worktodo_* tools so the agent reads and writes the same list as the user.
- Persistence uses the Harness storage domain; zero runtime dependencies.
- Published on npm: dsh-worktodo@0.1.0 (declares dsh.bundle + dsh.client).
- Only this one file is added; README and catalog projections untouched.
```

7. 等 **Plugin submission review / static-review** 变绿（非草稿状态会被自动合并）。失败会把原因评论在 PR 上，PR 保持打开可继续改。

**别手改 `README.md` 或 `catalog/README.md`**——它们是机器人从目录 API 重建的投影，改了会被门禁拒。

---

## 二、dsh-plugin.org / DSH Plugin Hub

- 仓库 `dshplugin/dsh-plugin-hub`，npm 包名 `dsh-plugin`（v1.6.x），README 自称收录 9,463 个
- 收录方式：**只靠 `dsh-plugin` 话题自动发现**——原文（`README.zh.md`/`README.en.md` 第 194 行）：
  > 将你的插件发布到 GitHub 并添加 `dsh-plugin` topic，即可被 DSH Plugin 插件目录**自动发现与收录**。
  > Publish your plugin to GitHub and add the `dsh-plugin` topic — it will be discovered and indexed automatically.
- 也就是说：**无需提 PR、无需表单**，加话题即可（本仓库已推送，只差话题这一下）
- 动作：先确认话题已加，再去 <https://dsh-plugin.org/zh/submit> 填表（填仓库地址 + npm 包名即可）

## 三、awesome 清单仓库（PR 加一行）

这些是清单仓，格式各不相同，但动作一样：**fork → 在对应分类的列表里加一行 → 提 PR**。
本插件那一行的写法（照他们既有条目的格式：`- [名字](仓库) — 说明`）：

```markdown
- [dsh-worktodo](https://github.com/olimc2016/dsh-worktodo) — 归你所有、跨会话持久的工作待办：优先级、截止日期、项目、逾期与本周视图，agent 通过 worktodo_* 工具读写同一份列表。
```

按 star 数从高到低做（值不值得花时间一目了然）：

| 仓库 | star（调研时） | 备注 |
|---|---|---|
| `0xsline/awesome-deepseek-harness` | ~1.2k | 最大的清单仓之一 |
| `bruc3van/awesome-dsh-plugin` | ~401 | |
| `Dominic789654/awesome-deepseek-harness` | ~374 | |
| `beancookie/awesome-dsh-plugin` | ~163 | |
| `Alex-Yanggg/awesome-DSH-plugin` | ~101 | |

另外，**你自己 fork 过 4 个清单仓**（`olimc2016/awesome-dsh-plugin`、`awesome-dsh-plugins`、
`awesome-deepseek-harness`、`awesome-deepseek-harness-plugins`）。往自己的 fork 加条目对下载量没帮助
（没人看 fork），**要提 PR 回上游**；`imsai-sh/awesome-deepseek-harness-plugins` 就是你 fork 的上游之一，
所以那条走上文第一节即可。

---

## 三点五、用官方校验器与审核器核对过（不要只信自建门禁）

自建门禁只能证明"我理解的规则没被违反"。所以把上游仓库**匿名克隆**下来，用它自己的代码核对：

```bash
git clone --depth 1 https://github.com/imsai-sh/awesome-deepseek-harness-plugins.git /tmp/catalog
# 官方字段校验器（scripts/lib/catalog-entry.mjs 的 validateCatalogEntry）
node -e "import('/tmp/catalog/scripts/lib/catalog-entry.mjs').then(async m => { ... })"
```

**结果**：`validateCatalogEntry(条目, 'catalog/plugins/olimc2016--dsh-worktodo.json', 官方分类集)` **通过** ✓
（字段集合、`$schema` 常量、id 形态与长度上限 201、文件名由 id 派生、`repository` 必须等于
`https://github.com/<id>`、分类存在、双语描述非空且 ≤1000、`added` 是 ISO 日期）。

**审核器还读仓库核对这几点**（`scripts/review-plugin-submission.mjs`，已逐条抄进本地门禁）：

| 上游要求 | 本仓库 |
|---|---|
| 仓库里要有声明 `dsh.bundle.patch` 的 `package.json`，且**该 patch 文件在仓库树里** | ✓ 根 `package.json` + `cordis.patch.yml` |
| patch 路径不得绝对、不得含反斜杠、不得逃出仓库 | ✓ 相对路径 |
| git 安装分类（`classifyGitInstall`） | ✓ **`entry_committed`**（`lib/index.js` 已提交），且无 `prepare` → **不需要构建授权** |
| 多个 manifest 时按"层级更浅优先"挑 | ✓ 仓库里只有根 `package.json` |
| PR 只含 `catalog/plugins/*.json`，变更文件不得 ≥100 个 | ✓ 只加 1 个文件 |

**一条重要更正**：上游审核器里有 `installAvailabilityAdvisory`——"1024 Store 只从 npm 安装；
在包发布到 npm（且声明 `dsh.bundle`）之前，条目是**仅浏览**（browse-only），之后**自动检测、无需再提 PR**"。
**我们的包已发布（`dsh-worktodo@0.1.0`，含 `dsh.bundle`），所以条目会直接带安装命令，而不是仅浏览。**
这一点在首版发布前写下的旧预期已经过时，以本节为准。

## 三点六、凭据能力边界（实测）

| 要做的事 | fine-grained PAT（只授权 `dsh-worktodo`） | classic PAT（`repo`） |
|---|---|---|
| 推送插件仓库 | ✓ 实测可以 | ✓ |
| 设仓库话题（`dsh-plugin`） | **✗ 403**（需 Administration 权限） | ✓ |
| fork 目录仓 `imsai-sh/awesome-deepseek-harness-plugins` | **✗ 403**（细粒度不能 fork 他仓） | ✓ |
| 提收录 PR | ✗ | ✓（fork 后推分支 + 开 PR） |

结论：**推送用细粒度就够；话题与 fork 要么在网页点，要么用 classic `repo` token。**

## 四、提交后核对

- [x] npm 上 `npm view dsh-worktodo version` 返回 **0.1.0** ✓（已发布；1024 Store 只从 npm 安装）
- [ ] 仓库有 `dsh-plugin` 话题
- [ ] 目录 PR 的 `static-review` 变绿（失败会把原因评论在 PR 上，PR 保持打开可继续改）
- [ ] 收录后站点搜索 `worktodo` / `待办` 能搜到
- [ ] （可选）把 repo 加进自己那 4 个 fork 的 README，方便自己在 fork 里也看得到
