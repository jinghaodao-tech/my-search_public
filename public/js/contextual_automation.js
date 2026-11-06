// Contextual assistance is a local presentation decision, separate from AI work.
// No query, article text, memo, or interaction history is persisted here.
(function (root) {
  'use strict';

  const STORAGE_KEY = 'mySearch:contextualAutomation:v1';
  const DEFAULTS = Object.freeze({ f1: true, f2: true, f3: true, f4: true, f5: false, f6: true });
  const suppressed = new Map();

  function read() {
    try {
      const saved = JSON.parse(root.localStorage.getItem(STORAGE_KEY) || '{}');
      return Object.fromEntries(Object.keys(DEFAULTS).map(id => [id, typeof saved[id] === 'boolean' ? saved[id] : DEFAULTS[id]]));
    } catch { return { ...DEFAULTS }; }
  }

  function setEnabled(id, enabled) {
    if (!Object.hasOwn(DEFAULTS, id)) return false;
    const settings = read();
    settings[id] = Boolean(enabled);
    try { root.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { return false; }
    return true;
  }

  function resolve(id, context) {
    const state = context || {};
    if (!Object.hasOwn(DEFAULTS, id)) return 'unavailable';
    if (state.available === false) return 'unavailable';
    if (!read()[id]) return 'suppressed';
    const key = `${id}:${String(state.contextKey || '')}`;
    if (suppressed.get(id) === key) return 'suppressed';
    if (state.active === true) return 'active';
    return state.eligible === true ? 'eligible' : 'ineligible';
  }

  function suppress(id, contextKey) {
    if (!Object.hasOwn(DEFAULTS, id)) return;
    suppressed.set(id, `${id}:${String(contextKey || '')}`);
  }

  function clearSuppression(id) { suppressed.delete(id); }

  function initSettings() {
    const settings = read();
    for (const [id, checked] of Object.entries(settings)) {
      const input = document.querySelector(`[data-context-feature="${id}"]`);
      if (input) input.checked = checked;
    }
  }

  root.isContextualFeatureEnabled = function (id) { return Object.hasOwn(DEFAULTS, id) && read()[id]; };
  root.setContextualFeature = function (id, enabled) {
    if (!setEnabled(id, enabled)) {
      const input = document.querySelector(`[data-context-feature="${id}"]`);
      if (input) input.checked = read()[id];
      if (typeof root.toast === 'function') root.toast('設定を保存できませんでした', 'warn');
      return;
    }
    if (root.ContextualStudy) root.ContextualStudy.record({ feature: id, event: 'settings_changed', trigger: 'setting', mode: enabled ? 'contextual' : 'off' });
    if (typeof root.toast === 'function') root.toast(enabled ? '補助機能を有効にしました' : '補助機能を停止しました');
  };
  root.openContextualSettings = function () { initSettings(); root.openModal('modal-contextual-settings'); };

  root.ContextualAutomation = Object.freeze({ read, setEnabled, resolve, suppress, clearSuppression, initSettings });
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initSettings);
})(typeof window !== 'undefined' ? window : globalThis);
