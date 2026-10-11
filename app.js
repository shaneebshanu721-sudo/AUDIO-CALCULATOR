// app.js — user interface glue. All user-supplied text is inserted with
// textContent (never innerHTML) so transcripts/remarks/imports cannot inject markup.

import { formatINR, parseMoneyInput, paiseToInput } from './money.js';
import { parseAmount } from './parser.js';
import * as L from './ledger.js';
import { booksToCSV, allBooksCSV, makeBackup, parseBackup, fileSafe, MAX_BACKUP_BYTES } from './exporter.js';
import { loadState, saveState, wipeAll, requestPersistentStorage } from './storage.js';
import { SpeechController, getRecognitionCtor, STATES, MESSAGES } from './speech.js';
import { ReadBack, readBackText } from './readback.js';
import { UndoHistory } from './history.js';

export const APP_VERSION = '2.0.0';
const LOW_CONFIDENCE = 0.5;

const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c.nodeType ? c : document.createTextNode(String(c)));
  return node;
}

// ---------------- state ----------------
const loaded = loadState();
let state = loaded.state;
let storageError = loaded.warning;
let justAddedIds = new Set();
const history = new UndoHistory(40);
const readBack = new ReadBack();

function persist() {
  const err = saveState(state);
  storageError = err || (storageError && storageError.startsWith('Saved data could not') ? storageError : null);
  renderStorageBanner();
}
function commit() { persist(); render(); }
const activeBook = () => L.getActiveBook(state);
const title = (b) => L.bookTitle(b);

/** Run a data change with an undo point. */
function mutate(label, fn) {
  history.record(label, state);
  try {
    const out = fn();
    commit();
    return out;
  } catch (e) {
    history.undo(state); // roll back the snapshot we just took
    throw e;
  }
}

// ---------------- environment ----------------
const Recognition = getRecognitionCtor(window);
const env = {
  protocol: location.protocol,
  secure: window.isSecureContext === true,
  speech: window.SpeechRecognition ? 'SpeechRecognition' : window.webkitSpeechRecognition ? 'webkitSpeechRecognition (Chrome)' : 'Not available',
  webview: /; wv\)/.test(navigator.userAgent || ''),
};

function renderEnvBanner() {
  const b = $('env-banner');
  b.replaceChildren();
  let head = null; const lines = [];
  if (env.protocol === 'content:' || env.protocol === 'file:') {
    head = `This page was opened as a local file (${env.protocol}//). The microphone cannot work here.`;
    lines.push('Chrome only grants microphone access to real websites (https://). Open the app from its https:// address.');
  } else if (!env.secure) {
    head = 'This page is not secure (http://). The microphone is blocked.';
    lines.push('Open the https:// address of the app instead.');
  } else if (!Recognition) {
    head = 'Voice input is not available in this browser.';
    lines.push(env.webview ? 'You are inside an in-app browser (WhatsApp, Gmail…). Use ⋮ → “Open in Chrome”.' : 'Open this page in Google Chrome. Typing amounts works everywhere.');
  }
  if (!head) { b.hidden = true; return; }
  b.append(el('strong', { text: head }), ...lines.map((t) => el('div', { text: t })));
  b.hidden = false;
}
function renderStorageBanner() { const b = $('storage-banner'); b.textContent = storageError || ''; b.hidden = !storageError; }
function renderOffline() { $('offline-banner').hidden = navigator.onLine !== false; }

// ---------------- speech ----------------
let micChecked = false;
let wakeLock = null;
let pausedInBackground = false;

const speech = new SpeechController({
  Recognition,
  lang: state.settings.lang,
  mode: state.settings.mode,
  onStatus: handleStatus,
  onInterim: (text) => {
    const live = $('live-text');
    if (text) { live.textContent = text; live.classList.add('interim'); } else live.classList.remove('interim');
  },
  onFinal: handleFinal,
});

function handleStatus(s) {
  const actual = s.state;
  $('status-dot').dataset.state = actual;
  $('status-text').textContent = s.message;
  const btn = $('btn-listen');
  btn.dataset.state = actual;
  btn.setAttribute('aria-pressed', String(speech.wanted));
  $('listen-label').textContent = speech.wanted ? 'Stop' : 'Start';
  $('btn-retry').hidden = !(s.canRetry && actual === STATES.ERROR);
  if (actual === STATES.LISTENING) acquireWakeLock(); else if (!speech.wanted) releaseWakeLock();
}

