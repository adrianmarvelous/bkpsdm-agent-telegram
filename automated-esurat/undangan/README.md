# undangan/

Folder output **automated-esurat** — hasil pengambilan agenda/undangan dari
`{ESURAT_AGENDA_URL}` disimpan di sini sebagai JSON per tanggal:

```
undangan/undangan-2026-08-05.json
```

Jalankan `node index.js <tanggal>` dari folder induk untuk mengisi folder ini.

Konten JSON: `{ tanggal, fetchedAt, total, data: [...] }` — `data` sudah
dinormalisasi (lihat `normalizeRow()` di `../index.js`).

> ⚠️ File `*.json` di folder ini **di-ignore git** karena memuat nama & NIP pegawai.
