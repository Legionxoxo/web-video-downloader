# Per-Site History via Google Sheets — Plan

## Context

Scraping 3 websites with this Chrome extension:
1. `https://www.keyframe.gallery/` (fully downloaded — history exists)
2. `https://framerate.tv/explore?tab=videos` (fully downloaded — history exists)
3. `https://before.click/` (nothing scraped yet)

**Problem with chrome.storage.local**: Can't transfer to another PC or share with others. Lose PC = lose history.

**Solution**: Use a Google Sheet as shared history backend.

---

## Architecture

```
[Extension on any PC] ←→ [Google Apps Script Web App] ←→ [Google Sheet]
                         https://script.google.com/...
```

---

## Issues

### 1. Chrome Extension Folder is Read-Only
Extensions can't write to their own folder after installation. We can't save JSON files directly in the extension directory.

**Workaround**: Use Google Sheet as the persistent store. Extension folder only holds code, not data.

### 2. Multiple Devices Need Shared History
If user works on PC A and PC B, both need to know what was downloaded on the other.

**Workaround**: Both PCs read/write to the same Google Sheet. Single source of truth.

### 3. Existing History Needs Migration
`history_seed.json` and `chrome.storage.local` already contain ~1500 downloaded video entries.

**Workaround**: First time setup, user populates the Google Sheet from existing history_seed.json (one-time manual import or a "Seed from file" button).

### 4. Google Sheet Rate Limits
Sheets API allows ~100 writes/minute per sheet.

**Workaround**: We only write once per video download (not per segment). This is well within limits.

### 5. Site Detection Without Content Script Changes
The content script runs on all URLs. We need to know which of the 3 sites we're on purely in the popup.

**Workaround**: Use `chrome.tabs.query({ active: true })` to get the current tab's URL. Detect site from hostname.

---

## Implementation

### Step 1 — Create Google Sheet

**Why the original schema was wrong:** Title+company is not a reliable dedup key. Two different videos on different sites could share the same title, or even on the same site over time. We need to use the actual content ID from each page.

**What each site gives us for unique identification:**

| Site | Content Type | Unique ID Source | Notes |
|---|---|---|---|
| `keyframe.gallery` | Video | `video_id` from `phx-value-video_id="374"` | |
| `framerate.tv` | Video | URL slug `/watch/eb0e1d3b-83e4-433c-a38a-558bb411e100` | Path after `/watch/` |
| `before.click` | App | URL slug `/explore?app=unwind` | One row per app (covers all screenshots) |

**Corrected Sheet columns:** `site`, `content_type`, `unique_id`, `title`, `creator`, `downloaded_at`, `url`

Example rows:
| site | content_type | unique_id | title | creator | downloaded_at | url |
|---|---|---|---|---|---|---|
| keyframe | video | 374 | FAUNA Text to Visual Generation | FLORA © | 2026-04-02T... | https://www.keyframe.gallery/... |
| framerate | video | eb0e1d3b-83e4-433c-a38a-558bb411e100 | SHOWREEL 2025 | fafa Zhu | 2026-04-02T... | https://framerate.tv/watch/eb0e1d3b... |
| before | app | unwind | Unwind | — | 2026-04-02T... | https://before.click/explore?app=unwind |

**Dedup key:** `site + unique_id` (composite, not title)

### Step 2 — Create Google Apps Script

Extensions → Apps Script → new project

```javascript
const SHEET_ID = '1y3qsr-MUZKWDLyVzhNVmPaf1dPBgo1Xb6_IbeI3lUFk';

function doGet(e) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getActiveSheet();
  const rows = sheet.getDataRange().getValues();
  const siteFilter = e.parameter.site;

  let data = rows.slice(1).map(row => ({
    site: row[0],
    content_type: row[1],
    unique_id: row[2],
    title: row[3],
    creator: row[4],
    downloaded_at: row[5],
    url: row[6]
  }));

  if (siteFilter) {
    data = data.filter(r => r.site === siteFilter);
  }

  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getActiveSheet();
  const { site, content_type, unique_id, title, creator, url } = JSON.parse(e.postData.contents);
  sheet.appendRow([site, content_type, unique_id, title, creator, new Date().toISOString(), url]);
  return ContentService.createTextOutput('ok');
}
```

### Step 3 — Deploy Apps Script as Web App

- Click Deploy → New deployment
- Type: Web App
- Execute as: Me
- Access: Anyone
- Copy the URL (looks like `https://script.google.com/macros/s/ABCD.../exec`)

### Step 4 — Update popup.js

**SHEET_URL is already set** to `https://script.google.com/macros/s/AKfycbw_e6kNjE9xvqS_yBP4xd8EnP2ipf8opNt2rbwP1oZiaWN4lkogVe0AhhGZf6_3A4Hl5w/exec` in popup.js — no changes needed unless you deploy your own Apps Script.

### Step 5 — Update popup.html

Add:
- Site indicator (shows "keyframe" / "framerate" / "before" based on current tab)
- "Sync Now" button that calls `syncFromSheet(currentSite)`

---

## Data Flow

```
[Extension starts]
    │
    ▼
[Get current tab URL] → getSiteFromUrl()
    │
    ▼
[syncFromSheet(site)] → GET sheet URL
    │
    ▼
[Sheet returns all rows for this site]
    │
    ▼
[Populate downloadHistory Map: `${site}_${uniqueId}` → metadata]
    │
    ▼
[UI shows content items with ✓ on already-downloaded]

[User clicks Download All]
    │
    ▼
[For each content item]
    │
    ├─→ [isAlreadyScraped(site, uniqueId)] → yes: skip
    │
    └─→ no: download → success → [appendToSheet(...)] → POST to Sheet
    │
    ▼
[New row appears in Sheet]
```

**Note on before.click:** One app entry covers all its screenshots. The unique_id is the app slug (e.g., `unwind`). If the app row exists in the Sheet, all its ASO images are considered downloaded — no re-scrape needed.

---

## Seed Data Migration

To migrate existing ~1500 videos from `history_seed.json`:

**Challenge:** `history_seed.json` only has `"Title - Company"` strings — no unique IDs.

**For keyframe.gallery and framerate.tv (videos):**
1. The history entries were scraped from pages that included video IDs
2. Need to re-visit each site's page to get the current unique IDs, OR
3. Accept a one-time re-download of already-downloaded videos ( Sheet dedup won't catch them without IDs)
4. Better approach: add a "Rescrape" mode that re-fetches page HTML, extracts IDs, and reconciles

**For before.click (apps):**
- Not in history_seed.json yet — just starts fresh

---

## Verification

1. Open extension on keyframe.gallery → shows ✓ on ~1500 videos (from Sheet)
2. Download a new video → row added to Sheet
3. Open on another PC → same history loaded
4. Share Sheet link with collaborator → they see same history

---

## Files to Modify

| File | Changes |
|---|---|
| `popup.js` | Add `getSiteFromUrl()`, `syncFromSheet()` (Map-based), `appendToSheet()`, `isAlreadyScraped()`, update download functions to use unique_id for dedup |
| `popup.html` | Add site indicator, "Sync Now" button |
| `SETUP.md` | Document how to create Sheet and deploy Apps Script |

---

## Key Changes Summary

1. **Schema** → 7 columns instead of 4, includes `unique_id` and `content_type`
2. **Dedup** → `site + unique_id` composite key (Map structure), not title-company Set
3. **before.click** → one row per app, not per screenshot
4. **Migration** → needs re-scrape approach since seed data lacks unique IDs