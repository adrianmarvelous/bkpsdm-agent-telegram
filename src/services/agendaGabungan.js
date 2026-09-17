/**
 * agendaGabungan.js — gabungkan DUA API menjadi SATU agenda rapat.
 *
 *   Sumber A: API jadwal rapat (WEB)   → apiClient.getJadwal*()  (bingkai `rows`, 24 kolom)
 *   Sumber B: API eSurat agenda        → automated-esurat        (bingkai `data`, 22 kolom)
 *
 * Kunci join (terverifikasi 7/7 pada 10 Sep 2026):
 *   1) jadwal.id_surat_masuk === esurat.id_surat_masuk   ← kunci utama (paling kuat)
 *   2) jadwal.esurat         === esurat.surat            ← cadangan (URL PDF sama)
 *   3) normalize(acara)+tanggal+jam                      ← cadangan (surat tanpa penanda)
 * Catatan: sejak ~10 Sep 2026 API jadwal mengganti kolom `link_esurat` → `esurat`
 *          dan menambah `id_surat_masuk`. Kode lama yang baca `link_esurat` harus
 *          pakai fallback `r.esurat || r.link_esurat`.
 *
 * FILTER TUJUAN UNIT — aturan (keputusan user, 10 Sep 2026):
 *   A. punya `tujuan_unit` ∈ filter        → tampil (ditandai unit yang cocok)
 *      punya `tujuan_unit` ∉ filter        → dibuang
 *   B. undangan eSurat tanpa `tujuan_unit` → dibuang
 *   C. rapat hanya-dari-API-jadwal         → TETAP tampil, ditandai ⚠️
 *      (rapat eksternal: BKN/DPRD/dll. memang tak punya unit tujuan)
 *
 * `tujuan_unit` HANYA ada di API eSurat. Flag `sekretariat/bangkom/pkp/paik` di API
 * jadwal BUKAN unit tujuan (7/7 terbukti tidak cocok), jadi TIDAK dipakai memfilter.
 */
const api = require('./apiClient');
const esurat = require('../../automated-esurat');
const units = require('../../automated-esurat/units');

/**
 * Unit tujuan default. Prioritas: env khusus → env reminder → hardcode.
 * (Tidak menambah key .env baru; kalau tidak di-set, pakai default yang aman.)
 */
const UNIT_DEFAULT =
  process.env.AGENDA_GABUNGAN_UNIT ||
  process.env.ESURAT_REMINDER_UNIT ||
  'SEKRETARIAT,SUB BAGIAN KEUANGAN';

const BULAN_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

/** Tanggal hari ini menurut WIB (UTC+7), bukan TZ server. */
function todayWib() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Tanggal ISO → "10 September 2026" (format Indonesia). */
function tanggalIndo(t) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(t || '').slice(0, 10));
  return m ? `${m[3]} ${BULAN_ID[Number(m[2]) - 1] || m[2]} ${m[1]}` : String(t || '');
}

/** Buang tag HTML + rapikan spasi (kolom `acara`/`nama_acara` kadang berisi <p>/&nbsp;). */
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

/** Escape untuk parse_mode HTML Telegram (dipakai di formatter). */
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Map<unit, Map<nip,nama>> → objek biasa { unit: [nama, …] } (biar mudah di-copy & di-union). */
function mapKeObj(mapUnit) {
  const o = {};
  for (const [u, m] of mapUnit) o[u] = [...m.values()];
  return o;
}

/** Kunci fuzzy: nama acara (dinormalisasi) + tanggal + jam. */
function fuzzyKey(acara, tanggal, pukul) {
  return `${stripHtml(acara).toLowerCase()}`.replace(/[^a-z0-9]/g, '').slice(0, 60) +
    `|${String(tanggal || '').slice(0, 10)}|${String(pukul || '').slice(0, 5)}`;
}

// ===================== PENGAMBIL DATA =====================

/**
 * Ambil baris jadwal dari API jadwal. Return [] kalau kosong/gagal.
 * @param {'hari-ini'|'tanggal'|'minggu'} mode
 */
async function ambilBarisJadwal(mode, tanggal) {
  const r = mode === 'minggu'
    ? await api.getJadwalMingguIni()
    : mode === 'tanggal'
      ? await api.getJadwalByTanggal(tanggal)
      : await api.getJadwalHariIni();
  return Array.isArray(r) ? r : [];
}

/** Ambil baris eSurat untuk satu tanggal. Return [] kalau tidak ada/gagal. */
async function ambilBarisEsurat(tanggal) {
  try {
    const resp = await esurat.getAgenda(tanggal);
    return resp && Array.isArray(resp.data) ? resp.data : [];
  } catch (err) {
    console.log(`⚠️  agendaGabungan: eSurat ${tanggal} gagal — ${err.message}`);
    return [];
  }
}

