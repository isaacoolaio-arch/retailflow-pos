# RetailFlow POS — Complete Setup Guide
## Get Your Shop Running in 30 Minutes

---

## WHAT YOU'RE SETTING UP

```
┌──────────────────────────────────────────┐
│         YOUR PHONE (Frontend)            │
│  ┌────────────────────────────────────┐  │
│  │    RetailFlow POS App (PWA)        │  │
│  │    • Sell screen + barcode scan    │  │
│  │    • AI camera detection           │  │
│  │    • Offline mode (IndexedDB)      │  │
│  │    • Auto-sync when online         │  │
│  └────────────┬───────────────────────┘  │
└───────────────┼──────────────────────────┘
                │ Internet (when available)
┌───────────────┼──────────────────────────┐
│  GOOGLE SHEETS (Backend + Database)      │
│  ┌────────────┴───────────────────────┐  │
│  │    Apps Script Web App (API)       │  │
│  │    • Products, Sales, Users data   │  │
│  │    • Sync engine                   │  │
│  │    • Auto stock deduction          │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

---

## STEP 1: CREATE GOOGLE SHEETS BACKEND (10 min)

### 1.1 Create a New Google Sheet
1. Go to **sheets.google.com**
2. Click **+ Blank** spreadsheet
3. Name it: **RetailFlow POS**

### 1.2 Add the Backend Code
1. Click **Extensions** → **Apps Script**
2. Delete everything in the editor
3. Copy ALL contents from **Code.gs** file I gave you
4. Paste into the editor
5. Click **💾 Save** (Ctrl+S)
6. Name the project: **RetailFlow Backend**

### 1.3 Run Auto Setup
1. In the Apps Script editor, find the function dropdown (top bar)
2. Select **autoSetup**
3. Click **▶ Run**
4. First time: Click **Review permissions** → Choose your Google account → **Allow**
5. Wait for the alert: "Setup Complete! ✅"

This creates 5 sheets with sample data:
- **Users** — 3 default users (Admin/1234, Manager/5678, Cashier/0000)
- **Products** — Sample products (barcoded, weight, piece, variant)
- **Sales** — Empty (will fill as you sell)
- **SyncLog** — Tracks all sync activity
- **Config** — Shop settings

### 1.4 Deploy as Web App (API)
1. Click **Deploy** → **New deployment**
2. Click the ⚙️ gear icon → Select **Web app**
3. Settings:
   - Description: `RetailFlow POS API`
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click **Deploy**
5. **COPY THE URL** — it looks like:
   ```
   https://script.google.com/macros/s/AKfycb...long-string.../exec
   ```
6. **Save this URL** — you'll need it for the frontend!

---

## STEP 2: SET UP THE FRONTEND (10 min)

### Option A: Quick Start (GitHub Pages — FREE)

#### 2A.1 Create GitHub Repository
1. Go to **github.com** and sign in (create account if needed)
2. Click **+ New repository**
3. Name: `retailflow-pos`
4. Make it **Public**
5. Check **Add a README file**
6. Click **Create repository**

#### 2A.2 Upload the Frontend Files
1. In your new repo, click **Add file** → **Upload files**
2. Create these files:

**index.html** (create this file):
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>RetailFlow POS</title>
    <meta name="description" content="RetailFlow Point of Sale System">
    <meta name="theme-color" content="#18181b">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <link rel="manifest" href="manifest.json">
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏪</text></svg>">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.9/babel.min.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-zinc-950">
    <div id="root"></div>
    <script type="text/babel" src="RetailPOS.jsx"></script>
    <script type="text/babel">
        ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(RetailFlowPOS));
    </script>
    <script>
        // Register Service Worker for offline support
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js')
                .then(reg => console.log('SW registered:', reg.scope))
                .catch(err => console.log('SW failed:', err));
        }
    </script>
</body>
</html>
```

