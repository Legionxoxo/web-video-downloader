// Popup script: communicates with content script and triggers downloads
// Supports keyframe.gallery, framerate.tv with Google Sheets history sync
// Also supports before.click for image downloads

let allVideos = [];
let allApps = []; // for before.click image mode
let activeTabId = null;
let failedIndices = new Set();
let failedImageApps = new Set(); // for before.click
let downloadHistory = new Set(); // "Title - Company" keys for videos, "name-category" for before.click
let currentSite = null;

const SHEET_URL = 'https://script.google.com/macros/s/AKfycbw_e6kNjE9xvqS_yBP4xd8EnP2ipf8opNt2rbwP1oZiaWN4lkogVe0AhhGZf6_3A4Hl5w/exec';

const downloadIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
const retryIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;

function getSiteFromUrl(url) {
  if (!url) return null;
  if (url.includes('keyframe.gallery')) return 'keyframe';
  if (url.includes('framerate.tv')) return 'framerate';
  if (url.includes('before.click')) return 'before';
  return null;
}

// Sync history from Google Sheet for the given site
async function syncFromSheet(site) {
  if (!site) {
    downloadHistory = new Set();
    return;
  }

  try {
    const resp = await fetch(`${SHEET_URL}?site=${encodeURIComponent(site)}`);
    if (!resp.ok) throw new Error('Sheet fetch failed');
    const data = await resp.json();
    // Sheet stores "title - creator" as the unique key
    downloadHistory = new Set(data.map(r => `${r.title} - ${r.creator}`));
    console.log(`Synced ${downloadHistory.size} entries from Sheet for site: ${site}`);
  } catch (err) {
    console.error('Failed to sync from Sheet:', err);
    downloadHistory = new Set();
  }
}

// Append a new entry to Google Sheet after successful download
async function appendToSheet(site, title, company, uniqueId = '', tab = '') {
  if (!site) return;

  try {
    await fetch(SHEET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site,
        content_type: site === 'before' ? 'image' : 'video',
        unique_id: uniqueId, // used as 'aso' for before.click apps
        title,
        creator: company,
        url: '',
        tab: tab, // 'onboarding' or 'paywalls' for before.click
        downloadedAt: new Date().toISOString()
      })
    });
    console.log(`Appended to Sheet: ${title} - ${company} (${site})`);
  } catch (err) {
    console.error('Failed to append to Sheet:', err);
  }
}

async function markAsDownloaded(title, company) {
  const key = `${title} - ${company}`;
  downloadHistory.add(key);
}

function makeImageFilename(appName, category, index, ext) {
  const safeAppName = (appName || 'unknown')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '-')
    .trim()
    .toLowerCase()
    .substring(0, 50);
  const safeCategory = (category || 'unknown')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '-')
    .trim()
    .toLowerCase()
    .substring(0, 50);
  return `${safeAppName}-${safeCategory}-${index}${ext}`;
}

