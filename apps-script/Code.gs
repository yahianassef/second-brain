/**
 * Second Brain — Google Sheets sync API
 * =====================================
 * v9 — reads the month's income from the "Starting …" block, including amounts
 *      that only the Notes column names ("Salary + 720 From Egypt + 850
 *      Company" against a 10,500 cell means 12,070 came in). CONFIG.INCOME_FROM
 *      decides which months are read.
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
  CAR_FUEL_TAB: '',      // '' = found automatically on whichever tab holds it
  CAR_SERVICE_TAB: '',   // '' = found automatically (its own tab, or stacked under fuel)

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
  // Month from which the "Starting …" block counts as that month's income
  // (YYYY-MM). Earlier months are left alone. '' = every month.
  INCOME_FROM: '2026-09',

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
      case 'ping':          return json({ ok: true, now: Date.now(), version: 10 });
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
      case 'setCardPaid':   return json({ ok: true, result: setCardPaid(body) });
      case 'notifyPreview': return json({ ok: true, result: notifyPreview() });
      case 'notifyTest':    return json({ ok: true, result: notifyTest(body.message) });
      case 'notifyStatus':  return json({ ok: true, result: notifyTriggerStatus() });
      case 'notifyInstall': return json({ ok: true, result: installNotifications() });
      case 'notifyRemove':  return json({ ok: true, result: removeNotifications() });
      case 'notifyRun':     return json({ ok: true, result: runNotifications() });
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
    income: readIncome(),
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

/**
 * The car tab holding a table. Fuel and service can share one tab (stacked) or
 * live on separate tabs; either way the tab is found by its header row, so the
 * service log is never looked for on the fuel tab. A named tab in CONFIG wins.
 */
function carSheetFor(kind) {
  var ss = openCar();
  var named = kind === 'fuel' ? CONFIG.CAR_FUEL_TAB : CONFIG.CAR_SERVICE_TAB;
  if (named) {
    var byName = ss.getSheetByName(named);
    if (byName) return byName;
  }
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var grid = gridOf(sheets[i]);
    if (kind === 'fuel') {
      var hr = findHeaderRow(grid, ['Odometer Reading', 'Date', 'Cost']);
      // the service header also has Odometer / Date / Cost — only a header without "Item" is fuel
      if (hr >= 0 && colIndex(grid, hr, 'Item') < 0) return sheets[i];
    } else if (findHeaderRow(grid, ['Item', 'Cost', 'Date']) >= 0) {
      return sheets[i];
    }
  }
  return sheets[0];
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
  var sh = carSheetFor('fuel');
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
  var sh = carSheetFor('service');
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
 * The "Current Credit Available" figure a card tab keeps beside its table:
 * the first number to the right of that label, else the value just below it.
 * Returns null when the tab has no such label.
 */
function creditAvailable(grid) {
  var label = /credit\s*ava/i;            // "Credit Available", and the tabs' own "Availabe"
  var hasDigits = function (v) { return v !== '' && v !== null && /\d/.test(String(v)); };
  var rows = Math.min(grid.length, 60);
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < grid[r].length; c++) {
      if (!label.test(String(grid[r][c]))) continue;
      for (var k = c + 1; k < grid[r].length; k++) {
        if (hasDigits(grid[r][k])) return Math.round(asNumber(grid[r][k]) * 100) / 100;
      }
      if (r + 1 < grid.length && hasDigits(grid[r + 1][c])) return Math.round(asNumber(grid[r + 1][c]) * 100) / 100;
    }
  }
  return null;
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
      available: creditAvailable(grid),
      statusCol: c.paid >= 0,        // false = no Payment Status column, so it can't be toggled
      debt: Math.round(debt * 100) / 100,
      charges: rows.length,
      unpaid: rows.filter(function (x) { return !x.paid; }).length,
      lastDate: last,
      rows: rows
    };
  });
}

