/**
 * Market Mode System
 *
 * Preset parameter bundles for different market conditions.
 * Set the mode via Telegram, REPL, or the set_market_mode tool.
 *
 * Modes:
 *   auto         — Use base config values (no preset applied)
 *   bullish      — Token trending up; deploy bins above & below, take profit sooner
 *   bearish      — Market falling; single-sided below only, exit fast
 *   sideways     — Range-bound; balanced bins, standard settings
 *   volatile     — High volatility; wide range, high profit target, loose OOR wait
 *   conservative — Safe mode; tight filters, small range, fast exit
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

// ─── Preset Definitions ──────────────────────────────────────────

export const MARKET_PRESETS = {
  bullish: {
    description: "Harga trending naik. Deploy bins di atas & bawah harga, take-profit lebih tinggi.",
    // Strategy
    binsAbove: 20,           // Deploy 20 bins atas harga untuk tangkap upside fee
    // Management
    stopLossPct: -25,        // Stop loss lebih ketat dari default -50%
    trailingTriggerPct: 5,   // Aktifkan trailing setelah +5% profit
    trailingDropPct: 2.0,    // Keluar jika turun 2% dari peak
    outOfRangeWaitMinutes: 20, // OOR di atas → keluar lebih cepat (token sudah naik)
    // Screening
    maxVolatility: 8,        // Izinkan volatility lebih tinggi (pasar aktif)
    minVolume: 1000,         // Volume minimum lebih tinggi
  },

  bearish: {
    description: "Market turun. Deploy hanya ke bawah harga, stop loss ketat, keluar cepat.",
    // Strategy
    binsAbove: 0,            // Jangan deploy di atas harga (token akan turun)
    // Management
    stopLossPct: -20,        // Stop loss sangat ketat
    trailingTriggerPct: 2,   // Trailing profit lebih rendah (ambil profit lebih cepat)
    trailingDropPct: 1.0,    // Keluar segera jika drop 1% dari peak
    outOfRangeWaitMinutes: 15, // Keluar lebih cepat jika OOR
    // Screening
    maxVolatility: 5,        // Hindari pool terlalu volatile
    minVolume: 1500,         // Butuh volume lebih tinggi untuk konfirmasi activity
  },

  sideways: {
    description: "Harga sideways dalam range. Posisi balanced, sabar untuk fee.",
    // Strategy
    binsAbove: 10,           // Sedikit bins di atas untuk capture fee kedua arah
    // Management
    stopLossPct: -30,        // Stop loss moderat
    trailingTriggerPct: 3,   // Standard trailing trigger
    trailingDropPct: 1.5,    // Standard drop tolerance
    outOfRangeWaitMinutes: 30, // Tunggu lebih lama (harga cenderung balik)
    // Screening
    maxVolatility: 6,        // Volatility sedang
    minVolume: 500,          // Volume normal
  },

  volatile: {
    description: "Pasar sangat volatile. Range lebar kedua arah, target profit tinggi.",
    // Strategy
    binsAbove: 30,           // Range lebar di atas untuk tangkap swing
    // Management
    stopLossPct: -40,        // Stop loss longgar (volatile butuh ruang gerak)
    trailingTriggerPct: 8,   // Trailing trigger tinggi (tunggu move besar)
    trailingDropPct: 3.0,    // Toleransi drop lebih besar
    outOfRangeWaitMinutes: 45, // Tunggu lebih lama sebelum close OOR
    // Screening
    maxVolatility: 10,       // Izinkan pool sangat volatile
    minVolume: 3000,         // Volume tinggi = activity nyata pada volatile market
  },

  conservative: {
    description: "Mode aman. Filter ketat, exit cepat, lindungi modal.",
    // Strategy
    binsAbove: 0,            // Single-sided below only
    // Management
    stopLossPct: -15,        // Stop loss sangat ketat
    trailingTriggerPct: 2,   // Ambil profit cepat
    trailingDropPct: 1.0,    // Exit cepat jika balik turun
    outOfRangeWaitMinutes: 15, // Keluar cepat jika OOR
    // Screening (filter lebih ketat)
    maxVolatility: 4,        // Hanya pool stabil
    minVolume: 2000,         // Volume solid dibutuhkan
    minOrganic: 75,          // Organic score lebih tinggi dari default 60
    minHolders: 1000,        // Holders lebih banyak dari default 500
  },
};

export const VALID_MODES = ["auto", ...Object.keys(MARKET_PRESETS)];

// ─── Set Market Mode ─────────────────────────────────────────────

/**
 * Set market mode and persist preset values to user-config.json.
 * The bot must be restarted (or update_config called) for full effect.
 * Screening changes take effect immediately via reloadScreeningThresholds().
 */
