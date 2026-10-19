# 更新方式设置（off / manual / auto）+ 自动更新后提醒重启

- 仓库：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`
- 版本：0.2.9（本轮**不升版本**、不改 CHANGELOG / `.github`、不 commit / push / tag / 发布）
- 日期：2026-10-19
- 代码：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/index.js`、
  `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/client/index.js`
- 测试：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-host.mjs`、
  `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-client.mjs`、
  `~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-contract.mjs`
- 构建产物：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/client.js` 与
  `.map` 由 `tools/build-client.mjs` 重新生成；测试套件仍是 **9 个**。

## 1. 三档语义

| 值 | 面板文案 | 后台行为 | 网络 | 自动下载/安装 |
| --- | --- | --- | --- | --- |
| `off` | 禁用更新 / Updates off | 完全不检查更新；启动检查、`/list` 轮询、手动「检查更新」都不打网络 | **零请求** | 否 |
| `manual`（默认） | 仅提示新版本 / Only notify me | 后台只检查（沿用 20s + 重试 1 次 + 25s 预算 + 30s→10min 退避）；有新版本只在面板提示 | 检查时才请求 | **绝不**；用户点「下载」「安装并重启」才动 |
| `auto` | 自动更新 / Auto-update | 检查 → 有新版自动下载 → 自动安装；装好停在 `installed` + `restartRequired:true` | 检查 + 下载 | 是；但**不自动重启** |

`auto` 安装成功后，面板顶部出现醒目提示条（不是错误红、没有假重启按钮）：

- 中文：`已更新到 vX，请重启 DSH 生效`
- English：`Updated to vX — restart DSH to apply`

`off` 下连 `restartRequired` 提示也不展示：面板只显示当前版本（与「完全没有更新概念」一致）。

### 1.1 config 与 UI 设置的优先级

**用户设置（`settings.json`）优先**；插件 config 只在没有设置文件时充当默认值：

- `config.autoUpdate: false` → 默认档位 `manual`。这是 0.2.x 的旧语义「不要自动升级」，
  但**仍然检查**；它**不等于 `off`**（`off` 只能由用户在面板里显式选择，避免一次配置手滑
  把更新提示也一起关掉）。
- `config.autoInstall: true` → 默认档位 `auto`（显式 opt-in 的旧行为「后台下完就装」）。
- 其余（含空配置）→ `manual`（安全默认：只提示）。

一旦 `settings.json` 存在且合法，它就覆盖上述两个 config；UI 里切档立即生效，无需重启 DSH。

## 2. 存储与 API

### 2.1 存储

- 位置：`$DSH_HOME/worktodo/settings.json`。
- 内容：只存 `{updateMode, updatedAt}`；`updatedAt` 是 ISO 字符串。
- 写入：复用 `writeFileAtomicSync`（原子替换；测试断言目录里没有 `.tmp` / `.bak` 残留）。
- 读取失败 / 损坏 / `updateMode` 非法 → **回退 `manual`** + `logger.warn`，绝不崩；
  文件缺失是首次启动的常态，按 config 推导的默认档位处理，不告警。
- 测试缝：`WORKTODO_SETTINGS_PATH`；未设置时默认放在 update-state 同目录的
  `settings.json`，因此测试把状态文件指到临时目录时，设置也永远不会落到真实 `~/.dsh`。

### 2.2 API

- `GET /worktodo/settings`
  → `{ok:true, data:{updateMode, effective:{autoCheck, autoInstall}, updatedAt}}`
- `POST /worktodo/settings`，body `{updateMode}`
  - 合法 `off | manual | auto`：原子写盘 + 更新内存档位 → `{ok:true, data:{updateMode, effective, updatedAt}}`
  - 非法值：**HTTP 400** + `reason:'invalid-update-mode'`，**不写盘**（测试逐字节比较文件前后）
  - 写盘失败：HTTP 500 + `reason:'settings-write-failed'`，内存档位保持不变
- `/list` 的 `update` 块与 `GET /worktodo/update` 都带 `updateMode` + `effective`；
  `/worktodo/update` 还带 `restartRequired`（落盘版本 > 运行版本）。

`effective` 的口径只有一份（`effectiveUpdatePolicy`）：

- `off` → `{autoCheck:false, autoInstall:false}`
- `manual` → `{autoCheck:true, autoInstall:false}`
- `auto` → `{autoCheck:true, autoInstall:true}`

