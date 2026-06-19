/**
 * content.js - Content Script injetado na pagina GDOOR Web
 *
 * ESTRATEGIA CENTRAL:
 *   Comissao = status CONCLUIDO + "Alterado em" (proxy para data de conclusao)
 *   NAO usa data de emissao. NAO confia apenas na listagem.
 *   Dados confiaveis vem da PAGINA DE DETALHES (rota /movimentos/pedidos/{id}).
 *
 * ARQUITETURA DO GDOOR Web:
 *   - Angular 13.2.2 SPA com Angular Material
 *   - Lista de pedidos: gw-standard-list > mat-list-item (NAO tabela)
 *   - Detalhes: navegacao por rota (NAO modal)
 *   - Paginacao: mat-paginator (formato "X - Y / Z")
 *   - Produtos: mat-table (NAO table HTML)
 *   - Status textual: gw-label ("Concluído" / "Em aberto")
 *   - Campo "Vendedor" existe SOMENTE na pagina de edicao
 *   - NAO existe campo explicito "Data de conclusao" — usa-se "Alterado em"
 *
 * FLUXO:
 *   1. Percorre todos os itens mat-list-item da pagina
 *   2. Se status != "Concluído" -> ignora
 *   3. Se status = "Concluído" -> clica no item (navega para /pedidos/{id})
 *   4. Extrai dados da pagina de detalhes + dados da API (via interceptor.js)
 *   5. Usa "Alterado em" como proxy para data de conclusao
 *   6. Se data esta no periodo -> coleta
 *   7. Senao -> descarta
 *   8. Volta para a lista (history.back)
 *   9. Proxima pagina -> repete
 */

