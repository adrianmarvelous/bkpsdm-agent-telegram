/**
 * units.js — Resolusi & pencocokan "unit kerja tujuan" (field `tujuan_unit`) eSurat.
 *
 * Nilai ASLI dari API (hasil probe 41 tanggal / 245 entri, 10 Sep 2026):
 *   SEKRETARIAT · SUB BAGIAN KEUANGAN · TIM KERJA UMUM DAN KEPEGAWAIAN ·
 *   TIM KERJA PENILAIAN KINERJA PEGAWAI · TIM KERJA PEMBINAAN DISIPLIN PEGAWAI ·
 *   TIM KERJA PENGADAAN PEGAWAI DAN INFORMASI KEPEGAWAIAN ·
 *   TIM KERJA PENGEMBANGAN KOMPETENSI TEKNIS · TIM KERJA MUTASI DAN PROMOSI PEGAWAI ·
 *   TIM KERJA PENGEMBANGAN KOMPETENSI MANAJERIAL DAN FUNGSIONAL ·
 *   BIDANG PENGELOLAAN KINERJA PEGAWAI · BIDANG PENGEMBANGAN KOMPETENSI PEGAWAI ·
 *   BIDANG PENGELOLAAN ADMINISTRASI DAN INFORMASI KEPEGAWAIAN ·
 *   BADAN KEPEGAWAIAN DAN PENGEMBANGAN SUMBER DAYA MANUSIA
 *   (nilai `(null)` = 141/245 entri tidak punya unit tujuan)
 *
 * Pemakaian:
 *   resolveUnitList('keuangan')             → ['SUB BAGIAN KEUANGAN']
 *   resolveUnitList('sekretariat,keuangan') → ['SEKRETARIAT', 'SUB BAGIAN KEUANGAN']
 *   resolveUnitList('semua') / '' / null    → null   (= TANPA filter)
 *   cocokUnit('sub bagian keuangan', [...]) → true   (case-insensitive)
 *
 * Pencocokan SELALU exact match pada nama kanonik — bukan substring — supaya
 * "SUB BAGIAN KEUANGAN" tidak ikut tertarik oleh kata "KEUANGAN" di unit lain.
 */
const UNIT_ALIAS = {
  sekretariat: 'SEKRETARIAT',
  keuangan: 'SUB BAGIAN KEUANGAN',
  'sub bagian keuangan': 'SUB BAGIAN KEUANGAN',
  subbagian: 'SUB BAGIAN KEUANGAN',
  umum: 'TIM KERJA UMUM DAN KEPEGAWAIAN',
  'umum dan kepegawaian': 'TIM KERJA UMUM DAN KEPEGAWAIAN',
  'penilaian kinerja': 'TIM KERJA PENILAIAN KINERJA PEGAWAI',
  'pembinaan disiplin': 'TIM KERJA PEMBINAAN DISIPLIN PEGAWAI',
  pengadaan: 'TIM KERJA PENGADAAN PEGAWAI DAN INFORMASI KEPEGAWAIAN',
  'kompetensi teknis': 'TIM KERJA PENGEMBANGAN KOMPETENSI TEKNIS',
  mutasi: 'TIM KERJA MUTASI DAN PROMOSI PEGAWAI',
  bkpsdm: 'BADAN KEPEGAWAIAN DAN PENGEMBANGAN SUMBER DAYA MANUSIA',
};

const NO_FILTER = new Set(['', 'semua', 'all', '*', '-', 'tanpa filter', 'tanpafilter', 'tanpa-filter', 'semua unit']);

/** Alias terpanjang dulu, supaya 'sub bagian keuangan' menang atas 'keuangan'. */
const ALIAS_KEYS = Object.keys(UNIT_ALIAS).sort((a, b) => b.length - a.length);

/**
 * Ubah input bebas → daftar nama unit kanonik, atau null kalau berarti "tanpa filter".
 * @param {string|null|undefined} input  mis. 'keuangan', 'SEKRETARIAT,keuangan', 'semua'
 * @returns {string[]|null}
 */
function resolveUnitList(input) {
  const s = String(input == null ? '' : input).trim().toLowerCase();
  if (NO_FILTER.has(s)) return null;
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const out = [];
  for (const p of parts) {
    const v = UNIT_ALIAS[p] || p.toUpperCase();
    if (!out.includes(v)) out.push(v);
  }
  return out.length ? out : null;
}

/**
 * Cek apakah satu nilai `tujuan_unit` lolos filter.
 * @param {string|null} tujuanUnit  nilai mentah dari API
 * @param {string[]|null} unitList  hasil resolveUnitList (null = semua lolos)
 */
function cocokUnit(tujuanUnit, unitList) {
  if (!unitList) return true;
  const t = String(tujuanUnit == null ? '' : tujuanUnit).trim().toUpperCase();
  return unitList.includes(t);
}

/** Label untuk judul/PDF. */
function labelUnit(unitList) {
  return unitList && unitList.length ? unitList.join(' + ') : 'semua unit tujuan';
}

/**
 * Tebak unit dari teks perintah bebas (dipakai bot).
 * Cari alias yang muncul di teks; 'tanpa filter'/'semua unit' → null (semua).
 * @returns {string[]|null|undefined} undefined = tidak disebut (pakai default pemanggil)
 */
function unitDariTeks(teks) {
  const s = String(teks || '').toLowerCase();
  if (/(tanpa\s*filter|semua\s*unit|semua\s*undangan|semua\s*agenda)/.test(s)) return null;
  for (const k of ALIAS_KEYS) {
    if (s.includes(k)) return resolveUnitList(k);
  }
  return undefined;
}

module.exports = { UNIT_ALIAS, ALIAS_KEYS, NO_FILTER, resolveUnitList, cocokUnit, labelUnit, unitDariTeks };
