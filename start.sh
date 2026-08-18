#!/usr/bin/env bash
# Lance le serveur local Claude Bridge.
set -e
cd "$(dirname "$0")"
export PORT="${PORT:-8795}"
export OUTPUT_DIR="${OUTPUT_DIR:-$HOME/Documents/teams-inbox}"
# AUTORUN=0 désactive le traitement automatique (retour au /teams manuel).
export AUTORUN="${AUTORUN:-1}"
exec node server/server.js
