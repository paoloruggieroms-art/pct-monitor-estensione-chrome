/**
 * PCT Monitor - Ricerca fascicoli in API diretta (service worker)
 *
 * Sostituisce il pilotaggio del form Angular di /advanced-search con le stesse
 * chiamate REST che quel form esegue. Girando nel service worker:
 *   - non serve nessuna finestra del PdA aperta per CERCARE i fascicoli;
 *   - niente autocomplete, cambi di scheda, click, attese di rendering;
 *   - niente throttling di Chrome sulle finestre ridotte a icona.
 *
 * Endpoint e corpo della richiesta sono quelli catturati dalla webapp del PdA
 * (vedi _API_RICERCA_PDA.md e logs/pda_trace.log). Il token e' quello Keycloak
 * intercettato da interceptor.js e conservato in storage da background.js; se
 * e' vicino alla scadenza si rinnova qui col refresh token, senza riaprire il
 * portale.
 *
 * Il modulo si occupa SOLO della ricerca e del salvataggio dell'anagrafica:
 * lo scarico dei documenti resta al motore collaudato (pda_download.js), a cui
 * background.js consegna l'elenco dei fascicoli trovati.
 */

'use strict';

const PDA_ORIGINE = 'https://www.giustizia.toscana.it';
const API_ROOT = PDA_ORIGINE + '/pda-rt/api';
const API_UFFICIO = API_ROOT + '/servizipda-anagrafiche/v1/catalogo-ug/getUfficioGiudiziario/';
const API_AREE = API_ROOT + '/servizipda-anagrafiche/v1/catalogo-ug/getListaUfficiGiudiziariPerArea';
const DETTAGLIO_ROOT = PDA_ORIGINE + '/pda-rt/cancelleriatelematica/dettaglio-fascicolo';

// Realm e client del PdA (gli stessi che compaiono nel token: iss/azp).
const KEYCLOAK_TOKEN_URL = 'https://auth.regione.toscana.it/auth/realms/rt/protocol/openid-connect/token';
const KEYCLOAK_CLIENT_ID = 'r_toscan__pda_cancelleria';

const API_TENTATIVI = 4;           // il portale rifiuta a raffica sotto carico
const API_PAUSA_FRA_CHIAMATE = 250;
const ANNI_INDIETRO = 5;           // anno corrente + i cinque precedenti
const MAX_BATCH = 100;             // fascicoli per singola chiamata salva_batch

// Traduzione fra l'etichetta del registro salvata a database
// (tab_uffici_giudiziari.registro) e cio' che l'API del portale si aspetta.
// "app" determina l'endpoint, "cod_api" il codice registro: attenzione al
// Lavoro, che nel catalogo e' LAV ma nella ricerca e nei link e' DL.
const REGISTRI_PORTALE = {
    'contenzioso civile':       { app: 'sicid',  cod_api: 'CC',   nome: 'Contenzioso Civile' },
    'lavoro':                   { app: 'sicid',  cod_api: 'DL',   nome: 'Lavoro' },
    'diritto del lavoro':       { app: 'sicid',  cod_api: 'DL',   nome: 'Lavoro' },
    'volontaria giurisdizione': { app: 'sicid',  cod_api: 'VG',   nome: 'Volontaria Giurisdizione' },
    'procedure concorsuali':    { app: 'siecic', cod_api: 'FALL', nome: 'Procedure Concorsuali' },
    'esecuzioni mobiliari':     { app: 'siecic', cod_api: 'ESM',  nome: 'Esecuzioni Mobiliari' },
    'esecuzioni immobiliari':   { app: 'siecic', cod_api: 'ESIM', nome: 'Esecuzioni Immobiliari' },
    'giudice di pace':          { app: 'sigp',   cod_api: 'ESIM', nome: 'Giudice di Pace' },
    'giudici di pace':          { app: 'sigp',   cod_api: 'ESIM', nome: 'Giudice di Pace' },
};

