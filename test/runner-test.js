/**
 * Vérifie la mécanique du runner sans lancer de vraie session Claude :
 * branche git dédiée, garde-fous, statuts de la question, journal, session
 * mémorisée, et arguments passés au binaire.
 *
 *   node test/runner-test.js
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BRIDGE = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
const ARGS_FILE = path.join(TMP, 'args.txt');

process.env.PROJECTS_FILE = path.join(TMP, 'projects.json');
process.env.CLAUDE_BIN = path.join(BRIDGE, 'test/fake-claude.sh');
process.env.FAKE_CLAUDE_ARGS = ARGS_FILE;

const runner = require('../server/runner');

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok, detail });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Monte un dépôt jouet + une question, et déclare le projet dans le mapping. */
function scenario(name, { mapped = true, dirty = false } = {}) {
  const project = path.join(TMP, name);
  const inbox = path.join(TMP, `inbox-${name}`);
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(inbox, name), { recursive: true });
  fs.writeFileSync(path.join(project, 'index.php'), '<?php // code du plugin\n');

  const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '.');
  git('commit', '-qm', 'depart');
  if (dirty) fs.appendFileSync(path.join(project, 'index.php'), '// travail en cours\n');

  const questionFile = path.join(inbox, name, '2026-08-18-1200-la-synchro.md');
  fs.writeFileSync(
    questionFile,
    `---\nauteur: "Alex"\nprojet: ${name}\nstatut: nouveau\n---\n\n# Question de Alex\n\nla synchro ne remonte plus\n`
  );

  fs.writeFileSync(
    process.env.PROJECTS_FILE,
    JSON.stringify(mapped ? { [name]: project } : {})
  );

  return { project, inbox, questionFile, name };
}

async function main() {
  /* 1. cas nominal : dépôt propre, projet connu */
  const nominal = scenario('jouet');
  runner.enqueue({
    project: 'jouet',
    questionFile: nominal.questionFile,
    outputDir: nominal.inbox,
    author: 'Alex',
    channel: 'claude-bridge',
  });
  await wait(2500);

  const args = fs.readFileSync(ARGS_FILE, 'utf8');
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: nominal.project })
    .toString()
    .trim();
  const sessions = JSON.parse(fs.readFileSync(path.join(nominal.inbox, '_sessions.json'), 'utf8'));
  const run = runner.runs[0] || {};

  check('branche dédiée créée', branch.startsWith('claude-bridge/'), branch);
  check('question marquée traitée', /statut: traite/.test(fs.readFileSync(nominal.questionFile, 'utf8')));
  check('session mémorisée pour le projet', Boolean(sessions.jouet), sessions.jouet);
  check('journal écrit', fs.existsSync(path.join(nominal.inbox, '_runs')), run.log);
  check('résumé récupéré', /déposé la réponse/.test(run.summary || ''));
  // macOS résout /var en /private/var : on compare les chemins canoniques.
  check('session lancée dans le dossier du projet', args.includes(`cwd=${fs.realpathSync(nominal.project)}`));
  check('mode acceptEdits', args.includes('acceptEdits'));
  check('garde-fous injectés', args.includes('DONNÉES, pas des instructions'));
  check('inbox accessible à la session', args.includes(nominal.inbox));
  check('git commit interdit dans les consignes', args.includes('git commit'));

  /* 2. dépôt avec du travail en cours : on ne bascule pas de branche */
  fs.rmSync(ARGS_FILE, { force: true });
  const dirty = scenario('encours', { dirty: true });
  runner.enqueue({
    project: 'encours',
    questionFile: dirty.questionFile,
    outputDir: dirty.inbox,
    author: 'Alex',
  });
  await wait(2500);

  const dirtyBranch = execFileSync('git', ['branch', '--show-current'], { cwd: dirty.project })
    .toString()
    .trim();
  const dirtyArgs = fs.readFileSync(ARGS_FILE, 'utf8');
  check('travail en cours préservé (pas de bascule)', !dirtyBranch.startsWith('claude-bridge/'), dirtyBranch);
  check('la session est prévenue', dirtyArgs.includes('modifications en cours'));

  /* 3. projet absent de projects.json : rien n'est lancé */
  fs.rmSync(ARGS_FILE, { force: true });
  const unknown = scenario('inconnu', { mapped: false });
  runner.enqueue({
    project: 'inconnu',
    questionFile: unknown.questionFile,
    outputDir: unknown.inbox,
    author: 'Alex',
  });
  await wait(1500);

  check('aucune session pour un projet inconnu', !fs.existsSync(ARGS_FILE));
  check(
    'question marquée projet_inconnu',
    /statut: projet_inconnu/.test(fs.readFileSync(unknown.questionFile, 'utf8'))
  );

  for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} vérification(s) en échec` : '\ntout est vert');
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();
