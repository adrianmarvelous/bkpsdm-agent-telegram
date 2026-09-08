// qr-pair.js — Pairing WhatsApp bot BKPSDM via QR (unified repo)
// QR ditulis ke qr-code.png (di-refresh tiap QR baru, ~20-60 detik sekali)
// + dicetak sebagai ASCII di terminal.
// SINGLE-SHOT semantics: tidak pernah minta pairing code. Begitu ke-link
// (connection open + creds tersimpan) → exit bersih. Bot utama yang lanjut.
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const path = require('path');

const AUTH_DIR = path.join(__dirname, 'src', 'whatsapp', 'auth_info');
const QR_PATH = path.join(__dirname, 'qr-code.png');
const fs = require('fs');
const START = Date.now();
const MAX_MS = 180000; // batas total 3 menit, sesudahnya exit (jalankan ulang utk QR baru)
let firstRun = true; // hanya cek session-lama di invokasi pertama; reconnect (pasca-515) tidak boleh exit

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  if (firstRun) {
    firstRun = false;
    if (state.creds?.registered) {
      const me = state.creds.me?.id || '?';
      const hasKeys = fs.existsSync(path.join(AUTH_DIR, 'session-' + state.creds.me?.id?.replace(':', '_') + '.json'));
      if (!hasKeys) {
        console.log('⚠️ Session ' + me + ' terdaftar tapi TIDAK lengkap (tanpa pre-keys).');
        console.log('→ Hapus folder auth_info/ dulu, lalu jalankan ulang untuk pairing fresh.');
        process.exit(1);
      }
      console.log('⚠️ Session sudah terdaftar & lengkap (' + me + '). Tidak perlu pairing.');
      process.exit(0);
    }
  }

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '126.0.0.1'],
  });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      QRCode.toFile(QR_PATH, qr, { width: 400, margin: 1 }, (err) => {
        if (err) console.error('❌ Gagal tulis QR: ' + err.message);
        else console.log('📱 QR terbaru: ' + QR_PATH + ' | ' + new Date().toISOString());
      });
      QRCode.toString(qr, { type: 'terminal', small: true }, (err, ascii) => {
        if (!err) {
          try { fs.writeFileSync(path.join(__dirname, 'qr-ascii.txt'), ascii); } catch (e) {}
          console.log('━━━ QR ASCII (scan langsung dari layar) ━━━\n' + ascii + '\n━━━━━━━━━━━━━━━━━━━━━━━━');
        }
      });
    }

    if (connection === 'open') {
      console.log('✅ LINKED & CONNECTED: ' + (sock.user?.id || '?'));
      setTimeout(() => process.exit(0), 2000);
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      if (status === DisconnectReason.loggedOut) {
        console.log('⚠️ loggedOut (401) — session tidak valid. Hapus auth_info/ lalu jalankan ulang.');
        process.exit(1);
      }
      if (Date.now() - START > MAX_MS) {
        console.log('⏱ Waktu habis (' + MAX_MS / 1000 + 's). Jalankan ulang untuk QR baru.');
        process.exit(1);
      }
      // 515 (restart setelah pairing) / 503 / network drop: reconnect.
      // Kalau sudah registered, reconnect = menyelesaikan login sampai open
      // (JANGAN exit di 515 — device jadi setengah jadi & ditolak 401 berikutnya).
      // QR hanya muncul kalau belum registered; setelah registered socket baru
      // langsung login (tanpa QR) dan exit di 'open'.
      console.log('❌ Koneksi putus (status ' + status + ') — reconnect dalam 3 detik...');
      try { sock.end(undefined); } catch (e) {}
      setTimeout(start, 3000);
    }
  });

  setTimeout(() => {
    if (Date.now() - START > MAX_MS) {
      console.log('⏱ Waktu habis (3 menit). Jalankan ulang untuk QR baru.');
      process.exit(1);
    }
  }, MAX_MS + 5000);
}

start();
