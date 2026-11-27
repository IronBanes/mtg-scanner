'use strict';
/* Deck insights (insights.js): pure analysis plus the review-pass fixes to the Stats and Test hand tabs.
   Loads app.js then insights.js into one vm context, the same way index.html does. */

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { app, card, json, failure } = require('./harness.cjs');

const LEGAL = Object.fromEntries(['commander', 'standard', 'pioneer', 'modern', 'legacy', 'vintage', 'pauper'].map((f) => [f, 'legal']));
/** A Scryfall-shaped card; cached through app.js's slim() so the tests see what the app stores. */
const sfCard = (id, o = {}) => card(id, {
  oracle_id: id + '-oracle', name: id, type_line: 'Instant', cmc: 0, mana_cost: '',
  color_identity: [], keywords: [], legalities: LEGAL, ...o,
});
const basic = (id, produced) => sfCard(id, { type_line: 'Basic Land — ' + id, produced_mana: produced });
const legend = (id, colors, o = {}) => sfCard(id, { type_line: 'Legendary Creature — Human', cmc: 3, color_identity: colors, ...o });

function setup(cards, opts = {}) {
  const a = app({ insights: true, ...opts });
  for (const c of cards) a.call('cache', c);
  return a;
}
const deck = (a, name, format, entries) => {
  const d = a.call('createDeck', name, format);
  for (const [id, qty, board = 'main', foil = false] of entries) a.call('addTo', d.id, id, foil, qty, board);
  return d;
};
const analyze = (a, d, format = d.format) => json(a.insights().analyzeDeck(d.cards, a.state().cards, format));
const NOPAIR = 'These two commanders can’t be used together (they need matching partner, Background or Doctor abilities).';
const kinds = (r) => r.issues.map((i) => i.kind).sort();
const open = (a, d, tab) => {
  a.eval(`openDeckId = ${JSON.stringify(d.id)}`);
  a.call('renderDeckDetail');
  if (tab) { a.eval(`deckTab = ${JSON.stringify(tab)}`); a.call('renderDeckDetail'); }
  return a.element('#deckDetail').innerHTML;
};

test('analyzeDeck: curve, averages, highest, color symbols vs sources, types, keywords, land advice', () => {
  const a = setup([
    sfCard('bolt', { cmc: 1, mana_cost: '{R}', color_identity: ['R'] }),
    sfCard('goblin', { type_line: 'Creature — Goblin', cmc: 2, mana_cost: '{1}{R}', keywords: ['Haste'] }),
    sfCard('titan', { type_line: 'Creature — Giant', cmc: 6, mana_cost: '{4}{R}{R}' }),
    sfCard('dragon', { type_line: 'Creature — Dragon', cmc: 6, mana_cost: '{4}{R}{G}', keywords: ['Flying'] }),
    sfCard('big', { type_line: 'Sorcery', cmc: 9, mana_cost: '{7}{G}{G}' }),
    sfCard('side-only', { cmc: 3, mana_cost: '{U}{U}{U}' }),
    basic('Mountain', ['R']), basic('Forest', ['G']),
  ]);
  const d = deck(a, 'Gruul', 'modern', [
    ['bolt', 4], ['goblin', 4], ['titan', 2], ['dragon', 1], ['big', 1], ['Mountain', 10], ['Forest', 2],
    ['side-only', 2, 'side'], ['side-only', 3, 'maybe'], ['not-cached', 4],
  ]);
  const r = analyze(a, d);
  assert.equal(r.total, 24); // side, maybe and uncached cards don't count
  assert.equal(r.lands, 12);
  assert.equal(r.nonland, 12);
  assert.deepEqual(r.curve, [0, 4, 4, 0, 0, 0, 3, 1]); // last bucket is 7+
  assert.equal(r.avgMv, 39 / 12);
  assert.equal(r.avgMvWithLands, 39 / 24);
  assert.deepEqual(r.highest, { mv: 9, names: ['big'] });
  assert.deepEqual(r.pips, { W: 0, U: 0, B: 0, R: 13, G: 3 });
  assert.deepEqual(r.sources, { W: 0, U: 0, B: 0, R: 10, G: 2, C: 0 });
  assert.deepEqual(r.types, { Instant: 4, Creature: 7, Sorcery: 1, Land: 12 });
  assert.deepEqual(r.keywords, { Haste: ['goblin'], Flying: ['dragon'] });
  assert.deepEqual(r.landAdvice, [23, 26]);
  assert.deepEqual(r.issues.map((i) => i.text), ['Deck has 24 cards; modern needs at least 60.']);

  assert.deepEqual(analyze(a, d, 'commander').landAdvice, [36, 38]);
  assert.deepEqual(analyze(a, d, 'limited').landAdvice, [16, 18]);
  const casual = analyze(a, d, 'casual');
  assert.deepEqual(casual.landAdvice, [23, 26]);
  assert.deepEqual(casual.issues, [], 'formats without rules report no legality issues');
});

