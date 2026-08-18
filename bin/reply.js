#!/usr/bin/env node
/**
 * Dépose une réponse (texte + pièces jointes) dans la file d'attente du pont
 * Teams. L'extension Chrome la prépare ensuite dans le canal.
 *
 *   node bin/reply.js --project monprojet --text-file reponse.md --attach dist/plugin.zip
 *   node bin/reply.js --project monprojet --text "c'est corrigé en 1.4.2" \
 *        --question monprojet/2026-08-18-1432-le-solde.md
 */

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const opts = { attachments: [] };

for (let i = 0; i < args.length; i++) {
  const next = () => args[++i];
  switch (args[i]) {
    case '--project': opts.project = next(); break;
    case '--text': opts.text = next(); break;
    case '--text-file': opts.text = fs.readFileSync(next(), 'utf8'); break;
    case '--attach': opts.attachments.push(path.resolve(next())); break;
    case '--question': opts.question = next(); break;
    case '--channel': opts.channel = next(); break;
    case '--port': opts.port = Number(next()); break;
    case '-h':
    case '--help': opts.help = true; break;
    default:
      console.error(`option inconnue : ${args[i]}`);
      process.exit(2);
  }
}

if (opts.help || !opts.text || !opts.project) {
  console.log(`usage : reply.js --project <nom> (--text "…" | --text-file <fichier>)
                [--attach <fichier>]… [--question <fichier.md>] [--channel <nom>] [--port 8795]`);
  process.exit(opts.help ? 0 : 2);
}

const port = opts.port || Number(process.env.PORT) || 8795;

fetch(`http://127.0.0.1:${port}/reply`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(opts),
})
  .then(async (res) => {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `serveur ${res.status}`);
    const joints = data.attachments ? ` (+${data.attachments} pièce(s) jointe(s))` : '';
    console.log(`réponse ${data.id} en attente d'envoi${joints}`);
    console.log("→ ouvre l'onglet Teams : l'extension la prépare dans le canal.");
  })
  .catch((e) => {
    console.error(`échec : ${e.message}`);
    console.error('le serveur est-il lancé ? (claude-bridge/start.sh)');
    process.exit(1);
  });
