#!/usr/bin/env bash
# esurat-reminder.sh — jalankan reminder undangan eSurat (1 jam sebelum acara,
# hanya surat dengan tujuan unit SEKRETARIAT / SUB BAGIAN KEUANGAN).
# Dipanggil cron tiap 10 menit.
#
# PENTING: cron punya PATH minimal (/usr/bin:/bin); node ada di ~/.local/bin.
#
# PEMANTAUAN 403 (ditambahkan 15 Sep 2026):
#   Kalau API eSurat menolak dengan 403 "tidak punya akses ke modul esurat-agenda",
#   ini masalah HAK AKSES di sisi KantorKu — bukan bug kita, dan percobaan ulang
#   tidak menolong. Supaya tidak diam-diam, dikirim SATU alert ke Telegram saat
#   403 pertama terdeteksi, lalu SATU alert lagi saat akses pulih. Selama status
#   tidak berubah, cron tetap diam (tidak spam).
DIR="/home/ubuntu/bkpsdm-agent-telegram/automated-esurat"
LOG="$DIR/logs/reminder.log"
LOCK="/tmp/esurat-reminder.lock"
FLAG="/tmp/esurat-403.flag"

export PATH="/home/ubuntu/.local/bin:$PATH"

# Token Telegram dibaca dari root .env — cron tidak mewarisi env project.
ENV_FILE="/home/ubuntu/bkpsdm-agent-telegram/.env"
TELEGRAM_BOT_TOKEN="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '\r')"

if ! command -v node >/dev/null 2>&1; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ node tidak ditemukan di PATH — reminder DILEWATI." >> "$LOG"
  exit 1
fi

mkdir -p "$DIR/logs"

# Hindari tumpang tindih kalau tick sebelumnya masih jalan
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] masih berjalan — dilewati." >> "$LOG"
  exit 0
fi

cd "$DIR" || exit 0

# Jalankan; stdout dibuang (script kirim sendiri ke Telegram), stderr + log ke file
BEFORE=$(wc -l < "$LOG" 2>/dev/null || echo 0)
node reminder.js >> "$LOG" 2>&1
NEW="$(tail -n +$((BEFORE + 1)) "$LOG" 2>/dev/null)"

TOKEN_403="Access denied: tidak punya akses ke modul esurat-agenda"

kirim_alert() {   # $1 = teks
  local tgt
  tgt="$(grep -E '^ESURAT_ALERT_CHAT_ID=' "/home/ubuntu/bkpsdm-agent-telegram/.env" 2>/dev/null | cut -d= -f2- | tr -d '\r')"
  [ -z "$tgt" ] && tgt="$(grep -E '^ALLOWED_CHAT_IDS=' "/home/ubuntu/bkpsdm-agent-telegram/.env" 2>/dev/null | cut -d= -f2- | cut -d, -f1 | tr -d '\r')"
  [ -z "$tgt" ] && return 0
  curl -s -o /dev/null -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -H 'Content-Type: application/json' \
    -d "{\"chat_id\":\"$tgt\",\"parse_mode\":\"HTML\",\"disable_web_page_preview\":true,\"text\":$(printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}" 2>/dev/null
}

if printf '%s' "$NEW" | grep -q "$TOKEN_403"; then
  if [ ! -f "$FLAG" ]; then
    date '+%Y-%m-%d %H:%M:%S' > "$FLAG"
    kirim_alert "⚠️ <b>Akses modul eSurat DITOLAK (403)</b>

Akun <code>bkpsdm</code> tidak lagi punya akses ke modul <code>esurat-agenda</code>.

• Reminder undangan otomatis <b>berhenti membaca agenda</b> sampai akses dibuka kembali.
• Ini masalah hak akses di sisi KantorKu — bukan bug di sisi bot, dan percobaan ulang tidak menolong.
• Ringkasan harian (tugas/rapat/tupoksi) <b>tetap normal</b> — sumbernya API berbeda.

Pesan ini dikirim sekali saja. Akan ada notifikasi lagi begitu akses pulih.

— Dipantau otomatis oleh Hermes Agent"
  fi
elif [ -f "$FLAG" ] && printf '%s' "$NEW" | grep -q "entri agenda hari ini"; then
  rm -f "$FLAG"
  kirim_alert "✅ <b>Akses modul eSurat PULIH</b>

Akun <code>bkpsdm</code> sudah bisa membaca agenda kembali — reminder undangan otomatis jalan seperti biasa.

— Dipantau otomatis oleh Hermes Agent"
fi

exit 0
