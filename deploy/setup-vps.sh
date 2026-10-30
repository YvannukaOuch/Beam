#!/usr/bin/env bash
# One-time setup on the VPS, which already runs other sites behind Caddy and coturn for task's calls.
# Run from your PC:
#   ssh root@162.35.161.214 'bash -s' < deploy/setup-vps.sh
# Leaves everything else alone: the Caddyfile only gets a Beam block appended (backed up and validated
# first, put back if it doesn't validate), and the TURN relay is used as it is.
set -euo pipefail

id cam >/dev/null 2>&1 || useradd --system --home /opt/cam --shell /usr/sbin/nologin cam
mkdir -p /opt/cam /var/www/cam /var/lib/cam
chown cam:cam /opt/cam /var/lib/cam

if ! grep -q 'Beam (added by cam deploy/setup-vps.sh)' /etc/caddy/Caddyfile; then
  BACKUP="/etc/caddy/Caddyfile.bak-$(date +%F)-cam"
  cp /etc/caddy/Caddyfile "$BACKUP"
  cat >> /etc/caddy/Caddyfile <<'EOF'

# ---- Beam (added by cam deploy/setup-vps.sh) -----------------------------------------------------
# Phone camera to any screen. The built site is in /var/www/cam; /ws and /api/* go to the pairing
# server on localhost:8794. The video goes browser to browser (or through coturn), never through here.
# The sslip.io name works with no DNS. deploy/enable-domain.sh adds cam.sraas.dev in front once its
# A record exists (adding it before then only collects failed certificate attempts).
cam.162-35-161-214.sslip.io {
	import horsetinder_log cam
	handle /ws {
		reverse_proxy 127.0.0.1:8794
	}
	handle /api/* {
		reverse_proxy 127.0.0.1:8794
	}
	handle {
		encode zstd gzip
		root * /var/www/cam
		@assets path /assets/*
		header @assets Cache-Control "public, max-age=31536000, immutable"
		@pages not path /assets/*
		header @pages Cache-Control "no-cache"
		try_files {path} /index.html
		file_server
	}
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		Permissions-Policy "camera=(self), microphone=(self)"
	}
}
EOF
  # Caddy runs as its own user and can't create log files in this folder itself.
  touch /var/log/caddy/cam.log && chown caddy:caddy /var/log/caddy/cam.log
  if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
    cp "$BACKUP" /etc/caddy/Caddyfile
    echo "The new Caddyfile didn't validate; the old one is back in place." >&2
    exit 1
  fi
  systemctl reload caddy
fi

echo "VPS ready."
