// parser.js — turns a speech-recognition transcript into an amount (in paise).
//
// Design rules (financial safety first):
//  * Only a clean, single, unambiguous amount gets status "ok" (auto-add).
//  * Anything uncertain — unrecognised words, several amounts run together,
//    odd grouping, very large values — is returned as "confirm" / "multiple".
//    Malayalam number words are flagged (usedMalayalam) so the app can apply the
//    user's "confirm Malayalam amounts" setting.
//  * Several plain digit amounts in one phrase ("588 1400 600", how Chrome writes
//    fast speech) are marked cleanSplit so the app may add them one by one.
//  * Two amounts are never merged into one unless the words clearly form one
//    number ("twenty thousand two hundred" = 20,200; "10000 20000" = two amounts).
//  * Maths uses BigInt rationals; results are integer paise.

import { isValidGrouping, MAX_ENTRY_PAISE, formatINR } from './money.js';

const formatRupees = (p) => formatINR(p, { decimals: p % 100 !== 0 });

/** Amounts at or above this (₹1 crore) are queued for confirmation. */
export const LARGE_AMOUNT_PAISE = 1_00_00_000 * 100;

// ---------- tiny BigInt rational helpers ----------
const R = (n, d = 1n) => ({ n: BigInt(n), d: BigInt(d) });
const radd = (a, b) => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const rmul = (a, s) => ({ n: a.n * BigInt(s), d: a.d });
const risZero = (a) => a.n === 0n;
const risInt = (a) => a.n % a.d === 0n;
const rlt = (a, s) => a.n < BigInt(s) * a.d;
const rToPaise = (a) => ((a.n * 100n) % a.d === 0n ? (a.n * 100n) / a.d : null);

// ---------- English vocabulary ----------
const EN_VALUES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const EN_SCALES = {
  thousand: 1000n, thousands: 1000n, tousand: 1000n, thousend: 1000n, thausand: 1000n, thousan: 1000n, tausand: 1000n, thousant: 1000n,
  lakh: 100000n, lakhs: 100000n, lack: 100000n, lacks: 100000n, laakhs: 100000n, lac: 100000n, lacs: 100000n, lak: 100000n, laks: 100000n, laakh: 100000n,
  million: 1000000n, millions: 1000000n,
  crore: 10000000n, crores: 10000000n, cr: 10000000n, karod: 10000000n, karor: 10000000n,
};
const FILLERS = new Set([
  'and', 'only', 'the', 'of', 'is', 'uh', 'um', 'umm', 'uhh', 'hmm', 'ok', 'okay', 'sir',
  'amount', 'value', 'total', 'roopa', 'rupa', 'roopaa', 'roopay', 'രൂപ', 'രൂപയും',
]);
const RUPEE_WORDS = new Set(['rupees', 'rupee', 'inr']);
const SEPARATORS = new Set(['plus', 'next', 'then', ',', ';']);
const POINT_WORDS = new Set(['point', 'dot']);
const PAISE_WORDS = new Set(['paise', 'paisa', 'paisas', 'pice', 'പൈസ']);
const REF_WORDS = new Set([
  'voucher', 'vouchers', 'receipt', 'leaf', 'bill', 'serial', 'ref', 'reference',
  'number', 'no', 'num', 'vr', 'sl', 'slip', 'page',
]);
// Words Chrome often writes instead of a number, accepted only right before
// "hundred/thousand/lakh/crore" (e.g. "to thousand" = 2,000; "for lakh" = 4 lakh).
const HOMOPHONES = { to: 2, too: 2, tu: 2, for: 4, fore: 4, won: 1, ate: 8, tree: 3, free: 3, sex: 6, nain: 9 };
const HUNDRED_WORDS = new Set(['hundred', 'hundreds', 'hundrad', 'hunderd', 'hundered', 'hundret']);
const FRACTION_DIGIT_WORDS = { ...Object.fromEntries(Object.entries(EN_VALUES).filter(([, v]) => v < 10)), oh: 0, o: 0 };

// ---------- Malayalam / Manglish vocabulary (best-effort; always confirmed) ----------
const val = (v) => ({ t: 'val', v: R(v), src: 'word' });
const HUNDRED = { t: 'hundred' };
const scale = (v) => ({ t: 'scale', v: BigInt(v) });

function table(entries) {
  const out = new Map();
  for (const [words, tok] of entries) for (const w of words) out.set(w, tok);
  return out;
}
function withSuffixes(stems, suffixes) {
  const out = [];
  for (const s of stems) for (const x of suffixes) out.push(s + x);
  return out;
}

