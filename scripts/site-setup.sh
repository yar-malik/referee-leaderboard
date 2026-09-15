#!/usr/bin/env bash
# Runs on the VM (piped in by `deploy.sh --setup`): serves the site on $DOMAIN (and www.$DOMAIN when it
# resolves here) with the /api proxy, gets a TLS cert, then turns $OLD_DOMAIN into a permanent redirect
# so links already shared keep working. Safe to re-run.
set -euo pipefail
: "${DOMAIN:?}" "${WEBROOT:?}" "${API_PORT:?}"
OLD_DOMAIN="${OLD_DOMAIN:-}"
site="/etc/nginx/sites-available/${DOMAIN%%.*}"
ip=$(curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip)

points_here() { [ "$(dig +short A "$1" @1.1.1.1 | tail -1)" = "$ip" ]; }

if ! points_here "$DOMAIN"; then
  echo "$DOMAIN does not resolve to $ip yet. Add an A record for it, then re-run --setup." >&2
  exit 1
fi
names="$DOMAIN"
certs=(-d "$DOMAIN")
if points_here "www.$DOMAIN"; then
  names="$DOMAIN www.$DOMAIN"
  certs+=(-d "www.$DOMAIN")
else
  echo "note: www.$DOMAIN does not resolve here yet, skipping it"
fi

sudo mkdir -p "$WEBROOT"
sudo tee "$site" >/dev/null <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $names;

    root $WEBROOT;
    index index.html;

    access_log /var/log/nginx/${DOMAIN%%.*}.access.log;
    error_log /var/log/nginx/${DOMAIN%%.*}.error.log;

    gzip on;
    gzip_types text/css application/javascript image/svg+xml application/json;

    location /_astro/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location /api/ {
        proxy_pass http://127.0.0.1:$API_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        client_max_body_size 16k;
    }

    location / {
        try_files \$uri \$uri/ =404;
    }

    error_page 404 /404.html;
}
NGINX
sudo ln -sf "$site" "/etc/nginx/sites-enabled/${DOMAIN%%.*}"
sudo nginx -t
sudo systemctl reload nginx

sudo certbot --nginx "${certs[@]}" --non-interactive --agree-tos --register-unsafely-without-email --redirect --expand
echo "https://$DOMAIN is live"

# Old address: keep its cert, but send every request to the same path on the new domain.
old_site=/etc/nginx/sites-available/clear-and-obvious
if [ -n "$OLD_DOMAIN" ] && [ -f "$old_site" ] && ! grep -q "return 301 https://$DOMAIN" "$old_site"; then
  sudo cp "$old_site" /tmp/clear-and-obvious.nginx.bak
  sudo tee "$old_site" >/dev/null <<NGINX
server {
    server_name $OLD_DOMAIN;
    listen 443 ssl;
    listen [::]:443 ssl;
    ssl_certificate /etc/letsencrypt/live/$OLD_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$OLD_DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    return 301 https://$DOMAIN\$request_uri;
}
server {
    listen 80;
    listen [::]:80;
    server_name $OLD_DOMAIN;
    return 301 https://$DOMAIN\$request_uri;
}
NGINX
  if ! sudo nginx -t 2>/dev/null; then
    sudo cp /tmp/clear-and-obvious.nginx.bak "$old_site"
    echo "redirect config failed nginx -t; restored $OLD_DOMAIN" >&2
    exit 1
  fi
  sudo systemctl reload nginx
  echo "$OLD_DOMAIN now redirects to https://$DOMAIN"
fi
