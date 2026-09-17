# Kampung Pancasila — Ekstraksi PDF

Modul ekstraksi PDF berkas **Program Kampung Pancasila** (BKPSDM Kota Surabaya).
Jenis dokumen **dideteksi otomatis** dari teksnya:

| `jenis` | Bentuk dokumen | Yang diambil |
|---|---|---|
| `daftar-penerima` | Surat berkop BKPSDM + lampiran **daftar penerima bernomor** | nomor/tgl/sifat/perihal, penandatangan, `daftarPenerima[]` (66 penerima) |
| `pergantian-personel` | Surat dari kecamatan + lampiran **2 tabel "Semula → Menjadi"** | nomor/tgl/sifat/lampiran/perihal, tujuan, tembusan, penandatangan, `tabel.semula[]`, `tabel.menjadi[]`, `perbedaan[]` |

Keduanya diuji pada surat asli:
`800/12528/436.8.4/2026` (3 hlm) dan `800/863/436.9.3/2026` (2 hlm, dompdf + CPDF).

## Pakai (CLI, dari root repo)

```bash
node pdf-extraction/kampung-pancasila/cli.js /path/surat.pdf            # ringkasan + isi lampiran
node pdf-extraction/kampung-pancasila/cli.js /path/surat.pdf --simpan   # parse + arsipkan PDF-nya
node pdf-extraction/kampung-pancasila/cli.js /path/surat.pdf --json     # JSON penuh
node pdf-extraction/kampung-pancasila/cli.js /path/surat.pdf --dump     # teks mentah pdftotext
node pdf-extraction/kampung-pancasila/cli.js --list                     # daftar isi arsip
```

Sebagai modul:

```js
const kp = require('./pdf-extraction/kampung-pancasila');
const h = kp.parsePdf('/path/surat.pdf');

if (h.jenis === 'pergantian-personel') {
  console.log(h.tabel.semula.length, '→', h.tabel.menjadi.length);
  for (const d of h.perbedaan) console.log(d.nama, d.field, d.semula, '→', d.mejadi);
  console.log('keluar:', h.personelDiganti, 'masuk:', h.personelBaru);
} else {
  for (const p of h.daftarPenerima) console.log(p.no, p.nama, p.kategori);
}
```

## Dua mesin ekstraksi

**1. Teks biasa (`pdftotext -layout`)** — untuk blok surat (nomor, tanggal, sifat,
perihal, tujuan, tembusan, penandatangan) dan lampiran daftar penerima bernomor.

**2. Koordinat (`pdftohtml -xml`)** — untuk tabel dua kolom-kolom yang **sel-selnya
menempel**: jarak antar sel ≈ 0 sehingga `pdftotext -layout` menulis satu kata
gabungan, contoh nyata:

```
"TJAHJONO AGUNG WIBOWO197705172001121005Pengadministrasi PerkantoranAlun-Alun Contong"
```

Setiap potongan teks tetap punya `left`/`width`, jadi kolom dipisahkan berdasar
posisi: pusat kolom dihitung dari baris header, tiap kata dipetakan ke kolom
terdekat. **NO/NAMA/NIP** dipetakan berdasarkan *urutan token* (bukan posisi),
karena pada satu baris seluruh sel bisa menyatu dalam satu elemen.

Semuanya deterministik — **tanpa LLM**. Helper bersama ada di `../lib/pdf-teks.js`.

## Jebakan yang sudah ditangani (semua dari kejadian nyata)

| Jebakan | Akibat kalau tidak ditangani | Perilaku modul |
|---|---|---|
| **`top` halaman 1 & 2 berbagi ruang koordinat yang sama** | badan surat halaman 1 ikut tersedot jadi baris tabel (nama jadi "SUSBANDORO Sehubungan") | tabel diproses **per halaman**, penanda `Semula`/`Menjadi` dicari di halaman yang sama |
| **Nama mulai lebih kiri daripada kolom NO** | nama terpotong: "TJAHJONO AGUNG WIBOWO" → "AGUNG WIBOWO" | NO/NAMA/NIP dipetakan dari urutan token |
| NIP + JABATAN menempel jadi satu elemen | NIP/JABATAN tercampur | NIP diambil dari deret 18 digit, sisa teks token dikembalikan ke kolom ekor |
| JABATAN + KELURAHAN menempel ("PerkantoranAlun-Alun") | kelurahan ikut masuk jabatan | dipisah berdasar posisi pusat kolom |
| Nama/gelar terpotong ke baris berikutnya ("S.A.P.") | gelar hilang atau jadi baris data palsu | baris tanpa nomor & tanpa NIP digabung ke baris sebelumnya per kolom |
| PENDAMPING RT 2 baris ("RW 7 … ; RW 8 …") | RT kedua hilang | lanjutan kolom digabung dengan pemisah `;` |
| **Footer e-sign + tanda tangan diulang tiap halaman** | daftar berhenti di tengah (36 dari 66 item) | footer hanya dilewati; akhir daftar = akhir dokumen |
| Daftar ketentuan bernomor di badan surat | ikut terbaca sebagai penerima | hanya nomor urut yang **berurutan dari 1** yang diterima |
| NIP/NIK panjang tidak lazim | NIP palsu masuk data | baris ditolak + peringatan (tidak diterka) |
| PDF hasil scan/foto | salah baca total | error `PERLU_OCR` |

## Uji

```bash
# tabel Semula/Menjadi — fixture XML teranonimisasi, 18 uji
node pdf-extraction/kampung-pancasila/test/buat-fixture.js    # regenerasi fixture dari arsip
node pdf-extraction/kampung-pancasila/test/test-tabel.js

# lampiran daftar penerima — fixture PDF sintetis
node pdf-extraction/kampung-pancasila/test/make-sample-kp.js
node pdf-extraction/kampung-pancasila/cli.js pdf-extraction/kampung-pancasila/test/sample-kp.pdf
```

Fixture tabel **teranonimisasi** (nama, NIP/NIK, HP diganti; nomor surat, jabatan,
kelurahan, dan seluruh anomali layout dipertahankan) sehingga aman masuk Git:
`test/fixture-tabel-semula-menjadi.xml`.

## Arsip

```
arsip/<tanggal>_<nomor-surat>.pdf    ← PDF asli (tidak diubah)
arsip/<tanggal>_<nomor-surat>.json   ← metadata + isi lampiran (audit)
arsip/index.json                     ← indeks (sha256, jenis, ringkas)
```

Contoh isi metadata surat pergantian: `tabel.semula` (5), `tabel.menjadi` (5),
`perbedaan` (8 perubahan antar tabel), `personelDiganti`, `personelBaru`,
`tujuan`, `tembusan` (8).

⚠️ `arsip/` di-gitignore (memuat nama & NIP) — hanya tersimpan lokal di VPS.

## Batasan

- Angka & tanda baca pada lampiran diambil apa adanya; kolom **KOORDINATOR
  KELURAHAN** dan **PENGAWAS RW** yang berisi `-` disimpan sebagai `"-"`
  (tidak dikosongkan, supaya terlihat memang kosong di surat).
- Bila suatu baris tetap ambigu, modul menambah entri `peringatan` — bukan menerka.
- Format baru (tabel tanpa nomor, daftar berkolom NIP pihak ketiga, dsb.) perlu
  contoh PDF aslinya dulu sebelum parser ditambah.
