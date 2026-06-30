const { execute } = require('./database');

/**
 * State disposisi sementara per chat
 * chatId => { step, jadwalId, jadwalData }
 */
const disposisiState = new Map();

/**
 * Memulai flow disposisi
 */
function startDisposisi(chatId, jadwalId, jadwalData) {
  disposisiState.set(chatId, {
    step: 'waiting_names',
    jadwalId,
    jadwalData,
  });
}

/**
 * Mendapatkan state disposisi
 */
function getDisposisiState(chatId) {
  return disposisiState.get(chatId);
}

/**
 * Menghapus state disposisi
 */
function clearDisposisiState(chatId) {
  disposisiState.delete(chatId);
}

/**
 * Menyimpan disposisi ke database
 */
async function saveDisposisi(chatId, namaList) {
  const state = disposisiState.get(chatId);
  if (!state) throw new Error('Tidak ada disposisi yang sedang diproses');

  const { jadwalData } = state;
  const tugasText = jadwalData.nama_acara || 'Rapat tanpa nama';

  // Ambil tanggal & jam dari jadwal rapat
  const tgl = jadwalData.tanggal_mulai;
  const tanggalRapat = tgl instanceof Date
    ? `${tgl.getFullYear()}-${String(tgl.getMonth() + 1).padStart(2, '0')}-${String(tgl.getDate()).padStart(2, '0')}`
    : String(tgl).split('T')[0] || new Date().toISOString().split('T')[0];
  const jamRapat = jadwalData.pukul_mulai || new Date().toTimeString().slice(0, 8);

  // 1. Insert ke disposisi_tugas
  const result = await execute(
    'sijaka',
    `INSERT INTO disposisi_tugas (tugas, tanggal, jam, disposisi_ke, created_at, updated_at)
     VALUES (?, ?, ?, ?, NOW(), NOW())`,
    [tugasText, tanggalRapat, jamRapat, 'Telegram Bot'],
  );

  const idTugas = result.insertId;

  // 2. Insert ke disposisi_tugas_content untuk setiap nama
  const names = namaList.split(',').map(n => n.trim()).filter(n => n);
  for (const nama of names) {
    await execute(
      'sijaka',
      `INSERT INTO disposisi_tugas_content (id_disposisi_tugas, nip_nik, nama, created_at)
       VALUES (?, ?, ?, NOW())`,
      [idTugas, '-', nama],
    );
  }

  // Bersihkan state
  clearDisposisiState(chatId);

  return { idTugas, totalNama: names.length, names };
}

/**
 * Menghapus tugas beserta relasi content-nya
 */
async function deleteTugas(tugasId) {
  // Hapus content dulu (foreign key)
  await execute(
    'sijaka',
    'DELETE FROM disposisi_tugas_content WHERE id_disposisi_tugas = ?',
    [tugasId],
  );

  // Hapus induk
  const result = await execute(
    'sijaka',
    'DELETE FROM disposisi_tugas WHERE id = ?',
    [tugasId],
  );

  return result.affectedRows > 0;
}

module.exports = {
  startDisposisi,
  getDisposisiState,
  clearDisposisiState,
  saveDisposisi,
  deleteTugas,
};