**manifest.json** (for PWA — "install as app"):
```json
{
    "name": "RetailFlow POS",
    "short_name": "RetailFlow",
    "description": "Point of Sale System for Retail Shops",
    "start_url": "/retailflow-pos/",
    "display": "standalone",
    "background_color": "#09090b",
    "theme_color": "#f59e0b",
    "orientation": "portrait",
    "icons": [
        {
            "src": "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏪</text></svg>",
            "sizes": "any",
            "type": "image/svg+xml"
        }
    ]
}
```

**sw.js** (Service Worker for offline):
```javascript
const CACHE_NAME = 'retailflow-v1';
const ASSETS = [
    './',
    './index.html',
    './RetailPOS.jsx',
    './manifest.json',
    'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.9/babel.min.js',
    'https://cdn.tailwindcss.com',
    'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', event => {
    // Network first for API calls
    if (event.request.url.includes('script.google.com') || event.request.url.includes('api.anthropic.com')) {
        event.respondWith(
            fetch(event.request).catch(() => caches.match(event.request))
        );
        return;
    }
    // Cache first for assets
    event.respondWith(
        caches.match(event.request).then(cached => cached || fetch(event.request))
    );
});
```

3. Upload **RetailPOS.jsx** (the file I gave you)
4. Commit the files

#### 2A.3 Enable GitHub Pages
1. Go to repo **Settings** → **Pages**
2. Source: **Deploy from a branch**
3. Branch: **main** / **(root)**
4. Click **Save**
5. Wait 2-3 minutes
6. Your URL: `https://YOUR_USERNAME.github.io/retailflow-pos/`

### 2A.4 Connect to Backend
1. Open **RetailPOS.jsx** in your GitHub repo
2. Click the ✏️ edit button
3. Find this line at the top:
   ```javascript
   const API_URL = "";
   ```
4. Replace with your Apps Script URL:
   ```javascript
   const API_URL = "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec";
   ```
5. Commit the change
6. Wait 1-2 minutes for GitHub Pages to rebuild

---

## STEP 3: OPEN ON YOUR PHONE (2 min)

### 3.1 Open in Browser
1. Open **Chrome** on your phone
2. Go to: `https://YOUR_USERNAME.github.io/retailflow-pos/`
3. The POS should load!

### 3.2 Install as App (Add to Home Screen)
**Android:**
1. In Chrome, tap the **⋮** menu (3 dots)
2. Tap **"Add to Home Screen"** or **"Install app"**
3. Name it: **RetailFlow**
4. Tap **Add**
5. Now you have an app icon on your phone!

**iPhone:**
1. In Safari, tap the **Share** icon (square with arrow)
2. Scroll down, tap **"Add to Home Screen"**
3. Tap **Add**

### 3.3 Test Login
- Admin: PIN **1234**
- Manager: PIN **5678**
- Cashier: PIN **0000**

---

## STEP 4: ADD YOUR REAL PRODUCTS (15 min)

### Option A: Directly in Google Sheets
1. Open your **RetailFlow POS** spreadsheet
2. Go to the **Products** sheet
3. Edit/add rows following this structure:

**For Barcoded Products** (Coca Cola, Soap, etc.):
| ProductID | Type | Barcode | Name | Category | Price | PricePerKg | PricePerPiece | Cost | Stock | Unit | Image |
|-----------|------|---------|------|----------|-------|------------|---------------|------|-------|------|-------|
| P010 | barcode | 8901234567XX | Product Name | Category | 2500 | | | 1800 | 50 | bottle | 🥤 |

**For Weight Products** (Sugar, Beans, Potatoes):
| ProductID | Type | Barcode | Name | Category | Price | PricePerKg | PricePerPiece | Cost | Stock | Unit | Image | MinWeight | WeightStep |
|-----------|------|---------|------|----------|-------|------------|---------------|------|-------|------|-------|-----------|------------|
| W010 | weight | | Sugar (Loose) | Grocery | | 5000 | | 3800 | 100 | kg | 🍚 | 0.25 | 0.25 |

