/**
 * TEKO-CAK Integration Service
 *
 * Menjalankan task automasi TEKO-CAK via Playwright
 * dan mengirim hasilnya ke Telegram.
 *
 * Task tersedia:
 *   - login            : Login saja
 *   - generate         : Generate laporan absensi (H-1 → hari ini)
 *   - generate-tanggal : Generate laporan untuk tanggal spesifik (butuh param tanggal, YYYY-MM-DD)
 *   - update           : Update data pegawai per NIP
 *   - all              : Login → Generate → Update (full)
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');

const TEKOCAK_DIR = path.resolve(__dirname, '../../automated-tekocak');

/**
 * Load env dari root .env (semua env sudah digabung ke root)
 */
function ensureTekocakEnv() {
  const envPath = path.join(TEKOCAK_DIR, '..', '.env');
  if (!fs.existsSync(envPath)) return false;

  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^[\"']|[\"']$/g, '');
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
  return true;
}

/**
 * Format durasi dalam detik ke string
 */
function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)} detik`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m} menit ${s} detik`;
}

/**
 * Simple API client for master-pegawai endpoints (reuse .env credentials)
 */
class MasterPegawaiApi {
  constructor() {
    this.baseUrl = process.env.API_BASE_URL || 'https://bkpsdm.surabaya.go.id/api/ai-agent';
    this.username = process.env.API_USERNAME;
    this.password = process.env.API_PASSWORD;
    this.timeoutMs = 120000;
    this.authToken = null;
    this.tokenExpiry = 0;
  }

