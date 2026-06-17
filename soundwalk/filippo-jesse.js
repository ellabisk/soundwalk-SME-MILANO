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
  const MATCH_OCTAVE = false;  // false = qualsiasi ottava va bene (es. ogni DO)

  // --- Soglie audio (tarabili a runtime dalla schermata di calibrazione) ---
  // Sono `let` perché gli slider di calibrazione le modificano dal vivo.
  // I valori qui sotto sono i DEFAULT consigliati (anche pre-impostati sugli
  // slider): trovati provando un pianoforte vero. Se cambi idea li ritocchi
  // dal telefono senza ripassare da GitHub.
  let RMS_THRESHOLD = 0.010;   // soglia di volume: sotto = silenzio/rumore
  let CLARITY_MIN = 0.75;      // qualità minima del picco di autocorrelazione
  const FMIN = 70;             // Hz minima cercata
  const FMAX = 1400;           // Hz massima cercata

  // Valori consigliati mostrati come riferimento sugli slider.
  const RMS_RECOMMENDED = 0.010;
  const CLARITY_RECOMMENDED = 0.75;
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
  let elGameOver, elRestartBtn, elFinalScore, elDebug;

  // schermata di calibrazione microfono
  let elCalibScreen, elCalibVu, elCalibNote, elCalibRms, elCalibClarity;
  let elRmsSlider, elRmsVal, elClaritySlider, elClarityVal, elCalibContinue;
  let elOnsetSlider, elOnsetVal;
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

  // game loop
  let rafId = null, lastTs = 0, running = false;
  let gameState = "idle"; // idle | permissions | calibrating | playing | gameover

  // mondo di gioco
  let cfg = DIFFICULTIES[CURRENT_DIFFICULTY];
  let staffY = 0, lineGap = 0, runnerX = 0;
  let section = "A";
  let score = 0, lives = 3;
  const MAX_LIVES = 3;
  let runFrame = 0;

  // --- Coda di note a SLOT fissi (niente scorrimento temporale) ---
  // notes[0] è la nota davanti all'omino (il target corrente). Le altre
  // sono in fila a destra. Quando si indovina, tutta la coda scorre di uno
  // slot a sinistra con un'animazione, e ne entra una nuova in fondo.
  let notes = [];            // ogni nota: { midi } oppure { midis, progress, label } per accordo
  const VISIBLE_SLOTS = 5;   // quante note tenere in fila
  let slotGap = 0;           // distanza orizzontale tra slot (calcolata in resize)

  // animazione di scorrimento della coda (shift) e feedback omino
  let shiftAnim = 0;         // 0 = fermo; 1 -> 0 mentre la coda scorre di uno slot
  const SHIFT_TIME = 0.28;   // durata scorrimento (s)
  // stato animazione direttore: idle | conduct (successo) | stumble (errore)
  let runnerAnim = "idle";
  let runnerAnimT = 0;       // tempo trascorso nell'animazione corrente
  const CONDUCT_TIME = 0.45;
  const STUMBLE_TIME = 0.55;
  let flashErr = 0;          // breve flash rosso su errore

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

  function computeRms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
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
    if (armed && stableCount >= STABLE_FRAMES && now >= refractoryUntil) {
      isOnset = true;
      armed = false;
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
    drawNotes();
    drawRunner();
    drawHud();
    // velo rosso smorzato sull'errore
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
      if (cfg.showName) drawNoteLabel(x, midiToStaffY(n.midi), n.midi);
    } else { // accordo: pila di teste
      for (let k = 0; k < n.midis.length; k++) {
        drawLedgerLines(x, n.midis[k]);
        drawNoteHead(x, midiToStaffY(n.midis[k]), n.midis[k], isTarget && k < n.progress);
      }
      if (cfg.showName) {
        const topM = Math.max(...n.midis);
        ctx.fillStyle = PAL.ink;
        ctx.font = "italic 15px 'EB Garamond', Georgia, serif";
        ctx.textAlign = "center";
        ctx.fillText(n.label, x, midiToStaffY(topM) - 28);
        ctx.font = "13px 'EB Garamond', Georgia, serif";
        const seq = n.midis.map((m, j) => (isTarget && j < n.progress ? "•" : midiToNote(m).name)).join(" ");
        ctx.fillStyle = PAL.note;
        ctx.fillText(seq, x, midiToStaffY(topM) - 12);
      }
    }
    ctx.restore();
  }

  // Testa di nota a "goccia d'inchiostro" con leggero alone.
  function drawNoteHead(x, y, midi, highlighted) {
    ctx.save();
    const col = highlighted ? PAL.note : PAL.inkDim;
    // alone luminoso solo sulla nota attiva
    if (highlighted) {
      ctx.shadowColor = PAL.note;
      ctx.shadowBlur = 14;
    }
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.ellipse(x, y, 9, 7, -0.35, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    // gambo a inchiostro
    ctx.strokeStyle = col; ctx.lineWidth = 2.4; ctx.lineCap = "round";
    ctx.beginPath();
    const midLineY = staffY - lineGap * 2;
    if (y > midLineY) { ctx.moveTo(x + 8, y - 1); ctx.lineTo(x + 8, y - lineGap * 3.2); }
    else { ctx.moveTo(x - 8, y + 1); ctx.lineTo(x - 8, y + lineGap * 3.2); }
    ctx.stroke();
    // alterazione (♯) accanto alla testa
    const pc = ((midi % 12) + 12) % 12;
    if (PC_TO_DIATONIC[pc].acc === 1) {
      ctx.fillStyle = PAL.gold;
      ctx.font = "16px 'EB Garamond', Georgia, serif";
      ctx.textAlign = "right";
      ctx.fillText("♯", x - 11, y + 5);
    }
    ctx.restore();
  }

  function drawNoteLabel(x, y, midi) {
    ctx.save();
    ctx.fillStyle = PAL.ink;
    ctx.font = "italic 20px 'Cormorant Garamond', Georgia, serif";
    ctx.textAlign = "center";
    ctx.fillText(midiToNote(midi).name, x, y - 24);
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
  // Stati: idle (oscilla piano), conduct (colpo di bacchetta = successo),
  // stumble (inciampa all'indietro = errore).
  function drawRunner() {
    // Y a terra: appoggiato sulla linea centrale del pentagramma.
    const groundY = staffY - lineGap * 2;
    let bob = 0, lean = 0, batonAngle = -0.6, hop = 0;

    if (runnerAnim === "idle") {
      bob = Math.sin(runFrame * 0.12) * 2;        // respiro leggero
      batonAngle = -0.6 + Math.sin(runFrame * 0.12) * 0.12;
    } else if (runnerAnim === "conduct") {
      // colpo di bacchetta: parte alto, scende deciso verso la nota
      const t = Math.min(1, runnerAnimT / CONDUCT_TIME);
      const swing = Math.sin(t * Math.PI);        // 0->1->0
      batonAngle = -1.1 + swing * 1.9;            // sferzata verso il basso/avanti
      hop = -Math.sin(t * Math.PI) * 10;          // piccolo balzo di entusiasmo
      lean = swing * 0.12;
    } else if (runnerAnim === "stumble") {
      // inciampo: si piega all'indietro e barcolla
      const t = Math.min(1, runnerAnimT / STUMBLE_TIME);
      lean = -Math.sin(t * Math.PI) * 0.4;        // si butta indietro
      bob = Math.sin(t * Math.PI * 3) * 3;        // tremolio
      batonAngle = -0.6 - Math.sin(t * Math.PI) * 0.8;
    }

    const x = directorX, y = groundY + hop + bob;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(lean);

    const skin = "#d9b896";

    // gambe (inchiostro scuro)
    ctx.fillStyle = PAL.frac;
    if (runnerAnim === "stumble") {
      ctx.fillRect(-9, -6, 6, 8); ctx.fillRect(3, -6, 6, 6);
    } else {
      ctx.fillRect(-8, -6, 6, 7); ctx.fillRect(2, -6, 6, 7);
    }
    // frac da direttore
    ctx.fillStyle = PAL.frac;
    ctx.fillRect(-9, -23, 18, 17);
    // sparato della camicia (avorio)
    ctx.fillStyle = PAL.ink;
    ctx.fillRect(-3, -22, 6, 12);
    // papillon ametista
    ctx.fillStyle = PAL.accent;
    ctx.fillRect(-3, -22, 6, 3);
    // testa
    ctx.fillStyle = skin;
    ctx.fillRect(-6, -35, 12, 12);
    // capelli
    ctx.fillStyle = "#2a3142";
    ctx.fillRect(-6, -35, 12, 4);
    // occhio
    ctx.fillStyle = PAL.frac;
    ctx.fillRect(3, -31, 2, 3);

    // braccio sinistro
    ctx.fillStyle = PAL.frac;
    ctx.fillRect(-12, -20, 4, 8);

    // braccio destro con la BACCHETTA
    ctx.save();
    ctx.translate(8, -19);
    ctx.rotate(batonAngle);
    ctx.fillStyle = PAL.frac;
    ctx.fillRect(0, -2, 9, 4);
    ctx.fillStyle = skin;
    ctx.fillRect(8, -2, 4, 4);
    // bacchetta: asta avorio con punta ametista luminosa
    ctx.strokeStyle = PAL.ink; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(11, 0); ctx.lineTo(30, 0); ctx.stroke();
    ctx.shadowColor = PAL.accent; ctx.shadowBlur = 8;
    ctx.fillStyle = PAL.accent;
    ctx.beginPath(); ctx.arc(30, 0, 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();

    ctx.restore();

    // scintille d'inchiostro ciano sul colpo riuscito
    if (runnerAnim === "conduct") {
      const t = Math.min(1, runnerAnimT / CONDUCT_TIME);
      const sparkX = directorX + 34, sparkY = groundY - 18;
      ctx.fillStyle = "rgba(127,212,232," + (1 - t).toFixed(2) + ")";
      for (let s = 0; s < 6; s++) {
        const a = (s / 6) * Math.PI * 2 + t * 3;
        const r = 6 + t * 18;
        ctx.fillRect(Math.round(sparkX + Math.cos(a) * r), Math.round(sparkY + Math.sin(a) * r), 2.5, 2.5);
      }
    }
  }

  function drawHud() {
    // punteggio (serif, in alto a sinistra)
    ctx.fillStyle = PAL.ink;
    ctx.font = "20px 'Cormorant Garamond', Georgia, serif";
    ctx.textAlign = "left";
    ctx.fillText(score === 0 ? "—" : score + (score === 1 ? " battuta" : " battute"), 16, 32);

    // vite come gocce d'inchiostro (♪), in alto a destra
    ctx.textAlign = "right";
    let lifeX = W - 16;
    for (let i = MAX_LIVES - 1; i >= 0; i--) {
      ctx.fillStyle = i < lives ? PAL.accent : "rgba(154,143,118,0.3)";
      ctx.font = "20px 'EB Garamond', Georgia, serif";
      ctx.fillText("♪", lifeX, 32);
      lifeX -= 22;
    }

    // sezione (eyebrow discreto)
    ctx.fillStyle = PAL.inkDim;
    ctx.font = "italic 13px 'EB Garamond', Georgia, serif";
    ctx.textAlign = "right";
    ctx.fillText(section === "A" ? "note sciolte" : "arpeggi", W - 16, 52);

    // nota target corrente (al centro, sopra il rigo)
    const target = notes[0];
    if (target && shiftAnim === 0) {
      ctx.textAlign = "center";
      ctx.fillStyle = PAL.gold;
      ctx.font = "italic 17px 'Cormorant Garamond', Georgia, serif";
      let txt;
      if (target.type === "note") txt = midiToNote(target.midi).name;
      else txt = target.midis.slice(target.progress).map(m => midiToNote(m).name).join(" · ");
      ctx.fillText(txt, W / 2, 30);
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
    runFrame++;

    // avanzamento animazioni (indipendenti dal gameplay, solo estetica)
    if (runnerAnim !== "idle") {
      runnerAnimT += dt;
      const dur = runnerAnim === "conduct" ? CONDUCT_TIME : STUMBLE_TIME;
      if (runnerAnimT >= dur) { runnerAnim = "idle"; runnerAnimT = 0; }
    }
    if (flashErr > 0) flashErr = Math.max(0, flashErr - dt / 0.35);

    // animazione di scorrimento della coda: shiftAnim cala da 1 a 0
    if (shiftAnim > 0) {
      shiftAnim = Math.max(0, shiftAnim - dt / SHIFT_TIME);
      if (shiftAnim === 0) {
        // scorrimento finito: rimuovi la nota suonata e rifornisci la coda
        notes.shift();
        while (notes.length < VISIBLE_SLOTS) notes.push(getNextNote());
      }
    }

    handleNoteInput();
  }

  // Genera la prossima nota/accordo in base alla sezione corrente.
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

  function handleNoteInput() {
    if (!lastDetected) return;
    if (shiftAnim > 0) return;            // mentre la coda scorre, ignora input
    // accetta SOLO un attacco nuovo: il decay della nota precedente non conta
    if (!lastDetected.isOnset) return;

    const target = notes[0];
    if (!target) return;

    if (target.type === "note") {
      if (noteMatches(lastDetected.midi, target.midi)) triggerSuccess();
      else triggerError();
    } else { // accordo arpeggiato: ogni nota richiede un attacco distinto
      const expected = target.midis[target.progress];
      if (noteMatches(lastDetected.midi, expected)) {
        target.progress++;
        if (target.progress >= target.midis.length) {
          triggerSuccess();
        } else {
          // nota intermedia giusta: cenno di bacchetta, niente shift
          runnerAnim = "conduct"; runnerAnimT = 0;
        }
      } else {
        // nota sbagliata nell'arpeggio: errore e ricomincia l'accordo
        target.progress = 0;
        triggerError();
      }
    }
  }

  // SUCCESSO: colpo di bacchetta + scorrimento della coda di uno slot.
  function triggerSuccess() {
    score++;
    runnerAnim = "conduct"; runnerAnimT = 0;
    shiftAnim = 1;                    // avvia lo scorrimento (animato)
    maybeSwitchSection();
  }

  // ERRORE: il direttore inciampa, flash rosso, perdi una vita.
  function triggerError() {
    runnerAnim = "stumble"; runnerAnimT = 0;
    flashErr = 1;
    lives--;
    if (lives <= 0) {
      // lascia finire un attimo l'animazione, poi game over.
      // La guardia in endGame evita che scatti dopo un restart/uscita.
      setTimeout(() => { if (running && lives <= 0) endGame(); }, 400);
    }
  }

  /* =====================================================================
     (5) GESTIONE SEZIONI A / B
     ===================================================================== */

  function maybeSwitchSection() {
    if (section === "A" && score >= cfg.chordsAfterScore) section = "B";
  }

  /* =====================================================================
     CONTROLLO DI FLUSSO: avvio, restart, game over, pulizia
     ===================================================================== */

  function beginPlaying() {
    gameState = "playing";
    resetGame();
    running = true;
    lastTs = performance.now();
    rafId = requestAnimationFrame(loop);
  }

  function resetGame() {
    cfg = DIFFICULTIES[CURRENT_DIFFICULTY];
    score = 0; lives = MAX_LIVES; section = "A";
    // reset stato onset/audio
    armed = true; refractoryUntil = 0; stableMidi = -1; stableCount = 0;
    recentPeak = 0;
    shiftAnim = 0; runnerAnim = "idle"; runnerAnimT = 0; flashErr = 0;
    // riempi la coda con VISIBLE_SLOTS note
    notes = [];
    while (notes.length < VISIBLE_SLOTS) notes.push(getNextNote());
  }

  function endGame() {
    if (gameState === "gameover") return;
    running = false; gameState = "gameover";
    if (rafId) cancelAnimationFrame(rafId);
    if (elFinalScore) elFinalScore.textContent = String(score);
    if (elGameOver) elGameOver.classList.remove("hidden");
  }

  // Restart: riusa l'AudioContext, riparte direttamente dal gioco.
  function restartGame() {
    if (elGameOver) elGameOver.classList.add("hidden");
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    beginPlaying();
  }

  // Pulizia all'uscita dalla stanza: ferma il loop, riporta la UI alla
  // schermata iniziale. NON distrugge l'AudioContext (riusabile).
  function stopPianoforte() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    stopCalibration();
    gameState = "idle";
    if (elGameOver) elGameOver.classList.add("hidden");
    if (elStart) elStart.classList.remove("hidden");
    if (elStartBtn) { elStartBtn.disabled = false; elStartBtn.textContent = "Sali sul podio"; }
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
     CALIBRAZIONE MICROFONO (schermata di prova pre-gioco)
     Loop dedicato, separato dal game loop: legge il microfono, mostra
     VU/nota/clarity in tempo reale e lascia regolare le due soglie con
     gli slider. Le soglie modificate valgono per tutta la sessione.
     ===================================================================== */

  function startCalibration() {
    gameState = "calibrating";
    if (elCalibScreen) elCalibScreen.classList.remove("hidden");

    // pre-imposta gli slider sui valori correnti
    if (elRmsSlider) {
      elRmsSlider.value = RMS_THRESHOLD;
      elRmsVal.textContent = RMS_THRESHOLD.toFixed(3);
      elRmsSlider.oninput = () => {
        RMS_THRESHOLD = parseFloat(elRmsSlider.value);
        elRmsVal.textContent = RMS_THRESHOLD.toFixed(3);
      };
    }
    if (elClaritySlider) {
      elClaritySlider.value = CLARITY_MIN;
      elClarityVal.textContent = CLARITY_MIN.toFixed(2);
      elClaritySlider.oninput = () => {
        CLARITY_MIN = parseFloat(elClaritySlider.value);
        elClarityVal.textContent = CLARITY_MIN.toFixed(2);
      };
    }
    if (elOnsetSlider) {
      elOnsetSlider.value = ONSET_REARM;
      elOnsetVal.textContent = ONSET_REARM.toFixed(2);
      elOnsetSlider.oninput = () => {
        ONSET_REARM = parseFloat(elOnsetSlider.value);
        elOnsetVal.textContent = ONSET_REARM.toFixed(2);
      };
    }
    if (elCalibContinue) {
      elCalibContinue.onclick = () => {
        stopCalibration();
        beginPlaying();   // niente più gate tilt: si gioca direttamente
      };
    }

    const tick = () => {
      if (gameState !== "calibrating") return;
      pollAudio();
      renderCalibration();
      calibRafId = requestAnimationFrame(tick);
    };
    calibRafId = requestAnimationFrame(tick);
  }

  function stopCalibration() {
    if (calibRafId) { cancelAnimationFrame(calibRafId); calibRafId = null; }
    if (elCalibScreen) elCalibScreen.classList.add("hidden");
  }

  // Aggiorna la barra VU e i readout durante la calibrazione.
  let calibOnsetFlash = 0;
  function renderCalibration() {
    if (!elCalibVu) return;
    const pct = Math.min(100, (lastRms / 0.3) * 100);
    elCalibVu.style.width = pct.toFixed(0) + "%";
    const passing = lastRms >= RMS_THRESHOLD;
    elCalibVu.style.background = passing ? PAL.note : PAL.err;

    // quando scatta un ATTACCO, lampeggia (feedback "colpo registrato")
    if (lastDetected && lastDetected.isOnset) calibOnsetFlash = 1;
    calibOnsetFlash = Math.max(0, calibOnsetFlash - 0.05);

    if (lastDetected) {
      elCalibNote.textContent = lastDetected.name + lastDetected.octave;
      elCalibClarity.textContent = lastDetected.clarity.toFixed(2);
      // la nota lampeggia in oro quando è un attacco appena rilevato
      elCalibNote.style.color = calibOnsetFlash > 0.3 ? PAL.gold : PAL.note;
    } else {
      elCalibNote.textContent = "—";
      elCalibNote.style.color = PAL.inkDim;
      elCalibClarity.textContent = "0.00";
    }
    elCalibRms.textContent = lastRms.toFixed(3);
  }



  // Inietta il markup della stanza dentro #pianoforte (chiamata dal router).
  // Sovrascrive il contenuto del div: qui mettiamo canvas + overlay del gioco.
  function creaPianoforte() {
    const pianoforte = document.getElementById("pianoforte");
    if (!pianoforte) return;
    pianoforte.innerHTML = `
      <div id="pianoApp">
        <canvas id="gameCanvas"></canvas>

        <div id="startScreen" class="pf-overlay">
          <p class="pf-eyebrow">Sala 131 · il Pianoforte</p>
          <h1 class="pf-title">Il Direttore</h1>
          <div class="pf-rule"></div>
          <p class="pf-subtitle">Davanti a te, una nota sul pentagramma.<br>Suonala al pianoforte per dirigerla.<br>Sbaglia, e il direttore inciampa.</p>
          <button id="startBtn" class="pf-bigBtn">Sali sul podio</button>
          <p class="pf-hint">Tieni il telefono orizzontale, appoggiato sul pianoforte. Useremo il microfono.</p>
          <button class="pf-back" onclick="if(window.stopPianoforte)window.stopPianoforte();mostraPagina('menu')">Torna indietro</button>
        </div>

        <div id="calibScreen" class="pf-overlay hidden">
          <p class="pf-eyebrow">Accordatura</p>
          <h2 class="pf-title pf-title--sm">Prova il microfono</h2>
          <div class="pf-rule"></div>
          <p class="pf-subtitle">Suona qualche nota. La barra deve accendersi<br>e la nota deve illuminarsi a ogni tocco.</p>

          <div class="pf-vuWrap"><div id="calibVu" class="pf-vuBar"></div></div>
          <div class="pf-readout">
            <span id="calibNote" class="pf-readout-note">—</span>
            <span class="pf-readout-meta">vol <span id="calibRms">0.000</span> · qualità <span id="calibClarity">0.00</span></span>
          </div>

          <div class="pf-sliderRow">
            <label>Volume minimo</label>
            <input id="rmsSlider" class="pf-slider" type="range" min="0.001" max="0.05" step="0.001">
            <span id="rmsVal" class="pf-sliderVal">0.010</span>
          </div>
          <div class="pf-sliderRow">
            <label>Qualità minima</label>
            <input id="claritySlider" class="pf-slider" type="range" min="0.50" max="0.95" step="0.01">
            <span id="clarityVal" class="pf-sliderVal">0.75</span>
          </div>
          <div class="pf-sliderRow">
            <label>Stacco tra note</label>
            <input id="onsetSlider" class="pf-slider" type="range" min="0.15" max="0.80" step="0.01">
            <span id="onsetVal" class="pf-sliderVal">0.45</span>
          </div>
          <p class="pf-hint">Se non rileva, abbassa volume e qualità. Se conta due volte la stessa nota, alza lo stacco tra note.</p>

          <button id="calibContinue" class="pf-bigBtn">Comincia</button>
          <button class="pf-back" onclick="if(window.stopPianoforte)window.stopPianoforte();mostraPagina('menu')">Torna indietro</button>
        </div>

        <div id="gameOverScreen" class="pf-overlay hidden">
          <p class="pf-eyebrow">Fine del concerto</p>
          <h2 class="pf-title pf-title--sm">Sipario</h2>
          <div class="pf-rule"></div>
          <p class="pf-subtitle">Hai diretto <span id="finalScore">0</span> battute.</p>
          <button id="restartBtn" class="pf-bigBtn">Da capo</button>
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
    elGameOver = document.getElementById("gameOverScreen");
    elRestartBtn = document.getElementById("restartBtn");
    elFinalScore = document.getElementById("finalScore");
    elDebug = document.getElementById("debugPanel");

    elCalibScreen = document.getElementById("calibScreen");
    elCalibVu = document.getElementById("calibVu");
    elCalibNote = document.getElementById("calibNote");
    elCalibRms = document.getElementById("calibRms");
    elCalibClarity = document.getElementById("calibClarity");
    elRmsSlider = document.getElementById("rmsSlider");
    elRmsVal = document.getElementById("rmsVal");
    elClaritySlider = document.getElementById("claritySlider");
    elClarityVal = document.getElementById("clarityVal");
    elOnsetSlider = document.getElementById("onsetSlider");
    elOnsetVal = document.getElementById("onsetVal");
    elCalibContinue = document.getElementById("calibContinue");

    if (DEBUG && elDebug) elDebug.classList.remove("hidden");
    return true;
  }

  async function onStartTap() {
    elStartBtn.disabled = true;
    elStartBtn.textContent = "Un momento…";
    gameState = "permissions";

    const audioOk = await initAudio();
    if (!audioOk) { elStartBtn.disabled = false; elStartBtn.textContent = "Sali sul podio"; return; }

    elStart.classList.add("hidden");
    startCalibration();   // microfono ok -> prova/accordatura -> gioco
  }

  // PUNTO DI INGRESSO dal router. IDEMPOTENTE: il router lo chiama ogni
  // volta che si entra nella stanza, anche al ritorno dal menu.
  function avviaPianoforteInit() {
    if (!document.getElementById("gameCanvas")) creaPianoforte();
    if (!cacheElements()) return;

    resizeCanvas();

    if (!initialized) {
      window.addEventListener("resize", () => {
        resizeCanvas();
        if (gameState !== "playing") render();
      });
      // su mobile il cambio orientamento arriva con un evento dedicato
      window.addEventListener("orientationchange", () => {
        setTimeout(() => { resizeCanvas(); if (gameState !== "playing") render(); }, 200);
      });
      initialized = true;
    }

    if (elStartBtn) elStartBtn.onclick = onStartTap;
    if (elRestartBtn) elRestartBtn.onclick = restartGame;

    stopPianoforte(); // stato pulito alla (ri)entrata
    render();
  }
  window.avviaPianoforteInit = avviaPianoforteInit;

  // L'HTML del sito ha un onclick="avviaPianoforte()" (vecchio nome).
  // Alias per non lasciare un riferimento rotto.
  window.avviaPianoforte = function () {
    if (elStartBtn) onStartTap();
  };

})();
