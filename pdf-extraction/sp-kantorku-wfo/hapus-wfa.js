#!/usr/bin/env node
'use strict';
/**
 * Hapus Jadwal WFA KantorKu berdasarkan hasil ekstraksi SP PDF.
 * =============================================================
 * Alur:
 *   1. Login KantorKu (kredensial dari .env)
 *   2. Buka halaman WFA
 *   3. Isi filter: Tanggal + Status WFH (radio) → klik Cari
 *   4. Untuk setiap pegawai di PDF: cocokkan (NIP dulu, fallback nama) ke baris tabel
 *   5. Klik tombol hapus → konfirmasi
 *
 * PENTING — mode:
 *   --dry-run  (DEFAULT) hanya melaporkan apa yang AKAN dihapus, TIDAK mengklik
 *   --eksekusi            benar-benar menghapus (butuh flag ini eksplisit)
 *   --semua               hapus SEMUA baris hasil filter (bukan hanya yg ada di PDF)
 *
 * Pakai:
 *   node pdf-extraction/sp-kantorku-wfo/hapus-wfa.js --pdf <sp.pdf> --tanggal 2026-09-19
 *   node pdf-extraction/sp-kantorku-wfo/hapus-wfa.js --pdf <sp.pdf> --tanggal 2026-09-19 --eksekusi
 *   node pdf-extraction/sp-kantorku-wfo/hapus-wfa.js --tanggal 2026-09-19 --semua --eksekusi
 *   node pdf-extraction/sp-kantorku-wfo/hapus-wfa.js --pdf <sp.pdf> --tanggal 2026-09-19 --status wfh
 *
 * Status filter: semua (default) | wfh | tidak_wfh
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const sp = require('./index');

const ROOT = path.join(__dirname, '..', '..');
const ENV_FILE = path.join(ROOT, '.env');
const LOGIN_URL = 'https://kantorku.surabaya.go.id/login';
const WFA_URL = 'https://kantorku.surabaya.go.id/admin?modul=wfa&child=jadwal_wfa';

function dariEnv(key) {
  if (process.env[key]) return process.env[key];
  const txt = fs.readFileSync(ENV_FILE, 'utf-8');
  for (const line of txt.split('\n')) {
    if (line.startsWith(key + '=')) return line.slice(key.length + 1).replace(/\r$/, '');
  }
  return '';
}

function arg(nama, bawaan = null) {
  const i = process.argv.indexOf(nama);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : bawaan;
}

/** NIP dinormalisasi: buang non-digit, samakan NIP '-' (Non-ASN) → pakai NIK */
function normNip(s) {
  return String(s || '').replace(/[^0-9]/g, '');
}
/** Nama dinormalisasi: uppercase, buang gelar/tanda baca, ringkas spasi */
function normNama(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(S\.?E|S\.?KOM|S\.?T|S\.?TR\.?IP|S\.?SOS|S\.?AP|S\.?H|S\.?M|S\.?SI|DR|DRA|M\.?SI|MM|SE|SKOM|ST|SH|SAP|SSOS)\b/g, ' ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cocokkan nama longgar: semua kata nama-pendek ada di nama-panjang (atau sebaliknya) */
function namaMirip(a, b) {
  const x = normNama(a).split(' ').filter(Boolean);
  const y = normNama(b).split(' ').filter(Boolean);
  if (!x.length || !y.length) return false;
  const [p, q] = x.length <= y.length ? [x, y] : [y, x];
  return p.every((w) => q.includes(w));
}

(async () => {
  const PDF = arg('--pdf');
  const TANGGAL = arg('--tanggal');
  const STATUS = (arg('--status', 'semua') || 'semua').toLowerCase();
  const EKSEKUSI = process.argv.includes('--eksekusi');
  const SEMUA = process.argv.includes('--semua');
  const HEADLESS = process.env.HEADLESS !== 'false';

  if (!TANGGAL) {
    console.error('❌ Wajib: --tanggal YYYY-MM-DD');
    console.error('   Mode PDF   : --pdf <file.pdf> --tanggal YYYY-MM-DD [--status wfh] [--eksekusi]');
    console.error('   Mode semua : --tanggal YYYY-MM-DD --semua [--status wfh] [--eksekusi]');
    process.exit(1);
  }
  if (!SEMUA && !PDF) {
    console.error('❌ Wajib: --pdf <file.pdf>  (atau pakai --semua untuk hapus semua baris filter)');
    process.exit(1);
  }
  if (PDF && !fs.existsSync(PDF)) {
    console.error('❌ PDF tidak ditemukan:', PDF);
    process.exit(1);
  }
  if (!['semua', 'wfh', 'tidak_wfh'].includes(STATUS)) {
    console.error(`❌ --status harus: semua | wfh | tidak_wfh (diberi: ${STATUS})`);
    process.exit(1);
  }

  // ---- tentukan target ----
  // Mode --semua: target = SEMUA baris hasil filter (PDF opsional, hanya catatan)
  let hasil = null;
  let target = [];
  if (SEMUA) {
    if (PDF) hasil = sp.parsePdf(PDF);
  } else {
    hasil = sp.parsePdf(PDF);
    target = hasil.pegawai.map((p) => ({ ...p, kunciNip: normNip(p.nip), kunciNama: normNama(p.nama) }));
  }

  console.log('══════════════════════════════════════════════════════');
  console.log('  HAPUS JADWAL WFA — KANTORKU');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  PDF       : ${PDF ? path.basename(PDF) : '(tidak dipakai — mode --semua)'}`);
  console.log(`  Nomor SP  : ${hasil?.nomorSurat || '-'}`);
  console.log(`  Tanggal   : ${TANGGAL}  (filter KantorKu)`);
  console.log(`  Status    : ${STATUS}`);
  console.log(`  MODE      : ${EKSEKUSI ? '⚠️  EKSEKUSI (benar-benar hapus)' : '🛡️  DRY-RUN (tidak menghapus)'}${SEMUA ? ' + SEMUA BARIS FILTER' : ''}`);
  if (!SEMUA) {
    console.log(`  Target    : ${target.length} pegawai dari PDF`);
    console.log();
    target.forEach((t, i) => console.log(`   ${i + 1}. ${t.nama}  (${t.nip})`));
  } else {
    console.log('  Target    : SEMUA baris yang lolos filter (lihat hasil filter di bawah)');
  }
  console.log();

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const laporan = { pdf: PDF ? path.basename(PDF) : null, nomorSurat: hasil?.nomorSurat || null, tanggal: TANGGAL, status: STATUS, mode: (EKSEKUSI ? 'EKSEKUSI' : 'DRY-RUN') + (SEMUA ? ' + SEMUA' : ''), dihapus: [], tidakKetemu: [], gagal: [], barisTabel: [] };

  try {
    // ---------- login ----------
    // Retry goto: halaman KantorKu kadang lambat walau server responsif
    // (rate-limit sesi / antrian sisi klien). Coba beberapa kali sebelum menyerah.
    let masukLogin = false;
    let errTerakhir = null;
    for (let coba = 1; coba <= 3 && !masukLogin; coba++) {
      try {
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForSelector('input[name="nik"]', { timeout: 30000 });
        masukLogin = true;
      } catch (e) {
        errTerakhir = e;
        console.log(`   ⚠️  Login percobaan ${coba}/3 gagal: ${e.message.split('\n')[0]}`);
        if (coba < 3) {
          const jeda = coba * 8;
          console.log(`   ⏳ Tunggu ${jeda} detik lalu coba lagi...`);
          await page.waitForTimeout(jeda * 1000);
        }
      }
    }
    if (!masukLogin) throw new Error(`Gagal membuka halaman login setelah 3 percobaan: ${errTerakhir?.message?.split('\n')[0]}`);
    console.log('✅ Halaman login terbuka');

    await page.fill('input[name="nik"]', dariEnv('KANTORKU_NIK'));
    await page.fill('input[name="password"]', dariEnv('KANTORKU_PASSWORD'));
    await page.click('button[type="submit"]');

    // Tunggu hasil login. PENTING: dialog hasil (sukses ATAU gagal) muncul
    // sebagai swal "OK" yang butuh ~beberapa detik. Verifikasi hanya lewat URL
    // terlalu dini → sukses disalahartikan gagal (bug 18 Sep 2026).
    // Jadi: tunggu dialog muncul dulu, baca teksnya, baru tutup.
    let pesanDialog = '';
    for (let coba = 1; coba <= 20; coba++) {
      await page.waitForTimeout(1000);
      const info = await page.evaluate(() => {
        const sel = '.swal-modal, .swal2-popup, .modal.show, div[role="dialog"]';
        for (const m of document.querySelectorAll(sel)) {
          const t = (m.innerText || '').trim();
          if (t) return t;
        }
        return '';
      });
      if (info) { pesanDialog = info; break; }
      // kalau sudah pindah dari /login tanpa dialog, anggap sukses
      if (!page.url().includes('/login')) break;
    }

    // tutup dialog apa pun (tombol OK)
    await page.evaluate(() => {
      for (const b of document.querySelectorAll('button')) {
        const t = b.textContent.trim().toLowerCase();
        if (t === 'ok' || t === 'lanjut' || t === 'tutup') { b.click(); return; }
      }
    });
    await page.waitForTimeout(2000);

    // verifikasi login: sukses kalau sudah keluar dari /login ATAU dialog bilang berhasil
    const masihDiLogin = page.url().includes('/login');
    const dialogSukses = /berhasil\s*login|selamat datang|berhasil/i.test(pesanDialog);
    const dialogGagal = /salah|gagal|tidak ditemukan|belum terdaftar|kesalahan/i.test(pesanDialog);

    if (dialogGagal || (masihDiLogin && !dialogSukses)) {
      throw new Error(`Login gagal — dialog: "${pesanDialog || '(tidak ada dialog)'}" (url: ${page.url()})`);
    }
    console.log(`✅ Login berhasil${pesanDialog ? ` (dialog: ${pesanDialog.replace(/\s+/g, ' ')})` : ''}`);

    // pastikan benar-benar sudah di area admin sebelum lanjut
    if (page.url().includes('/login')) {
      await page.goto(WFA_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(3000);
      if (page.url().includes('/login')) {
        throw new Error('Login gagal — sesi tidak diterima, masih di /login setelah buka halaman WFA');
      }
    }

    await page.goto(WFA_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('#data_list', { timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('✅ Halaman WFA terbuka');

    // ---------- filter tanggal ----------
    // flatpickr: set value lewat API instance (paling andal) + dispatch event
    await page.evaluate((tgl) => {
      const el = document.querySelector('#tanggal');
      if (!el) throw new Error('input#tanggal tidak ditemukan');
      if (el._flatpickr) {
        el._flatpickr.setDate(tgl, true);
      } else {
        el.value = tgl;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, TANGGAL);
    console.log(`✅ Filter tanggal diisi: ${TANGGAL}`);

    // ---------- filter status WFH (radio btn-check) ----------
    // PENTING: input.btn-check tersembunyi (Bootstrap 5) → yang diklik LABEL-nya.
    const idRadio = { semua: 'filter_semua', wfh: 'filter_wfh', tidak_wfh: 'filter_tidak_wfh' }[STATUS];
    await page.evaluate((id) => {
      const input = document.getElementById(id);
      if (input) {
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('click', { bubbles: true }));
      }
      // klik label visual juga supaya state UI ikut berubah
      const label = document.querySelector(`label[for="${id}"]`);
      if (label) label.click();
    }, idRadio);
    await page.waitForTimeout(600);
    const statusTerpilih = await page.evaluate((id) => document.getElementById(id)?.checked, idRadio);
    console.log(`✅ Filter status: ${STATUS} (radio #${idRadio}, checked=${statusTerpilih})`);
    if (!statusTerpilih) throw new Error(`Radio #${idRadio} gagal dipilih`);

    // ---------- klik Cari ----------
    await page.click('#btn-filter');
    await page.waitForTimeout(4000); // tunggu DataTable reload
    console.log('✅ Tombol Cari diklik');

    // ---------- tampilkan 100 entri (default cuma 10) ----------
    await page.evaluate(() => {
      const sel = document.querySelector('select[name="data_list_length"]');
      if (sel) {
        sel.value = '100';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        // jQuery DataTable: panggil API langsung supaya pasti reload
        if (window.jQuery && window.jQuery.fn.dataTable) {
          try {
            const dt = window.jQuery('#data_list').DataTable();
            dt.page.len(100).draw();
          } catch (e) { /* abaikan */ }
        }
      }
    });
    await page.waitForTimeout(4000);
    const infoTabel = await page.evaluate(() => {
      const el = document.querySelector('#data_list_info');
      return el ? el.innerText.trim() : null;
    });
    console.log(`✅ Tampilan 100 entri — info tabel: ${infoTabel || '(tidak terbaca)'}\n`);

    // ---------- baca baris tabel hasil filter ----------
    const baris = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('#data_list tbody tr').forEach((r) => {
        const td = r.querySelectorAll('td');
        if (td.length < 9) return;
        const btn = r.querySelector('button.btn-danger');
        out.push({
          no: td[0]?.innerText?.trim() || null,
          instansi: td[1]?.innerText?.trim() || null,
          nama: td[2]?.innerText?.trim() || null,
          nip: td[3]?.innerText?.trim() || null,
          unitKerja: td[4]?.innerText?.trim() || null,
          status: td[5]?.innerText?.trim() || null,
          jenisWfh: td[6]?.innerText?.trim() || null,
          esurat: td[7]?.innerText?.trim() || null,
          adaTombolHapus: !!btn,
          onclick: btn ? btn.getAttribute('onclick') : null,
        });
      });
      return out;
    });

    laporan.barisTabel = baris.map(({ onclick, ...sisa }) => sisa);
    console.log(`════ HASIL FILTER — ${baris.length} baris ════`);
    baris.forEach((b, i) => {
      console.log(`  ${i + 1}. ${b.nama}  |  NIP ${b.nip}  |  ${b.status} / ${b.jenisWfh}  |  hapus: ${b.adaTombolHapus ? 'ya' : 'TIDAK'}`);
    });
    console.log();

    // ---------- tentukan daftar yang dihapus ----------
    // Simpan TOKEN onclick tiap baris (bukan indeks DOM) — token tetap valid
    // walau tabel sudah berubah, sedangkan indeks baris bergeser.
    const ambilToken = (idxRow) => page.evaluate((i) => {
      const tr = document.querySelector(`#data_list tbody tr:nth-child(${i + 1})`);
      if (!tr) return null;
      const btn = tr.querySelector('button.btn-danger');
      if (!btn) return null;
      const onclick = btn.getAttribute('onclick') || '';
      const m = onclick.match(/hapus\(([\s\S]*)\)\s*$/);
      const td = tr.querySelectorAll('td');
      return {
        args: m ? m[1] : null,
        nama: td[2]?.innerText?.trim() || null,
        nip: td[3]?.innerText?.trim() || null,
        status: td[5]?.innerText?.trim() || null,
        jenisWfh: td[6]?.innerText?.trim() || null,
      };
    }, idxRow);

    let daftarHapus = [];
    if (SEMUA) {
      for (let i = 0; i < baris.length; i++) {
        const t = await ambilToken(i);
        if (t && t.args) daftarHapus.push({ ...t, cara: 'SEMUA' });
      }
      console.log(`════ MODE --semua: ${daftarHapus.length} baris terdeteksi untuk dihapus ════\n`);
    } else {
      for (const t of target) {
        const idx = baris.findIndex((b) => b.nip && normNip(b.nip) === t.kunciNip && t.kunciNip);
        let idxFinal = idx, cara = 'NIP';
        if (idxFinal < 0) {
          idxFinal = baris.findIndex((b) => namaMirip(t.nama, b.nama));
          cara = 'NAMA';
        }
        if (idxFinal < 0) {
          console.log(`  ❌ TIDAK KETEMU : ${t.nama} (${t.nip})`);
          laporan.tidakKetemu.push({ nama: t.nama, nip: t.nip });
          continue;
        }
        const tk = await ambilToken(idxFinal);
        if (!tk || !tk.args) {
          console.log(`  ❌ Token tidak terbaca : ${t.nama}`);
          laporan.gagal.push({ nama: t.nama, nip: t.nip, pesan: 'token onclick tidak terbaca' });
          continue;
        }
        const cocokNip = normNip(tk.nip) === t.kunciNip;
        console.log(`  ${cocokNip ? '✅' : '🟡'} KETEMU (${cara}) : ${tk.nama} | NIP ${tk.nip} | ${tk.status}/${tk.jenisWfh}`);
        if (!cocokNip) console.log(`      ⚠️  NIP beda! PDF=${t.nip} vs Tabel=${tk.nip}`);
        daftarHapus.push({ ...tk, cara });
      }
    }

    console.log('════ PROSES PENGHAPUSAN ════');
    let n = 0;
    for (const item of daftarHapus) {
      n++;
      if (!EKSEKUSI) {
        console.log(`  🛡️  DRY-RUN ${n}/${daftarHapus.length} : ${item.nama} (${item.nip}) | ${item.status}/${item.jenisWfh}`);
        laporan.dihapus.push({ nama: item.nama, nip: item.nip, status: item.status, jenisWfh: item.jenisWfh, cara: item.cara, dryRun: true });
        continue;
      }

      // ---------- HAPUS ----------
      // PENTING: tombol hapus TERSEMBUNYI oleh CSS DataTables (kolom Action
      // ter-scroll), jadi klik fisik gagal ("element is hidden"). Solusinya:
      // panggil fungsi hapus(...) via JS dengan token dari onclick tombol —
      // efek IDENTIK dengan mengklik tombolnya.
      try {
        await page.evaluate((args) => { eval(`hapus(${args})`); }, item.args);
        await page.waitForTimeout(1200);

        const adaDialog = await page.evaluate(() => !!document.querySelector('.jconfirm-box'));
        if (adaDialog) {
          await page.evaluate(() => {
            const dlg = document.querySelector('.jconfirm-box');
            for (const btn of dlg.querySelectorAll('button')) {
              if (/^confirm$/i.test(btn.textContent.trim())) { btn.click(); return; }
            }
            for (const btn of dlg.querySelectorAll('button')) {
              if (/confirm|ya|hapus/i.test(btn.textContent.trim())) { btn.click(); return; }
            }
            const btns = dlg.querySelectorAll('button');
            if (btns.length) btns[0].click();
          });
          await page.waitForTimeout(2200);
        }

        const alertTeks = await page.evaluate(() => {
          const d = document.querySelector('.jconfirm-box');
          return d ? d.innerText.trim().replace(/\s+/g, ' ').slice(0, 200) : null;
        });
        const berhasil = alertTeks && /berhasil/i.test(alertTeks) && !/gagal/i.test(alertTeks);
        console.log(`  ${berhasil ? '✅' : '⚠️ '} ${n}/${daftarHapus.length} ${item.nama} (${item.nip}) → ${berhasil ? 'DIHAPUS' : alertTeks || 'tidak ada respons'}`);
        if (berhasil) laporan.dihapus.push({ nama: item.nama, nip: item.nip, cara: item.cara });
        else laporan.gagal.push({ nama: item.nama, nip: item.nip, pesan: alertTeks });

        await page.evaluate(() => {
          for (const btn of document.querySelectorAll('.jconfirm-box button')) {
            if (btn.textContent.trim().toLowerCase() === 'ok') { btn.click(); return; }
          }
        });
        await page.waitForTimeout(1500);
      } catch (e) {
        console.log(`  ❌ ${n}/${daftarHapus.length} ${item.nama} (${item.nip}) → GAGAL: ${e.message}`);
        laporan.gagal.push({ nama: item.nama, nip: item.nip, pesan: e.message });
        // tutup dialog kalau nyangkut
        await page.evaluate(() => {
          for (const btn of document.querySelectorAll('.jconfirm-box button')) {
            const t = btn.textContent.trim().toLowerCase();
            if (t === 'ok' || t === 'cancel') { btn.click(); return; }
          }
        }).catch(() => {});
        await page.waitForTimeout(1200);
      }
    }

  } catch (e) {
    console.error('\n❌ Error:', e.message);
    laporan.error = e.message;
  } finally {
    await browser.close();
  }

  // ---------- ringkasan ----------
  console.log('\n══════════════════════════════════════════════════════');
  console.log(`  RINGKASAN (${laporan.mode})`);
  console.log('══════════════════════════════════════════════════════');
  console.log(`  Baris tabel (setelah filter) : ${laporan.barisTabel.length}`);
  console.log(`  Target dari PDF              : ${target.length}`);
  console.log(`  ${EKSEKUSI ? 'Dihapus' : 'Akan dihapus'}                     : ${laporan.dihapus.length}`);
  console.log(`  Tidak ketemu                 : ${laporan.tidakKetemu.length}`);
  console.log(`  Gagal                        : ${laporan.gagal.length}`);
  if (laporan.tidakKetemu.length) {
    console.log('\n  ⚠️  Tidak ketemu di tabel:');
    laporan.tidakKetemu.forEach(x => console.log(`     - ${x.nama} (${x.nip})`));
  }

  const outFile = path.join(__dirname, 'arsip', `hapus-wfa-${TANGGAL}-${EKSEKUSI ? 'eksekusi' : 'dryrun'}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(laporan, null, 2), 'utf-8');
  console.log(`\n💾 Laporan: ${outFile}`);
  process.exit(laporan.gagal.length ? 1 : 0);
})();
