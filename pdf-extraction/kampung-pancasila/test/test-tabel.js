'use strict';
/**
 * Uji parser tabel "Semula / Menjadi" memakai fixture XML teranonimisasi
 * (tanpa file PDF, tanpa data pribadi).
 *
 *   node pdf-extraction/kampung-pancasila/test/test-tabel.js
 *
 * Fokus uji = jebakan nyata yang pernah bikin salah baca:
 *   1. nama di baris pertama TIDAK boleh terpotong (dulu "TJAHJONO AGUNG
 *      WIBOWO" terbaca "AGUNG WIBOWO");
 *   2. sel NIP+JABATAN yang menempel harus terpisah;
 *   3. NAMA dan KELURAHAN yang menempel ke kolom lain harus terpisah;
 *   4. baris lanjutan (nama wrap & RW tambahan) harus digabung ke baris yang benar;
 *   5. perpindahan kolom antar tabel (Gundih → Jepara) harus terdeteksi;
 *   6. perbedaan NIP di antara tabel harus terdeteksi (bukan dianggap sama);
 *   7. footer/tanda tangan berulang tidak boleh masuk jadi baris data.
 */

const fs = require('fs');
const path = require('path');
const { parseElemenXml } = require('../../lib/pdf-teks');
const tabel = require('../tabel-pergantian');
const { KELUARAN } = require('./buat-fixture');

let gagal = 0;
function cek(nama, syarat, detail) {
  if (syarat) {
    console.log(`  ✅ ${nama}`);
  } else {
    gagal++;
    console.log(`  ❌ ${nama}${detail ? ` → ${detail}` : ''}`);
  }
}

const xml = fs.readFileSync(KELUARAN, 'utf-8');
const { halaman } = parseElemenXml(xml);
const h = tabel.parseTabelSemulaMenjadi(halaman);

const cari = (arr, nama) => arr.find((r) => (r.nama || '').includes(nama));

console.log('\n═══ UJI PARSER TABEL SEMULA / MENJADI ═══\n');

console.log('— struktur dasar —');
cek('tabel Semula terbaca 5 baris', h.semula.length === 5, `dapat ${h.semula.length}`);
cek('tabel Menjadi terbaca 5 baris', h.menjadi.length === 5, `dapat ${h.menjadi.length}`);
cek('semua baris punya NIP 18 digit', [...h.semula, ...h.menjadi].every((r) => (r.nip || '').length === 18));
cek('semua baris punya nama', [...h.semula, ...h.menjadi].every((r) => r.nama && r.nama.length > 3));
cek('footer/ttd tidak jadi baris data', ![...h.semula, ...h.menjadi].some((r) => /UU ITE|BSrE|Ditandatangani|KEPALA|PEJABAT CONTOH/i.test(r.nama)));

console.log('\n— nama tidak terpotong (bug lama) —');
const barisPertama = h.semula[0];
cek('nama baris 1 utuh 3 kata', barisPertama.nama === 'AHMAD SANTOSO WIJAYA', `dapat "${barisPertama.nama}"`);
cek('nama tidak diawali angka', !/^\d/.test(barisPertama.nama), barisPertama.nama);
cek('nomor urut terbaca', barisPertama.no === 1, String(barisPertama.no));

console.log('\n— sel yang menempel dipisah benar —');
cek('NIP baris 1 panjang 18 digit', (barisPertama.nip || '').length === 18, barisPertama.nip);
cek('JABATAN baris 1 terbaca', barisPertama.jabatan === 'Pengadministrasi Perkantoran', barisPertama.jabatan);
cek('KELURAHAN baris 1 terbaca', barisPertama.kelurahan === 'Alun-Alun Contong', barisPertama.kelurahan);
cek('nama tidak membawa sisa NIP', !/\d{6,}/.test(barisPertama.nama), barisPertama.nama);

console.log('\n— nama & kelurahan yang menempel —');
const nikel = cari(h.semula, 'SITI AMINAH');
cek('nama menempel ke jabatan dipisah', nikel && nikel.nama === 'SITI AMINAH', nikel && nikel.nama);
cek('kelurahan menempel ke jabatan dipisah', nikel && nikel.kelurahan === 'Tembok Dukuh', nikel && nikel.kelurahan);

console.log('\n— baris lanjutan digabung —');
const setiawanSemula = cari(h.semula, 'SETIAWAN');
cek('RW tambahan (2 baris) digabung', setiawanSemula && setiawanSemula.pendampingRt.includes('RW 8'), setiawanSemula && setiawanSemula.pendampingRt);
cek('pendampingRt lanjutan dipisah " ; "', setiawanSemula && setiawanSemula.pendampingRt.includes(' ; '), setiawanSemula && setiawanSemula.pendampingRt);
const rina = cari(h.menjadi, 'RINA');
cek('nama wrap 2 baris digabung (gelar)', rina && rina.nama === 'RINA KARTIKA, S.E.', rina && rina.nama);

console.log('\n— pembanding Semula → Menjadi —');
cek('personel keluar terdeteksi', h.diganti.length === 1 && h.diganti[0] === 'AHMAD SANTOSO WIJAYA', JSON.stringify(h.diganti));
cek('personel masuk terdeteksi', h.baru.length === 1 && h.baru[0] === 'RINA KARTIKA, S.E.', JSON.stringify(h.baru));
cek('perbedaan NIP antar tabel terdeteksi',
  h.perbedaan.some((d) => d.nama.includes('SETIAWAN') && d.field === 'NIP' && d.semula !== d.menjadi),
  JSON.stringify(h.perbedaan.filter((d) => d.field === 'NIP')));
cek('perpindahan kelurahan terdeteksi',
  h.perbedaan.some((d) => d.nama.includes('SITI AMINAH') && d.field === 'Kelurahan' && d.semula === 'Tembok Dukuh' && d.menjadi === 'Gundih'),
  JSON.stringify(h.perbedaan.filter((d) => d.field === 'Kelurahan')));
cek('tidak ada peringatan', h.peringatan.length === 0, JSON.stringify(h.peringatan));

console.log(`\n═══ ${gagal === 0 ? 'SEMUA UJI LULUS ✅' : `${gagal} UJI GAGAL ❌`} ═══\n`);
process.exit(gagal === 0 ? 0 : 1);
