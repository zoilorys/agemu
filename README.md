# agemu

`agemu` builds, runs, inspects, and controls an iOS app in Simulator. Commands return JSON, so people and coding agents can use the same interface.

> [!NOTE]
> `agemu` is under active development. The command and configuration formats may change before 1.0.

## Unreleased changes

- Breaking: the `inspect` plan action no longer returns the `trees` list (XCTest debug text or raw `idb` JSON). It returns `runnerResult.inspections`, a list of `{ "index": <action index in the plan>, "elements": [...] }`, in one element format on both backends. See [Inspect the screen](#inspect-the-screen).
- New `agemu ui inspect` command, targeting by `labelContains`, `type`, and `index`, and the `clear`, `pressKey`, `pressButton`, `openUrl`, `terminate`, `scrollUntilVisible`, and `assertText` actions. See [Targets](#targets) and [Actions reference](#actions-reference).

## Breaking changes in 0.2.0

- Unknown options and extra positional arguments fail with `COMMAND_INVALID`. Options accept both `--name=value` and `--name value`; a value starting with `--` needs the `=` form.
- Bare `agemu config` (without `show`) fails with `COMMAND_INVALID`.
- `simulator boot|shutdown --runtime` without `--name` fails with `COMMAND_INVALID`.
- `build` returns `run`. Run directory names under `.agemu/runs/` keep the timestamp prefix and gain a `-<pid>-<hex>` suffix.
- More commands append to `.agemu/events.jsonl`, so `diagnose` `recentErrors` reports more failures.
- UI plans stop at the first failed action on both backends. `UI_DELIVERY_FAILED` details add `failedAction` (`index`, `kind`, `message`) and `completed`.
- XCTest runs return `screenshots` PNG paths like idb runs; failed plans on both backends return `failureScreenshot`.
- `assertVisible` requires nonempty on-screen geometry. Hittability is separate. `assertExists` and `assertNotVisible` distinguish existence from visibility.
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

## Discover commands and results

```sh
agemu commands --runtime=native
agemu capabilities --runtime=expo-go
agemu ui tap --help
```

`commands` and `capabilities` work without a configuration and list runtime support, option types/defaults/bounds, required/repeated flags, destructive guards and recording policy. Runtime profiles are `native`, `react-native`, `expo-development-build` and `expo-go`. Their availability describes runtime support; it does not probe a live device or certify installed tools. Unknown configuration/tool readiness is explicitly null with a reason. Use `doctor` for prerequisites. Parsing, generated command/option help, discovery and dispatch share one registry.

Successful dispatched commands retain their existing fields and add common metadata:

| Field | Meaning |
| --- | --- |
| `action` | Command action; preserves existing command-specific values. |
| `udid`, `bundleId` | Observed device/app scope, or null when inapplicable or unavailable. Inventory commands have null app scope. |
| `run` | Relative evidence run directory, or null when no run was created. |
| `capturedAt` | ISO timestamp; the existing evidence timestamp when available, otherwise response generation time. |
| `artifacts` | `screenshots`, `recordings`, `logs`, `reports` and `files` arrays; nullable `transcript` and named `backend` evidence. Empty arrays mean no evidence. |

JSON envelopes remain `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "code", "message", "details"? } }`. Help/version keep their established envelopes. Artifact paths and aliases are retained: `screenshot`, `screenshots`, `recordings`, `artifact`, `logs.build`, `logs.settings`, `resultBundle`, `manifest` and `runnerResult`. A build product's `appPath` is a product, not a captured evidence file.

Every build result includes `appType`. Native/React Native builds also include `target`, `derivedData` and `logs.settings`; Expo development builds return null for those three native-only fields; Expo Go uses an installed host and cannot build/install through agemu. Diagnostics always include nullable `evidence.build` and `evidence.host`, plus `evidence.availability.{build,host}` with separate `applicable` and `available` booleans. Unavailable applicable evidence also has a reason in `failures`.

## Inspect and control one step

```sh
agemu app status
agemu app list
agemu app reload
agemu clipboard write --text='exact text'
agemu clipboard read
agemu ui tap --id=saveButton --backend=xctest
agemu ui type --id=nameField --text=Ada
agemu ui assert-value --id=gestureStatus --value=saved:Ada
agemu ui screenshot --name=current
```

`app status` returns exact UIKit service/PID evidence for `running`/`pid`, or null with a reason when inspection is unavailable/ambiguous. `foreground` is always null with an explicit limitation. `app list` returns a sorted installed app inventory with nullable name/executable/type fields. `app reload` requires a matching ready Metro/Expo project server. Bare React Native requests Metro's `/reload`; Expo has no such route, so agemu broadcasts `reload` on the server's `/message` socket and fails when no app is connected. Success confirms request delivery, not completed app reload. Native apps reject it. Clipboard commands require a booted Simulator; writes preserve exact text through stdin, accept an empty string and exclude input from process arguments and event summaries.

One-action UI shortcuts use the same validator and executor as plans: `launch`, `terminate`, `tap`, `type`, `clear`, `wait`, `long-press`, `swipe`, `assert-visible`, `assert-exists`, `assert-not-visible`, `assert-value`, `assert-text`, `screenshot`, `press-key`, `press-button` and `open-url`. Targets use `--id`, `--label`, `--label-contains`, `--type` and `--index`. Coordinate swipes accept `--from=x,y --to=x,y`. `--wait-timeout` bounds an element wait; `--timeout` always bounds the whole command. Pass `--confirm` to consent to URL prompts. Recording pairs and nested scroll actions remain ordinary JSON plans.

Both backend UI results are flat: `backend`, `bundleId`, `actions` (submitted count), `completed`, `screenshots`, `recordings`, `inspections`, `transcript` and `backendArtifacts`. The compatibility `runnerResult` aliases completed/bundle/inspection data. Empty evidence arrays remain present when recording or screenshots are absent. Screenshot and inspection indexes refer to the original submitted plan across recording boundaries. Failures preserve the same accumulated evidence and a nullable `failedAction`; `failureScreenshot` is available when capture succeeds.

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

`agemu build` runs `expo run:ios --device <udid> --no-bundler`. It can generate or modify `ios/` files. Review those files after the build. `app launch` opens the running project's development URL in the installed development build. Like Expo CLI, it first approves the URL scheme for that app in the Simulator's launch-services preferences, so iOS's first-open "Open in …?" prompt does not block the project.

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

Expo Go uses its installed host: `agemu build` and `agemu app install` do not apply. `app launch` approves the `exp` scheme for the host, then opens the running project's Expo URL in it.

For React Native and Expo, `diagnose` includes server status, the last server output, detected bundling errors, a screenshot, and Simulator logs. The saved server log may be from an earlier run. It does not include JavaScript console messages from inside the app; capture them with `agemu logs js` (see [JavaScript console](#javascript-console)). `logs show` reads Simulator unified logs for the built app or Expo Go host. Inspect `partial` and `failures` when evidence collection fails.

`diagnose` also returns `evidence.crashes` (see [Investigate failures](#investigate-failures)) and `window`, which reports the start and source of the `logs` and `crashes` windows. Without `--since` or `--last`, both start at the latest agemu launch of the configured app when one is recorded.

`agemu` writes build state, logs, screenshots, and test results to `.agemu/`. Add that directory to the app repository's `.gitignore`. Mutating workflows and evidence commands append redacted events to `.agemu/events.jsonl`; `commands` reports each command's recording policy. Recording is best effort: a write failure never changes success or replaces the primary error. Lock contention uses a 100 ms budget per event. `diagnose` also records its individual evidence collectors and reports recent failures. The file is append-only and is never trimmed.

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

`ui run` uses `idb` when an installed companion supports the plan. Otherwise it uses the bundled XCTest runner. [Install idb](https://fbidb.io/docs/idb/installation/) to enable this path. Use `--backend=xctest` when you need an `.xcresult` bundle, or `--backend=idb` to require `idb`. Both backends return the flat UI result described above. XCTest also returns `runnerCached` and `resultBundle`; its PNGs are exported from the result bundle. `ui build-runner` returns the `manifest` path. Both backends name screenshots `screenshots/<index>-<name>.png`. A non-timeout XCTest export failure keeps the action outcome and reports `screenshotExportError`; export deadline expiry returns `PROCESS_TIMEOUT` with completed evidence.

A plan stops at the first failed action. The `UI_DELIVERY_FAILED` error reports `details.failedAction` when known (`index` in the submitted plan, `kind`, `message`), `details.completed` (actions finished), and `details.failureScreenshot` when a failure screenshot was captured. A failed XCTest runner build returns `BUILD_FAILED`.

`--timeout=SECONDS` (1 to 86400) bounds `build` (default 1800), `ui build-runner` (default 900), and `ui run` (default 900, covering the whole plan including a runner build). A timeout fails with `PROCESS_TIMEOUT`. The shared deadline covers device selection, plan IO, runner build/cache, Expo URL preflight, actions, recordings and screenshot export. After a timeout, bounded cleanup stops active recordings and runners. An executing `ui run` may terminate the configured app; read-only `ui inspect` keeps it running. Failure details preserve `failedAction` (or null when no action failed), `completed`, `screenshots`, `recordings` and `inspections`; the legacy `lastStartedAction` alias may also be present.

`startVideoRecording` begins capturing the selected Simulator to an MP4 in the run directory. `stopVideoRecording` finishes that file. Put the pair around the entire sequence you want to show, including waits and screenshots. Keep it open until the last action; use another pair only when you want a separate clip. Starts cannot overlap, and every start needs a stop. The optional `name` labels the file. Plans with recordings return `recordings` paths. Recording keeps the same top-level result and submitted action indexes on both backends; it does not introduce segmented results. If an action fails, agemu stops the active recording before returning the error.

For a short plan, pass JSON directly:

```sh
agemu ui run --plan-json='{"version":1,"actions":[{"screenshot":{"name":"current"}}]}'
```

Targets accept an accessibility `identifier`, an exact `label`, and the other fields described in [Targets](#targets). The `tap` and `longPress` actions also accept `x` and `y` screen coordinates. `longPress` holds for `duration` seconds (default `1`). Swipe a scrollable element with `{ "swipe": { "direction": "up", "identifier": "resultsList", "duration": 0.3 } }`, or swipe the whole screen by omitting the target. Directions are `up`, `down`, `left`, and `right`; they describe finger movement, so swiping up scrolls content down the page. For a precise path, use `{ "swipe": { "from": { "x": 100, "y": 500 }, "to": { "x": 100, "y": 100 }, "duration": 0.3 } }`. `idb` uses the requested duration; XCTest uses gesture velocity to approximate it. Screen swipes without a target use XCTest. `wait` accepts a target and optional `timeout` to wait for an element, or `duration` in seconds to pause before the next action. Use a timed wait after a swipe before capturing an animation-sensitive screenshot. For `idb`, targeted taps use an accessibility press with an exact-value guard when the element has a unique identifier or label; otherwise they tap the center of its reported frame and log `coordinate fallback` in the transcript. Follow a tap with `wait` or an assertion for the expected result. The `inspect` action returns the screen's elements in `runnerResult.inspections` (see [Inspect the screen](#inspect-the-screen)).

Assertions take a target (see [Targets](#targets)). `assertVisible` passes when the element has nonempty on-screen geometry, independently of hittability. XCTest also requires the configured app to be `runningForeground`; background or stopped apps are not visible even when XCTest retains cached frames. This state qualification does not certify foreground identity. `assertExists` passes when the element is in the accessibility tree, even off screen; `assertNotVisible` passes when the element is absent or not on screen; `assertValue` compares the element's accessibility value with `value`. Plans are validated completely before any Simulator interaction: unknown actions, unknown fields, and missing targets or text fail with `UI_VALIDATION_FAILED`.

The bundled XCTest runner needs no macOS Accessibility or Screen Recording permission. XCTest runs save an `.xcresult` bundle and `xcodebuild.log` under `.agemu/runs/`. Its build is reused until runner sources change; `runnerCached` reports whether the run used that build. `idb` runs save `idb.log` and any requested screenshots there.

### Inspect the screen

```sh
agemu ui inspect [--backend=auto|idb|xctest] [--all] [--timeout=SECONDS]
```

Reads the running app's current screen and returns the elements and a screenshot in one response, so you can find identifiers and labels before writing a plan. It is read-only: it never launches, terminates, or taps the app, even on timeout. The app must already be running (`agemu app launch`); otherwise it fails with `UI_DELIVERY_FAILED` and a hint to launch it. With `idb` or `auto`, agemu checks exact UIKit service/PID evidence with `launchctl` first. XCTest inspects the configured app; idb reads the foreground tree. Neither backend certifies foreground identity: `foreground` is null with `foregroundUnavailable`. Bring the configured app forward before an idb inspection; an application label alone is not proof of its identity.

The result retains the flat UI evidence (`actions`, `completed`, `screenshots`, `recordings`, `inspections`, `transcript`, `runnerResult` and `backendArtifacts`) plus `run`, `udid`, `bundleId`, `backend`, `capturedAt`, `screenshot` (a PNG path), `elements`, and `counts` (`total` and `visible`). `elements` lists only visible elements unless you pass `--all`, which also returns off-screen ones with `visible: false`. If XCTest screenshot export fails, the result keeps its elements and reports `screenshotExportError`.

Each element, in document order, has:

- `type`: one of `application`, `window`, `button`, `staticText`, `textField`, `secureTextField`, `searchField`, `textView`, `image`, `cell`, `switch`, `slider`, `link`, `scrollView`, `table`, `collectionView`, `navigationBar`, `tabBar`, `alert`, `keyboard`, or `other` for anything else.
- `identifier`, `label`, `value`: strings, omitted when empty.
- `frame`: `{ x, y, width, height }` in points (zeros when the backend reports none).
- `visible`: the frame has positive size and intersects the application frame. This is a geometric check, not XCTest's `isHittable`.
- `enabled`, `selected`: present when the backend reports them.
- `depth`: nesting depth as a number, or null when unavailable. idb always returns null because its list is flat.

The `inspect` plan action returns the same elements as `runnerResult.inspections[].elements` (all elements, including off-screen ones), where `index` is the action's position in the submitted plan.

### Targets

Actions that act on an element take these target fields:

| Field | Meaning |
| --- | --- |
| `identifier` | Exact accessibility identifier. |
| `label` | Exact accessibility label. |
| `labelContains` | Case-sensitive substring of the label; must not be empty. |
| `type` | One of the element types above except `application` and `other`. |
| `index` | Zero-based position among the matches, in document order (default `0`). |

Give at least one of `identifier`, `label`, or `labelContains`; `identifier` and `label` cannot be combined. `type` and `index` narrow the match. A target matches the elements that satisfy every field you give, and `index` picks one of them in document order. The application root is never a candidate. Actions that act on or read an element (`tap`, `longPress`, `type`, `clear`, `swipe`, `assertValue`, `assertText`, `assertExists`, `assertVisible`) fail when the target has no match; `wait`, `scrollUntilVisible`, and `assertNotVisible` behave as described for each. Example: `{ "tap": { "labelContains": "Item", "type": "cell", "index": 2 } }`.

With `idb`, a tap on a resolved element presses it through accessibility when its identifier is unique, then when its label is unique, and otherwise taps its center (the transcript logs this coordinate fallback).

### Actions reference

Plans stop at the first failed action and are validated completely before running. "Target" means the fields in [Targets](#targets). Both backends accept every action; where `idb` has a limit, it is noted, and `auto` falls back to XCTest for plans `idb` cannot run.

| Action | Fields | XCTest | idb |
| --- | --- | --- | --- |
| `launch` | `arguments`, `environment` | yes | yes |
| `terminate` | none | yes | yes |
| `openUrl` | `url`; `confirm` (boolean) | yes, on iOS 16.4 or newer; presses SpringBoard's first-open "Open" prompt only with `confirm: true` (default false) | yes; presses the prompt only with `confirm: true`, and only when a new "Open in “App”?" title (naming the configured app when its display name is known) with Open and Cancel buttons appears |
| `pressButton` | `button`: `home` | yes | yes |
| `pressKey` | `key`: `return`, `delete`, `tab`, or `space`; `count` 1 to 100 (default 1) | yes | yes |
| `tap` | target, or `x` and `y` | yes | yes |
| `longPress` | target or `x` and `y`; `duration` | yes | yes |
| `type` | target; `text` | yes | yes |
| `clear` | target | yes | yes |
| `swipe` | `direction` with an optional target, or `from` and `to`; `duration` | yes | yes, except a direction without a target (XCTest) |
| `scrollUntilVisible` | `target`; `in` (container target); `direction` (default `up`); `maxSwipes` 1 to 50 (default 10) | yes | yes |
| `wait` | target with optional `timeout`, or `duration` | yes | yes |
| `assertVisible`, `assertExists`, `assertNotVisible` | target | yes | yes |
| `assertValue` | target; `value` | yes | yes |
| `assertText` | target; exactly one of `equals`, `contains`, `matches` | yes | yes |
| `screenshot` | `name` | yes | yes |
| `inspect` | none | yes | yes |
| `startVideoRecording`, `stopVideoRecording` | `name` (start only) | yes | yes |

Notes:

- `pressKey` types into the focused element. `pressKey` with `return` dismisses the keyboard.
- `pressButton` with `home` backgrounds the app. Use `launch` or `openUrl` before acting on the app again.
- `terminate` stops the configured app and succeeds if it is not running.
- `scrollUntilVisible` swipes the `in` container (default: the whole app) until `target` is visible, up to `maxSwipes` swipes. "Visible" uses the same nonempty frame-intersection rule on both backends; it does not require hittability. `direction` is the finger direction, so the default `up` scrolls content down the page. It fails when the target is still not visible afterward.
- `assertText` compares the element's `value` when it is not empty, otherwise its `label`. `matches` searches anywhere in the text unless anchored. Both engines use a validated portable subset: Unicode scalar characters, dot, anchors, classes, ASCII `\d`/`\w`/`\s`, capturing/noncapturing groups, alternation and greedy/lazy quantifiers (repeat counts up to 16777215). Dot excludes LF, CR, U+2028 and U+2029; `$` requires the strict end of text. Lookaround, backreferences, named groups, flags, Unicode properties and class-set operations are rejected before backend selection. This UI assertion subset differs from the JavaScript expressions accepted by log `--until`.

### Verification notes

Shared process fixtures exercise both backend contracts, including geometry/regex normalization, recording indexes, flat results and preserved failure evidence. XCTest also runs against the native Simulator fixture. Live idb conformance is unavailable on the current Intel host: the current official companion package is ARM64-only. Process fixtures do not establish live idb parity. No live Expo/React Native claim follows from these native checks.

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

`app launch`, `app restart`, and each `launch` action in a `ui run` plan record the launch time in `.agemu/launch.json`. Both backends record reached launch attempts as they execute. XCTest emits the action index and timestamp immediately before each launch attempt; an unreached later launch cannot replace the previous marker. `--since=launch` on `logs show`, `crashes list`, and `diagnose` starts at the latest record. It fails with `COMMAND_INVALID` when nothing was recorded or the record is for another app or Simulator. For `logs show`, lines timestamped before the launch are dropped from the response; the saved artifact keeps the full output. Do not combine `--since` with `--last`.

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

The authoritative suite is `test/**/*.test.ts`; nested review worktree copies are excluded. Native integration files run serially because they share the fixture app and selected Simulator. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full verification commands.

Bare React Native and Expo project launch/reload contracts are covered by injected processes and real local HTTP and WebSocket peers. Live Expo development-build and Expo Go workflows are covered by the opt-in test described in [test/fixtures/ExpoFixture/README.md](test/fixtures/ExpoFixture/README.md).

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
