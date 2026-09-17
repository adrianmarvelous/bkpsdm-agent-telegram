'use strict';
/**
 * SP WFO/WFH Parser — ekstraksi data dari PDF Surat Perintah (SP) Work From Home
 *
 * Tujuan: ambil NIP + NAMA pegawai (dan nomor/tanggal surat + link eSurat) dari
 * PDF SP, supaya automasi KantorKu tidak lagi memakai nilai hardcode
 * (sebelumnya nomor surat/tgl/link SP di-hardcode di index.js dan sudah basi).
 *
 * Mesin ekstraksi: `pdftotext -layout` (paket poppler-utils, sudah terpasang
 * di VPS) — TIDAK perlu dependency npm baru. PDF hasil scan (gambar) tidak
 * punya layer teks → parser melempar error code PERLU_OCR (OCR belum termasuk
 * di modul ini).
 *
 * Dipakai oleh:
 *   - cli.js                     → uji cepat dari terminal
 *   - index.js                   → API parseSp() + simpanSp()
 *   - automated-kantorku-wfh/index.js (nanti: isi form dari SP, bukan hardcode)
 */

const fs = require('fs');

// Helper bersama antar-modul pdf-extraction (teks PDF, tanggal, nomor surat).
// Definisi aslinya ada di ../lib/pdf-teks.js supaya tidak digandakan.
const {
  BULAN_MAP,
  NAMA_BULAN,
  rapikan,
  pad2,
  bersihkanKolom,
  nilaiBersih,
  ekstrakTeks,
  infoPdf,
  parseTanggalIndonesia,
  deteksiNomorSurat,
  cariTokenNomorDiBaris,
} = require('../lib/pdf-teks');

// =============== KONSTANTA ===============

/** Baris yang bukan data pegawai (header/footer surat) */
const KATA_ABAIKAN = /^(no\.?|nomor|nama|nip|nik|jabatan|keterangan|tembusan|lampiran|halaman|salinan|tentang|kepala\s+badan|badan\s+kepegawaian|pemerintah\s+kota|surabaya|untuk|kepada|memerintahkan|dengan\s+ini|menyatakan|diberikan|mulai|sampai|catatan|ttd|ditandatangani)\b/i;

const DEFAULT_OPTS = {
  layout: true,        // pakai `pdftotext -layout` (jaga kolom tabel)
  gabungNamaWrap: true, // gabung nama yang terpotong ke baris berikutnya
  minPanjangTeks: 120,  // di bawah ini dianggap PDF scan (tidak ada layer teks)
};

// =============== EKSTRAKSI TEKS / UTIL / NOMOR SURAT ===============
// ekstrakTeks(), infoPdf(), rapikan(), pad2(), bersihkanKolom(), nilaiBersih(),
// POLA_NOMOR, cariTokenNomorDiBaris(), deteksiNomorSurat(), dan
// parseTanggalIndonesia() sekarang dipakai dari ../lib/pdf-teks.js (lihat import
// di atas) — dulu digandakan di sini dan berisiko menyimpang satu sama lain.

// =============== TANGGAL SURAT ===============

/**
 * Tanggal surat. Urutan prioritas:
 *  1. "Surabaya, 17 Juli 2026" — paling andal
 *  2. "Tanggal : …" yang berada di blok kepala surat (dalam 4 baris dari baris
 *     "Nomor : …"). Ini penting: frasa "Tanggal : 11 September 2026" pada blok
 *     kegiatan ("Hari : Jumat / Tanggal : …") BUKAN tanggal surat.
 *  3. dari path link eSurat (…/2026/July/17/…)
 *  4. hanya tahun dari nomor surat
 */
