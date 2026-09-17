'use strict';
/**
 * Anonimisasi lampiran tabel "Semula / Menjadi" → fixture uji yang aman di-commit.
 *
 * Pakai:
 *   node pdf-extraction/kampung-pancasila/test/buat-fixture.js [file.pdf]
 *   (tanpa argumen: pakai arsip surat pergantian terbaru di arsip/)
 *
 * Yang diganti: nama pegawai, NIP/NIK, nomor HP, nama pejabat penandatangan.
 * Yang DIPERTAHANKAN: nomor surat, tanggal, nama jabatan, nama kelurahan, dan
 * seluruh anomali layout (sel yang menempel, nama terpotong baris, footer
 * berulang) — justru itu yang diuji.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const DIR_ARSIP = path.resolve(DIR, '..', 'arsip');
const KELUARAN = path.join(DIR, 'fixture-tabel-semula-menjadi.xml');

/** Nama asli → nama fiktif (panjang dijaga mirip, supaya tata letak tetap setara) */
const GANTI_NAMA = [
  ['TJAHJONO AGUNG WIBOWO', 'AHMAD SANTOSO WIJAYA'],
  ['SUSBANDORO', 'HANDOKO PRASETYO'],
  ['SYAHRUDIN, S.M.', 'SETIAWAN, S.T.'],
  ['PRIYO UTOMO', 'DEDI KURNIAWAN'],
  ['NENI TRIANA', 'SITI AMINAH'],
  ['YULI ASTUTI,', 'RINA KARTIKA,'],
  ['S.A.P.', 'S.E.'],
  ['HAJAR SULISTYONO, S.Sos,M.Si', 'PEJABAT CONTOH, S.Sos'],
  ['197405021997031003', '197001012000031001'], // NIP CAMAT (penandatangan)
];

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * NIP fiktif ke-i — WAJIB 18 digit (seperti NIP ASN asli): kalau panjangnya
 * berbeda, posisi token di dalam sel yang menempel ikut bergeser sehingga
 * fixture tidak lagi mewakili surat asli.
 */
function fakeNip(i) {
  return `1975${pad2(7 + i)}${pad2(26 + i)}2008${pad2(1 + i)}${String(2000 + i)}`;
}

/** Nomor HP fiktif ke-i */
function fakeHp(i) {
  return `0812${String(345670 + i)}`;
}

/** Terapkan anonimisasi pada teks XML */
function anonymalkan(xml) {
  let teks = String(xml);

  for (const [asli, fiktif] of GANTI_NAMA) {
    teks = teks.split(asli).join(fiktif);
  }

  const petaNip = new Map();
  teks = teks.replace(/(?<!\d)(\d{18})(?!\d)/g, (m) => {
    if (!petaNip.has(m)) petaNip.set(m, fakeNip(petaNip.size + 1));
    return petaNip.get(m);
  });

  const petaHp = new Map();
  teks = teks.replace(/(?<!\d)(08\d{8,11})(?!\d)/g, (m) => {
    if (!petaHp.has(m)) petaHp.set(m, fakeHp(petaHp.size + 1));
    return petaHp.get(m);
  });

  return { teks, petaNip: Object.fromEntries(petaNip), petaHp: Object.fromEntries(petaHp) };
}

function pdfSumber() {
  const arg = process.argv[2];
  if (arg) return path.resolve(arg);
  const kandidat = fs.readdirSync(DIR_ARSIP)
    .filter((f) => /pergantian|863/i.test(f) === false && f.endsWith('.pdf'))
    .sort();
  // utamakan arsip surat pergantian (nomor 800/863)
  const nama = fs.readdirSync(DIR_ARSIP).find((f) => f.endsWith('.pdf') && f.includes('863'))
    || kandidat[kandidat.length - 1];
  if (!nama) throw new Error('Tidak ada PDF di arsip/ — berikan path PDF sebagai argumen');
  return path.join(DIR_ARSIP, nama);
}

if (require.main === module) {
  const pdf = pdfSumber();
  const xml = execFileSync('pdftohtml', ['-xml', '-stdout', '-i', '-f', '2', '-l', '2', pdf],
    { maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf-8');
  const { teks, petaNip, petaHp } = anonymalkan(xml);
  fs.writeFileSync(KELUARAN, teks, 'utf-8');
  console.log(`✅ Fixture (teranonimisasi) dibuat dari: ${path.basename(pdf)}`);
  console.log(`   → ${KELUARAN}`);
  console.log(`   NIP diganti: ${Object.keys(petaNip).length}, HP diganti: ${Object.keys(petaHp).length}`);
}

module.exports = { anonymalkan, fakeNip, fakeHp, GANTI_NAMA, KELUARAN };
