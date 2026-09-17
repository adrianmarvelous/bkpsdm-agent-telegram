# SP KantorKu WFO/WFH — Ekstraksi & Arsip Surat Perintah

Modul untuk membaca **PDF SP / Surat Tugas** dan mengambil:

| Field | Contoh (dari SP asli) |
|---|---|
| `nomorSurat` | `100.3.5/____/436.8.4/2026` |
| `tanggalSurat` | `{ iso, display, tahun, sumber }` — null kalau PDF belum diisi tanggal |
| `kegiatan` | `{ hari: 'Jumat', tanggal: '2026-09-11', display: '11 September 2026' }` |
| `linkEsurat` | `https://esurat.surabaya.go.id/upload/esign/.../1160346_signed.pdf` |
| `pegawai[]` | `{ no, nip, nama, jabatan, pangkat, jenis: ASN/NON-ASN, valid }` |

**Kenapa modul ini ada:** `automated-kantorku-wfh/index.js` memakai nomor surat,
tanggal surat, dan link eSurat yang **hardcode** (nilai run 17 Juli 2026, dipakai
terus sejak commit pertama). Modul ini jadi sumber tunggal nilai tersebut —
diambil dari SP asli — sekaligus arsip bukti suratnya.

⚠️ Modul ini **tidak** di dalam `automated-kantorku-wfh`; letaknya di
`pdf-extraction/` supaya bisa dipakai automasi lain dan diuji terpisah.

## Pakai cepat (CLI, dari root repo)

```bash
node pdf-extraction/sp-kantorku-wfo/cli.js /path/sp.pdf              # lihat isi surat
node pdf-extraction/sp-kantorku-wfo/cli.js /path/sp.pdf --simpan     # parse + arsipkan
node pdf-extraction/sp-kantorku-wfo/cli.js /path/sp.pdf --json       # JSON penuh
node pdf-extraction/sp-kantorku-wfo/cli.js /path/sp.pdf --dump       # teks mentah pdftotext
node pdf-extraction/sp-kantorku-wfo/cli.js --list                    # daftar arsip
```

## Pakai sebagai modul

```js
const sp = require('./pdf-extraction/sp-kantorku-wfo');

const hasil = sp.parsePdf('/path/sp.pdf');
console.log(hasil.nomorSurat, hasil.tanggalSurat?.iso, hasil.jumlahPegawai);
for (const p of hasil.pegawai) console.log(p.nip, p.nama, p.jenis);

// parse + simpan PDF ke arsip (idempoten: sha256 sama → tidak digandakan)
const r = sp.simpanSp('/path/sp.pdf');
console.log(r.duplikat, r.file);

// audit
console.log(sp.daftarArsip());
console.log(sp.ambilArsip('2026-07-17'));   // by tanggal / nomor surat / file
```

## Penyimpanan arsip

```
pdf-extraction/sp-kantorku-wfo/arsip/
  <tanggal>_<nomor-surat>.pdf     ← PDF asli (tidak diubah)
  <tanggal>_<nomor-surat>.json    ← metadata + hasil ekstraksi (audit)
  index.json                      ← indeks semua arsip (sha256, jumlah pegawai)
```

- `index.json` menyimpan sha256 → **tidak ada duplikat** kalau PDF sama di-upload dua kali.
- ⚠️ **Privasi:** PDF & metadata memuat NIP/NIK + nama pegawai (data pribadi).
  `arsip/` di-gitignore (lihat `pdf-extraction/.gitignore`) → hanya lokal di VPS.

## Mesin ekstraksi

`pdftotext -layout` dari paket **poppler-utils** (sudah ada di VPS — nol dependency npm baru).
**Tanpa LLM/AI**: regex + pencocokan label saja, supaya hasilnya bisa diulang & diaudit.

Helper umum (ekstraksi teks, parsing tanggal Indonesia, pencarian nomor surat)
dipakai dari `../lib/pdf-teks.js` — dipakai bersama modul `kampung-pancasila/`,
tidak digandakan lagi di sini.

