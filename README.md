# Second Brain

A personal operating system that runs entirely in the browser — no server, no build step, no framework.
Projects, tasks, habits, studying, exercising, finances, journal, courses, notes, and a Car Maintenance
section that reads and writes your Google Sheets.

| | |
|---|---|
| **Live site** | https://yahianassef.github.io/second-brain/ |
| **Landing page** | [`index.html`](index.html) — what the site opens on, with a link into the app |
| **Desktop build** | [`app.html`](app.html) — sidebar layout, kanban board, tables |
| **Phone build** | [`m.html`](m.html) — bottom tabs, sheets, big tap targets |
| **Sheets API** | [`apps-script/Code.gs`](apps-script/Code.gs) — deploy once, see below |

The landing page sends you to the build that fits your screen. **Skip this page next time** on it stores a
flag in your browser, after which the site opens the app directly — add `?stay=1` to the address to see the
landing page again.

Both builds share the same data model, the same form schemas and the same sync engine, so anything you
add on one device shows up on the others.

---

## Sections

- **Dashboard** — stats, upcoming deadlines across everything, today's tasks, cash-flow chart
- **Projects** — status, priority, area, progress, deadlines, linked task counts, kanban board
- **Tasks** — priorities, due dates, grouping (overdue / today / this week), project links
- **Finances** — transactions, budgets vs. actual, savings goals, and a live **Google Sheet** tab.
  Each month's page carries a spending-by-category chart, and the list sorts by date, amount or
  category — the last of which groups rows under category subtotals.
  Every monthly tab of the expenses workbook is read as history; the dashboard always shows the
  month you are in, and the range picker (this month / 3 months / year / all time) reaches back
  through every tab
