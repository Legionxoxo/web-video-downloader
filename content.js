// Content script: extracts video metadata from web pages
// Searches for Mux videos using various heuristics

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
      videoId: playbackId, // fallback
      hlsUrl: `https://stream.mux.com/${playbackId}.m3u8`,
      thumbnail: `https://image.mux.com/${playbackId}/thumbnail.jpg?width=160&height=90&fit_mode=smartcrop`
    });
  };

  // Heuristic 1: Legacy Keyframe Gallery specific attributes
  const phxElements = document.querySelectorAll('[phx-value-playback_id]');
  phxElements.forEach(el => {
    const playbackId = el.getAttribute('phx-value-playback_id');
    const title = el.getAttribute('phx-value-title');
    const company = el.getAttribute('phx-value-company_name');
    addVideo(playbackId, title, company);
  });

  // Heuristic 2: <mux-player> tags
  const muxPlayers = document.querySelectorAll('mux-player');
  muxPlayers.forEach(player => {
    const playbackId = player.getAttribute('playback-id');
    if (!playbackId) return;

    let title = document.title || 'Video';
    let company = window.location.hostname;

    // Framerate.tv Watch Page Specifics
    const titleH1 = document.querySelector('h1.font-bold');
    if (titleH1) title = titleH1.textContent;
    const authorH3 = document.querySelector('h3.font-semibold');
    if (authorH3) company = authorH3.textContent;

    addVideo(playbackId, title, company);
  });

  // Heuristic 3: Image Thumbnails pointing to Mux
  const muxImages = document.querySelectorAll('img[src*="image.mux.com"]');
  muxImages.forEach(img => {
    const src = img.getAttribute('src');
    // Extract playbackId from URLs like https://image.mux.com/PLAYBACK_ID/thumbnail.webp
    const match = src.match(/image\.mux\.com\/([a-zA-Z0-9]+)\//);
    if (!match) return;
    const playbackId = match[1];

    let title = 'Video Image';
    let company = 'Unknown';

    // Framerate.tv Explore Page Specifics
    // Looks for parent card container, then h3 for title, and creator logic
    const card = img.closest('.group');
    if (card) {
      const h3 = card.querySelector('h3.font-semibold');
      if (h3) title = h3.textContent;

      const pCreator = card.querySelector('p.text-muted-foreground');
      if (pCreator) company = pCreator.textContent;
    } else {
      // Fallback to alt tag or page details
      if (img.alt) {
        title = img.alt;
      }
    }

    addVideo(playbackId, title, company);
  });

  // Heuristic 4: Direct specific [data-playback-id] elements used by some libs
  const dataPlaybackEls = document.querySelectorAll('[data-playback-id]');
  dataPlaybackEls.forEach(el => {
    if (el.tagName !== 'MUX-PLAYER') {
      const playbackId = el.getAttribute('data-playback-id');
      const container = el.closest('[class]');
      const title = document.title;
      addVideo(playbackId, title, 'Scraped Video');
    }
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
    // Fallback if it's a specific scrolling container rather than window
    const scrollable = document.querySelector('main') || document.body;
    scrollable.scrollBy({
       top: window.innerHeight * 2,
       behavior: 'smooth'
    });
    sendResponse({ success: true });
  }
  return true;
});
