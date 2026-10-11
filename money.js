// money.js — safe money handling.
// All amounts are stored as integer PAISE (1 rupee = 100 paise) so totals never
// suffer from floating-point rounding. Nothing in this app stores rupees as floats.

/** Largest single entry accepted: ₹10,000 crore (1e13 paise). */
export const MAX_ENTRY_PAISE = 1e13;

/** Throws unless value is a safe, non-negative integer number of paise. */
export function assertPaise(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Invalid paise amount: ${value}`);
  }
  return value;
}

/** Group a string of digits the Indian way: 1234567 -> 12,34,567 */
export function groupIndian(digits) {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

/** Format paise as Indian rupees, e.g. 12500000 -> "₹1,25,000.00". */
export function formatINR(paise, { symbol = true, decimals = true } = {}) {
  if (!Number.isSafeInteger(paise)) throw new TypeError(`Invalid paise amount: ${paise}`);
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const ps = abs % 100;
  let out = groupIndian(String(rupees));
  if (decimals) out += '.' + String(ps).padStart(2, '0');
  return (negative ? '-' : '') + (symbol ? '₹' : '') + out;
}

/** Plain machine-readable rupee string for CSV, e.g. 5220000 -> "52200.00". */
export function paiseToPlain(paise) {
  if (!Number.isSafeInteger(paise)) throw new TypeError(`Invalid paise amount: ${paise}`);
  const negative = paise < 0;
  const abs = Math.abs(paise);
  return (negative ? '-' : '') + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}

/** Paise -> plain editable string without trailing ".00" (for input fields). */
export function paiseToInput(paise) {
  assertPaise(paise);
  const r = Math.floor(paise / 100);
  const p = paise % 100;
  return p === 0 ? String(r) : `${r}.${String(p).padStart(2, '0')}`;
}

/** True if a comma-grouped digit string is validly grouped (Indian or Western). */
export function isValidGrouping(s) {
  return /^\d{1,2}(,\d{2})*,\d{3}$/.test(s) || /^\d{1,3}(,\d{3})+$/.test(s);
}

/**
 * Convert a decimal digit string ("1250", "1250.5", "1250.50") to paise using
 * integer arithmetic only. Returns null if it has more than 2 decimals.
 */
export function decimalStringToPaise(str) {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(str);
  if (!m) return null;
  const rupees = BigInt(m[1]);
  const frac = (m[2] || '').padEnd(2, '0');
  const paise = rupees * 100n + BigInt(frac || '0');
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(paise);
}

/**
 * Parse a manually typed amount. Accepts "10000", "10,000", "1,25,000.50",
 * "₹ 600", "Rs. 600". Rejects negatives, zero, >2 decimals and bad grouping.
 * @returns {{ok:true, paise:number} | {ok:false, error:string}}
 */
export function parseMoneyInput(input) {
  if (typeof input !== 'string') return { ok: false, error: 'Enter an amount.' };
  let s = input.trim().replace(/^(₹|rs\.?|inr)\s*/i, '').replace(/\/-$/, '').trim();
  if (s === '') return { ok: false, error: 'Enter an amount.' };
  if (s.startsWith('-')) return { ok: false, error: 'Negative amounts are not allowed.' };
  const m = /^([\d,]+)(\.\d+)?$/.exec(s);
  if (!m) return { ok: false, error: 'Use digits only, e.g. 20200 or 1,25,000.50' };
  let intPart = m[1];
  if (intPart.includes(',')) {
    if (!isValidGrouping(intPart)) return { ok: false, error: 'Commas look misplaced. Check the amount.' };
    intPart = intPart.replace(/,/g, '');
  }
  const frac = m[2] ? m[2].slice(1) : '';
  if (frac.length > 2) return { ok: false, error: 'Use at most 2 decimal places (paise).' };
  const paise = decimalStringToPaise(frac ? `${intPart}.${frac}` : intPart);
  if (paise === null) return { ok: false, error: 'Amount is too large.' };
  if (paise === 0) return { ok: false, error: 'Amount must be greater than zero.' };
  if (paise > MAX_ENTRY_PAISE) return { ok: false, error: 'Amount exceeds ₹10,000 crore limit.' };
  return { ok: true, paise };
}

/** Sum paise values; throws if the result would leave the safe-integer range. */
export function sumPaise(values) {
  let total = 0;
  for (const v of values) {
    assertPaise(v);
    total += v;
    if (!Number.isSafeInteger(total)) throw new RangeError('Total is too large to compute safely.');
  }
  return total;
}
