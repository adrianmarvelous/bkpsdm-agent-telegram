# automated-organisasi-iko — Monitor Approval Monev Agustus (headless / VPS)

Automasi login + monitor tabel **Approval Monev Agustus** Bagian Organisasi Kota Surabaya.
Berjalan **headless** sehingga siap dijalankan di VPS.

## File
| File | Fungsi |
|------|--------|
| `index.js` | Login headless (isi CAPTCHA manual), lalu simpan `PHPSESSID` ke `session.json`. |
| `monitor.js` | Daemon: cek tiap 30 menit ada baris baru di tabel → notif Telegram. |
| `session.json` | Sesi login (`PHPSESSID`) — **jangan di-commit** (sudah di `.gitignore`). |
| `state.json` | Baris yang sudah terlihat (baseline) — **jangan di-commit**. |
| `ecosystem.config.cjs` | Definisi proses pm2 untuk `monitor.js`. |

## Setup di VPS (Linux)

### 1. Dependensi
```bash
cd automated-organisasi-iko
npm install                 # dotenv (playwright hanya dipakai login)
npx playwright install chromium --with-deps   # browser headless untuk login
```

> `monitor.js` tidak butuh browser (memakai `fetch` bawaan Node), hanya `dotenv`.

### 2. Konfigurasi
- `.env` (folder ini): `ORGANISASI_USERNAME`, `ORGANISASI_PASSWORD`, `HEADLESS=true`.
- Konfig Telegram dibaca dari `.env` root: `TELEGRAM_BOT_TOKEN`, `ALLOWED_CHAT_IDS`
  (opsional override: `ORGANISASI_CHAT_ID`).
- Interval: env `ORGANISASI_INTERVAL_MINUTES` (default 30).

### 3. Login sekali (untuk membuat `session.json`)
CAPTCHA tidak bisa dilewati — masukkan manual:
```bash
node index.js                 # headless; baca kode dari captcha.png lalu ketik
node index.js KODECAPTCHA     # atau langsung dengan kode dari arg
```
Setelah sukses, `PHPSESSID` otomatis tersimpan ke `session.json`.

> Di VPS tanpa GUI, untuk "melihat" `captcha.png`, kirim/SCP file itu ke mesin lokal
> lalu baca, atau OCR. Opsi lanjutan: relai gambar ke Telegram seperti
> `automated-pengaduan-listener` bila ingin login otomatis penuh.

### 4. Jalankan monitor (pm2)
```bash
cd automated-organisasi-iko
pm2 start ecosystem.config.cjs
pm2 save
```
Uji manual satu siklus:
```bash
node monitor.js --once
```

## Catatan
- Sesi (`PHPSESSID`) bisa kedaluwarsa → monitor kirim peringatan ke Telegram lalu
  berhenti. Jalankan `node index.js` lagi untuk login ulang.
- Notifikasi Telegram hanya saat muncul **baris baru** (pengecekan pertama = baseline).
