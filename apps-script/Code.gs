/**
 * Second Brain — Google Sheets sync API
 * =====================================
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
      case 'ping':          return json({ ok: true, now: Date.now(), version: 5 });
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
   EXPENSE TABS — every monthly tab is history, not just the newest
   CARD TABS   — one per credit card, charges summing to the debt
   ============================================================ */


var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
              'july', 'august', 'september', 'october', 'november', 'december'];
var NAME_HEADERS = ['expense name', 'expense', 'expenses', 'item', 'description', 'name', 'details'];
var AMOUNT_HEADERS = [
  ['amount in aed', 'AED'], ['amount (aed)', 'AED'], ['amount aed', 'AED'], ['aed', 'AED'],
  ['amount in egp', 'EGP'], ['amount (egp)', 'EGP'], ['amount egp', 'EGP'], ['egp', 'EGP'],
  ['amount', ''], ['cost', ''], ['price', ''], ['value', ''], ['total', '']
];
var CATEGORY_HEADERS = ['category', 'categories', 'group', 'kind'];
var PAID_HEADERS = ['paid', 'settled', 'cleared', 'status'];
var TOTAL_WORDS = ['total', 'totals', 'subtotal', 'sum', 'grand total', 'balance',
                   'current debt', 'outstanding', 'amount due'];
var METHOD_HEADERS = ['payment method', 'method', 'paid with', 'payment', 'account', 'card'];
var DATE_HEADERS = ['date', 'day', 'when'];

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function isoMonth(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }

/** Month + year hidden in a tab name: "UAE Finances November", "Nov 2025", "2025-11". */
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

function currencyFromName(name) {
  return /egypt|egp|cairo/.test(String(name || '').toLowerCase()) ? 'EGP' : 'AED';
}

/** The first row carrying both a name-ish and an amount-ish header. */
function findExpenseTable(grid) {
  var limit = Math.min(grid.length, 40);
  for (var r = 0; r < limit; r++) {
    var row = grid[r].map(function (c) { return String(c).trim().toLowerCase(); });
    var nameCol = -1, amtCol = -1, currency = '';
    for (var i = 0; i < NAME_HEADERS.length && nameCol < 0; i++) nameCol = row.indexOf(NAME_HEADERS[i]);
    for (var j = 0; j < AMOUNT_HEADERS.length && amtCol < 0; j++) {
      var c = row.indexOf(AMOUNT_HEADERS[j][0]);
      if (c >= 0 && c !== nameCol) { amtCol = c; currency = AMOUNT_HEADERS[j][1]; }
    }
    if (nameCol >= 0 && amtCol >= 0) return { hr: r, nameCol: nameCol, amtCol: amtCol, currency: currency };
  }
  return null;
}

/** Tabs named only by month need a year: walk them in order and roll over past December. */
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

/** Scanning every tab is the expensive part, so each request does it once. */
var _scan = null;
function invalidateTabs() { _scan = null; }

function listNames(csv) {
  return String(csv || '').split(',').map(function (x) { return x.trim().toLowerCase(); })
    .filter(function (x) { return !!x; });
}

/**
 * Splits the workbook in two:
 *   months — the expense history, one tab per month
 *   cards  — credit-card tabs, whose charges add up to the current debt
 * A tab with a charges table but no month in its name is a card.
 */
function scanTabs() {
  if (_scan) return _scan;
  var ss = openExpenses();
  var startYear = inferStartYear(ss);
  var forced = listNames(CONFIG.CARD_TABS);
  var ignored = listNames(CONFIG.IGNORE_TABS);
  var prev = {};
  var months = [], cards = [];
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name === CONFIG.BRAIN_TAB) return;
    if (ignored.indexOf(name.toLowerCase()) !== -1) return;
    var grid = gridOf(sh);
    var found = findExpenseTable(grid);
    if (!found) return;
    var tab = {
      sheet: sh, grid: grid, hr: found.hr, nameCol: found.nameCol, amtCol: found.amtCol,
      currency: found.currency || currencyFromName(name), name: name, month: '', token: '', family: name.toLowerCase()
    };
    var mm = monthFromName(name);
    var isCard = forced.length ? forced.indexOf(name.toLowerCase()) !== -1 : !mm;
    if (isCard) { cards.push(tab); return; }
    if (!mm) return;                       // no month and not a card: nothing to read
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
  _scan = { months: months, cards: cards };
  return _scan;
}

