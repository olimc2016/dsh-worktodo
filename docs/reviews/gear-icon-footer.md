# 更新设置入口：太阳图标 → 齿轮，顶部 → 页脚版本号旁

- 仓库：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo`
- 版本：0.2.9（本轮**不升版本**、不改 CHANGELOG / `.github` / `lib/index.js`，不 commit / push / tag / 发布）
- 日期：2026-10-19
- 代码：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/src/client/index.js`
- 测试：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/tools/smoke-client.mjs`
- 构建产物：`~/Documents/deepseek-harness/default-workspace/dsh-worktodo/lib/client.js` 与
  `.map` 由 `tools/build-client.mjs` 重新生成；测试套件仍是 **9 个**（没有新增测试文件）。

## 1. 改了什么

### 1.1 图标：放射线「太阳」→ 真正的齿轮

原来的 `IconSettings` 是「一个圆 + 8 条从圆心向外的放射线」（16×16、stroke 1.3），
视觉上就是太阳。现在换成**齿圈轮廓 + 中心圆孔**：

- `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor"
  stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
- `<path>` 画齿圈：**8 个均匀的梯形齿**。每个齿由两条直边（齿侧）+ 一段齿顶外弧组成，
  齿与齿之间用一段齿根内弧连接：
  - 齿顶外弧半径 `R = 6.05`，齿根内弧半径 `r = 4.65`；
  - 每个齿占 `360° / 8 = 45°`，齿顶半角 `8.6°`、齿根半角 `11.2°`；
  - 坐标全部四舍五入到两位小数，逐齿写开（8 段 `A6.05 6.05` 外弧 + 8 段 `A4.65 4.65` 内弧）。
- `<circle cx="7" cy="7" r="1.7">` 是**中心圆孔**。
- 图形几何范围：`1.02 … 12.98`，加 stroke 半宽 `0.75` 后为 `0.27 … 13.73`，完整落在 14×14 内，
  不会在 14px 尺寸下被裁边。
- **没有**任何文字字形（不用 `☀` / `⚙`），跨平台渲染一致；也没有 `innerHTML`、没有新依赖。

### 1.2 位置：顶部 → 页脚、版本号右侧

- 顶部 `.wt-head` 里的 `settingsNode` 已移除；顶部只剩标题、统计、排序、视图、刷新。
- 页脚最后一块 `.wt-foot` 里，版本行改为 `.wt-ver-row`：
  - 版本号 `span` 后**紧挨**齿轮（同一行、直接兄弟、齿轮在右）；
  - `gap: 6px`（要求 6–8px）、`align-items: center`（垂直居中）；
  - 齿轮按钮沿用 `.wt-icon-btn` 的 muted 色（`C.label3`），hover 变亮到 `C.label`；
  - 按钮 20×20，图标 14×14（页脚小字行不撑高）。
- `.wt-foot` 是 `.wt-root` 的最后一个直接子区域，所以入口视觉上贴面板底部。

### 1.3 浮层：向下弹 → 向上弹

- `.wt-ver-row { position: relative; }` 作为定位基准；
  `.wt-settings-pop { position:absolute; bottom: calc(100% + 6px); left: 0; right: auto;
  width: 268px; max-width: 100%; }`。
- 浮层挂在齿轮容器内、**从版本行向上展开**，因此贴底时不会越出面板底部；`left: 0`
  对齐页脚行左缘，窄面板用 `max-width: 100%` 收缩，不会横向溢出。
- 交互保持不变并补齐了两处可达性：
  - 点齿轮开/关；Escape 关闭 —— `keydown` 挂在入口容器 `.wt-settings-wrap` 上，
    焦点还在齿轮（而不是浮层里）时也能收到 Escape；
  - 点击外部关闭 —— 浮层打开时才在 `document` 上挂 `mousedown`，命中入口容器
    （`wrap.contains(event.target)`）则忽略，关闭/卸载时立即移除；
  - 三档仍是 `role="radio"` + 正确 `aria-checked`，`radiogroup`、`role="dialog"`、
    中英 `aria-label` / `title`（「更新设置」/「Update settings」）不变；
  - 没有新增动效；`prefers-reduced-motion` 下没有需要额外关闭的动画；深浅色都只用主题变量
    （`C.label3` / `C.label` / `C.layer1` / `C.border`），没有颜色字面量。

