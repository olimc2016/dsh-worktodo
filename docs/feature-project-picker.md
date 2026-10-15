# 快速添加行的「项目」选择器（feature-project-picker）

对象：仓库 `dsh-worktodo`（本次改动只碰代码与测试，**未升版本、未改 CHANGELOG 版本段、未动 `.github/`、未 commit/tag/发布**）。
复现环境：仓库根 `~/Documents/deepseek-harness/default-workspace/dsh-worktodo`，Node 用 `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`，
跑测试前 `export WORKTODO_NO_UPDATE_CHECK=1`，全量 `node tools/verify-all.mjs`（会先构建客户端 bundle）。

需求一句话：快速添加的第二行（原来只有 日期 / 时间 / 优先级）**在优先级之后**加第四项「项目」，
既可选用已有项目，也能直接新建，未设置 = 未归类。

---

## 1. 设计

### 1.1 宿主：`/list` 的「已知项目清单」

面板要能列出已有项目，所以宿主必须把清单给它。

| 维度 | 决定 |
| --- | --- |
| 字段 | `projects: string[]`，**始终存在**；另加 `projectsTruncated: boolean` |
| 数据来源 | **全部记录**的 `project`（不是筛后子集，也不随 `filter` / `project` 收窄变化） |
| 形状 | **不受 `shapes` 影响**：`shapes=todos` / `groups` / `projectGroups` 下都在（它是小数组，而「按截止」视图下同样要能点开选择器） |
| 去重 | 同名去重；忽略空值 / 纯空白 / 非字符串（未归类不是项目） |
| 排序 | **出现次数降序** → 次数相同按**名称升序**（`localeCompare`） |
| 截断 | 超过 `PROJECT_LIST_LIMIT = 50` 只回前 50 个，并把 `projectsTruncated` 置 `true` |
| 落点 | 纯函数 `listProjects()` 在 `src/records.mjs`；`src/service.mjs` 的 `list()` 组装进载荷 |

为什么把排序/截断抽成纯函数：`/list` 载荷与单测用**同一份**逻辑（不是测试里再抄一遍排序），
反向验证时也只需要回退 `service.mjs` 那一处就能看见红。

为什么清单取自**全量**而不是当前筛选：面板顶部可以切「已完成」、也可以按项目收窄，
但选择器必须始终列得出**所有**可选项目，否则切进去就再也切不出来。

向后兼容：`projects` 这个键在 0.2.x 就有（旧写法是 `[...new Set(...)].sort()`），
本次只是把**排序规则**换成「常用优先」并加了截断与 `projectsTruncated`；老面板不看新字段、
新面板不看老字段都不受影响（`smoke-contract.mjs` 的字段清单断言仍然覆盖 `projects`）。

### 1.2 客户端：第二行第四项

顺序固定为 **日期 → 时间 → 优先级 → 项目**（四个 chip 各带 `data-wt-field`，
测试直接断言渲染顺序 `['due','time','priority','project']`，而不是断言一个可能与渲染脱节的常量）。

- **未设置**：`项目 · 未归类`，颜色用 `C.label3`（灰）；**已设置**：显示项目名，颜色 `C.label`（正常色）。
- **点击弹出小弹层**（与优先级四旗同一种弹层风格、同一套 `C.*` 主题变量、同一位置策略 `position:absolute; top:100%`）：
  1. **已有项目**：一行一个，点击即选中；当前选中的高亮（`aria-pressed=true` + 边框用 `C.brand`）；
  2. **未归类**：一键清除，等价 `project = null`；
  3. **新建**：文本输入 + 「新建」按钮，**回车即新建**；
  4. `projectsTruncated` 为真时，弹层底部提示「项目较多，只显示最常用的 {count} 个」。
- **重名处理**：`matchExistingProject()`（导出为纯函数）按**忽略大小写 + 去首尾空白**去匹配；
  命中就把值对齐到**已有项目的原名**（例如已有 `beta`，输入 `  BETA  ` → 选中 `beta`），
  不报错、也不造一个只差大小写的第二份（那会让「按项目」视图立刻裂成两个桶）。
- **提交**：项目值随 `/create` 报文一起发；**空值用显式 `null`**（不是 `undefined`）——
  宿主对请求体做「无损 JSON」校验，`undefined` 会变成「没有这个键」甚至整次调用被拒
  （`worktodo_add` 当年踩过同类坑）。面板侧 `handleAdd` 再 `String(...).trim()` 一次兜底。
- **手动优先 / 复位**：项目是**纯手动**字段（标题里没有"项目词"可解析），所以标题解析不会覆盖它；
  标题清空与添加成功后沿用现有逻辑——与 日期 / 时间 / 优先级 一致：**保留项目值**（连着录同一批事不用重设），
  只收起弹层、清标题、复位 `manual/parsed`。
