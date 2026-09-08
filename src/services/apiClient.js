/**
 * API Client — menggantikan koneksi MySQL langsung
 *
 * Semua query database dialihkan ke HTTP API endpoint.
 * Support auto-login dengan Bearer token (JWT).
 *
 * Konfigurasi di .env:
 *   API_BASE_URL=https://bkpsdm.surabaya.go.id/api/ai-agent
 *   API_USERNAME=admin_bkpsdm
 *   API_PASSWORD=BkpsdmSby@2024!
 */

// ⚠️ Baca env secara LAZY (bukan saat module load) — 3 Sep 2026:
// dbTools.js me-require apiClient di top-level; kalau module ini ke-load SEBELUM
// dotenv.config() jalan, credential ke-capture undefined → request tanpa token
// → "Token tidak disertakan" (401). Dengan lazy-read, urutan require tidak relevan.
const DEFAULT_BASE_URL = 'https://bkpsdm.surabaya.go.id/api/ai-agent';
function baseUrl() {
  return process.env.API_BASE_URL || DEFAULT_BASE_URL;
}
function apiCreds() {
  return {
    username: process.env.API_USERNAME,
    password: process.env.API_PASSWORD,
  };
}
const TIMEOUT_MS = 120000;

// Token cache
let authToken = null;
let tokenExpiry = 0;

/**
 * Parse response sebagai JSON dengan aman.
 *
 * Server kadang balikin HTML (halaman error nginx 502/504) padahal kita minta JSON.
 * Deteksi itu dan lempar pesan yang jelas, bukan error "Unexpected token '<'" mentah.
 */
async function parseJsonResponse(res, endpoint) {
  const text = await res.text();
  const trimmed = text.trim();

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    const snippet = trimmed.replace(/\s+/g, ' ').slice(0, 100);
    if (res.status >= 500) {
      throw new Error(
        `⚠️ Server BKPSDM sedang sibuk (HTTP ${res.status}) — coba lagi beberapa saat nanti. (${snippet})`
      );
    }
    throw new Error(`Respons dari ${endpoint} bukan JSON (HTTP ${res.status}): ${snippet}`);
  }

  return JSON.parse(trimmed);
}

/** Delay kecil sebelum retry */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Login ke API backend untuk mendapatkan Bearer token
 */
async function login() {
  const { username, password } = apiCreds();
  if (!username || !password) {
    console.warn('⚠️ API_USERNAME / API_PASSWORD tidak dikonfigurasi. Gunakan API_TOKEN manual jika ada.');
    return;
  }

  try {
    let res = await fetch(`${baseUrl()}/auth/login.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // Retry sekali untuk error 5xx (server sibuk / nginx timeout)
    if (res.status >= 500) {
      console.log(`🔄 Login: server sibuk (HTTP ${res.status}), retry sekali...`);
      await sleep(3000);
      res = await fetch(`${baseUrl()}/auth/login.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    }

    const data = await parseJsonResponse(res, '/auth/login.php');

    if (!res.ok) {
      throw new Error(data.error || `Login gagal: HTTP ${res.status}`);
    }

    authToken = data.token;
    // Asumsi token berlaku 24 jam, refresh 1 jam sebelum expired
    tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
    console.log('✅ API Login berhasil, token tersimpan');
  } catch (err) {
    console.error('❌ API Login gagal:', err.message);
    throw err;
  }
}

/**
 * Memastikan token masih valid, login ulang jika expired
 */
async function ensureToken() {
  const { username, password } = apiCreds();
  // Coba login jika belum punya token
  if (!authToken && username && password) {
    await login();
  }
  // Login ulang jika expired
  if (authToken && Date.now() > tokenExpiry && username && password) {
    console.log('🔄 Token expired, login ulang...');
    await login();
  }
}

/**
 * HTTP request helper dengan Bearer token
 * Otomatis login ulang jika dapat 401
 */
