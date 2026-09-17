'use strict';
/**
 * pdf-extraction/lib/pdf-teks.js — helper bersama untuk semua modul ekstraksi
 * di folder pdf-extraction/ (SP KantorKu WFO, Kampung Pancasila, dst).
 *
 * Isi: ekstraksi teks via poppler (`pdftotext`/`pdfinfo`), parsing tanggal
 * Indonesia, dan pencarian nomor surat. Semuanya deterministik — tanpa LLM.
 *
 * Catatan: helper di sini murni "teks & tanggal". Logika khas tiap jenis surat
 * (daftar pegawai vs daftar penerima) tetap di parser masing-masing modul.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');

// =============== BULAN ===============

const BULAN_MAP = {
  januari: 1, februari: 2, maret: 3, april: 4, mei: 5, juni: 6,
  juli: 7, agustus: 8, september: 9, oktober: 10, november: 11, desember: 12,
  jan: 1, feb: 2, mar: 3, jun: 6, jul: 7, agt: 8, agu: 8, aug: 8,
  sep: 9, sept: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12,
};
const NAMA_BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

// =============== UTIL ===============

const rapikan = (s) => String(s == null ? '' : s).replace(/[ \t]+/g, ' ').trim();
const pad2 = (n) => String(n).padStart(2, '0');

/** Bersihkan nilai kolom: buang tanda pipa/garis tabel di ujung */
function bersihkanKolom(s) {
  return String(s || '')
    .replace(/^[\s|]+|[\s|]+$/g, '')
    .replace(/^[:\-–—]+/, '')
    .replace(/[|]+$/g, '')
    .trim();
}

/** Bersihkan nilai yang cuma berisi tanda kosong ("-", "—", "/") */
function nilaiBersih(v) {
  const t = rapikan(v);
  return !t || /^[-–—/.\s]+$/.test(t) ? null : t;
}

// =============== EKSTRAKSI TEKS PDF ===============

const DEFAULT_EKSTRAK = { layout: true, minPanjangTeks: 120 };

/**
 * Jalankan pdftotext untuk mengambil layer teks PDF.
 * @throws {Error} err.code = 'PDF_TIDAK_ADA' | 'PERLU_OCR' | 'PDFTOTEXT_GAGAL'
 */
function ekstrakTeks(pdfPath, opts = {}) {
  const { layout, minPanjangTeks } = { ...DEFAULT_EKSTRAK, ...opts };

  if (!pdfPath || !fs.existsSync(pdfPath)) {
    const err = new Error(`File PDF tidak ditemukan: ${pdfPath}`);
    err.code = 'PDF_TIDAK_ADA';
    throw err;
  }

  const args = ['-enc', 'UTF-8'];
  if (layout) args.push('-layout');
  args.push(pdfPath, '-');

  let out;
  try {
    out = execFileSync('pdftotext', args, { maxBuffer: 32 * 1024 * 1024 }).toString('utf-8');
  } catch (err) {
    const e = new Error(`Gagal mengekstrak teks PDF (pdftotext): ${err.message}`);
    e.code = 'PDFTOTEXT_GAGAL';
    throw e;
  }

  const teks = out.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
  if (teks.replace(/\s/g, '').length < minPanjangTeks) {
    const err = new Error(
      'PDF ini tidak punya layer teks (kemungkinan hasil scan/foto) — parser butuh OCR.'
    );
    err.code = 'PERLU_OCR';
    throw err;
  }
  return teks;
}

/** Info singkat PDF (jumlah halaman, producer, dll) — tanpa ekstraksi teks */
function infoPdf(pdfPath) {
  try {
    const out = execFileSync('pdfinfo', [pdfPath], { maxBuffer: 8 * 1024 * 1024 }).toString('utf-8');
    const get = (k) => (out.match(new RegExp(`^${k}:\\s*(.+)$`, 'mi')) || [])[1]?.trim() || null;
    return {
      halaman: Number(get('Pages')) || null,
      ukuran: get('Page size'),
      aplikasi: get('Producer'),
      terenkripsi: /yes/i.test(get('Encrypted') || 'no'),
    };
  } catch {
    return { halaman: null, ukuran: null, aplikasi: null, terenkripsi: null };
  }
}

// =============== TANGGAL ===============

/** Parse tanggal Indonesia → { iso, display, sumber } */
function parseTanggalIndonesia(str, opts = {}) {
  if (!str) return null;

  // "17 Juli 2026" / "17 Juli"
  let m = String(str).match(/(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?/);
  if (m) {
    const bln = BULAN_MAP[m[2].toLowerCase()];
    if (bln) {
      const th = m[3] || String(opts.tahunDefault || new Date().getFullYear());
      return {
        iso: `${th}-${pad2(bln)}-${pad2(m[1])}`,
        display: `${Number(m[1])} ${NAMA_BULAN[bln - 1]} ${th}`,
        sumber: opts.sumber || 'teks',
      };
    }
  }

  // "17-07-2026" / "17/07/2026" (asumsi dd-mm-yyyy)
  m = String(str).match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/);
  if (m) {
    return {
      iso: `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`,
      display: `${Number(m[1])} ${NAMA_BULAN[Number(m[2]) - 1] || m[2]} ${m[3]}`,
      sumber: opts.sumber || 'teks',
    };
  }
  return null;
}

// =============== NOMOR SURAT ===============

/** Pola token nomor surat: "800/12528/436.8.4/2026" atau "100.3.5/____/436.8.4/2026" */
const POLA_NOMOR = /^\d[\dA-Za-z._\-]*(?:\/[\dA-Za-z._\-]+){2,4}$/;

