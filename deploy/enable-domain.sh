#!/usr/bin/env bash
# Serve Beam on cam.sraas.dev too, once its A record points at this server. Run from your PC:
#   ssh root@162.35.161.214 'bash -s' < deploy/enable-domain.sh
# Refuses until the record is there: every attempt Caddy makes without it counts against Let's
# Encrypt's limit of failed validations, which would delay the real certificate.
set -euo pipefail
DOMAIN=beam.sraas.dev
IP=162.35.161.214

if grep -q "^$DOMAIN, " /etc/caddy/Caddyfile; then
  echo "$DOMAIN is already on."
  exit 0
fi

# Ask a public resolver: the local one may still remember that the name didn't exist.
FOUND=$(dig +short A "$DOMAIN" @1.1.1.1 | tail -n1)
if [ "$FOUND" != "$IP" ]; then
  echo "$DOMAIN doesn't point at $IP yet (it gives: ${FOUND:-nothing})." >&2
  echo "Add an A record at Porkbun: host 'beam', answer $IP. Then run this again in a minute." >&2
  exit 1
fi

BACKUP="/etc/caddy/Caddyfile.bak-$(date +%F-%H%M)-cam-domain"
cp /etc/caddy/Caddyfile "$BACKUP"
sed -i "s/^cam\.162-35-161-214\.sslip\.io {/$DOMAIN, cam.162-35-161-214.sslip.io {/" /etc/caddy/Caddyfile
if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
  cp "$BACKUP" /etc/caddy/Caddyfile
  echo "The changed Caddyfile didn't validate; the old one is back in place." >&2
  exit 1
fi
systemctl reload caddy

# Caddy fetches the certificate in the background; usually a few seconds.
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health"; then
    echo "https://$DOMAIN is live."
    exit 0
  fi
  sleep 2
done
echo "Caddy is still fetching the certificate; https://$DOMAIN should work within a few minutes."
