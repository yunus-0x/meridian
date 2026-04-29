const fs = require('fs');

const FILE = '/root/meridian/priority-mints.json';

function readQueue() {
  if (!fs.existsSync(FILE)) return [];
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

function writeQueue(queue) {
  fs.writeFileSync(FILE, JSON.stringify(queue, null, 2));
}

const mode = process.argv[2] || 'peek'; // peek | use

const queue = readQueue();
const next = queue.find((x) => !x.used);

if (!next) {
  console.log('NO_PRIORITY_MINT');
  process.exit(0);
}

if (mode === 'peek') {
  console.log(JSON.stringify(next, null, 2));
  process.exit(0);
}

if (mode === 'use') {
  next.used = true;
  writeQueue(queue);
  console.log(JSON.stringify(next, null, 2));
  process.exit(0);
}

console.error('Usage: node next-priority-mint.cjs [peek|use]');
process.exit(1);
