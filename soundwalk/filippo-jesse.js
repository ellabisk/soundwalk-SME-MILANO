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

  let elStart, elStartBtn, elReadyBtn, elTiltMsg, elTiltScreen;
  let elGameOver, elRestartBtn, elFinalScore, elDebug;

  // schermata di calibrazione microfono
  let elCalibScreen, elCalibVu, elCalibNote, elCalibRms, elCalibClarity;
  let elRmsSlider, elRmsVal, elClaritySlider, elClarityVal, elCalibContinue;
  let calibRafId = null; // loop dedicato alla calibrazione (separato dal gioco)

  let initialized = false; // per rendere avviaPianoforteInit idempotente

  // audio
  let audioCtx = null, analyser = null, micStream = null;
  let timeBuf = null, lastDetected = null, lastRms = 0;

  // sensori
  let orientationHandler = null, tiltOkSince = 0, tiltGatePassed = false;
  let orientPermission = "unavailable"; // esito di requestOrientationPermission

  // game loop
  let rafId = null, lastTs = 0, running = false;
  let gameState = "idle"; // idle | permissions | waitingTilt | playing | gameover

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

  let noteReleased = true;   // edge detection: una nota va rilasciata prima della prossima

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
    lastRms = computeRms(timeBuf);
    if (lastRms < RMS_THRESHOLD) { lastDetected = null; noteReleased = true; return; }

    const { freq, clarity } = autoCorrelate(timeBuf, audioCtx.sampleRate);
    if (freq <= 0) { lastDetected = null; return; }

    const midi = Math.round(freqToMidi(freq));
    const note = midiToNote(midi);
    lastDetected = { midi, name: note.name, octave: note.octave, pc: note.pc, freq, rms: lastRms, clarity };
  }

  function noteMatches(detectedMidi, targetMidi) {
    if (MATCH_OCTAVE) return detectedMidi === targetMidi;
    return (((detectedMidi % 12) + 12) % 12) === (((targetMidi % 12) + 12) % 12);
  }

  /* =====================================================================
     (2) SETUP SENSORI / ORIENTAMENTO (gate di avvio)
     ===================================================================== */

  async function requestOrientationPermission() {
    const D = window.DeviceOrientationEvent;
    if (D && typeof D.requestPermission === "function") {
      try { return (await D.requestPermission()) === "granted" ? "granted" : "unavailable"; }
      catch (e) { return "unavailable"; }
    } else if (D) {
      return "android";
    }
    return "unavailable";
  }

  const TILT_TOL = 20;       // gradi di tolleranza
  const TILT_HOLD_MS = 1000; // tempo continuo richiesto

  function startTiltGate() {
    tiltOkSince = 0; tiltGatePassed = false;
    orientationHandler = function (ev) {
      if (tiltGatePassed) return;
      const beta = ev.beta, gamma = ev.gamma;
      if (beta === null || gamma === null) return;
      const flat = Math.abs(beta) <= TILT_TOL && Math.abs(gamma) <= TILT_TOL;
      const now = performance.now();
      if (flat) {
        if (tiltOkSince === 0) tiltOkSince = now;
        const held = now - tiltOkSince;
        if (elTiltMsg) elTiltMsg.textContent = "Perfetto, tieni fermo… " + Math.ceil((TILT_HOLD_MS - held) / 1000) + "s";
        if (held >= TILT_HOLD_MS) { tiltGatePassed = true; stopTiltGate(); beginPlaying(); }
      } else {
        tiltOkSince = 0;
        if (elTiltMsg) elTiltMsg.textContent = "Appoggia il telefono in orizzontale sul pianoforte";
      }
    };
    window.addEventListener("deviceorientation", orientationHandler, true);
  }

  function stopTiltGate() {
    if (orientationHandler) {
      window.removeEventListener("deviceorientation", orientationHandler, true);
      orientationHandler = null;
    }
  }

  /* =====================================================================
     (3) GAME LOOP + RENDERING CANVAS
     ===================================================================== */

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

    lineGap = Math.max(14, Math.round(H * 0.045));
    staffY = Math.round(H * 0.62);
    runnerX = Math.round(W * 0.18);
    // distanza tra le note in fila: lo spazio da runner al bordo destro / slot
    slotGap = Math.max(70, Math.round((W - runnerX - 30) / VISIBLE_SLOTS));
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
    ctx.fillStyle = "#0e1230";
    ctx.fillRect(0, 0, W, H);
    drawBackground();
    drawStaff();
    drawNotes();
    drawRunner();
    drawHud();
    // breve flash rosso su errore
    if (flashErr > 0) {
      ctx.fillStyle = "rgba(239,71,111," + (flashErr * 0.35).toFixed(3) + ")";
      ctx.fillRect(0, 0, W, H);
    }
  }

  function drawBackground() {
    ctx.fillStyle = "#1b2350";
    for (let i = 0; i < 30; i++) {
      const x = (i * 53) % W;
      const y = (i * 37) % (H * 0.5);
      ctx.fillRect(Math.round(x), Math.round(y), 2, 2);
    }
    ctx.fillStyle = "#161a3a";
    ctx.fillRect(0, staffY + lineGap * 3, W, H);
  }

  function drawStaff() {
    ctx.strokeStyle = "#aab4f0";
    ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      const y = staffY - i * lineGap;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    drawTrebleClef(34, staffY);
  }

  function drawTrebleClef(x, bottomY) {
    ctx.save();
    ctx.strokeStyle = "#ffd166"; ctx.lineWidth = 3; ctx.lineCap = "round";
    const topY = bottomY - lineGap * 4, midY = (topY + bottomY) / 2;
    ctx.beginPath();
    ctx.moveTo(x, bottomY + lineGap * 0.8);
    ctx.bezierCurveTo(x + 14, midY + 6, x - 14, midY - 6, x, topY - 6);
    ctx.bezierCurveTo(x + 12, topY + 6, x + 16, midY, x, midY + 4);
    ctx.bezierCurveTo(x - 14, midY + 8, x - 6, bottomY - 2, x + 6, bottomY - 6);
    ctx.stroke();
    ctx.fillStyle = "#ffd166";
    ctx.beginPath(); ctx.arc(x + 2, bottomY + lineGap * 0.6, 4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Posizione X di uno slot, tenendo conto dell'animazione di scorrimento.
  // Durante lo shift le note "scivolano" da uno slot al precedente.
  function slotX(index) {
    // shiftAnim va da 1 (appena indovinato) a 0 (fermo): le note partono
    // dallo slot index+1 e arrivano a index.
    return runnerX + (index + shiftAnim) * slotGap;
  }

  function drawNotes() {
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const x = slotX(i);
      if (x > W + 40) continue; // fuori schermo a destra
      const isTarget = (i === 0);
      if (n.type === "note") {
        drawNoteHead(x, midiToStaffY(n.midi), n.midi, isTarget);
        drawLedgerLines(x, n.midi);
        if (cfg.showName) drawNoteLabel(x, midiToStaffY(n.midi), n.midi);
      } else { // accordo
        for (let k = 0; k < n.midis.length; k++) {
          drawNoteHead(x, midiToStaffY(n.midis[k]), n.midis[k], isTarget && k < n.progress);
          drawLedgerLines(x, n.midis[k]);
        }
        if (cfg.showName) {
          const topM = Math.max(...n.midis);
          ctx.fillStyle = "#ffffff"; ctx.font = "bold 13px monospace"; ctx.textAlign = "center";
          ctx.fillText(n.label, x, midiToStaffY(topM) - 26);
          ctx.font = "11px monospace";
          const seq = n.midis.map((m, j) => (isTarget && j < n.progress ? "•" : midiToNote(m).name)).join(" ");
          ctx.fillText(seq, x, midiToStaffY(topM) - 12);
        }
      }
    }
  }

  function drawNoteHead(x, y, midi, highlighted) {
    ctx.save();
    ctx.fillStyle = highlighted ? "#06d6a0" : "#ef476f";
    ctx.beginPath(); ctx.ellipse(x, y, 9, 7, -0.3, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = "#10122b"; ctx.stroke();
    ctx.strokeStyle = highlighted ? "#06d6a0" : "#ef476f"; ctx.lineWidth = 3;
    ctx.beginPath();
    const midLineY = staffY - lineGap * 2;
    if (y > midLineY) { ctx.moveTo(x + 8, y - 1); ctx.lineTo(x + 8, y - lineGap * 3.2); }
    else { ctx.moveTo(x - 8, y + 1); ctx.lineTo(x - 8, y + lineGap * 3.2); }
    ctx.stroke();
    const pc = ((midi % 12) + 12) % 12;
    if (PC_TO_DIATONIC[pc].acc === 1) {
      ctx.fillStyle = "#ffd166"; ctx.font = "bold 16px monospace"; ctx.textAlign = "right";
      ctx.fillText("#", x - 11, y + 5);
    }
    ctx.restore();
  }

  function drawNoteLabel(x, y, midi) {
    ctx.fillStyle = "#ffffff"; ctx.font = "bold 14px monospace"; ctx.textAlign = "center";
    ctx.fillText(midiToNote(midi).name, x, y - 22);
  }

  function drawLedgerLines(x, midi) {
    const y = midiToStaffY(midi);
    ctx.strokeStyle = "#aab4f0"; ctx.lineWidth = 2;
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

    const x = runnerX, y = groundY + hop + bob;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(lean);

    const c = "#06d6a0", dark = "#048a67", skin = "#ffd9a6";

    // gambe
    ctx.fillStyle = dark;
    if (runnerAnim === "stumble") {
      ctx.fillRect(-9, -6, 6, 8); ctx.fillRect(3, -6, 6, 6); // gambe scomposte
    } else {
      ctx.fillRect(-8, -6, 6, 7); ctx.fillRect(2, -6, 6, 7);
    }
    // corpo (frac da direttore)
    ctx.fillStyle = "#10122b";
    ctx.fillRect(-9, -23, 18, 17);
    // camicia bianca al centro
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(-3, -22, 6, 12);
    // testa
    ctx.fillStyle = skin;
    ctx.fillRect(-6, -35, 12, 12);
    // capelli
    ctx.fillStyle = "#3a2a18";
    ctx.fillRect(-6, -35, 12, 4);
    // occhio (guarda avanti, verso la nota)
    ctx.fillStyle = "#10122b";
    ctx.fillRect(3, -31, 2, 3);

    // braccio sinistro (dietro)
    ctx.fillStyle = "#10122b";
    ctx.fillRect(-12, -20, 4, 8);

    // braccio destro che impugna la BACCHETTA (verso la nota)
    ctx.save();
    ctx.translate(8, -19);          // spalla destra
    ctx.rotate(batonAngle);
    // avambraccio
    ctx.fillStyle = "#10122b";
    ctx.fillRect(0, -2, 9, 4);
    // mano
    ctx.fillStyle = skin;
    ctx.fillRect(8, -2, 4, 4);
    // bacchetta bianca
    ctx.strokeStyle = "#fff8e7";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.lineTo(30, 0);
    ctx.stroke();
    // punta della bacchetta
    ctx.fillStyle = "#ffd166";
    ctx.beginPath(); ctx.arc(30, 0, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    ctx.restore();

    // scintille sul colpo di bacchetta riuscito
    if (runnerAnim === "conduct") {
      const t = Math.min(1, runnerAnimT / CONDUCT_TIME);
      const sparkX = runnerX + 34, sparkY = groundY - 18;
      ctx.fillStyle = "rgba(255,209,102," + (1 - t).toFixed(2) + ")";
      for (let s = 0; s < 5; s++) {
        const a = (s / 5) * Math.PI * 2 + t * 3;
        const r = 6 + t * 16;
        ctx.fillRect(Math.round(sparkX + Math.cos(a) * r), Math.round(sparkY + Math.sin(a) * r), 3, 3);
      }
    }
  }

  function drawHud() {
    ctx.fillStyle = "#ffffff"; ctx.font = "bold 18px monospace"; ctx.textAlign = "left";
    ctx.fillText("Punti: " + score, 12, 28);

    // vite a forma di cuoricino pixel, in alto a destra
    ctx.textAlign = "right";
    let hearts = "";
    for (let i = 0; i < MAX_LIVES; i++) hearts += (i < lives ? "♥" : "·");
    ctx.fillStyle = "#ef476f";
    ctx.fillText(hearts, W - 12, 28);

    // sezione (piccola, sotto le vite)
    ctx.fillStyle = "#6b76b8"; ctx.font = "12px monospace";
    ctx.fillText("Sez. " + section, W - 12, 46);

    // nota target corrente = notes[0]
    const target = notes[0];
    if (target && shiftAnim === 0) {
      ctx.textAlign = "center"; ctx.fillStyle = "#ffd166"; ctx.font = "bold 16px monospace";
      let txt;
      if (target.type === "note") txt = "Suona: " + midiToNote(target.midi).name;
      else txt = "Arpeggia: " + target.midis.slice(target.progress).map(m => midiToNote(m).name).join(" → ");
      ctx.fillText(txt, W / 2, 52);
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
    if (shiftAnim > 0) return;        // mentre la coda scorre, ignora input
    const target = notes[0];
    if (!target) return;
    if (!noteReleased) return;        // serve un "rilascio" tra due note

    if (target.type === "note") {
      if (noteMatches(lastDetected.midi, target.midi)) {
        triggerSuccess();
      } else {
        triggerError();
      }
      noteReleased = false;
    } else { // accordo arpeggiato
      const expected = target.midis[target.progress];
      if (noteMatches(lastDetected.midi, expected)) {
        target.progress++;
        noteReleased = false;
        if (target.progress >= target.midis.length) {
          triggerSuccess();
        } else {
          // nota intermedia giusta: piccolo cenno di bacchetta, niente shift
          runnerAnim = "conduct"; runnerAnimT = 0;
        }
      } else {
        // nota sbagliata nell'arpeggio: errore e ricomincia l'accordo
        target.progress = 0;
        triggerError();
        noteReleased = false;
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
    if (elTiltScreen) elTiltScreen.classList.add("hidden");
    gameState = "playing";
    resetGame();
    running = true;
    lastTs = performance.now();
    rafId = requestAnimationFrame(loop);
  }

  function resetGame() {
    cfg = DIFFICULTIES[CURRENT_DIFFICULTY];
    score = 0; lives = MAX_LIVES; section = "A";
    noteReleased = true;
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

  // Pulizia all'uscita dalla stanza: ferma il loop e il gate, riporta la
  // UI alla schermata iniziale. NON distrugge l'AudioContext (riusabile).
  function stopPianoforte() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    stopTiltGate();
    stopCalibration();
    gameState = "idle";
    if (elGameOver) elGameOver.classList.add("hidden");
    if (elTiltScreen) elTiltScreen.classList.add("hidden");
    if (elStart) elStart.classList.remove("hidden");
    if (elStartBtn) { elStartBtn.disabled = false; elStartBtn.textContent = "Avvia"; }
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
    if (elCalibContinue) {
      elCalibContinue.onclick = () => {
        stopCalibration();
        goToTiltGate();
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
  function renderCalibration() {
    if (!elCalibVu) return;
    // barra VU: mappa l'RMS (0..~0.3 tipico) su 0..100%
    const pct = Math.min(100, (lastRms / 0.3) * 100);
    elCalibVu.style.width = pct.toFixed(0) + "%";
    // colore: rosso sotto soglia, verde sopra (così vedi subito se "passa")
    const passing = lastRms >= RMS_THRESHOLD;
    elCalibVu.style.background = passing ? "#06d6a0" : "#ef476f";

    if (lastDetected) {
      elCalibNote.textContent = lastDetected.name + lastDetected.octave;
      elCalibClarity.textContent = lastDetected.clarity.toFixed(2);
    } else {
      elCalibNote.textContent = "—";
      // mostra comunque la clarity grezza se il volume passa ma la nota no
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
          <h1 class="pf-title">IL PIANOFORTE</h1>
          <p class="pf-subtitle">Sei il direttore d'orchestra.<br>Suona la nota giusta per dirigerla.</p>
          <button id="startBtn" class="pf-bigBtn">Avvia</button>
          <p class="pf-hint">Servono microfono e sensori del telefono.</p>
          <button class="pf-back" onclick="if(window.stopPianoforte)window.stopPianoforte();mostraPagina('menu')">Torna indietro</button>
        </div>

        <div id="calibScreen" class="pf-overlay hidden">
          <h2 class="pf-title">PROVA MICROFONO</h2>
          <p class="pf-subtitle">Suona qualche nota sul pianoforte.<br>Controlla che il livello salga e che compaia la nota.</p>

          <div class="pf-vuWrap">
            <div id="calibVu" class="pf-vuBar"></div>
          </div>
          <div class="pf-calibReadout">
            Nota: <span id="calibNote">—</span><br>
            Volume (RMS): <span id="calibRms">0.000</span> ·
            Qualità: <span id="calibClarity">0.00</span>
          </div>

          <div class="pf-sliderRow">
            <label>Soglia volume</label>
            <input id="rmsSlider" class="pf-slider" type="range" min="0.001" max="0.05" step="0.001">
            <span id="rmsVal" class="pf-sliderVal">0.010</span>
          </div>
          <div class="pf-sliderRow">
            <label>Soglia qualità</label>
            <input id="claritySlider" class="pf-slider" type="range" min="0.50" max="0.95" step="0.01">
            <span id="clarityVal" class="pf-sliderVal">0.75</span>
          </div>
          <p class="pf-hint">Consigliato: volume 0.010 · qualità 0.75. Abbassa se non rileva, alza se rileva nel silenzio.</p>

          <button id="calibContinue" class="pf-bigBtn">Continua</button>
          <button class="pf-back" onclick="if(window.stopPianoforte)window.stopPianoforte();mostraPagina('menu')">Torna indietro</button>
        </div>

        <div id="tiltScreen" class="pf-overlay hidden">
          <div class="pf-phoneIcon">📱</div>
          <p id="tiltMsg" class="pf-tiltMsg">Appoggia il telefono in orizzontale sul pianoforte</p>
          <button id="readyBtn" class="pf-bigBtn hidden">Sono pronto</button>
          <button class="pf-back" onclick="if(window.stopPianoforte)window.stopPianoforte();mostraPagina('menu')">Torna indietro</button>
        </div>

        <div id="gameOverScreen" class="pf-overlay hidden">
          <h2 class="pf-title pf-gameover">GAME OVER</h2>
          <p class="pf-subtitle">Punteggio: <span id="finalScore">0</span></p>
          <button id="restartBtn" class="pf-bigBtn">Ricomincia</button>
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
    elReadyBtn = document.getElementById("readyBtn");
    elTiltScreen = document.getElementById("tiltScreen");
    elTiltMsg = document.getElementById("tiltMsg");
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
    elCalibContinue = document.getElementById("calibContinue");

    if (DEBUG && elDebug) elDebug.classList.remove("hidden");
    return true;
  }

  async function onStartTap() {
    elStartBtn.disabled = true;
    elStartBtn.textContent = "Attendi…";
    gameState = "permissions";

    const audioOk = await initAudio();
    if (!audioOk) { elStartBtn.disabled = false; elStartBtn.textContent = "Avvia"; return; }

    // chiedi SUBITO il permesso sensori (deve stare nel gesto del tap su iOS),
    // ma il gate del tilt lo attiviamo solo dopo la calibrazione
    orientPermission = await requestOrientationPermission();

    elStart.classList.add("hidden");
    // -> schermata di prova microfono
    startCalibration();
  }

  // Dopo la calibrazione: schermata "appoggia il telefono" + gate del tilt.
  function goToTiltGate() {
    elTiltScreen.classList.remove("hidden");
    if (orientPermission === "unavailable") {
      elTiltMsg.textContent = "Sensori non disponibili. Premi quando sei pronto.";
      elReadyBtn.classList.remove("hidden");
    } else {
      elReadyBtn.classList.add("hidden");
      elTiltMsg.textContent = "Appoggia il telefono in orizzontale sul pianoforte";
      startTiltGate();
    }
  }

  // PUNTO DI INGRESSO dal router. IDEMPOTENTE: il router lo chiama ogni
  // volta che si entra nella stanza, anche al ritorno dal menu.
  function avviaPianoforteInit() {
    // se il markup non c'è (router non ha chiamato creaPianoforte, o il div
    // è stato sovrascritto), lo iniettiamo noi
    if (!document.getElementById("gameCanvas")) creaPianoforte();
    if (!cacheElements()) return;

    resizeCanvas();

    if (!initialized) {
      window.addEventListener("resize", () => {
        resizeCanvas();
        if (gameState !== "playing") render();
      });
      initialized = true;
    }

    // i bottoni sono nel markup iniettato: riattacco i listener ogni volta
    // (sono elementi nuovi se il div è stato rigenerato). Uso .onclick così
    // non si accumulano handler duplicati.
    if (elStartBtn) elStartBtn.onclick = onStartTap;
    if (elReadyBtn) elReadyBtn.onclick = () => { stopTiltGate(); beginPlaying(); };
    if (elRestartBtn) elRestartBtn.onclick = restartGame;

    stopPianoforte(); // stato pulito alla (ri)entrata
    render();
  }
  window.avviaPianoforteInit = avviaPianoforteInit;

  // L'HTML del sito ha un onclick="avviaPianoforte()" (vecchio nome).
  // Alias per non lasciare un riferimento rotto: avvia il flow dei permessi.
  window.avviaPianoforte = function () {
    if (elStartBtn) onStartTap();
  };

})();
