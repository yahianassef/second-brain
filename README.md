# Second Brain

A personal operating system that runs entirely in the browser — no server, no build step, no framework.
Projects, tasks, finances, journal, courses, notes, and a Car Maintenance section that reads and writes
your Google Sheets.

| | |
|---|---|
| **Live app** | https://yahianassef.github.io/second-brain/ |
| **Desktop build** | [`app.html`](app.html) — sidebar layout, kanban board, tables |
| **Phone build** | [`m.html`](m.html) — bottom tabs, sheets, big tap targets |
| **Sheets API** | [`apps-script/Code.gs`](apps-script/Code.gs) — deploy once, see below |

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
- **Cards** — one page per credit card, its charges adding up to what is currently owed
- **Car Maintenance** — **Fuel** and **Service** pages, live from your car spreadsheet
- **Journal** — dated entries, mood tracking, streaks, a 16-week mood heatmap
- **Courses** — lessons completed, progress, deadlines, resources
- **Notes** — categories, tags, pinning, markdown-ish formatting

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

- Reading: **every tab** that has a name column (`Expense Name`, `Item`, `Description`…) and an
  amount column (`Amount in AED`, `Amount in EGP`, `Amount`, `Cost`…). Tabs without such a table,
  like a Summary tab, are ignored. A tab's month comes from its name — `UAE Finances November`,
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
  or exclude a tab entirely with `CONFIG.IGNORE_TABS`.
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
