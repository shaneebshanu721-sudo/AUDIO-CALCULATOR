// speech.js — Web Speech API wrapper with an explicit session state machine.
//
// Why a state machine: Chrome (especially on Android) ends a recognition session
// on its own after a pause, after an error, or randomly. To give "tap once, keep
// talking" behaviour we open a fresh recognition session each time one ends,
// unless the user stopped, permission was denied, or the service keeps failing.
//
// Safety properties:
//  * Only FINAL results are reported via onFinal. Interim text goes to onInterim.
//  * Each final result is reported at most once (tracked per session + result index).
//  * Events from an old session object are ignored after a new one is opened.
//  * The same text arriving again within DUPLICATE_WINDOW_MS is flagged
//    `possibleDuplicate` so the app asks instead of auto-adding it.
//  * Permanent errors (permission denied, no microphone, unsupported language)
//    never auto-restart. Repeated failures pause with a Retry option — no infinite loops.

export const STATES = Object.freeze({
  OFF: 'off',               // not listening, by user choice
  STARTING: 'starting',     // session requested, waiting for audio to start
  LISTENING: 'listening',   // microphone is actually capturing
  RESTARTING: 'restarting', // a session ended; a new one will open shortly
  ERROR: 'error',           // stopped because of a problem; user action needed
});

export const DUPLICATE_WINDOW_MS = 1500;
const RESTART_DELAY_MS = 300;
const START_TIMEOUT_MS = 7000;
const MAX_NETWORK_RETRIES = 3;
const MAX_EMPTY_RESTARTS = 8;
const EMPTY_RESTART_WINDOW_MS = 20000;
const RAPID_END_MS = 4000;          // a session shorter than this with no result counts as a failure
export const IDLE_STOP_MS = 3 * 60 * 1000; // stop after 3 minutes without any recognised speech

export const MESSAGES = {
  off: 'Microphone is off.',
  starting: 'Starting microphone…',
  listening: 'Listening — say the next amount.',
  restarting: 'Speech session ended; resuming…',
  'no-speech': 'No speech detected — still listening.',
  unsupported: 'Speech recognition is not supported in this browser. Use manual entry, or open the app in Google Chrome.',
  denied: 'Microphone permission denied for this site. Allow it in Chrome (lock icon → Permissions → Microphone), then tap Retry.',
  'service-denied': 'Speech recognition service was blocked by the browser. Check Chrome settings and that Google speech services are enabled, then tap Retry.',
  'no-mic': 'No microphone was found or it is used by another app. Close other apps using the mic, then tap Retry.',
  network: 'Speech recognition needs an internet connection (Chrome sends audio to Google’s speech service). Reconnect, then tap Retry.',
  'network-retry': 'Speech service unreachable — retrying…',
  language: 'This language is not supported by the speech service on this device. Choose another language.',
  unstable: 'Speech recognition keeps stopping. Paused to avoid a loop — tap Retry, or use manual entry.',
  'start-failed': 'Could not start speech recognition. Tap Retry.',
  idle: 'Stopped after 3 minutes without speech (saves battery). Tap Start to continue.',
};

/** Returns the SpeechRecognition constructor, or null when unsupported. */
export function getRecognitionCtor(win = globalThis) {
  return (win && (win.SpeechRecognition || win.webkitSpeechRecognition)) || null;
}

const normText = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

