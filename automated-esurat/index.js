/**
 * automated-esurat — klien API eSurat / agenda undangan KantorKu Surabaya.
 *
 * Endpoint:
 *   POST {ESURAT_LOGIN_URL}                        → { token, user }   (Laravel Sanctum)
 *   GET  {ESURAT_AGENDA_URL}?tanggal=YYYY-MM-DD    → { success, data: [...], message }
 *
 * Cara pakai (CLI):
 *   node index.js 2026-08-05          → ringkasan undangan + simpan JSON ke undangan/
 *   node index.js 2026-08-05 --json   → cetak JSON mentah
 *   node index.js --login             → cuma tes login
 *   node index.js                     → pakai tanggal hari ini (WIB)
 *   node index.js 2026-08-05 --dry    → tampilkan saja, TIDAK menyimpan file
 *
 * Sebagai modul:
 *   const { login, getAgenda, formatAgenda } = require('./index');
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

let cachedToken = null;

function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args); }

/** Buang tag HTML + rapikan spasi (kolom `acara` kadang berisi <p>…</p>). */
function stripHtml(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fetch dengan timeout (AbortController). */
async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.requestTimeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Login → simpan token di memori. Return { token, user }. */
async function login() {
  if (!config.username || !config.password) {
    throw new Error('ESURAT_USERNAME / ESURAT_PASSWORD belum diisi di root .env');
  }
  const res = await fetchWithTimeout(config.loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username: config.username, password: config.password }),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Login bukan JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || !data.token) {
    throw new Error(`Login gagal (HTTP ${res.status}): ${text.slice(0, 250)}`);
  }
  cachedToken = data.token;
  log(`✅ Login OK sebagai "${data.user?.username || config.username}" (token ${String(cachedToken).slice(0, 10)}…)`);
  return { token: cachedToken, user: data.user };
}

/**
 * Ambil agenda/undangan untuk satu tanggal.
 * Kalau token kedaluwarsa (401), login ulang otomatis SEKALI.
 */
async function getAgenda(tanggal, { retry = true } = {}) {
  if (!tanggal || !/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) {
    throw new Error(`tanggal wajib format YYYY-MM-DD (dapat: "${tanggal}")`);
  }
  if (!cachedToken) await login();

  const url = `${config.agendaUrl}?tanggal=${encodeURIComponent(tanggal)}`;
  const res = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${cachedToken}`, Accept: 'application/json' },
  });
  const text = await res.text();

  if (res.status === 401 && retry) {
    log('⚠️  Token ditolak (401) — login ulang lalu coba sekali lagi…');
    cachedToken = null;
    await login();
    return getAgenda(tanggal, { retry: false });
  }

  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Respons bukan JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  // Server membalas 404 {"success":false,"message":"Data tidak ditemukan"} untuk tanggal
  // yang memang tidak punya agenda. Itu BUKAN error — perlakukan sebagai hasil kosong.
  if (res.status === 404 && data && data.success === false) {
    return { success: false, data: [], message: data.message || 'Data tidak ditemukan' };
  }
  if (!res.ok) throw new Error(`Gagal ambil agenda (HTTP ${res.status}): ${text.slice(0, 250)}`);
  return data;
}

/** Normalisasi 1 baris agenda → field yang enak dipakai (HTML dibersihkan). */
function normalizeRow(r) {
  return {
    idSuratMasuk: r.id_surat_masuk,
    idDetail: r.id_detail,
    tanggal: r.tanggal,
    hari: r.hari,
    pukulAwal: r.pukul_awal,
    pukulAkhir: r.pukul_akhir,
    acara: stripHtml(r.acara),
    tempat: stripHtml(r.tempat),
    pengirim: stripHtml(r.dinas_pengirim),
    penandatangan: stripHtml(r.dinas_penandatangan),
    dariUnit: stripHtml(r.dari_unit),
    tujuanUnit: stripHtml(r.tujuan_unit),
    dariUser: stripHtml(r.dari_user),
    tujuanUser: stripHtml(r.tujuan_user),
    isiDisposisi: stripHtml(r.isi_disposisi),
    suratPdf: r.surat,
    lampiran: r.lampiran,
    penerima: Array.isArray(r.user_penerima)
      ? r.user_penerima.filter((u) => u && (u.nip || u.nama)).map((u) => ({ nip: u.nip, nama: u.nama }))
      : [],
    raw: r,
  };
}

/** Ringkasan teks untuk dibaca manusia / dikirim ke chat. */
function formatAgenda(rows, tanggal) {
  if (!rows.length) return `📭 Tidak ada undangan/agenda untuk ${tanggal}.`;
  const lines = [`📅 UNDANGAN / AGENDA — ${tanggal} (${rows.length} entri)`, ''];
  rows.forEach((r, i) => {
    const entry = [
      `${i + 1}. ${r.pukulAwal || '-'}${r.pukulAkhir ? '–' + r.pukulAkhir : ''} — ${r.acara || '(tanpa acara)'}`,
      `   🏢 ${r.pengirim || '-'}${r.tempat ? ` | 📍 ${r.tempat}` : ''}`,
    ];
    if (r.tujuanUnit || r.tujuanUser) entry.push(`   👤 ${r.tujuanUnit || '-'}${r.tujuanUser ? ` (${r.tujuanUser})` : ''}`);
    if (r.penerima.length) entry.push(`   👥 ${r.penerima.length} penerima`);
    if (r.suratPdf) entry.push(`   📄 ${r.suratPdf}`);
    lines.push(...entry, '');
  });
  return lines.join('\n').trim();
}

/** Simpan hasil ke undangan/undangan-<tanggal>.json */
function saveAgenda(tanggal, rows) {
  fs.mkdirSync(config.outputDir, { recursive: true });
  const file = path.join(config.outputDir, `undangan-${tanggal}.json`);
  fs.writeFileSync(file, JSON.stringify({ tanggal, fetchedAt: new Date().toISOString(), total: rows.length, data: rows }, null, 2));
  return file;
}

function todayWib() {
  // WIB = UTC+7
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

// ===================== CLI =====================
async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const positional = args.filter((a) => !a.startsWith('--'));

  if (flags.includes('--login')) {
    await login();
    return;
  }

  const tanggal = positional[0] || todayWib();
  log(`📡 Ambil agenda eSurat untuk tanggal ${tanggal}…`);
  const resp = await getAgenda(tanggal);
  const rows = (resp.data || []).map(normalizeRow);

  if (flags.includes('--json')) {
    console.log(JSON.stringify(resp, null, 2));
    return;
  }

  console.log('');
  console.log(formatAgenda(rows, tanggal));
  console.log('');

  if (!flags.includes('--dry')) {
    const file = saveAgenda(tanggal, rows);
    log(`💾 Disimpan: ${file}`);
  }
  log(`✅ Selesai — ${rows.length} entri (message server: "${resp.message || '-'}")`);
}

module.exports = { login, getAgenda, normalizeRow, formatAgenda, saveAgenda, stripHtml, todayWib, config };

if (require.main === module) {
  main().catch((e) => { console.error(`❌ Error: ${e.message}`); process.exitCode = 1; });
}