// ===================== PENGGABUNG =====================

/**
 * Gabungkan baris mentah dua API → daftar agenda unik.
 * @returns {{merged: Array, stats: Object}}
 */
function merge(jadwalRows, esuratRows) {
  // --- 1. Rapatkan baris eSurat: 1 surat = N baris (per detail-penerima) ---
  const esuratBySurat = new Map();
  for (const r of esuratRows) {
    const k = String(r.id_surat_masuk);
    if (!esuratBySurat.has(k)) {
      esuratBySurat.set(k, {
        idSuratMasuk: r.id_surat_masuk,
        idSkFk: r.id_sk_fk,
        surat: r.surat,
        tanggal: r.tanggal,
        hari: r.hari,
        pukulAwal: r.pukul_awal,
        pukulAkhir: r.pukul_akhir,
        acara: stripHtml(r.acara),
        tempat: stripHtml(r.tempat),
        pengirim: stripHtml(r.dinas_pengirim),
        baris: 0,
        disposisi: [],
        penerimaSemua: new Map(),
        // Penerima dikelompokkan PER UNIT TUJUAN (kunci = nama unit, '(tanpa unit)' bila null).
        // Dibutuhkan karena 1 surat bisa didisposisikan ke beberapa unit sekaligus,
        // dan kita hanya boleh menampilkan penerima dari unit yang lolos filter.
        unitPenerima: new Map(),
        tujuanUnits: new Set(),
      });
    }
    const g = esuratBySurat.get(k);
    g.baris += 1;
    const unit = r.tujuan_unit ? String(r.tujuan_unit).trim().toUpperCase() : '(tanpa unit)';
    if (r.isi_disposisi) g.disposisi.push(stripHtml(r.isi_disposisi));
    if (r.tujuan_unit) g.tujuanUnits.add(unit);
    if (!g.unitPenerima.has(unit)) g.unitPenerima.set(unit, new Map());
    for (const u of (r.user_penerima || [])) {
      if (!u || !u.nama) continue;
      const key = u.nip || u.nama;
      g.penerimaSemua.set(key, u.nama);
      g.unitPenerima.get(unit).set(key, u.nama);
    }
  }

  const esuratBelumKetemu = new Set(esuratBySurat.keys());
  const merged = [];
  let matchById = 0, matchByUrl = 0, matchByFuzzy = 0;

  // --- 2. Telusuri baris jadwal, cari pasangannya di eSurat ---
  for (const j of jadwalRows) {
    let e = null, via = 'jadwal-only';

    if (j.id_surat_masuk != null && esuratBySurat.has(String(j.id_surat_masuk))) {
      e = esuratBySurat.get(String(j.id_surat_masuk)); via = 'id_surat_masuk'; matchById++;
    } else if (j.esurat || j.link_esurat) {
      // `link_esurat` = nama kolom LAMA (sebelum API berubah) — tetap didukung.
      const url = j.esurat || j.link_esurat;
      e = [...esuratBySurat.values()].find((x) => x.surat === url) || null;
      if (e) { via = 'url-esurat'; matchByUrl++; }
    }
    if (!e) {
      const key = fuzzyKey(j.nama_acara, j.tanggal_mulai, j.pukul_mulai);
      e = [...esuratBySurat.values()].find((x) => fuzzyKey(x.acara, x.tanggal, x.pukulAwal) === key) || null;
      if (e) { via = 'acara+tanggal+jam'; matchByFuzzy++; }
    }
    if (e) esuratBelumKetemu.delete(String(e.idSuratMasuk));

    merged.push({
      sumber: via === 'jadwal-only' ? 'jadwal' : 'keduanya',
      via,
      jam: String(j.pukul_mulai || '').slice(0, 5) || null,
      jamSelesai: j.pukul_selesai && j.pukul_selesai !== '00:00:00' ? String(j.pukul_selesai).slice(0, 5) : null,
      tanggal: String(j.tanggal_mulai || '').slice(0, 10),
      acara: stripHtml(j.nama_acara),
      tempat: stripHtml(j.tempat) || (e ? e.tempat : ''),
      opd: stripHtml(j.nama_opd),
      disposisi: stripHtml(j.disposisi),
      jadwalId: j.id,
      idSuratMasuk: j.id_surat_masuk != null ? j.id_surat_masuk : (e ? e.idSuratMasuk : null),
      pdf: j.esurat || j.link_esurat || (e ? e.surat : null),
      esuratPenerima: e ? [...e.penerimaSemua.values()] : [],
      unitPenerima: e ? mapKeObj(e.unitPenerima) : {},
      esuratDisposisi: e ? e.disposisi : [],
      esuratBaris: e ? e.baris : 0,
      tujuanUnits: e ? [...e.tujuanUnits] : [],
    });
  }

  // --- 3. Undangan eSurat yang sama sekali tidak ada di API jadwal ---
  for (const k of esuratBelumKetemu) {
    const e = esuratBySurat.get(k);
    merged.push({
      sumber: 'esurat',
      via: 'esurat-only',
      jam: e.pukulAwal ? String(e.pukulAwal).slice(0, 5) : null,
      jamSelesai: e.pukulAkhir || null,
      tanggal: String(e.tanggal || '').slice(0, 10),
      acara: e.acara,
      tempat: e.tempat,
      opd: e.pengirim,
      disposisi: '',
      jadwalId: null,
      idSuratMasuk: e.idSuratMasuk,
      pdf: e.surat,
      esuratPenerima: [...e.penerimaSemua.values()],
      unitPenerima: mapKeObj(e.unitPenerima),
      esuratDisposisi: e.disposisi,
      esuratBaris: e.baris,
      tujuanUnits: [...e.tujuanUnits],
    });
  }

  merged.sort(bandingkanAgenda);

  return {
    merged,
    stats: {
      jadwalBaris: jadwalRows.length,
      esuratBaris: esuratRows.length,
      esuratSurat: esuratBySurat.size,
      hasilGabungan: merged.length,
      hanyaJadwal: merged.filter((m) => m.sumber === 'jadwal').length,
      hanyaEsurat: merged.filter((m) => m.sumber === 'esurat').length,
      keduanya: merged.filter((m) => m.sumber === 'keduanya').length,
      matchById, matchByUrl, matchByFuzzy,
    },
  };
}

