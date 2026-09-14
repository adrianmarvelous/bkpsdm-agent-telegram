# Arsip kode tidak terpakai

Dipindahkan 14 September 2026 dari root project.

## `api-server.js` (dipindah 14 Sep 2026)

Server Express yang mengekspos data jadwal & tugas lewat HTTP (port 3000).

Cara pakai semula: `npm install express && node api-server.js`

**Alasan diarsipkan — tidak pernah dijalankan dan tidak dipanggil apa pun:**

- tidak ada di `ecosystem.config.cjs` maupun `dump.pm2` (tidak pernah menjadi proses PM2)
- `express` tidak terpasang di `node_modules`/`package.json` → memang tidak bisa jalan
- tidak ada referensi dari kode/skrip lain di repo ini
- tidak disentuh sejak 14 Juli 2026

Fungsinya kini sudah tercakup oleh bot Telegram/WhatsApp: dispatcher memanggil
`src/services/apiClient` langsung, jadi server HTTP terpisah tidak dibutuhkan.

**Kalau ingin dihidupkan lagi:** `npm install express`, pindahkan kembali ke root,
jalankan `node api-server.js`, lalu (kalau mau permanen) daftarkan ke `ecosystem.config.cjs`
dan tambahkan ke daftar app yang dipantau `~/.hermes/scripts/pm2-watchdog.sh`.
