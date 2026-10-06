# agemu

`agemu` builds, runs, inspects, and controls an iOS app in Simulator. Commands return JSON, so people and coding agents can use the same interface. It supports native iOS, bare React Native, Expo development builds, and Expo Go.

> [!NOTE]
> `agemu` is under active development. The command and configuration formats may change before 1.0.

## Requirements

- macOS with Xcode and an iOS Simulator runtime
- Node.js 24 or later
- pnpm
- Optional: [idb](https://fbidb.io/docs/idb/installation/) for faster UI plans (XCTest is the fallback)

## Install from source

```sh
cd agemu
pnpm install
pnpm build
pnpm link --global
agemu --version
```

## Install the agent skill

```sh
npx skills add zoilorys/agemu --skill agemu
```

Or install the native plugin:

```sh
# Codex
codex plugin marketplace add zoilorys/agemu
codex plugin add agemu@agemu

# Claude Code
claude plugin marketplace add zoilorys/agemu
claude plugin install agemu@agemu
```

Start a new agent session afterwards. The skill activates in iOS app repositories and sets up the project on first use.

## Get help

Every command documents itself:

```sh
agemu --help                  # all commands
agemu <command> --help        # options, bounds, and notes (for example, agemu ui run --help)
agemu commands --runtime=expo-go   # machine-readable options and runtime support
agemu capabilities            # UI actions, regex subset, and backend limitations
```

Responses are `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "code", "message", "details"? } }`. Add `--pretty` to indent and `--debug` for error details. Results include `run` (the evidence directory under `.agemu/runs/`) and an `artifacts` object with `screenshots`, `recordings`, `logs`, `reports`, and `files`.

## Configure an app

You don't need to configure anything by hand. On first use in a project, the agent runs `agemu setup`, which detects the app type, picks a Simulator, and writes `.agemu/config.json`. Everything agemu creates (config, builds, logs, screenshots) lives in `.agemu/`, which ignores itself through its own `.gitignore`, so nothing shows up in your repository.

To set up without an agent, run `agemu setup` from the project root, then `agemu doctor`. See `agemu setup --help` for options and the config format.

## Build and run

Install project dependencies first (Expo development builds need `expo-dev-client`; Expo Go must be installed on the Simulator).

| App | Commands |
| --- | --- |
| Native iOS | `simulator boot` → `build` → `app install` → `app launch` |
| Bare React Native, Expo development build | `simulator boot` → `build` → `app install` → `server start` → `app launch` |
| Expo Go | `simulator boot` → `server start` → `app launch` |

```sh
agemu simulator boot
agemu build
agemu app install
agemu server start                 # React Native and Expo only
agemu app launch --arg=VALUE --env=NAME=VALUE
agemu observe                      # screenshot
agemu app reload                   # React Native and Expo only
agemu app terminate
agemu server stop                  # stops only servers agemu started
agemu simulator shutdown
```

For Expo, `build` runs `expo run:ios`, which can generate or modify `ios/`. A failed build returns `BUILD_FAILED` with parsed `errors` and the `log` path. `build` accepts `--timeout=SECONDS` (default 1800) and fails with `PROCESS_TIMEOUT` when it expires.

## Drive the UI

Find identifiers on the running app's screen:

```sh
agemu ui inspect
```

Run one action:

```sh
agemu ui tap --id=saveButton
agemu ui type --id=nameField --text=Ada
agemu ui assert-value --id=status --value=saved:Ada
agemu ui screenshot --name=current
```

## Run a UI plan

Create `ui-plan.json`:

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

```sh
agemu ui run --plan=ui-plan.json
agemu ui run --plan-json='{"version":1,"actions":[{"screenshot":{"name":"current"}}]}'
```

- **Targets** use `identifier`, `label`, or `labelContains`, narrowed by `type` and zero-based `index`. `tap` and `longPress` also accept `x` and `y`.
- **Actions** include `launch`, `terminate`, `openUrl`, `tap`, `longPress`, `type`, `clear`, `swipe`, `scrollUntilVisible`, `wait`, `pressKey`, `pressButton`, `assertVisible`, `assertExists`, `assertNotVisible`, `assertValue`, `assertText`, `screenshot`, `inspect`, and `startVideoRecording`/`stopVideoRecording`. See `agemu ui run --help` and `agemu capabilities` for fields.
- **Backends:** `auto` uses idb when it supports the plan, otherwise the bundled XCTest runner. Use `--backend=xctest` to keep an `.xcresult` bundle.
- **Failures:** a plan stops at the first failed action with `UI_DELIVERY_FAILED`; read `details.failedAction`, `details.completed`, and `details.failureScreenshot`.
- `--timeout=SECONDS` (default 900) bounds the whole plan, including a runner build.

## Control the Simulator

```sh
agemu simulator ui --appearance=dark --content-size=extra-large
agemu simulator status-bar --preset=clean
agemu simulator add-media --file=photo.jpg --file=contact.vcf
agemu privacy grant --service=photos
agemu push --payload-json='{"aps":{"alert":"Hello"}}'
agemu location set --coordinate=37.3349,-122.0090
agemu clipboard write --text='exact text'
agemu simulator create --name=Review --device-type="iPhone SE (3rd generation)"
```

Destructive commands (`app uninstall`, `simulator erase`, `simulator delete`) do nothing without `--yes`.

## Investigate failures

```sh
agemu diagnose --last=1m --level=info --limit=200
agemu crashes list --since=launch
agemu logs show --since=launch
agemu logs stream --duration=30s --until='Login succeeded'
agemu logs js --duration=30s --until='Login failed'    # React Native and Expo console
```

`diagnose` collects a screenshot, logs, crash reports, recent errors, and (for React Native and Expo) server output and bundling errors. Check `partial` and `failures`. `--since=launch` starts at the latest `app launch`, `app restart`, or plan `launch`.

## Clean up

`.agemu/` is never trimmed automatically:

```sh
agemu clean --runs --older-than=7d --dry-run
agemu clean --derived-data
```

## Develop

```sh
pnpm install
pnpm test
AGEMU_NATIVE_SIMULATOR_UDID=<udid> pnpm test:integration:native
```

Live React Native and Expo tests are opt-in; see [test/fixtures/ExpoFixture/README.md](test/fixtures/ExpoFixture/README.md) and [test/fixtures/ReactNativeFixture/README.md](test/fixtures/ReactNativeFixture/README.md). See [CONTRIBUTING.md](CONTRIBUTING.md) for full verification steps.

## License

[MIT](LICENSE)