## 2. 结构描述（无法提供截图，按 DOM/布局描述）

```
.wt-root                              (height:100%; overflow:auto)
├─ <style>                            (STYLE_TEXT)
├─ [.wt-restart-banner]               (仅 restartRequired)
├─ .wt-head                           (标题 / 统计 chips / 排序 / 视图 / 刷新 —— 没有齿轮)
├─ [错误条]
├─ [.wt-plus 快速添加]
├─ [.wt-adopt 会话待办]
├─ [分组列表 / 空态]
└─ .wt-foot                           (最后一个直接子区域 = 页面底部)
   └─ .wt-ver-row                     (position:relative; display:flex; gap:6px; align-items:center)
      ├─ <span> 版本 versionLabel v0.2.9   (title=versionHint)
      ├─ <span.wt-settings-wrap>       (onKeyDown=Escape)
      │  ├─ <button.wt-icon-btn.wt-settings-btn
      │  │          title=更新设置 aria-label=更新设置
      │  │          aria-haspopup=dialog aria-expanded=…>
      │  │  └─ <svg 14×14 fill=none stroke=currentColor stroke-width=1.5 aria-hidden=true>
      │  │     ├─ <path d=8 个梯形齿的闭合轮廓>
      │  │     └─ <circle cx=7 cy=7 r=1.7>            (中心圆孔)
      │  └─ [.wt-settings-pop role=dialog]             (position:absolute;
      │        ├─ 标题 / 说明                            bottom:calc(100% + 6px);
      │        ├─ .wt-settings-group role=radiogroup     left:0；向上弹)
      │        │  └─ 3 × <button role=radio aria-checked>  (禁用/仅提示/自动)
      │        └─ .wt-settings-foot (当前版本 + 检查更新)
      └─ [.wt-chip.wt-update 更新徽标/状态]              (版本号 + 齿轮之后)
```

- 视觉上：齿轮就在 `v0.2.9` 右边约 6px，和版本号同一行、垂直居中；浮层打开时从这一行
  **向上**覆盖页脚上方的列表区域，面板底部不会被浮层顶出去。
- 为了确认齿轮不是「看起来像太阳」，用同样的 path 单独渲染过一张 280×280 的预览图
  （临时文件，未入库）：8 个梯形齿均匀、中心孔清晰、齿间缺口对称，没有放射线。

## 3. 测试（全部加进现有 client 套件，9 个套件不变）

`tools/smoke-client.mjs` 从 **67 通过** 变为 **69 通过 / 0 失败**，新增 3 条、改写 1 条：

1. **入口在底部、不在顶部**
   - 找到 `.wt-head` 与 `.wt-foot`：顶部子树里**没有** `.wt-settings-btn`；
   - `.wt-foot` 是 `.wt-root` 的最后一个直接子区域（反向：挪回顶部 → 红）；
   - 版本行 `.wt-ver-row` 的直接子节点里，版本号 `span` 后**紧邻**齿轮（`gearIndex === versionIndex + 1`）；
   - 从样式表原文解析 `.wt-ver-row` 的 `gap` ∈ [6, 8] 且 `align-items: center`；
   - 齿轮的 className 含 `wt-icon-btn`（muted + hover 变亮）。
2. **图标是 SVG 齿轮、不是文字符号**
   - `<svg>` 存在，`width/height = 14`、`viewBox = 0 0 14 14`、`fill=none`、
     `stroke=currentColor`、`stroke-width` ∈ [1.4, 1.6]、`aria-hidden=true`；
   - `<path>` 里有 6–8 段齿顶外弧（测试实际断言 8 段 `A6.05 6.05`）且内弧数量一致；
   - `<circle>` 存在且 `r > 0`（中心孔）；
   - 按钮子树里没有任何文字节点，也不含 `☀` / `☼` / `⚙`（反向：换回字形 → 红）。
