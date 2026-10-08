/**
 * PCT Monitor - Popup script
 * Gestisce l'interfaccia del popup e la comunicazione con content.js via background.js
 */

'use strict';

// ─── Costanti default ─────────────────────────────────────────────────────────
const DEFAULT_BACKEND_URL = 'https://www.sincpdatoscana.it/wp-content/monitor/api_sync.php';
const DEFAULT_API_TOKEN   = 'pct_aruba_2026_adb200f9';

// ─── Elementi DOM ─────────────────────────────────────────────────────────────
const elPageStatus    = document.getElementById('page-status');
const elPageStatusTxt = document.getElementById('page-status-text');
const elFascicoloInfo = document.getElementById('fascicolo-info');
const elInfoNumero    = document.getElementById('info-numero');
const elInfoOggetto   = document.getElementById('info-oggetto');
const elBtnSync       = document.getElementById('btn-sync');
const elProgressArea  = document.getElementById('progress-area');
const elProgressFill  = document.getElementById('progress-fill');
const elProgressLabel = document.getElementById('progress-label');
const elSyncResult    = document.getElementById('sync-result');
const elLastSyncInfo  = document.getElementById('last-sync-info');
const elLastSyncText  = document.getElementById('last-sync-text');
const elSettingsPanel = document.getElementById('settings-panel');
const elSettingUrl    = document.getElementById('setting-backend-url');
const elSettingToken  = document.getElementById('setting-api-token');
const elBtnClose      = document.getElementById('btn-close-settings');
const elBtnSaveSet    = document.getElementById('btn-save-settings');
const elBtnOpenSet    = document.getElementById('btn-open-settings');

// ─── Stato ────────────────────────────────────────────────────────────────────
let currentTabId  = null;
let currentTabUrl = '';
let settings      = { backendUrl: DEFAULT_BACKEND_URL, apiToken: DEFAULT_API_TOKEN };

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
    // Carica impostazioni salvate
    const stored = await chrome.storage.local.get(['backendUrl', 'apiToken', 'lastSync']);
    if (stored.backendUrl) settings.backendUrl = stored.backendUrl;
    if (stored.apiToken)   settings.apiToken   = stored.apiToken;

    elSettingUrl.value   = settings.backendUrl;
    elSettingToken.value = settings.apiToken;

    // Ultima sync
    if (stored.lastSync) {
        showLastSync(stored.lastSync);
    }

    // Tab corrente
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    currentTabId  = tab.id;
    currentTabUrl = tab.url || '';

    if (isPdaFascicoloUrl(currentTabUrl)) {
        setStatus('detected', 'Fascicolo PdA rilevato');
        elBtnSync.disabled = false;

        // Chiedi al content script le info di anteprima
        try {
            const resp = await chrome.tabs.sendMessage(tab.id, { action: 'getPreview' });
            if (resp && resp.numero) {
                elFascicoloInfo.classList.remove('hidden');
                elInfoNumero.textContent  = resp.numero  || '—';
                elInfoOggetto.textContent = resp.oggetto || '—';
            }
        } catch (e) {
            // Content script non ancora pronto (pagina in caricamento)
        }
    } else {
        setStatus('idle', 'Apri un fascicolo sul PdA Toscana');
        elBtnSync.disabled = true;
    }
}

