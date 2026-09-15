#!/usr/bin/env bash
# Switch on password reset emails: stores your Resend API key on the VM and restarts the API.
#   ./scripts/set-mail.sh                       # prompts for the key (typing is hidden)
#   MAIL_FROM="FootyVibe <hello@footyvibe.xyz>" ./scripts/set-mail.sh
# The key goes straight to /etc/clear-and-obvious-api.env over SSH; it never lands in shell history or the repo.
set -euo pipefail

VM="${VM:-voho-vm}"
ZONE="${ZONE:-europe-west2-a}"
DOMAIN="${DOMAIN:-footyvibe.xyz}"
MAIL_FROM="${MAIL_FROM:-FootyVibe <no-reply@$DOMAIN>}"

read -rsp "Resend API key (starts with re_): " KEY
echo
[[ "$KEY" == re_* ]] || { echo "That doesn't look like a Resend key (they start with re_)." >&2; exit 1; }

printf '%s\n%s\n%s\n' "$KEY" "$MAIL_FROM" "https://$DOMAIN" | gcloud compute ssh "$VM" --zone "$ZONE" --tunnel-through-iap --quiet --command '
  set -e
  read -r key; read -r from; read -r site
  env=/etc/clear-and-obvious-api.env
  tmp=$(mktemp)
  sudo grep -vE "^(RESEND_API_KEY|MAIL_FROM|SITE_URL)=" "$env" > "$tmp" || true
  printf "RESEND_API_KEY=%s\nMAIL_FROM=%s\nSITE_URL=%s\n" "$key" "$from" "$site" >> "$tmp"
  sudo install -m 600 "$tmp" "$env"
  rm -f "$tmp"
  sudo systemctl restart clear-and-obvious-api
  sleep 1
  curl -s http://127.0.0.1:4071/api/health
'
echo
echo "Done. \"mail\":true above means password reset emails are on."
