require('dotenv').config();
const { TelegramBot } = require('node-telegram-bot-api');
const { askAI } = require('../services/ai');
const { getHistory, addMessage, clearHistory } = require('../services/conversation');
const api = require('../services/apiClient');
const { startDisposisi, getDisposisiState, clearDisposisiState, saveDisposisi, deleteTugas } = require('../services/disposisi');
const tekocak = require('../services/tekocak');
const fs = require('fs');
const { generateAbsensiPdf } = require('../services/pdfGenerator');
const { executeTool, parseIndonesianDate } = require('../services/dbTools');

// Ambil token dari environment variable
const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('❌ TELEGRAM_BOT_TOKEN tidak ditemukan di file .env');
  process.exit(1);
}

// Inisialisasi bot
const bot = new TelegramBot(token, { polling: true });

// =============== AUTHORIZATION ===============

// Daftar chat ID yang diizinkan dari .env (pisahkan dengan koma)
const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(id => id.length > 0)
  .map(Number);

// Jika ALLOWED_CHAT_IDS dikonfigurasi, aktifkan mode terbatas
const RESTRICTED_MODE = ALLOWED_CHAT_IDS.length > 0;

if (RESTRICTED_MODE) {
  console.log(`🔒 Mode terbatas: hanya ${ALLOWED_CHAT_IDS.length} chat ID yang diizinkan`);
} else {
  console.log('🌐 Mode publik: semua pengguna dapat mengakses bot');
  console.log('💡 Atur ALLOWED_CHAT_IDS di .env untuk membatasi akses');
}

/**
 * Memeriksa apakah chat ID diizinkan
 * @param {number} chatId
 * @returns {boolean}
 */
function isAuthorized(chatId) {
  if (!RESTRICTED_MODE) return true;
  return ALLOWED_CHAT_IDS.includes(chatId);
}

console.log('🤖 Bot Telegram BKPSDM sedang berjalan...');
console.log('🔗 Terhubung ke OpenRouter AI');
console.log('💬 Kirim pesan apa pun dengan bahasa alami!');

// Cek koneksi API saat startup (tidak blocking)
(async () => {
  try {
    const health = await api.healthCheck();
    if (health.databases) {
      health.databases.forEach((db) => {
        if (db.ok) {
          console.log(`  ✅ ${db.name}: ${db.message}`);
        } else {
          console.warn(`  ⚠️ ${db.name}: ${db.message} (bot tetap berjalan)`);
        }
      });
    }
  } catch (err) {
    console.warn(`  ⚠️ API Health Check gagal: ${err.message} (bot tetap berjalan)`);
  }
})();

// =============== COMMAND HANDLERS ===============

// Handler untuk /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'User';

  // Periksa otorisasi
  if (!isAuthorized(chatId)) {
    return bot.sendMessage(
      chatId,
      `⛔ Maaf *${firstName}*, Anda tidak memiliki akses ke bot ini.\n\nGunakan /myid untuk melihat Chat ID Anda, lalu minta admin untuk menambahkannya ke daftar izin.`,
      { parse_mode: 'Markdown' },
    );
  }

  // Reset percakapan
  clearHistory(chatId);

  const welcomeMessage = `
👋 Halo *${firstName}*! Selamat datang di *BKPSDM Telegram Bot* 🤖

Saya adalah asisten AI yang siap membantu Anda! 🎉

✨ *Yang bisa saya lakukan:*
• 💬 Chat dengan bahasa alami — ngobrol seperti dengan teman
• 📅 Cek jadwal rapat hari ini / tanggal tertentu
• 📋 Cek tugas dan disposisi dari SIJAKA
• 🤖 Automasi absensi TEKO-CAK
• 📊 Cek absensi & BBM Non-Fosil
• 🧠 Didukung AI dari OpenRouter

👇 *Pilih menu di bawah atau ketik perintah langsung:*
  `;

  bot.sendMessage(chatId, welcomeMessage, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📅 Jadwal Rapat', callback_data: 'menu_jadwal' }, { text: '📋 Tugas & Disposisi', callback_data: 'menu_tugas' }],
        [{ text: '🤖 TEKO-CAK', callback_data: 'menu_tekocak' }, { text: '📊 Absensi', callback_data: 'menu_absensi' }],
        [{ text: '🛢️ BBM Non-Fosil', callback_data: 'menu_bbm' }, { text: 'ℹ️ Status', callback_data: 'menu_status' }],
        [{ text: '❓ Bantuan', callback_data: 'menu_help' }],
      ]
    }
  });
});

// Handler untuk /help
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;

  // Periksa otorisasi
  if (!isAuthorized(chatId)) {
    return bot.sendMessage(chatId, '⛔ Anda tidak memiliki akses ke bot ini. Gunakan /myid untuk melihat Chat ID Anda.');
  }

  const helpMessage = `
📋 *Bantuan — BKPSDM Telegram Bot*

🧠 *Bot ini didukung AI dari OpenRouter!*
Kamu bisa ngobrol dengan bahasa alami, tidak perlu perintah kaku.

💬 *Contoh percakapan:*
• "Halo, apa kabar?"
• "Jadwal rapat hari ini?"
• "Tampilkan jadwal rapat 26 juni"
• "Munculkan tugas 25 juni"
• "Tugas hari ini"
• "Apa saja tugas yang ada?"

📌 *Perintah khusus:*
/start — Mulai ulang percakapan
/help — Bantuan ini
/reset — Hapus riwayat chat
/status — Cek status bot
/info — Info akun kamu
/tekocak — Automasi absensi TEKO-CAK ( /tekocak help)
/absensi — Cek absensi TEKO-CAK hari ini

💡 *Tips:* Semakin detail pertanyaanmu, semakin baik jawabannya!
  `;

  bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// Handler untuk /reset — reset riwayat percakapan
bot.onText(/\/reset/, (msg) => {
  const chatId = msg.chat.id;

  // Periksa otorisasi
  if (!isAuthorized(chatId)) {
    return bot.sendMessage(chatId, '⛔ Anda tidak memiliki akses ke bot ini.');
  }

  clearHistory(chatId);
  bot.sendMessage(chatId, '🔄 Riwayat percakapan berhasil dihapus! Mulai obrolan baru yuk! 😊');
});

