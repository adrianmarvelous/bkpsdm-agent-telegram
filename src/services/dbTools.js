const api = require('./apiClient');

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

// =============== TOOLS DATABASE (via API) ===============

const DB_TOOLS = [
  {
    name: 'get_jadwal_rapat_hari_ini',
    description: 'Mendapatkan daftar jadwal rapat untuk hari ini',
    parameters: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      return await api.getJadwalHariIni();
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
      return await api.getJadwalByTanggal(parsed);
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
      return await api.getJadwalMingguIni();
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
      return await api.getSemuaJadwal();
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
      return await api.getTugasHariIni();
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
      return await api.getTugasByTanggal(parsed);
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
      return await api.getSemuaTugas();
    },
  },
  // =============== TOOLS BBM NON-FOSIL ===============
  {
    name: 'get_bbm_non_fosil_hari_ini',
    description: 'Mendapatkan data BBM Non-Fosil untuk hari ini',
    parameters: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      return await api.getBbmNonFosilHariIni();
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
