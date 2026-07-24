const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const NIK = process.env.NIK;
const PASSWORD = process.env.PASSWORD;
const LOGIN_URL = 'https://kantorku.surabaya.go.id/login';
const WFA_URL = 'https://kantorku.surabaya.go.id/admin?modul=wfa&child=jadwal_wfa';
const CSV_PATH = path.join(__dirname, 'pegawai bkd non prigen.csv');

// ====== AMBIL TANGGAL WFH DARI ARGUMEN ATAU INPUT ======
async function getTanggalWFH() {
    const arg = process.argv[2];
    if (arg) {
        // Validasi format YYYY-MM-DD
        if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
            console.log(`📅 Tanggal dari argumen: ${arg}`);
            return arg;
        }
        console.log(`⚠️  Format tanggal salah, gunakan YYYY-MM-DD. Contoh: node index.js 2026-07-24`);
    }

    // Minta input dari user
    const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        readline.question('📅 Masukkan tanggal WFH (format: YYYY-MM-DD): ', (answer) => {
            readline.close();
            const date = answer.trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                resolve(date);
            } else {
                console.log('❌ Format salah. Gunakan YYYY-MM-DD. Contoh: 2026-07-24');
                process.exit(1);
            }
        });
    });
}

(async () => {
    const TANGGAL_WFH = await getTanggalWFH();

    console.log('\n🚀 Meluncurkan browser...');
    console.log('🚀 Meluncurkan browser...');
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: ['--start-maximized']
    });

    const page = await browser.newPage();
    const screenshotDir = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(screenshotDir)) {
        fs.mkdirSync(screenshotDir);
    }

    try {
        // ========== BACA CSV & FILTER PEGAWAI WFH ==========
        console.log('\n📂 Membaca file CSV...');
        const csvRaw = fs.readFileSync(CSV_PATH, 'utf-8');
        const lines = csvRaw.split('\n').filter(line => line.trim() !== '');
        const header = lines[0].split(';');
        console.log('   Header:', header.join(' | '));

        // Cari index kolom
        const idxNip = header.indexOf('NIP/NIK');
        const idxKet = header.indexOf('KET');

        // Filter pegawai dengan KET = "WFH"
        const pegawaiWFH = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(';');
            if (cols.length > idxKet && cols[idxKet]?.trim() === 'WFH') {
                pegawaiWFH.push({
                    nip: cols[idxNip]?.trim(),
                    nama: cols[idxKet === 4 ? 3 : 3]?.trim() || cols[3]?.trim()
                });
            }
        }

        console.log(`   📋 Ditemukan ${pegawaiWFH.length} pegawai dengan status WFH:`);
        pegawaiWFH.forEach(p => console.log(`      - ${p.nip} (${p.nama})`));

        if (pegawaiWFH.length === 0) {
            console.log('❌ Tidak ada pegawai WFH, hentikan script.');
            await browser.close();
            return;
        }

        // ========== 1. BUKA HALAMAN LOGIN ==========
        console.log('\n📄 Membuka halaman login...');
        await page.goto(LOGIN_URL, {
            waitUntil: 'networkidle0',
            timeout: 60000
        });
        await page.screenshot({ path: path.join(screenshotDir, '01-halaman-login.png') });
        console.log('✅ Halaman login terbuka');

        // ========== 2. ISI FORM LOGIN ==========
        console.log('✏️  Mengisi NIK...');
        await page.waitForSelector('input[name="nik"]', { timeout: 10000 });
        await page.type('input[name="nik"]', NIK, { delay: 30 });

        console.log('✏️  Mengisi Password...');
        await page.type('input[name="password"]', PASSWORD, { delay: 30 });
        await page.screenshot({ path: path.join(screenshotDir, '02-form-terisi.png') });
        console.log('✅ Form login terisi');

        // ========== 3. KLIK TOMBOL MASUK ==========
        console.log('🔑 Mengklik tombol Masuk...');
        await page.click('button[type="submit"]');
        console.log('✅ Tombol Masuk diklik');

        // ========== 4. TUNGGU DIALOG BERHASIL LOGIN ==========
        console.log('⏳ Menunggu dialog konfirmasi login...');
        await page.waitForSelector('.jconfirm-content, .jconfirm-box, [role="dialog"]', {
            timeout: 15000
        });
        console.log('✅ Dialog berhasil login muncul');
        await page.screenshot({ path: path.join(screenshotDir, '03-dialog-login.png') });

        // ========== 5. KLIK OK PADA DIALOG ==========
        console.log('👆 Mengklik tombol OK...');
        await page.evaluate(() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                const text = btn.textContent.trim().toLowerCase();
                if (text === 'ok') {
                    btn.click();
                    return;
                }
            }
            const dialogBtns = document.querySelectorAll('.jconfirm-buttons button');
            if (dialogBtns.length > 0) {
                dialogBtns[0].click();
            }
        });
        console.log('✅ Tombol OK diklik');

        // ========== 6. TUNGGU NAVIGASI KE HALAMAN HOME ==========
        console.log('⏳ Menunggu navigasi ke halaman utama...');
        await page.waitForNavigation({
            waitUntil: 'networkidle0',
            timeout: 30000
        }).catch(() => {});

        await page.screenshot({ path: path.join(screenshotDir, '04-setelah-login.png') });

        // ========== 7. CEK HASIL LOGIN ==========
        const loginUrl = page.url();
        console.log('📍 Halaman saat ini:', loginUrl);
        if (loginUrl.includes('/home') || loginUrl.includes('/dashboard')) {
            console.log('✅ Login BERHASIL!');
        } else {
            console.log('❌ Login mungkin gagal. Halaman masih:', loginUrl);
        }

        // ========== 8. NAVIGASI KE HALAMAN WFA ==========
        console.log('\n📍 Navigasi ke halaman WFA...');
        await page.goto(WFA_URL, {
            waitUntil: 'networkidle0',
            timeout: 30000
        });
        console.log('✅ Sampai di halaman WFA:', page.url());
        await page.screenshot({ path: path.join(screenshotDir, '05-halaman-wfa.png') });

        // ========== 9. KLIK TOMBOL "Jadwal Work From Home" ==========
        console.log('🔍 Mengklik tombol "Jadwal Work From Home"...');
        await page.waitForSelector('div.btn.btn-primary', { timeout: 10000 });

        await page.evaluate(() => {
            const buttons = document.querySelectorAll('div.btn.btn-primary');
            for (const btn of buttons) {
                if (btn.textContent.trim().includes('Jadwal Work From Home')) {
                    btn.click();
                    return;
                }
            }
        });
        console.log('✅ Tombol diklik, menunggu modal muncul...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        // ========== 10. ISI FORM MODAL ==========
        console.log('\n📝 Mengisi form modal Tambah Jadwal Work From Home Baru...');

        // 10a. Tanggal WFH
        console.log(`   📅 Tanggal WFH: ${TANGGAL_WFH}`);
        await page.evaluate((tgl) => {
            const input = document.querySelector('#tanggal_wfh');
            if (input) {
                input.value = tgl;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, TANGGAL_WFH);

        // 10b. Nomor Surat
        console.log('   📄 Nomor Surat: 800/11641/436.8.4/2026');
        await page.evaluate(() => {
            const input = document.querySelector('#no_surat');
            if (input) {
                input.value = '800/11641/436.8.4/2026';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });

        // 10c. Tanggal Surat - 17 Juli 2026
        console.log('   📅 Tanggal Surat: 17 Juli 2026');
        await page.evaluate(() => {
            const input = document.querySelector('#tgl_surat');
            if (input) {
                input.value = '2026-07-17';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });

        // ========== 10d. PILIH SEMUA PEGAWAI WFH via Select2 API ==========
        console.log(`\n   👤 Memilih ${pegawaiWFH.length} pegawai WFH...`);

        const selectResult = await page.evaluate((daftarPegawai) => {
            const select = document.querySelector('#pegawai');
            if (!select) return { success: false, message: 'Select #pegawai tidak ditemukan' };

            const foundValues = [];
            const notFound = [];

            // Cari setiap NIP di option Select2
            for (const peg of daftarPegawai) {
                let matched = false;
                for (const opt of select.options) {
                    if (opt.text.includes(peg.nip)) {
                        foundValues.push(opt.value);
                        matched = true;
                        break;
                    }
                }
                if (!matched) {
                    notFound.push(peg.nip);
                }
            }

            if (foundValues.length === 0) {
                return { success: false, message: 'Tidak ada NIP yang cocok dengan option', notFound };
            }

            // Pilih semua via jQuery Select2 API
            if (typeof jQuery !== 'undefined') {
                const $select = jQuery(select);
                if ($select.data('select2')) {
                    $select.val(foundValues).trigger('change');
                    return {
                        success: true,
                        total: daftarPegawai.length,
                        terpilih: foundValues.length,
                        tidakDitemukan: notFound.length,
                        notFound
                    };
                }
            }

            return { success: false, message: 'Select2 API tidak tersedia' };
        }, pegawaiWFH);

        if (selectResult.success) {
            console.log(`   ✅ ${selectResult.terpilih} dari ${selectResult.total} pegawai terpilih`);
            if (selectResult.tidakDitemukan > 0) {
                console.log(`   ⚠️  ${selectResult.tidakDitemukan} pegawai tidak ditemukan di dropdown:`);
                selectResult.notFound.forEach(n => console.log(`      - ${n}`));
            }
        } else {
            console.log(`   ❌ ${selectResult.message}`);
        }

        // 10e. Keterangan
        console.log('   📝 Keterangan: WFH');
        await page.evaluate(() => {
            const textarea = document.querySelector('#keterangan');
            if (textarea) {
                textarea.value = 'WFH';
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });

        // 10f. Link SP
        console.log('   🔗 Link SP: https://esurat.surabaya.go.id/upload/esign/2026/July/17/1160346/1160346_signed.pdf');
        await page.evaluate(() => {
            const input = document.querySelector('#esurat');
            if (input) {
                input.value = 'https://esurat.surabaya.go.id/upload/esign/2026/July/17/1160346/1160346_signed.pdf';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });

        await page.screenshot({ path: path.join(screenshotDir, '07-form-terisi.png') });
        console.log('✅ Semua field form terisi!');

        // ========== 11. KLIK TOMBOL SAVE CHANGES ==========
        console.log('\n💾 Menyimpan form...');
        await page.evaluate(() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                if (btn.textContent.trim().toLowerCase() === 'save changes') {
                    btn.click();
                    return;
                }
            }
        });
        console.log('✅ Tombol Save changes diklik!');

        await new Promise(resolve => setTimeout(resolve, 5000));
        await page.screenshot({ path: path.join(screenshotDir, '08-setelah-simpan.png') });
        console.log('\n✅ Semua langkah berhasil!');

        console.log('\n📋 Script selesai. Browser akan ditutup dalam 30 detik...');
        console.log('💡 Tekan Ctrl+C di terminal untuk menutup lebih cepat.');
        await new Promise(resolve => setTimeout(resolve, 30000));

    } catch (error) {
        console.error('❌ Terjadi error:', error.message);
        try {
            await page.screenshot({ path: path.join(screenshotDir, '99-error.png') });
            console.log('📸 Screenshot error disimpan');
        } catch (_) { }
    } finally {
        await browser.close();
        console.log('🛑 Browser ditutup.');
    }
})();