// Handler untuk /status
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;

  // Periksa otorisasi
  if (!isAuthorized(chatId)) {
    return bot.sendMessage(chatId, '⛔ Anda tidak memiliki akses ke bot ini.');
  }

  // Cek status AI
  const aiConfigured = process.env.OPENROUTER_API_KEY ? '✅ Terkonfigurasi' : '❌ Belum diatur';
  const aiModel = process.env.OPENROUTER_MODEL || 'cohere/north-mini-code:free';

  // Cek status semua database via API (real-time)
  let dbStatusText = '⚠️ Tidak bisa hubungi API backend';
  try {
    const health = await api.healthCheck();
    if (health.databases) {
      dbStatusText = health.databases
        .map((s) => `  ${s.ok ? '✅' : '❌'} ${s.name}: ${s.ok ? 'Terhubung' : s.message}`)
        .join('\n');
    }
  } catch (err) {
    dbStatusText = `  ❌ API: ${err.message}`;
  }

  const statusMessage = `
✅ *Bot Status: AKTIF*

📡 Mode: Polling
🧠 AI: ${aiConfigured}
🤖 Model: ${aiModel}
🗄 *Database:*
${dbStatusText}
⏱ Waktu: ${new Date().toLocaleString('id-ID')}
  `;

  bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
});

// Handler untuk /info
bot.onText(/\/info/, (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from;

  // Periksa otorisasi
  if (!isAuthorized(chatId)) {
    return bot.sendMessage(chatId, '⛔ Anda tidak memiliki akses ke bot ini.');
  }

  const infoMessage = `
ℹ️ *Informasi Pengguna*

👤 Nama: ${user.first_name || '-'} ${user.last_name || ''}
🆔 User ID: ${user.id}
💬 Username: ${user.username ? '@' + user.username : '-'}
🏷 Bahasa: ${user.language_code || '-'}

🤖 *Info Bot*
📦 Versi: 1.0.0
🛠 Platform: Node.js
  `;

  bot.sendMessage(chatId, infoMessage, { parse_mode: 'Markdown' });
});

// Handler untuk /myid — lihat chat ID sendiri
bot.onText(/\/myid/, (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from;

  const isOwner = isAuthorized(chatId);

  const idMessage = `
📱 *Chat ID Anda*

🆔 Chat ID: \`${chatId}\`
👤 User ID: \`${user.id}\`
🔐 Status: ${isOwner ? '✅ Terdaftar' : '❌ Belum terdaftar'}

${!isOwner ? `\n📌 *Untuk mengizinkan akses:*\nTambahkan \`${chatId}\` ke \`ALLOWED_CHAT_IDS\` di file \`.env\`` : ''}
  `;

  bot.sendMessage(chatId, idMessage, { parse_mode: 'Markdown' });
});

// =============== TEKO-CAK COMMANDS ===============

/**
 * Helper: jalankan task TEKO-CAK dan kirim hasil ke Telegram
 */
async function runTekocakTask(chatId, taskName, label, nip = null) {
  // Kirim status awal
  const statusMsg = await bot.sendMessage(
    chatId,
    `⏳ **TEKO-CAK: ${label}**${nip ? ` (NIP: ${nip})` : ''}\n\nMemproses... mohon tunggu, ini bisa beberapa menit.`,
    { parse_mode: 'Markdown' }
  );

  // Kumpulkan log
  const logs = [];
  const onProgress = (msg) => {
    logs.push(msg);
  };

  try {
    const result = await tekocak.runTask(taskName, onProgress, nip);
    let output = result.output;

    // Kirim hasil
    try { await bot.deleteMessage(chatId, statusMsg.message_id); } catch (_) {}

    const statusIcon = result.success ? '✅' : '❌';
    const fullMsg = `${statusIcon} **TEKO-CAK: ${label} — ${result.success ? 'BERHASIL' : 'GAGAL'}**\n\n${output}`;

    // Split pesan jika terlalu panjang (>4096 chars untuk Telegram)
    const MAX_LEN = 4000;
    if (fullMsg.length <= MAX_LEN) {
      await bot.sendMessage(chatId, fullMsg, { parse_mode: 'Markdown' });
    } else {
      // Kirim sebagai file jika terlalu panjang
      const fs = require('fs');
      const tmpPath = `/tmp/tekocak-${taskName}-${Date.now()}.log`;
      fs.writeFileSync(tmpPath, output, 'utf-8');
      await bot.sendMessage(chatId, `${statusIcon} **TEKO-CAK: ${label} — ${result.success ? 'BERHASIL' : 'GAGAL'}**\n\n📄 Output terlalu panjang, dikirim sebagai file.`, { parse_mode: 'Markdown' });
      await bot.sendDocument(chatId, tmpPath);
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  } catch (err) {
    try { await bot.deleteMessage(chatId, statusMsg.message_id); } catch (_) {}
    await bot.sendMessage(
      chatId,
      `❌ **TEKO-CAK Error:**\n${err.message}`,
      { parse_mode: 'Markdown' }
    );
  }
}

// /tekocak — jalankan semua task
bot.onText(/\/tekocak\b(?: (.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;

  if (!isAuthorized(chatId)) {
    return bot.sendMessage(chatId, '⛔ Anda tidak memiliki akses ke bot ini.');
  }

  const sub = (match[1] || '').trim().toLowerCase();

  // Pisahkan sub-perintah dan NIP (jika ada)
  const parts = sub.split(/\s+/);
  const cmd = parts[0];
  const nip = parts.length > 1 ? parts[1] : null;

  if (cmd === 'login') {
    return runTekocakTask(chatId, 'login', 'Login');
  }
  if (cmd === 'generate' || cmd === 'gen') {
    return runTekocakTask(chatId, 'generate', 'Generate Laporan');
  }
  if (cmd === 'update' || cmd === 'upd') {
    if (nip) {
      return runTekocakTask(chatId, 'update', `Update 1 Pegawai (NIP: ${nip})`, nip);
    }
    return runTekocakTask(chatId, 'update', 'Update Semua Pegawai');
  }
  if (cmd === 'help' || cmd === 'h') {
    const help = [
      '📋 **Perintah TEKO-CAK:**',
      '',
      '`/tekocak` — Jalankan semua task (Login → Generate → Update)',
      '`/tekocak login` — Login saja',
      '`/tekocak generate` — Generate laporan absensi',
      '`/tekocak update` — Update semua pegawai (66 NIP)',
      '`/tekocak update <NIP>` — Update 1 pegawai spesifik',
      '`/tekocak help` — Bantuan ini',
      '',
      '⏱️ Update 66 NIP butuh beberapa menit. Untuk 1 NIP lebih cepat.',
      '',
      '💡 *Contoh:* `/tekocak update 196910171993032006`',
    ].join('\n');
    return bot.sendMessage(chatId, help, { parse_mode: 'Markdown' });
  }
  if (sub) {
    return bot.sendMessage(
      chatId,
      `❌ Sub-perintah tidak dikenal: \`${sub}\`\nGunakan \`/tekocak help\` untuk bantuan.`,
      { parse_mode: 'Markdown' }
    );
  }

  // Default: jalankan semua task
  return runTekocakTask(chatId, 'all', 'Semua Task');
});