document.addEventListener('DOMContentLoaded', async () => {
  const content = document.getElementById('content');
  const stats = document.getElementById('stats');
  const downloadAllBtn = document.getElementById('downloadAll');
  const autoScrollBtn = document.getElementById('autoScroll');
  const retryAllBtn = document.getElementById('retryAll');

  // Get current tab URL to detect site and sync history from Sheet
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url) {
    currentSite = getSiteFromUrl(tab.url);
  }
  if (currentSite) {
    await syncFromSheet(currentSite);
  }

  // Update site indicator in header
  const siteIndicator = document.getElementById('siteIndicator');
  if (siteIndicator) {
    if (currentSite === 'before') {
      siteIndicator.textContent = 'IMAGES';
      siteIndicator.style.background = '#4ade80';
      siteIndicator.style.color = '#111';
    } else if (currentSite === 'keyframe') {
      siteIndicator.textContent = 'KEYFRAME';
      siteIndicator.style.background = '#333';
    } else if (currentSite === 'framerate') {
      siteIndicator.textContent = 'FRAMERATE';
      siteIndicator.style.background = '#333';
    }
  }

  async function fetchAndRender() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
        content.innerHTML = '<div class="empty">Navigate to a website with Mux videos or before.click images to use this extension.</div>';
        stats.textContent = 'Invalid Page';
        return;
      }
      activeTabId = tab.id;

      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getVideos' });

      // Handle before.click image mode
      if (response.site === 'before') {
        allApps = response.apps || [];
        allVideos = [];

        if (allApps.length === 0) {
          content.innerHTML = '<div class="empty">No apps found on this page.<br>Try scrolling down to load more apps first.</div>';
          stats.textContent = '0 apps found';
          downloadAllBtn.disabled = true;
          downloadAllBtn.textContent = 'Download All';
          return;
        }

        const totalImages = allApps.reduce((sum, app) => sum + app.images.length, 0);
        stats.textContent = `${allApps.length} apps (${totalImages} images) found`;
        downloadAllBtn.disabled = false;
        downloadAllBtn.textContent = `Download All (${allApps.length} apps)`;

        content.innerHTML = '<div class="video-list" id="videoList"></div>';
        const videoList = document.getElementById('videoList');

        allApps.forEach((app, index) => {
          const item = document.createElement('div');
          item.className = 'video-item';
          item.id = `video-${index}`;

          const tabForHistory = app.tab === 'paywalls' ? 'paywall' : (app.tab || 'aso');
          const historyKey = `${app.name} - ${tabForHistory}`;
          const isDownloaded = downloadHistory.has(historyKey);
          const thumb = app.images[0] || '';

          item.innerHTML = `
            <img class="video-thumb" src="${thumb}" alt="" loading="lazy">
            <div class="video-info">
              <div class="video-title" title="${app.name}">${app.name}</div>
              <div class="video-company">${app.category} · ${app.images.length} images</div>
              <div class="video-status" id="status-${index}" style="font-size:10px;color:${isDownloaded ? '#4ade80' : '#FAC800'};margin-top:2px;">
                ${isDownloaded ? '✓ Already Downloaded' : ''}
              </div>
            </div>
            <button class="btn-download" data-index="${index}" title="Download all images"
                    style="${isDownloaded ? 'color: #4ade80; opacity: 0.7' : ''}">
              ${isDownloaded ? '✓' : downloadIcon}
            </button>
            <button class="btn-retry" data-index="${index}" id="retry-btn-${index}" title="Retry download">
              ${retryIcon}
            </button>
          `;
          videoList.appendChild(item);
        });

        videoList.addEventListener('click', (e) => {
          const downloadBtn = e.target.closest('.btn-download');
          const retryBtn = e.target.closest('.btn-retry');

          if (downloadBtn && !downloadBtn.disabled) {
            const index = parseInt(downloadBtn.dataset.index);
            downloadSingleAppImages(allApps[index], index, downloadBtn);
          } else if (retryBtn && !retryBtn.disabled) {
            const index = parseInt(retryBtn.dataset.index);
            const iconBtn = document.querySelector(`#video-${index} .btn-download`);
            downloadSingleAppImages(allApps[index], index, iconBtn);
          }
        });
        return;
      }

      // Handle video mode (keyframe, framerate)
      allVideos = response.videos || [];
      allApps = [];

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

        const historyKey = `${video.title} - ${video.company}`;
        const isDownloaded = downloadHistory.has(historyKey);

        item.innerHTML = `
          <img class="video-thumb" src="${video.thumbnail}" alt="" loading="lazy">
          <div class="video-info">
            <div class="video-title" title="${video.title}">${video.title}</div>
            <div class="video-company">${video.company}</div>
            <div class="video-status" id="status-${index}" style="font-size:10px;color:${isDownloaded ? '#4ade80' : '#FAC800'};margin-top:2px;">
              ${isDownloaded ? '✓ Already Downloaded' : ''}
            </div>
          </div>
          <button class="btn-download" data-index="${index}" title="Download this video"
                  style="${isDownloaded ? 'color: #4ade80; opacity: 0.7' : ''}">
            ${isDownloaded ? '✓' : downloadIcon}
          </button>
          <button class="btn-retry" data-index="${index}" id="retry-btn-${index}" title="Retry download">
            ${retryIcon}
          </button>
        `;
        videoList.appendChild(item);
      });

      videoList.addEventListener('click', (e) => {
        const downloadBtn = e.target.closest('.btn-download');
        const retryBtn = e.target.closest('.btn-retry');

        if (downloadBtn && !downloadBtn.disabled) {
          const index = parseInt(downloadBtn.dataset.index);
          downloadSingleVideo(allVideos[index], index, downloadBtn);
        } else if (retryBtn && !retryBtn.disabled) {
          const index = parseInt(retryBtn.dataset.index);
          const iconBtn = document.querySelector(`#video-${index} .btn-download`);
          downloadSingleVideo(allVideos[index], index, iconBtn);
        }
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
  let isAutoScrolling = false;

  autoScrollBtn.addEventListener('click', async () => {
    if (!activeTabId) return;

    if (isAutoScrolling) {
      isAutoScrolling = false;
      autoScrollBtn.textContent = 'Stopping...';
      return;
    }

    isAutoScrolling = true;
    autoScrollBtn.textContent = 'Stop Autoscroll';
    autoScrollBtn.style.background = '#f87171';
    autoScrollBtn.style.color = '#111';

    let previousCount = allVideos.length;
    let noNewVideosCount = 0;

    const resetAutoScrollBtn = () => {
      autoScrollBtn.textContent = 'Auto-Scroll & Find More';
      autoScrollBtn.style.background = '#444';
      autoScrollBtn.style.color = '#eee';
      autoScrollBtn.disabled = false;
    };

    const scrollLoop = async () => {
      if (!isAutoScrolling) {
        resetAutoScrollBtn();
        return;
      }

      try {
        await chrome.tabs.sendMessage(activeTabId, { action: 'autoScroll' });

        setTimeout(async () => {
          if (!isAutoScrolling) {
            resetAutoScrollBtn();
            return;
          }
          await fetchAndRender();

          if (allVideos.length === previousCount) {
            noNewVideosCount++;
            if (noNewVideosCount >= 3) {
              isAutoScrolling = false;
              resetAutoScrollBtn();
              return;
            }
          } else {
            noNewVideosCount = 0;
            previousCount = allVideos.length;
          }

          scrollLoop();
        }, 1500);
      } catch (err) {
        isAutoScrolling = false;
        resetAutoScrollBtn();
      }
    };

    scrollLoop();
  });

  downloadAllBtn.addEventListener('click', () => {
    if (currentSite === 'before') {
      downloadAllAppsSequential(Array.from({length: allApps.length}, (_, i) => i));
    } else {
      downloadAllSequential(Array.from({length: allVideos.length}, (_, i) => i));
    }
  });

  retryAllBtn.addEventListener('click', () => {
    if (currentSite === 'before') {
      const toRetry = Array.from(failedImageApps);
      failedImageApps.clear();
      retryAllBtn.style.display = 'none';
      downloadAllAppsSequential(toRetry);
    } else {
      const toRetry = Array.from(failedIndices);
      failedIndices.clear();
      retryAllBtn.style.display = 'none';
      downloadAllSequential(toRetry);
    }
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
  return `${safeTitle} - ${safeCompany}`;
}

async function downloadSingleVideo(video, index, btn) {
  const historyKey = `${video.title} - ${video.company}`;

  // Skip if already downloaded (check both local history and Sheet-synced history)
  if (downloadHistory.has(historyKey)) {
    if (btn) {
      btn.innerHTML = '✓';
      btn.style.color = '#4ade80';
      btn.style.opacity = '0.7';
    }
    const statusEl = document.getElementById(`status-${index}`);
    if (statusEl) {
      statusEl.textContent = '✓ Already Downloaded';
      statusEl.style.color = '#4ade80';
    }
    return false;
  }

  const retryBtn = document.getElementById(`retry-btn-${index}`);
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.innerHTML = downloadIcon;
  }
  if (retryBtn) retryBtn.style.display = 'none';

  const statusEl = document.getElementById(`status-${index}`);
  const intendedName = makeIntendedName(video);

  const pollInterval = setInterval(() => {
    chrome.runtime.sendMessage({ action: 'getProgress' }, (resp) => {
      if (resp && resp.progress && resp.progress[video.playbackId]) {
        if (statusEl) statusEl.textContent = resp.progress[video.playbackId];
      }
    });
  }, 500);

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'downloadVideo', video }, (response) => {
      clearInterval(pollInterval);
      if (response && response.success) {
        if (btn) {
          btn.innerHTML = '✓';
          btn.style.color = '#4ade80';
          btn.style.opacity = '1';
        }
        if (statusEl) {
          statusEl.textContent = `✓ → ${intendedName}${response.ext || '.mp4'}`;
          statusEl.style.color = '#4ade80';
        }
        failedIndices.delete(index);
        markAsDownloaded(video.title, video.company);
        appendToSheet(currentSite, video.title, video.company);
        resolve(true);
      } else {
        if (btn) {
          btn.innerHTML = '✗';
          btn.style.color = '#f87171';
          btn.style.opacity = '1';
        }
        if (statusEl) {
          statusEl.textContent = response?.error || 'Failed';
          statusEl.style.color = '#f87171';
        }
        if (retryBtn) retryBtn.style.display = 'flex';
        failedIndices.add(index);
        document.getElementById('retryAll').style.display = 'block';
        resolve(false);
      }
    });
  });
}

