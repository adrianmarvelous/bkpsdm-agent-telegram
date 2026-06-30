# API Contract — BKPSDM Telegram Bot Backend (PHP Native)

> Dokumen ini berisi spesifikasi lengkap backend API yang dibutuhkan oleh Telegram Bot BKPSDM.
> Gunakan dokumen ini sebagai acuan untuk membuat API server menggunakan **PHP Native** oleh AI Agent DeepSeek V4 atau developer mana pun.

---

## 📦 Tech Stack yang Direkomendasikan

| Komponen | Teknologi |
|----------|-----------|
| Runtime | PHP 8.x |
| Web Server | PHP Built-in Server (`php -S`) atau Apache/Nginx |
| Database | MySQL 8.x |
| Driver DB | `mysqli` atau `PDO` |
| Autentikasi | `firebase/php-jwt` (via Composer) atau manual JWT |
| JSON | `json_encode` / `json_decode` native |
| Env | `vlucas/phpdotenv` (via Composer) atau parse manual |

---

## 🔐 Sistem Autentikasi

Semua endpoint (kecuali login) **WAJIB** menyertakan **Bearer Token** di header.

### Alur Autentikasi

```
Bot/Client                     Backend API (PHP)
    │                              │
    │  POST /api/auth/login        │
    │  { username, password }      │
    │ ──────────────────────────>  │
    │                              │── Verifikasi username & password
    │                              │── Generate JWT token (exp: 24 jam)
    │  { token: "eyJ..." }        │
    │ <──────────────────────────  │
    │                              │
    │  GET /api/jadwal/hari-ini    │
    │  Authorization: Bearer eyJ...│
    │ ──────────────────────────>  │
    │                              │── Middleware verifikasi token
    │  { rows: [...] }            │
    │ <──────────────────────────  │
```

### Konfigurasi di `.env`

```
# Autentikasi API
API_USERNAME=admin_bkpsdm
API_PASSWORD=BkpsdmSby@2024!
JWT_SECRET=bkpsdm-jwt-secret-key-2026-ganti-sesuai-keinginan
JWT_EXPIRES_IN=3600
```

### Cara Install JWT Library (via Composer)

```bash
# Di root folder project
composer require firebase/php-jwt
```

Alternatif: bisa pakai JWT manual (tanpa Composer), tinggal copy library atau implementasi `hash_hmac()` sederhana.

### Middleware Auth (PHP Native)

Buat file `middleware/AuthMiddleware.php`:

```php
<?php
require_once __DIR__ . '/../vendor/autoload.php';

use Firebase\JWT\JWT;
use Firebase\JWT\Key;

function authenticate() {
    $headers = getallheaders();
    $authHeader = $headers['Authorization'] ?? '';

    if (!preg_match('/^Bearer\s(.+)$/', $authHeader, $matches)) {
        http_response_code(401);
        echo json_encode(['error' => 'Token tidak disertakan']);
        exit;
    }

    $token = $matches[1];

    try {
        $decoded = JWT::decode($token, new Key($_ENV['JWT_SECRET'], 'HS256'));
        return (array) $decoded;
    } catch (Exception $e) {
        http_response_code(401);
        echo json_encode(['error' => 'Token tidak valid atau kedaluwarsa']);
        exit;
    }
}
```

Gunakan di setiap endpoint yang butuh auth:
```php
require_once __DIR__ . '/middleware/AuthMiddleware.php';
$user = authenticate(); // otomatis exit(401) jika gagal
```

---

## 📋 Daftar Endpoint API

### Root URL: `/api`

Semua endpoint mengembalikan response JSON dengan `Content-Type: application/json`.

---

### 0️⃣ POST `/api/auth/login` (NO AUTH)

Login untuk mendapatkan Bearer Token. **Endpoint ini SATU-SATUNYA yang tidak perlu token.**

**Request Body (JSON):**
```json
{
  "username": "admin_bkpsdm",
  "password": "BkpsdmSby@2024!"
}
```

