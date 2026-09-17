/**
 * Reminder undangan/agenda eSurat — kirim notifikasi ke Telegram DAN WhatsApp
 * SEKITAR 1 JAM SEBELUM acara mulai, KHUSUS untuk unit kerja tujuan tertentu
 * (default: SEKRETARIAT).
 *
 * Alur:
 *   1. Ambil agenda tanggal hari ini (WIB) dari API eSurat.
 *   2. Filter entri yang `tujuan_unit` == unit target (default SEKRETARIAT).
 *   3. Hitung selisih waktu mulai vs sekarang (WIB). Kalau 0 < selisih <= window (60 menit)
 *      dan belum pernah diingatkan → kirim pesan.
 *   4. Simpan penanda di reminder-state.json supaya TIDAK kirim ulang.
 *
 * Pengiriman WA lewat bridge bot (pm2 bkpsdm-wa) — proses ini TIDAK membuka
 * koneksi WA sendiri (2 koneksi session sama = di-kick WhatsApp).
 *   POST http://127.0.0.1:8787/wa/send  { token, text, to }
 *
 * Nomor tujuan + tag nama dibaca dari root .env:
 *   WA_CONTACTS=adrian:6281216435394,nancy:6282244649994
 *   (kalau kosong → fallback ke WA_ALLOWED_NUMBERS, tag otomatis wa1, wa2, …)
 *
 * CLI:
 *   node reminder.js                            → normal (TG + WA ke semua kontak)
 *   node reminder.js --dry                      → tampilkan saja, tidak kirim & tidak simpan
 *   node reminder.js --now "2026-09-10 08:00"   → simulasi waktu (WIB) untuk uji
 *   node reminder.js --to adrian                → WA hanya ke tag `adrian` (bisa `a,b`)
 *   node reminder.js --no-wa / --no-tg          → matikan salah satu channel
 *   node reminder.js --force                    → abaikan penanda sudah-dikirim (uji)
 *   node reminder.js --window 60                → jendela reminder (menit)
 *   node reminder.js --unit SEKRETARIAT         → override unit tujuan
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { login, getAgenda, normalizeRow } = require('./index');
const { resolveUnitList, cocokUnit, labelUnit } = require('./units');

const STATE_FILE = path.join(__dirname, 'reminder-state.json');

const ARGS = process.argv.slice(2);
const FLAG = (n) => ARGS.includes('--' + n);
const OPT = (n, d) => {
  const i = ARGS.indexOf('--' + n);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : d;
};

const DRY = FLAG('dry');
const FORCE = FLAG('force');
const NO_TG = FLAG('no-tg');
const NO_WA = FLAG('no-wa');
const WINDOW_MIN = parseInt(OPT('window', process.env.ESURAT_REMINDER_WINDOW_MIN || '60'), 10) || 60;
// Unit tujuan yang diingatkan. Boleh LEBIH DARI SATU, dipisah koma — mis.
//   ESURAT_REMINDER_UNIT=SEKRETARIAT,SUB BAGIAN KEUANGAN
// Alias juga diterima (mis. "keuangan"); "semua" = seluruh unit. Lihat units.js.
const UNIT_INPUT = String(OPT('unit', process.env.ESURAT_REMINDER_UNIT || 'SEKRETARIAT') || '').trim();
const UNIT_LIST = UNIT_INPUT ? resolveUnitList(UNIT_INPUT) : resolveUnitList('SEKRETARIAT');
const TARGET_LABEL = UNIT_LIST ? labelUnit(UNIT_LIST) : 'SEMUA UNIT';
const NOW_ARG = OPT('now', null);
// Sasaran WA: dari --to (prioritas) atau env ESURAT_REMINDER_WA_TO; kosong = semua kontak.
const WA_ONLY_TAGS = (OPT('to', process.env.ESURAT_REMINDER_WA_TO || '') || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.ESURAT_REMINDER_CHAT_ID
  || (process.env.ALLOWED_CHAT_IDS || '').split(',')[0]
  || null;

const WA_BRIDGE_URL = process.env.WA_BRIDGE_URL || 'http://127.0.0.1:8787/wa/send';
const WA_BRIDGE_TOKEN = process.env.WA_BRIDGE_TOKEN || '572182ec20aa6d9202f0f0bb';

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }

/** Kontak WA: tag → nomor. Dari WA_CONTACTS, fallback WA_ALLOWED_NUMBERS. */
function waContacts() {
  const map = new Map();
  (process.env.WA_CONTACTS || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((pair) => {
    const [tag, num] = pair.split(':');
    const n = String(num || '').replace(/[^0-9]/g, '');
    if (tag && n) map.set(tag.trim().toLowerCase(), n);
  });
  if (map.size === 0) {
    (process.env.WA_ALLOWED_NUMBERS || '').split(',').map((s) => s.replace(/[^0-9]/g, '')).filter(Boolean)
      .forEach((n, i) => map.set(`wa${i + 1}`, n));
  }
  return map;
}

/** sasaran WA sesuai --to (kalau kosong = semua kontak) */
function waTargets() {
  const all = waContacts();
  if (WA_ONLY_TAGS.length === 0) return [...all.entries()];
  return WA_ONLY_TAGS.map((t) => {
    if (!all.has(t)) { log(`⚠️  tag WA "${t}" tidak ada di WA_CONTACTS — dilewati.`); return null; }
    return [t, all.get(t)];
  }).filter(Boolean);
}

// ===================== WAKTU (semua eksplisit WIB / UTC+7) =====================

/** "YYYY-MM-DD" + "HH:MM" (WIB) → epoch ms. */
function wibToMs(tanggal, jam) {
  const [y, m, d] = tanggal.split('-').map(Number);
  const [hh, mm] = String(jam).split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh - 7, mm || 0, 0, 0);
}

