/**
 * Second Brain — Google Sheets sync API
 * =====================================
 * v6 — columns are found by what they contain, not only by their header:
 *      these sheets leave the amount and date headers blank. Card tabs use
 *      "Payments" as their name column. CARD_TABS / IGNORE_TABS accept globs
 *      such as "*egypt*".
 * v5 — credit-card tabs (any charges table whose name has no month in it) are
 *      read as debts and kept out of the expense history, so a card payment
 *      copied into a month tab is not counted twice.
 * v4 — reads EVERY monthly expense tab (full history, not just the newest),
 *      writes each expense into the tab for its own month (creating it when
 *      needed), and applies edits and deletions to the tab the row lives in.
 *
 * Deploy this once as a Web App. It gives the Second Brain apps (GitHub Pages,
 * phone, and the standalone HTML file) read/write access to your sheets,
 * so edits flow both ways.
 *
 * KEEPING YOUR SETTINGS: put them in a second file (File → + → Script, name it
 * "Config") containing one line:
 *     var USER_CONFIG = { SECRET: 'your secret', CAR_SHEET_ID: '…', EXPENSES_SHEET_ID: '…' };
 * Then updating is just: select all in Code.gs, paste the new version, redeploy.
 *
 * SETUP (about 3 minutes)
 *  1. Go to script.google.com → New project → paste this file over Code.gs
 *  2. Put your own IDs in CONFIG below (they are already filled in for you).
 *  3. Deploy → New deployment → type "Web app"
 *       Execute as:      Me
 *       Who has access:  Anyone            ← required; the app calls it from the browser
 *  4. Copy the /exec URL it gives you and paste it into the app:
 *       Settings → Google Sheets sync → Web App URL
 *  5. Set a SECRET below and paste the same secret into the app.
 *
 * SECURITY NOTE: "Anyone" means anyone who knows the URL can call it, so the
 * SECRET below is what actually protects your data. Use a long random string.
 * You can revoke access at any time: Deploy → Manage deployments → Archive.
 */

var CONFIG = {
  // A long random string. The app must send the same value. CHANGE THIS.
  SECRET: 'CHANGE-ME-to-a-long-random-string',

  // "Hyundai Elantra" — the car log
  CAR_SHEET_ID: 'PASTE_CAR_SHEET_ID_HERE',
  CAR_FUEL_TAB: '',      // '' = first tab. Set a name if your fuel table moves.
  CAR_SERVICE_TAB: '',   // '' = same tab as fuel (two tables side by side / stacked)

  // "Expenses Sheet Starting November 2025"
  EXPENSES_SHEET_ID: 'PASTE_EXPENSES_SHEET_ID_HERE',
  // Which tab new expenses are written to. '' = the most recently updated
  // monthly tab that has an "Expense Name" header.
  EXPENSES_TAB: '',

  // Credit-card tabs, e.g. "ADCB Visa". Blank = any tab that has a charges table
  // but no month in its name. Set a comma-separated list to name them explicitly.
  CARD_TABS: '',
  // Tabs to skip entirely, comma separated (a Summary tab, say).
  IGNORE_TABS: '',

  // Where the Second Brain's own data (tasks, notes, projects…) is stored.
  // A tab is created automatically in the Expenses spreadsheet.
  BRAIN_TAB: 'SecondBrain_Data'
};

/* ============================================================
   ENTRY POINTS
   ============================================================ */

/**
 * Your settings can live in a separate file called Config.gs holding just:
 *     var USER_CONFIG = { SECRET: '…', CAR_SHEET_ID: '…', EXPENSES_SHEET_ID: '…' };
 * Anything it defines wins over CONFIG above, so pasting a new Code.gs over this
 * one never loses your setup. Without that file, CONFIG above is used as-is.
 */
function applyUserConfig() {
  if (typeof USER_CONFIG === 'undefined') return;
  for (var k in USER_CONFIG) CONFIG[k] = USER_CONFIG[k];
}

function doGet(e) {
  return handle(e, {});
}

function doPost(e) {
  var body = {};
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    body = {};
  }
  return handle(e, body);
}

