/**
 * PCT Monitor - Background Service Worker (Manifest V3)
 * Gestisce la comunicazione tra popup e content script,
 * e mantiene lo stato della sincronizzazione.
 */

import { ricercaDirettaOrdine, assicuraToken } from './pda_ricerca.js';

'use strict';

// ─── Sonda diagnostica avvio service worker ───────────────────────────────────
// Appena il service worker parte (installazione, reload estensione, wake-up),
// chiama api_ext_ping.php: se compare una riga fresca nel log lato server,
// significa che QUESTO codice aggiornato e' realmente in esecuzione in Chrome.
(function pingWorkerStart() {
    try {
        const ver = chrome.runtime.getManifest().version;
        chrome.storage.local.get(['backendUrl'], (st) => {
            // La sonda parte sempre da localhost e scrive nel log quale
            // indirizzo backend Chrome si e' tenuto in memoria: se e' quello
            // sbagliato, lo si legge subito invece di indovinarlo.
            diagnostica('worker_start - backendUrl in memoria: ' + (st.backendUrl || '(nessuno, uso il predefinito)'));
            const base = (st.backendUrl || 'http://localhost/pct/api_sync.php').replace(/\/api_sync[^/]*\.php$/, '');
            fetch(base + '/api_ext_ping.php?m=worker_start_su_indirizzo_salvato&v=' + encodeURIComponent(ver)).catch(() => {});
        });
    } catch (e) { /* noop */ }
})();

// ─── Installazione / aggiornamento ────────────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        console.log('[PCT Monitor] Estensione installata. Versione:', chrome.runtime.getManifest().version);
        // Imposta valori default nello storage (produzione: Aruba).
        chrome.storage.local.set({
            backendUrl: 'https://www.sincpdatoscana.it/wp-content/monitor/api_sync.php',
            apiToken:   'pct_aruba_2026_adb200f9',
        });
    }
    if (details.reason === 'update' || details.reason === 'chrome_update') {
        console.log('[PCT Monitor] Estensione aggiornata a', chrome.runtime.getManifest().version);
        // Migrazione token: le installazioni precedenti hanno salvato in storage
        // il vecchio token di default (pct_token_2026_change_me), che il server
        // Aruba rifiuta con 401. Lo sostituiamo automaticamente col token corretto
        // cosi' l'avvocato non deve toccare nulla nelle impostazioni.
        chrome.storage.local.get(['apiToken', 'backendUrl'], (st) => {
            const OLD = 'pct_token_2026_change_me';
            const NEW = 'pct_aruba_2026_adb200f9';
            const PROD_BACKEND = 'https://www.sincpdatoscana.it/wp-content/monitor/api_sync.php';
            const patch = {};
            if (!st.apiToken || st.apiToken === OLD) {
                patch.apiToken = NEW;
            }
            // Se il backend salvato punta ancora a localhost (default di sviluppo)
            // o e' assente, lo portiamo su Aruba: l'estensione parla sempre col
            // server, non con la macchina dell'avvocato.
            if (!st.backendUrl || /localhost|127\.0\.0\.1/i.test(String(st.backendUrl))) {
                patch.backendUrl = PROD_BACKEND;
            }
            if (Object.keys(patch).length) {
                chrome.storage.local.set(patch);
                console.log('[PCT Monitor] Impostazioni aggiornate automaticamente:', Object.keys(patch).join(', '));
            }
        });
        // Ricarica i tab del PdA aperti per ri-iniettare content.js con il nuovo contesto
        reloadPdATabs();
        // Ri-inietta il ponte nella dashboard WP/localhost gia' aperta: dopo un
        // aggiornamento dell'estensione il content script resta "orfano" e il
        // controllo sessione andrebbe in timeout ("Non risulta una sessione
        // attiva") finche' l'utente non ricarica la pagina a mano. Cosi' non
        // serve piu' il refresh manuale.
        reinjectDashboardBridges();
    }
});

// ─── Re-iniezione del ponte dashboard nelle schede gia' aperte ────────────────
// Dopo un reload/aggiornamento dell'estensione i content script iniettati in
// precedenza diventano orfani (chrome.runtime invalidato) e non rispondono piu'
// ai postMessage della pagina. Reinietta dashboard_bridge.js (idempotente) in
// tutte le schede/iframe del pannello, azzerando prima la sua guardia di
// singola-iniezione cosi' i listener vengono riagganciati.
function reinjectDashboardBridges() {
    const urls = [
        'https://sincpdatoscana.it/*',
        'https://www.sincpdatoscana.it/*',
        'http://localhost/pct/*',
        'https://localhost/pct/*',
        'http://desktop-peoancq/pct/*',
        'https://desktop-peoancq/pct/*',
    ];
    chrome.tabs.query({ url: urls }, (tabs) => {
        for (const tab of tabs) {
            if (!tab.id) continue;
            chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                func: () => { try { delete window.__pctDashboardBridgeLoaded; } catch (e) { /* noop */ } },
            }).then(() => chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                files: ['dashboard_bridge.js'],
            })).then(() => {
                console.log('[PCT Monitor] ponte dashboard re-iniettato in tab', tab.id, tab.url);
            }).catch(() => { /* frame senza match/cross-origin: ignora */ });
        }
    });
}

// ─── Ricarica tab PdA aperti ──────────────────────────────────────────────────
function reloadPdATabs() {
    chrome.tabs.query({ url: 'https://www.giustizia.toscana.it/pda-rt/cancelleriatelematica/*' }, (tabs) => {
        for (const tab of tabs) {
            if (tab.id) {
                console.log('[PCT Monitor] reload tabId', tab.id, tab.url);
                chrome.tabs.reload(tab.id, { bypassCache: true }).catch(() => {});
            }
        }
    });
}

// ─── Indirizzo del backend: ripiego e autoriparazione ─────────────────────────
// L'indirizzo del backend viene tenuto in memoria da Chrome (storage.local) e
// puo' essere sovrascritto da una sync dell'Ordine partita da una pagina aperta
// con un altro nome host o in https. Se quell'indirizzo non risponde piu', la
// fetch muore dentro Chrome senza nemmeno raggiungere Apache e l'avvocato vede
// soltanto "Failed to fetch", senza alcuna traccia nel log del server.
// Da qui in avanti la stessa chiamata viene ritentata solo sugli indirizzi
// equivalenti allo stesso host: se il primario e' remoto, un fallimento resta
// un fallimento (visibile), non una scrittura silenziosa nel DB locale.

function indirizziDiRipiego(url) {
    const lista = [url];
    let percorso = '/pct/api_sync.php';
    try {
        const u = new URL(url);
        percorso = u.pathname + (u.search || '');
    } catch (e) {
        // indirizzo malformato: si riparte dal percorso predefinito
    }
    // L'indirizzo primario e' remoto (produzione): localhost NON e' un ripiego.
    // Se la rete verso il server vacilla, una scrittura finita nel DB locale
    // del PC e' una scrittura persa: a monitor non compare nulla e l'utente
    // vede il fascicolo fermo a giorni prima, senza alcun errore a schermo.
    const primarioLocale = /^https?:\/\/(localhost|127\.0\.0\.1|::1|\[::1\])([:/]|$)/i.test(String(url));
    if (primarioLocale) {
        for (const radice of ['http://localhost', 'http://127.0.0.1']) {
            const candidato = radice + percorso;
            if (!lista.includes(candidato)) {
                lista.push(candidato);
            }
        }
    }
    return lista;
}

// Un errore di rete significa che la richiesta non e' nemmeno partita: solo in
// quel caso vale la pena provare un altro indirizzo. Una risposta HTTP di
// errore (404, 500, ...) e' invece una risposta vera e va restituita cosi'
// com'e', altrimenti si maschererebbe un problema del backend.
async function fetchConRipiego(url, init) {
    const provati = [];
    let ultimoErrore = null;
    for (const candidato of indirizziDiRipiego(url)) {
        provati.push(candidato);
        try {
            const resp = await fetch(candidato, init);
            if (candidato !== url) {
                diagnostica('riepiego_rete: ' + url + ' -> ' + candidato);
            }
            return { resp, urlUsata: candidato, provati };
        } catch (e) {
            ultimoErrore = e;
        }
    }
    const err = new Error(
        'Backend non raggiungibile. Indirizzi provati: ' + provati.join('  |  ') +
        '. Dettaglio: ' + (ultimoErrore ? ultimoErrore.message : 'errore di rete')
    );
    err.provati = provati;
    throw err;
}

function diagnostica(messaggio) {
    // Va sempre su localhost: se l'indirizzo salvato fosse rotto, questa riga
    // sarebbe l'unica prova di cosa e' accaduto.
    try {
        const ver = chrome.runtime.getManifest().version;
        fetch('http://localhost/pct/api_ext_ping.php?m=' + encodeURIComponent(messaggio) +
              '&v=' + encodeURIComponent(ver)).catch(() => {});
    } catch (e) { /* noop */ }
}

function ricordaBackendFunzionante(urlUsata, urlVecchia) {
    // Si salva solo l'endpoint dei metadati: e' quello che il content script usa
    // come base per costruire tutti gli altri indirizzi.
    if (!/\/api_sync\.php(\?.*)?$/.test(urlUsata)) return;
    try {
        chrome.storage.local.set({ backendUrl: urlUsata });
    } catch (e) { /* noop */ }
    console.warn('[PCT Monitor] backend non raggiungibile su', urlVecchia, '- passo a', urlUsata);
    diagnostica('backend_corretto: ' + urlVecchia + ' -> ' + urlUsata);
}

// Verifica che un indirizzo base risponda davvero prima di salvarlo come
// backend: qualunque risposta HTTP dimostra che dall'altra parte c'e' un server.
async function baseRaggiungibile(base) {
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(base + '/api_ext_ping.php?m=base_probe', {
            signal: ctrl.signal,
            cache: 'no-store',
        });
        clearTimeout(timer);
        return !!r;
    } catch (e) {
        return false;
    }
}

// ─── Background scraper tabs (profilo + token calendario) ─────────────────────
// Apriamo una nuova tab in background per lo scraping; viene chiusa
// automaticamente dal content script al termine del procedimento.
const activeScraperTabs = new Map(); // tabId -> { url, openedAt }
const activeOrderSyncTabs = new Map(); // tabId -> { url, openedAt, cfAvvocato }

function isScraperTab(tabId) {
    return activeScraperTabs.has(tabId) || activeOrderSyncTabs.has(tabId);
}

function closeAllScraperTabs() {
    for (const tabId of activeScraperTabs.keys()) {
        chrome.tabs.remove(tabId).catch(() => {});
    }
    for (const [tabId, info] of activeOrderSyncTabs.entries()) {
        // Le schede dell'utente riusate per il sync non si chiudono mai.
        if (info && info.riusata) continue;
        chrome.tabs.remove(tabId).catch(() => {});
    }
    activeScraperTabs.clear();
    activeOrderSyncTabs.clear();
}

let lastBackgroundScraperAt = 0;
function openBackgroundScraper(url) {
    // Cooldown di sicurezza: se il backend è in errore, impedisce che la finestra
    // pctBackground venga riaperta in loop (una ogni pochi secondi). Max 1 ogni 5 min.
    const nowTs = Date.now();
    if (nowTs - lastBackgroundScraperAt < 5 * 60 * 1000) {
        console.log('[PCT Monitor] openBackgroundScraper: cooldown attivo, salto apertura');
        return;
    }
    lastBackgroundScraperAt = nowTs;

    // Chiudi eventuali tab precedenti bloccate
    closeAllScraperTabs();

    chrome.tabs.create({
        url: url + (url.includes('?') ? '&' : '?') + 'pctBackground=1',
        active: false,
    }, (tab) => {
        if (!tab || !tab.id) return;
        activeScraperTabs.set(tab.id, { url, openedAt: Date.now() });
        console.log('[PCT Monitor] Aperta tab di background', tab.id, 'per', url);

        // Sicurezza: chiudi automaticamente dopo 90s se non si è chiusa da sola
        setTimeout(() => {
            if (activeScraperTabs.has(tab.id)) {
                console.log('[PCT Monitor] Timeout 90s, chiudo tab', tab.id);
                closeBackgroundTab(tab.id);
            }
        }, 90000);
    });
}

function closeBackgroundTab(tabId) {
    if (!activeScraperTabs.has(tabId) && !activeOrderSyncTabs.has(tabId)) return;
    const eraOrderSync = activeOrderSyncTabs.has(tabId);
    const info = activeOrderSyncTabs.get(tabId);
    const riusata = !!(info && info.riusata);
    activeScraperTabs.delete(tabId);
    activeOrderSyncTabs.delete(tabId);
    // Se la scheda era dell'utente (riusata) non si chiude: la si lascia dov'e',
    // riportandola alla dashboard del PdA.
    if (riusata) {
        chrome.tabs.update(tabId, { url: 'https://www.giustizia.toscana.it/pda-rt/cancelleriatelematica/dashboard' }).catch(() => {});
        console.log('[PCT Monitor] Scheda PdA riusata: lasciata aperta', tabId);
    } else {
        chrome.tabs.remove(tabId).catch(() => {});
        console.log('[PCT Monitor] Chiusa tab di background', tabId);
    }
    // Libera il debounce: una nuova sync-ordine potra' ripartire.
    if (eraOrderSync) {
        chrome.storage.local.remove(['pctOrderSyncTabId', 'pctOrderSyncStartedAt', 'pctOrderSyncWindowRiusata']);
    }
}

function openOrderSyncTab(cfAvvocato, codiciUffici, fullSync, fastSync) {
    const cf = String(cfAvvocato || '').toUpperCase();
    const codici = Array.isArray(codiciUffici) ? codiciUffici : [];
    const full = !!fullSync;
    const fast = !!fastSync;
    // Anti doppio-invio: ignora SOLO i duplicati entro pochi secondi (es. due
    // schede dashboard che inviano insieme). Oltre quella finestra, un avvio
    // richiesto dall'utente deve SEMPRE partire, chiudendo l'eventuale tab
    // vecchio rimasto aperto (che altrimenti bloccherebbe la nuova sync).
    chrome.storage.local.get(['pctOrderSyncStartedAt'], (st) => {
        const startedAt = st.pctOrderSyncStartedAt || 0;
        if ((Date.now() - startedAt) < 8000) {
            console.log('[PCT Monitor] startOrderSync duplicato entro 8s, ignoro');
            return;
        }
        avviaNuovaSyncTab(cf, codici, full, fast);
    });
}

