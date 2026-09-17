require('dotenv').config();
const { TelegramBot } = require('node-telegram-bot-api');
const { askAI } = require('../services/ai');
const { getHistory, addMessage, clearHistory } = require('../services/conversation');
const api = require('../services/apiClient');
const { startDisposisi, getDisposisiState, clearDisposisiState, saveDisposisi, deleteTugas } = require('../services/disposisi');
const tekocak = require('../services/tekocak');
const kantorkuWfh = require('../services/kantorkuWfh');
const fs = require('fs');
const path = require('path'); // dipakai blok forward captcha (CAPTCHA_DIRS) — sebelumnya HILANG → ReferenceError tiap pesan teks biasa
const { generateAbsensiPdf } = require('../services/pdfGenerator');
const { isPulangCepat, countPulangCepat } = require('../services/absensiRules');
const { executeTool, parseIndonesianDate } = require('../services/dbTools');
// ===== Core dispatcher (channel-agnostic — dipakai Telegram & WhatsApp) =====
const {
  handleMessage,
  buildAbsensiReply,
  formatJadwal,
  formatTugas,
  formatBbm,
  formatAbsensi,
  detectJadwalQuery,
  detectTugasQuery,
  detectBbmQuery,
  detectAbsensiQuery,
} = require('../core/dispatcher');

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
• 📨 Cek undangan eSurat (unit Sekretariat)
• 🧠 Didukung AI dari OpenRouter

