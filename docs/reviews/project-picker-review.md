# 独立审查：快速添加行「项目」选择器（未提交改动）

对象：工作区**未提交**的改动（`git status` 里 10 个文件 + 未跟踪的 `docs/feature-project-picker.md`），
需求是给快速添加行第二行加第四项「项目」（可选已有 / 可直接新建，排在优先级之后）。
本次审查**未修改任何仓库源码、未 commit / push / tag、未触碰用户真实数据与真实 profile**；
所有回退实验都在 `/tmp/wtrev/repo` 的整树副本里做，副本已按 sha256 逐文件核对回源。

> 一句话结论：**可以放行（不需要为发布而阻塞）**。本次改动**没有把已有功能弄坏**——全量 `node tools/verify-all.mjs` 10/10，
> 载荷只涨了几百字节，宿主四条不变量与客户端交互全部保持；新功能自身**没有发现高严重度缺陷**，
> 只有 2 条中/中低严重度行为缺口（`B2` 重名查重只在客户端、`B3` 清单去重与其他读取路径口径不一致）
> 与 4 条低/信息级小项（`B5`/`B6`/`C3`/`B7` 测试缺口）。
> 若本轮顺手可改，建议先修 `B3`（trim 口径一致，1 行）与 `B7`（补 1 条截断提示用例）；`B2` 的完整修法（宿主侧查重）需要产品取舍，可以留给下一轮。

---

## 0. 审查方法与实跑清单

| 项目 | 做法 | 结果 |
| --- | --- | --- |
| 基线 | 仓库根跑 `WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs` | **10/10 步骤通过**（records 33 / service 29 / store 37 / host 58 / contract 17 / client 40 / workflows 11，0 失败） |
| 载荷体量 | 用真服务 + 5000 条内存记录，量 `JSON.stringify(payload)` 的字节数（带 / 不带 `projects`、四种 `shapes`） | 见 `A1`：**+311 B（26 个项目）**，最坏 50 个 200 字长名 **+10.4 KiB** |
| 反向验证 | 在 `/tmp` 整树副本里做 **5 组**回退（R1/R2/R3 复现作者结论 + R4/R5 是我加的关键用例回退） | 全部**必须变红**且只红对应项，见 §C2 |
| 静态核查 | `git diff` 逐行读 5 个源文件 + 抽查 `src/store.mjs` / `src/tools.mjs` / `lib/index.js` | 这三个宿主文件**未改**（`git diff --stat` 为空） |
| 构建产物 | `git status` + `grep -c data-wt-project lib/client.js` | `lib/client.js` 是**当前源码的产物**（含新标记，构建幂等） |

---

## A. 有没有弄坏已有功能

### A1（信息级 / 通过）`projects` 在任何 `shapes` 下都在，且载荷没有被意外放大

- 文件：`src/service.mjs:176`、`src/service.mjs:192-193`、`src/client/index.js:2100`
- **实跑**：新服务的 `list()` 在 `shapes = undefined / todos / groups / projectGroups` 下都返回 `projects` + `projectsTruncated`；
  客户端只请求 `groups`（按截止）或 `projectGroups`（按项目），两种视图都拿得到清单。
  5000 条记录、项目列 26 个（含中文项目）时：

  | shapes | 总载荷 | 去掉 projects | 差值 |
  | --- | --- | --- | --- |
  | 缺省（三份） | 3724.0 KiB | 3723.7 KiB | **+311 B** |
  | `todos` | 1240.9 KiB | 1240.6 KiB | **+311 B** |
  | `groups` | 1240.9 KiB | 1240.6 KiB | **+311 B** |
  | `projectGroups` | 1243.0 KiB | 1242.7 KiB | **+311 B** |

  最坏情形（50 个项目、每个名 200 字符）也只有 **+10.4 KiB**，且这是**上限**（`PROJECT_LIST_LIMIT = 50` 截断）。
  对比 0.2.4 的改造（三份 → 一份省下约 2/3），这点增量可以忽略；面板仍然只请求一种形状。
- 结论：**没有放大载荷，也没有把某个视图的清单弄丢**。

### A2（通过）现有交互没有被破坏

- **日期 / 时间胶囊**：`openPicker` 与透明原生输入的选择器逻辑未被触碰（`src/client/index.js:849-857`、`976-1012`），
  新增的两行只是给 `due` / `time` 的胶囊补上 `data-wt-field`（纯新增属性，不影响 `onClick` 的 `preventDefault` + `showPicker`）。