const ML_ROMAN = table([
  [['onnu', 'onn', 'oru', 'onu'], val(1)],
  [['randu', 'rand', 'rendu', 'rend', 'randa'], val(2)],
  [['moonnu', 'munnu', 'moonn', 'munn', 'moonu', 'munu', 'moov', 'muv'], val(3)],
  [['naalu', 'nalu', 'naal', 'nal', 'naala'], val(4)],
  [['anju', 'anj', 'anchu', 'anch', 'ayy', 'ayyi'], val(5)],
  [['aaru', 'aru', 'aar'], val(6)],
  [['ezhu', 'ezh', 'elu', 'yezhu'], val(7)],
  [['ettu', 'ett', 'enn', 'ennu'], val(8)],
  [['onpathu', 'ombathu', 'onpath', 'ombath', 'onpathi', 'ombathi', 'onpathin', 'ombathin', 'ompathu'], val(9)],
  [['pathu', 'path', 'pathi', 'pathin', 'patthu', 'patth'], val(10)],
  [['pathinonnu', 'pathinonn'], val(11)],
  [['panthrandu', 'panthrand', 'pantrandu'], val(12)],
  [['pathimoonnu', 'pathimunnu', 'pathimoonn'], val(13)],
  [['pathinaalu', 'pathinalu', 'pathinaal'], val(14)],
  [['pathinanju', 'pathinanchu', 'pathinanj'], val(15)],
  [['pathinaaru', 'pathinaru', 'pathinaar'], val(16)],
  [['pathinezhu', 'pathinezh'], val(17)],
  [['pathinettu', 'pathinett'], val(18)],
  [['pathonpathu', 'patthonpathu', 'pathombathu', 'pathonpath'], val(19)],
  [withSuffixes(['irupath', 'irubath'], ['', 'u', 'i', 'in', 'inu']), val(20)],
  [withSuffixes(['muppath', 'mupath'], ['', 'u', 'i', 'in', 'inu']), val(30)],
  [withSuffixes(['naalpath', 'nalpath'], ['', 'u', 'i', 'in', 'inu']), val(40)],
  [withSuffixes(['anpath', 'ambath', 'ampath', 'anbath'], ['', 'u', 'i', 'in', 'inu']), val(50)],
  [withSuffixes(['arupath', 'aarupath'], ['', 'u', 'i', 'in', 'inu']), val(60)],
  [withSuffixes(['ezhupath', 'elupath'], ['', 'u', 'i', 'in', 'inu']), val(70)],
  [withSuffixes(['enpath', 'embath', 'enbath'], ['', 'u', 'i', 'in', 'inu']), val(80)],
  [['thonnooru', 'thonnuru', 'thonnoor', 'thonnootti', 'thonnoottu', 'thonnuttu'], val(90)],
  [['nooru', 'nuru', 'noor', 'nur', 'nootti', 'noottu', 'nooti', 'nuttu'], HUNDRED],
  [['irunooru', 'irunuru', 'irunootti', 'irunoottu'], val(200)],
  [['munnooru', 'moonnooru', 'munnuru', 'munnootti'], val(300)],
  [['naanooru', 'nanooru', 'naanuru', 'nanuru', 'naanootti', 'nanootti'], val(400)],
  [['anjooru', 'anjuru', 'anjootti', 'anjoottu'], val(500)],
  [['arunooru', 'arunuru', 'arunootti'], val(600)],
  [['ezhunooru', 'ezhunuru', 'ezhunootti'], val(700)],
  [['ennooru', 'ennuru', 'ennootti'], val(800)],
  [['thollayiram', 'tholayiram', 'thollaayiram', 'thollayirathi', 'tholayirathi'], val(900)],
  [['aayiram', 'ayiram', 'aayirom', 'ayirom', 'aayirathi', 'ayirathi', 'aayirathu', 'ayirathu', 'aayirath', 'ayirath', 'naayiram'], scale(1000)],
  [['laksham', 'lakshm', 'laksha', 'lakshathi', 'lakshathinu', 'lacham'], scale(100000)],
  [['kodi', 'kodiyi'], scale(10000000)],
]);
const ML_ROMAN_LINKERS = ['i', 'y', 'u', 'a', 'n', 'v'];

