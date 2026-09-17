'use strict';
/**
 * SP WFO/WFH — Modul lengkap (parse + arsip)
 *
 * Fungsi:
 *   1. parsePdf(pdfPath)     → ekstrak NIP + NAMA (+ nomor/tgl surat, link eSurat)
 *   2. simpanSp(pdfPath)     → parse + simpan PDF asli ke sp-kantorku-wfo/arsip/
 *                              beserta metadata JSON (idempoten via sha256)
 *   3. daftarArsip()         → isi arsip (untuk audit)
 *
 * Penyimpanan:
 *   sp-kantorku-wfo/arsip/<tanggal>_<nomor-surat>.pdf   ← PDF asli (tidak diubah)
 *   sp-kantorku-wfo/arsip/<tanggal>_<nomor-surat>.json  ← metadata + hasil ekstraksi
 *   sp-kantorku-wfo/arsip/index.json                    ← indeks semua arsip
 *
 * Catatan privasi: PDF & metadata memuat NIP/NIK + nama pegawai (data
 * pribadi) → folder arsip/ di-gitignore, hanya tersimpan lokal di VPS.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const parser = require('./parser');

const DIR_ARSIP = path.join(__dirname, 'arsip');
const FILE_INDEKS = path.join(DIR_ARSIP, 'index.json');

/** Nama file arsip: 2026-07-17_800-11641-436.8.4-2026.pdf */
function namaArsip(hasil, fallback) {
  const t = hasil?.tanggalSurat || {};
  const tgl = t.iso || (t.tahun ? `${t.tahun}-tanpa-tanggal` : 'tanpa-tanggal');
  const nomor = (hasil?.nomorSurat || fallback || 'sp').replace(/[^0-9A-Za-z._\-]/g, '-');
  return `${tgl}_${nomor}`;
}

function bacaIndeks() {
  try {
    return JSON.parse(fs.readFileSync(FILE_INDEKS, 'utf-8'));
  } catch {
    return { jumlah: 0, arsip: [] };
  }
}

function tulisIndeks(indeks) {
  indeks.jumlah = indeks.arsip.length;
  indeks.terakhirDiperbarui = new Date().toISOString();
  fs.writeFileSync(FILE_INDEKS, JSON.stringify(indeks, null, 2), 'utf-8');
}

/**
 * Parse PDF tanpa menyimpan apa pun.
 * @param {string} pdfPath
 * @param {{simpanTeks?: boolean}} [opts]
 */
function parsePdf(pdfPath, opts = {}) {
  const hasil = parser.parseSp(pdfPath, opts);
  if (!opts.simpanTeks) delete hasil.teksMentah;
  return hasil;
}

/**
 * Parse + simpan PDF ke arsip. Idempoten: PDF dengan sha256 sama tidak
 * disimpan dua kali (kembalikan entri lama dengan flag duplikat).
 *
 * @param {string} pdfPath
 * @param {{simpanTeks?: boolean, paksaSimpan?: boolean}} [opts]
 * @returns {{duplikat: boolean, file: string, metaFile: string, hasil: object}}
 */
function simpanSp(pdfPath, opts = {}) {
  if (!fs.existsSync(pdfPath)) throw new Error(`File PDF tidak ditemukan: ${pdfPath}`);
  fs.mkdirSync(DIR_ARSIP, { recursive: true });

  const hasil = parsePdf(pdfPath, { simpanTeks: true, ...opts });
  const indeks = bacaIndeks();

  // Sudah pernah diarsipkan?
  const lama = indeks.arsip.find((a) => a.sha256 === hasil.sha256);
  if (lama && !opts.paksaSimpan) {
    return { duplikat: true, file: lama.file, metaFile: lama.meta, hasil, entri: lama };
  }

  const dasar = namaArsip(hasil, `sp-${hasil.sha256.slice(0, 8)}`);
  let namaPdf = `${dasar}.pdf`;
  let n = 2;
  while (fs.existsSync(path.join(DIR_ARSIP, namaPdf)) && !lama) {
    namaPdf = `${dasar}-${n++}.pdf`;
  }

  const tujuanPdf = path.join(DIR_ARSIP, namaPdf);
  const tujuanMeta = tujuanPdf.replace(/\.pdf$/i, '.json');

  fs.copyFileSync(pdfPath, tujuanPdf);

  const meta = {
    namaFileAsli: path.basename(pdfPath),
    disimpanPada: new Date().toISOString(),
    sha256: hasil.sha256,
    nomorSurat: hasil.nomorSurat,
    tanggalSurat: hasil.tanggalSurat,
    linkEsurat: hasil.linkEsurat,
    jumlahPegawai: hasil.jumlahPegawai,
    jumlahAsn: hasil.jumlahAsn,
    jumlahNonAsn: hasil.jumlahNonAsn,
    peringatan: hasil.peringatan,
    pdf: hasil.pdf,
    pegawai: hasil.pegawai,
  };
  fs.writeFileSync(tujuanMeta, JSON.stringify(meta, null, 2), 'utf-8');

  const entri = {
    file: path.relative(DIR_ARSIP, tujuanPdf),
    meta: path.relative(DIR_ARSIP, tujuanMeta),
    namaFileAsli: meta.namaFileAsli,
    disimpanPada: meta.disimpanPada,
    sha256: hasil.sha256,
    nomorSurat: meta.nomorSurat,
    tanggalSurat: meta.tanggalSurat?.iso || null,
    jumlahPegawai: meta.jumlahPegawai,
  };
  indeks.arsip = indeks.arsip.filter((a) => a.sha256 !== hasil.sha256);
  indeks.arsip.push(entri);
  tulisIndeks(indeks);

  return { duplikat: false, file: tujuanPdf, metaFile: tujuanMeta, hasil, entri };
}

/** Daftar isi arsip (terbaru dulu) */
function daftarArsip() {
  const indeks = bacaIndeks();
  return {
    ...indeks,
    arsip: [...indeks.arsip].sort((a, b) => String(b.disimpanPada).localeCompare(String(a.disimpanPada))),
  };
}

/** Ambil satu arsip lengkap (termasuk daftar pegawai) berdasarkan nomor surat / tanggal / file */
function ambilArsip(kunci) {
  const indeks = bacaIndeks();
  const entri = indeks.arsip.find(
    (a) => a.sha256 === kunci
      || a.file === kunci
      || a.nomorSurat === kunci
      || a.tanggalSurat === kunci
      || path.basename(a.file, '.pdf') === kunci
  );
  if (!entri) return null;
  const meta = JSON.parse(fs.readFileSync(path.join(DIR_ARSIP, entri.meta), 'utf-8'));
  return { entri, meta, pdfPath: path.join(DIR_ARSIP, entri.file) };
}

module.exports = {
  DIR_ARSIP,
  parsePdf,
  simpanSp,
  daftarArsip,
  ambilArsip,
  // re-export helper parser
  parseSpTeks: parser.parseSpTeks,
  parsePegawai: parser.parsePegawai,
  parseTanggalIndonesia: parser.parseTanggalIndonesia,
  ekstrakTeks: parser.ekstrakTeks,
};