3. **交互**
   - 从页脚齿轮点开：`role=dialog` 挂在 `.wt-settings-wrap` 内；
   - 三档 `role=radio`、当前 `manual` 的 `aria-checked = [false,true,false]`、原生 `button`；
   - Escape（调用入口容器上的 handler，模拟焦点仍在齿轮）关闭；
   - 重新打开后触发 `document` 的 `mousedown`（模拟点外部）关闭；
   - 选 `off` 后 `aria-checked = [true,false,false]`，且「检查更新」按钮 `disabled=true`
     并带 `updateCheckDisabledOff` 的 title；
   - 样式断言：`.wt-settings-pop` 有 `bottom:`、没有 `top:`（向上弹）；浮层无 `innerHTML`。
4. 既有用例「头部齿轮 → 浮层三档…」已改写为页脚版本；另外补了 `directChildren()` 测试助手，
   用来准确判断「版本号 + 齿轮是不是同一行的相邻兄弟」（stub 的 `createElement` 会把数组
   children 多包一层）。

## 4. 反向验证（故意改坏 → 变红 → 恢复 → 变绿）

源码先备份到 `/tmp/wt-src-green.js`、产物备份到 `/tmp/wt-lib-green.js`；每次改坏都重新
`build-client.mjs` 后跑 `smoke-client.mjs`，并**显式检查退出码**。

| 故意改坏 | 结果 | 关键报错 |
| --- | --- | --- |
| 把 `settingsNode` 从页脚移回 `.wt-head`（原顶部位置） | build EXIT=0；smoke-client **EXIT=1**，68 通过 / 1 失败 | `更新设置入口在页脚版本号右侧…: 顶部不能再放更新设置入口：期望 false，实际 true` |
| 把 `IconSettings` 换成文字符号 `<span>☀</span>` | build EXIT=0；smoke-client **EXIT=1**，68 通过 / 1 失败 | `更新设置图标是 SVG 齿轮…: 图标必须是 <svg>（改用文字符号这条必须红）：期望 true，实际 false` |
| 两处均恢复 | build EXIT=0；smoke-client **EXIT=0**，69 通过 / 0 失败 | 恢复后的 `lib/client.js` sha256 = `d267a3ee…67a7c5`，与破坏前绿态产物一致 |

## 5. 两套门禁（均显式检查退出码）

```bash
# 本机
export WORKTODO_NO_UPDATE_CHECK=1
export PATH=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:$PATH
node tools/verify-all.mjs
# EXIT=0，10/10 个步骤通过（含构建）
```

```bash
# 干净环境（不带 WORKTODO_* / DSH_*，CI=true）
env -i HOME=/tmp/cihome \
  PATH=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin:/usr/bin:/bin \
  CI=true node tools/verify-all.mjs
# EXIT=0，10/10 个步骤通过（含构建）
```

两次最终运行的关键汇总：`smoke-client` 69 通过 / 0 失败，`smoke-host` 106 通过，
`verify-privacy` 18 通过，`verify-workflows` 11 通过，总表 10/10。

## 6. 未做 / 不确定

- **没有在真实 DSH 页面里截图或点真实面板**：按约束不碰真实 profile/数据；结构、样式与交互
  由 `smoke-client` 的真渲染（迷你 React + 样式表原文解析）+ 单独渲染的 SVG 预览覆盖。
- **齿轮按钮 20×20、图标 14×14**：比原来的 24×24 图标按钮略小，是为了跟 10.5px 的页脚版本行
  协调；如果实际点击觉得偏小，可只调 `.wt-settings-btn` 的宽高，不影响图标几何与测试。
- **浮层宽度固定 268px（max-width:100%）**：极窄面板会收缩到页脚行宽度；没有为更窄的侧栏
  单独做两行布局。
- **点外部关闭用 `mousedown`**：在浮层内部按下不会关，点在面板其他位置会关；如果宿主外壳
  在捕获阶段阻止了 document 上的 mousedown，这条路径需要真机再确认（当前测试直接调用监听器）。
- 本轮**未升版本**（仍是 0.2.9）、未改 CHANGELOG / `.github` / `lib/index.js`、
  未 commit / push / tag / 发布；只改了 `src/client/index.js`、`tools/smoke-client.mjs`
  以及 `build-client.mjs` 重新生成的 `lib/client.js` / `.map`。