/* ============================================================
   INCOME — the "Starting <date>" block each month tab keeps beside its table.
   The cells hold what landed in each account; the Notes column beside them
   spells out where it came from, and sometimes names money that arrived in a
   DIFFERENT account ("Salary + 720 From Egypt + 850 Company"). Those amounts
   are part of the month's income too, so the notes are read, not just summed.
   ============================================================ */

var STARTING_LABEL = /^\s*starting\b/i;
var CARRIED_NOTE = /last month|previous month|carried|carry[- ]?over|saving from/i;
var TOTAL_LABEL = /^(total|sum)$/i;

/** Every number in a note: "720 From Egypt+850 Company" -> [720, 850]. */
function numbersIn(text) {
  var out = [];
  var hits = String(text || '').match(/\d[\d,]*(?:\.\d+)?/g) || [];
  hits.forEach(function (h) {
    var n = asNumber(h);
    if (n > 0) out.push(n);
  });
  return out;
}

/**
 * What a note adds on top of the cell beside it.
 *  - "Starting Balance 13920 , Added 1325 , 9000 Credit Card" against a cell of
 *    25,245 is a BREAKDOWN of that cell — it adds nothing.
 *  - "Salary + 720 From Egypt + 850 Company" against a cell of 10,500 names two
 *    amounts that are not in the cell — they add 1,570.
 * Any number equal to the cell itself is the cell, never an extra.
 */
function extrasFromNote(note, cellAmount) {
  var nums = numbersIn(note);
  if (!nums.length) return [];
  var sum = 0;
  nums.forEach(function (n) { sum += n; });
  if (cellAmount > 0 && Math.abs(sum - cellAmount) < 1) return [];      // the note breaks down the cell
  return nums.filter(function (n) { return Math.abs(n - cellAmount) >= 1; });
}

/** Months at or after CONFIG.INCOME_FROM ('' = every month). */
function incomeMonthAllowed(month) {
  var from = String(CONFIG.INCOME_FROM || '').trim();
  if (!from) return true;
  return !!month && month >= from;
}

/**
 * The income block on one tab: the rows under "Starting …" down to its Total.
 * Blocks listing credit limits are not money coming in, so they are skipped.
 */
function readIncomeBlock(t) {
  var grid = t.grid;
  for (var r = 0; r < grid.length; r++) {
    var row = grid[r] || [];
    for (var c = 0; c < row.length; c++) {
      if (!STARTING_LABEL.test(String(row[c] === undefined ? '' : row[c]))) continue;
      var heading = String(row[c]).trim();
      var lines = [], total = null, blanks = 0;
      for (var i = r + 1; i < grid.length; i++) {
        var label = cellText(grid, i, c);
        if (!label) { if (++blanks > 1) break; continue; }
        blanks = 0;
        if (STARTING_LABEL.test(label)) break;                 // the next block
        var amount = asNumber((grid[i] || [])[c + 1]);
        if (TOTAL_LABEL.test(label)) { total = amount; break; }
        lines.push({ label: label, amount: amount, note: cellText(grid, i, c + 2) });
      }
      var limitish = lines.filter(function (l) { return /limit/i.test(l.label); }).length;
      if (lines.length && limitish > lines.length / 2) continue;   // a credit-limit block
      if (!lines.length) continue;

      var base = 0, extras = [], carried = 0;
      lines.forEach(function (l) {
        base += l.amount;
        l.extras = extrasFromNote(l.note, l.amount);
        l.extraTotal = 0;
        l.extras.forEach(function (n) { l.extraTotal += n; });
        if (CARRIED_NOTE.test(l.note)) carried += l.amount;
      });
      if (total === null) total = base;
      lines.forEach(function (l) { l.extras.forEach(function (n) { extras.push({ amount: n, from: l.label, note: l.note }); }); });
      var extraTotal = 0;
      extras.forEach(function (e) { extraTotal += e.amount; });

      return {
        heading: heading,
        accounts: total,            // what the account cells add up to
        extras: extras,             // amounts named only in the notes
        extraTotal: Math.round(extraTotal * 100) / 100,
        carried: Math.round(carried * 100) / 100,   // rows noted as last month's money
        total: Math.round((total + extraTotal) * 100) / 100,
        lines: lines
      };
    }
  }
  return null;
}

