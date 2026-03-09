import { useState, useEffect, useRef, useCallback } from "react";

// ═══════════════════════════════════════════════════════════════
// RetailFlow POS — Configuration
// ═══════════════════════════════════════════════════════════════
// Set this to your deployed Apps Script Web App URL
// Leave empty to use demo/mock data mode
const API_URL = ""; // e.g. "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec"
const DEVICE_ID = "device_" + Math.random().toString(36).substr(2, 8);

// ─── IndexedDB Offline Cache ──────────────────────────────────

const DB_NAME = "RetailFlowPOS";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("products")) db.createObjectStore("products", { keyPath: "id" });
      if (!db.objectStoreNames.contains("pendingSales")) db.createObjectStore("pendingSales", { keyPath: "offlineId" });
      if (!db.objectStoreNames.contains("syncedSales")) db.createObjectStore("syncedSales", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(storeName, data) {
  try {
    const db = await openDB();
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    if (Array.isArray(data)) { data.forEach(item => store.put(item)); }
    else { store.put(data); }
    return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
  } catch (e) { console.warn("DB put failed:", e); }
}

async function dbGetAll(storeName) {
  try {
    const db = await openDB();
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    return new Promise((res, rej) => {
      const req = store.getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  } catch (e) { console.warn("DB getAll failed:", e); return []; }
}

async function dbDelete(storeName, key) {
  try {
    const db = await openDB();
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
  } catch (e) { console.warn("DB delete failed:", e); }
}

async function dbClear(storeName) {
  try {
    const db = await openDB();
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).clear();
    return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
  } catch (e) { console.warn("DB clear failed:", e); }
}

// ─── API Service ──────────────────────────────────────────────

const api = {
  isConfigured: () => !!API_URL,

  async get(action, params = {}) {
    if (!API_URL) return null;
    const url = new URL(API_URL);
    url.searchParams.set("action", action);
    Object.keys(params).forEach(k => url.searchParams.set(k, params[k]));
    try {
      const res = await fetch(url.toString(), { redirect: "follow" });
      return await res.json();
    } catch (e) {
      console.warn("API GET failed:", e);
      return null;
    }
  },

  async post(action, data = {}) {
    if (!API_URL) return null;
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...data, deviceId: DEVICE_ID }),
        redirect: "follow"
      });
      return await res.json();
    } catch (e) {
      console.warn("API POST failed:", e);
      return null;
    }
  }
};

// ─── Sync Engine ──────────────────────────────────────────────

async function syncPendingSales() {
  if (!api.isConfigured()) return { synced: 0, pending: 0 };

  const pending = await dbGetAll("pendingSales");
  if (pending.length === 0) return { synced: 0, pending: 0 };

  try {
    const result = await api.post("syncSales", { sales: pending });
    if (result && result.success) {
      // Remove successfully synced sales from pending
      for (const r of (result.results || [])) {
        if (r.success && r.offlineId) {
          await dbDelete("pendingSales", r.offlineId);
        }
      }
      return { synced: result.synced || 0, pending: result.failed || 0 };
    }
  } catch (e) {
    console.warn("Sync failed:", e);
  }
  return { synced: 0, pending: pending.length };
}

// ─── Online Status Hook ───────────────────────────────────────

