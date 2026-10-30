#!/usr/bin/env bash
# Build locally and ship to the VPS. Run in Git Bash from the project folder:
#   ./deploy.sh
# Never touches the Caddyfile or other apps (one-time setup: deploy/setup-vps.sh).
set -euo pipefail

TARGET="${DEPLOY_TARGET:-root@162.35.161.214}"

echo "> Building"
pnpm build

echo "> Uploading to $TARGET"
tar czf - dist dist-server deploy | ssh "$TARGET" '
  set -e
  rm -rf /opt/cam/incoming && mkdir -p /opt/cam/incoming
  tar xzf - -C /opt/cam/incoming
  cd /opt/cam/incoming
  # Swap the new site in with one move, so nobody loads a half-copied page.
  rm -rf /var/www/cam.new /var/www/cam.old
  cp -r dist /var/www/cam.new
  [ -d /var/www/cam ] && mv /var/www/cam /var/www/cam.old
  mv /var/www/cam.new /var/www/cam
  rm -rf /var/www/cam.old
  rm -rf /opt/cam/dist-server && mv dist-server /opt/cam/dist-server
  cp deploy/cam.service /etc/systemd/system/cam.service
  cd /opt/cam && rm -rf incoming
  chown -R cam:cam /opt/cam
  systemctl daemon-reload
  systemctl enable cam >/dev/null 2>&1
  # The server saves its sessions on the way down and reads them back: calls in progress carry on.
  systemctl restart cam
  sleep 1
  echo "cam: $(systemctl is-active cam)"
  curl -fsS http://127.0.0.1:8794/api/health && echo
'
echo "> Done: https://cam.162-35-161-214.sslip.io (and https://cam.sraas.dev once its DNS record exists)"
