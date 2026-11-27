'use strict';
/* Deck insights: stats, keywords, legality, commander picker, legendary tracker, test hands.
   Loaded after app.js and uses its helpers ($, esc, state, save, showModal, toast, ...).
   The analysis functions are pure (deck entries + card map in, plain data out) so they can be tested. */

// ---------------------------------------------------------------- keyword glossary (short, plain-English)
const KEYWORD_INFO = {
  'Flying': 'Can only be blocked by creatures with flying or reach.',
  'Reach': 'Can block creatures with flying.',
  'Trample': 'Extra combat damage beyond what kills the blockers goes to the player.',
  'Haste': 'Can attack and use tap abilities the turn it comes in.',
  'Deathtouch': 'Any amount of damage it deals to a creature is enough to destroy it.',
  'Lifelink': 'Damage it deals also gains you that much life.',
  'Vigilance': 'Attacking doesn’t tap it.',
  'First strike': 'Deals combat damage before creatures without first strike.',
  'Double strike': 'Deals combat damage twice: in a first-strike step and the normal step.',
  'Menace': 'Can’t be blocked except by two or more creatures.',
  'Hexproof': 'Can’t be targeted by spells or abilities your opponents control.',
  'Shroud': 'Can’t be targeted by any spells or abilities, including yours.',
  'Indestructible': 'Damage and “destroy” effects don’t kill it.',
  'Defender': 'Can’t attack.',
  'Flash': 'Can be cast any time you could cast an instant.',
  'Ward': 'When an opponent targets it, their spell or ability is countered unless they pay the ward cost.',
  'Protection': 'Can’t be damaged, enchanted/equipped, blocked or targeted by the named quality.',
  'Prowess': 'Gets +1/+1 until end of turn whenever you cast a noncreature spell.',
  'Equip': 'Pay the cost to attach this Equipment to a creature you control (sorcery speed).',
  'Enchant': 'Says what this Aura can be attached to.',
  'Flashback': 'Can be cast from your graveyard for its flashback cost, then it’s exiled.',
  'Cycling': 'Pay the cost and discard it to draw a card.',
  'Kicker': 'Optional extra cost when casting for a bigger effect.',
  'Cascade': 'When cast, reveal cards until a cheaper nonland card; you may cast it free.',
  'Convoke': 'Your creatures can tap to help pay for it.',
  'Delve': 'Exile cards from your graveyard to help pay the generic cost.',
  'Affinity': 'Costs less for each permanent of the named kind you control.',
  'Storm': 'Copy it for each spell cast before it this turn.',
  'Landfall': 'Triggers whenever a land enters under your control.',
  'Scry': 'Look at the top cards of your library; put any on the bottom, the rest back in any order.',
  'Surveil': 'Look at the top cards; put any in your graveyard, the rest back in any order.',
  'Mill': 'Put cards from the top of a library into the graveyard.',
  'Proliferate': 'Add one more of each kind of counter already on any players or permanents you choose.',
  'Exalted': 'When a creature attacks alone, it gets +1/+1 for each exalted instance you control.',
  'Infect': 'Deals damage to creatures as -1/-1 counters and to players as poison counters.',
  'Toxic': 'Combat damage to a player also gives them that many poison counters.',
  'Wither': 'Deals damage to creatures as -1/-1 counters.',
  'Persist': 'When it dies without a -1/-1 counter, it returns with one.',
  'Undying': 'When it dies without a +1/+1 counter, it returns with one.',
  'Evolve': 'Gets a +1/+1 counter when a bigger creature enters under your control.',
  'Annihilator': 'When it attacks, the defending player sacrifices that many permanents.',
  'Ninjutsu': 'Swap it in for an unblocked attacker by paying its ninjutsu cost.',
  'Mutate': 'Cast it onto a non-Human creature you own to merge them.',
  'Partner': 'Can be your commander alongside another commander with partner.',
  'Companion': 'Starts outside the game; can be put in your hand for {3} if your deck meets its condition.',
  'Treasure': 'A token you can sacrifice for one mana of any color.',
  'Food': 'A token you can pay {2}, tap and sacrifice to gain 3 life.',
  'Clue': 'A token you can pay {2} and sacrifice to draw a card.',
  'Investigate': 'Create a Clue token.',
  'Explore': 'Reveal the top card; a land goes to hand, otherwise put a +1/+1 counter on it.',
  'Amass': 'Put +1/+1 counters on your Army token (create one if needed).',
  'Connive': 'Draw, then discard; if a nonland was discarded, put a +1/+1 counter on it.',
  'Training': 'Gets a +1/+1 counter when it attacks with a bigger creature.',
  'Ward—Pay life': 'Like ward, but the opponent pays life instead of mana.',
  'Fight': 'Two creatures each deal damage equal to their power to the other.',
  'Sacrifice': 'Put a permanent you control into the graveyard (it isn’t destroyed).',
  'Transform': 'Turn a double-faced card to its other face.',
  'Morph': 'Can be cast face down as a 2/2 for {3} and turned up later.',
  'Disguise': 'Cast face down as a 2/2 with ward {2}; turn it up for its disguise cost.',
  'Cumulative upkeep': 'Pay the upkeep cost for each age counter, or sacrifice it.',
  'Echo': 'Pay its cost again on your next upkeep or sacrifice it.',
  'Suspend': 'Exile it with time counters; cast it free when the last counter comes off.',
  'Dredge': 'Instead of drawing, mill that many and return this from the graveyard to hand.',
  'Madness': 'If you discard it, you may cast it for its madness cost.',
  'Unearth': 'Return it from the graveyard for a turn with haste, then exile it.',
  'Bestow': 'Cast it as an Aura that gives its stats; it becomes a creature if the host leaves.',
  'Crew': 'Tap creatures with enough total power to turn this Vehicle into a creature.',
  'Fabricate': 'Choose: put +1/+1 counters on it, or make that many 1/1 Servos.',
  'Afterlife': 'When it dies, create that many 1/1 flying Spirits.',
  'Embalm': 'Exile it from the graveyard to make a token copy.',
  'Eternalize': 'Exile it from the graveyard to make a 4/4 black Zombie token copy.',
  'Riot': 'Choose: it enters with a +1/+1 counter or with haste.',
  'Adapt': 'If it has no +1/+1 counters, put that many on it.',
  'Raid': 'Bonus if you attacked this turn.',
  'Revolt': 'Bonus if a permanent you controlled left the battlefield this turn.',
  'Metalcraft': 'Bonus while you control three or more artifacts.',
  'Threshold': 'Bonus while seven or more cards are in your graveyard.',
  'Delirium': 'Bonus while four or more card types are in your graveyard.',
  'Constellation': 'Triggers when an enchantment enters under your control.',
  'Magecraft': 'Triggers when you cast or copy an instant or sorcery.',
  'Heroic': 'Triggers when you cast a spell that targets it.',
  'Domain': 'Counts the basic land types among lands you control.',
  'Kinship': 'At upkeep, reveal the top card; bonus if it shares a creature type.',
  'Changeling': 'Has every creature type.',
  'Devoid': 'It’s colorless even though it has colored mana in its cost.',
  'Living weapon': 'Comes in with a 0/0 Germ token and attaches to it.',
  'Battle cry': 'When it attacks, your other attackers get +1/+0.',
  'Extort': 'When you cast a spell, you may pay {W/B} to drain each opponent for 1.',
  'Populate': 'Copy a creature token you control.',
  'Venture into the dungeon': 'Move to the next room of a dungeon.',
  'Initiative': 'Take the initiative and venture into the Undercity.',
  'Monarch': 'Draw a card at your end step; dealing combat damage to the monarch steals it.',
};

