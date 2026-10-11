// app.js — user interface glue. All user-supplied text is inserted with
// textContent (never innerHTML) so transcripts/remarks/imports cannot inject markup.

import { formatINR, parseMoneyInput, paiseToInput } from './money.js';
import { parseAmount } from './parser.js';
import * as L from './ledger.js';
import { booksToCSV, allBooksCSV, makeBackup, parseBackup, fileSafe, MAX_BACKUP_BYTES } from './exporter.js';
import { loadState, saveState, wipeAll, requestPersistentStorage } from './storage.js';
import { SpeechController, getRecognitionCtor, STATES, MESSAGES } from './speech.js';

export const APP_VERSION = '1.0.0';
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
let justAddedId = null;

function persist() {
  const err = saveState(state);
  storageError = err || (storageError && storageError.startsWith('Saved data could not') ? storageError : null);
  renderStorageBanner();
}
function commit() { persist(); render(); }
const activeBook = () => L.getActiveBook(state);

// ---------------- environment checks ----------------
const Recognition = getRecognitionCtor(window);
const env = {
  protocol: location.protocol,
  secure: window.isSecureContext === true,
  speech: window.SpeechRecognition ? 'SpeechRecognition' : window.webkitSpeechRecognition ? 'webkitSpeechRecognition (Chrome)' : 'Not available',
  webview: /; wv\)/.test(navigator.userAgent),
};

function renderEnvBanner() {
  const b = $('env-banner');
  b.replaceChildren();
  let title = null; const lines = [];
  if (env.protocol === 'content:' || env.protocol === 'file:') {
    title = `This page was opened as a local file (${env.protocol}//). The microphone cannot work here.`;
    lines.push('Chrome only grants microphone access to real websites (https://). A file opened from Files, Downloads or WhatsApp has no website origin, so Chrome reports “permission denied” even when the microphone is allowed in Chrome settings.');
    lines.push('Fix: publish the app (GitHub Pages or Netlify — see README) and open its https:// address in Chrome.');
  } else if (!env.secure) {
    title = 'This page is not secure (http://). The microphone is blocked.';
    lines.push('Open the https:// address of the app instead. (http://localhost works only on the same computer.)');
  } else if (!Recognition) {
    title = 'Voice input is not available in this browser.';
    lines.push(env.webview
      ? 'You seem to be inside an in-app browser (e.g. opened from WhatsApp or Gmail). Use ⋮ → “Open in Chrome”.'
      : 'Open this page in Google Chrome on Android (or desktop Chrome/Edge). Manual entry works everywhere.');
  }
  if (!title) { b.hidden = true; return; }
  b.append(el('strong', { text: title }), ...lines.map((t) => el('div', { text: t })));
  b.hidden = false;
}

function renderStorageBanner() {
  const b = $('storage-banner');
  b.textContent = storageError || '';
  b.hidden = !storageError;
}

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
    if (text) { live.textContent = text; live.classList.add('interim'); }
    else live.classList.remove('interim');
  },
  onFinal: handleFinal,
});

