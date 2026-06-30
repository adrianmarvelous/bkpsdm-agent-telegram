const mysql = require('mysql2/promise');

// =============== KONFIGURASI DATABASE ===============

/**
 * Konfigurasi untuk masing-masing database
 * Dibaca dari environment variable dengan prefix WEB_ dan SIJAKA_
 */
const DB_CONFIGS = [
  {
    name: 'web',
    label: 'Database Website',
    prefix: 'WEB',
    fallbackPrefix: 'DB', // legacy fallback
    config: {},
  },
  {
    name: 'sijaka',
    label: 'Database SIJAKA',
    prefix: 'SIJAKA',
    fallbackPrefix: null,
    config: {},
  },
];

/**
 * Membaca konfigurasi dari environment variable
 * @param {object} dbConfig - Objek konfigurasi database
 * @returns {object} - Konfigurasi yang sudah diisi
 */
function loadConfig(dbConfig) {
  const { prefix, fallbackPrefix } = dbConfig;

  const getEnv = (key, defaultValue) => {
    // Coba dengan prefix spesifik dulu, lalu fallback
    return process.env[`${prefix}_${key}`]
      || (fallbackPrefix ? process.env[`${fallbackPrefix}_${key}`] : undefined)
      || process.env[`${key}`]
      || defaultValue;
  };

  return {
    host: getEnv('HOST', 'localhost'),
    port: parseInt(getEnv('PORT', '3306'), 10),
    user: getEnv('USER', 'root'),
    password: getEnv('PASSWORD', ''),
    database: getEnv('NAME', `${dbConfig.name}_db`),
    poolLimit: parseInt(getEnv('POOL_LIMIT', '10'), 10),
  };
}

// =============== MEMBUAT POOL KONEKSI ===============

/** Map untuk menyimpan semua pool berdasarkan nama */
const pools = new Map();

/**
 * Membuat pool koneksi untuk satu database
 * @param {string} name - Nama unik database ('web', 'sijaka', ...)
 * @param {object} cfg - Konfigurasi database
 * @returns {object} - MySQL connection pool
 */
function createPool(name, cfg) {
  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: cfg.poolLimit,
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: '+07:00', // WIB
  });
  pools.set(name, { pool, config: cfg, label: name });
  return pool;
}

// Inisialisasi semua pool dari konfigurasi
DB_CONFIGS.forEach((db) => {
  const cfg = loadConfig(db);
  db.config = cfg;
  createPool(db.name, cfg);
});

// =============== FUNGSI-FUNGSI DATABASE ===============

/**
 * Mendapatkan pool berdasarkan nama
 * @param {string} dbName - Nama database ('web' atau 'sijaka')
 * @returns {object} - MySQL connection pool
 */
function getPool(dbName = 'web') {
  if (!pools.has(dbName)) {
    throw new Error(`Database '${dbName}' tidak ditemukan. Gunakan: ${[...pools.keys()].join(', ')}`);
  }
  return pools.get(dbName).pool;
}

/**
 * Mengecek koneksi ke satu database
 * @param {string} dbName - Nama database ('web' atau 'sijaka')
 * @returns {Promise<{ok: boolean, message: string, name: string}>}
 */
async function checkConnection(dbName = 'web') {
  try {
    const entry = pools.get(dbName);
    if (!entry) {
      return { ok: false, message: `Database '${dbName}' tidak dikenal`, name: dbName };
    }
    const connection = await entry.pool.getConnection();
    await connection.query('SELECT 1 AS verifikasi');
    connection.release();
    return {
      ok: true,
      message: `Terhubung (${entry.config.user}@${entry.config.host}:${entry.config.port}/${entry.config.database})`,
      name: dbName,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Gagal: ${error.message}`,
      name: dbName,
    };
  }
}

/**
 * Mengecek koneksi ke SEMUA database yang terdaftar
 * @returns {Promise<Array<{ok: boolean, message: string, name: string}>>}
 */
async function checkAllConnections() {
  const results = [];
  for (const [name] of pools) {
    results.push(await checkConnection(name));
  }
  return results;
}

/**
 * Eksekusi query SELECT pada database tertentu
 * @param {string} dbName - Nama database ('web' atau 'sijaka')
 * @param {string} sql - Query SQL
 * @param {Array} params - Parameter untuk prepared statement
 * @returns {Promise<Array>} - Array baris hasil query
 */
async function query(dbName = 'web', sql, params = []) {
  try {
    const pool = getPool(dbName);
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (error) {
    console.error(`❌ Query error [${dbName}]:`, error.message);
    throw error;
  }
}

/**
 * Eksekusi query INSERT, UPDATE, DELETE pada database tertentu
 * @param {string} dbName - Nama database ('web' atau 'sijaka')
 * @param {string} sql - Query SQL
 * @param {Array} params - Parameter untuk prepared statement
 * @returns {Promise<object>} - Hasil { affectedRows, insertId, ... }
 */
async function execute(dbName = 'web', sql, params = []) {
  try {
    const pool = getPool(dbName);
    const [result] = await pool.execute(sql, params);
    return result;
  } catch (error) {
    console.error(`❌ Execute error [${dbName}]:`, error.message);
    throw error;
  }
}

/**
 * Mendapatkan daftar tabel dari database tertentu
 * @param {string} dbName - Nama database
 * @returns {Promise<Array>} - Daftar tabel
 */
async function getTableList(dbName = 'web') {
  try {
    const entry = pools.get(dbName);
    const db = entry.config.database;
    return await query(
      dbName,
      'SELECT TABLE_NAME, TABLE_COMMENT, ENGINE, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
      [db],
    );
  } catch (error) {
    console.error(`❌ Gagal mendapatkan daftar tabel [${dbName}]:`, error.message);
    return [];
  }
}

/**
 * Mendapatkan struktur kolom dari sebuah tabel
 * @param {string} dbName - Nama database
 * @param {string} tableName - Nama tabel
 * @returns {Promise<Array>} - Daftar kolom
 */
async function getTableColumns(dbName = 'web', tableName) {
  try {
    const entry = pools.get(dbName);
    const db = entry.config.database;
    return await query(
      dbName,
      'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [db, tableName],
    );
  } catch (error) {
    console.error(`❌ Gagal mendapatkan kolom [${dbName}]:`, error.message);
    return [];
  }
}

/**
 * Menutup SEMUA pool koneksi database
 */
async function closeAllPools() {
  for (const [name, entry] of pools) {
    try {
      await entry.pool.end();
      console.log(`🔌 ${name} (${entry.config.database}) ditutup.`);
    } catch (error) {
      console.error(`❌ Error menutup ${name}:`, error.message);
    }
  }
}

module.exports = {
  pools,
  getPool,
  checkConnection,
  checkAllConnections,
  query,
  execute,
  getTableList,
  getTableColumns,
  closeAllPools,
};