## 3. 面板交互

- 头部新增**齿轮按钮**：`title` / `aria-label` 中英随语言、`aria-haspopup="dialog"`、
  `aria-expanded` 反映浮层状态。
- 点开小浮层：
  - `role="dialog"` + 中英标题；
  - 三档 `role="radio"` + `aria-checked`（原生 `<button>`，Tab/Enter/Space 可达，
    Escape 收起）；每档带一句说明；
  - 「当前版本 vX」；
  - 「检查更新」按钮：`off` 时禁用，`title` 说明「已禁用更新，不会检查」；
  - 保存失败时浮层内显示 `role="alert"` 的文本错误。
- 顶部重启提醒：`restartRequired` 时渲染一条 `role="status"` / `aria-live="polite"` 的提示条，
  只含文本节点，**没有**「重启」按钮；`off` 时不渲染。
- 无障碍/规范：全部使用 `React.createElement` 文本子节点（无 `innerHTML`）、
  `aria-checked`、原生按钮键盘可达；没有新增动效，`prefers-reduced-motion` 无需额外分支。

## 4. 与已有状态机如何共存

- `refreshUpdate()` 入口先判档位：`off` 直接返回（连注入的测试 latest 都不处理）；
  在飞检查用 `activeCheckControllers` + `updateModeEpoch` 双重收口：
  切到 `off` 时 abort 当前检查，晚到的结果因 epoch 不匹配被丢弃，绝不触发下一次重试。
- `updateCheckDue()` 在 `off` 下恒为 false；启动定时器到点也跳过检查。
- `manual` / `auto` 共享既有的 `checking / check-failed / available / downloaded / installed /
  unsupported / failed` 状态机；新增档位没有新增 phase。
- `maybeAutoUpdate()` 只在 `auto` 下运行：
  - 下载前先做只读 `detectUnsupportedInstall()`；命中 `link:` / 推不出 profile 就
    `unsupported` 收口，**不下载、不安装、不写节流状态**（一个子进程都不起）；
  - 下载完成后再确认一次档位仍是 `auto`，避免用户中途切回 `manual/off` 仍被自动安装；
  - 安装成功由既有 `finishRun('done')` 收口为 `installed`，`restartRequired` 由
    「落盘版本 > 运行版本」计算；**从不**调用重启。
- `manual` 与 `auto` 的下载/安装仍走既有两步护栏（`requireDownload`、逐字节校验、跨进程锁、
  回滚事务），档位只决定「谁触发」，不改变安装事务本身。
- `check-failed` / `unsupported` 的温和文案、muted 色、无重试按钮等既有行为不变。

## 5. 测试

全部加进现有 9 个套件，没有新增测试文件。

### 5.1 宿主（`smoke-host.mjs`，129 通过 / 0 失败）

1. **三档纯函数 + 持久化**：`UPDATE_MODES` / 默认值 / 非法值 / config 映射 /
   `effective` 口径；POST 三种模式后 GET 一致；`settings.json` 只有两个键；
   目录无 `.tmp`/`.bak` 残留；非法值 400 且文件逐字节不变；损坏文件回退 `manual` 且告警。
2. **`off` 零网络**：本地假 registry 记录请求；启动 + `/list` 轮询共 0 请求；
   `/list` 的 `hasUpdate:false`、`latest:null`、`checkError:null`、`run.phase:'idle'`。
   同一用例还验证「检查在飞时切到 off」：先切 manual 触发一次慢检查，再切 off，
   断言请求数停在 1、阶段回到 idle、错误为空（abort 不被当成失败）。
3. **`manual` 不自动装**：注入新版本后停在 `available`；假 pnpm 调用 0 次、暂存区不存在；
   `/list` 仍 `hasUpdate:true` 并带 `latest`。
4. **`auto` 全自动 + 重启提醒**：假 tarball 服务命中 1 次、假 pnpm 真的改掉落盘版本；
   最终 `phase:'installed'`、`restartRequired:true`、`restart:null`（不自动重启）；
   `/list` 的 `restartRequired:true`、`installedVersion` 是新版本。
5. **`auto` + `unsupported`（link:）**：不安装（pnpm 0 次）、暂存区不存在、
   `update-state.json` 不存在（零写盘）、profile 逐字节不变、`settings.json` 不变；
   `phase:'unsupported'` + `updateUnsupported:'link-install'` + 温和可执行文案。