/** Income per month, for the months CONFIG.INCOME_FROM allows. */
function readIncome() {
  var out = [];
  expenseTabs().forEach(function (t) {
    if (!incomeMonthAllowed(t.month)) return;
    var block = readIncomeBlock(t);
    if (!block) return;
    out.push({
      month: t.month,
      tab: t.name,
      currency: t.currency,
      heading: block.heading,
      total: block.total,
      accounts: block.accounts,
      extraTotal: block.extraTotal,
      carried: block.carried,
      lines: block.lines.map(function (l) {
        return {
          label: l.label,
          amount: l.amount,
          note: l.note,
          extras: l.extras,
          extraTotal: Math.round(l.extraTotal * 100) / 100,
          carried: CARRIED_NOTE.test(l.note)
        };
      }),
      extras: block.extras
    });
  });
  return out;
}

/* ============================================================
   WRITE
   ============================================================ */

/**
 * Marks one card charge paid or unpaid.  body: { card, row, name, amount, paid }
 * Writes "Paid" (or clears it) in the tab's Payment Status column — the same
 * convention the sheet already uses. Marking paid also stamps an empty Payment
 * Date; marking unpaid leaves any date you typed alone.
 * The row number is checked against the charge's name first: if rows were
 * inserted in the sheet since the app last synced, the charge is found again by
 * name and amount rather than flipping whatever now sits on that row.
 */
function setCardPaid(body) {
  invalidateTabs();
  var t = cardTabs().filter(function (x) { return x.name === body.card; })[0];
  if (!t) throw new Error('Card tab not found: ' + body.card);
  var c = t.cols, grid = t.grid;
  if (c.paid < 0) throw new Error('"' + body.card + '" has no Payment Status column to write to');
  var want = String(body.name || '').trim();
  var nameAt = function (i) { return i > t.hr && i < grid.length && cellText(grid, i, c.name) === want; };
  var r = Number(body.row) - 1;
  if (!want || !nameAt(r)) {
    r = -1;
    for (var i = t.hr + 1; i < grid.length; i++) {
      var sameAmount = body.amount === undefined || Math.abs(asNumber(grid[i][c.amount]) - Number(body.amount)) < 0.005;
      if (nameAt(i) && sameAmount) { r = i; break; }
    }
    if (r < 0) throw new Error('Could not find "' + want + '" on ' + body.card + ' — sync and try again');
  }
  t.sheet.getRange(r + 1, c.paid + 1).setValue(body.paid ? 'Paid' : '');
  if (body.paid) {
    var dateCol = colByHeaders(grid, t.hr, ['payment date', 'paid on', 'date paid'], c.name);
    if (dateCol >= 0 && !cellText(grid, r, dateCol)) t.sheet.getRange(r + 1, dateCol + 1).setValue(new Date());
  }
  invalidateTabs();
  return { card: body.card, row: r + 1, paid: !!body.paid };
}

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
  var sh = carSheetFor('fuel');
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
  var sh = carSheetFor('service');
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
  var result = { fuel: 0, service: 0, expenses: 0, edits: 0, deletes: 0, cardStatus: 0, brain: false };
  (data.newFuel || []).forEach(function (r) { addFuel(r); result.fuel++; });
  (data.newService || []).forEach(function (r) { addService(r); result.service++; });
  (data.newExpenses || []).forEach(function (r) { addExpense(r); result.expenses++; });
  (data.edits || []).forEach(function (e) { updateRow(e); result.edits++; });
  (data.deletes || []).forEach(function (d) { deleteRow(d); result.deletes++; });
  (data.cardStatus || []).forEach(function (st) { setCardPaid(st); result.cardStatus++; });
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
  if (kind === 'fuel') return carSheetFor('fuel');
  return carSheetFor('service');
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

