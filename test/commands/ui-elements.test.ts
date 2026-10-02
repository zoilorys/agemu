import { describe, expect, it } from 'vitest';
import { normalizeIdbElements, normalizeXctestNodes } from '../../src/commands/ui-elements.js';

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
      { type: 'application', label: 'Fixture', frame: { x: 0, y: 0, width: 390, height: 844 }, visible: true },
      { type: 'button', identifier: 'save', label: 'Save', frame: { x: 10, y: 20, width: 60, height: 30 }, visible: true, enabled: false },
      { type: 'other', label: 'Box', value: '3', frame: { x: 0, y: 100, width: 390, height: 44 }, visible: true },
      { type: 'staticText', label: 'No frame', frame: { x: 0, y: 0, width: 0, height: 0 }, visible: false },
      { type: 'staticText', label: 'Item 24', frame: { x: 0, y: 1440, width: 390, height: 44 }, visible: false },
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
});
