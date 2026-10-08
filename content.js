/**
 * PCT Monitor - Content Script
 * Scrapa i dati del fascicolo dal DOM del PdA Toscana (app Angular).
 *
 * URL pattern (Tribunale Ordinario - SICID):
 *   https://www.giustizia.toscana.it/pda-rt/cancelleriatelematica/dettaglio-fascicolo/
 *   SICID/GLFI/{idUfficio}/{tipo}/{anno}/{numero}/{sub}/{CF_avvocato}/{ruolo}
 *
 * URL pattern (Giudice di Pace - SIGP):
 *   https://www.giustizia.toscana.it/pda-rt/cancelleriatelematica/dettaglio-fascicolo/
 *   SIGP/GLGE/{idUfficio}/{tipo}/{anno}/{numero}/{sub}/{CF_avvocato}/{ruolo}
 *
 * Differenze GdP vs Tribunale:
 *   - registro: SIGP invece di SICID
 *   - gestore: GLGE invece di GLFI
 *   - Tab GdP: 4 tab (Parti, Aggiornamenti, Atti e documenti, Scadenze)
 *     vs 6+ del Tribunale (include anche Comunicazioni e altri)
 *   - Label header GdP: "Giudice di Pace" invece di "Giudice",
 *     "Valore controversia" invece di "Valore causa"
 *
 * Struttura DOM reale verificata:
 *   - Header: <app-dettaglio-fascicolo-dati-generali> > table.tableScollable > tr > td > strong + td
 *   - Tribunale/sezione: aria-label di .card-header.card-title-huge
 *   - Tab: componenti Angular, trovati per textContent (non Bootstrap href)
 *   - Parti: due sezioni Attori/Convenuti con header arancione + tabella
 *   - Scadenze/Comunicazioni: tabella con colonne Data | Descrizione (o Tipo)
 *
 * ATTENZIONE: background.js re-inietta questo script sulle navigazioni SPA.
 * Il guard qui sotto evita doppia esecuzione nello stesso contesto.
 */

'use strict';

// ─── URL della dashboard ──────────────────────────────────────────────────────
// Il link "Apri Dashboard" deve puntare al pannello WordPress vero, ricavato
// dallo stesso indirizzo del backend (backendUrl). In produzione il backend e'
// .../wp-content/monitor/api_sync.php -> dashboard .../wp-admin/admin.php?page=pct-monitor.
// In sviluppo (localhost/pct/) resta la vecchia dashboard locale.
function pctDashboardUrl(backendUrl) {
    const b = String(backendUrl || '');
    try {
        const u = new URL(b, location.href);
        if (/\/wp-content\/monitor\//i.test(u.pathname)) {
            return u.origin + '/wp-admin/admin.php?page=pct-monitor';
        }
        return u.origin + '/pct/';
    } catch (e) {
        return 'http://localhost/pct/';
    }
}

// Aggiorna gli href dei link "Apri Dashboard" gia' presenti nel DOM.
function pctAggiornaLinkDashboard() {
    try {
        chrome.storage.local.get(['backendUrl'], (s) => {
            const url = pctDashboardUrl(s && s.backendUrl);
            document.querySelectorAll('#pct-banner-link-dashboard, .pct-link-dashboard')
                .forEach((a) => { a.href = url; });
        });
    } catch (e) { /* storage non disponibile */ }
}

// ─── Ping login PdA ─────────────────────────────────────────────────────────
// Il content script (per manifest.json) viene iniettato SOLO su pagine autenticate
// del PdA (dashboard, profile, dettaglio-fascicolo, elenco-comunicazioni, agenda,
// esportazione-agenda): il solo fatto che questo script sia in esecuzione prova
// che l'avvocato ha in quel momento una sessione PdA attiva. Segnaliamolo subito
// al backend, che userà il timestamp per decidere se mostrare l'alert
// "Accedi al PdA Toscana" in ricerca_fascicoli.php.
(function () {
    'use strict';

    function estraiCfDaPagina() {
        try {
            const params = new URLSearchParams(window.location.search);
            for (const key of ['cf', 'cf_avvocato', 'codiceFiscale', 'codice_fiscale']) {
                const v = params.get(key);
                if (v && v.length >= 11) return v.toUpperCase();
            }
            const cfRegex = /\b([A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z])\b/i;
            const allText = document.body ? document.body.innerText : '';
            const matchPage = allText.match(cfRegex);
            if (matchPage) return matchPage[1].toUpperCase();
        } catch (e) {}
        return '';
    }

    async function pingLoginPda() {
        try {
            const stored = await new Promise(resolve =>
                chrome.storage.local.get(['backendUrl', 'apiToken', 'lastCfAvvocato'], resolve)
            );
            let cf = estraiCfDaPagina();
            if (!cf && stored.lastCfAvvocato) cf = stored.lastCfAvvocato;
            console.log('[PCT] Ping login PdA: cf estratto =', cf, '(lunghezza', cf ? cf.length : 0, ')');
            if (!cf || cf.length !== 16) {
                console.warn('[PCT] Ping login PdA: CF non disponibile, ping non inviato');
                return;
            }

            const apiToken = stored.apiToken || 'pct_aruba_2026_adb200f9';
            const baseUrl = (stored.backendUrl || 'http://localhost/pct/api_sync.php')
                .replace(/\/api_sync[^/]*\.php$/, '');
            const pingUrl = baseUrl + '/api_pda_ping.php';
            console.log('[PCT] Ping login PdA: invio a', pingUrl);

            const risposta = await chrome.runtime.sendMessage({
                action:     'syncToBackend',
                backendUrl: pingUrl,
                apiToken:   apiToken,
                cfAvvocato: cf,
                data:       { codice_fiscale: cf },
            });
            console.log('[PCT] Ping login PdA: risposta backend =', JSON.stringify(risposta));
        } catch (e) {
            console.warn('[PCT] Ping login PdA fallito:', e);
        }
    }

    console.log('[PCT] Ping login PdA: script eseguito su', window.location.href);
    pingLoginPda();

    // Heartbeat: finche' la scheda PdA resta aperta, aggiorniamo periodicamente
    // pda_ultimo_accesso, cosi' una sessione valida ma inattiva non risulta
    // erroneamente "scaduta" (la finestra lato server e' di alcuni minuti).
    // Guard su window per non duplicare l'intervallo alle re-iniezioni SPA.
    if (!window.__pctPingInterval) {
        window.__pctPingInterval = setInterval(pingLoginPda, 15 * 60 * 1000);
    }
})();

(function() {
    // Guard anti-doppio-caricamento: background.js reinietta lo script sulle navigazioni SPA.
    if (window.__pctMonitorLoaded) {
        console.log('[PCT] content.js già caricato in questo contesto — salto');
        return;
    }
    window.__pctMonitorLoaded = true;

// ─── Controllo versione ─────────────────────────────────────────────────────
checkForUpdate();

function checkForUpdate() {
    const manifest = chrome.runtime.getManifest();
    const localVersion = manifest?.version || '0.0.0';

    fetch('http://localhost/pct/api_version.php', { method: 'GET', cache: 'no-store' })
        .then(response => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
        })
        .then(data => {
            const remoteVersion = data?.version;
            if (!remoteVersion || remoteVersion === localVersion) return;
            if (compareVersions(remoteVersion, localVersion) > 0) {
                showUpdateBanner(remoteVersion, data.url || '', data.message || '');
            }
        })
        .catch(err => {
            console.error('[PCT] checkForUpdate:', err);
        });
}

function compareVersions(a, b) {
    const parsePart = (part) => {
        const match = String(part).match(/^(\d+)(.*)$/);
        return match ? [parseInt(match[1], 10), match[2] || ''] : [0, String(part)];
    };

    const partsA = String(a).split('.');
    const partsB = String(b).split('.');

    const maxLen = Math.max(partsA.length, partsB.length);
    for (let i = 0; i < maxLen; i++) {
        const [numA, suffixA] = parsePart(partsA[i] || '0');
        const [numB, suffixB] = parsePart(partsB[i] || '0');

        if (numA !== numB) return numA - numB;
        if (suffixA !== suffixB) return suffixA.localeCompare(suffixB);
    }
    return 0;
}

function showUpdateBanner(version, url, message) {
    if (document.getElementById('pct-update-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'pct-update-banner';
    banner.style.cssText = [
        'position: fixed',
        'top: 0',
        'left: 0',
        'right: 0',
        'z-index: 2147483647',
        'background: linear-gradient(90deg, #fff3cd 0%, #ffeeba 100%)',
        'border-bottom: 2px solid #f0ad4e',
        'color: #856404',
        'padding: 12px 16px',
        'font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        'font-size: 14px',
        'display: flex',
        'align-items: center',
        'justify-content: center',
        'gap: 12px',
        'box-shadow: 0 2px 8px rgba(0,0,0,0.15)'
    ].join(';');

    const text = document.createElement('span');
    text.textContent = `Versione ${version} disponibile` + (message ? ` — ${message}` : '');

    if (url) {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Scarica ora';
        link.style.cssText = 'color: #856404; font-weight: 600; text-decoration: underline;';
        text.appendChild(document.createTextNode(' '));
        text.appendChild(link);
    }

    const closeBtn = document.createElement('button');
    closeBtn.setAttribute('aria-label', 'Chiudi avviso');
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cssText = [
        'background: transparent',
        'border: none',
        'color: #856404',
        'font-size: 22px',
        'line-height: 1',
        'cursor: pointer',
        'padding: 0 4px',
        'margin-left: 8px'
    ].join(';');
    closeBtn.addEventListener('click', () => banner.remove());

    banner.appendChild(text);
    banner.appendChild(closeBtn);

    document.body.appendChild(banner);
}

// ─── Listener messaggi dal popup / background ─────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'getPreview') {
        sendResponse(getPreview());
        return true;
    }
    if (message.action === 'scrape') {
        scrapeAll()
            .then(data => sendResponse(data))
            .catch(err => sendResponse({ error: err.message }));
        return true; // risposta asincrona
    }
});

// ─── Preview rapida (per il popup) ───────────────────────────────────────────
function getPreview() {
    const urlInfo = parseUrlParams();
    return {
        numero:  urlInfo.anno_ruolo && urlInfo.numero_ruolo
                    ? formatNumeroFascicolo(urlInfo)
                    : '',
        oggetto: getFieldValue('Oggetto'),
    };
}

// ─── Scraping principale ──────────────────────────────────────────────────────
async function scrapeAll() {
    const urlInfo = parseUrlParams();

    // Dati header fascicolo
    const fascicolo = {
        ...urlInfo,
        ...scrapeHeader(),
    };

    // Naviga i tab in sequenza (il sito Angular è lento, 1000ms di attesa)
    console.log('[PCT] scrapeAll: inizio navigazione tab');
    const parti          = await scrapeTab('Parti',              scrapePart);
    console.log('[PCT] scrapeAll: parti =', parti.length);
    const aggiornamenti  = await scrapeTab('Aggiornamenti',      scrapeAggiornamenti);
    console.log('[PCT] scrapeAll: aggiornamenti =', aggiornamenti.length);
    const atti           = await scrapeTab('Atti e documenti',   scrapeAtti);
    console.log('[PCT] scrapeAll: atti =', atti.length, atti.length > 0 ? 'primo: ' + atti[0].nome_file : '(nessuno)');
    const scadenze       = await scrapeTab('Scadenze',           scrapeScadenze);
    // Il tab Comunicazioni non viene più cliccato durante la sync di un
    // fascicolo: su SICID apre la pagina elenco-comunicazioni e interrompe
    // il flusso. Le comunicazioni restano sincronizzabili dalla pagina
    // dedicata tramite il banner apposito.
    const comunicazioni  = [];

    return {
        ...fascicolo,
        parti,
        aggiornamenti,
        atti,
        scadenze,
        comunicazioni,
        _parti_diagnostics: (parti && parti._diagnostics) ? parti._diagnostics : [],
    };
}

// ─── Parsing URL ─────────────────────────────────────────────────────────────
/**
 * Estrae i parametri dall'URL del fascicolo.
 *
 * SICID (Tribunale Ordinario) — ha il segmento {tipo} (es. CC, DL, VG…):
 *   /dettaglio-fascicolo/SICID/{gestore}/{idUfficio}/{tipo}/{anno}/{numero}/{sub}/{CF}/{ruolo}
 *
 * SIGP (Giudice di Pace) — NON ha il segmento {tipo}:
 *   /dettaglio-fascicolo/SIGP/{gestore}/{idUfficio}/{anno}/{numero}/{sub}/{CF}/{ruolo}
 *
 * La distinzione si fa guardando il segmento subito dopo {idUfficio}:
 *   - se è composto solo da cifre (4 cifre = anno) → SIGP, nessun tipo
 *   - altrimenti (lettere come CC, DL…) → SICID, presente il tipo
 */
function parseUrlParams() {
    const url = window.location.pathname;

    // Prova prima SICID: dopo idUfficio c'è un segmento NON numerico (tipo), poi anno numerico
    const matchSICID = url.match(
        /dettaglio-fascicolo\/([^/]+)\/([^/]+)\/([^/]+)\/([A-Za-z][^/]*)\/(\d{4})\/([^/]+)\/([^/]+)\/([^/]+)(?:\/([^/]+))?/
    );
    // Prova SIGP: dopo idUfficio c'è direttamente l'anno (4 cifre)
    const matchSIGP = url.match(
        /dettaglio-fascicolo\/([^/]+)\/([^/]+)\/([^/]+)\/(\d{4})\/([^/]+)\/([^/]+)\/([^/]+)(?:\/([^/]+))?/
    );

    if (matchSICID) {
        const area    = (matchSICID[1] || '').toUpperCase();
        const settimo = matchSICID[7] || '0';
        // In SIECIC (esecuzioni e procedure concorsuali) il settimo pezzo non e'
        // il sub-procedimento ma l'identificativo interno del fascicolo (idDfa):
        // usarlo come sub creava un doppione in archivio e mostrava un numero di
        // ruolo inesistente tipo "2024/76/51217".
        const eSiecic = area === 'SIECIC';
        return {
            registro:         matchSICID[1] || '',
            gestore:          matchSICID[2] || '',
            id_ufficio:       matchSICID[3] || '',
            tipo_ruolo:       matchSICID[4] || '',
            anno_ruolo:       matchSICID[5] || '',
            numero_ruolo:     matchSICID[6] || '',
            sub_procedimento: eSiecic ? '0' : settimo,
            id_dfa:           eSiecic ? settimo : '',
            cf_avvocato:      matchSICID[8] || '',
        };
    }

    if (matchSIGP) {
        return {
            registro:         matchSIGP[1] || '',
            gestore:          matchSIGP[2] || '',
            id_ufficio:       matchSIGP[3] || '',
            tipo_ruolo:       '',                   // SIGP non ha tipo
            anno_ruolo:       matchSIGP[4] || '',
            numero_ruolo:     matchSIGP[5] || '',
            sub_procedimento: matchSIGP[6] || '0',
            cf_avvocato:      matchSIGP[7] || '',
        };
    }

    return {};
}

/**
 * Restituisce true se la pagina corrente è un fascicolo del Giudice di Pace (SIGP).
 * Usato per adattare label e comportamento dove necessario.
 */
function isGdP() {
    return window.location.pathname.includes('/SIGP/');
}

/**
 * Formatta il numero fascicolo per la visualizzazione nel banner.
 * Formato: "anno/numero" oppure "anno/numero/sub" se sub != '0'.
 * Esempi: "2026/11022" oppure "2026/11022/1"
 */
function formatNumeroFascicolo(urlInfo) {
    const base = `${urlInfo.anno_ruolo}/${urlInfo.numero_ruolo}`;
    const sub  = urlInfo.sub_procedimento;
    return (sub && sub !== '0') ? `${base}/${sub}` : base;
}

// ─── Header fascicolo ─────────────────────────────────────────────────────────
/**
 * Estrae i dati dall'intestazione della pagina del fascicolo.
 *
 * Struttura reale:
 *   <app-dettaglio-fascicolo-dati-generali>
 *     <table class="table tableScollable">
 *       <tr><td><strong>Giudice:</strong></td><td>Mario Rossi</td></tr>
 *       ...
 *     </table>
 *   </app-dettaglio-fascicolo-dati-generali>
 *
 * Tribunale/sezione:
 *   <div class="card-header card-title-huge" aria-label="Tribunale Ordinario - Massa (MS) - Area Lavoro - Sezione Lavoro">
 */
function scrapeHeader() {
    const data = {};

    data.fascicolo          = getFieldValue('Fascicolo');
    data.ruolo              = getFieldValue('Ruolo');
    data.materia            = getFieldValue('Materia');
    data.rito_principale    = getFieldValue('Rito principale');
    data.stato              = getFieldValue('Stato');
    data.oggetto            = getFieldValue('Oggetto');
    // "Giudice di Pace" (SIGP) oppure "Giudice" (SICID)
    data.giudice            = getFieldValue('Giudice di Pace') || getFieldValue('Giudice');
    // "Valore controversia" (SIGP) oppure "Valore causa" (SICID)
    data.valore_causa       = getFieldValue('Valore controversia') || getFieldValue('Valore causa');
    data.contributo_unificato = getFieldValue('Contributo unificato');
    data.data_iscrizione    = getFieldValue('Data iscrizione');
    // SICID: "Data ultima udienza" / SIGP: potrebbe essere "Ultima udienza"
    data.data_ultima_udienza   = getFieldValue('Data ultima udienza')
                              || getFieldValue('Ultima udienza');
    // SICID: "Data prossima udienza" / SIGP: potrebbe essere "Prossima udienza"
    data.data_prossima_udienza = getFieldValue('Data prossima udienza')
                              || getFieldValue('Prossima udienza');

    // Tribunale e sezione dall'aria-label del card-header
    const cardHeader = document.querySelector('.card-header.card-title-huge, .card-header[aria-label]');
    if (cardHeader) {
        const ariaLabel = cardHeader.getAttribute('aria-label') || '';
        data.tribunale_sezione = ariaLabel.trim();

        // Prova a estrarre le parti: "Tribunale X - Città (XX) - Area Y - Sezione Z"
        const parts = ariaLabel.split('-').map(s => s.trim());
        data.tribunale = parts[0] || '';
        data.sezione   = parts[parts.length - 1] || '';
    }

    return data;
}

// ─── Tab: Parti ───────────────────────────────────────────────────────────────
/**
 * Scrapa le parti dal tab Parti.
 *
 * Struttura reale:
 *   Due sezioni separate con header arancione "Attori" e "Convenuti".
 *   Ogni sezione ha una tabella con colonne:
 *     0: Nome parte  1: CF/P.IVA  2: Avvocato  3: CF Avvocato  4: Tipo
 *
 *   Tipo: AP = Attori, CP = Convenuti
 */
// Polling: aspetta che Angular renderizzi le tabelle nel tab Parti E popoli le celle.
// Controlla ogni 500ms per max 15 secondi.
// NOTA: non basta aspettare che la <table> esista — Angular spesso crea la struttura
// vuota e poi riempie i dati via binding in un secondo momento. Aspettiamo che almeno
// una tabella abbia celle con contenuto testuale non vuoto.
async function waitForTablesInRoot(searchRoot, maxWaitMs = 15000) {
    const interval = 500;
    let waited = 0;
    while (waited < maxWaitMs) {
        const tables = Array.from(searchRoot.querySelectorAll('table')).filter(
            t => !t.closest('app-dettaglio-fascicolo-dati-generali')
        );
        // Filtra solo le tabelle che hanno almeno una td con testo non vuoto
        const tablesWithContent = tables.filter(t => {
            const tds = t.querySelectorAll('td');
            for (const td of tds) {
                if ((td.textContent || '').trim().length > 0) return true;
            }
            return false;
        });
        if (tablesWithContent.length > 0) {
            console.log('[PCT] waitForTables: trovate', tablesWithContent.length,
                'tabelle con contenuto dopo', waited, 'ms');
            return tablesWithContent;
        }
        await new Promise(r => setTimeout(r, interval));
        waited += interval;
    }
    console.log('[PCT] waitForTables: timeout dopo', maxWaitMs, 'ms, 0 tabelle con contenuto');
    // Dump dell'innerHTML per diagnostica: mostra la struttura reale del searchRoot al timeout
    if (searchRoot !== document) {
        const htmlSnap = searchRoot.innerHTML.replace(/\s+/g, ' ').substring(0, 400);
        console.log('[PCT] waitForTables: searchRoot.innerHTML al timeout:', htmlSnap);
    }
    return [];
}

// Configurazione per il download incrementale: impostata da handleSyncClick
// prima di chiamare scrapeAtti(), così da poter fare il pre-check dentro scrapeAtti
// (quando i pulsanti sono già stati trovati ma non ancora cliccati).
let _downloadPreCheckConfig = null;

// Stub degli atti enumerati nella FASE 1.5 (pre-sync DB senza download).
// Ogni stub contiene i metadati + riferimenti DOM (btn, fileItem, folderSpan)
// per evitare di rieseguire l'espansione DOM nella FASE 2.
// Formato: Array di oggetti { btn, fileName, fileItem, folderSpan?, data_atto, ... }
// null = non ancora eseguita la FASE 1.5.
let _enumeratedButtons = null;

// Riferimenti d'archivio (high-water mark) per la lettura INCREMENTALE dei tab
// paginati. Impostati in handleSyncClick prima dello scraping interrogando
// api_hwm.php: { aggiornamenti: 'YYYY-MM-DD HH:MM:SS'|null, scadenze: 'YYYY-MM-DD'|null }.
// null = leggi tutto (fascicolo non in archivio, cancellato, o riferimento assente).
let _riferimentiArchivio = null;

// Converte una data italiana "dd/mm/yyyy" o "dd/mm/yyyy HH:mm" in un numero
// ordinabile (yyyymmddHHMM). Torna null se non riconosciuta.
function _dataItaOrdinabile(s) {
    if (!s) return null;
    const m = String(s).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
    if (!m) return null;
    return Number(m[3] + m[2] + m[1] + (m[4] || '00') + (m[5] || '00'));
}
// Converte un riferimento ISO "yyyy-mm-dd HH:MM:SS" (o "yyyy-mm-dd") nello
// stesso numero ordinabile, per confrontarlo con le righe scrapate.
function _isoOrdinabile(s) {
    if (!s) return null;
    const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
    if (!m) return null;
    return Number(m[1] + m[2] + m[3] + (m[4] || '00') + (m[5] || '00'));
}

// ─── Interruzione sincronizzazione ───────────────────────────────────────────
// Flag globale impostato dal pulsante "Ferma sincronizzazione" del banner.
// Vive a livello di modulo (e non dentro initBanner) così anche le funzioni di
// scraping/download possono controllarlo e fermarsi immediatamente, invece di
// arrivare fino alla fine della fase in corso.
let _syncAborted = false;

function pctSetSyncAborted(value) {
    _syncAborted = !!value;
}
function pctIsSyncAborted() {
    return _syncAborted;
}
/** Lancia __SYNC_ABORTED__ se l'utente ha premuto "Ferma sincronizzazione" */
function pctThrowIfAborted() {
    if (_syncAborted) throw new Error('__SYNC_ABORTED__');
}
/** Come wait(), ma controlla il flag di abort ogni 150ms e interrompe l'attesa */
async function waitAbortable(ms) {
    const STEP = 150;
    let waited = 0;
    while (waited < ms) {
        pctThrowIfAborted();
        const slice = Math.min(STEP, ms - waited);
        await new Promise(r => setTimeout(r, slice));
        waited += slice;
    }
    pctThrowIfAborted();
}

/**
 * Chiede al backend quali file (tra quelli indicati) sono già presenti
 * nel DB e sul filesystem, così da non riscaricarli dal PdA.
 *
 * items: array di { nome_file, data_atto }.
 * Il nome da solo NON basta: sul PdA lo stesso nome si ripete in depositi
 * diversi (DatiAtto.xml.p7m, "Atto principale.pdf.p7m", ricevute...), quindi
 * il confronto avviene su nome + data ed è a consumo lato server.
 *
 * Usa _downloadPreCheckConfig (impostato da handleSyncClick prima della FASE 2).
 * Restituisce un Set con gli INDICI degli item già scaricati; Set vuoto se il
 * pre-check non è configurato o fallisce (in tal caso si scarica tutto).
 */
async function pctPreCheckDownloaded(items) {
    const cfg = _downloadPreCheckConfig;
    if (!cfg || !items || items.length === 0) return new Set();

    const files = items.map(it => (typeof it === 'string'
        ? { nome_file: it, data_atto: '' }
        : { nome_file: it.nome_file || '', data_atto: it.data_atto || '' }
    ));

    try {
        const { fascicoloId, apiToken, cfAvvocato, checkUrl } = cfg;
        const checkResp = await chrome.runtime.sendMessage({
            action:     'syncToBackend',
            backendUrl: checkUrl,
            apiToken,
            cfAvvocato,
            data: { fascicolo_id: fascicoloId, files: files },
        });
        if (!checkResp || checkResp.error) {
            console.warn('[PCT] Pre-check fallito (scarico tutto):', checkResp && checkResp.error);
            return new Set();
        }
        const idx = (checkResp.result && checkResp.result.downloaded_idx) || [];
        return new Set(idx);
    } catch (e) {
        console.warn('[PCT] Pre-check fallito (scarico tutto):', e.message);
        return new Set();
    }
}

const PARTE_LABEL_TO_TIPO = {
    'attore': 'AP', 'attori': 'AP', 'ricorrente': 'AP', 'ricorrenti': 'AP',
    'convenuto': 'CP', 'convenuti': 'CP', 'resistente': 'CP', 'resistenti': 'CP',
    'terzo': 'TP', 'terzi': 'TP', 'intervenuto': 'TP', 'controinteressato': 'TP',
};
// Questi label indicano l'inizio di un nuovo record-parte (uno per ogni soggetto)
const IS_PARTE_LABEL = /^(attore|attori|ricorrente|ricorrenti|convenuto|convenuti|resistente|resistenti|terzo|terzi|intervenuto|controinteressato)$/i;

// ─── Tab: Parti SIGP (Giudice di Pace) ───────────────────────────────────────
/**
 * Scrapa le parti dal tab Parti per le pagine SIGP (Giudice di Pace).
 *
 * Il DOM SIGP usa Angular con componenti custom. La struttura osservata è:
 *   - ngx-datatable con datatable-body-row (stessa struttura SICID ma layout diverso)
 *   - Oppure tabelle HTML standard <table> con colonne: Tipo | Cognome/Denominazione | Nome | CF | Avvocato
 *   - Oppure elementi Angular con attributi data-* o title con il CF
 *
 * Colonne attese (SIGP):
 *   0: Tipo (Attore/Ricorrente/Convenuto/Resistente) — testo o codice
 *   1: Cognome / Denominazione
 *   2: Nome (vuoto per enti)
 *   3: CF Parte
 *   4: Avvocato (nome)
 *   5: CF Avvocato (opzionale)
 *
 * Strategia multi-livello (best-effort):
 *   1. ngx-datatable (datatable-body-row) — stessa struttura SICID
 *   2. Tabella HTML standard con header che contiene "tipo"/"cognome"/"cf"
 *   3. Ricerca nel DOM Angular: data-* attributes, title, tooltip
 *   4. Fallback: estrae quello che c'è (tipo, cognome, nome) senza CF
 *
 * NOTA: se il CF non è nel DOM, viene restituito '' — sarà completato
 * successivamente dal DatiAtto.xml estratto dal P7M (api_upload_doc.php).
 */
async function scrapePartSIGP() {
    const parti = [];
    const diag  = ['sigp_start'];

    // Mappa label testuale → codice tipo processuale
    const SECTION_TIPO = {
        'attori': 'AP', 'attore': 'AP', 'ricorrenti': 'AP', 'ricorrente': 'AP',
        'convenuti': 'CP', 'convenuto': 'CP', 'resistenti': 'CP', 'resistente': 'CP',
        'terzi': 'TP', 'terzo': 'TP', 'intervenuti': 'TP', 'intervenuto': 'TP',
        'controinteressati': 'TP', 'controinteressato': 'TP',
    };

    // Helper: testo visibile escludendo elementi screen-reader-only
    const getVis = (el) => {
        if (!el) return '';
        const clone = el.cloneNode(true);
        clone.querySelectorAll(
            '.screen-reader-only, .sr-only, .visually-hidden, ' +
            '[class*="screen-reader"], [class*="screenreader"], [class*="sr-only"]'
        ).forEach(s => s.remove());
        return clone.textContent.replace(/\s+/g, ' ').trim();
    };

    // Helper: estrae righe di testo da una cella (per avvocati multipli)
    const getCellDivLines = (cell) => {
        if (!cell) return [];
        const childDivs = Array.from(cell.querySelectorAll(':scope > div, :scope > span'));
        if (childDivs.length > 0) {
            const lines = childDivs.map(d => getVis(d)).filter(Boolean);
            if (lines.length > 0) return lines;
        }
        const txt = getVis(cell);
        return txt ? [txt] : [];
    };

    // Helper: normalizza il tipo da testo colonna SIGP
    const normalizeTipoSIGP = (txt) => {
        const t = (txt || '').trim().toLowerCase();
        if (/^(ap|attore|attori|ricorrente|ricorrenti)$/.test(t)) return 'AP';
        if (/^(cp|convenuto|convenuti|resistente|resistenti)$/.test(t)) return 'CP';
        if (/^(tp|terzo|terzi|intervenuto|intervenuti|controinteressato)$/.test(t)) return 'TP';
        return null;
    };

    // ── Strategia 1: ngx-datatable (datatable-body-row) ──────────────────────
    // SIGP potrebbe usare la stessa struttura ngx-datatable di SICID.
    // Polling fino a 15s per attendere il rendering Angular.
    console.log('[PCT] scrapePartSIGP: strategia 1 — ngx-datatable polling...');
    let bodyRows = [];
    const maxWaitNgx = 15000;
    const stepNgx    = 500;
    let waitedNgx    = 0;
    while (waitedNgx < maxWaitNgx) {
        bodyRows = Array.from(document.querySelectorAll('datatable-body-row'));
        if (bodyRows.length > 0) {
            console.log('[PCT] scrapePartSIGP: trovati', bodyRows.length, 'datatable-body-row dopo', waitedNgx, 'ms');
            diag.push('ngx_rows=' + bodyRows.length + '_ms=' + waitedNgx);
            break;
        }
        await new Promise(r => setTimeout(r, stepNgx));
        waitedNgx += stepNgx;
    }

    if (bodyRows.length > 0) {
        // Cerca card-header con label sezione (Attori/Convenuti/ecc.)
        const sectionCards = [];
        const headerCandidates = Array.from(document.querySelectorAll(
            '.card-header .font-weight-bold, .card-header strong, ' +
            '.card-header span, .card-header h5, .card-header h6'
        ));
        for (const hdr of headerCandidates) {
            const txt = (hdr.textContent || '').trim().toLowerCase();
            if (!txt || txt.length > 40) continue;
            const tipo = SECTION_TIPO[txt];
            if (!tipo) continue;
            const card = hdr.closest('.card');
            if (!card) continue;
            if (sectionCards.some(s => s.card === card)) continue;
            sectionCards.push({ tipo, card, label: txt });
            diag.push('sigp_ngx_sezione=' + txt + '_tipo=' + tipo);
        }

        // Fallback: cerca qualsiasi elemento con testo esatto sezione
        if (sectionCards.length === 0) {
            document.querySelectorAll('*').forEach(el => {
                const t = (el.textContent || '').trim();
                if (t.length === 0 || t.length > 40) return;
                const tipo = SECTION_TIPO[t.toLowerCase()];
                if (!tipo) return;
                const children = Array.from(el.children).filter(c => (c.textContent || '').trim() === t);
                if (children.length > 0) return;
                const card = el.closest('.card') || el.parentElement;
                if (!card) return;
                if (sectionCards.some(s => s.card === card)) return;
                sectionCards.push({ tipo, card, label: t.toLowerCase() });
                diag.push('sigp_ngx_sezione_fallback=' + t + '_tipo=' + tipo);
            });
        }

        console.log('[PCT] scrapePartSIGP: ngx-datatable →', sectionCards.length, 'sezioni trovate');
        diag.push('sigp_ngx_sections=' + sectionCards.length);

        for (const section of sectionCards) {
            const { tipo: tipoSezione, card, label: sectionLabel } = section;
            const datatableBody = card.querySelector('datatable-body');
            if (!datatableBody) {
                diag.push('sigp_ngx_' + sectionLabel + '_no_datatable_body');
                continue;
            }
            const sectionRows = Array.from(datatableBody.querySelectorAll('datatable-body-row'));
            diag.push('sigp_ngx_' + sectionLabel + '_rows=' + sectionRows.length);

            for (let rIdx = 0; rIdx < sectionRows.length; rIdx++) {
                const row = sectionRows[rIdx];
                const rowCenter = row.querySelector('div.datatable-row-center') || row;
                const cells = Array.from(rowCenter.querySelectorAll('datatable-body-cell'));
                if (cells.length === 0) continue;

                // Layout SIGP ngx-datatable (rilevato empiricamente):
                // Prova layout A (come SICID): 0=nome, 1=CF, 2=avvocato, 3=CF_avv, 4=tipo
                // Prova layout B (SIGP specifico): 0=tipo, 1=cognome, 2=nome, 3=CF, 4=avvocato, 5=CF_avv
                // Determina il layout dalla prima cella: se contiene un tipo noto → layout B
                const cell0txt = getVis(cells[0]);
                const tipoFromCell0 = normalizeTipoSIGP(cell0txt);

                let nomeCompleto, cfParte, nomiAvv, cfAvv, tipoFinal;

                if (tipoFromCell0 && cells.length >= 3) {
                    // Layout B: tipo | cognome | nome | CF | avvocato | CF_avv
                    tipoFinal    = tipoFromCell0;
                    const cognome = getVis(cells[1]);
                    const nome    = cells[2] ? getVis(cells[2]) : '';
                    nomeCompleto  = (cognome + (nome ? ' ' + nome : '')).trim();
                    cfParte       = cells[3] ? getVis(cells[3]) : '';
                    nomiAvv       = cells[4] ? getCellDivLines(cells[4]) : [];
                    cfAvv         = cells[5] ? getCellDivLines(cells[5]) : [];
                } else {
                    // Layout A: nome | CF | avvocato | CF_avv | tipo
                    nomeCompleto = cell0txt;
                    cfParte      = cells[1] ? getVis(cells[1]) : '';
                    nomiAvv      = cells[2] ? getCellDivLines(cells[2]) : [];
                    cfAvv        = cells[3] ? getCellDivLines(cells[3]) : [];
                    tipoFinal    = tipoSezione;
                }

                if (!nomeCompleto) continue;

                // Cerca CF in data-* o title se non trovato nel testo
                if (!cfParte) {
                    for (const cell of cells) {
                        const dataCf = cell.getAttribute('data-cf') ||
                                       cell.getAttribute('data-codice-fiscale') ||
                                       cell.getAttribute('title') || '';
                        if (/^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/i.test(dataCf.trim()) ||
                            /^\d{11}$/.test(dataCf.trim())) {
                            cfParte = dataCf.trim().toUpperCase();
                            diag.push('sigp_ngx_cf_da_attr=' + cfParte);
                            break;
                        }
                    }
                }

                const avvocati = [];
                const nAvv = Math.max(nomiAvv.length, cfAvv.length);
                for (let k = 0; k < nAvv; k++) {
                    const nomeA = (nomiAvv[k] || '').replace(/^Avvocat[oi]:\s*/i, '').trim();
                    const cfA   = (cfAvv[k]   || '').replace(/^Codice\s+Fiscale(\s+Avvocat[oi])?\s*:?\s*/i, '').trim();
                    if (nomeA || cfA) avvocati.push({ nome_avvocato: nomeA, cf_avvocato: cfA });
                }

                const cn = splitCognomeNome(nomeCompleto);
                console.log('[PCT] scrapePartSIGP (ngx):', nomeCompleto, '| tipo:', tipoFinal, '| cf:', cfParte, '| avv:', avvocati.length);
                diag.push('sigp_ngx_parte=' + nomeCompleto + ' tipo=' + tipoFinal + ' cf=' + (cfParte || 'N/A'));

                parti.push({
                    tipo:         tipoFinal,
                    cognome:      cn.cognome,
                    nome:         cn.nome,
                    cf_parte:     cfParte,
                    tipo_raw:     sectionLabel,
                    data_nascita: null,
                    avvocati:     avvocati,
                });
            }
        }

        if (parti.length > 0 || sectionCards.length > 0) {
            console.log('[PCT] scrapePartSIGP: ngx-datatable → trovate', parti.length, 'parti');
            diag.push('sigp_ngx_risultato=' + parti.length);
            parti._diagnostics = diag;
            return parti;
        }
        diag.push('sigp_ngx_no_parti_trovate');
    } else {
        console.log('[PCT] scrapePartSIGP: timeout ngx-datatable, provo tabelle HTML...');
        diag.push('sigp_ngx_timeout');
    }

    // ── Strategia 2: tabella HTML standard ───────────────────────────────────
    // SIGP potrebbe usare <table> con colonne: Tipo | Cognome | Nome | CF | Avvocato | CF Avv
    console.log('[PCT] scrapePartSIGP: strategia 2 — tabelle HTML...');

    // Polling per tabelle con contenuto
    let tables = await waitForTablesInRoot(document, 5000);
    // Filtra escludendo la tabella header fascicolo
    tables = tables.filter(t => !t.closest('app-dettaglio-fascicolo-dati-generali'));
    diag.push('sigp_tabelle=' + tables.length);

    // Cerca tabelle con header che contiene parole chiave parti
    const partiTables = tables.filter(t => {
        const headerCells = Array.from(t.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td'));
        const hText = headerCells.map(h => h.textContent.trim().toLowerCase()).join(' ');
        return /attore|attori|codice\s*fiscale|avvocat|convenuto|convenuti|parte|ricorrente|resistente|cognome|tipo/i.test(hText);
    });
    diag.push('sigp_tabelle_parti=' + partiTables.length);

    for (const table of partiTables) {
        // Determina il layout delle colonne dall'header
        const headerRow = table.querySelector('thead tr, tr:first-child');
        const headerCells = headerRow
            ? Array.from(headerRow.querySelectorAll('th, td')).map(c => c.textContent.trim().toLowerCase())
            : [];

        // Mappa colonne per nome
        const colIdx = {
            tipo:      headerCells.findIndex(h => /^tipo$/.test(h)),
            cognome:   headerCells.findIndex(h => /cognome|denominazione/.test(h)),
            nome:      headerCells.findIndex(h => /^nome$/.test(h)),
            cf:        headerCells.findIndex(h => /codice\s*fiscale|^cf$/.test(h) && !/avvocat/.test(h)),
            avvocato:  headerCells.findIndex(h => /avvocat/.test(h) && !/cf/.test(h)),
            cf_avv:    headerCells.findIndex(h => /avvocat/.test(h) && /cf|codice/.test(h)),
        };
        diag.push('sigp_table_cols=' + JSON.stringify(colIdx));
        console.log('[PCT] scrapePartSIGP: tabella HTML colonne:', colIdx);

        // Determina tipo sezione dall'header precedente nel DOM
        let tipoSezioneDefault = null;
        let el = table;
        for (let depth = 0; depth < 7 && !tipoSezioneDefault; depth++) {
            let prev = el.previousElementSibling;
            for (let i = 0; i < 8 && prev; i++) {
                const txt = (prev.textContent || '').trim().toLowerCase();
                if (txt.length < 100) {
                    if (/\battori\b|\battore\b|\bricorrente/i.test(txt)) { tipoSezioneDefault = 'AP'; break; }
                    if (/\bconvenut|\bresistente/i.test(txt)) { tipoSezioneDefault = 'CP'; break; }
                }
                prev = prev.previousElementSibling;
            }
            if (!el.parentElement) break;
            el = el.parentElement;
        }

        // Processa righe dati (salta header)
        const allRows = Array.from(table.querySelectorAll('tr'));
        const dataRows = allRows.filter(row => {
            const tds = row.querySelectorAll('td');
            const ths = row.querySelectorAll('th');
            if (ths.length > 0 && tds.length === 0) return false;
            if (tds.length < 2) return false;
            return true;
        });

        for (const row of dataRows) {
            const cells = Array.from(row.querySelectorAll('td'));
            if (cells.length < 2) continue;

            let tipoFinal, cognome, nome, cfParte, nomiAvv, cfAvv;

            if (colIdx.tipo >= 0 && colIdx.cognome >= 0) {
                // Layout con colonne nominate
                const tipoTxt = cells[colIdx.tipo] ? getVis(cells[colIdx.tipo]) : '';
                tipoFinal = normalizeTipoSIGP(tipoTxt) || tipoSezioneDefault || 'CP';
                cognome   = cells[colIdx.cognome] ? getVis(cells[colIdx.cognome]) : '';
                nome      = colIdx.nome >= 0 && cells[colIdx.nome] ? getVis(cells[colIdx.nome]) : '';
                cfParte   = colIdx.cf >= 0 && cells[colIdx.cf] ? getVis(cells[colIdx.cf]) : '';
                nomiAvv   = colIdx.avvocato >= 0 && cells[colIdx.avvocato] ? getCellLines(cells[colIdx.avvocato]) : [];
                cfAvv     = colIdx.cf_avv >= 0 && cells[colIdx.cf_avv] ? getCellLines(cells[colIdx.cf_avv]) : [];
            } else {
                // Layout posizionale fallback: 0=nome, 1=CF, 2=avvocato, 3=CF_avv, 4=tipo
                const nomeCompleto = getVis(cells[0]);
                if (!nomeCompleto) continue;
                if (/^\d+\s+risultat/i.test(nomeCompleto)) continue;
                const cn = splitCognomeNome(nomeCompleto);
                cognome   = cn.cognome;
                nome      = cn.nome;
                cfParte   = cells[1] ? getVis(cells[1]) : '';
                nomiAvv   = cells[2] ? getCellLines(cells[2]) : [];
                cfAvv     = cells[3] ? getCellLines(cells[3]) : [];
                const tipoTxt = cells[4] ? getVis(cells[4]) : '';
                tipoFinal = normalizeTipoSIGP(tipoTxt) || tipoSezioneDefault || 'CP';
            }

            const nomeCompleto = (cognome + (nome ? ' ' + nome : '')).trim();
            if (!nomeCompleto) continue;
            if (/^\d+\s+risultat/i.test(nomeCompleto)) continue;

            // Cerca CF in data-* o title se non trovato nel testo
            if (!cfParte) {
                for (const cell of cells) {
                    const dataCf = cell.getAttribute('data-cf') ||
                                   cell.getAttribute('data-codice-fiscale') ||
                                   cell.getAttribute('title') || '';
                    if (/^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/i.test(dataCf.trim()) ||
                        /^\d{11}$/.test(dataCf.trim())) {
                        cfParte = dataCf.trim().toUpperCase();
                        diag.push('sigp_table_cf_da_attr=' + cfParte);
                        break;
                    }
                }
            }

            const avvocati = [];
            for (let k = 0; k < Math.max(nomiAvv.length, cfAvv.length); k++) {
                const nomeA = (nomiAvv[k] || '').replace(/^Avvocat[oi]:\s*/i, '').trim();
                const cfA   = (cfAvv[k]   || '').replace(/^Codice\s+Fiscale(\s+Avvocat[oi])?\s*:?\s*/i, '').trim();
                if (nomeA || cfA) avvocati.push({ nome_avvocato: nomeA, cf_avvocato: cfA });
            }

            console.log('[PCT] scrapePartSIGP (table):', nomeCompleto, '| tipo:', tipoFinal, '| cf:', cfParte, '| avv:', avvocati.length);
            diag.push('sigp_table_parte=' + nomeCompleto + ' tipo=' + tipoFinal + ' cf=' + (cfParte || 'N/A'));

            parti.push({
                tipo:         tipoFinal,
                cognome:      cognome,
                nome:         nome,
                cf_parte:     cfParte,
                tipo_raw:     tipoFinal,
                data_nascita: null,
                avvocati:     avvocati,
            });
        }
    }

    if (parti.length > 0) {
        console.log('[PCT] scrapePartSIGP: tabelle HTML → trovate', parti.length, 'parti');
        diag.push('sigp_table_risultato=' + parti.length);
        parti._diagnostics = diag;
        return parti;
    }
    diag.push('sigp_table_no_parti');

    // ── Strategia 3: Angular component state / attributi DOM ─────────────────
    // Cerca elementi con attributi data-cf, data-codice-fiscale, o title con CF
    // in qualsiasi elemento del tab Parti (app-dettaglio-fascicolo-parti o simili)
    console.log('[PCT] scrapePartSIGP: strategia 3 — Angular state / data-attributes...');
    const partiComponent = document.querySelector(
        'app-dettaglio-fascicolo-parti, app-parti, [class*="parti"], [id*="parti"]'
    );
    const searchRoot3 = partiComponent || document;
    diag.push('sigp_s3_root=' + (partiComponent ? partiComponent.tagName : 'document'));

    // Cerca tutti gli elementi con data-cf o data-codice-fiscale
    const cfElements = Array.from(searchRoot3.querySelectorAll('[data-cf], [data-codice-fiscale]'));
    diag.push('sigp_s3_cf_elements=' + cfElements.length);

    if (cfElements.length > 0) {
        for (const cfEl of cfElements) {
            const cf = cfEl.getAttribute('data-cf') || cfEl.getAttribute('data-codice-fiscale') || '';
            const nomeEl = cfEl.closest('[data-nome], [data-cognome]') ||
                           cfEl.previousElementSibling ||
                           cfEl.parentElement;
            const nomeCompleto = nomeEl ? getVis(nomeEl) : '';
            const tipoEl = cfEl.closest('[data-tipo]');
            const tipoTxt = tipoEl ? tipoEl.getAttribute('data-tipo') : '';
            const tipoFinal = normalizeTipoSIGP(tipoTxt) || 'CP';
            const cn = splitCognomeNome(nomeCompleto);

            if (cf || nomeCompleto) {
                diag.push('sigp_s3_parte=' + nomeCompleto + ' cf=' + cf);
                parti.push({
                    tipo:         tipoFinal,
                    cognome:      cn.cognome,
                    nome:         cn.nome,
                    cf_parte:     cf.toUpperCase(),
                    tipo_raw:     tipoTxt,
                    data_nascita: null,
                    avvocati:     [],
                });
            }
        }
    }

    // ── Strategia 4: dump diagnostico DOM SIGP ────────────────────────────────
    // Se nessuna strategia ha trovato parti, logga la struttura per debug futuro.
    // NON e' un guasto: da quando il server legge il profilo del fascicolo dal
    // Portale (profiloFascicolo), le parti del Giudice di Pace con il loro
    // codice fiscale arrivano da li'. Questa lettura dalla pagina e' solo un
    // ripiego, e se non trova niente il mittente non invia nulla (le parti
    // sul monitor restano quelle del server). Percio' si scrive con log() e
    // non con warn(): warn() finisce nell'elenco "Errori" dell'estensione e
    // sembrava un difetto.
    if (parti.length === 0) {
        console.log('[PCT] scrapePartSIGP: nessuna parte nella pagina, valgono quelle lette dal server');
        const angularComponents = Array.from(document.querySelectorAll('*'))
            .filter(el => el.tagName.toLowerCase().startsWith('app-'))
            .map(el => el.tagName.toLowerCase())
            .filter((v, i, a) => a.indexOf(v) === i)
            .slice(0, 20);
        diag.push('sigp_angular_components=' + JSON.stringify(angularComponents));
        console.log('[PCT] scrapePartSIGP: componenti Angular nel DOM:', angularComponents.join(', '));

        // Dump innerHTML del componente parti se esiste
        const partiComp = document.querySelector('app-dettaglio-fascicolo-parti, app-parti');
        if (partiComp) {
            const snap = partiComp.innerHTML.replace(/\s+/g, ' ').substring(0, 600);
            console.log('[PCT] scrapePartSIGP: app-parti innerHTML:', snap);
            diag.push('sigp_parti_comp_html=' + snap);
        }

        // Dump di tutti i testi visibili nel tab Parti per analisi manuale
        const allTexts = [];
        const allEls = (partiComp || document).querySelectorAll('*');
        let count = 0;
        for (const el of allEls) {
            if (count >= 20) break;
            const txt = (el.textContent || '').trim();
            if (txt.length > 0 && txt.length < 100 && el.children.length === 0) {
                allTexts.push(el.tagName + ': ' + JSON.stringify(txt.substring(0, 60)));
                count++;
            }
        }
        diag.push('sigp_dom_texts=' + JSON.stringify(allTexts));
        console.log('[PCT] scrapePartSIGP: testi DOM:', allTexts.join(' | '));
    }

    console.log('[PCT] scrapePartSIGP: risultato finale', parti.length, 'parti');
    diag.push('sigp_risultato_finale=' + parti.length);
    parti._diagnostics = diag;
    return parti;
}

async function scrapePart() {
    // ── Dispatcher SIGP (Giudice di Pace): DOM Angular diverso da SICID ──────
    if (isGdP()) {
        console.log('[PCT] scrapePart: pagina SIGP rilevata → uso scrapePartSIGP()');
        return await scrapePartSIGP();
    }

    const parti = [];
    const diag = [];

    // Helper: testo visibile escludendo span.screen-reader-only.
    // NON usare innerText sul div live: .screen-reader-only usa position:absolute
    // (non display:none), quindi innerText LO INCLUDE restituendo "Attore:\nVALORE".
    // Clone + remove + textContent è l'unico modo affidabile per escluderli.
    const getVis = (el) => {
        if (!el) return '';
        const clone = el.cloneNode(true);
        clone.querySelectorAll(
            '.screen-reader-only, .sr-only, .visually-hidden, ' +
            '[class*="screen-reader"], [class*="screenreader"], [class*="sr-only"]'
        ).forEach(s => s.remove());
        return clone.textContent.replace(/\s+/g, ' ').trim();
    };

    // Helper: estrae le righe di testo da un elemento (per avvocati multipli).
    // Ogni avvocato è in un div figlio separato dentro la datatable-body-cell.
    const getCellDivLines = (cell) => {
        if (!cell) return [];
        // Prima prova: div figli diretti (struttura ngx-datatable con avvocati multipli)
        const childDivs = Array.from(cell.querySelectorAll(':scope > div, :scope > span'));
        if (childDivs.length > 0) {
            const lines = childDivs.map(d => getVis(d)).filter(Boolean);
            if (lines.length > 0) return lines;
        }
        // Fallback: testo unico della cella
        const txt = getVis(cell);
        return txt ? [txt] : [];
    };

    // ── Strategia principale: ngx-datatable (PdA Toscana) ────────────────────────────────
    // Cerca le sezioni Attori/Convenuti tramite card-header con span.font-weight-bold,
    // poi naviga il ngx-datatable dentro ogni card per estrarre le righe.
    //
    // Struttura DOM:
    //   .card > .card-header > span.font-weight-bold "Attori"
    //   .card > .card-body > ... > ngx-datatable > datatable-body
    //     > datatable-selection > datatable-scroller
    //       > datatable-row-wrapper > datatable-body-row
    //           > div.datatable-row-center > datatable-body-cell[0..4]
    //
    // Polling: aspetta fino a 15s che almeno un datatable-body-row appaia nel document.

    let bodyRows = [];
    const maxWaitNgx = 15000;
    const stepNgx = 500;
    let waitedNgx = 0;
    while (waitedNgx < maxWaitNgx) {
        bodyRows = Array.from(document.querySelectorAll('datatable-body-row'));
        if (bodyRows.length > 0) {
            console.log('[PCT] scrapePart: trovati', bodyRows.length, 'datatable-body-row dopo', waitedNgx, 'ms');
            diag.push('ngx_body_rows=' + bodyRows.length + '_ms=' + waitedNgx);
            break;
        }
        await new Promise(r => setTimeout(r, stepNgx));
        waitedNgx += stepNgx;
    }

    if (bodyRows.length > 0) {
        // Mappa label sezione → tipo processuale
        const SECTION_TIPO = {
            'attori': 'AP', 'attore': 'AP', 'ricorrenti': 'AP', 'ricorrente': 'AP',
            'convenuti': 'CP', 'convenuto': 'CP', 'resistenti': 'CP', 'resistente': 'CP',
            'terzi': 'TP', 'terzo': 'TP', 'intervenuti': 'TP', 'intervenuto': 'TP',
            'controinteressati': 'TP', 'controinteressato': 'TP',
        };

        // Trova tutte le card che contengono sezioni parti (Attori/Convenuti/ecc.)
        // Cerca span.font-weight-bold (o simili) con testo che corrisponde a un tipo parte.
        const sectionCards = []; // { tipo: 'AP'|'CP'|'TP', card: Element }

        // Cerca header di sezione: span.font-weight-bold, .card-header strong, ecc.
        const headerCandidates = Array.from(document.querySelectorAll(
            '.card-header .font-weight-bold, .card-header strong, ' +
            '.card-header span, .card-header h5, .card-header h6'
        ));
        for (const hdr of headerCandidates) {
            const txt = (hdr.textContent || '').trim().toLowerCase();
            if (!txt || txt.length > 40) continue;
            const tipo = SECTION_TIPO[txt];
            if (!tipo) continue;
            // Risali al .card contenitore
            const card = hdr.closest('.card');
            if (!card) continue;
            // Evita duplicati (stesso card già trovato)
            if (sectionCards.some(s => s.card === card)) continue;
            sectionCards.push({ tipo, card, label: txt });
            console.log('[PCT] scrapePart: sezione trovata:', txt, '→', tipo, '| card:', card.className.substring(0, 40));
            diag.push('sezione=' + txt + '_tipo=' + tipo);
        }

        // Fallback: se non trovate card con header, usa compareDocumentPosition
        // sugli header trovati nel document per assegnare tipo a ogni datatable-body-row
        if (sectionCards.length === 0) {
            console.log('[PCT] scrapePart: nessuna card-header trovata, provo fallback header generico');
            diag.push('ngx_no_card_headers');
            // Cerca qualsiasi elemento con testo esatto "Attori"/"Convenuti" ecc.
            document.querySelectorAll('*').forEach(el => {
                const t = (el.textContent || '').trim();
                if (t.length === 0 || t.length > 40) return;
                const tipo = SECTION_TIPO[t.toLowerCase()];
                if (!tipo) return;
                // Evita elementi che contengono altri elementi con lo stesso testo
                const children = Array.from(el.children).filter(c => (c.textContent || '').trim() === t);
                if (children.length > 0) return; // è un wrapper, non il testo diretto
                const card = el.closest('.card') || el.parentElement;
                if (!card) return;
                if (sectionCards.some(s => s.card === card)) return;
                sectionCards.push({ tipo, card, label: t.toLowerCase() });
                diag.push('sezione_fallback=' + t + '_tipo=' + tipo);
            });
        }

        console.log('[PCT] scrapePart:', sectionCards.length, 'sezioni trovate');
        diag.push('section_cards=' + sectionCards.length);

        // Processa ogni sezione
        for (const section of sectionCards) {
            const { tipo: tipoSezione, card, label: sectionLabel } = section;

            // Trova il datatable-body dentro questa card
            const datatableBody = card.querySelector('datatable-body');
            if (!datatableBody) {
                console.log('[PCT] scrapePart: sezione', sectionLabel, '| nessun datatable-body trovato nella card');
                diag.push('sezione_' + sectionLabel + '_no_datatable_body');
                continue;
            }

            // Trova tutte le datatable-body-row dentro questo datatable-body
            const sectionRows = Array.from(datatableBody.querySelectorAll('datatable-body-row'));
            console.log('[PCT] scrapePart: sezione', sectionLabel, '|', sectionRows.length, 'righe trovate');
            diag.push('sezione_' + sectionLabel + '_rows=' + sectionRows.length);

            for (let rIdx = 0; rIdx < sectionRows.length; rIdx++) {
                const row = sectionRows[rIdx];

                // Trova le celle nell'ordine DOM dentro div.datatable-row-center
                // (o direttamente dentro datatable-body-row se non c'è il wrapper)
                const rowCenter = row.querySelector('div.datatable-row-center') || row;
                const cells = Array.from(rowCenter.querySelectorAll('datatable-body-cell'));

                if (cells.length === 0) {
                    diag.push('sezione_' + sectionLabel + '_riga' + rIdx + '_no_cells');
                    continue;
                }

                // Log diagnostico prima riga
                if (rIdx === 0) {
                    const cellTexts = cells.map((c, i) => i + ':' + getVis(c).substring(0, 30));
                    console.log('[PCT] scrapePart: sezione', sectionLabel, '| riga[0] celle:', cellTexts.join(' | '));
                    diag.push('sezione_' + sectionLabel + '_riga0=' + cellTexts.join('|'));
                }

                // Mappa per posizione:
                //   cella 0 = nome completo parte
                //   cella 1 = CF/P.IVA parte
                //   cella 2 = nome avvocato (può avere più div figli per avvocati multipli)
                //   cella 3 = CF avvocato (corrispondenza 1:1 con cella 2)
                //   cella 4 = tipo (P=Principale, S=Secondario — NON usato per AP/CP)
                const nomeCompleto = cells[0] ? getVis(cells[0]) : '';
                if (!nomeCompleto) continue;

                const cfParte = cells[1] ? getVis(cells[1]) : '';

                // Avvocati multipli: ogni avvocato è in un div figlio separato
                const nomiAvv = cells[2] ? getCellDivLines(cells[2]) : [];
                const cfAvv   = cells[3] ? getCellDivLines(cells[3]) : [];

                // Costruisci array avvocati con corrispondenza 1:1 nome↔CF
                const avvocati = [];
                const nAvv = Math.max(nomiAvv.length, cfAvv.length);
                for (let k = 0; k < nAvv; k++) {
                    const nomeA = (nomiAvv[k] || '').replace(/^Avvocat[oi]:\s*/i, '').trim();
                    const cfA   = (cfAvv[k]   || '').replace(/^Codice\s+Fiscale(\s+Avvocat[oi])?\s*:?\s*/i, '').trim();
                    if (nomeA || cfA) avvocati.push({ nome_avvocato: nomeA, cf_avvocato: cfA });
                }

                // tipoRaw dalla colonna 4 (P/S = principale/secondario, NON il ruolo processuale)
                const tipoRaw = cells[4] ? getVis(cells[4]) : '';
                // Il tipo processuale (AP/CP/TP) viene dalla sezione, NON dalla colonna tipo
                const tipoFinal = tipoSezione;

                const cn = splitCognomeNome(nomeCompleto);

                console.log('[PCT] scrapePart: parte[' + sectionLabel + '/' + rIdx + ']',
                    nomeCompleto, '| tipo:', tipoFinal, '| cf_parte:', cfParte,
                    '| avv:', avvocati.length, avvocati.length > 0 ? JSON.stringify(avvocati[0]) : '');
                diag.push('parte_' + sectionLabel + rIdx + '=' + nomeCompleto + ' tipo=' + tipoFinal + ' avv=' + avvocati.length);

                parti.push({
                    tipo:         tipoFinal,
                    cognome:      cn.cognome,
                    nome:         cn.nome,
                    cf_parte:     cfParte,
                    tipo_raw:     tipoRaw || sectionLabel,
                    data_nascita: null,
                    avvocati:     avvocati,
                });
            }
        }

        // Se abbiamo trovato parti con la strategia ngx-datatable, ritorna
        if (parti.length > 0 || sectionCards.length > 0) {
            console.log('[PCT] scrapePart: ngx-datatable → trovate', parti.length, 'parti');
            diag.push('ngx_risultato=' + parti.length);
            parti._diagnostics = diag;
            return parti;
        }

        // ── Strategia "Elenco Parti" piatto (procedure concorsuali SIECIC) ──────
        // Nei fascicoli FALL/liquidazione giudiziale il tab Parti NON usa le card
        // a sezioni Attori/Convenuti: e' una sola ngx-datatable con il Ruolo come
        // COLONNA (Debitore / Creditore / ...), piu' Descrizione e Codice Fiscale.
        // Il servizio API elencoPartiEC per questi fascicoli risponde 204, quindi
        // questa lettura dal DOM e' l'unica fonte. Ogni cella porta la propria
        // etichetta in span.screen-reader-only ("Ruolo:", "Descrizione:",
        // "Codice Fiscale:"): usiamo quella per mappare cella->campo, cosi' la
        // lettura regge anche il layout responsive a schede.
        if (sectionCards.length === 0) {
            const RUOLO_TIPO = (r) => {
                const u = (r || '').toUpperCase();
                if (/CREDITOR/.test(u)) return /INTERVEN/.test(u) ? 'APC' : 'AP';
                if (/DEBITOR/.test(u)) return 'CP';
                if (/ATTOR|ATTRIC|RICORRENT|OPPONENT|ISTANT/.test(u)) return 'AP';
                if (/CONVENUT|RESISTENT|OPPOST/.test(u)) return 'CP';
                if (/TERZ|INTERVENUT|CONTROINTERESS/.test(u)) return 'TP';
                return '';
            };
            // Etichetta screen-reader di una cella (es. "Ruolo:")
            const cellLabel = (cell) => {
                const sr = cell.querySelector(
                    '.screen-reader-only, .sr-only, .visually-hidden, ' +
                    '[class*="screen-reader"], [class*="screenreader"], [class*="sr-only"]'
                );
                return sr ? (sr.textContent || '').replace(/[:\s]+$/, '').trim().toLowerCase() : '';
            };

            const partiPiatte = [];
            for (const row of bodyRows) {
                const rowCenter = row.querySelector('div.datatable-row-center') || row;
                const cells = Array.from(rowCenter.querySelectorAll('datatable-body-cell'));
                if (cells.length === 0) continue;

                let ruolo = '', descr = '', cf = '';
                cells.forEach((cell, i) => {
                    const lab = cellLabel(cell);
                    const val = getVis(cell);
                    if (/ruolo/.test(lab))                         ruolo = val;
                    else if (/descriz|nominativ|parte|denominaz/.test(lab)) descr = descr || val;
                    else if (/fiscale|p\.?\s*iva|partita/.test(lab)) cf = cf || val;
                });

                // Senza etichette screen-reader (layout diverso) ripiega sulle
                // posizioni tipiche: Ruolo | Descrizione | Codice Fiscale.
                if (!ruolo && !descr && cells.length >= 2) {
                    ruolo = getVis(cells[0]);
                    descr = getVis(cells[1]);
                    cf    = cells[2] ? getVis(cells[2]) : '';
                }

                const tipo = RUOLO_TIPO(ruolo);
                // Accetta la riga solo se e' davvero una parte (ruolo riconosciuto
                // e un nominativo), per non raccogliere righe di altre datatable.
                if (!tipo || !descr) continue;

                // Scarta le righe il cui "nominativo" e' in realta' un codice
                // fiscale personale di avvocato: in alcuni layout il difensore
                // del creditore compare come riga a se', con il suo CF al posto
                // del nome. Non e' una parte e non va salvato (finirebbe come
                // "Creditore BRTVNC77M43L833L").
                if (/^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/i.test(descr.replace(/\s+/g, ''))) {
                    console.log('[PCT] scrapePart: riga saltata (nominativo = CF avvocato):', descr);
                    continue;
                }

                const cn = splitCognomeNome(descr);
                partiPiatte.push({
                    tipo:         tipo,
                    cognome:      cn.cognome,
                    nome:         cn.nome,
                    cf_parte:     (cf === 'N/A' || cf === 'N-A') ? '' : cf,
                    tipo_raw:     ruolo,
                    data_nascita: null,
                    avvocati:     [],
                });
            }

            if (partiPiatte.length > 0) {
                console.log('[PCT] scrapePart: elenco parti piatto (concorsuale) →',
                    partiPiatte.length, 'parti');
                diag.push('ngx_elenco_piatto=' + partiPiatte.length);
                partiPiatte.forEach(p => parti.push(p));
                parti._diagnostics = diag;
                return parti;
            }
        }

        // Se bodyRows esistono ma nessuna sezione trovata, logga diagnostica e ritorna vuoto
        if (sectionCards.length === 0) {
            console.log('[PCT] scrapePart: datatable-body-row trovati ma nessuna sezione AP/CP identificata');
            diag.push('ngx_no_sections_found');
            // Dump primo body-row per diagnostica
            if (bodyRows[0]) {
                const snap = bodyRows[0].outerHTML.replace(/\s+/g, ' ').substring(0, 500);
                console.log('[PCT] scrapePart: bodyRows[0] outerHTML:', snap);
                diag.push('ngx_row0_html=' + snap);
            }
            parti._diagnostics = diag;
            return parti;
        }
    } else {
        console.log('[PCT] scrapePart: timeout 15s senza datatable-body-row, provo tabelle...');
        diag.push('ngx_timeout_no_rows');
    }

    // ── Fallback: struttura a tabella standard (altri PdA) ───────────────────────────────
    console.log('[PCT] scrapePart: fallback tabelle standard...');
    diag.push('timeout_row_divs=0_uso_tabelle');

    const activeArea = getActiveTabContent();
    const searchRoot = activeArea || document;
    const srDesc = searchRoot === document
        ? 'document'
        : (searchRoot.tagName + (searchRoot.id ? '#' + searchRoot.id : '') +
           (searchRoot.className ? '.' + searchRoot.className.trim().replace(/\s+/g, '.').substring(0, 60) : ''));
    diag.push('searchRoot=' + srDesc);
    console.log('[PCT] scrapePart: searchRoot =', srDesc);

    // ── Step 2: raccogli TUTTE le tabelle nell'area ──────────────────────────
    // Dopo il click sul tab Parti, il contenuto visibile contiene SOLO le
    // sezioni Attori e Convenuti: le uniche tabelle presenti sono quelle di parti.
    // ESCLUDIAMO le tabelle dentro app-dettaglio-fascicolo-dati-generali (header fascicolo).
    // NOTA: se searchRoot è app-dettaglio-fascicolo (componente padre), contiene anche
    // app-dettaglio-fascicolo-dati-generali, quindi il filtro è necessario.
    // Usa polling per aspettare che Angular renderizzi le tabelle.
    let tables = await waitForTablesInRoot(searchRoot, 5000);
    diag.push('tabelle_in_searchRoot=' + tables.length);
    diag.push('searchRoot_html_snippet=' + (searchRoot !== document ? searchRoot.innerHTML.substring(0, 200).replace(/\s+/g, ' ') : 'document'));
    console.log('[PCT] scrapePart: tabelle trovate in searchRoot (escluso header):', tables.length);

    // ── Fallback A: se 0 tabelle in activeArea, cerca su document con polling ──
    if (tables.length === 0) {
        console.log('[PCT] scrapePart: fallback A - polling su document per tabelle parti');
        diag.push('fallback_A=attivo');
        // Polling su document: Angular potrebbe non aver ancora renderizzato
        // le tabelle nel searchRoot ma potrebbe averle altrove nel document.
        const docTables = await waitForTablesInRoot(document, 3000);
        // Cerca in tutto il document, escludendo SOLO la tabella header fascicolo
        // (app-dettaglio-fascicolo-dati-generali). Le tabelle delle parti sono in
        // componenti Angular diversi (es. app-dettaglio-fascicolo-parti).
        const allTables = docTables.length > 0
            ? docTables
            : Array.from(document.querySelectorAll('table')).filter(
                t => !t.closest('app-dettaglio-fascicolo-dati-generali')
              );
        diag.push('fallback_A_all_tables_in_doc=' + allTables.length);
        // Dump dei componenti Angular presenti per diagnostica
        const angularComponents = Array.from(document.querySelectorAll('*')).filter(el => el.tagName.toLowerCase().startsWith('app-')).map(el => el.tagName.toLowerCase()).filter((v, i, a) => a.indexOf(v) === i).slice(0, 15);
        diag.push('angular_components=' + JSON.stringify(angularComponents));
        // Cerca tabelle con header che contengono parole chiave parti
        tables = allTables.filter(t => {
            // Controlla sia thead che prima riga tr (per tabelle senza thead esplicito)
            const headerCells = Array.from(t.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td'));
            const hText = headerCells.map(h => h.textContent.trim().toLowerCase()).join(' ');
            return /attore|attori|codice\s*fiscale|avvocat|convenuto|convenuti|parte|ricorrente|resistente/i.test(hText);
        });
        diag.push('fallback_A_tabelle=' + tables.length);
        console.log('[PCT] scrapePart: fallback A → tabelle con header parti:', tables.length);

        // Fallback A2: se ancora 0, prendi TUTTE le tabelle non-header con almeno 2 colonne
        if (tables.length === 0) {
            tables = allTables.filter(t => {
                const rows = t.querySelectorAll('tr');
                if (rows.length === 0) return false;
                const firstDataRow = Array.from(rows).find(r => r.querySelectorAll('td').length >= 2);
                return !!firstDataRow;
            });
            diag.push('fallback_A2_tabelle=' + tables.length);
            console.log('[PCT] scrapePart: fallback A2 → tabelle con >=2 colonne:', tables.length);
        }
    }

    // ── Fallback B: dump diagnostico + Angular Material mat-table ───────────────
    if (tables.length === 0) {
        // Dump innerHTML del searchRoot per capire la struttura reale
        const rootHtml = searchRoot !== document
            ? searchRoot.innerHTML.replace(/\s+/g, ' ').substring(0, 600)
            : '(document, troppo grande)';
        console.log('[PCT] scrapePart: searchRoot.innerHTML snapshot:', rootHtml);
        diag.push('fallback_B_searchRoot_html=' + rootHtml);

        // Dump #schedaFascicolo-panel se esiste (PdA Toscana)
        const schedaPanel = document.querySelector('#schedaFascicolo-panel, .scheda-fascicolo, app-dettaglio-fascicolo-parti');
        if (schedaPanel) {
            const schedaHtml = schedaPanel.innerHTML.replace(/\s+/g, ' ').substring(0, 600);
            console.log('[PCT] scrapePart: schedaPanel:', schedaPanel.tagName, schedaHtml);
            diag.push('fallback_B_schedaPanel=' + schedaPanel.tagName + ':' + schedaHtml);
        }

        // ── Fallback C: Angular Material mat-table (usa div, non <table>) ────────
        // mat-table renderizza con mat-row/mat-cell invece di tr/td.
        // Seleziona tutte le mat-row (righe dati, non header) in tutto il document.
        const matRows = Array.from(document.querySelectorAll(
            'mat-row, [mat-row], .mat-row, ' +
            'cdk-row, [cdk-row], .cdk-row, ' +
            '[role="row"]:not([aria-label*="header"]):not(.mat-header-row):not(.cdk-header-row)'
        ));
        console.log('[PCT] scrapePart: Fallback C (mat-row):', matRows.length, 'righe trovate');
        diag.push('fallback_C_mat_rows=' + matRows.length);

        if (matRows.length > 0) {
            // Log prime due righe per diagnostica — includi outerHTML del primo per vedere la struttura
            const firstRowOuter = matRows[0].outerHTML.replace(/\s+/g, ' ').substring(0, 500);
            console.log('[PCT] scrapePart: mat-row[0] outerHTML:', firstRowOuter);
            diag.push('fallback_C_row0_outerHTML=' + firstRowOuter);
            matRows.slice(0, 2).forEach((r, i) => {
                const cells = Array.from(r.querySelectorAll('mat-cell, [mat-cell], .mat-cell, cdk-cell, [cdk-cell], .cdk-cell, [role="gridcell"], [role="cell"]'));
                const cellTexts = cells.map(c => JSON.stringify((c.innerText || c.textContent || '').trim().substring(0, 30)));
                console.log('[PCT] scrapePart: mat-row[' + i + '] celle=' + cells.length, cellTexts.join(', '));
                diag.push('fallback_C_row' + i + '=' + JSON.stringify(cellTexts));
            });

            matRows.forEach((row, rowIdx) => {
                const cells = Array.from(row.querySelectorAll(
                    'mat-cell, [mat-cell], .mat-cell, ' +
                    'cdk-cell, [cdk-cell], .cdk-cell, ' +
                    '[role="gridcell"], [role="cell"]'
                ));
                if (cells.length < 2) return;

                const nomeCompleto = (cells[0].innerText || getText(cells[0])).trim();
                if (!nomeCompleto) return;
                if (/^\d+\s+risultat/i.test(nomeCompleto)) return;
                // Salta righe header (nome che coincide con etichette colonna)
                if (/^(nome|parte|cognome|attore|convenuto|tipo)$/i.test(nomeCompleto)) return;

                const tipoRaw   = cells.length >= 5 ? (cells[4].innerText || getText(cells[4])).trim() : '';
                // Determina tipo da contesto parent (sezione Attori/Convenuti)
                let tipoSezione = null;
                let el = row;
                for (let d = 0; d < 8 && !tipoSezione; d++) {
                    const prev = el.previousElementSibling;
                    if (prev) {
                        const txt = (prev.textContent || '').trim().toLowerCase();
                        if (txt.length < 100) {
                            if (/\battori\b|\battore\b|\bricorrente/i.test(txt)) tipoSezione = 'AP';
                            else if (/\bconvenut|\bresistente/i.test(txt)) tipoSezione = 'CP';
                        }
                    }
                    if (!el.parentElement) break;
                    el = el.parentElement;
                }
                const tipoFinal = tipoRaw ? normalizeTipo(tipoRaw) : (tipoSezione || 'CP');
                const cn = splitCognomeNome(nomeCompleto);

                const nomiAvv = getCellLines(cells[2]) ;
                const cfAvv   = cells.length >= 4 ? getCellLines(cells[3]) : [];
                const avvocati = [];
                for (let k = 0; k < Math.max(nomiAvv.length, cfAvv.length); k++) {
                    const nomeA = nomiAvv[k] || '';
                    const cfA   = cfAvv[k]   || '';
                    if (nomeA || cfA) avvocati.push({ nome_avvocato: nomeA, cf_avvocato: cfA });
                }

                console.log('[PCT] scrapePart (mat-row): aggiunta parte:', nomeCompleto, '| tipo:', tipoFinal, '| avvocati:', avvocati.length);
                diag.push('fallback_C_parte=' + nomeCompleto + ' tipo=' + tipoFinal);

                parti.push({
                    tipo:         tipoFinal,
                    cognome:      cn.cognome,
                    nome:         cn.nome,
                    cf_parte:     (cells[1].innerText || getText(cells[1])).trim() || '',
                    tipo_raw:     tipoRaw,
                    data_nascita: null,
                    avvocati:     avvocati,
                });
            });

            if (parti.length > 0) {
                console.log('[PCT] scrapePart: Fallback C trovato', parti.length, 'parti');
                parti._diagnostics = diag;
                return parti;
            }
        }

        // Dump struttura DOM per diagnostica finale
        const domDump = [];
        const allEls = document.querySelectorAll('*');
        let count = 0;
        for (const el of allEls) {
            if (count >= 30) break;
            const txt = (el.textContent || '').trim();
            if (txt.length > 0 && txt.length < 80) {
                const entry = el.tagName + (el.className ? '.' + String(el.className).trim().replace(/\s+/g, '.').substring(0, 30) : '') + ': ' + JSON.stringify(txt.substring(0, 50));
                domDump.push(entry);
                console.log('[PCT] dump:', entry);
                count++;
            }
        }
        diag.push('fallback_B_dom_dump=' + JSON.stringify(domDump));
        // Salva diagnostics come proprietà speciale sull'array
        parti._diagnostics = diag;
        return parti; // nulla da fare
    }

    // ── Step 3: per ogni tabella, determina tipo sezione dall'header precedente
    const processedTables = new Set();

    tables.forEach((table, idx) => {
        if (processedTables.has(table)) return;
        processedTables.add(table);

        // Cerca l'header di sezione risalendo nel DOM:
        // 1) fratello precedente (o suoi antenati) con testo 'Attori'/'Convenuti'
        // 2) risali fino a 5 livelli nel parent cercando un fratello precedente
        let tipoSezione = null; // null = non determinato, verrà inferito dalla colonna tipo
        let headerFound = false;

        const findSectionLabel = (startEl) => {
            // Prima prova: fratelli precedenti dell'elemento corrente
            let prev = startEl.previousElementSibling;
            for (let i = 0; i < 8 && prev; i++) {
                const txt = (prev.textContent || '').trim().toLowerCase();
                if (txt.length < 100) { // è un elemento intestazione, non contenuto
                    if (/\battori\b|\battore\b|\bricorrente/i.test(txt)) return 'AP';
                    if (/\bconvenut|\bresistente/i.test(txt)) return 'CP';
                }
                prev = prev.previousElementSibling;
            }
            // Seconda prova: testo del parent diretto
            const parentTxt = (startEl.parentElement?.textContent || '').substring(0, 200).toLowerCase();
            if (/\battori\b|\battore\b|\bricorrente/i.test(parentTxt)) return 'AP';
            if (/\bconvenut|\bresistente/i.test(parentTxt)) return 'CP';
            return null;
        };

        // Prova sul parent diretto della tabella e risali fino a 6 livelli
        let el = table;
        for (let depth = 0; depth < 7 && !headerFound; depth++) {
            const found = findSectionLabel(el);
            if (found) {
                tipoSezione = found;
                headerFound = true;
            }
            if (!el.parentElement) break;
            el = el.parentElement;
        }

        // Log diagnostico thead
        const theadCells = Array.from(table.querySelectorAll('thead th, thead td, tr:first-child th'));
        const theadText = theadCells.map(c => getText(c)).join(' | ');
        const diagEntry = 'tabella[' + idx + '] tipoSezione=' + tipoSezione + ' headerFound=' + headerFound + ' thead=[' + (theadText || 'no thead') + ']';
        diag.push(diagEntry);
        console.log('[PCT] scrapePart:', diagEntry);

        // ── Step 4: processa le righe ────────────────────────────────────────
        // USA tr DIRETTAMENTE (non tbody tr) per gestire tabelle senza tbody esplicito.
        // Filtra le righe di intestazione (th) e le righe con meno di 2 td.
        const allRows = Array.from(table.querySelectorAll('tr'));
        // Salta la prima riga se è un'intestazione (contiene th o testo header)
        const dataRows = allRows.filter(row => {
            const tds = row.querySelectorAll('td');
            const ths = row.querySelectorAll('th');
            // Riga di intestazione: ha th oppure tutti i td hanno testo che sembra header
            if (ths.length > 0 && tds.length === 0) return false;
            if (tds.length < 2) return false;
            // Salta righe dove la prima cella sembra un'intestazione di colonna
            const firstCellText = getText(tds[0]).toLowerCase();
            if (/^(nome|parte|cognome|attore|convenuto|ricorrente|resistente|tipo)$/.test(firstCellText)) return false;
            return true;
        });

        // Log prima riga dati
        if (dataRows.length > 0) {
            const fc = Array.from(dataRows[0].querySelectorAll('td')).map(c => getText(c).substring(0, 40));
            diag.push('tabella[' + idx + '] prima_riga=' + JSON.stringify(fc));
            console.log('[PCT] scrapePart: tabella', idx, '| prima riga dati:', fc);
        } else {
            diag.push('tabella[' + idx + '] nessuna_riga_dati allRows=' + allRows.length);
            console.log('[PCT] scrapePart: tabella', idx, '| nessuna riga dati (allRows=' + allRows.length + ')');
        }

        dataRows.forEach((row, rowIdx) => {
            const cells = row.querySelectorAll('td');
            console.log('[PCT] scrapePart: tabella', idx, 'riga', rowIdx, '| celle:', cells.length,
                '| cell[0]:', cells[0] ? JSON.stringify(getText(cells[0]).substring(0, 60)) : '(vuota)');

            if (cells.length < 2) return;

            // Colonne reali PdA: 0=Nome, 1=CF/PIVA, 2=Avvocati, 3=CF Avvocati, 4=Tipo
            const nomeCompleto = getText(cells[0]);
            if (!nomeCompleto) return;

            // Salta righe footer "N risultati" del PdA
            if (/^\d+\s+risultat/i.test(nomeCompleto)) {
                console.log('[PCT] scrapePart: riga', rowIdx, 'saltata (footer risultati):', nomeCompleto);
                return;
            }

            const tipoRaw  = cells.length >= 5 ? getText(cells[4]) : '';
            // Se tipoSezione non determinato dall'header, usa normalizeTipo o default CP
            const tipoFinal = tipoRaw ? normalizeTipo(tipoRaw) : (tipoSezione || 'CP');
            const cn = splitCognomeNome(nomeCompleto);

            // Avvocati: cella 2 = nomi (uno per riga), cella 3 = CF (uno per riga).
            // Usa getCellLines() invece di getText().split() perché getText() normalizza
            // i whitespace distruggendo i newline; getCellLines() preserva i <br> come '\n'.
            const nomiAvv = getCellLines(cells[2]);
            const cfAvv   = cells.length >= 4 ? getCellLines(cells[3]) : [];
            const avvocati = [];
            for (let k = 0; k < Math.max(nomiAvv.length, cfAvv.length); k++) {
                const nomeA = nomiAvv[k] || '';
                const cfA   = cfAvv[k]   || '';
                if (nomeA || cfA) avvocati.push({ nome_avvocato: nomeA, cf_avvocato: cfA });
            }

            console.log('[PCT] scrapePart: aggiunta parte:', nomeCompleto, '| tipo:', tipoFinal, '| avvocati:', avvocati.length);
            diag.push('parte_trovata=' + nomeCompleto + ' tipo=' + tipoFinal);

            parti.push({
                tipo:         tipoFinal,
                cognome:      cn.cognome,
                nome:         cn.nome,
                cf_parte:     getText(cells[1]) || '',
                tipo_raw:     tipoRaw,
                data_nascita: null,
                avvocati:     avvocati,
            });
        });
    });

    console.log('[PCT] scrapePart: risultato finale', parti.length, 'parti',
        parti.length > 0 ? JSON.stringify(parti[0]) : '(nessuna)');
    diag.push('risultato_finale=' + parti.length + '_parti');
    // Salva diagnostics come proprietà ENUMERABILE sull'array (così JSON.stringify la include)
    // e come proprietà non-enumerabile per retrocompatibilità con codice che usa parti._diagnostics
    parti._diagnostics = diag;
    return parti;
}

// ─── Tab: Aggiornamenti ───────────────────────────────────────────────────────

/**
 * Legge TUTTE le pagine di una ngx-datatable del PdA, non solo la prima.
 * La tabella del Portale mostra 10 righe per volta: la paginazione la fa il
 * browser (il servizio restituisce tutto), quindi senza questo giro il sync
 * raccoglierebbe solo la prima pagina.
 * raccogliRighe(root) estrae i record della pagina corrente; il risultato
 * complessivo viene deduplicato per sicurezza.
 */
async function scrapeDatatableTuttePagine(searchRoot, raccogliRighe, fermaSe) {
    const raccolti = [];
    const visti = new Set();
    let root = searchRoot;

    // Il footer dichiara il totale ("23 risultati"): raggiunto il totale ci
    // si ferma senza fare l'ultimo clic a vuoto.
    const footer = root && root.querySelector ? root.querySelector('datatable-footer') : null;
    const mTot = footer ? footer.textContent.match(/(\d+)\s+risultat/i) : null;
    const totaleDichiarato = mTot ? parseInt(mTot[1], 10) : null;

    for (let pagine = 0; pagine < 100; pagine++) {
        pctThrowIfAborted();
        if (!root || !root.isConnected) {
            root = Array.from(document.querySelectorAll('ngx-datatable'))
                .find(el => pdaElementoVisibile(el) && el.querySelector('datatable-header-cell')) || null;
        }
        if (!root) break;

        let raggiunto = false;
        for (const record of raccogliRighe(root)) {
            const chiave = JSON.stringify(record);
            if (!visti.has(chiave)) { visti.add(chiave); raccolti.push(record); }
            if (typeof fermaSe === 'function' && fermaSe(record)) raggiunto = true;
        }
        if (totaleDichiarato !== null && raccolti.length >= totaleDichiarato) break;
        // Lettura incrementale: se in questa pagina compare una riga gia' in
        // archivio, tutte le successive (piu' vecchie, l'elenco e' dal piu'
        // recente) sono gia' salvate: interrompiamo la paginazione.
        if (raggiunto) break;

        const pager = root.querySelector('datatable-pager');
        if (!pager) break;
        const attiva = pager.querySelector('li.active, li.current');
        const paginaCorrente = attiva ? attiva.textContent.trim() : '';
        const numeroPagina = parseInt(paginaCorrente, 10);
        const links = Array.from(pager.querySelectorAll('li a'));

        // Pagina successiva: il link col numero successivo; in mancanza la
        // freccia "avanti" riconosciuta dall'etichetta o dal simbolo ›.
        let prossimo = links.find(a => a.textContent.trim() === String(numeroPagina + 1));
        if (!prossimo) {
            prossimo = links.find(a => /next|successiv|avanti|›/i.test(
                (a.getAttribute('aria-label') || '') + ' ' + (a.getAttribute('title') || '') + ' ' + (a.textContent || '')));
        }
        const liProssimo = prossimo ? prossimo.closest('li') : null;
        if (!prossimo || !liProssimo || liProssimo.classList.contains('disabled')) break;

        // I link del pager hanno href="javascript:void(0)": un click normale
        // tenta di navigare a quell'URL e la CSP del Portale lo blocca (errore
        // "Running the JavaScript URL violates ... script-src"), impedendo il
        // cambio pagina. Annullo l'azione predefinita in fase di cattura: il
        // gestore (click) di Angular scatta comunque e cambia pagina.
        const bloccaNav = (e) => e.preventDefault();
        prossimo.addEventListener('click', bloccaNav, { capture: true });
        try {
            prossimo.click();
        } finally {
            prossimo.removeEventListener('click', bloccaNav, { capture: true });
        }
        let cambiata = false;
        for (let attesa = 0; attesa < 5000; attesa += 250) {
            await waitAbortable(250);
            const ora = pager.querySelector('li.active, li.current');
            if (ora && ora.textContent.trim() !== paginaCorrente) { cambiata = true; break; }
        }
        if (!cambiata) break;
    }
    return raccolti;
}

/**
 * Scrapa la tabella degli aggiornamenti.
 * Cerca la tabella visibile nel contenuto attivo del tab.
 */
async function scrapeAggiornamenti(panelRoot) {
    const aggiornamenti = [];
    const searchRoot = panelRoot || getActiveTabContent() || document;
    console.log('[PCT] scrapeAggiornamenti: ENTRY | panelRoot=', panelRoot ? panelRoot.tagName : 'null', '| searchRoot=', searchRoot.tagName || 'document');

    // ── Primo tentativo: ngx-datatable (componente Angular reale del PdA) ──
    const dtRows = searchRoot.querySelectorAll('datatable-body-row');
    console.log('[PCT] scrapeAggiornamenti: querySelectorAll datatable-body-row →', dtRows.length, 'righe');
    if (dtRows.length > 0) {
        console.log('[PCT] scrapeAggiornamenti: trovate', dtRows.length, 'righe ngx-datatable (pagina corrente)');
        const raccogliRighe = (root) => {
            const pagina = [];
            root.querySelectorAll('datatable-body-row').forEach(row => {
                const cells = row.querySelectorAll('datatable-body-cell');
                if (cells.length < 2) return;

                let data_evento, data_registrazione, descrizione, link_documenti = '';
                if (cells.length >= 3) {
                    data_evento        = getDatatableCellValue(cells[0]);
                    data_registrazione = getDatatableCellValue(cells[1]);
                    descrizione        = getDatatableCellValue(cells[2]);
                } else {
                    data_evento        = getDatatableCellValue(cells[0]);
                    data_registrazione = '';
                    descrizione        = getDatatableCellValue(cells[1]);
                }

                // Documenti: ultima cella può contenere un link o un'icona cliccabile
                if (cells.length >= 4) {
                    link_documenti = getHref(cells[cells.length - 1]) || '';
                }

                if (descrizione || data_evento) {
                    pagina.push({ data_evento, data_registrazione, descrizione, link_documenti });
                }
            });
            return pagina;
        };
        // Lettura incrementale: ci si ferma alla prima riga con "Data
        // Registrazione" (o "Data") gia' presente in archivio.
        const markerAgg = (_riferimentiArchivio && _riferimentiArchivio.aggiornamenti)
            ? _isoOrdinabile(_riferimentiArchivio.aggiornamenti) : null;
        const fermaSe = markerAgg ? (rec) => {
            const d = _dataItaOrdinabile(rec.data_registrazione) || _dataItaOrdinabile(rec.data_evento);
            return d !== null && d <= markerAgg;
        } : null;
        return await scrapeDatatableTuttePagine(searchRoot, raccogliRighe, fermaSe);
    }

    // ── Fallback: tabella HTML standard ──
    const table = findVisibleTable();
    if (!table) return aggiornamenti;

    table.querySelectorAll('tbody tr').forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return;

        let data_evento, data_registrazione, descrizione;
        if (cells.length >= 3) {
            data_evento        = getText(cells[0]);
            data_registrazione = getText(cells[1]);
            descrizione        = getText(cells[2]);
        } else {
            data_evento        = getText(cells[0]);
            data_registrazione = '';
            descrizione        = getText(cells[1]);
        }

        const link = getHref(cells[cells.length - 1]);

        if (descrizione || data_evento) {
            aggiornamenti.push({
                data_evento,
                data_registrazione,
                descrizione,
                link_documenti: link || '',
            });
        }
    });

    return aggiornamenti;
}

// ─── Tab: Atti e Documenti ────────────────────────────────────────────────────

/**
 * Inietta uno script nel contesto della pagina (non isolato) che:
 * 1) Monkey-patcha URL.createObjectURL per catturare i blob Angular
 * 2) Monkey-patcha XMLHttpRequest e fetch per intercettare POST a downloadDocumento
 * Comunica i risultati al content script via window.postMessage.
 *
 * NOTA: il content script gira in un isolated world e NON puo' accedere
 * allo scope Angular. Lo script iniettato gira nel contesto della pagina.
 * Per evitare il blocco della CSP del PdA usiamo un file JS esterno
 * dichiarato in web_accessible_resources anziche' uno script inline.
 */
function injectDownloadInterceptor() {
    // Evita doppia iniezione
    if (document.getElementById('pct-interceptor-script')) return;

    const script = document.createElement('script');
    script.id = 'pct-interceptor-script';
    script.src = chrome.runtime.getURL('interceptor.js');
    (document.head || document.documentElement).appendChild(script);
}

/**
 * Espande tutti i nodi chiusi dell'albero atti (Angular treeview).
 * Struttura reale PdA: icone .fa-caret-right per nodi CHIUSI, .fa-caret-down per nodi GIA' APERTI.
 * Clicca i toggle uno alla volta con 500ms di attesa tra ciascuno.
 * Ripete finché non ci sono più nodi chiusi.
 *
 * IMPORTANTE: NON cliccare fa-caret-down (già aperto) altrimenti si chiude il nodo.
 * Cliccare SOLO fa-caret-right (chiuso) e aria-expanded="false".
 *
 * STRATEGIA MULTI-LIVELLO: dopo ogni click, nuovi nodi figli potrebbero apparire.
 * Il loop continua finché non ci sono più toggle chiusi O il numero non cambia
 * per 2 iterazioni consecutive (anti-loop).
 */
// Forza l'espansione dei nodi di primo livello dell'albero atti che Angular
// non renderizza finché non vengono cliccati.
// Espande: "Provvedimenti di Ufficio", "Altri Atti", "Atti di Parte" e qualsiasi
// nodo radice dell'albero con icona fa-caret-right (chiuso) visibile.
async function expandFirstLevelNodes(searchRoot) {
    const root = searchRoot || document;
    const EXCLUDE_NAV = 'nav, header, footer, .navbar, .sidebar, .dropdown-menu, app-header, app-sidebar, app-footer, app-breadcrumbs';

    // Pattern di nodi di primo livello da espandere esplicitamente
    const FIRST_LEVEL_PATTERNS = [
        /provvedimenti\s+di\s+ufficio/i,
        /altri\s+atti/i,
        /atti\s+di\s+parte/i,
        /atti\s+e\s+documenti/i,
    ];

    let expanded = 0;
    const allElements = root.querySelectorAll('span, a, div, li');
    for (const el of allElements) {
        pctThrowIfAborted();
        if (el.closest(EXCLUDE_NAV)) continue;
        const txt = (el.textContent || '').trim();
        if (txt.length === 0 || txt.length > 100) continue;
        const matches = FIRST_LEVEL_PATTERNS.some(re => re.test(txt));
        if (!matches) continue;
        // Verifica che sia un nodo con icona chiusa (fa-caret-right) o aria-expanded=false
        const hasClosedIcon = el.querySelector('i.fa-caret-right, [aria-expanded="false"]') ||
            el.closest('li')?.querySelector('i.fa-caret-right, [aria-expanded="false"]');
        const clickTarget = el.closest('a') || el.closest('li') || el;
        console.log('[PCT] expandFirstLevel: espando nodo "' + txt.substring(0, 50) + '" (hasClosedIcon=' + !!hasClosedIcon + ')');
        clickTarget.click();
        await waitAbortable(1500);
        expanded++;
    }

    // Secondo passaggio: espandi qualsiasi fa-caret-right visibile di primo livello
    // (nodi che non hanno testo riconoscibile ma sono chiusi)
    const closedToggles = Array.from(root.querySelectorAll('i.fa-caret-right')).filter(el => {
        if (el.closest(EXCLUDE_NAV)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    });
    if (closedToggles.length > 0) {
        console.log('[PCT] expandFirstLevel: trovati', closedToggles.length, 'toggle chiusi aggiuntivi, espando...');
        for (const toggle of closedToggles) {
            pctThrowIfAborted();
            toggle.click();
            await waitAbortable(800);
            expanded++;
        }
    }

    console.log('[PCT] expandFirstLevel: espansi', expanded, 'nodi di primo livello');
    if (expanded > 0) {
        await waitAbortable(1000); // attesa extra per rendering Angular
    }
}

async function expandAttiTree(searchRoot) {
    let maxIterations = 30; // sicurezza anti-loop infinito (aumentato per alberi profondi)
    // Anti-loop per IDENTITA', non per conteggio: un elemento gia' cliccato
    // non va ricliccato, ma il conteggio dei toggle chiusi puo' restare
    // uguale tra due iterazioni per pura coincidenza (nodi vecchi che si
    // aprono e nodi nuovi che compaiono, stesso totale) - in quel caso la
    // vecchia euristica "numero invariato per 2 giri" usciva prima di aver
    // espanso tutto l'albero, facendo saltare interi atti dalla sincronizzazione.
    const cliccati = new WeakSet();

    while (maxIterations-- > 0) {
        pctThrowIfAborted();
        // Cerca SOLO nodi CHIUSI (non quelli già aperti):
        // - .fa-caret-right (freccia destra = chiuso nel PdA reale)
        // - [aria-expanded="false"] (standard ARIA)
        // - .fa-chevron-right (variante chevron chiuso)
        // - li.collapsed (nodo collassato)
        // NON includere fa-caret-down (= già aperto/espanso)
        const toggles = Array.from(searchRoot.querySelectorAll(
            'i.fa-caret-right, ' +
            '[aria-expanded="false"], ' +
            '.fa-chevron-right:not(.fa-chevron-down), ' +
            '.tree-toggle[aria-expanded="false"], ' +
            'span.toggle:not(.open), ' +
            '.node-toggle:not(.expanded), ' +
            'li.collapsed > span, ' +
            'li.collapsed > a, ' +
            '.ng-star-inserted [aria-expanded="false"]'
        )).filter(el => {
            // Filtra solo elementi visibili e cliccabili
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            // Escludi elementi della navbar/header/sidebar/footer - NON fanno parte dell'albero atti
            if (el.closest('nav, header, footer, .navbar, .sidebar, .dropdown-menu, app-header, app-sidebar, app-footer, app-breadcrumbs')) return false;
            return true;
        });

        console.log('[PCT] expandAttiTree: iterazione', 30 - maxIterations, '| toggle chiusi trovati:', toggles.length,
            toggles.length > 0 ? '| primo: ' + (toggles[0].className || toggles[0].tagName) : '');

        if (toggles.length === 0) break; // nessun nodo chiuso rimasto

        // Considera solo i toggle non ancora cliccati in un'iterazione precedente:
        // se sono tutti gia' stati cliccati (e sono ancora "chiusi" nel DOM,
        // es. per un elemento che non risponde al click) siamo davvero bloccati.
        const nuovi = toggles.filter(el => !cliccati.has(el));
        if (nuovi.length === 0) {
            console.log('[PCT] expandAttiTree: tutti i toggle chiusi rimasti erano gia\' stati cliccati, uscita anti-loop');
            break;
        }

        for (const toggle of nuovi) {
            pctThrowIfAborted();
            cliccati.add(toggle);
            toggle.click();
            await waitAbortable(500);
        }

        // Attesa extra per rendering Angular dopo espansione
        await waitAbortable(500);
    }
}

/**
 * Trova tutti i pulsanti download nell'albero atti.
 * Struttura reale PdA:
 *   <a role="button"><i class="fa fa-file-archive-o orange clicabile" title="Download copia informatica NomeFile.pdf.p7m"></i></a>
 *
 * Restituisce array di { btn, fileName, fileItem } dove:
 *   - btn: l'elemento <a role="button"> da cliccare
 *   - fileName: nome file estratto dal title dell'icona
 *   - fileItem: il nodo <li> o contenitore del file
 */
function findDownloadButtons(searchRoot) {
    const results = [];

    // Selettore primario: icone con title "Download copia informatica ..."
    const icons = searchRoot.querySelectorAll(
        '[role="button"] i[title*="Download"], ' +
        '[role="button"] i.fa-file-archive-o, ' +
        '[role="button"] i.fa-download, ' +
        '[role="button"] i[class*="file"]'
    );

    icons.forEach(icon => {
        const btn = icon.closest('[role="button"]');
        if (!btn) return;

        // Estrai nome file dal title dell'icona
        // title = "Download copia informatica Ricorso_Della_Tommasina_Ivano.pdf.p7m"
        let fileName = '';
        const title = icon.getAttribute('title') || '';
        const titleMatch = title.match(/Download\s+(?:copia\s+informatica\s+)?(.+)/i);
        if (titleMatch) {
            fileName = titleMatch[1].trim();
        }

        // Se il fileName estratto dal title non ha estensione (es. "originale", "copia informatica"),
        // cerca il nome file reale nel testo del bottone o nel contenitore
        const hasExtension = /\.(pdf|p7m|xml|zip|docx?|xlsx?)/i.test(fileName);
        if (!hasExtension) {
            // 1. Cerca nel testo del bottone stesso (es. <span role="button"><i>...</i> 26530312s.pdf</span>)
            const btnText = btn.textContent.trim();
            const btnFileMatch = btnText.match(/(\S+\.(pdf|p7m|xml|zip|docx?|xlsx?))/i);
            if (btnFileMatch) {
                // Mantieni il prefisso "originale" o "copia informatica" + nome file reale
                const prefix = fileName && !/\.(pdf|p7m|xml)/i.test(fileName) ? fileName + ' ' : '';
                fileName = prefix + btnFileMatch[1];
            }

            // 2. Fallback: cerca span con nome file nel nodo contenitore
            if (!btnFileMatch) {
                const fileItem = btn.closest('li, div.ng-star-inserted, .tree-node, div[class*="col-md"]');
                if (fileItem) {
                    const spans = fileItem.querySelectorAll('span');
                    for (const span of spans) {
                        const txt = span.textContent.trim();
                        const spanFileMatch = txt.match(/(\S+\.(pdf|p7m|xml|zip|docx?|xlsx?))/i);
                        if (spanFileMatch) {
                            fileName = spanFileMatch[1];
                            break;
                        }
                    }
                }
            }
        }

        if (!fileName) return; // salta se non riusciamo a determinare il nome file

        const fileItem = btn.closest('li, div.ng-star-inserted, .tree-node, div[class*="col-md"]');
        results.push({ btn, fileName, fileItem });
    });

    return results;
}

/**
 * Estrae metadati contestuali (parte, tipo_atto, data_atto, dimensione)
 * risalendo nell'albero DOM dal nodo file.
 */
function extractAttoMetadata(fileItem, fileName) {
    let data_atto = '';
    let parte = '';
    let tipo_parte = '';
    let nome_parte = '';
    let cf_parte   = '';
    let tipo_atto = '';
    let dimensione_str = '';
    let categoria = 'altro';

    if (!fileItem) return { parte, tipo_parte, nome_parte, cf_parte, tipo_atto, data_atto, dimensione: 0, categoria };

    // Dimensione: testo tra parentesi tipo "(280.54 Kb)" nel nodo file
    const sizeMatch = fileItem.textContent.match(/\([\d.,]+\s*(?:Kb|KB|Mb|MB|Gb|GB|b|B)\)/i);
    if (sizeMatch) dimensione_str = sizeMatch[0].replace(/[()]/g, '').trim();

    // Risali nell'albero per trovare nodo atto, nodo parte e categoria di primo livello
    let ancestor = fileItem.parentElement;
    let depth = 0;
    while (ancestor && depth < 20) {
        // Cerca solo il testo diretto del nodo (non dei figli profondi)
        const directSpan = ancestor.querySelector(':scope > span, :scope > a, :scope > div');
        const directText = directSpan ? directSpan.textContent.trim() : '';

        // Nodo atto: "Atto DD/MM/YYYY" o "Atto N. ..."
        if (!data_atto) {
            const attoMatch = directText.match(/Atto\s+(\d{2}\/\d{2}\/\d{4})/);
            if (attoMatch) {
                data_atto = attoMatch[1];
                tipo_atto = directText;
            }
        }

        // Nodo parte: "TIPO - NOME COGNOME (CF)" (es. AP, CS, CP, TP)
        if (!tipo_parte) {
            const parteMatch = directText.match(/^([A-Z]{1,3})\s*[-–]\s*(.+)/);
            if (parteMatch) {
                parte = directText;
                tipo_parte = parteMatch[1];
                const rest = parteMatch[2].trim();
                const cfMatch = rest.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
                if (cfMatch) {
                    nome_parte = cfMatch[1].trim();
                    cf_parte   = cfMatch[2].trim();
                } else {
                    nome_parte = rest;
                }
                // Un nodo "TIPO - NOME (CF)" esiste SOLO dentro il ramo
                // "Atti di Parte" (mai sotto "Provvedimenti di Ufficio").
                // Deduciamo quindi la categoria da questo, invece di fare
                // affidamento sul testo dell'intestazione superiore, che può
                // non essere raggiunto dal selettore ':scope > span, a, div'
                // se è marcato con un tag diverso (label/h*/strong) o se il
                // limite di risalita (depth<20) viene raggiunto prima.
                categoria = 'atti_di_parte';
            }
        }

        // Categoria di primo livello: "Atti di Parte" o "Provvedimenti di Ufficio"
        if (categoria === 'altro') {
            if (/atti\s+di\s+parte/i.test(directText)) {
                categoria = 'atti_di_parte';
            } else if (/provvedimenti/i.test(directText)) {
                categoria = 'provvedimenti_di_ufficio';
            }
        }

        ancestor = ancestor.parentElement;
        depth++;
    }

    return {
        parte,
        tipo_parte,
        nome_parte,
        cf_parte,
        tipo_atto,
        data_atto,
        dimensione: parseSize(dimensione_str),
        categoria,
    };
}

/**
 * Attende il segnale 'pct-interceptor-ready' dall'interceptor.js.
 * Se l'interceptor è già attivo (doppia iniezione evitata), risolve subito.
 * Timeout: 3 secondi, poi procede comunque.
 */
function waitForInterceptorReady() {
    return new Promise((resolve) => {
        const TIMEOUT_MS = 3000;
        let resolved = false;

        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                window.removeEventListener('message', handler);
                console.log('[PCT] waitForInterceptorReady: timeout, procedo comunque');
                resolve();
            }
        }, TIMEOUT_MS);

        function handler(event) {
            if (event.source !== window) return;
            if (!event.data || event.data.type !== 'pct-interceptor-ready') return;
            if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                window.removeEventListener('message', handler);
                console.log('[PCT] Interceptor pronto');
                resolve();
            }
        }

        window.addEventListener('message', handler);
    });
}

/**
 * Normalizza un nome file per il confronto tra content script e interceptor.
 * Rimuove prefissi descrittivi e normalizza spazi/lower-case.
 */
function normalizeFileName(name) {
    return (name || '')
        .toLowerCase()
        .trim()
        .replace(/^(originale|copia informatica|copia)\s+/i, '');
}

/**
 * Attende un messaggio postMessage di tipo 'pct-download-result' per un dato fileName.
 * Timeout: 30 secondi.
 * Restituisce { base64, mimeType } o null in caso di timeout.
 */
function waitForDownloadResult(expectedFileName) {
    return new Promise((resolve) => {
        const TIMEOUT_MS = 30000;
        let resolved = false;

        const finish = (value) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            clearInterval(abortPoll);
            window.removeEventListener('message', handler);
            resolve(value);
        };

        const timer = setTimeout(() => finish(null), TIMEOUT_MS);

        // Se l'utente preme "Ferma sincronizzazione" non restiamo appesi 30s:
        // sblocchiamo subito, il chiamante troverà il flag di abort al giro dopo.
        const abortPoll = setInterval(() => {
            if (pctIsSyncAborted()) finish(null);
        }, 200);

        function handler(event) {
            if (event.source !== window) return;
            const msg = event.data;
            if (!msg || msg.type !== 'pct-download-result') return;

            // Accetta il messaggio se il fileName corrisponde (o se è l'unico in attesa)
            const msgFile = normalizeFileName(msg.fileName);
            const expFile = normalizeFileName(expectedFileName);
            console.log('[PCT] waitForDownloadResult: atteso=', expFile, 'ricevuto=', msgFile);
            if (msgFile && expFile && msgFile !== expFile) return;

            finish({ base64: msg.base64, mimeType: msg.mimeType });
        }

        window.addEventListener('message', handler);
    });
}

/**
 * Scrapa l'albero degli atti e documenti.
 *
 * STRATEGIA PRINCIPALE (PdA Toscana con Angular):
 * I file NON hanno <a href>. I pulsanti download sono <a role="button"> con
 * click handler Angular che fa POST a downloadDocumento e poi crea un blob URL.
 *
 * Flusso:
 * 1) Inietta script interceptor nella pagina (monkey-patch URL.createObjectURL + XHR + fetch)
 * 2) Espandi tutti i nodi dell'albero
 * 3) Trova tutti i pulsanti download
 * 4) Per ogni pulsante, in sequenza:
 *    a) Segnala il fileName atteso all'interceptor (window.__pctWaitingFileName)
 *    b) Clicca il pulsante
 *    c) Attendi il postMessage con il blob in base64
 *    d) Aggiungi all'array atti con blob_b64 invece di url_download
 *
 * FALLBACK: se non ci sono pulsanti Angular, usa le strategie originali (a[href]).
 */
// ─── Scraping atti SIGP (Giudice di Pace) ────────────────────────────────────
/**
 * Scrapa la sezione "Atti e documenti" per le pagine SIGP (Giudice di Pace).
 *
 * Il DOM SIGP raggruppa i documenti per DATA in cartelle espandibili:
 *   <span class='outline' aria-label='Cartella' role='button'> con testo data (dd/mm/yyyy)
 *   I file dentro ogni cartella-data sono in div con ID tipo:
 *     attiParte_2025-08-22T17:25:47Z_div
 *
 * Per ogni cartella-data:
 *   1. Espande la cartella (click se chiusa)
 *   2. Scarica DatiAtto.xml.p7m PRIMA degli altri file
 *   3. Parsa il DatiAtto.xml per determinare tipo (atto di parte vs provvedimento)
 *      e la parte depositante (AP/CS con nome e CF)
 *   4. Calcola il subfolder target e lo aggiunge a ogni atto
 *
 * Ogni atto restituito ha un campo extra `subfolder` (stringa relativa a dir_name/)
 * che viene passato a api_upload_doc.php per il salvataggio nella posizione corretta.
 */
async function scrapeAttiSIGP(enumOnly = false) {
    // scrapeTab passa il panel come primo argomento; normalizziamo a boolean
    if (typeof enumOnly !== 'boolean') enumOnly = false;
    const atti = [];

    // In modalità enumOnly non servono download, ma l'interceptor è comunque
    // necessario per la FASE 2 successiva (lo inietta ora così è già pronto).
    injectDownloadInterceptor();
    if (!enumOnly) {
        await waitForInterceptorReady();
    }
    console.log('[PCT] scrapeAttiSIGP: interceptor pronto (enumOnly=' + enumOnly + ')');

    // ── Fast-path FASE 2 SIGP: usa i pulsanti già enumerati dalla FASE 1.5 ────
    // Se _enumeratedButtons è disponibile e non siamo in enumOnly, usa i DOM refs
    // salvati per evitare di rieseguire l'espansione delle cartelle-data.
    if (!enumOnly && _enumeratedButtons && _enumeratedButtons.length > 0) {
        console.log('[PCT] scrapeAttiSIGP FASE 2 fast-path: uso', _enumeratedButtons.length, 'stub da _enumeratedButtons');
        await waitForInterceptorReady();

        // Nome cartella-data: lo ricaviamo dal subfolder già calcolato nella FASE 1.5
        // (ultimo segmento). In questo modo la numerazione dei depositi con la stessa
        // data (_comp_1, _comp_2, ...) resta identica anche quando il pre-check
        // esclude alcuni file, evitando di spostare i documenti in cartelle sbagliate.
        const allStubs = _enumeratedButtons.filter(s => s._btn);
        const folderOf = (s) => {
            const fromSub = (s.subfolder || '').split('/').filter(Boolean).pop();
            if (fromSub) return fromSub;
            return s.data_atto ? s.data_atto.replace(/\//g, '-') : 'senza_data';
        };
        const isDatiAttoName = (n) => /datiatto[^.]*\.xml/i.test(n || '');

        // Pre-check incrementale: non riscarichiamo i file già presenti nel DB
        // e nella cartella documenti.
        let stubsToDownload = allStubs;
        if (_downloadPreCheckConfig && allStubs.length > 0) {
            const downloadedIdx = await pctPreCheckDownloaded(allStubs);
            if (downloadedIdx.size > 0) {
                // I DatiAtto.xml servono a calcolare il subfolder degli altri file
                // dello stesso deposito: li riscarichiamo solo se in quel deposito
                // c'è ancora almeno un file da scaricare.
                const gruppiDaScaricare = new Set();
                allStubs.forEach((s, i) => {
                    if (isDatiAttoName(s.nome_file)) return;
                    if (!downloadedIdx.has(i)) gruppiDaScaricare.add(folderOf(s));
                });
                stubsToDownload = allStubs.filter((s, i) => {
                    if (!downloadedIdx.has(i)) return true;
                    return isDatiAttoName(s.nome_file) && gruppiDaScaricare.has(folderOf(s));
                });
            }
            window.__pctPreCheckTotal   = allStubs.length;
            window.__pctPreCheckAlready = downloadedIdx.size;
            console.log('[PCT] SIGP fast-path pre-check:', allStubs.length, 'totali,',
                downloadedIdx.size, 'già presenti,', stubsToDownload.length, 'da scaricare');
            if (downloadedIdx.size > 0) {
                updateBannerStatus('Pre-check: ' + downloadedIdx.size + ' file già presenti, scarico ' + stubsToDownload.length + ' nuovi...');
            }
        }

        // Scarica i file usando i pulsanti DOM già trovati
        // Elabora in ordine DOM: parsa DatiAtto per determinare il subfolder,
        // poi scarica gli altri file dello stesso gruppo.
        const refIdToPartyInfo = {};
        const subfolderByDateFolder = {};
        const totalStubs = stubsToDownload.length;

        for (let si = 0; si < stubsToDownload.length; si++) {
            pctThrowIfAborted();
            const stub = stubsToDownload[si];
            const isDatiAtto = isDatiAttoName(stub.nome_file);
            const dateFolderName = folderOf(stub);

            const shortName = stub.nome_file.length > 35 ? stub.nome_file.substring(0, 35) + '...' : stub.nome_file;
            updateBannerStatus('SIGP fast-path ' + (si + 1) + '/' + totalStubs + ' ' + shortName);

            window.postMessage({ type: 'pct-set-waiting-file-name', fileName: stub.nome_file }, '*');
            const resultPromise = waitForDownloadResult(stub.nome_file);
            stub._btn.click();
            const result = await resultPromise;
            pctThrowIfAborted();

            if (isDatiAtto) {
                if (result && result.base64) {
                    const parsedSubfolder = await parseDatiAttoForSubfolder(result.base64, dateFolderName, refIdToPartyInfo);
                    if (parsedSubfolder) subfolderByDateFolder[dateFolderName] = parsedSubfolder;
                    atti.push({
                        parte:        '',
                        tipo_parte:   parsedSubfolder ? (parsedSubfolder.startsWith('atti_di_parte') ? 'AP' : 'PU') : '',
                        nome_parte:   '',
                        cf_parte:     '',
                        tipo_atto:    'DatiAtto',
                        data_atto:    stub.data_atto,
                        nome_file:    stub.nome_file,
                        dimensione:   0,
                        categoria:    parsedSubfolder && parsedSubfolder.startsWith('provvedimenti') ? 'provvedimenti_di_ufficio' : 'atti_di_parte',
                        url_download: '',
                        blob_b64:     result.base64,
                        mime_type:    result.mimeType || 'application/octet-stream',
                        subfolder:    parsedSubfolder || stub.subfolder || ('altro/' + dateFolderName),
                    });
                } else {
                    console.warn('[PCT] SIGP fast-path: timeout DatiAtto.xml per', stub.nome_file);
                }
                await waitAbortable(500);
            } else {
                const fileSubfolder = subfolderByDateFolder[dateFolderName] || stub.subfolder || ('altro/' + dateFolderName);
                const categoria = fileSubfolder && fileSubfolder.startsWith('provvedimenti')
                    ? 'provvedimenti_di_ufficio'
                    : 'atti_di_parte';
                atti.push({
                    parte:        stub.parte        || '',
                    tipo_parte:   stub.tipo_parte   || '',
                    nome_parte:   stub.nome_parte   || '',
                    cf_parte:     stub.cf_parte     || '',
                    tipo_atto:    stub.tipo_atto    || '',
                    data_atto:    stub.data_atto,
                    nome_file:    stub.nome_file,
                    dimensione:   stub.dimensione   || 0,
                    categoria:    categoria,
                    url_download: '',
                    blob_b64:     result ? result.base64 : '',
                    mime_type:    result ? (result.mimeType || 'application/octet-stream') : '',
                    subfolder:    fileSubfolder,
                });
                await waitAbortable(800);
            }
        }

        console.log('[PCT] scrapeAttiSIGP fast-path completato. Atti con blob:', atti.filter(a => a.blob_b64).length, '/ totale:', atti.length);
        return atti;
    }

    // ── Step 1: trova tutte le cartelle-data nel DOM ──────────────────────────
    // Polling: Angular potrebbe non aver ancora renderizzato il componente
    let folderSpans = [];
    for (let attempt = 0; attempt < 30; attempt++) {
        // Selettore permissivo: qualsiasi elemento cliccabile o .outline che contenga una data
        folderSpans = Array.from(document.querySelectorAll(
            '[role="button"], button, .outline, [aria-label*="Cartella" i]'
        )).filter(s => {
            // Accetta date nei figli diretti o nel testo proprio, con separatore / o -
            const txt = (s.textContent || '').trim();
            return /\d{2}[\/\-]\d{2}[\/\-]\d{4}/.test(txt);
        });
        if (folderSpans.length > 0) {
            console.log('[PCT] scrapeAttiSIGP: trovate', folderSpans.length, 'cartelle-data dopo', attempt * 500, 'ms');
            break;
        }
        await wait(500);
    }

    if (folderSpans.length === 0) {
        console.warn('[PCT] scrapeAttiSIGP: nessuna cartella-data trovata nel DOM SIGP');
        // Dump diagnostico
        const appAtti = document.querySelector('app-atti-documenti, [class*="atti"]');
        if (appAtti) {
            console.log('[PCT] scrapeAttiSIGP: app-atti-documenti innerHTML (500):', appAtti.innerHTML.replace(/\s+/g, ' ').substring(0, 500));
        }
        return atti;
    }

    // ── Step 2: itera ogni cartella-data ─────────────────────────────────────
    const dateFolderCount = {};   // deduplicazione nome cartella per data
    const refIdToPartyInfo = {};  // cache RefId -> etichetta parte per depositi collegati (es. DepositoComplementare)
    if (!enumOnly && _downloadPreCheckConfig) {
        window.__pctPreCheckTotal   = 0;
        window.__pctPreCheckAlready = 0;
    }
    for (let fi = 0; fi < folderSpans.length; fi++) {
        pctThrowIfAborted();
        const folderSpan = folderSpans[fi];
        const rawDate = (folderSpan.textContent || '').trim().match(/(\d{2}\/\d{2}\/\d{4})/);
        const dateStr = rawDate ? rawDate[1] : '';
        // Converti dd/mm/yyyy → dd-mm-yyyy per il nome cartella
        let dateFolderName = dateStr ? dateStr.replace(/\//g, '-') : 'senza_data';

        // Deduplicazione cartelle-data: primo deposito = 02-04-2026, successivi = 02-04-2026_comp_1, _comp_2...
        const originalDateFolderName = dateFolderName;
        if (!dateFolderCount[dateFolderName]) {
            dateFolderCount[dateFolderName] = 1;
        } else {
            dateFolderCount[dateFolderName]++;
            dateFolderName = dateFolderName + '_comp_' + (dateFolderCount[dateFolderName] - 1);
        }
        if (dateFolderCount[originalDateFolderName] > 1) {
            console.log('[PCT] scrapeAttiSIGP: data duplicata, rinominata cartella:', dateFolderName);
        }

        console.log('[PCT] scrapeAttiSIGP: cartella-data', fi + 1, '/', folderSpans.length, '→', dateStr);
        updateBannerStatus('SIGP: cartella ' + (fi + 1) + '/' + folderSpans.length + ' (' + dateStr + ')...');

        // Espandi la cartella se chiusa (cerca icona fa-folder-open o fa-folder)
        const folderIcon = folderSpan.querySelector('i.fa-folder, i.fa-folder-open, i[class*="folder"]');
        const isOpen = folderIcon && folderIcon.classList.contains('fa-folder-open');
        if (!isOpen) {
            folderSpan.click();
            await waitAbortable(800); // attendi rendering Angular
        }

        // Trova il contenitore dei file per questa cartella-data
        // I div dei file hanno ID tipo: attiParte_2025-08-22T17:25:47Z_div
        // oppure sono figli del nodo successivo al folderSpan nel DOM
        let fileContainer = null;

        // Strategia 1: cerca div con ID che contiene un timestamp ISO vicino al folderSpan
        const allDivs = Array.from(document.querySelectorAll('div[id*="attiParte_"], div[id*="atti_"]'));
        if (allDivs.length > 0) {
            // Prendi il div più vicino al folderSpan nel DOM (dopo di esso)
            // Usa compareDocumentPosition per trovare il div successivo
            let bestDiv = null;
            let bestPos = Infinity;
            for (const div of allDivs) {
                const pos = folderSpan.compareDocumentPosition(div);
                // DOCUMENT_POSITION_FOLLOWING = 4
                if (pos & 4) {
                    // Conta la distanza approssimativa (numero di nodi tra i due)
                    const range = document.createRange();
                    range.setStart(folderSpan, 0);
                    range.setEnd(div, 0);
                    const dist = range.toString().length;
                    if (dist < bestPos) {
                        bestPos = dist;
                        bestDiv = div;
                    }
                }
            }
            if (bestDiv) fileContainer = bestDiv;
        }

        // Strategia 2: cerca il nodo fratello/cugino successivo con ng-trigger
        if (!fileContainer) {
            let sibling = folderSpan.parentElement ? folderSpan.parentElement.nextElementSibling : null;
            for (let s = 0; s < 5 && sibling; s++) {
                if (sibling.hasAttribute('ng-trigger') || sibling.classList.contains('ng-trigger')) {
                    fileContainer = sibling;
                    break;
                }
                sibling = sibling.nextElementSibling;
            }
        }

        // Strategia 3: cerca nel parent del folderSpan
        if (!fileContainer) {
            const parent = folderSpan.closest('div, li');
            if (parent) {
                const nextSib = parent.nextElementSibling;
                if (nextSib) fileContainer = nextSib;
            }
        }

        if (!fileContainer) {
            console.warn('[PCT] scrapeAttiSIGP: nessun contenitore file trovato per cartella', dateStr);
            continue;
        }

        // ── Step 3: trova i pulsanti download nella cartella-data ────────────
        // Attendi che i pulsanti siano renderizzati
        let dlButtons = [];
        for (let attempt = 0; attempt < 10; attempt++) {
            dlButtons = findDownloadButtons(fileContainer);
            if (dlButtons.length > 0) break;
            // Prova anche nel document intero filtrando per posizione
            if (attempt === 5) {
                dlButtons = findDownloadButtons(document).filter(b => {
                    const pos = folderSpan.compareDocumentPosition(b.btn);
                    return (pos & 4); // FOLLOWING
                });
                if (dlButtons.length > 0) break;
            }
            await waitAbortable(400);
        }

        console.log('[PCT] scrapeAttiSIGP: cartella', dateStr, '→', dlButtons.length, 'pulsanti download');

        if (dlButtons.length === 0) {
            console.warn('[PCT] scrapeAttiSIGP: nessun pulsante download in cartella', dateStr);
            continue;
        }

        // ── Step 3b: deduplicazione nomi file nella cartella-data ────────────
        // Se più file hanno lo stesso fileName, rinomina dal secondo in poi
        // aggiungendo _N prima della prima estensione (es. DatiAtto_2.xml.p7m)
        {
            const nameCount = {};
            for (const b of dlButtons) {
                const orig = b.fileName;
                if (nameCount[orig] === undefined) {
                    nameCount[orig] = 1;
                } else {
                    nameCount[orig]++;
                    const n = nameCount[orig];
                    // Inserisce _N prima del primo punto (prima estensione)
                    const dotIdx = orig.indexOf('.');
                    const newName = dotIdx === -1
                        ? orig + '_' + n
                        : orig.slice(0, dotIdx) + '_' + n + orig.slice(dotIdx);
                    console.log('[PCT] scrapeAttiSIGP: rinomina duplicato', orig, '→', newName, '(occorrenza', n, ')');
                    b.fileName = newName;
                }
            }
        }

        // ── Step 3c: pre-check incrementale ─────────────────────────────────
        // Prima di cliccare, chiede al backend quali file di questa cartella-data
        // sono già nel DB e sulla cartella documenti, così da non riscaricarli.
        if (!enumOnly && _downloadPreCheckConfig && dlButtons.length > 0) {
            const items = dlButtons.map(b => ({ nome_file: b.fileName, data_atto: dateStr }));
            const downloadedIdx = await pctPreCheckDownloaded(items);
            window.__pctPreCheckTotal   = (window.__pctPreCheckTotal   || 0) + dlButtons.length;
            window.__pctPreCheckAlready = (window.__pctPreCheckAlready || 0) + downloadedIdx.size;
            if (downloadedIdx.size > 0) {
                const isDatiAttoName = (n) => /datiatto[^.]*\.xml/i.test(n || '');
                const mancanti = dlButtons.filter((b, i) =>
                    !isDatiAttoName(b.fileName) && !downloadedIdx.has(i)
                );
                if (mancanti.length === 0) {
                    console.log('[PCT] scrapeAttiSIGP: cartella', dateStr, 'già completa (',
                        downloadedIdx.size, 'file presenti) → skip');
                    updateBannerStatus('Cartella ' + dateStr + ' già presente, salto...');
                    continue;
                }
                // I DatiAtto.xml restano: servono a calcolare il subfolder dei file mancanti.
                dlButtons = dlButtons.filter((b, i) =>
                    isDatiAttoName(b.fileName) || !downloadedIdx.has(i)
                );
                console.log('[PCT] scrapeAttiSIGP: cartella', dateStr, '→', downloadedIdx.size,
                    'già presenti,', mancanti.length, 'da scaricare');
            }
        }

        // ── Step 4: scarica TUTTI i DatiAtto.xml PRIMA degli altri ──────────
        // Identifica tutti i pulsanti DatiAtto.xml (case-insensitive)
        const datiAttoBtns = dlButtons.filter(b =>
            /datiatto[^.]*\.xml/i.test(b.fileName)
        );

        let subfolder = null; // verrà calcolato dopo il parsing dell'ultimo DatiAtto.xml valido

        if (enumOnly) {
            // ── Modalità enumOnly: raccogli stub senza scaricare ────────────
            // Aggiungi tutti i pulsanti (DatiAtto + altri) come stub con riferimenti DOM
            for (const b of dlButtons) {
                const meta = extractAttoMetadata(b.fileItem, b.fileName);
                const guessedSubfolder = guessSubfolderByFilename(b.fileName, dateFolderName);
                atti.push({
                    // Riferimenti DOM (usati dalla FASE 2 per evitare doppia espansione)
                    _btn:        b.btn,
                    _fileItem:   b.fileItem,
                    _folderSpan: folderSpan,
                    // Metadati
                    parte:        meta.parte        || '',
                    tipo_parte:   meta.tipo_parte   || '',
                    nome_parte:   meta.nome_parte   || '',
                    cf_parte:     meta.cf_parte     || '',
                    tipo_atto:    meta.tipo_atto    || '',
                    data_atto:    dateStr,
                    nome_file:    b.fileName,
                    dimensione:   meta.dimensione   || 0,
                    categoria:    meta.categoria    || 'atti_di_parte',
                    url_download: '',
                    blob_b64:     '',
                    mime_type:    '',
                    subfolder:    guessedSubfolder || ('altro/' + dateFolderName),
                });
            }
            console.log('[PCT] scrapeAttiSIGP enumOnly: cartella', dateStr, '→', dlButtons.length, 'stub aggiunti');
        } else {
            // ── Modalità normale: scarica DatiAtto.xml poi gli altri ────────
            if (datiAttoBtns.length > 0) {
                console.log('[PCT] scrapeAttiSIGP: trovati', datiAttoBtns.length, 'DatiAtto.xml per', dateStr);
                for (const datiAttoBtn of datiAttoBtns) {
                    pctThrowIfAborted();
                    console.log('[PCT] scrapeAttiSIGP: scarico DatiAtto.xml per', dateStr, '→', datiAttoBtn.fileName);
                    window.postMessage({ type: 'pct-set-waiting-file-name', fileName: datiAttoBtn.fileName }, '*');
                    const datiAttoPromise = waitForDownloadResult(datiAttoBtn.fileName);
                    datiAttoBtn.btn.click();
                    const datiAttoResult = await datiAttoPromise;
                    pctThrowIfAborted();

                    if (datiAttoResult && datiAttoResult.base64) {
                        // Parsa il DatiAtto.xml in-memory per determinare il subfolder
                        const parsedSubfolder = await parseDatiAttoForSubfolder(datiAttoResult.base64, dateFolderName, refIdToPartyInfo);
                        if (parsedSubfolder) {
                            subfolder = parsedSubfolder; // aggiorna con l'ultimo parsing riuscito
                            console.log('[PCT] scrapeAttiSIGP: subfolder calcolato da', datiAttoBtn.fileName, ':', subfolder);
                        } else {
                            console.warn('[PCT] scrapeAttiSIGP: parsing subfolder fallito per', datiAttoBtn.fileName, '- subfolder corrente:', subfolder);
                            // Fallback: se ancora null, prova a ricavarlo dal contesto DOM
                            if (!subfolder) {
                                const domMeta = extractAttoMetadata(datiAttoBtn.fileItem, datiAttoBtn.fileName);
                                if (domMeta.categoria === 'provvedimenti_di_ufficio') {
                                    subfolder = 'provvedimenti_di_ufficio/' + dateFolderName;
                                } else if (domMeta.tipo_parte && domMeta.nome_parte) {
                                    const label = domMeta.tipo_parte + ' - ' + domMeta.nome_parte + (domMeta.cf_parte ? ' (' + domMeta.cf_parte + ')' : '');
                                    subfolder = 'atti_di_parte/' + label.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() + '/' + dateFolderName;
                                } else {
                                    subfolder = guessSubfolderByFilename(datiAttoBtn.fileName, dateFolderName);
                                }
                                console.log('[PCT] scrapeAttiSIGP: fallback subfolder da DOM per', datiAttoBtn.fileName, ':', subfolder);
                            }
                        }

                        // Aggiungi DatiAtto.xml agli atti
                        atti.push({
                            parte:        '',
                            tipo_parte:   subfolder ? (subfolder.startsWith('atti_di_parte') ? 'AP' : 'PU') : '',
                            nome_parte:   '',
                            cf_parte:     '',
                            tipo_atto:    'DatiAtto',
                            data_atto:    dateStr,
                            nome_file:    datiAttoBtn.fileName,
                            dimensione:   0,
                            categoria:    subfolder && subfolder.startsWith('provvedimenti') ? 'provvedimenti_di_ufficio' : 'atti_di_parte',
                            url_download: '',
                            blob_b64:     datiAttoResult.base64,
                            mime_type:    datiAttoResult.mimeType || 'application/octet-stream',
                            subfolder:    subfolder || ('altro/' + dateFolderName),
                        });
                    } else {
                        console.warn('[PCT] scrapeAttiSIGP: timeout DatiAtto.xml per', dateStr, '→', datiAttoBtn.fileName);
                    }
                    await waitAbortable(500);
                }
            }

            // ── Step 5: scarica gli altri file della cartella-data ───────────────
            const otherButtons = dlButtons.filter(b => !/datiatto[^.]*\.xml/i.test(b.fileName));
            const totalOther = otherButtons.length;

            for (let bi = 0; bi < otherButtons.length; bi++) {
                pctThrowIfAborted();
                const { btn, fileName, fileItem } = otherButtons[bi];
                const shortName = fileName.length > 35 ? fileName.substring(0, 35) + '...' : fileName;
                updateBannerStatus('SIGP ' + dateStr + ': ' + (bi + 1) + '/' + totalOther + ' ' + shortName);

                // Determina il subfolder per questo file (usa quello calcolato dal DatiAtto.xml)
                // Se non disponibile, usa euristica sul nome file
                let fileSubfolder = subfolder;
                if (!fileSubfolder) {
                    fileSubfolder = guessSubfolderByFilename(fileName, dateFolderName);
                }

                window.postMessage({ type: 'pct-set-waiting-file-name', fileName }, '*');
                const resultPromise = waitForDownloadResult(fileName);
                btn.click();
                const result = await resultPromise;
                pctThrowIfAborted();

                const meta = extractAttoMetadata(fileItem, fileName);
                const categoria = fileSubfolder && fileSubfolder.startsWith('provvedimenti')
                    ? 'provvedimenti_di_ufficio'
                    : 'atti_di_parte';

                atti.push({
                    parte:        meta.parte        || '',
                    tipo_parte:   meta.tipo_parte   || '',
                    nome_parte:   meta.nome_parte   || '',
                    cf_parte:     meta.cf_parte     || '',
                    tipo_atto:    meta.tipo_atto    || '',
                    data_atto:    dateStr,
                    nome_file:    fileName,
                    dimensione:   meta.dimensione   || 0,
                    categoria:    categoria,
                    url_download: '',
                    blob_b64:     result ? result.base64 : '',
                    mime_type:    result ? (result.mimeType || 'application/octet-stream') : '',
                    subfolder:    fileSubfolder || ('altro/' + dateFolderName),
                });

                await waitAbortable(800);
            }
        } // fine else (modalità normale)
    }

    console.log('[PCT] scrapeAttiSIGP: completato (enumOnly=' + enumOnly + '). Atti totali:', atti.length,
        '| con blob:', atti.filter(a => a.blob_b64).length);
    return atti;
}

/**
 * Parsa il base64 di un DatiAtto.xml (o DatiAtto.xml.p7m) per determinare
 * il subfolder di destinazione.
 *
 * Restituisce una stringa relativa a dir_name/, es.:
 *   "atti_di_parte/AP - Mario Rossi (RSSMRA80A01H501Z)/22-08-2025"
 *   "provvedimenti_di_ufficio/22-08-2025"
 *
 * Se il parsing fallisce, restituisce null (il chiamante userà un fallback).
 */
async function parseDatiAttoForSubfolder(base64Data, dateFolderName, refIdToPartyInfo) {
    try {
        // Decodifica base64 → stringa
        const rawBinary = atob(base64Data);
        // Alcuni p7m (tipico SIGP) incapsulano l'XML in un OCTET STRING "costruito"
        // a blocchi: ogni ~1000 byte c'e' un header DER (tag 0x04 + lunghezza) che
        // finisce anche dentro i tag e rompe il parsing. Qui si rimuovono (il tag
        // 0x04 non compare mai nel testo XML valido). Per i p7m SICID (OCTET STRING
        // contiguo) e' un no-op.
        const xmlStart0 = rawBinary.indexOf('<?xml');
        let binary = rawBinary;
        if (xmlStart0 > 0) {
            let out = '';
            for (let k = xmlStart0; k < rawBinary.length;) {
                const c = rawBinary.charCodeAt(k) & 0xff;
                if (c === 0x04) {
                    const n = rawBinary.charCodeAt(k + 1) & 0xff;
                    if (n === 0x81) { k += 3; continue; }
                    if (n === 0x82) { k += 4; continue; }
                    if (n === 0x83) { k += 5; continue; }
                    if (n < 0x80) { k += 2; continue; }
                    k += 1; continue;
                }
                out += rawBinary[k]; k++;
            }
            binary = out;
        }
        let xmlStr = binary;

        // Se è un P7M, prova a estrarre il payload XML cercando il tag <?xml
        // I P7M SIGP spesso contengono l'XML in chiaro come payload CMS
        const xmlStart = binary.indexOf('<?xml');
        if (xmlStart > 0) {
            xmlStr = binary.substring(xmlStart);

            // Trova il primo tag root (es. <atto ...> o <DatiAtto ...>)
            const rootMatch = xmlStr.match(/<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>/);
            if (rootMatch) {
                const rootTag = rootMatch[1];
                const tagRegex = new RegExp('<(' + rootTag + ')(?:\\s[^>]*)?>|<\\/(' + rootTag + ')>', 'g');
                let depth = 0;
                let match;
                let endPos = -1;
                while ((match = tagRegex.exec(xmlStr)) !== null) {
                    if (match[1]) {
                        depth++;
                    } else {
                        depth--;
                        if (depth === 0) {
                            endPos = match.index + match[0].length;
                            break;
                        }
                    }
                }
                if (endPos > 0) {
                    xmlStr = xmlStr.substring(0, endPos);
                }
            }
        }

        // Sanifica caratteri di controllo non validi in XML
        xmlStr = xmlStr.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

        // Parsa l'XML
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlStr, 'application/xml');
        const parseError = doc.querySelector('parsererror');
        if (parseError) {
            console.warn('[PCT] parseDatiAttoForSubfolder: errore parsing XML:', parseError.textContent.substring(0, 100));
            return null;
        }

        const root = doc.documentElement;
        const rootName = root.localName || root.nodeName || '';
        const rootNs = root.namespaceURI || '';

        console.log('[PCT] parseDatiAttoForSubfolder: root=<' + rootName + '> ns=' + rootNs.substring(0, 60));

        // Estrai RefId (attributo root o elemento figlio) per collegare depositi correlati
        const refIdAttr = root.getAttribute('RefId') || root.getAttribute('refId') || root.getAttribute('refid');
        const refIdEl = Array.from(root.querySelectorAll('*')).find(el =>
            (el.localName || '').toLowerCase() === 'refid'
        );
        const refId = (refIdAttr || (refIdEl ? refIdEl.textContent : '')).trim();

        // Determina tipo: provvedimento o atto di parte
        const nsLower = rootNs.toLowerCase();
        const rootLower = rootName.toLowerCase();
        const isProvvedimento =
            nsLower.includes('sigp/giudice') ||
            nsLower.includes('sigp/provvedimenti') ||
            ['decreto', 'ordinanza', 'sentenza', 'provvedimento'].includes(rootLower);

        if (isProvvedimento) {
            return 'provvedimenti_di_ufficio/' + dateFolderName;
        }

        // Atto di parte: estrai parte principale (AP) e controparti (CS)
        // Cerca nodi Parte e ControParte con qualsiasi namespace
        const allElements = Array.from(root.querySelectorAll('*'));

        // Helper: cerca un elemento per localName (ignora namespace)
        const findByLocal = (localName) =>
            allElements.find(el => (el.localName || el.nodeName || '').toLowerCase() === localName.toLowerCase());

        // Cerca Partecipanti → Parte
        const parteNode = findByLocal('Parte');
        let parteLabel = null;

        if (parteNode) {
            const denom = (findByLocal('denominazione') || {}).textContent || '';
            const nome  = (findByLocal('nome') || {}).textContent || '';
            const cf    = (findByLocal('codiceFiscale') || {}).textContent || '';

            // Cerca dentro parteNode specificamente
            const denomEl = Array.from(parteNode.querySelectorAll('*')).find(el =>
                (el.localName || '').toLowerCase() === 'denominazione'
            );
            const nomeEl = Array.from(parteNode.querySelectorAll('*')).find(el =>
                (el.localName || '').toLowerCase() === 'nome'
            );
            const cfEl = Array.from(parteNode.querySelectorAll('*')).find(el =>
                (el.localName || '').toLowerCase() === 'codicefiscale'
            );

            const denomStr = denomEl ? denomEl.textContent.trim() : denom.trim();
            const nomeStr  = nomeEl  ? nomeEl.textContent.trim()  : nome.trim();
            const cfStr    = cfEl    ? cfEl.textContent.trim()    : cf.trim();

            if (nomeStr) {
                // Persona fisica: denominazione=cognome, nome=nome
                const cognome = toTitleCase(denomStr);
                const nomeF   = toTitleCase(nomeStr);
                parteLabel = 'AP - ' + cognome + ' ' + nomeF + (cfStr ? ' (' + cfStr + ')' : '');
            } else if (denomStr) {
                parteLabel = 'AP - ' + denomStr + (cfStr ? ' (' + cfStr + ')' : '');
            }
        }

        if (parteLabel) {
            // Sanifica per filesystem
            parteLabel = parteLabel.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
            if (refId) {
                // Memorizza solo l'etichetta parte: il nome data viene aggiunto dal chiamante
                refIdToPartyInfo[refId] = parteLabel;
                console.log('[PCT] parseDatiAttoForSubfolder: cache RefId', refId, '->', parteLabel);
            }
            return 'atti_di_parte/' + parteLabel + '/' + dateFolderName;
        }

        // Deposito collegato (es. DepositoComplementare) senza anagrafica: prova a recuperare la parte dal RefId
        if (refId && refIdToPartyInfo[refId]) {
            const cachedLabel = refIdToPartyInfo[refId];
            console.log('[PCT] parseDatiAttoForSubfolder: deposito collegato RefId', refId, '-> parte cached', cachedLabel);
            return 'atti_di_parte/' + cachedLabel + '/' + dateFolderName;
        }

        // Fallback: atti_di_parte senza parte identificata
        return 'atti_di_parte/senza_parte/' + dateFolderName;

    } catch (e) {
        console.warn('[PCT] parseDatiAttoForSubfolder: eccezione:', e.message);
        return null;
    }
}

/**
 * Euristica: determina il subfolder in base al nome del file.
 * Usato quando DatiAtto.xml non è disponibile o non è stato parsato.
 */
function guessSubfolderByFilename(fileName, dateFolderName) {
    const lower = fileName.toLowerCase();
    if (/decreto|ordinanza|sentenza|provvedimento|comunicazione/i.test(lower)) {
        return 'provvedimenti_di_ufficio/' + dateFolderName;
    }
    return 'atti_di_parte/senza_parte/' + dateFolderName;
}

/**
 * Converte una stringa in Title Case (prima lettera di ogni parola maiuscola).
 */
function toTitleCase(str) {
    return str.replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
}

// ─── Scraping atti (SICID + SIGP dispatcher) ──────────────────────────────────
async function scrapeAtti(enumOnly = false) {
    // scrapeTab passa il panel come primo argomento; normalizziamo a boolean
    if (typeof enumOnly !== 'boolean') enumOnly = false;
    // ── Ramo SIGP (Giudice di Pace): DOM Angular completamente diverso ────────
    if (isGdP()) {
        console.log('[PCT] scrapeAtti: pagina SIGP rilevata → uso scrapeAttiSIGP(enumOnly=' + enumOnly + ')');
        return await scrapeAttiSIGP(enumOnly);
    }

    // ── Ramo SICID (Tribunale Ordinario): logica originale ────────────────────
    const atti = [];
    const activeArea = getActiveTabContent();
    const searchRoot = activeArea || document;
    console.log('[PCT] scrapeAtti: START — searchRoot =', activeArea ? (activeArea.tagName + (activeArea.id ? '#' + activeArea.id : '') + (activeArea.className ? '.' + String(activeArea.className).trim().replace(/\s+/g, '.').substring(0, 40) : '')) : 'document (fallback)');

    // ── Fast-path FASE 2: usa i pulsanti già enumerati dalla FASE 1.5 ─────────
    // Se _enumeratedButtons è disponibile, i pulsanti sono già nel DOM (stesso tab)
    // e non serve rieseguire l'espansione dell'albero Angular.
    if (!enumOnly && _enumeratedButtons && _enumeratedButtons.length > 0) {
        console.log('[PCT] scrapeAtti FASE 2 fast-path: uso', _enumeratedButtons.length, 'pulsanti da _enumeratedButtons');
        injectDownloadInterceptor();
        await waitForInterceptorReady();

        // Ricostruisce downloadButtons dai riferimenti DOM salvati.
        // NOTA: manteniamo anche i metadati (parte, categoria, ...) già
        // calcolati durante l'enumerazione (Fase 1.5): NON vanno ricalcolati
        // qui dal DOM. Se tra Fase 1.5 e Fase 2 l'albero Angular si è
        // ulteriormente espanso o riordinato, il nodo DOM salvato può risalire
        // a un ramo diverso (es. finire sotto "Provvedimenti di Ufficio"
        // invece che sotto la parte corretta) anche se al momento
        // dell'enumerazione la parte era stata individuata giusta. Riusare i
        // metadati già noti evita l'errore per qualsiasi fascicolo, non solo
        // per questo caso.
        let stubs = _enumeratedButtons.filter(s => s._btn);

        // Pre-check incrementale: salta i file già presenti nel DB e su disco
        if (_downloadPreCheckConfig && stubs.length > 0) {
            const totale        = stubs.length;
            const downloadedIdx = await pctPreCheckDownloaded(stubs);
            window.__pctPreCheckTotal   = totale;
            window.__pctPreCheckAlready = downloadedIdx.size;
            stubs = stubs.filter((s, i) => !downloadedIdx.has(i));
            console.log('[PCT] Fast-path pre-check:', totale, 'totali,',
                downloadedIdx.size, 'già presenti,', stubs.length, 'da scaricare');
            if (downloadedIdx.size > 0) {
                updateBannerStatus('Pre-check: ' + downloadedIdx.size + ' file già presenti, scarico ' + stubs.length + ' nuovi...');
            }
        }

        const downloadButtons = stubs.map(s => ({
            btn: s._btn, fileName: s.nome_file, fileItem: s._fileItem, stub: s,
        }));

        const totalButtons = downloadButtons.length;
        let dlIndex = 0;
        for (const { btn, fileName, stub } of downloadButtons) {
            pctThrowIfAborted();
            const meta = {
                parte: stub.parte, tipo_parte: stub.tipo_parte, nome_parte: stub.nome_parte,
                cf_parte: stub.cf_parte, tipo_atto: stub.tipo_atto, data_atto: stub.data_atto,
                dimensione: stub.dimensione, categoria: stub.categoria,
            };
            const shortName = fileName.length > 35 ? fileName.substring(0, 35) + '...' : fileName;
            updateBannerStatus('Download ' + (dlIndex + 1) + '/' + totalButtons + ': ' + shortName);
            updateBannerProgress(dlIndex + 1, totalButtons);
            console.log('[PCT] scrapeAtti fast-path: download', (dlIndex + 1) + '/' + totalButtons, '→', fileName);

            window.postMessage({ type: 'pct-set-waiting-file-name', fileName }, '*');
            const resultPromise = waitForDownloadResult(fileName);
            btn.click();
            const result = await resultPromise;
            pctThrowIfAborted();

            if (result && result.base64) {
                atti.push({
                    parte:        meta.parte,
                    tipo_parte:   meta.tipo_parte,
                    nome_parte:   meta.nome_parte,
                    cf_parte:     meta.cf_parte,
                    tipo_atto:    meta.tipo_atto,
                    data_atto:    meta.data_atto,
                    nome_file:    fileName,
                    dimensione:   meta.dimensione,
                    categoria:    meta.categoria,
                    url_download: '',
                    blob_b64:     result.base64,
                    mime_type:    result.mimeType || 'application/octet-stream',
                });
            } else {
                console.warn('[PCT] Fast-path TIMEOUT download per', fileName);
                atti.push({
                    parte:        meta.parte,
                    tipo_parte:   meta.tipo_parte,
                    nome_parte:   meta.nome_parte,
                    cf_parte:     meta.cf_parte,
                    tipo_atto:    meta.tipo_atto,
                    data_atto:    meta.data_atto,
                    nome_file:    fileName,
                    dimensione:   meta.dimensione,
                    categoria:    meta.categoria,
                    url_download: '',
                    blob_b64:     '',
                    mime_type:    '',
                });
            }
            await waitAbortable(1000);
            dlIndex++;
        }
        console.log('[PCT] scrapeAtti fast-path completato. Atti con blob:', atti.filter(a => a.blob_b64).length, '/ totale:', atti.length);
        return atti;
    }

    // Log diagnostico: quanti elementi con role="button" e icone download ci sono già?
    const preCheckBtns = document.querySelectorAll('[role="button"] i[title*="Download"], [role="button"] i.fa-file-archive-o, [role="button"] i.fa-download');
    const preCheckLinks = document.querySelectorAll('a[role="button"]');
    const preCheckIcons = document.querySelectorAll('i.fa-caret-right, i.fa-caret-down, i.fa-folder, i.fa-file');
    console.log('[PCT] scrapeAtti: DOM pre-expand → a[role=button]:', preCheckLinks.length,
        '| icone download:', preCheckBtns.length,
        '| icone albero (caret/folder/file):', preCheckIcons.length);

    // Inietta l'interceptor nella pagina (idempotente) e attendi il segnale "ready"
    injectDownloadInterceptor();
    await waitForInterceptorReady(); // attendi che lo script sia eseguito e pronto
    console.log('[PCT] scrapeAtti: interceptor pronto');

    // Forza l'espansione dei nodi di primo livello (es. "Provvedimenti di Ufficio", "Altri Atti")
    // che Angular non renderizza finché non vengono cliccati esplicitamente.
    console.log('[PCT] scrapeAtti: avvio expandFirstLevelNodes...');
    await expandFirstLevelNodes(document);
    console.log('[PCT] scrapeAtti: expandFirstLevelNodes completato');

    // Espandi tutti i nodi dell'albero prima di fare lo scraping
    console.log('[PCT] scrapeAtti: avvio expandAttiTree...');
    await expandAttiTree(document);
    console.log('[PCT] scrapeAtti: expandAttiTree completato');
    // Attesa extra per il rendering Angular dopo l'espansione
    await waitAbortable(800);

    // Log diagnostico post-espansione
    const postExpandBtns = document.querySelectorAll('[role="button"] i[title*="Download"], [role="button"] i.fa-file-archive-o, [role="button"] i.fa-download');
    const postExpandLinks = document.querySelectorAll('a[role="button"]');
    console.log('[PCT] scrapeAtti: DOM post-expand → a[role=button]:', postExpandLinks.length,
        '| icone download:', postExpandBtns.length);

    // Dump dei titoli delle icone download trovate (max 10)
    const iconTitles = Array.from(postExpandBtns).slice(0, 10).map(i => i.getAttribute('title') || '(no title)');
    if (iconTitles.length > 0) {
        console.log('[PCT] scrapeAtti: titoli icone download (max 10):', iconTitles);
    } else {
        // Dump diagnostico: cerca qualsiasi elemento con "title" che contiene "download" o "copia"
        const anyDlTitle = Array.from(document.querySelectorAll('[title]'))
            .filter(e => /download|copia\s+informatica/i.test(e.getAttribute('title') || ''))
            .slice(0, 10)
            .map(e => e.tagName + '[' + e.getAttribute('title') + ']');
        console.log('[PCT] scrapeAtti: nessuna icona download trovata. Elementi con title "download/copia":', anyDlTitle);

        // Dump struttura albero atti: cerca li, ul, tree-node
        const treeNodes = document.querySelectorAll('li.ng-star-inserted, ul.ng-star-inserted, tree-node, .tree-node, [class*="tree"]');
        console.log('[PCT] scrapeAtti: nodi albero (li/ul/tree-node):', treeNodes.length);
        if (treeNodes.length > 0) {
            const treeSnap = Array.from(treeNodes).slice(0, 5).map(n => n.tagName + '.' + String(n.className).trim().replace(/\s+/g, '.').substring(0, 40) + ': "' + (n.textContent || '').trim().substring(0, 60) + '"');
            console.log('[PCT] scrapeAtti: primi nodi albero:', treeSnap);
        }

        // Dump innerHTML del pannello atti (se trovato)
        const attiPanel = document.querySelector('app-dettaglio-fascicolo-atti, [class*="atti"], [id*="atti"]');
        if (attiPanel) {
            console.log('[PCT] scrapeAtti: pannello atti trovato:', attiPanel.tagName, '| innerHTML (500 chars):', attiPanel.innerHTML.replace(/\s+/g, ' ').substring(0, 500));
        } else {
            console.log('[PCT] scrapeAtti: nessun pannello atti (app-dettaglio-fascicolo-atti) trovato nel DOM');
        }
    }

    // Polling: aspetta che Angular renderizzi tutti i pulsanti download
    // dopo l'espansione dell'albero. I Provvedimenti di Ufficio potrebbero
    // avere un rendering asincrono dei pulsanti.
    let stableCount = 0;
    let lastButtonCount = 0;
    for (let pollAttempt = 0; pollAttempt < 15; pollAttempt++) {
        const currentButtons = findDownloadButtons(document);
        console.log('[PCT] scrapeAtti polling: tentativo', pollAttempt + 1, '→', currentButtons.length, 'pulsanti');
        if (currentButtons.length > lastButtonCount) {
            // Nuovi pulsanti apparsi, resetta il contatore di stabilita'
            lastButtonCount = currentButtons.length;
            stableCount = 0;
        } else {
            stableCount++;
        }
        // Stabile per 3 iterazioni consecutive (1.5s senza nuovi pulsanti)
        if (stableCount >= 3 && lastButtonCount > 0) {
            console.log('[PCT] scrapeAtti polling: stabilizzato a', lastButtonCount, 'pulsanti dopo', pollAttempt + 1, 'tentativi');
            break;
        }
        await waitAbortable(500);
    }

    // Verifica quanti pulsanti download sono visibili dopo la prima espansione.
    // Log diagnostico per categoria.
    let downloadButtonsCheck = findDownloadButtons(document);
    const hasProvvedimenti = Array.from(document.querySelectorAll('*')).some(el => {
        const txt = (el.textContent || '').trim();
        return txt.length < 60 && /provvediment/i.test(txt);
    });
    const provvButtonsCheck = downloadButtonsCheck.filter(b => {
        const meta = extractAttoMetadata(b.fileItem, b.fileName);
        return meta.categoria === 'provvedimenti_di_ufficio';
    });
    console.log('[PCT] scrapeAtti: dopo expandAttiTree → downloadButtons totali:', downloadButtonsCheck.length,
        '| provvedimenti:', provvButtonsCheck.length,
        '| hasProvvedimenti nel DOM:', hasProvvedimenti);
    // NOTA: il fallback fa-caret-down è stato RIMOSSO perché controproducente:
    // nel PdA fa-caret-down indica nodi GIÀ APERTI, cliccarlo li chiude.

    // ── Strategia principale: pulsanti Angular <a role="button"> ────────────
    // Retry con polling: Angular potrebbe non aver ancora renderizzato l'albero
    let downloadButtons = findDownloadButtons(searchRoot);
    // Se searchRoot non ha risultati, prova nell'intero document
    if (downloadButtons.length === 0 && searchRoot !== document) {
        console.log('[PCT] scrapeAtti: 0 pulsanti in searchRoot, provo in document...');
        downloadButtons = findDownloadButtons(document);
    }
    if (downloadButtons.length === 0) {
        console.log('[PCT] scrapeAtti: 0 pulsanti al primo tentativo, retry con polling...');
        // Log diagnostico: cosa c'è nel document?
        const allLinks = document.querySelectorAll('a[role="button"]');
        const allIconsDl = document.querySelectorAll('i[title*="Download"], i.fa-file-archive-o, i.fa-download');
        const allSpanDl = document.querySelectorAll('span[title*="Download"], span.btn');
        const allTitles = Array.from(document.querySelectorAll('[title]')).filter(e => e.title.toLowerCase().includes('download')).slice(0, 10).map(e => e.tagName + ': ' + e.title);
        console.log('[PCT] Diagnostica DOM (document): a[role=button]:', allLinks.length,
            '| icone download:', allIconsDl.length,
            '| span download:', allSpanDl.length,
            '| elementi con title "download":', allTitles);
        for (let attempt = 1; attempt <= 5; attempt++) {
            await waitAbortable(2000);
            downloadButtons = findDownloadButtons(document);
            console.log('[PCT] scrapeAtti: tentativo', attempt, '→', downloadButtons.length, 'pulsanti');
            if (downloadButtons.length > 0) break;
        }
    }
    console.log('[PCT] scrapeAtti: trovati', downloadButtons.length, 'pulsanti download Angular');

    // === Pre-check download incrementale ================================================
    // Avviene QUI, PRIMA dei click sui pulsanti, così da non scaricare file già presenti
    // nel DB e nella cartella documenti.
    // _downloadPreCheckConfig viene impostato da handleSyncClick prima di chiamare scrapeAtti.
    if (_downloadPreCheckConfig && downloadButtons.length > 0) {
        // Il nome file da solo non basta: serve la data dell'atto per distinguere
        // documenti omonimi appartenenti a depositi diversi.
        const items = downloadButtons.map(b => {
            const meta = extractAttoMetadata(b.fileItem, b.fileName);
            return { nome_file: b.fileName, data_atto: (meta && meta.data_atto) || '' };
        });
        const totale        = downloadButtons.length;
        const downloadedIdx = await pctPreCheckDownloaded(items);
        downloadButtons = downloadButtons.filter((b, i) => !downloadedIdx.has(i));
        // Salva conteggio pre-check per il messaggio finale
        window.__pctPreCheckTotal   = totale;
        window.__pctPreCheckAlready = downloadedIdx.size;
        console.log('[PCT] Pre-check:', totale, 'file totali,',
            downloadedIdx.size, 'già presenti,', downloadButtons.length, 'da scaricare');
        if (downloadedIdx.size > 0) {
            updateBannerStatus('Pre-check: ' + downloadedIdx.size + ' file già presenti, scarico ' + downloadButtons.length + ' nuovi...');
        }
    }
    // ====================================================================================

    // ── Modalità enumOnly (SICID): restituisce stub con riferimenti DOM ──────
    if (enumOnly) {
        console.log('[PCT] scrapeAtti enumOnly: raccolta', downloadButtons.length, 'stub SICID senza download');
        for (const { btn, fileName, fileItem } of downloadButtons) {
            const meta = extractAttoMetadata(fileItem, fileName);
            atti.push({
                // Riferimenti DOM (usati dalla FASE 2 per evitare doppia espansione)
                _btn:      btn,
                _fileItem: fileItem,
                // Metadati
                parte:        meta.parte,
                tipo_parte:   meta.tipo_parte,
                nome_parte:   meta.nome_parte,
                cf_parte:     meta.cf_parte,
                tipo_atto:    meta.tipo_atto,
                data_atto:    meta.data_atto,
                nome_file:    fileName,
                dimensione:   meta.dimensione,
                categoria:    meta.categoria,
                url_download: '',
                blob_b64:     '',
                mime_type:    '',
            });
        }
        return atti;
    }

    if (downloadButtons.length > 0) {
        console.log('[PCT] Primi 3 pulsanti:', downloadButtons.slice(0, 3).map(b => b.fileName));
        const totalButtons = downloadButtons.length;
        let dlIndex = 0;
        for (const { btn, fileName, fileItem } of downloadButtons) {
            pctThrowIfAborted();
            const meta = extractAttoMetadata(fileItem, fileName);
            const shortName = fileName.length > 35 ? fileName.substring(0, 35) + '...' : fileName;
            updateBannerStatus('Download ' + (dlIndex + 1) + '/' + totalButtons + ': ' + shortName);
            updateBannerProgress(dlIndex + 1, totalButtons);

            console.log('[PCT] scrapeAtti: download', (dlIndex + 1) + '/' + totalButtons, '→', fileName,
                '| categoria:', meta.categoria, '| data_atto:', meta.data_atto,
                '| btn.tagName:', btn.tagName, '| btn.role:', btn.getAttribute('role'));

            // Segnala all'interceptor il fileName atteso tramite postMessage.
            // L'interceptor.js (iniettato nel contesto della pagina) ascolta
            // il messaggio 'pct-set-waiting-file-name' e aggiorna window.__pctWaitingFileName.
            window.postMessage({
                type: 'pct-set-waiting-file-name',
                fileName: fileName,
            }, '*');

            // Avvia l'attesa PRIMA del click (per non perdere messaggi veloci)
            const resultPromise = waitForDownloadResult(fileName);

            // Clicca il pulsante download
            console.log('[PCT] scrapeAtti: click su pulsante per', fileName);
            btn.click();

            // Attendi il blob (max 30 secondi)
            const result = await resultPromise;
            pctThrowIfAborted();

            if (result && result.base64) {
                const b64Len = result.base64.length;
                console.log('[PCT] scrapeAtti: blob ricevuto per', fileName,
                    '| mime:', result.mimeType, '| base64 length:', b64Len,
                    '| bytes stimati:', Math.round(b64Len * 0.75));
                atti.push({
                    parte:        meta.parte,
                    tipo_parte:   meta.tipo_parte,
                    nome_parte:   meta.nome_parte,
                    cf_parte:     meta.cf_parte,
                    tipo_atto:    meta.tipo_atto,
                    data_atto:    meta.data_atto,
                    nome_file:    fileName,
                    dimensione:   meta.dimensione,
                    categoria:    meta.categoria,
                    url_download: '', // non disponibile con Angular
                    blob_b64:     result.base64,
                    mime_type:    result.mimeType || 'application/octet-stream',
                });
            } else {
                // Timeout o errore: aggiungi comunque i metadati senza blob
                console.warn('[PCT] TIMEOUT download per', fileName, '— nessun blob ricevuto in 30s. Possibili cause: interceptor non attivo, Angular non ha fatto POST a downloadDocumento, o il click non ha triggerato il download.');
                atti.push({
                    parte:        meta.parte,
                    tipo_parte:   meta.tipo_parte,
                    nome_parte:   meta.nome_parte,
                    cf_parte:     meta.cf_parte,
                    tipo_atto:    meta.tipo_atto,
                    data_atto:    meta.data_atto,
                    nome_file:    fileName,
                    dimensione:   meta.dimensione,
                    categoria:    meta.categoria,
                    url_download: '',
                    blob_b64:     '',
                    mime_type:    '',
                });
            }

            // Pausa tra un download e l'altro per non sovraccaricare il server
            await waitAbortable(1000);
            dlIndex++;
        }

        console.log('[PCT] scrapeAtti: loop download completato. Atti con blob:', atti.filter(a => a.blob_b64).length, '/ totale:', atti.length);
        return atti;
    }

    // ── Fallback 1: albero Angular con a[href] (vecchia struttura) ──────────
    // FILTRO: solo link che puntano a file con estensione valida
    const FILE_EXT_RE = /\.(pdf|p7m|xml|zip|docx?|xlsx?|odt|ods|csv|rtf|eml|msg|tif|tiff|png|jpg|jpeg)/i;
    const fileNodes = searchRoot.querySelectorAll(
        '.ng-star-inserted a[href], ' +
        'tree-node a[href], ' +
        '.tree-node a[href], ' +
        '[class*="tree"] a[href], ' +
        '.file-node a[href]'
    );

    if (fileNodes.length > 0) {
        fileNodes.forEach(link => {
            const href = link.href || '';
            if (!href || href === '#' || href === window.location.href) return;

            const fileItem = link.closest('li, .tree-node, .ng-star-inserted');
            if (!fileItem) return;

            let nome_file = link.textContent.trim();
            if (!nome_file || nome_file.length < 3) {
                const nameSpan = fileItem.querySelector('.file-name, [class*="name"], span:not([class*="size"]):not([class*="icon"])');
                nome_file = nameSpan ? nameSpan.textContent.trim() : '';
            }
            if (!nome_file) return;

            // Filtra: accetta solo file con estensione valida
            if (!FILE_EXT_RE.test(nome_file) && !FILE_EXT_RE.test(href)) return;

            const meta = extractAttoMetadata(fileItem, nome_file);

            atti.push({
                parte:        meta.parte,
                tipo_parte:   meta.tipo_parte,
                nome_parte:   meta.nome_parte,
                cf_parte:     meta.cf_parte,
                tipo_atto:    meta.tipo_atto,
                data_atto:    meta.data_atto,
                nome_file:    nome_file,
                dimensione:   meta.dimensione,
                categoria:    meta.categoria,
                url_download: href,
                blob_b64:     '',
                mime_type:    '',
            });
        });
    }

    // ── Fallback 2: tabella con righe ────────────────────────────────────────
    if (atti.length === 0) {
        const table = findVisibleTable(searchRoot);
        if (table) {
            table.querySelectorAll('tbody tr').forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length < 2) return;

                const nome_file = getText(cells[cells.length - 2]) || getText(cells[0]);
                if (!nome_file) return;

                atti.push({
                    parte:        getText(cells[0]),
                    tipo_parte:   '',
                    nome_parte:   '',
                    cf_parte:     '',
                    tipo_atto:    getText(cells[1]) || '',
                    data_atto:    getText(cells[2]) || '',
                    nome_file:    nome_file,
                    dimensione:   parseSize(getText(cells[cells.length - 2])),
                    categoria:    'altro',
                    url_download: getHref(cells[cells.length - 1]) || getHref(row) || '',
                    blob_b64:     '',
                    mime_type:    '',
                });
            });
        }
    }

    // ── Fallback 3: link diretti a file PDF/P7M/XML ──────────────────────────
    if (atti.length === 0) {
        searchRoot.querySelectorAll('a[href]').forEach(link => {
            const href = link.href || '';
            const text = link.textContent.trim();
            if (
                /\.(pdf|p7m|xml|zip|docx?|xlsx?)(\?|$)/i.test(href) ||
                /download|allegat|document|atto/i.test(href) ||
                /\.(pdf|p7m|xml)/i.test(text)
            ) {
                const row = link.closest('tr');
                const cells = row ? row.querySelectorAll('td') : [];
                atti.push({
                    parte:        cells[0] ? getText(cells[0]) : '',
                    tipo_parte:   '',
                    nome_parte:   '',
                    cf_parte:     '',
                    tipo_atto:    cells[1] ? getText(cells[1]) : '',
                    data_atto:    cells[2] ? getText(cells[2]) : '',
                    nome_file:    text || href.split('/').pop(),
                    dimensione:   0,
                    categoria:    'altro',
                    url_download: href,
                    blob_b64:     '',
                    mime_type:    '',
                });
            }
        });
    }

    return atti;
}

// ─── Tab: Comunicazioni ───────────────────────────────────────────────────────
/**
 * Scrapa la tabella delle comunicazioni.
 * Struttura reale: Data | Tipo | Descrizione
 */
async function scrapeComunicazioni(panelRoot) {
    const comunicazioni = [];
    const searchRoot = panelRoot || getActiveTabContent() || document;

    // ── Primo tentativo: ngx-datatable (componente Angular reale del PdA) ──
    const dtRows = searchRoot.querySelectorAll('datatable-body-row');
    if (dtRows.length > 0) {
        console.log('[PCT] scrapeComunicazioni: trovate', dtRows.length, 'righe ngx-datatable (pagina corrente)');
        const raccogliRighe = (root) => {
            const pagina = [];
            root.querySelectorAll('datatable-body-row').forEach(row => {
                const cells = row.querySelectorAll('datatable-body-cell');
                if (cells.length < 2) return;

                let data_comunicazione, tipo, descrizione;
                if (cells.length >= 3) {
                    data_comunicazione = getDatatableCellValue(cells[0]);
                    tipo               = getDatatableCellValue(cells[1]);
                    descrizione        = getDatatableCellValue(cells[2]);
                } else {
                    data_comunicazione = getDatatableCellValue(cells[0]);
                    tipo               = '';
                    descrizione        = getDatatableCellValue(cells[1]);
                }

                if (data_comunicazione || descrizione) {
                    pagina.push({
                        data_comunicazione,
                        tipo,
                        descrizione,
                        letto: isLetto(row),
                    });
                }
            });
            return pagina;
        };
        return await scrapeDatatableTuttePagine(searchRoot, raccogliRighe);
    }

    // ── Fallback: tabella HTML standard ──
    const table = findVisibleTable();
    if (!table) return comunicazioni;

    table.querySelectorAll('tbody tr').forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return;

        let data_comunicazione, tipo, descrizione;
        if (cells.length >= 3) {
            data_comunicazione = getText(cells[0]);
            tipo               = getText(cells[1]);
            descrizione        = getText(cells[2]);
        } else {
            data_comunicazione = getText(cells[0]);
            tipo               = '';
            descrizione        = getText(cells[1]);
        }

        if (data_comunicazione || descrizione) {
            comunicazioni.push({
                data_comunicazione,
                tipo,
                descrizione,
                letto: isLetto(row),
            });
        }
    });

    return comunicazioni;
}

// ─── Tab: Scadenze ────────────────────────────────────────────────────────────
/**
 * Scrapa la tabella delle scadenze.
 * Struttura reale: Data | Descrizione
 * Può mostrare '0 risultati' / 'Nessun risultato' quando vuota.
 */
async function scrapeScadenze(panelRoot) {
    const scadenze = [];
    const searchRoot = panelRoot || getActiveTabContent() || document;

    // ── Primo tentativo: ngx-datatable (componente Angular reale del PdA) ──
    const dtRows = searchRoot.querySelectorAll('datatable-body-row');
    if (dtRows.length > 0) {
        console.log('[PCT] scrapeScadenze: trovate', dtRows.length, 'righe ngx-datatable (pagina corrente)');
        const raccogliRighe = (root) => {
            const pagina = [];
            root.querySelectorAll('datatable-body-row').forEach(row => {
                const cells = row.querySelectorAll('datatable-body-cell');
                if (cells.length < 2) return;

                const data_scadenza = getDatatableCellValue(cells[0]);
                const descrizione   = getDatatableCellValue(cells[1]) || '';

                if (!data_scadenza || /nessun|risultat/i.test(data_scadenza)) return;
                pagina.push({ data_scadenza, descrizione });
            });
            return pagina;
        };
        return await scrapeDatatableTuttePagine(searchRoot, raccogliRighe);
    }

    // ── Fallback: tabella HTML standard ──
    const table = findVisibleTable();
    if (!table) return scadenze;

    table.querySelectorAll('tbody tr').forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return;

        const data_scadenza = getText(cells[0]);
        const descrizione   = getText(cells[1]) || '';

        if (!data_scadenza || /nessun|risultat/i.test(data_scadenza)) return;
        scadenze.push({ data_scadenza, descrizione });
    });

    return scadenze;
}

// ─── Helper aggiornamento banner (accessibili da scrapeTab e scrapeAtti) ─────

function updateBannerStatus(text) {
    const statusEl = document.getElementById('pct-banner-progress-label');
    if (statusEl) statusEl.textContent = text;
    
    const miniLbl = document.getElementById('pct-mini-panel-progress-label');
    if (miniLbl) {
        miniLbl.textContent = text;
        const wrap = document.getElementById('pct-mini-panel-progress-wrap');
        if (wrap) wrap.style.display = 'block';
    }

    // Aggiorna anche l'overlay fullscreen se visibile.
    // Se l'utente ha chiesto lo stop, non sovrascriviamo il messaggio di interruzione.
    const overlayLbl = document.getElementById('pct-sync-overlay-label');
    if (overlayLbl && !pctIsSyncAborted()) overlayLbl.textContent = text;
    
    try { chrome.runtime.sendMessage({ action: 'syncProgress', label: text }).catch(() => {}); } catch(e){}
}

function updateBannerProgress(current, total) {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    const bar = document.getElementById('pct-banner-progress-fill');
    if (bar) bar.style.width = pct + '%';
    
    const miniBar = document.getElementById('pct-mini-panel-progress-fill');
    if (miniBar) miniBar.style.width = pct + '%';
    
    try { chrome.runtime.sendMessage({ action: 'syncProgress', pct: pct }).catch(() => {}); } catch(e){}
}

// ─── Navigazione tab ─────────────────────────────────────────────────────────
/**
 * Clicca sul tab specificato (componente Angular), attende 1000ms e chiama scrapeFn.
 *
 * I tab Angular NON usano Bootstrap href. Vengono trovati per textContent.
 * Selettori tentati in ordine: [role="tab"], .nav-link, a, button, li a
 */
async function scrapeTab(tabName, scrapeFn) {
    pctThrowIfAborted();
    const tabEl = findTabByText(tabName);
    console.log('[PCT] scrapeTab:', tabName, tabEl ? ('tab TROVATO → ' + tabEl.tagName + ' "' + tabEl.textContent.trim().substring(0, 60) + '"') : 'tab NON trovato');

    updateBannerStatus('Scraping: ' + tabName + '...');

    let foundPanel = null;

    if (tabEl) {
        tabEl.click();
        // Attendi che Angular carichi il contenuto del tab.
        // Prima aspetta sempre 1 secondo di base, poi fa polling per verificare
        // che il panel abbia contenuto reale (non solo commenti Angular <!---->).
        await waitAbortable(1000);
        // Candidati panel Angular per il contenuto del tab cliccato
        const PANEL_SELECTORS = [
            'app-dettaglio-fascicolo-parti',
            'app-dettaglio-fascicolo-aggiornamenti',
            'app-dettaglio-eventi',
            'app-dettaglio-fascicolo-atti',
            'app-atti-documenti',
            'app-dettaglio-fascicolo-scadenze',
            'app-scadenze',
            'app-dettaglio-fascicolo-comunicazioni',
            'app-comunicazioni',
            '#schedaFascicolo-panel',
            '.scheda-fascicolo',
            '[role="tabpanel"]:not([hidden])',
        ];
        const maxWait = 10000; // ms totali (incluso il secondo iniziale)
        const step    = 500;
        let   waited  = 1000;
        let   panelReady = false;
        while (waited < maxWait) {
            for (const sel of PANEL_SELECTORS) {
                const panel = document.querySelector(sel);
                if (panel) {
                    // innerHTML > 50 byte esclude i puri commenti Angular <!----><---->
                    const len = panel.innerHTML.length;
                    if (len > 50) {
                        console.log('[PCT] scrapeTab:', tabName, '→ panel pronto (' + sel + ') dopo', waited, 'ms, innerHTML len=', len);
                        panelReady = true;
                        foundPanel = panel;
                        break;
                    }
                }
            }
            if (panelReady) break;
            await waitAbortable(step);
            waited += step;
        }
        if (!panelReady) {
            // Log diagnostico: quali componenti Angular sono presenti nel DOM?
            const angularComps = Array.from(document.querySelectorAll('*'))
                .filter(el => el.tagName.toLowerCase().startsWith('app-'))
                .map(el => el.tagName.toLowerCase())
                .filter((v, i, a) => a.indexOf(v) === i)
                .slice(0, 20);
            console.log('[PCT] scrapeTab:', tabName, '→ panel NON pronto dopo', waited, 'ms, procedo comunque');
            console.log('[PCT] scrapeTab: componenti Angular nel DOM:', angularComps.join(', '));
        }
    }

    console.log('[PCT] scrapeTab:', tabName, '→ chiamo scrapeFn, foundPanel=', foundPanel ? foundPanel.tagName : 'null');
    const result = await scrapeFn(foundPanel);
    console.log('[PCT] scrapeTab:', tabName, '→ scrapeFn completata, risultati:', result ? result.length : 0);
    return result;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Cerca un campo per label testuale nella pagina.
 *
 * Struttura reale PdA:
 *   <td><strong>Label:</strong></td><td>Valore</td>
 *
 * Cerca tutti i <td> che contengono un <strong> il cui testo include il label,
 * poi prende il nextElementSibling (il <td> con il valore).
 */
function getFieldValue(label) {
    const labelLower = label.toLowerCase();

    // Strategia 1: <td><strong>Label:</strong></td><td>Valore</td>  (struttura reale PdA)
    const tds = document.querySelectorAll('td');
    for (const td of tds) {
        const strong = td.querySelector('strong');
        if (strong && strong.textContent.trim().toLowerCase().replace(/:$/, '').trim() === labelLower) {
            const next = td.nextElementSibling;
            if (next) return next.textContent.trim();
        }
    }

    // Strategia 2: <td><strong> con includes (più permissivo)
    for (const td of tds) {
        const strong = td.querySelector('strong');
        if (strong && strong.textContent.trim().toLowerCase().includes(labelLower)) {
            const next = td.nextElementSibling;
            if (next && next !== td) return next.textContent.trim();
        }
    }

    // Strategia 3: th, label, dt come fallback
    const labelEls = document.querySelectorAll('th, td.label, label, .field-label, dt');
    for (const el of labelEls) {
        if (el.textContent.trim().toLowerCase().includes(labelLower)) {
            const next = el.nextElementSibling || el.closest('tr')?.querySelector('td:last-child');
            if (next && next !== el) return next.textContent.trim();
        }
    }

    return '';
}

/** Testo pulito di un elemento o selettore CSS */
function getText(elOrSelector) {
    if (!elOrSelector) return '';
    const el = typeof elOrSelector === 'string'
        ? document.querySelector(elOrSelector)
        : elOrSelector;
    return el ? el.textContent.trim().replace(/\s+/g, ' ') : '';
}

/**
 * Estrae il valore da una cella ngx-datatable (<datatable-body-cell>),
 * rimuovendo le label <span class="screen-reader-only"> che Angular inserisce.
 * Es: "<span class='screen-reader-only'>Data:</span>29/09/2025" → "29/09/2025"
 */
function getDatatableCellValue(cell) {
    if (!cell) return '';
    const clone = cell.cloneNode(true);
    clone.querySelectorAll('.screen-reader-only').forEach(sr => sr.remove());
    return clone.textContent.trim().replace(/\s+/g, ' ');
}

/**
 * Estrae le righe di testo da una cella tabella preservando i separatori <br>.
 * getText() normalizza whitespace distruggendo i newline; questa funzione
 * sostituisce prima ogni <br> con '\n' su un clone, poi splitta.
 * Usata per estrarre nomi avvocati e CF da celle con valori multipli (uno per riga).
 */
function getCellLines(cell) {
    if (!cell) return [];
    // Prova innerText prima: rispetta il rendering CSS di Angular e converte
    // automaticamente i <br> in newline, come li vede l'utente.
    // textContent collasserebbe i whitespace e ignorerebbe i <br> visivi.
    const innerTxt = (typeof cell.innerText !== 'undefined' ? cell.innerText : '').trim();
    if (innerTxt) {
        return innerTxt.split(/[\n\r]+/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    }
    // Fallback: clona la cella e sostituisce <br> con '\n' prima di splittare
    const clone = cell.cloneNode(true);
    clone.querySelectorAll('br').forEach(br => { br.replaceWith('\n'); });
    return clone.textContent
        .split(/[\n\r]+/)
        .map(s => s.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
}

/** Href del primo link in un elemento */
function getHref(el) {
    if (!el) return '';
    const a = el.tagName === 'A' ? el : el.querySelector('a');
    return a ? a.href : '';
}

/**
 * Cerca un tab per testo parziale (case-insensitive).
 * Prova in ordine: [role="tab"], .nav-link, a, button, li a
 * Usa textContent per filtrare (no :contains non standard).
 *
 * IMPORTANTE: esclude elementi di navigazione globale (navbar, sidebar, breadcrumb,
 * header, footer) per evitare di cliccare voci di menu invece dei tab del fascicolo.
 * Preferisce elementi con testo ESATTO (trim) prima di quelli con includes.
 */
function findTabByText(text) {
    const lower = text.toLowerCase();
    // Selettori in ordine di priorità: prima i tab ARIA, poi nav-link, poi generici
    const selectors = ['[role="tab"]', '.nav-link', 'a', 'button', 'li a'];

    // Esclusioni: elementi dentro navigazione globale del PdA (non tab del fascicolo)
    const EXCLUDE_SELECTOR = 'nav, header, footer, .navbar, .sidebar, .dropdown-menu, ' +
        'app-header, app-sidebar, app-footer, app-breadcrumbs, app-navbar, ' +
        '.breadcrumb, .main-menu, .side-menu, [class*="navbar"], [class*="sidebar"]';

    // Prima passata: match ESATTO (trim) — più affidabile
    for (const sel of selectors) {
        const elements = document.querySelectorAll(sel);
        for (const el of elements) {
            if (el.closest(EXCLUDE_SELECTOR)) continue;
            const txt = el.textContent.trim().toLowerCase();
            if (txt === lower) {
                console.log('[PCT] findTabByText: match ESATTO per "' + text + '" → ' + el.tagName + ' "' + el.textContent.trim().substring(0, 60) + '"');
                return el;
            }
        }
    }

    // Seconda passata: match parziale (includes) — fallback
    for (const sel of selectors) {
        const elements = document.querySelectorAll(sel);
        for (const el of elements) {
            if (el.closest(EXCLUDE_SELECTOR)) continue;
            const txt = el.textContent.trim().toLowerCase();
            if (txt.includes(lower)) {
                console.log('[PCT] findTabByText: match PARZIALE per "' + text + '" → ' + el.tagName + ' "' + el.textContent.trim().substring(0, 60) + '"');
                return el;
            }
        }
    }

    // Terza passata: senza esclusioni (ultimo fallback)
    for (const sel of selectors) {
        const elements = document.querySelectorAll(sel);
        for (const el of elements) {
            if (el.textContent.trim().toLowerCase().includes(lower)) {
                console.log('[PCT] findTabByText: match FALLBACK (no-exclude) per "' + text + '" → ' + el.tagName + ' "' + el.textContent.trim().substring(0, 60) + '"');
                return el;
            }
        }
    }

    return null;
}

/**
 * Restituisce il contenuto del tab attivo (Angular).
 * Prova vari selettori per trovare l'area visibile/attiva.
 */
function getActiveTabContent() {
    // Prova selettori comuni per contenuto tab attivo
    const candidates = [
        '.tab-pane.active',
        '.tab-pane.show',
        '[role="tabpanel"]:not([hidden])',
        '.tab-content > .active',
        'router-outlet + *',   // Angular router outlet
        'app-dettaglio-fascicolo',  // PdA Toscana: componente dettaglio
    ];

    for (const sel of candidates) {
        try {
            const el = document.querySelector(sel);
            if (el) return el;
        } catch (e) {
            // selettore non valido, continua
        }
    }

    return null; // fallback: usa document
}

/**
 * Trova la tabella visibile nel contenuto attivo del tab.
 * Cerca in: area attiva del tab, poi in tutto il documento.
 */
function findVisibleTable(root) {
    const searchRoot = root || getActiveTabContent() || document;

    // Prova selettori in ordine di specificità
    const selectors = [
        '.card table',
        'table.table',
        'table',
    ];

    for (const sel of selectors) {
        const tables = searchRoot.querySelectorAll(sel);
        for (const table of tables) {
            // Verifica che la tabella sia visibile
            if (table.offsetParent !== null || table.closest('[style*="display: none"]') === null) {
                // Salta tabelle dell'header fascicolo (dentro app-dettaglio-fascicolo-dati-generali)
                if (!table.closest('app-dettaglio-fascicolo-dati-generali')) {
                    return table;
                }
            }
        }
    }

    // Ultimo fallback: prima tabella trovata ovunque (escluso header)
    const allTables = document.querySelectorAll('table');
    for (const table of allTables) {
        if (!table.closest('app-dettaglio-fascicolo-dati-generali')) {
            return table;
        }
    }

    return null;
}

/** Normalizza il tipo parte (AP/CP/TP), '' se il valore non indica un ruolo */
function normalizeTipo(raw) {
    const r = (raw || '').toUpperCase().trim();
    if (!r) return '';
    // Nel PdA i codici hanno due lettere: la 1a e' il ruolo processuale
    // (A=attore, C=convenuto, T/I=terzo), la 2a e' P/S = parte principale o
    // secondaria. Quindi "AS" = attore secondario, non convenuto.
    // Un "P" o "S" da solo non porta informazione di ruolo.
    if (r === 'P' || r === 'S') return '';
    if (r.includes('ATTORE') || r.includes('ATTRICE') || r.includes('RICORRENT') || r.includes('OPPONENT')) return 'AP';
    if (r.includes('CONVENUT') || r.includes('RESISTENT') || r.includes('OPPOST')) return 'CP';
    if (r.includes('TERZO') || r.includes('INTERVENUT')) return 'TP';
    if (r[0] === 'A') return 'AP';
    if (r[0] === 'C') return 'CP';
    if (r[0] === 'T' || r[0] === 'I') return 'TP';
    return '';
}

/**
 * Splitta il nome completo in cognome e nome.
 * - Persone fisiche: primo token = cognome, resto = nome.
 * - Persone giuridiche/aziende: tutto in cognome, nome vuoto.
 */
function splitCognomeNome(nomeCompleto) {
    const s = (nomeCompleto || '').trim();
    if (!s) return { cognome: '', nome: '' };
    // Rileva forme societarie: metti tutto in cognome
    if (/\b(s\.?r\.?l\.?s?|s\.?p\.?a\.?|s\.?a\.?s\.?|s\.?n\.?c\.?|s\.?a\.?p\.?a\.?|onlus|a\.?r\.?l\.?|s\.?s\.?|cooperativa|fondazione|associazione|studio\s+legale|ordine|comune|ministero|azienda|asl|ente\s+pubblico|pubblica\s+amministrazione)\b/i.test(s)) {
        return { cognome: s, nome: '' };
    }
    // Persona fisica: primo token = cognome, resto = nome
    const parts = s.split(/\s+/);
    if (parts.length <= 1) return { cognome: s, nome: '' };
    return { cognome: parts[0], nome: parts.slice(1).join(' ') };
}

/** Determina se una comunicazione è già letta */
function isLetto(row) {
    return row.classList.contains('letto') || row.classList.contains('read')
        || !!row.querySelector('.fa-envelope-open, .icon-read, [data-letto="1"]')
        ? 1 : 0;
}

/** Converte una stringa dimensione (es. "123 KB", "1.2 MB") in byte */
function parseSize(str) {
    if (!str) return 0;
    const m = str.match(/([\d.,]+)\s*(KB|MB|GB|B)?/i);
    if (!m) return 0;
    const n = parseFloat(m[1].replace(',', '.'));
    const unit = (m[2] || 'B').toUpperCase();
    const mult = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };
    return Math.round(n * (mult[unit] || 1));
}

/** Attende N millisecondi */
function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Scraping pagina Elenco Comunicazioni ────────────────────────────────────
/**
 * Scrapa la tabella visibile nella pagina elenco-comunicazioni.
 * Struttura tabella: Ufficio | Oggetto | Data | Fascicolo | Azioni
 * Restituisce array di { ufficio, oggetto, data, fascicolo }
 */
function scrapeComunicazioniPage() {
    const risultati = [];
    // Cerca la tabella principale della pagina (non Angular, HTML standard)
    const tables = document.querySelectorAll('table');
    let targetTable = null;
    for (const t of tables) {
        const headers = Array.from(t.querySelectorAll('th')).map(th => th.textContent.trim().toLowerCase());
        if (headers.some(h => h.includes('ufficio')) && headers.some(h => h.includes('oggetto'))) {
            targetTable = t;
            break;
        }
    }
    if (!targetTable) {
        console.warn('[PCT] scrapeComunicazioniPage: tabella non trovata');
        return risultati;
    }

    // Mappa indici colonne dai th
    const ths = Array.from(targetTable.querySelectorAll('thead th, tr:first-child th'));
    const colMap = {};
    ths.forEach((th, i) => {
        const txt = th.textContent.trim().toLowerCase();
        if (txt.includes('ufficio'))   colMap.ufficio   = i;
        if (txt.includes('oggetto'))   colMap.oggetto   = i;
        if (txt.includes('data'))      colMap.data      = i;
        if (txt.includes('fascicolo')) colMap.fascicolo = i;
    });
    console.log('[PCT] scrapeComunicazioniPage: colMap =', JSON.stringify(colMap));

    const rows = Array.from(targetTable.querySelectorAll('tbody tr'));
    for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 3) continue;
        const get = (idx) => (idx !== undefined && cells[idx]) ? cells[idx].textContent.trim() : '';
        const record = {
            ufficio:   get(colMap.ufficio),
            oggetto:   get(colMap.oggetto),
            data:      get(colMap.data),
            fascicolo: get(colMap.fascicolo),
        };
        if (record.ufficio || record.oggetto || record.fascicolo) {
            risultati.push(record);
        }
    }
    console.log('[PCT] scrapeComunicazioniPage: trovate', risultati.length, 'righe');
    return risultati;
}

// ─── Scraping pagina Agenda ───────────────────────────────────────────────────
/**
 * Scrapa la tabella visibile nella pagina agenda.
 * Struttura tabella: Data | Ufficio | Tipo | Fascicolo | Giudice | Azioni
 * La colonna Tipo può contenere un'icona (es. martelletto = udienza).
 * Restituisce array di { data, ufficio, tipo, fascicolo, giudice }
 */
function scrapeAgendaPage() {
    const risultati = [];
    const tables = document.querySelectorAll('table');
    let targetTable = null;
    for (const t of tables) {
        const headers = Array.from(t.querySelectorAll('th')).map(th => th.textContent.trim().toLowerCase());
        if (headers.some(h => h.includes('fascicolo')) && headers.some(h => h.includes('giudice'))) {
            targetTable = t;
            break;
        }
        // Fallback: tabella con "data" e "ufficio"
        if (!targetTable && headers.some(h => h.includes('data')) && headers.some(h => h.includes('ufficio'))) {
            targetTable = t;
        }
    }
    if (!targetTable) {
        console.warn('[PCT] scrapeAgendaPage: tabella non trovata');
        return risultati;
    }

    // Mappa indici colonne
    const ths = Array.from(targetTable.querySelectorAll('thead th, tr:first-child th'));
    const colMap = {};
    ths.forEach((th, i) => {
        const txt = th.textContent.trim().toLowerCase();
        if (txt.includes('data'))      colMap.data      = i;
        if (txt.includes('ufficio'))   colMap.ufficio   = i;
        if (txt.includes('tipo'))      colMap.tipo      = i;
        if (txt.includes('fascicolo')) colMap.fascicolo = i;
        if (txt.includes('giudice'))   colMap.giudice   = i;
    });
    console.log('[PCT] scrapeAgendaPage: colMap =', JSON.stringify(colMap));

    const rows = Array.from(targetTable.querySelectorAll('tbody tr'));
    for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 3) continue;
        const get = (idx) => (idx !== undefined && cells[idx]) ? cells[idx].textContent.trim() : '';
        // Per la colonna Tipo: prova prima il title/aria-label dell'icona, poi il testo
        let tipo = '';
        if (colMap.tipo !== undefined && cells[colMap.tipo]) {
            const tipoCell = cells[colMap.tipo];
            const icon = tipoCell.querySelector('[title], [aria-label], img, i, span[class*="icon"]');
            if (icon) {
                tipo = icon.getAttribute('title') || icon.getAttribute('aria-label') || icon.getAttribute('alt') || tipoCell.textContent.trim();
            } else {
                tipo = tipoCell.textContent.trim();
            }
        }
        const record = {
            data:      get(colMap.data),
            ufficio:   get(colMap.ufficio),
            tipo:      tipo,
            fascicolo: get(colMap.fascicolo),
            giudice:   get(colMap.giudice),
        };
        if (record.data || record.fascicolo || record.ufficio) {
            risultati.push(record);
        }
    }
    console.log('[PCT] scrapeAgendaPage: trovate', risultati.length, 'righe');
    return risultati;
}

// ─── Estrai CF avvocato dalla pagina lista ────────────────────────────────────
/**
 * Nelle pagine elenco-comunicazioni e agenda il CF non è nell'URL.
 * Prova a trovarlo: 1) nell'URL come query param, 2) in un elemento della pagina,
 * 3) dallo storage (salvato durante l'ultima sync fascicolo).
 */
async function getCfAvvocatoFromPage() {
    // 1. Prova query string (?cf=... o ?codiceFiscale=...)
    const params = new URLSearchParams(window.location.search);
    for (const key of ['cf', 'cf_avvocato', 'codiceFiscale', 'codice_fiscale']) {
        const v = params.get(key);
        if (v && v.length >= 11) return v.toUpperCase();
    }

    // 2. Prova elementi della pagina con pattern CF (16 char alfanumerico o 11 cifre P.IVA)
    const cfRegex = /\b([A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z])\b/i;
    const allText = document.body ? document.body.innerText : '';
    const matchPage = allText.match(cfRegex);
    if (matchPage) return matchPage[1].toUpperCase();

    // 3. Prova storage (salvato dall'ultima sync fascicolo)
    try {
        const stored = await new Promise(resolve =>
            chrome.storage.local.get(['lastCfAvvocato'], resolve)
        );
        if (stored && stored.lastCfAvvocato) return stored.lastCfAvvocato;
    } catch (e) {}

    return '';
}

// ─── Stato profilo avvocato sul DB ───────────────────────────────────────────
/**
 * Cache dello stato profilo per CF, per non interrogare il backend a ogni
 * trigger (dashboard, pagina profilo, esportazione agenda, retry periodico).
 */
const _profiloDbCache = new Map(); // cf -> { ts, state }
const PROFILO_DB_CACHE_MS = 60000;

const PROFILO_DB_VUOTO = { complete: false, has_calendar: false, calendar_token: '', missing: [], needs_residenza: false, residenza_vuota: false };

/**
 * Estrae il riquadro "Residenza" della pagina /profile:
 *   Indirizzo | Nr. | Cap | Comune
 * Lavora sul testo a partire dalla parola "Residenza" per non confondere il
 * "Comune" della residenza con il "Comune di nascita" che sta piu' su.
 * Il documento puo' essere quello corrente o uno scaricato via fetch.
 */
function estraiResidenzaDaDocumento(doc) {
    const vuota = { residenza_indirizzo: '', residenza_civico: '', residenza_cap: '', residenza_comune: '' };
    if (!doc || !doc.body) return vuota;

    const testo = (doc.body.innerText || doc.body.textContent || '').replace(/\s+/g, ' ');
    const i = testo.search(/\bResidenz[ae]\b/i);
    const zona = i >= 0 ? testo.slice(i) : testo;

    const pesca = (re) => {
        const m = zona.match(re);
        return m && m[1] ? m[1].replace(/\s+/g, ' ').trim() : '';
    };

    const res = {
        residenza_indirizzo: pesca(/\bIndirizzo\b[\s:]*(.+?)\s*(?=\bNr\b|\bCap\b|\bC\.A\.P\b|\bComune\b|\bProvincia\b|$)/i),
        // Il civico e' un numero (anche "8/A") oppure "SNC": preteso subito
        // dopo la label, altrimenti con "Nr." vuoto si prenderebbe "Cap".
        residenza_civico:    pesca(/\bNr\b\.?[\s:]*(\d{1,6}(?:\s?[\/\-]\s?[0-9A-Za-z]{1,4}|[A-Za-z]{1,3})?|SNC)\b/i),
        residenza_cap:       pesca(/\b(?:CAP|Cap|C\.A\.P)\b\.?[\s:]*(\d{5})\b/i),
        residenza_comune:    '',
    };

    // Il comune arriva come "Massa (MS)"; senza provincia si ripiega su un
    // nome di poche parole. Il "Comune di nascita" e' escluso a monte.
    res.residenza_comune = pesca(/\bComune\b(?!\s*di\s+nascita)[\s:]*([A-Za-zÀ-ÿ'’\.\- ]{2,60}?\(\s*[A-Za-z]{2}\s*\))/i);
    if (!res.residenza_comune) {
        res.residenza_comune = pesca(/\bComune\b(?!\s*di\s+nascita)[\s:]*([A-Za-zÀ-ÿ'’\.\-]+(?:\s[A-Za-zÀ-ÿ'’\.\-]+){0,2})\s*(?=\bIndirizzo\b|\bNr\b|\bCap\b|\bProvincia\b|©|$)/i);
    }

    // L'indirizzo del PdA ripete spesso il civico ("via l staffetti 17"):
    // se il civico manca lo si ricava dalla coda dell'indirizzo.
    if (!res.residenza_civico && res.residenza_indirizzo) {
        const m = res.residenza_indirizzo.match(/(\d+[A-Za-z\/]*)\s*$/);
        if (m) res.residenza_civico = m[1];
    }

    // Ripiego sul DOM: con HTML minificato label e valore possono restare
    // attaccati nel testo e le regex qui sopra non agganciano nulla.
    if (!res.residenza_indirizzo && !res.residenza_cap && !res.residenza_comune) {
        const norm = (s) => (s || '').toLowerCase().replace(/[\s.:]+/g, '').replace(/[^a-z0-9]/g, '');
        const etichette = {
            indirizzo: 'residenza_indirizzo',
            nr:        'residenza_civico',
            cap:       'residenza_cap',
            comune:    'residenza_comune',
        };
        const radice = doc.querySelectorAll ? doc : doc.body;
        const celle = (radice && radice.querySelectorAll)
            ? radice.querySelectorAll('td, th, dt, dd, div, span, p, label, li')
            : [];
        for (let k = 0; k < celle.length; k++) {
            const chiave = etichette[norm(celle[k].textContent)];
            if (!chiave || res[chiave]) continue;
            for (let j = k + 1; j < Math.min(k + 4, celle.length); j++) {
                const val = (celle[j].textContent || '').replace(/\s+/g, ' ').trim();
                if (val && !etichette[norm(val)]) { res[chiave] = val; break; }
            }
        }
    }
    return res;
}

/**
 * Chiede al backend se il profilo dell'avvocato (per CF) è già completo.
 *
 * "Completo" = tutti i campi di tab_avvocati valorizzati AD ECCEZIONE di
 * email e password. Quando è completo non si deve più interrogare la pagina
 * /cancelleriatelematica/profile del PdA per ri-estrarre gli stessi dati.
 *
 * NB: definita a livello di modulo perché serve a tre trigger distinti
 * (dashboard, pagina profilo, esportazione agenda).
 */
async function verificaCompletezzaDB(cf, opts = {}) {
    if (!cf || cf.length !== 16) return { ...PROFILO_DB_VUOTO };

    const cached = _profiloDbCache.get(cf);
    if (!opts.forceRefresh && cached && (Date.now() - cached.ts) < PROFILO_DB_CACHE_MS) {
        return cached.state;
    }

    try {
        const stored = await new Promise(resolve =>
            chrome.storage.local.get(['backendUrl', 'apiToken'], resolve)
        );
        const baseUrl = (stored.backendUrl || 'http://localhost/pct/api_sync.php')
            .replace(/\/api_sync[^/]*\.php$/, '');
        const apiToken = stored.apiToken || 'pct_aruba_2026_adb200f9';
        const resp = await chrome.runtime.sendMessage({
            action:     'syncToBackend',
            backendUrl: baseUrl + '/api_check_profilo_avvocato.php',
            apiToken:   apiToken,
            cfAvvocato: cf,
            data:       { codice_fiscale: cf },
        });
        if (resp && !resp.error && resp.result) {
            const state = {
                complete:        !!resp.result.complete,
                has_calendar:    !!resp.result.has_calendar,
                calendar_token:  resp.result.calendar_token || '',
                missing:         resp.result.missing || [],
                needs_residenza: !!resp.result.needs_residenza,
                residenza_vuota: !!resp.result.residenza_vuota,
            };
            _profiloDbCache.set(cf, { ts: Date.now(), state });
            return state;
        }
        console.warn('[PCT] Verifica profilo DB: risposta non valida', JSON.stringify(resp));
    } catch (err) {
        console.error('[PCT] Errore verifica completezza DB:', err);
    }
    // Errore / backend non raggiungibile: NON è "profilo incompleto". Lo segnalo
    // con error:true così i chiamanti non riaprono in loop la finestra pctBackground.
    return { ...PROFILO_DB_VUOTO, error: true };
}

/** Invalida la cache dello stato profilo (da chiamare dopo un salvataggio) */
function invalidaCacheProfiloDB(cf) {
    if (cf) _profiloDbCache.delete(cf);
    else _profiloDbCache.clear();
}

/**
 * Allinea i flag in localStorage allo stato reale del DB, così i trigger
 * successivi non ripartono con lo scraping quando i dati ci sono già.
 */
function allineaFlagLocali(cf, dbState) {
    if (!cf || !dbState) return;
    if (dbState.complete) localStorage.setItem('pctProfileComplete_' + cf, '1');
    if (dbState.has_calendar) {
        localStorage.setItem('pctCalendarToken_' + cf, dbState.calendar_token || '1');
    }
}

// ─── Banner flottante Comunicazioni ──────────────────────────────────────────
(function initBannerComunicazioni() {
    'use strict';
    if (!window.location.href.includes('elenco-comunicazioni')) return;
    if (document.getElementById('pct-floating-banner')) return;

    const BANNER_ID     = 'pct-floating-banner';
    const STYLE_ID      = 'pct-banner-style';
    const DASHBOARD_URL = 'http://localhost/pct/';

    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #pct-floating-banner {
                position: fixed; bottom: 24px; right: 24px; z-index: 999999;
                width: 300px; background: #ffffff; border: 1px solid #e0e0e0;
                border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                padding: 16px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 13px; color: #333; box-sizing: border-box;
                animation: pct-slide-up 0.35s cubic-bezier(0.22,1,0.36,1) both;
            }
            @keyframes pct-slide-up {
                from { transform: translateY(120%); opacity: 0; }
                to   { transform: translateY(0);    opacity: 1; }
            }
            #pct-floating-banner * { box-sizing: border-box; }
            #pct-banner-header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
            #pct-banner-logo { width: 24px; height: 24px; border-radius: 4px; flex-shrink: 0; }
            #pct-banner-title { font-size: 14px; font-weight: 700; color: #222; flex: 1; }
            #pct-banner-close { background: none; border: none; color: #999; font-size: 16px; cursor: pointer; padding: 0 2px; line-height: 1; flex-shrink: 0; }
            #pct-banner-close:hover { color: #333; }
            #pct-banner-subtitle { font-size: 12px; color: #555; margin-bottom: 10px; }
            #pct-banner-btn-sync {
                display: block; width: 100%; padding: 9px 0; background: #0056b3;
                color: #fff; border: none; border-radius: 5px; font-size: 13px;
                font-weight: 600; cursor: pointer; margin-bottom: 8px;
            }
            #pct-banner-btn-sync:hover { background: #004494; }
            #pct-banner-btn-sync:disabled { background: #aaa; cursor: not-allowed; }
            #pct-banner-result {
                display: none; font-size: 12px; border-radius: 4px;
                padding: 7px 10px; margin-bottom: 8px; text-align: center; font-weight: 600;
            }
            #pct-banner-result.pct-success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
            #pct-banner-result.pct-error   { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
            #pct-banner-result.pct-warning { background: #fff3cd; color: #856404; border: 1px solid #ffc107; }
            #pct-banner-footer { display: flex; justify-content: space-between; font-size: 11px; }
            #pct-banner-link-dashboard { color: #0056b3; font-size: 11px; text-decoration: none; }
            #pct-banner-link-dashboard:hover { text-decoration: underline; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    const banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.innerHTML = `
        <div id="pct-banner-header">
            <img id="pct-banner-logo" src="${chrome.runtime.getURL('icon48.png')}" alt="PCT">
            <span id="pct-banner-title">PCT Monitor</span>
            <button id="pct-banner-close" title="Chiudi">&times;</button>
        </div>
        <div id="pct-banner-subtitle">Comunicazioni di cancelleria</div>
        <button id="pct-banner-btn-sync">Sync Comunicazioni (pagina corrente)</button>
        <div id="pct-banner-result"></div>
        <div id="pct-banner-footer">
            <a id="pct-banner-link-dashboard" href="${DASHBOARD_URL}" target="_blank" rel="noopener">Apri Dashboard</a>
        </div>
    `;
    document.body.appendChild(banner);
    pctAggiornaLinkDashboard();

    const elBtnSync = document.getElementById('pct-banner-btn-sync');
    const elResult  = document.getElementById('pct-banner-result');
    const elClose   = document.getElementById('pct-banner-close');

    elClose.addEventListener('click', () => { banner.style.display = 'none'; });

    elBtnSync.addEventListener('click', async () => {
        elBtnSync.disabled = true;
        elResult.style.display = 'none';
        elBtnSync.textContent = 'Scraping...';
        try {
            const stored = await new Promise(resolve =>
                chrome.storage.local.get(['backendUrl', 'apiToken', 'lastCfAvvocato'], resolve)
            );
            const apiToken   = stored.apiToken   || 'pct_aruba_2026_adb200f9';
            const baseUrl    = (stored.backendUrl || 'http://localhost/pct/api_sync.php')
                .replace(/\/api_sync[^/]*\.php$/, '');
            const backendUrl = baseUrl + '/api_sync_comunicazioni.php';

            const cfAvvocato = await getCfAvvocatoFromPage();
            const comunicazioni = scrapeComunicazioniPage();

            if (comunicazioni.length === 0) {
                elResult.className = 'pct-error';
                elResult.textContent = 'Nessuna comunicazione trovata nella tabella.';
                elResult.style.display = 'block';
                return;
            }

            elBtnSync.textContent = 'Invio al backend...';
            const resp = await chrome.runtime.sendMessage({
                action:     'syncToBackend',
                backendUrl: backendUrl,
                apiToken:   apiToken,
                cfAvvocato: cfAvvocato,
                data: {
                    cf_avvocato:    cfAvvocato,
                    comunicazioni:  comunicazioni,
                },
            });

            if (resp && !resp.error && resp.result && resp.result.success) {
                const ins = resp.result.inserted || 0;
                const tot = resp.result.total    || comunicazioni.length;
                elResult.className = 'pct-success';
                elResult.textContent = `OK: ${ins} nuove / ${tot} totali inviate`;
            } else {
                const errMsg = (resp && resp.error) ? resp.error
                    : (resp && resp.result && resp.result.error) ? resp.result.error
                    : 'Errore sconosciuto';
                elResult.className = 'pct-error';
                elResult.textContent = 'Errore: ' + errMsg;
            }
            elResult.style.display = 'block';
        } catch (err) {
            elResult.className = 'pct-error';
            elResult.textContent = 'Errore: ' + err.message;
            elResult.style.display = 'block';
        } finally {
            elBtnSync.disabled = false;
            elBtnSync.textContent = 'Sync Comunicazioni (pagina corrente)';
        }
    });
})();

// ─── Auto-sync Agenda in background ──────────────────────────────────────────
/**
 * Quando l'utente è su /agenda o /dashboard del PdA, invia cf_avvocato al backend.
 * Il backend risolve il token ICS da tab_avvocati, scarica e parsa il calendario,
 * e salva gli eventi su DB. Nessun scraping DOM, nessun popup, nessun toast invasivo.
 */
(function initAgendaAutoSync() {
    'use strict';

    const url = window.location.href;
    if (!url.includes('/agenda') && !url.includes('/dashboard')) return;

    // Evita doppia esecuzione nello stesso contesto
    if (window.__pctAgendaSyncStarted) return;
    window.__pctAgendaSyncStarted = true;

    async function syncAgenda() {
        try {
            const stored = await new Promise(resolve =>
                chrome.storage.local.get(['backendUrl', 'apiToken', 'lastCfAvvocato'], resolve)
            );
            const apiToken = stored.apiToken || 'pct_aruba_2026_adb200f9';
            const baseUrl = (stored.backendUrl || 'http://localhost/pct/api_sync.php')
                .replace(/\/api_sync[^/]*\.php$/, '');
            const backendUrl = baseUrl + '/api_sync_agenda.php';
            const cfAvvocato = await getCfAvvocatoFromPage();

            if (!cfAvvocato || cfAvvocato.length !== 16) {
                console.warn('[PCT] Agenda: CF avvocato non trovato');
                return;
            }

            console.log('[PCT] Agenda: avvio sync background via ICS — cf=', cfAvvocato);
            const resp = await chrome.runtime.sendMessage({
                action: 'syncToBackend',
                backendUrl: backendUrl,
                apiToken: apiToken,
                cfAvvocato: cfAvvocato,
                data: { cf_avvocato: cfAvvocato },
            });

            if (resp && !resp.error && resp.result && resp.result.success) {
                console.log('[PCT] Agenda sync ok:', resp.result.inserted, 'eventi su mesi', resp.result.mesi.join(', '));
            } else {
                console.warn('[PCT] Agenda sync errore:', JSON.stringify(resp));
            }
        } catch (err) {
            console.error('[PCT] Agenda sync eccezione:', err);
        }
    }

    // Avvia subito e anche su SPA navigation
    syncAgenda();

    let lastUrl = window.location.href;
    const navObserver = new MutationObserver(() => {
        const currentUrl = window.location.href;
        if (currentUrl !== lastUrl) {
            lastUrl = currentUrl;
            if (currentUrl.includes('/agenda') || currentUrl.includes('/dashboard')) {
                console.log('[PCT] Agenda: navigazione interna rilevata, riavvio sync');
                syncAgenda();
            }
        }
    });
    navObserver.observe(document, { subtree: true, childList: true });
})();

// ─── Auto-import profilo avvocato — dashboard trigger ─────────────────────────
/**
 * Quando l'avvocato atterra sulla dashboard del PdA, l'estensione completa
 * automaticamente il profilo e cattura il token calendario via fetch silenzioso
 * dalla pagina corrente. Se il fetch non restituisce i dati, usa una tab
 * di background come fallback.
 */
(function initProfileDashboardTrigger() {
    'use strict';

    const PROFILE_URL       = 'https://www.giustizia.toscana.it/pda-rt/cancelleriatelematica/profile';
    const EXPORT_AGENDA_URL = 'https://www.giustizia.toscana.it/pda-rt/cancelleriatelematica/esportazione-agenda';

    function isDashboardPage() {
        return window.location.href.includes('/cancelleriatelematica/dashboard');
    }

    function getCfFromStorage() {
        const lastCf = localStorage.getItem('pctLastCf');
        if (lastCf) return lastCf;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('pctProfileComplete_')) {
                return key.replace('pctProfileComplete_', '');
            }
        }
        return '';
    }

    function hasCalendarToken(cf) {
        return !!localStorage.getItem('pctCalendarToken_' + cf);
    }

    function normalizzaCf(cf) {
        return (cf || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
    }

    function injectNetworkInterceptor() {
        if (document.getElementById('pct-network-interceptor-script')) return;
        const script = document.createElement('script');
        script.id = 'pct-network-interceptor-script';
        script.src = chrome.runtime.getURL('interceptor.js');
        (document.head || document.documentElement).appendChild(script);
    }

    // ── Nome/cognome: parole da scartare e verifica sul codice fiscale ─────────
    // Le pagine del PdA affiancano al nome l'etichetta del profilo ("RUOLO",
    // "AVV"): senza filtro finivano salvate come nome dell'avvocato.
    const PAROLE_NON_NOME = ['RUOLO', 'RUOLI', 'AVV', 'AVV.', 'AVVOCATO', 'PARTE', 'PROFILO',
        'PROFILI', 'DELEGATO', 'UTENTE', 'BENVENUTO', 'BENVENUTA', 'STUDIO'];

    function paroleNome(testo) {
        return String(testo || '')
            .split(/[^A-Za-zÀ-ÖØ-öø-ÿ'’\-]+/)
            .filter(p => p.length >= 2 && PAROLE_NON_NOME.indexOf(p.toUpperCase()) === -1)
            .map(p => p.toUpperCase());
    }

    function lettereCf(testo) {
        return String(testo || '').toUpperCase().replace(/[^A-Z]/g, '');
    }

    // Codice fiscale: primi 3 caratteri dal cognome, successivi 3 dal nome.
    function codiceCognomeCf(cognome) {
        const s = lettereCf(cognome);
        const cons = s.replace(/[AEIOU]/g, '');
        const voc = s.replace(/[^AEIOU]/g, '');
        return (cons + voc + 'XXX').slice(0, 3);
    }
    function codiceNomeCf(nome) {
        const s = lettereCf(nome);
        const cons = s.replace(/[AEIOU]/g, '');
        if (cons.length >= 4) return cons[0] + cons[2] + cons[3];
        const voc = s.replace(/[^AEIOU]/g, '');
        return (cons + voc + 'XXX').slice(0, 3);
    }

    /**
     * Divide una sequenza di parole in cognome + nome usando il codice fiscale
     * come riscontro (es. "BERTUCCELLI VERONICA" + BRTVNC... -> BERTUCCELLI /
     * VERONICA). Senza riscontro si assume la forma ufficiale "COGNOME NOME".
     */
    function dividiNomeConCf(parole, cf) {
        if (!parole || !parole.length) return null;
        if (parole.length === 1) return { cognome: parole[0], nome: '' };
        const c = normalizzaCf(cf);
        if (c.length === 16) {
            for (let k = 1; k < parole.length; k++) {
                const cogn = parole.slice(0, k).join(' ');
                const nom = parole.slice(k).join(' ');
                if (codiceCognomeCf(cogn) === c.slice(0, 3) && codiceNomeCf(nom) === c.slice(3, 6)) {
                    return { cognome: cogn, nome: nom };
                }
            }
            // Prova anche l'ordine inverso "NOME COGNOME".
            for (let k = 1; k < parole.length; k++) {
                const nom = parole.slice(0, k).join(' ');
                const cogn = parole.slice(k).join(' ');
                if (codiceCognomeCf(cogn) === c.slice(0, 3) && codiceNomeCf(nom) === c.slice(3, 6)) {
                    return { cognome: cogn, nome: nom };
                }
            }
            return null; // col CF disponibile non si tira a indovinare
        }
        return { cognome: parole.slice(0, -1).join(' '), nome: parole[parole.length - 1] };
    }

    /**
     * Codice fiscale dell'utente realmente collegato al PdA, letto dal token
     * Keycloak in localStorage (claim preferred_username = "tinit-<cf>").
     * E' l'unica fonte certa: nelle risposte delle API compaiono anche i CF
     * delle parti, che non vanno confusi con quello dell'avvocato.
     */
    function cfUtenteLoggato() {
        try {
            let jwt = localStorage.getItem('access_token') || '';
            if (!jwt) {
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i) || '';
                    if (/access_token|id_token/i.test(k)) { jwt = localStorage.getItem(k) || ''; break; }
                }
            }
            const parti = String(jwt).split('.');
            if (parti.length < 2) return '';
            const b64 = parti[1].replace(/-/g, '+').replace(/_/g, '/');
            const payload = JSON.parse(decodeURIComponent(escape(atob(b64 + '==='.slice(0, (4 - b64.length % 4) % 4)))));
            const user = String(payload.preferred_username || '').replace(/^tinit-/i, '');
            return normalizzaCf(user);
        } catch (e) {
            return '';
        }
    }

    function estraiCampiDaTesto(text) {
        const CALENDAR_BASE = 'https://www.giustizia.toscana.it/pda-rt/api/pda-batch/public/calendar/';
        const cf = normalizzaCf((text.match(/\b([A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z])\b/i) || [])[1] || '');
        const tokenId = ((text.match(/\/calendar\/([a-f0-9]+)/i) || [])[1] || '');
        const token = tokenId ? CALENDAR_BASE + tokenId : '';

        // Nome/cognome: le due chiavi devono stare nello STESSO oggetto JSON,
        // altrimenti si rischia di accoppiare il cognome dell'utente con il
        // "nome" di un oggetto qualsiasi della risposta (era il caso di "RUOLO").
        let nome = '', cognome = '';
        const coppia = text.match(/"cognome"\s*[:=]\s*"([^"]*)"[^{}\[\]]*?"nome"\s*[:=]\s*"([^"]*)"/i)
            || (function () {
                const m = text.match(/"nome"\s*[:=]\s*"([^"]*)"[^{}\[\]]*?"cognome"\s*[:=]\s*"([^"]*)"/i);
                return m ? [m[0], m[2], m[1]] : null;
            })();
        if (coppia) {
            const cogn = paroleNome(coppia[1]).join(' ');
            const nom = paroleNome(coppia[2]).join(' ');
            // Se il campo cognome contiene tutto il nominativo lo si divide col CF.
            if (cogn && !nom) {
                const d = dividiNomeConCf(paroleNome(coppia[1]), cf);
                if (d) { cognome = d.cognome; nome = d.nome; }
            } else {
                cognome = cogn;
                nome = nom;
            }
        }

        // Email / PEC: cerca tutti gli indirizzi e distingue in base al dominio
        const allEmails = [...text.matchAll(/\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/gi)]
            .map(m => m[1].toLowerCase());
        let email = '';
        let pec = '';
        for (const addr of allEmails) {
            if (addr.includes('pec') || addr.includes('legalmail') || addr.includes('securemail')) {
                if (!pec) pec = addr;
            } else if (!email) {
                email = addr;
            }
        }

        // JSON espliciti (sovrascrivono l'euristica sugli indirizzi)
        const emailJson = text.match(/"(?:email|e-mail|mail)"\s*[:=]\s*"([^"]*)"/i);
        const pecJson = text.match(/"(?:pec|indirizzoPec|emailPec)"\s*[:=]\s*"([^"]*)"/i);
        if (emailJson && emailJson[1].trim()) email = emailJson[1].trim().toLowerCase();
        if (pecJson && pecJson[1].trim()) pec = pecJson[1].trim().toLowerCase();

        // Ordine: pattern generico
        let ordine = '';
        const ordineMatch = text.match(/"ordine"\s*[:=]\s*"([^"]+)"/i);
        if (ordineMatch) ordine = ordineMatch[1].trim();

        return { cf, nome, cognome, email, pec, ordine, token };
    }

    // ─── Schede del fascicolo intercettate mentre le consulti ────────────────
    // Quando apri Incarichi, Beni, Lotti, Libretti, Spese, Pendenze o Istanze,
    // il Portale chiama un suo servizio JSON e noi quella risposta ce l'abbiamo
    // già in mano: la giriamo al monitor così com'è. Nessun clic automatico,
    // nessuna scheda aperta a tua insaputa, nessun secondo viaggio in rete.
    const SEZIONI_PDA = {
        elencoIncarichi:    'incarichi',
        elencoBeniImmobili: 'beni',
        elencoLotti:        'lotti',
        elencoLibretti:     'libretti',
        elencoSpese:        'spese',
        elencoPendenze:     'pendenze',
        dettaglioIstanze:   'istanze',
    };
    const LISTE_SEZIONI_PDA = {
        incarichi: 'elencoIncarichiList',
        beni: 'beniImmobiliList',
        lotti: 'elencoLottiList',
        libretti: 'elencoLibrettiList',
        spese: 'elencoSpeseList',
        pendenze: 'elencoPendenzeList',
        istanze: 'istanzaFascicoloList',
    };
    const sezioniInviate = new Map();   // sezione -> impronta dell'ultimo invio

    function sezioneDaUrl(url) {
        const m = String(url || '').match(/servizipda-(?:sicid|siecic|sigp)\/v\d+\/([A-Za-z]+)/);
        return m ? (SEZIONI_PDA[m[1]] || '') : '';
    }

    function archiviaSezionePda(url, text) {
        const sezione = sezioneDaUrl(url);
        if (!sezione) return;
        if (!window.location.href.includes('dettaglio-fascicolo')) return;

        let risposta = {};
        if (text && text.trim() !== '') {
            try { risposta = JSON.parse(text); } catch (e) { return; }
            if (!risposta || typeof risposta !== 'object') return;
        }
        if (!Array.isArray(risposta[LISTE_SEZIONI_PDA[sezione]])) return;
        // Stessa scheda riletta senza cambiamenti: non si rimanda niente.
        const impronta = sezione + '|' + window.location.pathname + '|' + (text || '').length;
        if (sezioniInviate.get(sezione) === impronta) return;
        sezioniInviate.set(sezione, impronta);

        try {
            chrome.runtime.sendMessage({
                action: 'salvaSezioni',
                payload: { url: window.location.href, risposte: { [sezione]: risposta } },
            }, (r) => {
                if (chrome.runtime.lastError) return;
                if (r && r.result && r.result.sezioni && r.result.sezioni[sezione]) {
                    console.log('[PCT] scheda', sezione, 'archiviata:',
                                r.result.sezioni[sezione].righe, 'righe');
                } else if (r && r.result && r.result.da_sincronizzare) {
                    console.log('[PCT] scheda', sezione, 'non archiviata: il fascicolo non è ancora in archivio');
                }
            });
        } catch (e) { /* estensione ricaricata: si riprova al prossimo giro */ }
    }

    async function elaboraRispostaNetwork(url, text) {
        if (!text || text.length < 20) return;

        // Su pagina dettaglio-fascicolo non salvare dati profilo avvocato:
        // le API restituiscono CF delle parti, non dell'avvocato loggato.
        if (window.location.href.includes('dettaglio-fascicolo')) {
            archiviaSezionePda(url, text);
            return;
        }

        const dati = estraiCampiDaTesto(text);
        console.log('[PCT] Network: analizzo', url, 'dati=', dati);

        if (!dati.cf || dati.cf.length !== 16) return;

        // Il CF trovato nella risposta deve essere quello dell'utente collegato:
        // nelle risposte del PdA compaiono anche i CF di parti e controparti, che
        // altrimenti finirebbero salvati come avvocati.
        const cfLoggato = cfUtenteLoggato();
        if (cfLoggato && dati.cf !== cfLoggato) {
            console.log('[PCT] Network: CF', dati.cf, 'non è quello dell\'utente collegato (' + cfLoggato + '), ignoro');
            return;
        }

        localStorage.setItem('pctLastCf', dati.cf);

        // Stato reale sul DB: se l'anagrafica è già completa (email e password
        // escluse) non serve rimandarla al backend.
        const dbState = await verificaCompletezzaDB(dati.cf);
        allineaFlagLocali(dati.cf, dbState);

        // Se profilo e token sono già stati salvati per questo CF, salta
        const profileComplete = localStorage.getItem('pctProfileComplete_' + dati.cf) === '1' && hasCalendarToken(dati.cf);
        if (profileComplete) {
            console.log('[PCT] Network: profilo e token già presenti, skip salvataggio');
            return;
        }

        // Salva profilo solo se il CF dell'utente collegato è certo: senza quella
        // verifica ci si limita al token del calendario.
        if (dati.nome && dati.cognome && cfLoggato && !dbState.complete && localStorage.getItem('pctProfileComplete_' + dati.cf) !== '1') {
            const profilo = {
                codice_fiscale: dati.cf,
                nome: dati.nome,
                cognome: dati.cognome,
                email: dati.email,
                pec: dati.pec,
                ordine: dati.ordine,
            };
            const r = await chiamaBackend('/api_profilo_avvocato.php', dati.cf, profilo);
            if (r && !r.error && r.result && r.result.success) {
                console.log('[PCT] Network: profilo salvato');
                invalidaCacheProfiloDB(dati.cf);
                localStorage.setItem('pctProfileComplete_' + dati.cf, '1');
                localStorage.setItem('pctProfileName_' + dati.cf, dati.nome + ' ' + dati.cognome);
            }
        }

        // Salva token calendario se non è già presente
        if (dati.token && !dbState.has_calendar && !hasCalendarToken(dati.cf)) {
            const r = await chiamaBackend('/api_profilo_avvocato.php', dati.cf, {
                codice_fiscale: dati.cf,
                api_calendario: dati.token,
            });
            if (r && !r.error && r.result && r.result.success) {
                console.log('[PCT] Network: token calendario salvato');
                invalidaCacheProfiloDB(dati.cf);
                localStorage.setItem('pctCalendarToken_' + dati.cf, dati.token);
            }
        }
    }

    async function sincronizzaProfiloDaDashboard() {
        const cf = await getCfAvvocatoFromPage();
        if (!cf || cf.length !== 16) {
            console.log('[PCT] Dashboard: CF non trovato sulla pagina');
            return false;
        }

        const pageText = document.body ? document.body.innerText : '';
        // Il saluto della dashboard e' "Benvenuta BERTUCCELLI VERONICA" ma spesso
        // e' seguito dall'etichetta del profilo ("RUOLO", "AVV"): si prendono solo
        // le parole del nominativo e si divide cognome/nome col riscontro sul CF.
        const m = pageText.match(/Benvenut[oa][,:\s]+([^\n\r,;:.0-9]{3,80})/i);
        if (!m) {
            console.log('[PCT] Dashboard: nome/cognome non trovati nel saluto');
            return false;
        }

        const diviso = dividiNomeConCf(paroleNome(m[1]), cf);
        if (!diviso || !diviso.cognome || !diviso.nome) {
            console.log('[PCT] Dashboard: saluto "' + m[1].trim() + '" non coerente col CF ' + cf + ', ignoro');
            return false;
        }

        const cognome = diviso.cognome;
        const nome    = diviso.nome;
        const profilo = {
            codice_fiscale: cf,
            nome:           nome,
            cognome:        cognome,
            email:          '',
            pec:            '',
            ordine:         '',
        };

        console.log('[PCT] Dashboard: profilo dal saluto', profilo);
        const r = await chiamaBackend('/api_profilo_avvocato.php', cf, profilo);
        if (r && !r.error && r.result && r.result.success) {
            console.log('[PCT] Dashboard: profilo dal saluto salvato');
            invalidaCacheProfiloDB(cf);
            localStorage.setItem('pctLastCf', cf);
            localStorage.setItem('pctProfileComplete_' + cf, '1');
            localStorage.setItem('pctProfileName_' + cf, nome + ' ' + cognome);
            return true;
        }
        console.warn('[PCT] Dashboard: salvataggio profilo dal saluto fallito', JSON.stringify(r));
        return false;
    }

    function normalizzaLabel(label) {
        return label.toLowerCase().replace(/[-\s]+/g, '').replace(/[^a-z0-9]/g, '');
    }

    function estraiValoreDaDoc(doc, label) {
        const pageText = doc.body ? doc.body.innerText : '';
        const cleaned = pageText.replace(/\n+/g, '\n').replace(/\s+/g, ' ');
        const lowerLabel = label.toLowerCase();

        const patterns = {
            'codice fiscale': /\bCodice\s+Fiscale\b[\s:]*([A-Z0-9]{16})/i,
            'nome': /\bNome\b[\s:]*([A-Z][A-Za-z\s]*?)\s*(?=\bCognome\b|\bComune\s+di\s+nascita\b|\bData\s+di\s+nascita\b|\bE[-\s]?Mail\b|\bPEC\b|\bTelefono\b|\bOrdine\b|$)/i,
            'cognome': /\bCognome\b[\s:]*([A-Z][A-Za-z\s]*?)\s*(?=\bComune\s+di\s+nascita\b|\bData\s+di\s+nascita\b|\bE[-\s]?Mail\b|\bPEC\b|\bTelefono\b|\bOrdine\b|$)/i,
            'e-mail': /\bE[-\s]?Mail\b[\s:]*([^\s]+@[^\s]+)/i,
            'pec': /\bPEC\b[\s:]*([^\s]+@[^\s]+)/i,
            'ordine': /\bOrdine\b[\s:]*(.+?)\s*(?=\bResidenza\b|\bIndirizzo\b|\bCAP\b|\bComune\b|$)/i,
        };

        if (patterns[lowerLabel]) {
            const m = cleaned.match(patterns[lowerLabel]);
            if (m && m[1]) {
                const val = m[1].replace(/\s+/g, ' ').trim();
                if (val) return val;
            }
        }

        if (lowerLabel === 'codice fiscale') {
            const cfMatch = cleaned.match(/\b([A-Z0-9]{16})\b/);
            if (cfMatch) return cfMatch[1].toUpperCase();
        }

        const norm = normalizzaLabel(label);
        const rows = doc.querySelectorAll('table tr, .row, [class*="profile"], [class*="detail"], dl, [class*="form-group"]');
        for (const row of rows) {
            const cells = row.querySelectorAll('td, th, dt, dd, .col-md-3, .col-md-4, .col-md-6, .col-6, .col-sm-3, .col-sm-4, .col-sm-6');
            for (let i = 0; i < cells.length - 1; i++) {
                const cellText = normalizzaLabel(cells[i].textContent);
                if (cellText === norm || cellText.startsWith(norm + ':')) {
                    return cells[i + 1].textContent.replace(/\s+/g, ' ').trim();
                }
            }
        }

        const boldLabels = doc.querySelectorAll('strong, b, .font-weight-bold, .modal-font-bold, [class*="bold"]');
        for (const el of boldLabels) {
            const text = normalizzaLabel(el.textContent);
            if (text === norm || text === norm + ':') {
                const own = el.textContent.replace(/^[^:]*:?\s*/, '').replace(/\s+/g, ' ').trim();
                if (own && normalizzaLabel(own) !== norm) return own;
                let next = el.nextSibling;
                while (next) {
                    const t = (next.textContent || '').trim();
                    if (t) return t.replace(/\s+/g, ' ').trim();
                    next = next.nextSibling;
                }
                const nextEl = el.nextElementSibling || el.parentElement?.nextElementSibling;
                if (nextEl) return nextEl.textContent.replace(/\s+/g, ' ').trim();
            }
        }
        return '';
    }

    function estraiTokenDaDoc(doc) {
        const CALENDAR_BASE = 'https://www.giustizia.toscana.it/pda-rt/api/pda-batch/public/calendar/';
        const inputs = doc.querySelectorAll('input, textarea');
        for (const input of inputs) {
            const val = (input.value || input.placeholder || '').trim();
            const m = val.match(/\/calendar\/([a-f0-9]+)/i);
            if (m) return CALENDAR_BASE + m[1];
        }
        const links = doc.querySelectorAll('a[href*="/calendar/"]');
        for (const link of links) {
            const m = (link.href || '').match(/\/calendar\/([a-f0-9]+)/i);
            if (m) return CALENDAR_BASE + m[1];
        }
        const pageText = doc.body ? doc.body.innerText : '';
        const m = pageText.match(/\/calendar\/([a-f0-9]+)/i);
        if (m) return CALENDAR_BASE + m[1];
        const html = doc.body ? doc.body.innerHTML : '';
        const m2 = html.match(/\/calendar\/([a-f0-9]+)/i);
        if (m2) return CALENDAR_BASE + m2[1];
        return '';
    }

    async function getBackendBaseUrl() {
        const stored = await new Promise(resolve =>
            chrome.storage.local.get(['backendUrl'], resolve)
        );
        return (stored.backendUrl || 'http://localhost/pct/api_sync.php')
            .replace(/\/api_sync[^/]*\.php$/, '');
    }

    async function chiamaBackend(path, cf, payload) {
        const baseUrl = await getBackendBaseUrl();
        const stored = await new Promise(resolve =>
            chrome.storage.local.get(['apiToken'], resolve)
        );
        const apiToken = stored.apiToken || 'pct_aruba_2026_adb200f9';
        const resp = await chrome.runtime.sendMessage({
            action: 'syncToBackend',
            backendUrl: baseUrl + path,
            apiToken: apiToken,
            cfAvvocato: cf,
            data: payload,
        });
        return resp;
    }

    async function inviaProfilo(cf, forzaResidenza = false) {
        try {
            // Ultima sicurezza: se il DB ha già i dati anagrafici non interroghiamo
            // la pagina /profile del PdA. Con forzaResidenza si legge comunque,
            // perché la residenza sta solo su quella pagina.
            if (cf && cf.length === 16 && !forzaResidenza) {
                const dbState = await verificaCompletezzaDB(cf);
                if (dbState.complete && !dbState.needs_residenza) {
                    console.log('[PCT] Dashboard fetch: profilo già completo sul DB, nessuna richiesta a /profile');
                    allineaFlagLocali(cf, dbState);
                    return { ok: true, cf: cf };
                }
            }

            const resp = await fetch(PROFILE_URL, { credentials: 'include', cache: 'no-store' });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const html = await resp.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            const cfReale = normalizzaCf(estraiValoreDaDoc(doc, 'Codice Fiscale'));
            if (cfReale.length !== 16) {
                console.log('[PCT] Dashboard fetch: CF non trovato nell\'HTML');
                return { ok: false };
            }
            cf = cfReale;
            localStorage.setItem('pctLastCf', cf);

            const profilo = {
                codice_fiscale: cf,
                nome:           estraiValoreDaDoc(doc, 'Nome'),
                cognome:        estraiValoreDaDoc(doc, 'Cognome'),
                email:          estraiValoreDaDoc(doc, 'E-Mail'),
                pec:            estraiValoreDaDoc(doc, 'PEC'),
                ordine:         estraiValoreDaDoc(doc, 'Ordine'),
                ...estraiResidenzaDaDocumento(doc),
            };

            if (profilo.nome && profilo.cognome) {
                console.log('[PCT] Dashboard fetch: profilo estratto', profilo);
                const r = await chiamaBackend('/api_profilo_avvocato.php', cf, profilo);
                if (r && !r.error && r.result && r.result.success) {
                    console.log('[PCT] Dashboard fetch: profilo salvato');
                    invalidaCacheProfiloDB(cf);
                    localStorage.setItem('pctProfileComplete_' + cf, '1');
                    localStorage.setItem('pctProfileName_' + cf, profilo.nome + ' ' + profilo.cognome);
                    return { ok: true, cf: cf };
                }
                console.warn('[PCT] Dashboard fetch: backend non ha confermato', JSON.stringify(r));
            } else {
                console.log('[PCT] Dashboard fetch: nome/cognome non presenti nell\'HTML');
            }
        } catch (err) {
            console.error('[PCT] Dashboard fetch profilo errore:', err);
        }
        return { ok: false };
    }

    async function inviaTokenCalendario(cf) {
        try {
            const resp = await fetch(EXPORT_AGENDA_URL, { credentials: 'include', cache: 'no-store' });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const html = await resp.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const token = estraiTokenDaDoc(doc);
            if (!token) {
                console.log('[PCT] Dashboard fetch: token calendario non trovato nell\'HTML');
                return false;
            }
            console.log('[PCT] Dashboard fetch: token calendario estratto', token);
            const r = await chiamaBackend('/api_profilo_avvocato.php', cf, {
                codice_fiscale: cf,
                api_calendario: token,
            });
            if (r && !r.error && r.result && r.result.success) {
                console.log('[PCT] Dashboard fetch: token calendario salvato');
                invalidaCacheProfiloDB(cf);
                localStorage.setItem('pctCalendarToken_' + cf, token);
                return true;
            }
            console.warn('[PCT] Dashboard fetch: backend token non confermato', JSON.stringify(r));
        } catch (err) {
            console.error('[PCT] Dashboard fetch token errore:', err);
        }
        return false;
    }

    function openBackgroundScraper(url) {
        console.log('[PCT] Dashboard: apro tab di background fallback per', url);
        chrome.runtime.sendMessage({ action: 'openBackgroundScraper', url: url });
    }

    async function startAutoScrape(force = false) {
        if (!isDashboardPage()) return;
        if (window.__pctDashboardScraping && !force) return;
        window.__pctDashboardScraping = true;

        try {
            let cf = getCfFromStorage();

            // Se il CF non è noto, prova a leggerlo dalla pagina
            if (!cf) {
                cf = await getCfAvvocatoFromPage();
                if (cf && cf.length === 16) {
                    localStorage.setItem('pctLastCf', cf);
                }
            }

            // Verifica sul DB se il profilo è già completo.
            // "Completo" = tutti i campi di tab_avvocati popolati tranne email e
            // password: in quel caso la pagina /profile non va più interrogata.
            let dbState = { ...PROFILO_DB_VUOTO };
            if (cf && cf.length === 16) {
                dbState = await verificaCompletezzaDB(cf);
                console.log('[PCT] Dashboard: stato DB =', JSON.stringify(dbState));
                if (dbState.error) {
                    console.warn('[PCT] Dashboard: verifica profilo non disponibile (backend in errore): non apro finestre, riprovo più tardi');
                    return;
                }
                allineaFlagLocali(cf, dbState);

                if (dbState.complete && dbState.has_calendar && !dbState.needs_residenza) {
                    console.log('[PCT] Dashboard: profilo e token calendario già presenti nel DB');
                    return;
                }
            }

            // Il profilo è considerato già acquisito se lo dice il DB oppure il flag locale.
            let profileComplete = !!cf && (dbState.complete || localStorage.getItem('pctProfileComplete_' + cf) === '1');
            let tokenOk = !!cf && (dbState.has_calendar || hasCalendarToken(cf));

            // 1) Prova a ricavare CF, nome e cognome direttamente dal saluto dashboard
            if (!cf || !profileComplete) {
                console.log('[PCT] Dashboard: provo a leggere profilo dal saluto');
                const ok = await sincronizzaProfiloDaDashboard();
                if (ok) {
                    cf = getCfFromStorage();
                    profileComplete = true;
                }
            }

            // 2) Prova a recuperare il profilo via fetch della pagina profilo.
            //    Non viene eseguito se il DB ha già i dati anagrafici.
            let profiloLetto = false;
            if (!cf || !profileComplete) {
                console.log('[PCT] Dashboard: provo scraping profilo via fetch');
                const res = await inviaProfilo(cf || 'TEMP');
                profiloLetto = true;
                if (res.ok) {
                    cf = res.cf || getCfFromStorage();
                    profileComplete = true;
                }
            } else {
                console.log('[PCT] Dashboard: profilo già completo, salto la pagina /profile');
            }

            // 2b) La residenza sta solo nel riquadro "Residenza" della pagina
            //     /profile: se manca la si legge una volta, con la stessa fetch
            //     (nessuna finestra in più). Il backend segna la lettura, quindi
            //     questo passaggio non si ripete ad ogni giro.
            if (cf && cf.length === 16 && dbState.needs_residenza && !profiloLetto) {
                console.log('[PCT] Dashboard: leggo la residenza dalla pagina /profile');
                const resRes = await inviaProfilo(cf, true);
                if (resRes.ok) invalidaCacheProfiloDB(cf);
            }

            // Se ora ho il CF, provo a recuperare il token calendario via fetch
            if (cf && !tokenOk) {
                console.log('[PCT] Dashboard: provo scraping token calendario via fetch');
                const ok = await inviaTokenCalendario(cf);
                if (ok) tokenOk = true;
            }

            // Fallback a tab di background solo se il fetch non è bastato
            if (!profileComplete) {
                console.log('[PCT] Dashboard: fetch profilo non riuscito, uso tab di background');
                openBackgroundScraper(PROFILE_URL);
            } else if (!tokenOk) {
                console.log('[PCT] Dashboard: fetch token non riuscito, uso tab di background');
                openBackgroundScraper(EXPORT_AGENDA_URL);
            }
        } finally {
            window.__pctDashboardScraping = false;
        }
    }

    function init() {
        injectNetworkInterceptor();

        window.addEventListener('message', (event) => {
            if (event.source !== window) return;
            const msg = event.data;
            if (msg && msg.type === 'pct-network-response' && msg.url && msg.text) {
                console.log('[PCT] Network: risposta intercettata da', msg.url);
                elaboraRispostaNetwork(msg.url, msg.text);
            }
            // Schede del fascicolo: si archivia anche la risposta vuota, perche'
            // "nessun risultato" e' un'informazione (i Lotti vuoti del Portale
            // non devono sembrare una scheda mai letta).
            if (msg && msg.type === 'pct-network-response' && msg.url && !msg.text) {
                archiviaSezionePda(msg.url, '');
            }
            // Tracing API PdA: inoltra al background che lo registra sul backend
            // (api_pda_trace.php) per mappare le API REST da replicare server-side.
            if (msg && msg.type === 'pct-api-trace' && msg.entry) {
                try {
                    chrome.runtime.sendMessage({ action: 'pdaTrace', entry: msg.entry }, () => {
                        void chrome.runtime.lastError; // nessuna risposta attesa
                    });
                } catch (e) {}
            }
            // Token Keycloak del PdA catturato dall'interceptor: il background lo
            // conserva in storage per avviare i job server-side (download documenti).
            if (msg && msg.type === 'pct-pda-token' && msg.access) {
                try {
                    chrome.runtime.sendMessage({ action: 'pdaToken', access: msg.access, refresh: msg.refresh || '' }, () => {
                        void chrome.runtime.lastError;
                    });
                } catch (e) {}
            }
        });

        const run = () => setTimeout(() => startAutoScrape(), 1500);
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', run);
        } else {
            run();
        }

        let lastUrl = window.location.href;
        new MutationObserver(() => {
            if (window.location.href !== lastUrl) {
                lastUrl = window.location.href;
                run();
            }
        }).observe(document, { subtree: true, childList: true });

        // Ritenta ogni 30s finché profilo+token non sono completi
        setInterval(() => {
            const cf = getCfFromStorage();
            const complete = cf && localStorage.getItem('pctProfileComplete_' + cf) === '1' && hasCalendarToken(cf);
            if (!complete) startAutoScrape(true);
        }, 30000);
    }

    init();
})();

// ─── Auto-import profilo avvocato — pagina profilo ────────────────────────────
/**
 * Quando l'utente è su /profile del PdA, estrae i dati anagrafici
 * (CF, nome, cognome, email, PEC, ordine), controlla sul backend se il profilo
 * è completo e, se necessario, invia i dati al backend per aggiornare il DB.
 * Al termine, se era stata avviata dalla dashboard, torna alla dashboard.
 */
(function initProfileImport() {
    'use strict';

    const PROFILE_URL       = 'https://www.giustizia.toscana.it/pda-rt/cancelleriatelematica/profile';
    const EXPORT_AGENDA_URL = 'https://www.giustizia.toscana.it/pda-rt/cancelleriatelematica/esportazione-agenda';

    function isProfilePage() {
        return window.location.href.includes('/cancelleriatelematica/profile');
    }

    function isBackgroundMode() {
        if (window.name === 'pctBackground') return true;
        if (window.location.search.includes('pctBackground=1')) return true;
        if (sessionStorage.getItem('pctBackgroundMode') === '1') return true;
        return false;
    }

    function markBackgroundMode() {
        window.name = 'pctBackground';
        sessionStorage.setItem('pctBackgroundMode', '1');
    }

    function normalizzaLabel(label) {
        return label.toLowerCase().replace(/[-\s]+/g, '').replace(/[^a-z0-9]/g, '');
    }

    /**
     * Estrae il valore associato a una label nella pagina profilo.
     * Usa prima un'estrazione regex sul testo visibile, poi vari fallback DOM.
     */
    function estraiValore(label) {
        const norm = normalizzaLabel(label);
        const pageText = document.body ? document.body.innerText : '';
        const cleaned = pageText.replace(/\n+/g, '\n').replace(/\s+/g, ' ');
        const lowerLabel = label.toLowerCase();

        // Estrazione via regex per le label note
        const patterns = {
            'codice fiscale': /\bCodice\s+Fiscale\b[\s:]*([A-Z0-9]{16})/i,
            'nome': /\bNome\b[\s:]*([A-Z][A-Za-z\s]*?)\s*(?=\bCognome\b|\bComune\s+di\s+nascita\b|\bData\s+di\s+nascita\b|\bE[-\s]?Mail\b|\bPEC\b|\bTelefono\b|\bOrdine\b|$)/i,
            'cognome': /\bCognome\b[\s:]*([A-Z][A-Za-z\s]*?)\s*(?=\bComune\s+di\s+nascita\b|\bData\s+di\s+nascita\b|\bE[-\s]?Mail\b|\bPEC\b|\bTelefono\b|\bOrdine\b|$)/i,
            'e-mail': /\bE[-\s]?Mail\b[\s:]*([^\s]+@[^\s]+)/i,
            'pec': /\bPEC\b[\s:]*([^\s]+@[^\s]+)/i,
            'ordine': /\bOrdine\b[\s:]*(.+?)\s*(?=\bResidenza\b|\bIndirizzo\b|\bCAP\b|\bComune\b|$)/i,
        };

        if (patterns[lowerLabel]) {
            const m = cleaned.match(patterns[lowerLabel]);
            if (m && m[1]) {
                const val = m[1].replace(/\s+/g, ' ').trim();
                if (val) return val;
            }
        }

        // Fallback 0: label in elemento bold/strong con valore in sibling/testo successivo
        const boldLabels = document.querySelectorAll('strong, b, .font-weight-bold, .modal-font-bold, [class*="bold"]');
        for (const el of boldLabels) {
            const text = normalizzaLabel(el.textContent);
            if (text === norm || text === norm + ':') {
                // valore nel testo rimanente dello stesso elemento o nel sibling
                const own = el.textContent.replace(/^[^:]*:?\s*/, '').replace(/\s+/g, ' ').trim();
                if (own && normalizzaLabel(own) !== norm) return own;
                let next = el.nextSibling;
                while (next) {
                    const t = (next.textContent || '').trim();
                    if (t) return t.replace(/\s+/g, ' ').trim();
                    next = next.nextSibling;
                }
                const nextEl = el.nextElementSibling || el.parentElement?.nextElementSibling;
                if (nextEl) return nextEl.textContent.replace(/\s+/g, ' ').trim();
            }
        }

        // Fallback 0b: per CF, cerca un pattern 16 caratteri vicino alla label
        if (lowerLabel === 'codice fiscale') {
            const cfMatch = cleaned.match(/\b([A-Z0-9]{16})\b/);
            if (cfMatch) return cfMatch[1].toUpperCase();
        }

        // Fallback 1: righe di tabella o griglia bootstrap
        const rows = document.querySelectorAll('table tr, .row, [class*="profile"], [class*="detail"], dl, [class*="form-group"]');
        for (const row of rows) {
            const cells = row.querySelectorAll('td, th, dt, dd, .col-md-3, .col-md-4, .col-md-6, .col-6, .col-sm-3, .col-sm-4, .col-sm-6');
            for (let i = 0; i < cells.length - 1; i++) {
                const cellText = normalizzaLabel(cells[i].textContent);
                if (cellText === norm || cellText.startsWith(norm + ':')) {
                    return cells[i + 1].textContent.replace(/\s+/g, ' ').trim();
                }
            }
        }

        // Fallback 2: cerca elemento il cui testo diretto è la label e prende sibling successivo
        const all = document.querySelectorAll('p, div, span, label, td, th, li, dt');
        for (const el of all) {
            const directText = (el.childNodes[0]?.textContent || el.textContent || '').toLowerCase().replace(/[-\s:]+/g, '').trim();
            if (directText === norm || directText === norm + ':') {
                const own = el.textContent.replace(/^[^:]*:?\s*/, '').replace(/\s+/g, ' ').trim();
                if (own && normalizzaLabel(own) !== norm) return own;
                const next = el.nextElementSibling;
                if (next) return next.textContent.replace(/\s+/g, ' ').trim();
            }
        }

        // Fallback 3: tree walker
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while ((node = walker.nextNode())) {
            const text = normalizzaLabel(node.textContent);
            if (text === norm || text.startsWith(norm + ':')) {
                const own = node.textContent.split(':').slice(1).join(':').replace(/\s+/g, ' ').trim();
                if (own) return own;
                const parent = node.parentElement;
                if (parent && parent.nextElementSibling) {
                    return parent.nextElementSibling.textContent.replace(/\s+/g, ' ').trim();
                }
                let sib = node.nextSibling;
                while (sib) {
                    const t = (sib.textContent || '').trim();
                    if (t) return t.replace(/\s+/g, ' ').trim();
                    sib = sib.nextSibling;
                }
            }
        }
        return '';
    }

    function normalizzaCf(cf) {
        return (cf || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
    }

    async function getBackendBaseUrl() {
        const stored = await new Promise(resolve =>
            chrome.storage.local.get(['backendUrl'], resolve)
        );
        return (stored.backendUrl || 'http://localhost/pct/api_sync.php')
            .replace(/\/api_sync[^/]*\.php$/, '');
    }

    async function chiamaBackend(path, cf, payload = null) {
        const baseUrl = await getBackendBaseUrl();
        const stored = await new Promise(resolve =>
            chrome.storage.local.get(['apiToken'], resolve)
        );
        const apiToken = stored.apiToken || 'pct_aruba_2026_adb200f9';
        const data = payload ? payload : { codice_fiscale: cf };
        const resp = await chrome.runtime.sendMessage({
            action: 'syncToBackend',
            backendUrl: baseUrl + path,
            apiToken: apiToken,
            cfAvvocato: cf,
            data: data,
        });
        return resp;
    }

    async function sincronizzaProfilo(cf) {
        const profilo = {
            codice_fiscale: cf,
            nome:           estraiValore('Nome'),
            cognome:        estraiValore('Cognome'),
            email:          estraiValore('E-Mail'),
            pec:            estraiValore('PEC'),
            ordine:         estraiValore('Ordine'),
            ...estraiResidenzaDaDocumento(document),
        };

        if (!profilo.nome || !profilo.cognome) {
            console.log('[PCT] Profilo: nome/cognome mancanti, attendo...');
            return false;
        }

        console.log('[PCT] Profilo estratto:', profilo);
        const resp = await chiamaBackend('/api_profilo_avvocato.php', cf, profilo);
        if (resp && !resp.error && resp.result && resp.result.success) {
            console.log('[PCT] Profilo sincronizzato sul backend (id=' + resp.result.id + ', created=' + resp.result.created + ')');
            return true;
        }
        console.warn('[PCT] Profilo: backend non ha confermato', JSON.stringify(resp));
        return false;
    }

    async function elaboraProfilo() {
        const background = isBackgroundMode();
        if (background) markBackgroundMode();

        const cf = normalizzaCf(estraiValore('Codice Fiscale'));
        if (cf.length !== 16) {
            console.log('[PCT] Profilo: CF non trovato o non valido, attendo...');
            return false;
        }

        // Salva subito il CF per poterlo usare anche per il token calendario
        localStorage.setItem('pctLastCf', cf);

        // Stato sul DB: il profilo è "completo" quando tutti i campi di
        // tab_avvocati sono valorizzati tranne email e password. In quel caso
        // non si estrae più nulla da questa pagina.
        const dbState = await verificaCompletezzaDB(cf);
        allineaFlagLocali(cf, dbState);

        if (dbState.error) {
            console.warn('[PCT] Profilo: verifica DB non disponibile (backend in errore): non ri-sincronizzo ora');
            if (background) {
                chrome.runtime.sendMessage({ action: 'closeBackgroundTab' });
            }
            return true;
        }

        // Siamo proprio sulla pagina che contiene la residenza: se sul DB manca,
        // si rilegge anche quando l'anagrafica risulta completa. Non costa una
        // richiesta in piu' (la pagina e' gia' aperta) e recupera i casi in cui
        // la lettura via fetch dalla dashboard non aveva agganciato nulla.
        const serveResidenza = dbState.needs_residenza || dbState.residenza_vuota;

        if (dbState.complete && !serveResidenza) {
            if (dbState.has_calendar) {
                console.log('[PCT] Profilo: dati già presenti nel DB, nessun re-scraping');
                if (background) {
                    chrome.runtime.sendMessage({ action: 'closeBackgroundTab' });
                }
                return true;
            }
            // Anagrafica a posto: manca solo il token calendario, che sta su
            // un'altra pagina. Non serve leggere i campi del profilo.
            console.log('[PCT] Profilo: anagrafica già completa sul DB, manca solo il token calendario');
            if (background) {
                window.location.href = EXPORT_AGENDA_URL + '?pctBackground=1';
            }
            return true;
        }
        if (dbState.complete && serveResidenza) {
            console.log('[PCT] Profilo: anagrafica completa ma residenza assente, la leggo da questa pagina');
        }

        const saved = await sincronizzaProfilo(cf);
        if (saved) {
            const nome    = estraiValore('Nome');
            const cognome = estraiValore('Cognome');
            invalidaCacheProfiloDB(cf);
            localStorage.setItem('pctProfileComplete_' + cf, '1');
            if (nome && cognome) {
                localStorage.setItem('pctProfileName_' + cf, nome + ' ' + cognome);
            }
            console.log('[PCT] Profilo sincronizzato per', cf);
        } else {
            console.warn('[PCT] Profilo: sincronizzazione fallita per', cf);
            return false;
        }

        // Modalità background: naviga verso Esportazione Agenda se manca il token,
        // altrimenti chiudi la tab.
        if (background) {
            if (!localStorage.getItem('pctCalendarToken_' + cf)) {
                console.log('[PCT] Profilo background: navigo verso Esportazione Agenda per catturare il token calendario');
                window.location.href = EXPORT_AGENDA_URL + '?pctBackground=1';
                return true;
            }
            console.log('[PCT] Profilo background: token già presente, chiudo tab');
            chrome.runtime.sendMessage({ action: 'closeBackgroundTab' });
            return true;
        }

        return true;
    }

    async function tentaElaborazione(tentativi = 80) {
        for (let i = 0; i < tentativi; i++) {
            if (!isProfilePage()) return;
            if (await elaboraProfilo()) return;
            await new Promise(r => setTimeout(r, 750));
        }
        console.warn('[PCT] Profilo: impossibile elaborare dopo ' + tentativi + ' tentativi');
        if (isBackgroundMode()) {
            console.log('[PCT] Profilo background: chiudo tab per fallimento');
            chrome.runtime.sendMessage({ action: 'closeBackgroundTab' });
        }
    }

    function avviaSeNecessario() {
        if (!isProfilePage()) return;
        if (window.__pctProfileImportRunning) return;
        window.__pctProfileImportRunning = true;
        tentaElaborazione().finally(() => {
            window.__pctProfileImportRunning = false;
        });
    }

    let lastUrl = window.location.href;
    new MutationObserver(() => {
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            avviaSeNecessario();
        }
    }).observe(document, { subtree: true, childList: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => avviaSeNecessario());
    } else {
        avviaSeNecessario();
    }
})();

// ─── Cattura token calendario da Esportazione Agenda ──────────────────────────
/**
 * Sulla pagina /esportazione-agenda estrae il token pubblico del calendario
 * dall'URL mostrato e lo salva in tab_avvocati.api_calendario.
 */
(function initCalendarTokenCapture() {
    'use strict';

    function isExportAgendaPage() {
        return window.location.href.includes('/cancelleriatelematica/esportazione-agenda');
    }

    function isBackgroundMode() {
        if (window.name === 'pctBackground') return true;
        if (window.location.search.includes('pctBackground=1')) return true;
        if (sessionStorage.getItem('pctBackgroundMode') === '1') return true;
        return false;
    }

    function markBackgroundMode() {
        window.name = 'pctBackground';
        sessionStorage.setItem('pctBackgroundMode', '1');
    }

    function getCfFromStorage() {
        // Usa l'ultimo CF sincronizzato
        const lastCf = localStorage.getItem('pctLastCf');
        if (lastCf) return lastCf;

        // Altrimenti cerca tra i flag di profilo completo
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('pctProfileComplete_')) {
                return key.replace('pctProfileComplete_', '');
            }
        }
        return '';
    }

    function estraiTokenCalendario() {
        const CALENDAR_BASE = 'https://www.giustizia.toscana.it/pda-rt/api/pda-batch/public/calendar/';

        // 1) Cerca in qualsiasi input/textarea con il percorso /calendar/
        const inputs = document.querySelectorAll('input, textarea');
        for (const input of inputs) {
            const val = (input.value || input.placeholder || '').trim();
            const m = val.match(/\/calendar\/([a-f0-9]+)/i);
            if (m) return CALENDAR_BASE + m[1];
        }

        // 2) Cerca in link/anchor con href che contiene /calendar/
        const links = document.querySelectorAll('a[href*="/calendar/"]');
        for (const link of links) {
            const href = (link.href || '').trim();
            const m = href.match(/\/calendar\/([a-f0-9]+)/i);
            if (m) return CALENDAR_BASE + m[1];
        }

        // 3) Cerca nel testo visibile della pagina
        const pageText = document.body ? document.body.innerText : '';
        const m = pageText.match(/\/calendar\/([a-f0-9]+)/i);
        if (m) return CALENDAR_BASE + m[1];

        // 4) Cerca nell'HTML grezzo
        const html = document.body ? document.body.innerHTML : '';
        const m2 = html.match(/\/calendar\/([a-f0-9]+)/i);
        if (m2) return CALENDAR_BASE + m2[1];

        return '';
    }

    async function getBackendBaseUrl() {
        const stored = await new Promise(resolve =>
            chrome.storage.local.get(['backendUrl'], resolve)
        );
        return (stored.backendUrl || 'http://localhost/pct/api_sync.php')
            .replace(/\/api_sync[^/]*\.php$/, '');
    }

    async function inviaToken(cf, token) {
        const baseUrl = await getBackendBaseUrl();
        const stored = await new Promise(resolve =>
            chrome.storage.local.get(['apiToken'], resolve)
        );
        const apiToken = stored.apiToken || 'pct_aruba_2026_adb200f9';
        const background = isBackgroundMode();

        try {
            console.log('[PCT] Token calendario: invio per CF', cf, 'token', token);
            const resp = await chrome.runtime.sendMessage({
                action: 'syncToBackend',
                backendUrl: baseUrl + '/api_profilo_avvocato.php',
                apiToken: apiToken,
                cfAvvocato: cf,
                data: {
                    codice_fiscale: cf,
                    api_calendario: token,
                },
            });

            console.log('[PCT] Token calendario risposta:', JSON.stringify(resp));

            if (resp && !resp.error && resp.result && resp.result.success) {
                console.log('[PCT] Token calendario salvato per', cf);
                invalidaCacheProfiloDB(cf);
                localStorage.setItem('pctCalendarToken_' + cf, token);

                if (background) {
                    console.log('[PCT] Token calendario background: chiudo tab');
                    chrome.runtime.sendMessage({ action: 'closeBackgroundTab' });
                }

                return true;
            }
            console.warn('[PCT] Token calendario: backend non ha confermato', JSON.stringify(resp));
        } catch (err) {
            console.error('[PCT] Token calendario errore:', err);
        }
        return false;
    }

    async function cercaTokenViaNetwork() {
        // Prova a interrogare direttamente l'endpoint pubblico del calendario
        // usando un CF noto: spesso l'ID è restituito da altre API.
        try {
            const cf = getCfFromStorage();
            if (!cf) return '';

            // Endpoint che restituisce i dati dell'utente loggato
            const endpoints = [
                'https://www.giustizia.toscana.it/pda-rt/api/pda-utenti/v1/public/utenti',
                'https://www.giustizia.toscana.it/pda-rt/api/pda-batch/public/calendars',
            ];
            for (const url of endpoints) {
                try {
                    const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
                    if (!r.ok) continue;
                    const text = await r.text();
                    const m = text.match(/\/calendar\/([a-f0-9]+)/i);
                    if (m) return 'https://www.giustizia.toscana.it/pda-rt/api/pda-batch/public/calendar/' + m[1];
                } catch (e) {}
            }
        } catch (e) {}
        return '';
    }

    async function elaboraToken() {
        const background = isBackgroundMode();
        if (background) markBackgroundMode();

        const cf = getCfFromStorage();
        if (!cf || cf.length !== 16) {
            console.warn('[PCT] Token calendario: CF non disponibile in memoria');
            return false;
        }

        // Se il DB ha già il token calendario, non fare scraping
        const dbState = await verificaCompletezzaDB(cf);
        allineaFlagLocali(cf, dbState);
        if (dbState.has_calendar) {
            console.log('[PCT] Token calendario: già presente nel DB, chiudo tab senza re-scraping');
            if (background) {
                chrome.runtime.sendMessage({ action: 'closeBackgroundTab' });
            }
            return true;
        }

        let token = estraiTokenCalendario();
        if (!token) {
            token = await cercaTokenViaNetwork();
        }
        if (!token) {
            console.log('[PCT] Token calendario non trovato, attendo...');
            return false;
        }
        console.log('[PCT] Token calendario estratto:', token);

        // Evita di inviare lo stesso token già salvato
        const saved = localStorage.getItem('pctCalendarToken_' + cf);
        if (saved === token) {
            console.log('[PCT] Token calendario già salvato per', cf);
            if (background) {
                console.log('[PCT] Token calendario background: già salvato, chiudo tab');
                chrome.runtime.sendMessage({ action: 'closeBackgroundTab' });
            }
            return true;
        }

        return await inviaToken(cf, token);
    }

    async function tentaElaborazione(tentativi = 60) {
        for (let i = 0; i < tentativi; i++) {
            if (!isExportAgendaPage()) return;
            if (await elaboraToken()) return;
            await new Promise(r => setTimeout(r, 750));
        }
        console.warn('[PCT] Token calendario: impossibile salvare dopo ' + tentativi + ' tentativi');
        if (isBackgroundMode()) {
            console.log('[PCT] Token calendario background: chiudo tab per fallimento');
            chrome.runtime.sendMessage({ action: 'closeBackgroundTab' });
        }
    }

    function avviaSeNecessario() {
        if (!isExportAgendaPage()) return;
        if (window.__pctCalendarTokenRunning) return;
        window.__pctCalendarTokenRunning = true;
        tentaElaborazione().finally(() => {
            window.__pctCalendarTokenRunning = false;
        });
    }

    let lastUrl = window.location.href;
    new MutationObserver(() => {
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            avviaSeNecessario();
        }
    }).observe(document, { subtree: true, childList: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => avviaSeNecessario());
    } else {
        avviaSeNecessario();
    }
})();

// ─── Banner flottante ─────────────────────────────────────────────────────────
/**
 * Inietta il banner flottante PCT Monitor nella pagina del fascicolo.
 * Il banner riusa le stesse funzioni di scraping già presenti (scrapeAll, getFieldValue, ecc.).
 * Viene mostrato solo sulle pagine dettaglio-fascicolo e può essere chiuso
 * (la chiusura viene salvata in sessionStorage per non riapparire nella sessione).
 */
(function() {
    'use strict';

    function initBanner() {
        // Esegui solo su pagine dettaglio-fascicolo
        if (!window.location.href.includes('dettaglio-fascicolo')) return;

        // Se minimizzato, mostra solo il mini-bottone (non bloccare l'init)

        // Evita doppia iniezione
        if (document.getElementById('pct-floating-banner')) return;

        // ── Costanti ──────────────────────────────────────────────────────────────
        const BANNER_ID      = 'pct-floating-banner';
        const STYLE_ID       = 'pct-banner-style';
        const DASHBOARD_URL  = 'http://localhost/pct/';

        // ── Stili ─────────────────────────────────────────────────────────────────
    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #pct-floating-banner {
                position: fixed;
                bottom: 24px;
                right: 24px;
                z-index: 999999;
                width: 300px;
                background: #ffffff;
                border: 1px solid #e0e0e0;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                padding: 16px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 13px;
                color: #333;
                animation: pct-slide-up 0.35s cubic-bezier(0.22,1,0.36,1) both;
                box-sizing: border-box;
            }

            #pct-mini-panel {
                position: fixed;
                bottom: 80px;
                right: 24px;
                z-index: 999999;
                width: 320px;
                background: #ffffff;
                border: 1px solid #e0e0e0;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                padding: 16px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 13px;
                color: #333333;
                display: none;
                box-sizing: border-box;
            }
            #pct-mini-panel * { box-sizing: border-box; }
            #pct-mini-panel-header {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 12px;
            }
            #pct-mini-panel-icon {
                width: 24px;
                height: 24px;
                border-radius: 4px;
                flex-shrink: 0;
            }
            #pct-mini-panel-title {
                font-size: 14px;
                font-weight: bold;
                flex: 1;
                color: #222;
            }
            #pct-mini-panel-close {
                background: none;
                border: none;
                font-size: 16px;
                cursor: pointer;
                color: #999;
                padding: 0;
                line-height: 1;
            }
            #pct-mini-panel-close:hover { color: #333; }
            .pct-mini-status {
                display: flex;
                align-items: center;
                gap: 6px;
                color: #28a745;
                font-weight: 500;
                margin-bottom: 12px;
            }
            .pct-mini-dot {
                width: 8px;
                height: 8px;
                background-color: #28a745;
                border-radius: 50%;
                display: inline-block;
            }
            #pct-mini-panel-info {
                background: #f8f9fa;
                border: 1px solid #eee;
                border-radius: 4px;
                padding: 8px;
                margin-bottom: 12px;
            }
            #pct-mini-panel-numero {
                font-weight: bold;
                color: #0056b3;
                margin-bottom: 4px;
            }
            #pct-mini-panel-oggetto {
                color: #555;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            #pct-mini-panel-btn-sync {
                width: 100%;
                padding: 8px 0;
                background: #0056b3;
                color: #fff;
                border: none;
                border-radius: 4px;
                font-weight: bold;
                cursor: pointer;
                margin-bottom: 12px;
            }
            #pct-mini-panel-btn-sync:hover { background: #004494; }
            #pct-mini-panel-btn-sync:disabled { background: #999; cursor: not-allowed; }
            
            #pct-mini-panel-progress-wrap {
                display: none;
                margin-bottom: 12px;
            }
            #pct-mini-panel-progress-bar {
                width: 100%;
                height: 6px;
                background: #e9ecef;
                border-radius: 3px;
                overflow: hidden;
                margin-bottom: 4px;
            }
            #pct-mini-panel-progress-fill {
                height: 100%;
                background: #28a745;
                width: 0%;
                transition: width 0.3s ease;
            }
            #pct-mini-panel-progress-label {
                font-size: 11px;
                color: #666;
                text-align: center;
            }
            #pct-mini-panel-footer {
                display: flex;
                justify-content: space-between;
                font-size: 11px;
            }
            #pct-mini-panel-footer a {
                color: #0056b3;
                text-decoration: none;
            }
            #pct-mini-panel-footer a:hover { text-decoration: underline; }

            #pct-floating-banner.pct-hiding {
                animation: pct-slide-down 0.3s cubic-bezier(0.55,0,1,0.45) both;
            }
            @keyframes pct-slide-up {
                from { transform: translateY(120%); opacity: 0; }
                to   { transform: translateY(0);    opacity: 1; }
            }
            @keyframes pct-slide-down {
                from { transform: translateY(0);    opacity: 1; }
                to   { transform: translateY(120%); opacity: 0; }
            }
            #pct-floating-banner * { box-sizing: border-box; }
            #pct-banner-header {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 12px;
            }
            #pct-banner-logo {
                width: 24px;
                height: 24px;
                border-radius: 4px;
                flex-shrink: 0;
            }
            #pct-banner-title {
                font-size: 14px;
                font-weight: 700;
                color: #222;
                flex: 1;
            }
            #pct-banner-close {
                background: none;
                border: none;
                color: #999;
                font-size: 16px;
                cursor: pointer;
                padding: 0 2px;
                line-height: 1;
                flex-shrink: 0;
            }
            #pct-banner-close:hover { color: #333; }
            #pct-mini-btn {
                position: fixed;
                bottom: 24px;
                right: 24px;
                z-index: 999999;
                background: transparent;
                border: none;
                border-radius: 50%;
                width: 48px;
                height: 48px;
                padding: 0;
                cursor: pointer;
                box-shadow: none;
                display: none;
                align-items: center;
                justify-content: center;
                transition: transform 0.2s;
                overflow: hidden;
            }
            #pct-mini-btn:hover { transform: scale(1.15); }
            #pct-mini-btn img {
                width: 48px;
                height: 48px;
                border-radius: 0;
                display: block;
            }
            #pct-banner-info {
                background: #f8f9fa;
                border: 1px solid #eee;
                border-radius: 4px;
                padding: 8px 10px;
                margin-bottom: 12px;
                font-size: 12px;
                line-height: 1.5;
            }
            #pct-banner-numero {
                font-weight: 700;
                color: #0056b3;
                font-size: 13px;
            }
            #pct-banner-oggetto {
                color: #555;
                margin-top: 2px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            #pct-banner-loading {
                color: #666;
                font-size: 13px;
                text-align: center;
                padding: 6px 0;
                display: none;
            }
            #pct-banner-loading .pct-dots span {
                animation: pctDotPulse 1.4s infinite ease-in-out both;
                display: inline-block;
                width: 5px; height: 5px;
                margin: 0 2px;
                background: #999;
                border-radius: 50%;
            }
            #pct-banner-loading .pct-dots span:nth-child(2) { animation-delay: 0.2s; }
            #pct-banner-loading .pct-dots span:nth-child(3) { animation-delay: 0.4s; }
            @keyframes pctDotPulse {
                0%, 80%, 100% { opacity: 0.3; transform: scale(0.7); }
                40% { opacity: 1; transform: scale(1); }
            }
            #pct-banner-btn-sync {
                display: block;
                width: 100%;
                padding: 8px 0;
                background: #0056b3;
                color: #fff;
                border: none;
                border-radius: 4px;
                font-size: 14px;
                font-weight: 700;
                cursor: pointer;
                transition: background 0.18s;
                margin-bottom: 12px;
            }
            #pct-banner-btn-sync:hover:not(:disabled) { background: #004494; }
            #pct-banner-btn-sync:disabled { background: #999; cursor: not-allowed; }
            #pct-banner-last-sync {
                font-size: 11px;
                color: #999;
                text-align: center;
                margin-bottom: 8px;
                min-height: 14px;
            }
            #pct-banner-progress-wrap {
                display: none;
                margin-bottom: 8px;
            }
            #pct-banner-progress-bar {
                width: 100%;
                height: 6px;
                background: #e9ecef;
                border-radius: 3px;
                overflow: hidden;
                margin-bottom: 4px;
            }
            #pct-banner-progress-fill {
                height: 100%;
                background: #28a745;
                border-radius: 3px;
                width: 0%;
                transition: width 0.3s ease;
            }
            #pct-banner-progress-label {
                font-size: 11px;
                color: #666;
                text-align: center;
            }
            #pct-banner-result {
                display: none;
                font-size: 12px;
                border-radius: 4px;
                padding: 7px 10px;
                margin-bottom: 8px;
                text-align: center;
                font-weight: 600;
            }
            #pct-banner-result.pct-success {
                background: #d4edda;
                color: #155724;
                border: 1px solid #c3e6cb;
            }
            #pct-banner-result.pct-error {
                background: #f8d7da;
                color: #721c24;
                border: 1px solid #f5c6cb;
            }
            #pct-banner-result.pct-warning {
                background: #fff3cd;
                color: #856404;
                border: 1px solid #ffc107;
            }
            #pct-banner-footer {
                display: flex;
                justify-content: space-between;
                font-size: 11px;
            }
            #pct-banner-link-dashboard {
                color: #0056b3;
                font-size: 11px;
                text-decoration: none;
            }
            #pct-banner-link-dashboard:hover { text-decoration: underline; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    // ── HTML del banner ───────────────────────────────────────────────────────
    const banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.innerHTML = `
        <div id="pct-banner-header">
            <img id="pct-banner-logo" src="${chrome.runtime.getURL('icon48.png')}" alt="PCT">
            <span id="pct-banner-title">PCT Monitor</span>
            <button id="pct-banner-close" title="Chiudi">&times;</button>
        </div>
        <div class="pct-mini-status">
            <span class="pct-mini-dot"></span> Fascicolo PdA rilevato
        </div>
        <div id="pct-banner-info">
            <div id="pct-banner-numero">—</div>
            <div id="pct-banner-oggetto">—</div>
        </div>
        <div id="pct-banner-loading">Caricamento fascicolo <span class="pct-dots"><span></span><span></span><span></span></span></div>
        <button id="pct-banner-btn-sync">Sincronizza fascicolo corrente</button>
        <div id="pct-banner-last-sync"></div>
        <div id="pct-banner-progress-wrap">
            <div id="pct-banner-progress-bar">
                <div id="pct-banner-progress-fill"></div>
            </div>
            <div id="pct-banner-progress-label"></div>
        </div>
        <div id="pct-banner-result"></div>
        <div id="pct-banner-footer">
            <a id="pct-banner-link-dashboard" href="${DASHBOARD_URL}" target="_blank" rel="noopener">Apri Dashboard</a>
        </div>
    `;
    document.body.appendChild(banner);
    pctAggiornaLinkDashboard();

    // ── Pannello sync: overlay fullscreen sulla pagina della Cancelleria ──
    const syncOverlay = document.createElement('div');
    syncOverlay.id = 'pct-sync-overlay';
    syncOverlay.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:18px;">
            <div class="pct-spinner"></div>
            <div id="pct-sync-overlay-label" style="font-size:18px;font-weight:600;color:#fff;">Sincronizzazione in corso...</div>
            <div id="pct-sync-overlay-detail" style="font-size:14px;color:#ccc;">Non chiudere e non cambiare pagina</div>
            <button id="pct-banner-btn-stop" style="margin-top:10px;background:#c0392b;color:#fff;border:none;padding:8px 22px;border-radius:6px;cursor:pointer;font-size:14px;">Ferma sincronizzazione</button>
        </div>
    `;
    const overlayStyle = document.createElement('style');
    overlayStyle.textContent = `
        #pct-sync-overlay {
            display: none;
            position: fixed; inset: 0;
            background: rgba(0,0,0,0.65);
            z-index: 999999;
            justify-content: center; align-items: center;
        }
        #pct-sync-overlay.active { display: flex; }
        .pct-spinner {
            width: 56px; height: 56px;
            border: 5px solid rgba(255,255,255,0.25);
            border-top-color: #fff;
            border-radius: 50%;
            animation: pct-spin 0.8s linear infinite;
        }
        @keyframes pct-spin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(overlayStyle);
    document.body.appendChild(syncOverlay);

    // ── Mini-bottone (visibile quando banner minimizzato) ────────────────────
    const miniBtn = document.createElement('button');
    miniBtn.id = 'pct-mini-btn';
    miniBtn.title = 'PCT Monitor';
    const miniIcon = document.createElement('img');
    miniIcon.src = chrome.runtime.getURL('icon48.png');
    miniIcon.alt = 'PCT';
    miniBtn.appendChild(miniIcon);
    document.body.appendChild(miniBtn);

    // ── Mini-pannello inline ──────────────────────────────────────────────────
    const miniPanel = document.createElement('div');
    miniPanel.id = 'pct-mini-panel';
    miniPanel.innerHTML = `
        <div id="pct-mini-panel-header">
            <img id="pct-mini-panel-icon" src="${chrome.runtime.getURL('icon48.png')}" alt="PCT">
            <span id="pct-mini-panel-title">PCT Monitor</span>
            <button id="pct-mini-panel-close" title="Chiudi">&times;</button>
        </div>
        <div class="pct-mini-status">
            <span class="pct-mini-dot"></span> Fascicolo PdA rilevato
        </div>
        <div id="pct-mini-panel-info">
            <div id="pct-mini-panel-numero">—</div>
            <div id="pct-mini-panel-oggetto">—</div>
        </div>
        <button id="pct-mini-panel-btn-sync">Sincronizza fascicolo corrente</button>
        
        <div id="pct-mini-panel-progress-wrap">
            <div id="pct-mini-panel-progress-bar">
                <div id="pct-mini-panel-progress-fill"></div>
            </div>
            <div id="pct-mini-panel-progress-label">Avvio...</div>
        </div>

        <div id="pct-mini-panel-footer">
            <a class="pct-link-dashboard" href="${DASHBOARD_URL}" target="_blank" rel="noopener">Apri Dashboard</a>
        </div>
    `;
    document.body.appendChild(miniPanel);
    pctAggiornaLinkDashboard();


    // Se era minimizzato, parti minimizzato
    if (sessionStorage.getItem('pct-banner-closed') === '1') {
        banner.style.display = 'none';
        miniBtn.style.display = 'flex';
    }

    // ── Riferimenti elementi ──────────────────────────────────────────────────
    const elNumero       = document.getElementById('pct-banner-numero');
    const elOggetto      = document.getElementById('pct-banner-oggetto');
    const elLoading      = document.getElementById('pct-banner-loading');
    const elBtnSync      = document.getElementById('pct-banner-btn-sync');
    const elLastSync     = document.getElementById('pct-banner-last-sync');
    const elProgressWrap = document.getElementById('pct-banner-progress-wrap');
    const elProgressFill = document.getElementById('pct-banner-progress-fill');
    const elProgressLbl  = document.getElementById('pct-banner-progress-label');
    const elResult       = document.getElementById('pct-banner-result');
    const elClose        = document.getElementById('pct-banner-close');

    // ── Utility UI ────────────────────────────────────────────────────────────
    function bannerShowProgress(pct, label) {
        if (typeof elMiniProgressWrap !== 'undefined') {
            elMiniProgressWrap.style.display = 'block';
            elMiniProgressFill.style.width = pct + '%';
            elMiniProgressLbl.textContent = label;
            if (pct >= 100) {
                setTimeout(() => { elMiniProgressWrap.style.display = 'none'; }, 1800);
            }
        }
        try { chrome.runtime.sendMessage({ action: 'syncProgress', label: label, pct: pct }).catch(() => {}); } catch(e){}

        elProgressWrap.style.display = 'block';
        elProgressFill.style.width   = pct + '%';
        elProgressLbl.textContent    = label;
        if (pct >= 100) {
            setTimeout(() => { elProgressWrap.style.display = 'none'; }, 1800);
        }
    }

    function bannerShowResult(type, msg) {
        if (type === 'success') {
            elResult.className = 'pct-success';
        } else if (type === 'warning') {
            elResult.className = 'pct-warning';
        } else {
            elResult.className = 'pct-error';
        }
        elResult.textContent = msg;
        elResult.style.display = 'block';
    }

    function bannerShowLastSync(isoDate) {
        try {
            const d   = new Date(isoDate);
            const fmt = d.toLocaleDateString('it-IT') + ' ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
            elLastSync.textContent = 'Ultima sync: ' + fmt;
        } catch (e) {
            elLastSync.textContent = '';
        }
    }

    // ── Popola info fascicolo ─────────────────────────────────────────────────
    function showBannerLoading() {
        elNumero.textContent  = '';
        elOggetto.textContent = '';
        elLoading.style.display = 'block';
        elBtnSync.style.display = 'none';
        elResult.style.display  = 'none';
    }

    function populateBannerInfo() {
        const urlInfo = parseUrlParams();
        const numero  = (urlInfo.anno_ruolo && urlInfo.numero_ruolo)
            ? formatNumeroFascicolo(urlInfo)
            : '';
        const oggetto = getFieldValue('Oggetto');

        elLoading.style.display = 'none';
        elBtnSync.style.display = 'block';
        elNumero.textContent  = numero  || '—';
        elOggetto.textContent = oggetto || '—';
        if (typeof elMiniNumero !== 'undefined') {
            elMiniNumero.textContent = numero || '—';
            elMiniOggetto.textContent = oggetto || '—';
        }

        // Auto-sync rimosso: la sincronizzazione parte solo al click del pulsante
    }

    // ── Carica ultima sync da storage ─────────────────────────────────────────
    chrome.storage.local.get(['lastSync'], (stored) => {
        if (stored && stored.lastSync) bannerShowLastSync(stored.lastSync);
    });

    // ── Chiusura banner ───────────────────────────────────────────────────────
    elClose.addEventListener('click', () => {
        banner.style.display = 'none';
        miniBtn.style.display = 'flex';
        sessionStorage.setItem('pct-banner-closed', '1');
    });

    // Click mini-bottone → apri mini-pannello
    miniBtn.addEventListener('click', () => {
        miniPanel.style.display = 'block';
        miniBtn.style.display = 'none';
    });
    
    // Chiudi mini-pannello
    const miniPanelClose = document.getElementById('pct-mini-panel-close');
    miniPanelClose.addEventListener('click', () => {
        miniPanel.style.display = 'none';
        miniBtn.style.display = 'flex';
    });
    
    // Riferimenti mini-pannello
    const elMiniNumero = document.getElementById('pct-mini-panel-numero');
    const elMiniOggetto = document.getElementById('pct-mini-panel-oggetto');
    const elMiniBtnSync = document.getElementById('pct-mini-panel-btn-sync');
    const elMiniProgressWrap = document.getElementById('pct-mini-panel-progress-wrap');
    const elMiniProgressFill = document.getElementById('pct-mini-panel-progress-fill');
    const elMiniProgressLbl = document.getElementById('pct-mini-panel-progress-label');
    // ── Sincronizzazione ──────────────────────────────────────────────────────

    // Riferimento al pulsante di interruzione (il flag _syncAborted è globale,
    // così anche scrapeAtti/scrapeAttiSIGP possono fermarsi immediatamente)
    const elBtnStop = document.getElementById('pct-banner-btn-stop');
    const elOverlayLabel = document.getElementById('pct-sync-overlay-label');

    // Nasconde il banner PCT e mostra l'overlay fullscreen
    function enterSyncMode() {
        banner.style.display = 'none';
        miniBtn.style.display = 'none';
        miniPanel.style.display = 'none';
        syncOverlay.classList.add('active');
        pctSetSyncAborted(false);
        // Azzera i contatori del pre-check della sync precedente
        window.__pctPreCheckTotal   = 0;
        window.__pctPreCheckAlready = 0;
    }
    function exitSyncMode() {
        syncOverlay.classList.remove('active');
        banner.style.display = 'block';
    }

    // Pulsante "Ferma sincronizzazione"
    elBtnStop.addEventListener('click', () => {
        pctSetSyncAborted(true);
        elBtnStop.textContent = 'Fermando...';
        elBtnStop.disabled = true;
        if (elOverlayLabel) elOverlayLabel.textContent = 'Interruzione in corso...';
    });

    // Blocco navigazione durante la sync
    function beforeUnloadGuard(e) {
        e.preventDefault();
        e.returnValue = 'La sincronizzazione è in corso. Sei sicuro di voler uscire?';
        return e.returnValue;
    }

    // ── Diagnostica della sync (leggibile dal server) ─────────────────────────
    // Scrive una riga in logs/pda_trace.log via api_pda_trace.php, sullo stesso
    // backend a cui l'estensione manda i dati. Serve a capire, senza aprire la
    // console del browser, cosa ha risposto il backend: quale indirizzo, quale
    // fascicolo_id, quanti atti inviati e con che esito.
    function diagSync(passo, dati) {
        try {
            chrome.runtime.sendMessage({
                action: 'pdaTrace',
                entry: {
                    method: 'DIAG',
                    url: 'pct://sync/' + passo,
                    status: 200,
                    reqBody: JSON.stringify(dati || {}).slice(0, 900),
                    contentType: 'diag',
                    size: 0,
                    respSnippet: location.href,
                },
            }, () => { void chrome.runtime.lastError; });
        } catch (e) { /* la diagnostica non deve mai bloccare la sync */ }
    }

    // ── Scarico diretto dei documenti (client-side, sul PC dell'avvocato) ──────
    // I documenti NON passano da Aruba. Qui, nella pagina del PdA, si chiedono le
    // 8 buste per volta direttamente ai servizi del portale (same-origin, come fa
    // la webapp) e ogni file viene consegnato al servizio locale AstarFirmaServer
    // che lo salva in Documenti\PCT Monitor\<fascicolo>. Aruba conserva solo i
    // metadati (gia' inviati via syncToBackend).
    //
    // Restituisce { ok: true, esito } quando il motore ha girato (anche con
    // qualche file non riuscito: si mostra un avviso, senza ricadere sul DOM).
    // Restituisce { ok: false, motivo } solo se non e' stato possibile partire
    // (servizio locale spento, area non coperta, token assente): allora la
    // sincronizzazione riprende dalla strada del DOM.
    async function scaricoDiretto(backendUrl) {
        if (!window.PctDownload || !window.PctDownload.scaricaFascicoloPC) {
            return { ok: false, motivo: 'motore di scarico diretto non caricato' };
        }

        let token = '';
        try {
            token = localStorage.getItem('access_token') || '';
        } catch (e) {
            // localStorage non leggibile: si prova col token dell'interceptor
        }
        if (!token) {
            try {
                const r = await chrome.runtime.sendMessage({ action: 'pdaTokenGet' });
                token = (r && r.access) || '';
            } catch (e) { /* nessun token in memoria */ }
        }
        if (!token) return { ok: false, motivo: 'token del portale non disponibile' };

        try {
            const esito = await window.PctDownload.scaricaFascicoloPC(location.href, token, {
                // Sync di UN fascicolo: l'elenco atti torna sempre completo, anche
                // se i file erano gia' tutti sul PC. Serve a ripopolare l'archivio
                // quando il fascicolo e' stato cancellato dal pannello (la copia
                // sul PC resta, quindi il motore non scaricherebbe nulla e la
                // scheda resterebbe vuota).
                attiSempre: true,
                onProgress: (fatti, totale) => {
                    const pct = totale > 0
                        ? Math.max(45, Math.min(97, 45 + Math.round((fatti / totale) * 52)))
                        : 45;
                    const msg = 'Scarico documenti sul PC: ' + fatti + '/' + totale;
                    bannerShowProgress(pct, msg);
                    updateBannerStatus(msg);
                },
            });
            // Se il motore ha prodotto un conteggio, ha girato: lo consideriamo
            // usato anche con qualche file non riuscito (evita di riscaricare
            // tutto via DOM finendo su Aruba).
            if (esito && esito.documenti) {
                return { ok: true, esito: { success: true, documenti: esito.documenti, atti: esito.atti || [], parti: esito.parti || [], difensori: esito.difensori || [], parti_xml: esito.parti_xml || [], beni: esito.beni || [], udienza: esito.udienza || '', messaggio: esito.messaggio || '' } };
            }
            return { ok: false, motivo: (esito && esito.messaggio) || 'scarico diretto non riuscito' };
        } catch (e) {
            return { ok: false, motivo: e.message || String(e) };
        }
    }

    function pdaElementoVisibile(el) {
        return !!(el && el.isConnected && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
    }

    function pdaDettaglioDaDialog(dialog) {
        const testo = (dialog.innerText || dialog.textContent || '').trim().replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').slice(0, 30000);
        if (!testo) return null;
        const tabelle = Array.from(dialog.querySelectorAll('table')).map(tabella =>
            Array.from(tabella.querySelectorAll('tr')).map(riga =>
                Array.from(riga.querySelectorAll('th,td')).map(cella => getDatatableCellValue(cella))
            ).filter(riga => riga.some(Boolean))
        ).filter(righe => righe.length);
        const coppie = [];
        dialog.querySelectorAll('dt').forEach(dt => {
            const valore = dt.nextElementSibling;
            if (valore) coppie.push({ campo: getText(dt), valore: getText(valore) });
        });
        return { testo, tabelle, campi: coppie };
    }

    async function pdaLeggiLenteRiga(riga) {
        if (!riga) return null;
        const originalUrl = location.href;
        const celle = Array.from(riga.querySelectorAll('datatable-body-cell'));
        const azioni = celle[celle.length - 1] || riga;
        const cliccabili = Array.from(azioni.querySelectorAll('button,[role="button"],a,i,svg'))
            .filter(pdaElementoVisibile)
            .filter(el => el.tagName !== 'A' || !el.getAttribute('href') || el.getAttribute('href') === '#');
        const descrizione = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.className, el.textContent]
            .filter(Boolean).join(' ').toLowerCase();
        const lenteIcona = cliccabili.find(el => /search|zoom|lens|lente|dettaglio|magnif|visualizza|fa-eye|glyphicon-search|visibility/.test(descrizione(el)));
        if (!lenteIcona) return null;
        const lente = lenteIcona.closest('button,[role="button"],a') || lenteIcona;
        const dialoghiPrima = new Set(Array.from(document.querySelectorAll('[role="dialog"],dialog[open],.modal.show,.modal.in,.modal-dialog,.cdk-overlay-pane,.ui-dialog,.p-dialog')).filter(pdaElementoVisibile));
        lente.click();
        let dialog = null;
        for (let attesa = 0; attesa < 6000; attesa += 200) {
            await waitAbortable(200);
            if (location.href !== originalUrl) return null;
            dialog = Array.from(document.querySelectorAll('[role="dialog"],dialog[open],.modal.show,.modal.in,.modal-dialog,.cdk-overlay-pane,.ui-dialog,.p-dialog'))
                .filter(pdaElementoVisibile).reverse().find(el => !dialoghiPrima.has(el)) || null;
            if (dialog) break;
        }
        if (!dialog) return null;
        const dettaglio = pdaDettaglioDaDialog(dialog);
        const chiudi = Array.from(dialog.querySelectorAll('button,[role="button"],a'))
            .filter(pdaElementoVisibile)
            .find(el => /close|chiudi|annulla|×|✕/i.test([el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' '))
                || el.matches('[data-dismiss="modal"],.close,.btn-close'));
        if (chiudi) chiudi.click();
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        for (let attesa = 0; attesa < 3000; attesa += 150) {
            await waitAbortable(150);
            if (!pdaElementoVisibile(dialog)) break;
        }
        return dettaglio;
    }

    async function leggiDettagliSezioniDom(richieste) {
        const dettagli = {};
        const nonLette = [];
        const tabPerSezione = {
            incarichi: 'Incarichi', beni: 'Beni', lotti: 'Lotti', libretti: 'Libretti',
            spese: 'Spese', pendenze: 'Pendenze', istanze: 'Istanze',
        };
        for (const [sezione, ordini] of Object.entries(richieste || {})) {
            pctThrowIfAborted();
            const nomeTab = tabPerSezione[sezione];
            if (!nomeTab || !Array.isArray(ordini) || !ordini.length) continue;
            const tab = findTabByText(nomeTab);
            if (!tab) { nonLette.push(sezione); continue; }
            updateBannerStatus('Lettura dettagli ' + nomeTab + '...');
            tab.click();
            let root = null;
            for (let attesa = 0; attesa < 10000; attesa += 250) {
                await waitAbortable(250);
                root = Array.from(document.querySelectorAll('ngx-datatable')).find(el => pdaElementoVisibile(el) && el.querySelector('datatable-header-cell')) || null;
                if (root) break;
            }
            if (!root) { nonLette.push(sezione); continue; }
            const intestazioni = Array.from(root.querySelectorAll('datatable-header-cell'))
                .map(c => (c.querySelector('.datatable-header-cell-label') || c).textContent.trim().replace(/\s+/g, ' '));
            const richiesti = new Set(ordini.map(Number));
            const trovati = [];
            const processati = new Set(); // righe richieste effettivamente raggiunte
            let ordine = 0;
            let pagine = 0;
            while (root && pagine < 100) {
                pctThrowIfAborted();
                const numeroRighePagina = root.querySelectorAll('datatable-body-row').length;
                for (let indiceRiga = 0; indiceRiga < numeroRighePagina; indiceRiga++) {
                    if (!root.isConnected) {
                        root = Array.from(document.querySelectorAll('ngx-datatable')).find(el => pdaElementoVisibile(el) && el.querySelector('datatable-header-cell')) || null;
                    }
                    if (!root) break;
                    const riga = root.querySelectorAll('datatable-body-row')[indiceRiga];
                    if (!riga) continue;
                    const celle = Array.from(riga.querySelectorAll('datatable-body-cell'));
                    const colonne = {};
                    celle.forEach((cella, i) => {
                        const chiave = intestazioni[i] || ('Colonna ' + (i + 1));
                        const valore = getDatatableCellValue(cella);
                        if (chiave && valore && !/^(azioni|azione)$/i.test(chiave)) colonne[chiave] = valore;
                    });
                    if (richiesti.has(ordine)) {
                        processati.add(ordine); // riga raggiunta: risolta anche se non ha lente
                        updateBannerStatus('Lettura dettagli ' + nomeTab + ': ' + (trovati.length + 1) + '/' + ordini.length);
                        const dettaglio = await pdaLeggiLenteRiga(riga);
                        if (dettaglio) trovati.push({ ordine, colonne, dettaglio });
                    }
                    ordine++;
                }
                pagine++;
                if (Array.from(richiesti).every(n => processati.has(n))) break;
                const pager = root.querySelector('datatable-pager');
                if (!pager) break;
                const attiva = pager.querySelector('li.active, li.current');
                const paginaCorrente = attiva ? attiva.textContent.trim() : String(pagine);
                const links = Array.from(pager.querySelectorAll('li a'));
                const prossimo = links.find(a => /next|successiva|avanti/i.test((a.getAttribute('aria-label') || '') + ' ' + (a.getAttribute('title') || '')))
                    || links[links.length - 1];
                const liProssimo = prossimo ? prossimo.closest('li') : null;
                if (!prossimo || !liProssimo || liProssimo.classList.contains('disabled')) break;
                prossimo.click();
                let cambiata = false;
                for (let attesa = 0; attesa < 5000; attesa += 250) {
                    await waitAbortable(250);
                    const ora = pager.querySelector('li.active, li.current');
                    if (ora && ora.textContent.trim() !== paginaCorrente) { cambiata = true; break; }
                }
                if (!cambiata) break;
            }
            if (trovati.length) dettagli[sezione] = trovati;
            // Segnaliamo "non letta" solo se alcune righe richieste non sono
            // state proprio raggiunte (tab/tabella non leggibili): una riga
            // raggiunta ma senza lente e' normale e non e' un fallimento.
            if (processati.size < richiesti.size) nonLette.push(sezione);
        }
        if (!Object.keys(dettagli).length) return { dettagli_salvati: 0, dettagli_non_letti: nonLette };
        const risposta = await chrome.runtime.sendMessage({
            action: 'salvaDettagliSezioni',
            payload: { url: window.location.href, dettagli },
        });
        if (!risposta || !risposta.success || !risposta.result || !risposta.result.success) {
            return { dettagli_salvati: 0, dettagli_non_letti: nonLette, errore: (risposta && (risposta.error || (risposta.result && risposta.result.error))) || '' };
        }
        return { dettagli_salvati: Number(risposta.result.dettagli_salvati || 0), dettagli_saltati: Number(risposta.result.dettagli_saltati || 0), dettagli_non_letti: nonLette };
    }

    async function salvaSezioniFallbackDom(nomi) {
        const tabPerSezione = {
            incarichi: 'Incarichi', beni: 'Beni', lotti: 'Lotti', libretti: 'Libretti',
            spese: 'Spese', pendenze: 'Pendenze', istanze: 'Istanze',
        };
        const dati = {};
        const nonLette = [];

        for (const sezione of nomi) {
            pctThrowIfAborted();
            const nomeTab = tabPerSezione[sezione];
            const tab = nomeTab ? findTabByText(nomeTab) : null;
            if (!tab) {
                nonLette.push(sezione);
                continue;
            }

            tab.click();
            updateBannerStatus('Ripiego pagina aperta: ' + nomeTab + '...');
            let root = null;
            let totale = null;
            for (let attesa = 0; attesa < 10000; attesa += 300) {
                await waitAbortable(300);
                const attivi = Array.from(document.querySelectorAll('ngx-datatable'))
                    .filter(el => el.getClientRects().length > 0);
                root = attivi.find(el => el.querySelector('datatable-header-cell')) || attivi[0] || null;
                if (root) {
                    const footer = root.querySelector('datatable-footer');
                    const testoFooter = footer ? footer.textContent : '';
                    const match = testoFooter.match(/(\d+)\s+risultat/i);
                    totale = match ? parseInt(match[1], 10) : null;
                    if (root.querySelector('datatable-header-cell') || totale === 0) break;
                }
            }

            if (!root) {
                nonLette.push(sezione);
                continue;
            }

            const intestazioni = Array.from(root.querySelectorAll('datatable-header-cell'))
                .map(c => (c.querySelector('.datatable-header-cell-label') || c).textContent.trim().replace(/\s+/g, ' '));
            if (!intestazioni.length && totale !== 0) {
                nonLette.push(sezione);
                continue;
            }

            const righe = [];
            let paginaPrecedente = '';
            let pagine = 0;
            while (pagine < 100) {
                pctThrowIfAborted();
                const righePagina = Array.from(root.querySelectorAll('datatable-body-row'));
                for (const [indice, riga] of righePagina.entries()) {
                    const celle = Array.from(riga.querySelectorAll('datatable-body-cell'));
                    const colonne = {};
                    celle.forEach((cella, i) => {
                        const chiave = intestazioni[i] || ('Colonna ' + (i + 1));
                        const valore = getDatatableCellValue(cella);
                        if (chiave && valore && !/^(azioni|azione)$/i.test(chiave)) colonne[chiave] = valore;
                    });
                    if (Object.keys(colonne).length) righe.push({ ordine: righe.length, colonne });
                }
                pagine++;
                const pager = root.querySelector('datatable-pager');
                if (!pager) break;
                const attiva = pager.querySelector('li.active, li.current');
                const paginaCorrente = attiva ? attiva.textContent.trim() : String(pagine);
                const links = Array.from(pager.querySelectorAll('li a'));
                const prossimo = links.find(a => /next|successiva|avanti/i.test((a.getAttribute('aria-label') || '') + ' ' + (a.getAttribute('title') || '')))
                    || links[links.length - 1];
                const liProssimo = prossimo ? prossimo.closest('li') : null;
                if (!prossimo || !liProssimo || liProssimo.classList.contains('disabled') || totale !== null && righe.length >= totale) break;
                if (paginaCorrente === paginaPrecedente) break;
                paginaPrecedente = paginaCorrente;
                prossimo.click();
                let cambiata = false;
                for (let attesa = 0; attesa < 5000; attesa += 250) {
                    await waitAbortable(250);
                    const ora = pager.querySelector('li.active, li.current');
                    if (ora && ora.textContent.trim() !== paginaCorrente) {
                        cambiata = true;
                        break;
                    }
                }
                if (!cambiata) break;
            }

            if (totale === 0) {
                dati[sezione] = { esito: 'vuota', righe: [] };
            } else if (righe.length && (totale === null || righe.length >= totale)) {
                dati[sezione] = { esito: 'ok', righe };
            } else {
                nonLette.push(sezione);
            }
        }

        if (Object.keys(dati).length) {
            const risposta = await chrome.runtime.sendMessage({
                action: 'salvaSezioni',
                payload: { url: window.location.href, sezioni: dati },
            });
            if (!risposta || risposta.error || !risposta.result || !risposta.result.success) {
                throw new Error((risposta && (risposta.error || (risposta.result && risposta.result.error)))
                    || 'salvataggio DOM delle schede non riuscito');
            }
        }
        return { salvate: Object.keys(dati), nonLette, ordiniDettaglio: Object.fromEntries(
            Object.entries(dati).filter(([, s]) => Array.isArray(s.righe) && s.righe.length)
                .map(([nome, s]) => [nome, s.righe.map(r => Number(r.ordine))])
        ) };
    }

    async function aggiornaTutteLeSchede() {
        const tabIniziale = document.querySelector('[role="tab"][aria-selected="true"], .nav-tabs .active a, .nav-tabs .active button');
        const risposta = await chrome.runtime.sendMessage({
            action: 'aggiornaSchede',
            link: window.location.href,
            // Token VIVO della pagina: quello salvato in storage puo' essere gia'
            // scaduto (schede in HTTP 401 "Access token expired") mentre la webapp
            // del Portale rinnova di continuo localStorage.access_token. Lo scarico
            // documenti lo legge gia' cosi'; ora anche le schede.
            token_pda: (function () { try { return localStorage.getItem('access_token') || ''; } catch (e) { return ''; } })(),
        });
        const risultato = risposta && risposta.result;
        const area = ((location.pathname.match(/dettaglio-fascicolo\/([^/]+)/i) || [])[1] || '').toUpperCase();
        // Sezioni "extra" (oltre alle schede storiche) disponibili per registro:
        //  - SIECIC (esecuzioni/fallimentare): sette sezioni + istanze
        //  - SICID  (contenzioso): solo istanze
        //  - SIGP   (Giudice di Pace) e altri: NESSUNA sezione extra (niente
        //    scheda Istanze), quindi non va cercata ne' segnalata come "non letta".
        const sezioniValide = area === 'SIECIC'
            ? ['incarichi', 'beni', 'lotti', 'libretti', 'spese', 'pendenze', 'istanze']
            : (area === 'SICID' ? ['istanze'] : []);
        const tutte = sezioniValide;
        const dom = await salvaSezioniFallbackDom(
            Array.isArray(risultato && risultato.da_leggere_dal_dom)
                ? risultato.da_leggere_dal_dom.filter(n => sezioniValide.includes(n))
                : (!risposta || risposta.error || !risposta.success || !risultato || !risultato.success ? tutte : [])
        );
        const richiesteDettaglio = Object.fromEntries(
            Object.entries((risultato && risultato.dettagli_dal_dom) || {}).map(([nome, ordini]) => [nome, Array.isArray(ordini) ? ordini.slice() : []])
        );
        for (const [nome, ordini] of Object.entries(dom.ordiniDettaglio || {})) {
            richiesteDettaglio[nome] = Array.from(new Set([...(richiesteDettaglio[nome] || []), ...ordini]));
        }
        const dettagli = await leggiDettagliSezioniDom(richiesteDettaglio);
        if (tabIniziale && tabIniziale.isConnected) tabIniziale.click();
        const erroriApi = Object.entries((risultato && risultato.sezioni) || {})
            .filter(([nome, s]) => s && s.esito === 'errore' && sezioniValide.includes(nome) && !dom.salvate.includes(nome))
            .map(([nome]) => nome);
        const nonRisolte = Array.from(new Set([...erroriApi, ...dom.nonLette, ...(dettagli.dettagli_non_letti || [])]));
        if (risultato && risultato.schede_storiche && risultato.schede_storiche.esito === 'errore') {
            nonRisolte.push('schede storiche (Parti, Aggiornamenti, Atti, Comunicazioni, Scadenze)');
        }
        return { risultato, dom, dettagli, nonRisolte };
    }

    const handleSyncClick = async () => {
        elBtnSync.disabled = true;
        if (typeof elMiniBtnSync !== 'undefined') elMiniBtnSync.disabled = true;
        elResult.style.display = 'none';
        enterSyncMode();
        window.__pctAvvisoAtti = '';
        window.addEventListener('beforeunload', beforeUnloadGuard);
        bannerShowProgress(5, 'Avvio raccolta dati...');

        // Lancia __SYNC_ABORTED__ se l'utente ha premuto "Ferma sincronizzazione"
        const checkAbort = pctThrowIfAborted;

        try {
            // 2. Leggi impostazioni da storage
            const stored = await new Promise(resolve =>
                chrome.storage.local.get(['backendUrl', 'apiToken'], resolve)
            );
            const backendUrl = stored.backendUrl || 'http://localhost/pct/api_sync.php';
            const apiToken   = stored.apiToken   || 'pct_aruba_2026_adb200f9';
            const uploadUrl  = 'http://localhost/pct/api_upload_doc.php';

            // === FASE 1: Metadati (veloce) ===
            bannerShowProgress(10, 'Scraping metadati...');
            updateBannerStatus('Scraping metadati...');

            const urlInfo = parseUrlParams();
            const cfAvvocato = urlInfo.cf_avvocato || '';
            const header = {
                ...urlInfo,
                ...scrapeHeader(),
                link: window.location.href,
            };

            // Salva il CF avvocato nello storage per uso nelle pagine lista (comunicazioni/agenda)
            if (urlInfo.cf_avvocato) {
                chrome.storage.local.set({ lastCfAvvocato: urlInfo.cf_avvocato });
            }

            // let parti        = await scrapeTab('Parti',         scrapePart);  // Parti estratte lato server da DatiAtto.xml
            let parti           = []; // Parti estratte lato server da DatiAtto.xml
            checkAbort();

            // Riferimenti d'archivio per la lettura INCREMENTALE dei tab
            // paginati: chiediamo al backend la data piu' recente gia' salvata.
            // Se il fascicolo non e' in archivio (o e' stato cancellato) i
            // riferimenti tornano nulli e si rilegge tutto.
            _riferimentiArchivio = null;
            try {
                const hwmResp = await chrome.runtime.sendMessage({
                    action: 'archivioHwm', backendUrl, apiToken, cfAvvocato,
                    data: {
                        id_ufficio:       header.id_ufficio,
                        registro:         header.registro,
                        gestore:          header.gestore,
                        anno_ruolo:       header.anno_ruolo,
                        numero_ruolo:     header.numero_ruolo,
                        sub_procedimento: header.sub_procedimento || '0',
                        cf_avvocato:      cfAvvocato,
                    },
                });
                if (hwmResp && hwmResp.success && hwmResp.result && hwmResp.result.found) {
                    _riferimentiArchivio = hwmResp.result;
                    console.log('[PCT] Riferimenti archivio:', JSON.stringify(hwmResp.result));
                }
            } catch (e) { /* senza riferimenti si legge tutto, come prima */ }
            checkAbort();

            const aggiornamenti = await scrapeTab('Aggiornamenti', scrapeAggiornamenti);
            checkAbort();
            const scadenze      = await scrapeTab('Scadenze',      scrapeScadenze);
            checkAbort();
            // Non clicchiamo più il tab Comunicazioni durante la sync di un
            // fascicolo: su SICID quella voce porta alla pagina
            // elenco-comunicazioni e rompe il flusso. Le comunicazioni si
            // sincronizzano dalla pagina dedicata con il proprio banner.
            const comunicazioni = [];
            checkAbort();
            const dataMetadati = {
                ...header,
                parti:              parti         || [],
                aggiornamenti:      aggiornamenti || [],
                scadenze:           scadenze      || [],
                comunicazioni:      comunicazioni || [],
                atti:               [],
                _parti_diagnostics: (parti && parti._diagnostics) ? parti._diagnostics : [],
                parti_debug:        (parti && parti._diagnostics) ? parti._diagnostics.join(' | ') : 'no_diag',
            };

            bannerShowProgress(30, 'Salvataggio metadati...');
            updateBannerStatus('Salvataggio metadati...');

            const syncResp1 = await chrome.runtime.sendMessage({
                action: 'syncToBackend',
                backendUrl,
                apiToken,
                cfAvvocato,
                data: dataMetadati,
            });

            if (!syncResp1 || syncResp1.error) {
                throw new Error(syncResp1?.error || 'Errore di comunicazione con il backend (metadati)');
            }

            const result1 = syncResp1.result || {};
            if (!result1.success) {
                throw new Error(result1.error || 'Risposta backend non valida (metadati)');
            }

            const fascicoloId = result1.fascicolo_id;
            if (!fascicoloId) {
                updateBannerStatus('Errore sync metadati');
                console.warn('[PCT] Sync metadati fallita: fascicolo_id mancante', syncResp1);
                throw new Error('Sync metadati fallita: fascicolo_id non ricevuto');
            }

            console.log('[PCT] Metadati salvati, fascicolo_id:', fascicoloId);
            diagSync('metadati', {
                backend: backendUrl,
                cf: cfAvvocato,
                fascicolo: (header.registro || '?') + ' ' + (header.anno_ruolo || '?') + '/' + (header.numero_ruolo || '?')
                    + ' uff=' + (header.id_ufficio || '?') + ' cf_hdr=' + (header.cf_avvocato || ''),
                risposta: JSON.stringify(result1).slice(0, 300),
            });
            checkAbort();

            let esitoSchede = null;
            try {
                bannerShowProgress(38, 'Lettura completa delle schede del fascicolo...');
                updateBannerStatus('Lettura completa delle schede del fascicolo...');
                esitoSchede = await aggiornaTutteLeSchede();
                diagSync('schede', {
                    fascicolo_id: fascicoloId,
                    api: JSON.stringify(esitoSchede.risultato.sezioni || {}).slice(0, 500),
                    fallback_dom: esitoSchede.dom.salvate,
                    non_lette: esitoSchede.nonRisolte,
                });
            } catch (e) {
                if (e && e.message === '__SYNC_ABORTED__') throw e;
                esitoSchede = { nonRisolte: ['schede fascicolo'] };
                console.warn('[PCT] Scraping completo schede non riuscito:', e && e.message);
                diagSync('schede-errore', { fascicolo_id: fascicoloId, errore: (e && e.message) || String(e) });
            }

            // Prima si prova la strada diretta: i documenti li scarica il
            // server parlando con i servizi del portale, otto alla volta. Solo
            // se non e' praticabile (token scaduto, area non coperta, server
            // muto) si ripiega sulla strada del DOM, che clicca un file alla
            // volta ed e' molto piu' lenta.
            bannerShowProgress(45, 'Scarico diretto dei documenti...');
            updateBannerStatus('Scarico diretto dei documenti...');
            const diretto = await scaricoDiretto(backendUrl);
            if (diretto.ok) {
                const d = diretto.esito.documenti || {};

                // I file restano sul PC (Astar), ma i metadati degli atti vanno su
                // Aruba per popolare la scheda "Atti" del pannello. path_locale resta
                // vuoto lato server: e' l'estensione a sapere dove sono sul disco.
                const attiMeta = diretto.esito.atti || [];
                // Parti dal profilo del portale (una chiamata API, nessuna finestra).
                // Senza di queste il fascicolo appena ricreato resta anonimo nel
                // pannello: nessun nome da cercare e riga in fondo all'elenco.
                const partiPortale = diretto.esito.parti || [];
                // Prossima udienza dal decreto di fissazione: la pagina del PdA non
                // la mostra per i Giudici di Pace, e senza data il fascicolo scende
                // in fondo all'elenco del pannello.
                const udienzaXml = diretto.esito.udienza || '';
                const extraUdienza = (udienzaXml && !header.data_prossima_udienza)
                    ? { data_prossima_udienza: udienzaXml } : {};
                if (attiMeta.length > 0) {
                    bannerShowProgress(98, 'Aggiornamento atti nel pannello...');
                    updateBannerStatus('Aggiornamento atti nel pannello...');
                    // Il fallimento di questo passo NON puo' restare muto: senza
                    // questi metadati i documenti stanno sul PC ma la scheda
                    // "Atti e documenti" del pannello non li mostra. Un tentativo
                    // di riprova e, se fallisce ancora, l'avviso nel messaggio
                    // finale cosi' l'utente sa che il sync va rifatto.
                    var erroreAtti = '';
                    var syncAtti = null;
                    for (var tentativoAtti = 1; tentativoAtti <= 2; tentativoAtti++) {
                        try {
                            syncAtti = await chrome.runtime.sendMessage({
                            action: 'syncToBackend',
                            backendUrl,
                            apiToken,
                            cfAvvocato,
                            data: {
                                ...header,
                                ...extraUdienza,
                                parti:         partiPortale.length ? partiPortale : (parti || []),
                                // Parte → difensore, letto dagli XML delle buste: e'
                                // l'unica fonte vera nelle esecuzioni.
                                difensori:     diretto.esito.difensori || [],
                                // Partecipanti letti dagli XML delle buste col
                                // codice fiscale che fa fede: il Portale
                                // (elencoPartiEC) a volte ne sbaglia uno -
                                // INTESA SANPAOLO elencata col CF di POSTE -
                                // e senza questa lista il server non ha modo
                                // di accorgersene.
                                parti_xml:     diretto.esito.parti_xml || [],
                                beni:          diretto.esito.beni || [],
                                aggiornamenti: aggiornamenti || [],
                                scadenze:      scadenze      || [],
                                comunicazioni: comunicazioni || [],
                                atti:          attiMeta,
                                atti_full:     true,
                                atti_debug:    'scarico_diretto totale=' + attiMeta.length,
                            },
                            });
                        } catch (eAtti) {
                            syncAtti = null; // contesto estensione morto o simile: si comporta come risposta negativa
                        }
                        if (syncAtti && !syncAtti.error && syncAtti.result && syncAtti.result.success) {
                            erroreAtti = '';
                            break;
                        }
                        erroreAtti = (syncAtti && (syncAtti.error || (syncAtti.result && syncAtti.result.error)))
                            || 'risposta non valida dal backend';
                        if (tentativoAtti === 1) {
                            console.warn('[PCT] Sync atti (diretto) non riuscita, riprovo:', erroreAtti);
                            await new Promise((r) => setTimeout(r, 1500));
                        }
                    }
                    if (erroreAtti) {
                        console.warn('[PCT] Sync atti (diretto) fallita dopo il riprova:', erroreAtti);
                        window.__pctAvvisoAtti = 'ATTI non aggiornati sul pannello (' + String(erroreAtti).slice(0, 120) + '): rifai la sincronizzazione';
                    } else {
                        window.__pctAvvisoAtti = '';
                    }
                    diagSync('atti', {
                        fascicolo_id: fascicoloId,
                        inviati: attiMeta.length,
                        parti: partiPortale.length,
                        udienza: udienzaXml || (header.data_prossima_udienza || ''),
                        errore: erroreAtti,
                        risposta: JSON.stringify((syncAtti && syncAtti.result) || {}).slice(0, 300),
                    });
                } else {
                    diagSync('atti-vuoti', {
                        fascicolo_id: fascicoloId,
                        messaggio: diretto.esito.messaggio || '',
                        documenti: JSON.stringify(d).slice(0, 200),
                    });
                }

                const dettaglioSchede = esitoSchede && esitoSchede.nonRisolte.length
                    ? '; schede non lette: ' + esitoSchede.nonRisolte.join(', ')
                    : '; schede fascicolo aggiornate';
                const riga = 'Scarico diretto: ' + (d.scaricati || 0) + ' nuovi su ' + (d.nel_fascicolo || 0)
                    + (d.gia_presenti ? ', ' + d.gia_presenti + ' già presenti' : '')
                    + (d.falliti ? ', ' + d.falliti + ' non riusciti' : '')
                    + (d.secondi ? ' in ' + d.secondi + 's' : '') + dettaglioSchede
                    + (window.__pctAvvisoAtti ? ' — ' + window.__pctAvvisoAtti : '');
                bannerShowProgress(100, 'Completato!');
                updateBannerStatus(riga);
                bannerShowResult(d.falliti || window.__pctAvvisoAtti || (esitoSchede && esitoSchede.nonRisolte.length) ? 'warning' : 'success', riga);
                const adesso = new Date().toISOString();
                chrome.storage.local.set({ lastSync: adesso });
                bannerShowLastSync(adesso);
                console.log('[PCT] Scarico diretto completato:', diretto.esito);
                return;
            }
            // I documenti si scaricano solo per via diretta, sul PC dell'avvocato
            // tramite AstarFirmaServer. Se non e' stato possibile (servizio spento,
            // token scaduto, area non coperta) ci si ferma qui: non esiste piu' il
            // ripiego sul DOM, che avrebbe caricato i file su Aruba.
            console.warn('[PCT] Scarico diretto non riuscito:', diretto.motivo);
            updateBannerStatus(diretto.motivo || 'Scarico documenti non riuscito');
            bannerShowResult('error', diretto.motivo || 'Scarico documenti non riuscito. I metadati sono comunque aggiornati.');
            return;

            // === FASE 1.5: Pre-sync DB degli atti (enumerazione senza download) ===
            // Naviga al tab "Atti e documenti", raccoglie i metadati di tutti i file
            // (senza scaricarli) e li invia al backend per aggiornare il DB.
            // I riferimenti DOM (btn, fileItem) vengono salvati in _enumeratedButtons
            // così la FASE 2 può usarli direttamente senza rieseguire l'espansione.
            _enumeratedButtons = null; // reset
            try {
                console.log('[PCT] FASE 1.5: avvio enumerazione atti (enumOnly=true)');
                updateBannerStatus('Enumerazione atti in corso...');
                const stubAtti = await scrapeTab('Atti e documenti', () => scrapeAtti(true));
                if (stubAtti && stubAtti.length > 0) {
                    // Salva i riferimenti DOM per la FASE 2
                    _enumeratedButtons = stubAtti;

                    // Invia al backend i metadati (senza blob) per il pre-sync DB
                    const stubSenzaRef = stubAtti.map(a => {
                        const { _btn, _fileItem, _folderSpan, blob_b64, mime_type, ...rest } = a;
                        return rest;
                    });
                    const dataStub = {
                        ...header,
                        parti:         parti         || [],
                        aggiornamenti: aggiornamenti || [],
                        comunicazioni: comunicazioni || [],
                        atti:          stubSenzaRef,
                        atti_debug:    'pre-sync enumOnly=' + stubAtti.length,
                    };
                    console.log('[PCT] FASE 1.5: invio', stubAtti.length, 'stub al backend');
                    const syncResp15 = await chrome.runtime.sendMessage({
                        action: 'syncToBackend',
                        backendUrl,
                        apiToken,
                        cfAvvocato,
                        data: dataStub,
                    });
                    if (syncResp15 && !syncResp15.error) {
                        console.log('[PCT] FASE 1.5: pre-sync DB OK →', JSON.stringify(syncResp15.result || {}));
                    } else {
                        console.warn('[PCT] FASE 1.5: pre-sync DB fallito (non bloccante):', syncResp15?.error);
                    }
                } else {
                    console.log('[PCT] FASE 1.5: nessun stub trovato, FASE 2 eseguirà espansione DOM completa');
                }
            } catch (e15) {
                if (e15.message === '__SYNC_ABORTED__') throw e15;
                console.warn('[PCT] FASE 1.5: errore (non bloccante):', e15.message);
                _enumeratedButtons = null;
            }
            checkAbort();

            bannerShowProgress(55, 'Avvio download documenti...');
            updateBannerStatus('Avvio download documenti...');

            // === FASE 2: Documenti (lento) ===
            // Imposta il config per il pre-check incrementale PRIMA di scrapeAtti.
            // scrapeAtti userà questa config per filtrare i pulsanti già scaricati
            // PRIMA di cliccarli (evitando download inutili).
            // NB: cfAvvocato è obbligatorio, api_check_atti.php richiede l'header
            // X-Cf-Avvocato e senza di esso risponde 400 (facendo riscaricare tutto).
            _downloadPreCheckConfig = {
                fascicoloId,
                apiToken,
                cfAvvocato,
                checkUrl: uploadUrl.replace('api_upload_doc.php', 'api_check_atti.php'),
            };
            // Se _enumeratedButtons è disponibile, scrapeAtti lo userà per saltare
            // l'espansione DOM (i pulsanti sono già nel DOM dallo stesso tab aperto in FASE 1.5).
            console.log('[PCT] FASE 2: avvio scrapeTab("Atti e documenti") con fascicoloId=' + fascicoloId
                + ' | _enumeratedButtons=' + (_enumeratedButtons ? _enumeratedButtons.length : 'null'));
            const atti = await scrapeTab('Atti e documenti', scrapeAtti);
            _enumeratedButtons = null;      // reset dopo l'uso
            // NB: _downloadPreCheckConfig resta valorizzato: serve ancora al
            // pre-check della FASE 3. Viene azzerato nel finally.
            console.log('[PCT] FASE 2: scrapeTab completato. atti.length=' + (atti ? atti.length : 'null'),
                '| atti con blob:', (atti || []).filter(a => a.blob_b64 && a.blob_b64.length > 0).length,
                '| atti senza blob:', (atti || []).filter(a => !a.blob_b64 || a.blob_b64.length === 0).length);

            // Log diagnostico atti per categoria
            const attiPerCategoria = {};
            (atti || []).forEach(a => {
                const cat = a.categoria || 'altro';
                attiPerCategoria[cat] = (attiPerCategoria[cat] || 0) + 1;
            });
            console.log('[PCT] scrapeAtti: atti per categoria:', JSON.stringify(attiPerCategoria));

            // Fallback parti: se il tab Parti era vuoto, estraiamo le parti dai metadati degli atti
            if ((!parti || parti.length === 0) && atti && atti.length > 0) {
                console.log('[PCT] Fallback parti: estraggo parti dai metadati atti...');
                const partiMap = new Map(); // chiave: cf_parte o nome_parte
                for (const atto of atti) {
                    if (!atto.tipo_parte || !atto.nome_parte) continue;
                    const key = atto.cf_parte || atto.nome_parte;
                    if (!partiMap.has(key)) {
                        const cn = splitCognomeNome(atto.nome_parte);
                        partiMap.set(key, {
                            tipo: normalizeTipo(atto.tipo_parte),
                            cognome: cn.cognome,
                            nome: cn.nome,
                            cf_parte: atto.cf_parte || '',
                            tipo_raw: atto.tipo_parte,
                            data_nascita: null,
                            avvocati: [],
                        });
                    }
                }
                parti = Array.from(partiMap.values());
                console.log('[PCT] Fallback parti: trovate', parti.length, 'parti da atti');
            }

            // Sync aggiornata con atti (senza blob_b64)
            if (atti && atti.length > 0) {
                const dataConAtti = {
                    ...header,
                    parti:         parti         || [],
                    aggiornamenti: aggiornamenti || [],
                    comunicazioni: comunicazioni || [],
                    atti: atti.map(a => {
                        const { blob_b64, mime_type, ...rest } = a;
                        return rest;
                    }),
                    atti_debug: 'totale=' + atti.length + ' categorie=' + JSON.stringify(attiPerCategoria),
                };

                bannerShowProgress(70, 'Aggiornamento atti nel DB...');
                updateBannerStatus('Aggiornamento atti nel DB...');

                const syncResp2 = await chrome.runtime.sendMessage({
                    action: 'syncToBackend',
                    backendUrl,
                    apiToken,
                    cfAvvocato,
                    data: dataConAtti,
                });

                if (!syncResp2 || syncResp2.error) {
                    console.warn('[PCT] Sync atti fallita (non bloccante):', syncResp2?.error);
                } else {
                    const result2 = syncResp2.result || {};
                    if (!result2.success) {
                        console.warn('[PCT] Sync atti: risposta non valida (non bloccante):', result2.error);
                    }
                }
            }

            bannerShowProgress(75, 'Elaborazione risposta...');

            // === FASE 3: Upload file (download incrementale) ===
            console.log('[PCT] FASE 3: inizio upload documenti');
            const attiConDoc = (atti || []).filter(a =>
                (a.blob_b64 && a.blob_b64.trim() !== '') ||
                (a.url_download && a.url_download.trim() !== '')
            );

            // Download incrementale: chiedi al backend quali file sono già scaricati
            // così da evitare di riscaricaricare documenti già presenti su disco.
            let attiDaScaricare = attiConDoc;
            let giaScaricati    = 0;
            if (attiConDoc.length > 0) {
                const downloadedIdx = await pctPreCheckDownloaded(attiConDoc);
                if (downloadedIdx.size > 0) {
                    attiDaScaricare = attiConDoc.filter((a, i) => !downloadedIdx.has(i));
                    giaScaricati    = attiConDoc.length - attiDaScaricare.length;
                    console.log('[PCT] Download incrementale:', attiDaScaricare.length,
                        'nuovi,', giaScaricati, 'già presenti → skip');
                    updateBannerStatus(giaScaricati + ' file già presenti, carico ' + attiDaScaricare.length + ' nuovi...');
                }
            }

            let scaricati = 0;
            console.log('[PCT] FASE 3: attiConDoc=' + attiConDoc.length + ' attiDaScaricare=' + attiDaScaricare.length);
            if (attiDaScaricare.length > 0) {
                console.log('[PCT] Upload documenti:', attiDaScaricare.length, 'file da scaricare',
                    giaScaricati > 0 ? '(' + giaScaricati + ' già presenti, saltati)' : '');

                for (let i = 0; i < attiDaScaricare.length; i++) {
                    if (pctIsSyncAborted()) {
                        console.log('[PCT] Sync interrotta dall\'utente durante upload atto', i + 1);
                        bannerShowResult('warning', 'Sincronizzazione interrotta — ' + scaricati + ' documenti caricati su ' + attiDaScaricare.length);
                        break;
                    }
                    const atto = attiDaScaricare[i];
                    const shortName = (atto.nome_file || '').length > 35
                        ? atto.nome_file.substring(0, 35) + '...'
                        : (atto.nome_file || '');
                    updateBannerStatus('Upload ' + (i + 1) + '/' + attiDaScaricare.length + ': ' + shortName);
                    bannerShowProgress(
                        Math.round(80 + (i / attiDaScaricare.length) * 18),
                        'Upload ' + (i + 1) + '/' + attiDaScaricare.length
                    );

                    try {
                        let fileBase64 = null;
                        let fileMime = 'application/octet-stream';

                        if (atto.blob_b64 && atto.blob_b64.trim() !== '') {
                            fileBase64 = atto.blob_b64;
                            fileMime = atto.mime_type || 'application/octet-stream';
                            console.log('[PCT] FASE 3: upload', (i+1) + '/' + attiDaScaricare.length,
                                atto.nome_file, '| fonte: blob_b64 | mime:', fileMime,
                                '| base64 len:', fileBase64.length);
                        } else if (atto.url_download && atto.url_download.trim() !== '') {
                            console.log('[PCT] FASE 3: upload', (i+1) + '/' + attiDaScaricare.length,
                                atto.nome_file, '| fonte: url_download →', atto.url_download.substring(0, 80));
                            // Link diretto: chiedi al background di scaricarlo
                            const dlResp = await chrome.runtime.sendMessage({
                                action: 'downloadFile',
                                url:    atto.url_download,
                            });
                            if (dlResp && !dlResp.error && dlResp.buffer) {
                                // Converti ArrayBuffer in base64
                                const bytes = new Uint8Array(dlResp.buffer);
                                let binary = '';
                                for (let j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j]);
                                fileBase64 = btoa(binary);
                                console.log('[PCT] FASE 3: download da URL OK, base64 len:', fileBase64.length);
                            } else {
                                console.warn('[PCT] FASE 3: download da URL fallito:', dlResp?.error);
                            }
                        } else {
                            console.warn('[PCT] FASE 3: atto senza blob_b64 né url_download, skip:', atto.nome_file);
                        }

                        if (!fileBase64) {
                            console.warn('[PCT] FASE 3: fileBase64 null per', atto.nome_file, '— skip upload');
                            continue;
                        }

                        const fields = {
                            fascicolo_id: String(fascicoloId),
                            nome_file:    atto.nome_file    || '',
                            parte:        atto.parte        || '',
                            tipo_parte:   atto.tipo_parte   || '',
                            nome_parte:   atto.nome_parte   || '',
                            cf_parte:     atto.cf_parte     || '',
                            tipo_atto:    atto.tipo_atto    || '',
                            data_atto:    atto.data_atto    || '',
                            url_download: atto.url_download || '',
                            categoria:    atto.categoria    || '',
                        };
                        // SIGP: passa il subfolder pre-calcolato (es. "atti_di_parte/AP - Mario Rossi (CF)/22-08-2025")
                        // api_upload_doc.php lo userà direttamente invece di ricalcolare il percorso
                        if (atto.subfolder && atto.subfolder.trim() !== '') {
                            fields.subfolder = atto.subfolder.trim();
                        }
                        console.log('[PCT] FASE 3: invio uploadDoc a', uploadUrl,
                            '| fascicolo_id:', fields.fascicolo_id,
                            '| nome_file:', fields.nome_file,
                            '| categoria:', fields.categoria,
                            '| subfolder:', fields.subfolder || '(nessuno)');

                        const upResp = await chrome.runtime.sendMessage({
                            action:     'uploadDoc',
                            url:        uploadUrl,
                            apiToken,
                            cfAvvocato,
                            fields,
                            fileBase64: fileBase64,
                            fileName:   atto.nome_file || 'documento',
                            mimeType:   fileMime,
                        });

                        if (upResp && !upResp.error) {
                            const upResult = upResp.result || {};
                            if (upResult.success) {
                                scaricati++;
                                console.log('[PCT] Upload OK:', atto.nome_file, '->', upResult.path);
                            } else {
                                console.warn('[PCT] Upload fallito:', atto.nome_file, upResult.error || upResult);
                            }
                        } else {
                            console.warn('[PCT] Upload errore risposta:', atto.nome_file, upResp?.error);
                        }
                    } catch (dlErr) {
                        console.warn('[PCT Banner] Errore upload', atto.nome_file, dlErr.message);
                    }
                }
            }

            // === FASE 4: Riconciliazione DB (solo SIGP) ===
            // Viene eseguita dopo che tutti i file sono stati scaricati e posizionati su disco.
            // Il filesystem è la fonte di verità: allinea tab_atti a ciò che esiste realmente.
            if (isGdP() && fascicoloId) {
                try {
                    const reconcileResp = await fetch('http://localhost/pct/api_reconcile_fascicolo.php', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ fascicolo_id: fascicoloId }),
                    });
                    const data = await reconcileResp.json();
                    console.log('[PCT] Riconciliazione DB:', data);
                } catch (reconcileErr) {
                    console.warn('[PCT] Riconciliazione DB fallita (non bloccante):', reconcileErr.message);
                }
            }

            bannerShowProgress(100, 'Completato!');

            const totaleConDoc = attiConDoc.length;

            if (!atti || atti.length === 0) {
                // Controlla se il pre-check ha trovato file già presenti
                const preTotal = window.__pctPreCheckTotal || 0;
                const preAlready = window.__pctPreCheckAlready || 0;
                if (preAlready > 0) {
                    // Tutti i file sono già scaricati: fascicolo aggiornato
                    updateBannerStatus('Fascicolo già aggiornato (' + preAlready + '/' + preTotal + ' documenti presenti)');
                    bannerShowResult('success', 'Fascicolo già aggiornato — ' + preAlready + ' documenti già presenti');
                } else {
                    // Nessun atto trovato dal PdA: mostra warning giallo
                    updateBannerStatus('Nessun atto trovato dal PdA');
                    bannerShowResult('warning', 'Sincronizzazione non riuscita: nessun atto trovato');
                }
            } else {
                const completionStatus = totaleConDoc > 0
                    ? 'Sincronizzazione completata! ' + scaricati + ' nuovi' +
                      (giaScaricati > 0 ? ', ' + giaScaricati + ' già presenti' : '') + ' documenti'
                    : 'Sincronizzazione completata (solo metadati)';
                updateBannerStatus(completionStatus);

                const msg = totaleConDoc > 0
                    ? `Sincronizzato (ID: ${fascicoloId}) — ${scaricati} nuovi` +
                      (giaScaricati > 0 ? `/${totaleConDoc} (${giaScaricati} già presenti)` : `/${totaleConDoc} doc`)
                    : `Fascicolo sincronizzato (ID: ${fascicoloId})`;
                bannerShowResult('success', msg);
            }

            // Salva timestamp ultima sync
            const now = new Date().toISOString();
            chrome.storage.local.set({ lastSync: now });
            bannerShowLastSync(now);

        } catch (err) {
            elProgressWrap.style.display = 'none';
            if (err.message === '__SYNC_ABORTED__') {
                bannerShowResult('warning', 'Sincronizzazione interrotta dall\'utente');
                console.log('[PCT] Sincronizzazione interrotta dall\'utente');
            } else {
                bannerShowResult('error', err.message);
            }
        } finally {
            exitSyncMode();
            window.removeEventListener('beforeunload', beforeUnloadGuard);
            elBtnStop.textContent = 'Ferma sincronizzazione';
            elBtnStop.disabled = false;
            if (elOverlayLabel) elOverlayLabel.textContent = 'Sincronizzazione in corso';
            elBtnSync.disabled = false;
            if (typeof elMiniBtnSync !== 'undefined') elMiniBtnSync.disabled = false;
            // Reset dello stato globale usato dalle funzioni di scraping
            _downloadPreCheckConfig = null;
            _enumeratedButtons      = null;
            pctSetSyncAborted(false);
        }
    };
    elBtnSync.addEventListener('click', handleSyncClick);
    if (typeof elMiniBtnSync !== 'undefined') elMiniBtnSync.addEventListener('click', handleSyncClick);

    // Avvio remoto della sync: il dettaglio del pannello ("Sync fascicolo")
    // apre questa pagina dal service worker e chiede di avviare la raccolta,
    // come se l'utente avesse premuto il pulsante del banner. Un solo avvio
    // per volta: se una sync e' gia' in corso si risponde senza fare nulla.
    let __pctSyncRemotaInCorso = false;
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message) return;
        if (message.action === 'scrapeDettagliFascicolo') {
            const atteso = String(message.link || '').split('?')[0].replace(/\/+$/, '').toLowerCase();
            const corrente = location.href.split('?')[0].replace(/\/+$/, '').toLowerCase();
            if (!atteso || atteso !== corrente) {
                sendResponse({ success: false, error: 'La scheda PdA aperta non corrisponde al fascicolo da sincronizzare' });
                return false;
            }
            (async () => {
                const tabIniziale = document.querySelector('[role="tab"][aria-selected="true"], .nav-tabs .active a, .nav-tabs .active button');
                const dom = await salvaSezioniFallbackDom(message.sezioni_dom || []);
                const richieste = Object.fromEntries(
                    Object.entries(message.richieste || {}).map(([nome, ordini]) => [nome, Array.isArray(ordini) ? ordini.slice() : []])
                );
                for (const [nome, ordini] of Object.entries(dom.ordiniDettaglio || {})) {
                    richieste[nome] = Array.from(new Set([...(richieste[nome] || []), ...ordini]));
                }
                const dettagli = await leggiDettagliSezioniDom(richieste);
                if (tabIniziale && tabIniziale.isConnected) tabIniziale.click();
                sendResponse({ success: true, sezioni_dom: dom.salvate, nonLette: dom.nonLette, ...dettagli });
            })().catch(e => sendResponse({ success: false, error: (e && e.message) || String(e) }));
            return true;
        }
        if (message.action !== 'autoSyncFascicolo') return;
        if (__pctSyncRemotaInCorso) {
            sendResponse({ ok: false, error: 'Sincronizzazione gia in corso in questa pagina' });
            return true;
        }
        __pctSyncRemotaInCorso = true;
        sendResponse({ ok: true });
        Promise.resolve(handleSyncClick()).finally(() => { __pctSyncRemotaInCorso = false; });
        return true;
    });

    // ── Attendi rendering Angular prima di popolare le info ───────────────────
    // Usa MutationObserver per rilevare quando Angular ha renderizzato la tabella header
    let populated = false;

    // Mostra loading al primo caricamento
    showBannerLoading();

    function tryPopulate() {
        if (populated) return;
        // Verifica che la tabella header del fascicolo sia presente
        const headerTable = document.querySelector('app-dettaglio-fascicolo-dati-generali table, .tableScollable');
        if (!headerTable) return;
        // Verifica che il DOM corrisponda all'URL corrente (Angular potrebbe non aver ancora aggiornato).
        // Il portale scrive il numero come "numero/anno" nei registri civili e
        // come "anno/numero" nelle esecuzioni (SIECIC): si confrontano i numeri
        // e non la stringa, altrimenti sui fascicoli SIECIC il confronto non
        // tornava mai e il banner restava per sempre su "Caricamento fascicolo".
        const urlInfo = parseUrlParams();
        const fascDom = getFieldValue('Fascicolo') || '';
        if (urlInfo.anno_ruolo && urlInfo.numero_ruolo) {
            const numeri = (fascDom.match(/\d+/g) || []).map(n => parseInt(n, 10));
            const anno   = parseInt(urlInfo.anno_ruolo, 10);
            const numero = parseInt(urlInfo.numero_ruolo, 10);
            if (!numeri.length || numeri.indexOf(anno) === -1 || numeri.indexOf(numero) === -1) {
                return; // DOM vuoto o ancora sul fascicolo precedente
            }
        }
        populated = true;
        observer.disconnect();
        // Ritarda di 400ms per dare tempo ad Angular di completare il render di tutti i campi
        // (il campo Fascicolo si aggiorna prima degli altri, evita oggetto ancora vecchio)
        setTimeout(populateBannerInfo, 400);
    }

    const observer = new MutationObserver(tryPopulate);
    observer.observe(document.body, { childList: true, subtree: true });

    // Fallback: prova dopo 2s e 5s nel caso il MutationObserver non scatti
    setTimeout(tryPopulate, 2000);
    setTimeout(tryPopulate, 5000);

    // ── Monitora cambi URL (SPA Angular) ─────────────────────────────────────
    let lastUrl = location.href;
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            if (!location.href.includes('dettaglio-fascicolo')) {
                // Nasconde banner e mini-bottone se non siamo su un fascicolo
                banner.style.display = 'none';
                miniBtn.style.display = 'none';
            } else {
                // Cambiato fascicolo: riapri il banner pieno anche se era minimizzato
                banner.style.display = '';
                miniBtn.style.display = 'none';
                sessionStorage.removeItem('pct-banner-closed');
                populated = false;
                // Mostra stato di caricamento
                showBannerLoading();
                // Ricollega il MutationObserver (era stato disconnesso)
                observer.observe(document.body, { childList: true, subtree: true });
                // Aspetta che Angular renderizzi il nuovo fascicolo
                setTimeout(() => { populated = false; tryPopulate(); }, 2000);
                setTimeout(() => { populated = false; tryPopulate(); }, 4000);
                setTimeout(() => { populated = false; tryPopulate(); }, 6000);
            }
        }
    }, 500);

    } // fine initBanner

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initBanner);
    } else {
        initBanner();
    }

    // ── Watcher SPA: fa apparire il banner anche senza refresh ────────────────
    // Il PdA è una SPA Angular: passare dalla lista fascicoli al dettaglio
    // (o viceversa/tra due fascicoli diversi) cambia solo l'URL via
    // pushState, senza un vero reload della pagina. Lo script del content
    // è già stato eseguito una volta al primo caricamento: se in quel
    // momento l'URL non era "dettaglio-fascicolo", initBanner() è uscita
    // subito e il banner non è mai stato creato. Questo watcher richiama
    // initBanner() UNA SOLA VOLTA quando l'URL cambia e ricade su una pagina
    // di dettaglio; una volta che il banner esiste, il watcher si ferma e
    // lascia il compito di restare aggiornato al watcher interno del banner
    // stesso (righe sopra, "Monitora cambi URL"). Non deve restare attivo
    // all'infinito: farlo ripartire di continuo rischia di correre in
    // parallelo con quello interno e creare un secondo banner duplicato.
    let pctLastUrlPerBanner = location.href;
    const pctBannerWatcher = setInterval(() => {
        if (document.getElementById('pct-floating-banner')) {
            clearInterval(pctBannerWatcher);
            return;
        }
        if (location.href !== pctLastUrlPerBanner) {
            pctLastUrlPerBanner = location.href;
            if (location.href.includes('dettaglio-fascicolo')) {
                initBanner();
            }
        }
    }, 500);
})();

// ── Invio automatico delle parti al backend quando si apre il dettaglio PdA ──
// Lo scraping dalle API REST (ricerca/sync bulk) non distingue il ruolo
// processuale: restituisce solo un flag P/S. Il dettaglio HTML invece separa
// chiaramente Attori e Convenuti/Resistenti. Quando l'avvocato apre il
// dettaglio di un fascicolo, leggiamo le tabelle Parti e le inviamo al
// backend, che le considera attendibili e allinea (ruoli + cancellazione orfani).
(function pctInviaPartiDalDettaglio() {
    async function invia() {
        if (!location.href.includes('dettaglio-fascicolo')) return;
        // Aspetta che Angular renderizzi le tabelle delle parti.
        await new Promise(r => setTimeout(r, 4000));
        try {
            const urlInfo = parseUrlParams();
            if (!urlInfo.anno_ruolo || !urlInfo.numero_ruolo || !urlInfo.cf_avvocato) return;
            const parti = await scrapePart();
            if (!parti || !parti.length) {
                console.log('[PCT] parti: nessuna parte letta dal dettaglio, skip');
                return;
            }
            // Rimuovi _diagnostics prima di inviare (non serve al backend)
            const partiClean = Array.from(parti).map(p => ({
                tipo: p.tipo,
                cognome: p.cognome,
                nome: p.nome,
                cf_parte: p.cf_parte,
                data_nascita: p.data_nascita || '',
                tipo_raw: p.tipo_raw || '',
                avvocati: (p.avvocati || []).map(a => ({
                    nome_avvocato: a.nome_avvocato || '',
                    cf_avvocato: a.cf_avvocato || ''
                }))
            }));
            chrome.runtime.sendMessage({
                action: 'salva_parti_pda',
                cf_avvocato: urlInfo.cf_avvocato,
                fascicolo: {
                    id_ufficio: urlInfo.id_ufficio,
                    registro: urlInfo.registro,
                    // Senza gestore e tipo_ruolo la chiave del fascicolo non e'
                    // completa e le parti finivano su una riga diversa da quella
                    // mostrata a monitor (tipico dei SIECIC: gestore GLGE, ESIM).
                    gestore: urlInfo.gestore || '',
                    tipo_ruolo: urlInfo.tipo_ruolo || '',
                    anno_ruolo: urlInfo.anno_ruolo,
                    numero_ruolo: urlInfo.numero_ruolo,
                    sub_procedimento: urlInfo.sub_procedimento || '0',
                },
                parti: partiClean,
            }, (res) => {
                console.log('[PCT] parti: risposta backend', res);
            });
            console.log('[PCT] parti: inviate', partiClean.length, 'parti al backend');
        } catch (e) {
            console.error('[PCT] parti: invio fallito', e);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', invia);
    } else {
        invia();
    }
})();
})();
