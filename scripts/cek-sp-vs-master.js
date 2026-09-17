'use strict';
/**
 * Cek silang daftar pegawai dari arsip SP (pdf-extraction/sp-kantorku-wfo/arsip/*.json)
 * dengan MASTER PEGAWAI dari API BKPSDM.
 *
 * Pakai:
 *   node scripts/cek-sp-vs-master.js                 # arsip SP terbaru
 *   node scripts/cek-sp-vs-master.js <file.json>     # metadata SP tertentu
 *   node scripts/cek-sp-vs-master.js --simpan-raw    # simpan respons API mentah
 *
 * Output: tabel status per pegawai + simpan hasil ke
 *   pdf-extraction/sp-kantorku-wfo/arsip/<...>-vs-master.json
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const BASE = process.env.API_BASE_URL || 'https://bkpsdm.surabaya.go.id/api/ai-agent';
const TIMEOUT = 120000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIR_SP = path.resolve(__dirname, '..', 'pdf-extraction', 'sp-kantorku-wfo', 'arsip');

// ================= MASTER PEGAWAI =================

async function ambilMaster() {
  const username = process.env.API_USERNAME;
  const password = process.env.API_PASSWORD;
  if (!username || !password) throw new Error('API_USERNAME / API_PASSWORD tidak ada di .env');

  const login = async () => {
    const r = await fetch(`${BASE}/auth/login.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const d = await r.json();
    if (!r.ok || !d.token) throw new Error(d.error || `Login gagal HTTP ${r.status}`);
    return d.token;
  };

  let token = await login();
  const minta = () => fetch(`${BASE}/master-pegawai/all.php?limit=1000`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT),
  });

  let t0 = Date.now();
  let res = await minta();
  if (res.status >= 500 || res.status === 401) {
    console.log(`   ⏳ Server balas HTTP ${res.status}, retry sekali...`);
    await sleep(3000);
    if (res.status === 401) token = await login();
    res = await minta();
  }
  const teks = await res.text();
  if (!teks.trim().startsWith('{') && !teks.trim().startsWith('[')) {
    throw new Error(`Respons bukan JSON (HTTP ${res.status}): ${teks.slice(0, 120)}`);
  }
  const data = JSON.parse(teks);
  const items = data.data || data.rows || (Array.isArray(data) ? data : []);
  return { items, ms: Date.now() - t0, status: res.status };
}

// ================= NORMALISASI =================

/** Gelar yang ditulis sebagai kata utuh (setelah tanda baca dibuang) */
const GELAR_SET = new Set([
  'SE', 'SH', 'ST', 'SP', 'SI', 'SA', 'SS', 'SSI', 'SAP', 'SKOM', 'SIKOM', 'STI', 'SKED',
  'SSOS', 'SIP', 'SPSI', 'SKEP', 'SST', 'SSTP', 'SAB', 'SFARM', 'SPI', 'SAK', 'SAG',
  'MM', 'MSI', 'MS', 'MA', 'MSC', 'MBA', 'MP', 'MPD', 'MH', 'MKM', 'MT', 'MPSI',
  'AK', 'AMD', 'AMK', 'AMG', 'AMKG', 'A', 'MD',
  'DR', 'DRA', 'DRS', 'IR', 'PROF', 'HJ', 'H', 'RADEN', 'R',
]);

/**
 * Nama untuk perbandingan: uppercase, buang tanda baca, buang gelar.
 *
 * Aturan gelar: (a) token tunggal (mis. sisa "S" / "A" / "P" dari "S.A.P."),
 * (b) token singkatan gelar umum, dan (c) token yang mengikuti satu huruf
 * tunggal (mis. "KOM" pada "S.Kom", "Si" pada "M.Si") — karena sebagian master
 * menyimpan nama tanpa gelar sama sekali, tanpa ini perbandingan jadi timpang.
 */
function normalNama(s) {
  const token = String(s || '')
    .replace(/,/g, ' ')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const bersih = [];
  for (let i = 0; i < token.length; i++) {
    if (token[i].length === 1) { i++; continue; }   // buang huruf tunggal + pasangannya
    if (GELAR_SET.has(token[i])) continue;          // buang singkatan gelar
    bersih.push(token[i]);
  }
  return bersih.join(' ').trim();
}

