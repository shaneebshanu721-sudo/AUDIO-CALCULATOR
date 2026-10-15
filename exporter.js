// exporter.js — CSV export, JSON backup and strict backup validation.
// Imported files are treated purely as data: parsed with JSON.parse, rebuilt
// field-by-field into fresh objects (unknown keys dropped), never executed.

import { paiseToPlain, MAX_ENTRY_PAISE } from './money.js';
import { bookTotal, grandTotal, runningTotals, bookTitle, SCHEMA_VERSION, ENTRY_SOURCES, BOOK_KINDS, MAX_LEAF, defaultSettings } from './ledger.js';

export const BACKUP_APP_ID = 'voice-audit-calculator';
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;

/** Escape one CSV cell; neutralise spreadsheet formula injection in text cells. */
export function csvCell(value, { text = true } = {}) {
  let s = String(value ?? '');
  if (text && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const HEADER = ['Book Type', 'Book No.', 'Audit Date', 'Leaf No.', 'Amount (INR)', 'Running Total (INR)', 'Source', 'Voucher Ref', 'Speech Transcript', 'Remarks', 'Added At', 'Last Edited At', 'Original Amount (if edited)'];

function rowsForBook(book) {
  const run = runningTotals(book);
  const rows = book.entries.map((e, i) => [
    csvCell(book.kind), csvCell(book.name), csvCell(book.auditDate), String(e.leaf ?? ''),
    paiseToPlain(e.paise), paiseToPlain(run[i]), e.source === 'voice' ? 'Voice' : 'Manual', csvCell(e.reference),
    csvCell(e.transcript), csvCell(e.remarks), csvCell(e.createdAt), csvCell(e.updatedAt !== e.createdAt ? e.updatedAt : ''),
    e.originalPaise !== null && e.originalPaise !== undefined ? paiseToPlain(e.originalPaise) : '',
  ]);
  rows.push([csvCell(book.kind), csvCell(book.name), csvCell(book.auditDate), 'BOOK TOTAL', paiseToPlain(bookTotal(book)), '', '', '', csvCell(`${book.entries.length} leaves`), '', '', '', '']);
  return rows;
}

/** CSV for one or more books. A grand-total row is added when grandTotalPaise is given. */
export function booksToCSV(books, { grandTotalPaise = null } = {}) {
  const lines = [HEADER.map((h) => csvCell(h)).join(',')];
  for (const b of books) for (const r of rowsForBook(b)) lines.push(r.join(','));
  if (grandTotalPaise !== null) {
    const count = books.reduce((n, b) => n + b.entries.length, 0);
    lines.push(['ALL BOOKS', '', '', 'GRAND TOTAL', paiseToPlain(grandTotalPaise), '', '', '', csvCell(`${count} leaves in ${books.length} books`), '', '', '', ''].join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n'; // BOM: Excel opens UTF-8 (₹, Malayalam) correctly
}

export function allBooksCSV(state) {
  return booksToCSV(state.books, { grandTotalPaise: grandTotal(state) });
}

export function makeBackup(state) {
  return JSON.stringify({ app: BACKUP_APP_ID, schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), data: state }, null, 2);
}

// ---------- validation ----------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function str(v, max, field) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new Error(`${field} must be text.`);
  return v.replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, max);
}
function id(v, field) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new Error(`${field} is not a valid id.`);
  return v;
}
function amount(v, field, allowNull = false) {
  if (allowNull && (v === null || v === undefined)) return null;
  if (!Number.isSafeInteger(v) || v <= 0 || v > MAX_ENTRY_PAISE) throw new Error(`${field} is not a valid amount.`);
  return v;
}
function leafNum(v, field, allowNull = false) {
  if (allowNull && (v === null || v === undefined)) return null;
  if (!Number.isSafeInteger(v) || v < 1 || v > MAX_LEAF) throw new Error(`${field} is not a valid leaf number.`);
  return v;
}
function iso(v, field) {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new Error(`${field} is not a valid date/time.`);
  return v.slice(0, 40);
}

/** Upgrade older saved data to the current schema (v1 had no leaf numbers / book types). */
function migrate(data) {
  if (data.schemaVersion === 1 && Array.isArray(data.books)) {
    return {
      ...data,
      schemaVersion: 2,
      books: data.books.map((b) => (isObj(b) ? {
        ...b,
        kind: 'Other',
        startLeaf: 1,
        nextLeaf: null,
        entries: Array.isArray(b.entries) ? b.entries.map((e, i) => (isObj(e) ? { ...e, leaf: i + 1 } : e)) : b.entries,
      } : b)),
    };
  }
  return data;
}

