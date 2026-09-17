/**
 * pdf-undangan-raw.js — Cetak DATA MENTAH respons API eSurat ke PDF.
 *
 * Berbeda dari pdf-undangan.js (yang mengelompokkan & merapikan), PDF ini
 * sengaja menampilkan APA ADANYA apa yang dikirim server:
 *   - envelope respons: { success, message, jumlah }
 *   - struktur JSON 1 entri (persis, termasuk null)
 *   - SEMUA entri dengan SELURUH field + nilai mentah (HTML tidak dibersihkan)
 *
 * Field diambil dengan Object.entries(raw), jadi kalau API menambah field baru,
 * otomatis ikut tampil tanpa perlu ubah kode.
 *
 * CLI:
 *   node pdf-undangan-raw.js 2026-09-07
 *   node pdf-undangan-raw.js 2026-09-07 --json
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const config = require('./config');
const { getAgenda } = require('./index');
const { tanggalIndoLengkap } = require('./reminder');
const { resolveUnitList, cocokUnit, labelUnit } = require('./units');

const M = 40;
const FONT = 'Helvetica';
const FONT_B = 'Helvetica-Bold';
const MONO = 'Courier';
const MONO_B = 'Courier-Bold';
const GRAY = '#555555';
const LINE = '#cccccc';
const ACCENT = '#0b5394';

function tglIndo(t) {
  try { return tanggalIndoLengkap(t).replace(/^[^,]+,\s*/, ''); } catch (_) { return t; }
}
function hariIndo(t) {
  try { return tanggalIndoLengkap(t).split(',')[0]; } catch (_) { return ''; }
}

