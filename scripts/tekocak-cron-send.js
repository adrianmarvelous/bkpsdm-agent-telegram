#!/usr/bin/env node
/**
 * TEKO-CAK cron self-send — jalanin task via runTask(), kirim RINGKASAN via bot Telegram.
 *
 * Dipanggil dari ~/.hermes/scripts/tekocak-pagi.sh / tekocak-sore.sh (setsid nohup background,
 * karena cron no_agent membunuh script di ~120s sedangkan task TEKO-CAK butuh 5-10 menit).
 *
 * Mode:
 *   node scripts/tekocak-cron-send.js pagi   → runTask('all') + ringkasan
 *   node scripts/tekocak-cron-send.js sore   → runTask('all') + cek absensi; anomali non-DR > 5 → ulangi sekali + ringkasan absensi
 *   node scripts/tekocak-cron-send.js test   → kirim pesan tes (verifikasi jalur kirim)
 *
 * Cron job: no_agent=true + deliver=local → script INI yang kirim ke Telegram (hindari double-send).
 * Keluar dengan stdout kosong (tidak ada delivery dari Hermes).
 */
const path = require('path');
const fs = require('fs');
const PROJECT_DIR = path.resolve(__dirname, '..');
process.chdir(PROJECT_DIR);
require('dotenv').config();

const MODE = process.argv[2] || 'pagi';
const tekocak = require(path.join(PROJECT_DIR, 'src', 'services', 'tekocak'));
const api = require(path.join(PROJECT_DIR, 'src', 'services', 'apiClient'));

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = String(process.env.ALLOWED_CHAT_IDS || '').split(',')[0].trim() || process.env.PENGADUAN_CHAT_ID || '1413990594';

// ─── Kirim via bot ────────────────────────────────────────────────────
async function tgSend(text) {
  if (!TOKEN) {
    console.error('NO TELEGRAM_BOT_TOKEN — tidak bisa kirim');
    return false;
  }
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const body = new URLSearchParams({ chat_id: CHAT_ID, text, parse_mode: 'Markdown' });
  try {
    const res = await fetch(url, { method: 'POST', body });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) console.error('TG send error:', JSON.stringify(j));
    return !!j.ok;
  } catch (e) {
    console.error('TG send error:', e.message);
    return false;
  }
}

// Escape karakter markdown Telegram (utk teks bebas, mis. pesan error)
function escMd(s) {
  return String(s).replace(/[*_`[\]\\]/g, (c) => '\\' + c);
}

// ─── Parse output runTask ─────────────────────────────────────────────
function extractStats(output) {
  const prog = [...String(output).matchAll(/(\d+)\/(\d+) \(\d+%\)/g)];
  const genCount = prog.length ? prog[prog.length - 1][1] : null;
  const genTotal = prog.length ? prog[prog.length - 1][2] : null;
  const genDone = /Generate laporan (selesai|tanggal spesifik selesai)/.test(String(output));
  const upM = String(output).match(/Update (\d+) Pegawai/);
  const upCount = upM ? upM[1] : null;
  const upDone = /Update pegawai selesai/.test(String(output));
  const failM = String(output).match(/⚠️ \*\*(\d+) pegawai tetap gagal/);
  const upFail = failM ? Number(failM[1]) : 0;
  const durs = [...String(output).matchAll(/Selesai dalam ([^\n*]+)/g)];
  const dur = durs.length ? durs[durs.length - 1][1].trim() : null;
  return { genCount, genTotal, genDone, upCount, upDone, upFail, dur };
}

// ─── Absensi (untuk mode sore) ────────────────────────────────────────
async function fetchAbsensi() {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return await api.getAbsensiHariIni();
    } catch (e) {
      lastErr = e;
      if (i < 2) await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw lastErr;
}

function absensiSummary(data) {
  const anomali = data.anomali || [];
  const ring = data.ringkasan || {};
  // H/DR/DL/I dianggap normal (Hadir) — tidak dihitung anomali
  const normalKeterangan = anomali.filter((a) => ['DR', 'DL', 'I', 'H'].includes(String(a.keterangan || '').toUpperCase())).length;
  const rawAnomali = ring.anomali != null ? ring.anomali : anomali.length;
  const anomaliNonDr = Math.max(0, rawAnomali - normalKeterangan);
  const total = ring.total_pegawai || anomali.length;
  const hadir = Math.max(0, total - anomaliNonDr);
  const rm = ring.rincian_masalah || {};
  const mangkir = rm.mangkir || 0;
  const tanpaJam = Math.max(0, (rm.tanpa_jam || 0) - normalKeterangan);
  return { tanggal: data.tanggal || '-', total, hadir, anomaliNonDr, mangkir, tanpaJam };
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  let text;
  try {
    if (MODE === 'test') {
      text = '✅ **TES TEKO-CAK self-send** — jalur kirim OK.';
    } else if (MODE === 'sore') {
      const r1 = await tekocak.runTask('all');
      let abs = await fetchAbsensi();
      let a = absensiSummary(abs);
      let reran = false;
      if (a.anomaliNonDr > 5) {
        await tekocak.runTask('all'); // ulangi sekali (sesuai prompt Sore lama)
        abs = await fetchAbsensi();
        a = absensiSummary(abs);
        reran = true;
      }
      const st = extractStats(r1.output);
      const garis = '━━━━━━━━━━━━━━━━━━━━';
      text = [
        '**TEKO-CAK Sore — Selesai** ✅',
        '',
        `📅 ${a.tanggal}`,
        `👥 Total ${a.total} pegawai | ✅ Hadir ${a.hadir} | ⚠️ Anomali ${a.anomaliNonDr}`,
        `📌 Mangkir ${a.mangkir} · Tanpa jam ${a.tanpaJam}`,
        '',
        garis,
        `🔄 Generate: ${st.genDone ? `${st.genCount || '?'}/${st.genTotal || '?'} pegawai` : 'GAGAL'}`,
        `👤 Update: ${st.upFail > 0 ? `⚠️ ${st.upFail} gagal` : `${st.upCount || '?'} pegawai OK`}${reran ? ' (diulang, anomali > 5)' : ''}`,
        `⏱️ ${st.dur || '?'}`,
      ].join('\n');
    } else {
      // pagi (default)
      const r = await tekocak.runTask('all');
      const st = extractStats(r.output);
      const status =
        st.genDone && st.upDone && st.upFail === 0
          ? '✅ Semua selesai'
          : st.upFail > 0
            ? `⚠️ ${st.upFail} pegawai gagal`
            : '❌ Gagal';
      text = [
        '**TEKO-CAK Pagi — Selesai** ✅',
        '',
        `**Generate:** ${st.genDone ? `${st.genCount || '?'}/${st.genTotal || '?'} pegawai` : 'GAGAL'}`,
        `**Update:** ${st.upCount || '?'} pegawai ${st.upFail > 0 ? `— ⚠️ ${st.upFail} gagal` : 'berhasil'}`,
        `**Durasi:** ${st.dur || '?'}`,
        `**Status:** ${status}`,
      ].join('\n');
    }
    await tgSend(text);
  } catch (e) {
    const label = MODE === 'sore' ? 'Sore' : MODE === 'test' ? 'Test' : 'Pagi';
    await tgSend(`❌ **TEKO-CAK ${label} GAGAL**\n\n${escMd(e.message || String(e)).slice(0, 800)}`);
  } finally {
    try {
      fs.writeFileSync(`/tmp/tekocak-${MODE}-last.txt`, new Date().toISOString());
    } catch {}
  }
  process.exit(0);
}

main();