async function downloadAllSequential(indices) {
  const downloadAllBtn = document.getElementById('downloadAll');
  const retryAllBtn = document.getElementById('retryAll');
  const statusBar = document.getElementById('statusBar');

  downloadAllBtn.disabled = true;
  statusBar.style.display = 'block';
  statusBar.textContent = `Starting ${indices.length} downloads...`;

  let completedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < indices.length; i++) {
    const index = indices[i];
    const video = allVideos[index];
    const btn = document.querySelector(`#video-${index} .btn-download`);
    const statusEl = document.getElementById(`status-${index}`);

    const historyKey = `${video.title} - ${video.company}`;
    if (downloadHistory.has(historyKey)) {
      skippedCount++;
      if (statusEl) statusEl.textContent = 'Already Downloaded (Skipped)';
      continue;
    }

    statusBar.textContent = `Downloading ${i + 1} of ${indices.length}... (✓ ${completedCount} | ✗ ${errorCount} | ⏩ ${skippedCount})`;

    let success = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        if (statusEl) statusEl.textContent = `Retrying (Attempt ${attempt}/2)...`;
      }

      success = await downloadSingleVideo(video, index, btn);
      if (success) break;

      await new Promise(r => setTimeout(r, 1000));
    }

    if (success) {
      completedCount++;
    } else {
      errorCount++;
    }

    await new Promise(r => setTimeout(r, 500));
  }

  downloadAllBtn.disabled = false;
  downloadAllBtn.textContent = `Download All (${allVideos.length})`;
  statusBar.innerHTML = `Batch Complete: ✓ ${completedCount} done | ⏩ ${skippedCount} skipped | ✗ ${errorCount} failed.`;

  if (failedIndices.size > 0) {
    retryAllBtn.style.display = 'block';
  } else {
    retryAllBtn.style.display = 'none';
  }
}

