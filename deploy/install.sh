#!/usr/bin/env bash
# Установка «Маникюра» на чистый Ubuntu 22/24 одной командой:
#   curl -fsSL https://raw.githubusercontent.com/0Raphtal1a/testnogot/main/deploy/install.sh | bash
# Повторный запуск = обновление до последней версии из GitHub (код доступа сохраняется).

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
  say "Настройки"
  read -rp "Код доступа к приложению (Enter — без кода): " CODE </dev/tty
  printf 'ACCESS_CODE=%s\nPORT=3000\n' "$CODE" > "$APP/.env"
  chmod 600 "$APP/.env"
fi
# ИИ больше не используется — убираем старые ключи, если остались
sed -i '/^IMAGE_/d;/^OPENROUTER_/d' "$APP/.env"

say "Автозапуск"
cat > /etc/systemd/system/nails.service <<EOF
[Unit]
Description=Nails ideas app
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

printf '\n\033[1;32mГотово! Открой на iPhone:  https://%s\033[0m\n' "$DOMAIN"
echo "(HTTPS-сертификат выпускается за 10–60 секунд после первого открытия)"