function avviaNuovaSyncTab(cf, codiciUffici, fullSync, fastSync) {
    const codici = Array.isArray(codiciUffici) ? codiciUffici : [];
    const full = !!fullSync;
    const fast = !!fastSync;
    // Chiudi un eventuale tab di sync-ordine precedente ancora aperto, cosi'
    // non resta uno scraper orfano e la nuova sync parte pulita. Se il run
    // precedente aveva riusato una scheda dell'utente, quella NON si chiude.
    chrome.storage.local.get(['pctOrderSyncTabId', 'pctOrderSyncWindowRiusata'], (s) => {
        const oldId = s.pctOrderSyncTabId;
        if (oldId) {
            activeOrderSyncTabs.delete(oldId);
            if (!s.pctOrderSyncWindowRiusata) chrome.tabs.remove(oldId).catch(() => {});
        }
    });
    closeAllScraperTabs();
    // Su questo PC la sync dell'Ordine usa il flusso ORIGINALE PdA Toscana
    // (advanced-search): qui la sessione CNS e' quella del PdA e lo scraper
    // scraper_ordine.js pilota la ricerca per Ufficio x Registro.
    const url = 'https://www.giustizia.toscana.it/pda-rt/cancelleriatelematica/advanced-search#pct-sync-ordine';
    // Oltre all'hash, impostiamo un flag in storage: se l'app Angular rimuove
    // l'hash durante il boot, lo scraper puo' comunque avviarsi leggendo il flag.
    chrome.storage.local.set({
        lastCfAvvocato: cf,
        pctOrderSyncPending: Date.now(),
        pctOrderSyncStartedAt: Date.now(),
        pctOrderSyncRedirects: 0,
        pctOrderSyncLoginClicks: 0,
        pctOrderSyncCodici: codici,
        pctOrderSyncFull: full,
        pctOrderSyncFast: fast,
    });
    // Azzera lo stato della macchina a stati dello scraper Ministero: una nuova
    // sync deve ripartire da zero e non riprendere un run precedente/orfano.
    chrome.storage.local.remove(['pctMinState']);
    // Beacon iniziale: segna subito lo stato 'avvio' nel backend, cosi' la
    // dashboard vede che la richiesta e' partita e sovrascrive record vecchi.
    // Se poi lo stato non passa a 'in_corso', significa che il content script
    // nella tab aperta non e' partito (redirect SPA / mancata iniezione).
    setOrderProgress(cf, {
        stato: 'avvio',
        messaggio: 'Portale PdA Toscana aperto, avvio dello scraper...',
        uffici_totali: 0, uffici_fatti: 0,
        fascicoli_trovati: 0, fascicoli_salvati: 0, errori: 0,
    });
    // Finestra separata aperta SUBITO minimizzata (ridotta a icona), come
    // richiesto dall'utente: non compare sullo schermo. Si chiude da sola a fine
    // cattura ('orderSyncFinished'). NB: Chrome throttla i timer delle finestre
    // nascoste; i timeout lato scraper sono alzati per compensare.
    const registraTabSync = (tabId, riusata) => {
        if (!tabId) return;
        activeOrderSyncTabs.set(tabId, { url, openedAt: Date.now(), cfAvvocato: cf, riusata: !!riusata });
        chrome.storage.local.set({ pctOrderSyncTabId: tabId });
        console.log('[PCT Monitor] Sync Ordine avviata (finestra minimizzata), tabId', tabId);
        updateBadge(tabId, 'sync');
        setTimeout(() => {
            if (activeOrderSyncTabs.has(tabId)) {
                console.log('[PCT Monitor] Timeout sync Ordine, chiudo tab', tabId);
                closeBackgroundTab(tabId);
            }
        }, 40 * 60 * 1000);
    };
    if (chrome.windows && chrome.windows.create) {
        // Riuso della scheda PdA dell'utente: DISATTIVATO. Provato in 1.9.45, ma
        // una scheda in secondo piano nella finestra dell'utente viene rallentata
        // da Chrome e lo scraper si pianta su "Preparazione ricerca". Si torna
        // alla finestra separata ridotta a icona, che invece non compare davanti
        // perche' il fuoco ora si prende solo se lo scraper risulta bloccato.
        const RIUSA_SCHEDA_PDA = false;
        chrome.tabs.query({ url: 'https://www.giustizia.toscana.it/pda-rt/*' }, (tabs) => {
            const riusabile = RIUSA_SCHEDA_PDA
                ? (tabs || []).find((t) => t && t.id && !t.active && !activeOrderSyncTabs.has(t.id))
                : null;
            if (riusabile) {
                orderSyncWindowId = riusabile.windowId || null;
                orderSyncWindowRiusata = true;
                chrome.storage.local.set({
                    pctOrderSyncWindowId: orderSyncWindowId,
                    pctOrderSyncWindowRiusata: true,
                });
                console.log('[PCT Monitor] Riuso la scheda PdA gia aperta, tabId', riusabile.id);
                // Niente 'active: true': la scheda resta dove sta, in secondo piano.
                chrome.tabs.update(riusabile.id, { url }, () => { registraTabSync(riusabile.id, true); });
                return;
            }
            orderSyncWindowRiusata = false;
            chrome.storage.local.set({ pctOrderSyncWindowRiusata: false });
            chrome.windows.create({ url, focused: false, state: 'minimized', type: 'normal' }, (win) => {
                const tab = win && win.tabs && win.tabs[0];
                if (win && win.id) {
                    orderSyncWindowId = win.id;
                    chrome.storage.local.set({ pctOrderSyncWindowId: win.id });
                    chrome.windows.update(win.id, { state: 'minimized' }).catch(() => {});
                }
                if (tab && tab.id) {
                    registraTabSync(tab.id);
                } else {
                    chrome.tabs.create({ url, active: false }, (t) => { if (t) registraTabSync(t.id); });
                }
            });
        });
    } else {
        chrome.tabs.create({ url, active: false }, (tab) => { if (tab) registraTabSync(tab.id); });
    }
}

// Id della finestra separata di sync (per il "risveglio" anti-throttling).
let orderSyncWindowId = null;
// true quando il sync sta riusando una finestra/scheda dell'utente: in quel caso
// NON si tocca mai lo stato della finestra (ne' fuoco ne' riduzione a icona),
// altrimenti si minimizzerebbe una finestra che l'utente sta usando.
let orderSyncWindowRiusata = false;

// Quante sincronizzazioni sta davvero facendo questa estensione in questo
// momento. Serve a rispondere alla pagina quando il record di progresso sul
// server e' rimasto "in_corso" per una corsa morta (browser chiuso, sessione
// del Portale scaduta, estensione aggiornata): in quel caso il contatore e' a
// zero e il pulsante "Sync fascicolo" deve poter ripartire subito.
let corseSyncAttive = 0;

/** true se la finestra di sync e' una finestra dell'utente (riusata). */
async function isOrderSyncWindowRiusata() {
    if (orderSyncWindowRiusata) return true;
    try {
        const st = await chrome.storage.local.get(['pctOrderSyncWindowRiusata']);
        return !!st.pctOrderSyncWindowRiusata;
    } catch (e) { return false; }
}

// Porta la finestra di sync brevemente a fuoco per rompere il throttling di
// Chrome sui timer delle finestre minimizzate (l'autocomplete Angular del PdA
// usa debounce/HTTP che restano bloccati se la finestra e' nascosta), poi la
// re-minimizza subito. Ritorna una Promise che si risolve quando ha ri-nascosto.
// Ultima risorsa: si usa solo quando lo scraper e' bloccato, mai di routine.
async function wakeOrderSyncWindow(ms) {
    if (await isOrderSyncWindowRiusata()) return false;
    const winId = await getOrderSyncWindowId();
    if (!winId) return false;
    const durata = Math.max(300, Math.min(4000, ms || 1200));
    try {
        await chrome.windows.update(winId, { state: 'normal', focused: true, drawAttention: false });
    } catch (e) { return false; }
    await new Promise((r) => setTimeout(r, durata));
    await minimizeOrderSyncWindow();
    return true;
}

/** Risolve l'id della finestra di sync (da variabile o storage). */
async function getOrderSyncWindowId() {
    let winId = orderSyncWindowId;
    if (!winId) {
        try {
            const st = await chrome.storage.local.get(['pctOrderSyncWindowId']);
            winId = st.pctOrderSyncWindowId || null;
        } catch (e) { /* noop */ }
    }
    return winId;
}

/** Rende "sveglia" la finestra di sync SENZA rubare il primo piano all'utente:
 *  la si porta in stato normale ma non a fuoco. Se la finestra e' dell'utente
 *  (riusata) non si tocca nulla. */
async function focusOrderSyncWindow() {
    if (await isOrderSyncWindowRiusata()) return true;
    const winId = await getOrderSyncWindowId();
    if (!winId) return false;
    try {
        await chrome.windows.update(winId, { state: 'normal', focused: false, drawAttention: false });
        return true;
    } catch (e) { return false; }
}

/** Ri-minimizza (nasconde) la finestra di sync. Mai su finestre dell'utente. */
async function minimizeOrderSyncWindow() {
    if (await isOrderSyncWindowRiusata()) return true;
    const winId = await getOrderSyncWindowId();
    if (!winId) return false;
    try {
        await chrome.windows.update(winId, { state: 'minimized' });
        return true;
    } catch (e) { return false; }
}

// Scrive lo stato di avanzamento sync-ordine nel backend (usato per il beacon
// iniziale dal service worker, che ha CF + token ma non gira nella pagina).
function setOrderProgress(cf, extra) {
    if (!/^[A-Z0-9]{16}$/.test(cf)) return;
    chrome.storage.local.get(['backendUrl', 'apiToken'], (st) => {
        const base = (st.backendUrl || 'http://localhost/pct/api_sync.php').replace(/\/api_sync[^/]*\.php$/, '');
        const apiToken = st.apiToken || 'pct_aruba_2026_adb200f9';
        const body = Object.assign({ azione: 'progresso_set', cf_avvocato: cf }, extra || {});
        fetch(base + '/api_sync_ordine.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Token': apiToken, 'X-Cf-Avvocato': cf },
            body: JSON.stringify(body),
        }).catch(() => {});
    });
}

chrome.tabs.onRemoved.addListener((tabId) => {
    if (activeScraperTabs.has(tabId)) {
        activeScraperTabs.delete(tabId);
        console.log('[PCT Monitor] Tab di background chiusa manualmente', tabId);
    }
    if (activeOrderSyncTabs.has(tabId)) {
        activeOrderSyncTabs.delete(tabId);
        console.log('[PCT Monitor] Tab sync Ordine chiusa manualmente', tabId);
    }
});

// ─── Servizio locale dell'avvocato (AstarFirmaServer) ─────────────────────────
// I documenti del fascicolo NON vanno su Aruba: vengono scaricati dal PdA (nel
// content script) e consegnati qui al servizio locale, che li salva in
// Documenti\PCT Monitor\<fascicolo>. Una pagina https non puo' parlare con
// http://localhost (mixed-content): per questo le chiamate a localhost partono
// dal background, che vive nell'origine dell'estensione.
const SERVER_LOCALE = 'http://localhost:8766';
const APP_LOCALE = '&app=pct';
let _serverLocale = { quando: 0, salva: false, documento: false };

function serverLocaleCapacita() {
    if (Date.now() - _serverLocale.quando < 20000) return Promise.resolve(_serverLocale);
    return fetch(SERVER_LOCALE + '/status', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
            const e = (j && j.endpoints) || [];
            _serverLocale = {
                quando: Date.now(),
                salva: e.indexOf('/salva-documento') !== -1,
                documento: e.indexOf('/documento') !== -1,
            };
            return _serverLocale;
        })
        .catch(() => {
            _serverLocale = { quando: Date.now(), salva: false, documento: false };
            return _serverLocale;
        });
}

function base64ToBytes(b64) {
    const bin = atob(b64 || '');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function astarSalvaDocumento(msg) {
    const q = '?cartella=' + encodeURIComponent(msg.cartella || '')
        + '&parte=' + encodeURIComponent(msg.parte || '')
        + '&nome=' + encodeURIComponent(msg.nome || 'documento')
        + APP_LOCALE;
    return fetch(SERVER_LOCALE + '/salva-documento' + q, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: base64ToBytes(msg.dataBase64 || ''),
    })
        .then((r) => r.json().catch(() => null))
        .then((j) => {
            if (!j || !j.ok) return { ok: false, error: (j && j.error) || 'salvataggio non confermato' };
            return { ok: true, path: j.path, dimensione: j.dimensione };
        })
        .catch((e) => ({ ok: false, error: e.message || String(e) }));
}

function astarElencoFascicolo(cartella) {
    return fetch(SERVER_LOCALE + '/elenco-fascicolo?cartella=' + encodeURIComponent(cartella || '') + APP_LOCALE, { cache: 'no-store' })
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then((j) => {
            if (!j || !j.ok) throw new Error('risposta non valida');
            return { ok: true, files: (j.files || []).map((f) => ({ parte: f.parte, nome: f.nome, path: f.path, size: (f.size != null ? f.size : (f.dimensione != null ? f.dimensione : (f.bytes != null ? f.bytes : null))) })) };
        })
        .catch((e) => ({ ok: false, error: e.message || String(e), files: [] }));
}