test('analyzeDeck: ties for highest mana value list every card once', () => {
  const a = setup([sfCard('x', { cmc: 5 }), sfCard('y', { cmc: 5 }), sfCard('z', { cmc: 2 })]);
  const d = deck(a, 'Ties', 'modern', [['x', 1], ['z', 1], ['y', 1], ['x', 1, 'main', true]]);
  assert.deepEqual(analyze(a, d).highest, { mv: 5, names: ['x', 'y'] });
  const empty = analyze(a, deck(a, 'Empty', 'modern', []));
  assert.equal(empty.highest, null);
  assert.equal(empty.avgMv, 0);
  assert.equal(empty.avgMvWithLands, 0);
});

test('commander legality: size, banned, not legal, color identity, copies and the any-number rule', () => {
  const a = setup([
    legend('boros', ['R', 'W']),
    sfCard('sol', { type_line: 'Artifact', cmc: 1 }),
    sfCard('bolt', { color_identity: ['R'] }),
    sfCard('rats', { type_line: 'Creature — Rat', color_identity: ['B'], oracle_text: 'A deck can have any number of cards named rats.' }),
    sfCard('banned', { legalities: { ...LEGAL, commander: 'banned' } }),
    sfCard('nope', { legalities: { ...LEGAL, commander: 'not_legal' } }),
    basic('Mountain', ['R']),
  ]);
  const d = deck(a, 'Boros', 'commander', [
    ['boros', 1, 'commander'], ['sol', 2], ['sol', 1, 'side'], ['bolt', 1], ['rats', 10], ['banned', 1], ['nope', 1],
    ['Mountain', 20], ['nope', 4, 'maybe'],
  ]);
  const r = analyze(a, d);
  assert.deepEqual(r.identity.sort(), ['R', 'W']);
  assert.deepEqual(r.issues.map((i) => i.text), [
    'Deck has 36 cards; commander decks need exactly 100 (including the commander).',
    'rats is outside your commander’s colors.',
    'banned is banned in commander.',
    'nope isn’t legal in commander.',
    '2 copies of sol; the limit is 1.', // the sideboard copy is ignored in commander; basics and "any number" cards are exempt
  ]);

  const legalDeck = deck(a, 'Legal', 'commander', [['boros', 1, 'commander'], ['Mountain', 99]]);
  assert.deepEqual(analyze(a, legalDeck).issues, []);

  const noCommander = deck(a, 'No commander', 'commander', [['rats', 1], ['Mountain', 99]]);
  assert.deepEqual(kinds(analyze(a, noCommander)), ['commander'], 'no identity check without a commander');
});

