/**
 * PCT Monitor - Scraper sincronizzazione fascicoli per Ordine (Portale Ministero)
 *
 * Iniettato su https://servizipst.giustizia.it/PST/* (all_frames): opera nel
 * frame che contiene il form "Uffici e registri" (Consultazione registri).
 *
 * A differenza del PdA Toscana (Angular SPA, un solo loop), il portale del
 * Ministero e' una web-app Struts: OGNI "Consulta" / cambio scheda / cambio
 * pagina e' una NAVIGAZIONE completa del frame, che distrugge il contesto JS.
 * Per questo lo scraper e' una MACCHINA A STATI persistita in
 * chrome.storage.local (chiave 'pctMinState'): ad ogni (re)iniezione riprende
 * da dove era, avanza di un passo (compila+Consulta, oppure legge+salva+pagina
 * successiva, oppure passa alla combinazione ufficio/registro seguente).
 *
 * Flusso per ciascuna combinazione (una riga di tab_uffici_giudiziari):
 *   1. seleziona Uffici giudiziari (match sul nome), Registro (label), Ruolo=Avvocato
 *   2. click "Consulta"  -> navigazione
 *   3. attiva la scheda "Fascicoli personali"  -> navigazione
 *   4. legge la tabella (Fascicolo | Attore/Convenuto | Data udienza | Giudice)
 *   5. salva in batch, segue la paginazione, poi passa alla combinazione dopo.
 */

