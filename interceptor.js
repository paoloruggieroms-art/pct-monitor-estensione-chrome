(function() {
    'use strict';
    if (window.__pctInterceptorActive) {
        // Già attivo: segnala subito che è pronto (per waitForInterceptorReady nel content script)
        window.postMessage({ type: 'pct-interceptor-ready' }, '*');
        return;
    }
    window.__pctInterceptorActive = true;

    // ── Helper: converti Blob in base64 e invia via postMessage ────────────────
    function sendBlobResult(blob, fileName) {
        const reader = new FileReader();
        reader.onload = function() {
            // reader.result = "data:mime/type;base64,XXXX"
            const dataUrl = reader.result;
            const commaIdx = dataUrl.indexOf(',');
            const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : '';
            const mime = blob.type || 'application/octet-stream';
            window.postMessage({
                type:      'pct-download-result',
                fileName:  fileName,
                base64:    base64,
                mimeType:  mime,
            }, '*');
        };
        reader.readAsDataURL(blob);
    }

    // ── Tracing API PdA (mappatura per il download server-side) ────────────────
    // Registra OGNI chiamata XHR/fetch alle API del PdA (URL, metodo, body,
    // status, content-type, snippet risposta JSON) e la invia al content script
    // che la gira al backend (logs/pda_trace.log via api_pda_trace.php).
    function pctTraceShouldSkip(url) {
        if (!url) return true;
        if (/^(data:|blob:|chrome-extension:)/i.test(url)) return true;
        if (/\.(js|css|png|jpe?g|gif|svg|ico|map|woff2?|ttf|eot)(\?|$)/i.test(url)) return true;
        return false;
    }

    function pctSendTrace(entry) {
        try { window.postMessage({ type: 'pct-api-trace', entry: entry }, '*'); } catch (e) {}
    }

    function pctBodyToStr(body) {
        try {
            if (body == null) return '';
            if (typeof body === 'string') return body.slice(0, 1500);
            if (typeof FormData !== 'undefined' && body instanceof FormData) {
                const parts = [];
                for (const [k, v] of body.entries()) parts.push(k + '=' + (typeof v === 'string' ? v : '[file]'));
                return parts.join('&').slice(0, 1500);
            }
            return String(body).slice(0, 1500);
        } catch (e) { return ''; }
    }

    function pctSnippet(text) {
        if (!text) return '';
        const t = text.trim();
        // Solo JSON: ci interessano le strutture dati, non l'HTML delle pagine
        if (!(t.startsWith('{') || t.startsWith('['))) return '';
        return t.slice(0, 4000);
    }

    // ── Ascolta comandi dal content script ─────────────────────────────────────
    window.addEventListener('message', function(event) {
        if (event.source !== window) return;
        const msg = event.data;
        if (!msg) return;

        // Imposta il fileName atteso prima del click
        if (msg.type === 'pct-set-waiting-file-name' || msg.type === 'pct-set-waiting-file') {
            window.__pctWaitingFileName = msg.fileName || '';
            console.log('[PCT] Interceptor: in attesa di blob per', window.__pctWaitingFileName);
        }
    });

    // ── Blocca download nativo: Angular fa <a>.click() con blob URL ─────────
    // Patch sia .click() che dispatchEvent() per coprire tutti i pattern Angular
    const _origAClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
        if (window.__pctSuppressDownload && this.href && this.href.startsWith('blob:')) {
            console.log('[PCT] Download nativo bloccato (.click) per:', this.download || this.href.slice(0, 50));
            window.__pctSuppressDownload = false;
            return; // PCT ha già catturato il blob, non scaricare su disco
        }
        return _origAClick.apply(this, arguments);
    };

    // Patch dispatchEvent per bloccare click sintetici su <a blob:>
    const _origDispatchEvent = HTMLAnchorElement.prototype.dispatchEvent;
    HTMLAnchorElement.prototype.dispatchEvent = function(event) {
        if (
            window.__pctSuppressDownload &&
            event && event.type === 'click' &&
            this.href && this.href.startsWith('blob:')
        ) {
            console.log('[PCT] Download nativo bloccato (dispatchEvent) per:', this.download || this.href.slice(0, 50));
            window.__pctSuppressDownload = false;
            return true;
        }
        return _origDispatchEvent.apply(this, arguments);
    };

    // ── Monkey-patch URL.createObjectURL ───────────────────────────────────────
    // Angular dopo aver ricevuto il blob fa:
    //   const url = URL.createObjectURL(blob)
    //   const a = document.createElement('a'); a.href = url; a.click()
    // Intercettiamo qui per catturare il blob prima del download.
    const _origCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function(obj) {
        const url = _origCreateObjectURL(obj);
        if (obj instanceof Blob && window.__pctWaitingFileName) {
            const fileName = window.__pctWaitingFileName;
            window.__pctWaitingFileName = null;
            window.__pctSuppressDownload = true; // blocca il prossimo <a>.click()
            console.log('[PCT] Blob catturato:', fileName, '(' + obj.size + ' bytes)');
            sendBlobResult(obj, fileName);
        }
        return url;
    };

    // ── Monkey-patch XMLHttpRequest ────────────────────────────────────────────
    // Intercetta POST a downloadDocumento per catturare la risposta blob
    // e inoltre inoltra al content script le risposte utili (profilo/calendario).
    const _origOpen = XMLHttpRequest.prototype.open;
    const _origSend = XMLHttpRequest.prototype.send;

    function shouldForwardResponse(url, text) {
        if (!url || !text) return false;
        if (url.includes('downloadDocumento')) return false; // gestito a parte come blob
        if (url.includes('/calendar/')) return true;
        if (/\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/i.test(text)) return true;
        if (/\b(codicefiscale|codice_fiscale|fiscalCode|email|pec|ordine|nome|cognome)\b/i.test(text)) return true;
        return false;
    }

    XMLHttpRequest.prototype.open = function(method, url) {
        this._pctMethod = method;
        this._pctUrl    = url;
        return _origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(body) {
        const url = this._pctUrl || '';
        const isDownload = this._pctMethod && this._pctMethod.toUpperCase() === 'POST' && url.includes('downloadDocumento');

        if (isDownload) {
            // Forza responseType blob per poter leggere la risposta
            this.responseType = 'blob';

            // Estrai il nome file dal body della richiesta
            let fileName = '';
            try {
                const parsed = typeof body === 'string' ? JSON.parse(body) : body;
                if (parsed && parsed.name) fileName = parsed.name;
            } catch (e) {}

            const self = this;

            this.addEventListener('load', function() {
                if (self.status >= 200 && self.status < 300 && self.response instanceof Blob) {
                    const fn = fileName || window.__pctWaitingFileName || 'documento';
                    window.__pctWaitingFileName = null;
                    sendBlobResult(self.response, fn);
                }
            });

            // Tracing: la POST downloadDocumento e' l'API chiave da replicare
            // server-side, quindi registriamo URL + body + esito.
            this.addEventListener('loadend', function() {
                if (!pctTraceShouldSkip(url)) {
                    pctSendTrace({
                        method: (self._pctMethod || 'GET').toUpperCase(),
                        url: url,
                        reqBody: pctBodyToStr(body),
                        status: self.status,
                        contentType: self.getResponseHeader('content-type') || '',
                        size: self.response instanceof Blob ? self.response.size : ((self.responseText || '').length),
                        respSnippet: '',
                    });
                }
            });
        } else {
            const self = this;
            this.addEventListener('load', function() {
                try {
                    let text = '';
                    if (typeof self.responseText === 'string') {
                        text = self.responseText;
                    } else if (self.response instanceof Blob) {
                        // ignora blob non-download
                        return;
                    }
                    if (!pctTraceShouldSkip(url)) {
                        pctSendTrace({
                            method: (self._pctMethod || 'GET').toUpperCase(),
                            url: url,
                            reqBody: pctBodyToStr(body),
                            status: self.status,
                            contentType: self.getResponseHeader('content-type') || '',
                            size: text.length,
                            respSnippet: pctSnippet(text),
                        });
                    }
                    // Cattura token Keycloak del PdA (access 5 min / refresh 30 min):
                    // servono al backend per replicare le API REST server-side.
                    if (url.indexOf('openid-connect/token') !== -1 && text.indexOf('access_token') !== -1) {
                        try {
                            const tk = JSON.parse(text);
                            if (tk.access_token) {
                                window.postMessage({
                                    type: 'pct-pda-token',
                                    access: tk.access_token,
                                    refresh: tk.refresh_token || '',
                                }, '*');
                            }
                        } catch (e) {}
                    }
                    if (shouldForwardResponse(url, text)) {
                        window.postMessage({
                            type: 'pct-network-response',
                            url: url,
                            text: text,
                        }, '*');
                    }
                } catch (e) {}
            });
        }
        return _origSend.apply(this, arguments);
    };

    // ── Monkey-patch fetch ─────────────────────────────────────────────────────
    // Alcune versioni di Angular usano fetch invece di XHR.
    const _origFetch = window.fetch;
    window.fetch = function(input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const method = (init && init.method || 'GET').toUpperCase();
        const isDownload = method === 'POST' && url.includes('downloadDocumento');

        if (isDownload) {
            let fileName = '';
            try {
                const body = init && init.body;
                const parsed = typeof body === 'string' ? JSON.parse(body) : body;
                if (parsed && parsed.name) fileName = parsed.name;
            } catch (e) {}

            return _origFetch.apply(this, arguments).then(function(response) {
                // Clone per non consumare il body originale
                const cloned = response.clone();
                cloned.blob().then(function(blob) {
                    const fn = fileName || window.__pctWaitingFileName || 'documento';
                    window.__pctWaitingFileName = null;
                    sendBlobResult(blob, fn);
                }).catch(function() {});
                if (!pctTraceShouldSkip(url)) {
                    pctSendTrace({
                        method: method,
                        url: url,
                        reqBody: pctBodyToStr(init && init.body),
                        status: response.status,
                        contentType: response.headers.get('content-type') || '',
                        size: 0,
                        respSnippet: '',
                    });
                }
                return response;
            });
        }

        return _origFetch.apply(this, arguments).then(function(response) {
            try {
                const cloned = response.clone();
                cloned.text().then(function(text) {
                    if (!pctTraceShouldSkip(url)) {
                        pctSendTrace({
                            method: method,
                            url: url,
                            reqBody: pctBodyToStr(init && init.body),
                            status: response.status,
                            contentType: response.headers.get('content-type') || '',
                            size: text.length,
                            respSnippet: pctSnippet(text),
                        });
                    }
                    // Cattura token Keycloak del PdA (vedi ramo XHR sopra).
                    if (url.indexOf('openid-connect/token') !== -1 && text.indexOf('access_token') !== -1) {
                        try {
                            const tk = JSON.parse(text);
                            if (tk.access_token) {
                                window.postMessage({
                                    type: 'pct-pda-token',
                                    access: tk.access_token,
                                    refresh: tk.refresh_token || '',
                                }, '*');
                            }
                        } catch (e) {}
                    }
                    if (shouldForwardResponse(url, text)) {
                        window.postMessage({
                            type: 'pct-network-response',
                            url: url,
                            text: text,
                        }, '*');
                    }
                }).catch(function() {});
            } catch (e) {}
            return response;
        });
    };

    console.log('[PCT] Network interceptor attivo');

    // ── Segnala al content script che l'interceptor è pronto ──────────────────
    window.postMessage({ type: 'pct-interceptor-ready' }, '*');
})();