// ===== BEFORE.CLICK IMAGE DOWNLOAD FUNCTIONS =====

// Navigate to an app gallery page and extract all images
async function getAppGalleryImages(appSlug, tab = '') {
  // Normalize tab values (some URLs use plural like 'paywalls')
  const normalizedTab = tab === 'paywalls' ? 'paywall' : tab;
  const tabParam = normalizedTab ? `&tab=${normalizedTab}` : '';
  const galleryUrl = `https://before.click/explore?app=${appSlug}${tabParam}`;

  // Map tab value to button text (normalize plural to singular for matching)
  const tabButtonMap = {
    'aso': 'ASO Images',
    'onboarding': 'Onboarding (NUX)',
    'paywall': 'Paywall',
    'paywalls': 'Paywall'
  };
  const buttonText = tabButtonMap[tab] || '';

  return new Promise((resolve) => {
    chrome.tabs.update(activeTabId, { url: galleryUrl }, async (tab) => {
      if (chrome.runtime.lastError) {
        console.error('Tab update failed:', chrome.runtime.lastError);
        resolve(null);
        return;
      }

      // Wait for tab to finish loading
      await new Promise(r => setTimeout(r, 2500));

      // If we have a tab to select, click the corresponding button
      if (buttonText) {
        try {
          const clicked = await chrome.tabs.sendMessage(activeTabId, {
            action: 'clickTabButton',
            buttonText: buttonText
          });
          if (clicked) {
            // Wait for images to load after clicking tab
            await new Promise(r => setTimeout(r, 1500));
          }
        } catch (e) {
          console.error('Failed to click tab button:', e);
        }
      }

      // Retry sending message a few times in case content script hasn't injected yet
      let retries = 5;
      let result = null;
      while (retries > 0) {
        try {
          result = await chrome.tabs.sendMessage(activeTabId, { action: 'getVideos' });
          if (result) break;
        } catch (e) {
          // Content script not ready yet
        }
        retries--;
        if (retries > 0) await new Promise(r => setTimeout(r, 1000));
      }

      if (result && result.site === 'before' && result.apps && result.apps.length > 0) {
        const galleryApp = result.apps[0];
        // Fallback: use the tab we passed in if not set
        if (!galleryApp.tab && tab) {
          galleryApp.tab = tab;
        }
        resolve(galleryApp);
      } else {
        resolve(null);
      }
    });
  });
}

