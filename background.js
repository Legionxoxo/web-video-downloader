// Background service worker: downloads Mux videos by parsing HLS manifests

// Ensure the offscreen document exists (for blob URL creation)
let creatingOffscreen = null;
async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
  } else {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Create blob URLs for video downloads'
    });
    await creatingOffscreen;
    creatingOffscreen = null;
  }
}

// Parse a master m3u8 playlist and return the highest quality rendition URL
function parseMasterPlaylist(m3u8Text, baseUrl) {
  const lines = m3u8Text.split('\n');
  let bestBandwidth = 0;
  let bestUrl = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      const bandwidth = bwMatch ? parseInt(bwMatch[1]) : 0;
      for (let j = i + 1; j < lines.length; j++) {
        const urlLine = lines[j].trim();
        if (urlLine && !urlLine.startsWith('#')) {
          if (bandwidth > bestBandwidth) {
            bestBandwidth = bandwidth;
            bestUrl = urlLine.startsWith('http') ? urlLine : new URL(urlLine, baseUrl).href;
          }
          break;
        }
      }
    }
  }
  return bestUrl;
}

// Parse a rendition m3u8 and return init segment URL + media segment URLs
function parseRenditionPlaylist(m3u8Text, baseUrl) {
  const lines = m3u8Text.split('\n');
  let initUrl = null;
  const segments = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const mapMatch = trimmed.match(/#EXT-X-MAP:URI="([^"]+)"/);
    if (mapMatch) {
      const uri = mapMatch[1];
      initUrl = uri.startsWith('http') ? uri : new URL(uri, baseUrl).href;
    }
    if (trimmed && !trimmed.startsWith('#')) {
      const url = trimmed.startsWith('http') ? trimmed : new URL(trimmed, baseUrl).href;
      segments.push(url);
    }
  }
  return { initUrl, segments };
}

// Fetch and assemble a video, return as Uint8Array
async function fetchVideoData(playbackId, sendProgress) {
  sendProgress('Fetching manifest...');

  const masterUrl = `https://stream.mux.com/${playbackId}.m3u8`;
  const masterResp = await fetch(masterUrl);
  if (!masterResp.ok) throw new Error(`Master manifest failed: ${masterResp.status}`);
  const masterText = await masterResp.text();

  const renditionUrl = parseMasterPlaylist(masterText, masterUrl);
  if (!renditionUrl) throw new Error('No rendition found in manifest');

  sendProgress('Fetching segment list...');
  const renditionResp = await fetch(renditionUrl);
  if (!renditionResp.ok) throw new Error(`Rendition manifest failed: ${renditionResp.status}`);
  const renditionText = await renditionResp.text();

  const { initUrl, segments } = parseRenditionPlaylist(renditionText, renditionUrl);
  if (segments.length === 0) throw new Error('No segments found');

  const parts = [];
  if (initUrl) {
    sendProgress('Downloading init segment...');
    const initResp = await fetch(initUrl);
    if (!initResp.ok) throw new Error(`Init segment failed: ${initResp.status}`);
    parts.push(await initResp.arrayBuffer());
  }

  for (let i = 0; i < segments.length; i++) {
    sendProgress(`Downloading segment ${i + 1}/${segments.length}...`);
    const segResp = await fetch(segments[i]);
    if (!segResp.ok) throw new Error(`Segment ${i} failed: ${segResp.status}`);
    parts.push(await segResp.arrayBuffer());
  }

  sendProgress('Assembling video...');
  const totalSize = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const combined = new Uint8Array(totalSize);
  let offset = 0;
  for (const part of parts) {
    combined.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }
  return combined;
}

// Download assembled video data, returns the actual filename Chrome saved it as
async function downloadVideoData(combined, sendProgress) {
  sendProgress('Preparing download...');
  await ensureOffscreenDocument();

  const blobUrlResponse = await chrome.runtime.sendMessage({
    action: 'createBlobUrl',
    data: Array.from(combined)
  });

  if (!blobUrlResponse || !blobUrlResponse.blobUrl) {
    throw new Error('Failed to create blob URL');
  }

  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: blobUrlResponse.blobUrl,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      // Wait for download to get a filename, then resolve with the info
      const listener = (delta) => {
        if (delta.id === downloadId && delta.filename) {
          chrome.downloads.onChanged.removeListener(listener);
          chrome.downloads.search({ id: downloadId }, (results) => {
            if (results && results.length > 0) {
              resolve({
                downloadId,
                actualPath: results[0].filename // full path on disk
              });
            } else {
              resolve({ downloadId, actualPath: null });
            }
          });
        }
        // Also handle completion
        if (delta.id === downloadId && delta.state && delta.state.current === 'complete') {
          chrome.downloads.onChanged.removeListener(listener);
          chrome.downloads.search({ id: downloadId }, (results) => {
            if (results && results.length > 0) {
              resolve({
                downloadId,
                actualPath: results[0].filename
              });
            } else {
              resolve({ downloadId, actualPath: null });
            }
          });
        }
      };
      chrome.downloads.onChanged.addListener(listener);

      // Fallback: resolve after a short delay if events don't fire
      setTimeout(() => {
        chrome.downloads.onChanged.removeListener(listener);
        chrome.downloads.search({ id: downloadId }, (results) => {
          if (results && results.length > 0) {
            resolve({
              downloadId,
              actualPath: results[0].filename
            });
          } else {
            resolve({ downloadId, actualPath: null });
          }
        });
      }, 3000);
    });
  });
}

