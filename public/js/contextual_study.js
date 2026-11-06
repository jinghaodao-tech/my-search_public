// Optional, local-only instrumentation for future contextual-feature comparisons.
// The opt-in event log excludes article text, queries, URLs, memo text, card IDs, and page history.
(function (root) {
  'use strict';

  const CONSENT_KEY = 'mySearch:contextualStudy:consent:v1';
  const EVENTS_KEY = 'mySearch:contextualStudy:events:v1';
  const MAX_EVENTS = 5000;
  const FEATURES = new Set(['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
  const EVENT_NAMES = new Set(['shown', 'started', 'completed', 'ignored', 'cancelled', 'failed', 'settings_changed']);
  const TRIGGERS = new Set(['snippet_match', 'search_no_results', 'search_api_error', 'quote_selected', 'draft_available', 'numeric_selection', 'search_result', 'reader_session', 'saved_search', 'user_action', 'setting']);
  const MODES = new Set(['contextual', 'manual', 'safe_auto', 'off']);
  const PROCESSORS = new Set(['rules', 'chrome_local', 'configured_server', 'mock', 'none']);
  const OUTCOMES = new Set(['ok', 'unavailable', 'error', 'ambiguous', 'unmatched', 'cancelled', 'discarded', 'retry', 'accepted', 'ignored']);
  let eventsCache = null;
  let flushTimer = null;
  let hasPendingWrites = false;

  function hasConsent() {
    try { return root.localStorage.getItem(CONSENT_KEY) === 'true'; } catch { return false; }
  }

  function safeEnum(value, allowed) { return allowed.has(value) ? value : undefined; }

  function enabledSnapshot() {
    try {
      const config = root.ContextualAutomation?.read?.() || {};
      return Object.fromEntries([...FEATURES].map(feature => [feature, Boolean(config[feature])]));
    } catch { return {}; }
  }

  function readEvents() {
    if (eventsCache) return eventsCache;
    try {
      const parsed = JSON.parse(root.localStorage.getItem(EVENTS_KEY) || '[]');
      eventsCache = Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object').slice(-MAX_EVENTS) : [];
    } catch { eventsCache = []; }
    return eventsCache;
  }

  function flushEvents() {
    if (!hasPendingWrites) return true;
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    try {
      root.localStorage.setItem(EVENTS_KEY, JSON.stringify(eventsCache || []));
      hasPendingWrites = false;
      return true;
    } catch { return false; }
  }

  function record(input) {
    if (!hasConsent() || !input || !FEATURES.has(input.feature) || !EVENT_NAMES.has(input.event)) return false;
    const entry = {
      schema: 'my-search-contextual-study-v1',
      featureVersion: `contextual-${input.feature}-v1`,
      at: new Date().toISOString(),
      feature: input.feature,
      event: input.event,
      mode: safeEnum(input.mode, MODES) || (input.event === 'started' ? 'manual' : 'contextual'),
      trigger: safeEnum(input.trigger, TRIGGERS) || 'user_action',
      enabled: enabledSnapshot()[input.feature] === true,
    };
    const processor = safeEnum(input.processor, PROCESSORS);
    const outcome = safeEnum(input.outcome, OUTCOMES);
    if (processor) entry.processor = processor;
    if (outcome) entry.outcome = outcome;
    if (Number.isFinite(input.latencyMs) && input.latencyMs >= 0) entry.latencyMs = Math.round(input.latencyMs);
    try {
      const events = readEvents();
      events.push(entry);
      eventsCache = events.slice(-MAX_EVENTS);
      hasPendingWrites = true;
      if (flushTimer === null) flushTimer = setTimeout(flushEvents, 250);
      const count = document.getElementById('contextual-study-count');
      if (count) count.textContent = `${eventsCache.length}件をこのブラウザーに記録`;
      const exportButton = document.getElementById('contextual-study-export');
      if (exportButton) exportButton.disabled = false;
      return true;
    } catch { return false; }
  }

  function setConsent(enabled) {
    if (!enabled) flushEvents();
    try { root.localStorage.setItem(CONSENT_KEY, enabled ? 'true' : 'false'); }
    catch { return false; }
    updateControls();
    return true;
  }

  function exportEvents() {
    if (!hasConsent()) return false;
    flushEvents();
    const blob = new Blob([JSON.stringify({ schema: 'my-search-contextual-study-v1', exportedAt: new Date().toISOString(), events: readEvents() }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'my-search-contextual-study.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  }

  function clearEvents() {
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    hasPendingWrites = false;
    try { root.localStorage.removeItem(EVENTS_KEY); } catch { return false; }
    eventsCache = [];
    updateControls();
    return true;
  }

  function updateControls() {
    if (typeof document === 'undefined') return;
    const consent = document.getElementById('contextual-study-consent');
    if (consent) consent.checked = hasConsent();
    const count = document.getElementById('contextual-study-count');
    if (count) count.textContent = hasConsent() ? `${readEvents().length}件をこのブラウザーに記録` : '記録は停止中です';
    const exportButton = document.getElementById('contextual-study-export');
    if (exportButton) exportButton.disabled = !hasConsent() || readEvents().length === 0;
  }

  root.setContextualStudyConsent = function (checked) {
    if (!setConsent(Boolean(checked))) {
      updateControls();
      if (typeof root.toast === 'function') root.toast('研究記録の設定を保存できませんでした', 'warn');
    }
  };
  root.exportContextualStudyEvents = exportEvents;
  root.clearContextualStudyEvents = function () {
    if (clearEvents() && typeof root.toast === 'function') root.toast('状況別補助機能の記録を削除しました');
  };
  root.ContextualStudy = Object.freeze({ hasConsent, record, readEvents, setConsent, clearEvents, updateControls });
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', updateControls);
    root.addEventListener?.('pagehide', flushEvents);
  }
})(typeof window !== 'undefined' ? window : globalThis);
