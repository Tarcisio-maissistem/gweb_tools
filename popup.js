/**
 * popup.js — Lógica do popup da extensão GWeb Comissões
 * Comunicação bidirecional com content script e background
 */

(function () {
  'use strict';

  const PREFIX = '[GDOORScraper]';

  // --- DOM refs ---
  const urlWarning     = document.getElementById('urlWarning');
  const statusDot      = document.getElementById('statusDot');
  const statusText     = document.getElementById('statusText');
  const dateFrom       = document.getElementById('dateFrom');
  const dateTo         = document.getElementById('dateTo');
  const progressLabel  = document.getElementById('progressLabel');
  const progressPercent = document.getElementById('progressPercent');
  const progressBar    = document.getElementById('progressBar');
  const btnStart       = document.getElementById('btnStart');
  const btnPause       = document.getElementById('btnPause');
  const btnStop        = document.getElementById('btnStop');
  const btnReport      = document.getElementById('btnReport');
  const btnTestApi    = document.getElementById('btnTestApi');
  const btnClearCache  = document.getElementById('btnClearCache');
  const cacheInfoEl    = document.getElementById('cacheInfo');
  const logCount       = document.getElementById('logCount');
  const alertCount     = document.getElementById('alertCount');
  const logContainer   = document.getElementById('logContainer');
  const logEmpty       = document.getElementById('logEmpty');
  const alertsContainer = document.getElementById('alertsContainer');
  const alertsEmpty    = document.getElementById('alertsEmpty');
  const sumProcessed   = document.getElementById('sumProcessed');
  const sumItems       = document.getElementById('sumItems');
  const sumTotal       = document.getElementById('sumTotal');
  const sumPages       = document.getElementById('sumPages');

  let currentTabId = null;
  let timerInterval = null;
  let timerStart = null;
  let timerPausedAt = null;
  let timerPausedTotal = 0;
  let state = {
    status: 'idle',
    progress: 0,
    total: 0,
    logs: [],
    alerts: [],
    data: [],
    paused: false,
    pages: 0,
    // Extras da estratégia
    stats: {},
    audit: [],
    discarded: []
  };

  function formatElapsed(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  function startTimer() {
    stopTimer();
    timerStart = Date.now();
    timerPausedTotal = 0;
    timerPausedAt = null;
    timerInterval = setInterval(renderTimer, 500);
    renderTimer();
  }

  function pauseTimer() {
    if (timerPausedAt) {
      // Resume
      timerPausedTotal += Date.now() - timerPausedAt;
      timerPausedAt = null;
    } else {
      timerPausedAt = Date.now();
    }
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function renderTimer() {
    const clockEl = document.getElementById('timerClock');
    const speedEl = document.getElementById('timerSpeed');
    if (!clockEl) return;
    if (!timerStart) { clockEl.textContent = '00:00'; speedEl.textContent = ''; return; }
    const paused = timerPausedAt ? (Date.now() - timerPausedAt) : 0;
    const elapsed = Date.now() - timerStart - timerPausedTotal - paused;
    clockEl.textContent = formatElapsed(Math.max(0, elapsed));
    if (state.progress > 0 && elapsed > 1000) {
      const perSec = (state.progress / (elapsed / 1000)).toFixed(1);
      speedEl.textContent = perSec + ' pedidos/s';
    } else {
      speedEl.textContent = '';
    }
  }

  // --- Init ---
  async function init() {
    console.log(PREFIX, 'Popup aberto');
    await checkCurrentTab();
    await loadState();
    setupListeners();
    setupTabs();
    restoreDates();
    restoreTimer();
    render();
    await loadCacheStats();
  }

  // --- Restaurar cronômetro ao reabrir popup ---
  function restoreTimer() {
    // Se a raspagem está em andamento ou pausada, restaurar cronômetro do background
    if (state.timerStartedAt) {
      timerStart = state.timerStartedAt;
      timerPausedTotal = state.timerPausedTotal || 0;
      timerPausedAt = state.timerPausedAt || null;

      if (state.status === 'run') {
        // Em execução: retomar cronômetro ao vivo
        timerInterval = setInterval(renderTimer, 500);
        renderTimer();
      } else if (state.status === 'paused' || state.paused) {
        // Pausado: mostrar tempo congelado
        renderTimer();
      } else if (state.status === 'done') {
        // Concluído: mostrar tempo final (parado)
        renderTimer();
      }
    }
  }

  // --- Check if on correct page ---
  async function checkCurrentTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        currentTabId = tab.id;
        const isGdoor = tab.url && tab.url.includes('app.gdoorweb.com.br');
        urlWarning.classList.toggle('visible', !isGdoor);
        if (!isGdoor) {
          btnStart.disabled = true;
        }
      }
    } catch (e) {
      console.error(PREFIX, 'Erro ao verificar aba:', e);
    }
  }

  // --- Load state from background (com fallback para chrome.storage.session) ---
  async function loadState() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      if (resp && resp.state) {
        state = { ...state, ...resp.state };
      }
    } catch (e) {
      console.log(PREFIX, 'Background não disponível, tentando chrome.storage.session...');
      try {
        const result = await chrome.storage.session.get('scraperState');
        if (result && result.scraperState) {
          state = { ...state, ...result.scraperState };
        }
      } catch (e2) {
        console.log(PREFIX, 'Sem estado salvo, usando padrão');
      }
    }
  }

  // --- Save filter dates ---
  function saveDates() {
    chrome.storage.local.set({
      filterDateFrom: dateFrom.value,
      filterDateTo: dateTo.value
    });
  }

  function restoreDates() {
    chrome.storage.local.get(['filterDateFrom', 'filterDateTo'], (result) => {
      if (result.filterDateFrom) dateFrom.value = result.filterDateFrom;
      if (result.filterDateTo) dateTo.value = result.filterDateTo;
    });
  }

  // --- Setup event listeners ---
  function setupListeners() {
    btnTestApi.addEventListener('click', onTestApi);
    btnStart.addEventListener('click', onStart);
    btnPause.addEventListener('click', onPause);
    btnStop.addEventListener('click', onStop);
    btnReport.addEventListener('click', onReport);
    btnClearCache.addEventListener('click', onClearCache);
    dateFrom.addEventListener('change', saveDates);
    dateTo.addEventListener('change', saveDates);

    // Listen for messages from background
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      console.log(PREFIX, 'Popup recebeu:', msg.type);
      handleMessage(msg);
      sendResponse({ ok: true });
    });
  }

  // --- Handle messages from background/content ---
  function handleMessage(msg) {
    switch (msg.type) {
      case 'LOG':
        addLog(msg.text, msg.level || 'info');
        break;
      case 'PROGRESS':
        state.progress = msg.current;
        if (msg.total) state.total = msg.total;
        break;
      case 'TOTAL':
        state.total = msg.total;
        break;
      case 'DONE':
        state.status = 'done';
        state.data = msg.data || state.data;
        state.stats = msg.stats || state.stats;
        state.audit = msg.audit || state.audit;
        state.discarded = msg.discarded || state.discarded;
        stopTimer();
        renderTimer();
        if (msg.alerts) {
          msg.alerts.forEach(a => addAlert(a.text || a.msg || a, a.level || 'warn'));
        }
        addLog('Raspagem concluída!', 'success');
        if (msg.stats) {
          addLog(`  ${msg.stats.included || 0} incluídos | ${msg.stats.skippedNotDone || 0} ignorados | ${msg.stats.discardedByDate || 0} fora do período`, 'info');
          if (msg.stats.cacheHits !== undefined) {
            addLog(`  Cache: ${msg.stats.cacheHits} hits | ${msg.stats.cacheMisses} misses | ${msg.stats.cacheRevalidated || 0} reval. | ${msg.stats.cacheTransitions || 0} transições`, 'info');
          }
        }
        loadCacheStats();
        autoOpenReport();
        break;
      case 'RESET':
        _reportOpened = false;
        break;
      case 'STATUS':
        state.status = msg.status;
        if (msg.pages) state.pages = msg.pages;
        break;
      case 'ALERT':
        addAlert(msg.text, msg.level || 'error');
        break;
      case 'DATA_UPDATE':
        state.data = msg.data || state.data;
        break;
      case 'RESET':
        resetState();
        break;
    }
    render();
  }

  // --- Actions ---
  async function onTestApi() {
    if (!currentTabId) return;

    btnTestApi.disabled = true;
    btnTestApi.textContent = '⏳ Testando...';
    addLog('Iniciando teste de conexão com a API...', 'info');
    render();

    try {
      // Injeta o content script caso não esteja carregado
      try {
        await chrome.scripting.executeScript({
          target: { tabId: currentTabId },
          files: ['src/comissao-content.js']
        });
      } catch (e) { /* já injetado */ }

      await new Promise(r => setTimeout(r, 500));

      const resp = await chrome.tabs.sendMessage(currentTabId, {
        action: 'TEST_API',
        dateFrom: dateFrom.value || '',
        dateTo: dateTo.value || ''
      });

      if (resp && resp.steps) {
        resp.steps.forEach(step => {
          const icon = step.ok ? '✅' : '❌';
          addLog(`${icon} ${step.name}: ${step.detail}`, step.ok ? 'success' : 'error');
          if (step.sampleIds) {
            step.sampleIds.forEach(s => {
              addLog(`   📋 #${s.doc} | Emissão: ${s.issued} | Atualizado: ${s.updated}`, 'info');
            });
          }
        });
        if (resp.ok) {
          addLog('🎉 Todos os testes passaram! A API está funcional.', 'success');
        } else {
          addLog('⚠️ Teste falhou: ' + (resp.error || 'Verifique os passos acima'), 'error');
        }
      } else {
        addLog('❌ Sem resposta do content script. Recarregue a página do GDOOR.', 'error');
      }
    } catch (e) {
      addLog('❌ Erro no teste: ' + e.message, 'error');
    }

    btnTestApi.disabled = false;
    btnTestApi.textContent = '🔌 Testar API';
    render();
  }

  async function onStart() {
    if (!currentTabId) return;
    if (!dateFrom.value || !dateTo.value) {
      addAlert('Defina as datas de início e fim para filtrar.', 'warn');
      render();
      return;
    }

    state.status = 'run';
    state.progress = 0;
    state.total = 0;
    state.logs = [];
    state.alerts = [];
    state.data = [];
    state.pages = 0;
    _reportOpened = false;

    startTimer();
    // Sinalizar ao background o timestamp de início do timer
    chrome.runtime.sendMessage({ type: 'TIMER_START' }).catch(() => {});
    addLog('Iniciando raspagem...', 'info');
    render();

    try {
      // Tenta injetar o content script caso nao esteja carregado
      try {
        await chrome.scripting.executeScript({
          target: { tabId: currentTabId },
          files: ['src/comissao-content.js']
        });
      } catch (injectErr) {
        // Ja injetado ou sem permissao — ok
        console.log(PREFIX, 'Inject tentativa:', injectErr.message);
      }

      // Pequeno delay para garantir que o script inicializou
      await new Promise(r => setTimeout(r, 500));

      await chrome.tabs.sendMessage(currentTabId, {
        action: 'START',
        dateFrom: dateFrom.value,
        dateTo: dateTo.value
      });
    } catch (e) {
      console.error(PREFIX, 'Erro ao enviar START:', e);
      addAlert('Falha ao comunicar com a página. Recarregue a página do GDOOR e tente novamente.', 'error');
      state.status = 'error';
      render();
    }
  }

  async function onPause() {
    if (!currentTabId) return;
    state.paused = !state.paused;
    const action = state.paused ? 'PAUSE' : 'RESUME';
    state.status = state.paused ? 'paused' : 'run';
    pauseTimer();
    addLog(state.paused ? 'Pausado pelo usuário' : 'Retomando...', 'warn');
    render();

    try {
      await chrome.tabs.sendMessage(currentTabId, { action });
    } catch (e) {
      console.error(PREFIX, 'Erro ao enviar PAUSE/RESUME:', e);
    }
  }

  async function onStop() {
    if (!currentTabId) return;
    state.status = 'idle';
    state.paused = false;
    stopTimer();
    addLog('Parado pelo usuário', 'warn');
    render();

    try {
      await chrome.tabs.sendMessage(currentTabId, { action: 'STOP' });
    } catch (e) {
      console.error(PREFIX, 'Erro ao enviar STOP:', e);
    }
  }

  async function onReport() {
    if (state.data.length === 0) {
      addAlert('Nenhum dado para gerar relatório.', 'warn');
      render();
      return;
    }

    await chrome.storage.local.set({
      reportData: state.data,
      reportDateFrom: dateFrom.value,
      reportDateTo: dateTo.value,
      reportGeneratedAt: new Date().toISOString(),
      reportStats: state.stats || {},
      reportAudit: state.audit || [],
      reportDiscarded: state.discarded || [],
      reportAlerts: state.alerts.map(a => ({ text: a.text, level: a.level }))
    });

    const reportUrl = chrome.runtime.getURL('report.html');
    chrome.tabs.create({ url: reportUrl });
  }

  let _reportOpened = false;
  function autoOpenReport() {
    if (_reportOpened) return;
    if (state.data && state.data.length > 0) {
      _reportOpened = true;
      onReport();
    }
  }

  // --- Cache ---
  async function loadCacheStats() {
    if (!currentTabId) {
      cacheInfoEl.textContent = 'Cache: N/A (não está no GDOOR)';
      return;
    }
    try {
      const resp = await chrome.tabs.sendMessage(currentTabId, { action: 'GET_CACHE_STATS' });
      if (resp && resp.ok && resp.cacheStats) {
        const cs = resp.cacheStats;
        cacheInfoEl.textContent = 'Cache: ' + cs.total + ' pedidos (' + cs.concluded + ' concl. | ' + cs.pending + ' pend. | ' + cs.cancelled + ' canc.)';
      } else {
        cacheInfoEl.textContent = 'Cache: vazio';
      }
    } catch (e) {
      cacheInfoEl.textContent = 'Cache: N/A';
    }
  }

  async function onClearCache() {
    if (!currentTabId) return;
    if (!confirm('Limpar cache de pedidos? Todos os pedidos serão reprocessados na próxima execução.')) return;
    try {
      await chrome.tabs.sendMessage(currentTabId, { action: 'CLEAR_CACHE' });
      cacheInfoEl.textContent = 'Cache: vazio (limpo)';
      addLog('Cache de pedidos limpo pelo usuário', 'warn');
      render();
    } catch (e) {
      console.error(PREFIX, 'Erro ao limpar cache:', e);
    }
  }

  // --- Log & Alerts ---
  function addLog(text, level) {
    const now = new Date();
    const time = now.toLocaleTimeString('pt-BR');
    state.logs.push({ text, level, time });
  }

  function addAlert(text, level) {
    state.alerts.push({ text, level, time: new Date().toLocaleTimeString('pt-BR') });
  }

  // --- Render UI ---
  function render() {
    renderStatus();
    renderProgress();
    renderButtons();
    renderLogs();
    renderSummary();
    renderAlerts();
  }

  function renderStatus() {
    statusDot.className = 'status-dot ' + (state.paused ? 'paused' : state.status);

    const labels = {
      idle: '<strong>Aguardando</strong> — Pronto para iniciar',
      run: '<strong>Executando</strong> — Processando pedidos...',
      paused: '<strong>Pausado</strong> — Clique em Retomar para continuar',
      done: '<strong>Concluído</strong> — Raspagem finalizada',
      error: '<strong>Erro</strong> — Verifique os alertas'
    };
    statusText.innerHTML = labels[state.paused ? 'paused' : state.status] || labels.idle;
  }

  function renderProgress() {
    const pct = state.total > 0 ? Math.round((state.progress / state.total) * 100) : 0;
    progressBar.style.width = pct + '%';
    progressPercent.textContent = pct + '%';
    progressLabel.textContent = `${state.progress} de ${state.total} pedidos`;
  }

  function renderButtons() {
    const isRunning = state.status === 'run' || state.paused;
    const isDone = state.status === 'done';
    const hasData = state.data.length > 0;

    btnStart.disabled = isRunning;
    btnTestApi.disabled = isRunning;
    btnPause.disabled = !isRunning;
    btnStop.disabled = !isRunning;
    btnReport.style.display = (isDone && hasData) ? '' : 'none';

    btnPause.textContent = state.paused ? '▶ Retomar' : '⏸ Pausar';

    if (isDone) {
      btnStart.disabled = false;
      btnTestApi.disabled = false;
      btnPause.disabled = true;
      btnStop.disabled = true;
    }
  }

  function renderLogs() {
    if (state.logs.length === 0) {
      logEmpty.style.display = 'block';
      logContainer.innerHTML = '';
    } else {
      logEmpty.style.display = 'none';
      logContainer.innerHTML = state.logs.map(l =>
        `<div class="log-entry ${l.level}"><span class="log-time">${l.time}</span>${escapeHtml(l.text)}</div>`
      ).join('');
      logContainer.scrollTop = logContainer.scrollHeight;
    }
    logCount.textContent = state.logs.length;
  }

  function renderSummary() {
    const activeData = state.data.filter(p => !(p.status && p.status.toLowerCase().includes('cancel')));
    const totalItems = activeData.reduce((sum, p) => sum + (p.itens ? p.itens.length : 0), 0);
    const totalValue = activeData.reduce((sum, p) => sum + (parseFloat(p.valorTotal) || 0), 0);
    const ticketMedio = activeData.length > 0 ? totalValue / activeData.length : 0;

    sumProcessed.textContent = activeData.length;
    sumItems.textContent = totalItems;
    sumTotal.textContent = formatBRL(totalValue);
    sumPages.textContent = state.pages || 0;

    // Update extra stats if available
    const statsEl = document.getElementById('sumStats');
    if (statsEl && state.stats) {
      statsEl.innerHTML = `
        <div class="summary-card"><div class="label">Ticket Médio</div><div class="value" style="font-size:14px">${formatBRL(ticketMedio)}</div></div>
        <div class="summary-card"><div class="label">Alertas</div><div class="value" style="font-size:14px;color:var(--red)">${state.stats.alertCount || state.alerts.length}</div></div>
      `;
    }
  }

  function renderAlerts() {
    if (state.alerts.length === 0) {
      alertsEmpty.style.display = 'block';
      alertsContainer.innerHTML = '';
    } else {
      alertsEmpty.style.display = 'none';
      alertsContainer.innerHTML = state.alerts.map(a =>
        `<div class="alert-item ${a.level}">[${a.time}] ${escapeHtml(a.text)}</div>`
      ).join('');
    }
    alertCount.textContent = state.alerts.length;
  }

  // --- Tabs ---
  function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const panel = document.getElementById('panel' + capitalize(btn.dataset.tab));
        if (panel) panel.classList.add('active');
      });
    });
  }

  // --- Helpers ---
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function formatBRL(value) {
    return 'R$ ' + value.toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  // --- Kick off ---
  init();
})();
