/**
 * interceptor.js - Interceptor de API para GDOOR Web
 *
 * Roda no contexto da pagina (world: "MAIN") para interceptar
 * chamadas XHR/fetch e capturar dados da API do GDOOR.
 *
 * Comunica-se com content.js (world: "ISOLATED") via CustomEvent.
 *
 * Objetivo principal: capturar o objeto completo do pedido retornado
 * pela API, que pode conter campos nao exibidos na UI (ex: vendedor).
 */

(function () {
  'use strict';

  // Evitar dupla injecao
  if (window.__gdoorInterceptorActive) return;
  window.__gdoorInterceptorActive = true;

  var EVENT_NAME = '__gdoor_api_data';

  function dispatch(url, method, data) {
    try {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, {
        detail: JSON.stringify({ url: url, method: method, data: data })
      }));
    } catch (e) {
      // silencioso
    }
  }

  function isRelevantUrl(url) {
    if (!url) return false;
    return url.indexOf('/pedidos') !== -1 || url.indexOf('/orders') !== -1;
  }

  // ===== Interceptar XMLHttpRequest (Angular HttpClient usa XHR) =====
  // Tambem captura headers de autenticacao para reutilizar no proxy.

  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  var origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  // Armazena headers de auth capturados das requisicoes do Angular
  var capturedAuthHeaders = {};

  XMLHttpRequest.prototype.open = function (method, url) {
    this._gdoor_url = url;
    this._gdoor_method = method;
    this._gdoor_headers = {};
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    // Captura headers de autenticacao de qualquer requisicao para api.gdoorweb
    if (this._gdoor_url && this._gdoor_url.indexOf('gdoorweb.com.br') !== -1) {
      var lower = name.toLowerCase();
      if (lower === 'authorization' || lower === 'x-token' || lower === 'x-api-key') {
        capturedAuthHeaders[name] = value;
      }
      if (this._gdoor_headers) this._gdoor_headers[name] = value;
    }
    return origSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    var xhr = this;

    if (isRelevantUrl(xhr._gdoor_url)) {
      xhr.addEventListener('load', function () {
        try {
          var data = JSON.parse(xhr.responseText);
          dispatch(xhr._gdoor_url, xhr._gdoor_method || 'GET', data);
        } catch (e) {
          // resposta nao e JSON — ignorar
        }
      });
    }

    return origSend.apply(this, arguments);
  };

  // ===== Interceptar fetch (fallback, caso Angular use fetch) =====

  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      var args = arguments;
      var url = '';
      if (typeof args[0] === 'string') {
        url = args[0];
      } else if (args[0] && args[0].url) {
        url = args[0].url;
      }

      var result = origFetch.apply(this, args);

      if (isRelevantUrl(url)) {
        result.then(function (response) {
          response.clone().json().then(function (data) {
            dispatch(url, 'FETCH', data);
          }).catch(function () {});
        }).catch(function () {});
      }

      return result;
    };
  }

  // ===== Proxy de API para content script (ISOLATED world) =====
  // Usa XHR nativo com os mesmos headers de auth que o Angular envia.
  // Tambem expoe os auth headers via evento para o content script usar em fetch direto.

  var FETCH_REQ = '__gdoor_fetch_req';
  var FETCH_RESP = '__gdoor_fetch_resp';
  var AUTH_HEADERS_EVENT = '__gdoor_auth_headers';

  function sendProxyResp(rid, data, error) {
    try {
      window.dispatchEvent(new CustomEvent(FETCH_RESP, {
        detail: JSON.stringify({ id: rid, data: data, error: error })
      }));
    } catch (e) {
      // silencioso
    }
  }

  // Responde pedidos de auth headers do content script
  window.addEventListener('__gdoor_get_auth', function () {
    try {
      window.dispatchEvent(new CustomEvent(AUTH_HEADERS_EVENT, {
        detail: JSON.stringify(capturedAuthHeaders)
      }));
    } catch (e) {
      // silencioso
    }
  });

  window.addEventListener(FETCH_REQ, function (e) {
    var req;
    try { req = JSON.parse(e.detail); } catch (ex) { return; }
    var rid = req.id;

    // Usa XHR nativo (mesmo mecanismo que Angular HttpClient)
    var xhr = new XMLHttpRequest();
    origOpen.call(xhr, 'GET', req.url, true);
    xhr.withCredentials = true;

    // Headers explicitamente passados pelo content script
    var headers = req.headers || {};
    Object.keys(headers).forEach(function (k) {
      origSetRequestHeader.call(xhr, k, headers[k]);
    });

    // Adiciona headers de auth capturados do Angular (se nao ja presentes)
    Object.keys(capturedAuthHeaders).forEach(function (k) {
      if (!headers[k]) {
        origSetRequestHeader.call(xhr, k, capturedAuthHeaders[k]);
      }
    });

    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          var data = JSON.parse(xhr.responseText);
          sendProxyResp(rid, data, null);
        } catch (pe) {
          sendProxyResp(rid, null, 'JSON parse error: ' + pe.message);
        }
      } else {
        sendProxyResp(rid, null, 'HTTP ' + xhr.status + ' em ' + req.url);
      }
    };

    xhr.onerror = function () {
      sendProxyResp(rid, null, 'XHR network error em ' + req.url);
    };

    xhr.ontimeout = function () {
      sendProxyResp(rid, null, 'XHR timeout em ' + req.url);
    };

    origSend.call(xhr);
  });

})();
