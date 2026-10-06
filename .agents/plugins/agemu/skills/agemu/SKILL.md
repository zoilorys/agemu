---
name: agemu
description: Build, verify, and debug native iOS, bare React Native, and Expo apps in Simulator. Use in iOS app repositories, including ones agemu has not set up yet.
---

# iOS Simulator development

Use the installed `agemu` CLI from the app root. Every response is JSON (`ok`, `data` or `error.code`). This skill covers the core flows; for everything else run `agemu --help`, `agemu <command> --help`, `agemu commands` (flags, bounds, runtime support) or `agemu capabilities` (UI actions, backend limits).

## Set up

1. If `.agemu/config.json` is absent, set the project up yourself without asking the user to: `agemu simulator list`, then `agemu setup --udid=ID` (add `--expo-go` for Expo Go, `--port=PORT` if Metro/Expo is not on 8081). If setup cannot run, write the file using the format in `agemu setup --help`. Ask only for choices the repository cannot settle. If a legacy `.agemu.json` exists in the project root, move it to `.agemu/config.json`.
2. `agemu doctor`; fix what blocks `ready` (`advisory: true` checks do not). Install project dependencies the project's own way.

## Run

Boot first: `agemu simulator boot`.

| App | Flow |
| --- | --- |
| Native iOS | `build` → `app install` → `app launch` |
| Bare React Native, Expo dev build | `build` → `app install` → `server start` → `app launch` |
| Expo Go | `server start` → `app launch` (no build/install) |

For Expo, `build` runs `expo run:ios` and may change `ios/`; inspect the diff. On `BUILD_FAILED`, read `details.errors` and `details.log`. `PROCESS_TIMEOUT` means `--timeout=SECONDS` expired; raise it for a large first build. Use `app reload` (RN/Expo) and `app restart` to iterate.

## Verify

- `agemu ui inspect` (app must already be running) to find element identifiers.
- One step: `agemu ui tap --id=ID`, `ui type --id=ID --text=TEXT`, `ui assert-visible --label=TEXT`, `ui screenshot --name=NAME`.
- Flows: `agemu ui run --plan-json='{"version":1,"actions":[...]}'` (or `--plan=FILE`). Example actions: `{"tap":{"identifier":"save"}}`, `{"wait":{"identifier":"done","timeout":5}}`, `{"wait":{"duration":0.5}}`, `{"assertVisible":{"label":"Saved"}}`, `{"scrollUntilVisible":{"target":{"identifier":"row42"}}}`, `{"screenshot":{"name":"saved"}}`. Wrap actions in `{"startVideoRecording":{"name":"flow"}}` … `{"stopVideoRecording":{}}` for video. Full action list: `agemu ui run --help`.
- Prefer `identifier`, then `label`/`labelContains` with `type`, then coordinates. Wait or assert after taps and before screenshots.
- A plan stops at the first failure (`UI_DELIVERY_FAILED`): read `details.failedAction`, `details.completed`, and open `details.failureScreenshot`.
- `agemu observe` takes a plain screenshot. Foreground identity is never certified; `app status` reports running/PID only.

## Debug

- `agemu diagnose --last=1m --level=info --limit=200`: screenshot, logs, crashes, server output; check `partial` and `failures`.
- `agemu crashes list --since=launch` after a crash.
- `agemu logs stream --duration=30s --until=REGEX` instead of sleeping for a log line.
- `agemu logs js --duration=30s --until=REGEX` for RN/Expo `console.*` (server running, app loaded; only messages logged during capture).

## Clean up

`app terminate`, `server stop` (RN/Expo; stops only agemu-owned servers), `simulator shutdown`. Keep `.agemu/` evidence unless asked; `agemu clean --runs --older-than=7d` for housekeeping.

## Rules

- Use `agemu privacy grant --service=NAME` instead of tapping permission prompts.
- For clean screenshots: `simulator status-bar --preset=clean`, `simulator ui --appearance=dark|light`.
- Destructive commands (`app uninstall`, `simulator erase`, `simulator delete`) need `--yes` and explicit user intent.
