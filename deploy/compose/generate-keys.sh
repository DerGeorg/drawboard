#!/bin/sh
# Creates the three key files of the backend under ./keys - once, before the first start.
#   file_url_keys         signs the short-lived file URLs (32 random bytes, base64)
#   plugin_pseudonym_key  derives the user ids plugins see (32 random bytes, base64, a key of its own)
#   guest_signing_keys    signs guest-link sessions (EC P-256, PKCS#8 PEM)
# Existing files are never overwritten: new keys would end every signed URL and guest session.
# The folder is 0700 (other users on this host cannot list it); the files are 0444 because the
# backend reads them as its own user (uid 10001) through the bind mount.
set -eu
cd "$(dirname "$0")"
command -v openssl >/dev/null || { echo "openssl is needed" >&2; exit 1; }
umask 077
mkdir -p keys
chmod 700 keys
create() {
  if [ -s "keys/$1" ]; then echo "keys/$1 exists - kept"; return; fi
  "$2" > "keys/$1.tmp" && mv "keys/$1.tmp" "keys/$1" && chmod 444 "keys/$1" && echo "keys/$1 created"
}
random32() { openssl rand -base64 32; }
ec_p256() { openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt; }
create file_url_keys random32
create plugin_pseudonym_key random32
create guest_signing_keys ec_p256
