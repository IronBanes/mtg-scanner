'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { app, card, json, ok, failure, saved, storageKey } = require('./harness.cjs');

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
  assert.deepEqual(json(a.state().settings), { dest: 'none', sound: true, exact: false, searchOwned: false });
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

test('shopping list counts only main and commander, groups printings, and prices the missing copies', () => {
  const a = app();
  a.call('cache', card());
  a.call('cache', card('alt-print', { prices: { usd: '1.00', usd_foil: '2.00' } }));
  a.call('cache', card('island', { name: 'Island', oracle_id: 'island-oracle', prices: { usd: '0.25', usd_foil: '0.50' } }));
  a.call('cache', card('opt', { name: 'Opt', oracle_id: 'opt-oracle', prices: { usd: '0.25', usd_foil: '0.75' } }));
  a.call('addTo', 'collection', 'alt-print', false, 1); // any printing counts toward the same card identity
  const d = a.call('createDeck', 'Shop');
  a.call('addTo', d.id, 'sol-ring', false, 2, 'main');   // first entry: nonfoil, prices the row
  a.call('addTo', d.id, 'alt-print', true, 1, 'main');  // same identity: need 2 + 1, have 1 -> 2 missing
  a.call('addTo', d.id, 'island', false, 3, 'commander'); // commander counts
  a.call('addTo', d.id, 'opt', false, 2, 'side');        // sideboard is ignored
  a.call('addTo', d.id, 'opt', false, 9, 'maybe');       // maybe is ignored
  a.call('addTo', d.id, 'island', true, 1, 'maybe');
  assert.deepEqual(json(a.call('shoppingList', d)), [
    { cardId: 'island', name: 'Island', foil: false, need: 3, have: 0, missing: 3, unit: 0.25, total: 0.75 },
    { cardId: 'sol-ring', name: 'Sol Ring', foil: false, need: 3, have: 1, missing: 2, unit: 2.5, total: 5 },
  ]);
  // the first entry's foil flag prices the row (foil $0.50, not normal $0.25)
  assert.deepEqual(json(a.call('shoppingList', { cards: [
    { cardId: 'island', foil: true, qty: 2, board: 'main' },
  ] })), [
    { cardId: 'island', name: 'Island', foil: true, need: 2, have: 0, missing: 2, unit: 0.5, total: 1 },
  ]);
  // owning everything (any printing) yields an empty list
  a.call('addTo', 'collection', 'sol-ring', true, 2);
  a.call('addTo', 'collection', 'island', false, 3);
  assert.deepEqual(json(a.call('shoppingList', d)), []);
  assert.equal(a.call('shoppingText', [
    { missing: 2, name: 'Sol Ring', total: 10 },
    { missing: 1, name: 'Island', total: 0.5 },
  ]), '2 Sol Ring\n1 Island\n\nTotal: $10.50');
});

test('the deck shopping-list modal copies a store-ready list and exports only the missing copies', () => {
  const a = app();
  a.call('cache', card());
  a.call('cache', card('opt', { name: 'Opt', oracle_id: 'opt-oracle', prices: { usd: '0.25', usd_foil: '0.75' } }));
  const d = a.call('createDeck', 'Buy these');
  a.call('addTo', d.id, 'sol-ring', false, 2);
  a.call('addTo', d.id, 'opt', true, 1);
  a.eval(`openDeckId = ${JSON.stringify(d.id)}`);
  a.call('renderDeckDetail');
  assert.ok(a.element('#deckDetail').innerHTML.includes('id="deckShop"'));
  a.element('#deckShop').onclick();
  const modal = a.element('#modalBody').innerHTML;
  assert.match(modal, /Shopping list/);
  assert.match(modal, /2× Sol Ring/);
  assert.match(modal, /need 2 · own 0/);
  assert.match(modal, /\$5\.00/); // 2 missing normal Sol Rings
  assert.match(modal, /1× Opt/);
  assert.match(modal, /need 1 · own 0/);
  assert.match(modal, /\$0\.75/); // the foil entry's price
  assert.match(modal, /Total/);
  assert.match(modal, /3 cards to buy/); // copies, not rows
  assert.match(modal, /\$5\.75/);
  a.eval('navigator.clipboard = { writeText: async (t) => { __copied = t; } }');
  a.element('#shopCopy').onclick();
  assert.equal(a.eval('__copied'), '1 Opt\n2 Sol Ring\n\nTotal: $5.75'); // sorted by name
  // Export CSV maps each row to { cardId, qty: missing, foil}: Count is what you must buy
  const csv = a.call('toCsv', a.call('shoppingList', d).map((r) => ({ cardId: r.cardId, qty: r.missing, foil: r.foil })));
  const [head, optRow, solRow] = csv.split('\r\n');
  assert.equal(head.split(',')[0], 'Count');
  assert.equal(optRow, '1,Opt,Commander 2021,C21,263,foil,,uncommon,Artifact,0.75,0.75,opt'); // no board in a shopping row
  assert.equal(solRow, '2,Sol Ring,Commander 2021,C21,263,,,uncommon,Artifact,2.50,5.00,sol-ring');
});