function useOnlineStatus() {
  const [online, setOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSync, setLastSync] = useState(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // Check pending sales count periodically
  useEffect(() => {
    const check = async () => {
      try {
        const pending = await dbGetAll("pendingSales");
        setPendingCount(pending.length);
      } catch (e) { /* ignore */ }
    };
    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, []);

  // Auto-sync when coming back online
  useEffect(() => {
    if (online && pendingCount > 0 && !syncing) {
      const doSync = async () => {
        setSyncing(true);
        const result = await syncPendingSales();
        if (result.synced > 0) {
          setLastSync(new Date());
          const remaining = await dbGetAll("pendingSales");
          setPendingCount(remaining.length);
        }
        setSyncing(false);
      };
      doSync();
    }
  }, [online, pendingCount]);

  return { online, pendingCount, lastSync, syncing, setPendingCount };
}

// ─── Data Loading Hook ────────────────────────────────────────

function useProducts() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState("loading"); // "api", "cache", "demo"

  useEffect(() => {
    const load = async () => {
      setLoading(true);

      // 1. Try loading from IndexedDB cache first (instant)
      try {
        const cached = await dbGetAll("products");
        if (cached.length > 0) {
          setProducts(cached);
          setSource("cache");
          setLoading(false);
        }
      } catch (e) { /* continue */ }

      // 2. Try fetching from API (background refresh)
      if (api.isConfigured()) {
        const result = await api.get("getProducts");
        if (result && result.success && result.products) {
          setProducts(result.products);
          setSource("api");
          // Cache products for offline
          await dbClear("products");
          await dbPut("products", result.products);
          await dbPut("meta", { key: "lastProductSync", value: new Date().toISOString() });
          setLoading(false);
          return;
        }
      }

      // 3. Fallback to demo data if nothing else worked
      if (products.length === 0) {
        setProducts(MOCK_PRODUCTS);
        setSource("demo");
      }
      setLoading(false);
    };
    load();
  }, []);

  const refreshProducts = async () => {
    if (!api.isConfigured()) return;
    const result = await api.get("getProducts");
    if (result && result.success && result.products) {
      setProducts(result.products);
      setSource("api");
      await dbClear("products");
      await dbPut("products", result.products);
    }
  };

  return { products, setProducts, loading, source, refreshProducts };
}

// ─── Product Types ────────────────────────────────────────────
// "barcode"  → scan/type barcode, add by unit
// "weight"   → tap product, enter weight (kg), price = rate × weight
// "piece"    → tap product, enter count (pieces)
// "variant"  → tap product, choose size/portion variant

const MOCK_PRODUCTS = [
  // BARCODED PRODUCTS (factory goods with barcodes)
  { id: "P001", type: "barcode", barcode: "8901234567890", name: "Coca Cola 500ml", category: "Beverages", price: 2500, cost: 1800, stock: 48, unit: "bottle", image: "🥤" },
  { id: "P002", type: "barcode", barcode: "8901234567891", name: "Bread - White Loaf", category: "Bakery", price: 5000, cost: 3500, stock: 24, unit: "loaf", image: "🍞" },
  { id: "P003", type: "barcode", barcode: "8901234567892", name: "Omo Detergent 1kg", category: "Household", price: 8000, cost: 6200, stock: 15, unit: "pack", image: "🧴" },
  { id: "P004", type: "barcode", barcode: "8901234567893", name: "Colgate Toothpaste", category: "Personal Care", price: 4000, cost: 2800, stock: 35, unit: "tube", image: "🪥" },
  { id: "P005", type: "barcode", barcode: "8901234567894", name: "Cowboy Biscuits", category: "Snacks", price: 500, cost: 350, stock: 60, unit: "pack", image: "🍪" },
  { id: "P006", type: "barcode", barcode: "8901234567895", name: "Mukwano Soap Bar", category: "Household", price: 3500, cost: 2500, stock: 40, unit: "bar", image: "🧼" },
  { id: "P007", type: "barcode", barcode: "8901234567896", name: "Nile Special 500ml", category: "Beverages", price: 4000, cost: 3000, stock: 30, unit: "bottle", image: "🍺" },
  { id: "P008", type: "barcode", barcode: "8901234567897", name: "Fresh Milk 500ml", category: "Dairy", price: 3000, cost: 2200, stock: 40, unit: "pack", image: "🥛" },

  // WEIGHT-BASED PRODUCTS (sold by kg - weighed at counter)
  { id: "W001", type: "weight", barcode: "", name: "Sugar (Loose)", category: "Grocery", pricePerKg: 5000, cost: 3800, stock: 100, unit: "kg", image: "🍚", minWeight: 0.25, weightStep: 0.25 },
  { id: "W002", type: "weight", barcode: "", name: "Rice (Loose)", category: "Grocery", pricePerKg: 5500, cost: 4200, stock: 150, unit: "kg", image: "🌾", minWeight: 0.5, weightStep: 0.5 },
  { id: "W003", type: "weight", barcode: "", name: "Irish Potatoes", category: "Fresh Produce", pricePerKg: 3000, cost: 2000, stock: 200, unit: "kg", image: "🥔", minWeight: 0.5, weightStep: 0.5 },
  { id: "W004", type: "weight", barcode: "", name: "Beans (Loose)", category: "Grocery", pricePerKg: 6000, cost: 4500, stock: 80, unit: "kg", image: "🫘", minWeight: 0.25, weightStep: 0.25 },
  { id: "W005", type: "weight", barcode: "", name: "Maize Flour (Posho)", category: "Grocery", pricePerKg: 3500, cost: 2500, stock: 120, unit: "kg", image: "🌽", minWeight: 0.5, weightStep: 0.5 },
  { id: "W006", type: "weight", barcode: "", name: "Groundnuts", category: "Grocery", pricePerKg: 10000, cost: 7500, stock: 40, unit: "kg", image: "🥜", minWeight: 0.25, weightStep: 0.25 },
  { id: "W007", type: "weight", barcode: "", name: "Onions", category: "Fresh Produce", pricePerKg: 4000, cost: 2800, stock: 60, unit: "kg", image: "🧅", minWeight: 0.25, weightStep: 0.25 },
  { id: "W008", type: "weight", barcode: "", name: "Tomatoes", category: "Fresh Produce", pricePerKg: 5000, cost: 3500, stock: 50, unit: "kg", image: "🍅", minWeight: 0.25, weightStep: 0.25 },

  // PIECE-BASED PRODUCTS (sold per piece, no barcode)
  { id: "PC01", type: "piece", barcode: "", name: "Eggs (per piece)", category: "Dairy", pricePerPiece: 500, cost: 350, stock: 300, unit: "pcs", image: "🥚" },
  { id: "PC02", type: "piece", barcode: "", name: "Rolex Chapati", category: "Ready Food", pricePerPiece: 3000, cost: 2000, stock: 20, unit: "pcs", image: "🌯" },
  { id: "PC03", type: "piece", barcode: "", name: "Mandazi", category: "Bakery", pricePerPiece: 200, cost: 100, stock: 100, unit: "pcs", image: "🍩" },
  { id: "PC04", type: "piece", barcode: "", name: "Samosa", category: "Ready Food", pricePerPiece: 1000, cost: 600, stock: 50, unit: "pcs", image: "🔺" },
  { id: "PC05", type: "piece", barcode: "", name: "Chapati", category: "Bakery", pricePerPiece: 1000, cost: 600, stock: 40, unit: "pcs", image: "🫓" },
  { id: "PC06", type: "piece", barcode: "", name: "Banana (cooking)", category: "Fresh Produce", pricePerPiece: 300, cost: 150, stock: 80, unit: "pcs", image: "🍌" },

  // VARIANT PRODUCTS (big package with barcode, sold in smaller portions)
  { id: "V001", type: "variant", barcode: "8901234567900", name: "Blue Band", category: "Dairy", image: "🧈", cost: 1500,
    variants: [
      { label: "Small (100g)", price: 2000, stock: 30, unit: "pc" },
      { label: "Medium (250g)", price: 4500, stock: 20, unit: "pc" },
      { label: "Large (500g)", price: 8000, stock: 15, unit: "pc" },
    ]
  },
  { id: "V002", type: "variant", barcode: "", name: "Cooking Oil", category: "Grocery", image: "🫗", cost: 800,
    variants: [
      { label: "Small (250ml)", price: 3000, stock: 25, unit: "pc" },
      { label: "Medium (500ml)", price: 5500, stock: 18, unit: "pc" },
      { label: "Large (1L)", price: 10000, stock: 12, unit: "pc" },
      { label: "Jerrycan (5L)", price: 45000, stock: 5, unit: "pc" },
    ]
  },
  { id: "V003", type: "variant", barcode: "", name: "Washing Powder", category: "Household", image: "🧹", cost: 300,
    variants: [
      { label: "Small sachet", price: 500, stock: 80, unit: "pc" },
      { label: "Medium (500g)", price: 4000, stock: 25, unit: "pc" },
      { label: "Large (1kg)", price: 7500, stock: 10, unit: "pc" },
    ]
  },
  { id: "V004", type: "variant", barcode: "", name: "Royco Seasoning", category: "Spices", image: "🧂", cost: 100,
    variants: [
      { label: "Single cube", price: 200, stock: 200, unit: "pc" },
      { label: "Strip (10 cubes)", price: 1800, stock: 40, unit: "strip" },
      { label: "Box (24 cubes)", price: 4000, stock: 15, unit: "box" },
    ]
  },
];

const TYPE_LABELS = {
  barcode: { label: "Scan", color: "bg-blue-500/15 text-blue-400 border-blue-500/25", icon: "📦" },
  weight: { label: "Weigh", color: "bg-amber-500/15 text-amber-400 border-amber-500/25", icon: "⚖️" },
  piece: { label: "Count", color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25", icon: "🔢" },
  variant: { label: "Size", color: "bg-purple-500/15 text-purple-400 border-purple-500/25", icon: "📐" },
};

const ALL_CATEGORIES = ["All", "Favourites", ...new Set(MOCK_PRODUCTS.map(p => p.category))];
const formatUGX = (amount) => `UGX ${Math.round(amount).toLocaleString()}`;

function SearchInput({ value, onChange, placeholder, autoFocus }) {
  return (
    <div className="relative">
      <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500">
        <svg width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      </span>
      <input type="text" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus}
        className="w-full bg-zinc-800/60 border border-zinc-700/50 rounded-xl pl-10 pr-4 py-3 text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/20 transition-all text-sm" />
    </div>
  );
}

function WeightEntryModal({ product, onAdd, onClose }) {
  const [weight, setWeight] = useState("");
  const quickWeights = [0.25, 0.5, 1, 2, 3, 5];
  const total = (parseFloat(weight) || 0) * product.pricePerKg;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-zinc-900 rounded-3xl border border-zinc-800 shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-zinc-800 flex items-center gap-3">
          <span className="text-3xl">{product.image}</span>
          <div className="flex-1">
            <h3 className="text-lg font-bold text-zinc-100">{product.name}</h3>
            <p className="text-sm text-amber-400 font-semibold">{formatUGX(product.pricePerKg)} / kg</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 p-1">
            <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs text-zinc-500 uppercase tracking-wider mb-2 block">Enter Weight (kg)</label>
            <div className="relative">
              <input type="number" value={weight} onChange={e => setWeight(e.target.value)} step={product.weightStep || 0.25} min={product.minWeight || 0.25}
                autoFocus placeholder="0.00"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-4 text-3xl text-center text-zinc-100 font-bold focus:outline-none focus:border-amber-500 transition-all font-mono" />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 text-lg font-medium">kg</span>
            </div>
          </div>
          <div>
            <label className="text-xs text-zinc-500 uppercase tracking-wider mb-2 block">Quick Select</label>
            <div className="grid grid-cols-3 gap-2">
              {quickWeights.map(w => (
                <button key={w} onClick={() => setWeight(w.toString())}
                  className={`py-3 rounded-xl text-sm font-bold transition-all active:scale-95 ${
                    weight === w.toString() ? "bg-amber-500/20 text-amber-400 border-2 border-amber-500/40" : "bg-zinc-800 text-zinc-300 border border-zinc-700 hover:bg-zinc-700"
                  }`}>{w < 1 ? `${w * 1000}g` : `${w}kg`}</button>
              ))}
            </div>
          </div>
          {parseFloat(weight) > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 text-center">
              <p className="text-sm text-zinc-400">{weight}kg × {formatUGX(product.pricePerKg)}</p>
              <p className="text-3xl font-bold text-amber-400 mt-1" style={{ fontFamily: "'DM Sans', sans-serif" }}>{formatUGX(total)}</p>
            </div>
          )}
          <button onClick={() => { if (parseFloat(weight) > 0) onAdd(parseFloat(weight), total); }}
            disabled={!parseFloat(weight)}
            className={`w-full py-4 rounded-xl font-bold text-lg transition-all active:scale-95 ${
              parseFloat(weight) > 0 ? "bg-gradient-to-r from-amber-500 to-orange-500 text-zinc-900 shadow-lg shadow-amber-500/20" : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
            }`}>Add to Cart — {parseFloat(weight) > 0 ? formatUGX(total) : "Enter weight"}</button>
        </div>
      </div>
    </div>
  );
}

