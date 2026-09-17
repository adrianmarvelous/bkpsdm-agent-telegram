/**
 * automated-sdm-cuti — klien API data cuti SDM BKPSDM Surabaya.
 *
 * Endpoint:
 *   POST {API_BASE_URL}/auth/login.php                  → { token }
 *   GET  {API_BASE_URL}/sdm/cuti/diusulkan-bulan-ini.php → { success, periode, status,
 *                                                            total_hari, total_nip_unik,
 *                                                            nip: [...], rows: [...] }
 *   GET  {API_BASE_URL}/master-pegawai/all.php?limit=1000 → master pegawai (join nama)
 *
 * Cara pakai (CLI):
 *   node index.js                 → rekap cuti diusulkan bulan ini (tabel)
 *   node index.js --json          → cetak JSON mentah dari API
 *   node index.js --ringkas       → ringkasan singkat (untuk chat/WA)
 *   node index.js --login         → cuma tes login
 *   node index.js 199711242024212019 → detail per NIP tertentu
 *
 * Sebagai modul:
 *   const { getCutiDiusulkan, formatRekap, formatRingkas } = require('./index');
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

let cachedToken = null;
let tokenExpiry = 0;

function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args); }

// ===================== HTTP HELPERS =====================

async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.requestTimeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Baca respons sebagai JSON dengan pesan error yang jelas.
 * Server kadang balikin HTML (halaman error nginx 502/504) padahal kita minta JSON.
 */
async function parseJson(res, endpoint) {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    const snippet = trimmed.replace(/\s+/g, ' ').slice(0, 120);
    if (res.status >= 500) {
      throw new Error(`⚠️ Server BKPSDM sibuk (HTTP ${res.status}) — coba lagi nanti. (${snippet})`);
    }
    throw new Error(`Respons dari ${endpoint} bukan JSON (HTTP ${res.status}): ${snippet}`);
  }
  return JSON.parse(trimmed);
}

/** Login → simpan token di memori. */
async function login() {
  if (!config.username || !config.password) {
    throw new Error('API_USERNAME / API_PASSWORD tidak dikonfigurasi di root .env');
  }
  const res = await fetchWithTimeout(`${config.baseUrl}/auth/login.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: config.username, password: config.password }),
  });
  const data = await parseJson(res, '/auth/login.php');
  if (!res.ok || !data.token) {
    throw new Error(data.error || `Login gagal: HTTP ${res.status}`);
  }
  cachedToken = data.token;
  // Asumsi token berlaku 24 jam, refresh 1 jam sebelum expired.
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
  log('✅ Login API berhasil');
  return cachedToken;
}

async function ensureToken() {
  if (!cachedToken && config.username && config.password) await login();
  if (cachedToken && Date.now() > tokenExpiry && config.username && config.password) {
    log('🔄 Token expired, login ulang…');
    await login();
  }
  return cachedToken;
}

/** GET dengan Bearer token + retry sekali untuk 401/5xx. */
async function apiGet(url, { label } = {}) {
  await ensureToken();
  const headers = { 'Content-Type': 'application/json' };
  if (cachedToken) headers.Authorization = `Bearer ${cachedToken}`;

  let res = await fetchWithTimeout(url, { headers });

  if (res.status === 401 && config.username && config.password) {
    log('🔄 Token ditolak (401), login ulang…');
    await login();
    headers.Authorization = `Bearer ${cachedToken}`;
    res = await fetchWithTimeout(url, { headers });
  }
  if (res.status >= 500) {
    log(`🔄 Server sibuk (HTTP ${res.status}), retry sekali…`);
    await new Promise((r) => setTimeout(r, 3000));
    res = await fetchWithTimeout(url, { headers });
  }

  const data = await parseJson(res, label || url);
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}: ${res.statusText}`);
  return data;
}

// ===================== DATA CUTI =====================

/**
 * Ambil data cuti berstatus DIUSULKAN untuk BULAN BERJALAN.
 *
 * ⚠️ Server BELUM mendukung parameter periode/tahun — endpoint selalu
 * mengembalikan bulan berjalan. Parameter tidak dikirim supaya tidak
 * memberi kesan bisa memilih bulan.
 *
 * @returns {Promise<object>} { success, periode, status, total_hari, total_nip_unik, nip, rows }
 */