/**
 * Cari token nomor surat di satu baris. Token dipisah spasi lalu digabung lagi
 * supaya format "800 / 12528 / 436.8.4 / 2026" ikut terbaca; kandidat terpanjang
 * yang lolos pola dipakai (mencegah "100.3.5/…" terpotong jadi "3.5/…").
 */
function cariTokenNomorDiBaris(baris) {
  const token = baris.split(/[ \t]+/).filter(Boolean)
    .map((t) => t.replace(/^[^0-9A-Za-z]+/, '').replace(/[^0-9A-Za-z._\-/]+$/, ''));

  let terbaik = null;
  for (let i = 0; i < token.length; i++) {
    let gabung = '';
    for (let j = i; j < token.length && j < i + 9; j++) {
      gabung += token[j];
      const kandidat = gabung.replace(/[^0-9A-Za-z._\-/]/g, '');
      if (POLA_NOMOR.test(kandidat) && (!terbaik || kandidat.length > terbaik.length)) {
        terbaik = kandidat;
      }
    }
  }
  return terbaik;
}

/** Nomor surat: baris ber-"nomor" dulu, lalu baris mana pun yang berpola */
function deteksiNomorSurat(teks) {
  const baris = String(teks).split('\n');

  for (const b of baris) {
    if (!/\b(nomor|no)\b/i.test(b)) continue;
    const token = cariTokenNomorDiBaris(b);
    if (token) return token;
  }
  for (const b of baris) {
    const token = cariTokenNomorDiBaris(b);
    if (token) return token;
  }
  return null;
}

/**
 * Parse teks XML (keluaran `pdftohtml -xml`) → elemen per halaman.
 * Dipisah dari ekstrakElemen() supaya bisa diuji tanpa file PDF (fixture XML).
 */
function parseElemenXml(teksXml) {
  const halaman = [];
  const potongan = String(teksXml).split(/<page\b/).slice(1);
  for (const bagian of potongan) {
    const elemen = [];
    const re = /<text\s+top="(-?\d+)"\s+left="(-?\d+)"\s+width="(\d+)"\s+height="(\d+)"\s+font="(\d+)"\s*>([\s\S]*?)<\/text>/g;
    let m;
    while ((m = re.exec(bagian)) !== null) {
      const teks = m[6]
        .replace(/<[^>]+>/g, '')
        .replace(/&#34;/g, '"').replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
      if (!teks) continue;
      elemen.push({ top: Number(m[1]), left: Number(m[2]), w: Number(m[3]), h: Number(m[4]), font: Number(m[5]), teks });
    }
    halaman.push(elemen);
  }
  return { halaman };
}

/**
 * Ekstraksi BERBASIS KOORDINAT: kembalikan tiap potongan teks beserta posisinya.
 *
 * Dipakai untuk dokumen dengan TABEL yang sel-selnya menempel (jarak antar sel ≈ 0
 * sehingga `pdftotext -layout` menulis "NIPJABATAN" tanpa pemisah). Dengan
 * `pdftohtml -xml` (poppler) setiap sel tetap punya `left`/`width`, jadi kolom
 * bisa dipisahkan berdasar posisi — bukan menebak dari spasi.
 *
 * @returns {{halaman: Array<Array<{top,left,w,h,font,teks}>>}}
 */
function ekstrakElemen(pdfPath, opts = {}) {
  if (!pdfPath || !fs.existsSync(pdfPath)) {
    const err = new Error(`File PDF tidak ditemukan: ${pdfPath}`);
    err.code = 'PDF_TIDAK_ADA';
    throw err;
  }

  const args = ['-xml', '-stdout', '-i', '-hidden'];
  if (opts.halaman) args.push('-f', String(opts.halaman), '-l', String(opts.halaman));
  args.push(pdfPath);

  let keluar;
  try {
    keluar = execFileSync('pdftohtml', args, { maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf-8');
  } catch (err) {
    const e = new Error(`Gagal mengekstrak koordinat PDF (pdftohtml): ${err.message}`);
    e.code = 'PDFTOHTML_GAGAL';
    throw e;
  }

  return parseElemenXml(keluar);
}

/** Lebar relatif karakter (perkiraan Helvetica) untuk memetakan teks → posisi x */
function lebarKarakter(c) {
  if (c === ' ') return 0.278;
  if (/[0-9]/.test(c)) return 0.556;
  if (/[A-Z]/.test(c)) return 'MW'.includes(c) ? 0.92 : 'IJ'.includes(c) ? 0.3 : 0.7;
  if (/[ilj]/.test(c)) return 0.25;
  if (/[mw]/.test(c)) return 0.78;
  if (/[.,:;'!|]/.test(c)) return 0.28;
  return 0.53;
}

/**
 * Perkirakan posisi x (pusat) sebuah potongan teks di dalam elemen, memakai
 * proporsi lebar karakter. Dipakai hanya untuk menentukan kolom mana sebuah
 * kata berada — toleransi beberapa poin tidak masalah.
 */
function posisiKata(elemen, teksTarget, mulaiIndeks) {
  const teks = elemen.teks;
  const lebar = (s) => [...s].reduce((a, c) => a + lebarKarakter(c), 0);
  const total = lebar(teks) || 1;
  const sebelum = lebar(teks.slice(0, mulaiIndeks));
  const ini = lebar(teksTarget);
  return elemen.left + elemen.w * ((sebelum + ini / 2) / total);
}

module.exports = {
  BULAN_MAP,
  NAMA_BULAN,
  rapikan,
  pad2,
  bersihkanKolom,
  nilaiBersih,
  ekstrakTeks,
  ekstrakElemen,
  parseElemenXml,
  infoPdf,
  parseTanggalIndonesia,
  POLA_NOMOR,
  cariTokenNomorDiBaris,
  deteksiNomorSurat,
  posisiKata,
};
