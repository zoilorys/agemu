# agemu

`agemu` builds, runs, inspects, and controls an iOS app in Simulator. Commands return JSON, so people and coding agents can use the same interface.

> [!NOTE]
> `agemu` is under active development. The command and configuration formats may change before 1.0.

## Breaking changes in 0.2.0

- Unknown options and extra positional arguments fail with `COMMAND_INVALID`. Options accept both `--name=value` and `--name value`; a value starting with `--` needs the `=` form.
- Bare `agemu config` (without `show`) fails with `COMMAND_INVALID`.
- `simulator boot|shutdown --runtime` without `--name` fails with `COMMAND_INVALID`.
- `build` returns `run`. Run directory names under `.agemu/runs/` keep the timestamp prefix and gain a `-<pid>-<hex>` suffix.
- More commands append to `.agemu/events.jsonl`, so `diagnose` `recentErrors` reports more failures.
- UI plans stop at the first failed action on both backends. `UI_DELIVERY_FAILED` details add `failedAction` (`index`, `kind`, `message`) and `completed`.
- XCTest runs return `screenshots` PNG paths like idb runs; failed plans on both backends return `failureScreenshot`.
- `assertVisible` requires the element to be on screen and hittable. New `assertExists` and `assertNotVisible` actions.
- UI plans are validated completely before running: unknown actions or fields, and actions that were previously skipped silently, fail with `UI_VALIDATION_FAILED`.
- `build`, `ui build-runner`, and `ui run` accept `--timeout=SECONDS` and fail with `PROCESS_TIMEOUT` when it expires.
- Build logs are plain text. `BUILD_FAILED` details include parsed compiler `errors`. A failed XCTest runner build returns `BUILD_FAILED` instead of `UI_DELIVERY_FAILED`.
- `setup` accepts `--port` and offers only application targets as bundle IDs.
- `doctor` adds advisory checks (booted Simulator, idb, `.agemu/` ignored) that do not affect `ready`.
- `doctor` now checks the scheme against the selected Simulator with a 60 s timeout, so `ready` can be false where it was true before.
- New `agemu clean` command.

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

Run `agemu setup` from the app root. It detects native iOS, bare React Native, or Expo, selects a Simulator, and writes `.agemu.json` without replacing an existing file. Use `--udid=ID` to choose a Simulator. When several are installed, noninteractive setup selects the sole booted Simulator. If none or several are booted, pass `--udid=ID`. Interactive Expo setup asks for the launch target; noninteractive setup selects a development build. Use `agemu setup --expo-go` to select Expo Go explicitly. Expo Go must already be installed on the selected Simulator. For React Native and Expo, `--port=PORT` sets the server port (default 8081); native projects reject it. Setup offers only iOS application targets as bundle IDs, skipping test, widget, and extension targets. Setup and `doctor` do not install dependencies or generate native files.

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

Checks marked `advisory: true` (Simulator booted, idb usable, `.agemu/` git-ignored) are informational and do not affect `ready`.

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

`app launch`, `app restart`, and `app terminate` target the configured bundle ID. `app install` requires a prior build. A failed build returns `BUILD_FAILED` with up to 20 parsed compiler `errors` (or the output `tail` when none parse) and the path of its plain-text `log`.

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

`agemu` writes build state, logs, screenshots, and test results to `.agemu/`. Add that directory to the app repository's `.gitignore`. Each `build`, `app`, `server`, `simulator boot|shutdown`, `ui`, `observe`, `logs show`, `diagnose`, and `clean` run appends one redacted event to `.agemu/events.jsonl`; `diagnose` reports recent failures from it. The file is append-only and is never trimmed.

## Run a UI plan

Build and install native, bare React Native, or Expo development apps first. For Expo Go, use its installed host. Then create `ui-plan.json`:

```json
{
  "version": 1,
  "actions": [
    { "startVideoRecording": { "name": "save-flow" } },
    { "launch": { "arguments": ["--ui-testing"], "environment": { "RUN_ID": "example" } } },
    { "wait": { "identifier": "email", "timeout": 5 } },
    { "type": { "identifier": "email", "text": "agent@example.com" } },
    { "swipe": { "direction": "up", "identifier": "resultsList", "duration": 0.3 } },
    { "wait": { "duration": 0.5 } },
    { "longPress": { "label": "More options", "duration": 1.5 } },
    { "tap": { "identifier": "save" } },
    { "assertVisible": { "label": "Saved" } },
    { "screenshot": { "name": "saved" } },
    { "stopVideoRecording": {} }
  ]
}
```

Run the plan:

```sh
agemu ui run --plan=ui-plan.json
```

