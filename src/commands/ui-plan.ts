import { CliError } from '../core/errors.js';
import { targetTypes, type ElementTarget } from './ui-elements.js';
import { portableRegexSource } from './ui-regex.js';

/** Target identity is required, and identifier and label are mutually exclusive. */
export type Target = ElementTarget & (
  { identifier: string; label?: never } | { label: string; identifier?: never } |
  { labelContains: string; identifier?: never; label?: never }
);
export type Point = { x: number; y: number };
export type Swipe = ({ direction: 'up' | 'down' | 'left' | 'right' } & ElementTarget | { from: Point; to: Point }) & { duration?: number };
export type LongPress = (Target | Point) & { duration?: number };
type TextMode = { equals: string; contains?: never; matches?: never } |
  { contains: string; equals?: never; matches?: never } | { matches: string; equals?: never; contains?: never };
export type UiActionInputs = {
  launch: { arguments?: string[]; environment?: Record<string, string> };
  wait: (Target & { timeout?: number }) | { duration: number };
  type: Target & { text: string };
  tap: Target | Point;
  swipe: Swipe;
  longPress: LongPress;
  assertVisible: Target;
  assertExists: Target;
  assertNotVisible: Target;
  assertValue: Target & { value: string };
  screenshot: { name?: string };
  inspect: Record<string, never>;
  startVideoRecording: { name?: string };
  stopVideoRecording: Record<string, never>;
  clear: Target;
  pressKey: { key: 'return' | 'delete' | 'tab' | 'space'; count?: number };
  pressButton: { button: 'home' };
  openUrl: { url: string; confirm?: boolean };
  terminate: Record<string, never>;
  scrollUntilVisible: { target: Target; in?: Target; direction?: 'up' | 'down' | 'left' | 'right'; maxSwipes?: number };
  assertText: Target & TextMode;
};
export type UiActionKind = keyof UiActionInputs;
/** One validated action; narrowing its key determines the payload. */
export type UiAction = { [K in UiActionKind]: { [P in K]: UiActionInputs[P] } &
  { [P in Exclude<UiActionKind, K>]?: never } }[UiActionKind];
export type UiPlan = { version: 1; actions: UiAction[] };

const targetFields = ['identifier', 'label', 'labelContains', 'type', 'index'];

const hasTargetFields = (input: Record<string, unknown>) => targetFields.some(field => input[field] !== undefined);

/** Why a target is invalid, or undefined. Shared by every action that accepts a target. */
function targetProblem(input: Record<string, unknown>): string | undefined {
  for (const field of ['identifier', 'label', 'labelContains']) {
    if (input[field] !== undefined && typeof input[field] !== 'string') return `${field} must be a string`;
  }
  if (input.labelContains === '') return 'labelContains must not be empty';
  if (input.identifier !== undefined && input.label !== undefined) return 'accepts identifier or label, not both';
  if (input.identifier === undefined && input.label === undefined && input.labelContains === undefined) {
    return 'needs a string identifier, label, or labelContains';
  }
  if (input.type !== undefined && !(typeof input.type === 'string' && targetTypes.has(input.type))) {
    return `type must be one of ${[...targetTypes].join(', ')}`;
  }
  if (input.index !== undefined && !(Number.isSafeInteger(input.index) && (input.index as number) >= 0)) return 'index must be a non-negative integer';
  return undefined;
}
/** Accepted fields per action kind; every plan action must use exactly one of these kinds. */
const actionFields: Record<UiActionKind, readonly string[]> = {
  launch: ['arguments', 'environment'],
  wait: [...targetFields, 'timeout', 'duration'],
  type: [...targetFields, 'text'],
  tap: [...targetFields, 'x', 'y'],
  swipe: [...targetFields, 'direction', 'from', 'to', 'duration'],
  longPress: [...targetFields, 'x', 'y', 'duration'],
  assertVisible: targetFields,
  assertExists: targetFields,
  assertNotVisible: targetFields,
  assertValue: [...targetFields, 'value'],
  screenshot: ['name'],
  inspect: [],
  startVideoRecording: ['name'],
  stopVideoRecording: [],
  clear: targetFields,
  pressKey: ['key', 'count'],
  pressButton: ['button'],
  openUrl: ['url', 'confirm'],
  terminate: [],
  scrollUntilVisible: ['target', 'in', 'direction', 'maxSwipes'],
  assertText: [...targetFields, 'equals', 'contains', 'matches'],
};

