/**
 * TEKO-CAK Integration Service
 *
 * Menjalankan task automasi TEKO-CAK via Playwright
 * dan mengirim hasilnya ke Telegram.
 *
 * Task tersedia:
 *   - login    : Login saja
 *   - generate : Generate laporan absensi
 *   - update   : Update data pegawai per NIP
 *   - all      : Login → Generate → Update (full)
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const TEKOCAK_DIR = path.resolve(__dirname, '../../automated-tekocak');

/**
 * Load env dari automated-tekocak/.env dan merge ke process.env
 */
function ensureTekocakEnv() {
  const envPath = path.join(TEKOCAK_DIR, '.env');
  if (!fs.existsSync(envPath)) return false;

  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    // Jangan overwrite yang sudah ada di process.env (prioritas env utama)
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
 * Jalankan task TEKO-CAK
 *
 * @param {'all'|'login'|'generate'|'update'} taskName
 * @param {function(string)} onProgress - callback tiap baris log (opsional)
 * @returns {Promise<{success: boolean, output: string, duration: number}>}
 */
async function runTask(taskName, onProgress = () => {}) {
  const startTime = Date.now();
  const lines = [];
  const log = (msg) => { lines.push(msg); onProgress(msg); };

  // Load env dari automated-tekocak/.env
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

  // Validasi credential
  if (!config.USERNAME || !config.PASSWORD) {
    return {
      success: false,
      output: [
        '❌ **TEKO-CAK belum dikonfigurasi!**',
        '',
        'Buat file `automated-tekocak/.env` dengan isi:',
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

  log(`🚀 **TEKO-CAK: ${taskName.toUpperCase()}**`);
  log(`🔗 ${config.TEKOCAK_URL}`);
  log(`📅 Tahun: ${config.TAHUN}`);
  log(`👥 NIP: ${config.DAFTAR_NIP.length} pegawai`);
  if (config.HEADLESS) log('🕶️ Mode: Headless');
  log('');

  let browser;
  try {
    browser = await chromium.launch({
      headless: config.HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    // Load task modules (dari dalam TEKOCAK_DIR agar require paths-nya benar)
    const login = require(path.join(TEKOCAK_DIR, 'tasks', 'login'));
    const generate = require(path.join(TEKOCAK_DIR, 'tasks', 'generate'));
    const updatePegawai = require(path.join(TEKOCAK_DIR, 'tasks', 'update-pegawai'));

    // ===== LOGIN =====
    log('🔐 **Login TEKO-CAK...**');
    await login.run(page);
    log('✅ **Login berhasil!**\n');

    if (taskName === 'login') {
      const duration = (Date.now() - startTime) / 1000;
      log(`⏱️ Selesai dalam ${formatDuration(duration)}`);
      await browser.close();
      return { success: true, output: lines.join('\n'), duration };
    }

    // ===== GENERATE =====
    if (taskName === 'all' || taskName === 'generate') {
      log('📊 **Generate Laporan...**');
      await generate.run(page);
      log('✅ **Generate laporan selesai!**\n');
    }

    // ===== UPDATE PEGAWAI =====
    if (taskName === 'all' || taskName === 'update') {
      log(`👤 **Update ${config.DAFTAR_NIP.length} Pegawai...**`);
      await updatePegawai.run(page, browser);
      log('✅ **Update pegawai selesai!**\n');
    }

    const duration = (Date.now() - startTime) / 1000;
    log(`⏱️ **Selesai dalam ${formatDuration(duration)}**`);
    await browser.close();
    return { success: true, output: lines.join('\n'), duration };

  } catch (err) {
    try { if (browser) await browser.close(); } catch (_) {}
    const duration = (Date.now() - startTime) / 1000;
    log(`❌ **Error:** ${err.message}`);
    log(`⏱️ **Gagal setelah ${formatDuration(duration)}**`);
    return { success: false, output: lines.join('\n'), duration };
  }
}

module.exports = { runTask };
