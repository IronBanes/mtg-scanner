'use strict';
/* MTG Scanner — scan, price and track Magic cards. Data: Scryfall API. OCR: Tesseract.js. */

// ---------------------------------------------------------------- utilities
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + (Number(n) || 0).toFixed(2);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

function levRatio(a, b) {
  a = norm(a); b = norm(b);
  if (!a.length || !b.length) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

let toastTimer;
function toast(msg, actionLabel, action) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (actionLabel ? ` <button>${esc(actionLabel)}</button>` : '');
  if (actionLabel) t.querySelector('button').onclick = () => { t.classList.remove('show'); action(); };
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), actionLabel ? 4500 : 2200);
}

let audioCtx;
function beep(freq = 880) {
  if (!state.settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = freq; o.type = 'sine';
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
    o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.16);
  } catch {}
  try { navigator.vibrate && navigator.vibrate(40); } catch {}
}

// ---------------------------------------------------------------- storage
const STORE_KEY = 'mtgscan.v1';
// Bump SCHEMA when the saved data's shape changes, and add a step to MIGRATIONS that upgrades
// version n-1 data to n. Data is backed up before any upgrade and is never overwritten if it
// can't be read, so app updates can't wipe a collection.
const SCHEMA = 1;
const MIGRATIONS = {
  // 2: (d) => { ...upgrade d from schema 1 to 2...; return d; },
};
const BACKUP_PREFIX = 'mtgscan.safety.';
let saveBlocked = null; // reason string when saving is paused to protect data we couldn't read
const defaultState = () => ({
  schema: SCHEMA,
  cards: {},          // scryfall id -> slim card data (cache)
  collection: [],     // {cardId, foil, qty, added}
  decks: [],          // {id, name, format, created, cards:[{cardId, foil, qty, board}]}
  recent: [],         // {cardId, foil, t}
  settings: { dest: 'none', sound: true, exact: true },
});
let state = defaultState();
function keepSafetyCopy(tag, raw) {
  try { localStorage.setItem(BACKUP_PREFIX + tag, raw); } catch (e) { console.warn('safety copy failed', e); }
}
function load() {
  let raw = null;
  try { raw = localStorage.getItem(STORE_KEY); } catch (e) { saveBlocked = 'storage unavailable'; return; }
  if (!raw) return; // first run
  let data;
  try {
    data = JSON.parse(raw);
    const from = Number(data.schema) || 1;
    if (from > SCHEMA) {
      // written by a newer version of the app (e.g. this copy is an older cached release): read-only
      saveBlocked = 'newer data';
    } else if (from < SCHEMA) {
      keepSafetyCopy('before-schema-' + (from + 1), raw);
      for (let v = from + 1; v <= SCHEMA; v++) data = (MIGRATIONS[v] || ((d) => d))(data);
      data.schema = SCHEMA;
    }
    validateBackup(data);
  } catch (e) {
    console.warn('load failed', e);
    keepSafetyCopy('unreadable-' + new Date().toISOString().slice(0, 10), raw);
    saveBlocked = 'unreadable';
    return;
  }
  state = Object.assign(defaultState(), data);
  state.settings = Object.assign(defaultState().settings, state.settings);
}
function warnIfBlocked() {
  if (saveBlocked === 'newer data') toast('This copy of the app is older than your data, so changes won\u2019t be saved until it updates.', 'Reload', () => location.reload());
  else if (saveBlocked) toast('Your saved data couldn\u2019t be read, so nothing will be overwritten. A copy is under Settings \u2192 Safety copies.', 'Settings', () => openSettings());
}
/** State minus cached cards nothing points at (search results, printing lists) — those are re-fetched when needed. */
function persistable() {
  const used = new Set([...state.collection, ...state.recent, ...state.decks.flatMap((d) => d.cards)].map((e) => e.cardId));
  const cards = {};
  used.forEach((id) => { if (state.cards[id]) cards[id] = state.cards[id]; });
  return { ...state, cards };
}
let saveTimer;
function save() {
  if (saveBlocked) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(persistable())); }
    catch (e) { toast('Could not save — storage full?'); }
  }, 150);
}
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}

// ---------------------------------------------------------------- scryfall
const SF = 'https://api.scryfall.com';
let lastReq = 0;
async function sf(path, opts = {}) {
  const wait = lastReq + 110 - Date.now();   // Scryfall asks for <=10 req/s
  lastReq = Date.now() + Math.max(0, wait);
  if (wait > 0) await sleep(wait);
  const res = await fetch(path.startsWith('http') ? path : SF + path, {
    ...opts, headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.details || res.statusText); err.status = res.status; err.data = data; throw err; }
  return data;
}

function slim(c) {
  const face = c.card_faces && c.card_faces[0];
  const img = c.image_uris || (face && face.image_uris) || {};
  return {
    id: c.id, name: c.name, set: c.set, set_name: c.set_name, cn: c.collector_number,
    rarity: c.rarity, type: c.type_line || (face && face.type_line) || '',
    mana: c.mana_cost ?? (face && face.mana_cost) ?? '', cmc: c.cmc,
    colors: c.color_identity || [], oracle_id: c.oracle_id,
    img: img.normal || img.large || '', thumb: img.small || img.normal || '',
    prices: { usd: c.prices?.usd, usd_foil: c.prices?.usd_foil, usd_etched: c.prices?.usd_etched },
    finishes: c.finishes || ['nonfoil'], prints_uri: c.prints_search_uri, uri: c.scryfall_uri,
    updated: Date.now(),
  };
}
function cache(c) { const s = slim(c); state.cards[s.id] = s; save(); return s; }
function unitPrice(card, foil) {
  if (!card) return 0;
  const p = card.prices || {};
  const v = foil ? (p.usd_foil || p.usd_etched || p.usd) : (p.usd || p.usd_foil || p.usd_etched);
  return Number(v) || 0;
}
const frontName = (name) => String(name).split(' // ')[0];

async function refreshPrices(ids) {
  ids = [...new Set(ids)];
  for (let i = 0; i < ids.length; i += 75) {
    const chunk = ids.slice(i, i + 75);
    const res = await sf('/cards/collection', { method: 'POST', body: JSON.stringify({ identifiers: chunk.map((id) => ({ id })) }) });
    res.data.forEach(cache);
  }
}

// name lookups from OCR text, cached per session
const lookupCache = new Map();
async function identifyByName(text) {
  const key = norm(text);
  if (key.length < 3) return null;
  if (lookupCache.has(key)) return lookupCache.get(key);
  let card = null, netError = false;
  const tryFuzzy = async (q) => {
    try { return await sf('/cards/named?fuzzy=' + encodeURIComponent(q)); }
    catch (e) { if (e.status !== 404) netError = true; return null; }
  };
  card = await tryFuzzy(text);
  if (!card) {
    try {
      const ac = await sf('/cards/autocomplete?q=' + encodeURIComponent(text));
      if (ac.data && ac.data.length) card = await sf('/cards/named?exact=' + encodeURIComponent(ac.data[0]));
    } catch (e) { if (e.status !== 404) netError = true; }
  }
  if (!card) {
    const words = text.split(' ');
    if (words.length > 2) card = (await tryFuzzy(words.slice(1).join(' '))) || (await tryFuzzy(words.slice(0, -1).join(' ')));
  }
  const minRatio = key.length < 6 ? 0.8 : 0.6; // short reads must match closely
  if (card && levRatio(text, frontName(card.name)) < minRatio && levRatio(text, card.name) < minRatio) card = null;
  if (card || !netError) lookupCache.set(key, card);
  else throw new Error('Can’t reach Scryfall — check your connection');
  return card;
}