async function downloadSingleAppImages(app, index, btn) {
  // Normalize tab values (plural to singular)
  const normalizeTab = (t) => t === 'paywalls' ? 'paywall' : (t || 'aso');
  const historyKey = `${app.name} - ${normalizeTab(app.tab)}`;

  if (downloadHistory.has(historyKey)) {
    if (btn) {
      btn.innerHTML = '✓';
      btn.style.color = '#4ade80';
      btn.style.opacity = '0.7';
    }
    const statusEl = document.getElementById(`status-${index}`);
    if (statusEl) {
      statusEl.textContent = '✓ Already Downloaded';
      statusEl.style.color = '#4ade80';
    }
    return false;
  }

  const retryBtn = document.getElementById(`retry-btn-${index}`);
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.innerHTML = downloadIcon;
  }
  if (retryBtn) retryBtn.style.display = 'none';

  const statusEl = document.getElementById(`status-${index}`);

  // Check if we're on the gallery page (has all 8 images) or explore page (has only 3 previews)
  let imagesToDownload = app.images;
  let tabToSend = normalizeTab(app.tab);
  if (!app.galleryUrl || app.images.length < 8) {
    // Navigate to gallery page to get all images
    if (statusEl) statusEl.textContent = 'Opening gallery...';
    const galleryApp = await getAppGalleryImages(app.slug, normalizeTab(app.tab));
    if (galleryApp) {
      imagesToDownload = galleryApp.images;
      // Use tab from gallery URL (extracted from ?view= param)
      tabToSend = normalizeTab(galleryApp.tab) || tabToSend;
    }
  }

  const totalImages = imagesToDownload.length;
  let completedImages = 0;

  for (let i = 0; i < imagesToDownload.length; i++) {
    const imageUrl = imagesToDownload[i];
    const ext = imageUrl.split('.').pop() || 'jpg';
    const filename = makeImageFilename(app.name, app.category, i + 1, `.${ext}`);

    if (statusEl) statusEl.textContent = `Downloading image ${i + 1}/${totalImages}...`;

    let success = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'downloadImage', imageUrl, filename, tabId: activeTabId }, resolve);
        });
        if (response && response.success) {
          success = true;
          completedImages++;
          break;
        }
      } catch (e) {
        if (attempt === 2) console.error(`Failed to download ${filename}:`, e);
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  const allSuccess = completedImages === totalImages && totalImages > 0;

  if (btn) {
    btn.disabled = false;
    btn.style.opacity = '1';
  }

  if (allSuccess) {
    if (btn) {
      btn.innerHTML = '✓';
      btn.style.color = '#4ade80';
      btn.style.opacity = '1';
    }
    if (statusEl) {
      statusEl.textContent = `✓ All ${totalImages} images downloaded`;
      statusEl.style.color = '#4ade80';
    }
    failedImageApps.delete(index);
    downloadHistory.add(historyKey);
    appendToSheet(currentSite, app.name, tabToSend, app.slug || '', '');
    if (retryBtn) retryBtn.style.display = 'none';
    return true;
  } else {
    if (btn) {
      btn.innerHTML = '✗';
      btn.style.color = '#f87171';
      btn.style.opacity = '1';
    }
    if (statusEl) {
      statusEl.textContent = `${completedImages}/${totalImages} images downloaded`;
      statusEl.style.color = '#f87171';
    }
    if (retryBtn) retryBtn.style.display = 'flex';
    failedImageApps.add(index);
    document.getElementById('retryAll').style.display = 'block';
    return false;
  }
}

