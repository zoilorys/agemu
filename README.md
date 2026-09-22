# agemu

`agemu` builds, runs, inspects, and controls an iOS app in Simulator. Commands return JSON, so people and coding agents can use the same interface.

> [!NOTE]
> `agemu` is under active development. The command and configuration formats may change before 1.0.

## Requirements

- macOS with Xcode and an iOS Simulator runtime
- Node.js 24 or later
- pnpm

## Install from source

Clone this repository, then run:

```sh
cd agemu
pnpm install
pnpm build
pnpm link --global
```

Run `agemu --version` to confirm the installation.

## Install the agent skill

Install the skill for Codex, Claude Code, OpenCode, or another supported agent:

```sh
npx skills add zoilorys/agemu --skill agemu
```

The installer prompts for the target agents and installation scope. Start a new agent session after installation. The skill activates for repositories that contain `.agemu.json`.

Codex users can instead install the native plugin:

```sh
codex plugin marketplace add zoilorys/agemu
codex plugin add agemu@agemu
```

Claude Code users can instead install its native plugin:

```sh
claude plugin marketplace add zoilorys/agemu
claude plugin install agemu@agemu
```

## Configure an app

Add `.agemu.json` to the root of the iOS app repository:

```json
{
  "version": 1,
  "project": "App.xcodeproj",
  "scheme": "App",
  "configuration": "Debug",
  "bundleId": "com.example.App",
  "simulator": {
    "name": "iPhone 17",
    "runtime": "iOS-26-0"
  }
}
```

Use `workspace` instead of `project` for an `.xcworkspace`. Select a simulator by `udid`, or by `name` with an optional `runtime`.

Check the configuration and native tools:

```sh
agemu doctor --pretty
```

## Build and run an app

```sh
agemu simulator list --pretty
agemu simulator boot
agemu build
agemu app install
agemu app launch --arg=VALUE --env=NAME=VALUE
agemu observe
agemu logs show --last=1m --level=info --limit=200
agemu diagnose --last=1m --level=info --limit=200
agemu app terminate
agemu simulator shutdown
```

`app launch`, `app restart`, and `app terminate` target the configured bundle ID. Only `app install` requires a prior build.

`agemu` writes build state, logs, screenshots, and test results to `.agemu/`. Add that directory to the app repository's `.gitignore`.

## Run a UI plan

Build and install the app first. Then create `ui-plan.json`:

```json
{
  "version": 1,
  "actions": [
    { "launch": { "arguments": ["--ui-testing"], "environment": { "RUN_ID": "example" } } },
    { "wait": { "identifier": "email", "timeout": 5 } },
    { "type": { "identifier": "email", "text": "agent@example.com" } },
    { "tap": { "identifier": "save" } },
    { "assertVisible": { "label": "Saved" } },
    { "screenshot": { "name": "saved" } }
  ]
}
```

Run the plan:

```sh
agemu ui run --plan=ui-plan.json
```

Targets accept an accessibility `identifier` or an exact `label`. The `tap` action also accepts `x` and `y` screen coordinates. The `inspect` action returns the XCTest accessibility hierarchy in `runnerResult.trees`.

The bundled XCTest runner needs no macOS Accessibility or Screen Recording permission. Each run saves an `.xcresult` bundle and `xcodebuild.log` under `.agemu/runs/`.

## Develop

```sh
pnpm install
pnpm test
```

The native integration test needs an available Simulator:

```sh
AGEMU_NATIVE_SIMULATOR_UDID=<udid> pnpm test:integration:native
```

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
