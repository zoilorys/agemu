const common = `Global options:
  --help       Show this guide or help for a command (for example, agemu app --help).
  --version    Show the CLI version.
  --pretty     Indent the JSON response.
  --debug      Include error details in failed JSON responses.`;

const commands: Record<string, string> = {
  server: `agemu server start\n  Start or reuse this project's Metro or Expo server. Expo development builds use --dev-client.\n\nagemu server status\n  Report server readiness and ownership; an unverified port occupant is a collision.\n\nagemu server stop\n  Stop only a server started by agemu for this project.`,
  setup: `agemu setup [--expo-go] [--udid=ID]\n  Detect native iOS, bare React Native, or Expo and write version 2 .agemu.json.\n  --udid selects a Simulator; noninteractive setup otherwise uses the sole booted Simulator.\n  Interactive Expo setup asks for the launch target; noninteractive setup selects a development build. Setup does not install dependencies or generate native files.\n  --expo-go requires an installed Expo Go host on the selected Simulator.`,
  config: `agemu config show
  Show the resolved .agemu.json configuration, excluding internal paths and redaction values.`,
  simulator: `agemu simulator list
  List available iOS Simulator devices.

agemu simulator boot [--udid=ID | --name=NAME [--runtime=RUNTIME]]
agemu simulator shutdown [--udid=ID | --name=NAME [--runtime=RUNTIME]]
  Boot or shut down a simulator. A configured UDID takes precedence over --name;
  --udid overrides the configured selection.`,
  build: `agemu build
  Build native, bare React Native, or Expo development apps for the selected Simulator.
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
  Open a URL on the selected simulator.`,
  observe: `agemu observe
  Capture a simulator screenshot under .agemu/runs/ and return its path.`,
  logs: `agemu logs show [--last=30s] [--level=default] [--limit=100]
  Return Simulator logs for the built app or Expo Go host and save the full output to .agemu/runs/.
  --last accepts a number followed by s, m, h, or d (for example, 1m).
  --level accepts default, info, debug, error, or fault.
  --limit accepts an integer from 0 to 10000; it limits returned lines.`,
  diagnose: `agemu diagnose [--last=30s] [--level=default] [--limit=100]
  Collect Simulator, build or Expo Go host, screenshot, log, and recent error evidence.
  React Native and Expo add server output and bundling errors; in-app JavaScript console and DevTools are not captured. Saved server output may be stale.
  Log options have the same meaning as in "logs show". Partial results report failures.`,
  ui: `agemu ui build-runner
  Build the bundled XCTest runner for the selected simulator.

agemu ui run (--plan=FILE | --plan-json=JSON) [--backend=auto|idb|xctest]
  Run a JSON UI action plan and save results under .agemu/runs/.
  Pass JSON inline for short plans, or use a file for longer plans.
  auto uses idb when its companion supports the plan, then falls back to XCTest.
  Use xctest to keep an .xcresult bundle; idb saves a transcript and screenshots.
  Build and install the app first, except Expo Go, which uses an installed host. Swipe accepts duration in seconds; wait accepts a target with timeout or a duration-only pause. Actions include launch, wait, type, tap, swipe, longPress,
  assertVisible, screenshot, and inspect.`,
  doctor: `agemu doctor
  Check Node.js, Xcode, configuration, Simulator, app prerequisites, and write access. Does not install dependencies or generate native files.`,
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
  build                Build the configured iOS app.
  server start         Start or reuse this project's Metro or Expo server.
  server status        Inspect server readiness and ownership.
  server stop          Stop an agemu-owned server.
  app install          Install the built app.
  app launch           Launch the configured app.
  app terminate        Stop the configured app.
  app restart          Stop and relaunch the app.
  app open-url         Open a URL in Simulator.
  observe              Capture a simulator screenshot.
  logs show            Read recent app logs.
  diagnose             Collect debugging evidence.
  ui build-runner      Build the XCTest UI runner.
  ui run               Execute a JSON UI action plan.
  doctor               Check setup and dependencies.

Run "agemu <command> --help" for command options and examples.

${common}`;
}
