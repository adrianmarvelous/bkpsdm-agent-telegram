/**
 * PDF Generator — Generate PDF dari data absensi (format baru: anomali)
 *
 * Menggunakan pdfkit (lightweight, pure JS, no native dependencies)
 * Tabel dengan border-collapse style
 */
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// Kolom tabel: [posX, width]
const COLUMNS = [
  { x: 50, w: 30 },   // No
  { x: 80, w: 105 },  // NIP
  { x: 185, w: 200 }, // Nama
  { x: 385, w: 50 },  // Masuk
  { x: 435, w: 50 },  // Pulang
  { x: 485, w: 60 },  // Status
];
const TABLE_LEFT = 50;
const TABLE_RIGHT = 545;
const PAGE_BOTTOM = 760;
const ROW_H = 18;
const HEADER_H = 20;
const FONT_SIZE = 7;
const HEADER_FONT_SIZE = 7.5;

function drawRowBorder(doc, y, h) {
  for (const col of COLUMNS) {
    doc.rect(col.x, y, col.w, h).stroke();
  }
}

function writeCell(doc, colIdx, text, y, h, opts = {}) {
  const col = COLUMNS[colIdx];
  const fontSize = opts.bold ? HEADER_FONT_SIZE : FONT_SIZE;
  doc.fontSize(fontSize).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica');
  doc.text(String(text), col.x + 2, y + 3, {
    width: col.w - 4,
    lineBreak: false,
    ellipsis: true,
  });
}

function drawHeader(doc) {
  const y = doc.y;
  doc.rect(TABLE_LEFT, y, TABLE_RIGHT - TABLE_LEFT, HEADER_H).fill('#eeeeee');
  doc.fillColor('black');
  drawRowBorder(doc, y, HEADER_H);
  writeCell(doc, 0, '#', y, HEADER_H, { bold: true });
  writeCell(doc, 1, 'NIP', y, HEADER_H, { bold: true });
  writeCell(doc, 2, 'Nama', y, HEADER_H, { bold: true });
  writeCell(doc, 3, 'Masuk', y, HEADER_H, { bold: true });
  writeCell(doc, 4, 'Pulang', y, HEADER_H, { bold: true });
  writeCell(doc, 5, 'Status', y, HEADER_H, { bold: true });
  doc.y = y + HEADER_H;
}

function drawRow(doc, no, nip, nama, masuk, pulang, status) {
  if (doc.y + ROW_H > PAGE_BOTTOM) {
    doc.addPage();
    drawHeader(doc);
  }
  const y = doc.y;
  doc.fillColor('white');
  drawRowBorder(doc, y, ROW_H);
  doc.fillColor('black');
  writeCell(doc, 0, no, y, ROW_H);
  writeCell(doc, 1, nip, y, ROW_H);
  writeCell(doc, 2, nama, y, ROW_H);
  writeCell(doc, 3, masuk, y, ROW_H);
  writeCell(doc, 4, pulang, y, ROW_H);
  writeCell(doc, 5, status, y, ROW_H);
  doc.y = y + ROW_H;
}

function getStatusLabel(k) {
  if (k === 'H') return 'Hadir';
  if (k === 'M') return 'Mangkir';
  return k || '-';
}

/**
 * Format tanggal dari YYYY-MM-DD ke DD-MM-YYYY
 */
function formatTanggal(tgl) {
  if (!tgl || !/^\d{4}-\d{2}-\d{2}$/.test(tgl)) return tgl || '-';
  const [y, m, d] = tgl.split('-');
  return `${d}-${m}-${y}`;
}

/**
 * Generate PDF absensi dan return path file
 * Format response baru: { success, tanggal, ringkasan: { total_pegawai, normal, anomali, rincian_masalah }, anomali: [...] }
 */
function generateAbsensiPdf(data) {
  const tmpPath = path.join('/tmp', `absensi-${Date.now()}.pdf`);
  const doc = new PDFDocument({
    size: 'A4',
    margin: 50,
    info: {
      Title: 'Absensi TEKO-CAK',
      Author: 'BKPSDM Telegram Bot',
      Subject: `Absensi ${formatTanggal(data.tanggal)}`,
    },
  });

  const stream = fs.createWriteStream(tmpPath);
  doc.pipe(stream);

  // ─── Header ───
  doc.fontSize(16).font('Helvetica-Bold').text('Absensi TEKO-CAK', { align: 'center' });
  doc.fontSize(11).font('Helvetica').text(`Tanggal: ${formatTanggal(data.tanggal)}`, { align: 'center' });
  doc.moveDown(0.3);

  // ─── Garis ───
  doc.moveTo(TABLE_LEFT, doc.y).lineTo(TABLE_RIGHT, doc.y).stroke('#cccccc');
  doc.moveDown(0.3);

  // ─── Ringkasan (format baru) ───
  if (data.ringkasan) {
    const r = data.ringkasan;
    doc.fontSize(10).font('Helvetica');
    const total = r.total_pegawai || r.total || 0;
    const normal = r.normal || r.hadir || 0;
    const anomali = r.anomali || r.absen || 0;
    doc.text(`Total: ${total} pegawai  |  ✅ Normal: ${normal}  |  ⚠️ Anomali: ${anomali}`);
    doc.moveDown(0.3);
    doc.moveTo(TABLE_LEFT, doc.y).lineTo(TABLE_RIGHT, doc.y).stroke('#cccccc');
    doc.moveDown(0.5);
  }

  // ─── Tabel Anomali (format baru) ───
  if (data.anomali && data.anomali.length > 0) {
    doc.fontSize(11).font('Helvetica-Bold');
    doc.text(`⚠️ Anomali (${data.anomali.length})`);
    doc.moveDown(0.2);

    drawHeader(doc);

    data.anomali.forEach((r, i) => {
      drawRow(
        doc,
        String(i + 1),
        r.nip || '-',
        (r.nama || '-').substring(0, 40),
        r.jam_masuk || '-',
        r.jam_pulang || '-',
        getStatusLabel(r.keterangan)
      );
    });
  }

  // ─── Footer ───
  doc.moveDown(0.5);
  doc.fontSize(8).font('Helvetica').fillColor('#666666');
  doc.text(`Dicetak: ${new Date().toLocaleString('id-ID')}`, { align: 'center' });
  doc.text('BKPSDM Telegram Bot', { align: 'center' });

  // Finalize
  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(tmpPath));
    stream.on('error', reject);
  });
}

module.exports = { generateAbsensiPdf };
