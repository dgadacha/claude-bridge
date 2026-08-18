/** Claude Bridge : filtrage, dédoublonnage, notification et envoi au serveur local. */

const DEFAULT_CONFIG = {
  enabled: true,
  trigger: '#claude',
  channels: ['claude-bridge'], // vide = toutes les conversations
  // Dans un canal dédié, tout ce qui est posté est pour Claude : le tag déclencheur
  // ne sert que si le canal est partagé avec d'autres échanges.
  requireTag: false,
  authors: [],                 // vide = tous les auteurs
  sound: true,
  notify: true,
  forward: true,
  images: true,      // récupérer les captures d'écran jointes
  autoSend: false,   // false = la réponse est préparée, c'est moi qui clique Envoyer
  port: 8795,
  watchList: true, // pinger aussi sur les aperçus non lus de la liste de conversations
  maxAgeMin: 15,   // au-delà, un message est de l'historique rechargé
  debug: false,
};

const MAX_SEEN = 500;
const MAX_LOG = 50;
const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;

async function getConfig() {
  const { config } = await chrome.storage.sync.get('config');
  return { ...DEFAULT_CONFIG, ...(config || {}) };
}

function authorMatches(author, authors) {
  if (!authors || authors.length === 0) return true;
  const a = (author || '').toLowerCase();
  return authors.some((name) => a.includes(String(name).toLowerCase().trim()));
}

/** `#claude #monprojet la question…` → { project: 'monprojet', question: 'la question…' } */
function parse(body, trigger) {
  const lower = body.toLowerCase();
  const at = lower.indexOf(trigger.toLowerCase());
  // Sans tag (canal dédié), tout le message est la question et le projet vient
  // du premier hashtag s'il y en a un.
  const after = at === -1 ? body : body.slice(at + trigger.length);

  const prefix = at === -1 ? '' : body.slice(0, at).trim();
  let project = 'inbox';
  const nextTag = after.match(at === -1 ? /\s*#([\p{L}\p{N}_-]+)/u : /^\s*#([\p{L}\p{N}_-]+)/u);
  let question = after;
  if (nextTag) {
    project = nextTag[1].toLowerCase();
    question = at === -1 ? after.replace(nextTag[0], ' ') : after.slice(nextTag[0].length);
  }
  question = question.trim();
  if (!question) question = body.trim();
  return { project, question, prefix };
}

/**
 * Deux garde-fous contre les doublons, qui survivent au rechargement de l'onglet :
 * l'identifiant du message, et une empreinte du contenu — Teams expose parfois le
 * même message sous deux identifiants, et l'identifiant seul ne suffit pas.
 */
async function remember(id, fingerprint) {
  const { seen = [], recent = [] } = await chrome.storage.local.get(['seen', 'recent']);
  const now = Date.now();
  const fresh = recent.filter((r) => now - r.at < DUPLICATE_WINDOW_MS);

  if (seen.includes(id)) return false;
  if (fingerprint && fresh.some((r) => r.key === fingerprint)) return false;

  seen.push(id);
  if (fingerprint) fresh.push({ key: fingerprint, at: now });
  await chrome.storage.local.set({
    seen: seen.slice(-MAX_SEEN),
    recent: fresh.slice(-MAX_SEEN),
  });
  return true;
}

async function addLog(entry) {
  const { log = [] } = await chrome.storage.local.get('log');
  log.unshift(entry);
  await chrome.storage.local.set({ log: log.slice(0, MAX_LOG) });
}

async function forward(config, payload) {
  const res = await fetch(`http://127.0.0.1:${config.port}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`serveur ${res.status}`);
  return res.json();
}

/* --------------------------------------------------- réponses sortantes --- */

async function api(pathname, init) {
  const config = await getConfig();
  const res = await fetch(`http://127.0.0.1:${config.port}${pathname}`, init);
  if (!res.ok) throw new Error(`serveur ${res.status}`);
  return res.json();
}

async function pendingReplies() {
  try {
    const { replies } = await api('/outbox');
    return replies || [];
  } catch {
    return [];
  }
}

/**
 * Le ping sonore passe par une page hors écran : un onglet Teams avec lequel on
 * n'a pas interagi n'a pas le droit de jouer un son.
 */
async function playBeep() {
  try {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: "Signal sonore à l'arrivée d'une question Teams.",
      });
    }
    await chrome.runtime.sendMessage({ type: 'play-beep' });
  } catch (e) {
    console.warn('ping sonore impossible', e);
  }
}

function notify(id, title, message) {
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icon128.png',
    title,
    message,
    priority: 2,
    requireInteraction: true,
  });
}

