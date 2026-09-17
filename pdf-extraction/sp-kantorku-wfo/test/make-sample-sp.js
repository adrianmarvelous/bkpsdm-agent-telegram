'use strict';
/**
 * Generator PDF SP contoh (FIXTURE TEST) — bukan data asli.
 *
 * Dipakai untuk menguji pdf-extraction/sp-kantorku-wfo/parser.js tanpa menunggu PDF asli:
 *   node pdf-extraction/sp-kantorku-wfo/test/make-sample-sp.js
 * → menghasilkan sample-sp-v1.pdf (kolom NO|NIP|NAMA|JABATAN)
 *                sample-sp-v2.pdf (kolom NO|NAMA|NIP, gaya daftar hadir)
 *
 * Ganti/tambah baris di sini kalau mau menguji variasi layout lain.
 */

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const KELUARAN = __dirname;

const PEGAWAI = [
  { no: 1, nip: '197407192010011001', nama: 'AGUS HIDAJAT, S.M.', jabatan: 'Analis Kepegawaian Muda' },
  { no: 2, nip: '196908231999032001', nama: 'Dr. ANIS MASLUCHAH, Dra., M.Si', jabatan: 'Kepala Bidang Pengembangan Kompetensi' },
  { no: 3, nip: '198503122015031004', nama: 'FAHRUR ROZI, SE', jabatan: 'Pengelola Sistem Informasi' },
  { no: 4, nip: '3578011707890003', nama: 'ADRIAN MARVEL UGRASENA', jabatan: 'Pranata Komputer' }, // Non-ASN: NIK 16 digit
  { no: 5, nip: '197105292009011001', nama: 'RINA KARTIKA WULANDARI, S.Sos', jabatan: 'Bendahara Pengeluaran' },
];

const KOP = [
  'PEMERINTAH KOTA SURABAYA',
  'BADAN KEPEGAWAIAN DAN PENGEMBANGAN SUMBER DAYA MANUSIA',
  'Jl. Jimerto No. 25-27, Surabaya 60272',
];

function gambarKop(doc) {
  doc.font('Helvetica-Bold').fontSize(12).text(KOP[0], { align: 'center' });
  doc.font('Helvetica-Bold').fontSize(10).text(KOP[1], { align: 'center' });
  doc.font('Helvetica').fontSize(8).text(KOP[2], { align: 'center' });
  doc.moveDown(1.5);
  doc.font('Helvetica-Bold').fontSize(13).text('SURAT PERINTAH', { align: 'center', underline: true });
  doc.font('Helvetica').fontSize(10).text('Nomor : 800/11641/436.8.4/2026', { align: 'center' });
  doc.moveDown(1);
  doc.font('Helvetica-Bold').fontSize(10).text('TENTANG', { align: 'center' });
  doc.font('Helvetica-Bold').fontSize(10).text('PENUGASAN WORK FROM HOME (WFH) BAGI PEGAWAI', { align: 'center' });
  doc.moveDown(1);
  doc.font('Helvetica').fontSize(10).text('Kepala Badan Kepegawaian dan Pengembangan Sumber Daya Manusia Kota Surabaya, dengan ini menugaskan pegawai berikut untuk melaksanakan Work From Home (WFH):', { align: 'justify' });
  doc.moveDown(0.8);
}

/** Tabel versi 1: NO | NIP/NIK | NAMA | JABATAN */
function tabelNipDulu(doc) {
  const y0 = doc.y;
  const x = { no: 55, nip: 100, nama: 250, jabatan: 430 };
  doc.font('Helvetica-Bold').fontSize(9);
  doc.text('NO', x.no, y0);
  doc.text('NIP/NIK', x.nip, y0);
  doc.text('NAMA', x.nama, y0);
  doc.text('JABATAN', x.jabatan, y0);

  let y = y0 + 16;
  doc.font('Helvetica').fontSize(9);
  for (const p of PEGAWAI) {
    // Baris 5 sengaja namanya panjang → uji deteksi nama terpotong
    doc.text(String(p.no), x.no, y);
    doc.text(p.nip, x.nip, y);
    doc.text(p.nama, x.nama, y, { width: 175 });
    doc.text(p.jabatan, x.jabatan, y, { width: 130 });
    y += (p.no === 2 || p.no === 5) ? 34 : 18;
  }
  doc.y = y + 6;
}

