/**
 * Aturan Absensi — Kategori tambahan: Pulang Cepat
 *
 * Rule: pegawai dikategorikan PULANG CEPAT (kategori sendiri, bukan mangkir)
 * jika jam pulang < batas waktu kerja:
 *   - Senin - Kamis : jam pulang < 16:00
 *   - Jumat         : jam pulang < 16:30
 *   - Sabtu/Minggu  : tidak ada rule (null)
 *
 * Berlaku di sisi client (bot + PDF) — data keterangan dari server tetap dipakai,
 * rule ini MENAMBAH deteksi kategori pulang cepat untuk kasus pulang lebih awal.
 */

/**
 * Parse "HH:MM" (boleh tanpa leading zero) → menit sejak tengah malam.
 * Return null jika format tidak valid.
 */
function parseJam(j) {
  if (!j || typeof j !== 'string') return null;
  const m = j.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Ambil batas jam pulang berdasarkan hari dari tanggal (YYYY-MM-DD).
 * Return "16:00" | "16:30" | null (weekend = tidak ada rule).
 */
function getPulangCepatThreshold(tanggal) {
  if (!tanggal) return null;
  const d = new Date(`${tanggal}T00:00:00`);
  if (isNaN(d.getTime())) return null;
  const day = d.getDay(); // 0=Minggu, 1=Senin ... 5=Jumat, 6=Sabtu
  if (day >= 1 && day <= 4) return '16:00'; // Senin-Kamis
  if (day === 5) return '16:30';            // Jumat
  return null;                              // Sabtu/Minggu
}

/**
 * Cek apakah jam pulang dianggap "pulang cepat" (mangkir) untuk tanggal tsb.
 * @param {string|null} jamPulang  "HH:MM"
 * @param {string} tanggal         "YYYY-MM-DD"
 * @returns {boolean}
 */
function isPulangCepat(jamPulang, tanggal) {
  const t = parseJam(jamPulang);
  if (t === null) return false;
  const thr = getPulangCepatThreshold(tanggal);
  if (!thr) return false;
  const tt = parseJam(thr);
  return t < tt;
}

/**
 * Hitung jumlah pegawai dari array anomali yang kena rule pulang cepat.
 * @param {Array} anomali  array anomali dari API
 * @param {string} tanggal "YYYY-MM-DD"
 * @returns {number}
 */
function countPulangCepat(anomali, tanggal) {
  if (!Array.isArray(anomali)) return 0;
  return anomali.filter(a => isPulangCepat(a.jam_pulang, tanggal)).length;
}

module.exports = { parseJam, getPulangCepatThreshold, isPulangCepat, countPulangCepat };
