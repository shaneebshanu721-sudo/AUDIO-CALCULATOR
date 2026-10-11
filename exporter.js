// exporter.js — CSV export, JSON backup and strict backup validation.
// Imported files are treated purely as data: parsed with JSON.parse, rebuilt
// field-by-field into fresh objects (unknown keys dropped), never executed.

import { paiseToPlain, MAX_ENTRY_PAISE } from './money.js';
import { bookTotal, grandTotal, SCHEMA_VERSION, ENTRY_SOURCES } from './ledger.js';

export const BACKUP_APP_ID = 'voice-audit-calculator';
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;

/** Escape one CSV cell; neutralise spreadsheet formula injection in text cells. */
export function csvCell(value, { text = true } = {}) {
  let s = String(value ?? '');
  if (text && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const HEADER = ['Receipt Book', 'Audit Date', 'Sl. No.', 'Voucher/Leaf Ref', 'Amount (INR)', 'Source', 'Speech Transcript', 'Remarks', 'Added At', 'Last Edited At', 'Original Amount (if edited)'];

function rowsForBook(book) {
  const rows = book.entries.map((e, i) => [
    csvCell(book.name), csvCell(book.auditDate), String(i + 1), csvCell(e.reference),
    paiseToPlain(e.paise), e.source === 'voice' ? 'Voice' : 'Manual', csvCell(e.transcript), csvCell(e.remarks),
    csvCell(e.createdAt), csvCell(e.updatedAt !== e.createdAt ? e.updatedAt : ''),
    e.originalPaise !== null && e.originalPaise !== undefined ? paiseToPlain(e.originalPaise) : '',
  ]);
  rows.push([csvCell(book.name), csvCell(book.auditDate), '', 'BOOK TOTAL', paiseToPlain(bookTotal(book)), '', csvCell(`${book.entries.length} entries`), '', '', '', '']);
  return rows;
}

/** CSV for one or more books. A grand-total row is added when several books are included. */
export function booksToCSV(books, { grandTotalPaise = null } = {}) {
  const lines = [HEADER.map((h) => csvCell(h)).join(',')];
  for (const b of books) for (const r of rowsForBook(b)) lines.push(r.join(','));
  if (grandTotalPaise !== null) {
    const count = books.reduce((n, b) => n + b.entries.length, 0);
    lines.push(['ALL BOOKS', '', '', 'GRAND TOTAL', paiseToPlain(grandTotalPaise), '', csvCell(`${count} entries in ${books.length} books`), '', '', '', ''].join(','));
  }
  // BOM so Excel opens UTF-8 (Malayalam transcripts, ₹) correctly.
  return '﻿' + lines.join('\r\n') + '\r\n';
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
function iso(v, field) {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new Error(`${field} is not a valid date/time.`);
  return v.slice(0, 40);
}

/** Validate and rebuild an application state object. Throws with a readable message. */
export function validateState(data) {
  if (!isObj(data)) throw new Error('Backup data is missing.');
  if (data.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported backup version: ${data.schemaVersion}.`);
  if (!Array.isArray(data.books) || data.books.length === 0) throw new Error('Backup has no receipt books.');
  if (data.books.length > 2000) throw new Error('Backup has too many receipt books.');
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
    return {
      id: bookId, name, auditDate, createdAt: iso(b.createdAt, 'Book created time'),
      entries: b.entries.map((e, ei) => {
        const where = `Book ${bi + 1}, entry ${ei + 1}`;
        if (!isObj(e)) throw new Error(`${where} is malformed.`);
        if (!ENTRY_SOURCES.includes(e.source)) throw new Error(`${where} has an invalid source.`);
        const entryId = id(e.id, `${where} id`);
        if (seen.has(entryId)) throw new Error('Duplicate entry id.');
        seen.add(entryId);
        return {
          id: entryId, paise: amount(e.paise, `${where} amount`), source: e.source,
          transcript: str(e.transcript, 300, 'Transcript'), reference: str(e.reference, 40, 'Reference'),
          remarks: str(e.remarks, 300, 'Remarks'), createdAt: iso(e.createdAt, `${where} time`),
          updatedAt: iso(e.updatedAt, `${where} edit time`), originalPaise: amount(e.originalPaise, `${where} original amount`, true),
        };
      }),
    };
  });
  // Totals must remain computable.
  let total = 0;
  for (const b of books) for (const e of b.entries) {
    total += e.paise;
    if (!Number.isSafeInteger(total)) throw new Error('Backup totals are too large.');
  }
  const bookIds = new Set(books.map((b) => b.id));
  const pending = Array.isArray(data.pending)
    ? data.pending.filter((p) => isObj(p) && bookIds.has(p.bookId)).slice(0, 50).map((p) => ({
        id: id(p.id, 'Pending id'), bookId: p.bookId, kind: p.kind === 'multiple' ? 'multiple' : 'confirm', transcript: str(p.transcript, 300, 'Transcript'),
        amounts: Array.isArray(p.amounts) ? p.amounts.filter((a) => Number.isSafeInteger(a) && a > 0 && a <= MAX_ENTRY_PAISE).slice(0, 20) : [],
        reference: str(p.reference, 40, 'Reference'),
        reasons: Array.isArray(p.reasons) ? p.reasons.filter((r) => typeof r === 'string').map((r) => r.slice(0, 200)).slice(0, 5) : [],
        createdAt: iso(p.createdAt, 'Pending time'),
      }))
    : [];
  const s = isObj(data.settings) ? data.settings : {};
  return {
    schemaVersion: SCHEMA_VERSION,
    books,
    activeBookId: bookIds.has(data.activeBookId) ? data.activeBookId : books[0].id,
    pending,
    settings: {
      lang: ['en-IN', 'ml-IN', 'en-US'].includes(s.lang) ? s.lang : 'en-IN',
      mode: ['phrase', 'continuous'].includes(s.mode) ? s.mode : 'phrase',
      theme: ['system', 'light', 'dark'].includes(s.theme) ? s.theme : 'system',
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
