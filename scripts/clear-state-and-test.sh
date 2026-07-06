#!/usr/bin/env bash
# Clear the stored jackpot state for both lotteries, then trigger a run of the
# DEPLOYED scheduled (cron) handler and show its decision log.
#
# Usage:
#   scripts/clear-state-and-test.sh              # use the configured threshold
#   scripts/clear-state-and-test.sh 100          # override threshold to $100M for this run
#
# How it works: Cloudflare has no API to manually fire a cron trigger, and this
# account's workers.dev domain is behind Cloudflare Access, which blocks
# `wrangler dev --remote --test-scheduled` in non-interactive shells. So this
# script deploys a temporary config whose cron fires ~3 minutes from now (with
# JACKPOT_THRESHOLD optionally overridden), waits for Cloudflare to run it for
# real, captures the output via `wrangler tail`, then restores the original
# configuration with a normal deploy.
#
# The test run is the genuine article: deployed code, production KV, deployed
# secrets — a REAL push notification is sent if a jackpot crosses the
# (possibly overridden) threshold. With the state cleared, "previous" reads as
# 0, so anything above the threshold registers as a fresh crossing.
#
# Notes:
#   - Both deploys use the current working tree, so whatever code you have
#     checked out is what ends up deployed when the script finishes.
#   - If the script is killed hard (SIGKILL) between deploys, run
#     `npm run deploy` to restore the real cron and threshold.
set -euo pipefail

cd "$(dirname "$0")/.."

THRESHOLD_OVERRIDE="${1:-}"
if [ -n "$THRESHOLD_OVERRIDE" ] && ! [[ "$THRESHOLD_OVERRIDE" =~ ^[0-9]+$ ]]; then
	echo "Usage: $0 [threshold-override-in-millions]" >&2
	exit 1
fi

NAMESPACE_ID=$(sed -n 's/^id = "\(.*\)"/\1/p' wrangler.toml)
if [ -z "$NAMESPACE_ID" ]; then
	echo "Could not read KV namespace id from wrangler.toml" >&2
	exit 1
fi

echo "==> Clearing production KV state (namespace ${NAMESPACE_ID})"
for lottery in "Mega Millions" "Powerball"; do
	npx wrangler kv key delete "$lottery" --namespace-id "$NAMESPACE_ID" --remote
done

# Build a cron expression for ~3 minutes from now (UTC), truncated to the
# minute. Supports both BSD (macOS) and GNU date.
TARGET=$(($(date +%s) + 180))
if date -u -r "$TARGET" '+%M %H' >/dev/null 2>&1; then
	read -r MIN HR <<<"$(date -u -r "$TARGET" '+%M %H')"
else
	read -r MIN HR <<<"$(date -u -d "@${TARGET}" '+%M %H')"
fi
CRON="$((10#$MIN)) $((10#$HR)) * * *"

# Temporary config: same as wrangler.toml but with the one-shot cron (and the
# threshold override, if given). Must live in the repo root so the relative
# main = "src/index.js" path still resolves.
TMP_CONFIG=".wrangler.clear-state-and-test.$$.toml"
SED_ARGS=(-E -e "s|^crons = .*|crons = [\"${CRON}\"]|")
if [ -n "$THRESHOLD_OVERRIDE" ]; then
	SED_ARGS+=(-e "s|^JACKPOT_THRESHOLD = .*|JACKPOT_THRESHOLD = \"${THRESHOLD_OVERRIDE}\"|")
fi
sed "${SED_ARGS[@]}" wrangler.toml >"$TMP_CONFIG"

TAIL_LOG=$(mktemp "${TMPDIR:-/tmp}/lottocheck-test-run.XXXXXX")
TAIL_PID=""
RESTORED=""
restore() {
	if [ -n "$TAIL_PID" ]; then
		kill "$TAIL_PID" 2>/dev/null || true
		wait "$TAIL_PID" 2>/dev/null || true
		TAIL_PID=""
	fi
	if [ -z "$RESTORED" ]; then
		RESTORED=1
		echo "==> Restoring original configuration"
		npx wrangler deploy
	fi
	rm -f "$TMP_CONFIG"
}
trap restore EXIT

echo "==> Deploying temporary config (cron: \"${CRON}\" UTC$([ -n "$THRESHOLD_OVERRIDE" ] && echo ", threshold: \$${THRESHOLD_OVERRIDE}M"))"
npx wrangler deploy -c "$TMP_CONFIG"

echo "==> Tailing worker logs, waiting for the scheduled run (fires within ~3 minutes)"
npx wrangler tail --format pretty >"$TAIL_LOG" 2>&1 &
TAIL_PID=$!

DEADLINE=$((TARGET + 180))
found=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
	if grep -q "Starting jackpot check" "$TAIL_LOG"; then
		found=1
		break
	fi
	sleep 5
done

if [ -z "$found" ]; then
	echo "Scheduled run did not appear in the tail before the deadline." >&2
	echo "Tail output was:" >&2
	tail -n 20 "$TAIL_LOG" >&2
	exit 1
fi

# Let the rest of the run's logs arrive before disconnecting.
sleep 10

echo "==> Worker decision log"
grep -E 'Starting jackpot check|THRESHOLD CROSSED|Notification sent|Stored .* state|not configured|skipping|fetch failed|no notification|ALERT' "$TAIL_LOG" ||
	grep -v '^[[:space:]]*$' "$TAIL_LOG" | tail -n 20

restore
trap - EXIT
echo "==> Done"
