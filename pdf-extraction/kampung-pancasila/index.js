'use strict';
/**
 * Kampung Pancasila — modul lengkap (parse + arsip)
 *
 *   1. parsePdf(pdfPath)   → metadata surat + daftar penerima
 *   2. simpanKp(pdfPath)   → parse + simpan PDF asli ke arsip/ + metadata JSON
 *                            (idempoten: sha256 sama → tidak digandakan)
 *   3. daftarArsip()       → isi arsip (audit)
 *
 * Penyimpanan:
 *   arsip/<tanggal>_<nomor-surat>.pdf    ← PDF asli (tidak diubah)
 *   arsip/<tanggal>_<nomor-surat>.json   ← metadata + hasil ekstraksi
 *   arsip/index.json                     ← indeks semua arsip
 *
 * Catatan privasi: metadata memuat nama penandatangan (NIP) dan daftar penerima
 * → folder arsip/ di-gitignore, hanya tersimpan lokal di VPS.
 */

const fs = require('fs');
const path = require('path');
const parser = require('./parser');

const DIR_ARSIP = path.join(__dirname, 'arsip');
const FILE_INDEKS = path.join(DIR_ARSIP, 'index.json');

function namaArsip(hasil, fallback) {
  const t = hasil?.tanggalSurat || {};
  const tgl = t.iso || (t.tahun ? `${t.tahun}-tanpa-tanggal` : 'tanpa-tanggal');
  const nomor = (hasil?.nomorSurat || fallback || 'surat').replace(/[^0-9A-Za-z._\-]/g, '-');
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

/** Parse PDF tanpa menyimpan apa pun */
function parsePdf(pdfPath, opts = {}) {
  const hasil = parser.parsePdf(pdfPath, opts);
  if (!opts.simpanTeks) delete hasil.teksMentah;
  return hasil;
}

/**
 * Parse + simpan PDF ke arsip. Idempoten: PDF dengan sha256 sama tidak
 * disimpan dua kali (kembalikan entri lama dengan flag duplikat).
 */
function simpanKp(pdfPath, opts = {}) {
  if (!fs.existsSync(pdfPath)) throw new Error(`File PDF tidak ditemukan: ${pdfPath}`);
  fs.mkdirSync(DIR_ARSIP, { recursive: true });

  const hasil = parser.parsePdf(pdfPath, { simpanTeks: false, ...opts });
  delete hasil.teksMentah;
  const indeks = bacaIndeks();

  const lama = indeks.arsip.find((a) => a.sha256 === hasil.sha256);
  if (lama && !opts.paksaSimpan) {
    return { duplikat: true, file: path.join(DIR_ARSIP, lama.file), metaFile: path.join(DIR_ARSIP, lama.meta), hasil, entri: lama };
  }

  const dasar = namaArsip(hasil, `surat-${hasil.sha256.slice(0, 8)}`);
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
    jenis: hasil.jenis,
    jenisDokumen: hasil.jenisDokumen,
    nomorSurat: hasil.nomorSurat,
    tanggalSurat: hasil.tanggalSurat,
    sifat: hasil.sifat,
    lampiran: hasil.lampiran,
    perihal: hasil.perihal,
    penandatangan: hasil.penandatangan,
    peringatan: hasil.peringatan,
    pdf: hasil.pdf,
    // Isi khas per jenis dokumen
    ...(hasil.jenis === 'pergantian-personel'
      ? {
        tujuan: hasil.tujuan,
        tembusan: hasil.tembusan,
        jumlahSemula: hasil.jumlahSemula,
        jumlahMenjadi: hasil.jumlahMenjadi,
        tabel: hasil.tabel,
        perbedaan: hasil.perbedaan,
        personelDiganti: hasil.personelDiganti,
        personelBaru: hasil.personelBaru,
      }
      : {
        daftarTerlampir: hasil.daftarTerlampir,
        jumlahPenerima: hasil.jumlahPenerima,
        statistik: hasil.statistik,
        daftarPenerima: hasil.daftarPenerima,
      }),
  };
  fs.writeFileSync(tujuanMeta, JSON.stringify(meta, null, 2), 'utf-8');

  const entri = {
    file: path.relative(DIR_ARSIP, tujuanPdf),
    meta: path.relative(DIR_ARSIP, tujuanMeta),
    namaFileAsli: meta.namaFileAsli,
    disimpanPada: meta.disimpanPada,
    sha256: hasil.sha256,
    jenis: meta.jenis,
    nomorSurat: meta.nomorSurat,
    tanggalSurat: meta.tanggalSurat?.iso || null,
    perihal: meta.perihal,
    ringkas: meta.jenis === 'pergantian-personel'
      ? `${meta.jumlahSemula} → ${meta.jumlahMenjadi} pegawai (${meta.personelDiganti?.length || 0} keluar, ${meta.personelBaru?.length || 0} masuk)`
      : `${meta.jumlahPenerima} penerima`,
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

/** Ambil satu arsip lengkap berdasarkan nomor surat / tanggal / nama file / sha256 */
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
  simpanKp,
  daftarArsip,
  ambilArsip,
  // helper parser
  parseKpTeks: parser.parseKpTeks,
  kategoriPenerima: parser.kategoriPenerima,
};
