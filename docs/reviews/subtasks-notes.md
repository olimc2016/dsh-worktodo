# 子待办（subtasks）+ 备注（notes）实现记录

- 日期：2026-10-21
- 仓库：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`
- 范围：按用户本轮拍板的规格实现；**未升版本、未改 CHANGELOG / `.github`、未 commit / push / tag / 发布**
- 一句话：子待办内嵌在记录里（`subtasks[]`，≤50，独立 id，只有 title/done/order）；备注统一 `string | null`（≤4000，纯文本保留换行）；行内进度 chip + 备注图标 + 行下展开；勾父项级联子项、取消父项不级联、勾完最后一条只给可点轻提示。

---

## 1. 数据

### 1.1 记录形状（新增字段）

```jsonc
{
  "id": "wt-...",
  "title": "整理评审意见",
  "notes": "评审重点：\n1. ...",   // string | null
  "subtasks": [
    { "id": "st-...", "title": "整理会议记录", "done": true,  "order": 0 },
    { "id": "st-...", "title": "汇总三条争议", "done": false, "order": 1 }
  ]
}
```

| 字段 | 规则 |
|---|---|
| `subtasks` | 数组；每条 `{id,title,done,order}`；**没有**日期/优先级/项目/备注，也不允许递归 |
| `subtasks[].id` | 父项内唯一；客户端优先 `crypto.randomUUID()`，宿主用 `st-<base36 时间>-<4 位随机>` 等价实现；缺失/重复时写入自动补 |
| `subtasks[].title` | `trim` 后非空，≤ **200** 字 |
| `subtasks[].done` | 严格布尔；缺省按 `false` |
| `subtasks[].order` | 数字；缺省按数组下标；写入后按 order 稳定排序并重编号 `0..n-1` |
| 数组上限 | **50 条/父** |
| `notes` | `string \| null`；纯文本，**保留内部换行**；首尾空白 trim；空/null/缺省统一为 `null`；上限 **4000** 字 |

### 1.2 兼容

- 老记录没有 `subtasks` / `notes` → `repairRecord` 补 `[]` / `null`，`version` 仍是 1，**无迁移脚本**。
- 旧客户端只 patch 自己认识的字段，不会整条覆盖掉 `subtasks`。
- 本轮按拍板把备注从上一轮设计稿的「空串 + 2000」统一为「null + 4000」；旧数据里的 `''` 读出来是 `null`，旧客户端按「没有备注」处理。
- `notes` 只影响显示/搜索，不参与条目统计；子待办也不计入 open/overdue/today/completed。

## 2. 校验策略

沿用「HTTP 200 + `{ok:false, reason, message}`」，**写入严格、读盘宽容**。

### 2.1 写入（`/create`、`/update`、工具与面板共用）

| reason | 触发 |
|---|---|
| `bad-subtasks` | subtasks 不是数组（`null` 表示清空，合法） |
| `subtasks-too-many` | 超过 50 条 |
| `bad-subtask` | 某项不是对象 |
| `empty-subtask-title` | 标题 trim 后为空 |
| `subtask-title-too-long` | 标题 > 200 |
| `bad-subtask-done` | done 不是布尔（缺省允许） |
| `bad-subtask-order` | order 不是有限数字（缺省允许） |
| `bad-notes` | notes 既不是字符串也不是 null |
| `notes-too-long` | notes > 4000（**明确报错，不静默截断**） |

- 整批失败，不做部分写入；失败时一个字节都不写盘（服务层与 HTTP 层都测了逐字节不变）。
- id 缺失/重复不报错，自动补独立 id；`subtasks` 里多余字段会被剥掉。
- 面板侧先做本地拦截：textarea `maxLength=4000`、子待办输入 `maxLength=200`、到 50 条隐藏添加入口；服务端仍完整校验。

### 2.2 读盘修复（`repairRecord`）

| 坏数据 | 处理 |
|---|---|
| `subtasks` 非数组 / null / 缺失 | `[]` |
| 数组里的非对象项、空标题项 | 丢弃该项，保留整条记录 |
| 标题 > 200 | 读盘时截到 200（写入仍报错） |
| done 非严格 `true` | `false` |
| order 非法 | 用数组下标 |
| 缺失/重复 id | 生成 `st-recovered-<位置>` 并去重 |
| 超过 50 条 | 按 order/数组顺序保留前 50 条 |
| `notes` 非字符串 / 空白 | `null` |
| `notes` 超 4000 | **保留原文不截断**（避免静默丢用户文字；UI 显示超限，保存时要求删减） |

## 3. 交互

### 3.1 行结构

```
[旗子槽][勾选][标题][备注图标][小字组：进度 chip / 日期 / 来源 / 已过期 / 项目][行尾操作]
                          （有备注才渲染）        （有子待办才渲染）
