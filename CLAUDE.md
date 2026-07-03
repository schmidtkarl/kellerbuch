# Kellerbuch — Project Context for Claude Code

## What this is

Kellerbuch is a wine cellar inventory system built for Zippiri (restaurant, Cologne).
It tracks what's in the physical cellar, and is expanding into a bridge between the
restaurant's cellar and Zippiri's Shopify webshop, which currently share the same
physical stock — a frequent source of overselling and frustration.

Owner/operator: Karl. Non-technical colleagues use the app day-to-day at the
restaurant; Karl is the only one who touches code/config.

## Current architecture (as built)

- **Frontend:** standalone JavaScript app, hosted on GitHub Pages
  (`firestarter-karl.github.io/kellerbuch`). No framework dependency assumed —
  check the repo before assuming React/Vue/etc.
- **Backend:** Google Apps Script, exposed as an API.
- **Proxy:** Cloudflare Worker sits in front of the Apps Script API, added
  specifically to work around Safari CORS issues. Don't remove this layer
  without testing Safari specifically.
- **Data store:** Google Sheets is the single source of truth. "Sheet1" is the
  simple/lightweight sheet the restaurant-facing app reads and writes against.
- **Known open task:** the Apps Script is not yet reconnected to the real Zippiri
  Google account (`personal.zippiri@gmail.com`) — currently running against a
  personal/test account. This should be fixed before any Shopify-facing work
  goes live, since the bridge depends on the canonical account being correct.

## Core data model — current state and active migration

**Current matching key:** producer + wine name (string match, with name
correction biased toward Italian wine-naming conventions, since most of the
list is Italian).

**Active change — vintage is becoming part of the matching key.**
This is a deliberate, in-progress migration, not a future nice-to-have:

- New key: producer + name + vintage.
- Vintage is **mandatory** on every removal going forward.
- **Legacy rows** (added before this migration) have no vintage and are left
  as-is — no backfill. They'll naturally resolve to "vintage: unknown" and
  phase out as stock turns over, starting from the month-end physical
  stock-take (see below). Don't write migration scripts to backfill historical
  vintage data; this was an explicit decision.
- Restaurant-facing UI should still show a simple aggregated bottle count per
  wine (summed across vintages) — colleagues serving a table don't need to
  think about vintage unless prompted.

**Removal UX rule:** when a colleague removes a bottle, if only one vintage of
that wine is currently in stock, auto-fill it (zero extra friction). If
multiple vintages are in stock, prompt for a selection — this is the moment
that matters most for downstream Shopify accuracy, so don't let convenience
override correctness here.

**Existing removal/addition logic** (still applies): defaults to "remove"
absent a clear delivery signal. This logic needs to be revisited carefully
once vintage is part of the key — it currently operates at the
producer+name level only.

## Data architecture — single sheet, one row per wine variant

**Decision (supersedes an earlier two-sheet draft of this doc):** there is one
central sheet, not two. One row = one producer + name + vintage combination.
Every consumer (Kellerbuch's restaurant-facing quick-fill, the Shopify sync,
a future social-content pusher) reads/writes only the columns it needs from
this single sheet — nobody gets their own copy of wine data.

**Why this replaced the two-sheet plan:** the original design had a
restaurant-facing "Sheet1" and a richer Shopify-facing "Sheet2," kept in sync.
That meant duplicate data and reconciliation logic for no real benefit — a
single sheet with optional columns achieves the same goal (lightweight
restaurant view, rich Shopify view) without two sources of truth to keep
aligned.

**Schema — wine master sheet (one row per producer + name + vintage):**

| Field | Type | Mandatory | Notes |
|---|---|---|---|
| Producer | text | yes | part of row key |
| Wine name | text | yes | part of row key |
| Vintage | text/number | yes (going forward) | part of row key; legacy rows may be "unknown" — no backfill, see migration note above |
| Current bottle count | number | yes | the operational number every app reads |
| Region | text | optional | |
| Country | text | optional | |
| Grape varieties | multi-value | optional | comma-separated; wines are often blends — never force a single value |
| Acidity | enum: low / medium / high | optional | |
| Flavour profile | free text | optional | |
| Buying price (Einkaufspreis) | number | optional | |
| Agent/Retailer | text | optional | blank or "Direktimport" for direct import — don't force a retailer name |
| Shopify webshop price | number | optional | only populated if the wine is listed on Shopify |
| Restaurant menu price | number | optional | |
| Price per glass | **computed** | — | `menu price ÷ 5` (0.15L pour ÷ 0.75L bottle = 5 glasses/bottle). Don't store this as raw input — derive it, so it can't drift out of sync with menu price. |
| Shopify product/variant ID | text | optional | only populated if listed on Shopify; this is the join key for the sync |

**Kellerbuch's restaurant-facing UI** only ever reads/writes producer + name +
vintage + bottle count from this sheet — the rest of the columns exist for
Shopify and future consumers, but colleagues at the iPad never need to see
them.

