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

Run `agemu setup` from the app root. It detects native iOS, bare React Native, or Expo, selects a Simulator, and writes `.agemu.json` without replacing an existing file. Interactive Expo setup asks for the launch target; noninteractive setup selects a development build. Use `agemu setup --expo-go` to select Expo Go explicitly. Expo Go must already be installed on the selected Simulator. Setup and `doctor` do not install dependencies or generate native files.

You can also add `.agemu.json` manually:

```json
{
  "version": 2,
  "platform": "ios",
  "app": {
    "type": "native",
    "project": "App.xcodeproj",
    "scheme": "App",
    "configuration": "Debug",
    "bundleId": "com.example.App"
  },
  "simulator": { "udid": "SIMULATOR_UDID" }
}
```

The checked-in examples are [native](.agemu.example.json), [bare React Native](.agemu.react-native.example.json), [Expo development build](.agemu.expo-development.example.json), and [Expo Go](.agemu.expo-go.example.json).

Use exactly one of `project` or `workspace` for native and bare React Native. Paths are relative to `.agemu.json`. Select a Simulator by `udid`, or by `name` with an optional `runtime`. Version 1 configs are unsupported.

For bare React Native, replace `app` with:

```json
{ "type": "react-native", "root": ".", "port": 8081, "workspace": "ios/App.xcworkspace", "scheme": "App", "configuration": "Debug", "bundleId": "com.example.app" }
```

For Expo, use one of these `app` values:

```json
{ "type": "expo", "root": ".", "port": 8081, "launchTarget": "development-build", "bundleId": "com.example.app" }
```

```json
{ "type": "expo", "root": ".", "port": 8081, "launchTarget": "expo-go", "hostBundleId": "EXPO_GO_HOST_BUNDLE_ID" }
```

`root` points to the JavaScript project. `port` is the local Metro or Expo port. `hostBundleId` identifies the installed Expo Go app, not the Expo project's bundle ID. `redactions` optionally lists strings to mask in output and saved evidence.

Check the configuration and native tools:

```sh
agemu doctor --pretty
```

## Build and run a native app

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

`app launch`, `app restart`, and `app terminate` target the configured bundle ID. `app install` requires a prior build.

## Run bare React Native

Install the project's dependencies and native iOS dependencies first. Then run:

```sh
agemu doctor --pretty
agemu simulator boot
agemu build
agemu app install
agemu server start
agemu app launch
agemu observe
agemu diagnose --last=1m --limit=200
agemu app terminate
agemu server stop
agemu simulator shutdown
```

`agemu build` uses the configured Xcode project or workspace. `server status` reports readiness and ownership. `server stop` stops only a server started by agemu; a matching external server can be reused, but agemu leaves it running. A port used by an unverified project fails rather than being reused.

## Run an Expo development build

Install the project's dependencies, including `expo-dev-client`, first. Set `app.bundleId` to the Expo iOS bundle identifier. Then run:

```sh
agemu doctor --pretty
agemu simulator boot
agemu build
agemu app install
agemu server start
agemu app launch
agemu observe
agemu diagnose --last=1m --limit=200
agemu app terminate
agemu server stop
agemu simulator shutdown
```

`agemu build` runs `expo run:ios --device <udid> --no-bundler`. It can generate or modify `ios/` files. Review those files after the build. `app launch` opens the running project's development URL in the installed development build.

## Run Expo Go

Install the project's dependencies and Expo Go on the selected Simulator first. Set `hostBundleId` to that installed Expo Go app. Then run:

```sh
agemu doctor --pretty
agemu simulator boot
agemu server start
agemu app launch
agemu observe
agemu diagnose --last=1m --limit=200
agemu app terminate
agemu server stop
agemu simulator shutdown
```

Expo Go uses its installed host: `agemu build` and `agemu app install` do not apply. `app launch` opens the running project's Expo URL in the host.

For React Native and Expo, `diagnose` includes server status, the last server output, detected bundling errors, a screenshot, and Simulator logs. The saved server log may be from an earlier run. JavaScript console messages inside the app and React Native DevTools output are not captured. `logs show` reads Simulator unified logs for the built app or Expo Go host. Inspect `partial` and `failures` when evidence collection fails.

`agemu` writes build state, logs, screenshots, and test results to `.agemu/`. Add that directory to the app repository's `.gitignore`.

## Run a UI plan

Build and install native, bare React Native, or Expo development apps first. For Expo Go, use its installed host. Then create `ui-plan.json`:

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

The bundled XCTest runner needs no macOS Accessibility or Screen Recording permission. XCTest runs save an `.xcresult` bundle and `xcodebuild.log` under `.agemu/runs/`. Its build is reused until runner sources change; `runnerCached` reports whether the run used that build. `idb` runs save `idb.log` and any requested screenshots there.

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

As of 2026-09-26, the native Simulator workflow and test suite pass. A bare React Native sample is unavailable. An Expo development sample reached Xcode asset compilation but did not complete its build. An Expo Go live run is unverified because CoreSimulatorService failed during that attempt.

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
