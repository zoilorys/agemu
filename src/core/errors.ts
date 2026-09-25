export type ErrorCode =
  | 'COMMAND_INVALID'
  | 'CONFIG_INVALID'
  | 'WORKFLOW_UNSUPPORTED'
  | 'SIMULATOR_AMBIGUOUS'
  | 'SIMULATOR_NOT_FOUND'
  | 'TOOL_NOT_FOUND'
  | 'PROCESS_FAILED'
  | 'PROCESS_TIMEOUT'
  | 'BUILD_FAILED'
  | 'APP_NOT_BUILT'
  | 'UI_DELIVERY_FAILED'
  | 'UI_VALIDATION_FAILED';

export class CliError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
