require('dotenv').config();
const { TelegramBot } = require('node-telegram-bot-api');
const { askAI } = require('./services/ai');
const { getHistory, addMessage, clearHistory } = require('./services/conversation');
const { checkConnection, checkAllConnections, closeAllPools, query } = require('./services/database');
const { startDisposisi, getDisposisiState, clearDisposisiState, saveDisposisi, deleteTugas } = require('./services/disposisi');

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

// Cek koneksi database saat startup (tidak blocking)
(async () => {
  const results = await checkAllConnections();
  results.forEach((status) => {
    if (status.ok) {
      console.log(`  ✅ ${status.name}: ${status.message}`);
    } else {
      console.warn(`  ⚠️ ${status.name}: ${status.message} (bot tetap berjalan)`);
    }
  });
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
• ❓ Jawab pertanyaan seputar kepegawaian
• 🧠 Didukung AI dari OpenRouter

📋 *Perintah:*
/start — Mulai ulang percakapan
/help — Bantuan & tips
/reset — Reset riwayat chat
/status — Cek status bot
/info — Info pengguna

Coba kirim pesan apa saja, saya akan merespons dengan cerdas! 🚀
  `;

  bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
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
  const aiModel = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free';

  // Cek status semua database (real-time)
  const dbResults = await checkAllConnections();
  const dbStatusText = dbResults
    .map((s) => `  ${s.ok ? '✅' : '❌'} ${s.name}: ${s.ok ? 'Terhubung' : s.message}`)
    .join('\n');

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

// =============== DIRECT DATABASE QUERY HANDLER ===============

/**
 * Deteksi apakah pesan berisi permintaan jadwal rapat
 * Jika ya, langsung query database tanpa lewat AI
 */
const { executeTool } = require('./services/dbTools');

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

function formatJadwal(rows, title) {
  if (!rows || rows.length === 0) return { text: null, keyboard: null };
  if (rows.message) return { text: `📭 ${rows.message}`, keyboard: null };

  let msg = `📅 *${title}*\n\n`;
  const keyboard = [];

  rows.forEach((r, i) => {
    const waktu = r.pukul_mulai ? r.pukul_mulai.slice(0, 5) : '-';
    msg += `${i + 1}. *${r.nama_acara}*\n`;
    msg += `   ⏰ ${waktu}`;
    if (r.tempat) msg += ` | 📍 ${r.tempat}`;
    msg += '\n\n';
    keyboard.push([{ text: `📌 Disposisi #${i + 1}`, callback_data: `disposisi_${r.id}` }]);
  });

  msg += '_Klik tombol di bawah untuk disposisi rapat_';
  return { text: msg, keyboard };
}

function formatTugas(rows, title) {
  if (!rows || rows.length === 0) return { text: null, keyboard: null };
  if (rows.message) return { text: `📭 ${rows.message}`, keyboard: null };
  if (rows.error) return { text: `⚠️ ${rows.message}`, keyboard: null };

  let msg = `📋 *${title}*\n\n`;
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
    msg += '\n\n';
    keyboard.push([{ text: `🗑 Hapus #${i + 1}`, callback_data: `hapus_tugas_${r.id}` }]);
  });

  msg += '_Klik 🗑 Hapus untuk menghapus tugas_';
  return { text: msg, keyboard };
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
        const opt = { parse_mode: 'Markdown' };
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
        const opt = { parse_mode: 'Markdown' };
        if (formatted.keyboard && formatted.keyboard.length > 0) {
          opt.reply_markup = { inline_keyboard: formatted.keyboard };
        }
        return await bot.sendMessage(chatId, formatted.text, opt);
      } else {
        return await bot.sendMessage(chatId, '📭 Tidak ada tugas.');
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
  
  // Cari data jadwal dari result yang sudah ditampilkan
  const rows = await query(
    'web',
    `SELECT id, nama_acara, tanggal_mulai, pukul_mulai, tempat
     FROM dashboard_web_jadwal_rapat WHERE id = ?`,
    [jadwalId],
  );

  if (rows.length === 0) {
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
  await closeAllPools();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Menghentikan bot...');
  bot.stopPolling();
  await closeAllPools();
  process.exit(0);
});
