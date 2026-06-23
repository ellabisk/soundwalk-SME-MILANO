/* =====================================================================
   SOUNDWALK — SALA 131 · IL PIANOFORTE
   Algoritmo: YIN pitch detection + threshold-crossing onset.
   Modalità: Direttore (nota ferma sul pentagramma, la suoni per avanzare).
   ===================================================================== */

(function () {
  'use strict';

  /* ====================================================================
     (0) COSTANTI — modifica qui dopo il test sul piano vero
     ==================================================================== */

  const YIN_THRESH    = 0.12;   // soglia CMNDF (0.10 = più strict, 0.15 = più permissivo)
  const FMIN          = 70;     // Hz minimo cercato
  const FMAX          = 1400;   // Hz massimo cercato
  const STABLE_FRAMES = 3;      // frame consecutivi sulla stessa nota prima di registrarla
  const REFRACTORY_MS = 300;    // ms minimi tra un onset e il successivo
  const ONSET_WINDOW  = 400;    // ms: finestra entro cui aspettarsi stabilità dopo onset
  const CALIB_MS      = 2000;   // durata calibrazione silenzio (ms)
  const CALIB_MULT    = 2.5;    // soglia = rumore_max × CALIB_MULT
  const CALIB_MIN     = 0.005;  // soglia minima assoluta
  const CALIB_MAX     = 0.05;   // soglia massima assoluta

  /* ====================================================================
     PALETTE E NOTE
     ==================================================================== */

  const PAL = {
    bg:     '#0d1b2a',
    bg2:    '#13243a',
    staff:  '#5a7a99',
    note:   '#7fd4e8',
    ink:    '#e8dcc0',
    inkDim: '#9a8f76',
    gold:   '#d4a843',
    err:    '#c1666b',
    accent: '#b794d4',
  };

  const NOTE_NAMES_IT = ['DO','DO#','RE','RE#','MI','FA','FA#','SOL','SOL#','LA','LA#','SI'];
  const WHITE_MIDIS   = [60,62,64,65,67,69,71,72,74,76,77,79,81,83]; // DO4..SI5

  const TREBLE_BOTTOM_MIDI = 64; // E4 = linea inferiore del rigo

  // pitch class → step diatonico (0=C..6=B) e accidentale
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

  // onset state
  let wasQuiet      = true;
  let lastOnsetMs   = -9999;
  let stableMidi    = -1;
  let stableCount   = 0;
  let onsetPending  = false;
  let onsetPendMs   = 0;
  let pendingNote   = null; // nota confermata, consumata dal game loop

  function rmsLast(buf, n) {
    const start = Math.max(0, buf.length - n);
    let s = 0;
    for (let i = start; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / (buf.length - start));
  }

  function freqToMidi(f) { return 12 * Math.log2(f / 440) + 69; }

  // YIN — de Cheveigné & Kawahara (2002)
  function yin(buf, sr) {
    const N  = buf.length;
    const W  = Math.floor(N / 2);
    const t1 = Math.ceil(sr / FMAX);
    const t2 = Math.min(W - 1, Math.floor(sr / FMIN));

    // Funzione di differenza
    const d = new Float32Array(t2 + 1);
    for (let tau = 1; tau <= t2; tau++) {
      let sum = 0;
      for (let j = 0; j < W; j++) {
        const x = buf[j] - buf[j + tau];
        sum += x * x;
      }
      d[tau] = sum;
    }

    // CMNDF (Cumulative Mean Normalized Difference Function)
    const cmnd = new Float32Array(t2 + 1);
    cmnd[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= t2; tau++) {
      run += d[tau];
      cmnd[tau] = run > 0 ? (d[tau] * tau) / run : 1;
    }

    // Primo dip sotto la soglia
    for (let tau = t1; tau <= t2; tau++) {
      if (cmnd[tau] < YIN_THRESH) {
        while (tau + 1 <= t2 && cmnd[tau + 1] < cmnd[tau]) tau++;
        let ft = tau;
        if (tau > 1 && tau < t2) {
          const a = cmnd[tau-1], b = cmnd[tau], c = cmnd[tau+1];
          const den = a - 2*b + c;
          if (Math.abs(den) > 1e-12) ft = tau + 0.5 * (a - c) / den;
        }
        return { freq: sr / ft, clarity: 1 - cmnd[tau] };
      }
    }

    // Nessun dip: ritorna il minimo nel range (bassa confidence)
    let bt = t1, bv = cmnd[t1];
    for (let t = t1 + 1; t <= t2; t++) { if (cmnd[t] < bv) { bv = cmnd[t]; bt = t; } }
    return { freq: sr / bt, clarity: 1 - bv };
  }

  function pollAudio() {
    if (!analyser) return;
    analyser.getFloatTimeDomainData(timeBuf);

    const rms    = rmsLast(timeBuf, 512); // ultimi ~11ms
    const isLoud = rms >= RMS_THRESH;
    const now    = performance.now();

    // Durante calibrazione: solo raccolta rumore, niente onset
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
    if (wasQuiet && (now - lastOnsetMs) > REFRACTORY_MS) {
      onsetPending = true;
      onsetPendMs  = now;
      stableMidi   = -1;
      stableCount  = 0;
    }
    wasQuiet = false;

    // Pitch detection
    const { freq } = yin(timeBuf, sampleRate);
    if (freq <= 0) return;

    const midi = Math.round(freqToMidi(freq));

    if (onsetPending) {
      if (now - onsetPendMs > ONSET_WINDOW) {
        // Finestra scaduta
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
      src.connect(analyser); // NON a destination → niente feedback
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
  let staffY  = 0; // linea inferiore del rigo (px)
  let lineGap = 0; // distanza tra le linee (px)
  let noteX   = 0; // posizione x della nota corrente

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

  let gameState   = 'idle'; // idle | calibrating | playing | gameover
  let score       = 0;
  let lives       = 3;
  let currentNote = null;   // { midi }
  let nextNote    = null;   // anteprima nota successiva

  // Animazione scorrimento nota
  // type: 'in' (arriva da destra) | 'idle' | 'out' (esce a sinistra)
  let anim     = null;
  let flashErr = 0;
  let frameN   = 0;

  const ANIM_DUR = 0.22; // secondi

  function randomNote() {
    return { midi: WHITE_MIDIS[Math.floor(Math.random() * WHITE_MIDIS.length)] };
  }

  function beginPlaying() {
    gameState   = 'playing';
    score       = 0;
    lives       = 3;
    flashErr    = 0;
    pendingNote = null;
    wasQuiet    = true;
    onsetPending = false;
    stableMidi  = -1; stableCount = 0;
    currentNote = randomNote();
    nextNote    = randomNote();
    anim        = { type: 'in', t: 0 };
    if (elGameBar) elGameBar.classList.remove('hidden');
  }

  function onNoteDetected(midi) {
    if (gameState !== 'playing') return;
    if (anim && anim.type !== 'idle') return; // aspetta fine animazione

    if (midi === currentNote.midi) {
      score++;
      anim = { type: 'out', t: 0 };
    } else {
      lives--;
      flashErr = 1;
      if (lives <= 0) endGame();
    }
  }

  function updateGame(dt) {
    if (gameState !== 'playing') return;

    if (flashErr > 0) flashErr = Math.max(0, flashErr - dt / 0.3);

    if (anim && anim.type !== 'idle') {
      anim.t += dt / ANIM_DUR;
      if (anim.t >= 1) {
        if (anim.type === 'out') {
          currentNote = nextNote;
          nextNote    = randomNote();
          anim        = { type: 'in', t: 0 };
        } else {
          anim = { type: 'idle', t: 1 };
        }
      }
    }

    if (pendingNote) {
      onNoteDetected(pendingNote.midi);
      pendingNote = null;
    }
  }

  function endGame() {
    gameState = 'gameover';
    if (elGameBar)   elGameBar.classList.add('hidden');
    if (elFinalScore) elFinalScore.textContent = String(score);
    if (elGameOver)  elGameOver.classList.remove('hidden');
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
      drawCurrentNote();
      drawHud();
      if (flashErr > 0) {
        ctx.fillStyle = `rgba(193,102,107,${(flashErr * 0.28).toFixed(3)})`;
        ctx.fillRect(0, 0, W, H);
      }
    } else if (gameState === 'calibrating') {
      // Pentagramma visibile ma nota assente — feedback visivo "ascolto"
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

  function drawCurrentNote() {
    if (!currentNote || !anim) return;

    const p = Math.min(1, anim.t);
    let x = noteX, alpha = 1;

    if (anim.type === 'out') {
      // ease in: accelera verso sinistra
      const ease = p * p;
      x     = noteX - ease * W * 0.55;
      alpha = 1 - p;
    } else if (anim.type === 'in') {
      // ease out: decelera arrivando al centro
      const ease = 1 - (1 - p) * (1 - p);
      x     = noteX + (1 - ease) * W * 0.42;
      alpha = ease;
    }

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    drawNoteSymbol(x, currentNote.midi, true);
    ctx.restore();

    // Anteprima prossima nota (semitrasparente, a destra)
    if (nextNote && anim.type === 'idle') {
      ctx.save();
      ctx.globalAlpha = 0.16;
      drawNoteSymbol(noteX + W * 0.36, nextNote.midi, false);
      ctx.restore();
    }
  }

  function drawNoteSymbol(x, midi, isTarget) {
    const y   = staffYOf(midi);
    const r   = lineGap * 0.44;
    const rx  = r * 1.4;
    const pc  = ((midi % 12) + 12) % 12;

    drawLedgerLines(x, midi);

    ctx.save();
    if (isTarget) {
      const pulse = lineGap * (0.65 + Math.sin(frameN * 0.14) * 0.28);
      ctx.shadowColor = PAL.note;
      ctx.shadowBlur  = pulse;
    }
    ctx.fillStyle = isTarget ? PAL.note : PAL.inkDim;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, r, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Gambo
    const midY = staffY - lineGap * 2;
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth   = lineGap * 0.13;
    ctx.lineCap     = 'round';
    ctx.beginPath();
    if (y > midY) {
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

    // Nome nota (piccolo, sotto il rigo)
    if (isTarget) {
      const oct  = Math.floor(midi / 12) - 1;
      const name = NOTE_NAMES_IT[pc] + oct;
      ctx.save();
      ctx.fillStyle   = PAL.inkDim;
      ctx.font        = `${lineGap * 0.7}px 'Courier New', monospace`;
      ctx.textAlign   = 'center';
      ctx.globalAlpha = 0.7;
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

  function drawHud() {
    const fs = lineGap * 0.72;
    ctx.font      = `${fs}px 'Courier New', monospace`;
    ctx.fillStyle = PAL.inkDim;

    // Punteggio
    ctx.textAlign = 'left';
    ctx.fillText(score + (score === 1 ? ' battuta' : ' battute'), W * 0.06, fs * 1.3);

    // Vite (♪ = vita)
    ctx.font = `${lineGap * 0.88}px Georgia, serif`;
    let lx = W * 0.94;
    for (let i = 2; i >= 0; i--) {
      ctx.fillStyle = i < lives ? PAL.accent : 'rgba(90,122,153,0.22)';
      ctx.textAlign = 'right';
      ctx.fillText('♪', lx, lineGap * 0.92);
      lx -= lineGap;
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

  let rafId    = null;
  let lastTs   = 0;
  let running  = false;

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
     (7) DOM — elementi e pulizia
     ==================================================================== */

  let elStart, elStartBtn;
  let elCalib, elCalibText;
  let elGameOver, elRestartBtn, elFinalScore;
  let elGameBar, elExitBtn;
  let initialized = false;

  function stopPianoforte() {
    stopLoop();
    releaseMic();
    gameState = 'idle';
    if (elGameOver) elGameOver.classList.add('hidden');
    if (elGameBar)  elGameBar.classList.add('hidden');
    if (elCalib)    elCalib.classList.add('hidden');
    if (elStart)    elStart.classList.remove('hidden');
    if (elStartBtn) { elStartBtn.disabled = false; elStartBtn.textContent = 'Inizia'; }
  }
  window.stopPianoforte = stopPianoforte;

  /* ====================================================================
     (8) HTML INJECTION — chiamata dal router
     ==================================================================== */

  function creaPianoforte() {
    const el = document.getElementById('pianoforte');
    if (!el) return;
    el.innerHTML = `
      <div id="pianoApp">
        <canvas id="gameCanvas"></canvas>

        <div id="gameBar" class="pf-gamebar hidden">
          <button id="exitBtn" class="pf-iconbtn" aria-label="Esci">✕</button>
        </div>

        <div id="startScreen" class="pf-overlay">
          <p class="pf-eyebrow">Sala 131 · il Pianoforte</p>
          <h1 class="pf-title">Il Direttore</h1>
          <div class="pf-rule"></div>
          <p class="pf-subtitle">Leggi le note sul pentagramma<br>e suonale al pianoforte.</p>
          <button id="startBtn" class="pf-bigBtn">Inizia</button>
          <p class="pf-hint">Tieni il telefono orizzontale vicino al pianoforte.<br>Useremo il microfono.</p>
          <button class="pf-back" onclick="if(window.stopPianoforte)window.stopPianoforte();mostraPagina('menu')">Torna indietro</button>
        </div>

        <div id="calibScreen" class="pf-overlay hidden">
          <p class="pf-eyebrow">Accordatura</p>
          <p id="calibText" class="pf-title pf-title--sm">Silenzio…</p>
          <div class="pf-rule"></div>
          <p class="pf-subtitle">Non fare rumori.<br>Stiamo misurando il rumore di fondo.</p>
        </div>

        <div id="gameOverScreen" class="pf-overlay hidden">
          <p class="pf-eyebrow">Fine del concerto</p>
          <h2 class="pf-title pf-title--sm">Sipario</h2>
          <div class="pf-rule"></div>
          <p class="pf-subtitle">
            <span id="finalScore" class="pf-finalNum">0</span><br>
            battute dirette
          </p>
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
    canvas       = document.getElementById('gameCanvas');
    if (!canvas) return false;
    ctx          = canvas.getContext('2d');
    elStart      = document.getElementById('startScreen');
    elStartBtn   = document.getElementById('startBtn');
    elCalib      = document.getElementById('calibScreen');
    elCalibText  = document.getElementById('calibText');
    elGameOver   = document.getElementById('gameOverScreen');
    elRestartBtn = document.getElementById('restartBtn');
    elFinalScore = document.getElementById('finalScore');
    elGameBar    = document.getElementById('gameBar');
    elExitBtn    = document.getElementById('exitBtn');
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
    startLoop();        // avvia il loop (render + pollAudio)
    startCalibration(); // cambia gameState → calibrating
  }

  /* ====================================================================
     PUNTO DI INGRESSO — chiamato dal router ogni volta che si entra
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
      startCalibration();
    };
    if (elExitBtn) elExitBtn.onclick = () => {
      if (window.stopPianoforte) window.stopPianoforte();
      mostraPagina('menu');
    };

    stopPianoforte(); // stato pulito alla (ri)entrata
    render();         // disegna lo sfondo anche prima di iniziare
  }
  window.avviaPianoforteInit = avviaPianoforteInit;

})();
