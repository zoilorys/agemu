const common = `Global options:
  --help       Show this guide or help for a command (for example, agemu app --help).
  --version    Show the CLI version.
  --pretty     Indent the JSON response.
  --debug      Include error details in failed JSON responses.
Options accept --name=value or --name value. Unknown options are rejected.
A value starting with -- requires the --name=value form (for example, --arg=--verbose).`;

const commands: Record<string, string> = {
  server: `agemu server start\n  Start or reuse this project's Metro or Expo server. Expo development builds use --dev-client.\n\nagemu server status\n  Report server readiness and ownership; an unverified port occupant is a collision.\n\nagemu server stop\n  Stop only a server started by agemu for this project.`,
  setup: `agemu setup [--expo-go] [--udid=ID] [--port=PORT]\n  Detect native iOS, bare React Native, or Expo and write version 2 .agemu.json.\n  Only iOS application targets are offered as bundle IDs; test, widget, and extension targets are skipped.\n  --port sets the Metro or Expo server port (default 8081, 1 to 65535); native projects reject it.\n  --udid selects a Simulator; noninteractive setup otherwise uses the sole booted Simulator.\n  Interactive Expo setup asks for the launch target; noninteractive setup selects a development build. Setup does not install dependencies or generate native files.\n  --expo-go requires an installed Expo Go host on the selected Simulator.`,
  config: `agemu config show
  Show the resolved .agemu.json configuration, excluding internal paths and redaction values.`,
  simulator: `agemu simulator list
  List available iOS Simulator devices.

agemu simulator boot [--udid=ID | --name=NAME [--runtime=RUNTIME]]
agemu simulator shutdown [--udid=ID | --name=NAME [--runtime=RUNTIME]]
  Boot or shut down a simulator. A configured UDID takes precedence over --name;
  --udid overrides the configured selection.

agemu simulator ui [--appearance=light|dark] [--content-size=SIZE] [--increase-contrast=enabled|disabled] [selector]
  Set any given options on the booted simulator, then return the current appearance, contentSize, and increaseContrast.
  SIZE: increment, decrement, extra-small, small, medium, large, extra-large, extra-extra-large, extra-extra-extra-large,
  accessibility-medium, accessibility-large, accessibility-extra-large, accessibility-extra-extra-large, accessibility-extra-extra-extra-large.
  Values read from older runtimes (for example, unsupported) are returned as-is.

agemu simulator status-bar (--clear | [--preset=clean] [override options]) [selector]
  Override or clear the booted simulator's status bar, then return the active override lines (empty after --clear).
  --preset=clean: time 9:41, Wi-Fi active 3 bars, cellular active 4 bars, empty operator name, battery charged 100.
  Explicit options override preset values: --time=TEXT, --data-network=hide|wifi|3g|4g|lte|lte-a|lte+|5g|5g+|5g-uwb|5g-uc,
  --wifi-mode=searching|failed|active, --wifi-bars=0-3, --cellular-mode=notSupported|searching|failed|active, --cellular-bars=0-4,
  --operator-name=TEXT (may be empty), --battery-state=charging|charged|discharging, --battery-level=0-100.
  [selector] is --udid=ID | --name=NAME [--runtime=RUNTIME], as for boot.

agemu simulator add-media --file=PATH [--file=PATH ...] [selector]
  Import photos, videos, live photos, or vCard contacts into the booted simulator. Paths are relative to the current directory.
  Extensions: .jpg .jpeg .png .heic .gif .mov .mp4 .m4v .vcf. Missing files or other types fail before simctl runs.
  Imported media stays on the Simulator; there is no removal command. Returns the added paths.

agemu simulator create --name=NAME --device-type=TYPE [--runtime=RUNTIME]
  Create a Simulator and return it. TYPE is a device type name or identifier (for example, "iPhone SE (3rd generation)");
  RUNTIME is an available iOS runtime identifier, name, or version (default: simctl's choice). Needs no .agemu.json.

agemu simulator delete --udid=ID --yes
  Permanently delete the Simulator with that UDID and all its data, shutting it down first. Never infers the device; needs no .agemu.json.

agemu simulator erase --yes [selector]
  Shut down the selected Simulator if needed and erase all its content and settings (installed apps are removed;
  run "app install" again). Without .agemu.json, --udid is required. Without --yes nothing is changed.`,
  build: `agemu build [--timeout=SECONDS]
  Build native, bare React Native, or Expo development apps for the selected Simulator.
  --timeout limits the whole build (default 1800 s, 1 to 86400); a timeout fails with PROCESS_TIMEOUT and keeps the log.
  Expo development builds run expo run:ios, which may generate or modify ios/ files.
  Run before "app install". Expo Go uses an installed host and has no build.`,
  app: `agemu app install
  Install the previously built app on the selected simulator.

agemu app launch [--arg=VALUE ...] [--env=KEY=VALUE ...]
  Launch the configured bundle ID. Expo opens the running project's URL in its development build or Expo Go host. Repeat --arg and --env as needed.

agemu app terminate
  Stop the configured app if it is running.

agemu app restart [--arg=VALUE ...] [--env=KEY=VALUE ...]
  Stop and launch the app with optional launch arguments and environment values.

agemu app open-url --url=URL
  Open a URL on the selected simulator.

agemu app uninstall --yes
  Remove the configured app and all of its data from the selected booted Simulator.
  Without --yes nothing is removed. An app that is not installed reports alreadyUninstalled: true.
  Expo Go projects are refused because the host is shared. Build state is kept for "app install".`,
  privacy: `agemu privacy grant --service=NAME
agemu privacy revoke --service=NAME
agemu privacy reset --service=NAME [--all-apps]
  Change the configured app's permission for a service on the selected booted Simulator.
  Services: all, calendar, contacts-limited, contacts, location, location-always, photos-add, photos, media-library, microphone, motion, reminders, siri.
  reset --all-apps resets the service for every app instead of only the configured one.
  The change may terminate the running app. The current permission state cannot be read.`,
  push: `agemu push (--payload=FILE | --payload-json=JSON)
  Deliver a simulated remote notification to the configured app on the selected booted Simulator.
  Example: agemu push --payload-json='{"aps":{"alert":"Hello"}}'
  The payload must be a JSON object with an "aps" object and at most 4096 bytes. Delivery is not confirmed.
  A "Simulator Target Bundle" key is ignored; the configured bundle ID is always used.
  The payload is saved as .agemu/runs/<run>/push.json (mode 0600) and is NOT redacted; it may contain secrets.`,
  location: `agemu location set --coordinate=LAT,LON
agemu location clear
agemu location list
agemu location run --scenario=NAME
  Control the selected booted Simulator's simulated location (device-wide, not per app).
  set takes one coordinate without spaces (latitude -90 to 90, longitude -180 to 180), for example 37.3349,-122.0090.
  list returns scenario names; run starts one of them (names may contain spaces, quote them).
  The current location cannot be read back. Waypoint routes and speed are not supported.`,
  observe: `agemu observe
  Capture a simulator screenshot under .agemu/runs/ and return its path.`,
  logs: `agemu logs show [--last=30s | --since=launch|DURATION] [--level=default] [--limit=100]
  Return Simulator logs for the built app or Expo Go host and save the full output to .agemu/runs/.
  --last accepts a number followed by s, m, h, or d (for example, 1m).
  --since=launch starts at the latest agemu launch (app launch, app restart, or a ui run plan with launch) of the configured app on the configured Simulator; it also accepts a duration. Do not combine --since with --last.
  --level accepts default, info, debug, error, or fault.
  --limit accepts an integer from 0 to 10000; it limits returned lines.

agemu logs stream --duration=DURATION [--until=REGEX] [--level=default] [--limit=100]
  Capture live Simulator logs for the app until --duration elapses or a line matches --until, then return one JSON response.
  --duration is required: a number followed by s or m, from 1s to 10m. Stopping adds up to 3 s.
  --until is a JavaScript regular expression tested against each redacted line; no match is not an error (matched: false).
  log stream needs 1-2 s to start; begin the capture before triggering the behavior. The full capture is saved to .agemu/runs/.
  Example: agemu logs stream --duration=20s --until='Login succeeded'

agemu logs js --duration=DURATION [--until=REGEX] [--limit=100]
  Capture in-app JavaScript console messages (console.log, info, warn, error) of a React Native or Expo app through the running Metro/Expo server, then return one JSON response.
  Requires agemu server start and the app loaded on the configured Simulator. Messages logged before the command starts are filtered out.
  --duration is required: a number followed by s or m, from 1s to 10m.
  --until is a JavaScript regular expression tested against each redacted message text; no match is not an error (matched: false). Messages are saved to .agemu/runs/<run>/js-console.jsonl.
  Tested alongside a second inspector client, not with the React Native DevTools frontend; refuses targets that would disconnect an existing debugger. Sends no code to the app, but while connected Hermes may run getters or Proxy traps of logged objects to build previews.
  Example: agemu logs js --duration=20s --until='Login failed'`,
  diagnose: `agemu diagnose [--last=30s | --since=launch|DURATION] [--level=default] [--limit=100]
  Collect Simulator, build or Expo Go host, screenshot, log, crash report, and recent error evidence.
  By default logs and crash reports start at the latest matching agemu launch; without one, logs use --last (30s) and crash reports the last hour. The result's window reports the start and source.
  React Native and Expo add server output and bundling errors; use "logs js" for in-app JavaScript console output. Saved server output may be stale.
  Log options have the same meaning as in "logs show". Partial results report failures.`,
  crashes: `agemu crashes list [--since=24h|launch] [--limit=10]
  Return summaries of recent Simulator crash reports for the configured app (exception, termination, message when the report has one, faulting-thread frames with source file/line)
  and save redacted copies under .agemu/runs/<run>/crashes/. Reports are matched by bundle ID, or by executable name when a report has none.
  --since accepts a number followed by s, m, h, or d, or launch for the latest agemu launch of the configured app. --limit accepts an integer from 1 to 100. Reports are not symbolicated.`,
  ui: `agemu ui build-runner [--timeout=SECONDS]
  Build the bundled XCTest runner for the selected simulator. --timeout defaults to 900 s.

agemu ui run (--plan=FILE | --plan-json=JSON) [--backend=auto|idb|xctest] [--timeout=SECONDS]
  Run a JSON UI action plan and save results under .agemu/runs/.
  --timeout limits the whole plan, including a runner build (default 900 s, 1 to 86400). After an XCTest PROCESS_TIMEOUT agemu terminates the runner and the app.
  Pass JSON inline for short plans, or use a file for longer plans.
  auto uses idb when its companion supports the plan, then falls back to XCTest.
  Use xctest to keep an .xcresult bundle; idb saves a transcript and screenshots.
  Build and install the app first, except Expo Go, which uses an installed host. Swipe accepts duration in seconds; wait accepts a target with timeout or a duration-only pause. Actions include launch, wait, type, tap, swipe, longPress,
  assertVisible (on screen and hittable), assertExists (in the tree, even off screen), assertNotVisible (absent or off screen),
  assertValue, screenshot, inspect, startVideoRecording, and stopVideoRecording. Unknown actions or fields fail validation.
  Pair each recording start with a stop. Repeated pairs create separate MP4 files.`,
  doctor: `agemu doctor
  Check Node.js, Xcode, configuration, Simulator, app prerequisites, and write access. Does not install dependencies or generate native files.
  Advisory checks (advisory: true) report whether the Simulator is booted, idb is usable, and .agemu/ is git-ignored; they do not affect ready.`,
  clean: `agemu clean (--runs [--older-than=7d] | --derived-data) [--dry-run]
  Delete .agemu/runs/ directories and/or .agemu/DerivedData and .agemu/RunnerDerivedData, and report removed paths and freed bytes.
  --older-than keeps runs modified more recently (number followed by s, m, h, or d); without it, a run in progress is also removed.
  --derived-data also removes state.json when it points into DerivedData. --dry-run lists without deleting. Symlinks are never followed.
  Keeps events.jsonl, server state, and logs.`,
};