async function getCutiDiusulkan() {
  return await apiGet(config.cutiDiusulkanUrl, { label: '/sdm/cuti/diusulkan-bulan-ini.php' });
}

/**
 * Ambil data cuti LENGKAP bulan berjalan — memecah DIUSETUJUI + DIUSULKAN.
 *
 * ⚠️ Sama seperti endpoint diusulkan: selalu bulan berjalan, tidak ada parameter.
 *
 * @returns {Promise<object>} { success, periode, tanggal_awal, tanggal_akhir,
 *                              total_hari, rekap: { disetujui, diusulkan,
 *                              nip_disetujui, nip_diusulkan },
 *                              rows: [ { tanggal, disetujui, diusulkan, total } ] }
 */
async function getCutiBulanIni() {
  return await apiGet(config.cutiBulanIniUrl, { label: '/sdm/cuti/bulan-ini.php' });
}

/**
 * Master pegawai (NIP → nama, unit kerja). Endpoint cuti hanya memberi NIP,
 * jadi ini dipakai untuk melengkapi nama.
 * @returns {Promise<Map<string, object>>} Map key = NIP (string)
 */
async function getMasterPegawai() {
  const data = await apiGet(config.masterPegawaiUrl, { label: '/master-pegawai/all.php' });
  // Respons: { success, total, returned, data: [ { NIP, NAMA, "UNIT KERJA", ... } ] }
  // ⚠️ Kolom master memakai HURUF BESAR semua (NIP, NAMA, NIK, KET, "UNIT KERJA").
  const rows = Array.isArray(data) ? data : (data.data || data.rows || []);
  const map = new Map();
  for (const r of rows) {
    // Ambil field case-insensitive agar tahan terhadap perubahan header CSV.
    const get = (name) => {
      const k = Object.keys(r).find((key) => key.toLowerCase().replace(/[\s_-]/g, '') === name);
      return k ? String(r[k] == null ? '' : r[k]).trim() : '';
    };
    // Master pegawai memakai NIP untuk ASN; non-ASN NIP '-' → kunci pakai NIK.
    const nip = get('nip');
    const nik = get('nik');
    const key = (nip && nip !== '-') ? nip : (nik && nik !== '-' ? nik : '');
    if (key) map.set(key, r);
  }
  return map;
}

/**
 * Ambil field dari record master pegawai — case-insensitive.
 * Master memakai header UPPERCASE ("NAMA", "UNIT KERJA"), tapi fungsi ini
 * toleran juga terhadap variasi lowercase/huruf campur.
 */
function fieldDari(record, name) {
  if (!record) return null;
  const k = Object.keys(record).find(
    (key) => key.toLowerCase().replace(/[\s_-]/g, '') === name
  );
  if (!k) return null;
  const v = String(record[k] == null ? '' : record[k]).trim();
  return v && v !== '-' ? v : null;
}

/** Ambil nama pegawai dari record master (toleran terhadap variasi nama kolom). */
function namaDari(master, nip) {
  return fieldDari(master && master.get(String(nip)), 'nama');
}

/**
 * Agregasi per PEGAWAI (endpoint mengembalikan per TANGGAL, bukan per orang).
 *
 * @param {object} data      respons getCutiDiusulkan()
 * @param {Map}    [master]  hasil getMasterPegawai() — opsional, untuk nama
 * @returns {Array<{nip, nama, tanggal: string[], jumlah_tanggal}>}
 */
function rekapPerPegawai(data, master) {
  const per = new Map();
  for (const row of (data.rows || [])) {
    for (const nip of (row.nip || [])) {
      if (!per.has(nip)) per.set(nip, []);
      per.get(nip).push(row.tanggal);
    }
  }
  return [...per.entries()]
    .map(([nip, tanggal]) => {
      const m = master && master.get(String(nip));
      return {
        nip,
        nama: namaDari(master, nip) || '(nama tidak ditemukan di master)',
        nik: fieldDari(m, 'nik'),
        jenis: fieldDari(m, 'jenis'),
        jabatan: fieldDari(m, 'jabatan'),
        unit_kerja: fieldDari(m, 'unitkerja'),
        ket: fieldDari(m, 'ket'),
        tanggal: tanggal.sort(),
        jumlah_tanggal: tanggal.length,
      };
    })
    .sort((a, b) => (a.tanggal[0] || '9999').localeCompare(b.tanggal[0] || '9999')
      || a.nama.localeCompare(b.nama));
}