// Elimina l'intera cartella del fascicolo dal PC dell'avvocato (usata dal
// pulsante "Elimina fascicolo" del pannello). Richiede AstarFirmaServer >= 2.0.6.
function astarEliminaFascicolo(cartella) {
    // Il corpo vuoto e' obbligatorio: il servizio locale gira su HTTP.SYS, che
    // rifiuta una POST senza Content-Length con un 411 "Length Required". Senza
    // questo la cartella sul PC non veniva mai cancellata.
    return fetch(SERVER_LOCALE + '/elimina-fascicolo?cartella=' + encodeURIComponent(cartella || '') + APP_LOCALE,
        { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then((r) => r.json().catch(() => ({})).then((j) => ({ status: r.status, j })))
        .then(({ status, j }) => {
            if (status === 404) return { ok: false, error: 'endpoint assente (aggiorna Firma Digitale)', outdated: true };
            if (!j || !j.ok) return { ok: false, error: (j && j.error) || ('HTTP ' + status) };
            return { ok: true, eliminata: !!j.eliminata, assente: !!j.assente, path: j.path || '' };
        })
        .catch((e) => ({ ok: false, error: e.message || String(e), offline: true }));
}

function bytesToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}

// Apre (per anteprima/scaricamento nel pannello) un documento che sta sul PC
// dell'avvocato: prima localizza il file col servizio locale (/trova-documento),
// poi ne scarica il contenuto (/documento, che sbusta anche i .p7m) e lo
// restituisce in base64 con il relativo mime-type.
function astarApriDocumento(msg) {
    // Se il chiamante conosce gia' il percorso relativo ESATTO del file sul disco
    // (ricavato da /elenco-fascicolo), lo usiamo direttamente: evita la
    // risoluzione per solo-nome, che con nomi ripetuti (es. DatiAtto.xml presente
    // in piu' sottocartelle) aprirebbe il file sbagliato.
    if (msg.path) {
        return Promise.resolve({ ok: true, path: msg.path, nome: msg.nome || '' })
            .then((j) => astarScaricaDaPath(j, msg));
    }
    const q = '?cartella=' + encodeURIComponent(msg.cartella || '')
        + '&parte=' + encodeURIComponent(msg.parte || '')
        + '&nome=' + encodeURIComponent(msg.nome || '')
        + APP_LOCALE;
    return fetch(SERVER_LOCALE + '/trova-documento' + q, { cache: 'no-store' })
        .then((r) => r.json().catch(() => null))
        .then((j) => {
            if (!j || !j.ok || !j.path) {
                throw new Error((j && j.error) || 'documento non trovato sul PC');
            }
            return astarScaricaDaPath(j, msg);
        })
        .catch((e) => ({ ok: false, error: e.message || String(e) }));
}

// Scarica il contenuto (e info firma) di un file gia' localizzato (j.path).
function astarScaricaDaPath(j, msg) {
    const pathEnc = encodeURIComponent(j.path);
            // Modalita' RAW: scarica la busta firmata ORIGINALE dal disco (senza
            // sbustare il .p7m). Usata dal pulsante "Scarica" del pannello: l'avvocato
            // deve ottenere il file firmato integro, non il PDF estratto.
            if (msg.raw) {
                return fetch(SERVER_LOCALE + '/documento?path=' + pathEnc + '&raw=1' + APP_LOCALE, { cache: 'no-store' })
                    .then((rr) => {
                        if (!rr.ok) throw new Error('HTTP ' + rr.status);
                        return rr.arrayBuffer().then((buf) => ({
                            ok: true,
                            mime: 'application/octet-stream',
                            nome: j.nome || msg.nome || 'documento',
                            dataBase64: bytesToBase64(buf),
                            raw: true,
                        }));
                    })
                    .catch((e) => ({ ok: false, error: e.message || String(e) }));
            }
            // Info firma (firmatari) in parallelo: serve al pannello per mostrare
            // il dettaglio della firma digitale quando si apre la busta firmata.
            const infoP = fetch(SERVER_LOCALE + '/documento-info?path=' + pathEnc + APP_LOCALE, { cache: 'no-store' })
                .then((ri) => (ri.ok ? ri.json().catch(() => null) : null))
                .catch(() => null);
            const contentP = fetch(SERVER_LOCALE + '/documento?path=' + pathEnc + APP_LOCALE, { cache: 'no-store' })
                .then((rr) => {
                    if (!rr.ok) throw new Error('HTTP ' + rr.status);
                    const mime = rr.headers.get('Content-Type') || 'application/octet-stream';
                    return rr.arrayBuffer().then((buf) => ({
                        mime: mime.split(';')[0].trim(),
                        dataBase64: bytesToBase64(buf),
                    }));
                });
            return Promise.all([contentP, infoP]).then(([c, info]) => ({
                ok: true,
                mime: c.mime,
                nome: j.nome || msg.nome || 'documento',
                dataBase64: c.dataBase64,
                firmato: !!(info && info.firmato),
                signatureChecked: !!(info && info.ok === true && typeof info.firmato === 'boolean'),
                signers: (info && Array.isArray(info.signers)) ? info.signers : [],
            }))
            .catch((e) => ({ ok: false, error: e.message || String(e) }));
}

// ─── Firma digitale CNS ───────────────────────────────────────────────────────
// La pagina "Firma digitale" del pannello non puo' chiamare il servizio locale
// direttamente: AstarFirmaServer accetta solo gli origin che ha in whitelist
// (sincronizzafascicolo.it e l'estensione), mentre il pannello e' servito da
// sincpdatoscana.it. Le chiamate passano quindi da qui, con i percorsi ammessi
// elencati esplicitamente.
const FIRMA_PERCORSI = /^\/(status|cert|sign|sign-pades|verify|extract|reload-cns|eject-cns|restart|download\/[^/?#]+)$/;

function astarFirmaChiamata(msg) {
    const percorso = String(msg.path || '');
    if (!FIRMA_PERCORSI.test(percorso)) {
        return Promise.resolve({ ok: false, error: 'percorso non consentito: ' + percorso });
    }
    const metodo = (String(msg.method || 'GET').toUpperCase() === 'POST') ? 'POST' : 'GET';
    const opz = { method: metodo, cache: 'no-store' };
    if (metodo === 'POST') {
        const fd = new FormData();
        const campi = msg.campi || {};
        Object.keys(campi).forEach((k) => { if (campi[k] !== null && campi[k] !== undefined) fd.append(k, String(campi[k])); });
        if (msg.fileBase64) {
            const b = new Blob([base64ToBytes(msg.fileBase64)], { type: 'application/octet-stream' });
            // Il servizio locale riconosce la parte col nome "file" e ne legge il filename.
            fd.append('file', b, msg.fileNome || 'documento');
        }
        opz.body = fd;
    }
    return fetch(SERVER_LOCALE + percorso, opz)
        .then((r) => {
            const ct = (r.headers.get('Content-Type') || '').toLowerCase();
            if (ct.indexOf('json') !== -1) {
                return r.json().catch(() => null).then((j) => ({
                    ok: true,
                    stato: r.status,
                    json: j,
                    error: r.ok ? '' : ('HTTP ' + r.status + (j && (j.error || j.message) ? ': ' + (j.error || j.message) : '')),
                }));
            }
            // Errore senza corpo JSON (es. eccezione del servizio): si riporta il
            // testo, altrimenti la pagina mostrerebbe "errore sconosciuto".
            if (!r.ok) {
                return r.text().catch(() => '').then((t) => ({
                    ok: false,
                    stato: r.status,
                    error: 'HTTP ' + r.status + (t ? ': ' + String(t).slice(0, 400) : ''),
                }));
            }
            return r.arrayBuffer().then((buf) => ({
                ok: true,
                stato: r.status,
                mime: ct.split(';')[0].trim() || 'application/octet-stream',
                dataBase64: bytesToBase64(buf),
            }));
        })
        .catch((e) => ({ ok: false, error: e.message || String(e) }));
}

// ─── Ricerca fascicoli in API diretta (senza finestra del PdA) ────────────────
// La ricerca non passa piu' dal form Angular di /advanced-search: il service
// worker chiama direttamente le API REST del portale (pda_ricerca.js) col token
// Keycloak intercettato. La finestra del PdA serve solo alla fase documenti,
// che usa il motore di scarico collaudato dentro la pagina.

/** Radice del backend (senza il nome del file) da un indirizzo api_sync.php. */
function radiceBackend(url) {
    return String(url || 'http://localhost/pct/api_sync.php')
        .replace(/\/api_sync[^/]*\.php.*$/, '')
        .replace(/\/+$/, '');
}

/** Riga nel registro della sync (logs/sync_ordine.log), come fa lo scraper. */
function logSync(base, cf, riga, reset) {
    try {
        if (reset) logLocaleNuovaCorsa(cf);
        logLocaleAggiungi(cf, riga);
        fetch(base + '/api_sync_log.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cf: cf || '', lines: [String(riga)], reset: !!reset }),
        }).catch(() => {});
    } catch (e) { /* il registro non e' critico */ }
}

// ─── Registro della corsa sul PC dell'avvocato ───────────────────────────────
// Oltre alla copia sul server, ogni corsa lascia un file sul PC, nella stessa
// cartella dei documenti: Documents\PCT Monitor\logs\sync_<data>_<ora>.log.
//
// Perche' sul PC: il log del server veniva azzerato all'inizio di ogni corsa,
// percio' con piu' avvocati in parallelo l'ultimo che partiva cancellava la
// traccia degli altri. Ora quei file sono separati per codice fiscale, ma il
// file locale aggiunge quello che il server non puo' dare: resta per sempre,
// uno per corsa, quindi non si sovrascrive mai nulla, e non fa crescere il
// disco del server.
//
// Perche' NON solo sul PC: scrivere in locale dipende da AstarFirmaServer
// attivo. Se e' spento si perderebbe il log proprio quando serve, cioe' quando
// qualcosa non va: la copia sul server resta come rete di sicurezza.
const LogLocale = {
    nome: '',
    righe: [],
    disponibile: true,   // diventa false se il companion non risponde
    scritturaInCorso: false,
    daScrivere: false,
    timer: null,
};

/** Apre il file di una nuova corsa. Il nome porta data e ora: e' irripetibile. */
function logLocaleNuovaCorsa(cf) {
    const d = new Date();
    const due = (n) => String(n).padStart(2, '0');
    const stampo = d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(d.getDate())
        + '_' + due(d.getHours()) + '-' + due(d.getMinutes()) + '-' + due(d.getSeconds());
    LogLocale.nome = 'sync_' + stampo + '.log';
    LogLocale.righe = ['# PCT Monitor - corsa del ' + d.toLocaleString('it-IT')
        + (cf ? ' - avvocato ' + cf : '')];
    LogLocale.disponibile = true;
}

/** Accoda una riga e programma la scrittura su disco. */
function logLocaleAggiungi(cf, riga) {
    if (!LogLocale.disponibile) return;
    if (!LogLocale.nome) logLocaleNuovaCorsa(cf);
    const d = new Date();
    const due = (n) => String(n).padStart(2, '0');
    LogLocale.righe.push(due(d.getHours()) + ':' + due(d.getMinutes()) + ':' + due(d.getSeconds())
        + '\t' + String(riga).replace(/[\r\n]+/g, ' '));
    // Si riscrive l'intero file, non si appende: il servizio locale sa solo
    // salvare un documento per intero. Accorpare le righe per un secondo
    // evita di riscriverlo a ogni singola riga durante una corsa lunga.
    LogLocale.daScrivere = true;
    if (LogLocale.timer) return;
    LogLocale.timer = setTimeout(() => { LogLocale.timer = null; logLocaleScrivi(); }, 1200);
}

/** Scrive sul PC il contenuto accumulato finora. */
async function logLocaleScrivi() {
    if (!LogLocale.disponibile || !LogLocale.daScrivere) return;
    if (LogLocale.scritturaInCorso) { return; }
    LogLocale.scritturaInCorso = true;
    LogLocale.daScrivere = false;
    try {
        const testo = LogLocale.righe.join('\r\n') + '\r\n';
        const byte = new TextEncoder().encode(testo);
        let bin = '';
        for (let i = 0; i < byte.length; i++) bin += String.fromCharCode(byte[i]);
        const r = await astarSalvaDocumento({
            cartella: 'logs', parte: '', nome: LogLocale.nome, dataBase64: btoa(bin),
        });
        if (!r || !r.ok) {
            // Companion spento o versione che non accetta questa cartella: si
            // smette di provare per il resto della corsa e si resta sul server.
            LogLocale.disponibile = false;
        }
    } catch (e) {
        LogLocale.disponibile = false;
    } finally {
        LogLocale.scritturaInCorso = false;
        if (LogLocale.daScrivere && LogLocale.disponibile && !LogLocale.timer) {
            LogLocale.timer = setTimeout(() => { LogLocale.timer = null; logLocaleScrivi(); }, 400);
        }
    }
}

/** Una chiamata a api_sync_ordine.php; ritorna il JSON o {error}. */
async function postOrdine(base, apiToken, cf, payload) {
    try {
        const { resp } = await fetchConRipiego(base + '/api_sync_ordine.php', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Api-Token': apiToken || '',
                'X-Cf-Avvocato': cf,
            },
            body: JSON.stringify(Object.assign({ cf_avvocato: cf }, payload || {})),
        });
        const testo = await resp.text();
        let j = null;
        try { j = JSON.parse(testo); } catch (e) { /* risposta non JSON */ }
        if (!j) return { error: 'risposta non in JSON (HTTP ' + resp.status + '): ' + testo.slice(0, 200) };
        return j;
    } catch (e) {
        return { error: (e && e.message) || String(e) };
    }
}

// Chrome spegne il service worker dopo 30 secondi di inattivita': durante la
// ricerca (minuti, decine di chiamate) si tiene sveglio interrogando una API
// dell'estensione a intervalli regolari.
let sveglioTimer = null;
function tieniSveglio(attiva) {
    if (attiva) {
        if (sveglioTimer) return;
        sveglioTimer = setInterval(() => {
            try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) { /* noop */ }
        }, 20000);
    } else if (sveglioTimer) {
        clearInterval(sveglioTimer);
        sveglioTimer = null;
    }
}

/**
 * RICERCA LATO SERVER (Aruba): il backend interroga il PdA con curl
 * server-to-server (api_sync_ordine_diretto.php). Qui si consegnano i token e si
 * ripassa a blocchi finche' non e' completata: nessuna finestra, nessuna
 * chiamata al portale dal browser, niente throttling di Chrome.
 *
 * @returns esito con gli stessi campi di ricercaDirettaOrdine, piu' `pubblicata`
 *          (false quando l'endpoint non c'e' ancora sul server).
 */
