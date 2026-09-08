/**
 * Pengaduan SPB Listener — pantau hotline via API bkpsdm (tiap 30 menit)
 *
 * ARSITEKTUR (sesuai arahan user):
 *   VPS ──> bkpsdm.surabaya.go.id/api/ai-agent/pengaduan-spb/*  (API proxy)
 *   Server bkpsdm yang membuka halaman SPB — VPS TIDAK scrape spb.surabaya.go.id langsung.
 *
 * Alur per siklus:
 *   1. POST /auth/login.php            → token admin
 *   2. GET  /pengaduan-spb/captcha.php → captcha (kirim ke Telegram, tunggu jawaban)
 *   3. POST /pengaduan-spb/login.php?captcha=KODE&act=ACT → login SPB (session server-side, TANPA JWT)
 *   4. GET  /pengaduan-spb/hotline.php → JSON data pengaduan (Bearer admin token)
 *   5. Bandingkan ticket ID vs state.json → ada baru? tandai; LAPORAN tiap 2 jam
 *      (jam genap WIB 12,14,16,18,20,22,00,02 — via REPORT_HOURS_WIB)
 *
 * Jalankan:
 *   node index.js                  → daemon (default interval 30 menit)
 *   PENGADUAN_INTERVAL_MINUTES=15 node index.js
 *   node index.js --once           → cek sekali lalu keluar
 *   node index.js --check-session  → verifikasi session tanpa login ulang
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SESSION_FILE = path.join(DIR, 'session.json');   // { adminToken, updatedAt }
const STATE_FILE = path.join(DIR, 'state.json');        // { seenTicketIds, lastCheck, lastError, lastReportAt }
const PENDING_FILE = path.join(DIR, 'pending_captcha.json');
const ANSWER_FILE = path.join(DIR, 'captcha_answer.txt');

const API_BASE = 'https://bkpsdm.surabaya.go.id/api/ai-agent';
const SPB_BASE = `${API_BASE}/pengaduan-spb`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const INTERVAL_MS = (parseInt(process.env.PENGADUAN_INTERVAL_MINUTES || '30', 10) || 30) * 60 * 1000;
// Laporan ke Telegram: tiap 2 jam pada jam genap WIB 12,14,16,18,20,22,00,02 (jadwal berbasis jam,
// bukan interval relatif). Polling (cek hotline) TETAP tiap 30 menit — hit API tidak berubah.
// Atur jam via env PENGADUAN_REPORT_HOURS (comma-separated, jam WIB).
const REPORT_HOURS_WIB = (process.env.PENGADUAN_REPORT_HOURS || '12,14,16,18,20,22,0,2')
  .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
const CAPTCHA_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_NEW_PER_CHECK = 5;

// Window waktu aktif: 05:00 – 03:00 WIB (wrap melewati tengah malam, agar laporan
// jam 00:00 & 02:00 WIB ikut terkirim). Server timezone = +08, WIB = UTC+7.
const START_HOUR_WIB = parseInt(process.env.PENGADUAN_START_HOUR || '5', 10);
const END_HOUR_WIB = parseInt(process.env.PENGADUAN_END_HOUR || '3', 10);

/** Apakah sekarang termasuk window aktif (WIB)? Mendukung wrap (mis. 5 → 3 = 05:00–02:59 WIB). */
function isWithinWindow() {
  const now = new Date();
  const hourWib = (now.getUTCHours() + 7) % 24; // UTC+7 = WIB
  if (START_HOUR_WIB <= END_HOUR_WIB) {
    return hourWib >= START_HOUR_WIB && hourWib < END_HOUR_WIB;
  }
  return hourWib >= START_HOUR_WIB || hourWib < END_HOUR_WIB;
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.PENGADUAN_CHAT_ID
  || (process.env.ALLOWED_CHAT_IDS || '').split(',')[0]
  || null;

// ===================== UTIL =====================

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ===================== WA BRIDGE (kirim via bot bkpsdm-wa, localhost) =====================
// Listener TIDAK boleh buka koneksi WA sendiri (2 koneksi session sama = di-kick).
// Alert WA dikirim lewat bridge HTTP di dalam proses bot (src/whatsapp/bot.js).
const WA_BRIDGE_URL = process.env.WA_BRIDGE_URL || 'http://127.0.0.1:8787/wa/send';
const WA_BRIDGE_TOKEN = process.env.WA_BRIDGE_TOKEN || '572182ec20aa6d9202f0f0bb';
// Nomor WA penerima alert (bisa lebih dari satu, pisah koma) — default: 2 nomor allowed bot
const WA_ALERT_NUMBERS = (process.env.WA_ALERT_NUMBERS || '6282244649994,6281216435394')
  .split(',')
  .map((s) => s.trim().replace(/[^0-9]/g, ''))
  .filter((s) => s.length > 0);

/** <b>…</b> → *…*, tag HTML lain dihapus (WA tidak render HTML) */
function toWaText(s) {
  return String(s || '')
    .replace(/<b>(.*?)<\/b>/g, '*$1*')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/** Kirim teks alert ke semua nomor WA tujuan via bridge bot (fire-and-forget, error tidak fatal) */
async function waSendAlert(text) {
  if (WA_ALERT_NUMBERS.length === 0) return;
  for (const num of WA_ALERT_NUMBERS) {
    try {
      const res = await fetch(WA_BRIDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: WA_BRIDGE_TOKEN, text: toWaText(text), to: num }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) log('⚠️  waSendAlert gagal ke', num + ':', res.status, JSON.stringify(data).slice(0, 150));
      else log('✅ Alert WA terkirim ke', num);
    } catch (e) {
      log('⚠️  waSendAlert error ke', num + ':', e.message, '(bot bkpsdm-wa hidup? bridge ada di proses itu)');
    }
  }
}

// ===================== TELEGRAM =====================

async function tgSendText(text) {
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    log('⚠️  TELEGRAM_TOKEN/CHAT_ID tidak ada — notif dilewati');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) log('⚠️  tgSendText gagal:', res.status, (await res.text()).slice(0, 200));
  } catch (e) {
    log('⚠️  tgSendText error:', e.message);
  }
}

