/**
 * pdf-undangan.js — Cetak daftar undangan/agenda eSurat ke PDF (rapi, A4).
 *
 * Dipakai karena daftar agenda bisa panjang & berisi banyak nama penerima,
 * sehingga tidak nyaman dibaca di chat.
 *
 * ⚠️ PENTING — satu surat bisa muncul BEBERAPA KALI di API (field `idSuratMasuk`
 * sama, `idDetail` berbeda) untuk setiap tujuan/disposisi. Kalau ditampilkan
 * apa adanya, 1 undangan bisa jadi 5 blok nyaris identik. Karena itu PDF ini
 * DIKELOMPOKKAN PER SURAT: identitas surat ditulis sekali, lalu daftar
 * distribusinya (tujuan + disposisi + penerima). Semua data tetap tampil.
 *
 * CLI:
 *   node pdf-undangan.js                     → SEMUA entri hari ini (WIB), tanpa filter
 *   node pdf-undangan.js 2026-08-05          → SEMUA entri tanggal itu
 *   node pdf-undangan.js --unit SEKRETARIAT  → hanya unit tujuan tertentu
 *   node pdf-undangan.js --json              → ringkasan JSON (dipakai bot/cron)
 *
 * Catatan desain (hasil verifikasi pypdf):
 *  - Font standar PDF (Helvetica) TIDAK punya glyph emoji → PDF ini sengaja
 *    diisi teks ASCII + karakter WinAnsi aman (•, –, ·) saja, supaya semua
 *    karakter pasti terbaca. Emoji hanya dipakai di ringkasan chat, bukan PDF.
 *  - JANGAN pakai `continued: true` dengan width sempit: pdfkit memakai width
 *    itu untuk membungkus teks lanjutan → teks tercetak terpotong per 2 huruf.
 *    Semua baris "Label: nilai" di sini memakai POSISI ABSOLUT + widthOfString.
 *  - Footer ditulis dengan margins.bottom = 0 sementara; kalau tidak, menulis
 *    di area bawah memicu page-break otomatis → muncul halaman kosong.
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const { getAgenda, normalizeRow } = require('./index');
const { tanggalIndoLengkap } = require('./reminder');
const { resolveUnitList, cocokUnit, labelUnit } = require('./units');

const M = 45; // margin
const FONT = 'Helvetica';
const FONT_B = 'Helvetica-Bold';
const GRAY = '#555555';
const LINE = '#cccccc';
const ACCENT = '#0b5394';

/** "2026-09-10" → "10 September 2026" */
function tglIndo(t) {
  try { return tanggalIndoLengkap(t).replace(/^[^,]+,\s*/, ''); } catch (_) { return t; }
}
/** "2026-09-10" → "Kamis" */
function hariIndo(t) {
  try { return tanggalIndoLengkap(t).split(',')[0]; } catch (_) { return ''; }
}

const fmtJam = (r) => `${r.pukulAwal || '-'}${r.pukulAkhir ? '–' + r.pukulAkhir : ''} WIB`;

/** Kelompokkan baris per SURAT (idSuratMasuk), distribusi disimpan berurutan. */
function kelompokkanPerSurat(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = String(r.idSuratMasuk || r.suratPdf || r.acara || '-');
    if (!map.has(key)) map.set(key, { idSurat: key, contoh: r, distribusi: [] });
    map.get(key).distribusi.push(r);
  }
  const grup = [...map.values()];
  grup.sort((a, b) => b.distribusi.length - a.distribusi.length
    || String(a.contoh.pukulAwal || '').localeCompare(String(b.contoh.pukulAwal || '')));
  return grup;
}

/**
 * Tulis satu baris "Label: nilai" secara presisi.
 * Label bold di x, nilai di x+lebarLabel dengan lebar sisa (membungkus normal).
 */
