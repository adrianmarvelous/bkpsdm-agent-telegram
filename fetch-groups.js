// fetch-groups.js — daftar grup yang diikuti bot (pakai session auth_info yang sama)
// ONE-SHOT: connect → fetch → print → exit. Jangan dijalankan saat bot utama hidup
// (2 koneksi session sama = salah satu di-kick).
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const path = require('path');
const AUTH_DIR = path.join(__dirname, 'src', 'whatsapp', 'auth_info');

(async () => {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  if (!state.creds?.registered) {
    console.log('❌ Belum ada session valid di ' + AUTH_DIR);
    process.exit(1);
  }
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '126.0.0.1'],
  });
  sock.ev.on('creds.update', saveCreds);

  let done = false;
  const finish = (msg) => {
    if (done) return;
    done = true;
    if (msg) console.log(msg);
    try { sock.end(undefined); } catch (e) {}
    setTimeout(() => process.exit(0), 1000);
  };

  sock.ev.on('connection.update', async (u) => {
    if (u.connection === 'open') {
      console.log('✅ Terhubung: ' + (sock.user?.id || '?'));
      setTimeout(async () => {
        try {
          const groups = await sock.groupFetchAllParticipating();
          const list = Object.values(groups);
          console.log('=== JUMLAH GROUP: ' + list.length + ' ===');
          for (const g of list.sort((a, b) => (a.subject || '').localeCompare(b.subject || ''))) {
            console.log('• ' + (g.subject || '(tanpa nama)') + ' | ' + g.id + ' | anggota: ' + (g.participants?.length ?? '?'));
          }
          finish('SELESAI');
        } catch (e) {
          finish('❌ Gagal fetch groups: ' + e.message);
        }
      }, 8000);
    }
    if (u.connection === 'close') {
      finish('❌ Koneksi tertutup (status ' + u.lastDisconnect?.error?.output?.statusCode + ')');
    }
  });

  setTimeout(() => finish('⏱ Timeout 45 detik'), 45000);
})();
