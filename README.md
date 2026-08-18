# Groundcrew for Raycast

Browse Groundcrew tasks and check Groundcrew status without leaving Raycast.

> [!IMPORTANT]
> This extension requires the Groundcrew CLI to be installed and configured on your Mac. The extension does not store
> provider credentials; it uses the CLI's existing local configuration.

## Prerequisites

- macOS with [Raycast](https://www.raycast.com/) installed
- An installed and configured Groundcrew CLI
- The `crew` executable available on `PATH`, or its absolute path entered in the extension preference

## Commands

- **Browse Groundcrew Tasks** — opens the task browser placeholder
- **Groundcrew Status** — opens the status placeholder

The command views are scaffolded in this ticket. Groundcrew CLI integration and feature behavior will be added in
follow-up work.

## Configuration

The optional **Groundcrew Executable Path** preference accepts an absolute path such as
`/opt/homebrew/bin/crew`. Leave it empty to resolve `crew` from `PATH`.

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
