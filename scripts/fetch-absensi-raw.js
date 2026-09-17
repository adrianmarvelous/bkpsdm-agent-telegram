/**
 * Dump RAW API absensi untuk tanggal tertentu (audit).
 * Usage: node fetch-absensi-raw.js 2026-09-09
 */
require('dotenv').config({ path: '/home/ubuntu/bkpsdm-agent-telegram/.env' });
const fs = require('fs');
const api = require('/home/ubuntu/bkpsdm-agent-telegram/src/services/apiClient');

(async () => {
  const tgl = process.argv[2] || '2026-09-09';
  const out = `/tmp/absensi-raw-${tgl}.json`;
  try {
    const data = await api.getAbsensiByTanggal(tgl);
    fs.writeFileSync(out, JSON.stringify(data, null, 2));
    console.log('SAVED:', out);
    console.log('keys:', Object.keys(data));
    console.log('tanggal:', data.tanggal, '| success:', data.success);
    console.log('ringkasan:', JSON.stringify(data.ringkasan));
    console.log('anomali_count:', (data.anomali || []).length);
    if (data.anomali && data.anomali[0]) console.log('sample_anomali:', JSON.stringify(data.anomali[0]));
    if (data.hadir && data.hadir[0]) console.log('sample_hadir:', JSON.stringify(data.hadir[0]));
    console.log('bytes:', fs.statSync(out).size);
  } catch (e) {
    console.log('ERROR:', e.message);
    process.exit(1);
  }
})();
