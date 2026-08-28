#!/usr/bin/env bash
# Clean-checkout verifier. Its ordered commands intentionally mirror README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

cleanup_on_failure() {
  local status=$?
  if [ "$status" -ne 0 ]; then docker compose down --remove-orphans >/dev/null 2>&1 || true; fi
  exit "$status"
}
trap cleanup_on_failure EXIT

command -v docker >/dev/null || { echo "blocked: docker is required for ./scripts/verify.sh" >&2; exit 1; }
docker compose version >/dev/null

npm install
npm run build
npm test
npm --prefix web run build
./e2e/browser-journey.sh

docker compose up --build -d
for _attempt in $(seq 1 30); do
  if SMARTNOTES_URL=http://localhost:8787 npm run health; then break; fi
  sleep 1
done
SMARTNOTES_URL=http://localhost:8787 npm run health

if command -v xcrun >/dev/null && [ -x /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc ]; then
  ./ipad/Scripts/build-and-test.sh --ios --app
else
  echo "SKIPPED (platform-blocked): ./ipad/Scripts/build-and-test.sh --ios --app (Xcode/iOS toolchain unavailable)"
fi

trap - EXIT
echo "verification complete: http://localhost:8080 (stack remains running)"
