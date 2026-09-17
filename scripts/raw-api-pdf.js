/**
 * RAW API → PDF  (audit)
 *
 * Ambil respons MENTAH dari API BKPSDM untuk sebuah perintah, lalu cetak ke PDF:
 *   1) Endpoint + waktu ambil (reproducibility)
 *   2) JSON mentah verbatim (apa adanya, tanpa filter)
 *   3) Tabel field mentah per baris (tanpa filter/business rule)
 *
 * Usage:
 *   node raw-api-pdf.js absensi 2026-09-09
 *   node raw-api-pdf.js jadwal  2026-09-09
 *   node raw-api-pdf.js tugas   2026-09-09
 *   node raw-api-pdf.js bbm     2026-09-09
 *   node raw-api-pdf.js tupoksi 2026-09-09
 *
 * Output: /tmp/<jenis>-raw-<tanggal>.pdf  dan dump JSON di /tmp/<jenis>-raw-<tanggal>.json
 */
require('dotenv').config({ path: '/home/ubuntu/bkpsdm-agent-telegram/.env' });
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const api = require('/home/ubuntu/bkpsdm-agent-telegram/src/services/apiClient');

const BASE = process.env.API_BASE_URL || 'https://bkpsdm.surabaya.go.id/api/ai-agent';

const ENDPOINTS = {
  absensi: (t) => `/absensi/hari-ini.php${t ? `?tanggal=${t}` : ''}`,
  jadwal: (t) => (t ? `/jadwal/tanggal.php?tanggal=${t}` : '/jadwal/hari-ini.php'),
  tugas: (t) => (t ? `/tugas/tanggal.php?tanggal=${t}` : '/tugas/hari-ini.php'),
  tupoksi: (t) => (t ? `/tupoksi/tanggal.php?tanggal=${t}` : '/tupoksi/hari-ini.php'),
  bbm: (t) => (t ? `/bbm-non-fosil/tanggal.php?tanggal=${t}` : '/bbm-non-fosil/hari-ini.php'),
};

const FETCHERS = {
  absensi: (t) => (t ? api.getAbsensiByTanggal(t) : api.getAbsensiHariIni()),
  jadwal: (t) => (t ? api.getJadwalByTanggal(t) : api.getJadwalHariIni()),
  tugas: (t) => (t ? api.getTugasByTanggal(t) : api.getTugasHariIni()),
  tupoksi: (t) => (t ? api.getTupoksiByTanggal(t) : api.getTupoksiHariIni()),
  bbm: (t) => (t ? api.getBbmNonFosilByTanggal(t) : api.getBbmNonFosilHariIni()),
};

// ── Helpers ──
function tglIndo(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '-';
  const BLN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli',
    'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${BLN[Number(m) - 1]} ${y}`;
}

/** Cari array baris pertama di dalam objek respons (mis. anomali / data / hadir) */
function findRowArrays(obj) {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null) {
      out.push({ key: k, rows: v });
    }
  }
  return out;
}

// ── Layout PDF ──
const M = 40;              // margin
const LEFT = M;
const RIGHT = 595 - M;     // A4 width 595
const BOTTOM = 800;
const LINE = 9;

function scalars(obj) {
  return Object.entries(obj).filter(([, v]) => v === null || typeof v !== 'object');
}

