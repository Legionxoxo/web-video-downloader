// Popup script: communicates with content script and triggers downloads

let allVideos = [];
let activeTabId = null;

const downloadIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

document.addEventListener('DOMContentLoaded', async () => {
  const content = document.getElementById('content');
  const stats = document.getElementById('stats');
  const downloadAllBtn = document.getElementById('downloadAll');
  const autoScrollBtn = document.getElementById('autoScroll');

  async function fetchAndRender() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
        content.innerHTML = '<div class="empty">Navigate to a website with Mux videos to use this extension.</div>';
        stats.textContent = 'Invalid Page';
        return;
      }
      activeTabId = tab.id;

      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getVideos' });
      allVideos = response.videos || [];

      if (allVideos.length === 0) {
        content.innerHTML = '<div class="empty">No videos found on this page.<br>Try scrolling down to load more videos first.</div>';
        stats.textContent = '0 videos found';
        downloadAllBtn.disabled = true;
        downloadAllBtn.textContent = 'Download All';
        return;
      }

      stats.textContent = `${allVideos.length} videos found`;
      downloadAllBtn.disabled = false;
      downloadAllBtn.textContent = `Download All (${allVideos.length})`;

      content.innerHTML = '<div class="video-list" id="videoList"></div>';
      const videoList = document.getElementById('videoList');

      allVideos.forEach((video, index) => {
        const item = document.createElement('div');
        item.className = 'video-item';
        item.id = `video-${index}`;
        item.innerHTML = `
          <img class="video-thumb" src="${video.thumbnail}" alt="" loading="lazy">
          <div class="video-info">
            <div class="video-title" title="${video.title}">${video.title}</div>
            <div class="video-company">${video.company}</div>
            <div class="video-status" id="status-${index}" style="font-size:10px;color:#FAC800;margin-top:2px;"></div>
          </div>
          <button class="btn-download" data-index="${index}" title="Download this video">
            ${downloadIcon}
          </button>
        `;
        videoList.appendChild(item);
      });

      videoList.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-download');
        if (!btn || btn.disabled) return;
        const index = parseInt(btn.dataset.index);
        downloadSingleVideo(allVideos[index], index, btn);
      });

    } catch (err) {
      console.error('Error:', err);
      content.innerHTML = '<div class="empty">Could not connect to page.<br>Try refreshing the page and reopening the extension.</div>';
      stats.textContent = 'Connection error';
    }
  }

  // Initial load
  await fetchAndRender();

  // Auto-scroll handler
  autoScrollBtn.addEventListener('click', async () => {
    if (!activeTabId) return;
    autoScrollBtn.disabled = true;
    const originalText = autoScrollBtn.textContent;
    autoScrollBtn.textContent = 'Scrolling...';
    
    try {
      await chrome.tabs.sendMessage(activeTabId, { action: 'autoScroll' });
      // Wait a moment for page to load new content then fetch again
      setTimeout(async () => {
        await fetchAndRender();
        autoScrollBtn.disabled = false;
        autoScrollBtn.textContent = originalText;
      }, 1500);
    } catch (err) {
      autoScrollBtn.disabled = false;
      autoScrollBtn.textContent = 'Scroll Error';
      setTimeout(() => autoScrollBtn.textContent = originalText, 2000);
    }
  });

  // Download all handler
  downloadAllBtn.addEventListener('click', () => {
    downloadAllSequential();
  });
});

function makeIntendedName(video) {
  const safeTitle = (video.title || 'Untitled')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 80);
  const safeCompany = (video.company || 'Unknown')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${safeTitle} - ${safeCompany}`; // UI display only
}

async function downloadSingleVideo(video, index, btn) {
  btn.disabled = true;
  btn.style.opacity = '0.5';
  const statusEl = document.getElementById(`status-${index}`);
  const intendedName = makeIntendedName(video);

  const pollInterval = setInterval(() => {
    chrome.runtime.sendMessage({ action: 'getProgress' }, (resp) => {
      if (resp && resp.progress && resp.progress[video.playbackId]) {
        statusEl.textContent = resp.progress[video.playbackId];
      }
    });
  }, 500);

  chrome.runtime.sendMessage({
    action: 'downloadVideo',
    video: video
  }, (response) => {
    clearInterval(pollInterval);
    if (response && response.success) {
      btn.innerHTML = '✓';
      btn.style.color = '#4ade80';
      btn.style.opacity = '1';
      statusEl.textContent = `✓ → ${intendedName}${response.ext || '.mp4'}`;
      statusEl.style.color = '#4ade80';
    } else {
      btn.innerHTML = '✗';
      btn.style.color = '#f87171';
      btn.style.opacity = '1';
      statusEl.textContent = response?.error || 'Failed';
      statusEl.style.color = '#f87171';
      setTimeout(() => {
        btn.innerHTML = downloadIcon;
        btn.style.color = '';
        btn.style.opacity = '';
        btn.disabled = false;
      }, 3000);
    }
  });
}

async function downloadAllSequential() {
  const downloadAllBtn = document.getElementById('downloadAll');
  const statusBar = document.getElementById('statusBar');

  downloadAllBtn.disabled = true;
  statusBar.style.display = 'block';
  statusBar.textContent = 'Starting downloads...';

  const pollInterval = setInterval(() => {
    chrome.runtime.sendMessage({ action: 'getProgress' }, (resp) => {
      if (resp && resp.progress) {
        let completedCount = 0;
        let errorCount = 0;

        allVideos.forEach((video, index) => {
          const statusEl = document.getElementById(`status-${index}`);
          if (statusEl && resp.progress[video.playbackId]) {
            const status = resp.progress[video.playbackId];
            statusEl.textContent = status;

            if (status === 'Complete!') {
              statusEl.style.color = '#4ade80';
              statusEl.textContent = `✓ → ${makeIntendedName(video)}`;
              const btn = document.querySelector(`#video-${index} .btn-download`);
              if (btn) { btn.innerHTML = '✓'; btn.style.color = '#4ade80'; }
              completedCount++;
            } else if (status.startsWith('Error')) {
              statusEl.style.color = '#f87171';
              const btn = document.querySelector(`#video-${index} .btn-download`);
              if (btn) { btn.innerHTML = '✗'; btn.style.color = '#f87171'; }
              errorCount++;
            }
          }
        });

        downloadAllBtn.textContent = `Downloading... (${completedCount}/${allVideos.length})`;
        statusBar.textContent = `✓ ${completedCount} done${errorCount ? ' · ✗ ' + errorCount + ' failed' : ''}`;
      }
    });
  }, 500);

  chrome.runtime.sendMessage({
    action: 'downloadAll',
    videos: allVideos
  }, (response) => {
    clearInterval(pollInterval);
    if (response) {
      downloadAllBtn.textContent = `Done! ${response.completed}/${response.total}`;
      statusBar.innerHTML = `✓ ${response.completed} videos completely downloaded directly to your <strong>mux-videos</strong> folder.`;
    }
  });
}