export class SpeechController {
  /**
   * @param {object} opts
   * @param {Function|null} opts.Recognition  SpeechRecognition constructor
   * @param {(s:{state:string, code:string, message:string, canRetry:boolean})=>void} opts.onStatus
   * @param {(text:string)=>void} [opts.onInterim]
   * @param {(r:{transcript:string, alternatives:{transcript:string,confidence:number}[], confidence:number, sessionId:number, resultIndex:number, possibleDuplicate:boolean})=>void} opts.onFinal
   */
  constructor({ Recognition, onStatus, onInterim = () => {}, onFinal, lang = 'en-IN', mode = 'phrase', timers, now } = {}) {
    this.Recognition = Recognition || null;
    this.onStatus = onStatus || (() => {});
    this.onInterim = onInterim;
    this.onFinal = onFinal || (() => {});
    this.lang = lang;
    this.mode = mode;
    this.timers = timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
    this.now = now || (() => Date.now());
    this.state = STATES.OFF;
    this.wanted = false;
    this.rec = null;
    this.sessionId = 0;
    this.restartTimer = null;
    this.startTimer = null;
    this.stopTimer = null;
    this.lastFinal = null;
    this._resetCounters();
  }

  get supported() { return !!this.Recognition; }

  _resetCounters() {
    this.networkFails = 0;
    this.emptyEnds = [];
  }

  _emit(state, code, canRetry = false) {
    this.state = state;
    this.onStatus({ state, code, message: MESSAGES[code] || code, canRetry });
  }

  setLang(lang) { this.lang = lang; this._restartIfActive(); }
  setMode(mode) { this.mode = mode; this._restartIfActive(); }
  _restartIfActive() { if (this.wanted && this.rec) { try { this.rec.abort(); } catch { /* ignore */ } } }

  start() {
    if (!this.Recognition) { this.wanted = false; this._emit(STATES.ERROR, 'unsupported'); return false; }
    if (this.wanted && this.state !== STATES.ERROR) return true;
    this.wanted = true;
    this._resetCounters();
    this.lastActivity = this.now();
    this._open();
    return true;
  }

  stop() {
    this.wanted = false;
    this._clearTimers();
    const rec = this.rec;
    if (rec) {
      // stop() lets an utterance already spoken be finalised; abort if it hangs.
      try { rec.stop(); } catch { /* ignore */ }
      this.stopTimer = this.timers.setTimeout(() => {
        if (this.rec === rec) { try { rec.abort(); } catch { /* ignore */ } this.rec = null; }
      }, 1500);
    }
    this.onInterim('');
    this._emit(STATES.OFF, 'off');
  }

  _clearTimers() {
    for (const k of ['restartTimer', 'startTimer', 'stopTimer']) {
      if (this[k]) { this.timers.clearTimeout(this[k]); this[k] = null; }
    }
  }

  _open() {
    this._clearTimers();
    let rec;
    try {
      rec = new this.Recognition();
    } catch {
      this.wanted = false;
      this._emit(STATES.ERROR, 'start-failed', true);
      return;
    }
    const session = { id: ++this.sessionId, processed: new Set(), gotFinal: false, fatal: null, aborted: false, openedAt: this.now() };
    this.rec = rec;
    this.session = session;
    rec.lang = this.lang;
    rec.continuous = this.mode === 'continuous';
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    const current = () => this.rec === rec;

    rec.onstart = () => {
      if (!current()) return;
      if (this.startTimer) { this.timers.clearTimeout(this.startTimer); this.startTimer = null; }
      if (this.wanted) this._emit(STATES.LISTENING, 'listening');
    };
    rec.onresult = (ev) => { if (current()) this._handleResult(ev, session); };
    rec.onerror = (ev) => { if (current()) this._handleError(ev, session); };
    rec.onend = () => { if (current()) this._handleEnd(session); };

    this._emit(this.state === STATES.RESTARTING ? STATES.RESTARTING : STATES.STARTING, this.state === STATES.RESTARTING ? 'restarting' : 'starting');
    try {
      rec.start();
    } catch {
      // InvalidStateError etc. — treat like an empty session end and retry with limits.
      this.rec = null;
      this._scheduleRestart(session, RESTART_DELAY_MS * 3);
      return;
    }
    this.startTimer = this.timers.setTimeout(() => {
      if (current() && this.state !== STATES.LISTENING) { try { rec.abort(); } catch { /* ignore */ } }
    }, START_TIMEOUT_MS);
  }