// =============== ABSENSI COMMAND ===============

/**
 * Helper: kirim absensi (teks atau PDF tergantung jumlah data)
 */
async function sendAbsensiResponse(chatId, data, label = 'Absensi TEKO-CAK Hari Ini') {
  const r = data?.ringkasan;
  const totalPegawai = r?.total_pegawai || (r?.total) || 0;

  // Jika data banyak (>15 pegawai), kirim sebagai PDF
  if (totalPegawai > 15) {
    const pdfPath = await generateAbsensiPdf(data);
    const hadir = r?.normal || r?.hadir || 0;
    const anomali = r?.anomali || r?.absen || 0;
    const caption = `📋 <b>${label}</b>\n📅 ${data.tanggal || '-'}\n👥 ${totalPegawai} pegawai | ✅ Normal ${hadir}${anomali ? ' | ⚠️ Anomali ' + anomali : ''}`;
    await bot.sendDocument(chatId, pdfPath, { caption, parse_mode: 'HTML' });
    try { fs.unlinkSync(pdfPath); } catch (_) {}
    return;
  }

  // Jika sedikit, kirim teks biasa
  const formatted = formatAbsensi(data, label);
  if (formatted.text) {
    await bot.sendMessage(chatId, formatted.text, { parse_mode: 'HTML' });
  } else {
    await bot.sendMessage(chatId, '📭 Tidak ada data absensi.');
  }
}

// /absensi — lihat absensi TEKO-CAK (hari ini atau tanggal tertentu)
// /absensi                   → hari ini
// /absensi 2026-07-13        → tanggal tertentu
// /absensi 13 juli 2026      → teks Indonesia
bot.onText(/\/absensi(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAuthorized(chatId)) {
    return bot.sendMessage(chatId, '⛔ Anda tidak memiliki akses ke bot ini.');
  }

  const dateInput = (match[1] || '').trim();

  try {
    const waitMsg = await bot.sendMessage(chatId, '⏳ Mengambil data absensi TEKO-CAK...');

    let data;
    let label;

    if (dateInput) {
      // Parse tanggal — buang kata "tanggal" jika ada
      const cleanInput = dateInput.replace(/^tanggal\s+/i, '');
      const parsed = parseIndonesianDate(cleanInput); // returns YYYY-MM-DD
      if (parsed) {
        data = await api.getAbsensiByTanggal(parsed);
        label = `Absensi TEKO-CAK ${parsed}`;
      } else {
        // Coba langsung YYYY-MM-DD
        data = await api.getAbsensiByTanggal(cleanInput);
        label = `Absensi TEKO-CAK ${cleanInput}`;
      }
    } else {
      data = await api.getAbsensiHariIni();
      label = 'Absensi TEKO-CAK Hari Ini';
    }

    try { await bot.deleteMessage(chatId, waitMsg.message_id); } catch (_) {}
    await sendAbsensiResponse(chatId, data, label);

  } catch (err) {
    try { await bot.deleteMessage(chatId, waitMsg.message_id); } catch (_) {}
    await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// =============== BBM NON-FOSIL COMMAND ===============

// /bbm — lihat data BBM Non-Fosil (hari ini atau tanggal tertentu)
bot.onText(/\/bbm(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAuthorized(chatId)) {
    return bot.sendMessage(chatId, '⛔ Anda tidak memiliki akses ke bot ini.');
  }

  const dateInput = (match[1] || '').trim();

  try {
    const waitMsg = await bot.sendMessage(chatId, '⏳ Mengambil data BBM Non-Fosil... (mungkin butuh beberapa saat)');

    let data;
    if (dateInput) {
      // Coba parse tanggal: support DD/MM/YYYY atau teks Indonesia
      const parsed = parseIndonesianDate(dateInput); // returns YYYY-MM-DD
      if (parsed) {
        // Convert YYYY-MM-DD ke DD/MM/YYYY
        const [y, m, d] = parsed.split('-');
        const tanggalDmy = `${d}/${m}/${y}`;
        data = await api.getBbmNonFosilByTanggal(tanggalDmy);
      } else {
        // Coba langsung DD/MM/YYYY
        data = await api.getBbmNonFosilByTanggal(dateInput);
      }
      try { await bot.deleteMessage(chatId, waitMsg.message_id); } catch (_) {}
      const formatted = formatBbm(data, `BBM Non-Fosil ${dateInput} 🛢️`);
      if (formatted.text) {
        await bot.sendMessage(chatId, formatted.text, { parse_mode: 'HTML' });
      } else {
        await bot.sendMessage(chatId, '📭 Tidak ada data BBM Non-Fosil.');
      }
    } else {
      // Hari ini
      data = await api.getBbmNonFosilHariIni();
      try { await bot.deleteMessage(chatId, waitMsg.message_id); } catch (_) {}
      const formatted = formatBbm(data, 'BBM Non-Fosil Hari Ini 🛢️');
      if (formatted.text) {
        await bot.sendMessage(chatId, formatted.text, { parse_mode: 'HTML' });
      } else {
        await bot.sendMessage(chatId, '📭 Tidak ada data BBM Non-Fosil.');
      }
    }
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// =============== DIRECT DATABASE QUERY HANDLER ===============

/**
 * Deteksi apakah pesan berisi permintaan jadwal rapat
 * Jika ya, langsung query database tanpa lewat AI
 */
const JADWAL_PATTERNS = [
  /(jadwal|rapat|agenda|acara)\s+(hari\s*ini|sekarang)/i,
  /(jadwal|rapat|agenda|acara)\s+(minggu\s*ini|bulan\s*ini)/i,
  /(tampilkan|munculkan|lihat|cek|tunjukkin|tunjukkan)\s+(semua\s+)?(jadwal|rapat|agenda)/i,
  /(tampilkan|munculkan|lihat|cek|tunjukkin|tunjukkan)\s+(semua\s+)?(jadwal|rapat|agenda)\s+(tanggal\s+)?(\d{1,2}\s+[a-z]+|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})/i,
  /(jadwal|rapat|agenda)\s+(tanggal\s+)?(\d{1,2}\s+[a-z]+|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})/i,
];

const BULAN_MAP = {
  januari:1,februari:2,maret:3,april:4,mei:5,juni:6,juli:7,agustus:8,september:9,oktober:10,november:11,desember:12,
  jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,agt:8,sep:9,okt:10,nov:11,des:12,
};

function parseTanggal(text) {
  const match = text.match(/(\d{1,2})\s+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|jun|jul|agt|sep|okt|nov|des)\s*(\d{4})?/i);
  if (match) {
    const d = match[1].padStart(2,'0');
    const m = String(BULAN_MAP[match[2].toLowerCase()]).padStart(2,'0');
    const y = match[3] || new Date().getFullYear();
    return `${y}-${m}-${d}`;
  }
  return null;
}

function detectJadwalQuery(text) {
  const lower = text.toLowerCase();

  // Cek pola jadwal hari ini
  if (/(jadwal|rapat|agenda).*(hari\s*ini|sekarang)/i.test(lower)) {
    return { tool: 'get_jadwal_rapat_hari_ini', args: {} };
  }

  // Cek pola jadwal minggu ini
  if (/(jadwal|rapat|agenda).*(minggu\s*ini)/i.test(lower)) {
    return { tool: 'get_jadwal_rapat_minggu_ini', args: {} };
  }

  // Cek pola semua jadwal / tampilkan semua
  if (/(tampilkan|munculkan|lihat).*(semua)\s*(jadwal|rapat)/i.test(lower) ||
      /semua\s*(jadwal|rapat)/i.test(lower)) {
    return { tool: 'get_semua_jadwal_rapat', args: {} };
  }

  // Cek pola tanggal spesifik
  const tanggal = parseTanggal(text);
  if (tanggal && /(jadwal|rapat|agenda|tampilkan|munculkan)/i.test(lower)) {
    return { tool: 'get_jadwal_rapat_by_tanggal', args: { tanggal } };
  }

  // Cek pola dengan angka saja (DD-MM-YYYY atau YYYY-MM-DD)
  const angkaMatch = text.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2})|(\d{1,2}[-/]\d{1,2}[-/]\d{4})/);
  if (angkaMatch && /(jadwal|rapat|agenda|tampilkan|munculkan|tanggal)/i.test(lower)) {
    return { tool: 'get_jadwal_rapat_by_tanggal', args: { tanggal: angkaMatch[0] } };
  }

  return null;
}