async function acquireWakeLock() {
  try {
    if (!wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not critical */ }
}
function releaseWakeLock() { try { wakeLock && wakeLock.release(); } catch { /* ignore */ } wakeLock = null; }

async function ensureMicPermission() {
  if (micChecked || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'ok';
  handleStatus({ state: STATES.STARTING, code: 'custom', message: 'Requesting microphone access…', canRetry: false });
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    micChecked = true;
    await new Promise((r) => setTimeout(r, 200));
    return 'ok';
  } catch (err) {
    const n = err && err.name;
    if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'denied';
    if (n === 'NotFoundError' || n === 'NotReadableError' || n === 'OverconstrainedError') return 'no-mic';
    return 'ok';
  }
}

async function startListening() {
  pausedInBackground = false;
  if (!Recognition) { handleStatus({ state: STATES.ERROR, code: 'unsupported', message: MESSAGES.unsupported, canRetry: false }); return; }
  if (!env.secure) { handleStatus({ state: STATES.ERROR, code: 'insecure', message: 'Microphone blocked: open the app from its https:// address.', canRetry: false }); return; }
  const btn = $('btn-listen');
  btn.disabled = true;
  const mic = await ensureMicPermission();
  btn.disabled = false;
  if (mic === 'denied') { handleStatus({ state: STATES.ERROR, code: 'denied', message: MESSAGES.denied, canRetry: true }); return; }
  if (mic === 'no-mic') { handleStatus({ state: STATES.ERROR, code: 'no-mic', message: MESSAGES['no-mic'], canRetry: true }); return; }
  speech.start();
}

/** Split a parser "reference" into a leaf number (digits) or a voucher ref (other text). */
function leafAndRef(reference) {
  if (!reference) return { leaf: undefined, ref: '' };
  return /^\d{1,7}$/.test(reference) && Number(reference) >= 1 ? { leaf: Number(reference), ref: '' } : { leaf: undefined, ref: reference };
}

function speakAdded(addedPaise, totalPaise) {
  const mode = state.settings.readBack;
  if (mode === 'off') return;
  const nums = mode === 'amount' ? [addedPaise] : mode === 'total' ? [totalPaise] : [addedPaise, totalPaise];
  readBack.speak(readBackText(mode, addedPaise, totalPaise), nums);
}

function addVoiceEntries(book, amounts, transcript, reference) {
  const { leaf, ref } = leafAndRef(reference);
  const added = mutate(amounts.length > 1 ? `${amounts.length} amounts` : formatINR(amounts[0]), () =>
    amounts.map((paise, i) => L.addEntry(state, book.id, { paise, source: 'voice', transcript, reference: i === 0 ? ref : '', leaf: i === 0 ? leaf : undefined })));
  justAddedIds = new Set(added.map((e) => e.id));
  render();
  const total = L.bookTotal(book);
  const sum = added.reduce((s, e) => s + e.paise, 0);
  const leafText = added.length === 1 ? `Leaf ${added[0].leaf}` : `Leaves ${added[0].leaf}–${added[added.length - 1].leaf}`;
  showFlash('ok', `+ ${formatINR(sum)}`, `${leafText} · Total ${formatINR(total)}`);
  vibrate(30);
  speakAdded(sum, total);
}

function handleFinal(r) {
  const live = $('live-text');
  live.textContent = r.transcript;
  live.classList.remove('interim');
  const book = activeBook();
  let parsed = parseAmount(r.transcript);
  const reasons = [];

  // If the top transcript is unusable, try Chrome's other guesses.
  if (parsed.status === 'invalid') {
    for (const alt of r.alternatives.slice(1)) {
      const p = parseAmount(alt.transcript);
      if (p.status === 'ok' || p.status === 'confirm') {
        parsed = { ...p, status: 'confirm', transcript: alt.transcript };
        reasons.push(`Unclear speech; best guess from “${alt.transcript}”.`);
        break;
      }
    }
  }

  if (parsed.status === 'command') {
    if (parsed.command === 'undo') doUndo();
    else if (parsed.command === 'stop') speech.stop();
    else if (parsed.command === 'setLeaf') {
      const { leaf } = leafAndRef(parsed.reference);
      if (leaf) {
        mutate(`next leaf ${leaf}`, () => L.setNextLeaf(state, book.id, leaf));
        showFlash('ok', `Next leaf ${leaf}`, title(book));
        if (state.settings.readBack !== 'off') readBack.speak(`leaf ${leaf}`, []);
      }
    }
    return;
  }
  if (parsed.status === 'invalid') {
    showFlash('err', 'Not understood — say it again', parsed.reasons[0] || '');
    vibrate([30, 60, 30]);
    return;
  }

  const heard = parsed.status === 'multiple' ? parsed.amounts : [parsed.paise];
  if (readBack.isEcho(heard)) { live.textContent = `${r.transcript} (ignored: read-back echo)`; return; }

  reasons.push(...parsed.reasons);
  let amounts = heard;
  let kind = parsed.status === 'multiple' ? 'multiple' : 'confirm';

  if (parsed.status !== 'multiple') {
    const others = new Set();
    for (const alt of r.alternatives.slice(1)) {
      const p = parseAmount(alt.transcript);
      if ((p.status === 'ok' || p.status === 'confirm') && p.paise !== parsed.paise) others.add(p.paise);
    }
    if (others.size) {
      amounts = [parsed.paise, ...others].slice(0, 4);
      reasons.push(`Unsure between ${amounts.map((a) => formatINR(a)).join(' / ')}.`);
    }
    if (r.confidence > 0 && r.confidence < LOW_CONFIDENCE) reasons.push('Low recognition confidence.');
  }
  if (parsed.usedMalayalam && state.settings.confirmMalayalam) reasons.push('Malayalam number words (confirmation is on in settings).');
  if (r.possibleDuplicate) reasons.push('Same phrase heard twice quickly — possible duplicate.');

  const fastOk = parsed.status === 'multiple' && parsed.cleanSplit && state.settings.fastMulti;
  if ((parsed.status === 'ok' || fastOk) && reasons.length === (fastOk ? 1 : 0)) {
    addVoiceEntries(book, amounts, parsed.transcript || r.transcript, parsed.reference);
    return;
  }
  mutate('uncertain result', () => L.addPending(state, { bookId: book.id, kind, transcript: r.transcript, amounts, reference: leafAndRef(parsed.reference).ref, leaf: leafAndRef(parsed.reference).leaf, reasons }));
  showFlash('warn', 'Check this one', reasons[0] || '');
  vibrate([30, 80, 30]);
}

function doUndo() {
  if (!history.canUndo) { toast('Nothing to undo.'); return; }
  const label = history.undo(state);
  readBack.cancel();
  commit();
  const book = activeBook();
  showFlash('warn', 'Undone', `${label} · Total ${formatINR(L.bookTotal(book))}`);
  toast(`Undone: ${label}`);
  if (state.settings.readBack !== 'off') readBack.speak(`undone. total ${readBackText('amount', L.bookTotal(book), 0) || 'zero'}`, [L.bookTotal(book)]);
}

// ---------------- feedback ----------------
let flashTimer = null;
function showFlash(kind, main, sub) {
  const box = $('last-added');
  box.replaceChildren(el('div', { class: kind === 'ok' ? 'flash' : `flash ${kind}` }, el('span', { class: 'amt', text: main }), el('span', { text: sub })));
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => box.replaceChildren(), 7000);
}
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch { /* ignore */ } }