// Il Giudice di Pace sta nell'area SIGP: il portale, sulle sue pagine, cerca
// sempre col codice registro ESIM.
const REGISTRI_GDP = [{ app: 'sigp', cod: 'ESIM', desc: 'Giudice di Pace' }];

const AREA_DA_APP = { sicid: 'SICID', siecic: 'SIECIC', sigp: 'SIGP' };
const COD_API_DA_CATALOGO = { LAV: 'DL' };

// SIGP ha un endpoint suo (ricerca per Ruolo/Materia/Oggetto), SIECIC cerca per
// numero, SICID per tipo: il corpo della richiesta e' identico per tutti e tre.
function urlRicerca(app) {
    if (app === 'siecic') return API_ROOT + '/servizipda-siecic/v1/ricercaInformazioniFascicoloPerNumero';
    if (app === 'sigp') return API_ROOT + '/servizipda-sigp/v1/ricercaInformazioniFascicoloPerRMO';
    return API_ROOT + '/servizipda-sicid/v1/ricercaInformazioniFascicoloPerTipo';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const codaToken = (v) => '…' + String(v || '').slice(-8);

// ─── Token del portale ────────────────────────────────────────────────────────

/** Payload di un JWT (senza verifica di firma): serve solo a leggere 'exp'. */
function jwtPayload(jwt) {
    try {
        const parti = String(jwt || '').split('.');
        if (parti.length < 2) return null;
        let b64 = parti[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        return JSON.parse(atob(b64));
    } catch (e) {
        return null;
    }
}

/** Secondi di vita residui dell'access token (0 se illeggibile o scaduto). */
function secondiResidui(access) {
    const p = jwtPayload(access);
    if (!p || !p.exp) return 0;
    return Math.max(0, Math.round(p.exp - Date.now() / 1000));
}

/**
 * Access token spendibile. Se manca meno di `margine` secondi alla scadenza si
 * chiede a Keycloak un token nuovo col refresh (che vive ~30 minuti), cosi' una
 * ricerca lunga non muore a metà.
 */
export async function assicuraToken(margine, log) {
    const st = await chrome.storage.local.get(['pdaAccessToken', 'pdaRefreshToken']);
    const access = String(st.pdaAccessToken || '');
    const refresh = String(st.pdaRefreshToken || '');
    if (access && secondiResidui(access) > (margine || 90)) return access;
    if (!refresh) {
        // Nessun refresh: si prova comunque l'access finche' respira.
        return secondiResidui(access) > 0 ? access : '';
    }
    const nuovo = await rinnovaToken(refresh, log);
    if (nuovo) return nuovo;
    return secondiResidui(access) > 0 ? access : '';
}

/** Rinnovo dell'access token dal refresh token (Keycloak della Regione). */
async function rinnovaToken(refresh, log) {
    try {
        const r = await fetch(KEYCLOAK_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: KEYCLOAK_CLIENT_ID,
                refresh_token: refresh,
            }).toString(),
        });
        if (!r.ok) {
            if (log) log('    token: rinnovo rifiutato da Keycloak (HTTP ' + r.status + ')');
            return '';
        }
        const j = await r.json();
        if (!j || !j.access_token) {
            if (log) log('    token: risposta di Keycloak senza access_token');
            return '';
        }
        await chrome.storage.local.set({
            pdaAccessToken: j.access_token,
            pdaRefreshToken: j.refresh_token || refresh,
            pdaTokenAt: Date.now(),
        });
        if (log) log('    token rinnovato ' + codaToken(j.access_token) + ' (vale ' + (j.expires_in || '?') + 's)');
        return String(j.access_token);
    } catch (e) {
        if (log) log('    token: rinnovo non riuscito (' + ((e && e.message) || e) + ')');
        return '';
    }
}

// ─── Chiamate all'API del portale ─────────────────────────────────────────────

