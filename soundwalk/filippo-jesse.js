/* =====================================================================
   SOUNDWALK — STANZA 131 · IL PIANOFORTE
   Endless runner musicale. Il terreno è un pentagramma; gli ostacoli
   Gioco musicale "direttore d'orchestra". C'è una fila di note sul
   pentagramma; quella davanti al direttore va suonata sul pianoforte vero.
   Nota giusta -> colpo di bacchetta e la fila avanza. Nota sbagliata ->
   il direttore inciampa e perde una vita. Nessuna pressione temporale.

   Tutto vanilla JS. Nessuna dipendenza.

   ===== INTEGRAZIONE NEL SITO SoundWalk =====
   Il router (function.js) quando si entra nella stanza 131 fa:
     1. creaPianoforte()        -> inietta l'HTML della stanza via innerHTML
     2. avviaPianoforteInit()   -> (dopo 100ms) avvia la mia logica
   Quindi:
     - creaPianoforte() qui dentro genera canvas + overlay del gioco.
     - avviaPianoforteInit() è IDEMPOTENTE: il router la chiama ogni volta
       che si entra nella stanza, anche al ritorno dal menu, quindi non
       deve duplicare listener né AudioContext.
     - All'uscita dalla stanza il game loop viene fermato (stopPianoforte),
       così non gira nascosto in background.

   ORGANIZZAZIONE DEL FILE:
     (0) Costanti & configurazione
     (1) Setup audio + pitch detection (autocorrelazione)
     (2) Setup sensori / orientamento (gate di avvio)
     (3) Game loop + rendering canvas
     (4) Logica di gioco / punteggio
     (5) Gestione sezioni A / B
     (6) Bootstrap: creaPianoforte() + avviaPianoforteInit()
   ===================================================================== */

