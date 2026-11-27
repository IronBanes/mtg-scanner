'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const source = readFileSync(join(__dirname, '../sw.js'), 'utf8');
const html = readFileSync(join(__dirname, '../index.html'), 'utf8');
const origin = 'https://scanner.example';
const root = origin + '/mtg-scanner/';
const appPath = html.match(/<script src="(app\.js\?v=\d+)"/)[1];
const stylePath = html.match(/<link rel="stylesheet" href="(style\.css\?v=\d+)"/)[1];
const version = Number(new URL(appPath, root).searchParams.get('v'));
// every versioned file index.html loads (app.js, insights.js, style.css, ...)
const versioned = [...html.matchAll(/(?:src|href)="([\w-]+\.(?:js|css)\?v=\d+)"/g)].map((m) => m[1]);
const current = 'mtgscan-r' + version;
const complete = '/__release-complete__';

function worker({ failInstall = false, network = () => new Response('from network') } = {}) {
  const listeners = new Map(), stores = new Map(), requests = [], precache = [];
  let skipped = 0, claimed = 0;
  const key = (request) => new URL(request.url ?? request, root).href;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async match(request) { return entries.get(key(request))?.clone(); },
        async put(request, response) { entries.set(key(request), response.clone()); },
        async addAll(shell) {
          precache.push(...shell);
          if (failInstall) throw new Error('download failed');
          for (const request of shell) entries.set(key(request), new Response('asset: ' + request.url));
        },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async match(request) {
      for (const entries of stores.values()) {
        const match = entries.get(key(request));
        if (match) return match.clone();
      }
    },
  };
  runInNewContext(source, {
    caches, location: { origin }, URL, Response,
    Request: class extends Request { constructor(path, options) { super(new URL(path, root), options); } },
    fetch: async (req) => { requests.push(req); return network(req); },
    self: {
      addEventListener: (type, listener) => listeners.set(type, listener),
      skipWaiting: () => { skipped++; },
      clients: { claim: async () => { claimed++; } },
    },
  }, { filename: 'sw.js' });
  async function dispatch(type, fields) {
    const work = [];
    let response;
    listeners.get(type)({ ...fields, waitUntil: (promise) => work.push(promise), respondWith: (promise) => { response = promise; } });
    const result = await response;
    await Promise.all(work);
    return result;
  }
  return {
    caches, dispatch, precache, requests,
    skipped: () => skipped, claimed: () => claimed,
    request: (path, options) => dispatch('fetch', { request: { url: key(path), method: 'GET', ...options } }),
    async seed(name, entries) {
      const cache = await caches.open(name);
      for (const [path, body] of Object.entries(entries)) await cache.put(path, new Response(body));
    },
  };
}

test('install stages the complete versioned shell and waits for explicit activation', async () => {
  const w = worker();
  await w.dispatch('install');
  assert.deepEqual(w.precache.map((r) => r.url).sort(), [
    './', 'index.html', ...versioned, 'manifest.webmanifest',
    'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  ].map((path) => new URL(path, root).href).sort());
  assert.ok(w.precache.every((r) => r.cache === 'reload'));
  assert.equal(await (await (await w.caches.open(current)).match(complete)).text(), 'ok');
  assert.equal(w.skipped(), 0);
  await w.dispatch('message', { data: 'unrelated' });
  assert.equal(w.skipped(), 0);
  await w.dispatch('message', { data: 'SKIP_WAITING' });
  assert.equal(w.skipped(), 1);
});

test('failed shell installation removes the new cache without touching the previous release', async () => {
  const w = worker({ failInstall: true });
  const previous = 'mtgscan-r' + (version - 1);
  await w.seed(current, { 'index.html': 'leftover partial download' });
  await w.seed(previous, { [complete]: 'ok' });
  await assert.rejects(w.dispatch('install'), /download failed/);
  assert.deepEqual(await w.caches.keys(), [previous]);
  assert.ok(await (await w.caches.open(previous)).match(complete));
});

test('activation keeps one complete previous release and preserves independent caches', async () => {
  const w = worker();
  const incomplete = 'mtgscan-r' + (version - 1);
  const previous = 'mtgscan-r' + (version - 2);
  const older = 'mtgscan-r' + (version - 3);
  const oldScript = 'app.js?v=' + (version - 2);
  await w.seed(incomplete, { 'index.html': 'incomplete' });
  await w.seed(older, { [complete]: 'ok' });
  await w.seed(previous, { [complete]: 'ok', './': 'old shell', [oldScript]: 'old script' });
  await w.seed(current, { [complete]: 'ok', './': 'current shell', [appPath]: 'current script' });
  await w.seed('mtgscan-ocr', {});
  await w.seed('unrelated', {});
  await w.dispatch('activate');
  assert.deepEqual((await w.caches.keys()).sort(), [previous, current, 'mtgscan-ocr', 'unrelated'].sort());
  assert.equal(w.claimed(), 1);
  assert.equal(await (await w.request('./collection', { mode: 'navigate' })).text(), 'current shell');
  assert.equal(await (await w.request(oldScript)).text(), 'old script');
  assert.equal(await (await w.request(appPath)).text(), 'current script');
  assert.equal(w.requests.length, 0);
});

test('uncached same-origin assets go to the network; Scryfall and non-GET requests pass through', async () => {
  const w = worker();
  assert.equal(await (await w.request('app.js?v=999')).text(), 'from network');
  assert.equal(await w.request('https://api.scryfall.com/cards/named?fuzzy=Opt'), undefined);
  assert.equal(await w.request(appPath, { method: 'POST' }), undefined);
  assert.deepEqual(w.requests.map((r) => r.url), [root + 'app.js?v=999']);
});

test('OCR assets are cached after success and remain retryable after an HTTP failure', async () => {
  const asset = 'https://cdn.example/tessdata/eng.traineddata.gz';
  let available = false;
  const w = worker({ network: () => available ? new Response('model') : new Response('unavailable', { status: 503 }) });
  assert.equal((await w.request(asset)).status, 503);
  available = true;
  assert.equal(await (await w.request(asset)).text(), 'model');
  available = false;
  assert.equal(await (await w.request(asset)).text(), 'model');
  assert.equal(w.requests.length, 2);
});

test('every versioned file in index.html matches the service worker VERSION', () => {
  const swVersion = Number(source.match(/const VERSION = '(\d+)'/)[1]);
  assert.ok(versioned.length >= 3, 'expected app.js, insights.js and style.css');
  for (const path of versioned) assert.equal(Number(path.split('?v=')[1]), swVersion, path + ' must match VERSION in sw.js');
});