  _handleResult(ev, session) {
    if (!ev || !ev.results) return;
    let interim = '';
    for (let i = ev.resultIndex || 0; i < ev.results.length; i++) {
      const res = ev.results[i];
      if (!res || !res[0]) continue;
      if (!res.isFinal) { interim += res[0].transcript; continue; }
      if (session.processed.has(i)) continue; // same final delivered again
      session.processed.add(i);
      const alternatives = [];
      for (let a = 0; a < res.length; a++) alternatives.push({ transcript: String(res[a].transcript || ''), confidence: Number(res[a].confidence) || 0 });
      const transcript = alternatives[0].transcript.trim();
      if (!transcript) continue;
      const t = this.now();
      const possibleDuplicate = !!(this.lastFinal && this.lastFinal.text === normText(transcript) && t - this.lastFinal.time < DUPLICATE_WINDOW_MS);
      this.lastFinal = { text: normText(transcript), time: t };
      session.gotFinal = true;
      this.lastActivity = t;
      this.networkFails = 0;
      this.emptyEnds = [];
      this.onInterim('');
      this.onFinal({ transcript, alternatives, confidence: alternatives[0].confidence, sessionId: session.id, resultIndex: i, possibleDuplicate });
    }
    if (interim) this.onInterim(interim);
  }

  _handleError(ev, session) {
    const code = ev && ev.error;
    switch (code) {
      case 'no-speech':
        if (this.wanted) this.onStatus({ state: this.state, code: 'no-speech', message: MESSAGES['no-speech'], canRetry: false });
        break;
      case 'aborted':
        session.aborted = true;
        break;
      case 'not-allowed':
        session.fatal = 'denied';
        break;
      case 'service-not-allowed':
        session.fatal = 'service-denied';
        break;
      case 'audio-capture':
        session.fatal = 'no-mic';
        break;
      case 'language-not-supported':
        session.fatal = 'language';
        break;
      case 'network':
        this.networkFails++;
        if (this.networkFails >= MAX_NETWORK_RETRIES) session.fatal = 'network';
        else session.networkRetry = true;
        break;
      default:
        break; // other errors: the end handler restarts within limits
    }
  }

  _handleEnd(session) {
    this.rec = null;
    if (this.startTimer) { this.timers.clearTimeout(this.startTimer); this.startTimer = null; }
    if (this.stopTimer) { this.timers.clearTimeout(this.stopTimer); this.stopTimer = null; }
    this.onInterim('');
    if (session.fatal) {
      this.wanted = false;
      this._emit(STATES.ERROR, session.fatal, session.fatal !== 'language');
      return;
    }
    if (!this.wanted) {
      if (this.state !== STATES.ERROR) this._emit(STATES.OFF, 'off');
      return;
    }
    const delay = session.networkRetry ? 1500 * this.networkFails : RESTART_DELAY_MS;
    this._scheduleRestart(session, delay);
  }

  _scheduleRestart(session, delay) {
    const t = this.now();
    if (t - (this.lastActivity ?? t) > IDLE_STOP_MS) {
      this.wanted = false;
      this._emit(STATES.OFF, 'idle');
      return;
    }
    if (!session.gotFinal && t - session.openedAt < RAPID_END_MS) {
      this.emptyEnds = this.emptyEnds.filter((x) => t - x < EMPTY_RESTART_WINDOW_MS);
      this.emptyEnds.push(t);
      if (this.emptyEnds.length >= MAX_EMPTY_RESTARTS) {
        this.wanted = false;
        this._emit(STATES.ERROR, 'unstable', true);
        return;
      }
    }
    this._emit(STATES.RESTARTING, session.networkRetry ? 'network-retry' : 'restarting');
    this.restartTimer = this.timers.setTimeout(() => {
      this.restartTimer = null;
      if (this.wanted) this._open();
    }, delay);
  }
}