- **无障碍**：chip 有 `aria-label` / `aria-expanded` / `aria-haspopup`；弹层 `role="group"` + `aria-label`；
  Esc 在 chip、弹层、输入框三处都能关闭；Tab 可在「已有项目 → 未归类 → 输入框 → 新建」间原生进出；
  Enter 在标题框提交、在新项目输入框新建。文案 zh/en 双份走既有字典机制，**全程不用 `innerHTML`**。
- **形状无关**：面板按视图只请求一种 `shapes`，而 `projects` 在任何形状下都在载荷里（见 1.1），
  所以停在「按截止」还是「按项目」都能列出项目。

### 1.3 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/records.mjs` | 新增 `PROJECT_LIST_LIMIT` 与纯函数 `listProjects()` |
| `src/service.mjs` | `list()` 载荷始终带 `projects` / `projectsTruncated` |
| `src/client/index.js` | zh/en 新文案、`IconFolder`、`matchExistingProject()`、QuickAdd 的项目 chip + 弹层、`handleAdd` 带 `project`、面板把 `projects` 透传给 QuickAdd |
| `lib/client.js`(+map) | 构建产物（`verify-all` 会先构建） |
| `tools/*.mjs` | 5 个现有测试文件里加用例（见下） |

---

## 2. 测试覆盖

用例全部加在现有 9 个测试文件里，没有新增测试文件。

| 文件 | 新增用例（要点） |
| --- | --- |
| `verify-records.mjs` | `listProjects`：空清单 / 去重 / 忽略空值与脏数据；**次数降序 → 名称升序（不是纯字典序）**；**超 50 截断 + `truncated`**、恰好等于上限不算截断、上限可注入（含 0） |
| `verify-service.mjs` | `/list` 在 `undefined`/`todos`/`groups`/`projectGroups`/组合下都带 `projects`+`projectsTruncated`；排序 + 来自全量（切「已完成」/按项目收窄都不变）；60 个项目在三种形状下都截断到 50；`create`/`update` 带 `project` 落库并被 `projects` 反映，含 `project:null` 与空白串清空 |
| `smoke-host.mjs` | 路由级：任何 `shapes` 下都有清单（含 `stats` 等小字段不被 shapes 省掉）；**频次 vs 字典序**、同频次名称升序；60 个项目截断 + `projectsTruncated=true`；`POST /create` 带 `project` 落库并进清单、`POST /update` 改名 / `project:null` 清空后从清单消失 |
| `smoke-contract.mjs` | 静态：`/create` 报文键含 `project`，且源码里 `project` 的空值表达式必须是 `... ? String(...).trim() : null`；行为：带 `project` 的 create 报文能落库，三种 `shapes` 下清单都含它；`project:null` 能清空；`/list` 字段清单加 `projectsTruncated` |
| `smoke-client.mjs` | ① 第二行四个 chip 顺序 = `['due','time','priority','project']`，未设置文案与灰色；② 弹层列出已有项目、点选后 chip 变项目名 + 当前项 `aria-pressed` 高亮，提交报文带该项目名；③ 新建名（回车）→ chip 变新名、报文带新名、**本地不会把新名塞进「已有」清单**；④ 重名（大小写/空白）→ 选中已有原名、清单不多一行、报文带原名；⑤ 选「未归类」→ chip 回到未归类、报文 `project` **键存在且为 `null`**；⑥ 键盘：`aria-expanded` 跟随开合、弹层 `role=group`、Esc 在弹层/输入框都能关、Enter 能新建 |

`verify-store.mjs` / `verify-workflows.mjs` / `verify-privacy.mjs` / `verify-submission.mjs` 未改（本次不涉及持久化格式、CI、发布面）。

---

## 3. 反向验证（回退修复 → 测试必须变红）

做法：改一处实现 → 只跑相关套件 → 记录红名单与报错原文 → 从 `/tmp` 快照恢复 → 复跑确认回绿。
（每次都没碰用户真实数据；测试用临时 `DSH_HOME` / `mkdtemp` 目录。）

### R1 → 对应需求第 1 条（宿主在任何 `shapes` 下都给清单，且排序/截断正确）

回退：`src/service.mjs` 里把清单换回旧写法
`projects: [...new Set(records.map((r) => r.project).filter(Boolean))].sort()`，并删掉 `projectsTruncated`。

```bash
export WORKTODO_NO_UPDATE_CHECK=1
node tools/verify-service.mjs   # 26 通过，3 失败
node tools/smoke-host.mjs       # 55 通过，3 失败
```

红名单（新增用例全部命中）：

