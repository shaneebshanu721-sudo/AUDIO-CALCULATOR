# Voice Audit Calculator

A mobile-first web app for internal auditors who total physical receipt books, vouchers and cash receipts. Tap **Start Listening** once, speak each voucher amount with a short pause between them, and the app adds every amount to the current receipt book — no typing, no saying “plus”.

- **Version 3.2:** auto-corrects amounts Google splits or glues (“2000 100” or “2000100” → ₹2,100, marked “auto-corrected” on the line) · Voice typing box moved to the top
- **Version 3.1:** **Voice typing box** — dictate with the keyboard’s 🎤 (Gboard): no repeated beeps, and you see/fix the amounts before adding · large-amount check (default above ₹1,00,000) with split suggestions when two amounts run together
- **Version 3:** Quiet mode (one long listening session, far fewer Android beeps) · digit dictation (“four two zero zero”, “four two double zero”) · “4000 200” is offered as ₹4,200 instead of being split silently · ☑ Select to delete several lines · 🗑 Clear book · better Malayalam thousands (നാലായിരത്തി ഇരുനൂറ്)
- **Version 2:** navy & white design · adding-machine **tape** with leaf numbers and running total · automatic leaf numbering (1, 2, 3… from a starting leaf you choose; say “leaf 25” to jump) · big **Undo** that reverses any add/edit/delete · **read-back** of each amount and the total · fast dictation (“588 … 1400 … 600”) · better mixed Malayalam/English recognition
- Separate workspace per Receipt / Voucher / Cash book (number, audit date, first leaf), plus a consolidated grand total
- Every entry keeps its leaf number, amount, optional voucher reference, time, source (voice/manual), the exact speech transcript and remarks
- Edit, delete, undo and clear — totals are always recomputed from the stored entries
- Uncertain voice results go to a **Needs your confirmation** list and are never added silently
- Manual entry always available (numeric keypad)
- CSV export (one book or all books), JSON backup/restore, all data kept on the phone
- Money handled as integer paise; Indian formatting (₹1,25,000.00), thousand / lakh / crore
- No build step, no frameworks, no trackers, no external requests from the app itself

---

## 1. Why the microphone failed before (the `content://` problem)

When an HTML file is opened from the Files app, Downloads, WhatsApp or Gmail, Android Chrome shows it at an address beginning with `content://` (or `file://`). Such a page has **no website origin**, so Chrome has nowhere to store a “this site may use the microphone” permission. It refuses microphone access for that page and the speech API reports `not-allowed` — which the old app displayed as *“Microphone permission was denied”* — **even though the microphone is enabled in Chrome settings**. Your settings were not wrong; the page’s address was.

The fix is to serve the app from a real **https://** website. Both options below are free. (This version also refuses to run silently from a local file: it shows an explanation instead.)

HTTPS is necessary but not sufficient on its own: voice input also needs Chrome’s speech service, an internet connection, and microphone permission for that site. See [docs/SPEECH-RECOGNITION.md](docs/SPEECH-RECOGNITION.md).

---

## 2. Deploy to a free HTTPS address

All app files are in the top folder of this project, with no sub-folders needed:

```
index.html  styles.css  app.js  money.js  parser.js  ledger.js  exporter.js
storage.js  speech.js  readback.js  history.js  sw.js  manifest.webmanifest  icon.svg  icon-192.png
icon-512.png  icon-512-maskable.png  .nojekyll  netlify.toml
```

(`tests/`, `docs/`, `package.json` and `README.md` are optional to upload; uploading them does no harm.)

### Option A — GitHub Pages (works from a PC or from an Android phone)

1. Create a free account at <https://github.com> and sign in.
2. Tap **+ → New repository**. Name it `voice-audit-calculator`, choose **Public** (free Pages requires public — only the app code is public; your audit data never goes to GitHub), tick **Add a README file**, and tap **Create repository**.
3. In the repository tap **Add file → Upload files**.
   - On a PC: drag in all the files listed above.
   - On Android: tap **choose your files** and multi-select the files (they are all in one folder, so this works from the phone). If `.nojekyll` is hidden, skip it — it is not essential.
