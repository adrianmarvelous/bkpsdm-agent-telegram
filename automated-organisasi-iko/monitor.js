/**
 * Monitor Approval Monev Agustus — Bagian Organisasi Kota Surabaya
 *
 * Mengecek tabel pada https://organisasi.surabaya.go.id/monev2026/penyelia/monev-agustus
 * secara berkala (default tiap 30 menit). Jika muncul BARIS BARU di tabel,
 * kirim notifikasi ke Telegram.
 *
 * Cara pakai:
 *   node monitor.js             → daemon (interval default 30 menit)
 *   node monitor.js --once      → cek satu kali lalu keluar (uji)
 *   ORGANISASI_INTERVAL_MINUTES=15 node monitor.js
 *
 * Sesi:
 *   - PHPSESSID dibaca dari session.json (folder ini) atau env ORGANISASI_PHPSESSID.
 *   - Jika sesi kedaluwarsa, skrip mengirim peringatan ke Telegram lalu keluar;
 *     lakukan login ulang untuk memperbarui session.json.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SESSION_FILE = path.join(DIR, 'session.json'); // { phpsessid }
const STATE_FILE = path.join(DIR, 'state.json');      // { seenRows: [signature], lastCheck }
const MONITOR_URL = 'https://organisasi.surabaya.go.id/monev2026/penyelia/monev-agustus';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const INTERVAL_MS = (parseInt(process.env.ORGANISASI_INTERVAL_MINUTES || '30', 10) || 30) * 60 * 1000;
const MAX_NOTIFY = 10; // batas jumlah baris baru yang dirinci per notifikasi

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.ORGANISASI_CHAT_ID
  || (process.env.ALLOWED_CHAT_IDS || '').split(',')[0]
  || null;
const ONCE = process.argv.includes('--once');

// ===================== UTIL =====================

function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripTags(s) {
  return String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Ambil baris data dari HTML tabel server (#dataTable / <tbody>).
 * Tiap baris → { cells: [kolom...], signature: gabungan kolom }.
 * Baris kosong (pagination/"no data") dilewati.
 */
function parseRows(html) {
  const tbody = (html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/) || [])[1] || '';
  if (!tbody) return [];
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(tbody)) !== null) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;
    let c;
    while ((c = tdRe.exec(m[1])) !== null) cells.push(stripTags(c[1]));
    const nonEmpty = cells.filter(Boolean);
    if (nonEmpty.length === 0) continue; // baris pagination / "no data"
    rows.push({ cells: nonEmpty, signature: nonEmpty.join(' | ') });
  }
  return rows;
}

/** Ambil jumlah entri dari teks info DataTables ("Showing X to Y of Z entries"). */
function parseTotal(html) {
  const m = html.match(/Showing\s+\d+\s+to\s+\d+\s+of\s+(\d+)\s+entries/i);
  return m ? parseInt(m[1], 10) : null;
}

// ===================== FETCH =====================

async function fetchPage() {
  const sess = readJson(SESSION_FILE, {});
  const phpsessid = sess.phpsessid || process.env.ORGANISASI_PHPSESSID;
  if (!phpsessid) {
    throw new Error('PHPSESSID belum tersedia. Isi session.json atau env ORGANISASI_PHPSESSID (hasil login).');
  }
  const res = await fetch(MONITOR_URL, {
    headers: { Cookie: `PHPSESSID=${phpsessid}`, 'User-Agent': UA },
  });
  const text = await res.text();
  const loggedIn = text.includes('APPROVAL MONITORING') || text.includes('dataTable');
  return { status: res.status, text, loggedIn };
}

// ===================== TELEGRAM =====================

async function tgSend(text) {
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    log('⚠️  TELEGRAM_TOKEN/CHAT_ID belum dikonfigurasi — notifikasi dilewati.');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) log('⚠️  tgSend gagal:', res.status, (await res.text()).slice(0, 200));
  } catch (e) {
    log('⚠️  tgSend error:', e.message);
  }
}

// ===================== LOGIKA CEK =====================

/**
 * Satu siklus pengecekan.
 * Mengembalikan jumlah baris baru yang terdeteksi & dikirim.
 */
async function checkOnce() {
  let page;
  try {
    page = await fetchPage();
  } catch (e) {
    log('❌ Gagal ambil halaman:', e.message);
    return;
  }

  if (!page.loggedIn) {
    log('⚠️  Sesi login sudah tidak valid (terlempar ke halaman login).');
    await tgSend('⚠️ <b>Monev Organisasi — sesi login habis.</b>\nMonitor berhenti. Silakan login ulang untuk memperbarui session.json.');
    if (!ONCE) process.exit(1);
    return;
  }

  const rows = parseRows(page.text);
  const total = parseTotal(page.text);
  const signatures = rows.map((r) => r.signature);

  const state = readJson(STATE_FILE, {});
  const seen = new Set(state.seenRows || []);

  // Baris baru = yang belum pernah terlihat sebelumnya
  const newRows = rows.filter((r) => !seen.has(r.signature));

  if (!Array.isArray(state.seenRows)) {
    // Pengecekan pertama → jadikan baseline, jangan banjir notif data lama.
    log(`ℹ️  Baseline awal: ${rows.length} baris (tidak ada notifikasi).`);
  } else if (newRows.length > 0) {
    log(`🆕 ${newRows.length} baris baru terdeteksi.`);
    let msg = `<b>🆕 Monev Agustus — ${newRows.length} baris baru</b>\n`
      + `<a href="${MONITOR_URL}">Buka halaman approval</a>\n`;
    const shown = newRows.slice(0, MAX_NOTIFY);
    shown.forEach((r, i) => {
      msg += `\n<b>#${i + 1}</b>\n${r.cells.join('\n')}`;
    });
    if (newRows.length > MAX_NOTIFY) msg += `\n\n…dan ${newRows.length - MAX_NOTIFY} baris lainnya.`;
    await tgSend(msg);
  } else {
    log(`✓ Tidak ada baris baru (${rows.length} baris).`);
  }

  // Simpan state terbaru (baseline = gabungan lama + baru)
  writeJson(STATE_FILE, { seenRows: [...seen, ...signatures], lastCheck: new Date().toISOString(), total });
  return newRows.length;
}

// ===================== MAIN =====================

(async () => {
  log(`🚀 Monitor Monev Agustus — interval ${INTERVAL_MS / 60000} menit${ONCE ? ' (sekali)' : ''}`);
  for (;;) {
    try {
      const n = await checkOnce();
      if (ONCE) { log('Selesai (--once).'); break; }
      log(`Tunggu ${INTERVAL_MS / 60000} menit ke pengecekan berikutnya…`);
    } catch (e) {
      log('❌ Error siklus:', e.message);
    }
    await sleep(INTERVAL_MS);
  }
})();
