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
  assert.deepEqual(json(a.state().settings), { dest: 'none', sound: true, exact: false, searchOwned: false, tradeOnly: false });
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

test('review: a backup with a bad trade count is rejected; an import Count is never negative', async () => {
  const a = app({ raw: '{' });
  a.element('#settingsBtn').onclick();
  const restore = async (data) => {
    await a.element('#bkImport').onchange({ target: { files: [{ text: async () => JSON.stringify(data) }] } });
    a.flush();
  };
  for (const trade of ['<img src=x onerror=alert(1)>', 3, -1, 1.5]) {
    await restore({ app: 'mtgscan', ...saved({ collection: [{ cardId: 'sol-ring', qty: 2, trade }] }) });
    assert.equal(a.stored.get(storageKey), '{', 'rejected: ' + trade);
    assert.match(a.element('#toast').innerHTML, /trade count/);
  }
  await restore({ app: 'mtgscan', ...saved({ collection: [{ cardId: 'sol-ring', qty: 2, trade: 2 }] }) });
  assert.equal(JSON.parse(a.stored.get(storageKey)).collection[0].trade, 2, 'a valid trade count restores');
  assert.deepEqual(json(a.call('parseList', 'Count,Name\n-1,Sol Ring\n0,Opt')).map((x) => x.qty), [1, 1]);
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
  assert.deepEqual(json(a.call('collectionTotals')), { cards: 3, value: 8.75, change: 0, unique: 1 });
  assert.equal(a.call('ownedCount', 'sol-ring-oracle'), 3);
  const d = a.call('createDeck', 'Board tests');
  a.call('addTo', d.id, 'sol-ring', false, 2);
  a.call('addTo', d.id, 'sol-ring', false, 1, 'side');
  a.call('addTo', d.id, 'sol-ring', false, 4, 'maybe');
  a.call('addTo', d.id, 'sol-ring', true);
  a.call('removeFrom', d.id, 'sol-ring', false, 5, 'side');
  assert.deepEqual(json(a.call('deckTotals', d)), { cards: 3, value: 10, change: 0 });
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
  // review: an old card's artist/copyright line has no language marker, so it yields no set codes to look up
  for (const line of ['Illus. Christopher Rush\n© 1993-1995 Wizards of the Coast', 'ILLUS. MARK POOLE 123/350 ©1999 WIZARDS']) {
    assert.deepEqual(json(a.call('parseSetLine', line).sets), [], line);
  }
  // review (Sonnet): modern lines still work when OCR drops the "•"/"EN", and for non-English printings
  for (const [line, set] of [['U 0263 C21 EN', 'C21'], ['R 0123\nCMR JA', 'CMR'], ['M 0045 NEO', 'NEO']]) {
    assert.ok(a.call('parseSetLine', line).sets.includes(set), line);
  }
});

test('review: exact mode makes no printing lookups for an old card without a set code', async () => {
  const a = app({
    ocr: ['Lightning Bolt', 'Illus. Christopher Rush\n© 1993-1995 Wizards of the Coast'],
    route: (url) => (url.pathname === '/cards/named' ? ok(card('bolt', { name: 'Lightning Bolt', oracle_id: 'bolt-oracle' })) : failure(404)),
  });
  const result = await a.call('identifyFrom', {}, { x: 0, y: 0, w: 200, h: 280 }, { exact: true });
  assert.equal(result.card.id, 'bolt');
  assert.deepEqual(a.requests.map(({ url }) => url.pathname), ['/cards/named'], 'no /cards/<set>/<num> guesses');
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

test('old-frame crops run only after the four modern-frame crops fail, and can find the card', async () => {
  const a = app({
    // four modern-frame reads come back as noise, then the first old-frame crop reads the name
    ocr: ['ee', 'Te Se', '', 'xx', 'Lightning Bolt'],
    route: (url) => (url.pathname === '/cards/named' ? ok(card('bolt', { name: 'Lightning Bolt', oracle_id: 'bolt-oracle' })) : failure(404)),
  });
  const result = await a.call('identifyFrom', {}, { x: 0, y: 0, w: 200, h: 280 }, { exact: false });
  assert.equal(result.card.name, 'Lightning Bolt');
  assert.equal(result.text, 'Lightning Bolt');
  const variants = json(a.eval('NAME_VARIANTS'));
  assert.equal(variants.length, 6);
  assert.deepEqual(variants.slice(0, 4).map((v) => v.channel), [undefined, undefined, undefined, undefined], 'modern crops unchanged');
  assert.deepEqual(variants.slice(4).map((v) => [v.channel, v.invert, v.smooth, v.bin]), [['min', true, 3, false], ['min', true, 3, 'plain']]);
});

test('grayOf: the darkest channel keeps near-white text bright and makes a colored frame dark', () => {
  const a = app();
  const lum = (rgb) => a.call('grayOf', ...rgb), min = (rgb) => a.call('grayOf', ...rgb, 'min');
  const text = [240, 236, 228], greenFrame = [110, 140, 90];
  assert.ok(min(text) - min(greenFrame) > lum(text) - lum(greenFrame), 'more contrast between text and a colored frame');
  assert.equal(min(greenFrame), 90);
  assert.equal(lum([255, 255, 255]), 255);
});

test('review: the old-frame gray crop turns light text on a colored frame into dark text on light', () => {
  // a 10x10 crop: green frame everywhere, one row of near-white "text" at y = 5
  let last;
  const a = app({ pixels: (w, h) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w * h; p++) d.set(Math.floor(p / w) === 5 ? [240, 236, 228, 255] : [110, 140, 90, 255], p * 4);
    return (last = d);
  } });
  const gray = (opts, invert) => { a.call('grayCrop', {}, { x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 1, h: 1 }, 10, invert, opts); return [last[5 * 40], last[0]]; };
  assert.deepEqual(gray({ channel: 'min', smooth: 0 }, true), [0, 255], 'text dark, frame light');
  // a mild blur leaves that order intact
  const [text, frame] = gray({ channel: 'min', smooth: 1 }, true);
  assert.ok(text < frame, `text ${text} stays darker than frame ${frame}`);
});

