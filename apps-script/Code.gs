/**
 * Second Brain — Google Sheets sync API
 * =====================================
 * Deploy this once as a Web App. It gives the Second Brain apps (GitHub Pages,
 * phone, and the standalone HTML file) read/write access to your sheets,
 * so edits flow both ways.
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

  // Where the Second Brain's own data (tasks, notes, projects…) is stored.
  // A tab is created automatically in the Expenses spreadsheet.
  BRAIN_TAB: 'SecondBrain_Data'
};

/* ============================================================
   ENTRY POINTS
   ============================================================ */

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
  var p = e && e.parameter ? e.parameter : {};
  var action = body.action || p.action || 'pull';
  var secret = body.secret || p.secret || '';

  if (CONFIG.SECRET && secret !== CONFIG.SECRET) {
    return json({ ok: false, error: 'Bad secret' });
  }

  try {
    switch (action) {
      case 'ping':          return json({ ok: true, now: Date.now(), version: 3 });
      case 'pull':          return json({ ok: true, now: Date.now(), data: pullAll(), stamp: stamp() });
      case 'stamp':         return json({ ok: true, now: Date.now(), stamp: stamp() });
      case 'push':          return json({ ok: true, now: Date.now(), result: pushAll(body.data || {}), data: pullAll(), stamp: stamp() });
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
    brain: readBrain(),
    meta: {
      carSheet: openCar().getName(),
      expensesSheet: openExpenses().getName(),
      expensesTab: expensesTab().getName(),
      pulledAt: new Date().toISOString()
    }
  };
}

function openCar() { return SpreadsheetApp.openById(CONFIG.CAR_SHEET_ID); }
function openExpenses() { return SpreadsheetApp.openById(CONFIG.EXPENSES_SHEET_ID); }

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

/** The monthly expense tab to read/write. */
function expensesTab() {
  var ss = openExpenses();
  if (CONFIG.EXPENSES_TAB) {
    var named = ss.getSheetByName(CONFIG.EXPENSES_TAB);
    if (named) return named;
  }
  // otherwise: the left-most tab that has an "Expense Name" header
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getName() === CONFIG.BRAIN_TAB) continue;
    var grid = gridOf(sheets[i]);
    if (findHeaderRow(grid, ['Expense Name', 'Amount in AED']) >= 0) return sheets[i];
  }
  return sheets[0];
}

/** Expense rows: Expense Name | Amount in AED | Category | Payment Method | Date */
function readExpenses() {
  var sh = expensesTab();
  var grid = gridOf(sh);
  var hr = findHeaderRow(grid, ['Expense Name', 'Amount in AED']);
  if (hr < 0) return [];
  var cName = colIndex(grid, hr, 'Expense Name');
  var cAmt = colIndex(grid, hr, 'Amount in AED');
  var cCat = colIndex(grid, hr, 'Category');
  var cPay = colIndex(grid, hr, 'Payment Method');
  var cDate = colIndex(grid, hr, 'Date');
  var out = [];
  for (var r = hr + 1; r < grid.length; r++) {
    var name = String(grid[r][cName] || '').trim();
    var amt = grid[r][cAmt];
    if (!name) continue;                 // totals row has an amount but no name
    out.push({
      id: 'exp-' + sh.getName() + '-' + (r + 1),
      row: r + 1,
      tab: sh.getName(),
      name: name,
      amount: asNumber(amt),
      category: cCat >= 0 ? String(grid[r][cCat] || '').trim() : '',
      method: cPay >= 0 ? String(grid[r][cPay] || '').trim() : '',
      date: cDate >= 0 ? asISO(grid[r][cDate]) : '',
      source: 'sheet'
    });
  }
  return out;
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

function addExpense(row) {
  var sh = expensesTab();
  var grid = gridOf(sh);
  var hr = findHeaderRow(grid, ['Expense Name', 'Amount in AED']);
  if (hr < 0) throw new Error('Expense table not found');
  var c0 = colIndex(grid, hr, 'Expense Name');
  var written = appendUnderTable(sh, hr, c0, [
    String(row.name || ''),
    asNumber(row.amount),
    String(row.category || ''),
    String(row.method || ''),
    row.date ? new Date(row.date) : new Date()
  ]);
  return { row: written, tab: sh.getName() };
}

/** Applies a batch of app-side changes. */
function pushAll(data) {
  var result = { fuel: 0, service: 0, expenses: 0, brain: false };
  (data.newFuel || []).forEach(function (r) { addFuel(r); result.fuel++; });
  (data.newService || []).forEach(function (r) { addService(r); result.service++; });
  (data.newExpenses || []).forEach(function (r) { addExpense(r); result.expenses++; });
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

function targetSheet(kind) {
  if (kind === 'expense') return expensesTab();
  if (kind === 'fuel') return CONFIG.CAR_FUEL_TAB ? openCar().getSheetByName(CONFIG.CAR_FUEL_TAB) : openCar().getSheets()[0];
  return CONFIG.CAR_SERVICE_TAB ? openCar().getSheetByName(CONFIG.CAR_SERVICE_TAB) : openCar().getSheets()[0];
}

function headerFor(kind, grid) {
  if (kind === 'fuel') return findHeaderRow(grid, ['Odometer Reading', 'Date', 'Cost']);
  if (kind === 'service') return findHeaderRow(grid, ['Item', 'Cost', 'Date']);
  return findHeaderRow(grid, ['Expense Name', 'Amount in AED']);
}

/** body: { kind:'fuel'|'service'|'expense', row:<1-based sheet row>, values:{...} } */
function updateRow(body) {
  var kind = body.kind, rowNum = Number(body.row), v = body.values || {};
  if (!rowNum) throw new Error('No row given');
  var sh = targetSheet(kind);
  var grid = gridOf(sh);
  var hr = headerFor(kind, grid);
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
  } else if (kind === 'service') {
    put('Item', v.item);
    put('Cost', v.cost !== undefined ? asNumber(v.cost) : undefined);
    put('Date', v.date ? new Date(v.date) : undefined);
    put('Odometer Reading', v.odometer !== undefined ? asNumber(v.odometer) : undefined);
  } else {
    put('Expense Name', v.name);
    put('Amount in AED', v.amount !== undefined ? asNumber(v.amount) : undefined);
    put('Category', v.category);
    put('Payment Method', v.method);
    put('Date', v.date ? new Date(v.date) : undefined);
  }
  return { row: rowNum, kind: kind };
}

/** Clears a row's table cells (keeps the sheet layout intact). */
function deleteRow(body) {
  var kind = body.kind, rowNum = Number(body.row);
  if (!rowNum) throw new Error('No row given');
  var sh = targetSheet(kind);
  var grid = gridOf(sh);
  var hr = headerFor(kind, grid);
  if (hr < 0) throw new Error('Table not found for ' + kind);
  var headers = kind === 'fuel' ? ['Odometer Reading', 'Date', 'Cost']
    : kind === 'service' ? ['Item', 'Cost', 'Date', 'Odometer Reading']
    : ['Expense Name', 'Amount in AED', 'Category', 'Payment Method', 'Date'];
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
