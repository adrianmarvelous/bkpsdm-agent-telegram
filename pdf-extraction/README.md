# pdf-extraction — Ekstraksi data dari PDF (folder mandiri)

Kumpulan modul ekstraksi PDF untuk agent BKPSDM. **Berdiri sendiri**, tidak
menempel di automasi mana pun: tiap automasi (mis. KantorKu WFH) memanggil
modul di sini, sehingga parser bisa dipakai ulang, diuji sendiri, dan diperbaiki
tanpa menyentuh kode automasinya.

## Peta isi

| Folder | Sumber PDF | Keluaran utama |
|---|---|---|
| `lib/pdf-teks.js` | — | Helper bersama: ekstraksi teks (`pdftotext`/`pdfinfo`), ekstraksi **koordinat** (`pdftohtml -xml`) untuk tabel bersel menempel, parsing tanggal Indonesia, pencarian nomor surat |
| `sp-kantorku-wfo/` | Surat Perintah / Surat Tugas (SP) KantorKu | `nomorSurat`, `tanggalSurat`, `linkEsurat`, `pegawai[]` (NIP/NIK + nama + jabatan) |
| `kampung-pancasila/` | Berkas Program Kampung Pancasila (2 jenis, deteksi otomatis) | **daftar penerima**: 66 penerima (35 perangkat daerah + 31 kecamatan) · **pergantian personel**: 2 tabel `Semula`/`Menjadi` + `perbedaan[]` |

Helper di `lib/` dipakai bersama kedua modul supaya logika tanggal/nomor surat
tidak digandakan (dulu `sp-kantorku-wfo` punya salinan sendiri — sudah dihapus).

## Cara pakai (dari root repo)

```bash
# SP KantorKu: lihat isi surat
node pdf-extraction/sp-kantorku-wfo/cli.js /path/sp.pdf

# Surat Kampung Pancasila: lihat metadata + daftar penerima
node pdf-extraction/kampung-pancasila/cli.js /path/surat.pdf

# sama untuk keduanya: --simpan (arsipkan), --json, --dump (teks mentah), --list
```

Sebagai modul:

```js
const sp = require('./pdf-extraction/sp-kantorku-wfo');
const kp = require('./pdf-extraction/kampung-pancasila');

console.log(sp.parsePdf('/path/sp.pdf').pegawai.length);
console.log(kp.parsePdf('/path/surat.pdf').jumlahPenerima);
```

## Prinsip modul di folder ini

1. **Deterministik, bukan LLM.** Ekstraksi memakai `pdftotext` (poppler) + aturan
   eksplisit di kode — bukan model AI. NIP itu data identitas: kalau model
   berhalusinasi, hasilnya bukan error yang kelihatan, tapi NIP mirip yang masuk
   ke sistem. Karena itu modul di sini **menolak** (dengan peringatan) daripada menerka.
2. **Nol dependency npm baru.** Cukup Node + `pdftotext`/`pdfinfo` dari poppler-utils
   (sudah terpasang di VPS). Modul fixture saja yang butuh `pdfkit` (sudah ada di root).
3. **Arsip = bukti.** PDF asli disimpan utuh + metadata JSON (sha256 + hasil
   ekstraksi) supaya keputusan automasi bisa diaudit ulang.
4. **PDF scan ditolak terang-terangan** (error `PERLU_OCR`), tidak dikira-kira.
5. **Data pribadi tidak ke Git.** Folder `arsip/` tiap modul di-gitignore.
6. **Format asli dulu, baru parser.** Bikin parser tanpa melihat PDF aslinya
   hampir pasti salah — asumsi awal `sp-kantorku-wfo` (tabel kolom) ternyata
   tidak sesuai dokumen asli (lampiran blok berlabel).

## Uji

```bash
node pdf-extraction/sp-kantorku-wfo/test/make-sample-sp.js       # 3 fixture SP
node pdf-extraction/kampung-pancasila/test/make-sample-kp.js     # 1 fixture surat KP

node pdf-extraction/sp-kantorku-wfo/cli.js pdf-extraction/sp-kantorku-wfo/test/sample-sp-v1.pdf
node pdf-extraction/kampung-pancasila/cli.js pdf-extraction/kampung-pancasila/test/sample-kp.pdf
```

## Cek silang pegawai ke master (khusus modul SP)

```bash
node scripts/cek-sp-vs-master.js               # SP dari arsip terbaru vs master pegawai
node scripts/cek-sp-vs-master.js --simpan-raw  # + simpan respons API mentah
```