/** epoch ms → "YYYY-MM-DD" di WIB. */
function msToWibDate(ms) {
  return new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

/** "2026-09-10" → "10 September 2026" */
function tanggalIndo(t) {
  const [y, m, d] = t.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${BULAN[m - 1]} ${y}`;
}

/** "2026-09-10" → "Kamis, 10 September 2026" */
function tanggalIndoLengkap(t) {
  const [y, m, d] = t.split('-').map(Number);
  const hari = HARI[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${hari}, ${String(d).padStart(2, '0')} ${BULAN[m - 1]} ${y}`;
}

// ===================== SUSUN PESAN =====================

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** HTML (Telegram) → teks polos bergaya WhatsApp. */
function toWaText(s) {
  return String(s || '')
    .replace(/<b>(.*?)<\/b>/g, '*$1*')
    .replace(/<a href="([^"]+)">([^<]*)<\/a>/g, '$2: $1')
    .replace(/<[^>]+>/g, '');
}

/**
 * Susun pesan reminder.
 * channel: 'tg' (HTML + link) | 'wa' (teks polos, URL mentah)
 */
function buildMessage(items, tanggal, channel = 'tg') {
  const head = [
    `⏰ <b>REMINDER 1 JAM — ${esc(TARGET_LABEL)}</b>`,
    `📅 ${tanggalIndoLengkap(tanggal)}`,
  ].join('\n');

  const body = items.map(({ row, menit }, i) => {
    const p = [];
    const judul = esc(row.acara || '(tanpa nama acara)');
    p.push(`\n${items.length > 1 ? `${i + 1}.` : '📌'} <b>${judul}</b>`);
    p.push(`🕐 <b>${esc(row.pukulAwal)}</b>${row.pukulAkhir ? '–' + esc(row.pukulAkhir) : ''} WIB · mulai ±${menit} menit lagi`);
    if (row.tempat) p.push(`📍 ${esc(row.tempat)}`);
    if (row.pengirim) p.push(`🏢 Pengirim: ${esc(row.pengirim)}`);
    if (row.tujuanUnit || row.tujuanUser) {
      p.push(`👤 Tujuan: ${esc(row.tujuanUnit || '-')}${row.tujuanUser ? ` (${esc(row.tujuanUser)})` : ''}`);
    }
    if (row.penerima.length) {
      p.push(`👥 Penerima (${row.penerima.length}): ${esc(row.penerima.map((x) => x.nama || x.nip).join('; '))}`);
    }
    if (row.isiDisposisi) p.push(`📝 Disposisi: ${esc(row.isiDisposisi)}`);
    if (row.suratPdf) {
      p.push(channel === 'tg' ? `📄 <a href="${esc(row.suratPdf)}">Lihat surat</a>` : `📄 Surat: ${row.suratPdf}`);
    }
    return p.join('\n');
  }).join('\n');

  const msg = head + body;
  return channel === 'tg' ? msg : toWaText(msg);
}

// ===================== PENGIRIMAN =====================

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch { return { sent: {} }; }
}
function writeState(st) { fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2)); }

async function tgSend(text) {
  if (!TG_TOKEN || !TG_CHAT) { log('⚠️  TELEGRAM_BOT_TOKEN / chat id belum diatur — TG dilewati.'); return false; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) { log('⚠️  Kirim TG gagal:', res.status, (await res.text()).slice(0, 200)); return false; }
    return true;
  } catch (e) { log('⚠️  Kirim TG error:', e.message); return false; }
}