👇 *Pilih menu di bawah atau ketik perintah langsung:*
  `;

  bot.sendMessage(chatId, welcomeMessage, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📅 Jadwal Hari Ini', callback_data: 'cmd_jadwal_hariini' }, { text: '📅 Jadwal Besok', callback_data: 'cmd_jadwal_besok' }],
        [{ text: '📅 Minggu Ini', callback_data: 'cmd_jadwal_mingguini' }, { text: '📅 Semua Jadwal', callback_data: 'cmd_jadwal_semua' }],
        [{ text: '📋 Tugas Hari Ini', callback_data: 'cmd_tugas_hariini' }, { text: '📋 Tugas Besok', callback_data: 'cmd_tugas_besok' }],
        [{ text: '📋 Semua Tugas', callback_data: 'cmd_tugas_semua' }, { text: '📊 Absensi', callback_data: 'cmd_absensi' }],
        [{ text: '🛢️ BBM Non-Fosil', callback_data: 'cmd_bbm' }, { text: '🤖 TEKO-CAK', callback_data: 'menu_tekocak' }],
        [{ text: '📨 Undangan Hari Ini', callback_data: 'cmd_undangan_hariini' }, { text: '📨 Undangan Besok', callback_data: 'cmd_undangan_besok' }],
        [{ text: 'ℹ️ Status', callback_data: 'menu_status' }, { text: '❓ Bantuan', callback_data: 'menu_help' }],
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
/tekocak — Automasi absensi TEKO-CAK (/tekocak help)
/kantorku — Automasi KantorKu WFH (/kantorku YYYY-MM-DD)
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
async function runTekocakTask(chatId, taskName, label, nip = null, tanggal = null) {
  // Kirim status awal
  const statusMsg = await bot.sendMessage(
    chatId,
    `⏳ **TEKO-CAK: ${label}**${nip ? ` (NIP: ${nip})` : ''}\n\nMemproses... mohon tunggu, ini bisa beberapa menit.`,
    { parse_mode: 'Markdown' }
  );

  // Kumpulkan log
  const logs = [];
  let lastProgressEdit = 0;

  // Escape karakter Markdown untuk tampilan live — baris log mentah bisa
  // mengandung karakter yang bikin parse error saat editMessageText.
  const escapeMarkdown = (s) => String(s || '').replace(/([_*[\]`])/g, '\\$1');

  const onProgress = (msg) => {
    logs.push(msg);

    // ⏳ LIVE PROGRESS: update status message berjalan (throttle ~2 detik
    // karena Telegram punya rate limit edit). Berlaku untuk SEMUA task
    // (/tekocak generate, generate tanggal, update, all).
    const now = Date.now();
    if (now - lastProgressEdit >= 2000) {
      lastProgressEdit = now;
      const line = String(msg || '').trim();
      const liveText = `⏳ **TEKO-CAK: ${label}**${nip ? ` (NIP: ${nip})` : ''}\n\n${escapeMarkdown(line) || 'Memproses...'}`;
      bot.editMessageText(liveText, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        parse_mode: 'Markdown',
      }).catch(() => {});
    }
  };

  try {
    const result = await tekocak.runTask(taskName, onProgress, nip, tanggal);
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
    // Dukungan tanggal spesifik: /tekocak generate tanggal 4 agustus
    // → fungsi baru generate-tanggal (perintah generate biasa TIDAK berubah)
    const argTanggal = parts.slice(1).join(' ').trim();
    if (argTanggal) {
      const cleaned = argTanggal.replace(/^tanggal\s+/i, '');
      const tanggal = parseIndonesianDate(cleaned);
      if (!tanggal) {
        return bot.sendMessage(
          chatId,
          `❌ Tanggal tidak dikenali: \`${cleaned}\`\n\n` +
          `Contoh: \`/tekocak generate tanggal 4 agustus\`\n` +
          `Format lain: \`4 agustus 2026\`, \`2026-08-04\`, \`04/08/2026\``,
          { parse_mode: 'Markdown' }
        );
      }
      return runTekocakTask(chatId, 'generate-tanggal', `Generate Laporan (${tanggal})`, null, tanggal);
    }
    return runTekocakTask(chatId, 'generate', 'Generate Laporan');
  }
  if (cmd === 'update' || cmd === 'upd') {
    // /tekocak update <NIP>            → update 1 pegawai spesifik
    // /tekocak update [tanggal] <tgl>  → update pegawai anomali di PDF absensi tanggal itu
    // /tekocak update                  → update pegawai anomali di PDF absensi hari ini
    const rest = parts.slice(1).join(' ').trim();
    if (rest) {
      const cleaned = rest.replace(/^tanggal\s+/i, '');
      if (/^\d{16,18}$/.test(cleaned)) {
        return runTekocakTask(chatId, 'update', `Update 1 Pegawai (NIP: ${cleaned})`, cleaned);
      }
      const tanggal = parseIndonesianDate(cleaned);
      if (!tanggal) {
        return bot.sendMessage(
          chatId,
          `❌ Argumen tidak dikenali: \`${cleaned}\`\n\n` +
          `Contoh:\n` +
          `• \`/tekocak update\` — update pegawai anomali di PDF absensi hari ini\n` +
          `• \`/tekocak update <NIP>\` — update 1 pegawai spesifik\n` +
          `• \`/tekocak update 2 september\` — update pegawai anomali di PDF absensi 2 Sep\n\n` +
          `Format tanggal lain: \`2 september 2026\`, \`2026-09-02\`, \`02/09/2026\``,
          { parse_mode: 'Markdown' }
        );
      }
      return runTekocakTask(chatId, 'update', `Update Pegawai — PDF absensi ${tanggal}`, null, tanggal);
    }
    return runTekocakTask(chatId, 'update', 'Update Semua Pegawai');
  }
  if (cmd === 'help' || cmd === 'h') {
    const help = [
      '📋 **Perintah TEKO-CAK:**',
      '',
      '`/tekocak` — Jalankan semua task (Login → Generate → Update)',
      '`/tekocak login` — Login saja',
      '`/tekocak generate` — Generate laporan absensi (kemarin → hari ini)',
      '`/tekocak generate tanggal <tanggal>` — Generate laporan tanggal spesifik, contoh: `/tekocak generate tanggal 4 agustus`',
      '`/tekocak update` — Update pegawai anomali di PDF absensi hari ini',
      '`/tekocak update <NIP>` — Update 1 pegawai spesifik',
      '`/tekocak update <tanggal>` — Update pegawai anomali di PDF absensi tanggal itu, contoh: `/tekocak update 2 september`',
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

// =============== KANTORKU WFH COMMAND ===============

/**
 * Helper: jalankan KantorKu WFH dan kirim hasil ke Telegram
 */
async function runKantorkuWfhTask(chatId, tanggal) {
  const tglDisplay = tanggal || 'hari ini';
  const statusMsg = await bot.sendMessage(
    chatId,
    `⏳ **KantorKu WFH — ${tglDisplay}**\n\nMemproses... mohon tunggu, ini bisa beberapa menit.`,
    { parse_mode: 'Markdown' }
  );

  try {
    const result = await kantorkuWfh.runWfh(tanggal);
    try { await bot.deleteMessage(chatId, statusMsg.message_id); } catch (_) {}

    const statusIcon = result.success ? '✅' : '❌';
    let output = result.output;

    // Ambil baris penting saja (filter noise)
    const lines = output.split('\n').filter(l => l.trim());
    const important = lines.filter(l =>
      /✅|❌|📂|📋|👤|💾|⚠️|🚀|🛑|Error|berhasil|gagal|mode|Login|Sampai|field|terisi|Save|ditutup|ditemukan|terpilih/.test(l)
    );
    const summary = important.slice(0, 15).join('\n');

    const fullMsg = `${statusIcon} **KantorKu WFH — ${tglDisplay} ${result.success ? 'BERHASIL' : 'GAGAL'}**\n⏱ ${result.duration} detik\n\n${summary || output}`;

    const MAX_LEN = 4000;
    if (fullMsg.length <= MAX_LEN) {
      await bot.sendMessage(chatId, fullMsg, { parse_mode: 'Markdown' });
    } else {
      const tmpPath = `/tmp/kantorku-wfh-${Date.now()}.log`;
      require('fs').writeFileSync(tmpPath, output, 'utf-8');
      await bot.sendMessage(chatId, `${statusIcon} **KantorKu WFH — ${tglDisplay} ${result.success ? 'BERHASIL' : 'GAGAL'}**\n⏱ ${result.duration} detik\n\n📄 Output terlalu panjang, dikirim sebagai file.`, { parse_mode: 'Markdown' });
      await bot.sendDocument(chatId, tmpPath);
      try { require('fs').unlinkSync(tmpPath); } catch (_) {}
    }
  } catch (err) {
    try { await bot.deleteMessage(chatId, statusMsg.message_id); } catch (_) {}
    await bot.sendMessage(
      chatId,
      `❌ **KantorKu WFH Error:**\n${err.message}`,
      { parse_mode: 'Markdown' }
    );
  }
}

// /kantorku — jalankan WFH dengan tanggal
bot.onText(/\/kantorku(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAuthorized(chatId)) {
    return bot.sendMessage(chatId, '⛔ Anda tidak memiliki akses ke bot ini.');
  }

  const dateInput = (match[1] || '').trim();
  if (!dateInput) {
    // Tanya tanggal
    return bot.sendMessage(chatId,
      '📅 **KantorKu WFH**\n\nGunakan:\n`/kantorku YYYY-MM-DD`\n`/kantorku 31 juli`\n`/kantorku 31 juli 2026`\n\nAtau ketik langsung:\n`kantorku wfh tanggal 31 juli`',
      { parse_mode: 'Markdown' }
    );
  }

  // Parse tanggal
  const parsed = parseIndonesianDate(dateInput);
  if (parsed) {
    return runKantorkuWfhTask(chatId, parsed);
  }

  // Coba format ISO langsung
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    return runKantorkuWfhTask(chatId, dateInput);
  }

  return bot.sendMessage(chatId, `❌ Format tanggal tidak dikenal: \`${dateInput}\`\nGunakan format \`YYYY-MM-DD\` atau teks seperti \`31 juli 2026\``, { parse_mode: 'Markdown' });
});

