/**
 * PCT Monitor - Scarico diretto dei documenti sul PC dell'avvocato.
 *
 * Porta in JavaScript il contratto di pda_diretto.php (lato server), ma eseguito
 * qui, nel content script della pagina del PdA: le chiamate alle API del portale
 * (elenco atti e download delle buste) sono cosi' SAME-ORIGIN, identiche a quelle
 * che fa la webapp, e non incappano ne' in CORS ne' in blocchi mixed-content.
 *
 * I file NON passano piu' da Aruba: ogni busta scaricata viene consegnata al
 * servizio locale AstarFirmaServer (http://localhost:8766) che la salva in
 * Documenti\PCT Monitor\<fascicolo>\<parte>\<file>. Aruba conserva solo i
 * metadati (fascicoli/atti), salvati altrove via api_sync.php.
 *
 * Le chiamate a localhost:8766 non possono partire da questa pagina https
 * (mixed-content): le inoltra il background (astarStatus / astarElenco /
 * astarSalva), che vive nell'origine dell'estensione.
 *
 * Espone: window.PctDownload.scaricaFascicoloPC(url, token, { onProgress })
 */
(function () {
    'use strict';

    // Misurato sul campo (83 documenti, 23 MB): rete del portale 299s di lavoro
    // cumulato contro 5,7s di scrittura su disco. Il collo di bottiglia e' la
    // latenza del portale (~3,6s per documento, file piccoli), non la banda e non
    // AstarFirmaServer: l'unica leva vera e' tenere piu' richieste in volo.
    const PARALLELE = 14; // documenti scaricati in parallelo DENTRO un singolo fascicolo.
    // La sync massiva elabora piu' fascicoli insieme, quindi il limite per fascicolo
    // non basta: 5 fascicoli x 8 documenti farebbero 40 richieste contemporanee e
    // AstarFirmaServer (servizio locale a thread limitati) si ingolfa, con buste
    // che tornano vuote. Qui c'e' un tetto GLOBALE valido per tutti i fascicoli in
    // corso: un fascicolo da solo mantiene la velocita' di prima, tanti insieme si
    // spartiscono i posti invece di moltiplicarli.
    //
    // Due code distinte, non una: il collo di bottiglia da proteggere e' il
    // servizio locale che scrive i file, NON il portale. Con una coda sola il
    // posto restava occupato anche durante base64 + scrittura su disco, quindi il
    // portale stava fermo ad aspettare il disco e si scaricava un file alla volta
    // per corsia. Ora la busta si scarica (coda portale), il posto si libera
    // subito e il salvataggio prosegue nella sua coda.
    const PARALLELE_TOTALI = 24;   // buste scaricate dal portale insieme (tutti i fascicoli)
    const SALVA_TOTALI = 8;        // scritture contemporanee su AstarFirmaServer

    /** Semaforo elementare: n posti, chi non trova posto aspetta in coda. */
    function semaforo(n) {
        let inCorso = 0;
        const attesa = [];
        return {
            prendi() {
                if (inCorso < n) { inCorso++; return Promise.resolve(); }
                return new Promise((ok) => attesa.push(ok));
            },
            libera() {
                const prossimo = attesa.shift();
                if (prossimo) prossimo();
                else inCorso = Math.max(0, inCorso - 1);
            },
        };
    }
    const semPortale = semaforo(PARALLELE_TOTALI);
    const semSalva = semaforo(SALVA_TOTALI);

    // Cronometri del fascicolo in corso: li riempiono anche i passi annidati
    // (lettura delle buste dei depositi) e finiscono nel log del sync, cosi'
    // si vede quale fase si mangia i secondi quando non c'e' nulla da scaricare.
    let tempiExtra = null;

    /**
     * Esegue fn su tutti gli elementi con n lavoratori CONTINUI, non a ondate.
     * Le ondate (slice + Promise.all) aspettano il piu' lento del gruppo prima
     * di far partire il successivo: col portale, dove una chiamata su dieci ci
     * mette secondi, si perde piu' tempo in attesa che in lavoro.
     */
    async function inPool(items, n, fn) {
        const out = new Array(items.length);
        let i = 0;
        const worker = async () => {
            while (i < items.length) {
                const k = i++;
                try { out[k] = await fn(items[k], k); }
                catch (e) { out[k] = undefined; }
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
        return out;
    }

    /** Prende un posto fra i download concorrenti, aspettando se sono tutti pieni. */
    function prendiPosto() { return semPortale.prendi(); }

    /** Libera il posto e fa partire il primo in coda. */
    function liberaPosto() { semPortale.libera(); }

    // ── Utilita' ──────────────────────────────────────────────────────────────

    /** Ripulisce un pezzo di percorso dai caratteri che Windows rifiuta. */
    function pulisci(s) {
        s = String(s == null ? '' : s).replace(/[\\/:*?"<>|]/g, '_');
        s = s.replace(/\s+/g, ' ').trim();
        return s.replace(/[ .]+$/, '');
    }

    /** Scompone l'indirizzo della pagina del fascicolo (come pda_url_fascicolo). */
    function parseUrl(url) {
        const h = /^(https?:\/\/[^/]+)\/(pda-[a-z]{2})\//i.exec(url);
        if (!h) return null;

        let m, registro, anno, numero, sub, cf, ruolo;
        m = /\/dettaglio-fascicolo\/([A-Za-z]+)\/([A-Za-z]+)\/(\d+)\/([A-Za-z][A-Za-z0-9]*)\/(\d{4})\/(\d+)\/(\d+)\/([A-Za-z0-9]+)(?:\/([A-Za-z]+))?/.exec(url);
        if (m) {
            registro = m[4].toUpperCase();
            anno = m[5]; numero = m[6]; sub = m[7]; cf = m[8]; ruolo = m[9] || 'AVV';
        } else {
            m = /\/dettaglio-fascicolo\/([A-Za-z]+)\/([A-Za-z]+)\/(\d+)\/(\d{4})\/(\d+)\/(\d+)\/([A-Za-z0-9]+)(?:\/([A-Za-z]+))?/.exec(url);
            if (!m) return null;
            registro = '';
            anno = m[4]; numero = m[5]; sub = m[6]; cf = m[7]; ruolo = m[8] || 'AVV';
        }

        const F = {
            host: h[1].replace(/\/+$/, ''),
            contesto: h[2].toLowerCase(),
            area: m[1].toUpperCase(),
            distretto: m[2].toUpperCase(),
            ufficio: m[3],
            registro: registro,
            anno: parseInt(anno, 10),
            numero: parseInt(numero, 10),
            sub: parseInt(sub, 10),
            cf: cf.toUpperCase(),
            ruolo: ruolo.toUpperCase(),
            link: url,
        };
        // In SIECIC il settimo pezzo e' l'idDfa, non il sub-procedimento.
        F.idDfa = '';
        if (F.area === 'SIECIC') { F.idDfa = String(m[7]); F.sub = 0; }

        F.numero_pad = String(F.numero).padStart(8, '0');
        F.etichetta = F.anno + '_' + F.numero
            + (F.sub !== 0 ? '_' + F.sub : '')
            + '_' + F.area + '_' + F.ufficio;
        return F;
    }

    /** Intestazioni comuni: senza X-ROLE il portale risponde 401. */
    function intestazioni(F, token) {
        return {
            'Authorization': 'Bearer ' + token,
            'X-ROLE': F.ruolo,
            'Accept': 'application/json',
        };
    }

    function radiceDocumenti(F) {
        return F.host + '/' + F.contesto + '/api/servizipda-documenti/v1';
    }

    function urlElenco(F) {
        const r = radiceDocumenti(F);
        if (F.area === 'SICID') {
            return r + '/dm/documentiFascicoloSicid/'
                + F.distretto + '/' + F.ufficio + '/' + F.registro + '/'
                + F.anno + '/' + F.numero_pad + '/' + F.sub;
        }
        if (F.area === 'SIECIC') {
            if (F.idDfa === '') return null;
            return r + '/dm/documentiFascicoloSiecic/'
                + F.distretto + '/' + F.ufficio + '/' + F.registro + '/' + F.idDfa;
        }
        if (F.area === 'SIGP') {
            return r + '/dm/documentiFascicoloSigp/'
                + F.distretto + '/' + F.ufficio + '/'
                + F.anno + '/' + F.numero + '/' + F.sub;
        }
        return null;
    }

    function urlStato(F) {
        const u = urlElenco(F);
        if (u === null) return null;
        return u.replace('/dm/documentiFascicolo', '/dm/statoDownloadFascicolo');
    }

    function servizioScarico(F) {
        const mappa = { SICID: 'sicid', SIECIC: 'siecic', SIGP: 'sigp' };
        const s = mappa[F.area];
        return s ? (radiceDocumenti(F) + '/' + s + '/downloadDocumento') : null;
    }

    // ── Profilo del fascicolo: parti col ruolo vero e difensore ─────────────────
    // Stesso endpoint che il portale usa per la testata del fascicolo. Serve a due
    // cose: dare alla cartella il ruolo REALE della parte (attore, convenuto,
    // terzo) invece di un 'AP' di comodo, e riconoscere il depositante nei
    // depositi il cui datiAtto non porta nessuna parte, partendo dall'avvocato
    // che ha firmato la busta.

    function urlProfilo(F) {
        const mappa = { SICID: 'sicid', SIECIC: 'siecic', SIGP: 'sigp' };
        const s = mappa[F.area];
        return s ? (F.host + '/' + F.contesto + '/api/servizipda-' + s + '/v1/profiloFascicolo') : null;
    }

    function corpoProfilo(F) {
        const c = { anno: String(F.anno), idUfficio: F.ufficio, scadTermini: true, distretto: F.distretto };
        if (F.area === 'SIGP') { c.numero = String(F.numero); return c; }
        c.registroSICID = F.registro; c.registro = F.registro;
        if (F.area === 'SIECIC') { c.numero = String(F.numero); c.idDfa = F.idDfa; return c; }
        c.numero = F.numero_pad; c.fascPrecedente = true; return c;
    }

    // ── Storico eventi: la stessa fonte del tab "Aggiornamenti" del portale ─────
    // Prima la cronologia si ricostruiva dai comunicazione.txt scaricati: arrivano
    // solo gli eventi che hanno prodotto una comunicazione di cancelleria (nel
    // fascicolo di prova 7 su 19) e quel file non porta la data di registrazione.
    // Il portale invece ha un endpoint dedicato (storicoFascicolo) che restituisce
    // TUTTI gli eventi con data, data di registrazione e descrizione.

    function urlStorico(F) {
        // Stessa radice del profilo (nel portale sono due metodi dello stesso
        // servizio): si riusa quella che funziona, cambiando solo l'ultimo pezzo.
        const p = urlProfilo(F);
        return p ? p.replace(/\/profiloFascicolo$/, '/storicoFascicolo') : null;
    }

    /** Filtro dello storico: come il profilo, piu' il subprocedimento. */
    function corpoStorico(F) {
        const c = corpoProfilo(F);
        // Per il Giudice di Pace lo storico accetta lo STESSO corpo del profilo
        // (che sul GdP funziona): togliere scadTermini e aggiungere subPro faceva
        // rispondere a vuoto il servizio, e la cronologia finiva ricostruita dalle
        // comunicazioni (una riga sola, senza data di registrazione).
        if (F.area === 'SIGP') return c;
        delete c.scadTermini;
        c.subPro = String(F.sub === '' || F.sub === undefined ? '0' : F.sub);
        return c;
    }

    /**
     * Data del portale -> "YYYY-MM-DD HH:MM" (o solo data). Il servizio puo'
     * mandare millisecondi, ISO o "dd/MM/yyyy HH:mm": vanno accettate tutte,
     * altrimenti la colonna resta vuota senza dire perche'.
     */
    function dataPortale(v) {
        if (v === null || v === undefined || v === '') return '';
        const due = (n) => ('0' + n).slice(-2);
        const daDate = (d) => {
            if (isNaN(d.getTime())) return '';
            const base = d.getFullYear() + '-' + due(d.getMonth() + 1) + '-' + due(d.getDate());
            const ora = due(d.getHours()) + ':' + due(d.getMinutes());
            return ora === '00:00' ? base : base + ' ' + ora;
        };
        if (typeof v === 'number') return daDate(new Date(v));
        const s = String(v).trim();
        if (/^\d{10,}$/.test(s)) return daDate(new Date(Number(s)));
        let m = /^(\d{2})\/(\d{2})\/(\d{4})(?:[\sT]+(\d{1,2})[:.](\d{2}))?/.exec(s);
        if (m) {
            const base = m[3] + '-' + m[2] + '-' + m[1];
            return m[4] ? base + ' ' + due(m[4]) + ':' + m[5] : base;
        }
        // ISO con fuso dichiarato: va CONVERTITO all'ora italiana, non tagliato
        // alla lettera. Il Portale manda gli eventi in UTC, percio' la
        // mezzanotte del 1 ottobre arriva come "2026-09-30T22:00:00Z": leggendo
        // i primi dieci caratteri si sbagliava di un giorno, e con l'ora in coda
        // il server scartava del tutto il valore.
        if (/^\d{4}-\d{2}-\d{2}[T\s].*(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
            const conv = daDate(new Date(s));
            if (conv) return conv;
        }
        m = /^(\d{4})-(\d{2})-(\d{2})(?:[\sT]+(\d{2}):(\d{2}))?/.exec(s);
        if (m) return m[1] + '-' + m[2] + '-' + m[3] + (m[4] ? ' ' + m[4] + ':' + m[5] : '');
        return daDate(new Date(s));
    }

    /** Vero se il valore, normalizzato, somiglia a una data del Portale. */
    function pareData(v) {
        if (v === null || v === undefined || v === '') return false;
        if (typeof v === 'object') return false;
        return /^\d{4}-\d{2}-\d{2}/.test(dataPortale(v));
    }

    /**
     * Data dell'evento, qualunque nome le dia il registro.
     *
     * I nomi noti sono tre e non bastano: il SIGP mostra a video due date
     * distinte ("Data" 28/06/2019 e "Data Registrazione" 04/07/2019 15:06) ma
     * non usa nessuna delle chiavi che conoscevamo, percio' la colonna restava
     * vuota. Invece di indovinare, qui si cercano nell'oggetto TUTTI i campi
     * che contengono una data e si scarta quello di registrazione: resta la
     * data dell'evento, come nome del campo non ci interessa.
     *
     * Si escludono per nome i campi che sono date di altra natura (udienza,
     * scadenza, iscrizione, nascita, notifica): prenderli per data evento
     * sarebbe peggio che lasciare la colonna vuota.
     */
    function dataEventoDaEvento(e, valoreReg) {
        for (const k of ['data', 'dataEvento', 'dataStorico']) {
            if (pareData(e[k])) return dataPortale(e[k]);
        }
        const escluse = /udienza|scadenz|iscrizion|nascita|notific|termin|pubblicaz/i;
        const registrazione = /registra|dataReg/i;
        let ripiego = '';
        for (const k of Object.keys(e)) {
            if (!/data|dt/i.test(k)) continue;
            if (registrazione.test(k) || escluse.test(k)) continue;
            if (!pareData(e[k])) continue;
            const v = dataPortale(e[k]);
            // La data dell'evento e' quella DIVERSA dalla registrazione: se
            // coincidono si tiene comunque, ma si preferisce una differente.
            if (valoreReg && v.slice(0, 10) === String(valoreReg).slice(0, 10)) {
                if (!ripiego) ripiego = v;
                continue;
            }
            return v;
        }
        return ripiego;
    }

    /**
     * Cronologia completa dal portale. Ogni voce: data evento, data di
     * registrazione, descrizione. Niente cache: e' una sola chiamata e la
     * cronologia e' esattamente la cosa che cambia fra una sync e l'altra.
     */
    async function storicoEventi(F, token) {
        const url = urlStorico(F);
        if (!url) return [];
        try {
            const h = Object.assign(intestazioni(F, token), { 'Content-Type': 'application/json' });
            const r = await fetch(url, {
                method: 'POST', headers: h, body: JSON.stringify(corpoStorico(F)), credentials: 'include',
            });
            if (r.status !== 200) return [];
            const j = await r.json();
            const lista = (j && (j.eventoList || j.eventiList || j.lista)) || [];
            if (!Array.isArray(lista)) return [];
            const out = [];
            // Diagnostica: i nomi reali dei campi del primo evento. Serve a
            // inchiodare come si chiama la data nei registri che non seguono le
            // chiavi note (il SIGP), senza dover rifare la cattura di rete.
            // Finisce nel log di sincronizzazione, non in una console nascosta.
            if (lista.length && lista[0] && typeof lista[0] === 'object') {
                try {
                    const campi = Object.keys(lista[0]).filter((k) => /data|dt/i.test(k))
                        .map((k) => k + '=' + String(lista[0][k]).slice(0, 24));
                    window.PctDownload.ultimiCampiEvento = {
                        area: String(F.area || '?'),
                        campi: campi.join(' '),
                        tutti: Object.keys(lista[0]).join(','),
                    };
                } catch (e) { /* la diagnostica non deve mai rompere il sync */ }
            }
            for (const e of lista) {
                if (!e) continue;
                const desc = String(e.desc || e.descrizione || '').replace(/\s+/g, ' ').trim();
                // Ogni registro battezza le due date a modo suo: il SIECIC
                // scrive "dataReg" dove il SICID scrive "dataRegistrazione", e
                // il SIGP usa nomi che non conoscevamo affatto.
                let dReg = dataPortale(e.dataRegistrazione || e.dataReg || e.dataRegEvento);
                let dEv = dataEventoDaEvento(e, dReg);
                // Ripiego incrociato: se una delle due manca si usa il giorno
                // dell'altra, cosi' nessuna riga resta senza data. Senza questo,
                // nel SIGP la colonna "Data evento" era sempre vuota e la
                // cronologia veniva ordinata a caso (si ordina su quel campo).
                if (!dEv && dReg) dEv = dReg.slice(0, 10);
                if (!dReg && dEv) dReg = dEv;
                if (!dEv && !desc) continue;
                out.push({
                    data_evento: dEv, data_registrazione: dReg, descrizione: desc,
                    id_documento: String(e.idDocumento || ''),
                });
            }
            // Doppioni via (lo stesso evento puo' tornare per piu' parti) e ordine
            // cronologico, come il portale.
            const visti = {};
            return out.filter((e) => {
                const k = e.data_evento + '|' + e.data_registrazione + '|' + e.descrizione;
                if (visti[k]) return false;
                visti[k] = true;
                return true;
            }).sort((a, b) => String(a.data_evento).localeCompare(String(b.data_evento)));
        } catch (e) { return []; }
    }

    function normaNome(s) {
        return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    /** Chiave indipendente dall'ordine: il certificato scrive "NOME COGNOME". */
    function chiaveOrdineLibero(s) {
        return normaNome(s).split(' ').filter((x) => x.length > 1).sort().join(' ');
    }

    /** Elenco parti del fascicolo dal profilo e, per SIECIC, dalla lista ufficiale delle parti. */
    async function profiloParti(F, token) {
        const ck = 'pctProfilo3:' + pulisci(F.etichetta);
        try {
            const c = await storageGet(ck);
            if (c && Array.isArray(c.parti) && (Date.now() - (c.t || 0)) < 7 * 86400000) return c.parti;
        } catch (e) { /* si rilegge dal portale */ }
        let parti = [];
        const url = urlProfilo(F);
        if (url !== null) {
            try {
                const r = await fetch(url, {
                    method: 'POST', credentials: 'include',
                    headers: Object.assign(intestazioni(F, token), { 'Content-Type': 'application/json' }),
                    body: JSON.stringify(corpoProfilo(F)),
                });
                if (r.status === 200) {
                    const j = await r.json();
                    const p0 = (j && Array.isArray(j.profiloFascicoloList)) ? j.profiloFascicoloList[0] : null;
                    const lista = (p0 && Array.isArray(p0.infoParteList)) ? p0.infoParteList : [];
                    parti = lista.map((p) => ({
                        cognome: String(p.cognome || '').trim(),
                        nome:    String(p.nome || '').trim(),
                        tipo:    ruoloDaDescrizione(String(p.tipo || '')) || String(p.tipo || '').toUpperCase().trim(),
                        cf:      String(p.codiceFiscaleParte || p.codiceFiscale || '').toUpperCase().trim(),
                        nascita: String(p.dataNascita || '').trim(),
                        avv:     String(p.avvocato || '').trim(),
                        avvCf:   String(p.codiceFiscaleAvvocato || '').toUpperCase().trim(),
                    })).filter((p) => p.cognome !== '' || p.cf !== '');
                }
            } catch (e) { /* best effort: si resta col ruolo di ripiego */ }
        }

        if (F.area === 'SIECIC') {
            try {
                // Le parti dei SIECIC stanno su DUE servizi e il Portale sceglie
                // in base al registro: "elencoPartiEC" per le esecuzioni (ESM,
                // ESIM...), "elencoPartiPC" per le concorsuali (FALL, CP, LCA...).
                // Chiedere le parti di un fallimento a "elencoPartiEC" torna
                // sempre 204: era il motivo per cui i concorsuali restavano senza
                // parti e senza codice fiscale. Si prova prima quello giusto per
                // il registro, poi il gemello, cosi' non serve conoscere l'elenco
                // completo dei registri concorsuali.
                const esecuzione = /^ES/i.test(String(F.registro || ''));
                const servizi = esecuzione
                    ? ['elencoPartiEC', 'elencoPartiPC']
                    : ['elencoPartiPC', 'elencoPartiEC'];
                let elenco = [];
                for (const srv of servizi) {
                    const u = F.host + '/' + F.contesto + '/api/servizipda-siecic/v1/' + srv;
                    const r = await fetch(u, {
                        method: 'POST', credentials: 'include',
                        headers: Object.assign(intestazioni(F, token), { 'Content-Type': 'application/json' }),
                        body: JSON.stringify({ distretto: F.distretto, idUfficio: F.ufficio,
                                               registro: F.registro, idDfa: F.idDfa }),
                    });
                    if (r.status === 200) {
                        const j = await r.json();
                        const l = (j && (j.elencoPartiECList || j.elencoPartiPCList || j.lista)) || [];
                        if (Array.isArray(l) && l.length) { elenco = l; break; }
                    }
                }
                {
                    if (Array.isArray(elenco)) {
                        const profilo = parti;
                        const ufficiali = elenco.map((p) => {
                            const desc = String((p && (p.descrizione || p.nominativo || p.desc)) || '').trim();
                            let cf = String((p && (p.codice || p.codiceFiscale || p.cf)) || '').toUpperCase().trim();
                            if (cf === 'N-A' || cf === 'N/A') cf = '';
                            const nomeKey = chiaveOrdineLibero(desc);
                            const esistente = profilo.find((q) => (cf && q.cf === cf)
                                || (nomeKey && chiaveOrdineLibero((q.cognome || '') + ' ' + (q.nome || '')) === nomeKey));
                            const tipo = ruoloDaDescrizione(String((p && (p.ruolo || p.tipoParte || p.tipo)) || ''))
                                || (esistente ? ruoloDaDescrizione(esistente.tipo) : 'TP');
                            return {
                                cognome: esistente && esistente.cognome ? esistente.cognome : desc,
                                nome: esistente ? esistente.nome : '',
                                tipo: tipo,
                                cf: cf || (esistente ? esistente.cf : ''),
                                nascita: esistente ? esistente.nascita : '',
                                avv: esistente ? esistente.avv : '',
                                avvCf: esistente ? esistente.avvCf : '',
                            };
                        }).filter((p) => p.cognome !== '' || p.cf !== '');
                        for (const p of profilo) {
                            const nomeKey = chiaveOrdineLibero((p.cognome || '') + ' ' + (p.nome || ''));
                            const esistente = ufficiali.some((q) => (p.cf && q.cf === p.cf)
                                || (nomeKey && chiaveOrdineLibero((q.cognome || '') + ' ' + (q.nome || '')) === nomeKey));
                            if (!esistente) ufficiali.push(Object.assign({}, p, { tipo: ruoloDaDescrizione(p.tipo) || 'TP' }));
                        }
                        if (ufficiali.length) parti = ufficiali;
                    }
                }
            } catch (e) { /* best effort: si conservano le parti del profilo */ }
        }
        if (parti.length) { try { await storageSet(ck, { t: Date.now(), parti: parti }); } catch (e) { /* ignore */ } }
        return parti;
    }

    /**
     * Ruolo della parte in sigla, dalla descrizione del Portale.
     *
     * Nelle esecuzioni il creditore procedente e quello intervenuto vanno tenuti
     * distinti (AP e APC): finiscono in sottocartelle diverse e hanno difensori
     * diversi. Stessa tabella del lato server (pct_normalizza_ruolo_parte).
     */
    function ruoloDaDescrizione(s) {
        const c = String(s || '').toUpperCase();
        if (/CREDITOR/.test(c)) return /INTERVEN/.test(c) ? 'APC' : 'AP';
        if (/DEBITOR/.test(c)) return 'CP';
        if (/ATTORE|ATTRICE|ATTORI|RICORRENT|OPPONENT/.test(c)) return 'AP';
        if (/CONVENUT|RESISTENT|OPPOST/.test(c)) return 'CP';
        if (/TERZO|TERZI|INTERVENUT|CONTROINTERESSAT|ALTRO|ALTRI|ALTRE/.test(c)) return 'TP';
        if (c === 'AP' || c === 'APC' || c === 'CP' || c === 'TP') return c;
        return c ? c.slice(0, 4) : 'AP';
    }

    /** Indice delle parti: per CF, per nome e per difensore. null = ambiguo. */
    function indiceProfilo(parti) {
        const perCf = {}, perCfSimile = {}, perNome = {}, perAvv = {};
        const metti = (mappa, k, p) => {
            if (!k) return;
            if (mappa[k] === undefined) mappa[k] = p;
            else if (mappa[k] !== p) mappa[k] = null;
        };
        for (const p of parti) {
            const nome = (p.cognome + ' ' + p.nome).trim();
            metti(perCf, p.cf, p);
            metti(perCfSimile, cfChiave(p.cf), p);
            metti(perNome, normaNome(nome), p);
            metti(perNome, chiaveOrdineLibero(nome), p);
            metti(perAvv, p.avvCf, p);
            metti(perAvv, chiaveOrdineLibero(p.avv), p);
        }
        return { perCf: perCf, perCfSimile: perCfSimile, perNome: perNome, perAvv: perAvv, lista: parti, n: parti.length };
    }

    /**
     * Chiave di confronto per un codice fiscale scritto a mano nell'atto.
     *
     * La procura del debitore nel 2024/76 dichiara "RSALDO73L53FZ04W" mentre il
     * registro ha "RSALDO73L53F704W": una Z al posto di un 7. Confrontando alla
     * lettera la parte non si riconosceva, e la cartella finiva battezzata con
     * il cognome dell'avvocato e con il ruolo sbagliato. Qui i caratteri che si
     * confondono nella lettura diventano uno solo.
     */
    function cfChiave(cf) {
        const c = String(cf || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!c) return '';
        let o = '';
        for (const ch of c) {
            o += (ch === 'O' || ch === 'Q') ? '0'
               : (ch === 'I' || ch === 'L') ? '1'
               : (ch === 'Z') ? '7'
               : (ch === 'S') ? '5'
               : (ch === 'B') ? '8'
               : (ch === 'G') ? '6'
               : ch;
        }
        return o;
    }

    /** Cerca la parte nel profilo per codice fiscale, poi per nome. */
    function trovaParte(idx, nome, cf) {
        if (!idx || !idx.n) return null;
        const c = String(cf || '').toUpperCase().trim();
        if (c && idx.perCf[c]) return idx.perCf[c];
        const k = normaNome(nome);
        if (k && idx.perNome[k]) return idx.perNome[k];
        const k2 = chiaveOrdineLibero(nome);
        if (k2 && idx.perNome[k2]) return idx.perNome[k2];
        // Ultimo tentativo: codice fiscale con un carattere sbagliato ma
        // somigliante, accettato solo se porta a una parte sola.
        const ks = cfChiave(c);
        if (ks && idx.perCfSimile && idx.perCfSimile[ks]) return idx.perCfSimile[ks];
        return null;
    }

    /** Etichetta della cartella parte: "RUOLO - Nome Cognome (CF)". */
    function etichettaParte(tipo, nome, cf) {
        const t = String(tipo || 'AP').toUpperCase().trim() || 'AP';
        return pulisci(t + ' - ' + String(nome || '').trim() + (cf ? ' (' + cf + ')' : ''));
    }

    /** Vero per le etichette parte che non nominano nessuno. */
    function etichettaSegnaposto(parte) {
        const p = String(parte || '');
        return !p || /(^|[\s-])SENZA NOME\b/i.test(p) || /^ND\b/i.test(p) || /^[A-Z0-9]{11,16}$/.test(p);
    }

    /**
     * Rimette sugli atti l'etichetta parte gia' risolta, rileggendola dal
     * manifest.
     *
     * Il manifest `_pct_index.json` conserva per ogni documento il percorso
     * definitivo sul PC, cioe' quello con la parte GIA' battezzata
     * ("atti_di_parte/AP - ASTAR S.R.L.S. (01382550455)/2022-09-16 - 1/...").
     * Quel nome e' il frutto della lettura dei datiAtto fatta a suo tempo.
     *
     * Il tree del Portale, invece, intesta gli atti di parte col codice fiscale
     * di chi ha depositato (il difensore) o con niente: rimandandoli al backend
     * com'erano, il pannello mostrava "BRTVNC77M43L833L" e "ND - SENZA NOME" su
     * depositi che sul disco erano correttamente intestati alla parte.
     *
     * Interviene SOLO dove l'etichetta dell'atto e' un segnaposto, quindi non
     * puo' mai peggiorare un nome appena risolto dai datiAtto: per questo e'
     * innocua su tutti i percorsi di scarico, non solo sulla via rapida.
     * Non tocca la categoria: spostare un atto tra parte e ufficio e' compito di
     * risolviPartiSegnaposto, che legge le buste e sa la verita'.
     */
    function rietichettaDaManifest(compiti, atti, manifest) {
        const docs = (manifest && manifest.docs) || {};
        let messi = 0;
        for (let i = 0; i < compiti.length; i++) {
            const a = atti[i];
            if (!a || !compiti[i] || !compiti[i].id) continue;
            if (a.categoria !== 'atti_di_parte') continue;
            // Un'intestazione gia' buona non si tocca.
            if (!etichettaSegnaposto(a.parte)) continue;
            const voce = docs[String(compiti[i].id)];
            const rel = String((voce && voce.rel) || '');
            if (!rel) continue;
            const seg = rel.split('/');
            if (seg[0] !== 'atti_di_parte' || seg.length < 3) continue;
            const et = seg[1];
            // Se anche il manifest e' rimasto al segnaposto non c'e' niente da
            // recuperare: si lascia l'atto come sta, senza peggiorarlo.
            if (!et || et === a.parte || etichettaSegnaposto(et)) continue;
            const m = /^([A-Z]{2,3})\s+-\s+(.*?)(?:\s+\(([A-Z0-9]{11,16})\))?$/i.exec(et);
            a.parte = et;
            a.tipo_parte = m ? m[1].toUpperCase() : (a.tipo_parte || 'AP');
            a.nome_parte = m ? String(m[2] || '').trim() : '';
            a.cf_parte = (m && m[3]) ? m[3].toUpperCase() : '';
            messi++;
        }
        return messi;
    }

    /**
     * Firmatario della busta CAdES: il certificato scrive il codice fiscale come
     * "TINIT-<cf>" e il nominativo in chiaro nel DER, quindi bastano i byte
     * stampabili. Nessuna richiesta in piu': la busta e' quella del datiAtto che
     * scarichiamo comunque per leggere la parte.
     */
    function firmatarioDaBusta(buf) {
        const bytes = new Uint8Array(buf);
        let testo = '', run = '';
        for (let i = 0; i < bytes.length; i++) {
            const c = bytes[i];
            if (c >= 0x20 && c <= 0x7e) { run += String.fromCharCode(c); continue; }
            if (run.length >= 4) testo += run + '\n';
            run = '';
        }
        if (run.length >= 4) testo += run;
        testo = testo.toUpperCase();
        const m = /TINIT-([A-Z0-9]{16})/.exec(testo);
        const nome = nomeDalCertificato(bytes);
        return { cf: m ? m[1] : '', nome: nome, cn: nome, testo: testo };
    }

    /**
     * Nominativo del firmatario letto dal DER del certificato: si cercano gli
     * OID surname (2.5.4.4 -> 06 03 55 04 04) e givenName (2.5.4.42 ->
     * 06 03 55 04 2A) del subject, che nei certificati di firma qualificata
     * portano cognome e nome della persona. Sono attributi che i certificati
     * delle CA non hanno, quindi non si rischia di scambiare l'emittente col
     * firmatario (il commonName, invece, ce l'hanno entrambi). Stringa vuota se
     * il certificato non li dichiara: meglio nessun nome che un nome sbagliato.
     */
    function nomeDalCertificato(bytes) {
        // Valore della stringa ASN.1 che segue l'OID: tag, lunghezza, testo.
        const valore = (i) => {
            const tag = bytes[i], len = bytes[i + 1];
            if (len === undefined || len === 0 || len > 0x7f) return '';
            const fine = Math.min(i + 2 + len, bytes.length);
            let s = '';
            if (tag === 0x1e) {                       // BMPString (UTF-16BE)
                for (let k = i + 2; k + 1 < fine; k += 2) {
                    s += String.fromCharCode((bytes[k] << 8) | bytes[k + 1]);
                }
            } else if (tag === 0x13 || tag === 0x0c || tag === 0x16 || tag === 0x14) {
                for (let k = i + 2; k < fine; k++) s += String.fromCharCode(bytes[k]);
                if (tag === 0x0c) {                   // UTF8String: decodifica accenti
                    try { s = decodeURIComponent(escape(s)); } catch (e) { /* resta grezza */ }
                }
            } else {
                return '';
            }
            return s.replace(/\s+/g, ' ').trim();
        };
        const pareNome = (s) => /^[A-Za-z][A-Za-z'\u00C0-\u00FF. -]{1,58}$/.test(s);
        const cerca = (arco) => {
            for (let i = 0; i + 6 < bytes.length; i++) {
                if (bytes[i] !== 0x06 || bytes[i + 1] !== 0x03 || bytes[i + 2] !== 0x55
                    || bytes[i + 3] !== 0x04 || bytes[i + 4] !== arco) continue;
                const v = valore(i + 5);
                if (pareNome(v)) return v;
            }
            return '';
        };
        const cognome = cerca(0x04), proprio = cerca(0x2a);
        if (cognome === '' || proprio === '') return '';
        return (cognome + ' ' + proprio).toUpperCase();
    }

    /** Dalla firma della busta alla parte difesa da quell'avvocato. */
    function parteDalFirmatario(idx, firma) {
        if (!idx || !idx.n || !firma) return null;
        if (firma.cf && idx.perAvv[firma.cf]) return idx.perAvv[firma.cf];
        let trovata = null;
        for (const p of idx.lista) {
            const t = normaNome(p.avv).split(' ').filter((x) => x.length > 1);
            if (t.length < 2) continue;
            // I due pezzi del nome devono comparire accostati, in un ordine
            // qualunque: e' la forma del CN del certificato di firma.
            const a = t[0] + ' ' + t[1], b = t[1] + ' ' + t[0];
            if (firma.testo.indexOf(a) < 0 && firma.testo.indexOf(b) < 0) continue;
            if (trovata !== null && trovata !== p) return null;   // ambiguo
            trovata = p;
        }
        return trovata;
    }

    /**
     * Dall'avvocato dichiarato nell'atto alla parte del registro che difende.
     *
     * Serve quando il deposito nomina un soggetto che il registro non ha: nel
     * 178/2024 del Giudice di Pace la comparsa di costituzione e' intestata a
     * "ADRIATIC OSIGURANJE D.D. (90156860323)", mentre il registro conosce
     * "ADRIATICA ASSICURAZIONI (01332090321)" - due codici fiscali diversi,
     * quindi nessun accostamento per nome o per codice. L'anello che li unisce
     * e' il difensore: il registro dice che quella parte e' difesa dall'avv.
     * MANCINI LUCA, ed e' lui che firma la comparsa. Senza questo passaggio il
     * ruolo restava quello di ripiego ("AP") e la cartella diceva attore su un
     * deposito del convenuto.
     *
     * Il codice fiscale dell'avvocato spesso manca nel registro (il Portale
     * riempie solo il nome), quindi si prova anche col nome in ordine libero.
     * Si risponde solo se quell'avvocato difende UNA parte sola: con due o piu'
     * non si indovina.
     */
    function parteDalDifensoreRegistro(idx, avvCf, avvNome) {
        if (!idx || !idx.n || !idx.perAvv) return null;
        const c = String(avvCf || '').toUpperCase().trim();
        if (c && idx.perAvv[c]) return idx.perAvv[c];
        const k = chiaveOrdineLibero(avvNome);
        if (k && idx.perAvv[k]) return idx.perAvv[k];
        return null;
    }

    /** Traduce il guasto del portale in una frase comprensibile. */
    function guastoLeggibile(errore, codice) {
        // Token scaduto: non e' un guasto del portale ne' un fascicolo rotto. Va
        // detto con parole sue e marcato riprovabile, perche' chi chiama sa
        // rinnovare l'access col refresh token e ripetere il fascicolo.
        if (codice === 401 || codice === 403 || /invalid_token|token non valido/i.test(errore || '')) {
            return { messaggio: 'Sessione PdA scaduta (token rifiutato): rinnovo e riprovo', riprovabile: true };
        }
        const passeggero = codice >= 500 || codice === 0
            || /timed out|timeout|Errore del server|queued for execution|recuperare le informazioni/i.test(errore || '');
        if (passeggero) {
            return { messaggio: 'Impossibile scaricare documenti dalla PdA Toscana, riprova più tardi', riprovabile: true };
        }
        return { messaggio: 'Elenco documenti non disponibile: ' + errore, riprovabile: false };
    }

    const FAMIGLIE = ['attiParte', 'provvedimenti', 'altriAtti', 'archivio', 'attiPerData', 'attiPerDataOldMode'];

    function famiglieVuote(lista) {
        return !FAMIGLIE.some((k) => Array.isArray(lista[k]) && lista[k].length);
    }

    function cercaFamiglie(nodo, livello) {
        livello = livello || 0;
        if (!nodo || typeof nodo !== 'object' || livello > 5) return null;
        for (const k of FAMIGLIE) {
            if (Array.isArray(nodo[k])) return nodo;
        }
        for (const figlio of Array.isArray(nodo) ? nodo : Object.values(nodo)) {
            if (!figlio || typeof figlio !== 'object') continue;
            const t = cercaFamiglie(figlio, livello + 1);
            if (t !== null) return t;
        }
        return null;
    }

    // ── Elenco atti ────────────────────────────────────────────────────────────

    async function elencoAtti(F, token) {
        const url = urlElenco(F);
        if (url === null) {
            return { ok: false, lista: [], codice: 0, errore: "scarico diretto non disponibile per l'area " + F.area };
        }
        const headers = intestazioni(F, token);

        // Il risveglio del documentale ("stato") serve allo scarico delle buste,
        // non all'elenco: si tenta prima l'elenco e lo si chiama solo se il
        // Portale non risponde, cosi' i sync senza documenti nuovi non pagano
        // un'attesa che non serve a nulla.
        let risposta = '', codice = 0, errore = '';
        const tEl = Date.now();
        for (let tentativo = 1; tentativo <= 2; tentativo++) {
            try {
                const r = await fetch(url, { headers, credentials: 'include' });
                codice = r.status;
                risposta = await r.text();
            } catch (e) {
                errore = String(e && e.message ? e.message : e); codice = 0;
            }
            if (codice === 200) break;
            if (tentativo === 1) {
                const uStato = urlStato(F);
                if (uStato) {
                    const tSt = Date.now();
                    try { await fetch(uStato, { headers, credentials: 'include' }); } catch (e) { /* best effort */ }
                    if (tempiExtra) tempiExtra.stato += Date.now() - tSt;
                }
                await new Promise((res) => setTimeout(res, 2000));
            }
        }
        if (tempiExtra) tempiExtra.lista = Date.now() - tEl;

        if (codice !== 200) {
            return { ok: false, lista: [], codice: codice,
                errore: errore !== '' ? errore : ('HTTP ' + codice + ' ' + risposta.trim().slice(0, 200)) };
        }
        let j;
        try { j = JSON.parse(risposta); } catch (e) { j = null; }
        if (!j || typeof j !== 'object') {
            return { ok: false, lista: [], codice: codice, errore: 'risposta non in JSON' };
        }
        let lista = Array.isArray(j.listaAttiFascicolo) || (j.listaAttiFascicolo && typeof j.listaAttiFascicolo === 'object')
            ? j.listaAttiFascicolo : null;
        if (lista === null) {
            for (const k of ['attiParte', 'provvedimenti', 'altriAtti', 'archivio']) {
                if (j[k] !== undefined) { lista = j; break; }
            }
        }
        if (lista === null) lista = cercaFamiglie(j);
        return { ok: true, codice: 200, errore: '', lista: (lista && typeof lista === 'object') ? lista : {} };
    }

    // ── Compiti (file da scaricare, con percorso relativo) ──────────────────────

    function compitiPct(lista, parteFallback) {
        const compiti = [];
        const attiMeta = [];
        const visti = {};
        const note = [];

        const aggiungi = (atto, cartella, ctx) => {
            ctx = ctx || {};
            const doc = [];
            if (atto.docPrincipale) doc.push({ d: atto.docPrincipale, capo: true });
            for (const s of atto.docSecondari || []) doc.push({ d: s, capo: false });
            const tipoAtto = String(atto.descrizioneAtto || atto.tipoAtto || atto.descrizione
                || atto.descrizioneTipoAtto || atto.oggetto || '').trim();
            for (const it of doc) {
                const d = it.d;
                if (!d || !d.idDocumento || !d.nomeFile) continue;
                const nome = pulisci(String(d.nomeFile));
                if (nome === '') continue;
                // "Atto" = documento principale del deposito, "Documenti" =
                // allegati, ricevute e datiAtto: la stessa divisione che il
                // portale usa nel pacchetto che confeziona per il fascicolo.
                // Il flag arriva dall'albero (campo "principale"); se manca si
                // usa la posizione (docPrincipale contro docSecondari).
                const capo = (d.principale === undefined || d.principale === null)
                    ? it.capo
                    : (d.principale === true || String(d.principale).toLowerCase() === 'true');
                const sotto = cartella + '/' + (capo ? 'Atto' : 'Documenti');
                const rel = sotto + '/' + nome;
                // Il doppione si giudica sul DEPOSITO, non sulla sottocartella:
                // lo stesso nome file non puo' stare due volte nello stesso
                // deposito nemmeno se una copia e' atto e l'altra allegato.
                const key = (cartella + '/' + nome).toLowerCase();
                if (visti[key]) { note.push('doppione stesso nome nel deposito, tenuto il primo: ' + rel); continue; }
                visti[key] = true;
                // "attesi" = dimensione dichiarata dall'albero: serve a scartare
                // gli scarichi troncati (vedi scaricaUno). Il file che arriva e'
                // la busta firmata, quindi non e' piu' piccolo del dichiarato.
                const attesi = parseInt(String(d.dimensione || d.dimensioneFile || d.size || '')
                    .replace(/[^\d]/g, ''), 10);
                compiti.push({
                    id: String(d.idDocumento), nome: String(d.nomeFile), rel: rel,
                    attesi: (isNaN(attesi) || attesi <= 0) ? 0 : attesi,
                });
                // Metadati per il DB su Aruba: i file restano sul PC (path_locale vuoto).
                attiMeta.push({
                    parte:        ctx.parte || '',
                    tipo_parte:   ctx.tipo_parte || '',
                    nome_parte:   ctx.nome_parte || '',
                    cf_parte:     ctx.cf_parte || '',
                    tipo_atto:    tipoAtto,
                    // Solo la parte data (YYYY-MM-DD): il backend (parse_date)
                    // non accetta il datetime ISO con orario, altrimenti la data
                    // resta vuota e il pannello mostra il nodo "Atto —".
                    data_atto:    (String(atto.dataAtto || '').match(/^\d{4}-\d{2}-\d{2}/) || [''])[0],
                    nome_file:    String(d.nomeFile),
                    dimensione:   String(d.dimensione || d.dimensioneFile || d.size || ''),
                    categoria:    ctx.categoria || '',
                    subfolder:    sotto,
                    url_download: '',
                });
            }
        };

        // ── Elenchi dei depositi, nell'ordine usato dai cicli qui sotto ────────
        const attiDiParte = (Array.isArray(lista.attiParte) ? lista.attiParte : [])
            .filter((a) => a && typeof a === 'object');
        const attiUfficio = []
            .concat(Array.isArray(lista.provvedimenti) ? lista.provvedimenti : [])
            .concat(Array.isArray(lista.altriAtti) ? lista.altriAtti : [])
            .concat(Array.isArray(lista.archivio) ? lista.archivio : [])
            .filter((a) => a && typeof a === 'object');
        const attiData = ((Array.isArray(lista.attiPerData) && lista.attiPerData.length)
            ? lista.attiPerData
            : (Array.isArray(lista.attiPerDataOldMode) ? lista.attiPerDataOldMode : []))
            .filter((a) => a && typeof a === 'object');

        const perData = (a, b) => String(a.dataAtto || '').localeCompare(String(b.dataAtto || ''));

        // ── Progressivo del deposito dentro al fascicolo ───────────────────────
        // Il portale nomina ogni deposito "AAAA-MM-GG - n", con n unico nel
        // fascicolo: e' il numero che assegna il documentale quando confeziona
        // il pacchetto, non compare nell'albero degli atti e non e' stabile fra
        // due pacchetti diversi. Qui si numera in ordine cronologico (data e ora
        // del deposito, idDocumento a parita' di istante): stessa forma del
        // portale, numero nostro, che non cambia da una sincronizzazione
        // all'altra e quindi non fa rinominare cartelle gia' scritte sul PC.
        const progressivi = new Map();
        {
            const idMinimo = (atto) => {
                let min = null;
                const doc = [];
                if (atto.docPrincipale) doc.push(atto.docPrincipale);
                for (const s of atto.docSecondari || []) doc.push(s);
                for (const d of doc) {
                    const n = parseInt(d && d.idDocumento, 10);
                    if (!isNaN(n) && (min === null || n < min)) min = n;
                }
                return min === null ? 0 : min;
            };
            // I depositi senza data vengono scartati dai cicli qui sotto: fuori
            // anche dalla numerazione, altrimenti "bucherebbero" i progressivi.
            const tutti = attiDiParte.concat(attiUfficio).concat(attiData)
                .filter((a) => /^\d{4}-\d{2}-\d{2}/.test(String(a.dataAtto || '')));
            const chiave = new Map();
            for (const a of tutti) {
                chiave.set(a, String(a.dataAtto || '') + '\u0000'
                    + ('000000000000' + idMinimo(a)).slice(-12));
            }
            tutti.sort((a, b) => chiave.get(a).localeCompare(chiave.get(b)));
            let n = 0;
            for (const a of tutti) { if (!progressivi.has(a)) progressivi.set(a, ++n); }
        }

        /** Cartella del deposito: "AAAA-MM-GG - n", come nel pacchetto del portale. */
        const cartellaDeposito = (atto) => {
            const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(atto.dataAtto || ''));
            if (!d) return null;
            return d[1] + '-' + d[2] + '-' + d[3] + ' - ' + (progressivi.get(atto) || 0);
        };

        // Atti di parte
        const parte = attiDiParte.slice();
        parte.sort(perData);
        for (const atto of parte) {
            const chi = String((atto.cognomeParte || '') + ' ' + (atto.nomeParte || '')).trim();
            let tipo = String(atto.tipoParte || 'ND').toUpperCase().trim() || 'ND';
            let cf = String(atto.cfParte || '').toUpperCase().trim();
            if (cf === 'N-A' || cf === 'NA') cf = '';
            const cfVero = /^[A-Z0-9]{11,16}$/.test(cf);
            let et;
            if (chi !== '') et = tipo + ' - ' + chi + (cf !== '' ? ' (' + cf + ')' : '');
            else if (cfVero) et = cf;
            else et = tipo + ' - SENZA NOME' + (cf !== '' ? ' (' + cf + ')' : '');
            et = pulisci(et);
            const data = cartellaDeposito(atto);
            if (data === null) { note.push('deposito senza data, ignorato: ' + et); continue; }
            aggiungi(atto, 'atti_di_parte/' + et + '/' + data,
                { categoria: 'atti_di_parte', parte: et, tipo_parte: (tipo || 'AP'), nome_parte: chi, cf_parte: cf });
        }

        // Provvedimenti, altri atti, archivio
        const provv = attiUfficio.slice();
        provv.sort(perData);
        for (const atto of provv) {
            const data = cartellaDeposito(atto);
            if (data === null) { note.push('provvedimento senza data, ignorato'); continue; }
            aggiungi(atto, 'provvedimenti_di_ufficio/' + data,
                { categoria: 'provvedimenti_di_ufficio', parte: '', tipo_parte: 'PU', nome_parte: '', cf_parte: '' });
        }

        // Atti per data (Giudice di Pace)
        const perDataArr = attiData.slice();
        perDataArr.sort(perData);
        for (const atto of perDataArr) {
            // Categoria decisa dal documento PRINCIPALE, non dagli allegati.
            // Prima si guardavano TUTTI i nomi del deposito: un ricorso di parte
            // che allega un "PROVVEDIMENTO di ASSUNZIONE.pdf" faceva finire
            // l'intero deposito - ricorso, procura, ricevute - dentro
            // provvedimenti_di_ufficio. I file confezionati dall'ufficio hanno
            // nomi generati dal sistema, sempre senza spazi (comunicazione.txt,
            // decretoFissazioneUdienza.pdf, decretoGenerico_1234.pdf); gli
            // allegati di parte hanno nomi scritti a mano dall'avvocato.
            let capo = '';
            if (atto.docPrincipale && atto.docPrincipale.nomeFile) {
                capo = String(atto.docPrincipale.nomeFile);
            } else {
                const s0 = (atto.docSecondari || [])[0];
                if (s0 && s0.nomeFile) capo = String(s0.nomeFile);
            }
            const bnCapo = capo.split(/[\\/]/).pop().toLowerCase();
            const generato = bnCapo !== '' && !/\s/.test(bnCapo);
            const ufficiale = generato && (
                bnCapo === 'comunicazione.txt'
                || /^(decreto|ordinanza|sentenza|verbale|provvedimento|attoacq|biglietto)/.test(bnCapo)
            );
            if (!ufficiale) {
                let chi = String((atto.cognomeParte || '') + ' ' + (atto.nomeParte || '')).trim();
                let tipo = String(atto.tipoParte || 'ND').toUpperCase().trim() || 'ND';
                let cf = '';
                // Il tree del PdA (tipico Giudice di Pace / SIGP) spesso NON riporta
                // la parte del deposito e nemmeno il datiAtto la contiene (depositi
                // note conclusionali, richiesta visibilita', ecc.): invece di
                // "SENZA NOME" usiamo la parte del fascicolo rappresentata
                // dall'avvocato loggato, nota dalla ricerca massiva.
                if (chi === '' && parteFallback && parteFallback.nome) {
                    chi = toTitleCase(String(parteFallback.nome));
                    tipo = String(parteFallback.tipo || tipo || 'AP').toUpperCase() || 'AP';
                    cf = String(parteFallback.cf || '');
                }
                const nomeEtich = (chi !== '' && cf) ? (chi + ' (' + cf + ')') : chi;
                const et = pulisci(chi !== '' ? (tipo + ' - ' + nomeEtich) : (tipo + ' - SENZA NOME'));
                const data = cartellaDeposito(atto);
                if (data === null) { note.push('deposito senza data, ignorato: ' + et); continue; }
                aggiungi(atto, 'atti_di_parte/' + et + '/' + data,
                    { categoria: 'atti_di_parte', parte: et, tipo_parte: (tipo || 'AP'), nome_parte: chi, cf_parte: cf });
            } else {
                const data = cartellaDeposito(atto);
                if (data === null) { note.push('provvedimento senza data, ignorato'); continue; }
                aggiungi(atto, 'provvedimenti_di_ufficio/' + data,
                    { categoria: 'provvedimenti_di_ufficio', parte: '', tipo_parte: 'PU', nome_parte: '', cf_parte: '' });
            }
        }

        return { compiti: compiti, atti: attiMeta, note: note };
    }

    // ── Salvataggio locale via background (AstarFirmaServer) ─────────────────────

    /**
     * Dal percorso relativo (famiglia/parte/data/file) ai tre pezzi che il
     * servizio locale accetta: cartella (fascicolo) + parte (UN solo livello,
     * quindi appiattiamo i livelli intermedi con " - ") + nome file.
     */
    function pezziLocali(etichetta, rel) {
        const parti = rel.split('/');
        const nome = parti.pop();
        const parte = parti.join(' - ');
        return { cartella: pulisci(etichetta), parte: pulisci(parte), nome: pulisci(nome) };
    }

    function bgMessage(msg) {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage(msg, (resp) => {
                    if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
                    resolve(resp || { ok: false, error: 'nessuna risposta dal background' });
                });
            } catch (e) { resolve({ ok: false, error: String(e) }); }
        });
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

    // ── Orchestratore ────────────────────────────────────────────────────────────

    /**
     * @param url    indirizzo della pagina del fascicolo (di norma location.href)
     * @param token  access token Keycloak del PdA (Bearer)
     * @param opts   { onProgress(fatti, totale) }
     */
    async function scaricaFascicoloPC(url, token, opts) {
        opts = opts || {};
        const t0 = Date.now();
        const F = parseUrl(url);
        if (!F) return { ok: false, riprovabile: false, messaggio: 'Indirizzo del fascicolo non riconosciuto' };
        if (!token) return { ok: false, riprovabile: false, messaggio: 'Sessione PdA non disponibile: ricarica la pagina del fascicolo' };
        if (!servizioScarico(F)) return { ok: false, riprovabile: false, messaggio: "Scarico diretto non disponibile per l'area " + F.area };

        // 1) Il servizio locale dev'essere attivo, altrimenti non c'e' dove salvare.
        const cap = await bgMessage({ action: 'astarStatus' });
        if (!cap || !cap.salva) {
            return { ok: false, riprovabile: true,
                messaggio: 'AstarFirmaServer non è attivo: avvialo per scaricare i documenti sul tuo PC.' };
        }

        // 1b) CACHE DI VERIFICA (15 minuti). Anche un fascicolo completo al 100%
        //     costava una chiamata all'elenco atti del portale prima di poter
        //     dire "e' gia' tutto sul PC": con centinaia di fascicoli sono
        //     decine di minuti buttati, e con due corse ravvicinate il portale
        //     rallenta o scade il token. Se il manifest porta un timbro di
        //     verifica recente, il fascicolo si salta senza toccare il portale.
        //     La sincronizzazione del SINGOLO fascicolo (opts.attiSempre) non
        //     usa mai la cache: lì la verifica la chiede l'utente adesso.
        const cartellaFsc = pulisci(F.etichetta);
        const manifest = await leggiManifest(cartellaFsc);
        // Impronta dei documenti gia' registrati: dice se dal tentativo
        // precedente e' arrivato qualcosa di nuovo.
        const improntaDoc = improntaManifest(manifest);
        const nomiGiaTentati = (String(manifest.nomi_firma || '') === improntaDoc);
        if (!opts.attiSempre && !opts.ignoraCache) {
            const quando = Number(manifest.verificato_il || 0);
            const noti = Object.keys(manifest.docs || {}).length;
            // Un fascicolo con cartelle ancora senza nome ("ND - SENZA NOME")
            // non e' sistemato: la cache non deve impedire il tentativo di dargli
            // un nome leggendo datiAtto, firma e comunicazione di cancelleria.
            // Ma se quel tentativo e' gia' stato fatto su questi stessi
            // documenti, rifarlo costa l'elenco atti del Portale e la rilettura
            // delle buste (oltre due minuti) senza poter dare un esito diverso:
            // si riprovera' appena arriva un documento nuovo.
            let daNominare = false;
            for (const k in (manifest.docs || {})) {
                if (/SENZA NOME|(^|\/)ND - /i.test(String(manifest.docs[k].rel || ''))) { daNominare = true; break; }
            }
            if (daNominare && nomiGiaTentati) daNominare = false;
            if (quando > 0 && noti > 0 && !daNominare && (Date.now() - quando) < FINESTRA_VERIFICA_MS) {
                return {
                    ok: true, riprovabile: false,
                    messaggio: 'Verificato ' + Math.round((Date.now() - quando) / 60000)
                        + ' min fa: già completo sul PC',
                    atti: [],
                    saltatoDaCache: true,
                    documenti: {
                        scaricati: 0, nel_fascicolo: noti, gia_presenti: noti,
                        falliti: 0, secondi: Math.round((Date.now() - t0) / 100) / 10, megabyte: 0,
                    },
                };
            }
        }

        // 2) Elenco atti dal PdA (same-origin).
        let msElenco = 0, msParti = 0, msLocale = 0;
        // Cronometri dei passi che non scaricano documenti ma parlano col
        // Portale: servono a capire dove vanno i secondi quando il sync non
        // porta a casa nemmeno un file nuovo.
        const extra = { storico: 0, portale: 0, udienza: 0, buste: 0, nbuste: 0, stato: 0, lista: 0 };
        tempiExtra = extra;
        // Elenco atti, storico e parti sono tre letture INDIPENDENTI del
        // Portale: nessuna usa il risultato dell'altra. Finche' si aspettava
        // l'elenco e solo dopo si chiedevano le altre due, un sync che non porta
        // a casa nemmeno un file costava la somma dei tempi (nel log ~10s di
        // elenco + ~14s di storico/parti = i 22s osservati). Qui partono
        // insieme, quindi il sync costa quanto la piu' lenta delle tre.
        // Si lanciano in anticipo solo quando il ramo che le usa e' quello
        // probabile (sync di un fascicolo singolo, documenti gia' tutti noti e
        // scheda in cache): negli altri casi non si aggiunge nessuna chiamata.
        const schedaInAnticipo = !!(opts.attiSempre && nomiGiaTentati && manifest.scheda_cache);
        const tAnticipo = Date.now();
        // storicoEventi e partiArchivio non lanciano eccezioni (catturano e
        // tornano lista vuota), percio' lanciarle senza await non lascia
        // promesse rifiutate in giro.
        const pStorico = schedaInAnticipo ? storicoEventi(F, token) : null;
        const pParti = schedaInAnticipo ? partiArchivio(F, token) : null;
        const tElenco = Date.now();
        const el = await elencoAtti(F, token);
        msElenco = Date.now() - tElenco;
        if (!el.ok) {
            const g = guastoLeggibile(el.errore, el.codice);
            return { ok: false, riprovabile: g.riprovabile, messaggio: g.messaggio };
        }
        const { compiti, atti } = compitiPct(el.lista, opts.parteFallback || null);
        const totaleFascicolo = compiti.length;
        if (totaleFascicolo === 0) {
            return { ok: true, riprovabile: false, messaggio: 'Nessun documento nel fascicolo', atti: atti,
                documenti: { scaricati: 0, nel_fascicolo: 0, gia_presenti: 0, falliti: 0, secondi: 0 } };
        }

        // 2b) DELTA RAPIDO per idDoc, PRIMA di qualsiasi lavoro costoso.
        //     Il manifest _pct_index.json e' indicizzato per idDoc STABILE: se
        //     contiene gia' TUTTI i documenti del fascicolo non c'e' nulla da
        //     scaricare, quindi evitiamo la risoluzione parti (che ri-scarica i
        //     datiAtto.xml dal PdA + roundtrip al backend) e la lettura del
        //     disco. E' il caso piu' frequente nella sync massiva ed era il
        //     principale spreco di tempo rispetto allo scarico del singolo
        //     fascicolo. Ritorniamo atti:[] cosi' il chiamante NON rifa' il
        //     salva_batch: il DB resta com'e' (gia' corretto dal run che aveva
        //     scaricato il fascicolo), nessuna regressione sui nomi parte.
        const idPresenti = new Set(Object.keys(manifest.docs || {}));
        // Non tutti i documenti del Portale hanno un idDoc (alcune ricevute e
        // comunicazioni ne sono prive). Finche' si guardavano solo gli idDoc, un
        // fascicolo con anche un solo documento senza id NON risultava mai
        // completo: ogni sync ripeteva l'intero percorso lungo (lettura delle
        // buste, elenco del disco, delta) pur non scaricando nulla. Per quei
        // documenti il manifest tiene il percorso relativo.
        const relPresenti = new Set(Object.keys(manifest.rels || {}));
        const tuttiNoti = compiti.every((c) => (c.id
            ? idPresenti.has(String(c.id))
            : relPresenti.has(String(c.rel))));
        extra.noti = idPresenti.size + relPresenti.size;
        extra.senzaId = compiti.filter((c) => !c.id).length;
        // Vero se restano atti di parte ancora "segnaposto" (ND / SENZA NOME / CF
        // nudo): tipico Giudice di Pace, dove il tree del PdA non porta la parte.
        const _segnaposto = (parte) => {
            const p = String(parte || '');
            return /(^|[\s-])SENZA NOME\b/i.test(p) || /^ND\b/i.test(p) || /^[A-Z0-9]{11,16}$/.test(p);
        };
        let haSegnaposto = false;
        for (let i = 0; i < compiti.length; i++) {
            const a = atti[i];
            if (!a || a.categoria !== 'atti_di_parte') continue;
            const seg = String(compiti[i].rel).split('/');
            if (seg.length >= 2 && _segnaposto(seg[1])) { haSegnaposto = true; break; }
        }
        if (tuttiNoti) {
            // Timbro di verifica: il confronto col portale dice che il PC ha
            // tutto. Per i prossimi 15 minuti questo fascicolo si salta senza
            // richiamare il portale (vedi cache al punto 1b).
            try {
                manifest.v = 1;
                manifest.verificato_il = Date.now();
                // Si registra che su questi documenti il battesimo delle cartelle
                // e' stato tentato: senza questo timbro ogni sync successivo
                // rifarebbe la rilettura delle buste per lo stesso esito.
                manifest.nomi_firma = improntaManifest(manifest);
                await scriviManifest(cartellaFsc, manifest);
            } catch (e) { /* best-effort: senza timbro si ricontrolla, come prima */ }
            // I documenti sono gia' tutti sul PC. Se pero' ci sono ancora atti di
            // parte segnaposto, il DB del backend puo' essere rimasto con "Parti
            // (0)" e atti "ND - SENZA NOME" (fascicolo scaricato da una versione
            // precedente, oppure prima corsa fallita): in quel caso risolvo i nomi
            // dai datiAtto (con cache, rilegge solo quelli non noti) e restituisco
            // l'elenco atti COMPLETO cosi' il chiamante rifa' il salva_batch e le
            // Parti si ricostruiscono. Senza segnaposto resta la via veloce
            // (atti:[]), nessun costo aggiuntivo e nessuna regressione.
            //
            // opts.attiSempre: la via veloce con atti:[] lascia l'archivio come
            // sta. Va bene nella sync massiva, NON va bene quando si sincronizza
            // un singolo fascicolo: se l'archivio e' stato svuotato (fascicolo
            // cancellato dal pannello, che NON cancella la copia sul PC) i file
            // restano sul disco, il motore dice "gia' presente" e il pannello
            // resta vuoto per sempre. Con attiSempre l'elenco atti torna sempre
            // completo, cosi' l'archivio si riallinea a quello che c'e' sul PC.
            if ((haSegnaposto && !nomiGiaTentati) || opts.attiSempre) {
                // VIA RAPIDA per le sync ripetute. I documenti non sono cambiati
                // (nomiGiaTentati) e nel manifest c'e' gia' il risultato caro
                // calcolato l'ultima volta (prossima udienza dei provvedimenti,
                // difensori e beni letti dai datiAtto). Allora NON rileggiamo
                // decine di datiAtto dal Portale (era il costo dei 26s sul Giudice
                // di Pace): riusiamo la cache + gli XML gia' sul disco, e teniamo
                // comunque freschi aggiornamenti e parti con le due chiamate
                // leggere (storico + profilo). Esito identico, tempi ridotti.
                if (nomiGiaTentati && manifest.scheda_cache) {
                    const cache = manifest.scheda_cache || {};
                    // Storico e parti sono due chiamate indipendenti: in sequenza
                    // costavano la somma dei due tempi (nel log ~8s + ~14s per
                    // fascicolo). Lanciate insieme costano quanto la piu' lenta,
                    // come fa il lato server con curl_multi.
                    const tS0 = Date.now();
                    const [eventi, partiPdA] = await Promise.all([
                        pStorico || storicoEventi(F, token),
                        pParti || partiArchivio(F, token),
                    ]);
                    // Se sono partite insieme all'elenco, qui l'attesa residua e'
                    // quasi nulla: il tempo vero si misura dal momento del lancio.
                    extra.storico = Date.now() - (schedaInAnticipo ? tAnticipo : tS0);
                    extra.portale = 0;
                    const xmlLocale = await partecipantiXmlLocale(cartellaFsc);
                    const comCache = {};
                    if (xmlLocale.parti.length) comCache.parti_xml = xmlLocale.parti;
                    if (xmlLocale.difensori.length) comCache.difensori = xmlLocale.difensori;
                    else if (Array.isArray(cache.difensori) && cache.difensori.length) comCache.difensori = cache.difensori;
                    if (xmlLocale.beni.length) comCache.beni = xmlLocale.beni;
                    else if (Array.isArray(cache.beni) && cache.beni.length) comCache.beni = cache.beni;
                    if (cache.giudice) comCache.giudice = cache.giudice;
                    if (cache.sezione) comCache.sezione = cache.sezione;
                    if (cache.oggetto) comCache.oggetto = cache.oggetto;
                    const sch = schedaDaComunicazioni(comCache, eventi);
                    const udienza = sch.data_prossima_udienza || cache.udienza || '';
                    // Gli atti tornano al backend con l'etichetta parte buona,
                    // ripresa dal manifest: senza questo passaggio la via rapida
                    // riscriveva "ND - SENZA NOME" sul database a ogni sync, pur
                    // avendo le cartelle correttamente intestate sul PC.
                    const rinominati = rietichettaDaManifest(compiti, atti, manifest);
                    return Object.assign({
                        ok: true, riprovabile: false, messaggio: 'Fascicolo gia\' presente sul PC (da cache locale)'
                            + (rinominati ? ' - ' + rinominati + ' atti reintestati dal manifest' : ''),
                        atti: atti,
                        parti: partiPdA,
                        udienza: udienza,
                        documenti: {
                            scaricati: 0, nel_fascicolo: totaleFascicolo, gia_presenti: totaleFascicolo,
                            falliti: 0, secondi: Math.round((Date.now() - t0) / 100) / 10, megabyte: 0,
                            tempi: {
                                elenco: Math.round(msElenco / 100) / 10,
                                parti: 0, locale: 0, scarico: 0, rete: 0, disco: 0,
                                storico: Math.round(extra.storico / 100) / 10,
                                portale: Math.round(extra.portale / 100) / 10,
                                udienza: 0, buste: 0, nbuste: 0,
                                noti: extra.noti, senzaId: extra.senzaId, tot: totaleFascicolo,
                                stato: 0, lista: 0, segnaposto: 3,
                            },
                        },
                    }, sch);
                }
                let com = null;
                const tP = Date.now();
                const xmlLocale = await partecipantiXmlLocale(cartellaFsc);
                try { com = await risolviPartiSegnaposto(F, token, compiti, atti, xmlLocale.difensori || []); }
                catch (e) { /* fallback silenzioso sul segnaposto */ }
                if (xmlLocale.parti.length || xmlLocale.difensori.length) {
                    com = com || {};
                    if (xmlLocale.parti.length) com.parti_xml = xmlLocale.parti;
                    if (xmlLocale.difensori.length) com.difensori = xmlLocale.difensori;
                    if (xmlLocale.beni.length) com.beni = xmlLocale.beni;
                }
                msParti = Date.now() - tP;
                // Rete di sicurezza: i depositi che le buste non hanno saputo
                // battezzare (busta assente o illeggibile) restano col segnaposto
                // del Portale. Se in un giro precedente erano stati risolti, il
                // nome buono e' ancora nel manifest: si recupera da li' invece di
                // riscrivere il segnaposto sul database.
                rietichettaDaManifest(compiti, atti, manifest);
                const tS = Date.now();
                const [eventiTN, partiTN] = await Promise.all([
                    pStorico || storicoEventi(F, token),
                    opts.attiSempre ? (pParti || partiArchivio(F, token)) : Promise.resolve([]),
                ]);
                const sch = schedaDaComunicazioni(com, eventiTN);
                extra.storico = Date.now() - (schedaInAnticipo ? tAnticipo : tS);
                const partiPdA = partiTN;
                extra.portale = 0;
                const tU = Date.now();
                const udienza = sch.data_prossima_udienza
                    || (opts.attiSempre ? await udienzaDaProvvedimenti(F, token, compiti, atti) : '');
                extra.udienza = Date.now() - tU;
                // Salviamo nel manifest il risultato caro appena calcolato, cosi'
                // la prossima sync sugli stessi documenti prende la via rapida.
                try {
                    manifest.scheda_cache = {
                        udienza: udienza || '',
                        difensori: (com && Array.isArray(com.difensori)) ? com.difensori : null,
                        beni: (com && Array.isArray(com.beni)) ? com.beni : null,
                        giudice: sch.giudice || (com && com.giudice) || '',
                        sezione: sch.sezione || (com && com.sezione) || '',
                        oggetto: sch.oggetto || (com && com.oggetto) || '',
                    };
                    await scriviManifest(cartellaFsc, manifest);
                } catch (e) { /* best-effort: senza cache si ricalcola, come prima */ }
                return Object.assign({
                    ok: true, riprovabile: false, messaggio: 'Fascicolo gia\' presente sul PC (parti aggiornate)',
                    atti: atti,
                    parti: partiPdA,
                    udienza: udienza,
                    documenti: {
                        scaricati: 0, nel_fascicolo: totaleFascicolo, gia_presenti: totaleFascicolo,
                        falliti: 0, secondi: Math.round((Date.now() - t0) / 100) / 10, megabyte: 0,
                        tempi: {
                            elenco: Math.round(msElenco / 100) / 10,
                            parti: Math.round(msParti / 100) / 10,
                            locale: 0, scarico: 0, rete: 0, disco: 0,
                            storico: Math.round(extra.storico / 100) / 10,
                            portale: Math.round(extra.portale / 100) / 10,
                            udienza: Math.round(extra.udienza / 100) / 10,
                            buste: Math.round(extra.buste / 100) / 10,
                            nbuste: extra.nbuste,
                            noti: extra.noti, senzaId: extra.senzaId, tot: totaleFascicolo,
                            stato: Math.round(extra.stato / 100) / 10,
                            lista: Math.round(extra.lista / 100) / 10,
                            segnaposto: haSegnaposto ? (nomiGiaTentati ? 2 : 1) : 0,
                        },
                    },
                }, sch);
            }
            // Fascicolo interamente sul PC e nessuna intestazione da risolvere.
            // Si restituisce comunque l'elenco atti: e' GIA' in mano (l'abbiamo
            // pagato con elencoAtti qui sopra) e rimandarlo non costa nessuna
            // chiamata al Portale. Senza questo, la sincronizzazione massiva non
            // aveva niente da salvare e il pannello restava indietro.
            // La scheda (profilo, cronologia, comunicazioni) NON si manda da
            // qui: la legge il server con aggiornaSchedePerElenco(), che vede
            // tutti i servizi del Portale. Rimandare quella conservata nel
            // manifest significherebbe riscrivere dati vecchi sull'archivio.
            //
            // I difensori invece si mandano sempre. Gli XML dei depositi sono la
            // sola fonte che dice quale avvocato difende quale parte, col codice
            // fiscale di entrambi: il registro del Portale scrive soltanto il
            // nome. Quegli XML sono qui sul PC, quindi leggerli non costa
            // nessuna chiamata al Portale; uscendo da qui senza leggerli, la
            // colonna "CF avvocato" della scheda Parti restava vuota per sempre
            // su tutti i fascicoli gia' scaricati. Le parti non si mandano: a
            // elencarle e' il registro, l'atto nomina solo chi vi compare.
            //
            // La lettura dei file costa qualche decimo di secondo, e questo e'
            // il ramo che percorre la sincronizzazione di tutti i fascicoli:
            // il risultato resta quindi in cache per fascicolo, rinnovato
            // quando arrivano atti nuovi o dopo una settimana. Al server i
            // difensori si mandano a ogni giro, letti o ripresi dalla cache.
            const tFermo = Date.now();
            let difFermo = [], beniFermo = [];
            try {
                const ckLoc = 'pctDifLoc1:' + pulisci(F.etichetta);
                const cLoc = await storageGet(ckLoc);
                const buona = cLoc && Array.isArray(cLoc.lista)
                    && cLoc.atti === totaleFascicolo
                    && (Date.now() - (cLoc.t || 0)) < 7 * 86400000;
                if (buona) {
                    difFermo = cLoc.lista;
                    beniFermo = Array.isArray(cLoc.beni) ? cLoc.beni : [];
                } else {
                    const xmlFermo = await partecipantiXmlLocale(cartellaFsc, 16);
                    difFermo = xmlFermo.difensori || [];
                    beniFermo = xmlFermo.beni || [];
                    if (difFermo.length || beniFermo.length) {
                        try {
                            await storageSet(ckLoc, {
                                t: Date.now(), atti: totaleFascicolo,
                                lista: difFermo, beni: beniFermo,
                            });
                        } catch (e) { /* ignore */ }
                    }
                }
            } catch (e) { /* dato in piu': non deve far fallire il sync */ }
            msParti = Date.now() - tFermo;
            return {
                ok: true, riprovabile: false, messaggio: 'Fascicolo gia\' presente sul PC',
                atti: atti,
                difensori: difFermo,
                beni: beniFermo,
                documenti: {
                    scaricati: 0, nel_fascicolo: totaleFascicolo, gia_presenti: totaleFascicolo,
                    falliti: 0, secondi: Math.round((Date.now() - t0) / 100) / 10, megabyte: 0,
                    tempi: {
                        elenco: Math.round(msElenco / 100) / 10,
                        parti: Math.round(msParti / 100) / 10,
                        locale: 0, scarico: 0, rete: 0, disco: 0,
                        storico: 0, portale: 0, udienza: 0, buste: 0, nbuste: 0,
                        noti: extra.noti, senzaId: extra.senzaId, tot: totaleFascicolo,
                        stato: 0, lista: 0, segnaposto: 0,
                    },
                },
            };
        }

        // 2c) Risolve il nome parte reale dai datiAtto.xml per i depositi che il tree
        // del PdA lascia senza parte (segnaposto "ND - SENZA NOME", tipico Giudice di
        // Pace): cosi' cartelle e record atti nascono gia' col nome corretto, prima
        // del calcolo del delta e del salvataggio. Best effort: in caso di problemi
        // si prosegue col comportamento attuale (nessuna regressione).
        // Eseguito SOLO quando c'e' qualcosa da scaricare (vedi delta rapido sopra).
        let comFascicolo = null;
        const tParti = Date.now();
        const xmlLocaleFascicolo = await partecipantiXmlLocale(cartellaFsc);
        try { comFascicolo = await risolviPartiSegnaposto(F, token, compiti, atti, xmlLocaleFascicolo.difensori || []); }
        catch (e) { /* fallback silenzioso sul segnaposto */ }
        if (xmlLocaleFascicolo.parti.length || xmlLocaleFascicolo.difensori.length) {
            comFascicolo = comFascicolo || {};
            if (xmlLocaleFascicolo.parti.length) comFascicolo.parti_xml = xmlLocaleFascicolo.parti;
            if (xmlLocaleFascicolo.difensori.length) comFascicolo.difensori = xmlLocaleFascicolo.difensori;
            if (xmlLocaleFascicolo.beni.length) comFascicolo.beni = xmlLocaleFascicolo.beni;
        }
        msParti = Date.now() - tParti;

        // 3) Delta completo: al manifest (idDoc) aggiungiamo l'elenco reale su
        //    disco per (parte,nome), cosi' i fascicoli scaricati PRIMA di questa
        //    funzione (senza manifest) non vengono ri-scaricati al primo giro.
        //    Il confronto e' su due livelli: prima il percorso esatto, poi un
        //    conteggio per (nome file + data del deposito). Il secondo serve ai
        //    fascicoli scaricati con la vecchia struttura ("atto_GG-MM-AAAA",
        //    senza Atto/Documenti): il file c'e' gia', solo in una cartella che
        //    ora si chiama diversamente, e ri-scaricarlo sarebbe uno spreco.
        const tLocale = Date.now();
        const elL = await bgMessage({ action: 'astarElenco', cartella: cartellaFsc });
        msLocale = Date.now() - tLocale;
        const presenti = new Set();
        const perNomeData = new Map();
        const dataDaParte = (p) => {
            let m = /(\d{4})-(\d{2})-(\d{2})/.exec(p);          // struttura nuova
            if (m) return m[1] + m[2] + m[3];
            m = /(\d{2})-(\d{2})-(\d{4})/.exec(p);              // struttura vecchia
            if (m) return m[3] + m[2] + m[1];
            return '';
        };
        const chiaveNomeData = (parte, nome) => nome.toLowerCase() + '\u0000' + dataDaParte(parte);
        if (elL && elL.ok && Array.isArray(elL.files)) {
            for (const f of elL.files) {
                const pt = pulisci(f.parte || ''), nm = pulisci(f.nome || '');
                presenti.add(pt + '\u0000' + nm);
                const k = chiaveNomeData(pt, nm);
                perNomeData.set(k, (perNomeData.get(k) || 0) + 1);
            }
        }
        const daFare = compiti.filter((c) => {
            if (c.id && idPresenti.has(String(c.id))) return false;
            const p = pezziLocali(F.etichetta, c.rel);
            const k = chiaveNomeData(p.parte, p.nome);
            const n = perNomeData.get(k) || 0;
            if (presenti.has(p.parte + '\u0000' + p.nome)) {
                if (n > 0) perNomeData.set(k, n - 1);
                return false;
            }
            // Stesso nome file nello stesso giorno di deposito: e' lo stesso
            // documento in una cartella con il vecchio nome. Si scala il
            // conteggio, cosi' due depositi omonimi nella stessa data non si
            // coprono a vicenda.
            if (n > 0) { perNomeData.set(k, n - 1); return false; }
            return true;
        });
        const giaPresenti = totaleFascicolo - daFare.length;

        // XML in chiaro per le buste gia' sul disco: i fascicoli scaricati prima
        // di questa versione hanno accanto solo il .p7m, illeggibile senza
        // strumenti di firma. Qui la busta si rilegge dal disco e si scrive
        // l'XML estratto, senza ripassare dal portale e senza riscaricare nulla.
        if (elL && elL.ok && Array.isArray(elL.files)) {
            try {
                const chiave = (parte, nome) => pulisci(parte || '') + '\u0000' + pulisci(String(nome || '')).toLowerCase();
                const xmlPresenti = new Set();
                for (const f of elL.files) {
                    if (/\.xml$/i.test(String(f.nome || ''))) xmlPresenti.add(chiave(f.parte, f.nome));
                }
                const buste = elL.files.filter((f) => f && f.path
                    && /\.xml\.p7m$/i.test(String(f.nome || ''))
                    && !xmlPresenti.has(chiave(f.parte, String(f.nome).replace(/\.p7m$/i, ''))));
                // Tetto prudenziale: un fascicolo enorme non deve allungare il
                // sync solo per rigenerare gli XML, che tanto ripassa al giro dopo.
                for (const f of buste.slice(0, 40)) {
                    const letto = await bgMessage({ action: 'astarApriDocumento', path: f.path, nome: f.nome, raw: true });
                    if (!letto || !letto.ok || !letto.dataBase64) continue;
                    const bin = atob(letto.dataBase64);
                    const arr = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
                    const xmlStr = testoXmlDaBusta(arr);
                    if (!xmlStr) continue;
                    await bgMessage({
                        action: 'astarSalva', cartella: cartellaFsc, parte: f.parte,
                        nome: String(f.nome).replace(/\.p7m$/i, ''),
                        dataBase64: utf8ToBase64(xmlStr),
                    });
                }
            } catch (e) { /* estrazione di comodo: non blocca il sync */ }
        }

        // Risveglio del fascicolo nel documentale: serve solo per poter tirare
        // giu' le buste, non per elencarle. Farlo sempre costava oltre un minuto
        // anche ai sync che non avevano un solo documento da scaricare, quindi
        // si chiama qui, una volta, e solo se c'e' davvero da scaricare.
        if (daFare.length > 0) {
            const uSt = urlStato(F);
            if (uSt) {
                const tSt = Date.now();
                try {
                    await fetch(uSt, { headers: intestazioni(F, token), credentials: 'include' });
                } catch (e) { /* best effort */ }
                extra.stato += Date.now() - tSt;
            }
        }

        // 4) Scarico buste in parallelo (8), con 3 giri per i falliti.
        const scaricato = [];
        const falliti = [];
        let byteTot = 0;
        // Cronometri per capire dove finisce il tempo: rete del portale, scrittura
        // su disco e le fasi preliminari. Finiscono nel risultato e nel log.
        let msRete = 0, msDisco = 0;
        const post = servizioScarico(F);
        const hPost = Object.assign(intestazioni(F, token), { 'Content-Type': 'application/json', 'Accept': '*/*' });

        const scaricaUno = async (c) => {
            const corpo = JSON.stringify({
                area: F.area, nome: c.nome, isArchivio: false,
                idRepeAtto: c.id, idDoc: c.id, original: true,
                distretto: F.distretto, idUfficio: F.ufficio,
            });
            let buf = null, cod = 0, testo = '';
            // Posto nella coda del portale: tenuto SOLO per la chiamata di rete.
            await semPortale.prendi();
            const tRete = Date.now();
            try {
                const r = await fetch(post, { method: 'POST', headers: hPost, body: corpo, credentials: 'include' });
                cod = r.status;
                buf = await r.arrayBuffer();
            } catch (e) {
                msRete += Date.now() - tRete;
                semPortale.libera();
                return { ok: false, rel: c.rel, errore: String(e && e.message ? e.message : e) };
            }
            msRete += Date.now() - tRete;
            // Busta in mano: il posto torna libero subito, cosi' la prossima
            // richiesta parte mentre questo file si scrive su disco.
            semPortale.libera();

            const bytes = new Uint8Array(buf);
            // Un errore torna come JSON: un documento vero non comincia per "{".
            if (cod === 200 && bytes.length > 100 && bytes[0] !== 0x7B) {
                // Scarico troncato: il portale a volte chiude la risposta a meta'
                // e il file arriverebbe mutilo sul PC, senza che nessuno se ne
                // accorga. Quello che riceviamo e' la busta firmata, mai piu'
                // piccola del documento dichiarato nell'albero: se e' meno della
                // meta' il file e' rotto. Non viene salvato ne' messo nel
                // manifest, quindi lo riprende il giro successivo.
                if (c.attesi > 0 && bytes.length < c.attesi / 2) {
                    return { ok: false, rel: c.rel,
                        errore: 'documento incompleto: ' + bytes.length + ' byte su ' + c.attesi + ' attesi' };
                }
                const p = pezziLocali(F.etichetta, c.rel);
                const b64 = bytesToBase64(buf);
                await semSalva.prendi();
                const tDisco = Date.now();
                let salva;
                try {
                    salva = await bgMessage({
                        action: 'astarSalva', cartella: p.cartella, parte: p.parte, nome: p.nome,
                        dataBase64: b64,
                    });
                } finally {
                    msDisco += Date.now() - tDisco;
                    semSalva.libera();
                }
                if (salva && salva.ok) {
                    // Accanto alla busta firmata si scrive anche l'XML in chiaro:
                    // il p7m e' illeggibile senza strumenti di firma, mentre
                    // l'XML estratto si apre e si controlla a vista. E' la copia
                    // che fa fede per i dati dell'atto - parti, codici fiscali,
                    // parte rappresentata dall'avvocato.
                    if (/\.xml\.p7m$/i.test(p.nome)) {
                        try {
                            const xmlStr = testoXmlDaBusta(buf);
                            if (xmlStr) {
                                await bgMessage({
                                    action: 'astarSalva', cartella: p.cartella, parte: p.parte,
                                    nome: p.nome.replace(/\.p7m$/i, ''),
                                    dataBase64: utf8ToBase64(xmlStr),
                                });
                            }
                        } catch (e) { /* l'XML in chiaro e' un in piu': non blocca lo scarico */ }
                    }
                    return { ok: true, rel: c.rel, byte: bytes.length };
                }
                return { ok: false, rel: c.rel, errore: (salva && salva.error) || 'salvataggio locale fallito' };
            }
            try { testo = new TextDecoder('utf-8').decode(bytes.subarray(0, 120)); } catch (e) { testo = ''; }
            return { ok: false, rel: c.rel, errore: 'HTTP ' + cod + ' ' + testo.trim() };
        };

        const passata = async (coda) => {
            const rimasti = [];
            let i = 0;
            const worker = async () => {
                while (i < coda.length) {
                    const c = coda[i++];
                    // I posti li prende scaricaUno, uno per la rete e uno per il
                    // disco: qui non si trattiene nulla, altrimenti un fascicolo
                    // andato male terrebbe occupata una corsia per tutta la corsa.
                    let esito;
                    try {
                        esito = await scaricaUno(c);
                    } catch (e) {
                        esito = { ok: false, errore: (e && e.message) || String(e) };
                    }
                    if (esito.ok) {
                        scaricato.push(esito.rel);
                        byteTot += esito.byte || 0;
                        if (opts.onProgress) { try { opts.onProgress(scaricato.length, daFare.length); } catch (e) { /* noop */ } }
                    } else {
                        rimasti.push(c);
                        c._errore = esito.errore;
                    }
                }
            };
            const n = Math.min(PARALLELE, coda.length);
            await Promise.all(Array.from({ length: n }, worker));
            return rimasti;
        };

        let rimasti = daFare;
        const tScarico = Date.now();
        for (let giro = 1; giro <= 3 && rimasti.length; giro++) {
            if (giro > 1) await new Promise((res) => setTimeout(res, 3000));
            rimasti = await passata(rimasti);
        }
        const msScarico = Date.now() - tScarico;
        for (const c of rimasti) falliti.push({ rel: c.rel, errore: c._errore || '' });

        // Rete di sicurezza sulle intestazioni, PRIMA di riscrivere il manifest:
        // qui il manifest porta ancora i nomi risolti nei giri precedenti, quindi
        // i depositi che stavolta le buste non hanno saputo battezzare recuperano
        // l'intestazione buona invece di finire sul database come segnaposto.
        rietichettaDaManifest(compiti, atti, manifest);

        // 5) Aggiorna il manifest: registra per idDoc ogni documento del fascicolo
        //    ora presente sul PC (tutti i compiti tranne quelli falliti). Cosi' la
        //    prossima sync massiva salta il fascicolo senza ri-scaricarlo, a
        //    prescindere dall'etichetta parte/sottocartella.
        try {
            const failedRel = new Set(falliti.map((f) => f.rel));
            let cambiato = false;
            for (const c of compiti) {
                if (failedRel.has(c.rel)) continue;
                if (c.id) {
                    const k = String(c.id);
                    if (!manifest.docs[k]) cambiato = true;
                    manifest.docs[k] = { nome: c.nome || '', rel: c.rel || '' };
                } else if (c.rel) {
                    // Documento senza idDoc: si registra per percorso, altrimenti
                    // il fascicolo non sarebbe mai considerato completo e ogni
                    // sync rifarebbe da zero tutto il lavoro preliminare.
                    if (!manifest.rels) manifest.rels = {};
                    if (!manifest.rels[c.rel]) cambiato = true;
                    manifest.rels[c.rel] = 1;
                }
            }
            if (cambiato || scaricato.length) {
                manifest.v = 1;
                manifest.updated = new Date().toISOString();
                // Timbro di verifica solo a corsa pulita: con documenti falliti
                // il fascicolo NON e' completo e va ricontrollato subito.
                if (!falliti.length) manifest.verificato_il = Date.now();
                await scriviManifest(cartellaFsc, manifest);
            } else if (!falliti.length) {
                manifest.v = 1;
                manifest.verificato_il = Date.now();
                await scriviManifest(cartellaFsc, manifest);
            }
        } catch (e) { /* best-effort: il delta per nome resta comunque valido */ }

        const secondi = Math.round((Date.now() - t0) / 100) / 10;
        const tS2 = Date.now();
        const [eventiFsc, partiFsc] = await Promise.all([
            pStorico || storicoEventi(F, token),
            opts.attiSempre ? (pParti || partiArchivio(F, token)) : Promise.resolve([]),
        ]);
        const schFsc = schedaDaComunicazioni(comFascicolo, eventiFsc);
        extra.storico = Date.now() - (schedaInAnticipo ? tAnticipo : tS2);
        const partiPdA2 = partiFsc;
        extra.portale = 0;
        const tU2 = Date.now();
        const udienza2 = schFsc.data_prossima_udienza
            || (opts.attiSempre ? await udienzaDaProvvedimenti(F, token, compiti, atti) : '');
        extra.udienza = Date.now() - tU2;
        return Object.assign({
            ok: falliti.length === 0,
            riprovabile: falliti.length > 0,
            messaggio: falliti.length === 0
                ? ('Scaricati ' + scaricato.length + ' documenti sul tuo PC')
                : (scaricato.length + ' scaricati, ' + falliti.length + ' non riusciti (riprova)'),
            documenti: {
                scaricati: scaricato.length,
                nel_fascicolo: totaleFascicolo,
                gia_presenti: giaPresenti,
                falliti: falliti.length,
                secondi: secondi,
                megabyte: Math.round(byteTot / 1048576 * 10) / 10,
                // Dove sono finiti i secondi: elenco atti e risoluzione parti
                // (preliminari), scarico complessivo, e dentro lo scarico quanto
                // e' rete del portale e quanto scrittura su disco. In coda i passi
                // che parlano col Portale anche quando non c'e' nulla da scaricare.
                tempi: {
                    elenco: Math.round(msElenco / 100) / 10,
                    parti: Math.round(msParti / 100) / 10,
                    locale: Math.round(msLocale / 100) / 10,
                    scarico: Math.round(msScarico / 100) / 10,
                    rete: Math.round(msRete / 100) / 10,
                    disco: Math.round(msDisco / 100) / 10,
                    storico: Math.round(extra.storico / 100) / 10,
                    portale: Math.round(extra.portale / 100) / 10,
                    udienza: Math.round(extra.udienza / 100) / 10,
                    buste: Math.round(extra.buste / 100) / 10,
                    nbuste: extra.nbuste,
                    noti: extra.noti, senzaId: extra.senzaId, tot: totaleFascicolo,
                            stato: Math.round(extra.stato / 100) / 10,
                            lista: Math.round(extra.lista / 100) / 10,
                            segnaposto: haSegnaposto ? (nomiGiaTentati ? 2 : 1) : 0,
                },
            },
            atti: atti,
            parti: partiPdA2,
            udienza: udienza2,
            dettaglioFalliti: falliti,
        }, schFsc);
    }

    /**
     * Scheda del fascicolo ricavata dalle comunicazioni di cancelleria, nei nomi
     * dei campi che il backend salva: giudice, sezione, oggetto, date di udienza
     * e cronologia degli eventi (tab "Aggiornamenti" del pannello).
     */
    function schedaDaComunicazioni(com, eventiPortale) {
        const out = {};
        // Difensori letti dagli XML delle buste (parte → avvocato): il dato vero,
        // che nelle esecuzioni il Portale non dichiara.
        if (com && Array.isArray(com.difensori) && com.difensori.length) out.difensori = com.difensori;
        if (com && Array.isArray(com.parti_xml) && com.parti_xml.length) out.parti_xml = com.parti_xml;
        if (com && Array.isArray(com.beni) && com.beni.length) out.beni = com.beni;
        // Cronologia: vince sempre il portale, che ha TUTTI gli eventi e la data
        // di registrazione. I comunicazione.txt restano come ripiego per i
        // fascicoli dove lo storico non risponde.
        const daPortale = Array.isArray(eventiPortale) ? eventiPortale : [];
        if (!com && !daPortale.length) return out;
        if (com) {
            if (com.giudice) out.giudice = com.giudice;
            if (com.sezione) out.sezione = com.sezione;
            if (com.oggetto) out.oggetto = com.oggetto;
        }
        if (daPortale.length) {
            out.aggiornamenti = daPortale.map((e) => ({
                data_evento: e.data_evento,
                data_registrazione: e.data_registrazione,
                descrizione: e.descrizione,
            }));
        } else if (com && com.eventi && com.eventi.length) {
            out.aggiornamenti = com.eventi.map((e) => ({
                data_evento: e.data_evento,
                descrizione: [e.oggetto, e.descrizione].filter(Boolean).join(' — '),
            })).filter((a) => a.data_evento && a.descrizione);
        }
        // Udienze: si leggono dalla cronologia piu' ricca fra le due.
        const perUdienze = daPortale.length
            ? daPortale.map((e) => ({ data_evento: e.data_evento, udienza: udienzaDaTesto(e.descrizione) }))
            : (com ? com.eventi : []);
        const u = udienzeDaEventi(perUdienze);
        if (u.prossima) out.data_prossima_udienza = u.prossima;
        if (u.ultima) out.data_ultima_udienza = u.ultima;
        return out;
    }

    /**
     * Prossima udienza letta dai decreti di fissazione, cioe' dai datiAtto dei
     * provvedimenti di ufficio. Per i Giudici di Pace il profilo del portale non
     * riporta la prossima udienza: senza questa lettura il fascicolo resta senza
     * data e nel pannello scivola in fondo all'elenco.
     */
    async function udienzaDaProvvedimenti(F, token, compiti, atti) {
        const cand = [];
        for (let i = 0; i < compiti.length; i++) {
            const a = atti[i];
            if (!a || a.categoria !== 'provvedimenti_di_ufficio') continue;
            if (!/datiatto[^\/\\]*\.xml(\.p7m)?$/i.test(String(compiti[i].nome || ''))) continue;
            cand.push(compiti[i]);
        }
        if (!cand.length) return '';
        const post = servizioScarico(F);
        const hPost = Object.assign(intestazioni(F, token), { 'Content-Type': 'application/json', 'Accept': '*/*' });
        let migliore = '';
        const udienze = await inPool(cand, 10, async (c) => {
            try {
                const corpo = JSON.stringify({
                    area: F.area, nome: c.nome || 'datiAtto.xml', isArchivio: false,
                    idRepeAtto: c.id, idDoc: c.id, original: true,
                    distretto: F.distretto, idUfficio: F.ufficio,
                });
                const r = await fetch(post, { method: 'POST', headers: hPost, body: corpo, credentials: 'include' });
                if (r.status !== 200) return '';
                const info = parseParteDaBusta(await r.arrayBuffer());
                return (info && info.udienza) || '';
            } catch (e) { return ''; }
        });
        for (const u of udienze) if (u && u > migliore) migliore = u;
        return migliore;
    }

    /**
     * Parti del fascicolo nel formato dell'archivio: una riga per parte con
     * l'elenco dei suoi difensori. Il profilo del portale ripete la stessa
     * parte una volta per difensore (stesso idParte), qui si raggruppa.
     */
    async function partiArchivio(F, token) {
        let lista = [];
        try { lista = await profiloParti(F, token); } catch (e) { return []; }
        const per = {};
        const ordine = [];
        for (const p of (lista || [])) {
            const k = (p.cf || '') + '|' + normaNome((p.cognome || '') + ' ' + (p.nome || '')) + '|' + (p.tipo || '');
            if (!per[k]) {
                per[k] = {
                    cognome: p.cognome || '', nome: p.nome || '',
                    tipo: p.tipo || '', cf_parte: p.cf || '',
                    data_nascita: p.nascita || '', avvocati: [],
                };
                ordine.push(k);
            }
            if (p.avv) {
                const giaVisto = per[k].avvocati.some((a) => normaNome(a.nome_avvocato) === normaNome(p.avv));
                if (!giaVisto) per[k].avvocati.push({ nome_avvocato: p.avv, cf_avvocato: p.avvCf || '' });
            }
        }
        return ordine.map((k) => per[k]);
    }

    function toTitleCase(str) {
        return String(str || '').replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.substr(1).toLowerCase());
    }

    // ── Manifest di fascicolo (indice dei documenti gia' scaricati) ──────────────
    // File JSON scritto DENTRO la cartella del fascicolo sul PC dell'avvocato
    // (Documenti\PCT Monitor\<fascicolo>\_pct_index.json). Indicizza ogni documento
    // per il suo idDoc STABILE: cosi' la sync massiva non ri-scarica un fascicolo
    // gia' presente anche se cambia l'etichetta della parte/sottocartella (motivo
    // per cui i fascicoli SIGP si ri-scaricavano). E' co-locato coi file: se
    // l'avvocato cancella la cartella, il manifest sparisce con essa e i documenti
    // vengono ri-scaricati (comportamento voluto). Best-effort: ogni errore ricade
    // sul vecchio delta per nome/parte, senza regressioni.
    const MANIFEST_NOME = '_pct_index.json';

    // Finestra della cache di verifica: entro questi minuti dall'ultimo
    // confronto riuscito col portale, un fascicolo risultato completo si salta
    // senza richiamare il portale. Oltre la finestra si ricontrolla come prima.
    const FINESTRA_VERIFICA_MS = 15 * 60 * 1000;

    function base64ToUtf8(b64) {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new TextDecoder('utf-8').decode(arr);
    }
    function utf8ToBase64(str) {
        const arr = new TextEncoder().encode(str);
        let bin = '';
        const ch = 0x8000;
        for (let i = 0; i < arr.length; i += ch) bin += String.fromCharCode.apply(null, arr.subarray(i, i + ch));
        return btoa(bin);
    }

    async function leggiManifest(cartella) {
        try {
            const r = await bgMessage({ action: 'astarApriDocumento', cartella: cartella, parte: '', nome: MANIFEST_NOME, raw: true });
            if (r && r.ok && r.dataBase64) {
                const j = JSON.parse(base64ToUtf8(r.dataBase64));
                if (j && typeof j === 'object' && j.docs && typeof j.docs === 'object') return j;
            }
        } catch (e) { /* manifest assente o illeggibile: si riparte da vuoto */ }
        return { v: 1, docs: {} };
    }
    async function scriviManifest(cartella, manifest) {
        try {
            const b64 = utf8ToBase64(JSON.stringify(manifest));
            await bgMessage({ action: 'astarSalva', cartella: cartella, parte: '', nome: MANIFEST_NOME, dataBase64: b64 });
        } catch (e) { /* best-effort */ }
    }

    /**
     * Impronta dei documenti registrati nel manifest.
     *
     * Serve a capire se dall'ultima corsa e' arrivato qualcosa di nuovo. Un
     * fascicolo con cartelle ancora senza nome ("ND - ...") rifaceva ad ogni
     * sync tutto il lavoro di battesimo: elenco atti dal Portale e rilettura
     * delle buste, oltre due minuti, per riottenere lo stesso risultato. Con
     * l'impronta il tentativo si rifa' solo quando i documenti cambiano.
     */
    function improntaManifest(m) {
        const chiavi = Object.keys((m && m.docs) || {}).sort()
            .concat(Object.keys((m && m.rels) || {}).sort());
        const s = chiavi.join('|');
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
        // Il suffisso ':rNN' lega l'impronta alla versione della logica di
        // rietichettatura delle parti: alzandolo, al primo sync di ogni fascicolo
        // "nomiGiaTentati" torna falso una volta, cosi' la via rapida NON salta
        // risolviPartiSegnaposto e le cartelle si riallineano alla regola nuova.
        // Dopo quella passata l'impronta viene riscritta e i sync tornano veloci.
        return chiavi.length + ':' + h.toString(36) + ':r17';
    }

    // ── Dalla busta firmata (p7m) al documento XML ────────────────────────────
    // "Si legge sempre l'XML estratto dal p7m": qui si tira fuori il payload XML
    // dalla busta CAdES. Il testo estratto serve a due cose: leggere i dati
    // dell'atto e scrivere l'XML in chiaro accanto alla busta, cosi' il
    // contenuto resta consultabile senza strumenti di firma.
    function testoXmlDaBusta(buf) {
        try {
            const bytes = new Uint8Array(buf);
            // Individua l'inizio dell'XML ('<?xml') nei byte della busta.
            let start = -1;
            for (let i = 0; i + 4 < bytes.length; i++) {
                if (bytes[i] === 0x3c && bytes[i + 1] === 0x3f && bytes[i + 2] === 0x78 && bytes[i + 3] === 0x6d && bytes[i + 4] === 0x6c) { start = i; break; }
            }
            if (start < 0) {
                // Non tutti i p7m incapsulano un XML col prologo '<?xml': in quel
                // caso si cerca l'inizio del primo elemento ('<Lettera'). Senza
                // questo ripiego la busta firmata veniva scartata in blocco e
                // l'atto restava per sempre senza parte ("ND - SENZA NOME").
                for (let i = 0; i + 1 < bytes.length; i++) {
                    const d = bytes[i + 1];
                    const isLetter = (d >= 0x41 && d <= 0x5a) || (d >= 0x61 && d <= 0x7a);
                    if (bytes[i] === 0x3c && isLetter) { start = i; break; }
                }
            }
            if (start < 0) return null;
            // Alcuni p7m (tipico SIGP) incapsulano l'XML in un OCTET STRING "costruito"
            // a blocchi: ogni ~1000 byte c'e' un header DER (tag 0x04 + lunghezza) che
            // finisce anche dentro i tag e rompe il parsing. Qui si rimuovono. Il tag
            // 0x04 non compare mai nel testo XML valido, quindi e' sicuro.
            const cleanBytes = [];
            for (let k = start; k < bytes.length;) {
                const c = bytes[k];
                if (c === 0x04) {
                    const n = bytes[k + 1];
                    if (n === 0x81) { k += 3; continue; }
                    if (n === 0x82) { k += 4; continue; }
                    if (n === 0x83) { k += 5; continue; }
                    if (n !== undefined && n < 0x80) { k += 2; continue; }
                    k += 1; continue;
                }
                cleanBytes.push(c); k++;
            }
            let xmlStr = new TextDecoder('utf-8').decode(new Uint8Array(cleanBytes));
            {
                const rootMatch = xmlStr.match(/<([A-Za-z_][\w:.-]*)(?:\s[^>]*)?>/);
                if (rootMatch) {
                    const rootTag = rootMatch[1];
                    const tagRegex = new RegExp('<(' + rootTag + ')(?:\\s[^>]*)?>|<\\/(' + rootTag + ')>', 'g');
                    let depth = 0, m, endPos = -1;
                    while ((m = tagRegex.exec(xmlStr)) !== null) {
                        if (m[1]) depth++;
                        else { depth--; if (depth === 0) { endPos = m.index + m[0].length; break; } }
                    }
                    if (endPos > 0) xmlStr = xmlStr.substring(0, endPos);
                }
            }
            xmlStr = xmlStr.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
            // L'XML deve almeno essere ben formato, altrimenti non e' il payload
            // cercato e scriverlo su disco servirebbe solo a confondere.
            try {
                const prova = new DOMParser().parseFromString(xmlStr, 'application/xml');
                if (!prova || !prova.documentElement || prova.querySelector('parsererror')) return null;
            } catch (e) { return null; }
            return xmlStr;
        } catch (e) { return null; }
    }

    /** DOM dell'XML estratto dalla busta firmata. */
    function documentoDaBusta(buf) {
        const xmlStr = testoXmlDaBusta(buf);
        if (!xmlStr) return null;
        try {
            const doc = new DOMParser().parseFromString(xmlStr, 'application/xml');
            if (doc.querySelector('parsererror')) return null;
            return doc.documentElement ? doc : null;
        } catch (e) { return null; }
    }

    /**
     * Tutte le coppie "parte → difensore" dichiarate nell'XML della busta.
     *
     * L'atto introduttivo delle esecuzioni le scrive per esteso:
     * <pt:Parte ID="1">BARESCHINO</pt:Parte> e
     * <pt:Avvocato><at:cognome>BARUFFI</at:cognome>
     *   <at:parteRappresentata ref="1"/></pt:Avvocato>.
     * Questa e' la fonte vera del difensore: il Portale, nelle esecuzioni, non lo
     * dichiara affatto. Ritorna [{ cfParte, nomeParte, nome, cf }].
     */
    function difensoriDaBusta(buf) {
        const doc = documentoDaBusta(buf);
        if (!doc) return [];
        try {
            const ln = (e) => String((e && (e.localName || e.nodeName)) || '').toLowerCase();
            const tutti = Array.from(doc.documentElement.querySelectorAll('*'));
            const attr = (el, nome) => {
                for (const a of Array.from((el && el.attributes) || [])) {
                    if (String(a.localName || a.name || '').toLowerCase() === nome) return String(a.value || '').trim();
                }
                return '';
            };
            const figlio = (el, nome) => {
                const e = Array.from(el.querySelectorAll('*')).find((x) => ln(x) === nome);
                return e ? String(e.textContent || '').trim() : '';
            };
            // Parti per ID. Ogni schema del Portale le chiama a modo suo:
            // <Parte>/<ControParte>/<TerzaParte> negli atti introduttivi,
            // <Parte>/<Chiamato> dentro <ModificheAnagrafica><Partecipanti>
            // dell'atto di intervento, e nelle esecuzioni compaiono anche
            // creditore, debitore, intervenuto e <Altro> per i terzi pignorati.
            // Si accettano tutti: quello che conta e' che l'avvocato punti a
            // uno di questi con il suo ref.
            const TAG_PARTE = ['parte', 'controparte', 'terzaparte', 'chiamato',
                'partechiamata', 'creditore', 'creditoreintervenuto', 'intervenuto',
                'debitore', 'esecutato', 'terzo', 'altro'];
            const perId = {};
            for (const el of tutti) {
                if (TAG_PARTE.indexOf(ln(el)) < 0) continue;
                const id = attr(el, 'id');
                if (!id) continue;
                const cogn = figlio(el, 'cognome') || figlio(el, 'denominazione');
                const nm = figlio(el, 'nome');
                perId[id] = {
                    cf: (figlio(el, 'codicefiscale') || attr(el, 'codicefiscale')).toUpperCase(),
                    nome: (cogn + ' ' + nm).replace(/\s+/g, ' ').trim(),
                    tipo: ({ parte: 'AP', controparte: 'CP', creditore: 'AP', creditoreintervenuto: 'APC', debitore: 'CP', esecutato: 'CP', terzaparte: 'TP', terzo: 'TP', altro: 'TP' })[ln(el)] || '',
                };
            }
            const out = [];
            for (const av of tutti.filter((e) => ln(e) === 'avvocato')) {
                const cf = (figlio(av, 'codicefiscale') || '').toUpperCase();
                const cogn = figlio(av, 'cognome') || figlio(av, 'denominazione');
                const nm = figlio(av, 'nome');
                const nome = (toTitleCase(cogn) + ' ' + toTitleCase(nm)).replace(/\s+/g, ' ').trim();
                if (!cf && !nome) continue;
                const rapp = Array.from(av.querySelectorAll('*')).filter((e) => ln(e) === 'parterappresentata');
                for (const r of rapp) {
                    const ref = attr(r, 'ref');
                    const p = ref ? perId[ref] : null;
                    // Senza riferimento alla parte il dato non si puo' usare: non
                    // si indovina chi difende, si lascia stare.
                    if (!p || (!p.cf && !p.nome)) continue;
                    out.push({ cfParte: p.cf, nomeParte: p.nome, tipoParte: p.tipo, nome: nome, cf: cf });
                }
            }
            return out;
        } catch (e) { return []; }
    }

    /**
     * Tutti i partecipanti dichiarati nell'XML della busta, con il codice
     * fiscale che fa fede. A differenza di difensoriDaBusta (che elenca solo
     * le parti difese da un avvocato), qui ci stanno anche i terzi pignorati
     * e le banche: il Portale a volte riporta il loro CF sbagliato (INTESA
     * SANPAOLO elencata col CF di POSTE ITALIANE), e questa lettura permette
     * al backend di correggerlo. Ritorna [{cf, nome}].
     */
    function partecipantiDaBusta(buf) {
        const doc = documentoDaBusta(buf);
        if (!doc) return [];
        try {
            const ln = (e) => String((e && (e.localName || e.nodeName)) || '').toLowerCase();
            const attr = (el, nome) => {
                for (const a of Array.from((el && el.attributes) || [])) {
                    if (String(a.localName || a.name || '').toLowerCase() === nome) return String(a.value || '').trim();
                }
                return '';
            };
            const figlio = (el, nome) => {
                const e = Array.from(el.querySelectorAll('*')).find((x) => ln(x) === nome);
                return e ? String(e.textContent || '').trim() : '';
            };
            const TAG_PARTE = ['parte', 'controparte', 'terzaparte', 'chiamato',
                'partechiamata', 'creditore', 'creditoreintervenuto', 'intervenuto',
                'debitore', 'esecutato', 'terzo', 'altro'];
            const out = [];
            const visti = {};
            for (const el of Array.from(doc.documentElement.querySelectorAll('*'))) {
                if (TAG_PARTE.indexOf(ln(el)) < 0) continue;
                // Salta i wrapper: alcuni schemi (es. liquidazione giudiziale)
                // annidano la parte dentro un contenitore con lo stesso nome e
                // accanto all'avvocato - <Creditore><creditore/><avvocato/></Creditore>.
                // Una parte "vera" contiene solo l'anagrafica, mai un'altra parte
                // o un avvocato: senza questo filtro figlio() pescherebbe cognome
                // e nome dell'avvocato (il creditore ASTAR finiva "BERTUCCELLI VERONICA").
                const annidati = Array.from(el.querySelectorAll('*')).some(
                    (x) => x !== el && (TAG_PARTE.indexOf(ln(x)) >= 0 || ln(x) === 'avvocato'));
                if (annidati) continue;
                const cogn = figlio(el, 'cognome') || figlio(el, 'denominazione');
                const nm = figlio(el, 'nome');
                const cf = (figlio(el, 'codicefiscale') || attr(el, 'codicefiscale')).toUpperCase();
                const nome = (cogn + ' ' + nm).replace(/\s+/g, ' ').trim();
                if (!nome || !cf) continue;
                // Dedup per CF e per nome: piu' atti dichiarano la stessa parte.
                const kc = cfChiave(cf);
                const kn = 'N:' + normaNome(nome);
                if ((kc && visti[kc]) || visti[kn]) continue;
                if (kc) visti[kc] = true;
                visti[kn] = true;
                out.push({ cf: cf, nome: nome });
            }
            return out;
        } catch (e) { return []; }
    }

    async function partecipantiXmlLocale(cartella, maxFile) {
        const result = { parti: [], difensori: [], beni: [] };
        try {
            const elenco = await bgMessage({ action: 'astarElenco', cartella: cartella });
            if (!elenco || !elenco.ok || !Array.isArray(elenco.files)) return result;
            const files = elenco.files.filter((f) => f && f.path && /^datiatto.*\.xml(?:\.p7m)?$/i.test(String(f.nome || '')));
            const xmlPresenti = new Set(files.filter((f) => /\.xml$/i.test(f.nome)).map((f) => pulisci(f.parte || '') + '\u0000' + pulisci(f.nome).toLowerCase()));
            const selezionati = files.filter((f) => !/\.p7m$/i.test(f.nome)
                || !xmlPresenti.has(pulisci(f.parte || '') + '\u0000' + pulisci(String(f.nome).replace(/\.p7m$/i, '')).toLowerCase()));
            const vistiParti = new Set();
            const vistiDifensori = new Set();
            // Prima gli atti di parte: sono i soli che dichiarano <Avvocato> con
            // parteRappresentata e i dati catastali dei beni. I provvedimenti
            // d'ufficio non nominano difensori, quindi quando c'e' un tetto al
            // numero di file non devono rubare il posto a una comparsa di
            // costituzione (nel 178/2024 meta' dei DatiAtto sono d'ufficio).
            const inOrdine = selezionati.slice().sort((a, b) => {
                const ua = /uffic/i.test(String(a.parte || '')) ? 1 : 0;
                const ub = /uffic/i.test(String(b.parte || '')) ? 1 : 0;
                return ua - ub;
            });
            for (const file of inOrdine.slice(0, Math.max(1, maxFile || 40))) {
                const letto = await bgMessage({ action: 'astarApriDocumento', path: file.path, nome: file.nome });
                if (!letto || !letto.ok || !letto.dataBase64) continue;
                const bin = atob(letto.dataBase64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const xml = testoXmlDaBusta(bytes);
                if (!xml) continue;
                if (/\.p7m$/i.test(file.nome)) {
                    await bgMessage({
                        action: 'astarSalva', cartella: cartella, parte: file.parte,
                        nome: String(file.nome).replace(/\.p7m$/i, ''), dataBase64: utf8ToBase64(xml),
                    });
                }
                for (const p of partecipantiDaBusta(bytes)) {
                    const k = normaNome(p.nome);
                    if (!k || vistiParti.has(k)) continue;
                    vistiParti.add(k);
                    result.parti.push(p);
                }
                for (const d of difensoriDaBusta(bytes)) {
                    const k = cfChiave(d.cfParte) || normaNome(d.nomeParte);
                    if (!k || vistiDifensori.has(k)) continue;
                    vistiDifensori.add(k);
                    result.difensori.push(d);
                }
                if (!result.beni.length) result.beni.push(...beniDaBusta(bytes));
            }
        } catch (e) { /* dato accessorio: la sincronizzazione prosegue */ }
        return result;
    }

    // ── Beni immobili con i dati catastali ────────────────────────────────────
    // Il servizio del Portale per la scheda Beni da' solo descrizione, stato,
    // ubicazione, frazione e tipo diritto: catasto, foglio, particella,
    // subalterno e classe stanno soltanto nell'XML del pignoramento, che sta
    // qui sul PC. Il formato prodotto e' quello che il server salva nella lente
    // (descrizione + chiave di ubicazione + gruppi da mostrare).
    function beniDaBusta(buf) {
        const doc = documentoDaBusta(buf);
        if (!doc) return [];
        try {
            const ln = (e) => String((e && (e.localName || e.nodeName)) || '').toLowerCase();
            const attr = (el, nome) => {
                for (const a of Array.from((el && el.attributes) || [])) {
                    if (String(a.localName || a.name || '').toLowerCase() === nome) return String(a.value || '').trim();
                }
                return '';
            };
            const figli = (el, nome) => Array.from(el.children || []).filter((x) => ln(x) === nome);
            const figlio = (el, nome) => {
                const e = figli(el, nome)[0];
                return e ? String(e.textContent || '').trim() : '';
            };
            const tutti = Array.from(doc.documentElement.querySelectorAll('*'));
            const contenitore = tutti.find((e) => ln(e) === 'beni');
            if (!contenitore) return [];

            // Quota e stima del diritto pignorato stanno in un altro ramo dello
            // stesso atto, collegate al bene con refBene.
            const diritti = {};
            for (const dd of tutti.filter((e) => ln(e) === 'datidebitore')) {
                const cfDeb = attr(dd, 'codicefiscale');
                for (const bp of Array.from(dd.querySelectorAll('*')).filter((e) => ln(e) === 'benepignorato')) {
                    const ref = attr(bp, 'refbene');
                    if (!ref) continue;
                    for (const dr of Array.from(bp.querySelectorAll('*')).filter((e) => ln(e) === 'dirittireali')) {
                        let q = attr(dr, 'quota');
                        if (q && !isNaN(parseFloat(q))) {
                            q = (parseFloat(q) === 1) ? '1/1' : String(parseFloat(q));
                        }
                        (diritti[ref] = diritti[ref] || []).push({
                            Debitore: cfDeb || '—',
                            Quota: q || '—',
                            Stima: attr(dr, 'stima') || '—',
                        });
                    }
                }
            }

            const out = [];
            for (const b of Array.from(contenitore.children || [])) {
                const id = attr(b, 'id');
                const desc = figlio(b, 'descrizione');
                let via = '', civ = '', cap = '', loc = '', prov = '', stato = '';
                const ind = figli(b, 'indirizzo')[0];
                if (ind) {
                    via = figlio(ind, 'via'); civ = figlio(ind, 'civico');
                    cap = figlio(ind, 'cap'); loc = figlio(ind, 'localita');
                    prov = figlio(ind, 'provincia'); stato = figlio(ind, 'stato');
                }
                const catasto = figlio(b, 'catasto');
                let classe = '';
                const cl = figli(b, 'classe')[0];
                if (cl) {
                    classe = String(cl.textContent || '').trim();
                    if (attr(cl, 'classato').toLowerCase() === 'false') classe = (classe + ' (non classato)').trim();
                }
                const catastali = figli(b, 'daticatastali').map((dc) => ({
                    Catasto: catasto || '—',
                    Sezione: figlio(dc, 'sezione') || '—',
                    Foglio: figlio(dc, 'foglio') || '—',
                    Particella: figlio(dc, 'particella') || '—',
                    Subalterno: figlio(dc, 'subalterno') || '—',
                    Classe: classe || '—',
                }));

                const dettaglio = {};
                if (catastali.length) dettaglio['Dati catastali'] = catastali;
                if (via || loc || cap) {
                    dettaglio['Ubicazione'] = [{
                        Via: via || '—', Civico: civ || '—', CAP: cap || '—',
                        'Localita': loc || '—', Provincia: prov || '—', Stato: stato || '—',
                    }];
                }
                if (id && diritti[id] && diritti[id].length) dettaglio['Diritti pignorati'] = diritti[id];
                if (!Object.keys(dettaglio).length) continue;

                out.push({ descrizione: desc, chiave_ubi: via + loc + prov + cap, dettaglio: dettaglio });
            }
            return out;
        } catch (e) { return []; }
    }

    // ── Legge la parte principale dal datiAtto (xml o p7m) ────────────────────
    // Stessa logica dello scarico del SINGOLO fascicolo (client-side, DOMParser):
    // estrae il payload XML dalla busta CAdES, individua il nodo <Parte> e
    // compone il nominativo. Ritorna { isProvv, refId, name, cf } oppure null.
    function parseParteDaBusta(buf) {
        const doc0 = documentoDaBusta(buf);
        if (!doc0) return null;
        try {
            const doc = doc0;
            const root = doc.documentElement;
            if (!root) return null;
            const rootNs = (root.namespaceURI || '').toLowerCase();
            const rootLower = (root.localName || root.nodeName || '').toLowerCase();
            const isProvv = rootNs.includes('sigp/giudice') || rootNs.includes('sigp/provvedimenti') ||
                ['decreto', 'ordinanza', 'sentenza', 'provvedimento'].includes(rootLower);
            const all = Array.from(root.querySelectorAll('*'));
            const refIdAttr = root.getAttribute('RefId') || root.getAttribute('refId') || root.getAttribute('refid');
            const refIdEl = all.find((el) => (el.localName || '').toLowerCase() === 'refid');
            const refId = (refIdAttr || (refIdEl ? refIdEl.textContent : '')).trim();
            // Decreto di fissazione udienza: la data sta negli attributi, non in un
            // nodo testuale (<DecretoFissazioneUdienza DataUdienza="2027-01-21"
            // OraUdienza="09:00:00.096"/>). Per i Giudici di Pace questa e' la sola
            // fonte della prossima udienza: il profilo del portale non la riporta.
            let udienza = '';
            for (const el of all.concat([root])) {
                const att = Array.from(el.attributes || []);
                const dataAttr = att.find((a) => (a.localName || a.name || '').toLowerCase() === 'dataudienza');
                if (!dataAttr || !/^\d{4}-\d{2}-\d{2}/.test(String(dataAttr.value || ''))) continue;
                const oraAttr = att.find((a) => (a.localName || a.name || '').toLowerCase() === 'oraudienza');
                const val = String(dataAttr.value).slice(0, 10)
                    + (oraAttr ? ' ' + String(oraAttr.value || '').slice(0, 5) : '');
                if (val > udienza) udienza = val;
            }
            if (isProvv) return { isProvv: true, refId: refId, name: '', cf: '', udienza: udienza };
            const parteNode = all.find((el) => (el.localName || el.nodeName || '').toLowerCase() === 'parte');
            let name = '', cf = '', cognome = '', nomeProprio = '';
            if (parteNode) {
                const inside = Array.from(parteNode.querySelectorAll('*'));
                // SOLO dentro al nodo <Parte>: cercare nel resto del documento
                // pescava il <nome> dell'<Avvocato> e la parte diventava
                // "AUTOCARROZZERIA DR SRLS MANUELA" (nome del difensore).
                // I dati possono stare come figli <at:denominazione> oppure come
                // attributi del nodo stesso: AttoRichiestaVisibilita scrive
                // <Parte ID="1" codiceFiscale="00181760455"/>, tutto in attributo.
                const attr = (ln) => {
                    for (const a of Array.from(parteNode.attributes || [])) {
                        if ((a.localName || a.name || '').toLowerCase() === ln) return String(a.value || '').trim();
                    }
                    return '';
                };
                const pick = (ln) => {
                    const e = inside.find((x) => (x.localName || '').toLowerCase() === ln);
                    return e ? String(e.textContent || '').trim() : attr(ln);
                };
                const denomStr = pick('denominazione');
                const cognStr = pick('cognome');
                const nomeStr = pick('nome');
                cf = pick('codicefiscale');
                // La natura giuridica decide la forma del nome. Attenzione: SIGP
                // mette il COGNOME in <denominazione> anche per le persone fisiche
                // (naturaGiuridica="PFI": denominazione=HUSSAIN, nome=TASADAQ),
                // quindi l'ente non si deduce dalla presenza di <denominazione>.
                // Enti (ENP, PGI, PGE...): un solo nome, nessun nome proprio.
                const nat = String(parteNode.getAttribute('naturaGiuridica')
                    || parteNode.getAttribute('naturagiuridica') || '');
                const ente = nat !== '' ? !/^PF/i.test(nat) : (nomeStr === '');
                if (ente) {
                    cognome = denomStr || cognStr;
                    nomeProprio = '';
                    name = cognome;
                } else {
                    cognome = toTitleCase(cognStr || denomStr);
                    nomeProprio = toTitleCase(nomeStr);
                    name = (cognome + ' ' + nomeProprio).trim();
                }
            }
            // Ripiego: alcuni atti (es. DepositoNoteScritteSostUdie del Giudice di
            // Pace) NON hanno il nodo <Parte>, ma dichiarano il depositante come
            // codice fiscale nudo in <codiceFiscaleParte>. Senza questo ripiego
            // l'atto resta per sempre sotto "ND - SENZA NOME" pur avendo il dato
            // nel XML: col solo CF il backend abbina la parte gia' nota.
            if (!cf) {
                const cfEl = all.find((el) => {
                    const ln = (el.localName || el.nodeName || '').toLowerCase();
                    return ln === 'codicefiscaleparte' || ln === 'cfparte';
                });
                if (cfEl) cf = String(cfEl.textContent || '').trim();
            }
            // Avvocato della parte: <Soggetti><Avvocato> con
            // <parteRappresentata ref="..."> che punta all'attributo ID del nodo
            // <Parte>. Cosi' il convenuto porta con se' il suo difensore, che
            // altrimenti resterebbe vuoto in scheda (il PdA fornisce solo
            // l'avvocato loggato).
            let avvNome = '', avvCf = '';
            try {
                const parteId = parteNode ? (parteNode.getAttribute('ID') || parteNode.getAttribute('id') || '') : '';
                const avvNodes = all.filter((el) => (el.localName || el.nodeName || '').toLowerCase() === 'avvocato');
                for (const av of avvNodes) {
                    const figli = Array.from(av.querySelectorAll('*'));
                    const ln = (e) => (e.localName || e.nodeName || '').toLowerCase();
                    const rapp = figli.find((e) => ln(e) === 'parterappresentata');
                    const ref = rapp ? (rapp.getAttribute('ref') || '') : '';
                    if (parteId && ref && ref !== parteId) continue;
                    const leggi = (nome) => {
                        const el = figli.find((e) => ln(e) === nome);
                        return el ? String(el.textContent || '').trim() : '';
                    };
                    const cogn = leggi('cognome') || leggi('denominazione');
                    const nm2 = leggi('nome');
                    avvNome = (toTitleCase(cogn) + ' ' + toTitleCase(nm2)).trim();
                    avvCf = leggi('codicefiscale').toUpperCase();
                    if (avvNome || avvCf) break;
                }
            } catch (e) { /* avvocato opzionale: non blocca la lettura della parte */ }
            return { isProvv: false, refId: refId, name: name, cf: cf, cognome: cognome,
                     nomeProprio: nomeProprio, avvNome: avvNome, avvCf: avvCf };
        } catch (e) { return null; }
    }

    // ── Risolve il nome parte reale per i depositi lasciati "senza parte" ──────
    // Il tree del PdA a volte non espone cognome/nome parte (tipico Giudice di
    // Pace) e il deposito finisce sotto "ND - SENZA NOME". Il nome vero e' pero'
    // dentro il datiAtto.xml della busta: qui lo si legge e, tramite il backend
    // (che riusa la logica PHP di disambiguazione ruoli), si ottiene l'etichetta
    // "RUOLO - NOME (CF)". Le voci compiti/atti vengono riscritte in-place, cosi'
    // cartelle sul PC e record atti nel DB nascono gia' corretti e coerenti.
    // Cache locale (chrome.storage) delle etichette parte gia' risolte, per
    // fascicolo: cosi' ai sync successivi NON si ri-scarica il datiAtto e il
    // delta "gia' presente" combacia (nessun ri-download di file vecchi).
    function storageGet(key) {
        return new Promise((res) => {
            try { chrome.storage.local.get([key], (o) => res((o && o[key]) || null)); }
            catch (e) { res(null); }
        });
    }
    function storageSet(key, val) {
        return new Promise((res) => {
            try { chrome.storage.local.set({ [key]: val }, () => res(true)); }
            catch (e) { res(false); }
        });
    }

    /**
     * Legge i comunicazione.txt di cancelleria allegati ai provvedimenti
     * d'ufficio. Un file tipico dice tutto quello che il datiAtto non dice:
     *
     *   Sezione: 03
     *   Giudice: STORELLI FRANCESCO
     *   Ricorrente Principale: CAGETTI ILIO
     *   Resistente Principale: ALD AUTOMOTIVE SRL
     *   Data Evento: 15/10/2024
     *   Oggetto: RINVIO AD ALTRA UDIENZA
     *   Descrizione: UDIENZA RINVIATA AL 28/10/2024 ore 09:00 IN PRESENZA
     *
     * Serve per tre cose: NOMINARE la parte che il datiAtto cita col solo
     * codice fiscale, ricostruire la cronologia degli eventi e leggere le date
     * di udienza (fissazione e rinvii), che nel XML spesso non ci sono.
     * Una sola lettura per fascicolo, in cache per una settimana.
     */
    async function leggiComunicazioni(F, token, gruppi) {
        const vuoto = { roster: [], eventi: [], giudice: '', sezione: '', oggetto: '' };
        const ck = 'pctComunicazioni:' + pulisci(F.etichetta);
        try {
            const c = await storageGet(ck);
            if (c && c.dati && c.v === 1 && (Date.now() - (c.t || 0)) < 7 * 86400000) return c.dati;
        } catch (e) { /* si rilegge dal portale */ }
        const conTxt = gruppi.filter((g) => g.comunicazioneId);
        if (!conTxt.length) return vuoto;
        const post = servizioScarico(F);
        const hPost = Object.assign(intestazioni(F, token), { 'Content-Type': 'application/json', 'Accept': '*/*' });
        const dati = { roster: [], eventi: [], giudice: '', sezione: '', oggetto: '' };
        const visti = {};
        const aggiungiParte = (nome, tipo) => {
            const n = String(nome || '').replace(/\s+/g, ' ').trim();
            // Scarta i segnaposto del modello di cancelleria ("<nome ...>").
            if (n === '' || n.charAt(0) === '<' || /^-+$/.test(n)) return;
            const k = normaNome(n);
            if (!k || visti[k]) return;
            visti[k] = true;
            dati.roster.push({ nome: n, tipo: tipo });
        };
        const pulisciVal = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        // "28/10/2024 ore 13:40" -> "2024-10-28 13:40", come il resto dell'archivio.
        const dataOra = (g, m, a, hh, mm) => a + '-' + m + '-' + g + (hh ? ' ' + hh + ':' + (mm || '00') : '');
        const testi = [];
        const scaricati = await inPool(conTxt.slice(0, 30), 10, async (g) => {
            try {
                const corpo = JSON.stringify({
                    area: F.area, nome: g.comunicazioneNome || 'comunicazione.txt', isArchivio: false,
                    idRepeAtto: g.comunicazioneId, idDoc: g.comunicazioneId, original: true,
                    distretto: F.distretto, idUfficio: F.ufficio,
                });
                const r = await fetch(post, { method: 'POST', headers: hPost, body: corpo, credentials: 'include' });
                if (r.status !== 200) return '';
                return String(await r.text());
            } catch (e) { return ''; }
        });
        for (const t of scaricati) if (t) testi.push(t);
        for (const testo of testi) {
            const ev = { data_evento: '', tipo: '', oggetto: '', descrizione: '', udienza: '' };
            for (const riga of testo.split(/\r?\n/)) {
                let m = /^\s*(?:Ricorrente|Attore)\b[^:]*:\s*(.+)$/i.exec(riga);
                if (m) { aggiungiParte(m[1], 'AP'); continue; }
                m = /^\s*(?:Resistente|Convenuto)\b[^:]*:\s*(.+)$/i.exec(riga);
                if (m) { aggiungiParte(m[1], 'CS'); continue; }
                m = /^\s*Giudice\s*:\s*(.+)$/i.exec(riga);
                if (m) { if (!dati.giudice) dati.giudice = pulisciVal(m[1]); continue; }
                m = /^\s*Sezione\s*:\s*(.+)$/i.exec(riga);
                if (m) { if (!dati.sezione) dati.sezione = pulisciVal(m[1]); continue; }
                m = /^\s*Tipo procedimento\s*:\s*(.+)$/i.exec(riga);
                if (m) { if (!dati.oggetto) dati.oggetto = pulisciVal(m[1]); continue; }
                m = /^\s*Data Evento\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(riga);
                if (m) { ev.data_evento = m[3] + '-' + m[2] + '-' + m[1]; continue; }
                m = /^\s*Tipo Evento\s*:\s*(.*)$/i.exec(riga);
                if (m) { ev.tipo = pulisciVal(m[1]); continue; }
                m = /^\s*Oggetto\s*:\s*(.+)$/i.exec(riga);
                if (m) { ev.oggetto = pulisciVal(m[1]); continue; }
                m = /^\s*Descrizione\s*:\s*(.+)$/i.exec(riga);
                if (m) { ev.descrizione = pulisciVal(m[1]); }
            }
            // La data di udienza sta nella descrizione, sia alla fissazione sia
            // ad ogni rinvio: "FISSATA PRIMA UDIENZA AL 28/10/2024 ore 13:40",
            // "UDIENZA RINVIATA AL 25/06/2025 ore 09:30".
            ev.udienza = udienzaDaTesto(ev.descrizione + ' ' + ev.oggetto);
            if (ev.data_evento || ev.descrizione) dati.eventi.push(ev);
        }
        // Ordine cronologico e niente doppioni (la stessa comunicazione arriva
        // sia come atto sia nei documenti del deposito).
        const chiaviEv = {};
        dati.eventi = dati.eventi.filter((e) => {
            const k = e.data_evento + '|' + e.oggetto + '|' + e.descrizione;
            if (chiaviEv[k]) return false;
            chiaviEv[k] = true;
            return true;
        }).sort((a, b) => String(a.data_evento).localeCompare(String(b.data_evento)));
        try { await storageSet(ck, { t: Date.now(), v: 1, dati: dati }); } catch (e) { /* ignore */ }
        return dati;
    }

    /**
     * Data di udienza dentro un testo di cancelleria, sia alla fissazione sia ad
     * ogni rinvio: "FISSATA PRIMA UDIENZA AL 28/10/2024 ore 13:40", "UDIENZA
     * RINVIATA AL 25/06/2025 ore 09:30". Torna "YYYY-MM-DD HH:MM" o ''.
     */
    function udienzaDaTesto(testo) {
        const mu = /UDIENZA[^0-9]{0,40}?(\d{2})\/(\d{2})\/(\d{4})(?:\s*ore\s*(\d{1,2})[:.](\d{2}))?/i
            .exec(String(testo || ''));
        if (!mu) return '';
        const hh = mu[4] ? ('0' + mu[4]).slice(-2) : '';
        return mu[3] + '-' + mu[2] + '-' + mu[1] + (hh ? ' ' + hh + ':' + (mu[5] || '00') : '');
    }

    /**
     * Ultima e prossima udienza dalle comunicazioni di cancelleria. L'ultima
     * fissazione/rinvio in ordine di evento e' quella che vale: le precedenti
     * sono state superate dal rinvio successivo.
     */
    function udienzeDaEventi(eventi) {
        const oggi = new Date();
        const iso = oggi.getFullYear() + '-' + ('0' + (oggi.getMonth() + 1)).slice(-2)
            + '-' + ('0' + oggi.getDate()).slice(-2);
        let ultima = '', prossima = '';
        for (const e of (eventi || [])) {
            if (!e.udienza) continue;
            const giorno = e.udienza.slice(0, 10);
            if (giorno >= iso) {
                if (!prossima || e.udienza < prossima) prossima = e.udienza;
            } else if (e.udienza > ultima) {
                ultima = e.udienza;
            }
        }
        return { ultima: ultima, prossima: prossima };
    }

    async function risolviPartiSegnaposto(F, token, compiti, atti, difensoriLocali = []) {
        const segnaposto = (parte) => {
            const p = String(parte || '');
            return /(^|[\s-])SENZA NOME\b/i.test(p) || /^ND\b/i.test(p) || /^[A-Z0-9]{11,16}$/.test(p);
        };
        // Raggruppa per deposito: chiave = et \u0000 dataFolder. Si prendono sia
        // gli atti di parte (per dare un nome alla parte) sia i depositi finiti
        // tra i provvedimenti d'ufficio: l'euristica sui nomi file puo' aver
        // sbagliato (un ricorso che allega un "PROVVEDIMENTO di ASSUNZIONE.pdf")
        // e solo il datiAtto dice la verita'. Chi e' davvero un provvedimento
        // resta dov'e'; chi e' un atto di parte torna al suo posto.
        const dep = new Map();
        for (let i = 0; i < compiti.length; i++) {
            const a = atti[i];
            if (!a) continue;
            const parti = String(compiti[i].rel).split('/');
            let et = '', dataFolder = '', file = '', ufficio = false;
            if (a.categoria === 'atti_di_parte') {
                if (parti.length < 4) continue;
                et = parti[1]; dataFolder = parti[2]; file = parti.slice(3).join('/');
            } else if (a.categoria === 'provvedimenti_di_ufficio') {
                if (parti.length < 3) continue;
                dataFolder = parti[1]; file = parti.slice(2).join('/'); ufficio = true;
            } else {
                continue;
            }
            const key = et + '\u0000' + dataFolder;
            let g = dep.get(key);
            if (!g) {
                g = { et: et, dataFolder: dataFolder, ufficio: ufficio, idxs: [], files: [],
                      datiAttoId: '', datiAttoNome: '', xmlIds: [], firmaIds: [],
                      comunicazioneId: '', comunicazioneNome: '' };
                dep.set(key, g);
            }
            g.idxs.push(i);
            g.files.push(file);
            // Il nome del file NON e' sempre "DatiAtto.xml": nei depositi della
            // controparte arriva come "DatiAtto-00017283-2024100766087727330.xml.p7m".
            // Col filtro esatto quei depositi non venivano nemmeno aperti, ed e' il
            // motivo per cui restavano "ND - SENZA NOME". Qui si prendono TUTTI gli
            // XML di dati atto del deposito, non solo il primo.
            if (/datiatto[^\/\\]*\.xml(\.p7m)?$/i.test(file)) {
                g.xmlIds.push({ id: compiti[i].id, nome: compiti[i].nome });
                if (!g.datiAttoId) { g.datiAttoId = compiti[i].id; g.datiAttoNome = compiti[i].nome; }
            } else if (/\.p7m$/i.test(file)) {
                // Buste firmate del deposito: se il dati atto non nomina nessuno,
                // la firma dice almeno quale difensore ha depositato.
                g.firmaIds.push({ id: compiti[i].id, nome: compiti[i].nome });
            }
            // La comunicazione di cancelleria nomina ricorrente e resistente:
            // serve a dare un nome alla parte citata col solo codice fiscale.
            if (!g.comunicazioneId && /comunicazione\.txt$/i.test(file)) {
                g.comunicazioneId = compiti[i].id;
                g.comunicazioneNome = compiti[i].nome;
            }
        }
        const daRisolvere = [];
        for (const g of dep.values()) {
            if (!g.xmlIds.length && !g.firmaIds.length) continue;
            const verificaRappresentata = F.area === 'SIECIC'
                && !g.ufficio && /^AP(?:\s|$)/i.test(g.et);
            if (g.ufficio || segnaposto(g.et) || verificaRappresentata) daRisolvere.push(g);
        }

        // Comunicazioni di cancelleria: parti nominate, eventi e date di udienza.
        // Lettura unica per fascicolo (in cache), usata sia per battezzare le
        // cartelle sia per la scheda del fascicolo nel pannello.
        const comunicazioni = await leggiComunicazioni(F, token, Array.from(dep.values()));

        // Parti del fascicolo col ruolo vero: serve sia a riconoscere il
        // depositante dalla firma, sia ad allineare il ruolo delle cartelle
        // (passo 3). Una sola richiesta, in cache per una settimana.
        const idx = indiceProfilo(await profiloParti(F, token));

        // Etichette gia' note dalla cache; leggo dal PdA solo i depositi mancanti.
        const cacheKey = 'pctPartiV17:' + pulisci(F.etichetta);
        const cache = (daRisolvere.length ? (await storageGet(cacheKey)) : null) || {};
        const etichette = {};   // depKey -> {tipo,nome,cf,label}
        const provv = {};       // depKey -> true (deposito da spostare in provvedimenti)
        const daLeggere = [];
        for (const g of daRisolvere) {
            const k = g.et + '\u0000' + g.dataFolder;
            // Da v:16 i depositi AP SIECIC vengono riletti usando il ruolo esplicito
            // dell'XML e il profilo aggiornato, non il ruolo dedotto dalla cartella.
            if (cache[k] && cache[k].label && cache[k].v >= 17) etichette[k] = cache[k];
            else if (cache[k] && cache[k].isProvv) provv[k] = true;
            else daLeggere.push(g);
        }

        // Scarica un singolo file del deposito (XML di dati atto o busta firmata)
        // e ne restituisce il contenuto grezzo. Serve sia a battezzare le cartelle
        // sia a leggere i difensori dichiarati negli atti.
        const postScarico = servizioScarico(F);
        const hPostScarico = Object.assign(intestazioni(F, token), { 'Content-Type': 'application/json', 'Accept': '*/*' });
        const scaricaBusta = async (rif, msTetto) => {
            const tBusta = Date.now();
            const corpo = JSON.stringify({
                area: F.area, nome: rif.nome || 'DatiAtto.xml', isArchivio: false,
                idRepeAtto: rif.id, idDoc: rif.id, original: true,
                distretto: F.distretto, idUfficio: F.ufficio,
            });
            // Tetto di tempo: senza questo, una richiesta che il Portale non
            // chiude mai lascia lo scarico fermo per sempre sulla barra.
            const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            const t = (ac && msTetto) ? setTimeout(() => { try { ac.abort(); } catch (e) { /* noop */ } }, msTetto) : null;
            try {
                const r = await fetch(postScarico, {
                    method: 'POST', headers: hPostScarico, body: corpo,
                    credentials: 'include', signal: ac ? ac.signal : undefined,
                });
                if (r.status !== 200) return null;
                return await r.arrayBuffer();
            } catch (e) {
                return null;
            } finally {
                if (t) clearTimeout(t);
                if (tempiExtra) { tempiExtra.buste += Date.now() - tBusta; tempiExtra.nbuste++; }
            }
        };

        // Depositi nuovi: scarica i datiAtto.xml (piccoli) in parallelo (8) e
        // ricava la parte direttamente dall'XML (client-side, come lo scarico
        // singolo). I depositi complementari senza anagrafica ereditano la parte
        // via RefId. Le etichette risolte finiscono in cache.
        if (daLeggere.length) {
            const parsed = [];   // { key, info:{isProvv,refId,name,cf} }
            const lettiDepositi = await inPool(daLeggere, 10, async (g) => {
                try {
                    const apSiecic = F.area === 'SIECIC' && !g.ufficio && /^AP(?:\s|$)/i.test(g.et);
                    // TUTTI gli XML del deposito, non solo il primo: un deposito
                    // puo' contenerne piu' di uno e spesso e' il secondo a
                    // nominare la parte. Si ferma appena trova un nome.
                    let info = null;
                    let firma = null;
                    for (const rif of g.xmlIds) {
                        const buf = await scaricaBusta(rif);
                        if (!buf) continue;
                        const letto = parseParteDaBusta(buf);
                        const collegamenti = difensoriDaBusta(buf);
                        if (letto && collegamenti.length) letto.difensori = collegamenti;
                        if (!firma) firma = firmatarioDaBusta(buf);
                        if (letto && letto.name) { info = letto; break; }
                        if (letto && !info) info = letto;          // almeno il codice fiscale
                    }
                    // Nessun XML utile: la firma delle altre buste del deposito
                    // (istanza, procura, comparsa) dice comunque quale difensore
                    // ha depositato, e da li' si risale alla parte.
                    if (!firma) {
                        for (const rif of g.firmaIds.slice(0, 3)) {
                            const buf = await scaricaBusta(rif);
                            if (!buf) continue;
                            firma = firmatarioDaBusta(buf);
                            if (firma && (firma.cf || firma.cn)) break;
                        }
                    }
                    // La busta .p7m dei procedimenti concorsuali a volte non si
                    // lascia leggere (econtent in blocchi DER): parseParteDaBusta e
                    // difensoriDaBusta tornano vuoti e il deposito verrebbe scartato,
                    // lasciando il nome grezzo del Portale (spesso il DEBITORE). Ma i
                    // datiAtto gia' scaricati sul disco danno comunque i difensori:
                    // per i depositi SIECIC AP teniamo uno stub, cosi' la regola
                    // deterministica (difensori locali -> parte istante) attribuisce
                    // la parte giusta a valle.
                    if (!info && !firma) {
                        if (apSiecic && difensoriLocali.length) {
                            return { key: g.et + '\u0000' + g.dataFolder, info: { isProvv: false, refId: '', name: '', cf: '', firma: null } };
                        }
                        return null;
                    }
                    info = info || { isProvv: false, refId: '', name: '', cf: '' };
                    info.firma = firma;
                    return { key: g.et + '\u0000' + g.dataFolder, info: info };
                } catch (e) { return null; }
            });
            for (const p of lettiDepositi) if (p) parsed.push(p);
            // Mappa RefId -> parte, per i depositi complementari privi di anagrafica.
            // Si porta dietro cognome/nome proprio: il deposito che eredita la
            // parte non ha anagrafica propria da scrivere in scheda.
            const anaDi = (nm, cf, cogn, nomeP) => ({ name: nm, cf: cf, cognome: cogn || nm || '', nomeProprio: nomeP || '' });
            const refMap = {};
            for (const p of parsed) {
                if (!p.info.isProvv && p.info.name && p.info.refId) {
                    refMap[p.info.refId] = anaDi(p.info.name, p.info.cf, p.info.cognome, p.info.nomeProprio);
                }
            }
            // Unico AP noto nel fascicolo (introduttivo): serve per i depositi di
            // parte senza anagrafica ne' RefId (es. IstanzaGenerica). Considera sia
            // le parti appena lette sia quelle gia' in cache.
            const apSeen = {}; let apCount = 0, apOnly = null;
            const consideraAp = (nm, cf, cogn, nomeP) => {
                if (!nm) return;
                const key = cf || nm;
                if (!apSeen[key]) { apSeen[key] = true; apCount++; apOnly = anaDi(nm, cf, cogn, nomeP); }
            };
            for (const k in etichette) {
                if (etichette[k].tipo === 'AP') {
                    consideraAp(etichette[k].nome, etichette[k].cf, etichette[k].cognome, etichette[k].nomeProprio);
                }
            }
            for (const p of parsed) {
                if (!p.info.isProvv && p.info.name) consideraAp(p.info.name, p.info.cf, p.info.cognome, p.info.nomeProprio);
            }
            // Mappa codice fiscale -> parte di tutte le parti note (lette adesso o
            // gia' in cache): serve agli atti che dichiarano il depositante col
            // solo codice fiscale, senza anagrafica ne' RefId (in <codiceFiscaleParte>
            // oppure come attributo di <Parte>).
            const cfMap = {};
            for (const k in etichette) {
                if (etichette[k] && etichette[k].cf && etichette[k].nome) {
                    cfMap[String(etichette[k].cf).toUpperCase()] =
                        anaDi(etichette[k].nome, etichette[k].cf, etichette[k].cognome, etichette[k].nomeProprio);
                }
            }
            for (const p of parsed) {
                if (!p.info.isProvv && p.info.name && p.info.cf) {
                    cfMap[String(p.info.cf).toUpperCase()] =
                        anaDi(p.info.name, p.info.cf, p.info.cognome, p.info.nomeProprio);
                }
            }
            // Stessa mappa per chiave dei caratteri gemelli: la procura del
            // debitore nel 2024/76 scrive "RSALDO73L53FZ04W" dove il registro ha
            // "RSALDO73L53F704W", e senza questa via la parte non si riconosceva.
            const cfMapK = {};
            for (const c in cfMap) {
                if (!cfMap[c]) continue;
                const k = cfChiave(c);
                if (!k) continue;
                if (cfMapK[k] === undefined) cfMapK[k] = cfMap[c];
                else if (cfMapK[k] && cfMapK[k].name !== cfMap[c].name) cfMapK[k] = null;
            }
            // Anagrafica della parte partendo dal solo codice fiscale, prima
            // esatto e poi per caratteri gemelli.
            const anaDaCf = (cf) => {
                const c = String(cf || '').toUpperCase().trim();
                if (!c) return null;
                if (cfMap[c]) return cfMap[c];
                const k = cfChiave(c);
                if (k && cfMapK[k]) return cfMapK[k];
                // Ultima fonte: l'elenco parti del registro. Il debitore nominato
                // col solo codice fiscale non compare negli altri datiAtto, ma il
                // Portale lo conosce.
                const p = trovaParte(idx, '', c);
                if (p && (p.cognome || p.nome)) {
                    return anaDi((p.cognome + ' ' + p.nome).replace(/\s+/g, ' ').trim(), p.cf || c, p.cognome, p.nome);
                }
                return null;
            };
            // Mappa difensore -> parte, ricavata dagli stessi datiAtto del
            // fascicolo: il nodo <Avvocato> porta il codice fiscale del difensore
            // e <parteRappresentata> dice quale parte difende. Serve ai depositi
            // che NON hanno affatto il nodo <Parte> (IstanzaGenerica,
            // ProduzioneDocumentiRichiesti): la loro busta e' firmata da quel
            // difensore, quindi la parte e' la sua. Funziona anche quando il
            // profilo del fascicolo non risponde.
            const avvMap = {};
            // Nomi che non sono parti ma etichette di comodo messe da noi nei giri
            // precedenti ("Avv. Bertuccelli", "SENZA NOME"). Vanno scartati: se
            // entrano nella mappa, il difensore risulta rappresentare se stesso e
            // il deposito resta per sempre in "ND - Avv. ...", confermando a ogni
            // sync l'errore del giro prima.
            const nomeDiComodo = (nm) => {
                const t = String(nm || '').trim();
                if (!t) return true;
                return /^avv\.?\s/i.test(t) || /^(nd|senza nome|nd - senza nome)$/i.test(t);
            };
            const consideraAvv = (avvCf, nm, cf, cogn, nomeP) => {
                const k = String(avvCf || '').toUpperCase();
                if (!k) return;
                // La parte difesa puo' essere dichiarata col solo codice fiscale:
                // l'AttoRichiestaVisibilita del 2024/76 ha <Parte ID="1"
                // codiceFiscale="..."/> senza denominazione. Il nome si prende
                // dalle parti gia' note, altrimenti quel difensore andava perso e
                // i suoi depositi finivano in "ND - Avv. Bertuccelli Veronica".
                if (nomeDiComodo(nm) && cf) {
                    const a2 = anaDaCf(cf);
                    if (a2 && !nomeDiComodo(a2.name)) {
                        nm = a2.name; cf = a2.cf || cf; cogn = a2.cognome; nomeP = a2.nomeProprio;
                    }
                }
                if (nomeDiComodo(nm)) return;
                if (avvMap[k] === undefined) avvMap[k] = anaDi(nm, cf, cogn, nomeP);
                else if (avvMap[k] && avvMap[k].name !== nm) avvMap[k] = null;   // ambiguo
            };
            for (const k in etichette) {
                consideraAvv(etichette[k].avvCf, etichette[k].nome, etichette[k].cf,
                    etichette[k].cognome, etichette[k].nomeProprio);
            }
            for (const p of parsed) {
                if (!p.info.isProvv) {
                    consideraAvv(p.info.avvCf, p.info.name, p.info.cf, p.info.cognome, p.info.nomeProprio);
                    for (const d of p.info.difensori || []) {
                        consideraAvv(d.cf, d.nomeParte, d.cfParte, d.nomeParte, '');
                    }
                }
            }
            // Sonda leggibile dalla console della pagina del Portale: dice quali
            // difensori sono stati riconosciuti e a quale parte puntano. Serve a
            // capire in fretta perche' un deposito finisce in "ND - Avv. ...".
            try {
                console.info('[PCT] difensori riconosciuti: ' + (Object.keys(avvMap).map(
                    (k) => k + ' -> ' + (avvMap[k] ? avvMap[k].name : '(piu\' parti: ambiguo)')
                ).join(' ; ') || '(nessuno)'));
                console.info('[PCT] parti dal registro (' + idx.n + '): ' + ((idx.lista || []).map(
                    (p) => (p.tipo || '?') + ' ' + (p.cf || '(senza cf)') + ' ' + ((p.cognome || '') + ' ' + (p.nome || '')).trim()
                ).join(' ; ') || '(nessuna)'));
                console.info('[PCT] avvocati letti negli atti: ' + (parsed.filter((p) => p.info && p.info.avvCf).map(
                    (p) => p.info.avvCf + ' difende [' + (p.info.name || 'SENZA NOME') + '] cf=[' + (p.info.cf || 'SENZA CF') + ']'
                ).join(' ; ') || '(nessuno)'));
            } catch (e) { /* noop */ }
            let cambiata = false;
            // Parti dichiarate dalla cancelleria (comunicazione.txt): chi resta
            // senza abbinamento e' la controparte che il datiAtto cita col solo
            // codice fiscale. Un solo residuo = attribuzione certa.
            const roster = comunicazioni.roster || [];
            const nomiOccupati = {};
            const occupa = (nm) => { const k = normaNome(nm || ''); if (k) nomiOccupati[k] = true; };
            for (const k in etichette) occupa(etichette[k].nome);
            for (const c in cfMap) if (cfMap[c]) occupa(cfMap[c].name);
            for (const p of parsed) if (!p.info.isProvv) occupa(p.info.name);
            const residuiRoster = roster.filter((r) => !nomiOccupati[normaNome(r.nome)]);
            const rosterUnico = (residuiRoster.length === 1) ? residuiRoster[0] : null;
            // Prima passata: risolvo con i dati del documento (anagrafica, RefId,
            // codice fiscale, unico AP). Gli irrisolti restano in coda.
            const irrisolti = [];
            const perData = {};   // data del deposito -> { nome, cf } (se unica)
            const soloData = (s) => (/(\d{4}-\d{2}-\d{2})/.exec(String(s || '')) || ['', ''])[1];
            const registraData = (chiave, nm, cf) => {
                const base = soloData(chiave.split('\u0000')[1]);
                if (!base || !nm) return;
                if (!perData[base]) perData[base] = { nome: nm, cf: cf, conflitto: false };
                else if (String(perData[base].cf || perData[base].nome) !== String(cf || nm)) perData[base].conflitto = true;
            };
            for (const k in etichette) registraData(k, etichette[k].nome, etichette[k].cf);
            const assegna = (p, nm, cf, tipo, ana) => {
                // Ruolo vero dal profilo del fascicolo (attore, convenuto, terzo):
                // il datiAtto non lo dice e prima si scriveva 'AP' per tutti.
                const pf = trovaParte(idx, nm, cf);
                const ruolo = tipo || (pf && pf.tipo) || 'AP';
                const label = etichettaParte(ruolo, nm, cf);
                // Se la parte e' stata ereditata (RefId, codice fiscale, firma), la
                // sua anagrafica arriva da quella voce: questa busta non ce l'ha.
                const info = { label: label, tipo: ruolo, nome: nm, cf: cf, v: 17,
                               parteDaAttoFirmato: !!p.info.parteDaAttoFirmato,
                               cognome: p.info.cognome || (ana && ana.cognome) || '',
                               nomeProprio: p.info.nomeProprio || (ana && ana.nomeProprio) || '',
                               avvNome: p.info.avvNome || '', avvCf: p.info.avvCf || '' };
                etichette[p.key] = info; cache[p.key] = info; cambiata = true;
                registraData(p.key, nm, cf);
            };
            // Gruppo di appartenenza di ogni busta letta: serve a sapere se il
            // deposito arriva dai provvedimenti d'ufficio (verifica) o dagli atti
            // di parte (nome da risolvere).
            const gruppoDi = {};
            for (const g of daRisolvere) gruppoDi[g.et + '\u0000' + g.dataFolder] = g;
            for (const p of parsed) {
                if (p.info.isProvv) {
                    provv[p.key] = true; cache[p.key] = { isProvv: true }; cambiata = true;
                    continue;
                }
                // Un deposito che sta tra i provvedimenti d'ufficio si sposta tra
                // gli atti di parte SOLO se il suo datiAtto nomina direttamente la
                // parte (come il <Ricorso> con il nodo <Parte>). Le deduzioni
                // (RefId, firma, unica parte di quella data) non bastano a togliere
                // un atto dall'ufficio: meglio lasciarlo dov'e' che spostarlo a torto.
                const gr = gruppoDi[p.key];
                if (gr && gr.ufficio && !p.info.name) continue;
                let nm = p.info.name, cf = p.info.cf, ana = null, tipoRoster = '';
                // SIECIC concorsuale: il depositante di un atto di parte e' la
                // PARTE ISTANTE (creditore), non il primo <Parte> (che e' il
                // resistente/debitore). Vale sia per i depositi gia' marcati "AP..."
                // sia per quelli ancora SEGNAPOSTO (ND / solo codice fiscale): proprio
                // su questi parseParteDaBusta restituirebbe il resistente, sbagliando.
                const verificaAvvocatoSIECIC = F.area === 'SIECIC'
                    && gr && !gr.ufficio && (/^AP(?:\s|$)/i.test(gr.et) || segnaposto(gr.et));
                if (verificaAvvocatoSIECIC) {
                    const firmaCf = String((p.info.firma && p.info.firma.cf) || '').toUpperCase();
                    // Difensori del deposito letti dalla busta scaricata; se la busta
                    // non si e' lasciata leggere o non porta il blocco avvocato->parte
                    // (succede con i p7m concorsuali: resta solo <Partecipanti/Parte>),
                    // si usano i difensori letti dai datiAtto LOCALI del fascicolo. Il
                    // nome gia' presente si rispetta SOLO se non e' un segnaposto: per
                    // un ND/CF il "nome" dedotto e' il resistente, quindi inaffidabile.
                    const nomeAffidabile = p.info.name && !segnaposto(gr.et);
                    const collegamenti = (p.info.difensori && p.info.difensori.length)
                        ? p.info.difensori
                        : (nomeAffidabile ? [] : (difensoriLocali || []));
                    const corrispondenze = firmaCf
                        ? collegamenti.filter((d) => String(d.cf || '').toUpperCase() === firmaCf)
                        : [];
                    // Regola deterministica (schema concorsuale): la parte depositante
                    // e' quella dichiarata dal collegamento avvocato->parte nell'XML
                    // (TipoParteIstante/Creditore -> creditore via parteRappresentata),
                    // NON chi ha firmato la busta. Il certificato di firma spesso porta
                    // un CF diverso (altro professionista, firma tecnica): se non combacia
                    // con nessun difensore NON si deve ricadere sul primo <Parte>, che e'
                    // il resistente/debitore. Quando la firma combacia la si usa (preciso);
                    // altrimenti si usano i collegamenti dichiarati nel documento.
                    const candidati = (firmaCf && corrispondenze.length) ? corrispondenze : collegamenti;
                    const unici = new Map();
                    for (const d of candidati) {
                        const parteXml = trovaParte(idx, d.nomeParte, d.cfParte);
                        const nomeXml = parteXml
                            ? (parteXml.cognome + ' ' + parteXml.nome).replace(/\s+/g, ' ').trim()
                            : toTitleCase(String(d.nomeParte || '').replace(/\s+/g, ' ').trim());
                        const cfXml = (parteXml && parteXml.cf) || d.cfParte || '';
                        const chiaveXml = cfXml ? cfChiave(cfXml) : normaNome(nomeXml);
                        if (chiaveXml) unici.set(chiaveXml, { nome: nomeXml, cf: cfXml, ana: parteXml, difensore: d });
                    }
                    if (unici.size === 1) {
                        const rappresentata = unici.values().next().value;
                        nm = rappresentata.nome;
                        cf = rappresentata.cf;
                        ana = rappresentata.ana
                            ? { name: nm, cf: cf, cognome: rappresentata.ana.cognome || nm,
                                nomeProprio: rappresentata.ana.nome || rappresentata.ana.nomeProprio || '' }
                            : { name: nm, cf: cf, cognome: nm, nomeProprio: '' };
                        tipoRoster = rappresentata.difensore.tipoParte || (parteXml && parteXml.tipo) || (trovaParte(idx, rappresentata.nome, rappresentata.cf) || {}).tipo || 'AP';
                        p.info.parteDaAttoFirmato = true;
                        p.info.cognome = ana.cognome;
                        p.info.nomeProprio = ana.nomeProprio;
                        p.info.avvNome = rappresentata.difensore.nome || '';
                        p.info.avvCf = rappresentata.difensore.cf || '';
                    } else if (firmaCf) {
                        const rappresentata = avvMap[firmaCf] || parteDalFirmatario(idx, p.info.firma);
                        if (rappresentata) {
                            nm = rappresentata.name;
                            cf = rappresentata.cf;
                            ana = rappresentata;
                            tipoRoster = (trovaParte(idx, rappresentata.name, rappresentata.cf) || {}).tipo || 'AP';
                            p.info.parteDaAttoFirmato = true;
                            p.info.cognome = rappresentata.cognome || rappresentata.name;
                            p.info.nomeProprio = rappresentata.nomeProprio || '';
                            p.info.avvNome = (p.info.firma && p.info.firma.nome) || '';
                            p.info.avvCf = firmaCf;
                        }
                    }
                }
                if (!nm && p.info.refId && refMap[p.info.refId]) {
                    ana = refMap[p.info.refId]; nm = ana.name; cf = ana.cf;
                }
                // Nel XML c'era solo il codice fiscale del depositante: come nodo
                // <codiceFiscaleParte> (DepositoNoteScritteSostUdie) oppure come
                // attributo di <Parte> (AttoRichiestaVisibilita). Abbino alla parte
                // gia' nota con lo stesso CF, invece di lasciarlo "ND - SENZA NOME".
                if (!nm && cf) {
                    const a2 = anaDaCf(cf);
                    if (a2) { ana = a2; nm = a2.name; if (a2.cf) cf = a2.cf; }
                }
                // Il datiAtto non nomina nessuna parte (tipico dei depositi di
                // documenti richiesti e delle istanze generiche): la busta e'
                // firmata dall'avvocato che ha depositato. Prima si guarda chi
                // difende negli altri datiAtto dello stesso fascicolo, poi il
                // profilo. Sono prove molto piu' solide delle euristiche sotto.
                if (!nm && p.info.firma && p.info.firma.cf && avvMap[p.info.firma.cf]) {
                    ana = avvMap[p.info.firma.cf]; nm = ana.name; cf = ana.cf;
                }
                // Stessa prova col difensore dichiarato nel datiAtto: qui il
                // codice fiscale dell'avvocato arriva dal documento e non dal
                // certificato, e basta per sapere quale parte difende.
                if (!nm && p.info.avvCf && avvMap[String(p.info.avvCf).toUpperCase()]) {
                    ana = avvMap[String(p.info.avvCf).toUpperCase()]; nm = ana.name; cf = ana.cf;
                }
                if (!nm) {
                    const pf = parteDalFirmatario(idx, p.info.firma);
                    if (pf) {
                        nm = (pf.cognome + ' ' + pf.nome).trim(); cf = pf.cf;
                        ana = { cognome: pf.cognome || nm, nomeProprio: pf.nome || '' };
                    }
                }
                // Nessun nome nel documento ne' nel profilo: la cancelleria pero'
                // dichiara ricorrente e resistente nel comunicazione.txt. Se una
                // sola di quelle parti non e' ancora abbinata, il depositante e'
                // quella, col ruolo vero (es. "CS - ALD AUTOMOTIVE SRL"). Va
                // prima del ripiego "unico AP", che altrimenti attribuirebbe
                // l'atto della controparte al ricorrente.
                const firmaNonAssociata = !!(p.info.firma && p.info.firma.cf && !nm);
                if (!nm && rosterUnico && !firmaNonAssociata) {
                    nm = rosterUnico.nome; tipoRoster = rosterUnico.tipo;
                    ana = { cognome: rosterUnico.nome, nomeProprio: '' };
                }
                // Ultimo ripiego prima di arrendersi: il difensore letto nel XML
                // (<Avvocato>) o riconosciuto dalla firma della busta. Meglio
                // "Avv. Massimei Gianluca" che "SENZA NOME": dice di chi e' il
                // deposito e resta verificabile dal codice fiscale della parte.
                if (!nm && p.info.avvNome) {
                    nm = 'Avv. ' + p.info.avvNome;
                    ana = { cognome: nm, nomeProprio: '' };
                }
                if (!nm && apCount === 1 && apOnly && !firmaNonAssociata) { ana = apOnly; nm = apOnly.name; cf = apOnly.cf; }
                // Ultima risorsa: nessuna fonte del fascicolo nomina la parte. E'
                // il caso tipico del Giudice di Pace, dove il datiAtto porta solo
                // <codiceFiscaleParte> e quel codice non e' tra le parti del
                // profilo (es. un terzo chiamato): ne' il profilo, ne' le
                // comunicazioni di cancelleria, ne' gli altri datiAtto lo
                // conoscono. Il certificato della busta dice invece chi ha
                // depositato: "Avv. MIONE FRANCESCO" col codice fiscale della
                // parte accanto e' un dato vero e verificabile, molto meglio di un
                // indistinto "SENZA NOME" che accorpa depositi di soggetti
                // diversi. Il ruolo resta 'ND' perche' nessuna fonte lo dichiara:
                // non si inventa un 'AP'.
                if (!nm && p.info.firma && p.info.firma.nome) {
                    nm = 'Avv. ' + p.info.firma.nome;
                    ana = { cognome: nm, nomeProprio: '' };
                    if (!tipoRoster) tipoRoster = 'ND';
                }
                if (!nm) { irrisolti.push(p); continue; }
                assegna(p, nm, cf, tipoRoster, ana);
            }
            // Seconda passata: i depositi complementari (ricevute, allegati) hanno
            // la stessa data del deposito principale, con un progressivo diverso.
            // Se per quella data esiste UNA sola parte risolta, sono suoi: meglio
            // abbinarli che lasciarli sotto "ND - SENZA NOME".
            for (const p of irrisolti) {
                const base = soloData(p.key.split('\u0000')[1]);
                const d = base ? perData[base] : null;
                if (d && d.nome && !d.conflitto) {
                    assegna(p, d.nome, d.cf, '', cfMap[String(d.cf || '').toUpperCase()] || null);
                }
            }
            if (cambiata) { try { await storageSet(cacheKey, cache); } catch (e) { /* ignore */ } }
        }

        // Sposta un deposito sotto un'altra cartella conservando i livelli
        // interni (Atto/ oppure Documenti/) e il nome del file. La coda e' tutto
        // quello che sta DOPO la cartella del deposito: "atti_di_parte/<parte>/
        // <data - n>/..." ha tre livelli davanti, "provvedimenti_di_ufficio/
        // <data - n>/..." soltanto due.
        const sposta = (i, nuovaCartella) => {
            const seg = String(compiti[i].rel).split('/');
            const salto = (seg[0] === 'atti_di_parte') ? 3 : 2;
            const coda = seg.slice(salto).join('/');
            if (coda === '') return;
            compiti[i].rel = nuovaCartella + '/' + coda;
            atti[i].subfolder = compiti[i].rel.split('/').slice(0, -1).join('/');
        };

        if (Object.keys(etichette).length || Object.keys(provv).length) {
            // 1) Depositi che dal datiAtto risultano PROVVEDIMENTI (es. decreto di
            // fissazione udienza) ma che il tree del PdA ha messo tra gli atti di
            // parte: li sposta in provvedimenti_di_ufficio (come lo scarico singolo).
            // Il nome della cartella ("AAAA-MM-GG - n") e' unico nel fascicolo,
            // quindi resta lo stesso: non serve nessun suffisso anti-collisione.
            for (const g of daRisolvere) {
                const k = g.et + '\u0000' + g.dataFolder;
                if (!provv[k]) continue;
                const nuovaCartella = 'provvedimenti_di_ufficio/' + g.dataFolder;
                for (const i of g.idxs) {
                    sposta(i, nuovaCartella);
                    atti[i].categoria = 'provvedimenti_di_ufficio';
                    atti[i].parte = '';
                    atti[i].tipo_parte = '';
                    atti[i].nome_parte = '';
                    atti[i].cf_parte = '';
                }
            }

            // 2) Applica le etichette parte (cache + nuove): riscrive solo il nome
            // della parte, la cartella del deposito resta quella (progressivo unico).
            // Se il deposito era stato messo tra i provvedimenti d'ufficio per
            // sbaglio, qui torna tra gli atti di parte: il datiAtto ha detto che
            // non e' un provvedimento ed ha dato la parte.
            for (const g of daRisolvere) {
                const info = etichette[g.et + '\u0000' + g.dataFolder];
                if (!info || !info.label) continue;
                const newEt = pulisci(info.label);
                if (!newEt || newEt === g.et) continue;
                const nuovaCartella = 'atti_di_parte/' + newEt + '/' + g.dataFolder;
                for (const i of g.idxs) {
                    sposta(i, nuovaCartella);
                    atti[i].categoria = 'atti_di_parte';
                    atti[i].parte = newEt;
                    atti[i].tipo_parte = info.tipo || atti[i].tipo_parte || 'AP';
                    atti[i].nome_parte = info.nome || '';
                    atti[i].cf_parte = info.cf || '';
                    atti[i].attribuzione_xml_firma = !!info.parteDaAttoFirmato;
                    // Cognome e nome separati: in scheda sono due colonne distinte.
                    atti[i].parte_cognome = info.cognome || '';
                    atti[i].parte_nome = info.nomeProprio || '';
                    // Difensore letto dal datiAtto (<Avvocato> + parteRappresentata):
                    // viaggia con l'atto cosi' il backend lo salva sulla parte.
                    atti[i].avv_nome = info.avvNome || '';
                    atti[i].avv_cf = info.avvCf || '';
                }
            }
        }

        // 2bis) Difensori delle parti letti DAGLI XML delle buste.
        //
        // Nelle esecuzioni il Portale non dice chi difende chi: il dato sta solo
        // nell'atto introduttivo e negli atti di intervento, dove <Avvocato>
        // porta <parteRappresentata ref="ID"> e quell'ID e' la parte. Finche'
        // questa lettura mancava, la colonna Avvocato veniva riempita col
        // titolare del fascicolo — un dato falso quando le parti sono piu' di una
        // (BARESCHINO e' difeso da BARUFFI, non dall'avvocato collegato).
        //
        // Si leggono le buste degli atti di parte in ordine cronologico e si
        // smette appena ogni parte nota ha il suo difensore, con un tetto per non
        // rallentare lo scarico. Il risultato sta in cache per fascicolo.
        const difensori = [];
        const beni = [];
        const partiXml = [];
        try {
            // La chiave invalida le letture precedenti: il parser include ora
            // anche gli altri partecipanti SIECIC e i loro codici fiscali.
            const ckDif = 'pctDifensori6:' + pulisci(F.etichetta);
            const cDif = await storageGet(ckDif);
            const fresca = cDif && Array.isArray(cDif.lista) && (Date.now() - (cDif.t || 0)) < 7 * 86400000;
            if (fresca) {
                for (const d of cDif.lista) difensori.push(d);
                if (Array.isArray(cDif.beni)) for (const b of cDif.beni) beni.push(b);
                if (Array.isArray(cDif.parti)) for (const pp of cDif.parti) partiXml.push(pp);
            } else {
                const gruppiParte = Array.from(dep.values())
                    .filter((g) => !g.ufficio && g.xmlIds && g.xmlIds.length)
                    .sort((a, b) => String(a.dataFolder).localeCompare(String(b.dataFolder)));
                // Le buste si leggono a blocchi di otto: sono XML di pochi
                // kilobyte, ma il difensore puo' stare in qualunque deposito —
                // nel 2024/76 la procura del debitore e' l'undicesimo e
                // l'intervento dell'Agenzia delle Entrate il quarantaduesimo.
                // Si scorrono quindi tutti, fermandosi appena ogni parte nota ha
                // il suo difensore. Ogni richiesta ha il suo tetto di tempo e il
                // passo intero ne ha un altro: i difensori sono un dato in piu' e
                // non devono mai poter fermare lo scarico dei documenti.
                const visti = {};
                const vistiParti = {};
                const scadenzaPasso = Date.now() + 25000;
                const cfNoti = (idx.lista || []).map((p) => String((p && p.cf) || '').toUpperCase()).filter(Boolean);
                for (let i = 0; i < gruppiParte.length; i += 8) {
                    if (Date.now() > scadenzaPasso) break;
                    const blocco = gruppiParte.slice(i, i + 8);
                    const buste = await Promise.all(blocco.map(async (g) => {
                        try { return await scaricaBusta(g.xmlIds[0], 8000); } catch (e) { return null; }
                    }));
                    for (const buf of buste) {
                        if (!buf) continue;
                        // Beni con i dati catastali: li porta il solo atto di
                        // pignoramento, quindi basta il primo che li dichiara.
                        if (!beni.length) {
                            try { for (const b of beniDaBusta(buf)) beni.push(b); } catch (e) { /* ignore */ }
                        }
                        // Partecipanti col CF che fa fede: correggono i codici
                        // fiscali sbagliati che il Portale riporta in elencoPartiEC.
                        for (const pp of partecipantiDaBusta(buf)) {
                            const k = pp.cf ? cfChiave(pp.cf) : ('N:' + normaNome(pp.nome || ''));
                            if (!k || k === 'N:' || vistiParti[k]) continue;
                            vistiParti[k] = true;
                            partiXml.push(pp);
                        }
                        for (const d of difensoriDaBusta(buf)) {
                            // Indice per la chiave tollerante, cosi' due atti che
                            // scrivono lo stesso codice fiscale in modi diversi
                            // non contano come due parti.
                            const k = d.cfParte ? cfChiave(d.cfParte)
                                                : ('N:' + String(d.nomeParte || '').toUpperCase());
                            if (k === 'N:' || !k || visti[k]) continue;
                            visti[k] = true;
                            difensori.push(d);
                        }
                    }
                    // Tutte le parti dichiarate dal Portale hanno il difensore e
                    // le buste lette hanno dichiarato i partecipanti: gli altri
                    // depositi non aggiungono nulla.
                    if (cfNoti.length && partiXml.length && cfNoti.every((c) => vistiParti[cfChiave(c)])) break;
                }
                // In cache solo se si e' trovato qualcosa: una lettura a vuoto
                // non deve impedire di riprovare al prossimo sync.
                if (difensori.length || beni.length || partiXml.length) {
                    try { await storageSet(ckDif, { t: Date.now(), lista: difensori, beni: beni, parti: partiXml }); } catch (e) { /* ignore */ }
                }
            }
        } catch (e) { /* i difensori sono un dato in piu': non bloccano lo scarico */ }
        comunicazioni.difensori = difensori;
        // Tutti i partecipanti letti dalle buste, col CF che fa fede: il
        // backend li usa per correggere i codici fiscali sbagliati che il
        // Portale riporta in elencoPartiEC (INTESA con il CF di POSTE).
        if (partiXml.length) comunicazioni.parti_xml = partiXml;
        // I dati catastali dei beni viaggiano con i difensori: il server li mette
        // nella lente della scheda Beni, che il servizio del Portale non riempie.
        if (beni.length) comunicazioni.beni = beni;

        // 3) Ruolo della parte allineato al profilo del fascicolo. Il tree degli
        // atti e il datiAtto marcano quasi tutti come "AP", mentre il portale
        // distingue attore, convenuto e terzo: la cartella prende il ruolo che
        // mostra la testata del fascicolo, cosi' il pacchetto sul PC e quello del
        // portale dicono la stessa cosa.
        if (idx.n) {
            // Mappa difensore -> parte, costruita sui <Avvocato> dichiarati negli
            // atti. Serve ai depositi battezzati col nome di chi ha firmato
            // ("ND - Avv. BERTUCCELLI VERONICA"): se gli atti dicono che quel
            // difensore rappresenta una parte sola, il deposito e' di quella
            // parte e va sotto la sua cartella. Se ne rappresenta piu' di una la
            // voce diventa nulla e il deposito resta dov'e': non si indovina.
            const partePerAvv = {};
            for (const d of difensori) {
                const pd = trovaParte(idx, d.nomeParte, d.cfParte);
                if (!pd || !pd.tipo) continue;
                const chiavi = [];
                if (d.cf) chiavi.push('C:' + cfChiave(d.cf));
                if (d.nome) { chiavi.push('N:' + normaNome(d.nome)); chiavi.push('N:' + chiaveOrdineLibero(d.nome)); }
                for (const k of chiavi) {
                    if (!k || k === 'N:') continue;
                    if (partePerAvv[k] === undefined) partePerAvv[k] = pd;
                    else if (partePerAvv[k] !== pd) partePerAvv[k] = null;
                }
            }
            for (let i = 0; i < compiti.length; i++) {
                const a = atti[i];
                if (!a || a.categoria !== 'atti_di_parte') continue;
                const seg = String(compiti[i].rel).split('/');
                if (seg.length < 4) continue;
                let p = trovaParte(idx, a.nome_parte, a.cf_parte);
                let viaAvvocato = false;
                let soloRuolo = false;
                if (!p || !p.tipo) {
                    const m = /^avv\.?\s+(.+)$/i.exec(String(a.nome_parte || '').trim());
                    const nomeAvv = a.avv_nome || (m ? m[1] : '');
                    let cand = null;
                    if (a.avv_cf) cand = partePerAvv['C:' + cfChiave(a.avv_cf)];
                    if (!cand && nomeAvv) {
                        cand = partePerAvv['N:' + normaNome(nomeAvv)];
                        if (cand === undefined) cand = partePerAvv['N:' + chiaveOrdineLibero(nomeAvv)];
                    }
                    p = cand || null;
                    viaAvvocato = !!p;
                }
                // Terzo tentativo: il difensore secondo il REGISTRO, non secondo
                // gli atti. Prende i depositi intestati a un soggetto che il
                // registro non elenca (la societa' estera al posto della sua
                // rappresentante italiana): il nome e il codice fiscale restano
                // quelli dell'atto, che e' il deposito vero, e si corregge solo
                // il ruolo, che e' l'unica cosa che il registro sa meglio.
                if ((!p || !p.tipo) && (a.avv_cf || a.avv_nome)) {
                    const pr = parteDalDifensoreRegistro(idx, a.avv_cf, a.avv_nome);
                    if (pr && pr.tipo) { p = pr; soloRuolo = true; }
                }
                if (!p || !p.tipo) continue;
                // Nome della cartella: quello del registro quando l'atto non dava
                // un nome di parte ma un segnaposto (il cognome del firmatario,
                // "Avv. Bertuccelli", o nessun nome). Il registro e' la fonte
                // ufficiale: la cartella deve dire "Raise Loide", non il nome
                // dell'avvocato che ha depositato.
                const nomeRegistro = toTitleCase((p.cognome + ' ' + p.nome).replace(/\s+/g, ' ').trim());
                const segnaposto = viaAvvocato || !a.nome_parte || /^avv\.?\s/i.test(String(a.nome_parte).trim());
                const nome = soloRuolo
                    ? (a.nome_parte || nomeRegistro)
                    : ((segnaposto && nomeRegistro) ? nomeRegistro : (a.nome_parte || nomeRegistro));
                // Codice fiscale: se l'atto lo scrive con un carattere somigliante
                // (RSALDO73L53FZ04W per RSALDO73L53F704W) vale quello del registro.
                // Quando la parte e' stata riconosciuta dal difensore, il codice
                // scritto nell'atto non riguarda questa parte: vale il registro.
                let cf = soloRuolo
                    ? (a.cf_parte || p.cf)
                    : ((viaAvvocato && p.cf) ? p.cf : (a.cf_parte || p.cf));
                if (p.cf && cf !== p.cf && cfChiave(cf) === cfChiave(p.cf)) cf = p.cf;
                const tipoCartella = p.tipo || 'AP';
                const newEt = etichettaParte(tipoCartella, nome, cf);
                if (!newEt || newEt === seg[1]) continue;
                sposta(i, 'atti_di_parte/' + newEt + '/' + seg[2]);
                a.parte = newEt;
                a.tipo_parte = tipoCartella;
                // Nome e codice fiscale del registro anche nei dati inviati al
                // monitor: se restasse il segnaposto, la cartella direbbe "Raise
                // Loide" e la tabella atti "Avv. Bertuccelli".
                a.nome_parte = nome;
                a.cf_parte = cf;
            }
        }

        // Le comunicazioni tornano al chiamante: giudice, sezione, eventi e date
        // di udienza finiscono nella scheda del fascicolo.
        return comunicazioni;
    }

    // Verifica RAPIDA e LOCALE (nessuna chiamata al PdA) se la cartella del
    // fascicolo esiste ancora sul PC con almeno un file. Serve al gate della
    // sync incrementale: un fascicolo "gia' visto" nello storico ma la cui
    // cartella l'avvocato ha cancellato dev'essere ri-scaricato.
    async function presenzaLocale(url) {
        const F = parseUrl(url);
        if (!F) return { ok: false, files: 0 };
        try {
            const cartellaFsc = pulisci(F.etichetta);
            const elL = await bgMessage({ action: 'astarElenco', cartella: cartellaFsc });
            const n = (elL && elL.ok && Array.isArray(elL.files)) ? elL.files.length : 0;
            return { ok: !!(elL && elL.ok), files: n };
        } catch (e) {
            return { ok: false, files: 0 };
        }
    }

    window.PctDownload = { scaricaFascicoloPC: scaricaFascicoloPC, parseUrl: parseUrl, presenzaLocale: presenzaLocale };
})();
