# 「按截止」视图新增「明天」分组

- 仓库：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`
- 基线：版本 **0.2.14**，HEAD `5e4ff55`，开工时工作区干净
- 本轮范围：代码 + 中英文案 + 测试 + 反向验证 + 本报告
- **未做**：升版本号、改 CHANGELOG、改 `.github`、commit / push / tag / 发布、碰真实数据
- 报告里的路径一律写 `~/...`

---

## 1. 分桶定义（`src/records.mjs` · `groupRecords`）

分组顺序固定为：

> 已过期 → 今天 → **明天** → 本周 → 以后 → 已完成

| 桶 | 判定（`today = dayKey(now)`，本地时区） |
| --- | --- |
| `overdue` | `status !== completed` 且 `due < today` |
| `today` | `due === today` |
| `tomorrow` | `due === addDaysKey(today, 1)` |
| `week` | `due > tomorrow` 且 `due <= weekEnd` |
| `later` | 无 `due`，或 `due > weekEnd` |
| `completed` | `status === completed`（先判，优先于所有日期规则） |

「明天」与「今天」一样按**本地墙上时钟**计算，和既有 `dayKey` 同语义；已过期、今天、以后的语义未改。

`statsOf` 顺带新增 `tomorrow` 字段（与分组同口径，只统计未完成），面板顶部 chip **没有**改动，仍是原来的五项，避免统计行变拥挤。

## 2. 本周如何排除明天

原来的本周是 `due <= weekEnd`（`weekEnd = 本周日`）。新增判断的顺序是：

```js
if (due < today) → overdue
if (due === today) → today
if (due === tomorrow) → tomorrow   // 先截走明天
if (due <= weekEnd) → week         // 走到这里必然 due > tomorrow
```

因此本周天然变成「**严格晚于明天**、且不晚于本周日」。本周日的边界定义、周一为一周之始的规则都沿用原实现（`weekStartKey` + 6 天）。

一个刻意保留的结果：如果今天是周日，明天就是下周一（已超出本周末尾），明天仍然进「明天」，本周桶为空。这是「明天 := 今天 + 1 天」的直接推论，也符合用户看面板时的直觉。

## 3. 跨月 / 跨年 / 闰日边界

明天用日历加法而不是固定加 24 小时：

```js
function addDaysKey(key, days) {
  const d = new Date(dayStart(key));
  d.setDate(d.getDate() + days);
  return dayKey(d);
}
```

- 跨月：`2026-10-31`（周六）→ 明天 `2026-11-01`（同时是本周日）；`2026-11-01` 进「明天」，本周为空。
- 跨年：`2026-12-31`（周四）→ 明天 `2027-01-01`；`2027-01-01` 进「明天」，`2027-01-02` 进「本周」。
- 闰日：`2028-02-28` → 明天 `2028-02-29`。
- 非闰年：`2027-02-28` → 明天 `2027-03-01`。

用 `Date#setDate` 而不是 `dayStart + 24h`，在有夏令时的时区里也不会把「明天」算错成今天或后天。

## 4. 客户端（`src/client/index.js`）

- i18n：中文 `groupTomorrow: '明天'`、英文 `groupTomorrow: 'Tomorrow'`，沿用现有 `zh` / `en` 字典，经 `ctx.locale.register('worktodo', { zh, en })` 注册。
  `locale/zh.json` 与 `locale/en.json` 只承载插件标题与描述（没有分组文案键），因此本轮无需改动这两个文件。
- `GROUPS` 改为导出常量，新增 `{ key: 'tomorrow', label: 'groupTomorrow' }`，位置在 `today` 与 `week` 之间。
- 默认折叠状态仍是 `useState({ completed: true })`，明天没有条目 → 默认展开；空分组由 `Group` 组件返回 `null`，标题整块不渲染（沿用原行为）。

## 5. 测试

测试文件数量保持 **9 个**（`tools/*.mjs` 只改既有文件，不新增测试文件）。

### 5.1 数据模型（`tools/verify-records.mjs`）