### Dua format daftar yang didukung

**1. Lampiran blok berlabel** (format SP BKPSDM saat ini — terbukti pada SP asli 2 halaman):

```
1. Nama        : Fahrur Rozi, SE
  Pangkat/Gol : Penata Muda Tingkat I / III/b
  NIP / NIK    : 197105292009011001
  Jabatan      : Staf Tim Kerja Pengembangan Kompetensi Teknis
```

Pencocokan **berbasis label** (bukan posisi kolom), jadi tetap jalan walau
spasi/indentasi berubah. Nama yang terpotong ke baris berikutnya digabung.

**2. Tabel** `NO | NIP | NAMA | JABATAN` atau `NO | NAMA | NIP` (urutan kolom
dideteksi otomatis dari header).

### Aturan penting

| Hal | Perilaku |
|---|---|
| `NIP / NIK` berisi `-` (Non-ASN) | NIK 16 digit di baris yang sama dipakai; ditandai `NON-ASN` |
| **NIP terpotong** oleh PDF (17/19 digit, atau sisa digit turun baris) | **Tidak diterka** — baris dibuang + peringatan minta cek manual |
| Pola NIP/NIK tidak wajar (tahun/bulan/tanggal tidak masuk akal) | Tetap diambil tapi `valid: false` + peringatan |
| `Tanggal : 11 September 2026` di blok **kegiatan** (`Hari : … / Tanggal : …`) | **Bukan** tanggal surat → masuk `kegiatan`, bukan `tanggalSurat` |
| `Surabaya,` masih kosong di PDF (draft belum ditandatangani) | `tanggalSurat = null` + peringatan — bukan diisi tebakan |
| Nomor surat bertanda garis bawah (`100.3.5/____/436.8.4/2026`) | Diambil apa adanya (nomor urut belum diisi) |
| PDF hasil scan/foto | ❌ error `PERLU_OCR` — perlu PDF versi teks atau tambah OCR |

Kalau ragu, jalankan `--dump` untuk melihat teks mentah `pdftotext`, lalu
sesuaikan label/pola di `parser.js` (`bacaLabel`, `KATA_ABAIKAN`, `POLA_NOMOR`).

## Uji cepat (fixture)

```bash
node pdf-extraction/sp-kantorku-wfo/test/make-sample-sp.js     # bikin 3 PDF contoh:
#   sample-sp-v1.pdf                  tabel NIP-dulu
#   sample-sp-v2.pdf                  tabel NAMA-dulu + nama wrap
#   sample-sp-v3-nip-terpotong.pdf    NIP terpotong → harus muncul peringatan
node pdf-extraction/sp-kantorku-wfo/cli.js pdf-extraction/sp-kantorku-wfo/test/sample-sp-v1.pdf
```

## Cek silang ke master pegawai (API BKPSDM)

```bash
node scripts/cek-sp-vs-master.js               # arsip SP terbaru vs master pegawai
node scripts/cek-sp-vs-master.js --simpan-raw  # + simpan respons API mentah (audit)
```
Hasil: 9/9 pegawai SP cocok dengan master (kunci pencocokan **NIP/NIK** — nama di
master kadang tanpa gelar, jadi jangan pakai nama sebagai kunci).

## Integrasi berikutnya (belum dikerjakan)

1. Bot Telegram: user kirim PDF → bot balas ringkasan (nomor surat, tanggal,
   N pegawai) + tombol konfirmasi.
2. Setelah konfirmasi, `/kantorku <tanggal>` memakai nilai dari SP ini
   (menggantikan 3 field hardcode di `automated-kantorku-wfh/index.js` —
   `no_surat` baris 277, `tgl_surat` baris 287, `esurat` baris 349).
3. Daftar pegawai dari SP dipakai sebagai sumber pilihan pegawai
   (bukan filter `KET='WFH'` di API master — catatan: 1 pegawai di SP asli
   berstatus `WFO` di master, jadi filter itu tidak setara dengan SP).