// ---------------- rendering ----------------
const timeFmt = (iso) => { try { return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const dateFmt = (ymd) => { if (!ymd) return ''; const [y, m, d] = ymd.split('-'); return `${d}-${m}-${y}`; };

function render() {
  const book = activeBook();
  if (state.activeBookId !== book.id) state.activeBookId = book.id;
  let total, grand, running;
  try { total = L.bookTotal(book); grand = L.grandTotal(state); running = L.runningTotals(book); }
  catch (e) { storageError = e.message; renderStorageBanner(); return; }

  const sel = $('book-select');
  sel.replaceChildren(...state.books.map((b) => el('option', { value: b.id, text: `${title(b)} (${b.entries.length})` })));
  sel.value = book.id;

  $('book-name').textContent = title(book);
  $('book-date').textContent = book.auditDate ? `Audit date ${dateFmt(book.auditDate)}` : 'No audit date';
  $('book-total').textContent = formatINR(total);
  $('next-leaf').textContent = `Leaf ${L.nextLeafFor(book)}`;
  $('book-count').textContent = `${book.entries.length} ${book.entries.length === 1 ? 'leaf' : 'leaves'}`;
  $('grand-total').textContent = formatINR(grand);
  $('history-total').textContent = formatINR(total);
  $('btn-undo').disabled = !history.canUndo;
  $('empty-hint').hidden = book.entries.length > 0;
  $('manual-leaf').setAttribute('placeholder', String(L.nextLeafFor(book)));

  // tape / details
  const view = state.settings.view;
  const card = document.querySelector('.tape-card');
  if (card) card.classList.toggle('view-details', view === 'details');
  const list = $('entry-list');
  list.className = view === 'details' ? 'tape details' : 'tape';
  list.replaceChildren(...book.entries.map((e, i) => (view === 'details' ? renderDetail(book, e) : renderTapeRow(book, e, running[i]))));
  if (justAddedIds.size) {
    const scroller = $('tape-scroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    justAddedIds = new Set();
  }

  renderPending();

  $('books-body').replaceChildren(...L.summary(state).map((s) =>
    el('tr', { class: s.id === book.id ? 'active' : '', onclick: () => { L.switchBook(state, s.id); commit(); window.scrollTo({ top: 0, behavior: 'smooth' }); } },
      el('td', { text: s.title + (s.auditDate ? ` · ${dateFmt(s.auditDate)}` : '') }),
      el('td', { class: 'num', text: String(s.count) }),
      el('td', { class: 'num', text: formatINR(s.total) }))));
  $('books-count-all').textContent = String(state.books.reduce((n, b) => n + b.entries.length, 0));
  $('books-grand').textContent = formatINR(grand);

  renderSettings();
}

function renderSettings() {
  const s = state.settings;
  $('lang-select').value = s.lang;
  $('mode-select').value = s.mode;
  $('theme-select').value = s.theme;
  $('readback-select').value = s.readBack;
  $('fast-multi').checked = !!s.fastMulti;
  $('confirm-ml').checked = !!s.confirmMalayalam;
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === s.lang));
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === s.view));
  const rb = $('btn-readback');
  rb.setAttribute('aria-pressed', String(s.readBack !== 'off'));
  rb.textContent = s.readBack === 'off' ? '🔇 Read-back off' : '🔊 Read-back on';
}

