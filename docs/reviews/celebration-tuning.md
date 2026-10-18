# 完成动效调校：从「一闪而过」到从容落定

对象：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`（0.2.5，git HEAD `3d08b44`）。
本轮**不升版本、不改 CHANGELOG/.github、不 commit/push/tag/发布**；实验都在 `/tmp`，没有碰真实数据与 profile。

---

## 结论摘要

- 三段动效从「320ms 弹跳 / 300ms 描边 / 560ms 高亮」改成 **620ms 轻呼吸 / 520ms（delay 140ms）描边 / 1150ms（delay 80ms）整行落定**，总时长 **1230ms**。
- 勾选框不再用带回弹的 `cubic-bezier(.34,1.56,.64,1)`，改成 `cubic-bezier(0.22,0.61,0.36,1)`；缩放只到 **1.06**，不再 1.32 过冲。
- 关键修复：完成类写入成功后**不再立刻 `refresh()`**，而是排一个 **1260ms** 的定时器，让 CSS 动画完整播完、行留在原位，再重取列表「落位」到已完成分组。
- 降级路径保持原语义：`prefers-reduced-motion: reduce`、`config.celebrate=false`、取消完成、写失败都**不排延迟定时器、立即刷新**。
- 全量 `verify-all` **10/10**（含构建），`smoke-client` 61 条断言全绿；两条反向验证都按预期变红。

---

## 1. 最终参数表

| 段 | 时长 | 延迟 | 缓动 | 动什么属性 |
| --- | --- | --- | --- | --- |
| 勾选框 | **620ms** | 0 | `cubic-bezier(0.22, 0.61, 0.36, 1)` | `transform: scale(1 → 1.06 → 1)`；`background: transparent → ok/10% → ok/14%`（极轻的背景淡入，终态与 `.wt-check-done` 一致） |
| 对勾描边 | **520ms** | **140ms** | `ease-out` | `stroke-dashoffset: 14 → 0`（配合 `stroke-dasharray: 14`，「写出来」） |
| 整行背景 | **1150ms** | **80ms** | `ease-out` | `background: ok/26% → ok/16% → ok/6% → transparent`（缓慢淡出，不是一眼就没） |
| 标题颜色 | **560ms** | **80ms** | `ease-out` | `color: var(--dsw-alias-label) → var(--dsw-alias-label-tertiary)` |
| 总计（落定） | **1230ms** | — | — | 整行 delay + duration |
| 延迟刷新 | **1260ms** | — | — | 比总时长多 30ms 余量，保证最后一帧不被重排切掉 |

实现位置（`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/client/index.js`）：

- 常量：`CHECK_POP_MS` / `MARK_DRAW_MS` / `MARK_DRAW_DELAY_MS` / `ROW_CELEBRATE_MS` / `ROW_CELEBRATE_DELAY_MS` / `TITLE_SETTLE_MS` / `CELEBRATE_MS` / `CELEBRATE_REFRESH_MS`（约 `:469–486`）。
- Keyframes 与规则：`wt-check-pop`、`wt-mark-draw`、`wt-row-celebrate`、`wt-title-settle`（约 `:503–568`）。
- `@media (prefers-reduced-motion: reduce)` 同时关掉行、勾选框、对勾、标题四条动画（`:643` 附近）。

只动 `transform / background / color / opacity`，没有改宽高、margin、padding、字体，**零布局跳动**。

---

## 2. 为什么这样更「从容、有层次、克制」

1. **去掉过冲，观感不再廉价。**
   旧的 `cubic-bezier(.34,1.56,.64,1)` 会让勾选框先冲过 1 再回弹，短时长下像「叮」一下。新的柔和曲线 + 1.06 的轻微呼吸只有「起身—回落」两拍，不抢注意力。

2. **三段有明确先后，而不是同时迸发。**
   勾选框先起（0–620ms），对勾在 140ms 后才开始「写」（140–660ms），整行和标题在 80ms 后缓慢铺开（80–1230ms / 80–640ms）。眼睛先看到「勾上了」，再看到「对勾被画出来」，最后看到「这一行安静地落定」——层次来自时间差，不是幅度。

3. **时长拉到 1.2s，但每一段都收得住。**
   旧版 560ms 总长在 60Hz 屏上只有 ~34 帧，去掉延迟几乎看不出过程；新版主段 1150ms 让背景色有 3 个中间色阶（26% → 16% → 6% → 0），是「缓慢退场」而不是「开关灯」。标题单独用 560ms 变灰，避免整行一起变灰造成的「整体闪一下」。

4. **刷新不再截断动画。**
   旧实现的根因是写成功后的 `finally` 立刻 `refresh()`：新数据一到，行被重新归组，动画当场消失。现在动画播完才「落位」，观感从「被打断」变成「完成后归位」。

---

## 3. 刷新时机的实现与清理

数据流：

1. `TodoRow.handleCheck` 判断这次是否会播动效（`canCelebrate = !done && celebrate !== false && !prefersReducedMotion()`），把决定随写操作一起上报：
   `onToggle(row.id, { celebrate: canCelebrate })`（`src/client/index.js:1507`）。
2. 面板 `handleToggle` 只在 `options.celebrate === true` 时给 `runWrite` 传 `{ deferRefreshMs: CELEBRATE_REFRESH_MS }`（`:2446–2449`）。
3. `runWrite` 的 `finally`：
   - 成功且要求延迟 → `celebrationRefresh.schedule(deferMs)`，**不 refresh**；
   - 失败 / 未要求延迟 → `celebrationRefresh.cancel()` 后立刻 `refresh()`。
4. `createCelebrationRefresh(refresh)`（`:970`）只持有一个 `setTimeout` 句柄：
   - `schedule()` 先取消上一个再排新的（连续完成由最后一次接管，不会补两次刷新）；
   - `cancel()` 幂等，卸载、连续点击、写失败、取消完成都会走到；
   - 回调里先置空句柄再 `refresh()`；Node 下 `unref()`，浏览器返回 number 时安全跳过。
5. 面板用 `useMemo` 持有实例，并用一条 effect 的清理函数在卸载时 `cancel()`（`:2259`）。
6. 行的 `onAnimationEnd` 仍然只认 `event.target === event.currentTarget` 且 `animationName === 'wt-row-celebrate'`（`src/client/index.js:1710` 附近）；标题/勾选框/描边的 `animationend` 冒泡上来不会提前摘掉行高亮。

没有 JS 逐帧动画：JS 只负责「挂类 / 摘类 / 排一个刷新定时器」，所有插值都在 CSS 里。

---

## 4. 测试与反向验证

### 新增用例（`tools/smoke-client.mjs`，测试文件仍为 9 个）

- 节拍常量（`:2270`）：从 `STYLE_TEXT` 正则解析三段 `animation`，钉住勾选框 **600–700ms**、对勾 **480–560ms 且 delay > 0**、整行 **1000–1300ms**，并校验缓动不含 `1.56` 过冲、缩放不含 `1.32`、标题落到 `label-tertiary`。
- 刷新被延后（`:2317`）：用假 `setTimeout` 记录定时器；完成写入后断言「动画结束前 tick 刷新 0 次、定时器仍挂着、时长 = `CELEBRATE_REFRESH_MS`」，手动推进定时器后断言「恰好刷新 1 次」。
- reduced-motion / `celebrate:false`（`:2355`）：两种情况都断言不排定时器、写完立即刷新 1 次。
- 连续点击（`:2406`）：第一次完成排的定时器，在第二次「取消完成」时被 `clearTimeout`，且立即刷新。
- 写失败（`:2436`）：不残留定时器、立即刷新、动效类被摘掉。
- 卸载（`:2473`）：跑一遍 effect 清理函数后，待刷新定时器被清掉。

测试替身还补了两处基础设施：`stateUpdates` 记录 `{slot, next}`（用于识别「刷新 tick」槽位），以及 `installFakeTimers` / `withStableHooksAsync`。

### 全量结果

```text
cd ~/Documents/deepseek-harness/default-workspace/dsh-worktodo
export WORKTODO_NO_UPDATE_CHECK=1
~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node tools/verify-all.mjs
→ 10/10 个步骤通过（含构建）
```

`smoke-client` 本身：**61 通过，0 失败**。

### 反向验证（在 `/tmp/wt-reverse` 副本里做，不改工作区）

1. 把 `CHECK_POP_MS` 改回 **320** 并重新构建：
   ```text
   ✗ 完成动效节拍：勾选框 600–700ms、对勾 480–560ms 且 delay>0、整行 1000–1300ms
   60 通过，1 失败（exit 1）
   ```
2. 把 `handleToggle` 改回忽略 `options`、立即刷新并重新构建：
   ```text
   ✗ 刷新被延后：完成动效播完前不刷新，假定时器推进后恰好刷新一次
   ✗ 连续点击：第二次点击取消上一段待刷新，并立即刷新
   ✗ 卸载：待刷新定时器会被清理（不留悬空回调）
   58 通过，3 失败（exit 1）
   ```

两条反向验证都精确命中预期用例，说明新断言不是「永绿」。

---

## 5. 未做 / 不确定

- **没有在真实浏览器里做肉眼验收。** 本轮只跑了无头烟测；`620 / 520 / 1150 / 560ms` 是按要求区间定的，实际手感仍建议在 DSH Web GUI 里勾几条真实待办确认（尤其暗色主题下的 `ok` 色淡底强度）。
- **`background` 是重绘属性，不是合成器专属属性。** 它不改布局（满足「零布局跳动」），但会在动画期间触发 paint；单行面积很小，实测无性能压力，未做 GPU 层观测。
- **其他刷新路径没有加闸。** 30s 轮询、窗口重新聚焦/可见触发的 `refresh()` 仍可能在 1.26s 窗口内发生并提前归组；概率很低，本轮没有把它们也推迟（避免把「外部改动的新鲜度」拖慢）。如果以后想 100% 锁死，可以在这些入口也检查 `celebrationRefresh.isPending()`。
- **同一条完成动画进行中又去写别的行**时，后一次写操作会取消前一次的待刷新并按自己的路径刷新，可能提前结束前一行动画；这是本轮有意保留的「新鲜度优先」取舍，未做串行队列。
- `CELEBRATE_REFRESH_MS` 取 **1260ms**（总时长 1230 + 30ms 余量），略高于任务里举例的 ~1200ms；理由是宁晚 30ms 也不切最后一帧。
- 未改版本号 / CHANGELOG / `.github`，未 commit / push / tag / 发布；`lib/client.js` 与 sourcemap 只是 `verify-all` 的构建产物。
