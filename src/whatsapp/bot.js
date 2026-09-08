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

const { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const http = require('http');
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

// =============== FORWARDER GRUP → NOMOR TERTENTU ===============
// Pesan mengandung FORWARD_KEYWORD di grup mana pun (SEMUA @g.us yang bot ikuti,
// termasuk grup yang akan datang) diteruskan ke FORWARD_NUMBER.
// Konfigurasi hardcode (default), bisa dioverride via env tanpa edit kode.
// Set WA_MONITOR_GROUP ke SATU grup tertentu untuk membatasi; KOSONGKAN = semua grup.
const MONITOR_GROUP = (process.env.WA_MONITOR_GROUP || '').trim(); // kosong = SEMUA grup
const FORWARD_NUMBER = (process.env.WA_FORWARD_NUMBER || '6281216435394').replace(/[^0-9]/g, '');
// Hanya teruskan pesan yang mengandung kata ini (case-insensitive). Kosongkan ('') = forward semua pesan.
const FORWARD_KEYWORD = (process.env.WA_FORWARD_KEYWORD || 'hadir').toLowerCase();
if (FORWARD_NUMBER) {
  console.log(
    `🔁 Forwarder grup aktif: ${MONITOR_GROUP ? `khusus ${MONITOR_GROUP}` : 'SEMUA grup (@g.us)'} → ${FORWARD_NUMBER}` +
      (FORWARD_KEYWORD ? ` (hanya yang mengandung "${FORWARD_KEYWORD}")` : ' (semua pesan)')
  );
}

/**
 * WhatsApp kini memakai LID (Linked ID) untuk sebagian jid, mis. "7234...@lid",
 * bukan nomor HP "628xxx@s.whatsapp.net". Kita simpan mapping LID → nomor HP
 * dari event 'lid-mapping.update' dan/atau resolve via Baileys saat pesan masuk.
 */
const lidToPnCache = new Map();
const LID_CACHE_FILE = path.join(__dirname, 'lid-pn-cache.json');

// Cache LID→PN PERSISTEN: kalau cuma di memori, mapping hilang tiap restart →
// pesan dari @lid yang belum ke-cache dianggap tidak punya akses (⛔).
// Catatan: Baileys 6.7.24 TIDAK punya signalRepository.lidMapping.getPNForLID —
// satu-satunya sumber mapping adalah event 'lid-mapping.update' + file ini.
try {
  const saved = JSON.parse(fs.readFileSync(LID_CACHE_FILE, 'utf8'));
  for (const [lid, pn] of Object.entries(saved)) lidToPnCache.set(String(lid), String(pn));
  const n = Object.keys(saved).length;
  if (n > 0) console.log(`🗂️ LID cache dimuat dari file: ${n} entri`);
} catch (_) { /* file belum ada / rusak → mulai kosong */ }

/** Simpan cache LID→PN ke file (non-blokir, error tidak fatal) */
function persistLidCache() {
  try {
    fs.writeFileSync(LID_CACHE_FILE, JSON.stringify(Object.fromEntries(lidToPnCache), null, 0));
  } catch (e) {
    console.warn('⚠️ Gagal simpan LID cache: ' + e.message);
  }
}

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
      persistLidCache();
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

// =============== FORWARDER HELPERS ===============

/** Label untuk tipe pesan non-teks (dipakai kalau pesan tidak punya teks/caption) */
const TYPE_MARKERS = {
  imageMessage: '📷 [Gambar]',
  videoMessage: '🎥 [Video]',
  audioMessage: '🎵 [Audio]',
  pttMessage: '🎤 [Pesan suara]',
  stickerMessage: '🖼️ [Stiker]',
  contactMessage: '👤 [Kontak]',
  locationMessage: '📍 [Lokasi]',
  documentMessage: '📄 [Dokumen tanpa caption]',
  pollCreationMessage: '📊 [Polling]',
  groupInviteMessage: '🔗 [Undangan grup]',
  liveLocationMessage: '📍 [Lokasi langsung]',
};

/** Ambil isi pesan untuk diteruskan: teks → caption → label tipe */
function extractMessageContent(m) {
  const msg = m.message || {};
  const text = msg.conversation || msg.extendedTextMessage?.text || '';
  if (text.trim()) return text;
  const cap =
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    '';
  if (cap.trim()) return cap;
  for (const [key, label] of Object.entries(TYPE_MARKERS)) {
    if (msg[key]) return label;
  }
  return '🔔 [Pesan]';
}

/** Nama grup — cache per grup (TTL 60 dtk) agar tidak groupMetadata setiap pesan */
const groupNameCache = new Map(); // gid → { name, at }
async function monitorGroupName(sock, gid) {
  const hit = groupNameCache.get(gid);
  if (hit && Date.now() - hit.at < 60000) return hit.name;
  let name = gid;
  try {
    const meta = await sock.groupMetadata(gid);
    name = meta.subject || gid;
  } catch (_) { /* fallback: pakai jid */ }
  groupNameCache.set(gid, { name, at: Date.now() });
  return name;
}

/** Format 628xx → 08xx untuk tampilan */
function prettyPn(pn) {
  const d = String(pn || '').replace(/[^0-9]/g, '');
  if (!d) return '';
  return d.startsWith('62') ? '0' + d.slice(2) : d;
}

/** Deteksi tipe media yang BISA diunduh & diteruskan sebagai file asli */
function getDownloadableMedia(m) {
  const msg = m.message || {};
  const order = ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'pttMessage', 'stickerMessage'];
  for (const t of order) {
    if (msg[t]) return { type: t, m: msg[t] };
  }
  return null;
}