(function () {
  "use strict";

  /* =====================================================================
     (0) COSTANTI & CONFIGURAZIONE
     ===================================================================== */

  const DEBUG = true;          // pannello di debug in un angolo
  const MATCH_OCTAVE = true;   // true = serve l'ottava ESATTA mostrata sul rigo:
                               // l'altezza disegnata corrisponde alla nota reale
                               // da suonare (coerenza visiva pitch <-> pentagramma)

  // --- Soglie audio (impostate AUTOMATICAMENTE dall'autocalibrazione) ---
  // Sono `let` perché la calibrazione guidata le ricalcola misurando il rumore
  // di fondo e la qualità delle note che l'utente suona. I valori qui sotto sono
  // solo i DEFAULT iniziali, validi finché la calibrazione non li sovrascrive.
  let RMS_THRESHOLD = 0.010;   // soglia di volume: sotto = silenzio/rumore
  let CLARITY_MIN = 0.75;      // qualità minima del picco di autocorrelazione
  const FMIN = 70;             // Hz minima cercata
  const FMAX = 1400;           // Hz massima cercata
  // Una nota è "azzeccata" se il MIDI arrotondato coincide col target (~±50 cent).

  // --- Geometria musicale ---
  // Solo chiave di violino. Range: C4 (DO centrale) .. B5.
  // La linea inferiore del pentagramma in chiave di violino è il MI4 (E4).
  const TREBLE_BOTTOM_LINE_MIDI = 64; // E4

  const NOTE_NAMES_IT = ["DO", "DO#", "RE", "RE#", "MI", "FA",
                         "FA#", "SOL", "SOL#", "LA", "LA#", "SI"];
  // pitch class -> { step diatonico (0=C..6=B), accidental (0/1) }
  const PC_TO_DIATONIC = {
    0:  { step: 0, acc: 0 }, 1:  { step: 0, acc: 1 },
    2:  { step: 1, acc: 0 }, 3:  { step: 1, acc: 1 },
    4:  { step: 2, acc: 0 }, 5:  { step: 3, acc: 0 },
    6:  { step: 3, acc: 1 }, 7:  { step: 4, acc: 0 },
    8:  { step: 4, acc: 1 }, 9:  { step: 5, acc: 0 },
    10: { step: 5, acc: 1 }, 11: { step: 6, acc: 0 },
  };

  // --- Difficoltà (struttura predisposta) ---
  const DIFFICULTIES = {
    facile:    { label: "Facile",    scrollSpeed: 70,  showName: true,  whiteOnly: true,  spawnGapPx: 320, chordsAfterScore: 8 },
    medio:     { label: "Medio",     scrollSpeed: 95,  showName: true,  whiteOnly: false, spawnGapPx: 300, chordsAfterScore: 8 },
    difficile: { label: "Difficile", scrollSpeed: 120, showName: false, whiteOnly: false, spawnGapPx: 280, chordsAfterScore: 8 },
  };
  let CURRENT_DIFFICULTY = "facile";

  // --- PALETTE "Notturno del copista" ---
  // Manoscritto musicale visto di notte: carta blu-notte invecchiata,
  // inchiostro avorio, righi sbiaditi, note come gocce d'inchiostro ciano.
  const PAL = {
    bg:     "#0d1b2a",  // blu notte profondo (fondo carta)
    bg2:    "#13243a",  // carta più chiara (pannelli)
    ink:    "#e8dcc0",  // inchiostro avorio invecchiato (testo)
    inkDim: "#9a8f76",  // inchiostro sbiadito
    staff:  "#5a7a99",  // righi blu polvere
    note:   "#7fd4e8",  // ciano luminoso (la nota / inchiostro fresco)
    accent: "#b794d4",  // viola ametista (bacchetta, accenti)
    gold:   "#d4a843",  // oro spento (chiave, ornamenti)
    err:    "#c1666b",  // rosso mattone smorzato (errore)
    frac:   "#1a2c44",  // frac scuro del direttore
  };

  // Note (MIDI) per la sezione A.
  const WHITE_MIDIS = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83];
  const CHROMATIC_MIDIS = [];
  for (let m = 60; m <= 83; m++) CHROMATIC_MIDIS.push(m);

  // Accordi per la sezione B (arpeggiati).
  const CHORD_SHAPES = [
    { name: "maggiore", intervals: [0, 4, 7] },
    { name: "minore",   intervals: [0, 3, 7] },
  ];
  const CHORD_ROOTS = [60, 62, 64, 65, 67, 69]; // C4 D4 E4 F4 G4 A4

  /* =====================================================================
     STATO GLOBALE DEL MODULO
     ===================================================================== */

  let canvas, ctx;
  let DPR = 1, W = 0, H = 0;

  let elStart, elStartBtn;
  let elSelectScreen, elChangeModeBtn, elFinalLabel;
  let elGameOver, elRestartBtn, elFinalScore, elDebug;

  // barra di controllo in-game + overlay di pausa
  let elGameBar, elPauseBtn, elExitBtn;
  let elPauseScreen, elResumeBtn, elPauseModeBtn;

  // schermata di calibrazione microfono (autocalibrazione guidata)
  let elCalibScreen, elCalibVu, elCalibNote, elCalibStep, elCalibProgress;
  let elCalibContinue, elCalibRetry;
  let calibRafId = null; // loop dedicato alla calibrazione (separato dal gioco)

  let initialized = false; // per rendere avviaPianoforteInit idempotente

  // audio
  let audioCtx = null, analyser = null, micStream = null;
  let timeBuf = null, lastDetected = null, lastRms = 0;

  // --- Rilevamento ATTACCO (onset) per evitare i falsi trigger del decay ---
  // Il pianoforte ha una coda lunga: dopo che suoni una nota, il suono resta
  // sopra soglia per 1-2s mentre decade. Senza onset detection, quel decay
  // verrebbe letto come una "nuova" nota e darebbe falsi errori.
  //
  // MODELLO arm/fire (robusto sul pianoforte, il cui attacco è rapidissimo):
  //   - "armed" = pronto ad accettare una nota nuova.
  //   - si SPARA un onset quando, essendo armati, l'RMS supera la soglia di
  //     volume con pitch confermato stabile.
  //   - ci si RIARMA solo dopo che l'RMS è sceso sotto una frazione del picco
  //     recente (il tasto è stato "rilasciato"/sta decadendo) oppure dopo
  //     silenzio. Così il plateau e la coda della stessa nota NON rispar­ano.
  let armed = true;           // pronto ad accettare un nuovo attacco
  let refractoryUntil = 0;    // timestamp fino a cui ignoro nuovi attacchi
  let stableMidi = -1;        // ultima nota letta (per la conferma di stabilità)
  let stableCount = 0;        // per quanti frame consecutivi è stabile
  let recentPeak = 0;         // picco di RMS recente (per la soglia di riarmo)
  // "Sensibilità tocco": quanto deve calare l'RMS (rispetto al picco) perché
  // il sistema si consideri pronto a una nuova nota. Valore basso = si riarma
  // facilmente (più sensibile, rischio doppi conteggi); alto = più severo.
  let ONSET_REARM = 0.45;     // riarmo quando rms < recentPeak * (1 - ONSET_REARM)... vedi pollAudio
  const REFRACTORY_MS = 120;  // tempo morto minimo dopo un attacco accettato
  const STABLE_FRAMES = 2;    // frame di conferma del pitch prima di accettare

  // Anti-feedback: il telefono ascolta col proprio microfono mentre gli effetti
  // sonori (e le note del dettato) escono dall'altoparlante dello stesso device.
  // Senza echo cancellation, quei suoni verrebbero riletti come "note suonate"
  // dal giocatore. Durante questa finestra NON facciamo scattare onset.
  let detectMuteUntil = 0;
  // Timestamp dell'ultimo onset accettato: serve a forzare il riarmo se il
  // giocatore suona legato (volume sempre alto) e non si scende mai sotto la
  // soglia di riarmo: senza questo, l'input smetterebbe di registrare.
  let onsetAt = 0;
  const MAX_HOLD_MS = 700;    // dopo questo tempo dall'onset, riarma comunque

  // Segna che l'altoparlante starà suonando fino a `untilMs` (ms, performance.now):
  // entro quella finestra il rilevamento ignora gli attacchi (sono il nostro audio).
  function muteDetectionUntil(untilMs) {
    if (untilMs > detectMuteUntil) detectMuteUntil = untilMs;
  }

  // game loop
  let rafId = null, lastTs = 0, running = false;
  let paused = false;     // pausa durante "playing": il loop continua a girare
                          // ma update() è congelato (così non perdo lo stato)
  let gameState = "idle"; // idle | select | permissions | calibrating | playing | endseq | gameover

  // --- MODALITÀ DI GIOCO ---
  // "direttore"  : nota ferma, la suoni per farla avanzare (no tempo)
  // "scorrimento": endless runner, le note arrivano da destra (pressione tempo)
  // "dettato"    : il gioco suona 4 note, tu le ripeti nell'ordine
  // "memoria"    : come dettato ma la sequenza si allunga ogni volta (fino a 8)
  let MODE = "direttore";

  // mondo di gioco
  let cfg = DIFFICULTIES[CURRENT_DIFFICULTY];
  let staffY = 0, lineGap = 0, runnerX = 0;
  let section = "A";
  let score = 0, lives = 3;
  const MAX_LIVES = 3;
  let runFrame = 0;

  // --- Coda di note a SLOT fissi (modalità direttore) ---
  let notes = [];            // { type:"note", midi } oppure { type:"chord", midis, progress, label }
  const VISIBLE_SLOTS = 5;
  let slotGap = 0;

  // animazione di scorrimento della coda (shift) e feedback omino
  let shiftAnim = 0;
  const SHIFT_TIME = 0.28;
  let runnerAnim = "idle";   // idle | conduct | stumble | bow (inchino finale)
  let runnerAnimT = 0;
  const CONDUCT_TIME = 0.45;
  const STUMBLE_TIME = 0.55;
  let flashErr = 0;

  // --- Modalità SCORRIMENTO (endless runner) ---
  // ogni elemento: { midi, x } con x in px; scorrono verso runnerX da destra.
  let scrollNotes = [];
  let scrollSpeed = 0;       // px/s, cresce col punteggio
  let scrollSpawnX = 0;      // prossima x di spawn (per spaziatura costante)
  const SCROLL_BASE_SPEED = 90;
  const SCROLL_SPAWN_GAP = 240; // px tra una nota e l'altra

  // --- Modalità DETTATO / MEMORIA ---
  let seq = [];              // sequenza di midi da ripetere
  let seqProgress = 0;       // quante note della sequenza ho già ripetuto
  let seqPhase = "listen";   // listen (il gioco suona) | repeat (tocca a te)
  let seqPlayIndex = 0;      // indice nota in riproduzione durante "listen"
  let seqPlayTimer = 0;      // timer per scandire la riproduzione
  let seqLen = 4;            // lunghezza sequenza (4 fisso in dettato, cresce in memoria)
  const SEQ_NOTE_MS = 620;   // durata di ogni nota suonata dal gioco
  const SEQ_GAP_MS = 180;    // pausa tra note
  let seqMaxLen = 0;         // record di lunghezza (memoria)

  // --- Animazione di FINE PARTITA ---
  let endParticles = [];     // simboli musicali che cadono
  let endTimer = 0;          // durata della sequenza finale prima della schermata
  const END_DURATION = 2.2;  // secondi

  // --- Indicatore "armed" (pronto a ricevere una nota) ---
  // armed è già gestito in pollAudio; qui solo per il pulsare visivo.

  /* =====================================================================
     (1) SETUP AUDIO + PITCH DETECTION
     ===================================================================== */


  async function initAudio() {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === "suspended") await audioCtx.resume();
      if (!micStream) {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      }
      const source = audioCtx.createMediaStreamSource(micStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      timeBuf = new Float32Array(analyser.fftSize);
      source.connect(analyser); // NON colleghiamo a destination: niente feedback
      return true;
    } catch (err) {
      console.error("Errore audio:", err);
      alert("Permesso microfono negato o non disponibile. Il gioco ha bisogno del microfono.");
      return false;
    }
  }

  // Spegne il microfono: ferma le tracce audio (la spia del mic si spegne)
  // e azzera i riferimenti. initAudio() ricrea tutto al rientro, perciò
  // questa va chiamata SOLO all'uscita dalla stanza, non in pausa.
  function releaseMic() {
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }
    analyser = null;
    lastDetected = null;
    if (audioCtx && audioCtx.state !== "closed") {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
  }

  function computeRms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  /* ---------------------------------------------------------------------
     SINTESI AUDIO — feedback sonoro (gain basso, non sovrasta il piano).
     Tutti i suoni usano un GainNode con envelope per evitare i "click".
     --------------------------------------------------------------------- */

  function midiToHz(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

  // Tono breve con envelope morbido. type: forma d'onda.
  function playTone(freq, dur, when, type, peakGain) {
    if (!audioCtx) return;
    const t0 = when != null ? when : audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type || "sine";
    osc.frequency.value = freq;
    const peak = peakGain != null ? peakGain : 0.16;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.012);          // attacco
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);     // rilascio
    osc.connect(g); g.connect(audioCtx.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
    // copre l'eventuale parte futura (when>now) + la durata del suono + coda
    const aheadMs = Math.max(0, (t0 - audioCtx.currentTime)) * 1000;
    muteDetectionUntil(performance.now() + aheadMs + dur * 1000 + 60);
  }

  // Successo: la nota stessa, breve e pulita.
  function sfxSuccess(midi) {
    playTone(midiToHz(midi), 0.18, null, "sine", 0.16);
    // armonica leggera per renderlo più "campanellino"
    playTone(midiToHz(midi) * 2, 0.12, null, "sine", 0.05);
  }

  // Errore: buzz basso e corto.
  function sfxError() {
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(140, t0);
    osc.frequency.exponentialRampToValueAtTime(90, t0 + 0.12);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.14, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + 0.14);
    osc.connect(g); g.connect(audioCtx.destination);
    osc.start(t0); osc.stop(t0 + 0.16);
    muteDetectionUntil(performance.now() + 0.16 * 1000 + 60);
  }

  // Sequenza completata (dettato/memoria): arpeggio ascendente DO-MI-SOL.
  function sfxFanfare() {
    if (!audioCtx) return;
    const base = audioCtx.currentTime;
    [60, 64, 67, 72].forEach((m, i) => {
      playTone(midiToHz(m), 0.22, base + i * 0.09, "triangle", 0.14);
    });
  }

  // Game over: tre note discendenti, lente e meste.
  function sfxGameOver() {
    if (!audioCtx) return;
    const base = audioCtx.currentTime;
    [67, 64, 60].forEach((m, i) => {
      playTone(midiToHz(m), 0.5, base + i * 0.28, "sine", 0.15);
    });
  }

  // Nota suonata dal gioco durante il dettato (timbro distinto, più pieno).
  function sfxDictationNote(midi) {
    playTone(midiToHz(midi), 0.5, null, "triangle", 0.18);
    playTone(midiToHz(midi) * 2, 0.3, null, "sine", 0.04);
  }


  // -------- AUTOCORRELAZIONE (cuore del pitch detection) --------
  // Approccio MPM: NSDF (autocorrelazione normalizzata robusta all'ampiezza)
  // + peak picking del primo picco "abbastanza alto" (evita l'ottava
  // sbagliata) + interpolazione parabolica per affinare la frequenza.
  function autoCorrelate(buf, sampleRate) {
    const SIZE = buf.length;
    const minLag = Math.floor(sampleRate / FMAX);
    const maxLag = Math.min(Math.floor(sampleRate / FMIN), Math.floor(SIZE / 2));

    // nsdf[tau] = 2*r[tau]/m[tau]
    const nsdf = new Float32Array(maxLag + 1);
    for (let tau = minLag; tau <= maxLag; tau++) {
      let r = 0, m = 0;
      for (let i = 0; i < SIZE - tau; i++) {
        const a = buf[i], b = buf[i + tau];
        r += a * b;
        m += a * a + b * b;
      }
      nsdf[tau] = m > 0 ? (2 * r) / m : 0;
    }

    // peak picking: primo picco dopo che la NSDF riattraversa lo zero
    let pos = minLag;
    while (pos <= maxLag && nsdf[pos] > 0) pos++;
    while (pos <= maxLag && nsdf[pos] <= 0) pos++;

    let bestLag = -1, bestVal = 0;
    let curMaxLag = -1, curMaxVal = -Infinity;

    for (let tau = pos; tau <= maxLag; tau++) {
      const v = nsdf[tau];
      if (v > curMaxVal) { curMaxVal = v; curMaxLag = tau; }
      if (v <= 0 && curMaxLag !== -1) {
        if (curMaxVal > bestVal) { bestVal = curMaxVal; bestLag = curMaxLag; }
        curMaxVal = -Infinity; curMaxLag = -1;
        while (tau + 1 <= maxLag && nsdf[tau + 1] <= 0) tau++;
      }
    }
    if (curMaxLag !== -1 && curMaxVal > bestVal) { bestVal = curMaxVal; bestLag = curMaxLag; }

    if (bestLag <= 0 || bestVal < CLARITY_MIN) return { freq: -1, clarity: bestVal };

    // interpolazione parabolica
    let lag = bestLag;
    if (bestLag > minLag && bestLag < maxLag) {
      const x0 = nsdf[bestLag - 1], x1 = nsdf[bestLag], x2 = nsdf[bestLag + 1];
      const denom = (x0 - 2 * x1 + x2);
      if (denom !== 0) lag = bestLag + 0.5 * (x0 - x2) / denom;
    }
    return { freq: sampleRate / lag, clarity: bestVal };
  }

  function freqToMidi(freq) { return 12 * Math.log2(freq / 440) + 69; }
  function midiToNote(midi) {
    const pc = ((midi % 12) + 12) % 12;
    return { name: NOTE_NAMES_IT[pc], octave: Math.floor(midi / 12) - 1, pc };
  }
  // Etichetta con ottava (es. "DO4"): il nome da solo sarebbe ambiguo ora che
  // l'ottava conta, quindi il testo deve indicare anche l'altezza reale.
  function noteLabel(midi) {
    const n = midiToNote(midi);
    return n.name + n.octave;
  }

  function pollAudio() {
    if (!analyser) return;
    analyser.getFloatTimeDomainData(timeBuf);
    const rms = computeRms(timeBuf);
    const now = performance.now();
    lastRms = rms;

    // picco recente con decadimento lento (riferimento per il riarmo)
    recentPeak = Math.max(rms, recentPeak * 0.96);

    // silenzio: azzera e riarma
    if (rms < RMS_THRESHOLD) {
      lastDetected = null;
      armed = true;
      stableMidi = -1; stableCount = 0;
      recentPeak = Math.max(rms, recentPeak * 0.85); // svuota più in fretta
      return;
    }

    // RIARMO: se l'energia è ricaduta sotto una frazione del picco recente,
    // significa che la nota è stata rilasciata / sta decadendo: pronto a una
    // nuova. ONSET_REARM alto => serve un calo maggiore => meno doppi conteggi.
    if (!armed && rms < recentPeak * (1 - ONSET_REARM)) armed = true;
    // riarmo di sicurezza per il legato: se è passato troppo tempo dall'ultimo
    // attacco senza un calo di volume, riarma comunque (altrimenti l'input
    // suonato "attaccato" non verrebbe mai più registrato).
    if (!armed && now - onsetAt > MAX_HOLD_MS) armed = true;

    // pitch detection
    const { freq, clarity } = autoCorrelate(timeBuf, audioCtx.sampleRate);
    if (freq <= 0) { /* pitch incerto: tieni l'ultima nota, niente onset */
      if (lastDetected) lastDetected = { ...lastDetected, rms, isOnset: false };
      return;
    }

    const midi = Math.round(freqToMidi(freq));
    const note = midiToNote(midi);

    // conferma di stabilità del pitch (scarta i transienti iniziali)
    if (midi === stableMidi) stableCount++;
    else { stableMidi = midi; stableCount = 1; }

    // SPARA un onset: siamo armati, sopra soglia (già garantito), pitch
    // stabile e fuori dal periodo refrattario. NON serve che l'RMS stia
    // ancora salendo: sul piano l'attacco è troppo rapido per vederlo.
    let isOnset = false;
    if (armed && stableCount >= STABLE_FRAMES && now >= refractoryUntil
        && now >= detectMuteUntil) {  // non scattare sul nostro stesso audio
      isOnset = true;
      armed = false;
      onsetAt = now;
      refractoryUntil = now + REFRACTORY_MS;
    }

    lastDetected = { midi, name: note.name, octave: note.octave, pc: note.pc,
                     freq, rms, clarity, isOnset };
  }

  function noteMatches(detectedMidi, targetMidi) {
    if (MATCH_OCTAVE) return detectedMidi === targetMidi;
    return (((detectedMidi % 12) + 12) % 12) === (((targetMidi % 12) + 12) % 12);
  }

  /* =====================================================================
     (2) GEOMETRIA E LAYOUT
     ===================================================================== */

  // Posizioni orizzontali (calcolate in resize):
  //   directorX = dove sta il direttore (a sinistra)
  //   runnerX   = dove riposa la nota corrente, il "punto del leggio"
  //               (verso il centro, lontano dal direttore per leggibilità)
  let directorX = 0;

  function resizeCanvas() {
    if (!canvas) return;
    DPR = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    W = rect.width || window.innerWidth;
    H = rect.height || window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.imageSmoothingEnabled = false;

    // In landscape su iPhone H è ~390px: servono proporzioni generose.
    // Pentagramma centrato verticalmente, righe ben spaziate.
    lineGap = Math.max(18, Math.round(H * 0.085));
    staffY = Math.round(H * 0.60);          // linea inferiore del rigo
    directorX = Math.round(W * 0.14);       // direttore a sinistra
    runnerX = Math.round(W * 0.52);         // nota corrente verso il centro
    // distanza tra slot: usata solo per l'animazione di scorrimento
    slotGap = Math.max(120, Math.round(W * 0.30));
  }

  function midiToStaffY(midi) {
    const stepsAbove = diatonicIndex(midi) - diatonicIndex(TREBLE_BOTTOM_LINE_MIDI);
    return staffY - stepsAbove * (lineGap / 2);
  }

  function diatonicIndex(midi) {
    const pc = ((midi % 12) + 12) % 12;
    const octave = Math.floor(midi / 12) - 1;
    return octave * 7 + PC_TO_DIATONIC[pc].step;
  }

  function loop(ts) {
    if (!running) return;
    const dt = Math.min(0.05, (ts - lastTs) / 1000 || 0);
    lastTs = ts;
    pollAudio();
    update(dt);
    render();
    updateDebug();
    rafId = requestAnimationFrame(loop);
  }

  function render() {
    drawBackground();
    drawStaff();
    if (gameState === "endseq") {
      // durante la sequenza finale: niente note di gioco, solo direttore+particelle
      drawRunner();
      drawEndParticles();
    } else {
      if (MODE === "direttore") drawNotes();
      else if (MODE === "scorrimento") drawScrollNotes();
      else drawSeqNotes();        // dettato / memoria
      drawRunner();
      drawArmedIndicator();
      drawHud();
    }
    if (flashErr > 0) {
      ctx.fillStyle = "rgba(193,102,107," + (flashErr * 0.28).toFixed(3) + ")";
      ctx.fillRect(0, 0, W, H);
    }
  }

  // Fondo: carta di manoscritto blu-notte con vignettatura a lume di candela.
  function drawBackground() {
    ctx.fillStyle = PAL.bg;
    ctx.fillRect(0, 0, W, H);

    // alone caldo di candela attorno al direttore (luce radente)
    const g = ctx.createRadialGradient(directorX, staffY - lineGap * 2, 10,
                                       directorX, staffY - lineGap * 2, W * 0.6);
    g.addColorStop(0, "rgba(212,168,67,0.10)");
    g.addColorStop(1, "rgba(212,168,67,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // macchie d'invecchiamento della carta (deterministiche, ferme)
    ctx.fillStyle = "rgba(154,143,118,0.05)";
    for (let i = 0; i < 22; i++) {
      const x = (i * 97 + 40) % W;
      const y = (i * 131 + 30) % H;
      const r = 8 + (i % 5) * 6;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }

    // vignettatura ai bordi
    const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.75);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,0.45)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }

  function drawStaff() {
    ctx.strokeStyle = PAL.staff;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.85;
    for (let i = 0; i < 5; i++) {
      const y = staffY - i * lineGap;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    drawTrebleClef(40, staffY);
  }

  // Chiave di violino vergata a inchiostro oro, stilizzata ma elegante.
  function drawTrebleClef(x, bottomY) {
    ctx.save();
    ctx.strokeStyle = PAL.gold; ctx.lineWidth = 3.2; ctx.lineCap = "round"; ctx.lineJoin = "round";
    const topY = bottomY - lineGap * 4, midY = (topY + bottomY) / 2;
    ctx.beginPath();
    ctx.moveTo(x, bottomY + lineGap * 1.1);
    ctx.bezierCurveTo(x + 16, midY + 8, x - 16, midY - 8, x, topY - 8);
    ctx.bezierCurveTo(x + 14, topY + 8, x + 19, midY, x, midY + 5);
    ctx.bezierCurveTo(x - 17, midY + 10, x - 7, bottomY - 2, x + 7, bottomY - 8);
    ctx.stroke();
    ctx.fillStyle = PAL.gold;
    ctx.beginPath(); ctx.arc(x + 2, bottomY + lineGap * 0.9, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Posizione X di uno slot.
  // A riposo (shiftAnim=0) lo slot 0 sta esattamente a runnerX.
  // Durante lo shift (shiftAnim 1->0) le note traslano a sinistra di slotGap:
  // la corrente (slot 0) scivola verso il direttore e la prossima (slot 1)
  // arriva a runnerX. A shift concluso, update() fa notes.shift().
  function slotX(index) {
    if (shiftAnim <= 0) return runnerX + index * slotGap;
    const progress = 1 - shiftAnim;            // 0 -> 1 nel corso dello shift
    return runnerX + (index - progress) * slotGap;
  }

  // Mostra SOLO la nota corrente (slot 0). Durante lo scorrimento si vede
  // anche quella in arrivo (slot 1 che scivola verso 0), con dissolvenza,
  // così l'avanzamento è leggibile senza svelare in anticipo le note future.
  function drawNotes() {
    const maxIndex = shiftAnim > 0 ? 1 : 0;
    for (let i = 0; i <= maxIndex && i < notes.length; i++) {
      const n = notes[i];
      const x = slotX(i);
      let alpha = 1;
      if (shiftAnim > 0) {
        // slot 0 esce e svanisce; slot 1 entra e compare
        if (i === 0) alpha = shiftAnim;        // 1 -> 0
        else alpha = 1 - shiftAnim;            // 0 -> 1
      }
      // la "nota target" piena (con alone) solo quando è ferma a riposo
      drawNoteEntity(n, x, i === 0 && shiftAnim === 0, alpha);
    }
  }

  function drawNoteEntity(n, x, isTarget, alpha) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    if (n.type === "note") {
      drawLedgerLines(x, n.midi);
      drawNoteHead(x, midiToStaffY(n.midi), n.midi, isTarget);
      // niente nome sulla testa: il nome sta solo in alto (HUD), per non
      // sovrapporsi alla nota quando questa è in cima al rigo.
    } else { // accordo: pila di teste
      for (let k = 0; k < n.midis.length; k++) {
        drawLedgerLines(x, n.midis[k]);
        drawNoteHead(x, midiToStaffY(n.midis[k]), n.midis[k], isTarget && k < n.progress);
      }
    }
    ctx.restore();
  }

  // Testa di nota a "goccia d'inchiostro". Se è la nota target attiva,
  // alone ciano PULSANTE per massima leggibilità.
  function drawNoteHead(x, y, midi, highlighted) {
    ctx.save();
    const col = highlighted ? PAL.note : PAL.inkDim;
    if (highlighted) {
      const pulse = 12 + Math.sin(runFrame * 0.18) * 6; // alone che respira
      ctx.shadowColor = PAL.note;
      ctx.shadowBlur = pulse;
    }
    // testa leggermente più grande
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.ellipse(x, y, 10, 7.5, -0.35, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    // gambo
    ctx.strokeStyle = col; ctx.lineWidth = 2.6; ctx.lineCap = "round";
    ctx.beginPath();
    const midLineY = staffY - lineGap * 2;
    if (y > midLineY) { ctx.moveTo(x + 9, y - 1); ctx.lineTo(x + 9, y - lineGap * 3.2); }
    else { ctx.moveTo(x - 9, y + 1); ctx.lineTo(x - 9, y + lineGap * 3.2); }
    ctx.stroke();
    // alterazione (♯)
    const pc = ((midi % 12) + 12) % 12;
    if (PC_TO_DIATONIC[pc].acc === 1) {
      ctx.fillStyle = PAL.gold;
      ctx.font = "18px 'EB Garamond', Georgia, serif";
      ctx.textAlign = "right";
      ctx.fillText("♯", x - 13, y + 5);
    }
    ctx.restore();
  }

  function drawLedgerLines(x, midi) {
    const y = midiToStaffY(midi);
    ctx.strokeStyle = PAL.staff; ctx.lineWidth = 1.5;
    const topLineY = staffY - lineGap * 4, bottomLineY = staffY, half = lineGap / 2;
    for (let ly = bottomLineY + lineGap; ly <= y + half - 1; ly += lineGap) {
      ctx.beginPath(); ctx.moveTo(x - 14, ly); ctx.lineTo(x + 14, ly); ctx.stroke();
    }
    for (let ly = topLineY - lineGap; ly >= y - half + 1; ly -= lineGap) {
      ctx.beginPath(); ctx.moveTo(x - 14, ly); ctx.lineTo(x + 14, ly); ctx.stroke();
    }
  }

  // Omino DIRETTORE D'ORCHESTRA con bacchetta.
  // Stati: idle, conduct (successo), stumble (errore), bow (inchino finale).
  const DIR_SCALE = 1.6;     // il direttore è più grande: più presenza sul rigo
  function drawRunner() {
    const groundY = staffY - lineGap * 2;
    let bob = 0, lean = 0, batonAngle = -0.6, hop = 0, bend = 0;

    if (runnerAnim === "idle") {
      bob = Math.sin(runFrame * 0.12) * 2;
      batonAngle = -0.6 + Math.sin(runFrame * 0.12) * 0.12;
    } else if (runnerAnim === "conduct") {
      const t = Math.min(1, runnerAnimT / CONDUCT_TIME);
      const swing = Math.sin(t * Math.PI);
      batonAngle = -1.1 + swing * 1.9;
      hop = -Math.sin(t * Math.PI) * 10;
      lean = swing * 0.12;
    } else if (runnerAnim === "stumble") {
      const t = Math.min(1, runnerAnimT / STUMBLE_TIME);
      lean = -Math.sin(t * Math.PI) * 0.4;
      bob = Math.sin(t * Math.PI * 3) * 3;
      batonAngle = -0.6 - Math.sin(t * Math.PI) * 0.8;
    } else if (runnerAnim === "bow") {
      // inchino: si piega lentamente in avanti e si rialza (loop morbido)
      const t = (runnerAnimT % 1.6) / 1.6;
      bend = Math.sin(t * Math.PI) * 0.5;   // piega in avanti
      batonAngle = -0.6 + bend * 0.8;
    }

    const x = directorX, y = groundY + hop + bob;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(DIR_SCALE, DIR_SCALE);
    ctx.rotate(lean + bend);

    const skin = "#d9b896";

    ctx.fillStyle = PAL.frac;
    if (runnerAnim === "stumble") {
      ctx.fillRect(-9, -6, 6, 8); ctx.fillRect(3, -6, 6, 6);
    } else {
      ctx.fillRect(-8, -6, 6, 7); ctx.fillRect(2, -6, 6, 7);
    }
    ctx.fillStyle = PAL.frac;
    ctx.fillRect(-9, -23, 18, 17);
    ctx.fillStyle = PAL.ink;
    ctx.fillRect(-3, -22, 6, 12);
    ctx.fillStyle = PAL.accent;
    ctx.fillRect(-3, -22, 6, 3);
    ctx.fillStyle = skin;
    ctx.fillRect(-6, -35, 12, 12);
    ctx.fillStyle = "#2a3142";
    ctx.fillRect(-6, -35, 12, 4);
    ctx.fillStyle = PAL.frac;
    ctx.fillRect(3, -31, 2, 3);

    ctx.fillStyle = PAL.frac;
    ctx.fillRect(-12, -20, 4, 8);

    ctx.save();
    ctx.translate(8, -19);
    ctx.rotate(batonAngle);
    ctx.fillStyle = PAL.frac;
    ctx.fillRect(0, -2, 9, 4);
    ctx.fillStyle = skin;
    ctx.fillRect(8, -2, 4, 4);
    ctx.strokeStyle = PAL.ink; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(11, 0); ctx.lineTo(30, 0); ctx.stroke();
    ctx.shadowColor = PAL.accent; ctx.shadowBlur = 8;
    ctx.fillStyle = PAL.accent;
    ctx.beginPath(); ctx.arc(30, 0, 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();

    ctx.restore();

    // scintille d'inchiostro ciano sul colpo riuscito (scalate)
    if (runnerAnim === "conduct") {
      const t = Math.min(1, runnerAnimT / CONDUCT_TIME);
      const sparkX = directorX + 34 * DIR_SCALE, sparkY = groundY - 18 * DIR_SCALE;
      ctx.fillStyle = "rgba(127,212,232," + (1 - t).toFixed(2) + ")";
      for (let s = 0; s < 6; s++) {
        const a = (s / 6) * Math.PI * 2 + t * 3;
        const r = 8 + t * 22;
        ctx.fillRect(Math.round(sparkX + Math.cos(a) * r), Math.round(sparkY + Math.sin(a) * r), 3, 3);
      }
    }
  }

  // Cerchietto "armed": verde quando il sistema è pronto a una nuova nota,
  // grigio quando è in attesa di rilascio. Sta sopra la testa del direttore.
  function drawArmedIndicator() {
    if (MODE === "dettato" || MODE === "memoria") {
      if (seqPhase !== "repeat") return; // mostra solo quando tocca al giocatore
    }
    const cx = directorX;
    const cy = staffY - lineGap * 2 - 38 * DIR_SCALE;
    ctx.save();
    if (armed) { ctx.shadowColor = "#6fcf8e"; ctx.shadowBlur = 10; ctx.fillStyle = "#6fcf8e"; }
    else { ctx.fillStyle = "rgba(154,143,118,0.4)"; }
    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // --- Disegno note modalità SCORRIMENTO ---
  function drawScrollNotes() {
    for (const n of scrollNotes) {
      const isTarget = Math.abs(n.x - runnerX) < slotGap * 0.5 && n.x >= runnerX - 12;
      ctx.save();
      ctx.globalAlpha = 1;
      drawLedgerLines(n.x, n.midi);
      drawNoteHead(n.x, midiToStaffY(n.midi), n.midi, isTarget);
      ctx.restore();
    }
  }

  // --- Disegno note modalità DETTATO / MEMORIA ---
  // Mostra la sequenza come teste sul rigo: già ripetute in ciano, ancora da
  // fare in grigio. Durante l'ascolto evidenzia quella in riproduzione.
  function drawSeqNotes() {
    if (!seq.length) return;
    const startX = runnerX - slotGap * 0.5;
    const gap = Math.min(slotGap * 0.7, (W - startX - 30) / Math.max(1, seq.length));
    for (let i = 0; i < seq.length; i++) {
      const x = startX + i * gap;
      let hi = false;
      if (seqPhase === "listen") hi = (i === seqPlayIndex);
      else hi = (i === seqProgress); // la prossima da suonare
      const done = (seqPhase === "repeat" && i < seqProgress);
      ctx.save();
      ctx.globalAlpha = done ? 0.45 : 1;
      drawLedgerLines(x, seq[i]);
      drawNoteHead(x, midiToStaffY(seq[i]), seq[i], hi);
      ctx.restore();
    }
  }

  // --- Particelle di fine partita (note che cadono) ---
  function drawEndParticles() {
    ctx.save();
    ctx.fillStyle = PAL.gold;
    ctx.textAlign = "center";
    for (const p of endParticles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      ctx.font = p.size + "px 'EB Garamond', Georgia, serif";
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillText(p.glyph, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  // Nome nota grande in alto al centro, con alone scuro per leggibilità.
  function drawBigNoteName(txt) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.font = "italic 28px 'Cormorant Garamond', Georgia, serif";
    ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 8;
    ctx.fillStyle = PAL.gold;
    ctx.fillText(txt, W / 2, 36);
    ctx.restore();
  }

  function drawHud() {
    // punteggio in alto a sinistra (etichetta per modalità)
    ctx.fillStyle = PAL.ink;
    ctx.font = "20px 'Cormorant Garamond', Georgia, serif";
    ctx.textAlign = "left";
    let scoreLabel;
    if (MODE === "memoria") scoreLabel = "lunghezza " + (seq.length || seqLen);
    else scoreLabel = score === 0 ? "—" : score + (score === 1 ? " battuta" : " battute");
    ctx.fillText(scoreLabel, 16, 32);

    // vite (solo modalità con vite: direttore, scorrimento, memoria)
    if (MODE !== "dettato") {
      ctx.textAlign = "right";
      let lifeX = W - 16;
      const showLives = (MODE === "memoria") ? 1 : MAX_LIVES; // memoria: 1 vita
      for (let i = showLives - 1; i >= 0; i--) {
        ctx.fillStyle = i < lives ? PAL.accent : "rgba(154,143,118,0.3)";
        ctx.font = "20px 'EB Garamond', Georgia, serif";
        ctx.fillText("♪", lifeX, 32);
        lifeX -= 22;
      }
    }

    // nome nota / indicazione corrente in alto al centro
    if (MODE === "direttore") {
      const target = notes[0];
      if (target && shiftAnim === 0) {
        let txt = target.type === "note" ? noteLabel(target.midi)
          : target.midis.slice(target.progress).map(m => noteLabel(m)).join(" · ");
        drawBigNoteName(txt);
      }
    } else if (MODE === "scorrimento") {
      // mostra il nome della nota target più vicina al direttore
      let near = null, best = Infinity;
      for (const n of scrollNotes) {
        if (n.x >= runnerX - 12) { const d = n.x - runnerX; if (d < best) { best = d; near = n; } }
      }
      if (near) drawBigNoteName(noteLabel(near.midi));
    } else { // dettato / memoria
      if (seqPhase === "listen") drawBigNoteName("Ascolta…");
      else {
        const m = seq[seqProgress];
        if (m != null) drawBigNoteName(noteLabel(m));
      }
    }
  }

  /* =====================================================================
     (4) LOGICA DI GIOCO / PUNTEGGIO
     Modello SLOT-BASED: nessuna pressione temporale.
       - notes[0] è la nota davanti al direttore (il target).
       - suoni giusta -> animazione "conduct" + la coda scorre di uno slot
         (shiftAnim) + nuova nota in fondo + punto.
       - suoni sbagliata -> animazione "stumble" + perdi una vita. La coda
         NON scorre: resti sulla stessa nota finché non la indovini.
     ===================================================================== */

  function update(dt) {
    if (paused) return;   // in pausa: lo stato resta congelato
    runFrame++;

    // animazioni del direttore
    if (runnerAnim !== "idle" && runnerAnim !== "bow") {
      runnerAnimT += dt;
      const dur = runnerAnim === "conduct" ? CONDUCT_TIME : STUMBLE_TIME;
      if (runnerAnimT >= dur) { runnerAnim = "idle"; runnerAnimT = 0; }
    }
    if (flashErr > 0) flashErr = Math.max(0, flashErr - dt / 0.35);

    // sequenza di FINE PARTITA (inchino + particelle)
    if (gameState === "endseq") { updateEndSeq(dt); return; }

    if (MODE === "direttore")        updateDirettore(dt);
    else if (MODE === "scorrimento") updateScorrimento(dt);
    else                             updateDettato(dt);  // dettato + memoria
  }

  /* ---------- MODALITÀ DIRETTORE ---------- */
  function updateDirettore(dt) {
    if (shiftAnim > 0) {
      shiftAnim = Math.max(0, shiftAnim - dt / SHIFT_TIME);
      if (shiftAnim === 0) {
        notes.shift();
        while (notes.length < VISIBLE_SLOTS) notes.push(getNextNote());
      }
    }
    if (!canAcceptOnset()) return;
    const target = notes[0];
    if (!target) return;
    if (target.type === "note") {
      if (noteMatches(lastDetected.midi, target.midi)) { sfxSuccess(target.midi); triggerSuccess(); }
      else { sfxError(); triggerError(); }
    } else {
      const expected = target.midis[target.progress];
      if (noteMatches(lastDetected.midi, expected)) {
        sfxSuccess(expected);
        target.progress++;
        if (target.progress >= target.midis.length) triggerSuccess();
        else { runnerAnim = "conduct"; runnerAnimT = 0; }
      } else { sfxError(); target.progress = 0; triggerError(); }
    }
  }

  /* ---------- MODALITÀ SCORRIMENTO ---------- */
  function updateScorrimento(dt) {
    scrollSpeed = SCROLL_BASE_SPEED + score * 4; // accelera col punteggio
    for (const n of scrollNotes) n.x -= scrollSpeed * dt;

    // spawn a distanza costante
    scrollSpawnX -= scrollSpeed * dt;
    if (scrollSpawnX <= 0) {
      const pool = cfg.whiteOnly ? WHITE_MIDIS : CHROMATIC_MIDIS;
      scrollNotes.push({ midi: pool[Math.floor(Math.random() * pool.length)], x: W + 30 });
      scrollSpawnX = SCROLL_SPAWN_GAP;
    }

    // la nota più vicina che ha passato il direttore senza essere suonata
    const first = scrollNotes[0];
    if (first && first.x < runnerX - 16) {
      // mancata: errore, rimuovi
      scrollNotes.shift();
      sfxError(); triggerError();
      return;
    }

    // input: se c'è una nota nella finestra del direttore
    if (!canAcceptOnset()) return;
    if (first && Math.abs(first.x - runnerX) < slotGap * 0.55) {
      if (noteMatches(lastDetected.midi, first.midi)) {
        sfxSuccess(first.midi);
        scrollNotes.shift();
        score++;
        runnerAnim = "conduct"; runnerAnimT = 0;
      } else {
        sfxError(); triggerError();
      }
    }
  }

  /* ---------- MODALITÀ DETTATO / MEMORIA ---------- */
  function updateDettato(dt) {
    if (seqPhase === "listen") {
      seqPlayTimer -= dt * 1000;
      if (seqPlayTimer <= 0) {
        if (seqPlayIndex < seq.length) {
          sfxDictationNote(seq[seqPlayIndex]);
          seqPlayIndex++;
          seqPlayTimer = SEQ_NOTE_MS + SEQ_GAP_MS;
        } else {
          // finito di suonare: tocca al giocatore
          seqPhase = "repeat";
          seqProgress = 0;
          armed = true;
        }
      }
      return;
    }
    // fase repeat: ascolta gli attacchi del giocatore
    if (!canAcceptOnset()) return;
    const expected = seq[seqProgress];
    if (noteMatches(lastDetected.midi, expected)) {
      sfxSuccess(expected);
      seqProgress++;
      runnerAnim = "conduct"; runnerAnimT = 0;
      if (seqProgress >= seq.length) {
        // sequenza completata
        sfxFanfare();
        if (MODE === "memoria") {
          seqMaxLen = Math.max(seqMaxLen, seq.length);
          score = seq.length;
          // allunga e ricomincia l'ascolto
          if (seq.length < 8) seq.push(randSeqMidi());
          startListen();
        } else {
          // dettato: nuova sequenza da 4, +1 punto
          score++;
          newSeq(4);
          startListen();
        }
      }
    } else {
      sfxError();
      if (MODE === "memoria") {
        // un errore = game over
        triggerError();
      } else {
        // dettato: ricomincia la stessa sequenza dall'ascolto, niente vite
        flashErr = 1; runnerAnim = "stumble"; runnerAnimT = 0;
        startListen();
      }
    }
  }

  function randSeqMidi() {
    const pool = WHITE_MIDIS;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  function newSeq(len) {
    seq = []; for (let i = 0; i < len; i++) seq.push(randSeqMidi());
  }
  function startListen() {
    seqPhase = "listen"; seqPlayIndex = 0; seqProgress = 0;
    seqPlayTimer = 500; // piccola pausa prima di iniziare a suonare
  }

  // Filtro comune: accetta solo attacchi nuovi e confermati.
  function canAcceptOnset() {
    return lastDetected && lastDetected.isOnset;
  }

  // Genera la prossima nota/accordo (modalità direttore).
  function getNextNote() {
    if (section === "A") {
      const pool = cfg.whiteOnly ? WHITE_MIDIS : CHROMATIC_MIDIS;
      return { type: "note", midi: pool[Math.floor(Math.random() * pool.length)] };
    } else {
      const root = CHORD_ROOTS[Math.floor(Math.random() * CHORD_ROOTS.length)];
      const shape = CHORD_SHAPES[Math.floor(Math.random() * CHORD_SHAPES.length)];
      const midis = shape.intervals.map(iv => root + iv);
      return { type: "chord", midis, progress: 0, label: midiToNote(root).name + " " + shape.name };
    }
  }

  // SUCCESSO (direttore): colpo di bacchetta + scorrimento coda.
  function triggerSuccess() {
    score++;
    runnerAnim = "conduct"; runnerAnimT = 0;
    shiftAnim = 1;
    maybeSwitchSection();
  }

  // ERRORE: inciampo, flash rosso, vita persa. A zero vite -> fine partita.
  function triggerError() {
    runnerAnim = "stumble"; runnerAnimT = 0;
    flashErr = 1;
    lives--;
    if (lives <= 0) startEndSeq();
  }

  /* ---------- SEZIONI A/B (solo direttore) ---------- */
  function maybeSwitchSection() {
    if (MODE === "direttore" && section === "A" && score >= cfg.chordsAfterScore) section = "B";
  }

  /* =====================================================================
     SEQUENZA DI FINE PARTITA + game over
     ===================================================================== */

  function startEndSeq() {
    if (gameState === "endseq" || gameState === "gameover") return;
    gameState = "endseq";
    endTimer = 0;
    runnerAnim = "bow"; runnerAnimT = 0;   // il direttore si inchina
    sfxGameOver();
    // genera le particelle (note che cadono)
    endParticles = [];
    const glyphs = ["♪", "♩", "♫", "♬", "𝄞"];
    for (let i = 0; i < 26; i++) {
      endParticles.push({
        x: Math.random() * W,
        y: -20 - Math.random() * H * 0.5,
        vy: 40 + Math.random() * 80,
        rot: (Math.random() - 0.5) * 1.2,
        vr: (Math.random() - 0.5) * 2,
        size: 16 + Math.random() * 22,
        glyph: glyphs[Math.floor(Math.random() * glyphs.length)],
        life: 1,
      });
    }
  }

  function updateEndSeq(dt) {
    runnerAnimT += dt;
    endTimer += dt;
    for (const p of endParticles) {
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.y > H * 0.7) p.life -= dt * 0.8; // svaniscono in basso
    }
    if (endTimer >= END_DURATION) endGame();
  }

  function endGame() {
    if (gameState === "gameover") return;
    running = false; gameState = "gameover"; paused = false;
    if (rafId) cancelAnimationFrame(rafId);
    if (elGameBar) elGameBar.classList.add("hidden");
    // testo finale a seconda della modalità
    if (elFinalScore) {
      if (MODE === "memoria") elFinalScore.textContent = String(seqMaxLen);
      else elFinalScore.textContent = String(score);
    }
    if (elFinalLabel) {
      elFinalLabel.textContent = (MODE === "memoria")
        ? "note ricordate di fila"
        : (score === 1 ? "battuta diretta" : "battute dirette");
    }
    if (elGameOver) elGameOver.classList.remove("hidden");
  }

  /* =====================================================================
     CONTROLLO DI FLUSSO: avvio, restart, game over, pulizia
     ===================================================================== */

  function beginPlaying() {
    gameState = "playing";
    paused = false;
    resetGame();
    running = true;
    lastTs = performance.now();
    updateGameBar();
    rafId = requestAnimationFrame(loop);
  }

  /* ---------- PAUSA ---------- */
  // Mostra/nasconde la barra in-game (Pausa + Esci) a seconda dello stato.
  function updateGameBar() {
    const inGame = (gameState === "playing" || gameState === "endseq");
    if (elGameBar) elGameBar.classList.toggle("hidden", !inGame);
  }

  function pauseGame() {
    if (gameState !== "playing" || paused) return;
    paused = true;
    if (elPauseScreen) elPauseScreen.classList.remove("hidden");
    // sospendo l'audio context così non resta attivo inutilmente in pausa
    if (audioCtx && audioCtx.state === "running") audioCtx.suspend();
  }

  function resumeGame() {
    if (!paused) return;
    paused = false;
    if (elPauseScreen) elPauseScreen.classList.add("hidden");
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    lastTs = performance.now(); // evita un dt enorme al primo frame dopo la pausa
  }

  function resetGame() {
    cfg = DIFFICULTIES[CURRENT_DIFFICULTY];
    score = 0; lives = (MODE === "memoria") ? 1 : MAX_LIVES; section = "A";
    armed = true; refractoryUntil = 0; stableMidi = -1; stableCount = 0; recentPeak = 0;
    onsetAt = 0; detectMuteUntil = 0;
    shiftAnim = 0; runnerAnim = "idle"; runnerAnimT = 0; flashErr = 0;
    notes = []; scrollNotes = []; seq = []; endParticles = [];

    if (MODE === "direttore") {
      while (notes.length < VISIBLE_SLOTS) notes.push(getNextNote());
    } else if (MODE === "scorrimento") {
      scrollSpawnX = W * 0.6; scrollSpeed = SCROLL_BASE_SPEED;
    } else if (MODE === "dettato") {
      newSeq(4); startListen();
    } else if (MODE === "memoria") {
      seqMaxLen = 0; newSeq(2); startListen();
    }
  }

  // Restart: riusa l'AudioContext, riparte direttamente dal gioco.
  function restartGame() {
    if (elGameOver) elGameOver.classList.add("hidden");
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    beginPlaying();
  }

  // Pulizia all'uscita dalla stanza: ferma il loop, rilascia il microfono
  // e riporta la UI alla schermata iniziale. Al rientro initAudio() ricrea
  // l'audio e richiede di nuovo il permesso del microfono.
  function stopPianoforte() {
    running = false;
    paused = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    stopCalibration();
    releaseMic();   // uscita dalla stanza: spegne il microfono (spia off)
    gameState = "idle";
    if (elGameOver) elGameOver.classList.add("hidden");
    if (elPauseScreen) elPauseScreen.classList.add("hidden");
    if (elGameBar) elGameBar.classList.add("hidden");
    if (elCalibScreen) elCalibScreen.classList.add("hidden");
    if (elSelectScreen) elSelectScreen.classList.add("hidden");
    if (elStart) elStart.classList.remove("hidden");
    if (elStartBtn) { elStartBtn.disabled = false; elStartBtn.textContent = "Inizia"; }
  }
  // esposta globalmente così il router/altri bottoni possono fermare il gioco
  window.stopPianoforte = stopPianoforte;

  /* =====================================================================
     DEBUG
     ===================================================================== */

  function updateDebug() {
    if (!DEBUG || !elDebug) return;
    const d = lastDetected;
    const det = d ? (d.name + d.octave + " (" + d.freq.toFixed(1) + "Hz, clar " + d.clarity.toFixed(2) + ")") : "—";
    elDebug.innerHTML = "RMS: " + lastRms.toFixed(4) + "<br>Nota rilevata: " + det +
                        "<br>Sezione: " + section + " · Punti: " + score;
  }

  /* =====================================================================
     AUTOCALIBRAZIONE MICROFONO (procedura guidata pre-gioco)
     Loop dedicato, separato dal game loop. In due fasi:
       (1) misura il RUMORE di fondo mentre l'utente sta in silenzio;
       (2) fa suonare all'utente alcune NOTE di riferimento e, dai dati
           raccolti, calcola da sé RMS_THRESHOLD e CLARITY_MIN.
     Nessuno slider: tutto automatico. Le soglie valgono per la sessione.
     ===================================================================== */

  // Note di riferimento che l'utente deve suonare per calibrare (bassa/media/alta:
  // così verifichiamo che il rilevamento regga su tutto il range della stanza).
  const CALIB_NOTES = [60, 67, 72];   // DO4, SOL4, DO5
  const CALIB_AMBIENT_MS = 1800;      // durata misura del rumore di fondo

  function clampRange(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // Stato dell'autocalibrazione
  let calibPhase = "ambient";         // ambient | listen | done
  let calibPhaseStart = 0;
  let calibNoiseMax = 0, calibNoiseSum = 0, calibNoiseN = 0;
  let calibIdx = 0;
  let calibClarities = [];

  function startCalibration() {
    gameState = "calibrating";
    if (elCalibScreen) elCalibScreen.classList.remove("hidden");
    if (elCalibContinue) elCalibContinue.classList.add("hidden");
    if (elCalibRetry) elCalibRetry.classList.add("hidden");

    // Durante la MISURA usiamo soglie permissive, così il microfono rileva tutto;
    // i valori definitivi li calcoliamo a fine procedura dai dati raccolti.
    RMS_THRESHOLD = 0.004;
    CLARITY_MIN = 0.50;

    calibPhase = "ambient";
    calibPhaseStart = performance.now();
    calibNoiseMax = 0; calibNoiseSum = 0; calibNoiseN = 0;
    calibIdx = 0; calibClarities = [];
    // reset macchina onset, così il primo attacco viene colto pulito
    armed = true; stableMidi = -1; stableCount = 0; recentPeak = 0;
    onsetAt = 0; detectMuteUntil = 0;

    if (elCalibContinue) elCalibContinue.onclick = () => { stopCalibration(); beginPlaying(); };
    if (elCalibRetry) elCalibRetry.onclick = () => startCalibration();

    const tick = () => {
      if (gameState !== "calibrating") return;
      pollAudio();
      stepCalibration();
      renderCalibration();
      calibRafId = requestAnimationFrame(tick);
    };
    calibRafId = requestAnimationFrame(tick);
  }

  // Avanza la procedura: misura il rumore, poi attende le note richieste, infine
  // calcola le soglie definitive. Tutto automatico, senza slider.
  function stepCalibration() {
    const now = performance.now();

    if (calibPhase === "ambient") {
      // accumula il livello di rumore mentre l'utente sta in silenzio
      calibNoiseSum += lastRms; calibNoiseN++;
      if (lastRms > calibNoiseMax) calibNoiseMax = lastRms;
      if (now - calibPhaseStart >= CALIB_AMBIENT_MS) {
        const noiseAvg = calibNoiseN ? calibNoiseSum / calibNoiseN : 0;
        // soglia volume = ben sopra il rumore misurato, con un minimo di sicurezza
        RMS_THRESHOLD = clampRange(Math.max(calibNoiseMax * 1.8, noiseAvg * 3, 0.006), 0.006, 0.04);
        calibPhase = "listen";
        calibPhaseStart = now;
        armed = true; stableMidi = -1; stableCount = 0;
      }
      return;
    }

    if (calibPhase === "listen") {
      const target = CALIB_NOTES[calibIdx];
      // accetta quando arriva un ATTACCO la cui classe di nota coincide col target
      // (in calibrazione siamo tolleranti sull'ottava: conta che sia la nota giusta)
      if (lastDetected && lastDetected.isOnset && lastRms > RMS_THRESHOLD) {
        const samePc = (((lastDetected.midi % 12) + 12) % 12) === (((target % 12) + 12) % 12);
        if (samePc) {
          calibClarities.push(lastDetected.clarity);
          calibIdx++;
          if (calibIdx >= CALIB_NOTES.length) {
            // qualità minima = la peggiore osservata, con un margine sotto
            let minC = 1;
            for (const c of calibClarities) if (c < minC) minC = c;
            CLARITY_MIN = clampRange(minC - 0.06, 0.55, 0.85);
            calibPhase = "done";
            if (elCalibContinue) elCalibContinue.classList.remove("hidden");
            if (elCalibRetry) elCalibRetry.classList.remove("hidden");
          }
        }
      }
      return;
    }
    // done: si aspetta che l'utente prema "Comincia"
  }

  function stopCalibration() {
    if (calibRafId) { cancelAnimationFrame(calibRafId); calibRafId = null; }
    if (elCalibScreen) elCalibScreen.classList.add("hidden");
  }

  // Aggiorna la barra VU, la nota rilevata e i testi-guida della procedura.
  let calibOnsetFlash = 0;
  function renderCalibration() {
    if (!elCalibVu) return;
    const pct = Math.min(100, (lastRms / 0.3) * 100);
    elCalibVu.style.width = pct.toFixed(0) + "%";
    const passing = lastRms >= RMS_THRESHOLD;
    elCalibVu.style.background = passing ? PAL.note : PAL.err;

    // lampeggio sull'attacco rilevato (feedback "colpo registrato")
    if (lastDetected && lastDetected.isOnset) calibOnsetFlash = 1;
    calibOnsetFlash = Math.max(0, calibOnsetFlash - 0.05);

    if (lastDetected) {
      elCalibNote.textContent = lastDetected.name + lastDetected.octave;
      elCalibNote.style.color = calibOnsetFlash > 0.3 ? PAL.gold : PAL.note;
    } else {
      elCalibNote.textContent = "—";
      elCalibNote.style.color = PAL.inkDim;
    }

    if (!elCalibStep) return;
    if (calibPhase === "ambient") {
      const left = Math.ceil(Math.max(0, CALIB_AMBIENT_MS - (performance.now() - calibPhaseStart)) / 1000);
      elCalibStep.textContent = "Fai silenzio… misuro il rumore di fondo (" + left + ")";
      if (elCalibProgress) elCalibProgress.textContent = "";
    } else if (calibPhase === "listen") {
      const target = CALIB_NOTES[calibIdx];
      elCalibStep.textContent = "Suona  " + noteLabel(target);
      if (elCalibProgress) elCalibProgress.textContent = "nota " + (calibIdx + 1) + " di " + CALIB_NOTES.length;
    } else {
      elCalibStep.textContent = "Calibrazione completata ✓";
      if (elCalibProgress) elCalibProgress.textContent =
        "vol≥" + RMS_THRESHOLD.toFixed(3) + " · qual≥" + CLARITY_MIN.toFixed(2);
    }
  }



  // Inietta il markup della stanza dentro #pianoforte (chiamata dal router).
  // Sovrascrive il contenuto del div: qui mettiamo canvas + overlay del gioco.
  function creaPianoforte() {
    const pianoforte = document.getElementById("pianoforte");
    if (!pianoforte) return;
    pianoforte.innerHTML = `
      <div id="pianoApp">
        <canvas id="gameCanvas"></canvas>

        <div id="gameBar" class="pf-gamebar hidden">
          <button id="pauseBtn" class="pf-iconbtn" aria-label="Pausa">‖</button>
          <button id="exitBtn" class="pf-iconbtn" aria-label="Esci al menu">✕</button>
        </div>

        <div id="pauseScreen" class="pf-overlay hidden">
          <p class="pf-eyebrow">Intervallo</p>
          <h2 class="pf-title pf-title--sm">In pausa</h2>
          <div class="pf-rule"></div>
          <p class="pf-subtitle">Il concerto riprende quando vuoi.</p>
          <div class="pf-btnRow">
            <button id="resumeBtn" class="pf-bigBtn">Riprendi</button>
            <button id="pauseModeBtn" class="pf-bigBtn pf-bigBtn--ghost">Cambia prova</button>
          </div>
          <button class="pf-back" onclick="if(window.stopPianoforte)window.stopPianoforte();mostraPagina('menu')">Torna al menu</button>
        </div>

        <div id="startScreen" class="pf-overlay">
          <p class="pf-eyebrow">Sala 131 · il Pianoforte</p>
          <h1 class="pf-title">Il Direttore</h1>
          <div class="pf-rule"></div>
          <p class="pf-subtitle">Leggi le note sul pentagramma<br>e suonale al pianoforte.</p>
          <button id="startBtn" class="pf-bigBtn">Inizia</button>
          <p class="pf-hint">Tieni il telefono orizzontale, appoggiato sul pianoforte. Useremo il microfono.</p>
          <button class="pf-back" onclick="if(window.stopPianoforte)window.stopPianoforte();mostraPagina('menu')">Torna indietro</button>
        </div>

        <div id="selectScreen" class="pf-overlay hidden">
          <p class="pf-eyebrow">Scegli la prova</p>
          <h2 class="pf-title pf-title--sm">Quattro modi di leggere</h2>
          <div class="pf-rule"></div>
          <div class="pf-modeGrid">
            <button class="pf-mode" data-mode="direttore">
              <span class="pf-mode-name">Direttore</span>
              <span class="pf-mode-desc">Una nota alla volta, con calma. La suoni e avanzi.</span>
            </button>
            <button class="pf-mode" data-mode="scorrimento">
              <span class="pf-mode-name">Scorrimento</span>
              <span class="pf-mode-desc">Le note arrivano da destra: suonale prima che ti raggiungano.</span>
            </button>
            <button class="pf-mode" data-mode="dettato">
              <span class="pf-mode-name">Dettato</span>
              <span class="pf-mode-desc">Il pianoforte suona quattro note. Tu le ripeti a orecchio.</span>
            </button>
            <button class="pf-mode" data-mode="memoria">
              <span class="pf-mode-name">Memoria</span>
              <span class="pf-mode-desc">Come il dettato, ma la sequenza si allunga. Fino a dove arrivi?</span>
            </button>
          </div>
          <button class="pf-back" onclick="if(window.stopPianoforte)window.stopPianoforte();mostraPagina('menu')">Torna indietro</button>
        </div>

        <div id="calibScreen" class="pf-overlay hidden">
          <p class="pf-eyebrow">Accordatura</p>
          <h2 class="pf-title pf-title--sm">Calibrazione automatica</h2>
          <div class="pf-rule"></div>
          <p id="calibStep" class="pf-subtitle">Preparati: l'app si regola da sola.</p>

          <div class="pf-vuWrap"><div id="calibVu" class="pf-vuBar"></div></div>
          <div class="pf-readout">
            <span id="calibNote" class="pf-readout-note">—</span>
            <span id="calibProgress" class="pf-readout-meta"></span>
          </div>

          <p class="pf-hint">Segui le indicazioni: prima il silenzio per misurare il rumore, poi suona le note richieste.</p>

          <button id="calibContinue" class="pf-bigBtn hidden">Comincia</button>
          <button id="calibRetry" class="pf-bigBtn pf-bigBtn--ghost hidden">Ripeti calibrazione</button>
          <button class="pf-back" onclick="if(window.stopPianoforte)window.stopPianoforte();mostraPagina('menu')">Torna indietro</button>
        </div>

        <div id="gameOverScreen" class="pf-overlay hidden">
          <p class="pf-eyebrow">Fine del concerto</p>
          <h2 class="pf-title pf-title--sm">Sipario</h2>
          <div class="pf-rule"></div>
          <p class="pf-subtitle"><span id="finalScore" class="pf-finalNum">0</span><br><span id="finalLabel">battute dirette</span></p>
          <div class="pf-btnRow">
            <button id="restartBtn" class="pf-bigBtn">Da capo</button>
            <button id="changeModeBtn" class="pf-bigBtn pf-bigBtn--ghost">Cambia prova</button>
          </div>
          <button class="pf-back" onclick="if(window.stopPianoforte)window.stopPianoforte();mostraPagina('menu')">Torna indietro</button>
        </div>

        <div id="debugPanel" class="hidden"></div>
      </div>
    `;
  }
  window.creaPianoforte = creaPianoforte;

  function cacheElements() {
    canvas = document.getElementById("gameCanvas");
    if (!canvas) return false;
    ctx = canvas.getContext("2d");
    elStart = document.getElementById("startScreen");
    elStartBtn = document.getElementById("startBtn");
    elSelectScreen = document.getElementById("selectScreen");
    elGameOver = document.getElementById("gameOverScreen");
    elRestartBtn = document.getElementById("restartBtn");
    elChangeModeBtn = document.getElementById("changeModeBtn");
    elFinalScore = document.getElementById("finalScore");
    elFinalLabel = document.getElementById("finalLabel");
    elDebug = document.getElementById("debugPanel");

    elGameBar = document.getElementById("gameBar");
    elPauseBtn = document.getElementById("pauseBtn");
    elExitBtn = document.getElementById("exitBtn");
    elPauseScreen = document.getElementById("pauseScreen");
    elResumeBtn = document.getElementById("resumeBtn");
    elPauseModeBtn = document.getElementById("pauseModeBtn");

    elCalibScreen = document.getElementById("calibScreen");
    elCalibVu = document.getElementById("calibVu");
    elCalibNote = document.getElementById("calibNote");
    elCalibStep = document.getElementById("calibStep");
    elCalibProgress = document.getElementById("calibProgress");
    elCalibContinue = document.getElementById("calibContinue");
    elCalibRetry = document.getElementById("calibRetry");

    if (DEBUG && elDebug) elDebug.classList.remove("hidden");
    return true;
  }

  // "Inizia": chiede il microfono, poi mostra la scelta della modalità.
  async function onStartTap() {
    elStartBtn.disabled = true;
    elStartBtn.textContent = "Un momento…";
    gameState = "permissions";

    const audioOk = await initAudio();
    if (!audioOk) { elStartBtn.disabled = false; elStartBtn.textContent = "Inizia"; return; }

    elStart.classList.add("hidden");
    showModeSelect();
  }

  function showModeSelect() {
    gameState = "select";
    if (elSelectScreen) elSelectScreen.classList.remove("hidden");
  }

  // scelta modalità -> calibrazione -> gioco
  function onModeChosen(mode) {
    MODE = mode;
    if (elSelectScreen) elSelectScreen.classList.add("hidden");
    startCalibration();
  }

  // PUNTO DI INGRESSO dal router. IDEMPOTENTE.
  function avviaPianoforteInit() {
    if (!document.getElementById("gameCanvas")) creaPianoforte();
    if (!cacheElements()) return;

    resizeCanvas();

    if (!initialized) {
      window.addEventListener("resize", () => {
        resizeCanvas();
        if (gameState !== "playing") render();
      });
      window.addEventListener("orientationchange", () => {
        setTimeout(() => { resizeCanvas(); if (gameState !== "playing") render(); }, 200);
      });
      initialized = true;
    }

    if (elStartBtn) elStartBtn.onclick = onStartTap;
    if (elRestartBtn) elRestartBtn.onclick = restartGame;

    // barra in-game
    if (elPauseBtn) elPauseBtn.onclick = pauseGame;
    if (elExitBtn) elExitBtn.onclick = () => {
      if (window.stopPianoforte) window.stopPianoforte();
      mostraPagina("menu");
    };
    // overlay di pausa
    if (elResumeBtn) elResumeBtn.onclick = resumeGame;
    if (elPauseModeBtn) elPauseModeBtn.onclick = () => {
      paused = false;
      if (elPauseScreen) elPauseScreen.classList.add("hidden");
      running = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      if (elGameBar) elGameBar.classList.add("hidden");
      showModeSelect();
    };
    if (elChangeModeBtn) elChangeModeBtn.onclick = () => {
      if (elGameOver) elGameOver.classList.add("hidden");
      showModeSelect();
    };
    // bottoni di scelta modalità
    const modeBtns = document.querySelectorAll("#pianoforte .pf-mode");
    modeBtns.forEach(b => { b.onclick = () => onModeChosen(b.getAttribute("data-mode")); });

    stopPianoforte(); // stato pulito alla (ri)entrata
    render();
  }
  window.avviaPianoforteInit = avviaPianoforteInit;

  window.avviaPianoforte = function () {
    if (elStartBtn) onStartTap();
  };

})();
