/* Offline Finance App (no CDNs, no backend)
   Stores data locally in the browser.
*/

// Legacy localStorage key (used only for migration)
const LEGACY_STORAGE_KEY = 'ms_finanzas_offline_v1';
const LEGACY_BILLAR_KEYS = {
  products: 'productos',
  sales: 'ventas',
  tables: 'mesasActivas',
};

// IndexedDB configuration (primary persistence)
const IDB_DB_NAME = 'ms_finanzas_offline';
const IDB_DB_VERSION = 1;
const IDB_STORE = 'kv';
const IDB_STATE_KEY = 'state';
const IDB_META_KEY = 'meta';
const IDB_SYNC_KEY = 'syncConfig';
const IDB_SNAPSHOT_INDEX_KEY = 'snapshotIndex';
const IDB_SNAPSHOT_PREFIX = 'snapshot:';
const MAX_SNAPSHOTS = 20;

/** @typedef {{id:number,name:string,category:string,cost:number,price:number,stock:number,stockMin:number}} Product */
/** @typedef {{id:number,at:string,productId:number,qty:number,unitPrice:number,unitCost:number,total:number,profit:number,notes?:string}} Sale */
/** @typedef {{id:number,at:string,type:string,amount:number,description?:string}} Expense */
/** @typedef {{id:number,table:number,players:number,rate:number,startAt:string,endAt?:string,active:boolean,total?:number}} TableSession */

function nowISO() {
  return new Date().toISOString();
}

function parseMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatMoney(n) {
  const x = Number(n) || 0;
  return x.toLocaleString('es-GT', { style: 'currency', currency: 'GTQ' });
}

function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('es-GT', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function clampInt(n, min, max) {
  const x = Math.floor(Number(n));
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function uuid() {
  return Date.now() + Math.floor(Math.random() * 1000);
}

function randomId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch {
    // ignore
  }
  return String(Date.now()) + '-' + Math.random().toString(16).slice(2);
}

function toast(title, msg) {
  const el = document.getElementById('toast');
  const t = document.getElementById('toastTitle');
  const m = document.getElementById('toastMsg');
  t.textContent = title;
  m.textContent = msg;
  el.classList.add('show');
  window.clearTimeout(toast._t);
  toast._t = window.setTimeout(() => el.classList.remove('show'), 3200);
}

toast._t = 0;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, IDB_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @type {Promise<IDBDatabase> | null} */
let _dbPromise = null;

function db() {
  if (!_dbPromise) _dbPromise = openDB();
  return _dbPromise;
}

async function idbGet(key) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve(undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbClearAll() {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const req = store.clear();
    req.onsuccess = () => resolve(undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(key) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const req = store.delete(key);
    req.onsuccess = () => resolve(undefined);
    req.onerror = () => reject(req.error);
  });
}

function isStateEmpty(state) {
  return !state.products?.length && !state.sales?.length && !state.expenses?.length && !state.tables?.length;
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

async function getMeta() {
  const meta = await idbGet(IDB_META_KEY);
  return (meta && typeof meta === 'object') ? meta : {};
}

async function setMeta(meta) {
  await idbSet(IDB_META_KEY, meta);
}

async function ensureDeviceId() {
  const meta = await getMeta();
  if (!meta.deviceId) {
    meta.deviceId = randomId();
    await setMeta(meta);
  }
  return meta.deviceId;
}

async function getSyncConfig() {
  const cfg = await idbGet(IDB_SYNC_KEY);
  const base = { url: '', user: '', pass: '', auto: false };
  if (!cfg || typeof cfg !== 'object') return base;
  return {
    url: typeof cfg.url === 'string' ? cfg.url : '',
    user: typeof cfg.user === 'string' ? cfg.user : '',
    pass: typeof cfg.pass === 'string' ? cfg.pass : '',
    auto: Boolean(cfg.auto),
  };
}

async function setSyncConfig(cfg) {
  await idbSet(IDB_SYNC_KEY, cfg);
}

function base64FromBytes(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function basicAuthHeader(user, pass) {
  const u = String(user || '');
  const p = String(pass || '');
  if (!u && !p) return null;
  const bytes = new TextEncoder().encode(`${u}:${p}`);
  return `Basic ${base64FromBytes(bytes)}`;
}

async function webdavRequest({ url, method, user, pass, body }) {
  const headers = {};
  const auth = basicAuthHeader(user, pass);
  if (auth) headers.Authorization = auth;
  if (body != null) headers['Content-Type'] = 'application/json; charset=utf-8';

  const res = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });

  return res;
}

async function fetchRemoteSnapshot(cfg) {
  const res = await webdavRequest({ url: cfg.url, method: 'GET', user: cfg.user, pass: cfg.pass });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const txt = await res.text();
  const parsed = safeJsonParse(txt);
  if (!parsed || typeof parsed !== 'object') throw new Error('Respuesta inválida');
  return parsed;
}

async function pushRemoteSnapshot(cfg, payload) {
  const res = await webdavRequest({ url: cfg.url, method: 'PUT', user: cfg.user, pass: cfg.pass, body: payload });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function isValidStateShape(s) {
  return !!s && typeof s === 'object' && Array.isArray(s.products) && Array.isArray(s.sales) && Array.isArray(s.expenses) && Array.isArray(s.tables);
}

function parseComparableIso(iso) {
  const d = new Date(String(iso || ''));
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoNewerThan(a, b) {
  const da = parseComparableIso(a);
  const db = parseComparableIso(b);
  if (!da && !db) return false;
  if (da && !db) return true;
  if (!da && db) return false;
  return da.getTime() > db.getTime();
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./sw.js');
  } catch {
    // ignore (common when running from file://)
  }
}

function setupInstallButton() {
  const btn = document.getElementById('btnInstall');
  if (!btn) return;

  /** @type {any} */
  let deferred = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    btn.hidden = true;
  });

  btn.addEventListener('click', async () => {
    if (!deferred) {
      toast('Instalar', 'Si no aparece el instalador, abre el menú del navegador y elige “Instalar app”.');
      return;
    }
    deferred.prompt();
    try { await deferred.userChoice; } catch { /* ignore */ }
    deferred = null;
    btn.hidden = true;
  });
}