function deteksiTanggalSurat(teks, opts = {}) {
  const { linkEsurat, nomorSurat } = opts;
  const baris = teks.split('\n');

  // (1) "Surabaya, <tanggal>" — coba SEMUA kemunculan (kop "PEMERINTAH KOTA
  //     SURABAYA" & kalimat "…Kota Surabaya, dengan ini menugaskan…" tidak
  //     berisi tanggal, jadi harus dilewati, bukan bikin gagal total).
  const reSby = /Surabaya\s*,\s*([^\n]{0,40})/gi;
  let mSby;
  while ((mSby = reSby.exec(teks)) !== null) {
    const sebaris = mSby[1] || '';
    const duaBaris = teks.slice(mSby.index, mSby.index + 70);
    const t = parseTanggalIndonesia(sebaris) || parseTanggalIndonesia(duaBaris);
    if (t) return t;
  }

  // (2) "Tanggal :" yang menempel pada baris NOMOR SURAT. Hanya baris yang benar
  //     berisi token nomor surat yang dihitung — supaya "Jalan Tunjungan Nomor
  //     1-3" atau nomor surat lain (referensi "Dasar") tidak dianggap kepala surat.
  const idxNomor = [];
  baris.forEach((b, i) => {
    const token = cariTokenNomorDiBaris(b);
    if (!token) return;
    if (nomorSurat && token !== nomorSurat) return; // hanya nomor surat ini sendiri
    idxNomor.push(i);
  });
  for (const iN of idxNomor) {
    for (let j = Math.max(0, iN - 4); j <= Math.min(baris.length - 1, iN + 4); j++) {
      const m = baris[j].match(/\btanggal\s*[:.]\s*([^\n]{4,40})/i);
      if (!m) continue;
      const t = parseTanggalIndonesia(m[1]);
      if (t) return t;
    }
  }

  // (3) dari link eSurat → /2026/July/17/
  if (linkEsurat) {
    const m = linkEsurat.match(/\/(\d{4})\/([A-Za-z]+)\/(\d{1,2})\//);
    if (m) {
      const bln = BULAN_MAP[m[2].toLowerCase()];
      if (bln) {
        return {
          iso: `${m[1]}-${pad2(bln)}-${pad2(m[3])}`,
          display: `${Number(m[3])} ${NAMA_BULAN[bln - 1]} ${m[1]}`,
          sumber: 'link-esurat',
        };
      }
    }
  }

  // (4) hanya tahun dari nomor surat (tanggal tidak lengkap di PDF)
  const th = String(nomorSurat || '').match(/\/(20\d{2})\b/)?.[1];
  if (th) return { iso: null, display: null, tahun: th, sumber: 'nomor-surat' };
  return null;
}

/**
 * Blok kegiatan ("Hari : Jumat / Tanggal : 11 September 2026") — dipakai bot
 * untuk mengusulkan tanggal, TAPI tidak boleh dikira tanggal surat.
 */
function deteksiKegiatan(teks) {
  const baris = teks.split('\n');
  for (let i = 0; i < baris.length; i++) {
    const mHari = baris[i].match(/\bhari\s*[:.]\s*([A-Za-z]{3,10})/i);
    if (!mHari) continue;
    for (let j = i; j <= i + 4 && j < baris.length; j++) {
      const mTgl = baris[j].match(/\btanggal\s*[:.]\s*([^\n]{4,40})/i);
      if (!mTgl) continue;
      const t = parseTanggalIndonesia(mTgl[1]);
      if (t) return { hari: mHari[1], tanggal: t.iso, display: t.display };
    }
  }
  return null;
}

// =============== LINK ESURAT ===============

/**
 * Rekatkan URL yang terpotong jadi beberapa baris oleh PDF writer
 * (mis. "…/upload/" + "esign/2026/…/1160346_signed.pdf").
 * Hanya menggabung baris yang isinya murni karakter URL tanpa spasi.
 */
function rekatkanUrlBaris(teks) {
  const baris = teks.split('\n');
  const keluar = [];
  for (let i = 0; i < baris.length; i++) {
    let b = baris[i].trim();
    if (/esurat|https?:\/\//i.test(b)) {
      while (i + 1 < baris.length) {
        const next = baris[i + 1].trim();
        if (!next) break;
        if (/\s/.test(next)) break;                  // ada spasi → bukan potongan URL
        if (!/^[A-Za-z0-9._\-\/]+$/.test(next)) break;
        if (!/[\/.]/.test(next)) break;
        b += next;
        i++;
      }
    }
    keluar.push(b);
  }
  return keluar.join('\n');
}

/** Cari link eSurat / PDF e-sign (dengan atau tanpa http://) */
function deteksiLinkEsurat(teks) {
  const bersih = rekatkanUrlBaris(teks).replace(/[\s\u00a0]+/g, ' ');

  const kandidat = bersih.match(/(?:https?:\/\/)?[a-z0-9.\-]*esurat[a-z0-9.\-]*\.go\.id\/[^\s<>"')]+/gi) || [];
  if (kandidat.length) {
    const url = kandidat[0].replace(/[.,;]+$/, '');
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
  }

  // Fallback: URL apa pun yang berakhiran .pdf
  const pdfUrl = bersih.match(/(?:https?:\/\/)?[a-z0-9.\-/]*\/[^\s<>"')]+\.pdf/gi) || [];
  if (pdfUrl.length) {
    const url = pdfUrl[0].replace(/[.,;]+$/, '');
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
  }
  return null;
}

// =============== URUTAN KOLOM ===============

/**
 * Cek header tabel: "NO | NIP | NAMA | JABATAN" vs "NO | NAMA | NIP".
 * @returns {boolean} true = kolom NAMA mendahului NIP
 */
function namaMendahuluiNip(teks) {
  for (const b of teks.split('\n')) {
    const iNama = b.search(/\bNAMA\b/i);
    const iNip = b.search(/\bNIP\b|\bNIK\b/i);
    if (iNama >= 0 && iNip >= 0) return iNama < iNip;
  }
  return false; // default SP pegawai: NO | NIP | NAMA | JABATAN
}

// =============== BARIS PEGAWAI ===============

/**
 * Validasi ringan pola NIP/NIK (soft — hanya jadi peringatan, bukan penolakan):
 *  - 18 digit (ASN): YYYYMMDD + 10 digit → tahun 1930-2015, bulan 1-12, tanggal 1-31
 *  - 16 digit (Non-ASN/NIK): 6 digit wilayah + DDMMYY + 4 digit
 */
function validasiNip(nip) {
  if (nip.length === 18) {
    const th = Number(nip.slice(0, 4));
    const bl = Number(nip.slice(4, 6));
    const tg = Number(nip.slice(6, 8));
    return th >= 1930 && th <= 2015 && bl >= 1 && bl <= 12 && tg >= 1 && tg <= 31;
  }
  if (nip.length === 16) {
    const tg = Number(nip.slice(6, 8));
    const bl = Number(nip.slice(8, 10));
    return tg >= 1 && tg <= 31 && bl >= 1 && bl <= 12;
  }
  return false;
}

/** Peta posisi: string tanpa spasi → indeks karakter di baris asli */
function petakan(baris) {
  const chars = [];
  const idx = [];
  for (let i = 0; i < baris.length; i++) {
    if (/[ \t]/.test(baris[i])) continue;
    chars.push(baris[i]);
    idx.push(i);
  }
  return { rapat: chars.join(''), idx };
}

/**
 * Ambil NIP/NIK dari satu baris tabel.
 *
 * Dua tahap:
 *  1. Pola langsung di baris asli — kasus normal (NIP dipisah spasi dari kolom lain).
 *  2. Kalau gagal (NIP dipecah spasi oleh layout PDF): rapatkan spasi, lalu cari
 *     deret digit dengan panjang PERSIS 16/18. Deret dengan panjang lain
 *     (17, 19, 20+) tidak dipakai — itu tanda NIP terpotong/menempel, dan
 *     memaksakan tebakan justru menghasilkan NIP palsu.
 *
 * @returns {null|{nip, jenis, valid, mulai, akhir}|{nip: null, curiga: string[]}}
 */
function ambilNipDariBaris(baris) {
  // Tahap 1 — pola langsung
  const langsung = baris.match(/(?<!\d)(\d{16}|\d{18})(?!\d)/);
  if (langsung) {
    return {
      nip: langsung[1],
      jenis: langsung[1].length === 18 ? 'ASN' : 'NON-ASN',
      valid: validasiNip(langsung[1]),
      mulai: langsung.index,
      akhir: langsung.index + langsung[1].length,
    };
  }

  // Tahap 2 — rapatkan spasi, cari deret digit panjang persis 16/18
  const { rapat, idx } = petakan(baris);
  const curiga = [];
  const deret = [...rapat.matchAll(/(?<!\d)\d{15,}/g)];
  for (const d of deret) {
    const s = d[0];
    const panjangLazim = s.length === 16 || s.length === 18;
    const cocokPola = s.length === 16 ? true : validasiNip(s); // 18 digit wajib lolos pola NIP
    if (!panjangLazim || !cocokPola) {
      curiga.push(`${s} (${s.length} digit${panjangLazim ? ', pola tidak wajar' : ''})`);
      continue;
    }
    return {
      nip: s,
      jenis: s.length === 18 ? 'ASN' : 'NON-ASN',
      valid: validasiNip(s),
      mulai: idx[d.index],
      akhir: idx[d.index + s.length - 1] + 1,
    };
  }
  if (curiga.length) return { nip: null, curiga };
  return null;
}

/** Pecah baris jadi kolom (pemisah: 2+ spasi atau pipa tabel) + posisi tiap kolom */
function potongKolom(teks, offsetAbs) {
  const kolom = [];
  const re = /(?:\s{2,}|\s*\|\s*)/g;
  let idx = 0;
  let m;
  while ((m = re.exec(teks)) !== null) {
    const bagian = teks.slice(idx, m.index);
    if (bagian.trim()) {
      kolom.push({ teks: bersihkanKolom(bagian), mulai: offsetAbs + idx + (bagian.length - bagian.trimStart().length) });
    }
    idx = m.index + m[0].length;
  }
  const sisa = teks.slice(idx);
  if (sisa.trim()) {
    kolom.push({ teks: bersihkanKolom(sisa), mulai: offsetAbs + idx + (sisa.length - sisa.trimStart().length) });
  }
  // buang kolom nomor urut & sisa label kolom
  return kolom
    .filter((c) => c.teks && !/^\d{1,3}\.?$/.test(c.teks))
    .map((c) => ({ ...c, teks: c.teks.replace(/^(nip|nik)[.,:]?$/i, '') }))
    .filter((c) => c.teks);
}

// =============== FORMAT BLOK LABEL ===============
//
// Format lampiran banyak SP BKPSDM (bukan tabel), contoh nyata:
//
//   1. Nama        : Fahrur Rozi, SE
//     Pangkat/Gol : Penata Muda Tingkat I / III/b
//     NIP / NIK    : 197105292009011001
//     Jabatan      : Staf Tim Kerja Pengembangan Kompetensi Teknis
//
// Label dinormalisasi (buang non-huruf, uppercase): "NIP / NIK" → "NIPNIK".

/** "NIP / NIK" → "NIPNIK" */
function normalisasiLabel(s) {
  return String(s).replace(/[^A-Za-z]/g, '').toUpperCase();
}

/** Baca baris berlabel "Label : nilai" (nomor urut daftar "1. " dibuang) */
function bacaLabel(baris) {
  const mNomor = baris.match(/^\s*(\d{1,3})[.)]\s+(?=\S)/);
  const isi = mNomor ? baris.slice(mNomor[0].length) : baris;
  const m = isi.match(/^\s*([A-Za-z][A-Za-z\s/.\-]{1,22}?)\s*:\s*(.*)$/);
  if (!m) return null;
  return {
    label: normalisasiLabel(m[1]),
    nilai: m[2].trim(),
    no: mNomor ? Number(mNomor[1]) : null,
    indentasi: baris.length - baris.trimStart().length,
  };
}

/**
 * Parse lampiran berformat blok label → daftar pegawai.
 * @returns {{pegawai: Array, peringatan: string[]}}
 */
function parseBlokLabel(teks) {
  const baris = teks.split('\n');
  const rekaman = [];
  const peringatan = [];
  let cur = null;
  let labelTerakhir = null;

  const tutup = () => { if (cur) { rekaman.push(cur); cur = null; } };

  for (const b of baris) {
    const lv = bacaLabel(b);
    if (lv) {
      labelTerakhir = lv;
      if (lv.label === 'NAMA') {
        tutup();
        cur = { nama: lv.nilai, no: lv.no };
      } else if (cur && !(lv.label in cur)) {
        cur[lv.label] = lv.nilai;
      }
      continue;
    }

    // Nama terpotong ke baris berikutnya (tanpa label, lebih menjorok, tanpa ':')
    if (cur && labelTerakhir?.label === 'NAMA' && b.trim() && !b.trim().startsWith('-')) {
      const indentasi = b.length - b.trimStart().length;
      if (!b.includes(':') && indentasi > labelTerakhir.indentasi && b.trim().length < 55) {
        cur.nama = rapikan(`${cur.nama} ${b.trim()}`);
      }
    }
  }
  tutup();

  // Susun jadi baris pegawai
  const pegawai = [];
  const sudahAda = new Set();
  for (const r of rekaman) {
    const nama = nilaiBersih(r.nama);
    if (!nama) continue;

    const nilaiNip = nilaiBersih(r.NIPNIK) || nilaiBersih(r.NIP) || nilaiBersih(r.NIK) || '';
    const nip = String(nilaiNip).replace(/[^0-9]/g, '');

    if (!nip) {
      peringatan.push(`NIP/NIK kosong di lampiran untuk: ${nama}`);
      continue;
    }
    if (nip.length !== 16 && nip.length !== 18) {
      peringatan.push(`NIP/NIK panjang tidak lazim (${nip.length} digit) untuk ${nama}: ${nip} — tidak dipakai`);
      continue;
    }
    if (sudahAda.has(nip)) continue;

    sudahAda.add(nip);
    pegawai.push({
      no: pegawai.length + 1,
      nip,
      nama,
      jabatan: nilaiBersih(r.JABATAN),
      pangkat: nilaiBersih(r.PANGKATGOL),
      jenis: nip.length === 18 ? 'ASN' : 'NON-ASN',
      valid: validasiNip(nip),
    });
  }

  return { pegawai, peringatan };
}

/**
 * Ekstrak daftar pegawai (NIP + NAMA) dari teks SP.
 * Format blok-label (lampiran "Nama : … / NIP / NIK : …") dicoba lebih dulu
 * karena tidak ambigu; kalau tidak ada, baru format tabel.
 * @returns {{pegawai: Array, peringatan: string[], urutan: string}}
 */
function parsePegawai(teks, opts = {}) {
  const { gabungNamaWrap } = { ...DEFAULT_OPTS, ...opts };

  const blok = parseBlokLabel(teks);
  if (blok.pegawai.length) {
    return { pegawai: blok.pegawai, peringatan: blok.peringatan, urutan: 'blok-label' };
  }

  const namaDulu = namaMendahuluiNip(teks);
  const baris = teks.split('\n');

  const hasil = [];
  const sudahAda = new Set();
  const peringatan = [...blok.peringatan];

  for (let i = 0; i < baris.length; i++) {
    const b = baris[i];
    if (!b.trim()) continue;
    // Blok tanda tangan ("NIP. 196512031990031008") bukan baris tabel pegawai
    if (/^(nip|nik)\s*[.:]?\s*\d{16,18}\s*$/i.test(b.trim())) continue;
    if (KATA_ABAIKAN.test(b.trim()) && !/\d{16}|\d{18}/.test(b)) continue;

    const info = ambilNipDariBaris(b);
    if (!info) continue;
    // NIP terpotong / menempel → catat sebagai peringatan, jangan diterka
    if (!info.nip) {
      if (info.curiga?.length) {
        for (const c of info.curiga) {
          const pesan = `NIP tidak lazim panjangnya di PDF: ${c} — cek baris: "${b.trim().slice(0, 80)}"`;
          if (!peringatan.includes(pesan)) peringatan.push(pesan);
        }
      }
      continue;
    }
    if (sudahAda.has(info.nip)) continue;

    // Sinyal NIP terpotong: kandidat 16 digit yang polanya tidak wajar, DAN baris
    // berikutnya berisi sisa digit (1-4) sejajar kolom NIP → jangan diterka,
    // karena NIP ASN 18 digit yang terpotong akan tersamar sebagai Non-ASN.
    if (info.jenis === 'NON-ASN' && !info.valid) {
      const lanjut = baris[i + 1];
      if (lanjut && /^\s*\d{1,4}\s*$/.test(lanjut)) {
        const indentasi = lanjut.length - lanjut.trimStart().length;
        if (Math.abs(indentasi - info.mulai) <= 6) {
          const pesan = `NIP kemungkinan terpotong di PDF (kolom NIP terlalu sempit): "${b.trim().slice(0, 70)}" + "${lanjut.trim()}"`;
          if (!peringatan.includes(pesan)) peringatan.push(pesan);
          continue;
        }
      }
    }

    const kiri = b.slice(0, info.mulai);
    const kanan = b.slice(info.akhir);

    // Tentukan nama + posisi kolom namanya (dipakai untuk validasi baris lanjutan)
    let nama = '';
    let jabatan = '';
    let kolomNama = -1;
    if (namaDulu) {
      const kolom = potongKolom(kiri, 0);
      const terakhir = kolom[kolom.length - 1];
      nama = terakhir?.teks || '';
      kolomNama = terakhir?.mulai ?? -1;
      jabatan = kolom.length >= 2 ? kolom[kolom.length - 2].teks : '';
    } else {
      const kolom = potongKolom(kanan, info.akhir);
      nama = kolom[0]?.teks || '';
      kolomNama = kolom[0]?.mulai ?? -1;
      jabatan = kolom[1]?.teks || '';
    }

    // Nama terpotong ke baris berikutnya: hanya diterima kalau indentasi baris
    // lanjutan sejajar kolom NAMA (kalau tidak, itu kolom JABATAN yang wrap).
    if (gabungNamaWrap && nama && kolomNama >= 0) {
      for (let j = i + 1; j <= i + 2 && j < baris.length; j++) {
        const lanjut = baris[j];
        if (!lanjut.trim()) break;
        if (/\d{16}|\d{18}/.test(lanjut)) break;
        if (KATA_ABAIKAN.test(lanjut.trim())) break;
        if (/\s{2,}/.test(lanjut.trim())) break;        // >1 kolom → bukan lanjutan nama
        const indentasi = lanjut.length - lanjut.trimStart().length;
        if (Math.abs(indentasi - kolomNama) > 4) break; // tidak sejajar kolom nama
        const tambahan = bersihkanKolom(lanjut);
        if (!tambahan || tambahan.length > 60) break;
        nama = rapikan(`${nama} ${tambahan}`);
        i = j;
        break;
      }
    }

    nama = rapikan(nama).replace(/[,;]$/, '');
    // Buang sisa label kolom ("NIP", "NIK") yang ikut terbaca sebagai nama
    if (/^(nip|nik)[.,:]?$/i.test(nama)) continue;
    if (!nama || nama.length < 3 || /^[\d\s.,\-]+$/.test(nama)) continue;

    sudahAda.add(info.nip);
    hasil.push({
      no: hasil.length + 1,
      nip: info.nip,
      nama,
      jabatan: rapikan(jabatan) || null,
      jenis: info.jenis,
      valid: info.valid,
    });
  }

  const invalid = hasil.filter((r) => !r.valid);
  if (invalid.length) {
    peringatan.push(`${invalid.length} NIP/NIK dengan pola tidak wajar (cek manual): ${invalid.map((r) => r.nip).join(', ')}`);
  }

  return { pegawai: hasil, peringatan, urutan: namaDulu ? 'NAMA-dulu' : 'NIP-dulu' };
}

// =============== API UTAMA ===============

/**
 * Parse teks SP mentah (tanpa sentuh file) — berguna untuk unit test.
 */
function parseSpTeks(teks, opts = {}) {
  const nomorSurat = deteksiNomorSurat(teks);
  const linkEsurat = deteksiLinkEsurat(teks);
  const tanggalSurat = deteksiTanggalSurat(teks, { linkEsurat, nomorSurat });
  const kegiatan = deteksiKegiatan(teks);
  const { pegawai, peringatan, urutan } = parsePegawai(teks, opts);

  const warn = [...peringatan];
  if (!nomorSurat) warn.push('Nomor surat tidak terdeteksi');
  if (!tanggalSurat || !tanggalSurat.iso) {
    warn.push('Tanggal surat tidak terdeteksi lengkap di PDF (mis. bagian "Surabaya, …" masih kosong)');
  }
  if (!linkEsurat) warn.push('Link eSurat tidak terdeteksi');
  if (!pegawai.length) warn.push('Tidak ada NIP/NAMA yang terbaca — cek format tabel/lampiran atau lampirkan PDF versi teks (bukan scan)');

  return {
    nomorSurat,
    tanggalSurat,
    kegiatan,
    linkEsurat,
    jumlahPegawai: pegawai.length,
    jumlahAsn: pegawai.filter((p) => p.jenis === 'ASN').length,
    jumlahNonAsn: pegawai.filter((p) => p.jenis === 'NON-ASN').length,
    formatDaftar: urutan,
    pegawai,
    peringatan: warn,
  };
}

/**
 * Parse file PDF SP → objek terstruktur.
 * @param {string} pdfPath
 * @param {object} [opts]
 * @returns {{sumber, sha256, pdf, ...hasilParse}}
 */
function parseSp(pdfPath, opts = {}) {
  const teks = ekstrakTeks(pdfPath, opts);
  const hasil = parseSpTeks(teks, opts);
  const crypto = require('crypto');
  return {
    sumber: pdfPath,
    namaFile: require('path').basename(pdfPath),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex'),
    pdf: infoPdf(pdfPath),
    ...hasil,
    teksMentah: teks, // dibuang oleh index.js kalau tidak diminta
  };
}

module.exports = {
  ekstrakTeks,
  infoPdf,
  parseSp,
  parseSpTeks,
  parsePegawai,
  parseTanggalIndonesia,
  deteksiNomorSurat,
  deteksiTanggalSurat,
  deteksiLinkEsurat,
  namaMendahuluiNip,
  BULAN_MAP,
  NAMA_BULAN,
};
