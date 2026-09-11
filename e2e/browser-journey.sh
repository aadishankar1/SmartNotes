#!/usr/bin/env bash
# The web test is a deterministic browser journey: it runs the production web
# modules with a browser-compatible IndexedDB/fetch shim against the real API.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
npm run test:server
npm --prefix web test
