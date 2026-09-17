#!/usr/bin/env node
'use strict';
/**
 * CLI SP WFO/WFH — uji ekstraksi dari terminal.
 *
 * Pakai:
 *   node pdf-extraction/sp-kantorku-wfo/cli.js <file.pdf>              # tampilkan ringkasan + tabel pegawai
 *   node pdf-extraction/sp-kantorku-wfo/cli.js <file.pdf> --simpan     # parse + arsipkan PDF-nya
 *   node pdf-extraction/sp-kantorku-wfo/cli.js <file.pdf> --json       # keluarkan JSON penuh (untuk pipeline)
 *   node pdf-extraction/sp-kantorku-wfo/cli.js <file.pdf> --dump       # tampilkan teks mentah hasil pdftotext (debug)
 *   node pdf-extraction/sp-kantorku-wfo/cli.js --list                  # daftar isi arsip
 */

const path = require('path');
const sp = require('./index');

function tampilkanRingkasan(hasil) {
  const t = hasil.tanggalSurat || {};
  console.log('');
  console.log('════════════════════════════════════════════');
  console.log('  HASIL EKSTRAKSI SP WFO/WFH');
  console.log('════════════════════════════════════════════');
  console.log(`  Nomor surat  : ${hasil.nomorSurat || '— (tidak terdeteksi)'}`);
  console.log(`  Tanggal surat: ${t.display || '—'}${t.iso ? `  (${t.iso})` : ''}`);
  console.log(`  Link eSurat  : ${hasil.linkEsurat || '— (tidak terdeteksi)'}`);
  if (hasil.kegiatan) console.log(`  Kegiatan     : ${hasil.kegiatan.hari || '-'}, ${hasil.kegiatan.display || '-'} (${hasil.kegiatan.tanggal || '-'})`);
  console.log(`  Format daftar: ${hasil.formatDaftar}`);
  console.log(`  Jumlah       : ${hasil.jumlahPegawai} pegawai (ASN ${hasil.jumlahAsn}, Non-ASN ${hasil.jumlahNonAsn})`);
  if (hasil.pdf?.halaman) console.log(`  PDF          : ${hasil.pdf.halaman} halaman`);
  console.log('────────────────────────────────────────────');

  if (hasil.pegawai.length) {
    const lebar = Math.max(...hasil.pegawai.map((p) => p.nama.length), 5);
    console.log(`  ${'NO'.padStart(3)}  ${'NIP/NIK'.padEnd(20)} ${'NAMA'.padEnd(lebar)}  JENIS`);
    for (const p of hasil.pegawai) {
      console.log(`  ${String(p.no).padStart(3)}  ${p.nip.padEnd(20)} ${p.nama.padEnd(lebar)}  ${p.jenis}`);
    }
  } else {
    console.log('  (tidak ada pegawai terbaca)');
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

  if (flags.has('--list') || (!filePdf && !flags.has('--help') && !flags.has('-h'))) {
    const isi = sp.daftarArsip();
    console.log(`\n📁 Arsip SP: ${sp.DIR_ARSIP}`);
    console.log(`   Jumlah: ${isi.jumlah} surat\n`);
    for (const a of isi.arsip) {
      console.log(`   • ${a.file}  →  ${a.jumlahPegawai} pegawai  (${a.namaFileAsli})`);
    }
    console.log('');
    return;
  }
  if (flags.has('--help') || flags.has('-h')) {
    console.log(fs.readFileSync(__filename, 'utf-8').split('*/')[0].split('/**')[1].replace(/^ \* ?/gm, ''));
    return;
  }

  const pdf = path.resolve(filePdf);

  try {
    if (flags.has('--simpan')) {
      const r = sp.simpanSp(pdf);
      if (flags.has('--json')) {
        console.log(JSON.stringify({ duplikat: r.duplikat, file: r.file, metaFile: r.metaFile, hasil: r.hasil }, null, 2));
      } else {
        tampilkanRingkasan(r.hasil);
        console.log(r.duplikat
          ? `♻️  Sudah pernah diarsipkan (isi identik) → ${r.file}`
          : `💾 Tersimpan → ${r.file}\n   metadata → ${r.metaFile}`);
        console.log('');
      }
      return;
    }

    const hasil = sp.parsePdf(pdf, { simpanTeks: flags.has('--dump') });

    if (flags.has('--dump')) {
      console.log('\n═════ TEKS MENTAH (pdftotext -layout) ═════\n');
      console.log(hasil.teksMentah);
      delete hasil.teksMentah;
    }
    if (flags.has('--json')) console.log(JSON.stringify(hasil, null, 2));
    else tampilkanRingkasan(hasil);
  } catch (err) {
    if (err.code === 'PERLU_OCR') {
      console.error('\n❌ PDF hasil scan (tidak ada layer teks). Modul ini butuh PDF teks.');
      console.error('   Solusi: cetak ulang/ekspor SP sebagai PDF teks, atau OCR dulu (belum termasuk).\n');
    } else {
      console.error(`\n❌ ${err.message}\n`);
    }
    process.exit(1);
  }
}

const fs = require('fs');
main();
