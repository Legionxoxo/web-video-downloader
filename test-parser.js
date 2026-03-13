const fs = require('fs');
const html = fs.readFileSync('keyframe-index.html', 'utf8');

const matches = [];

const phxRegex = /phx-value-playback_id=\"([^\"]+)\"[\s\S]*?phx-value-title=\"([^\"]+)\"[\s\S]*?phx-value-company_name=\"([^\"]+)\"/g;
let m;
while ((m = phxRegex.exec(html)) !== null) {
  matches.push({ type: 'H1', id: m[1], title: m[2], company: m[3] });
}
console.log('H1 found:', matches.length);

const dpRegex = /data-playback-id=\"([^\"]+)\"/g;
let m2;
while ((m2 = dpRegex.exec(html)) !== null) {
  if (!matches.find(x => x.id === m2[1])) {
    matches.push({ type: 'H4', id: m2[1] });
  }
}
console.log('H4 filtered found:', matches.filter(x => x.type === 'H4').length);

const seen = new Set();
const final = [];
matches.forEach(x => {
  if (!seen.has(x.id)) {
    seen.add(x.id);
    final.push({id: x.id, title: x.title, type: x.type});
  }
});

console.log('Total unique videos parsed:', final.length);
console.log('Sample outputs:');
console.log(final.slice(0, 3));
