#!/usr/bin/env bash
# Runs on the VM (piped in by `deploy.sh --api-setup`): installs the fan verdict API as a systemd
# service bound to localhost and proxies /api to it from the site's nginx config. Safe to re-run.
set -euo pipefail
: "${API_DIR:?}" "${API_DATA:?}" "${API_PORT:?}" "${WEBROOT:?}"
user=$(whoami)

sudo mkdir -p "$API_DIR" "$API_DATA"
sudo chown "$user" "$API_DIR" "$API_DATA"

# Secrets are generated on the VM and never leave it: sudo cat /etc/clear-and-obvious-api.env
if ! sudo test -f /etc/clear-and-obvious-api.env; then
  printf 'ADMIN_TOKEN=%s\nSALT=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" | sudo tee /etc/clear-and-obvious-api.env >/dev/null
  sudo chmod 600 /etc/clear-and-obvious-api.env
fi

sudo tee /etc/systemd/system/clear-and-obvious-api.service >/dev/null <<UNIT
[Unit]
Description=FootyVibe fan hubs API
After=network.target

[Service]
User=$user
Environment=PORT=$API_PORT DATA_DIR=$API_DATA WEBROOT=$WEBROOT
EnvironmentFile=/etc/clear-and-obvious-api.env
ExecStart=/usr/bin/node $API_DIR/community.mjs
Restart=always
RestartSec=2
MemoryMax=256M
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$API_DATA
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable clear-and-obvious-api >/dev/null

site=/etc/nginx/sites-available/clear-and-obvious
# Newer installs get /api from site-setup.sh already; this patches the original site file.
if [ -f "$site" ] && ! grep -q "return 301" "$site" && ! grep -q 'location /api/' "$site"; then
  sudo cp "$site" /tmp/clear-and-obvious.nginx.bak
  block="    location /api/ {\n        proxy_pass http://127.0.0.1:$API_PORT;\n        proxy_set_header Host \$host;\n        proxy_set_header X-Real-IP \$remote_addr;\n        proxy_set_header X-Forwarded-Proto \$scheme;\n        client_max_body_size 16k;\n    }\n\n    location / {"
  sudo sed -i "0,/^    location \/ {/s||$block|" "$site"
  if ! sudo nginx -t 2>/dev/null; then
    sudo cp /tmp/clear-and-obvious.nginx.bak "$site"
    echo 'nginx config test failed; restored the previous config' >&2
    exit 1
  fi
  sudo systemctl reload nginx
fi
echo "api setup done"