async function ricercaServerAruba(cf, base, apiToken, codici, log) {
    const esito = {
        ok: false, pubblicata: true, motivo: '', ordine: '', provincia: '',
        uffici: 0, trovati: 0, salvati: 0, errori: 0,
        scoperti: [], codiciFatti: [], lista: [], nomiUffici: {},
    };
    const st = await chrome.storage.local.get(['pdaAccessToken', 'pdaRefreshToken']);
    let access = String(st.pdaAccessToken || '');
    let refresh = String(st.pdaRefreshToken || '');
    if (!access && !refresh) {
        esito.motivo = 'token del PdA non disponibile';
        return esito;
    }

    const visti = new Set();
    let da = 0;
    for (let blocco = 1; blocco <= 60; blocco++) {
        let risposta = null;
        try {
            const { resp } = await fetchConRipiego(base + '/api_sync_ordine_diretto.php', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Api-Token': apiToken || '',
                    'X-Cf-Avvocato': cf,
                },
                body: JSON.stringify({
                    cf_avvocato: cf, access, refresh, codici, da,
                    trovati: esito.trovati, salvati: esito.salvati, errori: esito.errori,
                    documenti: true,
                }),
            });
            if (resp.status === 404) {
                // File non ancora pubblicato sul server: si passa alla ricerca
                // dal service worker senza trattarlo come un guasto.
                esito.pubblicata = false;
                esito.motivo = 'api_sync_ordine_diretto.php non presente sul server';
                return esito;
            }
            const testo = await resp.text();
            try { risposta = JSON.parse(testo); } catch (e) { /* non JSON */ }
            if (!risposta) {
                esito.motivo = 'risposta non in JSON (HTTP ' + resp.status + '): ' + testo.slice(0, 160);
                return esito;
            }
        } catch (e) {
            esito.motivo = 'rete verso il backend: ' + ((e && e.message) || e);
            return esito;
        }
        if (risposta.success !== true) {
            esito.motivo = risposta.error || 'errore del server';
            return esito;
        }

        esito.trovati = risposta.trovati | 0;
        esito.salvati = risposta.salvati | 0;
        esito.errori = risposta.errori | 0;
        esito.uffici = risposta.totale | 0;
        if (risposta.ordine) esito.ordine = String(risposta.ordine);
        if (risposta.provincia) esito.provincia = String(risposta.provincia);
        (risposta.scoperti || []).forEach((c) => {
            const k = String(c);
            if (k && esito.scoperti.indexOf(k) === -1) esito.scoperti.push(k);
        });
        (risposta.lista || []).forEach((f) => {
            if (f && f.link && !visti.has(f.link)) { visti.add(f.link); esito.lista.push(f); }
        });
        Object.assign(esito.nomiUffici, risposta.uffici || {});
        // Il server rinnova il token quando serve: si riporta nello storage, cosi'
        // la fase documenti sul PC parte con un token buono.
        if (risposta.access && risposta.access !== access) {
            access = String(risposta.access);
            refresh = String(risposta.refresh || refresh);
            await chrome.storage.local.set({
                pdaAccessToken: access, pdaRefreshToken: refresh, pdaTokenAt: Date.now(),
            });
        }
        log('  ricerca su Aruba, blocco ' + blocco + ': uffici ' + (risposta.da | 0) + '/' + esito.uffici
            + ' · trovati ' + esito.trovati + ' · salvati ' + esito.salvati + ' · errori ' + esito.errori);

        if (risposta.completato) {
            esito.ok = true;
            esito.codiciFatti = codici.slice();
            return esito;
        }
        if ((risposta.da | 0) <= da) {
            esito.motivo = 'il cursore del server non avanza (fermo a ' + da + ')';
            return esito;
        }
        da = risposta.da | 0;
    }
    esito.motivo = 'troppi blocchi senza arrivare in fondo';
    return esito;
}

// ─── Scarico documenti senza finestra (documento offscreen) ───────────────────
// Il motore pda_download.js ha bisogno di un DOM (DOMParser sul DatiAtto), non
// della pagina del PdA. Un documento offscreen glielo da' senza aprire nulla a
// schermo e senza il throttling che Chrome applica alle finestre ridotte a icona.
let attesaOffscreen = null;   // resolver dell'attesa di 'offscreenFinito'

async function offscreenAperto() {
    try {
        if (chrome.runtime.getContexts) {
            const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
            return !!(ctx && ctx.length);
        }
    } catch (e) { /* API non disponibile: si prova a crearlo */ }
    return false;
}

async function assicuraOffscreen() {
    if (!chrome.offscreen || !chrome.offscreen.createDocument) {
        throw new Error('API offscreen non disponibile (serve Chrome 109+)');
    }
    if (await offscreenAperto()) return;
    try {
        await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['DOM_PARSER'],
            justification: 'Lettura del DatiAtto.xml delle buste del PdA durante lo scarico dei documenti.',
        });
    } catch (e) {
        // Creazione in corsa con un'altra chiamata: se il documento c'e' va bene.
        if (!/single offscreen|already exist/i.test((e && e.message) || '')) throw e;
    }
}

async function chiudiOffscreen() {
    try {
        if (chrome.offscreen && chrome.offscreen.closeDocument && (await offscreenAperto())) {
            await chrome.offscreen.closeDocument();
        }
    } catch (e) { /* niente da chiudere */ }
}

/**
 * Scarica i documenti dei fascicoli indicati senza aprire alcuna finestra.
 * @param pacco {lista, uffici, ordine, provincia}
 * @returns {ok, motivo, esito}
 */
async function scaricaSenzaFinestra(cf, base, apiToken, pacco, log) {
    const lista = (pacco && pacco.lista) || [];
    if (!lista.length) return { ok: true, esito: { tot: 0 } };
    try {
        await assicuraOffscreen();
    } catch (e) {
        return { ok: false, motivo: (e && e.message) || String(e) };
    }

    const payload = {
        lista,
        uffici: pacco.uffici || {},
        ordine: pacco.ordine || '',
        provincia: pacco.provincia || '',
        ambito: pacco.ambito || '',
        cf,
        base,
        ordineUrl: base + '/api_sync_ordine.php',
        apiToken: apiToken || '',
    };

    // L'attesa e' risolta dal messaggio 'offscreenFinito'; il tetto di tempo
    // evita di restare appesi se il documento offscreen muore.
    const attesa = new Promise((resolve) => {
        attesaOffscreen = resolve;
        setTimeout(() => {
            if (attesaOffscreen === resolve) { attesaOffscreen = null; resolve({ scaduta: true }); }
        }, 6 * 60 * 60 * 1000);
    });

    const avvio = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'offscreenScarica', payload }, (r) => {
            if (chrome.runtime.lastError) { resolve({ error: chrome.runtime.lastError.message }); return; }
            resolve(r || { error: 'nessuna risposta dal documento offscreen' });
        });
    });
    if (!avvio || !avvio.avviato) {
        attesaOffscreen = null;
        await chiudiOffscreen();
        return { ok: false, motivo: (avvio && (avvio.error || avvio.motivo)) || 'avvio rifiutato' };
    }

    const esito = await attesa;
    await chiudiOffscreen();
    if (esito && esito.scaduta) return { ok: false, motivo: 'scarico offscreen senza risposta' };
    if (esito && esito.errore) return { ok: false, motivo: esito.errore };
    // Nessun fascicolo lavorato, oppure tutti in errore (tipico se il portale
    // rifiuta le chiamate dall'origine dell'estensione): si ripiega.
    if (esito && esito.tot && !esito.fatti) {
        return { ok: false, motivo: esito.motivo || 'nessun fascicolo lavorato' };
    }
    if (esito && esito.bloccoTotale) {
        return { ok: false, motivo: esito.motivo || 'scarico bloccato dal portale' };
    }
    if (esito && esito.tot && esito.errori >= esito.tot) {
        return { ok: false, motivo: 'tutti i fascicoli in errore nello scarico offscreen' };
    }
    if (log) {
        log('SCARICO senza finestra: ' + ((esito && esito.nuovi) || 0) + ' documenti nuovi su '
            + ((esito && esito.tot) || 0) + ' fascicoli, errori ' + ((esito && esito.errori) || 0));
    }
    return { ok: true, esito: esito || {} };
}

/**
 * Ripasso veloce (bottone "Aggiorna") senza finestra: l'elenco dei link arriva
 * dal backend e i documenti li scarica il documento offscreen.
 */
async function scaricoVeloceSenzaFinestra(cf, base, apiToken, codici, log) {
    let r = null;
    try {
        r = await postOrdine(base, apiToken, cf, { azione: 'link_fascicoli', codici });
    } catch (e) {
        return { ok: false, motivo: 'link_fascicoli: ' + ((e && e.message) || e) };
    }
    if (!r || !r.success) return { ok: false, motivo: 'link_fascicoli: risposta inattesa' };
    const lista = (r.fascicoli || []).filter((f) => f && f.link && f.link.indexOf('/dettaglio-fascicolo/') !== -1);
    if (!lista.length) return { ok: false, motivo: 'nessun link salvato' };
    if (log) log('AGGIORNAMENTO VELOCE senza finestra: ' + lista.length + ' fascicoli dai link salvati');
    const esitoVeloce = await scaricaSenzaFinestra(cf, base, apiToken, {
        lista,
        uffici: r.uffici || {},
        ordine: r.ordine || '',
        provincia: r.provincia || '',
    }, log);
    // Senza questo passo l'archivio resta a meta': i documenti arrivano, ma
    // profilo, cronologia, comunicazioni e schede no.
    await aggiornaSchedePerElenco(base, apiToken, lista, log);
    return esitoVeloce;
}

/**
 * Aggiorna a monitor le schede del fascicolo (Incarichi, Beni, Lotti, Libretti,
 * Spese, Pendenze, Istanze).
 *
 * Le legge il server chiamando i servizi del Portale col token della sessione:
 * qui si passa soltanto l'indirizzo del fascicolo e il token, quindi non si apre
 * nessuna scheda e non si scarica niente due volte.
 */
async function aggiornaSchedePortale(base, apiToken, link, log, tokenOverride) {
    try {
        const st = await chrome.storage.local.get(['pdaAccessToken']);
        // Si preferisce il token passato (vivo, letto dalla pagina) a quello in
        // storage, che potrebbe essere scaduto e far rispondere 401 alle schede.
        const token = (tokenOverride && String(tokenOverride)) || st.pdaAccessToken;
        if (!token) {
            if (log) log('SCHEDE: sessione del Portale assente, salto');
            return null;
        }
        const r = await fetch(base + '/api_sync_sezioni.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-TOKEN': apiToken },
            body: JSON.stringify({ url: link, token_pda: token }),
        });
        const j = await r.json();
        if (log) {
            if (j && j.success && j.sezioni) {
                const righe = Object.keys(j.sezioni)
                    .map((k) => k + '=' + j.sezioni[k].righe + (j.sezioni[k].esito === 'errore' ? '(ko)' : ''))
                    .join(' ');
                log('SCHEDE: ' + righe + ' in ' + (j.secondi || '?') + 's');
            if (j.schede_storiche && j.schede_storiche.esito === 'errore') {
                log('SCHEDE STORICHE incompleta: ' + (j.schede_storiche.nota || 'errore senza dettagli'));
            }
            } else {
                log('SCHEDE non aggiornate: ' + ((j && j.error) || 'risposta non valida'));
            }
        }
        return j;
    } catch (e) {
        if (log) log('SCHEDE: eccezione → ' + ((e && e.message) || e));
        return null;
    }
}

/**
 * Schede del Portale per un elenco di fascicoli (corsa massiva).
 *
 * Il sync di un solo fascicolo chiama aggiornaSchedePortale(), che fa leggere al
 * server profilo, cronologia, comunicazioni, scadenze e le sette schede con il
 * token della sessione. La corsa massiva non lo faceva: salvava solo quello che
 * l'estensione ricava dall'elenco atti, e percio' il fascicolo restava senza
 * sezione, rito, stato, oggetto, data di iscrizione e comunicazioni finche' non
 * lo si ripassava a mano con "Sync fascicolo".
 *
 * Gira DOPO lo scarico dei documenti e non in parallelo: userebbe la stessa
 * sessione del Portale e il motore dei documenti, trovando buste vuote,
 * ripiegherebbe su seriale peggiorando i tempi. Due fascicoli per volta: e'
 * lavoro del server, non del browser, ma non va inondato.
 */
async function aggiornaSchedePerElenco(base, apiToken, lista, log) {
    const fascicoli = (lista || []).filter((f) => f && f.link
        && f.link.indexOf('/dettaglio-fascicolo/') !== -1);
    if (!fascicoli.length) return;
    const t0 = Date.now();
    let fatti = 0, falliti = 0;
    const PARALLELE = 2;
    let i = 0;
    async function corsia() {
        while (i < fascicoli.length) {
            const f = fascicoli[i++];
            const j = await aggiornaSchedePortale(base, apiToken, f.link, null);
            if (j && j.success) fatti++; else falliti++;
        }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLELE, fascicoli.length) }, corsia));
    if (log) {
        log('SCHEDE DEL PORTALE: ' + fatti + '/' + fascicoli.length + ' fascicoli aggiornati'
            + (falliti ? ' (' + falliti + ' non riusciti)' : '')
            + ' in ' + Math.round((Date.now() - t0) / 100) / 10 + 's');
    }
}

