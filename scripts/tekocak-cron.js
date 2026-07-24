#!/usr/bin/env node
/**
 * Cron task TEKO-CAK — dipanggil dari cronjob Hermes.
 * 
 * Usage:
 *   node tekocak-cron.js generate    # Generate laporan + update
 *   node tekocak-cron.js update      # Update pegawai saja
 *   node tekocak-cron.js all         # Login → Generate → Update
 *
 * Output langsung di stdout — cron no_agent akan deliver ke Telegram.
 */
const path = require('path');

// Pindah ke root project
const PROJECT_DIR = path.resolve(__dirname, '..');
process.chdir(PROJECT_DIR);

// Load dotenv dari project
require('dotenv').config();

// Load env dari automated-tekocak/.env juga
const fs = require('fs');
const tekocakEnvPath = path.join(PROJECT_DIR, 'automated-tekocak', '.env');
if (fs.existsSync(tekocakEnvPath)) {
  const content = fs.readFileSync(tekocakEnvPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

const taskName = process.argv[2] || 'all';
const tekocak = require(path.join(PROJECT_DIR, 'src', 'services', 'tekocak'));

(async () => {
  const result = await tekocak.runTask(taskName);
  console.log(result.output);
  process.exit(result.success ? 0 : 1);
})();