- **优先级四旗**：只加了 `data-wt-field` / `aria-label`（`src/client/index.js:1019`），弹层结构与 `onClick` 未变。
- **手动优先**：`setManual(true)` 只在 `setDate` / `setTime` 里调用，项目是纯手动字段（`project` 不参与 `parseNaturalDue`），
  改标题不会覆盖已有 `project`，也不会把 `manual` 置位——与设计一致。
- **拖拽排序 / 行级 `React.memo` / 错误边界**：本次改动全部在 `QuickAdd` 内部与载荷字段上，没有改 `TodoRow`、`Group`、
  `drag` 对象身份或 `WorkTodoErrorBoundary`。`QuickAdd` 是**未 memo 的函数组件**，新增两个 `useState` 不会让 `TodoRow` 的
  props 身份改变（面板仍把 `t` / `onToggle` 等稳定引用传下去）。面板 `return` 的是一个**带 key 的子元素数组**
  （`key: 'quick'` 等），所以错误条出现/消失也不会因为位置漂移把 `QuickAdd` 重挂载（不会连带丢掉已选项目）。
- **状态与生命周期**：新弹层没有引入任何 effect、`setTimeout`、`setInterval` 或全局监听，不存在未清理监听或
  无限渲染的路径（`React.useEffect` 仍然只有原来的 3 处：解析防抖 + 轮询 + 升级轮询）。
- **无障碍**：`aria-expanded`（`1049`）、`aria-haspopup="true"`（`1050`）、弹层 `role="group"` + `aria-label`（`1059-1060`）、
  选项 `aria-pressed`（`1072`）、输入框 `aria-label`（`1098`）、Esc 三处可关（chip `1052` / 弹层 `1061` / 输入框 `1100-1103`）。
- **安全**：项目名全程走 `React.createElement('span', {…}, name)` 文本子节点渲染，**没有 `innerHTML` / `dangerouslySetInnerHTML` 调用**
  （全客户端源码里这两词只出现在两处注释里：`src/client/index.js:478`、`1623`；另外既有用例
  `tools/smoke-client.mjs:913`「错误信息只走文本子节点：bundle 里不存在 innerHTML」也是全绿），用户输入不会被当 HTML 解析。

### A3（通过）四条宿主不变量仍然成立

- **存储后端不静默降级**：`src/store.mjs` 本次**一行没改**（`git diff --stat` 为空）；`verify-store.mjs` 37/37 通过，
  `smoke-host.mjs` 里 `backendError / mismatch / split / retired / merge` 的告警用例全绿。
- **批量 `updateOrder` 只写一次**：`src/service.mjs` 的 `reorder` 未被触碰；`verify-store.mjs` 37/37 里
  含「S3-1：domain 后端 updateOrder 走官方 table.update（写链内读-改-写）」与写次数计数用例，全绿。
- **路由注册兜底 / 挂载超时**：`lib/index.js`（宿主入口）**未改**；`smoke-host.mjs` 58/58 里 S1-1（第 N 条路由注册抛错只降级那一条、
  卸载清干净、重挂不撞 duplicate）与 S1-2（`storageDomain.open` 永不 resolve → 超时后仍挂满 8 路由 / 7 工具）全绿。
- **`/list` 的 shapes 语义**：`verify-service.mjs` 的 `shapes=todos` 只回一份、`groups` / `projectGroups` / 组合 / 缺省 / 非法值回落三份
  这几条全绿；且新用例**额外**断言「换成 shapes 不能把 stats / projects 这些小字段一起省掉」。

---

## B. 新功能自身的正确性

### B1（通过）排序与截断

- 文件：`src/records.mjs:485-511`（`PROJECT_LIST_LIMIT` / `listProjects`）
- **实跑**：`verify-records.mjs` 里 3 条 `listProjects` 用例全绿，我另外直接调用探针确认：
  出现次数降序 → 同次数按 `localeCompare` 升序；`60 个项目 → 50 个 + truncated:true`；`恰好 50 → truncated:false`；
  空数组 / 全空值 / `project: 42` / `null` 记录 / 非数组输入都**不抛**且返回 `{projects:[], truncated:false}`；
  emoji + 中文 + ASCII 混排返回 `["🚀 上线","beta","中文项目"]`（次数 2 的 emoji 项正确压过 1 次项）。