/**
 * Agregasi per PEGAWAI untuk endpoint `bulan-ini.php` yang memecah status.
 *
 * @param {object} data      respons getCutiBulanIni()
 * @param {Map}    [master]  hasil getMasterPegawai()
 * @returns {{disetujui: Array, diusulkan: Array}}
 */
function rekapPerStatus(data, master) {
  const build = (field) => {
    const per = new Map();
    for (const row of (data.rows || [])) {
      for (const nip of (row[field] || [])) {
        if (!per.has(nip)) per.set(nip, []);
        per.get(nip).push(row.tanggal);
      }
    }
    return [...per.entries()]
      .map(([nip, tanggal]) => {
        const m = master && master.get(String(nip));
        return {
          nip,
          nama: namaDari(master, nip) || '(nama tidak ditemukan di master)',
          nik: fieldDari(m, 'nik'),
          jenis: fieldDari(m, 'jenis'),
          jabatan: fieldDari(m, 'jabatan'),
          unit_kerja: fieldDari(m, 'unitkerja'),
          tanggal: tanggal.sort(),
          jumlah_tanggal: tanggal.length,
        };
      })
      .sort((a, b) => (a.tanggal[0] || '9999').localeCompare(b.tanggal[0] || '9999')
        || a.nama.localeCompare(b.nama));
  };
  return { disetujui: build('disetujui'), diusulkan: build('diusulkan') };
}

/** Format tanggal ISO → "04 September 2026" (format Indonesia). */
function tanggalIndo(iso) {
  const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const [y, m, d] = String(iso).split('-');
  if (!y || !m || !d) return iso;
  return `${d} ${BULAN[parseInt(m, 10) - 1] || m} ${y}`;
}

/** Nama bulan periode "2026-09" → "September 2026". */
function periodeIndo(periode) {
  const [y, m] = String(periode).split('-');
  const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  return `${BULAN[parseInt(m, 10) - 1] || m} ${y}`;
}

/**
 * Rekap per tanggal (seperti bentuk asli API, tapi tanggal sudah diformat).
 */
function rekapPerTanggal(data) {
  return (data.rows || []).map((r) => ({
    tanggal: r.tanggal,
    tanggal_indo: tanggalIndo(r.tanggal),
    total: r.total,
    nip: r.nip || [],
  }));
}

// ===================== FORMATTER =====================

/** Tabel teks rekap per pegawai (untuk CLI / log). */
function formatRekap(data, master) {
  const periode = periodeIndo(data.periode);
  const perPegawai = rekapPerPegawai(data, master);

  const lines = [];
  lines.push(`REKAP CUTI DIUSULKAN — ${periode}`);
  lines.push(`Status: ${data.status} | ${data.total_nip_unik} pegawai | ${data.total_hari} tanggal`);
  lines.push('');
  lines.push('Per pegawai:');
  for (const p of perPegawai) {
    const tgl = p.tanggal.map((t) => t.slice(8)).join(', ');
    lines.push(`  • ${p.nama}`);
    lines.push(`    NIP ${p.nip} | ${p.jenis || '-'} | ${p.ket || '-'}`);
    if (p.jabatan) lines.push(`    ${p.jabatan}`);
    if (p.unit_kerja) lines.push(`    ${p.unit_kerja}`);
    lines.push(`    ${p.jumlah_tanggal} hari — tgl ${tgl}`);
  }
  lines.push('');
  lines.push('Per tanggal:');
  for (const t of rekapPerTanggal(data)) {
    lines.push(`  • ${t.tanggal_indo} — ${t.total} pegawai`);
  }
  return lines.join('\n');
}