/** Accepted action fields and backend limitations, shared with capability discovery. */
export const actionDefinitions: Readonly<Record<UiActionKind, { fields: readonly string[]; backends: readonly ('idb' | 'xctest')[] }>> =
  Object.fromEntries(Object.entries(actionFields).map(([kind, fields]) => [kind, {
    fields, backends: ['idb', 'xctest'],
  }])) as unknown as Record<UiActionKind, { fields: readonly string[]; backends: readonly ('idb' | 'xctest')[] }>;

const targetedActions = new Set(['tap', 'type', 'assertVisible', 'assertExists', 'assertNotVisible', 'assertValue', 'clear', 'assertText']);
export const swipeDirections = ['up', 'down', 'left', 'right'];
export const textModes = ['equals', 'contains', 'matches'] as const;
export const pressKeys = ['return', 'delete', 'tab', 'space'];
export const pressButtons = ['home'];

export function validatePlan(value: unknown): UiPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('UI_VALIDATION_FAILED', 'The UI plan must be an object');
  const plan = value as Record<string, unknown>;
  if (plan.version !== 1 || !Array.isArray(plan.actions) || plan.actions.length === 0) {
    throw new CliError('UI_VALIDATION_FAILED', 'The UI plan requires version 1 and at least one action');
  }
  const object = (item: unknown): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item);
  const point = (item: unknown): item is Point => object(item) && Number.isFinite(item.x) && Number.isFinite(item.y);
  let recording = false;
  for (const [index, raw] of plan.actions.entries()) {
    const fail = (message: string): never => { throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: ${message}`); };
    if (!object(raw) || Object.keys(raw).length !== 1) throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: must contain exactly one action`);
    const [kind] = Object.keys(raw);
    const fields = Object.hasOwn(actionDefinitions, kind) ? actionDefinitions[kind as UiActionKind].fields : undefined;
    if (!fields) throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: unknown action ${kind}`);
    const input = raw[kind];
    if (!object(input)) throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: ${kind} must be an object`);
    for (const field of Object.keys(input)) if (!fields.includes(field)) fail(`${kind} does not accept ${field}`);
    const optionalString = (field: string) => input[field] === undefined || typeof input[field] === 'string';
    const checkTarget = () => { const problem = targetProblem(input); if (problem) fail(`${kind} ${problem}`); };
    if (targetedActions.has(kind)) {
      const coordinates = input.x !== undefined || input.y !== undefined;
      if (kind === 'tap' && coordinates) {
        if (hasTargetFields(input) || !Number.isFinite(input.x) || !Number.isFinite(input.y)) fail('tap needs a target or finite x and y, not both');
      } else checkTarget();
    }
    if (kind === 'wait' && hasTargetFields(input)) checkTarget();
    if (kind === 'swipe' && input.direction !== undefined && hasTargetFields(input)) checkTarget();
    if (kind === 'longPress' && hasTargetFields(input)) checkTarget();
    if (kind === 'type' && typeof input.text !== 'string') fail('type needs string text');
    if (kind === 'assertValue' && typeof input.value !== 'string') fail('assertValue needs string value');
    if (kind === 'screenshot' && !optionalString('name')) fail('screenshot name must be a string');
    if (kind === 'pressKey') {
      if (!pressKeys.includes(input.key as string)) fail(`pressKey key must be one of ${pressKeys.join(', ')}`);
      if (input.count !== undefined && !(Number.isSafeInteger(input.count) && (input.count as number) >= 1 && (input.count as number) <= 100)) {
        fail('pressKey count must be an integer from 1 to 100');
      }
    }
    if (kind === 'scrollUntilVisible') {
      for (const field of ['target', 'in']) {
        const nested = input[field];
        if (nested === undefined && field === 'in') continue;
        if (!object(nested)) fail(`scrollUntilVisible ${field} must be an object`);
        const fields = nested as Record<string, unknown>;
        for (const key of Object.keys(fields)) if (!targetFields.includes(key)) fail(`scrollUntilVisible ${field} does not accept ${key}`);
        const problem = targetProblem(fields);
        if (problem) fail(`scrollUntilVisible ${field} ${problem}`);
      }
      if (input.direction !== undefined && !swipeDirections.includes(input.direction as string)) {
        fail(`scrollUntilVisible direction must be one of ${swipeDirections.join(', ')}`);
      }
      if (input.maxSwipes !== undefined && !(Number.isSafeInteger(input.maxSwipes) && (input.maxSwipes as number) >= 1 && (input.maxSwipes as number) <= 50)) {
        fail('scrollUntilVisible maxSwipes must be an integer from 1 to 50');
      }
    }
    if (kind === 'assertText') {
      const modes = textModes.filter(mode => input[mode] !== undefined);
      if (modes.length !== 1 || typeof input[modes[0]!] !== 'string') fail('assertText needs exactly one string equals, contains, or matches');
      if (modes[0] === 'matches') {
        try { portableRegexSource(input.matches as string); } catch (error) { fail(error instanceof Error ? error.message : 'assertText matches must be a valid regular expression'); }
      }
    }
    if (kind === 'pressButton' &&!pressButtons.includes(input.button as string)) fail(`pressButton button must be one of ${pressButtons.join(', ')}`);
    if (kind === 'openUrl') {
      const parses = (url: string) => { try { new URL(url); return true; } catch { return false; } };
      if (typeof input.url !== 'string' || !parses(input.url)) fail('openUrl needs a valid url string');
      if (input.confirm !== undefined && typeof input.confirm !== 'boolean') fail('openUrl confirm must be a boolean');
    }
    if (kind === 'launch') {
      if (input.arguments !== undefined && (!Array.isArray(input.arguments) || !input.arguments.every(item => typeof item === 'string'))) {
        fail('launch arguments must be an array of strings');
      }
      if (input.environment !== undefined && (!object(input.environment)
        || !Object.entries(input.environment).every(([name, entry]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof entry === 'string'))) {
        fail('launch environment must map valid variable names to strings');
      }
    }
    if ('startVideoRecording' in raw || 'stopVideoRecording' in raw) {
      const keys = Object.keys(raw);
      if (keys.length !== 1 || !object(raw[keys[0]])) throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: recording action must contain one object`);
      const value = raw[keys[0]] as Record<string, unknown>;
      if (keys[0] === 'startVideoRecording') {
        if (recording || Object.keys(value).some(key => key !== 'name') || (value.name !== undefined && (typeof value.name !== 'string' || !value.name.trim()))) {
          throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: invalid or nested startVideoRecording`);
        }
        recording = true;
      } else {
        if (!recording || Object.keys(value).length !== 0) throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: stopVideoRecording has no active recording`);
        recording = false;
      }
      continue;
    }
    if ('swipe' in raw) {
      const swipe = raw.swipe;
      const directional = object(swipe) && ['up', 'down', 'left', 'right'].includes(String(swipe.direction))
        && swipe.from === undefined && swipe.to === undefined;
      const coordinates = object(swipe) && swipe.direction === undefined && !hasTargetFields(swipe)
        && point(swipe.from) && point(swipe.to)
        && (swipe.from.x !== swipe.to.x || swipe.from.y !== swipe.to.y);
      if ((!directional && !coordinates) || (object(swipe) && swipe.duration !== undefined && (!Number.isFinite(swipe.duration) || Number(swipe.duration) <= 0))) {
        throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: swipe needs a direction or distinct from/to coordinates and a positive duration`);
      }
    }
    if ('wait' in raw) {
      const wait = raw.wait;
      const target = object(wait) && hasTargetFields(wait);
      const pause = object(wait) && !target && wait.timeout === undefined
        && typeof wait.duration === 'number' && Number.isFinite(wait.duration) && wait.duration >= 0;
      if (!object(wait) || (!target && !pause) || (target && (wait.duration !== undefined || (wait.timeout !== undefined
        && (typeof wait.timeout !== 'number' || !Number.isFinite(wait.timeout) || wait.timeout < 0))))) {
        throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: wait needs a target and optional timeout, or a nonnegative duration`);
      }
    }
    if ('longPress' in raw) {
      const press = raw.longPress;
      const target = object(press) && hasTargetFields(press);
      const coordinates = object(press) && Number.isFinite(press.x) && Number.isFinite(press.y);
      if (!object(press) || (!target && !coordinates) || (target && (press.x !== undefined || press.y !== undefined)) || (press.duration !== undefined && (!Number.isFinite(press.duration) || Number(press.duration) <= 0))) {
        throw new CliError('UI_VALIDATION_FAILED', `Action ${index}: longPress needs a target or coordinates and a positive duration`);
      }
    }
  }
  if (recording) throw new CliError('UI_VALIDATION_FAILED', 'Every startVideoRecording needs a matching stopVideoRecording');
  return value as UiPlan;
}