async function tgSendPhoto(photoPath, caption) {
  if (!TELEGRAM_TOKEN || !CHAT_ID) {
    log('⚠️  TELEGRAM_TOKEN/CHAT_ID tidak ada — foto dilewati');
    return;
  }
  try {
    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('photo', new Blob([fs.readFileSync(photoPath)], { type: 'image/png' }), 'captcha.png');
    form.append('caption', caption || '');
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) log('⚠️  tgSendPhoto gagal:', res.status, (await res.text()).slice(0, 200));
  } catch (e) {
    log('⚠️  tgSendPhoto error:', e.message);
  }
}

// ===================== API BKPSDM =====================

async function apiFetch(path, options = {}) {
  const res = await fetch(`${SPB_BASE}${path}`, {
    ...options,
    headers: {
      'User-Agent': UA,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

/** Login admin API → token (dipakai sebagai Bearer untuk captcha & login) */
async function adminLogin() {
  const res = await fetch(`${API_BASE}/auth/login.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      username: process.env.API_USERNAME,
      password: process.env.API_PASSWORD,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.token) throw new Error(`Admin login gagal: ${res.status} ${JSON.stringify(data).slice(0, 150)}`);
  return data.token;
}

/**
 * Ambil captcha dari API (format baru 2026-08-07).
 * Return { captchaB64, act }.
 * Respons: { success, status, captcha_url, image_base64, act, message }
 */
async function apiCaptcha(adminToken) {
  const { status, data } = await apiFetch('/captcha.php', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (status !== 200 || !data || !data.image_base64) {
    throw new Error(`captcha.php gagal (HTTP ${status}): ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { captchaB64: data.image_base64, act: data.act || '' };
}

/**
 * Login SPB via API dengan kode captcha.
 * NOTE: respons TIDAK berisi JWT — session login SPB tersimpan server-side
 * per admin token. Sukses = { success: true, status: logged_in }.
 */
async function apiLogin(adminToken, captchaCode, act = '') {
  const { status, data } = await apiFetch(`/login.php?captcha=${encodeURIComponent(captchaCode)}&act=${encodeURIComponent(act)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({
      username: process.env.SPB_USERNAME,
      password: process.env.SPB_PASSWORD,
    }),
  });
  if (status !== 200 || !data || data.success !== true) {
    const msg = (data && (data.message || data.detail || data.error)) || `HTTP ${status}`;
    throw new Error(`Login SPB gagal: ${msg}`);
  }
  return true;
}

/** Fetch hotline via API → array row pengaduan (pakai admin token, bukan JWT) */
async function apiHotline(adminToken, limit = 50) {
  const { status, data } = await apiFetch(`/hotline.php?limit=${limit}&hal=1&q=`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (status !== 200) {
    const msg = (data && (data.message || data.detail || data.error)) || `HTTP ${status}`;
    throw new Error(`hotline.php gagal: ${msg}`);
  }
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.rows)) return data.rows;
  throw new Error(`hotline.php respons tidak dikenal: ${JSON.stringify(data).slice(0, 150)}`);
}

/** Normalisasi row API (format baru) → { ticketId, tanggal, pelapor, isi, pd, kategori, status } */
function normalizeRow(r) {
  const t = r.ticket_id || r.ticketId || r.id || '';
  const ticketId = String(t).match(/(HWL-\d{12}-\d{6})/)?.[1] || String(t);
  const pdArr = Array.isArray(r.pd) ? r.pd : [];
  return {
    ticketId,
    tanggal: [r.tanggal, r.jam].filter(Boolean).join(' | '),
    tgl: r.tanggal || '',
    jam: r.jam || '',
    pelapor: r.pelapor || r.nama_pelapor || '',
    isi: r.laporan || r.isi_laporan || r.isi || '',
    pd: pdArr.length > 0 ? pdArr.join(', ') : (r.status || ''),
    kategori: r.kategori || '',
    status: (r.status_tgl || '').trim() || (pdArr.length > 0 ? (r.status || '') : ''),
  };
}

// ===================== HITUNG "1 JAM TERAKHIR" =====================
const BULAN_ID = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, Mei: 4, Jun: 5, Jul: 6, Agu: 7, Sep: 8, Okt: 9, Nov: 10, Des: 11 };

/**
 * Parse "6 Agu 2026" + "14:42:38" (WIB) → timestamp ms.
 * Return null kalau format tak dikenal (biar dihitung aman sebagai tidak-lama).
 */
function parseWibTime(tglStr, jamStr) {
  const m = String(tglStr || '').match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m) return null;
  const [, dStr, monStr, yStr] = m;
  const month = BULAN_ID[monStr];
  if (month === undefined) return null;
  const [hh, mm, ss] = String(jamStr || '00:00:00').split(':').map(Number);
  // WIB = UTC+7
  return Date.UTC(Number(yStr), month, Number(dStr), (hh || 0) - 7, mm || 0, ss || 0);
}

/** Jumlah row yang masuk SEJAK 00.00 WIB hari ini (reset tengah malam, bukan rolling 24 jam) */
function countRecent(rows) {
  const now = Date.now();
  const WIB_OFFSET = 7 * 60 * 60 * 1000; // UTC+7
  // Awal hari ini dalam WIB: floor(epoch-shifted / hari) lalu balik ke UTC ms
  const dayStart = Math.floor((now + WIB_OFFSET) / 86400000) * 86400000 - WIB_OFFSET;
  let n = 0;
  for (const r of rows) {
    const t = parseWibTime(r.tgl, r.jam);
    if (t !== null && t >= dayStart && t <= now + 60 * 60 * 1000) n++;
  }
  return n;
}

// ===================== SESSION & STATE =====================

function loadSession() {
  return readJson(SESSION_FILE, { adminToken: null, updatedAt: null });
}

function saveSession(session) {
  writeJson(SESSION_FILE, { ...session, updatedAt: new Date().toISOString() });
  log('✅ Session tersimpan');
}

function loadState() {
  return readJson(STATE_FILE, { seenTicketIds: [], lastCheck: null, lastReportAt: 0, lastReportKey: null });
}

function saveState(state) {
  writeJson(STATE_FILE, state);
}

// ===================== CAPTCHA FLOW =====================

/**
 * Alur minta captcha via API: simpan gambar → kirim ke Telegram →
 * tunggu jawaban user (bot.js menulis ke captcha_answer.txt) → login SPB.
 */
async function requestCaptchaAndLogin(adminToken) {
  log('🔐 Butuh captcha baru...');
  let captcha;
  try {
    captcha = await apiCaptcha(adminToken);
  } catch (e) {
    log('❌ Gagal ambil captcha API:', e.message);
    // Anti-spam: kirim notif error hanya jika pesan beda dari terakhir
    const state = loadState();
    const errKey = `captcha:${e.message.slice(0, 120)}`;
    if (state.lastError !== errKey) {
      state.lastError = errKey;
      saveState(state);
      await tgSendText(
        `⚠️ <b>Pengaduan Listener</b>\nGagal ambil captcha dari API: <code>${e.message.slice(0, 200)}</code>\n\nKemungkinan bug server <code>captcha.php</code> (str_starts_with) belum diperbaiki IT.`,
      );
    }
    return false;
  }

  // Simpan gambar captcha
  const imgPath = '/tmp/pengaduan_captcha.png';
  fs.writeFileSync(imgPath, Buffer.from(captcha.captchaB64, 'base64'));

  // Tandai pending — bot.js akan menulis jawaban ke ANSWER_FILE
  writeJson(PENDING_FILE, { chatId: CHAT_ID, createdAt: Date.now() });
  if (fs.existsSync(ANSWER_FILE)) fs.unlinkSync(ANSWER_FILE);

  await tgSendPhoto(
    imgPath,
    '🔐 <b>Butuh login ulang SPB</b>\n\nBalas pesan ini dengan <b>kode captcha 6 karakter</b> di gambar.',
  );

  // Polling jawaban (maks 10 menit)
  const deadline = Date.now() + CAPTCHA_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(ANSWER_FILE)) {
      const code = fs.readFileSync(ANSWER_FILE, 'utf-8').trim();
      fs.unlinkSync(ANSWER_FILE);
      if (fs.existsSync(PENDING_FILE)) fs.unlinkSync(PENDING_FILE);
      if (!code) { log('⚠️  Jawaban kosong'); return false; }
      log(`🔑 Kode diterima: ${code}`);
      try {
        // Format baru: session SPB tersimpan server-side per admin token (tanpa JWT)
        await apiLogin(adminToken, code, captcha.act);
        saveSession({ adminToken });
        log('✅ Login SPB berhasil');
        return true;
      } catch (e) {
        log('❌ Login gagal:', e.message);
        return false;
      }
    }
    await sleep(5000);
  }
  if (fs.existsSync(PENDING_FILE)) fs.unlinkSync(PENDING_FILE);
  log('⏰ Timeout menunggu captcha');
  return false;
}

// ===================== NOTIFIKASI =====================

function formatNewRows(rows) {
  const lines = [`🚨 <b>PENGADUAN BARU DITEMUKAN (${rows.length})</b>`, ''];
  for (const r of rows) {
    lines.push(
      `🎫 <b>${r.ticketId}</b>`,
      `📅 ${r.tanggal || '-'}`,
      r.pelapor ? `👤 ${r.pelapor}` : '',
      `🏢 ${r.pd || '-'} | ${r.kategori || '-'}`,
      `📝 ${(r.isi || '-').slice(0, 300)}${(r.isi || '').length > 300 ? '…' : ''}`,
      `✅ ${r.status || '-'}`,
      '',
    );
  }
  return lines.join('\n');
}

/** Format laporan periodik (dikirim tiap 1 jam) — RINGKASAN singkat + jumlah sejak 00.00 WIB */
function formatReport(rows, newRows, recentCount) {
  const waktu = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  const lines = [
    `📊 <b>LAPORAN PENGADUAN SPB</b>`,
    `🕐 ${waktu} WIB`,
    `📋 Total: ${rows.length} pengaduan`,
    `🕒 <b>${recentCount} pengaduan</b> hari ini (sejak 00.00 WIB)`,
  ];
  if (newRows.length > 0) {
    lines.push(`🚨 <b>${newRows.length} pengaduan BARU</b>`);
  } else {
    lines.push(`✅ Tidak ada pengaduan baru`);
  }
  lines.push('');

  // Row paling baru (teratas tabel)
  const top = rows[0];
  if (top) {
    const isNew = newRows.some((n) => n.ticketId === top.ticketId);
    lines.push(
      `${isNew ? '🆕' : '•'} <b>Terbaru:</b> ${top.ticketId}`,
      `   📅 ${top.tanggal || '-'}`,
      top.pelapor ? `   👤 ${top.pelapor}` : '',
      `   🏢 ${top.pd || '-'}`,
      `   📝 ${(top.isi || '-').slice(0, 100)}${(top.isi || '').length > 100 ? '…' : ''}`,
    );
  }
  return lines.join('\n');
}

// ===================== MAIN LOOP =====================

async function checkOnce() {
  let session = loadSession();

  // ── LOGIN HANYA SEKALI ──
  // Admin token disimpan di session.json. Setiap siklus TIDAK login ulang —
  // cukup reuse admin token. Login SPB (captcha) hanya jika server bilang
  // not_logged_in / 401, atau belum pernah login SPB.

  // Hitung umur session untuk log transparan
  const sessionAge = session.updatedAt
    ? Math.round((Date.now() - new Date(session.updatedAt).getTime()) / 60000)
    : null;

  if (!session.adminToken) {
    log('🔑 Admin login (pertama kali)...');
    try {
      session.adminToken = await adminLogin();
      saveSession(session);
    } catch (e) {
      log('❌ Admin login gagal:', e.message);
      return;
    }
  }

  // Coba fetch hotline langsung dengan admin token (session SPB tersimpan server-side)
  let rows;
  try {
    rows = await apiHotline(session.adminToken);
    log(`♻️  Reuse admin session (umur ${sessionAge ?? '?'} menit) — tanpa login ulang`);
  } catch (e) {
    log('❌ Fetch hotline gagal:', e.message);
    // Token admin expired → refresh admin token dulu, lalu coba lagi
    if (/token tidak valid|kedaluwarsa|invalid token|401/i.test(e.message)) {
      log('🔄 Admin token expired — refresh...');
      try {
        session.adminToken = await adminLogin();
        saveSession(session);
        rows = await apiHotline(session.adminToken);
        log('✅ Admin token di-refresh, hotline OK');
      } catch (e2) {
        log('❌ Refresh admin token gagal:', e2.message);
        return;
      }
    } else if (/not_logged_in|belum login|expired/i.test(e.message)) {
      // Session SPB belum ada / ditolak → flow captcha (hanya saat dibutuhkan)
      log('🔐 Session SPB belum login/ditolak — minta captcha...');
      const ok = await requestCaptchaAndLogin(session.adminToken);
      if (!ok) return;
      session = loadSession();
      try {
        rows = await apiHotline(session.adminToken);
      } catch (e2) {
        log('❌ Fetch ulang gagal:', e2.message);
        return;
      }
    } else {
      return;
    }
  }

  processRows(rows.map(normalizeRow));
}

function processRows(rows) {
  const state = loadState();
  const seen = new Set(state.seenTicketIds || []);
  const newRows = rows.filter((r) => r.ticketId && !seen.has(r.ticketId));

  state.lastCheck = new Date().toISOString();

  // Hit API tetap tiap 30 menit (interval polling), tapi LAPORAN hanya pada jam genap WIB
  // (12,14,16,18,20,22,00,02 — via REPORT_HOURS_WIB). Anti-duplikat: lastReportKey
  // berisi "YYYY-MM-DD:HHWIB" dari laporan terakhir; laporan baru hanya jika jam sekarang
  // termasuk jam laporan DAN key-nya beda (mencegah 2 laporan di jam yang sama).
  const now = new Date();
  const hourWib = (now.getUTCHours() + 7) % 24; // UTC+7 = WIB
  const dateWib = new Date(now.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const reportKey = `${dateWib}:${hourWib}`;
  const isReportHour = REPORT_HOURS_WIB.includes(hourWib);
  const due = isReportHour && state.lastReportKey !== reportKey;

  if (newRows.length > 0) {
    // 🚨 ALERT INSTAN: pengaduan baru langsung dilaporkan saat pengecekan hotline (tiap 30 menit),
    // TIDAK menunggu laporan terjadwal 2 jam. Laporan 2 jam tetap jalan sesuai jadwalnya.
    log(`🚨 ${newRows.length} row baru ditemukan — kirim alert instan`);
    tgSendText(formatNewRows(newRows));
    waSendAlert(formatNewRows(newRows)); // 🔔 + kirim ke WA nomor tujuan (via bridge bot bkpsdm-wa)
  } else {
    log(`✅ Tidak ada row baru (total ${rows.length} row)`);
  }

  if (due) {
    const recentCount = countRecent(rows);
    log(`📊 Kirim laporan (jam laporan ${hourWib}:00 WIB)`);
    tgSendText(formatReport(rows, newRows, recentCount));
    state.lastReportKey = reportKey;
  } else if (!isReportHour) {
    const nextHour = REPORT_HOURS_WIB.find((h) => h > hourWib) ?? REPORT_HOURS_WIB[0];
    log(`⏳ Jam ${hourWib}:00 WIB bukan jam laporan — berikutnya ${nextHour}:00 WIB`);
  } else {
    log(`✅ Laporan jam ${hourWib}:00 WIB sudah terkirim (lastReportKey=${state.lastReportKey})`);
  }

  // Update seen — tandai semua row yang ada
  for (const r of rows) if (r.ticketId) seen.add(r.ticketId);

  state.seenTicketIds = [...seen];
  saveState(state);
}

async function checkSessionOnly() {
  // Mode verifikasi: cek apakah session tersimpan masih valid TANPA login ulang.
  const session = loadSession();
  if (!session.adminToken) {
    log('ℹ️  Belum ada admin token di session.json — belum pernah login.');
    return;
  }
  const ageMin = session.updatedAt
    ? Math.round((Date.now() - new Date(session.updatedAt).getTime()) / 60000)
    : null;
  log(`🔎 Cek validitas session (umur ${ageMin ?? '?'} menit)...`);
  try {
    const rows = await apiHotline(session.adminToken);
    log(`✅ Session MASIH VALID — ${rows.length} row didapat tanpa login ulang.`);
  } catch (e) {
    log(`❌ Session TIDAK VALID: ${e.message}`);
    log('   → Butuh login ulang (flow captcha).');
  }
}

async function main() {
  log(`🚀 Pengaduan Listener (API bkpsdm) — interval ${INTERVAL_MS / 60000} menit`);
  if (!process.env.API_USERNAME || !process.env.API_PASSWORD) {
    log('❌ API_USERNAME/API_PASSWORD belum di-set di .env');
    process.exit(1);
  }
  if (!process.env.SPB_USERNAME || !process.env.SPB_PASSWORD) {
    log('❌ SPB_USERNAME/SPB_PASSWORD belum di-set di .env');
    process.exit(1);
  }

  if (process.argv.includes('--check-session')) {
    await checkSessionOnly();
    log('🏁 Selesai (--check-session)');
    process.exit(0);
  }

  // Cek pertama — hanya jika dalam window aktif
  if (isWithinWindow()) {
    await checkOnce();
  } else {
    const h = new Date().getUTCHours() + 7;
    log(`⏸️  Di luar window aktif (05:00–03:00 WIB, sekarang ${h % 24}:00 WIB) — diam`);
  }

  if (process.argv.includes('--once')) {
    log('🏁 Selesai (--once)');
    process.exit(0);
  }

  setInterval(() => {
    if (isWithinWindow()) {
      checkOnce();
    } else {
      const h = new Date().getUTCHours() + 7;
      log(`⏸️  Di luar window aktif (sekarang ${h % 24}:00 WIB) — diam`);
    }
  }, INTERVAL_MS);
  log(`⏱️  Cek berikutnya dalam ${INTERVAL_MS / 60000} menit (window 05:00–03:00 WIB)`);
}

main().catch((e) => {
  console.error('❌ Fatal:', e);
  process.exit(1);
});