// ---------------------------------------------------------------- OCR
let ocrWorkerPromise = null;
function getWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      for (let i = 0; i < 50 && !window.Tesseract; i++) await sleep(200);
      if (!window.Tesseract) throw new Error('OCR engine failed to load (are you online?)');
      const w = await Tesseract.createWorker('eng');
      return w;
    })();
    ocrWorkerPromise.catch(() => { ocrWorkerPromise = null; });
  }
  return ocrWorkerPromise;
}

/** Crop a region (fractions of the card rect) from a source into a cleaned-up canvas for OCR. */
function cropForOcr(src, card, r, targetW = 900, binarize = false, forceInvert = null) {
  const sx = card.x + r.x * card.w, sy = card.y + r.y * card.h, sw = r.w * card.w, sh = r.h * card.h;
  const scale = targetW / sw;
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const im = g.getImageData(0, 0, c.width, c.height), d = im.data;
  const hist = new Uint32Array(256); let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    d[i] = v; hist[v]++; sum += v;
  }
  const n = d.length / 4, mean = sum / n;
  const pct = (p) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * p) return v; } return 255; };
  const lo = pct(0.02), hi = pct(0.98), span = Math.max(1, hi - lo);
  const invert = forceInvert ?? mean < 115; // light text on a dark bar
  for (let i = 0; i < d.length; i += 4) {
    let v = ((d[i] - lo) * 255) / span; v = v < 0 ? 0 : v > 255 ? 255 : v;
    if (invert) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  if (binarize) {
    // Otsu threshold, then wipe frame lines / blobs that touch the top or bottom edge
    const h2 = new Uint32Array(256); for (let i = 0; i < d.length; i += 4) h2[d[i] | 0]++;
    let sumAll = 0; for (let v = 0; v < 256; v++) sumAll += v * h2[v];
    let wB = 0, sB = 0, best = 0, thr = 128;
    for (let v = 0; v < 256; v++) { wB += h2[v]; if (!wB) continue; const wF = n - wB; if (!wF) break; sB += v * h2[v];
      const mB = sB / wB, mF = (sumAll - sB) / wF, between = wB * wF * (mB - mF) ** 2; if (between > best) { best = between; thr = v; } }
    const W = c.width, H = c.height, dark = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) dark[p] = d[p * 4] < thr ? 1 : 0;
    // flood-fill dark regions connected to the top/bottom edges (borders, crowns, frame lines)
    const stack = [];
    for (let x = 0; x < W; x++) { stack.push(x, (H - 1) * W + x); }
    for (let y = 0; y < H; y++) { stack.push(y * W, y * W + W - 1); }
    while (stack.length) {
      const p = stack.pop(); if (!dark[p]) continue; dark[p] = 0;
      const x = p % W;
      if (x > 0) stack.push(p - 1); if (x < W - 1) stack.push(p + 1);
      if (p >= W) stack.push(p - W); if (p < W * (H - 1)) stack.push(p + W);
    }
    for (let p = 0; p < W * H; p++) { const v = dark[p] ? 0 : 255; d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = v; }
  }
  g.putImageData(im, 0, 0);
  return c;
}

const NAME_ZONE = { x: 0.05, y: 0.025, w: 0.75, h: 0.095 };
const SET_ZONE = { x: 0.03, y: 0.89, w: 0.47, h: 0.085 };
const NAME_VARIANTS = [
  { zone: NAME_ZONE, bin: false },
  { zone: NAME_ZONE, bin: true },
  { zone: { x: 0.06, y: 0.035, w: 0.74, h: 0.07 }, bin: true },
  { zone: { x: 0.04, y: 0.015, w: 0.78, h: 0.12 }, bin: true },
];

