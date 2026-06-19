/**
 * background.js — Service Worker (hub de estado e message passing)
 * GWeb Comissões v3.4.0
 *
 * Estado agora é persistido em chrome.storage.session para que o popup
 * mantenha logs, progresso e cronômetro mesmo ao fechar/minimizar/trocar aba.
 */

const PREFIX = '[GDOORScraper]';
const STATE_KEY = 'scraperState';

// Estado centralizado
let state = {
  status: 'idle',   // idle | run | paused | done | error
  progress: 0,
  total: 0,
  paused: false,
  logs: [],
  alerts: [],
  data: [],
  pages: 0,
  stats: {},
  audit: [],
  discarded: [],
  timerStartedAt: null,   // timestamp de início da raspagem
  timerPausedTotal: 0,    // ms acumulados em pausa
  timerPausedAt: null      // timestamp de quando pausou (null = não pausado)
};

// --- Persistência com debounce ---
let persistTimer = null;

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistState, 300);
}

async function persistState() {
  try {
    await chrome.storage.session.set({ [STATE_KEY]: state });
  } catch (e) {
    console.warn(PREFIX, 'Erro ao persistir estado:', e);
  }
}

async function restoreState() {
  try {
    const result = await chrome.storage.session.get(STATE_KEY);
    if (result && result[STATE_KEY]) {
      state = { ...state, ...result[STATE_KEY] };
      console.log(PREFIX, 'Estado restaurado da sessão:', state.status, '| logs:', state.logs.length);
    }
  } catch (e) {
    console.warn(PREFIX, 'Erro ao restaurar estado:', e);
  }
}

// Restaura ao inicializar o service worker
restoreState();

// Listener de mensagens
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log(PREFIX, 'BG recebeu:', msg.type, msg);

  switch (msg.type) {
    case 'GET_STATE':
      sendResponse({ state: { ...state } });
      return true;

    case 'LOG':
      state.logs.push({
        text: msg.text,
        level: msg.level || 'info',
        time: new Date().toLocaleTimeString('pt-BR')
      });
      // Limitar logs em memória para evitar crescimento infinito
      if (state.logs.length > 500) state.logs = state.logs.slice(-400);
      schedulePersist();
      forwardToPopup(msg);
      break;

    case 'PROGRESS':
      state.progress = msg.current;
      if (msg.total !== undefined) state.total = msg.total;
      schedulePersist();
      forwardToPopup(msg);
      break;

    case 'TOTAL':
      state.total = msg.total;
      schedulePersist();
      forwardToPopup(msg);
      break;

    case 'STATUS':
      state.status = msg.status;
      if (msg.pages !== undefined) state.pages = msg.pages;
      if (msg.status === 'paused') {
        state.paused = true;
        if (!state.timerPausedAt) state.timerPausedAt = Date.now();
      }
      if (msg.status === 'run') {
        state.paused = false;
        // Se estava pausado, acumula tempo de pausa
        if (state.timerPausedAt) {
          state.timerPausedTotal += Date.now() - state.timerPausedAt;
          state.timerPausedAt = null;
        }
        // Se é primeiro run (início da raspagem), marca o timestamp
        if (!state.timerStartedAt) state.timerStartedAt = Date.now();
      }
      schedulePersist();
      forwardToPopup(msg);
      break;

    case 'ALERT':
      state.alerts.push({
        text: msg.text,
        level: msg.level || 'error',
        time: new Date().toLocaleTimeString('pt-BR')
      });
      schedulePersist();
      forwardToPopup(msg);
      break;

    case 'DONE':
      state.status = 'done';
      state.data = msg.data || state.data;
      state.stats = msg.stats || state.stats;
      state.audit = msg.audit || state.audit;
      state.discarded = msg.discarded || state.discarded;
      // Congelar timer no momento da conclusão
      if (state.timerPausedAt) {
        state.timerPausedTotal += Date.now() - state.timerPausedAt;
        state.timerPausedAt = null;
      }
      schedulePersist();
      forwardToPopup(msg);
      break;

    case 'DATA_UPDATE':
      state.data = msg.data || state.data;
      schedulePersist();
      forwardToPopup(msg);
      break;

    case 'RESET':
      state.status = 'idle';
      state.progress = 0;
      state.total = 0;
      state.paused = false;
      state.logs = [];
      state.alerts = [];
      state.data = [];
      state.pages = 0;
      state.stats = {};
      state.audit = [];
      state.discarded = [];
      state.timerStartedAt = null;
      state.timerPausedTotal = 0;
      state.timerPausedAt = null;
      schedulePersist();
      forwardToPopup(msg);
      break;

    case 'TIMER_START':
      state.timerStartedAt = Date.now();
      state.timerPausedTotal = 0;
      state.timerPausedAt = null;
      schedulePersist();
      break;
  }

  sendResponse({ ok: true });
  return true;
});

// Retransmite mensagem para o popup (se estiver aberto)
async function forwardToPopup(msg) {
  try {
    await chrome.runtime.sendMessage(msg);
  } catch (e) {
    // Popup não está aberto — ignorar
  }
}

console.log(PREFIX, 'Background service worker inicializado v3.1.0');