`ui run` uses `idb` when an installed companion supports the plan. Otherwise it uses the bundled XCTest runner. [Install idb](https://fbidb.io/docs/idb/installation/) to enable this path. Use `--backend=xctest` when you need an `.xcresult` bundle, or `--backend=idb` to require `idb`. An `idb` run returns `backend`, `transcript`, and `screenshots` paths. An XCTest run returns `backend`, `runnerCached`, `resultBundle`, `transcript`, and `screenshots` exported from the result bundle. Both backends name screenshots `screenshots/<index>-<name>.png`. If XCTest export fails, the run keeps its outcome and reports `screenshotExportError`.

A plan stops at the first failed action. The `UI_DELIVERY_FAILED` error reports `details.failedAction` when known (`index` in the submitted plan, `kind`, `message`), `details.completed` (actions finished), and `details.failureScreenshot` when a failure screenshot was captured. A failed XCTest runner build returns `BUILD_FAILED`.

`--timeout=SECONDS` (1 to 86400) bounds `build` (default 1800), `ui build-runner` (default 900), and `ui run` (default 900, covering the whole plan including a runner build). A timeout fails with `PROCESS_TIMEOUT`. After an XCTest timeout, agemu terminates the runner and the app and returns `lastStartedAction` when known.

`startVideoRecording` begins capturing the selected Simulator to an MP4 in the run directory. `stopVideoRecording` finishes that file. Put the pair around the entire sequence you want to show, including waits and screenshots. Keep it open until the last action; use another pair only when you want a separate clip. Starts cannot overlap, and every start needs a stop. The optional `name` labels the file. Plans with recordings return `recordings` paths. idb also returns `segments` results for actions between recording boundaries. If an action fails, agemu stops the active recording before returning the error.

For a short plan, pass JSON directly:

```sh
agemu ui run --plan-json='{"version":1,"actions":[{"screenshot":{"name":"current"}}]}'
```

Targets accept an accessibility `identifier` or an exact `label`. The `tap` and `longPress` actions also accept `x` and `y` screen coordinates. `longPress` holds for `duration` seconds (default `1`). Swipe a scrollable element with `{ "swipe": { "direction": "up", "identifier": "resultsList", "duration": 0.3 } }`, or swipe the whole screen by omitting the target. Directions are `up`, `down`, `left`, and `right`; they describe finger movement, so swiping up scrolls content down the page. For a precise path, use `{ "swipe": { "from": { "x": 100, "y": 500 }, "to": { "x": 100, "y": 100 }, "duration": 0.3 } }`. `idb` uses the requested duration; XCTest uses gesture velocity to approximate it. Screen swipes without a target use XCTest. `wait` accepts a target and optional `timeout` to wait for an element, or `duration` in seconds to pause before the next action. Use a timed wait after a swipe before capturing an animation-sensitive screenshot. For `idb`, targeted taps use an accessibility press with an exact-value guard instead of converting the reported frame to touch coordinates. Follow a tap with `wait` or an assertion for the expected result. The `inspect` action returns accessibility data in `runnerResult.trees`: XCTest debug text or `idb` JSON.

Assertions take a target with exactly one of `identifier` or `label`. `assertVisible` passes only when the element is on screen and hittable; `assertExists` passes when the element is in the accessibility tree, even off screen; `assertNotVisible` passes when the element is absent or not on screen; `assertValue` compares the element's accessibility value with `value`. Plans are validated completely before any Simulator interaction: unknown actions, unknown fields, and missing targets or text fail with `UI_VALIDATION_FAILED`.

The bundled XCTest runner needs no macOS Accessibility or Screen Recording permission. XCTest runs save an `.xcresult` bundle and `xcodebuild.log` under `.agemu/runs/`. Its build is reused until runner sources change; `runnerCached` reports whether the run used that build. `idb` runs save `idb.log` and any requested screenshots there.

## Clean up

`.agemu/` is never trimmed automatically. Delete its artifacts explicitly:

```sh
agemu clean --runs --older-than=7d --dry-run
agemu clean --runs --older-than=7d
agemu clean --derived-data
```

`--runs` deletes directories under `.agemu/runs/`; add `--older-than=<n><s|m|h|d>` to keep recent runs, including one in progress. `--derived-data` deletes `.agemu/DerivedData` and `.agemu/RunnerDerivedData`, and `state.json` when it points into `DerivedData` (run `agemu build` again afterwards). `--dry-run` lists what would be deleted. The result reports `removed` paths and `freedBytes`. `events.jsonl`, server state, and logs are kept; symlinks are never followed.

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

As of 2026-09-29, the unit test suite passes, and the native Simulator integration test (`pnpm test:integration:native`) passed on iPhone 17 Pro (iOS 26.5, Xcode 26.5). idb paths are covered by unit tests only and were not verified live.

A bare React Native sample is unavailable. An Expo development sample reached Xcode asset compilation but did not complete its build. An Expo Go live run is unverified because CoreSimulatorService failed during that attempt.

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