function fieldLine(doc, label, value, x, width, size = 8.5, color = '#000000') {
  const lw = doc.font(FONT_B).fontSize(size).widthOfString(label + ': ');
  const y = doc.y;
  doc.font(FONT_B).fontSize(size).fillColor('#000000').text(label + ': ', x, y, { width: lw + 1, lineBreak: false });
  doc.font(FONT).fontSize(size).fillColor(color).text(String(value), x + lw, y, { width: Math.max(40, width - lw) });
}

/**
 * Bangun PDF dari daftar entri (sudah normalizeRow).
 * @returns {Promise<string>} path file PDF
 */
function generateUndanganPdf(rows, tanggal, { unit = null } = {}) {
  const outPath = path.join('/tmp', `undangan-esurat-${tanggal}-${Date.now()}.pdf`);
  const grup = kelompokkanPerSurat(rows);
  const doc = new PDFDocument({
    size: 'A4',
    margin: M,
    bufferPages: true,
    info: {
      Title: `Undangan eSurat ${tanggal}`,
      Author: 'BKPSDM Agent',
      Subject: unit ? `Undangan unit ${unit}` : 'Semua undangan/agenda eSurat',
    },
  });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  const W = doc.page.width - 2 * M;
  const BOTTOM = doc.page.height - 62;

  // ─── Kop ───
  doc.font(FONT_B).fontSize(15).fillColor('#000000').text('UNDANGAN / AGENDA eSURAT', { align: 'center' });
  doc.moveDown(0.15);
  doc.font(FONT).fontSize(11).fillColor('#000000')
    .text(`${hariIndo(tanggal)}, ${tglIndo(tanggal)}`, { align: 'center' });
  doc.moveDown(0.1);
  doc.fontSize(8.5).fillColor(GRAY).text(
    `KantorKu Surabaya  ·  ${unit || 'semua unit tujuan'}  ·  `
    + `${rows.length} entri dari ${grup.length} surat`,
    { align: 'center' },
  );
  doc.moveDown(0.4);
  doc.moveTo(M, doc.y).lineTo(M + W, doc.y).strokeColor(LINE).stroke();
  doc.moveDown(0.5);

  if (rows.length === 0) {
    doc.font(FONT).fontSize(10).fillColor('#000000')
      .text(`Tidak ada undangan/agenda pada ${tglIndo(tanggal)}.`, { width: W });
  }

  grup.forEach((g, gi) => {
    if (doc.y > BOTTOM - 110) doc.addPage();
    const c = g.contoh;

    // Judul kelompok: garis + "SURAT n — k distribusi"
    doc.font(FONT_B).fontSize(10.5).fillColor(ACCENT)
      .text(`SURAT ${gi + 1}`, M, doc.y, { width: W, continued: true })
      .font(FONT).fontSize(8).fillColor(GRAY)
      .text(`   ${g.distribusi.length} distribusi`, { width: W });
    doc.moveDown(0.12);

    doc.font(FONT_B).fontSize(10).fillColor('#000000').text(c.acara || '(tanpa nama acara)', M, doc.y, { width: W });
    doc.moveDown(0.15);

    const ident = [
      ['Waktu', `${c.hari ? c.hari + ', ' : ''}${fmtJam(c)}`],
      ['Tempat', c.tempat],
      ['Pengirim', c.pengirim],
      ['Dari unit', c.dariUnit && c.dariUnit !== c.pengirim ? c.dariUnit : null],
    ].filter(([, v]) => v);
    for (const [label, value] of ident) fieldLine(doc, label, value, M + 12, W - 12);
    if (c.suratPdf) fieldLine(doc, 'Surat', c.suratPdf, M + 12, W - 12, 8.5, ACCENT);
    fieldLine(doc, 'Ref', `id surat ${c.idSuratMasuk}${c.lampiran ? ` · lampiran: ${c.lampiran}` : ''}`, M + 12, W - 12, 8, GRAY);
    doc.moveDown(0.3);

    // Distribusi
    doc.font(FONT_B).fontSize(8.5).fillColor('#000000').text('Distribusi:', M + 12, doc.y);
    doc.moveDown(0.12);
    g.distribusi.forEach((d, di) => {
      if (doc.y > BOTTOM - 40) doc.addPage();
      const y = doc.y;
      doc.font(FONT_B).fontSize(9).fillColor('#000000').text(`${di + 1})`, M + 20, y, { width: 16, lineBreak: false });
      const tujuan = `${d.tujuanUnit || '(tanpa unit tujuan)'}${d.tujuanUser ? ` — ${d.tujuanUser}` : ''}`;
      doc.font(FONT).fontSize(9).fillColor('#000000').text(tujuan, M + 38, y, { width: W - 50 });
      if (d.isiDisposisi) fieldLine(doc, 'Disposisi', d.isiDisposisi, M + 38, W - 50, 8, GRAY);
      if (d.penerima && d.penerima.length) {
        fieldLine(doc, `Penerima (${d.penerima.length})`, d.penerima.map((p) => p.nama || p.nip).join('; '), M + 38, W - 50, 8, GRAY);
      }
      fieldLine(doc, 'Ref detail', d.idDetail, M + 38, W - 50, 7.5, GRAY);
      doc.moveDown(0.15);
    });

    doc.moveDown(0.25);
    doc.moveTo(M, doc.y).lineTo(M + W, doc.y).strokeColor(LINE).stroke();
    doc.moveDown(0.5);
  });

  // ─── Footer setiap halaman (margins.bottom=0 agar tidak memicu page-break) ───
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let p = range.start; p < range.start + total; p++) {
    doc.switchToPage(p);
    const simpanBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - 34;
    doc.font(FONT).fontSize(7.5).fillColor(GRAY);
    doc.text(`Dicetak: ${new Date().toLocaleString('id-ID')}  ·  BKPSDM Agent`, M, fy, { width: W / 2, align: 'left', lineBreak: false });
    doc.text(`Halaman ${p + 1} dari ${total}`, M + W / 2, fy, { width: W / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = simpanBottom;
  }

  doc.end();
  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(outPath));
    stream.on('error', reject);
  });
}

