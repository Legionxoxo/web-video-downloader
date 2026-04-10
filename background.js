// Background service worker: downloads Mux videos by parsing HLS manifests

// Save large buffers to IndexedDB to avoid the 64MiB message size limit
function idbPut(id, buffer) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('MuxDownloaderDB', 1);
    request.onupgradeneeded = e => e.target.result.createObjectStore('blobs');
    request.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction('blobs', 'readwrite');
      const putReq = tx.objectStore('blobs').put(buffer, id);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(tx.error);
    };
    request.onerror = e => reject(request.error);
  });
}

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
  let videoUrl = null;
  let audioGroupId = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      const bandwidth = bwMatch ? parseInt(bwMatch[1]) : 0;
      
      const audioMatch = line.match(/AUDIO="([^"]+)"/);
      const currentAudioGroup = audioMatch ? audioMatch[1] : null;

      for (let j = i + 1; j < lines.length; j++) {
        const urlLine = lines[j].trim();
        if (urlLine && !urlLine.startsWith('#')) {
          if (bandwidth > bestBandwidth) {
            bestBandwidth = bandwidth;
            videoUrl = urlLine.startsWith('http') ? urlLine : new URL(urlLine, baseUrl).href;
            audioGroupId = currentAudioGroup;
          }
          break;
        }
      }
    }
  }

  let audioUrl = null;
  if (audioGroupId) {
    // Find the audio track matching this group
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO') && line.includes(`GROUP-ID="${audioGroupId}"`)) {
        const uriMatch = line.match(/URI="([^"]+)"/);
        if (uriMatch) {
           const uri = uriMatch[1];
           audioUrl = uri.startsWith('http') ? uri : new URL(uri, baseUrl).href;
           break;
        }
      }
    }
  }

  return { videoUrl, audioUrl };
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

// Test if native MP4 download is available for this video
async function tryDirectMp4(playbackId, sendProgress) {
  sendProgress('Checking native MP4 availability...');
  const url = `https://stream.mux.com/${playbackId}/high.mp4`;
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (res.ok) {
      return { type: 'direct', url, ext: '.mp4', mimeType: 'video/mp4' };
    }
  } catch (e) {
    // Ignore, fallback to HLS
  }
  return null;
}

// Fetch and assemble a video, return as Uint8Array
async function fetchVideoData(playbackId, sendProgress) {
  const directMp4 = await tryDirectMp4(playbackId, sendProgress);
  if (directMp4) return directMp4;

  // Fallback: Manually download and concatenate HLS streams
  sendProgress('Fetching master manifest...');

  const masterUrl = `https://stream.mux.com/${playbackId}.m3u8`;
  const masterResp = await fetch(masterUrl);
  if (!masterResp.ok) throw new Error(`Master manifest failed: ${masterResp.status}`);
  const masterText = await masterResp.text();

  const { videoUrl, audioUrl } = parseMasterPlaylist(masterText, masterUrl);
  if (!videoUrl) throw new Error('No rendition found in manifest');

  const downloadSegments = async (manifestUrl, label) => {
    sendProgress(`Fetching ${label} segment list...`);
    const resp = await fetch(manifestUrl);
    if (!resp.ok) throw new Error(`${label} manifest failed: ${resp.status}`);
    const { initUrl, segments } = parseRenditionPlaylist(await resp.text(), manifestUrl);
    
    if (segments.length === 0) throw new Error(`No ${label} segments found`);

    const parts = [];
    if (initUrl) {
      sendProgress(`Downloading ${label} init segment...`);
      const initResp = await fetch(initUrl);
      if (!initResp.ok) throw new Error(`${label} Init segment failed`);
      parts.push(await initResp.arrayBuffer());
    }

    for (let i = 0; i < segments.length; i++) {
      sendProgress(`Downloading ${label} segment ${i + 1}/${segments.length}...`);
      const segResp = await fetch(segments[i]);
      if (!segResp.ok) throw new Error(`${label} Segment ${i} failed`);
      parts.push(await segResp.arrayBuffer());
    }

    sendProgress(`Assembling ${label}...`);
    const totalSize = parts.reduce((sum, p) => sum + p.byteLength, 0);
    const combined = new Uint8Array(totalSize);
    let offset = 0;
    for (const part of parts) {
      combined.set(new Uint8Array(part), offset);
      offset += part.byteLength;
    }
    return { combined, isMp4: !!initUrl };
  };

  const videoData = await downloadSegments(videoUrl, 'video');

  let audioData = null;
  if (audioUrl) {
    audioData = await downloadSegments(audioUrl, 'audio');
  }

  if (audioData) {
    return { 
      type: 'hls-demuxed', 
      videoCombined: videoData.combined, 
      audioCombined: audioData.combined,
      ext: '.mp4', 
      mimeType: 'video/mp4' 
    };
  } else {
    // If there is no separate audio stream, it's either video-only, or multiplexed TS.
    const ext = videoData.isMp4 ? '.mp4' : '.ts';
    const mimeType = videoData.isMp4 ? 'video/mp4' : 'video/MP2T';
    return { type: 'hls', combined: videoData.combined, ext, mimeType };
  }
}