async function listSnapshots() {
  const idx = await idbGet(IDB_SNAPSHOT_INDEX_KEY);
  return Array.isArray(idx) ? idx : [];
}

async function createSnapshot(state, reason) {
  const at = nowISO();
  const id = at;
  const snapshot = {
    id,
    at,
    reason: String(reason || 'manual'),
    state: deepClone(state),
  };

  await idbSet(IDB_SNAPSHOT_PREFIX + id, snapshot);

  const idx = await listSnapshots();
  idx.unshift({ id, at, reason: snapshot.reason });

  // Trim old snapshots
  while (idx.length > MAX_SNAPSHOTS) {
    const removed = idx.pop();
    if (removed?.id) {
      try { await idbDelete(IDB_SNAPSHOT_PREFIX + removed.id); } catch { /* ignore */ }
    }
  }

  await idbSet(IDB_SNAPSHOT_INDEX_KEY, idx);
  return snapshot;
}

async function ensureDailySnapshot(state) {
  if (isStateEmpty(state)) return;
  const meta = await getMeta();
  const today = new Date().toISOString().slice(0, 10);
  if (meta.lastSnapshotDay === today) return;

  await createSnapshot(state, 'auto-diario');
  meta.lastSnapshotDay = today;
  await setMeta(meta);
}

function normalizeName(s) {
  return String(s || '').trim().toLowerCase();
}

function parseLegacyDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function migrateFromLegacyBillarLocalStorageIntoState(state) {
  // Only migrate into an empty state
  if (!isStateEmpty(state)) return { state, migrated: false };

  let rawProducts = null;
  let rawSales = null;
  let rawTables = null;

  try {
    rawProducts = localStorage.getItem(LEGACY_BILLAR_KEYS.products);
    rawSales = localStorage.getItem(LEGACY_BILLAR_KEYS.sales);
    rawTables = localStorage.getItem(LEGACY_BILLAR_KEYS.tables);
  } catch {
    return { state, migrated: false };
  }

  const legacyProducts = rawProducts ? safeJsonParse(rawProducts) : null;
  const legacySales = rawSales ? safeJsonParse(rawSales) : null;
  const legacyTables = rawTables ? safeJsonParse(rawTables) : null;

  const hasAnything =
    (Array.isArray(legacyProducts) && legacyProducts.length) ||
    (Array.isArray(legacySales) && legacySales.length) ||
    (Array.isArray(legacyTables) && legacyTables.length);

  if (!hasAnything) return { state, migrated: false };

  const next = emptyState();
  next.business = state.business || next.business;

  // Products
  const byName = new Map();
  if (Array.isArray(legacyProducts)) {
    for (const lp of legacyProducts) {
      const name = String(lp?.nombre || lp?.name || '').trim();
      if (!name) continue;
      const product = {
        id: uuid(),
        name,
        category: String(lp?.categoria || 'otro'),
        cost: parseMoney(lp?.costo),
        price: parseMoney(lp?.precio),
        stock: clampInt(lp?.stock, 0, 1_000_000),
        stockMin: clampInt(lp?.stockMinimo, 0, 1_000_000),
      };
      next.products.push(product);
      byName.set(normalizeName(product.name), product);
    }
  }

  // Sales
  if (Array.isArray(legacySales)) {
    for (const ls of legacySales) {
      const qty = clampInt(ls?.cantidad ?? ls?.qty, 1, 1_000_000);
      const unitPrice = parseMoney(ls?.precio ?? ls?.unitPrice);
      const total = parseMoney(ls?.total ?? (unitPrice * qty));
      const profit = parseMoney(ls?.ganancia ?? ls?.profit);
      const name = String(ls?.producto || ls?.product || '').trim();
      const atDate = parseLegacyDate(ls?.hora || ls?.at) || new Date();

      let product = byName.get(normalizeName(name));
      if (!product) {
        // Create a placeholder product so the sale has a productId
        const unitProfit = qty ? (profit / qty) : 0;
        const unitCost = Math.max(0, unitPrice - unitProfit);
        product = {
          id: uuid(),
          name: name || 'Producto (migrado)',
          category: 'otro',
          cost: Number(unitCost.toFixed(2)),
          price: Number(unitPrice.toFixed(2)),
          stock: 0,
          stockMin: 0,
        };
        next.products.push(product);
        byName.set(normalizeName(product.name), product);
      }

      next.sales.push({
        id: uuid(),
        at: atDate.toISOString(),
        productId: product.id,
        qty,
        unitPrice: Number(unitPrice.toFixed(2)),
        unitCost: Number(product.cost.toFixed(2)),
        total: Number(total.toFixed(2)),
        profit: Number(profit.toFixed(2)),
        notes: 'Migrado',
      });
    }
  }

  // Tables (only active ones; legacy finished tables don't carry end timestamp)
  if (Array.isArray(legacyTables)) {
    for (const lt of legacyTables) {
      const active = lt?.activa !== false;
      if (!active) continue;
      const startDate = parseLegacyDate(lt?.inicio) || new Date();
      next.tables.push({
        id: uuid(),
        table: clampInt(lt?.mesa, 1, 1_000_000),
        players: clampInt(lt?.jugadores, 1, 100),
        rate: parseMoney(lt?.tarifa),
        startAt: startDate.toISOString(),
        active: true,
      });
    }
  }

  return { state: next, migrated: true };
}

