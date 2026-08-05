/**
 * BKPSDM Agent — Channel-Agnostic Core Dispatcher (Fase 1)
 *
 * Satu logika, dua channel (Telegram & WhatsApp).
 * Semua handler di sini TIDAK tahu cara kirim ke Telegram/WA — mereka
 * cuma mengembalikan Reply object, dan adapter channel yang merender.
 *
 * Reply types:
 *   { type: 'text',     text, parse_mode }                       → pesan teks
 *   { type: 'document', path, caption, parse_mode }              → file (PDF)
 *   { type: 'menu',     text, options: [{id,label}], parse_mode }→ teks + opsi (TG: inline keyboard)
 *
 * Fase 1 scope: jadwal rapat, tugas/disposisi, BBM, absensi (teks+PDF), AI chat.
 * TEKO-CAK & KantorKu WFH tetap Telegram-only (Fase 3).
 */

const api = require('../services/apiClient');
const { executeTool, parseIndonesianDate } = require('../services/dbTools');
const { getHistory, addMessage, clearHistory } = require('../services/conversation');
const { askAI } = require('../services/ai');
const { generateAbsensiPdf } = require('../services/pdfGenerator');
const { isPulangCepat, countPulangCepat } = require('../services/absensiRules');

// =============== DETEKSI QUERY (diport verbatim dari bot.js) ===============

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

  if (/(jadwal|rapat|agenda).*(hari\s*ini|sekarang)/i.test(lower)) {
    return { tool: 'get_jadwal_rapat_hari_ini', args: {} };
  }
  if (/(jadwal|rapat|agenda).*(minggu\s*ini)/i.test(lower)) {
    return { tool: 'get_jadwal_rapat_minggu_ini', args: {} };
  }
  if (/(tampilkan|munculkan|lihat).*(semua)\s*(jadwal|rapat)/i.test(lower) ||
      /semua\s*(jadwal|rapat)/i.test(lower)) {
    return { tool: 'get_semua_jadwal_rapat', args: {} };
  }
  const tanggal = parseTanggal(text);
  if (tanggal && /(jadwal|rapat|agenda|tampilkan|munculkan)/i.test(lower)) {
    return { tool: 'get_jadwal_rapat_by_tanggal', args: { tanggal } };
  }
  const angkaMatch = text.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2})|(\d{1,2}[-/]\d{1,2}[-/]\d{4})/);
  if (angkaMatch && /(jadwal|rapat|agenda|tampilkan|munculkan|tanggal)/i.test(lower)) {
    return { tool: 'get_jadwal_rapat_by_tanggal', args: { tanggal: angkaMatch[0] } };
  }
  return null;
}

function detectTugasQuery(text) {
  const lower = text.toLowerCase();

  if (/(tugas|disposisi).*(hari\s*ini|sekarang)/i.test(lower)) {
    return { tool: 'get_tugas_hari_ini', args: {} };
  }
  if (/(tampilkan|munculkan|lihat).*(semua)\s*(tugas|disposisi)/i.test(lower) ||
      /semua\s*(tugas|disposisi)/i.test(lower)) {
    return { tool: 'get_semua_tugas', args: {} };
  }
  const tanggal = parseTanggal(text);
  if (tanggal && /(tugas|disposisi|tampilkan|munculkan)/i.test(lower)) {
    return { tool: 'get_tugas_by_tanggal', args: { tanggal } };
  }
  const angkaMatch = text.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2})|(\d{1,2}[-/]\d{1,2}[-/]\d{4})/);
  if (angkaMatch && /(tugas|disposisi|tampilkan|munculkan|tanggal)/i.test(lower)) {
    return { tool: 'get_tugas_by_tanggal', args: { tanggal: angkaMatch[0] } };
  }
  return null;
}