function buildPdf(jenis, tanggal, url, raw, json) {
  const outPath = `/tmp/${jenis}-raw-${tanggal || 'hari-ini'}.pdf`;
  const doc = new PDFDocument({ size: 'A4', margin: M, autoFirstPage: true });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  const fetchedAt = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  // ── Kop ──
  doc.font('Helvetica-Bold').fontSize(13).fillColor('black')
    .text(`RAW API RESPONSE — ${jenis.toUpperCase()}`);
  doc.font('Helvetica').fontSize(9);
  doc.text(`BKPSDM Surabaya · tanggal data: ${tglIndo(tanggal)}`);
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(7.5).fillColor('#333333');
  doc.text(`Endpoint : GET ${BASE}${url}`);
  doc.text(`Diambil  : ${fetchedAt} WIB`);
  doc.text(`Perintah : "${jenis}${tanggal ? ' ' + tglIndo(tanggal) : ''}"`);
  doc.moveDown(0.4);
  doc.moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).stroke('#999999');
  doc.moveDown(0.5);
  doc.fillColor('black');

  // ── 1. JSON mentah verbatim ──
  doc.font('Helvetica-Bold').fontSize(10).text('1. JSON Mentah (verbatim, tanpa filter)');
  doc.moveDown(0.2);
  doc.font('Courier').fontSize(6.2).fillColor('#111111');
  doc.text(JSON.stringify(raw, null, 2), LEFT, doc.y, {
    width: RIGHT - LEFT,
    lineGap: 1.2,
  });
  doc.moveDown(0.6);

  // ── 2. Tabel field mentah ──
  let sectionNo = 2;
  for (const grp of findRowArrays(raw)) {
    const rows = grp.rows;
    const fields = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    if (doc.y + 60 > BOTTOM) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(10).fillColor('black')
      .text(`${sectionNo}. Tabel Field Mentah — data.${grp.key} (${rows.length} baris)`);
    doc.moveDown(0.25);
    sectionNo++;

    // lebar kolom proporsional terhadap panjang nilai maksimum
    const widths = fields.map((f) => {
      const maxLen = Math.max(f.length, ...rows.slice(0, 80).map((r) => String(r[f] ?? '').length));
      return { field: f, maxLen };
    });
    const totalLen = widths.reduce((a, w) => a + w.maxLen + 2, 0);
    const avail = RIGHT - LEFT;
    let x = LEFT;
    const cols = widths.map((w) => {
      const cw = Math.max(26, Math.floor(((w.maxLen + 2) / totalLen) * avail));
      const col = { field: w.field, x, w: cw };
      x += cw;
      return col;
    });
    // rapikan agar pas kanan
    const last = cols[cols.length - 1];
    last.w = RIGHT - last.x;

    const drawHead = () => {
      const y = doc.y;
      doc.rect(LEFT, y, RIGHT - LEFT, 14).fill('#eeeeee').fillColor('black');
      cols.forEach((c) => {
        doc.rect(c.x, y, c.w, 14).stroke('#888888');
        doc.font('Helvetica-Bold').fontSize(6).fillColor('black')
          .text(c.field, c.x + 2, y + 4, { width: c.w - 3, lineBreak: false, ellipsis: true });
      });
      doc.y = y + 14;
    };
    drawHead();

    rows.forEach((r, i) => {
      const y = doc.y;
      const h = 12;
      if (y + h > BOTTOM) { doc.addPage(); drawHead(); }
      const yy = doc.y;
      doc.rect(LEFT, yy, RIGHT - LEFT, h).stroke('#bbbbbb');
      cols.forEach((c) => {
        doc.rect(c.x, yy, c.w, h).stroke('#bbbbbb');
        const val = r[c.field];
        doc.font('Courier').fontSize(5.8).fillColor('black')
          .text(val === null || val === undefined ? 'null' : String(val), c.x + 2, yy + 3, {
            width: c.w - 3, lineBreak: false, ellipsis: true,
          });
      });
      doc.y = yy + h;
    });
    doc.moveDown(0.6);
  }

  // ── 3. Field skalar respons ──
  const sc = scalars(raw);
  if (sc.length) {
    if (doc.y + 40 > BOTTOM) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(10).fillColor('black')
      .text(`${sectionNo}. Field Skalar Respons`);
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(7.5);
    sc.forEach(([k, v]) => doc.text(`${k} = ${JSON.stringify(v)}`));
    doc.moveDown(0.4);
  }

  // ── Footer ──
  doc.fontSize(7).fillColor('#666666')
    .text(`Dicetak: ${fetchedAt} WIB · sumber: API ${jenis} BKPSDM (raw, tanpa business rule)`, LEFT, doc.y, {
      width: RIGHT - LEFT, align: 'center',
    });
  doc.end();

  return new Promise((res, rej) => {
    stream.on('finish', () => res(outPath));
    stream.on('error', rej);
  });
}

(async () => {
  const jenis = (process.argv[2] || 'absensi').toLowerCase();
  let tanggal = process.argv[3] || null;

  // normalisasi tanggal Indonesia: "9 september" / "09-09-2026" / "2026-09-09"
  if (tanggal) {
    const BLN = { januari: 1, februari: 2, maret: 3, april: 4, mei: 5, juni: 6, juli: 7, agustus: 8, september: 9, oktober: 10, november: 11, desember: 12 };
    let m;
    if ((m = tanggal.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/))) {
      tanggal = `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    } else if ((m = tanggal.match(/^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/i))) {
      const bln = BLN[m[2].toLowerCase()];
      const tahun = m[3] || String(new Date().getFullYear());
      tanggal = `${tahun}-${String(bln).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    }
  }

  if (!ENDPOINTS[jenis]) {
    console.error(`jenis tidak dikenal: ${jenis}. Pilihan: ${Object.keys(ENDPOINTS).join(', ')}`);
    process.exit(1);
  }

  const url = ENDPOINTS[jenis](tanggal);
  const raw = await FETCHERS[jenis](tanggal);

  const jsonPath = `/tmp/${jenis}-raw-${tanggal || 'hari-ini'}.json`;
  fs.writeFileSync(jsonPath, JSON.stringify(raw, null, 2));

  const pdfPath = await buildPdf(jenis, tanggal, url, raw, null);
  const size = fs.statSync(pdfPath).size;
  console.log('JSON :', jsonPath, `(${fs.statSync(jsonPath).size} B)`);
  console.log('PDF  :', pdfPath, `(${size} B)`);
})();