async function renderSnapshotsUI() {
  const info = document.getElementById('snapshotInfo');
  const listEl = document.getElementById('snapshotList');
  if (!info || !listEl) return;

  const meta = await getMeta();
  const idx = await listSnapshots();

  const last = idx[0]?.at ? formatDateTime(idx[0].at) : '—';
  const daily = meta.lastSnapshotDay ? meta.lastSnapshotDay : '—';
  info.textContent = `Último respaldo: ${last} | Respaldos: ${idx.length} | Auto diario: ${daily}`;

  listEl.innerHTML = '';
  if (!idx.length) {
    const li = document.createElement('li');
    li.className = 'snapshot-item snapshot-empty';
    li.textContent = 'No hay respaldos todavía.';
    listEl.appendChild(li);
    return;
  }

  for (const it of idx) {
    const li = document.createElement('li');
    li.className = 'snapshot-item';

    const left = document.createElement('div');
    left.className = 'snapshot-left';

    const title = document.createElement('div');
    title.className = 'snapshot-title';
    title.textContent = `${formatDateTime(it.at)} (${it.reason || 'manual'})`;

    const sub = document.createElement('div');
    sub.className = 'snapshot-sub';
    sub.textContent = it.id;

    left.appendChild(title);
    left.appendChild(sub);

    const right = document.createElement('div');
    right.className = 'snapshot-actions';

    const b1 = document.createElement('button');
    b1.className = 'btn';
    b1.type = 'button';
    b1.textContent = 'Restaurar';
    b1.setAttribute('data-act', 'restore');
    b1.setAttribute('data-id', it.id);

    const b2 = document.createElement('button');
    b2.className = 'btn';
    b2.type = 'button';
    b2.textContent = 'Descargar';
    b2.setAttribute('data-act', 'download');
    b2.setAttribute('data-id', it.id);

    right.appendChild(b1);
    right.appendChild(b2);

    li.appendChild(left);
    li.appendChild(right);
    listEl.appendChild(li);
  }
}

