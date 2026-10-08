// SIGIT Cookie Catcher v2.2.0
// Background: proxy API Chrome-only + cookie capture + declarativeNetRequest per P7M
// Architettura v2.2: logica batch spostata in content_aruba_tutti.js.
// Background = solo proxy (open_tab, close_tab, read_cookies_sigit, save_cookie_sigit,
//              set_sync_mode) + relay messaggi SIGIT→tutti.js + cookie capture.

const SAVE_URL = 'https://www.sincronizzafascicolo.it/wp-content/monitor/save_cookie.php';

// === DECLARATIVE NET REQUEST: Forza Sec-Fetch-Mode: navigate per scaricaDocumento ===
const SEC_FETCH_RULE_ID = 1;

async function enableP7MHeaders() {
    try {
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [SEC_FETCH_RULE_ID],
            addRules: [{
                id: SEC_FETCH_RULE_ID,
                priority: 1,
                action: {
                    type: 'modifyHeaders',
                    requestHeaders: [
                        { header: 'Sec-Fetch-Mode', operation: 'set', value: 'navigate' },
                        { header: 'Sec-Fetch-Dest', operation: 'set', value: 'document' },
                        { header: 'Sec-Fetch-User', operation: 'set', value: '?1' }
                    ]
                },
                condition: {
                    urlFilter: 'sigit.finanze.it/NIRWeb/Fascicolo.do?pagina=scaricaDocumento',
                    resourceTypes: ['xmlhttprequest']
                }
            }]
        });
        console.log('[BG] P7M headers rule ENABLED');
    } catch(e) { console.error('[BG] Failed to enable P7M rule:', e); }
}

async function disableP7MHeaders() {
    try {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [SEC_FETCH_RULE_ID], addRules: [] });
        console.log('[BG] P7M headers rule DISABLED');
    } catch(e) { console.error('[BG] Failed to disable P7M rule:', e); }
}

// === COOKIE CAPTURE ===
chrome.cookies.onChanged.addListener(function(changeInfo) {
    if (changeInfo.removed) return;
    var cookie = changeInfo.cookie;
    if (cookie.name === 'JSESSIONID' && cookie.domain.includes('finanze.it')) {
        salvaCookie('sigit', 'JSESSIONID', cookie.value);
    }
    if (cookie.name === 'LtpaToken2' && cookie.domain.includes('finanze.it')) {
        salvaCookie('sigit', 'LtpaToken2', cookie.value);
    }
});

chrome.webNavigation.onCompleted.addListener(function(details) {
    if (!details.url.includes('sigit.finanze.it')) return;

    // Cattura cookie (invariato)
    leggiCookieSigit();

    // Injection routing — solo main frame (frameId=0)
    // Tab aperto dal batch (presente in tabInfoMap) → inietta tutti.js (SIGIT Batch Context)
    // Tab aperto dall'utente (non in tabInfoMap)   → inietta singolo.js
    if (details.frameId !== 0) return;
    var scriptFile = tabInfoMap[details.tabId] ? 'content_aruba_tutti.js' : 'content_aruba_singolo.js';
    chrome.scripting.executeScript({
        target: { tabId: details.tabId },
        files: [scriptFile]
    }).catch(function(e) {
        console.warn('[BG] inject', scriptFile, 'tab', details.tabId, '\u2192', e && e.message);
    });
}, { url: [{ hostContains: 'finanze.it' }] });

function leggiCookieSigit() {
    chrome.cookies.getAll({ url: 'https://sigit.finanze.it/' }, function(cookies) {
        var jsid = null, ltpa = null;
        cookies.forEach(function(c) {
            if (c.name === 'JSESSIONID') jsid = c.value;
            if (c.name === 'LtpaToken2') ltpa = c.value;
        });
        if (jsid) salvaCookie('sigit', 'JSESSIONID', jsid);
        if (ltpa) salvaCookie('sigit', 'LtpaToken2', ltpa);
    });
}

function salvaCookie(tipo, name, value) {
    var url = SAVE_URL + '?tipo=' + tipo + '&name=' + encodeURIComponent(name) + '&value=' + encodeURIComponent(value);
    fetch(url).then(r => r.text()).then(t => console.log('[BG] Cookie saved:', tipo, name));
}

// === STATO PROXY ===
// tabInfoMap: tabId → { ...fascicolo info, originTabId }
// Usato da: get_sync_info (singolo.js) e relay messaggi sync_* verso tutti.js
let tabInfoMap = {};
// syncMode: null | 'single' | 'all'  — mutex per sync_single check
// Gestito da tutti.js via set_sync_mode; aggiornato qui per sync_single standalone.
let syncMode = null;