const ML_SCRIPT = table([
  [['ഒന്ന്', 'ഒരു', 'യൊന്ന്'], val(1)],
  [['രണ്ട്', 'രണ്ട'], val(2)],
  [['മൂന്ന്', 'മൂവ'], val(3)],
  [['നാല്', 'നാല', 'നാൽ'], val(4)],
  [['അഞ്ച്', 'അയ്യ', 'യഞ്ച്'], val(5)],
  [['ആറ്', 'ആറ', 'യാറ്'], val(6)],
  [['ഏഴ്', 'ഏഴ', 'യേഴ്'], val(7)],
  [['എട്ട്', 'എണ്ണ', 'യെട്ട്'], val(8)],
  [['ഒൻപത്', 'ഒമ്പത്', 'ഒൻപതി', 'ഒമ്പതി', 'യൊൻപത്', 'യൊമ്പത്'], val(9)],
  [['പത്ത്', 'പതി'], val(10)],
  [['പതിനൊന്ന്'], val(11)], [['പന്ത്രണ്ട്'], val(12)], [['പതിമൂന്ന്'], val(13)],
  [['പതിനാല്', 'പതിനാൽ'], val(14)], [['പതിനഞ്ച്'], val(15)], [['പതിനാറ്'], val(16)],
  [['പതിനേഴ്'], val(17)], [['പതിനെട്ട്'], val(18)], [['പത്തൊൻപത്', 'പത്തൊമ്പത്'], val(19)],
  [['ഇരുപത്', 'ഇരുപത്തി', 'ഇരുപതി'], val(20)],
  [['മുപ്പത്', 'മുപ്പത്തി', 'മുപ്പതി'], val(30)],
  [['നാല്പത്', 'നാൽപത്', 'നാൽപ്പത്', 'നാല്പത്തി', 'നാൽപത്തി', 'നാൽപ്പത്തി', 'നാല്പതി', 'നാൽപതി'], val(40)],
  [['അമ്പത്', 'അൻപത്', 'അമ്പത്തി', 'അൻപത്തി', 'അമ്പതി', 'അൻപതി', 'യമ്പത്', 'യൻപത്'], val(50)],
  [['അറുപത്', 'അറുപത്തി', 'അറുപതി'], val(60)],
  [['എഴുപത്', 'എഴുപത്തി', 'എഴുപതി'], val(70)],
  [['എൺപത്', 'എമ്പത്', 'എൺപത്തി', 'എമ്പത്തി', 'എൺപതി'], val(80)],
  [['തൊണ്ണൂറ്', 'തൊണ്ണൂറ്റി'], val(90)],
  [['നൂറ്', 'നൂറ്റി', 'നൂറ'], HUNDRED],
  [['ഇരുനൂറ്', 'ഇരുനൂറ്റി'], val(200)],
  [['മുന്നൂറ്', 'മുന്നൂറ്റി'], val(300)],
  [['നാനൂറ്', 'നാനൂറ്റി'], val(400)],
  [['അഞ്ഞൂറ്', 'അഞ്ഞൂറ്റി'], val(500)],
  [['അറുനൂറ്', 'അറുനൂറ്റി'], val(600)],
  [['എഴുനൂറ്', 'എഴുനൂറ്റി'], val(700)],
  [['എണ്ണൂറ്', 'എണ്ണൂറ്റി'], val(800)],
  [['തൊള്ളായിരം', 'തൊള്ളായിരത്തി'], val(900)],
  [['ആയിരം', 'ആയിരത്തി', 'ആയിരത്ത്', 'നായിരം', 'നായിരത്തി', 'നായിരത്ത്', 'ായിരം', 'ായിരത്തി', 'ായിരത്ത്', 'യിരം', 'യിരത്തി'], scale(1000)],
  [['ലക്ഷം', 'ലക്ഷത്തി', 'ലക്ഷ'], scale(100000)],
  [['കോടി'], scale(10000000)],
  // English number words as Malayalam-script transliterations (mixed speech with ml-IN)
  [['വൺ'], val(1)], [['ടു'], val(2)], [['ത്രീ'], val(3)], [['ഫോർ', 'ഫോറ്'], val(4)], [['ഫൈവ്'], val(5)],
  [['സിക്സ്'], val(6)], [['സെവൻ', 'സെവെൻ'], val(7)], [['എയ്റ്റ്', 'എയിറ്റ്', 'എയ്‌റ്റ്'], val(8)], [['നൈൻ', 'നയൻ'], val(9)],
  [['ടെൻ'], val(10)], [['ഇലവൻ'], val(11)], [['ട്വൽവ്', 'ട്വെൽവ്'], val(12)], [['തേർട്ടീൻ'], val(13)], [['ഫോർട്ടീൻ'], val(14)],
  [['ഫിഫ്റ്റീൻ'], val(15)], [['സിക്സ്റ്റീൻ'], val(16)], [['സെവന്റീൻ'], val(17)], [['എയ്റ്റീൻ'], val(18)], [['നൈന്റീൻ'], val(19)],
  [['ട്വന്റി', 'ട്വെന്റി'], val(20)], [['തേർട്ടി'], val(30)], [['ഫോർട്ടി'], val(40)], [['ഫിഫ്റ്റി'], val(50)],
  [['സിക്സ്റ്റി'], val(60)], [['സെവന്റി'], val(70)], [['എയ്റ്റി', 'എയിറ്റി'], val(80)], [['നൈന്റി', 'നയന്റി'], val(90)],
  [['ഹൺഡ്രഡ്', 'ഹണ്ട്രഡ്', 'ഹൺഡ്രെഡ്', 'ഹണ്ട്രെഡ്', 'ഹൺട്രഡ്'], HUNDRED],
  [['തൗസൻഡ്', 'തൗസന്റ്', 'തൗസണ്ട്', 'തൗസൻറ്', 'തൌസന്റ്', 'തൗസൻ്റ്', 'തൗസന്ഡ്'], scale(1000)],
  [['ലാഖ്', 'ലാക്ക്', 'ലാക്', 'ലാക്സ്'], scale(100000)],
  [['ക്രോർ', 'ക്രോറ്', 'ക്രോർസ്'], scale(10000000)],
]);

