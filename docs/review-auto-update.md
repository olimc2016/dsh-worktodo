# 自更新修复：默认自动更新 + 真正会换版本的升级路径

> 本轮针对 **0.2.5 自更新的两个真问题**（用户诉求 + 真机实测证实的 no-op）。
> 本文是 0.2.6 之前的修复记录；`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/docs/reviews/self-update.md`
> 里「`autoUpdate` 默认 false」那一行**已被本文取代**（那是 0.2.5 的设计结论，本轮改成默认 true）。
>
> 本报告路径一律写 `~/...` / `$DSH_HOME` / 应用包内相对路径，不含个人路径与用户名。
> 全部实验都在临时目录（`/tmp` 下的临时目录、`os.tmpdir()`）与**假 profile / 假 pnpm / 假 CLI** 上完成，
> 没有触碰真实 profile 或用户数据；没有真联网、没有真安装。
> 本轮**不升版本、不改 CHANGELOG、不提交、不打 tag、不发布**。

---

## 1. 结论摘要

| 项 | 结果 |
| --- | --- |
| 问题 1：默认不自动更新（「一个版本用到老」） | ✅ `autoUpdate` 默认 **true**；只有**字面量** `false` 才完全关（行为与旧版一致） |
| 问题 2：`plugin add <pkg>@<ver>` 退出码 0 却什么都没换（no-op） | ✅ 改成**多步升级序列**，每一步之后都读 `node_modules/dsh-worktodo/package.json` 的 `version` 校验 |
| 「命令成功但版本没变」 | ✅ 最终必须 `state:'failed'`、`reason:'version-unchanged'`，error 明确写「落盘版本未变（可能是镜像缓存/规格锁定）」；**绝不允许 `done`** |
| 用户实测有效的那条命令 | ✅ `pnpm update dsh-worktodo --registry <官方源>` 成为 pnpm 路径的第 1 步 |
| 旧规格把升级钉死 | ✅ 版本没变就把 profile 规格改写成 registry 上的**精确版本**（`dist-tags.latest`）再 `pnpm install` |
| 自动更新的安全 | ✅ 后台异步（不阻塞任何请求）、每个 latest 只尝试一次、失败只记日志、`link:` **零子进程** |
| 状态可观测 | ✅ `GET /worktodo/update` 报 `autoUpdate: true`（默认）+ 新增 `steps[]`（每步 kind/命令/退出码/跳过原因） |
| 保留项 | ✅ CLI 优先/降级 pnpm、超时（默认 180s）、并发护栏、状态机、日志尾部截断、成功后按落盘版本重算 `hasUpdate`/`restartRequired` |
| 全量测试 | ✅ `node tools/verify-all.mjs` → **10/10 步骤通过**（含构建）；`smoke-host.mjs` 从 61 通过 → **67 通过 / 0 失败** |

---

## 2. 改动点

### 2.1 默认值：`autoUpdate` 默认 `true`

`lib/index.js` 的 `normalizeUpdateConfig()`（本轮导出，供单测直接钉住）：

```js
const autoUpdate = config?.autoUpdate !== false; // 默认开；只有字面量 false 才关
```

- `{}` / `undefined` / `autoUpdate: 'yes'` / `'false'` / `0` → **true**（配置里一个手滑的 falsy 值不该静默关掉用户要的自动更新）；
- `autoUpdate: false` → **false**，此时**一次子进程都不起**（与旧版行为完全一致）；
- registry 默认 `https://registry.npmjs.org/`、超时默认 `180000ms` 的回落逻辑不变。

面板/接口可观测性：`GET /worktodo/update` 的 `autoUpdate` 字段现在默认是 `true`，用户能看出「自动更新已开启」。

### 2.2 升级路径：多步序列 + 每步按**落盘版本**校验（核心）

`buildUpdateSteps()`（纯函数，导出供单测）按以下顺序产出步骤；`runUpdateSequence()` 逐条执行，
**每一步之后都读 `<profile>/node_modules/dsh-worktodo/package.json` 的 `version`**，只有版本真的变了才收 `done`：