/* ============================================================
   NOTIFICATIONS
   A time-driven trigger runs hourly, works out which reminders are due from
   your own data, and pushes them to your phone. What to send and when comes
   from the app (Settings → Notifications), carried over in the synced brain,
   so nothing needs editing here.

   ONE-TIME SETUP: run installNotifications() from the editor once and accept
   the permissions Google asks for (schedule, send mail / call the push
   service). removeNotifications() takes the schedule away again.
   ============================================================ */

var NOTIFY_STATE_KEY = 'secondBrainNotifyState';

/** Defaults, overridden per category by whatever the app has saved. */
var NOTIFY_DEFAULTS = {
  expenses: { time: '21:00' },
  journal:  { time: '21:30' },
  tasks:    { time: '08:00' },
  projects: { time: '09:00', day: 'Sun' },
  courses:  { time: '18:00', day: 'Wed' },
  habits:   { time: '20:00' },
  study:    { time: '19:00', day: 'Fri' },
  exercise: { time: '19:30', day: 'Fri' },
  budgets:  { time: '10:00' },
  cards:    { time: '10:30', day: 'Mon' },
  car:      { time: '09:30', day: 'Sat' },
  digest:   { time: '07:30' }
};

function notifySettings() {
  var brain = readBrain() || {};
  var s = (brain.settings && brain.settings.notify) || {};
  return {
    on: s.on !== false,
    channel: s.channel || 'email',
    to: s.to || '',
    cats: s.cats || {}
  };
}

function notifyTZ() { return Session.getScriptTimeZone(); }
function notifyNow(tz) { return new Date(); }
var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function notifyState() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(NOTIFY_STATE_KEY) || '{}'); }
  catch (e) { return {}; }
}
function saveNotifyState(st) {
  PropertiesService.getScriptProperties().setProperty(NOTIFY_STATE_KEY, JSON.stringify(st));
}

/* ---------------- delivery ---------------- */

/** Sends one message on whichever channel is configured. Returns a short note. */
function notifySend(title, body, settings) {
  var s = settings || notifySettings();
  var channel = s.channel || 'email';
  var to = String(s.to || '').trim();

  if (channel === 'ntfy') {
    if (!to) throw new Error('No ntfy topic set');
    var topic = to.replace(/^https?:\/\/ntfy\.sh\//i, '');
    UrlFetchApp.fetch('https://ntfy.sh/' + encodeURIComponent(topic), {
      method: 'post',
      contentType: 'text/plain; charset=utf-8',
      payload: body,
      headers: { Title: title, Tags: 'brain', Priority: 'default' },
      muteHttpExceptions: true
    });
    return 'ntfy:' + topic;
  }
  if (channel === 'telegram') {
    var parts = to.split('|');
    var token = (parts[0] || '').trim(), chat = (parts[1] || '').trim();
    if (!token || !chat) throw new Error('Telegram needs "botToken|chatId"');
    UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chat, text: title + '\n' + body, disable_web_page_preview: true }),
      muteHttpExceptions: true
    });
    return 'telegram:' + chat;
  }
  var address = to || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({ to: address, subject: title, body: body });
  return 'email:' + address;
}

/* ---------------- the rules ----------------
   Each returns a message when it should fire, or '' when there is nothing to
   say. Every one reads real data, so a reminder only arrives when it is true. */

function notifyContext() {
  var tz = notifyTZ();
  var now = new Date();
  var brain = readBrain() || {};
  var arr = function (k) { return Array.isArray(brain[k]) ? brain[k] : []; };
  return {
    tz: tz, now: now,
    today: Utilities.formatDate(now, tz, 'yyyy-MM-dd'),
    month: Utilities.formatDate(now, tz, 'yyyy-MM'),
    brain: brain,
    tasks: arr('tasks'), projects: arr('projects'), journal: arr('journal'),
    courses: arr('courses'), habits: arr('habits'), habitLogs: arr('habitLogs'),
    study: arr('study'), workouts: arr('workouts'), budgets: arr('budgets'),
    settings: brain.settings || {}
  };
}
function daysBetween(a, b) { return Math.round((new Date(a) - new Date(b)) / 86400000); }
function notifyPlural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

