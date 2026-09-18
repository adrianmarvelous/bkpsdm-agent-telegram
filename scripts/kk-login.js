#!/usr/bin/env node
'use strict';
/**
 * Login KantorKu via Playwright DENGAN membaca kredensial langsung dari .env.
 * Aman dari salah ketik manual (tidak ada copy-paste password ke terminal/chat).
 *
 * Pakai:
 *   node scripts/kk-login.js                 # login + buka halaman WFA
 *   node scripts/kk-login.js --url <url>     # login + buka URL tertentu
 *   node scripts/kk-login.js --kecuali-pw    # login tanpa password (uji deteksi)
 *
 * Output: JSON hasil (url akhir, judul, ada/tidak tabel) di akhir → mudah diaudit.
 * Mode ini READ-ONLY: hanya login + navigasi, tidak mengubah/menghapus data.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const LOGIN_URL = 'https://kantorku.surabaya.go.id/login';
const WFA_URL = 'https://kantorku.surabaya.go.id/admin?modul=wfa&child=jadwal_wfa';

function dariEnv(key) {
  // utamakan process.env, fallback baca file .env (cocokkan baris persis)
  if (process.env[key]) return process.env[key];
  const txt = fs.readFileSync(ENV_FILE, 'utf-8');
  for (const line of txt.split('\n')) {
    if (line.startsWith(key + '=')) return line.slice(key.length + 1).replace(/\r$/, '');
  }
  return '';
}

(async () => {
  const argv = process.argv.slice(2);
  const idxUrl = argv.indexOf('--url');
  const URL_TUJUAN = idxUrl >= 0 ? argv[idxUrl + 1] : WFA_URL;
  const TANPA_PW = argv.includes('--kecuali-pw');

  const NIK = dariEnv('KANTORKU_NIK');
  const PW = dariEnv('KANTORKU_PASSWORD');

  if (!NIK || !PW) {
    console.error('❌ KANTORKU_NIK / KANTORKU_PASSWORD tidak ditemukan di .env');
    process.exit(1);
  }
  // hanya laporkan bentuknya, JANGAN cetak isinya
  console.log(`🔑 Kredensial dari .env — NIK: ${NIK.slice(0, 4)}*** | password: ${PW.length} karakter`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  const hasil = { login: null, url: null, judul: null, peringatan: [] };

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'load', timeout: 60000 });
    await page.waitForSelector('input[name="nik"]', { timeout: 15000 });
    await page.fill('input[name="nik"]', NIK);
    if (TANPA_PW) {
      console.log('⚠️  Mode --kecuali-pw: password TIDAK diisi (uji deteksi saja)');
    } else {
      await page.fill('input[name="password"]', PW);
    }
    await page.click('button[type="submit"]');

    // tunggu salah satu: dialog gagal, atau halaman berubah
    await page.waitForTimeout(4000);

    const dialog = await page.$('.jconfirm-content, .jconfirm-box, [role="dialog"]');
    if (dialog) {
      const teks = (await dialog.innerText()).trim();
      // PENTING: dialog muncul untuk KEDUA kasus (sukses & gagal).
      // "Login Failed" / "salah password" = gagal; "Berhasil Login" = sukses.
      const gagal = /gagal|failed|salah|tidak valid|wrong/i.test(teks);
      hasil.login = gagal ? 'GAGAL' : 'BERHASIL';
      hasil.dialogTeks = teks.slice(0, 200);
      if (gagal) {
        hasil.peringatan.push(teks.slice(0, 200));
        console.log('❌ LOGIN GAGAL:', teks.slice(0, 200));
      } else {
        console.log('✅ Dialog:', teks.replace(/\s+/g, ' ').slice(0, 120));
      }
      // tutup dialog
      await page.evaluate(() => {
        for (const b of document.querySelectorAll('button')) {
          if (b.textContent.trim().toLowerCase() === 'ok') { b.click(); return; }
        }
      });
      await page.waitForTimeout(1500);
      // verifikasi ulang: sudah tidak di /login = berhasil
      if (page.url().includes('/login') === false) hasil.login = 'BERHASIL';
    } else {
      hasil.login = page.url().includes('/login') ? 'GAGAL' : 'BERHASIL';
      console.log(hasil.login === 'BERHASIL' ? '✅ Login berhasil (tanpa dialog)' : '❌ Masih di halaman login');
    }

    if (hasil.login === 'BERHASIL') {
      console.log(`\n📍 Buka: ${URL_TUJUAN}`);
      await page.goto(URL_TUJUAN, { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(3000);
      hasil.url = page.url();
      hasil.judul = await page.title();
      console.log('   URL   :', hasil.url);
      console.log('   Judul :', hasil.judul);

      // inventaris elemen penting untuk membangun selector
      const info = await page.evaluate(() => {
        const out = {
          select: [], input: [], tombolMenarik: [], tabel: [],
          judulHalaman: document.querySelector('h1,h2,h3,h4,.card-title,.page-title')?.innerText?.trim() || null,
        };
        document.querySelectorAll('select').forEach((s) => {
          out.select.push({
            name: s.name || null, id: s.id || null,
            jumlahOpsi: s.options.length,
            opsiContoh: Array.from(s.options).slice(0, 8).map(o => `${o.value}=${o.text.trim()}`),
          });
        });
        document.querySelectorAll('input').forEach((i) => {
          out.input.push({
            name: i.name || null, id: i.id || null, type: i.type,
            placeholder: i.placeholder || null, value: i.value || null,
          });
        });
        document.querySelectorAll('button, a.btn, div.btn').forEach((b) => {
          const t = (b.innerText || '').trim();
          if (t && t.length < 50) {
            out.tombolMenarik.push({ teks: t, onclick: (b.getAttribute('onclick') || '').slice(0, 80), kelas: b.className.slice(0, 60) });
          }
        });
        document.querySelectorAll('table').forEach((t) => {
          const head = Array.from(t.querySelectorAll('thead th')).map(th => th.innerText.trim());
          out.tabel.push({ id: t.id || null, kelas: t.className.slice(0, 60), kolom: head, baris: t.querySelectorAll('tbody tr').length });
        });
        return out;
      });

      hasil.InfoHalaman = info;
      console.log('\n════ INVENTARIS ELEMEN ════');
      console.log(JSON.stringify(info, null, 2));

      // simpan teks halaman untuk audit
      const teksHal = await page.evaluate(() => document.body.innerText);
      fs.writeFileSync('/tmp/kk-halaman.txt', teksHal, 'utf-8');
      console.log('\n📄 Teks halaman → /tmp/kk-halaman.txt');
    }
  } catch (e) {
    console.error('❌ Error:', e.message);
    hasil.peringatan.push(e.message);
  } finally {
    await browser.close();
  }

  console.log('\n════ HASIL AKHIR ════');
  console.log(JSON.stringify({ login: hasil.login, url: hasil.url, judul: hasil.judul, peringatan: hasil.peringatan }, null, 2));
})();
