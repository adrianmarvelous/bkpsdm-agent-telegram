#!/usr/bin/env node
'use strict';
/**
 * CLI Kampung Pancasila — uji ekstraksi dari terminal.
 *
 * Pakai (dari root repo):
 *   node pdf-extraction/kampung-pancasila/cli.js <file.pdf>            # ringkasan + daftar penerima
 *   node pdf-extraction/kampung-pancasila/cli.js <file.pdf> --simpan   # parse + arsipkan PDF-nya
 *   node pdf-extraction/kampung-pancasila/cli.js <file.pdf> --json     # JSON penuh
 *   node pdf-extraction/kampung-pancasila/cli.js <file.pdf> --dump     # teks mentah pdftotext (debug)
 *   node pdf-extraction/kampung-pancasila/cli.js --list                # daftar isi arsip
 */

const fs = require('fs');
const path = require('path');
const kp = require('./index');

/** Tampilan untuk surat + lampiran DUA TABEL (pergantian personel) */
function tampilkanPergantian(hasil) {
  const t = hasil.tanggalSurat || {};
  const p = hasil.penandatangan || {};
  console.log('');
  console.log('════════════════════════════════════════════════════════════════════');
  console.log('  HASIL EKSTRAKSI — KAMPUNG PANCASILA (pergantian personel)');
  console.log('════════════════════════════════════════════════════════════════════');
  console.log(`  Nomor surat  : ${hasil.nomorSurat || '—'}`);
  console.log(`  Tanggal surat: ${t.display || '—'}${t.iso ? `  (${t.iso})` : ''}`);
  console.log(`  Sifat        : ${hasil.sifat || '—'}   |   Lampiran: ${hasil.lampiran || '—'}`);
  console.log(`  Perihal      : ${hasil.perihal || '—'}`);
  console.log(`  Tujuan       : ${hasil.tujuan || '—'}`);
  console.log(`  Penandatangan: ${p.jabatan || '—'} — ${p.nama || '—'}${p.nip ? ` (NIP ${p.nip})` : ''}`);
  if (hasil.tembusan?.length) console.log(`  Tembusan     : ${hasil.tembusan.length} pihak`);
  console.log(`  PDF          : ${hasil.pdf?.halaman || '?'} halaman`);

  for (const [judul, data] of [['TABEL SEMULA', hasil.tabel.semula], ['TABEL MENJADI', hasil.tabel.menjadi]]) {
    console.log('────────────────────────────────────────────────────────────────────');
    console.log(`  ${judul} (${data.length} pegawai)`);
    console.log('────────────────────────────────────────────────────────────────────');
    const wNama = Math.max(...data.map((d) => d.nama.length), 4, 1);
    const wJab = Math.max(...data.map((d) => d.jabatan.length), 7, 1);
    const wKel = Math.max(...data.map((d) => d.kelurahan.length), 9, 1);
    console.log(`  ${'NO'.padStart(3)}  ${'NAMA'.padEnd(wNama)}  ${'NIP'.padEnd(18)}  ${'JABATAN'.padEnd(wJab)}  ${'KELURAHAN'.padEnd(wKel)}  PENDAMPING RT`);
    for (const d of data) {
      console.log(`  ${String(d.no).padStart(3)}  ${d.nama.padEnd(wNama)}  ${String(d.nip || '-').padEnd(18)}  ${d.jabatan.padEnd(wJab)}  ${d.kelurahan.padEnd(wKel)}  ${d.pendampingRt}`);
    }
  }

  console.log('────────────────────────────────────────────────────────────────────');
  console.log('  PERUBAHAN SEMULA → MENJADI');
  console.log('────────────────────────────────────────────────────────────────────');
  if (hasil.personelDiganti?.length) console.log(`  ➖ keluar : ${hasil.personelDiganti.join(', ')}`);
  if (hasil.personelBaru?.length) console.log(`  ➕ masuk  : ${hasil.personelBaru.join(', ')}`);
  if (hasil.perbedaan?.length) {
    for (const d of hasil.perbedaan) console.log(`  • ${d.nama} — ${d.field}: "${d.semula}" → "${d.menjadi}"`);
  } else {
    console.log('  (tidak ada perubahan pada pegawai yang sama)');
  }

  if (hasil.peringatan?.length) {
    console.log('────────────────────────────────────────────────────────────────────');
    for (const w of hasil.peringatan) console.log(`  ⚠️  ${w}`);
  }
  console.log('');
}

