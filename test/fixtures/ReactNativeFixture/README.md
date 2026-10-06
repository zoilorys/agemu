# React Native fixture

A minimal bare React Native 0.87.1 app (no Expo) for the opt-in live test `test/integration/react-native-fixture.test.ts`. Bundle ID `dev.agemu.react-native-fixture`; the Debug app loads JavaScript from Metro on port 8087 (`ios/ReactNativeFixture/AppDelegate.swift`).

Screen identifiers: `fixtureReady`, `loadId` (new per JavaScript load), `draftInput`, `saveButton`, `savedValue`, `incrementButton`, `counterValue`, `consoleProbeButton` (logs `agemu-rn-probe log|info <saved> <n>`), `probeCount`.

## Prerequisites

macOS with Xcode 26.5 and an iOS 26 Simulator, Node.js 24 and its bundled npm, Ruby 3.4+ with Bundler. CocoaPods 1.16.2 is pinned in `Gemfile.lock` and installed into `vendor/bundle`. React Native core and Hermes are prebuilt artifacts that `pod install` downloads and caches in `~/Library/Caches/ReactNative`.

## Set up

From this directory:

```sh
npm ci
npm run pods
```

`npm run pods` runs `bundle install` and `bundle exec pod install`. It generates `ios/Pods` and `ios/ReactNativeFixture.xcworkspace`; both are ignored. Rerun it when `ios/Podfile.lock` changes.

## Run the live test

From the repository root, with a Simulator that no other suite is using and port 8087 free:

```sh
pnpm build
AGEMU_REACT_NATIVE_FIXTURE=1 AGEMU_REACT_NATIVE_SIMULATOR_UDID=<udid> pnpm exec vitest run test/integration/react-native-fixture.test.ts
```

The test writes `.agemu/react-native-fixture/<udid>/.agemu.json` and drives `doctor`, `simulator boot`, `build`, `app install`, `server start|status|stop`, `app launch|status|reload|terminate`, `ui run`, `ui inspect`, `logs js`, and `observe`. It types a random token, saves it, increments the counter, captures console probes carrying the token, and checks that `app reload` gives a new load ID and resets the counter in the same process. Evidence stays under `.agemu/react-native-fixture/<udid>/.agemu/`. The test stops only its own Metro server and app, and shuts the Simulator down only if it booted it. Without `AGEMU_REACT_NATIVE_FIXTURE=1`, the root `pnpm test` skips it without side effects.

The test fails with setup instructions if `node_modules`, `ios/Pods` or `dist/` is missing or stale. It does not install dependencies.

## Run manually

From this directory (the generated `.agemu.json` and `.agemu/` are ignored):

```sh
agemu setup --udid=<udid> --port=8087
agemu build && agemu app install && agemu server start && agemu app launch
```
