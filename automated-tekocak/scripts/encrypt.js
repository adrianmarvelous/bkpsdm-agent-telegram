/**
 * Enkrip/dekrip master-pegawai.csv
 *
 * Cara pakai:
 *   node scripts/encrypt.js          → Enkrip CSV (hasilkan .enc)
 *   node scripts/encrypt.js decrypt  → Dekrip CSV (kembalikan ke .csv)
 *
 * Password enkripsi dari: .env → CSV_ENCRYPT_KEY
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load .env manual (biar ga dependen ke dotenv)
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const [k, ...v] = line.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  }
}

const KEY = process.env.CSV_ENCRYPT_KEY;
if (!KEY || KEY.length < 8) {
  console.error('❌ Isi CSV_ENCRYPT_KEY di .env dulu! (min 8 karakter)');
  process.exit(1);
}

const csvPath = path.join(__dirname, '..', 'master-pegawai.csv');
const encPath = path.join(__dirname, '..', 'master-pegawai.csv.enc');

const mode = process.argv[2] === 'decrypt' ? 'decrypt' : 'encrypt';

function encrypt(text) {
  const key = crypto.createHash('sha256').update(KEY).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf-8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(encrypted) {
  const key = crypto.createHash('sha256').update(KEY).digest();
  const parts = encrypted.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encryptedText = Buffer.from(parts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
  return decrypted.toString('utf-8');
}

if (mode === 'encrypt') {
  if (!fs.existsSync(csvPath)) {
    console.error('❌ master-pegawai.csv tidak ditemukan!');
    process.exit(1);
  }
  const data = fs.readFileSync(csvPath, 'utf-8');
  const encrypted = encrypt(data);
  fs.writeFileSync(encPath, encrypted, 'utf-8');
  console.log('✅ CSV berhasil dienkrip → master-pegawai.csv.enc');
  console.log('   Hapus CSV asli? (y/n)');
} else {
  if (!fs.existsSync(encPath)) {
    console.error('❌ master-pegawai.csv.enc tidak ditemukan!');
    process.exit(1);
  }
  const data = fs.readFileSync(encPath, 'utf-8');
  const decrypted = decrypt(data);
  fs.writeFileSync(csvPath, decrypted, 'utf-8');
  console.log('✅ CSV berhasil didekrip → master-pegawai.csv');
}
