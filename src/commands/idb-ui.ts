import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { targetBundleId, type LoadedConfig } from '../config/config.js';
import { CliError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import type { ProcessResult, RunOptions } from '../process/run-process.js';
import type { LongPress, Point, Swipe, UiPlan } from './ui.js';

type Run = (executable: string, args: string[], options?: RunOptions) => Promise<ProcessResult>;
type Target = { identifier?: string; label?: string; x?: number; y?: number };
type Element = { AXUniqueId?: unknown; AXLabel?: unknown; AXValue?: unknown; frame?: { x?: number; y?: number; width?: number; height?: number } };
const operations = new Set(['launch', 'wait', 'type', 'tap', 'swipe', 'longPress', 'assertVisible', 'assertValue', 'screenshot', 'inspect']);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compatible(plan: UiPlan): boolean {
  return plan.actions.every((action) => {
    if (!record(action)) return false;
    const keys = Object.keys(action);
    if (keys.length !== 1 || !operations.has(keys[0]) || !record(action[keys[0]])) return false;
    const value = action[keys[0]];
    if (!record(value)) return false;
    if (keys[0] === 'launch') return (value.arguments === undefined || (Array.isArray(value.arguments) && value.arguments.every(v => typeof v === 'string')))
      && (value.environment === undefined || (record(value.environment) && Object.values(value.environment).every(v => typeof v === 'string')));
    if (keys[0] === 'screenshot') return value.name === undefined || typeof value.name === 'string';
    if (keys[0] === 'inspect') return true;
    const targeted = typeof value.identifier === 'string' || typeof value.label === 'string';
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

function findElement(elements: Element[], target: Target): Element | undefined {
  return target.identifier !== undefined
    ? elements.find(element => element.AXUniqueId === target.identifier)
    : elements.find(element => element.AXLabel === target.label);
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

export async function tryRunIdbPlan(config: LoadedConfig, plan: UiPlan, udid: string, directory: string, run: Run) {
  if (!compatible(plan)) return undefined;
  const idb = (args: string[]) => run('idb', [...args, '--udid', udid], { timeoutMs: 8_000 });
  try {
    const probe = await idb(['ui', 'describe-all', '--api', 'axbridge']);
    if (probe.exitCode !== 0) return undefined;
    parseElements(probe.stdout);
  } catch { return undefined; }

  const transcript = path.join(directory, 'idb.log');
  const lines: string[] = [];
  const trees: string[] = [];
  const screenshots: string[] = [];
  const execute = async (executable: string, args: string[], options?: RunOptions): Promise<ProcessResult> => {
    const result = await run(executable, args, options);
    lines.push(`${executable} ${args.slice(0, 2).join(' ')}: exit ${result.exitCode}, ${result.durationMs} ms`);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${executable} failed`);
    return result;
  };
  const elements = async (): Promise<Element[]> => parseElements((await execute('idb', ['ui', 'describe-all', '--api', 'axbridge', '--udid', udid])).stdout);
  const targetElement = async (target: Target): Promise<Element> => {
    const element = findElement(await elements(), target);
    if (!element) throw new Error(`Element not found: ${target.identifier ?? target.label}`);
    return element;
  };

  try {
    for (const [index, raw] of plan.actions.entries()) {
      const action = raw as Record<string, Record<string, unknown>>;
      const [kind] = Object.keys(action);
      const value = action[kind];
      if (kind === 'launch') {
        const stopped = await run('xcrun', ['simctl', 'terminate', udid, targetBundleId(config)]);
        if (stopped.exitCode !== 0 && !/not running|no such process|found nothing to terminate/i.test(stopped.stderr)) {
          throw new Error(stopped.stderr.trim() || 'Unable to terminate the app');
        }
        const environment = { ...process.env };
        for (const [key, entry] of Object.entries(value.environment ?? {})) environment[`SIMCTL_CHILD_${key}`] = String(entry);
        await execute('xcrun', ['simctl', 'launch', udid, targetBundleId(config), ...((value.arguments as string[] | undefined) ?? [])], { env: environment });
      } else if (kind === 'wait') {
        if (typeof value.duration === 'number') {
          await new Promise(resolve => setTimeout(resolve, value.duration as number * 1000));
        } else {
          const timeout = (value.timeout as number | undefined) ?? 5;
          const deadline = Date.now() + timeout * 1000;
          while (true) {
            if (findElement(await elements(), value as Target)) break;
            if (Date.now() >= deadline) throw new Error(`Element did not appear: ${value.identifier ?? value.label}`);
            await new Promise(resolve => setTimeout(resolve, 250));
          }
        }
      } else if (kind === 'tap' || kind === 'type') {
        if (kind === 'tap' && Number.isFinite(value.x) && Number.isFinite(value.y)) {
          await execute('idb', ['ui', 'tap', String(value.x), String(value.y), '--udid', udid]);
        } else {
          const target = value as Target;
          const element = await targetElement(target);
          const identifier = typeof element.AXUniqueId === 'string' && element.AXUniqueId.length > 0 ? element.AXUniqueId : undefined;
          const matchKey = identifier ? 'AXUniqueId' : 'AXLabel';
          const expectedKey = target.identifier !== undefined ? 'AXUniqueId' : 'AXLabel';
          await execute('idb', ['ui', 'tap', identifier ?? target.label!, '--match-key', matchKey,
            '--expected-key', expectedKey, '--expected-value', target.identifier ?? target.label!, '--api', 'axbridge', '--udid', udid]);
        }
        if (kind === 'type') await execute('idb', ['ui', 'text', '--udid', udid, '--', value.text as string]);
      } else if (kind === 'longPress') {
        const press = value as LongPress;
        const coordinates = Number.isFinite(press.x) && Number.isFinite(press.y)
          ? [press.x!, press.y!] : center(await targetElement(press));
        await execute('idb', ['ui', 'tap', String(Math.round(coordinates[0])), String(Math.round(coordinates[1])),
          '--duration', String(press.duration ?? 1), '--udid', udid]);
      } else if (kind === 'swipe') {
        const swipe = value as Swipe;
        const [from, to] = 'from' in swipe ? [swipe.from, swipe.to] : swipePoints((await targetElement(swipe)).frame ?? {}, swipe.direction);
        await execute('idb', ['ui', 'swipe', String(Math.round(from.x)), String(Math.round(from.y)),
          String(Math.round(to.x)), String(Math.round(to.y)), ...(swipe.duration === undefined ? [] : ['--duration', String(swipe.duration)]), '--udid', udid]);
      } else if (kind === 'assertVisible' || kind === 'assertValue') {
        const element = await targetElement(value as Target);
        if (kind === 'assertValue' && element.AXValue !== value.value) throw new Error(`Element value does not match: ${value.identifier ?? value.label}`);
      } else if (kind === 'screenshot') {
        const name = typeof value.name === 'string' ? value.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) : 'screen';
        const file = path.join(directory, 'screenshots', `${index}-${name}.png`);
        await mkdir(path.dirname(file), { recursive: true });
        await execute('idb', ['screenshot', file, '--udid', udid]);
        screenshots.push(path.relative(config.root, file));
      } else if (kind === 'inspect') {
        trees.push(JSON.stringify(await elements()));
      }
    }
    return {
      run: path.relative(config.root, directory), udid, bundleId: redact(targetBundleId(config), config.redactions ?? []),
      backend: 'idb', actions: plan.actions.length, runnerResult: { completed: plan.actions.length, bundleId: targetBundleId(config), trees },
      screenshots, transcript: path.relative(config.root, transcript),
    };
  } catch (error) {
    lines.push(`error: ${error instanceof Error ? error.message : String(error)}`);
    throw new CliError('UI_DELIVERY_FAILED', `The idb UI plan failed: ${redact(error instanceof Error ? error.message : String(error), config.redactions ?? [])}`, {
      transcript: path.relative(config.root, transcript),
    });
  } finally {
    await writeFile(transcript, `${redact(lines.join('\n'), config.redactions ?? [])}\n`, { mode: 0o600 });
  }
}