- **Cards** — a rail of card tiles: pick one (or **All cards**) and flip between them with the ‹ › buttons,
  the **← →** keys, or a **swipe** on the phone. Each card shows what is owed, the credit available
  (read from the tab's own *Current Credit Available* cell), how much of the line is in use, its open
  charges by category, and every charge filterable by **All / Open / Paid**. The last card viewed is remembered.
- **Car Maintenance** — **Fuel** and **Service** pages, live from your car spreadsheet. Fuel and service can
  sit on separate tabs or be stacked on one; each table is found by its header row, so a service log on its
  own tab is read, and new entries are written back to the tab they belong on.
- **Habits** — a daily checklist, per-habit colours and weekly targets (*days per week*), current and best
  streaks, a 30-day keep rate, and a **calendar heatmap** of every habit at once or one habit on its own.
  Pick a single habit and any day on the map becomes a tick box, so a missed evening can be filled in later
- **Studying** — log a session (subject, minutes, session type, optional course link, what you covered),
  and the section keeps the week against your hours-per-week target, the study streak, a subject breakdown
  for the month and a **heatmap of the days you studied**. Clicking an empty day opens a session prefilled
  with that date
- **Exercising** — the same shape for workouts (type, focus, minutes, intensity, optional distance), with
  workouts-per-week against target, streaks and rest days, the month's split by workout type and its own
  **heatmap**
- **Journal** — dated entries, mood tracking, streaks, a 16-week mood heatmap
- **Courses** — lessons completed, progress, deadlines, resources
- **Notes** — categories, tags, pinning, markdown-ish formatting

Every heatmap has a **Month** and a **Year** view: the month view is a calendar of the days themselves, and
the year view is the same shading across twelve mini months. Shading is relative — the busiest day in view
is the brightest — and the weekly targets for studying and exercising live in **Settings**.

On the phone build, Habits, Studying and Exercising sit under **More**, with today's checklist and both
quick-log buttons on the Home screen.

---

## Syncing

There are two independent sync paths. Use either or both.

### 1. Google Sheets (car + expenses + everything else)

A Google Apps Script Web App acts as the API. It is the only piece that can hold Google credentials,
and it runs under **your** account.

**Setup, once:**

> **Updating an existing deployment:** copy your current `CONFIG` values out first, paste the new
> `Code.gs` over the old one, put the values back, then **Deploy → Manage deployments → ✏️ →
> Version: New version → Deploy**. The URL and secret stay the same, so the apps need no changes.

1. Open [script.google.com](https://script.google.com) → **New project**.
2. Replace `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs) from this repo.
3. At the top of the file fill in `CONFIG`:
   - `SECRET` — any long random string you invent
   - `CAR_SHEET_ID` — from your car sheet's URL: `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`
   - `EXPENSES_SHEET_ID` — same, from the expenses workbook
4. **Deploy → New deployment → Web app**
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**  ← required, the browser calls it directly
5. Authorise when prompted (it is your own script, so Google shows the "unverified app" screen —
   choose *Advanced → Go to project*).
6. Copy the **/exec** URL.
7. In the app: **Settings → Google Sheets sync**, paste the URL and the same secret, press *Save & test*.

On another device, open the same panel and press **Copy setup code** on a device that already works,
then paste that code — no retyping.

**What flows where**

| Source | Destination | How fast |
|---|---|---|
| Edit in Google Sheets | every device | ≤ 15s while the app is open |
| Add/edit/delete in the app | Google Sheets | immediately |
| Any app data (tasks, notes…) | other devices | ≤ 15s |

**How expenses map to tabs**

- Reading: **every tab** with a name column (`Expense Name`, `Payments`, `Item`, `Description`…).
  The amount and date columns are found by **what they contain**, not by their headers — real
  sheets leave those headers blank, and a labelled-but-empty `Amount in AED` column loses to the
  column that actually holds the numbers. Currency is read from how the amounts are *displayed*
  (`AED15.00`, `EGP 250.00`), since the cells are formatted numbers. A tab's month comes from its name — `UAE Finances November`,
  `Nov 2025` and `2025-11` all work — and tabs named by month alone get their year by counting
  forward from the first tab, so a January after a December belongs to the next year.
- A row with no date inherits the first of its tab's month, so undated history still charts.
- Writing: an expense logged in the app goes to the tab **for its own date**. If that month has no
  tab yet, one is created by copying the newest tab's layout and renaming it (`UAE Finances
  December`), with the year added when a month name would otherwise repeat.
- Editing or deleting a row acts on the tab that row came from, not on whichever tab is newest.
- Currency follows the tab: `Amount in EGP` tabs are EGP, the rest AED. The finance views show one
  currency at a time (AED by default) with a switcher when both exist.
- **Credit-card tabs** (a charges table whose name has no month in it, like `ADCB Visa`) are read
  as debts, never as expenses: the current debt is the sum of their charges, skipping the tab's own
  total row and anything marked in a `Paid`/`Status` column. They are kept out of expense totals on
  purpose — the payment you copy into a month tab is what counts as the expense, so counting the
  charges too would double up. Name them explicitly with `CONFIG.CARD_TABS` if the guess is wrong,
  or exclude a tab entirely with `CONFIG.IGNORE_TABS`. Both accept globs, so `IGNORE_TABS: '*egypt*'`
  drops every Egypt tab, and naming your cards in `CARD_TABS` also keeps scratch tabs (Draft,
  Calculations, Wishlist…) out of the app entirely.
- A card's debt is the sum of its unpaid charges; a `Payment Status` of `Paid` takes a row out of
  the total while leaving it listed.
- `apps-script/test-layouts.html` runs the reader against mock sheets shaped like real ones — open
  it next to a checkout to check a layout change without touching your data.
- Income stays in the app, since these sheets hold expenses only. It syncs between devices through
  the hidden `SecondBrain_Data` tab and appears in the app's totals alongside sheet expenses.

The app polls a cheap "has anything changed?" probe every 15 seconds and only downloads the full
workbook when a sheet actually changed — this keeps it well inside the Apps Script free runtime quota.

> **Security:** "Anyone" means anyone who knows the URL can call the script, so the `SECRET` is what
> actually protects your data. Use a long random one. Revoke any time with
> *Deploy → Manage deployments → Archive*.

### 2. GitHub Gist (app data only, no Google account needed)

**Settings → Sync with GitHub**. Paste a personal access token with **only the `gist` scope**. The app
keeps one secret gist in step across devices. Merging is per item — the most recently edited version of
each task, note or transaction wins, and deletions are remembered for 120 days so they cannot reappear.

---

## Running it locally

Download `app.html` (or `m.html`) and open it. That is the whole application — one file, no
dependencies, works offline. It keeps syncing with your other devices through whichever sync you set up.

## Data storage

Everything lives in the browser's `localStorage`, plus whichever sync you connect. **Settings → Backup**
exports a full JSON backup and imports it back. Every section also exports CSV whose columns match the
matching tab of the companion `Second Brain.xlsx` workbook.

## Privacy

No analytics, no third-party scripts, no CDN requests. The app talks to exactly two hosts, and only if
you connect them: `api.github.com` and your own `script.google.com` deployment. Tokens are stored in
your browser only, never in this repository.
