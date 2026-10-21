# Work Todo · dsh-worktodo


**A work todo list that belongs to you, not to a session.** A dedicated DSH sidebar panel, plus `worktodo_*` tools so the agent reads and writes **the same** list you do.

> Works with **DSH 0.2.x** (tested on 0.2.0-rc.2) · **no runtime npm dependencies**; the 3 official platform packages are optional peers supplied by DSH · community plugin, unofficial

> **About the paths in this file**: references to `docs/`, `tools/` and similar point into the **repository** —
> those files are not part of the npm package. Repository: <https://github.com/olimc2016/dsh-worktodo>

## The gap it fills

DSH ships `todo_write`: the plan of **one agent session**. It replaces the whole list every call, has only `pending / in_progress / completed`, and — quoting the official docs — "the list belongs to the one agent session that created it… there is no way to share a list across agents". No priority, no due date, no project, no per-item edit. Close the session and the plan is gone.

So the things that actually need to survive — waiting on a reply, waiting on review, shipping next week — have nowhere to live.

**This list is for the human.** Priorities, due dates, projects, notes. It persists across sessions and projects. The agent can read and write it, but the source of truth is yours.

| | official `todo_write` | **dsh-worktodo** |
|---|---|---|
| Owned by | one agent session | **you** (cross-session, cross-project) |
| Update | whole-list replacement | **per-item create / edit / delete** |
| Fields | content + 3 states | content + **priority + due date + project + notes** |
| Shared across agents | ❌ not supported | ✅ one list, human and agent both read/write |
| Views | in-session checklist | **overdue / today / this week / later / done** + stats |
| Storage | session event log | `$DSH_HOME/storages` (official storage) or `~/.dsh/worktodo/todos.json` |

The two are complementary: `worktodo_adopt` promotes the entries worth keeping from this session's `todo_write` into your work list.

## Install

**Option 1: straight from GitHub** (no npm package needed; restart DSH afterwards)

```bash
dsh plugin --profile desktop add github:olimc2016/dsh-worktodo
```

This path is verified (see `docs/verification.md`): the browser half's build output `lib/client.js` is committed,
and the package declares no `prepare`/`install` build script, so a git install needs **no build authorization**.
Measured (installed from GitHub): **1 top-level package** (this plugin only). The 3 official platform packages are
supplied by the DSH installation, so no second copy is installed into the profile and no development dependencies
are pulled in; there is no nested `node_modules`, and the installed tree matches the npm tarball file for file.

> **Why the platform packages are optional peers, not `dependencies`**: with peer-only declarations, DSH before
> 0.2.1 had no installation interception layer, so an installed plugin could not resolve them and failed to load
> entirely; 0.1.1 switched them to `dependencies`. Since 0.2.1 the host provides those packages, and carrying a
> copy installs a **second** one into the profile that mixes with the host's version (the 2026-10-17 desktop
> "required plugin did not activate" failure). 0.2.7 moves them back to optional peers: they resolve from the DSH
> installation, and if one is genuinely missing the plugin degrades to panel-only instead of dragging the host
> down (all three are loaded through guarded dynamic imports inside functions).

**Option 2: from npm** (once the package is published)

```bash
dsh plugin --profile desktop add dsh-worktodo
```

**Option 3**: use the DSH sidebar — **Plugins → Add plugin** — and enter `dsh-worktodo` or the repository URL.

## Updating

The panel checks for new versions. DSH does not let plugins install packages or restart DSH by themselves,
so when an automatic update fails the update badge gets a **Manual update** button that expands copyable commands.
You can also run them yourself:

```bash
# 1) remove the old version
dsh plugin --profile desktop remove dsh-worktodo
# 2) install the latest version (the one dist-tags.latest points to on npm)
dsh plugin --profile desktop add dsh-worktodo@latest
```

Then **fully quit DSH and reopen it** (⌘Q / Quit menu — closing the window is not enough).

- Don't know the profile name? `dsh plugin --list` prints it; replace `--profile desktop` in the commands.
- Installed from GitHub instead? Replace step 2 with
  `dsh plugin --profile desktop add github:olimc2016/dsh-worktodo`.
- Dev mode (the profile uses `link:` to a local checkout): don't reinstall from the profile — run
  `git pull && pnpm install && pnpm run build` inside the plugin repo, then restart DSH.
