# Google Sheets Setup Guide

This extension uses a Google Sheet as a shared history backend so you can sync download history across multiple PCs and share it with collaborators.

---

## Step 1 — Create the Google Sheet

1. Go to [sheets.google.com](https://sheets.google.com) and sign in
2. Create a new blank spreadsheet
3. Rename the first sheet to `History` (optional)
4. Add a header row with these columns:

| A    | B           | C        | D          | E        | F              | G     |
| ---- | ----------- | -------- | ---------- | -------- | -------------- | ----- |
| site | content_type | unique_id | title      | creator  | downloaded_at  | url   |

(These exact column names are required)

**Why 7 columns instead of 4?** The original `title + company` dedup key was unreliable — two different videos on different sites (or even on the same site over time) can share the same title. The corrected schema uses `site + unique_id` as a composite dedup key, pulled directly from each page's content identifiers. `content_type` and `creator` provide useful metadata, and `url` allows re-visiting the original page.

---

## Step 2 — Get your Sheet ID

Open the spreadsheet. The URL will look like:

```
https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID_HERE/edit
```

Copy the `YOUR_SHEET_ID_HERE` part (the long alphanumeric string between `/d/` and `/edit`).

---

## Step 3 — Create the Google Apps Script

1. In the spreadsheet, click **Extensions → Apps Script**
2. A new tab opens with the Apps Script editor (close any tutorial that appears)
3. Delete any code in the editor and paste this:

```javascript
const SHEET_ID = '1y3qsr-MUZKWDLyVzhNVmPaf1dPBgo1Xb6_IbeI3lUFk';

function doGet(e) {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getActiveSheet();
    const rows = sheet.getDataRange().getValues();
    const siteFilter = e.parameter.site;

    let data = rows.slice(1).map((row) => ({
        site: row[0],
        content_type: row[1],
        unique_id: row[2],
        title: row[3],
        creator: row[4],
        downloaded_at: row[5],
        url: row[6],
    }));

    if (siteFilter) {
        data = data.filter((r) => r.site === siteFilter);
    }

    return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(
        ContentService.MimeType.JSON,
    );
}

function doPost(e) {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getActiveSheet();
    const { site, content_type, unique_id, title, creator, url } = JSON.parse(
        e.postData.contents,
    );
    sheet.appendRow([
        site,
        content_type,
        unique_id,
        title,
        creator,
        new Date().toISOString(),
        url,
    ]);
    return ContentService.createTextOutput('ok');
}
```

4. Replace `YOUR_SHEET_ID` on line 1 with your actual Sheet ID (`1y3qsr-MUZKWDLyVzhNVmPaf1dPBgo1Xb6_IbeI3lUFk`)

---

## Step 4 — Deploy as Web App

1. Click the blue **Deploy** button (top right) → **New deployment**
2. Click the gear icon ⚙️ next to "Select type" → choose **Web app**
3. Fill in:
    - **Description**: `Mux Downloader History`
    - **Execute as**: Me (your email)
    - **Access**: Anyone
4. Click **Deploy**
5. Click **Authorize access** and grant permissions (select your Google account)
6. Copy the Web App URL. It is:
    ```
    https://script.google.com/macros/s/AKfycbw_e6kNjE9xvqS_yBP4xd8EnP2ipf8opNt2rbwP1oZiaWN4lkogVe0AhhGZf6_3A4Hl5w/exec
    ```

   (Deployment ID: `AKfycbw_e6kNjE9xvqS_yBP4xd8EnP2ipf8opNt2rbwP1oZiaWN4lkogVe0AhhGZf6_3A4Hl5w`)

---

## Step 5 — Update popup.js

The Web App URL is already set in `popup.js` — no changes needed.

Paste your actual Web App URL, e.g.:

```javascript
const SHEET_URL = "https://script.google.com/macros/s/ABCD1234...XYZ/exec";
```

---

## Step 6 — Migrate Existing History (One Time)

If you already have downloaded videos in `history_seed.json` and want to populate the Sheet:

1. Open your new Google Sheet
2. Copy the data from `history_seed.json` (each entry is `"Title - Company"` format)
3. In the Sheet, add a new row for each entry:
    - `site`: `keyframe` or `framerate` (based on which site it came from)
    - `content_type`: `video`
    - `unique_id`: leave blank, or visit the original page to find the video/slug ID
    - `title`: extract the title part before `-`
    - `creator`: extract the company/creator part after `-`
    - `downloaded_at`: any past date or today's date
    - `url`: leave blank, or reconstruct from the site's URL pattern

**Tip**: For the ~1500 entries from keyframe.gallery, they were all scraped from that site, so `site = "keyframe"`. Since `history_seed.json` has no unique IDs, those rows will use blank `unique_id` — dedup will rely on the extension re-scraping page HTML to find actual IDs. A "Rescrape" mode in the extension will re-fetch each page, extract IDs, and reconcile against the Sheet.

---

## Sites & Site IDs

| Website                                 | Site ID (use in Sheet) |
| --------------------------------------- | ---------------------- |
| https://www.keyframe.gallery/           | `keyframe`             |
| https://framerate.tv/explore?tab=videos | `framerate`            |
| https://before.click/                   | `before`               |

---

## Sharing with Others

To let someone else use the same history:

1. Share the Google Sheet with their Google account (Share button → add their email)
2. They deploy their own Apps Script pointing to the same Sheet
3. They update their `popup.js` with the same Sheet URL
4. Now both can download and see each other's history

**Dedup**: The extension uses `site + unique_id` as the dedup key (stored as a Map in `downloadHistory`). This means the same video on the same site will never be downloaded twice, even if shared across multiple PCs.

---

## Troubleshooting

**"Sheet URL not configured" in console**
→ You haven't replaced `YOUR_GOOGLE_APPS_SCRIPT_URL_HERE` in popup.js yet.

**Fetch errors in console**
→ Check that the Apps Script URL is correct and that the Web App is deployed.

**History not syncing**
→ Open browser DevTools (F12) → Console to see detailed error messages from `syncFromSheet()`.

**Rate limiting**
→ The Sheet allows ~100 writes/minute. The extension only writes once per completed video download, so you'll never hit this.