**PHP Logic:**
```php
<?php
$input = json_decode(file_get_contents('php://input'), true);
$username = $input['username'] ?? '';
$password = $input['password'] ?? '';

if ($username !== $_ENV['API_USERNAME'] || $password !== $_ENV['API_PASSWORD']) {
    http_response_code(401);
    echo json_encode(['error' => 'Username atau password salah']);
    exit;
}

$payload = [
    'iss' => 'bkpsdm-api',
    'iat' => time(),
    'exp' => time() + (intval($_ENV['JWT_EXPIRES_IN'] ?? 3600)),
    'username' => $username,
];

$token = JWT::encode($payload, $_ENV['JWT_SECRET'], 'HS256');
echo json_encode(['token' => $token, 'expiresIn' => ($_ENV['JWT_EXPIRES_IN'] ?? 3600) . 's']);
```

**Response 200:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": "3600s"
}
```

**Response 401:**
```json
{
  "error": "Username atau password salah"
}
```

---

### 1️⃣ GET `/api/health`

Cek koneksi ke kedua database. **Wajib header `Authorization: Bearer <token>`.**

**PHP Logic:**
```php
<?php
require_once __DIR__ . '/../middleware/AuthMiddleware.php';
require_once __DIR__ . '/../config/database.php';

authenticate();

$db1 = checkConnection('web');
$db2 = checkConnection('sijaka');

$allOk = $db1['ok'] && $db2['ok'];
$status = $allOk ? 'ok' : 'degraded';

echo json_encode([
    'status' => $status,
    'databases' => [$db1, $db2],
]);
```

**Response 200:**
```json
{
  "status": "ok",
  "databases": [
    {
      "name": "web",
      "ok": true,
      "message": "Terhubung (programmer_bkd@172.18.0.78:3306/bkd_surabaya)"
    },
    {
      "name": "sijaka",
      "ok": false,
      "message": "Gagal: connect ETIMEDOUT"
    }
  ]
}
```

**Response 401:**
```json
{
  "error": "Token tidak valid atau kedaluwarsa"
}
```

---

### 2️⃣ GET `/api/jadwal/hari-ini`

Mendapatkan daftar jadwal rapat untuk hari ini.

**Query ke database `bkd_surabaya`:**
```sql
SELECT id, nama_acara, tanggal_mulai, pukul_mulai, pukul_selesai, tempat, keterangan
FROM dashboard_web_jadwal_rapat
WHERE tanggal_mulai = CURDATE()
ORDER BY pukul_mulai
```

**PHP Logic:**
```php
<?php
require_once __DIR__ . '/../middleware/AuthMiddleware.php';
require_once __DIR__ . '/../config/database.php';

authenticate();
$rows = query('web', "SELECT id, nama_acara, tanggal_mulai, pukul_mulai, pukul_selesai, tempat, keterangan FROM dashboard_web_jadwal_rapat WHERE tanggal_mulai = CURDATE() ORDER BY pukul_mulai");

if (count($rows) > 0) {
    echo json_encode(['rows' => $rows]);
} else {
    echo json_encode(['rows' => [], 'message' => 'Tidak ada jadwal rapat untuk hari ini']);
}
```

**Response 200 (ada data):**
```json
{
  "rows": [
    {
      "id": 1,
      "nama_acara": "Rapat Koordinasi Kepegawaian",
      "tanggal_mulai": "2026-06-30",
      "pukul_mulai": "09:00:00",
      "pukul_selesai": "11:00:00",
      "tempat": "Ruang Rapat Lt. 2",
      "keterangan": "Divisi Pengembangan"
    }
  ]
}
```

**Response 200 (kosong):**
```json
{
  "rows": [],
  "message": "Tidak ada jadwal rapat untuk hari ini (2026-06-30)"
}
```

---

### 3️⃣ GET `/api/jadwal/tanggal?date=YYYY-MM-DD`

| Parameter | Tipe | Wajib | Contoh |
|-----------|------|-------|--------|
| `date` | string | Ya | `2026-06-26` |

**Query:**
```sql
SELECT ... FROM dashboard_web_jadwal_rapat
WHERE tanggal_mulai = ?
ORDER BY pukul_mulai
```

**PHP (gunakan prepared statement untuk keamanan):**
```php
$date = $_GET['date'] ?? '';
$rows = query('web', "SELECT ... FROM dashboard_web_jadwal_rapat WHERE tanggal_mulai = ? ORDER BY pukul_mulai", [$date]);

