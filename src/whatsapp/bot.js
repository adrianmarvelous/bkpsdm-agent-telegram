const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const moment = require('moment');
const path = require('path');
const api = require('../services/apiClient');

const AUTH_DIR = path.resolve(__dirname, '../../auth_info');

// ─── Formatter ─────────────────────────────────────────────────────────────

function formatJadwal(rows) {
  if (!rows || rows.length === 0) return '📅 _Tidak ada jadwal._';
  return rows.map((r, i) =>
    `*${i + 1}. ${r.nama_acara}*\n` +
    `   🕐 ${r.pukul_mulai} - ${r.pukul_selesai || '?'}\n` +
    `   📍 ${r.tempat || '-'}\n` +
    `   📝 ${r.keterangan || '-'}`
  ).join('\n\n');
}

function formatTugas(rows) {
  if (!rows || rows.length === 0) return '📋 _Tidak ada tugas._';
  return rows.map((r, i) =>
    `*${i + 1}. ${r.tugas}*\n` +
    `   🕐 ${r.jam || '-'}\n` +
    `   👤 Disposisi ke: ${r.disposisi_ke || '-'}\n` +
    `   👥 Pegawai: ${r.pegawai || '-'}`
  ).join('\n\n');
}

function formatAbsensi(rows) {
  if (!rows || rows.length === 0) return '✅ _Tidak ada data absensi._';
  return rows.map(r =>
    `*${r.id_pegawai}*\n   Status: ${r.hadir ? '✅ Hadir' : '❌ Tidak Hadir'}\n   Tanggal: ${r.tanggal}`
  ).join('\n\n');
}

// ─── Natural Language → Command ────────────────────────────────────────────

function naturalToCommand(text) {
  const lower = text.toLowerCase().trim();
  if (/^(tugas|tugas hari ini)/i.test(lower)) return '/tugas-hariini';
  if (/^(tugas besok)/i.test(lower)) return '/tugas-besok';
  if (/^(tugas semua|semua tugas)/i.test(lower)) return '/tugas-semua';
  if (/^tugas \d{4}-\d{2}-\d{2}$/i.test(lower)) return `/tugas ${lower.split(/\s+/)[1]}`;
  if (/^(jadwal|jadwal hari ini|rapat hari ini)/i.test(lower)) return '/jadwal-hariini';
  if (/^(jadwal besok|rapat besok)/i.test(lower)) return '/jadwal-besok';
  if (/^(jadwal minggu ini|rapat minggu ini)/i.test(lower)) return '/jadwal-mingguini';
  if (/^(jadwal semua|semua jadwal)/i.test(lower)) return '/jadwal-semua';
  if (/^jadwal \d{4}-\d{2}-\d{2}$/i.test(lower)) return `/jadwal ${lower.split(/\s+/)[1]}`;
  if (/^(absensi|absen|kehadiran)/i.test(lower)) return '/absensi';
  if (/^(ping|pong|cek|test)$/i.test(lower)) return '/ping';
  if (/^(help|bantuan|menu|halo|hai|hallo|siang|pagi|sore)$/i.test(lower)) return '/help';
  return text;
}

// ─── Help Text ─────────────────────────────────────────────────────────────

const helpText = `
*🤖 BKPSDM — WhatsApp Bot*

*Perintah:*
📅 /jadwal-hariini — Jadwal hari ini
📅 /jadwal-besok — Jadwal besok
📅 /jadwal-mingguini — Jadwal minggu ini
📅 /jadwal YYYY-MM-DD — Jadwal per tanggal

📋 /tugas-hariini — Tugas hari ini
📋 /tugas-besok — Tugas besok
📋 /tugas YYYY-MM-DD — Tugas per tanggal

✅ /absensi — Cek absensi hari ini
🔧 /help — Bantuan

┈┈┈┈┈┈┈┈┈┈┈┈┈┈
_BKPSDM Surabaya_
`;

// ─── Command Handler ───────────────────────────────────────────────────────

