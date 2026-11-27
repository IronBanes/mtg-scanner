'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInContext, createContext } = require('node:vm');

const source = readFileSync(join(__dirname, '../app.js'), 'utf8');
const storageKey = 'mtgscan.v1';
const json = (value) => JSON.parse(JSON.stringify(value));
const card = (id = 'sol-ring', overrides = {}) => ({
  id, oracle_id: 'sol-ring-oracle', name: 'Sol Ring', set: 'c21',
  set_name: 'Commander 2021', collector_number: '263', rarity: 'uncommon',
  type_line: 'Artifact', prices: { usd: '2.50', usd_foil: '5.00' }, ...overrides,
});

function app({ raw, route, ocr = [], confirm = () => true, offlineStorage = false, mediaDevices } = {}) {
  const stored = new Map(raw === undefined ? [] : [[storageKey, raw]]);
  const requests = [], timers = new Map(), elements = new Map();
  let nextTimer = 0, tick = 0;
  const element = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        value: '', checked: false, innerHTML: '', classList: { add() {}, remove() {}, toggle() {} },
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
    console: { warn() {} }, navigator: { mediaDevices }, window: { Tesseract }, Tesseract, confirm,
    // Advance enough between calls to keep Scryfall's request pacing from needing real timers.
    Date: class extends Date { static now() { return Date.UTC(2026, 0, 1) + (tick += 1000); } },
    document: {
      querySelector: element, querySelectorAll: () => [], addEventListener() {},
      createElement(tag) {
        assert.equal(tag, 'canvas');
        return {
          getContext: () => ({
            drawImage() {}, putImageData() {},
            getImageData: (_, __, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
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
  return {
    stored, requests, element,
    state: () => context.window.__mtg.state(),
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

test('loads legacy data with default settings and persists only cards in use', () => {
  const cards = Object.fromEntries(['owned', 'scanned', 'decked', 'unused'].map((id) => [
    id, { id, name: 'Sol Ring', oracle_id: 'sol-ring-oracle', set: 'c21' },
  ]));
  const a = app({ raw: JSON.stringify(saved({
    cards, settings: { exact: false },
    collection: [{ cardId: 'owned', qty: 1 }],
    recent: [{ cardId: 'scanned' }],
    decks: [{ id: 'deck', name: 'My deck', cards: [{ cardId: 'decked', qty: 1, board: 'main' }] }],
  })) });
  assert.deepEqual(json(a.state().settings), { dest: 'none', sound: true, exact: false });
  a.call('addTo', 'collection', 'owned', false, 2);
  a.flush();
  const data = JSON.parse(a.stored.get(storageKey));
  assert.equal(data.schema, 1);
  assert.equal(data.collection[0].qty, 3);
  assert.deepEqual(Object.keys(data.cards).sort(), ['decked', 'owned', 'scanned']);
  assert.ok(a.state().cards.unused);
});

for (const [label, raw] of [
  ['malformed JSON', '{'],
  ['invalid nested quantity', JSON.stringify(saved({
    decks: [{ id: 'deck', name: 'Deck', cards: [{ cardId: 'sol-ring', qty: 0 }] }],
  }))],
]) {
  test('preserves the original bytes and makes a safety copy for ' + label, () => {
    const a = app({ raw });
    a.call('addTo', 'collection', 'sol-ring', false);
    a.flush();
    assert.equal(a.stored.get(storageKey), raw);
    const copies = [...a.stored].filter(([key]) => /^mtgscan\.safety\.unreadable-/.test(key));
    assert.equal(copies.length, 1);
    assert.equal(copies[0][1], raw);
  });
}

test('a newer save can be read but cannot be overwritten by an older app', () => {
  const raw = JSON.stringify(saved({ schema: 2, collection: [{ cardId: 'sol-ring', qty: 3 }] }));
  const a = app({ raw });
  assert.equal(a.state().collection[0].qty, 3);
  a.call('addTo', 'collection', 'sol-ring', false);
  a.flush();
  assert.equal(a.stored.get(storageKey), raw);
  assert.match(a.element('#toast').innerHTML, /older than your data/);
});

test('storage that cannot be read is never written', () => {
  const a = app({ offlineStorage: true });
  a.call('addTo', 'collection', 'sol-ring', false);
  a.flush();
  assert.equal(a.stored.size, 0);
});

test('backup restore rejects damaged inputs and can recover a blocked save', async () => {
  const a = app({ raw: '{' });
  a.element('#settingsBtn').onclick();
  const restore = async (data) => {
    await a.element('#bkImport').onchange({ target: { files: [{ text: async () => JSON.stringify(data) }] } });
    a.flush();
  };
  await restore(saved());
  assert.equal(a.stored.get(storageKey), '{');
  assert.match(a.element('#toast').innerHTML, /Not an MTG Scanner backup/);
  await restore({ app: 'mtgscan', ...saved({ cards: { a: { id: 'b' } } }) });
  assert.equal(a.stored.get(storageKey), '{');
  assert.match(a.element('#toast').innerHTML, /card data/);
  await restore({ app: 'mtgscan', ...saved({ recent: [{ cardId: 'sol-ring' }] }) });
  assert.deepEqual(JSON.parse(a.stored.get(storageKey)).recent, [{ cardId: 'sol-ring' }]);
});

test('scan-only logs price checks; bulk add counts each scan once', () => {
  const a = app();
  const c = a.call('cache', card());
  a.element('#foilToggle').checked = true;
  a.call('addScanned', c);
  a.call('addScanned', c);
  assert.equal(a.state().collection.length, 0);
  assert.equal(a.element('#recentTotal').textContent, '2 · $10.00');
  a.element('#recentAddAllBtn').onclick();
  a.element('#bulkDest').value = 'collection';
  a.element('#bulkGo').onclick();
  a.element('#recentAddAllBtn').onclick();
  assert.deepEqual(json(a.state().collection).map(({ cardId, foil, qty }) => ({ cardId, foil, qty })), [
    { cardId: 'sol-ring', foil: true, qty: 2 },
  ]);
  assert.match(a.element('#toast').innerHTML, /No unsaved scans/);
});

test('scan undo removes only its own foil copy and recent entry', () => {
  const a = app();
  const c = a.call('cache', card());
  a.state().settings.dest = 'collection';
  a.call('addTo', 'collection', c.id, false, 2);
  a.element('#foilToggle').checked = true;
  a.call('addScanned', c);
  a.element('button').onclick();
  assert.equal(a.state().recent.length, 0);
  assert.equal(a.state().collection.length, 1);
  assert.equal(a.state().collection[0].foil, false);
  assert.equal(a.state().collection[0].qty, 2);
});

test('totals group printings by card identity and exclude Maybe from deck value', () => {
  const a = app();
  a.call('cache', card());
  a.call('cache', card('alternate', { prices: { usd_etched: '3.75' } }));
  a.call('addTo', 'collection', 'sol-ring', false, 2);
  a.call('addTo', 'collection', 'alternate', true);
  assert.deepEqual(json(a.call('collectionTotals')), { cards: 3, value: 8.75, unique: 1 });
  assert.equal(a.call('ownedCount', 'sol-ring-oracle'), 3);
  const d = a.call('createDeck', 'Board tests');
  a.call('addTo', d.id, 'sol-ring', false, 2);
  a.call('addTo', d.id, 'sol-ring', false, 1, 'side');
  a.call('addTo', d.id, 'sol-ring', false, 4, 'maybe');
  a.call('addTo', d.id, 'sol-ring', true);
  a.call('removeFrom', d.id, 'sol-ring', false, 5, 'side');
  assert.deepEqual(json(a.call('deckTotals', d)), { cards: 3, value: 10 });
  assert.equal(a.call('deckText', d), '2 Sol Ring\n1 Sol Ring');
  assert.equal(d.cards.find((entry) => entry.board === 'maybe').qty, 4);
});

test('deck text preserves commander and sideboard placement', () => {
  const a = app();
  a.call('cache', card());
  a.call('cache', card('opt', { name: 'Opt' }));
  a.call('cache', card('commander', { name: 'Alela, Artful Provocateur' }));
  const items = [
    { cardId: 'opt', qty: 1, board: 'side' },
    { cardId: 'sol-ring', qty: 2, board: 'main' },
    { cardId: 'commander', qty: 1, board: 'commander' },
    { cardId: 'opt', qty: 3, board: 'maybe' },
  ];
  assert.equal(a.call('deckText', { cards: items }), '1 Alela, Artful Provocateur\n2 Sol Ring\n\nSideboard\n1 Opt');
});

test('CSV quotes commas and escaped quotes and exports the selected finish price', () => {
  const a = app();
  a.call('cache', card('alela', { name: 'Alela, Artful Provocateur', set_name: 'Set "One"' }));
  const csv = a.call('toCsv', [{ cardId: 'alela', qty: 2, foil: true, board: 'side' }, { cardId: 'missing' }]);
  const [header, row, ...rest] = csv.split('\r\n');
  assert.match(header, /^Count,Name,Edition,Set Code,Collector Number,Foil,Board,/);
  assert.equal(row, '2,"Alela, Artful Provocateur","Set ""One""",C21,263,foil,side,uncommon,Artifact,5.00,10.00,alela');
  assert.deepEqual(rest, []);
  assert.deepEqual(json(a.call('parseList', csv)), [
    { qty: 2, name: 'Alela, Artful Provocateur', set: 'c21', cn: '263', foil: true, board: 'side' },
  ]);
});

test('plain list parser respects board headings, SB prefixes, and printing annotations', () => {
  const a = app();
  const input = '// deck notes\r\nCommander:\r\nAlela, Artful Provocateur\r\nDeck\r\n2x Sol Ring (C21) 263 *F*\r\nSB: 3 Opt\r\nSideboard\r\nNegate (foil)';
  assert.deepEqual(json(a.call('parseList', input)), [
    { qty: 1, name: 'Alela, Artful Provocateur', set: '', cn: '', foil: false, board: 'commander' },
    { qty: 2, name: 'Sol Ring', set: 'c21', cn: '263', foil: true, board: 'main' },
    { qty: 3, name: 'Opt', set: '', cn: '', foil: false, board: 'side' },
    { qty: 1, name: 'Negate', set: '', cn: '', foil: true, board: 'side' },
  ]);
});

test('import matches results around missing entries and reports unresolved names', async () => {
  const reports = [];
  const a = app({ route: (url, body) => {
    if (url.pathname === '/cards/collection') {
      assert.deepEqual(body.identifiers, [
        { set: 'c21', collector_number: '263' }, { name: 'Nonsense' }, { name: 'Opt' }, { name: 'Negat' },
      ]);
      return ok({ data: [card(), card('opt', { name: 'Opt' })], not_found: [{ name: 'Nonsense' }, { name: 'Negat' }] });
    }
    if (url.searchParams.get('fuzzy') === 'Negat') return ok(card('negate', { name: 'Negate' }));
    return failure(404);
  } });
  const d = a.call('createDeck', 'Import');
  await a.call('importList', '2 Sol Ring (C21) 263\n9 Nonsense\nSideboard\n3 Opt\n1 Negat (foil)', d.id, (m) => reports.push(m));
  assert.deepEqual(json(d.cards), [
    { cardId: 'sol-ring', qty: 2, foil: false, board: 'main' },
    { cardId: 'opt', qty: 3, foil: false, board: 'side' },
    { cardId: 'negate', qty: 1, foil: true, board: 'side' },
  ]);
  assert.equal(reports.at(-1), 'Imported 6 cards. Not found: Nonsense');
});

test('second batch failure leaves existing quantities intact and allows a safe retry', async () => {
  let fail = true;
  const reports = [];
  const a = app({ route: (_url, { identifiers }) => {
    if (identifiers.length === 1 && fail) return failure(503, 'offline');
    return ok({ data: identifiers.map(() => card()) });
  } });
  a.call('addTo', 'collection', 'sol-ring', false, 2);
  const input = Array(76).fill('Sol Ring').join('\n');
  const doImport = () => a.call('importList', input, 'collection', (m) => reports.push(m));
  await doImport();
  assert.equal(a.state().collection[0].qty, 2);
  assert.match(reports.at(-1), /nothing was imported/);
  fail = false;
  await doImport();
  assert.equal(a.state().collection[0].qty, 78);
  assert.deepEqual(a.requests.map(({ body }) => body.identifiers.length), [75, 1, 75, 1]);
});

test('OCR cleans names and reads both modern and fraction collector numbers', () => {
  const a = app();
  assert.equal(a.call('cleanName', "5\n| A   Gisa's Bidding 9 X\n##"), "Gisa's Bidding");
  assert.equal(a.call('cleanName', '12 | ###'), '');
  for (const [line, num, set] of [['U 0263 C21 • EN', '263', 'C21'], ['003/280\nMKM · EN', '3', 'MKM']]) {
    const result = a.call('parseSetLine', line);
    assert.equal(result.num, num);
    assert.ok(result.sets.includes(set));
  }
  assert.equal(a.call('parseSetLine', 'unreadable').num, undefined);
});

test('exact OCR skips a wrong oracle identity and accepts a matching printing', async () => {
  const a = app({
    ocr: ['12', 'Sol Ring', 'U 0263 C21 • EN\nC20 • EN'],
    route: (url) => {
      if (url.pathname === '/cards/named') return ok(card());
      if (url.pathname === '/cards/c21/263') return ok(card('unrelated', { oracle_id: 'elsewhere' }));
      if (url.pathname === '/cards/c20/263') return ok(card('matching-print'));
      return failure(404);
    },
  });
  const result = await a.call('identifyFrom', {}, { x: 0, y: 0, w: 200, h: 280 });
  assert.equal(result.card.id, 'matching-print');
  assert.equal(result.text, 'Sol Ring');
  assert.deepEqual(a.requests.map(({ url }) => url.pathname), ['/cards/named', '/cards/c21/263', '/cards/c20/263']);
});

test('name lookup caches matches and definitive misses, but retries transient failures', async () => {
  let recover = false;
  const a = app({ route: (url) => {
    const name = url.searchParams.get('fuzzy');
    if (name === 'Sol Ring') return ok(card());
    if (name === 'Opt') return recover ? ok(card('opt', { name: 'Opt' })) : failure(503);
    if (name === 'Zap') return ok(card()); // An implausible fuzzy hit must be rejected.
    return url.pathname === '/cards/autocomplete' ? ok({ data: [] }) : failure(404);
  } });
  assert.equal((await a.call('identifyByName', 'Sol Ring')).id, 'sol-ring');
  assert.equal((await a.call('identifyByName', 'SOL RING!')).id, 'sol-ring');
  assert.equal(await a.call('identifyByName', 'Zap'), null);
  assert.equal(await a.call('identifyByName', 'zap!'), null);
  assert.equal(a.requests.length, 2);
  await assert.rejects(a.call('identifyByName', 'Opt'), /check your connection/);
  recover = true;
  assert.equal((await a.call('identifyByName', 'Opt')).id, 'opt');
});

test('search ranks an exact match first, appends pages, and shows an empty result on 404', async () => {
  const a = app({ route: (url) => {
    if (url.searchParams.get('page') === '2') return ok({ data: [card('last', { name: 'After' })], has_more: false });
    if (url.searchParams.get('q') === 'missing') return failure(404);
    return ok({
      data: [card('near', { name: 'Sol Ring Replica' }), card()],
      has_more: true, next_page: 'https://api.scryfall.com/cards/search?page=2',
    });
  } });
  const results = () => a.element('#searchResults').innerHTML;
  await a.call('runSearch', 'Sol Ring');
  assert.deepEqual([...results().matchAll(/data-open="([^"]+)"/g)].map((m) => m[1]), ['sol-ring', 'near']);
  await a.element('#moreBtn').onclick();
  assert.deepEqual([...results().matchAll(/data-open="([^"]+)"/g)].map((m) => m[1]), ['sol-ring', 'near', 'last']);
  await a.element('#moreBtn').onclick();
  assert.equal(a.requests.length, 2);
  await a.call('runSearch', 'missing');
  assert.match(results(), /No cards found/);
});

test('auto-scan needs consecutive reads and only adds the same card again after a gap', async () => {
  const a = app({
    mediaDevices: { getUserMedia: async () => ({ getVideoTracks: () => [] }) },
    // A failed read tries four crop variants before the scan loop sees an empty frame.
    ocr: ['Sol Ring', 'Sol Ring', 'Sol Ring', '', '', '', '', 'Sol Ring', 'Sol Ring'],
    route: () => ok(card()),
  });
  a.state().settings.exact = false;
  a.state().settings.sound = false;
  Object.assign(a.element('#video'), { videoWidth: 200, videoHeight: 280, play: async () => {} });
  for (const selector of ['#camera', '#guide']) {
    a.element(selector).getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 280 });
  }
  const settleFrame = () => new Promise((resolve) => setImmediate(resolve));
  await a.element('#autoBtn').onclick();
  try {
    for (const [frame, count] of [0, 1, 1, 1, 1, 2].entries()) {
      if (frame) a.advance(150); // next scan loop iteration
      await settleFrame();
      assert.equal(a.state().recent.length, count, 'after frame ' + (frame + 1));
    }
    assert.equal(a.requests.length, 1);
  } finally {
    a.element('#autoBtn').onclick();
    a.flush();
  }
});

test('a late card detail response cannot replace a newer card modal', async () => {
  let resolveSlow;
  const slow = new Promise((resolve) => { resolveSlow = resolve; });
  const a = app({
    route: (url) => url.pathname === '/cards/sol-ring' ? slow : ok(card('opt', { name: 'Opt' })),
  });
  const first = a.call('openCard', 'sol-ring');
  await a.call('openCard', 'opt');
  assert.match(a.element('#modalBody').innerHTML, /<h2>Opt<\/h2>/);
  resolveSlow(ok(card()));
  await first;
  assert.match(a.element('#modalBody').innerHTML, /<h2>Opt<\/h2>/);
});