var NOTIFY_RULES = {
  expenses: function (c) {
    var todays = readExpenses().filter(function (r) { return r.date === c.today; });
    if (todays.length) return '';
    return 'Nothing logged today. Add what you spent while you still remember it.';
  },
  journal: function (c) {
    if (c.journal.some(function (j) { return j.date === c.today; })) return '';
    var streak = 0, d = new Date(c.now);
    for (var i = 0; i < 365; i++) {
      d.setDate(d.getDate() - (i === 0 ? 1 : 1));
      var ds = Utilities.formatDate(d, c.tz, 'yyyy-MM-dd');
      if (c.journal.some(function (j) { return j.date === ds; })) streak++; else break;
    }
    return 'No entry yet today.' + (streak ? ' You are on a ' + streak + '-day streak — keep it going.' : '');
  },
  tasks: function (c) {
    var open = c.tasks.filter(function (t) { return t.status !== 'Done'; });
    var overdue = open.filter(function (t) { return t.due && t.due < c.today; });
    var today = open.filter(function (t) { return t.due === c.today; });
    if (!overdue.length && !today.length) return '';
    var lines = [];
    if (overdue.length) lines.push(notifyPlural(overdue.length, 'task') + ' overdue');
    if (today.length) lines.push(notifyPlural(today.length, 'task') + ' due today');
    var names = today.concat(overdue).slice(0, 5).map(function (t) { return '• ' + t.title; });
    return lines.join(' · ') + '\n' + names.join('\n');
  },
  projects: function (c) {
    var active = c.projects.filter(function (p) { return p.status === 'Active'; });
    if (!active.length) return '';
    var stale = active.filter(function (p) {
      var when = p.updated || p.created;
      return when && daysBetween(c.today, when) >= 7;
    });
    var soon = active.filter(function (p) {
      return p.deadline && p.deadline >= c.today && daysBetween(p.deadline, c.today) <= 7;
    });
    if (!stale.length && !soon.length) return '';
    var out = [];
    if (soon.length) out.push('Due within a week:\n' + soon.map(function (p) { return '• ' + p.name + ' — ' + p.deadline; }).join('\n'));
    if (stale.length) out.push('Not updated in a while:\n' + stale.slice(0, 5).map(function (p) { return '• ' + p.name + ' (' + (p.progress || 0) * 1 + '%)'; }).join('\n'));
    return out.join('\n\n');
  },
  courses: function (c) {
    var going = c.courses.filter(function (x) { return x.status === 'In Progress'; });
    if (!going.length) return '';
    var stale = going.filter(function (x) {
      var when = x.updated || x.created;
      return when && daysBetween(c.today, when) >= 7;
    });
    if (!stale.length) return '';
    return 'No lessons logged in a week:\n' + stale.map(function (x) {
      var done = Number(x.lessonsDone) || 0, total = Number(x.lessonsTotal) || 0;
      return '• ' + x.name + (total ? ' — ' + done + '/' + total : '');
    }).join('\n');
  },
  habits: function (c) {
    if (!c.habits.length) return '';
    var doneToday = {};
    c.habitLogs.forEach(function (l) { if (l.date === c.today) doneToday[l.habitId] = true; });
    var missed = c.habits.filter(function (h) { return !doneToday[h.id]; });
    if (!missed.length) return '';
    return notifyPlural(missed.length, 'habit') + ' still open today:\n' + missed.slice(0, 6).map(function (h) { return '• ' + h.name; }).join('\n');
  },
  study: function (c) {
    var target = Number(c.settings.studyWeekly) || 0;
    if (!target) return '';
    var since = Utilities.formatDate(new Date(c.now.getTime() - 6 * 86400000), c.tz, 'yyyy-MM-dd');
    var hours = c.study.filter(function (s) { return s.date >= since; })
      .reduce(function (t, s) { return t + (Number(s.hours) || 0); }, 0);
    if (hours >= target) return 'Studied ' + hours.toFixed(1) + 'h this week — target of ' + target + 'h met.';
    return 'Studied ' + hours.toFixed(1) + 'h of your ' + target + 'h target this week.';
  },
  exercise: function (c) {
    var target = Number(c.settings.exerciseWeekly) || 0;
    if (!target) return '';
    var since = Utilities.formatDate(new Date(c.now.getTime() - 6 * 86400000), c.tz, 'yyyy-MM-dd');
    var count = c.workouts.filter(function (w) { return w.date >= since; }).length;
    if (count >= target) return count + ' workouts this week — target of ' + target + ' met.';
    return count + ' of ' + target + ' workouts done this week.';
  },
  budgets: function (c) {
    if (!c.budgets.length) return '';
    var spent = {};
    readExpenses().forEach(function (r) {
      if (String(r.date || '').slice(0, 7) !== c.month) return;
      if ((r.currency || 'AED') !== 'AED') return;
      spent[r.category] = (spent[r.category] || 0) + (Number(r.amount) || 0);
    });
    var hot = [];
    c.budgets.forEach(function (b) {
      var limit = Number(b.limit) || 0;
      if (!limit) return;
      var used = spent[b.category] || 0;
      var pct = used / limit * 100;
      if (pct >= 90) hot.push('• ' + b.category + ' — ' + Math.round(pct) + '% (' + Math.round(used) + ' of ' + limit + ')');
    });
    if (!hot.length) return '';
    return 'Budgets at or past 90% this month:\n' + hot.join('\n');
  },
  cards: function (c) {
    var cards = readCards().filter(function (x) { return Number(x.debt) > 0; });
    if (!cards.length) return '';
    return 'Outstanding on your cards:\n' + cards.map(function (x) {
      return '• ' + x.name + ' — ' + (x.currency || 'AED') + ' ' + x.debt + ' (' + x.unpaid + ' open)';
    }).join('\n');
  },
  car: function (c) {
    var fuel = readFuel(), service = readService();
    if (!fuel.length && !service.length) return '';
    var lastOdo = 0;
    fuel.forEach(function (f) { if (Number(f.odometer) > lastOdo) lastOdo = Number(f.odometer); });
    var last = null;
    service.forEach(function (s) { if (!last || String(s.date) > String(last.date)) last = s; });
    if (!last) return '';
    var km = last.odometer ? lastOdo - Number(last.odometer) : 0;
    var days = last.date ? daysBetween(c.today, last.date) : 0;
    if (km < 5000 && days < 180) return '';
    var bits = [];
    if (km >= 5000) bits.push(km.toLocaleString() + ' km since the last service');
    if (days >= 180) bits.push(days + ' days since the last service');
    return 'Service may be due: ' + bits.join(', ') + '.\nLast was ' + last.item + ' on ' + last.date + '.';
  },
  digest: function (c) {
    var open = c.tasks.filter(function (t) { return t.status !== 'Done'; });
    var overdue = open.filter(function (t) { return t.due && t.due < c.today; }).length;
    var due = open.filter(function (t) { return t.due === c.today; }).length;
    var spentToday = readExpenses().filter(function (r) { return r.date === c.today; });
    var monthSpend = 0;
    readExpenses().forEach(function (r) {
      if (String(r.date || '').slice(0, 7) === c.month && (r.currency || 'AED') === 'AED') monthSpend += Number(r.amount) || 0;
    });
    var lines = [
      notifyPlural(due, 'task') + ' due today' + (overdue ? ', ' + overdue + ' overdue' : ''),
      'Spent this month: AED ' + Math.round(monthSpend) + (spentToday.length ? ' · ' + spentToday.length + ' logged today' : ''),
      c.journal.some(function (j) { return j.date === c.today; }) ? 'Journal written' : 'Journal not written yet'
    ];
    return lines.join('\n');
  }
};