async function handleCommand(sock, chatId, text) {
  const normalized = naturalToCommand(text);
  const parts = normalized.trim().toLowerCase().split(/\s+/);
  const mainCmd = parts[0];
  const arg = parts[1];

  try {
    switch (mainCmd) {
      case '/jadwal-hariini':
      case '/jadwal_hari_ini': {
        const data = await api.get('/jadwal/hari-ini.php');
        const msg = data.rows?.length
          ? `📅 *Jadwal Rapat Hari Ini*\n${formatJadwal(data.rows)}`
          : `📅 ${data.message || 'Tidak ada jadwal hari ini.'}`;
        await sock.sendMessage(chatId, { text: msg });
        break;
      }
      case '/jadwal-besok': {
        const besok = moment().add(1, 'day').format('YYYY-MM-DD');
        const data = await api.get(`/jadwal/tanggal.php?date=${besok}`);
        const msg = data.rows?.length
          ? `📅 *Jadwal Besok (${besok})*\n${formatJadwal(data.rows)}`
          : `📅 ${data.message || 'Tidak ada jadwal besok.'}`;
        await sock.sendMessage(chatId, { text: msg });
        break;
      }
      case '/jadwal-mingguini':
      case '/jadwal_minggu_ini': {
        const data = await api.get('/jadwal/minggu-ini.php');
        const msg = data.rows?.length
          ? `📅 *Jadwal Minggu Ini*\n${formatJadwal(data.rows)}`
          : `📅 ${data.message || 'Tidak ada jadwal minggu ini.'}`;
        await sock.sendMessage(chatId, { text: msg });
        break;
      }
      case '/jadwal-semua':
      case '/jadwal_semua': {
        const data = await api.get('/jadwal/semua.php');
        const msg = data.rows?.length
          ? `📅 *Semua Jadwal*\n${formatJadwal(data.rows)}`
          : '📅 _Tidak ada jadwal._';
        await sock.sendMessage(chatId, { text: msg });
        break;
      }
      case '/jadwal': {
        if (!arg || !/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
          await sock.sendMessage(chatId, { text: '⚠️ Format: /jadwal YYYY-MM-DD' });
          return;
        }
        const data = await api.get(`/jadwal/tanggal.php?date=${arg}`);
        const msg = data.rows?.length
          ? `📅 *Jadwal (${arg})*\n${formatJadwal(data.rows)}`
          : `📅 ${data.message || 'Tidak ada jadwal.'}`;
        await sock.sendMessage(chatId, { text: msg });
        break;
      }
      case '/tugas-hariini':
      case '/tugas_hari_ini': {
        const data = await api.get('/tugas/hari-ini.php');
        const msg = data.rows?.length
          ? `📋 *Tugas Hari Ini*\n${formatTugas(data.rows)}`
          : `📋 ${data.message || 'Tidak ada tugas hari ini.'}`;
        await sock.sendMessage(chatId, { text: msg });
        break;
      }
      case '/tugas-besok': {
        const besok = moment().add(1, 'day').format('YYYY-MM-DD');
        const data = await api.get(`/tugas/tanggal.php?date=${besok}`);
        const msg = data.rows?.length
          ? `📋 *Tugas Besok (${besok})*\n${formatTugas(data.rows)}`
          : `📋 ${data.message || 'Tidak ada tugas besok.'}`;
        await sock.sendMessage(chatId, { text: msg });
        break;
      }
      case '/tugas-semua':
      case '/tugas_semua': {
        const data = await api.get('/tugas/semua.php');
        const msg = data.rows?.length
          ? `📋 *Semua Tugas*\n${formatTugas(data.rows)}`
          : '📋 _Tidak ada tugas._';
        await sock.sendMessage(chatId, { text: msg });
        break;
      }
      case '/tugas': {
        if (!arg || !/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
          await sock.sendMessage(chatId, { text: '⚠️ Format: /tugas YYYY-MM-DD' });
          return;
        }
        const data = await api.get(`/tugas/tanggal.php?date=${arg}`);
        const msg = data.rows?.length
          ? `📋 *Tugas (${arg})*\n${formatTugas(data.rows)}`
          : `📋 ${data.message || 'Tidak ada tugas.'}`;
        await sock.sendMessage(chatId, { text: msg });
        break;
      }
      case '/absensi': {
        const data = await api.get('/absensi/bulan-ini.php');
        const msg = data.rows?.length
          ? `✅ *Absensi*\n${formatAbsensi(data.rows)}`
          : '✅ _Tidak ada data absensi._';
        await sock.sendMessage(chatId, { text: msg });
        break;
      }
      case '/ping':
        await sock.sendMessage(chatId, { text: '🏓 *Pong!* Bot aktif ✅' });
        break;
      case '/help':
      case '/start':
      case 'halo':
      case 'hai':
      case 'hallo':
        await sock.sendMessage(chatId, { text: helpText });
        break;
      default:
        await sock.sendMessage(chatId, {
          text: `❌ Maaf, tidak paham perintah *${text}*.\n\nKetik /help untuk bantuan.`
        });
    }
  } catch (err) {
    console.error('[WA] Error:', err.message);
    await sock.sendMessage(chatId, { text: '❌ Gagal memproses perintah. Coba lagi nanti.' });
  }
}

// ─── Main WhatsApp Connection ──────────────────────────────────────────────

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Scan QR Code untuk login WhatsApp:\n');
      QRCode.toString(qr, { type: 'terminal', small: true }, (err, url) => {
        if (err) console.log('QR:', qr);
        else console.log(url);
      });
      QRCode.toFile('qr-code.png', qr, { width: 400 }, (err) => {
        if (!err) console.log('📸 QR disimpan di qr-code.png');
      });
      console.log('');
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp terhubung!');
      console.log(`📱 Nomor: ${sock.user.id.split(':')[0]}`);
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`❌ Koneksi WA terputus. Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        console.log('⏳ Reconnect dalam 5 detik...');
        setTimeout(() => startBot(), 5000);
      } else {
        console.log('⚠️ Logout. Hapus auth_info/ untuk login ulang.');
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (msg) => {
    const message = msg.messages[0];
    if (!message.key || message.key.fromMe) return;
    if (message.key.remoteJid.endsWith('@broadcast') || message.key.remoteJid.endsWith('@g.us')) return;
    if (!message.message?.conversation && !message.message?.extendedTextMessage?.text) return;

    const chatId = message.key.remoteJid;
    const text = message.message.conversation || message.message.extendedTextMessage?.text || '';
    if (!text) return;

    console.log(`📩 [WA] ${chatId}: ${text}`);
    await handleCommand(sock, chatId, text);
  });

  console.log('🤖 BKPSDM WhatsApp Bot starting...');
}

// ─── Start ─────────────────────────────────────────────────────────────────

startBot().catch(err => {
  console.error('[WA] Fatal:', err);
  process.exit(1);
});
