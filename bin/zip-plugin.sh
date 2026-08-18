#!/usr/bin/env bash
# Fabrique le .zip d'un plugin/livrable à joindre à une réponse Teams.
#
#   bin/zip-plugin.sh /chemin/vers/mon-projet mon-plugin-1.4.2 \
#     --exclude 'tests/*' --exclude 'docker-compose.yml'
#
# Le zip est écrit dans /tmp et son chemin est affiché (à passer à reply.js --attach).
set -euo pipefail

src="${1:?usage: zip-plugin.sh <dossier> [nom] [--exclude motif]...}"
name="${2:-$(basename "$src")}"
shift 2 2>/dev/null || shift 1

excludes=(-x '*.git/*' -x '*/node_modules/*' -x '*.DS_Store' -x '*.zip')
while [ $# -gt 0 ]; do
  case "$1" in
    --exclude) excludes+=(-x "$2"); shift 2 ;;
    *) echo "option inconnue : $1" >&2; exit 2 ;;
  esac
done

out="/tmp/${name}.zip"
rm -f "$out"
cd "$(dirname "$src")"
zip -qr "$out" "$(basename "$src")" "${excludes[@]}"
echo "$out"
ls -lh "$out" | awk '{print "  " $5}'