```
✗ /list 在任何 shapes 下都带 projects / projectsTruncated（空清单时是 [] / false）
✗ /list 的 projects：按出现次数降序 → 名称升序；来自全量而非当前筛选（去掉空值）
    Error: 期望 ["zeta","alpha","beta"]，实际 ["alpha","beta","zeta"]
✗ /list 的 projects 超过上限时只回前 50 个并置 projectsTruncated（任何 shapes 都截断）
    Error: shapes=undefined 时回前 50 个：期望 50，实际 60
✗ GET /list 在任何 shapes 下都带 projects / projectsTruncated（面板项目选择器的数据来源）
✗ GET /list 的 projects 按出现次数降序（不是字典序），次数相同按名称升序
    Error: 常用的（3 次）必须排在只用过 1 次的前面：["aaa-sort","alpha","zzz-sort"]期望 true，实际 false
✗ GET /list 的 projects 超过 50 个时截断并置 projectsTruncated=true（面板据此提示「只显示常用项」）
```

### R2 → 对应需求第 4 条（弹层渲染已有项目、点选后报文带该项目名）

回退：`src/client/index.js` 弹层里删掉 `...projectOptions.map(...)`（不再列已有项目）→ 重新构建后跑。

```bash
node tools/build-client.mjs
node tools/smoke-client.mjs     # 36 通过，4 失败
```

```
✗ 项目弹层列出已有项目；点选后 chip 变项目名、当前项高亮，提交报文带该项目名
    Error: 已有项目要按宿主的顺序一行一个：期望 ["dsh-worktodo","alpha","beta"]，实际 []
✗ 新建项目：输入新名字回车 → chip 变新名字，提交报文带新名字（且不由本地塞进「已有」清单）
✗ 新建项目重名（大小写/首尾空白不同）→ 选中已有项目的原名，不产生第二份
✗ 选「未归类」→ chip 回到未归类，提交报文的 project 是显式 null（不是缺键 / undefined）
```

（后三条同红是合理的连带：它们都要先经过"点选已有项目"这条路径。）

### R3 → 对应需求第 6 条（选「未归类」→ 报文 `project: null`）

回退：`src/client/index.js` 把「未归类」按钮的 `onClick` 改成空函数（只退这一处）→ 重新构建后跑。

```bash
node tools/build-client.mjs
node tools/smoke-client.mjs     # 39 通过，1 失败
```

```
✗ 选「未归类」→ chip 回到未归类，提交报文的 project 是显式 null（不是缺键 / undefined）
    Error: 清除后回到「项目 · 未归类」：期望 "[projectLabel] · [noProject]"，实际 "alpha"
```

**独立性**：R3 只让第 6 条变红，其余 39 条全绿 → 这条用例的确是「未归类 = 清空」的专属靶子。

需求第 3、5 条未做回退实验（按任务要求只做第 1、4、6 条）。

---

## 4. 全量测试

```bash
export WORKTODO_NO_UPDATE_CHECK=1
node tools/verify-all.mjs
```

```
  ✓ 客户端 bundle 构建  (build-client.mjs)
  ✓ 数据模型  (verify-records.mjs)
  ✓ 服务层  (verify-service.mjs)
  ✓ 存储层  (verify-store.mjs)
  ✓ 宿主接线与工具  (smoke-host.mjs)
  ✓ 客户端↔宿主契约  (smoke-contract.mjs)
  ✓ 客户端 bundle  (smoke-client.mjs)
  ✓ CI workflow 契约  (verify-workflows.mjs)
  ✓ 发布面审计（隐私与文档完整性）  (verify-privacy.mjs)
  ✓ 收录提交门禁  (verify-submission.mjs)

10/10 个步骤通过（含构建）
```

---

## 5. 未做 / 不确定

**未做**

- 项目**重命名 / 删除 / 合并**没有专门 UI：仍走每行的行内编辑（自由文本 `project` 输入框）与 agent 工具。
- 弹层**没有搜索框**，也没有「查看全部 N 个项目」：超过 50 个时只列最常用的前 50 个。
- 查重只在**客户端**做：宿主/工具侧仍允许写入只差大小写的两个项目（比如 agent 用 `worktodo_add` 直接写 `Beta` 与 `beta`）；
  未在 `normalizeProject` 里做大小写归一（那会改变既有数据语义，超出本轮范围）。
- 未做「项目清单」的缓存：每次 `/list` 都重新统计一遍（O(记录数)，与载荷同一数量级，暂不构成瓶颈）。

**不确定**

- `localeCompare` 对**中文项目名**的先后顺序依赖运行环境 locale（只在"次数相同"时作为次序）；测试里只用 ASCII 名字钉住行为。
- 50 这个上限是拍的：常用项目真的超过 50 个时，冷门项目在面板里就选不到了（只能手动输入新建，重名仍会被对齐到已有原名）。
- 弹层交互只在**迷你渲染器**里验证（断言事件处理函数与渲染结构），没有在真实浏览器里跑一遍；
  视觉与 Tab 实际焦点顺序仍需要人眼过一遍（弹层是绝对定位、没有做焦点陷阱）。
- 「添加成功后保留项目」是与 日期/时间/优先级 对齐后的取舍：如果产品上更希望"录完一条就回到未归类"，需要改一行（`setProject(null)`），
  当前行为已由 `smoke-client.mjs` 隐含覆盖（同一窗口内连续两次提交复用同一个项目值）。
