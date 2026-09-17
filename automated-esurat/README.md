# automated-esurat

Klien API **eSurat / agenda undangan** KantorKu Surabaya (`kantorku.surabaya.go.id`).
Mengambil daftar undangan/agenda per tanggal, membersihkan HTML, lalu menyimpannya ke
folder [`undangan/`](undangan/).

## Alur API

| Langkah | Request | Hasil |
|---|---|---|
| 1. Login | `POST {ESURAT_LOGIN_URL}` body JSON `{username, password}` | `{ token, user }` (Laravel Sanctum, berlaku ~2 jam) |
| 2. Ambil agenda | `GET {ESURAT_AGENDA_URL}?tanggal=YYYY-MM-DD` header `Authorization: Bearer <token>` | `{ success, data: [...], message }` |

Rate limit server: **60 request/menit** (`x-ratelimit-limit`).

## Config (root `.env` — env digabung)

```ini
ESURAT_BASE_URL=https://kantorku.surabaya.go.id
ESURAT_LOGIN_URL=https://kantorku.surabaya.go.id/api/login
ESURAT_AGENDA_URL=https://kantorku.surabaya.go.id/api/integrasi/esurat-agenda
ESURAT_USERNAME=...
ESURAT_PASSWORD=...
# opsional
ESURAT_TIMEOUT_MS=30000
```

Tidak ada kredensial yang di-hardcode di kode (lihat `config.js`).

## Pakai (CLI)

```bash
cd /home/ubuntu/bkpsdm-agent-telegram/automated-esurat

node index.js --login              # tes login saja
node index.js 2026-08-05           # ringkasan + simpan ke undangan/undangan-2026-08-05.json
node index.js 2026-08-05 --json    # JSON mentah
node index.js 2026-08-05 --dry     # tampilkan saja, tidak menyimpan
node index.js                      # tanggal hari ini (WIB)
```

## Pakai (modul)

```js
const { login, getAgenda, normalizeRow, formatAgenda, saveAgenda } = require('./index');

await login();
const resp = await getAgenda('2026-08-05');
const rows = resp.data.map(normalizeRow);
console.log(formatAgenda(rows, '2026-08-05'));
```

## Field per entri (setelah `normalizeRow`)

| Field | Keterangan |
|---|---|
| `acara` | Nama/keterangan agenda (HTML sudah dibersihkan) |
| `tanggal`, `hari`, `pukulAwal`, `pukulAkhir` | Waktu acara |
| `tempat` | Lokasi / link Zoom |
| `pengirim` / `dariUnit` | Asal surat |
| `tujuanUnit` / `tujuanUser` | Tujuan disposisi |
| `isiDisposisi` | Isi disposisi (mis. "ikuti", "TL") |
| `suratPdf` | URL PDF surat (esurat.surabaya.go.id) |
| `penerima[]` | Daftar `{nip, nama}` penerima |
| `raw` | Objek asli dari server (kalau butuh field lain) |

## Catatan

- `acara` dan `tempat` dari server kadang berisi HTML (`<p style=…>`), karena itu dibersihkan dulu.
- Satu surat bisa muncul beberapa kali dengan `idSuratMasuk` sama tapi `idDetail` berbeda
  (beda penerima/disposisi) — itu normal, bukan duplikat.
- Token di-cache di memori per proses; kalau kena 401, modul login ulang otomatis sekali.
