# 修复报告：项目选择器审查里的非阻塞问题（B3 / B2 / 低优先）

对象：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`（工作区改动，**未 commit / 未 push / 未打 tag / 未升版本 / 未动 CHANGELOG 与 `.github`**）。
来源：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/docs/reviews/project-picker-review.md`（224 行，含复现步骤）。
本轮**只收缩改动面**：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/records.mjs`、`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/service.mjs`、`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/tools.mjs`（只改工具描述）、`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/*`（测试文件仍 9 个，未新增文件）。
反向验证一律在 `/tmp/wtfix/repo` 的整树副本里做，**没有**在用户工作树里回退过；副本与工作树逐文件 sha256 核对过。

## 0. 一句话结论

B3 与 B2（含**宿主侧归一**，原报告建议「留给下一轮」的那一半）都已修掉并有带牙齿的用例；
低优先里做了 `projectsTruncated` 文案用例、`limit` 边界、契约断言去文本绑定这三条，`B5` 按指示不做、只记取舍。
全量 `node tools/verify-all.mjs` **10/10（含构建）**，各套用例：records 35 / service 31 / store 37 / host 59 / contract 18 / client 41 / workflows 11，0 失败。

## 1. 逐条修法 / 测试 / 反向验证

### B3（中低）清单口径与其余读取路径不一致 —— **已修**

- **根因**（实跑复核）：`listProjects` 输出 `trim()` 过的名字，但
  `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/records.mjs:451` 的 `groupByProject` 用原样字符串，
  `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/service.mjs:185-186` 的 `/list?project=` 又是
  「**参数** trim + 忽略大小写」去比「**记录**原样」——存储里存在 `" beta "` 时，清单显示 `beta`、过滤键是 `beta`、
  记录值是 `" beta "`，比较恒不相等 → 点选命中 0 条。
- **修法**（两处，都很小）：
  1. `src/records.mjs` 的 `listProjects`：**输出原样字符串**，只用 `name.trim()` 判断「是不是空」。
     清单给什么值，`/list?project=` 就用什么值命中，与 `groupByProject` 的桶名逐字一致；
  2. `src/service.mjs` 的过滤侧：比较时**两边都 trim**（`(r.project ?? '').trim().toLowerCase() === wanted`），
     这样「原样值 `" beta "`」与「选择器 trim 后显示的 `beta`」都能命中同一条，
     而记录之间也只有「忽略首尾空白 + 忽略大小写」的差异才算同一个项目。
- **用例**：
  - `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/verify-records.mjs:250`「listProjects：空清单 / 去重 / 忽略空值与脏数据，且不凭空造项目」里加了
    「清单原样给出 `" beta "`」+「与 `groupByProject` 桶名是同一个字符串」两条断言（用**原始记录**造，因为 `mk()` 走 `createRecord` 会 trim）；
  - 同文件新增「listProjects：忽略全空白名（未归类），但保留带首尾空白的真实项目名」；
  - `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/verify-service.mjs:354` 新增
    「B3：清单里给出的项目名原样拿去 /list?project= 必须命中」——**核心断言**是
    「用清单里给出的值过滤必须命中该记录」，另加两种存量写法（`" beta "` / `beta`）算同一个项目、清单仍原样给出。
- **反向验证**（副本）：把 `listProjects` 输出改回 `.trim()` → records **33 通过 / 2 失败**（只红 B3 两条），
  service **30 通过 / 1 失败**（只红 B3 那条）；恢复后回到 35 / 31 全绿。
  再把过滤侧记录值去掉 `.trim()` → service **30 通过 / 1 失败**，红的仍是 B3 那条。
- **遗留（要写进下一轮，不在本轮扩大改动面）**：`listProjects` 只按**逐字**去重，所以存储里同时存在
  `" beta "` 与 `beta` 时清单会有两个条目（`groupByProject` 同理）。本轮保证的是
  **每个条目都能命中**（已在用例里逐条验证），不再有「选了却 0 条」。

### B2（中）重名只在客户端查重 —— **两半都做了**

#### B2-1（工具描述）已修

- `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/tools.mjs:97-102`（`worktodo_add` 的 `project`）、
  `:160-163`（`worktodo_add_many` 的 `items[].project`）、`:304-308`（`worktodo_update` 的 `project`）都补上
  「项目名请复用/沿用一个已有名，别写只差大小写/空白的变体；不确定就先调 `worktodo_list` 看 `projects` 清单」。
- **用例**：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-host.mjs:275`「B2：登记/修改项目的工具描述必须提醒『复用已有项目名』（防止以后被删）」——
  三个工具都断言描述里含「复用 / 既有 / 保持一致」，并要求给出自查方式（`worktodo_list`）。
  断言的是**编译后的 schema**（`parameters.properties…`），不是源码文本，所以换行/拼接写法不会假红。
- **反向验证**：把三处描述删回原样 → host **58 通过 / 1 失败**，只红这一条。

#### B2-2（宿主侧归一）已修（低成本，约 30 行、无新概念、无新载荷字段）

- `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/service.mjs:105-124` 加了两个局部助手：
  `alignProject(records, normalized)` 与 `snapshotForAlign()`；规则与客户端 `matchExistingProject` **完全相同**
  （忽略大小写 + 去首尾空白），命中已有项目时**存已有原名**，没有近似重名时**原样保留**（不改大小写）。
- 落库点只有两个：`create`（`src/service.mjs:260-262`）与 `update`（`:345-353`）。
  `update` 的候选池是「除自己外的全部记录 + 自己当前那条」：
  「改到别人的大小写变体」命中别人（`Ops` → `beta` 命中 `Beta`），
  「只改自己项目的大小写」留在自己的原名上（`Ops` → `oPS` 仍是 `Ops`），同时**排除自己的旧名**，
  避免改名时匹配到自己、白白放过真正的重名。
- 任何一步读失败（`store.load()` 抛错）都只跳过对齐、忠实落库，不会把写操作变成失败。
- **用例**：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/verify-service.mjs:394`「B2：宿主侧把近似重名归一到已有项目名」——
  `Beta` / `beta` / `'  BEta  '` 三次 create 后 `/list.projects` 与 `projectGroups` 都只有一个桶；
  update 的 `oPS → Ops` 归一、`betA → Beta`（排除自己）、全新名 `NewThing` 原样保留。
- **反向验证**：去掉 `create` 的对齐 → service **30 通过 / 1 失败**（只红 B2）；
  再把 `update` 的候选池换回「不含自己」的旧写法 → 同样只红 B2。
- **取舍（明确记下）**：这一半会改变「只差大小写的改名」的落库结果（例如把某条从 `Ops` 改成 `oPS` 会留在 `Ops`）。
  这与面板侧既有行为一致（选择器本来只会给出已有原名），且不再制造第二个桶；
  若以后要支持「精确大小写改名」，需要产品层面决定（本轮不做）。

### B7（低 · 测试盲区）`projectsTruncated` 的提示文案 —— **已补用例**

- `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-client.mjs:1294` 新增
  「B7：清单被截断（projectsTruncated）时弹层出现提示文案，且 {count} 已替换成实际条数」：
  正例断言那句 `项目较多，只显示最常用的 {count} 个` 真的渲染出来、`{count}` 不再是裸占位符、数字等于实际展示条数（3）；
  反例把 `projectsTruncated` 置回 false，断言这句提示不出现（证明断言不是恒真）。
- **反向验证**：把 `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/client/index.js:1111-1115` 的提示整段换成 `null`
  并重新 build → client **40 通过 / 1 失败**，只红 B7。

### B6（低）`listProjects` 的非法 `limit` —— **已明确处理**

- `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/records.mjs`：
  `const wanted = Number(limit); const cap = Number.isFinite(wanted) && wanted >= 0 ? Math.floor(wanted) : PROJECT_LIST_LIMIT;`
  → `-1` / `NaN` / 乱码回落默认 50，**数字字符串（`"2"`）可用**，`Infinity` 回落默认（不再绕过截断），小数向下取整。
- **用例**：records 新增「listProjects：非法 limit 明确回落默认 50；数字字符串可用；Infinity/负值不能绕过截断」，
  覆盖 `-1` / `"2"` / `NaN` / `Infinity` / `"乱写"` / `undefined` / `2.7` / `"2.9"`。
- **反向验证**：把 `cap` 换回 `Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : …` → records **34 通过 / 1 失败**，只红这一条。

### C3（低）契约断言绑死源码文本 —— **已换成结构 + 行为**

- 删掉 `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-contract.mjs` 里两条**绑字面量**的正则
  （`project:` / `dueTime:` 的 `input?.x ? String(x)… : null`）。
- 换成 `stripLineComments()` + `extractArgExpression()` + `evaluateCreateArg()`：
  从 `/create` 的报文对象字面量里**深度感知地抽出该键的表达式原文**，再在独立作用域里对两种输入求值：
  （a）没给值 → **必须是 `null`**；（b）给了值 → 等于期望值（顺带证明不是恒 null）。抽表达式时按字符串感知剥行注释，
  不会毁掉 `'https://…'` 这类字面量。
- 另加**行为**用例 `smoke-contract.mjs:446`「C3：create/update 两条路径的空值语义（显式 null 与空串）落到宿主都不产生空项目」：
  用与 `handleAdd` 同形的报文打真实 `/create`（`project:null` / `dueTime:null`），断言记录里 `project` 键存在且为 `null`、
  未归类不进 `projects` 清单；再用 `/update` 的 `project:null` 走一遍清空。
- **反向验证（副本）**：
  - 把 `/create` 报文里的条件**写反**（`!input?.project ? … : null`，即旧正则会假通过的那种）→ contract **16 通过 / 2 失败**（project 与 dueTime 各一条）；
  - 把 `project` 换成语义**等价**的重构（IIFE + `typeof raw === 'string' ? raw.trim() : null`）→ contract **18 通过 / 0 失败**（旧正则在这里会假红）。
- 说明：客户端 bundle 里没有字面量，所以这个「假红/假通过」实验是对**源码**做的，符合契约检查的对象。

### B5（低）弹层「点击外部关闭」/ `projectDraft` 残留 —— **按指示不做**

- 优先级四旗弹层（`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/client/index.js:1024-1039`）同样没有外部点击关闭，
  两个弹层行为保持一致，**不算本次回归**；`projectDraft` 残留可解释为「保留上次输入」。
- 记为**已知取舍**：不做外部点击关闭，也不额外清 `projectDraft`；若要统一改，应一次改两个弹层（留给下一轮）。

## 2. 反向验证汇总（全部在 `/tmp/wtfix/repo` 副本，未动工作树）

| 回退 | 改动 | 结果 | 结论 |
| --- | --- | --- | --- |
| R1 | `listProjects` 输出改回 `.trim()` | records 33/2 红；service 30/1 红 | B3 用例有牙 |
| R2 | 过滤侧记录值去掉 `.trim()` | service 30/1 红（只红 B3） | B3 过滤侧有牙 |
| R3 | 去掉 `create` 的宿主归一 | service 30/1 红（只红 B2） | B2 create 有牙 |
| R4 | `update` 候选池换成「不含自己」 | service 30/1 红（只红 B2） | B2 update 有牙 |
| R5 | 删掉三处工具描述的「复用」提醒 | host 58/1 红 | B2-1 有牙 |
| R6 | `limit` 换回旧写法 | records 34/1 红 | B6 有牙 |
| R7 | 删掉截断提示整段 | client 40/1 红（只红 B7） | B7 有牙 |
| C3-R1b | `/create` 报文条件写反 | contract 16/2 红 | C3 抓语义 |
| C3-R2 | `project` 换等价重构（IIFE） | contract 18/0 绿 | C3 不假红 |

## 3. 未做项与原因

- **B5 弹层外部点击关闭 / `projectDraft` 清理**：按任务指示不做（与优先级弹层保持一致，非回归），记为已知取舍。
- **`listProjects` 的逐字去重**（`" beta "` 与 `beta` 仍是两个条目）：本轮只保证「每个条目都能命中」。
  若要合并，连带 `groupByProject` 桶名与 `?project=` 也要一起改成「归一后归类」，
  会改变既有展示语义，留给下一轮并需要产品确认。
- **精确大小写改名**（`Ops` → `ops` 想故意改大小写）：被 B2 的宿主归一收敛到已有名，属 B2-2 的已知取舍。
- 版本号 / CHANGELOG / `.github` / commit / push / tag / 发布：按指示一律未动。

## 附：改动面清单（本轮相对 `project-picker-review.md` 时的工作树）

| 文件 | 改动 |
| --- | --- |
| `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/records.mjs` | `listProjects` 输出不 trim（+ 注释/`@param`）、`limit` 明确处理（B6） |
| `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/service.mjs` | `alignProject` / `snapshotForAlign` 两个局部助手 + `create`/`update` 落库前归一（B2-2）、`/list?project=` 记录值 trim（B3） |
| `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/tools.mjs` | 三个工具描述补「复用已有项目名」（B2-1），**无逻辑改动** |
| `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/client/index.js` | **未改**（B5 不做；截断提示本来就在，只是补用例） |
| `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/verify-records.mjs` | B3 两条 + B6 一条 + 修正一条旧断言（旧的 `' dev '` 归并断言描述的是被修掉的口径） |
| `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/verify-service.mjs` | B3 一条 + B2 一条 |
| `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-host.mjs` | B2-1 描述断言一条 |
| `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-contract.mjs` | C3：删两条源码正则，加表达式抽取/求值助手 + 行为用例一条 |
| `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-client.mjs` | B7 一条 |
| `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/client.js` / `.map` | 由 `build-client.mjs` 重新生成（`verify-all` 第一步会重建） |

未动：版本号、`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/CHANGELOG.md`、
`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/.github/`、用户真实数据与真实 profile（本轮只用内存假存储与 `/tmp` 副本）。
