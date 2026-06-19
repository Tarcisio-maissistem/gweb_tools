/**
 * content.js — DANFE Simplificada para Gweb (ISOLATED world)
 * Injeta o botão no menu, usa inject.js (MAIN world) como proxy autenticado.
 *
 * DEBUG: F12 → Console → filtrar por "[DANFE]"
 */
(function () {
  'use strict';

  if (window.__danfeGwebInit) return;
  window.__danfeGwebInit = true;

  const DEBUG = false;

  function dbg()  { if (DEBUG) console.log('[DANFE]', ...arguments); }
  function dbgW() { if (DEBUG) console.warn('[DANFE]', ...arguments); }
  function dbgE() { console.error('[DANFE]', ...arguments); }
  function dbgG(l){ if (DEBUG) console.group('[DANFE] ' + l); }
  function dbgGE(){ if (DEBUG) console.groupEnd(); }

  dbg('✅ Extensão carregada');

  // ─────────────────────────────────────────────────────────────────
  // ESTADO
  // ─────────────────────────────────────────────────────────────────
  let _ultimoId       = null;   // ID capturado ao clicar no trigger
  let _ultimoIdViewer = null;   // ID capturado de chamadas API do viewer
  let _authHeaders    = {};     // Headers capturados pelo inject.js
  let _urlsDescob     = [];     // URLs de API descobertas pelo inject.js
  let _pendentes      = {};     // Callbacks aguardando resposta do proxy

  // ─────────────────────────────────────────────────────────────────
  // COMUNICAÇÃO COM inject.js (MAIN world → ISOLATED via CustomEvent)
  // ─────────────────────────────────────────────────────────────────

  // Receber headers de auth capturados pelo inject.js
  window.addEventListener('__danfe_auth_captured', function (e) {
    try {
      _authHeaders = JSON.parse(e.detail);
      dbg('Auth headers atualizados:', Object.keys(_authHeaders));
    } catch (ex) {}
  });

  // Receber resposta XML do proxy inject.js
  window.addEventListener('__danfe_xml_response', function (e) {
    let resp;
    try { resp = JSON.parse(e.detail); } catch (ex) { return; }
    const cb = _pendentes[resp.reqId];
    if (cb) {
      delete _pendentes[resp.reqId];
      cb(resp);
    }
  });

  // Receber notificação de URL de API descoberta (XML cacheado pelo inject.js)
  window.addEventListener('__danfe_url_discovered', function (e) {
    try {
      const d = JSON.parse(e.detail);
      if (d.url && !_urlsDescob.includes(d.url)) {
        _urlsDescob.push(d.url);
        dbg('URL de XML descoberta:', d.url);
      }
    } catch (ex) {}
  });

  // Escutar TODAS as chamadas à API para descobrir padrões de URL
  window.addEventListener('__danfe_api_call', function (e) {
    try {
      const d = JSON.parse(e.detail);
      if (!d.url) return;
      const path = d.url.replace(/^https?:\/\/[^/]+/, '');
      // Registrar qualquer URL que pareça relacionada a NF-e / saídas / fiscal
      if (/nf.?e|saida|fiscal|nota/i.test(path) && !_urlsDescob.includes(d.url)) {
        _urlsDescob.push(d.url);
        dbg('URL NF-e detectada na API:', d.status, path);
      }
      // Capturar ID da NF-e aberta no viewer (auxiliaryDocument ou xml)
      const mId = path.match(/\/nfe\/([0-9]+)\//i);
      if (mId && d.status === 200) {
        _ultimoIdViewer = mId[1];
        dbg('ID NF-e do viewer capturado via API:', _ultimoIdViewer);
      }
    } catch (ex) {}
  });

  // Pedir ao inject.js que nos envie os headers que já capturou
  window.dispatchEvent(new CustomEvent('__danfe_get_auth'));

  // ─────────────────────────────────────────────────────────────────
  // ETAPA 1a — Captura de ID via clique no trigger "⋮"
  // ─────────────────────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    const trigger = e.target.closest(
      '[matMenuTrigger], [mat-menu-trigger-for], ' +
      '.mat-mdc-icon-button, .mat-icon-button, ' +
      'button[aria-haspopup="menu"], button[aria-haspopup="true"]'
    );
    if (!trigger) return;

    dbgG('Clique em trigger de menu');
    dbg('Trigger:', trigger.tagName, trigger.className.substring(0, 80));

    // Subir na árvore DOM buscando container com ID (até 15 níveis)
    const id = _subirBuscandoId(trigger, 15);
    if (id) {
      _ultimoId = id;
      dbg('✅ _ultimoId capturado:', id);
    } else {
      dbgW('Sem ID no ancestral. Trigger outerHTML:', trigger.outerHTML.substring(0, 300));
    }
    dbgGE();
  }, true);

  /** Sobe na árvore DOM buscando ID de NF-e em até maxNiveis níveis */
  function _subirBuscandoId(el, maxNiveis) {
    let atual = el;
    for (let i = 0; i < maxNiveis; i++) {
      if (!atual || atual === document.body) break;

      // data-id no próprio elemento
      if (atual.dataset && atual.dataset.id && /^\d+$/.test(atual.dataset.id)) {
        dbg('  ID via dataset.id em', atual.tagName + '.' + atual.className.substring(0,40));
        return atual.dataset.id;
      }

      // Links/botões filhos com href/ng-reflect contendo /saidas/<ID>
      const filhos = atual.querySelectorAll('a, button, [ng-reflect-router-link], [routerlink]');
      for (const f of filhos) {
        const id = _idDeAtributos(f);
        if (id) {
          dbg('  ID via filho de', atual.tagName, ':', id);
          return id;
        }
      }

      // innerHTML do nível atual
      const idInner = _idDeTexto(atual.innerHTML || '');
      if (idInner) {
        dbg('  ID via innerHTML de', atual.tagName + '.' + atual.className.substring(0,40));
        return idInner;
      }

      atual = atual.parentElement;
    }
    return null;
  }

  function _idDeAtributos(el) {
    const attrs = [
      el.getAttribute('href'),
      el.getAttribute('ng-reflect-router-link'),
      el.getAttribute('routerlink'),
      el.getAttribute('data-id'),
      el.getAttribute('ng-reflect-query-params')
    ];
    for (const a of attrs) {
      if (!a) continue;
      const id = _idDeTexto(a);
      if (id) return id;
    }
    return null;
  }

  function _idDeTexto(txt) {
    if (!txt) return null;
    const m =
      txt.match(/saidas\/(\d+)/i)       ||
      txt.match(/nf-e\/(\d+)/i)         ||
      txt.match(/\/(\d+)\/xml/i)        ||
      txt.match(/\/(\d+)\/editar/i)     ||
      txt.match(/\/(\d+)\/cancelar/i)   ||
      txt.match(/\/(\d+)\/eventos/i)    ||
      txt.match(/[?&]id=(\d+)/i);
    return m ? m[1] : null;
  }

  // ─────────────────────────────────────────────────────────────────
  // ETAPA 1b — Observer do DOM para menus Angular Material
  // ─────────────────────────────────────────────────────────────────
  const _observer = new MutationObserver(_verificarMenus);

  (function _iniciar() {
    _observer.observe(document.body, { childList: true, subtree: true });
    dbg('Observer iniciado');
  })();

  function _verificarMenus() {
    // ── Menus de contexto (overlay) ──
    const overlay = document.querySelector('.cdk-overlay-container');
    if (overlay) {
      const paineis = overlay.querySelectorAll(
        '.mat-menu-panel:not([data-danfe-ok]), .mat-mdc-menu-panel:not([data-danfe-ok])'
      );
      paineis.forEach(function (painel) {
        painel.setAttribute('data-danfe-ok', '1');

        if (DEBUG) {
          dbgG('Menu detectado');
          dbg('Texto:', painel.textContent.trim().replace(/\s+/g, ' ').substring(0, 200));
          dbgGE();
        }

        // Botões DANFE ficam apenas no viewer (não mais no menu de contexto)
      });
    }

    // ── Viewer de DANFE/PDF ──
    _verificarViewerDanfe();
  }

  // ─────────────────────────────────────────────────────────────────
  // ETAPA 1c — Botão no viewer de DANFE (tela de visualização PDF)
  // ─────────────────────────────────────────────────────────────────
  function _verificarViewerDanfe() {
    const wrapper = document.querySelector('#view-pdf-wrapper');
    if (!wrapper || wrapper.hasAttribute('data-danfe-viewer-ok')) return;
    wrapper.setAttribute('data-danfe-viewer-ok', '1');

    dbg('Viewer de DANFE/PDF detectado — injetando botões');

    const toolbar = wrapper.querySelector('[fxflex="40px"]') ||
                    wrapper.querySelector('[fxflexalign="center"]') ||
                    wrapper.children[0];
    if (!toolbar) {
      dbgW('Toolbar do viewer não encontrada');
      return;
    }

    function _criarBtnViewer(label, formato, cor) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mat-focus-indicator mat-button mat-button-base';
      b.title = label;
      b.innerHTML =
        '<span class="mat-button-wrapper" style="color:' + cor + ';font-weight:600;font-size:12px;">' +
          label +
        '</span>' +
        '<span class="mat-ripple mat-button-ripple"></span>';
      b.style.cssText = 'margin-left:4px;border:1px solid ' + cor + ';border-radius:4px;padding:0 8px;height:36px;';
      b.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        const id = _extrairIdDoViewer() || _ultimoIdViewer || _ultimoId;
        dbg('Botão DANFE ' + formato + ' no viewer clicado, ID:', id);
        _iniciarDanfe(id, formato);
      });
      return b;
    }

    const sep = document.createElement('span');
    sep.className = 'w10';
    sep.style.cssText = 'width:10px;display:inline-block;';

    toolbar.appendChild(sep);
    toolbar.appendChild(_criarBtnViewer('🧾 DANFE Cupom', 'cupom', '#1565c0'));
    toolbar.appendChild(_criarBtnViewer('📦 DANFE Simplificada', 'etiqueta', '#2e7d32'));

    const idViewer = _extrairIdDoViewer() || _ultimoIdViewer || _ultimoId;
    dbg('✅ Botões DANFE injetados no viewer, ID:', idViewer);
  }

  /** Extrai ID da NF-e da URL atual do navegador ou de elementos na página */
  function _extrairIdDoViewer() {
    // Tentar da URL do Angular (hash ou path)
    const loc = window.location.href;
    const m = loc.match(/nfe\/([0-9]+)/i) || loc.match(/saidas\/([0-9]+)/i);
    if (m) return m[1];

    // Tentar do breadcrumb ou título na página
    const titulo = document.querySelector('.mat-dialog-title, [mat-dialog-title]');
    if (titulo) {
      const mt = titulo.textContent.match(/(\d+)/);
      if (mt) return mt[1];
    }

    return null;
  }

  function _ehMenuNFe(painel) {
    const t = (painel.textContent || '').toLowerCase();
    return t.includes('xml') || t.includes('danfe') ||
           t.includes('cancelar nf') || t.includes('carta de corre') ||
           t.includes('inutilizar')  || t.includes('visualizar nf') ||
           t.includes('nota fiscal') || t.includes('consultar status');
  }

  // ─────────────────────────────────────────────────────────────────
  // ETAPA 2 — Injetar botões no menu (Cupom + Etiqueta)
  // ─────────────────────────────────────────────────────────────────
  function _injetarBotao(painel) {
    const conteudo = painel.querySelector('.mat-menu-content, .mat-mdc-menu-content') || painel;
    const modelo = conteudo.querySelector('button');
    const classeBase = modelo ? modelo.className : 'mat-focus-indicator mat-menu-item';

    function _criarBtnMenu(texto, titulo, formato, cor) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = classeBase;
      btn.disabled = false;
      btn.innerHTML = texto;
      btn.title = titulo;
      btn.style.cssText = 'color: ' + cor + ' !important; font-weight: 600 !important;';

      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();

        const idMenu = _idDoMenu(painel);
        const idFinal = idMenu || _ultimoId;

        dbgG('Botão DANFE ' + formato + ' clicado');
        dbg('ID do menu:', idMenu, '| _ultimoId:', _ultimoId, '| final:', idFinal);
        dbgGE();

        const backdrop = document.querySelector('.cdk-overlay-backdrop');
        if (backdrop) backdrop.click();

        _iniciarDanfe(idFinal, formato);
      });
      return btn;
    }

    const btnCupom = _criarBtnMenu(
      '&#129534; DANFE Cupom',
      'Gerar DANFE em formato cupom 80mm e imprimir',
      'cupom', '#1565c0'
    );
    const btnEtiqueta = _criarBtnMenu(
      '&#128230; DANFE Simplificada',
      'Gerar DANFE Simplificada 10×15cm (NT 2020.004)',
      'etiqueta', '#2e7d32'
    );

    // Inserir antes do separador
    const sep = Array.from(conteudo.children).find(function (el) {
      return el.tagName === 'MAT-DIVIDER' || el.tagName === 'HR' ||
             el.getAttribute('role') === 'separator' ||
             el.classList.contains('mat-divider');
    });

    if (sep) {
      conteudo.insertBefore(btnEtiqueta, sep);
      conteudo.insertBefore(btnCupom, btnEtiqueta);
    } else {
      conteudo.appendChild(btnCupom);
      conteudo.appendChild(btnEtiqueta);
    }

    dbg('✅ Botões injetados (Cupom + Simplificada)');
  }

  // ─────────────────────────────────────────────────────────────────
  // ETAPA 3 — Extrair ID do menu
  // ─────────────────────────────────────────────────────────────────
  function _idDoMenu(painel) {
    for (const el of painel.querySelectorAll('*')) {
      const id = _idDeAtributos(el);
      if (id) {
        dbg('ID via atributo do menu:', id);
        return id;
      }
    }
    const id = _idDeTexto(painel.innerHTML);
    if (id) {
      dbg('ID via innerHTML do menu:', id);
      return id;
    }
    // Último recurso: busca na página restrita ao contexto da linha mais próxima do trigger
    const linksNaPagina = document.querySelectorAll('[ng-reflect-router-link*="saidas"], a[href*="saidas"]');
    dbg('Links com saidas na página:', linksNaPagina.length);
    // Não usar o primeiro da página — pode ser linha errada. Só se _ultimoId tbm é null.
    if (linksNaPagina.length === 1) {
      return _idDeAtributos(linksNaPagina[0]);
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────
  // ORQUESTRADOR
  // ─────────────────────────────────────────────────────────────────
  async function _iniciarDanfe(nfeId, formato) {
    try {
      if (!nfeId) {
        dbgE('ID não encontrado');
        _toast('ID da NF-e não identificado — veja o console (F12) para detalhes', 'erro');
        return;
      }

      formato = formato || 'cupom';
      dbg('Iniciando para NF-e ID:', nfeId, '| formato:', formato);
      _toast('Buscando XML da NF-e #' + nfeId + '...');

      const xml = await _buscarXml(nfeId);
      dbg('XML ok, tamanho:', xml.length);

      const dados = _parsearXml(xml);
      dbg('Parseado:', dados.nNF, '|', dados.emit.nome, '|', dados.produtos.length, 'produtos');

      const html = formato === 'etiqueta' ? _gerarHtmlEtiqueta(dados) : _gerarHtmlCupom(dados);
      _abrirEImprimir(html);
      _toast('✅ DANFE gerada!');

    } catch (err) {
      dbgE('Erro:', err);
      _toast('Erro: ' + err.message, 'erro');
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // ETAPA 4 — Buscar XML via proxy inject.js (MAIN world)
  // ─────────────────────────────────────────────────────────────────
  async function _buscarXml(nfeId) {
    const urls = _montarUrlsCandidatas(nfeId);
    dbg('URLs candidatas (' + urls.length + '):', urls);

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      dbg('Tentando URL [' + (i + 1) + '/' + urls.length + ']:', url);

      try {
        const resp = await _proxyfetch(nfeId, url);
        dbg('Resposta HTTP', resp.status, 'para', url);

        if (resp.status === 200 && resp.text) {
          const t = resp.text.trim();
          dbg('HTTP 200 — primeiros 300 chars:', t.substring(0, 300));

          // Extrair XML: pode vir como string pura, como JSON {xml:"..."} ou {content:"..."}
          const xmlStr = _extrairXmlDaResposta(t);
          if (xmlStr) {
            dbg('✅ XML válido recebido de:', url);
            return xmlStr;
          }
          dbgW('HTTP 200 mas sem XML de NF-e reconhecível');
        }
        // Status != 200: tentar próxima sem logar como erro
      } catch (err) {
        dbgW('Erro na URL [' + (i + 1) + ']:', err.message || err);
        // Continuar para a próxima URL
      }
    }

    throw new Error(
      'XML não encontrado em nenhuma das ' + urls.length + ' URLs testadas. ' +
      'Abra "Visualizar XML" pelo menos uma vez no Gweb para que a extensão ' +
      'descubra a URL correta automaticamente.'
    );
  }

  function _montarUrlsCandidatas(nfeId) {
    const base = 'https://api.gdoorweb.com.br';
    // URL CONFIRMADA pela interceptação do Gweb (v1/movements/nfe/{id}/xml?preview=false)
    const candidatas = [
      // URL real do Gweb — confirmada via interceptação
      base + '/v1/movements/nfe/' + nfeId + '/xml?preview=false',
      base + '/v1/movements/nfe/' + nfeId + '/xml',
      // Variações com saidas
      base + '/v1/movements/nfe/saidas/' + nfeId + '/xml?preview=false',
      base + '/v1/movements/nfe/saidas/' + nfeId + '/xml',
      // Variações fiscais
      base + '/v1/fiscal/nfe/' + nfeId + '/xml?preview=false',
      base + '/v1/fiscal/nfe/' + nfeId + '/xml',
      base + '/v1/fiscal/nfe/saidas/' + nfeId + '/xml',
      base + '/v1/fiscal/nfes/' + nfeId + '/xml',
    ];

    // Priorizar URLs já descobertas pelo inject.js (padrão real do Gweb)
    for (const url of _urlsDescob) {
      // Ignorar URLs de listagem/query — não são endpoints de XML
      if (/[?&]page=/.test(url) || /[?&]limit=/.test(url)) continue;
      // Só considerar URLs que tenham padrão de XML
      if (!/\/\d+\/xml/i.test(url)) continue;
      // Substituir ID mantendo query string (ex: ?preview=false)
      const adaptada = url.replace(/\/\d+\/(xml)/i, '/' + nfeId + '/$1');
      if (!candidatas.includes(adaptada)) candidatas.unshift(adaptada);
    }

    dbg('Total de URLs candidatas:', candidatas.length);
    return candidatas;
  }

  /** Envia pedido ao inject.js via CustomEvent e aguarda resposta */
  function _proxyfetch(nfeId, url) {
    return new Promise(function (resolve, reject) {
      const reqId = Math.random().toString(36).substr(2, 9);
      const timeout = setTimeout(function () {
        delete _pendentes[reqId];
        reject(new Error('Timeout na URL: ' + url));
      }, 10000);

      _pendentes[reqId] = function (resp) {
        clearTimeout(timeout);
        resolve(resp);
      };

      window.dispatchEvent(new CustomEvent('__danfe_xml_request', {
        detail: JSON.stringify({ reqId: reqId, nfeId: nfeId, url: url })
      }));
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // ETAPA 4b — Extrair XML da resposta (pode vir puro, JSON, base64)
  // ─────────────────────────────────────────────────────────────────
  function _extrairXmlDaResposta(texto) {
    if (!texto) return null;

    // 1) Tentar JSON primeiro (API do Gweb retorna {"data":"<xml...>"})
    //    IMPORTANTE: testar JSON ANTES de XML puro, porque o JSON
    //    contém tags XML dentro da string e a regex casaria erroneamente.
    if (texto.charAt(0) === '{' || texto.charAt(0) === '[') {
      try {
        const obj = JSON.parse(texto);
        // Campos comuns: data, xml, content, nfeProc, xmlNFe, xmlContent
        const campos = ['data', 'xml', 'content', 'nfeProc', 'xmlNFe', 'xmlContent'];
        for (const campo of campos) {
          if (obj[campo] && typeof obj[campo] === 'string') {
            const val = obj[campo].trim();
            // Campo contém XML direto
            if (/<NFe|<nfeProc|<infNFe/i.test(val)) {
              dbg('XML detectado: JSON campo "' + campo + '"');
              return val;
            }
            // Campo pode ser Base64
            if (/^[A-Za-z0-9+/=\s]+$/.test(val) && val.length > 100) {
              try {
                const decoded = atob(val.replace(/\s/g, ''));
                if (/<NFe|<nfeProc|<infNFe/i.test(decoded)) {
                  dbg('XML detectado: JSON campo "' + campo + '" em Base64');
                  return decoded;
                }
              } catch (ex) {}
            }
          }
        }
        dbgW('JSON recebido mas sem XML reconhecível. Keys:', Object.keys(obj).join(', '));
        return null;
      } catch (ex) {
        // Começa com { mas não é JSON válido — cair para próximos testes
      }
    }

    // 2) Resposta é XML puro
    if (/<NFe|<nfeProc|<infNFe/i.test(texto)) {
      dbg('XML detectado: formato puro');
      return texto;
    }

    // 3) Resposta pode ser Base64 puro
    if (/^[A-Za-z0-9+/=\s]+$/.test(texto) && texto.length > 100) {
      try {
        const decoded = atob(texto.replace(/\s/g, ''));
        if (/<NFe|<nfeProc|<infNFe/i.test(decoded)) {
          dbg('XML detectado: Base64 puro');
          return decoded;
        }
      } catch (ex) {}
    }

    return null;
  }

  // ─────────────────────────────────────────────────────────────────
  // ETAPA 5 — Parser do XML
  // ─────────────────────────────────────────────────────────────────
  function _parsearXml(xmlStr) {
    const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');

    // Verificar erro de parse
    const parseErr = doc.querySelector('parsererror');
    if (parseErr) {
      dbgE('Erro no parse do XML:', parseErr.textContent.substring(0, 200));
    }

    function g(pai, tag) {
      if (!pai) return '';
      const el = pai.getElementsByTagName(tag)[0];
      return el ? el.textContent.trim() : '';
    }

    const emit   = doc.getElementsByTagName('emit')[0];
    const dest   = doc.getElementsByTagName('dest')[0];
    const ide    = doc.getElementsByTagName('ide')[0];
    const tot    = doc.getElementsByTagName('ICMSTot')[0];
    const infNFe = doc.getElementsByTagName('infNFe')[0];
    const infAdic = doc.getElementsByTagName('infAdic')[0];
    const transp  = doc.getElementsByTagName('transp')[0];
    const protNFe = doc.getElementsByTagName('protNFe')[0];

    const dhEmi = g(ide, 'dhEmi') || g(ide, 'dEmi');
    const dhSaiEnt = g(ide, 'dhSaiEnt') || g(ide, 'dSaiEnt');
    const chave = infNFe ? (infNFe.getAttribute('Id') || '').replace(/^NFe/, '') : '';
    const nProt = g(protNFe, 'nProt');
    const dhRecbto = g(protNFe, 'dhRecbto');

    // Endereço do emitente
    const enderEmit = emit ? emit.getElementsByTagName('enderEmit')[0] : null;
    // Endereço do destinatário
    const enderDest = dest ? dest.getElementsByTagName('enderDest')[0] : null;

    const produtos = Array.from(doc.getElementsByTagName('det')).map(function (det) {
      const p = det.getElementsByTagName('prod')[0];
      const imp = det.getElementsByTagName('imposto')[0];
      const icms = imp ? imp.querySelector('[orig]') || imp.getElementsByTagName('ICMS')[0] : null;
      return {
        cod:   g(p, 'cProd'),
        nome:  g(p, 'xProd'),
        ncm:   g(p, 'NCM'),
        cfop:  g(p, 'CFOP'),
        qtd:   parseFloat(g(p, 'qCom')   || '0'),
        unid:  g(p, 'uCom'),
        vUnit: parseFloat(g(p, 'vUnCom') || '0'),
        vProd: parseFloat(g(p, 'vProd')  || '0'),
        vDesc: parseFloat(g(p, 'vDesc')  || '0'),
        nItem: det.getAttribute('nItem') || ''
      };
    });

    // Pagamento
    const pagamentos = Array.from(doc.getElementsByTagName('detPag')).map(function (dp) {
      const tPag = g(dp, 'tPag');
      const vPag = parseFloat(g(dp, 'vPag') || '0');
      return { tPag: tPag, vPag: vPag, desc: _descFormaPag(tPag) };
    });

    return {
      emit: {
        nome: g(emit, 'xNome'),
        fantasia: g(emit, 'xFant'),
        cnpj: g(emit, 'CNPJ'),
        ie:   g(emit, 'IE'),
        uf:   g(enderEmit, 'UF'),
        end:  enderEmit ? (
          [g(enderEmit, 'xLgr'), g(enderEmit, 'nro')].filter(Boolean).join(', ') +
          (g(enderEmit, 'xCpl') ? ' - ' + g(enderEmit, 'xCpl') : '') +
          (g(enderEmit, 'xBairro') ? ' - ' + g(enderEmit, 'xBairro') : '') +
          ' - CEP ' + g(enderEmit, 'CEP') +
          (g(enderEmit, 'xMun') ? ' - ' + g(enderEmit, 'xMun') + '/' + g(enderEmit, 'UF') : '')
        ) : '',
        fone: g(enderEmit, 'fone')
      },
      dest: {
        nome:    g(dest, 'xNome') || 'Consumidor Final',
        cpfCnpj: g(dest, 'CPF') || g(dest, 'CNPJ') || '',
        ie:      g(dest, 'IE') || '',
        uf:      g(enderDest, 'UF'),
        end:     enderDest ? (
          [g(enderDest, 'xLgr'), g(enderDest, 'nro')].filter(Boolean).join(', ') +
          (g(enderDest, 'xBairro') ? ' - ' + g(enderDest, 'xBairro') : '') +
          (g(enderDest, 'xMun') ? ' - ' + g(enderDest, 'xMun') + '/' + g(enderDest, 'UF') : '')
        ) : ''
      },
      nNF:     g(ide, 'nNF'),
      serie:   g(ide, 'serie'),
      natOp:   g(ide, 'natOp'),
      tpNF:    g(ide, 'tpNF'),  // 0=entrada, 1=saida
      data:    dhEmi ? new Date(dhEmi).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '',
      dataSai: dhSaiEnt ? new Date(dhSaiEnt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '',
      chave,
      nProt,
      dhRecbto: dhRecbto ? new Date(dhRecbto).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '',
      vProd:   parseFloat(g(tot, 'vProd')   || '0'),
      vNF:     parseFloat(g(tot, 'vNF')     || '0'),
      vDesc:   parseFloat(g(tot, 'vDesc')   || '0'),
      vFrete:  parseFloat(g(tot, 'vFrete')  || '0'),
      vSeg:    parseFloat(g(tot, 'vSeg')    || '0'),
      vOutro:  parseFloat(g(tot, 'vOutro')  || '0'),
      vBC:     parseFloat(g(tot, 'vBC')     || '0'),
      vICMS:   parseFloat(g(tot, 'vICMS')   || '0'),
      vBCST:   parseFloat(g(tot, 'vBCST')   || '0'),
      vST:     parseFloat(g(tot, 'vST')     || '0'),
      vIPI:    parseFloat(g(tot, 'vIPI')    || '0'),
      vTotTrib: parseFloat(g(tot, 'vTotTrib') || '0'),
      infCpl:  g(infAdic, 'infCpl'),
      modFrete: g(transp, 'modFrete'),
      produtos,
      pagamentos
    };
  }

  function _descFormaPag(cod) {
    const map = {
      '01': 'Dinheiro', '02': 'Cheque', '03': 'Cartão Crédito',
      '04': 'Cartão Débito', '05': 'Créd. Loja', '10': 'Vale Alimentação',
      '11': 'Vale Refeição', '12': 'Vale Presente', '13': 'Vale Combustível',
      '14': 'Duplicata Mercantil', '15': 'Boleto', '16': 'Dep. Bancário',
      '17': 'PIX', '18': 'Transf. Bancária', '19': 'Prog. Fidelidade',
      '90': 'Sem Pagamento', '99': 'Outros'
    };
    return map[cod] || 'Outros (' + cod + ')';
  }

  // ─────────────────────────────────────────────────────────────────
  // ETAPA 6a — Gerar HTML do DANFE CUPOM (80mm)
  // ─────────────────────────────────────────────────────────────────
  function _gerarHtmlCupom(d) {
    function br(v)  { return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function n3(v)  { return v.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }); }
    function fCnpj(c) {
      return c && c.length === 14
        ? c.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : c || '';
    }
    function fCpf(c) {
      return c && c.length === 11
        ? c.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : c || '';
    }
    function fDoc(c) { return !c ? '' : (c.length === 14 ? fCnpj(c) : fCpf(c)); }
    function fNF(n) {
      if (!n) return '';
      return n.replace(/^0+/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    }
    function fFone(f) {
      if (!f) return '';
      f = f.replace(/\D/g, '');
      if (f.length === 11) return '(' + f.substr(0,2) + ') ' + f.substr(2,5) + '-' + f.substr(7);
      if (f.length === 10) return '(' + f.substr(0,2) + ') ' + f.substr(2,4) + '-' + f.substr(6);
      return f;
    }

    const chaveBlocks = d.chave ? d.chave.match(/.{1,4}/g).join(' ') : '';
    const tipoNF = d.tpNF === '0' ? 'ENTRADA' : 'SA\u00CDDA';

    // Itens com número, código, NCM, CFOP
    const itens = d.produtos.map(function (p, i) {
      return (
        '<div class="item">' +
          '<div class="iNum">' + (p.nItem || (i + 1)) + '</div>' +
          '<div class="iDet">' +
            '<div class="iN">' + p.nome + '</div>' +
            '<div class="iMeta">' +
              (p.cod ? 'Cód: ' + p.cod + ' ' : '') +
              (p.ncm ? '| NCM: ' + p.ncm + ' ' : '') +
              (p.cfop ? '| CFOP: ' + p.cfop : '') +
            '</div>' +
            '<div class="iC">' +
              '<span>' + n3(p.qtd) + ' ' + p.unid + ' \u00D7 R$ ' + br(p.vUnit) + '</span>' +
              '<span class="iT">R$ ' + br(p.vProd) + '</span>' +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    // Pagamentos
    const pags = (d.pagamentos || []).map(function (p) {
      return '<div class="tL"><span>' + p.desc + '</span><span>R$ ' + br(p.vPag) + '</span></div>';
    }).join('');

    const css = [
      '@page { size: 80mm auto; margin: 3mm 2mm; }',
      '* { box-sizing: border-box; margin: 0; padding: 0; }',
      'body { font-family: "Courier New",Courier,monospace; font-size:12px; color:#000; background:#fff;',
      '       width:76mm; margin:0 auto; padding:2mm 1mm; line-height:1.5; -webkit-print-color-adjust:exact; font-weight:700; }',
      '.c { text-align:center; }',
      'hr { border:none; border-top:1px dashed #000; margin:5px 0; }',
      '.titulo { font-size:16px; font-weight:900; letter-spacing:1px; }',
      '.subtit { font-size:10px; color:#333; font-weight:600; }',
      '.eN { font-size:13px; font-weight:900; word-break:break-word; }',
      '.eI { font-size:10px; color:#222; word-break:break-word; font-weight:600; }',
      '.sec { font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:.5px;',
      '        background:#eee; padding:2px 4px; margin:2px 0; }',
      '.dN { font-weight:900; word-break:break-word; font-size:12px; }',
      '.item { margin-bottom:5px; display:flex; gap:4px; border-bottom:1px dotted #000; padding-bottom:3px; }',
      '.iNum { font-size:10px; color:#555; min-width:16px; text-align:right; padding-top:1px; font-weight:700; }',
      '.iDet { flex:1; }',
      '.iN { word-break:break-word; font-weight:900; font-size:11px; }',
      '.iMeta { font-size:9px; color:#555; font-weight:600; }',
      '.iC { display:flex; justify-content:space-between; font-size:11px; color:#333; font-weight:700; }',
      '.iT { font-weight:900; color:#000; }',
      '.tL { display:flex; justify-content:space-between; margin:2px 0; font-size:11px; font-weight:700; }',
      '.tB { font-size:14px; font-weight:900; }',
      '.rod { font-size:9px; color:#444; text-align:center; margin-top:4px; font-weight:600; }',
      '.chv { font-size:8px; word-break:break-all; text-align:center; font-family:monospace; font-weight:700; }',
      '.info { font-size:9px; color:#333; word-break:break-word; white-space:pre-wrap; margin:3px 0; font-weight:600; }',
      '.lbl { font-size:9px; color:#555; font-weight:700; }',
      '.val { font-size:11px; font-weight:700; }',
      '.row2 { display:flex; justify-content:space-between; margin:1px 0; }',
      '@media print { body { margin:0; } }'
    ].join('\n');

    return '<!DOCTYPE html>\n<html lang="pt-BR">\n<head>\n' +
      '<meta charset="UTF-8">\n' +
      '<title>DANFE Cupom' + (d.nNF ? ' NF-' + d.nNF : '') + '</title>\n' +
      '<style>\n' + css + '\n</style>\n</head>\n<body>\n' +

      // === CABEÇALHO ===
      '<div class="c"><div class="titulo">DANFE CUPOM</div>' +
      '<div class="subtit">Documento Auxiliar da Nota Fiscal Eletr\u00F4nica</div>' +
      (d.nNF ? '<div style="font-size:12px;font-weight:bold;margin-top:2px;">N\u00BA ' + fNF(d.nNF) +
               (d.serie ? ' | S\u00E9rie ' + d.serie : '') +
               ' | ' + tipoNF + '</div>' : '') +
      '</div><hr>' +

      // === EMITENTE ===
      '<div class="c sec">Emitente</div>' +
      '<div class="c"><div class="eN">' + (d.emit.fantasia || d.emit.nome) + '</div>' +
      (d.emit.fantasia && d.emit.nome !== d.emit.fantasia ? '<div class="eI">' + d.emit.nome + '</div>' : '') +
      '<div class="eI">CNPJ: ' + fCnpj(d.emit.cnpj) +
      (d.emit.ie ? ' | IE: ' + d.emit.ie : '') + '</div>' +
      (d.emit.end ? '<div class="eI">' + d.emit.end + '</div>' : '') +
      (d.emit.fone ? '<div class="eI">Fone: ' + fFone(d.emit.fone) + '</div>' : '') +
      '</div><hr>' +

      // === NATUREZA DA OPERAÇÃO ===
      (d.natOp ? '<div class="row2"><span class="lbl">NATUREZA DA OPERA\u00C7\u00C3O</span>' +
                 '<span class="val">' + d.natOp + '</span></div>' : '') +

      // === CHAVE DE ACESSO ===
      (chaveBlocks
        ? '<div class="c sec" style="font-size:8px;">Chave de Acesso</div>' +
          '<div class="chv">' + chaveBlocks + '</div>'
        : '') +

      // === PROTOCOLO ===
      (d.nProt
        ? '<div class="row2"><span class="lbl">Protocolo Autoriza\u00E7\u00E3o</span>' +
          '<span class="val">' + d.nProt + (d.dhRecbto ? ' - ' + d.dhRecbto : '') + '</span></div>'
        : '') +
      '<hr>' +

      // === DESTINATÁRIO ===
      '<div class="c sec">Destinat\u00E1rio / Remetente</div>' +
      '<div class="dN">' + d.dest.nome + '</div>' +
      (d.dest.cpfCnpj ? '<div class="eI">CPF/CNPJ: ' + fDoc(d.dest.cpfCnpj) +
       (d.dest.ie ? ' | IE: ' + d.dest.ie : '') + '</div>' : '') +
      (d.dest.end ? '<div class="eI">' + d.dest.end + '</div>' : '') +
      '<hr>' +

      // === DADOS DA EMISSÃO ===
      '<div class="row2">' +
        '<span class="lbl">Emiss\u00E3o: <b>' + (d.data || '-') + '</b></span>' +
        '<span class="lbl">Sa\u00EDda: <b>' + (d.dataSai || '-') + '</b></span>' +
      '</div><hr>' +

      // === ITENS ===
      '<div class="c sec">Produtos / Servi\u00E7os (' + d.produtos.length + ')</div>' +
      itens + '<hr>' +

      // === TOTAIS ===
      '<div class="c sec">Totais</div>' +
      '<div class="tL"><span>Valor Produtos</span><span>R$ ' + br(d.vProd) + '</span></div>' +
      (d.vDesc  > 0 ? '<div class="tL"><span>Desconto</span><span style="color:#c62828;">- R$ ' + br(d.vDesc) + '</span></div>' : '') +
      (d.vFrete > 0 ? '<div class="tL"><span>Frete</span><span>R$ ' + br(d.vFrete) + '</span></div>' : '') +
      (d.vSeg   > 0 ? '<div class="tL"><span>Seguro</span><span>R$ ' + br(d.vSeg) + '</span></div>' : '') +
      (d.vOutro > 0 ? '<div class="tL"><span>Outras Despesas</span><span>R$ ' + br(d.vOutro) + '</span></div>' : '') +
      (d.vICMS  > 0 ? '<div class="tL"><span>ICMS</span><span>R$ ' + br(d.vICMS) + '</span></div>' : '') +
      (d.vIPI   > 0 ? '<div class="tL"><span>IPI</span><span>R$ ' + br(d.vIPI) + '</span></div>' : '') +
      '<div class="tL tB" style="border-top:2px solid #000;padding-top:3px;margin-top:3px;">' +
        '<span>VALOR TOTAL DA NF-e</span><span>R$ ' + br(d.vNF) + '</span></div><hr>' +

      // === PAGAMENTO ===
      (pags ? '<div class="c sec">Pagamento</div>' + pags + '<hr>' : '') +

      // === INFORMAÇÕES COMPLEMENTARES ===
      (d.infCpl ? '<div class="c sec" style="font-size:8px;">Informa\u00E7\u00F5es Complementares</div>' +
                  '<div class="info">' + d.infCpl + '</div><hr>' : '') +

      // === RODAPÉ ===
      '<div class="rod">' +
        'Impresso em ' + new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) +
      '</div>' +
      '<div style="margin-top:6px;text-align:center;font-size:8px;color:#bbb;">\u2014 Gweb Extens\u00E3o DANFE Simplificada \u2014</div>\n' +
      '</body>\n</html>';
  }

  // ─────────────────────────────────────────────────────────────────
  // ETAPA 6b — Gerar HTML do DANFE SIMPLIFICADA 10×15cm (NT 2020.004)
  // ─────────────────────────────────────────────────────────────────
  function _gerarHtmlEtiqueta(d) {
    var chave = d.chave || '';
    var chEsp = chave.replace(/(.{4})/g, '$1 ').trim();
    function br(v) { return (v || 0).toFixed(2).replace('.', ','); }
    function fDoc(v) {
      if (!v) return '';
      v = v.replace(/\D/g, '');
      if (v.length === 11) return v.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
      if (v.length === 14) return v.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
      return v;
    }

    var tipoOp = d.tpNF === '0' ? '0 \u2013 ENTRADA' : d.tpNF === '1' ? '1 \u2013 SAIDA' : (d.tpNF || '');
    var nomeEmit = d.emit.fantasia || d.emit.nome || '';

    return '<!DOCTYPE html><html><head><meta charset="utf-8">\n' +
      '<title>DANFE Simplificada' + (d.nNF ? ' NF-' + d.nNF : '') + '</title>\n' +
      '<style>\n' +
      '@page{size:100mm 150mm;margin:2mm;}\n' +
      '*{margin:0;padding:0;box-sizing:border-box;}\n' +
      'body{font-family:Arial,Helvetica,sans-serif;font-size:7pt;color:#000;width:96mm;}\n' +
      'table{width:100%;border-collapse:collapse;}\n' +
      'td,th{border:1px solid #000;padding:1.5mm 2mm;vertical-align:top;font-size:7pt;}\n' +
      'th{font-weight:bold;text-transform:uppercase;font-size:6pt;background:#f5f5f5;}\n' +
      '.wrap{border:2px solid #000;width:96mm;}\n' +
      '.hdr{text-align:center;padding:2mm;border-bottom:1px solid #000;}\n' +
      '.hdr h1{font-size:10pt;font-weight:bold;margin:0 0 1mm 0;}\n' +
      '.hdr h2{font-size:8pt;font-weight:normal;margin:0;}\n' +
      '.docaux{display:flex;justify-content:space-between;padding:2mm;border-bottom:1px solid #000;font-size:7pt;}\n' +
      '.docaux-r{text-align:right;font-weight:bold;}\n' +
      '.bc{text-align:center;padding:2mm;border-bottom:1px solid #000;}\n' +
      '.bc img{width:92mm;height:15mm;}\n' +
      '.bc-num{font-family:monospace;font-size:7pt;margin-top:1mm;letter-spacing:0.3px;}\n' +
      '.chave{text-align:center;padding:2mm;border-bottom:1px solid #000;}\n' +
      '.chave b{font-size:6.5pt;text-transform:uppercase;display:block;margin-bottom:1mm;}\n' +
      '.chave .num{font-family:monospace;font-size:8pt;font-weight:bold;letter-spacing:0.5px;}\n' +
      '.chave .prot-lbl{font-size:6.5pt;text-transform:uppercase;margin-top:2mm;display:block;}\n' +
      '.chave .prot-val{font-size:7pt;}\n' +
      '.sec-title{font-size:6pt;font-weight:bold;text-transform:uppercase;padding:1mm 2mm;border-bottom:1px solid #000;background:#f0f0f0;}\n' +
      '.imp td,.imp th{padding:1mm;text-align:right;font-size:6.5pt;}\n' +
      '.imp th{text-align:center;font-size:5.5pt;}\n' +
      '.info{padding:2mm;font-size:6.5pt;border-top:1px solid #000;}\n' +
      '.info b{display:block;margin-top:1mm;}\n' +
      '@media print{body{margin:0;}}\n' +
      '</style></head><body>\n' +
      '<div class="wrap">\n' +

      // ---- Cabeçalho ----
      '<div class="hdr">\n' +
      '  <h1>DANFE Simplificada</h1>\n' +
      '  <h2>' + nomeEmit + '</h2>\n' +
      '</div>\n' +

      // ---- Documento Auxiliar + Tipo/Número/Série ----
      '<div class="docaux">\n' +
      '  <div>Documento Auxiliar da NF-e</div>\n' +
      '  <div class="docaux-r">' + tipoOp + '<br>N ' + (d.nNF || '') + '<br>S\u00c9RIE: ' + (d.serie || '') + '</div>\n' +
      '</div>\n' +

      // ---- Código de barras ----
      (chave ?
      '<div class="bc">\n' +
      '  <img src="https://barcode.tec-it.com/barcode.ashx?data=' + encodeURIComponent(chave) + '&code=Code128&dpi=150&imagetype=png" alt="C\u00f3digo de Barras">\n' +
      '  <div class="bc-num">' + chEsp + '</div>\n' +
      '</div>\n' : '') +

      // ---- Chave de Acesso + Protocolo ----
      '<div class="chave">\n' +
      '  <b>Chave de Acesso</b>\n' +
      '  <div class="num">' + chEsp + '</div>\n' +
      (d.nProt ?
      '  <span class="prot-lbl">Protocolo de Autoriza\u00e7\u00e3o de Uso</span>\n' +
      '  <div class="prot-val">' + d.nProt + '&nbsp;&nbsp;&nbsp;&nbsp;' + (d.dhRecbto || '') + '</div>\n'
      : '') +
      '</div>\n' +

      // ---- Natureza da Operação + Datas ----
      '<table><tr>' +
      '<td style="width:55%;"><b style="font-size:6pt;text-transform:uppercase;">Natureza da Opera\u00e7\u00e3o</b><br>' + (d.natOp || '') + '</td>' +
      '<td><b style="font-size:6pt;text-transform:uppercase;">Emiss\u00e3o:</b> ' + (d.data || '') + '<br>' +
      '<b style="font-size:6pt;text-transform:uppercase;">Sa\u00edda:</b> ' + (d.dataSai || '') + '</td>' +
      '</tr></table>\n' +

      // ---- Emitente ----
      '<div style="padding:2mm;border-bottom:1px solid #000;">\n' +
      '  <div style="font-size:7pt;">CNPJ: ' + fDoc(d.emit.cnpj) + '</div>\n' +
      '  <div style="font-size:8pt;font-weight:bold;">' + nomeEmit + '</div>\n' +
      (d.emit.end ? '  <div style="font-size:7pt;">' + d.emit.end + '</div>\n' : '') +
      '</div>\n' +

      // ---- Destinatário / Remetente ----
      '<div class="sec-title">Destinat\u00e1rio / Remetente</div>\n' +
      '<div style="padding:2mm;border-bottom:1px solid #000;">\n' +
      '  <div style="font-size:8pt;font-weight:bold;">' + (d.dest.nome || '') + '</div>\n' +
      (d.dest.end ? '  <div style="font-size:7pt;">' + d.dest.end + '</div>\n' : '') +
      '  <div style="font-size:7pt;">CNPJ/CPF: ' + fDoc(d.dest.cpfCnpj) +
      '&nbsp;&nbsp;&nbsp;&nbsp;IE: ' + (d.dest.ie || '') + '</div>\n' +
      '</div>\n' +

      // ---- Cálculo do Imposto ----
      '<div class="sec-title">C\u00e1lculo do Imposto</div>\n' +
      '<table class="imp"><tr>' +
      '<th>BASE ICMS</th><th>VALOR ICMS</th><th>BC ICMS ST</th><th>VL ICMS ST</th><th>TOT PRODUTOS</th>' +
      '</tr><tr>' +
      '<td>' + br(d.vBC) + '</td><td>' + br(d.vICMS) + '</td><td>' + br(d.vBCST) + '</td><td>' + br(d.vST) + '</td><td>' + br(d.vProd) + '</td>' +
      '</tr><tr>' +
      '<th>VL FRETE</th><th>VL SEGURO</th><th>VL DESCONTO</th><th>VALOR IPI</th><th>TOT NOTA</th>' +
      '</tr><tr>' +
      '<td>' + br(d.vFrete) + '</td><td>' + br(d.vSeg) + '</td><td>' + br(d.vDesc) + '</td><td>' + br(d.vIPI) + '</td><td><b>' + br(d.vNF) + '</b></td>' +
      '</tr></table>\n' +

      // ---- Informações Complementares ----
      (d.infCpl || d.vTotTrib ?
      '<div class="info">\n' +
      (d.infCpl ? '  <div>' + d.infCpl + '</div>\n' : '') +
      (d.vTotTrib ? '  <b>Valor Aproximado dos Tributos: R$ ' + br(d.vTotTrib) + '</b>\n' : '') +
      '</div>\n' : '') +

      '</div>\n' +
      '</body></html>';
  }

  // ─────────────────────────────────────────────────────────────────
  // ETAPAS 7+8+9 — Imprimir via iframe oculto (mesma página)
  // ─────────────────────────────────────────────────────────────────
  function _abrirEImprimir(html) {
    // Remove iframe anterior se existir
    var old = document.getElementById('_danfe_print_frame');
    if (old) old.remove();

    var iframe = document.createElement('iframe');
    iframe.id = '_danfe_print_frame';
    iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:0;height:0;border:none;';
    document.body.appendChild(iframe);

    var doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();

    iframe.addEventListener('load', function () {
      setTimeout(function () {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      }, 400);
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Toast visual
  // ─────────────────────────────────────────────────────────────────
  function _toast(msg, tipo) {
    let el = document.getElementById('_danfe_toast_gweb');
    if (el) el.remove();
    el = document.createElement('div');
    el.id = '_danfe_toast_gweb';
    el.textContent = msg;
    el.style.cssText =
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
      'background:' + (tipo === 'erro' ? '#b71c1c' : '#212121') + ';' +
      'color:#fff;padding:10px 22px;border-radius:20px;' +
      'z-index:2147483647;font-size:13px;font-family:Roboto,sans-serif;' +
      'box-shadow:0 3px 10px rgba(0,0,0,.5);max-width:80vw;text-align:center;' +
      'pointer-events:none;transition:opacity .3s;';
    document.body.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      setTimeout(function () { if (el.parentNode) el.remove(); }, 350);
    }, tipo === 'erro' ? 7000 : 3000);
  }

})();