/** Ringkasan singkat — untuk chat / WA / notifikasi. */
function formatRingkas(data, master) {
  const perPegawai = rekapPerPegawai(data, master);
  const lines = [];
  lines.push(`📋 *Cuti Diusulkan — ${periodeIndo(data.periode)}*`);
  lines.push(`${data.total_nip_unik} pegawai · ${data.total_hari} tanggal`);
  lines.push('');
  for (const p of perPegawai) {
    lines.push(`• *${p.nama}*`);
    lines.push(`  ${p.nip}`);
    lines.push(`  ${p.jumlah_tanggal} hari — ${p.tanggal.map(tanggalIndo).join(', ')}`);
  }
  return lines.join('\n');
}

/** Header blok satu status (disetujui/diusulkan) untuk rekap lengkap. */
function blokStatus(judul, daftar, indent = '  ') {
  const lines = [];
  lines.push(`${judul} — ${daftar.length} pegawai`);
  if (daftar.length === 0) {
    lines.push(`${indent}(tidak ada)`);
    return lines;
  }
  for (const p of daftar) {
    const tgl = p.tanggal.map((t) => t.slice(8)).join(', ');
    lines.push(`${indent}• ${p.nama}`);
    lines.push(`${indent}  NIP ${p.nip} | ${p.jenis || '-'}`);
    if (p.jabatan) lines.push(`${indent}  ${p.jabatan}`);
    if (p.unit_kerja) lines.push(`${indent}  ${p.unit_kerja}`);
    lines.push(`${indent}  ${p.jumlah_tanggal} hari — tgl ${tgl}`);
  }
  return lines;
}

/**
 * Rekap LENGKAP dari endpoint `bulan-ini.php` — DISETUJUI dan DIUSULKAN
 * dipisah dalam dua blok (bukan dicampur).
 */
function formatRekapLengkap(data, master) {
  const { disetujui, diusulkan } = rekapPerStatus(data, master);
  const lines = [];
  lines.push(`REKAP CUTI — ${periodeIndo(data.periode)}`);
  lines.push(`Periode ${data.tanggal_awal} s/d ${data.tanggal_akhir} (${data.total_hari} hari)`);
  lines.push(`Disetujui: ${disetujui.length} pegawai | Diusulkan: ${diusulkan.length} pegawai`);
  lines.push('');
  lines.push(...blokStatus('DISETUJUI', disetujui));
  lines.push('');
  lines.push(...blokStatus('DIUSULKAN', diusulkan));
  return lines.join('\n');
}

/** Ringkasan dua blok — untuk chat / WA (tanpa detail jabatan/unit). */
function formatRingkasLengkap(data, master) {
  const { disetujui, diusulkan } = rekapPerStatus(data, master);
  const blok = (judul, daftar) => {
    const l = [`*${judul} (${daftar.length})*`];
    if (daftar.length === 0) l.push('_tidak ada_');
    for (const p of daftar) {
      l.push(`• ${p.nama}`);
      l.push(`  ${p.jumlah_tanggal} hari — ${p.tanggal.map(tanggalIndo).join(', ')}`);
    }
    return l;
  };
  return [
    `📋 *Rekap Cuti — ${periodeIndo(data.periode)}*`,
    `Periode ${data.tanggal_awal} s/d ${data.tanggal_akhir}`,
    '',
    ...blok('DISETUJUI', disetujui),
    '',
    ...blok('DIUSULKAN', diusulkan),
  ].join('\n');
}

/**
 * Simpan hasil ke output/ (bentuk mentah + bentuk rekap).
 * @param {object} data    respons API
 * @param {Map}    master  master pegawai
 * @param {string} mode    'diusulkan' (default) atau 'lengkap' (dua status)
 */