function kemiripan(a, b) {
  const A = new Set(normalNama(a).split(' ').filter(Boolean));
  const B = new Set(normalNama(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let irisan = 0;
  for (const t of A) if (B.has(t)) irisan++;
  return irisan / Math.max(A.size, B.size);
}

// ================= MAIN =================

function bacaMetadata(berkas) {
  try {
    const data = JSON.parse(fs.readFileSync(berkas, 'utf-8'));
    if (Array.isArray(data.pegawai) && data.pegawai.length) return data;
    if (Array.isArray(data.arsip)) {
      const urut = [...data.arsip].sort((a, b) => String(b.disimpanPada).localeCompare(String(a.disimpanPada)));
      for (const entri of urut) {
        const meta = path.join(DIR_SP, entri.meta);
        if (fs.existsSync(meta)) return bacaMetadata(meta);
      }
    }
  } catch { /* lanjut */ }
  return null;
}

(async () => {
  const argv = process.argv.slice(2);
  const berkasArg = argv.find((a) => !a.startsWith('--'));
  const berkasSp = berkasArg
    ? path.resolve(berkasArg)
    : path.join(DIR_SP, 'index.json');

  const sp = bacaMetadata(berkasSp);
  if (!sp) throw new Error(`Tidak bisa membaca metadata SP dari: ${berkasSp}`);

  console.log('📄 SP   : ' + (sp.namaFileAsli || '-'));
  console.log('   Nomor: ' + (sp.nomorSurat || '-') + ' | ' + sp.pegawai.length + ' pegawai di SP');

  console.log('\n🌐 Ambil master pegawai dari API...');
  const { items, ms } = await ambilMaster();
  console.log(`   ✅ ${items.length} baris master diterima (${(ms / 1000).toFixed(1)} detik)`);

  if (argv.includes('--simpan-raw')) {
    const keluar = path.join(DIR_SP, `master-raw-${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(keluar, JSON.stringify(items, null, 2));
    console.log(`   💾 Respons mentah: ${keluar}`);
  }

  // Indeks master: by NIP, by NIK, by nama ternormalisasi
  const byNip = new Map();
  const byNama = new Map();
  for (const it of items) {
    const nip = String(it.NIP || '').trim();
    const nik = String(it.NIK || '').trim();
    if (nip && nip !== '-') byNip.set(nip, it);
    if (nik) {
      byNip.set(nik, byNip.get(nik) || it); // NIK juga bisa jadi kunci (Non-ASN)
    }
    const n = normalNama(it.NAMA);
    if (n) byNama.set(n, it);
  }

  const baris = [];
  let cocok = 0; let namaBeda = 0; let tidakAda = 0;

  for (const p of sp.pegawai) {
    const mNip = byNip.get(p.nip);
    let status; let master = null; let skor = null;

    if (mNip) {
      master = mNip;
      skor = kemiripan(p.nama, mNip.NAMA);
      if (skor >= 0.999) { status = 'COCOK'; cocok++; }
      else { status = 'NIP SAMA / NAMA BEDA'; namaBeda++; }
    } else {
      // cari berdasar kemiripan nama
      let terbaik = null; let skorTerbaik = 0;
      for (const [n, it] of byNama) {
        const s = kemiripan(p.nama, it.NAMA);
        if (s > skorTerbaik) { skorTerbaik = s; terbaik = it; }
      }
      if (terbaik && skorTerbaik >= 0.6) {
        status = `NAMA MIRIP ${(skorTerbaik * 100).toFixed(0)}% (NIP beda)`;
        master = terbaik; skor = skorTerbaik; namaBeda++;
      } else {
        status = 'TIDAK ADA DI MASTER'; tidakAda++;
      }
    }

    baris.push({
      no: p.no,
      nip_sp: p.nip,
      nama_sp: p.nama,
      jenis_sp: p.jenis,
      status,
      kemiripan: skor,
      nip_master: master ? String(master.NIP || '').trim() : null,
      nik_master: master ? String(master.NIK || '').trim() : null,
      nama_master: master ? String(master.NAMA || '').trim() : null,
      ket_master: master ? master.KET : null,
    });
  }

  // ===== Tampilan =====
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log('  HASIL CEK SILANG SP ↔ MASTER PEGAWAI');
  console.log('════════════════════════════════════════════════════════════════════');
  for (const b of baris) {
    const ikon = b.status === 'COCOK' ? '✅' : b.status.startsWith('NAMA MIRIP') ? '🟡' : b.status.startsWith('NIP SAMA') ? '⚠️' : '❌';
    console.log(`\n${ikon} [${b.no}] ${b.nama_sp}`);
    console.log(`     NIP SP    : ${b.nip_sp} (${b.jenis_sp})`);
    if (b.nama_master) {
      console.log(`     NIP master: ${b.nip_master === b.nip_sp ? '(sama)' : b.nip_master}${b.nik_master && b.nik_master !== b.nip_master ? ` | NIK: ${b.nik_master}` : ''}`);
      console.log(`     Nama master: ${b.nama_master}${b.ket_master ? `  [KET: ${b.ket_master}]` : ''}`);
      if (b.kemiripan !== null && b.kemiripan < 0.999) console.log(`     Kemiripan nama: ${(b.kemiripan * 100).toFixed(0)}%`);
    }
    console.log(`     Status    : ${b.status}`);
  }

  console.log('\n────────────────────────────────────────────────────────────────────');
  console.log(`  Total SP: ${sp.pegawai.length}  |  ✅ cocok: ${cocok}  |  🟡/⚠️ perlu dicek: ${namaBeda}  |  ❌ tidak ada: ${tidakAda}`);

  // Sebaran KET di master (konteks: apakah mereka memang terdaftar WFH/WFO)
  const sebaran = {};
  for (const it of items) {
    const k = String(it.KET || '-').trim() || '-';
    sebaran[k] = (sebaran[k] || 0) + 1;
  }
  console.log('  KET di master (semua pegawai): ' + Object.entries(sebaran).map(([k, v]) => `${k}=${v}`).join(', '));

  const ketSp = {};
  for (const b of baris) {
    const k = b.ket_master || '(tidak di master)';
    ketSp[k] = (ketSp[k] || 0) + 1;
  }
  console.log('  KET 9 pegawai SP ini: ' + Object.entries(ketSp).map(([k, v]) => `${k}=${v}`).join(', '));
  console.log('────────────────────────────────────────────────────────────────────\n');

  const keluaran = {
    dibuatPada: new Date().toISOString(),
    sp: { namaFile: sp.namaFileAsli, nomorSurat: sp.nomorSurat, jumlahPegawai: sp.pegawai.length },
    masterApi: { jumlahBaris: items.length, baseUrl: BASE },
    ringkasan: { cocok, perluDicek: namaBeda, tidakAda },
    detail: baris,
  };
  const berkasHasil = path.join(
    DIR_SP,
    `${(sp.nomorSurat || 'sp').replace(/[^0-9A-Za-z._-]/g, '-')}-vs-master.json`
  );
  fs.writeFileSync(berkasHasil, JSON.stringify(keluaran, null, 2));
  console.log(`💾 Hasil lengkap: ${berkasHasil}\n`);
})().catch((err) => {
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
});