test('a sticky toast has no auto-hide timer and comes back after a normal toast', () => {
  const a = app();
  const toast = () => a.element('#toast');
  a.call('offerUpdate', { postMessage: () => {}, state: 'installed' });
  assert.ok(toast().classList.contains('show'));
  assert.match(toast().innerHTML, /A new version is ready/);
  assert.match(toast().innerHTML, /aria-label="Dismiss"/);
  assert.ok(toast().classList.contains('sticky'), 'sticky notice sits under the top bar, clear of the scan buttons');
  assert.throws(() => a.advance(2200), /expected a pending timer/, 'a sticky toast leaves no auto-hide timer');
  a.call('toast', 'Added 1× Sol Ring'); // a normal toast replaces it on screen without losing it
  assert.match(toast().innerHTML, /Added 1× Sol Ring/);
  assert.ok(!toast().innerHTML.includes('A new version is ready'));
  assert.ok(!toast().classList.contains('sticky'), 'normal toasts stay at the bottom');
  a.advance(2200); // the normal toast's timer brings the sticky notice back
  assert.match(toast().innerHTML, /A new version is ready/);
  assert.ok(toast().classList.contains('show'));
  assert.throws(() => a.advance(2200), /expected a pending timer/, 'the restored sticky toast has no timer either');
  toast().querySelector('button[aria-label="Dismiss"]').onclick(); // × clears the pending sticky
  assert.ok(!toast().classList.contains('show'));
  a.call('toast', 'Added 1× Sol Ring');
  a.advance(2200);
  assert.ok(!toast().classList.contains('show'), 'no sticky toast is brought back after ×');
  a.call('offerUpdate', { postMessage: () => {}, state: 'installed' });
  assert.ok(toast().classList.contains('show'));
  a.element('button').onclick(); // the Reload action also clears the pending sticky
  assert.ok(!toast().classList.contains('show'));
  a.call('toast', 'Added 1× Sol Ring');
  a.advance(2200);
  assert.ok(!toast().classList.contains('show'));
});

test('tapping Reload posts SKIP_WAITING, or reloads directly once the worker is already active', () => {
  const posted = [];
  const a = app();
  a.call('offerUpdate', { postMessage: (m) => posted.push(m), state: 'installed' });
  a.element('button').onclick();
  assert.deepEqual(posted, ['SKIP_WAITING']);
  assert.equal(a.reloads(), 0, 'an installed worker is skipped, the controllerchange reload handles it');
  a.call('offerUpdate', { postMessage: (m) => posted.push(m), state: 'activated' });
  a.element('button').onclick();
  assert.deepEqual(posted, ['SKIP_WAITING', 'SKIP_WAITING']);
  assert.equal(a.reloads(), 1, 'another tab already switched: reload directly');
  a.call('offerUpdate', { postMessage: (m) => posted.push(m), state: 'redundant' });
  a.element('button').onclick();
  assert.equal(a.reloads(), 2);
});

