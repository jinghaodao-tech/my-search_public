import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadAutomation(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const sandbox: Record<string, unknown> = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    },
    document: { addEventListener() {}, querySelector() { return null; } },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), 'public/js/contextual_automation.js'), 'utf8'), sandbox);
  return sandbox.ContextualAutomation as {
    read(): Record<string, boolean>;
    setEnabled(id: string, value: boolean): boolean;
    resolve(id: string, state: Record<string, unknown>): string;
    suppress(id: string, key: string): void;
    clearSuppression(id: string): void;
  };
}

describe('contextual feature availability and controls', () => {
  it('defaults the experimental tool proposal to off and separates eligible, active and unavailable states', () => {
    const automation = loadAutomation();
    expect(automation.read()).toMatchObject({ f1: true, f2: true, f3: true, f4: true, f5: false, f6: true });
    expect(automation.resolve('f1', { eligible: false })).toBe('ineligible');
    expect(automation.resolve('f1', { eligible: true })).toBe('eligible');
    expect(automation.resolve('f1', { eligible: true, active: true })).toBe('active');
    expect(automation.resolve('f1', { eligible: true, available: false })).toBe('unavailable');
    expect(automation.resolve('f5', { eligible: true })).toBe('suppressed');
  });

  it('supports per-feature off/on and suppresses only the same current context', () => {
    const automation = loadAutomation();
    expect(automation.setEnabled('f1', false)).toBe(true);
    expect(automation.resolve('f1', { eligible: true, contextKey: 'a' })).toBe('suppressed');
    expect(automation.setEnabled('f1', true)).toBe(true);
    automation.suppress('f1', 'a');
    expect(automation.resolve('f1', { eligible: true, contextKey: 'a' })).toBe('suppressed');
    expect(automation.resolve('f1', { eligible: true, contextKey: 'b' })).toBe('eligible');
    automation.clearSuppression('f1');
    expect(automation.resolve('f1', { eligible: true, contextKey: 'a' })).toBe('eligible');
  });
});
