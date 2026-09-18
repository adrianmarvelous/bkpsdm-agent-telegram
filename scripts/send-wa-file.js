#!/usr/bin/env node
/**
 * Kirim berkas CSV/dokumen sekali pakai ke satu nomor WA.
 * Pakai session auth_info yang sudah ada (src/whatsapp/auth_info).
 *
 *   node scripts/send-wa-file.js <nomor> <path-file> [caption]
 *
 * ⚠️ JANGAN jalan bareng index-wa.js (session sama → konflik).
 *    Stop bkpsdm-wa dulu, kirim, lalu start lagi.
 */
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');

const number = process.argv[2];
const jalur = process.argv[3];
const caption = process.argv[4] || '';

if (!number || !jalur) {
  console.error('Gunakan: node scripts/send-wa-file.js <nomor> <path-file> [caption]');
  process.exit(1);
}
if (!fs.existsSync(jalur)) {
  console.error('❌ Berkas tidak ditemukan:', jalur);
  process.exit(1);
}

const jid = `${number.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
const ext = path.extname(jalur).toLowerCase();
const mimetype = ext === '.xlsx'
  ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  : ext === '.csv' ? 'text/csv'
  : ext === '.pdf' ? 'application/pdf'
  : 'application/octet-stream';

(async () => {
  const AUTH_DIR = path.join(__dirname, '..', 'src', 'whatsapp', 'auth_info');
  const { state } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  const timeout = setTimeout(() => {
    console.error('⏳ Timeout: tidak terhubung dalam 60 detik.');
    process.exit(1);
  }, 60000);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      clearTimeout(timeout);
      console.log('✅ Terhubung ke WhatsApp, mengirim berkas ke', jid);
      try {
        const sent = await sock.sendMessage(jid, {
          document: fs.readFileSync(jalur),
          fileName: path.basename(jalur),
          mimetype,
          caption: caption || undefined,
        });
        console.log('✅ Berkas terkirim →', jid, '|', path.basename(jalur), '| id:', sent?.key?.id);
      } catch (err) {
        console.error('❌ Gagal kirim:', err.message);
        process.exitCode = 1;
      } finally {
        setTimeout(() => { sock.end(); process.exit(process.exitCode || 0); }, 3000);
      }
    }
    if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
      clearTimeout(timeout);
      console.error('❌ Koneksi tertutup:', lastDisconnect?.error?.message || '');
      process.exit(1);
    }
  });
})();