**Stock-take deltas and theft-flagging are NOT part of this sheet.** They're
event/log data (what happened, when), structurally different from the wine
master data (what is true about a wine right now). Keep this as a separate
tab in the same spreadsheet file — not a competing source of truth, just a
different kind of data with different cardinality (many events over time per
wine, vs. one current row per wine).

## Shopify bridge — top priority, in design

**Problem:** one physical cellar serves both the restaurant (reserve) and the
Shopify webshop (retail). Bottles get sold online that are no longer
physically available, because the two systems don't talk to each other.

**Design:**
- **Sync direction: two-way.**
  - Kellerbuch → Shopify: cellar stock levels (from the master sheet) push to
    Shopify inventory, keyed by Shopify product/variant ID.
  - Shopify → Kellerbuch: a Shopify sale reduces the bottle count on the
    matching row (producer + name + vintage) in the master sheet.
- **Sync frequency: once daily (v1).** Known and accepted limitation: there's
  up to a 24h window where a bottle could be served in-house or sold online
  before the other side reflects it. This is a deliberate v1 tradeoff, not an
  oversight — revisit frequency only after the bridge is proven stable.
- **Concurrency note:** once Shopify sales, restaurant removals, and
  (eventually) a content app can all touch the same sheet, exactly one
  gatekeeper should own writes — the existing Apps Script API. Don't let the
  Shopify sync or any future app write to the Google Sheet directly; route
  everything through Apps Script so collisions (e.g. a Shopify sale and a
  restaurant removal on the same row at the same moment) are handled in one
  place.

## iPad stock-take feature — replacing pen-and-paper counting

Goal: replace manual paper tallying with a fast, ipad-friendly entry screen,
used physically in the cellar.

**Per-wine entry screen:**
- Header line, reference only (not an input): `Sollten {expected_count}
  Flaschen sein` — pulled from current Kellerbuch tally.
- Blank tally inputs:
  - **Boxes** — standard case is 6 × 0.75L bottles. Entering "1 box" = 6
    bottles.
  - **Loose bottles** — bottles stored outside boxes for quick access.
  - **Loose magnums** — tracked as standalone units, no box multiplier (no
    "magnum boxes" concept — confirmed explicitly, don't add one).
- **Computed counted total** = `(boxes × 6) + loose bottles` (magnums tracked
  and shown separately, not folded into the bottle-equivalent count unless
  Karl asks for that later).
- **Delta vs. expected** is computed and **flagged visibly** — this is not a
  silent overwrite. A mismatch can indicate theft or just operational drift,
  and the point of flagging it is to make it noticeable in the moment, not
  buried in a spreadsheet.
- After review, the counted total becomes the new authoritative stock count
  (overwrites the old expected value) — but only after being surfaced, not
  automatically.

**Discrepancy Log — a second tab in the same workbook (not a second sheet
file, not a competing source of truth).** Only gets a row when a stock-take
produces a delta — wines that match their expected count don't get logged.
This keeps the log lean and directly actionable rather than a full audit
trail of every count.

| Field | Notes |
|---|---|
| Date | when the stock-take happened |
| Producer | |
| Wine name | |
| Vintage | |
| Expected count | what the sheet said before counting |
| Counted count | boxes × 6 + loose bottles + loose magnums |
| Delta | counted − expected (negative = missing, positive = surplus) |
| Status | default "Unreviewed"; Karl updates later to e.g. "Investigated — theft suspected," "Miscount, corrected," "Resolved" |

The `Status` column is what makes this useful over time — without it, a flag
seen once and forgotten can't later be cross-referenced for a recurring
pattern (same wine, same time period, same staff shift, etc.).

**No backfill of historical vintage data is happening via this feature** —
it's a forward-looking count. The first real stock-take is planned for
month-end.

## Weekly performance dashboard

- Lightweight, embedded in the existing Kellerbuch app (not a separate tool).
- Ranks wines by bottles removed over the past week.
- **Scope: restaurant-service removals only — explicitly excludes Shopify
  sales.** This is intentional: the dashboard is meant to reflect what's
  actually moving at the table (useful for pairing/by-the-glass decisions),
  not overall demand including the webshop. Don't merge the two removal
  sources into one ranking unless asked.

## Terminology / glossary

- **Sollten X Flaschen sein** — "should be X bottles" — the expected-count
  reference line shown during stock-take, German phrasing intentional (used
  by restaurant staff, not just Karl).
- **Box** — a standard case of 6 × 0.75L bottles, except magnums which are
  never boxed in this system.

## Working conventions

- Karl reviews diffs before anything is pushed to `main` — small commits,
  no direct unreviewed pushes given this is a live tool in use at the
  restaurant.
- Prioritization order for upcoming work: (1) Shopify bridge + vintage
  migration together, since they're entangled, (2) iPad stock-take feature,
  (3) weekly dashboard. Confirm with Karl before resequencing.
- When in doubt about a UX tradeoff between speed (for restaurant colleagues
  entering data quickly) and precision (for Shopify accuracy), default to
  asking Karl rather than guessing — several past decisions in this doc were
  explicit tradeoffs, not defaults.