/** Header info (grup, pengirim, waktu WIB) — dipakai sebagai caption/pengantar media */
function forwardHeader(gname, senderLabel, now) {
  const fmtDate = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric' });
  const fmtTime = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });
  return `📢 [${gname}] — ${fmtDate.format(now)}\n👤 ${senderLabel}\n🕐 ${fmtTime.format(now)} WIB`;
}

/** Kirim 1 pesan forward ke nomor tujuan (dengan header info pengirim & waktu WIB) */
async function sendForward(sock, m, senderJid) {
  if (!FORWARD_NUMBER) return;

  // Jangan echo-balik pesan dari nomor tujuan itu sendiri (dia sudah melihat isi grup)
  let senderPn = null;
  try {
    senderPn = await resolveNumber(sock, senderJid);
  } catch (_) { /* LID tak ter-resolve → tetap lanjut */ }
  if (senderPn && senderPn === FORWARD_NUMBER) return;

  const gname = await monitorGroupName(sock, m.key.remoteJid);
  const senderLabel =
    (m.pushName ? m.pushName + ' ' : '') + '(' + prettyPn(senderPn || numberFromPnJid(senderJid)) + ')';
  const header = forwardHeader(gname, senderLabel, new Date());
  const target = FORWARD_NUMBER + '@s.whatsapp.net';

  // ---- Media (gambar/video/dokumen/audio/stiker): unduh & kirim sebagai file asli ----
  const media = getDownloadableMedia(m);
  if (media) {
    let buff = null;
    try {
      // downloadMediaMessage = fungsi ekspor Baileys (bukan method socket di 6.7.24)
      buff = await downloadMediaMessage(m, 'buffer');
    } catch (e) {
      console.error('❌ Unduh media gagal, fallback teks: ' + e.message);
    }
    if (buff) {
      const cap = (media.m.caption || '').trim();
      // Tipe dengan caption (gambar/video/dokumen): header + caption asli jadi caption kiriman
      const caption = (header + (cap ? '\n──────────\n' + cap : '')).trim();
      switch (media.type) {
        case 'imageMessage':
          await sock.sendMessage(target, { image: buff, caption });
          break;
        case 'videoMessage':
          await sock.sendMessage(target, { video: buff, caption, mimetype: media.m.mimetype || 'video/mp4' });
          break;
        case 'documentMessage':
          await sock.sendMessage(target, {
            document: buff,
            fileName: media.m.fileName || 'file_' + Date.now(),
            mimetype: media.m.mimetype || 'application/octet-stream',
            caption,
          });
          break;
        // Audio/ptt/stiker tidak punya caption → header dikirim sebagai pesan teks dulu
        case 'audioMessage':
          await sock.sendMessage(target, { text: header });
          await sock.sendMessage(target, { audio: buff, mimetype: media.m.mimetype || 'audio/mpeg' });
          break;
        case 'pttMessage':
          await sock.sendMessage(target, { text: header });
          await sock.sendMessage(target, { audio: buff, ptt: true, mimetype: 'audio/ogg; codecs=opus' });
          break;
        case 'stickerMessage':
          await sock.sendMessage(target, { text: header });
          await sock.sendMessage(target, { sticker: buff });
          break;
      }
      console.log(`🔁 Forward ${gname} → ${FORWARD_NUMBER}: [${media.type} ${(buff.length / 1024).toFixed(0)} KB]`);
      return;
    }
    // Gagal unduh → jatuh ke fallback teks di bawah
  }

  // ---- Fallback teks: pesan teks biasa, kontak/lokasi/polling, atau media yang gagal diunduh ----
  const content = extractMessageContent(m);
  await sock.sendMessage(target, { text: `${header}\n──────────\n${content}` });
  console.log(`🔁 Forward ${gname} → ${FORWARD_NUMBER}: ${content.slice(0, 80)}`);
}

// Antrean serial forward: tiap pesan menunggu yang sebelumnya selesai + jeda acak,
// supaya kiriman tidak numpuk/balap saat grup ramai (pola human-like anti-restriction).
let forwardChain = Promise.resolve();

/**
 * Antrekan forward grup → nomor tujuan dengan jeda acak 1-5 detik.
 * Return promise (error pesan tertentu tidak mematikan antrean berikutnya).
 */
