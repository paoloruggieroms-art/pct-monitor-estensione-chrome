/*
 * Ponte tra la dashboard localhost e la service worker dell'estensione.
 * La dashboard non può chiamare direttamente chrome.runtime: questo content
 * script riceve il comando via window.postMessage e apre lo scraper in background.
 */
(() => {
    'use strict';

    if (window.__pctDashboardBridgeLoaded) return;
    window.__pctDashboardBridgeLoaded = true;

    // Marcatore visibile alla pagina: le variabili del content script vivono in
    // un mondo isolato, mentre l'attributo sul tag <html> e' condiviso. Serve al
    // pannello per distinguere "estensione assente" da "servizio spento" senza
    // restare in attesa del timeout.
    (function segnalaPresenza() {
        var versione = '';
        try {
            versione = (chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest().version : '';
        } catch (e) { /* contesto estensione non valido */ }
        function marca() {
            if (document.documentElement) {
                document.documentElement.setAttribute('data-pct-estensione', versione || '1');
            }
        }
        marca();
        document.addEventListener('DOMContentLoaded', marca);
    })();

    // Verifica che il contesto dell'estensione sia ancora valido: dopo un
    // reload/aggiornamento dell'estensione, i content script gia' iniettati
    // restano "orfani" e chrome.runtime diventa undefined (Extension context
    // invalidated). In quel caso qualsiasi sendMessage andrebbe in crash.
    function extAlive() {
        try {
            return !!(chrome && chrome.runtime && chrome.runtime.id);
        } catch (e) {
            return false;
        }
    }

    function notificaRicarica(action) {
        window.postMessage({
            source: 'pct-extension',
            action: action,
            success: false,
            loggedIn: false,
            error: 'Estensione aggiornata: ricarica la pagina (F5) e riprova.',
            needsReload: true,
        }, '*');
    }

    function safeSend(msg, cb, resultAction) {
        if (!extAlive()) {
            if (resultAction) notificaRicarica(resultAction);
            return;
        }
        try {
            chrome.runtime.sendMessage(msg, (response) => {
                void chrome.runtime.lastError;
                if (cb) cb(response);
            });
        } catch (e) {
            if (resultAction) notificaRicarica(resultAction);
        }
    }

    // Base del backend derivata dalla pagina corrente. Su localhost e'
    // ".../pct"; sul server WordPress e' ".../wp-content/monitor". Usiamo la
    // cartella della pagina corrente, mantenendo il caso storico "/pct".
    function derivaBaseBackend() {
        var href = String(window.location.href).split('#')[0].split('?')[0];
        var mPct = href.match(/^(https?:\/\/[^\/]+\/pct)(?:\/|$)/i);
        if (mPct) return mPct[1];
        return href.replace(/\/[^\/]*$/, '');
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const data = event.data || {};
        if (data.source !== 'pct-dashboard') return;

        if (data.action === 'registerCf') {
            safeSend({
                action: 'registerCf',
                cfAvvocato: String(data.cfAvvocato || '').toUpperCase(),
            });
            return;
        }

        if (data.action === 'startOrderSync') {
            // Base del backend derivata dalla pagina corrente (localhost/pct o
            // sincpdatoscana.it/wp-content/monitor).
            var pageBase = derivaBaseBackend();
            safeSend({
                action: 'startOrderSync',
                cfAvvocato: String(data.cfAvvocato || '').toUpperCase(),
                codiciUffici: Array.isArray(data.codiciUffici) ? data.codiciUffici.map(String) : [],
                base: pageBase,
                full: !!data.full,
                fast: !!data.fast,
            }, (response) => {
                const error = (chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError.message : '';
                window.postMessage({
                    source: 'pct-extension',
                    action: 'startOrderSyncResult',
                    success: !error && !!(response && response.success),
                    error: error || (response && response.error) || '',
                }, '*');
            }, 'startOrderSyncResult');
            return;
        }

        if (data.action === 'pdaTokens') {
            // Token del PdA per la ricerca "Cerca fascicoli": la pagina chiama
            // il proprio backend (same-origin) passando access/refresh, quindi
            // niente finestre del portale e niente lavoro nel service worker.
            safeSend({ action: 'pdaTokens' }, (response) => {
                const error = (chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError.message : '';
                window.postMessage({
                    source: 'pct-extension',
                    action: 'pdaTokensResult',
                    success: !error && !!(response && response.success),
                    access: (response && response.access) || '',
                    refresh: (response && response.refresh) || '',
                    error: error || (response && response.error) || '',
                }, '*');
            }, 'pdaTokensResult');
            return;
        }

        if (data.action === 'syncAttiva') {
            // "C'e' gia' una sincronizzazione in corso?": la verita' la sa solo
            // l'estensione. Il record di progresso sul server puo' restare
            // "in_corso" dopo un browser chiuso o un aggiornamento
            // dell'estensione, e in quel caso il pulsante resterebbe bloccato.
            safeSend({ action: 'syncAttiva' }, (response) => {
                const error = (chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError.message : '';
                window.postMessage({
                    source: 'pct-extension',
                    action: 'syncAttivaResult',
                    // Senza risposta non si sa: si lascia decidere alla pagina.
                    noto: !error && !!(response && response.success),
                    attiva: !!(response && response.attiva),
                }, '*');
            }, 'syncAttivaResult');
            return;
        }

        if (data.action === 'startFascicoloSyncDiretto') {
            // Sync di un solo fascicolo SENZA aprire la scheda del portale:
            // stesso motore offscreen della sync per ufficio. La pagina segue
            // l'avanzamento con progresso_get, quindi qui basta l'esito
            // dell'avvio.
            var baseUno = derivaBaseBackend();
            safeSend({
                action: 'startFascicoloSyncDiretto',
                link: String(data.link || ''),
                cfAvvocato: String(data.cfAvvocato || '').toUpperCase(),
                base: baseUno,
                ufficio: String(data.ufficio || ''),
                nomeUfficio: String(data.nomeUfficio || ''),
                numero: String(data.numero || ''),
                etichetta: String(data.etichetta || ''),
                // Identita' completa: il salvataggio sul server pretende
                // id_ufficio, registro, anno e numero di ruolo. Senza, i
                // documenti finivano sul PC ma il pannello non si aggiornava.
                registro: String(data.registro || ''),
                annoRuolo: String(data.annoRuolo || ''),
                numeroRuolo: String(data.numeroRuolo || ''),
                subProcedimento: String(data.subProcedimento || '0'),
                nAtti: Number(data.nAtti || 0),
            }, (response) => {
                const error = (chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError.message : '';
                window.postMessage({
                    source: 'pct-extension',
                    action: 'startFascicoloSyncDirettoResult',
                    success: !error && !!(response && response.success),
                    error: error || (response && response.error) || '',
                }, '*');
            }, 'startFascicoloSyncDirettoResult');
            return;
        }

        if (data.action === 'startFascicoloSync') {
            // Sync remota di un singolo fascicolo: chiesta dal dettaglio del
            // pannello, apre la pagina del fascicolo sul PdA e avvia la
            // raccolta come se l'utente avesse premuto il pulsante del banner.
            safeSend({
                action: 'startFascicoloSync',
                link: String(data.link || ''),
            }, (response) => {
                const error = (chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError.message : '';
                window.postMessage({
                    source: 'pct-extension',
                    action: 'startFascicoloSyncResult',
                    success: !error && !!(response && response.success),
                    error: error || (response && response.error) || '',
                }, '*');
            }, 'startFascicoloSyncResult');
            return;
        }

        if (data.action === 'startPdaDocs') {
            // Download documenti dal PdA Toscana via job server-side (token
            // Keycloak catturati dall'interceptor). Stessa derivazione base.
            var pageBase2 = derivaBaseBackend();
            safeSend({
                action: 'pdaDocsStart',
                cfAvvocato: String(data.cfAvvocato || '').toUpperCase(),
                base: pageBase2,
            }, (response) => {
                const error = (chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError.message : '';
                window.postMessage({
                    source: 'pct-extension',
                    action: 'startPdaDocsResult',
                    success: !error && !!(response && response.success),
                    needLogin: !!(response && response.needLogin),
                    error: error || (response && response.error) || '',
                }, '*');
            }, 'startPdaDocsResult');
            return;
        }

        if (data.action === 'pstProbe') {
            safeSend({
                action: 'pstProbe',
                cf: String(data.cf || '').toUpperCase(),
                ufficio: data.ufficio, registro: data.registro,
                ruolo: data.ruolo, anno: data.anno, sistema: data.sistema,
            }, (response) => {
                const error = (chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError.message : '';
                window.postMessage({
                    source: 'pct-extension',
                    action: 'pstProbeResult',
                    success: !error && !!(response && response.success),
                    cookieCount: response && response.cookieCount,
                    result: response && response.result,
                    error: error || (response && response.error) || '',
                }, '*');
            }, 'pstProbeResult');
            return;
        }

        if (data.action === 'checkPdaLogin') {
            safeSend({
                action: 'checkPdaLogin',
                cfAvvocato: String(data.cfAvvocato || '').toUpperCase(),
            }, (response) => {
                const error = (chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError.message : '';
                window.postMessage({
                    source: 'pct-extension',
                    action: 'checkPdaLoginResult',
                    loggedIn: !error && !!(response && response.loggedIn),
                    error: error || (response && response.error) || '',
                }, '*');
            }, 'checkPdaLoginResult');
            return;
        }

        if (data.action === 'astarPreview') {
            // Anteprima di un documento del fascicolo che sta sul PC dell'avvocato:
            // il background interroga il servizio locale (AstarFirmaServer) e
            // restituisce il file in base64, che la pagina mostra nel modale.
            const reqId = String(data.reqId || '');
            safeSend({
                action: 'astarApriDocumento',
                cartella: String(data.cartella || ''),
                parte: String(data.parte || ''),
                nome: String(data.nome || ''),
                path: String(data.path || ''),
                raw: !!data.raw,
            }, (response) => {
                const error = (chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError.message : '';
                window.postMessage({
                    source: 'pct-extension',
                    action: 'astarPreviewResult',
                    reqId: reqId,
                    ok: !error && !!(response && response.ok),
                    mime: response && response.mime,
                    nome: response && response.nome,
                    dataBase64: response && response.dataBase64,
                    firmato: !!(response && response.firmato),
                    signatureChecked: !!(response && response.signatureChecked),
                    raw: !!(response && response.raw),
                    signers: (response && Array.isArray(response.signers)) ? response.signers : [],
                    error: error || (response && response.error) || '',
                }, '*');
            }, 'astarPreviewResult');
            return;
        }

        if (data.action === 'astarElenco') {
            // Elenco REALE dei file presenti sul PC per un fascicolo: serve alla
            // dashboard per mostrare solo i documenti effettivamente su disco
            // (niente voci fantasma dei metadati DB). Inoltra al servizio locale.
            const reqId = String(data.reqId || '');
            safeSend({
                action: 'astarElenco',
                cartella: String(data.cartella || ''),
            }, (response) => {
                const error = (chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError.message : '';
                window.postMessage({
                    source: 'pct-extension',
                    action: 'astarElencoResult',
                    reqId: reqId,
                    ok: !error && !!(response && response.ok),
                    files: (response && Array.isArray(response.files)) ? response.files : [],
                    error: error || (response && response.error) || '',
                }, '*');
            }, 'astarElencoResult');
            return;
        }

        if (data.action === 'astarElimina') {
            // Elimina l'intera cartella del fascicolo dal PC (pulsante
            // "Elimina fascicolo"). Inoltra al servizio locale; degrada in
            // modo pulito se il servizio e' spento o troppo vecchio.
            const reqId = String(data.reqId || '');
            safeSend({
                action: 'astarElimina',
                cartella: String(data.cartella || ''),
            }, (response) => {
                const error = (chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError.message : '';
                window.postMessage({
                    source: 'pct-extension',
                    action: 'astarEliminaResult',
                    reqId: reqId,
                    ok: !error && !!(response && response.ok),
                    eliminata: !!(response && response.eliminata),
                    assente: !!(response && response.assente),
                    outdated: !!(response && response.outdated),
                    offline: !!(response && response.offline),
                    error: error || (response && response.error) || '',
                }, '*');
            }, 'astarEliminaResult');
            return;
        }

        if (data.action === 'astarFirma') {
            // Pagina "Firma digitale": la chiamata al servizio locale viene fatta dal
            // background (il servizio accetta solo origin in whitelist, non questo sito).
            const reqId = String(data.reqId || '');
            safeSend({
                action: 'astarFirma',
                path: String(data.path || ''),
                method: String(data.method || 'GET'),
                campi: data.campi || null,
                fileBase64: data.fileBase64 || '',
                fileNome: String(data.fileNome || ''),
            }, (response) => {
                const error = (chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError.message : '';
                window.postMessage({
                    source: 'pct-extension',
                    action: 'astarFirmaResult',
                    reqId: reqId,
                    ok: !error && !!(response && response.ok),
                    stato: response && response.stato,
                    json: (response && response.json) || null,
                    mime: response && response.mime,
                    dataBase64: (response && response.dataBase64) || '',
                    error: error || (response && response.error) || '',
                }, '*');
            }, 'astarFirmaResult');
            return;
        }
    });
})();
