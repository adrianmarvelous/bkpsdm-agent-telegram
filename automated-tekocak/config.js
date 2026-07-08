/**
 * Konfigurasi bersama untuk semua task TEKO-CAK
 *
 * Baca dari file .env (wajib ada) — lihat contoh di .env.example
 * Jangan commit .env ke git!
 *
 * Daftar NIP otomatis dibaca dari master-pegawai.csv.enc (terenkripsi AES-256)
 * atau master-pegawai.csv (plain text) sebagai fallback.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

// ===== Dekrip CSV =====
function decryptCsv(encryptedData, key) {
  const hashKey = crypto.createHash('sha256').update(key).digest();
  const parts = encryptedData.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encryptedText = Buffer.from(parts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', hashKey, iv);
  return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString('utf-8');
}

// ===== Load NIP dari CSV (encrypted preferred) =====
function loadNipFromCsv() {
  const encPath = path.join(__dirname, 'master-pegawai.csv.enc');
  const csvPath = path.join(__dirname, 'master-pegawai.csv');
  let content = null;

  // Prioritaskan file terenkripsi
  if (fs.existsSync(encPath)) {
    const key = process.env.CSV_ENCRYPT_KEY;
    if (!key) {
      console.warn('⚠️  CSV_ENCRYPT_KEY tidak ditemukan di .env');
      return [];
    }
    try {
      const encrypted = fs.readFileSync(encPath, 'utf-8');
      content = decryptCsv(encrypted, key);
      console.log('  ✓ Membaca NIP dari master-pegawai.csv.enc (AES-256)');
    } catch (e) {
      console.warn('⚠️  Gagal dekrip CSV.enc:', e.message);
      return [];
    }
  } else if (fs.existsSync(csvPath)) {
    content = fs.readFileSync(csvPath, 'utf-8');
    console.warn('⚠️  CSV tidak terenkripsi! Enkrip dulu: node scripts/encrypt.js');
  } else {
    console.warn('⚠️  master-pegawai.csv tidak ditemukan, pakai fallback NIP');
    return [];
  }

  const lines = content.trim().split('\n');
  const nips = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const match = line.match(/^"(\d+)"/);
    if (match) nips.push(match[1]);
  }
  return nips;
}

// ===== Filter NIP dari .env (opsional) =====
function filterNip(nips) {
  const filter = process.env.TEKOCAK_FILTER_NIP;
  if (!filter) return nips;
  const allowed = filter.split(',').map(s => s.trim());
  return nips.filter(nip => allowed.includes(nip));
}

const semuaNip = loadNipFromCsv();

module.exports = {
  // Browser
  HEADLESS: process.env.TEKOCAK_HEADLESS === 'true' || false,

  // Login
  TEKOCAK_URL: process.env.TEKOCAK_URL || 'https://teko-cak.surabaya.go.id',
  USERNAME: process.env.TEKOCAK_USERNAME,
  PASSWORD: process.env.TEKOCAK_PASSWORD,
  TAHUN: process.env.TEKOCAK_TAHUN || '2026',

  // Generate Laporan
  HALAMAN_GENERATE: `${process.env.TEKOCAK_URL || 'https://teko-cak.surabaya.go.id'}/daftar_generate_laporan`,

  // Update Pegawai
  HALAMAN_PEGAWAI: `${process.env.TEKOCAK_URL || 'https://teko-cak.surabaya.go.id'}/lap_per_pegawai`,
  INSTANSI: 'BADAN KEPEGAWAIAN DAN PENGEMBANGAN SUMBER DAYA MANUSIA',

  // Daftar NIP — dari CSV, bisa difilter via .env
  DAFTAR_NIP: filterNip(semuaNip).length > 0 ? filterNip(semuaNip) : [
    '3578041306950011',
    '3578016205030003'
  ]
};