- **性能**：5000 条**全唯一**项目名时 `listProjects` 10.2 ms（每次 `/list` 一次，与载荷同数量级），不构成瓶颈。

### B2（中）重名对齐只在客户端做，宿主/agent 写入仍能造出近重名的第三个桶

- 文件：`src/client/index.js:816-822`（`matchExistingProject` 仅在客户端）、`src/records.mjs:120-127`（`normalizeProject` 只 trim、不做大小写归一）
- **实跑**（真服务 + 内存存储，模拟 agent / 手工编辑直接写入）：

  ```
  create({project:'Beta'}) / create({project:'beta'}) / create({project:'  BEta  '})
  → /list 的 projects: ["beta","Beta","BEta"]
  → projectGroups 的桶:  ["beta","Beta","BEta"]   （3 个桶）
  ```

- **现象**：面板的「按项目」视图会立刻裂成 3 个桶；用户从选择器点选只能得到其中一个。
  作者在 `docs/feature-project-picker.md` §5 已承认这一点。我评估：**风险中等但可控**——
  `worktodo_update` 的工具描述是「换项目」（鼓励传已有名），真正的触发面是 agent 凭记忆写一个新的大小写变体；
  行内编辑现成的项目字段（`src/client/index.js:1179,1243`，它把用户输入的 trim 值直接 `patch.project` 发出去，走 `/update`）也不查重，
  所以用户手动改一行的项目名同样可以造出 `Beta` vs `beta`。
- **最小修复建议**（三种强度，任选）：
  1. 最便宜：在 `worktodo_add` / `worktodo_update` 的工具描述里加一句「项目名请沿用 `worktodo_list` 里已有的项目名」——不碰代码；
  2. 宿主侧软对齐：`/create` 与 `/update` 落库前，用 `listProjects(records)`（忽略大小写）把**近似重名**对齐到已有原名，
     命中时在返回里带 `projectAlignedFrom`，面板照旧；这会改变既有数据语义，需要作者确认；
  3. 只做「面板内一致」：把行内编辑的项目输入也接上 `matchExistingProject`（1 行），至少把面板能触发的路径堵住。

### B3（中）清单口径与其余读取路径不一致：`listProjects` 会 trim，`groupByProject` / `/list?project=` 不会

- 文件：`src/records.mjs:502`（`record.project.trim()`）vs `src/records.mjs:451-452`（`record.project ?? null`，不 trim）
  与 `src/service.mjs:144-146`（`project` 参数用 `String(project).trim().toLowerCase()` 比对 `r.project.toLowerCase()`）
- **实跑**：存储里有一条 `project: ' beta '`（只有手改 JSON / 迁移才可能产生，正常写入路径 `normalizeProject` 会 trim）：

  ```
  /list 的 projects      → ["beta"]        （清单里显示 beta）
  /list?project=beta     → 0 条            （点了这个项目却一条都看不到）
  projectGroups 的桶名    → " beta "       （桶名与清单里的名字不是同一个字符串）
  ```

- **现象**：面板「按项目」视图里会出现一个叫 `beta` 的桶，但点选择器选 `beta` 时筛选命中 0 条；
  如果以后给 `projectGroups` 加重名合并，两处口径不一致还会继续咬人。旧版客户端把清单 trim 过再显示，
  所以**用户可见行为没有回归**，但「清单来自哪里」这件事现在有两套口径。
- **最小修复建议**：`listProjects` 不要 trim，只做「去空白后为空则跳过」判断（`const name = typeof r?.project === 'string' ? r.project : '';` + 用 `name.trim()` 只做空判定），
  与 `groupByProject` 保持逐字一致；或者在 `groupByProject` 与 `/list?project=` 两侧都补 trim（改动更大）。

### B4（通过）清空确实落 `project: null`

- 文件：`src/client/index.js:1081-1090`（未归类按钮 `setProject(null)`，`1089`）、`src/client/index.js:891`（`project ?? null`）、`1833`（面板侧再 trim 一次）
- **实跑**：R3（把未归类按钮的 `onClick` 改成空函数）→ 只红 1 条；
  R4（把 `handleAdd` 改成「没有项目就不发这个键」）→ 客户端 1 条 + 契约 3 条变红。
  说明「键存在且为 `null`」这条约定**有真实用例守着**，而且确实有别于「缺键 / undefined」（宿主对请求体做无损 JSON 校验）。

### B5（低）弹层外部点击不关闭，且草稿值会残留在被关掉的状态里