/** Tampilan untuk surat + lampiran daftar penerima */
function tampilkanRingkasan(hasil) {
  const t = hasil.tanggalSurat || {};
  const p = hasil.penandatangan || {};
  console.log('');
  console.log('════════════════════════════════════════════');
  console.log('  HASIL EKSTRAKSI — KAMPUNG PANCASILA');
  console.log('════════════════════════════════════════════');
  console.log(`  Nomor surat  : ${hasil.nomorSurat || '— (tidak terdeteksi)'}`);
  console.log(`  Tanggal surat: ${t.display || '—'}${t.iso ? `  (${t.iso})` : ''}`);
  console.log(`  Sifat        : ${hasil.sifat || '—'}`);
  console.log(`  Lampiran     : ${hasil.lampiran || '—'}`);
  console.log(`  Perihal      : ${hasil.perihal || '—'}`);
  console.log(`  Tembusan/    : ${hasil.daftarTerlampir ? 'nama penerima ada di lampiran' : '—'}`);
  if (p.nama) {
    console.log('  ── Penandatangan ──');
    console.log(`  Jabatan      : ${p.jabatan || '—'}`);
    console.log(`  Nama         : ${p.nama}`);
    console.log(`  Pangkat      : ${p.pangkat || '—'}`);
    console.log(`  NIP          : ${p.nip || '—'}`);
  }
  console.log(`  ── Penerima: ${hasil.jumlahPenerima} ──`);
  console.log(`     Perangkat Daerah: ${hasil.statistik.perangkatDaerah} | Kecamatan: ${hasil.statistik.kecamatan} | Lainnya: ${hasil.statistik.lainnya}`);
  if (hasil.pdf?.halaman) console.log(`  PDF          : ${hasil.pdf.halaman} halaman`);
  console.log('────────────────────────────────────────────');

  const lebar = Math.max(...hasil.daftarPenerima.map((d) => d.nama.length), 5, 1);
  for (const d of hasil.daftarPenerima) {
    console.log(`  ${String(d.no).padStart(3)}  ${d.nama.padEnd(lebar)}  ${d.kategori}`);
  }

  if (hasil.peringatan?.length) {
    console.log('────────────────────────────────────────────');
    for (const w of hasil.peringatan) console.log(`  ⚠️  ${w}`);
  }
  console.log('');
}

function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const filePdf = argv.find((a) => !a.startsWith('--'));

  if (flags.has('--help') || flags.has('-h')) {
    console.log(fs.readFileSync(__filename, 'utf-8').split('*/')[0].split('/**')[1].replace(/^ \* ?/gm, ''));
    return;
  }

  if (flags.has('--list') || !filePdf) {
    const isi = kp.daftarArsip();
    console.log(`\n📁 Arsip Kampung Pancasila: ${kp.DIR_ARSIP}`);
    console.log(`   Jumlah: ${isi.jumlah} surat\n`);
    for (const a of isi.arsip) {
      console.log(`   • ${a.file}`);
      console.log(`     ${a.nomorSurat || '-'} | ${a.tanggalSurat || '-'} | ${a.jenis || '-'} | ${a.ringkas || '-'} | ${a.namaFileAsli}`);
    }
    console.log('');
    return;
  }

  const pdf = path.resolve(filePdf);

  try {
    if (flags.has('--simpan')) {
      const r = kp.simpanKp(pdf);
      if (flags.has('--json')) {
        console.log(JSON.stringify({ duplikat: r.duplikat, file: r.file, metaFile: r.metaFile, hasil: r.hasil }, null, 2));
      } else {
        if (r.hasil.jenis === 'pergantian-personel') tampilkanPergantian(r.hasil);
        else tampilkanRingkasan(r.hasil);
        console.log(r.duplikat
          ? `♻️  Sudah pernah diarsipkan (isi identik) → ${r.file}`
          : `💾 Tersimpan → ${r.file}\n   metadata → ${r.metaFile}`);
        console.log('');
      }
      return;
    }

    const hasil = kp.parsePdf(pdf, { simpanTeks: flags.has('--dump') });
    if (flags.has('--dump')) {
      console.log('\n═════ TEKS MENTAH (pdftotext -layout) ═════\n');
      console.log(hasil.teksMentah);
      delete hasil.teksMentah;
    }
    if (flags.has('--json')) console.log(JSON.stringify(hasil, null, 2));
    else if (hasil.jenis === 'pergantian-personel') tampilkanPergantian(hasil);
    else tampilkanRingkasan(hasil);
  } catch (err) {
    if (err.code === 'PERLU_OCR') {
      console.error('\n❌ PDF hasil scan (tidak ada layer teks). Modul ini butuh PDF teks.');
      console.error('   Solusi: ekspor ulang sebagai PDF teks, atau OCR dulu (belum termasuk).\n');
    } else {
      console.error(`\n❌ ${err.message}\n`);
    }
    process.exit(1);
  }
}

main();
