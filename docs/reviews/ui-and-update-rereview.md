# 复核审查：上一轮修复（A1–A5 / B1–B3）是否真的修好、是否真的被测到

> 复核对象：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo` 工作区里上一轮修复后的代码
> （`lib/index.js`、`src/client/index.js` + 重建的 `lib/client.js`、`tools/smoke-host.mjs`、`tools/smoke-client.mjs`）。
> 上一轮审查报告：`docs/reviews/ui-and-update-review.md`（末尾「修复状态」节）。
>
> 方法：**不复用仓库自带结论**。所有 A 系列证据都在 `/tmp` 的假 profile / 假 pnpm / 临时 `DSH_HOME` 上，
> 用一个独立驱动（`/tmp/wt-rereview/driver.mjs`，直接 `import` 仓库的 `lib/index.js` 调 `apply()`）实跑完整序列；
> 牙齿验证在 `/tmp/wt-rereview/tree` 的整树副本里做（副本已恢复，sha256 与仓库逐字节一致）。
> Node `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`（v24.21.0），全程 `WORKTODO_NO_UPDATE_CHECK=1`。
> **本次复核没有改动仓库源码、没有 commit/push/tag，没有读写真实 `~/.dsh/profiles/*` 与真实待办数据**
> （见文末「真实环境核对」）。唯一的仓库写入是这份新报告文件。

**一句话结论：可以放行。** A1–A5 / B1–B3 八条修复逐条实跑复现通过；上一轮最关键的「修了仍全绿」缺口已补齐
（把 A1 原子写、A2 超时回滚、B3 `currentTarget` 三处分别回退，对应用例**确实变红**）；全量 `verify-all` 10/10，
无回归。遗留的是两条**已被本轮实测确认**的残留风险（多实例无锁 / SIGKILL）与 4 个不影响放行的诊断类小问题，
在**单机单实例**的真实使用下可接受（判断见 §6）。

| # | 修好了吗 | 有测试吗 | 证据（实跑 or 推断） |
| --- | --- | --- | --- |
| A1 | ✅ 修好 | ✅ 有牙齿（回退即红） | 实跑 4 组：`ulimit -f 1` 真写失败不截断原文件；pnpm 留下截断清单 → 逐字节还原且合法 JSON；非法/缺失 JSON → 零写盘零子进程；写不动时如实报 `rollback-failed` |
| A2 | ✅ 修好 | ✅ 有牙齿 | 实跑：`add` 挂起 6s / 超时 900ms → 929ms 收口、规格逐字节回滚、error+steps 明说「已回滚」、node_modules 未变 |
| A3 | ✅ 修好 | ✅ 有牙齿 | 实跑：deps `^0.2.0` + devDeps `~0.1.0` 被同时改写 → 回滚**逐字节等于原文件**；devDeps 是 `link:` → 整体跳过、零子进程零写盘 |
| A4 | ✅ 修好 | ✅ 有牙齿 | 实跑（**两个真实进程**）：第 1 次 2 子进程 + 落状态；第 2 次**零新增子进程、清单字节与 mtime 都不变、状态 idle** |
| A5 | ✅ 修好 | ✅ 有牙齿 | 实跑：`$DSH_HOME/profiles/{aaa,zzz}` 且不设 `WORKTODO_PROFILE_DIR` → `profile-not-found`、零子进程、两份清单逐字节不变；静态确认 `readdirSync` 与 profiles 扫描已不存在 |
| B1 | ✅ 修好 | ✅ 有牙齿 | 从**样式表原文**解析：行高 44 / 视觉盒 26 / 命中盒 40×40（y=[−5,35]）/ 下一行上沿 39 → 重叠 0、间隙 4（与测试打印一致，我按原 CSS 独立算式复核） |
| B2 | ✅ 修好 | ✅ 有牙齿 | 乐观态绑定「点击那一刻的数据对象」；用例断言数据回 pending 后不再显示已完成、再点发的是 `toggle`（方向正确） |
| B3 | ✅ 修好 | ✅ 有牙齿（**上一轮此处无牙**） | 回退成不看 `currentTarget` → 该用例变红；用例现在真的用「子元素 target + 行 currentTarget」去调处理器 |

---

## 0. 复核方法与产物

- 独立驱动：`/tmp/wt-rereview/driver.mjs`（假 cordis ctx + 假 pnpm + 真 `lib/index.js`），
  子场景 `a1-child` / `a1-writefail` / `a1-pnpm-truncate` / `a1-unfixable` / `a1-zerowrite` /
  `a2-timeout` / `a3-two-sections` / `a3-devlink` / `a4-persist`（两个真进程）/ `a5-noprofile` / `a6-readonly` / `multi-child`。
- 牙齿脚本：`/tmp/wt-rereview/teeth.mjs`（在 `/tmp/wt-rereview/tree` 整树副本里逐条回退，跑完恢复）。
- 基线全量日志：`/tmp/wt-rereview/verify-all-baseline.log`。
- 多实例 / SIGKILL 实验：`/tmp/wt-rereview/multi.sh`。

---

## 1. A1（严重）：不再手写 profile JSON；残留还原路径是原子写

### 1.1 静态确认「插件对 profile 只剩一处写」

`lib/index.js` 整个宿主半侧只有两个写盘点（`grep writeFileSync|writeFileAtomicSync|renameSync|unlinkSync`）：

| 位置 | 写什么 |
| --- | --- |
| `lib/index.js:605`（`persistAttempt`） | `$DSH_HOME/worktodo/update-state.json`（插件自己的节流状态，不是 profile） |
| `lib/index.js:663`（`journal.rollback()`） | profile `package.json` 的**逐字节还原**——唯一一处 |

第 3 步已改成 `pnpm add <pkg>@<精确版本> --save-exact --registry <源>`（`buildUpdateSteps`：`lib/index.js:694-717`，
`prepare()` 副作用已删除），规格改写交给 pnpm。**没有**再出现「插件自己 `JSON.parse` → `JSON.stringify` → 写回 profile」的路径。

### 1.2 实跑 ①：真实写失败（`ulimit -f 1`）不截断原文件

`/tmp` 假 profile（原清单 2010 字节，`dependencies.dsh-worktodo=^0.2.0`），假 pnpm 在 `add` 里把清单换成 80 字节的
**合法**新清单（模拟「pnpm 改了规格但升级没成功」），整条序列放进 `sh -c 'ulimit -f 1; exec node driver.mjs a1-child'`：

```
originalBytes=2010  diskBytes=80  validJSON=true  equalsPnpmContent=true  equalsOriginal=false
state=failed  reason=version-unchanged
error=…；回滚失败，请人工检查 …/a1-writefail/profile/package.json：EFBIG: file too large, write
steps=[pnpm-update(0), pnpm-add-exact(0), rollback-profile-spec{ok:false, note:回滚失败…}]
leftovers=[]          ← 同目录没有留下 .package.json.worktodo-tmp-*
```

结论：还原写失败时，**目标文件保持 pnpm 写下的那份完整内容**（80 字节、合法 JSON），
截断的临时文件被清理、**没有被 rename 上去**。旧实现在同一分片上会把 profile 截成 1024 字节的非法 JSON。

> 关于任务里「逐字节等于改动前」这句话：在「还原写盘**本身**失败」的分片上，物理上不可能把原字节写回去，
> 正确且可验证的不变量是「盘上永远是某一份**完整合法**的内容，绝不是半截」。逐字节还原到改动前的证据见 1.3。

### 1.3 实跑 ②：pnpm 留下截断清单 → 插件逐字节还原（这一条直接命中「逐字节等于改动前」）

同一 `ulimit -f 1` 环境，但原清单只有 105 字节（**小于** 1024 上限），假 pnpm 试图写 1874 字节 →
shell 只写进 1024 字节（**非法 JSON**）后 `exit 0`：

```
originalBytes=105  diskBytes=105  validJSON=true  byteEqualOriginal=true
state=failed  reason=manifest-corrupted
error=profile 清单曾不是合法 JSON，已逐字节还原原始清单
rollbackSteps=[{kind:rollback-profile-spec, ok:true, note:已回滚 profile 规格（逐字节还原 package.json）}]
leftovers=[]
```

即：**最终 profile 仍是合法 JSON，且逐字节等于改动前** —— 在真实写尺寸上限下成立。

### 1.4 实跑 ③：读不到 / JSON 非法 → 零写盘、零子进程

| 场景 | 结果 |
| --- | --- |
| `package.json` 含 `//` 注释（非法 JSON） | `ok:false reason:not-installed`；子进程 **0**；文件清单/字节/mtime 全未变 |
| `package.json` 不存在 | 同上；目录仍为空，未创建任何文件 |

（`readProfileManifest` 解析失败即 `ok=false`，`startUpdate` 在读规格阶段就收口，`runUpdateSequence` 根本进不去。）

### 1.5 补证：修复说明里那条「`fs.writeSync(fd,string)` 静默只写一半」是真的

独立探针（`/tmp/wt-rereview/probe-write.mjs`，写入 2003 字节）：

```
无 ulimit:  writeSync(string) returned=2003 不抛错; writeFileSync 不抛错
ulimit -f 1: writeSync(string) returned=1024 且**不抛错**  ← 静默半截写，实锤
             writeFileSync 抛 EFBIG，但目标文件已被截断到 1024 字节  ← 旧 A1 事故
```

所以「循环 `write(2)` + 进度校验」不是过度设计：只做「临时文件 + rename」而保留单次 `writeSync` 的实现
**仍然会把被截断的临时文件 rename 上去**——这一点已被下面的牙齿验证单独钉住（§4 第 2 行）。

### 1.6 反例 / 补充（不改放行结论）

- **无法自愈的窄缝（实测）**：如果 pnpm 自己留下非法清单，**同时**文件系统已经写不下原字节（磁盘满 / RLIMIT_FSIZE），
  插件只能如实报错而不能修复：
  ```
  diskBytes=57 validJSON=false state=failed reason=rollback-failed
  error=profile 清单曾不是合法 JSON，还原失败：回滚失败，请人工检查 <path>：EFBIG: file too large, write
  ```
  这是物理限制，关键是：**这个坏状态不是插件造成的**（插件自己不再写规格），且它**明确报出来**而不是静默声称成功。
  旧实现在这里会静默留一个 1024 字节的非法 JSON。
- **去掉 `rollback()` 的写后自检（`lib/index.js:665`）→ 测试全绿**（77/0）。这行是纯纵深防御，
  目前**零覆盖**：可接受（它不是承载安全性的那一环），但记录在案。
- 上一轮报告 A6 说「`link:` / 非 JSON / 只读 profile 都零子进程零写盘」——前两条本轮复测仍成立；
  只读 profile（0444）现在是 `failed/version-unchanged`（旧为 `pin-failed`）、**2 个子进程**（假 pnpm 为 no-op），
  **文件字节与 mode 均未变**。安全性保持（插件连写都不再尝试），只是 reason 文案变了。

---

## 2. A2 / A3：统一收尾与逐字节还原

### 2.1 A2 实跑：第 3 步挂起到超时 → 规格逐字节回滚

假 pnpm 在 `add` 里先把规格改成 `0.2.7`、再 `sleep 6`；`updateTimeoutMs=900`：

```
elapsedMs=929  state=failed  reason=timeout
error=升级超时（900ms）已终止；已回滚 profile 规格（逐字节还原 package.json）
steps=[pnpm-update(0), pnpm-add-exact(exitCode=null, timedOut=true), rollback-profile-spec{ok:true}]
spec=^0.2.0   byteEqualOriginal=true   installed=0.2.0
```

超时路径确实走到了回滚（这是旧实现 `if (result.timedOut) return` 绕过去的那条），且 error / steps 都写明。

**对「settleTransaction 是唯一出口」这句话的精度补充**：`lib/index.js:1066-1072` 在 `try` **之前**有一条早退
（`!journal.ok` 时 `finishRun('failed', not-installed)` 然后 `return`），所以它不是字面意义的唯一出口；
但那条路径是设计上「零写盘」的诊断出口，不违反 A2 的意图。

### 2.2 A3 实跑 a：双段位同名不同值 → 逐字节还原

`dependencies.dsh-worktodo=^0.2.0` + `devDependencies.dsh-worktodo=~0.1.0`，假 pnpm 把两段都改成 `0.2.7`：

```
state=failed reason=version-unchanged
byteEqualOriginal=true
deps=^0.2.0  devDeps=~0.1.0        ← 旧实现会把 ^0.2.0 写进 devDependencies
```

### 2.3 A3 实跑 b：任一段位是本地协议 → 整体跳过

`dependencies=^0.2.0` + `devDependencies=link:../../default-workspace/dsh-worktodo`：

```
ok=false reason=linked
error=这是本地安装（devDependencies：devDependencies.dsh-worktodo=link:…），请在仓库里用 git/pnpm 工作流更新…
subprocesses=0   treeUnchanged=true（含 mtime）
```

单测补证：`isLocalSpec` 对 `link:` / `file:` / `workspace:` 均为 true，对 `^0.2.0` / ` 1.2.3 ` 为 false。

### 2.4 补充（低危、无测试）

第 3 步是 `pnpm add <pkg>@<ver> --save-exact`，**没有** `--save-dev`。若某个 profile 只把 `dsh-worktodo`
放在 `devDependencies`（不是 `dependencies`），pnpm 默认会把它写到 `dependencies`，段位发生迁移。
本轮测试覆盖的是「`dependencies` 优先」与「双段位」两种，未覆盖「只有 devDependencies」。
实际 DSH profile 里该包是运行期依赖（在 `dependencies`），影响面低，记录备查。

---

## 3. A4 / A5：跨重启节流与 profile 反推

### 3.1 A4 实跑（两个**真实进程**，比仓内用例更接近「两次启动」）

no-op 假 pnpm，注入 `latest=9.9.9`，落盘版本停在 `0.2.0`（升级必然失败）：

```
第 1 次启动: state=failed reason=version-unchanged  子进程=2
状态文件    : {"attempted":"9.9.9","at":…,"result":"done"}
第 2 次启动: state=idle  新增子进程=0  清单字节相同=true  清单 mtime 相同=true
```

跨重启节流成立：第二次启动**零子进程、零写盘**。

**本轮新发现的小毛病（只影响可观测性）**：状态文件里的 `result` 写成了 `"done"`，而这次尝试其实是
`failed/version-unchanged`。原因：`startUpdate()` 在**序列刚启动时**就 resolve（返回 `{ok:true, running:true}`），
所以 `lib/index.js:1292-1299` 的 `.then(result => … : persistAttempt(…, 'done'))` 会把任何「过了守卫」的尝试
都记成 `done`。`readPersistedAttempt` 只读 `attempted`，因此**不影响节流逻辑**，但该字段不可信，
建议改成回写 `updateRun.reason` 或直接删掉。

另：`link:` / `profile-not-found` 场景会先落一次 `attempted` 再被守卫拒绝（`lib/index.js:1288-1291`），
即「什么都没做也写了节流状态文件」。那只是插件自己的状态文件（不是 profile），无害。

### 3.2 A5 实跑：反推不出 profile → 零写盘

`$DSH_HOME/profiles/{aaa:^0.2.0, zzz:link:…}`，**不设** `WORKTODO_PROFILE_DIR`，注入 `latest=9.9.9`：

```
ok=false reason=profile-not-found
error=反推不出本实例自己所在的 profile 目录（link: 装载或非标准布局），为避免改写别的 profile，已放弃升级且未做任何写操作
subprocesses=0   aaaUnchanged=true   zzzUnchanged=true
```

静态确认「没有再见 profiles 扫描 / desktop 兜底」：

- `lib/index.js` 里**没有** `readdirSync`，也没有任何 `$DSH_HOME/profiles/*` 扫描或 `desktop` 目录兜底；
  `findProfileDir()`（`lib/index.js:466-475`）只有两条精确信号：`WORKTODO_PROFILE_DIR` → 本模块自身 URL。
- 文件里剩下的 `desktop` 字样只在 `DESKTOP_CLI_RELATIVE`（定位官方 `dsh plugin` CLI 的路径），不是 profile 兜底。
- 纯函数单测：`profileDirFromModuleUrl('…/profiles/desktop/node_modules/dsh-worktodo/lib/index.js')` → 正确返回
  `…/profiles/desktop`；对仓库源码路径（`link:` 安装的形态）→ `null`。

---

## 4. 测试牙齿（上一轮最关键的结论）

在 `/tmp/wt-rereview/tree`（整树副本，先跑基线确认 77/0 与 51/0）里逐条把修复**回退成旧行为**，
跑对应套件（客户端改动会先 `build-client.mjs`），要求**非 0 退出且目标用例出现在 `✗` 列表**：

| # | 回退的修复 | 套件 | 结果 | 命中的用例 |
| --- | --- | --- | --- | --- |
| 1 | **A1**：`writeFileAtomicSync` 换回裸 `writeFileSync`（O_TRUNC 截断写） | smoke-host | exit 1，**75 通过 / 2 失败** | `A1（严重）：写盘失败（ulimit -f…）` + `A1：writeFileAtomicSync 失败不动原文件…` |
| 2 | **A1 部分回退**：保留临时文件 + rename，但写退化成单次 `writeSync`（= 只修了一半、静默半截写） | smoke-host | exit 1，**76 / 1** | `A1（严重）：写盘失败（ulimit -f…）` |
| 3 | A1 去掉 `rollback()` 的**写后自检**一行（循环写保留） | smoke-host | exit 0，**77 / 0** | 无 —— 该行**零覆盖**（纵深防御，见 §1.6） |
| 4 | **A2**：`finally` 不再调用 `settleTransaction()` | smoke-host | exit 1，**71 / 6** | `A2：第 3 步 pnpm add 挂起到超时…` 等 6 条 |
| 5 | A3：回滚退回「第一个命中的原值写进所有段位 + `JSON.stringify` 重写」 | smoke-host | exit 1，**73 / 4** | `A3：dependencies 与 devDependencies 同名不同值…` 等 4 条 |
| 6 | A4：`attempted` 只看内存（去掉跨重启持久化） | smoke-host | exit 1，**76 / 1** | `A4：跨重启节流…` |
| 7 | A5：恢复「扫 `$DSH_HOME/profiles/*` 取字典序第一个」兜底 | smoke-host | exit 1，**76 / 1** | `A5：反推不出本实例 profile…` |
| 8 | B1：`ROW_MIN_HEIGHT_PX` 44 → 33 | smoke-client | exit 1，**50 / 1** | `B1（护栏）：行高 ≥ 命中盒高度…` |
| 9 | B2：`optimisticActive = optimisticDone !== null`（永不回收） | smoke-client | exit 1，**50 / 1** | `B2：乐观完成态…必须回收…` |
| 10 | **B3**：`onAnimationEnd` 退回「不校验 `currentTarget`」 | smoke-client | exit 1，**50 / 1** | `勾选完成的动效…` |

**结论**：上一轮「把 A1 修成原子写 / A2 补超时回滚 / B3 改 `currentTarget`，三种修复跑完仍全绿」的缺口
**已补齐**——这三条现在**回退即红**。此外 A3/A4/A5/B1/B2 也各有牙齿。
两处需要如实标注的覆盖边界：**第 3 行（写后自检）零覆盖**；第 2 行说明牙齿确实咬在「静默半截写」这个具体 bug 上，
而不是只咬「有没有用临时文件」。

副本在全部实验后已恢复，`sha256(lib/index.js)` = `d06b4ac5…`、`sha256(src/client/index.js)` = `a49e7f93…`，
与真实仓库逐字节一致。

---

## 5. 回归（全量 + 宿主不变量 + 第一轮 UI）

- `node tools/verify-all.mjs`（含先 build）→ **10/10 个步骤通过**，exit 0。
  分项：数据模型 35、服务层 31、存储层 37、**宿主 77**、契约 18、**客户端 51**、CI workflow 11、
  发布面审计 30、收录提交门禁 17（全部 0 失败）。日志：`/tmp/wt-rereview/verify-all-baseline.log`。
- 与上一轮审查基线对照：宿主 67 → **77**（新增 10 条正好对应 A1×3 / A2×1 / A3×2 / A4×3 / A5×1），
  客户端 49 → **51**（B1 几何护栏 + B2）。测试文件数仍是 9 个。
- 抽查上一轮修过的宿主不变量，**都在且绿**（日志行号为准）：
  - 存储不静默降级：`二次挂载（同一 storageDomain 服务上再开一次）不降级、不丢数据、不重复 open`（L126）、
    `S1-2：storageDomain.open 永不 resolve → 默认 3 秒超时降级并告警`（L145）、
    `apply 两次（同一 storageDomain）不降级、不丢数据，domain/changed 真的接到 health`（L204）、
    `卸载后立刻重载：……不撞 already-open 降级到 file`（L205）；
  - `updateOrder` 只写一次：`S3-1/S4-1：reorder 只调一次 updateOrder…`（L91）、
    `S3-1：domain 后端 updateOrder 走官方 table.update…`（L140）、
    `1000 条 reorder 只发生「读 2 次 / 写 1 次 / rename 1 次」`（L138）；
  - 路由注册兜底与挂载超时：`S1-1：第 N 条路由注册抛错 → apply 不 reject…`（L208）、
    `S1-2：storageDomain.open 永不 resolve → 超时后 apply 仍然返回并完整挂载（8 路由 / 7 工具）`（L209）；
  - `shapes` / `projects`：L80-86、L193-197（宿主）、L271（契约）。
- 第一轮 UI（旗子 / 动效 / 勾选框）**未被这轮改动破坏**，用例全绿：
  `四旗 UI 只有一份…`、`行内旗子：无优先级行默认 ghost，hover/focus 才淡出…`、
  `行内旗子选「高」/「无」：发出 POST /worktodo/update，body 恰好是 {ref, priority}`、
  `勾选框：视觉 26px、可点区域 ≥40×40…`、`勾选完成的动效…`、
  `取消完成（completed → pending）绝不播庆祝动画`、`config.celebrate === false…`、
  `prefers-reduced-motion…`。
- B1 的实测输出与修复说明一致（我从 `src/client/index.js` 原文独立复核了算式）：
  ```
  [B1] 行高 44px / 视觉盒 26px / 命中盒 40×40px（y=[-5,35]） / 下一行命中盒上沿 39 / 重叠 0px / 间隙 4px
  ```
  补充稳健性：即便 `.wt-check` 按 content-box 计（26 + 2px 边框 = 28 外框），命中盒 y=[−5,37]、
  与下一行上沿 39 仍不重叠——结论不依赖 `box-sizing`。**仍未经过浏览器布局引擎**，建议发版前真机点一遍（沿用上一轮建议）。
- `lib/client.js` 由 `build-client.mjs` 重新构建后 sha256 未变（`5eb35283…`），即「src 与产物一致」。

---

## 6. 残留风险复核与判断

### 6.1 多实例无跨进程锁（A 实例回滚会不会盖掉 B 刚写下的成功规格）——**实测：会**

`/tmp/wt-rereview/multi.sh` 实验 1：两个**独立进程**同时升级同一个假 profile。
A（`mode=fail`）的 `add` 先写规格 `0.7.7` 再挂 3 秒；B（`mode=ok`）1 秒后启动，写规格 `0.2.7`；
A 在 ~3s 判定 `version-unchanged` 后回滚：

```
A: state=failed reason=version-unchanged  steps[… rollback-profile-spec{ok:true}]
B: state=done
最终盘上: 规格 = "dsh-worktodo":"^0.2.0"      ← 被 A 的回滚盖回去了
          node_modules = "0.2.7"              ← B 真的装上去了
```

即：**A 的失败回滚确实会盖掉 B 刚写下的成功规格**，留下「清单说旧版本、实际装的是新版本」的不一致，
而 B 仍然报 `done`。同一机制也会盖掉「用户在序列运行期间手工编辑 profile」的改动。

**判断（单机单实例）**：可接受。要触发它必须**同时**有两个宿主进程对**同一个 profile** 跑升级序列，
而正常 DSH 桌面使用是一台机器一个 profile 一个宿主进程；本轮修改前该窗口只会更大（双方都在手写 JSON）。
建议留作后续改进（成本很低）：回滚前除了比对「与运行前是否不同」，再比对「是否仍等于**本实例自己**那一步
写下的内容」，或加一个 profile 级锁文件。这不影响本次放行。

### 6.2 宿主被 SIGKILL 时无法回滚 ——**实测：确实无法回滚，但后果有界**

实验 2：宿主在 `pnpm add` 进行中被 `kill -9`（进程内任何 `finally` 都不会执行），孤儿子进程把规格改成 `0.7.7`：

```
盘上: 规格 = "dsh-worktodo":"0.7.7"    node_modules = "0.2.0"    节流状态文件 = (无)
```

**判断（单机单实例）**：可接受，理由有三：
1. 这是进程内方案的物理边界，旧实现同样做不到，而且旧实现被杀时可能留下**非法 JSON**（本轮已消除插件侧的这种可能）；
2. 残留的规格是**配置源 registry 的 `dist-tags.latest`**（不是插件猜的值），最坏结果是「升级推迟到下次 `pnpm install` 生效/失败」，
   而不是「写坏一份清单」；
3. A4 的持久化节流保证不会因为这次半途而废而在下次启动反复重试同一个版本。
   补充：`write-file-atomic@7`（DSH 内置 pnpm 的清单写实现，`dist/pnpm.mjs:47942` 调用、`45066+` 实现）是
   「临时文件 → fsync → chmod → rename」，所以 pnpm 写清单这一侧也是原子的；**但它是一次 `fs.write(fd,data,0,len,0)`
   而不循环校验进度**，所以在磁盘满 / `RLIMIT_FSIZE` 下理论上仍可能把截断的临时文件 rename 上去——
   那种情况下插件能检测（`manifest-corrupted`）并在空间够时逐字节还原，空间不够就只能如实报 `rollback-failed`（见 §1.6）。

---

## 7. 本轮新发现的小问题（都不阻塞放行）

1. **`update-state.json` 的 `result` 字段不可信**：过了守卫的尝试一律记 `"done"`，实测第一次是 `failed/version-unchanged`
   而状态文件写的是 `result:"done"`。只影响可观测性（`readPersistedAttempt` 只读 `attempted`）。
2. **profile `package.json` 非法 JSON 时的报错文案误导**：`startUpdate` 在读规格阶段就返回 `not-installed`，
   error 说「该 profile 的 package.json 里没有 dsh-worktodo 依赖」，而真实原因是「文件不是合法 JSON / 读不到」
   （零写盘的安全行为没问题，只是文案没说中原因）。
3. **`pnpm add` 未带 `--save-dev`**：只有 `devDependencies` 的 profile 会把该包迁移到 `dependencies`（无测试，影响面低）。
4. **`rollback()` 的写后自检零覆盖**（§4 第 3 行）：纵深防御，可接受。

---

## 8. 真实环境核对

- 本次复核**没有**修改仓库源码：`sha256` 与复核开始时一致 ——
  `lib/index.js d06b4ac5…`、`src/client/index.js a49e7f93…`、`lib/client.js 5eb35283…`、
  `tools/smoke-host.mjs 8af526d0…`、`tools/smoke-client.mjs a3e46c6c…`。
  `git status` 只列出复核开始时就存在的那 7 个已改文件 + 3 个未跟踪文档（+ 本报告）。
- **没有** commit / push / tag；未改版本号、未改 `CHANGELOG.md`、未发布。
- 真实 `~/.dsh/worktodo/`：跑完两轮全量 `verify-all` 后，5 个文件（`todos.json.bak-20261013-*` ×4 +
  `todos.json.migrated-20261013-220627`）**sha256 与复核开始时逐一相同**；没有出现 `update-state.json`
  （`tools/smoke-host.mjs:30` 的全局 `WORKTODO_UPDATE_STATE_PATH` 兜底生效）。
- 真实 `~/.dsh/profiles/desktop/package.json` **sha256 与 mtime 均未变**（`547b9626…`）。
- 所有 profile / pnpm / `DSH_HOME` 实验都在 `/tmp/wt-rereview/` 下；`/tmp` 整树副本在牙齿实验后已恢复并核对 sha256。

---

## 9. 放行建议

**可以放行。** 条件性建议（不阻塞）：

1. 发版前对 B1 做一次**真机像素命中**手测（几何结论目前只是从样式表原文算出来的，无布局引擎参与）。
2. 顺手修 §7.1 的 `result` 回写与 §7.2 的报错文案（各一行）。
3. 后续（下一个版本）考虑 §6.1 的回滚前「仍等于本实例自己写下的内容」校验或 profile 级锁；
   以及 §2.4 的 `--save-dev` 口径。
4. `docs/review-auto-update.md` §2.2/§4.3 的描述已被本轮实现取代（第 3 步不再是插件手写规格 + `install`），
   建议随发布一并更新。

---

## 10. 修复状态（小问题 1–3）

> 本轮只修 §7 的三条**非阻塞**小问题（都在自更新相关代码里），为下一次发版做准备。
> **不升版本、不改 `CHANGELOG.md`/`.github`、不 commit/push/tag、不发布。**
> 写域：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/index.js`、`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/*`（测试文件仍是 **9** 个）。
> Node `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`，全程 `WORKTODO_NO_UPDATE_CHECK=1`。
> 所有用例都在 `/tmp` 假 profile + 假 pnpm + 临时 `DSH_HOME` / `WORKTODO_UPDATE_STATE_PATH` 上跑；
> 反向验证在 `/tmp/wt-rev{1,2,3}` 的整树副本里做（仓库源码只保留修好的那一份）。
> 真实 `~/.dsh/worktodo/` 仍是原来那 5 个文件（没有出现 `update-state.json`），
> 真实 `~/.dsh/profiles/desktop/package.json` 的 mtime 未变。

### 10.1 小问题 1：`update-state.json` 的 `result` 恒为 `"done"` → 按真实结论回写

- **根因**：`startUpdate()` 在升级序列**刚起步**时就 resolve（`{ok:true, running:true}`），
  `maybeAutoUpdate` 的 `.then` 于是把任何「过了守卫」的尝试都记成 `result:"done"`
  —— 实测第一次其实是 `failed/version-unchanged`。
- **修法**（`lib/index.js`）：
  - `startUpdate({ attempt })` 新增可选 `attempt = {version, at}`；内部
    `writeAttemptOutcome(result, reason)` 在**每个出口最多写一次**：
    守卫拒绝（`profile-not-found` / `profile-manifest-*` / `not-installed` / `linked`）→ `failed + reason`。
  - 序列出口经 `runUpdateSequence({ onSettled })`：在 `finally` 里
    `settleTransaction()`（超时、清单被写坏、回滚失败都会在这里改状态）**之后**回写
    `done`，或 `failed + reason`；`internal` 兜底在 `.catch` 里写。
  - 持久化载荷：`{attempted, at（尝试开始时间）, finishedAt, result: 'done'|'failed', reason?}`。
    `A4` 的节流只读 `attempted`，所以跨重启节流语义不变；手动升级（HTTP 路由）不传 `attempt`，仍不写状态文件。
- **测试**（`tools/smoke-host.mjs`，2 条）：
  - `小问题 1：自动升级尝试真的失败时，状态文件如实写 failed + reason（旧实现恒 done）`：
    注入 `latest=9.9.9` + no-op 假 pnpm → 运行状态 `failed/version-unchanged`；
    读状态文件断言 `result === 'failed'`、`reason === 'version-unchanged'`、`attempted === '9.9.9'`、
    `at` / `finishedAt` 都是数字（尝试时间）。
  - `小问题 1：自动升级真的成功时，状态文件写 done（且不再带 reason）`：
    假 pnpm 在 `update` 那一步就真的换掉落盘版本 → `done`；状态文件 `result === 'done'`、无 `reason`、`attempted` 保留。
- **反向验证**：副本 `/tmp/wt-rev1` 里把回写改回「恒 `result:'done'`」（旧行为）→
  **83 通过 / 1 失败**，命中的正是失败那条用例。

### 10.2 小问题 2：profile JSON 非法时报成「没有依赖」 → 分开说、说准

- **根因**：`startUpdate` 用 `readProfileSpecEntries()`（解析失败返回 `[]`），坏清单于是落到
  「该 profile 的 package.json 里没有 dsh-worktodo 依赖」；真实原因是「文件不是合法 JSON / 读不到」。
- **修法**（`lib/index.js`）：
  - `readProfileManifest()` 增加 `kind: 'unreadable'|'invalid-json'|null`；
    抽出纯函数 `specEntriesFromPkg(pkg)`，`startUpdate` 直接消费已经读到的清单（少一次读盘、收窄 TOCTOU）。
  - 坏清单的 reason 分成 `profile-manifest-invalid` / `profile-manifest-unreadable`，文案：
    `profile 清单不是合法 JSON（<path>），已跳过安装与写盘；请人工检查该文件` 与
    `读不到 profile 清单（<path>），已跳过安装与写盘；请人工检查该文件`；
    **不再**与 `not-installed`（真的没有依赖）混用。行为保持 §1.4 的硬前提：零子进程、零写盘。
  - `runUpdateSequence` 里 `journal.ok === false` 的兜底出口改成同一套口径（收窄竞态窗口）。
- **测试**（2 条）：
  - `小问题 2：profile 清单不是合法 JSON → 文案说准原因（不是「没有依赖」），零子进程零写盘`：
    带 `//` 注释的清单 → `reason === 'profile-manifest-invalid'`；文案含「不是合法 JSON」+ 具体路径 +
    「已跳过安装与写盘」，且**不含**「没有 dsh-worktodo 依赖」；`invokeCount === 0`、
    清单逐字节不变、mtime 不变。
  - `小问题 2：profile 清单读不到 → 说的是「读不到」，同样零子进程零写盘`：
    目录在但没有 `package.json` → `reason === 'profile-manifest-unreadable'`、文案含「读不到 profile 清单」、
    不含「没有」；零子进程、目录里不许多出任何文件。
- **反向验证**：副本 `/tmp/wt-rev2` 里把该分支短路（退回旧的「落到 `not-installed`」）→
  **82 通过 / 2 失败**，上面两条都变红。

### 10.3 小问题 3：`pnpm add` 未带 `--save-dev` → 按原段位写回

- **根因**：序列第 3 步恒定 `pnpm add <pkg>@<精确版本> --save-exact`；若规格原本在
  `devDependencies`，pnpm 会把它迁到 `dependencies`（段位迁移）。
- **修法**（`lib/index.js`）：
  - 新增纯函数 `shouldSaveDev(entries)`：只有 `devDependencies` 命中 → `true`；
    只有 `dependencies` → `false`；**两处都有 → 优先 `dependencies`（不加 `--save-dev`）**。
    取舍理由：运行期依赖优先，且本插件在真实 DSH profile 里就在 `dependencies`；这一口径记录在本报告里。
  - `buildUpdateSteps({…, saveDev})` 在 `add` 的 `--save-exact` **之后**按需插入 `--save-dev`（仍在 `--registry` 之前）；
    `display` 同步带出「原在 devDependencies，按原段位带 --save-dev」。
  - `startUpdate` 用 `shouldSaveDev(entries)` 计算并传入序列。
- **测试**（3 条）：
  - `小问题 3：pnpm add 按原段位决定 --save-dev（纯函数 + 命令构造）`：
    `saveDev:true` → argv 含 `--save-dev` 且形状精确（`add dsh-worktodo@1.2.3 --save-exact --save-dev --registry …`）；
    缺省（= `dependencies`）→ 不含；`shouldSaveDev` 覆盖 dev-only / deps-only / 两处都有 / 空四种输入。
  - `小问题 3（端到端）：只有 devDependencies 的 profile → pnpm add 真带 --save-dev`：
    从假 pnpm 的 capture 断言真正发出的 `add` 那条**含** `--save-dev`（`update` 那条不含）。
  - `小问题 3（端到端）：只有 dependencies 的 profile → pnpm add 不带 --save-dev`：`add` 那条**不含** `--save-dev`。
- **反向验证**：副本 `/tmp/wt-rev3` 里去掉 `--save-dev` 的判断（永不插入，旧行为）→
  **82 通过 / 2 失败**，纯函数用例与 dev-only 端到端用例都变红。

### 10.4 全量与状态

- `node tools/verify-all.mjs` → **10/10 个步骤通过（含 build）**，exit 0。
  分项：数据模型 35、服务层 31、存储层 37、**宿主 84**（77 → 84，新增 7 条：问题 1×2 / 问题 2×2 / 问题 3×3）、
  契约 18、客户端 51、CI workflow 11、发布面审计 30、收录提交门禁 17。
  日志：`/tmp/wt-smallfix-verify-all.log`。
- 测试文件数仍是 **9**；`lib/client.js` 经 `build-client.mjs` 重建后 sha256 未变（`5eb35283…`），
  即 `src` 与产物一致（本轮没有改客户端半侧）。
- 反向验证副本 `/tmp/wt-rev{1,2,3}`：分别回退问题 1 / 2 / 3 的修复，**只有目标用例变红**，无连带红灯。
- **未做项 / 剩余不确定**：
  1. §7.4 `rollback()` 的写后自检仍是**零覆盖**（纵深防御，本轮未动）。
  2. §6.1 多实例回滚互盖、§6.2 SIGKILL 无法回滚：本轮**未修**，仍是残留风险（判断见 §6）。
  3. 持久化状态文件的 `result` 只在**自动升级**路径写；手动升级仍不写状态文件（与旧行为一致，本轮有意保留）。
  4. `docs/review-auto-update.md` §2.2/§4.3 的旧描述本轮**未更新**（不随本轮交付）。
  5. 仍未经过浏览器布局引擎的真机像素命中（§5 的 B1 建议），与本轮改动无关。
- 本轮**不升版本、不改 `CHANGELOG.md`/`.github`、不 commit/push/tag、不发布**。

---

## 11. 修复状态（安装态 vs 运行态提示）

> 本轮只修「后台已经装好新版，面板却还在喊『有新版本』」这一条体验闭环：
> 把**安装态**（`node_modules` 落盘版本）与**运行态**（本进程加载的版本）分开报给面板，
> 面板优先提示「已更新，重启 DSH 生效」，不再把「装好了」误报成「还没装」。
> **不升版本、不改 `CHANGELOG.md`/`.github`、不 commit/push/tag、不发布。**
> 写域：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/index.js`、
> `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/client/index.js`、
> `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/*`
> （测试套件仍是 **9** 个；`lib/client.js` 是 `build-client.mjs` 的产物，随 `verify-all` 重建）。
> Node `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`，全程 `WORKTODO_NO_UPDATE_CHECK=1`。
> 所有用例都在 `/tmp` 假 profile + 临时 `DSH_HOME` / `WORKTODO_UPDATE_STATE_PATH` 上跑，未触碰真实 `~/.dsh/profiles`。

### 11.1 根因

- 宿主 `updatePayload()` 把两个语义混进了一次比较：`current = installedVersion ?? PLUGIN_VERSION`，
  于是 `hasUpdate` 实际变成「latest vs **落盘版本**」。而内存里的 `installedVersion` 只在
  **本进程成功跑完升级序列**时才被赋值，初始化是 `null` —— 因此「另一个进程装的」「上次运行装好但没重启」
  「用户手动 `pnpm add` 的」这些真实的「已落盘 > 运行中」状态，`/list` 根本看不见。
- 客户端只有 `hasUpdate` 分支（以及 `run.state === 'done'` 的瞬时分支），没有稳态的 `restartRequired` 分支：
  只要宿主报了 `hasUpdate`，页脚就渲染可点的「有新版本」。
- 徽标无论有没有动作都渲染成 `<button>`，状态文本会给出「点了没反应」的错误暗示。

### 11.2 修法

宿主（`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/index.js`）：

- `/list` 的 `update` 载荷新增/明确四个字段（老字段 `current` / `latest` / `installed` / `page` / `run` 全部保留）：
  - `installedVersion`：**每次请求**读 `<profile>/node_modules/dsh-worktodo/package.json` 的 `version`；
    读不到（没 profile / 还没装 / 坏 JSON / 没 version 字段）一律 `null`。
  - `runningVersion`：本进程的 `PLUGIN_VERSION`。
  - `restartRequired`：`installedVersion` 与 `runningVersion` 都存在且 `compareVersion(installed, running) > 0`。
  - `hasUpdate`：**语义固定回**「registry latest 比 `runningVersion` 新」，不再拿落盘版本比较；
    装好待重启时它仍为 `true`（老面板兼容），新面板必须先看 `restartRequired`。
- 抽出同步的 `resolveOwnProfileDir()`（`WORKTODO_PROFILE_DIR` 优先，其次模块自身路径反推），
  `findProfileDir()` 复用同一口径；**不扫 `$DSH_HOME/profiles/*`、不猜别的 profile**。
- `readInstalledVersion()` 增加 `profileDir` 空值守卫，异常继续吞掉：读盘失败只让字段变 `null`，
  `/list` 照常 200 返回。没有新增网络请求、没有新增定时器。

客户端（`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/client/index.js`）：

- `updateBadgeState()` 优先级：`running` → **`restartRequired`** → `done`（落盘版本读不到时的兜底）
  → `failed` → `hasUpdate` → `null`。`restartRequired` 时文案用已有的
  `updatedRestart`（中「已更新到 {version}，重启 DSH 生效」/ 英「Updated to {version} — restart DSH to apply」），
  版本号只取 `installedVersion ?? installed`，缺版本号时回落到 `updateRestartHint`，不拿 `latest` 冒充落盘版本。
- 配色走主题变量 `UPDATE_TONE_STYLE.ok`（醒目但不用红色 error）；不新增常驻定时器，
  仍复用列表的 30s 轮询 / focus 刷新。
- 只有 `action` 非空才渲染 `<button>`；正在进行 / 已装好待重启 / linked 等纯状态渲染
  `<span role="status" className="wt-chip wt-update is-state">`，并带 `aria-label`（按钮同样带）。
  文案仍走 `t()`、无 `innerHTML`；新增 `.wt-update.is-state` 去掉可点光标与 hover 下划线。

### 11.3 测试（都加进现有 9 个套件）

- 宿主（`tools/smoke-host.mjs`，新增 4 条，84 → **88**）：
  1. `落盘版本比运行版本新 → restartRequired:true，hasUpdate 仍按运行版本`：
     假 profile 落盘 `pkgVersion+1`，注入同版本 latest；断言 `installedVersion` / `runningVersion` /
     `restartRequired` / `hasUpdate:true`，以及老字段 `installed` / `current` 不回归。
  2. `落盘版本不高于运行版本 → restartRequired:false`：旧版本（0.0.1）与同版本各断言一次。
  3. `落盘清单读不到/坏 JSON → installedVersion:null、restartRequired:false，/list 照常返回`：
     覆盖「还没装」「坏 JSON」「没有 version 字段」「profile 目录不存在」四种，每次都断言 `/list` 200、
     `ok:true`、`todos` 仍是数组。
  4. `hasUpdate 语义不变：latest 比 runningVersion 新，而不是比落盘版本新`：
     「latest 落在 running 与 installed 之间 → false」和「installed 比 latest 还新、latest 比 running 新 → true」
     两个方向，恰好能区分两种比较口径。
- 既有的「第 1 步 pnpm update 真的换落盘版本」用例同步改口径：升级落盘后断言
  `hasUpdate:true` + `installedVersion/installed === 0.2.7` + `restartRequired:true`（旧断言是 hasUpdate:false）。
- 客户端（`tools/smoke-client.mjs`，51 → **52**）：
  - 纯函数覆盖三种状态：只有 `hasUpdate` → 可点「有新版本」；`restartRequired`（即使 `hasUpdate` 同时为 true）
    → 只报「已更新到 v0.2.7，重启 DSH 生效」、`action:null`、`tone:'ok'`、文案不含「有新版本 / 立即更新」；
    两者都 false → `null`。另测 `installed` 回落与缺版本号的兜底文案。
  - 渲染覆盖：`restartRequired` 载荷下全页只有 1 个 `wt-update` 节点、必须是 `<span>`、`role=status`、
    有 `aria-label`、没有 `onClick`、全页扫不到 `button.wt-update`；对照组把 `restartRequired` 改 false 后
    立刻回到可点按钮 + 「有新版本」。进行中原先断言「禁用按钮」改为「只读 span」，因为本轮起
    纯状态不再渲染按钮。

### 11.4 反向验证

- 副本 `/tmp/wt-rev-state-client`（客户端把 `restartRequired` 分支恒置 false）→
  `smoke-client` **50 通过 / 2 失败**：命中的正是「纯函数装好待重启」与「页脚 restartRequired 渲染」两条。
- 副本 `/tmp/wt-rev-state-host`（宿主把 `hasUpdate` 改成 `compareVersion(latest, installedVersionOnDisk ?? runningVersion)`，
  即旧缺陷口径）→ `smoke-host` **85 通过 / 3 失败**：命中核心升级用例、新 restartRequired 用例、
  新 hasUpdate 语义用例，其余用例无连带红灯。
- 两个副本都是 `/tmp` 整树拷贝，仓库源码只保留修好的版本；所有假 profile 均在 `/tmp`。

### 11.5 全量与状态

- `node tools/verify-all.mjs` → **10/10 个步骤通过（含 build）**，exit 0。
  分项：数据模型 35、服务层 31、存储层 37、**宿主 88**、契约 18、**客户端 52**、CI workflow 11、
  发布面审计 30、收录提交门禁 17。日志：`/tmp/wt-install-state-verify-all-final.log`。
- 测试套件数仍是 **9**；`lib/client.js` 由 `build-client.mjs` 重建，sha256 `a5484890…`（`src` 与产物一致）。
- 真实 `~/.dsh/profiles/*` 与真实待办数据未被读写；本轮**不升版本、不改 `CHANGELOG.md`/`.github`、
  不 commit/push/tag、不发布**。

### 11.6 未做项 / 剩余不确定

1. `installedVersion` 改为**每次 `/list` 同步读一次**小文件（30s 轮询 + focus 刷新）。没有做 mtime 缓存或异步读；
   这个文件通常只有几百字节且在本机盘上，本轮未测出列表延迟回归，但也没有真机大 profile 的基准数据。
2. `updateRunSummary.installed` / `updateStatus().installed` 仍是本轮升级序列写下的**内存结论**
   （初始化 `null`，成功升级后填），不是每次读盘；面板要判断「已装好待重启」必须看新增的
   `update.installedVersion` / `restartRequired`。旧字段保留原语义，未混用。
3. `maybeAutoUpdate` 的触发版本判断仍用内存 `installedVersion ?? PLUGIN_VERSION`：若用户在 DSH 运行期间
   从外部装好了新版但本进程没重启，自动升级可能对同一个 latest 再尝试一次（跨重启节流仍在，只多一次）。
   本轮未改这条触发路径，避免扩大写盘面。
4. `failed` 与 `restartRequired` 同时成立时，客户端按优先级显示「重启生效」（盘上确实已装好）；
   若失败发生在**已装好之后的重试**，用户会看不到那次失败原因。这是有意的取舍，未单独做「失败详情」入口。
5. 仍未做浏览器布局引擎下的像素检查；`role=status` + `aria-label` 只经 React 替身树断言，未跑读屏实测。
