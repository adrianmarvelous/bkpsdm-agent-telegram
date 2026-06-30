/**
 * Manajemen riwayat percakapan per pengguna
 * Menyimpan konteks chat untuk setiap user agar AI bisa memahami konteks
 */

// Map untuk menyimpan riwayat percakapan: chatId => array of messages
const conversations = new Map();

// Konfigurasi
const MAX_HISTORY_PER_USER = 20; // Maksimal pesan yang disimpan per user
const CONVERSATION_TIMEOUT = 30 * 60 * 1000; // 30 menit

/**
 * Mendapatkan riwayat percakapan pengguna
 * @param {number} chatId - ID chat Telegram
 * @returns {Array} - Array pesan { role, content }
 */
function getHistory(chatId) {
  if (!conversations.has(chatId)) {
    conversations.set(chatId, []);
  }
  return conversations.get(chatId);
}

/**
 * Menambahkan pesan ke riwayat percakapan
 * @param {number} chatId - ID chat Telegram
 * @param {string} role - 'user' atau 'assistant'
 * @param {string} content - Isi pesan
 */
function addMessage(chatId, role, content) {
  const history = getHistory(chatId);

  history.push({
    role,
    content,
    timestamp: Date.now(),
  });

  // Batasi jumlah pesan yang disimpan
  if (history.length > MAX_HISTORY_PER_USER) {
    history.splice(0, history.length - MAX_HISTORY_PER_USER);
  }
}

/**
 * Menghapus riwayat percakapan pengguna
 * @param {number} chatId - ID chat Telegram
 */
function clearHistory(chatId) {
  conversations.delete(chatId);
}

/**
 * Membersihkan percakapan yang sudah kadaluarsa
 */
function cleanExpiredConversations() {
  const now = Date.now();
  for (const [chatId, history] of conversations.entries()) {
    const lastMessage = history[history.length - 1];
    if (lastMessage && now - lastMessage.timestamp > CONVERSATION_TIMEOUT) {
      conversations.delete(chatId);
    }
  }
}

// Bersihkan percakapan kadaluarsa setiap 10 menit
setInterval(cleanExpiredConversations, 10 * 60 * 1000);

module.exports = { getHistory, addMessage, clearHistory };