async function waSend(text, to) {
  try {
    const res = await fetch(WA_BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: WA_BRIDGE_TOKEN, text, to }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) { log(`⚠️  Kirim WA ke ${to} gagal:`, res.status, JSON.stringify(data).slice(0, 150)); return false; }
    return true;
  } catch (e) { log(`⚠️  Kirim WA ke ${to} error:`, e.message, '(bot bkpsdm-wa hidup? bridge di proses itu)'); return false; }
}

// ===================== EKSEKUSI =====================

async function run() {
  const nowMs = NOW_ARG ? wibToMs(NOW_ARG.split(' ')[0], NOW_ARG.split(' ')[1] || '00:00') : Date.now();
  const tanggal = msToWibDate(nowMs);
  const targets = NO_WA ? [] : waTargets();
  log(`▶ Cek reminder | unit="${TARGET_LABEL}"${UNIT_LIST ? ` (${UNIT_LIST.length} unit)` : ''} | window=${WINDOW_MIN}m | tanggal=${tanggal}`);
  log(`   channel: ${NO_TG ? '' : 'TG '}${NO_WA ? '' : `WA(${targets.map((t) => t[0]).join(',') || '-'})`}${DRY ? ' | MODE DRY-RUN' : ''}`);

  await login();
  const resp = await getAgenda(tanggal);
  const rows = (resp.data || []).map(normalizeRow);
  log(`   ${rows.length} entri agenda hari ini`);

  const matching = rows.filter((r) => cocokUnit(r.tujuanUnit, UNIT_LIST));
  log(`   ${matching.length} entri dengan tujuan unit "${TARGET_LABEL}"`);

  const state = readState();
  const due = [];
  for (const row of matching) {
    if (!row.pukulAwal || !/^\d{1,2}:\d{2}$/.test(row.pukulAwal)) { log(`   ⏭  lewat (tanpa jam): ${row.acara}`); continue; }
    const diffMin = Math.round((wibToMs(row.tanggal || tanggal, row.pukulAwal) - nowMs) / 60000);
    const key = `${row.idDetail}|${row.tanggal}|${row.pukulAwal}`;
    if (diffMin <= 0) { log(`   ⏭  sudah mulai (${diffMin} menit): ${row.acara}`); continue; }
    if (diffMin > WINDOW_MIN) { log(`   ⏳ ${diffMin} menit lagi (> ${WINDOW_MIN}) — belum waktunya: ${row.acara}`); continue; }
    if (state.sent[key] && !FORCE) { log(`   ✔ sudah diingatkan: ${row.acara}`); continue; }
    due.push({ row, menit: diffMin, key });
  }

  if (due.length === 0) { log('   Tidak ada reminder yang perlu dikirim.'); return 0; }

  const tgMsg = buildMessage(due, tanggal, 'tg');
  const waMsg = buildMessage(due, tanggal, 'wa');
  if (DRY) {
    console.log('\n----- PREVIEW TELEGRAM -----\n' + tgMsg.replace(/<[^>]+>/g, ''));
    console.log('\n----- PREVIEW WHATSAPP -----\n' + waMsg);
    log('   MODE DRY-RUN — tidak ada yang dikirim & state tidak diubah.');
    return due.length;
  }

  let tgOk = false, waOkCount = 0;
  if (!NO_TG) tgOk = await tgSend(tgMsg);
  if (tgOk) log('   ✅ TG terkirim');

  if (!NO_WA) {
    for (const [tag, num] of targets) {
      const ok = await waSend(waMsg, num);
      if (ok) { waOkCount++; log(`   ✅ WA terkirim ke ${tag} (${num})`); }
      await new Promise((r) => setTimeout(r, 1200)); // jeda sopan antar kirim
    }
  }

  if (tgOk || waOkCount > 0) {
    due.forEach(({ key }) => { state.sent[key] = new Date().toISOString(); });
    const batas = msToWibDate(nowMs - 2 * 24 * 3600 * 1000);
    for (const k of Object.keys(state.sent)) {
      const tglK = k.split('|')[1];
      if (tglK && tglK < batas) delete state.sent[k];
    }
    writeState(state);
    log(`   ✅ ${due.length} reminder tercatat (TG:${tgOk ? 'ok' : '-'} WA:${waOkCount}/${targets.length}).`);
  } else {
    log('   ❌ Semua channel gagal — state tidak ditandai, akan dicoba lagi tick berikutnya.');
  }
  return due.length;
}

module.exports = { run, buildMessage, toWaText, waContacts, wibToMs, msToWibDate, tanggalIndo, tanggalIndoLengkap };

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((e) => { console.error(`❌ Error: ${e.message}`); process.exit(1); });
}