test('review: thresholdCanvas wipes blobs touching the edges, except in plain mode', () => {
  const a = app();
  // 10x6 gray image: a dark bar at x 0..2 touching top and bottom, a dark "letter" at x 5..6, y 2..3, light elsewhere
  const run = (mode) => json(a.eval(`(() => {
    const W = 10, H = 6, d = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = x <= 2 || (x >= 5 && x <= 6 && y >= 2 && y <= 3) ? 20 : 220; d.set([v, v, v, 255], (y * W + x) * 4); }
    d.set([24, 24, 24, 255], 0); // one slightly lighter dark pixel (in the bar), as a real image has: the Otsu cut lands above 20

    thresholdCanvas({ width: W, height: H, getContext: () => ({ getImageData: () => ({ data: d }), putImageData() {} }) }, ${JSON.stringify(mode)});
    return { bar: d[(3 * W + 1) * 4], letter: d[(2 * W + 5) * 4], bg: d[(0 * W + 8) * 4] };
  })()`));
  assert.deepEqual(run(true), { bar: 255, letter: 0, bg: 255 }, 'the edge bar is wiped, the letter kept');
  assert.deepEqual(run('plain'), { bar: 0, letter: 0, bg: 255 }, 'plain keeps everything dark');
});

test('review: short junk from an old-frame crop is not looked up on Scryfall', async () => {
  // four modern crops read nothing; the old-frame crops read 5- and 4-letter texture noise
  const a = app({ ocr: ['', '', '', '', 'Brrak', 'Weta'], route: () => ok(card()) });
  const result = await a.call('identifyFrom', {}, { x: 0, y: 0, w: 200, h: 280 }, { exact: false });
  assert.equal(result.card, null);
  assert.equal(a.requests.length, 0, 'no lookups for short old-frame reads');
});

test('review: oldFrame:false skips the two old-frame crops; thresholded variants reuse their gray crop', async () => {
  let crops = 0;
  const a = app({ ocr: ['', '', '', '', 'Lightning Bolt'], pixels: (w, h) => (crops++, new Uint8ClampedArray(w * h * 4)) });
  const result = await a.call('identifyFrom', {}, { x: 0, y: 0, w: 200, h: 280 }, { exact: false, oldFrame: false });
  assert.equal(result.card, null, 'only the four modern crops ran');
  assert.equal(a.eval('NAME_VARIANTS').length, 6);
  // 4 modern variants: 3 distinct gray crops (variants 1 and 2 share a zone) + 3 thresholded copies read back = 6 reads,
  // instead of 7 when every variant redid its own crop
  assert.equal(crops, 6);
});

