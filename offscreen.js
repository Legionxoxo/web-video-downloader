// Offscreen script: creates blob URLs from video data
// (URL.createObjectURL is available here but not in MV3 service workers)

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'createBlobUrl') {
    const uint8Array = new Uint8Array(request.data);
    const mimeType = request.mimeType || 'video/mp4';
    const blob = new Blob([uint8Array], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);
    sendResponse({ blobUrl });
  }
  return true;
});
