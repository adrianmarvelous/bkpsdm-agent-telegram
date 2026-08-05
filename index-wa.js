#!/usr/bin/env node
/**
 * BKPSDM Agent — WhatsApp Entry Point (PM2: bkpsdm-wa)
 *
 * Kulit WhatsApp terpisah dari Telegram (index.js) karena session WA fragile:
 * WA putus/tidak harus tidak menggangu proses Telegram. Tapi KODE-nya satu
 * repo, satu core (src/core/dispatcher.js).
 *
 * PM2:
 *   pm2 start index-wa.js --name bkpsdm-wa --cwd /home/ubuntu/bkpsdm-agent-telegram
 */
require('dotenv').config();

const api = require('./src/services/apiClient');
const { startBot } = require('./src/whatsapp/bot');

console.log('🤖 BKPSDM Agent — WhatsApp entry starting...');

// Cek koneksi API saat startup (tidak blocking)
(async () => {
  try {
    const health = await api.healthCheck();
    if (health.databases) {
      health.databases.forEach((db) => {
        if (db.ok) console.log(`  ✅ ${db.name}: ${db.message}`);
        else console.warn(`  ⚠️ ${db.name}: ${db.message} (bot tetap berjalan)`);
      });
    }
  } catch (err) {
    console.warn(`  ⚠️ API Health Check gagal: ${err.message} (bot tetap berjalan)`);
  }
})();

startBot().catch((err) => {
  console.error('Fatal WA error:', err.message);
  process.exit(1);
});