test('commander legality: partner pairs, too many commanders, and cards that cannot command', () => {
  const a = setup([
    legend('solo', ['W']),
    legend('p1', ['U'], { keywords: ['Partner'] }),
    legend('p2', ['B'], { keywords: ['Partner'] }),
    legend('bg-fan', ['G'], { oracle_text: 'Choose a Background' }),
    legend('bg-fan2', ['R'], { oracle_text: 'Choose a Background' }),
    sfCard('bg', { type_line: 'Legendary Enchantment — Background', color_identity: ['G'] }),
    legend('pw-a', ['W'], { keywords: ['Partner with'], oracle_text: 'Partner with pw-b (When this creature enters, target player may put pw-b into their hand from their library, then shuffle.)' }),
    legend('pw-b', ['U'], { keywords: ['Partner with'], oracle_text: 'Partner with pw-a (When this creature enters, ...)' }),
    legend('ff1', ['W'], { keywords: ['Friends forever'] }), legend('ff2', ['U'], { keywords: ['Friends forever'] }),
    legend('doctor', ['U'], { type_line: 'Legendary Creature — Time Lord Doctor' }),
    legend('companion', ['W'], { oracle_text: 'Doctor’s companion (You can have two commanders if the other is the Doctor.)' }),
    sfCard('grunt', { type_line: 'Creature — Human', color_identity: ['W'] }),
    basic('Plains', ['W']),
  ]);
  const cmdIssues = (entries) => analyze(a, deck(a, 'D', 'commander', entries)).issues.filter((i) => i.kind === 'commander').map((i) => i.text);
  const pair = (x, y) => cmdIssues([[x, 1, 'commander'], [y, 1, 'commander'], ['Plains', 98]]);
  assert.deepEqual(cmdIssues([['p1', 1, 'commander'], ['p2', 1, 'commander'], ['Plains', 98]]), []);
  assert.deepEqual(cmdIssues([['bg-fan', 1, 'commander'], ['bg', 1, 'commander'], ['Plains', 98]]), []);
  for (const [x, y] of [['pw-a', 'pw-b'], ['ff1', 'ff2'], ['doctor', 'companion']]) assert.deepEqual(pair(x, y), [], x + ' + ' + y);
  for (const [x, y] of [['solo', 'p1'], ['bg-fan', 'bg-fan2'], ['p1', 'bg'], ['p1', 'pw-a'], ['p1', 'ff1'], ['pw-a', 'p1'], ['ff1', 'companion']]) {
    const expected = y === 'bg' ? ['bg can’t normally be a commander.', NOPAIR] : [NOPAIR];
    assert.deepEqual(pair(x, y), expected, x + ' + ' + y);
  }
  assert.deepEqual(cmdIssues([['p1', 1, 'commander'], ['p2', 1, 'commander'], ['solo', 1, 'commander'], ['Plains', 97]]),
    ['Only up to two commanders are allowed (with partner).']);
  assert.deepEqual(cmdIssues([['grunt', 1, 'commander'], ['Plains', 99]]), ['grunt can’t normally be a commander.']);
  assert.deepEqual(cmdIssues([['bg', 1, 'commander'], ['Plains', 99]]), ['bg can’t normally be a commander.'], 'a Background cannot lead alone');
});

test('cards cached before release 5 (old partner flag only) still pair as before', () => {
  const a = setup([]);
  const { analyzeDeck } = a.insights();
  const old = (id, partner) => ({ id, name: id, type: 'Legendary Creature — Elf', cmc: 2, colors: ['G'], legal: { commander: 'legal' }, canCommand: true, partner });
  const cards = { x: old('x', true), y: old('y', true), z: old('z', false) };
  const issues = (p, q) => json(analyzeDeck([{ cardId: p, qty: 1, board: 'commander' }, { cardId: q, qty: 1, board: 'commander' }], cards, 'commander'))
    .issues.filter((i) => i.kind === 'commander');
  assert.deepEqual(issues('x', 'y'), []);
  assert.equal(issues('x', 'z').length, 1);
});

test('a colorless commander still flags colored cards', () => {
  const a = setup([legend('karn', [], { type_line: 'Legendary Artifact Creature — Golem' }), sfCard('bolt', { color_identity: ['R'] }), sfCard('ring', { type_line: 'Artifact' })]);
  const d = deck(a, 'Karn', 'commander', [['karn', 1, 'commander'], ['bolt', 1], ['ring', 1]]);
  assert.deepEqual(analyze(a, d).issues.filter((i) => i.kind === 'identity').map((i) => i.card), ['bolt']);
});

test('restricted cards are limited to one copy; cards with their own limit (Nazgûl) use it', () => {
  const a = setup([
    sfCard('lotus', { type_line: 'Artifact', legalities: { ...LEGAL, vintage: 'restricted' } }),
    sfCard('nazgul', { type_line: 'Creature — Wraith Knight', color_identity: ['B'], oracle_text: 'Deathtouch\nA deck can have up to nine cards named nazgul.' }),
    sfCard('opt'), basic('Island', ['U']),
  ]);
  assert.equal(a.state().cards.nazgul.copyLimit, 9);
  const vintage = (n, side = 0) => analyze(a, deck(a, 'V', 'vintage', [['lotus', n], ['lotus', side, 'side'], ['opt', 4], ['Island', 55]].filter((e) => e[1])))
    .issues.map((i) => i.text);
  assert.deepEqual(vintage(1), []);
  assert.deepEqual(vintage(2), ['2 copies of lotus; the limit is 1 (restricted).']);
  assert.deepEqual(vintage(1, 1), ['2 copies of lotus; the limit is 1 (restricted).'], 'main and sideboard count together');
  const legacy = analyze(a, deck(a, 'L', 'legacy', [['lotus', 4], ['Island', 56]]));
  assert.deepEqual(legacy.issues, [], 'restricted only matters where the card is restricted');

  const cmd = (n) => analyze(a, deck(a, 'N', 'commander', [['nazgul', n]])).issues.filter((i) => i.kind === 'copies').map((i) => i.text);
  assert.deepEqual(cmd(9), []);
  assert.deepEqual(cmd(10), ['10 copies of nazgul; the limit is 9.']);
});

