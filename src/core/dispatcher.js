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
const { isPulangCepat, countPulangCepat, isKeteranganNormal, countKeteranganNormal } = require('../services/absensiRules');
const esurat = require('../../automated-esurat'); // agenda undangan KantorKu (lihat automated-esurat/)
const { resolveUnitList, cocokUnit, labelUnit, unitDariTeks } = require('../../automated-esurat/units');
const agendaGabungan = require('../services/agendaGabungan'); // gabungan API jadwal + API eSurat

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

/** Nama bulan Indonesia (display) */
const BULAN_NAMA = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];

/**
 * Format tanggal YYYY-MM-DD → "07 September 2026" (Indonesia).
 * Input non-ISO dibiarkan apa adanya.
 */
function formatTanggalIndonesia(tgl) {
  if (!tgl) return '-';
  const m = String(tgl).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return String(tgl);
  const [, y, mo, d] = m;
  return `${d} ${BULAN_NAMA[Number(mo) - 1] || mo} ${y}`;
}

function detectJadwalQuery(text) {
  const lower = text.toLowerCase();

  if (/(jadwal|rapat|agenda).*(hari\s*ini|sekarang)/i.test(lower)) {
    return { tool: 'get_jadwal_rapat_hari_ini', args: {} };
  }
  if (/(jadwal|rapat|agenda).*besok/i.test(lower)) {
    const besok = new Date(Date.now() + 86400000);
    const tgl = `${besok.getFullYear()}-${String(besok.getMonth() + 1).padStart(2, '0')}-${String(besok.getDate()).padStart(2, '0')}`;
    return { tool: 'get_jadwal_rapat_by_tanggal', args: { tanggal: tgl } };
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
  if (/(tugas|disposisi).*besok/i.test(lower)) {
    const besok = new Date(Date.now() + 86400000);
    const tgl = `${besok.getFullYear()}-${String(besok.getMonth() + 1).padStart(2, '0')}-${String(besok.getDate()).padStart(2, '0')}`;
    return { tool: 'get_tugas_by_tanggal', args: { tanggal: tgl } };
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

/** Deteksi query TUPOKSI — harus dipanggil SEBELUM detectTugasQuery,
 *  karena frasa "tugas tupoksi..." juga match regex tugas biasa. */
function detectTupoksiQuery(text) {
  const lower = text.toLowerCase();
  if (!/(tupoksi|tugas\s*pokok)/i.test(lower)) return null;

  if (/(hari\s*ini|sekarang|today)/i.test(lower)) {
    return { tool: 'get_tupoksi_hari_ini', args: {} };
  }
  if (/besok/i.test(lower)) {
    const besok = new Date(Date.now() + 86400000);
    const tgl = `${besok.getFullYear()}-${String(besok.getMonth() + 1).padStart(2, '0')}-${String(besok.getDate()).padStart(2, '0')}`;
    return { tool: 'get_tupoksi_by_tanggal', args: { tanggal: tgl } };
  }
  const tanggal = parseTanggal(text);
  if (tanggal) {
    return { tool: 'get_tupoksi_by_tanggal', args: { tanggal } };
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

// ===================== eSurat — undangan KantorKu =====================
// Unit tujuan DEFAULT kalau pesan tidak menyebut unit tertentu (mis. "undangan esurat
// hari ini"). Bisa diubah lewat env ESURAT_UNIT_FILTER. Pesan boleh menyebut unit lain
// (mis. "undangan esurat keuangan") atau "tanpa filter"/"semua unit" untuk semua unit.
// Daftar alias unit: automated-esurat/units.js
const ESURAT_UNIT = (process.env.ESURAT_UNIT_FILTER || 'SEKRETARIAT').trim().toUpperCase();

/** Tanggal hari ini (atau digeser n hari) dalam WIB / UTC+7. */
function tanggalWib(geserHari = 0) {
  return new Date(Date.now() + 7 * 3600 * 1000 + geserHari * 86400000).toISOString().slice(0, 10);
}

/** Escape HTML untuk parse_mode: HTML (Telegram). */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Deteksi perintah undangan eSurat → { tanggal } atau null.
 * Contoh yang dikenali:
 *   undangan esurat / cek undangan esurat      → hari ini
 *   undangan esurat hari ini | sekarang        → hari ini
 *   undangan esurat besok / kemarin            → besok / kemarin
 *   undangan esurat tanggal 2026-08-05         → tanggal itu
 *   undangan esurat 5 agustus 2026             → tanggal itu
 *   /undangan-hariini | /undangan-besok        → hari ini / besok
 */
function detectEsuratQuery(text) {
  const lower = String(text || '').toLowerCase();
  // Pemicu: menyebut "esurat"/"e-surat", ATAU diawali kata "undangan"
  // (mis. "/undangan-hariini"), ATAU memuat "undangan" bersamaan "agenda"
  // (mis. "agenda undangan hari ini"). Mencegah false-positive pada kalimat
  // lain yang cuma kebetulan memuat kata "undangan".
  const mentionsSurat = /e-?surat/i.test(lower);
  const undanganAgenda = /\bundangan\b/i.test(lower) && /\bagenda\b/i.test(lower);
  // "undangan ..." hanya dianggap perintah kalau lanjutannya berupa waktu/tanggal
  // (mis. "undangan hari ini", "/undangan-hariini"), supaya kalimat lain seperti
  // "undangan pernikahan" tidak ikut tertarik.
  const afterUndangan = lower.replace(/^\/?undangan[-_\s]*/i, '');
  const adaWaktu = /(hari\s*ini|hariini|besok|kemarin|tanggal|depan|\bini\b|\d{4}[-/]\d{1,2}|\d{1,2}\s+(jan|feb|mar|apr|mei|jun|jul|agt|agu|sep|okt|nov|des))/i.test(afterUndangan);
  const undanganTemporal = /^\/?undangan\b/i.test(lower) && adaWaktu;
  if (!mentionsSurat && !undanganAgenda && !undanganTemporal) return null;

  if (/besok/i.test(lower)) return { tanggal: tanggalWib(1) };
  if (/kemarin/i.test(lower)) return { tanggal: tanggalWib(-1) };
  if (/(hari\s*ini|sekarang|today)/i.test(lower)) return { tanggal: tanggalWib(0) };

  const iso = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return { tanggal: `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}` };
  const dmy = text.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmy) return { tanggal: `${dmy[3]}-${String(dmy[2]).padStart(2, '0')}-${String(dmy[1]).padStart(2, '0')}` };

  const tglIndo = parseTanggal(text);
  if (tglIndo) return { tanggal: tglIndo };

  return { tanggal: tanggalWib(0) };
}

/** Daftar undangan (sudah difilter unit SEKRETARIAT) → teks siap kirim. */
function formatUndangan(rows, tanggal, channel = 'telegram', unitLabel = ESURAT_UNIT) {
  const wa = channel === 'whatsapp';
  const b = (s) => (wa ? `*${s}*` : `<b>${s}</b>`);
  const t = (s) => (wa ? String(s == null ? '' : s) : escapeHtml(s));
  const tglTxt = formatTanggalIndonesia(tanggal);

  if (!rows.length) {
    return { text: `📭 Tidak ada undangan ${unitLabel} untuk ${tglTxt}.`, keyboard: [] };
  }

  const lines = [b(`📨 UNDANGAN eSURAT — ${unitLabel}`), `📅 ${tglTxt} · ${rows.length} undangan`, ''];
  rows.forEach((r, i) => {
    lines.push(`${i + 1}. ${b(t(r.acara || '(tanpa nama acara)'))}`);
    lines.push(`🕐 ${r.pukulAwal || '-'}${r.pukulAkhir ? '–' + r.pukulAkhir : ''} WIB`);
    if (r.tempat) lines.push(`📍 ${t(r.tempat)}`);
    if (r.pengirim) lines.push(`🏢 ${t(r.pengirim)}`);
    if (r.tujuanUser) lines.push(`👤 ${t(r.tujuanUser)}`);
    if (r.penerima.length) lines.push(`👥 ${t(r.penerima.map((x) => x.nama || x.nip).join('; '))}`);
    if (r.isiDisposisi) lines.push(`📝 ${t(r.isiDisposisi)}`);
    if (r.suratPdf) lines.push(wa ? `📄 Surat: ${r.suratPdf}` : `📄 <a href="${escapeHtml(r.suratPdf)}">Surat</a>`);
    lines.push('');
  });
  return { text: lines.join('\n').trim(), keyboard: [] };
}

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

/**
 * JALANKAN PERINTAH JADWAL RAPAT — memakai GABUNGAN dua API.
 *
 * Alur: API jadwal rapat (WEB) + API undangan eSurat → di-join lewat
 * jadwal.id_surat_masuk === esurat.id_surat_masuk → difilter tujuan unit.
 * Aturan filter (A/B/C) ada di src/services/agendaGabungan.js.
 *
 * Pengecualian: `get_semua_jadwal_rapat` tetap memakai jalur lama, karena
 * /jadwal/semua.php mengembalikan tanggal rusak (6200-08-13) sehingga tidak
 * bisa di-join dengan eSurat per tanggal.
 */
async function jalankanJadwalGabungan(tool, args, title, channel) {
  if (tool === 'get_semua_jadwal_rapat') {
    const result = await executeTool(tool, args);
    return renderQueryResult(formatJadwal(result, title, channel), '📭 Tidak ada jadwal rapat.', channel);
  }
  const mode = tool === 'get_jadwal_rapat_minggu_ini' ? 'minggu'
    : tool === 'get_jadwal_rapat_by_tanggal' ? 'tanggal'
      : 'hari-ini';

  const hasil = await agendaGabungan.ambilAgenda({
    mode,
    tanggal: mode === 'tanggal' ? (args && args.tanggal) : undefined,
  });
  const formatted = agendaGabungan.formatAgendaGabungan(hasil.merged, title, channel, hasil.unitLabel);
  return renderQueryResult(formatted, '📭 Tidak ada jadwal rapat.', channel);
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

/** Format data tupoksi: { staff_nama, jabatan, unit_kerja, tupoksi, deskripsi, deadline, selesai } */
function formatTupoksi(rows, title, channel = 'telegram') {
  if (!rows || rows.length === 0) return { text: null, keyboard: [] };
  if (rows.message) return { text: `📭 ${rows.message}`, keyboard: [] };
  if (rows.error) return { text: `⚠️ ${rows.message}`, keyboard: [] };

  let msg = `📋 <b>${title}</b>\n\n`;
  rows.forEach((r, i) => {
    msg += `${i + 1}. <b>${r.staff_nama || '-'}</b>\n`;
    if (r.jabatan) msg += `   💼 ${r.jabatan}\n`;
    if (r.unit_kerja) msg += `   🏢 ${r.unit_kerja}\n`;
    msg += `   📌 ${r.tupoksi || '-'}`;
    if (r.deskripsi) msg += ` — ${r.deskripsi}`;
    msg += '\n';
    if (r.deadline) msg += `   ⏰ Deadline: ${formatTanggalIndonesia(r.deadline)}\n`;
    msg += `   ${r.selesai ? '✅ Selesai' : '⏳ Belum selesai'}\n\n`;
  });
  return { text: msg, keyboard: [] };
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

  // Ringkasan — DR/DL/I dianggap Hadir
  if (response.ringkasan) {
    const r = response.ringkasan;
    const anomaliRaw = response.anomali || [];
    const normalKeterangan = countKeteranganNormal(anomaliRaw); // H/DR/DL/I
    const normal = (r.normal || 0) + normalKeterangan;
    const anomali = (r.anomali || 0) - normalKeterangan;
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

  // Daftar anomali — filter DR/DL/I (dianggap Hadir), KECUALI pulang cepat
  const anomaliFiltered = (response.anomali || []).filter(a => {
    const k = (a.keterangan || '').toUpperCase();
    if (k === 'DL' || k === 'I') return false; // DL/I: TIDAK PERNAH masuk daftar anomali (user 12 Agu 2026)
    if (isPulangCepat(a.jam_pulang, response.tanggal)) return true; // pulang cepat = kategori sendiri
    return !isKeteranganNormal(k); // H/DR dianggap normal — tidak masuk daftar anomali
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
    const normalKeterangan = countKeteranganNormal(anomaliArr); // H/DR/DL/I
    const hadir = (r?.normal || r?.hadir || 0) + normalKeterangan;
    const anomali = (r?.anomali || r?.absen || 0) - normalKeterangan;
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
    '• "Tugas tupoksi hari ini"',
    '• "Tugas tupoksi 8 september"',
    '• "Absensi 4 agustus"',
    '• "Undangan esurat hari ini"',
    '• "Undangan esurat 5 agustus"',
    '',
    '📌 *Perintah khusus:*',
    `${cmd('/start')} — Menu utama`,
    `${cmd('/help')} — Bantuan ini`,
    `${cmd('/reset')} — Hapus riwayat chat`,
    `${cmd('/status')} — Cek status bot`,
    `${cmd('/absensi')} — Absensi TEKO-CAK hari ini`,
    `${cmd('/absensi 4 agustus')} — Absensi tanggal spesifik`,
    `${cmd('/jadwal-hariini')} — Jadwal hari ini`,
    `${cmd('/jadwal-besok')} — Jadwal besok`,
    `${cmd('/jadwal-mingguini')} — Jadwal minggu ini`,
    `${cmd('/jadwal-semua')} — Semua jadwal rapat`,
    `${cmd('/jadwal 26 juni')} — Jadwal tanggal spesifik`,
    `${cmd('/tugas-hariini')} — Tugas hari ini`,
    `${cmd('/tugas-besok')} — Tugas besok`,
    `${cmd('/tugas-semua')} — Semua tugas`,
    `${cmd('/tugas 25 juni')} — Tugas tanggal spesifik`,
    `${cmd('/bbm')} — BBM Non-Fosil hari ini`,
    `${cmd('/bbm 26 juni')} — BBM Non-Fosil tanggal spesifik`,
    '',
    '📨 *Undangan eSurat (hanya unit SEKRETARIAT):*',
    `${cmd('/undangan-hariini')} — Undangan Sekretariat hari ini`,
    `${cmd('/undangan-besok')} — Undangan Sekretariat besok`,
    '"undangan esurat 5 agustus" — Undangan Sekretariat tanggal tertentu',
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
    'tupoksi-hariini': { tool: 'get_tupoksi_hari_ini', args: {}, title: 'Tugas Tupoksi Hari Ini 📋' },
    'tupoksi_hari_ini': { tool: 'get_tupoksi_hari_ini', args: {}, title: 'Tugas Tupoksi Hari Ini 📋' },
    'tupoksi-hari-ini': { tool: 'get_tupoksi_hari_ini', args: {}, title: 'Tugas Tupoksi Hari Ini 📋' },
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
        return await jalankanJadwalGabungan(
          'get_jadwal_rapat_by_tanggal', { tanggal },
          `Jadwal Rapat ${agendaGabungan.tanggalIndo(tanggal)} 📆`, channel,
        );
      }
      // Bukan tanggal — coba deteksi bahasa alami (mis. "jadwal rapat hari ini")
      const natQuery = detectJadwalQuery(input);
      if (natQuery) {
        const titles = {
          get_jadwal_rapat_hari_ini: 'Jadwal Rapat Hari Ini 📆',
          get_jadwal_rapat_minggu_ini: 'Jadwal Rapat Minggu Ini 📆',
          get_jadwal_rapat_by_tanggal: `Jadwal Rapat ${agendaGabungan.tanggalIndo(natQuery.args.tanggal)} 📆`,
          get_semua_jadwal_rapat: 'Semua Jadwal Rapat 📆',
        };
        return await jalankanJadwalGabungan(
          natQuery.tool, natQuery.args,
          titles[natQuery.tool] || 'Jadwal Rapat', channel,
        );
      }
      return [{ type: 'text', text: '⚠️ Format: `jadwal YYYY-MM-DD` atau `jadwal 26 juni`' }];
    }
    if (firstWord === 'jadwal-besok' || firstWord === 'jadwal_besok') {
      const tgl = agendaGabungan.todayWib(); // lalu +1 hari
      const besok = new Date(new Date(`${tgl}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
      return await jalankanJadwalGabungan(
        'get_jadwal_rapat_by_tanggal', { tanggal: besok },
        `Jadwal Rapat Besok (${agendaGabungan.tanggalIndo(besok)}) 📆`, channel,
      );
    }

    // ── TUPOKSI — harus SEBELUM branch 'tugas' biasa, karena frasa
    //    "tugas tupoksi ..." juga match /^tugas/ dan regex tugas biasa.
    const tupoksiNatQuery = detectTupoksiQuery(input);
    if (tupoksiNatQuery) {
      const result = await executeTool(tupoksiNatQuery.tool, tupoksiNatQuery.args);
      const tglTupoksi = tupoksiNatQuery.args.tanggal
        ? formatTanggalIndonesia(tupoksiNatQuery.args.tanggal)
        : '';
      const titles = {
        get_tupoksi_hari_ini: 'Tugas Tupoksi Hari Ini 📋',
        get_tupoksi_by_tanggal: `Tugas Tupoksi ${tglTupoksi} 📋`,
      };
      const formatted = formatTupoksi(result, titles[tupoksiNatQuery.tool] || 'Tugas Tupoksi', channel);
      return renderQueryResult(formatted, '📭 Tidak ada data tupoksi.', channel);
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
      let formatted, emptyText;
      if (exact.tool.startsWith('get_tupoksi')) {
        formatted = formatTupoksi(result, exact.title, channel);
        emptyText = '📭 Tidak ada data tupoksi.';
      } else if (exact.tool.startsWith('get_tugas')) {
        formatted = formatTugas(result, exact.title, channel);
        emptyText = '📭 Tidak ada tugas.';
      } else {
        // Jadwal rapat → pakai gabungan 2 API (jadwal + eSurat)
        return await jalankanJadwalGabungan(exact.tool, exact.args, exact.title, channel);
      }
      return renderQueryResult(formatted, emptyText, channel);
    }

    // ── Deteksi bahasa alami: jadwal → tugas → BBM → absensi ──
    // ── eSurat: undangan (HANYA tujuan unit SEKRETARIAT) ──
    // Ditaruh SEBELUM deteksi jadwal: frasa "agenda undangan ..." juga cocok
    // dengan pola jadwal, dan perintah undangan harus menang.
    const esuratQuery = detectEsuratQuery(input);
    if (esuratQuery) {
      // Unit tujuan: dari kata di pesan (mis. "keuangan"); kalau tidak disebut → default.
      // unitDariTeks() mengembalikan null utk "tanpa filter"/"semua unit", undefined kalau tak disebut.
      const unitHint = unitDariTeks(input);
      const unitList = unitHint === undefined ? resolveUnitList(ESURAT_UNIT) : unitHint;
      const unitLabel = unitList ? labelUnit(unitList) : 'SEMUA UNIT';
      // Login TIDAK dipanggil manual di sini: getAgenda() sudah login otomatis
      // (token di-cache per proses, dan kalau kena 401 ia login ulang sekali).
      // Memanggil login() tiap request = bikin sesi baru terus → lambat & boros rate limit.
      const resp = await esurat.getAgenda(esuratQuery.tanggal);
      const rows = (resp.data || [])
        .map(esurat.normalizeRow)
        .filter((r) => cocokUnit(r.tujuanUnit, unitList));
      const formatted = formatUndangan(rows, esuratQuery.tanggal, channel, unitLabel);
      return renderQueryResult(formatted, `📭 Tidak ada undangan ${unitLabel}.`, channel);
    }

    const jadwalQuery = detectJadwalQuery(input);
    if (jadwalQuery) {
      const titles = {
        get_jadwal_rapat_hari_ini: 'Jadwal Rapat Hari Ini 📆',
        get_jadwal_rapat_minggu_ini: 'Jadwal Rapat Minggu Ini 📆',
        get_jadwal_rapat_by_tanggal: `Jadwal Rapat ${agendaGabungan.tanggalIndo(jadwalQuery.args.tanggal)} 📆`,
        get_semua_jadwal_rapat: 'Semua Jadwal Rapat 📆',
      };
      // Gabungan API jadwal + undangan eSurat, difilter tujuan unit.
      return await jalankanJadwalGabungan(
        jadwalQuery.tool, jadwalQuery.args,
        titles[jadwalQuery.tool] || 'Jadwal Rapat', channel,
      );
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
  detectEsuratQuery,
  formatUndangan,
  parseTanggal,
  buildHelpText,
};
