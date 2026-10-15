// readback.js — speaks each amount and/or the running total aloud (Indian English),
// so the auditor can keep eyes on the receipt book.
//
// Echo guard: the phone's speaker can be picked up by its own microphone. While a
// read-back is playing (and briefly after), a recognised phrase whose amounts are
// exactly the numbers being spoken is treated as an echo and ignored.

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function below100(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
}
function below1000(n) {
  const h = Math.floor(n / 100), r = n % 100;
  return [h ? `${ONES[h]} hundred` : '', r ? below100(r) : ''].filter(Boolean).join(' ');
}

/** Whole rupees in Indian words: 125000 -> "one lakh twenty five thousand". */
export function rupeesToWords(r) {
  if (!Number.isSafeInteger(r) || r < 0) throw new TypeError('Invalid rupee amount');
  if (r === 0) return 'zero';
  const crore = Math.floor(r / 1e7), lakh = Math.floor((r % 1e7) / 1e5), thousand = Math.floor((r % 1e5) / 1e3), rest = r % 1e3;
  return [
    crore ? `${rupeesToWords(crore)} crore` : '',
    lakh ? `${below100(lakh)} lakh` : '',
    thousand ? `${below100(thousand)} thousand` : '',
    rest ? below1000(rest) : '',
  ].filter(Boolean).join(' ');
}

/** Paise in words: 58850 -> "five hundred eighty eight rupees fifty paise" (rupees word only if paise present). */
export function amountToWords(paise) {
  const r = Math.floor(paise / 100), p = paise % 100;
  if (!p) return rupeesToWords(r);
  return `${r ? rupeesToWords(r) + ' rupees ' : ''}${below100(p)} paise`;
}

/** Text to speak for a newly added amount. mode: off | amount | total | both */
export function readBackText(mode, addedPaise, totalPaise) {
  if (mode === 'amount') return amountToWords(addedPaise);
  if (mode === 'total') return `total ${amountToWords(totalPaise)}`;
  if (mode === 'both') return `${amountToWords(addedPaise)}. total ${amountToWords(totalPaise)}`;
  return '';
}

export class ReadBack {
  constructor({ synth = globalThis.speechSynthesis, Utterance = globalThis.SpeechSynthesisUtterance, now = () => Date.now() } = {}) {
    this.synth = synth || null;
    this.Utterance = Utterance || null;
    this.now = now;
    this.guard = null;
    this.voice = null;
  }

  get supported() { return !!(this.synth && this.Utterance); }

  _pickVoice() {
    if (this.voice || !this.synth || !this.synth.getVoices) return this.voice;
    const voices = this.synth.getVoices() || [];
    this.voice = voices.find((v) => v.lang === 'en-IN') || voices.find((v) => /^en[-_]IN/i.test(v.lang)) || voices.find((v) => /^en/i.test(v.lang)) || null;
    return this.voice;
  }

  /** Speak text; `numbers` are the paise values being spoken (for the echo guard). */
  speak(text, numbers = []) {
    if (!text || !this.supported) return false;
    try {
      this.synth.cancel(); // never queue up behind older read-backs — keeps pace with fast dictation
      const u = new this.Utterance(text);
      u.lang = 'en-IN';
      u.rate = 1.15;
      const v = this._pickVoice();
      if (v) u.voice = v;
      const words = text.split(/\s+/).length;
      this.guard = { numbers: new Set(numbers), until: this.now() + words * 380 + 1500 };
      u.onend = () => { if (this.guard) this.guard.until = Math.min(this.guard.until, this.now() + 1200); };
      this.synth.speak(u);
      return true;
    } catch { return false; }
  }

  /** True if every heard amount is one we are (or just were) speaking. */
  isEcho(paiseList) {
    const g = this.guard;
    if (!g || this.now() > g.until || !paiseList.length) return false;
    return paiseList.every((p) => g.numbers.has(p));
  }

  cancel() {
    try { this.synth && this.synth.cancel(); } catch { /* ignore */ }
    this.guard = null;
  }
}