async function raccogliDettagliSezioniPaginaEsistente(link, richieste, sezioniDom, log) {
    const sezioni = richieste && typeof richieste === 'object' ? richieste : {};
    const nomiDom = Array.isArray(sezioniDom) ? sezioniDom : [];
    if (!Object.keys(sezioni).length && !nomiDom.length) return { dettagli_salvati: 0, dettagli_saltati: 0 };
    const normalizza = valore => String(valore || '').split(/[?#]/, 1)[0].replace(/\/+$/, '').toLowerCase();
    const atteso = normalizza(link);
    const tabs = await chrome.tabs.query({ url: 'https://www.giustizia.toscana.it/pda-rt/cancelleriatelematica/dettaglio-fascicolo/*' });
    const tab = tabs.find(candidato => normalizza(candidato.url) === atteso);
    if (!tab || !Number.isInteger(tab.id)) {
        if (log) log('LENTI DOM: fascicolo non gia aperto nel PdA; nessuna nuova scheda creata');
        return { dettagli_salvati: 0, saltati: 0, nonDisponibile: true };
    }
    try {
        const risposta = await chrome.tabs.sendMessage(tab.id, {
            action: 'scrapeDettagliFascicolo',
            link,
            richieste: sezioni,
            sezioni_dom: nomiDom,
        });
        if (log) log('SCHEDE DOM/LENTI: ' + Number(risposta && risposta.sezioni_dom && risposta.sezioni_dom.length || 0)
            + ' sezioni lette, ' + Number(risposta && risposta.dettagli_salvati || 0) + ' dettagli salvati'
            + (risposta && risposta.nonLette && risposta.nonLette.length ? ', sezioni non lette: ' + risposta.nonLette.join(',') : '')
            + (risposta && risposta.dettagli_non_letti && risposta.dettagli_non_letti.length ? ', lenti non lette: ' + risposta.dettagli_non_letti.join(',') : '')
            + (risposta && risposta.error ? ' (' + risposta.error + ')' : ''));
        return risposta || { dettagli_salvati: 0, saltati: 0 };
    } catch (e) {
        if (log) log('LENTI DOM non disponibili: ' + ((e && e.message) || e));
        return { dettagli_salvati: 0, saltati: 0, errore: (e && e.message) || String(e) };
    }
}

/**
 * Identita' del fascicolo ricavata dal suo indirizzo sul Portale.
 *
 * Ripiego per quando chi chiama non la passa (pagina del pannello vecchia,
 * rimasta nella cache del browser). Il link ha due forme, con e senza il
 * codice di ruolo fra ufficio e anno:
 *   /dettaglio-fascicolo/SIGP/GLGE/0450100151/2026/650/0/<CF>/AVV
 *   /dettaglio-fascicolo/SICID/GLGE/0450100093/CC/2022/343/0/<CF>/AVV
 */
function identitaDaLink(link) {
    const vuoto = { registro: '', ufficio: '', anno: '', numero: '', sub: '' };
    try {
        const m = /\/dettaglio-fascicolo\/([A-Za-z]+)\/([A-Za-z]+)\/(\d+)\/(?:[A-Za-z][A-Za-z0-9]*\/)?(\d{4})\/(\d+)\/(\d+)/.exec(String(link || ''));
        if (!m) return vuoto;
        return {
            registro: m[1].toUpperCase(), ufficio: m[3],
            anno: m[4], numero: m[5], sub: m[6],
        };
    } catch (e) {
        return vuoto;
    }
}

/**
 * Un solo fascicolo, senza finestra del PdA: stesso motore offscreen del
 * ripasso veloce, con una lista di un elemento. Serve al pulsante "Sync
 * fascicolo" del dettaglio, che prima apriva una scheda del portale (lenta e
 * throttlata da Chrome) oppure passava dal server (e in produzione gli atti
 * finivano su Aruba, invece che nella cartella dell'avvocato).
 */
async function scaricoUnFascicoloSenzaFinestra(cf, base, apiToken, f, log) {
    if (!f || !f.link || f.link.indexOf('/dettaglio-fascicolo/') === -1) {
        return { ok: false, motivo: 'link del fascicolo non valido' };
    }
    const uffici = {};
    const cod = String(f.ufficio || '');
    if (cod) uffici[cod] = String(f.nome_ufficio || cod);
    if (log) log('SYNC SINGOLA senza finestra: ' + (f.etichetta || f.numero || f.link));
    const tScarico0 = Date.now();
    const esito = await scaricaSenzaFinestra(cf, base, apiToken, {
        lista: [f],
        uffici,
        ordine: String(f.nome_ufficio || ''),
        provincia: '',
        // Firma la corsa: il record di progresso e' condiviso con la sync per
        // ufficio e la pagina del fascicolo deve riconoscere il proprio.
        ambito: 'fascicolo',
    }, log);
    if (log) log('TEMPI SYNC SINGOLA: documenti=' + Math.round((Date.now() - tScarico0) / 100) / 10 + 's');
    // Le schede del Portale si aggiornano sempre, anche quando non c'erano
    // documenti nuovi: incarichi, udienze e libretti cambiano da soli. Restano
    // DOPO lo scarico, non in parallelo: userebbero la stessa sessione del
    // Portale e il motore dei documenti, trovando buste vuote, ripiegherebbe su
    // seriale peggiorando i tempi invece di migliorarli.
    const tSchede0 = Date.now();
    const schede = await aggiornaSchedePortale(base, apiToken, f.link, log);
    if (log) log('TEMPI SYNC SINGOLA: schede=' + Math.round((Date.now() - tSchede0) / 100) / 10 + 's');
    if (schede && schede.success) {
        const daDom = schede.da_leggere_dal_dom || [];
        const lenti = Object.keys(schede.dettagli_dal_dom || {}).length;
        const tDom0 = Date.now();
        if (log && (daDom.length || lenti)) {
            log('LENTI DOM: ' + daDom.length + ' sezioni da leggere in pagina, ' + lenti + ' gruppi di lenti');
        }
        await raccogliDettagliSezioniPaginaEsistente(
            f.link,
            schede.dettagli_dal_dom || {},
            daDom,
            log
        );
        if (log && (daDom.length || lenti)) {
            log('TEMPI SYNC SINGOLA: lenti_dom=' + Math.round((Date.now() - tDom0) / 100) / 10 + 's');
        }
    }
    return esito;
}

/**
 * Esegue la ricerca in API diretta e, a seguire, avvia la fase documenti
 * consegnando l'elenco trovato allo scraper (che non deve piu' cercare nulla).
 * Se la ricerca diretta non e' utilizzabile si ripiega sul percorso classico
 * col form, esattamente come prima.
 */
// Una ricerca per volta: il service worker non ha finestre da chiudere per
// fermare quella precedente, quindi due click ravvicinati raddoppierebbero le
// chiamate al portale e le scritture sul backend.
let ricercaApiInCorso = false;

/**
 * Apre la finestra di sync dopo la ricerca. openOrderSyncTab ignora gli avvii
 * entro 8 secondi dal precedente: siccome la ricerca ha appena marcato
 * pctOrderSyncStartedAt, quel timbro va azzerato o una ricerca lampo (es. zero
 * uffici) finirebbe per non aprire nulla, lasciando la dashboard in attesa.
 */
async function apriFinestraSync(cf, codici, full, fast) {
    try { await chrome.storage.local.set({ pctOrderSyncStartedAt: 0 }); } catch (e) { /* noop */ }
    openOrderSyncTab(cf, codici, full, fast);
}

async function ricercaDirettaEDocumenti(cf, base, apiToken, codici, full) {
    if (ricercaApiInCorso) {
        logSync(base, cf, 'RICERCA API: ne e\' gia\' in corso una, ignoro la richiesta doppia');
        return;
    }
    ricercaApiInCorso = true;
    tieniSveglio(true);
    const log = (riga) => logSync(base, cf, riga);
    try {
        await chrome.storage.local.set({ pctOrderSyncStartedAt: Date.now() });
        logSync(base, cf, '===== AVVIO RICERCA IN API DIRETTA ===== CF=' + cf
            + ' uffici selezionati=' + (codici.length || 'tutto l\'Ordine'), true);
        setOrderProgress(cf, {
            stato: 'avvio',
            messaggio: 'Ricerca diretta sul portale PdA Toscana...',
            uffici_totali: 0, uffici_fatti: 0,
            fascicoli_trovati: 0, fascicoli_salvati: 0, errori: 0,
        });

        // 1) La ricerca la fa il SERVER (Aruba), che parla col portale in curl:
        //    e' la via piu' veloce perche' il browser non tocca il PdA.
        log('RICERCA: provo la via server (Aruba) su ' + base + '/api_sync_ordine_diretto.php');
        let esito = await ricercaServerAruba(cf, base, apiToken, codici, log);

        // 2) Se il server non ce la fa (endpoint non pubblicato, token rifiutato,
        //    rete), la stessa ricerca la rifa' il service worker in API diretta.
        if (!esito.ok) {
            log('RICERCA via server non utilizzabile (' + esito.motivo
                + '): la rifaccio in API diretta dal service worker');
            esito = await ricercaDirettaOrdine({
                cf,
                codici,
                postBackend: (payload) => postOrdine(base, apiToken, cf, payload),
                log,
            });
        }

        // Ricerca fallita del tutto: si torna al percorso classico (finestra +
        // form), che copre anche i casi di sessione scaduta.
        if (!esito.ok) {
            log('RICERCA API: ripiego sul percorso classico col form ('
                + (esito.motivo || 'motivo non noto') + ')');
            await apriFinestraSync(cf, codici, full, false);
            return;
        }

        // Uffici che la ricerca diretta non ha potuto coprire: NON si rifa' tutto
        // col form (sarebbe il giro lento di prima), si tiene da parte l'elenco e
        // si passano al form solo quelli, dopo la fase documenti.
        const scoperti = esito.scoperti.filter((c) => !!c);
        if (scoperti.length) {
            log('RICERCA API: ' + scoperti.length + ' uffici non coperti ('
                + scoperti.join(', ') + '): li passo al form dopo i documenti');
        }

        if (!esito.lista.length) {
            if (scoperti.length) {
                log('RICERCA API: nessun fascicolo trovato, vado col form sui soli uffici scoperti');
                await apriFinestraSync(cf, scoperti, full, false);
                return;
            }
            log('RICERCA API: nessun fascicolo trovato, niente da scaricare');
            await postOrdine(base, apiToken, cf, {
                azione: 'progresso_set',
                stato: esito.errori ? 'completato_con_errori' : 'completato',
                ordine: esito.ordine,
                provincia: esito.provincia,
                uffici_totali: esito.uffici,
                uffici_fatti: esito.uffici,
                fascicoli_trovati: 0,
                fascicoli_salvati: 0,
                errori: esito.errori,
                messaggio: 'Ricerca completata: nessun fascicolo trovato per gli uffici richiesti',
            });
            return;
        }

        // Fase documenti SENZA finestra: il motore di scarico gira in un
        // documento offscreen (invisibile e non throttlato da Chrome) e i file
        // continuano a finire sul PC via AstarFirmaServer.
        log('RICERCA API: ' + esito.trovati + ' fascicoli trovati, ' + esito.salvati
            + ' salvati → scarico documenti su ' + esito.lista.length + ' fascicoli (senza finestra)');
        const doc = await scaricaSenzaFinestra(cf, base, apiToken, {
            lista: esito.lista,
            uffici: esito.nomiUffici,
            ordine: esito.ordine,
            provincia: esito.provincia,
        }, log);

        // Schede dal Portale lette dal server: completano l'archivio con
        // profilo, cronologia, comunicazioni, scadenze e le sette schede. Solo
        // se lo scarico e' andato: se l'offscreen ha fallito si ripiega sulla
        // finestra, che fa il suo giro e le legge per conto proprio.
        if (doc.ok) await aggiornaSchedePerElenco(base, apiToken, esito.lista, log);
        if (!doc.ok) {
            // L'offscreen non e' utilizzabile: come ultima risorsa si usa la
            // vecchia finestra, consegnandole l'elenco gia' trovato.
            log('SCARICO senza finestra non riuscito (' + doc.motivo + '): ripiego sulla finestra');
            await chrome.storage.local.set({
                pctOrderSyncListaDoc: {
                    lista: esito.lista,
                    uffici: esito.nomiUffici,
                    ordine: esito.ordine,
                    provincia: esito.provincia,
                    cf,
                    ts: Date.now(),
                },
                pctOrderSyncScoperti: scoperti.length
                    ? { cf, codici: scoperti, full: !!full, ts: Date.now() }
                    : null,
            });
            await apriFinestraSync(cf, esito.codiciFatti, false, true);
            return;
        }

        // Uffici scoperti: ora che i documenti sono finiti si recuperano col
        // form, e solo quelli.
        if (scoperti.length) {
            log('RICERCA API: recupero col form i ' + scoperti.length + ' uffici scoperti');
            await apriFinestraSync(cf, scoperti, full, false);
        }
    } catch (e) {
        const msg = (e && e.message) || String(e);
        log('RICERCA API: eccezione → ' + msg + ' (ripiego sul form)');
        diagnostica('ricerca_api_fallita: ' + msg);
        await apriFinestraSync(cf, codici, full, false);
    } finally {
        tieniSveglio(false);
        ricercaApiInCorso = false;
    }
}

// ─── Listener messaggi ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // Fine dello scarico nel documento offscreen: sblocca chi lo stava aspettando.
    if (message && message.action === 'offscreenFinito') {
        const r = attesaOffscreen;
        attesaOffscreen = null;
        if (r) {
            r(message.esito || {});
        } else {
            // Nessuno in attesa (il service worker era stato spento nel mentre):
            // almeno si chiude il documento, per non lasciarlo aperto a vuoto.
            chiudiOffscreen();
        }
        sendResponse({ received: true });
        return true;
    }

    // Access token del PdA garantito valido: se sta per scadere lo si rinnova
    // col refresh token. Lo usa il motore di scarico nel documento offscreen.
    if (message && message.action === 'pdaTokenFresh') {
        assicuraToken(120, (m) => console.log('[PCT Monitor] token:', m))
            .then((access) => sendResponse({ access: access || '' }))
            .catch((e) => sendResponse({ access: '', error: (e && e.message) || String(e) }));
        return true;
    }

    // Servizio locale AstarFirmaServer: stato, elenco (delta), salvataggio busta.
    if (message && message.action === 'astarStatus') {
        serverLocaleCapacita().then((c) => sendResponse(c));
        return true;
    }
    if (message && message.action === 'astarElenco') {
        astarElencoFascicolo(message.cartella).then((r) => sendResponse(r));
        return true;
    }
    if (message && message.action === 'astarElimina') {
        astarEliminaFascicolo(message.cartella).then((r) => sendResponse(r));
        return true;
    }
    if (message && message.action === 'astarSalva') {
        astarSalvaDocumento(message).then((r) => sendResponse(r));
        return true;
    }
    if (message && message.action === 'astarApriDocumento') {
        astarApriDocumento(message).then((r) => sendResponse(r));
        return true;
    }
    if (message && message.action === 'astarFirma') {
        astarFirmaChiamata(message).then((r) => sendResponse(r));
        return true;
    }

    // Salvataggio delle parti lette dal dettaglio PdA aperto nel browser.
    // Il content script non puo' chiamare direttamente il backend (token API),
    // quindi inoltra qui e il service worker fa la POST autenticata.
    if (message && message.action === 'salva_parti_pda') {
        chrome.storage.local.get(['backendUrl', 'apiToken'], (st) => {
            const base = (st.backendUrl || 'http://localhost/pct/api_sync.php').replace(/\/api_sync[^/]*\.php$/, '');
            const apiToken = st.apiToken || '';
            const cf = String(message.cf_avvocato || '').toUpperCase();
            if (!cf || cf.length !== 16) {
                sendResponse({ ok: false, error: 'CF avvocato non valido' });
                return;
            }
            postOrdine(base, apiToken, cf, {
                azione: 'salva_parti',
                cf_avvocato: cf,
                fascicolo: message.fascicolo,
                parti: message.parti,
            })
                .then((r) => sendResponse({ ok: !!(r && r.success), ...r }))
                .catch((e) => sendResponse({ ok: false, error: String(e) }));
        });
        return true;
    }

    // Risoluzione nome parte dai datiAtto.xml (flusso di scarico sul PC): il motore
    // pda_download invia il testo XML estratto dalle buste e riceve, per ogni atto,
    // l'etichetta "RUOLO - NOME (CF)" con cui nominare cartelle e record atti.
    if (message && message.action === 'risolviParti') {
        chrome.storage.local.get(['backendUrl', 'apiToken', 'lastCfAvvocato'], (st) => {
            const base = (st.backendUrl || 'http://localhost/pct/api_sync.php').replace(/\/api_sync[^/]*\.php$/, '');
            const url = base + '/api_sync_ordine.php';
            const apiToken = st.apiToken || '';
            const cf = String(message.cf || st.lastCfAvvocato || '').toUpperCase();
            fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Api-Token': apiToken, 'X-Cf-Avvocato': cf },
                body: JSON.stringify({ azione: 'risolvi_parti', cf_avvocato: cf, fascicolo: message.fascicolo || '', atti: message.atti || [] }),
            })
                .then((r) => r.json())
                .then((j) => sendResponse({ ok: !!(j && j.success), mappa: (j && j.mappa) || {} }))
                .catch((e) => sendResponse({ ok: false, error: String(e), mappa: {} }));
        });
        return true;
    }

    // Consente allo scraper Ministero di capire se sta girando nella scheda/finestra
    // aperta dalla sync: solo quella deve pilotare la macchina a stati (evita che
    // altre schede del Portale gia' aperte eseguano in parallelo sullo stesso stato).
    if (message.action === 'isOrderSyncTab') {
        const tid = sender && sender.tab ? sender.tab.id : null;
        chrome.storage.local.get(['pctOrderSyncTabId'], (s) => {
            sendResponse({ ok: !!(tid && s.pctOrderSyncTabId && tid === s.pctOrderSyncTabId) });
        });
        return true;
    }

    // Log diagnostico dello scraper: lo scraper gira su giustizia.toscana.it e
    // non puo' fare fetch diretto a localhost (mixed-content/CORS). Inoltra qui
    // le righe e le scrive in logs/sync_ordine.log via api_sync_log.php.
    if (message.action === 'logLine') {
        const base = String(message.base || 'http://localhost/pct').replace(/\/+$/, '');
        const righe = message.lines || [String(message.msg || '')];
        // Copia sul PC dell'avvocato, oltre a quella sul server.
        try {
            if (message.reset) logLocaleNuovaCorsa(message.cf || '');
            for (const r of righe) logLocaleAggiungi(message.cf || '', r);
        } catch (e) { /* il registro non e' critico */ }
        const body = JSON.stringify({ cf: message.cf || '', lines: righe, reset: !!message.reset });
        fetch(base + '/api_sync_log.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
        }).catch(() => {});
        sendResponse({ success: true });
        return true;
    }

    // [SERVER-SIDE] Arricchimento dettaglio dei fascicoli gia' in DB: cattura i
    // cookie e avvia il job in modalita' enrich_only (riempie data iscrizione,
    // ultima udienza, sezione, materia, oggetto senza rieseguire le ricerche).
    if (message.action === 'enrichExisting') {
        const cfAvvocato = String(message.cfAvvocato || '').toUpperCase();
        if (!/^[A-Z0-9]{16}$/.test(cfAvvocato)) { sendResponse({ success: false, error: 'CF non valido' }); return true; }
        chrome.storage.local.get(['backendUrl', 'apiToken'], (st) => {
            const base = (st.backendUrl || 'http://localhost/pct/api_sync.php').replace(/\/api_sync[^/]*\.php$/, '');
            const apiToken = st.apiToken || 'pct_aruba_2026_adb200f9';
            chrome.cookies.getAll({ domain: 'servizipst.giustizia.it' }, (cookies) => {
                const cookieHeader = (cookies || []).map((c) => c.name + '=' + c.value).join('; ');
                if (!cookieHeader) {
                    chrome.tabs.create({ url: 'https://servizipst.giustizia.it/PST/it/pst_2_1.wp', active: true });
                    sendResponse({ success: false, needLogin: true, error: 'Accedi al Portale del Ministero (CNS), poi riavvia.' });
                    return;
                }
                fetch(base + '/api_pst_scrape.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-API-TOKEN': apiToken },
                    body: JSON.stringify({ action: 'start', token: apiToken, cf: cfAvvocato, codici: [], cookie: cookieHeader, enrich_only: true }),
                })
                    .then((r) => r.json())
                    .then((j) => { try { sendResponse({ success: !!(j && j.ok), background: true, jobId: j && j.job_id, error: j && j.error }); } catch (e) { /* noop */ } })
                    .catch((e) => { try { sendResponse({ success: false, error: String(e) }); } catch (_e) { /* noop */ } });
            });
        });
        return true;
    }

    // [SERVER-SIDE PoC] Legge i cookie di sessione di servizipst.giustizia.it
    // (inclusi HttpOnly, via chrome.cookies) e li inoltra all'endpoint PHP che
    // esegue la ricerca via cURL. Serve a verificare se la sessione CNS e'
    // replicabile server-to-server (niente navigazione del browser).
    if (message.action === 'pstProbe') {
        const base = String(message.base || 'http://localhost/pct').replace(/\/+$/, '');
        chrome.cookies.getAll({ domain: 'servizipst.giustizia.it' }, (cookies) => {
            const arr = (cookies || []).map((c) => c.name + '=' + c.value);
            const cookieHeader = arr.join('; ');
            fetch(base + '/api_pst_scrape.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'probe',
                    cookie: cookieHeader,
                    cf: String(message.cf || '').toUpperCase(),
                    ufficio: message.ufficio || '0450100093',
                    registro: message.registro || 'LAV',
                    ruolo: message.ruolo || 'AVV@AVV',
                    anno: message.anno || String(new Date().getFullYear() - 2),
                    sistema: message.sistema || 'sicid',
                }),
            })
                .then((r) => r.json())
                .then((j) => { try { sendResponse({ success: true, cookieCount: arr.length, result: j }); } catch (e) { /* noop */ } })
                .catch((e) => { try { sendResponse({ success: false, error: String(e), cookieCount: arr.length }); } catch (_e) { /* noop */ } });
        });
        return true;
    }

    // [PdA DOCS] Avvia il download server-side dei documenti di tutti i
    // fascicoli in DB dal PdA Toscana: usa i token Keycloak catturati
    // dall'interceptor (pdaToken) e li passa a api_pst_scrape.php (pda_start).
    // Il worker scarica in curl_multi con delta-sync (solo i file mancanti).
    if (message.action === 'pdaDocsStart') {
        const cfAvvocato = String(message.cfAvvocato || '').toUpperCase();
        if (!/^[A-Z0-9]{16}$/.test(cfAvvocato)) { sendResponse({ success: false, error: 'CF non valido' }); return true; }
        chrome.storage.local.get(['backendUrl', 'apiToken', 'pdaAccessToken', 'pdaRefreshToken', 'pdaTokenAt'], (st) => {
            const base = (message.base || st.backendUrl || 'http://localhost/pct/api_sync.php').replace(/\/api_sync[^/]*\.php$/, '');
            const apiToken = st.apiToken || 'pct_aruba_2026_adb200f9';
            const access = st.pdaAccessToken || '';
            const refresh = st.pdaRefreshToken || '';
            const tokenAge = st.pdaTokenAt ? (Date.now() - st.pdaTokenAt) / 1000 : Infinity;
            if (!access || tokenAge > 25 * 60) {
                // Token assente o refresh scaduto (>25 min): apri il PdA cosi'
                // l'utente fa login/CNS e l'interceptor cattura token freschi.
                chrome.tabs.create({ url: 'https://www.giustizia.toscana.it/pda-rt/cancelleriatelematica/dashboard', active: true });
                try { sendResponse({ success: false, needLogin: true, error: 'Apri il PdA Toscana (login CNS), attendi il caricamento, poi ripremi Scarica documenti.' }); } catch (e) { /* noop */ }
                return;
            }
            fetch(base + '/api_pst_scrape.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-API-TOKEN': apiToken },
                body: JSON.stringify({ action: 'pda_start', token: apiToken, cf: cfAvvocato, access, refresh }),
            })
                .then((r) => r.json())
                .then((j) => { try { sendResponse({ success: !!(j && j.ok), jobId: j && j.job_id, error: j && j.error }); } catch (e) { /* noop */ } })
                .catch((e) => { try { sendResponse({ success: false, error: String(e) }); } catch (_e) { /* noop */ } });
        });
        return true;
    }

    // [PdA DIRETTO] Inoltra al backend locale lo scarico diretto dei documenti
    // di un fascicolo. Passa da qui, e non dal content script, per due motivi:
    // la pagina e' in https e non deve occuparsi di CORS, e la richiesta puo'
    // restare in volo mezzo minuto senza che il service worker venga spento,
    // perche' una fetch in corso e' attivita' di rete che lo tiene sveglio.
    if (message.action === 'scaricaDiretto') {
        const url = String(message.url || 'http://localhost/pct/api_scarica_diretto.php');
        chrome.storage.local.get(['apiToken'], (st) => {
            const apiToken = st.apiToken || 'pct_aruba_2026_adb200f9';
            fetchConRipiego(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Api-Token': apiToken },
                body: JSON.stringify(message.payload || {}),
            })
                .then(async ({ resp }) => {
                    const testo = await resp.text();
                    let j = null;
                    try { j = JSON.parse(testo); } catch (e) { /* risposta non JSON */ }
                    if (!j) {
                        throw new Error('Risposta non in JSON (HTTP ' + resp.status + '): ' + testo.slice(0, 200));
                    }
                    return j;
                })
                .then((result) => { try { sendResponse({ success: true, result }); } catch (e) { /* noop */ } })
                .catch((err) => {
                    diagnostica('scarico_diretto_fallito: ' + err.message);
                    try { sendResponse({ error: err.message }); } catch (e) { /* noop */ }
                });
        });
        return true;
    }

    // Il token Keycloak catturato dall'interceptor, per quando il content script
    // non riesce a leggerlo da localStorage. Oltre i quattro minuti si considera
    // vecchio: meglio dire che non c'e' che far rifiutare la richiesta dal
    // portale a metà scarico.
    if (message.action === 'pdaTokenGet') {
        chrome.storage.local.get(['pdaAccessToken', 'pdaTokenAt'], (st) => {
            const eta = st.pdaTokenAt ? (Date.now() - st.pdaTokenAt) / 1000 : Infinity;
            try {
                sendResponse({ access: eta < 4 * 60 ? (st.pdaAccessToken || '') : '' });
            } catch (e) { /* noop */ }
        });
        return true;
    }

    // [PdA TOKEN] L'interceptor ha catturato una risposta del token endpoint
    // Keycloak del PdA: conserva access (5 min) e refresh (30 min) token in
    // storage, cosi' l'avvio di un job documenti ha credenziali fresche.
    if (message.action === 'pdaToken' && message.access) {
        chrome.storage.local.set({
            pdaAccessToken: message.access,
            pdaRefreshToken: message.refresh || '',
            pdaTokenAt: Date.now(),
        });
        sendResponse({ success: true });
        return true;
    }

    // Schede del fascicolo chieste dalla pagina del Portale a fine scarico.
    if (message.action === 'aggiornaSchede' && message.link) {
        chrome.storage.local.get(['backendUrl', 'apiToken'], async (st) => {
            const base = (st.backendUrl || 'http://localhost/pct/api_sync.php').replace(/\/api_sync[^/]*\.php$/, '');
            // Se il content script ci gira il token vivo della pagina, aggiorniamo
            // subito lo storage: quello salvato prima poteva essere scaduto e far
            // rifiutare le schede con HTTP 401.
            if (message.token_pda) {
                try { await chrome.storage.local.set({ pdaAccessToken: message.token_pda, pdaTokenAt: Date.now() }); } catch (e) { /* noop */ }
            }
            const j = await aggiornaSchedePortale(base, st.apiToken || 'pct_aruba_2026_adb200f9',
                                                 String(message.link), null, message.token_pda || '');
            sendResponse({ success: !!(j && j.success), result: j });
        });
        return true;
    }

    // Schede del fascicolo (Incarichi, Beni, Lotti, Libretti, Spese, Pendenze,
    // Istanze): il content script gira al monitor la risposta che il Portale ha
    // appena dato alla sua stessa pagina, senza chiedere niente due volte.
    if (message.action === 'salvaSezioni' && message.payload) {
        chrome.storage.local.get(['backendUrl', 'apiToken'], (st) => {
            const base = (st.backendUrl || 'http://localhost/pct/api_sync.php').replace(/\/api_sync[^/]*\.php$/, '');
            fetch(base + '/api_sync_sezioni.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-API-TOKEN': st.apiToken || 'pct_aruba_2026_adb200f9' },
                body: JSON.stringify(message.payload),
            })
                .then((r) => r.json())
                .then((j) => sendResponse({ success: true, result: j }))
                .catch((e) => sendResponse({ success: false, error: String(e) }));
        });
        return true;
    }

    if (message.action === 'salvaDettagliSezioni' && message.payload) {
        chrome.storage.local.get(['backendUrl', 'apiToken'], (st) => {
            const base = (st.backendUrl || 'http://localhost/pct/api_sync.php').replace(/\/api_sync[^/]*\.php$/, '');
            const payload = Object.assign({}, message.payload, { azione: 'salva_dettagli' });
            fetch(base + '/api_sync_sezioni.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-API-TOKEN': st.apiToken || 'pct_aruba_2026_adb200f9' },
                body: JSON.stringify(payload),
            })
                .then(async (r) => ({ ok: r.ok, json: await r.json() }))
                .then(({ ok, json }) => sendResponse({ success: ok && !!json.success, result: json }))
                .catch((e) => sendResponse({ success: false, error: String(e) }));
        });
        return true;
    }

    // [TRACING PdA] Riceve dall'interceptor (via content.js) le chiamate API
    // XHR/fetch intercettate sulle pagine del PdA e le registra sul backend
    // (api_pda_trace.php → logs/pda_trace.log). Serve a mappare le API REST
    // (elenco atti, downloadDocumento) per il motore di download server-side.
    if (message.action === 'pdaTrace' && message.entry) {
        // Il codice fiscale va mandato: il server ci separa il file di traccia
        // per avvocato, perche' qui dentro finiscono le risposte del Portale e
        // la rotazione a 5 MB, su un file condiviso, tagliava le righe altrui.
        chrome.storage.local.get(['backendUrl', 'apiToken', 'lastCfAvvocato'], (st) => {
            const base = (st.backendUrl || 'http://localhost/pct/api_sync.php').replace(/\/api_sync[^/]*\.php$/, '');
            const cf = String(message.cf || st.lastCfAvvocato || '').toUpperCase();
            fetch(base + '/api_pda_trace.php', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-TOKEN': st.apiToken || 'pct_aruba_2026_adb200f9',
                    'X-Cf-Avvocato': cf,
                },
                body: JSON.stringify({ action: 'trace', cf: cf, entry: message.entry }),
            }).catch(() => {});
        });
        sendResponse({ success: true });
        return true;
    }

    // La dashboard registra il CF dell'avvocato loggato: cosi' il ping di
    // content.js sulla scheda PdA (dove il CF non e' nel DOM) puo' usarlo come
    // fallback e mantenere fresco pda_ultimo_accesso.
    if (message.action === 'registerCf') {
        const cf = String(message.cfAvvocato || '').toUpperCase();
        if (/^[A-Z0-9]{16}$/.test(cf)) {
            chrome.storage.local.set({ lastCfAvvocato: cf });
        }
        sendResponse({ success: true });
        return true;
    }

    // Risveglio anti-throttling: porta la finestra di sync a fuoco per pochi
    // istanti e la re-minimizza. Lo scraper lo invoca quando l'autocomplete
    // resta bloccato (spinner che non si spegne) perche' la finestra e' nascosta.
    if (message.action === 'orderSyncWake') {
        wakeOrderSyncWindow(message.ms).then((ok) => {
            try { sendResponse({ success: true, woke: ok }); } catch (e) { /* noop */ }
        });
        return true;
    }

    // Porta a fuoco la finestra di sync (senza re-minimizzare) e la tiene sveglia.
    if (message.action === 'orderSyncFocus') {
        focusOrderSyncWindow().then((ok) => {
            try { sendResponse({ success: true, focused: ok }); } catch (e) { /* noop */ }
        });
        return true;
    }

    // Re-minimizza (nasconde) la finestra di sync.
    if (message.action === 'orderSyncMinimize') {
        minimizeOrderSyncWindow().then((ok) => {
            try { sendResponse({ success: true, minimized: ok }); } catch (e) { /* noop */ }
        });
        return true;
    }

    // Consegna alla dashboard i token del PdA catturati dall'interceptor.
    // Serve al pulsante "Cerca fascicoli": la ricerca la fa il backend (che e'
    // same-origin con la pagina), quindi il pannello chiama l'endpoint da solo
    // e qui serve soltanto la coppia access/refresh, rinnovata se scaduta.
    // Nessuna finestra del portale, nessun lavoro nel service worker.
    if (message.action === 'pdaTokens') {
        (async () => {
            try {
                const access = await assicuraToken(120);
                const st = await chrome.storage.local.get(['pdaRefreshToken']);
                const refresh = String(st.pdaRefreshToken || '');
                sendResponse({
                    success: !!(access || refresh),
                    access: String(access || ''),
                    refresh: refresh,
                    error: (access || refresh) ? '' : 'Sessione PdA assente: apri il portale e accedi con la CNS',
                });
            } catch (e) {
                sendResponse({ success: false, access: '', refresh: '', error: (e && e.message) || String(e) });
            }
        })();
        return true;
    }

    // Sync di UN SOLO fascicolo senza aprire nessuna scheda del portale:
    // chiesta dal pulsante "Sync fascicolo" del dettaglio. Risposta immediata
    // ({avviato:true}) e lavoro in background: il pannello segue l'avanzamento
    // con progresso_get, come fa il modale degli uffici.
    if (message.action === 'startFascicoloSyncDiretto') {
        const cfAvvocato = String(message.cfAvvocato || '').toUpperCase();
        const link = String(message.link || '');
        if (!/^[A-Z0-9]{16}$/.test(cfAvvocato)) {
            sendResponse({ error: 'Codice fiscale dell\'avvocato non valido' });
            return true;
        }
        if (link.indexOf('/dettaglio-fascicolo/') === -1) {
            sendResponse({ error: 'Link del fascicolo non valido' });
            return true;
        }
        (async () => {
            const base = String(message.base || '').replace(/\/+$/, '');
            const baseBuono = base && (await baseRaggiungibile(base)) ? base : '';
            const st = await chrome.storage.local.get(['backendUrl', 'apiToken', 'pdaAccessToken', 'pdaTokenAt']);
            const radice = baseBuono || radiceBackend(st.backendUrl);
            const apiToken = st.apiToken || 'pct_aruba_2026_adb200f9';
            const etaToken = st.pdaTokenAt ? (Date.now() - st.pdaTokenAt) / 1000 : Infinity;
            if (!st.pdaAccessToken || etaToken >= 25 * 60) {
                try {
                    sendResponse({ error: 'Sessione del Portale assente o scaduta: apri il PdA Toscana, accedi con la CNS e riprova.' });
                } catch (e) { /* noop */ }
                return;
            }
            try { sendResponse({ success: true, avviato: true, background: true }); } catch (e) { /* noop */ }

            const log = (m) => logSync(radice, cfAvvocato, m);
            logSync(radice, cfAvvocato, '===== SYNC SINGOLO FASCICOLO SENZA FINESTRA ===== CF=' + cfAvvocato, true);
            tieniSveglio(true);
            corseSyncAttive++;
            // Identita' del fascicolo nelle chiavi che il server pretende
            // (id_ufficio, registro, anno_ruolo, numero_ruolo): senza queste,
            // salva_batch_fascicoli() scartava tutto il pacco con "campo
            // obbligatorio mancante", quindi i documenti finivano sul PC e la
            // cronologia nel pannello restava quella vecchia. Lo stesso guasto
            // era gia' stato corretto per il ripasso veloce; il pulsante
            // "Sync fascicolo" del dettaglio era rimasto indietro.
            //
            // 'registro' serve anche al motore: e' il segnale che sul SIGP la
            // cronologia la deve leggere l'estensione, perche' il passo di
            // lettura schede lato server copre solo SICID e SIECIC.
            const idl = identitaDaLink(link);
            const fasc = {
                link,
                ufficio: String(message.ufficio || idl.ufficio),
                nome_ufficio: String(message.nomeUfficio || ''),
                numero: String(message.numero || ''),
                etichetta: String(message.etichetta || message.numero || ''),
                registro: String(message.registro || idl.registro),
                id_ufficio: String(message.ufficio || idl.ufficio),
                anno_ruolo: String(message.annoRuolo || idl.anno),
                numero_ruolo: String(message.numeroRuolo || idl.numero),
                sub_procedimento: String(message.subProcedimento || idl.sub || '0'),
                n_atti: Number(message.nAtti || 0),
            };
            if (!fasc.id_ufficio || !fasc.registro || !fasc.anno_ruolo || !fasc.numero_ruolo) {
                // Meglio dirlo che lasciare l'avvocato a chiedersi perche' il
                // pannello non cambia: senza identita' il server scarta il pacco.
                log('ATTENZIONE: identita del fascicolo incompleta (ufficio="' + fasc.id_ufficio
                    + '" registro="' + fasc.registro + '" ruolo="' + fasc.anno_ruolo + '/'
                    + fasc.numero_ruolo + '"): il pannello potrebbe non aggiornarsi.');
            }
            try {
                const r = await scaricoUnFascicoloSenzaFinestra(cfAvvocato, radice, apiToken, fasc, log);
                if (!r.ok) log('SYNC SINGOLA non riuscita: ' + (r.motivo || 'motivo non noto'));
            } catch (e) {
                log('SYNC SINGOLA: eccezione → ' + ((e && e.message) || e));
            } finally {
                corseSyncAttive = Math.max(0, corseSyncAttive - 1);
                tieniSveglio(false);
            }
        })();
        return true;
    }

    // "C'e' davvero una sincronizzazione in corso?" La pagina lo chiede prima di
    // fermarsi davanti al record di progresso sul server, che puo' essere rimasto
    // "in_corso" per una corsa morta (browser chiuso, estensione aggiornata).
    if (message.action === 'syncAttiva') {
        (async () => {
            let offs = false;
            try { offs = await offscreenAperto(); } catch (e) { offs = false; }
            const attiva = corseSyncAttive > 0 || orderSyncWindowId !== null || offs;
            try { sendResponse({ success: true, attiva: attiva }); } catch (e) { /* noop */ }
        })();
        return true;
    }

    // Avvia la sincronizzazione per Ordine da http://localhost/pct senza attivare la tab PdA
    if (message.action === 'startOrderSync') {
        const cfAvvocato = String(message.cfAvvocato || '').toUpperCase();
        if (!/^[A-Z0-9]{16}$/.test(cfAvvocato)) {
            sendResponse({ error: 'Codice fiscale non valido' });
            return true;
        }
        // Codici ufficio selezionati nella griglia: se presenti, la sync scarica
        // SOLO quegli uffici; se vuoto, si torna a tutta la provincia dell'Ordine.
        const codici = Array.isArray(message.codiciUffici)
            ? message.codiciUffici.map((c) => String(c || '').trim()).filter(Boolean)
            : [];
        // [PdA TOSCANA] Nessuna finestra del portale: la RICERCA la fa il server
        // (api_sync_ordine_diretto.php) o, in ripiego, il service worker
        // (pda_ricerca.js); lo SCARICO dei documenti gira in un documento
        // offscreen invisibile, coi file che restano sul PC via AstarFirmaServer.
        // La finestra si riapre solo se questi percorsi non sono utilizzabili
        // (token assente, portale che rifiuta, login CNS da rifare).
        // Il progresso viene scritto in DB (progresso_set) e mostrato dal modale.
        (async () => {
            // message.base arriva dalla pagina che ha richiesto la sync (derivata
            // dalla sua URL, es. https://desktop-peoancq/pct): lo salviamo come
            // backendUrl cosi' lo scraper usa il backend giusto.
            const base = String(message.base || '').replace(/\/+$/, '');
            // Il base veniva salvato al buio: se la dashboard era aperta con un
            // altro nome host o in https, da quel momento ogni sincronizzazione
            // moriva con "Failed to fetch" perche' il service worker parlava a
            // un indirizzo che non risponde. Ora si salva solo se risponde.
            const baseBuono = base && (await baseRaggiungibile(base)) ? base : '';
            if (baseBuono) {
                await chrome.storage.local.set({
                    lastCfAvvocato: cfAvvocato,
                    backendUrl: baseBuono + '/api_sync.php',
                });
            } else {
                if (base) {
                    diagnostica('base_scartato (non risponde): ' + base);
                }
                await chrome.storage.local.set({ lastCfAvvocato: cfAvvocato });
            }

            const st = await chrome.storage.local.get(['backendUrl', 'apiToken', 'pdaAccessToken', 'pdaTokenAt']);
            const radice = baseBuono || radiceBackend(st.backendUrl);
            const apiToken = st.apiToken || 'pct_aruba_2026_adb200f9';
            // Token del portale catturato dall'interceptor: oltre i 25 minuti
            // anche il refresh e' scaduto e serve un nuovo accesso al PdA.
            const etaToken = st.pdaTokenAt ? (Date.now() - st.pdaTokenAt) / 1000 : Infinity;
            const tokenUsabile = !!st.pdaAccessToken && etaToken < 25 * 60;
            // La modalita' veloce (ripasso dai link salvati) non cerca nulla:
            // resta sul suo percorso. 'api: false' forza il vecchio flusso.
            const usaApi = message.api !== false && !message.fast && tokenUsabile;

            if (usaApi) {
                // Risposta subito: la ricerca dura minuti e la dashboard segue
                // l'avanzamento con progresso_get.
                try { sendResponse({ success: true, background: true, flow: 'api' }); } catch (e) { /* noop */ }
                ricercaDirettaEDocumenti(cfAvvocato, radice, apiToken, codici, !!message.full);
                return;
            }

            // Ripasso veloce (bottone "Aggiorna"): anche questo senza finestra.
            // L'elenco dei link arriva dal backend e lo scarico gira in offscreen;
            // solo se l'offscreen non e' utilizzabile si riapre la finestra.
            if (message.fast && tokenUsabile) {
                try { sendResponse({ success: true, background: true, flow: 'offscreen' }); } catch (e) { /* noop */ }
                tieniSveglio(true);
                const log = (m) => logSync(radice, cfAvvocato, m);
                logSync(radice, cfAvvocato, '===== AGGIORNAMENTO VELOCE SENZA FINESTRA ===== CF=' + cfAvvocato, true);
                scaricoVeloceSenzaFinestra(cfAvvocato, radice, apiToken, codici, log)
                    .then((r) => {
                        if (!r.ok) {
                            log('AGGIORNAMENTO VELOCE senza finestra non riuscito (' + r.motivo + '): apro la finestra');
                            openOrderSyncTab(cfAvvocato, codici, !!message.full, true);
                        }
                    })
                    .catch((e) => {
                        log('AGGIORNAMENTO VELOCE: eccezione → ' + ((e && e.message) || e) + ': apro la finestra');
                        openOrderSyncTab(cfAvvocato, codici, !!message.full, true);
                    })
                    .finally(() => tieniSveglio(false));
                return;
            }

            if (!message.fast && !tokenUsabile) {
                logSync(radice, cfAvvocato,
                    'RICERCA API non disponibile (token del PdA assente o scaduto): uso il percorso classico col form');
            }
            openOrderSyncTab(cfAvvocato, codici, !!message.full, !!message.fast);
            try { sendResponse({ success: true, background: true, flow: 'pda' }); } catch (e) { /* noop */ }
        })();
        return true; // risposta asincrona
    }

    // Sync remota di un singolo fascicolo: chiesta dal dettaglio del pannello
    // ("Sync fascicolo"), apre la pagina del fascicolo sul PdA e avvia la
    // raccolta come se l'utente avesse premuto il pulsante del banner.
    if (message.action === 'startFascicoloSync') {
        (async () => {
            const link = String(message.link || '');
            if (link.indexOf('https://www.giustizia.toscana.it/pda-rt/cancelleriatelematica/dettaglio-fascicolo/') !== 0) {
                sendResponse({ success: false, error: 'Link del fascicolo non valido' });
                return;
            }
            try {
                const tab = await chrome.tabs.create({ url: link, active: true });
                // Attende il caricamento completo, senza restare appeso per sempre
                // se il portale non risponde.
                await new Promise((resolve) => {
                    const limite = setTimeout(resolve, 45000);
                    chrome.tabs.onUpdated.addListener(function ascolto(idTab, info) {
                        if (idTab === tab.id && info.status === 'complete') {
                            chrome.tabs.onUpdated.removeListener(ascolto);
                            clearTimeout(limite);
                            resolve();
                        }
                    });
                });
                // Angular completa il rendering dopo il load: senza questa pausa
                // il banner parte ma la raccolta dell'header esce vuota.
                await new Promise((r) => setTimeout(r, 2500));
                let resp = null;
                try {
                    resp = await chrome.tabs.sendMessage(tab.id, { action: 'autoSyncFascicolo' });
                } catch (e) {
                    // Content script non ancora presente: si inietta e si riprova.
                    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
                    await new Promise((r) => setTimeout(r, 1200));
                    resp = await chrome.tabs.sendMessage(tab.id, { action: 'autoSyncFascicolo' });
                }
                sendResponse({ success: !!(resp && resp.ok), error: (resp && resp.error) || '' });
            } catch (err) {
                sendResponse({ success: false, error: (err && err.message) || String(err) });
            }
        })();
        return true; // risposta asincrona
    }

    // Verifica in diretta se esiste una scheda PdA autenticata (indipendente dal
    // timestamp lato server). Se la trova, rinfresca pda_ultimo_accesso e risponde
    // loggedIn:true. Usato da ricerca_fascicoli.php per nascondere l'alert login.
    if (message.action === 'checkPdaLogin') {
        (async () => {
            let loggedIn = false;
            let foundCf = '';
            try {
                const tabs = await chrome.tabs.query({ url: 'https://www.giustizia.toscana.it/pda-rt/*' });
                let tabEsiste = false;   // esiste almeno una scheda PdA aperta
                let ispezionato = false; // siamo riusciti a leggere il contenuto di almeno una
                for (const t of tabs) {
                    if (!t.id) continue;
                    tabEsiste = true;
                    try {
                        const res = await chrome.scripting.executeScript({
                            target: { tabId: t.id },
                            func: () => {
                                const txt = document.body ? document.body.innerText : '';
                                const m = txt.match(/\b([A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z])\b/i);
                                const authText = /Uscita|Benvenut/i.test(txt);
                                // Token Keycloak salvati dal PdA: se presenti in local/session
                                // storage la sessione e' attiva anche se il testo non combacia.
                                let hasToken = false;
                                try {
                                    const stores = [window.localStorage, window.sessionStorage];
                                    for (const st of stores) {
                                        if (!st) continue;
                                        for (let i = 0; i < st.length; i++) {
                                            const k = st.key(i) || '';
                                            if (/token|kc-|keycloak|oidc/i.test(k)) {
                                                const v = st.getItem(k) || '';
                                                if (v.length > 40) { hasToken = true; break; }
                                            }
                                        }
                                        if (hasToken) break;
                                    }
                                } catch (e) { /* storage non accessibile */ }
                                const letto = (!!txt && txt.length > 0) || hasToken;
                                return { cf: m ? m[1].toUpperCase() : '', auth: authText || hasToken, letto: letto };
                            },
                        });
                        const r = res && res[0] && res[0].result;
                        if (r && r.letto) {
                            ispezionato = true;
                            if (r.auth) {
                                loggedIn = true;
                                if (r.cf) foundCf = r.cf;
                                break;
                            }
                        }
                    } catch (e) { /* scheda congelata/non accessibile (login page cross-origin, ecc.) */ }
                }
                // Se una scheda PdA e' aperta ma Chrome l'ha "congelata"/scaricata per
                // risparmio memoria, executeScript non legge nulla: non e' un logout.
                // In quel caso NON blocchiamo l'utente con un falso "sessione assente":
                // assumiamo la sessione attiva, tanto la sync rileva da sola un eventuale
                // login realmente scaduto e lo segnala.
                if (!loggedIn && tabEsiste && !ispezionato) {
                    loggedIn = true;
                }
                if (loggedIn) {
                    const stored = await chrome.storage.local.get(['backendUrl', 'apiToken', 'lastCfAvvocato']);
                    const cf = (foundCf || message.cfAvvocato || stored.lastCfAvvocato || '').toUpperCase();
                    if (/^[A-Z0-9]{16}$/.test(cf)) {
                        const base = (stored.backendUrl || 'http://localhost/pct/api_sync.php')
                            .replace(/\/api_sync[^/]*\.php$/, '');
                        const apiToken = stored.apiToken || 'pct_aruba_2026_adb200f9';
                        try {
                            await fetch(base + '/api_pda_ping.php', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'X-Api-Token': apiToken },
                                body: JSON.stringify({ codice_fiscale: cf }),
                            });
                        } catch (e) { /* ping best-effort */ }
                    }
                }
            } catch (e) { /* nessuna scheda PdA */ }
            sendResponse({ loggedIn: loggedIn });
        })();
        return true; // risposta asincrona
    }

    // Apre una tab di background per scraping profilo/token calendario
    if (message.action === 'openBackgroundScraper') {
        openBackgroundScraper(message.url);
        sendResponse({ received: true });
        return true;
    }

    // Chiude la tab di background che ha inviato il messaggio
    if (message.action === 'closeBackgroundTab') {
        if (sender.tab && sender.tab.id) {
            closeBackgroundTab(sender.tab.id);
        }
        sendResponse({ received: true });
        return true;
    }

    // Il popup chiede di avviare lo scraping su un tab specifico
    if (message.action === 'startScrape') {
        const tabId = message.tabId;
        if (!tabId) {
            sendResponse({ error: 'tabId mancante' });
            return true;
        }

        // Inietta il content script se non già presente (fallback)
        chrome.scripting.executeScript({
            target: { tabId },
            files:  ['content.js'],
        }).then(() => {
            // Invia il comando di scraping al content script
            return chrome.tabs.sendMessage(tabId, { action: 'scrape' });
        }).then(data => {
            sendResponse({ success: true, data });
        }).catch(err => {
            sendResponse({ error: err.message });
        });

        return true; // risposta asincrona
    }

    // Download di un file dal PdA tramite fetch con credenziali (cookie sessione CNS)
    if (message.action === 'downloadFile') {
        const url = message.url;
        if (!url) {
            sendResponse({ error: 'url mancante' });
            return true;
        }

        fetch(url, { credentials: 'include' })
            .then(resp => {
                if (!resp.ok) {
                    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
                }
                return resp.arrayBuffer();
            })
            .then(buffer => {
                sendResponse({ success: true, buffer });
            })
            .catch(err => {
                sendResponse({ error: err.message });
            });

        return true; // risposta asincrona
    }

    // Sincronizza dati fascicolo verso il backend (evita CORS dal content script)
    if (message.action === 'syncToBackend') {
        const { backendUrl, apiToken, cfAvvocato, data } = message;
        if (!backendUrl) {
            sendResponse({ error: 'backendUrl mancante' });
            return true;
        }

        const headers = {
            'Content-Type': 'application/json',
            'X-Api-Token': apiToken || '',
        };
        if (cfAvvocato) {
            headers['X-Cf-Avvocato'] = cfAvvocato;
        }

        fetchConRipiego(backendUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(data || {}),
        })
            .then(async ({ resp, urlUsata }) => {
                const text = await resp.text();
                let json = null;
                try { json = JSON.parse(text); } catch (e) {}
                if (!resp.ok) {
                    throw new Error(`Backend error ${resp.status}: ${text}`);
                }
                if (urlUsata !== backendUrl) {
                    ricordaBackendFunzionante(urlUsata, backendUrl);
                }
                return json || { success: true, raw: text };
            })
            .then(result => {
                sendResponse({ success: true, result });
            })
            .catch(err => {
                diagnostica('sync_fallita: ' + err.message);
                sendResponse({ error: err.message });
            });

        return true; // risposta asincrona
    }

    // Riferimenti d'archivio (high-water mark) per la lettura INCREMENTALE dei
    // tab paginati: interroga api_hwm.php e torna la data piu' recente gia'
    // salvata per aggiornamenti/scadenze. Se il fascicolo non e' in archivio
    // torna found:false e l'estensione legge tutto.
    if (message.action === 'archivioHwm') {
        const { backendUrl, apiToken, cfAvvocato, data } = message;
        if (!backendUrl) { sendResponse({ error: 'backendUrl mancante' }); return true; }
        const urlHwm = backendUrl.replace(/\/api_sync[^/]*\.php$/, '/api_hwm.php');
        const headers = { 'Content-Type': 'application/json', 'X-Api-Token': apiToken || '' };
        if (cfAvvocato) headers['X-Cf-Avvocato'] = cfAvvocato;
        fetch(urlHwm, { method: 'POST', headers, body: JSON.stringify(data || {}) })
            .then(async (resp) => {
                const text = await resp.text();
                let json = null;
                try { json = JSON.parse(text); } catch (e) {}
                if (!resp.ok) throw new Error('HWM error ' + resp.status);
                return json || { found: false };
            })
            .then(result => sendResponse({ success: true, result }))
            .catch(err => sendResponse({ error: err.message }));
        return true; // risposta asincrona
    }

    // Upload documento verso il backend (evita CORS dal content script)
    if (message.action === 'uploadDoc') {
        const { url, apiToken, cfAvvocato, fields, fileBuffer, fileBase64, fileName, mimeType } = message;
        if (!url) {
            sendResponse({ error: 'url mancante' });
            return true;
        }

        const fd = new FormData();
        if (fields) {
            Object.keys(fields).forEach(key => {
                fd.append(key, fields[key] == null ? '' : String(fields[key]));
            });
        }
        if (fileBase64 && fileName) {
            // Decodifica base64 in binario
            const raw = atob(fileBase64);
            const arr = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
            const blob = new Blob([arr], { type: mimeType || 'application/octet-stream' });
            fd.append('file', blob, fileName);
        } else if (fileBuffer && fileName) {
            const blob = new Blob([fileBuffer], { type: mimeType || 'application/octet-stream' });
            fd.append('file', blob, fileName);
        }

        const headers = { 'X-Api-Token': apiToken || '' };
        if (cfAvvocato) {
            headers['X-Cf-Avvocato'] = cfAvvocato;
        }

        fetch(url, {
            method: 'POST',
            headers,
            body: fd,
        })
            .then(async resp => {
                const text = await resp.text();
                let json = null;
                try { json = JSON.parse(text); } catch (e) {}
                if (!resp.ok) {
                    throw new Error(`Backend error ${resp.status}: ${text}`);
                }
                return json || { success: true, raw: text };
            })
            .then(result => {
                sendResponse({ success: true, result });
            })
            .catch(err => {
                sendResponse({ error: err.message });
            });

        return true; // risposta asincrona
    }

    if (message.action === 'orderSyncFinished') {
        if (sender.tab && sender.tab.id) {
            updateBadge(sender.tab.id, 'ok');
            setTimeout(() => closeBackgroundTab(sender.tab.id), 1500);
        }
        // Se la ricerca diretta aveva lasciato fuori qualche ufficio, adesso che
        // i documenti sono finiti si recuperano col form: solo quelli, non tutto.
        chrome.storage.local.get(['pctOrderSyncScoperti'], (st) => {
            const coda = st.pctOrderSyncScoperti;
            if (!coda || !coda.cf || !(coda.codici || []).length) return;
            chrome.storage.local.remove('pctOrderSyncScoperti');
            if (Date.now() - (coda.ts || 0) > 45 * 60 * 1000) return; // troppo vecchia
            setTimeout(() => {
                console.log('[PCT Monitor] Recupero col form degli uffici scoperti:', coda.codici);
                apriFinestraSync(coda.cf, coda.codici, !!coda.full, false);
            }, 4000); // il tempo che la finestra dei documenti si chiuda
        });
        sendResponse({ received: true });
        return true;
    }

    // Notifica di sync completata dal content script
    if (message.action === 'syncComplete') {
        updateBadge(sender.tab?.id, 'ok');
        sendResponse({ received: true });
        return true;
    }

    // Notifica di errore sync
    if (message.action === 'syncError') {
        updateBadge(sender.tab?.id, 'err');
        sendResponse({ received: true });
        return true;
    }
});

