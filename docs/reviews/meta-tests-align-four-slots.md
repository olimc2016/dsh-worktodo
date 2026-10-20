# 小字组测试对齐四槽结构（meta-tests-align-four-slots）

对象：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`（0.2.12，HEAD `8e22494`，工作区有未提交改动）。
本轮**只改测试** `tools/smoke-client.mjs`，外加这份报告；测试文件仍是 **9 个**。

**未改 `src/**`**（源码行为已符合新规格）、未升版本、未改 CHANGELOG / `.github/`、未 commit / push / tag / 发布、未碰真实数据。
`lib/client.js` 与 `.map` 只是 `tools/verify-all.mjs` 先跑的 `build-client.mjs` 产物，没有手改。

Node：`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`；测试前 `WORKTODO_NO_UPDATE_CHECK=1`。

---

## 0. 改动前基线：3 条红（正好是待对齐的三处）

`node tools/build-client.mjs` → `BUILD_EXIT=0`；`node tools/smoke-client.mjs` → `SMOKE_EXIT=1`，`85 通过，3 失败`：

1. `小字组固定列…`：`小字组顺序必须固定为 [日期][项目]` 期望 true，实际 false
   （DOM 已是 `wt-meta-date | wt-meta-source | wt-meta-overdue | wt-meta-project`）。
2. `已过期标记…`：`胶囊必须在标题列右端` 期望 true，实际 false（胶囊已在小字组）。
3. `小字组换行态…`：`换行后列定义仍是 96px/96px` 期望 `"96px 96px"`，实际 `"96px 44px 44px 96px"`。

这三条同时充当**反向验证**：断言与旧结构绑得够紧，源码一换结构它们就红。

## 1. 断言改动（不放松、不删用例）

### 1.1 `小字组固定列`（用例 1）

- 列定义期望从写死的两列改成 `expectedMetaColumns()`：由 `META_SLOT_ORDER` + 四个导出宽度常量
  （`META_DATE_SLOT_PX=96`、`META_SOURCE_SLOT_PX=44`、`META_OVERDUE_SLOT_PX=44`、`META_PROJECT_SLOT_PX=96`）派生。
- 项目槽位置从写死 `kids[1]` 改成 `META_SLOT_ORDER.indexOf('project')`（当前＝第 4 槽）。
- 原「`[日期][项目]`」两条并成更强的四槽断言：
  - 每个直接子节点的 `data-wt-meta-slot` 必须**按序等于** `META_SLOT_ORDER`；
  - 每只槽的 `data-wt-meta-slot-width` 必须**按序等于**对应导出宽度常量。
- 来源胶囊从「必须在标题列右端、不许在小字组」翻转为新规格：
  - 必须落在 `data-wt-meta-source-slot` 里；
  - 必须**不在** `.wt-row-main`；
  - 来源槽在 DOM 中的下标必须等于 `META_SLOT_ORDER.indexOf('source')`，且满足
    `date < source < overdue`（全部从常量派生，不写死 44/96/顺序）。

### 1.2 `小字组占位`（用例 2）

- 用例名/注释由「两只槽」改成「四只槽」。
- 新增空槽断言：无来源的行仍渲染来源槽（44px）、未过期的行仍渲染「已过期」槽（44px），
  并与有内容行的同槽同宽；原日期/项目空槽断言保留。
- hover 后入口断言保留，措辞改为「日期槽与项目槽必须还在」。

### 1.3 `已过期标记`（用例 3）

- 删除两条旧断言（`胶囊必须在标题列右端` / `胶囊不许占小字组`），换成：
  - 必须在小字组（`.wt-meta`）内；
  - 必须在 `data-wt-meta-overdue-slot` 内；
  - 必须**不在** `.wt-row-main`，也不许塞进日期槽；
  - 小字组槽序等于 `META_SLOT_ORDER`；`overdue` 槽的 DOM 下标等于 `indexOf('overdue')`，
    且满足 `source < overdue < project`。
- 「日期槽里不再有已过期前缀」「日期仍显示」「warn 色」原断言全部保留。

### 1.4 `小字组换行态`（用例 4）

- 换行列定义期望改成 `expectedMetaColumns()`（四列，按常量派生）。
- 新增：换行态四槽 `data-wt-meta-slot` 顺序仍等于 `META_SLOT_ORDER`。
- 项目槽断言由「网格第 2 列」改成 `directChildren(meta)[indexOf('project')]`（当前第 4 列）。
- 换行态「不重写 `grid-template-columns`」「`justify-self:end`」「`grid-area:meta`」原断言保留；
  注释里的 `96px/96px`、`96px/72px` 一并改成四列 `96/44/44/96`。

### 1.5 注释清理

- 文件头用例分组注释、`行布局 B` 的 `第四个小字组（日期/项目两列）`、`小字组固定列` 段首、
  换行态注释，全部改成四槽措辞。
- 全文复查：`两列固定`、`96px 96px`、`96px/96px`、`[日期][项目]`、`网格第 2 列`、`meta 是两列`
  在测试文件里已无残留。

## 2. 有意保留的旧断言 / 旧措辞

- `来源胶囊不许再留在标题列右端`、`胶囊不许再留在标题列右端`：这些是**反向**断言，正是新规格要钉的。
- `标题列右端` 在文件里只剩上述否定句，以及段首「不再挂在标题列右端」的说明。
- `两列` 只剩 `.wt-row--wrap` 的行网格说明（`auto auto minmax(0,1fr) auto` 里「旗子 + 勾选 + 内容」），
  与 `.wt-meta` 四列无关，属实、保留。
- 全部原有用例标签与数量未删；`88 通过，0 失败`。

## 3. 两套门禁（均显式检查退出码）

本机：

```
WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs
→ 10/10 个步骤通过（含构建）  LOCAL_EXIT=0
```

干净环境：

```
env -i HOME=/tmp/cihome PATH=<node目录>:/usr/bin:/bin CI=true node tools/verify-all.mjs
→ 10/10 个步骤通过（含构建）  CLEAN_EXIT=0
```

9 个 suite + build ＝ 10 步；build 产出了新 `lib/client.js`（170.8 KB），烟测读的是新产物。

## 4. 剩余不确定 / 建议跟进

- **源码注释有旧数字，行为与新规格一致**：`src/client/index.js` 里仍有 6 处注释写「项目 72px」，
  `META_SLOT_TOTAL_PX` 上方注释还算成 `96+44+44+72+3×6=274px`（实际常量是 96，满宽 298px）。
  涉及行：`617`、`861`、`877`、`958`、`2641`、`2657`、`2875`。
  按本轮「不要改源码」的约束**未动**；它们不影响运行与测试，但建议下一轮单独做一次注释订正。
- `docs/reviews/fixed-meta-columns.md` / `flag-before-checkbox.md` 是历史评审，仍描述两列 / 标题列右端；
  历史文档按「当时状态」保留，未改。
- 测试替身没有真实布局，`offsetLeft` 断言仍是「有几何信息才跑」的条件分支（原样保留）；
  四列对齐的像素级回归由 `data-*` 宽度与 CSS 原文双重钉住。
