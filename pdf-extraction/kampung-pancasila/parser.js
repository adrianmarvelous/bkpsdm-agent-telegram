'use strict';
/**
 * Kampung Pancasila — Parser PDF surat BKPSDM + lampiran daftar penerima
 *
 * Bentuk dokumen yang ditangani (terbukti pada surat asli
 * 800/12528/436.8.4/2026, 3 halaman, dompdf + CPDF):
 *
 *   Halaman 1  : kop BKPSDM, "Surabaya, 29 Juli 2026", blok
 *                Nomor / Sifat / Lampiran / Hal (perihal bisa 2-3 baris),
 *                isi surat, blok tanda tangan elektronik (jabatan, nama,
 *                pangkat, NIP).
 *   Halaman 2-3: "Lampiran Daftar Penerima Surat" + "Kepada Yth." lalu daftar
 *                bernomor (1..N) berisi perangkat daerah dan kecamatan.
 *
 * Semua ekstraksi deterministik (pdftotext + aturan eksplisit) — tanpa LLM,
 * supaya hasilnya bisa diulang dan diaudit.
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const {
  rapikan,
  nilaiBersih,
  ekstrakTeks,
  ekstrakElemen,
  infoPdf,
  parseTanggalIndonesia,
  deteksiNomorSurat,
} = require('../lib/pdf-teks');
const tabelPergantian = require('./tabel-pergantian');

const DEFAULT_OPTS = { layout: true, minPanjangTeks: 120 };
const MAKS_PENERIMA = 500; // pengaman: jangan sampai salah baca jadi ribuan baris

// =============== TANGGAL ===============

/**
 * Tanggal surat: utamakan "Surabaya, <tanggal>" (paling andal — kop dan
 * kalimat badan surat juga memuat kata "Surabaya" tanpa tanggal, jadi semua
 * kemunculan dicoba), lalu header lampiran "Tanggal : …" yang menempel pada
 * baris nomor surat.
 */
function deteksiTanggalSurat(teks, opts = {}) {
  const baris = teks.split('\n');

  const reSby = /Surabaya\s*,\s*([^\n]{0,40})/gi;
  let m;
  while ((m = reSby.exec(teks)) !== null) {
    const t = parseTanggalIndonesia(m[1]) || parseTanggalIndonesia(teks.slice(m.index, m.index + 70));
    if (t) return t;
  }

  if (opts.nomorSurat) {
    for (let i = 0; i < baris.length; i++) {
      const mNomor = baris[i].match(/\bNomor\b\s*:/i);
      if (!mNomor || !baris[i].includes(opts.nomorSurat)) continue;
      for (let j = Math.max(0, i - 4); j <= Math.min(baris.length - 1, i + 4); j++) {
        const mTgl = baris[j].match(/\btanggal\s*[:.]\s*([^\n]{5,40})/i);
        if (!mTgl) continue;
        const t = parseTanggalIndonesia(mTgl[1], { sumber: 'header-lampiran' });
        if (t) return t;
      }
    }
  }

  const th = String(opts.nomorSurat || '').match(/\/(20\d{2})\b/)?.[1];
  return th ? { iso: null, display: null, tahun: th, sumber: 'nomor-surat' } : null;
}

// =============== BLOK META (Nomor/Sifat/Lampiran/Hal) ===============

/** Baca baris berlabel "Hal : ..." → { label, nilai, indentasi } */
function bacaBarisLabel(baris) {
  if (/^\s*\d/.test(baris)) return null; // baris bernomor daftar, bukan label
  const m = baris.match(/^\s*([A-Za-z][A-Za-z\s/.\-]{1,20}?)\s*:\s*(.*)$/);
  if (!m) return null;
  return {
    label: m[1].replace(/[^A-Za-z]/g, '').toUpperCase(),
    nilai: m[2].trim(),
    indentasi: baris.length - baris.trimStart().length,
  };
}