- Verify the version afterwards: the panel footer shows `version vX.Y.Z`, or run
  `dsh plugin --profile desktop list`.

> The commands in **Manual update** contain only the profile name (no local paths). If one fails,
> paste its output into [issues](https://github.com/olimc2016/dsh-worktodo/issues).

## Usage

**Panel**: stats on top (open / overdue / today / in progress / completed today), a quick-add box (title + due date + priority, Enter to save), then the grouped list. Each row can be checked off, edited inline by clicking the title, or deleted (with a second-click confirmation).

**Agent tools**: the model can file, query, advance and archive your work todos without you relaying anything.

| Tool | Purpose |
|---|---|
| `worktodo_add` | File a task (optional due date, priority, project, notes) |
| `worktodo_list` | List with `open` / `today` / `overdue` / `week` / `doing` / `completed` / `all`, filterable by project or keyword |
| `worktodo_update` | Edit one item without touching the rest |
| `worktodo_done` | Mark done, or back to in-progress / pending |
| `worktodo_remove` | Delete (use `worktodo_done` to keep the record instead) |
| `worktodo_adopt` | Promote this session's `todo_write` entries, de-duplicated by title |

One sentence is enough:

> "File the three things I need to follow up today into my work todos, and mark tomorrow morning's as high priority."

## Where the data lives

Chosen automatically; the actual location is reported by `/worktodo/health` and shown at the bottom of the panel:

1. **Official storage** (`ctx.storageDomain`, mounted by DSH by default) — data lands in `$DSH_HOME/storages`. This is the documented place for plugin-owned state that must survive restarts without becoming session events; a few dozen todos do not belong in the session history.
2. **JSON file fallback** — `$DSH_HOME/worktodo/todos.json`, used automatically in minimal compositions without the storage service. That file is meant to be opened, hand-edited and committed to git; a corrupted file is never silently wiped, and a single bad record is skipped rather than losing the list.

Pin your own path in `cordis.patch.yml`:

```yaml
- id: worktodo
  name: 'dsh-worktodo'
  config:
    storePath: /Users/me/notes/worktodo.json
```

**The legacy file is retired after a successful upgrade**: once the data has been merged into official storage,
`$DSH_HOME/worktodo/todos.json` is renamed to `todos.json.migrated-<time>` (a full archive you can inspect or
restore), and a `todos.json.retired` marker is left next to it. After that official storage is the single source
of truth: if a composition has no `storageDomain`, the panel reports an explicit error instead of showing an
empty list, and the footer spells out "official storage unavailable · legacy file retired".

## Compatibility

- **DSH 0.2.x** (tested against 0.2.0-rc.2 APIs; DSH's version gate rejects plugins pinned to older lines)
- **Node ≥ 22.19.0**
- No runtime npm dependencies. Platform packages (`@deepseek-ai/dsh-tools`, `dsh-storage-domain`, `dsh-home-paths`) are **optional peers** resolved from the DSH installation; if one genuinely cannot be resolved the plugin degrades to panel-only instead of failing to load, and logs the reason.

## Development

```bash
pnpm install            # esbuild ships a prebuilt binary; no approve-builds needed
pnpm run build          # build lib/client.js (browser half)
pnpm test               # 175 cases: data model / storage / service / host wiring and tools / client contract / client bundle / CI contract / privacy gate / catalog gate
pnpm run watch          # incremental client build
```

Release flow (trusted publishing + staged approval) is documented in `docs/releasing.md`:

```bash
```

No DSH instance is needed to run the suite: `verify-records` (pure data), `verify-store` (real file IO plus a genuine **official `defineDomain` contract check**), `verify-service` (explicit statuses and boundaries), `smoke-host` (apply → routes → service → storage in a fake context, plus tool registration and execution with schemas validated by the **official `defineTool`**), `smoke-contract` (extracts the paths and field names the client actually sends and checks them against the host's real routes — catching silent failures where a mistyped field means, for instance, that due dates never save), `smoke-client` (bundle format, slot registration, and a first render that must not throw), and `verify-submission` (a local gate for the catalog PR: fields, filename, category and date, plus checks that only matter on the GitHub distribution path, such as whether every file a git install needs is actually tracked).

## License

MIT © 2026 oli20
