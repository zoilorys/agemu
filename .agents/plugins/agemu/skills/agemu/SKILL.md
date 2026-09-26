---
name: agemu
description: Build, verify, and debug native iOS, bare React Native, and Expo apps in Simulator. Use in iOS app repositories, including those without .agemu.json.
---

# iOS Simulator development

Use the installed `agemu` CLI from the app root.

1. Inspect `.agemu.json`. If absent, identify the app type and an available Simulator with `agemu simulator list`. Use `agemu setup`, or `agemu setup --expo-go` for Expo Go. If setup cannot run interactively, write a version 2 config using the [config examples](../../../../../README.md#configure-an-app). Set the selected Simulator UDID. Ask only for choices the repository cannot settle.
2. Run `agemu doctor`. Resolve reported prerequisites before the run. Install project dependencies through the project's own instructions. Expo development builds need `expo-dev-client`; Expo Go needs an installed host on the selected Simulator.
3. Boot the selected Simulator. For native iOS, run `agemu build`, `agemu app install`, then `agemu app launch`. For bare React Native, build and install, then run `agemu server start` and `agemu app launch`. For Expo development builds, run build, install, server start, and app launch in that order. `agemu build` invokes `expo run:ios` and may generate or modify `ios/`; inspect the diff. For Expo Go, run only `agemu server start` and `agemu app launch`; its installed host needs no agemu build or install.
4. Verify the feature with `agemu observe` and a bounded `agemu ui run` plan. Prefer accessibility identifiers, then exact labels, then coordinates. Use `--backend=xctest` for an `.xcresult`, or let the CLI select `idb` when suitable. Inspect the returned backend and artifacts.
5. On failure, run `agemu diagnose --last=1m --level=info --limit=200`. Inspect `partial`, `failures`, the screenshot, logs, and server evidence. For React Native and Expo, server output shows bundling errors but does not capture all in-app JavaScript console messages or DevTools. Saved server output may belong to an earlier run.
6. Terminate the app used for this run. For React Native or Expo, run `agemu server stop`; it stops only agemu-owned servers. Shut down the selected Simulator. Preserve `.agemu/` evidence unless the task calls for removal.

Keep one run ID in launch arguments, environment, and notes when a task needs correlation. `agemu server status` reports readiness and ownership; resolve any port collision before launch. For Expo, `app launch` requires a running project server and opens its URL in the configured development build or Expo Go host.