(function () {
  'use strict';

  if (window.__gdoorScraperInitialized) return;
  window.__gdoorScraperInitialized = true;

  var PREFIX = '[GDOORScraper]';
  var CHECKPOINT_KEY = 'gdoor_scraper_checkpoint';
  var CHECKPOINT_TTL = 30 * 60 * 1000;
  var CACHE_KEY = 'gdoor_order_cache';
  var CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 dias para concluidos/cancelados
  var CACHE_VERSION = 1;
  var MAX_RETRIES = 3;
  var SESSION_EXPIRED_MSG = 'SESSAO_EXPIRADA';

  // --- Estado global ---
  var appState = {
    running: false,
    paused: false,
    stop: false,
    data: [],
    discarded: [],
    skippedNotDone: 0,
    alerts: [],
    audit: [],
    processedIds: new Set(),
    currentPage: 1,
    totalPages: 1,
    totalRowsSeen: 0,
    dateFrom: '',
    dateTo: '',
    lastApiResponse: null,
    // Cache stats
    cacheStats: {
      hits: 0,
      misses: 0,
      revalidated: 0,
      transitions: 0,
      totalCached: 0
    }
  };

  // =====================================================================
  // HELPERS
  // =====================================================================

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function humanDelay(min, max) {
    if (min === undefined) min = 500;
    if (max === undefined) max = 1500;
    return sleep(Math.floor(Math.random() * (max - min + 1)) + min);
  }

  function smoothScrollTo(el) {
    if (!el) return Promise.resolve();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return sleep(300 + Math.random() * 400);
  }

  function waitFor(selector, timeout) {
    if (!timeout) timeout = 15000;
    return new Promise(function (resolve, reject) {
      var el = document.querySelector(selector);
      if (el) return resolve(el);

      var observer = new MutationObserver(function () {
        el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          clearTimeout(timer);
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      var timer = setTimeout(function () {
        observer.disconnect();
        reject(new Error('Timeout aguardando: ' + selector));
      }, timeout);
    });
  }

  function waitForVisible(selector, timeout) {
    if (!timeout) timeout = 15000;
    return new Promise(function (resolve, reject) {
      function check() {
        var el = document.querySelector(selector);
        if (el && el.offsetParent !== null && getComputedStyle(el).display !== 'none') return el;
        return null;
      }
      var found = check();
      if (found) return resolve(found);

      var observer = new MutationObserver(function () {
        var el = check();
        if (el) { observer.disconnect(); clearTimeout(timer); resolve(el); }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });

      var timer = setTimeout(function () {
        observer.disconnect();
        reject(new Error('Timeout visibilidade: ' + selector));
      }, timeout);
    });
  }

  function parseReal(str) {
    if (!str) return 0;
    return parseFloat(str.replace(/[^\d,.\-]/g, '').replace(/\./g, '').replace(',', '.')) || 0;
  }

  function parseDate(str) {
    if (!str) return null;
    var m = str.trim().match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m) return null;
    return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
  }

  function formatDateBR(dateStr) {
    if (!dateStr) return '';
    if (/^\d{2}\/\d{2}\/\d{4}/.test(dateStr)) return dateStr.substring(0, 10);
    if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
      return new Date(dateStr + 'T00:00:00').toLocaleDateString('pt-BR');
    }
    return dateStr;
  }

  function getText(ctx, sel) {
    var el = ctx.querySelector(sel);
    return el ? el.textContent.trim() : '';
  }

  // =====================================================================
  // COMUNICACAO COM BACKGROUND
  // =====================================================================

  function sendMsg(type, payload) {
    try {
      chrome.runtime.sendMessage(Object.assign({ type: type }, payload || {}));
    } catch (e) {
      console.warn(PREFIX, 'Erro msg:', e);
    }
  }

  function log(text, level) {
    if (!level) level = 'info';
    sendMsg('LOG', { text: text, level: level });
  }

  function progress(current, total) {
    sendMsg('PROGRESS', { current: current, total: total || appState.totalRowsSeen });
  }

  function sendAlert(text, level) {
    if (!level) level = 'error';
    appState.alerts.push({ text: text, level: level, time: new Date().toISOString() });
    sendMsg('ALERT', { text: text, level: level });
  }

  function updateStatus(status, extra) {
    sendMsg('STATUS', Object.assign({ status: status }, extra || {}));
  }

  function auditLog(pedidoId, decision, reason) {
    appState.audit.push({
      pedidoId: pedidoId,
      decision: decision,
      reason: reason,
      timestamp: new Date().toISOString()
    });
  }

  // =====================================================================
  // API INTERCEPTOR LISTENER
  // Recebe dados capturados pelo interceptor.js (MAIN world)
  // =====================================================================

  window.addEventListener('__gdoor_api_data', function (e) {
    try {
      var payload = JSON.parse(e.detail);
      appState.lastApiResponse = payload.data;
    } catch (err) {
      console.warn(PREFIX, 'Erro ao parsear API data:', err);
    }
  });

  // =====================================================================
  // CHECKPOINT
  // =====================================================================

  function saveCheckpoint() {
    try {
      localStorage.setItem(CHECKPOINT_KEY, JSON.stringify({
        timestamp: Date.now(),
        data: appState.data,
        discarded: appState.discarded,
        alerts: appState.alerts,
        audit: appState.audit,
        processedIds: Array.from(appState.processedIds),
        currentPage: appState.currentPage,
        skippedNotDone: appState.skippedNotDone,
        totalRowsSeen: appState.totalRowsSeen,
        dateFrom: appState.dateFrom,
        dateTo: appState.dateTo
      }));
    } catch (e) {
      console.warn(PREFIX, 'Erro checkpoint:', e);
    }
  }

  function loadCheckpoint() {
    try {
      var raw = localStorage.getItem(CHECKPOINT_KEY);
      if (!raw) return null;
      var cp = JSON.parse(raw);
      if (Date.now() - cp.timestamp > CHECKPOINT_TTL) {
        localStorage.removeItem(CHECKPOINT_KEY);
        return null;
      }
      return cp;
    } catch (e) { return null; }
  }

  function clearCheckpoint() {
    localStorage.removeItem(CHECKPOINT_KEY);
  }

  // =====================================================================
  // CACHE PERSISTENTE DE PEDIDOS
  // Evita reprocessar pedidos ja concluidos/cancelados em execucoes futuras.
  // Pedidos concluidos/cancelados raramente mudam, entao podem ser cacheados
  // com TTL longo. Pendentes sao sempre revalidados.
  // =====================================================================

  function loadCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return { version: CACHE_VERSION, entries: {} };
      var cache = JSON.parse(raw);
      if (!cache || cache.version !== CACHE_VERSION) {
        log('Cache version mismatch, resetando cache', 'warn');
        localStorage.removeItem(CACHE_KEY);
        return { version: CACHE_VERSION, entries: {} };
      }
      return cache;
    } catch (e) {
      console.warn(PREFIX, 'Erro ao carregar cache:', e);
      return { version: CACHE_VERSION, entries: {} };
    }
  }

  function saveCache(cache) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (e) {
      console.warn(PREFIX, 'Erro ao salvar cache:', e);
      // Se localStorage estiver cheio, limpa entradas antigas
      if (e.name === 'QuotaExceededError') {
        pruneCache(cache);
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e2) { /* desiste */ }
      }
    }
  }

  function pruneCache(cache) {
    // Remove entradas com ultima_verificacao mais antiga (manter as 500 mais recentes)
    var entries = Object.keys(cache.entries);
    if (entries.length <= 500) return;
    entries.sort(function (a, b) {
      var ta = new Date(cache.entries[a].ultima_verificacao || 0).getTime();
      var tb = new Date(cache.entries[b].ultima_verificacao || 0).getTime();
      return ta - tb;
    });
    var toRemove = entries.length - 500;
    for (var i = 0; i < toRemove; i++) {
      delete cache.entries[entries[i]];
    }
    log('Cache podado: removidas ' + toRemove + ' entradas antigas', 'warn');
  }

  function getCacheEntry(cache, orderNum) {
    return cache.entries[orderNum] || null;
  }

  function setCacheEntry(cache, orderNum, orderData) {
    cache.entries[orderNum] = {
      numero: orderData.numeroPedido || orderNum,
      status: orderData.status || '',
      data_emissao: orderData.dataEmissao || '',
      data_conclusao: orderData.dataConclusao || '',
      vendedor: orderData.vendedor || '',
      cliente: orderData.cliente || '',
      total: orderData.valorTotal || 0,
      pagamento: orderData.formaPagamento || '',
      alteradoPor: orderData.alteradoPor || '',
      itens: orderData.itens || [],
      observacao: orderData.observacao || '',
      clienteCpfCnpj: orderData.clienteCpfCnpj || '',
      clienteEndereco: orderData.clienteEndereco || '',
      clienteTelefone: orderData.clienteTelefone || '',
      clienteEmail: orderData.clienteEmail || '',
      valorSubtotal: orderData.valorSubtotal || 0,
      valorDesconto: orderData.valorDesconto || 0,
      valorFrete: orderData.valorFrete || 0,
      comissao: orderData.comissao || 0,
      percentualComissao: orderData.percentualComissao || 0,
      ultima_verificacao: new Date().toISOString(),
      status_anterior: null
    };
  }

  /**
   * Verifica se uma entrada do cache e valida (TTL nao expirou).
   * Pedidos concluidos/cancelados tem TTL longo (7 dias).
   * Pedidos pendentes (Em aberto) SEMPRE expiram (TTL = 0).
   */
  function isCacheEntryValid(entry) {
    if (!entry || !entry.ultima_verificacao) return false;

    var statusLower = (entry.status || '').toLowerCase();
    var isFinal = statusLower.indexOf('conclu') !== -1 || statusLower.indexOf('cancel') !== -1;

    if (!isFinal) return false; // Pendentes sempre revalidam

    var age = Date.now() - new Date(entry.ultima_verificacao).getTime();
    return age < CACHE_TTL;
  }

  function getCacheStats(cache) {
    var entries = Object.keys(cache.entries);
    var concluded = 0, pending = 0, cancelled = 0;
    entries.forEach(function (k) {
      var s = (cache.entries[k].status || '').toLowerCase();
      if (s.indexOf('conclu') !== -1) concluded++;
      else if (s.indexOf('cancel') !== -1) cancelled++;
      else pending++;
    });
    return {
      total: entries.length,
      concluded: concluded,
      pending: pending,
      cancelled: cancelled
    };
  }

  function clearCache() {
    localStorage.removeItem(CACHE_KEY);
    log('Cache de pedidos limpo');
  }

  // =====================================================================
  // RETRY / PAUSE / STOP
  // =====================================================================

  function isSessionExpired() {
    var path = window.location.pathname;
    return path === '/login' || path.startsWith('/login');
  }

  async function withRetry(fn, label) {
    if (!label) label = 'operacao';
    for (var attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (e.message === SESSION_EXPIRED_MSG) throw e;
        if (isSessionExpired()) throw new Error(SESSION_EXPIRED_MSG);
        log('Tentativa ' + attempt + '/' + MAX_RETRIES + ' falhou: ' + label + ' - ' + e.message, 'warn');
        if (attempt === MAX_RETRIES) {
          sendAlert('Falha apos ' + MAX_RETRIES + ' tentativas: ' + label);
          throw e;
        }
        await sleep(2000 * attempt + Math.random() * 1000);
      }
    }
  }

  async function checkPauseStop() {
    while (appState.paused && !appState.stop) await sleep(500);
    if (appState.stop) throw new Error('STOPPED_BY_USER');
  }

  // =====================================================================
  // VALIDACOES
  // =====================================================================

  function validateOrder(order) {
    var alerts = [];

    if (!order.dataConclusao) {
      alerts.push({
        type: 'SEM_DATA_CONCLUSAO',
        msg: 'Pedido ' + (order.numeroPedido || '?') + ': sem data de conclusao (Alterado em)'
      });
    }
    if (!order.valorTotal || order.valorTotal === 0) {
      alerts.push({
        type: 'SEM_VALOR',
        msg: 'Pedido ' + (order.numeroPedido || '?') + ': valor total = R$ 0,00'
      });
    }
    if (!order.vendedor) {
      alerts.push({
        type: 'SEM_VENDEDOR',
        msg: 'Pedido ' + (order.numeroPedido || '?') + ': sem vendedor vinculado'
      });
    }

    alerts.forEach(function (a) {
      sendAlert(a.msg, 'warn');
      auditLog(order.numeroPedido || '?', 'ALERTA', a.msg);
    });

    return alerts;
  }

  // =====================================================================
  // LISTA DE PEDIDOS (gw-standard-list > mat-list-item)
  // =====================================================================

  /** Retorna todos os itens da lista de pedidos na pagina atual */
  function getOrderItems() {
    return Array.from(document.querySelectorAll('gw-standard-list mat-list-item'));
  }

  /**
   * Extrai dados basicos de um item da lista (usado para triagem).
   *
   * Estrutura real do DOM:
   *   mat-list-item
   *     .mat-list-text
   *       h2.mat-line  -> nome do cliente
   *       h3.mat-line  -> "Nº: 1.283  Emitido em: 24/03/2026 09:31 | Total: R$ 1.350,00"
   *       h3.mat-line  -> gw-label com status ("Concluído" / "Em aberto")
   *     a[mattooltip="Editar pedido"]  -> href="/movimentos/pedidos/{id}/editar" (apenas Em aberto)
   *     button[mattooltip="Opções"]    -> menu de opcoes (Concluído e Em aberto)
   */
  function extractItemBasicData(item) {
    var result = {
      orderNum: '',
      clientName: '',
      emissao: '',
      totalStr: '',
      status: '',
      internalId: ''
    };

    // Nome do cliente
    var h2 = item.querySelector('h2.mat-line');
    if (h2) result.clientName = h2.textContent.trim();

    // Info do pedido (Nº, Emitido em, Total)
    var h3s = item.querySelectorAll('h3.mat-line');
    if (h3s.length > 0) {
      var text = h3s[0].textContent;

      var numMatch = text.match(/Nº:\s*([\d.]+)/);
      if (numMatch) result.orderNum = numMatch[1];

      var dateMatch = text.match(/Emitido em:\s*([\d/]+ [\d:]+)/);
      if (dateMatch) result.emissao = dateMatch[1];

      var totalMatch = text.match(/Total:\s*(R\$[\s\d.,]+)/);
      if (totalMatch) result.totalStr = totalMatch[1].trim();
    }

    // Status via gw-label
    var labels = item.querySelectorAll('gw-label');
    for (var i = 0; i < labels.length; i++) {
      var t = labels[i].textContent.trim();
      if (/conclu|aberto|cancel/i.test(t)) {
        result.status = t;
        break;
      }
    }

    // ID interno (somente Em aberto tem link de edicao)
    var editLink = item.querySelector('a[mattooltip="Editar pedido"]');
    if (editLink) {
      var href = editLink.getAttribute('href') || '';
      var idMatch = href.match(/\/pedidos\/(\d+)\//);
      if (idMatch) result.internalId = idMatch[1];
    }

    return result;
  }

  /** Verifica se o status indica "Concluído" */
  function isStatusConcluido(statusText) {
    if (!statusText) return false;
    return statusText.toLowerCase().indexOf('conclu') !== -1;
  }

  // =====================================================================
  // PAGINA DE DETALHES (gw-order-detail) - fonte de verdade
  // =====================================================================

  /**
   * Extrai dados da pagina de visualizacao do pedido.
   *
   * Campos disponiveis no DOM (texto, NAO form fields):
   *   Número, Emissão, Cadastrado em, Cadastrado por,
   *   Alterado em, Alterado por, Situação,
   *   Nome, Apelido, CPF/CNPJ, Endereço, Celular, E-mail
   *   Produtos (mat-table), Valores, Pagamentos
   *
   * NOTA: O vendedor e identificado pelo campo "Cadastrado por" na pagina.
   *   Tambem tenta obter via dados da API interceptados pelo interceptor.js.
   */
  function extractViewPageData() {
    var data = {
      numeroPedido: '',
      dataEmissao: '',
      dataConclusao: '',
      alteradoEm: '',
      alteradoPor: '',
      cadastradoEm: '',
      cadastradoPor: '',
      status: '',
      cliente: '',
      clienteCpfCnpj: '',
      clienteEndereco: '',
      clienteTelefone: '',
      clienteEmail: '',
      vendedor: '',
      valorTotal: 0,
      valorSubtotal: 0,
      valorDesconto: 0,
      valorFrete: 0,
      formaPagamento: '',
      comissao: 0,
      percentualComissao: 0,
      observacao: '',
      itens: []
    };

    var allText = document.body.innerText;

    // Helper: extrai valor de campo baseado no label
    // O GDOOR concatena label+valor sem separador: "Numero1.283", "Cadastrado porNome"
    function extractField(label) {
      var patterns = [
        new RegExp(label + '\\s*\\n\\s*([^\\n]+)', 'i'),
        new RegExp(label + '\\s*:\\s*([^\\n]+)', 'i'),
        new RegExp(label + '\\s*([^\\n]+)', 'i')
      ];
      for (var p = 0; p < patterns.length; p++) {
        var m = allText.match(patterns[p]);
        if (m && m[1].trim()) return m[1].trim();
      }
      return '';
    }

    // --- Campos do cabecalho ---
    data.numeroPedido = extractField('Número');
    data.dataEmissao = extractField('Emissão');
    data.cadastradoEm = extractField('Cadastrado em');
    data.cadastradoPor = extractField('Cadastrado por');
    data.alteradoEm = extractField('Alterado em');
    data.alteradoPor = extractField('Alterado por');
    data.observacao = extractField('Informações adicionais');

    // "Alterado em" como proxy para "Data de conclusão" (somente parte da data)
    var dateOnly = (data.alteradoEm.match(/\d{2}\/\d{2}\/\d{4}/) || [''])[0];
    data.dataConclusao = dateOnly;

    // Status via gw-label
    var statusEl = document.querySelector('gw-order-detail gw-label');
    if (statusEl) data.status = statusEl.textContent.trim();
    if (!data.status) data.status = extractField('Situação');

    // --- Destinatario ---
    data.cliente = extractField('Nome');
    data.clienteCpfCnpj = extractField('CPF') || extractField('CNPJ');
    data.clienteEndereco = extractField('Endereço');
    data.clienteTelefone = extractField('Celular') || extractField('Telefone');
    data.clienteEmail = extractField('E-mail');

    // --- Produtos (mat-table com mat-row/mat-cell) ---
    // O mat-table tem uma coluna extra no inicio (indice 0 vazio/checkbox)
    // Colunas reais: [0]=vazio | [1]=Item | [2]=Produto | [3]=Cod.barras | [4]=Origem | [5]=Vl.unit | [6]=Qtd | [7]=Desc | [8]=Total
    var matRows = document.querySelectorAll('gw-product-items-list mat-table mat-row');
    data.itens = Array.from(matRows).map(function (row) {
      var cells = row.querySelectorAll('mat-cell');
      var nc = cells.length;
      // Detecta offset: se cells[0] esta vazio, offset=1; senao offset=0
      var offset = (nc > 8 || (cells[0] && cells[0].textContent.trim() === '')) ? 1 : 0;
      var prodText = cells[1 + offset] ? cells[1 + offset].textContent.trim() : '';
      var qtyText = cells[5 + offset] ? cells[5 + offset].textContent.trim() : '0';
      var qtyNum = parseFloat(qtyText.replace(/[^\d,.\-]/g, '').replace(',', '.')) || 0;
      var unit = qtyText.replace(/[\d,.\s]+/g, '').trim();

      return {
        codigo: (prodText.match(/#(\d+)/) || ['', ''])[1],
        descricao: prodText.replace(/#\d+\s*-\s*/, '').trim(),
        codigoBarras: cells[2 + offset] ? cells[2 + offset].textContent.trim() : '',
        origemPreco: cells[3 + offset] ? cells[3 + offset].textContent.trim() : '',
        valorUnitario: parseReal(cells[4 + offset] ? cells[4 + offset].textContent : ''),
        quantidade: qtyNum,
        unidade: unit || 'UNID',
        desconto: parseReal(cells[6 + offset] ? cells[6 + offset].textContent : ''),
        valorTotal: parseReal(cells[7 + offset] ? cells[7 + offset].textContent : '')
      };
    });

    // --- Valores totais (extraidos do texto visivel) ---
    var totalPedido = allText.match(/Total do pedido\s*\n?\s*(R\$[\s\d.,]+)/i);
    if (totalPedido) data.valorTotal = parseReal(totalPedido[1]);

    var subtotal = allText.match(/Produtos\s*\n?\s*(R\$[\s\d.,]+)/i);
    if (subtotal) data.valorSubtotal = parseReal(subtotal[1]);

    var frete = allText.match(/Frete\s*\n?\s*(R\$[\s\d.,]+)/i);
    if (frete) data.valorFrete = parseReal(frete[1]);

    var desconto = allText.match(/Descontos totais\s*\n?\s*(R\$[\s\d.,]+)/i);
    if (desconto) data.valorDesconto = parseReal(desconto[1]);

    // --- Pagamentos ---
    // Tenta multiplos seletores: HTML table, mat-table, e por ultimo extrai do texto
    var payments = [];

    // Tentativa 1: HTML table dentro de gw-document-payments-list
    var paymentRows = document.querySelectorAll('gw-document-payments-list table tbody tr');
    paymentRows.forEach(function (row) {
      var cells = row.querySelectorAll('td');
      if (cells.length >= 2) {
        payments.push({ forma: cells[0].textContent.trim(), valor: cells[1].textContent.trim() });
      }
    });

    // Tentativa 2: mat-table dentro de gw-document-payments-list
    if (payments.length === 0) {
      var matPaymentRows = document.querySelectorAll('gw-document-payments-list mat-table mat-row');
      matPaymentRows.forEach(function (row) {
        var cells = row.querySelectorAll('mat-cell');
        if (cells.length >= 2) {
          payments.push({ forma: cells[0].textContent.trim(), valor: cells[1].textContent.trim() });
        }
      });
    }

    // Tentativa 3: Extrai do texto visivel (formato: secao Pagamentos seguida de linhas forma/valor)
    if (payments.length === 0) {
      var paySection = allText.match(/Pagamentos\s*\n(?:Pagamento\s*\n)?(?:Valor\s*\n)?(?:A[çc][õo]es\s*\n)?([\s\S]*?)(?:\nInforma[çc][õo]es adicionais|\nAcesso|$)/i);
      if (paySection) {
        var payLines = paySection[1].trim().split('\n').filter(function(l) { return l.trim(); });
        // Cada par de linhas e forma + valor
        for (var pl = 0; pl < payLines.length - 1; pl += 2) {
          var forma = payLines[pl].trim();
          var valor = payLines[pl + 1].trim();
          if (forma && /R\$/.test(valor)) {
            payments.push({ forma: forma, valor: valor });
          }
        }
      }
    }

    if (payments.length > 0) {
      data.formaPagamento = payments.map(function (p) { return p.forma + ' (' + p.valor + ')'; }).join(', ');
    }

    // --- Vendedor = "Cadastrado por" (campo presente na pagina de detalhes) ---
    if (data.cadastradoPor) {
      data.vendedor = data.cadastradoPor;
    }

    // --- Fallback: Vendedor via dados da API (interceptor.js) ---
    if (!data.vendedor && appState.lastApiResponse) {
      var api = appState.lastApiResponse;
      var vendedor = '';
      if (api.vendedor && typeof api.vendedor === 'string') {
        vendedor = api.vendedor;
      } else if (api.vendedor && api.vendedor.nome) {
        vendedor = api.vendedor.nome;
      } else if (api.vendedor_nome) {
        vendedor = api.vendedor_nome;
      } else if (api.seller && typeof api.seller === 'string') {
        vendedor = api.seller;
      } else if (api.seller && api.seller.name) {
        vendedor = api.seller.name;
      }
      if (vendedor) data.vendedor = vendedor;
    }

    // Comissao da API (se disponivel)
    if (appState.lastApiResponse) {
      var apiData = appState.lastApiResponse;
      if (apiData.comissao !== undefined) data.comissao = parseFloat(apiData.comissao) || 0;
      if (apiData.percentual_comissao !== undefined) data.percentualComissao = parseFloat(apiData.percentual_comissao) || 0;
    }

    return data;
  }

  // =====================================================================
  // NAVEGACAO (SPA - Angular client-side routing)
  // =====================================================================

  /**
   * Clica no item da lista para navegar ate a pagina de detalhes.
   * Retorna o ID interno extraido da URL (/movimentos/pedidos/{id}).
   */
  async function clickOrderItem(item) {
    var textArea = item.querySelector('.mat-list-text');
    if (!textArea) throw new Error('Area de texto do item nao encontrada');

    appState.lastApiResponse = null; // Reset para capturar nova resposta

    await smoothScrollTo(item);
    await humanDelay(300, 700);
    textArea.click();

    // Aguarda pagina de detalhes carregar
    await waitFor('gw-order-detail', 15000);
    await humanDelay(800, 1200);

    // Aguarda interceptor capturar a resposta da API
    await sleep(500);

    // Extrai ID interno da URL
    var urlMatch = window.location.pathname.match(/\/pedidos\/(\d+)/);
    return urlMatch ? urlMatch[1] : '';
  }

  /**
   * Volta para a lista de pedidos usando history.back().
   * Preserva o estado de paginacao do Angular.
   */
  async function navigateBackToList() {
    if (isSessionExpired()) throw new Error(SESSION_EXPIRED_MSG);
    window.history.back();
    await sleep(500);
    if (isSessionExpired()) throw new Error(SESSION_EXPIRED_MSG);

    try {
      await waitFor('gw-standard-list mat-list-item', 10000);
      // Aguarda estabilizacao: a lista precisa renderizar todos os itens
      await sleep(1000);
      // Verifica se o paginator esta presente (indica lista completamente carregada)
      try {
        await waitFor('mat-paginator', 5000);
      } catch (e) { /* sem paginator = lista unica, ok */ }
      await humanDelay(500, 800);
    } catch (e) {
      if (isSessionExpired()) throw new Error(SESSION_EXPIRED_MSG);
      // Fallback: clica no link do sidebar (SPA, nao recarrega)
      log('history.back() falhou, tentando sidebar...', 'warn');
      var navClicked = false;
      var allLinks = document.querySelectorAll('a');
      for (var al = 0; al < allLinks.length; al++) {
        var href = allLinks[al].getAttribute('href') || '';
        if (href === '/movimentos/pedidos' || href.indexOf('/movimentos/pedidos') === 0) {
          allLinks[al].click();
          navClicked = true;
          break;
        }
      }
      if (!navClicked) {
        history.pushState(null, '', '/movimentos/pedidos');
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
      await sleep(2000);
      await waitFor('gw-standard-list mat-list-item', 15000);
      await humanDelay(800, 1200);
    }
  }

  /**
   * Garante que estamos na pagina correta apos voltar da navegacao.
   * Se a paginacao resetou, renavega ate a pagina esperada.
   */
  async function ensureCorrectPage(expectedPage) {
    var pag = detectPagination();
    if (pag.currentPage === expectedPage) return;

    log('Renavegando para pagina ' + expectedPage + ' (atual: ' + pag.currentPage + ')', 'warn');
    while (pag.currentPage < expectedPage) {
      var nextBtn = document.querySelector('button.mat-paginator-navigation-next');
      if (!nextBtn || nextBtn.disabled) break;
      nextBtn.click();
      await sleep(1500);
      await waitFor('gw-standard-list mat-list-item', 10000);
      await sleep(500);
      pag = detectPagination();
    }
  }

  // =====================================================================
  // PAGINACAO (mat-paginator)
  // =====================================================================

  /**
   * Detecta estado atual da paginacao.
   * Formato do label: "1 – 10 / 1279" (pode usar - ou –)
   */
  function detectPagination() {
    var paginator = document.querySelector('mat-paginator');
    if (!paginator) return { currentPage: 1, totalPages: 1, totalItems: 0 };

    var rangeLabel = paginator.querySelector('.mat-paginator-range-label');
    if (rangeLabel) {
      var match = rangeLabel.textContent.match(/(\d+)\s*[-–]\s*(\d+)\s*\/\s*(\d+)/);
      if (match) {
        var first = parseInt(match[1]);
        var last = parseInt(match[2]);
        var totalItems = parseInt(match[3]);
        var pageSize = last - first + 1;
        var currentPage = Math.ceil(first / pageSize);
        return {
          currentPage: currentPage,
          totalPages: Math.ceil(totalItems / pageSize),
          totalItems: totalItems,
          pageSize: pageSize
        };
      }
    }
    return { currentPage: 1, totalPages: 1, totalItems: 0 };
  }

  /** Navega para proxima pagina */
  async function goToNextPage() {
    var nextBtn = document.querySelector('button.mat-paginator-navigation-next');
    if (!nextBtn || nextBtn.disabled) return false;

    await smoothScrollTo(nextBtn);
    await humanDelay(400, 900);
    nextBtn.click();
    appState.currentPage++;
    log('Pagina ' + appState.currentPage + '...');

    await sleep(2000);
    await waitFor('gw-standard-list mat-list-item', 12000);
    await humanDelay(800, 1200);
    return true;
  }

  // =====================================================================
  // PRE-FILTRAGEM: URL + UI FALLBACK
  // =====================================================================

  /**
   * Expande o range de datas para o filtro de emissao na URL.
   * O filtro URL usa data de EMISSAO, mas queremos filtrar por CONCLUSAO.
   * Para pegar pedidos emitidos no mes anterior mas concluidos no periodo,
   * expandimos o inicio em 1 mes para tras.
   * Ex: filtro Marco -> busca desde Fevereiro (Fev, Mar).
   */
  function expandDateRange(dateFrom) {
    if (!dateFrom) return '';
    var d = new Date(dateFrom + 'T00:00:00');
    d.setMonth(d.getMonth() - 2);
    var yyyy = d.getFullYear();
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  }

  /**
   * Define valor em um input Angular Material (datepicker ou texto).
   * Angular nao detecta .value = x; precisa disparar eventos.
   */
  function setAngularInput(input, value) {
    var nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeInputValueSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Navega para a lista de pedidos pre-filtrada.
   *
   * Estrategia:
   *   O SPA Angular perde o content script em full reload, entao:
   *   1. Se ja esta em /movimentos/pedidos, nao navega
   *   2. Se nao, clica no link "Pedidos de venda" no sidebar (navegacao SPA interna)
   *   3. Aplica filtro via UI: icone filtro -> Faturados -> datas -> Aplicar
   */
  async function navigateToFilteredList(dateFrom, dateTo) {
    var expandedStart = expandDateRange(dateFrom);
    var onPedidos = window.location.pathname.indexOf('/movimentos/pedidos') !== -1;

    if (!onPedidos) {
      log('Navegando para pagina de pedidos via sidebar...');

      // Clica no link "Pedidos de venda" no sidebar (navegacao SPA, sem reload)
      var navClicked = false;
      var sideLinks = document.querySelectorAll('a[routerlink], a[href*="/movimentos/pedidos"]');
      for (var sl = 0; sl < sideLinks.length; sl++) {
        var linkText = sideLinks[sl].textContent.trim().toLowerCase();
        if (linkText.indexOf('pedidos') !== -1 && linkText.indexOf('venda') !== -1) {
          sideLinks[sl].click();
          navClicked = true;
          log('Clicou em "Pedidos de venda" no sidebar');
          break;
        }
      }

      // Fallback: tenta qualquer link que leve para /movimentos/pedidos
      if (!navClicked) {
        var allLinks = document.querySelectorAll('a');
        for (var al = 0; al < allLinks.length; al++) {
          var href = allLinks[al].getAttribute('href') || '';
          if (href === '/movimentos/pedidos' || href.indexOf('/movimentos/pedidos') === 0) {
            allLinks[al].click();
            navClicked = true;
            log('Clicou em link para pedidos');
            break;
          }
        }
      }

      // Ultimo fallback: usa Angular router via history API (nao causa reload)
      if (!navClicked) {
        log('Sidebar nao encontrado, usando history.pushState...', 'warn');
        history.pushState(null, '', '/movimentos/pedidos');
        window.dispatchEvent(new PopStateEvent('popstate'));
      }

      // Aguarda a lista carregar
      await sleep(2000);
      try {
        await waitFor('gw-standard-list mat-list-item', 20000);
      } catch (e) {
        await sleep(3000);
      }
      await humanDelay(1000, 2000);
    } else {
      log('Ja estamos na pagina de pedidos');
      // Aguarda a toolbar/lista carregar completamente antes de aplicar filtro
      try {
        await waitFor('mat-icon[svgicon="filter"]', 10000);
      } catch (e) {
        // Vai tentar de novo no applyFilterViaUI
      }
      await humanDelay(500, 1000);
    }

    // Aplica filtro via UI
    log('Aplicando filtro via UI (Faturados, emissao: ' + expandedStart + ' a ' + dateTo + ')...');
    await applyFilterViaUI(expandedStart, dateTo);

    // Aguarda lista estabilizar
    await humanDelay(500, 1000);
  }

  /**
   * Fallback: aplica filtro via interface do usuario.
   * Clica no icone filtro, preenche campos e clica Aplicar.
   */
  async function applyFilterViaUI(startDate, endDate) {
    // 1. Aguarda e clica no icone de filtro (botao com mat-icon svgicon="filter")
    var filterIcon = null;
    try {
      filterIcon = await waitFor('mat-icon[svgicon="filter"]', 10000);
    } catch (e) {
      log('Aguardando icone de filtro expirou, tentando seletor alternativo...', 'warn');
      // Tenta botao generico de filtro
      var buttons = document.querySelectorAll('button[mat-icon-button]');
      for (var b = 0; b < buttons.length; b++) {
        var icon = buttons[b].querySelector('mat-icon[svgicon="filter"]');
        if (icon) { filterIcon = icon; break; }
      }
    }
    if (!filterIcon) {
      sendAlert('Icone de filtro nao encontrado na pagina', 'error');
      return;
    }

    var filterBtn = filterIcon.closest('button') || filterIcon;
    await smoothScrollTo(filterBtn);
    await humanDelay(300, 600);
    filterBtn.click();
    log('Clicou no icone de filtro');

    // 2. Aguarda painel de filtros abrir
    try {
      await waitForVisible('gw-invoices-lists-filters', 8000);
    } catch (e) {
      // Tenta o mat-card
      await waitForVisible('mat-card.other-panels', 8000);
    }
    await humanDelay(500, 800);

    // 3. Seleciona Status = "Faturados"
    var statusSelect = document.querySelector('mat-select[name="status"]');
    if (statusSelect) {
      await smoothScrollTo(statusSelect);
      await humanDelay(200, 400);
      statusSelect.click();
      await sleep(600);

      // Aguarda overlay com opcoes
      try {
        await waitFor('.cdk-overlay-pane mat-option', 5000);
      } catch (e) {
        // Tenta plain mat-option
        await sleep(1000);
      }

      // Procura opcao "Faturados" ou "Concluído"
      var options = document.querySelectorAll('mat-option');
      var found = false;
      for (var o = 0; o < options.length; o++) {
        var txt = options[o].textContent.trim().toLowerCase();
        if (txt.indexOf('faturad') !== -1 || txt.indexOf('conclu') !== -1) {
          options[o].click();
          found = true;
          log('Selecionou status: ' + options[o].textContent.trim());
          break;
        }
      }
      if (!found) {
        log('Opcao "Faturados" nao encontrada no dropdown de status', 'warn');
      }
      await humanDelay(400, 700);
    }

    // 4. Define Data inicial
    var startInput = document.querySelector('input[name="start"]');
    if (startInput) {
      // Formata para dd/mm/yyyy (formato BR que o datepicker espera)
      var sd = new Date(startDate + 'T00:00:00');
      var startBR = sd.toLocaleDateString('pt-BR');
      startInput.focus();
      await sleep(200);
      setAngularInput(startInput, startBR);
      startInput.blur();
      log('Data inicial: ' + startBR);
      await humanDelay(300, 500);
    }

    // 5. Define Data final
    var endInput = document.querySelector('input[name="end"]');
    if (endInput) {
      var ed = new Date(endDate + 'T00:00:00');
      var endBR = ed.toLocaleDateString('pt-BR');
      endInput.focus();
      await sleep(200);
      setAngularInput(endInput, endBR);
      endInput.blur();
      log('Data final: ' + endBR);
      await humanDelay(300, 500);
    }

    // 6. Clica "Aplicar" — aguarda com retry (Angular pode re-renderizar o form)
    var applyBtn = null;
    var applySelectors = [
      'gw-invoices-lists-filters button[type="submit"]',
      'gw-invoices-lists-filters form button',
      'gw-invoices-lists-filters button'
    ];

    // Tenta waitFor com o seletor principal primeiro
    try {
      applyBtn = await waitFor(applySelectors[0], 5000);
    } catch (e) {
      // Angular pode ter re-renderizado — tenta seletores alternativos
      for (var si = 1; si < applySelectors.length && !applyBtn; si++) {
        var candidates = document.querySelectorAll(applySelectors[si]);
        for (var ci = 0; ci < candidates.length; ci++) {
          if (candidates[ci].textContent.trim().toLowerCase().indexOf('aplicar') !== -1) {
            applyBtn = candidates[ci];
            break;
          }
        }
      }
    }

    // Ultimo fallback: qualquer botao visivel com texto "Aplicar" na pagina
    if (!applyBtn) {
      var pageBtns = document.querySelectorAll('button');
      for (var pb = 0; pb < pageBtns.length; pb++) {
        var btnText = pageBtns[pb].textContent.trim().toLowerCase();
        if (btnText === 'aplicar' && pageBtns[pb].offsetParent !== null) {
          applyBtn = pageBtns[pb];
          break;
        }
      }
    }

    if (applyBtn) {
      await smoothScrollTo(applyBtn);
      await humanDelay(300, 600);
      applyBtn.click();
      log('Clicou em Aplicar filtros');

      // Aguarda lista recarregar
      await sleep(2000);
      try {
        await waitFor('gw-standard-list mat-list-item', 15000);
      } catch (e) {
        await sleep(3000);
      }
      await humanDelay(800, 1200);
    } else {
      sendAlert('Botao Aplicar nao encontrado no painel de filtros', 'error');
    }
  }

  // =====================================================================
  // REGRA DE NEGOCIO - FILTRO POR DATA DE CONCLUSAO
  // =====================================================================

  /**
   * Verifica se a data de conclusao (Alterado em) esta no periodo.
   * REGRA CENTRAL: comissao = data de conclusao, NAO emissao.
   */
  function isDataConclusaoNoPeriodo(dataConclusaoStr) {
    if (!dataConclusaoStr) return false;
    var dc = parseDate(dataConclusaoStr);
    if (!dc) return false;

    if (appState.dateFrom) {
      var from = new Date(appState.dateFrom + 'T00:00:00');
      if (dc < from) return false;
    }
    if (appState.dateTo) {
      var to = new Date(appState.dateTo + 'T23:59:59');
      if (dc > to) return false;
    }
    return true;
  }

  // =====================================================================
  // PROCESSAMENTO PRINCIPAL
  // =====================================================================

  /**
   * Processa todos os pedidos de uma pagina.
   *
   * FLUXO POR ITEM (com cache):
   *   1. Le dados basicos do mat-list-item (triagem)
   *   2. Se numero ja processado -> pula (duplicata)
   *   3. Consulta cache:
   *      a. Cache hit valido (concluido/cancelado + TTL ok) -> usa dados do cache, SEM abrir pagina
   *      b. Cache miss ou expirado -> abre pagina de detalhes, extrai, atualiza cache
   *   4. Se status != "Concluído" -> ignora (audit)
   *   5. Se "Concluído" -> filtra por data de conclusao no periodo
   *   6. Se abriu pagina -> volta para lista (history.back)
   */
  async function processPage() {
    var items = getOrderItems();
    log('Pagina ' + appState.currentPage + ': ' + items.length + ' itens');

    var cache = loadCache();
    var cacheDirty = false;

    for (var i = 0; i < items.length; i++) {
      await checkPauseStop();

      var item = items[i];
      var basic = extractItemBasicData(item);
      appState.totalRowsSeen++;

      // Pula itens sem numero
      if (!basic.orderNum) {
        log('Item ' + (i + 1) + ' sem numero, pulando', 'warn');
        continue;
      }

      // Protecao contra duplicatas
      if (appState.processedIds.has(basic.orderNum)) {
        auditLog(basic.orderNum, 'DESCARTADO_DUPLICATA', 'Ja processado');
        continue;
      }

      // --- VERIFICACAO DO CACHE ---
      var cached = getCacheEntry(cache, basic.orderNum);
      var cacheValid = isCacheEntryValid(cached);

      if (cacheValid) {
        // CACHE HIT: pedido concluido/cancelado com TTL valido
        // Usa dados do cache diretamente, SEM navegar para pagina de detalhes
        appState.cacheStats.hits++;

        var cachedStatus = (cached.status || '').toLowerCase();
        var isCachedConcluido = cachedStatus.indexOf('conclu') !== -1;

        if (!isCachedConcluido) {
          // Cancelado ou outro status final -> pular
          appState.skippedNotDone++;
          appState.processedIds.add(basic.orderNum);
          auditLog(basic.orderNum, 'CACHE_SKIP_STATUS', 'Cache: status="' + cached.status + '"');
          progress(appState.processedIds.size);
          continue;
        }

        // Concluido no cache -> verifica data de conclusao
        if (isDataConclusaoNoPeriodo(cached.data_conclusao)) {
          appState.data.push(buildOrderFromCacheEntry(cached, basic.orderNum));
          appState.processedIds.add(basic.orderNum);

          auditLog(basic.orderNum, 'CACHE_HIT',
            'Conclusao: ' + cached.data_conclusao + ' - no periodo (cache)'
          );
          log('[' + appState.processedIds.size + '] Pedido ' + basic.orderNum + ' CACHE HIT - Conclusao: ' + cached.data_conclusao + ', Total: R$ ' + (cached.total || 0).toFixed(2).replace('.', ','), 'success');

        } else {
          // Concluido mas fora do periodo
          appState.discarded.push({
            id: basic.orderNum,
            dataConclusao: cached.data_conclusao || 'N/A',
            valorTotal: cached.total,
            vendedor: cached.vendedor
          });
          appState.processedIds.add(basic.orderNum);

          auditLog(basic.orderNum, 'CACHE_HIT_FORA_PERIODO',
            'Conclusao: ' + (cached.data_conclusao || 'N/A') + ' - fora do periodo (cache)'
          );
          log('Pedido ' + basic.orderNum + ' fora do periodo via cache (conclusao: ' + (cached.data_conclusao || 'N/A') + ')');
        }

        progress(appState.processedIds.size);

        // Checkpoint a cada 5 pedidos
        if (appState.processedIds.size % 5 === 0) {
          saveCheckpoint();
          sendMsg('DATA_UPDATE', { data: appState.data });
        }

        continue; // PULA para proximo item - NENHUMA navegacao de pagina!
      }

      // --- CACHE MISS ou EXPIRADO ---
      if (cached) {
        appState.cacheStats.revalidated++;
        auditLog(basic.orderNum, 'CACHE_REVALIDANDO', 'TTL expirado ou status pendente, revalidando...');
      } else {
        appState.cacheStats.misses++;
      }

      // Filtro por status - so processa CONCLUIDOS (lista ja filtrada para Faturados)
      if (!isStatusConcluido(basic.status)) {
        appState.skippedNotDone++;
        appState.processedIds.add(basic.orderNum);
        auditLog(basic.orderNum, 'DESCARTADO_STATUS', 'Status="' + basic.status + '"');
        progress(appState.processedIds.size);
        continue;
      }

      log('[' + (appState.processedIds.size + 1) + '] Pedido ' + basic.orderNum + ' (' + basic.clientName + ') - CONCLUIDO, abrindo...');

      try {
        // Clica no item para navegar ate a pagina de detalhes
        var internalId = await withRetry(async function () {
          if (isSessionExpired()) throw new Error(SESSION_EXPIRED_MSG);
          var freshItems = getOrderItems();
          if (i >= freshItems.length) {
            if (isSessionExpired()) throw new Error(SESSION_EXPIRED_MSG);
            throw new Error('Item ' + i + ' fora do range (lista tem ' + freshItems.length + ' itens)');
          }
          return await clickOrderItem(freshItems[i]);
        }, 'abrir pedido ' + basic.orderNum);

        // Extrai dados da pagina de detalhes
        var viewData = extractViewPageData();
        if (!viewData) throw new Error('Falha ao extrair dados da pagina');

        // Volta para a lista
        await navigateBackToList();
        await ensureCorrectPage(appState.currentPage);

        // Re-obtem items apos navegacao com estabilizacao
        // Aguarda a lista recarregar completamente (pode demorar no SPA)
        items = getOrderItems();
        if (items.length < 2) {
          log('Lista parcialmente carregada (' + items.length + ' itens), aguardando...', 'warn');
          await sleep(2000);
          items = getOrderItems();
          if (items.length < 2) {
            await sleep(3000);
            items = getOrderItems();
          }
        }

        // --- Deteccao de transicao de status ---
        if (cached && cached.status) {
          var oldStatus = (cached.status || '').toLowerCase();
          var newStatus = (viewData.status || '').toLowerCase();
          if (oldStatus !== newStatus) {
            appState.cacheStats.transitions++;
            auditLog(basic.orderNum, 'TRANSICAO_STATUS',
              'Status mudou: "' + cached.status + '" -> "' + viewData.status + '"'
            );
            log('Pedido ' + basic.orderNum + ' TRANSICAO: ' + cached.status + ' -> ' + viewData.status, 'warn');

            // Guarda status anterior na entrada do cache
            viewData._statusAnterior = cached.status;
          }
        }

        // --- Atualiza cache com dados extraidos ---
        setCacheEntry(cache, basic.orderNum, viewData);
        cacheDirty = true;

        // Validacoes
        var orderAlerts = validateOrder(viewData);

        // REGRA CENTRAL: filtro por data de conclusao
        if (isDataConclusaoNoPeriodo(viewData.dataConclusao)) {
          appState.data.push(Object.assign({}, viewData, {
            _source: 'view_page',
            _internalId: internalId,
            _orderNum: basic.orderNum,
            _alerts: orderAlerts
          }));
          appState.processedIds.add(basic.orderNum);

          auditLog(basic.orderNum, 'INCLUIDO',
            'Conclusao (Alterado em): ' + viewData.dataConclusao + ' - no periodo ' + formatDateBR(appState.dateFrom) + ' a ' + formatDateBR(appState.dateTo)
          );
          log('Pedido ' + basic.orderNum + ' INCLUIDO - Conclusao: ' + viewData.dataConclusao + ', Total: R$ ' + (viewData.valorTotal || 0).toFixed(2).replace('.', ','), 'success');

        } else {
          appState.discarded.push({
            id: basic.orderNum,
            dataConclusao: viewData.dataConclusao || 'N/A',
            valorTotal: viewData.valorTotal,
            vendedor: viewData.vendedor
          });
          appState.processedIds.add(basic.orderNum);

          auditLog(basic.orderNum, 'DESCARTADO_DATA',
            'Conclusao: ' + (viewData.dataConclusao || 'N/A') + ' - fora do periodo ' + formatDateBR(appState.dateFrom) + ' a ' + formatDateBR(appState.dateTo)
          );
          log('Pedido ' + basic.orderNum + ' fora do periodo (conclusao: ' + (viewData.dataConclusao || 'N/A') + ')', 'warn');
        }

        progress(appState.processedIds.size);

        // Checkpoint + salva cache a cada 5 pedidos
        if (appState.processedIds.size % 5 === 0) {
          saveCheckpoint();
          if (cacheDirty) { saveCache(cache); cacheDirty = false; }
          sendMsg('DATA_UPDATE', { data: appState.data });
        }

      } catch (e) {
        if (e.message === 'STOPPED_BY_USER') throw e;
        if (e.message === SESSION_EXPIRED_MSG || isSessionExpired()) {
          auditLog(basic.orderNum, 'SESSAO_EXPIRADA', 'Sessao expirou durante processamento');
          throw new Error(SESSION_EXPIRED_MSG);
        }

        appState.processedIds.add(basic.orderNum);
        auditLog(basic.orderNum, 'ERRO', 'Falha: ' + e.message);
        log('Erro pedido ' + basic.orderNum + ': ' + e.message, 'error');
        sendAlert('Erro pedido ' + basic.orderNum + ': ' + e.message);

        try {
          if (!document.querySelector('gw-standard-list')) {
            await navigateBackToList();
            await ensureCorrectPage(appState.currentPage);
          }
        } catch (navErr) {
          if (navErr.message === SESSION_EXPIRED_MSG || isSessionExpired()) {
            throw new Error(SESSION_EXPIRED_MSG);
          }
          log('Erro ao voltar para lista: ' + navErr.message, 'error');
        }

        items = getOrderItems();
        if (items.length < 2) {
          await sleep(2000);
          items = getOrderItems();
        }
        await humanDelay(800, 1500);
      }

      // Delay humano entre pedidos (so para os que abriram pagina)
      await humanDelay(600, 1200);
    }

    // Salva cache ao final da pagina
    if (cacheDirty) saveCache(cache);
  }

  // =====================================================================
  // MODO RAPIDO: BUSCA DIRETA VIA API (sem navegacao DOM)
  //
  // Em vez de clicar em cada pedido e aguardar a pagina carregar (~6s/pedido),
  // chama a REST API do GDOOR diretamente com fetch() em paralelo (5 por vez).
  // Resultado tipico: 250 pedidos em ~1-2 minutos em vez de ~25 minutos.
  // =====================================================================

  var API_BASE = 'https://api.gdoorweb.com.br';
  var API_CONCURRENCY = 20; // requisicoes em paralelo (janela deslizante)

  // Proxy de API via MAIN world (interceptor.js)
  // O interceptor roda como XHR nativo no contexto da pagina,
  // garantindo cookies de sessao e compatibilidade CORS.
  var FETCH_REQ = '__gdoor_fetch_req';
  var FETCH_RESP = '__gdoor_fetch_resp';
  var _apiFetchId = 0;
  var _apiMode = 'direct'; // 'direct' (fetch do content script com auth headers)

  /**
   * Tenta proxy via interceptor.js (MAIN world XHR).
   * Se o proxy nao responder (interceptor nao carregado), timeout de 8s.
   */
  function apiFetchViaProxy(path) {
    return new Promise(function (resolve, reject) {
      var id = ++_apiFetchId;
      var settled = false;

      function onResp(e) {
        var resp;
        try { resp = JSON.parse(e.detail); } catch (ex) { return; }
        if (resp.id !== id) return;
        settled = true;
        window.removeEventListener(FETCH_RESP, onResp);
        clearTimeout(timer);
        if (resp.error) reject(new Error(resp.error));
        else resolve(resp.data);
      }

      window.addEventListener(FETCH_RESP, onResp);
      window.dispatchEvent(new CustomEvent(FETCH_REQ, {
        detail: JSON.stringify({
          id: id,
          url: API_BASE + path,
          headers: { 'Accept': 'application/json' }
        })
      }));

      // Timeout curto (8s) — se o interceptor nao esta carregado, falha rapido
      var timer = setTimeout(function () {
        if (!settled) {
          settled = true;
          window.removeEventListener(FETCH_RESP, onResp);
          reject(new Error('Proxy timeout (8s) — interceptor pode nao estar carregado'));
        }
      }, 8000);
    });
  }

  /**
   * Busca auth headers do Angular via interceptor (MAIN world).
   * Retorna um objeto com os headers capturados (ex: {Authorization: 'Bearer ...'}).
   */
  var _cachedAuthHeaders = null;
  function getAuthHeaders() {
    if (_cachedAuthHeaders) return Promise.resolve(_cachedAuthHeaders);
    return new Promise(function (resolve) {
      var timeout = setTimeout(function () {
        window.removeEventListener('__gdoor_auth_headers', onAuth);
        resolve({});
      }, 2000);

      function onAuth(e) {
        clearTimeout(timeout);
        window.removeEventListener('__gdoor_auth_headers', onAuth);
        try {
          _cachedAuthHeaders = JSON.parse(e.detail) || {};
        } catch (ex) {
          _cachedAuthHeaders = {};
        }
        resolve(_cachedAuthHeaders);
      }

      window.addEventListener('__gdoor_auth_headers', onAuth);
      window.dispatchEvent(new CustomEvent('__gdoor_get_auth'));
    });
  }

  /**
   * Fetch direto do content script com auth headers do Angular.
   * host_permissions permite cross-origin; auth headers autenticam a requisicao.
   */
  function apiFetchDirect(path) {
    return getAuthHeaders().then(function (authHeaders) {
      var headers = { 'Accept': 'application/json' };
      Object.keys(authHeaders).forEach(function (k) { headers[k] = authHeaders[k]; });
      return fetch(API_BASE + path, { headers: headers });
    }).then(function (resp) {
      if (!resp.ok) throw new Error('HTTP ' + resp.status + ' em ' + path);
      return resp.json();
    });
  }

  /**
   * Busca dados da API com fallback automatico.
   * Primeira chamada tenta proxy (interceptor XHR), se falhar tenta fetch direto.
   * Memoriza qual modo funciona para chamadas seguintes.
   */
  function apiFetch(path) {
    if (_apiMode === 'direct') return apiFetchDirect(path);

    return apiFetchViaProxy(path).catch(function (proxyErr) {
      log('Proxy falhou (' + proxyErr.message + '), tentando fetch direto...', 'warn');
      return apiFetchDirect(path).then(function (data) {
        _apiMode = 'direct';
        log('Fetch direto funcionou — usando modo direto para demais requisicoes', 'success');
        return data;
      }).catch(function (directErr) {
        throw new Error('Proxy: ' + proxyErr.message + ' | Direto: ' + directErr.message);
      });
    });
  }

  /**
   * Executa `fn` em todos os `items` com no maximo `limit` requisicoes simultaneas.
   * Usa janela deslizante: assim que uma conclui, ja inicia a proxima — sem esperar
   * o lote inteiro terminar (elimina o gargalo do item mais lento por lote).
   */
  async function runWithConcurrency(items, limit, fn) {
    var results = new Array(items.length);
    var idx = 0;
    async function worker() {
      while (true) {
        var i = idx;
        if (i >= items.length) break;
        idx = i + 1;
        results[i] = await fn(items[i]);
      }
    }
    var workers = [];
    var n = Math.min(limit, items.length);
    for (var w = 0; w < n; w++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  function formatDocNumber(num) {
    if (!num) return '';
    return Number(num).toLocaleString('pt-BR');
  }

  function isoToPTBR(isoStr) {
    if (!isoStr) return '';
    var d = new Date(isoStr);
    if (isNaN(d.getTime())) return '';
    var dd = String(d.getDate()).padStart(2, '0');
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var yyyy = d.getFullYear();
    var hh = String(d.getHours()).padStart(2, '0');
    var mi = String(d.getMinutes()).padStart(2, '0');
    return dd + '/' + mm + '/' + yyyy + ' ' + hh + ':' + mi;
  }

  function isoDateOnly(isoStr) {
    if (!isoStr) return '';
    return formatDateBR(isoStr.substring(0, 10)); // reuses existing formatDateBR("YYYY-MM-DD")
  }

  function formatCpfCnpjApi(doc) {
    if (!doc) return '';
    var d = String(doc).replace(/\D/g, '');
    if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    return doc;
  }

  /** Converte a resposta JSON da API de detalhe em um objeto no mesmo formato
   *  que extractViewPageData() produz, compativel com setCacheEntry e o relatorio. */
  function extractOrderFromApiData(resp) {
    var d = resp.data || resp;

    var updatedAt = d.updated_at || d.flow_at || '';
    var dataConclusao = isoDateOnly(updatedAt);

    // Vendedor: primeiro item com seller, ou created_by como fallback
    var vendedor = d.created_by || '';
    var apiItems = d.items || [];
    for (var i = 0; i < apiItems.length; i++) {
      if (apiItems[i].seller && apiItems[i].seller.name) {
        vendedor = apiItems[i].seller.name;
        break;
      }
    }

    // Pagamentos: tenta varios nomes de campo possiveis
    var payments = d.payments || [];
    var formas = payments.map(function (p) {
      var pm = p.payment_method || {};
      return pm.name || pm.description || p.payment_method_name || p.payment_type || p.description || p.name || p.forma || '';
    }).filter(Boolean);

    // Itens do pedido
    var itens = apiItems.map(function (item) {
      var prod = item.product || {};
      return {
        codigo: item.barcode || String(prod.id || '') || '',
        descricao: item.name || prod.name || '',
        quantidade: parseFloat(item.quantity) || 0,
        unidade: prod.measure_unit || 'UN',
        valorUnitario: parseFloat(item.unit_price) || 0,
        desconto: parseFloat(item.total_discount) || 0,
        valorTotal: parseFloat(item.total_value) || 0
      };
    });

    var isCancelled = !!d.cancelled || !!d.cancelled_at;
    var pessoa = d.person || {};

    return {
      numeroPedido: formatDocNumber(d.doc_number),
      dataEmissao: isoToPTBR(d.issued_at || d.flow_at),
      dataConclusao: dataConclusao,
      alteradoEm: isoToPTBR(updatedAt),
      alteradoPor: d.updated_by || '',
      cadastradoEm: isoToPTBR(d.created_at),
      cadastradoPor: d.created_by || '',
      status: isCancelled ? 'Cancelada' : 'Conclu\u00edda',
      cliente: pessoa.name || '',
      clienteCpfCnpj: formatCpfCnpjApi(pessoa.national_document),
      clienteEndereco: pessoa.full_address || '',
      clienteTelefone: pessoa.cell || pessoa.phone || '',
      clienteEmail: pessoa.email || '',
      vendedor: vendedor,
      valorTotal: parseFloat(d.total_invoice) || 0,
      valorSubtotal: parseFloat(d.total_products) || 0,
      valorDesconto: parseFloat(d.total_discount) || 0,
      valorFrete: parseFloat(d.total_shipping) || 0,
      formaPagamento: formas.join(', '),
      comissao: 0,
      percentualComissao: 0,
      observacao: d.additional_information || '',
      itens: itens
    };
  }

  /** Reconstroi um objeto de pedido a partir de uma entrada de cache */
  function buildOrderFromCacheEntry(cached, docNum) {
    return {
      numeroPedido: cached.numero || docNum,
      dataEmissao: cached.data_emissao,
      dataConclusao: cached.data_conclusao,
      status: cached.status,
      cliente: cached.cliente,
      clienteCpfCnpj: cached.clienteCpfCnpj || '',
      clienteEndereco: cached.clienteEndereco || '',
      clienteTelefone: cached.clienteTelefone || '',
      clienteEmail: cached.clienteEmail || '',
      vendedor: cached.vendedor,
      valorTotal: cached.total,
      valorSubtotal: cached.valorSubtotal || 0,
      valorDesconto: cached.valorDesconto || 0,
      valorFrete: cached.valorFrete || 0,
      formaPagamento: cached.pagamento,
      alteradoPor: cached.alteradoPor || '',
      comissao: cached.comissao || 0,
      percentualComissao: cached.percentualComissao || 0,
      observacao: cached.observacao || '',
      itens: cached.itens || [],
      _source: 'cache',
      _orderNum: docNum,
      _alerts: []
    };
  }

  /**
   * Modo rapido: percorre todos os pedidos via API REST em vez de navegacao DOM.
   * Pipeline paralela: busca lista da proxima pagina enquanto detalhes da atual sao processados.
   * Retorna true se teve sucesso, false se a API nao estiver acessivel (usa modo DOM).
   */
  async function startScrapingViaAPI(dateFrom, dateTo) {
    var cache = loadCache();
    var cacheDirty = false;
    var expandedStart = expandDateRange(dateFrom);
    var page = 1;
    var totalPages = Infinity;
    var listUrl = '/v1/movements/orders?limit=200&filter.status=true&filter.start=' + expandedStart + '&filter.end=' + dateTo;

    log('MODO RAPIDO ativo: API direta com ' + API_CONCURRENCY + ' pedidos em paralelo (pipeline)');
    log('Periodo de emissao expandido: ' + expandedStart + ' a ' + dateTo + ' (conclusao filtrada em seguida)');

    // Aguarda auth headers do Angular (capturados pelo interceptor)
    var authH = await getAuthHeaders();
    var authKeys = Object.keys(authH);
    if (authKeys.length > 0) {
      log('Auth headers capturados: ' + authKeys.join(', '));
    } else {
      log('Nenhum auth header capturado — API pode rejeitar (401)', 'warn');
    }

    // Busca primeira pagina
    var listResp;
    try {
      listResp = await apiFetch(listUrl + '&page=1');
    } catch (e) {
      log('Modo rapido indisponivel (' + e.message + ') - usando navegacao DOM...', 'warn');
      sendAlert('API indisponivel: ' + e.message + ' — tentando modo DOM', 'warn');
      return false;
    }

    var meta = listResp.meta || {};
    totalPages = meta.last_page || 1;
    var total = meta.total || (listResp.data || []).length;
    sendMsg('TOTAL', { total: total });
    log('Total: ' + total + ' pedidos em ' + totalPages + ' paginas (200/pagina)');
    updateStatus('run', { pages: totalPages });

    while (page <= totalPages) {
      await checkPauseStop();

      var orders = listResp.data || [];
      appState.currentPage = page;
      appState.totalRowsSeen += orders.length;

      // Separa: cache hits vs precisa buscar detalhes
      var needFetch = [];

      orders.forEach(function (o) {
        var docNum = formatDocNumber(o.doc_number);
        if (!docNum || appState.processedIds.has(docNum)) return;

        // Cancelados: pula
        if (o.cancelled_at) {
          appState.skippedNotDone++;
          appState.processedIds.add(docNum);
          progress(appState.processedIds.size);
          return;
        }

        // Pre-filtro rapido: usa updated_at da lista para evitar buscar detalhe de ordens
        // claramente fora do periodo — economia significativa de requisicoes
        if (o.updated_at) {
          var listDate = isoDateOnly(o.updated_at);
          if (!isDataConclusaoNoPeriodo(listDate)) {
            appState.discarded.push({ id: docNum, dataConclusao: listDate, valorTotal: 0, vendedor: '' });
            appState.processedIds.add(docNum);
            progress(appState.processedIds.size);
            return;
          }
        }

        // Verifica cache
        var cached = getCacheEntry(cache, docNum);
        if (isCacheEntryValid(cached)) {
          appState.cacheStats.hits++;
          var cStatus = (cached.status || '').toLowerCase();
          var isConcluido = cStatus.indexOf('conclu') !== -1;

          if (!isConcluido) {
            appState.skippedNotDone++;
          } else if (isDataConclusaoNoPeriodo(cached.data_conclusao)) {
            appState.data.push(buildOrderFromCacheEntry(cached, docNum));
            auditLog(docNum, 'CACHE_HIT', 'Conclusao: ' + cached.data_conclusao + ' (cache)');
            log('[' + (appState.data.length) + '] #' + docNum + ' CACHE HIT - ' + cached.data_conclusao, 'success');
          } else {
            appState.discarded.push({ id: docNum, dataConclusao: cached.data_conclusao, valorTotal: cached.total, vendedor: cached.vendedor });
            auditLog(docNum, 'CACHE_HIT_FORA_PERIODO', 'Conclusao: ' + cached.data_conclusao);
          }
          appState.processedIds.add(docNum);
          progress(appState.processedIds.size);
          return;
        }

        // Cache miss: agenda busca de detalhes
        appState.cacheStats.misses++;
        needFetch.push({ id: o.id, docNum: docNum });
      });

      // PIPELINE: busca detalhes da pagina atual + lista da proxima pagina em PARALELO
      var nextListPromise = null;
      if (page < totalPages) {
        nextListPromise = apiFetch(listUrl + '&page=' + (page + 1)).catch(function (e) {
          log('Erro ao buscar pagina ' + (page + 1) + ': ' + e.message, 'error');
          return null;
        });
      }

      if (needFetch.length > 0) {
        await checkPauseStop();

        var detailResults = await runWithConcurrency(needFetch, API_CONCURRENCY, function (item) {
          return apiFetch('/v1/movements/orders/' + item.id)
            .then(function (r) { return { item: item, data: r, err: null }; })
            .catch(function (e) { return { item: item, data: null, err: e }; });
        });

        detailResults.forEach(function (r) {
          var docNum = r.item.docNum;

          if (r.err || !r.data) {
            log('Erro API #' + docNum + ': ' + (r.err ? r.err.message : 'sem dados'), 'error');
            sendAlert('Erro ao buscar pedido #' + docNum + ': ' + (r.err ? r.err.message : ''));
            return;
          }

          var orderData = extractOrderFromApiData(r.data);
          if (appState.processedIds.has(docNum)) return;

          // Cancelados detectados no detalhe: descarta
          if (orderData.status && orderData.status.toLowerCase().indexOf('cancel') !== -1) {
            appState.skippedNotDone++;
            appState.processedIds.add(docNum);
            progress(appState.processedIds.size);
            return;
          }

          setCacheEntry(cache, docNum, orderData);
          cacheDirty = true;

          var orderAlerts = validateOrder(orderData);

          if (isDataConclusaoNoPeriodo(orderData.dataConclusao)) {
            appState.data.push(Object.assign({}, orderData, {
              _source: 'api_direct',
              _internalId: String(r.item.id),
              _alerts: orderAlerts
            }));
            appState.processedIds.add(docNum);
            auditLog(docNum, 'INCLUIDO', 'API: Conclusao=' + orderData.dataConclusao);
            log('[' + appState.data.length + '] #' + docNum + ' INCLUIDO - ' + orderData.dataConclusao + ' | ' + orderData.vendedor + ' | R$' + orderData.valorTotal.toFixed(2).replace('.', ','), 'success');
          } else {
            appState.processedIds.add(docNum);
            appState.discarded.push({ id: docNum, dataConclusao: orderData.dataConclusao, valorTotal: orderData.valorTotal, vendedor: orderData.vendedor });
            auditLog(docNum, 'DESCARTADO_DATA', 'API: Conclusao=' + orderData.dataConclusao);
          }

          progress(appState.processedIds.size);
        });
      }

      // Aguardar proxima pagina (já foi disparada em paralelo com detalhes)
      if (nextListPromise) {
        var nextResp = await nextListPromise;
        if (!nextResp) {
          // Erro na próxima página: tenta novamente sequencialmente
          try {
            nextResp = await apiFetch(listUrl + '&page=' + (page + 1));
          } catch (e) {
            throw new Error('Falha ao buscar pagina ' + (page + 1) + ': ' + e.message);
          }
        }
        listResp = nextResp;
      }

      // Checkpoint ao final de cada pagina (cache salvo apenas no final)
      saveCheckpoint();
      sendMsg('DATA_UPDATE', { data: appState.data });
      log('Pag. ' + page + '/' + totalPages + ': ' + appState.data.length + ' incluidos, ' + appState.discarded.length + ' descartados');

      page++;
    }

    // Salvar cache uma unica vez ao final (evita I/O pesado a cada pagina)
    if (cacheDirty) saveCache(cache);
    return true;
  }

  // =====================================================================
  // TESTE DE CONEXAO COM A API
  // =====================================================================

  async function testApiConnection(dateFrom, dateTo) {
    var results = { ok: false, steps: [] };
    var step;

    // PASSO 1: Capturar auth headers
    step = { name: 'Auth Headers', ok: false, detail: '' };
    try {
      _cachedAuthHeaders = null; // forca re-captura
      var authH = await getAuthHeaders();
      var keys = Object.keys(authH);
      if (keys.length > 0) {
        step.ok = true;
        step.detail = 'Capturados: ' + keys.join(', ');
        // Mostra prefixo do token (seguro)
        if (authH.Authorization) {
          step.detail += ' | Token: ' + authH.Authorization.substring(0, 20) + '...';
        }
      } else {
        step.detail = 'Nenhum header capturado. Navegue pelo GDOOR para gerar requisicoes Angular.';
      }
    } catch (e) {
      step.detail = 'Erro: ' + e.message;
    }
    results.steps.push(step);
    if (!step.ok) { results.error = 'Sem auth headers'; return results; }

    // PASSO 2: Listar pedidos (1 pagina, limit=5 para ser rapido)
    var expandedStart = expandDateRange(dateFrom || '2026-03-01');
    var testDateTo = dateTo || '2026-03-31';
    var listPath = '/v1/movements/orders?limit=5&filter.status=true&filter.start=' + expandedStart + '&filter.end=' + testDateTo + '&page=1';

    step = { name: 'Listar Pedidos', ok: false, detail: '' };
    try {
      var listResp = await apiFetchDirect(listPath);
      var meta = listResp.meta || {};
      var items = listResp.data || [];
      step.ok = true;
      step.detail = 'Total: ' + (meta.total || items.length) + ' pedidos, ' + (meta.last_page || 1) + ' paginas | Retornados: ' + items.length;
      step.total = meta.total || items.length;
      step.pages = meta.last_page || 1;
      step.sampleIds = items.slice(0, 3).map(function (o) {
        return { id: o.id, doc: o.doc_number, issued: (o.issued_at || '').substring(0, 10), updated: (o.updated_at || '').substring(0, 10) };
      });
    } catch (e) {
      step.detail = 'Erro: ' + e.message;
    }
    results.steps.push(step);
    if (!step.ok) { results.error = 'Falha ao listar pedidos'; return results; }

    // PASSO 3: Buscar detalhe do primeiro pedido
    var firstItem = (listResp.data || [])[0];
    step = { name: 'Detalhe do Pedido', ok: false, detail: '' };
    if (firstItem) {
      try {
        var detailResp = await apiFetchDirect('/v1/movements/orders/' + firstItem.id);
        var orderData = extractOrderFromApiData(detailResp);
        step.ok = true;
        step.detail = '#' + orderData.numeroPedido +
          ' | Emissao: ' + orderData.dataEmissao +
          ' | Conclusao: ' + orderData.dataConclusao +
          ' | Status: ' + orderData.status +
          ' | Vendedor: ' + orderData.vendedor +
          ' | Total: R$ ' + orderData.valorTotal.toFixed(2).replace('.', ',') +
          ' | Itens: ' + (orderData.itens || []).length +
          ' | Pagamento: ' + orderData.formaPagamento;

        // Verifica se data de conclusao esta no periodo
        if (dateFrom && dateTo) {
          appState.dateFrom = dateFrom;
          appState.dateTo = dateTo;
          var noPeriodo = isDataConclusaoNoPeriodo(orderData.dataConclusao);
          step.detail += ' | No periodo: ' + (noPeriodo ? 'SIM' : 'NAO');
        }
      } catch (e) {
        step.detail = 'Erro: ' + e.message;
      }
    } else {
      step.detail = 'Nenhum pedido retornado para testar detalhe';
    }
    results.steps.push(step);

    results.ok = results.steps.every(function (s) { return s.ok; });
    return results;
  }

  // =====================================================================
  // FLUXO PRINCIPAL
  // =====================================================================

  async function startScraping(dateFrom, dateTo) {
    appState.running = true;
    appState.stop = false;
    appState.paused = false;
    appState.dateFrom = dateFrom;
    appState.dateTo = dateTo;

    // Checkpoint existente?
    var checkpoint = loadCheckpoint();
    if (checkpoint && checkpoint.dateFrom === dateFrom && checkpoint.dateTo === dateTo) {
      log('Retomando checkpoint: ' + (checkpoint.processedIds || []).length + ' processados');
      appState.data = checkpoint.data || [];
      appState.discarded = checkpoint.discarded || [];
      appState.alerts = checkpoint.alerts || [];
      appState.audit = checkpoint.audit || [];
      appState.processedIds = new Set(checkpoint.processedIds || []);
      appState.currentPage = checkpoint.currentPage || 1;
      appState.skippedNotDone = checkpoint.skippedNotDone || 0;
      appState.totalRowsSeen = checkpoint.totalRowsSeen || 0;
      progress(appState.processedIds.size);
    } else {
      appState.data = [];
      appState.discarded = [];
      appState.alerts = [];
      appState.audit = [];
      appState.processedIds = new Set();
      appState.currentPage = 1;
      appState.skippedNotDone = 0;
      appState.totalRowsSeen = 0;
      clearCheckpoint();
    }

    updateStatus('run');
    log('Raspagem iniciada - Periodo de conclusao: ' + formatDateBR(dateFrom) + ' a ' + formatDateBR(dateTo));
    log('Regra: SOMENTE pedidos CONCLUIDOS com "Alterado em" no periodo');

    // Info do cache
    var cacheInfo = getCacheStats(loadCache());
    if (cacheInfo.total > 0) {
      log('Cache: ' + cacheInfo.total + ' pedidos em cache (' + cacheInfo.concluded + ' concluidos, ' + cacheInfo.pending + ' pendentes, ' + cacheInfo.cancelled + ' cancelados)');
    } else {
      log('Cache: vazio (primeira execucao ou cache limpo)');
    }

    try {
      // ETAPA 1: tenta modo rapido (API direta em paralelo)
      var apiOk = await startScrapingViaAPI(dateFrom, dateTo);

      if (apiOk) {
        // Modo rapido concluido com sucesso - pula para finalizacao
        log('Modo rapido concluido!', 'success');
      } else {
        // FALLBACK: navegacao DOM (modo original)
        log('Usando modo de navegacao DOM (fallback)...');
        log('Estrategia: pre-filtrar via URL (status=Faturados) + expandir emissao -2 meses');

        await navigateToFilteredList(dateFrom, dateTo);
        log('Lista filtrada carregada');

        var pag = detectPagination();
        appState.totalPages = pag.totalPages;

        if (pag.totalItems > 0) {
          sendMsg('TOTAL', { total: pag.totalItems });
          log('Total: ' + pag.totalItems + ' pedidos em ' + pag.totalPages + ' paginas');
        }

        if (appState.currentPage > 1) {
          log('Navegando para pagina ' + appState.currentPage + ' (checkpoint)...');
          await ensureCorrectPage(appState.currentPage);
        }

        updateStatus('run', { pages: appState.totalPages });

        var hasNext = true;
        while (hasNext) {
          await checkPauseStop();
          await processPage();
          saveCheckpoint();
          sendMsg('DATA_UPDATE', { data: appState.data });

          if (appState.currentPage < appState.totalPages) {
            hasNext = await goToNextPage();
          } else {
            hasNext = false;
          }
        }
      } // fim else (modo DOM)

      // CONCLUSAO
      clearCheckpoint();
      appState.running = false;

      // Cache final stats
      var finalCacheInfo = getCacheStats(loadCache());
      appState.cacheStats.totalCached = finalCacheInfo.total;

      log('Raspagem concluida!', 'success');
      log(appState.totalRowsSeen + ' analisados | ' + appState.skippedNotDone + ' ignorados | ' + appState.discarded.length + ' fora do periodo | ' + appState.data.length + ' incluidos', 'success');
      log('Cache: ' + appState.cacheStats.hits + ' hits | ' + appState.cacheStats.misses + ' misses | ' + appState.cacheStats.revalidated + ' revalidados | ' + appState.cacheStats.transitions + ' transicoes | ' + finalCacheInfo.total + ' total em cache', 'success');
      log(appState.alerts.length + ' alertas', appState.alerts.length > 0 ? 'warn' : 'success');

      updateStatus('done', { pages: appState.currentPage });
      sendMsg('DONE', {
        data: appState.data,
        discarded: appState.discarded,
        audit: appState.audit,
        alerts: appState.alerts,
        stats: {
          totalRowsSeen: appState.totalRowsSeen,
          skippedNotDone: appState.skippedNotDone,
          discardedByDate: appState.discarded.length,
          included: appState.data.length,
          pages: appState.currentPage,
          alertCount: appState.alerts.length,
          cacheHits: appState.cacheStats.hits,
          cacheMisses: appState.cacheStats.misses,
          cacheRevalidated: appState.cacheStats.revalidated,
          cacheTransitions: appState.cacheStats.transitions,
          cacheTotalEntries: finalCacheInfo.total
        }
      });

    } catch (e) {
      appState.running = false;
      if (e.message === 'STOPPED_BY_USER') {
        log('Raspagem interrompida.', 'warn');
        log('Progresso salvo: ' + appState.data.length + ' pedidos coletados');
        updateStatus('idle');
        saveCheckpoint();
        sendMsg('DATA_UPDATE', { data: appState.data });
      } else if (e.message === SESSION_EXPIRED_MSG || isSessionExpired()) {
        log('Sessao expirou! O GDOOR Web deslogou durante a raspagem.', 'error');
        log('Progresso salvo: ' + appState.data.length + ' pedidos coletados de ' + appState.totalRowsSeen + ' analisados', 'warn');
        log('Faca login novamente e re-execute. O cache acelerara o reprocessamento (' + appState.cacheStats.misses + ' pedidos ja em cache).', 'warn');
        sendAlert('Sessao expirada - faca login e re-execute');
        updateStatus('error');
        saveCheckpoint();

        var finalCacheInfo = getCacheStats(loadCache());
        appState.cacheStats.totalCached = finalCacheInfo.total;

        sendMsg('DONE', {
          data: appState.data,
          discarded: appState.discarded,
          audit: appState.audit,
          alerts: appState.alerts.concat([{ type: 'SESSAO_EXPIRADA', msg: 'Sessao expirou durante raspagem. Faca login e re-execute.' }]),
          stats: {
            totalRowsSeen: appState.totalRowsSeen,
            skippedNotDone: appState.skippedNotDone,
            discardedByDate: appState.discarded.length,
            included: appState.data.length,
            pages: appState.currentPage,
            alertCount: appState.alerts.length + 1,
            cacheHits: appState.cacheStats.hits,
            cacheMisses: appState.cacheStats.misses,
            cacheRevalidated: appState.cacheStats.revalidated,
            cacheTransitions: appState.cacheStats.transitions,
            cacheTotalEntries: finalCacheInfo.total,
            sessionExpired: true
          }
        });
      } else {
        log('Erro fatal: ' + e.message, 'error');
        sendAlert('Erro fatal: ' + e.message);
        updateStatus('error');
        saveCheckpoint();
      }
    }
  }

  // =====================================================================
  // LISTENER DE MENSAGENS DO POPUP
  // =====================================================================

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {

    switch (msg.action) {
      case 'START':
        if (!appState.running) startScraping(msg.dateFrom, msg.dateTo);
        sendResponse({ ok: true });
        break;

      case 'PAUSE':
        appState.paused = true;
        updateStatus('paused');
        log('Pausado');
        sendResponse({ ok: true });
        break;

      case 'RESUME':
        appState.paused = false;
        updateStatus('run');
        log('Retomando');
        sendResponse({ ok: true });
        break;

      case 'STOP':
        appState.stop = true;
        appState.paused = false;
        sendResponse({ ok: true });
        break;

      case 'CLEAR_CACHE':
        clearCache();
        var info = getCacheStats(loadCache());
        sendResponse({ ok: true, cacheStats: info });
        break;

      case 'GET_CACHE_STATS':
        var stats = getCacheStats(loadCache());
        sendResponse({ ok: true, cacheStats: stats });
        break;

      case 'TEST_API':
        testApiConnection(msg.dateFrom, msg.dateTo).then(function (result) {
          sendResponse(result);
        }).catch(function (err) {
          sendResponse({ ok: false, error: err.message });
        });
        return true; // async sendResponse

      default:
        sendResponse({ ok: false, error: 'Acao desconhecida' });
    }

    return true;
  });

})();