function handleStatus(s) {
  const dot = $('status-dot');
  const btn = $('btn-listen');
  const actual = s.state; // what the microphone is really doing
  dot.dataset.state = actual;
  $('status-text').textContent = s.message;
  btn.dataset.state = actual;
  btn.setAttribute('aria-pressed', String(speech.wanted));
  $('listen-label').textContent = speech.wanted ? 'Stop Listening' : 'Start Listening';
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

/** Trigger Chrome's permission prompt once, then release the mic so speech recognition can use it. */
async function ensureMicPermission() {
  if (micChecked) return 'ok';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return 'ok';
  setStatusOnly(STATES.STARTING, 'Requesting microphone access…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    micChecked = true;
    await new Promise((r) => setTimeout(r, 200)); // let Android release the mic
    return 'ok';
  } catch (err) {
    const n = err && err.name;
    if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'denied';
    if (n === 'NotFoundError' || n === 'NotReadableError' || n === 'OverconstrainedError') return 'no-mic';
    return 'ok'; // unknown: let speech recognition try and report its own error
  }
}

function setStatusOnly(state_, message, canRetry = false) {
  handleStatus({ state: state_, code: 'custom', message, canRetry });
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

function handleFinal(r) {
  const live = $('live-text');
  live.textContent = r.transcript;
  live.classList.remove('interim');
  const book = activeBook();
  const parsed = parseAmount(r.transcript);

  if (parsed.status === 'command') {
    if (parsed.command === 'undo') doUndo();
    if (parsed.command === 'stop') speech.stop();
    return;
  }
  if (parsed.status === 'invalid') {
    showFlash('err', 'Could not understand the amount', parsed.reasons[0] || '');
    vibrate([30, 60, 30]);
    return;
  }

  const reasons = [...parsed.reasons];
  let amounts = parsed.status === 'multiple' ? parsed.amounts : [parsed.paise];
  let kind = parsed.status === 'multiple' ? 'multiple' : 'confirm';

  if (parsed.status !== 'multiple') {
    // Do other recognition alternatives disagree on the value (e.g. "fifteen" vs "fifty")?
    const others = new Set();
    for (const alt of r.alternatives.slice(1)) {
      const p = parseAmount(alt.transcript);
      if ((p.status === 'ok' || p.status === 'confirm') && p.paise !== parsed.paise) others.add(p.paise);
    }
    if (others.size) {
      amounts = [parsed.paise, ...others].slice(0, 4);
      reasons.push(`Recognition was unsure between ${amounts.map((a) => formatINR(a)).join(' / ')}.`);
    }
    if (r.confidence > 0 && r.confidence < LOW_CONFIDENCE) reasons.push('Low recognition confidence.');
  }
  if (r.possibleDuplicate) reasons.push('Same phrase heard twice in quick succession — possible duplicate.');

  if (parsed.status === 'ok' && reasons.length === 0) {
    const entry = L.addEntry(state, book.id, { paise: parsed.paise, source: 'voice', transcript: r.transcript, reference: parsed.reference || '' });
    justAddedId = entry.id;
    commit();
    showFlash('ok', `+ ${formatINR(entry.paise)}`, `Total ${formatINR(L.bookTotal(book))}`);
    vibrate(35);
    return;
  }
  L.addPending(state, { bookId: book.id, kind, transcript: r.transcript, amounts, reference: parsed.reference || '', reasons });
  commit();
  showFlash('warn', 'Awaiting confirmation', reasons[0] || '');
  vibrate([30, 80, 30]);
}

function doUndo() {
  const book = activeBook();
  const removed = L.undoLast(state, book.id);
  if (!removed) { toast('Nothing to undo in this book.'); return; }
  commit();
  showFlash('warn', `Removed ${formatINR(removed.paise)}`, `Total ${formatINR(L.bookTotal(book))}`);
  toast(`Undone: ${formatINR(removed.paise)}`);
}

// ---------------- feedback ----------------
let flashTimer = null;
function showFlash(kind, main, sub) {
  const box = $('last-added');
  const cls = kind === 'ok' ? 'flash' : `flash ${kind}`;
  box.replaceChildren(el('div', { class: cls }, el('span', { class: 'amt', text: main }), el('span', { text: sub })));
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => box.replaceChildren(), 6000);
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
const timeFmt = (iso) => {
  try { return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
};
const dateFmt = (ymd) => {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-');
  return `${d}-${m}-${y}`;
};

function render() {
  const book = activeBook();
  if (state.activeBookId !== book.id) state.activeBookId = book.id;
  let bookTotal, grand;
  try { bookTotal = L.bookTotal(book); grand = L.grandTotal(state); }
  catch (e) { storageError = e.message; renderStorageBanner(); return; }

  // book selector
  const sel = $('book-select');
  sel.replaceChildren(...state.books.map((b) => el('option', { value: b.id, text: `${b.name} (${b.entries.length})` })));
  sel.value = book.id;

  $('book-name').textContent = book.name;
  $('book-date').textContent = book.auditDate ? `Audit date: ${dateFmt(book.auditDate)}` : 'No audit date set';
  $('book-total').textContent = formatINR(bookTotal);
  $('topbar-total').textContent = formatINR(bookTotal);
  $('book-count').textContent = `${book.entries.length} ${book.entries.length === 1 ? 'entry' : 'entries'}`;
  $('grand-total').textContent = formatINR(grand);
  $('btn-undo').disabled = book.entries.length === 0;
  $('btn-clear-book').disabled = book.entries.length === 0;
  $('history-total').textContent = formatINR(bookTotal);
  $('empty-hint').hidden = book.entries.length > 0;

  // entries
  const list = $('entry-list');
  list.replaceChildren(...book.entries.map((e, i) => renderEntry(book, e, i)));
  if (justAddedId) {
    const node = list.querySelector(`[data-id="${CSS.escape(justAddedId)}"]`);
    if (node) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    justAddedId = null;
  }

  renderPending();

  // all books
  $('books-body').replaceChildren(...L.summary(state).map((s) =>
    el('tr', { class: s.id === book.id ? 'active' : '', onclick: () => { L.switchBook(state, s.id); commit(); window.scrollTo({ top: 0, behavior: 'smooth' }); } },
      el('td', { text: s.name + (s.auditDate ? ` · ${dateFmt(s.auditDate)}` : '') }),
      el('td', { class: 'num', text: String(s.count) }),
      el('td', { class: 'num', text: formatINR(s.total) }))));
  $('books-count-all').textContent = String(state.books.reduce((n, b) => n + b.entries.length, 0));
  $('books-grand').textContent = formatINR(grand);

  $('lang-select').value = state.settings.lang;
  $('mode-select').value = state.settings.mode;
  $('theme-select').value = state.settings.theme;
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

function renderEntry(book, e, i) {
  const metaBits = [timeFmt(e.createdAt)];
  if (e.transcript) metaBits.push(`“${e.transcript}”`);
  if (e.remarks) metaBits.push(e.remarks);
  if (e.originalPaise !== null && e.originalPaise !== undefined) metaBits.push(`was ${formatINR(e.originalPaise)}`);
  return el('li', { class: 'entry' + (e.id === justAddedId ? ' just-added' : ''), 'data-id': e.id },
    el('div', { class: 'left' },
      el('div', { class: 'line1' },
        el('span', { class: 'sl', text: `${i + 1}.` }),
        el('span', { class: 'amount', text: formatINR(e.paise) }),
        e.reference ? el('span', { class: 'badge badge-manual', text: `Ref ${e.reference}` }) : null,
        el('span', { class: `badge ${e.source === 'voice' ? 'badge-voice' : 'badge-manual'}`, text: e.source === 'voice' ? 'Voice' : 'Manual' }),
        e.originalPaise !== null && e.originalPaise !== undefined ? el('span', { class: 'badge badge-edited', text: 'Edited' }) : null),
      el('div', { class: 'meta', text: metaBits.filter(Boolean).join(' · ') })),
    el('div', { class: 'acts' },
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Edit entry ${i + 1}`, onclick: () => openEntryDialog({ mode: 'edit', bookId: book.id, entryId: e.id }) }, icon(ICON_EDIT)),
      el('button', { type: 'button', class: 'icon-btn del', 'aria-label': `Delete entry ${i + 1}`, onclick: () => confirmDeleteEntry(book.id, e.id) }, icon(ICON_DEL))));
}

function confirmDeleteEntry(bookId, entryId) {
  const book = L.getBook(state, bookId);
  const idx = book.entries.findIndex((x) => x.id === entryId);
  if (idx < 0) return;
  const e = book.entries[idx];
  if (!window.confirm(`Delete entry ${idx + 1} (${formatINR(e.paise)}) from “${book.name}”?`)) return;
  L.deleteEntry(state, bookId, entryId);
  commit();
  toast(`Deleted ${formatINR(e.paise)}. New total ${formatINR(L.bookTotal(book))}`);
}

function renderPending() {
  const items = state.pending;
  $('pending-section').hidden = items.length === 0;
  $('pending-count').textContent = String(items.length);
  $('pending-list').replaceChildren(...items.map((p) => {
    const book = state.books.find((b) => b.id === p.bookId);
    const actions = [];
    if (p.kind === 'multiple' && p.amounts.length > 1) {
      actions.push(el('button', { type: 'button', class: 'btn btn-primary', onclick: () => acceptPending(p.id, p.amounts) },
        `Add all ${p.amounts.length} separately`));
    }
    for (const a of p.amounts) {
      actions.push(el('button', { type: 'button', class: p.kind === 'multiple' ? 'btn btn-outline' : 'btn btn-primary', onclick: () => acceptPending(p.id, [a]) },
        `${p.kind === 'multiple' ? 'Only' : 'Add'} ${formatINR(a)}`));
    }
    actions.push(el('button', { type: 'button', class: 'btn btn-outline', onclick: () => openEntryDialog({ mode: 'pending', pendingId: p.id }) }, 'Correct…'));
    actions.push(el('button', { type: 'button', class: 'btn btn-ghost danger-text', onclick: () => { L.removePending(state, p.id); commit(); } }, 'Discard'));
    return el('li', { class: 'pending-item' },
      el('div', { class: 'heard', text: `Heard: “${p.transcript}”` }),
      p.reference ? el('div', { class: 'for-book', text: `Voucher/leaf ref: ${p.reference}` }) : null,
      book && book.id !== state.activeBookId ? el('div', { class: 'for-book', text: `For book: ${book.name}` }) : null,
      el('div', { class: 'why', text: p.reasons.join(' ') }),
      el('div', { class: 'pending-actions' }, actions));
  }));
}

function acceptPending(id, amounts, opts) {
  try {
    const added = L.acceptPending(state, id, amounts, opts);
    if (added[0]) justAddedId = added[added.length - 1].id;
    commit();
    const total = added.reduce((s, e) => s + e.paise, 0);
    showFlash('ok', `+ ${formatINR(total)}`, `${added.length} ${added.length === 1 ? 'entry' : 'entries'} added`);
  } catch (e) { toast(e.message); }
}

// ---------------- entry dialog (edit / correct pending) ----------------
let dialogCtx = null;
function openEntryDialog(ctx) {
  dialogCtx = ctx;
  const dlg = $('entry-dialog');
  $('edit-error').textContent = '';
  const meta = $('edit-meta');
  meta.replaceChildren();
  if (ctx.mode === 'edit') {
    const book = L.getBook(state, ctx.bookId);
    const idx = book.entries.findIndex((x) => x.id === ctx.entryId);
    const e = book.entries[idx];
    if (!e) return;
    $('entry-dialog-title').textContent = `Edit entry ${idx + 1}`;
    $('edit-amount').value = paiseToInput(e.paise);
    $('edit-ref').value = e.reference;
    $('edit-remarks').value = e.remarks;
    $('edit-delete').hidden = false;
    meta.append(
      el('div', { text: `Book: ${book.name} · Source: ${e.source === 'voice' ? 'Voice' : 'Manual'}` }),
      el('div', { text: `Added: ${new Date(e.createdAt).toLocaleString('en-IN')}` }),
      e.updatedAt !== e.createdAt ? el('div', { text: `Last edited: ${new Date(e.updatedAt).toLocaleString('en-IN')}` }) : null,
      e.transcript ? el('div', { text: `Heard: “${e.transcript}”` }) : null,
      e.originalPaise !== null && e.originalPaise !== undefined ? el('div', { text: `Original amount: ${formatINR(e.originalPaise)}` }) : null,
    );
  } else {
    const p = state.pending.find((x) => x.id === ctx.pendingId);
    if (!p) return;
    $('entry-dialog-title').textContent = 'Correct heard amount';
    $('edit-amount').value = p.amounts[0] ? paiseToInput(p.amounts[0]) : '';
    $('edit-ref').value = p.reference;
    $('edit-remarks').value = '';
    $('edit-delete').hidden = true;
    meta.append(el('div', { text: `Heard: “${p.transcript}”` }));
  }
  dlg.showModal();
  setTimeout(() => $('edit-amount').focus(), 50);
}

$('entry-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const parsed = parseMoneyInput($('edit-amount').value);
  if (!parsed.ok) { $('edit-error').textContent = parsed.error; return; }
  try {
    if (dialogCtx.mode === 'edit') {
      L.updateEntry(state, dialogCtx.bookId, dialogCtx.entryId, { paise: parsed.paise, reference: $('edit-ref').value, remarks: $('edit-remarks').value });
      commit();
      toast(`Saved. Book total ${formatINR(L.bookTotal(L.getBook(state, dialogCtx.bookId)))}`);
    } else {
      acceptPending(dialogCtx.pendingId, [parsed.paise], { reference: $('edit-ref').value, remarks: $('edit-remarks').value || 'Amount corrected by auditor' });
    }
    $('entry-dialog').close();
  } catch (e) { $('edit-error').textContent = e.message; }
});
$('edit-cancel').addEventListener('click', () => $('entry-dialog').close());
$('edit-delete').addEventListener('click', () => {
  if (dialogCtx && dialogCtx.mode === 'edit') {
    $('entry-dialog').close();
    confirmDeleteEntry(dialogCtx.bookId, dialogCtx.entryId);
  }
});

// ---------------- book dialog ----------------
let bookDialogMode = 'edit';
function openBookDialog(mode) {
  bookDialogMode = mode;
  const book = activeBook();
  $('book-error').textContent = '';
  if (mode === 'new') {
    $('book-dialog-title').textContent = 'New receipt book';
    $('book-name-input').value = L.suggestBookName(state);
    $('book-date-input').value = new Date().toLocaleDateString('en-CA'); // yyyy-mm-dd, local
    $('book-delete').hidden = true;
  } else {
    $('book-dialog-title').textContent = 'Rename / audit date';
    $('book-name-input').value = book.name;
    $('book-date-input').value = book.auditDate || '';
    $('book-delete').hidden = false;
  }
  $('book-dialog').showModal();
}
$('book-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const name = $('book-name-input').value.trim();
  const date = $('book-date-input').value;
  if (!name) { $('book-error').textContent = 'Enter a book name or number.'; return; }
  try {
    if (bookDialogMode === 'new') {
      L.createBook(state, { name, auditDate: date });
      toast(`Created “${name}”. New entries go here.`);
    } else {
      const b = activeBook();
      L.renameBook(state, b.id, name);
      L.setAuditDate(state, b.id, date);
    }
    commit();
    $('book-dialog').close();
  } catch (e) { $('book-error').textContent = e.message; }
});
$('book-cancel').addEventListener('click', () => $('book-dialog').close());
$('book-delete').addEventListener('click', () => {
  const b = activeBook();
  if (!window.confirm(`Delete the whole book “${b.name}” with ${b.entries.length} entries (${formatINR(L.bookTotal(b))})? This cannot be undone.`)) return;
  L.deleteBook(state, b.id);
  commit();
  $('book-dialog').close();
  toast('Book deleted.');
});

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
$('btn-listen').addEventListener('click', () => { if (speech.wanted) speech.stop(); else startListening(); });
$('btn-retry').addEventListener('click', () => { micChecked = false; startListening(); });
$('btn-undo').addEventListener('click', doUndo);
$('btn-new-book').addEventListener('click', () => openBookDialog('new'));
$('btn-book-edit').addEventListener('click', () => openBookDialog('edit'));
$('book-select').addEventListener('change', (ev) => {
  L.switchBook(state, ev.target.value);
  commit();
  toast(`Now entering into “${activeBook().name}”.`);
});
$('btn-clear-book').addEventListener('click', () => {
  const b = activeBook();
  if (!window.confirm(`Remove all ${b.entries.length} entries (${formatINR(L.bookTotal(b))}) from “${b.name}”? Consider exporting first.`)) return;
  L.clearBook(state, b.id);
  commit();
  toast('Book cleared.');
});

$('manual-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const parsed = parseMoneyInput($('manual-amount').value);
  if (!parsed.ok) { $('manual-error').textContent = parsed.error; return; }
  $('manual-error').textContent = '';
  const book = activeBook();
  const entry = L.addEntry(state, book.id, { paise: parsed.paise, source: 'manual', reference: $('manual-ref').value, remarks: $('manual-remarks').value });
  justAddedId = entry.id;
  commit();
  showFlash('ok', `+ ${formatINR(entry.paise)}`, `Total ${formatINR(L.bookTotal(book))}`);
  $('manual-amount').value = '';
  $('manual-ref').value = '';
  $('manual-remarks').value = '';
  $('manual-amount').focus();
});

$('lang-select').addEventListener('change', (ev) => {
  state.settings.lang = ev.target.value;
  speech.setLang(state.settings.lang);
  persist();
  if (state.settings.lang === 'ml-IN') toast('Malayalam: amounts in Malayalam words always ask for confirmation.');
});
$('mode-select').addEventListener('change', (ev) => { state.settings.mode = ev.target.value; speech.setMode(state.settings.mode); persist(); });
$('theme-select').addEventListener('change', (ev) => { state.settings.theme = ev.target.value; applyTheme(); persist(); });

$('btn-export-book').addEventListener('click', () => {
  const b = activeBook();
  download(`audit_${fileSafe(b.name)}_${stamp()}.csv`, booksToCSV([b]), 'text/csv;charset=utf-8');
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
    if (!window.confirm(`Replace ALL current data on this phone with the backup (${restored.books.length} books, ${n} entries)? Current data will be lost unless you downloaded a backup.`)) return;
    if (speech.wanted) speech.stop();
    state = restored;
    speech.setLang(state.settings.lang);
    speech.setMode(state.settings.mode);
    applyTheme();
    commit();
    toast('Backup restored.');
  } catch (e) { window.alert(`Restore failed: ${e.message}`); }
});
$('btn-wipe').addEventListener('click', () => {
  if (!window.confirm('Delete ALL receipt books and entries from this phone? Export first if you need them.')) return;
  if (!window.confirm('Are you sure? This cannot be undone.')) return;
  if (speech.wanted) speech.stop();
  wipeAll();
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
    speech.stop(); // Chrome stops the mic in the background anyway; make that explicit
    pausedInBackground = true;
  } else if (!document.hidden && pausedInBackground) {
    pausedInBackground = false;
    handleStatus({ state: STATES.OFF, code: 'paused', message: 'Listening paused while the app was in the background. Tap Start Listening to continue.', canRetry: false });
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
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', '#0f4c35');
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