// ---------------------------------------------------------------- pure analysis
const COLORS = ['W', 'U', 'B', 'R', 'G'];
const COLOR_NAMES = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' };
const TYPE_ORDER = ['Land', 'Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment'];
const LIMITS = {
  commander: { size: 100, exact: true, copies: 1, sideboard: 0 },
  standard: { size: 60, copies: 4, sideboard: 15 }, pioneer: { size: 60, copies: 4, sideboard: 15 },
  modern: { size: 60, copies: 4, sideboard: 15 }, legacy: { size: 60, copies: 4, sideboard: 15 },
  vintage: { size: 60, copies: 4, sideboard: 15 }, pauper: { size: 60, copies: 4, sideboard: 15 },
};
const LAND_ADVICE = { commander: [36, 38], limited: [16, 18], default: [23, 26] };

function primaryType(type) {
  const front = String(type || '').split(' // ')[0];
  return TYPE_ORDER.find((t) => front.includes(t)) || 'Other';
}
function isBasic(card) { return /\bBasic\b/.test(card.type || ''); }
function pipsOf(mana) {
  const out = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const sym of String(mana || '').match(/\{[^}]+\}/g) || []) for (const c of COLORS) if (sym.includes(c)) out[c]++;
  return out;
}
function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}
/** P(exactly k successes) drawing `draws` cards from `deck` cards that contain `hits` successes. */
function hypergeom(deck, hits, draws, k) { return (choose(hits, k) * choose(deck - hits, draws - k)) / choose(deck, draws); }

