'use strict';
/**
 * Kampung Pancasila — Lampiran TABEL "Semula" vs "Menjadi"
 *
 * Kasus nyata: surat usulan PERGANTIAN ASN Pendamping RT dari kecamatan.
 * Lampirannya memuat dua tabel dengan kolom:
 *
 *   NO | NAMA | NIP | JABATAN | KELURAHAN | KOORDINATOR KELURAHAN |
 *   PENGAWAS RW | PENDAMPING RT | NO HP
 *
 * KENAPA tidak pakai `pdftotext -layout`: jarak antar sel ≈ 0 sehingga teks
 * menempel tanpa pemisah, contoh nyata:
 *
 *   "TJAHJONO AGUNG WIBOWO197705172001121005Pengadministrasi PerkantoranAlun-Alun Contong"
 *
 * Jadi kolom dipisahkan dengan KOORDINAT (pdftohtml -xml: setiap sel punya
 * left/width). Tiap kata dipetakan ke kolom dengan membandingkan posisi
 * pusat katanya terhadap posisi pusat kolom dari baris header — bukan menebak
 * dari spasi. Bila tetap ambigu, hasilnya diberi peringatan, bukan diterka.
 */

const { rapikan, posisiKata } = require('../lib/pdf-teks');

/** Label kolom sesuai urutan di dokumen */
const LABEL_KOLOM = [
  'NO', 'NAMA', 'NIP', 'JABATAN', 'KELURAHAN',
  'KOORDINATOR KELURAHAN', 'PENGAWAS RW', 'PENDAMPING RT', 'NO HP',
];

const KUNCI_KOLOM = {
  'NO': 'no',
  'NAMA': 'nama',
  'NIP': 'nip',
  'JABATAN': 'jabatan',
  'KELURAHAN': 'kelurahan',
  'KOORDINATOR KELURAHAN': 'koordinatorKelurahan',
  'PENGAWAS RW': 'pengawasRw',
  'PENDAMPING RT': 'pendampingRt',
  'NO HP': 'noHp',
};

