/* =====================================================================
   SOUNDWALK — STANZA 131 · IL PIANOFORTE
   Endless runner musicale. Il terreno è un pentagramma; gli ostacoli
   sono note vere che vanno suonate sul pianoforte per saltarle.

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

  // --- Soglie audio (da tarare dal vivo) ---
  const RMS_THRESHOLD = 0.012; // soglia di volume: sotto = silenzio/rumore
  const CLARITY_MIN = 0.78;    // qualità minima del picco di autocorrelazione
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

  let initialized = false; // per rendere avviaPianoforteInit idempotente

  // audio
  let audioCtx = null, analyser = null, micStream = null;
  let timeBuf = null, lastDetected = null, lastRms = 0;

  // sensori
  let orientationHandler = null, tiltOkSince = 0, tiltGatePassed = false;

  // game loop
  let rafId = null, lastTs = 0, running = false;
  let gameState = "idle"; // idle | permissions | waitingTilt | playing | gameover

  // mondo di gioco
  let cfg = DIFFICULTIES[CURRENT_DIFFICULTY];
  let staffY = 0, lineGap = 0, runnerX = 0;
  let obstacles = [], score = 0, section = "A";
  let nextSpawnX = 0, runFrame = 0, worldOffset = 0;

  let runner = { y: 0, vy: 0, jumping: false, baseY: 0 };
  const GRAVITY = 1700;

  let lastMatchedMidi = -1, noteReleased = true;

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
    runner.baseY = staffY - lineGap * 2; // appoggiato alla linea centrale
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
    drawObstacles();
    drawRunner();
    drawHud();
  }

  function drawBackground() {
    ctx.fillStyle = "#1b2350";
    for (let i = 0; i < 30; i++) {
      const x = (i * 53 + (worldOffset * 0.2)) % W;
      const y = (i * 37) % (H * 0.5);
      ctx.fillRect(Math.round((W - x)), Math.round(y), 2, 2);
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

  function drawObstacles() {
    for (const ob of obstacles) {
      if (ob.type === "note") {
        drawNoteHead(ob.x, midiToStaffY(ob.midi), ob.midi, ob.done);
        if (cfg.showName) drawNoteLabel(ob.x, midiToStaffY(ob.midi), ob.midi);
        drawLedgerLines(ob.x, ob.midi);
      } else if (ob.type === "chord") {
        for (let k = 0; k < ob.midis.length; k++) {
          const m = ob.midis[k];
          drawNoteHead(ob.x, midiToStaffY(m), m, k < ob.progress);
          drawLedgerLines(ob.x, m);
        }
        if (cfg.showName) {
          const topM = Math.max(...ob.midis);
          ctx.fillStyle = "#ffffff"; ctx.font = "bold 13px monospace"; ctx.textAlign = "center";
          ctx.fillText(ob.label, ob.x, midiToStaffY(topM) - 26);
          ctx.font = "11px monospace";
          const seq = ob.midis.map((m, i) => (i < ob.progress ? "•" : midiToNote(m).name)).join(" ");
          ctx.fillText(seq, ob.x, midiToStaffY(topM) - 12);
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

  function drawRunner() {
    const x = runnerX, y = runner.baseY + runner.y;
    ctx.save(); ctx.translate(x, y);
    const c = "#06d6a0", dark = "#048a67";
    ctx.fillStyle = c;
    ctx.fillRect(-8, -22, 16, 16);   // corpo
    ctx.fillRect(-6, -34, 12, 12);   // testa
    ctx.fillStyle = "#10122b"; ctx.fillRect(2, -31, 3, 3); // occhio
    ctx.fillStyle = c;
    if (runner.jumping) {
      ctx.fillStyle = dark; ctx.fillRect(-8, -6, 6, 6); ctx.fillRect(2, -6, 6, 6);
      ctx.fillStyle = c; ctx.fillRect(-12, -20, 4, 8); ctx.fillRect(8, -20, 4, 8);
    } else {
      const f = Math.floor(runFrame / 8) % 2;
      ctx.fillStyle = dark;
      if (f === 0) { ctx.fillRect(-8, -6, 6, 8); ctx.fillRect(2, -6, 6, 4); }
      else { ctx.fillRect(-8, -6, 6, 4); ctx.fillRect(2, -6, 6, 8); }
      ctx.fillStyle = c; ctx.fillRect(-11, -20, 4, 7); ctx.fillRect(7, -20, 4, 7);
    }
    ctx.restore();
  }

  function drawHud() {
    ctx.fillStyle = "#ffffff"; ctx.font = "bold 18px monospace"; ctx.textAlign = "left";
    ctx.fillText("Punti: " + score, 12, 28);
    ctx.textAlign = "right"; ctx.fillText("Sez. " + section, W - 12, 28);
    const target = getActiveTarget();
    if (target) {
      ctx.textAlign = "center"; ctx.fillStyle = "#ffd166"; ctx.font = "bold 16px monospace";
      let txt;
      if (target.type === "note") txt = "Suona: " + midiToNote(target.midi).name;
      else txt = "Arpeggia: " + target.midis.slice(target.progress).map(m => midiToNote(m).name).join(" → ");
      ctx.fillText(txt, W / 2, 52);
    }
  }

  /* =====================================================================
     (4) LOGICA DI GIOCO / PUNTEGGIO
     ===================================================================== */

  function update(dt) {
    runFrame++;
    const speed = cfg.scrollSpeed;
    worldOffset += speed * dt;
    for (const ob of obstacles) ob.x -= speed * dt;

    nextSpawnX -= speed * dt;
    if (nextSpawnX <= 0) { spawnObstacle(); nextSpawnX = cfg.spawnGapPx; }

    handleNoteInput();

    if (runner.jumping) {
      runner.vy += GRAVITY * dt;
      runner.y += runner.vy * dt;
      if (runner.y >= 0) { runner.y = 0; runner.vy = 0; runner.jumping = false; }
    }

    checkCollisions();
    obstacles = obstacles.filter(ob => ob.x > -40);
  }

  function triggerJump(midi) {
    if (runner.jumping) return;
    runner.jumping = true;
    const t = Math.max(0, Math.min(1, (midi - 60) / 23));
    runner.vy = -(620 + 180 * t);
  }

  function getActiveTarget() {
    for (const ob of obstacles) if (!ob.done && ob.x > runnerX - 60) return ob;
    return null;
  }

  const HIT_WINDOW = 90; // px

  function handleNoteInput() {
    if (!lastDetected) return;
    const target = getActiveTarget();
    if (!target) return;
    if (Math.abs(target.x - runnerX) > HIT_WINDOW) return;

    if (target.type === "note") {
      if (!noteReleased) return;
      if (noteMatches(lastDetected.midi, target.midi)) {
        target.done = true; score++; triggerJump(target.midi);
        noteReleased = false; lastMatchedMidi = lastDetected.midi;
        maybeSwitchSection();
      }
    } else if (target.type === "chord") {
      if (!noteReleased) return;
      const expected = target.midis[target.progress];
      if (noteMatches(lastDetected.midi, expected)) {
        target.progress++; noteReleased = false; lastMatchedMidi = lastDetected.midi;
        if (target.progress >= target.midis.length) {
          target.done = true; score++; triggerJump(Math.max(...target.midis));
          maybeSwitchSection();
        }
      }
    }
  }

  function checkCollisions() {
    for (const ob of obstacles) {
      if (ob.done) continue;
      if (ob.x - runnerX < -12 && !runner.jumping) { endGame(); return; }
    }
  }

  /* =====================================================================
     (5) GESTIONE SEZIONI A / B
     ===================================================================== */

  function notedPool() { return cfg.whiteOnly ? WHITE_MIDIS : CHROMATIC_MIDIS; }

  function spawnObstacle() {
    const spawnX = W + 30;
    if (section === "A") {
      const pool = notedPool();
      obstacles.push({ type: "note", x: spawnX, midi: pool[Math.floor(Math.random() * pool.length)], done: false });
    } else {
      const root = CHORD_ROOTS[Math.floor(Math.random() * CHORD_ROOTS.length)];
      const shape = CHORD_SHAPES[Math.floor(Math.random() * CHORD_SHAPES.length)];
      const midis = shape.intervals.map(iv => root + iv);
      obstacles.push({ type: "chord", x: spawnX, midis, progress: 0, done: false,
                       label: midiToNote(root).name + " " + shape.name });
    }
  }

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
    obstacles = []; score = 0; section = "A"; worldOffset = 0;
    nextSpawnX = Math.round(W * 0.6);
    runner.y = 0; runner.vy = 0; runner.jumping = false;
    noteReleased = true; lastMatchedMidi = -1;
  }

  function endGame() {
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
     (6) BOOTSTRAP — creaPianoforte() + avviaPianoforteInit()
     ===================================================================== */

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
          <p class="pf-subtitle">Corri sul pentagramma.<br>Suona le note per saltarle.</p>
          <button id="startBtn" class="pf-bigBtn">Avvia</button>
          <p class="pf-hint">Servono microfono e sensori del telefono.</p>
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
    if (DEBUG && elDebug) elDebug.classList.remove("hidden");
    return true;
  }

  async function onStartTap() {
    elStartBtn.disabled = true;
    elStartBtn.textContent = "Attendi…";
    gameState = "permissions";

    const audioOk = await initAudio();
    if (!audioOk) { elStartBtn.disabled = false; elStartBtn.textContent = "Avvia"; return; }

    const orient = await requestOrientationPermission();

    elStart.classList.add("hidden");
    elTiltScreen.classList.remove("hidden");

    if (orient === "unavailable") {
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