var NOTIFY_TITLES = {
  expenses: 'Log today’s spending',
  journal: 'Journal reminder',
  tasks: 'Tasks today',
  projects: 'Project check-in',
  courses: 'Course progress',
  habits: 'Habits today',
  study: 'Study this week',
  exercise: 'Exercise this week',
  budgets: 'Budget warning',
  cards: 'Credit cards',
  car: 'Car maintenance',
  digest: 'Your day'
};

/** Which categories are due in this hour, and what each would say. */
function notifyDue(force) {
  applyUserConfig();
  var s = notifySettings();
  var c = notifyContext();
  var hour = Utilities.formatDate(c.now, c.tz, 'HH');
  var day = DAY_NAMES[Number(Utilities.formatDate(c.now, c.tz, 'u')) % 7];
  var state = notifyState();
  var out = [];

  Object.keys(NOTIFY_RULES).forEach(function (key) {
    var cfg = s.cats[key] || {};
    var def = NOTIFY_DEFAULTS[key] || {};
    var enabled = cfg.on === true;
    if (!force && (!s.on || !enabled)) return;
    var time = cfg.time || def.time || '09:00';
    var wantDay = cfg.day || def.day || '';
    if (!force) {
      if (time.slice(0, 2) !== hour) return;
      if (wantDay && wantDay !== day) return;
      if (state[key] === c.today) return;            // already sent today
    }
    var body = '';
    try { body = NOTIFY_RULES[key](c) || ''; } catch (err) { body = ''; }
    if (!body) return;
    out.push({ key: key, title: NOTIFY_TITLES[key] || key, body: body, time: time, day: wantDay });
  });
  return { settings: { on: s.on, channel: s.channel, hasDestination: !!s.to }, hour: hour, day: day, today: c.today, due: out };
}