test('owned-only search keeps fetched pages, shows own-N badges, and re-renders without a new request', async () => {
  const a = app({ route: (url) => {
    if (url.searchParams.get('q') === 'Tundra') {
      if (url.searchParams.get('page') === '2') return ok({ data: [card('tundra2', { name: 'Tundra', oracle_id: 'tundra-oracle' })], has_more: false });
      return ok({ data: [card('tundra1', { name: 'Tundra', oracle_id: 'tundra-oracle' })], has_more: true, next_page: 'https://api.scryfall.com/cards/search?page=2&q=Tundra' });
    }
    return ok({
      data: [card('near', { name: 'Sol Ring Replica', oracle_id: 'replica-oracle' }), card(), card('owned-print', { name: 'Sol Ring', oracle_id: 'sol-ring-oracle' })],
      has_more: true, next_page: 'https://api.scryfall.com/cards/search?page=2&q=Sol+Ring',
    });
  } });
  a.call('addTo', 'collection', 'owned-print', false, 3);
  const results = () => a.element('#searchResults').innerHTML;
  const shown = () => [...results().matchAll(/data-open="([^"]+)"/g)].map((m) => m[1]);
  await a.call('runSearch', 'Sol Ring');
  assert.deepEqual(shown(), ['sol-ring', 'owned-print', 'near']);
  assert.equal([...results().matchAll(/class="own">own (\d+)/g)].map((m) => m[1]).join(), '3,3', 'own 3 on each owned printing');
  // owned-only renders only owned cards, re-rendering the fetched results without a new request
  a.element('#searchOwned').checked = true;
  a.element('#searchOwned').onchange({ target: { checked: true } });
  assert.ok(a.state().settings.searchOwned);
  assert.deepEqual(shown(), ['sol-ring', 'owned-print']);
  assert.equal(a.requests.length, 1);
  a.element('#searchOwned').checked = false;
  a.element('#searchOwned').onchange({ target: { checked: false } });
  assert.ok(!a.state().settings.searchOwned);
  assert.deepEqual(shown(), ['sol-ring', 'owned-print', 'near']);
  assert.equal(a.requests.length, 1);
  // a search with no owned cards says so, while Load more stays available until Scryfall runs out
  a.element('#searchOwned').checked = true;
  a.element('#searchOwned').onchange({ target: { checked: true } });
  await a.call('runSearch', 'Tundra');
  assert.match(results(), /None of these results are in your collection/);
  assert.ok(!a.element('#moreBtn').classList.contains('hidden'), 'more pages exist');
  await a.element('#moreBtn').onclick(); // page 2: none of it is owned either
  assert.match(results(), /None of these results are in your collection/);
  assert.ok(a.element('#moreBtn').classList.contains('hidden'), 'no more pages: Load more hides');
  assert.equal(a.requests.length, 3);
});

test('review: an owned deck shows no shopping buttons, and search badges refresh after adding a card', async () => {
  const a = app({ route: () => ok({ data: [card()], has_more: false }) });
  a.call('cache', card());
  const d = a.call('createDeck', 'Owned');
  a.call('addTo', d.id, 'sol-ring', false, 1);
  a.call('addTo', 'collection', 'sol-ring', false, 1);
  a.call('showShoppingList', d);
  assert.match(a.element('#modalBody').innerHTML, /You own every card in this deck/);
  assert.ok(!a.element('#modalBody').innerHTML.includes('shopCopy'));
  await a.call('runSearch', 'Sol Ring');
  assert.match(a.element('#searchResults').innerHTML, /own 1/);
  a.call('addTo', 'collection', 'sol-ring', false, 2);
  a.call('renderAll');
  assert.match(a.element('#searchResults').innerHTML, /own 3/);
});

test('a late response from an older search cannot replace or extend newer results', async () => {
  let resolveOld;
  const old = new Promise((resolve) => { resolveOld = resolve; });
  const a = app({ route: (url) => (url.searchParams.get('q') === 'Old'
    ? old
    : ok({ data: [card()], has_more: false })) });
  const first = a.call('runSearch', 'Old');
  await a.call('runSearch', 'Sol Ring');
  resolveOld(ok({ data: [card('stale', { name: 'Stale', oracle_id: 'stale-oracle' })], has_more: true, next_page: 'https://api.scryfall.com/cards/search?page=2&q=Old' }));
  await first;
  const html = a.element('#searchResults').innerHTML;
  assert.match(html, /data-open="sol-ring"/);
  assert.ok(!html.includes('stale'));
  assert.equal(a.eval('searchNext'), null, 'the stale page cannot set Load more');
});

test('restoring state syncs the owned-only checkbox on the next render', () => {
  const a = app();
  a.element('#searchOwned').checked = false;
  a.state().settings.searchOwned = true;
  a.call('renderAll');
  assert.equal(a.element('#searchOwned').checked, true);
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