  async parseJsonResponse(res, endpoint) {
    const text = await res.text();
    const trimmed = text.trim();

    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      const snippet = trimmed.replace(/\s+/g, ' ').slice(0, 120);
      if (res.status >= 500) {
        throw new Error(`⚠️ Server BKPSDM sibuk (HTTP ${res.status}) – coba lagi nanti. (${snippet})`);
      }
      throw new Error(`Respons dari ${endpoint} bukan JSON (HTTP ${res.status}): ${snippet}`);
    }
    return JSON.parse(trimmed);
  }

  async login() {
    if (!this.username || !this.password) {
      throw new Error('API_USERNAME / API_PASSWORD tidak dikonfigurasi di .env');
    }

    let res = await fetch(`${this.baseUrl}/auth/login.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    // Retry once for 5xx
    if (res.status >= 500) {
      await new Promise(r => setTimeout(r, 3000));
      res = await fetch(`${this.baseUrl}/auth/login.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.username, password: this.password }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    }

    const data = await this.parseJsonResponse(res, '/auth/login.php');
    if (!res.ok) throw new Error(data.error || `Login gagal: HTTP ${res.status}`);

    this.authToken = data.token;
    // Assume token valid for 1 hour (expiresIn from response usually 3600s)
    this.tokenExpiry = Date.now() + 55 * 60 * 1000; // refresh 5 min before expiry
    console.log('✅ API Login berhasil, token tersimpan');
  }

  async ensureToken() {
    if (!this.authToken && this.username && this.password) await this.login();
    if (this.authToken && Date.now() > this.tokenExpiry && this.username && this.password) {
      console.log('🔄 Token expired, login ulang...');
      await this.login();
    }
  }

  async request(method, path, body = null) {
    await this.ensureToken();

    const url = `${this.baseUrl}${path}`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;

    const options = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (body) options.body = JSON.stringify(body);

    let res = await fetch(url, options);

    // 401 → retry login once
    if (res.status === 401 && this.username && this.password) {
      console.log('🔄 Token ditolak (401), login ulang...');
      await this.login();
      headers['Authorization'] = `Bearer ${this.authToken}`;
      res = await fetch(url, options);
    }

    // Retry once for 5xx
    if (res.status >= 500) {
      console.log(`🔄 Server sibuk (HTTP ${res.status}), retry sekali...`);
      await new Promise(r => setTimeout(r, 3000));
      res = await fetch(url, options);
    }

    const data = await this.parseJsonResponse(res, path);
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}: ${res.statusText}`);
    return data;
  }

  async fetchAllNips() {
    try {
      const data = await this.request('GET', '/master-pegawai/all.php?limit=1000');
      // Adapt to possible response shapes
      let items = [];
      if (data && data.data && Array.isArray(data.data)) items = data.data;
      else if (data && data.rows && Array.isArray(data.rows)) items = data.rows;
      else if (Array.isArray(data)) items = data;
      // Sumber NIP = API master pegawai (BUKAN CSV). Non-ASN punya NIP '-' di master
      // → NIP TEKO-CAK = NIK, jadi fallback ke NIK. Filter nilai kosong/'-'.
      return items
        .map((item) => {
          const nipVal = String(item.NIP || '').trim();
          const nikVal = String(item.NIK || '').trim();
          if (nipVal && nipVal !== '-') return nipVal;
          if (nikVal && nikVal !== '-') return nikVal;
          return null;
        })
        .filter(Boolean);
    } catch (err) {
      console.log(`⚠️ Gagal ambil NIP dari API master-pegawai: ${err.message}`);
      return [];
    }
  }
}

/**
 * Jalankan task TEKO-CAK
 *
 * @param {'all'|'login'|'generate'|'generate-tanggal'|'update'} taskName
 * @param {function(string)} onProgress - callback tiap baris log (opsional)
 * @param {string|null} nip - NIP spesifik (untuk update 1 pegawai, opsional)
 * @param {string|null} tanggal - tanggal spesifik YYYY-MM-DD (untuk generate-tanggal, opsional)
 * @returns {Promise<{success: boolean, output: string, duration: number}>}
 */
async function runTask(taskName, onProgress = () => {}, nip = null, tanggal = null) {
  const startTime = Date.now();
  const lines = [];
  const log = (msg) => { lines.push(msg); onProgress(msg); };

  // Load env dari root .env (sudah digabung)
  ensureTekocakEnv();

  // Load config — pindah cwd dulu agar dotenv.config() menemukan .env
  let originalCwd, config;
  try {
    originalCwd = process.cwd();
    process.chdir(TEKOCAK_DIR);
    config = require(path.join(TEKOCAK_DIR, 'config'));
  } catch (err) {
    return { success: false, output: `❌ Gagal load config: ${err.message}`, duration: 0 };
  } finally {
    if (originalCwd) process.chdir(originalCwd);
  }

  // Validasi credential TEKO-CAK
  if (!config.USERNAME || !config.PASSWORD) {
    return {
      success: false,
      output: [
        '❌ **TEKO-CAK belum dikonfigurasi!**',
        '',
        'Buat file `.env` (root project) dengan isi:',
        '```',
        'TEKOCAK_URL=https://teko-cak.surabaya.go.id',
        'TEKOCAK_USERNAME=username_anda',
        'TEKOCAK_PASSWORD=password_anda',
        'TEKOCAK_TAHUN=2026',
        'TEKOCAK_HEADLESS=true',
        'CSV_ENCRYPT_KEY=key_rahasia_anda',
        '```',
      ].join('\n'),
      duration: 0,
    };
  }

  // Hook console.log agar output task module juga ke-capture
  const originalLog = console.log;
  const hookedLog = (...args) => {
    const msg = args.join(' ');
    lines.push(msg);
    onProgress(msg);
    originalLog(...args);
  };
  console.log = hookedLog;

  let browser;
  try {
    browser = await chromium.launch({
      headless: config.HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    let page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    // Load task modules
    const login = require(path.join(TEKOCAK_DIR, 'tasks', 'login'));
    const generate = require(path.join(TEKOCAK_DIR, 'tasks', 'generate'));
    const generateTanggal = require(path.join(TEKOCAK_DIR, 'tasks', 'generate-tanggal'));
    const updatePegawai = require(path.join(TEKOCAK_DIR, 'tasks', 'update-pegawai'));

    // ===== LOGIN =====
    log('🔐 **Login TEKO-CAK...**');
    await login.run(page);
    log('✅ **Login berhasil!**\n');

    if (taskName === 'login') {
      const duration = (Date.now() - startTime) / 1000;
      log(`⏱️ Selesai dalam ${formatDuration(duration)}`);
      console.log = originalLog;
      await browser.close();
      return { success: true, output: lines.join('\n'), duration };
    }

    // ===== GENERATE =====
    if (taskName === 'all' || taskName === 'generate') {
      log('📊 **Generate Laporan...**');
      await generate.run(page);
      log('✅ **Generate laporan selesai!**\n');
    }

    // ===== GENERATE TANGGAL SPESIFIK (fungsi baru, tidak ubah generate biasa) =====
    if (taskName === 'generate-tanggal') {
      if (!tanggal) {
        console.log = originalLog;
        await browser.close();
        const duration = (Date.now() - startTime) / 1000;
        return {
          success: false,
          output: '❌ **Tanggal tidak diberikan.**\nGunakan: `/tekocak generate tanggal <tanggal>`\nContoh: `/tekocak generate tanggal 4 agustus`',
          duration,
        };
      }
      log(`📊 **Generate Laporan (Tanggal: ${tanggal})...**`);
      await generateTanggal.run(page, tanggal);
      log('✅ **Generate laporan tanggal spesifik selesai!**\n');
    }

    // ===== UPDATE PEGAWAI =====
    if (taskName === 'all' || taskName === 'update') {
      const api = new MasterPegawaiApi();
      let nips = nip ? [nip] : await api.fetchAllNips();

      // Jika bukan update NIP spesifik: batasi ke pegawai yang ADA di PDF absensi hari ini.
      // (User: "jika sudah ada pdf absensi hari ini, hanya update pegawai yg ada pada file pdf" —
      //  sumber NIP-nya = data API absensi hari ini dengan FILTER SAMA seperti pdfGenerator:
      //  exclude H & DR (dianggap Hadir), KECUALI pulang cepat = kategori sendiri.)
      if (!nip) {
        try {
          const absensiApi = require('./apiClient'); // reuse existing client for absensi
          const absensi = await absensiApi.getAbsensiHariIni();
          const tanggalAbsensi = absensi.tanggal;
          const { isPulangCepat } = require('./absensiRules');
          const anomaliFiltered = (absensi.anomali || []).filter((a) => {
            const k = (a.keterangan || '').toUpperCase();
            if (isPulangCepat(a.jam_pulang, tanggalAbsensi)) return true; // pulang cepat = kategori sendiri
            return k !== 'H' && k !== 'DR';                                 // bukan Hadir/DiLuarkan
          });
          // Fetch master data to map identifiers to NIP
          const masterResp = await api.request('GET', '/master-pegawai/all.php?limit=1000');
          const masterItems = masterResp.data && masterResp.data ? masterResp.data : (masterResp.rows || []);
          const identifierToNip = new Map();
          for (const item of masterItems) {
            const nipVal = String(item.NIP || '').trim();
            const nikVal = String(item.NIK || '').trim();
            const idPegawai = String(item['ID-PEGAWAI'] || item.id_pegawai || '').trim();
            if (nipVal && nipVal !== '-') {
              // PNS/ASN: punya NIP asli — map NIP, NIK, & ID-PEGAWAI ke NIP
              identifierToNip.set(nipVal, nipVal);
              if (nikVal && nikVal !== '-') identifierToNip.set(nikVal, nipVal);
              if (idPegawai) identifierToNip.set(idPegawai, nipVal);
            } else if (nikVal && nikVal !== '-') {
              // Non-ASN: NIP di master '-' → NIP TEKO-CAK = NIK (pola master-pegawai.csv.enc)
              identifierToNip.set(nikVal, nikVal);
              if (idPegawai) identifierToNip.set(idPegawai, nikVal);
            }
          }
          const absenNips = [];
          for (const a of anomaliFiltered) {
            const nipVal = String(a.nip || '').trim();
            const nikVal = String(a.nik || '').trim();
            const idPegawai = String(a.id_pegawai || '').trim();
            let id = null;
            if (nipVal && nipVal !== '-') id = nipVal;
            else if (nikVal && nikVal !== '-') id = nikVal;
            else if (idPegawai && identifierToNip.has(idPegawai)) id = idPegawai;
            if (id && identifierToNip.has(id)) {
              const resolvedNip = identifierToNip.get(id);
              if (resolvedNip && resolvedNip !== '-') {
                absenNips.push(resolvedNip);
              }
            }
          }
          if (absenNips.length > 0) {
            // deduplicate
            const uniqueNips = [...new Set(absenNips)];
            log(`📋 PDF absensi hari ini: ${anomaliFiltered.length} pegawai (anomali non-DR) → update ${uniqueNips.length} pegawai yang ada di PDF`);
            nips = uniqueNips;
          } else {
            log('📋 Tidak ada anomali non-DR di absensi hari ini — update semua pegawai');
          }
        } catch (e) {
          log(`⚠️ Gagal ambil data absensi (${e.message}) — fallback update semua pegawai dari API master-pegawai`);
        }
      }
      log(`👤 **Update ${nips.length} Pegawai...**`);

      let failedNips = await updatePegawai.run(page, browser, nips);
      let retryCount = 0;

      while (failedNips.length > 0 && retryCount < 2) {
        retryCount++;
        log(`\n⚠️ **Retry #${retryCount} — ${failedNips.length} pegawai gagal, coba lagi...**`);
        // Browser context mungkin crash, buat page baru
        try {
          page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
          await page.goto(config.HALAMAN_PEGAWAI, { waitUntil: 'load', timeout: 60000 });
        } catch {
          // Kalau browser juga crash, bikin baru
          await browser.close();
          browser = await chromium.launch({
            headless: config.HEADLESS,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
          });
          page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        }
        // Login ulang karena page baru
        await login.run(page);
        failedNips = await updatePegawai.run(page, browser, failedNips);
      }

      if (failedNips.length > 0) {
        log(`\n⚠️ **${failedNips.length} pegawai tetap gagal setelah ${retryCount}× retry**`);
        log(`   NIP: ${failedNips.join(', ')}`);
      } else {
        log('✅ **Update pegawai selesai!**');
      }
    }

    const duration = (Date.now() - startTime) / 1000;
    log(`⏱️ **Selesai dalam ${formatDuration(duration)}**`);
    console.log = originalLog;
    await browser.close();
    return { success: true, output: lines.join('\n'), duration };
  } catch (err) {
    console.log = originalLog;
    try { if (browser) await browser.close(); } catch (_) {}
    const duration = (Date.now() - startTime) / 1000;
    log(`❌ **Error:** ${err.message}`);
    log(`⏱️ **Gagal setelah ${formatDuration(duration)}**`);
    return { success: false, output: lines.join('\n'), duration };
  }
}

module.exports = { runTask };