// ─── Sincronizzazione ─────────────────────────────────────────────────────────
elBtnSync.addEventListener('click', async () => {
    elBtnSync.disabled = true;
    elSyncResult.classList.add('hidden');
    showProgress(0, 'Avvio raccolta dati...');

    try {
        // 1. Chiedi al content script di raccogliere i dati
        showProgress(10, 'Raccolta dati dal DOM...');
        let data;
        try {
            data = await chrome.tabs.sendMessage(currentTabId, { action: 'scrape' });
        } catch (e) {
            throw new Error('Content script non risponde. Ricarica la pagina del fascicolo.');
        }

        if (!data || data.error) {
            throw new Error(data?.error || 'Errore durante lo scraping');
        }

        showProgress(50, 'Invio dati al backend...');

        // 2. Invia i dati al backend
        const response = await fetch(settings.backendUrl, {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'X-Api-Token':   settings.apiToken,
            },
            body: JSON.stringify(data),
        });

        showProgress(90, 'Elaborazione risposta...');

        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`Backend error ${response.status}: ${errBody}`);
        }

        const result = await response.json();
        if (!result.success) {
            throw new Error(result.error || 'Risposta backend non valida');
        }

        const fascicoloId = result.fascicolo_id;

        // 3. Upload documenti:
        //    - Se l'atto ha blob_b64 (intercettato da Angular): riconverti in Blob e carica
        //    - Se l'atto ha url_download (link diretto): chiedi al background di scaricarlo
        const attiConDoc = (data.atti || []).filter(a =>
            (a.blob_b64 && a.blob_b64.trim() !== '') ||
            (a.url_download && a.url_download.trim() !== '')
        );
        if (attiConDoc.length > 0) {
            const uploadUrl = 'http://localhost/pct/api_upload_doc.php';
            let scaricati = 0;

            for (let i = 0; i < attiConDoc.length; i++) {
                const atto = attiConDoc[i];
                showProgress(
                    Math.round(90 + (i / attiConDoc.length) * 9),
                    `Upload documenti... ${i + 1}/${attiConDoc.length}`
                );

                try {
                    let blob = null;

                    if (atto.blob_b64 && atto.blob_b64.trim() !== '') {
                        // Caso Angular: blob già intercettato, riconverti da base64
                        const mime = atto.mime_type || 'application/octet-stream';
                        const byteChars = atob(atto.blob_b64);
                        const byteArr = new Uint8Array(byteChars.length);
                        for (let j = 0; j < byteChars.length; j++) {
                            byteArr[j] = byteChars.charCodeAt(j);
                        }
                        blob = new Blob([byteArr], { type: mime });
                    } else {
                        // Caso link diretto: chiedi al background di scaricare il file
                        const dlResp = await chrome.runtime.sendMessage({
                            action: 'downloadFile',
                            url:    atto.url_download,
                        });

                        if (!dlResp || dlResp.error) {
                            console.warn('[PCT] Download fallito per', atto.nome_file, dlResp?.error);
                            continue;
                        }

                        blob = new Blob([dlResp.buffer]);
                    }

                    if (!blob) continue;

                    // Costruisci il FormData per l'upload al backend
                    const fd = new FormData();
                    fd.append('fascicolo_id', String(fascicoloId));
                    fd.append('nome_file',    atto.nome_file    || '');
                    fd.append('parte',        atto.parte        || '');
                    fd.append('tipo_atto',    atto.tipo_atto    || '');
                    fd.append('data_atto',    atto.data_atto    || '');
                    fd.append('url_download', atto.url_download || '');
                    fd.append('file',         blob, atto.nome_file || 'documento');

                    const upResp = await fetch(uploadUrl, {
                        method:  'POST',
                        headers: { 'X-Api-Token': settings.apiToken },
                        body:    fd,
                    });

                    if (upResp.ok) {
                        const upResult = await upResp.json();
                        if (upResult.success) scaricati++;
                    } else {
                        console.warn('[PCT] Upload fallito per', atto.nome_file, upResp.status);
                    }
                } catch (dlErr) {
                    console.warn('[PCT] Errore download/upload', atto.nome_file, dlErr.message);
                }
            }

            showProgress(100, `Sync completa, ${scaricati} document${scaricati === 1 ? 'o' : 'i'} scaricati`);
            showResult('success', `Fascicolo sincronizzato (ID: ${fascicoloId}) — ${scaricati}/${attiConDoc.length} documenti scaricati`);
        } else {
            showProgress(100, 'Completato!');
            showResult('success', `Fascicolo sincronizzato (ID: ${fascicoloId})`);
        }

        // Salva timestamp ultima sync
        const now = new Date().toISOString();
        await chrome.storage.local.set({ lastSync: now });
        showLastSync(now);

    } catch (err) {
        showProgress(0, '');
        elProgressArea.classList.add('hidden');
        showResult('error', err.message);
    } finally {
        elBtnSync.disabled = false;
    }
});

// ─── Impostazioni ─────────────────────────────────────────────────────────────
if (elBtnOpenSet) {
    elBtnOpenSet.addEventListener('click', () => {
        elSettingUrl.value   = settings.backendUrl;
        elSettingToken.value = settings.apiToken;
        elSettingsPanel.classList.toggle('hidden');
    });
}

elBtnClose.addEventListener('click', () => {
    elSettingsPanel.classList.add('hidden');
});

if (elBtnSaveSet) {
    elBtnSaveSet.addEventListener('click', async () => {
        const url = String(elSettingUrl.value || '').trim();
        const token = String(elSettingToken.value || '').trim();
        if (url) settings.backendUrl = url;
        if (token) settings.apiToken = token;
        await chrome.storage.local.set({ backendUrl: settings.backendUrl, apiToken: settings.apiToken });
        const testoOrig = elBtnSaveSet.textContent;
        elBtnSaveSet.textContent = 'Salvato';
        setTimeout(() => { elBtnSaveSet.textContent = testoOrig; }, 1200);
    });
}

// ─── Utility UI ──────────────────────────────────────────────────────────────

function isPdaFascicoloUrl(url) {
    return url && url.includes('giustizia.toscana.it') && url.includes('dettaglio-fascicolo');
}

function setStatus(type, text) {
    elPageStatus.className = 'status-box status-' + type;
    elPageStatusTxt.textContent = text;
}

function showProgress(pct, label) {
    elProgressArea.classList.remove('hidden');
    elProgressFill.style.width = pct + '%';
    elProgressLabel.textContent = label;
    if (pct >= 100) {
        setTimeout(() => elProgressArea.classList.add('hidden'), 1500);
    }
}

function showResult(type, msg) {
    elSyncResult.className = 'sync-result sync-result-' + type;
    elSyncResult.textContent = msg;
    elSyncResult.classList.remove('hidden');
}

function showLastSync(isoDate) {
    const d = new Date(isoDate);
    const fmt = d.toLocaleDateString('it-IT') + ' ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    elLastSyncText.textContent = 'Ultima sync: ' + fmt;
    elLastSyncInfo.classList.remove('hidden');
}

// ─── Avvio ────────────────────────────────────────────────────────────────────

// ─── Ascolto progresso da content script ──────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'syncProgress') {
        elProgressArea.classList.remove('hidden');
        if (message.pct !== undefined) {
            elProgressFill.style.width = message.pct + '%';
        }
        if (message.label !== undefined) {
            elProgressLabel.textContent = message.label;
        }
        if (message.pct >= 100) {
            setTimeout(() => elProgressArea.classList.add('hidden'), 1500);
        }
    }
});

init().catch(console.error);
