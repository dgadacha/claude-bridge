const FIELDS = ['enabled', 'trigger', 'port', 'maxAgeMin', 'sound', 'notify', 'forward', 'watchList', 'requireTag', 'autoSend', 'debug'];
const DEFAULTS = {
  enabled: true, trigger: '#claude', channels: ['claude-bridge'],
  requireTag: false, authors: [], sound: true, autoSend: false,
  notify: true, forward: true, port: 8795, watchList: true,
  maxAgeMin: 15, debug: false,
};

const $ = (id) => document.getElementById(id);

async function load() {
  const { config } = await chrome.storage.sync.get('config');
  const cfg = { ...DEFAULTS, ...(config || {}) };
  for (const id of FIELDS) {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = !!cfg[id];
    else el.value = cfg[id];
  }
  $('authors').value = (cfg.authors || []).join('\n');
  $('channels').value = (cfg.channels || []).join('\n');
  renderLog();
  renderOutbox();
  ping();
}

async function save() {
  const cfg = { ...DEFAULTS };
  for (const id of FIELDS) {
    const el = $(id);
    cfg[id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  cfg.port = Number(cfg.port) || DEFAULTS.port;
  cfg.maxAgeMin = Number(cfg.maxAgeMin) || DEFAULTS.maxAgeMin;
  cfg.trigger = cfg.trigger.trim() || DEFAULTS.trigger;
  cfg.authors = $('authors').value.split('\n').map((s) => s.trim()).filter(Boolean);
  cfg.channels = $('channels').value.split('\n').map((s) => s.trim()).filter(Boolean);
  await chrome.storage.sync.set({ config: cfg });
  return cfg;
}

async function ping() {
  const port = Number($('port').value) || DEFAULTS.port;
  const el = $('statusText');
  el.className = '';
  el.textContent = 'test…';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { cache: 'no-store' });
    const data = await res.json();
    el.className = 'ok';
    el.textContent = `serveur ok → ${data.outputDir}`;
  } catch {
    el.className = 'ko';
    el.textContent = 'serveur injoignable (lance ./start.sh)';
  }
}

function renderLog() {
  chrome.storage.local.get('log', ({ log = [] }) => {
    const ul = $('log');
    if (log.length === 0) {
      ul.innerHTML = '<li class="empty">Rien pour l\'instant.</li>';
      return;
    }
    ul.replaceChildren(...log.map((e) => {
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = `${e.author} · #${e.project}`;
      const q = document.createElement('div');
      q.textContent = e.question.slice(0, 160);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = e.error
        ? `⚠️ ${e.error}`
        : `${new Date(e.at).toLocaleString('fr-FR')} — ${e.file || 'non écrit'}`;
      li.append(who, q, meta);
      return li;
    }));
  });
}

/** Réponses rédigées par Claude, en attente de dépôt dans le canal. */
function renderOutbox() {
  chrome.runtime.sendMessage({ type: 'check-outbox' }, (res) => {
    if (chrome.runtime.lastError) return;
    const ul = $('outbox');
    const replies = (res && res.replies) || [];
    if (replies.length === 0) {
      ul.innerHTML = '<li class="empty">Aucune réponse en attente.</li>';
      return;
    }
    ul.replaceChildren(...replies.map((r) => {
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = `#${r.project}` + (r.channel ? ` → ${r.channel}` : '');
      const txt = document.createElement('div');
      txt.textContent = r.text.slice(0, 160);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = r.attachments.length
        ? `📎 ${r.attachments.map((a) => a.name).join(', ')}`
        : 'sans pièce jointe';
      const btn = document.createElement('button');
      btn.textContent = 'Déposer dans Teams';
      btn.addEventListener('click', () => prepare(r, meta));
      li.append(who, txt, meta, btn);
      return li;
    }));
  });
}

function prepare(reply, meta) {
  const TEAMS = [
    'https://teams.cloud.microsoft/*',
    'https://teams.microsoft.com/*',
    'https://teams.live.com/*',
  ];
  chrome.tabs.query({ url: TEAMS }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab) {
      meta.textContent = '⚠️ aucun onglet Teams ouvert';
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'prepare-now', reply }, (res) => {
      if (chrome.runtime.lastError) {
        meta.textContent = '⚠️ recharge l\'onglet Teams';
        return;
      }
      meta.textContent = res && res.ok
        ? '✅ déposée dans la zone de saisie — relis puis envoie'
        : `⚠️ ${(res && res.reason) || 'échec'}`;
    });
  });
}

document.addEventListener('input', save);
$('test').addEventListener('click', ping);
$('config').addEventListener('click', () => {
  const port = Number($('port').value) || DEFAULTS.port;
  chrome.tabs.create({ url: `http://127.0.0.1:${port}/` });
});
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && c.log) renderLog();
});
chrome.runtime.sendMessage({ type: 'clear-badge' });
load();