/**
 * Analyse a deck. entries: [{cardId, qty, board}], cards: {id: slimCard}, format: string.
 * Returns plain data used by the Stats tab (and by tests).
 */
function analyzeDeck(entries, cards, format) {
  const rows = entries.filter((e) => cards[e.cardId]).map((e) => ({ ...e, card: cards[e.cardId] }));
  const played = rows.filter((r) => r.board === 'main' || r.board === 'commander');
  const commanders = rows.filter((r) => r.board === 'commander');
  const count = (list) => list.reduce((s, r) => s + r.qty, 0);

  const curve = Array(8).fill(0); // 0..6, 7+
  let mvSum = 0, nonland = 0, highest = null;
  const types = {}, pips = { W: 0, U: 0, B: 0, R: 0, G: 0 }, sources = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  let lands = 0;
  const keywords = {};
  for (const r of played) {
    const c = r.card, t = primaryType(c.type);
    types[t] = (types[t] || 0) + r.qty;
    for (const k of c.keywords || []) (keywords[k] = keywords[k] || []).push(c.name);
    if (t === 'Land') {
      lands += r.qty;
      for (const m of c.produced || []) if (m in sources) sources[m] += r.qty;
      continue;
    }
    const mv = Number(c.cmc) || 0;
    curve[Math.min(7, Math.floor(mv))] += r.qty;
    mvSum += mv * r.qty; nonland += r.qty;
    if (!highest || mv > highest.mv) highest = { mv, names: [c.name] };
    else if (mv === highest.mv && !highest.names.includes(c.name)) highest.names.push(c.name);
    const p = pipsOf(c.mana);
    for (const col of COLORS) pips[col] += p[col] * r.qty;
  }

  // commander colour identity (union of the commanders' identities)
  const identity = new Set(commanders.flatMap((r) => r.card.colors || []));

  // legality
  const fmt = LIMITS[format] ? format : null;
  const issues = [];
  if (fmt) {
    const lim = LIMITS[fmt];
    const size = count(played);
    if (lim.exact && size !== lim.size) issues.push({ kind: 'size', text: `Deck has ${size} cards; ${fmt} decks need exactly ${lim.size} (including the commander).` });
    if (!lim.exact && size < lim.size) issues.push({ kind: 'size', text: `Deck has ${size} cards; ${fmt} needs at least ${lim.size}.` });
    const side = count(rows.filter((r) => r.board === 'side'));
    if (side > lim.sideboard && fmt !== 'commander') issues.push({ kind: 'size', text: `Sideboard has ${side} cards; the limit is ${lim.sideboard}.` });
    if (fmt === 'commander' && !commanders.length) issues.push({ kind: 'commander', text: 'No commander chosen yet.' });
    const byName = {};
    for (const r of rows.filter((x) => x.board !== 'maybe')) {
      const c = r.card, status = c.legal && c.legal[fmt];
      if (status === 'banned') issues.push({ kind: 'banned', card: c.name, text: `${c.name} is banned in ${fmt}.` });
      else if (status === 'not_legal') issues.push({ kind: 'not_legal', card: c.name, text: `${c.name} isn’t legal in ${fmt}.` });
      if (r.board !== 'side' || fmt !== 'commander') byName[c.name] = (byName[c.name] || 0) + r.qty;
      if (fmt === 'commander' && identity.size && r.board !== 'commander' && (c.colors || []).some((x) => !identity.has(x)))
        issues.push({ kind: 'identity', card: c.name, text: `${c.name} is outside your commander’s colors.` });
    }
    for (const [name, n] of Object.entries(byName)) {
      const c = rows.find((r) => r.card.name === name).card;
      if (n > lim.copies && !isBasic(c) && !c.anyNumber) issues.push({ kind: 'copies', card: name, text: `${n} copies of ${name}; the limit is ${lim.copies}.` });
    }
    if (fmt === 'commander') {
      for (const r of commanders) if (!r.card.canCommand) issues.push({ kind: 'commander', card: r.card.name, text: `${r.card.name} can’t normally be a commander.` });
      if (count(commanders) > 2) issues.push({ kind: 'commander', text: 'Only up to two commanders are allowed (with partner).' });
      if (count(commanders) === 2 && !commanders.every((r) => r.card.partner)) issues.push({ kind: 'commander', text: 'Two commanders need partner (or a background) to be used together.' });
    }
  }

  // legendary tracker
  const legends = played.filter((r) => /\bLegendary\b/.test(r.card.type || '')).map((r) => ({ id: r.card.id, name: r.card.name, type: r.card.type, qty: r.qty, canCommand: !!r.card.canCommand, isCommander: r.board === 'commander' }));

  const advice = LAND_ADVICE[format] || (format === 'commander' ? LAND_ADVICE.commander : LAND_ADVICE.default);
  return {
    total: count(played), lands, nonland, curve,
    avgMv: nonland ? mvSum / nonland : 0,
    avgMvWithLands: count(played) ? mvSum / count(played) : 0,
    highest, types, pips, sources, keywords, issues, legends,
    identity: [...identity], landAdvice: advice,
  };
}

