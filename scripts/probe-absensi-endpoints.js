/**
 * Probe: apakah endpoint absensi hanya balikin anomali, atau ada endpoint lain
 * yang mengembalikan SEMUA pegawai?
 */
require('dotenv').config({ path: '/home/ubuntu/bkpsdm-agent-telegram/.env' });

const BASE = process.env.API_BASE_URL || 'https://bkpsdm.surabaya.go.id/api/ai-agent';
const U = process.env.API_USERNAME;
const P = process.env.API_PASSWORD;
const TGL = process.argv[2] || '2026-09-09';

async function login() {
  const res = await fetch(`${BASE}/auth/login.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: U, password: P }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await res.json();
  if (!j.token) throw new Error('login gagal: HTTP ' + res.status + ' ' + JSON.stringify(j).slice(0, 200));
  return j.token;
}

(async () => {
  const token = await login();
  console.log('login OK, token len', token.length, '\n');

  const paths = [
    `/absensi/hari-ini.php?tanggal=${TGL}`,
    `/absensi/hari-ini.php?tanggal=${TGL}&all=1`,
    `/absensi/hari-ini.php?tanggal=${TGL}&lengkap=1`,
    `/absensi/hari-ini.php?tanggal=${TGL}&mode=all`,
    `/absensi/hari-ini.php?tanggal=${TGL}&include_hadir=1`,
    `/absensi/detail.php?tanggal=${TGL}`,
    `/absensi/pegawai.php?tanggal=${TGL}`,
    `/absensi/semua.php?tanggal=${TGL}`,
    `/absensi/rekap.php?tanggal=${TGL}`,
    `/absensi/index.php?tanggal=${TGL}`,
    `/absensi/raw.php?tanggal=${TGL}`,
  ];

  for (const p of paths) {
    try {
      const res = await fetch(`${BASE}${p}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60000),
      });
      const text = await res.text();
      let info = `HTTP ${res.status} | ${text.length} B`;
      try {
        const j = JSON.parse(text);
        if (j && typeof j === 'object') {
          info += ` | keys=[${Object.keys(j).join(',')}]`;
          for (const [k, v] of Object.entries(j)) {
            if (Array.isArray(v)) info += ` ${k}:${v.length}baris`;
          }
          if (j.tanggal) info += ` | tanggal=${j.tanggal}`;
          if (j.ringkasan) info += ` | ringkasan=${JSON.stringify(j.ringkasan)}`;
        }
      } catch { info += ` | bukan JSON: ${text.replace(/\s+/g, ' ').slice(0, 90)}`; }
      console.log(p.padEnd(52), '→', info);
    } catch (e) {
      console.log(p.padEnd(52), '→ ERROR', e.message);
    }
  }
})();
