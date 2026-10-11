// ledger.js — receipt books and entries. Pure data logic, no DOM.
// Totals are ALWAYS recomputed from the stored entries (never a running counter),
// so editing or deleting any entry immediately yields correct totals.

import { assertPaise, sumPaise, MAX_ENTRY_PAISE } from './money.js';

export const SCHEMA_VERSION = 1;
export const ENTRY_SOURCES = ['voice', 'manual'];

export function newId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const nowIso = () => new Date().toISOString();

function cleanText(value, max = 500) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
}

function checkAmount(paise) {
  assertPaise(paise);
  if (paise === 0) throw new RangeError('Amount must be greater than zero.');
  if (paise > MAX_ENTRY_PAISE) throw new RangeError('Amount exceeds the ₹10,000 crore limit.');
  return paise;
}

export function createInitialState() {
  const state = {
    schemaVersion: SCHEMA_VERSION,
    books: [],
    activeBookId: null,
    pending: [],
    settings: { lang: 'en-IN', mode: 'phrase', theme: 'system' },
  };
  createBook(state, { name: 'Receipt Book 1' });
  return state;
}

export function getBook(state, bookId) {
  const book = state.books.find((b) => b.id === bookId);
  if (!book) throw new Error('Receipt book not found.');
  return book;
}

export function getActiveBook(state) {
  return state.books.find((b) => b.id === state.activeBookId) || state.books[0] || null;
}

export function suggestBookName(state) {
  let n = state.books.length + 1;
  const names = new Set(state.books.map((b) => b.name.toLowerCase()));
  while (names.has(`receipt book ${n}`)) n++;
  return `Receipt Book ${n}`;
}

export function createBook(state, { name, auditDate = '' } = {}) {
  const book = {
    id: newId(),
    name: cleanText(name, 80) || suggestBookName(state),
    auditDate: /^\d{4}-\d{2}-\d{2}$/.test(auditDate) ? auditDate : '',
    createdAt: nowIso(),
    entries: [],
  };
  state.books.push(book);
  state.activeBookId = book.id;
  return book;
}

export function renameBook(state, bookId, name) {
  const clean = cleanText(name, 80);
  if (!clean) throw new Error('Book name cannot be empty.');
  getBook(state, bookId).name = clean;
}

export function setAuditDate(state, bookId, auditDate) {
  if (auditDate && !/^\d{4}-\d{2}-\d{2}$/.test(auditDate)) throw new Error('Invalid date.');
  getBook(state, bookId).auditDate = auditDate || '';
}

export function switchBook(state, bookId) {
  getBook(state, bookId);
  state.activeBookId = bookId;
}

export function deleteBook(state, bookId) {
  const idx = state.books.findIndex((b) => b.id === bookId);
  if (idx < 0) throw new Error('Receipt book not found.');
  state.books.splice(idx, 1);
  state.pending = state.pending.filter((p) => p.bookId !== bookId);
  if (state.books.length === 0) createBook(state, { name: 'Receipt Book 1' });
  if (!state.books.some((b) => b.id === state.activeBookId)) state.activeBookId = state.books[0].id;
}

export function addEntry(state, bookId, { paise, source = 'manual', transcript = '', reference = '', remarks = '' }) {
  if (!ENTRY_SOURCES.includes(source)) throw new Error('Invalid entry source.');
  const book = getBook(state, bookId);
  const t = nowIso();
  const entry = {
    id: newId(),
    paise: checkAmount(paise),
    source,
    transcript: cleanText(transcript, 300),
    reference: cleanText(reference, 40),
    remarks: cleanText(remarks, 300),
    createdAt: t,
    updatedAt: t,
    originalPaise: null, // set when an amount is edited, for the audit trail
  };
  book.entries.push(entry);
  return entry;
}

export function updateEntry(state, bookId, entryId, changes) {
  const book = getBook(state, bookId);
  const entry = book.entries.find((e) => e.id === entryId);
  if (!entry) throw new Error('Entry not found.');
  if ('paise' in changes && changes.paise !== entry.paise) {
    checkAmount(changes.paise);
    if (entry.originalPaise === null) entry.originalPaise = entry.paise;
    entry.paise = changes.paise;
  }
  if ('reference' in changes) entry.reference = cleanText(changes.reference, 40);
  if ('remarks' in changes) entry.remarks = cleanText(changes.remarks, 300);
  entry.updatedAt = nowIso();
  return entry;
}

export function deleteEntry(state, bookId, entryId) {
  const book = getBook(state, bookId);
  const idx = book.entries.findIndex((e) => e.id === entryId);
  if (idx < 0) throw new Error('Entry not found.');
  return book.entries.splice(idx, 1)[0];
}

/** Remove the most recently added entry of a book. Returns it, or null if empty. */
export function undoLast(state, bookId) {
  const book = getBook(state, bookId);
  return book.entries.length ? book.entries.pop() : null;
}

export function clearBook(state, bookId) {
  const book = getBook(state, bookId);
  const removed = book.entries.length;
  book.entries = [];
  return removed;
}

export function bookTotal(book) {
  return sumPaise(book.entries.map((e) => e.paise));
}

export function grandTotal(state) {
  return sumPaise(state.books.map(bookTotal));
}

export function summary(state) {
  return state.books.map((b) => ({ id: b.id, name: b.name, auditDate: b.auditDate, count: b.entries.length, total: bookTotal(b) }));
}

// ---------- pending (uncertain) voice results ----------
export function addPending(state, item) {
  const p = {
    id: newId(),
    bookId: item.bookId,
    kind: item.kind === 'multiple' ? 'multiple' : 'confirm',
    transcript: cleanText(item.transcript, 300),
    amounts: (item.amounts || []).filter((a) => Number.isSafeInteger(a) && a > 0 && a <= MAX_ENTRY_PAISE),
    reference: cleanText(item.reference || '', 40),
    reasons: (item.reasons || []).map((r) => cleanText(r, 200)).slice(0, 5),
    createdAt: nowIso(),
  };
  state.pending.push(p);
  if (state.pending.length > 50) state.pending.splice(0, state.pending.length - 50);
  return p;
}

export function removePending(state, pendingId) {
  state.pending = state.pending.filter((p) => p.id !== pendingId);
}

/** Accept a pending item: add one entry per chosen amount to its own book. */
export function acceptPending(state, pendingId, amounts, { reference, remarks = '' } = {}) {
  const p = state.pending.find((x) => x.id === pendingId);
  if (!p) throw new Error('Pending item not found.');
  if (!Array.isArray(amounts) || amounts.length === 0) throw new Error('Choose an amount.');
  const book = state.books.find((b) => b.id === p.bookId) ? p.bookId : state.activeBookId;
  const added = amounts.map((paise, i) =>
    addEntry(state, book, { paise, source: 'voice', transcript: p.transcript, reference: i === 0 ? (reference ?? p.reference) : '', remarks }),
  );
  removePending(state, pendingId);
  return added;
}
