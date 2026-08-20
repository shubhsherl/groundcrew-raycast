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