/** Build a shuffled library (main deck only, expanded by qty). `rand` is injectable for tests. */
function buildLibrary(entries, cards, rand = secureRandom) {
  const lib = [];
  for (const e of entries) if (e.board === 'main' && cards[e.cardId]) for (let i = 0; i < e.qty; i++) lib.push(e.cardId);
  for (let i = lib.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [lib[i], lib[j]] = [lib[j], lib[i]]; }
  return lib;
}
function secureRandom() { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] / 2 ** 32; }

// ---------------------------------------------------------------- UI: tabs inside a deck
let deckTab = 'cards';
let hand = null; // {deckId, library, hand, mulligans, bottomed, drawn}

function deckTabsHtml() {
  return `<div class="seg deck-tabs" role="tablist">${[['cards', 'Cards'], ['stats', 'Stats'], ['hand', 'Test hand']]
    .map(([k, l]) => `<button class="seg-btn ${deckTab === k ? 'active' : ''}" data-decktab="${k}">${l}</button>`).join('')}</div>`;
}
function wireDeckTabs(d) {
  $$('[data-decktab]').forEach((b) => (b.onclick = () => { deckTab = b.dataset.decktab; renderDeckDetail(); }));
  if (deckTab === 'stats') wireStats(d);
  if (deckTab === 'hand') wireHand(d);
}

/** Cards cached before this release lack keywords/legalities; fetch them once in the background. */
let detailFetch = null;
function ensureCardDetails(d) {
  const missing = [...new Set(d.cards.map((e) => e.cardId))].filter((id) => state.cards[id] && !state.cards[id].legal);
  if (!missing.length || detailFetch) return false;
  detailFetch = refreshPrices(missing).catch(() => toast('Couldn’t load card details — check your connection'))
    .finally(() => { detailFetch = null; if (openDeckId === d.id) renderDeckDetail(); });
  return true;
}