async function downloadAllAppsSequential(indices) {
  const downloadAllBtn = document.getElementById('downloadAll');
  const retryAllBtn = document.getElementById('retryAll');
  const statusBar = document.getElementById('statusBar');
  const [origTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const origUrl = origTab.url;
  // Ensure we're using the correct before.click origin for navigation
  const baseUrl = 'https://before.click';
  const exploreUrl = `${baseUrl}/explore`;

  downloadAllBtn.disabled = true;
  statusBar.style.display = 'block';
  statusBar.textContent = `Starting ${indices.length} apps...`;

  let completedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < indices.length; i++) {
    const index = indices[i];
    const app = allApps[index];
    const btn = document.querySelector(`#video-${index} .btn-download`);
    const statusEl = document.getElementById(`status-${index}`);

    const appTabForHistory = app.tab === 'paywalls' ? 'paywall' : (app.tab || 'aso');
    const historyKey = `${app.name} - ${appTabForHistory}`;
    if (downloadHistory.has(historyKey)) {
      skippedCount++;
      if (statusEl) statusEl.textContent = 'Already Downloaded (Skipped)';
      if (btn) {
        btn.innerHTML = '✓';
        btn.style.color = '#4ade80';
        btn.style.opacity = '0.7';
      }
      continue;
    }

    statusBar.textContent = `Processing app ${i + 1} of ${indices.length}: ${app.name} - ✓ ${completedCount} | ✗ ${errorCount} | ⏩ ${skippedCount}`;

    let success = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0 && statusEl) {
        statusEl.textContent = `Retrying (Attempt ${attempt}/2)...`;
      }

      success = await downloadSingleAppImages(app, index, btn);
      if (success) break;

      await new Promise(r => setTimeout(r, 1000));
    }

    if (success) {
      completedCount++;
    } else {
      errorCount++;
    }

    // Navigate back to explore page between apps and wait for load
    if (i < indices.length - 1) {
      await new Promise((resolve) => {
        chrome.tabs.update(activeTabId, { url: exploreUrl }, () => {
          // Wait for the explore page to load
          setTimeout(resolve, 2000);
        });
      });
    }
  }

  // Return to original page when done
  await new Promise((resolve) => {
    chrome.tabs.update(activeTabId, { url: origUrl }, () => {
      setTimeout(resolve, 1500);
    });
  });

  downloadAllBtn.disabled = false;
  downloadAllBtn.textContent = `Download All (${allApps.length} apps)`;
  statusBar.innerHTML = `Batch Complete: ✓ ${completedCount} done | ⏩ ${skippedCount} skipped | ✗ ${errorCount} failed.`;

  if (failedImageApps.size > 0) {
    retryAllBtn.style.display = 'block';
  } else {
    retryAllBtn.style.display = 'none';
  }
}