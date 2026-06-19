/**
 * inject.js — roda no mundo MAIN (mesmo contexto do Angular)
 * Captura headers de auth dos XHR/fetch do Angular e faz proxy para o content script.
 *
 * Comunicação com content.js (ISOLATED world) via CustomEvent:
 *   __danfe_auth_captured  → envia headers capturados para content.js
 *   __danfe_xml_request    ← recebe pedido de XML do content.js
 *   __danfe_xml_response   → envia resposta de volta para content.js
 */
(function () {
  'use strict';

  if (window.__danfeInjectInit) return;
  window.__danfeInjectInit = true;

  // Headers de auth capturados dos requests do Angular
  const _auth = {};
  // Cache de XML indexado por ID da NF-e
  const _xmlCache = {};

  // ── Interceptar XHR (Angular HttpClient usa XHR) ─────────────────────────
  const origOpen      = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend      = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._dUrl = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    // Capturar headers de auth de qualquer request ao gdoorweb.com.br
    if (this._dUrl && /gdoorweb\.com\.br/i.test(this._dUrl)) {
      const lower = name.toLowerCase();
      if (lower === 'authorization' || lower === 'x-token' ||
          lower === 'x-api-key'    || lower === 'bearer') {
        _auth[name] = value;
        _notifyAuth();
      }
    }
    return origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    if (xhr._dUrl && /gdoorweb\.com\.br/i.test(xhr._dUrl)) {
      xhr.addEventListener('load', function () {
        // Logar TODAS as chamadas à API para descoberta de URLs
        const path = xhr._dUrl.replace(/^https?:\/\/[^/]+/, '');
        // console.log('[DANFE inject] API→', xhr.status, path.substring(0, 120));

        // Notificar content.js de toda URL da API (para discovery)
        window.dispatchEvent(new CustomEvent('__danfe_api_call', {
          detail: JSON.stringify({ url: xhr._dUrl, status: xhr.status })
        }));

        _tentarCachearXml(xhr._dUrl, xhr.responseText);
      });
    }
    return origSend.apply(this, arguments);
  };

  // ── Interceptar fetch (fallback) ─────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');

    // Capturar auth header do fetch
    if (init && init.headers && /gdoorweb\.com\.br/i.test(url)) {
      const h = init.headers;
      let authVal = null;
      if (typeof h.get === 'function') {
        authVal = h.get('Authorization') || h.get('authorization');
      } else if (typeof h === 'object') {
        authVal = h['Authorization'] || h['authorization'];
      }
      if (authVal) {
        _auth['Authorization'] = authVal;
        _notifyAuth();
      }
    }

    const resultado = origFetch.apply(this, arguments);

    // Interceptar resposta para cachear XML
    if (/gdoorweb\.com\.br/i.test(url)) {
      resultado.then(function (resp) {
        resp.clone().text().then(function (texto) {
          _tentarCachearXml(url, texto);
        }).catch(function () {});
      }).catch(function () {});
    }

    return resultado;
  };

  /** Cacheia resposta se for XML de NF-e e notifica o content.js */
  function _tentarCachearXml(url, texto) {
    if (!texto) return;
    if (!texto.includes('<NFe') && !texto.includes('<nfeProc') && !texto.includes('infNFe')) return;

    // Extrair ID da NF-e da URL
    const m = url.match(/saidas\/(\d+)/i) || url.match(/nf-e\/(\d+)/i) || url.match(/\/(\d+)\/xml/i);
    if (m) {
      _xmlCache[m[1]] = texto;
      // console.log('[DANFE inject] XML cacheado para ID:', m[1], '| URL:', url);
      window.dispatchEvent(new CustomEvent('__danfe_xml_cached', {
        detail: JSON.stringify({ id: m[1] })
      }));
    }

    // Registrar o padrão de URL para uso futuro
    window.dispatchEvent(new CustomEvent('__danfe_url_discovered', {
      detail: JSON.stringify({ url: url })
    }));
  }

  /** Notifica o content.js (ISOLATED world) sobre novos headers de auth */
  function _notifyAuth() {
    window.dispatchEvent(new CustomEvent('__danfe_auth_captured', {
      detail: JSON.stringify(_auth)
    }));
  }

  // ── Proxy de fetch para o content.js ─────────────────────────────────────
  // Recebe pedido do content.js, faz XHR com os headers capturados,
  // retorna resposta de volta. Roda no MAIN world = mesma origem que Angular.
  window.addEventListener('__danfe_xml_request', function (e) {
    let req;
    try { req = JSON.parse(e.detail); } catch (ex) { return; }

    // Verificar cache antes de fazer request
    if (_xmlCache[req.nfeId]) {
      // console.log('[DANFE inject] Servindo do cache para ID:', req.nfeId);
      window.dispatchEvent(new CustomEvent('__danfe_xml_response', {
        detail: JSON.stringify({
          reqId: req.reqId,
          status: 200,
          text: _xmlCache[req.nfeId],
          fromCache: true
        })
      }));
      return;
    }

    // console.log('[DANFE inject] Fazendo XHR proxy para:', req.url, '| auth keys:', Object.keys(_auth));

    const xhr = new XMLHttpRequest();
    origOpen.call(xhr, 'GET', req.url, true);
    // NÃO usar withCredentials — a API não retorna Allow-Credentials: true.
    // O JWT Bearer no header é suficiente para autenticação.
    xhr.withCredentials = false;

    // Aplicar headers de auth capturados do Angular
    Object.keys(_auth).forEach(function (k) {
      try { origSetHeader.call(xhr, k, _auth[k]); } catch (ex) {}
    });

    xhr.onload = function () {
      // console.log('[DANFE inject] XHR proxy resposta:', xhr.status, '| url:', req.url);
      window.dispatchEvent(new CustomEvent('__danfe_xml_response', {
        detail: JSON.stringify({
          reqId: req.reqId,
          status: xhr.status,
          text: xhr.responseText
        })
      }));
    };

    xhr.onerror = function () {
      // console.log('[DANFE inject] XHR proxy erro na URL:', req.url);
      window.dispatchEvent(new CustomEvent('__danfe_xml_response', {
        detail: JSON.stringify({ reqId: req.reqId, status: 0, error: 'Erro de rede' })
      }));
    };

    origSend.call(xhr);
  });

  // Responde pedido do content.js pelos headers de auth atuais
  window.addEventListener('__danfe_get_auth', function () {
    _notifyAuth();
  });

  // console.log('[DANFE inject.js] Interceptor MAIN world ativo ✅');
})();
