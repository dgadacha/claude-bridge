#!/usr/bin/env node
/**
 * Claude Bridge : serveur local qui transforme les messages captés par
 * l'extension en fichiers .md lisibles depuis une conversation Claude Code.
 * Zéro dépendance, écoute uniquement sur 127.0.0.1.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const runner = require('./runner');

const PORT = Number(process.env.PORT || 8795);
const OUTPUT_DIR =
  process.env.OUTPUT_DIR || path.join(os.homedir(), 'Documents', 'teams-inbox');
const INDEX_FILE = path.join(OUTPUT_DIR, 'INBOX.md');
const OUTBOX_DIR = path.join(OUTPUT_DIR, '_outbox');
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const UI_FILE = path.join(__dirname, 'ui.html');
const PROJECTS_FILE = process.env.PROJECTS_FILE || path.join(__dirname, '..', 'projects.json');
const SETTINGS_FILE = path.join(OUTPUT_DIR, '_settings.json');
const SUGGEST_ROOT = process.env.SUGGEST_ROOT || path.join(os.homedir(), 'Documents');

/**
 * Seule l'extension parle à ce serveur depuis un autre contexte. Une page web
 * quelconque ne doit pas pouvoir déposer une question ou réécrire le mapping des
 * projets : on n'accorde les en-têtes CORS qu'aux origines `chrome-extension://`.
 */
function cors(req) {
  const origin = req.headers.origin;
  if (!origin) return {}; // curl, CLI, requêtes same-origin sans origine
  const isExtension = /^(chrome|moz)-extension:\/\//.test(origin);
  // La page de configuration est servie par ce serveur : elle envoie sa propre origine.
  const isSelf = origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
  if (!isExtension && !isSelf) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    Vary: 'Origin',
  };
}

const slugify = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'question';

/** Nom de projet sûr : pas d'échappement hors du dossier de sortie. */
const safeProject = (s) => slugify(String(s || 'inbox')) || 'inbox';

function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return {
    day: `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`,
    time: `${p(date.getHours())}${p(date.getMinutes())}`,
    human: date.toLocaleString('fr-FR'),
  };
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** Le mime annoncé n'est pas fiable : on lit la signature des octets. */
function sniff(buf, fallback) {
  if (buf.length > 8 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 6 && buf.toString('ascii', 0, 6).startsWith('GIF8')) return 'gif';
  if (buf.length > 12 && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return fallback;
}

/**
 * Écrit les captures dans `<projet>/captures/` et renvoie de quoi les référencer
 * depuis le markdown. Une image que l'extension n'a pas pu lire ne garde que son URL.
 */
function writeImages(dir, base, images) {
  const refs = [];
  (images || []).forEach((im, i) => {
    if (im && im.dataUrl) {
      const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(im.dataUrl);
      if (!m) return;
      const bytes = Buffer.from(m[2], 'base64');
      const ext = sniff(bytes, EXT[m[1]]);
      if (!ext) {
        console.warn(`capture ignorée : format non reconnu (${m[1]})`);
        return;
      }
      const name = `${base}-${i + 1}.${ext}`;
      const shots = path.join(dir, 'captures');
      fs.mkdirSync(shots, { recursive: true });
      fs.writeFileSync(path.join(shots, name), bytes);
      refs.push({ rel: `captures/${name}`, alt: im.alt || '' });
    } else if (im && im.url) {
      refs.push({ url: im.url, alt: im.alt || '' });
    }
  });
  return refs;
}

function write(entry) {
  const now = new Date();
  const { day, time, human } = stamp(now);
  const project = safeProject(entry.project);
  const dir = path.join(OUTPUT_DIR, project);
  fs.mkdirSync(dir, { recursive: true });

  let file = path.join(dir, `${day}-${time}-${slugify(entry.question)}.md`);
  let n = 2;
  while (fs.existsSync(file)) {
    file = path.join(dir, `${day}-${time}-${slugify(entry.question)}-${n++}.md`);
  }

  const author = String(entry.author || 'inconnu').replace(/"/g, "'");
  // Le tag n'ouvre pas toujours le message : si du texte le précède, il porte
  // souvent le contexte, on garde donc le message brut en plus de la question.
  const contextual = Boolean(entry.prefix && entry.raw);
  const base = path.basename(file, '.md');
  const shots = writeImages(dir, base, entry.images);
  const shotsMd = shots.length
    ? [
        '## Captures',
        '',
        ...shots.map((s) =>
          s.rel
            ? `![${s.alt || 'capture'}](${s.rel})`
            : `- capture non récupérée : ${s.url}`
        ),
        '',
      ].join('\n')
    : null;
  const md = [
    '---',
    `auteur: "${author}"`,
    `projet: ${project}`,
    `recu: ${now.toISOString()}`,
    'statut: nouveau',
    entry.channel ? `canal: "${String(entry.channel).replace(/"/g, "'")}"` : null,
    entry.url ? `source: ${entry.url}` : null,
    '---',
    '',
    `# Question de ${author}`,
    '',
    entry.question.trim(),
    '',
    shotsMd,
    contextual ? '## Message complet\n' : null,
    contextual ? String(entry.raw).trim() : null,
    contextual ? '' : null,
  ]
    .filter((l) => l !== null)
    .join('\n');

  fs.writeFileSync(file, md, 'utf8');

  const rel = path.relative(OUTPUT_DIR, file);
  if (!fs.existsSync(INDEX_FILE)) {
    fs.writeFileSync(
      INDEX_FILE,
      '# Questions Teams en attente\n\nUne ligne par question captée. Coche quand c\'est répondu.\n\n',
      'utf8'
    );
  }
  const shotTag = shots.length ? ` · 📎 ${shots.length}` : '';
  fs.appendFileSync(
    INDEX_FILE,
    `- [ ] **${human}** · ${author} · \`#${project}\`${shotTag} — ${entry.question
      .replace(/\s+/g, ' ')
      .slice(0, 120)} → [${rel}](${rel})\n`,
    'utf8'
  );

  return { file, rel, shots: shots.length };
}

/* -------------------------------------------------------- configuration --- */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readProjects() {
  const all = readJson(PROJECTS_FILE, {});
  const out = {};
  for (const [tag, dir] of Object.entries(all)) {
    if (!tag.startsWith('_')) out[tag] = dir;
  }
  return out;
}

/** N'enregistre que des dossiers qui existent : le mapping pilote où Claude travaille. */
function writeProjects(projects) {
  const clean = {};
  for (const [rawTag, rawDir] of Object.entries(projects || {})) {
    const tag = String(rawTag).trim().toLowerCase();
    const dir = String(rawDir).trim();
    if (!tag || !dir) continue;
    if (tag.startsWith('_')) throw new Error(`nom de projet réservé : ${tag}`);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`dossier introuvable pour #${tag} : ${dir}`);
    }
    clean[tag] = dir;
  }
  const previous = readJson(PROJECTS_FILE, {});
  const doc = previous._doc
    ? { _doc: previous._doc }
    : { _doc: 'Correspondance entre le tag #projet utilisé dans Teams et le dossier de code.' };
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify({ ...doc, ...clean }, null, 2), 'utf8');
  return clean;
}

