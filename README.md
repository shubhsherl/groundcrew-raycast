# Groundcrew for Raycast

Browse Groundcrew tasks and check Groundcrew status without leaving Raycast.

> [!IMPORTANT]
> This extension requires the Groundcrew CLI to be installed and configured on your Mac. The extension does not store
> provider credentials; it uses the CLI's existing local configuration.

## Prerequisites

- macOS with [Raycast](https://www.raycast.com/) installed
- Groundcrew CLI `4.50.3` or newer, installed and configured by the user
- The `crew` executable discoverable as described below, or its absolute path entered in the extension preference

## Commands

- **Browse Groundcrew Tasks** — searches and filters canonical tasks from every configured Groundcrew source, with
  on-demand task details and links
- **Groundcrew Status** — shows active and preserved workspaces, missing worktrees, queue and slot health, and degraded
  local or remote probes

Task browsing reads through `crew task list --json` and `crew task get <task> --json`. Groundcrew remains responsible
for source configuration and canonical task fields; the extension does not contact providers directly.

Status always loads the complete legacy `crew status --json` `{ local, remote }` inventory and filters task detail in
the extension. It never invokes task-scoped status JSON. Local capture, remote attempt, and retained remote payload
timestamps are shown separately because they can differ. When a remote attempt fails, an older payload can remain and
is labeled as potentially stale. An empty pull-request result is treated as unknown because the legacy response cannot
distinguish “no pull request” from a failed GitHub lookup; the extension creates PR actions only for supplied URLs.

## Configuration

The optional **Groundcrew Executable Path** preference accepts an absolute path such as
`/opt/homebrew/bin/crew`. When it is empty, the extension searches executable files named `crew` in this order:

1. Raycast's process `PATH`.
2. `/opt/homebrew/bin/crew`, then `/usr/local/bin/crew`.
3. Installed Node-version bins under `$NVM_DIR/versions/node` (or `~/.nvm/versions/node`), newest version first.

The extension invokes that executable directly with an argument array. It does not use a shell, read Groundcrew config
files, or handle provider credentials.

## Environment / Troubleshooting

Raycast spawns `crew` with a stripped environment: `PATH` is the bare
`/usr/bin:/bin:/usr/sbin:/sbin` and no shell-exported variables are present. On
node-version-manager (fnm, nvm, asdf) setups this produces three common failures:

| Symptom | Root cause |
|---|---|
| `env: node: No such file or directory` | `crew` is a Node script (`#!/usr/bin/env node`); Raycast's `PATH` has no `node`. Homebrew installs to `/opt/homebrew/bin` (usually visible); nvm/fnm installs are not. |
| Browse fails with "Linear API key not set"; Status works | `crew task list` needs `GROUNDCREW_LINEAR_API_KEY` (or `LINEAR_API_KEY`), which is typically shell-exported from `~/.secrets` or `.zshrc`. Status reads local files only, masking the gap. |
| Cleanup fails with `Lifecycle: Idle · Session: Unknown` | `crew`'s workspace probe requires `cmux`/`tmux` (and `gh`/`git`) on `PATH`; Raycast strips them, so cleanup can't reconcile session state. |

**Which commands need which environment:**

- **Groundcrew Status** — reads local snapshot files only; works without credentials or session tools.
- **Browse Groundcrew Tasks / Start Groundcrew Task / lifecycle actions** — require the provider API key and session backend (`cmux`/`tmux`, `gh`, `git`) on `PATH`.

**Accepted API key variable names:** `GROUNDCREW_LINEAR_API_KEY` (preferred) or `LINEAR_API_KEY`.

### Fix: point the Executable Path preference at a shim

Create a wrapper script that sources your secrets and extends `PATH`, then point the
**Groundcrew Executable Path** preference at it (or place it at `/opt/homebrew/bin/crew` for
auto-discovery).

```sh
#!/bin/sh
[ -f "$HOME/.secrets" ] && . "$HOME/.secrets"
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec "/absolute/path/to/node" "/absolute/path/to/@clipboard-health/groundcrew/bin/run.js" "$@"
```

Replace the two `exec` paths with the output of `which node` and `npm root -g`/`crew --version`
locate the installed script. Mark the shim executable (`chmod +x <shim>`).

> **Note:** Homebrew installs (`brew install clipboard-health/tap/groundcrew`) usually work
> out of the box because `/opt/homebrew/bin` is on Raycast's default `PATH`. Node-version-manager
> installs will not; the shim above is the recommended fix.

**Maintainer note — cleaner long-term alternatives:**

- Import the login-shell environment at extension startup using [`shell-env`](https://github.com/sindresorhus/shell-env) or [`fix-path`](https://github.com/sindresorhus/fix-path).
- Spawn `crew` via Raycast's bundled `process.execPath` (Node) to sidestep the `env node` shebang entirely.

## Development

```sh
npm install
npm run dev
```

Run `npm run build` to produce and validate a distribution build.

## Project Structure

- `src/cli` — Groundcrew CLI client and process boundary
- `src/types` — shared domain types
- `src/components` — reusable Raycast UI components
- `src/__tests__` — focused tests for shared and command behavior
