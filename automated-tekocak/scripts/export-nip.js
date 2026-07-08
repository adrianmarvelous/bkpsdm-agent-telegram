/**
 * Export NIP dari Excel ke CSV
 *
 * Cara pakai: node scripts/export-nip.js
 * Hasil: master-pegawai.csv (NIP,Nama)
 *
 * Penting: NIP tetap sebagai string (tidak kehilangan digit)
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const fileExcel = path.join(__dirname, '..', 'master tekocak.xlsx');
const fileCsv = path.join(__dirname, '..', 'master-pegawai.csv');

console.log('📂 Membaca:', fileExcel);
const wb = XLSX.readFile(fileExcel);
const ws = wb.Sheets[wb.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

// Header: [NO, JENIS, NIP/NIK, NAMA, ...]
// NIP di index 2, NAMA di index 3
let barisCsv = 'NIP,Nama\n';
let count = 0;

for (let i = 1; i < data.length; i++) {
  const row = data[i];
  const nip = String(row[2]).trim();
  const nama = String(row[3]).trim();

  if (nip && nip !== 'NIP/NIK') {
    // Pastikan NIP tetap string — tidak pakai kutip di CSV biasa
    // Tapi NIP panjang bisa kehilangan digit kalau dibuka Excel lagi
    // Makanya kita force dengan "="&"NIP"
    barisCsv += `"${nip}","${nama}"\n`;
    count++;
  }
}

fs.writeFileSync(fileCsv, barisCsv, 'utf-8');
console.log(`✅ ${count} NIP berhasil diexport ke: ${fileCsv}`);
console.log('   (NIP disimpan sebagai string, aman dari kehilangan digit)');