/**
 * Deteksi apakah pesan berisi permintaan tugas dari SIJAKA
 */
function detectTugasQuery(text) {
  const lower = text.toLowerCase();

  // Cek pola tugas hari ini
  if (/(tugas|disposisi).*(hari\s*ini|sekarang)/i.test(lower)) {
    return { tool: 'get_tugas_hari_ini', args: {} };
  }

  // Cek pola semua tugas
  if (/(tampilkan|munculkan|lihat).*(semua)\s*(tugas|disposisi)/i.test(lower) ||
      /semua\s*(tugas|disposisi)/i.test(lower)) {
    return { tool: 'get_semua_tugas', args: {} };
  }

  // Cek pola tugas dengan tanggal
  const tanggal = parseTanggal(text);
  if (tanggal && /(tugas|disposisi|tampilkan|munculkan)/i.test(lower)) {
    return { tool: 'get_tugas_by_tanggal', args: { tanggal } };
  }

  // Cek pola dengan angka
  const angkaMatch = text.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2})|(\d{1,2}[-/]\d{1,2}[-/]\d{4})/);
  if (angkaMatch && /(tugas|disposisi|tampilkan|munculkan|tanggal)/i.test(lower)) {
    return { tool: 'get_tugas_by_tanggal', args: { tanggal: angkaMatch[0] } };
  }

  return null;
}

/**
 * Deteksi apakah pesan berisi perintah TEKO-CAK (tanpa / slash)
 */
function detectTekocakQuery(text) {
  const lower = text.toLowerCase().trim();

  // Cek pola: "tekocak update <NIP>" atau "tekocak update"
  const updateMatch = lower.match(/^tekocak\s+update(?:\s+(\d+))?$/);
  if (updateMatch) {
    return { task: 'update', nip: updateMatch[1] || null };
  }

  // Cek pola: "tekocak generate" atau "tekocak gen"
  if (/^tekocak\s+(generate|gen)$/.test(lower)) {
    return { task: 'generate', nip: null };
  }

  // Cek pola: "tekocak login"
  if (/^tekocak\s+login$/.test(lower)) {
    return { task: 'login', nip: null };
  }

  // Cek pola: "tekocak" saja
  if (/^tekocak$/.test(lower)) {
    return { task: 'all', nip: null };
  }

  return null;
}

/**
 * Deteksi apakah pesan berisi permintaan BBM Non-Fosil
 */