/**
 * Split one word into known morphemes (fewest pieces wins), optionally allowing
 * a single linking letter between pieces (Manglish sandhi, e.g. "irupathi-y-anju").
 * Returns an array of tokens or null.
 */
export function segmentWord(word, dict, linkers = []) {
  const chars = Array.from(word);
  const n = chars.length;
  const maxLen = Math.max(...Array.from(dict.keys(), (k) => Array.from(k).length));
  const best = new Array(n + 1).fill(null);
  best[0] = [];
  for (let i = 0; i < n; i++) {
    if (!best[i]) continue;
    const starts = [i];
    if (i > 0) for (const l of linkers) if (chars[i] === l) starts.push(i + 1);
    for (const s of starts) {
      for (let len = Math.min(maxLen, n - s); len >= 1; len--) {
        const piece = chars.slice(s, s + len).join('');
        const tok = dict.get(piece);
        if (!tok) continue;
        const cand = [...best[i], { ...tok, raw: piece, ml: true }];
        const end = s + len;
        if (!best[end] || cand.length < best[end].length) best[end] = cand;
      }
    }
  }
  return best[n];
}

// ---------- normalisation & tokenising ----------
export function normalizeTranscript(text) {
  let s = String(text ?? '').normalize('NFC');
  s = s.replace(/[൦-൯]/g, (c) => String(c.charCodeAt(0) - 0x0d66)); // Malayalam digits
  s = s.replace(/[०-९]/g, (c) => String(c.charCodeAt(0) - 0x0966)); // Devanagari digits
  // Old-style chillu (consonant + virama + ZWJ) -> atomic chillu letters.
  s = s
    .replace(/ണ്‍/g, 'ൺ').replace(/ന്‍/g, 'ൻ')
    .replace(/ര്‍/g, 'ർ').replace(/ല്‍/g, 'ൽ')
    .replace(/ള്‍/g, 'ൾ').replace(/ക്‍/g, 'ൿ');
  s = s.replace(/[​-‍﻿]/g, '');
  s = s.toLowerCase();
  s = s.replace(/₹/g, ' rupees ');
  s = s.replace(/\brs\.?(?=\s|\d|$)/g, ' rupees ');
  s = s.replace(/\/-/g, ' ');
  s = s.replace(/(\d)\s*k\b/g, '$1 thousand');
  s = s.replace(/(\d)(lakhs?|lacs?|crores?|cr|thousand)\b/g, '$1 $2');
  s = s.replace(/(\p{L}|\p{M})-(?=\p{L})/gu, '$1 ');
  s = s.replace(/(?<!\d)\.|\.(?!\d)/g, ' '); // keep decimal points only
  s = s.replace(/(?<!\d),|,(?!\d)/g, ' , '); // a comma not inside digits separates
  s = s.replace(/[^\p{L}\p{M}\p{N}.,\s]/gu, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function tokenizeWord(w) {
  if (w === ',') return { t: 'sep', raw: w };
  if (/^\d[\d,]*(\.\d+)?$/.test(w)) {
    let [intPart, frac = ''] = w.split('.');
    if (intPart.includes(',')) {
      if (!isValidGrouping(intPart)) return { t: 'bad', raw: w };
      intPart = intPart.replace(/,/g, '');
    }
    return { t: 'val', v: R(intPart + frac, 10n ** BigInt(frac.length)), src: 'digit', raw: w, digits: intPart, frac };
  }
  if (/^[\p{L}\d]+$/u.test(w) && /\d/.test(w) && /\p{L}/u.test(w)) return { t: 'alnum', raw: w };
  if (w in EN_VALUES) return { t: 'val', v: R(EN_VALUES[w]), src: 'word', raw: w };
  if (HUNDRED_WORDS.has(w)) return { t: 'hundred', raw: w };
  if (w in EN_SCALES) return { t: 'scale', v: EN_SCALES[w], raw: w };
  if (w === 'a' || w === 'an') return { t: 'a', raw: w };
  if (w === 'oh' || w === 'o') return { t: 'oh', raw: w };
  if (RUPEE_WORDS.has(w)) return { t: 'rupees', raw: w };
  if (FILLERS.has(w)) return { t: 'filler', raw: w };
  if (SEPARATORS.has(w)) return { t: 'sep', raw: w };
  if (POINT_WORDS.has(w)) return { t: 'point', raw: w };
  if (PAISE_WORDS.has(w)) return { t: 'paise', raw: w };
  if (REF_WORDS.has(w)) return { t: 'refkw', raw: w };
  if (w in HOMOPHONES) return { t: 'homo', v: HOMOPHONES[w], raw: w };
  if (w === 'double' || w === 'triple') return { t: 'mult', n: w === 'double' ? 2 : 3, raw: w };
  return null;
}

export function tokenize(normalized) {
  const out = [];
  for (const w of normalized.split(' ').filter(Boolean)) {
    const tok = tokenizeWord(w);
    if (tok) { out.push(tok); continue; }
    let seg = null;
    if (/^[a-z]{3,}$/.test(w)) seg = segmentWord(w, ML_ROMAN, ML_ROMAN_LINKERS);
    else if (/[ഀ-ൿ]/.test(w)) seg = segmentWord(w, ML_SCRIPT);
    if (seg && seg.length) out.push(...seg);
    else out.push({ t: 'unknown', raw: w });
  }
  // A homophone counts as a number only right before hundred/thousand/lakh/crore.
  const mapped = out.map((t, i) => {
    if (t.t !== 'homo') return t;
    const nx = out[i + 1];
    return nx && (nx.t === 'hundred' || nx.t === 'scale') ? { t: 'val', v: R(t.v), src: 'word', raw: t.raw } : { t: 'unknown', raw: t.raw };
  });
  return mergeDictatedDigits(mapped);
}

/** One spoken digit (word "four"/"zero"/"oh" or a single digit "4"), else null. */
function singleDigit(t) {
  if (t.t === 'oh') return '0';
  if (t.t !== 'val') return null;
  if (t.src === 'digit') return !t.frac && t.digits.length === 1 ? t.digits : null;
  return t.raw in FRACTION_DIGIT_WORDS ? String(FRACTION_DIGIT_WORDS[t.raw]) : null;
}

/**
 * Digit-by-digit dictation: "four two zero zero", "4 2 0 0", "four two double zero"
 * become one amount (4200). Needs 3+ digits so "five six" is not merged. Digits after
 * "point" are left for the decimal parser; a run followed by hundred/thousand is not merged.
 */
function mergeDictatedDigits(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const startPrev = out[out.length - 1];
    let j = i, digits = '', raws = [];
    while (j < tokens.length) {
      const t = tokens[j];
      if (t.t === 'mult' && j + 1 < tokens.length && singleDigit(tokens[j + 1]) !== null) {
        digits += singleDigit(tokens[j + 1]).repeat(t.n);
        raws.push(t.raw, tokens[j + 1].raw);
        j += 2;
        continue;
      }
      const d = singleDigit(t);
      if (d === null) break;
      digits += d; raws.push(t.raw); j++;
    }
    const next = tokens[j];
    const ok = digits.length >= 3 && !(startPrev && startPrev.t === 'point') && !(next && (next.t === 'hundred' || next.t === 'scale'));
    if (ok) {
      const clean = digits.replace(/^0+(?=\d)/, '');
      out.push({ t: 'val', v: R(clean), src: 'digit', raw: raws.join(' '), digits: clean, frac: '', dictated: true });
      i = j;
    } else {
      const t = tokens[i];
      out.push(t.t === 'mult' ? { t: 'unknown', raw: t.raw } : t);
      i++;
    }
  }
  return out;
}

// ---------- grammar ----------
function canAdd(group, v, tok, prev, lastScale) {
  if (risZero(group)) return lastScale === null || rlt(v, lastScale);
  if (!risInt(group) || !risInt(v)) return false;
  if (tok.src === 'digit' || (prev && prev.t === 'val' && prev.src === 'digit')) return false;
  const g = group.n / group.d;
  const x = v.n / v.d;
  const last2 = g % 100n;
  if (x < 10n) return last2 === 0n || (last2 >= 20n && last2 % 10n === 0n);
  if (x < 100n) return last2 === 0n;
  return false;
}

/** Group a token list into one or more amounts (rationals, in rupees). */
export function groupAmounts(tokens) {
  const amounts = [];
  let unclear = false; // true when two amounts were split for a reason other than digits-then-digits or "plus"
  const boundaries = []; // how each split happened: 'sep' | 'digits' | 'other'
  let total = R(0), group = R(0), started = false, lastScale = null, hasHundred = false, prev = null;
  const flush = () => {
    if (started) amounts.push(radd(total, group));
    total = R(0); group = R(0); started = false; lastScale = null; hasHundred = false;
  };
  for (let i = 0; i < tokens.length; i++) {
    let tok = tokens[i];
    if (tok.t === 'a') {
      const nx = tokens[i + 1];
      if (nx && (nx.t === 'hundred' || nx.t === 'scale')) tok = { t: 'val', v: R(1), src: 'word', raw: tok.raw };
      else continue;
    }
    if (tok.t === 'sep') { if (started) boundaries.push('sep'); flush(); prev = tok; continue; }
    if (tok.t === 'val') {
      if (!started) { group = tok.v; started = true; hasHundred = false; }
      else if (canAdd(group, tok.v, tok, prev, lastScale)) group = radd(group, tok.v);
      else {
        const digitsSplit = tok.src === 'digit' && prev && prev.t === 'val' && prev.src === 'digit';
        if (!digitsSplit) unclear = true;
        boundaries.push(digitsSplit ? 'digits' : 'other');
        flush(); group = tok.v; started = true;
      }
      if (tok.v.n >= 100n * tok.v.d && risInt(tok.v) && tok.src === 'word') hasHundred = true;
    } else if (tok.t === 'hundred') {
      if (!started) { group = R(100); started = true; hasHundred = true; }
      else if (risZero(group)) { group = R(100); hasHundred = true; }
      else if (!hasHundred && rlt(group, 100)) { group = rmul(group, 100); hasHundred = true; }
      else return { amounts: [], error: 'The word "hundred" is in an unexpected place.' };
    } else if (tok.t === 'scale') {
      if (!started) { group = R(1); started = true; }
      if (risZero(group)) return { amounts: [], error: `"${tok.raw}" is in an unexpected place.` };
      if (lastScale === null || tok.v < lastScale) {
        total = radd(total, rmul(group, tok.v));
      } else {
        amounts.push(total); // a new amount starts with the current group
        unclear = true;
        boundaries.push('other');
        total = rmul(group, tok.v);
      }
      group = R(0); lastScale = tok.v; hasHundred = false;
    } else {
      continue; // fillers, rupee words, unknown words don't affect grouping
    }
    prev = tok;
  }
  flush();
  return { amounts, cleanSplit: !unclear, boundaries };
}

function detectCommand(norm) {
  if (/^(undo|undo last|undo last entry|delete last|delete last entry|cancel last|remove last|remove last entry)$/.test(norm)) return 'undo';
  if (/^(stop|stop listening)$/.test(norm)) return 'stop';
  return null;
}

/** Parse the fraction part after "point": digit words or one digit token, then optional scales. */
function parseFraction(tokens) {
  let digits = '';
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t === 'filler' || t.t === 'rupees') continue;
    if (t.t === 'val' && t.src === 'word' && t.raw in FRACTION_DIGIT_WORDS) digits += String(FRACTION_DIGIT_WORDS[t.raw]);
    else if (t.t === 'oh') digits += '0';
    else if (t.t === 'val' && t.src === 'digit' && !t.frac && digits === '') digits += t.digits;
    else break;
  }
  const scales = [];
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.t === 'filler' || t.t === 'rupees') continue;
    if (t.t === 'scale' || t.t === 'hundred') scales.push(t.t === 'hundred' ? 100n : t.v);
    else return null;
  }
  return digits ? { digits, scales } : null;
}

