// background.js - Service worker handling HLS fetching and coordination with FFmpeg

// Local map to force filenames for Blob URLs (overcoming Chromium cross-context stripping)
const blobNameMap = new Map();

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (blobNameMap.has(item.url)) {
    suggest({ filename: blobNameMap.get(item.url), conflictAction: 'uniquify' });
  } else {
    suggest();
  }
});

// Helper to interact with IndexedDB from background script
async function idbPut(id, buffer) {
  return new Promise((resolve, reject) => {
    const requestDb = indexedDB.open('MuxDownloaderDB', 1);
    requestDb.onupgradeneeded = e => e.target.result.createObjectStore('blobs');
    requestDb.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put(buffer, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('IDB put failed'));
    };
    requestDb.onerror = () => reject(new Error('IDB open failed'));
  });
}

// Function to ensure offscreen document exists
let downloadCountSinceRestart = 0;
const RESTART_THRESHOLD = 50;

async function ensureOffscreenDocument(forceRestart = false) {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  
  if (forceRestart && contexts.length > 0) {
    await chrome.offscreen.closeDocument();
  } else if (contexts.length > 0) {
    return;
  }
  
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_PARSER', 'BLOBS', 'LOCAL_STORAGE'],
    justification: 'FFmpeg wasm requires DOM APIs and IndexedDB for video processing.'
  });
  downloadCountSinceRestart = 0;
}

function parseRenditionPlaylist(text, baseUrl) {
  const lines = text.split('\n');
  const segments = [];
  let initUrl = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-MAP:URI=')) {
      const match = line.match(/URI="([^"]+)"/);
      if (match) initUrl = new URL(match[1], baseUrl).href;
    } else if (line && !line.startsWith('#')) {
      segments.push(new URL(line, baseUrl).href);
    }
  }
  return { initUrl, segments };
}

// Fetches all segments of a Mux video and combines them
async function fetchVideoData(playbackId, sendProgress) {
  const masterUrl = `https://stream.mux.com/${playbackId}.m3u8`;
  
  sendProgress('Fetching master manifest...');
  const masterResp = await fetch(masterUrl);
  if (!masterResp.ok) throw new Error('Master manifest failed');
  const masterText = await masterResp.text();

  // Pick highest quality rendition and separate audio if present
  let videoUrl = masterUrl;
  let audioUrl = null;

  const lines = masterText.split('\n');
  let bestBandwidth = 0;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
      const codecMatch = lines[i].match(/CODECS="([^"]+)"/);
      const bandwidth = bwMatch ? parseInt(bwMatch[1]) : 0;
      
      // If we see CODECS property, it's a variant playlist
      const nextLine = lines[i+1]?.trim();
      if (nextLine && !nextLine.startsWith('#')) {
          if (bandwidth > bestBandwidth) {
            bestBandwidth = bandwidth;
            videoUrl = new URL(nextLine, masterUrl).href;
          }
      }
    }
    if (lines[i].startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) {
      const uriMatch = lines[i].match(/URI="([^"]+)"/);
      if (uriMatch) audioUrl = new URL(uriMatch[1], masterUrl).href;
    }
  }

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
    const ext = videoData.isMp4 ? '.mp4' : '.ts';
    const mimeType = videoData.isMp4 ? 'video/mp4' : 'video/MP2T';
    const type = videoData.isMp4 ? 'hls' : 'hls-ts-to-mp4';
    return { type, combined: videoData.combined, ext: '.mp4', mimeType: 'video/mp4' };
  }
}

async function executeDownload(videoData, intendedName, sendProgress) {
  let downloadUrl = videoData.url;
  let isBlob = false;

  if (videoData.type === 'hls-demuxed' || videoData.type === 'hls' || videoData.type === 'hls-ts-to-mp4') {
    downloadCountSinceRestart++;
    const shouldRestart = downloadCountSinceRestart >= RESTART_THRESHOLD;
    await ensureOffscreenDocument(shouldRestart);
    
    if (videoData.type === 'hls-demuxed') {
      sendProgress('Combining audio & video frames...');
      const videoId = 'video_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
      const audioId = 'audio_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
      
      await idbPut(videoId, videoData.videoCombined.buffer);
      await idbPut(audioId, videoData.audioCombined.buffer);

      try {
        const resp = await chrome.runtime.sendMessage({
          action: 'muxAndCreateBlobUrl',
          videoId,
          audioId
        });

        if (!resp || !resp.blobUrl) {
          throw new Error('Failed to create file: ' + (resp ? (resp.error || 'No blob URL') : 'Unknown'));
        }
        downloadUrl = resp.blobUrl;
        isBlob = true;
      } catch (err) {
        await ensureOffscreenDocument(true);
        throw err;
      }

    } else if (videoData.type === 'hls-ts-to-mp4') {
      sendProgress('Converting TS to MP4 container...');
      const videoId = 'video_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
      await idbPut(videoId, videoData.combined.buffer);

      try {
        const resp = await chrome.runtime.sendMessage({
          action: 'convertTsToMp4',
          videoId
        });

        if (!resp || !resp.blobUrl) {
          throw new Error('Failed to create file: ' + (resp ? (resp.error || 'No blob URL') : 'Unknown'));
        }
        downloadUrl = resp.blobUrl;
        isBlob = true;
      } catch (err) {
        await ensureOffscreenDocument(true);
        throw err;
      }

    } else if (videoData.type === 'hls') {
      sendProgress('Preparing merged file...');
      const blobId = 'video_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
      await idbPut(blobId, videoData.combined.buffer);

      try {
        const resp = await chrome.runtime.sendMessage({
          action: 'createBlobUrlFromIdb',
          id: blobId,
          mimeType: videoData.mimeType
        });

        if (!resp || !resp.blobUrl) {
          throw new Error('Failed to create file: ' + (resp ? (resp.error || 'No blob URL') : 'Unknown'));
        }
        downloadUrl = resp.blobUrl;
        isBlob = true;
      } catch (err) {
        await ensureOffscreenDocument(true);
        throw err;
      }
    }
  }

  const finalFilename = `mux-videos/${intendedName}`;
  
  if (isBlob) {
    blobNameMap.set(downloadUrl, finalFilename);
  }

  sendProgress('Downloading via Chrome...');

  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: downloadUrl,
      filename: finalFilename,
      conflictAction: 'uniquify',
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        if (isBlob) blobNameMap.delete(downloadUrl);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      const listener = async (delta) => {
        if (delta.id === downloadId && delta.state) {
          if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(listener);
            
            if (isBlob) {
              blobNameMap.delete(downloadUrl);
              chrome.runtime.sendMessage({ action: 'revokeBlobUrl', url: downloadUrl }).catch(()=>{});
            }

            if (delta.state.current === 'complete') {
              resolve();
            } else {
              reject(new Error('Download interrupted.'));
            }
          }
        }
      };
      
      chrome.downloads.onChanged.addListener(listener);
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
});