function detectBbmQuery(text) {
  const lower = text.toLowerCase().trim();

  // BBM + tanggal (format: DD/MM/YYYY atau teks Indonesia)
  const bbmWithDate = lower.match(/^bbm(?:\s+non.?fosil)?(?:\s+tanggal)?\s+(.+)/);
  if (bbmWithDate) {
    const dateStr = bbmWithDate[1].trim();
    // Cek apakah itu format tanggal
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateStr) || /\d{1,2}\s+[a-z]+/.test(dateStr)) {
      return { tool: 'get_bbm_non_fosil_by_tanggal', args: { tanggal: dateStr } };
    }
  }

  if (/^(bbm|bbm non.?fosil|bahan bakar).*(hari.ini|sekarang)/i.test(lower)) {
    return { tool: 'get_bbm_non_fosil_hari_ini', args: {} };
  }
  if (/(bbm|bbm non.?fosil|bahan bakar)/i.test(lower) && /(tampilkan|lihat|cek|munculkan)/i.test(lower)) {
    return { tool: 'get_bbm_non_fosil_hari_ini', args: {} };
  }
  if (lower === 'bbm' || lower === 'bbm hari ini') {
    return { tool: 'get_bbm_non_fosil_hari_ini', args: {} };
  }

  return null;
}

function formatJadwal(rows, title) {
  if (!rows || rows.length === 0) return { text: null, keyboard: null };
  if (rows.message) return { text: `📭 ${rows.message}`, keyboard: null };

  let msg = `📅 <b>${title}</b>\n\n`;
  const keyboard = [];

  rows.forEach((r, i) => {
    const waktu = r.pukul_mulai ? r.pukul_mulai.slice(0, 5) : '-';
    msg += `${i + 1}. <b>${r.nama_acara}</b>\n`;
    msg += `   ⏰ ${waktu}`;
    if (r.tempat) msg += ` | 📍 ${r.tempat}`;
    if (r.link_esurat) msg += `\n   🔗 ${r.link_esurat}`;
    msg += '\n\n';
    keyboard.push([{ text: `📌 Disposisi #${i + 1}`, callback_data: `disposisi_${r.id}` }]);
  });

  msg += '<i>Klik tombol di bawah untuk disposisi rapat</i>';
  return { text: msg, keyboard };
}

function formatTugas(rows, title) {
  if (!rows || rows.length === 0) return { text: null, keyboard: null };
  if (rows.message) return { text: `📭 ${rows.message}`, keyboard: null };
  if (rows.error) return { text: `⚠️ ${rows.message}`, keyboard: null };

  let msg = `📋 <b>${title}</b>\n\n`;
  const keyboard = [];

  rows.forEach((r, i) => {
    const tgl = r.tanggal instanceof Date
      ? `${String(r.tanggal.getDate()).padStart(2,'0')}/${String(r.tanggal.getMonth()+1).padStart(2,'0')}/${r.tanggal.getFullYear()}`
      : String(r.tanggal).slice(0,10);
    const waktu = r.jam ? r.jam.slice(0, 5) : '-';
    msg += `${i + 1}. ${r.tugas}\n`;
    msg += `   📅 ${tgl} | ⏰ ${waktu}`;
    if (r.disposisi_ke) msg += ` | 👤 ${r.disposisi_ke}`;
    if (r.pegawai) msg += `\n   👥 ${r.pegawai}`;
    if (r.link_esurat) msg += `\n   🔗 ${r.link_esurat}`;
    msg += '\n\n';
    keyboard.push([{ text: `🗑 Hapus #${i + 1}`, callback_data: `hapus_tugas_${r.id}` }]);
  });

  msg += '<i>Klik 🗑 Hapus untuk menghapus tugas</i>';
  return { text: msg, keyboard };
}

function formatBbm(response, title) {
  // Response API: { success, tanggal, text, data }
  if (!response) return { text: null, keyboard: null };

  // Jika sukses tapi tidak ada data
  if (response.success === false) {
    return { text: `📭 ${response.message || 'Tidak ada data BBM Non-Fosil'}`, keyboard: null };
  }

  // Jika ada text pre-formatted dari backend (WhatsApp message)
  if (response.text) {
    let msg = `🛢️ <b>${title}</b>\n\n`;
    msg += response.text;
    return { text: msg, keyboard: null };
  }

  // Fallback: render dari data
  if (response.data) {
    let msg = `🛢️ <b>${title}</b>\n`;
    if (response.tanggal) msg += `📅 ${response.tanggal}\n`;
    msg += '\n';
    msg += Object.entries(response.data)
      .map(([k, v]) => `• <b>${k}</b>: ${v}`)
      .join('\n');
    return { text: msg, keyboard: null };
  }

  return { text: null, keyboard: null };
}

// =============== ABSENSI DETECTION & FORMATTER ===============

/**
 * Deteksi apakah pesan berisi permintaan absensi TEKO-CAK
 */
function detectAbsensiQuery(text) {
  const lower = text.toLowerCase().trim();

  // Pola absensi + tanggal (format: YYYY-MM-DD atau teks Indonesia)
  const absenWithDate = lower.match(/^(absensi|absen|kehadiran)\s+(.+)/);
  if (absenWithDate) {
    let dateStr = absenWithDate[2].trim();
    // Hapus kata "tanggal " di depan jika ada (misal: "absensi tanggal 13 juli")
    dateStr = dateStr.replace(/^tanggal\s+/i, '');
    // Cek apakah itu format tanggal
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || /\d{1,2}\s+[a-z]+/.test(dateStr)) {
      return { tool: 'get_absensi_by_tanggal', args: { tanggal: dateStr } };
    }
  }

  // Pola: "absensi hari ini", "absen hari ini", "absensi now"
  if (/(absensi|absen|kehadiran)\s*(hari\s*ini|sekarang|today)/i.test(lower)) {
    return { tool: 'get_absensi_today', args: {} };
  }
  if (/^(absensi|absen|kehadiran)$/.test(lower)) {
    return { tool: 'get_absensi_today', args: {} };
  }
  if (/(tampilkan|lihat|cek|munculkan)\s*(absensi|absen|kehadiran)/i.test(lower)) {
    return { tool: 'get_absensi_today', args: {} };
  }

  // Pola: "absensi tanggal 13 juli" atau "absensi 13 juli 2026"
  const absenTgl = lower.match(/^(absensi|absen|kehadiran)\s+(tanggal\s+)?(\d{1,2}\s+[a-z]+(?:\s+\d{4})?)$/);
  if (absenTgl) {
    return { tool: 'get_absensi_by_tanggal', args: { tanggal: absenTgl[3] } };
  }

  // Pola: "absensi 2026-07-13" (format YYYY-MM-DD)
  const absenIso = lower.match(/^(absensi|absen|kehadiran)\s+(\d{4}-\d{2}-\d{2})$/);
  if (absenIso) {
    return { tool: 'get_absensi_by_tanggal', args: { tanggal: absenIso[2] } };
  }

  return null;
}