/**
 * Ambil Nomor / Sifat / Lampiran / Hal beserta lanjutan perihal multi-baris.
 * Lanjutan dianggap bagian nilai bila baris berikutnya: tidak kosong, tanpa ':' ,
 * tidak diawali angka, dan pendek (bukan paragraf baru).
 */
function parseBlokMeta(teks) {
  const baris = teks.split('\n');
  const meta = { nomorSurat: null, sifat: null, lampiran: null, perihal: null };
  const perihalPotongan = [];

  for (let i = 0; i < baris.length; i++) {
    const lv = bacaBarisLabel(baris[i]);
    if (!lv) continue;

    if (lv.label === 'NOMOR' && !meta.nomorSurat) meta.nomorSurat = nilaiBersih(lv.nilai);
    if (lv.label === 'SIFAT' && !meta.sifat) meta.sifat = nilaiBersih(lv.nilai);
    if (lv.label === 'LAMPIRAN' && !meta.lampiran) meta.lampiran = nilaiBersih(lv.nilai);
    if (['HAL', 'PERIHAL'].includes(lv.label) && !perihalPotongan.length) {
      if (lv.nilai) perihalPotongan.push(lv.nilai);
      for (let j = i + 1; j < baris.length && j <= i + 4; j++) {
        const lanjut = baris[j].trim();
        if (!lanjut) break;
        if (lanjut.includes(':') || /^\d/.test(lanjut) || lanjut.length > 80) break;
        perihalPotongan.push(lanjut);
      }
    }
  }

  if (perihalPotongan.length) meta.perihal = rapikan(perihalPotongan.join(' '));
  return meta;
}

// =============== PENANDATANGAN ===============

/**
 * Blok tanda tangan elektronik:
 *   Surat ini Ditandatangani Elektronik Oleh :
 *   KEPALA BADAN,
 *   IRA TURSILOWATI, SH, MH
 *   Pembina Utama Muda / IV/c
 *   NIP. 196910171993032006
 */