async function request(method, path, body = null) {
  await ensureToken();

  const url = `${baseUrl()}${path}`;
  const headers = { 'Content-Type': 'application/json' };

  // Tambahkan Bearer token jika ada
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const options = {
    method,
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  if (body) options.body = JSON.stringify(body);

  let res = await fetch(url, options);

  // Jika 401 (Unauthorized), coba login ulang sekali
  const { username, password } = apiCreds();
  if (res.status === 401 && username && password) {
    console.log('🔄 Token ditolak (401), login ulang...');
    await login();
    headers['Authorization'] = `Bearer ${authToken}`;
    res = await fetch(url, options);
  }

  // Retry sekali untuk error 5xx (server sibuk / nginx timeout 504)
  if (res.status >= 500) {
    console.log(`🔄 Server sibuk (HTTP ${res.status}), retry sekali...`);
    await sleep(3000);
    res = await fetch(url, options);
  }

  const data = await parseJsonResponse(res, path);

  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}: ${res.statusText}`);
  }
  return data;
}

// ===================== JADWAL RAPAT (WEB) =====================

/** GET /api/ai-agent/jadwal/hari-ini.php */
async function getJadwalHariIni() {
  const data = await request('GET', '/jadwal/hari-ini.php');
  return data.rows && data.rows.length > 0
    ? data.rows
    : { message: data.message || 'Tidak ada jadwal rapat untuk hari ini' };
}

/** GET /api/ai-agent/jadwal/tanggal.php?date=YYYY-MM-DD */
async function getJadwalByTanggal(tanggal) {
  const data = await request('GET', `/jadwal/tanggal.php?date=${encodeURIComponent(tanggal)}`);
  return data.rows && data.rows.length > 0
    ? data.rows
    : { message: data.message || `Tidak ada jadwal rapat untuk tanggal ${tanggal}` };
}

/** GET /api/ai-agent/jadwal/minggu-ini.php */
async function getJadwalMingguIni() {
  const data = await request('GET', '/jadwal/minggu-ini.php');
  return data.rows && data.rows.length > 0
    ? data.rows
    : { message: data.message || 'Tidak ada jadwal rapat minggu ini' };
}

/** GET /api/ai-agent/jadwal/semua.php */
async function getSemuaJadwal() {
  const data = await request('GET', '/jadwal/semua.php');
  return data.rows || [];
}

/** GET /api/ai-agent/jadwal/detail.php?id={id} */
async function getJadwalById(id) {
  const data = await request('GET', `/jadwal/detail.php?id=${encodeURIComponent(id)}`);
  return data.row || [];
}

// ===================== TUGAS / DISPOSISI (SIJAKA) =====================

/** GET /api/ai-agent/tugas/hari-ini.php */
async function getTugasHariIni() {
  const data = await request('GET', '/tugas/hari-ini.php');
  return data.rows && data.rows.length > 0
    ? data.rows
    : { message: data.message || 'Tidak ada tugas untuk hari ini' };
}

/** GET /api/ai-agent/tugas/tanggal.php?date=YYYY-MM-DD */
async function getTugasByTanggal(tanggal) {
  const data = await request('GET', `/tugas/tanggal.php?date=${encodeURIComponent(tanggal)}`);
  return data.rows && data.rows.length > 0
    ? data.rows
    : { message: data.message || `Tidak ada tugas untuk tanggal ${tanggal}` };
}

/** GET /api/ai-agent/tugas/semua.php */
async function getSemuaTugas() {
  const data = await request('GET', '/tugas/semua.php');
  return data.rows || [];
}

/**
 * POST /api/ai-agent/tugas/tambah.php — simpan disposisi baru
 * Body: { tugas, tanggal, jam, disposisi_ke, pegawai: [nama1, ...] }
 */
async function createTugas({ tugas, tanggal, jam, disposisi_ke, pegawai, link_esurat }) {
  const body = {
    tugas,
    tanggal,
    jam,
    disposisi_ke: disposisi_ke || 'Telegram Bot',
    pegawai: pegawai || [],
  };
  if (link_esurat) body.link_esurat = link_esurat;
  return await request('POST', '/tugas/tambah.php', body);
}

/** DELETE /api/ai-agent/tugas/hapus.php?id={id} */
async function deleteTugasById(id) {
  return await request('DELETE', `/tugas/hapus.php?id=${encodeURIComponent(id)}`);
}

// ===================== TUGAS POKOK & FUNGSI (TUPOKSI) =====================

/** GET /api/ai-agent/tugas-tupoksi/hari-ini.php
 * Response: { date, count, rows: [...] } atau { message } saat kosong.
 */
async function getTupoksiHariIni() {
  const data = await request('GET', '/tugas-tupoksi/hari-ini.php');
  return data.rows && data.rows.length > 0
    ? data.rows
    : { message: data.message || 'Tidak ada data tupoksi untuk hari ini' };
}

/** GET /api/ai-agent/tugas-tupoksi/tanggal.php?date=YYYY-MM-DD
 * Response: { date, count, rows: [...] } atau { message } saat kosong.
 */
async function getTupoksiByTanggal(tanggal) {
  const data = await request('GET', `/tugas-tupoksi/tanggal.php?date=${encodeURIComponent(tanggal)}`);
  return data.rows && data.rows.length > 0
    ? data.rows
    : { message: data.message || `Tidak ada data tupoksi untuk tanggal ${tanggal}` };
}

// ===================== HEALTH CHECK =====================

/** GET /api/ai-agent/health.php */
async function healthCheck() {
  return await request('GET', '/health.php');
}

// ===================== BBM NON-FOSIL =====================

/**
 * GET /api/ai-agent/bbm-non-fosil/hari-ini.php
 * Response: { success, tanggal, text, data }
 */
async function getBbmNonFosilHariIni() {
  return await request('GET', '/bbm-non-fosil/hari-ini.php');
}

/**
 * GET /api/ai-agent/bbm-non-fosil/tanggal.php?tanggal=DD/MM/YYYY
 * Response: { success, tanggal, text, data }
 */
async function getBbmNonFosilByTanggal(tanggal) {
  return await request('GET', `/bbm-non-fosil/tanggal.php?tanggal=${encodeURIComponent(tanggal)}`);
}

// ===================== ABSENSI (CSV) =====================

/**
 * GET /api/ai-agent/absensi/hari-ini.php
 * Mendapatkan data absensi hari ini untuk ALL pegawai dari CSV
 * Response: { success, tanggal, ringkasan, hadir, absen }
 */
async function getAbsensiHariIni() {
  return await request('GET', '/absensi/hari-ini.php');
}

/**
 * GET /api/ai-agent/absensi/hari-ini.php?tanggal=YYYY-MM-DD
 * Mendapatkan data absensi by tanggal untuk ALL pegawai dari CSV
 * Response: { success, tanggal, ringkasan, hadir, absen }
 */
async function getAbsensiByTanggal(tanggal) {
  return await request('GET', `/absensi/hari-ini.php?tanggal=${encodeURIComponent(tanggal)}`);
}

module.exports = {
  // Jadwal
  getJadwalHariIni,
  getJadwalByTanggal,
  getJadwalMingguIni,
  getSemuaJadwal,
  getJadwalById,
  // Tugas
  getTugasHariIni,
  getTugasByTanggal,
  getSemuaTugas,
  createTugas,
  deleteTugasById,
  // Tupoksi
  getTupoksiHariIni,
  getTupoksiByTanggal,
  // BBM
  getBbmNonFosilHariIni,
  getBbmNonFosilByTanggal,
  // Absensi
  getAbsensiHariIni,
  getAbsensiByTanggal,
  // Health
  healthCheck,
};
