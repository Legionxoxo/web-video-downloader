// Content script: extracts video metadata from web pages
// Supports keyframe.gallery, framerate.tv, and before.click
// Uses playbackId as primary identifier for downloads

function extractVideos() {
  const videos = [];
  const seen = new Set();

  // Helper to add a video if we haven't seen the playbackId yet
  const addVideo = (playbackId, rawTitle, rawCompany) => {
    if (!playbackId || seen.has(playbackId)) return;
    seen.add(playbackId);

    const safeTitle = (rawTitle || 'Untitled')
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 80);

    const safeCompany = (rawCompany || 'Unknown')
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();

    videos.push({
      playbackId,
      title: safeTitle,
      company: safeCompany,
      videoId: playbackId,
      hlsUrl: `https://stream.mux.com/${playbackId}.m3u8`,
      thumbnail: `https://image.mux.com/${playbackId}/thumbnail.jpg?width=160&height=90&fit_mode=smartcrop`
    });
  };

  // ===== before.click =====
  // Check if this is a gallery page (has gallery with screenshots)
  const galleryContainer = document.querySelector('.gallery-scroll');
  if (galleryContainer) {
    // Gallery page: extract all 8 screenshots
    const galleryImages = galleryContainer.querySelectorAll('img[data-nimg="fill"]');
    if (galleryImages.length > 0) {
      // Extract app info from URL: /explore?app=tolan
      const urlParams = new URLSearchParams(window.location.search);
      const appSlug = urlParams.get('app') || 'unknown';
      const tab = urlParams.get('tab') || urlParams.get('view') || '';

      // Get app name and category from the page
      let appName = appSlug.charAt(0).toUpperCase() + appSlug.slice(1);
      let category = 'Unknown';

      // Try to find app name in breadcrumb or header
      const nameEl = document.querySelector('.text-sm.font-medium.tracking-tight.text-black');
      const categoryEl = document.querySelector('p.text-xs.font-medium.tracking-tight.text-black\\/40');
      if (nameEl) appName = nameEl.textContent.trim();
      if (categoryEl) category = categoryEl.textContent.trim();

      // Build the app entry with all gallery images
      const imageUrls = [];
      galleryImages.forEach(img => {
        const srcset = img.getAttribute('srcset') || img.getAttribute('src') || '';
        const urls = srcset.split(',').map(s => s.trim());
        let bestUrl = '';
        let highestW = 0;
        urls.forEach(u => {
          const wMatch = u.match(/w=(\d+)/);
          const w = wMatch ? parseInt(wMatch[1]) : 0;
          const urlPart = u.split(/\s+/)[0];
          if (w >= highestW && urlPart) {
            highestW = w;
            bestUrl = urlPart;
          }
        });
        if (bestUrl) {
          const urlMatch = bestUrl.match(/url=([^&]+)/);
          if (urlMatch) {
            const decodedUrl = decodeURIComponent(urlMatch[1]);
            const fullUrl = decodedUrl.startsWith('http') ? decodedUrl : window.location.origin + decodedUrl;
            imageUrls.push(fullUrl);
          }
        }
      });

      // Deduplicate while preserving order
      const seenUrls = new Set();
      const uniqueImages = [];
      imageUrls.forEach(url => {
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          uniqueImages.push(url);
        }
      });

      if (uniqueImages.length > 0) {
        return {
          site: 'before',
          apps: [{
            slug: appSlug,
            name: appName,
            category: category,
            tab: tab,
            images: uniqueImages
          }]
        };
      }
    }
  }

  // Explore page: extract app cards with previews
  const appCards = document.querySelectorAll('a.group.block[href*="/explore?app="]');
  const seenApps = new Set();
  const apps = [];
  const exploreUrlParams = new URLSearchParams(window.location.search);
  const exploreTab = exploreUrlParams.get('tab') || exploreUrlParams.get('view') || '';

  appCards.forEach(card => {
    const href = card.getAttribute('href');
    const appMatch = href.match(/[?&]app=([^&]+)/);
    if (!appMatch) return;
    const appSlug = appMatch[1];

    const nameEl = card.querySelector('.text-sm.font-medium.tracking-tight.text-black');
    const categoryEl = card.querySelector('p.text-xs.font-medium.tracking-tight.text-black\\/40');

    if (!nameEl) return;
    const appName = nameEl.textContent.trim();
    const category = categoryEl ? categoryEl.textContent.trim() : 'Unknown';

    const appKey = `${appSlug}-${category}`;
    if (seenApps.has(appKey)) return;
    seenApps.add(appKey);

    // Get preview images (first 3)
    const previewImages = card.querySelectorAll('img[src*="/_next/image"]');
    const imageUrls = [];

    previewImages.forEach(img => {
      const srcset = img.getAttribute('srcset') || img.getAttribute('src') || '';
      const urls = srcset.split(',').map(s => s.trim());
      let bestUrl = '';
      let highestW = 0;
      urls.forEach(u => {
        const wMatch = u.match(/w=(\d+)/);
        const w = wMatch ? parseInt(wMatch[1]) : 0;
        const urlPart = u.split(/\s+/)[0];
        if (w >= highestW && urlPart) {
          highestW = w;
          bestUrl = urlPart;
        }
      });
      if (bestUrl) {
        const urlMatch = bestUrl.match(/url=([^&]+)/);
        if (urlMatch) {
          const decodedUrl = decodeURIComponent(urlMatch[1]);
          const fullUrl = decodedUrl.startsWith('http') ? decodedUrl : window.location.origin + decodedUrl;
          imageUrls.push(fullUrl);
        }
      }
    });

    if (imageUrls.length > 0) {
      const galleryTabParam = exploreTab ? `&tab=${exploreTab}` : '';
      apps.push({
        slug: appSlug,
        name: appName,
        category: category,
        tab: exploreTab,
        images: imageUrls,
        galleryUrl: `${window.location.origin}/explore?app=${appSlug}${galleryTabParam}`
      });
    }
  });

  if (apps.length > 0) {
    return { site: 'before', apps };
  }

  // ===== keyframe.gallery =====
  // Heuristic 1: Phoenix LiveView attributes on clickable elements
  const phxElements = document.querySelectorAll('[phx-value-playback_id]');
  phxElements.forEach(el => {
    const playbackId = el.getAttribute('phx-value-playback_id');
    const title = el.getAttribute('phx-value-title');
    const company = el.getAttribute('phx-value-company_name');
    addVideo(playbackId, title, company);
  });

  // ===== framerate.tv =====
  // Heuristic 2: mux-player tags (watch pages)
  const muxPlayers = document.querySelectorAll('mux-player');
  muxPlayers.forEach(player => {
    const playbackId = player.getAttribute('playback-id');
    if (!playbackId) return;

    let title = document.title || 'Video';
    let company = window.location.hostname;

    const titleH1 = document.querySelector('h1.font-bold');
    if (titleH1) title = titleH1.textContent;
    const authorH3 = document.querySelector('h3.font-semibold');
    if (authorH3) company = authorH3.textContent;

    addVideo(playbackId, title, company);
  });

  // Heuristic 3: img thumbnails with image.mux.com (framerate explore page)
  const muxImages = document.querySelectorAll('img[src*="image.mux.com"]');
  muxImages.forEach(img => {
    const src = img.getAttribute('src');
    const match = src.match(/image\.mux\.com\/([a-zA-Z0-9]+)\//);
    if (!match) return;
    const playbackId = match[1];

    let title = 'Video';
    let company = 'Unknown';

    const card = img.closest('a.video-card-container') || img.closest('.group');
    if (card) {
      const h6 = card.querySelector('h6');
      const creatorP = card.querySelector('p.text-muted-foreground');
      if (h6) title = h6.textContent;
      if (creatorP) {
        const creatorA = creatorP.querySelector('a p');
        company = creatorA ? creatorA.textContent : creatorP.textContent;
      }
    } else if (img.alt) {
      title = img.alt;
    }

    addVideo(playbackId, title, company);
  });

  // Heuristic 4: [data-playback-id] on non-mux-player elements
  const dataPlaybackEls = document.querySelectorAll('[data-playback-id]');
  dataPlaybackEls.forEach(el => {
    if (el.tagName !== 'MUX-PLAYER') {
      const playbackId = el.getAttribute('data-playback-id');
      const title = document.title;
      addVideo(playbackId, title, 'Scraped Video');
    }
  });

  // Heuristic 5: video tags with stream.mux.com src (framerate explore page - animated preview)
  const streamVideos = document.querySelectorAll('video[src*="stream.mux.com/"]');
  streamVideos.forEach(el => {
    const src = el.getAttribute('src');
    const match = src.match(/stream\.mux\.com\/([a-zA-Z0-9]+)\//);
    if (!match) return;
    const playbackId = match[1];

    let title = 'Video';
    let company = 'Unknown';

    const card = el.closest('a.video-card-container') || el.closest('.group');
    if (card) {
      const h6 = card.querySelector('h6');
      const creatorP = card.querySelector('p.text-muted-foreground');
      if (h6) title = h6.textContent;
      if (creatorP) {
        const creatorA = creatorP.querySelector('a p');
        company = creatorA ? creatorA.textContent : creatorP.textContent;
      }
    }

    addVideo(playbackId, title, company);
  });

  return { site: null, videos };
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getVideos') {
    const result = extractVideos();
    // For before.click, return apps; for others, return videos
    if (result.site === 'before') {
      sendResponse({ apps: result.apps, site: 'before' });
    } else {
      sendResponse({ videos: result.videos, site: null });
    }
  } else if (request.action === 'autoScroll') {
    window.scrollBy({
      top: window.innerHeight * 2,
      behavior: 'smooth'
    });
    const scrollable = document.querySelector('main') || document.body;
    scrollable.scrollBy({
       top: window.innerHeight * 2,
       behavior: 'smooth'
    });
    sendResponse({ success: true });
  } else if (request.action === 'fetchImageAsDataUrl') {
    // Fetch image using XMLHttpRequest (same-origin, no CORS issues)
    const { imageUrl } = request;
    console.log('[Content] fetchImageAsDataUrl called for:', imageUrl);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', imageUrl, true);
    xhr.responseType = 'blob';
    xhr.onload = function() {
      if (xhr.status === 200) {
        const blob = xhr.response;
        console.log('[Content] XHR loaded, blob size:', blob.size);
        const reader = new FileReader();
        reader.onloadend = function() {
          console.log('[Content] FileReader completed, dataUrl length:', reader.result.length);
          sendResponse({ success: true, dataUrl: reader.result });
        };
        reader.onerror = function() {
          console.error('[Content] FileReader error');
          sendResponse({ success: false, error: 'Failed to read blob as data URL' });
        };
        reader.readAsDataURL(blob);
      } else {
        console.error('[Content] XHR failed with status:', xhr.status);
        sendResponse({ success: false, error: `HTTP ${xhr.status}` });
      }
    };
    xhr.onerror = function() {
      console.error('[Content] XHR network error');
      sendResponse({ success: false, error: 'Network error' });
    };
    xhr.send();
    return true; // Will respond asynchronously
  } else if (request.action === 'clickTabButton') {
    // Click the tab button with matching text
    const { buttonText } = request;
    const buttons = document.querySelectorAll('nav button');
    let clicked = false;
    buttons.forEach(btn => {
      if (btn.textContent.trim() === buttonText) {
        btn.click();
        clicked = true;
      }
    });
    sendResponse({ success: clicked });
  }
  return true;
});
