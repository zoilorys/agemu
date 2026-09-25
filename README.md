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

The installer prompts for the target agents and installation scope. Start a new agent session after installation. The skill activates for iOS app repositories and guides the agent to create `.agemu.json` if needed.

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

Run `agemu setup` from the root of the iOS app repository. It finds the Xcode project or workspace, schemes, bundle IDs, and available simulators, and asks you to choose when needed. It writes `.agemu.json` without replacing an existing file.

You can also add `.agemu.json` manually:

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
    { "swipe": { "direction": "up", "identifier": "resultsList" } },
    { "longPress": { "label": "More options", "duration": 1.5 } },
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

`ui run` uses `idb` when an installed companion supports the plan. Otherwise it uses the bundled XCTest runner. [Install idb](https://fbidb.io/docs/idb/installation/) to enable this path. Use `--backend=xctest` when you need an `.xcresult` bundle, or `--backend=idb` to require `idb`. An `idb` run returns `backend`, `transcript`, and `screenshots` paths. An XCTest run returns `backend`, `runnerCached`, `resultBundle`, and `transcript`.

For a short plan, pass JSON directly:

```sh
agemu ui run --plan-json='{"version":1,"actions":[{"screenshot":{"name":"current"}}]}'
```

Targets accept an accessibility `identifier` or an exact `label`. The `tap` and `longPress` actions also accept `x` and `y` screen coordinates. `longPress` holds for `duration` seconds (default `1`). Swipe a scrollable element with `{ "swipe": { "direction": "up", "identifier": "resultsList" } }`, or swipe the whole screen by omitting the target. Directions are `up`, `down`, `left`, and `right`; they describe finger movement, so swiping up scrolls content down the page. For a precise path, use `{ "swipe": { "from": { "x": 100, "y": 500 }, "to": { "x": 100, "y": 100 } } }`. Screen swipes without a target use XCTest. The `inspect` action returns accessibility data in `runnerResult.trees`: XCTest debug text or `idb` JSON.

The bundled XCTest runner needs no macOS Accessibility or Screen Recording permission. XCTest runs save an `.xcresult` bundle and `xcodebuild.log` under `.agemu/runs/`. `idb` runs save `idb.log` and any requested screenshots there.

## Develop

```sh
pnpm install
pnpm test
```

The native integration test needs an available Simulator:

```sh
AGEMU_NATIVE_SIMULATOR_UDID=<udid> pnpm test:integration:native
```

The native test keeps its Xcode DerivedData under `.agemu/native-workflow/<udid>/` so later runs use an incremental build.

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
