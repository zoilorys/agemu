import { describe, expect, it } from 'vitest';
import { normalizeIdbElements, normalizeXctestNodes, parseAppDisplayName, resolveTarget, type ElementTarget, type UiElement } from '../../src/commands/ui-elements.js';
import { readXctestResult } from '../../src/commands/ui-xctest-protocol.js';

describe('simctl appinfo display name', () => {
  it.each([
    ['the display name over the bundle name', '{\n    CFBundleDisplayName = NativeFixture;\n    CFBundleIdentifier = "dev.x";\n    CFBundleName = Other;\n}', 'NativeFixture'],
    ['a quoted bundle name when no display name exists', '{\n    CFBundleIdentifier = "dev.x";\n    CFBundleName = "My App";\n}', 'My App'],
    ['nothing for an uninstalled app', '{\n    CFBundleIdentifier = "dev.x";\n}', undefined],
  ])('returns %s', (_case, output, expected) => {
    expect(parseAppDisplayName(output)).toBe(expected);
  });
});

describe('target matching', () => {
  const frame = { x: 0, y: 0, width: 10, height: 10 };
  const tree: UiElement[] = [
    // XCTest never matches the application root, so neither backend does.
    { type: 'application', label: 'Save app', frame, visible: true, depth: null },
    { type: 'button', identifier: 'saveButton', label: 'Save', frame, visible: true, depth: null },
    { type: 'button', label: 'Save draft', frame, visible: true, depth: null },
    { type: 'staticText', label: 'Save status', frame, visible: true, depth: null },
    ...[0, 1, 2, 3].map((n): UiElement => ({ type: 'staticText', identifier: 'row', label: `Item ${n}`, frame, visible: true, depth: null })),
  ];

  it.each<[ElementTarget, string | undefined]>([
    [{ identifier: 'row', index: 3 }, 'Item 3'],
    [{ identifier: 'row' }, 'Item 0'],
    [{ labelContains: 'Save' }, 'Save'],
    [{ labelContains: 'Save', index: 1 }, 'Save draft'],
    [{ labelContains: 'save' }, undefined],
    [{ label: 'Save' }, 'Save'],
    [{ label: 'Save', index: 1 }, undefined],
    [{ labelContains: 'Save', type: 'staticText' }, 'Save status'],
    [{ labelContains: 'Item', type: 'button' }, undefined],
    [{ identifier: 'row', labelContains: '2' }, 'Item 2'],
    [{ identifier: 'row', index: 4 }, undefined],
    [{ label: 'Save app' }, undefined],
  ])('%j resolves to %s', (target, label) => {
    const position = resolveTarget(tree, target);
    expect(position === undefined ? undefined : tree[position]!.label).toBe(label);
  });
});

describe('idb element normalization', () => {
  it('maps idb fields, falls back to other, and applies the screen visibility rule', () => {
    expect(normalizeIdbElements([
      { type: 'Application', AXLabel: 'Fixture', frame: { x: 0, y: 0, width: 390, height: 844 } },
      { type: 'Button', AXUniqueId: 'save', AXLabel: 'Save', AXValue: '', enabled: false, frame: { x: 10, y: 20, width: 60, height: 30 } },
      { type: 'Group', AXUniqueId: '', AXLabel: 'Box', AXValue: 3, frame: { x: 0, y: 100, width: 390, height: 44 } },
      { type: 'StaticText', AXLabel: 'No frame' },
      { type: 'StaticText', AXLabel: 'Item 24', frame: { x: 0, y: 1440, width: 390, height: 44 } },
      'not an element',
    ])).toEqual([
      { type: 'application', label: 'Fixture', frame: { x: 0, y: 0, width: 390, height: 844 }, visible: true, depth: null },
      { type: 'button', identifier: 'save', label: 'Save', frame: { x: 10, y: 20, width: 60, height: 30 }, visible: true, depth: null, enabled: false },
      { type: 'other', label: 'Box', value: '3', frame: { x: 0, y: 100, width: 390, height: 44 }, visible: true, depth: null },
      { type: 'staticText', label: 'No frame', frame: { x: 0, y: 0, width: 0, height: 0 }, visible: false, depth: null },
      { type: 'staticText', label: 'Item 24', frame: { x: 0, y: 1440, width: 390, height: 44 }, visible: false, depth: null },
    ]);
  });
});