// ─── Badge sull'icona ─────────────────────────────────────────────────────────
/**
 * Aggiorna il badge sull'icona dell'estensione per il tab specificato.
 * @param {number|undefined} tabId
 * @param {'ok'|'err'|'sync'|''} state
 */
function updateBadge(tabId, state) {
    const config = {
        ok:   { text: '',    color: '#28a745' },
        err:  { text: '!',   color: '#dc3545' },
        sync: { text: '...',  color: '#ffc107' },
        '':   { text: '',    color: '#6c757d' },
    };
    const { text, color } = config[state] || config[''];

    const opts = tabId ? { tabId } : {};
    chrome.action.setBadgeText({ text, ...opts });
    chrome.action.setBadgeBackgroundColor({ color, ...opts });
}

// ─── Monitoraggio navigazione ─────────────────────────────────────────────────
/**
 * Quando l'utente naviga su una pagina del PdA, aggiorna il badge.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    const url = tab.url || '';
    if (url.includes('giustizia.toscana.it') && url.includes('dettaglio-fascicolo')) {
        // Pagina fascicolo rilevata: badge verde vuoto (pronto)
        updateBadge(tabId, 'ok');
    } else if (url.includes('giustizia.toscana.it')) {
        // Portale PdA ma non fascicolo
        updateBadge(tabId, '');
    }
});

// ─── SPA Navigation (Angular pushState) ──────────────────────────────────────
/**
 * Il portale PdA è un'app Angular SPA: le navigazioni interne non ricaricano la pagina
 * e quindi non ri-iniettano automaticamente content.js.
 * Quando l'URL cambia per navigazione SPA verso /dashboard, forziamo la re-iniezione.
 */
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    const url = details.url || '';
    if (!url.includes('giustizia.toscana.it')) return;
    if (!url.includes('/dashboard') && !url.includes('/profile')) return;

    console.log('[PCT Monitor] SPA navigation rilevata verso', url.includes('/dashboard') ? 'dashboard' : 'profile', ', re-iniezione content.js su tabId', details.tabId);

    chrome.scripting.executeScript({
        target: { tabId: details.tabId },
        files:  ['content.js'],
    }).catch(err => {
        console.warn('[PCT Monitor] Errore re-iniezione content.js (SPA nav):', err.message);
    });

    updateBadge(details.tabId, '');
}, {
    url: [{ hostContains: 'giustizia.toscana.it' }],
});

// ─── Context menu (opzionale, per uso futuro) ─────────────────────────────────
// chrome.contextMenus.create({
//     id:       'pct-sync',
//     title:    'Sincronizza fascicolo PCT',
//     contexts: ['page'],
//     documentUrlPatterns: ['https://www.giustizia.toscana.it/*'],
// });
