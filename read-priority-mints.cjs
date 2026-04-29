const fs = require('fs');

const FILE = '/root/meridian/priority-mints.json';

if (!fs.existsSync(FILE)) {
  console.log('No priority queue yet.');
  process.exit(0);
}

const queue = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const active = queue.filter((x) => !x.used);

if (!active.length) {
  console.log('No unused priority mints.');
  process.exit(0);
}

console.log('Priority mints:');
for (const item of active) {
  console.log(
    `${item.symbol} | ${item.mint} | wallet=${item.wallet} | source=${item.source}`
  );
}