if (count($rows) > 0) {
    echo json_encode(['rows' => $rows]);
} else {
    echo json_encode(['rows' => [], 'message' => "Tidak ada jadwal rapat untuk tanggal $date"]);
}
```

---

### 4️⃣ GET `/api/jadwal/minggu-ini`

Rentang tanggal dihitung dari:
- **Senin**: hari ini - (hari_ini - 1) jika Senin-Sabtu, atau hari ini - 6 jika Minggu
- **Minggu**: Senin + 6 hari

```php
$today = new DateTime();
$dayOfWeek = (int)$today->format('N'); // 1=Senin .. 7=Minggu
$diffToMonday = $dayOfWeek - 1;
$monday = (clone $today)->modify("-{$diffToMonday} days")->format('Y-m-d');
$sunday = (clone $today)->modify("+" . (6 - $diffToMonday) . " days")->format('Y-m-d');

$rows = query('web', "SELECT ... FROM dashboard_web_jadwal_rapat WHERE tanggal_mulai BETWEEN ? AND ? ORDER BY tanggal_mulai, pukul_mulai", [$monday, $sunday]);
```

**Response 200 (kosong):**
```json
{
  "rows": [],
  "message": "Tidak ada jadwal rapat minggu ini (2026-06-29 - 2026-07-05)"
}
```

---

### 5️⃣ GET `/api/jadwal/semua`

```sql
SELECT ... FROM dashboard_web_jadwal_rapat
ORDER BY tanggal_mulai DESC LIMIT 10
```

---

### 6️⃣ GET `/api/jadwal/:id`

Untuk routing parameter di URL di PHP, bisa pakai `$_GET['id']` dengan `.htaccess` rewrite, atau query string `?id=1`:

```
GET /api/jadwal/detail?id=1
```

Atau gunakan parsing manual dari `$_SERVER['REQUEST_URI']`:
```php
$uri = $_SERVER['REQUEST_URI'];
preg_match('/\/api\/jadwal\/(\d+)/', $uri, $matches);
$id = $matches[1] ?? 0;

$rows = query('web', "SELECT ... FROM dashboard_web_jadwal_rapat WHERE id = ?", [$id]);

if (count($rows) > 0) {
    echo json_encode(['row' => $rows]);
} else {
    http_response_code(404);
    echo json_encode(['error' => 'Jadwal tidak ditemukan']);
}
```

---

### 7️⃣ GET `/api/tugas/hari-ini`

**Query ke database `bkpsdm_surabaya_2`:**
```sql
SELECT dt.id, dt.tugas, dt.tanggal, dt.jam, dt.disposisi_ke,
       GROUP_CONCAT(dtc.nama SEPARATOR ', ') AS pegawai
FROM disposisi_tugas dt
LEFT JOIN disposisi_tugas_content dtc ON dt.id = dtc.id_disposisi_tugas
WHERE dt.tanggal = CURDATE()
GROUP BY dt.id
ORDER BY dt.jam
```

**Response 200 (ada data):**
```json
{
  "rows": [
    {
      "id": 10,
      "tugas": "Rapat Koordinasi Kepegawaian",
      "tanggal": "2026-06-30",
      "jam": "09:00:00",
      "disposisi_ke": "Telegram Bot",
      "pegawai": "Budi, Siti, Ahmad"
    }
  ]
}
```

---

### 8️⃣ GET `/api/tugas/tanggal?date=YYYY-MM-DD`

| Parameter | Tipe | Wajib | Contoh |
|-----------|------|-------|--------|
| `date` | string | Ya | `2026-06-26` |

```sql
SELECT ... FROM disposisi_tugas dt
LEFT JOIN disposisi_tugas_content dtc ON dt.id = dtc.id_disposisi_tugas
WHERE dt.tanggal = ?
GROUP BY dt.id ORDER BY dt.jam
```

---

### 9️⃣ GET `/api/tugas/semua`

```sql
SELECT ... FROM disposisi_tugas dt
LEFT JOIN disposisi_tugas_content dtc ON dt.id = dtc.id_disposisi_tugas
GROUP BY dt.id ORDER BY dt.tanggal DESC LIMIT 10
```

---

### 🔟 POST `/api/tugas`

**Request Body:**
```json
{
  "tugas": "Rapat Koordinasi Kepegawaian",
  "tanggal": "2026-06-30",
  "jam": "09:00:00",
  "disposisi_ke": "Telegram Bot",
  "pegawai": ["Budi", "Siti", "Ahmad"]
}
```

**PHP Logic:**
```php
$input = json_decode(file_get_contents('php://input'), true);