| 步 | 何时加 | 命令（`--registry` 始终显式带，默认官方源，可 config 覆盖） |
| --- | --- | --- |
| 1 | 拿得到官方 CLI | `dsh plugin --profile <name> add dsh-worktodo@latest --registry <源>`（保留既有「CLI 优先」） |
| 2 | 总是 | `pnpm update dsh-worktodo --registry <源>`（用户真机实测有效的一条） |
| 3 | 总是（需要有精确目标版本） | 先把 profile `package.json` 里的规格改写成 `<源>` 上查到的 `dist-tags.latest` 精确版本，再 `pnpm install --registry <源>` |

判定与收口：

- `installedVersionChanged(before, after)`：`after` 读不到 → 不算成功；原来没装、现在有了 → 成功；
  否则用语义化版本比较，**必须不相等**才算升级。1→2→3 每步之后都跑这个判定。
- 版本变了 → 立刻 `state:'done'`，`to`/`installed` 用**落盘版本**（不是 registry 的 latest、更不是退出码），
  并 `refreshUpdate({force:true})` 重算 `hasUpdate` / `restartRequired`（现有逻辑保留）。
- 走到最后版本仍未变 → `state:'failed'`：
  - 没有任何命令失败：`reason:'version-unchanged'`，
    error = `命令执行成功但 dsh-worktodo 落盘版本未变（可能是镜像缓存/规格锁定）：已依次尝试 pnpm-update → pin-exact-then-install，当前落盘版本仍是 0.2.0…`；
  - 有命令非 0 退出：`reason:'exit-nonzero'`，error = `安装命令退出码 3；且 dsh-worktodo 落盘版本未变（可能是镜像缓存/规格锁定）…`（退出码与「版本没变」两个事实都写清楚）。
- **额外安全阀（本轮加的）**：如果第 3 步确实改写过规格、最后仍然失败，就把规格**回滚**成原值
  （error 里说明「已把 profile 规格回滚为 `^0.2.0`，避免留下拉不到的精确版本」）。
  否则镜像里没有那个精确版本时，用户**下一次** `dsh` 启动的安装会直接失败——比不升级更糟。
- 拿不到精确目标版本（registry 查询失败且没有缓存）时，第 3 步**跳过**并记 `skipped:'unknown-target'`，
  失败原因里说明「无法把 profile 规格改写成精确版本」，绝不写进 `undefined`。

保留语义：超时是**整条序列共享的 deadline**（默认 180s；不是每步各 180s，否则三步最坏 540s）；
并发护栏（已在跑就幂等返回 `running`，子进程只启动一次）；状态机 `idle/running/done/failed`
与日志尾部截断（40 行 / 4000 字符）不变。

### 2.3 自动更新的触发与节流

```js
const shouldAutoUpdate = ({ enabled, latest, current, runState, attempted }) =>
  enabled === true && latest && compareVersion(latest, current ?? '0.0.0') > 0
  && runState !== 'running' && attempted !== latest;
```

- 触发点：`refreshUpdate()` 结束时（启动查一次、TTL 过期后 `/list` 刷新一次）。
- 节流：内存里 `autoAttempted` 记「已经试过的 latest」——同一个新版**只自动试一次**（失败也不反复打扰）；
  出现**更新**的 latest 时再允许试一次。`maybeAutoUpdate()` 用 `void startUpdate()`，**绝不阻塞任何请求**。
- 失败只 `logger.warn`，不弹任何东西。
- `link:` 安装由 `startUpdate()` 既有的 linked 分支拦住：设 `state:'idle'`、`reason:'linked'`，
  **一个子进程都不起**（自动路径同样适用）。

### 2.4 测试缝（新增一个，其余保留）

- 新增 `WORKTODO_UPDATE_LATEST`：注入「已知最新版」。全量测试按约定带 `WORKTODO_NO_UPDATE_CHECK=1`
  （单元测试不联网），但「第 3 步要写死精确版本」「自动更新要真的被触发」都需要一个 latest；
  该缝**只在显式设置时生效**（非法值忽略），不设就完全走生产路径，不制造第二种行为。