function PieceEntryModal({ product, onAdd, onClose }) {
  const [count, setCount] = useState(1);
  const total = count * product.pricePerPiece;
  const quickCounts = [1, 2, 3, 5, 6, 10, 12, 15, 20, 30];

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-zinc-900 rounded-3xl border border-zinc-800 shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-zinc-800 flex items-center gap-3">
          <span className="text-3xl">{product.image}</span>
          <div className="flex-1">
            <h3 className="text-lg font-bold text-zinc-100">{product.name}</h3>
            <p className="text-sm text-emerald-400 font-semibold">{formatUGX(product.pricePerPiece)} / piece</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 p-1">
            <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-center gap-6">
            <button onClick={() => setCount(c => Math.max(1, c - 1))}
              className="w-14 h-14 rounded-2xl bg-zinc-800 border border-zinc-700 text-zinc-200 text-2xl font-bold flex items-center justify-center hover:bg-zinc-700 active:scale-90 transition-all">−</button>
            <div className="text-center">
              <input type="number" value={count} onChange={e => setCount(Math.max(1, parseInt(e.target.value) || 1))} min="1"
                className="w-24 bg-transparent text-4xl text-center text-zinc-100 font-bold focus:outline-none font-mono" />
              <p className="text-xs text-zinc-500 mt-1">pieces</p>
            </div>
            <button onClick={() => setCount(c => c + 1)}
              className="w-14 h-14 rounded-2xl bg-zinc-800 border border-zinc-700 text-zinc-200 text-2xl font-bold flex items-center justify-center hover:bg-zinc-700 active:scale-90 transition-all">+</button>
          </div>
          <div className="flex flex-wrap gap-2 justify-center">
            {quickCounts.map(n => (
              <button key={n} onClick={() => setCount(n)}
                className={`px-3 py-2 rounded-xl text-sm font-bold transition-all active:scale-95 ${
                  count === n ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40" : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:bg-zinc-700"
                }`}>{n}</button>
            ))}
          </div>
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 text-center">
            <p className="text-sm text-zinc-400">{count} pcs × {formatUGX(product.pricePerPiece)}</p>
            <p className="text-3xl font-bold text-emerald-400 mt-1" style={{ fontFamily: "'DM Sans', sans-serif" }}>{formatUGX(total)}</p>
          </div>
          <button onClick={() => onAdd(count, total)}
            className="w-full py-4 rounded-xl font-bold text-lg bg-gradient-to-r from-emerald-500 to-teal-500 text-zinc-900 shadow-lg shadow-emerald-500/20 active:scale-95 transition-all">
            Add {count} pcs — {formatUGX(total)}</button>
        </div>
      </div>
    </div>
  );
}

function VariantModal({ product, onAdd, onClose }) {
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [qty, setQty] = useState(1);
  const selected = selectedIdx !== null ? product.variants[selectedIdx] : null;
  const total = selected ? selected.price * qty : 0;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-zinc-900 rounded-3xl border border-zinc-800 shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-zinc-800 flex items-center gap-3">
          <span className="text-3xl">{product.image}</span>
          <div className="flex-1">
            <h3 className="text-lg font-bold text-zinc-100">{product.name}</h3>
            <p className="text-sm text-purple-400 font-semibold">Choose size / portion</p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 p-1">
            <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="space-y-2">
            {product.variants.map((v, i) => (
              <button key={i} onClick={() => { setSelectedIdx(i); setQty(1); }}
                className={`w-full flex items-center justify-between p-4 rounded-xl border-2 transition-all ${
                  selectedIdx === i ? "border-purple-500 bg-purple-500/10" : "border-zinc-700/50 bg-zinc-800/30 hover:border-zinc-600"
                }`}>
                <div className="text-left">
                  <p className={`font-semibold ${selectedIdx === i ? "text-purple-300" : "text-zinc-200"}`}>{v.label}</p>
                  <p className="text-xs text-zinc-500 mt-0.5">{v.stock} in stock</p>
                </div>
                <span className={`text-lg font-bold ${selectedIdx === i ? "text-purple-400" : "text-zinc-400"}`}>{formatUGX(v.price)}</span>
              </button>
            ))}
          </div>
          {selected && (
            <div className="flex items-center justify-center gap-4 pt-2">
              <button onClick={() => setQty(q => Math.max(1, q - 1))}
                className="w-10 h-10 rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-200 text-lg font-bold flex items-center justify-center hover:bg-zinc-700 active:scale-90">−</button>
              <span className="text-2xl font-bold text-zinc-100 w-12 text-center font-mono">{qty}</span>
              <button onClick={() => setQty(q => q + 1)}
                className="w-10 h-10 rounded-xl bg-zinc-800 border border-zinc-700 text-zinc-200 text-lg font-bold flex items-center justify-center hover:bg-zinc-700 active:scale-90">+</button>
            </div>
          )}
          {selected && (
            <div className="bg-purple-500/10 border border-purple-500/20 rounded-xl p-4 text-center">
              <p className="text-sm text-zinc-400">{qty} × {selected.label} @ {formatUGX(selected.price)}</p>
              <p className="text-3xl font-bold text-purple-400 mt-1" style={{ fontFamily: "'DM Sans', sans-serif" }}>{formatUGX(total)}</p>
            </div>
          )}
          <button onClick={() => { if (selected) onAdd(selectedIdx, qty, total); }}
            disabled={!selected}
            className={`w-full py-4 rounded-xl font-bold text-lg transition-all active:scale-95 ${
              selected ? "bg-gradient-to-r from-purple-500 to-violet-500 text-white shadow-lg shadow-purple-500/20" : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
            }`}>{selected ? `Add to Cart — ${formatUGX(total)}` : "Select a size"}</button>
        </div>
      </div>
    </div>
  );
}