/** Dossiers de ~/Documents qui ressemblent à des projets, pour l'autocomplétion. */
function suggestProjects() {
  try {
    return fs
      .readdirSync(SUGGEST_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => path.join(SUGGEST_ROOT, e.name))
      .filter((dir) =>
        ['.git', 'CLAUDE.md', 'package.json', 'composer.json', 'pubspec.yaml'].some((marker) =>
          fs.existsSync(path.join(dir, marker))
        )
      )
      .sort();
  } catch {
    return [];
  }
}

const DEFAULT_ACK = "Bien reçu, je regarde ça et je reviens vers toi.";

/** Message envoyé dès qu'une question part en traitement. Vide = pas d'accusé. */
function ackText() {
  const settings = readSettings();
  return settings.ackText === undefined ? DEFAULT_ACK : String(settings.ackText).trim();
}

function readSettings() {
  return readJson(SETTINGS_FILE, {});
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** Frontmatter des questions les plus récentes, pour la page de config. */
function recentQuestions(limit = 15) {
  return listQuestions()
    .map(({ project, file }) => {
      const md = fs.readFileSync(file, 'utf8');
      const field = (name) => {
        const m = md.match(new RegExp(`^${name}: (.*)$`, 'm'));
        return m ? m[1].replace(/^"|"$/g, '') : '';
      };
      const body = md.split(/^# .*$/m)[1] || '';
      return {
        project,
        file: path.relative(OUTPUT_DIR, file),
        author: field('auteur') || 'inconnu',
        statut: field('statut') || 'nouveau',
        recu: field('recu'),
        question: body.trim().split('\n')[0].slice(0, 140),
      };
    })
    .sort((a, b) => String(b.recu).localeCompare(String(a.recu)))
    .slice(0, limit);
}

/* ---------------------------------------------------------------- outbox --- */

function outboxFiles() {
  if (!fs.existsSync(OUTBOX_DIR)) return [];
  return fs
    .readdirSync(OUTBOX_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(OUTBOX_DIR, f));
}

function readReply(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Réponses en attente d'envoi, sans les octets des pièces jointes. */
function pendingReplies() {
  return outboxFiles()
    .map(readReply)
    .filter((r) => r && r.status === 'pending')
    .map((r) => ({
      id: r.id,
      project: r.project,
      channel: r.channel || null,
      text: r.text,
      createdAt: r.createdAt,
      question: r.question || null,
      attachments: (r.attachments || []).map((a) => ({ name: a.name, size: a.size })),
    }));
}

function createReply(body) {
  if (!body.text || !String(body.text).trim()) throw new Error('texte de réponse vide');

  const attachments = [];
  for (const raw of body.attachments || []) {
    const file = path.resolve(String(raw));
    if (!fs.existsSync(file)) throw new Error(`pièce jointe introuvable : ${file}`);
    const size = fs.statSync(file).size;
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`pièce jointe trop lourde (${Math.round(size / 1e6)} Mo) : ${file}`);
    }
    attachments.push({ name: path.basename(file), path: file, size });
  }

  const now = new Date();
  const { day, time } = stamp(now);
  const project = safeProject(body.project);
  const id = `${day}-${time}-${project}-${outboxFiles().length + 1}`;
  const reply = {
    id,
    project,
    channel: body.channel || null,
    text: String(body.text),
    question: body.question || null,
    attachments,
    status: 'pending',
    createdAt: now.toISOString(),
  };

  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTBOX_DIR, `${id}.json`), JSON.stringify(reply, null, 2), 'utf8');
  return reply;
}

