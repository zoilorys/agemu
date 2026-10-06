import { commandDefinitions } from './registry.js';
import { commandGuides, common } from './help-content.js';
export function helpFor(command?: string, subcommand?: string): string {
  const selected = commandDefinitions.filter(definition => command === undefined || definition.key === command || definition.key.startsWith(`${command} `))
    .filter(definition => subcommand === undefined || definition.key === `${command} ${subcommand}`);
  if (command && selected.length) {
    const usage = selected.map(definition => {
      const flags = Object.entries(definition.flags).map(([name, spec]) => {
        const text = `--${name}${spec.kind === 'boolean' ? '' : `=${spec.choices?.join('|') ?? 'VALUE'}`}${spec.kind === 'repeat' ? ' ...' : ''}`;
        const bounds = spec.integer ? ` (${spec.integer.min} to ${spec.integer.max}${spec.integer.unit ? ` ${spec.integer.unit}` : ''}${spec.integer.default !== undefined ? `; default ${spec.integer.default}` : ''})` : '';
        return `    ${text}${bounds}`;
      }).join('\n');
      return `agemu ${definition.key}\n  ${definition.description}${flags ? `\n${flags}` : ''}`;
    }).join('\n\n');
    return `${usage}${commandGuides[command] ? `\n\n${commandGuides[command]}` : ''}\n\n${common}`;
  }
  return `agemu [--pretty] [--debug] <command> [options]
Build, run, inspect, and control an iOS app in Simulator. Responses are JSON.
Run from the project root. agemu keeps its configuration (.agemu/config.json, created by setup) and evidence in .agemu/.

Commands:
${commandDefinitions.map(definition => `  ${definition.key.padEnd(20)} ${definition.description}`).join('\n')}

Run "agemu <command> --help" for command options and examples.

${common}`;
}
