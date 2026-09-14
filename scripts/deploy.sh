#!/usr/bin/env bash
# Build the static site and publish it to the GCE VM behind nginx.
#   ./scripts/deploy.sh            # build + upload
#   ./scripts/deploy.sh --setup    # also (re)write the nginx site and request a TLS cert
set -euo pipefail

VM="${VM:-voho-vm}"
ZONE="${ZONE:-europe-west2-a}"
DOMAIN="${DOMAIN:-clear-and-obvious.35-246-73-32.sslip.io}"
WEBROOT="/var/www/clear-and-obvious"

cd "$(dirname "$0")/.."
SITE_URL="https://$DOMAIN" npm run build

ssh_vm() { gcloud compute ssh "$VM" --zone "$ZONE" --tunnel-through-iap --quiet --command "$1"; }

if [[ "${1:-}" == "--setup" ]]; then
  ssh_vm "sudo tee /etc/nginx/sites-available/clear-and-obvious >/dev/null <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    root $WEBROOT;
    index index.html;

    access_log /var/log/nginx/clear-and-obvious.access.log;
    error_log /var/log/nginx/clear-and-obvious.error.log;

    gzip on;
    gzip_types text/css application/javascript image/svg+xml application/json;

    location /_astro/ {
        expires 1y;
        add_header Cache-Control \"public, immutable\";
    }

    location / {
        try_files \$uri \$uri/ =404;
    }

    error_page 404 /404.html;
}
NGINX
sudo ln -sf /etc/nginx/sites-available/clear-and-obvious /etc/nginx/sites-enabled/clear-and-obvious
sudo mkdir -p $WEBROOT && sudo chown \$(whoami) $WEBROOT
sudo nginx -t && sudo systemctl reload nginx"
fi

# Stream the build over the IAP tunnel and swap it in atomically.
COPYFILE_DISABLE=1 tar --no-xattrs -C dist -czf - . | gcloud compute ssh "$VM" --zone "$ZONE" --tunnel-through-iap --quiet \
  --command "set -e; new=$WEBROOT.new; sudo rm -rf \$new; sudo mkdir -p \$new; sudo tar -xzf - -C \$new; sudo chmod -R a+rX \$new;
    sudo rm -rf $WEBROOT.old; [ -d $WEBROOT ] && sudo mv $WEBROOT $WEBROOT.old; sudo mv \$new $WEBROOT; sudo rm -rf $WEBROOT.old"

if [[ "${1:-}" == "--setup" ]]; then
  ssh_vm "sudo certbot --nginx -d $DOMAIN --non-interactive --redirect || echo 'certbot failed; site is still served over http'"
fi

echo "Deployed → https://$DOMAIN"