(() => {
    if (window.__pctScraperMinisteroLoaded) return;
    window.__pctScraperMinisteroLoaded = true;

    'use strict';

    const LOG = '[PCT][SyncMinistero]';
    const STATE_KEY = 'pctMinState';
    const MAX_PAGINE = 40;
    const MAX_BATCH = 100;
    const NUM_ANNI_STORICO = 10; // anni da consultare a ritroso dall'anno corrente
    const PENDING_MAX_MS = 45 * 60 * 1000; // trigger valido entro 45 min dall'avvio

    // Mappa label registro -> sistema (registro tab_fascicoli) + gestore di default.
    const REG_MAP = {
        'contenzioso civile':       { sis: 'SICID',  ges: 'CC'   },
        'lavoro':                   { sis: 'SICID',  ges: 'LAV'  },
        'volontaria giurisdizione': { sis: 'SICID',  ges: 'VG'   },
        'procedure concorsuali':    { sis: 'SIECIC', ges: 'CONC' },
        'esecuzioni mobiliari':     { sis: 'SIECIC', ges: 'ESM'  },
        'esecuzioni immobiliari':   { sis: 'SIECIC', ges: 'ESI'  },
        'giudice di pace':          { sis: 'SIGP',   ges: ''     },
    };

    // ─── Utility ─────────────────────────────────────────────────────────────
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (el) => !!(el && el.offsetParent !== null);

    async function waitFor(fn, { timeout = 25000, interval = 300 } = {}) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try { const v = fn(); if (v) return v; } catch (e) { /* continua */ }
            await sleep(interval);
        }
        return null;
    }

    // Stato per il log diagnostico lato server.
    let SLOG_BASE = 'http://localhost/pct';
    let SLOG_CF = '';
    function slog(...args) {
        const msg = args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (e) { return String(a); } })())).join(' ');
        console.log(LOG, msg);
        try { chrome.runtime.sendMessage({ action: 'logLine', base: SLOG_BASE, cf: SLOG_CF, msg }, () => { void chrome.runtime.lastError; }); } catch (e) { /* noop */ }
    }
    // Come slog, ma azzera il log lato server prima di scrivere: usato alla prima
    // riga di ogni nuova sincronizzazione, cosi' il log riparte pulito ogni volta.
    function slogReset(msg) {
        console.log(LOG, msg);
        try { chrome.runtime.sendMessage({ action: 'logLine', base: SLOG_BASE, cf: SLOG_CF, reset: true, lines: [String(msg)] }, () => { void chrome.runtime.lastError; }); } catch (e) { /* noop */ }
    }

    // ─── Storage / backend ───────────────────────────────────────────────────
    function storageGet(keys) { return new Promise((r) => chrome.storage.local.get(keys, r)); }
    function storageSet(obj)  { return new Promise((r) => chrome.storage.local.set(obj, r)); }
    function storageRemove(keys) { return new Promise((r) => chrome.storage.local.remove(keys, r)); }

    function backendPost(url, apiToken, cf, payload) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage(
                { action: 'syncToBackend', backendUrl: url, apiToken, cfAvvocato: cf, data: payload },
                (resp) => {
                    if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
                    else resolve(resp || { error: 'nessuna risposta dal background' });
                }
            );
        });
    }

    function ordineBackendUrl(backendUrl) {
        if (!backendUrl) return 'http://localhost/pct/api_sync_ordine.php';
        if (backendUrl.includes('api_sync_ordine.php')) return backendUrl;
        if (backendUrl.includes('api_sync.php')) return backendUrl.replace('api_sync.php', 'api_sync_ordine.php');
        return backendUrl.replace(/\/+$/, '') + '/api_sync_ordine.php';
    }

    let CFG = { backendUrl: '', apiToken: '', cf: '' };

    async function progressoSet(extra) {
        const url = ordineBackendUrl(CFG.backendUrl);
        await backendPost(url, CFG.apiToken, CFG.cf, Object.assign({ azione: 'progresso_set', cf_avvocato: CFG.cf }, extra || {}));
    }

    function orderSyncFinished() {
        try { chrome.runtime.sendMessage({ action: 'orderSyncFinished' }, () => { void chrome.runtime.lastError; }); } catch (e) { /* noop */ }
    }

    // ─── Banner di avanzamento sulla pagina ──────────────────────────────────
    const banner = { root: null, testo: null, barra: null, log: null };
    function ensureBanner() {
        if (banner.root) return;
        const root = document.createElement('div');
        root.id = 'pct-sync-min-banner';
        root.style.cssText = ['position:fixed', 'top:12px', 'right:12px', 'z-index:2147483647',
            'width:340px', 'max-width:90vw', 'background:#1a3a5c', 'color:#fff', 'border-radius:8px',
            'padding:12px 14px', 'font-family:Segoe UI,Arial,sans-serif', 'font-size:13px',
            'box-shadow:0 6px 24px rgba(0,0,0,.35)'].join(';');
        root.innerHTML = '<div style="font-weight:700;margin-bottom:6px;">PCT — Sync fascicoli (Ministero)</div>'
            + '<div data-role="testo" style="margin-bottom:8px;line-height:1.4;">Avvio...</div>'
            + '<div style="background:rgba(255,255,255,.2);border-radius:4px;height:8px;overflow:hidden;margin-bottom:8px;"><div data-role="barra" style="background:#4caf50;height:100%;width:0%;transition:width .3s;"></div></div>'
            + '<div data-role="log" style="font-size:11px;opacity:.85;max-height:110px;overflow-y:auto;line-height:1.5;"></div>';
        (document.body || document.documentElement).appendChild(root);
        banner.root = root;
        banner.testo = root.querySelector('[data-role=testo]');
        banner.barra = root.querySelector('[data-role=barra]');
        banner.log = root.querySelector('[data-role=log]');
    }
    function bannerTesto(msg) { ensureBanner(); banner.testo.textContent = msg; }
    function bannerLog(msg) {
        ensureBanner();
        const r = document.createElement('div'); r.textContent = msg; banner.log.appendChild(r);
        while (banner.log.childNodes.length > 30) banner.log.removeChild(banner.log.firstChild);
        banner.log.scrollTop = banner.log.scrollHeight;
    }
    function bannerProgresso(fatti, tot) { ensureBanner(); banner.barra.style.width = (tot > 0 ? Math.min(100, Math.round(fatti / tot * 100)) : 0) + '%'; }

    // ─── Rilevamento form / select ───────────────────────────────────────────
    function selectLabel(sel) {
        // 1) label[for=id]
        if (sel.id) {
            try { const l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(sel.id) : sel.id) + '"]'); if (l) return norm(l.textContent); } catch (e) { /* noop */ }
        }
        // 2) aria-label / name
        const aria = sel.getAttribute('aria-label') || sel.getAttribute('name') || '';
        if (aria) return norm(aria);
        // 3) testo nella stessa cella/riga, prima del select
        let cell = sel.closest('td, th, div, p, label');
        for (let i = 0; i < 3 && cell; i++) {
            const t = norm(cell.textContent);
            if (t && t.length <= 40) return t;
            cell = cell.parentElement;
        }
        return '';
    }

    function trovaSelects() {
        const sels = [...document.querySelectorAll('select')].filter(visible);
        let uff = null, reg = null, ruo = null;
        for (const s of sels) {
            const lab = selectLabel(s);
            if (!uff && /uffic/i.test(lab)) uff = s;
            else if (!reg && /registr/i.test(lab)) reg = s;
            else if (!ruo && /ruolo/i.test(lab)) ruo = s;
        }
        if (!uff && sels[0]) uff = sels[0];
        if (!reg && sels[1]) reg = sels[1];
        if (!ruo && sels[2]) ruo = sels[2];
        return { uff, reg, ruo, all: sels };
    }

    function trovaConsulta() {
        const cand = [...document.querySelectorAll('input[type=submit], input[type=button], button, a')].filter(visible);
        return cand.find((el) => {
            const t = norm(el.value || el.textContent);
            return t === 'consulta' || (t.length <= 20 && /\bconsulta\b/.test(t));
        }) || null;
    }

    function isFormFrame() { const s = trovaSelects(); return !!(s.uff && trovaConsulta()); }

    // ─── Impostazione dei <select> nativi ────────────────────────────────────
    function setSelectValue(sel, opt) {
        if (sel.value === opt.value) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, opt.value);
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /** Sceglie l'opzione migliore: match esatto -> contiene -> overlap token. */
    function scegliOpzione(sel, wantText, hintTerms) {
        const want = norm(wantText);
        const hints = (hintTerms || []).map(norm).filter(Boolean);
        let esatto = null, contiene = null, best = null, bestScore = 0;
        for (const opt of sel.options) {
            const t = norm(opt.textContent);
            if (!t) continue;
            if (t === want) { esatto = opt; break; }
            if (!contiene && want && (t.includes(want) || want.includes(t))) contiene = opt;
            // scoring token (per gli uffici GdP con denominazioni diverse)
            const tokens = want.split(' ').filter((w) => w.length > 2);
            let hit = 0;
            for (const w of tokens) if (t.includes(w)) hit++;
            for (const h of hints) if (h && t.includes(h)) hit += 1.5;
            const score = tokens.length ? hit / tokens.length : 0;
            if (score > bestScore) { bestScore = score; best = opt; }
        }
        const chosen = esatto || contiene || (bestScore >= 0.6 ? best : null);
        if (chosen) setSelectValue(sel, chosen);
        return chosen ? { text: norm(chosen.textContent), score: esatto ? 1 : (contiene ? 0.9 : bestScore) } : null;
    }

    // ─── Parsing della tabella "Fascicoli personali" ─────────────────────────
    function headerMap(table) {
        const rows = [...table.querySelectorAll('tr')];
        for (const r of rows) {
            const cells = [...r.querySelectorAll('th, td')];
            if (!cells.length) continue;
            const map = {};
            cells.forEach((c, i) => {
                const t = norm(c.textContent);
                if (/fascicolo/.test(t) && map.fascicolo == null) map.fascicolo = i;
                else if (/(attore|convenuto|parti)/.test(t) && map.parti == null) map.parti = i;
                else if (/(data.*udienz|udienza)/.test(t) && map.data == null) map.data = i;
                else if (/giudice/.test(t) && map.giud == null) map.giud = i;
            });
            if (map.fascicolo != null) { map.__headerRow = r; return map; }
        }
        return null;
    }

    function parseFascicoloText(txt) {
        // es. "LAV - 2/2024 - 1"  oppure  "LAV - 606/2024"
        const m = norm(txt).match(/([a-z]+)\s*-\s*(\d+)\s*\/\s*(\d+)(?:\s*-\s*(\d+))?/i);
        if (!m) return null;
        return { prefix: m[1].toUpperCase(), numero: parseInt(m[2], 10), anno: parseInt(m[3], 10), sub: m[4] ? String(parseInt(m[4], 10)) : '0' };
    }

    function parseData(txt) {
        const m = norm(txt).match(/(\d{1,2}\/\d{1,2}\/\d{4})(?:\s+(\d{1,2}:\d{2}))?/);
        if (!m) return '';
        return m[2] ? (m[1] + ' ' + m[2]) : m[1];
    }

    function parseRisultati(combo) {
        const tables = [...document.querySelectorAll('table')].filter(visible);
        let table = null, cm = null;
        for (const t of tables) { const m = headerMap(t); if (m) { table = t; cm = m; break; } }
        if (!table) return { rows: [], noTable: true };

        const info = REG_MAP[norm(combo.registro)] || { sis: 'SICID', ges: '' };
        const dataRows = [...table.querySelectorAll('tr')].filter((r) => r !== cm.__headerRow && r.querySelector('td'));
        const out = [];
        for (const r of dataRows) {
            const cells = [...r.querySelectorAll('td')];
            if (!cells.length) continue;
            const fascCell = cells[cm.fascicolo];
            if (!fascCell) continue;
            const fascText = norm(fascCell.textContent);
            const parsed = parseFascicoloText(fascText);
            if (!parsed) continue;
            const link = (() => { const a = fascCell.querySelector('a[href]'); return a ? a.href : ''; })();

            // Parti: "ATTORE / CONVENUTO" (rimuove "Dettaglio Parti")
            const parti = [];
            if (cm.parti != null && cells[cm.parti]) {
                let pt = cells[cm.parti].textContent.replace(/dettaglio\s+parti/ig, ' ').replace(/\s+/g, ' ').trim();
                const seg = pt.split('/');
                const attore = (seg[0] || '').trim();
                const conv = (seg.slice(1).join('/') || '').trim();
                if (attore) parti.push({ tipo: 'AP', cognome: attore });
                if (conv) parti.push({ tipo: 'CP', cognome: conv });
            }
            const giudice = (cm.giud != null && cells[cm.giud]) ? cells[cm.giud].textContent.replace(/\s+/g, ' ').trim() : '';
            const dataUd = (cm.data != null && cells[cm.data]) ? parseData(cells[cm.data].textContent) : '';

            out.push({
                id_ufficio: combo.codice_ufficio,
                registro: info.sis,
                gestore: parsed.prefix || info.ges || '',
                anno_ruolo: parsed.anno,
                numero_ruolo: parsed.numero,
                sub_procedimento: parsed.sub,
                giudice,
                data_prossima_udienza: dataUd,
                link,
                parti,
            });
        }
        return { rows: out, noTable: false };
    }

    // ─── Schede (tab) e paginazione ──────────────────────────────────────────
    function urlFascicoliPersonali() { return /fascicolipersonali/i.test(location.href); }

    function trovaTabFascicoli() {
        // Deve restituire l'ANCORA <a href> (il testo "Fascicoli personali" e' dentro
        // uno <span> annidato in <a>): cliccare il <li> contenitore non navigherebbe.
        const links = [...document.querySelectorAll('a[href]')].filter(visible);
        return links.find((a) => { const t = norm(a.textContent); return /fascicoli\s+personali/.test(t) && t.length <= 40; }) || null;
    }

    function trovaLinkPagina(n) {
        const anchors = [...document.querySelectorAll('a[href]')].filter(visible);
        let a = anchors.find((x) => norm(x.textContent) === String(n));
        if (a) return a;
        a = anchors.find((x) => /(success|avanti|»|›|prossim)/i.test(norm(x.textContent)));
        return a || null;
    }

    // La scheda "Fascicoli personali" mostra prima un FORM di ricerca: la tabella
    // dei fascicoli compare solo dopo aver premuto "Esegui ricerca".
    function haTabellaRisultati() {
        return [...document.querySelectorAll('table')].some((t) => headerMap(t));
    }
    // Individua SOLO il form "Ricerca per Numero" dei Fascicoli personali: ha il
    // campo hidden tipoRicerca=ricercaNumero, oppure i campi Tipologia + Anno.
    // In questo modo NON viene confuso col form "Esegui ricerca" della scheda Agenda
    // (che invece richiede dataDal/dataAl e farebbe fallire la ricerca).
    function formRicercaNumero() {
        const forms = [...document.querySelectorAll('form')];
        let f = forms.find((fm) => { const h = fm.querySelector('input[name="tipoRicerca"]'); return h && /numero/i.test(h.value); });
        if (f) return f;
        f = forms.find((fm) => fm.querySelector('select[name="tipologia"]') && fm.querySelector('input[name="anno"]'));
        return f || null;
    }
    function haFormRicerca() {
        return !!formRicercaNumero();
    }
    // Anni da consultare: dall'anno corrente a ritroso per NUM_ANNI_STORICO anni.
    function anniRicerca() {
        const y = new Date().getFullYear();
        const out = [];
        for (let i = 0; i < NUM_ANNI_STORICO; i++) out.push(y - i);
        return out;
    }
    // Esegue la ricerca "per Numero" con Tipologia = Ruolo Generale, Numero vuoto e
    // Anno = anno indicato: elenca tutti i fascicoli di quell'anno per il registro.
    function submitRicercaNumero(anno) {
        const f = formRicercaNumero();
        if (!f) return false;
        const tip = f.querySelector('select[name="tipologia"]');
        if (tip) {
            const opt = [...tip.options].find((o) => /RGN/i.test(o.value) || /ruolo generale/i.test(norm(o.textContent)));
            if (opt) { tip.value = opt.value; tip.dispatchEvent(new Event('change', { bubbles: true })); }
        }
        const num = f.querySelector('input[name="numero"]');
        if (num) { num.value = ''; num.dispatchEvent(new Event('input', { bubbles: true })); }
        const an = f.querySelector('input[name="anno"]');
        if (an) { an.value = String(anno); an.dispatchEvent(new Event('input', { bubbles: true })); an.dispatchEvent(new Event('change', { bubbles: true })); }
        const btn = f.querySelector('input[type=submit][name="action:search"]') || f.querySelector('input[type=submit]');
        if (btn) { btn.click(); return true; }
        try { f.submit(); return true; } catch (e) { return false; }
    }

    // ─── Salvataggio batch ───────────────────────────────────────────────────
    async function salvaBatch(fascicoli) {
        const url = ordineBackendUrl(CFG.backendUrl);
        let inseriti = 0, aggiornati = 0, errori = 0;
        for (let i = 0; i < fascicoli.length; i += MAX_BATCH) {
            const chunk = fascicoli.slice(i, i + MAX_BATCH);
            const resp = await backendPost(url, CFG.apiToken, CFG.cf, { azione: 'salva_batch', cf_avvocato: CFG.cf, fascicoli: chunk });
            const r = resp && resp.result ? resp.result : resp;
            if (r && typeof r === 'object') {
                inseriti += r.inseriti || 0; aggiornati += r.aggiornati || 0; errori += r.errori || 0;
            } else { errori += chunk.length; }
        }
        return { inseriti, aggiornati, errori };
    }

    // ─── Login ────────────────────────────────────────────────────────────────
    function paginaLogin() {
        if (isFormFrame()) return false;
        const txt = norm((document.body || {}).innerText || '');
        if (!txt) return false;
        // Se non c'e' il form e la pagina invita all'accesso: login richiesto.
        return /(effettua l'accesso|accedi con|area riservata|autenticazione|smart\s*card|carta nazionale dei servizi)/.test(txt)
            && !/benvenuto/.test(txt);
    }

    // ─── Macchina a stati ──────────────────────────────────────────────────────
    async function caricaStato() { const st = await storageGet([STATE_KEY]); return st[STATE_KEY] || null; }
    async function salvaStato(s) { await storageSet({ [STATE_KEY]: s }); }
    async function pulisciStato() { await storageRemove([STATE_KEY]); }

    async function finish(state, msg, stato) {
        await progressoSet({
            stato: stato || 'completato',
            ordine: state.ordine || '', provincia: state.provincia || '',
            uffici_totali: state.total || 0, uffici_fatti: state.total || 0,
            fascicoli_trovati: state.trovati || 0, fascicoli_salvati: state.salvati || 0,
            errori: state.errori || 0, messaggio: msg || 'Sincronizzazione completata',
        });
        bannerTesto(msg || 'Completato');
        bannerProgresso(state.total || 1, state.total || 1);
        await pulisciStato();
        await storageRemove(['pctOrderSyncPending']);
        orderSyncFinished();
    }

    async function initFresh() {
        bannerTesto('Recupero elenco uffici/registri...');
        const url = ordineBackendUrl(CFG.backendUrl);
        const store = await storageGet(['pctOrderSyncCodici']);
        const codici = Array.isArray(store.pctOrderSyncCodici) ? store.pctOrderSyncCodici : [];
        const resp = await backendPost(url, CFG.apiToken, CFG.cf, { azione: 'elenco_uffici', cf_avvocato: CFG.cf, codici });
        const r = resp && resp.result ? resp.result : resp;
        const uffici = (r && r.uffici) ? r.uffici : [];
        const state = {
            combos: uffici, idx: 0, page: 1, phase: 'search', tabClicked: false,
            trovati: 0, salvati: 0, errori: 0, fatti: 0, total: uffici.length,
            ordine: (r && r.ordine) || '', provincia: (r && r.provincia) || '',
        };
        await salvaStato(state);
        slogReset('===== AVVIO SYNC MINISTERO ===== ordine=' + state.ordine + ' provincia=' + state.provincia + ' combinazioni=' + state.total);
        await progressoSet({ stato: 'in_corso', ordine: state.ordine, provincia: state.provincia, uffici_totali: state.total, uffici_fatti: 0, fascicoli_trovati: 0, fascicoli_salvati: 0, errori: 0, messaggio: 'Avvio consultazione registri...' });
        return state;
    }

    // Compila i select e clicca Consulta per la combinazione corrente.
    // Ritorna 'submitted' (navigazione avviata) oppure 'skip' (combo saltata).
    async function doSearch(state) {
        const combo = state.combos[state.idx];
        const etichetta = combo.nome + ' — ' + (combo.registro || '');
        bannerTesto('[' + (state.idx + 1) + '/' + state.total + '] ' + etichetta);
        slog('--- [' + (state.idx + 1) + '/' + state.total + '] ufficio="' + combo.nome + '" registro="' + combo.registro + '"');
        await progressoSet({ stato: 'in_corso', ordine: state.ordine, provincia: state.provincia, ufficio_corrente: combo.nome, registro_corrente: combo.registro || '', uffici_totali: state.total, uffici_fatti: state.fatti, fascicoli_trovati: state.trovati, fascicoli_salvati: state.salvati, errori: state.errori, messaggio: 'Consultazione ' + etichetta });

        // Attende il form con il <select> Ufficio POPOLATO (le opzioni arrivano via
        // AJAX dopo il load: leggerlo troppo presto da' solo "seleziona un ufficio").
        const sels = await waitFor(() => {
            const s = trovaSelects();
            if (!s.uff || !trovaConsulta()) return null;
            const opts = [...s.uff.options].map((o) => norm(o.textContent)).filter(Boolean);
            const pronto = opts.length > 1 && opts.some((t) => !/seleziona|scegli/.test(t));
            return pronto ? s : null;
        }, { timeout: 30000, interval: 400 });
        if (!sels) {
            const s0 = trovaSelects();
            slog('    ✗ uffici non popolati: opzioni=' + (s0.uff ? [...s0.uff.options].map((o) => norm(o.textContent)).join(' || ') : 'nessun <select>'));
            state.errori++; return 'skip';
        }

        const uff = scegliOpzione(sels.uff, combo.nome, [combo.termine_ricerca]);
        if (!uff) {
            slog('    ✗ ufficio non selezionabile: opzioni=' + [...sels.uff.options].slice(0, 12).map((o) => norm(o.textContent)).join(' || '));
            state.errori++; return 'skip';
        }
        slog('    ✓ ufficio: ' + uff.text + ' (score ' + uff.score.toFixed(2) + ')');

        // Il <select> Registro viene ripopolato via AJAX DOPO la scelta dell'ufficio:
        // attendo che compaiano opzioni reali (oltre al placeholder "scegli/seleziona").
        const regPronto = await waitFor(() => {
            const rs = trovaSelects().reg;
            if (!rs) return null;
            const opts = [...rs.options].map((o) => norm(o.textContent)).filter(Boolean);
            return (opts.length > 1 && opts.some((t) => !/scegli|seleziona/.test(t))) ? rs : null;
        }, { timeout: 12000, interval: 250 });

        const regSel = regPronto || trovaSelects().reg;
        if (regSel) {
            slog('    opzioni registro: ' + [...regSel.options].map((o) => norm(o.textContent)).join(' || '));
            const reg = scegliOpzione(regSel, combo.registro, []);
            if (!reg) {
                slog('    ✗ registro non trovato: cercato="' + combo.registro + '"');
                state.errori++; return 'skip';
            }
            slog('    ✓ registro: ' + reg.text);
            await sleep(200);
        }

        // Anche il <select> Ruolo si popola via DWR DOPO la scelta del registro
        // (changeRuoli): attendo che compaia l'opzione "Avvocato".
        const ruoPronto = await waitFor(() => {
            const rs = trovaSelects().ruo;
            if (!rs) return null;
            const opts = [...rs.options].map((o) => norm(o.textContent)).filter(Boolean);
            return (opts.length > 1 && opts.some((t) => /avvocato/.test(t))) ? rs : null;
        }, { timeout: 10000, interval: 250 });
        const ruoSel = ruoPronto || trovaSelects().ruo;
        if (ruoSel) { const ru = scegliOpzione(ruoSel, 'Avvocato', []); if (ru) slog('    ✓ ruolo: ' + ru.text); }

        state.phase = 'read'; state.page = 1; state.tabClicked = false; state.searched = false; state.yearIdx = 0;
        await salvaStato(state);
        const btn = trovaConsulta();
        if (!btn) { slog('    ✗ pulsante Consulta assente'); state.phase = 'search'; await salvaStato(state); state.errori++; return 'skip'; }
        slog('    → click Consulta');
        btn.click();
        return 'submitted';
    }

    // Legge la scheda Fascicoli personali. Per ciascun anno (dall'anno corrente a
    // ritroso per NUM_ANNI_STORICO anni) sottomette la "Ricerca per Numero"
    // (Ruolo Generale, Numero vuoto, Anno) e ne estrae la tabella. Ritorna:
    //   'nav'       -> ha cliccato tab/ricerca/pagina (navigazione in corso)
    //   'next-combo'-> combinazione conclusa, si puo' proseguire (nessuna nav)
    //   'done'      -> tutte le combinazioni concluse
    async function doRead(state) {
        const combo = state.combos[state.idx];
        const YEARS = anniRicerca();
        if (typeof state.yearIdx !== 'number') state.yearIdx = 0;
        slog('    [doRead] url=' + location.href.slice(0, 90) + ' tabClicked=' + state.tabClicked + ' searched=' + state.searched + ' yearIdx=' + state.yearIdx + ' fascPers=' + urlFascicoliPersonali() + ' hasForm=' + haFormRicerca() + ' hasTab=' + haTabellaRisultati());

        // Assicura la scheda "Fascicoli personali". Se il form di ricerca e' gia'
        // presente su questa pagina, non serve cambiare scheda.
        if (!urlFascicoliPersonali() && !haFormRicerca()) {
            const tab = await waitFor(() => trovaTabFascicoli(), { timeout: 15000, interval: 400 });
            if (tab && !state.tabClicked) {
                state.tabClicked = true; await salvaStato(state);
                const href = tab.getAttribute('href') || tab.href || '';
                slog('    → apro scheda "Fascicoli personali": ' + href);
                if (href) { window.location.href = tab.href; } else { tab.click(); }
                return 'nav';
            }
        }

        const anno = YEARS[state.yearIdx];

        // Non ancora eseguita la ricerca per l'anno corrente: attende il form e la
        // sottomette (Ruolo Generale, anno). La tabella compare solo dopo il submit.
        if (!state.searched) {
            await waitFor(() => haFormRicerca(), { timeout: 20000, interval: 300 });
            if (!haFormRicerca()) {
                // Form non presente: ricarico la scheda "Fascicoli personali" pulita.
                const tab = trovaTabFascicoli();
                const href = tab ? (tab.getAttribute('href') || tab.href || '') : '';
                if (href && !state.reloaded) {
                    state.reloaded = true; await salvaStato(state);
                    slog('    (form assente) ricarico scheda "Fascicoli personali"');
                    window.location.href = tab.href; return 'nav';
                }
            }
            state.reloaded = false;
            state.searched = true; await salvaStato(state);
            slog('    → [' + combo.registro + '] Ricerca per Numero: Ruolo Generale, anno=' + anno);
            await progressoSet({ stato: 'in_corso', ordine: state.ordine, provincia: state.provincia, ufficio_corrente: combo.nome, registro_corrente: combo.registro || '', anno_corrente: anno, uffici_totali: state.total, uffici_fatti: state.fatti, fascicoli_trovati: state.trovati, fascicoli_salvati: state.salvati, errori: state.errori, messaggio: combo.nome + ' — ' + combo.registro + ' — anno ' + anno });
            if (submitRicercaNumero(anno)) return 'nav';
            slog('    ✗ form "Ricerca per Numero" non trovato');
        }

        // Attende la tabella dei risultati (o un messaggio "nessun risultato")
        await waitFor(() => {
            const t = [...document.querySelectorAll('table')].filter(visible).some((tb) => headerMap(tb));
            const empty = /nessun|non ha prodotto|non.*risultat|ricerca non ha|0 risultat|non.*fascicol/i.test(norm((document.body || {}).innerText || ''));
            return t || empty;
        }, { timeout: 12000, interval: 400 });

        const { rows, noTable } = parseRisultati(combo);
        slog('    ' + combo.registro + ' anno ' + anno + ' pag.' + state.page + ': righe=' + rows.length + (noTable ? ' (nessuna tabella)' : ''));
        if (rows.length) {
            bannerLog('Trovati ' + rows.length + ' fascicoli (' + anno + ' pag. ' + state.page + ')');
            state.trovati += rows.length;
            const res = await salvaBatch(rows);
            state.salvati += res.inseriti + res.aggiornati;
            state.errori += res.errori;
            await salvaStato(state);
            await progressoSet({ stato: 'in_corso', ordine: state.ordine, provincia: state.provincia, ufficio_corrente: combo.nome, registro_corrente: combo.registro || '', anno_corrente: anno, uffici_totali: state.total, uffici_fatti: state.fatti, fascicoli_trovati: state.trovati, fascicoli_salvati: state.salvati, errori: state.errori, messaggio: 'Salvati ' + state.salvati + ' fascicoli' });
        }

        // Paginazione entro l'anno
        if (state.page < MAX_PAGINE) {
            const next = trovaLinkPagina(state.page + 1);
            if (next) {
                state.page++; await salvaStato(state);
                slog('    → pagina ' + state.page);
                next.click();
                return 'nav';
            }
        }

        // Anno concluso: passa all'anno successivo.
        state.yearIdx++; state.page = 1; state.searched = false; state.reloaded = false;
        await salvaStato(state);
        if (state.yearIdx < YEARS.length) {
            const prossimo = YEARS[state.yearIdx];
            // Fast path: se il form "Ricerca per Numero" e' ancora presente, ri-submit
            // sulla stessa pagina. Altrimenti (es. registri che ritornano una pagina
            // senza form) ricarico la scheda "Fascicoli personali" per averlo pulito.
            if (haFormRicerca()) {
                state.searched = true; await salvaStato(state);
                slog('    → [' + combo.registro + '] Ricerca per Numero: Ruolo Generale, anno=' + prossimo);
                await progressoSet({ stato: 'in_corso', ordine: state.ordine, provincia: state.provincia, ufficio_corrente: combo.nome, registro_corrente: combo.registro || '', anno_corrente: prossimo, uffici_totali: state.total, uffici_fatti: state.fatti, fascicoli_trovati: state.trovati, fascicoli_salvati: state.salvati, errori: state.errori, messaggio: combo.nome + ' — ' + combo.registro + ' — anno ' + prossimo });
                if (submitRicercaNumero(prossimo)) return 'nav';
            }
            const tab = trovaTabFascicoli();
            const href = tab ? (tab.getAttribute('href') || tab.href || '') : '';
            if (href) {
                slog('    → anno ' + prossimo + ': ricarico scheda "Fascicoli personali"');
                window.location.href = tab.href; return 'nav';
            }
        }

        // Combinazione conclusa (tutti gli anni consultati)
        state.idx++; state.fatti++; state.phase = 'search'; state.tabClicked = false; state.searched = false; state.yearIdx = 0;
        await salvaStato(state);
        bannerProgresso(state.fatti, state.total);
        if (state.idx >= state.total) { await finish(state, 'Completato: ' + state.salvati + ' fascicoli salvati (' + state.trovati + ' trovati, ' + state.errori + ' errori)'); return 'done'; }
        return 'next-combo';
    }

    // ─── Main ────────────────────────────────────────────────────────────────
    async function main() {
        const cfg = await storageGet(['backendUrl', 'apiToken', 'lastCfAvvocato', 'pctOrderSyncPending']);
        CFG.backendUrl = cfg.backendUrl || 'http://localhost/pct/api_sync.php';
        CFG.apiToken = cfg.apiToken || 'pct_aruba_2026_adb200f9';
        CFG.cf = String(cfg.lastCfAvvocato || '').toUpperCase();
        SLOG_BASE = (CFG.backendUrl || 'http://localhost/pct/api_sync.php').replace(/\/api_sync[^/]*\.php$/, '');
        SLOG_CF = CFG.cf;

        let state = await caricaStato();
        const pendingRecent = (Date.now() - (cfg.pctOrderSyncPending || 0)) < PENDING_MAX_MS;

        // Trigger: sync in corso (state) oppure avvio recente richiesto dalla dashboard.
        if (!state && !pendingRecent) return;
        if (!/^[A-Z0-9]{16}$/.test(CFG.cf)) { slog('CF avvocato mancante/invald: interrompo'); return; }

        // Vincolo: solo la scheda/finestra aperta dalla sync pilota la macchina a
        // stati. Altre schede del Portale eventualmente aperte NON devono eseguire
        // (condividerebbero lo stesso pctMinState creando corse e "seleziona un ufficio").
        const amSync = await new Promise((res) => {
            try { chrome.runtime.sendMessage({ action: 'isOrderSyncTab' }, (r) => { void chrome.runtime.lastError; res(!!(r && r.ok)); }); }
            catch (e) { res(false); }
        });
        if (!amSync) return;

        // Solo il frame con il form (o i risultati) porta avanti la sync.
        if (!isFormFrame() && !urlFascicoliPersonali()) {
            // Frame portale/login: se e' una pagina di login, segnala e non ciclare.
            if (paginaLogin()) {
                slog('Login richiesto: attendo accesso CNS dell\'utente');
                await progressoSet({ stato: 'login_richiesto', ordine: (state && state.ordine) || '', provincia: (state && state.provincia) || '', messaggio: 'Accesso al Portale del Ministero richiesto: effettua il login con CNS.' });
            }
            return;
        }

        if (!state) { state = await initFresh(); }
        if (!state.total) { await finish(state, 'Nessun ufficio/registro da consultare per l\'Ordine'); return; }
        slog('[main] fase=' + state.phase + ' idx=' + state.idx + ' url=' + location.href.slice(0, 80));

        // Ciclo interno: avanza finche' non serve una navigazione (poi ci pensa
        // la re-iniezione a riprendere).
        let guard = 0;
        while (guard++ < (state.total * 2 + 5)) {
            if (state.phase === 'search') {
                const r = await doSearch(state);
                if (r === 'submitted') return;      // navigazione avviata
                // 'skip': combo saltata, passa alla successiva sullo stesso frame
                state.idx++; state.fatti++;
                await salvaStato(state);
                bannerProgresso(state.fatti, state.total);
                if (state.idx >= state.total) { await finish(state, 'Completato con ' + state.errori + ' combinazioni non disponibili'); return; }
                continue; // phase resta 'search'
            }
            if (state.phase === 'read') {
                const r = await doRead(state);
                if (r === 'nav' || r === 'done') return;
                // 'next-combo': phase e' gia' 'search', continua il ciclo
                continue;
            }
            break;
        }
    }

    // Avvio: attende un attimo il rendering del frame Struts.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(main, 400));
    } else {
        setTimeout(main, 400);
    }
})();