/**
 * Parse a transcript.
 * @returns {{
 *   status: 'ok'|'confirm'|'multiple'|'invalid'|'command',
 *   transcript: string, paise?: number, amounts?: number[], reference?: string,
 *   command?: 'undo'|'stop', reasons: string[], usedMalayalam: boolean }}
 */
export function parseAmount(transcript) {
  const raw = String(transcript ?? '');
  const result = { transcript: raw, reasons: [], usedMalayalam: false };
  const invalid = (reason) => ({ ...result, status: 'invalid', reasons: [reason] });
  const norm = normalizeTranscript(raw);
  if (!norm) return invalid('Nothing was heard.');
  const command = detectCommand(norm);
  if (command) return { ...result, status: 'command', command };

  let tokens = tokenize(norm);
  result.usedMalayalam = tokens.some((t) => t.ml);
  const bad = tokens.find((t) => t.t === 'bad');
  if (bad) return invalid(`"${bad.raw}" has misplaced commas — enter it manually.`);

  // Voucher / receipt / leaf reference, e.g. "voucher 25 amount 10000".
  const ki = tokens.findIndex((t) => t.t === 'refkw');
  if (ki >= 0) {
    let j = ki + 1;
    while (j < tokens.length && (tokens[j].t === 'refkw' || tokens[j].t === 'filler')) j++;
    const nx = tokens[j];
    if (nx && ((nx.t === 'val' && nx.src === 'digit' && !nx.frac) || nx.t === 'alnum')) {
      result.reference = nx.raw.replace(/,/g, '').toUpperCase();
      tokens = [...tokens.slice(0, ki), ...tokens.slice(j + 1)];
    } else if (tokens.some((t, idx) => idx > ki && (t.t === 'val' || t.t === 'scale' || t.t === 'hundred'))) {
      return invalid('Heard a voucher/receipt word but could not separate its number from the amount. Say the number in digits, e.g. "voucher 25, 10,000", or type it.');
    }
  }
  const unknown = tokens.filter((t) => t.t === 'unknown' || t.t === 'refkw' || t.t === 'alnum' || t.t === 'oh').map((t) => t.raw);

  // Paise: "five hundred rupees fifty paise" / "fifty paise".
  let paiseExtra = null;
  const pi = tokens.findIndex((t) => t.t === 'paise');
  if (pi >= 0) {
    if (tokens.slice(pi + 1).some((t) => t.t !== 'filler')) return invalid('Words after "paise" were not understood.');
    let ri = -1;
    for (let k = pi - 1; k >= 0; k--) if (tokens[k].t === 'rupees') { ri = k; break; }
    const paisePart = groupAmounts(tokens.slice(ri + 1, pi));
    if (paisePart.error || paisePart.amounts.length !== 1) return invalid('Could not understand the paise.');
    const p = paisePart.amounts[0];
    if (!risInt(p) || !rlt(p, 100)) return invalid('Paise must be between 0 and 99.');
    paiseExtra = p.n / p.d;
    tokens = ri >= 0 ? tokens.slice(0, ri) : [];
  }

  // Decimal "point".
  let amounts;
  const pointIdx = tokens.map((t, i) => (t.t === 'point' ? i : -1)).filter((i) => i >= 0);
  if (pointIdx.length > 1) return invalid('Heard "point" more than once.');
  if (pointIdx.length === 1) {
    if (paiseExtra !== null) return invalid('Heard both "point" and "paise".');
    const left = tokens.slice(0, pointIdx[0]);
    const frac = parseFraction(tokens.slice(pointIdx[0] + 1));
    if (!frac) return invalid('Could not understand the digits after "point".');
    const leftG = groupAmounts(left);
    if (leftG.error || leftG.amounts.length !== 1) return invalid('Could not understand the amount before "point".');
    const L = leftG.amounts[0];
    if (!risInt(L)) return invalid('Could not understand the decimal amount.');
    const den = 10n ** BigInt(frac.digits.length);
    let value = { n: (L.n / L.d) * den + BigInt(frac.digits), d: den };
    if (frac.scales.length) {
      if (left.some((t) => t.t === 'scale' || t.t === 'hundred')) return invalid('Could not understand the decimal amount.');
      for (const s of frac.scales) value = rmul(value, s);
    } else if (frac.digits.length > 2) {
      return invalid('More than two decimal places were heard.');
    }
    amounts = [value];
  } else {
    const g = groupAmounts(tokens);
    if (g.error) return invalid(g.error);
    amounts = g.amounts;
    result.cleanSplit = g.cleanSplit;
    result.boundaries = g.boundaries;
    if (paiseExtra !== null) {
      if (amounts.length > 1) return invalid('Could not understand the rupees part.');
      amounts = [radd(amounts[0] || R(0), { n: paiseExtra, d: 100n })];
    }
  }

  if (amounts.length === 0 && result.reference && unknown.length === 0) {
    return { ...result, status: 'command', command: 'setLeaf' };
  }
  if (amounts.length === 0) {
    return invalid(unknown.length ? `No amount understood in “${unknown.join(' ')}”.` : 'No amount was heard.');
  }
  const paiseList = [];
  for (const a of amounts) {
    const p = rToPaise(a);
    if (p === null) return invalid('More than two decimal places were heard.');
    if (p > BigInt(MAX_ENTRY_PAISE)) return invalid('Amount is above the ₹10,000 crore limit.');
    if (p === 0n) return invalid('Heard zero — nothing to add.');
    paiseList.push(Number(p));
  }

  if (paiseList.length > 1) {
    // "4000 200" may be one amount (₹4,200) that Chrome wrote in two pieces.
    // If a digit amount is a round number big enough to "absorb" the next one, don't split silently.
    const b = result.boundaries || [];
    let combined = null;
    let joinable = false;
    for (let k = 0; k + 1 < paiseList.length; k++) {
      if (b[k] !== 'digits') continue;
      const a = paiseList[k], c = paiseList[k + 1];
      if (a % 100 || c % 100) continue;
      const cLen = String(c / 100).length;
      if ((a / 100) % 10 ** cLen === 0 && a > c) {
        joinable = true; // "4000 200" -> 4,200
        if (paiseList.length === 2) combined = a + c;
      } else if (a < 1000) {
        joinable = true; // "4 200" -> 4,200 (a lone single digit is rarely a receipt amount)
        const joined = Number(String(a / 100) + String(c / 100)) * 100;
        if (paiseList.length === 2 && Number.isSafeInteger(joined) && joined <= MAX_ENTRY_PAISE) combined = joined;
      }
    }
    const reasons = ['More than one amount was heard in one phrase.'];
    if (joinable) reasons.unshift(combined ? `Did you say ${formatRupees(combined)} as one amount?` : 'Some of these may be one amount said in parts.');
    return {
      ...result, status: 'multiple', amounts: paiseList, combined,
      cleanSplit: !!result.cleanSplit && !joinable && !result.reference && unknown.length === 0,
      reasons,
    };
  }
  const reasons = [];
  if (unknown.length) reasons.push(`Unrecognised words: “${unknown.join(' ')}”.`);
  if (paiseList[0] >= LARGE_AMOUNT_PAISE) reasons.push('Unusually large amount (₹1 crore or more).');
  return { ...result, status: reasons.length ? 'confirm' : 'ok', paise: paiseList[0], reasons };
}

