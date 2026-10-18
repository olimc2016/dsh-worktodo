# 0.2.6 CI 失败修复报告：自升级用例在干净环境里退化成 idle

- 日期：2026-10-18
- 范围：`dsh-worktodo` 0.2.6 发布前的 CI Test 失败（0.2.5 仍是线上 latest，0.2.6 未发布）
- 结论：**不是 Node 22/24 的 API 差异，也不是 profile/state 路径解析失败**；根因是
  「单元测试想关掉 registry 查询，但 ESM 导入提升让开关晚了一步」+「启动版本检查在飞时，
  手动升级被 `startInstall` 的『已在运行』守卫当成安装进行中而静默丢弃」。
  另有一个并发收口缺陷：检查/超时的状态会在回滚之前或之后互相覆盖。

## 1. CI 失败矩阵：失败的是哪一个 job、哪个 Node

CI 日志副本在 `/tmp/f26/`。失败 job 是 **publish**（`publish.yml`，tag `v0.2.6`），
不是 test matrix 的那两个 job：

- `/tmp/f26/publish/4_Run actions_setup-node at v4 txt:3`：`node-version: 22`
- 同文件 `:16`：`node: v22.23.3`
- 失败汇总：`/tmp/f26/0_publish.txt:915-922` → 宿主接线与工具、客户端↔宿主契约两个 suite 红，
  `8/10 个步骤通过（含构建）`

本机用 **Node v22.23.3（与 CI 同版本）** 和 **Node v24.21.0（DSH 自带运行时）** 分别复现，
两边的失败集合完全一致（smoke-host 20 红、smoke-contract 4 红）。因此这不是 22 与 24 的
`fs.writeSync` / `structuredClone` / `fetch` / `AbortSignal.timeout` / `os.homedir()` 差异。

## 2. 复现：干净环境 + CI=true

仓库：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`（修复前 commit `f17680b`）

```bash
# Node 24（DSH 自带）
N24=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin
env -i HOME=/tmp/cihome PATH="$N24:/usr/bin:/bin:/usr/sbin:/sbin" CI=true \
  "$N24/node" tools/verify-all.mjs

# Node 22.23.3（从 nodejs.org 解到 /tmp/node22，与 CI 同版本）
N22=/tmp/node22/node-v22.23.3-darwin-arm64/bin
env -i HOME=/tmp/cihome PATH="$N22:/usr/bin:/bin:/usr/sbin:/sbin" CI=true \
  "$N22/node" tools/verify-all.mjs
