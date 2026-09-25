---
name: agemu
description: Build, verify, and debug iOS app features in Simulator while coding. Use for iOS app repositories even when .agemu.json is missing.
---

# iOS Simulator development

Use the installed `agemu` CLI.

1. Check for `.agemu.json` at the app repository root. If absent, inspect its Xcode project or workspace, schemes, build settings, and `agemu simulator list` output. Resolve the project or workspace, scheme, Debug configuration, and bundle ID from the repository. Ask only for choices the project cannot settle.
2. If the config is missing, recommend the best available simulator for the app's deployment target and device needs. Prefer a relevant already booted or recently used device when that can be determined. Offer a few other suitable installed devices and let the user specify another. Create `.agemu.json` with the selected simulator UDID. Use `agemu setup` when its prompts are usable; otherwise write the config yourself.
3. Choose one run ID. Keep it unchanged in launch arguments, environment, and notes. Run `doctor` and resolve any reported setup issue before proceeding.
4. Boot the configured simulator if it is shut down. Use the CLI as part of the coding loop: build and install the current app, launch it, interact with the feature, inspect the result, edit the code, and repeat until the feature works. Use the same loop to verify completed changes or investigate bugs.
5. For UI interaction, use a bounded JSON plan. Prefer accessibility identifiers, then exact labels, then coordinates. Pass short plans with `ui run --plan-json=JSON`; use `--plan=FILE` for longer plans. Group related actions to reduce startup cost.
6. Inspect the returned artifacts before deciding that the UI changed. For `backend: "idb"`, inspect `screenshots`, `runnerResult`, and `transcript`. For `backend: "xctest"`, inspect the `.xcresult` and transcript. Use `observe` and bounded `logs show` calls as needed. On failure, run `diagnose` with a bounded log window and inspect its evidence before proposing a cause.
7. After the turn's work, terminate only the app started for this investigation and shut down the selected simulator, including when an earlier step failed. Preserve evidence unless the task requests cleanup.

Core commands:

```sh
agemu doctor
agemu simulator list --pretty
agemu simulator boot
agemu build
agemu app install
agemu app launch --env=AGEMU_RUN_ID="$run_id"
agemu observe
agemu ui run --plan-json='{"version":1,"actions":[{"screenshot":{"name":"current"}}]}'
agemu ui run --plan=ui-plan.json
agemu logs show --last=1m --level=info --limit=200
agemu diagnose --last=1m --level=info --limit=200
agemu app terminate
agemu simulator shutdown
```