/** Validate and rebuild an application state object. Throws with a readable message. */
export function validateState(input) {
  if (!isObj(input)) throw new Error('Backup data is missing.');
  const data = migrate(input);
  if (data.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported backup version: ${data.schemaVersion}.`);
  if (!Array.isArray(data.books) || data.books.length === 0) throw new Error('Backup has no books.');
  if (data.books.length > 2000) throw new Error('Backup has too many books.');
  const seen = new Set();
  const books = data.books.map((b, bi) => {
    if (!isObj(b)) throw new Error(`Book ${bi + 1} is malformed.`);
    const bookId = id(b.id, `Book ${bi + 1} id`);
    if (seen.has(bookId)) throw new Error('Duplicate book id.');
    seen.add(bookId);
    if (!Array.isArray(b.entries)) throw new Error(`Book ${bi + 1} has no entry list.`);
    if (b.entries.length > 100000) throw new Error(`Book ${bi + 1} has too many entries.`);
    const auditDate = str(b.auditDate, 10, 'Audit date');
    if (auditDate && !/^\d{4}-\d{2}-\d{2}$/.test(auditDate)) throw new Error(`Book ${bi + 1} audit date is invalid.`);
    const name = str(b.name, 80, 'Book name').trim();
    if (!name) throw new Error(`Book ${bi + 1} has no name.`);
    if (!BOOK_KINDS.includes(b.kind)) throw new Error(`Book ${bi + 1} has an unknown type.`);
    return {
      id: bookId, kind: b.kind, name, auditDate,
      startLeaf: leafNum(b.startLeaf, `Book ${bi + 1} starting leaf`),
      nextLeaf: leafNum(b.nextLeaf, `Book ${bi + 1} next leaf`, true),
      createdAt: iso(b.createdAt, 'Book created time'),
      entries: b.entries.map((e, ei) => {
        const where = `Book ${bi + 1}, entry ${ei + 1}`;
        if (!isObj(e)) throw new Error(`${where} is malformed.`);
        if (!ENTRY_SOURCES.includes(e.source)) throw new Error(`${where} has an invalid source.`);
        const entryId = id(e.id, `${where} id`);
        if (seen.has(entryId)) throw new Error('Duplicate entry id.');
        seen.add(entryId);
        return {
          id: entryId, leaf: leafNum(e.leaf, `${where} leaf`), paise: amount(e.paise, `${where} amount`), source: e.source,
          transcript: str(e.transcript, 300, 'Transcript'), reference: str(e.reference, 40, 'Reference'),
          remarks: str(e.remarks, 300, 'Remarks'), createdAt: iso(e.createdAt, `${where} time`),
          updatedAt: iso(e.updatedAt, `${where} edit time`), originalPaise: amount(e.originalPaise, `${where} original amount`, true),
        };
      }),
    };
  });
  let total = 0;
  for (const b of books) for (const e of b.entries) {
    total += e.paise;
    if (!Number.isSafeInteger(total)) throw new Error('Backup totals are too large.');
  }
  const bookIds = new Set(books.map((b) => b.id));
  const pending = Array.isArray(data.pending)
    ? data.pending.filter((p) => isObj(p) && bookIds.has(p.bookId)).slice(0, 50).map((p) => ({
        id: id(p.id, 'Pending id'), bookId: p.bookId, kind: p.kind === 'multiple' ? 'multiple' : 'confirm',
        transcript: str(p.transcript, 300, 'Transcript'),
        amounts: Array.isArray(p.amounts) ? p.amounts.filter((a) => Number.isSafeInteger(a) && a > 0 && a <= MAX_ENTRY_PAISE).slice(0, 20) : [],
        reference: str(p.reference, 40, 'Reference'),
        splits: Array.isArray(p.splits) ? p.splits.filter((x) => Array.isArray(x) && x.length === 2 && x.every((a) => Number.isSafeInteger(a) && a > 0 && a <= MAX_ENTRY_PAISE)).slice(0, 3) : [],
        combined: Number.isSafeInteger(p.combined) && p.combined > 0 && p.combined <= MAX_ENTRY_PAISE ? p.combined : null,
        leaf: Number.isSafeInteger(p.leaf) && p.leaf >= 1 && p.leaf <= MAX_LEAF ? p.leaf : null,
        reasons: Array.isArray(p.reasons) ? p.reasons.filter((r) => typeof r === 'string').map((r) => r.slice(0, 200)).slice(0, 5) : [],
        createdAt: iso(p.createdAt, 'Pending time'),
      }))
    : [];
  const s = isObj(data.settings) ? data.settings : {};
  const d = defaultSettings();
  return {
    schemaVersion: SCHEMA_VERSION,
    books,
    activeBookId: bookIds.has(data.activeBookId) ? data.activeBookId : books[0].id,
    pending,
    settings: {
      lang: ['en-IN', 'ml-IN', 'en-US'].includes(s.lang) ? s.lang : d.lang,
      // Before settingsRev 3 the default was phrase-by-phrase (a beep before every amount);
      // move those users to the quieter continuous mode once.
      mode: (s.settingsRev || 0) < 3 ? 'continuous' : (['phrase', 'continuous'].includes(s.mode) ? s.mode : d.mode),
      theme: ['system', 'light', 'dark'].includes(s.theme) ? s.theme : d.theme,
      readBack: ['off', 'amount', 'total', 'both'].includes(s.readBack) ? s.readBack : d.readBack,
      confirmMalayalam: typeof s.confirmMalayalam === 'boolean' ? s.confirmMalayalam : d.confirmMalayalam,
      fastMulti: typeof s.fastMulti === 'boolean' ? s.fastMulti : d.fastMulti,
      view: ['tape', 'details'].includes(s.view) ? s.view : d.view,
      settingsRev: 3,
      autoFix: typeof s.autoFix === 'boolean' ? s.autoFix : d.autoFix,
      maxAmount: Number.isSafeInteger(s.maxAmount) && s.maxAmount >= 0 && s.maxAmount <= MAX_ENTRY_PAISE ? s.maxAmount : d.maxAmount,
    },
  };
}

/** Parse backup file text. Returns a validated state; throws a readable Error otherwise. */
export function parseBackup(text) {
  if (typeof text !== 'string') throw new Error('Backup file could not be read.');
  if (text.length > MAX_BACKUP_BYTES) throw new Error('Backup file is too large.');
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('This is not a valid JSON backup file.'); }
  if (!isObj(obj) || obj.app !== BACKUP_APP_ID) throw new Error('This file is not a Voice Audit Calculator backup.');
  return validateState(obj.data);
}

/** Safe file-name fragment. */
export function fileSafe(name) {
  return String(name).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'book';
}

export { bookTitle };
