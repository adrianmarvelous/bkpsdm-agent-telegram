# 🏢 Automasi Absensi TEKO-CAK

> **TEKO-CAK** (Tanda Kehadiran Online dan Catatan Absensi Karyawan)  
> Pemerintah Kota Surabaya

Script automasi untuk login, generate laporan, dan update data absensi pegawai di website TEKO-CAK menggunakan **Playwright (Node.js)**.

---

## ✨ Fitur

| # | Fitur | Status |
|:-:|:------|:------:|
| 1 | 🔐 **Login** — pilih tahun, login user/password, tutup modal | ✅ |
| 2 | 📊 **Generate Laporan** — pilih instansi, isi tanggal (1 tiap bulan - hari ini), generate & tunggu selesai | ✅ |
| 3 | 👤 **Update Pegawai** — pilih instansi, cari NIP via autocomplete, klik Update | ✅ |

## 📋 Alur Lengkap

```
Login (tahun 2026)
  ↓
Tutup modal otomatis (jika ada)
  ↓
Generate Laporan (By: Instansi, tgl 1 s/d hari ini)
  ↓
Tunggu proses generate (progress 0% → 100%)
  ↓
Klik OK dialog sukses
  ↓
Buka Laporan Per Pegawai
  ↓
Untuk setiap NIP (dari CSV):
  ├─ Pilih instansi BKPSDM
  ├─ Cari NIP via autocomplete
  ├─ Klik Update
  └─ Tutup tab laporan yang terbuka
```

---

## 🚀 Cara Pakai

### 1. Clone & Install
```bash
git clone <repo-url> automated-tekocak
cd automated-tekocak
npm install
npx playwright install chromium
```

### 2. Setup `.env`
```bash
cp .env.example .env
```

Edit `.env`:
```env
TEKOCAK_URL=https://teko-cak.surabaya.go.id
TEKOCAK_USERNAME=isi_username_anda
TEKOCAK_PASSWORD=isi_password_anda
TEKOCAK_TAHUN=2026
TEKOCAK_HEADLESS=false
```

### 3. Export NIP (jika punya file Excel)

Letakkan file `master tekocak.xlsx` di folder project (jika ada), lalu:
```bash
node scripts/export-nip.js
```
Atau buat `master-pegawai.csv` manual dengan format: `"NIP","Nama"`

### 4. Jalankan

| Perintah | Fungsi |
|:---------|:-------|
| `npm start` | 🏠 **Semua task** (login sekali) |
| `node tasks/login.js` | 🔐 Login saja |
| `node tasks/generate.js` | 📊 Login → Generate laporan |
| `node tasks/update-pegawai.js` | 👤 Login → Update semua pegawai |

---

## 📁 Struktur File

```
📁 automated-tekocak/
├── 📄 index.js                     🏠 Main — jalanin semua task berurutan
│
├── 📁 tasks/
│   ├── 📄 login.js                 🔐 Task Login (standalone)
│   ├── 📄 generate.js              📊 Task Generate Laporan (standalone)
│   ├── 📄 update-pegawai.js        👤 Task Update Pegawai (standalone)
│   └── 📄 _helper.js               ⚙️ Bootstrap browser untuk standalone mode
│
├── 📁 scripts/
│   └── 📄 export-nip.js            📋 Export NIP dari Excel ke CSV
│
├── 📄 config.js                    ⚙️ Konfigurasi (baca dari .env + CSV)
├── 📄 .env                         🔒 Credential (tidak di-commit!)
├── 📄 .env.example                 📋 Template .env
├── 📄 .gitignore
│
├── 📄 master-pegawai.csv           📊 Daftar NIP (dibaca otomatis oleh config)
│
├── 📄 package.json
└── 📄 README.md
```

---

## ⚙️ Konfigurasi

### Filter NIP tertentu
Edit `.env` — hanya proses NIP tertentu:
```env
TEKOCAK_FILTER_NIP=3578041306950011,3578016205030003
```
Kosongi untuk proses **semua** NIP dari CSV.

### Ganti Instansi
Edit `config.js`:
```js
INSTANSI: 'BADAN KEPEGAWAIAN DAN PENGEMBANGAN SUMBER DAYA MANUSIA',
```

### Headless Mode (VPS)
```env
TEKOCAK_HEADLESS=true    # jalan di background, tanpa browser terlihat
```

---

## 🖥️ Deploy ke VPS Linux

```bash
# Copy project
scp -r automated-tekocak user@vps-ip:/home/

# Install dependensi
cd /home/automated-tekocak
npm install
npx playwright install chromium
npx playwright install-deps chromium

# Set headless
sed -i 's/TEKOCAK_HEADLESS=false/TEKOCAK_HEADLESS=true/' .env

# Jadwal harian via crontab (contoh: jam 7 pagi)
crontab -e
0 7 * * * cd /home/automated-tekocak && node index.js >> log.txt 2>&1
```

---

## 🛠️ Tech Stack

- **Node.js** 16+ — runtime
- **Playwright** — browser automation (Chromium)
- **dotenv** — environment variables
- **xlsx** — baca file Excel (NIP)
- **CSV** — penyimpanan daftar NIP (agar digit aman)
