#!/bin/bash
# Cek umur sesi Monev Organisasi; auto-login kalau sudah >= 2,5 jam.
# Realita 8-9 Sep 2026: sesi mati ~4 jam (20:49 -> 00:52), bukan 8 jam.
# Threshold 7 jam terlalu lambat -> sesi mati duluan. 2,5 jam = margin aman.
# Dipanggil cron tiap 30 menit. Aman dipanggil bersamaan (flock).
DIR="/home/ubuntu/bkpsdm-agent-telegram/automated-organisasi-iko"
LOG="$DIR/logs/auto-login.log"
LOCK="/tmp/org-autologin.lock"
THRESHOLD_SEC=9000    # 2,5 jam

# PENTING: script ini dipanggil system crontab, yang PATH-nya minimal (/usr/bin:/bin).
# node ada di ~/.local/bin (symlink ke ~/.hermes/node/bin) -> di luar PATH cron.
# Tanpa baris ini, `node auto-login.js` gagal "command not found" TANPA terlihat.
export PATH="/home/ubuntu/.local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ node tidak ditemukan di PATH — auto-login DILEWATI." >> "$LOG"
  exit 1
fi

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] auto-login masih berjalan — dilewati." >> "$LOG"
  exit 0
fi

AGE=$(python3 - "$DIR/session.json" <<'EOF'
import json, sys, time
try:
    d = json.load(open(sys.argv[1]))
    saved = d.get('savedAt')
    if not saved:
        print(999999); raise SystemExit
    from datetime import datetime, timezone
    dt = datetime.fromisoformat(saved.replace('Z', '+00:00'))
    age = time.time() - dt.timestamp()
    print(int(age))
except Exception:
    print(999999)
EOF
)

if [ "$AGE" -ge "$THRESHOLD_SEC" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Umur sesi ${AGE}s (>=2,5j) — jalankan auto-login." >> "$LOG"
  cd "$DIR" && node auto-login.js >> "$LOG" 2>&1
  RC=$?   # simpan dulu — kalau dibaca lewat "echo $(date ...) $?" hasilnya exit-code date (selalu 0)
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] auto-login selesai (exit ${RC})." >> "$LOG"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Umur sesi ${AGE}s (<2,5j) — belum perlu." >> "$LOG"
fi