function detectBbmQuery(text) {
  const lower = text.toLowerCase().trim();

  const bbmWithDate = lower.match(/^bbm(?:\s+non.?fosil)?(?:\s+tanggal)?\s+(.+)/);
  if (bbmWithDate) {
    const dateStr = bbmWithDate[1].trim();
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

function detectAbsensiQuery(text) {
  const lower = text.toLowerCase().trim();

  const absenWithDate = lower.match(/^(absensi|absen|kehadiran)\s+(.+)/);
  if (absenWithDate) {
    let dateStr = absenWithDate[2].trim();
    dateStr = dateStr.replace(/^tanggal\s+/i, '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || /\d{1,2}\s+[a-z]+/.test(dateStr)) {
      return { tool: 'get_absensi_by_tanggal', args: { tanggal: dateStr } };
    }
  }
  if (/(absensi|absen|kehadiran)\s*(hari\s*ini|sekarang|today)/i.test(lower)) {
    return { tool: 'get_absensi_today', args: {} };
  }
  if (/^(absensi|absen|kehadiran)$/.test(lower)) {
    return { tool: 'get_absensi_today', args: {} };
  }
  if (/(tampilkan|lihat|cek|munculkan)\s*(absensi|absen|kehadiran)/i.test(lower)) {
    return { tool: 'get_absensi_today', args: {} };
  }
  const absenTgl = lower.match(/^(absensi|absen|kehadiran)\s+(tanggal\s+)?(\d{1,2}\s+[a-z]+(?:\s+\d{4})?)$/);
  if (absenTgl) {
    return { tool: 'get_absensi_by_tanggal', args: { tanggal: absenTgl[3] } };
  }
  const absenIso = lower.match(/^(absensi|absen|kehadiran)\s+(\d{4}-\d{2}-\d{2})$/);
  if (absenIso) {
    return { tool: 'get_absensi_by_tanggal', args: { tanggal: absenIso[2] } };
  }
  return null;
}

// =============== FORMATTER (diport verbatim dari bot.js) ===============

/**
 * Format jadwal rapat.
 * channel 'whatsapp' → tanpa hint tombol disposisi (WA Fase 1 belum punya disposisi).
 */
function formatJadwal(rows, title, channel = 'telegram') {
  if (!rows || rows.length === 0) return { text: null, keyboard: [] };
  if (rows.message) return { text: `📭 ${rows.message}`, keyboard: [] };

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

  if (channel === 'telegram') {
    msg += '<i>Klik tombol di bawah untuk disposisi rapat</i>';
  }
  return { text: msg, keyboard };
}

function formatTugas(rows, title, channel = 'telegram') {
  if (!rows || rows.length === 0) return { text: null, keyboard: [] };
  if (rows.message) return { text: `📭 ${rows.message}`, keyboard: [] };
  if (rows.error) return { text: `⚠️ ${rows.message}`, keyboard: [] };

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

  if (channel === 'telegram') {
    msg += '<i>Klik 🗑 Hapus untuk menghapus tugas</i>';
  }
  return { text: msg, keyboard };
}

function formatBbm(response, title) {
  if (!response) return { text: null };

  if (response.success === false) {
    return { text: `📭 ${response.message || 'Tidak ada data BBM Non-Fosil'}` };
  }
  if (response.text) {
    let msg = `🛢️ <b>${title}</b>\n\n`;
    msg += response.text;
    return { text: msg };
  }
  if (response.data) {
    let msg = `🛢️ <b>${title}</b>\n`;
    if (response.tanggal) msg += `📅 ${response.tanggal}\n`;
    msg += '\n';
    msg += Object.entries(response.data)
      .map(([k, v]) => `• <b>${k}</b>: ${v}`)
      .join('\n');
    return { text: msg };
  }
  return { text: null };
}

function formatAbsensi(response, title = 'Absensi TEKO-CAK Hari Ini') {
  if (!response) return { text: null };

  if (response.success === false) {
    return { text: `📭 ${response.message || 'Tidak ada data absensi'}` };
  }

  let msg = `📋 <b>${title}</b>\n`;
  if (response.tanggal) msg += `📅 ${response.tanggal}\n`;

  // Ringkasan — DR dianggap Hadir
  if (response.ringkasan) {
    const r = response.ringkasan;
    const anomaliRaw = response.anomali || [];
    const drCount = anomaliRaw.filter(a => (a.keterangan || '').toUpperCase() === 'DR').length;
    const normal = (r.normal || 0) + drCount;
    const anomali = (r.anomali || 0) - drCount;
    msg += `👥 Total: ${r.total_pegawai || 0} pegawai\n`;
    msg += `✅ Normal: ${normal} pegawai\n`;
    msg += `⚠️ Anomali: ${anomali} pegawai\n`;
    if (r.rincian_masalah) {
      const rm = r.rincian_masalah;
      const parts = [];
      if (rm.jam_sama) parts.push(`🕐 jam sama ${rm.jam_sama}`);
      if (rm.mangkir) parts.push(`📌 Mangkir ${rm.mangkir}`);
      if (rm.keterangan_bintang) parts.push(`* ${rm.keterangan_bintang}`);
      if (rm.tanpa_jam) parts.push(`⏺ tanpa jam ${rm.tanpa_jam}`);
      const pulangCepat = countPulangCepat(anomaliRaw, response.tanggal);
      if (pulangCepat > 0) parts.push(`🏃 Pulang cepat ${pulangCepat}`);
      if (parts.length) msg += `📊 ${parts.join(' | ')}\n`;
    }
    msg += `\n`;
  }

  // Daftar anomali — filter DR (dianggap Hadir), KECUALI pulang cepat
  const anomaliFiltered = (response.anomali || []).filter(a => {
    const k = (a.keterangan || '').toUpperCase();
    if (isPulangCepat(a.jam_pulang, response.tanggal)) return true; // pulang cepat = kategori sendiri
    return k !== 'H' && k !== 'DR';
  });
  if (anomaliFiltered.length > 0) {
    msg += `<u>⚠️ ANOMALI (${anomaliFiltered.length})</u>\n\n`;
    const MAX_SHOW = 15;
    const list = anomaliFiltered.slice(0, MAX_SHOW);
    list.forEach((r, i) => {
      const k = (r.keterangan || '').toUpperCase();
      const pulangCepat = isPulangCepat(r.jam_pulang, response.tanggal);
      const label = pulangCepat
        ? `Pulang Cepat (${r.jam_pulang})`
        : k === 'H' || k === 'DR' ? 'Hadir' : k === 'M' ? 'Mangkir' : r.keterangan || '';
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
    const remaining = anomaliFiltered.length - MAX_SHOW;
    if (remaining > 0) {
      msg += `... dan ${remaining} anomali lainnya\n\n`;
    }
  }

  if (msg.length <= 50) {
    return { text: null };
  }
  return { text: msg };
}

// =============== BUILD ABSENSI REPLY (teks atau PDF) ===============

/**
 * Membangun Reply absensi: PDF jika >15 pegawai, teks jika sedikit.
 * (port dari sendAbsensiResponse di bot.js)
 */
async function buildAbsensiReply(data, label = 'Absensi TEKO-CAK Hari Ini') {
  const r = data?.ringkasan;
  const totalPegawai = r?.total_pegawai || (r?.total) || 0;

  // Jika data banyak (>15 pegawai), kirim sebagai PDF
  if (totalPegawai > 15) {
    const pdfPath = await generateAbsensiPdf(data);
    const anomaliArr = data?.anomali || [];
    const drCount = anomaliArr.filter(a => (a.keterangan || '').toUpperCase() === 'DR').length;
    const hadir = (r?.normal || r?.hadir || 0) + drCount;
    const anomali = (r?.anomali || r?.absen || 0) - drCount;
    const caption = `📋 <b>${label}</b>\n📅 ${data.tanggal || '-'}\n👥 ${totalPegawai} pegawai | ✅ Normal ${hadir}${anomali > 0 ? ' | ⚠️ Anomali ' + anomali : ''}`;
    const pulangCepat = countPulangCepat(data?.anomali || [], data?.tanggal);
    const captionFull = pulangCepat > 0 ? `${caption} | 🏃 Pulang cepat ${pulangCepat}` : caption;
    return { type: 'document', path: pdfPath, caption: captionFull, parse_mode: 'HTML' };
  }

  // Jika sedikit, kirim teks biasa
  const formatted = formatAbsensi(data, label);
  if (formatted.text) {
    return { type: 'text', text: formatted.text, parse_mode: 'HTML' };
  }
  return { type: 'text', text: '📭 Tidak ada data absensi.' };
}

// =============== HELP & COMMAND MAP ===============

function buildHelpText(channel = 'telegram') {
  const cmd = (c) => (channel === 'whatsapp' ? c.replace(/^\//, '') : c);
  return [
    '📋 *Bantuan — BKPSDM Agent*',
    '',
    '🧠 *Bot ini didukung AI dari OpenRouter!*',
    'Kamu bisa ngobrol dengan bahasa alami, tidak perlu perintah kaku.',
    '',
    '💬 *Contoh percakapan:*',
    '• "Halo, apa kabar?"',
    '• "Jadwal rapat hari ini?"',
    '• "Tampilkan jadwal rapat 26 juni"',
    '• "Munculkan tugas 25 juni"',
    '• "Tugas hari ini"',
    '• "Absensi 4 agustus"',
    '',
    '📌 *Perintah khusus:*',
    `${cmd('/start')} — Menu utama`,
    `${cmd('/help')} — Bantuan ini`,
    `${cmd('/reset')} — Hapus riwayat chat`,
    `${cmd('/status')} — Cek status bot`,
    `${cmd('/absensi')} — Cek absensi TEKO-CAK hari ini`,
    `${cmd('/absensi 4 agustus')} — Absensi tanggal spesifik`,
    `${cmd('/jadwal-hariini')} — Jadwal hari ini`,
    `${cmd('/tugas-hariini')} — Tugas hari ini`,
    `${cmd('/bbm')} — BBM Non-Fosil`,
    '',
    '💡 *Tips:* Semakin detail pertanyaanmu, semakin baik jawabannya!',
  ].join('\n');
}

// Command persis (setelah slash di-strip) — parity dengan command Telegram
function handleExactCommand(firstWord, rest, channel) {
  const map = {
    'jadwal-hariini': { tool: 'get_jadwal_rapat_hari_ini', args: {}, title: 'Jadwal Rapat Hari Ini 📆' },
    'jadwal_hari_ini': { tool: 'get_jadwal_rapat_hari_ini', args: {}, title: 'Jadwal Rapat Hari Ini 📆' },
    'jadwal-hari-ini': { tool: 'get_jadwal_rapat_hari_ini', args: {}, title: 'Jadwal Rapat Hari Ini 📆' },
    'jadwal-mingguini': { tool: 'get_jadwal_rapat_minggu_ini', args: {}, title: 'Jadwal Rapat Minggu Ini 📆' },
    'jadwal_minggu_ini': { tool: 'get_jadwal_rapat_minggu_ini', args: {}, title: 'Jadwal Rapat Minggu Ini 📆' },
    'jadwal-semua': { tool: 'get_semua_jadwal_rapat', args: {}, title: 'Semua Jadwal Rapat 📆' },
    'jadwal_semua': { tool: 'get_semua_jadwal_rapat', args: {}, title: 'Semua Jadwal Rapat 📆' },
    'tugas-hariini': { tool: 'get_tugas_hari_ini', args: {}, title: 'Tugas Hari Ini 📋' },
    'tugas_hari_ini': { tool: 'get_tugas_hari_ini', args: {}, title: 'Tugas Hari Ini 📋' },
    'tugas-semua': { tool: 'get_semua_tugas', args: {}, title: 'Semua Tugas 📋' },
    'tugas_semua': { tool: 'get_semua_tugas', args: {}, title: 'Semua Tugas 📋' },
  };
  return map[firstWord] || null;
}

// =============== MAIN HANDLER ===============

/**
 * Proses satu pesan teks dari channel mana pun.
 *
 * @param {object} opts
 * @param {string} opts.text      — teks pesan user
 * @param {string|number} opts.userId — ID user (chatId TG / jid WA)
 * @param {boolean} opts.authorized — sudah lolos otorisasi?
 * @param {'telegram'|'whatsapp'} opts.channel
 * @returns {Promise<Array<object>>} — array Reply
 */
async function handleMessage({ text, userId, authorized = true, channel = 'telegram' }) {
  if (!authorized) {
    return [{ type: 'text', text: '⛔ Anda tidak memiliki akses ke bot ini.' }];
  }
  if (!text || typeof text !== 'string' || !text.trim()) {
    return [{ type: 'text', text: '📭 Tidak ada pesan untuk diproses.' }];
  }

  const input = text.trim().replace(/^\//, ''); // strip leading slash (WA users may type /cmd)
  const lower = input.toLowerCase();

  try {
    // ── Command persis ──
    const parts = lower.split(/\s+/);
    const firstWord = parts[0];

    if (firstWord === 'help' || firstWord === 'bantuan' || firstWord === 'menu' ||
        firstWord === 'start' || firstWord === 'halo' || firstWord === 'hai' || firstWord === 'hallo') {
      return [{ type: 'text', text: buildHelpText(channel), parse_mode: 'Markdown' }];
    }
    if (firstWord === 'reset') {
      clearHistory(userId);
      return [{ type: 'text', text: '🔄 Riwayat percakapan berhasil dihapus! Mulai obrolan baru yuk! 😊' }];
    }
    if (firstWord === 'status') {
      return [{ type: 'text', text: buildStatusText(), parse_mode: 'Markdown' }];
    }

    // ── Command dengan argumen tanggal ──
    if (firstWord === 'jadwal' && parts[1]) {
      const tanggal = parseIndonesianDate(parts.slice(1).join(' '));
      if (tanggal) {
        const result = await executeTool('get_jadwal_rapat_by_tanggal', { tanggal });
        const formatted = formatJadwal(result, `Jadwal Rapat ${tanggal} 📆`, channel);
        return renderQueryResult(formatted, '📭 Tidak ada jadwal rapat.', channel);
      }
      // Bukan tanggal — coba deteksi bahasa alami (mis. "jadwal rapat hari ini")
      const natQuery = detectJadwalQuery(input);
      if (natQuery) {
        const result = await executeTool(natQuery.tool, natQuery.args);
        const titles = {
          get_jadwal_rapat_hari_ini: 'Jadwal Rapat Hari Ini 📆',
          get_jadwal_rapat_minggu_ini: 'Jadwal Rapat Minggu Ini 📆',
          get_jadwal_rapat_by_tanggal: `Jadwal Rapat ${natQuery.args.tanggal || ''} 📆`,
          get_semua_jadwal_rapat: 'Semua Jadwal Rapat 📆',
        };
        const formatted = formatJadwal(result, titles[natQuery.tool] || 'Jadwal Rapat', channel);
        return renderQueryResult(formatted, '📭 Tidak ada jadwal rapat.', channel);
      }
      return [{ type: 'text', text: '⚠️ Format: `jadwal YYYY-MM-DD` atau `jadwal 26 juni`' }];
    }
    if (firstWord === 'jadwal-besok' || firstWord === 'jadwal_besok') {
      const besok = new Date(Date.now() + 86400000);
      const tgl = `${besok.getFullYear()}-${String(besok.getMonth() + 1).padStart(2, '0')}-${String(besok.getDate()).padStart(2, '0')}`;
      const result = await executeTool('get_jadwal_rapat_by_tanggal', { tanggal: tgl });
      const formatted = formatJadwal(result, `Jadwal Rapat Besok (${tgl}) 📆`, channel);
      return renderQueryResult(formatted, '📭 Tidak ada jadwal rapat.', channel);
    }
    if (firstWord === 'tugas' && parts[1]) {
      const tanggal = parseIndonesianDate(parts.slice(1).join(' '));
      if (tanggal) {
        const result = await executeTool('get_tugas_by_tanggal', { tanggal });
        const formatted = formatTugas(result, `Tugas ${tanggal} 📋`, channel);
        return renderQueryResult(formatted, '📭 Tidak ada tugas.', channel);
      }
      // Bukan tanggal — coba deteksi bahasa alami (mis. "tugas hari ini")
      const natQuery = detectTugasQuery(input);
      if (natQuery) {
        const result = await executeTool(natQuery.tool, natQuery.args);
        const titles = {
          get_tugas_hari_ini: 'Tugas Hari Ini 📋',
          get_tugas_by_tanggal: `Tugas ${natQuery.args.tanggal || ''} 📋`,
          get_semua_tugas: 'Semua Tugas 📋',
        };
        const formatted = formatTugas(result, titles[natQuery.tool] || 'Tugas', channel);
        return renderQueryResult(formatted, '📭 Tidak ada tugas.', channel);
      }
      return [{ type: 'text', text: '⚠️ Format: `tugas YYYY-MM-DD` atau `tugas 26 juni`' }];
    }
    if (firstWord === 'tugas-besok' || firstWord === 'tugas_besok') {
      const besok = new Date(Date.now() + 86400000);
      const tgl = `${besok.getFullYear()}-${String(besok.getMonth() + 1).padStart(2, '0')}-${String(besok.getDate()).padStart(2, '0')}`;
      const result = await executeTool('get_tugas_by_tanggal', { tanggal: tgl });
      const formatted = formatTugas(result, `Tugas Besok (${tgl}) 📋`, channel);
      return renderQueryResult(formatted, '📭 Tidak ada tugas.', channel);
    }
    if (firstWord === 'absensi') {
      const tanggalStr = parts.slice(1).join(' ').replace(/^tanggal\s+/i, '');
      if (tanggalStr) {
        // "absensi hari ini" / "absensi sekarang" / "absensi today" → data hari ini
        if (/(hari\s*ini|sekarang|today)/i.test(tanggalStr)) {
          const result = await executeTool('get_absensi_today', {});
          return [await buildAbsensiReply(result, 'Absensi TEKO-CAK Hari Ini')];
        }
        const tanggal = parseIndonesianDate(tanggalStr) || tanggalStr;
        const result = await executeTool('get_absensi_by_tanggal', { tanggal });
        return [await buildAbsensiReply(result, `Absensi TEKO-CAK ${result.tanggal || tanggal}`)];
      }
      const result = await executeTool('get_absensi_today', {});
      return [await buildAbsensiReply(result, 'Absensi TEKO-CAK Hari Ini')];
    }
    if (firstWord === 'bbm') {
      const tanggalStr = parts.slice(1).join(' ');
      if (tanggalStr) {
        const result = await executeTool('get_bbm_non_fosil_by_tanggal', { tanggal: tanggalStr });
        const formatted = formatBbm(result, `BBM Non-Fosil ${tanggalStr} 🛢️`);
        return formatted.text
          ? [{ type: 'text', text: formatted.text, parse_mode: 'HTML' }]
          : [{ type: 'text', text: '📭 Tidak ada data BBM Non-Fosil.' }];
      }
      const result = await executeTool('get_bbm_non_fosil_hari_ini', {});
      const formatted = formatBbm(result, 'BBM Non-Fosil Hari Ini 🛢️');
      return formatted.text
        ? [{ type: 'text', text: formatted.text, parse_mode: 'HTML' }]
        : [{ type: 'text', text: '📭 Tidak ada data BBM Non-Fosil.' }];
    }

    // ── Exact command tanpa argumen (jadwal-hariini dll) ──
    const exact = handleExactCommand(firstWord, parts.slice(1).join(' '), channel);
    if (exact) {
      const result = await executeTool(exact.tool, exact.args);
      const formatted = exact.tool.startsWith('get_tugas')
        ? formatTugas(result, exact.title, channel)
        : formatJadwal(result, exact.title, channel);
      return renderQueryResult(formatted, exact.tool.startsWith('get_tugas') ? '📭 Tidak ada tugas.' : '📭 Tidak ada jadwal rapat.', channel);
    }

    // ── Deteksi bahasa alami: jadwal → tugas → BBM → absensi ──
    const jadwalQuery = detectJadwalQuery(input);
    if (jadwalQuery) {
      const result = await executeTool(jadwalQuery.tool, jadwalQuery.args);
      const titles = {
        get_jadwal_rapat_hari_ini: 'Jadwal Rapat Hari Ini 📆',
        get_jadwal_rapat_minggu_ini: 'Jadwal Rapat Minggu Ini 📆',
        get_jadwal_rapat_by_tanggal: `Jadwal Rapat ${jadwalQuery.args.tanggal || ''} 📆`,
        get_semua_jadwal_rapat: 'Semua Jadwal Rapat 📆',
      };
      const formatted = formatJadwal(result, titles[jadwalQuery.tool] || 'Jadwal Rapat', channel);
      return renderQueryResult(formatted, '📭 Tidak ada jadwal rapat.', channel);
    }

    const tugasQuery = detectTugasQuery(input);
    if (tugasQuery) {
      const result = await executeTool(tugasQuery.tool, tugasQuery.args);
      const titles = {
        get_tugas_hari_ini: 'Tugas Hari Ini 📋',
        get_tugas_by_tanggal: `Tugas ${tugasQuery.args.tanggal || ''} 📋`,
        get_semua_tugas: 'Semua Tugas 📋',
      };
      const formatted = formatTugas(result, titles[tugasQuery.tool] || 'Tugas', channel);
      return renderQueryResult(formatted, '📭 Tidak ada tugas.', channel);
    }

    const bbmQuery = detectBbmQuery(input);
    if (bbmQuery) {
      const result = await executeTool(bbmQuery.tool, bbmQuery.args);
      const formatted = formatBbm(result, 'BBM Non-Fosil Hari Ini 🛢️');
      if (formatted.text) return [{ type: 'text', text: formatted.text, parse_mode: 'HTML' }];
      return [{ type: 'text', text: '📭 Tidak ada data BBM Non-Fosil.' }];
    }

    const absensiQuery = detectAbsensiQuery(input);
    if (absensiQuery) {
      const result = await executeTool(absensiQuery.tool, absensiQuery.args);
      const label = absensiQuery.tool === 'get_absensi_by_tanggal'
        ? `Absensi TEKO-CAK ${result.tanggal || absensiQuery.args.tanggal || ''}`
        : 'Absensi TEKO-CAK Hari Ini';
      return [await buildAbsensiReply(result, label)];
    }

    // ── Fallback: AI chat ──
    addMessage(userId, 'user', input);
    const history = getHistory(userId);
    const reply = await askAI(input, history);
    addMessage(userId, 'assistant', reply);
    return [{ type: 'text', text: reply, parse_mode: 'Markdown' }];

  } catch (error) {
    console.error('❌ [dispatcher] Error:', error.message);
    const msg = String(error.message || '');
    // Parity dengan pesan error lama di bot.js
    if (msg.includes('Absensi') || /absensi/i.test(input)) {
      return [{ type: 'text', text: `❌ *Absensi Error:* ${msg}`, parse_mode: 'Markdown' }];
    }
    if (msg.includes('timeout')) {
      return [{ type: 'text', text: `⏳ *BBM Non-Fosil*\n\nServer sedang sibuk, coba lagi nanti ya.\n\n⚠️ Koneksi timeout — mungkin data masih diproses di backend.`, parse_mode: 'Markdown' }];
    }
    return [{ type: 'text', text: '😅 Maaf, terjadi kesalahan. Silakan coba lagi.' }];
  }
}

/** Konversi hasil formatJadwal/formatTugas → Reply (menu untuk TG, teks untuk WA) */
function renderQueryResult(formatted, emptyText, channel) {
  if (!formatted.text) return [{ type: 'text', text: emptyText }];
  if (channel === 'telegram' && formatted.keyboard && formatted.keyboard.length > 0) {
    return [{
      type: 'menu',
      text: formatted.text,
      options: formatted.keyboard,
      parse_mode: 'HTML',
    }];
  }
  return [{ type: 'text', text: formatted.text, parse_mode: 'HTML' }];
}

/** Status bot (parity dengan /status di bot.js) */
async function buildStatusText() {
  const aiConfigured = process.env.OPENROUTER_API_KEY ? '✅ Terkonfigurasi' : '❌ Belum diatur';
  const aiModel = process.env.OPENROUTER_MODEL || 'cohere/north-mini-code:free';
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
  return (
    '✅ *Bot Status: AKTIF*\n\n' +
    '📡 Mode: Polling\n' +
    '🧠 AI: ' + aiConfigured + '\n' +
    '🤖 Model: ' + aiModel + '\n' +
    '🗄 *Database:*\n' + dbStatusText + '\n' +
    '⏱ Waktu: ' + new Date().toLocaleString('id-ID')
  );
}

module.exports = {
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
  parseTanggal,
  buildHelpText,
};