// =============== ABSENSI COMMAND ===============

/**
 * Render satu Reply object (dari dispatcher) ke Telegram.
 * type: 'text' → sendMessage | 'document' → sendDocument | 'menu' → teks + inline keyboard
 */
async function renderReply(chatId, reply) {
  if (!reply) return;

  if (reply.type === 'document') {
    await bot.sendDocument(chatId, reply.path, {
      caption: reply.caption,
      parse_mode: reply.parse_mode,
    });
    try { fs.unlinkSync(reply.path); } catch (_) {}
    return;
  }

  if (reply.type === 'menu') {
    const opt = { parse_mode: reply.parse_mode || 'HTML' };
    if (reply.options && reply.options.length > 0) {
      opt.reply_markup = { inline_keyboard: reply.options };
    }
    await bot.sendMessage(chatId, reply.text, opt);
    return;
  }

  // type: 'text'
  const opt = reply.parse_mode ? { parse_mode: reply.parse_mode } : {};
  await bot.sendMessage(chatId, reply.text, opt);
}

/**
 * Helper: kirim absensi (teks atau PDF tergantung jumlah data)
 * — logika ada di dispatcher.buildAbsensiReply (dipakai bersama WhatsApp)
 */
async function sendAbsensiResponse(chatId, data, label = 'Absensi TEKO-CAK Hari Ini') {
  const reply = await buildAbsensiReply(data, label);
  await renderReply(chatId, reply);
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
// (JADWAL_PATTERNS, BULAN_MAP, parseTanggal, detectJadwalQuery, detectTugasQuery
//  → dipindah ke src/core/dispatcher.js — dipakai bersama Telegram & WhatsApp)

/**

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

// (detectBbmQuery, formatJadwal, formatTugas, formatBbm
//  → dipindah ke src/core/dispatcher.js)

// =============== ABSENSI DETECTION & FORMATTER ===============
// (detectAbsensiQuery, formatAbsensi → dipindah ke src/core/dispatcher.js)

/**
 * Deteksi apakah pesan berisi perintah KantorKu WFH
 */
function detectKantorkuWfhQuery(text) {
  const lower = text.toLowerCase().trim();

  // Pola: "kantorku wfh tanggal 31 juli" atau "kantorku wfh 31 juli 2026"
  // atau "kantorku wfh 2026-07-31"
  const match = lower.match(/^kantorku\s+wfh(?:\s+tanggal)?\s+(.+)/);
  if (match) {
    const dateStr = match[1].trim();

    // Format ISO: YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return { tanggal: dateStr };
    }

    // Format teks Indonesia: "31 juli" atau "31 juli 2026"
    const tglMatch = dateStr.match(/^(\d{1,2})\s+(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|jan|feb|mar|apr|mei|jun|jul|agt|sep|okt|nov|des)(?:\s+(\d{4}))?$/);
    if (tglMatch) {
      const BULAN_MAP = {
        januari:1,februari:2,maret:3,april:4,mei:5,juni:6,juli:7,agustus:8,september:9,oktober:10,november:11,desember:12,
        jan:1,feb:2,mar:3,apr:4,mei:5,jun:6,jul:7,agt:8,sep:9,okt:10,nov:11,des:12,
      };
      const d = tglMatch[1].padStart(2, '0');
      const m = String(BULAN_MAP[tglMatch[2].toLowerCase()]).padStart(2, '0');
      const y = tglMatch[3] || String(new Date().getFullYear());
      return { tanggal: `${y}-${m}-${d}` };
    }
  }

  // Pola: "kantorku wfh" saja (tanpa tanggal)
  if (/^kantorku\s+wfh$/.test(lower)) {
    return { tanggal: null }; // akan pakai tanggal hari ini
  }

  return null;
}

