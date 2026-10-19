# 检查更新超时被当成「插件故障」——根因与修复

本轮只修体验 bug：**用户已是最新 0.2.8，面板却显示红色「检查更新失败：the operation was aborted due to timeout」**。
不升版本、不改 CHANGELOG / `.github`、不 commit / push / tag / 发布，也不碰真实 profile 与 `~/.dsh` 数据。

---

## 0. 结论摘要

1. **根因有两层**：单次 registry 查询写死 `AbortSignal.timeout(8000)`（国内访问 npm registry 常见 10s+）；
   失败又被映射成 `phase: 'failed'` + `failedOperation: 'check'` —— 与下载/安装失败共用红色徽标，
   并且把原始错误串 `the operation was aborted due to timeout` 直接拼进面板文案。
2. **修法**：单次 20s → 失败等 3s 用**新的 AbortController** 重试 1 次 → 整次检查预算 25s；
   失败改为温和的 `phase: 'check-failed'`（兼容 `state: 'idle'`）+ `checkError {reason, at, retriable, attempt, nextRetryAt, retryInMs}`，
   原始异常只进 `diagnostics.checkError`。
3. **不阻塞**：`/list` 仍只 `void refreshUpdate()`，检查全程异步；慢 registry 在飞时实测 `/list` 首屏 **0ms**（断言 <100ms）。
   检查失败时 `latest = null` → `hasUpdate === false`，列表渲染不受影响。
4. **自动重试**：失败后按 30s → 60s → 120s … 指数退避（上限 10 分钟）由下一轮 `/list` 轮询自然触发；成功后清零复位。
5. **面板文案**（中英）：
   - 中文：`暂时无法检查更新，稍后自动重试`
   - 英文：`Couldn't check for updates right now, will retry automatically`
   - 徽标走最淡的 `muted` 色（不亮红、没有重试按钮、没有原始错误串）；技术细节只在 `diagnostics`。
6. 两套门禁均 **10/10、EXIT=0**（本机 `WORKTODO_NO_UPDATE_CHECK=1` 与干净 `env -i` 环境）。

---

## 1. 根因

### 1.1 超时值太短

`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/index.js` 的 `refreshUpdate()` 旧实现：

- 只发一次 `fetch(<registry>/dsh-worktodo)`；
- 用 `AbortSignal.timeout(8000)` 写死 8s；
- 没有重试，也没有「整次检查预算」的概念。

国内访问 `registry.npmjs.org` 经常 10s+，一次抖动就必然超时。

### 1.2 失败被映射成「插件故障」

旧 catch 分支：

- `setPhase('failed', { failedOperation: 'check', failure: 'check-network', error: '检查更新失败：<raw>' })`；
- 面板 `failureBadge()` 对 `phase === 'failed'` 一律渲染 `tone: 'error'`（红色）+ 重试按钮；
- `error` 里的原始字符串就是用户看到的 `the operation was aborted due to timeout`。

这里把「这次没查到版本」错误地等同于「下载/安装失败」。插件本身没坏、待办列表也完全正常。

### 1.3 失败后 6 小时才重试

`updateState.at` 在失败时也被写成当前时间，而 `/list` 的自动检查闸门只看 `UPDATE_TTL_MS`（6 小时）。
于是网络抖一下之后，用户要在「检查更新瘫痪半天」和「红标一直挂着」之间二选一。

---

## 2. 修法

### 2.1 超时 / 重试 / 预算（宿主）

`lib/index.js` 新增并导出（纯函数，可单测）：

- `UPDATE_CHECK_TIMEOUT_MS = 20000`
- `UPDATE_CHECK_RETRY_DELAY_MS = 3000`
- `UPDATE_CHECK_TOTAL_BUDGET_MS = 25000`
- `UPDATE_CHECK_MAX_ATTEMPTS = 2`
- `UPDATE_CHECK_BACKOFF_BASE_MS = 30000`
- `UPDATE_CHECK_BACKOFF_MAX_MS = 600000`
- `resolveCheckTimeoutMs(env)`：默认 20s；`WORKTODO_CHECK_TIMEOUT_MS` 覆盖（下限 100ms、上限 120s）。
- `resolveCheckRetryDelayMs(env)`：默认 3s；`WORKTODO_CHECK_RETRY_DELAY_MS` 覆盖（测试可设 0）。
- `resolveCheckBackoffMs(failureCount)`：`30s * 2^(n-1)`，封顶 10 分钟。

