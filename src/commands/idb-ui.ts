import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { targetBundleId, type LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { redactValue } from '../artifacts/runs.js';
import { writeLaunchMarker } from '../artifacts/launch-marker.js';
import { deadline, type Deadline, type ProcessResult, type RunOptions } from '../process/run-process.js';
import { actionDefinitions, type LongPress, type Point, type Swipe, type UiPlan, type UiActionKind } from './ui-plan.js';
import { portableRegexSource } from './ui-regex.js';
import { createRecordingSession, startVideoRecording, type RecordingStarter } from './video-recording.js';
import { uiArtifactStem } from './ui-artifact-name.js';
import { checkUiDeadline, uiOperation, uiTimeout } from './ui-deadline.js';
import { failureMessage, uiFailure, uiResult } from './ui-result.js';
import { appDisplayName, describeTarget, elementVisible, matchingIndexes, normalizeIdbElements, type ElementTarget, type IdbElement, type Inspection } from './ui-elements.js';

type Run = (executable: string, args: string[], options?: RunOptions) => Promise<ProcessResult>;
type Target = ElementTarget & { x?: number; y?: number };
type Element = IdbElement;
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
  const passed = mode === 'equals' ? text === expected : mode === 'contains' ? text.includes(expected) : new RegExp(portableRegexSource(expected), 'u').test(text);
  return passed ? undefined : `text does not match: expected ${mode} ${expected}, got ${text}`;
}
/** SpringBoard's first-open "Open in …?" prompt button, confirmed by `openUrl` with `confirm: true`. */
const openPrompt: Target = { label: 'Open', type: 'button' };
const openPromptWaitMs = 2_000;
/** HID keyboard usage codes for `idb ui key`. */
const keyCodes: Record<string, string> = { return: '40', delete: '42', tab: '43', space: '44' };
const rightArrowKey = '79';

