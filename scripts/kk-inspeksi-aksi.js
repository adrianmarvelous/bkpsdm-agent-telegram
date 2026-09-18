#!/usr/bin/env node
'use strict';
/**
 * Inspeksi lanjutan (READ-ONLY):
 *  1. Isi lengkap fungsi hapus() — endpoint & parameter yang dipakai
 *  2. Dropdown status WFH (elemen pilih WFH/WFO/Semua)
 *  3. Cara filter tanggal bekerja (flatpickr + fungsi cari)
 *  4. Verifikasi alur filter tanpa menghapus apa pun
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
function dariEnv(key) {
  if (process.env[key]) return process.env[key];
  const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf-8');
  for (const line of txt.split('\n')) {
    if (line.startsWith(key + '=')) return line.slice(key.length + 1).replace(/\r$/, '');
  }
  return '';
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await page.goto('https://kantorku.surabaya.go.id/login', { waitUntil: 'load', timeout: 60000 });
    await page.fill('input[name="nik"]', dariEnv('KANTORKU_NIK'));
    await page.fill('input[name="password"]', dariEnv('KANTORKU_PASSWORD'));
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);
    await page.evaluate(() => { for (const b of document.querySelectorAll('button')) if (b.textContent.trim().toLowerCase() === 'ok') { b.click(); return; } });
    await page.waitForTimeout(1500);
    await page.goto('https://kantorku.surabaya.go.id/admin?modul=wfa&child=jadwal_wfa', { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(3500);
    console.log('✅ Login & halaman WFA siap\n');

    // --- 1. Fungsi hapus() LENGKAP ---
    const hapusFn = await page.evaluate(() => (typeof window.hapus === 'function' ? window.hapus.toString() : null));
    console.log('════ FUNGSI hapus() LENGKAP ════');
    console.log(hapusFn ? hapusFn.replace(/\s+/g, ' ') : '(tidak ditemukan)');

    // --- 2. Semua dropdown di area filter ---
    const dropdown = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('select').forEach((s) => {
        const opsi = Array.from(s.options).map(o => `${o.value}=${o.text.trim()}`);
        out.push({ name: s.name || null, id: s.id || null, kelas: String(s.className).slice(0, 80), opsi });
      });
      return out;
    });
    console.log('\n════ SEMUA DROPDOWN ════');
    console.log(JSON.stringify(dropdown, null, 2));

    // --- 3. Fungsi cari / filter ---
    const cariFn = await page.evaluate(() => {
      const hasil = {};
      for (const nama of ['cari', 'filter', 'caridata', 'loaddata', 'refresh', 'reload', 'getdata']) {
        if (typeof window[nama] === 'function') hasil[nama] = window[nama].toString().replace(/\s+/g, ' ').slice(0, 600);
      }
      return hasil;
    });
    console.log('\n════ FUNGSI CARI/FILTER ════');
    console.log(JSON.stringify(cariFn, null, 2));

    // --- 4. Struktur HTML area filter (untuk tahu tombol Cari onclick) ---
    const areaFilter = await page.evaluate(() => {
      // cari elemen yang memuat label 'Status WFH'
      const kandidat = [];
      document.querySelectorAll('*').forEach((el) => {
        const t = (el.textContent || '').trim();
        if (el.children.length <= 3 && /^Status WFH$/i.test(t)) {
          const induk = el.closest('.col-md-3, .col-md-4, .col-md-2, .form-group, .mb-3') || el.parentElement;
          kandidat.push({ tag: el.tagName, indukHTML: induk ? induk.outerHTML.slice(0, 900) : null });
        }
      });
      return kandidat.slice(0, 3);
    });
    console.log('\n════ AREA FILTER "STATUS WFH" ════');
    console.log(JSON.stringify(areaFilter, null, 2));

    // --- 5. tombol Cari: HTML + induk ---
    const btnCari = await page.evaluate(() => {
      let out = null;
      document.querySelectorAll('button').forEach((b) => {
        if ((b.innerText || '').trim().toLowerCase() === 'cari' && !out) {
          out = { outerHTML: b.outerHTML.slice(0, 400), induk: b.parentElement ? b.parentElement.outerHTML.slice(0, 700) : null };
        }
      });
      return out;
    });
    console.log('\n════ TOMBOL CARI ════');
    console.log(JSON.stringify(btnCari, null, 2));

  } catch (e) {
    console.error('❌', e.message);
  } finally {
    await browser.close();
  }
})();
