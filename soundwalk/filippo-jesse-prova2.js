/* =====================================================================
   SOUNDWALK — SALA 131 · IL PIANOFORTE — VERSIONE CHIAVE DOPPIA
   Chiave di violino (E4–F5) + chiave di basso (G2–B3).
   Nessun taglio addizionale mai.
   ===================================================================== */

(function () {
  'use strict';

  /* ====================================================================
     (0) COSTANTI
     ==================================================================== */

  const YIN_THRESH        = 0.12;
  const FMIN              = 55;   // più basso per catturare G2 (98Hz)
  const FMAX              = 1400;
  const STABLE_FRAMES     = 3;
  const REFRACTORY_MS     = 300;
  const ONSET_WINDOW      = 400;
  const ERROR_COOLDOWN_MS = 1500;
  const CALIB_MS          = 2000;
  const CALIB_MULT        = 2.0;
  const CALIB_MIN         = 0.003;
  const CALIB_MAX         = 0.03;
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

  // Note bianche chiave di violino: E4–F5 (senza tagli addizionali)
  const WHITE_MIDIS = [60,62,64,65,67,69,71,72,74,76,77,79,81,83];

  // Note bianche chiave di basso: G2–B3 (senza tagli addizionali)
  const BASS_MIDIS  = [43,45,47,48,50,52,53,55,57,59];

  const arpeggioImg = new Image();
  arpeggioImg.src   = 'arpeggio.svg';

  const TREBLE_BOTTOM_MIDI = 64;  // E4 = primo rigo violino
  const BASS_BOTTOM_MIDI   = 43;  // G2 = primo rigo basso

  const PC_STEP = [0,0,1,1,2,3,3,4,4,5,5,6];
  const PC_ACC  = [0,1,0,1,0,0,1,0,1,0,1,0];

  function diatonicIndex(midi) {
    const pc  = ((midi % 12) + 12) % 12;
    const oct = Math.floor(midi / 12) - 1;
    return oct * 7 + PC_STEP[pc];
  }

  // contesto della chiave corrente — cambia prima di ogni drawChallengeAt
  let clefCtx = 'treble';

  function staffYOf(midi) {
    const bottom = clefCtx === 'bass' ? BASS_BOTTOM_MIDI : TREBLE_BOTTOM_MIDI;
    return staffY - (diatonicIndex(midi) - diatonicIndex(bottom)) * (lineGap/2);
  }

  /* ====================================================================
     ACCORDI
     ==================================================================== */

  const CHORD_TYPES = [
    { label: 'triade magg.',  intervals: [4, 7]      },
    { label: 'triade min.',   intervals: [3, 7]      },
    { label: 'triade dim.',   intervals: [3, 6]      },
    { label: 'sus4',          intervals: [5, 7]      },
    { label: 'sesta agg.',    intervals: [4, 7, 9]   },
    { label: 'min 7ª',       intervals: [3, 7, 10]  },
    { label: '7ª dom.',      intervals: [4, 7, 10]  },
    { label: '7ª magg.',     intervals: [4, 7, 11]  },
    { label: '7ª dim.',      intervals: [3, 6,  9]  },
    { label: '½ dim.',       intervals: [3, 6, 10]  },
  ];

  function buildRankedChord(typeIdx) {
    const { intervals } = CHORD_TYPES[typeIdx];
    const roots = WHITE_MIDIS.filter(m => m >= 60 && m <= 67);
    const root  = roots[Math.floor(Math.random() * roots.length)];
    return [root, ...intervals.map(i => root + i)].sort((a, b) => a - b);
  }

  // Accordo in chiave di basso: radici G2–C3 (43–48), note cap B3 (59)
  function buildBassChord(typeIdx) {
    const { intervals } = CHORD_TYPES[typeIdx];
    const roots = BASS_MIDIS.filter(m => m >= 43 && m <= 48);
    const root  = roots[Math.floor(Math.random() * roots.length)];
    const notes = [root, ...intervals.map(i => root + i)].filter(n => n <= 59);
    return notes.sort((a, b) => a - b);
  }

  function randomWhiteNote() {
    const pool = WHITE_MIDIS.filter(m => m >= 64 && m <= 77); // E4–F5
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function randomBassNote() {
    return BASS_MIDIS[Math.floor(Math.random() * BASS_MIDIS.length)];
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function generateRankedList() {
    const trebleSingles = Array.from({ length: 5 }, () => ({
      notes: [randomWhiteNote()], step: 0, chordLabel: null, clef: 'treble'
    }));
    const bassSingles = Array.from({ length: 5 }, () => ({
      notes: [randomBassNote()], step: 0, chordLabel: null, clef: 'bass'
    }));
    const trebleChords = Array.from({ length: 5 }, (_, i) => ({
      notes: buildRankedChord(i), step: 0, chordLabel: CHORD_TYPES[i].label, clef: 'treble'
    }));
    const bassChords = Array.from({ length: 5 }, (_, i) => ({
      notes: buildBassChord(i), step: 0, chordLabel: CHORD_TYPES[i].label, clef: 'bass'
    }));
    return shuffle([...trebleSingles, ...bassSingles, ...trebleChords, ...bassChords]);
  }

  const FREE_INTERVAL_POOL = [
    [3,4,5],[3,4,5,7],[3,4,5,7,8,9],[3,4,5,7,8,9,12],
    [2,3,4,5,6,7,8,9,10,11,12]
  ];

  function generateFreeChallenge(idx) {
    const isBass = Math.random() < 0.4; // 40% chiave di basso
    if (idx < 10) return {
      notes: [isBass ? randomBassNote() : randomWhiteNote()],
      step: 0, chordLabel: null, clef: isBass ? 'bass' : 'treble'
    };
    const level    = Math.min(4, Math.floor((idx-10)/10));
    const chordProb = Math.min(0.75, 0.22+level*0.14);
    if (Math.random() > chordProb) return {
      notes: [isBass ? randomBassNote() : randomWhiteNote()],
      step: 0, chordLabel: null, clef: isBass ? 'bass' : 'treble'
    };
    if (isBass) {
      // Accordo in chiave di basso
      const typeIdx = Math.floor(Math.random() * Math.min(CHORD_TYPES.length, (level+1)*2));
      const notes   = buildBassChord(typeIdx);
      return { notes, step: 0, chordLabel: CHORD_TYPES[typeIdx].label, clef: 'bass' };
    }
    // Accordo in chiave di violino
    const maxSize = Math.min(4, 2+Math.floor(level/2));
    const size    = 2+Math.floor(Math.random()*(maxSize-1));
    const pool    = FREE_INTERVAL_POOL[level];
    const roots   = WHITE_MIDIS.filter(m => m >= 60 && m <= 67);
    const root    = roots[Math.floor(Math.random()*roots.length)];
    const notes   = [root];
    for (let i=1; i<size; i++) {
      const iv = pool[Math.floor(Math.random()*pool.length)];
      const nx = notes[notes.length-1]+iv;
      if (nx<=77) notes.push(nx);
    }
    return { notes: notes.sort((a,b)=>a-b), step: 0, chordLabel: null, clef: 'treble' };
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
    if (gameState === 'tuning' && isLoud) tuningRmsSamples.push(rms);
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
  let tuningNote = null, tuningTimer = null, tuningRmsSamples = [];

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
    wasQuiet = true; pendingNote = null; tuningNote = null; tuningRmsSamples = [];
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
    lineGap = Math.max(18, Math.round(H * 0.09));
    staffY  = Math.round(H * 0.62);
    noteX   = Math.round(W * 0.56);
  }

  /* ====================================================================
     (4) STATO DI GIOCO
     ==================================================================== */

  let gameState  = 'idle';
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
    clefCtx = challenge.clef || 'treble'; // importante: imposta prima di staffYOf
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
      if (challenge && anim) {
        ctx.save(); ctx.globalAlpha=0.35;
        clefCtx = challenge.clef || 'treble';
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
    const activeClef = challenge ? (challenge.clef || 'treble') : 'treble';
    if (activeClef === 'bass') drawBassClef(W*0.105, staffY);
    else                       drawTrebleClef(W*0.105, staffY);
  }

  function drawTrebleClef(x, botY) {
    const size = lineGap * 6.4;
    ctx.save();
    ctx.fillStyle    = PAL.gold;
    ctx.font         = `${size}px 'EB Garamond', Georgia, 'Times New Roman', serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('\u{1D11E}', x, botY + lineGap * 0.2);
    ctx.restore();
  }

  // Chiave di basso (F clef) — il taglio dei due puntini cade sul quarto rigo (F3)
  function drawBassClef(x, botY) {
    const size = lineGap * 3.8;
    ctx.save();
    ctx.fillStyle    = PAL.gold;
    ctx.font         = `${size}px 'EB Garamond', Georgia, 'Times New Roman', serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'alphabetic';
    // baseline calibrata: il glifo 𝄢 si posiziona con la F circa sul 4° rigo (botY-3*lineGap)
    ctx.fillText('\u{1D122}', x, botY - lineGap * 1.8);
    ctx.restore();
  }

  function computeXOffsets(notes) {
    const offsets = new Array(notes.length).fill(0);
    for (let i=1; i<notes.length; i++) {
      const dDist = Math.abs(diatonicIndex(notes[i]) - diatonicIndex(notes[i-1]));
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
    const prevClef = clefCtx;
    clefCtx = ch.clef || 'treble';

    const notes   = ch.notes;
    const step    = ch.step || 0;
    const isChord = notes.length > 1;
    const offsets = computeXOffsets(notes);

    // Etichetta accordo: pannello sinistro, sotto il rigo
    if (isActive && ch.chordLabel) {
      const rootPc   = ((notes[0] % 12) + 12) % 12;
      const rootOct  = Math.floor(notes[0] / 12) - 1;
      const rootName = NOTE_NAMES_IT[rootPc] + rootOct;
      const allNames = notes.map(m => {
        const pc = ((m%12)+12)%12; const oct = Math.floor(m/12)-1;
        return NOTE_NAMES_IT[pc]+oct;
      }).join(' + ');
      ctx.save();
      ctx.textAlign = 'left';
      ctx.font      = `${lineGap * 0.82}px 'Cormorant Garamond',Georgia,serif`;
      ctx.fillStyle = PAL.note;
      ctx.globalAlpha = 0.90;
      ctx.fillText(rootName, W * 0.045, staffY + lineGap * 1.7);
      ctx.font      = `italic ${lineGap * 0.56}px 'EB Garamond',Georgia,serif`;
      ctx.fillStyle = PAL.gold;
      ctx.globalAlpha = 0.75;
      ctx.fillText(ch.chordLabel, W * 0.045, staffY + lineGap * 2.45);
      ctx.font      = `${lineGap * 0.50}px 'Courier New',monospace`;
      ctx.fillStyle = PAL.inkDim;
      ctx.globalAlpha = 0.60;
      ctx.fillText(allNames, W * 0.045, staffY + lineGap * 3.25);
      ctx.restore();
    }

    // Arpeggio: immagine SVG scalata tra la nota più bassa e più alta
    if (isActive && isChord && arpeggioImg.complete) {
      const topNoteY = staffYOf(notes[notes.length - 1]) - lineGap * 0.55;
      const botNoteY = staffYOf(notes[0]) + lineGap * 0.55;
      const imgH     = botNoteY - topNoteY;
      const imgW     = Math.round(lineGap * 0.55);
      ctx.save();
      ctx.globalAlpha *= 0.85;
      ctx.drawImage(arpeggioImg, x - lineGap * 1.3 - imgW * 0.5, topNoteY, imgW, imgH);
      ctx.restore();
    }

    for (let i = 0; i < notes.length; i++) {
      let state;
      if (!isActive)       state = 'preview';
      else if (i < step)   state = 'done';
      else if (i === step) state = 'current';
      else                 state = 'pending';
      drawNoteSymbol(x + offsets[i], notes[i], state, !isChord);
    }

    clefCtx = prevClef;
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

    if (PC_ACC[pc] === 1) {
      ctx.fillStyle   = state === 'current' ? PAL.gold : PAL.inkDim;
      ctx.font        = `${lineGap * 1.2}px Georgia,serif`;
      ctx.textAlign   = 'left';
      ctx.globalAlpha = state === 'current' ? 1 : 0.5;
      ctx.fillText('♯', x + rx + lineGap * 0.18, y + lineGap * 0.38);
    }
    ctx.restore();

    if (state === 'done') {
      ctx.save();
      ctx.fillStyle   = PAL.ok;
      ctx.globalAlpha = 0.55;
      ctx.font        = `${lineGap * 0.62}px Georgia,serif`;
      ctx.textAlign   = 'center';
      ctx.fillText('✓', x + rx + lineGap * 0.5, y + lineGap * 0.22);
      ctx.restore();
    }

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

  function drawLedgerLines(x, midi) {
    const y    = staffYOf(midi);
    const topY = staffY - lineGap*4;
    const half = lineGap/2;
    const lw   = lineGap*1.55;
    ctx.strokeStyle = PAL.staff;
    ctx.lineWidth   = Math.max(1, lineGap*0.075);
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
    const fs = lineGap * 0.62;
    const hx = W * 0.20;
    const ex = W * 0.38;
    const hy = lineGap * 1.2;
    ctx.save();
    ctx.textAlign = 'left';
    if (gameMode === 'ranked') {
      if (score > 0) {
        ctx.font = `${fs * 1.1}px 'Courier New',monospace`;
        ctx.fillStyle = PAL.gold;
        ctx.fillText(String(score), hx, hy);
      }
    } else {
      if (notesCorrect > 0) {
        const avg = (totalNoteTimeSec / notesCorrect).toFixed(1) + 's';
        ctx.font = `${fs}px 'Courier New',monospace`;
        ctx.fillStyle = PAL.inkDim;
        ctx.fillText('⌀ ' + avg, hx, hy);
      }
    }
    if (errorCount > 0) {
      ctx.font = `${fs * 0.9}px 'Courier New',monospace`;
      ctx.fillStyle = PAL.err;
      ctx.fillText(errorCount + ' ✗', ex, hy);
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
      clefCtx = 'treble'; // nota di taratura sempre su violino
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
      if (tuningRmsSamples.length > 0) {
        const peakRms = Math.max(...tuningRmsSamples);
        const noteThresh = Math.max(CALIB_MIN, peakRms * 0.25);
        RMS_THRESH = Math.min(noteThresh, RMS_THRESH);
      }
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
    noteStartTime=performance.now();
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
    stopLoop(); releaseMic(); gameState='idle'; clefCtx='treble';
    clearTimeout(tuningTimer); tuningNote=null;
    if (elGameOver)    elGameOver.classList.add('hidden');
    if (elGameBar)     elGameBar.classList.add('hidden');
    if (elCalib)       elCalib.classList.add('hidden');
    if (elPauseScreen) elPauseScreen.classList.add('hidden');
    if (elStart)       elStart.classList.remove('hidden');
    if (elPauseBtn)    elPauseBtn.textContent='⏸';
    render();
  }

  function stopPianoforte2() { resetToStart(); }
  window.stopPianoforte2 = stopPianoforte2;

  /* ====================================================================
     (9) HTML
     ==================================================================== */

  function creaPianoforte2() {
    const el=document.getElementById('pianoforte');
    if (!el) return;
    el.innerHTML=`
      <div id="pianoApp">
        <canvas id="gameCanvas"></canvas>

        <div id="gameBar" class="pf-gamebar hidden">
          <button id="pauseBtn" class="pf-iconbtn" aria-label="Pausa">⏸</button>
          <button id="exitBtn"  class="pf-iconbtn" aria-label="Risultati / esci">✕</button>
        </div>

        <div id="startScreen" class="pf-overlay">
          <p class="pf-eyebrow">Sala 131 · il Pianoforte — Range Esteso</p>
          <h1 class="pf-title">Il Direttore</h1>
          <div class="pf-rule"></div>
          <div class="pf-modeGrid">
            <button class="pf-modeCard" id="modeRanked">
              <span class="pf-modeIcon">♙</span>
              <span class="pf-modeName">Ranked</span>
              <span class="pf-modeDesc">20 sfide — violino e basso, note e accordi.</span>
            </button>
            <button class="pf-modeCard" id="modeFree">
              <span class="pf-modeIcon">♩</span>
              <span class="pf-modeName">Free</span>
              <span class="pf-modeDesc">Infinito, senza punteggio. Chiave doppia.</span>
            </button>
          </div>
          <p class="pf-hint">Tieni il telefono vicino al pianoforte. Useremo il microfono.</p>
          <button class="pf-back" onclick="if(window.stopPianoforte2)window.stopPianoforte2();mostraPagina('menu')">Torna indietro</button>
        </div>

        <div id="calibScreen" class="pf-overlay hidden">
          <p class="pf-eyebrow">Taratura — fase 1 di 2</p>
          <p id="calibText" class="pf-title pf-title--sm">Silenzio…</p>
          <div class="pf-rule"></div>
          <p class="pf-subtitle">Non fare rumori.<br>Misuro il rumore di fondo.</p>
        </div>

        <div id="pauseScreen" class="pf-overlay hidden">
          <p class="pf-eyebrow">In pausa</p>
          <h2 class="pf-title pf-title--sm">∥</h2>
          <div class="pf-rule"></div>
          <div class="pf-btnRow">
            <button id="resumeBtn" class="pf-bigBtn">Riprendi</button>
          </div>
          <button class="pf-back" id="pauseExitBtn">Abbandona</button>
        </div>

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
          <button class="pf-back" onclick="if(window.stopPianoforte2)window.stopPianoforte2();mostraPagina('menu')">Torna al menu</button>
        </div>
      </div>
    `;
  }
  window.creaPianoforte2=creaPianoforte2;

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

  function avviaPianoforte2Init() {
    if (!document.getElementById('gameCanvas')) creaPianoforte2();
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
  window.avviaPianoforte2Init=avviaPianoforte2Init;

})();
