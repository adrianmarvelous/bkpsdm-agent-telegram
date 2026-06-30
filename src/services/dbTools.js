const { query } = require('./database');

// =============== PARSER TANGGAL BAHASA INDONESIA ===============

const BULAN_INDONESIA = {
  januari: '01', februari: '02', maret: '03', april: '04',
  mei: '05', juni: '06', juli: '07', agustus: '08',
  september: '09', oktober: '10', november: '11', desember: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06',
  jul: '07', agt: '08', agust: '08', sep: '09', okt: '10',
  nov: '11', des: '12',
};

/**
 * Mengubah berbagai format tanggal ke YYYY-MM-DD
 * Support: "26 juni", "26 Juni 2026", "2026-06-26", "26-06-2026"
 * @param {string} input - Teks tanggal
 * @returns {string|null} - Format YYYY-MM-DD atau null jika gagal
 */
function parseIndonesianDate(input) {
  if (!input || typeof input !== 'string') return null;

  let cleaned = input.trim().toLowerCase();

  // Format: YYYY-MM-DD atau YYYY/MM/DD
  const isoMatch = cleaned.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // Format: DD-MM-YYYY atau DD/MM/YYYY
  const dmyMatch = cleaned.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // Format: "26 juni 2026" atau "26 Juni 2026"
  const textMatch = cleaned.match(/^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/);
  if (textMatch) {
    const [, day, monthText, year] = textMatch;
    const month = BULAN_INDONESIA[monthText];
    if (month) {
      const y = year || new Date().getFullYear().toString();
      return `${y}-${month}-${day.padStart(2, '0')}`;
    }
  }

  // Format: "26 juni" saja (tahun ini)
  const shortMatch = cleaned.match(/^(\d{1,2})\s+([a-z]+)$/);
  if (shortMatch) {
    const [, day, monthText] = shortMatch;
    const month = BULAN_INDONESIA[monthText];
    if (month) {
      const y = new Date().getFullYear().toString();
      return `${y}-${month}-${day.padStart(2, '0')}`;
    }
  }

  return null;
}

// =============== TOOLS DATABASE ===============

