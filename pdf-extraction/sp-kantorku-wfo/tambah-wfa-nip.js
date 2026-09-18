/**
 * Tambah Jadwal WFH KantorKu — berbasis DAFTAR NIP TARGET
 * ======================================================
 * Beda dari ../automated-kantorku-wfh/index.js yang mengambil SEMUA pegawai
 * ber-KET WFH dari API master, script ini menambah HANYA NIP yang diberikan
 * lewat --nip-file, supaya bisa mengecualikan orang tertentu.
 *
 * Kasus pemakaian (18 Sep 2026): 38 pegawai KET=WFH di master, tapi 6 orang
 * terbit SP WFO (masuk kantor) → hanya 32 yang boleh dijadwalkan WFH.
 *
 * Alur:
 *   1. Login KantorKu (tunggu dialog hasil login, bukan cek URL dini)
 *   2. Buka halaman WFA, pilih instansi BKPSDM
 *   3. Klik "Jadwal Work From Home" → tambah()
 *   4. Isi tanggal, no surat, tgl surat, esurat (URL SP) + pilih pegawai Select2
 *   5. Save Changes
 *
 * Pakai:
 *   node tambah-wfa-nip.js --tanggal 2026-09-18 --nip-file /tmp/wfh-32-nip.txt --dry-run
 *   node tambah-wfa-nip.js --tanggal 2026-09-18 --nip-file /tmp/wfh-32-nip.txt --eksekusi \
 *        --no-surat "..." --tgl-surat 2026-09-17 --esurat "https://..."
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const LOGIN_URL = 'https://kantorku.surabaya.go.id/login';
const WFA_URL = 'https://kantorku.surabaya.go.id/admin?modul=wfa&child=jadwal_wfa';
const INSTANSI_BKPSDM = '3.02.00.00.00';

// ---------- argumen ----------
const argv = process.argv.slice(2);
function arg(nama, wajib = false) {
  const i = argv.indexOf(`--${nama}`);
  if (i === -1 || !argv[i + 1]) {
    if (wajib) { console.error(`❌ Wajib: --${nama} <nilai>`); process.exit(1); }
    return null;
  }
  return argv[i + 1];
}
const TANGGAL = arg('tanggal', true);
const NIP_FILE = arg('nip-file', true);
const NO_SURAT = arg('no-surat');
const TGL_SURAT = arg('tgl-surat');
const ESURAT = arg('esurat');
const KETERANGAN = arg('keterangan') || 'WFH';
const EKSEKUSI = argv.includes('--eksekusi');

if (!/^\d{4}-\d{2}-\d{2}$/.test(TANGGAL)) { console.error('❌ --tanggal harus YYYY-MM-DD'); process.exit(1); }
if (!fs.existsSync(NIP_FILE)) { console.error(`❌ File NIP tidak ditemukan: ${NIP_FILE}`); process.exit(1); }

const NIP_LIST = fs.readFileSync(NIP_FILE, 'utf-8')
  .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));

if (NIP_LIST.length === 0) { console.error('❌ Daftar NIP kosong'); process.exit(1); }
if (EKSEKUSI && (!NO_SURAT || !TGL_SURAT)) {
  console.error('❌ Mode --eksekusi butuh --no-surat dan --tgl-surat (biar tidak menebak).');
  process.exit(1);
}

console.log('══════════════════════════════════════════════════════');
console.log('  TAMBAH JADWAL WFH — KANTORKU (by NIP)');
console.log('══════════════════════════════════════════════════════');
console.log(`  Tanggal    : ${TANGGAL}`);
console.log(`  Daftar NIP : ${NIP_FILE} (${NIP_LIST.length} NIP)`);
console.log(`  No Surat   : ${NO_SURAT || '-'}`);
console.log(`  Tgl Surat  : ${TGL_SURAT || '-'}`);
console.log(`  Esurat     : ${ESURAT ? ESURAT.slice(0, 70) + '…' : '-'}`);
console.log(`  Keterangan : ${KETERANGAN}`);
console.log(`  MODE       : ${EKSEKUSI ? '⚠️  EKSEKUSI (benar-benar tambah)' : '🛡️  DRY-RUN (tidak menyimpan)'}`);
console.log('');

(async () => {
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  try {
    // ---------- LOGIN ----------
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('input[name="nik"]', { timeout: 30000 });
    await page.fill('input[name="nik"]', process.env.KANTORKU_NIK);
    await page.fill('input[name="password"]', process.env.KANTORKU_PASSWORD);
    await page.click('button[type="submit"]');

    // Tunggu dialog hasil login (sukses/gagal) — JANGAN cek URL dini.
    let pesanDialog = '';
    for (let c = 1; c <= 20; c++) {
      await page.waitForTimeout(1000);
      const t = await page.evaluate(() => {
        for (const m of document.querySelectorAll('.swal-modal, .swal2-popup, .modal.show, .jconfirm-box, [role="dialog"]')) {
          const x = (m.innerText || '').trim();
          if (x) return x;
        }
        return '';
      });
      if (t) { pesanDialog = t; break; }
      if (!page.url().includes('/login')) break;
    }
    await page.evaluate(() => {
      for (const b of document.querySelectorAll('button')) {
        const t = b.textContent.trim().toLowerCase();
        if (t === 'ok' || t === 'lanjut' || t === 'tutup') { b.click(); return; }
      }
      const j = document.querySelector('.jconfirm-buttons button');
      if (j) j.click();
    });
    await page.waitForTimeout(2000);

    const gagal = /salah|gagal|tidak ditemukan|belum terdaftar|kesalahan/i.test(pesanDialog);
    if (gagal) throw new Error(`Login gagal — dialog: "${pesanDialog.replace(/\s+/g, ' ')}"`);
    console.log(`✅ Login berhasil${pesanDialog ? ` (dialog: ${pesanDialog.replace(/\s+/g, ' ').slice(0, 60)})` : ''}`);

    // ---------- HALAMAN WFA ----------
    await page.goto(WFA_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(3000);
    if (page.url().includes('/login')) throw new Error('Sesi tidak diterima — masih di /login');
    console.log('✅ Halaman WFA terbuka');

    // Pilih instansi BKPSDM (wajib sebelum tambah())
    await page.waitForSelector('select[name="instansilokasi"]', { timeout: 20000 });
    await page.selectOption('select[name="instansilokasi"]', INSTANSI_BKPSDM);
    await page.waitForTimeout(1500);
    console.log('✅ Instansi BKPSDM terpilih');

    // Klik tombol Jadwal Work From Home → tambah()
    await page.waitForSelector('div.btn.btn-primary', { timeout: 20000 });
    await page.evaluate(() => {
      const btn = document.querySelector('div.btn.btn-primary');
      if (btn && (btn.getAttribute('onclick') || '').includes('tambah')) tambah();
      else btn?.click();
    });
    console.log('✅ Modal tambah dibuka');

    await page.waitForSelector('#pegawai', { timeout: 30000 });
    await page.waitForFunction(() => {
      const s = document.querySelector('#pegawai');
      if (!s || s.options.length === 0) return false;
      if (typeof jQuery === 'undefined') return false;
      return !!jQuery(s).data('select2');
    }, { timeout: 20000 });
    console.log('✅ Modal & Select2 siap');

    // ---------- ISI FORM ----------
    await page.evaluate((tgl) => {
      const el = document.querySelector('#tanggal_wfh');
      if (!el) return;
      if (el._flatpickr) el._flatpickr.setDate(tgl, true);
      else { el.value = tgl; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
    }, TANGGAL);
    console.log(`✅ Tanggal WFH: ${TANGGAL}`);

    if (NO_SURAT) await page.evaluate((v) => { const e = document.querySelector('#no_surat'); if (e) { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } }, NO_SURAT);
    if (TGL_SURAT) await page.evaluate((v) => { const e = document.querySelector('#tgl_surat'); if (e) { if (e._flatpickr) e._flatpickr.setDate(v, true); else { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } } }, TGL_SURAT);
    if (ESURAT) await page.evaluate((v) => { const e = document.querySelector('#esurat'); if (e) { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } }, ESURAT);
    await page.evaluate((v) => { const e = document.querySelector('#keterangan'); if (e) { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } }, KETERANGAN);
    console.log('✅ No surat / tgl surat / esurat / keterangan terisi');

    // ---------- PILIH PEGAWAI (by NIP) ----------
    const sel = await page.evaluate((nips) => {
      const select = document.querySelector('#pegawai');
      if (!select) return { ok: false, msg: 'Select #pegawai tidak ada' };
      const values = [], tidakAda = [], ketemu = [];
      // Kumpulkan seluruh opsi sekali (text mengandung NIP)
      const opsi = Array.from(select.options).map(o => ({ v: o.value, t: o.text }));
      for (const nip of nips) {
        const hit = opsi.find(o => o.t.includes(nip));
        if (hit) { values.push(hit.v); ketemu.push(hit.t.trim()); }
        else tidakAda.push(nip);
      }
      jQuery(select).val(values).trigger('change');
      return { ok: true, total: nips.length, terpilih: values.length, tidakAda, ketemu };
    }, NIP_LIST);

    if (!sel.ok) throw new Error(sel.msg);
    console.log(`✅ Pegawai terpilih: ${sel.terpilih}/${sel.total}`);
    if (sel.tidakAda.length) console.log(`   ⚠️  ${sel.tidakAda.length} NIP tidak ada di dropdown: ${sel.tidakAda.join(', ')}`);
    sel.ketemu.forEach((t, i) => console.log(`   ${String(i + 1).padStart(2)}. ${t}`));

    if (!EKSEKUSI) {
      console.log('\n🛡️  DRY-RUN — form TIDAK disimpan. Cek daftar di atas, lalu jalankan dengan --eksekusi.');
      console.log('   (modal dibiarkan terbuka sebentar lalu ditutup tanpa save)');
      await page.waitForTimeout(2000);
      return;
    }

    // ---------- SAVE ----------
    console.log('\n💾 Menyimpan...');
    await page.evaluate(() => {
      for (const b of document.querySelectorAll('button')) {
        if (b.textContent.trim().toLowerCase() === 'save changes') { b.click(); return; }
      }
    });
    await page.waitForTimeout(5000);

    // Baca respons dialog (berhasil / gagal)
    let resp = '';
    for (let c = 1; c <= 15; c++) {
      resp = await page.evaluate(() => {
        for (const m of document.querySelectorAll('.swal-modal, .swal2-popup, .jconfirm-box, [role="dialog"], .alert')) {
          const x = (m.innerText || '').trim();
          if (x) return x;
        }
        return '';
      });
      if (resp) break;
      await page.waitForTimeout(1000);
    }
    console.log(`\n📨 Respons: ${resp ? resp.replace(/\s+/g, ' ').slice(0, 200) : '(tidak ada dialog)'}`);
    console.log(/berhasil/i.test(resp) && !/gagal/i.test(resp) ? '\n✅ WFH BERHASIL DISIMPAN!' : '\n⚠️  Perlu verifikasi manual — cek halaman WFA.');

  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
    console.log('🛑 Browser ditutup.');
  }
})();
