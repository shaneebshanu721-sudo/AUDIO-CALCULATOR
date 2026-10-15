// ledger.js — receipt/voucher books, leaves (entries) and totals. Pure data logic, no DOM.
// Totals are ALWAYS recomputed from stored entries (never a running counter).
//
// Leaf numbers: every entry gets a leaf number. If the auditor does not give one,
// it is filled in automatically: the book's starting leaf for the first entry,
// then last leaf + 1. The auditor can set the next leaf at any time ("leaf 25").

import { assertPaise, sumPaise, MAX_ENTRY_PAISE } from './money.js';

export const SCHEMA_VERSION = 2;
export const ENTRY_SOURCES = ['voice', 'manual'];
export const BOOK_KINDS = ['Receipt Book', 'Voucher Book', 'Cash Book', 'Other'];
export const MAX_LEAF = 9999999;

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

/** Validate a leaf number (positive whole number). Accepts numbers or digit strings. */
export function parseLeaf(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (!/^\d{1,7}$/.test(s)) throw new RangeError('Leaf number must be a whole number (1 – 9999999).');
  const n = Number(s);
  if (n < 1 || n > MAX_LEAF) throw new RangeError('Leaf number must be between 1 and 9999999.');
  return n;
}

export function createInitialState() {
  const state = {
    schemaVersion: SCHEMA_VERSION,
    books: [],
    activeBookId: null,
    pending: [],
    settings: defaultSettings(),
  };
  createBook(state, { kind: 'Receipt Book', name: '1' });
  return state;
}

export function defaultSettings() {
  return { lang: 'en-IN', mode: 'continuous', theme: 'system', readBack: 'both', confirmMalayalam: false, fastMulti: true, view: 'tape', settingsRev: 3 };
}

/** "Receipt Book No. 1", "Voucher Book No. 12", or just the name for "Other". */
export function bookTitle(book) {
  if (book.kind === 'Other') return book.name;
  return /^[\w./-]{1,12}$/.test(book.name) ? `${book.kind} No. ${book.name}` : `${book.kind} – ${book.name}`;
}

export function getBook(state, bookId) {
  const book = state.books.find((b) => b.id === bookId);
  if (!book) throw new Error('Book not found.');
  return book;
}

export function getActiveBook(state) {
  return state.books.find((b) => b.id === state.activeBookId) || state.books[0] || null;
}

/** Next free number for a new book of this kind ("1", "2", …). */
export function suggestBookName(state, kind = 'Receipt Book') {
  const used = new Set(state.books.filter((b) => b.kind === kind).map((b) => b.name.toLowerCase()));
  let n = 1;
  while (used.has(String(n))) n++;
  return String(n);
}

export function createBook(state, { kind = 'Receipt Book', name, auditDate = '', startLeaf = 1 } = {}) {
  const k = BOOK_KINDS.includes(kind) ? kind : 'Receipt Book';
  const book = {
    id: newId(),
    kind: k,
    name: cleanText(name, 80) || suggestBookName(state, k),
    auditDate: /^\d{4}-\d{2}-\d{2}$/.test(auditDate) ? auditDate : '',
    startLeaf: parseLeaf(startLeaf) ?? 1,
    nextLeaf: null, // a manually chosen next leaf; null = automatic
    createdAt: nowIso(),
    entries: [],
  };
  state.books.push(book);
  state.activeBookId = book.id;
  return book;
}

export function updateBook(state, bookId, { kind, name, auditDate, startLeaf }) {
  const book = getBook(state, bookId);
  if (name !== undefined) {
    const clean = cleanText(name, 80);
    if (!clean) throw new Error('Book number / name cannot be empty.');
    book.name = clean;
  }
  if (kind !== undefined) {
    if (!BOOK_KINDS.includes(kind)) throw new Error('Unknown book type.');
    book.kind = kind;
  }
  if (auditDate !== undefined) {
    if (auditDate && !/^\d{4}-\d{2}-\d{2}$/.test(auditDate)) throw new Error('Invalid date.');
    book.auditDate = auditDate || '';
  }
  if (startLeaf !== undefined) book.startLeaf = parseLeaf(startLeaf) ?? 1;
  return book;
}

export function renameBook(state, bookId, name) { updateBook(state, bookId, { name }); }
export function setAuditDate(state, bookId, auditDate) { updateBook(state, bookId, { auditDate }); }

export function switchBook(state, bookId) {
  getBook(state, bookId);
  state.activeBookId = bookId;
}

