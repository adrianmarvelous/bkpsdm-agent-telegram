/**
 * KantorKu WFH Service
 *
 * Menjalankan automasi WFH via Playwright, menangkap output,
 * dan mengembalikan hasil untuk dikirim ke Telegram.
 */
const path = require('path');
const { spawn } = require('child_process');

const KANTORKU_DIR = path.resolve(__dirname, '..', '..', 'automated-kantorku-wfh');

/**
 * Jalankan WFH untuk tanggal tertentu
 * @param {string} tanggal — format YYYY-MM-DD
 * @returns {Promise<{success: boolean, output: string, duration: number}>}
 */
async function runWfh(tanggal) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const logs = [];

    const env = {
      ...process.env,
      HEADLESS: 'true',
    };

    // Env sudah digabung ke root .env (di-load entry index.js) — KANTORKU_*
    // otomatis ada di process.env dan ikut ke proses anak.

    const child = spawn('node', ['index.js', tanggal], {
      cwd: KANTORKU_DIR,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      logs.push('\n⏱️ Timeout — proses terlalu lama (>300 detik)');
      resolve({ success: false, output: logs.join('\n'), duration: parseFloat(duration) });
    }, 300000); // 5 menit timeout

    child.stdout.on('data', (data) => {
      logs.push(data.toString().trim());
    });

    child.stderr.on('data', (data) => {
      logs.push(data.toString().trim());
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      const output = logs.join('\n');
      const success = code === 0;

      resolve({ success, output, duration: parseFloat(duration) });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ success: false, output: `Gagal menjalankan proses: ${err.message}`, duration: 0 });
    });
  });
}

module.exports = { runWfh };