/**
 * Format data absensi ke HTML untuk Telegram
 * Response API (format baru):
 * {
 *   success, tanggal,
 *   ringkasan: { total_pegawai, normal, anomali, rincian_masalah },
 *   anomali: [{ nip, nama, jam_masuk, jam_pulang, keterangan, masalah: [] }]
 * }
 * Normal pegawai hanya ada hitungan di ringkasan.normal (tanpa detail array)
 */
function formatAbsensi(response, title = 'Absensi TEKO-CAK Hari Ini') {
  if (!response) return { text: null, keyboard: null };

  // Jika error
  if (response.success === false) {
    return { text: `📭 ${response.message || 'Tidak ada data absensi'}`, keyboard: null };
  }

  let msg = `📋 <b>${title}</b>\n`;
  if (response.tanggal) msg += `📅 ${response.tanggal}\n`;

  // Ringkasan (format baru: total_pegawai, normal, anomali)
  if (response.ringkasan) {
    const r = response.ringkasan;
    msg += `👥 Total: ${r.total_pegawai || 0} pegawai\n`;
    msg += `✅ Normal: ${r.normal || 0} pegawai\n`;
    msg += `⚠️ Anomali: ${r.anomali || 0} pegawai\n`;
    if (r.rincian_masalah) {
      const rm = r.rincian_masalah;
      const parts = [];
      if (rm.jam_sama) parts.push(`🕐 jam sama ${rm.jam_sama}`);
      if (rm.keterangan_M) parts.push(`📌 Mangkir ${rm.keterangan_M}`);
      if (rm.keterangan_bintang) parts.push(`* ${rm.keterangan_bintang}`);
      if (rm.tanpa_jam) parts.push(`⏺ tanpa jam ${rm.tanpa_jam}`);
      if (parts.length) msg += `📊 ${parts.join(' | ')}\n`;
    }
    msg += `\n`;
  }

  // Daftar anomali (format baru — array anomali dengan detail masalah)
  if (response.anomali && response.anomali.length > 0) {
    msg += `<u>⚠️ ANOMALI (${response.anomali.length})</u>\n\n`;
    const MAX_SHOW = 15;
    const list = response.anomali.slice(0, MAX_SHOW);
    list.forEach((r, i) => {
      const label = r.keterangan === 'H' ? 'Hadir' : r.keterangan === 'M' ? 'Mangkir' : r.keterangan || '';
      msg += `<b>${i + 1}. ${r.nama || '-'}</b>\n`;
      msg += `   🆔 NIP: ${r.nip || '-'}\n`;
      if (r.jam_masuk) msg += `   🟢 Masuk: ${r.jam_masuk}\n`;
      if (r.jam_pulang) msg += `   🔴 Pulang: ${r.jam_pulang}\n`;
      if (label) msg += `   📌 ${label}\n`;
      if (r.masalah && r.masalah.length > 0) {
        r.masalah.forEach(m => msg += `   ⚡ ${m}\n`);
      }
      msg += '\n';
    });
    const remaining = response.anomali.length - MAX_SHOW;
    if (remaining > 0) {
      msg += `... dan ${remaining} anomali lainnya\n\n`;
    }
  }

  if (msg.length <= 50) {
    return { text: null, keyboard: null };
  }

  return { text: msg, keyboard: null };
}

// =============== TEXT MESSAGE HANDLER (Natural Language via AI) ===============

// Kirim indikator "sedang mengetik" agar pengguna tahu bot sedang memproses
async function sendTypingAction(chatId) {
  try {
    await bot.sendChatAction(chatId, 'typing');
  } catch (err) {
    // Abaikan error jika gagal mengirim typing action
  }
}