export function deleteBook(state, bookId) {
  const idx = state.books.findIndex((b) => b.id === bookId);
  if (idx < 0) throw new Error('Book not found.');
  state.books.splice(idx, 1);
  state.pending = state.pending.filter((p) => p.bookId !== bookId);
  if (state.books.length === 0) createBook(state, { kind: 'Receipt Book', name: '1' });
  if (!state.books.some((b) => b.id === state.activeBookId)) state.activeBookId = state.books[0].id;
}

/** The leaf number the next entry will get automatically. */
export function nextLeafFor(book) {
  if (book.nextLeaf) return book.nextLeaf;
  const last = book.entries[book.entries.length - 1];
  if (!last) return book.startLeaf || 1;
  return Math.min((last.leaf || 0) + 1, MAX_LEAF);
}

/** Choose the next leaf number (e.g. auditor skipped cancelled leaves). null = automatic. */
export function setNextLeaf(state, bookId, leaf) {
  const book = getBook(state, bookId);
  book.nextLeaf = parseLeaf(leaf);
  return nextLeafFor(book);
}

export function addEntry(state, bookId, { paise, source = 'manual', transcript = '', reference = '', remarks = '', leaf }) {
  if (!ENTRY_SOURCES.includes(source)) throw new Error('Invalid entry source.');
  const book = getBook(state, bookId);
  const chosen = parseLeaf(leaf);
  const t = nowIso();
  const entry = {
    id: newId(),
    leaf: chosen ?? nextLeafFor(book),
    paise: checkAmount(paise),
    source,
    transcript: cleanText(transcript, 300),
    reference: cleanText(reference, 40),
    remarks: cleanText(remarks, 300),
    createdAt: t,
    updatedAt: t,
    originalPaise: null, // set when the amount is edited, for the audit trail
  };
  book.entries.push(entry);
  book.nextLeaf = null; // numbering continues from this leaf
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
  if ('leaf' in changes) entry.leaf = parseLeaf(changes.leaf) ?? entry.leaf;
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

/** Delete several entries of one book at once. Returns how many were removed. */
export function deleteEntries(state, bookId, entryIds) {
  const book = getBook(state, bookId);
  const ids = new Set(entryIds);
  const before = book.entries.length;
  book.entries = book.entries.filter((e) => !ids.has(e.id));
  return before - book.entries.length;
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
  book.nextLeaf = null;
  return removed;
}

export function bookTotal(book) {
  return sumPaise(book.entries.map((e) => e.paise));
}

/** Running totals after each entry (for the tape view and CSV). */
export function runningTotals(book) {
  let t = 0;
  return book.entries.map((e) => {
    t += e.paise;
    if (!Number.isSafeInteger(t)) throw new RangeError('Total is too large to compute safely.');
    return t;
  });
}

export function grandTotal(state) {
  return sumPaise(state.books.map(bookTotal));
}

export function summary(state) {
  return state.books.map((b) => ({ id: b.id, title: bookTitle(b), name: b.name, kind: b.kind, auditDate: b.auditDate, count: b.entries.length, total: bookTotal(b) }));
}

// ---------- pending (uncertain) voice results ----------
export function addPending(state, item) {
  const p = {
    id: newId(),
    bookId: item.bookId,
    kind: item.kind === 'multiple' ? 'multiple' : 'confirm',
    transcript: cleanText(item.transcript, 300),
    amounts: (item.amounts || []).filter((a) => Number.isSafeInteger(a) && a > 0 && a <= MAX_ENTRY_PAISE),
    combined: Number.isSafeInteger(item.combined) && item.combined > 0 && item.combined <= MAX_ENTRY_PAISE ? item.combined : null,
    reference: cleanText(item.reference || '', 40),
    leaf: (() => { try { return parseLeaf(item.leaf); } catch { return null; } })(),
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

/** Accept a pending item: add one entry per chosen amount to the book it was heard for. */
export function acceptPending(state, pendingId, amounts, { leaf, reference, remarks = '' } = {}) {
  const p = state.pending.find((x) => x.id === pendingId);
  if (!p) throw new Error('Pending item not found.');
  if (!Array.isArray(amounts) || amounts.length === 0) throw new Error('Choose an amount.');
  const bookId = state.books.find((b) => b.id === p.bookId) ? p.bookId : state.activeBookId;
  const firstLeaf = leaf !== undefined && leaf !== '' ? leaf : p.leaf;
  const added = amounts.map((paise, i) =>
    addEntry(state, bookId, {
      paise, source: 'voice', transcript: p.transcript, remarks,
      reference: i === 0 ? (reference ?? p.reference) : '',
      leaf: i === 0 ? firstLeaf : undefined,
    }),
  );
  removePending(state, pendingId);
  return added;
}