function forwardGroupMessage(sock, m, senderJid) {
  // Filter kata kunci: pesan yang tidak mengandung FORWARD_KEYWORD tidak diteruskan
  // (media tanpa caption/label juga otomatis lewat karena label tidak mengandung kata kunci).
  const content = extractMessageContent(m);
  if (FORWARD_KEYWORD && !content.toLowerCase().includes(FORWARD_KEYWORD)) {
    // Log skip hanya untuk pesan berteks asli — media/stiker tanpa teks tidak usah berisik
    const rawText =
      m.message?.conversation ||
      m.message?.extendedTextMessage?.text ||
      m.message?.imageMessage?.caption ||
      m.message?.videoMessage?.caption ||
      m.message?.documentMessage?.caption ||
      '';
    if (rawText.trim()) {
      console.log(`⏭️  ${m.key.remoteJid}: dilewati (tidak mengandung "${FORWARD_KEYWORD}") — ${content.slice(0, 60)}`);
    }
    return Promise.resolve();
  }
  forwardChain = forwardChain
    .catch(() => {}) // error forward sebelumnya tidak menghentikan antrean
    .then(async () => {
      const delayMs = rand(1000, 5000); // jeda acak 1-5 detik (natural)
      console.log(`⏳ Forward berikutnya dalam ${(delayMs / 1000).toFixed(1)} dtk (jeda natural)...`);
      await sleep(delayMs);
      await sendForward(sock, m, senderJid);
    });
  return forwardChain;
}

// =============== BRIDGE HTTP LOCALHOST (kirim WA dari proses lain) ===============
// Proses lain (mis. automated-pengaduan-listener) TIDAK boleh membuka koneksi WA
// sendiri — 2 koneksi pada session yang sama = salah satu di-kick WhatsApp.
// Mereka POST ke bridge ini (localhost saja, ber-token):
//   POST http://127.0.0.1:8787/wa/send   { token, text, to? }
const BRIDGE_PORT = parseInt(process.env.WA_BRIDGE_PORT || '8787', 10);
const BRIDGE_TOKEN = process.env.WA_BRIDGE_TOKEN || '572182ec20aa6d9202f0f0bb';
const BRIDGE_DEFAULT_TO = process.env.WA_BRIDGE_TO || FORWARD_NUMBER; // default: nomor forwarder
let activeSock = null; // socket WA aktif (di-update tiap reconnect)
let bridgeStarted = false;

function startWaBridge() {
  if (bridgeStarted) return;
  bridgeStarted = true;
  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method !== 'POST' || req.url !== '/wa/send') return send(404, { ok: false, error: 'not found' });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const { token, text, to } = JSON.parse(body || '{}');
        if (token !== BRIDGE_TOKEN) return send(403, { ok: false, error: 'token salah' });
        if (!text || !String(text).trim()) return send(400, { ok: false, error: 'text wajib diisi' });
        const target = String(to || BRIDGE_DEFAULT_TO || '').replace(/[^0-9]/g, '');
        if (!target) return send(400, { ok: false, error: 'nomor tujuan kosong' });
        if (!activeSock?.user) return send(503, { ok: false, error: 'WA belum connect' });
        await activeSock.sendMessage(target + '@s.whatsapp.net', { text: String(text) });
        console.log(`🔔 Bridge WA: pesan terkirim ke ${target}: ${String(text).slice(0, 60)}`);
        send(200, { ok: true });
      } catch (e) {
        send(500, { ok: false, error: e.message });
      }
    });
  });
  server.listen(BRIDGE_PORT, '127.0.0.1', () =>
    console.log(`🌉 Bridge WA lokal aktif: http://127.0.0.1:${BRIDGE_PORT}/wa/send`)
  );
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

  // Bridge WA (kirim dari proses lain via localhost) — ikut socket aktif terbaru
  activeSock = sock;
  startWaBridge();

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

  // Simpan mapping LID → nomor HP begitu Baileys memberitahu (dan persist ke file)
  sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
    if (lid && pn) {
      lidToPnCache.set(String(lid), String(pn));
      persistLidCache();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.key || !m.key.remoteJid || m.key.fromMe) return;
    if (m.key.remoteJid.endsWith('@broadcast')) return;

    const isGroup = m.key.remoteJid.endsWith('@g.us');
    // Di grup: balasan → grup, pengirim → participant (untuk otorisasi & riwayat chat)
    const replyJid = m.key.remoteJid;
    const senderJid = isGroup ? (m.key.participant || m.key.remoteJid) : m.key.remoteJid;

    // ============ FORWARDER: pesan ber-kata kunci di grup → nomor tujuan ============
    // Berlaku di SEMUA grup @g.us (atau hanya MONITOR_GROUP kalau di-set). Dijalankan
    // untuk pesan apa pun (teks, media, dll), kecuali pesan sistem (protocolMessage),
    // distribusi kunci, dan reaksi emoji. Pesan dari bot sendiri sudah tersaring di atas.
    if (isGroup && (!MONITOR_GROUP || m.key.remoteJid === MONITOR_GROUP)) {
      const sys = m.message?.protocolMessage || m.message?.senderKeyDistributionMessage || m.message?.reactionMessage;
      if (!sys) {
        forwardGroupMessage(sock, m, senderJid).catch((e) =>
          console.error('❌ Forward grup gagal: ' + e.message)
        );
      }
    }

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
