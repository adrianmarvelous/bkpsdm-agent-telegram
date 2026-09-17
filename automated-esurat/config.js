/**
 * Konfigurasi automated-esurat (eSurat / agenda undangan KantorKu Surabaya).
 *
 * SEMUA nilai dibaca dari ROOT .env project (env digabung di sana) — konsisten
 * dengan modul lain (tekocak, kantorku-wfh, organisasi-iko, pengaduan-listener).
 * Tidak ada kredensial yang di-hardcode di file ini.
 *
 * Key root .env yang dipakai:
 *   ESURAT_BASE_URL    default https://kantorku.surabaya.go.id
 *   ESURAT_LOGIN_URL   default <base>/api/login
 *   ESURAT_AGENDA_URL  default <base>/api/integrasi/esurat-agenda
 *   ESURAT_USERNAME    akun layanan (mis. bkpsdm)
 *   ESURAT_PASSWORD    password akun layanan
 */
const path = require('path');

// Env digabung ke root .env — naik satu level dari folder modul.
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const BASE_URL = (process.env.ESURAT_BASE_URL || 'https://kantorku.surabaya.go.id').replace(/\/+$/, '');

module.exports = {
  baseUrl: BASE_URL,
  loginUrl: process.env.ESURAT_LOGIN_URL || `${BASE_URL}/api/login`,
  agendaUrl: process.env.ESURAT_AGENDA_URL || `${BASE_URL}/api/integrasi/esurat-agenda`,
  username: process.env.ESURAT_USERNAME,
  password: process.env.ESURAT_PASSWORD,
  // Folder output — data undangan/agenda yang sudah diambil disimpan di sini.
  outputDir: path.join(__dirname, 'undangan'),
  requestTimeoutMs: parseInt(process.env.ESURAT_TIMEOUT_MS || '30000', 10) || 30000,
};
