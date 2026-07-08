const OpenAI = require('openai');
const { getToolDefinitions, executeTool } = require('./dbTools');

/**
 * Inisialisasi klien OpenAI untuk OpenRouter
 * OpenRouter menggunakan API yang kompatibel dengan OpenAI SDK
 */
const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': process.env.APP_URL || 'https://github.com/agent-bkpsdm-telegram',
    'X-Title': 'BKPSDM Telegram Bot',
  },
});

/**
 * Model AI yang digunakan
 * Bisa dikonfigurasi via .env, default menggunakan model gratis yang bagus
 */
const MODEL = process.env.OPENROUTER_MODEL || 'cohere/north-mini-code:free';

/**
 * System prompt untuk memberikan konteks dan kepribadian pada AI
 */
const SYSTEM_PROMPT = `Kamu adalah asisten AI yang membantu dan ramah untuk aplikasi Telegram Bot milik BKPSDM (Badan Kepegawaian dan Pengembangan Sumber Daya Manusia) Kota Surabaya.

Kepribadian dan aturan:
- Gunakan bahasa Indonesia yang baik dan natural, tidak kaku
- Jawab dengan ramah dan helpful
- Jika ada pertanyaan di luar konteks, jawab dengan sopan
- Gunakan emoji secukupnya untuk membuat percakapan lebih hidup
- Jika kamu tidak tahu jawabannya, akui saja
- Balaslah dengan singkat dan padat, maksimal 2-3 paragraf

Fitur database yang tersedia:
1. Kamu bisa mengecek jadwal rapat dari database
2. Ketika user bertanya tentang jadwal rapat, panggil tool yang sesuai
3. Untuk pertanyaan seperti "jadwal rapat tanggal 26 juni", gunakan tool get_jadwal_rapat_by_tanggal dengan parameter tanggal "26 juni" (tool akan otomatis mengenali format bahasa Indonesia)
4. Saat menampilkan jadwal rapat, tampilkan dengan format yang rapi:
   - Nama acara
   - Tanggal dan waktu
   - Tempat
5. Jika hasil tool berupa array, tampilkan satu per satu
6. Jika hasil tool berupa objek dengan pesan "Tidak ada jadwal", sampaikan ke user`;

/**
 * Tool definitions untuk function calling
 */
const TOOLS = getToolDefinitions();

/**
 * Mengirim pesan ke OpenRouter AI dan mendapatkan respons
 * Mendukung function calling untuk query database
 * @param {string} message - Pesan dari pengguna
 * @param {Array} history - Riwayat chat sebelumnya (optional)
 * @returns {Promise<string>} - Respons dari AI
 */
async function askAI(message, history = []) {
  try {
    // Validasi API key
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY tidak dikonfigurasi');
    }

    // Siapkan pesan untuk dikirim ke AI (filter hanya role & content)
    const historyMessages = history.slice(-10).map((h) => ({
      role: h.role,
      content: h.content,
    }));

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...historyMessages,
      { role: 'user', content: message },
    ];

    // Panggil AI dengan tools
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 800,
      temperature: 0.7,
    });

    const choice = response.choices[0];
    const reply = choice.message;

    // Jika AI memanggil tool(s), eksekusi dan kirim hasilnya kembali
    if (reply.tool_calls && reply.tool_calls.length > 0) {
      // Tambahkan respons AI (tool calls) ke riwayat
      messages.push(reply);

      for (const toolCall of reply.tool_calls) {
        const toolName = toolCall.function.name;
        let toolArgs = {};

        try {
          toolArgs = JSON.parse(toolCall.function.arguments || '{}');
        } catch (e) {
          toolArgs = {};
        }

        console.log(`🔧 AI memanggil tool: ${toolName}`, toolArgs);

        // Eksekusi tool
        const toolResult = await executeTool(toolName, toolArgs);

        // Kirim hasil tool kembali ke AI
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult),
        });
      }

      // Panggil AI lagi dengan hasil tool untuk diformat
      const finalResponse = await openai.chat.completions.create({
        model: MODEL,
        messages,
        max_tokens: 800,
        temperature: 0.7,
      });

      const finalContent = finalResponse.choices[0]?.message?.content;

      // Jika AI tidak memberikan konten, cek hasil tool untuk pesan fallback
      if (!finalContent) {
        // Cari tool result yang berisi pesan (empty result)
        for (const msg of messages) {
          if (msg.role === 'tool') {
            try {
              const data = JSON.parse(msg.content);
              if (data.message) {
                return `📭 ${data.message}`;
              }
            } catch (_) {}
          }
        }
        return '✅ Selesai memproses permintaan Anda.';
      }

      return finalContent;
    }

    // Jika AI tidak memanggil tool, langsung kirim balasan
    return reply.content || '⚠️ Maaf, saya tidak bisa memberikan respons saat ini. Silakan coba lagi.';
  } catch (error) {
    console.error('❌ OpenRouter API error:', error.message);

    if (error.status === 401) {
      return '🔑 API Key tidak valid. Silakan periksa konfigurasi OPENROUTER_API_KEY.';
    }
    if (error.status === 429) {
      return '⏳ Terlalu banyak permintaan. Silakan tunggu beberapa saat.';
    }

    return '😅 Maaf, terjadi kesalahan saat memproses pesan Anda. Silakan coba lagi nanti.';
  }
}

module.exports = { askAI };
