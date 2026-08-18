/**
 * Claude Bridge : détection des messages taggés dans le DOM de Teams web.
 *
 * Teams virtualise et re-rend beaucoup son arbre DOM : on combine un
 * MutationObserver (réaction immédiate) et un balayage périodique (filet de
 * sécurité quand l'observer rate un re-render complet du panneau).
 */

const PRIME_MS = 6000; // au chargement, on marque l'historique comme "déjà vu"
const SCAN_DEBOUNCE_MS = 400;
const SWEEP_MS = 3000;

// Conteneurs de message, du plus spécifique au plus générique.
const MESSAGE_CONTAINERS = [
  '[data-tid="chat-pane-message"]',
  '[data-tid="chat-pane-item"]',
  '[data-tid="message-pane-item"]',
  '.fui-ChatMessage',
  '.fui-ChatMyMessage',
  '[data-mid]',
  '[role="listitem"]',
];

const BODY_SELECTORS = [
  '[data-tid="message-body-content"]',
  '[data-tid="messageBodyContent"]',
  '[id^="content-"]', // teams.cloud.microsoft : #content-<id du message>
  '.fui-ChatMessage__body',
  '.fui-ChatMyMessage__body',
];

// Aperçus de la liste de conversations : permettent de pinger même quand la
// conversation n'est pas ouverte (le DOM du message, lui, n'existe pas encore).
const CHAT_LIST_ITEMS = [
  '[data-tid="chat-list-item"]',
  '[data-tid="chatListItem"]',
  '[data-tid="team-channel-list-item"]',
  '[role="treeitem"]',
];

// Un aperçu de conversation tient en une ligne ; au-delà, c'est un conteneur.
const PREVIEW_MAX_CHARS = 400;
const UNREAD_HINT = /non lus?|unread|nouveau message|new message|messages? non lus?/i;

const AUTHOR_SELECTORS = [
  '[data-tid="message-author-name"]',
  '[data-tid="messageAuthorName"]',
  '.fui-ChatMessage__author',
  '.fui-ChatMyMessage__author',
];

// En-tête de la conversation ouverte : sert à ne capter que le canal dédié.
const CHANNEL_HEADER = [
  '[data-tid="channel-header-title"]',
  '[data-tid="chat-header-title"]',
  '[data-tid="threadHeaderTitle"]',
  '[data-tid="team-channel-name"]',
  'h1[role="heading"]',
];

// Captures d'écran : en dessous de cette taille c'est un avatar, un emoji ou une
// icône de réaction, pas une capture.
const IMAGE_MIN_PX = 80;
const MAX_IMAGES = 4;
const IMAGE_MAX_WIDTH = 1600;
const NOT_A_SCREENSHOT = /avatar|profilepicture|profile-picture|emoji|sticker|reaction|presence|giphy-preview/i;

const OUTBOX_POLL_MS = 20000;

// Zone de saisie du message, du plus spécifique au plus générique.
const COMPOSE_BOX = [
  '[data-tid="ckeditor"] [contenteditable="true"]',
  '[data-tid="messageBodyInput"] [contenteditable="true"]',
  '.ck-editor__editable[contenteditable="true"]',
  'div[role="textbox"][contenteditable="true"]',
];

const SEND_BUTTON = [
  '[data-tid="sendMessageCommands"] button',
  '[data-tid="newMessageCommandBar-send"]',
  'button[name="send"]',
  'button[aria-label*="Envoyer" i]',
  'button[aria-label*="Send" i]',
];

const state = {
  config: null,
  seen: new Set(),
  primedUntil: Date.now() + PRIME_MS,
  scanTimer: null,
  timers: [],
  stopped: false,
  prepared: new Set(), // réponses déjà déposées dans la zone de saisie
};

/**
 * Recharger l'extension coupe le lien avec les scripts déjà injectés. Plutôt que
 * de laisser chaque appel échouer bruyamment, on s'arrête et on le dit une fois.
 */
