/**
 * WhatsApp Adapter — BKPSDM Agent (Fase 1)
 *
 * Kulit WhatsApp untuk core dispatcher (src/core/dispatcher.js).
 * Logika SAMA dengan Telegram — adapter ini cuma:
 *   1. Dengar pesan masuk via Baileys
 *   2. Di grup (@g.us): hanya balas jika di-mention/tag (mention JID, @nomor, atau reply pesan bot)
 *   3. Cek otorisasi (allowlist nomor WA dari env WA_ALLOWED_NUMBERS)
 *   4. Panggil handleMessage() → render Reply ke WhatsApp
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

/**
 * WhatsApp kini memakai LID (Linked ID) untuk sebagian jid, mis. "7234...@lid",
 * bukan nomor HP "628xxx@s.whatsapp.net". Kita simpan mapping LID → nomor HP
 * dari event 'lid-mapping.update' dan/atau resolve via Baileys saat pesan masuk.
 */
const lidToPnCache = new Map();

function isLidJid(jid) {
  return /@(lid|hosted\.lid)$/.test(String(jid));
}

/** Ambil angka murni dari jid nomor HP (628xxx@s.whatsapp.net / 628xxx:0@s.whatsapp.net / @hosted) */
function numberFromPnJid(jid) {
  // Format bisa 628xxx@s.whatsapp.net atau 628xxx:0@s.whatsapp.net (device ID di belakang ':')
  const user = String(jid).split('@')[0].split(':')[0];
  return user.replace(/[^0-9]/g, '');
}

/**
 * Resolve jid (bisa LID atau nomor HP) → nomor HP murni (hanya digit).
 * Prioritas: cache lokal → signalRepository.getPNForLID() → null.
 */
async function resolveNumber(sock, jid) {
  const jidStr = String(jid);

  if (!isLidJid(jidStr)) {
    // Sudah berbentuk nomor HP langsung
    return numberFromPnJid(jidStr);
  }

  // JID LID → cari nomor HP yang tertaut
  if (lidToPnCache.has(jidStr)) {
    return numberFromPnJid(lidToPnCache.get(jidStr));
  }

  try {
    const pn = await sock?.signalRepository?.lidMapping?.getPNForLID(jidStr);
    if (pn) {
      lidToPnCache.set(jidStr, pn);
      return numberFromPnJid(pn);
    }
  } catch (err) {
    console.warn(`⚠️ Gagal resolve LID ${jidStr}: ${err.message}`);
  }

  // LID tidak bisa dicocokkan dengan allowlist nomor HP → tolak
  return null;
}