```

修复前两边都是：

```text
✗ 宿主接线与工具  (smoke-host.mjs)      76 通过，20 失败
✗ 客户端↔宿主契约  (smoke-contract.mjs)  18 通过，4 失败
8/10 个步骤通过（含构建）
```

关键失败原文与 CI 一致，例如：

```text
link: 安装必须被拒绝，而不是照装：期望 false，实际 true
命令成功但版本没变必须落 failed（实际 idle）：期望 "failed"，实际 "idle"
没有可用新版本时阶段必须是 idle（实际 checking）：期望 "idle"，实际 "checking"
下载没完成时必须拒绝安装：期望 false，实际 true
```

**本地正常环境也会红**：同一份修复前代码，用
`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node tools/verify-all.mjs`
跑出同样的 20+4 失败。所谓「本地全绿」只是启动 registry 查询恰好在测试发请求前完成，
是时序运气，不是环境差异。

## 3. 根因与证据

### 3.1 测试的「不联网」开关被 ESM 导入提升绕过了

两个测试文件顶部都写了：

```js
// tools/smoke-host.mjs:2
process.env.WORKTODO_NO_UPDATE_CHECK = '1';
```

但下一行就是静态 `import ... from '../lib/index.js'`。ESM 的静态 import 会在模块体
语句之前求值，所以 `lib/index.js` 顶层读到的仍是 `undefined`：

```js
// 修复前
const UPDATE_CHECK_OFF = process.env.WORKTODO_NO_UPDATE_CHECK === '1';
```

最小证据（同一机制，独立于本仓库）：

```text
$ node /tmp/hoist-main.mjs
imported module saw: undefined
main module later sees: 1
```

后果：`UPDATE_CHECK_OFF=false`，`apply()` 启动时真的执行
`void refreshUpdate()` → `fetch('https://registry.npmjs.org/dsh-worktodo')`（8s 超时）。
CI 的 runner 到 registry 的往返只要几十到几百毫秒，但测试在 `apply()` 后几十毫秒内就开始
发升级请求，于是 `updateRun.phase` 停在 `checking`。

**证据**：CI 日志里响应体直接打印了阶段：

- `/tmp/f26/publish/7_Test.txt:277`、`:279`：
  `{"ok":true,"running":true,"state":"running","phase":"checking",...}`

### 3.2 `checking` 被当成「已经在安装」，所有守卫轮不到执行

修复前 `startInstall` 的第一道守卫是：

```js
if (['checking', 'downloading', 'verifying', 'installing', 'restarting']
  .includes(updateRun.phase)) {
  return { ok: true, running: true, ...updateStatus() };
}
```

`checking` 只是查版本，不是安装。但它在最前面，于是：

- `link:` 用例：请求回 `ok:true running`，根本没走到 profile 读取和 `isLocalSpec` →
  「期望 false，实际 true」；
- 两步护栏：`plugin-update-install` 同样先回 `ok:true running`，`requireDownload` 的
  `not-downloaded` 拒绝被绕过；
- 手动升级 / 核心序列：一个子进程都不起；检查随后完成把阶段改成 `idle`，于是测试看到
  「实际 idle，命令 0 条」；
- GET 状态：启动检查在飞，读到 `checking` 而不是 `idle`；
- autoUpdate：注入的 latest 与在飞的检查交错，出现一次尝试 4 条命令、或显式关闭仍起
  1 条命令的时序结果。

这就是「link: / autoUpdate / 下载护栏同时失效」的同一个根因。

### 3.3 检查晚到时会冲掉已经开始的安装

`refreshUpdate` 在 `await fetch()` **之前**算好 `idleBefore`，之后仍用它决定是否 `setPhase`。
如果检查期间用户点了升级，`phase` 已变成 `installing`，检查返回后仍会写回 `idle/available`。
这正好解释了「命令跑了，状态却是 idle」这一类失败，也会让真实面板把正在安装的任务显示成空闲。

### 3.4 超时结论早于回滚收口（A2 偶发红）

`runUpdateStep` 的超时定时器原来直接 `finishRun('failed', ...)`，而 profile 清单回滚要到
`runUpdateSequence` 的 `finally` 才执行。测试轮询到 `state=failed` 时可能还没回滚，
于是 `error` 里没有「已回滚」。这是修复过程中 5 次重跑里偶发 1 次的独立竞态，
不是 CI 那 20 条的主因，但同样属于「状态机在回滚前后不一致」。

## 4. 修法

原则：测试假设错了改测试，代码行为不对改代码；没有放宽任何断言。

### 4.1 代码（`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/index.js`）

1. `UPDATE_CHECK_OFF` 常量 → `updateCheckOff()` 函数，**每次调用时读环境变量**。
   测试即使因 ESM 提升晚设置，`apply()` 时也能生效；生产行为不变。
2. `startInstall` 的「已在运行」守卫移除 `checking`。只有
   `downloading/verifying/installing/restarting` 才算安装进行中；`checking` 继续走
   profile → link: → requireDownload → 安装序列。
3. `refreshUpdate` 在 `await` 之后重新确认 `updateRun.phase === 'checking'` 才收口，
   不再用 await 前的 `idleBefore` 快照冲掉 `installing/downloading`。
4. 超时不在定时器里落 `failed`：序列记录 `pendingFailure`，`finally` 里先
   `settleTransaction()`（回滚并追加说明），再 `finishRun('failed')`。面板读到的
   `failed` 一定带着回滚结论。

### 4.2 测试（不新增测试文件，仍是 9 个 suite）

1. `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/verify-all.mjs`：spawn 子进程**之前**设置
   `process.env.WORKTODO_NO_UPDATE_CHECK = '1'`，让每个 suite 从第一行就继承它，
   不再依赖测试文件模块体的晚设置。
2. `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-host.mjs`：新增一条回归用例
   「启动检查在飞时点升级不能被『已在运行』吞掉，且检查晚到不许冲掉结论」。
   它起一个**只监听 127.0.0.1 的慢 registry**（400ms 后返回），显式证明：
   - 前置条件 `phase=checking` 真的在飞；
   - 此时点升级，`link:` 仍被拒绝（`ok:false, reason:'linked'`）；
   - 检查晚到后阶段仍是 `failed/linked`，没有被冲成 `available`。
   全程不联网、不碰真实 profile / 真实 `~/.dsh`。

## 5. 反向验证

1. **修复前基线**：commit `f17680b` + 干净环境（Node 22 与 24）→ 8/10，20+4 红，
   与 CI 日志一致（见第 2 节）。
2. **只回退守卫与晚到收口**（保留测试环境修复与新增用例）：
   `smoke-host` 变红，失败原文正是 CI 的那一句：

   ```text
   ✗ 自升级：启动检查在飞时点升级不能被「已在运行」吞掉...
       检查在飞不是「已在安装」：手动升级必须继续走守卫，link: 要拒绝：期望 false，实际 true
   ```

3. **只回退「检查晚到重新确认 phase」**（守卫保留）：新用例在第二阶段变红：

   ```text
   ✗ ... 检查晚到不许把已定论的 link: 冲成 available/idle（实际 available）：期望 "failed"，实际 "available"
   ```

   两次回退后都还原为修复版，再跑全量恢复 10/10。

## 6. 两套环境结果（修复后）

| 环境 | Node | 命令 | 结果 |
| --- | --- | --- | --- |
| 干净环境（`env -i`、临时 HOME、`CI=true`） | 24.21.0 | `env -i HOME=/tmp/cihome PATH="$N24:..." CI=true "$N24/node" tools/verify-all.mjs` | **10/10** |
| 干净环境（同上） | 22.23.3（与 CI 同版本） | `env -i ... "$N22/node" tools/verify-all.mjs` | **10/10** |
| 本机正常环境（继承 `DSH_HOME` 等） | 24.21.0 | `~/.dsh/.../node tools/verify-all.mjs` | **10/10** |

另外 `smoke-host.mjs` 在干净环境连续跑 5 次均 `97 通过，0 失败`，未见 A2 超时回滚的偶发红。

## 7. 未做 / 不确定

- 只拿到 publish job 的日志；test matrix 的 22/24 两份线上日志不在 `/tmp/f26`。
  但同版本 Node 22.23.3 与 Node 24.21.0 已在本地分别复现和验证。
- 生产环境的 `refreshUpdate` 仍会真实访问 registry（这是功能，不是测试）；本次只保证
  「检查在飞时手动升级不再被静默吞掉」。
- 在生产里若用户在检查尚未返回时点升级，`updateState.latest` 可能还是 `null`：
  本次会先跑 `pnpm update`，拿不到 latest 时跳过精确版本 `pnpm add` 那一步。
  这是有明确失败原因的降级路径，没有为了 CI 去伪造 latest。
- A2 的「超时后先 failed 后回滚」竞态是修复过程中额外发现并修掉的，不是 CI 20 条失败的主因。
- 没有改 `.github/`、版本号、CHANGELOG；没有 commit / push / tag / 发布；
  所有测试 profile、临时 HOME、状态文件、下载暂存区都在 `/tmp` 下。