function PaymentModal({ cart, total, onClose, onConfirm }) {
  const [method, setMethod] = useState("cash");
  const [amountPaid, setAmountPaid] = useState("");
  const [processing, setProcessing] = useState(false);
  const [done, setDone] = useState(false);
  const change = Math.max(0, (parseFloat(amountPaid) || 0) - total);
  const quickAmounts = [total, Math.ceil(total / 1000) * 1000, Math.ceil(total / 5000) * 5000, Math.ceil(total / 10000) * 10000]
    .filter((v, i, a) => a.indexOf(v) === i && v >= total).slice(0, 4);

  const handleConfirm = () => {
    setProcessing(true);
    setTimeout(() => {
      setProcessing(false);
      setDone(true);
      setTimeout(() => { onConfirm({ method, amountPaid: parseFloat(amountPaid) || total, change }); }, 1500);
    }, 800);
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-4">
      <div className="w-full max-w-md bg-zinc-900 rounded-3xl border border-zinc-800 shadow-2xl overflow-hidden">
        {done ? (
          <div className="p-8 text-center">
            <div className="w-20 h-20 rounded-full bg-emerald-500/20 flex items-center justify-center mx-auto mb-4">
              <svg width="40" height="40" fill="none" stroke="#34d399" strokeWidth="3" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>
            </div>
            <h3 className="text-xl font-bold text-zinc-100 mb-1">Sale Complete!</h3>
            <p className="text-zinc-500">Transaction recorded successfully</p>
            {method === "cash" && change > 0 && (
              <div className="mt-4 bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4">
                <p className="text-sm text-emerald-400">Change Due</p>
                <p className="text-3xl font-bold text-emerald-400">{formatUGX(change)}</p>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between p-5 border-b border-zinc-800">
              <h3 className="text-lg font-bold text-zinc-100">Complete Payment</h3>
              <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">
                <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div className="p-5 text-center bg-zinc-800/30">
              <p className="text-sm text-zinc-500 uppercase tracking-wider">Amount Due</p>
              <p className="text-4xl font-bold text-amber-400 mt-1" style={{ fontFamily: "'DM Sans', sans-serif" }}>{formatUGX(total)}</p>
              <p className="text-sm text-zinc-500 mt-1">{cart.length} items in cart</p>
            </div>
            <div className="p-5 space-y-4">
              <div className="flex gap-2">
                {[{ id: "cash", label: "Cash", icon: "💵" }, { id: "momo", label: "MoMo", icon: "📱" }, { id: "credit", label: "Credit", icon: "📝" }].map(m => (
                  <button key={m.id} onClick={() => setMethod(m.id)}
                    className={`flex-1 flex flex-col items-center gap-1 p-3 rounded-xl border-2 transition-all ${
                      method === m.id ? "border-amber-500 bg-amber-500/10 text-amber-400" : "border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-600"
                    }`}><span className="text-xl">{m.icon}</span><span className="text-xs font-medium">{m.label}</span></button>
                ))}
              </div>
              {method === "cash" && (
                <div>
                  <label className="text-xs text-zinc-500 mb-2 block uppercase tracking-wider">Amount Received</label>
                  <input type="number" value={amountPaid} onChange={e => setAmountPaid(e.target.value)} placeholder={total.toString()}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-3 text-2xl text-center text-zinc-100 font-bold focus:outline-none focus:border-amber-500 transition-all font-mono" />
                  <div className="flex gap-2 mt-3">
                    {quickAmounts.map(a => (
                      <button key={a} onClick={() => setAmountPaid(a.toString())}
                        className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
                          amountPaid === a.toString() ? "bg-amber-500/20 text-amber-400 border border-amber-500/30" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 border border-zinc-700"
                        }`}>{a >= 1000 ? `${(a/1000).toFixed(0)}K` : a}</button>
                    ))}
                  </div>
                  {amountPaid && parseFloat(amountPaid) >= total && (
                    <div className="mt-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-3 text-center">
                      <span className="text-sm text-emerald-400">Change: </span>
                      <span className="text-lg font-bold text-emerald-400">{formatUGX(change)}</span>
                    </div>
                  )}
                </div>
              )}
              <button onClick={handleConfirm} disabled={processing || (method === "cash" && amountPaid && parseFloat(amountPaid) < total)}
                className={`w-full py-4 rounded-xl font-bold text-lg transition-all active:scale-95 ${
                  processing ? "bg-zinc-700 text-zinc-400 cursor-wait" : "bg-gradient-to-r from-amber-500 to-orange-500 text-zinc-900 hover:from-amber-400 hover:to-orange-400 shadow-lg shadow-amber-500/20"
                }`}>{processing ? "Processing..." : "Confirm Payment"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── AI Camera Scanner Modal ──────────────────────────────────

function CameraScanModal({ products, onProductFound, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [stream, setStream] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [capturedImage, setCapturedImage] = useState(null);
  const [cameraReady, setCameraReady] = useState(false);

  // Build product catalog for AI context
  const productCatalog = products.map(p => {
    const pricePart = p.type === "weight" ? `${p.pricePerKg}/kg` : p.type === "piece" ? `${p.pricePerPiece}/piece` : p.type === "variant" ? `variants` : `${p.price}`;
    return `${p.id}: ${p.name} (${p.type}, ${p.category}, ${pricePart})`;
  }).join("\n");

  useEffect(() => {
    let mounted = true;
    const startCamera = async () => {
      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        if (mounted && videoRef.current) {
          videoRef.current.srcObject = mediaStream;
          setStream(mediaStream);
          setCameraReady(true);
        }
      } catch (err) {
        if (mounted) setError("Camera access denied. Please allow camera permission.");
      }
    };
    startCamera();
    return () => {
      mounted = false;
      if (stream) stream.getTracks().forEach(t => t.stop());
    };
  }, []);

  const stopCamera = () => {
    if (stream) stream.getTracks().forEach(t => t.stop());
  };

  const captureAndIdentify = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0);

    const imageData = canvas.toDataURL("image/jpeg", 0.8);
    setCapturedImage(imageData);
    setScanning(true);
    setResult(null);
    setError(null);

    try {
      const base64 = imageData.split(",")[1];

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: base64 }
              },
              {
                type: "text",
                text: `You are a product identification system for a retail shop POS in Uganda. Look at this image and identify what product/food item it is.

Here are the products available in our shop inventory:
${productCatalog}

INSTRUCTIONS:
1. Look at the image carefully - it may show items in a clear polythene bag (cavera), on a scale, loose, or packaged.
2. Identify what the product is (sugar, beans, rice, irish potatoes, groundnuts, onions, tomatoes, maize flour, eggs, etc.)
3. Match it to the closest product ID from the inventory list above.
4. If you can estimate the weight or quantity from the image, include that.

Respond ONLY with this exact JSON format, no other text:
{"product_id": "W001", "product_name": "Sugar (Loose)", "confidence": "high", "estimated_weight_kg": 1.0, "estimated_pieces": null, "notes": "White granulated sugar in clear cavera bag, approximately 1kg"}

If confidence is low or you cannot identify: {"product_id": null, "product_name": null, "confidence": "low", "notes": "reason"}`
              }
            ]
          }]
        })
      });

      const data = await response.json();
      const text = data.content?.map(c => c.text || "").join("") || "";
      const clean = text.replace(/```json|```/g, "").trim();

      try {
        const parsed = JSON.parse(clean);
        setResult(parsed);

        if (parsed.product_id && parsed.confidence !== "low") {
          const matchedProduct = products.find(p => p.id === parsed.product_id);
          if (matchedProduct) {
            setResult({ ...parsed, matched: matchedProduct });
          }
        }
      } catch {
        setError("Could not parse AI response. Try again.");
      }
    } catch (err) {
      setError("Failed to connect to AI. Check your internet connection.");
    }

    setScanning(false);
  };

  const handleConfirmProduct = () => {
    if (result?.matched) {
      stopCamera();
      onProductFound(result.matched, result.estimated_weight_kg, result.estimated_pieces);
    }
  };

  const handleRetake = () => {
    setCapturedImage(null);
    setResult(null);
    setError(null);
  };

  const handleClose = () => {
    stopCamera();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 bg-black/80 backdrop-blur-sm z-10">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center">
            <span className="text-sm">🤖</span>
          </div>
          <div>
            <h3 className="text-sm font-bold text-white">Smart Scanner</h3>
            <p className="text-xs text-zinc-400">AI Product Detection</p>
          </div>
        </div>
        <button onClick={handleClose} className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-300 hover:bg-zinc-700">
          <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>

      {/* Camera View */}
      <div className="flex-1 relative overflow-hidden bg-black">
        {!capturedImage ? (
          <>
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
            {/* Scanning overlay frame */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-64 h-64 relative">
                <div className="absolute top-0 left-0 w-10 h-10 border-t-4 border-l-4 border-cyan-400 rounded-tl-2xl" />
                <div className="absolute top-0 right-0 w-10 h-10 border-t-4 border-r-4 border-cyan-400 rounded-tr-2xl" />
                <div className="absolute bottom-0 left-0 w-10 h-10 border-b-4 border-l-4 border-cyan-400 rounded-bl-2xl" />
                <div className="absolute bottom-0 right-0 w-10 h-10 border-b-4 border-r-4 border-cyan-400 rounded-br-2xl" />
                {cameraReady && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <p className="text-cyan-300 text-sm font-medium bg-black/50 px-3 py-1 rounded-full">
                      Point at product
                    </p>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <img src={capturedImage} className="w-full h-full object-cover" alt="Captured" />
        )}

        {/* Scanning animation overlay */}
        {scanning && (
          <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center">
            <div className="w-16 h-16 rounded-full border-4 border-cyan-400 border-t-transparent animate-spin mb-4" />
            <p className="text-cyan-300 font-semibold text-lg">Identifying product...</p>
            <p className="text-zinc-400 text-sm mt-1">AI is analyzing the image</p>
          </div>
        )}
      </div>

      <canvas ref={canvasRef} className="hidden" />

      {/* Results / Actions Panel */}
      <div className="bg-zinc-900 border-t border-zinc-800 p-4 space-y-3">
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 flex items-center gap-2">
            <span className="text-red-400">⚠️</span>
            <p className="text-sm text-red-300 flex-1">{error}</p>
            <button onClick={handleRetake} className="text-xs text-red-400 underline">Retry</button>
          </div>
        )}

        {result && !error && (
          <div className={`rounded-xl p-4 border ${
            result.confidence === "high" ? "bg-emerald-500/10 border-emerald-500/30" :
            result.confidence === "medium" ? "bg-amber-500/10 border-amber-500/30" :
            "bg-red-500/10 border-red-500/30"
          }`}>
            {result.matched ? (
              <div className="flex items-center gap-3">
                <span className="text-3xl">{result.matched.image}</span>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-lg font-bold text-zinc-100">{result.matched.name}</p>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                      result.confidence === "high" ? "bg-emerald-500/20 text-emerald-400" : "bg-amber-500/20 text-amber-400"
                    }`}>{result.confidence === "high" ? "✓ Sure" : "~ Maybe"}</span>
                  </div>
                  <p className="text-sm text-zinc-400 mt-0.5">{result.notes}</p>
                  {result.estimated_weight_kg && (
                    <p className="text-sm text-cyan-400 mt-1 font-medium">Est. weight: ~{result.estimated_weight_kg}kg</p>
                  )}
                  {result.estimated_pieces && (
                    <p className="text-sm text-cyan-400 mt-1 font-medium">Est. count: ~{result.estimated_pieces} pieces</p>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-center">
                <p className="text-zinc-300 font-medium">Could not identify product</p>
                <p className="text-sm text-zinc-500 mt-1">{result.notes || "Try taking a clearer photo"}</p>
              </div>
            )}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex gap-3">
          {!capturedImage ? (
            <button onClick={captureAndIdentify} disabled={!cameraReady || scanning}
              className={`flex-1 py-4 rounded-2xl font-bold text-lg transition-all active:scale-95 flex items-center justify-center gap-2 ${
                cameraReady && !scanning
                  ? "bg-gradient-to-r from-cyan-500 to-blue-500 text-white shadow-lg shadow-cyan-500/30"
                  : "bg-zinc-800 text-zinc-500 cursor-not-allowed"
              }`}>
              <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/>
              </svg>
              {scanning ? "Scanning..." : "Snap & Identify"}
            </button>
          ) : (
            <>
              <button onClick={handleRetake}
                className="flex-1 py-4 rounded-2xl bg-zinc-800 text-zinc-300 font-bold text-lg hover:bg-zinc-700 active:scale-95 transition-all">
                ↻ Retake
              </button>
              {result?.matched && (
                <button onClick={handleConfirmProduct}
                  className="flex-1 py-4 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-bold text-lg shadow-lg shadow-emerald-500/30 active:scale-95 transition-all">
                  ✓ Add {result.matched.name}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function POSScreen({ products, cart, setCart, onComplete }) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");
  const [barcodeInput, setBarcodeInput] = useState("");
  const [weightModal, setWeightModal] = useState(null);
  const [pieceModal, setPieceModal] = useState(null);
  const [variantModal, setVariantModal] = useState(null);
  const [showCamera, setShowCamera] = useState(false);
  const [favourites] = useState(["W001", "PC01", "W003", "PC05", "V002", "V004"]);

  const addBarcodeProduct = useCallback((product) => {
    setCart(prev => {
      const key = product.id;
      const exists = prev.find(c => c.cartKey === key);
      if (exists) return prev.map(c => c.cartKey === key ? { ...c, qty: c.qty + 1, lineTotal: (c.qty + 1) * c.unitPrice } : c);
      return [...prev, { cartKey: key, id: product.id, name: product.name, image: product.image, qty: 1, unitPrice: product.price, lineTotal: product.price, unit: product.unit, type: "barcode", cost: product.cost }];
    });
  }, [setCart]);

  const addWeightProduct = (product, weight, total) => {
    const key = `${product.id}_${Date.now()}`;
    setCart(prev => [...prev, { cartKey: key, id: product.id, name: `${product.name} (${weight}kg)`, image: product.image, qty: 1, unitPrice: total, lineTotal: total, unit: `${weight}kg`, type: "weight", weight, cost: product.cost * weight }]);
    setWeightModal(null);
  };

  const addPieceProduct = (product, count, total) => {
    setCart(prev => {
      const key = product.id;
      const exists = prev.find(c => c.cartKey === key);
      if (exists) { const newQty = exists.qty + count; return prev.map(c => c.cartKey === key ? { ...c, qty: newQty, lineTotal: newQty * c.unitPrice } : c); }
      return [...prev, { cartKey: key, id: product.id, name: product.name, image: product.image, qty: count, unitPrice: product.pricePerPiece, lineTotal: total, unit: "pcs", type: "piece", cost: product.cost }];
    });
    setPieceModal(null);
  };

  const addVariantProduct = (product, variantIdx, qty, total) => {
    const variant = product.variants[variantIdx];
    const key = `${product.id}_v${variantIdx}`;
    setCart(prev => {
      const exists = prev.find(c => c.cartKey === key);
      if (exists) { const newQty = exists.qty + qty; return prev.map(c => c.cartKey === key ? { ...c, qty: newQty, lineTotal: newQty * c.unitPrice } : c); }
      return [...prev, { cartKey: key, id: product.id, name: `${product.name} — ${variant.label}`, image: product.image, qty, unitPrice: variant.price, lineTotal: total, unit: variant.unit, type: "variant", cost: product.cost }];
    });
    setVariantModal(null);
  };

  const handleProductTap = (product) => {
    switch (product.type) {
      case "barcode": addBarcodeProduct(product); break;
      case "weight": setWeightModal(product); break;
      case "piece": setPieceModal(product); break;
      case "variant": setVariantModal(product); break;
    }
  };

  // AI Camera identified a product
  const handleCameraProduct = (product, estWeight, estPieces) => {
    setShowCamera(false);
    // Auto-open the right modal based on product type
    switch (product.type) {
      case "weight": setWeightModal(product); break;
      case "piece": setPieceModal(product); break;
      case "variant": setVariantModal(product); break;
      case "barcode": addBarcodeProduct(product); break;
    }
  };

  const handleBarcodeScan = () => {
    if (!barcodeInput.trim()) return;
    const found = products.find(p => p.barcode === barcodeInput.trim());
    if (found) {
      if (found.type === "variant") setVariantModal(found);
      else addBarcodeProduct(found);
      setBarcodeInput("");
    }
  };

  const updateQty = (cartKey, delta) => {
    setCart(prev => prev.map(c => {
      if (c.cartKey !== cartKey) return c;
      const newQty = Math.max(0, c.qty + delta);
      return { ...c, qty: newQty, lineTotal: newQty * c.unitPrice };
    }).filter(c => c.qty > 0));
  };

  const removeItem = (cartKey) => setCart(prev => prev.filter(c => c.cartKey !== cartKey));

  const filtered = products
    .filter(p => {
      if (activeCategory === "Favourites") return favourites.includes(p.id);
      if (activeCategory !== "All") return p.category === activeCategory;
      return true;
    })
    .filter(p => p.name.toLowerCase().includes(search.toLowerCase()) || (p.barcode && p.barcode.includes(search)) || p.id.toLowerCase().includes(search.toLowerCase()));

  const cartTotal = cart.reduce((sum, c) => sum + c.lineTotal, 0);
  const cartItemCount = cart.reduce((sum, c) => sum + c.qty, 0);

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 pb-2">
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-amber-500">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="12" y1="7" x2="12" y2="17"/></svg>
            </span>
            <input type="text" inputMode="numeric" value={barcodeInput} onChange={e => setBarcodeInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleBarcodeScan()} placeholder="Scan barcode..."
              className="w-full bg-zinc-800/80 border border-amber-500/30 rounded-xl pl-11 pr-4 py-3 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 transition-all font-mono" />
          </div>
          <button onClick={handleBarcodeScan} className="px-4 bg-amber-500 text-zinc-900 rounded-xl font-bold hover:bg-amber-400 active:scale-95 transition-all shadow-lg shadow-amber-500/20 text-sm">Scan</button>
          <button onClick={() => setShowCamera(true)} className="px-3 bg-gradient-to-br from-cyan-500 to-blue-600 text-white rounded-xl font-bold hover:from-cyan-400 hover:to-blue-500 active:scale-95 transition-all shadow-lg shadow-cyan-500/20 flex items-center gap-1" title="AI Camera">
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
            <span className="text-xs">AI</span>
          </button>
        </div>
      </div>

      <div className="px-4 pb-2">
        <SearchInput value={search} onChange={setSearch} placeholder="Search products by name..." />
      </div>

      <div className="px-4 pb-2 overflow-x-auto">
        <div className="flex gap-2 min-w-max">
          {ALL_CATEGORIES.map(cat => (
            <button key={cat} onClick={() => setActiveCategory(cat)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
                activeCategory === cat
                  ? cat === "Favourites" ? "bg-red-500/20 text-red-400 border border-red-500/30" : "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                  : "bg-zinc-800/60 text-zinc-500 hover:text-zinc-300 border border-zinc-700/30"
              }`}>{cat === "Favourites" ? "⭐ Favourites" : cat}</button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-2">
        <div className="grid grid-cols-3 gap-2">
          {filtered.map(p => {
            const typeInfo = TYPE_LABELS[p.type];
            const inCart = cart.find(c => c.id === p.id);
            const priceDisplay = p.type === "weight" ? `${formatUGX(p.pricePerKg)}/kg`
              : p.type === "piece" ? `${formatUGX(p.pricePerPiece)}/pc`
              : p.type === "variant" ? `from ${formatUGX(Math.min(...p.variants.map(v => v.price)))}`
              : formatUGX(p.price);

            return (
              <button key={p.id} onClick={() => handleProductTap(p)}
                className={`relative flex flex-col items-center p-2.5 rounded-2xl border transition-all duration-200 active:scale-95 ${
                  inCart ? "bg-amber-500/10 border-amber-500/40" : "bg-zinc-800/40 border-zinc-700/20 hover:bg-zinc-800/70"
                }`}>
                <span className={`absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md text-xs font-semibold border ${typeInfo.color}`} style={{ fontSize: "9px" }}>{typeInfo.icon}</span>
                {inCart && <span className="absolute -top-1.5 -right-1.5 bg-amber-500 text-zinc-900 text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center shadow">{inCart.qty}</span>}
                <span className="text-2xl mb-1 mt-1">{p.image}</span>
                <span className="text-xs text-zinc-300 text-center leading-tight line-clamp-2 font-medium">{p.name}</span>
                <span className="text-xs text-amber-400 font-bold mt-0.5">{priceDisplay}</span>
              </button>
            );
          })}
        </div>
        {filtered.length === 0 && (
          <div className="text-center py-12"><span className="text-4xl mb-3 block">🔍</span><p className="text-zinc-500">No products found</p></div>
        )}
      </div>

      {cart.length > 0 && (
        <div className="border-t border-zinc-800 bg-zinc-900/95 backdrop-blur-sm">
          <div className="max-h-36 overflow-y-auto px-4 pt-3">
            {cart.map(item => (
              <div key={item.cartKey} className="flex items-center gap-2 mb-2 bg-zinc-800/50 rounded-xl px-3 py-2">
                <span className="text-base">{item.image}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-zinc-200 truncate font-medium">{item.name}</p>
                  <p className="text-xs text-zinc-500">{item.type === "weight" ? item.unit : `${formatUGX(item.unitPrice)} × ${item.qty}`}</p>
                </div>
                {item.type !== "weight" && (
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => updateQty(item.cartKey, -1)} className="w-6 h-6 rounded-md bg-zinc-700 text-zinc-300 flex items-center justify-center hover:bg-zinc-600 active:scale-90 text-sm font-bold">−</button>
                    <span className="text-amber-400 font-bold w-5 text-center text-sm">{item.qty}</span>
                    <button onClick={() => updateQty(item.cartKey, 1)} className="w-6 h-6 rounded-md bg-zinc-700 text-zinc-300 flex items-center justify-center hover:bg-zinc-600 active:scale-90 text-sm font-bold">+</button>
                  </div>
                )}
                <span className="text-sm text-zinc-200 font-semibold min-w-fit">{formatUGX(item.lineTotal)}</span>
                <button onClick={() => removeItem(item.cartKey)} className="text-red-400/50 hover:text-red-400 ml-0.5">
                  <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              </div>
            ))}
          </div>
          <div className="px-4 pb-4 pt-3 flex items-center gap-3">
            <div className="flex-1">
              <p className="text-xs text-zinc-500 uppercase tracking-wider">Total</p>
              <p className="text-2xl font-bold text-amber-400" style={{ fontFamily: "'DM Sans', sans-serif" }}>{formatUGX(cartTotal)}</p>
            </div>
            <button onClick={() => setCart([])} className="px-3 py-3 rounded-xl bg-zinc-800 text-zinc-400 font-medium hover:bg-zinc-700 active:scale-95 transition-all text-sm">Clear</button>
            <button onClick={onComplete} className="px-6 py-3 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 text-zinc-900 font-bold hover:from-amber-400 hover:to-orange-400 active:scale-95 transition-all shadow-lg shadow-amber-500/20 text-lg">Pay →</button>
          </div>
        </div>
      )}

      {weightModal && <WeightEntryModal product={weightModal} onAdd={(w, t) => addWeightProduct(weightModal, w, t)} onClose={() => setWeightModal(null)} />}
      {pieceModal && <PieceEntryModal product={pieceModal} onAdd={(c, t) => addPieceProduct(pieceModal, c, t)} onClose={() => setPieceModal(null)} />}
      {variantModal && <VariantModal product={variantModal} onAdd={(vi, q, t) => addVariantProduct(variantModal, vi, q, t)} onClose={() => setVariantModal(null)} />}
      {showCamera && <CameraScanModal products={products} onProductFound={handleCameraProduct} onClose={() => setShowCamera(false)} />}
    </div>
  );
}

function InventoryScreen({ products }) {
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("all");
  const [sortBy, setSortBy] = useState("name");

  const getStock = (p) => p.type === "variant" ? p.variants.reduce((s, v) => s + v.stock, 0) : p.stock;
  const getPrice = (p) => p.type === "weight" ? p.pricePerKg : p.type === "piece" ? p.pricePerPiece : p.type === "variant" ? p.variants[0]?.price || 0 : p.price;

  const filtered = products
    .filter(p => filterType === "all" || p.type === filterType)
    .filter(p => p.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => sortBy === "name" ? a.name.localeCompare(b.name) : sortBy === "stock-low" ? getStock(a) - getStock(b) : getPrice(b) - getPrice(a));

  const lowStockCount = products.filter(p => getStock(p) <= 10).length;
  const totalValue = products.reduce((s, p) => s + getPrice(p) * getStock(p), 0);

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-4 pb-2 grid grid-cols-3 gap-2">
        <div className="bg-zinc-800/60 rounded-xl p-3 border border-zinc-700/30">
          <p className="text-xs text-zinc-500">Products</p>
          <p className="text-xl font-bold text-zinc-100">{products.length}</p>
        </div>
        <div className="bg-zinc-800/60 rounded-xl p-3 border border-zinc-700/30">
          <p className="text-xs text-zinc-500">Stock Value</p>
          <p className="text-lg font-bold text-amber-400">{(totalValue / 1000000).toFixed(1)}M</p>
        </div>
        <div className={`rounded-xl p-3 border ${lowStockCount > 0 ? "bg-red-500/10 border-red-500/20" : "bg-emerald-500/10 border-emerald-500/20"}`}>
          <p className="text-xs text-zinc-500">Low Stock</p>
          <p className={`text-xl font-bold ${lowStockCount > 0 ? "text-red-400" : "text-emerald-400"}`}>{lowStockCount}</p>
        </div>
      </div>

      <div className="px-4 py-2 flex gap-2">
        <div className="flex-1"><SearchInput value={search} onChange={setSearch} placeholder="Search inventory..." /></div>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="bg-zinc-800 border border-zinc-700/50 rounded-xl px-2 py-2 text-xs text-zinc-300 focus:outline-none">
          <option value="name">A-Z</option><option value="stock-low">Stock ↑</option><option value="price">Price ↓</option>
        </select>
      </div>

      <div className="px-4 pb-2 flex gap-2 overflow-x-auto">
        {[{ id: "all", label: "All", icon: "📋" }, { id: "barcode", label: "Barcoded", icon: "📦" }, { id: "weight", label: "By Weight", icon: "⚖️" }, { id: "piece", label: "By Piece", icon: "🔢" }, { id: "variant", label: "Variants", icon: "📐" }].map(t => (
          <button key={t.id} onClick={() => setFilterType(t.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap flex items-center gap-1 ${
              filterType === t.id ? "bg-amber-500/20 text-amber-400 border border-amber-500/30" : "bg-zinc-800/60 text-zinc-500 border border-zinc-700/30 hover:text-zinc-300"
            }`}><span>{t.icon}</span> {t.label}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
        {filtered.map(p => {
          const typeInfo = TYPE_LABELS[p.type];
          const stock = getStock(p);
          return (
            <div key={p.id} className="bg-zinc-800/40 rounded-xl border border-zinc-700/30 p-3 flex items-center gap-3">
              <span className="text-2xl w-9 text-center">{p.image}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm text-zinc-200 font-medium truncate">{p.name}</p>
                  <span className={`px-1.5 py-0.5 rounded text-xs font-semibold border ${typeInfo.color}`} style={{ fontSize: "9px" }}>{typeInfo.icon} {typeInfo.label}</span>
                </div>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {p.type === "variant" ? p.variants.map(v => `${v.label}: ${v.stock}`).join(" · ") :
                   p.type === "weight" ? `${formatUGX(p.pricePerKg)}/kg · ${p.category}` :
                   p.type === "piece" ? `${formatUGX(p.pricePerPiece)}/pc · ${p.category}` :
                   `${formatUGX(p.price)} · ${p.category}`}
                </p>
              </div>
              <div className={`px-3 py-1.5 rounded-lg font-bold text-sm border ${stock <= 5 ? "bg-red-500/10 border-red-500/30 text-red-400" : stock <= 15 ? "bg-yellow-500/10 border-yellow-500/30 text-yellow-400" : "bg-zinc-700/50 border-zinc-600/30 text-zinc-300"}`}>
                {stock} {p.unit}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HistoryScreen({ sales }) {
  const todayTotal = sales.reduce((s, sale) => s + sale.total, 0);
  const todayProfit = sales.reduce((s, sale) => s + sale.items.reduce((p, i) => p + ((i.unitPrice - (i.cost || 0)) * i.qty), 0), 0);

  return (
    <div className="flex flex-col h-full">
      <div className="p-4">
        <div className="bg-gradient-to-br from-amber-500/10 to-orange-500/10 rounded-2xl border border-amber-500/20 p-5">
          <p className="text-xs text-amber-400/70 uppercase tracking-wider mb-1">Today's Sales</p>
          <p className="text-3xl font-bold text-amber-400" style={{ fontFamily: "'DM Sans', sans-serif" }}>{formatUGX(todayTotal)}</p>
          <div className="flex gap-4 mt-3">
            <div><p className="text-xs text-zinc-500">Transactions</p><p className="text-lg font-bold text-zinc-200">{sales.length}</p></div>
            <div><p className="text-xs text-zinc-500">Gross Profit</p><p className="text-lg font-bold text-emerald-400">{formatUGX(todayProfit)}</p></div>
            <div><p className="text-xs text-zinc-500">Avg. Sale</p><p className="text-lg font-bold text-zinc-200">{sales.length > 0 ? formatUGX(Math.round(todayTotal / sales.length)) : "—"}</p></div>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {sales.length === 0 ? (
          <div className="text-center py-16"><span className="text-5xl mb-4 block">🧾</span><p className="text-zinc-500">No sales yet today</p><p className="text-zinc-600 text-sm mt-1">Complete a sale to see it here</p></div>
        ) : (
          <div className="space-y-2">
            {[...sales].reverse().map((sale) => (
              <div key={sale.id} className="bg-zinc-800/40 rounded-xl border border-zinc-700/30 p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${sale.method === "cash" ? "bg-emerald-500/15 text-emerald-400" : sale.method === "momo" ? "bg-blue-500/15 text-blue-400" : "bg-orange-500/15 text-orange-400"}`}>
                      {sale.method === "cash" ? "💵 Cash" : sale.method === "momo" ? "📱 MoMo" : "📝 Credit"}
                    </span>
                    <span className="text-xs text-zinc-600">#{sale.id}</span>
                  </div>
                  <span className="text-xs text-zinc-500">{sale.time}</span>
                </div>
                <div className="space-y-1">
                  {sale.items.map((item, j) => (
                    <div key={j} className="flex justify-between text-sm">
                      <span className="text-zinc-400">{item.image} {item.name} {item.type !== "weight" ? `× ${item.qty}` : ""}</span>
                      <span className="text-zinc-300 font-medium">{formatUGX(item.lineTotal)}</span>
                    </div>
                  ))}
                </div>
                <div className="flex justify-between mt-2 pt-2 border-t border-zinc-700/30">
                  <span className="text-sm text-zinc-500">Total</span>
                  <span className="text-amber-400 font-bold">{formatUGX(sale.total)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LoginScreen({ onLogin }) {
  const [pin, setPin] = useState("");
  const [shake, setShake] = useState(false);
  const [user, setUser] = useState("Cashier");

  const handleKey = (k) => {
    if (k === "DEL") return setPin(p => p.slice(0, -1));
    if (k === "OK") {
      if (pin.length >= 4) onLogin({ name: user, role: user.toLowerCase() });
      else { setShake(true); setTimeout(() => setShake(false), 500); }
      return;
    }
    if (pin.length < 6) setPin(p => p + k);
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center p-6" style={{ background: "radial-gradient(ellipse at 50% 0%, rgba(245,158,11,0.08) 0%, rgba(9,9,11,1) 60%)" }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-gradient-to-br from-amber-500 to-orange-600 mb-4 shadow-lg shadow-amber-500/20"><span className="text-4xl">🏪</span></div>
          <h1 className="text-2xl font-bold text-zinc-100 tracking-tight" style={{ fontFamily: "'DM Sans', sans-serif" }}>RetailFlow</h1>
          <p className="text-zinc-500 text-sm mt-1">Point of Sale System</p>
        </div>
        <div className="flex gap-2 mb-6 bg-zinc-900/80 rounded-xl p-1 border border-zinc-800/50">
          {["Admin", "Manager", "Cashier"].map(u => (
            <button key={u} onClick={() => setUser(u)} className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${user === u ? "bg-amber-500/20 text-amber-400 border border-amber-500/30" : "text-zinc-500 hover:text-zinc-300"}`}>{u}</button>
          ))}
        </div>
        <div className={`flex justify-center gap-3 mb-8 ${shake ? "animate-bounce" : ""}`}>
          {[0,1,2,3].map(i => (
            <div key={i} className={`w-12 h-12 rounded-xl border-2 flex items-center justify-center transition-all ${i < pin.length ? "border-amber-500 bg-amber-500/10" : "border-zinc-700 bg-zinc-900/50"}`}>
              {i < pin.length && <div className="w-3 h-3 rounded-full bg-amber-400"/>}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-3">
          {["1","2","3","4","5","6","7","8","9","DEL","0","OK"].map(k => (
            <button key={k} onClick={() => handleKey(k)} className={`h-14 rounded-xl font-semibold text-lg transition-all active:scale-95 ${k === "OK" ? "bg-amber-500 text-zinc-900 hover:bg-amber-400 shadow-lg shadow-amber-500/20" : k === "DEL" ? "bg-zinc-800 text-zinc-400 hover:bg-zinc-700" : "bg-zinc-900 text-zinc-200 hover:bg-zinc-800 border border-zinc-800"}`}>
              {k === "DEL" ? "⌫" : k}
            </button>
          ))}
        </div>
        <p className="text-center text-zinc-600 text-xs mt-6">Enter any 4-digit PIN to continue</p>
      </div>
    </div>
  );
}

export default function RetailFlowPOS() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [user, setUser] = useState(null);
  const [activeTab, setActiveTab] = useState("pos");
  const { products, setProducts, loading, source, refreshProducts } = useProducts();
  const [cart, setCart] = useState([]);
  const [sales, setSales] = useState([]);
  const [showPayment, setShowPayment] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const { online, pendingCount, lastSync, syncing, setPendingCount } = useOnlineStatus();

  const cartTotal = cart.reduce((sum, c) => sum + c.lineTotal, 0);
  const cartCount = cart.reduce((sum, c) => sum + c.qty, 0);

  // Load sales from cache on startup
  useEffect(() => {
    const loadSales = async () => {
      try {
        const cached = await dbGetAll("syncedSales");
        if (cached.length > 0) setSales(cached);
      } catch (e) { /* ignore */ }

      // Also try from API
      if (api.isConfigured()) {
        const today = new Date().toISOString().split("T")[0];
        const result = await api.get("getSales", { date: today, limit: "200" });
        if (result && result.success) {
          setSales(result.sales);
          await dbClear("syncedSales");
          await dbPut("syncedSales", result.sales);
        }
      }
    };
    if (loggedIn) loadSales();
  }, [loggedIn]);

  const handleCompleteSale = async (paymentInfo) => {
    const offlineId = "OFF_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
    const now = new Date();
    const saleData = {
      offlineId,
      dateTime: now.toISOString(),
      items: cart.map(c => ({ ...c })),
      total: cartTotal,
      paymentMethod: paymentInfo.method,
      amountPaid: paymentInfo.amountPaid,
      change: paymentInfo.change,
      cashierId: user?.id || "",
      cashierName: user?.name || "",
    };

    // Add to local sales list for display
    const localSale = {
      id: offlineId,
      ...saleData,
      method: paymentInfo.method,
      time: now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
      date: now.toLocaleDateString(),
      synced: false,
    };
    setSales(prev => [...prev, localSale]);

    // Save to IndexedDB pending queue
    try {
      await dbPut("pendingSales", saleData);
      setPendingCount(prev => prev + 1);
    } catch (e) { /* continue */ }

    // Try immediate sync if online
    if (online && api.isConfigured()) {
      try {
        const result = await api.post("recordSale", saleData);
        if (result && result.success) {
          await dbDelete("pendingSales", offlineId);
          setPendingCount(prev => Math.max(0, prev - 1));
          // Update the sale in our list to show as synced
          setSales(prev => prev.map(s => s.id === offlineId ? { ...s, id: result.saleId, synced: true } : s));
        }
      } catch (e) { /* Will sync later */ }
    }

    setCart([]);
    setShowPayment(false);
  };

  // Manual sync trigger
  const handleManualSync = async () => {
    if (!online || !api.isConfigured()) return;
    const result = await syncPendingSales();
    if (result.synced > 0) {
      const remaining = await dbGetAll("pendingSales");
      setPendingCount(remaining.length);
    }
    await refreshProducts();
  };

  if (!loggedIn) return <LoginScreen onLogin={(u) => { setUser(u); setLoggedIn(true); }} />;

  const tabs = [
    { id: "pos", label: "Sell", icon: <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="12" y1="7" x2="12" y2="17"/></svg> },
    { id: "inventory", label: "Stock", icon: <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg> },
    { id: "history", label: "Sales", icon: <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="9"/></svg> },
  ];

  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-100 overflow-hidden" style={{ background: "linear-gradient(180deg, rgba(24,24,27,1) 0%, rgba(9,9,11,1) 100%)" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet" />

      {/* Header with Sync Status */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-lg shadow-amber-500/10"><span className="text-lg">🏪</span></div>
          <div>
            <h1 className="text-sm font-bold text-zinc-100 leading-none" style={{ fontFamily: "'DM Sans', sans-serif" }}>RetailFlow</h1>
            <p className="text-xs text-zinc-500 leading-none mt-0.5">{user?.name} • {new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Connection & Sync Status */}
          <button onClick={handleManualSync} className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-zinc-800 transition-all" title={online ? "Online" : "Offline"}>
            {/* Online/Offline dot */}
            <span className={`w-2 h-2 rounded-full ${online ? "bg-emerald-400 shadow shadow-emerald-400/50" : "bg-red-400 shadow shadow-red-400/50"} ${syncing ? "animate-pulse" : ""}`} />

            {/* Pending sync count */}
            {pendingCount > 0 && (
              <span className="flex items-center gap-0.5 text-xs text-amber-400 font-medium">
                <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" className={syncing ? "animate-spin" : ""}><path d="M21 12a9 9 0 11-6.219-8.56"/></svg>
                {pendingCount}
              </span>
            )}

            {/* Data source badge */}
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
              source === "api" ? "bg-emerald-500/15 text-emerald-400" :
              source === "cache" ? "bg-blue-500/15 text-blue-400" :
              "bg-zinc-700 text-zinc-400"
            }`}>
              {source === "api" ? "Live" : source === "cache" ? "Cached" : "Demo"}
            </span>
          </button>

          {/* Settings */}
          <button onClick={() => setShowSettings(!showSettings)} className="text-zinc-500 hover:text-zinc-300 p-1 rounded-lg hover:bg-zinc-800 transition-all">
            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
          </button>

          <button onClick={() => { setLoggedIn(false); setUser(null); setCart([]); }} className="text-xs text-zinc-500 hover:text-red-400 transition-colors px-2 py-1.5 rounded-lg hover:bg-red-500/10">Out</button>
        </div>
      </header>

      {/* Offline Banner */}
      {!online && (
        <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 flex items-center gap-2">
          <span className="text-amber-400 text-sm">⚡</span>
          <p className="text-xs text-amber-300 flex-1">You're offline — sales are saved locally and will sync when internet returns</p>
          {pendingCount > 0 && <span className="text-xs font-bold text-amber-400">{pendingCount} pending</span>}
        </div>
      )}

      {/* Settings Dropdown */}
      {showSettings && (
        <div className="absolute right-4 top-14 z-40 w-72 bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl p-4 space-y-3">
          <h3 className="text-sm font-bold text-zinc-200">Settings</h3>

          <div>
            <label className="text-xs text-zinc-500 block mb-1">API URL (Apps Script Web App)</label>
            <div className="bg-zinc-800 rounded-lg p-2 text-xs text-zinc-400 font-mono break-all">
              {API_URL || "Not configured — using demo mode"}
            </div>
            <p className="text-xs text-zinc-600 mt-1">Set API_URL in the code to connect to your Google Sheet</p>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400">Connection</span>
            <span className={`text-xs font-medium ${online ? "text-emerald-400" : "text-red-400"}`}>{online ? "Online" : "Offline"}</span>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400">Data Source</span>
            <span className="text-xs font-medium text-zinc-300">{source === "api" ? "Live (Google Sheets)" : source === "cache" ? "Cached (IndexedDB)" : "Demo Data"}</span>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400">Pending Sales</span>
            <span className={`text-xs font-medium ${pendingCount > 0 ? "text-amber-400" : "text-emerald-400"}`}>{pendingCount > 0 ? `${pendingCount} awaiting sync` : "All synced ✓"}</span>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-400">Device ID</span>
            <span className="text-xs text-zinc-500 font-mono">{DEVICE_ID}</span>
          </div>

          <div className="flex gap-2 pt-2 border-t border-zinc-800">
            <button onClick={() => { handleManualSync(); setShowSettings(false); }}
              className="flex-1 py-2 rounded-lg bg-amber-500/20 text-amber-400 text-xs font-medium hover:bg-amber-500/30 transition-all">
              ↻ Sync Now
            </button>
            <button onClick={() => setShowSettings(false)}
              className="flex-1 py-2 rounded-lg bg-zinc-800 text-zinc-400 text-xs font-medium hover:bg-zinc-700 transition-all">
              Close
            </button>
          </div>
        </div>
      )}

      {/* Loading indicator */}
      {loading && (
        <div className="flex items-center justify-center py-8">
          <div className="w-8 h-8 border-3 border-amber-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Content */}
      <main className="flex-1 overflow-hidden">
        {activeTab === "pos" && <POSScreen products={products} cart={cart} setCart={setCart} onComplete={() => setShowPayment(true)} />}
        {activeTab === "inventory" && <InventoryScreen products={products} />}
        {activeTab === "history" && <HistoryScreen sales={sales} />}
      </main>

      <nav className="flex border-t border-zinc-800/50 bg-zinc-950/95 backdrop-blur-sm px-2 pb-1 pt-1">
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`flex-1 flex flex-col items-center py-2 gap-0.5 transition-all relative ${activeTab === tab.id ? "text-amber-400" : "text-zinc-600 hover:text-zinc-400"}`}>
            {activeTab === tab.id && <div className="absolute -top-1 w-8 h-0.5 rounded-full bg-amber-400" />}
            {tab.icon}
            <span className="text-xs font-medium">{tab.label}</span>
            {tab.id === "pos" && cartCount > 0 && <span className="absolute top-1 right-1/4 bg-amber-500 text-zinc-900 text-xs font-bold rounded-full w-4 h-4 flex items-center justify-center">{cartCount}</span>}
          </button>
        ))}
      </nav>

      {showPayment && <PaymentModal cart={cart} total={cartTotal} onClose={() => setShowPayment(false)} onConfirm={handleCompleteSale} />}
    </div>
  );
}
