/**
 * Automasi Kantorku WFH — Headless mode untuk VPS
 *
 * Cara pakai:
 *   node index.js 2026-07-31          → isi WFH tanggal 31 Juli 2026
 *   HEADLESS=true node index.js ...   → mode headless (VPS)
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { chromium } = require('playwright');

const NIK = process.env.NIK;
const PASSWORD = process.env.PASSWORD;
const HEADLESS = process.env.HEADLESS !== 'false'; // default headless
const LOGIN_URL = 'https://kantorku.surabaya.go.id/login';
const WFA_URL = 'https://kantorku.surabaya.go.id/admin?modul=wfa&child=jadwal_wfa';
const CSV_PATH = path.join(__dirname, 'pegawai bkd non prigen.csv');
const CSV_ENC_PATH = path.join(__dirname, 'pegawai bkd non prigen.csv.enc');
const TANGGAL_WFH = process.argv[2];

// Enkripsi key (sama dengan CSV_ENCRYPT_KEY di automated-tekocak)
const CSV_KEY = 'Tek0Cak_Enkrip2026!';

function decryptCsv(encryptedData) {
  const key = crypto.createHash('sha256').update(CSV_KEY).digest();
  const parts = encryptedData.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encryptedText = Buffer.from(parts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString('utf-8');
}

function loadCsvData() {
  // Coba .enc dulu, fallback ke .csv
  if (fs.existsSync(CSV_ENC_PATH)) {
    const encrypted = fs.readFileSync(CSV_ENC_PATH, 'utf-8');
    return decryptCsv(encrypted);
  }
  if (fs.existsSync(CSV_PATH)) {
    console.warn('⚠️  CSV tidak terenkripsi! Enkrip dulu untuk keamanan data.');
    return fs.readFileSync(CSV_PATH, 'utf-8');
  }
  throw new Error(`File CSV tidak ditemukan: ${CSV_PATH} atau ${CSV_ENC_PATH}`);
}

if (!TANGGAL_WFH || !/^\d{4}-\d{2}-\d{2}$/.test(TANGGAL_WFH)) {
  console.error('❌ Gunakan format: node index.js YYYY-MM-DD');
  console.error('   Contoh: node index.js 2026-07-31');
  process.exit(1);
}

(async () => {
  console.log(`🚀 KantorKu WFH — ${TANGGAL_WFH}`);
  console.log(`   Mode: ${HEADLESS ? 'Headless' : 'Visible'}`);

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  try {
    // ========== BACA CSV ==========
    console.log('\n📂 Membaca file CSV...');
    const csvRaw = loadCsvData();
    const lines = csvRaw.split('\n').filter(line => line.trim() !== '');
    const header = lines[0].split(';');
    const idxNip = header.indexOf('NIP/NIK');
    const idxNama = header.indexOf('NAMA');
    const idxKet = header.indexOf('KET');

    if (idxNip === -1 || idxKet === -1) {
      throw new Error('Kolom NIP/NIK atau KET tidak ditemukan di CSV');
    }

    const pegawaiWFH = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(';');
      if (cols.length > idxKet && cols[idxKet]?.trim() === 'WFH') {
        pegawaiWFH.push({
          nip: cols[idxNip]?.trim(),
          nama: idxNama >= 0 ? (cols[idxNama]?.trim() || '-') : (cols[3]?.trim() || '-')
        });
      }
    }

    console.log(`   📋 ${pegawaiWFH.length} pegawai dengan status WFH`);
    if (pegawaiWFH.length === 0) {
      console.log('❌ Tidak ada pegawai WFH.');
      await browser.close();
      return;
    }

    // ========== LOGIN ==========
    console.log('\n📄 Login ke KantorKu...');
    await page.goto(LOGIN_URL, { waitUntil: 'load', timeout: 60000 });
    await page.waitForSelector('input[name="nik"]', { timeout: 10000 });
    await page.fill('input[name="nik"]', NIK);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');

    // Tunggu dialog login
    try {
      await page.waitForSelector('.jconfirm-content, .jconfirm-box, [role="dialog"]', { timeout: 15000 });
      console.log('✅ Dialog login muncul');
      // Klik OK
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
          if (btn.textContent.trim().toLowerCase() === 'ok') { btn.click(); return; }
        }
        const dialogBtns = document.querySelectorAll('.jconfirm-buttons button');
        if (dialogBtns.length > 0) dialogBtns[0].click();
      });
    } catch {
      console.log('⚠️  Tidak ada dialog, lanjut...');
    }

    await page.waitForTimeout(2000);
    const currentUrl = page.url();
    if (currentUrl.includes('/home') || currentUrl.includes('/dashboard')) {
      console.log('✅ Login berhasil!');
    } else {
      console.log(`⚠️  Login mungkin gagal. URL: ${currentUrl}`);
    }

    // ========== NAVIGASI WFA ==========
    console.log('\n📍 Buka halaman WFA...');
    await page.goto(WFA_URL, { waitUntil: 'load', timeout: 30000 });
    console.log('✅ Sampai di halaman WFA');

    // Pilih instansi BKPSDM dulu — karena tambah() cek variable instan
    console.log('🔍 Memilih instansi BKPSDM...');
    await page.waitForSelector('select[name="instansilokasi"]', { timeout: 10000 });
    await page.selectOption('select[name="instansilokasi"]', '3.02.00.00.00');
    await page.waitForTimeout(1000); // Tunggu DataTable reload
    console.log('✅ Instansi BKPSDM terpilih');

    // Klik tombol "Jadwal Work From Home"
    console.log('🔍 Mencari tombol Jadwal Work From Home...');
    await page.waitForSelector('div.btn.btn-primary', { timeout: 10000 });
    // Pake evaluate langsung biar pasti trigger tambah()
    await page.evaluate(() => {
      const btn = document.querySelector('div.btn.btn-primary');
      if (btn && btn.getAttribute('onclick')?.includes('tambah')) {
        tambah();
      } else {
        // Fallback: Playwright click
        btn?.click();
      }
    });
    console.log('✅ Tombol Jadwal WFH diklik');

    // Tunggu modal terbuka & Select2 siap
    await page.waitForSelector('#pegawai', { timeout: 30000 });
    // Tunggu sampai Select2 benar-benar siap (options + data select2)
    await page.waitForFunction(() => {
      const select = document.querySelector('#pegawai');
      if (!select) return false;
      if (select.options.length === 0) return false;
      if (typeof jQuery === 'undefined') return false;
      if (!jQuery(select).data('select2')) return false;
      return true;
    }, { timeout: 15000 });
    console.log('✅ Modal & Select2 siap');

    // ========== ISI FORM ==========
    console.log('\n📝 Mengisi form WFH...');

    // Tanggal
    await page.evaluate((tgl) => {
      const input = document.querySelector('#tanggal_wfh');
      if (input) {
        input.value = tgl;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, TANGGAL_WFH);

    // Nomor Surat
    await page.evaluate(() => {
      const input = document.querySelector('#no_surat');
      if (input) {
        input.value = '800/11641/436.8.4/2026';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    // Tanggal Surat
    await page.evaluate(() => {
      const input = document.querySelector('#tgl_surat');
      if (input) {
        input.value = '2026-07-17';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    // Pilih pegawai WFH via Select2
    console.log(`   👤 Memilih ${pegawaiWFH.length} pegawai...`);
    const selectResult = await page.evaluate((daftarPegawai) => {
      const select = document.querySelector('#pegawai');
      if (!select) return { success: false, message: 'Select #pegawai tidak ditemukan' };

      const foundValues = [];
      const notFound = [];

      for (const peg of daftarPegawai) {
        let matched = false;
        for (const opt of select.options) {
          if (opt.text.includes(peg.nip)) {
            foundValues.push(opt.value);
            matched = true;
            break;
          }
        }
        if (!matched) notFound.push(peg.nip);
      }

      // Via Select2 API — trigger change agar Select2 update UI
      jQuery(select).val(foundValues).trigger('change');

      return {
        success: true,
        total: daftarPegawai.length,
        terpilih: foundValues.length,
        tidakDitemukan: notFound.length,
        notFound
      };
    }, pegawaiWFH);

    if (selectResult.success) {
      console.log(`   ✅ ${selectResult.terpilih}/${selectResult.total} pegawai terpilih`);
      if (selectResult.tidakDitemukan > 0) {
        console.log(`   ⚠️  ${selectResult.tidakDitemukan} tidak ditemukan: ${selectResult.notFound.join(', ')}`);
      }
    } else {
      console.log(`   ❌ ${selectResult.message}`);
    }

    // Keterangan
    await page.evaluate(() => {
      const ta = document.querySelector('#keterangan');
      if (ta) {
        ta.value = 'WFH';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    // Link SP
    await page.evaluate(() => {
      const input = document.querySelector('#esurat');
      if (input) {
        input.value = 'https://esurat.surabaya.go.id/upload/esign/2026/July/17/1160346/1160346_signed.pdf';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    console.log('✅ Semua field terisi!');

    // ========== SAVE ==========
    console.log('\n💾 Menyimpan...');
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent.trim().toLowerCase() === 'save changes') { btn.click(); return; }
      }
    });
    console.log('✅ Tombol Save diklik!');
    await page.waitForTimeout(3000);
    console.log('\n✅ ✅ WFH BERHASIL!');

  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  } finally {
    await browser.close();
    console.log('🛑 Browser ditutup.');
  }
})();
