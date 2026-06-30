/**
 * API Client — menggantikan koneksi MySQL langsung
 *
 * Semua query database dialihkan ke HTTP API endpoint.
 * Support auto-login dengan Bearer token (JWT).
 *
 * Konfigurasi di .env:
 *   API_BASE_URL=https://bkpsdm.surabaya.go.id/api/agent-telegram
 *   API_USERNAME=admin_bkpsdm
 *   API_PASSWORD=BkpsdmSby@2024!
 */

const BASE_URL = process.env.API_BASE_URL || 'https://bkpsdm.surabaya.go.id/api/agent-telegram';
const API_USERNAME = process.env.API_USERNAME;
const API_PASSWORD = process.env.API_PASSWORD;
const TIMEOUT_MS = 15000;

// Token cache
let authToken = null;
let tokenExpiry = 0;

/**
 * Login ke API backend untuk mendapatkan Bearer token
 */
async function login() {
  if (!API_USERNAME || !API_PASSWORD) {
    console.warn('⚠️ API_USERNAME / API_PASSWORD tidak dikonfigurasi. Gunakan API_TOKEN manual jika ada.');
    return;
  }

  try {
    const res = await fetch(`${BASE_URL}/auth/login.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: API_USERNAME, password: API_PASSWORD }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Login gagal: HTTP ${res.status}`);
    }

    const data = await res.json();
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
  // Coba login jika belum punya token
  if (!authToken && API_USERNAME && API_PASSWORD) {
    await login();
  }
  // Login ulang jika expired
  if (authToken && Date.now() > tokenExpiry && API_USERNAME && API_PASSWORD) {
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

  const url = `${BASE_URL}${path}`;
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
  if (res.status === 401 && API_USERNAME && API_PASSWORD) {
    console.log('🔄 Token ditolak (401), login ulang...');
    await login();
    headers['Authorization'] = `Bearer ${authToken}`;
    res = await fetch(url, options);
  }

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}: ${res.statusText}`);
  }
  return data;
}

// ===================== JADWAL RAPAT (WEB) =====================

/** GET /api/agent-telegram/jadwal/hari-ini.php */
async function getJadwalHariIni() {
  const data = await request('GET', '/jadwal/hari-ini.php');
  return data.rows && data.rows.length > 0
    ? data.rows
    : { message: data.message || 'Tidak ada jadwal rapat untuk hari ini' };
}

/** GET /api/agent-telegram/jadwal/tanggal.php?date=YYYY-MM-DD */
async function getJadwalByTanggal(tanggal) {
  const data = await request('GET', `/jadwal/tanggal.php?date=${encodeURIComponent(tanggal)}`);
  return data.rows && data.rows.length > 0
    ? data.rows
    : { message: data.message || `Tidak ada jadwal rapat untuk tanggal ${tanggal}` };
}

/** GET /api/agent-telegram/jadwal/minggu-ini.php */
async function getJadwalMingguIni() {
  const data = await request('GET', '/jadwal/minggu-ini.php');
  return data.rows && data.rows.length > 0
    ? data.rows
    : { message: data.message || 'Tidak ada jadwal rapat minggu ini' };
}

/** GET /api/agent-telegram/jadwal/semua.php */
async function getSemuaJadwal() {
  const data = await request('GET', '/jadwal/semua.php');
  return data.rows || [];
}

/** GET /api/agent-telegram/jadwal/detail.php?id={id} */
async function getJadwalById(id) {
  const data = await request('GET', `/jadwal/detail.php?id=${encodeURIComponent(id)}`);
  return data.row || [];
}

// ===================== TUGAS / DISPOSISI (SIJAKA) =====================

/** GET /api/agent-telegram/tugas/hari-ini.php */
async function getTugasHariIni() {
  const data = await request('GET', '/tugas/hari-ini.php');
  return data.rows && data.rows.length > 0
    ? data.rows
    : { message: data.message || 'Tidak ada tugas untuk hari ini' };
}

/** GET /api/agent-telegram/tugas/tanggal.php?date=YYYY-MM-DD */
async function getTugasByTanggal(tanggal) {
  const data = await request('GET', `/tugas/tanggal.php?date=${encodeURIComponent(tanggal)}`);
  return data.rows && data.rows.length > 0
    ? data.rows
    : { message: data.message || `Tidak ada tugas untuk tanggal ${tanggal}` };
}

/** GET /api/agent-telegram/tugas/semua.php */
async function getSemuaTugas() {
  const data = await request('GET', '/tugas/semua.php');
  return data.rows || [];
}

/**
 * POST /api/agent-telegram/tugas/tambah.php — simpan disposisi baru
 * Body: { tugas, tanggal, jam, disposisi_ke, pegawai: [nama1, ...] }
 */
async function createTugas({ tugas, tanggal, jam, disposisi_ke, pegawai }) {
  return await request('POST', '/tugas/tambah.php', {
    tugas,
    tanggal,
    jam,
    disposisi_ke: disposisi_ke || 'Telegram Bot',
    pegawai: pegawai || [],
  });
}

/** DELETE /api/agent-telegram/tugas/hapus.php?id={id} */
async function deleteTugasById(id) {
  return await request('DELETE', `/tugas/hapus.php?id=${encodeURIComponent(id)}`);
}

// ===================== HEALTH CHECK =====================

/** GET /api/agent-telegram/health.php */
async function healthCheck() {
  return await request('GET', '/health.php');
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
  // Health
  healthCheck,
};