function bandingkanAgenda(a, b) {
  return (a.tanggal + (a.jam || '99:99')).localeCompare(b.tanggal + (b.jam || '99:99'));
}

/**
 * Satukan agenda yang isinya sama (acara+tanggal+jam) → satu entri.
 * Menangani kasus 1 rapat diundangkan lewat 2 surat berbeda
 * (mis. 10 Sep 2026: id_surat_masuk 1750668 & 1750871, PDF 1202650 & 1202657).
 */
function collapseSameMeeting(merged) {
  const groups = new Map();
  for (const m of merged) {
    const k = fuzzyKey(m.acara, m.tanggal, m.jam);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const out = [];
  for (const items of groups.values()) {
    if (items.length === 1) {
      items[0].pdfs = items[0].pdf ? [items[0].pdf] : [];
      out.push(items[0]);
      continue;
    }
    const base = { ...items[0] };
    const SRC = ['keduanya', 'jadwal', 'esurat'];
    base.sumber = items.map((x) => x.sumber).sort((a, b) => SRC.indexOf(a) - SRC.indexOf(b))[0];
    base.pdfs = [...new Set(items.map((x) => x.pdf).filter(Boolean))];
    base.pdf = base.pdfs[0] || null;
    base.suratGanda = base.pdfs.length;
    const penerima = new Map();
    items.flatMap((x) => x.esuratPenerima).forEach((n) => penerima.set(n, n));
    base.esuratPenerima = [...penerima.values()];
    // Union penerima PER UNIT (kunci unit, nilai daftar nama unik)
    const perUnit = {};
    for (const x of items) {
      for (const [u, nama] of Object.entries(x.unitPenerima || {})) {
        perUnit[u] = perUnit[u] || [];
        for (const n of nama) if (!perUnit[u].includes(n)) perUnit[u].push(n);
      }
    }
    base.unitPenerima = perUnit;
    base.esuratDisposisi = [...new Set(items.flatMap((x) => x.esuratDisposisi))];
    base.tujuanUnits = [...new Set(items.flatMap((x) => x.tujuanUnits || []))];
    base.esuratBaris = items.reduce((a, x) => a + x.esuratBaris, 0);
    base.disposisi = base.disposisi || items.map((x) => x.disposisi).find(Boolean) || '';
    base.jadwalId = base.jadwalId || items.map((x) => x.jadwalId).find(Boolean) || null;
    out.push(base);
  }
  return out;
}

/**
 * Terapkan filter tujuan unit (aturan A/B/C di header file).
 * @param {Array} merged
 * @param {string[]|null} unitList  hasil units.resolveUnitList (null = tanpa filter)
 * @param {boolean} sertakanUndanganTanpaUnit  balik aturan B
 */
function filterUnit(merged, unitList, sertakanUndanganTanpaUnit = false) {
  if (!unitList) return { lolos: merged, dibuang: [], dibuangTanpaUnit: [] };
  const lolos = [], dibuang = [], dibuangTanpaUnit = [];
  for (const m of merged) {
    const uniq = (m.tujuanUnits || []).map((u) => String(u).trim().toUpperCase());

    if (uniq.length === 0) {
      // Aturan B & C
      if (m.sumber === 'jadwal' || sertakanUndanganTanpaUnit) {
        m.unitTidakDiketahui = true;
        lolos.push(m);
      } else {
        dibuangTanpaUnit.push(m);
      }
      continue;
    }
    const cocok = uniq.filter((u) => unitList.includes(u));   // Aturan A
    if (cocok.length) {
      m.unitCocok = cocok;
      // Penerima HANYA dari unit yang lolos filter — bukan seluruh penerima surat.
      const penerima = [];
      for (const u of cocok) for (const n of (m.unitPenerima || {})[u] || []) if (!penerima.includes(n)) penerima.push(n);
      m.penerimaCocok = penerima;
      lolos.push(m);
      continue;
    }
    dibuang.push(m);
  }
  return { lolos, dibuang, dibuangTanpaUnit };
}

// ===================== API UTAMA (dipakai dispatcher) =====================

/**
 * Ambil + gabung + filter agenda.
 *
 * @param {object} opts
 * @param {'hari-ini'|'tanggal'|'minggu'} [opts.mode='hari-ini']
 * @param {string} [opts.tanggal]        YYYY-MM-DD (untuk mode 'tanggal')
 * @param {string} [opts.unitInput]      teks unit bebas; undefined = pakai default
 * @returns {Promise<{merged: Array, stats: Object, unitList: string[]|null, unitLabel: string}>}
 */
async function ambilAgenda({ mode = 'hari-ini', tanggal, unitInput } = {}) {
  const unitList = units.resolveUnitList(unitInput === undefined ? UNIT_DEFAULT : unitInput);
  const unitLabel = units.labelUnit(unitList);
  const tgl = mode === 'minggu' ? null : (tanggal || todayWib());

  // --- Sumber A: jadwal ---
  let jadwalRows = [];
  try {
    jadwalRows = await ambilBarisJadwal(mode, tgl);
  } catch (err) {
    console.log(`⚠️  agendaGabungan: API jadwal gagal — ${err.message}`);
  }

  // --- Sumber B: eSurat ---
  let esuratRows = [];
  let tanggalEsurat;
  if (mode === 'minggu') {
    tanggalEsurat = [...new Set(jadwalRows.map((r) => String(r.tanggal_mulai).slice(0, 10)))];
    if (tanggalEsurat.length === 0) tanggalEsurat = [todayWib()];
  } else {
    tanggalEsurat = [tgl];
  }
  // eSurat diambil PER TANGGAL. Sengaja SEKUENSIAL, bukan paralel:
  // token eSurat di-cache di memori modul, dan panggilan paralel pada saat
  // token belum ada akan memicu beberapa login sekaligus (boros + rawan
  // kena rate-limit). Sekuensial = 1 login saja.
  esuratRows = [];
  for (const t of tanggalEsurat) {
    esuratRows.push(...(await ambilBarisEsurat(t)));
  }

  // --- Gabung + filter ---
  const { merged, stats } = merge(jadwalRows, esuratRows);
  const semua = collapseSameMeeting(merged).sort(bandingkanAgenda);
  const { lolos, dibuang, dibuangTanpaUnit } = filterUnit(semua, unitList);
  const final = lolos.sort(bandingkanAgenda);

  console.log(`📅 agendaGabungan[${mode}${tgl ? ' ' + tgl : ''}]: jadwal=${stats.jadwalBaris} esurat=${stats.esuratBaris}` +
    ` → ${semua.length} agenda → tampil ${final.length} (unit: ${unitLabel})`);

  return {
    merged: final,
    stats: {
      ...stats,
      rapatUnik: semua.length,
      tampilLolosFilterUnit: semua.filter((m) => (m.unitCocok || []).length > 0).length,
      tampilJadwalTanpaUnit: semua.filter((m) => m.unitTidakDiketahui).length,
      dibuangUnitLain: dibuang.length,
      dibuangUndanganTanpaUnit: dibuangTanpaUnit.length,
      ditampilkan: final.length,
    },
    dibuang,
    unitList,
    unitLabel,
  };
}

// ===================== FORMATTER =====================

/**
 * Format hasil gabungan → { text, keyboard } siap dikirim (HTML untuk Telegram).
 * Kompatibel dengan renderQueryResult() di dispatcher.
 */
function formatAgendaGabungan(merged, title, channel = 'telegram', unitLabel = null) {
  if (!merged || merged.length === 0) return { text: null, keyboard: [] };

  const keyboard = [];
  const baris = [];
  let tanggalTerakhir = null;
  let nomor = 0;

  for (const m of merged) {
    // Header tanggal kalau lintas hari (mode minggu ini)
    const bedaHari = tanggalTerakhir !== m.tanggal;
    if (bedaHari && (tanggalTerakhir !== null || adaLebihDariSatuTanggal(merged))) {
      baris.push(`— <b>${tanggalIndo(m.tanggal)}</b> —`, '');
      tanggalTerakhir = m.tanggal;
    } else if (bedaHari) {
      tanggalTerakhir = m.tanggal;
    }

    nomor += 1;
    const jam = m.jam ? `⏰ <b>${m.jam}${m.jamSelesai ? '–' + m.jamSelesai : ''}</b>` : '⏰ --:--';
    const label = m.sumber === 'keduanya' ? '🔗'
      : m.sumber === 'esurat' ? '✉️' : '📌';

    baris.push(`${nomor}. ${label} <b>${escHtml(m.acara || '(tanpa acara)')}</b>`);
    let info = `   ${jam}`;
    if (m.opd) info += ` | 🏢 ${escHtml(m.opd)}`;
    baris.push(info);
    if (m.tempat) baris.push(`   📍 ${escHtml(m.tempat)}`);
    if (m.disposisi) baris.push(`   🖊 disposisi: ${escHtml(m.disposisi)}`);

    if (m.unitCocok && m.unitCocok.length) {
      baris.push(`   🏷 unit tujuan: ✅ ${escHtml(m.unitCocok.join(' + '))}`);
    } else if (m.unitTidakDiketahui) {
      baris.push('   🏷 unit tujuan: ⚠️ tidak diketahui');
    }
    // Penerima: HANYA yang tujuan unitnya lolos filter (kalau ada).
    // Format: "N dari M penerima" — M = seluruh penerima surat (konteks audit).
    const totalPenerima = (m.esuratPenerima || []).length;
    const cocok = m.penerimaCocok || [];
    if (totalPenerima > 0) {
      if (cocok.length) {
        const tampil = cocok.slice(0, 5).map(escHtml).join('; ');
        baris.push(`   👥 ${cocok.length} dari ${totalPenerima} penerima (unit ✅ ${escHtml((m.unitCocok || []).join(' + '))}): ${tampil}${cocok.length > 5 ? ' …' : ''}`);
      } else {
        baris.push(`   👥 0 dari ${totalPenerima} penerima ada di unit tujuan`);
      }
    }
    const pdfs = m.pdfs && m.pdfs.length ? m.pdfs : (m.pdf ? [m.pdf] : []);
    if (pdfs.length > 1) baris.push(`   📄 ${pdfs.length} surat undangan:`);
    // URL dibungkus <a href> eksplisit supaya tidak pernah salah-render
    // (auto-link Telegram bisa mengacak garis bawah: cetak_surat → cetaksurat).
    pdfs.slice(0, 3).forEach((u) => {
      const aman = String(u).replace(/"/g, '%22');
      baris.push(`   🔗 <a href="${aman}">${escHtml(u)}</a>`);
    });
    baris.push('');

    // Tombol disposisi hanya kalau entri punya id di API jadwal
    if (m.jadwalId != null) {
      keyboard.push([{ text: `📌 Disposisi #${nomor}`, callback_data: `disposisi_${m.jadwalId}` }]);
    }
  }

  let text = `📅 <b>${escHtml(title)}</b>`;
  if (unitLabel) text += `\n<i>🏷 unit tujuan: ${escHtml(unitLabel)} · ${nomor} agenda</i>`;
  text += '\n\n' + baris.join('\n').trim();

  if (channel === 'telegram' && keyboard.length) {
    text += '\n\n<i>Klik tombol di bawah untuk disposisi rapat</i>';
  }
  return { text, keyboard };
}

/** Apakah daftar agenda mencakup >1 tanggal? (untuk memutuskan tampil header tanggal) */
function adaLebihDariSatuTanggal(merged) {
  return new Set(merged.map((m) => m.tanggal)).size > 1;
}

module.exports = {
  ambilAgenda,
  formatAgendaGabungan,
  merge,
  filterUnit,
  collapseSameMeeting,
  stripHtml,
  todayWib,
  tanggalIndo,
  UNIT_DEFAULT,
};