// Validasi
if (empty($input['tugas'])) {
    http_response_code(400);
    echo json_encode(['error' => "Field 'tugas' wajib diisi"]);
    exit;
}

// 1. Insert ke disposisi_tugas
$insertId = execute('sijaka', "INSERT INTO disposisi_tugas (tugas, tanggal, jam, disposisi_ke, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())", [
    $input['tugas'],
    $input['tanggal'],
    $input['jam'],
    $input['disposisi_ke'] ?? 'Telegram Bot',
]);

// 2. Insert setiap pegawai ke disposisi_tugas_content
foreach ($input['pegawai'] as $nama) {
    execute('sijaka', "INSERT INTO disposisi_tugas_content (id_disposisi_tugas, nip_nik, nama, created_at) VALUES (?, '-', ?, NOW())", [
        $insertId,
        trim($nama),
    ]);
}

http_response_code(201);
echo json_encode([
    'id' => $insertId,
    'insertId' => $insertId,
    'totalPegawai' => count($input['pegawai']),
    'pegawai' => $input['pegawai'],
]);
```

---

### 1️⃣1️⃣ DELETE `/api/tugas/:id`

```php
$uri = $_SERVER['REQUEST_URI'];
preg_match('/\/api\/tugas\/(\d+)/', $uri, $matches);
$id = $matches[1] ?? 0;

// 1. Hapus content dulu (foreign key)
execute('sijaka', "DELETE FROM disposisi_tugas_content WHERE id_disposisi_tugas = ?", [$id]);
// 2. Hapus induk
$affected = execute('sijaka', "DELETE FROM disposisi_tugas WHERE id = ?", [$id]);

if ($affected > 0) {
    echo json_encode(['deleted' => true, 'affectedRows' => $affected]);
} else {
    http_response_code(404);
    echo json_encode(['error' => 'Tugas tidak ditemukan', 'deleted' => false, 'affectedRows' => 0]);
}
```

---

## 🗄️ Config Database (PHP)

Buat file `config/database.php`:

```php
<?php
/**
 * Koneksi ke 2 database MySQL menggunakan mysqli
 */

// ====== KONFIGURASI ======

$DB_CONFIGS = [
    'web' => [
        'host' => $_ENV['WEB_HOST'] ?? '172.18.0.78',
        'port' => $_ENV['WEB_PORT'] ?? '3306',
        'user' => $_ENV['WEB_USER'] ?? 'programmer_bkd',
        'password' => $_ENV['WEB_PASSWORD'] ?? '',
        'database' => $_ENV['WEB_NAME'] ?? 'bkd_surabaya',
    ],
    'sijaka' => [
        'host' => $_ENV['SIJAKA_HOST'] ?? '172.18.0.78',
        'port' => $_ENV['SIJAKA_PORT'] ?? '3306',
        'user' => $_ENV['SIJAKA_USER'] ?? 'pompi_bkd',
        'password' => $_ENV['SIJAKA_PASSWORD'] ?? '',
        'database' => $_ENV['SIJAKA_NAME'] ?? 'bkpsdm_surabaya_2',
    ],
];

// Cache koneksi (koneksi sekali, reusable)
$CONNECTIONS = [];

/**
 * Mendapatkan koneksi ke database tertentu
 */