export function setMarketMode(mode, { applyToConfig = null } = {}) {
  if (!VALID_MODES.includes(mode)) {
    return {
      success: false,
      error: `Mode '${mode}' tidak valid. Pilihan: ${VALID_MODES.join(", ")}`,
    };
  }

  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /**/ }
  }

  userConfig.marketMode = mode;

  if (mode !== "auto") {
    const preset = MARKET_PRESETS[mode];
    // Persist all preset values (except internal description) to user-config
    for (const [k, v] of Object.entries(preset)) {
      if (k !== "description") userConfig[k] = v;
    }
  }

  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));
  log("market_mode", `Market mode → ${mode}`);

  // Optionally apply to live config immediately (when config object is passed)
  if (applyToConfig && mode !== "auto") {
    applyPresetToConfig(MARKET_PRESETS[mode], applyToConfig);
  }

  const preset = mode === "auto" ? null : MARKET_PRESETS[mode];
  return {
    success: true,
    mode,
    preset,
    applied_keys: preset ? Object.keys(preset).filter(k => k !== "description") : [],
    message: mode === "auto"
      ? "Market mode direset ke auto — menggunakan nilai config dasar."
      : `Preset '${mode}' diterapkan: ${preset.description}`,
    note: "Perubahan management (stopLoss, trailing, OOR) aktif setelah restart. Screening aktif sekarang.",
  };
}

// ─── Get Market Mode ─────────────────────────────────────────────

export function getMarketMode() {
  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /**/ }
  }
  const mode = userConfig.marketMode || "auto";
  const preset = mode === "auto" ? null : MARKET_PRESETS[mode];

  return {
    current_mode: mode,
    description: mode === "auto" ? "Menggunakan nilai config dasar" : preset.description,
    active_preset: preset ? Object.fromEntries(Object.entries(preset).filter(([k]) => k !== "description")) : null,
    available_modes: VALID_MODES.map(m => ({
      name: m,
      description: m === "auto" ? "Gunakan nilai config dasar (tidak ada preset)" : MARKET_PRESETS[m].description,
    })),
  };
}

// ─── Apply Preset to Live Config ────────────────────────────────

/**
 * Apply a preset's values directly to the live config object.
 * Called on startup to restore persisted market mode.
 */
export function applyPresetToConfig(preset, config) {
  if (!preset || !config) return;

  if (preset.binsAbove              != null) config.strategy.binsAbove               = preset.binsAbove;
  if (preset.stopLossPct            != null) config.management.stopLossPct            = preset.stopLossPct;
  if (preset.trailingTriggerPct     != null) config.management.trailingTriggerPct     = preset.trailingTriggerPct;
  if (preset.trailingDropPct        != null) config.management.trailingDropPct        = preset.trailingDropPct;
  if (preset.outOfRangeWaitMinutes  != null) config.management.outOfRangeWaitMinutes  = preset.outOfRangeWaitMinutes;
  if (preset.maxVolatility          != null) config.screening.maxVolatility           = preset.maxVolatility;
  if (preset.minVolume              != null) config.screening.minVolume               = preset.minVolume;
  if (preset.minOrganic             != null) config.screening.minOrganic              = preset.minOrganic;
  if (preset.minHolders             != null) config.screening.minHolders              = preset.minHolders;
}

/**
 * Apply the persisted market mode from user-config.json to the live config.
 * Call this once on startup after config is loaded.
 */
export function applyMarketModeOnStartup(config) {
  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { return; }
  }
  const mode = userConfig.marketMode;
  if (!mode || mode === "auto") return;

  const preset = MARKET_PRESETS[mode];
  if (!preset) return;

  log("market_mode", `Startup: restoring market mode '${mode}'`);
  applyPresetToConfig(preset, config);
}