const DB_TOOLS = [
  {
    name: 'get_jadwal_rapat_hari_ini',
    description: 'Mendapatkan daftar jadwal rapat untuk hari ini',
    parameters: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const today = new Date().toISOString().split('T')[0];
      const rows = await query(
        'web',
        `SELECT id, nama_acara, tanggal_mulai, pukul_mulai, pukul_selesai, tempat, keterangan
         FROM dashboard_web_jadwal_rapat
         WHERE tanggal_mulai = ?
         ORDER BY pukul_mulai`,
        [today],
      );
      return rows.length > 0
        ? rows
        : { message: `Tidak ada jadwal rapat untuk hari ini (${today})` };
    },
  },
  {
    name: 'get_jadwal_rapat_by_tanggal',
    description: 'Mendapatkan daftar jadwal rapat berdasarkan tanggal tertentu. Bisa terima format: YYYY-MM-DD, DD-MM-YYYY, atau teks Indonesia seperti "26 juni" atau "26 juni 2026"',
    parameters: {
      type: 'object',
      properties: {
        tanggal: {
          type: 'string',
          description: 'Tanggal dalam berbagai format. Contoh: "2026-06-30", "30-06-2026", "30 juni", "30 juni 2026"',
        },
      },
      required: ['tanggal'],
    },
    handler: async (args) => {
      const parsed = parseIndonesianDate(args.tanggal);
      if (!parsed) {
        return {
          error: true,
          message: `Maaf, saya tidak bisa memahami format tanggal "${args.tanggal}". Gunakan format seperti "26 juni" atau "2026-06-26".`,
        };
      }

      const rows = await query(
        'web',
        `SELECT id, nama_acara, tanggal_mulai, pukul_mulai, pukul_selesai, tempat, keterangan
         FROM dashboard_web_jadwal_rapat
         WHERE tanggal_mulai = ?
         ORDER BY pukul_mulai`,
        [parsed],
      );
      return rows.length > 0
        ? rows
        : { message: `Tidak ada jadwal rapat untuk tanggal ${parsed}` };
    },
  },
  {
    name: 'get_jadwal_rapat_minggu_ini',
    description: 'Mendapatkan daftar jadwal rapat untuk minggu ini (Senin-Minggu)',
    parameters: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const now = new Date();
      const dayOfWeek = now.getDay();
      const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const monday = new Date(now);
      monday.setDate(now.getDate() + diffToMonday);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);

      const start = monday.toISOString().split('T')[0];
      const end = sunday.toISOString().split('T')[0];

      const rows = await query(
        'web',
        `SELECT id, nama_acara, tanggal_mulai, pukul_mulai, pukul_selesai, tempat, keterangan
         FROM dashboard_web_jadwal_rapat
         WHERE tanggal_mulai BETWEEN ? AND ?
         ORDER BY tanggal_mulai, pukul_mulai`,
        [start, end],
      );
      return rows.length > 0
        ? rows
        : { message: `Tidak ada jadwal rapat minggu ini (${start} - ${end})` };
    },
  },
  {
    name: 'get_semua_jadwal_rapat',
    description: 'Mendapatkan semua jadwal rapat yang tersedia (max 10)',
    parameters: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const rows = await query(
        'web',
        `SELECT id, nama_acara, tanggal_mulai, pukul_mulai, pukul_selesai, tempat, keterangan
         FROM dashboard_web_jadwal_rapat
         ORDER BY tanggal_mulai DESC
         LIMIT 10`,
      );
      return rows;
    },
  },
  // =============== TOOLS TUGAS (SIJAKA) ===============
  {
    name: 'get_tugas_hari_ini',
    description: 'Mendapatkan daftar tugas/disposisi untuk hari ini dari database SIJAKA',
    parameters: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const today = new Date().toISOString().split('T')[0];
      const rows = await query(
        'sijaka',
        `SELECT dt.id, dt.tugas, dt.tanggal, dt.jam, dt.disposisi_ke,
                GROUP_CONCAT(dtc.nama SEPARATOR ', ') AS pegawai
         FROM disposisi_tugas dt
         LEFT JOIN disposisi_tugas_content dtc ON dt.id = dtc.id_disposisi_tugas
         WHERE dt.tanggal = ?
         GROUP BY dt.id
         ORDER BY dt.jam`,
        [today],
      );
      return rows.length > 0
        ? rows
        : { message: `Tidak ada tugas untuk hari ini (${today})` };
    },
  },
  {
    name: 'get_tugas_by_tanggal',
    description: 'Mendapatkan daftar tugas/disposisi berdasarkan tanggal tertentu dari database SIJAKA',
    parameters: {
      type: 'object',
      properties: {
        tanggal: {
          type: 'string',
          description: 'Tanggal dalam berbagai format. Contoh: "2026-06-30", "30-06-2026", "30 juni", "30 juni 2026"',
        },
      },
      required: ['tanggal'],
    },
    handler: async (args) => {
      const parsed = parseIndonesianDate(args.tanggal);
      if (!parsed) {
        return { error: true, message: `Tidak bisa memahami format tanggal "${args.tanggal}".` };
      }
      const rows = await query(
        'sijaka',
        `SELECT dt.id, dt.tugas, dt.tanggal, dt.jam, dt.disposisi_ke,
                GROUP_CONCAT(dtc.nama SEPARATOR ', ') AS pegawai
         FROM disposisi_tugas dt
         LEFT JOIN disposisi_tugas_content dtc ON dt.id = dtc.id_disposisi_tugas
         WHERE dt.tanggal = ?
         GROUP BY dt.id
         ORDER BY dt.jam`,
        [parsed],
      );
      return rows.length > 0
        ? rows
        : { message: `Tidak ada tugas untuk tanggal ${parsed}` };
    },
  },
  {
    name: 'get_semua_tugas',
    description: 'Mendapatkan semua tugas/disposisi yang tersedia (max 10) dari database SIJAKA',
    parameters: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      const rows = await query(
        'sijaka',
        `SELECT dt.id, dt.tugas, dt.tanggal, dt.jam, dt.disposisi_ke,
                GROUP_CONCAT(dtc.nama SEPARATOR ', ') AS pegawai
         FROM disposisi_tugas dt
         LEFT JOIN disposisi_tugas_content dtc ON dt.id = dtc.id_disposisi_tugas
         GROUP BY dt.id
         ORDER BY dt.tanggal DESC
         LIMIT 10`,
      );
      return rows;
    },
  },
];

/** Mendapatkan definisi tools untuk function calling AI */
function getToolDefinitions() {
  return DB_TOOLS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** Mengeksekusi tool berdasarkan nama yang dipanggil AI */
async function executeTool(name, args) {
  const tool = DB_TOOLS.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Tool '${name}' tidak dikenal`);
  }
  return await tool.handler(args || {});
}

module.exports = { getToolDefinitions, executeTool, DB_TOOLS };
