'use strict';
/* Shared vm sandbox for the app tests: loads app.js (and optionally insights.js) into one context with a fake DOM. */

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInContext, createContext } = require('node:vm');

const source = readFileSync(join(__dirname, '../app.js'), 'utf8');
const insightsSource = readFileSync(join(__dirname, '../insights.js'), 'utf8');
const storageKey = 'mtgscan.v1';
const json = (value) => JSON.parse(JSON.stringify(value));
const card = (id = 'sol-ring', overrides = {}) => ({
  id, oracle_id: 'sol-ring-oracle', name: 'Sol Ring', set: 'c21',
  set_name: 'Commander 2021', collector_number: '263', rarity: 'uncommon',
  type_line: 'Artifact', prices: { usd: '2.50', usd_foil: '5.00' }, ...overrides,
});

// `pixels(w, h)` lets a test supply the RGBA data a canvas's getImageData returns (default: all zeros)
function app({ raw, route, ocr = [], confirm = () => true, offlineStorage = false, mediaDevices, insights = false, all = {}, pixels } = {}) {
  const stored = new Map(raw === undefined ? [] : [[storageKey, raw]]);
  const requests = [], timers = new Map(), elements = new Map();
  let nextTimer = 0, tick = 0, reloads = 0;
  const element = (selector) => {
    if (!elements.has(selector)) {
      const set = new Set(); // Set-backed classList so tests can assert on .show / .hidden
      elements.set(selector, {
        value: '', checked: false, innerHTML: '',
        classList: {
          add: (...names) => names.forEach((n) => set.add(n)),
          remove: (...names) => names.forEach((n) => set.delete(n)),
          toggle: (name, force) => ((force === undefined ? !set.has(name) : !!force) ? set.add(name) : set.delete(name)),
          contains: (name) => set.has(name),
        },
        addEventListener() {}, querySelector: element, insertAdjacentHTML(_, html) { this.innerHTML += html; },
      });
    }
    return elements.get(selector);
  };
  const Tesseract = {
    async createWorker() {
      return {
        async setParameters() {},
        async recognize() {
          assert.ok(ocr.length, 'unexpected OCR call');
          return { data: { text: ocr.shift() } };
        },
      };
    },
  };
  const context = createContext({
    console: { warn() {} }, crypto: globalThis.crypto, navigator: { mediaDevices }, window: { Tesseract }, Tesseract, confirm,
    location: { reload: () => { reloads++; } },
    // Advance enough between calls to keep Scryfall's request pacing from needing real timers.
    Date: class extends Date { static now() { return Date.UTC(2026, 0, 1) + (tick += 1000); } },
    document: {
      // `all` lets a test hand querySelectorAll a list of fake elements for a selector (e.g. '[data-hand]')
      querySelector: element, querySelectorAll: (selector) => all[selector] || [], addEventListener() {},
      createElement(tag) {
        assert.equal(tag, 'canvas');
        return {
          getContext: () => ({
            drawImage() {}, putImageData() {},
            getImageData: (_, __, w, h) => ({ data: pixels ? pixels(w, h) : new Uint8ClampedArray(w * h * 4) }),
          }),
        };
      },
    },
    localStorage: {
      getItem(key) {
        if (offlineStorage) throw new Error('storage blocked');
        return stored.get(key) ?? null;
      },
      setItem: (key, value) => stored.set(key, value),
    },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    async fetch(url, options) {
      const parsed = new URL(url);
      const body = options.body && JSON.parse(options.body);
      requests.push({ url: parsed, body, method: options.method ?? 'GET' });
      assert.ok(route, 'unexpected request: ' + parsed);
      return route(parsed, body);
    },
  });
  runInContext(source, context, { filename: 'app.js' });
  // index.html loads insights.js right after app.js; both share one global scope
  if (insights) runInContext(insightsSource, context, { filename: 'insights.js' });
  return {
    stored, requests, element, reloads: () => reloads,
    state: () => context.window.__mtg.state(),
    insights: () => context.window.__insights,
    /** Evaluate an expression in the page scope, e.g. to read or set a top-level `let`. */
    eval: (code) => runInContext(code, context),
    call(name, ...args) {
      context.testArgs = args;
      return runInContext(name + '(...testArgs)', context);
    },
    advance(delay) {
      // fire every timer due at this delay: the scan loop's 150ms sleep and the 150ms save debounce
      // can both be pending, and firing only the first one leaves the scan loop a frame behind
      const due = [...timers].filter(([, timer]) => timer.delay === delay);
      assert.ok(due.length, 'expected a pending timer for ' + delay + 'ms');
      for (const [id, timer] of due) { timers.delete(id); timer.fn(); }
    },
    flush() {
      for (const [id, { fn }] of timers) { timers.delete(id); fn(); }
    },
  };
}

const ok = (data) => Response.json(data);
const failure = (status, details = 'not found') => Response.json({ details }, { status });
const saved = (overrides = {}) => ({ cards: {}, collection: [], decks: [], recent: [], ...overrides });

module.exports = { app, card, json, ok, failure, saved, storageKey };
