#!/usr/bin/env node
/**
 * Kirim pesan WhatsApp sekali pakai — memakai session auth_info yang sudah ada.
 *
 *   node scripts/send-wa.js <nomor> <pesan...>
 *   node scripts/send-wa.js 6282244649994 "ini ai agent BKPSDM"
 *
 * CATATAN:
 *   - JANGAN dijalankan bersamaan dengan index-wa.js (session sama → konflik).
 *     Stop bot dulu, kirim, lalu start lagi.
 *   - Tidak memanggil sock.logout() — session tetap aman.
 */
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const path = require('path');

const number = process.argv[2];
const message = process.argv.slice(3).join(' ');
if (!number || !message) {
  console.error('Gunakan: node scripts/send-wa.js <nomor> <pesan>');
  process.exit(1);
}
const jid = `${number.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

(async () => {
  const AUTH_DIR = path.join(__dirname, '..', 'src', 'whatsapp', 'auth_info');
  const { state } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  const timeout = setTimeout(() => {
    console.error('⏳ Timeout: tidak terhubung dalam 30 detik.');
    process.exit(1);
  }, 30000);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      clearTimeout(timeout);
      console.log('✅ Terhubung ke WhatsApp, mengirim ke', jid);
      try {
        await sock.sendMessage(jid, { text: message });
        console.log('✅ Pesan terkirim →', jid, ':', message);
      } catch (err) {
        console.error('❌ Gagal kirim:', err.message);
      } finally {
        // Tunggu sebentar agar pesan benar-benar terkirim sebelum menutup koneksi
        setTimeout(() => {
          sock.end();
          process.exit(0);
        }, 2000);
      }
    }
    if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
      clearTimeout(timeout);
      console.error('❌ Koneksi tertutup:', lastDisconnect?.error?.message || '');
      process.exit(1);
    }
  });
})();