test('legality is not reported as Legal while some cards have no legality data', async () => {
  const a = setup([sfCard('old', { legalities: undefined }), sfCard('opt'), basic('Island', ['U'])], { route: () => failure(503, 'offline') });
  const d = deck(a, 'Old', 'modern', [['old', 4], ['opt', 4], ['Island', 52]]);
  assert.deepEqual(analyze(a, d).unchecked, ['old']);
  let html = open(a, d, 'stats');
  assert.doesNotMatch(html, /badge-ok">Legal/);
  assert.match(html, /Not fully checked/);
  assert.match(html, /Still loading legality for 1 card…/);
  await a.eval('detailFetch');
  html = a.element('#deckDetail').innerHTML;
  assert.doesNotMatch(html, /badge-ok">Legal/);
  assert.match(html, /Couldn’t load legality for 1 card/);
  const fresh = deck(a, 'Fresh', 'modern', [['opt', 4], ['Island', 56]]);
  assert.match(open(a, fresh, 'stats'), /badge-ok">Legal/);
});

test('60-card legality: minimum size, sideboard limit, four copies, basics unlimited', () => {
  const a = setup([sfCard('opt'), sfCard('negate'), basic('Island', ['U'])]);
  const d = deck(a, 'Blue', 'modern', [['opt', 5], ['negate', 4], ['Island', 51], ['negate', 16, 'side']]);
  assert.deepEqual(analyze(a, d).issues.map((i) => i.text), [
    'Sideboard has 16 cards; the limit is 15.',
    '5 copies of opt; the limit is 4.',
    '20 copies of negate; the limit is 4.', // main + sideboard count together outside commander
  ]);
});

test('pipsOf counts colored symbols, including hybrid and Phyrexian, but not generic or colorless', () => {
  const a = setup([]);
  const { pipsOf } = a.insights();
  assert.deepEqual(json(pipsOf('{2}{W}{W/U}{G/P}{C}{X}')), { W: 2, U: 1, B: 0, R: 0, G: 1 });
  assert.deepEqual(json(pipsOf('')), { W: 0, U: 0, B: 0, R: 0, G: 0 });
  assert.deepEqual(json(pipsOf(undefined)), { W: 0, U: 0, B: 0, R: 0, G: 0 });
});

test('hypergeom gives exact draw odds and sums to 1', () => {
  const { hypergeom } = setup([]).insights();
  assert.equal(hypergeom(4, 2, 2, 1), 4 / 6);
  assert.equal(hypergeom(10, 10, 7, 7), 1);
  assert.equal(hypergeom(10, 0, 7, 1), 0);
  assert.equal(hypergeom(10, 3, 7, 4), 0, 'cannot draw more hits than exist');
  let sum = 0;
  for (let k = 0; k <= 7; k++) sum += hypergeom(60, 24, 7, k);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('buildLibrary expands only main-deck cards that are cached, and shuffles with the given random source', () => {
  const a = setup([sfCard('a'), sfCard('b'), sfCard('c')]);
  const d = deck(a, 'Lib', 'modern', [['a', 2], ['b', 1], ['c', 3, 'side'], ['c', 2, 'maybe'], ['ghost', 4], ['c', 1, 'commander']]);
  let calls = 0;
  const lib = json(a.insights().buildLibrary(d.cards, a.state().cards, () => { calls++; return 0; }));
  assert.deepEqual([...lib].sort(), ['a', 'a', 'b']);
  assert.equal(calls, 2);
  assert.deepEqual(lib, ['a', 'b', 'a']); // Fisher–Yates with rand() = 0
  const real = json(a.insights().buildLibrary(d.cards, a.state().cards)); // default crypto source
  assert.deepEqual(real.sort(), ['a', 'a', 'b']);
});

test('setCommanders moves one copy in, returns old commanders to the main deck, ignores cards not in the deck', () => {
  const a = setup([legend('leg', ['W']), legend('other', ['U']), legend('old', ['B'])]);
  const d = deck(a, 'Cmd', 'commander', [['leg', 2], ['other', 1, 'main', true], ['old', 1, 'commander']]);
  const boards = () => json(d.cards).map(({ cardId, qty, board, foil }) => `${board}:${cardId}x${qty}${foil ? 'f' : ''}`).sort();
  const set = (ids) => a.insights().setCommanders(d, ids);

  set(['leg']);
  assert.deepEqual(boards(), ['commander:legx1', 'main:legx1', 'main:oldx1', 'main:otherx1f']);
  set(['leg', 'other']);
  assert.deepEqual(boards(), ['commander:legx1', 'commander:otherx1f', 'main:legx1', 'main:oldx1']);
  set(['forged-id']);
  assert.deepEqual(boards(), ['main:legx2', 'main:oldx1', 'main:otherx1f']);
});

test('setCommanders keeps one commander copy and moves extras to the main deck with their foil', () => {
  const a = setup([legend('krenko', ['R'])]);
  const d = deck(a, 'Dup', 'commander', [['krenko', 2, 'commander'], ['krenko', 1, 'commander', true]]);
  a.insights().setCommanders(d, ['krenko']);
  const boards = json(d.cards).map(({ cardId, qty, board, foil }) => `${board}:${cardId}x${qty}${foil ? 'f' : ''}`).sort();
  assert.deepEqual(boards, ['commander:krenkox1', 'main:krenkox1', 'main:krenkox1f']);
});

test('commander picker drops ids that are not in the deck and refuses more than two', () => {
  const picked = [];
  const a = setup([legend('leg', ['W']), legend('p1', ['U']), legend('p2', ['B'])], {
    all: { '.pick-list input:checked': picked },
  });
  const d = deck(a, 'Pick', 'commander', [['leg', 1], ['p1', 1], ['p2', 1]]);
  a.call('pickCommander', d);
  picked.push({ value: 'leg' }, { value: 'forged' });
  a.element('#cmdSave').onclick();
  assert.deepEqual(json(d.cards.filter((e) => e.board === 'commander').map((e) => e.cardId)), ['leg']);

  a.call('pickCommander', d);
  picked.splice(0, Infinity, { value: 'leg' }, { value: 'p1' }, { value: 'p2' });
  a.element('#cmdSave').onclick();
  assert.match(a.element('#toast').innerHTML, /at most two/);
  assert.deepEqual(json(d.cards.filter((e) => e.board === 'commander').map((e) => e.cardId)), ['leg']);
});

test('commander picker lists Backgrounds as well as legendary creatures', () => {
  const a = setup([legend('bg-fan', ['G'], { oracle_text: 'Choose a Background' }),
    sfCard('bg', { type_line: 'Legendary Enchantment — Background', color_identity: ['G'] }), sfCard('bolt')]);
  const d = deck(a, 'Bg', 'commander', [['bg-fan', 1], ['bg', 1], ['bolt', 1]]);
  a.call('pickCommander', d);
  const ids = [...a.element('#modalBody').innerHTML.matchAll(/type="checkbox" value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['bg-fan', 'bg']);
});

test('card details are fetched once per card per session, so offline or missing cards cannot loop', async () => {
  // Cards cached before this release have no legalities; Scryfall is down.
  const a = setup([sfCard('old', { legalities: undefined }), sfCard('fresh')], { route: () => failure(503, 'offline') });
  const d = deck(a, 'Old deck', 'modern', [['old', 4], ['fresh', 4]]);
  assert.match(open(a, d, 'stats'), /Loading card details/);
  assert.equal(a.call('ensureCardDetails', d), false, 'a fetch is already running');
  assert.equal(a.requests.length, 1);
  assert.deepEqual(json(a.requests[0].body.identifiers), [{ id: 'old' }]);

  await a.eval('detailFetch');
  assert.equal(a.eval('detailFetch'), null);
  assert.match(a.element('#toast').innerHTML, /Couldn.t load card details/);
  assert.doesNotMatch(a.element('#deckDetail').innerHTML, /Loading/, 'the Stats tab re-renders when the fetch ends');
  assert.equal(a.requests.length, 1, 'the re-render must not start another fetch');

  a.call('renderDeckDetail');
  assert.equal(a.call('ensureCardDetails', d), false);
  assert.equal(a.requests.length, 1);
});

test('the open deck is re-rendered when a details fetch started by another deck finishes', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const a = setup([sfCard('old', { legalities: undefined }), sfCard('fresh')], {
    route: async () => { await gate; return Response.json({ data: [sfCard('old')] }); },
  });
  const first = deck(a, 'First', 'modern', [['old', 1]]);
  const second = deck(a, 'Second', 'modern', [['fresh', 1]]);
  open(a, first, 'stats');
  assert.match(open(a, second, 'stats'), /Loading card details/); // the shared fetch is still running
  release();
  await a.eval('detailFetch');
  assert.doesNotMatch(a.element('#deckDetail').innerHTML, /Loading/);
  assert.match(a.element('#deckDetail').innerHTML, /<h2>Second<\/h2>/);
  assert.ok(a.state().cards.old.legal, 'the fetched card details were stored');
});

test('the deck tab resets to Cards when you switch decks or go back', () => {
  const tabs = [{ dataset: { decktab: 'stats' } }];
  const a = setup([sfCard('x')], { all: { '[data-decktab]': tabs } });
  const one = deck(a, 'One', 'modern', [['x', 1]]);
  const two = deck(a, 'Two', 'modern', [['x', 1]]);
  open(a, one);
  tabs[0].onclick();
  assert.equal(a.eval('deckTab'), 'stats');
  open(a, two);
  assert.equal(a.eval('deckTab'), 'cards', 'switching decks starts on Cards');
  tabs[0].onclick();
  a.call('renderDeckDetail');
  assert.equal(a.eval('deckTab'), 'stats', 'same deck keeps its tab across re-renders');
  a.element('#deckBack').onclick();
  open(a, two);
  assert.equal(a.eval('deckTab'), 'cards', 'leaving and reopening the same deck starts on Cards');
});

test('deckSig only depends on the main deck, not entry order or other boards', () => {
  const a = setup([]);
  const { deckSig } = a.insights();
  const base = [{ cardId: 'a', qty: 2, board: 'main' }, { cardId: 'b', qty: 1, board: 'main' }];
  const sig = deckSig({ cards: base });
  assert.equal(deckSig({ cards: [...base].reverse() }), sig);
  assert.equal(deckSig({ cards: [...base, { cardId: 'c', qty: 1, board: 'side' }, { cardId: 'd', qty: 1, board: 'maybe' }] }), sig);
  assert.notEqual(deckSig({ cards: [{ ...base[0], qty: 3 }, base[1]] }), sig);
  assert.notEqual(deckSig({ cards: [...base, { cardId: 'c', qty: 1, board: 'main' }] }), sig);
  a.call('cache', sfCard('a'));
  assert.notEqual(deckSig({ cards: base }), sig, 'a card becoming cached changes the library, so the signature too');
});

test('test hand size, message and odds only count cards with data, and redeal when one arrives', () => {
  const a = setup([sfCard('a'), basic('Island', ['U'])]);
  const d = deck(a, 'Partial', 'modern', [['a', 3], ['Island', 3], ['later', 1]]);
  assert.match(open(a, d, 'hand'), /Add at least 7 main-deck cards/, 'six usable cards is not enough');
  a.call('cache', sfCard('later'));
  const html = open(a, d, 'hand');
  assert.match(html, /7 cards in hand/);
  assert.match(html, /With 3 lands in 7 cards/);
});

test('a test hand is redealt after the main deck changes', () => {
  const a = setup([sfCard('a'), basic('Island', ['U']), sfCard('new')]);
  const d = deck(a, 'Hand', 'modern', [['a', 6], ['Island', 4]]);
  assert.match(open(a, d, 'hand'), /7 cards in hand/);
  const before = a.eval('hand');
  a.call('renderDeckDetail');
  assert.equal(a.eval('hand'), before, 'an unchanged deck keeps its hand');
  a.call('addTo', d.id, 'new', false, 1, 'side');
  a.call('renderDeckDetail');
  assert.equal(a.eval('hand'), before, 'sideboard changes keep the hand');
  a.call('addTo', d.id, 'new', false, 1);
  a.call('renderDeckDetail');
  const after = a.eval('hand');
  assert.notEqual(after, before);
  assert.equal(after.hand.length + after.library.length, 11);
});

test('test hand: fewer than 7 cards shows a message; mulligans stop at 6; bad hand indexes are ignored', () => {
  const handButtons = [];
  const a = setup([sfCard('a'), basic('Island', ['U'])], { all: { '[data-hand]': handButtons } });
  const small = deck(a, 'Small', 'modern', [['a', 6]]);
  assert.match(open(a, small, 'hand'), /Add at least 7 main-deck cards/);

  const d = deck(a, 'Mull', 'modern', [['a', 20], ['Island', 20]]);
  open(a, d, 'hand');
  for (let i = 0; i < 9; i++) a.element('#hMull').onclick();
  assert.equal(a.eval('hand.mulligans'), 6);
  assert.match(a.element('#deckDetail').innerHTML, /id="hMull" disabled/);

  // London mulligan: tap cards to put them on the bottom; forged or stale indexes do nothing
  const bogus = ['7', '-1', '1.5', 'x'].map((i) => ({ dataset: { hand: i } }));
  handButtons.push(...bogus, { dataset: { hand: '0' } });
  a.call('renderDeckDetail');
  for (const b of bogus) b.onclick();
  assert.equal(a.eval('hand.hand.length'), 7);
  assert.equal(a.eval('hand.bottomed'), 0);
  handButtons.at(-1).onclick();
  assert.equal(a.eval('hand.hand.length'), 6);
  assert.equal(a.eval('hand.library.length'), 34);
  assert.equal(a.eval('hand.bottomed'), 1);
  assert.equal(a.requests.length, 0, 'bottoming never opens a card');
});

test('the test hand shows the 2–4 land odds for the deck', () => {
  const a = setup([sfCard('a'), basic('Island', ['U'])]);
  const d = deck(a, 'Odds', 'modern', [['a', 36], ['Island', 24]]);
  let p = 0;
  for (let k = 2; k <= 4; k++) p += a.insights().hypergeom(60, 24, 7, k);
  assert.match(open(a, d, 'hand'), new RegExp(`With 24 lands in 60 cards, an opening 7 has 2–4 lands about <b>${Math.round(p * 100)}%</b>`));
});

test('the Stats tab renders legality, curve, lands and legendaries for a commander deck', () => {
  const a = setup([legend('boros', ['R', 'W'], { keywords: ['Flying'] }), sfCard('bolt', { cmc: 1, mana_cost: '{R}', color_identity: ['R'] }), basic('Mountain', ['R'])]);
  const d = deck(a, 'Boros', 'commander', [['boros', 1, 'commander'], ['bolt', 1], ['Mountain', 98]]);
  const html = open(a, d, 'stats');
  assert.match(html, /<span class="badge-ok">Legal<\/span>/);
  assert.match(html, /<b>98<\/b> lands of 100 cards\. <span class="warn">High/);
  assert.match(html, /<b>boros<\/b>/);
  assert.match(html, /Commander<\/span><\/li>/);
  assert.match(html, /<b>Flying<\/b>/);
  assert.match(html, /Can only be blocked by creatures with flying or reach/);
});

test('deck header counts the main deck and sideboard separately and skips Maybe', () => {
  const a = setup([sfCard('x'), legend('cmd', ['W'])]);
  const d = deck(a, 'Header', 'commander', [['cmd', 1, 'commander'], ['x', 3], ['x', 2, 'side'], ['x', 4, 'maybe']]);
  assert.match(open(a, d), /<b>4<\/b><span>Cards \+ 2 side<\/span>/);
  const noSide = deck(a, 'No side', 'commander', [['x', 3]]);
  assert.match(open(a, noSide), /<b>3<\/b><span>Cards<\/span>/);
});

test('app.js still renders decks when insights.js is not loaded', () => {
  const a = app();
  a.call('cache', sfCard('x'));
  const d = a.call('createDeck', 'Plain', 'modern');
  a.call('addTo', d.id, 'x', false, 2);
  a.eval(`openDeckId = ${JSON.stringify(d.id)}`);
  a.call('renderDeckDetail');
  const html = a.element('#deckDetail').innerHTML;
  assert.match(html, /Main deck \(2\)/);
  assert.doesNotMatch(html, /deck-tabs/);
  a.element('#deckBack').onclick();
  assert.equal(a.eval('openDeckId'), null);
});

test('deck +/- buttons are at least 40px so they are easy to tap on a phone', () => {
  const css = readFileSync(join(__dirname, '../style.css'), 'utf8');
  const rule = css.match(/\.qty button \{([^}]*)\}/)[1];
  assert.match(rule, /width: 40px/);
  assert.match(rule, /height: 40px/);
});