- 文件：`src/client/index.js:1043-1056`（chip）、`1057-1116`（弹层）
- **静态推断**：整个弹层**没有** `onBlur` / 文档级 `mousedown` 监听；面板里唯一注册的 `document` 监听是 `visibilitychange`（`1719`）。
  打开弹层后点面板别处，弹层不会关，只能再点 chip 或按 Esc。
  **这个是既有风格**——优先级四旗弹层（`1024-1039`）同样没有外部点击关闭，所以**不算本次引入的回归**，
  但项目弹层比优先级弹层大（最多 50 行 + 输入框），遮挡更明显。
- 附带小问题：`projectDraft` 在弹层关闭时**不清空**。用户输入 `gam` → 按 Esc 或点别处 → 再点开，输入框里还是 `gam`。
  可解释为「保留了上次输入」，但没有提示，容易被当成渲染 bug。
- **最小修复建议**：给 chip 加 `onBlur`/在弹层内 `onMouseDown` 里预判焦点移出（或简单地在 `setProjectOpen(false)` 时一并 `setProjectDraft('')`）——
  后者 1 行、零风险，建议顺手做。

### B6（低）`listProjects` 对非法 `limit` 静默回落 50，`Infinity` 反而不截断

- 文件：`src/records.mjs:508`（`Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : PROJECT_LIST_LIMIT`）
- **实跑探针**：`limit=-1 → 返回全部（等效 50）`、`limit=NaN → 全部`、`limit="2" → 全部`（字符串不认）、`limit=2.7 → 2`、`limit=Infinity → 全部`。
- **现象**：`-1` 与 `"2"` 这类调用方错误被静默吞掉；`Infinity` 绕过截断（当前没有调用方这么传，属防御性缺口）。
  函数只在宿主内部与测试里用，实际影响≈0。
- **最小修复建议**：`const cap = Number.isFinite(Number(limit)) && Number(limit) >= 0 ? Math.floor(Number(limit)) : PROJECT_LIST_LIMIT;`
  或对负值抛/返回 `{projects:[], truncated:true}` 并加一条用例。

### B7（信息级）测试覆盖缺口：`projectsTruncated === true` 时的那行提示文案没有任何用例

- 文件：`src/client/index.js:1111-1114`
- **静态推断**：`smoke-client.mjs` 的假载荷里 `projects` 最多 3 条、`projectsTruncated` 从未置真，
  也没有「把提示整段删掉必须变红」的回退实验。也就是说 **`projectListTruncated` 这条 UI 分支目前是测试盲区**
  （locale 键存在性由「zh/en 键一一对应」用例覆盖，但渲染分支没覆盖）。
- **最小修复建议**：在既有「弹层列出已有项目」用例里补一个 `projectsTruncated: true` 的分支，
  断言弹层底部出现 `fillTemplate('[projectListTruncated]', {count: 3})` 且含 `{count}` 已被替换（不是裸模板）。

---

## C. 测试有没有牙齿

### C1（通过）新增用例没有恒真断言

逐条读过 4 个测试文件的全部新增用例（`verify-records` 3 条、`verify-service` 4 条、`smoke-host` 4 条、`smoke-contract` 4 条、`smoke-client` 6 条），
断言都是**具体值/计数/来源**（`eq(listProjects(rows).projects, ['zeta','beta','alpha'])`、`eq(view.projects.length, 50)`、
`eq(data.projects.includes('alpha'), true)`、`eq(body.project, null)` 等），没有 `assert(true)`、
没有「只断言函数被调用过」、没有把实现抄进测试再互相比对（排序规则只有 `listProjects` 一处实现，测试调的就是它）。
唯一偏弱的断言在 `verify-service.mjs:311`：`eq(view.projects, [], …)` 的空清单用例没顺带断言 `projectsTruncated === false`
（值层面靠 `smoke-host.mjs` 的 `typeof === 'boolean'` 与客户端用例兜着）——但该文件 `:315` 另有 `eq(view.projectsTruncated, false, …)`，所以**不是恒真**，
只是分工上略薄。

### C2（通过）我做了 5 组「回退修复 → 必须变红」验证（全部在 `/tmp/wtrev/repo` 副本，已按 sha256 核对恢复）

