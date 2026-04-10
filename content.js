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

    // Navigate up from the img → parent div.aspect-video → parent a.video-card-container
    // The card contains: img (thumbnail), h6 (title), p with creator info
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
  // Pattern: <video src="https://stream.mux.com/{PLAYBACK_ID}/medium.mp4">
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

  return videos;
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getVideos') {
    const videos = extractVideos();
    sendResponse({ videos });
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
  }
  return true;
});