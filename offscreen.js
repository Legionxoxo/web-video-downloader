// offscreen.js - Runs in a hidden document to provide DOM APIs and run FFmpeg WASM

let ffmpeg = null;

async function initFfmpeg() {
  if (ffmpeg) return;
  const { FFmpeg } = window.FFmpegWASM;
  ffmpeg = new FFmpeg();
  
  ffmpeg.on('log', ({ message }) => {
    // console.log('FFmpeg:', message);
  });
  
  await ffmpeg.load({
    coreURL: chrome.runtime.getURL('ffmpeg/ffmpeg-core.js'),
    wasmURL: chrome.runtime.getURL('ffmpeg/ffmpeg-core.wasm')
  });
}

function getFromIdb(id) {
  return new Promise((resolve, reject) => {
    const requestDb = indexedDB.open('MuxDownloaderDB', 1);
    requestDb.onupgradeneeded = e => e.target.result.createObjectStore('blobs');
    requestDb.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction('blobs', 'readonly');
      const getReq = tx.objectStore('blobs').get(id);
      getReq.onsuccess = () => resolve(getReq.result);
      getReq.onerror = () => reject(new Error('IDB get failed'));
    };
    requestDb.onerror = () => reject(new Error('IDB open failed'));
  });
}

function deleteFromIdb(id) {
  const requestDb = indexedDB.open('MuxDownloaderDB', 1);
  requestDb.onsuccess = e => {
    const db = e.target.result;
    const delTx = db.transaction('blobs', 'readwrite');
    delTx.objectStore('blobs').delete(id);
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'createBlobUrl') {
    const blob = new Blob([new Uint8Array(request.data)], { type: request.mimeType || 'video/mp4' });
    sendResponse({ blobUrl: URL.createObjectURL(blob) });
    return false;
  }
  
  if (request.action === 'createBlobUrlFromIdb') {
    getFromIdb(request.id).then(buffer => {
      if (!buffer) {
        sendResponse({ error: 'Buffer not found' });
        return;
      }
      const blob = new Blob([buffer], { type: request.mimeType || 'video/mp4' });
      sendResponse({ blobUrl: URL.createObjectURL(blob) });
      deleteFromIdb(request.id);
    }).catch(err => {
      sendResponse({ error: err.message });
    });
    return true;
  }
  
  if (request.action === 'muxAndCreateBlobUrl') {
    (async () => {
      try {
        await initFfmpeg();
        
        const videoBuffer = await getFromIdb(request.videoId);
        const audioBuffer = await getFromIdb(request.audioId);
        
        if (!videoBuffer || !audioBuffer) {
          throw new Error('Missing video or audio buffer in IDB');
        }
        
        await ffmpeg.writeFile('video.ts', new Uint8Array(videoBuffer));
        await ffmpeg.writeFile('audio.ts', new Uint8Array(audioBuffer));
        
        // Mux them without re-encoding (-c copy) to generate standard MP4
        await ffmpeg.exec(['-i', 'video.ts', '-i', 'audio.ts', '-c', 'copy', 'output.mp4']);
        
        const mp4Data = await ffmpeg.readFile('output.mp4');
        
        const blob = new Blob([mp4Data.buffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        
        // Cleanup memory in FFmpeg
        ffmpeg.deleteFile('video.ts').catch(()=>{});
        ffmpeg.deleteFile('audio.ts').catch(()=>{});
        ffmpeg.deleteFile('output.mp4').catch(()=>{});
        deleteFromIdb(request.videoId);
        deleteFromIdb(request.audioId);
        
        sendResponse({ blobUrl: url });
      } catch (err) {
        console.error('Mux error:', err);
        sendResponse({ error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (request.action === 'convertTsToMp4') {
    (async () => {
      try {
        await initFfmpeg();
        
        const videoBuffer = await getFromIdb(request.videoId);
        
        if (!videoBuffer) {
          throw new Error('Missing video buffer in IDB');
        }
        
        await ffmpeg.writeFile('video.ts', new Uint8Array(videoBuffer));
        
        // Convert to standard MP4 container instantly
        await ffmpeg.exec(['-i', 'video.ts', '-c', 'copy', 'output.mp4']);
        
        const mp4Data = await ffmpeg.readFile('output.mp4');
        
        const blob = new Blob([mp4Data.buffer], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        
        // Cleanup memory in FFmpeg
        ffmpeg.deleteFile('video.ts').catch(()=>{});
        ffmpeg.deleteFile('output.mp4').catch(()=>{});
        deleteFromIdb(request.videoId);
        
        sendResponse({ blobUrl: url });
      } catch (err) {
        console.error('Convert error:', err);
        sendResponse({ error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (request.action === 'revokeBlobUrl') {
    try {
      URL.revokeObjectURL(request.url);
      sendResponse({ success: true });
    } catch (err) {
      sendResponse({ success: false, error: err.message || String(err) });
    }
    return false;
  }
});