// Handler untuk pesan teks biasa — diproses oleh AI
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  // Abaikan jika pesan adalah command (sudah ditangani di atas)
  if (text.startsWith('/')) return;

  // Abaikan pesan non-teks (sticker, gambar, dll)
  if (!text) return;

  // Periksa otorisasi
  if (!isAuthorized(chatId)) {
    return bot.sendMessage(
      chatId,
      '⛔ Anda tidak memiliki akses ke bot ini.\n\nGunakan /myid untuk melihat Chat ID Anda, lalu minta admin untuk menambahkannya ke daftar izin.',
    );
  }

  try {
    // Kirim pesan "sedang memproses"
    const waitMsg = await bot.sendMessage(chatId, '⏳ Mohon tunggu, sedang mencari data...');

    // Kirim indikator typing sebagai tambahan
    sendTypingAction(chatId);

    // Cek apakah user sedang dalam flow disposisi (mengetik nama)
    const disposisiState = getDisposisiState(chatId);
    if (disposisiState && disposisiState.step === 'waiting_names') {
      try { await bot.deleteMessage(chatId, waitMsg.message_id); } catch (_) {}

      const result = await saveDisposisi(chatId, text);
      return await bot.sendMessage(
        chatId,
        `✅ *Disposisi berhasil disimpan!*\n\n📌 Tugas: ${disposisiState.jadwalData.nama_acara}\n👥 ${result.totalNama} orang: ${result.names.join(', ')}`,
        { parse_mode: 'Markdown' },
      );
    }

    // Cek apakah ini query jadwal — jika ya, proses langsung tanpa AI
    const jadwalQuery = detectJadwalQuery(text);
    if (jadwalQuery) {
      const result = await executeTool(jadwalQuery.tool, jadwalQuery.args);
      const titles = {
        get_jadwal_rapat_hari_ini: 'Jadwal Rapat Hari Ini 📆',
        get_jadwal_rapat_minggu_ini: 'Jadwal Rapat Minggu Ini 📆',
        get_jadwal_rapat_by_tanggal: `Jadwal Rapat ${jadwalQuery.args.tanggal || ''} 📆`,
        get_semua_jadwal_rapat: 'Semua Jadwal Rapat 📆',
      };
      const formatted = formatJadwal(result, titles[jadwalQuery.tool] || 'Jadwal Rapat');

      try { await bot.deleteMessage(chatId, waitMsg.message_id); } catch (_) {}

      if (formatted.text) {
        const opt = { parse_mode: 'HTML' };
        if (formatted.keyboard && formatted.keyboard.length > 0) {
          opt.reply_markup = { inline_keyboard: formatted.keyboard };
        }
        return await bot.sendMessage(chatId, formatted.text, opt);
      } else {
        return await bot.sendMessage(chatId, '📭 Tidak ada jadwal rapat.');
      }
    }

    // Cek apakah ini query tugas — jika ya, proses langsung tanpa AI
    const tugasQuery = detectTugasQuery(text);
    if (tugasQuery) {
      const result = await executeTool(tugasQuery.tool, tugasQuery.args);
      const titles = {
        get_tugas_hari_ini: 'Tugas Hari Ini 📋',
        get_tugas_by_tanggal: `Tugas ${tugasQuery.args.tanggal || ''} 📋`,
        get_semua_tugas: 'Semua Tugas 📋',
      };
      const formatted = formatTugas(result, titles[tugasQuery.tool] || 'Tugas');

      try { await bot.deleteMessage(chatId, waitMsg.message_id); } catch (_) {}

      if (formatted.text) {
        const opt = { parse_mode: 'HTML' };
        if (formatted.keyboard && formatted.keyboard.length > 0) {
          opt.reply_markup = { inline_keyboard: formatted.keyboard };
        }
        return await bot.sendMessage(chatId, formatted.text, opt);
      } else {
        return await bot.sendMessage(chatId, '📭 Tidak ada tugas.');
      }
    }

    // Cek apakah ini perintah TEKO-CAK (tanpa /)
    const tekocakQuery = detectTekocakQuery(text);
    if (tekocakQuery) {
      try { await bot.deleteMessage(chatId, waitMsg.message_id); } catch (_) {}

      const labels = {
        all: 'Semua Task',
        login: 'Login',
        generate: 'Generate Laporan',
        update: tekocakQuery.nip ? `Update 1 Pegawai (NIP: ${tekocakQuery.nip})` : 'Update Semua Pegawai',
      };
      return runTekocakTask(chatId, tekocakQuery.task, labels[tekocakQuery.task] || tekocakQuery.task, tekocakQuery.nip);
    }

    // Cek apakah ini query BBM Non-Fosil
    const bbmQuery = detectBbmQuery(text);
    if (bbmQuery) {
      try { await bot.deleteMessage(chatId, waitMsg.message_id); } catch (_) {}
      try {
        const result = await executeTool(bbmQuery.tool, bbmQuery.args);
        const formatted = formatBbm(result, 'BBM Non-Fosil Hari Ini 🛢️');
        if (formatted.text) {
          return await bot.sendMessage(chatId, formatted.text, { parse_mode: 'HTML' });
        } else {
          return await bot.sendMessage(chatId, '📭 Tidak ada data BBM Non-Fosil.');
        }
      } catch (err) {
        return await bot.sendMessage(
          chatId,
          `⏳ *BBM Non-Fosil*\n\nServer sedang sibuk, coba lagi nanti ya.\n\n${err.message.includes('timeout') ? '⚠️ Koneksi timeout — mungkin data masih diproses di backend.' : `❌ ${err.message}`}`,
          { parse_mode: 'Markdown' }
        );
      }
    }

    // Cek apakah ini query absensi TEKO-CAK
    const absensiQuery = detectAbsensiQuery(text);
    if (absensiQuery) {
      try { await bot.deleteMessage(chatId, waitMsg.message_id); } catch (_) {}
      try {
        const result = await executeTool(absensiQuery.tool, absensiQuery.args);
        const label = absensiQuery.tool === 'get_absensi_by_tanggal'
          ? `Absensi TEKO-CAK ${result.tanggal || absensiQuery.args.tanggal || ''}`
          : 'Absensi TEKO-CAK Hari Ini';
        await sendAbsensiResponse(chatId, result, label);
        return;
      } catch (err) {
        return await bot.sendMessage(
          chatId,
          `❌ *Absensi Error:* ${err.message}`,
          { parse_mode: 'Markdown' }
        );
      }
    }

    // Jika bukan query database, lanjutkan ke AI
    // Simpan pesan user ke riwayat
    addMessage(chatId, 'user', text);

    // Ambil riwayat percakapan untuk konteks
    const history = getHistory(chatId);

    // Kirim ke AI via OpenRouter
    const reply = await askAI(text, history);

    // Hapus pesan "sedang memproses"
    try {
      await bot.deleteMessage(chatId, waitMsg.message_id);
    } catch (_) {
      // Abaikan jika gagal hapus (misal sudah kehapus)
    }

    // Simpan respons AI ke riwayat
    addMessage(chatId, 'assistant', reply);

    // Kirim balasan ke user
    await bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Error memproses pesan:', error.message);
    await bot.sendMessage(
      chatId,
      '😅 Maaf, terjadi kesalahan. Silakan coba lagi.',
    );
  }
});

// =============== CALLBACK QUERY HANDLER (Inline Keyboard) ===============

bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  const msgId = callbackQuery.message.message_id;

  // ─── Menu Navigasi ───

  if (data === 'menu_jadwal') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: '📅' });
    await bot.sendMessage(chatId,
      '📅 *Cek Jadwal Rapat*\n\n' +
      'Ketik langsung pertanyaan tentang jadwal, contoh:\n' +
      '• "Jadwal rapat hari ini"\n' +
      '• "Rapat tanggal 25 juni 2026"\n' +
      '• "Tampilkan semua rapat minggu ini"\n\n' +
      'Atau gunakan perintah:\n' +
      '• `/absensi` — Cek absensi TEKO-CAK\n' +
      '• `/bbm` — Cek BBM Non-Fosil',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (data === 'menu_tugas') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: '📋' });
    await bot.sendMessage(chatId,
      '📋 *Cek Tugas & Disposisi*\n\n' +
      'Ketik langsung, contoh:\n' +
      '• "Tampilkan tugas hari ini"\n' +
      '• "Apa saja tugas yang ada?"\n' +
      '• "Tugas tanggal 25 juni"\n\n' +
      'Atau gunakan perintah /help untuk bantuan.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (data === 'menu_tekocak') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: '🤖' });
    await bot.sendMessage(chatId,
      '🤖 *TEKO-CAK Menu*\n\n' +
      '`/tekocak` — Jalankan semua task (Login → Generate → Update)\n' +
      '`/tekocak login` — Login saja\n' +
      '`/tekocak generate` — Generate laporan absensi\n' +
      '`/tekocak update` — Update semua pegawai\n' +
      '`/tekocak update <NIP>` — Update 1 pegawai\n' +
      '`/absensi` — Cek absensi hari ini\n' +
      '`/tekocak help` — Bantuan lengkap\n\n' +
      '⏱️ Proses update butuh beberapa menit.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (data === 'menu_absensi') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: '📊' });
    try {
      const api = require('../services/apiClient');
      const data = await api.getAbsensiHariIni();
      await sendAbsensiResponse(chatId, data, 'Absensi TEKO-CAK Hari Ini');
    } catch (err) {
      await bot.sendMessage(chatId, '❌ Error mengambil data absensi: ' + err.message);
    }
    return;
  }

  if (data === 'menu_bbm') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: '🛢️' });
    try {
      const api = require('../services/apiClient');
      const data = await api.getBbmNonFosilHariIni();
      const formatted = formatBbm(data, 'BBM Non-Fosil Hari Ini 🛢️');
      if (formatted && formatted.text) {
        await bot.sendMessage(chatId, formatted.text, { parse_mode: 'HTML' });
      } else {
        await bot.sendMessage(chatId, '📭 Tidak ada data BBM Non-Fosil hari ini.');
      }
    } catch (err) {
      await bot.sendMessage(chatId, '❌ Error: ' + err.message);
    }
    return;
  }

  if (data === 'menu_status') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'ℹ️' });
    // Re-use status logic
    const aiConfigured = process.env.OPENROUTER_API_KEY ? '✅ Terkonfigurasi' : '❌ Belum diatur';
    const aiModel = process.env.OPENROUTER_MODEL || 'cohere/north-mini-code:free';
    let dbStatusText = '⚠️ Tidak bisa hubungi API backend';
    try {
      const api = require('../services/apiClient');
      const health = await api.healthCheck();
      if (health.databases) {
        dbStatusText = health.databases
          .map((s) => `  ${s.ok ? '✅' : '❌'} ${s.name}: ${s.ok ? 'Terhubung' : s.message}`)
          .join('\n');
      }
    } catch (err) {
      dbStatusText = `  ❌ API: ${err.message}`;
    }
    await bot.sendMessage(chatId,
      '✅ *Bot Status: AKTIF*\n\n' +
      '📡 Mode: Polling\n' +
      '🧠 AI: ' + aiConfigured + '\n' +
      '🤖 Model: ' + aiModel + '\n' +
      '🗄 *Database:*\n' + dbStatusText + '\n' +
      '⏱ Waktu: ' + new Date().toLocaleString('id-ID'),
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (data === 'menu_help') {
    await bot.answerCallbackQuery(callbackQuery.id, { text: '❓' });
    const helpMessage = `
📋 *Bantuan — BKPSDM Telegram Bot*

🧠 *Bot ini didukung AI dari OpenRouter!*
Kamu bisa ngobrol dengan bahasa alami, tidak perlu perintah kaku.

💬 *Contoh percakapan:*
• "Halo, apa kabar?"
• "Jadwal rapat hari ini?"
• "Tampilkan jadwal rapat 26 juni"
• "Munculkan tugas 25 juni"
• "Tugas hari ini"

📌 *Perintah khusus:*
/start — Menu utama
/help — Bantuan ini
/reset — Hapus riwayat chat
/status — Cek status bot
/info — Info akun kamu
/tekocak — Automasi absensi TEKO-CAK
/absensi — Cek absensi TEKO-CAK hari ini
/bbm — Cek BBM Non-Fosil

💡 *Tips:* Semakin detail pertanyaanmu, semakin baik jawabannya!
    `;
    await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
    return;
  }

  // ─── Existing handlers ───

  // Handler: Hapus Tugas
  if (data.startsWith('hapus_tugas_')) {
    const tugasId = data.replace('hapus_tugas_', '');

    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: chatId,
        message_id: msgId,
      });
    } catch (_) {}

    const deleted = await deleteTugas(tugasId);
    if (deleted) {
      return bot.sendMessage(chatId, `🗑 *Tugas berhasil dihapus!* (ID: ${tugasId})`, { parse_mode: 'Markdown' });
    } else {
      return bot.sendMessage(chatId, '❌ Tugas tidak ditemukan atau gagal dihapus.');
    }
  }

  // Handler: Disposisi
  if (!data.startsWith('disposisi_')) return;

  const jadwalId = data.replace('disposisi_', '');
  
  // Cari data jadwal via API
  let rows;
  try {
    rows = await api.getJadwalById(jadwalId);
  } catch (err) {
    return bot.sendMessage(chatId, '❌ Data rapat tidak ditemukan.');
  }

  if (!rows || rows.length === 0) {
    return bot.sendMessage(chatId, '❌ Data rapat tidak ditemukan.');
  }

  // Simpan state disposisi
  startDisposisi(chatId, jadwalId, rows[0]);

  // Hapus tombol agar tidak diklik lagi
  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId,
      message_id: msgId,
    });
  } catch (_) {}

  const namaAcara = rows[0].nama_acara;
  await bot.sendMessage(
    chatId,
    `📌 *Disposisi Rapat:*\n${namaAcara}\n\n✏️ Ketik nama orang yang disposisi, pisahkan dengan koma.\nContoh: \`Budi, Siti, Ahmad\``,
    { parse_mode: 'Markdown' },
  );
});

// =============== ERROR HANDLING ===============

bot.on('polling_error', (error) => {
  console.error('❌ Polling error:', error.message);
});

bot.on('error', (error) => {
  console.error('❌ Bot error:', error.message);
});

// =============== GRACEFUL SHUTDOWN ===============

process.on('SIGINT', async () => {
  console.log('\n🛑 Menghentikan bot...');
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Menghentikan bot...');
  bot.stopPolling();
  process.exit(0);
});