// === MESSAGE HANDLER ===
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {

    // --- INVARIATI: dbg_log, cookie capture, p7m headers, get_sync_info, sync_single mutex ---

    if (msg.action === 'dbg_log') {
        console.log('[CT-FWD]', msg.msg);
        return;
    }

    if (msg.action === 'readAndSaveCookies') {
        leggiCookieSigit();
        sendResponse({ok: true});
        return;
    }

    if (msg.action === 'enable_p7m_headers') {
        enableP7MHeaders().then(() => sendResponse({ok: true}));
        return true;
    }

    if (msg.action === 'disable_p7m_headers') {
        disableP7MHeaders().then(() => sendResponse({ok: true}));
        return true;
    }

    if (msg.action === 'get_sync_info') {
        // Content singolo.js chiede i dati fascicolo per il suo tab
        var tabId = sender.tab ? sender.tab.id : 0;
        sendResponse(tabInfoMap[tabId] || null);
        return;
    }

    if (msg.action === 'sync_single') {
        // [MUTEX-2.3.7] Richiesta Sync Singolo — blocca se sync già in corso
        if (syncMode !== null) {
            sendResponse({ok: false, error: 'sync_in_progress', mode: syncMode});
        } else {
            syncMode = 'single';
            sendResponse({ok: true});
        }
        return true;
    }

    // --- NUOVI: proxy API Chrome-only (chiamati da content_aruba_tutti.js) ---

    if (msg.action === 'open_tab') {
        // Crea tab SIGIT per sync. originTabId = sender.tab.id (tutti.js), ricavato automaticamente.
        // msg: { url: string, info: { commissione, rgr, anno, nome, user_id, ... } }
        var originTabId = sender.tab ? sender.tab.id : null;
        chrome.tabs.create({ url: msg.url, active: false }, function(tab) {
            tabInfoMap[tab.id] = Object.assign({}, msg.info, { originTabId: originTabId });
            sendResponse({ tabId: tab.id });
        });
        return true;
    }

    if (msg.action === 'close_tab') {
        // Chiude tab SIGIT a fine sync e pulisce tabInfoMap
        // msg: { tabId: number }
        try { chrome.tabs.remove(msg.tabId); } catch(e) {}
        delete tabInfoMap[msg.tabId];
        sendResponse({ ok: true });
        return;
    }

    if (msg.action === 'read_cookies_sigit') {
        // Legge cookie SIGIT via chrome.cookies API (include HttpOnly)
        chrome.cookies.getAll({ url: 'https://sigit.finanze.it/' }, function(cookies) {
            sendResponse({ cookies: cookies || [] });
        });
        return true;
    }

    if (msg.action === 'save_cookie_sigit') {
        // Salva singolo cookie SIGIT su server
        // msg: { name: string, value: string }
        fetch(SAVE_URL + '?tipo=sigit&name=' + encodeURIComponent(msg.name) + '&value=' + encodeURIComponent(msg.value))
            .then(r => r.text())
            .then(function() { sendResponse({ ok: true }); })
            .catch(function(e) { sendResponse({ ok: false, error: e.message }); });
        return true;
    }

    if (msg.action === 'set_sync_mode') {
        // Aggiorna syncMode (gestito da tutti.js, sincronizzato qui per mutex sync_single)
        // msg: { mode: null | 'all' }
        syncMode = msg.mode;
        sendResponse({ ok: true });
        return;
    }

    // --- RELAY: messaggi da tab SIGIT (singolo.js) al tab origine (tutti.js) ---
    // Messaggi: sync_done, sync_failed, sync_started, sync_alive, file_progress

    if (msg.action === 'sync_done' || msg.action === 'sync_failed' ||
        msg.action === 'sync_started' || msg.action === 'sync_alive' ||
        msg.action === 'file_progress') {

        var senderTabId = sender.tab ? sender.tab.id : null;

        // Reset mutex solo per Sync Singolo (tab non in tabInfoMap → no relay)
        if (syncMode === 'single' && (msg.action === 'sync_done' || msg.action === 'sync_failed')) {
            syncMode = null;
        }

        // Relay al tab tutti.js (originTabId ricavato da tabInfoMap)
        if (senderTabId && tabInfoMap[senderTabId] && tabInfoMap[senderTabId].originTabId) {
            chrome.tabs.sendMessage(
                tabInfoMap[senderTabId].originTabId,
                Object.assign({}, msg, { _senderTabId: senderTabId })
            );
        }

        sendResponse({ ok: true });
        return;
    }

    return true;
});

console.log('[SIGIT Cookie Catcher v2.2.0] Background attivo');