test('boxBlur averages a gray channel in place and leaves radius 0 alone', () => {
  const a = app();
  // a 3x1 RGBA strip: gray values 0, 90, 0 (in the R slot)
  const strip = [0, 0, 0, 255, 90, 0, 0, 255, 0, 0, 0, 255];
  const blurred = json(a.eval(`(() => { const d = new Uint8ClampedArray(${JSON.stringify(strip)}); boxBlur(d, 3, 1, 1); return [...d]; })()`));
  assert.deepEqual([blurred[0], blurred[4], blurred[8]], [45, 30, 45], 'each pixel is the mean of its in-bounds neighbours');
  const same = json(a.eval(`(() => { const d = new Uint8ClampedArray(${JSON.stringify(strip)}); boxBlur(d, 3, 1, 0); return [...d]; })()`));
  assert.deepEqual(same, strip);
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
    // A failed read tries all six crop variants (four modern-frame, two old-frame) right after a card was seen.
    // One empty frame is only a flicker (no re-add); two in a row are a gap, after which the same card adds again.
    ocr: ['Sol Ring', 'Sol Ring', 'Sol Ring', ...Array(6).fill(''), 'Sol Ring', 'Sol Ring',
      ...Array(6).fill(''), ...Array(6).fill(''), 'Sol Ring', 'Sol Ring'],
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
    // frames: see, add, see, flicker, see, see (no re-add), miss, miss (gap), see, add again
    for (const [frame, count] of [0, 1, 1, 1, 1, 1, 1, 1, 1, 2].entries()) {
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

test('cache remembers the previous prices when they move, and only then', () => {
  const a = app();
  assert.equal(a.call('cache', card('fresh')).prev, undefined, 'a new card has no prev');
  const first = a.call('cache', card('sol-ring'));
  assert.equal(first.prev, undefined, 'the first fetch has nothing to compare against');
  a.call('cache', card('sol-ring', { prices: { usd: '3.00', usd_foil: '5.00' } }));
  const moved = a.state().cards['sol-ring'];
  assert.deepEqual(json(moved.prev), { prices: { usd: '2.50', usd_foil: '5.00' }, at: first.updated });
  // re-fetching an unchanged card keeps the last change instead of dropping it
  a.call('cache', card('sol-ring', { prices: { usd: '3.00', usd_foil: '5.00' } }));
  assert.deepEqual(json(a.state().cards['sol-ring'].prev), { prices: { usd: '2.50', usd_foil: '5.00' }, at: first.updated });
  // a foil-only move still counts as a change
  a.call('cache', card('sol-ring', { prices: { usd: '3.00', usd_foil: '4.00' } }));
  assert.deepEqual(json(a.state().cards['sol-ring'].prev.prices), { usd: '3.00', usd_foil: '5.00' });
  assert.ok(a.state().cards['sol-ring'].prev.at > first.updated, 'at moves to the newer refresh');
  // review: a missing price key and Scryfall's null are the same, not a move
  a.call('cache', card('etched', { prices: { usd: '1.00' } }));
  a.call('cache', card('etched', { prices: { usd: '1.00', usd_foil: null, usd_etched: null } }));
  assert.equal(a.state().cards.etched.prev, undefined);
});

test('priceChange: normal and foil entries, 0 without prev, 0 when a price is missing', () => {
  const a = app();
  assert.equal(a.call('priceChange', a.state().cards['nothing-there'], false), 0, 'no card, no change');
  a.call('cache', card('plain'));
  assert.equal(a.call('priceChange', a.state().cards.plain, false), 0, 'no prev yet');
  a.call('cache', card('moved', { prices: { usd: '2.50', usd_foil: '5.00' } }));
  a.call('cache', card('moved', { prices: { usd: '3.10', usd_foil: '4.00' } }));
  assert.equal(a.call('priceChange', a.state().cards.moved, false), 0.6);
  assert.equal(a.call('priceChange', a.state().cards.moved, true), -1);
  // a missing price is not a change, in either direction
  a.call('cache', card('gone', { prices: { usd: '2.50' } }));
  a.call('cache', card('gone', { prices: {} }));
  assert.equal(a.call('priceChange', a.state().cards.gone, false), 0);
  a.call('cache', card('arrived', { prices: {} }));
  a.call('cache', card('arrived', { prices: { usd: '2.50' } }));
  assert.equal(a.call('priceChange', a.state().cards.arrived, false), 0);
});

test('refreshPrices counts cards whose entry price changed; doRefresh toasts the count', async () => {
  let bump = false; // the last refresh moves a's normal price again
  const a = app({ route: (url, body) => {
    assert.equal(url.pathname, '/cards/collection');
    const prices = {
      a: bump ? { usd: '4.00', usd_foil: '5.00' } : { usd: '3.00', usd_foil: '5.00' },
      b: { usd: '2.50', usd_foil: '5.00' },
      c: { usd: '2.50', usd_foil: '4.00' },
    };
    return ok({ data: body.identifiers.map(({ id }) => ({ ...card(id), prices: prices[id] })) });
  } });
  a.call('cache', card('a', { prices: { usd: '2.50', usd_foil: '5.00' } }));
  a.call('cache', card('b', { prices: { usd: '2.50', usd_foil: '5.00' } }));
  a.call('cache', card('c', { prices: { usd: '2.50', usd_foil: '5.00' } }));
  a.call('addTo', 'collection', 'a', false, 2);
  a.call('addTo', 'collection', 'b', false, 1);
  const d = a.call('createDeck', 'Refresh');
  a.call('addTo', d.id, 'c', true, 1);
  assert.equal(await a.call('refreshPrices', ['a', 'b', 'c']), 2, 'a moved (normal), c moved (foil), b did not');
  assert.equal(await a.call('refreshPrices', ['a', 'b', 'c']), 0, 'nothing moves the second time');
  await a.call('doRefresh', ['a', 'b', 'c']);
  assert.match(a.element('#toast').innerHTML, /Prices updated — no changes/);
  a.call('cache', card('d', { prices: { usd: '9.00' } }));
  a.call('cache', card('d', { prices: { usd: '1.00' } }));
  assert.equal(await a.call('refreshPrices', ['d']), 0, 'a card nothing points at has no entry price to compare');
  bump = true;
  await a.call('doRefresh', ['a']);
  assert.match(a.element('#toast').innerHTML, /Prices updated — 1 changed/);
});

test('collection and deck changes sum per copy, and the deck skips Maybe', () => {
  const a = app();
  const cache2 = (id, prices, after) => { a.call('cache', card(id, { oracle_id: id + '-oracle', prices })); a.call('cache', card(id, { oracle_id: id + '-oracle', prices: after })); };
  cache2('a', { usd: '2.50', usd_foil: '5.00' }, { usd: '3.50', usd_foil: '5.00' }); // +1.00 normal
  cache2('b', { usd: '1.00', usd_foil: '2.00' }, { usd: '0.75', usd_foil: '2.00' }); // -0.25 normal
  cache2('c', { usd: '2.00', usd_foil: '5.00' }, { usd: '2.00', usd_foil: '4.50' }); // -0.50 foil only
  a.call('addTo', 'collection', 'a', false, 2);
  a.call('addTo', 'collection', 'b', false, 1);
  a.call('addTo', 'collection', 'c', true, 3);
  assert.deepEqual(json(a.call('collectionTotals')), { cards: 6, value: 21.25, change: 0.25, unique: 3 });
  const d = a.call('createDeck', 'Movers');
  a.call('addTo', d.id, 'a', false, 1);
  a.call('addTo', d.id, 'a', false, 4, 'maybe'); // skipped by the deck value
  a.call('addTo', d.id, 'b', false, 1, 'side');
  a.call('addTo', d.id, 'c', true, 1);
  assert.deepEqual(json(a.call('deckTotals', d)), { cards: 3, value: 8.75, change: 0.25 });
});

test('card rows and value tiles show the change under the price, and only when there is one', () => {
  const a = app();
  const cache2 = (id, name, prices, after) => {
    const base = { oracle_id: id + '-oracle', name, prices };
    a.call('cache', card(id, base));
    a.call('cache', card(id, { ...base, prices: after }));
  };
  cache2('up', 'Up', { usd: '2.50', usd_foil: '5.00' }, { usd: '2.90', usd_foil: '5.00' });   // +0.40 normal
  cache2('down', 'Down', { usd: '2.50', usd_foil: '5.00' }, { usd: '2.50', usd_foil: '4.00' }); // -1.00 foil
  cache2('same', 'Same', { usd: '2.50', usd_foil: '5.00' }, { usd: '2.50', usd_foil: '5.00' }); // no change
  a.call('addTo', 'collection', 'up', false, 2);
  a.call('addTo', 'collection', 'down', true, 1);
  a.call('addTo', 'collection', 'same', false, 1);
  const row = (id, foil = false) => a.call('cardRow', { cardId: id, foil, qty: 1 });
  assert.match(row('up'), /<span class="chg up" title="was \$2\.50[^"]*">▲ \$0\.40<\/span>/);
  assert.match(row('down', true), /class="chg down" title="was \$5\.00[^"]*">▼ \$1\.00</);
  assert.ok(!row('same').includes('chg'), 'an unchanged card shows no change line');
  assert.ok(!row('up', true).includes('chg'), 'the unchanged foil price of a moved card shows nothing');
  a.call('renderCollection');
  assert.ok(a.element('#collList').innerHTML.includes('▲ $0.40'), 'per copy, not per entry');
  assert.match(a.element('#collStats').innerHTML, /<span class="chg down">▼ \$0\.20<\/span>/, '2× +0.40 − 1.00');
  const d = a.call('createDeck', 'Mover deck');
  a.call('addTo', d.id, 'up', false, 1);
  a.call('addTo', d.id, 'down', true, 1, 'maybe'); // Maybe is not part of the deck value
  a.eval(`openDeckId = ${JSON.stringify(d.id)}`);
  a.call('renderDeckDetail');
  assert.match(a.element('#deckDetail').innerHTML, /<span class="chg up">▲ \$0\.40<\/span>/);
  assert.match(a.element('#deckDetail').innerHTML, /Deck value/);
});

test('the change sort orders by biggest absolute total change, ties by name', () => {
  const a = app();
  const mover = (id, name, from, to, qty) => {
    const base = { oracle_id: id + '-oracle', name, prices: { usd: from, usd_foil: from } };
    a.call('cache', card(id, base));
    a.call('cache', card(id, { ...base, prices: { usd: to, usd_foil: to } }));
    a.call('addTo', 'collection', id, false, qty);
  };
  mover('big', 'Big', '1.00', '2.00', 2);   // +2.00
  mover('mid', 'Mid', '1.00', '0.50', 2);   // -1.00
  mover('small', 'Small', '1.00', '0.70', 3); // -0.90
  mover('ann', 'Ann', '1.00', '1.50', 1);  // +0.50
  mover('zed', 'Zed', '1.00', '1.50', 1);  // +0.50, tied with Ann
  a.element('#collSort').value = 'change';
  a.call('renderCollection');
  const order = () => [...a.element('#collList').innerHTML.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order(), ['big', 'mid', 'small', 'ann', 'zed']);
  // review: $0.10 x 3 and $0.30 x 1 are the same total in cents, so the name decides (0.1 * 3 > 0.3 in floats)
  mover('zz', 'Zz', '1.00', '1.10', 3);
  mover('aa', 'Aa', '1.00', '1.30', 1);
  a.call('renderCollection');
  assert.deepEqual(order().slice(-2), ['aa', 'zz']);
});

test('review: value tiles hide a total change that rounds to zero cents', () => {
  const a = app();
  assert.equal(a.call('changeStat', 0.1 + 0.2 - 0.3), '');
  assert.equal(a.call('changeStat', -0.004), '');
  assert.match(a.call('changeStat', 0.1 + 0.2), /▲ \$0\.30/);
});

test('a legacy save with no prev loads, renders and saves without adding one', () => {
  const legacy = JSON.stringify(saved({
    cards: { 'sol-ring': { id: 'sol-ring', name: 'Sol Ring', oracle_id: 'sol-ring-oracle', set: 'c21', cn: '263', prices: { usd: '2.50', usd_foil: '5.00' }, updated: 1 } },
    collection: [{ cardId: 'sol-ring', qty: 2, foil: false, added: 1 }],
    decks: [{ id: 'deck', name: 'Old deck', format: 'commander', created: 1, cards: [{ cardId: 'sol-ring', qty: 1, foil: false, board: 'main' }] }],
    recent: [{ cardId: 'sol-ring', foil: false, t: 1 }],
  }));
  const a = app({ raw: legacy });
  assert.equal(a.state().schema, 1);
  a.call('renderAll');
  assert.match(a.element('#collStats').innerHTML, /Total value/);
  assert.ok(!a.element('#collStats').innerHTML.includes('chg'), 'no change line without prev');
  a.call('addTo', 'collection', 'sol-ring', false, 1);
  a.flush();
  const data = JSON.parse(a.stored.get(storageKey));
  assert.equal(data.collection[0].qty, 3);
  assert.equal(data.schema, 1);
  for (const c of Object.values(data.cards)) assert.ok(!('prev' in c), 'no prev added to saved cards');
  // a save that already has prev loads it and works (the field is additive, same schema)
  const b = app({ raw: JSON.stringify(saved({
    cards: { 'sol-ring': { id: 'sol-ring', name: 'Sol Ring', oracle_id: 'sol-ring-oracle', set: 'c21', prices: { usd: '3.00' }, prev: { prices: { usd: '2.50' }, at: 1 } } },
    collection: [{ cardId: 'sol-ring', qty: 1 }],
  })) });
  assert.deepEqual(json(b.state().cards['sol-ring'].prev), { prices: { usd: '2.50' }, at: 1 });
  assert.equal(b.call('priceChange', b.state().cards['sol-ring'], false), 0.5);
  b.call('renderAll');
  assert.match(b.element('#collStats').innerHTML, /<span class="chg up">▲ \$0\.50<\/span>/);
});

test('synergyTags reads each theme out of real rules text (one make and one pay per theme)', () => {
  const a = app();
  const tags = (oracle, keywords = []) => json(a.call('synergyTags', oracle, 'Creature — Human', keywords));
  for (const [label, oracle, keywords, expected] of [
    ['tokens make', 'Create a 1/1 white Spirit creature token.', [], ['tokens:make']],
    ['tokens pay (tokens you control)', 'Creature tokens you control get +1/+1 and have vigilance.', [], ['tokens:pay']],
    ['tokens pay (anthem)', 'Creatures you control get +1/+1.', [], ['tokens:pay']],
    ['sacrifice make (cost)', 'Sacrifice a creature: Add one mana of any color.', [], ['sacrifice:make']],
    ['sacrifice pay (dies)', 'Whenever another creature you control dies, draw a card.', [], ['sacrifice:pay']],
    ['sacrifice pay (you sacrifice)', 'Whenever you sacrifice a permanent, put a +1/+1 counter on this creature.', [], ['counters:make', 'sacrifice:pay']],
    ['counters make (put)', 'Put two +1/+1 counters on target creature you control.', [], ['counters:make']],
    ['counters make (Proliferate)', 'Proliferate.', ['Proliferate'], ['counters:make']],
    ['counters pay (enters with)', 'This creature enters the battlefield with a +1/+1 counter on it.', [], ['counters:pay']],
    ['counters pay (for each)', 'This creature gets +1/+1 for each +1/+1 counter on it.', [], ['counters:pay']],
    ['graveyard make (mill)', 'Mill three cards, then draw a card.', [], ['graveyard:make']],
    ['graveyard make (surveil keyword)', 'Surveil 2.', ['Surveil'], ['graveyard:make']],
    ['graveyard pay (from your graveyard)', 'You may cast this card from your graveyard for its flashback cost.', ['Flashback'], ['graveyard:pay']],
    ['spells pay', 'Whenever you cast an instant or sorcery spell, put a +1/+1 counter on this creature.', [], ['counters:make', 'spells:pay']],
    ['spells pay (Prowess)', 'Prowess.', ['Prowess'], ['spells:pay']],
    ['lifegain make (N life)', 'Whenever this creature attacks, you gain 2 life.', [], ['lifegain:make']],
    ['lifegain make (Lifelink)', 'Lifelink', ['Lifelink'], ['lifegain:make']],
    ['lifegain pay', 'Whenever you gain life, put a +1/+1 counter on this creature.', [], ['counters:make', 'lifegain:pay']],
    ['artifacts pay', 'This creature gets +1/+0 for each artifact you control.', [], ['artifacts:pay']],
    ['artifacts pay (Metalcraft)', 'Metalcraft — This creature has trample as long as you control three or more artifacts.', ['Metalcraft'], ['artifacts:pay']],
    ['landfall make (search)', 'Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.', [], ['landfall:make']],
    ['landfall pay (Landfall)', 'Landfall — Whenever a land enters the battlefield under your control, you may gain 1 life.', ['Landfall'], ['landfall:pay', 'lifegain:make']],
  ]) {
    assert.deepEqual(tags(oracle, keywords), expected, label + ': ' + oracle.slice(0, 40) + '…');
  }
  // the wording, not just the letter case, must be what the patterns expect
  assert.deepEqual(tags('CREATE A 1/1 GOBLIN TOKEN.'), ['tokens:make'], 'matching is case-insensitive');
  assert.deepEqual(tags('Whenever you sacrifice a creature, draw a card.'), ['sacrifice:pay'], 'a "Whenever you sacrifice" trigger is a payoff, not a cost');
  assert.deepEqual(tags('Trample, vigilance'), [], 'a vanilla creature gets no tags');
  // review: discarding your own cards fills your graveyard; making an opponent discard does not
  assert.deepEqual(tags('Draw two cards, then discard a card.'), ['graveyard:make']);
  assert.deepEqual(tags('Target player reveals their hand. You choose a nonland card from it. That player discards that card.'), []);
  assert.deepEqual(tags('Whenever an opponent casts a spell, that player loses 5 life unless they discard a card.'), []);
  assert.deepEqual(tags('Each opponent loses 2 life. Then discard a card.'), ['graveyard:make'], 'your own discard in a later sentence still counts');
  assert.deepEqual(tags(''), [], 'no rules text, no tags');
  assert.deepEqual(json(a.call('synergyTags', undefined, 'Creature', undefined)), [], 'missing pieces are tolerated');
});

test('slim() saves tags on every card (empty when none), and SYNERGY_RULES covers the eight themes', () => {
  const a = app();
  const tagged = a.call('cache', card('burst', { name: 'Token Burst', type_line: 'Sorcery', oracle_text: 'Create two 1/1 green Saproling creature tokens.' }));
  assert.deepEqual(json(tagged.tags), ['tokens:make']);
  const plain = a.call('cache', card('grunt', { name: 'Grizzly Grunt', type_line: 'Creature — Bear', oracle_text: 'Trample' }));
  assert.deepEqual(json(plain.tags), [], 'a vanilla creature saves an empty array');
  const rules = a.eval('SYNERGY_RULES');
  assert.deepEqual(Object.keys(rules), ['tokens', 'sacrifice', 'counters', 'graveyard', 'spells', 'lifegain', 'artifacts', 'landfall']);
  for (const rule of Object.values(rules)) {
    for (const key of ['name', 'thing', 'desc', 'make', 'pay', 'makeKw', 'payKw']) assert.ok(key in rule, 'theme rule has ' + key);
  }
});

// ---------------------------------------------------------------- trade binder (release 9)
test('setTrade clamps to 0..qty, deletes the key at 0, and ignores missing entries', () => {
  const a = app();
  a.call('cache', card());
  a.call('addTo', 'collection', 'sol-ring', false, 2);
  a.call('setTrade', 'sol-ring', false, 5);
  assert.equal(a.state().collection[0].trade, 2, 'clamped up to qty');
  a.call('setTrade', 'sol-ring', false, -3);
  assert.ok(!('trade' in a.state().collection[0]), 'below 0 is 0, and 0 drops the key');
  a.call('setTrade', 'sol-ring', false, 1);
  a.call('setTrade', 'sol-ring', false, 0);
  assert.ok(!('trade' in a.state().collection[0]), '0 drops the key');
  a.call('setTrade', 'unknown-card', false, 3); // no such entry: nothing happens
  a.call('setTrade', 'sol-ring', true, 3);      // no foil entry either
  assert.equal(a.state().collection.length, 1);
  assert.ok(!('trade' in a.state().collection[0]), 'a missing entry gains no trade key');
});

test('lowering qty clamps trade; the last copy drops the entry and its trade count', () => {
  const a = app();
  a.call('cache', card());
  a.call('addTo', 'collection', 'sol-ring', false, 3);
  a.call('setTrade', 'sol-ring', false, 2);
  a.call('removeFrom', 'collection', 'sol-ring', false, 1); // the qty − button path: 3 → 2
  assert.equal(a.state().collection[0].qty, 2);
  assert.equal(a.state().collection[0].trade, 2, 'trade fits the new qty unchanged');
  a.call('removeFrom', 'collection', 'sol-ring', false, 1); // 2 → 1: trade clamps to 1
  assert.equal(a.state().collection[0].qty, 1);
  assert.equal(a.state().collection[0].trade, 1);
  a.call('removeFrom', 'collection', 'sol-ring', false, 1); // the last copy: the entry goes
  assert.deepEqual(json(a.state().collection), []);
});

test('scan undo clamps the trade count along with qty', () => {
  const a = app();
  const c = a.call('cache', card());
  a.state().settings.dest = 'collection';
  a.call('addTo', 'collection', c.id, false, 2);
  a.call('setTrade', c.id, false, 2);
  a.call('addScanned', c);             // qty 3
  a.call('setTrade', c.id, false, 3);  // all three marked
  a.element('button').onclick();       // Undo
  const e = a.state().collection[0];
  assert.equal(e.qty, 2);
  assert.equal(e.trade, 2, 'undo lowers qty, trade clamps with it');
  assert.equal(a.state().recent.length, 0);
});

test('tradeOnly filters the list to trade entries and swaps in the trade stat tiles', () => {
  const a = app();
  a.call('cache', card());
  a.call('cache', card('island', { name: 'Island', oracle_id: 'island-oracle', prices: { usd: '0.25', usd_foil: '0.50' } }));
  a.call('addTo', 'collection', 'sol-ring', false, 2);
  a.call('addTo', 'collection', 'sol-ring', true, 1);
  a.call('addTo', 'collection', 'island', false, 4);
  a.call('setTrade', 'sol-ring', false, 1);
  a.call('setTrade', 'sol-ring', true, 1);
  const ids = () => [...a.element('#collList').innerHTML.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);
  a.call('renderCollection');
  assert.match(a.element('#collStats').innerHTML, /Total value/, 'usual tiles with the toggle off');
  assert.ok(a.element('#tradeCopy').classList.contains('hidden'), 'share buttons hidden');
  assert.deepEqual(ids(), ['island', 'sol-ring', 'sol-ring']); // recent sort: newest first
  a.state().settings.tradeOnly = true;
  a.call('renderCollection');
  assert.deepEqual(ids(), ['sol-ring', 'sol-ring'], 'only entries with trade > 0');
  assert.ok(!a.element('#tradeCopy').classList.contains('hidden') && !a.element('#tradeCsv').classList.contains('hidden'));
  const stats = a.element('#collStats').innerHTML;
  assert.match(stats, /Trade value/);
  // 1 normal ($2.50) + 1 foil ($5.00): $7.50, 2 copies, 1 identity
  assert.match(stats, /<b>\$7\.50<\/b><span>Trade value/);
  assert.match(stats, /<b>2<\/b><span>For trade/);
  assert.match(stats, /<b>1<\/b><span>Unique/);
  // the filter still applies in trade view
  a.element('#collFilter').value = 'island';
  a.call('renderCollection');
  // review: cards ARE marked for trade, the filter just hides them
  assert.match(a.element('#collList').innerHTML, /Nothing matches\./);
  a.element('#collFilter').value = 'sol';
  a.call('renderCollection');
  assert.deepEqual(ids(), ['sol-ring', 'sol-ring']);
});

test('tradeOnly with nothing marked shows the trade empty state, and off restores the list', () => {
  const a = app();
  a.call('cache', card());
  a.call('addTo', 'collection', 'sol-ring', false, 2);
  a.state().settings.tradeOnly = true;
  a.call('renderCollection');
  assert.match(a.element('#collList').innerHTML, /Nothing marked for trade yet\. Open a card you own and set how many to trade\./);
  a.state().settings.tradeOnly = false;
  a.call('renderCollection');
  assert.match(a.element('#collList').innerHTML, /data-id="sol-ring"/);
});

test('the For-trade-only toggle saves the setting, re-renders and stays in sync', () => {
  const a = app();
  a.call('cache', card());
  a.call('addTo', 'collection', 'sol-ring', false, 2);
  a.call('setTrade', 'sol-ring', false, 1);
  a.element('#tradeOnly').checked = true;
  a.element('#tradeOnly').onchange({ target: { checked: true } });
  assert.ok(a.state().settings.tradeOnly);
  a.flush();
  assert.equal(JSON.parse(a.stored.get(storageKey)).settings.tradeOnly, true, 'the setting persists');
  assert.match(a.element('#collStats').innerHTML, /For trade/, 'the tiles re-render');
  a.element('#tradeOnly').onchange({ target: { checked: false } });
  assert.ok(!a.state().settings.tradeOnly);
  assert.match(a.element('#collStats').innerHTML, /Total value/);
  // a restored state syncs the checkbox on the next render, like #searchOwned
  a.state().settings.tradeOnly = true;
  a.call('renderAll');
  assert.equal(a.element('#tradeOnly').checked, true);
});

test('the trade value tile keeps the price-change line, computed from trade copies', () => {
  const a = app();
  a.call('cache', card('up', { oracle_id: 'up-oracle', name: 'Up', prices: { usd: '2.50', usd_foil: '5.00' } }));
  a.call('cache', card('up', { oracle_id: 'up-oracle', name: 'Up', prices: { usd: '3.50', usd_foil: '5.00' } })); // +1.00 normal
  a.call('addTo', 'collection', 'up', false, 3);
  a.call('setTrade', 'up', false, 2);
  a.state().settings.tradeOnly = true;
  a.call('renderCollection');
  // 2 trade copies × +1.00 = +2.00, not the 3 owned copies' +3.00
  assert.match(a.element('#collStats').innerHTML, /<span class="chg up">▲ \$2\.00<\/span>/);
  assert.match(a.element('#collStats').innerHTML, /Trade value/);
});

test('collection rows badge the trade count by the card name', () => {
  const a = app();
  a.call('cache', card());
  a.call('addTo', 'collection', 'sol-ring', false, 2);
  a.call('addTo', 'collection', 'sol-ring', true, 1);
  a.call('setTrade', 'sol-ring', true, 1);
  a.call('renderCollection');
  const html = a.element('#collList').innerHTML;
  // review: a badge on the name line, since the grey set line is truncated on phones and hid it
  assert.match(html, /<div class="n">Sol Ring<span class="badge foil">FOIL<\/span> <span class="badge trade" title="1 for trade">⇄ 1<\/span><\/div>/, 'the marked entry is badged');
  assert.equal((html.match(/class="badge trade"/g) || []).length, 1, 'the unmarked entry is not');
});

test('the card popup stepper marks copies for trade without closing the popup', async () => {
  const num = () => ({ textContent: '' });
  const normal = num(), foil = num();
  const step = (trade, f, n) => ({ dataset: { trade: String(trade), foil: f ? '1' : '0' }, parentElement: { querySelector: () => n } });
  const buttons = [step(-1, false, normal), step(1, false, normal), step(-1, true, foil), step(1, true, foil)];
  const a = app({ route: () => ok(card()), all: { '[data-trade]': buttons } });
  a.call('cache', card());
  a.call('addTo', 'collection', 'sol-ring', false, 2);
  a.call('addTo', 'collection', 'sol-ring', true, 1);
  await a.call('openCard', 'sol-ring');
  const modal = () => a.element('#modalBody').innerHTML;
  assert.match(modal(), /For trade/);
  assert.ok(modal().includes('own 2') && modal().includes('own 1'), 'one row per owned finish');
  assert.ok(modal().includes('data-trade="-1"') && modal().includes('data-trade="1"'), 'a −/+ stepper per row');
  const entry = (f) => a.state().collection.find((e) => !!e.foil === f);
  buttons[1].onclick(); // + normal → 1
  assert.equal(entry(false).trade, 1);
  assert.equal(normal.textContent, 1, 'the number updates in place');
  assert.match(modal(), /<h2>Sol Ring<\/h2>/, 'the popup stays open');
  assert.match(a.element('#collList').innerHTML, /title="1 for trade">⇄ 1</, 'renderAll refreshed the list behind it');
  buttons[1].onclick(); // + normal → 2
  buttons[1].onclick(); // + normal → clamped at qty 2
  assert.equal(entry(false).trade, 2);
  buttons[0].onclick(); // − normal → 1
  buttons[0].onclick(); // − normal → 0: key dropped
  assert.ok(!('trade' in entry(false)));
  buttons[3].onclick(); // + foil → 1
  buttons[3].onclick(); // + foil → clamped at qty 1
  assert.equal(entry(true).trade, 1);
  buttons[2].onclick(); // − foil → 0
  assert.ok(!('trade' in entry(true)));
});

test('a printing you do not own shows no For-trade block in the popup', async () => {
  const a = app({ route: (url) => ok(url.pathname === '/cards/other' ? card('other') : card()) });
  a.call('cache', card());
  a.call('addTo', 'collection', 'sol-ring', false, 1);
  await a.call('openCard', 'other'); // same card, different (unowned) printing
  assert.match(a.element('#modalBody').innerHTML, /<h2>Sol Ring<\/h2>/);
  assert.ok(!a.element('#modalBody').innerHTML.includes('For trade'), 'no empty block');
  assert.ok(!a.element('#modalBody').innerHTML.includes('data-trade'));
});

test('tradeText and the trade CSV put one line per trade entry, Count = trade', () => {
  const a = app();
  a.call('cache', card('signet', { name: 'Arcane Signet', oracle_id: 'signet-oracle', prices: { usd: '2.25', usd_foil: '4.00' } }));
  a.call('cache', card());
  a.call('addTo', 'collection', 'sol-ring', true, 2);
  a.call('addTo', 'collection', 'signet', false, 3);
  a.call('setTrade', 'sol-ring', true, 1);
  a.call('setTrade', 'signet', false, 2);
  assert.equal(a.call('tradeText'), '2 Arcane Signet (C21) 263\n1 Sol Ring (C21) 263 *F*\n\nTotal: $9.50');
  // the button maps entries the same way: Count is the trade count, columns unchanged
  const csv = a.call('toCsv', a.call('tradeEntries').map((e) => ({ cardId: e.cardId, foil: e.foil, qty: e.trade })));
  const [head, signetRow, solRow] = csv.split('\r\n');
  assert.equal(head, 'Count,Name,Edition,Set Code,Collector Number,Foil,Board,Rarity,Type,Price (USD),Total (USD),Scryfall ID');
  assert.equal(signetRow, '2,Arcane Signet,Commander 2021,C21,263,,,uncommon,Artifact,2.25,4.50,signet');
  assert.equal(solRow, '1,Sol Ring,Commander 2021,C21,263,foil,,uncommon,Artifact,5.00,5.00,sol-ring');
  // the full collection CSV is unchanged: Count is owned qty, no trade column
  const [, foilRow, plainRow] = a.call('toCsv', a.state().collection).split('\r\n');
  assert.equal(foilRow, '2,Sol Ring,Commander 2021,C21,263,foil,,uncommon,Artifact,5.00,10.00,sol-ring');
  assert.equal(plainRow, '3,Arcane Signet,Commander 2021,C21,263,,,uncommon,Artifact,2.25,6.75,signet');
});

test('#tradeCopy copies the trade list as text', async () => {
  const a = app();
  a.call('cache', card());
  a.call('addTo', 'collection', 'sol-ring', false, 2);
  a.call('setTrade', 'sol-ring', false, 2);
  a.eval('navigator.clipboard = { writeText: async (t) => { __copied = t; } }');
  a.element('#tradeCopy').onclick();
  assert.equal(a.eval('__copied'), '2 Sol Ring (C21) 263\n\nTotal: $5.00');
});

test('copies marked for trade still count as owned everywhere', () => {
  const a = app();
  a.call('cache', card());
  a.call('addTo', 'collection', 'sol-ring', false, 2);
  a.call('setTrade', 'sol-ring', false, 2); // every copy marked
  assert.equal(a.call('ownedCount', 'sol-ring-oracle'), 2);
  assert.equal(a.call('collectionTotals').cards, 2);
  const d = a.call('createDeck', 'Wants');
  a.call('addTo', d.id, 'sol-ring', false, 2);
  assert.deepEqual(json(a.call('shoppingList', d)), [], 'the shopping list sees them as owned');
  a.call('showShoppingList', d);
  assert.match(a.element('#modalBody').innerHTML, /You own every card in this deck/);
});

test('a legacy save with no trade and no tradeOnly loads, renders and saves without trade keys', () => {
  const legacy = JSON.stringify(saved({
    cards: { 'sol-ring': { id: 'sol-ring', name: 'Sol Ring', oracle_id: 'sol-ring-oracle', set: 'c21', cn: '263', prices: { usd: '2.50', usd_foil: '5.00' }, updated: 1 } },
    collection: [{ cardId: 'sol-ring', qty: 2, foil: false, added: 1 }],
    decks: [{ id: 'deck', name: 'Old deck', format: 'commander', created: 1, cards: [{ cardId: 'sol-ring', qty: 1, foil: false, board: 'main' }] }],
    recent: [{ cardId: 'sol-ring', foil: false, t: 1 }],
  }));
  const a = app({ raw: legacy });
  assert.equal(a.state().schema, 1);
  assert.ok(!a.state().settings.tradeOnly, 'tradeOnly defaults off');
  a.call('renderAll');
  assert.match(a.element('#collStats').innerHTML, /Total value/);
  assert.ok(a.element('#tradeCopy').classList.contains('hidden'), 'the trade buttons stay hidden');
  a.call('addTo', 'collection', 'sol-ring', false, 1);
  a.flush();
  const data = JSON.parse(a.stored.get(storageKey));
  assert.equal(data.schema, 1);
  assert.deepEqual(data.collection, [{ cardId: 'sol-ring', qty: 3, foil: false, added: 1 }]);
  assert.ok(!('trade' in data.collection[0]), 'no trade key appears on old entries');
  // a save that already has trade and tradeOnly loads and works (additive fields, same schema)
  const b = app({ raw: JSON.stringify(saved({
    cards: { 'sol-ring': { id: 'sol-ring', name: 'Sol Ring', oracle_id: 'sol-ring-oracle', set: 'c21', cn: '263', prices: { usd: '2.50', usd_foil: '5.00' }, updated: 1 } },
    collection: [{ cardId: 'sol-ring', qty: 2, foil: false, added: 1, trade: 2 }],
    settings: { dest: 'none', sound: true, exact: true, searchOwned: false, tradeOnly: true },
  })) });
  assert.equal(b.state().collection[0].trade, 2);
  assert.ok(b.state().settings.tradeOnly);
  b.call('renderAll');
  assert.equal(b.element('#tradeOnly').checked, true);
  assert.match(b.element('#collStats').innerHTML, /Trade value/);
  assert.match(b.element('#collStats').innerHTML, /<b>\$5\.00<\/b>/, '2 × $2.50 marked for trade');
});
