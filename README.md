# model-depth-routing

An OpenCode plugin for configuring model-depth presets and bounded role policies, routing manual work units, and tracking native subagent work. The plugin fails closed when a configured model or worker is unavailable.

## Requirements

- OpenCode with the `@opencode/plugin` 2.x API (2.0.15 or newer).
- Node.js 20 or newer for local development and tests.

This plugin relies on experimental OpenCode APIs; changes to those APIs may break compatibility.

## Install

After hosting this repository, replace `<repository-url>` with its Git URL and clone it into the OpenCode plugin directory:

```sh
git clone <repository-url> ~/.config/opencode/plugins/model-depth-routing
```

Add the local plugin path to `~/.config/opencode/opencode.json` (merge it with any existing `plugins` entries):

```json
{
  "plugins": ["./plugins/model-depth-routing"]
}
```

Restart OpenCode to load it. `index.ts` is the backend plugin entrypoint; `tui.ts` contains the companion TUI commands. Configure a model preset for each tier, then configure the Director and worker role policies before routing work.

## Development

```sh
npm install
npm test
```

`npm test` compiles the TypeScript sources and tests, then runs the focused Node.js test suite. `npm run typecheck` checks types without emitting files.

## Publication checklist

Before publishing or releasing, verify the intended repository URL and package name, confirm the MIT license and copyright notice, review the exact release contents (`npm pack --dry-run`), run `npm test`, and check that no credentials, local configuration, generated output, or unrelated files are included. Do not publish without explicit authorization.
