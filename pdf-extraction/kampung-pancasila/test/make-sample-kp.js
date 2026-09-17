'use strict';
/**
 * Generator PDF contoh surat Kampung Pancasila (FIXTURE TEST) — bukan data asli.
 *
 *   node pdf-extraction/kampung-pancasila/test/make-sample-kp.js
 *   → test/sample-kp.pdf
 *
 * Yang SENGAJA ditiru dari surat asli (supaya regresi ketahuan):
 *   - blok Nomor/Sifat/Lampiran/Hal, dengan perihal terpotong 3 baris;
 *   - daftar ketentuan bernomor di badan surat (harus DIABAIKAN);
 *   - blok tanda tangan elektronik + footer yang DIULANG di setiap halaman;
 *   - daftar penerima yang TERPUTUS di akhir halaman lalu LANJUT di halaman
 *     berikutnya (bug nyata: dulu daftar berhenti di item 36/66);
 *   - satu nama penerima yang terpotong ke baris berikutnya.
 */

const path = require('path');
const PDFDocument = require('pdfkit');

const KELUARAN = path.join(__dirname, 'sample-kp.pdf');

const KOP = [
  'PEMERINTAH KOTA SURABAYA',
  'BADAN KEPEGAWAIAN DAN PENGEMBANGAN SUMBER DAYA MANUSIA',
  'Jalan Jimerto 25 - 27 Lt. III Surabaya 60272',
];

const META = [
  ['Nomor', ': 800/99999/436.8.4/2026'],
  ['Sifat', ': Biasa / Terbuka'],
  ['Lampiran', ': -'],
  ['Hal', ': Mekanisme Usulan Perubahan Data'],
  ['', 'Personel Program Kampung Pancasila'],
  ['', 'Tahun Anggaran Berjalan'],
];

const PENERIMA = [
  { no: 1, nama: 'Sekretaris DPRD' },
  { no: 2, nama: 'Inspektur' },
  { no: 3, nama: 'Kepala Dinas Pemberdayaan Perempuan dan Perlindungan Anak Serta Pengendalian Penduduk dan Keluarga Berencana' },
  { no: 4, nama: 'Kepala Bagian Organisasi' },
  { no: 5, nama: 'Direktur RSUD Contoh Sejahtera' },
  { no: 6, nama: 'Camat Contoh Satu' },
  { no: 7, nama: 'Camat Contoh Dua' },
  { no: 8, nama: 'Camat Contoh Tiga' },
];

const TTD = [
  'Surat ini Ditandatangani Elektronik Oleh :',
  'KEPALA BADAN,',
  'CONTOH NAMA PEJABAT, SH, MH',
  'Pembina Utama Muda / IV/c',
  'NIP. 196910171993032006',
];

const FOOTER = [
  '- Dokumen ini telah ditandatangani secara elektronik menggunakan sertifikat elektronik yang diterbitkan BSrE',
  '- UU ITE No 11 Tahun 2008 Pasal 5 Ayat 1',
  '  "Informasi Elektronik dan/atau Dokumen Elektronik dan/atau hasil cetaknya merupakan alat bukti hukum yang sah"',
];

/** Gambar baris teks pada koordinat absolut (kontrol penuh atas layout) */
function baris(doc, teks, x, y, opts = {}) {
  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 10);
  doc.text(teks, x, y, opts.width ? { width: opts.width } : undefined);
}

function buatPdf() {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const aliran = require('fs').createWriteStream(KELUARAN);
    doc.pipe(aliran);

    let y = 45;
    // ---- kop ----
    for (const k of KOP) { baris(doc, k, 40, y, { width: 515, align: 'center', bold: k !== KOP[2], size: k === KOP[0] ? 12 : 10 }); y += 16; }
    y += 14;
    baris(doc, 'Surabaya, 29 Juli 2026', 40, y, { width: 515, align: 'right' }); y += 30;

    // ---- blok Nomor/Sifat/Lampiran/Hal ----
    for (const [label, nilai] of META) {
      baris(doc, label, 40, y);
      baris(doc, nilai, 130, y);
      y += 16;
    }
    y += 10;

    // ---- badan surat (berisi daftar ketentuan bernomor — harus diabaikan) ----
    baris(doc, 'Yth. (Daftar Nama Terlampir)', 40, y); y += 16;
    baris(doc, 'di -', 60, y); y += 14;
    baris(doc, 'Surabaya', 70, y); y += 24;
    baris(doc, 'Dalam rangka tertib administrasi pengelolaan data personel,', 40, y); y += 14;
    baris(doc, 'bersama ini disampaikan ketentuan sebagai berikut:', 40, y); y += 20;
    baris(doc, '1. Koordinator Kecamatan', 60, y); y += 14;
    baris(doc, '2. Koordinator Kelurahan', 60, y); y += 14;
    baris(doc, '3. Koordinator RW', 60, y); y += 14;
    baris(doc, '4. ASN Pendamping', 60, y); y += 30;

    // ---- ttd + footer halaman 1 ----
    let ys = y;
    for (const t of TTD) { baris(doc, t, 300, ys, { size: 9, width: 255, align: 'right' }); ys += 13; }
    ys += 10;
    for (const f of FOOTER) { baris(doc, f, 40, ys, { size: 7 }); ys += 10; }

    // ---- halaman 2: lampiran daftar penerima ----
    doc.addPage();
    let y2 = 45;
    baris(doc, 'Lampiran Daftar Penerima Surat', 40, y2, { width: 515, align: 'right' }); y2 += 14;
    baris(doc, 'Tanggal          :    29 Juli 2026', 380, y2, { size: 9 }); y2 += 12;
    baris(doc, 'Nomor            :    800/99999/436.8.4/2026', 380, y2, { size: 9 }); y2 += 26;
    baris(doc, 'Kepada Yth.', 40, y2); y2 += 24;

    // Item 1-4 di halaman 2
    for (const p of PENERIMA.slice(0, 4)) {
      baris(doc, `${p.no}.`, 40, y2);
      if (p.nama.length > 60) {
        baris(doc, p.nama, 70, y2, { width: 300 });  // nama panjang → wrap
      } else {
        baris(doc, p.nama, 70, y2);
      }
      y2 += p.nama.length > 60 ? 30 : 18;
    }

    // ttd + footer di AKHIR halaman 2 (daftar masih lanjut di halaman 3!)
    let ys2 = y2 + 20;
    for (const t of TTD) { baris(doc, t, 300, ys2, { size: 9, width: 255, align: 'right' }); ys2 += 13; }
    ys2 += 10;
    for (const f of FOOTER) { baris(doc, f, 40, ys2, { size: 7 }); ys2 += 10; }

    // ---- halaman 3: lanjutan daftar (tanpa header) ----
    doc.addPage();
    let y3 = 45;
    for (const p of PENERIMA.slice(4)) {
      baris(doc, `${p.no}.`, 40, y3);
      baris(doc, p.nama, 70, y3);
      y3 += 18;
    }
    y3 += 20;
    for (const t of TTD) { baris(doc, t, 300, y3, { size: 9, width: 255, align: 'right' }); y3 += 13; }

    doc.end();
    aliran.on('finish', () => resolve(KELUARAN));
  });
}

(async () => {
  const f = await buatPdf();
  console.log('✅ Fixture dibuat: ' + f);
  console.log('   Harapan hasil parse: nomor 800/99999/436.8.4/2026 | 29 Juli 2026 | 8 penerima (7 Perangkat Daerah + 3 Kecamatan… cek statistik)');
})();