/** Ambil data + bangun PDF. Return { path, jumlah, jumlahSurat, rows, tanggal }. */
async function buatPdfUndangan(tanggal, { unit = null } = {}) {
  const unitList = resolveUnitList(unit); // null = tanpa filter
  const label = unitList ? `unit tujuan: ${labelUnit(unitList)}` : 'semua unit tujuan';
  const resp = await getAgenda(tanggal);
  let rows = (resp.data || []).map(normalizeRow);
  if (unitList) rows = rows.filter((r) => cocokUnit(r.tujuanUnit, unitList));
  const pdfPath = await generateUndanganPdf(rows, tanggal, { unit: label });
  return { path: pdfPath, jumlah: rows.length, jumlahSurat: kelompokkanPerSurat(rows).length, rows, tanggal, unit: label };
}

module.exports = { generateUndanganPdf, buatPdfUndangan, kelompokkanPerSurat, tglIndo, hariIndo };

// ===================== CLI =====================
if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
  const pos = args.filter((a) => !a.startsWith('--'));
  const unit = opt('unit');
  const nowWib = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const tanggal = (pos[0] && /^\d{4}-\d{2}-\d{2}$/.test(pos[0])) ? pos[0] : nowWib;

  buatPdfUndangan(tanggal, { unit })
    .then((hasil) => {
      if (args.includes('--json')) {
        console.log(JSON.stringify({
          path: hasil.path, tanggal: hasil.tanggal, jumlah: hasil.jumlah,
          jumlahSurat: hasil.jumlahSurat, ukuran: fs.statSync(hasil.path).size,
        }));
      } else {
        console.log(`OK ${hasil.path}`);
        console.log(`   ${hasil.jumlah} entri dari ${hasil.jumlahSurat} surat, ${(fs.statSync(hasil.path).size / 1024).toFixed(1)} KB`);
      }
      process.exit(0);
    })
    .catch((e) => { console.error('Error: ' + e.message); process.exit(1); });
}