| 回退 | 改动 | 期望/实际 | 结论 |
| --- | --- | --- | --- |
| **R1**（复现作者） | `src/service.mjs:176` 换回 `[...new Set(...)].sort()`，删掉 `projectsTruncated` | service **26 通过 / 3 失败**、host **55 通过 / 3 失败**（与作者报告逐字一致：字典序、60→未截断） | 有牙 |
| **R2**（复现作者） | `src/client/index.js` 弹层里不再 `map(projectOptions)` | client **36 通过 / 4 失败**（与作者报告一致，含连带 3 条） | 有牙 |
| **R3**（复现作者） | 「未归类」`onClick` 改空函数 | client **39 通过 / 1 失败**（只有那 1 条红 → 独立靶子） | 有牙 |
| **R4**（我加的） | `handleAdd` 改成「无项目就不发这个键」（`...(cond ? {project} : {})`） | client **1 红** + contract **3 红**（静态正则 + 行为） | 有牙 |
| **R5**（我加的） | `matchExistingProject` 去掉 `toLowerCase()`（即大小写敏感） | client **39 通过 / 1 失败**，只有「重名（大小写/首尾空白）」那条红 | 有牙且靶向准 |

另外我用「把优先级 chip 的 `data-wt-field` 改名」验证了**渲染顺序断言**不是摆设：client **39 通过 / 1 失败**，
红的正是「第二行的四个 chip 顺序是 日期→时间→优先级→项目」。

### C3（低）一条契约断言绑死在源码文本上，重构会误报

- 文件：`tools/smoke-contract.mjs:174-178`
- **现象**：`/project:\s*input\?\.project\s*\?\s*String\(input\.project\)\.trim\(\)\s*:\s*null/` 直接匹配 `src/client/index.js` 的**字面量**。
  好处：R4 证明它真的会红。坏处：把那个表达式抽成 `normalizeProjectInput()` 之类的等价重构会让它**假红**；
  而把条件写成 `!input?.project ? … : null` 这种逻辑反了的写法，正则**依然通过**（语义没被守住）。
- **最小修复建议**：保留正则作为「防手滑」的一层，同时补一条**行为**断言（R4 已经证明行为层能红：
  用客户端字面报文形状打真实 `/create`，断言「报文里 `project` 键存在且为 null 时宿主落 `null` 且清单里不出现空项目」）。

---

## 附：严重级别汇总

| 编号 | 级别 | 位置 | 一句话 |
| --- | --- | --- | --- |
| A1 | 通过 | `src/service.mjs:176,192` | 任何 shapes 都带清单，载荷 +311 B（最坏 +10.4 KiB，有 50 上限） |
| A2 / A3 | 通过 | — | 既有交互、`React.memo`、错误边界、手动优先、四条宿主不变量全绿 |
| B1 / B4 | 通过 | `src/records.mjs:485-511`、`src/client/index.js:891,1089,1833` | 排序/截断正确；清空是显式 `null`（R3/R4 有牙） |
| **B2** | **中** | `src/client/index.js:816-822`、`src/records.mjs:120-127` | 重名查重只在客户端 → agent/行内编辑仍可造 `Beta`/`beta`/`BEta` 三个桶 |
| **B3** | **中低** | `src/records.mjs:502` vs `:451`、`src/service.mjs:144-146` | 清单 trim 了，`projectGroups`/`?project=` 没 trim → 手改数据下「选了却 0 条」 |
| B5 | 低 | `src/client/index.js:1043-1116` | 弹层无外部点击关闭（与优先级弹层同风格，非回归）；`projectDraft` 残留 |
| B6 | 低 | `src/records.mjs:508` | `limit=-1/"2"/NaN` 静默回落 50，`Infinity` 不截断 |
| B7 | 低（测试缺口） | `src/client/index.js:1111-1114` | `projectsTruncated=true` 的提示文案无用例 |
| C1/C2 | 通过 | 5 个测试文件 | 无恒真断言；5 组回退全部按预期变红 |
| C3 | 低 | `tools/smoke-contract.mjs:174-178` | 契约断言绑死源码文本，等价重构会假红 |

**放行判断**：本次改动**不阻塞发布**；建议本轮顺手修 `B3`（1 行 trim 口径）与 `B7`（1 条用例），
`B2` 的宿主侧查重是产品取舍，留给下一轮并在 CHANGELOG / 插件说明里写清「项目名请沿用已有名」。

> 仓库地址（`docs/`、`tools/` 等路径都不在 npm 发布包里）：<https://github.com/olimc2016/dsh-worktodo>