// Generate a rename batch script
function generateRenameBat(mappings) {
  let bat = '@echo off\r\necho Renaming Keyframe Gallery videos...\r\necho.\r\n';

  for (const { actualFilename, intendedName } of mappings) {
    // Escape special batch characters
    const safeActual = actualFilename.replace(/"/g, '""');
    const safeIntended = intendedName.replace(/"/g, '""');
    bat += `if exist "${safeActual}" (\r\n`;
    bat += `  ren "${safeActual}" "${safeIntended}"\r\n`;
    bat += `  echo Renamed: ${safeIntended}\r\n`;
    bat += `) else (\r\n`;
    bat += `  echo SKIP: ${safeActual} not found\r\n`;
    bat += `)\r\n`;
  }

  bat += '\r\necho.\r\necho Done! Press any key to close.\r\npause >nul\r\n';
  return bat;
}

// Track active downloads for progress reporting
const downloadProgress = {};
// Track download mappings for rename script
const downloadMappings = [];

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'downloadVideo') {
    const { playbackId, intendedName } = request;

    (async () => {
      try {
        const combined = await fetchVideoData(playbackId, (status) => {
          downloadProgress[playbackId] = status;
        });

        const result = await downloadVideoData(combined, (status) => {
          downloadProgress[playbackId] = status;
        });

        if (result.actualPath) {
          const actualFilename = result.actualPath.split('\\').pop().split('/').pop();
          downloadMappings.push({ actualFilename, intendedName });
        }

        downloadProgress[playbackId] = 'Complete!';
        sendResponse({ success: true, downloadId: result.downloadId });
      } catch (err) {
        downloadProgress[playbackId] = `Error: ${err.message}`;
        sendResponse({ success: false, error: err.message });
      }
    })();

    return true;
  }

  if (request.action === 'getProgress') {
    sendResponse({ progress: downloadProgress });
    return false;
  }

  if (request.action === 'downloadAll') {
    const { videos } = request;

    (async () => {
      let completed = 0;
      let failed = 0;
      downloadMappings.length = 0; // clear previous

      for (const video of videos) {
        const intendedName = makeIntendedName(video);

        try {
          const combined = await fetchVideoData(video.playbackId, (status) => {
            downloadProgress[video.playbackId] = status;
          });

          const result = await downloadVideoData(combined, (status) => {
            downloadProgress[video.playbackId] = status;
          });

          if (result.actualPath) {
            const actualFilename = result.actualPath.split('\\').pop().split('/').pop();
            downloadMappings.push({ actualFilename, intendedName });
          }

          downloadProgress[video.playbackId] = 'Complete!';
          completed++;
        } catch (err) {
          downloadProgress[video.playbackId] = `Error: ${err.message}`;
          failed++;
        }
      }

      // Generate and download rename script
      if (downloadMappings.length > 0) {
        const batContent = generateRenameBat(downloadMappings);
        const encoder = new TextEncoder();
        const batData = encoder.encode(batContent);

        await ensureOffscreenDocument();
        const blobResp = await chrome.runtime.sendMessage({
          action: 'createBlobUrl',
          data: Array.from(batData),
          mimeType: 'application/bat'
        });

        if (blobResp && blobResp.blobUrl) {
          chrome.downloads.download({
            url: blobResp.blobUrl,
            filename: 'keyframe-videos/rename_videos.bat',
            conflictAction: 'overwrite'
          });
        }
      }

      sendResponse({ success: true, completed, failed, total: videos.length });
    })();

    return true;
  }

  // Generate rename script on demand
  if (request.action === 'generateRenameScript') {
    if (downloadMappings.length === 0) {
      sendResponse({ success: false, error: 'No downloads tracked yet' });
      return false;
    }

    (async () => {
      const batContent = generateRenameBat(downloadMappings);
      const encoder = new TextEncoder();
      const batData = encoder.encode(batContent);

      await ensureOffscreenDocument();
      const blobResp = await chrome.runtime.sendMessage({
        action: 'createBlobUrl',
        data: Array.from(batData),
        mimeType: 'application/bat'
      });

      if (blobResp && blobResp.blobUrl) {
        chrome.downloads.download({
          url: blobResp.blobUrl,
          filename: 'keyframe-videos/rename_videos.bat',
          conflictAction: 'overwrite'
        }, (downloadId) => {
          sendResponse({ success: true });
        });
      } else {
        sendResponse({ success: false, error: 'Could not create rename script' });
      }
    })();

    return true;
  }
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
  return `${safeTitle} - ${safeCompany}.mp4`;
}
