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

// Load dotenv dari project (root .env — semua env sudah digabung di sini)
require('dotenv').config();

// (Env TEKO-CAK dulu ada di automated-tekocak/.env — sekarang digabung ke root .env)

const taskName = process.argv[2] || 'all';
const tekocak = require(path.join(PROJECT_DIR, 'src', 'services', 'tekocak'));

(async () => {
  const result = await tekocak.runTask(taskName);
  console.log(result.output);
  process.exit(result.success ? 0 : 1);
})();