/** Les octets d'une pièce jointe, encodés pour le passage par l'extension. */
function replyPayload(id) {
  const file = path.join(OUTBOX_DIR, `${path.basename(String(id))}.json`);
  const reply = fs.existsSync(file) ? readReply(file) : null;
  if (!reply) return null;
  return {
    ...reply,
    attachments: (reply.attachments || []).map((a) => ({
      name: a.name,
      size: a.size,
      base64: fs.existsSync(a.path) ? fs.readFileSync(a.path).toString('base64') : null,
    })),
  };
}

/** Marque la réponse envoyée et referme la question correspondante. */
function markSent(id) {
  const file = path.join(OUTBOX_DIR, `${path.basename(String(id))}.json`);
  const reply = fs.existsSync(file) ? readReply(file) : null;
  if (!reply) return null;

  reply.status = 'sent';
  reply.sentAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(reply, null, 2), 'utf8');

  if (reply.question) {
    const qFile = path.isAbsolute(reply.question)
      ? reply.question
      : path.join(OUTPUT_DIR, reply.question);
    if (fs.existsSync(qFile)) {
      const md = fs.readFileSync(qFile, 'utf8').replace(/^statut: .*$/m, 'statut: repondu');
      fs.writeFileSync(qFile, md, 'utf8');
      const rel = path.relative(OUTPUT_DIR, qFile);
      if (fs.existsSync(INDEX_FILE)) {
        const index = fs
          .readFileSync(INDEX_FILE, 'utf8')
          .split('\n')
          .map((line) => (line.includes(rel) ? line.replace('- [ ]', '- [x]') : line))
          .join('\n');
        fs.writeFileSync(INDEX_FILE, index, 'utf8');
      }
    }
  }
  return reply;
}

function listQuestions() {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  const out = [];
  for (const project of fs.readdirSync(OUTPUT_DIR)) {
    const dir = path.join(OUTPUT_DIR, project);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      out.push({ project, file: path.join(dir, name) });
    }
  }
  return out;
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

/** Corps JSON d'une requête, avec une limite pour ne pas se faire noyer. */
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > limit) {
        req.destroy();
        reject(new Error('corps trop volumineux'));
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('JSON invalide'));
      }
    });
  });
}