/** Tabel versi 2: NO | NAMA | NIP (kolom nama sempit → nama wrap 2 baris) */
function tabelNamaDulu(doc) {
  const y0 = doc.y;
  const x = { no: 55, nama: 100, nip: 430 };
  doc.font('Helvetica-Bold').fontSize(9);
  doc.text('NO', x.no, y0);
  doc.text('NAMA', x.nama, y0);
  doc.text('NIP/NIK', x.nip, y0);

  let y = y0 + 16;
  doc.font('Helvetica').fontSize(9);
  for (const p of PEGAWAI) {
    doc.text(String(p.no), x.no, y);
    const tinggi = doc.heightOfString(p.nama, { width: 240 });
    doc.text(p.nama, x.nama, y, { width: 240 });
    doc.text(p.nip, x.nip, y);
    y += Math.max(18, tinggi + 6);
  }
  doc.y = y + 6;
}

/** Tabel versi 3: kolom NIP sengaja terlalu sempit → NIP terpotong (uji peringatan) */
function tabelNipTerpotong(doc) {
  const y0 = doc.y;
  const x = { no: 55, nama: 100, nip: 470 };
  doc.font('Helvetica-Bold').fontSize(9);
  doc.text('NO', x.no, y0);
  doc.text('NAMA', x.nama, y0);
  doc.text('NIP/NIK', x.nip, y0);

  let y = y0 + 16;
  doc.font('Helvetica').fontSize(9);
  for (const p of PEGAWAI) {
    doc.text(String(p.no), x.no, y);
    doc.text(p.nama, x.nama, y, { width: 300 });
    doc.text(p.nip, x.nip, y, { width: 84 }); // sedikit lebih sempit dari kebutuhan → digit terakhir turun baris
    y += 26;
  }
  doc.y = y + 6;
}

function penutup(doc) {
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(10).text('Surat perintah ini berlaku untuk tanggal 17 Juli 2026 dan dapat dipergunakan sebagaimana mestinya.');
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(9).text('Link eSurat: https://esurat.surabaya.go.id/upload/esign/2026/July/17/1160346/1160346_signed.pdf');
  doc.moveDown(1.5);
  doc.font('Helvetica-Bold').fontSize(10).text('Kepala Badan Kepegawaian dan Pengembangan Sumber Daya Manusia', { align: 'right' });
  doc.font('Helvetica').fontSize(10).text('Kota Surabaya', { align: 'right' });
  doc.moveDown(2);
  doc.font('Helvetica-Bold').fontSize(10).text('Drs. AGUS SETIYONO, M.Si', { align: 'right' });
  doc.font('Helvetica').fontSize(9).text('NIP. 196512031990031008', { align: 'right' });
  doc.moveDown(1);
  doc.font('Helvetica').fontSize(8).text('Tembusan:\n1. Kepala Badan Kepegawaian dan Pengembangan Sumber Daya Manusia Kota Surabaya;\n2. Yang bersangkutan.', { align: 'left' });
}

function buat(berkas, gambarTabel, judulAtas) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const aliran = fs.createWriteStream(path.join(KELUARAN, berkas));
    doc.pipe(aliran);
    gambarKop(doc);
    if (judulAtas) {
      doc.font('Helvetica-Bold').fontSize(10).text('Surabaya, 17 Juli 2026', { align: 'right' });
      doc.moveDown(0.5);
    }
    gambarTabel(doc);
    penutup(doc);
    doc.end();
    aliran.on('finish', () => resolve(path.join(KELUARAN, berkas)));
  });
}

(async () => {
  const v1 = await buat('sample-sp-v1.pdf', tabelNipDulu, true);
  const v2 = await buat('sample-sp-v2.pdf', tabelNamaDulu, true);
  const v3 = await buat('sample-sp-v3-nip-terpotong.pdf', tabelNipTerpotong, false);
  console.log('✅ Fixture dibuat:');
  for (const f of [v1, v2, v3]) console.log('   ' + f);
})();