function getConnection($dbName) {
    global $DB_CONFIGS, $CONNECTIONS;

    if (isset($CONNECTIONS[$dbName])) {
        return $CONNECTIONS[$dbName];
    }

    $cfg = $DB_CONFIGS[$dbName] ?? null;
    if (!$cfg) {
        throw new Exception("Database '$dbName' tidak dikenal");
    }

    $conn = new mysqli($cfg['host'], $cfg['user'], $cfg['password'], $cfg['database'], $cfg['port']);
    if ($conn->connect_error) {
        throw new Exception("Koneksi $dbName gagal: " . $conn->connect_error);
    }

    $conn->set_charset('utf8mb4');
    $conn->query("SET time_zone = '+07:00'");

    $CONNECTIONS[$dbName] = $conn;
    return $conn;
}

/**
 * Query SELECT — return array of rows
 * Support prepared statement (? placeholder)
 */
function query($dbName, $sql, $params = []) {
    $conn = getConnection($dbName);

    if (empty($params)) {
        $result = $conn->query($sql);
        if (!$result) {
            throw new Exception("Query error [$dbName]: " . $conn->error);
        }
        $rows = [];
        while ($row = $result->fetch_assoc()) {
            $rows[] = $row;
        }
        return $rows;
    }

    // Prepared statement
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        throw new Exception("Prepare error [$dbName]: " . $conn->error);
    }

    // Bind params
    $types = '';
    $bindParams = [];
    foreach ($params as $p) {
        if (is_int($p)) { $types .= 'i'; }
        elseif (is_float($p)) { $types .= 'd'; }
        else { $types .= 's'; }
        $bindParams[] = $p;
    }

    if (!empty($bindParams)) {
        $stmt->bind_param($types, ...$bindParams);
    }

    $stmt->execute();
    $result = $stmt->get_result();
    if ($result === false) {
        throw new Exception("Execute error [$dbName]: " . $stmt->error);
    }

    $rows = [];
    while ($row = $result->fetch_assoc()) {
        $rows[] = $row;
    }
    $stmt->close();
    return $rows;
}

/**
 * Query INSERT/UPDATE/DELETE — return affectedRows atau insertId
 */
function execute($dbName, $sql, $params = []) {
    $conn = getConnection($dbName);

    if (empty($params)) {
        $conn->query($sql);
        return $conn->affected_rows;
    }

    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        throw new Exception("Prepare error [$dbName]: " . $conn->error);
    }

    $types = '';
    $bindParams = [];
    foreach ($params as $p) {
        if (is_int($p)) { $types .= 'i'; }
        elseif (is_float($p)) { $types .= 'd'; }
        else { $types .= 's'; }
        $bindParams[] = $p;
    }

    if (!empty($bindParams)) {
        $stmt->bind_param($types, ...$bindParams);
    }

    $stmt->execute();

    // Cek apakah ini INSERT → return insert_id
    if (preg_match('/^INSERT/i', trim($sql))) {
        $insertId = $stmt->insert_id;
        $stmt->close();
        return $insertId;
    }

    $affected = $stmt->affected_rows;
    $stmt->close();
    return $affected;
}

/**
 * Cek koneksi ke satu database
 */
function checkConnection($dbName) {
    try {
        $conn = getConnection($dbName);
        $result = $conn->query("SELECT 1 AS verifikasi");
        $cfg = $GLOBALS['DB_CONFIGS'][$dbName];
        return [
            'name' => $dbName,
            'ok' => true,
            'message' => "Terhubung ({$cfg['user']}@{$cfg['host']}:{$cfg['port']}/{$cfg['database']})",
        ];
    } catch (Exception $e) {
        return [
            'name' => $dbName,
            'ok' => false,
            'message' => "Gagal: " . $e->getMessage(),
        ];
    }
}
```

---

## 📁 Struktur File Backend yang Disarankan

```
bkpsdm-api/
├── .env
├── .htaccess                  # URL rewriting (Apache) atau pakai PHP router
├── composer.json
├── composer.lock
├── index.php                  # Entry point / Router utama
├── config/
│   └── database.php           # Koneksi mysqli ke 2 database
├── middleware/
│   └── AuthMiddleware.php     # Middleware JWT
├── routes/
│   ├── auth.php               # POST /api/auth/login
│   ├── health.php             # GET /api/health
│   ├── jadwal.php             # Semua /api/jadwal/*
│   └── tugas.php              # Semua /api/tugas/*
└── helpers/
    └── response.php           # Fungsi jsonResponse, errorResponse, dll