describe('XCTest node normalization', () => {
  const node = (fields: Record<string, unknown>) => ({
    type: 'other', identifier: '', label: '', value: '', x: 0, y: 0, width: 0, height: 0, enabled: true, selected: false, depth: 0, ...fields,
  });

  it('omits empty strings and computes visibility against the application frame', () => {
    expect(normalizeXctestNodes([
      node({ type: 'application', label: 'Fixture', width: 390, height: 844 }),
      node({ type: 'textField', identifier: 'nameField', value: 'Name', x: 20, y: 155, width: 200, height: 36, depth: 3 }),
      node({ type: 'staticText', identifier: 'row', label: 'Item 24', x: 20, y: 1680, width: 300, height: 50, selected: true, depth: 4 }),
      node({ type: 'unexpected', depth: 1 }),
    ])).toEqual([
      { type: 'application', label: 'Fixture', frame: { x: 0, y: 0, width: 390, height: 844 }, visible: true, enabled: true, selected: false, depth: 0 },
      { type: 'textField', identifier: 'nameField', value: 'Name', frame: { x: 20, y: 155, width: 200, height: 36 }, visible: true,
        enabled: true, selected: false, depth: 3 },
      { type: 'staticText', identifier: 'row', label: 'Item 24', frame: { x: 20, y: 1680, width: 300, height: 50 }, visible: false,
        enabled: true, selected: true, depth: 4 },
      { type: 'other', frame: { x: 0, y: 0, width: 0, height: 0 }, visible: false, enabled: true, selected: false, depth: 1 },
    ]);
  });

  it('preserves cached frames while excluding background nodes and accepts legacy geometry-only nodes', () => {
    const button = node({ type: 'button', identifier: 'saveButton', x: 20, y: 30, width: 60, height: 30, enabled: false });
    const elements = normalizeXctestNodes([
      node({ type: 'application', width: 390, height: 844, visible: false }),
      { ...button, visible: false },
      { ...button, visible: true },
      button,
      { ...button, width: 0, visible: true },
    ]);
    expect(elements.map(element => element.visible)).toEqual([false, false, true, true, false]);
    expect(elements[1]).toMatchObject({ frame: { x: 20, y: 30, width: 60, height: 30 }, enabled: false });
  });

  it('rejects non-boolean visibility telemetry rather than interpreting it as foreground evidence', () => {
    const marker = 'AGEMU_RESULT:' + Buffer.from(JSON.stringify({ completed: 1, bundleId: 'dev.fixture',
      inspections: [{ index: 0, nodes: [node({ visible: 'false' })] }],
    })).toString('base64');
    expect(() => readXctestResult(marker, { version: 1, actions: [{ inspect: {} }] }, 'dev.fixture')).toThrow('malformed inspection node');
  });
});


describe('backend-neutral visibility and depth', () => {
  it('uses nonempty screen intersection for disabled and partially clipped elements on both backends', () => {
    const frames = [
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 90, y: 20, width: 20, height: 10 }, // partly clipped, disabled, still visible
      { x: 100, y: 20, width: 20, height: 10 }, // touching the screen edge is not intersection
      { x: 20, y: 100, width: 20, height: 10 },
      { x: 20, y: 20, width: 0, height: 10 },
      { x: Number.NaN, y: 20, width: 20, height: 10 },
    ];
    const idb = normalizeIdbElements(frames.map((frame, index) => ({
      type: index === 0 ? 'Application' : 'Button', frame, enabled: false,
    })));
    const xctest = normalizeXctestNodes(frames.map((frame, index) => ({
      type: index === 0 ? 'application' : 'button', ...frame, enabled: false,
    })));
    expect(idb.map(element => element.visible)).toEqual([true, true, false, false, false, false]);
    expect(xctest.map(element => element.visible)).toEqual([true, true, false, false, false, false]);
    expect(idb.every(element => element.depth === null)).toBe(true);
    expect(xctest.every(element => element.depth === null)).toBe(true);
  });

  it('marks malformed depth as explicitly unavailable while retaining root depth zero', () => {
    const nodes = normalizeXctestNodes([0, 3, -1, 1.5, null].map(depth => ({ type: 'button', depth })));
    expect(nodes.map(element => element.depth)).toEqual([0, 3, null, null, null]);
  });
});
