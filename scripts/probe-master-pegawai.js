/**
 * Probe: endpoint master-pegawai (daftar SEMUA pegawai) — pembanding endpoint absensi.
 */
require('dotenv').config({ path: '/home/ubuntu/bkpsdm-agent-telegram/.env' });

const BASE = process.env.API_BASE_URL || 'https://bkpsdm.surabaya.go.id/api/ai-agent';

async function login() {
  const res = await fetch(`${BASE}/auth/login.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.API_USERNAME, password: process.env.API_PASSWORD }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await res.json();
  if (!j.token) throw new Error('login gagal ' + res.status);
  return j.token;
}

(async () => {
  const token = await login();
  const res = await fetch(`${BASE}/master-pegawai/all.php?limit=1000`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  const j = JSON.parse(text);
  console.log('HTTP', res.status, '| bytes', text.length);
  console.log('keys:', Object.keys(j));
  const arr = j.data || j.rows || j.pegawai || (Array.isArray(j) ? j : null);
  if (!arr) { console.log('struktur tak terduga:', text.slice(0, 400)); return; }
  console.log('TOTAL baris master:', arr.length);
  console.log('contoh field:', Object.keys(arr[0]).join(', '));
  console.log('contoh 2 baris:');
  arr.slice(0, 2).forEach((r) => console.log('  ', JSON.stringify(r)));
  const byKet = {};
  arr.forEach((r) => { const k = r.KET ?? r.ket ?? r.keterangan ?? '-'; byKet[k] = (byKet[k] || 0) + 1; });
  console.log('distribusi KET:', JSON.stringify(byKet));
  const byStatus = {};
  arr.forEach((r) => { const k = r.STATUS ?? r.status ?? '-'; byStatus[k] = (byStatus[k] || 0) + 1; });
  console.log('distribusi STATUS:', JSON.stringify(byStatus).slice(0, 400));
  require('fs').writeFileSync('/tmp/master-pegawai-raw.json', JSON.stringify(j, null, 2));
  console.log('dump: /tmp/master-pegawai-raw.json', require('fs').statSync('/tmp/master-pegawai-raw.json').size, 'B');
})();