- 保留：`WORKTODO_PROFILE_DIR`、`WORKTODO_PNPM_PATH`、`WORKTODO_UPDATE_CLI`、`WORKTODO_BODY_TIMEOUT_MS`。

---

## 3. 测试与反向验证

改动文件只有两个：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/index.js`、
`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-host.mjs`（用例加进现有文件，
测试文件仍是 9 个 suite）。**没有碰** `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/client/index.js`。

假 pnpm 现在能演三种行为：什么都不做、**真的**改掉 `node_modules` 版本（可按子命令区分）、
以及把**每次调用当时的** profile `package.json` 抄下来（用来断言「install 之前规格确实已经改写」）。

### 3.1 用例清单（全部用假 pnpm / 假 CLI，不联网、不真装）

| 用例 | 钉住的行为 |
| --- | --- |
| 自升级（核心）：假 pnpm 什么都不做 → … | 必须走到第 3 步（`update` → 改写规格为 0.2.7 → `install`），`install` 时规格已是精确版本；仍不变则 `failed` + error 提「版本未变」「镜像缓存」+ 已回滚；**不得 `done`**；两条命令都带 `--registry <官方源>` |
| 自升级（核心）：第 1 步 `pnpm update` 真的换掉落盘版本 | `done` + `to/installed = 0.2.7` + 只启动 1 个子进程 + `/list` 里 `hasUpdate` 重算为 **false**、`restartRequired` 为 true |
| 自升级（核心）：第 1 步 no-op、第 3 步 install 真的换版本 | 从 failed 边缘救回 `done`；`install` 时规格已被改写成精确版本 |
| 自动更新（默认开）：同一个新版本只自动尝试一次 | 不传配置即自动升级；一次尝试 = 2 条命令；之后连续两次 tick（`/list`）**不再启动任何子进程**；状态不被改回 running |
| 自动更新：显式 `autoUpdate:false` | 即使注入了新版本也**零子进程**，`state:'idle'`，状态报 `autoUpdate:false` |
| 自动更新：`link:` 安装（默认开启） | **零子进程**，`reason:'linked'`，error 指向 git/pnpm 工作流 |
| 配置默认值 / `normalizeUpdateConfig` | 默认 true；`false` 才关；`'yes'`/`'false'`/`0` 回落 true；官方源、180s、非法值回落；`GET /update` 报 `autoUpdate` 与 `steps[]` |
| `buildUpdateSteps` 顺序 | CLI 可用时 `cli-add-latest → pnpm-update → pin-exact-then-install`；只有 pnpm 时两步；每步显式 `--registry`；无目标版本时没有改写步骤 |
| 既有用例（link / 并发 / 非 0 退出 / 超时 / 不阻塞 / 空体 / CLI argv / 模块路径反推 / ref 改待办） | 全部保留并按新语义收紧（例如 CLI 用例的假 CLI 现在**真的**换掉版本，否则修复后的代码会正确地继续走 pnpm 兜底；非 0 退出用例额外断言 error 也提「版本未变」） |

### 3.2 反向验证（回退修复 → 测试必须变红）

用 `/tmp` 里的脚本逐条把修复点回退成旧行为，跑 `node tools/smoke-host.mjs`，记录变红的用例，然后恢复原文件
（脚本确认「恢复原文件：OK」；恢复后 grep 无残留标记）：

| 回退 | 结果 | 变红的用例 |
| --- | --- | --- |
| R1 `autoUpdate` 默认改回 `=== true` | 64 通过 / **3 失败** | 配置默认值用例、自动更新「只试一次」用例、自动更新 link: 用例 |
| R2a 每步校验退化成「读得到版本就算成功」 | 64 通过 / **3 失败** | 三个核心升级用例（no-op 会错误地报 `done`） |
| R2b 砍掉第 3 步（只跑 `pnpm update`） | 64 通过 / **3 失败** | 三个核心升级用例（no-op 与「install 才生效」都失败） |
| R3 去掉失败后的规格回滚 | 66 通过 / **1 失败** | no-op 核心用例（回滚与 error 文案断言） |
| R4 去掉 `attempted !== latest` 节流 | 65 通过 / **2 失败** | `shouldAutoUpdate` 纯函数用例、自动更新「只试一次」用例（tick 会不断起新子进程） |

R1/R2a/R2b/R4 正是任务要求反向验证的第 1、2、4 条；R3 是本轮额外安全阀的验证。
（R2a 第一次跑时额外把并发用例也带红过一次，是当时 400ms 超时窗口下的时序抖动；
已把该用例放宽为 sleep 3s / 超时 1500ms，之后连跑 3 次与最终反向验证都不再抖动。）

### 3.3 全量

```
$ export WORKTODO_NO_UPDATE_CHECK=1
$ node ~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/verify-all.mjs
…
  ✓ 客户端 bundle 构建  (build-client.mjs)
  ✓ 数据模型 … ✓ 服务层 … ✓ 存储层 … ✓ 宿主接线与工具 … ✓ 客户端↔宿主契约 …
  ✓ 客户端 bundle … ✓ CI workflow 契约 … ✓ 发布面审计 … ✓ 收录提交门禁