/** The hourly trigger. */
function runNotifications() {
  var plan = notifyDue(false);
  if (!plan.settings.on) return plan;
  var state = notifyState();
  var sent = [];
  plan.due.forEach(function (item) {
    try {
      notifySend('Second Brain · ' + item.title, item.body, null);
      state[item.key] = plan.today;
      sent.push(item.key);
    } catch (err) {
      // leave it unsent so the next hour tries again
    }
  });
  if (sent.length) saveNotifyState(state);
  return { sent: sent, considered: plan.due.length };
}

/** Everything that WOULD be sent right now, without sending anything. */
function notifyPreview() {
  var plan = notifyDue(true);
  return {
    channel: plan.settings.channel,
    hasDestination: plan.settings.hasDestination,
    enabled: plan.settings.on,
    now: plan.today + ' ' + plan.hour + ':00 ' + plan.day,
    messages: plan.due.map(function (d) {
      return { category: d.key, title: d.title, when: (d.day ? d.day + ' ' : 'daily ') + d.time, body: d.body };
    })
  };
}

/** Sends one message now, to prove the channel works. */
function notifyTest(body) {
  var where = notifySend('Second Brain · test', body ? String(body) : 'If you can read this, notifications are working.', null);
  return { delivered: where };
}

/** Creates the hourly schedule (safe to run twice). */
function installNotifications() {
  removeNotifications();
  ScriptApp.newTrigger('runNotifications').timeBased().everyHours(1).create();
  return notifyTriggerStatus();
}
function removeNotifications() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runNotifications') ScriptApp.deleteTrigger(t);
  });
  return { installed: false };
}
function notifyTriggerStatus() {
  var found = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'runNotifications'; });
  return { installed: found.length > 0, count: found.length, timezone: notifyTZ(), state: notifyState() };
}
