// Content script — si inietta nelle pagine SIGIT
// 1. Cattura cookie e li invia ad Aruba
// 2. Auto-compila il form di ricerca se presente #autoRicerca nell'URL
// 3. Scrapa "Dettaglio Fascicolo" e invia documenti ad Aruba
(function() {
    var _csId = Math.random().toString(36).slice(2); // ID univoco per questa iniezione

    // === GUARD ANTI-DOPPIA-INIEZIONE (SS-LOCK) ===
    // Il guard DOM (MV3-DOM-LOCK) non funzionava: quando SIGIT naviga internamente,
    // document.body cambia e la seconda iniezione non trovava l'attributo data-sigit-cs-id.
    // sessionStorage è condiviso e SINCRONO tra tutte le injection dello stesso tab+origin
    // e persiste attraverso navigazioni same-origin — perfetto come mutex cross-injection.
    // TTL 120 s copre sync lunghi; il lock viene rimosso prima di ogni click+navigate.
    var _SS_LOCK_KEY = 'sigit_cs_active';
    var _SS_LOCK_TTL = 120000; // 120 secondi
    try {
        var _rawLock = sessionStorage.getItem(_SS_LOCK_KEY);
        if (_rawLock) {
            var _existingLock = JSON.parse(_rawLock);
            var _lockFresh = _existingLock && _existingLock.id && (Date.now() - (_existingLock.ts || 0)) < _SS_LOCK_TTL;
            if (_lockFresh && _existingLock.id !== _csId) {
                var _lockUrl = _existingLock.url || '';
                var _curUrl = location.href;
                if (_lockUrl && _lockUrl === _curUrl) {
                    // Lock fresco, STESSA URL, id diverso → duplicato stessa pagina → blocca
                    try { chrome.runtime.sendMessage({action: 'dbg_log', msg: '[CT] SS-LOCK: iniezione duplicata ignorata (sameUrl activeId=' + _existingLock.id + ' thisId=' + _csId + ' age=' + Math.round((Date.now()-(_existingLock.ts||0))/1000) + 's)'}); } catch(e) {}
                    return; // ← uscita totale dalla IIFE: nessuna logica eseguita
                }
                // Lock fresco ma URL DIVERSA → navigazione avvenuta, nuova pagina → sovrascrive e procede
                try { chrome.runtime.sendMessage({action: 'dbg_log', msg: '[CT] SS-LOCK: nuova pagina dopo navigazione (lockUrl=' + _lockUrl + ' curUrl=' + _curUrl + ') — sovrascrittura lock'}); } catch(e) {}
            }
        }
    } catch(e) { /* JSON invalido o sessionStorage non disponibile — procedi */ }
    // Prima iniezione (o lock stale o nuova URL): registra questa istanza come attiva
    sessionStorage.setItem(_SS_LOCK_KEY, JSON.stringify({id: _csId, ts: Date.now(), url: location.href}));

    // === DBG FORWARDER: invia log al background (service worker) ===
    // [BUG2-FIX-14062026] Rimosso console.log locale: ogni dbgFwd generava 2 righe
    // (una nel content-script console, una nel service-worker via [CT-FWD]).
    // Ora il log appare una sola volta nel service-worker console.
    function dbgFwd(msg, data) {
        try {
            chrome.runtime.sendMessage({action: 'dbg_log', msg: '[CT] ' + msg + (data !== undefined ? ' ' + JSON.stringify(data).slice(0, 500) : '')});
        } catch(e) {}
    }

    // === DIAGNOSTICA ANAGRAFICA SIGIT (v2.1.6-cfprobe) ===
    // Esegue un dump una sola volta per page load — cerca CF, PEC, header utente
    function dumpAnagraficaSIGIT() {
        if (window.__sigit_anagrafica_dumped) return;
        window.__sigit_anagrafica_dumped = true;

        var result = { url: location.href, title: document.title, cfs: [], cfNodes: [], emails: [], headerCandidates: [], profiloLinks: [] };

        // --- A: Regex CF italiano su document.body.innerText ---
        var RE_CF = /[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]/g;
        var rawText = document.body ? document.body.innerText : '';
        result.cfs = [...new Set((rawText.match(RE_CF) || []))];

        // --- B: Per ogni CF trovato, traccia i nodi contenitore ---
        result.cfs.forEach(function(cf) {
            var allNodes = document.querySelectorAll('*');
            for (var ni = 0; ni < allNodes.length; ni++) {
                var node = allNodes[ni];
                if (node.children.length > 0) continue; // solo leaf nodes
                var t = node.innerText || node.textContent || '';
                if (t.indexOf(cf) === -1) continue;
                // Risali 4 livelli per costruire selector path
                var path = [];
                var cur = node;
                for (var lvl = 0; lvl < 4 && cur && cur.tagName; lvl++) {
                    var seg = cur.tagName.toLowerCase();
                    if (cur.id) seg += '#' + cur.id;
                    else if (cur.className && typeof cur.className === 'string') seg += '.' + cur.className.trim().split(/\s+/).join('.');
                    path.unshift(seg);
                    cur = cur.parentElement;
                }
                result.cfNodes.push({ cf: cf, tag: node.tagName, id: node.id || '', cls: (node.className || '').toString().substring(0, 80), path: path.join(' > '), text: t.substring(0, 120) });
                if (result.cfNodes.length >= 20) break; // limite sicurezza
            }
        });

        // --- C: Regex email/PEC ---
        var RE_EMAIL = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
        result.emails = [...new Set((rawText.match(RE_EMAIL) || []))].slice(0, 20);

        // --- D: Selettori candidati header utente ---
        var candidateSelectors = ['header *', '.user-info', '.profilo', '#header-utente', '.userbox', '[class*="utente"]', '[class*="profilo"]', '[id*="utente"]', '[id*="user"]', '.navbar', '#navbar', '.topbar', '#topbar', '[class*="header"]', '[class*="login"]'];
        candidateSelectors.forEach(function(sel) {
            try {
                var nodes = document.querySelectorAll(sel);
                nodes.forEach(function(n) {
                    var txt = (n.innerText || n.textContent || '').trim().substring(0, 200);
                    if (txt.length < 2) return;
                    result.headerCandidates.push({ sel: sel, tag: n.tagName, id: n.id || '', cls: (n.className || '').toString().substring(0, 60), text: txt });
                    if (result.headerCandidates.length >= 40) return;
                });
            } catch(e) {}
        });
        // Deduplica per testo
        var seenTexts = new Set();
        result.headerCandidates = result.headerCandidates.filter(function(h) {
            if (seenTexts.has(h.text)) return false;
            seenTexts.add(h.text);
            return true;
        }).slice(0, 30);

        // --- E: Link Profilo/Logout e testo vicino ---
        var allLinks = document.querySelectorAll('a, button, [onclick]');
        allLinks.forEach(function(el) {
            var txt = (el.innerText || el.textContent || '').trim().toLowerCase();
            if (txt.includes('profilo') || txt.includes('logout') || txt.includes('esci') || txt.includes('benvenuto') || txt.includes('utente')) {
                var parent = el.parentElement;
                var parentText = parent ? (parent.innerText || parent.textContent || '').trim().substring(0, 200) : '';
                result.profiloLinks.push({ tag: el.tagName, text: (el.innerText || el.textContent || '').trim().substring(0, 80), href: el.getAttribute('href') || '', onclick: (el.getAttribute('onclick') || '').substring(0, 80), parentText: parentText });
                if (result.profiloLinks.length >= 15) return;
            }
        });

        // --- F: Invia via dbgFwd (split a 8000 char) ---
        var fullJson = 'SIGIT-ANAGRAFICA-DUMP: ' + JSON.stringify(result, null, 0);
        var chunkSize = 7800;
        if (fullJson.length <= chunkSize) {
            dbgFwd(fullJson);
        } else {
            var parts = Math.ceil(fullJson.length / chunkSize);
            for (var pi = 0; pi < parts; pi++) {
                dbgFwd('SIGIT-ANAGRAFICA-DUMP PART' + (pi+1) + '/' + parts + ': ' + fullJson.substring(pi * chunkSize, (pi+1) * chunkSize));
            }
        }
    }

    // === SAFE JSON HELPERS (JSON-FIX 2.1.3) ===
    // safeJsonParse: parse JSON string, ritorna defaultVal su errore/vuoto, logga via dbgFwd
    function safeJsonParse(text, defaultVal, context) {
        if (text === null || text === undefined || text === '') {
            dbgFwd('JSON parse @' + context + ': testo vuoto — ritorno default', {defaultVal});
            return defaultVal;
        }
        try {
            return JSON.parse(text);
        } catch(e) {
            dbgFwd('JSON parse @' + context + ': ERRORE — ' + e.message + ' — bodyPreview=' + String(text).substring(0, 100), {});
            return defaultVal;
        }
    }

    // safeFetchJson: fetch + leggi text() + parse JSON con log dettagliato
    // Su status >= 400 o body non-JSON ritorna defaultVal SENZA throw
    async function safeFetchJson(resp, defaultVal, context) {
        var text = '';
        try {
            text = await resp.text();
        } catch(e) {
            dbgFwd('JSON parse @' + context + ': text() fallito — ' + e.message, {status: resp.status});
            return defaultVal;
        }
        dbgFwd('JSON parse @' + context + ': status=' + resp.status + ' bodyLen=' + text.length + ' bodyPreview=' + text.substring(0, 100), {});
        if (!text || text.trim() === '') {
            dbgFwd('JSON parse @' + context + ': body vuoto — ritorno default', {status: resp.status});
            return defaultVal;
        }
        if (resp.status === 404 || resp.status >= 500) {
            dbgFwd('JSON parse @' + context + ': HTTP ' + resp.status + ' — ritorno default', {});
            return defaultVal;
        }
        return safeJsonParse(text, defaultVal, context);
    }

    const SAVE_URL = 'https://www.sincronizzafascicolo.it/wp-content/monitor/save_cookie.php';
    const SAVE_STORICO_URL = 'https://www.sincronizzafascicolo.it/wp-content/monitor/save_storico.php';

    // Helper: aggiorna UI solo se esiste (pannello rimosso, operazione silenziosa)
    function _el(id) { return document.getElementById(id); }
    function setElHtml(id, html) { var el = _el(id); if (el) el.innerHTML = html; }
    function setElText(id, text) { var el = _el(id); if (el) el.textContent = text; }
    
    // === CATTURA COOKIE ===
    // Metodo 1: document.cookie (funziona solo se non HttpOnly)
    const cookies = document.cookie.split(';');
    let jsid = null, ltpa = null;
    cookies.forEach(function(c) {
        const parts = c.trim().split('=');
        const name = parts[0];
        const value = parts.slice(1).join('=');
        if (name === 'JSESSIONID') jsid = value;
        if (name === 'LtpaToken2') ltpa = value;
    });
    if (jsid) {
        fetch(SAVE_URL + '?tipo=sigit&name=JSESSIONID&value=' + encodeURIComponent(jsid))
            .then(r => r.text()).then(t => console.log('[SIGIT Cookie Catcher] JSESSIONID saved:', t));
    }
    if (ltpa) {
        fetch(SAVE_URL + '?tipo=sigit&name=LtpaToken2&value=' + encodeURIComponent(ltpa))
            .then(r => r.text()).then(t => console.log('[SIGIT Cookie Catcher] LtpaToken2 saved:', t));
    }
    // Metodo 2: chiedi al background di leggere via chrome.cookies API (funziona anche con HttpOnly)
    if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({action: 'readAndSaveCookies'});
    }

    // === TRIGGER DUMP DIAGNOSTICO ANAGRAFICA (una volta per page load) ===
    // Esegui dopo che il DOM è idle (document_idle) — nessun impatto sulla logica sync
    if (!window.__sigit_anagrafica_dumped) {
        setTimeout(dumpAnagraficaSIGIT, 1500);
    }

    // === SCRAPING DETTAGLIO FASCICOLO ===
    // Rileva se siamo nella pagina "Dettaglio Fascicolo" (tabella documenti)
    // Rileva pagina di login SIGIT — sessione scaduta
    var isLoginPage = window.location.href.includes('login.jsp') || 
        window.location.href.includes('/NIRWeb/login') ||
        (document.body && document.body.innerText.toLowerCase().includes('smart card') && document.body.innerText.toLowerCase().includes('accedi'));
    
    // Gestisce paginazione: accumula documenti da tutte le pagine
    // SOLO se il tab è stato aperto dal sync (background.js aggiunge #sigit_sync= nell'URL iniziale)
    // Il flag + dati vengono salvati in sessionStorage perché SIGIT naviga via JS perdendo l'hash
    if (window.location.hash && window.location.hash.includes('sigit_sync=')) {
        sessionStorage.setItem('sigit_sync_active', '1');
        sessionStorage.setItem('sigit_sync_data', window.location.hash);
    }
    
    // Se sessionStorage non ha il flag, chiedi al background.js se questo tab è un sync tab
    // (necessario perché i redirect HTTP 302 perdono l'hash prima che il content script venga iniettato)
    if (sessionStorage.getItem('sigit_sync_active') !== '1') {
        chrome.runtime.sendMessage({ action: 'get_sync_info' }, function(info) {
            if (info && info.commissione) {
                // È un sync tab — ma se siamo sulla login page, sessione scaduta
                if (isLoginPage) {
                    console.log('[SIGIT] Login page rilevata — sessione scaduta');
                    try { chrome.runtime.sendMessage({action: 'sync_failed', reason: 'session_expired'}); } catch(e) {}
                    return;
                }
                sessionStorage.setItem('sigit_sync_active', '1');
                sessionStorage.setItem('sigit_sync_data', '#sigit_sync=' + encodeURIComponent(JSON.stringify(info)));
                // Invia sync_started SUBITO per cancellare il timeout ERR-01
                try { chrome.runtime.sendMessage({action: 'sync_started'}); } catch(e) {}
                console.log('[SIGIT] Sync tab rilevato via get_sync_info. URL:', window.location.href);
                setTimeout(function() {
                    scrapeFascicolo();
                }, 2000);
            } else {
                // Non è un sync tab — se siamo su caricaDettaglio, aggiungi anchor per scroll
                if (window.location.href.includes('caricaDettaglio') && !window.location.hash) {
                    window.location.hash = 'contenuti_pagina';
                }
            }
        });
    } else {
        // Se siamo sulla login page durante un sync, sessione scaduta
        if (isLoginPage) {
            console.log('[SIGIT] Login page rilevata (sessionStorage) — sessione scaduta');
            try { chrome.runtime.sendMessage({action: 'sync_failed', reason: 'session_expired'}); } catch(e) {}
            return;
        }
        // Invia sync_started SUBITO per cancellare il timeout ERR-01
        try { chrome.runtime.sendMessage({action: 'sync_started'}); } catch(e) {}
        console.log('[SIGIT] Sync tab attivo (sessionStorage). URL:', window.location.href);
        setTimeout(function() {
            scrapeFascicolo();
        }, 2000);
    }

    // Controlla se c'è paginazione e naviga tutte le pagine
    function checkPagination() {
        // Cerca "Successivo" link (testo o title)
        const links = document.querySelectorAll('a');
        for (let l of links) {
            const txt = l.textContent.trim().toLowerCase();
            if (txt === 'successivo' || txt === 'succ.' || txt === 'next' || l.title === 'Successivo') {
                return l;
            }
        }
        // Cerca anche link con "d-...-p=N" nel href (paginazione display:tag di SIGIT)
        const currentPage = document.querySelector('.pagelinks .pagebanner, [class*="paginat"]');
        if (currentPage) {
            const nextPageLink = currentPage.querySelector('a:last-child');
            if (nextPageLink && nextPageLink.textContent.match(/^\d+$/)) return nextPageLink;
        }
        return null;
    }

    function getAllPageDocs() {
        // Legge documenti accumulati dal sessionStorage
        const key = 'sigit_docs_accumulator';
        const data = sessionStorage.getItem(key);
        return data ? safeJsonParse(data, [], 'sessionStorage/sigit_docs_accumulator') : [];
    }

    function savePageDocs(docs) {
        sessionStorage.setItem('sigit_docs_accumulator', JSON.stringify(docs));
    }

    function clearPageDocs() {
        sessionStorage.removeItem('sigit_docs_accumulator');
    }

    function saveFascicoloInfo(commissione, rgr, anno) {
        sessionStorage.setItem('sigit_fascicolo_info', JSON.stringify({commissione, rgr, anno}));
    }
    
    function getFascicoloInfo() {
        const data = sessionStorage.getItem('sigit_fascicolo_info');
        return data ? safeJsonParse(data, null, 'sessionStorage/sigit_fascicolo_info') : null;
    }
    
    function clearFascicoloInfo() {
        sessionStorage.removeItem('sigit_fascicolo_info');
    }

    // Navigazione multi-parte
    function getVisitedParti() {
        const data = sessionStorage.getItem('sigit_parti_visited');
        return data ? safeJsonParse(data, [], 'sessionStorage/sigit_parti_visited') : [];
    }
    
    function markParteVisited(parteName) {
        const visited = getVisitedParti();
        visited.push(parteName.toLowerCase().trim());
        sessionStorage.setItem('sigit_parti_visited', JSON.stringify(visited));
    }
    
    function clearPartiVisited() {
        sessionStorage.removeItem('sigit_parti_visited');
    }
    
    function getNextParteLink() {
        // Cerca nella sidebar i link alle parti: Ricorrente, Resistente, Ufficio
        const visited = getVisitedParti();
        const partiNames = ['ricorrente', 'resistente', 'ufficio'];
        
        // Debug: logga tutti gli elementi che contengono il nome di una parte
        console.log('[SIGIT] Parti già visitate:', visited);
        
        // Strategia 1: cerca qualsiasi elemento cliccabile che contenga il nome della parte
        const allElements = document.querySelectorAll('a, td[onclick], div[onclick], span[onclick], li[onclick], [role="button"], [style*="cursor"]');
        
        for (let parteName of partiNames) {
            if (visited.includes(parteName)) continue;
            for (let el of allElements) {
                const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                if (txt.includes(parteName) && txt.includes('tot.')) {
                    console.log('[SIGIT] Trovato elemento parte "' + parteName + '":', el.tagName, el.className, el.id, 'onclick:', el.getAttribute('onclick'), 'href:', el.getAttribute('href'));
                    return el;
                }
            }
            // Strategia 2: cerca link con testo esatto
            for (let el of allElements) {
                const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                if (txt === parteName) {
                    console.log('[SIGIT] Trovato link esatto "' + parteName + '":', el.tagName);
                    return el;
                }
            }
        }
        
        // Strategia 3: cerca qualsiasi elemento con testo che include la parte
        const allAll = document.querySelectorAll('*');
        for (let parteName of partiNames) {
            if (visited.includes(parteName)) continue;
            for (let el of allAll) {
                if (el.children.length > 2) continue; // skip container troppo grandi
                const txt = (el.innerText || '').trim().toLowerCase();
                if (txt === parteName && (el.tagName === 'A' || el.tagName === 'SPAN' || el.tagName === 'TD' || el.tagName === 'DIV' || el.getAttribute('onclick'))) {
                    console.log('[SIGIT] Strategia 3 - trovato "' + parteName + '":', el.tagName, el.outerHTML.substring(0, 200));
                    return el;
                }
            }
        }
        
        console.log('[SIGIT] Nessuna parte trovata nella sidebar!');
        return null;
    }
    
    // [BUG-UFFICIO-FIX-14062026] Normalizza il nome della parte processuale verso i valori
    // canonici attesi da upload_doc.php ($parteMap). SIGIT può restituire varianti come
    // "Ufficio Finanziario", "Agenzia delle Entrate", "Altra Parte Resistente MEF" ecc.
    // Usa strpos (substring) per robustezza, con priorità ALTRA PARTE > RICORRENTE > UFFICIO > RESISTENTE.
    function normalizeParte(parte) {
        if (!parte || typeof parte !== 'string' || !parte.trim()) return '';
        const p = parte.trim().toUpperCase()
            .replace(/[àáâã]/g,'A').replace(/[èéêë]/g,'E').replace(/[ìíîï]/g,'I')
            .replace(/[òóôõ]/g,'O').replace(/[ùúûü]/g,'U'); // strip accents
        if (p.includes('ALTRA PARTE') || p.includes('ALTRA RESISTENTE')) return 'ALTRA PARTE RESISTENTE';
        if (p.includes('RICORRENTE'))  return 'RICORRENTE';
        if (p.includes('UFFICIO') || p.includes('AGENZIA') || p.includes('ENTRATE')) return 'UFFICIO';
        if (p.includes('RESISTENTE'))  return 'RESISTENTE';
        if (p.includes('TRASVERSAL'))  return 'TRASVERSALI';
        return parte.trim(); // pass-through per valori non riconosciuti
    }

    function extractDocsWithParte(docTable, hasParteCol, currentParte) {
        const rows = docTable.querySelectorAll('tr');
        const documenti = [];
        for (let i = 1; i < rows.length; i++) {
            const cells = rows[i].querySelectorAll('td');
            if (cells.length < 3) continue;
            const doc = {};
            const cellTexts = Array.from(cells).map(c => c.innerText.trim());
            
            if (hasParteCol) {
                // Vista unificata: col 0 = Parte, col 1 = Tipologia, col 2 = Nome file, col 3 = Ricevuta, col 4 = Data
                // normalizeParte: converte "Ufficio Finanziario" → "UFFICIO" ecc. [BUG-UFFICIO-FIX]
                doc.parte = normalizeParte(cellTexts[0]) || cellTexts[0] || 'ALTRO';
                doc.tipologia = cellTexts[1];
                doc.file = (cellTexts[2] || '').trim();
                // [ORIGNAME-DOM] nome reale SIGIT (cella 'Nome file') per upload_doc.php original_name
                doc.original_name = doc.file;
                doc.ricevuta = cellTexts[3] || '';
                doc.data = cellTexts[4] || '';
            } else {
                // Vista per parte: col 0 = Tipologia, col 1 = Nome file, col 2 = Ricevuta, col 3 = Data
                // currentParte viene da sessionStorage 'sigit_parte_corrente' impostato da FALLBACK PARTI [BUG-UFFICIO-FIX]
                doc.parte = normalizeParte(currentParte) || 'SCONOSCIUTA';
                doc.tipologia = cellTexts[0];
                doc.file = (cellTexts[1] || '').trim();
                // [ORIGNAME-DOM] nome reale SIGIT (cella 'Nome file') per upload_doc.php original_name
                doc.original_name = doc.file;
                doc.ricevuta = cellTexts[2] || '';
                doc.data = cellTexts[3] || '';
            }
            
            // Raccogli onclick dei bottoni download per uso successivo
            const saveButtons = rows[i].querySelectorAll('img.clickable-doc[onclick], a[onclick*="doScarica"]');
            doc.onclicks = [];
            saveButtons.forEach(btn => {
                const onclick = btn.getAttribute('onclick');
                if (onclick) doc.onclicks.push(onclick);
            });
            
            // Raccogli parametro getListaRicevutePec per ricevute PEC (CONSEGNA/ACCETTAZIONE)
            const infoRicEl = rows[i].querySelector('[onclick*="getListaRicevutePec"]');
            if (infoRicEl) {
                const infoOnclick = infoRicEl.getAttribute('onclick');
                const ricMatch = infoOnclick.match(/getListaRicevutePec\(\s*'([^']*)'\s*\)/);
                if (ricMatch) doc.ricevutePecParam = ricMatch[1];
            }
            
            // Se documento UFFICIO senza file, logga la riga per debug
            if ((!doc.file || doc.file.trim() === '') && doc.parte && doc.parte.toUpperCase() === 'UFFICIO') {
            }
            
            const link = rows[i].querySelector('a[href*="download"], a[href*="allegato"], a[href*="file"]');
            if (link) doc.download_url = link.href;
            if (doc.file || doc.tipologia) documenti.push(doc);
        }
        return documenti;
    }

    function injectPanel(commissione, rgr, anno) {
        // Inietta pannello "Area Aruba" nella pagina SIGIT
        const dettaglio = document.querySelector('h2, h3, .titolo');
        // Cerca un punto di ancoraggio — dopo "Dettaglio Fascicolo" o in alto a destra
        let anchor = null;
        document.querySelectorAll('td, div').forEach(el => {
            if (el.innerText.includes('Dettaglio Fascicolo') && !anchor) anchor = el.closest('table') || el;
        });
        if (!anchor) anchor = document.querySelector('.breadcrumb, [class*="bread"]') || document.body.children[3];

        const panel = document.createElement('div');
        panel.id = 'altervista-panel';
        panel.style.cssText = 'position:fixed;top:120px;right:20px;z-index:99998;background:#1a1a2e;border:2px solid #4ecca3;border-radius:12px;padding:16px 20px;width:280px;font-family:monospace;color:#e0e0e0;box-shadow:0 8px 24px rgba(0,0,0,0.6);';
        
        panel.innerHTML = `
            <div style="font-size:14px;font-weight:bold;color:#4ecca3;margin-bottom:12px;text-align:center;">
                ☁️ Aruba Sync
            </div>
            <div style="font-size:11px;color:#aaa;margin-bottom:10px;text-align:center;">
                ${commissione}/${rgr}/${anno}
            </div>
            <div id="av-status" style="font-size:11px;color:#aaa;text-align:center;min-height:20px;"></div>
            <div id="av-progress" style="font-size:10px;color:#aaa;text-align:center;margin-top:4px;"></div>
        `;
        
        document.body.appendChild(panel);
    }

    function doSync(commissione, rgr, anno, userId) {
        // Usa documenti accumulati dallo scraping multi-pagina se disponibili
        const _rawAllDownloads = sessionStorage.getItem('sigit_all_downloads');
        dbgFwd('JSON parse @sessionStorage/sigit_all_downloads (doSync): bodyLen=' + (_rawAllDownloads ? _rawAllDownloads.length : 0) + ' bodyPreview=' + (_rawAllDownloads || '').substring(0, 100), {});
        let documenti = safeJsonParse(_rawAllDownloads, [], 'sessionStorage/sigit_all_downloads(doSync)');
        
        if (documenti.length === 0) {
            // Fallback: leggi dal DOM corrente
            const tables = document.querySelectorAll('table');
            let docTable = null;
            for (let t of tables) {
                const headerText = t.innerText.toLowerCase();
                if (headerText.includes('tipologia') && (headerText.includes('parte processuale') || headerText.includes('nome file'))) {
                    docTable = t;
                    break;
                }
            }
            if (!docTable) {
                setElHtml('av-status', '<span style="color:#ff4444;">❌ Tabella documenti non trovata</span>');
                return;
            }
            documenti = extractDocs(docTable);
        }
        
        if (documenti.length === 0) {
            setElHtml('av-status', '<span style="color:#ff4444;">❌ Nessun documento trovato</span>');
            return;
        }

        const payload = { commissione, rgr, anno, documenti, user_id: userId };
        
        if (!userId) {
            dbgFwd('save_storico ABORT — user_id mancante', {});
            setElHtml('av-status', '<span style="color:#ff4444;">❌ user_id mancante — login richiesto</span>');
            doDownloadAndUpload(commissione, rgr, anno, userId).then((result) => {
                const expiredFiles = result && result.expiredFiles ? result.expiredFiles : [];
                sessionStorage.removeItem('sigit_scrape_started');
                if (result && result.sessionExpired) {
                    try { chrome.runtime.sendMessage({action: 'sync_failed', reason: 'session_expired'}); } catch(e) {}
                } else {
                    try { chrome.runtime.sendMessage({ action: 'sync_done' }); } catch(e) {}
                }
                if (expiredFiles.length > 0) {
                    console.warn('[SIGIT] sessione scaduta — file non scaricati:', expiredFiles);
                }
            });
            return;
        }
        
        fetch(SAVE_STORICO_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(r => {
            dbgFwd('JSON parse @save_storico response: status=' + r.status, {});
            return safeFetchJson(r, {ok: false, error: 'response non-JSON'}, 'save_storico');
        })
        .then(data => {
            if (data.ok) {
                setElHtml('av-status', '<span style="color:#4ecca3;">✅ ' + data.documenti + ' documenti sincronizzati!</span>');
                try { chrome.runtime.sendMessage({ action: 'file_progress', message: '📋 ' + data.documenti + ' documenti sincronizzati', type: 'sync' }); } catch(e) {}
            } else {
                // RESILIENZA v2.1.4: save_storico fallito ma NON blocca doDownloadAndUpload
                dbgFwd('save_storico failed but continuing to doDownloadAndUpload', {error: data.error, db_warning: data.db_warning});
                setElHtml('av-status', '<span style="color:#ffaa00;">⚠️ storico: ' + (data.error || data.db_warning || 'warning') + '</span>');
                try { chrome.runtime.sendMessage({ action: 'file_progress', message: '⚠️ save_storico warning: ' + (data.error || data.db_warning || '?') + ' — procedo con download', type: 'warning' }); } catch(e) {}
            }
            // Auto-download mancanti dopo sync — sempre, indipendentemente da ok/error di save_storico
            setElHtml('av-status', '<span style="color:#ffaa00;">⏳ Download file mancanti...</span>');
            doDownloadAndUpload(commissione, rgr, anno, userId).then((result) => {
                const expiredFiles = result && result.expiredFiles ? result.expiredFiles : [];
                dbgFwd('sync finale — flow path', {pathHit: 'doSync_ok', docsFound: documenti.length, storicoOk: data.ok});
                sessionStorage.removeItem('sigit_scrape_started');
                if (result && result.sessionExpired) {
                    try { chrome.runtime.sendMessage({action: 'sync_failed', reason: 'session_expired'}); } catch(e) {}
                } else {
                    try { chrome.runtime.sendMessage({ action: 'sync_done' }); } catch(e) {}
                }
                if (expiredFiles.length > 0) {
                    console.warn('[SIGIT] sessione scaduta — file non scaricati:', expiredFiles);
                }
            });
        })
        .catch(err => {
            // RESILIENZA v2.1.4: anche su eccezione fetch save_storico, procedi con download
            dbgFwd('save_storico catch — continuing to doDownloadAndUpload', {error: err.message});
            setElHtml('av-status', '<span style="color:#ffaa00;">⚠️ storico err: ' + err.message + ' — procedo</span>');
            try { chrome.runtime.sendMessage({ action: 'file_progress', message: '⚠️ save_storico catch: ' + err.message + ' — procedo con download', type: 'warning' }); } catch(e) {}
            setElHtml('av-status', '<span style="color:#ffaa00;">⏳ Download file mancanti...</span>');
            doDownloadAndUpload(commissione, rgr, anno, userId).then((result) => {
                const expiredFiles = result && result.expiredFiles ? result.expiredFiles : [];
                dbgFwd('sync finale — flow path', {pathHit: 'doSync_ok_after_catch', docsFound: documenti.length});
                sessionStorage.removeItem('sigit_scrape_started');
                if (result && result.sessionExpired) {
                    try { chrome.runtime.sendMessage({action: 'sync_failed', reason: 'session_expired'}); } catch(e) {}
                } else {
                    try { chrome.runtime.sendMessage({ action: 'sync_done' }); } catch(e) {}
                }
                if (expiredFiles.length > 0) {
                    console.warn('[SIGIT] sessione scaduta — file non scaricati:', expiredFiles);
                }
            });
        });
    }

    const UPLOAD_DOC_URL = 'https://www.sincronizzafascicolo.it/wp-content/monitor/upload_doc.php';
    const LIST_DOWNLOADS_URL = 'https://www.sincronizzafascicolo.it/wp-content/monitor/list_downloads.php';
    const SIGIT_SCARICA_FILE = 'https://sigit.finanze.it/NIRWeb/Fascicolo.do?pagina=scaricaFile';
    const SIGIT_SCARICA_DOC = 'https://sigit.finanze.it/NIRWeb/Fascicolo.do?pagina=scaricaDocumento';

    function parseOnclick(onclick, doc, idx) {
        const parte = doc.parte || 'ALTRO';
        const tipologia = doc.tipologia || '';
        const nomeFile = (doc.file || '').trim();
        // [ORIGNAME-DOM] nome reale SIGIT letto dal DOM (NON sanitizzato), propagato a ogni download
        const origName = (doc.original_name || '').trim();
        
        const matchFile = onclick.match(/doScaricaFile\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*(true|false)\s*\)/);
        const matchDoc = onclick.match(/doScaricaDocumento\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*(true|false)\s*\)/);
        
        if (matchFile) {
            const isFirmato = matchFile[8] === 'true';
            const results = [];
            if (isFirmato) {
                // [BYTEMIRROR 2.3.0] DE-DUP: per un documento firmato scarichiamo UNA SOLA
                // variante: il P7M ORIGINALE via scaricaDocumento (nome byte-identico a SIGIT).
                // Il PDF leggibile per l'anteprima viene DERIVATO lato server da
                // upload_doc.php::p7m_extract_eager (artefatto), quindi NON scarichiamo piu'
                // anche il PDF via scaricaFile (era la causa del doppio download _pdf_p7m + .p7m).
                results.push({
                    type: 'file',
                    url: SIGIT_SCARICA_DOC,
                    params: {
                        p_progDoc: matchFile[1],
                        p_flagProt: matchFile[3],
                        p_idRicevuta: '',
                        p_tipologiaDocumento: matchFile[5],
                        p_tipologiaDocumentoDesc: matchFile[6],
                        p_isFileFirmato: 'true'
                    },
                    parte: parte,
                    tipologia: tipologia,
                    ricevuta: doc.ricevuta || '',
                    data: doc.data || '',
                    original_name: origName,
                    filename: nomeFile || (tipologia.replace(/\s+/g, '_') + '_' + (idx+1) + '.pdf.p7m')
                });
            } else {
                results.push({
                    type: 'file',
                    url: SIGIT_SCARICA_FILE,
                    params: {
                        p_progDoc: matchFile[1],
                        p_annoFile: matchFile[2],
                        p_flagProt: matchFile[3],
                        p_tipologiaDocumento: matchFile[5],
                        p_tipologiaDocumentoDesc: matchFile[6],
                        p_dataDeposito: matchFile[7],
                        p_isFileFirmato: 'false'
                    },
                    parte: parte,
                    tipologia: tipologia,
                    ricevuta: doc.ricevuta || '',
                    data: doc.data || '',
                    original_name: origName,
                    filename: nomeFile || (tipologia.replace(/\s+/g, '_') + '_' + (idx+1) + '.pdf')
                });
            }
            return results;
        } else if (matchDoc) {
            const isFirmatoDoc = matchDoc[6] === 'true';
            let fname = nomeFile || (tipologia.replace(/\s+/g, '_') + '_' + (idx+1) + '.pdf');
            // Se è la versione non firmata (PDF estratto) e il filename finisce con .p7m, rimuovi .p7m
            if (!isFirmatoDoc && fname.match(/\.p7m$/i)) {
                fname = fname.replace(/\.p7m$/i, '');
            }
            return {
                type: 'doc',
                url: SIGIT_SCARICA_DOC,
                params: {
                    p_progDoc: matchDoc[1],
                    p_flagProt: matchDoc[2],
                    p_idRicevuta: matchDoc[3],
                    p_tipologiaDocumento: matchDoc[4],
                    p_tipologiaDocumentoDesc: matchDoc[5],
                    p_isFileFirmato: matchDoc[6]
                },
                parte: parte,
                tipologia: tipologia,
                ricevuta: doc.ricevuta || '',
                data: doc.data || '',
                original_name: origName,
                filename: fname
            };
        }
        return null;
    }

    // [FIX-HTMLSKIP-14062026] Distingue "sessione scaduta" da "documento non accessibile":
    // un file restituisce HTML anche quando l'utente non ha diritto su quel RGR,
    // ma la sessione SIGIT è ancora attiva. Senza questo check il loop si interrompeva
    // al primo file inaccessibile dichiarando erroneamente "Sessione SIGIT scaduta".
    // [BUG1-FIX-14062026] Resa più restrittiva: 'smart card' da solo era troppo broad
    // (le pagine SIGIT autenticate la menzionano spesso). Ora richiede pattern combinati
    // più specifici della vera pagina di login NIRWeb.
    function isSessionExpiredPage(htmlText) {
        if (!htmlText) return false;
        const lower = htmlText.toLowerCase();
        // Marcatori inequivocabili della pagina di login SIGIT/NIRWeb
        const hasLoginUrl = lower.includes('login.jsp') || lower.includes('/nirweb/login');
        // 'smart card' + 'accedi' + 'login' combinati → solo nella pagina login
        const hasLoginKeywords = lower.includes('smart card') &&
                                 lower.includes('accedi') &&
                                 (lower.includes('login') || lower.includes('accesso al sistema'));
        const hasSessionExpiredMsg = lower.includes('sessione scaduta') || lower.includes('session expired');
        return hasLoginUrl || hasLoginKeywords || hasSessionExpiredMsg;
    }

    // === SANITIZE NAME (Fix 2 delta-sync dual-name matching) ===
    // Genera la versione sanitizzata del nome file come faceva la vecchia sanitizeSigitFilename:
    // spazi -> underscore, caratteri speciali -> underscore.
    // Usata per confrontare i nomi SIGIT originali con quelli gia' presenti su Aruba (vecchio formato).
    function sanitizeName(name) {
        return name.replace(/[\s]+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
    }

    async function doDownloadAndUpload(commissione, rgr, anno, userId) {
        dbgFwd('doDownloadAndUpload START', {commissione, rgr, anno, userId});

        // === DOWNLOAD LOCK (DL-LOCK-v2.3.8) ===
        // Mutua esclusione cross-istanza: impedisce che una seconda iniezione di content.js
        // (causata da navigazione interna SIGIT durante il loop) avvii un secondo loop parallelo
        // sugli stessi file. sessionStorage persiste across same-origin navigations nello stesso tab.
        // Formato: JSON { id: string, ts: number } — TTL 15 min (900000ms, pari al timeout background)
        const _DL_LOCK_KEY = 'sigit_dl_running';
        const _dlLockTs = Date.now();
        const _rawExistingLock = sessionStorage.getItem(_DL_LOCK_KEY);
        if (_rawExistingLock) {
            try {
                const _exLock = JSON.parse(_rawExistingLock);
                if (_exLock && _exLock.id && (_dlLockTs - (_exLock.ts || 0)) < 900000) {
                    // Lock fresco (<15 min): un'altra istanza sta già scaricando — abort
                    dbgFwd('doDownloadAndUpload BLOCKED — DL-LOCK già detenuto id=' + _exLock.id + ' age=' + Math.round((_dlLockTs - (_exLock.ts||0))/1000) + 's thisId=' + _csId, {});
                    return { sessionExpired: false, expiredFiles: [] };
                }
                // Lock stale (>15 min): istanza precedente probabilmente morta — ignora e sovrascrivi
                dbgFwd('doDownloadAndUpload — DL-LOCK stale, sovrascrivendo', {staleId: _exLock.id, ageSeconds: Math.round((_dlLockTs-(_exLock.ts||0))/1000)});
            } catch(e) { /* JSON invalido — sovrascrivi */ }
        }
        // Imposta lock con id=_csId (univoco per questa IIFE) e timestamp corrente
        sessionStorage.setItem(_DL_LOCK_KEY, JSON.stringify({ id: _csId, ts: _dlLockTs }));

        // Funzione helper per rilasciare il lock (solo se ancora nostro)
        function _releaseDlLock() {
            try {
                const _cur = sessionStorage.getItem(_DL_LOCK_KEY);
                if (_cur) { const _c = JSON.parse(_cur); if (_c && _c.id === _csId) sessionStorage.removeItem(_DL_LOCK_KEY); }
            } catch(e) {}
        }

        // Usa le info download salvate durante lo scraping (sessionStorage)
        const _rawSavedDocs = sessionStorage.getItem('sigit_all_downloads');
        // [DL-LOCK-v2.3.8] Svuota subito sigit_all_downloads: se una seconda istanza di content.js
        // supera il lock (scenario race), trova savedDocs vuoto → 0 downloads → return early.
        sessionStorage.removeItem('sigit_all_downloads');
        dbgFwd('JSON parse @sessionStorage/sigit_all_downloads (doDownloadAndUpload): bodyLen=' + (_rawSavedDocs ? _rawSavedDocs.length : 0) + ' bodyPreview=' + (_rawSavedDocs || '').substring(0, 100), {});
        const savedDocs = safeJsonParse(_rawSavedDocs, [], 'sessionStorage/sigit_all_downloads(doDownloadAndUpload)');
        dbgFwd('savedDocs from sessionStorage', {count: savedDocs.length, sample: savedDocs.slice(0,5).map(d => ({file: d.file, parte: d.parte, onclicksLen: (d.onclicks||[]).length}))});
        
        let downloads = [];
        
        if (savedDocs.length > 0) {
            savedDocs.forEach((doc, idx) => {
                if (!doc.onclicks || doc.onclicks.length === 0) return;
                // Skip documenti senza nome file E senza onclick scaricabile
                // (es. AVVISO DI TRATTAZIONE, COMUNICAZIONE PROVVEDIMENTO senza bottone save)
                if ((!doc.file || doc.file.trim() === '') && (!doc.onclicks || doc.onclicks.length === 0)) return;
                // [CT-NIRFIX] Deriva nome file da tipologia testuale + identificativo onclick
                // Convenzione: <TIPOLOGIA_COMPLETA>_<IdentificativoRicevuta>.pdf
                // es. RICEVUTA_ABBINAMENTO_ATTI_SUCCESSIVI_25122311243169210.pdf
                if (!doc.file || doc.file.trim() === '') {
                    let tipSanitized = '', idRic = '';
                    try {
                        const oc = (typeof doc.onclicks[0] === 'string') ? doc.onclicks[0] : '';
                        // Estrai tutti gli argomenti stringa singola-quota dall'onclick
                        const args = [...oc.matchAll(/'([^']*)'/g)].map(m => m[1]);
                        // Identificativo Ricevuta: primo argomento con >= 10 cifre consecutive
                        idRic = (args.find(a => /^\d{10,}$/.test(a))) || '';
                        // Tipologia: usa doc.tipologia (colonna 'Tipologia Documento' della tabella)
                        // Sanitize: maiuscolo, caratteri non [A-Z0-9] -> '_', collassa '_' multipli, trim '_' agli estremi
                        const rawTip = (doc.tipologia || '').trim();
                        tipSanitized = rawTip.toUpperCase()
                            .replace(/[^A-Z0-9]+/g, '_')
                            .replace(/_+/g, '_')
                            .replace(/^_|_$/g, '');
                        if (!tipSanitized) tipSanitized = 'DOC';
                    } catch (e) { tipSanitized = 'DOC'; }
                    doc.file = tipSanitized + (idRic ? '_' + idRic : '') + '.pdf';
                    console.log('[CT-NIRFIX] nome derivato:', doc.file);
                    // [FILENAME-CD-FIX] Il nome CT-NIRFIX (es. AVVISO_DI_TRATTAZIONE.pdf) differisce
                    // dal nome reale SIGIT (es. AvvTratt__5_2026.pdf). Lo conserviamo in original_name:
                    // upload_doc.php lo scrive nel manifest, list_downloads.php lo restituisce come
                    // alias → il delta-sync pre-download lo trova nella existingSet al prossimo sync.
                    if (!doc.original_name) doc.original_name = doc.file;
                }
                // [FIX-DEDUP-P7M-13062026] Per doc firmati scarica SOLO il .p7m (doScaricaFile isFirmato=true).
                // Salta doScaricaDocumento che scaricherebbe il .pdf ridondante: già estratto server-side
                // da upload_doc.php::p7m_extract_eager(). Evita doppio download/upload per ogni doc firmato.
                const hasFirmatoFile = doc.onclicks.some(oc => /doScaricaFile\(/.test(oc) && /,\s*true\s*\)/.test(oc));
                doc.onclicks.forEach(onclick => {
                    if (hasFirmatoFile && /doScaricaDocumento\(/.test(onclick)) {
                        dbgFwd('FIX-DEDUP-P7M — skip doScaricaDocumento per doc firmato', {file: doc.file, parte: doc.parte});
                        return;
                    }
                    const parsed = parseOnclick(onclick, doc, idx);
                    if (parsed) {
                        if (Array.isArray(parsed)) downloads.push(...parsed);
                        else downloads.push(parsed);
                    }
                });
            });
        } else {
            const saveButtons = document.querySelectorAll('img.clickable-doc[onclick]');
            saveButtons.forEach((btn, idx) => {
                const onclick = btn.getAttribute('onclick');
                const row = btn.closest('tr');
                const cells = row ? row.querySelectorAll('td') : [];
                const parte = cells[0] ? cells[0].innerText.trim() : 'ALTRO';
                const tipologia = cells[1] ? cells[1].innerText.trim() : '';
                const nomeFile = cells[2] ? cells[2].innerText.trim() : '';
                // [ORIGNAME-DOM] nome reale SIGIT (cella 'Nome file' NON sanitizzato)
                const origName = cells[2] ? cells[2].innerText.trim() : '';
                const doc = { parte, tipologia, file: nomeFile, original_name: origName };
                const parsed = parseOnclick(onclick, doc, idx);
                if (parsed) {
                    if (Array.isArray(parsed)) downloads.push(...parsed);
                    else downloads.push(parsed);
                }
            });
        }

        // [DEDUP-FIX] Rimuove voci duplicate prima del delta-sync.
        // Causa: doc con più onclick (es. doScaricaFile + doScaricaDocumento sullo stesso file firmato)
        // produceva 2 entry nel downloads array con la stessa parte/filename/url → doppio upload.
        // Chiave: parte/filename/url — include url per distinguere file DIVERSI con stesso nome.
        {
            const _seenDlKeys = new Set();
            downloads = downloads.filter(dl => {
                const k = dl.parte.toUpperCase() + '/' + dl.filename.toLowerCase() + '/' + (dl.url || '');
                if (_seenDlKeys.has(k)) {
                    dbgFwd('download DEDUP — skip duplicato', {filename: dl.filename, parte: dl.parte});
                    return false;
                }
                _seenDlKeys.add(k);
                return true;
            });
        }

        // [EML-ONLY-FILTER] Esclude tipologie che arrivano già via PEC/EML: non scaricabili da SIGIT.
        const EML_ONLY_TIPOLOGIE = ['COMUNICAZIONE PROVVEDIMENTO', 'AVVISO DI TRATTAZIONE'];
        downloads = downloads.filter(dl => {
            const tip = (dl.tipologia || '').toUpperCase();
            const isEmlOnly = EML_ONLY_TIPOLOGIE.some(t => tip.includes(t));
            if (isEmlOnly) {
                dbgFwd('SKIP-EML-ONLY: ' + (dl.tipologia || '(tipologia assente)'), {filename: dl.filename, parte: dl.parte});
                notifyProgress('📧 ' + (dl.tipologia || 'EML-ONLY') + ' - disponibile via PEC, skip download', 'info');
            }
            return !isEmlOnly;
        });

        dbgFwd('downloads from DOM', {count: downloads.length, sample: downloads.slice(0,10).map(d => d.filename || d.params && d.params.p_progDoc)});
        
        if (downloads.length === 0) {
            dbgFwd('doDownloadAndUpload END — 0 downloads, exit early', {savedDocsCount: savedDocs.length, docsWithOnclicks: savedDocs.filter(d => d.onclicks && d.onclicks.length > 0).length, docsWithFile: savedDocs.filter(d => d.file && d.file.trim() !== '').length});
            setElHtml('av-status', '<span style="color:#ff4444;">❌ Nessun file da scaricare</span>');
            _releaseDlLock(); // [DL-LOCK-v2.3.8]
            return { sessionExpired: false, expiredFiles: [] };
        }

        if (!userId) {
            dbgFwd('doDownloadAndUpload ABORT — user_id mancante', {});
            _releaseDlLock(); // [DL-LOCK-v2.3.8]
            return { sessionExpired: false, expiredFiles: [] };
        }

        // === DELTA-SYNC: chiedi ad Aruba quali file ha già ===
        let existingFiles = [];
        try {
            dbgFwd('list_downloads request', {commissione, rgr, anno, userId});
            const listResp = await fetch(LIST_DOWNLOADS_URL + '?commissione=' + encodeURIComponent(commissione) + '&rgr=' + encodeURIComponent(rgr) + '&anno=' + encodeURIComponent(anno) + '&user_id=' + encodeURIComponent(userId));
            const listData = await safeFetchJson(listResp, {ok: false, files: []}, 'list_downloads');
            if (listData.ok) existingFiles = listData.files || [];
            dbgFwd('list_downloads response', {existingCount: existingFiles.length, missingCount: downloads.length - existingFiles.length});
        } catch(e) {
            console.warn('[SIGIT] Impossibile ottenere lista file esistenti, scarico tutto');
            dbgFwd('list_downloads ERROR', {error: e.message});
        }

        // Costruisci set di file già presenti (parte_uppercase/filename)
        const existingSet = new Set();
        existingFiles.forEach(f => {
            existingSet.add(f.parte.toUpperCase() + '/' + f.filename.toLowerCase());
            // [FILENAME-CD-FIX] Supporto alias CT-NIRFIX: quando list_downloads restituisce
            // original_name (nome sintetico da tipologia), aggiungiamo anche quello alla existingSet.
            // Questo consente il pre-download delta-sync: AVVISO_DI_TRATTAZIONE.pdf generato da
            // CT-NIRFIX combacia con original_name e il file non viene riscaricato inutilmente.
            if (f.original_name) {
                existingSet.add(f.parte.toUpperCase() + '/' + f.original_name.toLowerCase());
            }
            // Se il file è un placeholder .nofile, aggiungi anche senza .nofile
            if (f.filename.toLowerCase().endsWith('.nofile')) {
                existingSet.add(f.parte.toUpperCase() + '/' + f.filename.toLowerCase().replace(/\.nofile$/, ''));
            }
            // [P7M-PROBE-DEDUP-18062026] .p7m presente -> dedup PDF base
            if (f.filename.toLowerCase().endsWith('.p7m')) {
                existingSet.add(f.parte.toUpperCase() + '/' + f.filename.toLowerCase().replace(/\.p7m$/i, ''));
            }
        });

        // [DUP-RENAME] PRIMA del delta-sync: SOLO per tipologia RICORSO o MEMORIE,
        // aggiungi SEMPRE suffisso _IDENTIFICATIVO_RICEVUTA prima dell'estensione.
        // Per TUTTE le altre tipologie: NESSUN suffisso, MAI.
        // Es: Brevi repliche.pdf.p7m → Brevi repliche_26060921115801448.pdf.p7m
        {
            const _alwaysSuffixTipo = ['RICORSO', 'MEMORIE'];
            for (let _di = 0; _di < downloads.length; _di++) {
                const _dl = downloads[_di];
                const _tipoUpper = (_dl.tipologia || '').trim().toUpperCase();
                const _needsSuffix = _alwaysSuffixTipo.some(t => _tipoUpper.includes(t));
                if (_needsSuffix && _dl.ricevuta) {
                    const _dotIdx = _dl.filename.indexOf('.');
                    let _newName;
                    if (_dotIdx > 0) {
                        _newName = _dl.filename.substring(0, _dotIdx) + '_' + _dl.ricevuta + _dl.filename.substring(_dotIdx);
                    } else {
                        _newName = _dl.filename + '_' + _dl.ricevuta;
                    }
                    downloads[_di] = Object.assign({}, _dl, { filename: _newName });
                    dbgFwd('DUP-RENAME — suffisso ID ricevuta', {original: _dl.filename, renamed: _newName, parte: _dl.parte, ricevuta: _dl.ricevuta, tipologia: _dl.tipologia});
                }
            }
        }

        // Filtra: scarica solo quelli mancanti
        // [BYTEMIRROR 2.3.0] IDEMPOTENZA: dl.filename e' ora BYTE-IDENTICO al nome SIGIT e
        // upload_doc.php salva il file con lo STESSO nome (zero sanitizzazione). list_downloads.php
        // restituisce i nomi grezzi dal disco. Quindi la chiave parte/nome combacia 1:1 al re-sync
        // e i documenti gia' presenti vengono saltati (niente piu' duplicati _pdf_p7m vs .pdf.p7m).
        const totalBefore = downloads.length;
        downloads = downloads.filter(dl => {
            const key = dl.parte.toUpperCase() + '/' + dl.filename.toLowerCase();
            const keySan = dl.parte.toUpperCase() + '/' + sanitizeName(dl.filename).toLowerCase();
            const skip = existingSet.has(key) || existingSet.has(keySan);
            if (skip) dbgFwd('upload_doc SKIP — already exists', {filename: dl.filename, parte: dl.parte, matchedSanitized: !existingSet.has(key)});
            return !skip;
        });

        dbgFwd('downloads after delta filter', {totalBefore, toDownload: downloads.length, alreadyPresent: totalBefore - downloads.length});

        // [P7M-DEDUP] Se X.pdf.p7m (o X.eml.p7m) è nella lista, salta X.pdf / X.eml:
        // il P7M contiene già il file originale firmato, scaricare entrambi è ridondante.
        // Il confronto è case-insensitive: .p7m e .P7M sono equivalenti.
        {
            const _p7mBaseNames = new Set();
            downloads.forEach(dl => {
                if (dl.filename.toLowerCase().endsWith('.p7m')) {
                    // Rimuove l'estensione .p7m (case-insensitive) per ottenere il nome base
                    _p7mBaseNames.add(dl.parte.toUpperCase() + '/' + dl.filename.toLowerCase().replace(/\.p7m$/i, ''));
                }
            });
            if (_p7mBaseNames.size > 0) {
                downloads = downloads.filter(dl => {
                    const k = dl.parte.toUpperCase() + '/' + dl.filename.toLowerCase();
                    if (_p7mBaseNames.has(k)) {
                        dbgFwd('SKIP ' + dl.filename + ' — versione P7M presente', {filename: dl.filename, parte: dl.parte});
                        notifyProgress('⏭️ SKIP ' + dl.filename + ' — versione P7M presente', 'info');
                        return false;
                    }
                    return true;
                });
                dbgFwd('downloads after P7M-dedup filter', {toDownload: downloads.length, p7mBaseNames: Array.from(_p7mBaseNames)});
            }
        }

        function notifyProgress(msg, type) {
            try { chrome.runtime.sendMessage({ action: 'file_progress', message: msg, type: type || 'info' }); } catch(e) {}
        }

        let success = 0, failed = 0;
        let p7mDownloaded = []; // P7M scaricati via form submit nativo
        let sessionExpiredFiles = []; // File non scaricati per sessione scaduta (riepilogo finale)
        let sessionExpiredDetected = false; // Flag: sessione definitivamente scaduta → interrompi loop
        
        if (downloads.length === 0) {
            notifyProgress('✅ Tutti i ' + totalBefore + ' file già presenti — nessun download necessario', 'done');
            setElHtml('av-status', '<span style="color:#4ecca3;">✅ Nessun nuovo file da scaricare</span>');
            // NON fare return — continua per scaricare ricevute PEC
        } else {

        notifyProgress('📥 Delta-sync: ' + downloads.length + ' nuovi file da scaricare (su ' + totalBefore + ' totali, ' + existingFiles.length + ' già presenti)', 'start');

        setElText('av-progress', '0/' + downloads.length);

        // Leggi il token Struts anti-CSRF dal form nascosto (necessario per scaricaDocumento)
        const strutsTokenInput = document.querySelector('input[name="org.apache.struts.taglib.html.TOKEN"]');
        const strutsToken = strutsTokenInput ? strutsTokenInput.value : '';

        // Crea iframe nascosto per i download P7M via form submit
        let dlIframe = document.getElementById('sigit_dl_frame');
        if (!dlIframe) {
            dlIframe = document.createElement('iframe');
            dlIframe.id = 'sigit_dl_frame';
            dlIframe.name = 'sigit_dl_frame';
            dlIframe.style.display = 'none';
            document.body.appendChild(dlIframe);
        }

        for (let i = 0; i < downloads.length; i++) {
            try {
                const dl = downloads[i];
                setElText('av-progress', (i+1) + '/' + downloads.length + ' — ' + dl.filename.substring(0, 30));
                notifyProgress('📥 ' + (i+1) + '/' + downloads.length + ' — ' + dl.filename, 'downloading');

                // [P7M-PROBE-DEBUG-18062026]
                try { const _db = new URLSearchParams({filename:dl.filename||'',source_action:dl.type||'',download_kind:dl.params.p_isFileFirmato==='true'?'p7m':'pdf',url:(dl.url||'').substring(0,100),parte:dl.parte||''});
                fetch('https://www.sincronizzafascicolo.it/wp-content/monitor/upload_doc.php?debug_ext_log=1',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:_db.toString()}).catch(function(){}); } catch(_e) {}

                // Heartbeat ogni 30s per resettare il timeout background
                if (i % 3 === 0) {
                    try { chrome.runtime.sendMessage({action: 'sync_alive'}); } catch(e) {}
                    // [DL-LOCK-v2.3.8] Rinnova timestamp lock (heartbeat) e verifica che sia ancora nostro
                    const _loopLockRaw = sessionStorage.getItem(_DL_LOCK_KEY);
                    if (_loopLockRaw) {
                        try {
                            const _loopLock = JSON.parse(_loopLockRaw);
                            if (_loopLock && _loopLock.id !== _csId) {
                                dbgFwd('download loop ABORT — DL-LOCK preso da altra istanza file=' + (i+1) + '/' + downloads.length, {thisId: _csId, lockId: _loopLock.id});
                                break;
                            }
                        } catch(e) {}
                    }
                    sessionStorage.setItem(_DL_LOCK_KEY, JSON.stringify({ id: _csId, ts: Date.now() }));
                }
                
                // Per file firmati (P7M) via scaricaDocumento: fetch con declarativeNetRequest che forza Sec-Fetch-Mode: navigate
                // NB: scaricaFile con isFileFirmato=true restituisce il PDF estratto → va nel branch normale
                if (dl.params.p_isFileFirmato === 'true' && dl.url.indexOf('scaricaDocumento') !== -1) {
                    dbgFwd('upload_doc START (P7M)', {filename: dl.filename, parte: dl.parte, progDoc: dl.params.p_progDoc});
                    try {
                        // Attiva regola headers P7M
                        await chrome.runtime.sendMessage({ action: 'enable_p7m_headers' });
                        await new Promise(r => setTimeout(r, 100));
                        
                        // Costruisci i parametri del form
                        const p7mParams = new URLSearchParams();
                        p7mParams.append('org.apache.struts.taglib.html.TOKEN', strutsToken);
                        p7mParams.append('p_progDoc', dl.params.p_progDoc || '');
                        p7mParams.append('p_flagProt', dl.params.p_flagProt || '');
                        p7mParams.append('p_idRicevuta', dl.params.p_idRicevuta || '');
                        p7mParams.append('p_tipologiaDocumento', dl.params.p_tipologiaDocumento || '');
                        p7mParams.append('p_tipologiaDocumentoDesc', dl.params.p_tipologiaDocumentoDesc || '');
                        p7mParams.append('p_isFileFirmato', 'true');
                        
                        const p7mResp = await fetch(dl.url, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: p7mParams.toString(),
                            credentials: 'include'
                        });
                        
                        // Disattiva regola headers
                        await chrome.runtime.sendMessage({ action: 'disable_p7m_headers' });
                        
                        const p7mContentType = p7mResp.headers.get('content-type') || '';
                        // [BUG1-FIX-14062026] content-disposition: attachment indica file reale
                        // indipendentemente dal content-type (che SIGIT può restituire errato).
                        const p7mContentDisp = p7mResp.headers.get('content-disposition') || '';
                        const p7mIsFileAttachment = p7mContentDisp.includes('attachment') || p7mContentDisp.includes('filename=');
                        let p7mBlob = await p7mResp.blob();
                        
                        // Verifica: P7M reale deve essere > 1KB e non HTML
                        // Se content-disposition indica attachment, è un file reale — salta il check HTML
                        if (!p7mIsFileAttachment && (p7mBlob.size < 1000 || p7mContentType.includes('text/html'))) {
                            // Se è HTML, è sessione scaduta — accumula silenziosamente per riepilogo finale
                            if (p7mContentType.includes('text/html')) {
                                // [FIX-HTMLSKIP-14062026] Leggi il body HTML per distinguere
                                // login page (sessione scaduta) da errore documento (file non accessibile).
                                const p7mHtmlText = await p7mBlob.text();
                                if (isSessionExpiredPage(p7mHtmlText)) {
                                    console.warn('[SIGIT] P7M ' + dl.filename + ' returned HTML login page — sessione scaduta');
                                    dbgFwd('P7M fetch returned HTML login page — session expired, stop loop', {filename: dl.filename, size: p7mBlob.size, contentType: p7mContentType});
                                    failed++;
                                    sessionExpiredFiles.push(dl.filename);
                                    sessionExpiredDetected = true;
                                    break;
                                } else {
                                    // [FIX-HTML-RETRY-14062026] SIGIT restituisce HTML transitorio per P7M VALIDI
                                    // (file appartiene all'avvocato loggato ma SIGIT risponde HTML per errore transitorio).
                                    // Riprova fino a 2 volte con backoff + session refresh prima di rinunciare.
                                    let p7mRetryOk = false;
                                    let p7mRetrySessionExpired = false;
                                    for (let hr = 0; hr < 2 && !p7mRetrySessionExpired; hr++) {
                                        const hrWait = (hr + 1) * 2000;
                                        notifyProgress('⏳ ' + dl.filename + ' — P7M html, retry ' + (hr+1) + '/2...', 'warning');
                                        dbgFwd('p7m html-retry ' + (hr+1) + '/2 wait=' + hrWait + 'ms', {filename: dl.filename, htmlPreview: p7mHtmlText.substring(0, 300)});
                                        await new Promise(r => setTimeout(r, hrWait));
                                        try { await fetch('https://sigit.finanze.it/NIRWeb/Fascicolo.do', {credentials: 'include'}); } catch(e) {}
                                        try { await chrome.runtime.sendMessage({ action: 'enable_p7m_headers' }); } catch(e) {}
                                        await new Promise(r => setTimeout(r, 100));
                                        const hrP7mResp = await fetch(dl.url, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                            body: p7mParams.toString(),
                                            credentials: 'include'
                                        });
                                        await chrome.runtime.sendMessage({ action: 'disable_p7m_headers' }).catch(()=>{});
                                        const hrP7mType = hrP7mResp.headers.get('content-type') || '';
                                        const hrP7mDisp = hrP7mResp.headers.get('content-disposition') || '';
                                        const hrP7mBlob = await hrP7mResp.blob();
                                        const hrP7mIsAttach = hrP7mDisp.includes('attachment') || hrP7mDisp.includes('filename=');
                                        if (hrP7mIsAttach || (!hrP7mType.includes('text/html') && hrP7mBlob.size >= 1000)) {
                                            p7mBlob = hrP7mBlob;
                                            p7mRetryOk = true;
                                            dbgFwd('p7m html-retry ' + (hr+1) + ' SUCCESS', {filename: dl.filename, size: hrP7mBlob.size, hrP7mType});
                                            break;
                                        }
                                        if (hrP7mType.includes('text/html')) {
                                            const hrP7mHtml = await hrP7mBlob.text();
                                            if (isSessionExpiredPage(hrP7mHtml)) {
                                                failed++; sessionExpiredFiles.push(dl.filename); sessionExpiredDetected = true;
                                                p7mRetrySessionExpired = true;
                                            } else {
                                                dbgFwd('p7m html-retry ' + (hr+1) + ' still HTML (not login)', {filename: dl.filename, hrP7mType, htmlPreview: hrP7mHtml.substring(0, 300)});
                                            }
                                        }
                                    }
                                    if (p7mRetrySessionExpired) break;
                                    if (!p7mRetryOk) {
                                        console.warn('[SIGIT] P7M ' + dl.filename + ' — non accessibile dopo tutti i retry');
                                        dbgFwd('p7m all html-retries exhausted — file not accessible', {filename: dl.filename});
                                        failed++;
                                        notifyProgress('⚠️ ' + dl.filename + ' — P7M non accessibile (saltato)', 'warning');
                                        continue;
                                    }
                                    // p7mRetryOk = true → p7mBlob aggiornato, procedi all'upload
                                }
                            } else {
                            // Fallback: form submit nativo (scarica sul PC) — solo per file troppo piccoli non-HTML
                            console.warn('[SIGIT] P7M fetch fallito per ' + dl.filename + ' (size=' + p7mBlob.size + ', type=' + p7mContentType + '), uso form submit');
                            dbgFwd('P7M fetch fallito — fallback form submit', {filename: dl.filename, size: p7mBlob.size, contentType: p7mContentType});
                            const form = document.getElementById('downloadDocForm');
                            if (form) {
                                form.target = 'sigit_dl_frame';
                                form.action = dl.url;
                                const setField = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
                                setField('p_progDoc', dl.params.p_progDoc);
                                setField('p_flagProt', dl.params.p_flagProt);
                                setField('p_idRicevuta', dl.params.p_idRicevuta);
                                setField('p_tipologiaDocumento', dl.params.p_tipologiaDocumento);
                                setField('p_tipologiaDocumentoDesc', dl.params.p_tipologiaDocumentoDesc);
                                setField('p_isFileFirmato', dl.params.p_isFileFirmato);
                                form.submit();
                                p7mDownloaded.push(dl.filename);
                                success++;
                                notifyProgress('⬇️ ' + dl.filename + ' → scaricato in Download (fallback)', 'warning');
                                await new Promise(r => setTimeout(r, 500));
                            } else {
                                failed++;
                                notifyProgress('⚠️ ' + dl.filename + ' — form non trovato', 'warning');
                            }
                            continue;
                            }
                        }
                        
                        // Upload P7M su Aruba
                        const p7mUploadForm = new FormData();
                        p7mUploadForm.append('commissione', commissione);
                        p7mUploadForm.append('rgr', rgr);
                        p7mUploadForm.append('anno', anno);
                        p7mUploadForm.append('parte', dl.parte);
                        p7mUploadForm.append('user_id', userId);
                        p7mUploadForm.append('file', p7mBlob, dl.filename);
                        // [ORIGNAME-DOM] nome reale SIGIT dal DOM (vuoto -> server fa fallback al nome fisico)
                        if (dl.original_name) p7mUploadForm.append('original_name', dl.original_name);
                        // TIPOLOGIA-T45-14062026: passa tipologia/ricevuta/data per trigger template4+5 lato server
                        if (dl.tipologia) p7mUploadForm.append('tipologia', dl.tipologia);
                        if (dl.ricevuta) p7mUploadForm.append('id_ricevuta', dl.ricevuta);
                        if (dl.data) p7mUploadForm.append('data_deposito', dl.data);
                        
                        const p7mUpResp = await fetch(UPLOAD_DOC_URL, { method: 'POST', body: p7mUploadForm });
                        const p7mUpData = await safeFetchJson(p7mUpResp, {ok: false, error: 'upload response non-JSON'}, 'upload_doc/p7m');
                        if (p7mUpData.ok) {
                            success++;
                            notifyProgress('✅ ' + dl.filename + ' P7M (' + Math.round(p7mBlob.size/1024) + ' KB)', 'success');
                        } else {
                            failed++;
                            notifyProgress('❌ ' + dl.filename + ' — ' + (p7mUpData.error || 'upload fallito'), 'error');
                        }
                    } catch(p7mErr) {
                        console.error('[SIGIT] P7M error:', p7mErr);
                        await chrome.runtime.sendMessage({ action: 'disable_p7m_headers' }).catch(()=>{});
                        failed++;
                        notifyProgress('❌ ' + dl.filename + ' — ' + p7mErr.message, 'error');
                    }
                    await new Promise(r => setTimeout(r, 500));
                    continue;
                }
                
                dbgFwd('non-P7M START', {filename: dl.filename, parte: dl.parte, url: dl.url});

                // [P7M-PROBE-18062026] Probe P7M per doc PDF-only
                if (dl.params.p_isFileFirmato === 'false' && dl.url.indexOf('scaricaFile') !== -1 && dl.params.p_progDoc) {
                    let _probeOk = false;
                    try {
                        dbgFwd('P7M-PROBE', {filename: dl.filename, progDoc: dl.params.p_progDoc});
                        await chrome.runtime.sendMessage({action:'enable_p7m_headers'});
                        await new Promise(r => setTimeout(r, 100));
                        const _pp = new URLSearchParams({'org.apache.struts.taglib.html.TOKEN':strutsToken,
                            p_progDoc:dl.params.p_progDoc||'',p_flagProt:dl.params.p_flagProt||'',
                            p_idRicevuta:'',p_tipologiaDocumento:dl.params.p_tipologiaDocumento||'',
                            p_tipologiaDocumentoDesc:dl.params.p_tipologiaDocumentoDesc||'',p_isFileFirmato:'true'});
                        const _pr = await fetch(SIGIT_SCARICA_DOC, {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:_pp.toString(),credentials:'include'});
                        await chrome.runtime.sendMessage({action:'disable_p7m_headers'}).catch(function(){});
                        const _pCT = _pr.headers.get('content-type')||'',_pCD = _pr.headers.get('content-disposition')||'';
                        const _pBlob = await _pr.blob();
                        if (_pCD.includes('attachment')||_pCD.includes('filename=')||(!_pCT.includes('text/html')&&_pBlob.size>=1000)) {
                            const _p7mN = dl.filename.match(/\.p7m$/i)?dl.filename:dl.filename+'.p7m';
                            dbgFwd('P7M-PROBE OK', {filename:dl.filename,p7mName:_p7mN,size:_pBlob.size});
                            const _pF = new FormData();
                            _pF.append('commissione',commissione);_pF.append('rgr',rgr);
                            _pF.append('anno',anno);_pF.append('parte',dl.parte);
                            _pF.append('user_id',userId);_pF.append('file',_pBlob,_p7mN);
                            if(dl.original_name)_pF.append('original_name',dl.original_name);
                            if(dl.tipologia)_pF.append('tipologia',dl.tipologia);
                            if(dl.ricevuta)_pF.append('id_ricevuta',dl.ricevuta);
                            if(dl.data)_pF.append('data_deposito',dl.data);
                            const _pUD = await safeFetchJson(await fetch(UPLOAD_DOC_URL,{method:'POST',body:_pF}),{ok:false,error:'non-JSON'},'p7m-probe');
                            if(_pUD.ok){success++;notifyProgress('✅ '+_p7mN+' P7M ('+Math.round(_pBlob.size/1024)+'KB)','success');}
                            else{failed++;notifyProgress('❌ '+_p7mN+' — '+(_pUD.error||'fallito'),'error');}
                            _probeOk = true; await new Promise(r => setTimeout(r,500));
                        } else { dbgFwd('P7M-PROBE MISS',{filename:dl.filename,size:_pBlob.size}); }
                    } catch(_pe) {
                        dbgFwd('P7M-PROBE ERR',{filename:dl.filename,err:_pe.message});
                        await chrome.runtime.sendMessage({action:'disable_p7m_headers'}).catch(function(){});
                    }
                    if (_probeOk) continue;
                }

                // Per file non firmati: fetch diretto + upload su Aruba
                const formData = new URLSearchParams(dl.params);
                let response = await fetch(dl.url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: formData.toString(),
                    credentials: 'include'
                });
                
                let contentType = response.headers.get('content-type') || '';
                // [BUG1-FIX-14062026] content-disposition: attachment = file reale anche se content-type è text/html
                let contentDisp = response.headers.get('content-disposition') || '';
                if (!contentDisp.includes('attachment') && !contentDisp.includes('filename=') && contentType.includes('text/html')) {
                    // [FIX-SESSION-RETRY-13062026] Sessione scaduta — refresh e retry silenzioso (max 1 tentativo)
                    console.warn('[SIGIT] File ' + dl.filename + ' returned HTML — sessione scaduta, refresh silenzioso...');
                    dbgFwd('fetch returned HTML — session expired, refreshing (silent)', {filename: dl.filename, contentType});
                    // Nessun notifyProgress qui: il retry è silenzioso
                    try {
                        await fetch('https://sigit.finanze.it/NIRWeb/Fascicolo.do', {credentials: 'include'});
                    } catch(e) { dbgFwd('session refresh error', {error: e.message}); }
                    await new Promise(r => setTimeout(r, 1000));
                    // Retry download dopo refresh sessione (silenzioso)
                    response = await fetch(dl.url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: formData.toString(),
                        credentials: 'include'
                    });
                    contentType = response.headers.get('content-type') || '';
                    contentDisp = response.headers.get('content-disposition') || '';
                    if (!contentDisp.includes('attachment') && !contentDisp.includes('filename=') && contentType.includes('text/html')) {
                        // [FIX-HTMLSKIP-14062026] Leggi il body HTML per distinguere
                        // login page (sessione scaduta) da errore documento (file non accessibile).
                        const htmlAfterRetry = await response.text();
                        if (isSessionExpiredPage(htmlAfterRetry)) {
                            console.warn('[SIGIT] File ' + dl.filename + ' returned HTML after retry — sessione scaduta, stop loop');
                            dbgFwd('fetch retry also returned HTML login page — session expired, stop loop', {filename: dl.filename, contentType});
                            failed++;
                            sessionExpiredFiles.push(dl.filename);
                            sessionExpiredDetected = true;
                            break;
                        } else {
                            // [FIX-HTML-RETRY-14062026] SIGIT restituisce HTML transitorio per file VALIDI
                            // (RGR corretto, avvocato loggato, ma SIGIT risponde HTML per errore transitorio).
                            // Riprova fino a 2 volte con backoff crescente + session refresh prima di rinunciare.
                            let htmlRetryOk = false;
                            let htmlRetrySessionExpired = false;
                            for (let hr = 0; hr < 2 && !htmlRetrySessionExpired; hr++) {
                                const hrWait = (hr + 1) * 2000;
                                notifyProgress('⏳ ' + dl.filename + ' — SIGIT html, retry ' + (hr+1) + '/2...', 'warning');
                                dbgFwd('html-retry ' + (hr+1) + '/2 wait=' + hrWait + 'ms', {filename: dl.filename, htmlPreview: htmlAfterRetry.substring(0, 300)});
                                await new Promise(r => setTimeout(r, hrWait));
                                try { await fetch('https://sigit.finanze.it/NIRWeb/Fascicolo.do', {credentials: 'include'}); } catch(e) {}
                                const hrResp = await fetch(dl.url, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                    body: formData.toString(),
                                    credentials: 'include'
                                });
                                const hrType = hrResp.headers.get('content-type') || '';
                                const hrDisp = hrResp.headers.get('content-disposition') || '';
                                if (hrDisp.includes('attachment') || hrDisp.includes('filename=') || !hrType.includes('text/html')) {
                                    response = hrResp; contentType = hrType; contentDisp = hrDisp;
                                    htmlRetryOk = true;
                                    dbgFwd('html-retry ' + (hr+1) + ' SUCCESS', {filename: dl.filename, hrType});
                                    break;
                                }
                                const hrHtml = await hrResp.text();
                                if (isSessionExpiredPage(hrHtml)) {
                                    dbgFwd('html-retry returned login page — session expired', {filename: dl.filename, hr});
                                    failed++; sessionExpiredFiles.push(dl.filename); sessionExpiredDetected = true;
                                    htmlRetrySessionExpired = true;
                                } else {
                                    dbgFwd('html-retry ' + (hr+1) + ' still HTML (not login)', {filename: dl.filename, hrType, htmlPreview: hrHtml.substring(0, 300)});
                                }
                            }
                            if (htmlRetrySessionExpired) break;
                            if (!htmlRetryOk) {
                                console.warn('[SIGIT] File ' + dl.filename + ' — non accessibile dopo tutti i retry');
                                dbgFwd('all html-retries exhausted — file not accessible', {filename: dl.filename, contentType});
                                failed++;
                                notifyProgress('⚠️ ' + dl.filename + ' — non accessibile (saltato)', 'warning');
                                continue;
                            }
                            // htmlRetryOk = true → response/contentType/contentDisp aggiornati, procedi con blob
                        }
                    }
                }
                
                const blob = await response.blob();
                if (blob.size < 100) {
                    console.warn('[SIGIT] File ' + dl.filename + ' too small (' + blob.size + 'b)');
                    notifyProgress('⚠️ ' + dl.filename + ' — file vuoto', 'warning');
                    dbgFwd('fetch blob too small', {filename: dl.filename, size: blob.size});
                    failed++;
                    continue;
                }

                const uploadForm = new FormData();
                uploadForm.append('commissione', commissione);
                uploadForm.append('rgr', rgr);
                uploadForm.append('anno', anno);
                uploadForm.append('parte', dl.parte);
                uploadForm.append('user_id', userId);
                uploadForm.append('file', blob, dl.filename);
                // [ORIGNAME-DOM] nome reale SIGIT dal DOM (vuoto -> server fa fallback al nome fisico)
                if (dl.original_name) uploadForm.append('original_name', dl.original_name);
                // TIPOLOGIA-T45-14062026: passa tipologia/ricevuta/data per trigger template4+5 lato server
                if (dl.tipologia) uploadForm.append('tipologia', dl.tipologia);
                if (dl.ricevuta) uploadForm.append('id_ricevuta', dl.ricevuta);
                if (dl.data) uploadForm.append('data_deposito', dl.data);
                
                const upResp = await fetch(UPLOAD_DOC_URL, { method: 'POST', body: uploadForm });
                const upData = await safeFetchJson(upResp, {ok: false, error: 'upload response non-JSON'}, 'upload_doc/non-p7m');
                if (upData.ok) {
                    success++;
                    notifyProgress('✅ ' + dl.filename + ' (' + Math.round(blob.size/1024) + ' KB)', 'success');
                } else {
                    console.error('[SIGIT] Upload failed:', upData);
                    notifyProgress('❌ ' + dl.filename + ' — ' + (upData.error || 'upload fallito'), 'error');
                    failed++;
                }
                
                await new Promise(r => setTimeout(r, 500));
                
            } catch(e) {
                console.error('[SIGIT] Download/upload error:', e);
                notifyProgress('❌ Errore: ' + e.message, 'error');
                failed++;
            }
        }

        } // fine else (downloads.length > 0)

        // === SESSIONE SCADUTA: interrompi e segnala al chiamante ===
        if (sessionExpiredDetected) {
            notifyProgress('⚠️ Sessione SIGIT scaduta — ' + sessionExpiredFiles.length + ' file non scaricati. Effettua il Login CNS su SIGIT e riprova.', 'error');
            dbgFwd('sessionExpiredDetected → return early, il chiamante invierà sync_failed', {expiredCount: sessionExpiredFiles.length});
            _releaseDlLock(); // [DL-LOCK-v2.3.8]
            return { sessionExpired: true, expiredFiles: sessionExpiredFiles };
        }

        // === RICEVUTE PEC: scarica CONSEGNA/ACCETTAZIONE .eml ===
        const docsWithRicevute = savedDocs.filter(d => d.ricevutePecParam);
        if (docsWithRicevute.length > 0) {
            notifyProgress('📨 Scarico ricevute PEC (' + docsWithRicevute.length + ' documenti con ricevute)...', 'info');
            
            for (let ri = 0; ri < docsWithRicevute.length; ri++) {
                const rdoc = docsWithRicevute[ri];
                try {
                    // Fetch diretto a NirJSON.do per ottenere lista ricevute PEC
                    const ricUrl = 'https://sigit.finanze.it/NIRWeb/NirJSON.do?lista=listaRicevutePec&str=' + encodeURIComponent(rdoc.ricevutePecParam);
                    const ricResp = await fetch(ricUrl, {
                        credentials: 'include',
                        headers: {
                            'X-Requested-With': 'XMLHttpRequest',
                            'Referer': 'https://sigit.finanze.it/NIRWeb/Fascicolo.do'
                        }
                    });
                    const ricevuteHtml = ricResp.ok ? await ricResp.text() : '';
                    
                    if (!ricevuteHtml || ricevuteHtml.length < 50) {
                        notifyProgress('⚠️ Ricevute PEC vuote per ' + rdoc.tipologia, 'warning');
                        continue;
                    }
                    
                    // Parsa l'HTML del popup per estrarre i parametri doScaricaFile delle ricevute
                    // Estrai anche gli indirizzi PEC: ogni riga <tr> ha <td>tipo</td><td>email</td><td>data</td><td>button</td>
                    const emailMatches = [...ricevuteHtml.matchAll(/<tr[^>]*>.*?<td[^>]*>.*?<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>.*?<\/td>\s*<td[^>]*>.*?doScaricaFile\([^)]*'([^']*)',\s*(true|false)\).*?<\/td>/gs)];
                    const emailByIndex = {};
                    emailMatches.forEach((em, idx) => { emailByIndex[idx] = em[1]; });
                    
                    const regexMatches = [...ricevuteHtml.matchAll(/doScaricaFile\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*(true|false)\s*\)/g)];
                    if (regexMatches.length === 0) {
                        notifyProgress('⚠️ Nessun pulsante scarica in ricevute PEC per ' + rdoc.tipologia, 'warning');
                        continue;
                    }
                    for (let ricIdx = 0; ricIdx < regexMatches.length; ricIdx++) {
                        const ricMatch = regexMatches[ricIdx];
                        const ricTipo = ricMatch[6];
                        const ricId = ricMatch[4]; // idRicevuta univoco
                        const ricEmail = emailByIndex[ricIdx] || '';
                        const ricFilename = (rdoc.data || '').replace(/\//g, '-') + '_' + rdoc.tipologia.replace(/\s+/g, '_') + '_' + ricId + '_RICEVUTA_' + ricTipo + '.eml';
                        // Delta-sync: skip download se già presente, ma aggiorna metadati pec_email
                        const ricKey = (rdoc.parte || 'UFFICIO').toUpperCase() + '/' + ricFilename.toLowerCase();
                        if (existingSet.has(ricKey)) {
                            // Aggiorna pec_email nel storico se mancante
                            if (ricEmail) {
                                fetch('https://www.sincronizzafascicolo.it/wp-content/monitor/update_pec_email.php', {
                                    method: 'POST',
                                    headers: {'Content-Type': 'application/json'},
                                    body: JSON.stringify({commissione, rgr, anno, file: ricFilename, pec_email: ricEmail})
                                }).catch(function(){});
                            }
                            continue;
                        }
                        const postBody = new URLSearchParams();
                        postBody.append('p_progDoc', ricMatch[1]);
                        postBody.append('p_annoDoc', ricMatch[2]);
                        postBody.append('p_flagProt', ricMatch[3]);
                        postBody.append('p_idRicevuta', ricMatch[4]);
                        postBody.append('p_tipologiaDocumento', ricMatch[5]);
                        postBody.append('p_tipologiaDocumentoDesc', ricMatch[6]);
                        postBody.append('p_isFileFirmato', ricMatch[7]);
                        postBody.append('p_dataDeposito', '');
                        try {
                            const emlResp = await fetch('https://sigit.finanze.it/NIRWeb/Fascicolo.do?pagina=scaricaFile', {
                                method: 'POST', credentials: 'include', body: postBody
                            });
                            if (emlResp.ok) {
                                const emlBlob = await emlResp.blob();
                                if (emlBlob.size > 100) {
                                    const formData = new FormData();
                                    formData.append('file', emlBlob, ricFilename);
                                    formData.append('commissione', commissione);
                                    formData.append('rgr', rgr);
                                    formData.append('anno', anno);
                                    formData.append('parte', rdoc.parte || 'UFFICIO');
                                    formData.append('user_id', userId);
                                    formData.append('tipologia', 'RICEVUTA PEC — ' + rdoc.tipologia);
                                    formData.append('id_ricevuta', ricId);
                                    formData.append('data_deposito', rdoc.data || '');
                                    formData.append('pec_email', ricEmail);
                                    await fetch('https://www.sincronizzafascicolo.it/wp-content/monitor/upload_doc.php', { method: 'POST', body: formData });
                                    notifyProgress('📨 Ricevuta PEC scaricata: ' + ricFilename, 'success');
                                }
                            }
                        } catch(upErr) {
                            notifyProgress('❌ PEC errore: ' + upErr.message, 'error');
                        }
                    }
                } catch(ricMainErr) {
                    console.warn('[SIGIT] getListaRicevutePec error:', ricMainErr);
                }
            }
        }

        // Notifica file P7M scaricati localmente (da caricare manualmente su Aruba)
        if (p7mDownloaded.length > 0) {
            notifyProgress('📁 ' + p7mDownloaded.length + ' file P7M scaricati nella cartella Download. Caricali dal monitor Aruba.', 'info');
        }

        if (downloads.length > 0) {
            notifyProgress('🏁 Delta-sync completato: ' + success + ' nuovi file caricati, ' + failed + ' falliti (su ' + totalBefore + ' totali)', 'done');
        }
        setElText('av-progress', '');
        if (failed === 0) {
            setElHtml('av-status', '<span style="color:#4ecca3;">✅ ' + success + ' nuovi file caricati!</span>');
        } else {
            setElHtml('av-status', '<span style="color:#ffaa00;">⚠️ ' + success + ' ok, ' + failed + ' falliti</span>');
        }

        // === SYNC_COMPLETE: segnala fine sync a upload_doc.php per notifiche centralizzate ===
        try {
            const syncCompleteForm = new FormData();
            syncCompleteForm.append('sync_complete', '1');
            syncCompleteForm.append('commissione', commissione);
            syncCompleteForm.append('rgr', rgr);
            syncCompleteForm.append('anno', anno);
            syncCompleteForm.append('user_id', String(userId));
            syncCompleteForm.append('new_files_count', String(success)); // NONOTIF-12062026: 0 = skip notifiche
            await fetch(UPLOAD_DOC_URL, { method: 'POST', body: syncCompleteForm });
            dbgFwd('sync_complete sent', {commissione, rgr, anno, userId, new_files_count: success});
            // IFRAME-RELOAD-12062026: se nuovi file scaricati, segnala all'iframe lista fascicoli di ricaricarsi
            if (success > 0) {
                try { chrome.runtime.sendMessage({ action: 'file_progress', message: '__IFRAME_RELOAD__', type: 'iframe_reload' }); } catch(_) {}
            }
        } catch(scErr) {
            dbgFwd('sync_complete error', {error: scErr.message});
        }
        // === FINE SYNC_COMPLETE ===

        dbgFwd('doDownloadAndUpload END', {success, failed, total: totalBefore, toDownload: downloads.length, sessionExpiredCount: sessionExpiredFiles.length});
        _releaseDlLock(); // [DL-LOCK-v2.3.8]
        return { sessionExpired: false, expiredFiles: sessionExpiredFiles };
    }

    function extractDocs(docTable) {
        // Wrapper retrocompatibile — chiama extractDocsWithParte
        return extractDocsWithParte(docTable, true, '');
    }

    async function scrapeFascicolo() {
        // === GUARD anti-doppio scrape (redirect 302) ===
        // Il flag viene settato QUI (non prima del setTimeout) per evitare che
        // un redirect 302 distrugga il vecchio context e il flag blocchi la nuova iniezione
        if (sessionStorage.getItem('sigit_scrape_started') === '1') {
            dbgFwd('scrapeFascicolo GUARD: già avviato — skip (redirect 302 dupe)');
            return;
        }
        sessionStorage.setItem('sigit_scrape_started', '1');

        // === NUOVO APPROCCIO: usa la vista "Fascicolo" (unificata) che mostra TUTTI i docs ===
        dbgFwd('scrapeFascicolo CALL', {url: window.location.href, bodyLen: document.body.innerText.length, clicked_dettaglio: sessionStorage.getItem('sigit_clicked_dettaglio'), clicked_fascicolo: sessionStorage.getItem('sigit_clicked_fascicolo')});

        // [MUTEX-2.3.7] Mutua esclusione via background.js
        // I tab aperti da Sync Tutti hanno sigit_sync_active='1' e sono già gestiti dal background.
        // I tab standalone (Sync Singolo) registrano il proprio avvio e vengono bloccati se un altro
        // sync è già in corso.
        if (sessionStorage.getItem('sigit_sync_active') !== '1') {
            var _syncCheck = await new Promise(function(resolve) {
                try { chrome.runtime.sendMessage({action: 'sync_single'}, resolve); } catch(e) { resolve(null); }
            });
            if (_syncCheck && _syncCheck.ok === false) {
                dbgFwd('scrapeFascicolo BLOCKED — sync già in corso', {mode: _syncCheck.mode});
                try { chrome.runtime.sendMessage({ action: 'file_progress', message: '🔒 Sync già in corso (' + (_syncCheck.mode || '?') + '), attendere completamento', type: 'warning' }); } catch(e) {}
                return;
            }
        }
        
        // Cerca la tabella documenti
        const tables = document.querySelectorAll('table');
        let docTable = null;
        for (let t of tables) {
            const headerText = t.innerText.toLowerCase();
            if (headerText.includes('tipologia') && (headerText.includes('nome file') || headerText.includes('data deposito') || headerText.includes('salva'))) {
                docTable = t;
                break;
            }
        }
        
        dbgFwd('docTable trovata?', {found: !!docTable, righe: docTable ? docTable.querySelectorAll('tr').length : 0});
        
        // Controlla se docTable è vuota (solo header, nessun dato)
        const docTableEmpty = docTable && (docTable.querySelectorAll('tr').length <= 1 || docTable.innerText.toLowerCase().includes('nessun elemento'));
        
        if (!docTable || docTableEmpty) {
            if (docTableEmpty) {
                dbgFwd('docTable VUOTA', {righe: docTable.querySelectorAll('tr').length, nessunElemento: docTable.innerText.toLowerCase().includes('nessun elemento')});
            }
            // Check immediato: se la pagina mostra un messaggio di errore SIGIT, segnala subito ERR-02
            var bodyText = document.body.innerText.toLowerCase();
            var matched_keyword = null;
            if (bodyText.includes('nessun risultato')) matched_keyword = 'nessun risultato';
            else if (bodyText.includes('fascicolo non trovato')) matched_keyword = 'fascicolo non trovato';
            else if (bodyText.includes('non è presente')) matched_keyword = 'non è presente';
            else if (bodyText.includes('nessun fascicolo')) matched_keyword = 'nessun fascicolo';
            else if (bodyText.includes('non autorizzat')) matched_keyword = 'non autorizzat';
            else if (bodyText.includes('impossibile accedere')) matched_keyword = 'impossibile accedere';
            if (matched_keyword) {
                dbgFwd('bodyText match errore', {keyword: matched_keyword});
                console.log('[SIGIT] Fascicolo non trovato/non accessibile — segnalo sync_failed');
                sessionStorage.removeItem('sigit_scrape_started');
                try { chrome.runtime.sendMessage({action: 'sync_failed', reason: 'no_table'}); } catch(e) {}
                return;
            }
            
            // Caso 1: siamo sulla pagina LISTA RISULTATI RICERCA (non nel dettaglio)
            // Cerca link alla causa nella lista risultati (tabella con RGR/Anno o link "Dettaglio")
            const allLinks = [...document.querySelectorAll('a')];
            let dettaglioLink = allLinks.find(a => {
                const href = a.href || '';
                const onclick = a.getAttribute('onclick') || '';
                return href.includes('caricaDettaglio') || href.includes('pagina=dettaglio') || onclick.includes('caricaDettaglio');
            });
            // Cerca anche in qualsiasi elemento con onclick=caricaDettaglio
            if (!dettaglioLink) {
                dettaglioLink = document.querySelector('[onclick*="caricaDettaglio"]');
            }
            // Fallback: cerca link/elemento con onclick contenente "dettaglio" o "Fascicolo.do"
            if (!dettaglioLink) {
                dettaglioLink = document.querySelector('[onclick*="dettaglio"], [onclick*="Fascicolo.do"], a[href*="dettaglio"]');
            }
            // Fallback 2: se il testo della pagina contiene "Selezionare la causa", cerca primo link nella tabella risultati
            if (!dettaglioLink && document.body.innerText.includes('Selezionare la causa')) {
                const resultTable = [...document.querySelectorAll('table')].find(t => t.querySelectorAll('tr').length > 1);
                if (resultTable) {
                    const firstDataRow = resultTable.querySelector('tr:nth-child(2) a') || resultTable.querySelector('tr:nth-child(2) [onclick]');
                    if (firstDataRow) dettaglioLink = firstDataRow;
                }
            }
            if (dettaglioLink && !sessionStorage.getItem('sigit_clicked_dettaglio')) {
                sessionStorage.setItem('sigit_clicked_dettaglio', '1');
                dbgFwd('dettaglioLink click', {tag: dettaglioLink.tagName, onclick: dettaglioLink.getAttribute('onclick')});
                console.log('[SIGIT] Pagina lista risultati — click su dettaglio:', dettaglioLink.tagName, dettaglioLink.getAttribute('onclick') || dettaglioLink.href);
                dettaglioLink.click();
                sessionStorage.removeItem('sigit_scrape_started');
                setTimeout(scrapeFascicolo, 3000);
                return;
            }
            dbgFwd('dettaglioLink', {found: !!dettaglioLink, tag: dettaglioLink ? dettaglioLink.tagName : null, onclick: dettaglioLink ? dettaglioLink.getAttribute('onclick') : null});
            
            // Caso 2: siamo nel dettaglio ma senza tabella docs — cerca link "Fascicolo" nella sidebar
            const fascicoloLink = allLinks.find(a => {
                const txt = a.textContent.trim().toLowerCase();
                return (txt === 'fascicolo' || txt.startsWith('fascicolo')) && a.href;
            });
            dbgFwd('fascicoloLink', {found: !!fascicoloLink, href: fascicoloLink ? fascicoloLink.href : null});
            if (fascicoloLink && !sessionStorage.getItem('sigit_clicked_fascicolo')) {
                sessionStorage.setItem('sigit_clicked_fascicolo', '1');
                console.log('[SIGIT] Click su Fascicolo nella sidebar...');
                fascicoloLink.click();
                sessionStorage.removeItem('sigit_scrape_started');
                setTimeout(scrapeFascicolo, 3000);
                return;
            }
            
            // FALLBACK PARTI: cerca link Ricorrente/Resistente/Ufficio/Trasversali nella sidebar
            // Scatta quando non c'è tabella (o è vuota) e non si è ancora cliccato su una parte
            if (!sessionStorage.getItem('sigit_clicked_parte')) {
                dbgFwd('PRE-FAIL sidebar links', {links: [...document.querySelectorAll('a')].slice(0,40).map(a => a.textContent.trim()).filter(t => t.length>0 && t.length<40)});
                const partiNamesPriority = ['Ricorrente', 'Resistente', 'Ufficio', 'Trasversali'];
                let parteLink = null;
                let foundParteName = null;
                for (const parteName of partiNamesPriority) {
                    const candidates = [...document.querySelectorAll('a, span[onclick], li[onclick], div[onclick]')];
                    parteLink = candidates.find(el => {
                        const txt = (el.textContent || '').trim();
                        return txt === parteName || txt.toLowerCase() === parteName.toLowerCase();
                    });
                    if (parteLink) {
                        foundParteName = parteName;
                        dbgFwd('FALLBACK trovata parte', {parteName, tag: parteLink.tagName, onclick: parteLink.getAttribute('onclick')});
                        break;
                    }
                }
                if (parteLink) {
                    sessionStorage.setItem('sigit_clicked_parte', '1');
                    // [BUG-UFFICIO-FIX-14062026] Salva il nome della parte cliccata così la chiamata
                    // ricorsiva di scrapeFascicolo può passare il valore corretto a extractDocsWithParte
                    // invece di lasciare currentParte='' che dava doc.parte='SCONOSCIUTA'.
                    sessionStorage.setItem('sigit_parte_corrente', normalizeParte(foundParteName) || foundParteName);
                    dbgFwd('FALLBACK PARTI click', {foundParteName, normalizzata: normalizeParte(foundParteName) || foundParteName});
                    parteLink.click();
                    sessionStorage.removeItem('sigit_scrape_started');
                    setTimeout(scrapeFascicolo, 3000);
                    return;
                } else {
                    dbgFwd('FALLBACK — nessuna parte trovata in sidebar', {});
                }
            }
            
            console.log('[SIGIT] Tabella documenti non trovata. URL:', window.location.href);
            // Sessione non attiva o pagina non valida — segnala fallimento
            sessionStorage.removeItem('sigit_scrape_started');
            try { chrome.runtime.sendMessage({action: 'sync_failed', reason: 'no_table'}); } catch(e) {}
            return;
        }

        // Verifica se siamo nella vista unificata (colonna "Parte Processuale")
        const hasParteCol = docTable.innerText.toLowerCase().includes('parte processuale');
        
        // Se NON siamo nella vista unificata, prova a cliccare "Fascicolo" nella sidebar
        if (!hasParteCol && !sessionStorage.getItem('sigit_clicked_fascicolo')) {
            const fascicoloLink = [...document.querySelectorAll('a')].find(a => {
                const txt = a.textContent.trim().toLowerCase();
                return (txt === 'fascicolo' || txt.startsWith('fascicolo')) && a.href;
            });
            if (fascicoloLink) {
                sessionStorage.setItem('sigit_clicked_fascicolo', '1');
                console.log('[SIGIT] Vista per-parte rilevata. Click su Fascicolo per vista unificata...');
                fascicoloLink.click();
                sessionStorage.removeItem('sigit_scrape_started');
                setTimeout(scrapeFascicolo, 3000);
                return;
            }
        }

        console.log('[SIGIT] Tabella documenti trovata! Vista: ' + (hasParteCol ? 'unificata' : 'per-parte'));
        
        // Notifica background che stiamo lavorando (estende timeout)
        try { chrome.runtime.sendMessage({action: 'sync_started'}); } catch(e) {}

        // Estrai info fascicolo dal hash URL (passato da background.js)
        let commissione = '', rgr = '', anno = '';
        
        // Priorità 1: chiedi al background.js i dati fascicolo associati a questo tab
        try {
            const bgInfo = await chrome.runtime.sendMessage({ action: 'get_sync_info' });
            if (bgInfo && bgInfo.commissione) {
                commissione = bgInfo.commissione;
                rgr = bgInfo.rgr;
                anno = bgInfo.anno;
                console.log('[SIGIT] Dati fascicolo da background:', commissione, rgr, anno);
            }
        } catch(e) {}
        
        // Priorità 2: sessionStorage (hash salvato al primo caricamento)
        if (!commissione) {
            const hashStr = sessionStorage.getItem('sigit_sync_data') || window.location.hash;
            if (hashStr && hashStr.includes('sigit_sync=')) {
                try {
                    dbgFwd('JSON parse @sessionStorage/sigit_sync_data: bodyLen=' + hashStr.length + ' bodyPreview=' + hashStr.substring(0, 100), {});
                    const syncInfo = JSON.parse(decodeURIComponent(hashStr.split('sigit_sync=')[1]));
                    commissione = syncInfo.commissione || '';
                    rgr = syncInfo.rgr || '';
                    anno = syncInfo.anno || '';
                } catch(e) { dbgFwd('JSON parse @sessionStorage/sigit_sync_data: ERRORE — ' + e.message, {}); }
            }
        }
        
        // Fallback da URL params
        const urlParams = new URLSearchParams(window.location.search);
        if (!commissione) commissione = urlParams.get('commissioneSelezionata') || '';
        if (!rgr) rgr = urlParams.get('rgrCodice') || '';
        if (!anno) anno = urlParams.get('rgrAnno') || '';
        
        // Fallback dal testo della pagina
        if (!rgr || !anno) {
            const pageText = document.body.innerText;
            const rgrMatch = pageText.match(/(?:R\.?G\.?R\.?|N\.?\s*Iscrizione|Numero)[:\s]*(\d+)\s*\/\s*(\d{4})/i);
            if (rgrMatch) { rgr = rgr || rgrMatch[1]; anno = anno || rgrMatch[2]; }
        }
        if (!commissione) {
            const commMatch = document.body.innerText.match(/(?:Commissione|Sede)[:\s]*([A-Z]\d{2})/i);
            if (commMatch) commissione = commMatch[1];
        }

        if (!commissione || !rgr || !anno) {
            console.error('[SIGIT] Impossibile identificare il fascicolo:', commissione, rgr, anno);
            return;
        }

        // Estrai TUTTI i documenti dalla tabella
        // [BUG-UFFICIO-FIX-14062026] Per la vista per-parte (hasParteCol=false), leggi la parte
        // corrente da sessionStorage impostato dal FALLBACK PARTI — prima era sempre '' che
        // causava doc.parte='SCONOSCIUTA' e quindi cartella ALTRO invece di UFFICIO/RICORRENTE/ecc.
        const currentParte = hasParteCol ? '' : (sessionStorage.getItem('sigit_parte_corrente') || '');
        let documenti = extractDocsWithParte(docTable, hasParteCol, currentParte);
        console.log('[SIGIT] Trovati ' + documenti.length + ' documenti totali' + (currentParte ? ' [parte: ' + currentParte + ']' : ''));

        // Gestione paginazione (se presente)
        let allDocs = getAllPageDocs();
        allDocs = allDocs.concat(documenti);
        
        const nextLink = checkPagination();
        if (nextLink) {
            savePageDocs(allDocs);
            console.log('[SIGIT] Pagina successiva... (accumulati: ' + allDocs.length + ' docs)');
            nextLink.click();
            sessionStorage.removeItem('sigit_scrape_started');
            setTimeout(scrapeFascicolo, 3000);
            return;
        }
        
        // Tutte le pagine completate
        clearPageDocs();
        sessionStorage.removeItem('sigit_clicked_fascicolo');
        sessionStorage.removeItem('sigit_sync_active');
        documenti = allDocs;
        console.log('[SIGIT] Totale documenti finali: ' + documenti.length);
        
        // Delta-check: confronta con doc_count dal server (passato via hash/background)
        let serverDocCount = -1;
        try {
            const bgInfo = await chrome.runtime.sendMessage({ action: 'get_sync_info' });
            if (bgInfo && typeof bgInfo.serverDocCount !== 'undefined') {
                serverDocCount = bgInfo.serverDocCount;
            }
        } catch(e) {}
        
        if (serverDocCount >= 0 && documenti.length === serverDocCount) {
            // Documento count invariato — ma i FILE potrebbero non essere ancora scaricati.
            // NON fare return: doDownloadAndUpload ha il suo delta-sync file-level via list_downloads.php
            // che confronta i file effettivamente presenti su disco.
            console.log('[SIGIT] Delta-check: doc count invariato (' + documenti.length + ' = server ' + serverDocCount + ') — procedo comunque per verificare file mancanti');
            dbgFwd('delta_check_docs_equal — proceeding to doDownloadAndUpload for file-level delta', {docsFound: documenti.length, serverDocCount});
            try { chrome.runtime.sendMessage({ action: 'file_progress', message: '📋 ' + documenti.length + ' docs invariati — verifico file mancanti...', type: 'sync' }); } catch(e) {}
        }
        
        // Ci sono documenti nuovi — procedi con sync + download
        const newDocs = serverDocCount >= 0 ? (documenti.length - serverDocCount) : documenti.length;
        if (serverDocCount >= 0 && newDocs > 0) {
            console.log('[SIGIT] Delta-check: ' + newDocs + ' nuovi documenti trovati!');
            try { chrome.runtime.sendMessage({ action: 'file_progress', message: '🆕 ' + newDocs + ' nuovi documenti trovati (totale: ' + documenti.length + ')', type: 'sync' }); } catch(e) {}
        }
        
        // Salva per doDownloadAndUpload
        sessionStorage.setItem('sigit_all_downloads', JSON.stringify(documenti));

        // Evita ri-esecuzione
        if (document.getElementById('altervista-panel')) return;
        var marker = document.createElement('div');
        marker.id = 'altervista-panel';
        marker.style.display = 'none';
        document.body.appendChild(marker);
        
        // Avvia sync + download
        // Leggi user_id dalle info fascicolo passate dal background
        var syncUserId = 0;
        try {
            const bgInfoForUserId = await chrome.runtime.sendMessage({ action: 'get_sync_info' });
            if (bgInfoForUserId && bgInfoForUserId.user_id) syncUserId = bgInfoForUserId.user_id;
        } catch(e) {}
        dbgFwd('doSync userId', {syncUserId});
        doSync(commissione, rgr, anno, syncUserId);
    }

    function showNotification(msg) {
        const div = document.createElement('div');
        div.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;background:#1a1a2e;color:#4ecca3;padding:12px 20px;border-radius:8px;font-family:monospace;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.5);border:1px solid #4ecca3;';
        div.textContent = msg;
        document.body.appendChild(div);
        setTimeout(() => div.remove(), 5000);
    }

    // === AUTO-RICERCA ===
    const hash = window.location.hash;
    if (hash && hash.startsWith('#autoRicerca=')) {
        const params = decodeURIComponent(hash.replace('#autoRicerca=', '')).split('|');
        // params: [regione, commissione, rgr, anno, sezione]
        const regione = params[0];
        const commissione = params[1];
        const rgr = params[2];
        const anno = params[3];
        const sezione = params[4] || '00';

        console.log('[SIGIT Cookie Catcher] Auto-ricerca:', { regione, commissione, rgr, anno, sezione });

        // Attendi che la pagina sia pronta
        setTimeout(function() {
            // Seleziona regione
            const selRegione = document.querySelector('select[name="regioneSelezionata"]');
            if (selRegione) {
                selRegione.value = regione;
                selRegione.dispatchEvent(new Event('change', { bubbles: true }));
            }

            // Attendi che le commissioni si carichino, poi seleziona
            setTimeout(function() {
                const selComm = document.querySelector('select[name="commissioneSelezionata"]');
                if (selComm) {
                    selComm.value = commissione;
                }

                const radioNum = document.querySelector('input[value="N"]');
                if (radioNum) radioNum.checked = true;

                const inputRgr = document.querySelector('input[name="rgrCodice"]');
                if (inputRgr) inputRgr.value = rgr;

                const inputAnno = document.querySelector('input[name="rgrAnno"]');
                if (inputAnno) inputAnno.value = anno;

                const inputSez = document.querySelector('input[name="rgrSezione"]');
                if (inputSez) inputSez.value = sezione;

                setTimeout(function() {
                    const btnCerca = document.querySelector('input[type="submit"], button[type="submit"]');
                    if (btnCerca) {
                        console.log('[SIGIT Cookie Catcher] Auto-submit ricerca...');
                        btnCerca.click();
                    } else {
                        const form = document.querySelector('form');
                        if (form) form.submit();
                    }
                }, 500);
            }, 1500);
        }, 500);
    }
})();
