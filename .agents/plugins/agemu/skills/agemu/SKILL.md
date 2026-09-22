---
name: agemu
description: Debug a configured iOS app in Simulator with native lifecycle, interactive input, screenshots, and bounded logs. Use in repositories with .agemu.json.
---

# iOS Simulator debugging

Use the installed `agemu` CLI.

1. Choose one run ID. Keep it unchanged in launch arguments, environment, and notes.
2. Run `doctor`. Stop if `ready` is false.
3. Boot the configured simulator.
4. Build and install the app.
5. Write one bounded JSON plan for the interaction. Prefer accessibility identifiers, then exact labels, then coordinates.
6. Run `ui run --plan=<file>`. Put related actions in one plan to avoid repeated XCTest startup.
7. Inspect the returned `.xcresult`, transcript, and screenshot attachments before deciding that the UI changed.
8. On failure, run `diagnose` with a bounded log window. Inspect every returned screenshot, log, build log, and interaction artifact before proposing a cause.
9. Terminate only the app started for this investigation. Preserve evidence unless the task requests cleanup.

Core commands:

```sh
agemu doctor
agemu simulator boot
agemu build
agemu app install
agemu app launch --env=AGEMU_RUN_ID="$run_id"
agemu ui run --plan=ui-plan.json
agemu logs show --last=1m --level=info --limit=200
agemu diagnose --last=1m --level=info --limit=200
agemu app terminate
```
