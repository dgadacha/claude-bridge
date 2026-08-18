/**
 * Page hors écran dédiée au ping sonore : Chrome bloque l'audio d'un onglet tant
 * que l'utilisateur n'a pas interagi avec lui, ce qui rendait le bip muet quand
 * un message arrivait sans qu'on touche à Teams.
 */
function beep() {
  const ctx = new AudioContext();
  const now = ctx.currentTime;
  [0, 0.18].forEach((offset, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = i === 0 ? 880 : 1180;
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.25, now + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + offset);
    osc.stop(now + offset + 0.16);
  });
  setTimeout(() => ctx.close(), 900);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'play-beep') return false;
  try {
    beep();
    sendResponse({ ok: true });
  } catch (e) {
    sendResponse({ ok: false, reason: String(e) });
  }
  return false;
});
