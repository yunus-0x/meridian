const fs = require('fs');

const QUEUE_FILE = '/root/meridian/priority-mints.json';
const ACTIVE_FILE = '/root/meridian/active-priority-mint.json';

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const queue = readJson(QUEUE_FILE, []);
const next = queue.find((x) => !x.used);

if (!next) {
  console.log('NO_PRIORITY_MINT');
  process.exit(0);
}

writeJson(ACTIVE_FILE, next);
next.used = true;
writeJson(QUEUE_FILE, queue);

console.log('ACTIVE_PRIORITY_MINT_SET');
console.log(JSON.stringify(next, null, 2));