function parsePenandatangan(teks) {
  const baris = teks.split('\n');
  const i = baris.findIndex((b) => /Ditandatangani\s+Elektronik/i.test(b));
  if (i < 0) return null;

  const hasil = { jabatan: null, nama: null, pangkat: null, nip: null };
  for (let j = i + 1; j < Math.min(baris.length, i + 12); j++) {
    const t = baris[j].trim();
    if (!t) continue;
    if (/^-|UU ITE|Informasi Elektronik/i.test(t)) break;

    const mNip = t.match(/^NIP[.\s:]*(\d{16,18})\b/i);
    if (mNip) { hasil.nip = mNip[1]; continue; }

    if (!hasil.jabatan && !/\d/.test(t) && /^[A-Z\s.,]+$/.test(t)) {
      hasil.jabatan = t.replace(/,\s*$/, '');
      continue;
    }
    if (!hasil.nama && /^[A-Z][A-Za-z\s.,'()]{4,}$/.test(t) && !/^\d/.test(t)) {
      hasil.nama = rapikan(t).replace(/,\s*$/, '');
      continue;
    }
    if (!hasil.pangkat && /\/\s*(I{1,3}V?|IV)\s*\/?\s*[a-z]/i.test(t)) {
      hasil.pangkat = rapikan(t);
    }
  }
  return (hasil.nama || hasil.nip) ? hasil : null;
}

// =============== DAFTAR PENERIMA ===============

/** Kategori penerima berdasarkan awalan nama */
function kategoriPenerima(nama) {
  if (/^Camat\b/i.test(nama)) return 'Kecamatan';
  if (/^(Kepala|Sekretaris|Inspektur|Direktur|Ketua)\b/i.test(nama)) return 'Perangkat Daerah';
  return 'Lainnya';
}

/** Baris yang bukan bagian daftar: header lampiran, footer e-sign, blok ttd */
const BUKAN_PENERIMA = /^(Lampiran|Tanggal|Nomor|Kepada|Yth|Sifat|Hal|Surat ini Ditandatangani)/i;
const FOOTER_E_SIGN = /^(-|UU ITE|"Informasi Elektronik|Informasi Elektronik)/i;
const BARIS_TTD = /^(NIP[.\s:]*\d|Pembina|Penata|Pengatur|Juru|Ahli Pertama|Ahli Muda|Ahli Madya)/i;

/**
 * Baca daftar penerima pada lampiran ("Kepada Yth." lalu daftar bernomor).
 *
 * Catatan penting (bug nyata yang pernah terjadi): blok tanda tangan elektronik
 * dan catatan footer **diulang di setiap halaman**, jadi daftar TIDAK boleh
 * dihentikan saat menemui footer — daftar di surat asli berlanjut dari halaman 2
 * ke halaman 3 (36 item → 66 item). Karena itu footer hanya "dilewati", dan
 * penanda akhir daftar adalah habisnya dokumen.
 *
 * Pengaman utama: nomor urut harus tepat berurutan (1, 2, 3, …). Dengan itu
 * daftar ketentuan di badan surat (1. Perangkat daerah …, 2. Penyampaian usulan …)
 * dan angka lain di dokumen tidak ikut masuk.
 */
function parseDaftarPenerima(teks) {
  const baris = teks.split('\n');
  const daftar = [];
  const peringatan = [];
  const dilewati = [];

  const mulai = baris.findIndex((b) => /^\s*Kepada\s+Yth\b/i.test(b));
  if (mulai < 0) {
    return { daftar, peringatan: ['Blok "Kepada Yth." tidak ditemukan — daftar penerima tidak terbaca'], dilewati };
  }

  let harap = 1;
  let bolehLanjut = false;   // baris setelah item valid boleh jadi lanjutan nama
  let setelahTtd = false;    // sedang di blok tanda tangan/footer halaman

  for (let i = mulai + 1; i < baris.length; i++) {
    const b = baris[i];
    const t = b.trim();
    if (!t) continue;

    if (/Surat ini Ditandatangani/i.test(t)) { setelahTtd = true; bolehLanjut = false; continue; }
    if (FOOTER_E_SIGN.test(t) || BARIS_TTD.test(t)) { bolehLanjut = false; continue; }
    if (BUKAN_PENERIMA.test(t)) { bolehLanjut = false; continue; }

    const m = t.match(/^(\d{1,3})\.\s+(.+)$/);
    if (m) {
      const no = Number(m[1]);
      if (no !== harap) { dilewati.push(no); bolehLanjut = false; continue; }
      harap++;
      const nama = rapikan(m[2]);
      daftar.push({ no, nama, kategori: kategoriPenerima(nama) });
      bolehLanjut = true;
      setelahTtd = false;
      if (daftar.length >= MAKS_PENERIMA) break;
      continue;
    }

    // Lanjutan nama yang terpotong baris — hanya bila item sebelumnya baru diterima
    // (setelahTtd true = baris milik blok tanda tangan, jangan digabung!)
    if (bolehLanjut && !setelahTtd) {
      const indentasi = b.length - b.trimStart().length;
      const sebelumnya = daftar[daftar.length - 1];
      if (indentasi >= 6 && t.length < 90 && !/\d{3,}/.test(t)) {
        sebelumnya.nama = rapikan(`${sebelumnya.nama} ${t}`);
        sebelumnya.kategori = kategoriPenerima(sebelumnya.nama);
        continue;
      }
    }
    bolehLanjut = false;
  }

  if (dilewati.length) {
    peringatan.push(`Nomor di luar urutan diabaikan (bukan bagian daftar): ${dilewati.join(', ')}`);
  }
  if (daftar.length) {
    const akhir = daftar[daftar.length - 1].no;
    if (akhir !== daftar.length) {
      peringatan.push(`Nomor penerima tidak berurutan tanpa lompatan: terakhir ${akhir}, jumlah ${daftar.length}`);
    }
  }
  return { daftar, peringatan, dilewati };
}

// =============== JENIS DOKUMEN & BAGIAN SURAT LAIN ===============

const BARIS_FOOTER_SURAT = /^(-|UU ITE|"?Informasi Elektronik|Dokumen ini|Surat ini Ditandatangani)/i;

/**
 * Tebak jenis dokumen dari teksnya:
 *  - 'pergantian-personel' : lampiran dua tabel "Semula" → "Menjadi"
 *  - 'daftar-penerima'     : lampiran daftar penerima bernomor ("Kepada Yth.")
 *  - 'surat'               : surat biasa
 */
function deteksiJenisDokumen(teks) {
  const t = String(teks);
  if (/(^|\n)\s*Semula\s*(\n|$)/i.test(t) && /(^|\n)\s*Menjadi\s*(\n|$)/i.test(t)) return 'pergantian-personel';
  if (/Kepada\s+Yth/i.test(t) && /(^|\n)\s*1\.\s+\S/m.test(t)) return 'daftar-penerima';
  return 'surat';
}

/** Alamat tujuan surat: baris setelah "Yth." sampai baris "di -" */
function parseTujuan(teks) {
  const baris = String(teks).split('\n');
  const i = baris.findIndex((b) => /^\s*Yth\.?\s+\S/i.test(b) && !/Daftar Nama Terlampir/i.test(b));
  if (i < 0) return null;

  const potongan = [baris[i].replace(/^\s*Yth\.?\s*/i, '').trim()];
  for (let j = i + 1; j < Math.min(baris.length, i + 5); j++) {
    const t = baris[j].trim();
    if (!t) break;
    if (/^di\s*-?$/i.test(t)) break;
    if (/^Surabaya$/i.test(t)) break;
    if (/^\d/.test(t)) break;
    potongan.push(t);
  }
  const tujuan = rapikan(potongan.join(' '));
  return tujuan || null;
}

/** Tembusan: daftar bernomor setelah kata "Tembusan" */
function parseTembusan(teks) {
  const baris = String(teks).split('\n');
  const i = baris.findIndex((b) => /^\s*Tembusan\b/i.test(b));
  if (i < 0) return [];

  const daftar = [];
  let harap = 1;
  for (let j = i + 1; j < baris.length; j++) {
    const t = baris[j].trim();
    if (!t) continue;
    if (BARIS_FOOTER_SURAT.test(t)) break;
    const m = t.replace(/^Yth\.?\s*/i, '').match(/^(\d{1,2})\.\s+(.+)$/);
    if (!m) continue;
    if (Number(m[1]) !== harap) continue;   // hanya daftar yang benar berurutan
    harap++;
    daftar.push({ no: Number(m[1]), nama: rapikan(m[2]) });
  }
  return daftar;
}

/**
 * Parse surat + lampiran DUA TABEL (Semula → Menjadi) — kasus "pergantian
 * ASN Pendamping RT" dari kecamatan.
 *
 * @param {string} teks  hasil pdftotext -layout (dipakai untuk blok surat)
 * @param {Array} halaman array halaman elemen berkoordinat dari lib.ekstrakElemen
 */
function parsePergantian(teks, halaman) {
  const meta = parseBlokMeta(teks);
  const nomorSurat = meta.nomorSurat || deteksiNomorSurat(teks);
  const tanggalSurat = deteksiTanggalSurat(teks, { nomorSurat });
  const penandatangan = parsePenandatangan(teks);
  const tujuan = parseTujuan(teks);
  const tembusan = parseTembusan(teks);
  const tabel = tabelPergantian.parseTabelSemulaMenjadi(halaman);

  const catatan = [...tabel.peringatan];
  if (!nomorSurat) catatan.push('Nomor surat tidak terdeteksi');
  if (!tanggalSurat || !tanggalSurat.iso) catatan.push('Tanggal surat tidak terdeteksi lengkap di PDF');
  if (!meta.perihal) catatan.push('Perihal (Hal) tidak terdeteksi');
  if (!penandatangan) catatan.push('Blok tanda tangan (jabatan/nama/NIP) tidak terdeteksi');
  if (!tabel.semula.length) catatan.push('Tabel "Semula" kosong');
  if (!tabel.menjadi.length) catatan.push('Tabel "Menjadi" kosong');

  return {
    jenisDokumen: 'Surat usulan pergantian personel + lampiran 2 tabel (Semula → Menjadi)',
    nomorSurat,
    tanggalSurat,
    sifat: meta.sifat,
    lampiran: meta.lampiran,
    perihal: meta.perihal,
    tujuan,
    tembusan,
    penandatangan,
    tabel: { semula: tabel.semula, menjadi: tabel.menjadi },
    perbedaan: tabel.perbedaan,
    personelDiganti: tabel.diganti,
    personelBaru: tabel.baru,
    jumlahSemula: tabel.semula.length,
    jumlahMenjadi: tabel.menjadi.length,
    peringatan: catatan,
  };
}

// =============== API UTAMA ===============

/** Parse teks surat (tanpa sentuh file) — untuk unit test */
function parseKpTeks(teks) {
  const meta = parseBlokMeta(teks);
  const nomorSurat = meta.nomorSurat || deteksiNomorSurat(teks);
  const tanggalSurat = deteksiTanggalSurat(teks, { nomorSurat });
  const penandatangan = parsePenandatangan(teks);
  const { daftar, peringatan, dilewati } = parseDaftarPenerima(teks);

  const statistik = { perangkatDaerah: 0, kecamatan: 0, lainnya: 0 };
  for (const p of daftar) {
    if (p.kategori === 'Kecamatan') statistik.kecamatan++;
    else if (p.kategori === 'Perangkat Daerah') statistik.perangkatDaerah++;
    else statistik.lainnya++;
  }

  const catatan = [...peringatan];
  if (!nomorSurat) catatan.push('Nomor surat tidak terdeteksi');
  if (!tanggalSurat || !tanggalSurat.iso) catatan.push('Tanggal surat tidak terdeteksi lengkap di PDF');
  if (!meta.perihal) catatan.push('Perihal (Hal) tidak terdeteksi');
  if (!penandatangan) catatan.push('Blok tanda tangan (jabatan/nama/NIP) tidak terdeteksi');
  if (!daftar.length) catatan.push('Daftar penerima kosong — cek blok "Kepada Yth." di lampiran');
  if (dilewati.length) catatan.push(`Ada nomor urut yang terlewat: ${dilewati.join(', ')}`);

  return {
    jenisDokumen: daftar.length ? 'Surat + lampiran daftar penerima' : 'Surat',
    nomorSurat,
    tanggalSurat,
    sifat: meta.sifat,
    lampiran: meta.lampiran,
    perihal: meta.perihal,
    daftarTerlampir: /Daftar Nama Terlampir/i.test(teks),
    penandatangan,
    daftarPenerima: daftar,
    jumlahPenerima: daftar.length,
    statistik,
    peringatan: catatan,
  };
}

/** Parse file PDF → objek terstruktur (jenis dokumen dideteksi otomatis) */
function parsePdf(pdfPath, opts = {}) {
  const teks = ekstrakTeks(pdfPath, { ...DEFAULT_OPTS, ...opts });
  const jenis = deteksiJenisDokumen(teks);

  const dasar = {
    sumber: pdfPath,
    namaFile: path.basename(pdfPath),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex'),
    pdf: infoPdf(pdfPath),
  };

  // Lampiran dua tabel "Semula → Menjadi" perlu koordinat (sel menempel),
  // jadi diekstrak ulang dengan pdftohtml -xml.
  if (jenis === 'pergantian-personel') {
    const { halaman } = ekstrakElemen(pdfPath, opts);
    return { ...dasar, jenis, ...parsePergantian(teks, halaman), teksMentah: teks };
  }

  return { ...dasar, jenis, ...parseKpTeks(teks, opts), teksMentah: teks };
}

module.exports = {
  parsePdf,
  parseKpTeks,
  parsePergantian,
  parseBlokMeta,
  parsePenandatangan,
  parseDaftarPenerima,
  parseTujuan,
  parseTembusan,
  deteksiTanggalSurat,
  deteksiJenisDokumen,
  kategoriPenerima,
};