/** Screenshot file-name stem shared by both backends; AgentRunner.swift applies the same rule. */
export function screenshotName(name: unknown): string {
  return (typeof name === 'string' ? name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) : '') || 'screen';
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Plans reach backend selection only after shared validation. Check backend limitations alone. */
export function idbCompatible(plan: UiPlan): boolean {
  return plan.actions.every(action => {
    if (!actionDefinitions[Object.keys(action)[0] as UiActionKind].backends.includes('idb')) return false;
    // Whole-screen directional swipes are an XCTest-only capability.
    return !action.swipe || 'from' in action.swipe || action.swipe.identifier !== undefined
      || action.swipe.label !== undefined || action.swipe.labelContains !== undefined;
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
  limit: Deadline = deadline(900_000), dependencies: { startRecording?: RecordingStarter; launchUrl?: string } = {}) {
  if (!idbCompatible(plan)) return undefined;
  // Actions share the command deadline; availability probing and best-effort evidence have smaller caps.
  const run: Run = (executable, args, options = {}) => unbounded(executable, args, {
    ...options, timeoutMs: Math.min(options.timeoutMs ?? Infinity, limit.remaining()),
  });
  let deadlineHit = false;
  const expire = () => { deadlineHit = true; return new Error('the UI plan deadline was reached'); };
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  try {
    const probe = await run('idb', ['ui', 'describe-all', '--api', 'axbridge', '--udid', udid], { timeoutMs: idbCallMs });
    if (probe.exitCode !== 0) return undefined;
    parseElements(probe.stdout);
  } catch (error) {
    if (limit.expired()) throw uiTimeout(limit);
    return undefined;
  }

  const transcript = path.join(directory, 'idb.log');
  const lines: string[] = [];
  const inspections: Inspection[] = [];
  const screenshots: string[] = [];
  const recording = createRecordingSession(udid, directory, config.root, dependencies.startRecording ?? startVideoRecording, limit, config.redactions);
  const recordings = recording.recordings;
  let completed = 0;
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
      const action = raw as unknown as Record<string, Record<string, unknown>>;
      const [kind] = Object.keys(action);
      current = index;
      currentKind = kind;
      if (limit.expired()) throw expire();
      const value = action[kind];
      if (kind === 'launch') {
        await terminateApp();
        const environment = { ...process.env };
        for (const [key, entry] of Object.entries(value.environment ?? {})) environment[`SIMCTL_CHILD_${key}`] = String(entry);
        await uiOperation(limit, () => writeLaunchMarker(config.root, { at: new Date(), udid, bundleId: targetBundleId(config), source: 'ui run' }));
        await execute('xcrun', ['simctl', 'launch', udid, targetBundleId(config), ...((value.arguments as string[] | undefined) ?? [])], { env: environment });
        if (dependencies.launchUrl) await execute('xcrun', ['simctl', 'openurl', udid, dependencies.launchUrl]);
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
        // idb cannot press ⌘A, and the tap may leave the caret anywhere in the text: move it to the end, then delete.
        const target = value as Target;
        const tree = await elements();
        const element = await targetElement(target, tree);
        const old = typeof element.AXValue === 'string' ? element.AXValue : '';
        await press(target, element, tree);
        // An empty field reports its placeholder as its value, which idb cannot read. A placeholder is the value a full
        // delete pass leaves unchanged, so a value left after the first pass gets a second pass to tell them apart.
        let current = old;
        for (let pass = 0; current.length > 0; pass += 1) {
          const count = Array.from(current).length;
          await pressKey(rightArrowKey, count);
          await pressKey(keyCodes.delete!, count);
          const now = (await targetElement(target)).AXValue;
          const next = typeof now === 'string' ? now : '';
          if (next === current) break;
          if (pass === 1 && next.length > 0) throw new Error(`could not clear ${describeTarget(target)}`);
          current = next;
        }
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
        const coordinates = 'x' in press ? [press.x, press.y] : center(await targetElement(press));
        await execute('idb', ['ui', 'tap', String(Math.round(coordinates[0])), String(Math.round(coordinates[1])),
          '--duration', String(press.duration ?? 1), '--udid', udid], {});
      } else if (kind === 'swipe') {
        const swipe = value as Swipe;
        const [from, to] = 'from' in swipe ? [swipe.from, swipe.to] : swipePoints((await targetElement(swipe)).frame ?? {}, swipe.direction);
        await execute('idb', ['ui', 'swipe', String(Math.round(from.x)), String(Math.round(from.y)),
          String(Math.round(to.x)), String(Math.round(to.y)), ...(swipe.duration === undefined ? [] : ['--duration', String(swipe.duration)]), '--udid', udid],
          {});
      } else if (kind === 'assertVisible' || kind === 'assertNotVisible') {
        const tree = await elements();
        const element = findElement(tree, value as Target);
        const visible = elementVisible(tree, element);
        const name = describeTarget(value as Target);
        if (kind === 'assertVisible' && !visible) throw new Error(`element is not visible: ${name}${element ? ' (exists but has no on-screen geometry)' : ''}`);
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
      } else if (kind === 'startVideoRecording') {
        await recording.start(value.name as string | undefined);
      } else if (kind === 'stopVideoRecording') {
        await recording.stop();
      } else if (kind === 'screenshot') {
        const name = uiArtifactStem(value.name, 'screen', config.redactions);
        const file = path.join(directory, 'screenshots', `${index}-${name}.png`);
        await uiOperation(limit, () => mkdir(path.dirname(file), { recursive: true }));
        await execute('idb', ['screenshot', file, '--udid', udid]);
        screenshots.push(path.relative(config.root, file));
      } else if (kind === 'inspect') {
        inspections.push({ index, elements: normalizeIdbElements(await elements()) });
      }
      checkUiDeadline(limit);
      completed = index + 1;
    }
    return uiResult({
      run: path.relative(config.root, directory), udid, bundleId: targetBundleId(config), backend: 'idb',
      actions: plan.actions.length, transcript: path.relative(config.root, transcript),
    }, { completed, screenshots, recordings, inspections });
  } catch (error) {
    const secrets = config.redactions ?? [];
    const message = redact(error instanceof Error ? error.message : String(error), secrets);
    lines.push(`action ${current} (${currentKind}) error: ${message}`);
    const failedAction = { index: current, kind: currentKind, message };
    const evidence = { run: path.relative(config.root, directory), udid, bundleId: targetBundleId(config), backend: 'idb',
      actions: plan.actions.length, failedAction, completed, screenshots, recordings, inspections, transcript: path.relative(config.root, transcript) };
    if (deadlineHit || limit.expired() || (error instanceof CliError && error.code === 'PROCESS_TIMEOUT')) {
      throw uiFailure('PROCESS_TIMEOUT', `UI plan exceeded ${limit.ms / 1000} s`,
        redactValue({ ...evidence, timeoutSeconds: limit.ms / 1000 }, secrets));
    }
    let failureScreenshot: string | undefined;
    try {
      const file = path.join(directory, 'screenshots', `${uiArtifactStem('failure', 'screen', secrets)}.png`);
      await uiOperation(limit, () => mkdir(path.dirname(file), { recursive: true }));
      const shot = await run('idb', ['screenshot', file, '--udid', udid], { timeoutMs: 8_000 });
      lines.push(`idb screenshot failure: exit ${shot.exitCode}, ${shot.durationMs} ms`);
      if (shot.exitCode === 0 && (await uiOperation(limit, () => stat(file))).size > 0) failureScreenshot = path.relative(config.root, file);
    } catch { /* The failure screenshot is best effort. */ }
    if (limit.expired()) throw uiFailure('PROCESS_TIMEOUT', `UI plan exceeded ${limit.ms / 1000} s`,
      redactValue({ ...evidence, timeoutSeconds: limit.ms / 1000, ...(failureScreenshot ? { failureScreenshot } : {}) }, secrets));
    throw uiFailure('UI_DELIVERY_FAILED', redact(failureMessage(failedAction), secrets),
      redactValue({ ...evidence, ...(failureScreenshot ? { failureScreenshot } : {}) }, secrets));
  } finally {
    await recording.close();
    // A bounded best-effort transcript write cannot replace an action failure.
    await uiOperation(limit.expired() ? deadline(1_000) : limit,
      () => writeFile(transcript, `${redact(lines.join('\n'), config.redactions ?? [])}\n`, { mode: 0o600 })).catch(() => undefined);
  }
}
