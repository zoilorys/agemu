import { CliError } from '../core/errors.js';
import { normalizeXctestNodes, type Inspection } from './ui-elements.js';
import type { UiPlan } from './ui-plan.js';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function invalid(message: string): never { throw new CliError('UI_DELIVERY_FAILED', `Invalid XCTest runner result: ${message}`); }

function decode(encoded: string): unknown {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) || !encoded) invalid('malformed base64 marker');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) invalid('malformed base64 marker');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { return invalid('malformed or truncated JSON marker'); }
}

function inspection(value: unknown, plan: UiPlan): Inspection {
  if (!record(value) || !Number.isSafeInteger(value.index) || (value.index as number) < 0 ||
    (value.index as number) >= plan.actions.length || !plan.actions[value.index as number].inspect || !Array.isArray(value.nodes)) invalid('invalid inspection action index or nodes');
  for (const node of value.nodes as unknown[]) {
    if (!record(node) || typeof node.type !== 'string' ||
      !['x', 'y', 'width', 'height'].every(field => typeof node[field] === 'number' && Number.isFinite(node[field])) ||
      !['identifier', 'label', 'value'].every(field => node[field] === undefined || typeof node[field] === 'string') ||
      typeof node.enabled !== 'boolean' || typeof node.selected !== 'boolean' ||
      (node.visible !== undefined && typeof node.visible !== 'boolean') ||
      !Number.isSafeInteger(node.depth) || (node.depth as number) < 0) invalid('malformed inspection node');
  }
  return { index: value.index as number, elements: normalizeXctestNodes(value.nodes) };
}

/** Exit zero is only successful after exactly one complete, matching runner result. */
export function readXctestResult(stdout: string, plan: UiPlan, bundleId: string) {
  const markers = stdout.split(/\r?\n/).filter(line => line.includes('AGEMU_RESULT:'));
  if (markers.length !== 1) invalid(`expected exactly one AGEMU_RESULT marker, got ${markers.length}`);
  const value = decode(markers[0].slice(markers[0].indexOf('AGEMU_RESULT:') + 13).trim());
  if (!record(value) || value.bundleId !== bundleId) invalid('bundleId does not match the submitted plan');
  if (!Number.isSafeInteger(value.completed) || value.completed !== plan.actions.length) invalid('completed action count does not match the submitted plan');
  if (!Array.isArray(value.inspections)) invalid('inspections must be an array');
  const inspections = value.inspections.map(entry => inspection(entry, plan));
  const expected = plan.actions.flatMap((action, index) => action.inspect ? [index] : []);
  if (inspections.length !== expected.length || inspections.some((entry, position) => entry.index !== expected[position])) invalid('inspection actions are missing, duplicated or out of order');
  return { completed: value.completed as number, bundleId, inspections };
}

/** Completed inspections printed during execution survive a later action failure or process timeout. */
export function readPartialInspections(stdout: string, plan: UiPlan): Inspection[] {
  const result: Inspection[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const position = line.indexOf('AGEMU_INSPECTION:');
    if (position < 0) continue;
    try {
      const entry = inspection(decode(line.slice(position + 17).trim()), plan);
      if (!result.some(previous => previous.index === entry.index)) result.push(entry);
    } catch { /* Damaged partial telemetry cannot replace the primary failure. */ }
  }
  return result.sort((a, b) => a.index - b.index);
}

/** Only an attempt actually reached by the runner may replace launch evidence. */
export function readReachedLaunch(stdout: string, plan: UiPlan): { index: number; at: string } | undefined {
  let latest: { index: number; at: string } | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const position = line.indexOf('AGEMU_LAUNCH:');
    if (position < 0) continue;
    try {
      const value = decode(line.slice(position + 13).trim());
      if (!record(value) || !Number.isSafeInteger(value.index) || (value.index as number) < 0 ||
        !plan.actions[value.index as number]?.launch || typeof value.at !== 'string' ||
        !Number.isFinite(Date.parse(value.at)) || new Date(value.at).toISOString() !== value.at) continue;
      if (!latest || (value.index as number) >= latest.index) latest = { index: value.index as number, at: value.at };
    } catch { /* Incomplete launch telemetry never invents an attempt. */ }
  }
  return latest;
}
