#!/usr/bin/env bash
# get_pengaduan.sh
# Script to fetch pengaduan data from SPB API using JWT flow.
# Intended to be run within the bkpsdm-agent-telegram environment.
# Requires: curl, jq, base64
#
# URL BENAR: host bkpsdm (sama dengan API tugas), BUKAN spb.surabaya.go.id/permasalahanpd
# (yang terakhir kena blokir WAF 302 dari IP datacenter).
#
# ALUR (terverifikasi via tes langsung):
#   1. auth/login.php        → token admin (API_USERNAME/API_PASSWORD)
#   2. captcha.php (Bearer)  → gambar captcha + jwt sementara
#   3. login.php?captcha=XX  → JWT SPB (parameter = "captcha", BUKAN "atium")
#   4. hotline.php (Bearer)  → data pengaduan

set -euo pipefail

# === Configuration ===
BASE_URL="https://bkpsdm.surabaya.go.id/api/ai-agent/pengaduan-spb"
AUTH_URL="https://bkpsdm.surabaya.go.id/api/ai-agent/auth/login.php"
# Admin API credentials (dari .env bot bkpsdm-agent-telegram)
API_USERNAME="${API_USERNAME:-}"
API_PASSWORD="${API_PASSWORD:-}"
# Kredensial SPB pengaduan
SPB_USERNAME="${SPB_USERNAME:-}"
SPB_PASSWORD="${SPB_PASSWORD:-}"

# === Functions ===

admin_login() {
    echo "Login admin API..."
    local resp
    resp=$(curl -s -m 60 -X POST -H "Content-Type: application/json" \
        -d "{\"username\":\"${API_USERNAME}\",\"password\":\"${API_PASSWORD}\"}" \
        "${AUTH_URL}") || {
        echo "Error: Admin login request failed" >&2
        return 1
    }
    local token
    token=$(echo "$resp" | jq -r '.token // empty')
    if [[ -z "$token" || "$token" == "null" ]]; then
        echo "Error: Admin login gagal. Response:" >&2
        echo "$resp" >&2
        return 1
    fi
    echo "$token"
}

fetch_captcha() {
    local admin_token="$1"
    echo "Fetching CAPTCHA..."
    local resp
    resp=$(curl -s -m 60 -X GET "${BASE_URL}/captcha.php" \
        -H "Authorization: Bearer ${admin_token}") || {
        echo "Error: Failed to fetch CAPTCHA" >&2
        return 1
    }
    # Extract base64 image and temporary JWT (if provided)
    local captcha_b64 jwt_temp
    captcha_b64=$(echo "$resp" | jq -r '.captcha_image // empty')
    jwt_temp=$(echo "$resp" | jq -r '.jwt_token // empty')
    if [[ -z "$captcha_b64" ]]; then
        echo "Error: No CAPTCHA image in response" >&2
        echo "Response: $resp" >&2
        return 1
    fi
    # Save image for user to view
    echo "$captcha_b64" | base64 -d > /tmp/captcha.png
    echo "CAPTCHA image saved to /tmp/captcha.png"
    # Return the temporary JWT (if any) via stdout
    echo "$jwt_temp"
}

prompt_captcha() {
    local jwt_temp="$1"
    # Show instructions; in a terminal environment we can display path
    echo "Please view the CAPTCHA image at /tmp/captcha.png"
    echo "If you are running this via Telegram bot, the image will be sent separately."
    read -rp "Enter the CAPTCHA code you see: " captcha_code
    echo "$captcha_code"
}

login() {
    local admin_token="$1"
    local captcha_code="$2"
    echo "Logging in..."
    local login_resp
    login_resp=$(curl -s -m 60 -X POST "${BASE_URL}/login.php?captcha=${captcha_code}" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${admin_token}" \
        -d "{\"username\":\"${SPB_USERNAME}\",\"password\":\"${SPB_PASSWORD}\"}") || {
        echo "Error: Login request failed" >&2
        return 1
    }
    local jwt
    jwt=$(echo "$login_resp" | jq -r '.jwt // empty')
    if [[ -z "$jwt" || "$jwt" == "null" ]]; then
        echo "Error: Login gagal. Response:" >&2
        echo "$login_resp" >&2
        return 1
    fi
    echo "$jwt"
}

fetch_hotline() {
    local jwt="$1"
    local limit="${2:-5}"
    local page="${3:-1}"
    local query="${4:-}"
    echo "Fetching hotline data (limit=${limit}, page=${page})..."
    local hotline_resp
    hotline_resp=$(curl -s -m 60 -X GET "${BASE_URL}/hotline.php?limit=${limit}&hal=${page}&q=${query}" \
        -H "Authorization: Bearer ${jwt}") || {
        echo "Error: Hotline request failed" >&2
        return 1
    }
    echo "$hotline_resp"
}

# === Main execution ===

if [[ -z "$API_USERNAME" || -z "$API_PASSWORD" ]]; then
    echo "Error: Set API_USERNAME & API_PASSWORD (admin API) via env." >&2
    exit 1
fi
if [[ -z "$SPB_USERNAME" || -z "$SPB_PASSWORD" ]]; then
    echo "Error: Set SPB_USERNAME & SPB_PASSWORD (kredensial SPB pengaduan) via env." >&2
    echo "Contoh: export SPB_USERNAME=196910171993032006 SPB_PASSWORD=yourpass" >&2
    exit 1
fi

# Step 0: Login admin API → token
admin_token=$(admin_login) || exit 1
echo "Admin token acquired."

# Step 1: Get CAPTCHA (butuh Bearer admin)
jwt_temp=$(fetch_captcha "$admin_token") || exit 1

# Step 2: Prompt user for CAPTCHA code
captcha_code=$(prompt_captcha "$jwt_temp")

# Step 3: Login SPB untuk dapat JWT (parameter = captcha, bukan atium)
jwt=$(login "$admin_token" "$captcha_code") || exit 1
echo "Login SPB berhasil. JWT acquired."

# Step 4: Fetch hotline data (you can adjust parameters)
hotline_data=$(fetch_hotline "$jwt" 5 1 "")

# Output result (pretty-print JSON)
echo "=== Hotline Pengaduan (first 5) ==="
echo "$hotline_data" | jq . || echo "$hotline_data"

# Optionally save to file
echo "$hotline_data" | jq . > /tmp/pengaduan_hotline.json 2>/dev/null || cp /dev/null /tmp/pengaduan_hotline.json
echo "Full response saved to /tmp/pengaduan_hotline.json"

exit 0