实现要点：

- 每次尝试**新建** `AbortController`；用 `AbortSignal.any([attempt.signal, lifecycleController.signal])` 与卸载取消合流。
- 单次预算 `min(20s, 剩余总预算)`；重试间隔也只花剩余预算，因此最坏总耗时约 25s，而不是 20 + 3 + 20 = 43s。
- 检查定时器与退避等待**刻意不 `unref`**：否则没有其它句柄的进程（一次性 CLI / 测试）会在超时触发前直接退出。
- 退避期间会先把 `nextAt` 推远，避免 `/list` 在重试在飞时并发起第二个检查；有结论后再写真实退避或清零。

### 2.2 温和失败状态（宿主）

- `UPDATE_PHASES` 新增 `check-failed`；`COMPAT_STATE['check-failed'] = 'idle'`（老面板不会读到 `failed`）。
- `updateRun` 新增 `checkError`，并随 `GET /worktodo/update`、`/list` 的 `update.run` 与 `update.checkError` 下发：
  `{ reason: 'timeout'|'network'|'http'|'unknown', at, retriable: true, attempt, nextRetryAt, retryInMs }`。
- 检查失败时 `updateRun.error = null`、`failedOperation = null`、`failure = null`；
  原始异常只写 `diagnostics: { checkError, checkReason, attempts }`。
- `updateState.latest = null`，所以 `hasUpdate === false`（没查到就是「不知道 / 无更新」）。
- 连续失败 `checkFailure.count++`，退避 `30s → 60s → 120s … 600s`；任何一次成功都清零。
- `/list` 的自动触发从「只看 6 小时 TTL」改为 `updateCheckDue()`：有失败计数时看退避时间，否则看 TTL；
  仍然是 `void refreshUpdate()`，**绝不 await**。

### 2.3 面板（客户端）

`src/client/index.js`：

- 新增中英文案：
  - `updateCheckFailed` / `updateCheckFailedHint`
  - 中文：`暂时无法检查更新，稍后自动重试`；英文：`Couldn't check for updates right now, will retry automatically`
- `updateBadgeState()` 新增 `phase === 'check-failed'` 分支：
  - `tone: 'muted'`（最淡的一档，不是 `error`）；
  - `action: null`、`disabled: true`（后台会自动重试，不需要用户点）；
  - 没有 `detail`，不把 `diagnostics` 里的原始错误带到徽标或 title。
- `UPDATE_TONE_STYLE` 增加 `muted`（label3 系，主题变量驱动）。
- `isUpdateBusy()` 不把 `check-failed` 算进行中，避免常驻 2s 轮询。
- `checking` 仍然显示「正在检查更新…」轻提示，不阻塞首屏。

---

## 3. 测试

测试文件数量保持 **9 个**（`tools/*.mjs` 中仍是 9 个 suite；`verify-all` 另算 build 一步）。

### 3.1 宿主（`tools/smoke-host.mjs` 新增 3 条）

1. **策略常量与纯函数**：20s / 3s / 25s / 两次尝试 / 退避 30→60→120…→600s、env 覆盖与非法值回落。
2. **假 registry 慢响应**：
   - 本地起一个只监听 `127.0.0.1` 的假 registry，**25s 后才回**；
   - 用测试缝把单次超时压到 300ms、重试间隔 50ms，仍走同一条「超时 → 新 AbortController 重试」路径；
   - 断言最终 `phase === 'check-failed'`、`state === 'idle'`、`checkError.reason === 'timeout'`、
     `attempt === 2`、`retriable === true`、`retryInMs === 30000`；
   - 断言假 registry 收到 **2 次**请求（真的重试了）；
   - 断言 `/list` 在检查在飞时返回 200、**耗时 <100ms（实测 0ms）**、`hasUpdate === false`；
   - 断言列表摘要里 `run.error === null`，原始错误不在面板字段里；
   - 再手动 POST `plugin-update-check` 失败一次，断言仍是 `check-failed`（不是红色 `failed`），
     且连续第二次失败退避到 **60000ms**。
