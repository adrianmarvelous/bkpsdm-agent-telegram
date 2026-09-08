// pair-wa.js — Request WhatsApp pairing code untuk bot BKPSDM (unified)
// Pakai: node pair-wa.js [nomor-internasional-tanpa-plus]
// Sesi disimpan ke src/whatsapp/auth_info (AUTH_DIR bot.js)
//
// ALUR BENAR (pelajaran 6 & 8 Sep 2026):
// 1. requestPairingCode → user masukkan kode di HP → "pairing configured successfully"
// 2. WhatsApp RESTART koneksi (error 515) — ini NORMAL, JANGAN exit di sini.
//    Kalau exit di sini, device terdaftar SETENGAH JADI (creds.json saja, tanpa
//    pre-keys) → koneksi berikutnya selalu ditolak 401 loggedOut.
// 3. Reconnect → selesaikan login (upload pre-keys) → connection 'open'
//    = "✅ LINKED & CONNECTED" → BARU exit.
// Aturan: TIDAK PERNAH request kode pairing kalau state.creds.registered sudah true
// (kode ganda = WhatsApp invalidate device). Reconnect setelah registered TIDAK
// memicu kode baru karena ada guard di timer.
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const path = require('path');

const PHONE = process.argv[2] || '628217337638';
const AUTH_DIR = path.join(__dirname, 'src', 'whatsapp', 'auth_info');
const fs = require('fs');
const START = Date.now();
const MAX_MS = 300000; // batas total 5 menit, sesudahnya exit
let firstRun = true; // hanya cek session-lama di invokasi pertama; reconnect (pasca-515) tidak boleh exit

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (firstRun) {
    firstRun = false;
    if (state.creds?.registered) {
      const me = state.creds.me?.id || '?';
      const hasKeys = fs.existsSync(path.join(AUTH_DIR, 'session-' + state.creds.me?.id?.replace(':', '_') + '.json'));
      if (!hasKeys) {
        console.log('⚠️ Session ' + me + ' terdaftar tapi TIDAK lengkap (tanpa pre-keys — korban exit-dini bug lama).');
        console.log('→ Hapus folder auth_info/ dulu, lalu jalankan ulang untuk pairing fresh.');
        process.exit(1);
      }
      console.log('⚠️ Session sudah terdaftar & lengkap (' + me + '). Tidak perlu pairing.');
      console.log('→ Start bot langsung: pm2 start bkpsdm-wa');
      process.exit(0);
    }
  }

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '126.0.0.1'],
  });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log('✅ LINKED & CONNECTED: ' + (sock.user?.id || '?'));
      setTimeout(() => process.exit(0), 2000);
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      if (status === DisconnectReason.loggedOut) {
        console.log('⚠️ loggedOut (401) — session tidak valid. Hapus auth_info/, lalu jalankan ulang.');
        process.exit(1);
      }
      if (Date.now() - START > MAX_MS) {
        console.log('⏱ Waktu habis (' + MAX_MS / 1000 + 's). Jalankan ulang.');
        process.exit(1);
      }
      // 515 (restart setelah pairing) / 503 / network drop: reconnect.
      // Kalau sudah registered, reconnect hanya menyelesaikan login (guard timer
      // mencegah request kode baru). Kalau belum, ini siklus QR/code normal.
      console.log('❌ Koneksi tertutup (status ' + status + (state.creds?.registered ? ', session terdaftar — menyelesaikan login' : ', belum terdaftar') + ') — reconnect dalam 3 detik...');
      try { sock.end(undefined); } catch (e) {}
      setTimeout(start, 3000);
    }
  });

  setTimeout(async () => {
    if (state.creds?.registered) {
      console.log('ℹ️ Session sudah terdaftar saat proses berjalan — tidak minta kode pairing.');
      return;
    }
    try {
      console.log('⏳ Requesting pairing code for ' + PHONE + ' ...');
      const code = await sock.requestPairingCode(PHONE);
      console.log('🔑 PAIRING CODE: ' + code);
      console.log('→ Masukkan di HP: WhatsApp > Linked Devices > "Link with phone number instead"');
    } catch (e) {
      console.error('❌ requestPairingCode error: ' + e.message);
    }
  }, 4000);
}

start();
