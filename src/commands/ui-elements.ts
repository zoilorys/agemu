export type Frame = { x?: number; y?: number; width?: number; height?: number };
/** Raw element from `idb ui describe-all`. */
export type IdbElement = { AXUniqueId?: unknown; AXLabel?: unknown; AXValue?: unknown; type?: unknown; frame?: Frame; enabled?: unknown; selected?: unknown };

/** One element in the backend-neutral format returned by `inspect`. */
export type UiElement = {
  type: string;
  identifier?: string;
  label?: string;
  value?: string;
  frame: { x: number; y: number; width: number; height: number };
  visible: boolean;
  enabled?: boolean;
  selected?: boolean;
  depth?: number;
};
export type Inspection = { index: number; elements: UiElement[] };

/** Element serialized by AgentRunner.swift (`Node`). */
export type XctestNode = {
  type?: unknown; identifier?: unknown; label?: unknown; value?: unknown;
  x?: unknown; y?: unknown; width?: unknown; height?: unknown; enabled?: unknown; selected?: unknown; depth?: unknown;
};

const knownTypes = new Set(['application', 'window', 'button', 'staticText', 'textField', 'secureTextField', 'searchField', 'textView',
  'image', 'cell', 'switch', 'slider', 'link', 'scrollView', 'table', 'collectionView', 'navigationBar', 'tabBar', 'alert', 'keyboard']);

export function finiteFrame(frame: Frame | undefined): frame is Required<Frame> {
  return !!frame && [frame.x, frame.y, frame.width, frame.height].every(Number.isFinite);
}

/** Positive size and, when a screen frame is known, intersection with it. Shared by both backends. */
function frameVisible(frame: Frame | undefined, screen: Frame | undefined): boolean {
  if (!finiteFrame(frame) || frame.width <= 0 || frame.height <= 0) return false;
  if (!finiteFrame(screen)) return true;
  return frame.x < screen.x + screen.width && frame.x + frame.width > screen.x
    && frame.y < screen.y + screen.height && frame.y + frame.height > screen.y;
}

/**
 * Mirrors XCTest `exists && isHittable` as closely as the AX tree allows: a positive-size frame that intersects the
 * screen. The screen is the first `type === 'Application'` element's frame; if idb names that element differently
 * (the field varies by idb version), the intersection check is skipped.
 */
export function elementVisible(elements: IdbElement[], element: IdbElement | undefined): boolean {
  if (!element) return false;
  return frameVisible(element.frame, elements.find(candidate => candidate.type === 'Application')?.frame);
}

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return result === '' ? undefined : result;
}

function idbType(type: unknown): string {
  if (typeof type !== 'string' || type.length === 0) return 'other';
  const normalized = type[0].toLowerCase() + type.slice(1);
  return knownTypes.has(normalized) ? normalized : 'other';
}

function element(type: string, identifier: unknown, label: unknown, value: unknown, frame: Frame | undefined, screen: Frame | undefined): UiElement {
  const strings = { identifier: text(identifier), label: text(label), value: text(value) };
  return {
    type,
    ...(strings.identifier === undefined ? {} : { identifier: strings.identifier }),
    ...(strings.label === undefined ? {} : { label: strings.label }),
    ...(strings.value === undefined ? {} : { value: strings.value }),
    frame: finiteFrame(frame) ? { x: frame.x, y: frame.y, width: frame.width, height: frame.height } : { x: 0, y: 0, width: 0, height: 0 },
    visible: frameVisible(frame, screen),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function normalizeIdbElements(raw: unknown[]): UiElement[] {
  const elements = raw.filter(isRecord) as IdbElement[];
  const screen = elements.find(candidate => candidate.type === 'Application')?.frame;
  return elements.map((entry) => {
    const normalized = element(idbType(entry.type), entry.AXUniqueId, entry.AXLabel, entry.AXValue, entry.frame, screen);
    if (typeof entry.enabled === 'boolean') normalized.enabled = entry.enabled;
    if (typeof entry.selected === 'boolean') normalized.selected = entry.selected;
    return normalized;
  });
}

export function normalizeXctestNodes(raw: unknown): UiElement[] {
  if (!Array.isArray(raw)) return [];
  const nodes = raw.filter(isRecord) as XctestNode[];
  const frameOf = (node: XctestNode): Frame => ({ x: node.x as number, y: node.y as number, width: node.width as number, height: node.height as number });
  const application = nodes.find(node => node.type === 'application');
  const screen = application ? frameOf(application) : undefined;
  return nodes.map((node) => {
    const type = typeof node.type === 'string' && knownTypes.has(node.type) ? node.type : 'other';
    const normalized = element(type, node.identifier, node.label, node.value, frameOf(node), screen);
    if (typeof node.enabled === 'boolean') normalized.enabled = node.enabled;
    if (typeof node.selected === 'boolean') normalized.selected = node.selected;
    if (Number.isInteger(node.depth)) normalized.depth = node.depth as number;
    return normalized;
  });
}