function handle(e, body) {
  applyUserConfig();
  var p = e && e.parameter ? e.parameter : {};
  var action = body.action || p.action || 'pull';
  var secret = body.secret || p.secret || '';

  if (CONFIG.SECRET && secret !== CONFIG.SECRET) {
    return json({ ok: false, error: 'Bad secret' });
  }

  try {
    switch (action) {
      case 'ping':          return json({ ok: true, now: Date.now(), version: 6 });
      case 'pull':          return json({ ok: true, now: Date.now(), data: pullAll(), stamp: stamp() });
      case 'stamp':         return json({ ok: true, now: Date.now(), stamp: stamp() });
      case 'push':
        var pushed = pushAll(body.data || {});
        invalidateTabs();
        return json({ ok: true, now: Date.now(), result: pushed, data: pullAll(), stamp: stamp() });
      case 'addFuel':       return json({ ok: true, result: addFuel(body.row || {}) });
      case 'addService':    return json({ ok: true, result: addService(body.row || {}) });
      case 'addExpense':    return json({ ok: true, result: addExpense(body.row || {}) });
      case 'updateRow':     return json({ ok: true, result: updateRow(body) });
      case 'deleteRow':     return json({ ok: true, result: deleteRow(body) });
      default:              return json({ ok: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   READ — everything the app needs, in one round trip
   ============================================================ */

function pullAll() {
  return {
    fuel: readFuel(),
    service: readService(),
    expenses: readExpenses(),
    cards: readCards(),
    brain: readBrain(),
    meta: {
      carSheet: openCar().getName(),
      expensesSheet: openExpenses().getName(),
      expensesTab: expensesTab().getName(),
      tabs: expenseTabs().map(function (t) {
        return { name: t.name, month: t.month, currency: t.currency };
      }),
      cardTabs: cardTabs().map(function (t) {
        return { name: t.name, currency: t.currency };
      }),
      skippedTabs: scanTabs().skipped,
      thisMonth: isoMonth(new Date()),
      pulledAt: new Date().toISOString()
    }
  };
}

function openCar() { applyUserConfig(); return SpreadsheetApp.openById(CONFIG.CAR_SHEET_ID); }
function openExpenses() { applyUserConfig(); return SpreadsheetApp.openById(CONFIG.EXPENSES_SHEET_ID); }

/** Values of a tab as a 2D array, trimmed of fully-empty trailing rows. */
function gridOf(sheet) {
  var rng = sheet.getDataRange();
  return rng ? rng.getValues() : [];
}

/** Finds the row index (0-based) whose cells contain all the given headers. */
function findHeaderRow(grid, headers) {
  for (var r = 0; r < grid.length; r++) {
    var row = grid[r].map(function (c) { return String(c).trim().toLowerCase(); });
    var all = headers.every(function (h) { return row.indexOf(h.toLowerCase()) !== -1; });
    if (all) return r;
  }
  return -1;
}

function colIndex(grid, headerRow, name) {
  var row = grid[headerRow].map(function (c) { return String(c).trim().toLowerCase(); });
  return row.indexOf(name.toLowerCase());
}

function asISO(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var s = String(v || '').trim();
  if (!s) return '';
  var d = new Date(s.replace(/^\w+day\s+/i, ''));
  if (!isNaN(d.getTime())) {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return s;
}

function asNumber(v) {
  if (typeof v === 'number') return v;
  var s = String(v || '').replace(/[^0-9.\-]/g, '');
  var n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/** The fuel table: Odometer Reading | Date | Cost | Difference In Days */
function readFuel() {
  var sh = CONFIG.CAR_FUEL_TAB ? openCar().getSheetByName(CONFIG.CAR_FUEL_TAB) : openCar().getSheets()[0];
  var grid = gridOf(sh);
  var hr = findHeaderRow(grid, ['Odometer Reading', 'Date', 'Cost']);
  if (hr < 0) return [];
  var cOdo = colIndex(grid, hr, 'Odometer Reading');
  var cDate = colIndex(grid, hr, 'Date');
  var cCost = colIndex(grid, hr, 'Cost');
  var out = [];
  for (var r = hr + 1; r < grid.length; r++) {
    var odo = grid[r][cOdo], date = grid[r][cDate], cost = grid[r][cCost];
    if (!odo && !date && !cost) continue;
    // stop if we've wandered into the next table
    if (String(odo).trim().toLowerCase() === 'item') break;
    out.push({
      id: 'fuel-' + (r + 1),
      row: r + 1,
      odometer: asNumber(odo),
      date: asISO(date),
      cost: asNumber(cost),
      source: 'sheet'
    });
  }
  return out;
}

/** The service table: Item | Cost | Date | Odometer Reading */
function readService() {
  var sh = CONFIG.CAR_SERVICE_TAB ? openCar().getSheetByName(CONFIG.CAR_SERVICE_TAB) : openCar().getSheets()[0];
  var grid = gridOf(sh);
  var hr = findHeaderRow(grid, ['Item', 'Cost', 'Date']);
  if (hr < 0) return [];
  var cItem = colIndex(grid, hr, 'Item');
  var cCost = colIndex(grid, hr, 'Cost');
  var cDate = colIndex(grid, hr, 'Date');
  var cOdo = colIndex(grid, hr, 'Odometer Reading');
  var out = [];
  for (var r = hr + 1; r < grid.length; r++) {
    var item = grid[r][cItem];
    if (!String(item).trim()) continue;
    out.push({
      id: 'svc-' + (r + 1),
      row: r + 1,
      item: String(item).trim(),
      cost: asNumber(grid[r][cCost]),
      date: asISO(grid[r][cDate]),
      odometer: cOdo >= 0 ? asNumber(grid[r][cOdo]) : 0,
      source: 'sheet'
    });
  }
  return out;
}

/* ============================================================
   TABS — month tabs are the expense history, card tabs are debts.
   Real sheets rarely label every column: the amount and date headers
   are often blank, so columns are found by what they contain.
   ============================================================ */

var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
              'july', 'august', 'september', 'october', 'november', 'december'];
var NAME_HEADERS = ['expense name', 'expense', 'expenses', 'payments', 'payment',
                    'item', 'description', 'name', 'details'];
var AMOUNT_HEADERS = [
  ['amount in aed', 'AED'], ['amount (aed)', 'AED'], ['amount aed', 'AED'],
  ['amount in egp', 'EGP'], ['amount (egp)', 'EGP'], ['amount egp', 'EGP'],
  ['amount', ''], ['cost', ''], ['price', ''], ['value', '']
];
var CATEGORY_HEADERS = ['category', 'categories', 'group', 'kind'];
var METHOD_HEADERS = ['payment method', 'method', 'paid with', 'account', 'card', 'bank'];
var DATE_HEADERS = ['date', 'transaction date', 'debit date', 'credit date', 'day', 'when'];
var PAID_HEADERS = ['payment status', 'paid', 'settled', 'cleared', 'status'];
var TOTAL_WORDS = ['total', 'totals', 'subtotal', 'sum', 'grand total', 'balance',
                   'current debt', 'outstanding', 'amount due'];
var PAID_VALUES = /^(y|yes|paid|done|cleared|settled|true|1)$/i;

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function isoMonth(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }

/** Month + year hidden in a tab name: "UAE Finances -November 2025", "Nov 2025", "2025-11". */
function monthFromName(name) {
  var s = String(name || '').toLowerCase();
  for (var i = 0; i < 12; i++) {
    var full = MONTHS[i];
    var hit = new RegExp('(^|[^a-z])(' + full + '|' + full.slice(0, 3) + ')([^a-z]|$)').exec(s);
    if (hit) {
      var y = /(20\d{2})/.exec(s);
      return { month: i, year: y ? Number(y[1]) : null, token: hit[2] };
    }
  }
  var ym = /(20\d{2})[-_\/ ]?(0[1-9]|1[0-2])(?![0-9])/.exec(s);
  if (ym) return { month: Number(ym[2]) - 1, year: Number(ym[1]), token: ym[0] };
  return null;
}

/** Config lists accept exact names or globs: "*egypt*", "ADCB*". */
function listNames(csv) {
  return String(csv || '').split(',').map(function (x) { return x.trim().toLowerCase(); })
    .filter(function (x) { return !!x; });
}
function matchesAny(name, patterns) {
  var s = String(name || '').toLowerCase();
  for (var i = 0; i < patterns.length; i++) {
    var p = patterns[i];
    if (p.indexOf('*') === -1) {
      if (s === p) return true;
    } else {
      var rx = new RegExp('^' + p.split('*').map(function (part) {
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('.*') + '$');
      if (rx.test(s)) return true;
    }
  }
  return false;
}

function headerRowOf(grid, hr) {
  return grid[hr].map(function (c) { return String(c).trim().toLowerCase(); });
}

function colByHeaders(grid, hr, headers, skipCol) {
  var row = headerRowOf(grid, hr);
  for (var i = 0; i < headers.length; i++) {
    var c = row.indexOf(headers[i]);
    if (c >= 0 && c !== skipCol) return c;
  }
  return -1;
}

/** How often a column holds a real number, counting only rows that have a name. */
function numericScore(grid, hr, col, nameCol) {
  if (col < 0) return 0;
  var hits = 0, seen = 0;
  for (var r = hr + 1; r < Math.min(grid.length, hr + 30); r++) {
    if (!String(grid[r][nameCol] || '').trim()) continue;
    seen++;
    var v = grid[r][col];
    if (v instanceof Date) continue;
    if (String(v === undefined || v === null ? '' : v).trim() && asNumber(v) !== 0) hits++;
  }
  return seen ? hits / seen : 0;
}

/**
 * The amount column. These sheets keep it immediately right of the name with a
 * blank header, and sometimes carry a labelled-but-empty "Amount in AED" further
 * along — so what the column CONTAINS decides, not what it is called.
 */
function pickAmountColumn(grid, hr, nameCol) {
  var row = headerRowOf(grid, hr);
  var candidates = [];
  AMOUNT_HEADERS.forEach(function (pair) {
    var c = row.indexOf(pair[0]);
    if (c >= 0 && c !== nameCol) candidates.push({ col: c, currency: pair[1], labelled: true });
  });
  candidates.push({ col: nameCol + 1, currency: '', labelled: false });
  var best = null, firstLabelled = null;
  candidates.forEach(function (cand) {
    if (!firstLabelled && cand.labelled) firstLabelled = cand;
    var score = numericScore(grid, hr, cand.col, nameCol);
    var adjusted = score + (cand.labelled ? 0 : 0.01);   // the unlabelled neighbour wins ties
    if (!best || adjusted > best.adjusted) best = { col: cand.col, currency: cand.currency, score: score, adjusted: adjusted };
  });
  if (best && best.score > 0) return best;
  return firstLabelled || { col: nameCol + 1, currency: '', score: 0 };  // empty tab: trust the layout
}

/** True only for things a person would recognise as a date, never a bare number. */
function looksLikeDate(v) {
  if (v instanceof Date) return true;
  var s = String(v === undefined || v === null ? '' : v).trim();
  if (!s || /^[-+]?[\d.,\s]+$/.test(s)) return false;          // "3800", "2,066.00" — amounts
  if (!/[a-z]/i.test(s) && !/\d[\/.-]\d/.test(s)) return false;  // needs a month name or separators
  var iso = asISO(s);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  var year = Number(iso.slice(0, 4));
  return year >= 1990 && year <= 2100;
}

/** The date column, by header or by what parses as a date. */
function pickDateColumn(grid, hr, nameCol, amountCol) {
  var byHeader = colByHeaders(grid, hr, DATE_HEADERS, nameCol);
  if (byHeader >= 0 && byHeader !== amountCol) return byHeader;
  var row = headerRowOf(grid, hr);
  var width = Math.max(row.length, 2);
  var best = -1, bestScore = 0.49;                       // needs to convince
  for (var col = 0; col < width; col++) {
    if (col === nameCol || col === amountCol) continue;
    var hits = 0, seen = 0;
    for (var r = hr + 1; r < Math.min(grid.length, hr + 30); r++) {
      if (!String(grid[r][nameCol] || '').trim()) continue;
      seen++;
      if (looksLikeDate(grid[r][col])) hits++;
    }
    var score = seen ? hits / seen : 0;
    if (score > bestScore) { bestScore = score; best = col; }
  }
  return best;
}

/**
 * AED or EGP, read off how the amounts are DISPLAYED ("AED15.00", " EGP 250.00 ",
 * "dh4,900.00"). The cells are formatted numbers, so the raw value tells us nothing.
 */
function currencyFromDisplay(sh, hr, amountCol, grid) {
  var rows = Math.min(grid.length, hr + 25) - (hr + 1);
  if (rows <= 0 || amountCol < 0) return '';
  var shown;
  try { shown = sh.getRange(hr + 2, amountCol + 1, rows, 1).getDisplayValues(); }
  catch (e) { return ''; }
  var egp = 0, aed = 0;
  shown.forEach(function (row) {
    var s = String(row[0] || '');
    if (/egp|£/i.test(s)) egp++;
    else if (/aed|dh|د\.إ/i.test(s)) aed++;
  });
  if (egp > aed) return 'EGP';
  if (aed > 0) return 'AED';
  return '';
}

function currencyFromName(name) {
  return /egypt|egp|cairo/.test(String(name || '').toLowerCase()) ? 'EGP' : 'AED';
}

/** The header row and every column that matters. */
function findTable(grid, tabName) {
  var limit = Math.min(grid.length, 40);
  for (var r = 0; r < limit; r++) {
    var row = headerRowOf(grid, r);
    var nameCol = -1;
    for (var i = 0; i < NAME_HEADERS.length && nameCol < 0; i++) nameCol = row.indexOf(NAME_HEADERS[i]);
    if (nameCol < 0) continue;
    var amount = pickAmountColumn(grid, r, nameCol);
    var cols = {
      name: nameCol,
      amount: amount.col,
      category: colByHeaders(grid, r, CATEGORY_HEADERS, nameCol),
      method: colByHeaders(grid, r, METHOD_HEADERS, nameCol),
      date: pickDateColumn(grid, r, nameCol, amount.col),
      paid: colByHeaders(grid, r, PAID_HEADERS, nameCol)
    };
    return { hr: r, cols: cols, currency: amount.currency };   // '' unless a header named it
  }
  return null;
}

/** Scanning every tab is the expensive part, so each request does it once. */
var _scan = null;
function invalidateTabs() { _scan = null; }

/**
 * Splits the workbook into month tabs (expense history) and card tabs (debts).
 * With CONFIG.CARD_TABS set, only those are cards and any other tab without a
 * month in its name is ignored — which keeps Drafts, Calculations and the like out.
 */
function scanTabs() {
  if (_scan) return _scan;
  var ss = openExpenses();
  var startYear = inferStartYear(ss);
  var forced = listNames(CONFIG.CARD_TABS);
  var ignored = listNames(CONFIG.IGNORE_TABS);
  var prev = {};
  var months = [], cards = [], skipped = [];
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name === CONFIG.BRAIN_TAB) return;
    if (ignored.length && matchesAny(name, ignored)) { skipped.push(name); return; }
    var grid = gridOf(sh);
    var found = findTable(grid, name);
    if (!found) { skipped.push(name); return; }
    var tab = {
      sheet: sh, grid: grid, hr: found.hr, cols: found.cols,
      currency: found.currency || currencyFromDisplay(sh, found.hr, found.cols.amount, grid) || currencyFromName(name),
      name: name, month: '', token: '', family: name.toLowerCase()
    };
    var mm = monthFromName(name);
    var isCard = forced.length ? matchesAny(name, forced) : !mm;
    if (isCard) { cards.push(tab); return; }
    if (!mm) { skipped.push(name); return; }
    tab.token = mm.token;
    tab.family = name.toLowerCase().replace(mm.token, '#').replace(/20\d{2}/, '').replace(/\s+/g, ' ').trim();
    var year = mm.year;
    if (!year) {
      var p = prev[tab.family];
      year = !p ? startYear : (mm.month <= p.month ? p.year + 1 : p.year);
    }
    prev[tab.family] = { month: mm.month, year: year };
    tab.month = year + '-' + pad2(mm.month + 1);
    months.push(tab);
  });
  _scan = { months: months, cards: cards, skipped: skipped };
  return _scan;
}

function expenseTabs() { return scanTabs().months; }
function cardTabs() { return scanTabs().cards; }

/** Tabs named only by month need a year: walk them in order, rolling over past December. */
function inferStartYear(ss) {
  var y = /(20\d{2})/.exec(ss.getName());
  if (y) return Number(y[1]);
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var m = monthFromName(sheets[i].getName());
    if (m && m.year) return m.year;
  }
  return new Date().getFullYear();
}

/** Default write tab: this month's AED tab, else the newest AED tab. Never creates. */
function expensesTab() {
  var ss = openExpenses();
  if (CONFIG.EXPENSES_TAB) {
    var named = ss.getSheetByName(CONFIG.EXPENSES_TAB);
    if (named) return named;
  }
  var tabs = expenseTabs();
  var now = isoMonth(new Date());
  var exact = tabs.filter(function (t) { return t.month === now && t.currency === 'AED'; });
  if (exact.length) return exact[0].sheet;
  var aed = tabs.filter(function (t) { return t.currency === 'AED' && t.month; });
  aed.sort(function (a, b) { return a.month < b.month ? -1 : 1; });
  if (aed.length) return aed[aed.length - 1].sheet;
  return tabs.length ? tabs[0].sheet : ss.getSheets()[0];
}

/** True for summary rows that repeat the header or hold a total. */
function isNoiseRow(name) {
  var low = String(name).trim().toLowerCase();
  return !low || NAME_HEADERS.indexOf(low) !== -1 || TOTAL_WORDS.indexOf(low) !== -1;
}

function cellText(grid, r, c) {
  return c >= 0 ? String(grid[r][c] === undefined || grid[r][c] === null ? '' : grid[r][c]).trim() : '';
}

/** Expense rows from EVERY month tab — this is the history. */
function readExpenses() {
  var out = [];
  expenseTabs().forEach(function (t) {
    var grid = t.grid, hr = t.hr, c = t.cols;
    for (var r = hr + 1; r < grid.length; r++) {
      var name = cellText(grid, r, c.name);
      if (isNoiseRow(name)) continue;
      var date = c.date >= 0 && looksLikeDate(grid[r][c.date]) ? asISO(grid[r][c.date]) : '';
      var approx = false;
      if (!date && t.month) { date = t.month + '-01'; approx = true; }
      out.push({
        id: 'exp-' + t.name + '-' + (r + 1),
        row: r + 1,
        tab: t.name,
        month: date ? date.slice(0, 7) : t.month,
        currency: t.currency,
        name: name,
        amount: asNumber(grid[r][c.amount]),
        category: cellText(grid, r, c.category),
        method: cellText(grid, r, c.method),
        date: date,
        approxDate: approx,
        source: 'sheet'
      });
    }
  });
  return out;
}

/**
 * Every credit-card tab with its charges. The debt is their sum; a row whose
 * payment-status column says paid is left out, and the tab's own total row is
 * skipped so nothing is counted twice.
 */
function readCards() {
  return cardTabs().map(function (t) {
    var grid = t.grid, hr = t.hr, c = t.cols;
    var rows = [], debt = 0, last = '';
    for (var r = hr + 1; r < grid.length; r++) {
      var name = cellText(grid, r, c.name);
      if (isNoiseRow(name)) continue;
      var paid = c.paid >= 0 && PAID_VALUES.test(cellText(grid, r, c.paid));
      var amount = asNumber(grid[r][c.amount]);
      var date = c.date >= 0 && looksLikeDate(grid[r][c.date]) ? asISO(grid[r][c.date]) : '';
      if (date && date > last) last = date;
      if (!paid) debt += amount;
      rows.push({
        id: 'card-' + t.name + '-' + (r + 1),
        row: r + 1,
        card: t.name,
        name: name,
        amount: amount,
        date: date,
        category: cellText(grid, r, c.category),
        paid: paid,
        currency: t.currency
      });
    }
    return {
      name: t.name,
      currency: t.currency,
      debt: Math.round(debt * 100) / 100,
      charges: rows.length,
      unpaid: rows.filter(function (x) { return !x.paid; }).length,
      lastDate: last,
      rows: rows
    };
  });
}

/* ============================================================
   WRITE
   ============================================================ */

/** Appends a row directly beneath the last filled row of a table. */
function appendUnderTable(sheet, headerRow, firstCol, values) {
  var grid = gridOf(sheet);
  var r = headerRow + 1;
  while (r < grid.length && String(grid[r][firstCol] || '').trim() !== '') r++;
  // r is now the first empty row of this table
  sheet.getRange(r + 1, firstCol + 1, 1, values.length).setValues([values]);
  return r + 1;
}

function addFuel(row) {
  var sh = CONFIG.CAR_FUEL_TAB ? openCar().getSheetByName(CONFIG.CAR_FUEL_TAB) : openCar().getSheets()[0];
  var grid = gridOf(sh);
  var hr = findHeaderRow(grid, ['Odometer Reading', 'Date', 'Cost']);
  if (hr < 0) throw new Error('Fuel table not found in the car sheet');
  var c0 = colIndex(grid, hr, 'Odometer Reading');
  var written = appendUnderTable(sh, hr, c0, [
    asNumber(row.odometer),
    row.date ? new Date(row.date) : new Date(),
    asNumber(row.cost)
  ]);
  return { row: written };
}

function addService(row) {
  var sh = CONFIG.CAR_SERVICE_TAB ? openCar().getSheetByName(CONFIG.CAR_SERVICE_TAB) : openCar().getSheets()[0];
  var grid = gridOf(sh);
  var hr = findHeaderRow(grid, ['Item', 'Cost', 'Date']);
  if (hr < 0) throw new Error('Service table not found in the car sheet');
  var c0 = colIndex(grid, hr, 'Item');
  var written = appendUnderTable(sh, hr, c0, [
    String(row.item || ''),
    asNumber(row.cost),
    row.date ? new Date(row.date) : new Date(),
    asNumber(row.odometer)
  ]);
  return { row: written };
}

/** The tab for a month + currency. Creates it from the newest tab's layout when missing. */
function tabForMonth(month, currency, allowCreate) {
  var tabs = expenseTabs();
  var hit = null;
  tabs.forEach(function (t) { if (!hit && t.month === month && t.currency === currency) hit = t; });
  if (hit) return { tab: hit, created: false };
  if (allowCreate) {
    var sh = createMonthTab(month, currency, tabs);
    invalidateTabs();
    var made = null;
    expenseTabs().forEach(function (t) { if (!made && t.name === sh.getName()) made = t; });
    if (made) return { tab: made, created: true };
  }
  var fallback = null;
  tabs.forEach(function (t) {
    if (t.currency !== currency || !t.month) return;
    if (!fallback || t.month > fallback.month) fallback = t;
  });
  if (!fallback) fallback = tabs.length ? tabs[0] : null;
  if (!fallback) throw new Error('No expense tab found in the Expenses spreadsheet');
  return { tab: fallback, created: false };
}

/** Copies the newest tab of the same currency, renames it for the new month, clears its rows. */
function createMonthTab(month, currency, tabs) {
  var ss = openExpenses();
  var pool = tabs.filter(function (t) { return t.month && t.currency === currency; });
  if (!pool.length) pool = tabs.filter(function (t) { return t.month; });
  if (!pool.length) throw new Error('No monthly tab to copy a layout from');
  pool.sort(function (a, b) { return a.month < b.month ? -1 : 1; });
  var tpl = pool[pool.length - 1];
  var name = nextTabName(tpl, month);
  var clash = null;
  tabs.forEach(function (t) { if (t.name === name) clash = t; });
  if (clash) {
    if (clash.month === month) return clash.sheet;                 // it already exists
    name = uniqueTabName(ss, name, String(month).slice(0, 4));     // same month name, another year
  } else if (ss.getSheetByName(name)) {
    return ss.getSheetByName(name);
  }
  var sh = tpl.sheet.copyTo(ss).setName(name);
  var last = sh.getLastRow();
  if (last > tpl.hr + 1) {
    sh.getRange(tpl.hr + 2, 1, last - tpl.hr - 1, sh.getLastColumn()).clearContent();
  }
  ss.setActiveSheet(sh);
  ss.moveActiveSheet(ss.getNumSheets());
  return sh;
}

/** Keeps month names unique across years: "UAE Finances -November" -> "... November 2026". */
function uniqueTabName(ss, name, year) {
  if (!ss.getSheetByName(name)) return name;
  var withYear = /20\d{2}/.test(name) ? name : name + ' ' + year;
  if (!ss.getSheetByName(withYear)) return withYear;
  var i = 2;
  while (ss.getSheetByName(withYear + ' (' + i + ')')) i++;
  return withYear + ' (' + i + ')';
}

/** "UAE Finances - September 2026" + 2026-10 -> "UAE Finances - October 2026". */
function nextTabName(tpl, month) {
  var parts = String(month).split('-');
  var year = parts[0], mi = Number(parts[1]) - 1;
  var word = MONTHS[mi];
  var name = tpl.name;
  if (tpl.token) {
    var repl = tpl.token.length === 3 ? word.slice(0, 3) : word;
    repl = repl.charAt(0).toUpperCase() + repl.slice(1);
    name = name.replace(new RegExp(tpl.token, 'i'), repl);
    if (/20\d{2}/.test(name)) name = name.replace(/20\d{2}/, year);
    else if (tpl.month && tpl.month.slice(0, 4) !== year) name = name + ' ' + year;
  } else {
    name = name + ' ' + word.charAt(0).toUpperCase() + word.slice(1) + ' ' + year;
  }
  return name;
}

/** Writes into the columns the scan identified — headers here are often blank. */
function appendToTab(t, v) {
  var sh = t.sheet, c = t.cols;
  var grid = gridOf(sh);
  var r = t.hr + 1;
  while (r < grid.length && String(grid[r][c.name] || '').trim() !== '') r++;
  var rowNum = r + 1;
  sh.getRange(rowNum, c.name + 1).setValue(v.name);
  sh.getRange(rowNum, c.amount + 1).setValue(v.amount);
  if (c.category >= 0 && v.category) sh.getRange(rowNum, c.category + 1).setValue(v.category);
  if (c.method >= 0 && v.method) sh.getRange(rowNum, c.method + 1).setValue(v.method);
  if (c.date >= 0 && v.date) sh.getRange(rowNum, c.date + 1).setValue(v.date);
  return rowNum;
}

/** An expense logged in the app lands in its own month's tab. */
function addExpense(row) {
  var currency = String(row.currency || 'AED').toUpperCase();
  var date = row.date ? new Date(row.date) : new Date();
  var month = isoMonth(date);
  var res = tabForMonth(month, currency, true);
  var rowNum = appendToTab(res.tab, {
    name: String(row.name || ''),
    amount: asNumber(row.amount),
    category: String(row.category || ''),
    method: String(row.method || ''),
    date: date
  });
  invalidateTabs();
  return { row: rowNum, tab: res.tab.name, created: res.created, month: month, currency: currency };
}

/** Applies a batch of app-side changes. */
function pushAll(data) {
  var result = { fuel: 0, service: 0, expenses: 0, edits: 0, deletes: 0, brain: false };
  (data.newFuel || []).forEach(function (r) { addFuel(r); result.fuel++; });
  (data.newService || []).forEach(function (r) { addService(r); result.service++; });
  (data.newExpenses || []).forEach(function (r) { addExpense(r); result.expenses++; });
  (data.edits || []).forEach(function (e) { updateRow(e); result.edits++; });
  (data.deletes || []).forEach(function (d) { deleteRow(d); result.deletes++; });
  if (data.brain) { writeBrain(data.brain); result.brain = true; }
  return result;
}

/* ============================================================
   SECOND BRAIN DATA — one JSON blob, chunked across cells
   (a single cell caps at 50,000 characters)
   ============================================================ */

function brainTab() {
  var ss = openExpenses();
  var sh = ss.getSheetByName(CONFIG.BRAIN_TAB);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.BRAIN_TAB);
    sh.getRange('A1').setValue('Second Brain app data — do not edit by hand');
    sh.hideSheet();
  }
  return sh;
}

function readBrain() {
  var sh = brainTab();
  var values = sh.getRange('A2:A200').getValues();
  var parts = [];
  for (var i = 0; i < values.length; i++) {
    var v = String(values[i][0] || '');
    if (!v) break;
    parts.push(v);
  }
  var text = parts.join('');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function writeBrain(obj) {
  var sh = brainTab();
  var text = JSON.stringify(obj);
  var CHUNK = 45000;
  var chunks = [];
  for (var i = 0; i < text.length; i += CHUNK) chunks.push([text.substr(i, CHUNK)]);
  sh.getRange('A2:A200').clearContent();
  if (chunks.length) sh.getRange(2, 1, chunks.length, 1).setValues(chunks);
  sh.getRange('B1').setValue('Updated: ' + new Date().toISOString());
  return chunks.length;
}

/* ============================================================
   EDIT AND DELETE EXISTING ROWS (so app edits reach the sheet)
   ============================================================ */

function carSheet(kind) {
  if (kind === 'fuel') return CONFIG.CAR_FUEL_TAB ? openCar().getSheetByName(CONFIG.CAR_FUEL_TAB) : openCar().getSheets()[0];
  return CONFIG.CAR_SERVICE_TAB ? openCar().getSheetByName(CONFIG.CAR_SERVICE_TAB) : openCar().getSheets()[0];
}

/** An expense row number means nothing without its tab, so every edit carries one. */
function expenseTabByName(name) {
  var hit = null;
  expenseTabs().forEach(function (t) { if (!hit && t.name === name) hit = t; });
  if (!hit) cardTabs().forEach(function (t) { if (!hit && t.name === name) hit = t; });
  return hit;
}

function expenseTabFor(body) {
  var t = body.tab ? expenseTabByName(body.tab) : null;
  if (!t) t = expenseTabByName(expensesTab().getName());
  if (!t) throw new Error('Expense tab not found: ' + (body.tab || '(default)'));
  return t;
}

function carHeaderRow(kind, grid) {
  return kind === 'fuel'
    ? findHeaderRow(grid, ['Odometer Reading', 'Date', 'Cost'])
    : findHeaderRow(grid, ['Item', 'Cost', 'Date']);
}

/** body: { kind, row (1-based), tab (expense only), values } */
function updateRow(body) {
  var kind = body.kind, rowNum = Number(body.row), v = body.values || {};
  if (!rowNum) throw new Error('No row given');

  if (kind === 'expense') {
    var t = expenseTabFor(body);
    var c = t.cols;
    if (v.name !== undefined) t.sheet.getRange(rowNum, c.name + 1).setValue(String(v.name));
    if (v.amount !== undefined) t.sheet.getRange(rowNum, c.amount + 1).setValue(asNumber(v.amount));
    if (v.category !== undefined && c.category >= 0) t.sheet.getRange(rowNum, c.category + 1).setValue(String(v.category));
    if (v.method !== undefined && c.method >= 0) t.sheet.getRange(rowNum, c.method + 1).setValue(String(v.method));
    if (v.date && c.date >= 0) t.sheet.getRange(rowNum, c.date + 1).setValue(new Date(v.date));
    invalidateTabs();
    return { row: rowNum, kind: kind, tab: t.name };
  }

  var sh = carSheet(kind);
  var grid = gridOf(sh);
  var hr = carHeaderRow(kind, grid);
  if (hr < 0) throw new Error('Table not found for ' + kind);
  function put(header, value) {
    var col = colIndex(grid, hr, header);
    if (col < 0 || value === undefined || value === null) return;
    sh.getRange(rowNum, col + 1).setValue(value);
  }
  if (kind === 'fuel') {
    put('Odometer Reading', v.odometer !== undefined ? asNumber(v.odometer) : undefined);
    put('Cost', v.cost !== undefined ? asNumber(v.cost) : undefined);
    put('Date', v.date ? new Date(v.date) : undefined);
  } else {
    put('Item', v.item);
    put('Cost', v.cost !== undefined ? asNumber(v.cost) : undefined);
    put('Date', v.date ? new Date(v.date) : undefined);
    put('Odometer Reading', v.odometer !== undefined ? asNumber(v.odometer) : undefined);
  }
  return { row: rowNum, kind: kind };
}

/** Clears a row's table cells (keeps the sheet layout intact). */
function deleteRow(body) {
  var kind = body.kind, rowNum = Number(body.row);
  if (!rowNum) throw new Error('No row given');

  if (kind === 'expense') {
    var t = expenseTabFor(body);
    var c = t.cols;
    [c.name, c.amount, c.category, c.method, c.date].forEach(function (col) {
      if (col >= 0) t.sheet.getRange(rowNum, col + 1).clearContent();
    });
    invalidateTabs();
    return { row: rowNum, kind: kind, tab: t.name, cleared: true };
  }

  var sh = carSheet(kind);
  var grid = gridOf(sh);
  var hr = carHeaderRow(kind, grid);
  if (hr < 0) throw new Error('Table not found for ' + kind);
  var headers = kind === 'fuel'
    ? ['Odometer Reading', 'Date', 'Cost']
    : ['Item', 'Cost', 'Date', 'Odometer Reading'];
  headers.forEach(function (h) {
    var col = colIndex(grid, hr, h);
    if (col >= 0) sh.getRange(rowNum, col + 1).clearContent();
  });
  return { row: rowNum, kind: kind, cleared: true };
}

/**
 * A cheap "has anything changed?" probe. Polling this instead of pullAll keeps
 * the app responsive without burning the daily Apps Script runtime budget.
 */
function stamp() {
  function t(id) {
    try { return DriveApp.getFileById(id).getLastUpdated().getTime(); }
    catch (e) { return 0; }
  }
  return {
    car: t(CONFIG.CAR_SHEET_ID),
    expenses: t(CONFIG.EXPENSES_SHEET_ID)
  };
}
