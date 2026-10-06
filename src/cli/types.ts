import type { ErrorCode } from '../core/errors.js';
export type FlagSpec = {
  kind: 'boolean' | 'value' | 'repeat';
  integer?: { min: number; max: number; default?: number; unit?: string };
  choices?: readonly string[]; nonEmpty?: boolean; required?: boolean;
  message?: string; errorCode?: ErrorCode; description?: string;
};
export type CommandSpec = { subcommands?: Record<string, Record<string, FlagSpec>>; flags?: Record<string, FlagSpec> };
export type ParsedArgs = {
  command?: string; subcommand?: string; flags: Map<string, string[]>;
  globals: { pretty: boolean; debug: boolean; help: boolean; version: boolean };
};