1. **分桶**：昨天 / 今天 / 明天 / 后天 / 下个月 5 条，分别落在 已过期 / 今天 / 明天 / 本周 / 以后，并显式断言明天**不在**本周。
2. **边界**：跨月、跨年、闰日、非闰年四个固定 `now`，断言「明天」与「本周」的归属。
3. **统计**：`statsOf` 的 `tomorrow` 单独计数；原有用例补 `tomorrow: 0`。

### 5.2 服务层（`tools/verify-service.mjs`）

`list()` 的分组用例新增 `due: 'tomorrow'`：断言 `groups.tomorrow`、`groups.week` 为空、`stats.tomorrow === 1`，确认宿主载荷真的带上新桶。

### 5.3 客户端（`tools/smoke-client.mjs`）

- `GROUPS` 键顺序恰为 `overdue, today, tomorrow, week, later, completed`。
- `groupTomorrow` 的 key、中文「明天」、英文 "Tomorrow" 都存在。
- 临时注入一条明天记录后渲染：出现 `[groupTomorrow]` 分组头、`aria-expanded=true`、`title=[collapse]`、行直接可见；移除后空分组标题不再渲染。

### 5.4 契约/宿主

`tools/smoke-host.mjs` 与 `tools/smoke-contract.mjs` 里「分组键集合」的断言从五个键更新为六个键（`tomorrow`），否则会假红。

## 6. 反向验证（测试有牙齿）

把 `groupRecords` 里的 `if (due === tomorrow) { … }` 整行删掉（明天自然回落到本周），只跑数据模型：

```bash
~/Documents/deepseek-harness/default-workspace/dsh-worktodo $ WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-records.mjs
EXIT=1
✗ 分桶：昨天/今天/明天/后天/下个月 → 已过期/今天/明天/本周/以后（明天不再进本周）
✗ 明天边界：跨月 / 跨年 / 闰日按本地日历推进
```

两条新用例都变红，符合预期；随后用备份恢复，`shasum` 与备份一致，再跑 `verify-records.mjs` 得到 `38 通过，0 失败`、`EXIT=0`。

## 7. 两套门禁

| 环境 | 命令 | 结果 |
| --- | --- | --- |
| 本机 | `WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs` | **10/10**，`EXIT=0` |
| 干净环境 | `env -i HOME=/tmp/cihome PATH=<node目录>:/usr/bin:/bin CI=true node tools/verify-all.mjs` | **10/10**，`EXIT=0` |

两套都包含 `build-client.mjs`，且构建产物 `lib/client.js` / `lib/client.js.map` 已随源码重新生成（未提交）。

## 8. 改动文件

- `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/records.mjs`：`addDaysKey`、`groupRecords` 新桶、`statsOf.tomorrow`
- `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/client/index.js`：中英文字典、导出并扩充 `GROUPS`
- `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/verify-records.mjs`：分桶 / 边界 / 统计用例
- `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/verify-service.mjs`：`list()` 的明天桶断言
- `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-client.mjs`：`GROUPS` 顺序、文案、渲染展开用例
- `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-host.mjs`、`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-contract.mjs`：六桶键集合
- `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/client.js`、`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/client.js.map`：构建产物
- `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/docs/reviews/tomorrow-group.md`：本报告

## 9. 未做 / 不确定

- **未升版本、未改 CHANGELOG、未提交 / 打 tag / 发布**。
- 面板顶部统计 chip 没有加「明天」；`stats.tomorrow` 已可用，若以后要加 chip 不需要再改数据层。
- `filterRecords(..., 'week')` 仍是「今天起累计到本周日」的**查询语义**（包含今天和明天），和面板 `week` 分桶语义不同——这是原有且有意为之的差异，本轮没有改。
- 未在真实浏览器 / 真机上做视觉检查；客户端结论来自 bundle 烟测的渲染树断言。
- `README.md` / `README.en.md` 的「视图」一行仍写「已过期 / 今天 / 本周 / 以后 / 已完成」，没有补上「明天」；本轮写域不含 README，留待需要时同步。
- 「明天」按本地时区计算；如果宿主的 `now` 与浏览器所在时区不一致，面板分组仍以宿主时钟为准（与现有今天/本周行为一致）。
