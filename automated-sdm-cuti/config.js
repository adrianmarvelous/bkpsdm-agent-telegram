/**
 * Konfigurasi automated-sdm-cuti (SDM / kepegawaian — data cuti).
 *
 * SEMUA nilai dibaca dari ROOT .env project (env digabung di sana) — konsisten
 * dengan modul lain (esurat, tekocak, kantorku-wfh, organisasi-iko, pengaduan).
 * Tidak ada kredensial yang di-hardcode di file ini.
 *
 * Key root .env yang dipakai:
 *   API_BASE_URL     default https://bkpsdm.surabaya.go.id/api/ai-agent
 *   API_USERNAME     akun layanan API (mis. admin_bkpsdm)
 *   API_PASSWORD     password akun layanan API
 */
const path = require('path');

// Env digabung ke root .env — naik satu level dari folder modul.
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const BASE_URL = (process.env.API_BASE_URL || 'https://bkpsdm.surabaya.go.id/api/ai-agent').replace(/\/+$/, '');

module.exports = {
  baseUrl: BASE_URL,

  // Endpoint cuti (status DIUSULKAN saja, bulan berjalan).
  // CATATAN: server belum mendukung parameter periode/bulan — respons selalu
  // bulan berjalan. Jangan kirim ?periode=… sampai dev server menambahkannya.
  cutiDiusulkanUrl: process.env.SDM_CUTI_DIUSULKAN_URL
    || `${BASE_URL}/sdm/cuti/diusulkan-bulan-ini.php`,

  // Endpoint cuti LENGKAP bulan berjalan — memecah DISETUJUI + DIUSULKAN.
  // Struktur rows: { tanggal, disetujui: [nip], diusulkan: [nip], total }
  cutiBulanIniUrl: process.env.SDM_CUTI_BULAN_INI_URL
    || `${BASE_URL}/sdm/cuti/bulan-ini.php`,

  // Master pegawai — dipakai untuk join NIP → nama/unit (endpoint cuti hanya
  // mengembalikan NIP, tanpa nama).
  masterPegawaiUrl: process.env.SDM_MASTER_PEGAWAI_URL
    || `${BASE_URL}/master-pegawai/all.php?limit=1000`,

  // Kredensial API (auto-login Bearer token).
  username: process.env.API_USERNAME,
  password: process.env.API_PASSWORD,

  // Folder output — hasil rekap yang sudah diambil disimpan di sini.
  outputDir: path.join(__dirname, 'output'),

  requestTimeoutMs: parseInt(process.env.SDM_TIMEOUT_MS || '60000', 10) || 60000,
};