```

---

## 🚀 Cara Menjalankan API Server (PHP Native)

### Opsi A: PHP Built-in Server (Paling Gampang)

```bash
# 1. Buat project
mkdir bkpsdm-api && cd bkpsdm-api

# 2. Inisialisasi Composer
composer init --name="bkpsdm/api" --type="project" -n
composer require firebase/php-jwt
composer require vlucas/phpdotenv

# 3. Buat .env
cat > .env << 'ENVEOF'
PORT=3001

# Autentikasi API
API_USERNAME=admin_bkpsdm
API_PASSWORD=BkpsdmSby@2024!
JWT_SECRET=bkpsdm-jwt-secret-key-2026-ganti-sesuai-keinginan
JWT_EXPIRES_IN=3600

# Database WEB (bkd_surabaya)
WEB_HOST=172.18.0.78
WEB_PORT=3306
WEB_USER=programmer_bkd
WEB_PASSWORD=programmer_bKd@2020
WEB_NAME=bkd_surabaya

# Database SIJAKA (bkpsdm_surabaya_2)
SIJAKA_HOST=172.18.0.78
SIJAKA_PORT=3306
SIJAKA_USER=pompi_bkd
SIJAKA_PASSWORD=luckyLif+15
SIJAKA_NAME=bkpsdm_surabaya_2
ENVEOF

# 4. Buat file index.php (router) dan folder lainnya (lihat struktur di atas)

# 5. Jalankan
php -S 0.0.0.0:3001 -t . index.php
```

### Opsi B: Dengan Apache (.htaccess)

```apache
RewriteEngine On
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule ^(.*)$ index.php [QSA,L]
```

---

## ✅ Testing Endpoint (dengan token)

```bash
# 1. Login dulu
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin_bkpsdm","password":"BkpsdmSby@2024!"}' | jq -r '.token')

echo "Token: $TOKEN"

# 2. Pake token buat akses API
curl -s http://localhost:3001/api/health \
  -H "Authorization: Bearer $TOKEN" | jq

curl -s http://localhost:3001/api/jadwal/hari-ini \
  -H "Authorization: Bearer $TOKEN" | jq

curl -s "http://localhost:3001/api/jadwal/tanggal?date=2026-06-26" \
  -H "Authorization: Bearer $TOKEN" | jq

curl -s -X POST http://localhost:3001/api/tugas \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tugas":"Test Rapat","tanggal":"2026-06-30","jam":"10:00:00","disposisi_ke":"Bot","pegawai":["Budi","Siti"]}' | jq

# 3. Coba tanpa token (harus return 401)
curl -s http://localhost:3001/api/health | jq
# → { "error": "Token tidak disertakan" }
```

---

## 📝 Catatan Penting

1. **Database `172.18.0.78` hanya bisa diakses dari jaringan internal** — deploy API di server yang punya akses.
2. **Timezone** — database pakai `+07:00` (WIB). Sudah di-set di config.
3. **JWT Secret** — ganti `JWT_SECRET` dengan string acak yang kuat di production.
4. **Input validation** — semua input dari user (POST body, GET params) harus divalidasi & pakai prepared statement.
5. **Error handling** — semua endpoint harus pakai try-catch, jangan sampai error mentah bocor ke response.
6. **CORS** — kalau API di domain berbeda dengan bot, tambahkan header:
   ```php
   header('Access-Control-Allow-Origin: *');
   header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
   header('Access-Control-Allow-Headers: Content-Type, Authorization');
   ```
7. **PHP versi 8.x** — pastikan server pakai PHP 8.x untuk fitur modern (named arguments, match, dll). PHP 7.4 ke atas juga OK.