const BARIS_FOOTER = /^(Surat ini Ditandatangani|-\s|UU ITE|"?Informasi Elektronik|Dokumen ini)/i;

/** Kelompokkan elemen jadi baris (berdasar `top`), urut atas→bawah */
function kelompokkanBaris(elemen) {
  const peta = new Map();
  for (const e of elemen) {
    if (!peta.has(e.top)) peta.set(e.top, []);
    peta.get(e.top).push(e);
  }
  return [...peta.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([top, els]) => ({ top, els: els.slice().sort((a, b) => a.left - b.left) }));
}

/**
 * Pusat tiap kolom dari baris header. Label bisa menyatu dalam satu elemen
 * (mis. "KOORDINATOR KELURAHAN PENGAWAS RW PENDAMPING RT"), jadi label dicocokkan
 * berurutan di dalam elemen dan posisinya dihitung proporsional.
 */
function anchorKolom(barisHeader) {
  const anchor = [];
  let idx = 0;
  for (const e of barisHeader.els) {
    const teks = e.teks.toUpperCase();
    let kursor = 0;
    while (idx < LABEL_KOLOM.length) {
      const label = LABEL_KOLOM[idx];
      const i = teks.indexOf(label, kursor);
      if (i < 0) break;
      anchor.push({
        label,
        center: posisiKata(e, e.teks.slice(i, i + label.length), i),
      });
      kursor = i + label.length;
      idx++;
    }
    if (idx >= LABEL_KOLOM.length) break;
  }
  return anchor.sort((a, b) => a.center - b.center);
}

/** Kolom mana yang paling dekat dengan sebuah posisi x */
function labelTerdekat(pusat, anchor, hanyaLabel = null) {
  const kandidat = hanyaLabel ? anchor.filter((a) => hanyaLabel.includes(a.label)) : anchor;
  let terdekat = kandidat[0];
  for (const a of kandidat) {
    if (Math.abs(a.center - pusat) < Math.abs(terdekat.center - pusat)) terdekat = a;
  }
  return terdekat.label;
}

const NIP_RE = /(?<!\d)(\d{18}|\d{16})(?!\d)/;

/** Daftar token satu baris + posisi x pusatnya (dipakai untuk memetakan kolom) */
function tokenBerposisi(els, anchor) {
  const hasil = [];
  for (const e of els) {
    const re = /\S+/g;
    let m;
    while ((m = re.exec(e.teks)) !== null) {
      const pusat = posisiKata(e, m[0], m.index);
      hasil.push({ teks: m[0], pusat, el: e, offset: m.index, label: labelTerdekat(pusat, anchor) });
    }
  }
  return hasil;
}

/** Petakan semua token ke kolom terdekat (dipakai untuk baris lanjutan) */
function tokenKeKolom(els, anchor) {
  const hasil = {};
  for (const a of anchor) hasil[KUNCI_KOLOM[a.label]] = [];
  for (const t of tokenBerposisi(els, anchor)) {
    hasil[KUNCI_KOLOM[t.label]].push(t.teks);
  }
  for (const k of Object.keys(hasil)) hasil[k] = rapikan(hasil[k].join(' '));
  return hasil;
}

/** Ambil NIP 18 digit (ASN) / 16 digit (NIK) dari teks sebuah baris */
function ambilNip(teks) {
  const m = String(teks).match(/(?<!\d)(\d{18}|\d{16})(?!\d)/);
  return m ? m[1] : null;
}

/** Kolom ekor: semua kolom kecuali NO/NAMA/NIP (dipakai untuk token setelah NIP) */
const KOLOM_EKOR = ['JABATAN', 'KELURAHAN', 'KOORDINATOR KELURAHAN', 'PENGAWAS RW', 'PENDAMPING RT', 'NO HP'];

/**
 * Baca satu tabel (baris header + baris data + baris lanjutan).
 * @returns {{baris: Array, peringatan: string[]}}
 */
function bacaTabel(baris, iHeader, anchor) {
  const data = [];
  const peringatan = [];

  for (let i = iHeader + 1; i < baris.length; i++) {
    const b = baris[i];
    const teksBaris = b.els.map((e) => e.teks).join(' ').trim();
    if (!teksBaris) continue;
    if (BARIS_FOOTER.test(teksBaris)) break;
    if (/^(Semula|Menjadi)$/i.test(teksBaris)) break;

    // ---- Baris LANJUTAN (mis. "S.A.P." atau "RW 8 (RT 1 dan 2)") ----
    // Tanpa nomor urut & tanpa NIP → digabung ke baris sebelumnya per kolom.
    const tokens0 = tokenBerposisi(b.els, anchor);
    const adaNo0 = /^\d{1,3}$/.test(tokens0[0]?.teks || '');
    const adaNip0 = tokens0.some((t) => NIP_RE.test(t.teks));
    if (!adaNo0 && !adaNip0) {
      const terakhir = data[data.length - 1];
      if (!terakhir) continue;
      const kolomLanjut = {};
      for (const t of tokens0) {
        const kunci = KUNCI_KOLOM[t.label];
        kolomLanjut[kunci] = rapikan(`${kolomLanjut[kunci] || ''} ${t.teks}`);
      }
      for (const kunci of Object.keys(kolomLanjut)) {
        const nilai = kolomLanjut[kunci];
        if (!nilai || kunci === 'no') continue;
        if (!terakhir[kunci]) terakhir[kunci] = nilai;
        else terakhir[kunci] += kunci === 'pendampingRt' ? ` ; ${nilai}` : ` ${nilai}`;
      }
      continue;
    }

    // ---- Baris DATA ----
    // NO & NAMA ditentukan dari URUTAN token, bukan "posisi terdekat": pada
    // surat asli ada baris yang seluruh selnya menyatu dalam satu elemen
    // ("1 TJAHJONO AGUNG WIBOWO 197705172001121005 …") dan nama mulai lebih
    // kiri daripada kolom NO — pendekatan posisi-terdekat memotong nama jadi
    // "AGUNG WIBOWO" (kehilangan kata pertama). Dengan urutan: token pertama
    // angka = NO, sisanya sampai NIP = NAMA.
    const tokens = tokenBerposisi(b.els, anchor);
    const tokenNo = adaNo0 ? tokens.shift() : null;
    const iNip = tokens.findIndex((t) => NIP_RE.test(t.teks));

    let nip = null;
    const potonganNama = [];
    if (iNip >= 0) {
      const tk = tokens[iNip];
      const m = tk.teks.match(NIP_RE);
      nip = m[1];

      potonganNama.push(...tokens.slice(0, iNip).map((t) => t.teks));
      const kiri = tk.teks.slice(0, m.index).trim();   // nama yang menempel ke NIP
      if (kiri) potonganNama.push(kiri);
      tokens.splice(0, iNip + 1);

      // Sisa teks token NIP (jabatan yang menempel) → kolom ekor
      const sisa = tk.teks.slice(m.index + m[1].length);
      const sisaTrim = sisa.trim();
      if (sisaTrim) {
        const offset = tk.offset + m.index + m[1].length + (sisa.length - sisa.trimStart().length);
        tokens.unshift({ teks: sisaTrim, pusat: posisiKata(tk.el, sisaTrim, offset), el: tk.el, offset });
      }
    } else {
      potonganNama.push(...tokens.map((t) => t.teks));
      tokens.length = 0;
    }

    const kolom = { jabatan: [], kelurahan: [], koordinatorKelurahan: [], pengawasRw: [], pendampingRt: [], noHp: [] };
    for (const t of tokens) {
      kolom[KUNCI_KOLOM[labelTerdekat(t.pusat, anchor, KOLOM_EKOR)]].push(t.teks);
    }

    const record = {
      no: tokenNo ? Number(tokenNo.teks) : data.length + 1,
      nama: rapikan(potonganNama.join(' ')).replace(/^[,.]+\s*/, ''),
      nip: nip,
      jabatan: rapikan(kolom.jabatan.join(' ')),
      kelurahan: rapikan(kolom.kelurahan.join(' ')),
      koordinatorKelurahan: rapikan(kolom.koordinatorKelurahan.join(' ')),
      pengawasRw: rapikan(kolom.pengawasRw.join(' ')),
      pendampingRt: rapikan(kolom.pendampingRt.join(' ')),
      noHp: rapikan(kolom.noHp.join(' ')),
    };

    // Rapikan: buang sisa token yang salah kolom (nama kadang menempel ke NIP)
    if (record.nip) {
      for (const kunci of Object.keys(record)) {
        if (kunci !== 'nip' && typeof record[kunci] === 'string') {
          record[kunci] = rapikan(record[kunci].replace(new RegExp(`\\b${record.nip}\\b`, 'g'), ''));
        }
      }
    }
    if (!record.nama) peringatan.push(`Baris no ${record.no}: NAMA tidak terbaca`);
    if (!record.nip) peringatan.push(`Baris no ${record.no} (${record.nama || '?'}): NIP tidak terbaca`);
    else if (record.nip.length !== 18) peringatan.push(`Baris no ${record.no} (${record.nama || '?'}): NIP ${record.nip.length} digit (${record.nip}) — cek manual`);
    if (/^\d/.test(record.nama)) peringatan.push(`Baris no ${record.no}: NAMA masih memuat angka ("${record.nama}")`);

    data.push(record);
  }

  return { baris: data, peringatan };
}

// =============== PEMBANDING SEMULA vs MENJADI ===============

/** Nama untuk pencocokan antar tabel: uppercase, tanpa tanda baca */
function kunciNama(nama) {
  return String(nama || '').toUpperCase().replace(/[^A-Z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const FIELD_DIBANDING = [
  ['nip', 'NIP'],
  ['jabatan', 'Jabatan'],
  ['kelurahan', 'Kelurahan'],
  ['pendampingRt', 'Pendamping RT'],
  ['noHp', 'No HP'],
];

/**
 * Bandingkan tabel Semula vs Menjadi per orang (kunci: nama).
 * @returns {{perbedaan: Array, diganti: string[], baru: string[]}}
 */
function bandingkan(semula, menjadi) {
  const perbedaan = [];
  const petaMenjadi = new Map(menjadi.map((r) => [kunciNama(r.nama), r]));
  const petaSemula = new Map(semula.map((r) => [kunciNama(r.nama), r]));

  for (const s of semula) {
    const m = petaMenjadi.get(kunciNama(s.nama));
    if (!m) continue;
    for (const [kunci, label] of FIELD_DIBANDING) {
      const a = s[kunci] || '';
      const b = m[kunci] || '';
      if (a !== b) perbedaan.push({ nama: s.nama, field: label, semula: a || '(kosong)', menjadi: b || '(kosong)' });
    }
  }

  const diganti = semula.filter((s) => !petaMenjadi.has(kunciNama(s.nama))).map((s) => s.nama);
  const baru = menjadi.filter((m) => !petaSemula.has(kunciNama(m.nama))).map((m) => m.nama);
  return { perbedaan, diganti, baru };
}

// =============== API UTAMA ===============

/**
 * Parse seluruh lampiran dua tabel.
 *
 * @param {Array} halaman array halaman (tiap halaman = array elemen) dari
 *   lib.ekstrakElemen. WAJIB per halaman: koordinat `top` tiap halaman dimulai
 *   dari 0 lagi, jadi kalau semua halaman digabung lalu diurutkan berdasar `top`,
 *   baris surat halaman 1 akan terselip di antara baris tabel lampiran.
 */
function parseTabelSemulaMenjadi(halaman) {
  const daftarHalaman = Array.isArray(halaman[0]) ? halaman : [halaman];
  const peringatan = [];
  const hasil = { semula: null, menjadi: null };

  for (const elemenHalaman of daftarHalaman) {
    const baris = kelompokkanBaris(elemenHalaman);

    const penanda = [];
    baris.forEach((b, i) => {
      const t = b.els.map((e) => e.teks).join(' ').trim();
      if (/^Semula$/i.test(t)) penanda.push({ nama: 'semula', i });
      else if (/^Menjadi$/i.test(t)) penanda.push({ nama: 'menjadi', i });
    });
    if (!penanda.length) continue;

    for (let p = 0; p < penanda.length; p++) {
      const { nama, i } = penanda[p];
      const batasAkhir = p + 1 < penanda.length ? penanda[p + 1].i : baris.length;

      let iHeader = -1;
      for (let j = i + 1; j < batasAkhir; j++) {
        const t = baris[j].els.map((e) => e.teks).join(' ').toUpperCase();
        if (t.includes('NIP') && t.includes('JABATAN') && t.includes('NAMA')) { iHeader = j; break; }
      }
      if (iHeader < 0) {
        peringatan.push(`Baris header tabel "${nama}" tidak ditemukan`);
        if (!hasil[nama]) hasil[nama] = [];
        continue;
      }

      const anchor = anchorKolom(baris[iHeader]);
      if (anchor.length < LABEL_KOLOM.length) {
        peringatan.push(`Kolom tabel "${nama}" hanya terdeteksi ${anchor.length}/${LABEL_KOLOM.length}: ${anchor.map((a) => a.label).join(', ')}`);
      }
      const { baris: data, peringatan: pw } = bacaTabel(baris.slice(0, batasAkhir), iHeader, anchor);
      hasil[nama] = data;
      peringatan.push(...pw.map((s) => `[${nama}] ${s}`));
    }
  }

  if (!hasil.semula && !hasil.menjadi) {
    return {
      semula: [], menjadi: [], perbedaan: [], diganti: [], baru: [],
      peringatan: [...peringatan, 'Tabel "Semula"/"Menjadi" tidak ditemukan di lampiran'],
    };
  }

  const { perbedaan, diganti, baru } = bandingkan(hasil.semula || [], hasil.menjadi || []);

  return {
    semula: hasil.semula || [],
    menjadi: hasil.menjadi || [],
    perbedaan,
    diganti,
    baru,
    peringatan,
  };
}

module.exports = {
  LABEL_KOLOM,
  kelompokkanBaris,
  anchorKolom,
  tokenKeKolom,
  parseTabelSemulaMenjadi,
  bandingkan,
};