4. Tap **Commit changes**.
5. Go to **Settings → Pages**. Under *Build and deployment* set **Source: Deploy from a branch**, **Branch: main**, folder **/ (root)**, then **Save**.
6. Wait 1–3 minutes and refresh the Pages screen. Your address appears there, normally:
   `https://YOUR-USERNAME.github.io/voice-audit-calculator/`

### Option B — Netlify Drop (quickest from a PC)

1. Unzip the project on a computer.
2. Go to <https://app.netlify.com/drop>. Sign in or create a free account first so the site stays permanently in your account.
3. Drag the unzipped **voice-audit-calculator** folder onto the page.
4. Netlify gives you an address like `https://something-random.netlify.app` — you can rename it under **Site configuration → Change site name**.

`netlify.toml` adds security headers (Content-Security-Policy, `Permissions-Policy: microphone=(self)`). GitHub Pages ignores it; the page carries an equivalent Content-Security-Policy itself.

> I did not deploy the app to a public URL for you — deployment needs your own GitHub or Netlify account. Follow the steps above; it takes about 5 minutes.

---

## 3. First use on Android Chrome

1. Open the **https://** address in **Google Chrome** (not inside WhatsApp/Gmail’s built-in browser — use ⋮ → *Open in Chrome*).
2. Tap **Start Listening**. Chrome asks *“Allow … to use your microphone?”* → **Allow** (choose *While using the app* if offered).
3. Speak an amount, e.g. “twenty thousand two hundred”. It appears in **Heard**, then in the entry list, and the book total updates.
4. Optional: ⋮ → **Add to Home screen** / **Install app** to open it like an app (it is still the same https site).
5. Open **Microphone diagnostics** at the bottom of the page if anything fails — it shows the page address type, secure context, speech-API availability, the site’s microphone permission and connectivity.

### Granting or resetting microphone access for the site

- Tap the **lock / tune icon** left of the address bar → **Permissions** → **Microphone → Allow**. Reload the page.
- Or Chrome ⋮ → **Settings → Site settings → Microphone** → find your site → **Allow**.
- Also check Android **Settings → Apps → Chrome → Permissions → Microphone → Allow**.

Full guide: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

---

## 4. Daily workflow

1. Pick the book in the top bar, or **+ Book** → type (Receipt / Voucher / Cash), book number, **first leaf no.**, audit date.
2. Tap **Start** once.
3. Say an amount → pause → next amount … Each amount is added to the next leaf, shown on the tape with the running total, and read back (“588, total 10,588”). Turn read-back off with the 🔊 chip.
4. Leaves: numbered automatically. Say **“leaf 25”** (or tap *Next: Leaf …*) to jump; numbering continues 26, 27… You can also say “leaf 7, five hundred eighty eight”, or type a leaf in *Type an amount*.
5. Several plain amounts said quickly (“588 1400 600”) are each added on their own leaf.
6. Anything uncertain (unrecognised words, “fifteen” vs “fifty”, two amounts run together in words, a possible duplicate) goes to **Check these** and is not added until you tap it.
7. **Undo** (button or say “undo”) reverses the last action — add, fast multi-add, edit, delete, clear, new book — step by step. Tap any tape line to edit or delete it.
8. Tap **Stop** when done. The app also stops after 3 minutes of silence or when you switch apps.
7. At the end: **Export → All books (CSV)** and **Download backup (JSON)**.

Speaking tips: say whole amounts (“one lakh twenty five thousand”, “1.25 lakh”); to record a voucher number say it in digits first: “voucher 25 … ten thousand”. “Point” and “paise” work: “five hundred rupees fifty paise”.

---

## 5. What speech recognition can and cannot do

Short version (details in [docs/SPEECH-RECOGNITION.md](docs/SPEECH-RECOGNITION.md)):