/** Nilai field → string mentah (null/undefined ditulis eksplisit). */
function rawValue(v) {
  if (v === null) return 'null';
  if (v === undefined) return '(tidak ada)';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Baris "field : nilai" — label monospace, nilai membungkus, posisi absolut. */
function fieldLine(doc, key, value, x, width, size = 7.5, valueColor = '#000000') {
  const lw = doc.font(MONO_B).fontSize(size).widthOfString(key + ' : ');
  const y = doc.y;
  doc.font(MONO_B).fontSize(size).fillColor('#000000').text(key + ' : ', x, y, { width: lw + 1, lineBreak: false });
  const warna = value === 'null' ? '#999999' : valueColor;
  doc.font(MONO).fontSize(size).fillColor(warna).text(value, x + lw, y, { width: Math.max(60, width - lw) });
}

function generateRawPdf(resp, tanggal, { unit = null } = {}) {
  const outPath = path.join('/tmp', `esurat-raw-${tanggal}-${Date.now()}.pdf`);
  const data = resp.data || [];
  const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true,
    info: { Title: `Data raw API eSurat ${tanggal}`, Author: 'BKPSDM Agent' } });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  const W = doc.page.width - 2 * M;
  const BOTTOM = doc.page.height - 58;

  // ─── Kop ───
  doc.font(FONT_B).fontSize(14).fillColor('#000000').text('DATA MENTAH API eSURAT', { align: 'center' });
  doc.moveDown(0.15);
  doc.font(FONT).fontSize(10.5).text(`${hariIndo(tanggal)}, ${tglIndo(tanggal)}`, { align: 'center' });
  doc.moveDown(0.15);
  doc.font(MONO).fontSize(7.5).fillColor(GRAY)
    .text(`GET ${config.agendaUrl}?tanggal=${tanggal}   ·   Authorization: Bearer <token>`, { align: 'center' });
  doc.font(MONO).fontSize(7.5).fillColor(GRAY)
    .text(`filter: ${unit || 'tanpa filter (semua entri)'}`, { align: 'center' });
  doc.moveDown(0.35);
  doc.moveTo(M, doc.y).lineTo(M + W, doc.y).strokeColor(LINE).stroke();
  doc.moveDown(0.4);

  // ─── Envelope ───
  doc.font(FONT_B).fontSize(10).fillColor('#000000').text('A. ENVELOPE RESPONS (apa yang server balas)', M, doc.y, { width: W });
  doc.moveDown(0.15);
  fieldLine(doc, 'success', rawValue(resp.success), M + 10, W - 10, 8);
  fieldLine(doc, 'message', rawValue(resp.message), M + 10, W - 10, 8);
  fieldLine(doc, 'jumlah data[]', String(data.length), M + 10, W - 10, 8);
  fieldLine(doc, 'status HTTP', resp.success === false ? '404 (Data tidak ditemukan)' : '200', M + 10, W - 10, 8);
  doc.moveDown(0.4);

  if (data.length === 0) {
    doc.font(FONT).fontSize(9.5).fillColor('#000000')
      .text('Server tidak mengirim data untuk tanggal ini (message di atas adalah isi responsnya).', M, doc.y, { width: W });
  }

  // ─── Struktur 1 entri (JSON persis) ───
  if (data.length > 0) {
    doc.font(FONT_B).fontSize(10).fillColor('#000000').text('B. STRUKTUR 1 ENTRI — JSON persis dari server (data[0])', M, doc.y, { width: W });
    doc.moveDown(0.15);
    doc.font(MONO).fontSize(6.8).fillColor('#000000')
      .text(JSON.stringify(data[0], null, 2), M + 6, doc.y, { width: W - 12 });
    doc.moveDown(0.4);
  }

  // ─── Semua entri, semua field ───
  if (data.length > 0) {
    if (doc.y > BOTTOM - 60) doc.addPage();
    doc.font(FONT_B).fontSize(10).fillColor('#000000')
      .text(`C. SELURUH ENTRI — semua field apa adanya (${data.length} entri)`, M, doc.y, { width: W });
    doc.moveDown(0.2);

    data.forEach((r, i) => {
      if (doc.y > BOTTOM - 70) doc.addPage();
      doc.font(FONT_B).fontSize(9).fillColor(ACCENT).text(`ENTRI ${i + 1}`, M, doc.y, { width: W });
      doc.moveDown(0.12);
      for (const [k, v] of Object.entries(r)) {
        if (doc.y > BOTTOM - 30) doc.addPage();
        fieldLine(doc, k, rawValue(v), M + 10, W - 10);
      }
      doc.moveDown(0.15);
      doc.moveTo(M, doc.y).lineTo(M + W, doc.y).strokeColor(LINE).stroke();
      doc.moveDown(0.35);
    });
  }

  // ─── Footer ───
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let p = range.start; p < range.start + total; p++) {
    doc.switchToPage(p);
    const simpan = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - 32;
    doc.font(FONT).fontSize(7).fillColor(GRAY);
    doc.text(`Dicetak: ${new Date().toLocaleString('id-ID')} · sumber: kantorku.surabaya.go.id`, M, fy, { width: W * 0.7, lineBreak: false });
    doc.text(`Halaman ${p + 1} dari ${total}`, M + W * 0.7, fy, { width: W * 0.3, align: 'right', lineBreak: false });
    doc.page.margins.bottom = simpan;
  }

  doc.end();
  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(outPath));
    stream.on('error', reject);
  });
}

module.exports = { generateRawPdf };

if (require.main === module) {
  const args = process.argv.slice(2);
  const pos = args.filter((a) => !a.startsWith('--'));
  const iUnit = args.indexOf('--unit');
  const unitInput = iUnit >= 0 && args[iUnit + 1] ? args[iUnit + 1] : null;
  const unitList = resolveUnitList(unitInput); // null = tanpa filter
  const label = unitList ? `unit tujuan: ${labelUnit(unitList)}` : 'tanpa filter (semua entri)';
  const tanggal = (pos[0] && /^\d{4}-\d{2}-\d{2}$/.test(pos[0])) ? pos[0]
    : new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  (async () => {
    const resp = await getAgenda(tanggal);
    if (unitList) resp.data = (resp.data || []).filter((r) => cocokUnit(r.tujuan_unit, unitList));
    const p = await generateRawPdf(resp, tanggal, { unit: label });
    if (args.includes('--json')) {
      const data = resp.data || [];
      const keys = data.length ? Object.keys(data[0]) : [];
      console.log(JSON.stringify({ path: p, tanggal, unit: label, jumlah: data.length, ukuran: fs.statSync(p).size, field: keys }));
    } else {
      console.log(`OK ${p}`);
      console.log(`   ${(resp.data || []).length} entri · ${label} · ${(fs.statSync(p).size / 1024).toFixed(1)} KB`);
    }
    process.exit(0);
  })().catch((e) => { console.error('Error: ' + e.message); process.exit(1); });
}