/**
 * Una chiamata all'API del PdA. Ritenta solo quando ha senso: errori di rete e
 * 5xx (portale saturo). Su 401/403 chiede un token nuovo e riprova una volta,
 * perche' il caso tipico e' l'access token scaduto a metà giro.
 *
 * @returns {{stato:number, dati:any, errore?:string}}
 */
async function chiamataApi(url, body, cf, log, giaRinnovato) {
    const token = await assicuraToken(90, log);
    if (!token) return { stato: 0, dati: null, errore: 'token del portale non disponibile' };

    const opz = {
        method: body ? 'POST' : 'GET',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Accept': 'application/json',
            // Senza X-ROLE il portale risponde 401 anche con un token buono:
            // e' l'intestazione che la webapp del PdA aggiunge a ogni chiamata.
            // Le X-Delega-* che pure compaiono nelle chiamate della webapp NON
            // servono (il token identifica gia' l'avvocato) e, se il CF della
            // dashboard non coincide con quello della sessione PdA, farebbero
            // rispondere 403: si resta sulle intestazioni del flusso collaudato.
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
            if (tent === API_TENTATIVI) return { stato: 0, dati: null, errore: 'rete: ' + ((e && e.message) || e) };
            await sleep(attesa); attesa *= 2; continue;
        }
        if (r.status === 204) return { stato: 204, dati: null };
        if (r.status === 401 || r.status === 403) {
            if (giaRinnovato) return { stato: r.status, dati: null, errore: 'token rifiutato dal portale' };
            // Token rifiutato: forza il rinnovo e ripeti la chiamata una volta.
            const st = await chrome.storage.local.get(['pdaRefreshToken']);
            const nuovo = await rinnovaToken(String(st.pdaRefreshToken || ''), log);
            if (!nuovo) return { stato: r.status, dati: null, errore: 'token rifiutato e non rinnovabile (riapri il PdA)' };
            return chiamataApi(url, body, cf, log, true);
        }
        if (r.status >= 200 && r.status < 300) {
            try { return { stato: r.status, dati: await r.json() }; }
            catch (e) { return { stato: r.status, dati: null }; }
        }
        if (r.status >= 500 && tent < API_TENTATIVI) {
            if (log) log('    API ' + r.status + ' (portale saturo): ritento fra ' + Math.round(attesa / 1000) + 's');
            await sleep(attesa); attesa *= 2; continue;
        }
        return { stato: r.status, dati: null, errore: 'HTTP ' + r.status };
    }
    return { stato: 0, dati: null, errore: 'nessuna risposta' };
}

// ─── Catalogo uffici (distretto e registri) ───────────────────────────────────

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

/** Raccoglie i registri dichiarati dal catalogo per quell'ufficio. */
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
const AREE_CACHE = new Map();

/** Ripiego per il distretto: elenco uffici di un'area (serve solo codiceGL). */
async function elencoUfficiArea(area, cf, log) {
    if (AREE_CACHE.has(area)) return AREE_CACHE.get(area);
    const r = await chiamataApi(API_AREE, { area: [area] }, cf, log);
    const mappa = new Map();
    if (r.stato === 200 && r.dati) {
        const lista = r.dati.ufficioMinList || r.dati.ufficiList || [];
        lista.forEach((u) => {
            if (u && u.codiceUfficio) mappa.set(String(u.codiceUfficio), String(u.codiceGL || ''));
        });
        if (log) log('    elenco uffici area ' + area + ': ' + mappa.size + ' voci');
    } else if (log) {
        log('    elenco uffici area ' + area + ': ' + (r.errore || 'HTTP ' + r.stato));
    }
    AREE_CACHE.set(area, mappa);
    return mappa;
}

