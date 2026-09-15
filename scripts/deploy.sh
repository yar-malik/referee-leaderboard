#!/usr/bin/env bash
# Build the static site and publish it to the GCE VM behind nginx.
#   ./scripts/deploy.sh            # build + upload
#   ./scripts/deploy.sh --setup    # also (re)write the nginx site for $DOMAIN, get a TLS cert, redirect the old address
#   ./scripts/deploy.sh --api-setup  # once: install the fan verdict API service and proxy /api to it
set -euo pipefail

VM="${VM:-voho-vm}"
ZONE="${ZONE:-europe-west2-a}"
DOMAIN="${DOMAIN:-footyvibe.xyz}"
# The site's previous address; --setup turns it into a redirect so shared links keep working.
OLD_DOMAIN="${OLD_DOMAIN:-clear-and-obvious.35-246-73-32.sslip.io}"
WEBROOT="/var/www/clear-and-obvious"
API_DIR="/opt/clear-and-obvious-api"
API_DATA="/var/lib/clear-and-obvious"
API_PORT="4071"

cd "$(dirname "$0")/.."

# Domain and TLS first: if DNS isn't pointing here yet this stops before anything is published.
if [[ "${1:-}" == "--setup" ]]; then
  gcloud compute ssh "$VM" --zone "$ZONE" --tunnel-through-iap --quiet \
    --command "DOMAIN=$DOMAIN OLD_DOMAIN=$OLD_DOMAIN WEBROOT=$WEBROOT API_PORT=$API_PORT bash -s" <scripts/site-setup.sh
fi

SITE_URL="https://$DOMAIN" npm run build

# Stream the build over the IAP tunnel and swap it in atomically.
COPYFILE_DISABLE=1 tar --no-xattrs -C dist -czf - . | gcloud compute ssh "$VM" --zone "$ZONE" --tunnel-through-iap --quiet \
  --command "set -e; new=$WEBROOT.new; sudo rm -rf \$new; sudo mkdir -p \$new; sudo tar -xzf - -C \$new; sudo chmod -R a+rX \$new;
    sudo rm -rf $WEBROOT.old; [ -d $WEBROOT ] && sudo mv $WEBROOT $WEBROOT.old; sudo mv \$new $WEBROOT; sudo rm -rf $WEBROOT.old"

if [[ "${1:-}" == "--api-setup" ]]; then
  gcloud compute ssh "$VM" --zone "$ZONE" --tunnel-through-iap --quiet \
    --command "API_DIR=$API_DIR API_DATA=$API_DATA API_PORT=$API_PORT WEBROOT=$WEBROOT bash -s" <scripts/api-setup.sh
fi

# Ship the API code and restart it, when the service is installed.
COPYFILE_DISABLE=1 tar --no-xattrs -C server -czf - . | gcloud compute ssh "$VM" --zone "$ZONE" --tunnel-through-iap --quiet \
  --command "if [ -d $API_DIR ]; then tar -xzf - -C $API_DIR && sudo systemctl restart clear-and-obvious-api && sleep 1 && curl -sf http://127.0.0.1:$API_PORT/api/health; else cat >/dev/null; fi"

echo "Deployed → https://$DOMAIN"