function renderTapeRow(book, e, run) {
  const bits = [];
  if (e.reference) bits.push(`Ref ${e.reference}`);
  if (e.remarks) bits.push(e.remarks);
  if (e.originalPaise !== null && e.originalPaise !== undefined) bits.push(`edited, was ${formatINR(e.originalPaise)}`);
  const open = () => openEntryDialog({ mode: 'edit', bookId: book.id, entryId: e.id });
  return el('li', {
    class: 'row' + (justAddedIds.has(e.id) ? ' just-added' : ''), 'data-id': e.id, tabindex: '0', role: 'button',
    'aria-label': `Leaf ${e.leaf}, ${formatINR(e.paise)}. Tap to edit.`,
    onclick: open, onkeydown: (ev) => { if (ev.key === 'Enter') open(); },
  },
  el('span', { class: 'leaf', text: String(e.leaf) }),
  el('span', { class: 'amt', text: formatINR(e.paise, { symbol: false }) }),
  el('span', { class: 'run', text: formatINR(run, { symbol: false }) }),
  bits.length ? el('span', { class: 'sub', text: bits.join(' · ') }) : null);
}

const ICON_EDIT = 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25Zm17.71-10.21a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z';
const ICON_DEL = 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z';
function icon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '20'); svg.setAttribute('height', '20'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path); p.setAttribute('fill', 'currentColor');
  svg.append(p);
  return svg;
}

