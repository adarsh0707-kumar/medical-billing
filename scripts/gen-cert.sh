#!/usr/bin/env bash
# Generates a self-signed certificate for the production stack.
#
# This exists so the stack can be brought up over HTTPS on any machine with no
# domain and no external dependency — which is what makes the Phase 8 exit
# criterion verifiable rather than aspirational.
#
# A browser will warn on a self-signed certificate. That is correct behaviour and
# not something to work around. For a real deployment, replace the two files in
# certs/ with a certificate from a CA (Let's Encrypt, your organisation's PKI, or
# a cloud load balancer's) and restart nginx. Nothing else changes.

set -euo pipefail

CERT_DIR="${1:-certs}"
DAYS="${CERT_DAYS:-365}"
CN="${CERT_CN:-localhost}"

mkdir -p "$CERT_DIR"

if [[ -f "$CERT_DIR/fullchain.pem" && -f "$CERT_DIR/privkey.pem" ]]; then
  echo "Certificate already present in $CERT_DIR/ — leaving it alone."
  echo "Delete it first if you want a new one."
  exit 0
fi

openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "$CERT_DIR/privkey.pem" \
  -out    "$CERT_DIR/fullchain.pem" \
  -days   "$DAYS" \
  -subj   "/CN=$CN" \
  -addext "subjectAltName=DNS:$CN,DNS:localhost,IP:127.0.0.1" \
  2>/dev/null

chmod 600 "$CERT_DIR/privkey.pem"
chmod 644 "$CERT_DIR/fullchain.pem"

echo "Self-signed certificate written to $CERT_DIR/ (CN=$CN, ${DAYS} days)."
echo "  fullchain.pem  the certificate nginx serves"
echo "  privkey.pem    the private key — gitignored, never commit it"
