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
        sendResponse({ blobUrl: null, error: 'Buffer not found' });
        return;
      }
      const blob = new Blob([buffer], { type: request.mimeType || 'video/mp4' });
      sendResponse({ blobUrl: URL.createObjectURL(blob) });
      deleteFromIdb(request.id);
    }).catch(err => {
      sendResponse({ blobUrl: null, error: err.message });
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
        
        // Cleanup memory
        await ffmpeg.deleteFile('video.ts');
        await ffmpeg.deleteFile('audio.ts');
        await ffmpeg.deleteFile('output.mp4');
        
        deleteFromIdb(request.videoId);
        deleteFromIdb(request.audioId);
        
        sendResponse({ blobUrl: url });
      } catch (err) {
        console.error('Mux error:', err);
        sendResponse({ blobUrl: null, error: err.message });
      }
    })();
    return true;
  }
});
