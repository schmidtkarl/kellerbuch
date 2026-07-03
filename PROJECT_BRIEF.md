# Kellerbuch — Project Brief for Claude Code

## What this is
A wine cellar inventory app for a restaurant (Zippiri, Cologne). Staff type
free-text shorthand notes about wines removed during service or added from
deliveries (e.g. "2x Planeta NdA, 1x Gaja Barbaresco raus"). Claude parses
the text into structured changes, and the app writes those changes to a
Google Sheet that acts as the single source of truth for the cellar inventory.

Runs on a shared iPad (Safari) at the restaurant, accessed via a public
GitHub Pages URL. No login system — single shared device, single shared
Google Sheet.

## Architecture (3 separate pieces, 3 separate platforms)

```
iPad Safari (index.html, hosted on GitHub Pages)
        │
        │  user types wine shorthand, taps "Bestand aktualisieren"
        ▼
Cloudflare Worker (cloudflare-worker.js)
        │  proxies request to Anthropic — avoids Safari CORS block on
        │  direct browser → api.anthropic.com calls
        ▼
Anthropic API (claude-sonnet-4-6)
        │  parses free text into structured JSON: [{action, producer,
        │  wine, vintage, quantity}, ...]
        ▼
back to browser → browser POSTs the parsed changes to:
        ▼
Google Apps Script Web App (apps-script.js, lives inside the Google Sheet)
        │  reads/writes the actual spreadsheet rows
        ▼
Google Sheet (columns: Producer | Wine | Vintage | Quantity)
```

## Current live endpoints
- **Frontend (GitHub Pages):** https://firestarter-karl.github.io/kellerbuch
  - Repo: github.com/firestarter-karl/kellerbuch, file is `index.html` in root
- **Cloudflare Worker proxy:** https://kellerbuch-proxy.karljasperschmidt.workers.dev
- **Google Apps Script (test sheet):** https://script.google.com/macros/s/AKfycbzZla_YdRgm9jItgAVA-BzxWM39dV6tySg4d55B4WzLZ709FwbmVWKJ93LfF_ns6IWi/exec
  - This currently points at a **personal test Google Sheet**, not the real
    Zippiri restaurant sheet, because the Zippiri Google account
    (personal.zippiri@gmail.com) isn't accessible from the developer's home
    setup. When ready to go live at the restaurant, this whole Apps Script
    setup needs to be redone on the Zippiri account, pointed at the real
    cellar inventory sheet, and the new URL swapped into index.html.

## Key design decisions / constraints (don't relitigate these)
- **Vintage is part of the matching key (superseded, see CLAUDE.md).** An
  earlier version deliberately excluded vintage from matching after a bug
  where it silently failed to update quantities (null vintage never matched
  a stored value). That's since been fixed properly: apps-script.js now
  normalizes blank/null vintage to an explicit "" bucket before comparing,
  so producer+wine+vintage matching works without that failure mode. Legacy
  rows with no vintage aren't backfilled — they just live in the "" bucket.
  index.html auto-fills the vintage on removal when only one is in stock,
  and prompts for a pick when multiple vintages exist.
- **Default action is "remove."** If the typed text doesn't contain an
  explicit add/delivery signal (+, "Lieferung", "geliefert", "rein",
  "bekommen", etc.), the system prompt tells Claude to assume the wine was
  removed during service. Removals are the common case.
- **Italian-biased name correction.** The cellar is almost entirely Italian
  wines plus some German/Austrian — no Spanish or French. The system prompt
  tells Claude to favor Italian naming conventions when resolving
  abbreviations or typos (e.g. "NdA" → Nero d'Avola), but explicitly NOT to
  substitute one real wine for a different, more famous one (e.g. never
  silently turn "Barbaresco" into "Barolo").
- **No `mode: "no-cors"` on the Sheets POST.** An earlier version used
  `no-cors`, which silently discarded the response and made failures
  invisible. Current version reads the real JSON response from Apps Script
  so errors actually surface in the UI.
- **API key stored in browser localStorage**, entered once via a setup
  screen on first load. Not a "real" auth system — fine for a single shared
  device, would need rethinking for any multi-device or public deployment.

## Known resolved bugs (context for why the code looks the way it does)
1. Buttons didn't respond on GitHub Pages → root cause was inline `onclick=`
   attributes being unreliable; rewritten to use `addEventListener`.
2. Apps Script returned a Google login page instead of JSON → deployment
   "who has access" wasn't actually set to "Anyone"; had to redeploy.
3. `Cannot read properties of null (reading 'toLowerCase')` in Apps Script →
   empty/blank rows in the sheet crashed the matching loop; fixed by
   wrapping all `.toLowerCase()` calls in `String(... || "")`.
4. Quantities silently not updating → root cause was vintage being included
   in the match condition; when the user didn't say a vintage, it sent
   `null` which never matched the sheet's stored vintage. Fixed by dropping
   vintage from matching entirely (see "Key design decisions" above).
5. `JSON parse error: Unrecognized token` → Claude was wrapping its JSON
   response in markdown code fences (```json ... ```); fixed by both
   stripping fences defensively in the JS and reinforcing "no markdown" in
   the system prompt.
6. Direct browser → Anthropic API calls failed with "Load failed" (a CORS
   block) even with the `anthropic-dangerous-direct-browser-calls` header →
   solved by routing through the Cloudflare Worker proxy instead.
7. Speech-to-text (original input method) was unreliable for uncommon
   Italian wine names and got mangled by Safari's dictation engine → the
   whole voice input approach was abandoned in favor of free-text typing,
   which sidesteps the transcription problem entirely.

## What's NOT yet done / open items
- The Apps Script + Google Sheet still need to be redone on the real
  Zippiri Google account once the developer has access to it again (e.g.
  at the restaurant). The test sheet currently in use is a placeholder.
- No CSV export currently wired up in the text-input version of the app
  (existed in an earlier voice-based version, may be worth re-adding).
- No manual inventory editing has been re-tested since the input method
  switch from voice to text (the edit modal code path should still work,
  but hasn't been explicitly verified in this session).
- No automated tests of any kind — every fix so far has been manually
  verified by the developer typing into the live iPad app and checking the
  Google Sheet by hand.

## Files in this folder
- `index.html` — the full frontend app (single file, vanilla JS, no build
  step, no framework). This is what gets deployed to GitHub Pages as-is.
- `apps-script.js` — paste this into the Google Sheet's Apps Script editor
  (Extensions → Apps Script). Not run directly with Node — it's Google's
  own JS-like runtime (uses `SpreadsheetApp`, `ContentService`, etc., which
  only exist inside Apps Script).
- `cloudflare-worker.js` — paste this into the Cloudflare Workers dashboard
  editor for the `kellerbuch-proxy` worker. Uses the Workers runtime
  (`export default { async fetch(request) {...} }`), not a normal Node
  server.