function renderDetail(book, e) {
  const meta = [timeFmt(e.createdAt)];
  if (e.transcript) meta.push(`“${e.transcript}”`);
  if (e.reference) meta.push(`Ref ${e.reference}`);
  if (e.remarks) meta.push(e.remarks);
  if (e.originalPaise !== null && e.originalPaise !== undefined) meta.push(`was ${formatINR(e.originalPaise)}`);
  return el('li', { class: 'drow' + (justAddedIds.has(e.id) ? ' just-added' : ''), 'data-id': e.id },
    el('div', {},
      el('div', { class: 'line1' },
        el('span', { class: 'dleaf', text: `Leaf ${e.leaf}` }),
        el('span', { class: 'damt', text: formatINR(e.paise) }),
        el('span', { class: `badge ${e.source === 'voice' ? 'badge-voice' : 'badge-manual'}`, text: e.source === 'voice' ? 'Voice' : 'Typed' }),
        e.originalPaise !== null && e.originalPaise !== undefined ? el('span', { class: 'badge badge-edited', text: 'Edited' }) : null),
      el('div', { class: 'meta', text: meta.filter(Boolean).join(' · ') })),
    el('div', { class: 'acts' },
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Edit leaf ${e.leaf}`, onclick: () => openEntryDialog({ mode: 'edit', bookId: book.id, entryId: e.id }) }, icon(ICON_EDIT)),
      el('button', { type: 'button', class: 'icon-btn del', 'aria-label': `Delete leaf ${e.leaf}`, onclick: () => confirmDeleteEntry(book.id, e.id) }, icon(ICON_DEL))));
}

function confirmDeleteEntry(bookId, entryId) {
  const book = L.getBook(state, bookId);
  const e = book.entries.find((x) => x.id === entryId);
  if (!e) return;
  if (!window.confirm(`Delete leaf ${e.leaf} (${formatINR(e.paise)}) from ${title(book)}?`)) return;
  mutate(`delete leaf ${e.leaf}`, () => L.deleteEntry(state, bookId, entryId));
  toast(`Deleted leaf ${e.leaf}. Total ${formatINR(L.bookTotal(book))} — tap Undo to restore.`);
}

function renderPending() {
  const items = state.pending;
  $('pending-section').hidden = items.length === 0;
  $('pending-count').textContent = String(items.length);
  $('pending-list').replaceChildren(...items.map((p) => {
    const book = state.books.find((b) => b.id === p.bookId);
    const actions = [];
    if (p.kind === 'multiple' && p.amounts.length > 1) {
      actions.push(el('button', { type: 'button', class: 'btn btn-primary', onclick: () => acceptPending(p.id, p.amounts) }, `Add all ${p.amounts.length}`));
    }
    for (const a of p.amounts) {
      actions.push(el('button', { type: 'button', class: p.kind === 'multiple' ? 'btn btn-outline' : 'btn btn-primary', onclick: () => acceptPending(p.id, [a]) },
        `${p.kind === 'multiple' ? 'Only' : 'Add'} ${formatINR(a)}`));
    }
    actions.push(el('button', { type: 'button', class: 'btn btn-outline', onclick: () => openEntryDialog({ mode: 'pending', pendingId: p.id }) }, 'Correct…'));
    actions.push(el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => mutate('discard', () => L.removePending(state, p.id)) }, 'Discard'));
    return el('li', { class: 'pending-item' },
      el('div', { class: 'heard', text: `Heard: “${p.transcript}”` }),
      p.leaf ? el('div', { class: 'for-book', text: `Leaf ${p.leaf}` }) : null,
      book && book.id !== state.activeBookId ? el('div', { class: 'for-book', text: `For ${title(book)}` }) : null,
      el('div', { class: 'why', text: p.reasons.join(' ') }),
      el('div', { class: 'pending-actions' }, actions));
  }));
}

function acceptPending(id, amounts, opts) {
  try {
    const p = state.pending.find((x) => x.id === id);
    const book = p && state.books.find((b) => b.id === p.bookId) ? L.getBook(state, p.bookId) : activeBook();
    const added = mutate(amounts.length > 1 ? `${amounts.length} amounts` : formatINR(amounts[0]), () => L.acceptPending(state, id, amounts, opts));
    justAddedIds = new Set(added.map((e) => e.id));
    render();
    const sum = added.reduce((s, e) => s + e.paise, 0);
    const total = L.bookTotal(book);
    showFlash('ok', `+ ${formatINR(sum)}`, `Leaf ${added[0].leaf}${added.length > 1 ? '–' + added[added.length - 1].leaf : ''} · Total ${formatINR(total)}`);
    speakAdded(sum, total);
  } catch (e) { toast(e.message); }
}

// ---------------- entry dialog ----------------
let dialogCtx = null;
function openEntryDialog(ctx) {
  dialogCtx = ctx;
  $('edit-error').textContent = '';
  const meta = $('edit-meta');
  meta.replaceChildren();
  if (ctx.mode === 'edit') {
    const book = L.getBook(state, ctx.bookId);
    const e = book.entries.find((x) => x.id === ctx.entryId);
    if (!e) return;
    $('entry-dialog-title').textContent = `Leaf ${e.leaf} · ${title(book)}`;
    $('edit-leaf').value = String(e.leaf);
    $('edit-amount').value = paiseToInput(e.paise);
    $('edit-ref').value = e.reference;
    $('edit-remarks').value = e.remarks;
    $('edit-delete').hidden = false;
    meta.append(
      el('div', { text: `${e.source === 'voice' ? 'Voice' : 'Typed'} · added ${new Date(e.createdAt).toLocaleString('en-IN')}` }),
      e.updatedAt !== e.createdAt ? el('div', { text: `Last edited ${new Date(e.updatedAt).toLocaleString('en-IN')}` }) : null,
      e.transcript ? el('div', { text: `Heard: “${e.transcript}”` }) : null,
      e.originalPaise !== null && e.originalPaise !== undefined ? el('div', { text: `Original amount: ${formatINR(e.originalPaise)}` }) : null,
    );
  } else {
    const p = state.pending.find((x) => x.id === ctx.pendingId);
    if (!p) return;
    const book = state.books.find((b) => b.id === p.bookId) || activeBook();
    $('entry-dialog-title').textContent = 'Correct the amount';
    $('edit-leaf').value = String(p.leaf || L.nextLeafFor(book));
    $('edit-amount').value = p.amounts[0] ? paiseToInput(p.amounts[0]) : '';
    $('edit-ref').value = p.reference;
    $('edit-remarks').value = '';
    $('edit-delete').hidden = true;
    meta.append(el('div', { text: `Heard: “${p.transcript}”` }));
  }
  $('entry-dialog').showModal();
  setTimeout(() => $('edit-amount').focus(), 50);
}

$('entry-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const parsed = parseMoneyInput($('edit-amount').value);
  if (!parsed.ok) { $('edit-error').textContent = parsed.error; return; }
  try {
    const leaf = L.parseLeaf($('edit-leaf').value);
    if (dialogCtx.mode === 'edit') {
      const book = L.getBook(state, dialogCtx.bookId);
      mutate(`edit leaf ${leaf ?? ''}`.trim(), () => L.updateEntry(state, dialogCtx.bookId, dialogCtx.entryId, { paise: parsed.paise, leaf, reference: $('edit-ref').value, remarks: $('edit-remarks').value }));
      toast(`Saved. Total ${formatINR(L.bookTotal(book))}`);
    } else {
      acceptPending(dialogCtx.pendingId, [parsed.paise], { leaf: leaf ?? undefined, reference: $('edit-ref').value, remarks: $('edit-remarks').value || 'Amount corrected by auditor' });
    }
    $('entry-dialog').close();
  } catch (e) { $('edit-error').textContent = e.message; }
});
$('edit-cancel').addEventListener('click', () => $('entry-dialog').close());
$('edit-delete').addEventListener('click', () => {
  if (dialogCtx && dialogCtx.mode === 'edit') { $('entry-dialog').close(); confirmDeleteEntry(dialogCtx.bookId, dialogCtx.entryId); }
});

// ---------------- book dialog ----------------
let bookDialogMode = 'edit';
function openBookDialog(mode) {
  bookDialogMode = mode;
  const book = activeBook();
  $('book-error').textContent = '';
  if (mode === 'new') {
    const kind = book ? book.kind : 'Receipt Book';
    $('book-dialog-title').textContent = 'New book';
    $('book-kind-input').value = kind;
    $('book-name-input').value = L.suggestBookName(state, kind);
    $('book-start-input').value = '1';
    $('book-date-input').value = book && book.auditDate ? book.auditDate : new Date().toLocaleDateString('en-CA');
    $('book-delete').hidden = true;
  } else {
    $('book-dialog-title').textContent = 'Edit book';
    $('book-kind-input').value = book.kind;
    $('book-name-input').value = book.name;
    $('book-start-input').value = String(book.startLeaf);
    $('book-date-input').value = book.auditDate || '';
    $('book-delete').hidden = false;
  }
  $('book-dialog').showModal();
}
$('book-kind-input').addEventListener('change', () => {
  if (bookDialogMode === 'new') $('book-name-input').value = L.suggestBookName(state, $('book-kind-input').value);
});
$('book-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const fields = { kind: $('book-kind-input').value, name: $('book-name-input').value.trim(), auditDate: $('book-date-input').value, startLeaf: $('book-start-input').value || 1 };
  if (!fields.name) { $('book-error').textContent = 'Enter the book number or name.'; return; }
  try {
    L.parseLeaf(fields.startLeaf);
    if (bookDialogMode === 'new') {
      const b = mutate('new book', () => L.createBook(state, fields));
      toast(`${title(b)} ready — first leaf ${b.startLeaf}.`);
    } else {
      mutate('edit book', () => L.updateBook(state, activeBook().id, fields));
    }
    $('book-dialog').close();
  } catch (e) { $('book-error').textContent = e.message; }
});
$('book-cancel').addEventListener('click', () => $('book-dialog').close());
$('book-delete').addEventListener('click', () => {
  const b = activeBook();
  if (!window.confirm(`Delete ${title(b)} with ${b.entries.length} leaves (${formatINR(L.bookTotal(b))})?`)) return;
  mutate(`delete ${title(b)}`, () => L.deleteBook(state, b.id));
  $('book-dialog').close();
  toast('Book deleted — tap Undo to restore.');
});

// ---------------- next-leaf dialog ----------------
$('btn-next-leaf').addEventListener('click', () => {
  $('leaf-error').textContent = '';
  $('leaf-input').value = String(L.nextLeafFor(activeBook()));
  $('leaf-dialog').showModal();
  setTimeout(() => $('leaf-input').select && $('leaf-input').select(), 50);
});
$('leaf-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  try {
    const leaf = L.parseLeaf($('leaf-input').value);
    if (!leaf) { $('leaf-error').textContent = 'Enter a leaf number.'; return; }
    mutate(`next leaf ${leaf}`, () => L.setNextLeaf(state, activeBook().id, leaf));
    $('leaf-dialog').close();
  } catch (e) { $('leaf-error').textContent = e.message; }
});
$('leaf-auto').addEventListener('click', () => { mutate('automatic leaf', () => L.setNextLeaf(state, activeBook().id, null)); $('leaf-dialog').close(); });
$('leaf-cancel').addEventListener('click', () => $('leaf-dialog').close());

// ---------------- downloads ----------------
function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const stamp = () => new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-').slice(0, 16);

// ---------------- events ----------------
$('btn-listen').addEventListener('click', () => { if (speech.wanted) { speech.stop(); readBack.cancel(); } else startListening(); });
$('btn-retry').addEventListener('click', () => { micChecked = false; startListening(); });
$('btn-undo').addEventListener('click', doUndo);
$('btn-new-book').addEventListener('click', () => openBookDialog('new'));
$('btn-book-edit').addEventListener('click', () => openBookDialog('edit'));
$('book-select').addEventListener('change', (ev) => {
  L.switchBook(state, ev.target.value);
  commit();
  toast(`Now entering into ${title(activeBook())}.`);
});

for (const b of document.querySelectorAll('[data-lang]')) {
  b.addEventListener('click', () => setLang(b.dataset.lang));
}
for (const b of document.querySelectorAll('[data-view]')) {
  b.addEventListener('click', () => { state.settings.view = b.dataset.view; persist(); render(); });
}
function setLang(lang) {
  state.settings.lang = lang;
  speech.setLang(lang);
  persist();
  renderSettings();
  toast(lang === 'ml-IN' ? 'Listening in Malayalam (English numbers also understood).' : `Listening in ${lang === 'en-US' ? 'English (US)' : 'English (India)'}.`);
}
$('btn-readback').addEventListener('click', () => {
  state.settings.readBack = state.settings.readBack === 'off' ? 'both' : 'off';
  if (state.settings.readBack === 'off') readBack.cancel();
  persist(); renderSettings();
  if (state.settings.readBack !== 'off' && !readBack.supported) toast('Read-back is not supported in this browser.');
});

$('manual-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const parsed = parseMoneyInput($('manual-amount').value);
  if (!parsed.ok) { $('manual-error').textContent = parsed.error; return; }
  let leaf;
  try { leaf = L.parseLeaf($('manual-leaf').value); } catch (e) { $('manual-error').textContent = e.message; return; }
  $('manual-error').textContent = '';
  const book = activeBook();
  const entry = mutate(formatINR(parsed.paise), () => L.addEntry(state, book.id, { paise: parsed.paise, source: 'manual', leaf: leaf ?? undefined, remarks: $('manual-remarks').value }));
  justAddedIds = new Set([entry.id]);
  render();
  const total = L.bookTotal(book);
  showFlash('ok', `+ ${formatINR(entry.paise)}`, `Leaf ${entry.leaf} · Total ${formatINR(total)}`);
  speakAdded(entry.paise, total);
  $('manual-amount').value = '';
  $('manual-leaf').value = '';
  $('manual-remarks').value = '';
  $('manual-amount').focus();
});

$('lang-select').addEventListener('change', (ev) => setLang(ev.target.value));
$('mode-select').addEventListener('change', (ev) => { state.settings.mode = ev.target.value; speech.setMode(state.settings.mode); persist(); });
$('theme-select').addEventListener('change', (ev) => { state.settings.theme = ev.target.value; applyTheme(); persist(); });
$('readback-select').addEventListener('change', (ev) => { state.settings.readBack = ev.target.value; if (ev.target.value === 'off') readBack.cancel(); persist(); renderSettings(); });
$('fast-multi').addEventListener('change', (ev) => { state.settings.fastMulti = ev.target.checked; persist(); });
$('confirm-ml').addEventListener('change', (ev) => { state.settings.confirmMalayalam = ev.target.checked; persist(); });

$('btn-export-book').addEventListener('click', () => {
  const b = activeBook();
  download(`audit_${fileSafe(b.kind)}_${fileSafe(b.name)}_${stamp()}.csv`, booksToCSV([b]), 'text/csv;charset=utf-8');
});
$('btn-export-all').addEventListener('click', () => download(`audit_all_books_${stamp()}.csv`, allBooksCSV(state), 'text/csv;charset=utf-8'));
$('btn-backup').addEventListener('click', () => download(`voice-audit-backup_${stamp()}.json`, makeBackup(state), 'application/json'));
$('btn-restore').addEventListener('click', () => $('restore-file').click());
$('restore-file').addEventListener('change', async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  if (file.size > MAX_BACKUP_BYTES) { toast('Backup file is too large.'); return; }
  try {
    const restored = parseBackup(await file.text());
    const n = restored.books.reduce((s, b) => s + b.entries.length, 0);
    if (!window.confirm(`Replace ALL current data with the backup (${restored.books.length} books, ${n} leaves)?`)) return;
    if (speech.wanted) speech.stop();
    history.record('restore backup', state);
    state = restored;
    speech.setLang(state.settings.lang);
    speech.setMode(state.settings.mode);
    applyTheme();
    commit();
    toast('Backup restored.');
  } catch (e) { window.alert(`Restore failed: ${e.message}`); }
});
$('btn-wipe').addEventListener('click', () => {
  if (!window.confirm('Delete ALL books and leaves from this phone? Export first if you need them.')) return;
  if (!window.confirm('Are you sure? This cannot be undone.')) return;
  if (speech.wanted) speech.stop();
  wipeAll();
  history.clear();
  state = L.createInitialState();
  storageError = null;
  commit();
  applyTheme();
  toast('All data deleted.');
});
$('btn-diag-refresh').addEventListener('click', renderDiagnostics);
document.querySelector('details.diagnostics').addEventListener('toggle', renderDiagnostics);

document.addEventListener('visibilitychange', () => {
  if (document.hidden && speech.wanted) {
    speech.stop();
    readBack.cancel();
    pausedInBackground = true;
  } else if (!document.hidden && pausedInBackground) {
    pausedInBackground = false;
    handleStatus({ state: STATES.OFF, code: 'paused', message: 'Paused while the app was in the background. Tap Start to continue.', canRetry: false });
  }
});
window.addEventListener('online', renderOffline);
window.addEventListener('offline', renderOffline);
window.addEventListener('storage', (ev) => {
  if (ev.key && ev.key.startsWith('voice-audit-calculator')) toast('Data was changed in another tab — reload this page before continuing.');
});

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

async function renderDiagnostics() {
  let perm = 'unknown';
  try {
    if (navigator.permissions && navigator.permissions.query) perm = (await navigator.permissions.query({ name: 'microphone' })).state;
  } catch { perm = 'cannot be checked in this browser'; }
  const rows = [
    ['Page address', `${location.protocol}//${location.host}`, env.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1'],
    ['Secure context', env.secure ? 'Yes' : 'No — microphone blocked', env.secure],
    ['Speech API', env.speech, !!Recognition],
    ['Mic permission (this site)', perm, perm === 'granted' ? true : perm === 'denied' ? false : null],
    ['Read-back voice', readBack.supported ? 'Available' : 'Not available', readBack.supported],
    ['Internet', navigator.onLine ? 'Online' : 'Offline', navigator.onLine],
    ['In-app browser', env.webview ? 'Yes — open in Chrome' : 'No', !env.webview],
    ['Recognition language', state.settings.lang, null],
    ['Mic state', speech.state, null],
    ['Browser', navigator.userAgent, null],
  ];
  $('diag').replaceChildren(...rows.flatMap(([k, v, good]) => [
    el('dt', { text: k }),
    el('dd', { class: good === true ? 'good' : good === false ? 'bad' : '', text: v }),
  ]));
}

// ---------------- boot ----------------
applyTheme();
renderEnvBanner();
renderStorageBanner();
renderOffline();
render();
handleStatus({ state: STATES.OFF, code: 'off', message: Recognition ? MESSAGES.off : MESSAGES.unsupported, canRetry: false });
if (!Recognition) $('btn-listen').disabled = true;
$('app-version').textContent = `v${APP_VERSION}`;
$('app-root').hidden = false;
document.body.classList.add('app-ready');
requestPersistentStorage();
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* offline cache is optional */ });
}
