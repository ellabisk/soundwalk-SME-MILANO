/* =====================================================================
   SOUNDWALK — SALA 131 · IL PIANOFORTE
   YIN pitch detection + threshold-crossing onset.
   Modalità RANKED : 20 sfide (10 note + 10 accordi fino alle settime).
   Modalità FREE   : infinito, solo tempo medio a nota.
   ===================================================================== */

(function () {
  'use strict';

  /* ====================================================================
     (0) COSTANTI
     ==================================================================== */

  const YIN_THRESH        = 0.12;
  const FMIN              = 70;
  const FMAX              = 1400;
  const STABLE_FRAMES     = 3;
  const REFRACTORY_MS     = 300;
  const ONSET_WINDOW      = 400;
  const ERROR_COOLDOWN_MS = 1500;
  const CALIB_MS          = 2000;
  const CALIB_MULT        = 2.5;
  const CALIB_MIN         = 0.005;
  const CALIB_MAX         = 0.05;
  const RANKED_CHALLENGES = 20;
  const MAX_SPEED_SEC     = 8;

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
  const WHITE_MIDIS   = [60,62,64,65,67,69,71,72,74,76,77,79,81,83];

  const TREBLE_BOTTOM_MIDI = 64;
  const PC_STEP = [0,0,1,1,2,3,3,4,4,5,5,6];
  const PC_ACC  = [0,1,0,1,0,0,1,0,1,0,1,0];

  function diatonicIndex(midi) {
    const pc  = ((midi % 12) + 12) % 12;
    const oct = Math.floor(midi / 12) - 1;
    return oct * 7 + PC_STEP[pc];
  }

  /* ====================================================================
     ACCORDI RANKED
     ==================================================================== */

  const CHORD_TYPES = [
    { label: 'triade magg.',  intervals: [4, 7]      }, // lv 0
    { label: 'triade min.',   intervals: [3, 7]      }, // lv 0
    { label: 'triade dim.',   intervals: [3, 6]      }, // lv 1
    { label: 'sus4',          intervals: [5, 7]      }, // lv 1
    { label: 'sesta agg.',    intervals: [4, 7, 9]   }, // lv 2
    { label: 'min 7ª',       intervals: [3, 7, 10]  }, // lv 2
    { label: '7ª dom.',      intervals: [4, 7, 10]  }, // lv 3
    { label: '7ª magg.',     intervals: [4, 7, 11]  }, // lv 3
    { label: '7ª dim.',      intervals: [3, 6,  9]  }, // lv 4
    { label: '½ dim.',       intervals: [3, 6, 10]  }, // lv 4
  ];

  function buildRankedChord(typeIdx) {
    const { intervals } = CHORD_TYPES[typeIdx];
    // Radice max G4 (67) → nota top max F5 (77, +10 semitoni)
    const roots = WHITE_MIDIS.filter(m => m >= 60 && m <= 67);
    const root  = roots[Math.floor(Math.random() * roots.length)];
    return [root, ...intervals.map(i => root + i)].sort((a, b) => a - b);
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function generateRankedList() {
    const singles = Array.from({ length: 10 }, () => ({
      notes: [randomWhiteNote()], step: 0, chordLabel: null
    }));
    const chords = Array.from({ length: 10 }, (_, i) => ({
      notes: buildRankedChord(i), step: 0, chordLabel: CHORD_TYPES[i].label
    }));
    return shuffle([...singles, ...chords]);
  }

  /* ====================================================================
     (1) AUDIO — YIN
     ==================================================================== */

  let audioCtx  = null;
  let analyser  = null;
  let micStream = null;
  let timeBuf   = null;
  let sampleRate = 44100;
  let RMS_THRESH = 0.010;

  let wasQuiet         = true;
  let lastOnsetMs      = -9999;
  let postErrorUntilMs = -9999;
  let stableMidi       = -1;
  let stableCount      = 0;
  let onsetPending     = false;
  let onsetPendMs      = 0;
  let pendingNote      = null;

  function rmsLast(buf, n) {
    const start = Math.max(0, buf.length - n);
    let s = 0;
    for (let i = start; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / (buf.length - start));
  }

  function freqToMidi(f) { return 12 * Math.log2(f / 440) + 69; }

  function yin(buf, sr) {
    const N  = buf.length;
    const W  = Math.floor(N / 2);
    const t1 = Math.ceil(sr / FMAX);
    const t2 = Math.min(W - 1, Math.floor(sr / FMIN));
    const d  = new Float32Array(t2 + 1);
    for (let tau = 1; tau <= t2; tau++) {
      let sum = 0;
      for (let j = 0; j < W; j++) { const x = buf[j] - buf[j+tau]; sum += x*x; }
      d[tau] = sum;
    }
    const cmnd = new Float32Array(t2 + 1);
    cmnd[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= t2; tau++) {
      run += d[tau];
      cmnd[tau] = run > 0 ? (d[tau]*tau)/run : 1;
    }
    for (let tau = t1; tau <= t2; tau++) {
      if (cmnd[tau] < YIN_THRESH) {
        while (tau+1 <= t2 && cmnd[tau+1] < cmnd[tau]) tau++;
        let ft = tau;
        if (tau > 1 && tau < t2) {
          const a=cmnd[tau-1], b=cmnd[tau], c=cmnd[tau+1];
          const den = a-2*b+c;
          if (Math.abs(den) > 1e-12) ft = tau + 0.5*(a-c)/den;
        }
        return { freq: sr/ft };
      }
    }
    let bt=t1, bv=cmnd[t1];
    for (let t=t1+1; t<=t2; t++) { if (cmnd[t]<bv) { bv=cmnd[t]; bt=t; } }
    return { freq: sr/bt };
  }

  function pollAudio() {
    if (!analyser || gameState === 'paused') return;
    analyser.getFloatTimeDomainData(timeBuf);
    const rms  = rmsLast(timeBuf, 512);
    const isLoud = rms >= RMS_THRESH;
    const now  = performance.now();

    if (gameState === 'calibrating') { calibSamples.push(rms); wasQuiet = true; return; }
    if (!isLoud) { wasQuiet = true; pendingNote = null; return; }

    if (wasQuiet && (now - lastOnsetMs) > REFRACTORY_MS && now > postErrorUntilMs) {
      onsetPending = true; onsetPendMs = now; stableMidi = -1; stableCount = 0;
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
          onsetPending = false; lastOnsetMs = now; pendingNote = { midi };
        }
      }
    }
  }

  async function initAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      if (!micStream) {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false }
        });
      }
      sampleRate = audioCtx.sampleRate;
      analyser   = audioCtx.createAnalyser();
      analyser.fftSize = 4096;
      timeBuf    = new Float32Array(analyser.fftSize);
      audioCtx.createMediaStreamSource(micStream).connect(analyser);
      return true;
    } catch(e) { alert('Permesso microfono negato: '+e.message); return false; }
  }

  function releaseMic() {
    if (micStream) { micStream.getTracks().forEach(t=>t.stop()); micStream=null; }
    analyser = null;
    if (audioCtx) { audioCtx.close().catch(()=>{}); audioCtx=null; }
  }

  /* ====================================================================
     (2) CALIBRAZIONE
     ==================================================================== */

  let calibSamples = [];
  let tuningNote = null, tuningTimer = null;

  function startCalibration() {
    gameState='calibrating'; calibSamples=[]; wasQuiet=true;
    if (elCalib) elCalib.classList.remove('hidden');
    let t = Math.ceil(CALIB_MS/1000);
    updateCalibText(t);
    const iv = setInterval(() => {
      t--; if (t>0) updateCalibText(t); else { clearInterval(iv); finishCalibration(); }
    }, 1000);
  }

  function updateCalibText(s) { if (elCalibText) elCalibText.textContent = 'Silenzio… '+s; }

  function finishCalibration() {
    if (calibSamples.length > 0) {
      const maxN = Math.max(...calibSamples);
      const avgN = calibSamples.reduce((a,b)=>a+b,0)/calibSamples.length;
      RMS_THRESH = Math.max(maxN*CALIB_MULT, avgN*4, CALIB_MIN);
      RMS_THRESH = Math.min(RMS_THRESH, CALIB_MAX);
    }
    if (elCalib) elCalib.classList.add('hidden');
    startTuning();
  }

  function startTuning() {
    gameState = 'tuning';
    wasQuiet = true; pendingNote = null; tuningNote = null;
    // auto-avanza dopo 5s se nessuna nota rilevata
    tuningTimer = setTimeout(beginPlaying, 5000);
  }

  /* ====================================================================
     (3) CANVAS
     ==================================================================== */

  let canvas, ctx;
  let W=0, H=0, DPR=1;
  let staffY=0, lineGap=0, noteX=0;

  function resizeCanvas() {
    if (!canvas) return;
    DPR = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    W = rect.width  || window.innerWidth;
    H = rect.height || window.innerHeight;
    canvas.width  = Math.round(W*DPR);
    canvas.height = Math.round(H*DPR);
    ctx.setTransform(DPR,0,0,DPR,0,0);
    ctx.imageSmoothingEnabled = false;
    // Ottimizzato per telefono orizzontale — note contenute nel viewport
    lineGap = Math.max(18, Math.round(H * 0.09));
    staffY  = Math.round(H * 0.46);
    noteX   = Math.round(W * 0.56);
  }

  function staffYOf(midi) {
    const steps = diatonicIndex(midi) - diatonicIndex(TREBLE_BOTTOM_MIDI);
    return staffY - steps*(lineGap/2);
  }

  /* ====================================================================
     (4) STATO DI GIOCO
     ==================================================================== */

  let gameState  = 'idle';   // idle | calibrating | playing | paused | finishing | gameover
  let gameMode   = 'free';

  let challengeList = [];
  let challengeIdx  = 0;
  let freeNotesDone = 0;

  let challenge     = null;
  let nextChallenge = null;
  let errorCount    = 0;
  let score         = 0;
  let noteStartTime = 0;
  let totalNoteTimeSec = 0;
  let notesCorrect  = 0;
  let totalNotes    = 0;

  let anim     = null;
  let flashErr = 0;
  let frameN   = 0;
  let popups   = [];

  const ANIM_DUR = 0.22;

  const FREE_INTERVAL_POOL = [
    [3,4,5],[3,4,5,7],[3,4,5,7,8,9],[3,4,5,7,8,9,12],
    [2,3,4,5,6,7,8,9,10,11,12]
  ];

  function randomWhiteNote() {
    // cap a F5 (77) per stare nel viewport landscape
    const pool = WHITE_MIDIS.filter(m => m <= 77);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function generateFreeChallenge(idx) {
    if (idx<10) return { notes:[randomWhiteNote()], step:0, chordLabel:null };
    const level    = Math.min(4, Math.floor((idx-10)/10));
    const chordProb = Math.min(0.75, 0.22+level*0.14);
    if (Math.random()>chordProb) return { notes:[randomWhiteNote()], step:0, chordLabel:null };
    const maxSize = Math.min(4,2+Math.floor(level/2));
    const size    = 2+Math.floor(Math.random()*(maxSize-1));
    const pool    = FREE_INTERVAL_POOL[level];
    const roots   = WHITE_MIDIS.filter(m=>m>=60&&m<=67);
    const root    = roots[Math.floor(Math.random()*roots.length)];
    const notes   = [root];
    for (let i=1; i<size; i++) {
      const iv = pool[Math.floor(Math.random()*pool.length)];
      const nx = notes[notes.length-1]+iv;
      if (nx<=77) notes.push(nx);
    }
    return { notes:notes.sort((a,b)=>a-b), step:0, chordLabel:null };
  }

  function beginPlaying() {
    gameState='playing'; score=0; errorCount=0; flashErr=0; popups=[];
    pendingNote=null; wasQuiet=true; onsetPending=false; stableMidi=-1; stableCount=0;
    postErrorUntilMs=-9999; totalNoteTimeSec=0; notesCorrect=0; totalNotes=0;
    if (gameMode==='ranked') {
      challengeList=generateRankedList(); challengeIdx=0;
      challenge=challengeList[0]; nextChallenge=challengeList[1]||null;
      totalNotes=challengeList.reduce((s,c)=>s+c.notes.length,0);
    } else {
      freeNotesDone=0; challenge=generateFreeChallenge(0); nextChallenge=generateFreeChallenge(1);
    }
    noteStartTime=performance.now(); anim={type:'in',t:0};
    if (elGameBar) elGameBar.classList.remove('hidden');
  }

  function onNoteDetected(midi) {
    if (gameState!=='playing') return;
    if (anim && anim.type!=='idle') return;
    const targetMidi = challenge.notes[challenge.step];
    const elapsed    = (performance.now()-noteStartTime)/1000;
    if (midi===targetMidi) {
      notesCorrect++; totalNoteTimeSec+=elapsed;
      const timeBonus = Math.max(0,Math.round(50*Math.max(0,1-elapsed/MAX_SPEED_SEC)));
      const pts = 50+timeBonus;
      score+=pts;
      spawnPopup('+'+pts, noteX, staffYOf(targetMidi)-lineGap*2.2, PAL.ok);
      challenge.step++; noteStartTime=performance.now();
      if (challenge.step>=challenge.notes.length) {
        if (gameMode==='ranked') {
          challengeIdx++;
          if (challengeIdx>=RANKED_CHALLENGES) { anim={type:'out',t:0}; gameState='finishing'; return; }
        } else { freeNotesDone++; }
        anim={type:'out',t:0};
      }
    } else {
      errorCount++; flashErr=1; postErrorUntilMs=performance.now()+ERROR_COOLDOWN_MS;
      spawnPopup('✗', noteX, staffYOf(targetMidi)-lineGap*2.2, PAL.err);
    }
  }

  function spawnPopup(text,x,y,color) { popups.push({text,x,y,t:0,color}); }

  function updateGame(dt) {
    if (gameState!=='playing' && gameState!=='finishing') return;
    if (flashErr>0) flashErr=Math.max(0,flashErr-dt/0.3);
    for (let i=popups.length-1; i>=0; i--) {
      popups[i].t+=dt/1.1; if (popups[i].t>=1) popups.splice(i,1);
    }
    if (anim && anim.type!=='idle') {
      anim.t+=dt/ANIM_DUR;
      if (anim.t>=1) {
        if (anim.type==='out') {
          if (gameState==='finishing') { showSummary(); return; }
          if (gameMode==='ranked') {
            challenge=challengeList[challengeIdx]; nextChallenge=challengeList[challengeIdx+1]||null;
          } else {
            challenge=nextChallenge; nextChallenge=generateFreeChallenge(freeNotesDone+1);
          }
          anim={type:'in',t:0};
        } else { anim={type:'idle',t:1}; noteStartTime=performance.now(); }
      }
    }
    if (pendingNote && gameState==='playing') { onNoteDetected(pendingNote.midi); pendingNote=null; }
  }

  function computeRankedScore() {
    const avgTime     = notesCorrect>0 ? totalNoteTimeSec/notesCorrect : MAX_SPEED_SEC;
    const accuracyPts = Math.round((notesCorrect/Math.max(1,totalNotes))*600);
    const speedPts    = Math.round(Math.max(0,1-avgTime/MAX_SPEED_SEC)*400);
    return { total:accuracyPts+speedPts, avgTime };
  }

  function showSummary() {
    gameState='gameover'; stopLoop();
    if (elGameBar) elGameBar.classList.add('hidden');
    if (elPauseScreen) elPauseScreen.classList.add('hidden');
    if (gameMode==='ranked') {
      const {total,avgTime} = computeRankedScore();
      const acc = Math.round((notesCorrect/Math.max(1,totalNotes))*100);
      if (elFinalScore)   elFinalScore.textContent   = String(total);
      if (elFinalAcc)     elFinalAcc.textContent     = acc+'%';
      if (elFinalAvgTime) elFinalAvgTime.textContent = avgTime.toFixed(1)+'s';
      if (elFinalErrors)  elFinalErrors.textContent  = String(errorCount);
      if (elSummaryRanked) elSummaryRanked.classList.remove('hidden');
      if (elSummaryFree)   elSummaryFree.classList.add('hidden');
    } else {
      const avgTime = notesCorrect>0 ? totalNoteTimeSec/notesCorrect : 0;
      if (elFreeNotes)  elFreeNotes.textContent  = String(freeNotesDone);
      if (elFreeAvg)    elFreeAvg.textContent    = avgTime.toFixed(1)+'s';
      if (elFreeErrors) elFreeErrors.textContent = String(errorCount);
      if (elSummaryFree)   elSummaryFree.classList.remove('hidden');
      if (elSummaryRanked) elSummaryRanked.classList.add('hidden');
    }
    if (elGameOver) elGameOver.classList.remove('hidden');
  }

  /* ====================================================================
     (5) RENDER
     ==================================================================== */

  function render() {
    if (!ctx) return;
    frameN++;
    drawBg(); drawStaff();
    if (gameState==='playing' || gameState==='finishing') {
      drawChallenge(); drawPopups(); drawHud();
      if (flashErr>0) {
        ctx.fillStyle=`rgba(193,102,107,${(flashErr*0.28).toFixed(3)})`;
        ctx.fillRect(0,0,W,H);
      }
    } else if (gameState==='calibrating') {
      drawListeningDot();
    } else if (gameState==='tuning') {
      drawTuningState();
    } else if (gameState==='paused') {
      // disegna la nota ferma sbiadita
      if (challenge && anim) {
        ctx.save(); ctx.globalAlpha=0.35;
        drawChallengeAt(noteX,challenge,true);
        ctx.restore();
      }
    }
  }

  function drawBg() {
    ctx.fillStyle=PAL.bg; ctx.fillRect(0,0,W,H);
    const g=ctx.createRadialGradient(W/2,staffY-lineGap*2,30,W/2,staffY-lineGap*2,W*0.7);
    g.addColorStop(0,'rgba(212,168,67,0.07)'); g.addColorStop(1,'rgba(212,168,67,0)');
    ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
  }

  function drawStaff() {
    const lw=Math.max(1,lineGap*0.075);
    ctx.strokeStyle=PAL.staff; ctx.lineWidth=lw; ctx.globalAlpha=0.75;
    for (let i=0; i<5; i++) {
      const y=staffY-i*lineGap;
      ctx.beginPath(); ctx.moveTo(W*0.06,y); ctx.lineTo(W*0.94,y); ctx.stroke();
    }
    ctx.globalAlpha=1;
    drawTrebleClef(W*0.105, staffY);
  }

  // Chiave di violino Unicode 𝄞 — baseline calibrata sul secondo rigo (G4)
  function drawTrebleClef(x, botY) {
    const size = lineGap * 5.6;
    ctx.save();
    ctx.fillStyle    = PAL.gold;
    ctx.font         = `${size}px 'EB Garamond', Georgia, 'Times New Roman', serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('\u{1D11E}', x, botY - lineGap * 0.5);
    ctx.restore();
  }

  /* ── Calcola gli offset X per le note di un accordo ── */
  function computeXOffsets(notes) {
    const offsets = new Array(notes.length).fill(0);
    for (let i=1; i<notes.length; i++) {
      const dDist = Math.abs(diatonicIndex(notes[i]) - diatonicIndex(notes[i-1]));
      // Se i diatonic step <= 1, alterna: se la nota precedente era a 0 vai a +offset, viceversa
      offsets[i] = dDist<=1 ? (offsets[i-1]===0 ? lineGap*1.05 : 0) : 0;
    }
    return offsets;
  }

  function drawChallenge() {
    if (!challenge||!anim) return;
    const p=Math.min(1,anim.t);
    let x=noteX, alpha=1;
    if (anim.type==='out')      { const e=p*p; x=noteX-e*W*0.55; alpha=1-p; }
    else if (anim.type==='in')  { const e=1-(1-p)*(1-p); x=noteX+(1-e)*W*0.42; alpha=e; }

    ctx.save(); ctx.globalAlpha=Math.max(0,Math.min(1,alpha));
    drawChallengeAt(x,challenge,true);
    ctx.restore();

    if (nextChallenge && anim.type==='idle') {
      ctx.save(); ctx.globalAlpha=0.16;
      drawChallengeAt(noteX+W*0.30, nextChallenge, false);
      ctx.restore();
    }
  }

  function drawChallengeAt(x, ch, isActive) {
    const notes   = ch.notes;
    const step    = ch.step || 0;
    const isChord = notes.length > 1;
    const offsets = computeXOffsets(notes);

    // Etichetta accordo: pannello sinistro, sotto la chiave di violino
    if (isActive && ch.chordLabel) {
      const rootPc   = ((notes[0] % 12) + 12) % 12;
      const rootOct  = Math.floor(notes[0] / 12) - 1;
      const rootName = NOTE_NAMES_IT[rootPc] + rootOct;
      ctx.save();
      ctx.textAlign = 'left';
      // nome fondamentale
      ctx.font      = `${lineGap * 0.80}px 'Cormorant Garamond',Georgia,serif`;
      ctx.fillStyle = PAL.note;
      ctx.globalAlpha = 0.88;
      ctx.fillText(rootName, W * 0.055, staffY + lineGap * 1.3);
      // tipo accordo sotto
      ctx.font      = `italic ${lineGap * 0.54}px 'EB Garamond',Georgia,serif`;
      ctx.fillStyle = PAL.gold;
      ctx.globalAlpha = 0.72;
      ctx.fillText(ch.chordLabel, W * 0.055, staffY + lineGap * 2.05);
      ctx.restore();
    }

    // Linea arpeggio ondulata (sostituisce la parentesi): notazione standard
    if (isActive && isChord) {
      const topNoteY = staffYOf(notes[notes.length - 1]) - lineGap * 0.5;
      const botNoteY = staffYOf(notes[0]) + lineGap * 0.5;
      drawArpeggioWave(x - lineGap * 1.2, topNoteY, botNoteY);
    }

    for (let i = 0; i < notes.length; i++) {
      let state;
      if (!isActive)       state = 'preview';
      else if (i < step)   state = 'done';
      else if (i === step) state = 'current';
      else                 state = 'pending';
      // Accordi: senza gambi individuali (la linea arpeggio connette visivamente)
      drawNoteSymbol(x + offsets[i], notes[i], state, !isChord);
    }

    // Nota singola: gambo normale
    if (!isChord && isActive) {
      // gambo già disegnato da drawNoteSymbol con drawStem=true
    }
  }

  // Linea arpeggio ondulata verticale (notazione musicale standard)
  function drawArpeggioWave(x, topY, botY) {
    const amp  = lineGap * 0.22;
    const step = lineGap * 0.55;
    ctx.save();
    ctx.strokeStyle = PAL.gold;
    ctx.lineWidth   = Math.max(1.5, lineGap * 0.075);
    ctx.lineCap     = 'round';
    ctx.globalAlpha = 0.65;
    ctx.beginPath();
    ctx.moveTo(x, botY);
    let y   = botY;
    let dir = 1;
    while (y > topY + step * 0.5) {
      const ny = Math.max(topY, y - step);
      const cy = (y + ny) / 2;
      ctx.quadraticCurveTo(x + amp * dir, cy, x, ny);
      y  -= step;
      dir = -dir;
    }
    ctx.stroke();
    // Freccia verso l'alto (suona dal basso)
    const aw = lineGap * 0.18;
    ctx.beginPath();
    ctx.moveTo(x - aw, topY + lineGap * 0.3);
    ctx.lineTo(x, topY);
    ctx.lineTo(x + aw, topY + lineGap * 0.3);
    ctx.stroke();
    ctx.restore();
  }

  function drawNoteSymbol(x, midi, state, drawStem = true) {
    const y  = staffYOf(midi);
    const r  = lineGap * 0.44;
    const rx = r * 1.4;
    const pc = ((midi % 12) + 12) % 12;
    let color, alpha;
    switch (state) {
      case 'current': color = PAL.note;   alpha = 1;    break;
      case 'done':    color = PAL.inkDim; alpha = 0.38; break;
      case 'pending': color = PAL.note;   alpha = 0.28; break;
      default:        color = PAL.inkDim; alpha = 1;
    }

    drawLedgerLines(x, midi);

    ctx.save();
    ctx.globalAlpha *= alpha;

    if (state === 'current') {
      ctx.shadowColor = PAL.note;
      ctx.shadowBlur  = lineGap * (0.7 + Math.sin(frameN * 0.14) * 0.3);
    }
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.ellipse(x, y, rx, r, -0.3, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;

    // Gambo solo per note singole (accordi usano la linea arpeggio)
    if (drawStem) {
      const midStaffY = staffY - lineGap * 2;
      ctx.strokeStyle = color;
      ctx.lineWidth   = lineGap * 0.13;
      ctx.lineCap     = 'round';
      ctx.beginPath();
      if (y > midStaffY) {
        ctx.moveTo(x + rx * 0.82, y - r * 0.3);
        ctx.lineTo(x + rx * 0.82, y - lineGap * 3.5);
      } else {
        ctx.moveTo(x - rx * 0.82, y + r * 0.3);
        ctx.lineTo(x - rx * 0.82, y + lineGap * 3.5);
      }
      ctx.stroke();
    }

    // Diesis
    if (PC_ACC[pc] === 1) {
      ctx.fillStyle   = state === 'current' ? PAL.gold : PAL.inkDim;
      ctx.font        = `${lineGap * 1.2}px Georgia,serif`;
      ctx.textAlign   = 'right';
      ctx.globalAlpha = state === 'current' ? 1 : 0.5;
      ctx.fillText('♯', x - rx - lineGap * 0.25, y + lineGap * 0.38);
    }
    ctx.restore();

    // Spunta note già suonate dell'arpeggio
    if (state === 'done') {
      ctx.save();
      ctx.fillStyle   = PAL.ok;
      ctx.globalAlpha = 0.55;
      ctx.font        = `${lineGap * 0.62}px Georgia,serif`;
      ctx.textAlign   = 'center';
      ctx.fillText('✓', x + rx + lineGap * 0.5, y + lineGap * 0.22);
      ctx.restore();
    }

    // Nome nota corrente (sotto il rigo) — solo note singole, non accordi
    if (state === 'current' && drawStem) {
      const oct  = Math.floor(midi / 12) - 1;
      const name = NOTE_NAMES_IT[pc] + oct;
      ctx.save();
      ctx.fillStyle   = PAL.inkDim;
      ctx.globalAlpha = 0.72;
      ctx.font        = `${lineGap * 0.62}px 'Courier New',monospace`;
      ctx.textAlign   = 'center';
      ctx.fillText(name, x, staffY + lineGap * 2.2);
      ctx.restore();
    }
  }

  function drawLedgerLines(x,midi) {
    const y=staffYOf(midi); const topY=staffY-lineGap*4;
    const half=lineGap/2; const lw=lineGap*1.55;
    ctx.strokeStyle=PAL.staff; ctx.lineWidth=Math.max(1,lineGap*0.075);
    for (let ly=staffY+lineGap; ly<=y+half-1; ly+=lineGap) {
      ctx.beginPath(); ctx.moveTo(x-lw,ly); ctx.lineTo(x+lw,ly); ctx.stroke();
    }
    for (let ly=topY-lineGap; ly>=y-half+1; ly-=lineGap) {
      ctx.beginPath(); ctx.moveTo(x-lw,ly); ctx.lineTo(x+lw,ly); ctx.stroke();
    }
  }

  function drawPopups() {
    for (const p of popups) {
      const ease=1-(1-p.t)*(1-p.t); const yOff=ease*lineGap*3;
      const a=p.t<0.55?1:1-(p.t-0.55)/0.45;
      ctx.save(); ctx.globalAlpha=Math.max(0,a); ctx.fillStyle=p.color;
      ctx.font=`bold ${lineGap*0.85}px 'Courier New',monospace`; ctx.textAlign='center';
      ctx.fillText(p.text, p.x, p.y-yOff);
      ctx.restore();
    }
  }

  function drawHud() {
    const fs  = lineGap * 0.62;
    // Posizione HUD: angolo in alto a sinistra, oltre la chiave (clef finisce ~W*0.18)
    const hx  = W * 0.20;
    const hy  = lineGap * 1.0; // distanza dal bordo superiore
    ctx.save();

    if (gameMode === 'ranked') {
      if (score > 0) {
        ctx.font      = `${fs * 1.1}px 'Courier New',monospace`;
        ctx.fillStyle = PAL.gold;
        ctx.textAlign = 'left';
        ctx.fillText(String(score), hx, hy);
      }
    } else {
      if (notesCorrect > 0) {
        const avg = (totalNoteTimeSec / notesCorrect).toFixed(1) + 's';
        ctx.font      = `${fs}px 'Courier New',monospace`;
        ctx.fillStyle = PAL.inkDim;
        ctx.textAlign = 'left';
        ctx.fillText('⌀ ' + avg, hx, hy);
      }
    }

    if (errorCount > 0) {
      ctx.font      = `${fs * 0.9}px 'Courier New',monospace`;
      ctx.fillStyle = PAL.err;
      ctx.textAlign = 'left';
      ctx.fillText(errorCount + ' ✗', hx, hy + fs * 1.4);
    }

    ctx.restore();
  }

  function drawListeningDot() {
    const pulse=0.5+0.5*Math.sin(frameN*0.1);
    ctx.save(); ctx.fillStyle=PAL.staff; ctx.globalAlpha=0.3+pulse*0.4;
    ctx.beginPath(); ctx.arc(W/2,staffY-lineGap*2,lineGap*0.4,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }

  function drawTuningState() {
    const pulse = 0.5 + 0.5*Math.sin(frameN*0.08);
    ctx.save();
    ctx.textAlign = 'center';
    if (!tuningNote) {
      ctx.font      = `italic ${lineGap*0.72}px 'EB Garamond',Georgia,serif`;
      ctx.fillStyle = PAL.inkDim;
      ctx.globalAlpha = 0.5 + pulse*0.25;
      ctx.fillText('Suona qualsiasi nota', W*0.56, staffY - lineGap*2.6);
    } else {
      drawNoteSymbol(noteX, tuningNote, 'current', true);
      ctx.font      = `italic ${lineGap*0.62}px 'EB Garamond',Georgia,serif`;
      ctx.fillStyle = PAL.ok;
      ctx.globalAlpha = 0.9;
      ctx.fillText('✓ rilevato', W*0.56, staffY + lineGap*2.2);
    }
    ctx.restore();
  }

  /* ====================================================================
     (6) LOOP
     ==================================================================== */

  let rafId=null, lastTs=0, running=false;

  function loop(ts) {
    if (!running) return;
    const dt=Math.min(0.05,(ts-lastTs)/1000||0);
    lastTs=ts; pollAudio(); updateGame(dt);
    if (gameState==='tuning' && pendingNote) {
      tuningNote=pendingNote.midi; pendingNote=null;
      clearTimeout(tuningTimer);
      tuningTimer=setTimeout(beginPlaying, 800);
    }
    render();
    rafId=requestAnimationFrame(loop);
  }

  function startLoop() {
    if (running) return; running=true; lastTs=performance.now();
    rafId=requestAnimationFrame(loop);
  }

  function stopLoop() {
    running=false; if (rafId) { cancelAnimationFrame(rafId); rafId=null; }
  }

  /* ====================================================================
     (7) PAUSA
     ==================================================================== */

  function pauseGame() {
    if (gameState!=='playing') return;
    gameState='paused';
    if (elPauseScreen) elPauseScreen.classList.remove('hidden');
    if (elPauseBtn) elPauseBtn.textContent='▶';
  }

  function resumeGame() {
    if (gameState!=='paused') return;
    gameState='playing';
    noteStartTime=performance.now(); // resetta il timer per non penalizzare il tempo di pausa
    if (elPauseScreen) elPauseScreen.classList.add('hidden');
    if (elPauseBtn) elPauseBtn.textContent='⏸';
  }

  /* ====================================================================
     (8) DOM
     ==================================================================== */

  let elStart, elModeRanked, elModeFree;
  let elCalib, elCalibText;
  let elGameOver;
  let elRestartBtn;
  let elSummaryRanked, elFinalScore, elFinalAcc, elFinalErrors, elFinalAvgTime;
  let elSummaryFree, elFreeNotes, elFreeAvg, elFreeErrors;
  let elGameBar, elPauseBtn, elExitBtn;
  let elPauseScreen, elResumeBtn;
  let initialized=false;

  function resetToStart() {
    stopLoop(); releaseMic(); gameState='idle';
    clearTimeout(tuningTimer); tuningNote=null;
    if (elGameOver)    elGameOver.classList.add('hidden');
    if (elGameBar)     elGameBar.classList.add('hidden');
    if (elCalib)       elCalib.classList.add('hidden');
    if (elPauseScreen) elPauseScreen.classList.add('hidden');
    if (elStart)       elStart.classList.remove('hidden');
    if (elPauseBtn)    elPauseBtn.textContent='⏸';
    render();
  }

  function stopPianoforte() { resetToStart(); }
  window.stopPianoforte = stopPianoforte;

  /* ====================================================================
     (9) HTML
     ==================================================================== */

  function creaPianoforte() {
    const el=document.getElementById('pianoforte');
    if (!el) return;
    el.innerHTML=`
      <div id="pianoApp">
        <canvas id="gameCanvas"></canvas>

        <div id="gameBar" class="pf-gamebar hidden">
          <button id="pauseBtn" class="pf-iconbtn" aria-label="Pausa">⏸</button>
          <button id="exitBtn"  class="pf-iconbtn" aria-label="Risultati / esci">✕</button>
        </div>

        <!-- START: selezione modalità -->
        <div id="startScreen" class="pf-overlay">
          <p class="pf-eyebrow">Sala 131 · il Pianoforte</p>
          <h1 class="pf-title">Il Direttore</h1>
          <div class="pf-rule"></div>
          <div class="pf-modeGrid">
            <button class="pf-modeCard" id="modeRanked">
              <span class="pf-modeIcon">♙</span>
              <span class="pf-modeName">Ranked</span>
              <span class="pf-modeDesc">20 sfide — note e accordi fino alle settime. Punteggio finale.</span>
            </button>
            <button class="pf-modeCard" id="modeFree">
              <span class="pf-modeIcon">♩</span>
              <span class="pf-modeName">Free</span>
              <span class="pf-modeDesc">Infinito, senza punteggio. Solo il tuo tempo medio a nota.</span>
            </button>
          </div>
          <p class="pf-hint">Tieni il telefono vicino al pianoforte. Useremo il microfono.</p>
          <button class="pf-back" onclick="if(window.stopPianoforte)window.stopPianoforte();mostraPagina('menu')">Torna indietro</button>
        </div>

        <!-- CALIBRAZIONE -->
        <div id="calibScreen" class="pf-overlay hidden">
          <p class="pf-eyebrow">Taratura — fase 1 di 2</p>
          <p id="calibText" class="pf-title pf-title--sm">Silenzio…</p>
          <div class="pf-rule"></div>
          <p class="pf-subtitle">Non fare rumori.<br>Misuro il rumore di fondo.</p>
        </div>

        <!-- PAUSA -->
        <div id="pauseScreen" class="pf-overlay hidden">
          <p class="pf-eyebrow">In pausa</p>
          <h2 class="pf-title pf-title--sm">∥</h2>
          <div class="pf-rule"></div>
          <div class="pf-btnRow">
            <button id="resumeBtn" class="pf-bigBtn">Riprendi</button>
          </div>
          <button class="pf-back" id="pauseExitBtn">Abbandona</button>
        </div>

        <!-- RIEPILOGO -->
        <div id="gameOverScreen" class="pf-overlay hidden">
          <p class="pf-eyebrow">Fine del concerto</p>
          <h2 class="pf-title pf-title--sm">Sipario</h2>
          <div class="pf-rule"></div>

          <div id="summaryRanked" class="pf-statsGrid hidden">
            <div class="pf-stat">
              <span class="pf-statVal pf-statVal--gold" id="finalScore">0</span>
              <span class="pf-statLbl">/ 1000</span>
            </div>
            <div class="pf-stat">
              <span class="pf-statVal" id="finalAcc">—</span>
              <span class="pf-statLbl">precisione</span>
            </div>
            <div class="pf-stat">
              <span class="pf-statVal" id="finalAvgTime">—</span>
              <span class="pf-statLbl">⌀ tempo</span>
            </div>
            <div class="pf-stat">
              <span class="pf-statVal pf-statVal--err" id="finalErrors">0</span>
              <span class="pf-statLbl">errori</span>
            </div>
          </div>

          <div id="summaryFree" class="pf-statsGrid hidden">
            <div class="pf-stat">
              <span class="pf-statVal pf-statVal--gold" id="freeNotes">0</span>
              <span class="pf-statLbl">sfide</span>
            </div>
            <div class="pf-stat">
              <span class="pf-statVal" id="freeAvg">—</span>
              <span class="pf-statLbl">⌀ tempo</span>
            </div>
            <div class="pf-stat">
              <span class="pf-statVal pf-statVal--err" id="freeErrors">0</span>
              <span class="pf-statLbl">errori</span>
            </div>
          </div>

          <div class="pf-btnRow" style="margin-top:4px">
            <button id="restartBtn" class="pf-bigBtn">Da capo</button>
          </div>
          <button class="pf-back" onclick="if(window.stopPianoforte)window.stopPianoforte();mostraPagina('menu')">Torna al menu</button>
        </div>
      </div>
    `;
  }
  window.creaPianoforte=creaPianoforte;

  function cacheElements() {
    canvas          = document.getElementById('gameCanvas');
    if (!canvas) return false;
    ctx             = canvas.getContext('2d');
    elStart         = document.getElementById('startScreen');
    elModeRanked    = document.getElementById('modeRanked');
    elModeFree      = document.getElementById('modeFree');
    elCalib         = document.getElementById('calibScreen');
    elCalibText     = document.getElementById('calibText');
    elGameOver      = document.getElementById('gameOverScreen');
    elRestartBtn    = document.getElementById('restartBtn');
    elSummaryRanked = document.getElementById('summaryRanked');
    elFinalScore    = document.getElementById('finalScore');
    elFinalAcc      = document.getElementById('finalAcc');
    elFinalErrors   = document.getElementById('finalErrors');
    elFinalAvgTime  = document.getElementById('finalAvgTime');
    elSummaryFree   = document.getElementById('summaryFree');
    elFreeNotes     = document.getElementById('freeNotes');
    elFreeAvg       = document.getElementById('freeAvg');
    elFreeErrors    = document.getElementById('freeErrors');
    elGameBar       = document.getElementById('gameBar');
    elPauseBtn      = document.getElementById('pauseBtn');
    elExitBtn       = document.getElementById('exitBtn');
    elPauseScreen   = document.getElementById('pauseScreen');
    elResumeBtn     = document.getElementById('resumeBtn');
    return true;
  }

  async function startMode(mode) {
    gameMode=mode; elStart.classList.add('hidden');
    const ok=await initAudio();
    if (!ok) { elStart.classList.remove('hidden'); return; }
    startLoop(); startCalibration();
  }

  function avviaPianoforteInit() {
    if (!document.getElementById('gameCanvas')) creaPianoforte();
    if (!cacheElements()) return;
    resizeCanvas();
    if (!initialized) {
      window.addEventListener('resize', resizeCanvas);
      window.addEventListener('orientationchange', ()=>setTimeout(resizeCanvas,200));
      initialized=true;
    }
    if (elModeRanked) elModeRanked.onclick = ()=>startMode('ranked');
    if (elModeFree)   elModeFree.onclick   = ()=>startMode('free');
    if (elRestartBtn) elRestartBtn.onclick = ()=>{
      elGameOver.classList.add('hidden'); startLoop(); startCalibration();
    };
    if (elPauseBtn) elPauseBtn.onclick = ()=>{
      if (gameState==='playing') pauseGame();
      else if (gameState==='paused') resumeGame();
    };
    if (elResumeBtn) elResumeBtn.onclick  = resumeGame;
    const pauseExitBtn = document.getElementById('pauseExitBtn');
    if (pauseExitBtn) pauseExitBtn.onclick = ()=>{ resetToStart(); mostraPagina('menu'); };
    if (elExitBtn) elExitBtn.onclick = ()=>{
      if (gameState==='playing'||gameState==='finishing') showSummary();
      else if (gameState==='paused') { resetToStart(); mostraPagina('menu'); }
      else { resetToStart(); mostraPagina('menu'); }
    };
    resetToStart();
  }
  window.avviaPianoforteInit=avviaPianoforteInit;

})();
