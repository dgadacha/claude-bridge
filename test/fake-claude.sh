#!/usr/bin/env bash
# Faux binaire `claude` pour tester le runner sans lancer de vraie session :
# il enregistre ses arguments et imite la sortie --output-format json.
printf '%s\n' "$@" > "${FAKE_CLAUDE_ARGS:-/tmp/fake-claude-args.txt}"
echo "cwd=$PWD" >> "${FAKE_CLAUDE_ARGS:-/tmp/fake-claude-args.txt}"
cat <<JSON
{"type":"result","subtype":"success","is_error":false,"session_id":"11111111-2222-3333-4444-555555555555","result":"J'ai lu la question, corrigé le filtre de stock et déposé la réponse."}
JSON
