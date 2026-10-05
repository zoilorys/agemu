import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { targetBundleId, type LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { redactValue } from '../artifacts/runs.js';
import { writeLaunchMarker } from '../artifacts/launch-marker.js';
import { deadline, type Deadline, type ProcessResult, type RunOptions } from '../process/run-process.js';
import type { LongPress, Point, Swipe, UiPlan } from './ui.js';
import { appDisplayName, describeTarget, elementVisible, matchingIndexes, normalizeIdbElements, type ElementTarget, type IdbElement, type Inspection } from './ui-elements.js';

type Run = (executable: string, args: string[], options?: RunOptions) => Promise<ProcessResult>;
type Target = ElementTarget & { x?: number; y?: number };
type Element = IdbElement;
const operations = new Set(['launch', 'wait', 'type', 'tap', 'swipe', 'longPress', 'assertVisible', 'assertExists', 'assertNotVisible',
  'assertValue', 'screenshot', 'inspect', 'clear', 'pressKey', 'pressButton', 'openUrl', 'terminate', 'scrollUntilVisible', 'assertText']);
/** Pause after each scrollUntilVisible swipe so scrolling settles; AgentRunner.swift uses the same pause. */
const scrollSettleMs = 300;

/** Text compared by assertText: the value when it is a non-empty string, else the label. Mirrors AgentRunner.swift. */
function elementText(element: { AXValue?: unknown; AXLabel?: unknown }): string {
  if (typeof element.AXValue === 'string' && element.AXValue !== '') return element.AXValue;
  return typeof element.AXLabel === 'string' ? element.AXLabel : '';
}

/** Failure message for assertText, or undefined when `text` satisfies the one given mode. */
function textMismatch(assertion: { equals?: string; contains?: string; matches?: string }, text: string): string | undefined {
  const [mode, expected]: [string, string] = assertion.equals !== undefined ? ['equals', assertion.equals]
    : assertion.contains !== undefined ? ['contains', assertion.contains] : ['matches', assertion.matches ?? ''];
  const passed = mode === 'equals' ? text === expected : mode === 'contains' ? text.includes(expected) : new RegExp(expected).test(text);
  return passed ? undefined : `text does not match: expected ${mode} ${expected}, got ${text}`;
}
/** SpringBoard's first-open "Open in …?" prompt button, confirmed by `openUrl` with `confirm: true`. */
const openPrompt: Target = { label: 'Open', type: 'button' };
const openPromptWaitMs = 2_000;
/** HID keyboard usage codes for `idb ui key`. */
const keyCodes: Record<string, string> = { return: '40', delete: '42', tab: '43', space: '44' };

/** Screenshot file-name stem shared by both backends; AgentRunner.swift applies the same rule. */
export function screenshotName(name: unknown): string {
  return (typeof name === 'string' ? name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) : '') || 'screen';
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function idbCompatible(plan: UiPlan): boolean {
  return plan.actions.every((action) => {
    if (!record(action)) return false;
    const keys = Object.keys(action);
    if (keys.length !== 1 || !operations.has(keys[0]) || !record(action[keys[0]])) return false;
    const value = action[keys[0]];
    if (!record(value)) return false;
    if (keys[0] === 'launch') return (value.arguments === undefined || (Array.isArray(value.arguments) && value.arguments.every(v => typeof v === 'string')))
      && (value.environment === undefined || (record(value.environment) && Object.values(value.environment).every(v => typeof v === 'string')));
    if (keys[0] === 'screenshot') return value.name === undefined || typeof value.name === 'string';
    if (keys[0] === 'inspect' || keys[0] === 'terminate') return true;
    if (keys[0] === 'openUrl') return typeof value.url === 'string' && (value.confirm === undefined || typeof value.confirm === 'boolean');
    if (keys[0] === 'pressKey') return typeof value.key === 'string' && keyCodes[value.key] !== undefined;
    if (keys[0] === 'pressButton') return value.button === 'home';
    if (keys[0] === 'scrollUntilVisible') return record(value.target) && (value.in === undefined || record(value.in));
    const targeted = typeof value.identifier === 'string' || typeof value.label === 'string' || typeof value.labelContains === 'string';
    if (keys[0] === 'swipe') return value.from !== undefined || targeted;
    if (keys[0] === 'longPress') return targeted || (Number.isFinite(value.x) && Number.isFinite(value.y));
    if (keys[0] === 'tap') return targeted || (Number.isFinite(value.x) && Number.isFinite(value.y));
    if (keys[0] === 'wait' && value.duration !== undefined) return true;
    if (!targeted) return false;
    if (keys[0] === 'type') return typeof value.text === 'string';
    if (keys[0] === 'assertValue') return typeof value.value === 'string';
    if (keys[0] === 'wait') return value.timeout === undefined || (typeof value.timeout === 'number' && value.timeout >= 0 && Number.isFinite(value.timeout));
    return true;
  });
}

function parseElements(output: string): Element[] {
  const value: unknown = JSON.parse(output);
  if (!Array.isArray(value)) throw new Error('idb returned an invalid accessibility tree');
  return value.filter(record) as Element[];
}

/** Raw elements matching the target's fields, compared in normalized form; `elements` must contain only records. */
function matchElements(elements: Element[], target: Target): Element[] {
  return matchingIndexes(normalizeIdbElements(elements), target).map(position => elements[position]!);
}

function findElement(elements: Element[], target: Target): Element | undefined {
  return matchElements(elements, target)[target.index ?? 0];
}

function center(element: Element): [number, number] {
  const frame = element.frame;
  if (!frame || !Number.isFinite(frame.x) || !Number.isFinite(frame.y) || !Number.isFinite(frame.width) || !Number.isFinite(frame.height)) {
    throw new Error('The matched element has no usable screen frame');
  }
  return [Math.round(frame.x! + frame.width! / 2), Math.round(frame.y! + frame.height! / 2)];
}

/** A point just inside the element's bottom-right corner, where a tap leaves the caret after the last character. */
function textEnd(element: Element): [number, number] {
  const [x, y] = center(element);
  const frame = element.frame!;
  return [Math.round(x + Math.max(0, frame.width! / 2 - 4)), Math.round(y + Math.max(0, frame.height! / 2 - 4))];
}

function swipePoints(frame: NonNullable<Element['frame']>, direction: string): [Point, Point] {
  if (!Number.isFinite(frame.x) || !Number.isFinite(frame.y) || !Number.isFinite(frame.width) || !Number.isFinite(frame.height)) {
    throw new Error('The matched element has no usable screen frame');
  }
  const x = frame.x!;
  const y = frame.y!;
  const width = frame.width!;
  const height = frame.height!;
  if (width <= 0 || height <= 0) throw new Error('The matched element has no usable screen frame');
  const start = { x: x + width / 2, y: y + height / 2 };
  const end = { ...start };
  const distance = (direction === 'up' || direction === 'down' ? height : width) * 0.3;
  if (direction === 'up') { start.y += distance; end.y -= distance; }
  if (direction === 'down') { start.y -= distance; end.y += distance; }
  if (direction === 'left') { start.x += distance; end.x -= distance; }
  if (direction === 'right') { start.x -= distance; end.x += distance; }
  return [start, end];
}

const idbCallMs = 8_000;

export async function tryRunIdbPlan(config: LoadedConfig, plan: UiPlan, udid: string, directory: string, unbounded: Run,
  limit: Deadline = deadline(900_000)) {
  if (!idbCompatible(plan)) return undefined;
  // Every call ends by the plan deadline; idb calls additionally stop after 8 s unless the caller allows longer.
  const run: Run = (executable, args, options = {}) => unbounded(executable, args, {
    ...options, timeoutMs: Math.min(options.timeoutMs ?? (executable === 'idb' ? idbCallMs : Infinity), limit.remaining()),
  });
  const idb = (args: string[]) => run('idb', [...args, '--udid', udid]);
  let deadlineHit = false;
  const expire = () => { deadlineHit = true; return new Error('the UI plan deadline was reached'); };
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  try {
    const probe = await idb(['ui', 'describe-all', '--api', 'axbridge']);
    if (probe.exitCode !== 0) return undefined;
    parseElements(probe.stdout);
  } catch { return undefined; }

  const transcript = path.join(directory, 'idb.log');
  const lines: string[] = [];
  const inspections: Inspection[] = [];
  const screenshots: string[] = [];
  const execute = async (executable: string, args: string[], options?: RunOptions): Promise<ProcessResult> => {
    const result = await run(executable, args, options);
    lines.push(`${executable} ${args.slice(0, 2).join(' ')}: exit ${result.exitCode}, ${result.durationMs} ms`);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${executable} failed`);
    return result;
  };
  const elements = async (): Promise<Element[]> => parseElements((await execute('idb', ['ui', 'describe-all', '--api', 'axbridge', '--udid', udid])).stdout);
  const targetElement = async (target: Target, tree?: Element[]): Promise<Element> => {
    const element = findElement(tree ?? await elements(), target);
    if (!element) throw new Error(`element not found: ${describeTarget(target)}`);
    return element;
  };
  /** Taps a resolved element: through accessibility when its id or label is unique in `tree`, else at its center. */
  const press = async (target: Target, element: Element, tree: Element[]) => {
    const identifier = typeof element.AXUniqueId === 'string' && element.AXUniqueId.length > 0 ? element.AXUniqueId : undefined;
    if (identifier !== undefined && tree.filter(candidate => candidate.AXUniqueId === identifier).length === 1) {
      // A unique identifier lets idb press the element through accessibility.
      const [expectedKey, expectedValue] = target.identifier !== undefined ? ['AXUniqueId', target.identifier]
        : target.label !== undefined ? ['AXLabel', target.label] : ['AXUniqueId', identifier];
      await execute('idb', ['ui', 'tap', identifier, '--match-key', 'AXUniqueId',
        '--expected-key', expectedKey, '--expected-value', expectedValue, '--api', 'axbridge', '--udid', udid]);
    } else if (typeof element.AXLabel === 'string' && element.AXLabel.length > 0
      && tree.filter(candidate => candidate.AXLabel === element.AXLabel).length === 1) {
      const label = element.AXLabel;
      const [expectedKey, expectedValue] = target.identifier !== undefined ? ['AXUniqueId', target.identifier] : ['AXLabel', label];
      await execute('idb', ['ui', 'tap', label, '--match-key', 'AXLabel',
        '--expected-key', expectedKey, '--expected-value', expectedValue, '--api', 'axbridge', '--udid', udid]);
    } else {
      // idb's --match-key presses the first match, which may not be the resolved element; tap its center instead.
      const [x, y] = center(element);
      lines.push(`coordinate fallback: ${describeTarget(target)} at ${x},${y}`);
      await execute('idb', ['ui', 'tap', String(x), String(y), '--udid', udid]);
    }
  };
  /** Stops the configured app; an app that is not running counts as stopped (src/commands/app.ts `stopped()`). */
  const terminateApp = async () => {
    const stopped = await run('xcrun', ['simctl', 'terminate', udid, targetBundleId(config)]);
    lines.push(`xcrun simctl terminate: exit ${stopped.exitCode}, ${stopped.durationMs} ms`);
    if (stopped.exitCode !== 0 && !/not running|no such process|found nothing to terminate/i.test(stopped.stderr)) {
      throw new Error(stopped.stderr.trim() || 'Unable to terminate the app');
    }
  };
  const pressKey = async (code: string, count: number) => {
    for (let pressed = 0; pressed < count; pressed += 1) {
      if (limit.expired()) throw expire();
      await execute('idb', ['ui', 'key', code, '--udid', udid]);
    }
  };

  let current = 0;
  let currentKind = 'unknown';
  try {
    for (const [index, raw] of plan.actions.entries()) {
      const action = raw as Record<string, Record<string, unknown>>;
      const [kind] = Object.keys(action);
      current = index;
      currentKind = kind;
      if (limit.expired()) throw expire();
      const value = action[kind];
      if (kind === 'launch') {
        await terminateApp();
        const environment = { ...process.env };
        for (const [key, entry] of Object.entries(value.environment ?? {})) environment[`SIMCTL_CHILD_${key}`] = String(entry);
        await writeLaunchMarker(config.root, { at: new Date(), udid, bundleId: targetBundleId(config), source: 'ui run' });
        await execute('xcrun', ['simctl', 'launch', udid, targetBundleId(config), ...((value.arguments as string[] | undefined) ?? [])], { env: environment });
      } else if (kind === 'wait') {
        if (typeof value.duration === 'number') {
          const pause = (value.duration as number) * 1000;
          const available = limit.remaining();
          await sleep(Math.min(pause, available));
          if (pause > available) throw expire();
        } else {
          const timeout = (value.timeout as number | undefined) ?? 5;
          const giveUp = Date.now() + timeout * 1000;
          while (true) {
            if (findElement(await elements(), value as Target)) break;
            if (Date.now() >= giveUp) throw new Error(`element did not appear: ${describeTarget(value as Target)}`);
            if (limit.expired()) throw expire();
            await sleep(Math.min(250, limit.remaining()));
          }
        }
      } else if (kind === 'clear') {
        // idb cannot press ⌘A, so tap at the end of the text and delete backwards. A tap may still land mid-text
        // (scrolled or multi-line text), so delete again while that removes something, and fail if text is left.
        const target = value as Target;
        const text = (element: Element) => typeof element.AXValue === 'string' ? element.AXValue : '';
        let element = await targetElement(target);
        const original = text(element);
        let remaining = original;
        while (true) {
          const [x, y] = textEnd(element);
          await execute('idb', ['ui', 'tap', String(x), String(y), '--udid', udid]);
          if (remaining.length === 0) break;
          await pressKey(keyCodes.delete!, Array.from(remaining).length);
          element = await targetElement(target);
          const next = text(element);
          const deleted = next !== remaining;
          remaining = next;
          // Nothing deleted: an empty field reporting its placeholder, as on XCTest.
          if (!deleted || remaining.length === 0) break;
        }
        if (remaining.length > 0 && remaining !== original) throw new Error(`could not clear ${describeTarget(target)}`);
      } else if (kind === 'tap' || kind === 'type') {
        if (kind === 'tap' && Number.isFinite(value.x) && Number.isFinite(value.y)) {
          await execute('idb', ['ui', 'tap', String(value.x), String(value.y), '--udid', udid]);
        } else {
          const target = value as Target;
          const tree = await elements();
          await press(target, await targetElement(target, tree), tree);
        }
        if (kind === 'type') await execute('idb', ['ui', 'text', '--udid', udid, '--', value.text as string]);
      } else if (kind === 'pressKey') {
        await pressKey(keyCodes[value.key as string]!, (value.count as number | undefined) ?? 1);
      } else if (kind === 'pressButton') {
        // Backgrounds the app; a later action on it needs `launch` first.
        await execute('idb', ['ui', 'button', 'HOME', '--udid', udid]);
      } else if (kind === 'terminate') {
        await terminateApp();
      } else if (kind === 'openUrl') {
        const confirm = value.confirm === true;
        // Only the system prompt is pressed: a newly appeared "Open in “App”?" title with new Open and Cancel buttons.
        // An app button labelled Open revealed by the deep link does not qualify.
        const elementKey = (element: Element) => JSON.stringify([element.type ?? null, element.AXLabel ?? null, element.frame ?? null]);
        const before = confirm ? new Set((await elements()).map(elementKey)) : undefined;
        const appName = confirm ? await appDisplayName(run, udid, targetBundleId(config)) : undefined;
        await execute('xcrun', ['simctl', 'openurl', udid, value.url as string]);
        if (before) {
          const giveUp = Date.now() + openPromptWaitMs;
          while (true) {
            const tree = await elements();
            const fresh = tree.filter(element => !before.has(elementKey(element)));
            const title = fresh.some(element => typeof element.AXLabel === 'string' && /^Open in [“"]/.test(element.AXLabel)
              && (appName === undefined || element.AXLabel.includes(appName)));
            const cancel = matchElements(fresh, { label: 'Cancel', type: 'button' }).length > 0;
            const prompt = title && cancel ? matchElements(fresh, openPrompt)[0] : undefined;
            if (prompt) {
              await press(openPrompt, prompt, tree);
              lines.push('openUrl confirmation: pressed Open');
              break;
            }
            if (Date.now() >= giveUp || limit.expired()) {
              lines.push('openUrl confirmation: no Open prompt appeared');
              break;
            }
            await sleep(Math.min(250, limit.remaining()));
          }
        }
      } else if (kind === 'longPress') {
        const press = value as LongPress;
        const coordinates = Number.isFinite(press.x) && Number.isFinite(press.y)
          ? [press.x!, press.y!] : center(await targetElement(press));
        await execute('idb', ['ui', 'tap', String(Math.round(coordinates[0])), String(Math.round(coordinates[1])),
          '--duration', String(press.duration ?? 1), '--udid', udid], { timeoutMs: idbCallMs + (press.duration ?? 1) * 1000 });
      } else if (kind === 'swipe') {
        const swipe = value as Swipe;
        const [from, to] = 'from' in swipe ? [swipe.from, swipe.to] : swipePoints((await targetElement(swipe)).frame ?? {}, swipe.direction);
        await execute('idb', ['ui', 'swipe', String(Math.round(from.x)), String(Math.round(from.y)),
          String(Math.round(to.x)), String(Math.round(to.y)), ...(swipe.duration === undefined ? [] : ['--duration', String(swipe.duration)]), '--udid', udid],
          { timeoutMs: idbCallMs + (swipe.duration ?? 0) * 1000 });
      } else if (kind === 'assertVisible' || kind === 'assertNotVisible') {
        const tree = await elements();
        const element = findElement(tree, value as Target);
        const visible = elementVisible(tree, element);
        const name = describeTarget(value as Target);
        if (kind === 'assertVisible' && !visible) throw new Error(`element is not visible: ${name}${element ? ' (exists but not hittable)' : ''}`);
        if (kind === 'assertNotVisible' && visible) throw new Error(`element is visible: ${name}`);
      } else if (kind === 'assertExists') {
        if (!findElement(await elements(), value as Target)) throw new Error(`element does not exist: ${describeTarget(value as Target)}`);
      } else if (kind === 'assertValue') {
        const element = await targetElement(value as Target);
        if (element.AXValue !== value.value) {
          throw new Error(`element value does not match: expected ${String(value.value)}, got ${typeof element.AXValue === 'string' ? element.AXValue : 'nil'}`);
        }
      } else if (kind === 'assertText') {
        const mismatch = textMismatch(value as { equals?: string; contains?: string; matches?: string }, elementText(await targetElement(value as Target)));
        if (mismatch) throw new Error(mismatch);
      } else if (kind === 'scrollUntilVisible') {
        const target = value.target as Target;
        const container = value.in as Target | undefined;
        const direction = (value.direction as string | undefined) ?? 'up';
        const maxSwipes = (value.maxSwipes as number | undefined) ?? 10;
        for (let swipes = 0; ; swipes += 1) {
          const tree = await elements();
          if (elementVisible(tree, findElement(tree, target))) break;
          if (swipes >= maxSwipes) throw new Error(`target not visible after ${swipes} swipes: ${describeTarget(target)}`);
          const surface = container ? findElement(tree, container) : tree.find(candidate => candidate.type === 'Application');
          if (!surface) throw new Error(container ? `container not found: ${describeTarget(container)}` : 'the application frame is unavailable');
          const [from, to] = swipePoints(surface.frame ?? {}, direction);
          await execute('idb', ['ui', 'swipe', String(Math.round(from.x)), String(Math.round(from.y)),
            String(Math.round(to.x)), String(Math.round(to.y)), '--udid', udid]);
          if (limit.expired()) throw expire();
          await sleep(Math.min(scrollSettleMs, limit.remaining()));
          if (limit.expired()) throw expire();
        }
      } else if (kind === 'screenshot') {
        const name = screenshotName(value.name);
        const file = path.join(directory, 'screenshots', `${index}-${name}.png`);
        await mkdir(path.dirname(file), { recursive: true });
        await execute('idb', ['screenshot', file, '--udid', udid]);
        screenshots.push(path.relative(config.root, file));
      } else if (kind === 'inspect') {
        inspections.push({ index, elements: normalizeIdbElements(await elements()) });
      }
    }
    return redactValue({
      run: path.relative(config.root, directory), udid, bundleId: targetBundleId(config),
      backend: 'idb', actions: plan.actions.length, runnerResult: { completed: plan.actions.length, bundleId: targetBundleId(config), inspections },
      screenshots, transcript: path.relative(config.root, transcript),
    }, config.redactions ?? []);
  } catch (error) {
    const secrets = config.redactions ?? [];
    const message = redact(error instanceof Error ? error.message : String(error), secrets);
    lines.push(`action ${current} (${currentKind}) error: ${message}`);
    const failedAction = { index: current, kind: currentKind, message };
    if (deadlineHit || limit.expired()) {
      // No failure screenshot: it would run past the deadline.
      throw new CliError('PROCESS_TIMEOUT', `UI plan exceeded ${limit.ms / 1000} s`,
        redactValue({ timeoutSeconds: limit.ms / 1000, transcript: path.relative(config.root, transcript), failedAction, completed: current, screenshots }, secrets));
    }
    let failureScreenshot: string | undefined;
    try {
      const file = path.join(directory, 'screenshots', 'failure.png');
      await mkdir(path.dirname(file), { recursive: true });
      const shot = await run('idb', ['screenshot', file, '--udid', udid], { timeoutMs: 8_000 });
      lines.push(`idb screenshot failure: exit ${shot.exitCode}, ${shot.durationMs} ms`);
      if (shot.exitCode === 0 && (await stat(file)).size > 0) failureScreenshot = path.relative(config.root, file);
    } catch { /* The failure screenshot is best effort. */ }
    throw new CliError('UI_DELIVERY_FAILED', redact(`UI action ${current} (${currentKind}) failed: ${message}`, secrets),
      redactValue({ transcript: path.relative(config.root, transcript), failedAction, completed: current, screenshots,
        ...(failureScreenshot ? { failureScreenshot } : {}) }, secrets));
  } finally {
    await writeFile(transcript, `${redact(lines.join('\n'), config.redactions ?? [])}\n`, { mode: 0o600 });
  }
}
