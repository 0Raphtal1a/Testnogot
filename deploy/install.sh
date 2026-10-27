#!/usr/bin/env bash
# Установка «Маникюра» на чистый Ubuntu 22/24 одной командой:
#   curl -fsSL https://raw.githubusercontent.com/0Raphtal1a/testnogot/main/deploy/install.sh | bash
# Повторный запуск = обновление до последней версии из GitHub (ключ и код сохраняются).

set -euo pipefail
APP=/opt/nails
REPO=https://github.com/0Raphtal1a/testnogot
export DEBIAN_FRONTEND=noninteractive

say() { printf '\n\033[1;35m▸ %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Запусти от root"; exit 1; }

IP=$(curl -fsS4 --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')
DOMAIN="${IP//./-}.sslip.io"   # бесплатный адрес вида 5-181-183-74.sslip.io → HTTPS без покупки домена

say "Пакеты"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null

if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
  say "Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v caddy >/dev/null; then
  say "Caddy (HTTPS)"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

say "Код из GitHub"
if [ -d "$APP/.git" ]; then git -C "$APP" pull -q; else git clone -q "$REPO" "$APP"; fi

if [ ! -f "$APP/.env" ]; then
  say "Настройки ИИ"
  read -rp "Вставь ключ moduleapi (sk-...): " KEY </dev/tty
  read -rp "Придумай код доступа для приложения: " CODE </dev/tty
  cat > "$APP/.env" <<EOF
IMAGE_API_BASE=https://moduleapi.pro/v1
IMAGE_API_KEY=$KEY
IMAGE_MODEL=gpt-image-2.5
ACCESS_CODE=$CODE
PORT=3000
EOF
  chmod 600 "$APP/.env"
fi

say "Автозапуск"
cat > /etc/systemd/system/nails.service <<EOF
[Unit]
Description=Nails try-on app
After=network-online.target

[Service]
WorkingDirectory=$APP
ExecStart=/usr/bin/node --env-file=$APP/.env $APP/server.js
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF

if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi

systemctl daemon-reload
systemctl enable -q --now nails
systemctl restart nails caddy
sleep 3

say "Проверка"
if curl -fsS --max-time 10 -o /dev/null http://127.0.0.1:3000/; then echo "Приложение запущено"; else echo "Приложение не ответило — смотри: journalctl -u nails -n 50"; fi
if curl -sS --max-time 15 -o /dev/null -w '%{http_code}' https://moduleapi.pro/v1/models | grep -qE '^(200|401|403)$'; then echo "moduleapi.pro доступен с сервера"; else echo "ВНИМАНИЕ: moduleapi.pro не отвечает с этого сервера"; fi

printf '\n\033[1;32mГотово! Открой на iPhone:  https://%s\033[0m\n' "$DOMAIN"
echo "(HTTPS-сертификат выпускается за 10–60 секунд после первого открытия)"
