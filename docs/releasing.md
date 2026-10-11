# 以后怎么发版（dsh-worktodo）

> 结论先行：**以后不需要任何"人类验证码"。** 若账号的 2FA 是 WebAuthn 型（passkey / 安全密钥），它不产生 OTP，
> 命令行也无法完成 WebAuthn——此时**命令行手动发版这条路走不通**，但**自动化路线完全畅通**：
> 发版交给 GitHub Actions，走 npm 的 Trusted Publishing（OIDC），人类只在需要把关时在浏览器里完成一次 2FA。

## 两条路线（一次性绑定之后，二选一或随时切换）

| | 路线 A：全自动 | 路线 B：人类把关（npm 推荐） |
|---|---|---|
| CI 做什么 | `npm publish` 直接上线 | `npm stage publish` **提交到暂存区** |
| 你要做什么 | **什么都不用做** | 打开 npmjs.com → **Staged Packages** → Approve → 在浏览器里完成 2FA |
| 人类动作 | 0 | **1 次点击 / 版本** |
| 适合 | 小版本、修复 | 想要"发布前有人点头"的纪律 |

两条路的差异**只在绑定时勾的权限**（见下）。npm 官方现在明确推荐路线 B，并建议
**只允许 `npm stage publish`、禁止 `npm publish`**。

## 一次性设置（做一次，之后长期有效）

### 1. GitHub 仓库就位

仓库 `olimc2016/dsh-worktodo` 必须是 Public，且包含 `.github/workflows/publish.yml`。
推 tag 时 CI 触发，用仓库身份向 npm 换取一张**短时 OIDC token**（无需任何 secret）。

### 2. 绑定 Trusted Publisher（浏览器里完成 2FA 确认）

<https://www.npmjs.com/package/dsh-worktodo/access> → **Trusted Publisher** → **GitHub Actions**

| 字段 | 值 |
|---|---|
| Organization or user | `olimc2016` |
| Repository | `dsh-worktodo` |
| Workflow filename | `publish.yml` |
| Environment | 留空 |

若绑定页（或 `npm trust` CLI）让你选**允许的动作**：

- 想走**路线 B** → 只开 **`--allow-stage-publish`**（并关掉 `--allow-publish`）
- 想走**路线 A** → 开 **`--allow-publish`**

> npm 现在会提示「未验证的 trusted publishing 配置会过期」，绑完尽快用一次。

### 3. 清理不再需要的凭据（npm 官方最佳实践）

npm 在 `npm stage` 文档里明确建议：**删除所有 bypass-2FA 的 granular token**，改用
trust relationship（OIDC）或"不带 bypass 的 GAT + stage publish"。所以：
到 <https://www.npmjs.com/settings/&lt;你的账号&gt;/tokens> 把发布首版时用的那个 7 天 token **revoke** 掉。
（本机那两处凭据副本已删除。）

另外建议在包的 access 页把发布策略设为
**"Require two-factor authentication and disallow tokens"**——这是 npm 明写的推荐项。

## 每次发版（绑定之后）

```bash
cd <本仓库目录>

# 1) 改版本号 + 写 CHANGELOG（0.1.1 → …）
# 2) 提交
git add -A && git commit -m "release: v0.1.1"
# 3) 打 tag 并推送 → CI 自动跑测试、构建、提交
git tag v0.1.1 && git push origin main --tags
```

- **路线 A**：CI 跑完即上线，收工。
- **路线 B**：CI 跑完，版本进入暂存区 → 你打开 <https://www.npmjs.com> →
  **Staged Packages** → 找到 `dsh-worktodo@0.1.1` → **Approve** → 完成 2FA → 上线。

CI 的三个门（都会在日志里体现）：`pnpm install --frozen-lockfile` → `pnpm test`（161 例）→ `pnpm run build`。

## ⚠️ 发布方式会影响 **npm 页面上的 README**

实测（第二十二轮，用维护者另一个包做对照）：**暂存发布不会把 README 写进 registry 的 `readme` 字段**，
于是**包页面会没有 README**；普通 `npm publish` 则正常写入（对照组的 `readme` 有 8193 字符，本包 0 字符，
而 tarball 里 README 是齐的）。所以：

- **想要 README 出现在包页面上 → 走路线 A（直接发布）**；绑定 Trusted Publisher 时就要允许 `npm publish`；
- 每次发布后核对一次：

```bash
curl -s https://registry.npmjs.org/dsh-worktodo \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('readme:', len(d.get('readme') or ''), '字符')"
```

- 若发现为 0：用直接发布补一版（版本号要 +1，npm 不允许覆盖已发布的版本号）。

**Q：CI 里发布报 `404 … is not in this registry`？**
几乎一定是 **Trusted Publisher 没生效**。核对 <https://www.npmjs.com/package/<包名>/access>：
Provider=GitHub Actions、owner、repository、**Workflow filename 必须与文件名逐字一致（`publish.yml`）**、
Environment 留空，并且**允许的动作必须包含 `npm publish`**（只开 `stage publish` 时直接发布会以这个 404 被拒）。
注意：**provenance 签名成功不代表认证成功**——provenance 走的是 GitHub 的 OIDC，与 npm 的绑定是两件事。

## 常见问题（都是这次踩过的）

**Q：为什么没有验证码可收？**
WebAuthn 型 2FA（passkey / 安全密钥）不产生 OTP——它的验证方式是**在浏览器里完成一次设备确认**。
命令行无法完成 WebAuthn，所以**不要在命令行手动 `login` / `publish`**（会失败），一切交给 CI + 浏览器。

**Q：如果我就是想命令行手动发一版？**
需要给账号**再加一种** 2FA 方式：Settings → Two-Factor Authentication → 添加
**Authenticator app（TOTP）**（不是替换原有方式，是**再加一种**）。有了 6 位码之后，
`pnpm login`（Enter OTP）与 `pnpm publish --otp=<码>` 才可用。
注意：添加这种方式的**操作本身**也需要一次 2FA 确认 → 在能完成 WebAuthn 的浏览器里做。

**Q：`0.0.0-stage` 那个版本是什么？**
首版走暂存发布时 npm 自动建的**占位版本**（用来占住包名，内容不含真实代码）。无害；
想清理可在 npm 的版本管理里删掉它。

**Q：为什么首版是"暂存"而不是直接发布？**
实测：那次用的 bypass token 只能完成**暂存**（`npm stage publish` 永不要求 2FA，
而 `npm publish` 需要"存在性证明"）。npm 的方向就是如此：**自动流程负责暂存，人类负责批准。**

**Q：CI 的发布路径验证过吗？**
**没有。** 本地只验证到 install / build / test / pack；`publish.yml` 需要一次真实的 tag 发布
才算验证过。第一次跑请留意日志——绑定字段写错会以明确的报错出现（对照上面表格逐字检查）。

## 出处（本文件的依据）

- `npm stage` 命令与「各子命令的 2FA 要求」「各 token 类型的 stage/publish 行为」表格：
  <https://docs.npmjs.com/cli/v11/commands/npm-stage>
- 暂存发布的概念、占位版本、网页端批准：
  <https://docs.npmjs.com/staged-publishing>
- Trusted Publishing（OIDC）：<https://docs.npmjs.com/trusted-publishers>
- bypass-2FA token 的收紧时间表：GitHub Changelog 2026-07-31 与 2026-10-02