/** Distretto (codiceGL) e registri disponibili per un ufficio. */
async function catalogoUfficio(codiceUfficio, cf, log) {
    if (CATALOGO_CACHE.has(codiceUfficio)) return CATALOGO_CACHE.get(codiceUfficio);
    const r = await chiamataApi(API_UFFICIO + encodeURIComponent(codiceUfficio), null, cf, log);
    if (r.stato === 200 && r.dati) {
        const cat = {
            distretto: String(cercaChiave(r.dati, 'codiceGL') || ''),
            registri: registriDalCatalogo(r.dati),
        };
        if (log) {
            log('    catalogo ufficio ' + codiceUfficio + ': distretto=' + cat.distretto
                + ' registri=' + JSON.stringify(cat.registri.map((x) => x.app + ':' + x.cod)));
        }
        CATALOGO_CACHE.set(codiceUfficio, cat);
        return cat;
    }
    if (log) log('    catalogo ufficio ' + codiceUfficio + ': ' + (r.errore || 'HTTP ' + r.stato) + ' → provo con l\'elenco per area');
    for (const area of ['SICID', 'SIECIC', 'SIGP']) {
        const mappa = await elencoUfficiArea(area, cf, log);
        const gl = mappa.get(String(codiceUfficio));
        if (gl) {
            const cat = { distretto: gl, registri: [] };
            if (log) log('    ufficio ' + codiceUfficio + ' trovato in ' + area + ': distretto=' + gl);
            CATALOGO_CACHE.set(codiceUfficio, cat);
            return cat;
        }
    }
    CATALOGO_CACHE.set(codiceUfficio, null);
    return null;
}

// ─── Ricerca ──────────────────────────────────────────────────────────────────

