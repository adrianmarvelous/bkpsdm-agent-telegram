# automated-sdm-cuti

Klien API data **cuti SDM** BKPSDM Surabaya — mengambil daftar cuti berstatus
`DIUSULKAN` pada bulan berjalan.

## Endpoint

| Method | Endpoint | Keterangan |
|---|---|---|
| POST | `{API_BASE_URL}/auth/login.php` | Login → Bearer token |
| GET | `{API_BASE_URL}/sdm/cuti/diusulkan-bulan-ini.php` | Cuti diusulkan bulan ini |
| GET | `{API_BASE_URL}/master-pegawai/all.php?limit=1000` | Master pegawai (join nama) |

Base URL default: `https://bkpsdm.surabaya.go.id/api/ai-agent`

### Struktur respons endpoint cuti

```json
{
  "success": true,
  "periode": "2026-09",
  "status": "DIUSULKAN",
  "total_hari": 7,
  "total_nip_unik": 6,
  "nip": ["199711242024212019", "..."],
  "rows": [
    { "tanggal": "2026-09-15", "status": "DIUSULKAN",
      "nip": ["199803172022082001", "198001082025212003"], "total": 2 }
  ]
}
```

## ⚠️ Catatan penting (hasil probe 16 Sep 2026)

1. **Tidak ada parameter periode.** Percobaan `?periode=2026-08`,
   `?bulan=09&tahun=2026`, `?tanggal=2026-09-01` semuanya mengembalikan hasil
   identik (`periode: "2026-09"`). Endpoint **hardcoded bulan berjalan**.
   Untuk bisa memilih bulan lain, perlu perubahan di sisi server.
2. **Hanya NIP, tanpa nama.** Tidak ada `nama`, `jenis_cuti`, `unit_kerja`,
   maupun `tanggal_selesai`. Nama dilengkapi dengan join ke master pegawai.
3. **`rows` dikelompokkan per TANGGAL, bukan per orang.** Satu pegawai yang
   cuti beberapa hari muncul di beberapa baris. Modul ini mengagregasi ulang
   per pegawai (`rekapPerPegawai`).
4. **`total_hari` bukan total hari cuti.** Itu jumlah *tanggal* yang punya
   usulan. Jangan dibaca sebagai akumulasi lama cuti pegawai.
5. Semua NIP berformat ASN 18 digit.

## Konfigurasi

Kredensial dibaca dari **root** `.env` project (bukan `.env` lokal folder ini),
konsisten dengan modul lain (`esurat`, `tekocak`, `kantorku-wfh`, dll):

```
API_BASE_URL=https://bkpsdm.surabaya.go.id/api/ai-agent
API_USERNAME=...
API_PASSWORD=...
```

Override opsional:

```
SDM_CUTI_DIUSULKAN_URL=...   # override URL endpoint cuti
SDM_MASTER_PEGAWAI_URL=...   # override URL master pegawai
SDM_TIMEOUT_MS=60000         # timeout request (ms)
```

## Cara pakai

```bash
node index.js                      # rekap lengkap (per pegawai + per tanggal)
node index.js --ringkas            # ringkasan singkat (untuk chat/WA)
node index.js --json               # JSON mentah dari API
node index.js --login              # tes login saja
node index.js 199711242024212019   # detail per NIP
```

Sebagai modul:

```js
const {
  getCutiDiusulkan, getMasterPegawai,
  rekapPerPegawai, formatRekap, formatRingkas,
} = require('./automated-sdm-cuti');

const data = await getCutiDiusulkan();
const master = await getMasterPegawai();
console.log(formatRingkas(data, master));
```

Hasil rekap disimpan otomatis ke `output/cuti-diusulkan-<periode>-<tanggal>.json`
dan `.txt`.