**For Piece Products** (Eggs, Chapati):
| ProductID | Type | Barcode | Name | Category | Price | PricePerKg | PricePerPiece | Cost | Stock | Unit | Image |
|-----------|------|---------|------|----------|-------|------------|---------------|------|-------|------|-------|
| PC10 | piece | | Eggs (per piece) | Dairy | | | 500 | 350 | 300 | pcs | 🥚 |

**For Variant Products** (Oil, Royco):
| ProductID | Type | Barcode | Name | Category | ... | Variants |
|-----------|------|---------|------|----------|-----|----------|
| V010 | variant | | Cooking Oil | Grocery | ... | [{"label":"Small (250ml)","price":3000,"stock":25,"unit":"pc"},{"label":"Large (1L)","price":10000,"stock":12,"unit":"pc"}] |

### Option B: Through the API
Products can also be added through the frontend (coming in the next update with Product Management screen).

---

## HOW OFFLINE MODE WORKS

```
SCENARIO 1: Normal (Online)
─────────────────────────────
Customer buys items → Sale recorded
  ├─→ Saved to IndexedDB (instant)
  ├─→ Sent to Google Sheets (API)
  └─→ Stock deducted in Sheets
Status: 🟢 Green dot, "Live" badge

SCENARIO 2: Internet Drops
─────────────────────────────
Customer buys items → Sale recorded
  ├─→ Saved to IndexedDB (instant) ✅
  ├─→ API call fails (no internet) ❌
  └─→ Sale queued in "pendingSales"
Status: 🔴 Red dot, "1 pending"
Banner: "You're offline — sales saved locally"

SCENARIO 3: Internet Returns
─────────────────────────────
Connection restored → Auto-sync triggers
  ├─→ All pending sales sent to Sheets
  ├─→ Stock deducted for each sale
  ├─→ Products refreshed from Sheets
  └─→ Pending queue cleared
Status: 🟢 Green dot, "All synced ✓"

SCENARIO 4: Extended Offline (hours/days)
─────────────────────────────
Products loaded from IndexedDB cache
All sales queue locally (unlimited)
When online: batch sync sends ALL at once
No data loss, guaranteed.
```

---

## DEFAULT LOGIN CREDENTIALS

| Role | Username | PIN |
|------|----------|-----|
| Admin | Admin | 1234 |
| Manager | Manager | 5678 |
| Cashier | Cashier | 0000 |

Change these in the **Users** sheet in your Google Spreadsheet.

---

## TROUBLESHOOTING

### "Products not loading"
- Check if API_URL is set correctly in RetailPOS.jsx
- Verify Apps Script is deployed as Web App
- Check: Anyone can access the web app
- Test API: open `YOUR_API_URL?action=ping` in browser — should show `{"status":"ok"}`

### "Sales not syncing"
- Check internet connection
- Look for the sync indicator (top right of header)
- Tap the sync button to force manual sync
- Check SyncLog sheet in Google Sheets for errors

### "Camera/AI scan not working"
- Camera only works on HTTPS (GitHub Pages provides this)
- Allow camera permission when prompted
- AI scan requires internet (uses Claude API)
- Make sure the page is loaded via HTTPS, not HTTP

### "App not installing on home screen"
- Must be loaded via HTTPS
- manifest.json must be accessible
- Try clearing browser cache and reloading

---

## NEXT STEPS (Future Updates)

Once the base system is running, we can add:
1. ☐ Product Management screen (add/edit/delete from app)
2. ☐ Receipt generation (shareable via WhatsApp)
3. ☐ Daily/weekly/monthly reports
4. ☐ Multi-user shift management
5. ☐ Supplier & purchase tracking
6. ☐ Customer credit/debt management
7. ☐ Barcode label printing
8. ☐ Multi-branch support

---

**Your RetailFlow POS system is ready! 🏪🚀**