// ---------------------------------------------------------------- Stats tab
function statsHtml(d) {
  const loading = ensureCardDetails(d) || detailFetch;
  const a = analyzeDeck(d.cards, state.cards, d.format);
  const max = Math.max(1, ...a.curve);
  const curve = a.curve.map((n, i) => `<div class="bar"><span class="bn">${n || ''}</span><i style="height:${(n / max) * 100}%"></i><span class="bl">${i === 7 ? '7+' : i}</span></div>`).join('');
  const types = Object.entries(a.types).sort((x, y) => TYPE_ORDER.indexOf(x[0]) - TYPE_ORDER.indexOf(y[0]))
    .map(([t, n]) => `<span class="chip">${esc(t)} <b>${n}</b></span>`).join('');
  const [lo, hi] = a.landAdvice;
  const landNote = a.total ? (a.lands < lo ? `<span class="warn">Low — about ${lo}–${hi} is typical.</span>` : a.lands > hi ? `<span class="warn">High — about ${lo}–${hi} is typical.</span>` : `<span class="ok">Right in the usual ${lo}–${hi} range.</span>`) : '';
  const colorRows = COLORS.filter((c) => a.pips[c] || a.sources[c]).map((c) => {
    const ratio = a.pips[c] ? a.sources[c] / a.pips[c] : 1;
    const flag = a.pips[c] && a.sources[c] < Math.min(10, Math.ceil(a.pips[c] / 3)) ? ' <span class="warn">few sources</span>' : '';
    return `<tr><td><span class="pip pip-${c}">${c}</span> ${COLOR_NAMES[c]}</td><td>${a.pips[c]}</td><td>${a.sources[c]}${flag}</td></tr>`;
  }).join('');
  const isCmd = d.format === 'commander';
  const commanders = d.cards.filter((e) => e.board === 'commander' && state.cards[e.cardId]).map((e) => state.cards[e.cardId]);
  const issues = a.issues;
  const kw = Object.entries(a.keywords).sort((x, y) => y[1].length - x[1].length);

  return `${loading ? '<p class="muted">Loading card details…</p>' : ''}
    ${isCmd ? `<div class="panel"><div class="panel-head"><h3>Commander</h3><button class="btn small" id="pickCmd">${commanders.length ? 'Change' : 'Choose'}</button></div>
      ${commanders.length ? commanders.map((c) => `<div class="cmd"><img src="${esc(c.thumb)}" alt="" data-open="${esc(c.id)}"><div><b>${esc(c.name)}</b><div class="muted">${esc(c.type)}</div><div>${(c.colors || []).map((x) => `<span class="pip pip-${x}">${x}</span>`).join('') || '<span class="muted">Colorless</span>'}</div></div></div>`).join('') : '<p class="muted">No commander chosen. Pick one so color checks work.</p>'}
    </div>` : ''}

    <div class="panel"><div class="panel-head"><h3>Legality${LIMITS[d.format] ? ` · ${esc(d.format)}` : ''}</h3>${LIMITS[d.format] ? (issues.length ? `<span class="badge-bad">${issues.length} issue${issues.length > 1 ? 's' : ''}</span>` : '<span class="badge-ok">Legal</span>') : ''}</div>
      ${!LIMITS[d.format] ? `<p class="muted">No legality rules for “${esc(d.format)}”. Change the format under Edit.</p>`
        : issues.length ? `<ul class="issues">${issues.map((i) => `<li class="issue-${i.kind}">${esc(i.text)}</li>`).join('')}</ul>` : '<p class="ok">No problems found.</p>'}
    </div>

    <div class="panel"><h3>Mana curve</h3>
      <div class="curve">${curve}</div>
      <div class="stats three">
        <div class="stat"><b>${a.avgMv.toFixed(2)}</b><span>Avg mana value (spells)</span></div>
        <div class="stat"><b>${a.avgMvWithLands.toFixed(2)}</b><span>Avg incl. lands</span></div>
        <div class="stat"><b>${a.highest ? a.highest.mv : '—'}</b><span>Highest${a.highest ? ': ' + esc(a.highest.names.slice(0, 2).join(', ')) + (a.highest.names.length > 2 ? '…' : '') : ''}</span></div>
      </div>
    </div>

    <div class="panel"><h3>Lands & colors</h3>
      <p><b>${a.lands}</b> lands of ${a.total} cards. ${landNote}</p>
      ${colorRows ? `<table class="colors"><thead><tr><th>Color</th><th>Symbols in costs</th><th>Lands that make it</th></tr></thead><tbody>${colorRows}</tbody></table>` : '<p class="muted">No colored mana symbols yet.</p>'}
    </div>

    <div class="panel"><h3>Card types</h3><div class="chips">${types || '<span class="muted">No cards yet.</span>'}</div></div>

    <div class="panel"><h3>Legendaries <small class="muted">(${a.legends.length})</small></h3>
      ${a.legends.length ? `<ul class="legend-list">${a.legends.map((l) => `<li><span data-open="${esc(l.id)}">${esc(l.name)}</span>${l.qty > 1 ? ` <b>×${l.qty}</b>` : ''}<small class="muted"> ${esc(l.type.split(' — ')[0])}</small>${l.isCommander ? ' <span class="badge-ok">Commander</span>' : l.canCommand && isCmd ? ' <span class="chip small">can command</span>' : ''}</li>`).join('')}</ul>` : '<p class="muted">No legendary cards.</p>'}
    </div>

    <div class="panel"><h3>Keywords <small class="muted">tap one to see its cards</small></h3>
      ${kw.length ? `<ul class="kw-list">${kw.map(([k, names]) => `<li><details><summary><b>${esc(k)}</b> <span class="muted">· ${names.length} card${names.length > 1 ? 's' : ''}</span><div class="kw-def">${esc(KEYWORD_INFO[k] || 'Look this one up on Scryfall for the full rules.')}</div></summary><div class="kw-cards">${[...new Set(names)].map((n) => esc(n)).join(' · ')}</div></details></li>`).join('')}</ul>` : `<p class="muted">${loading ? 'Loading…' : 'No keyword abilities found.'}</p>`}
    </div>`;
}
function wireStats(d) {
  const btn = $('#pickCmd'); if (btn) btn.onclick = () => pickCommander(d);
}

