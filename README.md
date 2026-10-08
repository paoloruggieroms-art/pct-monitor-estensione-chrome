# PCT Monitor - Estensione per Chrome

Estensione per browser (Chrome/Edge, Manifest V3) sviluppata da **Astar S.r.l.s.** per il servizio PCT Monitor ([sincpdatoscana.it](https://www.sincpdatoscana.it)).

## Cosa fa

L'estensione **legge** i dati dei fascicoli dal Punto di Accesso (PdA) del Processo Civile Telematico quando l'avvocato è gi&agrave; autenticato con la propria CNS nel browser, e li invia al pannello PCT Monitor per la sincronizzazione automatica dei fascicoli.

## Cosa NON fa

- **Non richiede, non intercetta e non salva** PIN, password, credenziali SPID/CIE o la CNS stessa.
- **Non effettua l'autenticazione** al posto dell'utente: funziona solo se l'avvocato ha gi&agrave; una sessione attiva sul Portale, aperta con la propria CNS.
- **Non deposita atti** né invia comunicazioni alla cancelleria: l'operativit&agrave; è di sola lettura/consultazione fascicoli.
- Non comunica con server diversi da quelli indicati nei permessi del `manifest.json`.

## Permessi richiesti

I permessi dichiarati in `manifest.json` sono limitati ai domini del Portale PdA e del pannello PCT Monitor, necessari per leggere la pagina dei fascicoli e inviare i dati al proprio account.

## Trasparenza

Questo repository viene pubblicato per consentire la verifica indipendente del funzionamento del software, in risposta a dubbi sulla sicurezza del servizio.

## Licenza

Vedi [LICENSE](LICENSE).
