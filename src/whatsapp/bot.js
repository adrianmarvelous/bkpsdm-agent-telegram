/**
 * WhatsApp Adapter — BKPSDM Agent (Fase 1)
 *
 * Kulit WhatsApp untuk core dispatcher (src/core/dispatcher.js).
 * Logika SAMA dengan Telegram — adapter ini cuma:
 *   1. Dengar pesan masuk via Baileys
 *   2. Cek otorisasi (allowlist nomor WA dari env WA_ALLOWED_NUMBERS)
 *   3. Panggil handleMessage() → render Reply ke WhatsApp
 *
 * WhatsApp tidak punya inline keyboard / HTML / Markdown, jadi:
 *   - reply 'menu'      → ditampilkan sebagai teks biasa
 *   - tag HTML di-strip → teks plain (WA tidak render <b>)
 *   - reply 'document'  → dikirim sebagai attachment PDF
 *
 * Env tambahan (di .env root project):
 *   WA_ALLOWED_NUMBERS=628123456789,628987654321   (kosong = mode publik)
 */

const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { handleMessage } = require('../core/dispatcher');

// =============== AUTHORIZATION (allowlist nomor WA) ===============

const ALLOWED_NUMBERS = (process.env.WA_ALLOWED_NUMBERS || '')
  .split(',')
  .map((s) => s.trim().replace(/[^0-9]/g, ''))
  .filter((s) => s.length > 0);

if (ALLOWED_NUMBERS.length > 0) {
  console.log(`🔒 WA Mode terbatas: ${ALLOWED_NUMBERS.length} nomor diizinkan`);
} else {
  console.log('🌐 WA Mode publik — atur WA_ALLOWED_NUMBERS di .env untuk membatasi akses');
}

/** JID WhatsApp format: 628xxx@s.whatsapp.net → bandingkan dengan allowlist */
function isAuthorized(jid) {
  if (ALLOWED_NUMBERS.length === 0) return true;
  const number = String(jid).split('@')[0].replace(/[^0-9]/g, '');
  return ALLOWED_NUMBERS.some((n) => number === n || number.endsWith(n));
}

// =============== RENDER Reply → WhatsApp ===============

/** Bersihkan HTML & Markdown → teks plain untuk WhatsApp */
function waText(s) {
  return String(s || '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1') // markdown link → teks saja
    .replace(/<[^>]+>/g, '')                    // HTML tags
    .replace(/(\*\*|__|\*|_|`)/g, '');           // markdown markers
}

async function sendReply(sock, jid, reply) {
  if (!reply) return;

  if (reply.type === 'document') {
    const data = fs.readFileSync(reply.path);
    await sock.sendMessage(jid, {
      document: data,
      fileName: path.basename(reply.path),
      mimetype: 'application/pdf',
      caption: reply.caption ? waText(reply.caption) : undefined,
    });
    try { fs.unlinkSync(reply.path); } catch (_) {}
    return;
  }

  // type: 'text' | 'menu' (menu → teks biasa, WA tidak ada inline keyboard)
  await sock.sendMessage(jid, { text: waText(reply.text) });
}

// =============== MAIN — Baileys WhatsApp Connection ===============

async function startBot() {
  const AUTH_DIR = path.join(__dirname, 'auth_info');
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Scan QR Code ini dengan WhatsApp (⋮ → Perangkat Tertaut):\n');
      QRCode.toString(qr, { type: 'terminal', small: true }, (err, url) => {
        if (err) console.log('QR String:', qr);
        else console.log(url);
      });
      const qrPath = path.join(__dirname, 'qr-code.png');
      QRCode.toFile(qrPath, qr, { width: 400 }, (err) => {
        if (!err) console.log(`📸 QR disimpan di ${qrPath} — buka file ini untuk scan`);
      });
    }

    if (connection === 'open') {
      console.log('✅ Bot terhubung ke WhatsApp!');
      console.log(`📱 Nomor: ${sock.user.id.split(':')[0]}`);
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`❌ Koneksi terputus. Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        console.log('⏳ Coba reconnect dalam 5 detik...');
        setTimeout(() => startBot(), 5000);
      } else {
        console.log('⚠️ Bot logout. Hapus folder auth_info/ untuk login ulang.');
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.key || !m.key.remoteJid || m.key.fromMe) return;
    if (m.key.remoteJid.endsWith('@broadcast')) return;
    if (m.key.remoteJid.endsWith('@g.us')) return; // grup — Fase 1: abaikan

    const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
    if (!text) return;

    const jid = m.key.remoteJid;
    console.log(`📩 WA dari ${jid}: ${text.slice(0, 80)}`);

    if (!isAuthorized(jid)) {
      await sock.sendMessage(jid, { text: '⛔ Anda tidak memiliki akses ke bot ini.' });
      return;
    }

    // Status "memproses" (tidak bisa di-delete seperti Telegram — tetap tampil)
    await sock.sendMessage(jid, { text: '⏳ Mohon tunggu, sedang mencari data...' });

    try {
      const replies = await handleMessage({ text, userId: jid, authorized: true, channel: 'whatsapp' });
      for (const reply of replies) {
        await sendReply(sock, jid, reply);
      }
    } catch (err) {
      console.error('❌ WA error:', err.message);
      await sock.sendMessage(jid, { text: '😅 Maaf, terjadi kesalahan. Silakan coba lagi.' });
    }
  });

  console.log('🤖 BKPSDM Agent — WhatsApp bot starting...');
}

module.exports = { startBot, isAuthorized };