function pickCommander(d) {
  const inDeck = d.cards.filter((e) => state.cards[e.cardId] && state.cards[e.cardId].canCommand && e.board !== 'maybe');
  const current = new Set(d.cards.filter((e) => e.board === 'commander').map((e) => e.cardId));
  showModal(`<h2>Choose commander</h2>
    <p class="muted">Pick one, or two if they both have partner (or one says “Choose a Background”).</p>
    ${inDeck.length ? `<ul class="pick-list">${[...new Map(inDeck.map((e) => [e.cardId, e])).values()].map((e) => { const c = state.cards[e.cardId]; return `<li><label><input type="checkbox" value="${esc(c.id)}" ${current.has(c.id) ? 'checked' : ''}> <img src="${esc(c.thumb)}" alt=""> <span><b>${esc(c.name)}</b><br><small class="muted">${esc(c.type)}</small></span></label></li>`; }).join('')}</ul>`
      : '<p class="muted">No legendary creatures in this deck yet.</p>'}
    <div class="row gap" style="margin-top:12px"><button class="btn primary grow" id="cmdSave">Save</button><button class="btn" id="cmdSearch">Search for one</button></div>`);
  $('#cmdSave').onclick = () => {
    const ids = $$('.pick-list input:checked').map((i) => i.value);
    if (ids.length > 2) return toast('Pick at most two');
    setCommanders(d, ids); save(); hideModal(); renderDeckDetail(); renderDecks();
  };
  $('#cmdSearch').onclick = () => {
    hideModal(); setView('search'); state.settings.searchDest = d.id;
    $('#searchInput').value = 'is:commander '; $('#searchInput').focus();
    toast('Find your commander, then Add with Board → Commander');
  };
}
/** Move the chosen cards to the commander board (one copy each) and put previous commanders back in the main deck. */
function setCommanders(d, ids) {
  for (const e of d.cards.filter((x) => x.board === 'commander')) {
    if (ids.includes(e.cardId)) continue;
    d.cards.splice(d.cards.indexOf(e), 1);
    addTo(d.id, e.cardId, e.foil, e.qty, 'main');
  }
  for (const id of ids) {
    if (d.cards.some((x) => x.board === 'commander' && x.cardId === id)) continue;
    const src = d.cards.find((x) => x.cardId === id && x.board === 'main') || d.cards.find((x) => x.cardId === id);
    if (!src) continue;
    removeFrom(d.id, id, src.foil, 1, src.board);
    addTo(d.id, id, src.foil, 1, 'commander');
  }
}

