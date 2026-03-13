// Content script: extracts video metadata from Keyframe Gallery pages

function extractVideos() {
  const videos = [];
  const seen = new Set();

  // Find all elements with data-playback-id (video tags and thumbnail divs)
  const videoElements = document.querySelectorAll('[data-playback-id]');
  videoElements.forEach(el => {
    const playbackId = el.getAttribute('data-playback-id');
    if (!playbackId || seen.has(playbackId)) return;
    seen.add(playbackId);

    // Try to get title and company from the parent thumbnail div
    const container = el.closest('[data-phx-stream]') || el.closest('[id^="videos-"]');
    let title = '';
    let company = '';
    let videoId = '';

    if (container) {
      const thumbDiv = container.querySelector('[phx-value-title]');
      if (thumbDiv) {
        title = thumbDiv.getAttribute('phx-value-title') || '';
        company = thumbDiv.getAttribute('phx-value-company_name') || '';
        videoId = thumbDiv.getAttribute('phx-value-video_id') || '';
      }
    }

    // Also check mux-player element
    if (!title && el.tagName === 'MUX-PLAYER') {
      const theaterParent = el.closest('.relative');
      if (theaterParent) {
        const titleEl = theaterParent.querySelector('p.font-medium');
        if (titleEl) title = titleEl.textContent.trim();
      }
    }

    videos.push({
      playbackId,
      title: title || `video-${playbackId.substring(0, 8)}`,
      company: company || 'Unknown',
      videoId: videoId || '',
      // Mux direct MP4 URL
      mp4Url: `https://stream.mux.com/${playbackId}/high.mp4`,
      // Mux HLS URL as fallback
      hlsUrl: `https://stream.mux.com/${playbackId}.m3u8`,
      // Thumbnail
      thumbnail: `https://image.mux.com/${playbackId}/thumbnail.jpg?width=160&height=90&fit_mode=smartcrop`
    });
  });

  return videos;
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getVideos') {
    const videos = extractVideos();
    sendResponse({ videos });
  }
  return true;
});