async function handleMessage(payload) {
  const config = await getConfig();
  if (!config.enabled) return { accepted: false, reason: 'désactivé' };
  if (!authorMatches(payload.author, config.authors)) {
    return { accepted: false, reason: 'auteur non surveillé' };
  }
  const fingerprint = String(payload.body || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  if (!(await remember(payload.id, fingerprint))) {
    return { accepted: false, reason: 'déjà vu' };
  }

  const { project, question, prefix } = parse(payload.body, config.trigger);

  // Aperçu de la liste de conversations : le texte est tronqué, on prévient sans
  // écrire de fichier. Le .md sera créé à l'ouverture de la conversation.
  if (payload.partial) {
    if (config.sound) playBeep();
    if (config.notify) {
      notify(
        `tc-list-${Date.now()}`,
        `${payload.author || 'Teams'} · #${project} · non lu`,
        `Ouvre la conversation Teams pour capter la question complète.`
      );
    }
    chrome.action.setBadgeBackgroundColor({ color: '#d13438' });
    chrome.action.setBadgeText({ text: '!' });
    return { accepted: true, project, partial: true };
  }

  const entry = {
    at: new Date().toISOString(),
    author: payload.author || 'inconnu',
    project,
    question,
    raw: payload.body,
    prefix,
    channel: payload.channel || null,
    images: Array.isArray(payload.images) ? payload.images : [],
    url: payload.url,
    file: null,
    error: null,
  };

  if (config.forward) {
    try {
      const res = await forward(config, entry);
      entry.file = res.file || null;
    } catch (e) {
      entry.error = String(e.message || e);
    }
  }

  if (config.sound) playBeep();

  if (config.notify) {
    const title = `${entry.author} · #${project}`;
    const shots = entry.images.length
      ? `📎 ${entry.images.length} capture${entry.images.length > 1 ? 's' : ''} · `
      : '';
    const body = entry.error
      ? `⚠️ serveur injoignable — ${question.slice(0, 120)}`
      : shots + question.slice(0, 180);
    notify(`tc-${Date.now()}`, title, body);
  }

  await addLog(entry);
  chrome.action.setBadgeBackgroundColor({ color: '#d13438' });
  chrome.action.setBadgeText({ text: '!' });
  return { accepted: true, project, error: entry.error };
}

/** Prévient une seule fois par réponse qu'elle attend d'être envoyée. */
async function announceReplies(replies) {
  const config = await getConfig();
  if (!config.notify || replies.length === 0) return;
  const { announced = [] } = await chrome.storage.local.get('announced');
  const fresh = replies.filter((r) => !announced.includes(r.id));
  for (const r of fresh) {
    const joints = r.attachments.length ? ` · 📎 ${r.attachments.length}` : '';
    notify(`tc-reply-${r.id}`, `Réponse prête · #${r.project}${joints}`, r.text.slice(0, 180));
  }
  if (fresh.length) {
    await chrome.storage.local.set({
      announced: [...announced, ...fresh.map((r) => r.id)].slice(-100),
    });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'get-config') {
    getConfig().then(sendResponse);
    return true;
  }
  if (msg.type === 'teams-message') {
    handleMessage(msg.payload).then(sendResponse).catch((e) =>
      sendResponse({ accepted: false, reason: String(e) })
    );
    return true;
  }
  if (msg.type === 'check-outbox') {
    pendingReplies()
      .then(async (replies) => {
        await announceReplies(replies);
        if (replies.length) {
          chrome.action.setBadgeBackgroundColor({ color: '#3f7f4f' });
          chrome.action.setBadgeText({ text: `↑${replies.length}` });
        }
        sendResponse({ replies });
      })
      .catch(() => sendResponse({ replies: [] }));
    return true;
  }

  if (msg.type === 'fetch-reply') {
    api(`/outbox/${encodeURIComponent(msg.id)}`)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e.message || e) }));
    return true;
  }

  if (msg.type === 'reply-sent') {
    api(`/outbox/${encodeURIComponent(msg.id)}/sent`, { method: 'POST' })
      .then(() => {
        chrome.action.setBadgeText({ text: '' });
        sendResponse({ ok: true });
      })
      .catch((e) => sendResponse({ error: String(e.message || e) }));
    return true;
  }

  if (msg.type === 'clear-badge') {
    chrome.action.setBadgeText({ text: '' });
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// Sans popup déclaré, le clic sur l'icône ouvre les réglages dans un onglet.
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  chrome.action.setBadgeText({ text: '' });
});
