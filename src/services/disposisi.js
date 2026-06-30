const api = require('./apiClient');

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
 * Menyimpan disposisi via API
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

  // Parse nama (pisahkan dengan koma)
  const names = namaList.split(',').map(n => n.trim()).filter(n => n);

  // Kirim ke API
  const result = await api.createTugas({
    tugas: tugasText,
    tanggal: tanggalRapat,
    jam: jamRapat,
    disposisi_ke: 'Telegram Bot',
    pegawai: names,
  });

  // Bersihkan state
  clearDisposisiState(chatId);

  return {
    idTugas: result.id || result.insertId,
    totalNama: names.length,
    names,
  };
}

/**
 * Menghapus tugas beserta relasi content-nya via API
 */
async function deleteTugas(tugasId) {
  const result = await api.deleteTugasById(tugasId);
  return result.deleted || result.affectedRows > 0;
}

module.exports = {
  startDisposisi,
  getDisposisiState,
  clearDisposisiState,
  saveDisposisi,
  deleteTugas,
};