/** Corpo della richiesta di ricerca: quello della webapp, anno opzionale. */
function corpoRicerca(idUfficio, distretto, codApi, anno) {
    const adesso = Date.now();
    const body = {
        distretto,
        tipo: 'RGN',
        idUfficio: String(idUfficio || ''),
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
    if (anno) body.anno = String(anno);
    return body;
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
    // sub-procedimento: in SIECIC e' l'identificativo interno del fascicolo
    // (idDfa), ed e' con quello che il portale consegna i documenti.
    const pezzoSub = (app === 'siecic' && f.idFascicolo) ? String(f.idFascicolo) : sub;
    const parti = (f.infoParteList || []).map((p) => {
        const voce = {
            cognome: String(p.cognome || '').toUpperCase(),
            nome: String(p.nome || '').toUpperCase(),
            // Codici a due lettere: 1a = ruolo (A/C/T), 2a = P/S principale o
            // secondaria. Es. "AS" = attore secondario. La normalizzazione a
            // AP/CP/TP la fa il backend in sync_parti().
            tipo: String(p.tipo || '').toUpperCase(),
            tipo_raw: String(p.tipo || '').toUpperCase(),
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
    // L'indirizzo del dettaglio non ha la stessa forma per tutte le aree: SIGP
    // (Giudice di Pace) non ha il segmento del registro e porta il numero senza
    // zeri davanti, ed e' proprio da quell'indirizzo che il portale ricava i
    // documenti del fascicolo.
    const link = (app === 'sigp')
        ? DETTAGLIO_ROOT + '/' + area + '/' + distretto + '/' + idUff
            + '/' + anno + '/' + numeroInt + '/' + sub + '/' + cfAvvocato + '/AVV'
        : DETTAGLIO_ROOT + '/' + area + '/' + distretto + '/' + idUff + '/' + codApi
            + '/' + anno + '/' + numeroPad + '/' + pezzoSub + '/' + cfAvvocato + '/AVV';
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

/** Estrae l'elenco fascicoli dalla risposta, nelle tre forme che il PdA usa. */
function listaDaRisposta(dati) {
    if (!dati) return [];
    if (Array.isArray(dati)) return dati;
    return dati.infoFascicoloExtList || dati.infoFascicoloList || [];
}

/**
 * Una ricerca per ufficio+registro. Prima si chiede SENZA anno: il portale
 * risponde con i fascicoli di tutti gli anni in un colpo solo. Solo se quella
 * chiamata non riesce (o torna vuota) si ripete anno per anno, come fa il form.
 *
 * @returns {{ok:boolean, fascicoli:Array, chiamate:number, errore?:string}}
 */
async function ricercaRegistro(ufficio, voce, distretto, cfAvvocato, anni, log) {
    const url = urlRicerca(voce.app);
    const idUff = String(ufficio.codice_ufficio || '');
    let chiamate = 1;
    const r = await chiamataApi(url, corpoRicerca(idUff, distretto, voce.cod, null), cfAvvocato, log);
    if (r.stato === 200) {
        const lista = listaDaRisposta(r.dati);
        if (lista.length) {
            return {
                ok: true,
                chiamate,
                fascicoli: lista.map((f) => fascicoloDaApi(f, ufficio, distretto, voce.app, voce.cod, cfAvvocato)),
            };
        }
    } else if (r.stato !== 204) {
        if (log) log('    ricerca senza anno ' + voce.app + ':' + voce.cod + ' → ' + (r.errore || 'HTTP ' + r.stato) + ': riprovo anno per anno');
    }

    // Ripiego anno per anno (anche dopo un 204: alcuni registri rispondono
    // "nessun fascicolo" alla ricerca senza anno e popolano invece quella per
    // singola annualita').
    const trovati = [];
    let riuscite = 0;
    let ultimoErrore = r.errore || (r.stato === 204 ? '' : 'HTTP ' + r.stato);
    for (const anno of anni) {
        chiamate++;
        const ra = await chiamataApi(url, corpoRicerca(idUff, distretto, voce.cod, anno), cfAvvocato, log);
        if (ra.stato === 204) { riuscite++; continue; }
        if (ra.stato !== 200) {
            ultimoErrore = ra.errore || ('HTTP ' + ra.stato);
            continue;
        }
        riuscite++;
        listaDaRisposta(ra.dati).forEach((f) => {
            trovati.push(fascicoloDaApi(f, ufficio, distretto, voce.app, voce.cod, cfAvvocato));
        });
        await sleep(API_PAUSA_FRA_CHIAMATE);
    }
    // La ricerca senza anno riuscita (200 vuoto o 204) vale come esito valido
    // anche se il giro per anni non ha aggiunto nulla.
    const senzaAnnoOk = (r.stato === 200 || r.stato === 204);
    if (!riuscite && !senzaAnnoOk) {
        return { ok: false, chiamate, fascicoli: [], errore: ultimoErrore || 'nessuna risposta utile' };
    }
    return { ok: true, chiamate, fascicoli: trovati };
}

// ─── Orchestrazione: tutti gli uffici dell'Ordine ─────────────────────────────

/** Chiave di un fascicolo per la deduplica fra registri e anni. */
const chiaveFasc = (f) => [f.registro, f.gestore, f.id_ufficio, f.tipo_ruolo, f.anno_ruolo, f.numero_ruolo, f.sub_procedimento].join('|');

/** Etichetta leggibile del fascicolo, come nella sync veloce. */
function etichettaFasc(f) {
    const num = f.anno_ruolo + '/' + f.numero_ruolo + (f.sub_procedimento && f.sub_procedimento !== '0' ? '/' + f.sub_procedimento : '');
    return String(f.registro || '') + ' ' + num;
}

/**
 * Ricerca completa per l'Ordine dell'avvocato, tutta in API diretta.
 *
 * @param {object} opz
 * @param {string} opz.cf            codice fiscale dell'avvocato
 * @param {string[]} opz.codici      codici ufficio selezionati (vuoto = tutto l'Ordine)
 * @param {function} opz.postBackend (payload) => Promise<risultato|null>
 * @param {function} [opz.log]       (riga) => void, scrive in logs/sync_ordine.log
 * @returns {Promise<object>} esito con conteggi ed elenco per la fase documenti
 */
export async function ricercaDirettaOrdine(opz) {
    const cf = String((opz && opz.cf) || '').toUpperCase();
    const codici = Array.isArray(opz && opz.codici) ? opz.codici.map(String).filter(Boolean) : [];
    const postBackend = opz.postBackend;
    const log = typeof opz.log === 'function' ? opz.log : () => {};

    const esito = {
        ok: false, motivo: '', ordine: '', provincia: '',
        uffici: 0, chiamate: 0, riuscite: 0, trovati: 0, salvati: 0, errori: 0,
        ultimoErrore: '', scoperti: [], codiciFatti: [], lista: [], nomiUffici: {},
    };

    // Senza token non si parte: il chiamante ripieghera' sul percorso classico,
    // che sa anche riaprire il portale per il login CNS.
    const token = await assicuraToken(90, log);
    if (!token) {
        esito.motivo = 'token del portale non disponibile';
        log('RICERCA API: nessun token del PdA in memoria → non utilizzabile');
        return esito;
    }
    log('RICERCA API: token ' + codaToken(token) + ' valido per ' + secondiResidui(token) + 's');

    // 1. Elenco uffici/registri dell'Ordine (una riga per ufficio+registro).
    const respElenco = await postBackend({ azione: 'elenco_uffici', codici });
    if (!respElenco || !respElenco.success) {
        esito.motivo = 'elenco uffici non disponibile: ' + ((respElenco && (respElenco.error || JSON.stringify(respElenco))) || 'nessuna risposta');
        log('RICERCA API: ' + esito.motivo);
        return esito;
    }
    esito.ordine = respElenco.ordine || '';
    esito.provincia = respElenco.provincia || '';
    const ufficiDb = respElenco.uffici || [];

    // Uffici soppressi/accorpati: nel PdA restano in elenco come "TRIBUNALE DI
    // LA SPEZIA ex SD SARZANA", ma i fascicoli veri stanno sull'ufficio attuale.
    const soppresso = (u) => /\bex\s+(sd|sez|sezione)\b|\bex\s+s\.?d\.?/i.test(String(u.nome || ''));
    const peso = (u) => {
        const t = norm(u.tipo);
        const n = norm(u.nome);
        if (t === 'tribunale' || n.indexOf('tribunale') === 0) return 0;
        if (t.indexOf('pace') !== -1 || n.indexOf('giudice di pace') !== -1) return 1;
        return 2;
    };
    const righe = ufficiDb
        .filter((u) => {
            if (!soppresso(u)) return true;
            log('  ufficio ESCLUSO (soppresso/ex sezione distaccata): ' + u.codice_ufficio + ' | ' + u.nome);
            return false;
        })
        .sort((a, b) => (peso(a) - peso(b)) || norm(a.nome).localeCompare(norm(b.nome)));

    if (!righe.length) {
        esito.motivo = 'nessun ufficio da sincronizzare';
        log('RICERCA API: ' + esito.motivo + ' (righe DB=' + ufficiDb.length + ')');
        return esito;
    }

    // 2. Una voce per ufficio, con i registri tradotti per l'API.
    const perUfficio = new Map();
    for (const u of righe) {
        const k = String(u.codice_ufficio || '');
        if (!k) continue;
        if (!perUfficio.has(k)) perUfficio.set(k, { ufficio: u, voci: [], dalCatalogo: false, nomeAltro: '' });
        const v = perUfficio.get(k);
        const mappa = REGISTRI_PORTALE[norm(u.registro)];
        // Il nome da mostrare e' quello scritto nel database, non il codice.
        const nomeDb = String(u.registro || '').trim() || (mappa ? mappa.nome : '');
        if (mappa && mappa.cod_api) {
            if (!v.voci.some((x) => x.app === mappa.app && x.cod === mappa.cod_api)) {
                v.voci.push({ app: mappa.app, cod: mappa.cod_api, desc: nomeDb || mappa.nome });
            }
        } else {
            // Registro non traducibile: l'elenco lo chiede al catalogo del PdA.
            v.dalCatalogo = true;
            if (nomeDb) v.nomeAltro = nomeDb;
        }
    }
    esito.uffici = perUfficio.size;
    log('RICERCA API: uffici distinti=' + perUfficio.size + ' (dalle ' + righe.length + ' righe DB)');

    const annoOggi = new Date().getFullYear();
    const anni = [];
    for (let a = annoOggi; a >= annoOggi - ANNI_INDIETRO; a--) anni.push(a);

    await postBackend({
        azione: 'progresso_set',
        stato: 'in_corso',
        ordine: esito.ordine,
        provincia: esito.provincia,
        uffici_totali: perUfficio.size,
        uffici_fatti: 0,
        fascicoli_trovati: 0,
        fascicoli_salvati: 0,
        errori: 0,
        messaggio: 'Ricerca diretta sul portale: ' + perUfficio.size + ' uffici',
    });

    const viste = new Set();
    let indice = 0;

    for (const [cod, v] of perUfficio) {
        indice++;
        log('--- RICERCA API [' + indice + '/' + perUfficio.size + '] ' + cod + ' "' + v.ufficio.nome + '"');

        // Il distretto sta gia' nel database (tab_uffici_giudiziari.gestore): si
        // interroga il catalogo del portale solo se manca, o se servono i
        // registri che il DB non sa tradurre (es. Giudice di Pace).
        const distrettoDb = String(v.ufficio.gestore || '').toUpperCase();
        let voci = v.voci.slice();
        let cat = null;
        if (!distrettoDb || v.dalCatalogo || !voci.length) {
            cat = await catalogoUfficio(cod, cf, log);
        }
        const distretto = distrettoDb || (cat && cat.distretto) || '';
        if (!distretto) {
            esito.scoperti.push(cod);
            esito.ultimoErrore = 'distretto sconosciuto per ' + v.ufficio.nome;
            log('    ✗ ' + esito.ultimoErrore);
            continue;
        }
        if (cat && cat.registri.length && (v.dalCatalogo || !voci.length)) {
            for (const r of cat.registri) {
                if (!voci.some((x) => x.app === r.app && x.cod === r.cod)) voci.push(r);
            }
        }
        if (!voci.length && v.dalCatalogo) {
            voci = REGISTRI_GDP.map((r) => ({ app: r.app, cod: r.cod, desc: v.nomeAltro || r.desc }));
            log('    registri non noti: uso i codici del Giudice di Pace');
        }
        if (!voci.length) {
            esito.scoperti.push(cod);
            esito.ultimoErrore = 'nessun registro noto per ' + v.ufficio.nome;
            log('    ✗ ' + esito.ultimoErrore);
            continue;
        }
        log('    distretto=' + distretto + (distrettoDb ? ' (dal database)' : ' (dal catalogo del portale)')
            + ' registri=' + JSON.stringify(voci.map((x) => x.app + ':' + x.cod)));

        const daSalvare = [];
        let riusciteUff = 0;
        let erroriUff = 0;
        let ultimoRegistro = '';

        for (const voce of voci) {
            ultimoRegistro = voce.desc || voce.cod;
            await postBackend({
                azione: 'progresso_set',
                stato: 'in_corso',
                ordine: esito.ordine,
                provincia: esito.provincia,
                ufficio_corrente: v.ufficio.nome,
                registro_corrente: ultimoRegistro,
                uffici_totali: perUfficio.size,
                uffici_fatti: indice - 1,
                fascicoli_trovati: esito.trovati,
                fascicoli_salvati: esito.salvati,
                errori: esito.errori,
                messaggio: v.ufficio.nome + ' — ' + ultimoRegistro,
            });

            const ris = await ricercaRegistro(v.ufficio, voce, distretto, cf, anni, log);
            esito.chiamate += ris.chiamate;
            if (!ris.ok) {
                esito.errori++;
                erroriUff++;
                esito.ultimoErrore = voce.cod + ': ' + (ris.errore || 'errore');
                log('    ✗ ' + voce.app + ':' + voce.cod + ' → ' + esito.ultimoErrore);
                await sleep(API_PAUSA_FRA_CHIAMATE);
                continue;
            }
            esito.riuscite++;
            riusciteUff++;
            let nuovi = 0;
            // La finestra e' "anno corrente - ANNI_INDIETRO": la ricerca senza
            // anno riporta anche fascicoli molto vecchi, che non vanno scaricati.
            for (const f of ris.fascicoli) {
                const annoF = parseInt(f.anno_ruolo, 10) || 0;
                if (annoF && (annoF < annoOggi - ANNI_INDIETRO || annoF > annoOggi)) continue;
                const k = chiaveFasc(f);
                if (viste.has(k)) continue;
                viste.add(k);
                daSalvare.push(f);
                nuovi++;
            }
            esito.trovati += nuovi;
            log('    ✓ ' + voce.app + ':' + voce.cod + ' → ' + ris.fascicoli.length + ' fascicoli (' + nuovi + ' nuovi)');
            await sleep(API_PAUSA_FRA_CHIAMATE);
        }

        if (!riusciteUff) {
            // Nessuna ricerca riuscita: l'ufficio resta scoperto, e i tentativi
            // falliti non si contano come errori di sincronizzazione (lo rifara'
            // il percorso classico).
            esito.scoperti.push(cod);
            esito.errori -= erroriUff;
            log('    ✗ nessuna ricerca riuscita per questo ufficio');
            continue;
        }
        esito.codiciFatti.push(cod);
        esito.nomiUffici[cod] = String(v.ufficio.nome || cod);

        // 3. Salvataggio a blocchi dell'anagrafica trovata.
        for (let p = 0; p < daSalvare.length; p += MAX_BATCH) {
            const blocco = daSalvare.slice(p, p + MAX_BATCH);
            const resp = await postBackend({ azione: 'salva_batch', fascicoli: blocco });
            if (resp && (resp.inseriti != null || resp.aggiornati != null)) {
                esito.salvati += (resp.inseriti || 0) + (resp.aggiornati || 0);
                esito.errori += (resp.errori || 0);
                if (resp.dettaglio_errori && resp.dettaglio_errori.length) {
                    esito.ultimoErrore = String(resp.dettaglio_errori[0]);
                    log('    errore salvataggio: ' + esito.ultimoErrore);
                }
            } else {
                esito.errori += blocco.length;
                esito.ultimoErrore = (resp && resp.error) || 'errore salvataggio blocco';
                log('    ✗ ' + esito.ultimoErrore);
            }
        }

        // Elenco per la fase documenti: gli stessi campi della sync veloce
        // (link, ufficio, numero, etichetta) piu' le parti, che servono a dare
        // un nome alle cartelle quando il PdA non le riporta (tipico SIGP).
        for (const f of daSalvare) {
            esito.lista.push({
                link: f.link,
                ufficio: f.id_ufficio,
                registro: f.registro,
                numero: f.anno_ruolo + '/' + f.numero_ruolo,
                etichetta: etichettaFasc(f),
                parti: f.parti,
            });
        }

        await postBackend({
            azione: 'progresso_set',
            stato: 'in_corso',
            ordine: esito.ordine,
            provincia: esito.provincia,
            ufficio_corrente: v.ufficio.nome,
            registro_corrente: ultimoRegistro,
            uffici_totali: perUfficio.size,
            uffici_fatti: indice,
            fascicoli_trovati: esito.trovati,
            fascicoli_salvati: esito.salvati,
            errori: esito.errori,
            messaggio: v.ufficio.nome + ' — ' + daSalvare.length + ' fascicoli',
        });
    }

    esito.ok = esito.riuscite > 0;
    if (!esito.ok) esito.motivo = esito.ultimoErrore || 'nessuna ricerca riuscita';
    log('RICERCA API: chiamate=' + esito.chiamate + ' riuscite=' + esito.riuscite
        + ' trovati=' + esito.trovati + ' salvati=' + esito.salvati + ' errori=' + esito.errori
        + ' uffici scoperti=' + esito.scoperti.length);
    return esito;
}