| Situation | Result |
|---|---|
| Chrome on Android/desktop, https, online, mic allowed | Works. Recognition done by Google’s speech service. |
| Page opened as `content://` / `file://` / `http://` (not localhost) | Microphone blocked by Chrome. Use the https address. |
| In-app browsers (WhatsApp, Gmail), Firefox, some Samsung Internet versions | Speech API usually missing → manual entry only. |
| Offline | Voice input stops with “internet connection required”; manual entry works; data is safe. |
| The “ting” sound on Android | Played by Android each time listening (re)starts; a web page cannot switch it off. **Quiet mode** (default) keeps one session open across many amounts, so it plays only now and then (after long silences). |
| Manglish (Malayalam + English) | Use the **മലയാളം** button first: Chrome then writes Malayalam numbers in Malayalam script and English numbers as Malayalam-script transliterations (ടെൻ തൗസൻഡ്), both understood. If amounts come out wrong, tap **English**. A setting can make Malayalam-word amounts ask before adding. |

---

## 6. Data, privacy and backups

- Entries are stored only in this browser on this phone (`localStorage`). Nothing is sent to any server by the app. No analytics, ads or trackers; no API keys or credentials in the code.
- Chrome’s speech recognition usually sends your **audio** to Google’s speech service to turn it into text. Only the returned text is used; your entries and totals are never sent with it.
- Browser storage can be lost (clearing site data, uninstalling Chrome, a different phone or browser profile). **It is not a substitute for a secure, backed-up accounting system.** Export CSV and download a JSON backup after each session.
- Restoring a backup validates every field, rejects malformed files and never executes their content.
- **Delete all data on this phone** (in *Export, backup & settings*) removes everything the app stored.

---

## 7. Updating the app after deployment

- **GitHub Pages:** open the repository → **Add file → Upload files** → upload the changed files (same names overwrite) → **Commit changes**. The site updates in 1–3 minutes.
- **Netlify:** your site → **Deploys** → drag the updated folder onto the deploy area.
- On the phone, reload the page (pull down to refresh). The offline cache is network-first, so the newest version loads whenever you are online. Your stored entries are unaffected by updates.
- If you change the speech or parser logic, bump `APP_VERSION` in `app.js` and the `CACHE` name in `sw.js`.
- Data saved by version 1 is upgraded automatically (existing entries get leaves 1, 2, 3… in order).

---

## 8. Running the automated tests (optional, on a computer)

Requires Node.js 18+ (no packages to install):

```
npm test
```

77 tests cover the amount parser (English words, digits, Indian grouping, lakh/crore, decimals/paise, voucher references, Manglish and Malayalam script, never merging two amounts), money formatting and integer-paise sums, receipt-book logic (the ₹52,200 sample, edit to ₹20,250, delete ₹600, independent second book, undo/clear), CSV export (escaping, formula-injection protection, totals), JSON backup validation, storage recovery, and the speech state machine (auto-restart, duplicate events, interim results, permission denied, network failure, restart-loop protection, idle stop), plus an end-to-end smoke test that boots the real UI code against a minimal DOM stand-in and runs the whole auditor workflow. See [docs/TEST-REPORT.md](docs/TEST-REPORT.md) for results and the on-device checklist.

To try it on a computer: `npm run serve` (or `python3 -m http.server 8080`) and open <http://localhost:8080> in Chrome — `localhost` counts as secure, so the mic works there. Opening `http://192.168.x.x:8080` from your phone will **not** allow the mic (not https).

---

## 9. Project structure

| File | Purpose |
|---|---|
| `index.html`, `styles.css` | Page layout and design (dark green/white, light & dark themes) |
| `app.js` | User interface glue |
| `speech.js` | Web Speech API wrapper and session state machine |
| `parser.js` | Transcript → amount parsing (English, digits, Indian numbering, Manglish/Malayalam) |
| `money.js` | Integer-paise arithmetic, Indian formatting, manual input parsing |
| `ledger.js` | Receipt books, entries, pending confirmations, totals |
| `storage.js` | Local persistence and recovery |
| `readback.js` | Speaks amounts/totals in Indian English; echo guard |
| `history.js` | Multi-step Undo |
| `exporter.js` | CSV export, JSON backup and validation |
| `sw.js`, `manifest.webmanifest`, `icon*` | Installable app + offline shell |
| `tests/` | Automated tests (`node --test`) |
| `docs/` | Speech-recognition notes, troubleshooting, test report |