/**
 * When fast speech runs two amounts together ("4200" + "5300" heard as 4205300),
 * suggest ways to split the digits back into two amounts, each within the limit.
 * Splits where both parts are round (end in 0) are preferred. Whole rupees only.
 * @returns {number[][]} up to `max` pairs of paise amounts
 */
export function splitSuggestions(paise, limitPaise, max = 3) {
  if (!Number.isSafeInteger(paise) || paise % 100 !== 0) return [];
  const s = String(paise / 100);
  const out = [];
  for (let i = 2; i <= s.length - 2; i++) {
    const a = s.slice(0, i), b = s.slice(i);
    if (b[0] === '0') continue;
    const pa = Number(a) * 100, pb = Number(b) * 100;
    if (pa > limitPaise || pb > limitPaise) continue;
    const score = (a.endsWith('00') ? 2 : a.endsWith('0') ? 1 : 0) + (b.endsWith('00') ? 2 : b.endsWith('0') ? 1 : 0);
    out.push({ pair: [pa, pb], score });
  }
  return out.filter((x) => x.score > 0).sort((x, y) => y.score - x.score).slice(0, max).map((x) => x.pair);
}

/**
 * Google's recogniser sometimes glues the parts of one amount together:
 * "two thousand one hundred" -> "2000100", "twenty thousand two hundred" -> "20000200".
 * If the digits split into a round number followed by a smaller part that fits in its
 * zeros (2000|100), return the intended amount (2,100). Only one possible reading is
 * accepted; otherwise null.
 */
export function unglue(paise) {
  if (!Number.isSafeInteger(paise) || paise % 100 !== 0) return null;
  const s = String(paise / 100);
  const found = [];
  for (let i = 1; i < s.length; i++) {
    const a = s.slice(0, i), b = s.slice(i);
    if (b[0] === '0') continue;
    const zeros = a.length - a.replace(/0+$/, '').length;
    if (zeros >= b.length && zeros >= 2) found.push((Number(a) + Number(b)) * 100);
  }
  return found.length === 1 ? found[0] : null;
}