/** Month tabs only — the expense history. */
function expenseTabs() { return scanTabs().months; }

/** Credit-card tabs — charges that add up to what is owed. */
function cardTabs() { return scanTabs().cards; }

function colByHeaders(grid, hr, headers) {
  var row = grid[hr].map(function (c) { return String(c).trim().toLowerCase(); });
  for (var i = 0; i < headers.length; i++) {
    var c = row.indexOf(headers[i]);
    if (c >= 0) return c;
  }
  return -1;
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

/** Expense rows from EVERY month tab — this is the history the app charts. */
function readExpenses() {
  var out = [];
  expenseTabs().forEach(function (t) {
    var grid = t.grid, hr = t.hr;
    var cCat = colByHeaders(grid, hr, CATEGORY_HEADERS);
    var cPay = colByHeaders(grid, hr, METHOD_HEADERS);
    var cDate = colByHeaders(grid, hr, DATE_HEADERS);
    for (var r = hr + 1; r < grid.length; r++) {
      var name = String(grid[r][t.nameCol] || '').trim();
      if (!name) continue;
      var low = name.toLowerCase();
      if (NAME_HEADERS.indexOf(low) !== -1) continue;             // a repeated header row
      if (low === 'total' || low === 'totals' || low === 'sum') continue;
      var date = cDate >= 0 ? asISO(grid[r][cDate]) : '';
      var approx = false;
      if (!date && t.month) { date = t.month + '-01'; approx = true; }  // undated rows belong to their tab's month
      out.push({
        id: 'exp-' + t.name + '-' + (r + 1),
        row: r + 1,
        tab: t.name,
        month: date ? date.slice(0, 7) : t.month,
        currency: t.currency,
        name: name,
        amount: asNumber(grid[r][t.amtCol]),
        category: cCat >= 0 ? String(grid[r][cCat] || '').trim() : '',
        method: cPay >= 0 ? String(grid[r][cPay] || '').trim() : '',
        date: date,
        approxDate: approx,
        source: 'sheet'
      });
    }
  });
  return out;
}

/**
 * Every credit-card tab with its charges. The debt is their sum; a row marked
 * paid in a Paid/Status column is left out, and the tab's own total row is
 * skipped so it is never counted twice.
 */
function readCards() {
  return cardTabs().map(function (t) {
    var grid = t.grid, hr = t.hr;
    var cDate = colByHeaders(grid, hr, DATE_HEADERS);
    var cCat = colByHeaders(grid, hr, CATEGORY_HEADERS);
    var cPaid = colByHeaders(grid, hr, PAID_HEADERS);
    var rows = [], debt = 0, last = '';
    for (var r = hr + 1; r < grid.length; r++) {
      var name = String(grid[r][t.nameCol] || '').trim();
      if (!name) continue;
      var low = name.toLowerCase();
      if (NAME_HEADERS.indexOf(low) !== -1) continue;
      if (TOTAL_WORDS.indexOf(low) !== -1) continue;
      var paid = cPaid >= 0 && /^(y|yes|paid|done|cleared|settled|true|1)$/i
        .test(String(grid[r][cPaid] || '').trim());
      var amount = asNumber(grid[r][t.amtCol]);
      var date = cDate >= 0 ? asISO(grid[r][cDate]) : '';
      if (date && date > last) last = date;
      if (!paid) debt += amount;
      rows.push({
        id: 'card-' + t.name + '-' + (r + 1),
        row: r + 1,
        card: t.name,
        name: name,
        amount: amount,
        date: date,
        category: cCat >= 0 ? String(grid[r][cCat] || '').trim() : '',
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

/** Keeps month names unique across years: "UAE Finances November" -> "... November 2026". */
function uniqueTabName(ss, name, year) {
  if (!ss.getSheetByName(name)) return name;
  var withYear = /20\d{2}/.test(name) ? name : name + ' ' + year;
  if (!ss.getSheetByName(withYear)) return withYear;
  var i = 2;
  while (ss.getSheetByName(withYear + ' (' + i + ')')) i++;
  return withYear + ' (' + i + ')';
}

/** "UAE Finances November" + 2025-12 -> "UAE Finances December". */
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

/** Writes each value into the column its header names, in the table's first free row. */
function appendByHeaders(t, v) {
  var sh = t.sheet;
  var grid = gridOf(sh);
  var r = t.hr + 1;
  while (r < grid.length && String(grid[r][t.nameCol] || '').trim() !== '') r++;
  var rowNum = r + 1;
  var cCat = colByHeaders(grid, t.hr, CATEGORY_HEADERS);
  var cPay = colByHeaders(grid, t.hr, METHOD_HEADERS);
  var cDate = colByHeaders(grid, t.hr, DATE_HEADERS);
  sh.getRange(rowNum, t.nameCol + 1).setValue(v.name);
  sh.getRange(rowNum, t.amtCol + 1).setValue(v.amount);
  if (cCat >= 0 && v.category) sh.getRange(rowNum, cCat + 1).setValue(v.category);
  if (cPay >= 0 && v.method) sh.getRange(rowNum, cPay + 1).setValue(v.method);
  if (cDate >= 0 && v.date) sh.getRange(rowNum, cDate + 1).setValue(v.date);
  return rowNum;
}

/** An expense logged in the app lands in its own month's tab. */
function addExpense(row) {
  var currency = String(row.currency || 'AED').toUpperCase();
  var date = row.date ? new Date(row.date) : new Date();
  var month = isoMonth(date);
  var res = tabForMonth(month, currency, true);
  var rowNum = appendByHeaders(res.tab, {
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
    var g = gridOf(t.sheet);
    var cCat = colByHeaders(g, t.hr, CATEGORY_HEADERS);
    var cPay = colByHeaders(g, t.hr, METHOD_HEADERS);
    var cDate = colByHeaders(g, t.hr, DATE_HEADERS);
    if (v.name !== undefined) t.sheet.getRange(rowNum, t.nameCol + 1).setValue(String(v.name));
    if (v.amount !== undefined) t.sheet.getRange(rowNum, t.amtCol + 1).setValue(asNumber(v.amount));
    if (v.category !== undefined && cCat >= 0) t.sheet.getRange(rowNum, cCat + 1).setValue(String(v.category));
    if (v.method !== undefined && cPay >= 0) t.sheet.getRange(rowNum, cPay + 1).setValue(String(v.method));
    if (v.date && cDate >= 0) t.sheet.getRange(rowNum, cDate + 1).setValue(new Date(v.date));
    invalidateTabs();
    return { row: rowNum, kind: kind, tab: t.name };
  }

  var sh = carSheet(kind);
  var grid = gridOf(sh);
  var hr = carHeaderRow(kind, grid);
  if (hr < 0) throw new Error('Table not found for ' + kind);
  function put(header, value) {
    var c = colIndex(grid, hr, header);
    if (c < 0 || value === undefined || value === null) return;
    sh.getRange(rowNum, c + 1).setValue(value);
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
    var g = gridOf(t.sheet);
    [t.nameCol, t.amtCol,
      colByHeaders(g, t.hr, CATEGORY_HEADERS),
      colByHeaders(g, t.hr, METHOD_HEADERS),
      colByHeaders(g, t.hr, DATE_HEADERS)].forEach(function (c) {
      if (c >= 0) t.sheet.getRange(rowNum, c + 1).clearContent();
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
    var c = colIndex(grid, hr, h);
    if (c >= 0) sh.getRange(rowNum, c + 1).clearContent();
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
