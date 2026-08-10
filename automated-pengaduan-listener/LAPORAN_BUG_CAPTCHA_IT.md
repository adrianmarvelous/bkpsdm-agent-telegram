# Laporan Bug: Endpoint `captcha.php` HTTP 500 (SPB Pengaduan API)

**Tanggal:** 7 Agustus 2026
**Pelapor:** BKPSDM (Divisi Pengembangan SDM / Tim Otomasi)
**Prioritas:** Tinggi — memblokir seluruh alur login API Pengaduan SPB

---

## 1. Ringkasan Masalah

Endpoint **`GET /api/ai-agent/pengaduan-spb/captcha.php`** mengembalikan **HTTP 500 Internal Server Error** setiap kali dipanggil, dengan pesan:

```
Uncaught Error: Call to undefined function str_starts_with()
in /data/bkd.surabaya.go.id/public/api/ai-agent/pengaduan-spb/captcha.php:47
```

Error ini **konsisten** (100% reproduksi) dan terjadi pada setiap variasi pemanggilan (dengan/tanpa parameter, dengan/tanpa header Authorization).

**Dampak:** Endpoint ini adalah langkah pertama dari alur login API Pengaduan SPB. Karena gagal, seluruh alur berikut ikut terblokir:
`captcha.php` → `login.php?captcha=KODE` → `hotline.php`

---

## 2. Detail Error

| Item | Nilai |
|---|---|
| **Method** | `GET` |
| **URL** | `https://bkpsdm.surabaya.go.id/api/ai-agent/pengaduan-spb/captcha.php` |
| **HTTP Status** | `500 Internal Server Error` |
| **File** | `/data/bkd.surabaya.go.id/public/api/ai-agent/pengaduan-spb/captcha.php` |
| **Baris** | 47 |
| **Fungsi** | `str_starts_with()` |

**Respons JSON lengkap:**
```json
{
    "error": "Internal Server Error",
    "detail": "Uncaught Error: Call to undefined function str_starts_with() in /data/bkd.surabaya.go.id/public/api/ai-agent/pengaduan-spb/captcha.php:47\nStack trace:\n#0 {main}\n  thrown in /data/bkd.surabaya.go.id/public/api/ai-agent/pengaduan-spb/captcha.php:47"
}
```

---

## 3. Langkah Reproduksi

```bash
# 1. Login admin API untuk mendapatkan token
TOKEN=$(curl -s -X POST "https://bkpsdm.surabaya.go.id/api/ai-agent/auth/login.php" \
  -H "Content-Type: application/json" \
  -d '{"username":"<API_USERNAME>","password":"<API_PASSWORD>"}' | jq -r '.token')

# 2. Panggil captcha.php — SELALU 500
curl -s -w "\nHTTP %{http_code}\n" \
  "https://bkpsdm.surabaya.go.id/api/ai-agent/pengaduan-spb/captcha.php" \
  -H "Authorization: Bearer $TOKEN"
```

**Hasil yang diharapkan:** `200 OK` dengan JSON berisi `captcha_image` (base64 PNG) dan `jwt_token`.
**Hasil aktual:** `500` dengan error di atas.

---

## 4. Analisis Akar Masalah

`str_starts_with()` adalah **fungsi bawaan PHP yang baru diperkenalkan di PHP 8.0** (rilis November 2020).

Error `Call to undefined function` mengindikasikan **server produksi berjalan di PHP versi 7.x**, sedangkan kode di `captcha.php` baris 47 menggunakan fungsi PHP 8 tersebut.

**Bukti pendukung:** Endpoint lain di API yang sama (`auth/login.php`, `login.php`, `hotline.php`, `tugas/*.php`) **berjalan normal** — hanya `captcha.php` yang error. Ini menunjukkan kode `captcha.php` ditulis dengan sintaks PHP 8 (kemungkinan dikembangkan di lingkungan lokal PHP 8), sementara server produksi masih PHP 7.

---

## 5. Usulan Perbaikan

### Opsi A — Perbaikan Kode (cepat, 1 baris)

Ganti `str_starts_with()` dengan fungsi yang kompatibel PHP 7:

```php
// SEBELUMNYA (PHP 8 — error di server PHP 7)
if (str_starts_with($str, $prefix)) { ... }

// SESUDAHNYA (kompatibel PHP 7)
if (strpos($str, $prefix) === 0) { ... }
```

Jika ada beberapa pemakaian `str_starts_with()` di file yang sama, alternatif: tambahkan polyfill di awal file:

```php
// Polyfill untuk PHP < 8.0
if (!function_exists('str_starts_with')) {
    function str_starts_with(string $haystack, string $needle): bool {
        return $needle === '' || strpos($haystack, $needle) === 0;
    }
}
```

### Opsi B — Upgrade PHP Server ke 8.0+

Solusi permanen, namun perlu koordinasi & pengujian karena berdampak ke aplikasi lain di server.

---

## 6. Verifikasi Setelah Perbaikan

Setelah perbaikan, mohon konfirmasi bahwa:

1. `GET /api/ai-agent/pengaduan-spb/captcha.php` mengembalikan `200 OK` dengan field `captcha_image` (base64) dan `jwt_token`.
2. Alur lengkap berfungsi:
   - `POST /api/ai-agent/pengaduan-spb/login.php?captcha=KODE` → `200` dengan field `jwt`
   - `GET /api/ai-agent/pengaduan-spb/hotline.php?limit=5&hal=1&q=` dengan `Authorization: Bearer <jwt>` → `200` dengan data pengaduan

---

## 7. Informasi Tambahan

- **Lingkungan panggilan:** Server VPS dengan IP publik (datacenter). Catatan: host `spb.surabaya.go.id/permasalahanpd/...` memblokir IP datacenter (redirect 302 → error page), sedangkan host `bkpsdm.surabaya.go.id/api/ai-agent/...` tidak diblokir.
- **Kredensial:** Menggunakan kredensial API yang sama dengan endpoint tugas (`auth/login.php`).
- **Kontak:** Silakan hubungi Tim Pengembangan BKPSDM jika diperlukan detail tambahan atau akses log server.

---

*Terima kasih atas bantuannya. Mohon info perkiraan waktu perbaikan.*