function bridgeAlive() {
  try {
    return Boolean(chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

function stopBridge() {
  if (state.stopped) return;
  state.stopped = true;
  state.timers.forEach(clearInterval);
  clearTimeout(state.scanTimer);
  console.info('[claude-bridge] extension rechargée — recharge cet onglet Teams pour reprendre.');
}

function log(...args) {
  if (state.config && state.config.debug) console.log('[claude-bridge]', ...args);
}

function textOf(el) {
  return (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ').trim();
}

/**
 * Nom de la conversation ouverte, pour l'affichage. Le premier en-tête trouvé fait
 * foi ; à défaut on retombe sur l'URL puis le titre de l'onglet.
 */
function currentChannel() {
  for (const sel of CHANNEL_HEADER) {
    const el = document.querySelector(sel);
    const t = el ? textOf(el) : '';
    if (t && t.length < 120) return t;
  }
  const fromUrl = decodeURIComponent(location.href).match(/\/(?:channel|conversations)\/[^/]+\/([^?#/]+)/);
  if (fromUrl) return fromUrl[1];
  return (document.title || '').split('|')[0].trim();
}

/**
 * Tous les endroits où Teams peut écrire le nom de la conversation ouverte. Aucun
 * n'est fiable seul : selon la version, l'en-tête n'est pas balisé, le titre de
 * l'onglet dit juste « Conversation », et l'URL ne contient qu'un identifiant. On
 * les concatène et le filtre cherche le canal dans cet ensemble.
 */
function channelHints() {
  const bits = [currentChannel(), document.title, decodeURIComponent(location.href)];

  // L'entrée sélectionnée dans la liste latérale porte le nom du canal courant.
  for (const sel of ['[aria-selected="true"]', '[aria-current="page"]', '[data-tid="channel-list-item-selected"]']) {
    for (const el of document.querySelectorAll(sel)) {
      const t = textOf(el);
      if (t && t.length < 120) bits.push(t);
    }
  }

  // Le panneau de messages est souvent étiqueté avec le nom de la conversation.
  for (const el of document.querySelectorAll('[data-tid="message-pane-list-runway"], [data-tid="chat-pane-list"], main, [role="main"]')) {
    const label = el.getAttribute('aria-label');
    if (label && label.length < 120) bits.push(label);
  }

  return bits.filter(Boolean).join(' § ');
}

/**
 * « Claude Bridge », « claude-bridge », « Claude_Bridge » : Teams affiche le nom du
 * canal tel qu'il a été saisi, on compare donc sur une forme normalisée.
 */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Aucun canal configuré = on écoute partout. */
function channelAllowed(haystack, channels) {
  if (!channels || channels.length === 0) return true;
  const h = normalize(haystack);
  return channels.some((c) => {
    const needle = normalize(c);
    return needle && h.includes(needle);
  });
}

function findContainer(node) {
  for (const sel of MESSAGE_CONTAINERS) {
    const hit = node.closest ? node.closest(sel) : null;
    if (hit) return hit;
  }
  return null;
}

function pick(container, selectors) {
  for (const sel of selectors) {
    const hit = container.querySelector(sel);
    if (hit) {
      const t = textOf(hit);
      if (t) return t;
    }
  }
  return '';
}

// Les boutons de la barre d'action d'un message portent eux aussi un aria-label.
const ACTION_LABEL = /option|r[ée]agir|r[ée]pondre|react|reply|more|menu|modifier|supprimer|transf[ée]rer|forward|delete|edit|enregistrer|save|traduire|translate|[ée]pingler|pin/i;

/** Dernier recours : Teams met souvent "Nom, date heure" dans un aria-label. */
function authorFromAria(container) {
  const candidates = container.matches('[aria-label]')
    ? [container, ...container.querySelectorAll('[aria-label]')]
    : Array.from(container.querySelectorAll('[aria-label]'));

  for (const el of candidates) {
    if (el.closest('button, a, [role="button"], [role="menu"], [role="menuitem"], [role="toolbar"]')) continue;
    const label = el.getAttribute('aria-label') || '';
    if (!label || ACTION_LABEL.test(label)) continue;
    const first = label.split(',')[0].trim();
    if (first.length > 1 && first.length < 80) return first;
  }
  return '';
}

/**
 * Teams dérive souvent l'id d'un message de son horodatage epoch. Quand c'est le
 * cas, on peut écarter l'historique rechargé à l'ouverture d'une conversation.
 */
function timestampOf(container) {
  const mid = container.getAttribute('data-mid') || container.getAttribute('id') || '';
  const digits = String(mid).replace(/[^0-9]/g, '');
  if (digits.length < 13) return null;
  const ts = Number(digits.slice(0, 13));
  return ts > 1.5e12 && ts < Date.now() + 6e5 ? ts : null;
}

function messageId(container, body) {
  const attr =
    container.getAttribute('data-mid') ||
    container.getAttribute('id') ||
    container.getAttribute('data-tid-message-id');
  if (attr) return `mid:${attr}`;
  // Pas d'identifiant stable : on retombe sur une empreinte du contenu.
  let hash = 0;
  for (let i = 0; i < body.length; i++) {
    hash = (hash * 31 + body.charCodeAt(i)) | 0;
  }
  return `hash:${hash}`;
}

function extract(container) {
  let body = pick(container, BODY_SELECTORS) || textOf(container);
  // Un message peut n'être qu'une capture d'écran, sans une ligne de texte.
  if (!body) {
    const hasImage = Array.from(container.querySelectorAll('img')).some(looksLikeScreenshot);
    if (!hasImage) return null;
    body = '(capture d\'écran)';
  }
  const author = pick(container, AUTHOR_SELECTORS) || authorFromAria(container);
  return { author, body, id: messageId(container, body), ts: timestampOf(container) };
}

function looksLikeScreenshot(img) {
  const src = img.currentSrc || img.src || '';
  if (!src || NOT_A_SCREENSHOT.test(src)) return false;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  return w >= IMAGE_MIN_PX && h >= IMAGE_MIN_PX;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** Rééchantillonne les grosses captures : le message passe par chrome.runtime. */
async function shrink(blob) {
  if (blob.size < 400000) return blobToDataUrl(blob);
  try {
    const bitmap = await createImageBitmap(blob);
    const ratio = Math.min(1, IMAGE_MAX_WIDTH / bitmap.width);
    const canvas = new OffscreenCanvas(
      Math.round(bitmap.width * ratio),
      Math.round(bitmap.height * ratio)
    );
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    bitmap.close();
    return blobToDataUrl(out);
  } catch (e) {
    log('rééchantillonnage impossible', e);
    return blobToDataUrl(blob);
  }
}

/**
 * Récupère les octets d'une capture. Teams sert ses images tantôt en blob:,
 * tantôt derrière une URL authentifiée : on tente le fetch (les cookies de la
 * page suivent), puis la recopie du pixel déjà affiché, et à défaut on ne garde
 * que le lien.
 */
async function imageData(img) {
  const src = img.currentSrc || img.src;
  const alt = (img.getAttribute('alt') || '').trim();

  try {
    const res = await fetch(src, { credentials: 'include' });
    if (res.ok) {
      const blob = await res.blob();
      // Une page d'erreur HTML renvoyée en 200 ne doit pas passer pour une capture.
      if (blob.size > 0 && blob.type.startsWith('image/')) {
        return { dataUrl: await shrink(blob), alt };
      }
      log('réponse non-image, on tente le canvas', blob.type);
    }
  } catch (e) {
    log('fetch image refusé', e);
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return { dataUrl: canvas.toDataURL('image/png'), alt };
  } catch (e) {
    log('canvas tainted, on garde le lien', e);
  }

  return { url: src, alt };
}

async function collectImages(container) {
  const imgs = Array.from(container.querySelectorAll('img'))
    .filter(looksLikeScreenshot)
    .slice(0, MAX_IMAGES);
  const out = [];
  for (const img of imgs) {
    try {
      out.push(await imageData(img));
    } catch (e) {
      log('image ignorée', e);
    }
  }
  return out;
}

function send(payload) {
  if (!bridgeAlive()) return stopBridge();
  chrome.runtime.sendMessage({ type: 'teams-message', payload }, (res) => {
    if (chrome.runtime.lastError) return;
    if (res && res.accepted) log('capture acceptée', res);
  });
}

function scan() {
  const cfg = state.config;
  if (!cfg || !cfg.enabled) return;
  if (!bridgeAlive()) return stopBridge();

  const tag = (cfg.trigger || '#claude').toLowerCase();
  const priming = Date.now() < state.primedUntil;
  const channel = currentChannel();
  const hints = channelHints();

  if (!channelAllowed(hints, cfg.channels)) {
    log('conversation hors périmètre', channel, '| indices :', hints.slice(0, 200));
    return;
  }

  // Dans un canal dédié, le tag peut être facultatif : tout ce qui y est posté
  // est pour moi.
  const needsTag = cfg.requireTag !== false || !cfg.channels || cfg.channels.length === 0;

  // On part du texte : plus robuste qu'un sélecteur de message, qui change à
  // chaque refonte de Teams.
  const candidates = new Set();
  for (const sel of MESSAGE_CONTAINERS) {
    for (const el of document.querySelectorAll(sel)) candidates.add(el);
  }
  // Les conteneurs s'emboîtent (un item contient le message) : on ne garde que le
  // plus interne, sinon le même message est capté à chaque niveau.
  for (const el of Array.from(candidates)) {
    if (el.querySelector(MESSAGE_CONTAINERS.join(','))) candidates.delete(el);
  }
  if (candidates.size === 0) candidates.add(document.body);

  for (const container of candidates) {
    const raw = textOf(container);
    if (!raw) continue;
    if (needsTag && raw.toLowerCase().indexOf(tag) === -1) continue;

    const msg = extract(container);
    if (!msg) continue;
    if (needsTag && msg.body.toLowerCase().indexOf(tag) === -1) continue;
    if (state.seen.has(msg.id)) continue;

    state.seen.add(msg.id);

    const maxAgeMs = (Number(cfg.maxAgeMin) || 15) * 60000;
    if (msg.ts && Date.now() - msg.ts > maxAgeMs) {
      log('message trop ancien, ignoré', msg.id);
      continue;
    }

    if (priming) {
      log('historique ignoré', msg.id, msg.author);
      continue;
    }

    log('capture', msg);
    const payload = { ...msg, channel, url: location.href };
    if (cfg.images === false) {
      send(payload);
    } else {
      // Les captures sont lues tout de suite : Teams recycle vite son DOM.
      collectImages(container).then((images) => send({ ...payload, images }));
    }
  }
}

/**
 * Aperçus non lus : on ne connaît que le début du message, donc on se contente de
 * prévenir. Le texte complet est capté à l'ouverture de la conversation.
 */
function scanChatList() {
  const cfg = state.config;
  if (!cfg || !cfg.enabled || cfg.watchList === false) return;
  if (!bridgeAlive()) return stopBridge();
  const tag = (cfg.trigger || '#claude').toLowerCase();

  for (const sel of CHAT_LIST_ITEMS) {
    for (const item of document.querySelectorAll(sel)) {
      // Un item qui en contient d'autres est un conteneur de liste, pas un aperçu.
      if (item.querySelector(CHAT_LIST_ITEMS.join(','))) continue;

      const raw = textOf(item);
      if (!raw || raw.length > PREVIEW_MAX_CHARS) continue;

      // Sans marque de non-lu, c'est juste un canal dans la barre latérale.
      const label = `${item.getAttribute('aria-label') || ''} ${item.className || ''}`;
      if (!UNREAD_HINT.test(label)) continue;
      // Ici le nom du canal est dans l'aperçu lui-même.
      if (!channelAllowed(raw, cfg.channels)) continue;
      const listNeedsTag = cfg.requireTag !== false || !cfg.channels || cfg.channels.length === 0;
      if (listNeedsTag && raw.toLowerCase().indexOf(tag) === -1) continue;

      const key = `list:${item.getAttribute('data-tid-chat-id') || item.getAttribute('id') || raw.slice(0, 120)}`;
      if (state.seen.has(key)) continue;
      state.seen.add(key);

      const author = authorFromAria(item) || raw.split('\n')[0].trim();
      log('aperçu non lu', author, raw);
      send({
        author,
        body: raw,
        id: key,
        partial: true,
        channel: currentChannel(),
        url: location.href,
      });
    }
  }
}

function queueScan() {
  clearTimeout(state.scanTimer);
  state.scanTimer = setTimeout(() => {
    scan();
    scanChatList();
  }, SCAN_DEBOUNCE_MS);
}

/* --------------------------------------------------- réponses sortantes --- */

function composeBox() {
  for (const sel of COMPOSE_BOX) {
    const el = document.querySelector(sel);
    if (el && el.isContentEditable) return el;
  }
  return null;
}

function sendButton() {
  for (const sel of SEND_BUTTON) {
    const el = document.querySelector(sel);
    if (el && !el.disabled) return el;
  }
  return null;
}

function fileFromBase64(name, b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const type = /\.zip$/i.test(name)
    ? 'application/zip'
    : /\.(png|jpe?g|gif|webp)$/i.test(name)
      ? `image/${name.split('.').pop().toLowerCase().replace('jpg', 'jpeg')}`
      : 'application/octet-stream';
  return new File([bytes], name, { type });
}

/** Teams accepte le collage de fichiers ; l'input caché sert de secours. */
function attachFiles(target, files) {
  const dt = new DataTransfer();
  files.forEach((f) => dt.items.add(f));

  target.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
  );

  const input = document.querySelector('input[type="file"]');
  if (input) {
    try {
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      log('input file non exploitable', e);
    }
  }
}

function typeInto(box, text) {
  box.focus();
  const ok = document.execCommand && document.execCommand('insertText', false, text);
  if (!ok) {
    box.textContent = text;
    box.dispatchEvent(new InputEvent('input', { inputType: 'insertText', bubbles: true }));
  }
}

/** Marque la réponse envoyée au premier clic sur Envoyer (ou à l'Entrée). */
function watchForSend(replyId, box) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    chrome.runtime.sendMessage({ type: 'reply-sent', id: replyId }, () => {});
  };
  const btn = sendButton();
  if (btn) btn.addEventListener('click', finish, { once: true, capture: true });
  box.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && !e.shiftKey) finish();
    },
    { capture: true }
  );
}

/**
 * Dépose la réponse rédigée par Claude dans la zone de saisie du canal, pièces
 * jointes comprises. L'envoi reste manuel sauf si `autoSend` est activé.
 */
async function prepareReply(reply) {
  const box = composeBox();
  if (!box) return log('zone de saisie introuvable, réponse laissée en attente');
  if (textOf(box)) return log('zone de saisie occupée, réponse laissée en attente');

  const full = await new Promise((resolve) =>
    chrome.runtime.sendMessage({ type: 'fetch-reply', id: reply.id }, resolve)
  );
  if (!full || full.error) return log('réponse illisible', full && full.error);

  state.prepared.add(reply.id);
  typeInto(box, full.text);

  const files = (full.attachments || [])
    .filter((a) => a.base64)
    .map((a) => fileFromBase64(a.name, a.base64));
  if (files.length) attachFiles(box, files);

  watchForSend(reply.id, box);
  log('réponse préparée dans le canal', reply.id, files.map((f) => f.name));

  if (state.config.autoSend) {
    // Laisse à Teams le temps de finir l'envoi de la pièce jointe.
    setTimeout(
      () => {
        const btn = sendButton();
        if (btn) btn.click();
        else log('bouton Envoyer introuvable');
      },
      files.length ? 4000 : 400
    );
  }
}

function pollOutbox() {
  const cfg = state.config;
  if (!cfg || !cfg.enabled) return;
  if (!bridgeAlive()) return stopBridge();
  chrome.runtime.sendMessage({ type: 'check-outbox' }, (res) => {
    if (chrome.runtime.lastError || !res || !res.replies) return;
    const channel = currentChannel();
    for (const reply of res.replies) {
      if (state.prepared.has(reply.id)) continue;
      // Une réponse qui vise un canal précis n'est déposée que dans ce canal.
      const hints = channelHints();
      if (reply.channel && !channelAllowed(hints, [reply.channel])) continue;
      if (!reply.channel && !channelAllowed(hints, cfg.channels)) continue;
      prepareReply(reply);
      break; // une seule à la fois, pour ne pas empiler dans la zone de saisie
    }
  });
}

function start(config) {
  state.config = config;
  log('démarré', config);
  new MutationObserver(queueScan).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  state.timers.push(
    setInterval(() => {
      scan();
      scanChatList();
    }, SWEEP_MS),
    setInterval(pollOutbox, OUTBOX_POLL_MS)
  );
  setTimeout(pollOutbox, 2000);
  queueScan();
}

chrome.runtime.sendMessage({ type: 'get-config' }, (config) => {
  if (chrome.runtime.lastError || !config) return;
  start(config);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.config && state.config) {
    state.config = changes.config.newValue;
    log('config rechargée', state.config);
  }
});

// Dépôt déclenché à la main depuis le popup de l'extension.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'prepare-now') return false;
  if (!state.config) return sendResponse({ ok: false, reason: 'extension pas encore prête' });

  const box = composeBox();
  if (!box) return sendResponse({ ok: false, reason: 'ouvre le canal Teams voulu' });
  if (textOf(box)) return sendResponse({ ok: false, reason: 'la zone de saisie n\'est pas vide' });

  state.prepared.delete(msg.reply.id);
  prepareReply(msg.reply).then(
    () => sendResponse({ ok: true }),
    (e) => sendResponse({ ok: false, reason: String(e.message || e) })
  );
  return true;
});