// ---------------------------------------------------------------- Test hand tab
function newHand(d) {
  const library = buildLibrary(d.cards, state.cards);
  hand = { deckId: d.id, library, hand: library.splice(0, 7), mulligans: 0, bottomed: 0, drawn: 0 };
}
function handHtml(d) {
  if (!hand || hand.deckId !== d.id) newHand(d);
  const total = d.cards.filter((e) => e.board === 'main').reduce((s, e) => s + e.qty, 0);
  if (total < 7) return `<p class="empty">Add at least 7 main-deck cards to draw a test hand.</p>`;
  const lands = d.cards.filter((e) => e.board === 'main' && state.cards[e.cardId] && primaryType(state.cards[e.cardId].type) === 'Land').reduce((s, e) => s + e.qty, 0);
  const handLands = hand.hand.filter((id) => primaryType(state.cards[id]?.type) === 'Land').length;
  const toBottom = hand.mulligans - hand.bottomed;
  let p24 = 0; for (let k = 2; k <= 4; k++) p24 += hypergeom(total, lands, 7, k);
  return `<div class="row gap wrap">
      <button class="btn small primary" id="hNew">New hand</button>
      <button class="btn small" id="hMull" ${toBottom > 0 ? 'disabled' : ''}>Mulligan</button>
      <button class="btn small" id="hDraw" ${toBottom > 0 || !hand.library.length ? 'disabled' : ''}>Draw a card</button>
    </div>
    <p class="muted">${hand.hand.length} cards in hand · <b>${handLands}</b> land${handLands === 1 ? '' : 's'} · ${hand.library.length} left in library${hand.drawn ? ` · turn ${hand.drawn + 1}` : ''}${hand.mulligans ? ` · mulligan ${hand.mulligans}` : ''}</p>
    ${toBottom > 0 ? `<p class="warn">Tap ${toBottom} card${toBottom > 1 ? 's' : ''} to put on the bottom (London mulligan).</p>` : ''}
    <div class="hand">${hand.hand.map((id, i) => { const c = state.cards[id]; return `<button class="hand-card" data-hand="${i}" aria-label="${esc(c?.name || '')}"><img src="${esc(c?.thumb || '')}" alt="${esc(c?.name || '')}"></button>`; }).join('')}</div>
    <p class="muted">With ${lands} lands in ${total} cards, an opening 7 has 2–4 lands about <b>${Math.round(p24 * 100)}%</b> of the time.</p>`;
}
function wireHand(d) {
  const H = () => hand;
  const on = (id, fn) => { const b = $(id); if (b) b.onclick = () => { fn(); renderDeckDetail(); }; };
  on('#hNew', () => newHand(d));
  on('#hMull', () => {
    const m = H().mulligans + 1;
    const library = buildLibrary(d.cards, state.cards);
    hand = { deckId: d.id, library, hand: library.splice(0, 7), mulligans: m, bottomed: 0, drawn: 0 };
  });
  on('#hDraw', () => { H().hand.push(H().library.shift()); H().drawn++; });
  $$('[data-hand]').forEach((b) => (b.onclick = () => {
    const h = H();
    if (h.mulligans - h.bottomed > 0) {
      const [id] = h.hand.splice(Number(b.dataset.hand), 1); h.library.push(id); h.bottomed++;
      renderDeckDetail();
    } else openCard(h.hand[Number(b.dataset.hand)]);
  }));
}

window.__insights = { analyzeDeck, buildLibrary, hypergeom, pipsOf, primaryType, setCommanders, KEYWORD_INFO };
