/**
 * PCT Monitor - Fase documenti SENZA finestra del PdA.
 *
 * Questo script gira nel documento offscreen (offscreen.html) insieme al motore
 * pda_download.js. Prende l'elenco dei fascicoli trovato dalla ricerca (che ora
 * la fa il server o il service worker) e ne scarica i documenti nuovi, uno
 * blocco per volta, salvandoli sul PC dell'avvocato tramite AstarFirmaServer
 * (le chiamate a localhost passano dal background, come prima).
 *
 * Perche' offscreen e non una finestra del PdA: la finestra, anche ridotta a
 * icona, viene throttlata da Chrome e rallenta tutto lo scarico; inoltre appare
 * all'utente e mostra gli avvisi del portale. Qui non c'e' nessuna finestra.
 *
 * Il banner a video non esiste piu': l'avanzamento va sul modale della
 * dashboard (progresso_set) e nel log di sincronizzazione, come prima.
 */
'use strict';

// Fascicoli lavorati in parallelo: lo stesso numero del ripasso veloce nella
// pagina (dentro ogni fascicolo il motore scarica 8 documenti alla volta, con un
// tetto globale in pda_download.js che evita di ingolfare AstarFirmaServer).
const PARALLELI = 5;

let inCorso = false;

function bg(msg) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage(msg, (resp) => {
                if (chrome.runtime.lastError) { resolve({ error: chrome.runtime.lastError.message }); return; }
                resolve(resp || { error: 'nessuna risposta dal background' });
            });
        } catch (e) { resolve({ error: String(e) }); }
    });
}

/** Riga nel log di sincronizzazione (logs/sync_ordine.log). */
function slog(ctx, msg) {
    try {
        chrome.runtime.sendMessage({ action: 'logLine', base: ctx.base, cf: ctx.cf, msg }, () => {
            void chrome.runtime.lastError;
        });
    } catch (e) { /* il log non e' critico */ }
}

/** POST al backend passando dal background (unico punto che conosce i ripieghi). */
function postBackend(ctx, payload) {
    return bg({
        action: 'syncToBackend',
        backendUrl: ctx.ordineUrl,
        apiToken: ctx.apiToken,
        cfAvvocato: ctx.cf,
        data: payload,
    });
}

function progresso(ctx, dati) {
    return postBackend(ctx, Object.assign({ azione: 'progresso_set' }, dati)).catch(() => {});
}

/** Access token del PdA, rinnovato dal background quando sta per scadere. */
async function token(ctx) {
    const r = await bg({ action: 'pdaTokenFresh' });
    const t = (r && r.access) || '';
    if (t) ctx.token = t;
    return ctx.token || '';
}

/**
 * Parte del fascicolo rappresentata dall'avvocato: nome di ripiego per gli atti
 * di parte quando il tree del PdA non riporta la parte (tipico del Giudice di
 * Pace). Stessa scelta che faceva lo scraper nella pagina.
 */
function parteFallback(f) {
    const parti = (f && f.parti) || [];
    if (!parti.length) return null;
    let cfAvv = '';
    try {
        const seg = String(f.link || '').split('/');
        const iAvv = seg.lastIndexOf('AVV');
        if (iAvv > 0) cfAvv = String(seg[iAvv - 1] || '').toUpperCase();
    } catch (e) { /* link inatteso */ }
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
        nome,
        cf: String(scelta.cf_parte || '').toUpperCase(),
    };
}

/** Campi di scheda che il motore ricava dalle comunicazioni di cancelleria. */
function schedaDi(res) {
    const out = {};
    const campi = ['giudice', 'sezione', 'oggetto', 'data_prossima_udienza', 'data_ultima_udienza'];
    for (const c of campi) if (res[c]) out[c] = res[c];
    if (Array.isArray(res.aggiornamenti) && res.aggiornamenti.length) out.aggiornamenti = res.aggiornamenti;
    if (Array.isArray(res.parti) && res.parti.length) out.parti = res.parti;
    // Difensori letti dagli XML delle buste: parte → avvocato.
    if (Array.isArray(res.difensori) && res.difensori.length) out.difensori = res.difensori;
    // Partecipanti letti dagli XML delle buste, col CF che fa fede: il backend
    // li usa per correggere i CF sbagliati che il Portale riporta in elencoPartiEC.
    if (Array.isArray(res.parti_xml) && res.parti_xml.length) out.parti_xml = res.parti_xml;
    return out;
}

