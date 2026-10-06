# Expo fixture

Minimal Expo SDK 57 app (React Native 0.86.3, React 19.2.3) for live agemu Expo checks. Dependencies are pinned exactly in `package.json` and `package-lock.json` and stay in this directory; the root package never installs or ships them.

| testID | Behavior |
| --- | --- |
| `fixtureTitle` | `agemu Expo fixture` |
| `sessionValue` | `session:<random>`; new value on every JavaScript load |
| `draftInput`, `saveButton`, `savedValue` | Saves the typed text as `saved:<text>` (initially `saved:(none)`) |
| `incrementButton`, `counterValue` | `count:<n>`; resets to `count:0` after a reload |
| `probeButton`, `probeStatus` | Logs 10 ticks of `agemu-expo-probe:{log,warn,error}:<saved>:<tick>` 300 ms apart, then `agemu-expo-probe:done:<saved>`; status becomes `probe:done:10` |

Every JavaScript load also logs `agemu-expo-boot:<session>`. LogBox toasts are disabled so probes never cover controls; `app.json` sets dev-menu Info.plist defaults so the development build shows no onboarding sheet or floating button.

## Prerequisites

Node 24, Xcode 26.5 with an iOS 26 Simulator, and CocoaPods (used by `expo run:ios`). Commands below call `agemu`; from a checkout use `node <repo>/dist/cli/main.js`. From the repository root:

```sh
pnpm install && pnpm build
npm ci --prefix test/fixtures/ExpoFixture
```

## Development build (bundle ID `dev.agemu.expo-fixture`)

`expo-dev-client` is a fixture dependency. `agemu build` runs `expo run:ios`, which generates `ios/` (ignored, never checked in; delete it to regenerate) and builds into Xcode's default DerivedData folder for this checkout's path. After installing, `expo run:ios` asks macOS System Events whether Simulator.app is running; the process running agemu needs Automation permission for System Events, otherwise the step times out (`AppleEvent timed out (-1712)`) and `agemu build` reports `BUILD_FAILED` even though Xcode printed `Build Succeeded`.

```sh
cd test/fixtures/ExpoFixture
sed "s/SIMULATOR_UDID/<udid>/" agemu.development-build.json > .agemu.json
agemu simulator boot && agemu build && agemu app install
agemu server start && agemu app launch
agemu ui run --backend=xctest --plan-json='{"version":1,"actions":[{"wait":{"identifier":"fixtureTitle","timeout":300}}]}'
agemu server stop
```

## Expo Go (host `host.exp.Exponent`)

Expo Go needs no agemu build or install. Install the official client listed for SDK 57 by `https://api.expo.dev/v2/versions` (Expo Go 57.0.9, x86_64 and arm64) on a booted Simulator:

```sh
cd test/fixtures/ExpoFixture
node scripts/install-expo-go.mjs <udid>
sed "s/SIMULATOR_UDID/<udid>/" agemu.expo-go.json > .agemu.json
agemu server start && agemu app launch
```

## First open

`agemu app launch` approves the project scheme for the target app in the Simulator's launch-services preferences before opening the project URL, so iOS's "Open in …?" prompt does not appear. Expo Go also shows a one-time developer-menu introduction; tap `Continue`.

## Live integration test

Opt-in; without `AGEMU_EXPO_FIXTURE=1` it is skipped with no side effects. From the repository root:

```sh
pnpm build
AGEMU_EXPO_FIXTURE=1 AGEMU_EXPO_SIMULATOR_UDID=<udid> pnpm exec vitest run test/integration/expo-fixture.test.ts
# Expo Go host already installed on <udid>:
AGEMU_EXPO_FIXTURE=1 AGEMU_EXPO_MODE=expo-go AGEMU_EXPO_SIMULATOR_UDID=<udid> pnpm exec vitest run test/integration/expo-fixture.test.ts
```

`AGEMU_EXPO_PORT` overrides the default port 8088. The test drives only public agemu commands against the given UDID: doctor, boot, build and install (development build), server start/status, app launch, XCTest UI plans, observe, `logs js`, app reload, terminate and server stop. Outside agemu it only reads, deletes and restores the fixture's scheme approval with `xcrun simctl spawn <udid> defaults`, deleting it (`expo run:ios` also writes it) before launching, then asserts that `app launch` alone loads the project and records the approval for the target app, and checks real UI text, PNG screenshots, captured console messages and a reload that resets the counter and session. It stops only its own server, uninstalls the development build if it was absent before the run and is present afterwards (even after a failed build), restores the scheme approval, shuts the Simulator down only if it booted it, and keeps evidence under `.agemu/expo-fixture/<udid>/<mode>/`.
