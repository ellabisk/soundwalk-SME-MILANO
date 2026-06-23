/* =====================================================================
   SOUNDWALK — SALA 131 · IL PIANOFORTE
   YIN pitch detection + threshold-crossing onset.
   Modalità: Direttore (nota ferma sul pentagramma, la suoni per avanzare).
   Progressione: prime 10 note singole → accordi arpeggiati crescenti.
   ===================================================================== */

(function () {
  'use strict';

  /* ====================================================================
     (0) COSTANTI — modifica qui dopo il test sul piano vero
     ==================================================================== */

  const YIN_THRESH        = 0.12;  // soglia CMNDF (0.10 strict, 0.15 permissivo)
  const FMIN              = 70;    // Hz minimo cercato
  const FMAX              = 1400;  // Hz massimo cercato
  const STABLE_FRAMES     = 3;     // frame consecutivi sulla stessa nota prima di confermare
  const REFRACTORY_MS     = 300;   // ms minimi tra un onset e il successivo
  const ONSET_WINDOW      = 400;   // ms: finestra di stabilità dopo onset
  const ERROR_COOLDOWN_MS = 1500;  // ms di blocco onset dopo un errore (evita doppio trigger)
  const CALIB_MS          = 2000;  // durata calibrazione silenzio
  const CALIB_MULT        = 2.5;
  const CALIB_MIN         = 0.005;
  const CALIB_MAX         = 0.05;

  /* ====================================================================
     PALETTE E NOTE
     ==================================================================== */

  const PAL = {
    bg:     '#0d1b2a',
    staff:  '#5a7a99',
    note:   '#7fd4e8',
    ink:    '#e8dcc0',
    inkDim: '#9a8f76',
    gold:   '#d4a843',
    err:    '#c1666b',
    ok:     '#7fd4a8',
  };

  const NOTE_NAMES_IT = ['DO','DO#','RE','RE#','MI','FA','FA#','SOL','SOL#','LA','LA#','SI'];
  // Tasti bianchi DO4–SI5
  const WHITE_MIDIS   = [60,62,64,65,67,69,71,72,74,76,77,79,81,83];

  const TREBLE_BOTTOM_MIDI = 64; // E4 = prima linea del rigo (dal basso)
  const PC_STEP = [0,0,1,1,2,3,3,4,4,5,5,6];
  const PC_ACC  = [0,1,0,1,0,0,1,0,1,0,1,0];

  function diatonicIndex(midi) {
    const pc  = ((midi % 12) + 12) % 12;
    const oct = Math.floor(midi / 12) - 1;
    return oct * 7 + PC_STEP[pc];
  }

  /* ====================================================================
     (1) AUDIO — YIN pitch detection
     ==================================================================== */

  let audioCtx  = null;
  let analyser  = null;
  let micStream = null;
  let timeBuf   = null;
  let sampleRate = 44100;
  let RMS_THRESH = 0.010; // sovrascritta dalla calibrazione

  let wasQuiet         = true;
  let lastOnsetMs      = -9999;
  let postErrorUntilMs = -9999; // cooldown lungo dopo errore
  let stableMidi       = -1;
  let stableCount      = 0;
  let onsetPending     = false;
  let onsetPendMs      = 0;
  let pendingNote      = null; // consumato dal game loop

  function rmsLast(buf, n) {
    const start = Math.max(0, buf.length - n);
    let s = 0;
    for (let i = start; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / (buf.length - start));
  }

  function freqToMidi(f) { return 12 * Math.log2(f / 440) + 69; }

  // YIN — de Cheveigné & Kawahara (2002): meno errori di ottava di NSDF
  function yin(buf, sr) {
    const N  = buf.length;
    const W  = Math.floor(N / 2);
    const t1 = Math.ceil(sr / FMAX);
    const t2 = Math.min(W - 1, Math.floor(sr / FMIN));

    const d = new Float32Array(t2 + 1);
    for (let tau = 1; tau <= t2; tau++) {
      let sum = 0;
      for (let j = 0; j < W; j++) {
        const x = buf[j] - buf[j + tau];
        sum += x * x;
      }
      d[tau] = sum;
    }

    const cmnd = new Float32Array(t2 + 1);
    cmnd[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= t2; tau++) {
      run += d[tau];
      cmnd[tau] = run > 0 ? (d[tau] * tau) / run : 1;
    }

    for (let tau = t1; tau <= t2; tau++) {
      if (cmnd[tau] < YIN_THRESH) {
        while (tau + 1 <= t2 && cmnd[tau + 1] < cmnd[tau]) tau++;
        let ft = tau;
        if (tau > 1 && tau < t2) {
          const a = cmnd[tau-1], b = cmnd[tau], c = cmnd[tau+1];
          const den = a - 2*b + c;
          if (Math.abs(den) > 1e-12) ft = tau + 0.5 * (a - c) / den;
        }
        return { freq: sr / ft };
      }
    }

    let bt = t1, bv = cmnd[t1];
    for (let t = t1 + 1; t <= t2; t++) { if (cmnd[t] < bv) { bv = cmnd[t]; bt = t; } }
    return { freq: sr / bt };
  }

  function pollAudio() {
    if (!analyser) return;
    analyser.getFloatTimeDomainData(timeBuf);

    const rms    = rmsLast(timeBuf, 512);
    const isLoud = rms >= RMS_THRESH;
    const now    = performance.now();

    if (gameState === 'calibrating') {
      calibSamples.push(rms);
      wasQuiet = true;
      return;
    }

    if (!isLoud) {
      wasQuiet    = true;
      pendingNote = null;
      return;
    }

    // Rising edge → apre finestra di conferma pitch
    // Bloccato durante cooldown refrattario normale E durante cooldown post-errore
    if (wasQuiet &&
        (now - lastOnsetMs) > REFRACTORY_MS &&
        now > postErrorUntilMs) {
      onsetPending = true;
      onsetPendMs  = now;
      stableMidi   = -1;
      stableCount  = 0;
    }
    wasQuiet = false;

    const { freq } = yin(timeBuf, sampleRate);
    if (freq <= 0) return;

    const midi = Math.round(freqToMidi(freq));

    if (onsetPending) {
      if (now - onsetPendMs > ONSET_WINDOW) {
        onsetPending = false; stableMidi = -1; stableCount = 0;
      } else {
        if (midi === stableMidi) stableCount++;
        else { stableMidi = midi; stableCount = 1; }

        if (stableCount >= STABLE_FRAMES) {
          onsetPending = false;
          lastOnsetMs  = now;
          pendingNote  = { midi };
        }
      }
    }
  }

  async function initAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      if (!micStream) {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        });
      }
      sampleRate = audioCtx.sampleRate;
      analyser   = audioCtx.createAnalyser();
      analyser.fftSize = 4096;
      timeBuf    = new Float32Array(analyser.fftSize);
      const src  = audioCtx.createMediaStreamSource(micStream);
      src.connect(analyser);
      return true;
    } catch (e) {
      alert('Permesso microfono negato: ' + e.message);
      return false;
    }
  }

  function releaseMic() {
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    analyser = null;
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  }

  /* ====================================================================
     (2) CALIBRAZIONE — 2 secondi di silenzio
     ==================================================================== */

  let calibSamples = [];

  function startCalibration() {
    gameState    = 'calibrating';
    calibSamples = [];
    wasQuiet     = true;

    if (elCalib) elCalib.classList.remove('hidden');

    let t = Math.ceil(CALIB_MS / 1000);
    updateCalibText(t);

    const iv = setInterval(() => {
      t--;
      if (t > 0) {
        updateCalibText(t);
      } else {
        clearInterval(iv);
        finishCalibration();
      }
    }, 1000);
  }

  function updateCalibText(sec) {
    if (elCalibText) elCalibText.textContent = 'Silenzio… ' + sec;
  }

  function finishCalibration() {
    if (calibSamples.length > 0) {
      const maxN = Math.max(...calibSamples);
      const avgN = calibSamples.reduce((a, b) => a + b, 0) / calibSamples.length;
      RMS_THRESH = Math.max(maxN * CALIB_MULT, avgN * 4, CALIB_MIN);
      RMS_THRESH = Math.min(RMS_THRESH, CALIB_MAX);
    }
    if (elCalib) elCalib.classList.add('hidden');
    beginPlaying();
  }

  /* ====================================================================
     (3) CANVAS — geometria e resize
     ==================================================================== */

  let canvas, ctx;
  let W = 0, H = 0, DPR = 1;
  let staffY  = 0;
  let lineGap = 0;
  let noteX   = 0;

  function resizeCanvas() {
    if (!canvas) return;
    DPR = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    W = rect.width  || window.innerWidth;
    H = rect.height || window.innerHeight;
    canvas.width  = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.imageSmoothingEnabled = false;

    lineGap = Math.max(20, Math.round(H * 0.095));
    staffY  = Math.round(H * 0.60);
    noteX   = Math.round(W * 0.52);
  }

  function staffYOf(midi) {
    const steps = diatonicIndex(midi) - diatonicIndex(TREBLE_BOTTOM_MIDI);
    return staffY - steps * (lineGap / 2);
  }

  /* ====================================================================
     (4) STATO DI GIOCO
     ==================================================================== */

  let gameState    = 'idle';
  let score        = 0;
  let errorCount   = 0;
  let noteIndex    = 0;  // numero di sfide completate
  let noteStartTime = 0; // timestamp quando la nota/sfida è diventata attiva

  // Sfida corrente: { notes: [midi,...], step: int }
  let challenge     = null;
  let nextChallenge = null;

  let anim     = null;
  let flashErr = 0;
  let frameN   = 0;

  // Pop-up di feedback: [{ text, x, y, t, color }]
  let popups = [];

  const ANIM_DUR = 0.22;

  /* ── Generazione sfide ── */

  // Intervalli in semitoni per livello (dal più semplice)
  const INTERVAL_POOL = [
    [3, 4, 5],              // lv 0: terza min, terza magg, quarta
    [3, 4, 5, 7],           // lv 1: + quinta
    [3, 4, 5, 7, 8, 9],     // lv 2: + sesta
    [3, 4, 5, 7, 8, 9, 12], // lv 3: + ottava
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], // lv 4+: qualsiasi
  ];

  function generateChallenge(idx) {
    if (idx < 10) {
      return { notes: [randomWhiteNote()], step: 0 };
    }

    const level    = Math.min(4, Math.floor((idx - 10) / 10));
    const chordProb = Math.min(0.75, 0.22 + level * 0.14);

    if (Math.random() > chordProb) {
      return { notes: [randomWhiteNote()], step: 0 };
    }

    // Dimensione accordo cresce con il livello
    const maxSize = Math.min(4, 2 + Math.floor(level / 2));
    const size = 2 + Math.floor(Math.random() * (maxSize - 1));
    return { notes: buildChord(size, level), step: 0 };
  }

  function randomWhiteNote() {
    return WHITE_MIDIS[Math.floor(Math.random() * WHITE_MIDIS.length)];
  }

  function buildChord(size, level) {
    // Radice nel registro comodo (DO4–SOL5)
    const roots = WHITE_MIDIS.filter(m => m >= 60 && m <= 79);
    const root  = roots[Math.floor(Math.random() * roots.length)];
    const pool  = INTERVAL_POOL[Math.min(level, INTERVAL_POOL.length - 1)];

    const notes = [root];
    for (let i = 1; i < size; i++) {
      const interval = pool[Math.floor(Math.random() * pool.length)];
      const next     = notes[notes.length - 1] + interval;
      if (next <= 84) notes.push(next); // non oltre DO6
    }
    return notes.sort((a, b) => a - b); // ascendente per arpeggio
  }

  function beginPlaying() {
    gameState        = 'playing';
    score            = 0;
    errorCount       = 0;
    noteIndex        = 0;
    flashErr         = 0;
    popups           = [];
    pendingNote      = null;
    wasQuiet         = true;
    onsetPending     = false;
    stableMidi       = -1; stableCount = 0;
    postErrorUntilMs = -9999;
    challenge        = generateChallenge(0);
    nextChallenge    = generateChallenge(1);
    noteStartTime    = performance.now();
    anim             = { type: 'in', t: 0 };
    if (elGameBar) elGameBar.classList.remove('hidden');
  }

  function onNoteDetected(midi) {
    if (gameState !== 'playing') return;
    if (anim && anim.type !== 'idle') return;

    const targetMidi = challenge.notes[challenge.step];

    if (midi === targetMidi) {
      // Nota corretta → calcola punteggio con bonus tempo
      const elapsed   = (performance.now() - noteStartTime) / 1000;
      const timeBonus = Math.max(0, Math.round(50 * Math.max(0, 1 - elapsed / 8)));
      const pts       = 50 + timeBonus;
      score += pts;
      spawnPopup('+' + pts, noteX, staffYOf(targetMidi) - lineGap * 2.2, PAL.ok);

      challenge.step++;
      noteStartTime = performance.now(); // timer repart per prossima nota dell'arpeggio

      if (challenge.step >= challenge.notes.length) {
        // Sfida completata → avanza
        noteIndex++;
        anim = { type: 'out', t: 0 };
      }
      // Altrimenti resta sulla stessa sfida, prossima nota dell'arpeggio
    } else {
      // Errore — imposta cooldown lungo per evitare doppio trigger su note tenute
      errorCount++;
      flashErr         = 1;
      postErrorUntilMs = performance.now() + ERROR_COOLDOWN_MS;
      spawnPopup('✗', noteX, staffYOf(targetMidi) - lineGap * 2.2, PAL.err);
    }
  }

  function spawnPopup(text, x, y, color) {
    popups.push({ text, x, y, t: 0, color });
  }

  function updateGame(dt) {
    if (gameState !== 'playing') return;

    if (flashErr > 0) flashErr = Math.max(0, flashErr - dt / 0.3);

    // Pop-up: avanzano nel tempo e scompaiono
    for (let i = popups.length - 1; i >= 0; i--) {
      popups[i].t += dt / 1.1;
      if (popups[i].t >= 1) popups.splice(i, 1);
    }

    if (anim && anim.type !== 'idle') {
      anim.t += dt / ANIM_DUR;
      if (anim.t >= 1) {
        if (anim.type === 'out') {
          challenge     = nextChallenge;
          nextChallenge = generateChallenge(noteIndex + 1);
          anim          = { type: 'in', t: 0 };
        } else {
          anim          = { type: 'idle', t: 1 };
          noteStartTime = performance.now(); // timer parte da quando la nota è ferma
        }
      }
    }

    if (pendingNote) {
      onNoteDetected(pendingNote.midi);
      pendingNote = null;
    }
  }

  function showSummary() {
    gameState  = 'gameover';
    stopLoop();
    const total = noteIndex;
    const acc   = (total + errorCount) > 0
      ? Math.round(100 * total / (total + errorCount))
      : 0;
    if (elGameBar)     elGameBar.classList.add('hidden');
    if (elFinalScore)  elFinalScore.textContent  = String(score);
    if (elFinalErrors) elFinalErrors.textContent = String(errorCount);
    if (elFinalAcc)    elFinalAcc.textContent    = acc + '%';
    if (elGameOver)    elGameOver.classList.remove('hidden');
  }

  /* ====================================================================
     (5) RENDER
     ==================================================================== */

  function render() {
    if (!ctx) return;
    frameN++;

    drawBg();
    drawStaff();

    if (gameState === 'playing') {
      drawChallenge();
      drawPopups();
      drawHud();
      if (flashErr > 0) {
        ctx.fillStyle = `rgba(193,102,107,${(flashErr * 0.28).toFixed(3)})`;
        ctx.fillRect(0, 0, W, H);
      }
    } else if (gameState === 'calibrating') {
      drawListeningDot();
    }
  }

  function drawBg() {
    ctx.fillStyle = PAL.bg;
    ctx.fillRect(0, 0, W, H);
    const g = ctx.createRadialGradient(W/2, staffY - lineGap*2, 30, W/2, staffY - lineGap*2, W*0.7);
    g.addColorStop(0, 'rgba(212,168,67,0.07)');
    g.addColorStop(1, 'rgba(212,168,67,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function drawStaff() {
    const lw = Math.max(1, lineGap * 0.075);
    ctx.strokeStyle = PAL.staff;
    ctx.lineWidth   = lw;
    ctx.globalAlpha = 0.75;
    for (let i = 0; i < 5; i++) {
      const y = staffY - i * lineGap;
      ctx.beginPath();
      ctx.moveTo(W * 0.06, y);
      ctx.lineTo(W * 0.94, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    drawTrebleClef(W * 0.09, staffY);
  }

  function drawTrebleClef(x, botY) {
    ctx.save();
    ctx.strokeStyle = PAL.gold;
    ctx.lineWidth   = lineGap * 0.17;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    const topY = botY - lineGap * 4;
    const midY = (topY + botY) / 2;
    const g    = lineGap;
    ctx.beginPath();
    ctx.moveTo(x, botY + g * 1.05);
    ctx.bezierCurveTo(x + g*0.85, midY + g*0.4,  x - g*0.85, midY - g*0.4, x, topY - g*0.45);
    ctx.bezierCurveTo(x + g*0.75, topY + g*0.4,  x + g*0.95, midY,         x, midY + g*0.25);
    ctx.bezierCurveTo(x - g*0.9,  midY + g*0.55, x - g*0.35, botY - g*0.1, x + g*0.35, botY - g*0.45);
    ctx.stroke();
    ctx.fillStyle = PAL.gold;
    ctx.beginPath();
    ctx.arc(x + g*0.1, botY + g * 0.8, g * 0.27, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  }

  /* ── Disegno sfida corrente ── */

  function drawChallenge() {
    if (!challenge || !anim) return;

    const p = Math.min(1, anim.t);
    let x = noteX, alpha = 1;

    if (anim.type === 'out') {
      const ease = p * p;
      x     = noteX - ease * W * 0.55;
      alpha = 1 - p;
    } else if (anim.type === 'in') {
      const ease = 1 - (1 - p) * (1 - p);
      x     = noteX + (1 - ease) * W * 0.42;
      alpha = ease;
    }

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    drawChallengeAt(x, challenge, true);
    ctx.restore();

    // Anteprima prossima sfida (semitrasparente a destra)
    if (nextChallenge && anim.type === 'idle') {
      ctx.save();
      ctx.globalAlpha = 0.16;
      drawChallengeAt(noteX + W * 0.36, nextChallenge, false);
      ctx.restore();
    }
  }

  function drawChallengeAt(x, ch, isActive) {
    const notes = ch.notes;
    const step  = ch.step || 0;

    // Parentesi verticale a sinistra per accordi
    if (isActive && notes.length > 1) {
      const topY = staffYOf(notes[notes.length - 1]) - lineGap * 0.3;
      const botY = staffYOf(notes[0]) + lineGap * 0.3;
      const bx   = x - lineGap * 1.9;
      ctx.save();
      ctx.strokeStyle = PAL.gold;
      ctx.lineWidth   = Math.max(1, lineGap * 0.07);
      ctx.lineCap     = 'round';
      ctx.globalAlpha = 0.55;
      // Staffa
      ctx.beginPath();
      ctx.moveTo(bx + lineGap * 0.22, topY);
      ctx.lineTo(bx, topY);
      ctx.lineTo(bx, botY);
      ctx.lineTo(bx + lineGap * 0.22, botY);
      ctx.stroke();
      // Freccina ascendente (arpeggio dal basso)
      ctx.beginPath();
      ctx.moveTo(bx - lineGap * 0.16, botY + lineGap * 0.05);
      ctx.lineTo(bx, botY - lineGap * 0.3);
      ctx.lineTo(bx + lineGap * 0.16, botY + lineGap * 0.05);
      ctx.stroke();
      ctx.restore();
    }

    for (let i = 0; i < notes.length; i++) {
      const midi = notes[i];
      let state;
      if (!isActive)     { state = 'preview'; }
      else if (i < step) { state = 'done'; }
      else if (i === step) { state = 'current'; }
      else               { state = 'pending'; }

      // Offset x per note adiacenti (evita sovrapposizione capotasti vicini)
      const diatDist = i > 0
        ? Math.abs(diatonicIndex(notes[i]) - diatonicIndex(notes[i-1]))
        : 0;
      const xOff = (diatDist <= 1 && i > 0) ? lineGap * 1.1 : 0;

      drawNoteSymbol(x + xOff, midi, state);
    }
  }

  function drawNoteSymbol(x, midi, state) {
    const y  = staffYOf(midi);
    const r  = lineGap * 0.44;
    const rx = r * 1.4;
    const pc = ((midi % 12) + 12) % 12;

    let color, alpha;
    switch (state) {
      case 'current': color = PAL.note;   alpha = 1;    break;
      case 'done':    color = PAL.inkDim; alpha = 0.38; break;
      case 'pending': color = PAL.note;   alpha = 0.32; break;
      default:        color = PAL.inkDim; alpha = 1;    break; // preview
    }

    drawLedgerLines(x, midi);

    ctx.save();
    ctx.globalAlpha *= alpha;

    if (state === 'current') {
      ctx.shadowColor = PAL.note;
      ctx.shadowBlur  = lineGap * (0.65 + Math.sin(frameN * 0.14) * 0.28);
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, r, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Gambo
    const midStaffY = staffY - lineGap * 2;
    ctx.strokeStyle = color;
    ctx.lineWidth   = lineGap * 0.13;
    ctx.lineCap     = 'round';
    ctx.beginPath();
    if (y > midStaffY) {
      ctx.moveTo(x + rx * 0.82, y - r * 0.3);
      ctx.lineTo(x + rx * 0.82, y - lineGap * 3.6);
    } else {
      ctx.moveTo(x - rx * 0.82, y + r * 0.3);
      ctx.lineTo(x - rx * 0.82, y + lineGap * 3.6);
    }
    ctx.stroke();

    // Diesis
    if (PC_ACC[pc] === 1) {
      ctx.fillStyle = PAL.gold;
      ctx.font      = `${lineGap * 1.3}px Georgia, serif`;
      ctx.textAlign = 'right';
      ctx.fillText('♯', x - rx - lineGap * 0.28, y + lineGap * 0.4);
    }
    ctx.restore();

    // Spunta su note già suonate
    if (state === 'done') {
      ctx.save();
      ctx.fillStyle   = PAL.inkDim;
      ctx.globalAlpha = 0.45;
      ctx.font        = `${lineGap * 0.6}px Georgia, serif`;
      ctx.textAlign   = 'center';
      ctx.fillText('✓', x + rx + lineGap * 0.55, y + lineGap * 0.22);
      ctx.restore();
    }

    // Nome nota corrente (piccolo, sotto il rigo)
    if (state === 'current') {
      const oct  = Math.floor(midi / 12) - 1;
      const name = NOTE_NAMES_IT[pc] + oct;
      ctx.save();
      ctx.fillStyle   = PAL.inkDim;
      ctx.globalAlpha = 0.7;
      ctx.font        = `${lineGap * 0.68}px 'Courier New', monospace`;
      ctx.textAlign   = 'center';
      ctx.fillText(name, x, staffY + lineGap * 2.4);
      ctx.restore();
    }
  }

  function drawLedgerLines(x, midi) {
    const y    = staffYOf(midi);
    const topY = staffY - lineGap * 4;
    const half = lineGap / 2;
    const lw   = lineGap * 1.55;
    ctx.strokeStyle = PAL.staff;
    ctx.lineWidth   = Math.max(1, lineGap * 0.075);
    for (let ly = staffY + lineGap; ly <= y + half - 1; ly += lineGap) {
      ctx.beginPath(); ctx.moveTo(x - lw, ly); ctx.lineTo(x + lw, ly); ctx.stroke();
    }
    for (let ly = topY - lineGap; ly >= y - half + 1; ly -= lineGap) {
      ctx.beginPath(); ctx.moveTo(x - lw, ly); ctx.lineTo(x + lw, ly); ctx.stroke();
    }
  }

  function drawPopups() {
    for (const p of popups) {
      const ease = 1 - (1 - p.t) * (1 - p.t);
      const yOff = ease * lineGap * 3;
      const a    = p.t < 0.55 ? 1 : 1 - (p.t - 0.55) / 0.45;
      ctx.save();
      ctx.globalAlpha = Math.max(0, a);
      ctx.fillStyle   = p.color;
      ctx.font        = `bold ${lineGap * 0.85}px 'Courier New', monospace`;
      ctx.textAlign   = 'center';
      ctx.fillText(p.text, p.x, p.y - yOff);
      ctx.restore();
    }
  }

  function drawHud() {
    const fs = lineGap * 0.70;

    // Punteggio (in alto a sinistra)
    ctx.save();
    ctx.font      = `${fs}px 'Courier New', monospace`;
    ctx.fillStyle = PAL.gold;
    ctx.textAlign = 'left';
    ctx.fillText(String(score), W * 0.06, fs * 1.5);

    // Livello (sotto lo score, dal livello 1 in poi)
    if (noteIndex >= 10) {
      const lv = Math.min(4, Math.floor((noteIndex - 10) / 10)) + 1;
      ctx.font      = `${fs * 0.68}px 'Courier New', monospace`;
      ctx.fillStyle = PAL.inkDim;
      ctx.fillText('lv ' + lv, W * 0.06, fs * 2.5);
    }
    ctx.restore();

    // Errori (in alto a destra)
    if (errorCount > 0) {
      ctx.save();
      ctx.font      = `${fs}px 'Courier New', monospace`;
      ctx.fillStyle = PAL.err;
      ctx.textAlign = 'right';
      ctx.fillText(errorCount + ' ✗', W * 0.94, fs * 1.5);
      ctx.restore();
    }
  }

  function drawListeningDot() {
    const pulse = 0.5 + 0.5 * Math.sin(frameN * 0.1);
    ctx.save();
    ctx.fillStyle   = PAL.staff;
    ctx.globalAlpha = 0.3 + pulse * 0.4;
    ctx.beginPath();
    ctx.arc(W / 2, staffY - lineGap * 2, lineGap * 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /* ====================================================================
     (6) LOOP PRINCIPALE
     ==================================================================== */

  let rafId   = null;
  let lastTs  = 0;
  let running = false;

  function loop(ts) {
    if (!running) return;
    const dt = Math.min(0.05, (ts - lastTs) / 1000 || 0);
    lastTs = ts;
    pollAudio();
    updateGame(dt);
    render();
    rafId = requestAnimationFrame(loop);
  }

  function startLoop() {
    if (running) return;
    running = true;
    lastTs  = performance.now();
    rafId   = requestAnimationFrame(loop);
  }

  function stopLoop() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  /* ====================================================================
     (7) DOM
     ==================================================================== */

  let elStart, elStartBtn;
  let elCalib, elCalibText;
  let elGameOver, elRestartBtn, elFinalScore, elFinalErrors, elFinalAcc;
  let elGameBar, elExitBtn;
  let initialized = false;

  function resetToStart() {
    stopLoop();
    releaseMic();
    gameState = 'idle';
    if (elGameOver) elGameOver.classList.add('hidden');
    if (elGameBar)  elGameBar.classList.add('hidden');
    if (elCalib)    elCalib.classList.add('hidden');
    if (elStart)    elStart.classList.remove('hidden');
    if (elStartBtn) { elStartBtn.disabled = false; elStartBtn.textContent = 'Inizia'; }
    render();
  }

  function stopPianoforte() {
    resetToStart();
  }
  window.stopPianoforte = stopPianoforte;

  /* ====================================================================
     (8) HTML INJECTION
     ==================================================================== */

  function creaPianoforte() {
    const el = document.getElementById('pianoforte');
    if (!el) return;
    el.innerHTML = `
      <div id="pianoApp">
        <canvas id="gameCanvas"></canvas>

        <div id="gameBar" class="pf-gamebar hidden">
          <button id="exitBtn" class="pf-iconbtn" aria-label="Pausa / risultati">✕</button>
        </div>

        <!-- START -->
        <div id="startScreen" class="pf-overlay">
          <p class="pf-eyebrow">Sala 131 · il Pianoforte</p>
          <h1 class="pf-title">Il Direttore</h1>
          <div class="pf-rule"></div>
          <p class="pf-subtitle">Leggi le note sul pentagramma<br>e suonale al pianoforte.</p>
          <button id="startBtn" class="pf-bigBtn">Inizia</button>
          <p class="pf-hint">Tieni il telefono vicino al pianoforte.<br>Useremo il microfono.</p>
          <button class="pf-back" onclick="if(window.stopPianoforte)window.stopPianoforte();mostraPagina('menu')">Torna indietro</button>
        </div>

        <!-- CALIBRAZIONE -->
        <div id="calibScreen" class="pf-overlay hidden">
          <p class="pf-eyebrow">Accordatura ambiente</p>
          <p id="calibText" class="pf-title pf-title--sm">Silenzio…</p>
          <div class="pf-rule"></div>
          <p class="pf-subtitle">Non fare rumori.<br>Stiamo misurando il rumore di fondo.</p>
        </div>

        <!-- RIEPILOGO -->
        <div id="gameOverScreen" class="pf-overlay hidden">
          <p class="pf-eyebrow">Fine del concerto</p>
          <h2 class="pf-title pf-title--sm">Sipario</h2>
          <div class="pf-rule"></div>
          <div class="pf-statsGrid">
            <div class="pf-stat">
              <span class="pf-statVal pf-statVal--gold" id="finalScore">0</span>
              <span class="pf-statLbl">punti</span>
            </div>
            <div class="pf-stat">
              <span class="pf-statVal" id="finalAcc">—</span>
              <span class="pf-statLbl">precisione</span>
            </div>
            <div class="pf-stat">
              <span class="pf-statVal pf-statVal--err" id="finalErrors">0</span>
              <span class="pf-statLbl">errori</span>
            </div>
          </div>
          <div class="pf-btnRow">
            <button id="restartBtn" class="pf-bigBtn">Da capo</button>
          </div>
          <button class="pf-back" onclick="if(window.stopPianoforte)window.stopPianoforte();mostraPagina('menu')">Torna al menu</button>
        </div>
      </div>
    `;
  }
  window.creaPianoforte = creaPianoforte;

  function cacheElements() {
    canvas        = document.getElementById('gameCanvas');
    if (!canvas) return false;
    ctx           = canvas.getContext('2d');
    elStart       = document.getElementById('startScreen');
    elStartBtn    = document.getElementById('startBtn');
    elCalib       = document.getElementById('calibScreen');
    elCalibText   = document.getElementById('calibText');
    elGameOver    = document.getElementById('gameOverScreen');
    elRestartBtn  = document.getElementById('restartBtn');
    elFinalScore  = document.getElementById('finalScore');
    elFinalErrors = document.getElementById('finalErrors');
    elFinalAcc    = document.getElementById('finalAcc');
    elGameBar     = document.getElementById('gameBar');
    elExitBtn     = document.getElementById('exitBtn');
    return true;
  }

  async function onStartTap() {
    elStartBtn.disabled    = true;
    elStartBtn.textContent = 'Un momento…';
    const ok = await initAudio();
    if (!ok) {
      elStartBtn.disabled    = false;
      elStartBtn.textContent = 'Inizia';
      return;
    }
    elStart.classList.add('hidden');
    startLoop();
    startCalibration();
  }

  /* ====================================================================
     PUNTO DI INGRESSO
     ==================================================================== */

  function avviaPianoforteInit() {
    if (!document.getElementById('gameCanvas')) creaPianoforte();
    if (!cacheElements()) return;

    resizeCanvas();

    if (!initialized) {
      window.addEventListener('resize', resizeCanvas);
      window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 200));
      initialized = true;
    }

    if (elStartBtn)   elStartBtn.onclick   = onStartTap;
    if (elRestartBtn) elRestartBtn.onclick = () => {
      elGameOver.classList.add('hidden');
      startLoop();        // riavvia il loop (era stato fermato da showSummary)
      startCalibration();
    };
    if (elExitBtn) elExitBtn.onclick = () => {
      if (gameState === 'playing') {
        showSummary(); // mostra riepilogo senza perdere lo stato
      } else {
        resetToStart();
        mostraPagina('menu');
      }
    };

    resetToStart(); // stato pulito all'entrata (anche se si torna dalla stessa pagina)
  }
  window.avviaPianoforteInit = avviaPianoforteInit;

})();
