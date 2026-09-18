'use strict';
/**
 * Baca PDF SP memakai modul pdf-extraction/sp-kantorku-wfo (API modul, bukan CLI).
 * Menampilkan seluruh hasil ekstraksi apa adanya untuk audit.
 */
const path = require('path');
const sp = require('../pdf-extraction/sp-kantorku-wfo');

const PDF = process.argv[2] || '/home/ubuntu/.hermes/cache/documents/doc_0ed78e7b16a8_WFO-1.pdf';

console.log('══════════════════════════════════════════════════════');
console.log('  BACA PDF VIA MODUL sp-kantorku-wfo (API parsePdf)');
console.log('══════════════════════════════════════════════════════');
console.log('File:', PDF);
console.log();

// --- 1. parsePdf: API utama modul ---
const h = sp.parsePdf(PDF);

console.log('── HASIL parsePdf() ──────────────────────────────────');
console.log(JSON.stringify({
  sumber: h.sumber,
  namaFile: h.namaFile,
  sha256: h.sha256,
  pdf: h.pdf,
  nomorSurat: h.nomorSurat,
  tanggalSurat: h.tanggalSurat,
  kegiatan: h.kegiatan,
  linkEsurat: h.linkEsurat,
  formatDaftar: h.formatDaftar,
  jumlahPegawai: h.jumlahPegawai,
  jumlahAsn: h.jumlahAsn,
  jumlahNonAsn: h.jumlahNonAsn,
  peringatan: h.peringatan,
}, null, 2));

console.log();
console.log('── DAFTAR PEGAWAI ────────────────────────────────────');
for (const p of h.pegawai) {
  console.log(`${p.no}. ${p.nama}`);
  console.log(`   NIP/NIK : ${p.nip}`);
  console.log(`   Jabatan : ${p.jabatan || '-'}`);
  console.log(`   Pangkat : ${p.pangkat || '-'}`);
  console.log(`   Jenis   : ${p.jenis} | valid: ${p.valid}`);
}
console.log();

// --- 2. Uji simpanSp (idempoten) ---
console.log('── simpanSp() — cek idempoten ────────────────────────');
const r = sp.simpanSp(PDF);
console.log('duplikat :', r.duplikat, r.duplikat ? '(sudah ada, tidak digandakan)' : '(baru disimpan)');
console.log('file     :', path.basename(r.file));

// --- 3. daftarArsip ---
const idx = sp.daftarArsip();
console.log();
console.log('── daftarArsip() ─────────────────────────────────────');
console.log('Jumlah arsip:', idx.jumlah);
for (const a of idx.arsip) {
  console.log(`  • ${a.file}  →  ${a.jumlahPegawai} pegawai  (${a.namaFileAsli})`);
}

// --- 4. ambilArsip by nomor surat ---
const amb = sp.ambilArsip(h.nomorSurat);
console.log();
console.log('── ambilArsip(nomorSurat) ───────────────────────────');
console.log('ketemu  :', !!amb);
if (amb) {
  console.log('nomor   :', amb.meta.nomorSurat);
  console.log('tanggal :', amb.meta.tanggalSurat?.display || amb.meta.tanggalSurat?.iso);
  console.log('pegawai :', amb.meta.pegawai.length, 'orang');
  console.log('sha256  :', amb.meta.sha256);
}
