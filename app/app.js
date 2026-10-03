/* Ampliance: battery EPR compliance, client-side app.
   All data lives in this browser (localStorage + IndexedDB for files). */
(function () {
  'use strict';

  /* ======================================================================
     Constants & helpers
     ====================================================================== */
  var KEY = 'ampliance:v1';
  var CATS = { portable: 'Portable', automotive: 'Automotive', industrial: 'Industrial', ev: 'Electric vehicle' };
  var ROLES = { assembler: 'Assembler / manufacturer', importer: 'Importer', seller: 'Online seller', brand: 'Brand owner' };
  // Placeholder rates. Users must confirm these against Schedule II of the
  // Battery Waste Management Rules, 2022 (as amended) for the year in question.
  var DEFAULT_RATES = { portable: 70, automotive: 70, industrial: 70, ev: 70 };
  var DOC_TAGS = ['Registration', 'Certificate', 'Invoice', 'Return', 'Other'];
  var OFFSETS = [30, 14, 7, 1, 0];
  var NAV = [
    { k: 'dashboard', t: 'Dashboard' },
    { k: 'obligations', t: 'Obligations' },
    { k: 'certificates', t: 'Certificates' },
    { k: 'deadlines', t: 'Deadlines' },
    { k: 'returns', t: 'Returns' },
    { k: 'documents', t: 'Documents' }
  ];
  var GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
  var EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[A-Za-z]{2,}$/;
  var CERT_RE = /^[A-Z0-9][A-Z0-9\-\/]{5,39}$/i;
  var DAY = 864e5;

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5); }
  function num(v) { var n = parseFloat(String(v == null ? '' : v).replace(/[,\s₹]/g, '')); return isFinite(n) ? n : 0; }
  function fmt(n) { return (Math.round((+n || 0) * 10) / 10).toLocaleString('en-IN', { maximumFractionDigits: 1 }); }
  function fmtInt(n) { return Math.round(+n || 0).toLocaleString('en-IN'); }
  function fmtDate(d, withYear) {
    var o = { day: 'numeric', month: 'short' };
    if (withYear !== false) o.year = 'numeric';
    return new Date(d).toLocaleDateString('en-IN', o);
  }
  function iso(d) {
    d = new Date(d);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function parseISO(s) { var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s); }
  function today0() { var d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function daysUntil(d) { var x = parseISO(d); x.setHours(0, 0, 0, 0); return Math.round((x - today0()) / DAY); }
  function plural(n, w) { return n + ' ' + w + (Math.abs(n) === 1 ? '' : 's'); }
  function icon(id, cls) { return '<svg' + (cls ? ' class="' + cls + '"' : '') + ' aria-hidden="true"><use href="#i-' + id + '"/></svg>'; }

  // Indian financial year: 1 April to 31 March. Stored as "2026-27".
  function fyOf(d) {
    d = parseISO(d);
    var y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    return y + '-' + String((y + 1) % 100).padStart(2, '0');
  }
  function fyStart(fy) { return +fy.slice(0, 4); }
  function fyLabel(fy) { return 'FY ' + fy.slice(0, 4) + '–' + fy.slice(5); }
  function quarterOf(d) { var m = parseISO(d).getMonth(); return m >= 3 && m <= 5 ? 'Q1' : m >= 6 && m <= 8 ? 'Q2' : m >= 9 ? 'Q3' : 'Q4'; }
  var Q_MONTHS = { Q1: 'Apr–Jun', Q2: 'Jul–Sep', Q3: 'Oct–Dec', Q4: 'Jan–Mar' };

  function normCat(v) {
    v = String(v || '').toLowerCase().trim();
    if (!v) return '';
    if (CATS[v]) return v;
    if (/\bev\b|electric|e-?vehicle|traction/.test(v)) return 'ev';
    if (/^port|consumer|button|cell phone|mobile|laptop/.test(v)) return 'portable';
    if (/auto|sli|starter|car|two.?wheeler/.test(v)) return 'automotive';
    if (/indus|ups|inverter|solar|stationary|telecom/.test(v)) return 'industrial';
    return '';
  }
  function rowIssue(r) {
    if (!r.category) return 'Unknown category';
    if (!(r.weightKg > 0)) return 'Missing weight';
    return '';
  }

  /* ======================================================================
     State
     ====================================================================== */
  function blank() {
    return {
      v: 1,
      onboarded: false,
      sample: false,
      fy: fyOf(new Date()),
      profile: { name: '', gstin: '', city: '', contactName: '', email: '', phone: '', roles: [], categories: [], regStatus: 'yes', eprReg: '' },
      rates: Object.assign({}, DEFAULT_RATES),
      ratesConfirmed: false,
      priceRange: { min: '', max: '' },
      sales: [],
      certificates: [],
      checks: [],
      customDeadlines: [],
      doneDeadlines: [],
      reminders: { offsets: [30, 7, 1], browser: false },
      locks: {},
      filed: {}
    };
  }
  function load() {
    var s = blank();
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var d = JSON.parse(raw);
        Object.assign(s, d);
        s.profile = Object.assign(blank().profile, d.profile);
        s.rates = Object.assign({}, DEFAULT_RATES, d.rates);
        s.reminders = Object.assign(blank().reminders, d.reminders);
      }
    } catch (e) { /* storage blocked or corrupt: start fresh */ }
    return s;
  }
  var S = load();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); }
    catch (e) { toast('Could not save. Browser storage may be full or blocked.', 'bad'); }
  }
  function commit(msg, kind) { save(); render(); if (msg) toast(msg, kind); }

  /* ======================================================================
     Domain logic
     ====================================================================== */
  function activeCats(o) {
    return Object.keys(CATS).filter(function (k) {
      return S.profile.categories.indexOf(k) > -1 || o[k].placed > 0 || o[k].target > 0 || o[k].covered > 0 || o[k].pending > 0;
    });
  }

  function obligation(fy) {
    fy = fy || S.fy;
    var lock = S.locks[fy];
    var o = {};
    Object.keys(CATS).forEach(function (k) {
      o[k] = { placed: 0, units: 0, target: 0, computed: 0, covered: 0, pending: 0, rate: +S.rates[k] || 0 };
    });
    S.sales.forEach(function (r) {
      if (r.fy === fy && !rowIssue(r)) { o[r.category].placed += r.weightKg; o[r.category].units += r.units || 0; }
    });
    Object.keys(o).forEach(function (k) {
      o[k].computed = o[k].placed * o[k].rate / 100;
      o[k].target = lock ? (lock.targets[k] || 0) : o[k].computed;
    });
    S.certificates.forEach(function (c) {
      if (c.fy !== fy || !o[c.category]) return;
      if (c.status === 'verified') o[c.category].covered += c.kg;
      else if (c.status === 'pending') o[c.category].pending += c.kg;
    });
    var t = { placed: 0, target: 0, covered: 0, effective: 0, pending: 0, surplus: 0, computed: 0 };
    Object.keys(o).forEach(function (k) {
      var v = o[k];
      v.effective = Math.min(v.covered, v.target);
      v.gap = Math.max(0, v.target - v.covered);
      t.placed += v.placed; t.target += v.target; t.covered += v.covered; t.computed += v.computed;
      t.effective += v.effective; t.pending += v.pending; t.surplus += Math.max(0, v.covered - v.target);
    });
    t.gap = Math.max(0, t.target - t.effective);
    t.pct = t.target > 0 ? t.effective / t.target : 0;
    t.locked = !!lock;
    t.lockDrift = lock && Math.abs(t.computed - t.target) > 0.5;
    return { cats: o, t: t };
  }

  function quartersWithSales(fy) {
    var q = {};
    S.sales.forEach(function (r) { if (r.fy === fy && r.quarter) q[r.quarter] = true; });
    return q;
  }

  function generatedDeadlines(fy) {
    var y = fyStart(fy), q = quartersWithSales(fy), ob = obligation(fy);
    var d = [
      { id: 'q1-' + fy, date: iso(new Date(y, 6, 15)), title: 'Upload Q1 sales data', note: 'April–June sales · keeps your target accurate', kind: 'upload', q: 'Q1', link: 'obligations' },
      { id: 'q2-' + fy, date: iso(new Date(y, 9, 15)), title: 'Upload Q2 sales data', note: 'July–September sales · keeps your target accurate', kind: 'upload', q: 'Q2', link: 'obligations' },
      { id: 'cover-' + fy, date: iso(new Date(y, 11, 31)), title: 'Finish buying certificates', note: 'Leaves a buffer before the year closes · prices often rise late', kind: 'cover', link: 'certificates' },
      { id: 'q3-' + fy, date: iso(new Date(y + 1, 0, 15)), title: 'Upload Q3 sales data', note: 'October–December sales', kind: 'upload', q: 'Q3', link: 'obligations' },
      { id: 'q4-' + fy, date: iso(new Date(y + 1, 3, 15)), title: 'Upload Q4 sales data', note: 'January–March sales · completes the year', kind: 'upload', q: 'Q4', link: 'obligations' },
      { id: 'return-' + fy, date: iso(new Date(y + 1, 5, 30)), title: 'File annual EPR return', note: 'On the CPCB EPR portal · confirm the exact date on the portal', kind: 'return', link: 'returns' }
    ];
    d.forEach(function (x) {
      x.auto = (x.kind === 'upload' && q[x.q]) || (x.kind === 'cover' && ob.t.target > 0 && ob.t.gap <= 0) || (x.kind === 'return' && !!S.filed[fy]);
    });
    return d;
  }

  function allDeadlines() {
    var list = generatedDeadlines(S.fy).concat(S.customDeadlines.map(function (c) { return Object.assign({ kind: 'custom' }, c); }));
    list.forEach(function (x) { x.done = !!x.auto || S.doneDeadlines.indexOf(x.id) > -1; x.days = daysUntil(x.date); });
    return list.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  }
  function attention() {
    var open = allDeadlines().filter(function (d) { return !d.done; });
    return {
      overdue: open.filter(function (d) { return d.days < 0; }),
      soon: open.filter(function (d) { return d.days >= 0 && d.days <= 14; })
    };
  }

  function dayPill(d) {
    if (d.done) return '<span class="pill ok">Done</span>';
    if (d.days < 0) return '<span class="pill bad">Overdue ' + plural(-d.days, 'day') + '</span>';
    if (d.days === 0) return '<span class="pill warn">Due today</span>';
    if (d.days <= 14) return '<span class="pill warn">In ' + plural(d.days, 'day') + '</span>';
    return '<span class="pill mut">In ' + plural(d.days, 'day') + '</span>';
  }

  /* Certificate checks: what Ampliance can verify from your own records.
     Live lookups against the CPCB register need the server (not built yet). */
  function runChecks(c) {
    var out = [];
    function add(state, label, detail) { out.push({ state: state, label: label, detail: detail || '' }); }
    var ob = obligation(S.fy), cat = ob.cats[c.category];

    if (CERT_RE.test(c.certId)) add('pass', 'Certificate ID is well-formed');
    else add('fail', 'Certificate ID looks malformed', 'Use the exact ID shown on the CPCB EPR portal.');

    var dupe = S.certificates.filter(function (x) { return x.certId.toUpperCase() === c.certId.toUpperCase(); })[0];
    if (dupe) add('fail', 'Already in your certificates', 'Added on ' + fmtDate(dupe.addedAt) + '. The same certificate cannot count twice.');
    else add('pass', 'Not already in your records');

    if (c.recyclerReg) add('pass', 'Recycler registration number provided');
    else add('warn', 'No recycler registration number', 'Ask the seller for their CPCB registration number before you pay.');

    if (S.profile.categories.indexOf(c.category) < 0 && !(cat && cat.target > 0)) {
      add('fail', 'You have no ' + CATS[c.category].toLowerCase() + ' obligation', 'Certificates only count against the category they were generated for.');
    } else add('pass', 'Category matches your obligation');

    if (c.kg > 0 && cat) {
      var gap = Math.max(0, cat.target - cat.covered - cat.pending);
      if (cat.target <= 0) add('warn', 'No target calculated yet', 'Upload your sales first so we can tell how much you need.');
      else if (gap <= 0) add('warn', 'You may not need this', 'Your ' + CATS[c.category].toLowerCase() + ' target for ' + fyLabel(S.fy) + ' is already covered.');
      else if (c.kg > gap) add('warn', 'More than you need by ' + fmt(c.kg - gap) + ' kg', 'Your remaining ' + CATS[c.category].toLowerCase() + ' gap is ' + fmt(gap) + ' kg.');
      else add('pass', 'Fits within your remaining gap of ' + fmt(gap) + ' kg');
    } else add('fail', 'Quantity missing', 'Enter the quantity in kg shown on the certificate.');

    if (c.date) {
      if (fyOf(c.date) === S.fy) add('pass', 'Generated in ' + fyLabel(S.fy));
      else add('warn', 'Generated outside ' + fyLabel(S.fy), 'Check that it can be used against this year’s target.');
    }

    var min = num(S.priceRange.min), max = num(S.priceRange.max);
    if (c.price > 0 && (min || max)) {
      if (min && c.price < min) add('warn', 'Price is unusually low', 'Below your expected ₹' + fmt(min) + '/kg. Very cheap certificates are a common sign of fraud.');
      else if (max && c.price > max) add('warn', 'Price is above your expected range', 'Above ₹' + fmt(max) + '/kg.');
      else add('pass', 'Price within your expected range');
    }

    add('manual', 'Confirm availability on the CPCB EPR portal', 'Ampliance is not yet connected to the CPCB register. Check the certificate is listed and available to transfer before you pay.');

    var verdict = out.some(function (x) { return x.state === 'fail'; }) ? 'fail' : out.some(function (x) { return x.state === 'warn'; }) ? 'warn' : 'pass';
    return { checks: out, verdict: verdict };
  }

  /* ======================================================================
     Files: sales import, downloads, IndexedDB
     ====================================================================== */
  function parseCSV(text) {
    var rows = [], row = [], f = '', q = false;
    text = text.replace(/^﻿/, '');
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(f); rows.push(row); row = []; f = '';
      } else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return String(x).trim() !== ''; }); });
  }
  function parseDate(v) {
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * DAY));
    var s = String(v || '').trim();
    if (!s) return null;
    var m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (m) { var y = +m[3]; if (y < 100) y += 2000; return new Date(y, +m[2] - 1, +m[1]); }
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    var d = new Date(s);
    return isNaN(d) ? null : d;
  }
  function gridToSales(grid) {
    var head = grid[0].map(function (h) { return String(h).toLowerCase().trim(); });
    function find() {
      var res = Array.prototype.slice.call(arguments);
      return head.findIndex(function (h) { return res.some(function (r) { return r.test(h); }); });
    }
    var ci = find(/categ|battery type|^type|class/), chi = find(/chem/), ui = find(/unit|qty|quantit|count|nos/),
        wi = find(/weight|kg|mass/), qi = find(/quarter|^qtr|^q$/), di = find(/date|month|period/), ri = find(/ref|invoice|sku|model|product|desc/);
    if (wi < 0 || ci < 0) throw new Error('Couldn’t find a category and a weight column. Download the template to see the format.');
    return grid.slice(1).map(function (r) {
      function get(i) { return i >= 0 ? r[i] : ''; }
      var quarter = ((String(get(qi)).toUpperCase().match(/Q[1-4]/) || [])[0]) || '';
      var fy = S.fy, d = parseDate(get(di));
      if (d) { fy = fyOf(d); quarter = quarter || quarterOf(d); }
      return {
        id: uid(), fy: fy, quarter: quarter, category: normCat(get(ci)), chemistry: String(get(chi) || '').trim(),
        units: num(get(ui)), weightKg: num(get(wi)), ref: String(get(ri) || '').trim(), source: 'import'
      };
    });
  }
  function loadXLSX() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
      s.onload = function () { res(window.XLSX); };
      s.onerror = function () { rej(new Error('Couldn’t load the Excel reader. Save the file as CSV and try again.')); };
      document.head.appendChild(s);
    });
  }
  function readSalesFile(file) {
    if (file.size > 15 * 1024 * 1024) return Promise.reject(new Error('That file is over 15 MB. Split it or save as CSV.'));
    var p;
    if (/\.(xlsx|xls)$/i.test(file.name)) {
      p = loadXLSX().then(function (X) {
        return file.arrayBuffer().then(function (buf) {
          var wb = X.read(buf, { cellDates: true });
          return X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
        });
      });
    } else if (/\.(csv|txt)$/i.test(file.name)) {
      p = file.text().then(parseCSV);
    } else return Promise.reject(new Error('Upload a CSV or Excel file.'));
    return p.then(function (grid) {
      if (!grid || grid.length < 2) throw new Error('The file has no data rows.');
      return gridToSales(grid);
    });
  }
  function download(name, content, type) {
    var blob = content instanceof Blob ? content : new Blob([content], { type: type || 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  var DB = {
    db: null,
    open: function () {
      var self = this;
      if (self.db) return Promise.resolve(self.db);
      return new Promise(function (res, rej) {
        if (!window.indexedDB) return rej(new Error('File storage is not available in this browser.'));
        var r = indexedDB.open('ampliance', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('files', { keyPath: 'id' }); };
        r.onsuccess = function () { self.db = r.result; res(self.db); };
        r.onerror = function () { rej(r.error); };
      });
    },
    req: function (mode, fn) {
      return this.open().then(function (db) {
        return new Promise(function (res, rej) {
          var r = fn(db.transaction('files', mode).objectStore('files'));
          r.onsuccess = function () { res(r.result); };
          r.onerror = function () { rej(r.error); };
        });
      });
    },
    all: function () { return this.req('readonly', function (s) { return s.getAll(); }); },
    get: function (id) { return this.req('readonly', function (s) { return s.get(id); }); },
    put: function (o) { return this.req('readwrite', function (s) { return s.put(o); }); },
    del: function (id) { return this.req('readwrite', function (s) { return s.delete(id); }); },
    clear: function () { return this.req('readwrite', function (s) { return s.clear(); }); }
  };
  var docs = null; // metadata cache
  function refreshDocs() {
    return DB.all().then(function (list) {
      docs = list.map(function (d) { return { id: d.id, name: d.name, type: d.type, size: d.size, tag: d.tag, addedAt: d.addedAt }; })
        .sort(function (a, b) { return a.addedAt < b.addedAt ? 1 : -1; });
    }).catch(function () { docs = []; });
  }

  /* ======================================================================
     UI primitives: toast, modal, confirm
     ====================================================================== */
  var toastTimer;
  function toast(msg, kind) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show ' + (kind || 'ok');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 3400);
  }
  var modal = $('#modal');
  var lastFocus = null;
  function openModal(html, label) {
    lastFocus = document.activeElement;
    modal.innerHTML = '<div class="modal-in">' + html + '</div>';
    modal.setAttribute('aria-label', label || 'Dialog');
    if (!modal.open) modal.showModal();
    var f = modal.querySelector('[autofocus], input:not([type=hidden]), select, textarea, button');
    if (f) f.focus();
  }
  function closeModal() { if (modal.open) modal.close(); }
  modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
  var confirmResolve = null;
  modal.addEventListener('close', function () {
    if (confirmResolve) { var r = confirmResolve; confirmResolve = null; r(false); }
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  });
  function ask(title, body, ok, danger) {
    return new Promise(function (res) {
      openModal('<h2>' + esc(title) + '</h2><p class="muted mt8">' + body + '</p>' +
        '<div class="modal-actions"><button class="btn g" data-act="confirm-no">Cancel</button>' +
        '<button class="btn ' + (danger ? 'danger' : 'p') + '" data-act="confirm-yes" autofocus>' + esc(ok || 'Confirm') + '</button></div>', title);
      confirmResolve = res;
    });
  }

  /* ======================================================================
     Rendering
     ====================================================================== */
  var VIEWS = {};
  var view = 'dashboard';
  var obStep = 1;
  var lastCheck = null;     // { input, result }
  var pendingImport = null; // rows awaiting confirmation

  function currentRoute() { return (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'dashboard'; }

  function render() {
    view = currentRoute();
    if (!S.onboarded) view = 'onboarding';
    else if (view === 'onboarding' || !VIEWS[view]) view = 'dashboard';
    var html = view === 'onboarding' ? VIEWS.onboarding() : shell(VIEWS[view]());
    $('#app').innerHTML = html;
    document.title = (view === 'onboarding' ? 'Set up' : (NAV.filter(function (n) { return n.k === view; })[0] || { t: 'Settings' }).t) + ' · Ampliance';
    if (view === 'documents' && docs === null) refreshDocs().then(function () { if (view === 'documents') render(); });
  }

  function shell(inner) {
    var a = attention();
    var alert = a.overdue.length + a.soon.length;
    var p = S.profile;
    var initials = (p.name || 'A').split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
    var fys = [fyOf(new Date()), fyOf(new Date(new Date().getFullYear() - 1, new Date().getMonth(), 1))];
    S.sales.concat(S.certificates).forEach(function (r) { if (r.fy && fys.indexOf(r.fy) < 0) fys.push(r.fy); });
    if (fys.indexOf(S.fy) < 0) fys.push(S.fy);
    fys.sort().reverse();
    var crumb = (NAV.filter(function (n) { return n.k === view; })[0] || { t: 'Settings' }).t;
    return '<div class="shell">' +
      '<aside class="side"><a class="brand" href="#/dashboard"><span>Amp</span>liance</a>' +
      '<nav class="nav" aria-label="Main">' + NAV.map(function (n) {
        var badge = n.k === 'deadlines' && alert ? '<span class="count' + (a.overdue.length ? ' bad' : '') + '">' + alert + '</span>' : '';
        return '<a href="#/' + n.k + '"' + (view === n.k ? ' class="on" aria-current="page"' : '') + '>' + icon(n.k) + '<span>' + n.t + '</span>' + badge + '</a>';
      }).join('') + '</nav>' +
      '<a class="org" href="#/settings" aria-label="Business settings"><span class="av">' + esc(initials) + '</span><div style="min-width:0"><b>' + esc(p.name || 'Your business') + '</b><small>' +
      esc((p.roles.map(function (r) { return (ROLES[r] || '').split(' /')[0]; })[0] || 'Producer') + (p.city ? ' · ' + p.city : '')) + '</small></div></a></aside>' +
      '<div class="main"><header class="top"><a class="brand" href="#/dashboard"><span>Amp</span>liance</a><span class="crumb">' + esc(crumb) + ' / ' + esc(fyLabel(S.fy)) + '</span>' +
      '<div class="top-r"><label class="sr" for="fy">Financial year</label><select id="fy" class="fy-select" data-change="fy">' +
      fys.map(function (f) { return '<option value="' + f + '"' + (f === S.fy ? ' selected' : '') + '>' + fyLabel(f) + '</option>'; }).join('') + '</select>' +
      '<a class="iconbtn" href="#/deadlines" aria-label="Deadlines' + (alert ? ', ' + alert + ' need attention' : '') + '">' + icon('bell') + (alert ? '<span class="dot' + (a.overdue.length ? ' bad' : '') + '"></span>' : '') + '</a>' +
      '<a class="av" href="#/settings" style="border-radius:50%" aria-label="Settings">' + esc(initials) + '</a></div></header>' +
      '<main class="content" id="main">' + (S.sample ? sampleBanner() : '') + inner + '</main></div></div>';
  }
  function sampleBanner() {
    return '<div class="banner info"><span class="pill mut">Sample data</span><span class="grow">You’re exploring with a made-up business. Nothing here is real.</span>' +
      '<button class="btn g sm" data-act="reset">Start fresh with my business</button></div>';
  }

  function gauge(pct) {
    var N = 12, lit = Math.round(Math.max(0, Math.min(1, pct)) * N), y0 = 30, bot = 234, gap = 4, h = (bot - y0 - gap * (N - 1)) / N, cells = '';
    for (var i = 0; i < N; i++) {
      var on = i < lit;
      cells += '<rect x="24" width="92" rx="4" height="' + h.toFixed(2) + '" y="' + (bot - (i + 1) * h - i * gap).toFixed(2) + '" fill="' + (on ? 'url(#cellg)' : 'rgba(241,236,224,.04)') + '" stroke="' + (on ? '#D4FF3F' : 'rgba(241,236,224,.08)') + '"' + (on ? ' style="filter:drop-shadow(0 0 6px rgba(212,255,63,.4))"' : '') + '/>';
    }
    return '<svg viewBox="0 0 140 250" role="img" aria-label="' + Math.floor(pct * 100) + '% of target covered"><defs><linearGradient id="cellg" x1="0" x2="1"><stop offset="0" stop-color="#B9E52A"/><stop offset=".45" stop-color="#E2FF66"/><stop offset="1" stop-color="#C2EC30"/></linearGradient></defs>' +
      '<rect x="48" y="4" width="44" height="14" rx="4" fill="' + (pct >= 1 ? '#D4FF3F' : 'rgba(241,236,224,.06)') + '" stroke="rgba(241,236,224,.35)"/>' +
      '<rect x="14" y="18" width="112" height="228" rx="20" fill="rgba(241,236,224,.02)" stroke="rgba(241,236,224,.35)" stroke-width="1.25"/>' + cells + '</svg>';
  }

  function catBars(o) {
    var cats = activeCats(o.cats);
    if (!cats.length) return '<p class="muted small">No categories yet.</p>';
    return '<div style="display:grid;gap:16px">' + cats.map(function (k) {
      var v = o.cats[k], cov = v.target ? Math.min(1, v.covered / v.target) : 0, pend = v.target ? Math.min(1 - cov, v.pending / v.target) : 0;
      return '<div><div class="row between small" style="margin-bottom:8px"><span style="font-size:13.5px">' + CATS[k] + '</span><span class="muted">' +
        fmt(v.covered) + ' / <b style="color:var(--ink);font-weight:500">' + fmt(v.target) + ' kg</b></span></div>' +
        '<div class="bar split"><i style="width:' + (cov * 100).toFixed(1) + '%"></i><i class="pend" style="width:' + (pend * 100).toFixed(1) + '%"></i></div></div>';
    }).join('') + '</div>';
  }

  /* ---------------- Onboarding ---------------- */
  VIEWS.onboarding = function () {
    var p = S.profile;
    var steps = ['Business', 'Batteries you sell', 'Sales data'];
    var top = '<div class="ob-top"><span class="brand"><span>Amp</span>liance</span><div class="steps" aria-label="Progress">' +
      steps.map(function (s, i) {
        var n = i + 1, st = n < obStep ? 'done' : n === obStep ? 'on' : '';
        return (i ? '<span class="step-line"></span>' : '') + '<span class="step ' + st + '"' + (n === obStep ? ' aria-current="step"' : '') + '><i>' + (n < obStep ? icon('tick') : n) + '</i><span>' + s + '</span></span>';
      }).join('') + '</div><span class="muted small">Step ' + obStep + ' of 3</span></div>';

    var body, aside;
    if (obStep === 1) {
      body = '<span class="lbl">Set up your EPR profile</span><h1>Tell us about your <em>business.</em></h1>' +
        '<p class="lead">We use this to fill in your returns and keep your records in one place.</p>' +
        '<form class="ob-form" data-form="ob1" novalidate>' +
        '<div class="grid2"><div class="field"><label for="ob-name">Business name</label><input class="input" id="ob-name" name="name" required value="' + esc(p.name) + '" autocomplete="organization"></div>' +
        '<div class="field"><label for="ob-gstin">GSTIN</label><input class="input mono-in" id="ob-gstin" name="gstin" required maxlength="15" value="' + esc(p.gstin) + '" placeholder="27ABCDE1234F1Z5" style="text-transform:uppercase"></div></div>' +
        '<div class="grid2"><div class="field"><label for="ob-contact">Your name</label><input class="input" id="ob-contact" name="contactName" value="' + esc(p.contactName) + '" autocomplete="name"></div>' +
        '<div class="field"><label for="ob-city">City</label><input class="input" id="ob-city" name="city" value="' + esc(p.city) + '" autocomplete="address-level2"></div></div>' +
        '<div class="grid2"><div class="field"><label for="ob-email">Email</label><input class="input" id="ob-email" type="email" name="email" value="' + esc(p.email) + '" autocomplete="email"></div>' +
        '<div class="field"><label for="ob-phone">Mobile (for reminders at launch)</label><input class="input" id="ob-phone" type="tel" name="phone" value="' + esc(p.phone) + '" autocomplete="tel" placeholder="+91"></div></div>' +
        '<p class="err" id="ob-err" role="alert" style="color:var(--red);font-size:13px;min-height:1px"></p>' +
        '<div class="row wrap"><button class="btn p" type="submit">Continue ' + icon('arrow') + '</button><button class="btn g" type="button" data-act="sample">Explore with sample data</button></div></form>';
      aside = asideCard('Why we ask', 'Your GSTIN and business name appear on every <em>EPR filing.</em>',
        'Ampliance keeps them consistent across your obligation, certificates and returns, so nothing gets rejected on a typo.',
        ['Takes about 4 minutes', 'Everything stays in this browser', 'You can change it later in Settings']);
    } else if (obStep === 2) {
      body = '<span class="lbl">Set up your EPR profile</span><h1>What kind of producer <em>are you?</em></h1>' +
        '<p class="lead">This decides which CPCB obligations apply to you. Pick all that fit.</p>' +
        '<form class="ob-form" data-form="ob2" novalidate>' +
        '<fieldset class="field" style="border:0;padding:0;margin:0"><legend class="flabel" style="font-size:13px;color:var(--ink-2);margin-bottom:8px">Your role</legend><div class="chips">' +
        Object.keys(ROLES).map(function (k) { return '<label class="chip"><input type="checkbox" name="roles" value="' + k + '"' + (p.roles.indexOf(k) > -1 ? ' checked' : '') + '>' + ROLES[k] + '</label>'; }).join('') + '</div></fieldset>' +
        '<fieldset class="field" style="border:0;padding:0;margin:0"><legend class="flabel" style="font-size:13px;color:var(--ink-2);margin-bottom:8px">Battery categories you place on the market</legend><div class="chips">' +
        Object.keys(CATS).map(function (k) { return '<label class="chip"><input type="checkbox" name="categories" value="' + k + '"' + (p.categories.indexOf(k) > -1 ? ' checked' : '') + '>' + CATS[k] + '</label>'; }).join('') + '</div></fieldset>' +
        '<fieldset class="field" style="border:0;padding:0;margin:0"><legend class="flabel" style="font-size:13px;color:var(--ink-2);margin-bottom:8px">CPCB EPR registration</legend><div class="chips">' +
        '<label class="chip"><input type="radio" name="regStatus" value="yes"' + (p.regStatus !== 'no' ? ' checked' : '') + '>I’m registered</label>' +
        '<label class="chip"><input type="radio" name="regStatus" value="no"' + (p.regStatus === 'no' ? ' checked' : '') + '>Not yet</label></div></fieldset>' +
        '<div class="field"><label for="ob-reg">Registration number <span class="muted">(if registered)</span></label><input class="input mono-in" id="ob-reg" name="eprReg" value="' + esc(p.eprReg) + '"></div>' +
        '<p class="err" id="ob-err" role="alert" style="color:var(--red);font-size:13px;min-height:1px"></p>' +
        '<div class="row"><button class="btn p" type="submit">Continue ' + icon('arrow') + '</button><button class="btn g" type="button" data-act="ob-back">Back</button></div></form>';
      aside = asideCard('Why we ask', 'Assemblers and importers both count as <em>producers</em> under the Battery Waste Management Rules.',
        'Each battery category has its own recycling target. Ampliance tracks them separately so you never buy the wrong certificates.',
        ['No regulatory knowledge needed', 'Not registered yet? You can still set up', 'Change categories any time']);
    } else {
      var n = S.sales.length;
      body = '<span class="lbl">Set up your EPR profile</span><h1>Add your <em>sales.</em></h1>' +
        '<p class="lead">Upload what you sold this year so we can work out your recycling target. A CSV or Excel export from your billing software works.</p>' +
        '<div class="ob-form">' + dropZone('ob') +
        (n ? '<div class="banner info" style="margin:0"><span class="check">' + icon('tick') + '</span><span class="grow">' + plural(n, 'sales row') + ' added.</span></div>' : '') +
        '<p class="small muted">Columns we look for: date or quarter, category, chemistry, units, weight in kg. <button class="link" data-act="template">Download the template</button></p>' +
        '<div class="row wrap"><button class="btn p" data-act="ob-finish">' + (n ? 'Go to my dashboard' : 'Skip for now') + ' ' + icon('arrow') + '</button><button class="btn g" data-act="ob-back">Back</button></div></div>';
      aside = asideCard('What happens next', 'We turn your sales into a clear <em>target</em> in kilograms.',
        'Then we show how much is covered by certificates, what’s left to buy, and every deadline on the way.',
        ['Rows with missing data are flagged, not dropped', 'Your file never leaves this browser', 'You can upload more each quarter']);
    }
    return '<div class="ob">' + top + '<div class="ob-body"><div>' + body + '</div>' + aside + '</div></div>';
  };
  function asideCard(lbl, headline, text, points) {
    return '<aside class="card hl" style="align-self:start;padding:26px"><span class="lbl">' + lbl + '</span>' +
      '<p class="serif" style="margin-top:14px;font-size:26px;line-height:1.15">' + headline + '</p>' +
      '<p style="color:var(--ink-2);font-size:14px;line-height:1.6;margin-top:16px">' + text + '</p>' +
      '<div class="checklist" style="border-top:1px solid var(--line);margin-top:22px;padding-top:18px">' +
      points.map(function (t) { return '<span class="row"><span class="check">' + icon('tick') + '</span>' + t + '</span>'; }).join('') + '</div></aside>';
  }
  function dropZone(ctx) {
    return '<label class="drop" data-drop="' + ctx + '"><input type="file" accept=".csv,.xlsx,.xls,.txt" data-change="sales-file">' +
      '<span class="drop-ic">' + icon('up') + '</span><span><b>Upload sales file</b><span class="muted small">CSV or Excel · drag it here or click to browse</span></span></label>';
  }

  /* ---------------- Dashboard ---------------- */
  VIEWS.dashboard = function () {
    var o = obligation(), t = o.t;
    var hasSales = S.sales.some(function (r) { return r.fy === S.fy; });
    var a = attention();
    var open = allDeadlines().filter(function (d) { return !d.done; });
    var first = (S.profile.contactName || '').split(' ')[0];
    var hr = new Date().getHours();
    var greet = (hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening') + (first ? ', <em>' + esc(first) + '.</em>' : '<em>.</em>');
    var lead = !hasSales ? 'Upload your sales for ' + fyLabel(S.fy) + ' to see what you owe.'
      : t.target > 0 && t.gap <= 0 ? 'Your ' + fyLabel(S.fy) + ' target is fully covered. Nice.'
      : 'You’re ' + Math.floor(t.pct * 100) + '% of the way to this year’s target.' + (a.overdue.length + a.soon.length ? ' Something needs you soon.' : '');

    var urgent = a.overdue[0] || a.soon[0];
    var banner = urgent ? '<div class="banner ' + (urgent.days < 0 ? 'bad' : 'warn') + '">' + dayPill(urgent) + '<span class="grow"><b style="font-weight:500">' + esc(urgent.title) + '</b> · ' + esc(urgent.note) + '</span>' +
      '<a class="btn p sm" href="#/' + (urgent.link || 'deadlines') + '">Open</a></div>' : '';

    if (!hasSales && !S.certificates.length) {
      return '<div class="head"><div><h1>' + greet + '</h1><p class="lead">' + lead + '</p></div></div>' + banner +
        '<div class="card empty"><p class="serif">Start with your sales.</p><p>Upload a CSV or Excel export of the batteries you sold in ' + fyLabel(S.fy) + '. We’ll turn it into your EPR target.</p>' +
        '<div style="max-width:460px;margin:0 auto;text-align:left">' + dropZone('dash') + '</div>' +
        '<p class="small muted mt16"><button class="link" data-act="template">Download the template</button> · or <a class="link" href="#/obligations">add rows by hand</a></p></div>';
    }

    return '<div class="head"><div><h1>' + greet + '</h1><p class="lead">' + lead + '</p></div></div>' + banner +
      '<div class="cols-dash"><div class="card gauge"><span class="lbl" style="align-self:flex-start">Compliance charge</span>' + gauge(t.pct) +
      '<div class="big" style="margin:0;font-size:56px">' + Math.floor(t.pct * 100) + '%</div><span class="muted small mt8">' + fmt(t.effective) + ' of ' + fmt(t.target) + ' kg covered</span>' +
      (t.pending ? '<span class="small mt8" style="color:var(--amber)">+ ' + fmt(t.pending) + ' kg awaiting portal confirmation</span>' : '') + '</div>' +
      '<div class="stack"><div class="stats">' +
      '<div class="card"><span class="lbl">Target</span><div class="big">' + fmt(t.target) + '<small>kg</small></div><span class="muted small">' + (t.locked ? 'Locked on ' + fmtDate(S.locks[S.fy].at) : 'Not locked yet') + '</span></div>' +
      '<div class="card"><span class="lbl">Covered</span><div class="big volt">' + fmt(t.effective) + '<small>kg</small></div><span class="muted small">' + plural(S.certificates.filter(function (c) { return c.fy === S.fy && c.status === 'verified'; }).length, 'confirmed certificate') + '</span></div>' +
      '<div class="card"><span class="lbl">Still to buy</span><div class="big">' + fmt(t.gap) + '<small>kg</small></div><span class="muted small">' + (t.gap > 0 ? biggestGap(o) : 'Nothing left') + '</span></div></div>' +
      '<div class="card"><div class="row between" style="margin-bottom:16px"><span class="lbl">By category</span><a class="small muted" href="#/obligations">Details</a></div>' + catBars(o) + '</div>' +
      '<div class="card flush"><div class="card-h"><span class="lbl">Coming up</span><a class="small muted" href="#/deadlines">View all</a></div>' +
      (open.length ? '<div class="table-wrap"><table><tbody>' + open.slice(0, 4).map(function (d) {
        return '<tr><td><b>' + esc(d.title) + '</b></td><td class="num">' + fmtDate(d.date) + '</td><td class="num">' + dayPill(d) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<p class="muted small" style="padding:18px 22px">Nothing pending. You’re all caught up.</p>') +
      '</div></div></div>';
  };
  function biggestGap(o) {
    var k = Object.keys(o.cats).sort(function (a, b) { return o.cats[b].gap - o.cats[a].gap; })[0];
    return 'Mostly ' + CATS[k].toLowerCase();
  }

  /* ---------------- Obligations ---------------- */
  VIEWS.obligations = function () {
    var o = obligation(), t = o.t;
    var rows = S.sales.filter(function (r) { return r.fy === S.fy; });
    var issues = rows.filter(rowIssue);
    var groups = {}, order = [];
    rows.filter(function (r) { return !rowIssue(r); }).forEach(function (r) {
      var k = r.category + '|' + (r.chemistry || '—');
      if (!groups[k]) { groups[k] = { category: r.category, chemistry: r.chemistry || '—', units: 0, kg: 0 }; order.push(k); }
      groups[k].units += r.units || 0; groups[k].kg += r.weightKg;
    });
    order.sort(function (a, b) { return Object.keys(CATS).indexOf(groups[a].category) - Object.keys(CATS).indexOf(groups[b].category) || groups[b].kg - groups[a].kg; });
    var q = quartersWithSales(S.fy);

    var head = '<div class="head"><div><h1>What you <em>owe</em> this year</h1><p class="lead">Calculated from the batteries you placed on the market in ' + fyLabel(S.fy) + '.' + (t.locked ? '' : ' Review it, then lock it in.') + '</p></div>' +
      '<div class="head-actions"><button class="btn g" data-act="sale-new">' + icon('plus') + 'Add row</button>' +
      (t.locked ? '<button class="btn g" data-act="unlock">Unlock target</button>' : '<button class="btn p" data-act="lock"' + (t.computed > 0 ? '' : ' disabled') + '>Lock obligation ' + icon('arrow') + '</button>') + '</div></div>';

    var drift = t.lockDrift ? '<div class="banner warn"><span class="pill warn">Sales changed</span><span class="grow">Your sales now work out to ' + fmt(t.computed) + ' kg, but your locked target is ' + fmt(t.target) + ' kg.</span><button class="btn g sm" data-act="relock">Update lock</button></div>' : '';

    var table = rows.length ? '<div class="table-wrap"><table><thead><tr><th>Category</th><th>Chemistry</th><th class="num">Units</th><th class="num">Weight (kg)</th><th class="num">Rate</th><th class="num">Target (kg)</th></tr></thead><tbody>' +
      order.map(function (k) {
        var g = groups[k], rate = +S.rates[g.category] || 0;
        return '<tr><td><b>' + CATS[g.category] + '</b></td><td>' + esc(g.chemistry) + '</td><td class="num">' + fmtInt(g.units) + '</td><td class="num">' + fmt(g.kg) + '</td><td class="num">' + rate + '%</td><td class="num"><b>' + fmt(g.kg * rate / 100) + '</b></td></tr>';
      }).join('') +
      issues.map(function (r) {
        return '<tr><td><span class="pill warn">' + esc(rowIssue(r)) + '</span></td><td>' + esc(r.chemistry || '—') + '</td><td class="num">' + fmtInt(r.units) + '</td><td class="num">' + (r.weightKg ? fmt(r.weightKg) : '—') + '</td><td class="num">—</td><td class="num"><button class="btn g xs" data-act="sale-edit" data-id="' + r.id + '">Fix</button></td></tr>';
      }).join('') + '</tbody>' +
      '<tfoot><tr><td colspan="3">Total</td><td class="num">' + fmt(t.placed) + '</td><td></td><td class="num">' + fmt(t.computed) + '</td></tr></tfoot></table></div>' : '';

    var card = '<div class="card flush"><div class="card-h"><div><span class="lbl">Sales · ' + fyLabel(S.fy) + '</span><div class="small muted mt8">' +
      plural(rows.length, 'row') + ' · quarters: ' + ['Q1', 'Q2', 'Q3', 'Q4'].map(function (x) { return '<span style="color:' + (q[x] ? 'var(--volt)' : 'var(--ink-3)') + '">' + x + '</span>'; }).join(' ') + '</div></div>' +
      (issues.length ? '<span class="pill warn">' + plural(issues.length, 'row') + ' to review</span>' : rows.length ? '<span class="pill ok">All rows counted</span>' : '') + '</div>' +
      '<div style="padding:18px 22px;border-bottom:1px solid var(--line)">' + dropZone('ob-page') + '<p class="small muted mt12">Columns we look for: date or quarter, category, chemistry, units, weight in kg. <button class="link" data-act="template">Download the template</button></p></div>' +
      (rows.length ? table : '<p class="muted" style="padding:22px">No sales for ' + fyLabel(S.fy) + ' yet.</p>') +
      (rows.length ? '<details style="border-top:1px solid var(--line)"><summary class="small" style="padding:14px 22px;cursor:pointer;color:var(--ink-2)">All rows (' + rows.length + ')</summary><div class="table-wrap"><table><thead><tr><th>Qtr</th><th>Category</th><th>Chemistry</th><th class="num">Units</th><th class="num">kg</th><th>Reference</th><th></th></tr></thead><tbody>' +
        rows.slice(0, 400).map(function (r) {
          return '<tr><td>' + esc(r.quarter || '—') + '</td><td>' + (r.category ? CATS[r.category] : '<span class="pill warn">Unknown</span>') + '</td><td>' + esc(r.chemistry || '—') + '</td><td class="num">' + fmtInt(r.units) + '</td><td class="num">' + (r.weightKg ? fmt(r.weightKg) : '—') + '</td><td class="muted">' + esc(r.ref || '') + '</td>' +
            '<td class="t-actions"><button class="icon-act" data-act="sale-edit" data-id="' + r.id + '" aria-label="Edit row">' + icon('edit') + '</button><button class="icon-act" data-act="sale-del" data-id="' + r.id + '" aria-label="Delete row">' + icon('trash') + '</button></td></tr>';
        }).join('') + '</tbody></table></div>' + (rows.length > 400 ? '<p class="small muted" style="padding:12px 22px">Showing the first 400 rows.</p>' : '') +
        '<div class="card-f"><span class="small muted">Imported the wrong file?</span><button class="btn danger sm" data-act="sales-clear">Delete all ' + fyLabel(S.fy) + ' rows</button></div></details>' : '') + '</div>';

    var side = '<div class="stack"><div class="card hl"><span class="lbl">Total EPR target · ' + fyLabel(S.fy) + '</span><div class="big" style="font-size:60px">' + fmt(t.target) + '<small>kg</small></div>' +
      '<p class="muted small mt12" style="line-height:1.5">' + (t.locked ? 'Locked on ' + fmtDate(S.locks[S.fy].at) + '. ' : '') + 'The weight of batteries you need recycling certificates for this year.</p></div>' +
      '<div class="card"><span class="lbl">By category</span><div class="mt16">' + catBars(o) + '</div></div>' +
      '<div class="card"><span class="lbl">Target rates</span><div class="mt12 small" style="display:grid;gap:6px">' +
      activeCats(o.cats).map(function (k) { return '<div class="row between"><span>' + CATS[k] + '</span><b style="font-weight:500">' + (+S.rates[k] || 0) + '%</b></div>'; }).join('') + '</div>' +
      (S.ratesConfirmed ? '' : '<p class="small mt12" style="color:var(--amber);line-height:1.5">These are placeholder rates. Confirm them against Schedule II of the Battery Waste Management Rules for ' + fyLabel(S.fy) + '.</p>') +
      '<a class="btn g sm mt12" href="#/settings">Edit rates</a></div></div>';

    return head + drift + '<div class="cols">' + card + side + '</div>';
  };

  function saleModal(r) {
    r = r || { id: '', quarter: '', category: S.profile.categories[0] || '', chemistry: '', units: '', weightKg: '', ref: '' };
    openModal('<h2>' + (r.id ? 'Edit sales row' : 'Add sales row') + '</h2><p class="muted small">Counts towards ' + fyLabel(r.fy || S.fy) + '.</p>' +
      '<form data-form="sale" novalidate><input type="hidden" name="id" value="' + esc(r.id) + '">' +
      '<div class="grid2"><div class="field"><label for="s-cat">Category</label><select class="input" id="s-cat" name="category" required><option value="">Choose…</option>' +
      Object.keys(CATS).map(function (k) { return '<option value="' + k + '"' + (r.category === k ? ' selected' : '') + '>' + CATS[k] + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label for="s-q">Quarter</label><select class="input" id="s-q" name="quarter"><option value="">Not sure</option>' +
      ['Q1', 'Q2', 'Q3', 'Q4'].map(function (x) { return '<option value="' + x + '"' + (r.quarter === x ? ' selected' : '') + '>' + x + ' · ' + Q_MONTHS[x] + '</option>'; }).join('') + '</select></div></div>' +
      '<div class="field"><label for="s-chem">Chemistry</label><input class="input" id="s-chem" name="chemistry" list="chem-list" value="' + esc(r.chemistry) + '" placeholder="Li-ion, Lead-acid, Ni-MH…"><datalist id="chem-list"><option value="Li-ion"><option value="Lead-acid"><option value="Ni-MH"><option value="Ni-Cd"><option value="Alkaline"><option value="LFP"></datalist></div>' +
      '<div class="grid2"><div class="field"><label for="s-units">Units sold</label><input class="input" id="s-units" name="units" inputmode="numeric" value="' + esc(r.units) + '"></div>' +
      '<div class="field"><label for="s-kg">Total weight (kg)</label><input class="input" id="s-kg" name="weightKg" inputmode="decimal" required value="' + esc(r.weightKg || '') + '"></div></div>' +
      '<div class="field"><label for="s-ref">Reference <span class="muted">(optional)</span></label><input class="input" id="s-ref" name="ref" value="' + esc(r.ref) + '" placeholder="Invoice, SKU or product"></div>' +
      '<p class="err" id="m-err" role="alert" style="color:var(--red);font-size:13px"></p>' +
      '<div class="modal-actions"><button type="button" class="btn g" data-act="modal-close">Cancel</button><button class="btn p" type="submit">Save row</button></div></form>', 'Sales row');
  }

  function importModal(rows) {
    pendingImport = rows;
    var by = {}, fys = {}, bad = rows.filter(rowIssue).length;
    rows.forEach(function (r) { if (!rowIssue(r)) by[r.category] = (by[r.category] || 0) + r.weightKg; fys[r.fy] = (fys[r.fy] || 0) + 1; });
    var fyKeys = Object.keys(fys);
    var existing = S.sales.filter(function (r) { return fyKeys.indexOf(r.fy) > -1; }).length;
    openModal('<h2>' + plural(rows.length, 'row') + ' found</h2><p class="muted small">' + fyKeys.map(fyLabel).join(', ') + (bad ? ' · <span style="color:var(--amber)">' + plural(bad, 'row') + (bad === 1 ? ' needs' : ' need') + ' a look</span>' : '') + '</p>' +
      '<div class="card mt20" style="padding:16px 18px"><div style="display:grid;gap:8px;font-size:14px">' +
      (Object.keys(by).length ? Object.keys(by).map(function (k) { return '<div class="row between"><span>' + CATS[k] + '</span><b style="font-weight:500">' + fmt(by[k]) + ' kg</b></div>'; }).join('') : '<span class="muted">No rows could be counted yet. Check the category and weight columns.</span>') +
      '</div></div>' +
      (bad ? '<p class="small muted mt12">Rows missing a category or weight are kept and flagged so you can fix them.</p>' : '') +
      '<div class="modal-actions"><button class="btn g" data-act="modal-close">Cancel</button>' +
      (existing ? '<button class="btn g" data-act="import" data-mode="replace">Replace ' + plural(existing, 'existing row') + '</button>' : '') +
      '<button class="btn p" data-act="import" data-mode="append">' + (existing ? 'Add to existing' : 'Import rows') + '</button></div>', 'Import sales');
  }

  /* ---------------- Certificates ---------------- */
  VIEWS.certificates = function () {
    var o = obligation(), t = o.t;
    var mine = S.certificates.filter(function (c) { return c.fy === S.fy; }).sort(function (a, b) { return a.addedAt < b.addedAt ? 1 : -1; });
    var inp = lastCheck ? lastCheck.input : { category: S.profile.categories[0] || 'portable' };
    var form = '<form class="card" data-form="verify" novalidate style="padding:24px"><span class="lbl">Check a certificate</span>' +
      '<div class="row mt16 wrap" style="gap:12px"><div class="field grow" style="min-width:240px"><label class="sr" for="v-id">Certificate ID</label><input class="input pill-in mono-in" id="v-id" name="certId" required placeholder="Certificate ID from the seller" value="' + esc(inp.certId || '') + '"></div>' +
      '<button class="btn p" type="submit" style="height:52px;padding:0 26px">Run checks</button></div>' +
      '<div class="grid3 mt16"><div class="field"><label for="v-rec">Recycler name</label><input class="input" id="v-rec" name="recycler" value="' + esc(inp.recycler || '') + '"></div>' +
      '<div class="field"><label for="v-reg">Recycler CPCB reg. no.</label><input class="input mono-in" id="v-reg" name="recyclerReg" value="' + esc(inp.recyclerReg || '') + '"></div>' +
      '<div class="field"><label for="v-cat">Category</label><select class="input" id="v-cat" name="category">' + Object.keys(CATS).map(function (k) { return '<option value="' + k + '"' + (inp.category === k ? ' selected' : '') + '>' + CATS[k] + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label for="v-kg">Quantity (kg)</label><input class="input" id="v-kg" name="kg" inputmode="decimal" value="' + esc(inp.kg || '') + '"></div>' +
      '<div class="field"><label for="v-price">Price per kg (₹) <span class="muted">optional</span></label><input class="input" id="v-price" name="price" inputmode="decimal" value="' + esc(inp.price || '') + '"></div>' +
      '<div class="field"><label for="v-date">Date generated</label><input class="input" id="v-date" type="date" name="date" value="' + esc(inp.date || '') + '"></div></div>' +
      '<p class="err" id="v-err" role="alert" style="color:var(--red);font-size:13px;margin-top:10px"></p></form>';

    var result = '';
    if (lastCheck) {
      var r = lastCheck.result, v = r.verdict;
      var title = v === 'fail' ? 'Don’t buy this yet' : v === 'warn' ? 'Looks okay, with caveats' : 'Passes every check we can run';
      result = '<div class="card mt20" style="padding:26px;' + (v === 'pass' ? 'border-color:rgba(212,255,63,.3);background:linear-gradient(180deg,rgba(212,255,63,.07),rgba(241,236,224,.02))' : v === 'fail' ? 'border-color:rgba(255,142,115,.35)' : 'border-color:rgba(242,185,92,.35)') + '" id="check-result" tabindex="-1">' +
        '<div class="row between wrap"><div class="row" style="gap:14px"><span class="check lg ' + (v === 'pass' ? '' : v === 'fail' ? 'bad' : 'warn') + '">' + icon(v === 'pass' ? 'tick' : v === 'fail' ? 'x' : 'bang') + '</span>' +
        '<div><h2>' + title + '</h2><div class="muted small mono" style="margin-top:4px">' + esc(lastCheck.input.certId) + '</div></div></div>' +
        '<span class="pill ' + (v === 'pass' ? 'ok' : v === 'fail' ? 'bad' : 'warn') + '">' + (v === 'pass' ? 'Checks passed' : v === 'fail' ? 'Failed' : 'Review') + '</span></div>' +
        '<div class="checklist mt24">' + r.checks.map(function (c) {
          var cls = c.state === 'pass' ? '' : c.state === 'fail' ? 'bad' : c.state === 'warn' ? 'warn' : 'mut';
          return '<div class="row"><span class="check ' + cls + '">' + icon(c.state === 'pass' ? 'tick' : c.state === 'fail' ? 'x' : c.state === 'warn' ? 'bang' : 'dots') + '</span><div><span style="color:var(--ink)">' + esc(c.label) + '</span>' + (c.detail ? '<small>' + esc(c.detail) + '</small>' : '') + '</div></div>';
        }).join('') + '</div>' +
        (v !== 'fail' ? '<form data-form="add-cert" class="mt24" style="border-top:1px solid var(--line);padding-top:20px"><label class="cbox"><input type="checkbox" name="portal"> I’ve checked the CPCB EPR portal: this certificate is listed and available to transfer to me.</label>' +
          '<div class="row wrap mt16"><button class="btn p" type="submit">Add to my certificates</button><span class="small muted">Unconfirmed certificates are tracked but don’t count towards your target.</span></div></form>' : '') + '</div>';
    }

    var list = '<div class="card flush mt20"><div class="card-h"><div><span class="lbl">My certificates · ' + fyLabel(S.fy) + '</span><div class="small muted mt8">' + fmt(t.covered) + ' kg confirmed' + (t.pending ? ' · ' + fmt(t.pending) + ' kg awaiting confirmation' : '') + '</div></div>' +
      '<button class="btn g sm" data-act="cert-export"' + (mine.length ? '' : ' disabled') + '>' + icon('dl') + 'CSV</button></div>' +
      (mine.length ? '<div class="table-wrap"><table><thead><tr><th>Certificate</th><th>Recycler</th><th>Category</th><th class="num">kg</th><th class="num">₹/kg</th><th>Generated</th><th>Status</th><th></th></tr></thead><tbody>' +
        mine.map(function (c) {
          return '<tr><td class="mono" style="color:var(--ink)">' + esc(c.certId) + '</td><td>' + esc(c.recycler || '—') + '</td><td>' + CATS[c.category] + '</td><td class="num">' + fmt(c.kg) + '</td><td class="num">' + (c.price ? fmt(c.price) : '—') + '</td><td>' + (c.date ? fmtDate(c.date) : '—') + '</td>' +
            '<td>' + (c.status === 'verified' ? '<span class="pill ok">Confirmed</span>' : '<span class="pill warn">Confirm on portal</span>') + '</td>' +
            '<td class="t-actions">' + (c.status !== 'verified' ? '<button class="btn g xs" data-act="cert-confirm" data-id="' + c.id + '">Confirm</button>' : '') + '<button class="icon-act" data-act="cert-del" data-id="' + c.id + '" aria-label="Remove certificate">' + icon('trash') + '</button></td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="muted" style="padding:22px">No certificates for ' + fyLabel(S.fy) + ' yet. Run a check above, then add it.</p>') + '</div>';

    var recent = '<div class="card" style="padding:20px 22px"><span class="lbl">Recent checks</span>' +
      (S.checks.length ? '<div class="list mt8">' + S.checks.slice(0, 8).map(function (c) {
        var cls = c.verdict === 'pass' ? 'ok' : c.verdict === 'fail' ? 'bad' : 'warn';
        return '<div class="row"><span class="check ' + (c.verdict === 'pass' ? '' : cls) + '">' + icon(c.verdict === 'pass' ? 'tick' : c.verdict === 'fail' ? 'x' : 'bang') + '</span><div class="grow"><div class="mono" style="overflow:hidden;text-overflow:ellipsis">…' + esc(c.certId.slice(-8)) + '</div><div class="muted small">' + esc(c.summary) + '</div></div><span class="pill ' + cls + '">' + (c.verdict === 'pass' ? 'OK' : c.verdict === 'fail' ? 'Failed' : 'Review') + '</span></div>';
      }).join('') + '</div>' : '<p class="muted small mt12">Checks you run appear here.</p>') + '</div>';

    var tips = '<div class="card"><span class="lbl">Before you pay</span><div class="checklist mt16">' +
      ['Get the certificate ID and the recycler’s CPCB registration number in writing', 'Match the category to your obligation. Portable can’t cover automotive.', 'Be wary of prices far below the usual range', 'Pay only after the transfer shows on the CPCB portal'].map(function (x) {
        return '<div class="row"><span class="check mut">' + icon('dots') + '</span><div>' + x + '</div></div>';
      }).join('') + '</div>' + (S.priceRange.min || S.priceRange.max ? '' : '<p class="small muted mt16">Set your expected price range in <a class="link" href="#/settings">Settings</a> to flag suspicious offers.</p>') + '</div>';

    return '<div class="head"><div><h1>Check it <em>before</em> you pay</h1><p class="lead">Run the checks on any certificate a recycler offers you, then keep track of what you’ve bought.</p></div></div>' +
      '<div class="cols"><div>' + form + result + list + '</div><div class="stack">' + recent + tips + '</div></div>';
  };

  /* ---------------- Deadlines ---------------- */
  VIEWS.deadlines = function () {
    var list = allDeadlines();
    var notif = 'Notification' in window;
    var perm = notif ? Notification.permission : 'unsupported';
    var items = list.map(function (d) {
      var dt = parseISO(d.date);
      return '<div class="deadline' + (d.done ? ' done' : '') + '"><div class="date"><div class="lbl" style="color:' + (!d.done && d.days <= 14 ? (d.days < 0 ? 'var(--red)' : 'var(--amber)') : 'var(--ink-3)') + '">' + dt.toLocaleDateString('en-IN', { month: 'short' }) + '</div><div class="d">' + dt.getDate() + '</div><div class="small muted">' + dt.getFullYear() + '</div></div>' +
        '<div class="grow"><b>' + esc(d.title) + '</b><div class="muted small" style="margin-top:3px">' + esc(d.note || '') + (d.auto ? ' · done automatically' : '') + '</div></div>' +
        '<div class="row d-side">' + dayPill(d) +
        (d.link && !d.done ? '<a class="btn g sm" href="#/' + d.link + '">Open</a>' : '') +
        (!d.auto ? '<button class="btn g sm" data-act="dl-toggle" data-id="' + esc(d.id) + '">' + (d.done ? 'Undo' : 'Mark done') + '</button>' : '') +
        (d.kind === 'custom' ? '<button class="icon-act" data-act="dl-del" data-id="' + esc(d.id) + '" aria-label="Delete deadline">' + icon('trash') + '</button>' : '') +
        '</div></div>';
    }).join('');
    var rem = '<div class="card" style="padding:24px"><span class="lbl">Reminders</span>' +
      '<div style="display:grid;gap:18px;margin-top:18px;font-size:14px">' +
      '<label class="row" style="cursor:pointer"><div class="grow">Browser notifications<div class="muted small">' + (perm === 'denied' ? 'Blocked in your browser settings' : perm === 'unsupported' ? 'Not supported in this browser' : 'When Ampliance is open') + '</div></div><span class="toggle"><input type="checkbox" data-change="notif"' + (S.reminders.browser && perm === 'granted' ? ' checked' : '') + (perm === 'denied' || perm === 'unsupported' ? ' disabled' : '') + ' aria-label="Browser notifications"><span></span></span></label>' +
      '<div class="row"><div class="grow">WhatsApp &amp; email<div class="muted small">Arrives with the Ampliance server at launch</div></div><span class="pill mut">Soon</span></div></div>' +
      '<div class="divider"></div><span class="lbl">Remind me</span><div class="chips mt12">' +
      OFFSETS.map(function (n) { return '<label class="chip sm"><input type="checkbox" data-change="offset" value="' + n + '"' + (S.reminders.offsets.indexOf(n) > -1 ? ' checked' : '') + '>' + (n === 0 ? 'Same day' : n + (n === 1 ? ' day' : ' days') + ' before') + '</label>'; }).join('') + '</div>' +
      '<div class="divider"></div><p class="small muted" style="line-height:1.5">Put every deadline in Google Calendar, Outlook or Apple Calendar with these reminders built in.</p>' +
      '<button class="btn p sm mt12" data-act="ics">' + icon('cal') + 'Download calendar file</button></div>';
    return '<div class="head"><div><h1>Never miss a <em>deadline</em></h1><p class="lead">Every date that matters for ' + fyLabel(S.fy) + '. Upload and certificate steps tick themselves off as you go.</p></div>' +
      '<div class="head-actions"><button class="btn g" data-act="dl-new">' + icon('plus') + 'Add deadline</button></div></div>' +
      '<div class="cols"><div class="card" style="padding:4px 26px">' + items + '</div><div class="stack">' + rem +
      '<div class="card small muted" style="line-height:1.55">Statutory dates can change by notification. Ampliance shows the usual CPCB timeline; always confirm on the CPCB EPR portal.</div></div></div>';
  };

  /* ---------------- Returns ---------------- */
  VIEWS.returns = function () {
    var o = obligation(), t = o.t, cats = activeCats(o.cats);
    var q = quartersWithSales(S.fy), qn = Object.keys(q).length;
    var mine = S.certificates.filter(function (c) { return c.fy === S.fy; });
    var unconf = mine.filter(function (c) { return c.status !== 'verified'; }).length;
    var allMet = t.target > 0 && cats.every(function (k) { return o.cats[k].covered >= o.cats[k].target - 0.05; });
    var issues = S.sales.filter(function (r) { return r.fy === S.fy && rowIssue(r); }).length;
    var checks = [
      [qn === 4, 'Sales data for all 4 quarters', qn === 4 ? '' : 'Have: ' + (Object.keys(q).sort().join(', ') || 'none'), 'obligations'],
      [!issues && t.placed > 0, 'Every sales row counted', issues ? plural(issues, 'row') + (issues === 1 ? ' needs' : ' need') + ' fixing' : '', 'obligations'],
      [t.locked, 'Obligation locked', t.locked ? '' : 'Lock it so the numbers can’t drift', 'obligations'],
      [mine.length > 0 && !unconf, 'All certificates confirmed on the portal', unconf ? plural(unconf, 'certificate') + ' still to confirm' : mine.length ? '' : 'No certificates yet', 'certificates'],
      [allMet, 'Target met in every category', allMet ? '' : fmt(t.gap) + ' kg still to cover', 'certificates'],
      [GSTIN_RE.test(S.profile.gstin) && !!S.profile.eprReg, 'GSTIN and EPR registration on file', S.profile.eprReg ? '' : 'Add your registration number', 'settings']
    ];
    var ready = checks.every(function (c) { return c[0]; });
    var filed = S.filed[S.fy];
    var title = filed ? 'Your return is <em>filed.</em>' : ready ? 'Your return is <em>ready.</em>' : 'Your return is <em>taking shape.</em>';
    var lead = filed ? 'Marked as filed on ' + fmtDate(filed) + '. Keep the PDF with your records.' : ready ? 'Everything is pre-filled from your sales and certificates. Copy it into the CPCB portal and you’re done.' : 'Finish the items on the right and this summary will be ready to file.';
    return '<div class="head"><div><h1>' + title + '</h1><p class="lead">' + lead + '</p></div><div class="head-actions">' +
      '<button class="btn g" data-act="print"' + (t.placed > 0 ? '' : ' disabled') + '>' + icon('dl') + 'Download PDF</button>' +
      (filed ? '<button class="btn g" data-act="unfile">Undo filed</button>' : '<button class="btn p" data-act="file"' + (t.placed > 0 ? '' : ' disabled') + '>Mark as filed</button>') + '</div></div>' +
      '<div class="cols"><div class="card flush"><div class="card-h"><div><span class="lbl">Annual EPR return · summary · ' + fyLabel(S.fy) + '</span><div style="font-size:15px;margin-top:6px">' + esc(S.profile.name || 'Your business') + ' · Producer</div></div>' +
      (t.target > 0 ? '<span class="pill ' + (allMet ? 'ok' : 'warn') + '">' + (allMet ? 'Target met' : Math.floor(t.pct * 100) + '% covered') + '</span>' : '') + '</div>' +
      '<div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">Placed on market (kg)</th><th class="num">Target (kg)</th><th class="num">Certificates (kg)</th><th class="num">Status</th></tr></thead><tbody>' +
      (cats.length ? cats.map(function (k) {
        var v = o.cats[k], met = v.target > 0 && v.covered >= v.target - 0.05;
        return '<tr><td><b>' + CATS[k] + '</b></td><td class="num">' + fmt(v.placed) + '</td><td class="num">' + fmt(v.target) + '</td><td class="num">' + fmt(v.covered) + '</td><td class="num">' + (v.target <= 0 ? '<span class="pill mut">No target</span>' : met ? '<span class="pill ok">Met</span>' : '<span class="pill warn">Short ' + fmt(v.target - v.covered) + '</span>') + '</td></tr>';
      }).join('') : '<tr><td colspan="5" class="muted">No data for ' + fyLabel(S.fy) + ' yet.</td></tr>') + '</tbody>' +
      '<tfoot><tr><td>Total</td><td class="num">' + fmt(t.placed) + '</td><td class="num">' + fmt(t.target) + '</td><td class="num">' + fmt(t.covered) + '</td><td></td></tr></tfoot></table></div>' +
      '<div class="grid3" style="margin:4px 22px 22px;padding:18px 20px;border-radius:14px;background:var(--panel-2)">' +
      '<div><span class="lbl">Certificates</span><div class="mt8">' + mine.filter(function (c) { return c.status === 'verified'; }).length + ' confirmed</div></div>' +
      '<div><span class="lbl">Surplus</span><div class="mt8">' + fmt(t.surplus) + ' kg</div></div>' +
      '<div><span class="lbl">Usual due date</span><div class="mt8">' + fmtDate(new Date(fyStart(S.fy) + 1, 5, 30)) + '</div></div></div></div>' +
      '<div class="stack"><div class="card" style="padding:24px"><span class="lbl">Before you file</span><div class="checklist mt16">' +
      checks.map(function (c) {
        return '<div class="row"><span class="check ' + (c[0] ? '' : 'mut') + '">' + icon(c[0] ? 'tick' : 'dots') + '</span><div><span style="color:var(--ink)">' + c[1] + '</span>' + (c[2] ? '<small>' + esc(c[2]) + ' · <a class="link" href="#/' + c[3] + '">Fix</a></small>' : '') + '</div></div>';
      }).join('') + '</div><div class="divider"></div><span class="lbl">Step by step</span>' +
      '<ol style="margin:14px 0 0;padding-left:18px;color:var(--ink-2);font-size:13.5px;line-height:1.9"><li>Log in to the CPCB EPR portal</li><li>Open the annual return form</li><li>Copy each figure from this summary</li><li>Attach this PDF as your working</li><li>Come back and mark it as filed</li></ol></div></div></div>';
  };

  function printReturn() {
    var o = obligation(), t = o.t, p = S.profile;
    var mine = S.certificates.filter(function (c) { return c.fy === S.fy; });
    $('#print-root').innerHTML = '<h1>Annual EPR return summary · ' + fyLabel(S.fy) + '</h1>' +
      '<div class="meta"><div><span>Producer</span><br>' + esc(p.name) + '</div><div><span>GSTIN</span><br>' + esc(p.gstin) + '</div>' +
      '<div><span>EPR registration</span><br>' + esc(p.eprReg || '—') + '</div><div><span>Prepared</span><br>' + fmtDate(new Date()) + '</div></div>' +
      '<h2>Obligation and fulfilment</h2><table><thead><tr><th>Category</th><th class="num">Placed on market (kg)</th><th class="num">Rate</th><th class="num">Target (kg)</th><th class="num">Certificates (kg)</th></tr></thead><tbody>' +
      activeCats(o.cats).map(function (k) { var v = o.cats[k]; return '<tr><td>' + CATS[k] + '</td><td class="num">' + fmt(v.placed) + '</td><td class="num">' + v.rate + '%</td><td class="num">' + fmt(v.target) + '</td><td class="num">' + fmt(v.covered) + '</td></tr>'; }).join('') +
      '</tbody><tfoot><tr><td>Total</td><td class="num">' + fmt(t.placed) + '</td><td></td><td class="num">' + fmt(t.target) + '</td><td class="num">' + fmt(t.covered) + '</td></tr></tfoot></table>' +
      '<h2>Certificates</h2><table><thead><tr><th>Certificate ID</th><th>Recycler</th><th>Reg. no.</th><th>Category</th><th class="num">kg</th><th>Status</th></tr></thead><tbody>' +
      (mine.length ? mine.map(function (c) { return '<tr><td>' + esc(c.certId) + '</td><td>' + esc(c.recycler || '') + '</td><td>' + esc(c.recyclerReg || '') + '</td><td>' + CATS[c.category] + '</td><td class="num">' + fmt(c.kg) + '</td><td>' + (c.status === 'verified' ? 'Confirmed' : 'Not confirmed') + '</td></tr>'; }).join('') : '<tr><td colspan="6">None</td></tr>') +
      '</tbody></table><p class="note">Prepared with Ampliance from records entered by the producer. Figures should be checked against the CPCB EPR portal before filing. Target rates used: ' +
      activeCats(o.cats).map(function (k) { return CATS[k] + ' ' + o.cats[k].rate + '%'; }).join(', ') + (S.ratesConfirmed ? '' : ' (not yet confirmed by the producer)') + '.</p>';
    window.print();
  }

  /* ---------------- Documents ---------------- */
  VIEWS.documents = function () {
    var list = docs || [];
    function size(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
    return '<div class="head"><div><h1>Everything in <em>one place</em></h1><p class="lead">Keep your registration, certificates, invoices and filed returns ready for any CPCB query.</p></div></div>' +
      '<div class="cols"><div class="card flush"><div style="padding:18px 22px;border-bottom:1px solid var(--line)"><div class="row wrap" style="gap:12px">' +
      '<label class="drop grow" data-drop="docs" style="min-width:240px"><input type="file" multiple data-change="doc-file"><span class="drop-ic">' + icon('up') + '</span><span><b>Add documents</b><span class="muted small">PDF, images or spreadsheets · up to 20 MB each</span></span></label>' +
      '<div class="field" style="width:180px"><label for="doc-tag">File as</label><select class="input" id="doc-tag">' + DOC_TAGS.map(function (t) { return '<option>' + t + '</option>'; }).join('') + '</select></div></div></div>' +
      (docs === null ? '<p class="muted" style="padding:22px">Loading…</p>' : list.length ? '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th class="num">Size</th><th>Added</th><th></th></tr></thead><tbody>' +
        list.map(function (d) {
          return '<tr><td><b style="word-break:break-all">' + esc(d.name) + '</b></td><td><span class="pill mut">' + esc(d.tag) + '</span></td><td class="num">' + size(d.size) + '</td><td>' + fmtDate(d.addedAt) + '</td>' +
            '<td class="t-actions"><button class="icon-act" data-act="doc-dl" data-id="' + d.id + '" aria-label="Download ' + esc(d.name) + '">' + icon('dl') + '</button><button class="icon-act" data-act="doc-del" data-id="' + d.id + '" aria-label="Delete ' + esc(d.name) + '">' + icon('trash') + '</button></td></tr>';
        }).join('') + '</tbody></table></div>' : '<p class="muted" style="padding:22px">No documents yet.</p>') + '</div>' +
      '<div class="stack"><div class="card"><span class="lbl">Worth keeping here</span><div class="checklist mt16">' +
      ['CPCB EPR registration certificate', 'Every EPR certificate you buy, with the invoice', 'Sales exports for each quarter', 'Acknowledgements of filed returns', 'Any notices or letters from CPCB/SPCB'].map(function (x) { return '<div class="row"><span class="check mut">' + icon('dots') + '</span><div>' + x + '</div></div>'; }).join('') +
      '</div></div><div class="card small muted" style="line-height:1.55">Files are stored privately in this browser. Download a backup from Settings before clearing browser data.</div></div></div>';
  };

  /* ---------------- Settings ---------------- */
  VIEWS.settings = function () {
    var p = S.profile;
    return '<div class="head"><div><h1>Settings</h1><p class="lead">Your business details, target rates and data.</p></div></div>' +
      '<div class="cols"><div class="stack">' +
      '<form class="card" data-form="profile" novalidate style="padding:24px"><span class="lbl">Business</span><div style="display:grid;gap:16px;margin-top:18px">' +
      '<div class="grid2"><div class="field"><label for="p-name">Business name</label><input class="input" id="p-name" name="name" value="' + esc(p.name) + '" required></div>' +
      '<div class="field"><label for="p-gstin">GSTIN</label><input class="input mono-in" id="p-gstin" name="gstin" maxlength="15" value="' + esc(p.gstin) + '" style="text-transform:uppercase"></div></div>' +
      '<div class="grid2"><div class="field"><label for="p-reg">CPCB EPR registration no.</label><input class="input mono-in" id="p-reg" name="eprReg" value="' + esc(p.eprReg) + '"></div>' +
      '<div class="field"><label for="p-city">City</label><input class="input" id="p-city" name="city" value="' + esc(p.city) + '"></div></div>' +
      '<div class="grid2"><div class="field"><label for="p-contact">Your name</label><input class="input" id="p-contact" name="contactName" value="' + esc(p.contactName) + '"></div>' +
      '<div class="field"><label for="p-email">Email</label><input class="input" id="p-email" type="email" name="email" value="' + esc(p.email) + '"></div></div>' +
      '<fieldset class="field" style="border:0;padding:0;margin:0"><legend class="flabel" style="font-size:13px;color:var(--ink-2);margin-bottom:8px">Roles</legend><div class="chips">' +
      Object.keys(ROLES).map(function (k) { return '<label class="chip sm"><input type="checkbox" name="roles" value="' + k + '"' + (p.roles.indexOf(k) > -1 ? ' checked' : '') + '>' + ROLES[k] + '</label>'; }).join('') + '</div></fieldset>' +
      '<fieldset class="field" style="border:0;padding:0;margin:0"><legend class="flabel" style="font-size:13px;color:var(--ink-2);margin-bottom:8px">Battery categories</legend><div class="chips">' +
      Object.keys(CATS).map(function (k) { return '<label class="chip sm"><input type="checkbox" name="categories" value="' + k + '"' + (p.categories.indexOf(k) > -1 ? ' checked' : '') + '>' + CATS[k] + '</label>'; }).join('') + '</div></fieldset>' +
      '<p class="err" id="p-err" role="alert" style="color:var(--red);font-size:13px"></p><div><button class="btn p" type="submit">Save business details</button></div></div></form>' +
      '<form class="card" data-form="rates" novalidate style="padding:24px"><span class="lbl">EPR target rates</span>' +
      '<p class="small muted mt8" style="line-height:1.55">The share of what you placed on the market that you must cover with recycling certificates, per category. Enter the rates from Schedule II of the Battery Waste Management Rules, 2022 (as amended) that apply to ' + fyLabel(S.fy) + '. The defaults are placeholders.</p>' +
      '<div class="grid2 mt16">' + Object.keys(CATS).map(function (k) { return '<div class="field"><label for="r-' + k + '">' + CATS[k] + ' (%)</label><input class="input" id="r-' + k + '" name="' + k + '" inputmode="decimal" value="' + esc(S.rates[k]) + '"></div>'; }).join('') + '</div>' +
      '<label class="cbox mt16"><input type="checkbox" name="confirmed"' + (S.ratesConfirmed ? ' checked' : '') + '> I’ve checked these against the current rules</label>' +
      (S.locks[S.fy] ? '<p class="small mt12" style="color:var(--amber)">Your ' + fyLabel(S.fy) + ' obligation is locked. Changing rates won’t change it until you update the lock.</p>' : '') +
      '<div class="mt16"><button class="btn p" type="submit">Save rates</button></div></form>' +
      '<form class="card" data-form="price" novalidate style="padding:24px"><span class="lbl">Expected certificate price</span>' +
      '<p class="small muted mt8">We’ll flag offers outside this range when you check a certificate.</p><div class="grid2 mt16">' +
      '<div class="field"><label for="pr-min">Minimum (₹/kg)</label><input class="input" id="pr-min" name="min" inputmode="decimal" value="' + esc(S.priceRange.min) + '"></div>' +
      '<div class="field"><label for="pr-max">Maximum (₹/kg)</label><input class="input" id="pr-max" name="max" inputmode="decimal" value="' + esc(S.priceRange.max) + '"></div></div>' +
      '<div class="mt16"><button class="btn p" type="submit">Save range</button></div></form></div>' +
      '<div class="stack"><div class="card" style="padding:24px"><span class="lbl">Your data</span><p class="small muted mt8" style="line-height:1.55">Everything is stored in this browser only. Back it up regularly, especially before clearing browser data or switching computers.</p>' +
      '<div style="display:grid;gap:10px;margin-top:18px"><button class="btn g" data-act="backup">' + icon('dl') + 'Download backup</button>' +
      '<label class="btn g" style="cursor:pointer">' + icon('up') + 'Restore from backup<input type="file" accept=".json,application/json" data-change="restore" class="sr"></label>' +
      '<button class="btn danger" data-act="reset">Delete all data</button></div></div>' +
      '<div class="card small muted" style="line-height:1.55">Ampliance is in early access. Accounts, team access, WhatsApp/email reminders and live CPCB lookups arrive with the server.</div></div></div>';
  };

  /* ======================================================================
     Actions
     ====================================================================== */
  function formObj(f) {
    var o = {};
    new FormData(f).forEach(function (v, k) { if (o[k] !== undefined) { o[k] = [].concat(o[k], v); } else o[k] = v; });
    return o;
  }
  function arr(v) { return v == null ? [] : [].concat(v); }
  function showErr(id, msg, field) {
    var e = $('#' + id); if (e) e.textContent = msg;
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
  }

  var FORMS = {
    ob1: function (f) {
      var d = formObj(f), g = String(d.gstin || '').trim().toUpperCase();
      $$('[aria-invalid]', f).forEach(function (x) { x.removeAttribute('aria-invalid'); });
      if (!String(d.name || '').trim()) return showErr('ob-err', 'Enter your business name.', f.name);
      if (!GSTIN_RE.test(g)) return showErr('ob-err', 'Enter a valid 15-character GSTIN, like 27ABCDE1234F1Z5.', f.gstin);
      if (d.email && !EMAIL_RE.test(d.email)) return showErr('ob-err', 'That email doesn’t look right.', f.email);
      Object.assign(S.profile, { name: d.name.trim(), gstin: g, contactName: (d.contactName || '').trim(), city: (d.city || '').trim(), email: (d.email || '').trim(), phone: (d.phone || '').trim() });
      obStep = 2; commit();
    },
    ob2: function (f) {
      var d = formObj(f);
      var roles = arr(d.roles), cats = arr(d.categories);
      if (!roles.length) return showErr('ob-err', 'Pick at least one role.');
      if (!cats.length) return showErr('ob-err', 'Pick at least one battery category.');
      Object.assign(S.profile, { roles: roles, categories: cats, regStatus: d.regStatus || 'yes', eprReg: (d.eprReg || '').trim() });
      obStep = 3; commit();
    },
    sale: function (f) {
      var d = formObj(f), kg = num(d.weightKg);
      if (!d.category) return showErr('m-err', 'Choose a category.', f.category);
      if (!(kg > 0)) return showErr('m-err', 'Enter the total weight in kg.', f.weightKg);
      var row = { category: d.category, quarter: d.quarter || '', chemistry: (d.chemistry || '').trim(), units: num(d.units), weightKg: kg, ref: (d.ref || '').trim() };
      if (d.id) { Object.assign(S.sales.filter(function (r) { return r.id === d.id; })[0] || {}, row); }
      else S.sales.push(Object.assign({ id: uid(), fy: S.fy, source: 'manual' }, row));
      closeModal(); commit(d.id ? 'Row updated' : 'Row added');
    },
    verify: function (f) {
      var d = formObj(f);
      var input = { certId: String(d.certId || '').trim(), recycler: (d.recycler || '').trim(), recyclerReg: (d.recyclerReg || '').trim(), category: d.category, kg: num(d.kg), price: num(d.price), date: d.date || '' };
      if (!input.certId) return showErr('v-err', 'Enter the certificate ID.', f.certId);
      var result = runChecks(input);
      lastCheck = { input: input, result: result };
      S.checks.unshift({ certId: input.certId, verdict: result.verdict, summary: (input.recycler || 'Unknown recycler') + (input.kg ? ' · ' + fmt(input.kg) + ' kg' : ''), at: new Date().toISOString() });
      S.checks = S.checks.slice(0, 20);
      commit();
      var r = $('#check-result'); if (r) { r.focus({ preventScroll: true }); r.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    },
    'add-cert': function (f) {
      if (!lastCheck) return;
      var i = lastCheck.input, confirmed = !!f.portal.checked;
      S.certificates.push({ id: uid(), certId: i.certId, recycler: i.recycler, recyclerReg: i.recyclerReg, category: i.category, kg: i.kg, price: i.price, date: i.date, fy: S.fy, status: confirmed ? 'verified' : 'pending', addedAt: new Date().toISOString() });
      lastCheck = null;
      commit(confirmed ? 'Certificate added and counted' : 'Certificate added. Confirm it on the portal to count it.');
    },
    deadline: function (f) {
      var d = formObj(f);
      if (!String(d.title || '').trim()) return showErr('m-err', 'Give it a name.', f.title);
      if (!d.date) return showErr('m-err', 'Pick a date.', f.date);
      S.customDeadlines.push({ id: 'c-' + uid(), title: d.title.trim(), date: d.date, note: (d.note || '').trim() });
      closeModal(); commit('Deadline added');
    },
    profile: function (f) {
      var d = formObj(f), g = String(d.gstin || '').trim().toUpperCase();
      $$('[aria-invalid]', f).forEach(function (x) { x.removeAttribute('aria-invalid'); });
      if (!String(d.name || '').trim()) return showErr('p-err', 'Enter your business name.', f.name);
      if (g && !GSTIN_RE.test(g)) return showErr('p-err', 'Enter a valid 15-character GSTIN.', f.gstin);
      if (d.email && !EMAIL_RE.test(d.email)) return showErr('p-err', 'That email doesn’t look right.', f.email);
      if (!arr(d.categories).length) return showErr('p-err', 'Keep at least one battery category.');
      Object.assign(S.profile, { name: d.name.trim(), gstin: g, eprReg: (d.eprReg || '').trim(), city: (d.city || '').trim(), contactName: (d.contactName || '').trim(), email: (d.email || '').trim(), roles: arr(d.roles), categories: arr(d.categories) });
      commit('Business details saved');
    },
    rates: function (f) {
      var d = formObj(f), bad = Object.keys(CATS).filter(function (k) { var n = num(d[k]); return !(n >= 0 && n <= 100) || String(d[k]).trim() === ''; });
      if (bad.length) { toast('Rates must be between 0 and 100.', 'bad'); f[bad[0]].focus(); return; }
      Object.keys(CATS).forEach(function (k) { S.rates[k] = num(d[k]); });
      S.ratesConfirmed = !!d.confirmed;
      commit('Rates saved');
    },
    price: function (f) {
      var d = formObj(f), min = num(d.min), max = num(d.max);
      if (min && max && min > max) { toast('Minimum is higher than maximum.', 'bad'); return; }
      S.priceRange = { min: d.min ? min : '', max: d.max ? max : '' };
      commit('Price range saved');
    }
  };

  var ACTS = {
    'confirm-yes': function () { var r = confirmResolve; confirmResolve = null; closeModal(); if (r) r(true); },
    'confirm-no': function () { var r = confirmResolve; confirmResolve = null; closeModal(); if (r) r(false); },
    'modal-close': closeModal,
    'ob-back': function () { obStep = Math.max(1, obStep - 1); render(); },
    'ob-finish': function () { S.onboarded = true; save(); location.hash = '#/dashboard'; render(); toast('You’re set up. Welcome to Ampliance.'); },
    sample: function () { loadSample(); location.hash = '#/dashboard'; commit('Sample data loaded'); },
    template: function () {
      download('ampliance-sales-template.csv',
        'date,category,chemistry,units,weight_kg,reference\n15/04/' + fyStart(S.fy) + ',Portable,Li-ion,1200,240,Power banks\n20/05/' + fyStart(S.fy) + ',Automotive,Lead-acid,30,420,12V SLI\n02/06/' + fyStart(S.fy) + ',Portable,Ni-MH,500,100,AA packs\n', 'text/csv');
    },
    'sale-new': function () { saleModal(); },
    'sale-edit': function (el) { saleModal(S.sales.filter(function (r) { return r.id === el.dataset.id; })[0]); },
    'sale-del': function (el) { S.sales = S.sales.filter(function (r) { return r.id !== el.dataset.id; }); commit('Row deleted'); },
    'sales-clear': function () {
      var n = S.sales.filter(function (r) { return r.fy === S.fy; }).length;
      ask('Delete all ' + fyLabel(S.fy) + ' sales?', 'This removes ' + plural(n, 'row') + '. Your certificates are kept.', 'Delete rows', true).then(function (ok) {
        if (ok) { S.sales = S.sales.filter(function (r) { return r.fy !== S.fy; }); commit('Sales rows deleted'); }
      });
    },
    import: function (el) {
      if (!pendingImport) return;
      var rows = pendingImport, fys = {};
      rows.forEach(function (r) { fys[r.fy] = (fys[r.fy] || 0) + 1; });
      if (el.dataset.mode === 'replace') S.sales = S.sales.filter(function (r) { return !fys[r.fy]; });
      S.sales = S.sales.concat(rows);
      var top = Object.keys(fys).sort(function (a, b) { return fys[b] - fys[a]; })[0];
      if (top) S.fy = top;
      pendingImport = null; closeModal();
      commit(plural(rows.length, 'row') + ' imported into ' + fyLabel(S.fy));
    },
    lock: function () {
      var o = obligation();
      ask('Lock your ' + fyLabel(S.fy) + ' obligation?', 'We’ll fix your target at <b>' + fmt(o.t.computed) + ' kg</b>. If your sales change later, we’ll tell you so you can update it.', 'Lock obligation').then(function (ok) {
        if (!ok) return;
        var targets = {}; Object.keys(o.cats).forEach(function (k) { targets[k] = o.cats[k].computed; });
        S.locks[S.fy] = { at: new Date().toISOString(), targets: targets };
        commit('Obligation locked');
      });
    },
    relock: function () { ACTS.lock(); },
    unlock: function () {
      ask('Unlock the obligation?', 'Your target will follow your sales data again until you lock it.', 'Unlock').then(function (ok) { if (ok) { delete S.locks[S.fy]; commit('Obligation unlocked'); } });
    },
    'cert-confirm': function (el) {
      var c = S.certificates.filter(function (x) { return x.id === el.dataset.id; })[0];
      if (!c) return;
      ask('Confirmed on the CPCB portal?', 'Only confirm if <span class="mono">' + esc(c.certId) + '</span> shows on the CPCB EPR portal as transferred to, or available for, ' + esc(S.profile.name || 'your business') + '.', 'Yes, it’s confirmed').then(function (ok) {
        if (ok) { c.status = 'verified'; c.confirmedAt = new Date().toISOString(); commit('Certificate confirmed and counted'); }
      });
    },
    'cert-del': function (el) {
      var c = S.certificates.filter(function (x) { return x.id === el.dataset.id; })[0];
      if (!c) return;
      ask('Remove this certificate?', '<span class="mono">' + esc(c.certId) + '</span> will no longer count towards your target.', 'Remove', true).then(function (ok) {
        if (ok) { S.certificates = S.certificates.filter(function (x) { return x !== c; }); commit('Certificate removed'); }
      });
    },
    'cert-export': function () {
      var rows = [['certificate_id', 'recycler', 'recycler_reg', 'category', 'kg', 'price_per_kg', 'generated', 'status']];
      S.certificates.filter(function (c) { return c.fy === S.fy; }).forEach(function (c) { rows.push([c.certId, c.recycler, c.recyclerReg, CATS[c.category], c.kg, c.price || '', c.date, c.status === 'verified' ? 'confirmed' : 'unconfirmed']); });
      download('ampliance-certificates-' + S.fy + '.csv', rows.map(function (r) { return r.map(function (x) { x = String(x == null ? '' : x); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; }).join(','); }).join('\n'), 'text/csv');
    },
    'dl-new': function () {
      openModal('<h2>Add a deadline</h2><p class="muted small">For your own checkpoints, like an SPCB inspection or an internal review.</p><form data-form="deadline" novalidate>' +
        '<div class="field"><label for="d-title">What’s due</label><input class="input" id="d-title" name="title" required></div>' +
        '<div class="field"><label for="d-date">Date</label><input class="input" id="d-date" type="date" name="date" required></div>' +
        '<div class="field"><label for="d-note">Note <span class="muted">(optional)</span></label><input class="input" id="d-note" name="note"></div>' +
        '<p class="err" id="m-err" role="alert" style="color:var(--red);font-size:13px"></p>' +
        '<div class="modal-actions"><button type="button" class="btn g" data-act="modal-close">Cancel</button><button class="btn p" type="submit">Add deadline</button></div></form>', 'Add deadline');
    },
    'dl-toggle': function (el) {
      var id = el.dataset.id, i = S.doneDeadlines.indexOf(id);
      if (i > -1) S.doneDeadlines.splice(i, 1); else S.doneDeadlines.push(id);
      commit(i > -1 ? 'Marked as not done' : 'Marked as done');
    },
    'dl-del': function (el) { S.customDeadlines = S.customDeadlines.filter(function (d) { return d.id !== el.dataset.id; }); commit('Deadline deleted'); },
    ics: function () { exportICS(); },
    print: function () { printReturn(); },
    file: function () {
      ask('Mark ' + fyLabel(S.fy) + ' return as filed?', 'Do this once you’ve submitted the return on the CPCB EPR portal. Keep the acknowledgement in Documents.', 'Mark as filed').then(function (ok) {
        if (ok) { S.filed[S.fy] = new Date().toISOString(); commit('Return marked as filed'); }
      });
    },
    unfile: function () { delete S.filed[S.fy]; commit('Filed status removed'); },
    'doc-dl': function (el) {
      DB.get(el.dataset.id).then(function (d) { if (d) download(d.name, d.blob); }).catch(function () { toast('Couldn’t open that file.', 'bad'); });
    },
    'doc-del': function (el) {
      var d = (docs || []).filter(function (x) { return x.id === el.dataset.id; })[0];
      if (!d) return;
      ask('Delete this document?', esc(d.name) + ' will be removed from this browser. This can’t be undone.', 'Delete', true).then(function (ok) {
        if (ok) DB.del(d.id).then(refreshDocs).then(function () { render(); toast('Document deleted'); });
      });
    },
    backup: function () {
      DB.all().catch(function () { return []; }).then(function (files) {
        return Promise.all(files.map(function (f) {
          return new Promise(function (res) { var r = new FileReader(); r.onload = function () { res({ id: f.id, name: f.name, type: f.type, size: f.size, tag: f.tag, addedAt: f.addedAt, data: r.result }); }; r.onerror = function () { res(null); }; r.readAsDataURL(f.blob); });
        }));
      }).then(function (files) {
        download('ampliance-backup-' + iso(new Date()) + '.json', JSON.stringify({ app: 'ampliance', exportedAt: new Date().toISOString(), state: S, files: files.filter(Boolean) }), 'application/json');
      });
    },
    reset: function () {
      ask('Delete all data?', 'This removes your business details, sales, certificates and documents from this browser. Download a backup first if you might need them.', 'Delete everything', true).then(function (ok) {
        if (!ok) return;
        try { localStorage.removeItem(KEY); } catch (e) {}
        DB.clear().catch(function () {}).then(function () {
          S = blank(); obStep = 1; lastCheck = null; docs = null;
          location.hash = '#/onboarding'; render(); toast('All data deleted');
        });
      });
    }
  };

  var CHANGES = {
    fy: function (el) { S.fy = el.value; lastCheck = null; commit(); },
    'sales-file': function (el) { if (el.files[0]) handleSalesFile(el.files[0]); el.value = ''; },
    'doc-file': function (el) { if (el.files.length) handleDocs(el.files); el.value = ''; },
    offset: function (el) {
      var n = +el.value, i = S.reminders.offsets.indexOf(n);
      if (el.checked && i < 0) S.reminders.offsets.push(n);
      if (!el.checked && i > -1) S.reminders.offsets.splice(i, 1);
      S.reminders.offsets.sort(function (a, b) { return b - a; });
      save();
    },
    notif: function (el) {
      if (!el.checked) { S.reminders.browser = false; save(); return; }
      Notification.requestPermission().then(function (p) {
        S.reminders.browser = p === 'granted';
        commit(p === 'granted' ? 'Notifications on' : 'Notifications were not allowed', p === 'granted' ? 'ok' : 'bad');
        runNotifications();
      });
    },
    restore: function (el) {
      var f = el.files[0]; el.value = '';
      if (!f) return;
      f.text().then(function (txt) {
        var d = JSON.parse(txt);
        if (!d || d.app !== 'ampliance' || !d.state) throw new Error('bad');
        return ask('Restore this backup?', 'It replaces everything currently in Ampliance with the backup from ' + fmtDate(d.exportedAt) + '.', 'Restore', true).then(function (ok) {
          if (!ok) return;
          var s = blank(); Object.assign(s, d.state);
          s.profile = Object.assign(blank().profile, d.state.profile);
          s.rates = Object.assign({}, DEFAULT_RATES, d.state.rates);
          s.reminders = Object.assign(blank().reminders, d.state.reminders);
          S = s; save();
          return DB.clear().catch(function () {}).then(function () {
            return Promise.all((d.files || []).map(function (x) {
              return fetch(x.data).then(function (r) { return r.blob(); }).then(function (blob) { return DB.put({ id: x.id, name: x.name, type: x.type, size: x.size, tag: x.tag, addedAt: x.addedAt, blob: blob }); });
            }));
          }).then(refreshDocs).then(function () { location.hash = '#/dashboard'; render(); toast('Backup restored'); });
        });
      }).catch(function () { toast('That isn’t an Ampliance backup file.', 'bad'); });
    }
  };

  function handleSalesFile(file) {
    toast('Reading ' + file.name + '…');
    readSalesFile(file).then(function (rows) {
      if (!rows.length) throw new Error('No rows found in that file.');
      importModal(rows);
    }).catch(function (e) { toast(e.message || 'Couldn’t read that file.', 'bad'); });
  }
  function handleDocs(files) {
    var tagEl = $('#doc-tag'), tag = tagEl ? tagEl.value : 'Other';
    var list = Array.prototype.slice.call(files), skipped = 0;
    Promise.all(list.map(function (f) {
      if (f.size > 20 * 1024 * 1024) { skipped++; return null; }
      return DB.put({ id: uid(), name: f.name, type: f.type, size: f.size, tag: tag, addedAt: new Date().toISOString(), blob: f });
    })).then(refreshDocs).then(function () {
      render();
      toast(plural(list.length - skipped, 'document') + ' added' + (skipped ? ' · ' + skipped + ' over 20 MB skipped' : ''));
    }).catch(function (e) { toast(e.message || 'Couldn’t save that file.', 'bad'); });
  }

  function exportICS() {
    var open = allDeadlines().filter(function (d) { return !d.done && d.days >= 0; });
    if (!open.length) { toast('No upcoming deadlines to export.', 'bad'); return; }
    function e(s) { return String(s || '').replace(/[\\;,]/g, function (m) { return '\\' + m; }).replace(/\n/g, '\\n'); }
    function ymd(d) { return iso(d).replace(/-/g, ''); }
    var stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    var out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ampliance//EPR deadlines//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Ampliance EPR deadlines'];
    open.forEach(function (d) {
      var start = parseISO(d.date), end = new Date(start); end.setDate(end.getDate() + 1);
      out.push('BEGIN:VEVENT', 'UID:' + d.id + '@ampliance', 'DTSTAMP:' + stamp, 'DTSTART;VALUE=DATE:' + ymd(start), 'DTEND;VALUE=DATE:' + ymd(end), 'SUMMARY:' + e(d.title), 'DESCRIPTION:' + e(d.note));
      S.reminders.offsets.forEach(function (o) { out.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + e(d.title), 'TRIGGER:' + (o ? '-P' + o + 'D' : 'PT9H'), 'END:VALARM'); });
      out.push('END:VEVENT');
    });
    out.push('END:VCALENDAR');
    download('ampliance-deadlines-' + S.fy + '.ics', out.join('\r\n'), 'text/calendar');
  }

  function runNotifications() {
    try {
      if (!S.onboarded || !S.reminders.browser || !('Notification' in window) || Notification.permission !== 'granted') return;
      var logKey = KEY + ':notified', log = JSON.parse(localStorage.getItem(logKey) || '{}'), day = iso(new Date());
      allDeadlines().forEach(function (d) {
        if (d.done) return;
        var hit = S.reminders.offsets.indexOf(d.days) > -1 || d.days < 0;
        if (hit && !log[d.id + '@' + day]) {
          new Notification('Ampliance: ' + d.title, { body: d.days < 0 ? 'Overdue by ' + plural(-d.days, 'day') : d.days === 0 ? 'Due today' : 'Due in ' + plural(d.days, 'day') });
          log[d.id + '@' + day] = 1;
        }
      });
      localStorage.setItem(logKey, JSON.stringify(log));
    } catch (e) { /* notifications are best-effort */ }
  }

  function loadSample() {
    var fy = fyOf(new Date()), y = fyStart(fy);
    S = blank();
    S.onboarded = true; S.sample = true; S.fy = fy;
    S.profile = { name: 'Sharma Power Cells', gstin: '27ABCDE1234F1Z5', city: 'Pune', contactName: 'Rohan Sharma', email: 'rohan@example.com', phone: '', roles: ['assembler', 'importer'], categories: ['portable', 'automotive'], regStatus: 'yes', eprReg: 'SAMPLE-EPR-0001' };
    function s(q, cat, chem, units, kg, ref) { S.sales.push({ id: uid(), fy: fy, quarter: q, category: cat, chemistry: chem, units: units, weightKg: kg, ref: ref, source: 'sample' }); }
    s('Q1', 'portable', 'Li-ion', 9100, 1820, 'Power banks'); s('Q1', 'portable', 'Ni-MH', 1050, 210, 'AA packs'); s('Q1', 'automotive', 'Lead-acid', 78, 1092, '12V SLI');
    s('Q2', 'portable', 'Li-ion', 9300, 1860, 'Power banks'); s('Q2', 'portable', 'Ni-MH', 1100, 220, 'AA packs'); s('Q2', 'automotive', 'Lead-acid', 82, 1148, '12V SLI'); s('Q2', 'automotive', 'Li-ion', 48, 536, 'Two-wheeler starter');
    s('Q2', '', '', 3, 0, 'Unlabelled rows');
    function c(id, rec, reg, cat, kg, m, d, st) { S.certificates.push({ id: uid(), certId: id, recycler: rec, recyclerReg: reg, category: cat, kg: kg, price: '', date: iso(new Date(y, m, d)), fy: fy, status: st, addedAt: new Date(y, m, d + 2).toISOString() }); }
    c('SAMPLE-0029114', 'EcoCell Recyclers', 'SAMPLE-RC-014', 'portable', 800, 5, 12, 'verified');
    c('SAMPLE-0031552', 'GreenLoop Recyclers', 'SAMPLE-RC-027', 'portable', 1190, 6, 3, 'verified');
    c('SAMPLE-0040871', 'Shakti Lead Works', 'SAMPLE-RC-033', 'automotive', 1000, 7, 18, 'verified');
    c('SAMPLE-0048213', 'GreenLoop Recyclers', 'SAMPLE-RC-027', 'automotive', 1200, 8, 2, 'pending');
    S.checks = [{ certId: 'SAMPLE-0048213', verdict: 'warn', summary: 'GreenLoop Recyclers · 1,200 kg', at: new Date().toISOString() }, { certId: 'SAMPLE-0031907', verdict: 'fail', summary: 'Already in your certificates', at: new Date().toISOString() }];
    obStep = 1;
  }

  /* ======================================================================
     Wiring
     ====================================================================== */
  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-act]');
    if (!a || a.disabled) return;
    var fn = ACTS[a.dataset.act];
    if (fn) { e.preventDefault(); fn(a, e); }
  });
  document.addEventListener('submit', function (e) {
    var f = e.target.closest('form[data-form]');
    if (!f) return;
    e.preventDefault();
    var fn = FORMS[f.dataset.form];
    if (fn) fn(f);
  });
  document.addEventListener('change', function (e) {
    var el = e.target.closest('[data-change]');
    if (el && CHANGES[el.dataset.change]) CHANGES[el.dataset.change](el, e);
  });
  // Drag & drop onto upload zones
  ['dragenter', 'dragover'].forEach(function (t) {
    document.addEventListener(t, function (e) {
      var z = e.target.closest && e.target.closest('[data-drop]');
      if (!z) return;
      e.preventDefault(); z.classList.add('over');
    });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    document.addEventListener(t, function (e) {
      var z = e.target.closest && e.target.closest('[data-drop]');
      if (!z) return;
      e.preventDefault(); z.classList.remove('over');
      if (t !== 'drop' || !e.dataTransfer.files.length) return;
      if (z.dataset.drop === 'docs') handleDocs(e.dataTransfer.files);
      else handleSalesFile(e.dataTransfer.files[0]);
    });
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });
  window.addEventListener('hashchange', function () { lastCheck = null; render(); window.scrollTo(0, 0); });

  render();
  runNotifications();
})();