const server = http.createServer((req, res) => {
  const headers = cors(req);
  if (headers === null) {
    // Pas d'en-têtes CORS ici : le navigateur bloquera la lecture de la réponse.
    return send(res, 403, { error: 'origine non autorisée' });
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    return res.end();
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const json = (code, body) => send(res, code, body, headers);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return fs.readFile(UI_FILE, (err, data) => {
      if (err) return json(500, { error: 'page de configuration illisible' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }

  if (req.method === 'GET' && url.pathname === '/state') {
    return json(200, {
      ok: true,
      port: PORT,
      outputDir: OUTPUT_DIR,
      autorun: runner.autorun(OUTPUT_DIR),
      model: runner.model(OUTPUT_DIR),
      effort: runner.effort(OUTPUT_DIR),
      ackText: ackText(),
      projects: readProjects(),
      suggestions: suggestProjects(),
      questions: recentQuestions(),
      replies: pendingReplies(),
      runs: runner.runs,
    });
  }

  if (req.method === 'GET' && url.pathname === '/check-dir') {
    const dir = url.searchParams.get('path') || '';
    const exists = Boolean(dir) && fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    return json(200, { path: dir, exists });
  }

  if (req.method === 'GET' && url.pathname === '/projects') {
    return json(200, { projects: readProjects(), suggestions: suggestProjects() });
  }

  if (req.method === 'PUT' && url.pathname === '/projects') {
    return readBody(req)
      .then((body) => {
        const saved = writeProjects(body.projects);
        console.log(`mapping des projets mis à jour (${Object.keys(saved).length} projet(s))`);
        json(200, { ok: true, projects: saved });
      })
      .catch((e) => json(400, { error: String(e.message || e) }));
  }

  if (req.method === 'POST' && url.pathname === '/settings') {
    return readBody(req)
      .then((body) => {
        const patch = {};
        if ('autorun' in body) patch.autorun = Boolean(body.autorun);
        if ('model' in body) patch.model = String(body.model);
        if ('effort' in body) patch.effort = String(body.effort);
        if ('ackText' in body) patch.ackText = String(body.ackText);
        const next = writeSettings(patch);
        console.log(
          `réglages : traitement ${next.autorun === false ? 'manuel' : 'automatique'},` +
            ` modèle ${next.model || 'défaut'}, effort ${next.effort || 'défaut'}`
        );
        json(200, { ok: true, settings: next });
      })
      .catch((e) => json(400, { error: String(e.message || e) }));
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(200, {
      ok: true,
      outputDir: OUTPUT_DIR,
      count: listQuestions().length,
      pendingReplies: pendingReplies().length,
      autorun: runner.autorun(OUTPUT_DIR),
    });
  }

  if (req.method === 'GET' && url.pathname === '/runs') {
    return json(200, { autorun: runner.autorun(OUTPUT_DIR), runs: runner.runs });
  }

  if (req.method === 'GET' && url.pathname === '/questions') {
    return json(200, { questions: listQuestions() });
  }

  if (req.method === 'GET' && url.pathname === '/outbox') {
    return json(200, { replies: pendingReplies() });
  }

  const detail = url.pathname.match(/^\/outbox\/([^/]+)$/);
  if (req.method === 'GET' && detail) {
    const payload = replyPayload(detail[1]);
    return payload
      ? json(200, payload)
      : json(404, { error: 'réponse inconnue' });
  }

  const sent = url.pathname.match(/^\/outbox\/([^/]+)\/sent$/);
  if (req.method === 'POST' && sent) {
    const reply = markSent(sent[1]);
    if (reply) console.log(`[${new Date().toLocaleTimeString('fr-FR')}] réponse ${reply.id} envoyée`);
    return reply ? json(200, { ok: true }) : json(404, { error: 'réponse inconnue' });
  }

  if (req.method === 'POST' && url.pathname === '/reply') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        const reply = createReply(JSON.parse(raw));
        const joints = reply.attachments.map((a) => a.name).join(', ');
        console.log(
          `[${new Date().toLocaleTimeString('fr-FR')}] réponse en attente ${reply.id}` +
            (joints ? ` (+ ${joints})` : '')
        );
        json(200, { ok: true, id: reply.id, attachments: reply.attachments.length });
      } catch (e) {
        json(400, { error: String(e.message || e) });
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/message') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 25e6) req.destroy(); // les captures voyagent en base64
    });
    req.on('end', () => {
      try {
        const entry = JSON.parse(raw);
        if (!entry.question) return json(400, { error: 'question manquante' });
        const { file, rel, shots } = write(entry);
        const tag = shots ? ` (+${shots} capture${shots > 1 ? 's' : ''})` : '';
        console.log(`[${new Date().toLocaleTimeString('fr-FR')}] ${entry.author || '?'} → ${rel}${tag}`);
        json(200, { ok: true, file: rel, shots });

        // Traitement par une session Claude Code lancée dans le dossier du projet.
        const project = safeProject(entry.project);
        runner.enqueue({
          project,
          questionFile: file,
          outputDir: OUTPUT_DIR,
          author: entry.author,
          channel: entry.channel,
          ack: () => {
            const texte = ackText();
            if (!texte) return;
            createReply({ project, text: texte, channel: entry.channel });
            console.log(`[${new Date().toLocaleTimeString('fr-FR')}] accusé de réception déposé`);
          },
        });
      } catch (e) {
        console.error('écriture impossible', e);
        json(500, { error: String(e.message || e) });
      }
    });
    return;
  }

  json(404, { error: 'route inconnue' });
});

server.listen(PORT, '127.0.0.1', () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`Claude Bridge : écoute sur http://127.0.0.1:${PORT}`);
  console.log(`Questions écrites dans ${OUTPUT_DIR}`);
});