```

- **进度 chip**：小字组**最前**（紧跟日期之前），`2/3` 文案，同一套 `.wt-tag` / `.wt-meta-chip` 视觉；完成数 0 用 muted、全完成用 ok 色；可点展开/收起；没有子待办不渲染、不占位。`aria-label="子待办 2/3"`、`aria-expanded`、`aria-controls`，并带 `aria-live="polite"` 的视觉隐藏播报。
- **备注图标**：标题之后、小字组之前；**只在有备注时渲染**；点它展开行下只读备注，再点收起；`aria-label` + `aria-expanded`。无备注时行尾操作区在 hover/focus 出现「添加备注」轻入口。
- **行下展开**：`.wt-row-shell` 包住「单行行体 + 展开区」；展开区缩进到标题起始位置（≈68px），不改变单行/双向换行逻辑；展开/收起时重新触发换行测量。
- **子待办清单**：`role=list` / `listitem`，原生 checkbox（Space 勾选）、标题按钮点开原地 input（Enter 保存、Esc 取消、失焦保存）、删除按钮、上/下移动按钮（边界 disabled）、底部「＋ 添加子待办」（Enter 连加、输入框保持打开、Esc 收起）、空态与 50 条上限文案。整行可拖拽，drop 到目标项之前。
- **备注编辑**：行下 `<textarea>`（多行、`maxLength=4000`、计数），失焦或 Cmd/Ctrl+Enter 保存，Esc 取消；保存走 `POST /worktodo/update {ref, notes}`，空值发 `null`。
- **点标题**：仍进入原有行内标题编辑，同时展开备注只读区（有备注时）；第一次 Esc 只退出标题编辑并把焦点还给标题按钮，第二次 Esc 再收起备注（依次收起）。没有备注时不展开空区域，避免打断标题编辑。
- **入口**：无子待办时行尾 hover/focus 出现「＋子待办」；无备注时出现「添加备注」；有内容时用进度 chip / 备注图标进入，不额外挤常驻区。
- 全部使用 React 文本节点，没有 `innerHTML`；子待办与备注展开后父行高度自然增长。

## 4. 联动

- **勾父项 → 子项全部完成**：规则放在 `patchRecord`（纯函数），所以面板勾选、`/status` 路由与 `worktodo_done` 工具走同一条路径；UI 同时做乐观级联，失败一起回滚。
- **取消父项 → 只取消父项**：子项保持原状，不自动回滚。
- **勾完最后一个子项 → 父项不自动完成**：只在父行右侧出现轻提示「子项全部完成 · 勾掉这条？」；点它 = 完成父项，忽略 10s 后自动消失。服务端只收到子待办数组补丁，父项状态不变。
- 子项完成数变化先乐观更新，写失败回滚到点击前的数组，并在行下显示温和提示（不含原始异常串）。

## 5. `/list` 载荷取舍

- 继续在 `/list` 里带完整 `subtasks` 与 `notes` 全文：
  - 子待办 50 条 × 约 60B ≈ 3KB/父项；典型 3–5 条约 200–400B。
  - 备注最坏 4000 字（中文 UTF-8 约 12KB/条）。**典型数据很小，但极端 2000+ 条都写满长备注时载荷会明显变大。**
- 本轮没有拆「列表只带 `hasNotes` + 详情按需拉」：面板行内展开要求即时显示，拆详情会新增一条路由/一次 RTT，也会让离线/轮询状态多一套合并逻辑；现有 `/list` 已有 `shapes` 与 >2000 条的载荷提示，先保留一个真相。
- 若后续真实数据里长备注占比明显，再按「列表只带 `hasNotes` + 详情路由」演进；本报告把这列为待观察项。

## 6. 测试与反向验证

### 6.1 加进现有 9 个套件（没有新增测试文件）

| 套件 | 新增覆盖 |
|---|---|
| `tools/verify-records.mjs` | 默认 `[]`/`null`；order 排序与重编号；50/51；坏数组/坏项/空标题/超长/非布尔 done/非数字 order；4000/4001；patch 整组替换与 null 清空；父项级联、取消不级联、最后子项不自动完成；`subtaskProgress`；读盘修复不丢记录、长备注不截断 |
| `tools/verify-service.mjs` | create 带 subtasks/notes；update 增/改/删/排序/清备注；联动；非法输入整批拒绝且存储逐字节不变 |
| `tools/smoke-host.mjs` | `/create` 与 `/update` 的 subtasks/notes 契约；`/list` 原样带回；只带 subtasks 不被误判成插件升级；非法输入 200 + ok:false 且文件逐字节不变 |
| `tools/smoke-client.mjs` | 进度 chip `2/3` 与 aria、无子待办不渲染、备注图标仅在有备注时出现、点开备注；点标题同时展开只读备注；备注编辑/Cmd+Enter 保存/Esc 取消；勾选 1/3→2/3→3/3、最后一条只出提示、点提示走 `/status`；上下移动与拖拽改 order；Enter 连加；写失败回滚 + 温和提示 |
| `tools/smoke-contract.mjs` | 客户端 `/update` 的新字段（`subtasks`）在宿主接受范围内；`/create` 也允许 subtasks |

当前计数：records 45、service 35、host 110、client 98、contract 22，均 0 失败。

### 6.2 反向验证（都实际跑过、确认变红、再恢复）

1. **去掉「父项联动子项」**：把 `patchRecord` 的级联条件改成 `status === 'completed' && false ...` → `tools/verify-records.mjs` **EXIT=1**，「联动：勾父项…」红。恢复后绿。
2. **去掉「全完成轻提示」**：把客户端 `promptChip` 条件强制为 `false`，重新构建 → `tools/smoke-client.mjs` **EXIT=1**，「最后一条子项完成后必须出现轻提示」红。恢复后 98/98 绿。
3. **把备注图标改成常驻**：把 `hasNotes && !titleEditing` 改成 `!titleEditing`，重新构建 → `tools/smoke-client.mjs` **EXIT=1**，「没有备注的行不许渲染备注图标」红。恢复后绿。

恢复后重新构建并跑全套，结果见下节。

## 7. 两套门禁

| 环境 | 命令 | 结果 |
|---|---|---|
| 本机 | `WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs` | **12/12，EXIT=0** |
| 干净环境 | `env -i HOME=/tmp/cihome PATH=<node-bin>:/usr/bin:/bin CI=true node tools/verify-all.mjs` | **12/12，EXIT=0** |

口径说明（重要）：任务描述里的「10/10」对应 9 个 suite + 构建。**本轮开始时工作区里已有未提交的规范 v1.3 改动**（新增 `tools/verify-docs.mjs`、`tools/verify-meta.mjs`，并改了 `verify-all.mjs` 的套件表 / `package.json` / CI 等），基线本来就是 **12/12 EXIT=0**；这些改动在本轮进行中被提交为 `1efa38d`（不是我提交的）。它们不在本轮写域内，我没有改动或回退；本轮也没有新增测试文件。因此两套门禁的**退出码与结论都是绿的**，步骤数是 12（构建 + 11 个既有 suite），不是 10。

## 8. 未做 / 不确定

- **agent 工具**：本轮没有给 `worktodo_add` / `worktodo_update` 增加 `subtasks` 参数，`formatLine` 也不显示进度；agent 目前只能通过 `/list` 看到字段，不能按子项写。用户规格只要求 HTTP 契约与面板。
- **搜索**：`/list?query=` 仍只搜父标题 + 备注，不搜子待办标题；子项命中父项的搜索体验留待后续。
- **并发**：子待办是整数组 patch，last-write-wins；两个窗口同时改同一条父项会以最后写入为准（单用户本地场景接受）。
- **触屏拖拽**：HTML5 drag 在触屏上不可靠；上/下移动按钮是键盘与触屏的替代路径，但没有专门做 touch 排序。
- **320px 真机**：只做了结构与样式断言，没有在真实 320px 视口目测；展开区缩进 68px，标题过窄时仍走既有换行逻辑。
- **轻提示自动消失**：实现了 10s 定时器，但自动化用例只验证出现与点击，没有等 10s 验证消失（避免拖慢套件）。
- **备注焦点管理**：Esc 取消/保存后没有像标题那样显式把焦点还给「编辑」按钮；展开区没有焦点陷阱。
- **读盘超长备注**：`repairRecord` 不截断，旧数据 >4000 字仍会显示，保存时需要用户删减；这是有意的「不静默丢文字」。
- 依任务要求未升版本、未改 CHANGELOG / `.github`、未提交、未打 tag、未发布。