function simpan(data, master, mode = 'diusulkan') {
  fs.mkdirSync(config.outputDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const base = path.join(config.outputDir, `cuti-${mode}-${data.periode}-${stamp}`);

  if (mode === 'lengkap') {
    const { disetujui, diusulkan } = rekapPerStatus(data, master);
    fs.writeFileSync(`${base}.json`, JSON.stringify({
      raw: data,
      rekap_disetujui: disetujui,
      rekap_diusulkan: diusulkan,
    }, null, 2));
    fs.writeFileSync(`${base}.txt`, formatRekapLengkap(data, master));
  } else {
    fs.writeFileSync(`${base}.json`, JSON.stringify({
      raw: data,
      rekap_per_pegawai: rekapPerPegawai(data, master),
      rekap_per_tanggal: rekapPerTanggal(data),
    }, null, 2));
    fs.writeFileSync(`${base}.txt`, formatRekap(data, master));
  }
  return `${base}.json`;
}

// ===================== CLI =====================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--login')) {
    await login();
    console.log('✅ Login berhasil, token valid.');
    return;
  }

  const nipFilter = args.find((a) => /^\d{8,}$/.test(a));

  // Default: rekap LENGKAP (disetujui + diusulkan, dipisah).
  // `--diusulkan` → hanya status DIUSULKAN (endpoint lebih ringan).
  const hanyaDiusulkan = args.includes('--diusulkan');
  const data = hanyaDiusulkan ? await getCutiDiusulkan() : await getCutiBulanIni();

  if (args.includes('--json')) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // Master pegawai opsional — kalau gagal, tetap lanjut tanpa nama.
  let master = new Map();
  try {
    master = await getMasterPegawai();
    log(`Master pegawai: ${master.size} record`);
  } catch (err) {
    log(`⚠️ Master pegawai gagal diambil (${err.message}) — nama tidak ditampilkan.`);
  }

  if (nipFilter) {
    if (hanyaDiusulkan) {
      const perPegawai = rekapPerPegawai(data, master).filter((p) => p.nip === nipFilter);
      if (perPegawai.length === 0) {
        console.log(`Tidak ada usulan cuti untuk NIP ${nipFilter} pada periode ${data.periode}.`);
        return;
      }
      for (const p of perPegawai) {
        console.log(`${p.nama} (${p.nip})`);
        console.log(`Status: DIUSULKAN | ${p.jenis || '-'} | ${p.ket || '-'}`);
        for (const t of p.tanggal) console.log(`  • ${tanggalIndo(t)}`);
        console.log(`Total: ${p.jumlah_tanggal} hari`);
      }
      return;
    }

    // Mode lengkap: cari pegawai di KEDUA status.
    const { disetujui, diusulkan } = rekapPerStatus(data, master);
    const hitD = disetujui.find((p) => p.nip === nipFilter);
    const hitU = diusulkan.find((p) => p.nip === nipFilter);
    if (!hitD && !hitU) {
      console.log(`NIP ${nipFilter} tidak ada cuti (disetujui maupun diusulkan) pada periode ${data.periode}.`);
      return;
    }
    const p = hitD || hitU;
    console.log(`${p.nama} (${p.nip})`);
    console.log(`Status: ${hitD ? 'DISETUJUI' : 'DIUSULKAN'} | ${p.jenis || '-'}`);
    if (p.jabatan) console.log(`${p.jabatan}`);
    if (p.unit_kerja) console.log(`${p.unit_kerja}`);
    for (const t of p.tanggal) console.log(`  • ${tanggalIndo(t)}`);
    console.log(`Total: ${p.jumlah_tanggal} hari`);
    return;
  }

  const rekap = hanyaDiusulkan ? formatRekap(data, master) : formatRekapLengkap(data, master);
  const ringkas = hanyaDiusulkan ? formatRingkas(data, master) : formatRingkasLengkap(data, master);

  if (args.includes('--ringkas')) {
    console.log(ringkas);
    return;
  }

  console.log(rekap);
  const saved = simpan(data, master, hanyaDiusulkan ? 'diusulkan' : 'lengkap');
  console.log(`\n💾 Disimpan: ${saved}`);
}

module.exports = {
  login,
  getCutiDiusulkan,
  getCutiBulanIni,
  getMasterPegawai,
  rekapPerPegawai,
  rekapPerStatus,
  rekapPerTanggal,
  formatRekap,
  formatRekapLengkap,
  formatRingkas,
  formatRingkasLengkap,
  tanggalIndo,
  periodeIndo,
  simpan,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('❌', err.message);
    process.exit(1);
  });
}