6. 另更新了受影响的既有用例：路由数 8→9、默认配置「只查不装」、config 默认值映射
   （`autoInstall:false` → manual，用户点下载/安装才动；`autoInstall:true` → auto 全自动）。
7. `smoke-contract.mjs`（22 通过）的静态契约补上 `/settings` + `updateMode`，并让
   `plugin-update-check` 按「返回状态」而不是「稳定失败原因」校验（它是成功收口）。
8. A2 超时用例的超时窗口从 800ms 放宽到 3s：清洁环境里机器负载高时，假 pnpm 可能在
   写规格之前就被杀，导致「没有可回滚的规格」而误红；放宽后仍用 5s 睡眠证明「超时必收口」。

### 5.2 客户端（`smoke-client.mjs`，67 通过 / 0 失败）

- `off` 下 `updateBadgeState` 对 idle / check-failed / unsupported 都返回 `null`；
- `restartNotice` 中英都含目标版本、无 action；`off` / 非 `restartRequired` 返回 null；
- 中英 `updateRestartBanner` 等键都存在且含 `{version}`；
- 真渲染：头部齿轮是按钮且有 title/aria；点开后 `role="dialog"`、
  三档 `role="radio"` + 正确 `aria-checked`、当前版本、检查按钮；
  选 `off` 后检查按钮禁用且 title 说明原因；全程无 `innerHTML`。

### 5.3 反向验证（改坏 → 变红 → 恢复 → 变绿）

| 故意改坏 | 结果 | 关键报错 |
| --- | --- | --- |
| 去掉 `refreshUpdate` / `updateCheckDue` 的 `off` 短路 | `smoke-host` EXIT=1 | `off：阶段保持 idle：期望 "idle"，实际 "checking"` |
| `auto` 下载完成后不进入安装 | `smoke-host` EXIT=1 | `auto 要一路装完（实际 downloaded...）：期望 "installed"，实际 "downloaded"` |
| `restartNotice` 恒返回 null | `smoke-client` EXIT=1 | `restartRequired 的顶部提示…`（读取 null 的 text） |
| 三处均恢复 | 宿主 129/129、客户端 67/67，全绿 | 恢复文件与破坏前校验和一致 |

## 6. 两套门禁

两套都显式检查退出码（没有用管道吞失败）：

```bash
WORKTODO_NO_UPDATE_CHECK=1 node tools/verify-all.mjs
# EXIT=0，10/10 个步骤通过（含构建）
```

```bash
env -i HOME=/tmp/cihome PATH=<node目录>:/usr/bin:/bin CI=true node tools/verify-all.mjs
# EXIT=0，10/10 个步骤通过（含构建）
```

干净环境先重建 `/tmp/cihome`，不带任何 `WORKTODO_*` / `DSH_*` 变量；`verify-all.mjs` 自己在
子进程环境里设置 `WORKTODO_NO_UPDATE_CHECK=1`，所以全套测试不会联网。

## 7. 未做 / 不确定

- **config 不再能把档位设为 `off`**：`autoUpdate:false` 只映射到 `manual`（保留旧语义：
  「不要自动升级」但仍然检查）。这是刻意的安全取舍；如果以后需要「配置文件级禁用更新」，
  可以再增加 `config.updateMode` 并明确优先级，本轮没做。
- **`unsupported` 不写节流状态**：为了满足「零写盘」，`auto` + `link:` 不再写
  `update-state.json` 的 `result:'unsupported'`。代价是这类安装每次启动都会做一次只读预判
  （不起子进程、不打网络、不写盘），可以接受；真正的下载/安装尝试仍按 A4 节流。
- **`off` 时若已有下载/安装在进行**：只中止「检查」，不粗暴打断用户已经触发的下载/安装；
  完成后面板会因 `off` 不再显示更新徽标。这个边界没有专门用例（避免把测试写成实现细节）。
- **没有在真实 DSH 里点真实 profile 的面板**（按约束不碰真实 profile/数据）；面板交互由
  `smoke-client` 的真渲染 + 纯函数覆盖，宿主行为由假 profile/假 registry/假 pnpm 覆盖。
- 本轮未升版本、未改 CHANGELOG / `.github`、未 commit / push / tag / 发布；
  `package.json` 仍是 0.2.9。
