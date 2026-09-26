#!/usr/bin/env bash
#
# One-shot provisioning for the demo-fork box. Ubuntu 24.04, run as a sudo-capable user:
#
#     sudo ./infra/bootstrap.sh fork.yourdomain.com
#
# Idempotent — safe to re-run after editing units or pulling new code.
#
# Assumes, and checks, that DNS for the hostname already points at this box. Caddy's HTTP-01
# challenge needs that plus inbound :80, and failing here with a clear message beats failing
# later inside Caddy's retry loop.
set -euo pipefail

# Hostname is optional: without it everything is provisioned except TLS, so the box can be built
# before DNS exists or before the security group opens :80. Re-run later with the hostname to
# finish the Caddy step.
HOST="${1:-}"
if [[ $EUID -ne 0 ]]; then
  echo "error: run with sudo" >&2
  exit 1
fi

REPO="${REPO:-https://github.com/chandrabosep/eth-tokyo.git}"
ROOT=/opt/recycled
FOUNDRY_VERSION="${FOUNDRY_VERSION:-1.7.1}"

echo "==> packages"
apt-get update -qq
apt-get install -y -qq curl git python3 debian-keyring debian-archive-keyring apt-transport-https

echo "==> node 20"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
node --version

echo "==> caddy"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

echo "==> service user"
id -u recycled >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash recycled

echo "==> repo at $ROOT"
if [[ -f "$ROOT/foundry.toml" && ! -d "$ROOT/.git" ]]; then
  echo "    found a non-git working tree (rsync'd) — leaving it alone"
  chown -R recycled:recycled "$ROOT"
elif [[ -d "$ROOT/.git" ]]; then
  su - recycled -c "cd $ROOT && git pull --ff-only"
else
  mkdir -p "$ROOT"
  chown recycled:recycled "$ROOT"
  su - recycled -c "git clone --depth 1 $REPO $ROOT"
fi

echo "==> foundry $FOUNDRY_VERSION"
# Pinned, not latest. Deploy.s.sol mines the hook address against the CREATE2 proxy at
# 0x4e59b448..., which is where `forge script` routes a salted `new` during broadcast. Foundry
# 1.8.x does not route it there, so the hook lands at an address whose low bits do not encode its
# permission flags and v4 rejects it with HookAddressNotValid. Until the script is made explicit
# about the deployer, the toolchain has to match the one this was built against.
su - recycled -c 'command -v ~/.foundry/bin/foundryup >/dev/null 2>&1 || curl -L https://foundry.paradigm.xyz | bash'
su - recycled -c "~/.foundry/bin/foundryup --install $FOUNDRY_VERSION" >/dev/null
su - recycled -c "~/.foundry/bin/forge --version"
su - recycled -c "cd $ROOT && ~/.foundry/bin/forge build" >/dev/null

echo "==> /etc/recycled/env"
mkdir -p /etc/recycled
if [[ ! -f /etc/recycled/env ]]; then
  cat > /etc/recycled/env <<'ENV'
# RPC used to fork Base. A public endpoint is rate-limited and makes anvil's first sync slow;
# an Alchemy/Infura URL is much better. This file is NOT in git — keep the key here only.
BASE_RPC_URL=https://mainnet.base.org
FORK_BLOCK=51698307
ENV
  echo "    wrote a default — put your Infura URL in /etc/recycled/env before going live"
fi
chmod 600 /etc/recycled/env
chown recycled:recycled /etc/recycled/env

echo "==> sudoers for the reset job"
# reset.sh restarts units it does not own. Scope the grant to exactly those three verbs.
cat > /etc/sudoers.d/recycled-reset <<'SUDO'
recycled ALL=(root) NOPASSWD: /usr/bin/systemctl stop recycled-anvil.service, /usr/bin/systemctl start recycled-anvil.service, /usr/bin/systemctl restart recycled-gateway.service
SUDO
chmod 440 /etc/sudoers.d/recycled-reset
visudo -cf /etc/sudoers.d/recycled-reset >/dev/null

echo "==> systemd units"
install -m 644 "$ROOT"/infra/systemd/*.service /etc/systemd/system/
install -m 644 "$ROOT"/infra/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now recycled-anvil.service
systemctl enable --now recycled-gateway.service
systemctl enable --now recycled-reset.timer
systemctl enable --now recycled-churn.timer
# The watchdog that redeploys after an OOM kill or a reboot. Installed since it was written but
# never enabled, so until now it only ran when someone started it by hand.
systemctl enable --now recycled-ensure.timer

if [[ -z "$HOST" ]]; then
  echo "==> caddy SKIPPED (no hostname given)"
  echo "    the node is up but reachable only from this box. Finish with:"
  echo "      sudo $ROOT/infra/bootstrap.sh fork.yourdomain.com"
else
  echo "==> caddy for $HOST"
  RESOLVED=$(getent hosts "$HOST" | awk '{print $1}' | head -1 || true)
  PUBLIC=$(curl -fsS --max-time 5 https://checkip.amazonaws.com || echo "")
  if [[ -n "$RESOLVED" && -n "$PUBLIC" && "$RESOLVED" != "$PUBLIC" ]]; then
    echo "    warning: $HOST resolves to $RESOLVED but this box is $PUBLIC"
    echo "             Caddy will not get a certificate until that A record is right."
  fi
  sed "s/fork\.example\.com/$HOST/" "$ROOT/infra/Caddyfile" > /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
fi

echo "==> first build of the chain"
su - recycled -c "ROOT=$ROOT $ROOT/infra/reset.sh"

BASE_URL="${HOST:+https://$HOST}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8546 (local only — no hostname yet)}"

cat <<EOF

==> done.

   RPC      $BASE_URL
   Faucet   $BASE_URL/faucet      POST { "address": "0x..." }
   Health   $BASE_URL/health

   Check it:
     curl -s $BASE_URL/health
     curl -s $BASE_URL -X POST -H 'content-type: application/json' \\
       --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
     curl -s $BASE_URL -X POST -H 'content-type: application/json' \\
       --data '{"jsonrpc":"2.0","id":1,"method":"anvil_setBalance","params":[]}'   # must be refused

   Then set on Vercel:
     NEXT_PUBLIC_FORK_RPC_URL=$BASE_URL
     NEXT_PUBLIC_FORK_FAUCET_URL=$BASE_URL/faucet
EOF
