/**
 * PCT Monitor - Scraper sincronizzazione fascicoli per Ordine
 *
 * Viene iniettato sulle pagine /advanced-search del PdA Toscana.
 * Si attiva SOLO se l'URL contiene l'hash #pct-sync-ordine (impostato dal
 * pulsante "Sincronizza fascicoli del mio Ordine" della dashboard).
 *
 * Flusso:
 *  1. Recupera l'elenco uffici/registri dal backend (azione 'elenco_uffici').
 *  2. Per ogni ufficio/registro compila la Ricerca Avanzata con
 *     "Ruolo Interrogazione: Avvocato", clicca Ricerca e legge tutte le pagine.
 *  3. Invia i fascicoli trovati al backend in batch (azione 'salva_batch').
 *  4. Aggiorna lo stato di avanzamento (azione 'progresso_set') mostrato
 *     nella modale della dashboard.
 */

(() => {
    if (window.__pctScraperOrdineLoaded) return;
    window.__pctScraperOrdineLoaded = true;

    'use strict';

    const LOG = '[PCT][SyncOrdine]';
    const ADV_PATH = '/pda-rt/cancelleriatelematica/advanced-search';
    const TRIGGER_HASH = 'pct-sync-ordine';
    const MINUTI_ANTI_RIPETIZIONE = 10;
    const MAX_PAGINE_PER_RICERCA = 50;
    const MAX_OFFICINE_BATCH = 100; // fascicoli per singola chiamata salva_batch
    const ANNI_INDIETRO = 5;        // ramo FORM: anno corrente + i cinque precedenti.
    // Sul ramo FORM ogni anno in piu' e' una ricerca in piu' da paginare, quindi la
    // finestra resta corta. Sul ramo API il portale restituisce tutti gli anni in
    // una sola chiamata (le date "Dal" sono a "adesso" per disattivare il filtro):
    // allargare non costa nulla, e deve coprire la stessa finestra della ricerca
    // "Cerca fascicoli", altrimenti un fascicolo del 2018 aggiunto da lì non
    // verrebbe mai piu' aggiornato dalla sync.
    const ANNI_INDIETRO_API = 14;   // ramo API: anno corrente + i quattordici precedenti (dal 2012)
    const DOC_FASCICOLI_PARALLELI = 5; // fascicoli scaricati insieme.
    // Era 1 perche' scaricaDocumentiFascicolo() rinnovava il Bearer riscrivendo i
    // globali TOKEN_PDA/TOKEN_ORIGINE e non era rientrante: due fascicoli insieme
    // si azzeravano il token a vicenda -> autenticazioni saltate, buste vuote, atti
    // e xml mancanti. Ora il token passa da tokenPerScarico(), che rinnova UNA sola
    // volta per tutti (rinnovo condiviso) e non cancella mai il token in uso da
    // altri, e i documenti hanno un tetto GLOBALE (PARALLELE_TOTALI in
    // pda_download.js) che evita di ingolfare AstarFirmaServer moltiplicando i
    // fascicoli. Dentro ogni fascicolo restano i PARALLELE=8 documenti insieme.

    // SYNC VELOCE (ripasso dai link salvati): qui invece PIU' fascicoli in parallelo
    // sono sicuri, perche' si chiama DIRETTAMENTE chiamataScarico(...) ->
    // window.PctDownload.scaricaFascicoloPC, motore AUTONOMO (token passato come
    // parametro, nessun globale TOKEN_PDA/TOKEN_ORIGINE toccato, nessuna
    // rientranza). A 5 come il motore offscreen; scende a 1 da solo se un intero
    // blocco torna a "buste vuote" (sospetta interferenza sulla sessione del PdA).
    const RESYNC_PARALLELI = 5;

    // Traduzione fra l'etichetta del registro salvata a database
    // (tab_uffici_giudiziari.registro) e quello che il form del portale si
    // aspetta. Attenzione: le schede in alto nel PdA sono soltanto quattro
    // (Civile/Lavoro, Esecuzioni e fallimenti, Giudici di Pace, Cassazione
    // Civile) e NON hanno il nome del registro: il registro e' una voce del
    // menu "Registro Generale" DENTRO la scheda. Percio' qui "scheda" e
    // "registro_generale" sono due cose distinte.
    // "app" e "cod_api" servono alla ricerca diretta via API del portale:
    // l'applicativo (sicid / siecic) determina l'endpoint, cod_api e' il codice
    // registro che l'API vuole. Attenzione: per il Lavoro il catalogo uffici
    // dice "LAV" ma la ricerca e i link ai fascicoli usano "DL".
    const REGISTRI_PORTALE = {
        'contenzioso civile':       { codice: 'CC',   nome: 'Contenzioso Civile',       scheda: 'Civile/Lavoro',            registro_generale: 'Contenzioso Civile',       app: 'sicid',  cod_api: 'CC' },
        'lavoro':                   { codice: 'LAV',  nome: 'Lavoro',                   scheda: 'Civile/Lavoro',            registro_generale: 'Diritto del Lavoro',       app: 'sicid',  cod_api: 'DL' },
        'diritto del lavoro':       { codice: 'LAV',  nome: 'Lavoro',                   scheda: 'Civile/Lavoro',            registro_generale: 'Diritto del Lavoro',       app: 'sicid',  cod_api: 'DL' },
        'volontaria giurisdizione': { codice: 'VG',   nome: 'Volontaria Giurisdizione', scheda: 'Civile/Lavoro',            registro_generale: 'Volontaria Giurisdizione', app: 'sicid',  cod_api: 'VG' },
        'procedure concorsuali':    { codice: 'FALL', nome: 'Procedure Concorsuali',    scheda: 'Esecuzioni e fallimenti',  registro_generale: 'Procedure Concorsuali',    app: 'siecic', cod_api: 'FALL' },
        'esecuzioni mobiliari':     { codice: 'ESM',  nome: 'Esecuzioni Mobiliari',     scheda: 'Esecuzioni e fallimenti',  registro_generale: 'Esecuzioni Mobiliari',     app: 'siecic', cod_api: 'ESM' },
        'esecuzioni immobiliari':   { codice: 'ESIM', nome: 'Esecuzioni Immobiliari',   scheda: 'Esecuzioni e fallimenti',  registro_generale: 'Esecuzioni Immobiliari',   app: 'siecic', cod_api: 'ESIM' },
        'giudice di pace':          { codice: 'GDP',  nome: 'Giudice di Pace',          scheda: 'Giudici di Pace',          registro_generale: '',                         app: 'sigp',   cod_api: 'ESIM' },
        'giudici di pace':          { codice: 'GDP',  nome: 'Giudice di Pace',          scheda: 'Giudici di Pace',          registro_generale: '',                         app: 'sigp',   cod_api: 'ESIM' },
    };

    // ─── Ricerca diretta via API del portale (via rapida) ─────────────────────
    //
    // Il form di Ricerca Avanzata non fa altro che chiamare due endpoint REST.
    // Interrogarli direttamente elimina autocomplete, cambi di scheda, click e
    // attese di rendering: una chiamata per ufficio+registro invece di decine
    // di interazioni col DOM. Soprattutto, la ricerca senza il campo Anno
    // restituisce i fascicoli di TUTTI gli anni in un colpo solo (compresi
    // quelli molto vecchi, che il ciclo 2021-2026 non vedeva affatto).
    const API_ROOT = location.origin + '/pda-rt/api';
    const API_UFFICIO = API_ROOT + '/servizipda-anagrafiche/v1/catalogo-ug/getUfficioGiudiziario/';
    const API_TENTATIVI = 4;          // il portale rifiuta a raffica sotto carico
    const API_PAUSA_FRA_CHIAMATE = 250;
    // Durante la sync dell'Ordine si scaricano anche i documenti di ogni
    // fascicolo trovato, con la stessa strada diretta usata dal pulsante
    // "Sincronizza fascicolo corrente". Metti false per la sola anagrafica.
    const SCARICA_DOCUMENTI = true;
    const AREA_DA_APP = { sicid: 'SICID', siecic: 'SIECIC', sigp: 'SIGP' };
    const COD_API_DA_CATALOGO = { LAV: 'DL' };
    // Il Giudice di Pace sta nell'area SIGP e ha un'unica chiamata: il portale
    // stesso, sulle pagine del GdP, cerca sempre col codice registro ESIM.
    const REGISTRI_GDP = [
        { app: 'sigp', cod: 'ESIM', desc: 'Giudice di Pace' },
    ];

    // SIGP ha un endpoint di ricerca suo (per Ruolo/Materia/Oggetto), SIECIC
    // cerca per numero, SICID per tipo: il corpo della richiesta e' lo stesso.
    const urlRicercaApi = (app) => {
        if (app === 'siecic') return API_ROOT + '/servizipda-siecic/v1/ricercaInformazioniFascicoloPerNumero';
        if (app === 'sigp') return API_ROOT + '/servizipda-sigp/v1/ricercaInformazioniFascicoloPerRMO';
        return API_ROOT + '/servizipda-sicid/v1/ricercaInformazioniFascicoloPerTipo';
    };

    let TOKEN_PDA = '';
    let TOKEN_ORIGINE = '';

    /** Sembra un JWT? (tre pezzi separati da punto, lungo) */
    const pareJwt = (v) => {
        const s = String(v || '').trim();
        return s.length > 60 && s.split('.').length === 3;
    };
    /** Ultimi caratteri del token, per riconoscerlo nel log senza esporlo. */
    const codaToken = (v) => '…' + String(v || '').slice(-8);

    /**
     * Tutti i Bearer token utilizzabili, dal piu' affidabile al meno.
     * Non basta leggere localStorage.access_token: su questo portale quella
     * chiave puo' contenere un token vecchio o di un'altra applicazione, e il
     * PdA risponde 401. Il token davvero in uso e' quello che l'interceptor ha
     * catturato dalla risposta di Keycloak.
     */
    async function candidatiToken() {
        const out = [];
        const aggiungi = (origine, valore) => {
            const v = String(valore || '').trim();
            if (!pareJwt(v)) return;
            if (out.some((c) => c.valore === v)) return;
            out.push({ origine, valore: v });
        };
        try {
            const r = await chrome.runtime.sendMessage({ action: 'pdaTokenGet' });
            aggiungi('interceptor', r && (r.access || r.token));
        } catch (e) { /* service worker non raggiungibile */ }
        const depositi = [['localStorage', window.localStorage], ['sessionStorage', window.sessionStorage]];
        for (const [nome, dep] of depositi) {
            try {
                for (let i = 0; i < dep.length; i++) {
                    const k = dep.key(i);
                    if (!/token|access|jwt|auth|kc-/i.test(k)) continue;
                    const v = dep.getItem(k);
                    if (v && v.charAt(0) === '{') {
                        try {
                            const o = JSON.parse(v);
                            ['access_token', 'accessToken', 'token', 'access'].forEach((x) => aggiungi(nome + ':' + k + '.' + x, o[x]));
                            continue;
                        } catch (e) { /* non era JSON */ }
                    }
                    aggiungi(nome + ':' + k, v);
                }
            } catch (e) { /* deposito non accessibile */ }
        }
        return out;
    }

    /**
     * Access token RINNOVATO dal background (usa il refresh token su Keycloak).
     * Serve perche' l'access del PdA vive ~5 minuti mentre una sincronizzazione
     * di centinaia di fascicoli dura molto di piu': a meta' corsa il token in
     * mano nostra scade e il portale risponde 401 invalid_token su OGNI fascicolo
     * successivo, senza che nulla lo rimetta a posto. I candidati letti da
     * storage/localStorage non bastano: sono la stessa copia scaduta.
     */
    async function tokenFresco() {
        try {
            const r = await chrome.runtime.sendMessage({ action: 'pdaTokenFresh' });
            const v = String((r && r.access) || '').trim();
            return pareJwt(v) ? v : '';
        } catch (e) { return ''; }
    }

    /**
     * Token da usare per lo scarico documenti: quello che ha appena funzionato,
     * altrimenti il primo candidato. Si rilegge ogni volta perche' vive pochi
     * minuti e uno scarico lungo lo vedrebbe scadere a meta'.
     */
    async function tokenPortale() {
        if (TOKEN_PDA) return TOKEN_PDA;
        const cand = await candidatiToken();
        if (!cand.length) return '';
        TOKEN_PDA = cand[0].valore;
        TOKEN_ORIGINE = cand[0].origine;
        return TOKEN_PDA;
    }

    /** Una singola chiamata, con ritentativi solo sugli errori del server. */
    async function chiamataApi(url, body, token) {
        const opz = {
            method: body ? 'POST' : 'GET',
            headers: {
                'Authorization': 'Bearer ' + token,
                'Accept': 'application/json',
                // Senza X-ROLE il portale risponde 401 anche con un token buono:
                // e' l'intestazione che la webapp del PdA aggiunge a ogni chiamata.
                'X-ROLE': 'AVV',
            },
            credentials: 'include',
        };
        if (body) {
            opz.headers['Content-Type'] = 'application/json';
            opz.body = JSON.stringify(body);
        }
        let attesa = 1200;
        for (let tent = 1; tent <= API_TENTATIVI; tent++) {
            let r = null;
            try {
                r = await fetch(url, opz);
            } catch (e) {
                if (tent === API_TENTATIVI) return { stato: 0, dati: null, errore: 'rete: ' + (e && e.message) };
                await sleep(attesa); attesa *= 2; continue;
            }
            if (r.status === 204) return { stato: 204, dati: null };
            if (r.status === 401 || r.status === 403) return { stato: r.status, dati: null, errore: 'token rifiutato' };
            if (r.status >= 200 && r.status < 300) {
                try { return { stato: r.status, dati: await r.json() }; }
                catch (e) { return { stato: r.status, dati: null }; }
            }
            if (r.status >= 500 && tent < API_TENTATIVI) {
                slog('    API ' + r.status + ' (portale saturo): ritento fra ' + Math.round(attesa / 1000) + 's');
                await sleep(attesa); attesa *= 2; continue;
            }
            return { stato: r.status, dati: null, errore: 'HTTP ' + r.status };
        }
        return { stato: 0, dati: null, errore: 'nessuna risposta' };
    }

    /**
     * Chiamata all'API del portale. Se il token viene rifiutato si passa al
     * candidato successivo invece di arrendersi: e' esattamente il caso in cui
     * localStorage conserva un token scaduto mentre quello valido e' altrove.
     */
    async function apiPortale(url, body) {
        if (TOKEN_PDA) {
            const r = await chiamataApi(url, body, TOKEN_PDA);
            if (r.stato !== 401 && r.stato !== 403) return r;
            slog('    token ' + TOKEN_ORIGINE + ' ' + codaToken(TOKEN_PDA) + ' rifiutato (' + r.stato + '): cerco un altro token');
            TOKEN_PDA = '';
            TOKEN_ORIGINE = '';
        }
        const cand = await candidatiToken();
        if (!cand.length) {
            return { stato: 0, dati: null, errore: 'nessun token del portale trovato (ricarica la pagina del PdA)' };
        }
        slog('    token candidati: ' + cand.map((c) => c.origine + ' ' + codaToken(c.valore)).join(', '));
        let ultimo = { stato: 0, dati: null, errore: 'nessun token accettato' };
        for (const c of cand) {
            const r = await chiamataApi(url, body, c.valore);
            if (r.stato === 401 || r.stato === 403) {
                slog('    ✗ token ' + c.origine + ' rifiutato (' + r.stato + ')');
                ultimo = { stato: r.stato, dati: null, errore: 'token rifiutato dal portale (provati ' + cand.length + ' token)' };
                continue;
            }
            TOKEN_PDA = c.valore;
            TOKEN_ORIGINE = c.origine;
            slog('    ✓ token in uso: ' + c.origine + ' ' + codaToken(c.valore));
            return r;
        }
        return ultimo;
    }

    /** Cerca ricorsivamente la prima chiave con quel nome dentro un JSON. */
    function cercaChiave(nodo, chiave) {
        if (!nodo || typeof nodo !== 'object') return null;
        if (Object.prototype.hasOwnProperty.call(nodo, chiave) && nodo[chiave]) return nodo[chiave];
        for (const k of Object.keys(nodo)) {
            const v = cercaChiave(nodo[k], chiave);
            if (v) return v;
        }
        return null;
    }

    /** Raccoglie tutti i registri dichiarati dal catalogo per quell'ufficio. */
    function registriDalCatalogo(nodo, trovati) {
        trovati = trovati || [];
        if (!nodo || typeof nodo !== 'object') return trovati;
        if (Array.isArray(nodo)) { nodo.forEach((x) => registriDalCatalogo(x, trovati)); return trovati; }
        if (nodo.codice && nodo.codiceApplicazione) {
            const app = String(nodo.codiceApplicazione).toLowerCase();
            const cod = String(nodo.codice).toUpperCase();
            if (!trovati.some((r) => r.app === app && r.cod === cod)) {
                trovati.push({ app, cod: COD_API_DA_CATALOGO[cod] || cod, desc: nodo.descrizione || cod });
            }
        }
        Object.keys(nodo).forEach((k) => registriDalCatalogo(nodo[k], trovati));
        return trovati;
    }

    const CATALOGO_CACHE = new Map();
    const ELENCO_AREE_CACHE = new Map();

    /**
     * Ripiego per il distretto: l'elenco completo degli uffici di un'area.
     * Serve quando getUfficioGiudiziario non risponde (o non e' autorizzato) ma
     * la ricerca fascicoli funziona: del catalogo ci serve solo il codiceGL.
     */
    async function elencoUfficiArea(area) {
        if (ELENCO_AREE_CACHE.has(area)) return ELENCO_AREE_CACHE.get(area);
        const r = await apiPortale(API_ROOT + '/servizipda-anagrafiche/v1/catalogo-ug/getListaUfficiGiudiziariPerArea', { area: [area] });
        const mappa = new Map();
        if (r.stato === 200 && r.dati) {
            const lista = r.dati.ufficioMinList || r.dati.ufficiList || [];
            lista.forEach((u) => {
                if (u && u.codiceUfficio) mappa.set(String(u.codiceUfficio), String(u.codiceGL || ''));
            });
            slog('    elenco uffici area ' + area + ': ' + mappa.size + ' voci');
        } else {
            slog('    elenco uffici area ' + area + ': ' + (r.errore || 'HTTP ' + r.stato));
        }
        ELENCO_AREE_CACHE.set(area, mappa);
        return mappa;
    }

    /** Distretto (codiceGL) e registri disponibili per un ufficio. */
    async function catalogoUfficio(codiceUfficio) {
        if (CATALOGO_CACHE.has(codiceUfficio)) return CATALOGO_CACHE.get(codiceUfficio);
        const r = await apiPortale(API_UFFICIO + encodeURIComponent(codiceUfficio), null);
        if (r.stato === 200 && r.dati) {
            const cat = {
                distretto: String(cercaChiave(r.dati, 'codiceGL') || ''),
                registri: registriDalCatalogo(r.dati),
            };
            slog('    catalogo ufficio ' + codiceUfficio + ': distretto=' + cat.distretto
                + ' registri=' + JSON.stringify(cat.registri.map((x) => x.app + ':' + x.cod)));
            CATALOGO_CACHE.set(codiceUfficio, cat);
            return cat;
        }
        slog('    catalogo ufficio ' + codiceUfficio + ': ' + (r.errore || 'HTTP ' + r.stato) + ' → provo con l\'elenco per area');
        for (const area of ['SICID', 'SIECIC', 'SIGP']) {
            const mappa = await elencoUfficiArea(area);
            const gl = mappa.get(String(codiceUfficio));
            if (gl) {
                const cat = { distretto: gl, registri: [] };
                slog('    ufficio ' + codiceUfficio + ' trovato in ' + area + ': distretto=' + gl);
                CATALOGO_CACHE.set(codiceUfficio, cat);
                return cat;
            }
        }
        CATALOGO_CACHE.set(codiceUfficio, null);
        return null;
    }

    /** Traduce un fascicolo dell'API nel formato che il backend salva. */
    function fascicoloDaApi(f, ufficio, distretto, app, codApi, cfAvvocato) {
        const area = AREA_DA_APP[app] || 'SICID';
        const idUff = String(f.idUfficio || ufficio.codice_ufficio || '');
        const anno = String(f.annoRuolo || '');
        const numeroRaw = String(f.numeroRuolo || '');
        const numeroInt = parseInt(numeroRaw.replace(/\D/g, ''), 10) || 0;
        const numeroPad = numeroRaw.replace(/\D/g, '').padStart(8, '0');
        const sub = String(f.subProcedimento != null ? f.subProcedimento : 0);
        // Nel link del PdA il settimo pezzo dell'indirizzo NON e' sempre il
        // sub-procedimento: in SIECIC e' l'idDfa (identificativo interno del
        // fascicolo), ed e' con quello che il portale consegna i documenti.
        // Attenzione: idDfa e idFascicolo sono due numeri DIVERSI nella
        // risposta di ricerca; qui serve idDfa.
        let idDfaApi = '';
        for (const campoId of ['idDfa', 'idDataFascicolo', 'idDatiFascicolo',
                               'idDfascicolo', 'idProcedimento', 'idFascicolo']) {
            if (f[campoId]) { idDfaApi = String(f[campoId]); break; }
        }
        const pezzoSub = (app === 'siecic' && idDfaApi) ? idDfaApi : sub;
        const parti = (f.infoParteList || []).map((p) => {
            const voce = {
                cognome: String(p.cognome || '').toUpperCase(),
                nome: String(p.nome || '').toUpperCase(),
                tipo: String(p.tipo || 'CP').toUpperCase(),
                cf_parte: String(p.codiceFiscaleParte || '').toUpperCase(),
                data_nascita: String(p.dataNascita || ''),
            };
            if (p.avvocato) {
                voce.avvocati = [{
                    nome_avvocato: String(p.avvocato || ''),
                    cf_avvocato: String(p.codiceFiscaleAvvocato || '').toUpperCase(),
                }];
            }
            return voce;
        });
        // L'indirizzo del dettaglio non ha la stessa forma per tutte le aree:
        // SIGP (Giudice di Pace) non ha il segmento del registro e porta il
        // numero senza zeri davanti, ed e' proprio da quell'indirizzo che il
        // portale ricava i documenti del fascicolo.
        const radice = location.origin + ADV_PATH.replace('/advanced-search', '/dettaglio-fascicolo');
        // SICID vuole il numero a 8 cifre con gli zeri davanti (00000179);
        // SIECIC lo vuole cosi' com'e' (179) e col settimo pezzo = idDfa.
        const numeroLink = (app === 'siecic') ? String(numeroInt) : numeroPad;
        const link = (app === 'sigp')
            ? radice + '/' + area + '/' + distretto + '/' + idUff
                + '/' + anno + '/' + numeroInt + '/' + sub + '/' + cfAvvocato + '/AVV'
            : radice + '/' + area + '/' + distretto + '/' + idUff + '/' + codApi
                + '/' + anno + '/' + numeroLink + '/' + pezzoSub + '/' + cfAvvocato + '/AVV';
        return {
            registro: area,
            gestore: distretto,
            id_ufficio: idUff,
            tipo_ruolo: (app === 'sigp') ? '' : codApi,
            anno_ruolo: anno,
            numero_ruolo: numeroInt,
            sub_procedimento: sub,
            giudice: String(f.giudice || ''),
            sezione: String(f.sezione || ''),
            parti,
            link,
        };
    }

    /**
     * Interroga l'API per un ufficio+registro, senza filtro sull'anno.
     * Ritorna {ok, fascicoli, errore}: ok=false solo se la chiamata e' fallita
     * (204 "nessun fascicolo" e' un esito valido con elenco vuoto).
     */
    async function ricercaApi(ufficio, app, codApi, distretto, cfAvvocato) {
        const adesso = Date.now();
        const body = {
            distretto,
            tipo: 'RGN',
            idUfficio: String(ufficio.codice_ufficio || ''),
            registroSICID: codApi,
            registro: codApi,
            dataDepositoDal: adesso,
            dataIscrizioneDal: adesso,
            dataPubblicazioneDal: adesso,
            dataUdienzaDal: adesso,
            dataScadenzaDal: adesso,
            dataDepDa: adesso,
            dataPubDa: adesso,
            dataUdDa: adesso,
        };
        const r = await apiPortale(urlRicercaApi(app), body);
        if (r.stato === 204) return { ok: true, fascicoli: [] };
        if (r.stato !== 200 || !r.dati) return { ok: false, fascicoli: [], errore: r.errore || ('HTTP ' + r.stato) };
        const lista = r.dati.infoFascicoloExtList || r.dati.infoFascicoloList || [];
        return {
            ok: true,
            fascicoli: lista.map((f) => fascicoloDaApi(f, ufficio, distretto, app, codApi, cfAvvocato)),
        };
    }

    /** Indirizzo dell'endpoint locale che scarica i documenti di un fascicolo. */
    function urlScaricoDiretto(backendUrl) {
        const base = String(backendUrl || 'http://localhost/pct/api_sync.php');
        return base.replace(/\/[^\/]*$/, '/api_scarica_diretto.php');
    }

    /**
     * Scarico dei documenti di un fascicolo per la strada diretta: elenco atti,
     * buste in parallelo, sbustamento e scrittura in archivio li fa tutti il
     * server locale (api_scarica_diretto.php). Qui passiamo solo l'indirizzo del
     * fascicolo e il token del portale, che viene riletto ogni volta perche' vive
     * pochi minuti.
     */
    /**
     * Token valido per lo scarico, condiviso fra i fascicoli in parallelo.
     *
     * Prima ogni fascicolo si costruiva la sua lista di candidati e azzerava i
     * globali TOKEN_PDA/TOKEN_ORIGINE appena il portale gli diceva no: con piu'
     * fascicoli insieme quei globali si pestavano a vicenda (uno cancellava il
     * token che un altro stava usando). Qui il rinnovo e' UNO SOLO per tutti:
     * chi scopre il token scaduto avvia il rinnovo, gli altri aspettano lo stesso
     * esito invece di chiederne uno per conto proprio.
     *
     * @param {string} scaduto token che il portale ha appena rifiutato ('' se si
     *        vuole solo quello corrente senza forzare il rinnovo).
     */
    let RINNOVO_TOKEN = null;
    async function tokenPerScarico(scaduto) {
        // Qualcun altro ha gia' rinnovato mentre eravamo in coda: usa il nuovo.
        if (TOKEN_PDA && TOKEN_PDA !== scaduto) return TOKEN_PDA;
        if (!RINNOVO_TOKEN) {
            RINNOVO_TOKEN = (async () => {
                for (const c of await candidatiToken()) {
                    if (c.valore && c.valore !== scaduto) return { valore: c.valore, origine: c.origine };
                }
                const f = await tokenFresco();
                return f ? { valore: f, origine: 'rinnovato' } : null;
            })().then((t) => {
                TOKEN_PDA = t ? t.valore : '';
                TOKEN_ORIGINE = t ? t.origine : '';
                RINNOVO_TOKEN = null;
                return t;
            }, (e) => { RINNOVO_TOKEN = null; throw e; });
        }
        const t = await RINNOVO_TOKEN.catch(() => null);
        return t ? t.valore : '';
    }

    async function scaricaDocumentiFascicolo(urlScarico, fascicolo) {
        if (!fascicolo.link || fascicolo.link.indexOf('/dettaglio-fascicolo/') === -1) {
            return { ok: false, motivo: 'indirizzo del fascicolo non disponibile' };
        }
        if (['SICID', 'SIECIC', 'SIGP'].indexOf(fascicolo.registro) === -1) {
            return { ok: false, motivo: "scarico diretto non previsto per l'area " + fascicolo.registro };
        }
        const token = await tokenPerScarico('');
        if (!token) return { ok: false, motivo: 'token del portale non disponibile' };

        const esito = await chiamataScarico(urlScarico, fascicolo, token);
        if (esito.ok) return esito;
        // Se non e' un problema di token non ha senso ripetere lo scarico.
        if (!/token|401|403|scadut/i.test(esito.motivo || '')) return esito;

        // Token rifiutato: rinnovo condiviso (candidati diversi, poi refresh su
        // Keycloak) e un solo nuovo tentativo. Il token buono resta in TOKEN_PDA,
        // quindi i fascicoli successivi ripartono gia' con quello.
        const nuovo = await tokenPerScarico(token);
        if (!nuovo || nuovo === token) {
            // Nemmeno il refresh e' valido (vive ~30 minuti): da soli non si va
            // avanti, serve rientrare nel PdA. Meglio dirlo che collezionare
            // centinaia di errori uguali.
            return {
                ok: false, riprovabile: true,
                motivo: 'sessione PdA scaduta: riapri il portale e accedi con la CNS',
            };
        }
        slog('    token scaduto: rinnovato, riprovo ' + etichettaFascicolo(fascicolo));
        return await chiamataScarico(urlScarico, fascicolo, nuovo);
    }

    /**
     * Una singola richiesta di scarico. I documenti vengono scaricati dal
     * portale e consegnati al servizio locale AstarFirmaServer, che li salva in
     * Documenti\PCT Monitor SUL PC DELL'AVVOCATO: e' lo STESSO motore usato dallo
     * scarico del singolo fascicolo (window.PctDownload.scaricaFascicoloPC).
     * Prima invece si passava da api_scarica_diretto.php sul backend, che finiva
     * per salvare i file sul disco di Aruba anziche' sul PC dell'avvocato.
     */
    // Parte del fascicolo rappresentata dall'avvocato loggato: serve come nome di
    // ripiego per gli atti di parte quando il tree del PdA (tipico SIGP/Giudice di
    // Pace) non riporta la parte e nemmeno il datiAtto la contiene. Si sceglie la
    // parte il cui avvocato combacia col CF dell'avvocato del link (…/<cf>/AVV);
    // in mancanza, la prima parte con un avvocato, poi la prima in assoluto.
    function scegliParteFallback(fascicolo) {
        const parti = (fascicolo && fascicolo.parti) || [];
        if (!parti.length) return null;
        let cfAvv = '';
        try {
            const seg = String(fascicolo.link || '').split('/');
            const iAvv = seg.lastIndexOf('AVV');
            if (iAvv > 0) cfAvv = String(seg[iAvv - 1] || '').toUpperCase();
        } catch (e) { /* ignore */ }
        let scelta = null;
        if (cfAvv) {
            scelta = parti.find((p) => (p.avvocati || []).some((a) => String(a.cf_avvocato || '').toUpperCase() === cfAvv));
        }
        if (!scelta) scelta = parti.find((p) => (p.avvocati || []).length) || parti[0];
        if (!scelta) return null;
        const nome = String((scelta.cognome || '') + ' ' + (scelta.nome || '')).trim();
        if (!nome) return null;
        return {
            tipo: String(scelta.tipo || 'AP').toUpperCase() || 'AP',
            nome: nome,
            cf: String(scelta.cf_parte || '').toUpperCase(),
        };
    }

    async function chiamataScarico(urlScarico, fascicolo, token) {
        try {
            if (!window.PctDownload || !window.PctDownload.scaricaFascicoloPC) {
                return { ok: false, motivo: 'motore di scarico non caricato (ricarica la pagina del PdA)' };
            }
            const res = await window.PctDownload.scaricaFascicoloPC(fascicolo.link, token, {
                parteFallback: scegliParteFallback(fascicolo),
                // Nessun atto nel pannello: forza il rinvio dell'elenco anche se
                // i file sono tutti sul PC, altrimenti la scheda resta "Atti (0)".
                attiSempre: Number(fascicolo.n_atti || 0) === 0,
            });
            if (!res) return { ok: false, motivo: 'nessuna risposta dal motore di scarico' };
            const d = res.documenti || {};
            // ok:false puo' significare: servizio locale spento, token rifiutato,
            // area non coperta, oppure alcune buste non riuscite (riprovabile).
            // Se comunque il motore ha girato (ha contato i documenti del
            // fascicolo), lo trattiamo come esito valido parziale invece di
            // ricominciare da capo o ricadere sul backend.
            const haGirato = res.documenti && (d.nel_fascicolo || d.scaricati || d.gia_presenti);
            if (!res.ok && !haGirato) {
                return {
                    ok: false,
                    motivo: res.messaggio || 'scarico non riuscito',
                    dettaglio: '',
                    riprovabile: !!res.riprovabile,
                };
            }
            return {
                ok: true,
                documenti: d.nel_fascicolo || 0,
                scaricati: d.scaricati || 0,
                presenti: d.gia_presenti || 0,
                falliti: d.falliti || 0,
                megabyte: d.megabyte || 0,
                secondi: d.secondi || 0,
                cache: !!res.saltatoDaCache,
                atti: res.atti || [],
                // Giudice, sezione, oggetto, udienze ed eventi letti dalle
                // comunicazioni di cancelleria: vanno salvati col fascicolo.
                scheda: (function () {
                    const out = {};
                    ['giudice', 'sezione', 'oggetto', 'data_prossima_udienza', 'data_ultima_udienza']
                        .forEach(function (c) { if (res[c]) out[c] = res[c]; });
                    if (Array.isArray(res.aggiornamenti) && res.aggiornamenti.length) out.aggiornamenti = res.aggiornamenti;
                    if (Array.isArray(res.parti) && res.parti.length) out.parti = res.parti;
                    // Difensori letti dagli XML delle buste: parte → avvocato.
                    if (Array.isArray(res.difensori) && res.difensori.length) out.difensori = res.difensori;
                    return out;
                })(),
            };
        } catch (e) {
            return { ok: false, motivo: (e && e.message) || String(e) };
        }
    }

    // ─── Ripasso dei fascicoli rifiutati dal documentale ─────────────────────
    // Il gestore documentale del PdA risponde "Errore del server" quando e'
    // occupato, e allo stesso fascicolo risponde bene poco dopo (si vede nella
    // traccia della webapp: 500 e, due minuti dopo, 200). Invece di insistere
    // sul momento, questi fascicoli si mettono da parte e si riprovano una
    // volta sola alla fine, quando il documentale ha smaltito la coda.
    const DA_RIPROVARE = [];
    const RIPROVA_MAX = 80;

    /** Vero se vale la pena riprovare piu' tardi. */
    const guastoPasseggero = (motivo) => /HTTP 5\d\d|timed out|timeout|queued for execution|Errore del server|riprova piu|riprova più|recuperare le informazioni/i.test(motivo || '');

    function annotaDaRiprovare(urlScarico, fascicolo, motivo, riprovabile) {
        if (!(riprovabile || guastoPasseggero(motivo)) || DA_RIPROVARE.length >= RIPROVA_MAX) return;
        if (DA_RIPROVARE.some((x) => x.fascicolo.link === fascicolo.link)) return;
        DA_RIPROVARE.push({ urlScarico, fascicolo });
    }

    /** Secondo e ultimo passaggio sui fascicoli messi da parte. */
    async function ripassoDocumenti(conteggi, aggiorna) {
        if (!DA_RIPROVARE.length) return;
        const coda = DA_RIPROVARE.slice();
        DA_RIPROVARE.length = 0;
        slog('  ↻ ripasso documenti: ' + coda.length + ' fascicoli rifiutati dal documentale, attendo 15s');
        bannerTesto('Ripasso documenti: ' + coda.length + ' fascicoli');
        await sleep(15000);
        for (let z = 0; z < coda.length; z++) {
            const { urlScarico, fascicolo } = coda[z];
            const et = etichettaFascicolo(fascicolo);
            bannerTesto('Ripasso ' + (z + 1) + '/' + coda.length + ': ' + et);
            if (typeof aggiorna === 'function') await aggiorna(z + 1, coda.length, et);
            const doc = await scaricaDocumentiFascicolo(urlScarico, fascicolo);
            if (doc.ok) {
                conteggi.docScaricati += doc.scaricati;
                conteggi.docPresenti += doc.presenti;
                conteggi.docFalliti += doc.falliti;
                docConta(doc.scaricati, doc.presenti);
                if (conteggi.docErrori > 0) conteggi.docErrori--;
                if (conteggi.docBloccati > 0) conteggi.docBloccati--;
                slog('    ⤓ (ripasso) ' + et + ': ' + doc.scaricati + ' nuovi su ' + doc.documenti
                    + ' (' + doc.presenti + ' già presenti, ' + doc.megabyte + ' MB)');
                bannerLog('⤓ ' + et + ' — ' + doc.scaricati + '/' + doc.documenti + ' documenti');
            } else {
                slog('    ✗ (ripasso) documenti ' + et + ': ' + doc.motivo);
            }
            await sleep(1200);
        }
    }

    // ─── Utility ─────────────────────────────────────────────────────────────
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function waitFor(fn, { timeout = 20000, interval = 300 } = {}) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            try {
                const v = fn();
                if (v) return v;
            } catch (e) { /* continua */ }
            await sleep(interval);
        }
        return null;
    }

    /** True se e' attivo lo spinner di caricamento del PdA (ngx-loading). */
    function caricamentoAttivo() {
        return [...document.querySelectorAll('ngx-loading .backdrop, .spinner-three-bounce, ngx-loading .spinner')]
            .some((e) => visible(e));
    }

    /** Attende che lo spinner di caricamento del PdA sparisca (fino a maxMs). */
    async function attendiFineCaricamento(maxMs = 20000) {
        const t0 = Date.now();
        while (Date.now() - t0 < maxMs) {
            if (!caricamentoAttivo()) return true;
            await sleep(300);
        }
        return !caricamentoAttivo();
    }

    /** WARMUP: all'apertura, l'app Angular del PdA impiega diversi secondi
     *  (spesso ~40s) prima che l'autocomplete "Ufficio" risponda. Se partiamo
     *  subito, la PRIMA combinazione (di solito il registro principale, es.
     *  Contenzioso Civile coi piu' fascicoli) fallisce con opzioni=0 e viene
     *  saltata. Qui sondiamo ripetutamente il campo Ufficio con un termine reale
     *  finche' non torna almeno un'opzione, poi ripuliamo il campo. */
    async function warmupAutocompleteUfficio(probe, maxMs = 70000) {
        const termine = (probe || 'a').toString();
        const t0 = Date.now();
        let giro = 0;
        while (Date.now() - t0 < maxMs) {
            giro++;
            if (caricamentoAttivo()) await attendiFineCaricamento(15000);
            const trigger = findUfficioTrigger();
            if (!trigger || trigger.tagName !== 'INPUT') { await sleep(800); continue; }
            try { trigger.focus(); } catch (e) { /* noop */ }
            setInputValue(trigger, '');
            await sleep(200);
            try { trigger.focus(); } catch (e) { /* noop */ }
            setInputValue(trigger, termine);
            const ok = await waitFor(() => {
                if (document.activeElement !== trigger) { try { trigger.focus(); } catch (e) { /* noop */ } }
                const o = opzioniPannelloVisibili(termine);
                return o.length ? o : null;
            }, { timeout: 5000, interval: 250 });
            if (ok && ok.length) {
                slog('    warmup autocomplete OK dopo ' + giro + ' tentativi (' + Math.round((Date.now() - t0) / 1000) + 's)');
                setInputValue(trigger, '');
                await sleep(250);
                return true;
            }
        }
        slog('    warmup autocomplete: nessuna risposta entro ' + Math.round(maxMs / 1000) + 's, proseguo comunque');
        return false;
    }

    function log(...args) {
        console.log(LOG, ...args);
    }

    // Stato per il log diagnostico lato server (impostato in main()).
    let SLOG_BASE = 'http://localhost/pct';
    let SLOG_CF = '';

    // Scrive una riga sia in console sia in logs/sync_ordine.log (via background).
    function slog(...args) {
        const msg = args.map((a) => {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch (e) { return String(a); }
        }).join(' ');
        console.log(LOG, msg);
        try {
            chrome.runtime.sendMessage({ action: 'logLine', base: SLOG_BASE, cf: SLOG_CF, msg }, () => { void chrome.runtime.lastError; });
        } catch (e) { /* noop */ }
    }

    // Come slog(), ma azzera prima i log della sync (sync_ordine.log,
    // pda_stato.log, pda_elenco.log): usata una sola volta all'avvio di ogni
    // sincronizzazione, cosi' i log contengono solo la corsa in corso e sono
    // piu' facili da esaminare (invece di accumularsi tra una sync e l'altra).
    function slogReset(...args) {
        const msg = args.map((a) => {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch (e) { return String(a); }
        }).join(' ');
        console.log(LOG, msg);
        try {
            chrome.runtime.sendMessage({ action: 'logLine', base: SLOG_BASE, cf: SLOG_CF, msg, reset: true }, () => { void chrome.runtime.lastError; });
        } catch (e) { /* noop */ }
    }

    // ─── Storage / backend ───────────────────────────────────────────────────
    function storageGet(keys) {
        return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
    }

    /** Chiede al background di portare la finestra di sync brevemente a fuoco
     *  (rompe il throttling di Chrome sui timer delle finestre minimizzate, che
     *  blocca l'autocomplete Angular del PdA) e poi la re-minimizza. */
    function wakeWindow(ms) {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage({ action: 'orderSyncWake', ms: ms || 1200 }, (resp) => {
                    void chrome.runtime.lastError;
                    resolve(resp && resp.woke);
                });
            } catch (e) { resolve(false); }
        });
    }

    /** Porta la finestra a fuoco e la MANTIENE sveglia (niente re-minimize
     *  automatico): da usare intorno alle operazioni critiche (selezione ufficio,
     *  click Ricerca + lettura risultati), poi chiamare minimizeWindow(). */
    function focusWindow() {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage({ action: 'orderSyncFocus' }, (resp) => {
                    void chrome.runtime.lastError;
                    resolve(resp && resp.focused);
                });
            } catch (e) { resolve(false); }
        });
    }

    /** Re-minimizza (nasconde) la finestra di sync. */
    function minimizeWindow() {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage({ action: 'orderSyncMinimize' }, (resp) => {
                    void chrome.runtime.lastError;
                    resolve(resp && resp.minimized);
                });
            } catch (e) { resolve(false); }
        });
    }

    function backendPost(url, apiToken, cfAvvocato, payload) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage(
                { action: 'syncToBackend', backendUrl: url, apiToken, cfAvvocato, data: payload },
                (resp) => {
                    if (chrome.runtime.lastError) {
                        resolve({ error: chrome.runtime.lastError.message });
                    } else {
                        resolve(resp || { error: 'nessuna risposta dal background' });
                    }
                }
            );
        });
    }

    function ordineBackendUrl(backendUrl) {
        if (!backendUrl) return 'http://localhost/pct/api_sync_ordine.php';
        if (backendUrl.includes('api_sync_ordine.php')) return backendUrl;
        if (backendUrl.includes('api_sync.php')) {
            return backendUrl.replace('api_sync.php', 'api_sync_ordine.php');
        }
        return backendUrl.replace(/\/+$/, '') + '/api_sync_ordine.php';
    }

    // ─── Banner di avanzamento sulla pagina ──────────────────────────────────
    const banner = { root: null, testo: null, barra: null, log: null };

    function ensureBanner() {
        if (banner.root) return;
        const root = document.createElement('div');
        root.id = 'pct-sync-ordine-banner';
        root.style.cssText = [
            'position:fixed', 'top:16px', 'right:16px', 'z-index:999999',
            'width:340px', 'max-width:90vw', 'background:#1a3a5c', 'color:#fff',
            'border-radius:8px', 'padding:14px 16px', 'font-family:Segoe UI,Arial,sans-serif',
            'font-size:13px', 'box-shadow:0 6px 24px rgba(0,0,0,.35)',
        ].join(';');
        root.innerHTML = `
            <div style="font-weight:700;margin-bottom:6px;">PCT — Sync fascicoli del mio Ordine</div>
            <div data-role="testo" style="margin-bottom:8px;line-height:1.4;">Avvio...</div>
            <div style="background:rgba(255,255,255,.2);border-radius:4px;height:8px;overflow:hidden;margin-bottom:8px;">
                <div data-role="barra" style="background:#4caf50;height:100%;width:0%;transition:width .3s;"></div>
            </div>
            <div data-role="log" style="font-size:11px;opacity:.85;max-height:110px;overflow-y:auto;line-height:1.5;"></div>
        `;
        document.documentElement.appendChild(root);
        banner.root = root;
        banner.testo = root.querySelector('[data-role=testo]');
        banner.barra = root.querySelector('[data-role=barra]');
        banner.log = root.querySelector('[data-role=log]');
    }

    function bannerTesto(msg) {
        ensureBanner();
        banner.testo.textContent = msg;
    }

    function bannerLog(msg) {
        ensureBanner();
        const riga = document.createElement('div');
        riga.textContent = msg;
        banner.log.appendChild(riga);
        while (banner.log.childNodes.length > 30) banner.log.removeChild(banner.log.firstChild);
        banner.log.scrollTop = banner.log.scrollHeight;
    }

    function bannerProgresso(fatti, tot) {
        ensureBanner();
        const pct = tot > 0 ? Math.min(100, Math.round((fatti / tot) * 100)) : 0;
        banner.barra.style.width = pct + '%';
    }

    // ─── Helper DOM per il form Ricerca Avanzata ─────────────────────────────
    function visible(el) {
        return !!(el && el.offsetParent !== null);
    }

    const STOP_WORDS = ['ex', 'sd', 'di', 'del', 'della', 'dei', 'the', 'e'];

    function tokenScore(optText, target, codice) {
        const t = norm(optText);
        if (!t) return 0;
        if (codice && t.includes(codice)) return 100;
        const tokens = norm(target).split(' ')
            .filter((w) => w.length > 2 && !STOP_WORDS.includes(w));
        if (!tokens.length) return 0;
        let hit = 0;
        for (const w of tokens) {
            if (t.includes(w)) hit++;
        }
        return hit / tokens.length;
    }

    function setNativeSelectValue(sel, value) {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, value);
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /**
     * Cerca un <select> nativo che contenga un'opzione che soddisfa lo scorer
     * e la seleziona. Ritorna il testo dell'opzione scelta o null.
     */
    function pickNativeSelect(scorer) {
        for (const sel of document.querySelectorAll('select')) {
            if (!visible(sel)) continue;
            let best = null;
            let bestScore = 0;
            for (const opt of sel.options) {
                if (!opt.value && opt.value !== 0) continue;
                const score = scorer(norm(opt.textContent), opt);
                if (score > bestScore) {
                    bestScore = score;
                    best = opt;
                }
            }
            if (best && bestScore >= 0.5) {
                if (sel.value !== best.value) {
                    setNativeSelectValue(sel, best.value);
                }
                return { el: sel, text: norm(best.textContent), score: bestScore };
            }
        }
        return null;
    }

    /**
     * Componenti dropdown non-nativi (Material/PrimeNG): clicca il trigger,
     * attende il pannello delle opzioni e clicca la migliore.
     */
    async function pickPanelOption(scorer, triggerEl) {
        if (triggerEl) {
            triggerEl.click();
            await sleep(600);
        }
        const options = opzioniPannelloVisibili();
        if (!options.length) return null;
        let best = null;
        let bestScore = 0;
        for (const opt of options) {
            const score = scorer(norm(opt.textContent), null);
            if (score > bestScore) {
                bestScore = score;
                best = opt;
            }
        }
        if (best && bestScore >= 0.5) {
            const testo = norm(best.textContent);
            best.click();
            await sleep(400);
            return { text: testo, score: bestScore };
        }
        // chiudi il pannello se nessuna opzione utile
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return null;
    }

    function setInputValue(input, value) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        // Alcuni autocomplete Angular reagiscono anche ai keydown/keyup:
        // simuliamo l'ultimo tasto digitato per innescare la ricerca.
        const lastChar = value ? value.slice(-1) : '';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: lastChar, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: lastChar, bubbles: true }));
    }

    /**
     * Attiva la scheda (tab) corrispondente al registro: "Civile/Lavoro",
     * "Esecuzioni e fallimenti", "Giudici di Pace". La scheda filtra sia gli
     * uffici dell'autocomplete sia i registri disponibili: senza questo passo
     * gli uffici del tipo sbagliato non compaiono.
     */
    async function selectTab(nomeTab) {
        if (!nomeTab) { slog('    scheda: non richiesta'); return true; }
        const target = norm(nomeTab);
        // Esclude il banner overlay (contiene i nomi delle schede nel proprio log).
        const inBanner = (el) => banner.root && banner.root.contains(el);

        // Verifica se una scheda con quel testo risulta gia' attiva.
        const isActiveTab = () => {
            const attivi = [...document.querySelectorAll(
                '[role="tab"][aria-selected="true"], .nav-link.active, .nav-tabs .active, li.active, .active > a, .mat-tab-label-active')]
                .filter(visible);
            return attivi.some((el) => {
                const t = norm(el.textContent);
                if (!t || t.length > 40) return false;
                if (t === target || t.includes(target)) return true;
                // Vietato il match su frammenti corti ("giudice" per "Giudici di
                // Pace"): darebbe per attiva una scheda che non lo e'.
                return target.includes(t) && t.length >= Math.ceil(target.length * 0.7);
            });
        };
        if (isActiveTab()) { slog('    ✓ scheda gia attiva:', nomeTab); return true; }

        // Dump diagnostico una-tantum: elenca gli header di scheda con classe e
        // stato, per capire come il PdA marca la scheda attiva.
        if (!dumpTabFatto) {
            dumpTabFatto = true;
            const hdr = [...document.querySelectorAll('[role="tab"], .nav-link, .nav-tabs a, .nav-tabs li, ul.nav li a, .tab-item, a')]
                .filter((el) => visible(el) && !inBanner(el))
                .filter((el) => { const t = norm(el.textContent); return t && t.length <= 40 && /civile|esecuzioni|giudici|cassazione/.test(t); })
                .slice(0, 12)
                .map((el) => norm(el.textContent) + ' [' + el.tagName + '.' + (el.className || '') + (el.getAttribute('aria-selected') ? ' aria-selected=' + el.getAttribute('aria-selected') : '') + ']');
            slog('    [DUMP tabs] ' + hdr.join('  |  '));
        }

        // Cerca l'header di scheda cliccabile, ESCLUDENDO il banner overlay
        // (che contiene i nomi delle schede nel proprio log e verrebbe cliccato
        // per errore, riportando un falso successo).
        // Priorita' ai selettori tipici degli header di scheda; poi fallback.
        const selTab = '[role="tab"], .mat-tab-label, .nav-link, .nav-tabs a, .nav-tabs li, ul.nav li a, .tab-item';
        const selFallback = 'a, button, li, span';
        const pick = (selettore, richiediEsatto) => {
            const cands = [...document.querySelectorAll(selettore)].filter((el) => visible(el) && !inBanner(el));
            for (const el of cands) {
                const t = norm(el.textContent);
                if (!t || t.length > 40) continue;
                if (richiediEsatto) {
                    if (t === target) return el;
                    continue;
                }
                // Match generoso, ma non troppo: un elemento con testo "giudice"
                // non deve valere per la scheda "Giudici di Pace" (era proprio
                // cosi' che veniva cliccata la voce sbagliata del menu).
                if (t.includes(target)) return el;
                if (target.includes(t) && t.length >= Math.ceil(target.length * 0.7)) return el;
            }
            return null;
        };
        let best = pick(selTab, true) || pick(selTab, false) || pick(selFallback, true) || pick(selFallback, false);
        if (!best) { slog('    ✗ scheda NON trovata:', nomeTab); return false; }
        best.click();
        // Attende che la scheda diventi effettivamente attiva (max ~3s).
        const ok = await waitFor(() => isActiveTab(), { timeout: 3000, interval: 200 });
        if (!ok) {
            slog('    ✗ scheda cliccata ma NON attivata:', nomeTab, '| testo elemento:', norm(best.textContent));
            return false;
        }
        await sleep(600); // attende il rendering del form della scheda
        slog('    ✓ scheda attivata:', nomeTab);
        return true;
    }

    /** Termini da digitare nel campo Ufficio, dal piu' preciso al piu' generico. */
    function terminiRicercaUfficio(ufficio) {
        // Il primo termine e' il nome esatto come sta a database: e' l'unico che
        // identifica un ufficio senza ambiguita'. Digitare la scorciatoia
        // ("spezia") faceva tornare due voci molto simili — "Tribunale di La
        // Spezia ex SD Sarzana" e "Tribunale Ordinario - La Spezia" — e su
        // alcuni giri l'autocomplete rispondeva a vuoto lasciando il campo con
        // la sola parola digitata: da qui il "Non e' stato possibile recuperare
        // le informazioni richieste" e i 37 errori del giro precedente.
        // I termini brevi restano dietro, come ripiego se il nome intero non
        // produce nessuna proposta.
        const nome = norm(ufficio.nome || '');
        const daDb = norm(ufficio.termine_ricerca || '');
        const RIMUOVI = ['tribunale', 'ordinario', 'giudice', 'pace', 'sezione', 'distaccata',
            'ex', 'sd', 'giud', 'di', 'del', 'della', 'dei', 'e', 'ms', '(ms)'];
        const tokens = nome
            .replace(/[().\-]/g, ' ')
            .split(/\s+/)
            .map((w) => w.trim())
            .filter((w) => w.length > 2 && !RIMUOVI.includes(w));
        const uniq = [];
        if (nome) uniq.push(nome);
        if (daDb && !uniq.includes(daDb)) uniq.push(daDb);
        for (const t of tokens) if (!uniq.includes(t)) uniq.push(t);
        return uniq.length ? uniq : [nome];
    }

    /** Elenca i testi delle opzioni attualmente visibili nel pannello autocomplete.
     *  filtroTesto (opzionale): usato SOLO dal fallback per il componente custom
     *  del PdA (opzioni come <div> senza classi note), per limitare i candidati
     *  agli elementi-foglia il cui testo contiene il termine digitato. */
    function opzioniPannelloVisibili(filtroTesto) {
        const panelSel = '[role="listbox"] [role="option"], .mat-option, .p-dropdown-item, .cdk-overlay-container li, .ui-dropdown-items li, ul.autocomplete-items li, .dropdown-menu li a, .autocomplete-result, .ng-option, ngb-typeahead-window button, [class*="typeahead"] button, [class*="autocomplete"] [class*="item"], [class*="dropdown"] [class*="item"]';
        let els = [...document.querySelectorAll(panelSel)].filter(visible);
        if (els.length) return els;
        // Fallback PdA: le opzioni sono <div> (spesso con prefisso "→") in un
        // overlay senza classi riconoscibili. Cerca elementi-foglia visibili,
        // FUORI dal banner overlay dello scraper, il cui testo contiene il termine.
        const banner = document.getElementById('pct-sync-ordine-banner');
        const needle = filtroTesto ? norm(filtroTesto) : '';
        const cand = [...document.querySelectorAll('div, li, a, button, span')].filter((e) => {
            if (!visible(e)) return false;
            if (banner && banner.contains(e)) return false;
            if (e.querySelector('input, select, textarea, table, form')) return false;
            if (e.children.length > 2) return false;              // deve essere una foglia
            const t = norm(e.textContent);
            if (!t || t.length > 90) return false;
            if (needle && !t.includes(needle)) return false;      // deve contenere il termine
            return true;
        });
        // Dedup per testo mantenendo l'elemento piu' interno (foglia reale).
        const perTesto = new Map();
        for (const e of cand) {
            const t = norm(e.textContent);
            const prev = perTesto.get(t);
            if (!prev || prev.contains(e)) perTesto.set(t, e);
        }
        return [...perTesto.values()];
    }

    // Diagnostica una tantum: quando l'autocomplete non restituisce opzioni,
    // dumpa nel log gli elementi del DOM che contengono il termine digitato,
    // per scoprire il vero contenitore delle opzioni del componente custom.
    let dumpAutocompleteFatto = false;
    let dumpTabFatto = false;
    let dumpFormFatto = false;
    // Codice dell'ufficio attualmente selezionato nel form (per riuso).
    let ufficioSelezionatoCodice = '';
    function dumpAutocompleteDom(trigger, termine) {
        if (dumpAutocompleteFatto) return;
        dumpAutocompleteFatto = true;
        try {
            const ae = document.activeElement;
            slog('    [DUMP] activeElement:', ae ? (ae.tagName + '.' + String(ae.className || '')) : 'null');
            const all = [...document.querySelectorAll('li, a, span, div, td, p, option, [role="option"]')];
            const hits = [];
            for (const el of all) {
                if (el === trigger) continue;
                const t = norm(el.textContent);
                if (t && t.length <= 70 && t.includes(termine) && el.children.length <= 2) {
                    const cls = String(el.className || '').trim().replace(/\s+/g, '.');
                    hits.push(el.tagName.toLowerCase() + (cls ? '.' + cls : '') + ' :: ' + t.slice(0, 55));
                }
            }
            slog('    [DUMP] elementi con "' + termine + '" (' + hits.length + '):', hits.slice(0, 25).join('  |  '));
            const cont = trigger.closest('form') || trigger.parentElement;
            if (cont) {
                const kids = [...cont.querySelectorAll('*')].slice(0, 60).map((e) => {
                    const cls = String(e.className || '').trim().replace(/\s+/g, '.');
                    return e.tagName.toLowerCase() + (cls ? '.' + cls : '');
                });
                slog('    [DUMP] discendenti form (' + kids.length + '):', kids.join(' '));
            }
        } catch (e) {
            slog('    [DUMP] errore:', e && e.message);
        }
    }

    // Naviga alla Ricerca Avanzata tramite routing SPA: il deep-link a pagina
    // piena spesso monta la dashboard, quindi cerchiamo e clicchiamo il link di
    // menu interno che porta ad advanced-search (navigazione client Angular).
    let anchorDumpFatto = false;
    async function vaiAdRicercaAvanzata() {
        const anchors = [...document.querySelectorAll('a[href]')].filter(visible);
        // 1) link diretto ad advanced-search
        let target = anchors.find((a) => (a.getAttribute('href') || '').includes('advanced-search'));
        // 2) fallback per testo del menu ("ricerca avanzata" / "ricerca fascicoli")
        if (!target) {
            target = anchors.find((a) => {
                const t = norm(a.textContent);
                return t && t.length < 40 && (t.includes('ricerca avanzata') || t.includes('ricerca fascicol'));
            });
        }
        if (target) {
            slog('    navigazione SPA verso Ricerca Avanzata via link: "' + norm(target.textContent).slice(0, 40) + '" href=' + (target.getAttribute('href') || ''));
            target.click();
            await sleep(1500);
            return true;
        }
        if (!anchorDumpFatto) {
            anchorDumpFatto = true;
            const dump = anchors.slice(0, 40).map((a) => (norm(a.textContent).slice(0, 25) || '·') + '→' + (a.getAttribute('href') || ''));
            slog('    [DUMP anchor] link visibili (' + anchors.length + '):', dump.join('  |  '));
        }
        return false;
    }

    /** Punteggio type-aware fra un'opzione e l'ufficio target. */
    function scoreUfficioOpzione(optText, ufficio) {
        const t = norm(optText);
        if (!t) return 0;
        // Match diretto sul codice ufficio = certezza
        if (ufficio.codice_ufficio && t.includes(String(ufficio.codice_ufficio).toLowerCase())) return 100;
        let score = tokenScore(t, ufficio.nome, ufficio.codice_ufficio);
        // Coerenza di tipo: Tribunale vs Giudice di Pace
        const isGdp = /giudice\s*di\s*pace|gdp/.test(t);
        const isTrib = /tribunale/.test(t);
        if (ufficio.tipo === 'giudice_pace') {
            if (isGdp) score += 0.4; else if (isTrib) score -= 0.5;
        } else if (ufficio.tipo === 'tribunale') {
            if (isTrib) score += 0.4; else if (isGdp) score -= 0.5;
        }
        // Penalita' per token "extra" significativi presenti nell'opzione ma NON
        // nel nome dell'ufficio target: evita di scegliere "... massa MARITTIMA"
        // (Grosseto) o "... ex ... AULLA" al posto di "Giudice di Pace - Massa".
        const tgtTokens = new Set(norm(ufficio.nome).split(' ')
            .filter((w) => w.length > 3 && !STOP_WORDS.includes(w)));
        const optTokens = t.replace(/[().\-]/g, ' ').split(/\s+/)
            .filter((w) => w.length > 3 && !STOP_WORDS.includes(w)
                && !['giudice', 'pace', 'tribunale', 'ordinario', 'sezione'].includes(w));
        let extra = 0;
        for (const w of optTokens) if (!tgtTokens.has(w)) extra++;
        score -= extra * 0.35;
        return score;
    }

    /**
     * Seleziona l'ufficio nel form. Prova select nativo, poi autocomplete
     * digitando la citta' e registrando le opzioni proposte dal PdA.
     */
    async function selectUfficio(ufficio) {
        const target = ufficio.nome;
        const codice = ufficio.codice_ufficio;

        // 1. Select nativo
        const nativo = pickNativeSelect((t) => tokenScore(t, target, codice));
        if (nativo) {
            slog('    ufficio via SELECT nativo:', nativo.text, 'score', nativo.score.toFixed(2));
            return true;
        }

        // 2. Autocomplete: trova l'input
        const trigger = findUfficioTrigger();
        if (!trigger) {
            slog('    ✗ trigger campo Ufficio NON trovato nel form');
            return false;
        }
        if (trigger.tagName !== 'INPUT') {
            trigger.click();
            await sleep(600);
            const opts = opzioniPannelloVisibili();
            slog('    dropdown non-input, opzioni viste=' + opts.length + ' ::', opts.slice(0, 15).map((o) => norm(o.textContent)).join(' || '));
            const res = await pickPanelOption((t) => scoreUfficioOpzione(t, ufficio), null);
            if (res) { slog('    ufficio via dropdown:', res.text, 'score', res.score.toFixed(2)); return true; }
            return false;
        }

        // 3. Input autocomplete: prova ogni termine (citta') finche' non trova match
        const termini = terminiRicercaUfficio(ufficio);
        slog('    termini di ricerca ufficio:', JSON.stringify(termini));
        // Attende che lo spinner di caricamento del form sparisca: al primo giro
        // il form e' spesso ancora in "ngx-loading" e l'autocomplete non risponde.
        // La finestra e' gia' a fuoco (focusWindow nel chiamante), ma la ri-forziamo
        // per sicurezza cosi' i timer Angular non sono throttlati.
        await focusWindow();
        if (caricamentoAttivo()) {
            slog('    attendo fine caricamento form (spinner attivo)...');
            await attendiFineCaricamento(20000);
        }
        for (const termine of termini) {
            // Ritenta la digitazione piu' volte: la prima chiamata HTTP di ricerca
            // uffici puo' essere lenta; la ri-digitazione colpisce la cache calda.
            let opts = [];
            let testi = [];
            for (let tentativo = 1; tentativo <= 3 && !opts.length; tentativo++) {
                if (caricamentoAttivo()) {
                    await focusWindow();
                    await attendiFineCaricamento(15000);
                }
                try { trigger.focus(); } catch (e) { /* noop */ }
                // Azzera il campo per forzare un nuovo valueChanges (distinctUntilChanged).
                setInputValue(trigger, '');
                await sleep(250);
                try { trigger.focus(); } catch (e) { /* noop */ }
                setInputValue(trigger, termine);
                // Finestra minimizzata = timer throttlati: diamo fino a 15s.
                opts = await waitFor(() => {
                    if (document.activeElement !== trigger) {
                        try { trigger.focus(); } catch (e) { /* noop */ }
                    }
                    const o = opzioniPannelloVisibili(termine);
                    return o.length ? o : null;
                }, { timeout: 15000, interval: 150 }) || [];
                testi = opts.map((o) => norm(o.textContent)).filter(Boolean);
                slog('    digitato "' + termine + '" (tentativo ' + tentativo + ') → opzioni=' + testi.length + ' ::', testi.slice(0, 15).join(' || '));
                if (!opts.length) {
                    dumpAutocompleteDom(trigger, termine);
                    // chiudi il pannello prima di ritentare
                    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                    // Quando il portale scrive "Non e' stato possibile recuperare
                    // le informazioni richieste" e' il suo servizio di ricerca
                    // uffici che ha ceduto, non il nostro click: ritentare subito
                    // lo fa cedere di nuovo, quindi si aspetta qualche secondo.
                    if (/non .{0,3}\s*stato possibile recuperare/i.test(document.body.innerText || '')) {
                        slog('    il portale segnala "informazioni non recuperabili": attendo 3s e ritento');
                        await sleep(3000);
                    } else {
                        await sleep(300);
                    }
                }
            }
            if (!opts.length) { continue; }
            let best = null, bestScore = 0;
            for (const opt of opts) {
                const s = scoreUfficioOpzione(norm(opt.textContent), ufficio);
                if (s > bestScore) { bestScore = s; best = opt; }
            }
            if (best && bestScore >= 0.5) {
                const testo = norm(best.textContent);
                // Sequenza mouse completa: molti autocomplete custom committano la
                // selezione solo su mousedown/mouseup, non su un semplice .click().
                ['mouseover', 'mousedown', 'mouseup', 'click'].forEach((type) => {
                    best.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                });
                await sleep(600);
                // Verifica che il campo mostri l'ufficio pieno (non piu' il solo termine)
                let val = norm(trigger.value || '');
                if (!val.includes(norm(testo).slice(0, 12))) {
                    // Fallback: forza il valore pieno nell'input cosi' la Ricerca usa l'ufficio corretto
                    setInputValue(trigger, best.textContent.trim());
                    await sleep(300);
                    val = norm(trigger.value || '');
                }
                slog('    ✓ ufficio scelto: "' + testo + '" (score ' + bestScore.toFixed(2) + ') per termine "' + termine + '" → campo ora="' + val + '"');
                return true;
            }
            slog('    nessuna opzione >=0.5 per "' + termine + '" (miglior score ' + bestScore.toFixed(2) + ')');
            // chiudi il pannello prima di provare il prossimo termine
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await sleep(200);
        }
        slog('    ✗ ufficio non selezionabile con nessun termine');
        return false;
    }

    /** Trova il controllo (input o trigger dropdown) del campo "Ufficio". */
    function findUfficioTrigger() {
        // input con placeholder/aria-label che cita "ufficio"
        const inputs = [...document.querySelectorAll('input')].filter(visible);
        for (const inp of inputs) {
            const ctx = norm(
                (inp.placeholder || '') + ' ' + (inp.getAttribute('aria-label') || '') + ' ' +
                (inp.closest('label') ? inp.closest('label').textContent : '')
            );
            if (ctx.includes('ufficio')) return inp;
        }
        // trigger con aria-label o testo che cita "ufficio" (mat-select / p-dropdown)
        const triggers = [...document.querySelectorAll('[role="combobox"], mat-select, p-dropdown, .p-dropdown, .mat-select')].filter(visible);
        for (const tr of triggers) {
            const ctx = norm((tr.getAttribute('aria-label') || '') + ' ' + (tr.textContent || '') + ' ' + ancestorLabel(tr));
            if (ctx.includes('ufficio')) return tr;
        }
        // fallback: input vicino a una label "Ufficio" (fino a 3 livelli sopra)
        for (const inp of inputs) {
            let node = inp;
            for (let i = 0; i < 3 && node; i++) {
                node = node.parentElement;
                if (node && norm(node.textContent).includes('ufficio') && node.textContent.length < 400) return inp;
            }
        }
        return null;
    }

    function ancestorLabel(el) {
        let node = el;
        for (let i = 0; i < 3 && node; i++) {
            node = node.parentElement;
            if (!node) break;
            const t = norm(node.textContent);
            if (t.includes('ufficio') && t.length < 300) return t;
        }
        return '';
    }

    /** Il campo "Anno" del form. */
    // Senza anno il portale restituisce quasi nulla, per questo la ricerca va
    // rifatta per l'anno corrente e per i cinque precedenti. Si individua
    // dall'etichetta, non dalla posizione, perche' il form Angular cambia
    // l'ordine dei campi tra una scheda e l'altra.
    function trovaCampoAnno() {
        const etichette = Array.from(document.querySelectorAll('label'));
        for (const l of etichette) {
            if (norm(l.textContent) === 'anno') {
                const riga = l.closest('.form-group') || l.closest('.row') || l.parentElement;
                const inp = riga && riga.querySelector('input');
                if (inp) return inp;
            }
        }
        return null;
    }

    async function setAnno(anno) {
        const campo = trovaCampoAnno();
        if (!campo) {
            slog('    campo Anno non trovato: proseguo senza anno');
            return false;
        }
        setInputValue(campo, String(anno));
        await sleep(120);
        slog('    anno impostato: ' + anno);
        return true;
    }

    /** Seleziona il registro generale (se richiesto). */
    async function selectRegistro(registroGenerale) {
        if (!registroGenerale) { slog('    registro generale: non richiesto'); return true; }
        const target = norm(registroGenerale);
        const nativo = pickNativeSelect((t) => t === target || t.includes(target));
        if (nativo) {
            slog('    registro via SELECT nativo:', nativo.text);
            return true;
        }
        const trigger = findRegistroTrigger();
        if (trigger) {
            if (trigger.tagName === 'INPUT') {
                setInputValue(trigger, registroGenerale);
                await sleep(900);
            } else {
                trigger.click();
                await sleep(600);
            }
            const opts = opzioniPannelloVisibili(registroGenerale);
            slog('    registro "' + registroGenerale + '" → opzioni=' + opts.length + ' ::', opts.slice(0, 15).map((o) => norm(o.textContent)).join(' || '));
            const res = await pickPanelOption((t) => t === target || t.includes(target), null);
            if (res) {
                slog('    ✓ registro scelto:', res.text);
                return true;
            }
        }
        slog('    ✗ registro non trovato nel form:', registroGenerale);
        // Elenca cosa offre davvero il menu: serve per correggere la mappa
        // REGISTRI_PORTALE quando il portale usa un'etichetta diversa da quella
        // salvata a database (es. "Diritto del Lavoro" per il registro "Lavoro").
        const selects = [...document.querySelectorAll('select')].filter(visible);
        selects.slice(0, 4).forEach((s, k) => {
            const voci = [...s.options].map((o) => norm(o.textContent)).filter(Boolean);
            slog('    [DUMP select ' + (k + 1) + '] ' + voci.join(' || '));
        });
        return false;
    }

    function findRegistroTrigger() {
        const inputs = [...document.querySelectorAll('input')].filter(visible);
        for (const inp of inputs) {
            const ctx = norm(
                (inp.placeholder || '') + ' ' + (inp.getAttribute('aria-label') || '') + ' ' +
                ancestorLabel(inp)
            );
            if (ctx.includes('registro')) return inp;
        }
        const triggers = [...document.querySelectorAll('[role="combobox"], mat-select, p-dropdown, .p-dropdown, .mat-select')].filter(visible);
        for (const tr of triggers) {
            const ctx = norm((tr.getAttribute('aria-label') || '') + ' ' + (tr.textContent || '') + ' ' + ancestorLabel(tr));
            if (ctx.includes('registro')) return tr;
        }
        return null;
    }

    /** Imposta "Ruolo Interrogazione: Avvocato". Ritorna true se applicato o gia' attivo. */
    async function setRuoloAvvocato() {
        // 1) SELECT nativo con opzione "Avvocato" (es. campo "Ruolo Interrogazione").
        const selNat = pickNativeSelect((t) => (t === 'avvocato' ? 1 : (t.includes('avvocato') ? 0.7 : 0)));
        if (selNat) {
            log('Ruolo interrogazione: Avvocato (select nativo) =', selNat.text);
            return true;
        }
        // 2) radio nativi
        for (const radio of document.querySelectorAll('input[type=radio]')) {
            const label = radio.closest('label') ||
                document.querySelector('label[for="' + (radio.id || '') + '"]') ||
                radio.parentElement;
            const txt = norm(label ? label.textContent : '');
            if (txt.includes('avvocato')) {
                if (!radio.checked) radio.click();
                log('Ruolo interrogazione: Avvocato (radio)');
                return true;
            }
        }
        // componenti custom: clicca l'elemento con testo esatto "avvocato" nel form
        const cands = [...document.querySelectorAll('label, span, mat-radio-button, .p-radiobutton-label, .mat-radio-label-content')]
            .filter(visible)
            .filter((el) => norm(el.textContent) === 'avvocato');
        if (cands.length) {
            cands[0].click();
            log('Ruolo interrogazione: Avvocato (custom)');
            return true;
        }
        log('ATTENZIONE: radio "Avvocato" non trovato (potrebbe essere già predefinito)');
        return false;
    }

    /** Clicca uno dei pulsanti "Ricerca per" (es. "Ruolo, Materia, Oggetto"). */
    async function clickRicercaPer(etichetta) {
        const t = norm(etichetta);
        const cands = [...document.querySelectorAll('button, a, .btn, [role="tab"], label, span, li')]
            .filter((el) => visible(el) && !(banner.root && banner.root.contains(el)));
        for (const el of cands) {
            const et = norm(el.textContent);
            if (!et || et.length > 40) continue;
            if (et === t || et.includes(t) || t.includes(et)) {
                el.click();
                await sleep(500);
                return true;
            }
        }
        return false;
    }

    /** Dump una-tantum dei campi visibili del form (label + tipo). */
    function dumpFormFields() {
        if (dumpFormFatto) return;
        dumpFormFatto = true;
        try {
            const campi = [...document.querySelectorAll('select, input, [role="combobox"], mat-select')]
                .filter((el) => visible(el) && !(banner.root && banner.root.contains(el)))
                .slice(0, 15)
                .map((el) => {
                    const lbl = norm(ancestorLabel(el) || el.getAttribute('aria-label') || el.placeholder || '');
                    let extra = '';
                    if (el.tagName === 'SELECT') {
                        extra = ' opts=' + [...el.options].slice(0, 8).map((o) => norm(o.textContent)).filter(Boolean).join('/');
                    }
                    return (lbl || '?') + ' [' + el.tagName + (el.type ? ':' + el.type : '') + ']' + extra;
                });
            slog('    [DUMP form] ' + campi.join('  |  '));
        } catch (e) { /* noop */ }
    }

    /**
     * Assicura che il filtro "Ruolo Interrogazione: Avvocato" sia impostato.
     * Nella scheda Giudici di Pace il campo non compare nella sotto-modalita'
     * "Tipo Numero": in quel caso passa a "Ruolo, Materia, Oggetto" e riprova.
     */
    async function ensureFiltroAvvocato() {
        if (await setRuoloAvvocato()) return true;
        slog('    filtro Avvocato assente: passo alla sotto-modalita "Ruolo, Materia, Oggetto"');
        const ok = await clickRicercaPer('ruolo materia oggetto') ||
            await clickRicercaPer('ruolo, materia') ||
            await clickRicercaPer('ruolo');
        if (!ok) {
            slog('    ✗ sotto-modalita "Ruolo, Materia, Oggetto" non trovata');
            dumpFormFields();
            return false;
        }
        await sleep(700);
        // Il cambio sotto-modalita' avvia il caricamento dei dropdown
        // Ruolo/Materia/Oggetto (spinner ngx-loading a tutto form): finche' e'
        // attivo, il campo Ufficio non risponde. Attendo che si spenga davvero.
        if (caricamentoAttivo()) {
            slog('    attendo caricamento dropdown Ruolo/Materia/Oggetto...');
            await attendiFineCaricamento(45000);
        }
        dumpFormFields();
        return await setRuoloAvvocato();
    }

    /** Trova e clicca il pulsante "Ricerca". Usa una sequenza di eventi
     *  realistici (pointer/mouse + click) perche' un semplice .click() a volte
     *  non viene raccolto dai binding Angular. Ritorna true se ha cliccato. */
    async function clickRealistico(el) {
        try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* noop */ }
        try { el.focus({ preventScroll: true }); } catch (e) { /* noop */ }
        const r = el.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2);
        const cy = Math.round(r.top + r.height / 2);
        const opt = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
        const seq = ['pointerover', 'pointerenter', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        for (const tipo of seq) {
            let ev;
            try {
                ev = tipo.startsWith('pointer')
                    ? new PointerEvent(tipo, opt)
                    : new MouseEvent(tipo, opt);
            } catch (e) {
                ev = new MouseEvent(tipo.startsWith('pointer') ? 'mouse' + tipo.slice(7) : tipo, opt);
            }
            el.dispatchEvent(ev);
        }
        // Fallback aggiuntivo: alcuni handler ascoltano solo .click() nativo.
        try { el.click(); } catch (e) { /* noop */ }
    }

    async function clickRicerca() {
        const btns = [...document.querySelectorAll('button, a, input[type=submit], input[type=button]')].filter(visible);
        let target = null;
        for (const b of btns) {
            const t = norm(b.textContent || b.value || '');
            if (t === 'ricerca' || t === 'cerca' || t === 'avvia ricerca') { target = b; break; }
        }
        if (!target) {
            for (const b of btns) {
                const t = norm(b.textContent || b.value || '');
                if (t.startsWith('ricerca') && !t.includes('avanzata')) { target = b; break; }
            }
        }
        if (!target) {
            slog('    ✗ pulsante "Ricerca" non trovato tra ' + btns.length + ' bottoni visibili');
            return false;
        }
        const etichetta = norm(target.textContent || target.value || '');
        const disab = target.disabled || target.getAttribute('aria-disabled') === 'true'
            || /disabled/.test(target.className || '');
        slog('    → clicco pulsante "' + etichetta + '"' + (disab ? ' (ATTENZIONE: sembra disabilitato)' : ''));
        await clickRealistico(target);
        // Fallback: se e' un submit dentro un form, prova anche requestSubmit().
        try {
            const form = target.closest('form');
            if (form && typeof form.requestSubmit === 'function') form.requestSubmit(target);
        } catch (e) { /* noop */ }
        return true;
    }

    // ─── Parsing risultati ───────────────────────────────────────────────────
    const RE_NUMERO = /(\d{4,10})\s*\/\s*(\d{4})/;

    /** Struttura URL dettaglio (vedi content.js parseUrlParams). */
    function parseDettaglioHref(href) {
        const m1 = href.match(/dettaglio-fascicolo\/([^/]+)\/([^/]+)\/([^/]+)\/([A-Za-z][^/]*)\/(\d{4})\/([^/]+)\/([^/]+)\/([^/]+)(?:\/([^/]+))?/);
        const m2 = href.match(/dettaglio-fascicolo\/([^/]+)\/([^/]+)\/([^/]+)\/(\d{4})\/([^/]+)\/([^/]+)\/([^/]+)(?:\/([^/]+))?/);
        if (m1) {
            // In SIECIC il settimo pezzo e' l'idDfa, non il sub-procedimento:
            // usarlo come sub genera un doppione del fascicolo in archivio.
            const eSiecic = String(m1[1] || '').toUpperCase() === 'SIECIC';
            return {
                registro: m1[1], gestore: m1[2], id_ufficio: m1[3], tipo_ruolo: m1[4],
                anno_ruolo: m1[5], numero_ruolo: m1[6],
                sub_procedimento: eSiecic ? '0' : (m1[7] || '0'),
                id_dfa: eSiecic ? (m1[7] || '') : '',
            };
        }
        if (m2) {
            return {
                registro: m2[1], gestore: m2[2], id_ufficio: m2[3], tipo_ruolo: '',
                anno_ruolo: m2[4], numero_ruolo: m2[5], sub_procedimento: m2[6] || '0',
            };
        }
        return null;
    }

    function estraiPartiDaTesto(testo) {
        const parti = [];
        const attore = testo.match(/Attore(?:\s*principale)?\s*:?\s*([^\n]+?)\s*(?=Convenuto|Giudice|Azioni|$)/i);
        if (attore && norm(attore[1])) parti.push({ cognome: attore[1].trim().toUpperCase(), nome: '', tipo: 'AP' });
        const convenuto = testo.match(/Convenuto(?:\s*principale)?\s*:?\s*([^\n]+?)\s*(?=Giudice|Azioni|$)/i);
        if (convenuto && norm(convenuto[1])) parti.push({ cognome: convenuto[1].trim().toUpperCase(), nome: '', tipo: 'CP' });
        return parti;
    }

    function estraiGiudiceDaTesto(testo) {
        const g = testo.match(/Giudice\s*:?\s*([^\n]+?)\s*(?=Azioni|Numero|$)/i);
        return g ? g[1].trim() : '';
    }

    /**
     * Mappa gli indici di colonna della tabella risultati leggendo le
     * intestazioni: "Numero Fascicolo", "Attore principale",
     * "Convenuto principale", "Giudice", "Azioni".
     * Se non trova un'intestazione, l'indice resta -1 (fallback posizionale).
     */
    function mappaColonne(table) {
        const map = { numero: -1, attore: -1, convenuto: -1, giudice: -1, azioni: -1 };
        if (!table) return map;
        let celle = [...table.querySelectorAll('thead th, thead td')];
        if (!celle.length) {
            const primaRiga = table.querySelector('tr');
            celle = primaRiga ? [...primaRiga.children].filter((c) => c.tagName === 'TH' || c.tagName === 'TD') : [];
        }
        celle.forEach((c, idx) => {
            const t = norm(c.textContent);
            if (!t) return;
            if (map.numero < 0 && t.includes('numero') && t.includes('fascicolo')) map.numero = idx;
            else if (map.attore < 0 && t.includes('attore')) map.attore = idx;
            else if (map.convenuto < 0 && t.includes('convenuto')) map.convenuto = idx;
            else if (map.giudice < 0 && t.includes('giudice')) map.giudice = idx;
            else if (map.azioni < 0 && t.includes('azioni')) map.azioni = idx;
        });
        return map;
    }

    /**
     * Estrae numero/attore/convenuto/giudice dalle celle di una riga <tr>.
     * Usa la mappa colonne se disponibile, altrimenti le posizioni standard
     * (0=numero, 1=attore, 2=convenuto, 3=giudice).
     */
    function datiDaRigaTabella(row, colonne) {
        const celle = [...row.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
        const testoCella = (i) => (i >= 0 && i < celle.length ? (celle[i].innerText || '').replace(/\s+/g, ' ').trim() : '');
        // Se sono state riconosciute intestazioni (numero o giudice), la tabella
        // ha uno schema noto: NON inventare attore/convenuto per posizione.
        // Serve a evitare che nella scheda "Esecuzioni e fallimenti" (colonne
        // Numero Fascicolo | Rito | Giudice) il "Rito" finisca come attore.
        const hasHeaders = colonne.numero >= 0 || colonne.giudice >= 0;
        const iNumero  = colonne.numero  >= 0 ? colonne.numero  : 0;
        const iGiudice = colonne.giudice >= 0 ? colonne.giudice : (hasHeaders ? -1 : 3);
        let attore = '';
        let convenuto = '';
        if (colonne.attore >= 0) attore = testoCella(colonne.attore);
        else if (!hasHeaders) attore = testoCella(1);
        if (colonne.convenuto >= 0) convenuto = testoCella(colonne.convenuto);
        else if (!hasHeaders) convenuto = testoCella(2);
        const parti = [];
        if (attore)    parti.push({ cognome: attore.toUpperCase(),    nome: '', tipo: 'AP' });
        if (convenuto) parti.push({ cognome: convenuto.toUpperCase(), nome: '', tipo: 'CP' });
        return { numeroTxt: testoCella(iNumero), giudice: testoCella(iGiudice), parti };
    }

    /**
     * Legge le righe risultato della pagina corrente.
     * Restituisce un array di fascicoli grezzi.
     */
    function parseRisultatiPagina(ufficio, registroCodice) {
        const trovati = [];
        const visti = new Set();

        // Strategia A: link diretti al dettaglio fascicolo (icona "lente" della colonna Azioni)
        const links = [...document.querySelectorAll('a[href*="dettaglio-fascicolo/"]')];
        const mappeColonne = new WeakMap(); // cache mappa colonne per tabella
        for (const a of links) {
            const href = a.getAttribute('href') || '';
            const abs = href.startsWith('http') ? href : ('https://www.giustizia.toscana.it' + (href.startsWith('/') ? '' : '/') + href);
            const dati = parseDettaglioHref(abs);
            if (!dati) continue;
            const key = [dati.registro, dati.gestore, dati.id_ufficio, dati.anno_ruolo, dati.numero_ruolo, dati.sub_procedimento].join('|');
            if (visti.has(key)) continue;
            visti.add(key);

            // Estrazione dalle colonne della riga <tr>:
            // Numero Fascicolo | Attore principale | Convenuto principale | Giudice | Azioni
            const tr = a.closest('tr');
            let giudice = '';
            let parti = [];
            if (tr) {
                const table = tr.closest('table');
                let colonne = mappeColonne.get(table);
                if (!colonne) {
                    colonne = mappaColonne(table);
                    if (table) mappeColonne.set(table, colonne);
                }
                const datiRiga = datiDaRigaTabella(tr, colonne);
                giudice = datiRiga.giudice;
                parti = datiRiga.parti;
            }
            // Fallback: testo etichettato della riga (layout non tabellari)
            if (!parti.length || !giudice) {
                const row = tr || a.closest('li') || a.closest('[class*="row"]') || a.parentElement;
                const testo = row ? row.innerText : '';
                if (!parti.length) parti = estraiPartiDaTesto(testo);
                if (!giudice) giudice = estraiGiudiceDaTesto(testo);
            }

            trovati.push({
                registro: dati.registro,
                gestore: dati.gestore || (ufficio.gestore || ''),
                id_ufficio: dati.id_ufficio || ufficio.codice_ufficio,
                tipo_ruolo: dati.tipo_ruolo || '',
                anno_ruolo: dati.anno_ruolo,
                numero_ruolo: parseInt(dati.numero_ruolo, 10),
                sub_procedimento: (dati.sub_procedimento && dati.sub_procedimento !== 'undefined' && dati.sub_procedimento !== 'null') ? dati.sub_procedimento : '0',
                giudice,
                parti,
                link: abs,
            });
        }
        if (trovati.length) return trovati;

        // Strategia B: blocchi testuali "Numero fascicolo:XXXXXX/ANNO"
        const corpo = document.body.innerText || '';
        const blocchi = corpo.split(/Numero\s*fascicolo\s*:/i);
        for (let i = 1; i < blocchi.length; i++) {
            const blocco = blocchi[i];
            const m = blocco.match(RE_NUMERO);
            if (!m) continue;
            const numero = parseInt(m[1], 10);
            const anno = m[2];
            const key = anno + '|' + numero;
            if (visti.has(key)) continue;
            visti.add(key);
            const registro = registroCodice === 'GDP' ? 'SIGP' : 'SICID';
            trovati.push({
                registro,
                gestore: ufficio.gestore || '',
                id_ufficio: ufficio.codice_ufficio,
                tipo_ruolo: '',
                anno_ruolo: anno,
                numero_ruolo: numero,
                sub_procedimento: '0',
                giudice: estraiGiudiceDaTesto(blocco),
                parti: estraiPartiDaTesto(blocco),
                link: 'https://www.giustizia.toscana.it' + ADV_PATH,
            });
        }
        return trovati;
    }

    // ─── Paginazione ─────────────────────────────────────────────────────────
    // Firma della pagina risultati basata sui link "dettaglio-fascicolo" presenti
    // (o, in fallback, sul testo delle prime righe di tabella). Cambia quando si
    // passa a un'altra pagina, permettendo di rilevare l'avvenuta paginazione.
    function firmaRisultati() {
        const links = [...document.querySelectorAll('a[href*="dettaglio-fascicolo/"]')]
            .map((a) => a.getAttribute('href') || '');
        if (links.length) return links.join('|');
        const righe = [...document.querySelectorAll('table tr')]
            .map((r) => (r.innerText || '').trim())
            .filter(Boolean);
        if (righe.length) return righe.slice(0, 12).join('||');
        return (document.body.innerText || '').slice(0, 300);
    }
    // compat: alcune parti del codice possono ancora chiamare paginaFirma()
    function paginaFirma() { return firmaRisultati(); }

    // Risale all'elemento realmente cliccabile che rappresenta un controllo di
    // paginazione (a/button/li/.page-item) partendo dal nodo con il testo.
    function bersaglioCliccabile(el) {
        return el.closest('a, button, [role="button"], li.page-item, li, .page-link') || el;
    }

    function elementoDisabilitato(el) {
        if (!el) return true;
        const nodo = el.closest('li, a, button') || el;
        const cls = ((nodo.className || '') + ' ' + ((nodo.parentElement && nodo.parentElement.className) || '')).toString();
        return /disabled|p-disabled/i.test(cls) || nodo.hasAttribute('disabled') || nodo.getAttribute('aria-disabled') === 'true';
    }

    // Individua l'area del paginatore: il contenitore che ospita il testo
    // "N risultati" (footer della tabella del PdA) e, al suo interno, i numeri
    // di pagina e i chevron avanti/indietro.
    function trovaAreaPaginatore() {
        const cont = [...document.querySelectorAll('div, span, p, td, footer, section, nav')]
            .filter(visible)
            .find((e) => /\b\d+\s+risultat/i.test(e.textContent || '') && e.querySelectorAll('*').length < 80);
        if (cont) {
            return cont.closest('div, footer, section, nav, table') || cont.parentElement || document;
        }
        // fallback: un contenitore con classi tipiche di paginazione
        const pag = document.querySelector('.pagination, .p-paginator, mat-paginator, [class*="paginat"]');
        return pag || document;
    }

    async function vaiPaginaSuccessiva(paginaCorrente) {
        const prima = firmaRisultati();
        const clicca = async (nodo) => {
            if (!nodo || elementoDisabilitato(nodo)) return false;
            try { nodo.scrollIntoView({ block: 'center' }); } catch (e) {}
            nodo.click();
            return await waitFor(() => firmaRisultati() !== prima, { timeout: 15000, interval: 400 });
        };

        const scope = trovaAreaPaginatore();

        // 1) Paginazione numerata: clicca il numero della pagina successiva.
        const numeri = [...scope.querySelectorAll('a, button, li, span, div')]
            .filter(visible)
            .filter((e) => /^\d{1,3}$/.test((e.textContent || '').trim()))
            // scarta contenitori che a loro volta contengono altri numeri (prendo la foglia)
            .filter((e) => ![...e.children].some((c) => /^\d{1,3}$/.test((c.textContent || '').trim())));

        const numeroDi = (e) => parseInt((e.textContent || '').trim(), 10);

        // Numero target: se conosco la pagina corrente uso corrente+1 (piu' affidabile
        // dei marcatori CSS "attivo"), altrimenti provo a dedurre dalla pagina attiva.
        let target = NaN;
        if (typeof paginaCorrente === 'number' && !isNaN(paginaCorrente)) {
            target = paginaCorrente + 1;
        } else {
            const attivo = numeri.find((e) => {
                const own = (e.className || '') + ' ' + ((e.parentElement && e.parentElement.className) || '');
                return /active|highlight|selected|current|p-highlight/i.test(own) || e.getAttribute('aria-current') === 'true';
            });
            const pagAttiva = attivo ? numeroDi(attivo)
                : (numeri.length ? Math.min(...numeri.map(numeroDi).filter((n) => !isNaN(n))) : NaN);
            if (!isNaN(pagAttiva)) target = pagAttiva + 1;
        }
        if (!isNaN(target)) {
            const prossimo = numeri.find((e) => numeroDi(e) === target);
            if (prossimo && await clicca(bersaglioCliccabile(prossimo))) return true;
        }

        // 2) Chevron "pagina successiva" (›, », icone chevron/angle/arrow-right).
        const chevron = [...scope.querySelectorAll('a, button, li, span, i')]
            .filter(visible)
            .find((e) => {
                const al = (e.getAttribute('aria-label') || e.getAttribute('title') || '').toLowerCase();
                const t = (e.textContent || '').trim();
                const icon = (e.className || '') + ' ' + ([...e.querySelectorAll('i, span, svg')].map((c) => c.className || '').join(' '));
                return /successiv|next/.test(al)
                    || /(^|[^a-z])next([^a-z]|$)|angle-right|chevron-right|caret-right|arrow-right|pi-angle-right|fa-chevron-right|glyphicon-chevron-right/i.test(icon)
                    || t === '\u203a' || t === '\u00bb' || t === '\u25b6' || t === '>';
            });
        if (chevron && await clicca(bersaglioCliccabile(chevron))) return true;

        return false;
    }

    /** Se il PdA mostra la pagina di benvenuto (utente non loggato), clicca
     *  "Login" per avviare l'accesso CNS (PIN in cache -> trasparente). Ritorna
     *  true se ha cliccato (il chiamante deve interrompere: la pagina navighera').
     *  Guardia anti-loop: max 3 click totali per sessione di sync. */
    async function clickLoginSeBenvenuto() {
        // Indizi della pagina di benvenuto: testo "Benvenuti sul" e/o presenza di
        // un pulsante/link "Login" con accanto "Registrazione".
        const corpo = (document.body && document.body.innerText || '');
        const sembraBenvenuto = /benvenut\w+\s+sul|punto di accesso al processo civile telematico/i.test(corpo)
            || /richiesta la registrazione/i.test(corpo);
        // Cerca un elemento cliccabile con testo esattamente "Login"/"Accedi".
        const clic = [...document.querySelectorAll('a, button, input[type="button"], input[type="submit"]')]
            .filter((e) => visible(e))
            .find((e) => {
                const t = norm(e.textContent || e.value || '');
                const href = (e.getAttribute && (e.getAttribute('href') || '')) || '';
                return t === 'login' || t === 'accedi' || /\/login|\/auth|spid|\/sso/i.test(href);
            });
        if (!sembraBenvenuto && !clic) return false;
        if (!clic) return false;

        let click = 0;
        try {
            const r = await storageGet(['pctOrderSyncLoginClicks']);
            click = parseInt(r.pctOrderSyncLoginClicks || 0, 10);
        } catch (e) { /* noop */ }
        if (click >= 3) {
            slog('  pagina benvenuto: gia' + ' cliccato Login ' + click + ' volte, non reinsisto (login manuale necessario?)');
            return false;
        }
        try { chrome.storage.local.set({ pctOrderSyncLoginClicks: click + 1 }); } catch (e) { /* noop */ }
        slog('  pagina benvenuto PdA: clicco "Login" (tentativo ' + (click + 1) + ')');
        try { clic.scrollIntoView({ block: 'center' }); } catch (e) { /* noop */ }
        clic.click();
        return true;
    }

    // Contatori documenti della corsa in corso, condivisi con ogni beacon di
    // progresso: il pannello deve poter distinguere "non sta facendo nulla" da
    // "sta saltando fascicoli gia' completi sul PC". Sono cumulativi sull'intera
    // sincronizzazione, non sul singolo ufficio.
    const docTot = { nuovi: 0, presenti: 0 };
    function docConta(nuovi, presenti) {
        docTot.nuovi += (nuovi | 0);
        docTot.presenti += (presenti | 0);
    }

    async function aggiornaProgresso(ordineUrl, apiToken, cfAvvocato, base, extra = {}) {
        return backendPost(ordineUrl, apiToken, cfAvvocato, {
            azione: 'progresso_set',
            documenti_nuovi: docTot.nuovi,
            documenti_presenti: docTot.presenti,
            ...base,
            ...extra,
        });
    }

    function etichettaFascicolo(f) {
        const numero = String(f.numero_ruolo || '').padStart(8, '0');
        const sub = String(f.sub_procedimento || '');
        return (f.anno_ruolo ? String(f.anno_ruolo) + '/' : '') + numero +
            (sub && sub !== '0' && sub !== 'undefined' && sub !== 'null' ? '/' + sub : '');
    }

    // "Corte" (ufficio) + RGN leggibile per un fascicolo, usato nei messaggi
    // finali mostrati all'utente (es. fascicoli non scaricati per portale
    // occupato): a differenza di etichettaFascicolo() qui il numero di ruolo
    // non ha gli zeri iniziali, come viene mostrato nel resto della UI.
    function corteERgn(nomeUfficio, etichetta) {
        const rgn = etichetta.replace(/\/0+(\d)/, '/$1');
        return (nomeUfficio ? nomeUfficio + ' ' : '') + 'RG ' + rgn;
    }

    // ─── Flusso principale ───────────────────────────────────────────────────
    async function main() {
        // Trigger: hash dedicato oppure flag in storage impostato dalla service
        // worker (fallback nel caso Angular rimuova l'hash durante il boot).
        let trigger = location.hash.includes(TRIGGER_HASH);
        const suAdvanced = (location.pathname || '').indexOf(ADV_PATH) !== -1;

        // Legge il flag pending: la service worker lo imposta all'avvio della sync.
        let pendingTs = 0;
        try {
            const pend = await storageGet(['pctOrderSyncPending']);
            pendingTs = parseInt(pend.pctOrderSyncPending || 0, 10);
        } catch (e) { /* storage non disponibile */ }
        const pendingValido = pendingTs && (Date.now() - pendingTs) < 120000;

        // Config anticipata: serve a slog() anche nel ramo di redirect.
        const cfg = await storageGet(['backendUrl', 'apiToken', 'lastCfAvvocato', 'pctOrderSyncCodici']);
        SLOG_CF = (cfg.lastCfAvvocato || '').toUpperCase();
        SLOG_BASE = String(cfg.backendUrl || 'http://localhost/pct/api_sync.php').replace(/\/[^/]*\.php.*$/, '');

        // Se la sync e' richiesta ma l'app Angular ci ha portato altrove
        // (tipicamente /dashboard al boot), forziamo la navigazione verso
        // /advanced-search. Guardia anti-loop con contatore in storage.
        if (pendingValido && !suAdvanced) {
            // Prima di redirigere: se e' la pagina di benvenuto (non loggato),
            // clicca "Login" (sessione CNS/PIN in cache -> accesso trasparente).
            if (await clickLoginSeBenvenuto()) return;
            let redirects = 0;
            try {
                const r = await storageGet(['pctOrderSyncRedirects']);
                redirects = parseInt(r.pctOrderSyncRedirects || 0, 10);
            } catch (e) { /* noop */ }
            if (redirects < 3) {
                try { chrome.storage.local.set({ pctOrderSyncRedirects: redirects + 1 }); } catch (e) {}
                slog('Redirect verso advanced-search (tentativo ' + (redirects + 1) + ') da ' + location.href);
                window.location.href = 'https://www.giustizia.toscana.it' + ADV_PATH + '#' + TRIGGER_HASH;
            } else {
                slog('Troppi redirect verso advanced-search, interrompo. URL attuale=' + location.href);
            }
            return;
        }

        if (!trigger && suAdvanced && pendingValido) trigger = true;
        if (!trigger) return;

        // Anche su advanced-search la SPA puo' mostrare il benvenuto se la sessione
        // PdA non e' attiva: in tal caso clicca "Login" (CNS/PIN in cache).
        if (await clickLoginSeBenvenuto()) return;


        // Consuma i flag e rimuovi l'hash per evitare ri-avvii su navigazioni interne
        try { chrome.storage.local.remove(['pctOrderSyncPending', 'pctOrderSyncRedirects']); } catch (e) {}
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}

        ensureBanner();
        bannerTesto('Recupero configurazione...');
        log('Avvio sincronizzazione per Ordine —', location.href);

        const apiToken = cfg.apiToken || 'pct_aruba_2026_adb200f9';
        const cfAvvocato = (cfg.lastCfAvvocato || '').toUpperCase();
        SLOG_CF = cfAvvocato;
        slogReset('===== AVVIO SYNC ORDINE =====', location.href, 'CF=' + cfAvvocato);
        if (!cfAvvocato || cfAvvocato.length !== 16) {
            bannerTesto('Codice fiscale non disponibile. Apri prima un fascicolo sul PdA, poi riprova.');
            log('ERRORE: CF non disponibile in storage');
            return;
        }

        // Anti-ripetizione: la sync e' sempre avviata intenzionalmente (pulsante
        // o auto-avvio dopo login) e il backend deduplica, quindi NON blocchiamo
        // con un confirm() nativo (che congela i timer della pagina e lo scraper).
        // Ci limitiamo ad annotarlo nel log.
        const lastKey = 'pct_sync_ordine_last_' + cfAvvocato;
        const last = parseInt(localStorage.getItem(lastKey) || '0', 10);
        const minuti = (Date.now() - last) / 60000;
        if (last && minuti < MINUTI_ANTI_RIPETIZIONE) {
            slog('  (sync precedente ' + Math.round(minuti) + ' min fa: proseguo comunque, dedup lato backend)');
        }
        localStorage.setItem(lastKey, String(Date.now()));

        const ordineUrl = ordineBackendUrl(cfg.backendUrl);

        // ─── Sync incrementale: storico (anni completati + fascicoli visti) ──
        // Flag one-shot "sincronizzazione completa": ignora lo storico e lo
        // rigenera da zero. Impostato dalla dashboard/servizio all'avvio.
        let SYNC_FULL = false;
        try {
            const ff = await storageGet(['pctOrderSyncFull']);
            SYNC_FULL = !!ff.pctOrderSyncFull;
        } catch (e) { /* storage non disponibile */ }
        try { chrome.storage.local.remove(['pctOrderSyncFull']); } catch (e) {}

        // ─── SYNC VELOCE: ripasso dai link gia' salvati (nessuna enumerazione) ──
        // Attivata dal pulsante "Aggiorna (veloce)". Legge i link da tab_fascicoli
        // (azione link_fascicoli) e li ripassa a blocchi: ogni fascicolo passa da
        // chiamataScarico -> scaricaFascicoloPC (elencoAtti + delta via manifest +
        // 8 documenti in parallelo), scaricando SOLO i nuovi atti. Niente form,
        // niente combinazioni ufficio/registro/anno. Token risolto UNA volta e
        // passato fisso al blocco: nessun globale toccato in concorrenza.
        let SYNC_FAST = false;
        try {
            const fq = await storageGet(['pctOrderSyncFast']);
            SYNC_FAST = !!fq.pctOrderSyncFast;
        } catch (e) { /* storage non disponibile */ }
        try { chrome.storage.local.remove(['pctOrderSyncFast']); } catch (e) {}

        // ─── Elenco consegnato dalla RICERCA IN API DIRETTA ─────────────────────
        // Quando la ricerca l'ha fatta il service worker (pda_ricerca.js), qui non
        // c'e' piu' niente da cercare: arriva l'elenco dei fascicoli trovati e si
        // passa direttamente allo scarico documenti, che e' l'unica cosa per cui
        // serve stare dentro la pagina del PdA.
        let PACCO_API = null;
        try {
            const pq = await storageGet(['pctOrderSyncListaDoc']);
            const p = pq.pctOrderSyncListaDoc;
            if (p && Array.isArray(p.lista) && p.lista.length && (Date.now() - (p.ts || 0)) < 30 * 60 * 1000) {
                PACCO_API = p;
                SYNC_FAST = true;
            }
        } catch (e) { /* storage non disponibile */ }
        try { chrome.storage.local.remove(['pctOrderSyncListaDoc']); } catch (e) {}

        if (SYNC_FAST) {
            const codiciFast = Array.isArray(cfg.pctOrderSyncCodici)
                ? cfg.pctOrderSyncCodici.map(String).filter(Boolean) : [];
            slog('===== MODALITA VELOCE (ripasso dai link) =====', 'codici=' + JSON.stringify(codiciFast)
                + (PACCO_API ? ' origine=ricerca API diretta' : ''));
            bannerTesto(PACCO_API
                ? 'Ricerca completata sul portale: scarico i documenti...'
                : 'Aggiornamento veloce: recupero l\'elenco dei fascicoli...');

            let listaFast = [];
            let ordineFast = '', provinciaFast = '', uffMapFast = {};
            if (PACCO_API) {
                listaFast = PACCO_API.lista || [];
                ordineFast = PACCO_API.ordine || '';
                provinciaFast = PACCO_API.provincia || '';
                uffMapFast = PACCO_API.uffici || {};
                slog('ELENCO da ricerca API diretta: ' + listaFast.length + ' fascicoli');
            } else {
                try {
                    const rl = await backendPost(ordineUrl, apiToken, cfAvvocato, { azione: 'link_fascicoli', codici: codiciFast });
                    if (rl && rl.result && rl.result.success) {
                        listaFast = rl.result.fascicoli || [];
                        ordineFast = rl.result.ordine || '';
                        provinciaFast = rl.result.provincia || '';
                        uffMapFast = rl.result.uffici || {};
                    }
                    else slog('link_fascicoli: risposta inattesa ' + JSON.stringify(rl && rl.result ? rl.result : rl).slice(0, 200));
                } catch (e) { slog('link_fascicoli fallito: ' + ((e && e.message) || e)); }
            }
            listaFast = (listaFast || []).filter((f) => f && f.link && f.link.indexOf('/dettaglio-fascicolo/') !== -1);

            if (!listaFast.length) {
                bannerTesto('Nessun fascicolo con link salvato: esegui prima una sincronizzazione completa.');
                slog('SYNC VELOCE: nessun link disponibile');
                await backendPost(ordineUrl, apiToken, cfAvvocato, {
                    azione: 'progresso_set', stato: 'completato', totale: 0, completati: 0,
                    ordine: ordineFast, provincia: provinciaFast,
                    messaggio: 'Sync veloce: nessun fascicolo da aggiornare',
                }).catch(() => {});
                return;
            }

            let tokenFast = await tokenPortale();
            if (!tokenFast) {
                bannerTesto('Sessione PdA non pronta: apri un fascicolo sul PdA e riprova.');
                slog('SYNC VELOCE: token non disponibile');
                return;
            }
            // Ri-risoluzione del token quando scade a meta' run. Prima leggeva
            // solo candidatiToken()[0] e, se non c'era nulla di nuovo, tornava lo
            // STESSO token appena rifiutato: il "rinnovo" era finto e il ripasso
            // ritentava in eterno con un token morto. Ora passa dal rinnovo
            // condiviso, che scarta il token scaduto e in ultima istanza chiede un
            // access nuovo al background (refresh su Keycloak).
            const risolviTokenFresco = async (scaduto) => {
                try { return await tokenPerScarico(scaduto || ''); } catch (e) { return ''; }
            };
            // Quante volte di fila il rinnovo non e' riuscito: due bastano per
            // dire che la sessione del PdA e' finita davvero, e continuare su
            // centinaia di fascicoli produrrebbe solo errori identici.
            let rinnovoFallito = 0;
            let sessioneMorta = false;

            const totFast = listaFast.length;
            // Etichetta dei messaggi: la stessa fase, ma l'utente deve capire se
            // e' un ripasso dai link o la seconda meta' di una sincronizzazione
            // partita dalla ricerca in API diretta.
            const ETICH_FAST = PACCO_API ? 'Sincronizzazione' : 'Aggiornamento veloce';
            // Raggruppa i fascicoli per ufficio (circoscrizione) mantenendo l'ordine.
            // Cosi' l'intestazione mostra "Giudice di Pace di Carrara" e la tabella
            // sotto elenca SOLO i fascicoli di quella circoscrizione mentre e' in
            // lavorazione, non quelli di tutti gli uffici.
            const gruppiFast = [];
            const idxGruppo = {};
            listaFast.forEach((f) => {
                const cod = String(f.ufficio || '');
                if (!(cod in idxGruppo)) {
                    idxGruppo[cod] = gruppiFast.length;
                    gruppiFast.push({ cod: cod, nome: (uffMapFast[cod] || cod || '—'), items: [] });
                }
                gruppiFast[idxGruppo[cod]].items.push(f);
            });
            slog('SYNC VELOCE: ' + totFast + ' fascicoli in ' + gruppiFast.length + ' circoscrizioni, blocchi da ' + RESYNC_PARALLELI);
            let fatti = 0, nuovi = 0, presenti = 0, errori = 0, senzaAtti = 0;
            const tStart = Date.now();
            // Nel ripasso i fascicoli riusciti non finiscono nel log del server
            // (solo gli errori), quindi una corsa sana non lascia traccia e non si
            // capisce se sta andando o e' impantanata. Ogni 25 fascicoli si scrive
            // una riga di ritmo: serve a rispondere "quanto manca" senza misure a
            // mano, e a distinguere "lento" da "bloccato".
            let prossimoRitmo = 25;
            const logRitmo = () => {
                const sec = Math.max(1, Math.round((Date.now() - tStart) / 1000));
                const alMin = (fatti / sec) * 60;
                const restano = Math.max(0, totFast - fatti);
                slog('  ritmo: ' + fatti + '/' + totFast + ' in ' + sec + 's ('
                    + alMin.toFixed(1) + ' al minuto, ' + (sec / fatti).toFixed(1) + 's ciascuno)'
                    + ' — documenti: ' + nuovi + ' nuovi, ' + presenti + ' già sul PC, ' + errori + ' errori'
                    + (senzaAtti ? ' — ' + senzaAtti + ' fascicoli senza atti sul portale (niente da scaricare)' : '')
                    + (restano && alMin > 0 ? ' — restano ' + restano + ' (~' + Math.ceil(restano / alMin) + ' min)' : ''));
            };
            let dim = RESYNC_PARALLELI;
            const primoUff = gruppiFast[0] || { cod: '', nome: '—' };

            // Beacon 'avvio': fissa iniziata_il = NOW() lato server, cosi' il flag
            // "aggiornato ora" (updated_at >= iniziata_il) marca SOLO i fascicoli
            // toccati da QUESTA corsa veloce, non da run precedenti.
            await backendPost(ordineUrl, apiToken, cfAvvocato, {
                azione: 'progresso_set', stato: 'avvio', totale: totFast, completati: 0,
                ordine: ordineFast, provincia: provinciaFast,
                messaggio: 'Avvio ' + ETICH_FAST.toLowerCase() + ': scarico documenti',
            }).catch(() => {});

            await backendPost(ordineUrl, apiToken, cfAvvocato, {
                azione: 'progresso_set', stato: 'in_corso', totale: totFast, completati: 0,
                ordine: ordineFast, provincia: provinciaFast,
                ufficio_corrente: '0/' + totFast + ' fascicoli', registro_corrente: primoUff.nome,
                numero_fascicolo_corrente: 'UFF:' + primoUff.cod,
                messaggio: ETICH_FAST + ': ' + totFast + ' fascicoli',
            }).catch(() => {});

            for (const grp of gruppiFast) {
                if (sessioneMorta) break;
                let idxFast = 0;
                while (idxFast < grp.items.length && !sessioneMorta) {
                    const blocco = grp.items.slice(idxFast, idxFast + dim);
                    idxFast += blocco.length;
                    // Numeri dei fascicoli di questo blocco (mostrati come
                    // "in scansione" nel riquadro "Fascicolo N.").
                    const numeriBlocco = blocco.map((f) => String(f.numero || '')).filter(Boolean).join(', ');
                    await backendPost(ordineUrl, apiToken, cfAvvocato, {
                        azione: 'progresso_set', stato: 'in_corso', totale: totFast, completati: fatti,
                        ordine: ordineFast, provincia: provinciaFast,
                        ufficio_corrente: fatti + '/' + totFast + ' fascicoli', registro_corrente: grp.nome,
                        numero_fascicolo_corrente: 'UFF:' + grp.cod + '#' + numeriBlocco,
                        fascicolo_corrente: fatti, fascicoli_totali_ricerca: totFast,
                        percentuale_fascicolo: totFast ? Math.round((fatti / totFast) * 100) : 0,
                        messaggio: 'Scansione: ' + numeriBlocco,
                    }).catch(() => {});
                    const risultati = await Promise.all(blocco.map(async (f) => {
                        try { return { f, res: await chiamataScarico(null, f, tokenFast) }; }
                        catch (e) { return { f, res: { ok: false, motivo: (e && e.message) || String(e) } }; }
                    }));
                    // Token scaduto per qualcuno? risolvilo UNA volta (fuori dal blocco)
                    // e ritenta solo i falliti-per-token, serialmente.
                    const tokKO = risultati.filter((x) => x.res && !x.res.ok && x.res.riprovabile
                        && /token|401|403|autenticaz|sessione|scadut/i.test(x.res.motivo || ''));
                    if (tokKO.length) {
                        const rinnovato = await risolviTokenFresco(tokenFast);
                        if (rinnovato && rinnovato !== tokenFast) {
                            tokenFast = rinnovato;
                            rinnovoFallito = 0;
                            slog('SYNC VELOCE: token rinnovato, ritento ' + tokKO.length + ' fascicoli');
                            for (const x of tokKO) {
                                try { x.res = await chiamataScarico(null, x.f, tokenFast); } catch (e) { /* mantiene res */ }
                            }
                        } else {
                            // Nessun token nuovo: e' scaduto anche il refresh (vive
                            // ~30 minuti). Ritentare con lo stesso token morto e'
                            // esattamente il ciclo che riempiva il log di errori
                            // uguali senza scaricare niente.
                            rinnovoFallito++;
                            slog('SYNC VELOCE: sessione PdA scaduta, rinnovo non possibile ('
                                + rinnovoFallito + '/2)');
                            if (rinnovoFallito >= 2) sessioneMorta = true;
                        }
                    }
                    let vuoteBlocco = 0;
                    for (const { f, res } of risultati) {
                        fatti++;
                        if (res && res.ok) {
                            nuovi += res.scaricati || 0;
                            presenti += res.presenti || 0;
                            if ((res.documenti || 0) > 0 && !(res.scaricati || 0) && !(res.presenti || 0)) vuoteBlocco++;
                            // Fascicolo senza NESSUN atto esposto dal portale: non
                            // e' un errore e non crea cartella sul PC. Contarlo
                            // evita di leggere "non scarica niente" come un guasto.
                            if (!(res.documenti || 0)) senzaAtti++;
                            bannerLog('⤓ ' + f.etichetta + ' — +' + (res.scaricati || 0) + ' nuovi, ' + (res.presenti || 0) + ' presenti');
                        } else {
                            errori++;
                            bannerLog('✗ ' + f.etichetta + ' — ' + ((res && res.motivo) || 'errore'));
                            slog('    ✗ ' + f.etichetta + ': ' + ((res && res.motivo) || 'errore'));
                        }
                    }
                    bannerProgresso(fatti, totFast);
                    if (fatti >= prossimoRitmo) { logRitmo(); prossimoRitmo = fatti + 25; }
                    await backendPost(ordineUrl, apiToken, cfAvvocato, {
                        azione: 'progresso_set', stato: 'in_corso', totale: totFast, completati: fatti,
                        ordine: ordineFast, provincia: provinciaFast,
                        ufficio_corrente: fatti + '/' + totFast + ' fascicoli', registro_corrente: grp.nome,
                        numero_fascicolo_corrente: 'UFF:' + grp.cod + '#' + numeriBlocco,
                        fascicolo_corrente: fatti, fascicoli_totali_ricerca: totFast,
                        percentuale_fascicolo: totFast ? Math.round((fatti / totFast) * 100) : 0,
                        messaggio: ETICH_FAST + ': ' + fatti + '/' + totFast + ' (+' + nuovi + ' nuovi)',
                    }).catch(() => {});
                    // Sicurezza anti buste-vuote: se un intero blocco parallelo torna a
                    // vuoto (documenti dichiarati ma 0 scaricati e 0 presenti), sospetta
                    // interferenza da concorrenza sulla sessione e passa a seriale.
                    if (dim > 1 && vuoteBlocco >= Math.max(2, Math.ceil(blocco.length / 2))) {
                        dim = 1;
                        slog('SYNC VELOCE: buste vuote in parallelo (' + vuoteBlocco + '/' + blocco.length + ') → passo a seriale (dim=1)');
                        bannerLog('Passo a download seriale per prudenza (buste vuote rilevate).');
                    }
                }
            }

            const secs = Math.round((Date.now() - tStart) / 1000);
            // Sessione del PdA finita a metà corsa: si chiude dicendo cosa fare,
            // invece di macinare i fascicoli restanti raccogliendo lo stesso 401.
            if (sessioneMorta) {
                const avanzo = totFast - fatti;
                const avviso = 'Sessione PdA scaduta: riapri il portale e accedi con la CNS, poi riavvia'
                    + (avanzo > 0 ? ' (restavano ' + avanzo + ' fascicoli)' : '');
                await backendPost(ordineUrl, apiToken, cfAvvocato, {
                    azione: 'progresso_set', stato: 'errore', totale: totFast, completati: fatti,
                    ordine: ordineFast, provincia: provinciaFast,
                    ufficio_corrente: fatti + '/' + totFast + ' fascicoli',
                    messaggio: avviso,
                }).catch(() => {});
                bannerTesto(avviso);
                slog('SYNC VELOCE interrotta: ' + avviso + ' — fatti=' + fatti + '/' + totFast
                    + ' nuovi=' + nuovi + ' in ' + secs + 's');
                return;
            }
            // A fine corsa non lasciare vuoti "In elaborazione" e "Registro":
            // mostra il totale raggiunto e le circoscrizioni ripassate.
            const nomiUff = gruppiFast.map((g) => g.nome).filter(function (n) { return n && n !== '—'; });
            let registroFine = nomiUff.join(', ');
            if (registroFine.length > 60) registroFine = nomiUff.length + ' circoscrizioni';
            // Mantiene il filtro per ufficio ANCHE a corsa finita: la tabella dei
            // risultati deve mostrare solo i fascicoli delle circoscrizioni appena
            // aggiornate, non tutto l'Ordine (che creava confusione). Piu' codici
            // separati da '|' (una sola circoscrizione nel caso tipico).
            const codiciFastFine = gruppiFast.map((g) => g.cod).filter(Boolean);
            await backendPost(ordineUrl, apiToken, cfAvvocato, {
                azione: 'progresso_set', stato: 'completato', totale: totFast, completati: fatti,
                ordine: ordineFast, provincia: provinciaFast,
                ufficio_corrente: fatti + '/' + totFast + ' fascicoli', registro_corrente: registroFine,
                numero_fascicolo_corrente: 'UFF:' + codiciFastFine.join('|'),
                messaggio: ETICH_FAST + ' completata: +' + nuovi + ' documenti su ' + totFast + ' fascicoli (' + secs + 's)'
                    + (errori ? (', ' + errori + ' con errore') : ''),
            }).catch(() => {});
            bannerProgresso(totFast, totFast);
            bannerTesto(ETICH_FAST + ' completata: +' + nuovi + ' nuovi documenti su ' + totFast + ' fascicoli in ' + secs + 's'
                + (errori ? (' (' + errori + ' con errore, riprova più tardi)') : '') + '.');
            slog('SYNC VELOCE completata: fascicoli=' + totFast + ' nuovi=' + nuovi + ' presenti=' + presenti + ' errori=' + errori + ' in ' + secs + 's');
            return;
        }


        const CHIAVE_STORICO_LOCALE = 'pctSyncStorico_' + cfAvvocato;
        const storico = { anni: new Set(), fasc: new Set() };
        // Buffer di cio' che completiamo in QUESTO giro, da persistere a fine sync.
        const storicoNuovo = { anni: new Set(), fasc: new Set() };
        if (!SYNC_FULL) {
            // Fonte primaria: DB (backend). Cache offline: chrome.storage locale.
            try {
                const rs = await backendPost(ordineUrl, apiToken, cfAvvocato, { azione: 'storico_get' });
                if (rs && rs.result && rs.result.success) {
                    (rs.result.anni_completati || []).forEach((k) => storico.anni.add(String(k)));
                    (rs.result.fascicoli_visti || []).forEach((k) => storico.fasc.add(String(k)));
                }
            } catch (e) { slog('  storico_get fallito (proseguo full): ' + ((e && e.message) || e)); }
            try {
                const lc = await storageGet([CHIAVE_STORICO_LOCALE]);
                const loc = lc[CHIAVE_STORICO_LOCALE];
                if (loc && typeof loc === 'object') {
                    (loc.anni || []).forEach((k) => storico.anni.add(String(k)));
                    (loc.fasc || []).forEach((k) => storico.fasc.add(String(k)));
                }
            } catch (e) { /* cache locale assente */ }
        }
        slog('STORICO: ' + (SYNC_FULL ? 'IGNORATO (sync completa)' : ('anni_completati=' + storico.anni.size + ' fascicoli_visti=' + storico.fasc.size)));

        // Chiave (ufficio,registro,anno) per il ramo form; deve combaciare fra
        // scrittura (marcatura) e lettura (skip combinazioni).
        const chiaveAnno = (codUff, regGen, anno) =>
            String(codUff || '') + '|' + String(regGen || '') + '|' + String(anno || '');
        // Chiave fascicolo condivisa dai due rami (API e form) per lo storico.
        const chiaveFascStorico = (f) =>
            [f.registro, f.gestore, f.id_ufficio, f.tipo_ruolo, f.anno_ruolo, f.numero_ruolo, f.sub_procedimento].join('|');

        // Gate sync incrementale — OPZIONE B ("rileva nuovi depositi").
        // Ogni fascicolo enumerato passa comunque da scaricaFascicoloPC: li'
        // il confronto con il manifest _pct_index.json (idDoc) fa il lavoro
        // giusto in modo economico:
        //   • nessun atto nuovo  -> "delta rapido": elencoAtti + lettura manifest,
        //     nessun download (e nessuna ri-elaborazione dei datiAtto);
        //   • atti nuovi          -> scarica SOLO i nuovi;
        //   • cartella cancellata -> manifest assente, ri-scarica tutto.
        // Cosi' i nuovi documenti su un fascicolo gia' noto vengono SEMPRE
        // rilevati. Costo: una chiamata elencoAtti (PdA) per fascicolo, leggera.
        // NB: non usiamo piu' lo skip "gia' visto" dello storico per la fase
        // documenti; lo storico degli ANNI resta valido solo per il ramo form
        // (enumerazione), dove il ramo API elenca comunque tutti gli anni.
        async function filtraDaScaricare(lista, chiaveFn) {
            return lista.slice();
        }

        // Persistenza storico: DB (primario) + cache locale. Chiamata a fine sync.
        async function persistiStorico() {
            try {
                const anni = Array.from(storicoNuovo.anni);
                const fasc = Array.from(storicoNuovo.fasc);
                if (!SYNC_FULL && !anni.length && !fasc.length) return;
                await backendPost(ordineUrl, apiToken, cfAvvocato, {
                    azione: 'storico_merge', anni, fasc, reset: SYNC_FULL,
                });
                // Cache locale = storico noto ∪ nuovo (se full, solo il nuovo).
                const baseA = SYNC_FULL ? [] : Array.from(storico.anni);
                const baseF = SYNC_FULL ? [] : Array.from(storico.fasc);
                const allA = Array.from(new Set(baseA.concat(anni)));
                const allF = Array.from(new Set(baseF.concat(fasc)));
                const obj = {}; obj[CHIAVE_STORICO_LOCALE] = { anni: allA, fasc: allF, ts: Date.now() };
                try { chrome.storage.local.set(obj); } catch (e) {}
                slog('STORICO salvato: +' + anni.length + ' anni, +' + fasc.length + ' fascicoli' + (SYNC_FULL ? ' (reset)' : ''));
            } catch (e) { slog('  storico_merge fallito: ' + ((e && e.message) || e)); }
        }

        // 1. Elenco uffici. Se l'utente ha selezionato uffici specifici nella
        // griglia (pctOrderSyncCodici), li invio: il backend restituisce SOLO
        // quelli. Altrimenti tutta la provincia dell'Ordine.
        bannerTesto('Recupero elenco uffici dell\'Ordine...');
        const codiciSel = Array.isArray(cfg.pctOrderSyncCodici) ? cfg.pctOrderSyncCodici.map(String).filter(Boolean) : [];
        if (codiciSel.length) slog('Selezione uffici dalla griglia: ' + codiciSel.length + ' → ' + JSON.stringify(codiciSel));
        const respElenco = await backendPost(ordineUrl, apiToken, cfAvvocato, { azione: 'elenco_uffici', codici: codiciSel });
        if (!respElenco || respElenco.error || !(respElenco.result && respElenco.result.success)) {
            const msg = (respElenco && (respElenco.error || JSON.stringify(respElenco.result))) || 'errore sconosciuto';
            bannerTesto('Errore recupero uffici: ' + msg);
            log('ERRORE elenco_uffici:', msg);
            slog('ERRORE elenco_uffici: ' + msg);
            await aggiornaProgresso(ordineUrl, apiToken, cfAvvocato, {
                stato: 'errore',
                messaggio: 'Errore nel recupero degli uffici: ' + msg,
            });
            return;
        }
        const elenco = respElenco.result;
        const ufficiDb = elenco.uffici || [];

        // Uffici soppressi/accorpati: nel PdA restano in elenco come "TRIBUNALE
        // DI LA SPEZIA ex SD SARZANA", ma i fascicoli veri stanno sull'ufficio
        // attuale. Interrogarli fa solo perdere tempo, quindi si escludono.
        const ufficioSoppresso = (u) => /\bex\s+(sd|sez|sezione)\b|\bex\s+s\.?d\.?/i.test(String(u.nome || ''));
        // Ordine di lavorazione: prima i tribunali, poi i giudici di pace, poi il
        // resto; a pari merito conta il nome, cosi' i giri sono sempre uguali.
        const pesoUfficio = (u) => {
            const t = norm(u.tipo || '');
            const n = norm(u.nome || '');
            if (t === 'tribunale' || n.indexOf('tribunale') === 0) return 0;
            if (t.indexOf('pace') !== -1 || n.indexOf('giudice di pace') !== -1) return 1;
            return 2;
        };
        const uffici = ufficiDb
            .filter((u) => {
                if (!ufficioSoppresso(u)) return true;
                slog('  ufficio ESCLUSO (soppresso/ex sezione distaccata): ' + u.codice_ufficio + ' | ' + u.nome);
                return false;
            })
            .sort((a, b) => (pesoUfficio(a) - pesoUfficio(b)) || norm(a.nome || '').localeCompare(norm(b.nome || '')));

        log('Ordine:', elenco.ordine, '— provincia:', elenco.provincia || '?', '—', uffici.length, 'uffici');
        slog('Ordine=' + (elenco.ordine || '?'), 'provincia=' + (elenco.provincia || '?'),
            'uffici=' + uffici.length + (ufficiDb.length !== uffici.length ? ' (su ' + ufficiDb.length + ', esclusi i soppressi)' : ''));
        uffici.forEach((u) => slog('  ufficio DB:', u.codice_ufficio, '|', u.nome, '| tipo=' + u.tipo, '| registro="' + (u.registro || '') + '"', '| registri=' + JSON.stringify((u.registri || []).map((r) => r.nome))));

        if (!uffici.length) {
            const dett = ufficiDb.length
                ? ' (i ' + ufficiDb.length + ' uffici trovati risultano soppressi/accorpati)'
                : (codiciSel.length ? ' per la selezione richiesta (codici ' + JSON.stringify(codiciSel) + ')' : '');
            const m = 'Nessun ufficio da sincronizzare per l\'Ordine ' + (elenco.ordine || '') + dett + '.';
            bannerTesto(m + ' Contattare l\'amministratore.');
            slog('CHIUSURA: ' + m);
            await aggiornaProgresso(ordineUrl, apiToken, cfAvvocato, {
                stato: 'completato',
                ordine: elenco.ordine || '',
                provincia: elenco.provincia || '',
                uffici_totali: 0,
                uffici_fatti: 0,
                fascicoli_trovati: 0,
                fascicoli_salvati: 0,
                errori: 0,
                messaggio: m,
            });
            return;
        }

        // Combinazioni ufficio x registro x anno.
        //
        // Il backend manda una riga per ogni coppia ufficio+registro, con il
        // registro come stringa (la colonna tab_uffici_giudiziari.registro).
        // Qui invece si cercava solo un elenco "registri" che non esiste piu':
        // il risultato era una ricerca senza registro e senza anno, cioe' il
        // portale interrogato a vuoto, che rispondeva 0 o 1 fascicolo.
        //
        // L'anno e' obbligatorio nei fatti: la ricerca va ripetuta per l'anno
        // corrente e per i cinque precedenti, altrimenti i fascicoli piu'
        // vecchi non compaiono affatto.
        const combinazioni = [];
        const annoOggi = new Date().getFullYear();
        const anni = [];
        for (let a = annoOggi; a >= annoOggi - ANNI_INDIETRO; a--) anni.push(a);
        for (const u of uffici) {
            let registri = (u.registri && u.registri.length) ? u.registri : [];
            if (!registri.length && u.registro) {
                const mappa = REGISTRI_PORTALE[String(u.registro).trim().toLowerCase()];
                registri = [mappa || {
                    codice: '',
                    nome: String(u.registro),
                    registro_generale: String(u.registro),
                }];
            }
            if (!registri.length) registri = [{ codice: '', nome: '', registro_generale: '' }];
            for (const r of registri) {
                for (const anno of anni) {
                    // Sync incrementale: salta gli anni gia' completati per questo
                    // (ufficio,registro), TRANNE l'anno corrente (sempre riscansionato).
                    const ak = chiaveAnno(u.codice_ufficio, (r.registro_generale || r.nome || ''), anno);
                    if (!SYNC_FULL && anno !== annoOggi && storico.anni.has(ak)) continue;
                    combinazioni.push({ ufficio: u, registro: r, anno, annoKey: ak });
                }
            }
        }
        log('Combinazioni ufficio/registro/anno da catturare:', combinazioni.length,
            '(' + uffici.length + ' righe ufficio x ' + anni.length + ' anni: ' + anni[anni.length - 1] + '-' + anni[0] + ')');
        slog('  combinazioni=' + combinazioni.length + ' anni=' + JSON.stringify(anni));

        // Stato iniziale. Il totale mostrato e' il numero di uffici distinti,
        // non le combinazioni del form: la strada normale e' quella rapida, e
        // vedere "0 / 42" faceva sembrare in corso il giro lento.
        const ufficiDistinti = new Set(uffici.map((u) => String(u.codice_ufficio || u.codice || ''))).size;
        await backendPost(ordineUrl, apiToken, cfAvvocato, {
            azione: 'progresso_set',
            stato: 'in_corso',
            ordine: elenco.ordine || '',
            provincia: elenco.ordine ? elenco.provincia || '' : '',
            uffici_totali: ufficiDistinti || combinazioni.length,
            uffici_fatti: 0,
            fascicoli_trovati: 0,
            fascicoli_salvati: 0,
            errori: 0,
            messaggio: 'Sincronizzazione avviata',
        });

        // ─── VIA RAPIDA: interrogazione diretta dell'API del portale ──────────
        //
        // Il form di Ricerca Avanzata chiama due endpoint REST: li chiamiamo noi.
        // Una sola richiesta per ufficio+registro, SENZA il campo Anno, riporta
        // i fascicoli di tutti gli anni (anche 2009). Cosi' le 78 combinazioni
        // ufficio x registro x anno diventano ~13 chiamate HTTP, senza
        // autocomplete, cambi di scheda, click e attese di rendering.
        // Se il token non c'e' o il portale non collabora, si prosegue col
        // percorso classico sul form, che resta invariato piu' sotto.
        const viaApi = { ok: false, chiamate: 0, riuscite: 0, trovati: 0, salvati: 0, errori: 0, ultimoErrore: '', docScaricati: 0, docPresenti: 0, docFalliti: 0, docErrori: 0, docBloccati: 0, fascicoliBloccati: [] };
        // Uffici che la via rapida non ha potuto trattare: per quelli si torna al
        // form, invece di lasciarli fuori dalla sincronizzazione.
        const ufficiScoperti = new Set();
        try {
            const perUfficio = new Map();
            for (const u of uffici) {
                const k = String(u.codice_ufficio || '');
                if (!k) continue;
                if (!perUfficio.has(k)) perUfficio.set(k, { ufficio: u, voci: [], dalCatalogo: false });
                const v = perUfficio.get(k);
                const mappa = REGISTRI_PORTALE[norm(u.registro || '')];
                // Il nome da mostrare e' quello scritto nel database
                // (tab_uffici_giudiziari.registro), non il codice del portale.
                const nomeDb = String(u.registro || '').trim() || (mappa ? mappa.nome : '');
                if (mappa && mappa.cod_api) {
                    if (!v.voci.some((x) => x.app === mappa.app && x.cod === mappa.cod_api)) {
                        v.voci.push({ app: mappa.app, cod: mappa.cod_api, desc: nomeDb || mappa.nome });
                    }
                } else {
                    // Registro non traducibile (es. "Giudice di Pace"): l'elenco
                    // lo chiediamo al catalogo uffici del portale.
                    v.dalCatalogo = true;
                    if (nomeDb) v.nomeAltro = nomeDb;
                }
            }
            slog('VIA API: uffici distinti=' + perUfficio.size + ' (dalle ' + uffici.length + ' righe DB)');
            viaApi.uffici = perUfficio.size;
            bannerTesto('Interrogazione diretta del portale...');

            const chiaviViste = new Set();
            const chiaveFasc = (f) => [f.registro, f.gestore, f.id_ufficio, f.tipo_ruolo, f.anno_ruolo, f.numero_ruolo, f.sub_procedimento].join('|');
            let indiceUff = 0;

            for (const [cod, v] of perUfficio) {
                indiceUff++;
                bannerTesto('Ufficio ' + indiceUff + '/' + perUfficio.size + ': ' + v.ufficio.nome);
                bannerProgresso(indiceUff - 1, perUfficio.size);
                slog('--- VIA API [' + indiceUff + '/' + perUfficio.size + '] ' + cod + ' "' + v.ufficio.nome + '"');

                // Il distretto sta gia' nel database (tab_uffici_giudiziari.gestore):
                // si interroga il catalogo del portale solo se manca, o se servono
                // i registri che il DB non sa tradurre (es. Giudice di Pace).
                const distrettoDb = String(v.ufficio.gestore || '').toUpperCase();
                let voci = v.voci.slice();
                let cat = null;
                if (!distrettoDb || v.dalCatalogo || !voci.length) {
                    cat = await catalogoUfficio(cod);
                }
                const distretto = distrettoDb || (cat && cat.distretto) || '';
                if (!distretto) {
                    ufficiScoperti.add(cod);
                    viaApi.ultimoErrore = 'distretto sconosciuto per ' + v.ufficio.nome;
                    slog('    ✗ ' + viaApi.ultimoErrore + ' → lo lascio al form');
                    continue;
                }
                slog('    distretto=' + distretto + (distrettoDb ? ' (dal database)' : ' (dal catalogo del portale)'));
                if (cat && cat.registri.length && (v.dalCatalogo || !voci.length)) {
                    for (const r of cat.registri) {
                        if (!voci.some((x) => x.app === r.app && x.cod === r.cod)) voci.push(r);
                    }
                }
                if (!voci.length && v.dalCatalogo) {
                    // Giudice di Pace senza catalogo: si tentano i codici plausibili
                    // dell'area SIGP, il portale scarta da se' quelli sbagliati.
                    voci = REGISTRI_GDP.map((r) => ({ app: r.app, cod: r.cod, desc: v.nomeAltro || r.desc }));
                    slog('    registri non noti: tento i codici del Giudice di Pace');
                }
                if (!voci.length) {
                    ufficiScoperti.add(cod);
                    viaApi.ultimoErrore = 'nessun registro noto per ' + v.ufficio.nome;
                    slog('    ✗ ' + viaApi.ultimoErrore + ' → lo lascio al form');
                    continue;
                }
                slog('    registri da interrogare: ' + JSON.stringify(voci.map((x) => x.app + ':' + x.cod)));

                const daSalvare = [];
                let riusciteUff = 0;
                let erroriUff = 0;
                let ultimoRegistro = '';
                // Codice del portale → nome del registro come sta nel database:
                // serve a mostrare "Contenzioso Civile" invece di "CC".
                const nomiRegistro = new Map();
                for (const x of voci) if (x.cod) nomiRegistro.set(x.cod, x.desc || x.cod);
                const registroDiFascicolo = (f) => nomiRegistro.get(f.tipo_ruolo)
                    || (f.registro === 'SIGP' ? (v.nomeAltro || 'Giudice di Pace') : '')
                    || String(f.tipo_ruolo || '');
                for (const voce of voci) {
                    viaApi.chiamate++;
                    ultimoRegistro = voce.desc || voce.cod;
                    await aggiornaProgresso(ordineUrl, apiToken, cfAvvocato, {
                        stato: 'in_corso',
                        ordine: elenco.ordine || '',
                        provincia: elenco.provincia || '',
                        ufficio_corrente: v.ufficio.nome,
                        registro_corrente: voce.desc || voce.cod,
                        uffici_totali: perUfficio.size,
                        uffici_fatti: indiceUff,
                        fascicoli_trovati: viaApi.trovati,
                        fascicoli_salvati: viaApi.salvati,
                        errori: viaApi.errori,
                        messaggio: v.ufficio.nome + ' — ' + (voce.desc || voce.cod),
                    });
                    const esito = await ricercaApi(v.ufficio, voce.app, voce.cod, distretto, cfAvvocato);
                    if (!esito.ok) {
                        viaApi.errori++;
                        erroriUff++;
                        viaApi.ultimoErrore = voce.cod + ': ' + (esito.errore || 'errore');
                        slog('    ✗ ' + voce.app + ':' + voce.cod + ' → ' + viaApi.ultimoErrore);
                        await sleep(API_PAUSA_FRA_CHIAMATE);
                        continue;
                    }
                    viaApi.riuscite++;
                    riusciteUff++;
                    let nuovi = 0;
                    // La chiamata senza filtro Anno ritorna TUTTI gli anni del
                    // ruolo (anche 2009): qui si scartano quelli fuori dalla
                    // finestra "anno corrente - ANNI_INDIETRO_API" (10 anni, la
                    // stessa di "Cerca fascicoli"), altrimenti si scarica e
                    // sincronizza materiale troppo vecchio.
                    for (const f of esito.fascicoli) {
                        const annoF = parseInt(f.anno_ruolo, 10) || 0;
                        if (annoF && (annoF < annoOggi - ANNI_INDIETRO_API || annoF > annoOggi)) continue;
                        const k = chiaveFasc(f);
                        if (chiaviViste.has(k)) continue;
                        chiaviViste.add(k);
                        daSalvare.push(f);
                        nuovi++;
                    }
                    viaApi.trovati += nuovi;
                    slog('    ✓ ' + voce.app + ':' + voce.cod + ' → ' + esito.fascicoli.length + ' fascicoli (' + nuovi + ' nuovi)');
                    bannerLog('✓ ' + v.ufficio.nome + ' — ' + voce.desc + ': ' + esito.fascicoli.length);
                    await sleep(API_PAUSA_FRA_CHIAMATE);
                }

                // Nessuna delle ricerche di questo ufficio e' andata a buon fine:
                // meglio riprovarlo col form che perderlo.
                if (!riusciteUff) {
                    ufficiScoperti.add(cod);
                    // Non sono errori di sincronizzazione: questo ufficio lo rifara'
                    // il form, quindi i tentativi falliti non vanno contati.
                    viaApi.errori -= erroriUff;
                    slog('    ✗ nessuna ricerca riuscita per questo ufficio → lo lascio al form');
                    continue;
                }

                // Salvataggio a blocchi: molto piu' rapido di un POST per fascicolo.
                const salvatiPrimaDiQuestoUfficio = viaApi.salvati;
                for (let p = 0; p < daSalvare.length; p += MAX_OFFICINE_BATCH) {
                    const blocco = daSalvare.slice(p, p + MAX_OFFICINE_BATCH);
                    const resp = await backendPost(ordineUrl, apiToken, cfAvvocato, {
                        azione: 'salva_batch',
                        fascicoli: blocco,
                    });
                    if (resp && resp.result) {
                        viaApi.salvati += (resp.result.inseriti || 0) + (resp.result.aggiornati || 0);
                        viaApi.errori += (resp.result.errori || 0);
                        if (resp.result.dettaglio_errori && resp.result.dettaglio_errori.length) {
                            viaApi.ultimoErrore = resp.result.dettaglio_errori[0];
                            slog('    errore salvataggio: ' + viaApi.ultimoErrore);
                        }
                    } else {
                        viaApi.errori += blocco.length;
                        viaApi.ultimoErrore = (resp && resp.error) || 'errore salvataggio blocco';
                        slog('    ✗ ' + viaApi.ultimoErrore);
                    }
                }

                await backendPost(ordineUrl, apiToken, cfAvvocato, {
                    azione: 'progresso_set',
                    stato: 'in_corso',
                    ordine: elenco.ordine || '',
                    provincia: elenco.provincia || '',
                    ufficio_corrente: v.ufficio.nome,
                    registro_corrente: ultimoRegistro,
                    uffici_totali: perUfficio.size,
                    uffici_fatti: indiceUff,
                    fascicoli_trovati: viaApi.trovati,
                    fascicoli_salvati: viaApi.salvati,
                    errori: viaApi.errori,
                    messaggio: v.ufficio.nome + ' — ' + daSalvare.length + ' fascicoli',
                });

                // ── Scarico dei documenti, subito dopo il salvataggio ─────────
                // Sync incrementale: salta la fase documenti dei fascicoli GIA'
                // visti (storico). La ricerca resta completa, quindi un fascicolo
                // vecchio appena assegnato (non ancora nello storico) viene scaricato.
                const daScaricare = await filtraDaScaricare(daSalvare, chiaveFasc);
                const saltatiVisti = daSalvare.length - daScaricare.length;
                if (saltatiVisti) slog('    ⏭ ' + saltatiVisti + '/' + daSalvare.length + ' fascicoli già visti (storico): salto documenti');
                if (SCARICA_DOCUMENTI && daScaricare.length) {
                    const urlScarico = urlScaricoDiretto(ordineUrl);
                    // Durante lo scarico documenti il contatore "salvati" mostrato
                    // deve avanzare in sincrono con la barra "Fascicolo Z/N": qui
                    // riflette quanti fascicoli di QUESTO ufficio hanno gia'
                    // completato lo scarico, non il totale gia' registrato a DB
                    // (altrimenti si vedrebbe "salvati: 22" mentre la barra e' all'8/22).
                    let docCompletatiUff = 0;
                    const salvatiQuestoUfficio = viaApi.salvati - salvatiPrimaDiQuestoUfficio;
                    // Scarico a blocchi di DOC_FASCICOLI_PARALLELI fascicoli in parallelo
                    // (non piu' uno alla volta): un fascicolo senza documenti nuovi impegna
                    // il portale solo per la verifica (nessun p7m da scaricare), quindi
                    // sovrapporre qualche richiesta e' sicuro; resta un limite (8) per non
                    // saturare il PdA come accadeva sovrapponendo troppi scarichi pesanti.
                    for (let p = 0; p < daScaricare.length; p += DOC_FASCICOLI_PARALLELI) {
                        const blocco = daScaricare.slice(p, p + DOC_FASCICOLI_PARALLELI);
                        const etichette = blocco.map(etichettaFascicolo);
                        bannerTesto('Documenti ' + (p + 1) + '-' + (p + blocco.length) + '/' + daScaricare.length
                            + ': ' + etichette.join(', '));
                        await aggiornaProgresso(ordineUrl, apiToken, cfAvvocato, {
                            stato: 'in_corso',
                            ordine: elenco.ordine || '',
                            provincia: elenco.provincia || '',
                            ufficio_corrente: v.ufficio.nome,
                            registro_corrente: registroDiFascicolo(blocco[0]),
                            uffici_totali: perUfficio.size,
                            uffici_fatti: indiceUff,
                            fascicoli_trovati: viaApi.trovati,
                            fascicoli_salvati: salvatiPrimaDiQuestoUfficio + Math.min(docCompletatiUff, salvatiQuestoUfficio),
                            errori: viaApi.errori,
                            fascicolo_corrente: p + 1,
                            fascicoli_totali_ricerca: daScaricare.length,
                            numero_fascicolo_corrente: etichette.join(', '),
                            percentuale_fascicolo: Math.round((p / daScaricare.length) * 100),
                            messaggio: 'Scarico documenti ' + etichette.join(', '),
                        });
                        const risultati = await (async function () {
                            // L'avanzamento va scritto ANCHE durante il blocco: con
                            // un blocco che copre tutti i fascicoli (es. 6 su 6) il
                            // solo aggiornamento iniziale lasciava la barra a 0% per
                            // tutto lo scarico, e sembrava bloccata. Ogni fascicolo
                            // che finisce sposta la barra, al massimo una scrittura
                            // ogni 2,5s per non martellare il backend.
                            let finiti = 0, ultimoPush = Date.now();
                            const spingi = async function (forza) {
                                if (!forza && (Date.now() - ultimoPush) < 2500) return;
                                ultimoPush = Date.now();
                                const fattiOra = p + finiti;
                                await aggiornaProgresso(ordineUrl, apiToken, cfAvvocato, {
                                    stato: 'in_corso',
                                    ordine: elenco.ordine || '',
                                    provincia: elenco.provincia || '',
                                    ufficio_corrente: v.ufficio.nome,
                                    registro_corrente: registroDiFascicolo(blocco[0]),
                                    uffici_totali: perUfficio.size,
                                    uffici_fatti: indiceUff,
                                    fascicoli_trovati: viaApi.trovati,
                                    fascicoli_salvati: salvatiPrimaDiQuestoUfficio
                                        + Math.min(docCompletatiUff + finiti, salvatiQuestoUfficio),
                                    errori: viaApi.errori,
                                    fascicolo_corrente: fattiOra,
                                    fascicoli_totali_ricerca: daScaricare.length,
                                    numero_fascicolo_corrente: etichette.join(', '),
                                    percentuale_fascicolo: Math.round((fattiOra / daScaricare.length) * 100),
                                    messaggio: 'Scarico documenti ' + etichette.join(', '),
                                }).catch(function () { /* la barra riparte al prossimo giro */ });
                            };
                            return await Promise.all(blocco.map(function (f) {
                                return scaricaDocumentiFascicolo(urlScarico, f)
                                    .catch(function (err) { return { ok: false, motivo: (err && err.message) || String(err) }; })
                                    .then(async function (r) {
                                        finiti++;
                                        await spingi(finiti === blocco.length);
                                        return r;
                                    });
                            }));
                        })();
                        for (let i = 0; i < blocco.length; i++) {
                            const f = blocco[i];
                            const et = etichette[i];
                            const doc = risultati[i];
                            docCompletatiUff++;
                            if (doc.ok) {
                                viaApi.docScaricati += doc.scaricati;
                                viaApi.docPresenti += doc.presenti;
                                viaApi.docFalliti += doc.falliti;
                                docConta(doc.scaricati, doc.presenti);
                                if (doc.atti && doc.atti.length) f.atti = doc.atti;
                                // Giudice, sezione, udienze ed eventi letti dai
                                // comunicazione.txt: viaggiano col fascicolo nel
                                // salvataggio a blocchi, altrimenti restano solo
                                // sul PC e il pannello mostra "—".
                                if (doc.scheda) Object.assign(f, doc.scheda);
                                // Fascicolo interamente processato: entra nello storico.
                                storicoNuovo.fasc.add(chiaveFasc(f));
                                slog('    ⤓ ' + et + ': ' + doc.scaricati + ' nuovi su ' + doc.documenti
                                    + ' (' + doc.presenti + ' già presenti, ' + doc.falliti + ' falliti, '
                                    + doc.megabyte + ' MB, ' + doc.secondi + ' s'
                                    + (doc.cache ? ', verificato di recente: portale non interrogato' : '') + ')');
                                bannerLog('⤓ ' + et + ' — ' + doc.scaricati + '/' + doc.documenti + ' documenti');
                            } else {
                                viaApi.docErrori++;
                                if (doc.riprovabile || guastoPasseggero(doc.motivo)) {
                                    viaApi.docBloccati++;
                                    viaApi.fascicoliBloccati.push(corteERgn(v.ufficio.nome, et));
                                }
                                viaApi.ultimoErrore = 'documenti ' + et + ': ' + doc.motivo;
                                annotaDaRiprovare(urlScarico, f, doc.motivo, doc.riprovabile);
                                slog('    ✗ ' + viaApi.ultimoErrore
                                    + (doc.dettaglio ? ' [dettaglio: ' + doc.dettaglio + ']' : ''));
                                bannerLog('✗ documenti ' + et + ': ' + doc.motivo);
                            }
                        }
                    }

                    // I FILE sono stati salvati sul PC dell'avvocato dal motore
                    // client-side; qui re-inviamo al backend SOLO i metadati degli
                    // atti raccolti (nessun file su Aruba), cosi' la colonna
                    // Fascicoli resta popolata anche con lo scarico diretto sul PC.
                    const conAtti = daScaricare.filter(function (f) { return Array.isArray(f.atti) && f.atti.length; });
                    for (let q = 0; q < conAtti.length; q += MAX_OFFICINE_BATCH) {
                        const lotto = conAtti.slice(q, q + MAX_OFFICINE_BATCH);
                        const rb = await backendPost(ordineUrl, apiToken, cfAvvocato, {
                            azione: 'salva_batch',
                            fascicoli: lotto,
                        }).catch(function (e) { return { error: (e && e.message) || 'invio non riuscito' }; });
                        // Se il server scarta il lotto, i file restano sul PC ma nel
                        // pannello il fascicolo appare con "Atti (0)": va detto.
                        const res0 = (rb && rb.result) || rb || {};
                        const ko = res0.errori || (res0.error ? lotto.length : 0);
                        if (ko) {
                            const perche = (res0.dettaglio_errori && res0.dettaglio_errori[0]) || res0.error || 'motivo non indicato';
                            slog('  ! atti NON salvati nel pannello per ' + ko + ' fascicoli: ' + perche);
                        }
                    }
                }
            }

            // La via rapida vale solo se il portale ha davvero risposto almeno
            // una volta: altrimenti (token scaduto, servizio giu') si ripiega.
            viaApi.ok = viaApi.riuscite > 0;
            slog('VIA API: chiamate=' + viaApi.chiamate + ' riuscite=' + viaApi.riuscite
                + ' trovati=' + viaApi.trovati + ' salvati=' + viaApi.salvati + ' errori=' + viaApi.errori
                + ' | documenti nuovi=' + viaApi.docScaricati + ' già presenti=' + viaApi.docPresenti
                + ' falliti=' + viaApi.docFalliti + ' fascicoli non scaricati=' + viaApi.docErrori);
        } catch (e) {
            viaApi.ok = false;
            viaApi.ultimoErrore = (e && e.message) || String(e);
            slog('VIA API: eccezione → ' + viaApi.ultimoErrore);
        }

        if (viaApi.ok && !ufficiScoperti.size) {
            bannerProgresso(1, 1);
            const statoApi = viaApi.errori > 0 ? 'completato_con_errori' : 'completato';
            // Messaggio di chiusura in italiano corrente: i dettagli tecnici
            // (timeout, codici HTTP) restano nel registro, non a schermo.
            const parti = [
                viaApi.trovati + ' fascicoli trovati',
                viaApi.salvati + ' salvati',
                viaApi.docScaricati + ' documenti scaricati',
            ];
            if (viaApi.docErrori) {
                // Distinzione utile a chi legge: il portale occupato e' un
                // intoppo momentaneo, il fascicolo senza atti no.
                if (viaApi.docBloccati) {
                    parti.push(viaApi.docBloccati + ' fascicoli: impossibile scaricare documenti'
                        + ' dalla PdA Toscana, riprova più tardi ('
                        + viaApi.fascicoliBloccati.join('; ') + ')');
                }
                const senzaAtti = viaApi.docErrori - viaApi.docBloccati;
                if (senzaAtti > 0) parti.push(senzaAtti + ' fascicoli senza documenti disponibili');
            }
            if (viaApi.errori) parti.push(viaApi.errori + ' errori di ricerca');
            const msgApi = 'Sincronizzazione completata — ' + parti.join(' · ');
            if (viaApi.ultimoErrore) slog('  ultimo errore tecnico (non mostrato): ' + viaApi.ultimoErrore);
            bannerTesto(msgApi);
            await backendPost(ordineUrl, apiToken, cfAvvocato, {
                azione: 'progresso_set',
                stato: statoApi,
                ordine: elenco.ordine || '',
                provincia: elenco.provincia || '',
                uffici_totali: viaApi.uffici || viaApi.chiamate,
                uffici_fatti: viaApi.uffici || viaApi.chiamate,
                fascicoli_trovati: viaApi.trovati,
                fascicoli_salvati: viaApi.salvati,
                fascicolo_corrente: 0,
                fascicoli_totali_ricerca: 0,
                numero_fascicolo_corrente: '',
                percentuale_fascicolo: 100,
                errori: viaApi.errori,
                messaggio: msgApi,
            });
            await persistiStorico();
            chrome.runtime.sendMessage({ action: 'orderSyncFinished' });
            log('Sincronizzazione completata via API:', msgApi);
            return;
        }
        if (viaApi.ok) {
            // Copertura parziale: il form si occupa solo degli uffici rimasti.
            const restano = combinazioni.filter((c) => ufficiScoperti.has(String(c.ufficio.codice_ufficio || '')));
            combinazioni.length = 0;
            restano.forEach((c) => combinazioni.push(c));
            slog('VIA API parziale: ' + viaApi.riuscite + ' ricerche riuscite; restano al form '
                + ufficiScoperti.size + ' uffici (' + combinazioni.length + ' combinazioni)');
            bannerLog('Via diretta: ' + viaApi.trovati + ' fascicoli. Restano ' + ufficiScoperti.size + ' uffici sul form');
        } else {
            slog('VIA API non utilizzabile (' + (viaApi.ultimoErrore || 'motivo non noto') + '): uso il percorso classico sul form');
            bannerLog('Via diretta non disponibile: uso il form del portale');
        }

        // 2. Ciclo ufficio/registro
        let totaliTrovati = viaApi.trovati;
        let totaliSalvati = viaApi.salvati;
        let totaliErrori = viaApi.errori;
        let erroreUltimo = '';

        // Warmup: aspetta che l'autocomplete Ufficio risponda prima di iniziare,
        // altrimenti la prima combinazione (registro principale) fallisce.
        try {
            const probe = (combinazioni[0] && terminiRicercaUfficio(combinazioni[0].ufficio)[0]) || 'a';
            slog('  Warmup autocomplete Ufficio (sonda="' + probe + '")...');
            // Finestra a fuoco durante il warmup: senza, i timer Angular sono
            // throttlati e il warmup impiega decine di secondi (o fallisce).
            await focusWindow();
            await warmupAutocompleteUfficio(probe);
        } catch (e) { slog('  Warmup errore: ' + (e && e.message)); }
        finally { await minimizeWindow(); }

        for (let i = 0; i < combinazioni.length; i++) {
            const { ufficio, registro, anno, annoKey } = combinazioni[i];
            const labelUff = ufficio.nome + (registro.nome ? ' — ' + registro.nome : '') + (anno ? ' — ' + anno : '');
            slog('--- [' + (i + 1) + '/' + combinazioni.length + '] ufficio=' + ufficio.codice_ufficio + ' "' + ufficio.nome + '" | scheda="' + (registro.scheda || '') + '" | registro="' + (registro.nome || '') + '" | reg.generale="' + (registro.registro_generale || '') + '" | anno=' + (anno || ''));
            bannerTesto('Ufficio ' + (i + 1) + '/' + combinazioni.length + ': ' + labelUff);
            bannerProgresso(i, combinazioni.length);
            bannerLog('→ ' + labelUff);

            await backendPost(ordineUrl, apiToken, cfAvvocato, {
                azione: 'progresso_set',
                stato: 'in_corso',
                ordine: elenco.ordine || '',
                provincia: elenco.provincia || '',
                ufficio_corrente: ufficio.nome,
                registro_corrente: registro.nome || '',
                uffici_totali: combinazioni.length,
                uffici_fatti: i,
                fascicoli_trovati: totaliTrovati,
                fascicoli_salvati: totaliSalvati,
                errori: totaliErrori,
                messaggio: labelUff,
            });

            try {
                // Attende che il form sia pronto
                let formPronto = await waitFor(() => {
                    return visible(findUfficioTrigger()) || document.querySelector('select');
                }, { timeout: 8000 });
                if (!formPronto) {
                    // Il deep-link puo' aver montato la dashboard: naviga via SPA.
                    slog('    form non pronto (8s): tento navigazione SPA verso Ricerca Avanzata');
                    await vaiAdRicercaAvanzata();
                    formPronto = await waitFor(() => {
                        return visible(findUfficioTrigger()) || document.querySelector('select');
                    }, { timeout: 40000 });
                }
                if (!formPronto) {
                    throw new Error('Form Ricerca Avanzata non trovato (sessione PdA scaduta?)');
                }

                // La scheda da attivare NON e' il nome del registro (nel PdA le
                // schede sono solo Civile/Lavoro, Esecuzioni e fallimenti,
                // Giudici di Pace, Cassazione Civile): si prende dalla mappa,
                // con ripiego sul tipo di ufficio per il Giudice di Pace.
                let scheda = registro.scheda || '';
                if (!scheda && /pace/.test(norm(ufficio.tipo_ufficio || ufficio.tipo || ''))) {
                    scheda = 'Giudici di Pace';
                }
                if (!await selectTab(scheda)) {
                    throw new Error('Scheda non attivabile: ' + scheda);
                }
                // Porta la finestra a fuoco e la MANTIENE sveglia per tutta
                // l'operazione (selezione ufficio + Ricerca + lettura risultati):
                // con la finestra minimizzata Chrome throttla i timer Angular e
                // l'autocomplete/ricerca HTTP resta bloccato (0 risultati). Verra'
                // ri-minimizzata nel blocco finally a fine combinazione.
                await focusWindow();
                await ensureFiltroAvvocato();
                // Riuso della selezione ufficio: se il campo mostra ancora il
                // nome dell'ufficio corrente (stessa scheda, Ricerca precedente),
                // evitiamo l'interazione con l'autocomplete, che in tab di
                // background e' molto lenta per il throttling dei timer Angular.
                const trigUff = findUfficioTrigger();
                const valUff = trigUff ? norm(trigUff.value || '') : '';
                const nomeUffNorm = norm(ufficio.nome).slice(0, 14);
                if (ufficioSelezionatoCodice === ufficio.codice_ufficio && nomeUffNorm && valUff.includes(nomeUffNorm)) {
                    slog('    ufficio gia selezionato, riuso: "' + valUff + '"');
                } else {
                    const okUff = await selectUfficio(ufficio);
                    if (!okUff) {
                        ufficioSelezionatoCodice = '';
                        throw new Error('Ufficio non selezionabile: ' + ufficio.nome);
                    }
                    ufficioSelezionatoCodice = ufficio.codice_ufficio;
                }
                await selectRegistro(registro.registro_generale || '');
                await setAnno(anno);

                // Firma/conteggio PRIMA del click: servono a capire quando la NUOVA
                // ricerca ha davvero aggiornato la tabella (evita di leggere il
                // "0 risultati" o le righe della ricerca PRECEDENTE).
                const contaTesto = () => { const m = (document.body.innerText || '').match(/(\d+)\s+risultat/i); return m ? m[1] : null; };
                const firmaPrima = firmaRisultati();
                const contaPrima = contaTesto();
                // Click IMMEDIATO: appena ufficio+registro sono impostati premiamo
                // "Ricerca" senza attese (bastano pochi ms per la propagazione del
                // SELECT nativo del registro). Ritentiamo il click se la ricerca non
                // parte entro 1.5s (a volte il primo click non viene raccolto).
                await sleep(120);
                if (!await clickRicerca()) throw new Error('Pulsante Ricerca non trovato');
                log('Ricerca inviata per', ufficio.nome, '/', registro.nome || 'tutti i registri');
                slog('  Ricerca inviata, attendo risultati...');

                // 1) Attende che la ricerca sia PARTITA: compare lo spinner OPPURE
                //    cambia la firma/conteggio dei risultati. Se non parte, RI-CLICCA.
                let partita = await waitFor(() => caricamentoAttivo()
                    || firmaRisultati() !== firmaPrima
                    || contaTesto() !== contaPrima,
                    { timeout: 1500, interval: 150 });
                if (!partita) {
                    slog('    ricerca non partita entro 1.5s: ri-clicco "Ricerca"');
                    await focusWindow();
                    await clickRicerca();
                    partita = await waitFor(() => caricamentoAttivo()
                        || firmaRisultati() !== firmaPrima
                        || contaTesto() !== contaPrima,
                        { timeout: 5000, interval: 150 });
                }
                // 2) Attende la fine del caricamento e un attimo per il rendering
                //    (la finestra e' gia' a fuoco: nessun throttling sull'HTTP).
                await attendiFineCaricamento(30000);
                await sleep(400);

                // 3) Legge i risultati (o l'assenza di risultati). Esce su "0 risultati"
                //    solo ORA che la nuova ricerca e' completata.
                const apparsi = await waitFor(() => {
                    if (caricamentoAttivo()) return null;   // ancora in caricamento
                    const righe = parseRisultatiPagina(ufficio, registro.codice);
                    if (righe.length) return righe;
                    const testo = document.body.innerText || '';
                    if (/\b0\s+risultat/i.test(testo)) return [];   // "0 risultati" → vuoto
                    if (/nessun(?:a)?\s+(fascicol\w+|risultat\w+|dat\w+)/i.test(testo)) return [];
                    return null;
                }, { timeout: 30000, interval: 500 });

                const righe = apparsi || [];
                const mConta = (document.body.innerText || '').match(/(\d+)\s+risultat/i);
                slog('  RISULTATI: righe estratte=' + righe.length + (mConta ? ' | pagina dichiara "' + mConta[0] + '"' : ' | nessun "N risultati" trovato'));
                if (!righe.length) {
                    const tbl = document.querySelector('table');
                    slog('  DEBUG no-righe: tabelle in pagina=' + document.querySelectorAll('table').length + (tbl ? ' | prima tabella righe=' + tbl.querySelectorAll('tr').length : ''));
                }
                log('Trovati', righe.length, 'fascicoli (pagina 1) —', ufficio.nome);

                // Ciclo paginazione con de-dup tra pagine (chiave = link dettaglio
                // o combinazione registro/ufficio/anno/numero/sub). Evita di
                // contare piu' volte lo stesso fascicolo se il paginatore ripete righe.
                const fascicoliUfficio = [];
                const chiaviViste = new Set();
                const chiaveFasc = (f) => (f.link && f.link.includes('dettaglio-fascicolo/'))
                    ? f.link
                    : [f.registro, f.gestore, f.id_ufficio, f.anno_ruolo, f.numero_ruolo, f.sub_procedimento].join('|');
                const aggiungi = (arr) => {
                    let aggiunti = 0;
                    for (const f of arr) {
                        const k = chiaveFasc(f);
                        if (chiaviViste.has(k)) continue;
                        chiaviViste.add(k);
                        fascicoliUfficio.push(f);
                        aggiunti++;
                    }
                    return aggiunti;
                };
                aggiungi(righe);
                let pagina = 1;
                while (pagina < MAX_PAGINE_PER_RICERCA) {
                    const altre = await vaiPaginaSuccessiva(pagina);
                    if (!altre) break;
                    pagina++;
                    await sleep(600);
                    await attendiFineCaricamento(15000);
                    const nuove = parseRisultatiPagina(ufficio, registro.codice);
                    const aggiunti = aggiungi(nuove);
                    log('Pagina', pagina, ':', nuove.length, 'fascicoli (' + aggiunti + ' nuovi)');
                    // Se una pagina non porta fascicoli nuovi, il paginatore ha
                    // probabilmente ripetuto l'ultima pagina: interrompo.
                    if (aggiunti === 0) break;
                }
                totaliTrovati += fascicoliUfficio.length;
                slog('  PAGINAZIONE: pagine lette=' + pagina + ' | fascicoli totali (dedup)=' + fascicoliUfficio.length);

                // Tutte le pagine sono state lette: solo ora conosciamo il totale reale.
                // Il conteggio fascicolo-per-fascicolo parte da 0/totale.
                const totaleRicerca = fascicoliUfficio.length;
                let indiceRicerca = 0;
                await aggiornaProgresso(ordineUrl, apiToken, cfAvvocato, {
                    stato: 'in_corso',
                    ordine: elenco.ordine || '',
                    provincia: elenco.provincia || '',
                    ufficio_corrente: ufficio.nome,
                    registro_corrente: registro.nome || '',
                    uffici_totali: combinazioni.length,
                    uffici_fatti: i,
                    fascicoli_trovati: totaliTrovati,
                    fascicoli_salvati: totaliSalvati,
                    errori: totaliErrori,
                    messaggio: labelUff + ' — totale reale: ' + totaleRicerca + ' fascicoli',
                }, {
                    fascicolo_corrente: 0,
                    fascicoli_totali_ricerca: totaleRicerca,
                    numero_fascicolo_corrente: '',
                    percentuale_fascicolo: 0,
                });

                // Salva un fascicolo alla volta per mostrare il progresso reale
                // (e' solo un salvataggio a DB, veloce); i documenti invece si
                // scaricano a blocchi di DOC_FASCICOLI_PARALLELI in parallelo, come
                // sul percorso via API.
                for (let cp = 0; cp < fascicoliUfficio.length; cp += DOC_FASCICOLI_PARALLELI) {
                    const bloccoF = fascicoliUfficio.slice(cp, cp + DOC_FASCICOLI_PARALLELI);
                    for (const fascicolo of bloccoF) {
                        indiceRicerca++;
                        const resp = await backendPost(ordineUrl, apiToken, cfAvvocato, {
                            azione: 'salva_batch',
                            fascicoli: [fascicolo],
                        });
                        if (resp && resp.result) {
                            totaliSalvati += (resp.result.inseriti || 0) + (resp.result.aggiornati || 0);
                            totaliErrori += (resp.result.errori || 0);
                            if (resp.result.dettaglio_errori && resp.result.dettaglio_errori.length) {
                                erroreUltimo = resp.result.dettaglio_errori[0];
                                bannerLog('Errore fascicolo: ' + erroreUltimo);
                            }
                        } else {
                            totaliErrori++;
                            erroreUltimo = (resp && resp.error) || 'errore salvataggio fascicolo';
                            bannerLog('Errore fascicolo: ' + erroreUltimo);
                        }
                    }
                    const indiceBlocco = Math.min(indiceRicerca, totaleRicerca);
                    const percentuale = totaleRicerca > 0 ? Math.round((indiceBlocco / totaleRicerca) * 100) : 100;
                    const etichette = bloccoF.map(etichettaFascicolo);
                    bannerTesto('Fascicoli ' + (cp + 1) + '-' + indiceBlocco + '/' + totaleRicerca + ' — ' + labelUff);
                    bannerProgresso(indiceBlocco, totaleRicerca);
                    await aggiornaProgresso(ordineUrl, apiToken, cfAvvocato, {
                        stato: 'in_corso',
                        ordine: elenco.ordine || '',
                        provincia: elenco.provincia || '',
                        ufficio_corrente: ufficio.nome,
                        registro_corrente: registro.nome || '',
                        uffici_totali: combinazioni.length,
                        uffici_fatti: i,
                        fascicoli_trovati: totaliTrovati,
                        fascicoli_salvati: totaliSalvati,
                        errori: totaliErrori,
                        messaggio: labelUff + ' — fascicoli ' + (cp + 1) + '-' + indiceBlocco + '/' + totaleRicerca,
                    }, {
                        fascicolo_corrente: indiceBlocco,
                        fascicoli_totali_ricerca: totaleRicerca,
                        numero_fascicolo_corrente: etichette.join(', '),
                        percentuale_fascicolo: percentuale,
                    });

                    // Anche sul percorso classico i documenti si scaricano con le
                    // chiamate dirette: il form serve solo a trovare il fascicolo.
                    if (SCARICA_DOCUMENTI) {
                        // Sync incrementale: salta i fascicoli gia' visti (storico).
                        const bloccoScarica = await filtraDaScaricare(bloccoF, chiaveFascStorico);
                        const saltatiF = bloccoF.length - bloccoScarica.length;
                        if (saltatiF) slog('    ⏭ ' + saltatiF + ' fascicoli già visti (storico): salto documenti');
                        const risultatiDoc = await (async function () {
                            // Avanzamento anche DENTRO il blocco: lo scarico dei
                            // documenti di un blocco dura minuti e la barra, aggiornata
                            // solo a blocco finito, sembrava piantata.
                            let finiti = 0, ultimoPush = Date.now();
                            const spingi = async function (forza) {
                                if (!forza && (Date.now() - ultimoPush) < 2500) return;
                                ultimoPush = Date.now();
                                const fattiOra = Math.min(cp + finiti, totaleRicerca);
                                await aggiornaProgresso(ordineUrl, apiToken, cfAvvocato, {
                                    stato: 'in_corso',
                                    ordine: elenco.ordine || '',
                                    provincia: elenco.provincia || '',
                                    ufficio_corrente: ufficio.nome,
                                    registro_corrente: registro.nome || '',
                                    uffici_totali: combinazioni.length,
                                    uffici_fatti: i,
                                    fascicoli_trovati: totaliTrovati,
                                    fascicoli_salvati: totaliSalvati,
                                    errori: totaliErrori,
                                    messaggio: 'Scarico documenti ' + finiti + '/' + bloccoScarica.length
                                        + ' — ' + labelUff,
                                }, {
                                    fascicolo_corrente: fattiOra,
                                    fascicoli_totali_ricerca: totaleRicerca,
                                    numero_fascicolo_corrente: bloccoScarica.map(etichettaFascicolo).join(', '),
                                    percentuale_fascicolo: totaleRicerca > 0
                                        ? Math.round((fattiOra / totaleRicerca) * 100) : 100,
                                }).catch(function () { /* la barra riparte al prossimo giro */ });
                            };
                            return await Promise.all(bloccoScarica.map(function (f) {
                                return scaricaDocumentiFascicolo(urlScaricoDiretto(ordineUrl), f)
                                    .catch(function (err) { return { ok: false, motivo: (err && err.message) || String(err) }; })
                                    .then(async function (r) {
                                        finiti++;
                                        await spingi(finiti === bloccoScarica.length);
                                        return r;
                                    });
                            }));
                        })();
                        for (let k = 0; k < bloccoScarica.length; k++) {
                            const fascicolo = bloccoScarica[k];
                            const numeroCorrente = etichettaFascicolo(fascicolo);
                            const doc = risultatiDoc[k];
                            if (doc.ok) {
                                viaApi.docScaricati += doc.scaricati;
                                viaApi.docPresenti += doc.presenti;
                                viaApi.docFalliti += doc.falliti;
                                docConta(doc.scaricati, doc.presenti);
                                storicoNuovo.fasc.add(chiaveFascStorico(fascicolo));
                                slog('    ⤓ ' + numeroCorrente + ': ' + doc.scaricati + ' nuovi su ' + doc.documenti
                                    + ' (' + doc.presenti + ' già presenti, ' + doc.falliti + ' falliti, ' + doc.megabyte + ' MB)');
                                bannerLog('⤓ ' + numeroCorrente + ' — ' + doc.scaricati + '/' + doc.documenti + ' documenti');
                            } else {
                                viaApi.docErrori++;
                                if (doc.riprovabile || guastoPasseggero(doc.motivo)) {
                                    viaApi.docBloccati++;
                                    viaApi.fascicoliBloccati.push(corteERgn(ufficio.nome, numeroCorrente));
                                }
                                annotaDaRiprovare(urlScaricoDiretto(ordineUrl), fascicolo, doc.motivo, doc.riprovabile);
                                slog('    ✗ documenti ' + numeroCorrente + ': ' + doc.motivo
                                    + (doc.dettaglio ? ' [dettaglio: ' + doc.dettaglio + ']' : ''));
                            }
                        }
                    }
                }

                // Combinazione (ufficio,registro,anno) completata con successo:
                // marca l'anno nello storico, TRANNE l'anno corrente.
                if (annoKey && anno !== annoOggi) storicoNuovo.anni.add(annoKey);
                bannerLog('✓ ' + labelUff + ' — ' + fascicoliUfficio.length + ' fascicoli');
            } catch (err) {
                totaliErrori++;
                erroreUltimo = err.message || String(err);
                bannerLog('✗ ' + labelUff + ' — ' + erroreUltimo);
                log('ERRORE su', labelUff, ':', erroreUltimo);
                slog('  ✗ ERRORE:', erroreUltimo, '| stack:', (err && err.stack) ? String(err.stack).slice(0, 500) : '-');
            } finally {
                // Ri-minimizza la finestra tra una combinazione e l'altra: resta
                // visibile solo durante l'elaborazione attiva.
                await minimizeWindow();
            }
        }

        // Ultimo giro sui fascicoli che il documentale aveva rifiutato perche'
        // occupato: adesso la coda del portale e' smaltita.
        await ripassoDocumenti(viaApi, async (fatti, totale, et) => {
            await aggiornaProgresso(ordineUrl, apiToken, cfAvvocato, {
                stato: 'in_corso',
                ordine: elenco.ordine || '',
                provincia: elenco.provincia || '',
                uffici_totali: combinazioni.length,
                uffici_fatti: combinazioni.length,
                fascicoli_trovati: totaliTrovati,
                fascicoli_salvati: totaliSalvati,
                errori: totaliErrori,
                messaggio: 'Ripasso documenti ' + fatti + '/' + totale,
            }, {
                fascicolo_corrente: fatti,
                fascicoli_totali_ricerca: totale,
                numero_fascicolo_corrente: et,
                percentuale_fascicolo: Math.round((fatti / totale) * 100),
            });
        });

        bannerProgresso(combinazioni.length, combinazioni.length);
        const statoFinale = totaliErrori > 0 ? 'completato_con_errori' : 'completato';
        const partiF = [
            totaliTrovati + ' fascicoli trovati',
            totaliSalvati + ' salvati',
            viaApi.docScaricati + ' documenti scaricati',
        ];
        if (viaApi.docErrori) {
            if (viaApi.docBloccati) {
                partiF.push(viaApi.docBloccati + ' fascicoli: impossibile scaricare documenti'
                    + ' dalla PdA Toscana, riprova più tardi ('
                    + viaApi.fascicoliBloccati.join('; ') + ')');
            }
            const senzaAttiF = viaApi.docErrori - viaApi.docBloccati;
            if (senzaAttiF > 0) partiF.push(senzaAttiF + ' fascicoli senza documenti disponibili');
        }
        if (totaliErrori) partiF.push(totaliErrori + ' errori di ricerca');
        const msgFinale = 'Sincronizzazione completata — ' + partiF.join(' · ');
        if (erroreUltimo) slog('  ultimo errore tecnico (non mostrato): ' + erroreUltimo);
        bannerTesto(msgFinale);

        await backendPost(ordineUrl, apiToken, cfAvvocato, {
            azione: 'progresso_set',
            stato: statoFinale,
            ordine: elenco.ordine || '',
            provincia: elenco.provincia || '',
            uffici_totali: combinazioni.length,
            uffici_fatti: combinazioni.length,
            fascicoli_trovati: totaliTrovati,
            fascicoli_salvati: totaliSalvati,
            fascicolo_corrente: 0,
            fascicoli_totali_ricerca: 0,
            numero_fascicolo_corrente: '',
            percentuale_fascicolo: 100,
            errori: totaliErrori,
            messaggio: msgFinale,
        });
        // La tab è stata aperta dalla dashboard tramite la service worker,
        // quindi la chiusura a fine sync non porta mai l'utente sulla PdA.
        await persistiStorico();
        chrome.runtime.sendMessage({ action: 'orderSyncFinished' });
        log('Sincronizzazione completata:', msgFinale);
    }

    // Avvio: attende il boot di Angular prima del main
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => main());
    } else {
        main();
    }
})();