export function helpFor(command?: string): string {
  if (command && commands[command]) return `${commands[command]}\n\n${common}`;
  return `agemu [--pretty] [--debug] <command> [options]
Build, run, inspect, and control an iOS app in Simulator. Responses are JSON.
Run from a directory containing .agemu.json (except for setup, --help, and --version).

Commands:
  setup                Create .agemu.json for this project.
  config show          Show the resolved app configuration.
  simulator list       List available simulators.
  simulator boot       Boot the selected simulator.
  simulator shutdown   Shut down the selected simulator.
  simulator ui         Read or set appearance, content size, and contrast.
  simulator status-bar Override or clear the status bar.
  simulator add-media  Import photos, videos, or contacts.
  simulator create     Create a Simulator (also delete, erase; these require --yes).
  build                Build the configured iOS app.
  server start         Start or reuse this project's Metro or Expo server.
  server status        Inspect server readiness and ownership.
  server stop          Stop an agemu-owned server.
  app install          Install the built app.
  app launch           Launch the configured app.
  app terminate        Stop the configured app.
  app restart          Stop and relaunch the app.
  app open-url         Open a URL in Simulator.
  app uninstall        Remove the app and its data (requires --yes).
  privacy grant        Grant the app a permission (also revoke, reset).
  push                 Send a simulated remote notification to the app.
  location set         Set the simulated location (also clear, list, run).
  observe              Capture a simulator screenshot.
  logs show            Read recent app logs.
  logs stream          Capture live app logs for a bounded time.
  logs js              Capture JavaScript console messages for a bounded time.
  diagnose             Collect debugging evidence.
  crashes list         List recent app crash reports.
  ui build-runner      Build the XCTest UI runner.
  ui run               Execute a JSON UI action plan.
  doctor               Check setup and dependencies.
  clean                Delete agemu runs or derived data.

Run "agemu <command> --help" for command options and examples.

${common}`;
}