/** Contesto della corsa in corso: serve alle righe di diagnostica. */
let ctxDiag = null;
const campiEventoVisti = {};

/** Un fascicolo: stessa semantica di chiamataScarico() nello scraper. */
async function scarica(f, tk, forza) {
    try {
        if (!window.PctDownload || !window.PctDownload.scaricaFascicoloPC) {
            return { ok: false, motivo: 'motore di scarico non caricato' };
        }
        // attiSempre: il motore legge storico, profilo e parti anche quando i
        // documenti sono tutti sul PC. Serve in tre casi:
        //   - il pannello non ha ancora nessun atto per questo fascicolo;
        //   - lo ha chiesto chi chiama (pulsante "Sync fascicolo": chi lo preme
        //     vuole il fascicolo riallineato, non un "+0 documenti" in un secondo);
        //   - il registro e' noto e non e' SICID ne' SIECIC, perche' per gli
        //     altri (SIGP) il passo server di lettura schede non esiste e senza
        //     questo la cronologia non si aggiornerebbe mai. Se il registro non
        //     e' noto NON si forza: meglio un dato da riallineare che la lettura
        //     lenta su tutti i fascicoli della corsa.
        const senzaAttiNelDb = Number(f.n_atti || 0) === 0;
        const area = String(f.registro || f.area || '').toUpperCase();
        const senzaPassoServer = area !== '' && area !== 'SICID' && area !== 'SIECIC';
        const res = await window.PctDownload.scaricaFascicoloPC(f.link, tk, {
            parteFallback: parteFallback(f),
            attiSempre: senzaAttiNelDb || !!forza || senzaPassoServer,
        });
        if (!res) return { ok: false, motivo: 'nessuna risposta dal motore di scarico' };
        // Una riga sola per registro: i nomi dei campi data che il Portale usa
        // nella cronologia. Senza questo, su un registro che battezza la data
        // dell'evento a modo suo si resta a indovinare.
        try {
            const dg = window.PctDownload.ultimiCampiEvento;
            if (dg && dg.campi && !campiEventoVisti[dg.area] && ctxDiag) {
                campiEventoVisti[dg.area] = true;
                slog(ctxDiag, '  [campi data cronologia ' + dg.area + '] ' + dg.campi);
            }
        } catch (e) { /* diagnostica non critica */ }
        const d = res.documenti || {};
        const haGirato = res.documenti && (d.nel_fascicolo || d.scaricati || d.gia_presenti);
        if (!res.ok && !haGirato) {
            return {
                ok: false,
                motivo: res.messaggio || 'scarico non riuscito',
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
            tempi: d.tempi || null,
            cache: !!res.saltatoDaCache,
            atti: res.atti || [],
            // Scheda letta dalle comunicazioni di cancelleria (giudice, sezione,
            // oggetto, udienze, eventi): va salvata col fascicolo, altrimenti il
            // pannello resta con "—" nelle udienze e "Aggiornamenti (0)".
            scheda: schedaDi(res),
        };
    } catch (e) {
        return { ok: false, motivo: (e && e.message) || String(e) };
    }
}

const seiTokenScaduto = (motivo) => /token|401|403|autenticaz|sessione|scadut/i.test(motivo || '');
const guastoPasseggero = (motivo) => /HTTP 5\d\d|timed out|timeout|queued for execution|Errore del server|riprova piu|riprova più|recuperare le informazioni/i.test(motivo || '');

/** Scarico dell'intero elenco, a blocchi, con un solo ripasso finale. */
async function eseguiScarico(p) {
    const ctx = {
        base: p.base,
        ordineUrl: p.ordineUrl,
        apiToken: p.apiToken,
        cf: p.cf,
        token: '',
    };
    ctxDiag = ctx;
    const lista = (p.lista || []).filter((f) => f && f.link && f.link.indexOf('/dettaglio-fascicolo/') !== -1);
    const uffMap = p.uffici || {};
    const tot = lista.length;
    const esito = { tot, fatti: 0, nuovi: 0, presenti: 0, errori: 0, bloccati: 0 };
    if (!tot) return esito;

    // Il record di progresso e' uno solo per avvocato: lo scrivono sia la sync
    // per ufficio sia il pulsante "Sync fascicolo" del dettaglio. Senza un
    // marchio la pagina del fascicolo finisce per mostrare il messaggio della
    // corsa massiva ("Scarico documenti: 2023/179/0, 2022/11/0"), dando
    // l'impressione di scaricare fascicoli che nessuno ha chiesto. Qui la corsa
    // di un solo fascicolo si firma con "FASC:" e parla al singolare.
    const soloUno = String(p.ambito || '') === 'fascicolo' && tot === 1;
    const marcaUff = (cod, numeri) => (soloUno ? 'FASC:' + numeri : 'UFF:' + cod + '#' + numeri);

    if (!(await token(ctx))) {
        slog(ctx, 'SCARICO OFFSCREEN: token del PdA non disponibile');
        esito.motivo = 'token del PdA non disponibile';
        return esito;
    }

    // Raggruppa per ufficio, tenendo l'ordine: il modale mostra una
    // circoscrizione alla volta, come faceva la pagina.
    const gruppi = [];
    const indice = {};
    lista.forEach((f) => {
        const cod = String(f.ufficio || '');
        if (!(cod in indice)) {
            indice[cod] = gruppi.length;
            gruppi.push({ cod, nome: (uffMap[cod] || cod || '—'), items: [] });
        }
        gruppi[indice[cod]].items.push(f);
    });

    slog(ctx, 'SCARICO OFFSCREEN (nessuna finestra): ' + tot + ' fascicoli in '
        + gruppi.length + ' circoscrizioni, blocchi da ' + PARALLELI);
    const t0 = Date.now();
    const daRiprovare = [];
    const conAtti = [];

    let dim = PARALLELI;
    let primoBlocco = true;
    let stop = false;
    let rinnovoFallito = 0;   // rinnovi del token andati a vuoto di fila

    await progresso(ctx, {
        stato: 'in_corso', totale: tot, completati: 0,
        ordine: p.ordine || '', provincia: p.provincia || '',
        ufficio_corrente: soloUno ? 'fascicolo singolo' : ('0/' + tot + ' fascicoli'),
        registro_corrente: (gruppi[0] || {}).nome || '',
        numero_fascicolo_corrente: marcaUff(((gruppi[0] || {}).cod || ''), String((lista[0] || {}).numero || '')),
        fascicoli_totali_ricerca: tot,
        messaggio: soloUno
            ? 'Scarico i documenti del fascicolo'
            : ('Scarico documenti: ' + tot + ' fascicoli'),
    });

    for (const grp of gruppi) {
        let i = 0;
        while (i < grp.items.length) {
            const blocco = grp.items.slice(i, i + dim);
            i += blocco.length;
            const numeri = blocco.map((f) => String(f.numero || '')).filter(Boolean).join(', ');
            await progresso(ctx, {
                stato: 'in_corso', totale: tot, completati: esito.fatti,
                ordine: p.ordine || '', provincia: p.provincia || '',
                ufficio_corrente: soloUno ? 'fascicolo singolo' : (esito.fatti + '/' + tot + ' fascicoli'),
                registro_corrente: grp.nome,
                numero_fascicolo_corrente: marcaUff(grp.cod, numeri),
                fascicolo_corrente: esito.fatti, fascicoli_totali_ricerca: tot,
                percentuale_fascicolo: tot ? Math.round((esito.fatti / tot) * 100) : 0,
                messaggio: soloUno
                    ? 'Scarico i documenti del fascicolo'
                    : ('Scarico documenti: ' + numeri),
            });

            const tk = await token(ctx);
            // La barra va mossa DURANTE il blocco: lo scarico dei documenti di un
            // blocco dura minuti e, aggiornando solo prima e dopo, restava a 0%
            // per tutto il tempo sembrando bloccata. Scrittura al massimo ogni
            // 2,5s, piu' una finale garantita.
            let risultati = await (async function () {
                let finiti = 0, ultimoPush = Date.now();
                const spingi = async (forza) => {
                    if (!forza && (Date.now() - ultimoPush) < 2500) return;
                    ultimoPush = Date.now();
                    const fattiOra = esito.fatti + finiti;
                    await progresso(ctx, {
                        stato: 'in_corso', totale: tot, completati: fattiOra,
                        ordine: p.ordine || '', provincia: p.provincia || '',
                        ufficio_corrente: soloUno ? 'fascicolo singolo' : (fattiOra + '/' + tot + ' fascicoli'),
                        registro_corrente: grp.nome,
                        numero_fascicolo_corrente: marcaUff(grp.cod, numeri),
                        fascicolo_corrente: fattiOra, fascicoli_totali_ricerca: tot,
                        percentuale_fascicolo: tot ? Math.round((fattiOra / tot) * 100) : 0,
                        messaggio: soloUno
                            ? 'Scarico i documenti del fascicolo'
                            : ('Scarico documenti: ' + numeri),
                    });
                };
                return await Promise.all(blocco.map(async (f) => {
                    const res = await scarica(f, tk, soloUno);
                    finiti++;
                    await spingi(finiti === blocco.length);
                    return { f, res };
                }));
            })();

            // Token rifiutato a metà corsa: lo si rinnova UNA volta e si ritenta
            // solo chi e' caduto per quel motivo. Se il rinnovo torna lo STESSO
            // token (refresh scaduto, vive ~30 minuti) ritentare e' inutile: si
            // ripeterebbe lo stesso 401 su tutti i fascicoli restanti.
            const tokKO = risultati.filter((x) => !x.res.ok && seiTokenScaduto(x.res.motivo));
            if (tokKO.length) {
                const tk2 = await token(ctx);
                if (tk2 && tk2 !== tk) {
                    rinnovoFallito = 0;
                    slog(ctx, '  token rinnovato, ritento ' + tokKO.length + ' fascicoli');
                    for (const x of tokKO) x.res = await scarica(x.f, tk2, soloUno);
                } else {
                    rinnovoFallito++;
                    slog(ctx, '  sessione PdA scaduta, rinnovo non possibile (' + rinnovoFallito + '/2)');
                    if (rinnovoFallito >= 2) {
                        stop = true;
                        esito.motivo = 'sessione PdA scaduta: riapri il portale e accedi con la CNS';
                    }
                }
            }

            let vuote = 0;
            for (const { f, res } of risultati) {
                esito.fatti++;
                if (res.ok) {
                    esito.nuovi += res.scaricati;
                    esito.presenti += res.presenti;
                    if (res.documenti > 0 && !res.scaricati && !res.presenti) vuote++;
                    // Si salva anche quando l'elenco atti non torna ma la scheda
                    // si': cronologia, udienze e parti valgono da sole.
                    if (res.scheda && Object.keys(res.scheda).length) {
                        conAtti.push(Object.assign({}, f, res.scheda, { atti: res.atti || [] }));
                    } else if (res.atti && res.atti.length) {
                        conAtti.push(Object.assign({}, f, { atti: res.atti }));
                    }
                    slog(ctx, '    ⤓ ' + (f.etichetta || f.numero) + ': +' + res.scaricati
                        + ' nuovi su ' + res.documenti + ' (' + res.presenti + ' presenti, '
                        + res.falliti + ' falliti, ' + res.megabyte + ' MB'
                        + (res.cache ? ', verificato di recente: portale non interrogato' : '') + ')');
                    // Ripartizione dei secondi: serve a capire se il tempo lo
                    // prende il portale, il disco o le fasi preliminari.
                    if (res.tempi) {
                        const t = res.tempi;
                        slog(ctx, '      tempi ' + (res.secondi || 0) + 's: elenco=' + t.elenco
                            + 's (risveglio=' + (t.stato || 0) + 's lista=' + (t.lista || 0) + 's)'
                            + ' parti=' + t.parti + 's disco_elenco=' + t.locale
                            + 's scarico=' + t.scarico + 's (rete=' + t.rete + 's disco=' + t.disco + 's)'
                            + ' storico=' + (t.storico || 0) + 's parti_pda=' + (t.portale || 0)
                            + 's udienza=' + (t.udienza || 0) + 's buste=' + (t.buste || 0)
                            + 's x' + (t.nbuste || 0)
                            + ' | manifest noti=' + (t.noti || 0) + '/' + (t.tot || 0)
                            + ' senza_id=' + (t.senzaId || 0)
                            + ' segnaposto=' + (t.segnaposto === 2 ? 'gia_tentato'
                                : (t.segnaposto === 1 ? 'da_risolvere' : 'no')));
                    }
                } else {
                    esito.errori++;
                    if (res.riprovabile || guastoPasseggero(res.motivo)) {
                        esito.bloccati++;
                        if (daRiprovare.length < 80 && !daRiprovare.some((x) => x.link === f.link)) daRiprovare.push(f);
                    }
                    slog(ctx, '    ✗ ' + (f.etichetta || f.numero) + ': ' + res.motivo);
                }
            }

            // Buste vuote a raffica: sospetto di concorrenza sulla sessione del
            // portale, si passa a seriale come faceva il percorso in pagina.
            if (dim > 1 && vuote >= Math.max(2, Math.ceil(blocco.length / 2))) {
                dim = 1;
                slog(ctx, '  buste vuote in parallelo (' + vuote + '/' + blocco.length + ') → passo a seriale');
            }

            // Primo blocco tutto fallito: molto probabilmente il portale non
            // accetta le chiamate da qui (Origin dell'estensione) o la sessione
            // e' caduta. Inutile macinare tutto l'elenco: si esce e il service
            // worker ripiega sulla finestra.
            if (primoBlocco) {
                primoBlocco = false;
                if (risultati.length && risultati.every((x) => !x.res.ok)) {
                    esito.motivo = 'primo blocco tutto in errore: ' + (risultati[0].res.motivo || 'motivo non noto');
                    slog(ctx, 'SCARICO OFFSCREEN interrotto — ' + esito.motivo);
                    esito.bloccoTotale = true;
                    stop = true;
                    break;
                }
            }

            // Sessione finita: i risultati del blocco sono stati contati, si esce.
            if (stop) {
                slog(ctx, 'SCARICO OFFSCREEN interrotto — ' + (esito.motivo || 'sessione non valida'));
                break;
            }
        }
        if (stop) break;
    }

    if (stop) return esito;

    // Ripasso unico dei fascicoli che il documentale aveva rifiutato perche'
    // occupato: poco dopo lo stesso fascicolo risponde bene.
    if (daRiprovare.length) {
        slog(ctx, '  ↻ ripasso documenti: ' + daRiprovare.length + ' fascicoli, attendo 15s');
        await new Promise((r) => setTimeout(r, 15000));
        for (let z = 0; z < daRiprovare.length; z++) {
            const f = daRiprovare[z];
            await progresso(ctx, {
                stato: 'in_corso', totale: tot, completati: esito.fatti,
                ordine: p.ordine || '', provincia: p.provincia || '',
                messaggio: 'Ripasso documenti ' + (z + 1) + '/' + daRiprovare.length,
            });
            const res = await scarica(f, await token(ctx), soloUno);
            if (res.ok) {
                esito.nuovi += res.scaricati;
                esito.presenti += res.presenti;
                if (esito.errori > 0) esito.errori--;
                if (esito.bloccati > 0) esito.bloccati--;
                if (res.scheda && Object.keys(res.scheda).length) {
                    conAtti.push(Object.assign({}, f, res.scheda, { atti: res.atti || [] }));
                } else if (res.atti && res.atti.length) {
                    conAtti.push(Object.assign({}, f, { atti: res.atti }));
                }
                slog(ctx, '    ⤓ (ripasso) ' + (f.etichetta || f.numero) + ': +' + res.scaricati + ' nuovi');
            } else {
                slog(ctx, '    ✗ (ripasso) ' + (f.etichetta || f.numero) + ': ' + res.motivo);
            }
        }
    }

    // I file stanno sul PC; al backend vanno solo i metadati degli atti, cosi'
    // la colonna Fascicoli resta popolata (nessun file su Aruba).
    // L'esito va guardato: se il server scarta il batch (campi obbligatori
    // mancanti) i documenti restano sul PC ma il fascicolo appare "Atti (0)".
    // Prima l'errore veniva inghiottito e il problema era invisibile.
    let attiSalvati = 0, attiScartati = 0;
    const tBatch = Date.now();
    for (let q = 0; q < conAtti.length; q += 50) {
        const lotto = conAtti.slice(q, q + 50);
        const r = await postBackend(ctx, { azione: 'salva_batch', fascicoli: lotto })
            .catch((e) => ({ error: (e && e.message) || 'invio non riuscito' }));
        // ATTENZIONE: syncToBackend incapsula la risposta del server in
        // { success: true, result: <json del server> }. Leggendo r.errori si
        // guardava sempre un campo inesistente, percio' ogni scarto del server
        // passava per riuscito e il log diceva "✓ atti registrati" mentre il
        // pannello restava a "Atti (0)". L'esito vero sta in r.result.
        const risp = (r && r.result) || r || {};
        const koServer = Number(risp.errori || 0);
        const ko = koServer || ((r && r.error) ? lotto.length : 0);
        attiScartati += ko;
        attiSalvati += lotto.length - ko;
        if (ko) {
            const perche = risp.dettaglio_errori || (r && r.error) || 'motivo non indicato';
            slog(ctx, '    ! atti NON salvati sul pannello per ' + ko + ' fascicoli: '
                + (typeof perche === 'string' ? perche : JSON.stringify(perche).slice(0, 300)));
        }
    }
    if (attiSalvati) {
        slog(ctx, '    ✓ atti registrati nel pannello per ' + attiSalvati + ' fascicoli'
            + ' (salvataggio sul server ' + Math.round((Date.now() - tBatch) / 100) / 10 + 's)');
    }

    const secs = Math.round((Date.now() - t0) / 1000);
    const nomi = gruppi.map((g) => g.nome).filter((n) => n && n !== '—');
    let registroFine = nomi.join(', ');
    if (registroFine.length > 60) registroFine = nomi.length + ' circoscrizioni';
    // Se il server ha scartato gli atti, i documenti sono sul PC ma il pannello
    // resta vuoto: dirlo, invece di annunciare "completata" in verde.
    const codaScarti = attiScartati
        ? ' — ATTENZIONE: il pannello non ha registrato gli atti, vedi Log sync'
        : '';
    const messaggio = (soloUno
        ? ('Sincronizzazione completata: +' + esito.nuovi + ' documenti (' + secs + 's)'
            + (esito.errori ? ', con errore' : ''))
        : ('Sincronizzazione completata: +' + esito.nuovi + ' documenti su ' + tot
            + ' fascicoli (' + secs + 's)' + (esito.errori ? (', ' + esito.errori + ' con errore') : '')))
        + codaScarti;
    await progresso(ctx, {
        stato: (esito.errori || attiScartati) ? 'completato_con_errori' : 'completato',
        totale: tot, completati: esito.fatti,
        ordine: p.ordine || '', provincia: p.provincia || '',
        ufficio_corrente: soloUno ? 'fascicolo singolo' : (esito.fatti + '/' + tot + ' fascicoli'),
        registro_corrente: registroFine,
        numero_fascicolo_corrente: soloUno
            ? ('FASC:' + String((lista[0] || {}).numero || ''))
            : ('UFF:' + gruppi.map((g) => g.cod).filter(Boolean).join('|')),
        fascicolo_corrente: 0, fascicoli_totali_ricerca: soloUno ? 1 : 0, percentuale_fascicolo: 100,
        messaggio,
    });
    slog(ctx, 'SCARICO OFFSCREEN completato: fascicoli=' + tot + ' nuovi=' + esito.nuovi
        + ' presenti=' + esito.presenti + ' errori=' + esito.errori + ' in ' + secs + 's');
    esito.secondi = secs;
    esito.messaggio = messaggio;
    return esito;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.action !== 'offscreenScarica') return false;
    if (inCorso) { sendResponse({ avviato: false, error: 'scarico già in corso' }); return false; }
    inCorso = true;
    sendResponse({ avviato: true });
    eseguiScarico(message.payload || {})
        .then((esito) => {
            chrome.runtime.sendMessage({ action: 'offscreenFinito', esito }, () => { void chrome.runtime.lastError; });
        })
        .catch((e) => {
            chrome.runtime.sendMessage({
                action: 'offscreenFinito',
                esito: { errore: (e && e.message) || String(e) },
            }, () => { void chrome.runtime.lastError; });
        })
        .finally(() => { inCorso = false; });
    return false;
});