// Initiate the chrome download and wait for it to finish
async function executeDownload(videoData, intendedName, sendProgress) {
  let downloadUrl = videoData.url;

  if (videoData.type === 'hls-demuxed') {
    sendProgress('Combining audio & video frames (might take a moment)...');
    await ensureOffscreenDocument();

    const videoId = 'video_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
    const audioId = 'audio_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
    
    await idbPut(videoId, videoData.videoCombined.buffer);
    await idbPut(audioId, videoData.audioCombined.buffer);

    const blobUrlResponse = await chrome.runtime.sendMessage({
      action: 'muxAndCreateBlobUrl',
      videoId,
      audioId
    });

    if (!blobUrlResponse || !blobUrlResponse.blobUrl) {
      throw new Error('Failed to create blob URL: ' + (blobUrlResponse ? blobUrlResponse.error : 'Unknown'));
    }
    downloadUrl = blobUrlResponse.blobUrl;

  } else if (videoData.type === 'hls') {
    sendProgress('Preparing merged file...');
    await ensureOffscreenDocument();

    const blobId = 'video_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
    
    await idbPut(blobId, videoData.combined.buffer);

    const blobUrlResponse = await chrome.runtime.sendMessage({
      action: 'createBlobUrlFromIdb',
      id: blobId,
      mimeType: videoData.mimeType
    });

    if (!blobUrlResponse || !blobUrlResponse.blobUrl) {
      throw new Error('Failed to create blob URL: ' + (blobUrlResponse ? blobUrlResponse.error : 'Unknown'));
    }
    downloadUrl = blobUrlResponse.blobUrl;
  }

  sendProgress('Starting download...');

  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: downloadUrl,
      filename: `mux-videos/${intendedName}`,
      conflictAction: 'uniquify',
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      // Wait for complete
      const listener = (delta) => {
        if (delta.id === downloadId && delta.state) {
          if (delta.state.current === 'complete') {
            chrome.downloads.onChanged.removeListener(listener);
            resolve();
          } else if (delta.state.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(listener);
            reject(new Error('Download interrupted.'));
          }
        }
      };
      
      chrome.downloads.onChanged.addListener(listener);

      const interval = setInterval(() => {
        chrome.downloads.search({ id: downloadId }, (results) => {
          if (results && results.length > 0) {
            const item = results[0];
            if (item.state === 'complete') {
              clearInterval(interval);
              chrome.downloads.onChanged.removeListener(listener);
              resolve();
            } else if (item.state === 'interrupted') {
              clearInterval(interval);
              chrome.downloads.onChanged.removeListener(listener);
              reject(new Error('Download interrupted.'));
            }
          }
        });
      }, 500);
    });
  });
}

function makeIntendedName(video, ext) {
  const safeTitle = (video.title || 'Untitled')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 80);
  const safeCompany = (video.company || 'Unknown')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${safeTitle} - ${safeCompany}${ext || '.mp4'}`;
}

// Track active downloads for progress reporting
const downloadProgress = {};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'downloadVideo') {
    const { video } = request;

    (async () => {
      try {
        const videoData = await fetchVideoData(video.playbackId, (status) => {
          downloadProgress[video.playbackId] = status;
        });

        const intendedName = makeIntendedName(video, videoData.ext);

        await executeDownload(videoData, intendedName, (status) => {
          downloadProgress[video.playbackId] = status;
        });

        downloadProgress[video.playbackId] = 'Complete!';
        sendResponse({ success: true, ext: videoData.ext });
      } catch (err) {
        downloadProgress[video.playbackId] = `Error: ${err.message}`;
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

      for (const video of videos) {
        try {
          const videoData = await fetchVideoData(video.playbackId, (status) => {
            downloadProgress[video.playbackId] = status;
          });

          const intendedName = makeIntendedName(video, videoData.ext);

          await executeDownload(videoData, intendedName, (status) => {
            downloadProgress[video.playbackId] = status;
          });

          downloadProgress[video.playbackId] = 'Complete!';
          completed++;
        } catch (err) {
          downloadProgress[video.playbackId] = `Error: ${err.message}`;
          failed++;
        }
      }

      sendResponse({ success: true, completed, failed, total: videos.length });
    })();

    return true;
  }
});
