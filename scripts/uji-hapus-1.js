'use strict';
/** Uji metode hapus() via JS untuk SATU pegawai — verifikasi metode sebelum batch. */
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = '/home/ubuntu/bkpsdm-agent-telegram';
function dariEnv(k) {
  const t = fs.readFileSync(path.join(ROOT, '.env'), 'utf-8');
  for (const l of t.split('\n')) if (l.startsWith(k + '=')) return l.slice(k.length + 1).replace(/\r$/, '');
  return '';
}
const NIK_TARGET = process.argv[2];
const TANGGAL = '2026-09-19';
(async () => {
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    let masuk = false;
    for (let i = 1; i <= 3 && !masuk; i++) {
      try {
        await p.goto('https://kantorku.surabaya.go.id/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
        await p.waitForSelector('input[name="nik"]', { timeout: 30000 });
        masuk = true;
      } catch (e) {
        console.log('retry ' + i + ': ' + e.message.split('\n')[0]);
        await p.waitForTimeout(8000);
      }
    }
    if (!masuk) throw new Error('gagal buka login');
    await p.fill('input[name="nik"]', dariEnv('KANTORKU_NIK'));
    await p.fill('input[name="password"]', dariEnv('KANTORKU_PASSWORD'));
    await p.click('button[type="submit"]');
    await p.waitForTimeout(5000);
    await p.evaluate(() => { for (const x of document.querySelectorAll('button')) if (x.textContent.trim().toLowerCase() === 'ok') { x.click(); return; } });
    await p.waitForTimeout(2000);
    console.log('Login URL:', p.url());

    await p.goto('https://kantorku.surabaya.go.id/admin?modul=wfa&child=jadwal_wfa', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await p.waitForSelector('#data_list', { timeout: 30000 });
    await p.waitForTimeout(2500);

    await p.evaluate((tgl) => {
      const el = document.querySelector('#tanggal');
      if (el._flatpickr) el._flatpickr.setDate(tgl, true);
      else { el.value = tgl; el.dispatchEvent(new Event('change', { bubbles: true })); }
    }, TANGGAL);
    await p.evaluate(() => {
      const i = document.getElementById('filter_wfh');
      if (i) { i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('label[for="filter_wfh"]')?.click(); }
    });
    await p.click('#btn-filter');
    await p.waitForTimeout(4000);
    await p.evaluate(() => {
      const s = document.querySelector('select[name="data_list_length"]');
      if (s) { s.value = '100'; s.dispatchEvent(new Event('change', { bubbles: true })); }
      try { window.jQuery('#data_list').DataTable().page.len(100).draw(); } catch (e) {}
    });
    await p.waitForTimeout(4000);
    console.log('Info:', await p.evaluate(() => document.querySelector('#data_list_info')?.innerText?.trim()));

    const info = await p.evaluate((nik) => {
      let hasil = null;
      document.querySelectorAll('#data_list tbody tr').forEach((tr, i) => {
        const td = tr.querySelectorAll('td');
        if (td.length < 9) return;
        if ((td[3]?.innerText || '').replace(/[^0-9]/g, '') === nik) {
          const btn = tr.querySelector('button.btn-danger');
          hasil = { nama: td[2]?.innerText?.trim(), nip: td[3]?.innerText?.trim(), onclick: btn ? btn.getAttribute('onclick') : null, idx: i };
        }
      });
      return hasil;
    }, NIK_TARGET);
    console.log('Target:', JSON.stringify(info, null, 2));
    if (!info || !info.onclick) throw new Error('target/onclick tidak ditemukan');

    const m = info.onclick.match(/hapus\(([\s\S]*)\)\s*$/);
    console.log('Argumen:', m ? m[1].slice(0, 60) + '...' : '(GAGAL PARSE)');
    await p.evaluate((args) => { eval('hapus(' + args + ')'); }, m[1]);
    await p.waitForTimeout(1500);
    const dlgAda = await p.evaluate(() => !!document.querySelector('.jconfirm-box'));
    console.log('Dialog muncul:', dlgAda);
    console.log('Isi dialog:', await p.evaluate(() => document.querySelector('.jconfirm-box')?.innerText?.trim().replace(/\s+/g, ' ').slice(0, 150)));

    await p.evaluate(() => {
      const d = document.querySelector('.jconfirm-box');
      for (const x of d.querySelectorAll('button')) if (/^confirm$/i.test(x.textContent.trim())) { x.click(); return; }
      for (const x of d.querySelectorAll('button')) if (/confirm|ya|hapus/i.test(x.textContent.trim())) { x.click(); return; }
    });
    await p.waitForTimeout(3000);
    console.log('Hasil:', await p.evaluate(() => document.querySelector('.jconfirm-box')?.innerText?.trim().replace(/\s+/g, ' ').slice(0, 200)));

    await p.evaluate(() => { for (const x of document.querySelectorAll('.jconfirm-box button')) if (x.textContent.trim().toLowerCase() === 'ok') { x.click(); return; } });
    await p.waitForTimeout(2500);

    await p.click('#btn-filter');
    await p.waitForTimeout(4000);
    await p.evaluate(() => { try { window.jQuery('#data_list').DataTable().page.len(100).draw(); } catch (e) {} });
    await p.waitForTimeout(3000);
    console.log('SETELAH HAPUS ->', await p.evaluate(() => document.querySelector('#data_list_info')?.innerText?.trim()));
  } catch (e) { console.error('ERROR:', e.message); }
  finally { await b.close(); }
})();
