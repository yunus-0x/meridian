import "dotenv/config";
import fs from "fs";
import { fetchDlmmPnlForPool, deployPosition, getMyPositions } from "./tools/dlmm.js";

const userConfig = JSON.parse(fs.readFileSync("./user-config.json", "utf8"));
const SIGNAL_FILE = "./mirror-signal.json";

const wallets = JSON.parse(
  fs.readFileSync("./smart-mirror-wallets.json", "utf8")
).leaderWallets;

function getCopySize() {
  return Number(userConfig.mirrorCopySizeSol || 0.1);
}
async function getPortfolio(wallet) {
  const res = await fetch(
    `https://dlmm.datapi.meteora.ag/portfolio/open?user=${wallet}`
  );
  return res.json();
}

async function loop() {
  console.log("START LOOP");
let deployedCount = 0;
const MAX_MIRRORS_PER_RUN = 2;

const myPositions = await getMyPositions({ force: true, silent: true });
const openPools = new Set((myPositions.positions || []).map((p) => p.pool));
const openPositionCount = (myPositions.positions || []).length;
const MAX_OPEN_POSITIONS = 3;

  for (const wallet of wallets) {
    console.log("CHECK WALLET:", wallet);

    const portfolio = await getPortfolio(wallet);
    const pools = portfolio.pools || [];
    console.log("POOLS FOUND:", pools.length);

    for (const pool of pools) {
      const balancesSol = Number(pool.balancesSol || 0);
      console.log("POOL:", pool.poolAddress, "balancesSol:", balancesSol, "outOfRange:", pool.outOfRange);

      if (pool.outOfRange) continue;
      if (balancesSol < 0.5) continue;

      console.log("FETCHING PNL FOR:", pool.poolAddress);

      const pnlData = await fetchDlmmPnlForPool(pool.poolAddress, wallet);
      console.log("PNL KEYS:", pnlData ? Object.keys(pnlData).length : 0);

      for (const positionId of (pool.listPositions || [])) {
        console.log("POSITION:", positionId);

        const binData = pnlData?.[positionId];
        console.log("BINDATA:", binData);

        if (!binData) continue;

        const lowerBin = binData.lowerBinId;
        const upperBin = binData.upperBinId;

        if (!lowerBin || !upperBin) continue;

const copySize = getCopySize();
if (copySize <= 0) continue;

if (openPositionCount + deployedCount >= MAX_OPEN_POSITIONS) {
  console.log("SKIP: max open positions reached");
  continue;
}

if (openPools.has(pool.poolAddress)) {
  console.log("SKIP: already have position in this pool");
  continue;
}

if (deployedCount >= MAX_MIRRORS_PER_RUN) {
  console.log("SKIP: max mirrors per run reached");
  continue;
}
let lastSignal = null;

if (fs.existsSync(SIGNAL_FILE)) {
  try {
    lastSignal = JSON.parse(fs.readFileSync(SIGNAL_FILE, "utf8"));
  } catch {}
}
const signal = {
  wallet,
  pool: pool.poolAddress,
  tokenX: pool.tokenX,
  tokenY: pool.tokenY,
  lowerBin,
  upperBin,
  balancesSol,
  suggestedCopySizeSol: copySize,
  detectedAt: new Date().toISOString()
};

if (
  lastSignal &&
  lastSignal.wallet === signal.wallet &&
  lastSignal.pool === signal.pool &&
  lastSignal.lowerBin === signal.lowerBin &&
  lastSignal.upperBin === signal.upperBin
) {
  console.log("SKIP: duplicate signal");
  continue;
}

console.log("FULL MIRROR SIGNAL:");
console.log(signal);

fs.writeFileSync(SIGNAL_FILE, JSON.stringify(signal, null, 2));
console.log("Saved mirror signal to mirror-signal.json");
const activeBin = binData.poolActiveBinId;

const binsBelow = activeBin - lowerBin;
const binsAbove = 0;

console.log("DRY RUN DEPLOY INPUT:");
console.log({
  pool_address: pool.poolAddress,
  amount_sol: copySize,
  bins_below: binsBelow,
  bins_above: binsAbove,
  strategy: "spot"
});
const deployResult = await deployPosition({
  pool_address: pool.poolAddress,
  amount_sol: copySize,
  bins_below: binsBelow,
  bins_above: binsAbove,
  strategy: "spot"
});

deployedCount++;

console.log("DEPLOY RESULT:");
console.log(deployResult);
break;
      }
    }
  }
}

loop().catch(err => {
  console.error("SCRIPT ERROR:", err);
});
