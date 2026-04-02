const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, 'log.md');
const outputPath = path.join(__dirname, 'history_seed.json');

if (!fs.existsSync(logPath)) {
  console.error('log.md not found');
  process.exit(1);
}

const content = fs.readFileSync(logPath, 'utf8');
const lines = content.split('\n').map(l => l.trim());

const downloadedKeys = [];
let i = 0;

while (i < lines.length) {
  const title = lines[i];
  const company = lines[i + 1];
  const statusLine = lines[i + 2];
  
  if (title && company && statusLine) {
    // Check if it was a success based on the log pattern
    // ✓ → ...
    // or Complete!
    if (statusLine.startsWith('✓') || statusLine.includes('Complete!')) {
      const key = `${title} - ${company}`;
      if (!downloadedKeys.includes(key)) {
        downloadedKeys.push(key);
      }
    }
    
    // Move to next block (blocks are separated by empty lines or variable lengths)
    // Looking at the log, it's roughly 4-5 lines per block
    let nextStart = i + 3;
    while (nextStart < lines.length && lines[nextStart] !== '') {
        nextStart++;
    }
    i = nextStart + 1;
  } else {
    i++;
  }
}

fs.writeFileSync(outputPath, JSON.stringify(downloadedKeys, null, 2));
console.log(`Extracted ${downloadedKeys.length} downloaded videos to history_seed.json`);
