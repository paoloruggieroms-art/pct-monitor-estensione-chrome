# PCT Monitor - PdA Toscana (estensione per Chrome)

Estensione per browser (Chrome/Edge, Manifest V3) sviluppata da **Astar S.r.l.s.** per il servizio PCT Monitor ([sincpdatoscana.it](https://www.sincpdatoscana.it)), dedicato al Processo Civile Telematico sul **Portale di Accesso della Regione Toscana** (`giustizia.toscana.it/pda-rt`).

## Cosa fa

L'estensione **legge** i dati dei fascicoli dal Portale di Accesso (PdA) quando l'avvocato è già autenticato con la propria CNS/SPID/CIE nel browser, e li invia al pannello PCT Monitor per la sincronizzazione automatica di fascicoli, atti, parti e udienze.

## Cosa NON fa

- **Non richiede, non intercetta e non salva** PIN, password, credenziali SPID/CIE o la CNS stessa.
- **Non effettua l'autenticazione** al posto dell'utente: funziona solo se l'avvocato ha già una sessione attiva sul Portale, aperta con le proprie credenziali.
- **Non deposita atti** né invia comunicazioni alla cancelleria: l'operatività è di sola lettura/consultazione fascicoli.
- Non comunica con server diversi da quelli indicati nei permessi del `manifest.json` (il Portale della Regione Toscana, il servizio ministeriale collegato e il pannello PCT Monitor).

## Permessi richiesti

I permessi dichiarati in `manifest.json` sono limitati ai domini del Portale PdA della Regione Toscana e del pannello PCT Monitor, necessari per leggere la pagina dei fascicoli e inviare i dati al proprio account.

## Trasparenza

Questo repository viene pubblicato per consentire la verifica indipendente del funzionamento del software, in risposta a dubbi sulla sicurezza del servizio.

## Licenza

Vedi [LICENSE](LICENSE).
