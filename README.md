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
- New Simulator control commands: `privacy`, `push`, `location`, `app uninstall`, and `simulator ui|status-bar|add-media|create|delete|erase`. See [Control the Simulator](#control-the-simulator).

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

For React Native and Expo, `diagnose` includes server status, the last server output, detected bundling errors, a screenshot, and Simulator logs. The saved server log may be from an earlier run. It does not include JavaScript console messages from inside the app; capture them with `agemu logs js` (see [JavaScript console](#javascript-console)). `logs show` reads Simulator unified logs for the built app or Expo Go host. Inspect `partial` and `failures` when evidence collection fails.

`diagnose` also returns `evidence.crashes` (see [Investigate failures](#investigate-failures)) and `window`, which reports the start and source of the `logs` and `crashes` windows. Without `--since` or `--last`, both start at the latest agemu launch of the configured app when one is recorded.

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

## Control the Simulator

These commands set up Simulator state for tests and screenshots. Most need `.agemu.json` and a booted Simulator. `simulator create` and `simulator delete` need no config, and `simulator erase` shuts a booted Simulator down first. Destructive commands do nothing without `--yes`.

### Appearance and status bar

```sh
agemu simulator ui --appearance=dark --content-size=extra-large --increase-contrast=enabled
agemu simulator status-bar --preset=clean
agemu simulator status-bar --clear
```

`simulator ui` applies the options you pass, then returns the values read back (`appearance`, `contentSize`, `increaseContrast`). Values from older runtimes, such as `unsupported`, are returned as-is. `simulator status-bar --preset=clean` sets 9:41, full Wi-Fi and cellular bars, an empty operator name, and a charged battery at 100%. Explicit options (`--time`, `--data-network`, `--wifi-mode`, `--wifi-bars`, `--cellular-mode`, `--cellular-bars`, `--operator-name`, `--battery-state`, `--battery-level`) override preset values. The result lists the active `overrides` lines from simctl, or `[]` after `--clear`. Both commands accept `--udid=ID` or `--name=NAME [--runtime=RUNTIME]`.

### Photos, videos, and contacts

```sh
agemu simulator add-media --file=photo.jpg --file=contact.vcf
```

Imports `.jpg`, `.jpeg`, `.png`, `.heic`, `.gif`, `.mov`, `.mp4`, `.m4v`, and `.vcf` files. Missing files or other types fail before anything is imported. Imported media stays on the Simulator; there is no removal command.

### Permissions

```sh
agemu privacy grant --service=photos
agemu privacy revoke --service=location
agemu privacy reset --service=all --all-apps
```

Changes the configured app's permission for a service, so you can skip tapping permission prompts. `reset --all-apps` resets every app. The change may terminate the running app, so relaunch it afterwards. The current permission state cannot be read back.

### Push notifications

```sh
agemu push --payload-json='{"aps":{"alert":"Hello"}}'
agemu push --payload=push.json
```

Delivers a simulated remote notification to the configured app. The payload must be a JSON object with an `aps` object, at most 4096 bytes. Delivery is not confirmed. The payload is saved as `.agemu/runs/<run>/push.json` (mode 0600) and is not redacted, so keep secrets out of it.

### Location

```sh
agemu location set --coordinate=37.3349,-122.0090
agemu location list
agemu location run --scenario="City Run"
agemu location clear
```

Location is device-wide, not per app. `list` returns the scenario names simctl offers; `run` starts one. The current location cannot be read back. Waypoint routes and speed are not supported.

### Manage Simulators and the app

```sh
agemu simulator create --name=Review --device-type="iPhone SE (3rd generation)"
agemu simulator erase --yes
agemu simulator delete --udid=UDID --yes
agemu app uninstall --yes
```

`simulator create` returns the new Simulator. `simulator erase` shuts a booted Simulator down first and wipes its content and settings, so installed apps are removed: run `agemu app install` again. Without `.agemu.json`, `erase` needs `--udid`. `simulator delete` permanently removes the Simulator and its data, and always needs an explicit `--udid`; it never infers the device. `app uninstall` removes the configured app and its data; an app that is not installed reports `alreadyUninstalled: true`, and Expo Go projects are refused because the host is shared. Without `--yes`, none of these change anything.

## Investigate failures

### Crash reports

```sh
agemu crashes list --since=launch
agemu crashes list --since=24h --limit=5
```

`crashes list` reads `.ips` reports from `~/Library/Logs/DiagnosticReports`, where Simulator apps write them. Only crash reports (`bug_type` 309) are considered. A report matches when its header `bundleID` equals the configured bundle ID. Only a report without a `bundleID` falls back to matching the executable name (`app_name` or `procName`), and only when agemu knows that name from the last build or the Expo Go host. `--since` takes a duration or `launch` (default `24h`); `--limit` takes 1 to 100 (default 10).

Each result has the exception type and signal, `termination`, and the faulting thread's frames (up to 15, with `sourceFile` and `sourceLine` when the report has them). `message` comes from the report's `asi` section and is `null` when absent, which is usual for Simulator reports such as a Swift `fatalError`; read the frames instead. Redacted copies are saved under `.agemu/runs/<run>/crashes/`, named like the source report. Reports are not symbolicated, and ones that cannot be read are counted in `skipped`.

### Launch windows

`app launch`, `app restart`, and each `launch` action in a `ui run` plan record the launch time in `.agemu/launch.json`. With the `idb` backend each launch is recorded as it runs; with XCTest the time is recorded when the runner starts the plan. `--since=launch` on `logs show`, `crashes list`, and `diagnose` starts at the latest record. It fails with `COMMAND_INVALID` when nothing was recorded or the record is for another app or Simulator. For `logs show`, lines timestamped before the launch are dropped from the response; the saved artifact keeps the full output. Do not combine `--since` with `--last`.

### Live capture

```sh
agemu logs stream --duration=30s --until='Login succeeded'
```

`logs stream` captures live Simulator logs for the app and returns one JSON response when `--duration` (required, 1s to 10m) elapses or a line matches `--until`. `--until` is a JavaScript regular expression tested against each redacted line. The result reports `stoppedBy`, `matched` (and `matchedLine`), the last `--limit` lines, and the full capture in `logs-stream.txt` under the run. Stopping can add up to 3 s. The log stream takes a moment to start, so begin the capture a few seconds before triggering the behavior.

`crashes list` and `logs stream` also append an event to `.agemu/events.jsonl`.

### JavaScript console

```sh
agemu logs js --duration=30s --until='Login failed'
```

For React Native and Expo apps, `logs js` captures in-app `console.*` messages through the running Metro/Expo server (`agemu server start`) and returns one JSON response when `--duration` (required, 1s to 10m) elapses, a message matches `--until`, or the app disconnects. The app must be loaded on the configured Simulator; otherwise it fails with `PROCESS_FAILED`. A shut-down Simulator fails with `SIMULATOR_NOT_BOOTED`. Metro identifies apps only by device name, so `logs js` refuses to run while another booted Simulator has the same name. Native apps return `WORKFLOW_UNSUPPORTED`.

- Each message has `level` (the console method name; observed: `log`, `info`, `warn`, `error`), `text`, an ISO `timestamp`, and `stack` (first call frame, bundle positions, not source-mapped). Objects render from the preview React Native sends, capped at 4000 characters per message.
- React Native replays messages logged before the command starts; they are filtered out, so only messages logged during the capture are returned.
- `--until` is tested against each redacted message text. The result reports `target`, `stoppedBy` (`duration`, `until`, or `disconnected` with the close `disconnect` reason when the app process restarts or another debugger replaces the connection; a JavaScript reload does not end the capture), `matched` (and `matchedMessage`), the last `--limit` messages, and the full capture in `js-console.jsonl` under the run. Each capture appends an event to `.agemu/events.jsonl`.
- Tested alongside a second inspector client; not tested with the React Native DevTools frontend. Targets that would disconnect an existing debugger are refused.
- `logs js` sends no code to the app. While it is connected, Hermes may run getters or Proxy traps of objects the app logs to build previews, as React Native DevTools does.
- Verified with Expo Go (SDK 57, React Native 0.86, Metro 0.84). Development builds and bare React Native are expected to work the same way but are unverified.

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