async function loadState() {
  // 1) Try IndexedDB first
  try {
    const state = await idbGet(IDB_STATE_KEY);
    if (state) return state;
  } catch {
    // ignore and try legacy
  }

  // 2) Legacy migration from localStorage
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Persist into IndexedDB and remove legacy key (so it doesn't override later)
    try {
      await idbSet(IDB_STATE_KEY, parsed);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // If IDB write fails, keep legacy as fallback
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {any} state
 * @param {{updatedAt?:string, updatedBy?:string, source?:string}=} options
 */
async function saveState(state, options) {
  await idbSet(IDB_STATE_KEY, state);

  // Update metadata for sync/conflict resolution
  try {
    const meta = await getMeta();
    meta.deviceId = meta.deviceId || randomId();
    meta.stateUpdatedAt = options?.updatedAt || nowISO();
    meta.stateUpdatedBy = options?.updatedBy || meta.deviceId;
    meta.stateUpdatedSource = options?.source || 'local';
    await setMeta(meta);
  } catch {
    // ignore meta failures
  }
}

function emptyState() {
  return {
    version: 1,
    business: {
      name: 'M&S - Control Finanzas',
      currency: 'GTQ',
    },
    products: /** @type {Product[]} */ ([]),
    sales: /** @type {Sale[]} */ ([]),
    expenses: /** @type {Expense[]} */ ([]),
    tables: /** @type {TableSession[]} */ ([]),
  };
}

function seedIfEmpty(state) {
  if (state.products.length || state.sales.length || state.expenses.length || state.tables.length) return state;

  state.products = [
    { id: 1, name: 'Coca-Cola 500ml', category: 'bebida', cost: 5, price: 8, stock: 24, stockMin: 5 },
    { id: 2, name: 'Cerveza Nacional', category: 'bebida', cost: 6, price: 12, stock: 36, stockMin: 10 },
    { id: 3, name: 'Papas fritas', category: 'snack', cost: 3, price: 6, stock: 15, stockMin: 5 },
  ];
  state.tables = [
    { id: uuid(), table: 1, players: 2, rate: 10, startAt: new Date(Date.now() - 45 * 60000).toISOString(), active: true },
  ];
  toast('Listo', 'Datos de ejemplo creados (puedes borrarlos en Configuración).');
  return state;
}

/**
 * @param {string} startISO inclusive
 * @param {string} endISO exclusive
 */
function withinRangeISO(iso, startISO, endISO) {
  return iso >= startISO && iso < endISO;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfWeek(d) {
  const x = startOfDay(d);
  const day = x.getDay(); // 0=Sun
  const diff = (day === 0 ? -6 : 1) - day; // Monday start
  x.setDate(x.getDate() + diff);
  return x;
}

function startOfMonth(d) {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

function computeKPIs(state) {
  const now = new Date();
  const d0 = startOfDay(now).toISOString();
  const d1 = addDays(startOfDay(now), 1).toISOString();

  const w0 = startOfWeek(now).toISOString();
  const w1 = addDays(startOfWeek(now), 7).toISOString();

  const m0 = startOfMonth(now).toISOString();
  const m1 = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

  const salesToday = state.sales.filter(s => withinRangeISO(s.at, d0, d1));
  const salesWeek = state.sales.filter(s => withinRangeISO(s.at, w0, w1));
  const salesMonth = state.sales.filter(s => withinRangeISO(s.at, m0, m1));

  const expensesToday = state.expenses.filter(e => withinRangeISO(e.at, d0, d1));
  const expensesWeek = state.expenses.filter(e => withinRangeISO(e.at, w0, w1));
  const expensesMonth = state.expenses.filter(e => withinRangeISO(e.at, m0, m1));

  const incomeTablesToday = state.tables
    .filter(t => !t.active && t.endAt && withinRangeISO(t.endAt, d0, d1))
    .map(t => Number(t.total || 0));

  const incomeSalesToday = salesToday.map(s => s.total);

  const incomeToday = sum(incomeSalesToday) + sum(incomeTablesToday);
  const incomeWeek = sum(salesWeek.map(s => s.total)) + sum(state.tables.filter(t => !t.active && t.endAt && withinRangeISO(t.endAt, w0, w1)).map(t => Number(t.total || 0)));
  const incomeMonth = sum(salesMonth.map(s => s.total)) + sum(state.tables.filter(t => !t.active && t.endAt && withinRangeISO(t.endAt, m0, m1)).map(t => Number(t.total || 0)));

  const profitToday = sum(salesToday.map(s => s.profit)) - sum(expensesToday.map(e => e.amount));
  const profitWeek = sum(salesWeek.map(s => s.profit)) - sum(expensesWeek.map(e => e.amount));
  const profitMonth = sum(salesMonth.map(s => s.profit)) - sum(expensesMonth.map(e => e.amount));

  const lowStock = state.products.filter(p => p.stock <= p.stockMin);

  return {
    incomeToday, incomeWeek, incomeMonth,
    profitToday, profitWeek, profitMonth,
    expensesToday: sum(expensesToday.map(e => e.amount)),
    activeTables: state.tables.filter(t => t.active).length,
    lowStock,
  };
}

function $id(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

function setSection(id) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  $id(id).classList.add('active');

  document.querySelectorAll('.tab').forEach(b => {
    b.setAttribute('aria-selected', 'false');
    b.setAttribute('tabindex', '-1');
  });
  const btn = document.querySelector(`.tab[data-target="${id}"]`);
  if (btn) {
    btn.setAttribute('aria-selected', 'true');
    btn.setAttribute('tabindex', '0');
  }
}

function renderDashboard(state) {
  const k = computeKPIs(state);
  $id('kpiIncomeToday').textContent = formatMoney(k.incomeToday);
  $id('kpiIncomeWeek').textContent = formatMoney(k.incomeWeek);
  $id('kpiIncomeMonth').textContent = formatMoney(k.incomeMonth);

  $id('kpiProfitToday').textContent = formatMoney(k.profitToday);
  $id('kpiProfitWeek').textContent = formatMoney(k.profitWeek);
  $id('kpiProfitMonth').textContent = formatMoney(k.profitMonth);

  $id('kpiExpensesToday').textContent = formatMoney(k.expensesToday);
  $id('kpiActiveTables').textContent = String(k.activeTables);

  const ul = $id('lowStockList');
  ul.innerHTML = '';
  if (k.lowStock.length === 0) {
    const li = document.createElement('li');
    li.className = 'small';
    li.textContent = 'Sin alertas de inventario.';
    ul.appendChild(li);
  } else {
    k.lowStock
      .sort((a, b) => (a.stock - a.stockMin) - (b.stock - b.stockMin))
      .slice(0, 8)
      .forEach(p => {
        const li = document.createElement('li');
        li.className = 'small';
        li.textContent = `${p.name} — Stock ${p.stock} (mín. ${p.stockMin})`;
        ul.appendChild(li);
      });
  }
}

function renderProducts(state) {
  const tbody = $id('productsTbody');
  tbody.innerHTML = '';

  const filter = $id('productsFilter').value;
  const q = $id('productsSearch').value.trim().toLowerCase();

  const filtered = state.products
    .filter(p => filter === 'all' ? true : p.category === filter)
    .filter(p => q ? p.name.toLowerCase().includes(q) : true)
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));

  for (const p of filtered) {
    const tr = document.createElement('tr');
    const badge = p.stock <= p.stockMin ? '<span class="badge low">Bajo</span>' : '<span class="badge ok">OK</span>';
    tr.innerHTML = `
      <td data-label="Nombre">${escapeHtml(p.name)}</td>
      <td data-label="Categoría">${escapeHtml(p.category)}</td>
      <td data-label="Costo">${formatMoney(p.cost)}</td>
      <td data-label="Precio">${formatMoney(p.price)}</td>
      <td data-label="Stock">${p.stock}</td>
      <td data-label="Mín.">${p.stockMin}</td>
      <td data-label="Estado">${badge}</td>
      <td class="actions" data-label="">
        <button class="btn" data-act="edit" data-id="${p.id}">Editar</button>
        <button class="btn danger" data-act="del" data-id="${p.id}">Eliminar</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  const select = $id('saleProduct');
  const selected = select.value;
  select.innerHTML = '<option value="">Seleccione un producto</option>';
  for (const p of state.products.sort((a, b) => a.name.localeCompare(b.name, 'es'))) {
    const opt = document.createElement('option');
    opt.value = String(p.id);
    opt.textContent = `${p.name} (${p.stock}) — ${formatMoney(p.price)}`;
    select.appendChild(opt);
  }
  if ([...select.options].some(o => o.value === selected)) select.value = selected;
}

function renderSales(state) {
  const tbody = $id('salesTbody');
  tbody.innerHTML = '';

  const sales = [...state.sales].sort((a, b) => b.at.localeCompare(a.at));

  for (const s of sales.slice(0, 80)) {
    const p = state.products.find(x => x.id === s.productId);
    const name = p ? p.name : '(producto eliminado)';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="Fecha">${formatDateTime(s.at)}</td>
      <td data-label="Producto">${escapeHtml(name)}</td>
      <td data-label="Cant.">${s.qty}</td>
      <td data-label="Total">${formatMoney(s.total)}</td>
      <td data-label="Ganancia" class="text-success">${formatMoney(s.profit)}</td>
      <td class="actions" data-label=""><button class="btn danger" data-act="sale-del" data-id="${s.id}">Eliminar</button></td>
    `;
    tbody.appendChild(tr);
  }
}

function renderExpenses(state) {
  const tbody = $id('expensesTbody');
  tbody.innerHTML = '';
  const expenses = [...state.expenses].sort((a, b) => b.at.localeCompare(a.at));

  for (const e of expenses.slice(0, 120)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="Fecha">${formatDateTime(e.at)}</td>
      <td data-label="Tipo">${escapeHtml(e.type)}</td>
      <td data-label="Monto">${formatMoney(e.amount)}</td>
      <td data-label="Descripción">${escapeHtml(e.description || '')}</td>
      <td class="actions" data-label=""><button class="btn danger" data-act="exp-del" data-id="${e.id}">Eliminar</button></td>
    `;
    tbody.appendChild(tr);
  }
}

function renderTables(state) {
  const tbody = $id('tablesTbody');
  tbody.innerHTML = '';

  const active = state.tables.filter(t => t.active).sort((a, b) => a.table - b.table);

  for (const t of active) {
    const started = new Date(t.startAt);
    const mins = Math.max(0, Math.floor((Date.now() - started.getTime()) / 60000));
    const total = (mins / 60) * t.rate * t.players;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="Mesa">Mesa ${t.table}</td>
      <td data-label="Jugadores">${t.players}</td>
      <td data-label="Tarifa">${formatMoney(t.rate)}/h/jugador</td>
      <td data-label="Tiempo">${mins} min</td>
      <td data-label="Total">${formatMoney(total)}</td>
      <td class="actions" data-label="">
        <button class="btn warn" data-act="table-stop" data-id="${t.id}">Finalizar</button>
        <button class="btn" data-act="table-plus" data-id="${t.id}">+ Jugador</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  if (active.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="6" class="small">No hay mesas activas.</td>`;
    tbody.appendChild(tr);
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function downloadText(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function toCSV(rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    if (/[\n\r,\"]/g.test(s)) return '"' + s.replaceAll('"', '""') + '"';
    return s;
  };
  return rows.map(r => r.map(esc).join(',')).join('\n');
}

async function init() {
  setupInstallButton();
  void registerServiceWorker();

  /** @type {ReturnType<typeof emptyState>} */
  let state = (await loadState()) || emptyState();

  // Ensure we have a stable device id (used for sync)
  try { await ensureDeviceId(); } catch { /* ignore */ }

  let stateChangedDuringInit = false;

  // Legacy migration from the older monolithic HTML (productos/ventas/mesasActivas)
  try {
    const meta = await getMeta();
    if (!meta.legacyBillarMigratedAt && isStateEmpty(state)) {
      const res = migrateFromLegacyBillarLocalStorageIntoState(state);
      if (res.migrated) {
        state = res.state;
        meta.legacyBillarMigratedAt = nowISO();
        await setMeta(meta);
        await saveState(state, { source: 'migracion' });
        stateChangedDuringInit = true;
        toast('Migración', 'Importé datos antiguos (localStorage) a la app actual.');
      }
    }
  } catch {
    // ignore migration errors
  }

  const wasEmptyBeforeSeed = isStateEmpty(state);
  state = seedIfEmpty(state);
  if (wasEmptyBeforeSeed && !isStateEmpty(state)) stateChangedDuringInit = true;
  if (stateChangedDuringInit) {
    await saveState(state, { source: 'init' });
  }

  // Automatic daily snapshot (keeps last MAX_SNAPSHOTS)
  try { await ensureDailySnapshot(state); } catch { /* ignore */ }

  // Tabs
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => setSection(btn.getAttribute('data-target')));
  });

  // Top actions
  $id('btnExport').addEventListener('click', () => {
    const data = JSON.stringify(state, null, 2);
    downloadText('ms_finanzas_backup.json', data, 'application/json');
    toast('Exportado', 'Backup descargado como JSON.');
  });

  $id('fileImport').addEventListener('change', async (e) => {
    const input = /** @type {HTMLInputElement} */ (e.currentTarget);
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') throw new Error('Formato inválido');

      // Basic shape check
      if (!Array.isArray(parsed.products) || !Array.isArray(parsed.sales) || !Array.isArray(parsed.expenses) || !Array.isArray(parsed.tables)) {
        throw new Error('El backup no contiene la estructura esperada.');
      }

      state = parsed;
      await saveState(state);
      rerender();
      toast('Importado', 'Datos restaurados desde backup.');
    } catch (err) {
      toast('Error', `No se pudo importar: ${err?.message || err}`);
    }
  });

  $id('btnImport').addEventListener('click', () => $id('fileImport').click());

  $id('btnClear').addEventListener('click', async () => {
    if (!confirm('¿Eliminar TODOS los datos locales de esta app?')) return;
    state = emptyState();
    await idbClearAll();
    // Also clear any legacy remnants
    try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore */ }
    await saveState(state, { source: 'clear' });
    rerender();
    toast('Listo', 'Datos eliminados.');
  });

  // Snapshots / maintenance
  const btnSnapshotNow = document.getElementById('btnSnapshotNow');
  if (btnSnapshotNow) {
    btnSnapshotNow.addEventListener('click', async () => {
      await createSnapshot(state, 'manual');
      void renderSnapshotsUI();
      toast('Respaldo', 'Respaldo creado y guardado localmente.');
    });
  }

  const btnMigrateLegacy = document.getElementById('btnMigrateLegacy');
  if (btnMigrateLegacy) {
    btnMigrateLegacy.addEventListener('click', async () => {
      if (!confirm('¿Intentar importar datos antiguos desde localStorage (productos/ventas/mesasActivas)? Solo se importará si la app está vacía.')) return;
      if (!isStateEmpty(state)) {
        toast('No aplicado', 'Tu app ya tiene datos; no importé para evitar mezclar. Exporta y borra todo si deseas migrar.');
        return;
      }

      const res = migrateFromLegacyBillarLocalStorageIntoState(state);
      if (!res.migrated) {
        toast('Sin datos', 'No encontré datos antiguos para importar.');
        return;
      }

      state = res.state;
      await saveState(state, { source: 'migracion-manual' });
      const meta = await getMeta();
      meta.legacyBillarMigratedAt = nowISO();
      await setMeta(meta);
      try { await ensureDailySnapshot(state); } catch { /* ignore */ }
      rerender();
      void renderSnapshotsUI();
      toast('Migración', 'Datos antiguos importados correctamente.');
    });
  }

  const snapshotList = document.getElementById('snapshotList');
  if (snapshotList) {
    snapshotList.addEventListener('click', async (e) => {
      const btn = /** @type {HTMLElement} */ (e.target).closest('button');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      const id = btn.getAttribute('data-id');
      if (!act || !id) return;

      if (act === 'restore') {
        if (!confirm('¿Restaurar este respaldo? Esto reemplaza los datos actuales.')) return;
        const snap = await idbGet(IDB_SNAPSHOT_PREFIX + id);
        if (!snap?.state) {
          toast('Error', 'Respaldo no encontrado.');
          return;
        }
        state = snap.state;
        await saveState(state, { source: 'snapshot-restore' });
        rerender();
        toast('Restaurado', 'Datos restaurados desde respaldo.');
        return;
      }

      if (act === 'download') {
        const snap = await idbGet(IDB_SNAPSHOT_PREFIX + id);
        if (!snap?.state) {
          toast('Error', 'Respaldo no encontrado.');
          return;
        }
        const data = JSON.stringify(snap.state, null, 2);
        downloadText(`ms_finanzas_snapshot_${id.replaceAll(':', '-')}.json`, data, 'application/json');
        toast('Descargado', 'Respaldo descargado como JSON.');
      }
    });
  }

  // Products interactions
  $id('productsFilter').addEventListener('change', () => renderProducts(state));
  $id('productsSearch').addEventListener('input', () => renderProducts(state));

  $id('productForm').addEventListener('submit', (e) => {
    e.preventDefault();

    const id = Number($id('productId').value || 0);
    const name = $id('productName').value.trim();
    const category = $id('productCategory').value;
    const cost = parseMoney($id('productCost').value);
    const price = parseMoney($id('productPrice').value);
    const stock = clampInt($id('productStock').value, 0, 1_000_000);
    const stockMin = clampInt($id('productStockMin').value, 0, 1_000_000);

    if (!name) {
      toast('Falta dato', 'Escribe el nombre del producto.');
      return;
    }
    if (!(cost >= 0) || !(price >= 0) || price < cost) {
      toast('Validación', 'El precio debe ser >= costo (y ambos válidos).');
      return;
    }

    if (id) {
      const p = state.products.find(x => x.id === id);
      if (!p) {
        toast('Error', 'Producto no encontrado para editar.');
        return;
      }
      p.name = name;
      p.category = category;
      p.cost = cost;
      p.price = price;
      p.stock = stock;
      p.stockMin = stockMin;
      toast('Actualizado', 'Producto actualizado.');
    } else {
      const newP = /** @type {Product} */ ({
        id: uuid(),
        name,
        category,
        cost,
        price,
        stock,
        stockMin,
      });
      state.products.push(newP);
      toast('Agregado', 'Producto creado.');
    }

    // Reset form
    $id('productId').value = '';
    $id('productForm').reset();

    void saveState(state);
    rerender();
  });

  $id('productCancel').addEventListener('click', () => {
    $id('productId').value = '';
    $id('productForm').reset();
    toast('Listo', 'Edición cancelada.');
  });

  $id('productsTbody').addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    const id = Number(btn.getAttribute('data-id'));

    if (act === 'edit') {
      const p = state.products.find(x => x.id === id);
      if (!p) return;
      $id('productId').value = String(p.id);
      $id('productName').value = p.name;
      $id('productCategory').value = p.category;
      $id('productCost').value = String(p.cost);
      $id('productPrice').value = String(p.price);
      $id('productStock').value = String(p.stock);
      $id('productStockMin').value = String(p.stockMin);
      setSection('inventory');
      toast('Editar', 'Modifica y guarda los cambios.');
      return;
    }

    if (act === 'del') {
      const p = state.products.find(x => x.id === id);
      if (!p) return;
      if (!confirm(`¿Eliminar "${p.name}"?`)) return;
      state.products = state.products.filter(x => x.id !== id);
      // Keep sales history but product link may show “eliminado”
      void saveState(state);
      rerender();
      toast('Eliminado', 'Producto eliminado.');
    }
  });

  // Sales
  $id('saleForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const productId = Number($id('saleProduct').value || 0);
    const qty = clampInt($id('saleQty').value, 1, 1_000_000);
    const notes = $id('saleNotes').value.trim();

    const p = state.products.find(x => x.id === productId);
    if (!p) {
      toast('Falta dato', 'Selecciona un producto.');
      return;
    }

    if (p.stock < qty) {
      toast('Stock insuficiente', `Solo hay ${p.stock} unidades disponibles.`);
      return;
    }

    const total = qty * p.price;
    const profit = qty * (p.price - p.cost);

    /** @type {Sale} */
    const sale = {
      id: uuid(),
      at: nowISO(),
      productId: p.id,
      qty,
      unitPrice: p.price,
      unitCost: p.cost,
      total,
      profit,
      notes: notes || undefined,
    };

    state.sales.push(sale);
    p.stock -= qty;

    $id('saleForm').reset();

    await saveState(state);
    rerender();
    toast('Venta registrada', `${qty} x ${p.name} — Total ${formatMoney(total)}`);
  });

  $id('salesTbody').addEventListener('click', async (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!btn) return;
    if (btn.getAttribute('data-act') !== 'sale-del') return;
    const id = Number(btn.getAttribute('data-id'));
    const sale = state.sales.find(s => s.id === id);
    if (!sale) return;
    if (!confirm('¿Eliminar esta venta? (No repone stock automáticamente)')) return;
    state.sales = state.sales.filter(s => s.id !== id);
    await saveState(state);
    rerender();
    toast('Eliminada', 'Venta eliminada.');
  });

  // Expenses
  $id('expenseForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = $id('expenseType').value;
    const amount = parseMoney($id('expenseAmount').value);
    const description = $id('expenseDescription').value.trim();

    if (!type) {
      toast('Falta dato', 'Selecciona el tipo de gasto.');
      return;
    }
    if (!(amount > 0)) {
      toast('Validación', 'Monto debe ser mayor que 0.');
      return;
    }

    /** @type {Expense} */
    const exp = { id: uuid(), at: nowISO(), type, amount, description: description || undefined };
    state.expenses.push(exp);
    $id('expenseForm').reset();

    await saveState(state);
    rerender();
    toast('Gasto registrado', `${type} — ${formatMoney(amount)}`);
  });

  $id('expensesTbody').addEventListener('click', async (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!btn) return;
    if (btn.getAttribute('data-act') !== 'exp-del') return;
    const id = Number(btn.getAttribute('data-id'));
    if (!confirm('¿Eliminar este gasto?')) return;
    state.expenses = state.expenses.filter(x => x.id !== id);
    await saveState(state);
    rerender();
    toast('Eliminado', 'Gasto eliminado.');
  });

  // Tables
  $id('tableForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const table = clampInt($id('tableNumber').value, 1, 100);
    const players = clampInt($id('tablePlayers').value, 1, 50);
    const rate = parseMoney($id('tableRate').value);

    if (!(rate > 0)) {
      toast('Validación', 'Tarifa debe ser mayor que 0.');
      return;
    }

    const existing = state.tables.find(t => t.active && t.table === table);
    if (existing) {
      toast('Mesa activa', `La mesa ${table} ya está activa.`);
      return;
    }

    /** @type {TableSession} */
    const session = {
      id: uuid(),
      table,
      players,
      rate,
      startAt: nowISO(),
      active: true,
    };

    state.tables.push(session);
    $id('tableForm').reset();

    await saveState(state);
    rerender();
    toast('Mesa iniciada', `Mesa ${table} con ${players} jugador(es).`);
  });

  $id('tablesTbody').addEventListener('click', async (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    const id = Number(btn.getAttribute('data-id'));
    const t = state.tables.find(x => x.id === id);
    if (!t) return;

    if (act === 'table-plus') {
      t.players += 1;
      await saveState(state);
      rerender();
      toast('Jugador agregado', `Mesa ${t.table}: ${t.players} jugador(es).`);
      return;
    }

    if (act === 'table-stop') {
      const started = new Date(t.startAt);
      const mins = Math.max(0, Math.floor((Date.now() - started.getTime()) / 60000));
      const total = (mins / 60) * t.rate * t.players;

      t.active = false;
      t.endAt = nowISO();
      t.total = Number(total.toFixed(2));

      await saveState(state);
      rerender();
      toast('Mesa finalizada', `Mesa ${t.table} — Total ${formatMoney(total)}`);
      return;
    }
  });

  // Reports
  $id('btnExportCSV').addEventListener('click', () => {
    const rows = [
      ['tipo', 'fecha', 'detalle', 'cantidad', 'total', 'ganancia'],
      ...state.sales.map(s => {
        const p = state.products.find(x => x.id === s.productId);
        return ['venta', s.at, p ? p.name : '(eliminado)', String(s.qty), String(s.total), String(s.profit)];
      }),
      ...state.expenses.map(e => ['gasto', e.at, e.type, '', String(e.amount), '']),
      ...state.tables.filter(t => !t.active && t.endAt).map(t => ['mesa', t.endAt, `Mesa ${t.table}`, String(t.players), String(t.total || 0), '']),
    ];

    downloadText('ms_finanzas_movimientos.csv', toCSV(rows), 'text/csv');
    toast('Exportado', 'Archivo CSV descargado.');
  });

  function rerender() {
    renderDashboard(state);
    renderTables(state);
    renderProducts(state);
    renderSales(state);
    renderExpenses(state);

    $id('aboutStorage').textContent = `Guardado local (IndexedDB): ${IDB_DB_NAME}/${IDB_STORE}/${IDB_STATE_KEY} | PWA instalable + Sync opcional`;
    void renderSnapshotsUI();
  }

  // Initial render
  $id('appDate').textContent = new Date().toLocaleDateString('es-GT', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  $id('appTitle').textContent = state.business?.name || 'M&S - Control Finanzas';

  setSection('dashboard');
  rerender();
  void renderSnapshotsUI();

  // Sync (optional) UI
  const syncForm = document.getElementById('syncForm');
  if (syncForm) {
    const elUrl = /** @type {HTMLInputElement} */ (document.getElementById('syncUrl'));
    const elUser = /** @type {HTMLInputElement} */ (document.getElementById('syncUser'));
    const elPass = /** @type {HTMLInputElement} */ (document.getElementById('syncPass'));
    const elAuto = /** @type {HTMLInputElement} */ (document.getElementById('syncAuto'));
    const elStatus = document.getElementById('syncStatus');

    const btnTest = document.getElementById('btnSyncTest');
    const btnPush = document.getElementById('btnSyncPush');
    const btnPull = document.getElementById('btnSyncPull');

    const setStatus = (msg) => { if (elStatus) elStatus.textContent = msg; };

    const cfg = await getSyncConfig();
    elUrl.value = cfg.url;
    elUser.value = cfg.user;
    elPass.value = cfg.pass;
    elAuto.checked = cfg.auto;

    const persistCfg = async () => {
      const next = {
        url: elUrl.value.trim(),
        user: elUser.value.trim(),
        pass: elPass.value,
        auto: elAuto.checked,
      };
      await setSyncConfig(next);
      return next;
    };

    syncForm.addEventListener('input', () => { void persistCfg(); });
    syncForm.addEventListener('change', () => { void persistCfg(); });

    if (btnTest) {
      btnTest.addEventListener('click', async () => {
        const c = await persistCfg();
        if (!c.url) {
          toast('Falta URL', 'Escribe la URL WebDAV del archivo .json.');
          return;
        }
        try {
          setStatus('Probando conexión...');
          await fetchRemoteSnapshot(c);
          setStatus(`OK — online (${new Date().toLocaleTimeString('es-GT')})`);
          toast('Conexión', 'Conexión OK.');
        } catch (err) {
          setStatus(`Error: ${err?.message || err}`);
          toast('Error', `No se pudo conectar: ${err?.message || err}`);
        }
      });
    }

    if (btnPush) {
      btnPush.addEventListener('click', async () => {
        const c = await persistCfg();
        if (!c.url) {
          toast('Falta URL', 'Escribe la URL WebDAV del archivo .json.');
          return;
        }
        try {
          setStatus('Revisando remoto...');
          const remote = await fetchRemoteSnapshot(c);
          const meta = await getMeta();
          const localUpdatedAt = meta.stateUpdatedAt || null;
          const remoteUpdatedAt = remote?.updatedAt || remote?.meta?.updatedAt || null;

          if (remoteUpdatedAt && isoNewerThan(remoteUpdatedAt, localUpdatedAt)) {
            const ok = confirm('El remoto parece más reciente que este dispositivo. ¿Deseas sobrescribir el remoto con los datos locales?');
            if (!ok) {
              setStatus('Cancelado (remoto más reciente)');
              return;
            }
          }

          const deviceId = meta.deviceId || (await ensureDeviceId());
          const payload = {
            app: 'ms-finanzas',
            format: 1,
            updatedAt: localUpdatedAt || nowISO(),
            updatedBy: deviceId,
            state,
          };

          setStatus('Subiendo...');
          await pushRemoteSnapshot(c, payload);

          const m2 = await getMeta();
          m2.lastSyncPushAt = nowISO();
          await setMeta(m2);

          setStatus(`Subido OK (${new Date().toLocaleTimeString('es-GT')})`);
          toast('Sync', 'Datos subidos al remoto.');
        } catch (err) {
          setStatus(`Error: ${err?.message || err}`);
          toast('Error', `No se pudo subir: ${err?.message || err}`);
        }
      });
    }

    if (btnPull) {
      btnPull.addEventListener('click', async () => {
        const c = await persistCfg();
        if (!c.url) {
          toast('Falta URL', 'Escribe la URL WebDAV del archivo .json.');
          return;
        }
        try {
          setStatus('Descargando...');
          const remote = await fetchRemoteSnapshot(c);
          if (!remote || !remote.state) {
            toast('Sin datos', 'No encontré un archivo remoto válido (o está vacío).');
            setStatus('Sin datos remotos');
            return;
          }

          if (!isValidStateShape(remote.state)) {
            throw new Error('El remoto no contiene la estructura esperada.');
          }

          const meta = await getMeta();
          const localUpdatedAt = meta.stateUpdatedAt || null;
          const remoteUpdatedAt = remote.updatedAt || null;

          if (localUpdatedAt && isoNewerThan(localUpdatedAt, remoteUpdatedAt)) {
            const ok = confirm('Este dispositivo parece más reciente que el remoto. ¿Deseas reemplazar tus datos locales con los del remoto?');
            if (!ok) {
              setStatus('Cancelado (local más reciente)');
              return;
            }
          }

          state = remote.state;
          await saveState(state, {
            source: 'sync-pull',
            updatedAt: remoteUpdatedAt || nowISO(),
            updatedBy: remote.updatedBy || meta.deviceId,
          });

          const m2 = await getMeta();
          m2.lastSyncPullAt = nowISO();
          await setMeta(m2);

          rerender();
          setStatus(`Descargado OK (${new Date().toLocaleTimeString('es-GT')})`);
          toast('Sync', 'Datos descargados del remoto.');
        } catch (err) {
          setStatus(`Error: ${err?.message || err}`);
          toast('Error', `No se pudo bajar: ${err?.message || err}`);
        }
      });
    }

    // Auto-sync on startup (best-effort)
    try {
      const c = await getSyncConfig();
      if (c.auto && c.url && navigator.onLine) {
        setStatus('Auto-sync: revisando...');
        const remote = await fetchRemoteSnapshot(c);
        const meta = await getMeta();
        const localUpdatedAt = meta.stateUpdatedAt || null;
        const remoteUpdatedAt = remote?.updatedAt || null;

        if (remote && remote.state && isValidStateShape(remote.state) && isoNewerThan(remoteUpdatedAt, localUpdatedAt)) {
          state = remote.state;
          await saveState(state, { source: 'sync-auto-pull', updatedAt: remoteUpdatedAt || nowISO(), updatedBy: remote.updatedBy || meta.deviceId });
          rerender();
          setStatus('Auto-sync: datos remotos aplicados');
        } else {
          setStatus('Auto-sync: sin cambios');
        }
      } else {
        setStatus(navigator.onLine ? 'Listo (online)' : 'Listo (offline)');
      }
    } catch {
      setStatus(navigator.onLine ? 'Listo (online)' : 'Listo (offline)');
    }

    window.addEventListener('online', () => setStatus('Online'));
    window.addEventListener('offline', () => setStatus('Offline'));
  }

  // Autosave safeguard (state variable updates already call saveState)
  window.addEventListener('beforeunload', () => {
    // Best-effort; most actions already persisted.
    try { void saveState(state); } catch { /* ignore */ }
  });
}

document.addEventListener('DOMContentLoaded', () => { void init(); });