/** JID WhatsApp → bandingkan dengan allowlist (support LID & nomor HP) */
async function isAuthorized(sock, jid) {
  if (ALLOWED_NUMBERS.length === 0) return true;
  const number = await resolveNumber(sock, jid);
  if (!number) return false;
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

// =============== NATURAL DELAY (anti-restriction, human-like) ===============

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Acak integer [min, max) */
function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

/** Jeda "membaca" pesan masuk: 2-4.5 dtk + bonus utk pesan panjang (max +1.5 dtk) */
function readDelay(textLen) {
  return rand(2000, 4500) + Math.min(Math.floor(textLen / 10), 1500);
}

/** Durasi "mengetik" proporsional panjang balasan (~16 karakter/detik) + jitter */
function typingDelay(textLen) {
  return Math.min(Math.max(Math.floor(textLen / 16), 900), 6000) + rand(0, 1500);
}

/** Presence update yang aman — gagal tidak boleh menggagalkan kirim pesan */
async function safePresence(sock, state, jid) {
  try {
    await sock.sendPresenceUpdate(state, jid);
  } catch (_) { /* non-fatal */ }
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

  // Simpan mapping LID → nomor HP begitu Baileys memberitahu
  sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
    if (lid && pn) lidToPnCache.set(String(lid), String(pn));
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.key || !m.key.remoteJid || m.key.fromMe) return;
    if (m.key.remoteJid.endsWith('@broadcast')) return;

    const isGroup = m.key.remoteJid.endsWith('@g.us');
    // Di grup: balasan → grup, pengirim → participant (untuk otorisasi & riwayat chat)
    const replyJid = m.key.remoteJid;
    const senderJid = isGroup ? (m.key.participant || m.key.remoteJid) : m.key.remoteJid;

    const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
    if (!text) return;

    // Di grup: hanya proses jika bot di-mention/tag — abaikan chat grup biasa
    if (isGroup) {
      const ctx = m.message?.extendedTextMessage?.contextInfo || {};
      const myNumber = numberFromPnJid(sock.user.id);
      // 1) Teks mengandung @nomor (diketik manual): @628xxx / @0821xxx
      let isMentioned = text.includes('@' + myNumber) || text.includes('@0' + myNumber.slice(2));
      // 2) mentionedJid — bisa format nomor HP ATAU LID (@lid) — resolve LID → nomor HP
      if (!isMentioned) {
        for (const jid of ctx.mentionedJid || []) {
          const jidStr = String(jid);
          if (numberFromPnJid(jidStr) === myNumber) {
            isMentioned = true;
            break;
          }
          const pn = await resolveNumber(sock, jidStr);
          if (pn === myNumber) {
            isMentioned = true;
            break;
          }
        }
      }
      // 3) Reply/quote pesan bot (ctx.participant juga bisa LID)
      if (!isMentioned && ctx.quotedMessage && ctx.participant) {
        if (numberFromPnJid(ctx.participant) === myNumber) {
          isMentioned = true;
        } else {
          const qpn = await resolveNumber(sock, ctx.participant);
          if (qpn === myNumber) isMentioned = true;
        }
      }
      if (!isMentioned) {
        console.log(
          `⏭️  Grup ${m.key.remoteJid}: bukan mention — diabaikan (mentionedJid=${JSON.stringify(ctx.mentionedJid || [])}, participant=${ctx.participant || '-'})`
        );
        return;
      }
    }

    const number = await resolveNumber(sock, senderJid);
    console.log(`📩 WA ${isGroup ? 'GRUP' : 'PRIBADI'} dari ${senderJid}${number ? ` (${number})` : ''}: ${text.slice(0, 80)}`);

    if (!(await isAuthorized(sock, senderJid))) {
      // Di grup: jangan balas "tidak punya akses" agar tidak spam untuk semua anggota
      if (!isGroup) {
        await sock.sendMessage(replyJid, { text: '⛔ Anda tidak memiliki akses ke bot ini.' });
      }
      return;
    }

    // Simulasi manusia: jeda "membaca" sebelum proses (bubble ⏳ dihapus —
    // indikator mengetik sudah cukup sebagai sinyal "sedang bekerja")
    await sleep(readDelay(text.length));

    try {
      const replies = await handleMessage({ text, userId: senderJid, authorized: true, channel: 'whatsapp' });
      for (const reply of replies) {
        if (reply.type === 'document') {
          // Kirim file: jeda singkat tanpa indikator mengetik
          await sleep(rand(1500, 3000));
          await sendReply(sock, replyJid, reply);
        } else {
          // Tampil "mengetik..." → tunggu sesuai panjang balasan → kirim → berhenti
          await safePresence(sock, 'composing', replyJid);
          await sleep(typingDelay((reply.text || '').length));
          await safePresence(sock, 'paused', replyJid);
          await sendReply(sock, replyJid, reply);
          await sleep(rand(500, 1200)); // jeda antar balasan
        }
      }
    } catch (err) {
      console.error('❌ WA error:', err.message);
      await sleep(rand(1200, 2500));
      await sock.sendMessage(replyJid, { text: '😅 Maaf, terjadi kesalahan. Silakan coba lagi.' });
    }
  });

  console.log('🤖 BKPSDM Agent — WhatsApp bot starting...');
}

module.exports = { startBot, isAuthorized };
