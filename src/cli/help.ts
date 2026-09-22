const common = `Global options:
  --help       Show this guide or help for a command (for example, agemu app --help).
  --version    Show the CLI version.
  --pretty     Indent the JSON response.
  --debug      Include error details in failed JSON responses.`;

const commands: Record<string, string> = {
  config: `agemu config show
  Show the resolved .agemu.json configuration, excluding internal paths and redaction values.`,
  simulator: `agemu simulator list
  List available iOS Simulator devices.

agemu simulator boot [--udid=ID | --name=NAME [--runtime=RUNTIME]]
agemu simulator shutdown [--udid=ID | --name=NAME [--runtime=RUNTIME]]
  Boot or shut down a simulator. A configured UDID takes precedence over --name;
  --udid overrides the configured selection.`,
  build: `agemu build
  Build the configured scheme for the selected simulator and cache the app product
  in .agemu/. Run before "app install".`,
  app: `agemu app install
  Install the previously built app on the selected simulator.

agemu app launch [--arg=VALUE ...] [--env=KEY=VALUE ...]
  Launch the configured bundle ID. Repeat --arg and --env as needed.

agemu app terminate
  Stop the configured app if it is running.

agemu app restart [--arg=VALUE ...] [--env=KEY=VALUE ...]
  Stop and launch the app with optional launch arguments and environment values.

agemu app open-url --url=URL
  Open a URL on the selected simulator.`,
  observe: `agemu observe
  Capture a simulator screenshot under .agemu/runs/ and return its path.`,
  logs: `agemu logs show [--last=30s] [--level=default] [--limit=100]
  Return recent logs for the built app and save the full output to .agemu/runs/.
  --last accepts a number followed by s, m, h, or d (for example, 1m).
  --level accepts default, info, debug, error, or fault.
  --limit accepts an integer from 0 to 10000; it limits returned lines.`,
  diagnose: `agemu diagnose [--last=30s] [--level=default] [--limit=100]
  Collect simulator, build, screenshot, log, and recent error evidence.
  Log options have the same meaning as in "logs show". Partial results report failures.`,
  ui: `agemu ui build-runner
  Build the bundled XCTest runner for the selected simulator.

agemu ui run --plan=FILE
  Run a JSON UI action plan and save XCTest results under .agemu/runs/.
  Build and install the app first. Actions include launch, wait, type, tap,
  assertVisible, screenshot, and inspect.`,
  doctor: `agemu doctor
  Check Node.js, Xcode, configuration, simulator selection, and write access.`,
};

export function helpFor(command?: string): string {
  if (command && commands[command]) return `${commands[command]}\n\n${common}`;
  return `agemu [--pretty] [--debug] <command> [options]
Build, run, inspect, and control an iOS app in Simulator. Responses are JSON.
Run from a directory containing .agemu.json (except for --help and --version).

Commands:
  config show          Show the resolved app configuration.
  simulator list       List available simulators.
  simulator boot       Boot the selected simulator.
  simulator shutdown   Shut down the selected simulator.
  build                Build the configured iOS app.
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