10/10 个步骤通过（含构建）
```

`smoke-host.mjs`：**67 通过 / 0 失败**（修复前 61 通过）。

---

## 4. 未做 / 不确定

1. **没有真机端到端验证**：所有「命令执行 → 落盘版本」都是假 pnpm / 假 CLI 演的，没有在真实
   profile 上真跑 `pnpm update` / `pnpm install`。真机上「官方源可达 + 镜像缓存」这类环境差异仍需一次实跑确认。
   本轮按要求不碰真实 profile。
2. **CLI 的 `plugin` 子命令是否有 `update`**：未知，所以 CLI 路径仍只用既有的 `add …@latest`；
   实测它在这台机器上是 no-op，因此 CLI 只是「先试一条」，真正的补救是后面的 pnpm 序列。
   如果官方 CLI 的 `plugin add` 会**重写** profile 规格（例如又写回 `^x`），第 3 步的精确改写可能被它覆盖——
   当前顺序是「CLI → pnpm update → 改写+install」，最后一步在 CLI 之后，所以不会被覆盖。
3. **改写 profile 规格是真实的磁盘写入**：成功时保留精确版本（这是「换得动」的代价），失败时已回滚。
   没有做「写前备份 + 内容级 diff」；如果 `package.json` 同时被别的进程改写，存在覆盖风险（极小）。
4. **超时语义变了**：从「每条命令 180s」变成「整条序列共享 180s」。好处是不会让面板长时间停在 running，
   代价是慢网络（3 条命令）下总预算更紧；如需放宽，可配置 `updateTimeoutMs`。
5. **多 profile 与 `link:` 反推**的既有不确定性不变（`link:` 安装反推不出 profile，只能扫
   `$DSH_HOME/profiles/*` 取字典序第一个）；实际 `link:` 会被直接跳过，所以只会影响报错指向哪个目录。
6. **`WORKTODO_UPDATE_LATEST` 是测试缝**：生产环境不设置它就完全走真实 registry 查询；
   但它确实能强制「已知最新版」并可能触发一次自动升级——只应由测试使用（与既有 `WORKTODO_PNPM_PATH`
   等缝同一性质）。
7. **升级成功后不自动重启 DSH**（既有取舍保留），只提示「重启 DSH 生效」。
8. **版本比较不支持预发布号**：`compareVersion` 是按 `major.minor.patch` 解析的，
   `0.2.7-beta.1` 会被当成 `0.2.7`。正常路径上 `dist-tags.latest` 不会是预发布版，
   所以影响不到「升级是否真的发生」的判定；但如果用户自己装的是预发布版，落盘版本变化可能被判成「没变」。
   本轮没动这个既有函数（改动面最小）。
9. **「不阻塞请求」的实测覆盖**的是手动触发升级时的 `GET /list`；自动更新走的是同一个后台序列
   （`void startUpdate()` → `void runUpdateSequence()`，`apply()` 不 await 它），
   所以「启动时自动升级」同样不会阻塞挂载或任何请求，只是没有单独再计一次耗时。