// (formatAbsensi → dipindah ke src/core/dispatcher.js)

// =============== TEXT MESSAGE HANDLER (Natural Language via AI) ===============

// Kirim indikator "sedang mengetik" agar pengguna tahu bot sedang memproses
async function sendTypingAction(chatId) {
  try {
    await bot.sendChatAction(chatId, 'typing');
  } catch (err) {
    // Abaikan error jika gagal mengirim typing action
  }
}

// Handler untuk pesan teks biasa — jadwal/tugas/BBM/absensi/AI lewat core dispatcher
// (sama persis yang dipakai WhatsApp — satu logika, dua channel)
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

  // ── Forward jawaban captcha ke file (pola generik: satu folder per automation) ──
  // Jika ada pending_captcha.json di salah satu folder, teks user dianggap kode
  // captcha dan ditulis ke captcha_answer.txt folder itu.
  //   - automated-pengaduan-listener  → login SPB
  //   - automated-organisasi-iko      → auto-login Monev (fallback saat AI gagal)
  const CAPTCHA_DIRS = [
    path.join(__dirname, '../../automated-pengaduan-listener'),
    path.join(__dirname, '../../automated-organisasi-iko'),
  ];
  try {
    for (const dir of CAPTCHA_DIRS) {
      const pendingPath = path.join(dir, 'pending_captcha.json');
      const answerPath = path.join(dir, 'captcha_answer.txt');
      if (!fs.existsSync(pendingPath)) continue;
      const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
      const expired = Date.now() - (pending.createdAt || 0) > 10 * 60 * 1000;
      if (!expired) {
        fs.writeFileSync(answerPath, text.trim());
        return bot.sendMessage(chatId, '✅ Kode captcha diterima, mencoba login ulang...');
      }
      fs.unlinkSync(pendingPath); // pending basi — hapus
    }
  } catch (_) { /* abaikan error file */ }

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

    // Cek perintah TEKO-CAK tanpa slash (Telegram-only — Fase 3 untuk WA)
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

    // Cek perintah KantorKu WFH tanpa slash (Telegram-only)
    const kantorkuQuery = detectKantorkuWfhQuery(text);
    if (kantorkuQuery) {
      try { await bot.deleteMessage(chatId, waitMsg.message_id); } catch (_) {}
      const tanggal = kantorkuQuery.tanggal || new Date().toISOString().slice(0, 10);
      return runKantorkuWfhTask(chatId, tanggal);
    }

    // Sisanya → core dispatcher (jadwal/tugas/BBM/absensi/AI)
    try { await bot.deleteMessage(chatId, waitMsg.message_id); } catch (_) {}
    const replies = await handleMessage({ text, userId: chatId, authorized: true, channel: 'telegram' });
    for (const reply of replies) {
      await renderReply(chatId, reply);
    }
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

  // Tombol perintah langsung (cmd_*) → panggil dispatcher handleMessage
  const CMD_MAP = {
    cmd_jadwal_hariini: 'jadwal-hariini',
    cmd_jadwal_besok: 'jadwal-besok',
    cmd_jadwal_mingguini: 'jadwal-mingguini',
    cmd_jadwal_semua: 'jadwal-semua',
    cmd_tugas_hariini: 'tugas-hariini',
    cmd_tugas_besok: 'tugas-besok',
    cmd_tugas_semua: 'tugas-semua',
    cmd_absensi: 'absensi',
    cmd_bbm: 'bbm',
    cmd_undangan_hariini: 'undangan-hariini',
    cmd_undangan_besok: 'undangan-besok',
  };
  if (CMD_MAP[data]) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: '⏳ Memproses...' });
    try {
      const replies = await handleMessage({ text: CMD_MAP[data], userId: chatId, authorized: true, channel: 'telegram' });
      for (const reply of replies) {
        await renderReply(chatId, reply);
      }
    } catch (err) {
      console.error('❌ Error cmd:', err.message);
      await bot.sendMessage(chatId, '😅 Maaf, terjadi kesalahan. Silakan coba lagi.');
    }
    return;
  }

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
/kantorku — Automasi KantorKu WFH
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