3. **第二次成功**：假 registry 第一次延迟 5s（超过 200ms 超时）、第二次立即返回新版本；
   断言 `hits === 2`、最终 `phase === 'available'`、`checkError === null`、`to === FAKE_NEXT_VERSION`、
   `/list` 的 `hasUpdate === true` 且 `checkError === null`（成功复位）。

### 3.2 客户端（`tools/smoke-client.mjs` 新增 1 条）

- `phase: 'check-failed'` 时：`tone === 'muted'`、`action === null`、`detail === undefined`；
- 徽标/提示里不含 `aborted` / `timeout` / `ECONN` / `ENOTFOUND` / `operation was aborted`；
- 中文不含「失败」、英文不含 `failed`；
- 中英两个 key 都存在且值里没有原始错误串；
- `isUpdateBusy({ phase: 'check-failed' }) === false`；
- 正常 `idle` + `hasUpdate:false` 时仍然不渲染徽标。

### 3.3 反向验证（改坏 → 变红 → 恢复 → 变绿）

| 故意改坏 | 结果 | 证据 |
| --- | --- | --- |
| `UPDATE_CHECK_TIMEOUT_MS` 改回 `8000` | `smoke-host` 变红：`单次检查超时必须是 20s：期望 20000，实际 8000`，EXIT=1 | `/tmp/wt-reverse-timeout.log` |
| `phase === 'check-failed'` 改回 `failureBadge()`（红色失败态） | `smoke-client` 变红：`不能用 error 红色：期望 "muted"，实际 "error"`，EXIT=1 | `/tmp/wt-reverse-red.log` |
| 两处均恢复 | 两个 suite 重新变绿（宿主 122/122、客户端 64/64） | `/tmp/wt-smoke-host6.log`、`/tmp/wt-smoke-client.log` |

---

## 4. 门禁结果

两套命令均显式检查退出码（没有用管道吞失败）：

```bash
WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs
# EXIT=0，10/10 个步骤通过（含构建）

env -i HOME=/tmp/cihome PATH=<node目录>:/usr/bin:/bin CI=true node tools/verify-all.mjs
# EXIT=0，10/10 个步骤通过（含构建）
```

- 本机：`/tmp/wt-verify-local-final.log`
- 干净环境：`/tmp/wt-verify-clean-final.log`

`/list` 实测：慢 registry 检查在飞时 **0ms**（用例断言 <100ms）。

---

## 5. 未做 / 不确定

1. **没有新增「检查更新」按钮**：面板本来就没有这个入口，手动检查是既有
   `POST /worktodo/update {action:'plugin-update-check'}`。本轮只保证这条路径失败时也返回 `check-failed` 温和态。
2. **真实 20s 墙钟未被测试实际等待**：集成测试用 `WORKTODO_CHECK_TIMEOUT_MS=300` 压缩时间，
   20s 默认值由纯函数/常量断言钉住；这比让 CI 真等 25s 更稳定，但也意味着「真实 20s 网络超时」只在代码路径层验证。
3. **自动轮询的 30s 退避没有在测试里真等 30s**：退避数值由纯函数与首败 `retryInMs: 30000` 断言，
   连续失败用强制手动检查验证 60s；`/list` 的 `updateCheckDue()` 闸门未做 30s 墙钟集成测试。
4. **HTTP 4xx 也会重试一次**：实现按「任何失败都重试一次」处理；404 这类确定性错误多打一次请求，
   代价很小，但没有按状态码区分。若后续要更精细，可在 `classifyCheckError` 里把 4xx 标成不可重试。
5. 本轮未升版本、未改 CHANGELOG / `.github`、未 commit / push / tag / 发布；`package.json` 仍是 0.2.8。