function cleanName(text) {
  const lines = String(text).split('\n').map((l) => l.replace(/[^A-Za-z',\- ]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  let best = lines.sort((a, b) => b.replace(/[^A-Za-z]/g, '').length - a.replace(/[^A-Za-z]/g, '').length)[0] || '';
  const toks = best.split(' ');
  while (toks.length > 1 && toks[0].replace(/[^A-Za-z]/g, '').length <= 1) toks.shift();
  while (toks.length > 1 && toks[toks.length - 1].replace(/[^A-Za-z]/g, '').length <= 1) toks.pop();
  return toks.join(' ').replace(/^[',\- ]+|[',\- ]+$/g, '');
}

function parseSetLine(text) {
  const t = String(text).toUpperCase().replace(/[|]/g, 'I');
  const num = (t.match(/\b0*(\d{1,4})\s*\/\s*\d{1,4}\b/) || t.match(/\b[CURMLST]\s+0*(\d{1,4})\b/) || t.match(/\b0*(\d{1,4})\b/) || [])[1];
  const sets = [...t.matchAll(/\b([A-Z0-9]{3,5})\b\s*[•·*.\-]?\s*(?:EN|EM|FN|ENG)?\b/g)].map((m) => m[1]).filter((s) => /[A-Z]/.test(s) && !['EN', 'ENG', 'TM'].includes(s));
  return { num, sets };
}

/**
 * Run the full identify pipeline on an image source with the card at `card` (pixel rect).
 * Returns {card (scryfall object), text} or {card:null, text}.
 */
async function identifyFrom(src, rect, { exact = state.settings.exact } = {}) {
  const w = await getWorker();
  let card = null, text = '', firstText = '';
  // a few crop/cleanup variants; stop at the first one that matches a real card
  for (const v of NAME_VARIANTS) {
    await w.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',- " });
    const { data } = await w.recognize(cropForOcr(src, rect, v.zone, 900, v.bin));
    text = cleanName(data.text);
    if (text.replace(/[^A-Za-z]/g, '').length < 3) continue;
    firstText = firstText || text;
    card = await identifyByName(text);
    if (card) break;
  }
  if (!card) return { card: null, text: firstText };
  if (exact) {
    try {
      await w.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/•· ' });
      const setCanvas = cropForOcr(src, rect, SET_ZONE, 700);
      const r2 = await w.recognize(setCanvas);
      const { num, sets } = parseSetLine(r2.data.text);
      if (num) {
        for (const s of sets.slice(0, 3)) {
          try {
            const p = await sf(`/cards/${s.toLowerCase()}/${num}`);
            if (p.oracle_id === card.oracle_id) { card = p; break; }
          } catch {}
        }
      }
    } catch (e) { console.warn('set ocr failed', e); }
  }
  return { card, text };
}

// ---------------------------------------------------------------- camera
const cam = { stream: null, running: false, auto: false, busy: false, lastSeen: null, lastAdded: null, gap: true, wake: null };

function guideRectInVideo() {
  const v = $('#video'), box = $('#camera').getBoundingClientRect(), gr = $('#guide').getBoundingClientRect();
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw) return null;
  const scale = Math.max(box.width / vw, box.height / vh);
  const offX = (box.width - vw * scale) / 2, offY = (box.height - vh * scale) / 2;
  return { x: (gr.left - box.left - offX) / scale, y: (gr.top - box.top - offY) / scale, w: gr.width / scale, h: gr.height / scale };
}

async function startCamera() {
  if (cam.stream) return true;
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
    });
    const v = $('#video'); v.srcObject = cam.stream; await v.play();
    try { const [track] = cam.stream.getVideoTracks(); const caps = track.getCapabilities?.() || {};
      if (caps.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch {}
    $('#camMsg').classList.add('hidden');
    getWorker().then(() => status('Ready')).catch((e) => status(e.message));
    status('Loading scanner…');
    return true;
  } catch (e) {
    $('#camMsg').innerHTML = `<p>Camera unavailable: ${esc(e.message || e.name)}.<br>Allow camera access for this site, or use <b>Photo</b> / <b>Type</b> below.</p><button class="btn primary" id="startCamBtn2">Try again</button>`;
    $('#startCamBtn2').onclick = startCamera;
    return false;
  }
}
function stopCamera() {
  stopAuto();
  if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
  cam.stream = null;
  $('#camMsg').classList.remove('hidden');
}
function status(msg) { $('#scanStatus').textContent = msg || ''; }

async function scanOnce() {
  if (cam.busy) return;
  if (!cam.stream && !(await startCamera())) return;
  const rect = guideRectInVideo(); if (!rect) return;
  cam.busy = true; $('#shutterBtn').disabled = true; status('Reading card…');
  try {
    const { card, text } = await identifyFrom($('#video'), rect);
    if (card) { beep(); showResult(cache(card), text); status(''); }
    else { status(text ? `Couldn't match "${text}" — try again, or tap Type` : 'No card name found — fill the frame & hold steady'); beep(300); }
  } catch (e) { status('Error: ' + e.message); }
  finally { cam.busy = false; $('#shutterBtn').disabled = false; }
}

async function startAuto() {
  if (!cam.stream && !(await startCamera())) return;
  cam.auto = true; cam.lastSeen = null; cam.gap = true;
  $('#autoBtn').textContent = 'Stop auto-scan'; $('#autoBtn').classList.remove('primary');
  try { cam.wake = await navigator.wakeLock?.request('screen'); } catch {}
  status('Auto-scan on — show cards one at a time');
  loopAuto();
}
function stopAuto() {
  cam.auto = false; $('#camera').classList.remove('found');
  $('#autoBtn').textContent = 'Start auto-scan'; $('#autoBtn').classList.add('primary');
  try { cam.wake && cam.wake.release(); } catch {} cam.wake = null;
}
async function loopAuto() {
  while (cam.auto) {
    const rect = guideRectInVideo();
    if (!rect || cam.busy) { await sleep(300); continue; }
    cam.busy = true;
    try {
      const { card, text } = await identifyFrom($('#video'), rect, { exact: state.settings.exact });
      if (!cam.auto) break;
      if (!card) {
        cam.gap = true; cam.lastSeen = null; $('#camera').classList.remove('found');
        status(text ? `Reading… "${text}"` : 'Waiting for a card…');
      } else {
        // need the same card twice in a row; re-add the same name only after the frame changed
        if (cam.lastSeen === card.id && (cam.gap || cam.lastAdded !== card.oracle_id)) {
          const s = cache(card); addScanned(s, { quiet: true }); beep();
          cam.lastAdded = card.oracle_id; cam.gap = false;
          $('#camera').classList.add('found'); status(`✓ ${s.name} — ${money(unitPrice(s, foilOn()))}. Next card!`);
          setTimeout(() => $('#camera').classList.remove('found'), 600);
        } else if (cam.lastAdded !== card.oracle_id || cam.gap) {
          status(`Seeing ${card.name}…`);
        }
        cam.lastSeen = card.id;
      }
    } catch (e) { status('Error: ' + e.message); await sleep(800); }
    finally { cam.busy = false; }
    await sleep(150);
  }
}

async function scanPhoto(file) {
  const img = new Image(); img.src = URL.createObjectURL(file);
  await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight, ar = 63 / 88;
  // assume the card roughly fills the photo; take the largest centered card-shaped box
  let w = W, h = W / ar; if (h > H) { h = H; w = H * ar; }
  const rect = { x: (W - w) / 2, y: (H - h) / 2, w, h };
  status('Reading photo…');
  try {
    const { card, text } = await identifyFrom(img, rect);
    if (card) { beep(); showResult(cache(card), text); status(''); }
    else status(text ? `Couldn't match "${text}" — crop the photo to the card, or tap Type` : 'No card name found in photo');
  } catch (e) { status('Error: ' + e.message); }
  URL.revokeObjectURL(img.src);
}

// ---------------------------------------------------------------- destinations
const foilOn = () => $('#foilToggle').checked;
function destLabel(dest) {
  if (dest === 'none') return 'Recent scans only';
  if (dest === 'collection') return 'Collection';
  const d = state.decks.find((x) => x.id === dest); return d ? d.name : 'Recent scans only';
}
function destOptions(selected, { includeNone = true } = {}) {
  let html = includeNone ? `<option value="none">Just scan — don't save</option>` : '';
  html += `<option value="collection">Collection</option>`;
  state.decks.forEach((d) => (html += `<option value="${esc(d.id)}">Deck: ${esc(d.name)}</option>`));
  html += `<option value="__new">+ New deck…</option>`;
  return html.replace(`value="${esc(selected)}"`, `value="${esc(selected)}" selected`);
}
function renderDestSelect() {
  if (state.settings.dest !== 'none' && state.settings.dest !== 'collection' && !state.decks.some((d) => d.id === state.settings.dest)) state.settings.dest = 'none';
  $('#destSelect').innerHTML = destOptions(state.settings.dest);
}
async function handleNewDeckOption(sel, onPick) {
  if (sel.value !== '__new') return onPick(sel.value);
  const name = prompt('Deck name?');
  if (name && name.trim()) { const d = createDeck(name.trim()); onPick(d.id); }
  else onPick(null);
}

function addTo(dest, cardId, foil, qty = 1, board = 'main') {
  if (dest === 'collection') {
    const e = state.collection.find((x) => x.cardId === cardId && !!x.foil === !!foil);
    if (e) e.qty += qty; else state.collection.push({ cardId, foil: !!foil, qty, added: Date.now() });
  } else {
    const d = state.decks.find((x) => x.id === dest); if (!d) return;
    const e = d.cards.find((x) => x.cardId === cardId && !!x.foil === !!foil && x.board === board);
    if (e) e.qty += qty; else d.cards.push({ cardId, foil: !!foil, qty, board });
  }
  save();
}
function removeFrom(dest, cardId, foil, qty = 1, board = 'main') {
  const list = dest === 'collection' ? state.collection : state.decks.find((x) => x.id === dest)?.cards;
  if (!list) return;
  const i = list.findIndex((x) => x.cardId === cardId && !!x.foil === !!foil && (dest === 'collection' || x.board === board));
  if (i < 0) return;
  list[i].qty -= qty; if (list[i].qty <= 0) list.splice(i, 1);
  save();
}

/** A scan happened: log it in recent, and add to the chosen destination. */
function addScanned(card, { quiet } = {}) {
  const foil = foilOn(), dest = state.settings.dest;
  const entry = { cardId: card.id, foil, t: Date.now(), dest };
  state.recent.unshift(entry); state.recent = state.recent.slice(0, 300);
  if (dest !== 'none') addTo(dest, card.id, foil);
  save(); renderRecent();
  const msg = dest === 'none' ? `${card.name} — ${money(unitPrice(card, foil))}` : `Added ${card.name} to ${destLabel(dest)}`;
  if (!quiet || dest !== 'none') toast(msg, 'Undo', () => undoScan(entry));
}
function undoScan(entry) {
  const i = state.recent.indexOf(entry); if (i >= 0) state.recent.splice(i, 1);
  if (entry.dest !== 'none') removeFrom(entry.dest, entry.cardId, entry.foil);
  save(); renderAll();
}

// ---------------------------------------------------------------- scan result (single)
function showResult(card, ocrText) {
  const foil = foilOn(), dest = state.settings.dest;
  const el = $('#scanResult');
  el.innerHTML = `<div class="result">
    <img src="${esc(card.thumb)}" alt="" data-open="${esc(card.id)}">
    <div class="info">
      <h3>${esc(card.name)}</h3>
      <div class="muted">${esc(card.set_name)} · #${esc(card.cn)} · ${esc(card.rarity)}</div>
      <div class="price">${money(unitPrice(card, foil))}${foil ? ' <span class="badge foil">FOIL</span>' : ''}</div>
      ${ocrText && norm(ocrText) !== norm(frontName(card.name)) ? `<div class="muted">Read as “${esc(ocrText)}”</div>` : ''}
      <div class="actions">
        <button class="btn primary small" id="resAdd">${dest === 'none' ? 'Keep in recent' : 'Add to ' + esc(destLabel(dest))}</button>
        <button class="btn small" id="resPrint">Other printing</button>
        <button class="btn small ghost" id="resNo">Wrong card</button>
      </div>
    </div></div>`;
  $('#resAdd').onclick = () => { addScanned(card); el.innerHTML = ''; };
  $('#resPrint').onclick = () => openCard(card.id, { afterAdd: () => (el.innerHTML = '') });
  $('#resNo').onclick = () => { el.innerHTML = ''; manualEntry(ocrText); };
}

function manualEntry(prefill = '') {
  showModal(`<h2>Find card</h2>
    <form id="manForm" class="row gap" autocomplete="off"><input type="search" id="manInput" class="grow" value="${esc(prefill)}" placeholder="Card name"><button class="btn primary">Go</button></form>
    <ul class="suggest" id="manSuggest"></ul>`);
  const inp = $('#manInput'); inp.focus();
  const go = async (name) => {
    inp._acCancel?.();
    try { const c = await sf('/cards/named?fuzzy=' + encodeURIComponent(name)); hideModal(); showResult(cache(c), ''); }
    catch { toast('No card found for "' + name + '"'); }
  };
  attachAutocomplete(inp, $('#manSuggest'), go);
  $('#manForm').onsubmit = (e) => { e.preventDefault(); go(inp.value); };
}

// ---------------------------------------------------------------- recent list
function cardRow(entry, { qtyControls, extra = '', sub = '' } = {}) {
  const c = state.cards[entry.cardId];
  if (!c) return '';
  const unit = unitPrice(c, entry.foil), qty = Number(entry.qty ?? 1) || 0;
  return `<li data-id="${esc(c.id)}">
    <img src="${esc(c.thumb)}" alt="" loading="lazy" data-open="${esc(c.id)}">
    <div class="meta" data-open="${esc(c.id)}">
      <div class="n">${esc(c.name)}${entry.foil ? '<span class="badge foil">FOIL</span>' : ''}${extra}</div>
      <div class="s">${esc(c.set.toUpperCase())} #${esc(c.cn)} · ${esc(c.set_name)}${sub}</div>
    </div>
    ${qtyControls ? `<div class="qty"><button data-q="-1">−</button><b>${qty | 0}</b><button data-q="1">+</button></div>` : ''}
    <div class="p"><b>${money(unit * qty)}</b>${qty > 1 ? `<span>${money(unit)} ea</span>` : ''}</div>
  </li>`;
}
function renderRecent() {
  const list = state.recent.filter((r) => state.cards[r.cardId]);
  const total = list.reduce((s, r) => s + unitPrice(state.cards[r.cardId], r.foil), 0);
  $('#recentTotal').textContent = list.length ? `${list.length} · ${money(total)}` : '';
  $('#recentList').innerHTML = list.length
    ? list.slice(0, 100).map((r) => cardRow(r, { sub: r.dest && r.dest !== 'none' ? ' · → ' + esc(destLabel(r.dest)) : '' })).join('')
    : `<li class="empty">Scanned cards show up here with their prices.</li>`;
}

// ---------------------------------------------------------------- search
let searchNext = null;
function attachAutocomplete(input, listEl, onPick) {
  let t, seq = 0;
  input._acCancel = () => { clearTimeout(t); seq++; listEl.innerHTML = ''; };
  input.addEventListener('input', () => {
    clearTimeout(t);
    const q = input.value.trim();
    if (q.length < 2 || /[:<>=]/.test(q)) { listEl.innerHTML = ''; return; }
    t = setTimeout(async () => {
      const my = ++seq;
      try {
        const r = await sf('/cards/autocomplete?q=' + encodeURIComponent(q));
        if (my !== seq) return;
        listEl.innerHTML = r.data.slice(0, 8).map((n) => `<li>${esc(n)}</li>`).join('');
        $$('li', listEl).forEach((li) => (li.onclick = () => { input.value = li.textContent; listEl.innerHTML = ''; onPick(li.textContent); }));
      } catch {}
    }, 220);
  });
}
async function runSearch(q, append = false) {
  const res = $('#searchResults');
  $('#searchInput')._acCancel?.();
  if (!append) { res.innerHTML = '<p class="muted">Searching…</p>'; searchNext = null; }
  try {
    const r = await sf(append ? searchNext : '/cards/search?unique=cards&order=name&q=' + encodeURIComponent(q));
    if (!append) {
      res.innerHTML = '';
      const nq = norm(q), rank = (c) => (norm(c.name) === nq ? 0 : norm(c.name).startsWith(nq) ? 1 : 2);
      r.data.sort((a, b) => rank(a) - rank(b));
    }
    r.data.forEach(cache);
    res.insertAdjacentHTML('beforeend', r.data.map((c) => {
      const s = state.cards[c.id];
      return `<div class="gc" data-open="${esc(s.id)}"><img src="${esc(s.thumb)}" alt="${esc(s.name)}" loading="lazy"><div>${esc(s.name)}</div><div class="gp">${unitPrice(s) ? money(unitPrice(s)) : '—'}</div></div>`;
    }).join(''));
    searchNext = r.has_more ? r.next_page : null;
    $('#moreBtn').classList.toggle('hidden', !searchNext);
    $('#searchHint').classList.add('hidden');
  } catch (e) {
    res.innerHTML = `<p class="empty">${e.status === 404 ? 'No cards found.' : esc(e.message)}</p>`;
    $('#moreBtn').classList.add('hidden');
  }
}

// ---------------------------------------------------------------- card detail
async function openCard(cardId, { afterAdd, defaultDest } = {}) {
  const my = ++modalSeq; // a newer openCard or closing the popup makes this load stale
  let c = state.cards[cardId];
  showModal(`<p class="muted">Loading…</p>`);
  let full;
  try { full = await sf('/cards/' + encodeURIComponent(cardId)); c = cache(full); }
  catch { if (my !== modalSeq) return; if (!c) return showModal('<p>Could not load card.</p>'); }
  if (my !== modalSeq) return;
  const faces = full?.card_faces && !full.oracle_text ? full.card_faces : [full || {}];
  const oracle = faces.map((f) => [f.name && faces.length > 1 ? f.name + ' ' + (f.mana_cost || '') : '', f.type_line, f.oracle_text].filter(Boolean).join('\n')).join('\n\n');
  const owned = state.collection.filter((e) => state.cards[e.cardId]?.oracle_id === c.oracle_id).reduce((s, e) => s + e.qty, 0);
  const dest0 = defaultDest || (state.settings.dest === 'none' ? 'collection' : state.settings.dest);
  const hasFoil = c.finishes.includes('foil') || c.finishes.includes('etched');
  const hasNon = c.finishes.includes('nonfoil');
  showModal(`
    <h2>${esc(c.name)}</h2>
    <div class="muted" style="margin-bottom:8px">${esc(c.mana)} ${esc(c.type)}</div>
    <img class="detail-img" src="${esc(c.img)}" alt="">
    <div class="prices">
      <div class="stat hl"><b>${c.prices.usd ? money(c.prices.usd) : '—'}</b><span>Normal</span></div>
      <div class="stat hl"><b>${c.prices.usd_foil || c.prices.usd_etched ? money(c.prices.usd_foil || c.prices.usd_etched) : '—'}</b><span>Foil</span></div>
      <div class="stat"><b>${owned}</b><span>You own</span></div>
    </div>
    <label class="field"><span>Printing</span><select id="printSel"><option value="${esc(c.id)}">${esc(c.set_name)} (${esc(c.set.toUpperCase())}) #${esc(c.cn)}</option></select></label>
    <div class="form-grid">
      <label class="field full"><span>Add to</span><select id="addDest">${destOptions(dest0, { includeNone: false })}</select></label>
      <label class="field"><span>Quantity</span><input type="number" id="addQty" value="1" min="1" inputmode="numeric"></label>
      <label class="field"><span>Board</span><select id="addBoard"><option value="main">Main</option><option value="side">Sideboard</option><option value="commander">Commander</option><option value="maybe">Maybe</option></select></label>
      <label class="toggle full"><input type="checkbox" id="addFoil" ${(foilOn() && hasFoil) || !hasNon ? 'checked' : ''} ${!hasFoil || !hasNon ? 'disabled' : ''}> Foil</label>
    </div>
    <button class="btn primary big" style="width:100%" id="addBtn">Add</button>
    ${oracle.trim() ? `<p class="oracle">${esc(oracle)}</p>` : ''}
    <p class="center"><a class="muted" href="${esc(c.uri)}" target="_blank" rel="noopener">View on Scryfall ↗</a></p>`);
  const boardSel = $('#addBoard'), destSel = $('#addDest');
  const syncBoard = () => (boardSel.disabled = destSel.value === 'collection');
  syncBoard();
  destSel.onchange = () => handleNewDeckOption(destSel, (id) => { destSel.innerHTML = destOptions(id || 'collection', { includeNone: false }); syncBoard(); });
  $('#addBtn').onclick = () => {
    const id = $('#printSel').value, qty = Math.max(1, parseInt($('#addQty').value) || 1);
    const foil = $('#addFoil').checked, dest = destSel.value;
    addTo(dest, id, foil, qty, boardSel.value);
    hideModal(); toast(`Added ${qty}× ${state.cards[id].name} to ${destLabel(dest)}`);
    renderAll(); afterAdd && afterAdd();
  };
  $('#printSel').onchange = () => { const id = $('#printSel').value; openCard(id, { afterAdd, defaultDest: destSel.value }); };
  // load printings
  if (c.prints_uri) {
    try {
      let url = c.prints_uri, prints = [];
      while (url && prints.length < 350) {
        const r = await sf(url); if (my !== modalSeq) return;
        prints.push(...r.data); url = r.has_more ? r.next_page : null;
      }
      const sel = $('#printSel'); if (!sel || my !== modalSeq) return;
      prints.forEach((p) => (state.cards[p.id] ? Object.assign(state.cards[p.id], slim(p)) : (state.cards[p.id] = slim(p))));
      save();
      // hide digital-only versions, but always keep the one currently shown
      sel.innerHTML = prints.filter((p) => !p.digital || p.id === c.id).map((p) => {
        const s = state.cards[p.id];
        const pr = s.prices.usd ? money(s.prices.usd) : s.prices.usd_foil ? money(s.prices.usd_foil) + ' foil' : 'no price';
        return `<option value="${esc(p.id)}" ${p.id === c.id ? 'selected' : ''}>${esc(s.set_name)} (${esc(s.set.toUpperCase())}) #${esc(s.cn)} — ${pr}</option>`;
      }).join('');
    } catch {}
  }
}

// ---------------------------------------------------------------- collection
function collectionTotals() {
  let cards = 0, value = 0;
  const unique = new Set();
  state.collection.forEach((e) => { const c = state.cards[e.cardId]; if (!c) return; cards += e.qty; value += unitPrice(c, e.foil) * e.qty; unique.add(c.oracle_id); });
  return { cards, value, unique: unique.size };
}
function renderCollection() {
  const t = collectionTotals();
  $('#collStats').innerHTML = `<div class="stat hl"><b>${money(t.value)}</b><span>Total value</span></div>
    <div class="stat"><b>${t.cards}</b><span>Cards</span></div><div class="stat"><b>${t.unique}</b><span>Unique</span></div>`;
  const f = norm($('#collFilter').value), sort = $('#collSort').value;
  let list = state.collection.filter((e) => state.cards[e.cardId] && (!f || norm(state.cards[e.cardId].name + state.cards[e.cardId].type).includes(f)));
  const C = (e) => state.cards[e.cardId];
  if (sort === 'name') list.sort((a, b) => C(a).name.localeCompare(C(b).name));
  else if (sort === 'price') list.sort((a, b) => unitPrice(C(b), b.foil) * b.qty - unitPrice(C(a), a.foil) * a.qty);
  else if (sort === 'set') list.sort((a, b) => C(a).set_name.localeCompare(C(b).set_name) || C(a).cn.localeCompare(C(b).cn, undefined, { numeric: true }));
  else list.sort((a, b) => (b.added || 0) - (a.added || 0));
  $('#collList').innerHTML = list.length ? list.map((e) => cardRow(e, { qtyControls: true }).replace('<li ', `<li data-foil="${e.foil ? 1 : 0}" `)).join('')
    : `<li class="empty">${state.collection.length ? 'Nothing matches.' : 'Your collection is empty. Scan cards with “Collection” selected, or add them from Search.'}</li>`;
}

// ---------------------------------------------------------------- decks
let openDeckId = null;
function createDeck(name, format = 'commander') {
  const d = { id: uid(), name, format, created: Date.now(), cards: [] };
  state.decks.push(d); save(); renderAll(); return d;
}
function deckTotals(d) {
  let cards = 0, value = 0;
  d.cards.forEach((e) => { const c = state.cards[e.cardId]; if (!c || e.board === 'maybe') return; cards += e.qty; value += unitPrice(c, e.foil) * e.qty; });
  return { cards, value };
}
function ownedCount(oracleId) {
  return state.collection.filter((e) => state.cards[e.cardId]?.oracle_id === oracleId).reduce((s, e) => s + e.qty, 0);
}
function renderDecks() {
  $('#deckList').innerHTML = state.decks.length ? state.decks.map((d) => {
    const t = deckTotals(d);
    return `<li data-deck="${esc(d.id)}"><div><div class="dn">${esc(d.name)}</div><div class="muted">${t.cards} cards · ${esc(d.format)}</div></div><div class="dv">${money(t.value)}</div></li>`;
  }).join('') : `<li class="empty" style="cursor:default;display:block">No decks yet.</li>`;
  $$('#deckList li[data-deck]').forEach((li) => (li.onclick = () => { openDeckId = li.dataset.deck; renderDeckDetail(); }));
  renderDeckDetail();
}
const BOARDS = [['commander', 'Commander'], ['main', 'Main deck'], ['side', 'Sideboard'], ['maybe', 'Maybe']];
function renderDeckDetail() {
  const d = state.decks.find((x) => x.id === openDeckId);
  $('#deckIndex').classList.toggle('hidden', !!d);
  $('#deckDetail').classList.toggle('hidden', !d);
  if (!d) return;
  const t = deckTotals(d);
  let missingValue = 0;
  const need = {};
  d.cards.forEach((e) => { const c = state.cards[e.cardId]; if (c && e.board !== 'maybe') need[c.oracle_id] = (need[c.oracle_id] || 0) + e.qty; });
  Object.entries(need).forEach(([oid, n]) => {
    const miss = Math.max(0, n - ownedCount(oid));
    if (miss) { const e = d.cards.find((x) => state.cards[x.cardId]?.oracle_id === oid); missingValue += miss * unitPrice(state.cards[e.cardId], e.foil); }
  });
  let html = `<div class="deck-head"><button class="icon-btn" id="deckBack" aria-label="Back">‹</button><h2>${esc(d.name)}</h2><button class="btn small ghost" id="deckMenu">Edit</button></div>
    <div class="stats"><div class="stat hl"><b>${money(t.value)}</b><span>Deck value</span></div><div class="stat"><b>${t.cards}</b><span>Cards</span></div><div class="stat"><b>${money(missingValue)}</b><span>Not owned</span></div></div>
    <div class="row gap wrap">
      <button class="btn small primary" id="deckAdd">Add card</button>
      <button class="btn small" id="deckScan">Scan into deck</button>
      <button class="btn small" id="deckCsv">Export CSV</button>
      <button class="btn small" id="deckText">Copy for Untap</button>
      <button class="btn small ghost" id="deckImport">Import list</button>
      <button class="btn small ghost" id="deckRefresh">Refresh prices</button>
    </div>`;
  BOARDS.forEach(([b, label]) => {
    const rows = d.cards.filter((e) => e.board === b && state.cards[e.cardId]).sort((a, z) => state.cards[a.cardId].name.localeCompare(state.cards[z.cardId].name));
    if (!rows.length) return;
    const n = rows.reduce((s, e) => s + e.qty, 0), v = rows.reduce((s, e) => s + e.qty * unitPrice(state.cards[e.cardId], e.foil), 0);
    html += `<div class="section-title"><span>${label} (${n})</span><span>${money(v)}</span></div><ul class="cards">`;
    html += rows.map((e) => {
      const own = ownedCount(state.cards[e.cardId].oracle_id);
      return cardRow(e, { qtyControls: true, sub: own ? ` · own ${own}` : ' · <span class="warn">not owned</span>' })
        .replace('<li ', `<li data-foil="${e.foil ? 1 : 0}" data-board="${b}" `);
    }).join('') + '</ul>';
  });
  if (!d.cards.length) html += `<p class="empty">Empty deck. Add cards from Search, scan them in, or import a list.</p>`;
  $('#deckDetail').innerHTML = html;
  $('#deckBack').onclick = () => { openDeckId = null; renderDecks(); };
  $('#deckAdd').onclick = () => { setView('search'); state.settings.searchDest = d.id; $('#searchInput').focus(); toast(`Tap a card, then Add → ${d.name}`); };
  $('#deckScan').onclick = () => { state.settings.dest = d.id; save(); renderDestSelect(); setView('scan'); };
  $('#deckCsv').onclick = () => downloadCsv(d.name, d.cards.map((e) => ({ ...e })));
  $('#deckText').onclick = () => copyText(deckText(d), 'Deck list copied — paste it into Untap’s deck import');
  $('#deckImport').onclick = () => importDialog(d.id);
  $('#deckRefresh').onclick = () => doRefresh(d.cards.map((e) => e.cardId));
  $('#deckMenu').onclick = () => editDeck(d);
}
function editDeck(d) {
  showModal(`<h2>Edit deck</h2>
    <label class="field"><span>Name</span><input type="text" id="dName" value="${esc(d.name)}"></label>
    <label class="field" style="margin-top:8px"><span>Format</span><select id="dFormat">${['commander', 'standard', 'modern', 'pioneer', 'legacy', 'pauper', 'casual', 'limited'].map((f) => `<option ${f === d.format ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
    <div class="row gap" style="margin-top:14px"><button class="btn primary grow" id="dSave">Save</button><button class="btn danger" id="dDel">Delete deck</button></div>`);
  $('#dSave').onclick = () => { d.name = $('#dName').value.trim() || d.name; d.format = $('#dFormat').value; save(); hideModal(); renderAll(); };
  $('#dDel').onclick = () => {
    if (!confirm(`Delete "${d.name}"? This can't be undone (your collection is not affected).`)) return;
    state.decks = state.decks.filter((x) => x !== d); openDeckId = null; save(); hideModal(); renderAll();
  };
}

// ---------------------------------------------------------------- export / import
function csvCell(v) { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function toCsv(entries) {
  const head = ['Count', 'Name', 'Edition', 'Set Code', 'Collector Number', 'Foil', 'Board', 'Rarity', 'Type', 'Price (USD)', 'Total (USD)', 'Scryfall ID'];
  const rows = entries.filter((e) => state.cards[e.cardId]).map((e) => {
    const c = state.cards[e.cardId], u = unitPrice(c, e.foil), q = e.qty ?? 1;
    return [q, c.name, c.set_name, c.set.toUpperCase(), c.cn, e.foil ? 'foil' : '', e.board || '', c.rarity, c.type, u.toFixed(2), (u * q).toFixed(2), c.id];
  });
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}
async function downloadCsv(name, entries) {
  const csv = toCsv(entries);
  const fname = (name.replace(/[^\w\- ]+/g, '').trim() || 'cards') + '.csv';
  const file = new File([csv], fname, { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: fname }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = fname;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function deckText(d) {
  const line = (e) => `${e.qty} ${state.cards[e.cardId].name}`;
  const by = (b) => d.cards.filter((e) => e.board === b && state.cards[e.cardId]);
  let out = [];
  const cmd = by('commander'), main = by('main'), side = by('side');
  if (cmd.length) out.push(...cmd.map(line));
  out.push(...main.map(line));
  if (side.length) out.push('', 'Sideboard', ...side.map(line));
  return out.join('\n');
}
async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { showModal(`<h2>Copy this list</h2><textarea readonly>${esc(text)}</textarea>`); }
}

function importDialog(dest) {
  showModal(`<h2>Import list</h2>
    <p class="muted">One card per line, e.g. <code>4 Lightning Bolt</code>, <code>1 Sol Ring (C21) 263</code>, or a CSV with Count/Name columns. Lines after “Sideboard” go to the sideboard.</p>
    <textarea id="impText" placeholder="1 Sol Ring&#10;1 Arcane Signet&#10;..."></textarea>
    <div class="row gap" style="margin-top:10px"><label class="btn ghost">Choose file<input type="file" id="impFile" accept=".csv,.txt,text/*" hidden></label><button class="btn primary grow" id="impGo">Import to ${esc(destLabel(dest))}</button></div>
    <p class="muted" id="impStatus"></p>`);
  $('#impFile').onchange = async (e) => { const f = e.target.files[0]; if (f) $('#impText').value = await f.text(); };
  $('#impGo').onclick = async () => {
    $('#impGo').disabled = true;
    try { await importList($('#impText').value, dest, (m) => ($('#impStatus').textContent = m)); }
    finally { const b = $('#impGo'); if (b) b.disabled = false; }
  };
}
function parseList(text) {
  const lines = text.split(/\r?\n/);
  const out = []; let board = 'main';
  let csvCols = null;
  const splitCsv = (l) => { const r = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { r.push(cur); cur = ''; } else cur += ch; } r.push(cur); return r.map((s) => s.trim()); };
  lines.forEach((raw, i) => {
    const l = raw.trim(); if (!l) return;
    if (i === 0 && /name/i.test(l) && l.includes(',')) { csvCols = splitCsv(l).map((s) => s.toLowerCase()); return; }
    if (/^(sideboard|side ?board:?|sb:?)$/i.test(l)) { board = 'side'; return; }
    if (/^(commander|commanders):?$/i.test(l)) { board = 'commander'; return; }
    if (/^(deck|main ?deck|mainboard):?$/i.test(l)) { board = 'main'; return; }
    if (/^(\/\/|#)/.test(l)) return;
    if (csvCols) {
      const c = splitCsv(l), get = (...ks) => { for (const k of ks) { const i = csvCols.findIndex((x) => x === k || x.startsWith(k)); if (i >= 0 && c[i]) return c[i]; } return ''; };
      out.push({ qty: parseInt(get('count', 'quantity', 'qty')) || 1, name: get('name', 'card'), set: get('set code', 'set', 'edition code').toLowerCase(), cn: get('collector'), foil: /foil|etched|yes|true/i.test(get('foil', 'finish')), board: (get('board') || board).toLowerCase() });
      return;
    }
    let m = l.match(/^(?:SB:\s*)?(\d+)\s*x?\s+(.+)$/i); let qty = 1, rest = l;
    if (m) { qty = +m[1]; rest = m[2]; }
    const foil = /\*F\*|\(foil\)/i.test(rest); rest = rest.replace(/\*F\*|\(foil\)/gi, '').trim();
    const pm = rest.match(/^(.*?)\s+\(([A-Za-z0-9]{2,6})\)\s*([\w\-★]+)?\s*$/);
    const item = pm ? { qty, name: pm[1], set: pm[2].toLowerCase(), cn: pm[3] || '', foil, board } : { qty, name: rest, set: '', cn: '', foil, board };
    if (/^SB:/i.test(l)) item.board = 'side';
    out.push(item);
  });
  return out.filter((x) => x.name);
}
async function importList(text, dest, report) {
  const items = parseList(text);
  if (!items.length) return report('Nothing to import.');
  // Look everything up first; only add cards once every lookup has succeeded,
  // so a network failure part-way leaves the list untouched and a retry can't double-add.
  const plan = [], failed = [];
  const boardOf = (it) => (['main', 'side', 'commander', 'maybe'].includes(it.board) ? it.board : 'main');
  try {
    for (let i = 0; i < items.length; i += 75) {
      const chunk = items.slice(i, i + 75);
      const ids = chunk.map((x) => (x.set && x.cn ? { set: x.set, collector_number: x.cn } : x.set ? { name: x.name, set: x.set } : { name: x.name }));
      report(`Looking up ${i + chunk.length} / ${items.length}…`);
      const r = await sf('/cards/collection', { method: 'POST', body: JSON.stringify({ identifiers: ids }) });
      const found = r.data.map(cache);
      // Scryfall returns found cards in order, omitting not_found ones — match them back up
      const nf = new Set((r.not_found || []).map((x) => JSON.stringify(x)));
      let fi = 0;
      const retry = [];
      chunk.forEach((it, k) => {
        if (nf.has(JSON.stringify(ids[k]))) { retry.push(it); return; }
        const c = found[fi++]; if (c) plan.push({ id: c.id, it });
      });
      for (const it of retry) { // typos / odd spellings: let Scryfall's fuzzy match have a go
        try { plan.push({ id: cache(await sf('/cards/named?fuzzy=' + encodeURIComponent(it.name))).id, it }); }
        catch (e) { if (e.status === 404) failed.push(it.name); else throw e; }
      }
    }
  } catch (e) { report('Error: ' + e.message + ' — nothing was imported, try again.'); return; }
  let done = 0;
  plan.forEach(({ id, it }) => { addTo(dest, id, it.foil, it.qty, boardOf(it)); done += it.qty; });
  renderAll();
  report(`Imported ${done} cards.${failed.length ? ' Not found: ' + failed.join(', ') : ''}`);
  if (!failed.length) { hideModal(); toast(`Imported ${done} cards into ${destLabel(dest)}`); }
}

async function doRefresh(ids) {
  if (!ids.length) return;
  toast('Refreshing prices…');
  try { await refreshPrices(ids); renderAll(); toast('Prices updated'); }
  catch (e) { toast('Price refresh failed: ' + e.message); }
}

// ---------------------------------------------------------------- settings / backup
function safetyKeys() {
  try { return Object.keys(localStorage).filter((k) => k.startsWith(BACKUP_PREFIX)).sort(); } catch { return []; }
}
function openSettings() {
  const bytes = (localStorage.getItem(STORE_KEY) || '').length;
  showModal(`<h2>Settings & backup</h2>
    <label class="toggle"><input type="checkbox" id="setSound" ${state.settings.sound ? 'checked' : ''}> Beep when a card is recognized</label>
    <p class="muted">“Exact printing” on the Scan tab also reads the set code / collector number at the bottom of newer cards (2015+) so the right version and price are picked. Turn it off for faster scanning.</p>
    <h3>Backup</h3>
    <p class="muted">Your data lives only on this phone (${(bytes / 1024).toFixed(0)} KB). Export a backup now and then — it's one file you can save to iCloud Drive / Files.</p>
    <div class="row gap wrap"><button class="btn" id="bkExport">Export backup</button><label class="btn">Restore backup<input type="file" id="bkImport" accept=".json,application/json" hidden></label></div>
    ${safetyKeys().length ? `<h3>Safety copies</h3><p class="muted">Saved automatically before data upgrades, or when saved data couldn't be read. Download one, then use Restore backup to load it.</p><div class="row gap wrap">${safetyKeys().map((k) => `<button class="btn small" data-safety="${esc(k)}">${esc(k.slice(BACKUP_PREFIX.length))}</button>`).join('')}</div>` : ''}
    <h3>Export</h3>
    <div class="row gap wrap"><button class="btn" id="exAll">All decks + collection CSV</button></div>
    <h3>Danger zone</h3>
    <div class="row gap wrap"><button class="btn danger" id="clrCache">Clear unused card cache</button></div>
    <p class="muted">Card data & prices from <a class="muted" href="https://scryfall.com" target="_blank" rel="noopener">Scryfall</a>. Not affiliated with Wizards of the Coast.</p>`);
  $$('[data-safety]').forEach((b) => (b.onclick = () => {
    const raw = localStorage.getItem(b.dataset.safety) || '';
    let body = raw; try { body = JSON.stringify({ app: 'mtgscan', ...JSON.parse(raw) }); } catch {}
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    a.download = 'mtg-scanner-' + b.dataset.safety.slice(BACKUP_PREFIX.length) + '.json'; a.click();
  }));
  $('#setSound').onchange = (e) => { state.settings.sound = e.target.checked; save(); };
  $('#bkExport').onclick = async () => {
    const file = new File([JSON.stringify({ app: 'mtgscan', v: 1, at: new Date().toISOString(), ...persistable() })], `mtg-scanner-backup-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
  };
  $('#bkImport').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'mtgscan') throw new Error('Not an MTG Scanner backup');
      validateBackup(data);
      if (!confirm('Replace everything on this phone with this backup?')) return;
      const { app, v, at, ...rest } = data; state = Object.assign(defaultState(), rest, { schema: SCHEMA }); saveBlocked = null; save(); hideModal(); renderAll(); toast('Backup restored');
    } catch (err) { toast('Restore failed: ' + err.message); }
  };
  $('#exAll').onclick = () => {
    const all = [...state.collection.map((e) => ({ ...e, board: 'collection' })), ...state.decks.flatMap((d) => d.cards.map((e) => ({ ...e, board: d.name + ' / ' + e.board })))];
    downloadCsv('mtg-everything', all);
  };
  $('#clrCache').onclick = () => {
    const keep = new Set([...state.collection, ...state.recent, ...state.decks.flatMap((d) => d.cards)].map((e) => e.cardId));
    const before = Object.keys(state.cards).length;
    Object.keys(state.cards).forEach((id) => { if (!keep.has(id)) delete state.cards[id]; });
    save(); toast(`Removed ${before - Object.keys(state.cards).length} cached cards`);
  };
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
function validateBackup(d) {
  const bad = (m) => { throw new Error('Backup looks damaged (' + m + ')'); };
  if (!d.cards || typeof d.cards !== 'object' || Array.isArray(d.cards)) bad('cards');
  for (const k of ['collection', 'decks', 'recent']) if (!Array.isArray(d[k])) bad(k);
  const entry = (e, needQty) => {
    if (!e || typeof e !== 'object' || !SAFE_ID.test(String(e.cardId))) bad('card id');
    if (needQty && !(Number.isFinite(e.qty) && e.qty > 0)) bad('quantity');
  };
  d.collection.forEach((e) => entry(e, true));
  d.recent.forEach((e) => entry(e, false));
  d.decks.forEach((dk) => {
    if (!dk || !SAFE_ID.test(String(dk.id)) || typeof dk.name !== 'string' || !Array.isArray(dk.cards)) bad('deck');
    dk.cards.forEach((e) => entry(e, true));
  });
  Object.entries(d.cards).forEach(([k, c]) => { if (!SAFE_ID.test(k) || !c || c.id !== k) bad('card data'); });
}

// ---------------------------------------------------------------- modal & views
function showModal(html) { $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden'); }
let modalSeq = 0;
function hideModal() { modalSeq++; $('#modal').classList.add('hidden'); $('#modalBody').innerHTML = ''; }
const TITLES = { scan: 'Scan', search: 'Search', collection: 'Collection', decks: 'Decks' };
function setView(v) {
  $$('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + v));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  $('#viewTitle').textContent = TITLES[v];
  if (v !== 'scan') stopAuto();
  if (v !== 'search') state.settings.searchDest = null;
  if (v === 'scan') renderDestSelect();
  window.scrollTo(0, 0);
}
function renderAll() { renderDestSelect(); renderRecent(); renderCollection(); renderDecks(); }

// qty buttons and card opening via delegation
document.addEventListener('click', (e) => {
  const q = e.target.closest('[data-q]');
  if (q) {
    const li = q.closest('li'), id = li.dataset.id, foil = li.dataset.foil === '1', delta = +q.dataset.q;
    const inDeck = q.closest('#deckDetail'); const dest = inDeck ? openDeckId : 'collection';
    if (delta > 0) addTo(dest, id, foil, 1, li.dataset.board || 'main'); else removeFrom(dest, id, foil, 1, li.dataset.board || 'main');
    renderAll(); return;
  }
  const o = e.target.closest('[data-open]');
  if (o) openCard(o.dataset.open, { defaultDest: state.settings.searchDest || (openDeckId && $('#view-decks').classList.contains('active') ? openDeckId : undefined) });
});

// ---------------------------------------------------------------- wire up
function init() {
  load();
  renderAll();
  warnIfBlocked();
  $$('.tab').forEach((t) => (t.onclick = () => setView(t.dataset.view)));
  $('#settingsBtn').onclick = openSettings;
  $('#modalClose').onclick = hideModal;
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') hideModal(); });

  $('#destSelect').onchange = (e) => handleNewDeckOption(e.target, (id) => { state.settings.dest = id || 'none'; save(); renderDestSelect(); });
  $$('.seg-btn').forEach((b) => (b.onclick = () => {
    $$('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    const multi = b.dataset.mode === 'multi';
    $('#singleControls').classList.toggle('hidden', multi); $('#multiControls').classList.toggle('hidden', !multi);
    if (!multi) stopAuto();
    $('#scanResult').innerHTML = '';
  }));
  $('#exactToggle').checked = state.settings.exact;
  $('#exactToggle').onchange = (e) => { state.settings.exact = e.target.checked; save(); };
  $('#startCamBtn').onclick = startCamera;
  $('#shutterBtn').onclick = scanOnce;
  $('#autoBtn').onclick = () => (cam.auto ? stopAuto() : startAuto());
  $('#photoInput').onchange = (e) => { const f = e.target.files[0]; if (f) scanPhoto(f); e.target.value = ''; };
  $('#manualBtn').onclick = () => manualEntry();
  $('#recentClearBtn').onclick = () => { if (state.recent.length && confirm('Clear recent scans? (Cards already added to your collection or decks stay there.)')) { state.recent = []; save(); renderRecent(); } };
  $('#recentAddAllBtn').onclick = () => {
    const items = state.recent.filter((r) => state.cards[r.cardId] && (!r.dest || r.dest === 'none'));
    if (!items.length) return toast('No unsaved scans to add');
    showModal(`<h2>Add ${items.length} unsaved scans to…</h2><select id="bulkDest" style="width:100%">${destOptions('collection', { includeNone: false })}</select>
      <button class="btn primary big" style="width:100%;margin-top:12px" id="bulkGo">Add</button>`);
    $('#bulkDest').onchange = (e) => handleNewDeckOption(e.target, (id) => ($('#bulkDest').innerHTML = destOptions(id || 'collection', { includeNone: false })));
    $('#bulkGo').onclick = () => {
      const dest = $('#bulkDest').value;
      items.forEach((r) => { addTo(dest, r.cardId, r.foil); r.dest = dest; });
      save(); hideModal(); renderAll(); toast(`Added ${items.length} cards to ${destLabel(dest)}`);
    };
  };

  attachAutocomplete($('#searchInput'), $('#suggestList'), (name) => runSearch(`!"${name}"`));
  $('#searchForm').onsubmit = (e) => { e.preventDefault(); const q = $('#searchInput').value.trim(); if (q) runSearch(q); };
  $('#moreBtn').onclick = () => searchNext && runSearch('', true);

  $('#collFilter').oninput = renderCollection;
  $('#collSort').onchange = renderCollection;
  $('#collRefreshBtn').onclick = () => doRefresh(state.collection.map((e) => e.cardId));
  $('#collCsvBtn').onclick = () => downloadCsv('mtg-collection', state.collection);
  $('#collImportBtn').onclick = () => importDialog('collection');
  $('#newDeckBtn').onclick = () => { const n = prompt('Deck name?'); if (n && n.trim()) { const d = createDeck(n.trim()); openDeckId = d.id; renderDecks(); } };

  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });

  // auto-refresh prices older than a day, in the background
  const stale = Object.values(state.cards).filter((c) => Date.now() - (c.updated || 0) > 864e5).map((c) => c.id);
  const used = new Set([...state.collection, ...state.decks.flatMap((d) => d.cards)].map((e) => e.cardId));
  const todo = stale.filter((id) => used.has(id));
  if (todo.length && navigator.onLine) refreshPrices(todo).then(renderAll).catch(() => {});

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // every open copy of the app reloads when a new release takes over, not just the one that tapped Reload
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading) { reloading = true; location.reload(); } });
    const offer = (w) => toast('A new version is ready', 'Reload', () => w.postMessage('SKIP_WAITING'));
    navigator.serviceWorker.register('sw.js').then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
      });
    }).catch(() => {});
  }
}
init();

// exposed for testing in the console
window.__mtg = { cropForOcr, identifyFrom, cleanName, parseSetLine, parseList, toCsv, state: () => state };
