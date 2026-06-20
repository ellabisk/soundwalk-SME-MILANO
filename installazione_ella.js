/* CORRIDOIO INTERATTIVO
   - 3 oscillatori fondamentali (261, 330, 440 Hz)
   - Ogni oscillatore ha fino a 16 parziali armoniche gestite da RGB
   - R = numero parziali oscillatore 0 
   - G = numero parziali oscillatore 1
   - B = numero parziali oscillatore 2 
   - Luminosità = controlla la velocità della melodia e in alcune percentuali attiva dei glitch a frequenze già stabilite
/*

/* Variabili globali audio */

let audioCtx  
let masterGain 
let oscMelodia
let gainMelodia
let melodiaInterval
let NumEsattoLuce=0
let synths = [];
let luceInterval 
const FreqMelodia = [220, 246.94, 261.63, 293.66, 329.63, 349.23, 392, 440, 493.88, 523.25, 587.33, 659.25, 698.46]


/* Variabili globali video */

let smoothLuce = 0
let smoothR    = 0
let smoothG    = 0
let smoothB    = 0
const SMOOTH   = 0.08

/* Parametri degli oscillatori */
const FreqBase    = [261, 330, 440]
const MaxParziali = 16
const GainDiBase  = 0.06  // abbassato per evitare clipping con 16 parziali × 3 synth




async function avviaCorridoio() {
    
    const btnAvvia = document.getElementById("btnAvvia")
    if (btnAvvia) btnAvvia.style.display = "none"

    await avviaCamera(); //aspetta che la camera sia attiva prima di procedere con l'audio

   audioCtx = new (window.AudioContext || window.webkitAudioContext)()//se una delle due è vera
   await audioCtx.resume()
  
   
    masterGain = audioCtx.createGain()
    masterGain.gain.value = 0.5

    masterGain.connect(audioCtx.destination) // collegamento diretto



    /*  Sintesi additiva: 3 oscillatori fondamentali  */
    synths = []

    for (let i = 0; i < FreqBase.length; i++) {//creo un loop così lo applica ad ogni oscillatore, quindi qui legge le freq fondamentale
        const fondamentale = FreqBase[i]
        const partials     = []

        for (let k = 1; k <= MaxParziali; k++) { //qui impara a gestire le parziali
            const osc  = audioCtx.createOscillator()
            const gain = audioCtx.createGain()

            osc.type = "sine"
            osc.frequency.value = fondamentale * k
            
            gain.gain.value  = 0 // partenza a zero, poi aggiorno in base alla luminosità e aggiunge le parziali attive

            osc.connect(gain)
            gain.connect(masterGain)
            osc.start()

            partials.push({ osc, gain }) //push aggiunge un elemento alla fine dell'array così crea l'array di parziali per ogni osc
        }

        synths.push({ fondamentale, partials })
    } //qui ancora le parziali non dipendono da RGB, le ho solo create

    /* Oscillatore melodia */

    oscMelodia  = audioCtx.createOscillator()
    gainMelodia = audioCtx.createGain()

    oscMelodia.type = "sine"
    oscMelodia.frequency.value = FreqMelodia[0]
    gainMelodia.gain.value   = 0.25 // un pochino piu alto di volume rispetto agli altri osc così si distingue una melodia

    oscMelodia.connect(gainMelodia)
    gainMelodia.connect(masterGain)
    oscMelodia.start()

    function aggiornaMelodia() {
    const nuovaFreq = FreqMelodia[Math.floor(Math.random() * FreqMelodia.length)] //sceglie lui in modo randomico su quale frequenza andare (in base a quelle che gli avevo già detto io però), math.floor arrotonda per difetto
    const now = audioCtx.currentTime  //quella che sarà la nuova frequenza,quando la rampa inizia, e da adesso in poi per un certo tempo (che dipende dalla luminosità) si sposta su quella frequenza, se è molto luminoso si sposta subito, se è buio ci mette più tempo a spostarsi, e se nel frattempo cambia luminosità allora si aggiorna la velocità di spostamento in tempo reale
    oscMelodia.frequency.setTargetAtTime(nuovaFreq, now, 0.02) //creo la rampa per spostarci da quna freq all'altra

    // maggiore è la luminosità=note rapide (200ms), buio = lento (max 3000ms)

    const intervallo = 2000 * Math.pow(1 - smoothLuce, 2) //per calcolare ogni qunato dee aggiornare le note, calcola la differenza tra massimo e minimo ovvero 3000-2800 che fa 200 ms ovvero il massimo di velocità, il tutto in bael alla luminosità(smoothLuce)
    melodiaInterval = setTimeout(aggiornaMelodia, Math.max(200, intervallo))//math.max mi serve perchè così anche se dovessi avere tantissima luminosità la velocità non scende sotto i 200 ms, se invece è buio allora intervallo sarà più alto e quindi aggiorna la melodia più lentamente
}

aggiornaMelodia()

    loopLuce()
}



/* FOTOCAMERA */

async function avviaCamera() {
    const video  = document.getElementById("video");
    const stream = await navigator.mediaDevices.getUserMedia({//per attivare la camera, chiede il permesso all'utente e se lo da allora attiva la camera, se no non succede niente
        video: { facingMode: "environment" },//environment è la fotocamra posteriore
        audio: false
    });
    video.srcObject = stream;
    await video.play();
}

function aggiornasfondo(luceNorm) {
    // sequenza alba pastello: tanti colori intermedi per transizioni morbide
    const palette = [
        [  8,   8,  18],  // 0%   nero bluastro questi 3 numeri indicano la quantità di RGB
        [ 18,  15,  45],  // 10%  blu notte profondo
        [ 35,  25,  70],  // 20%  indaco scuro
        [ 65,  40,  90],  // 30%  viola melanzana
        [110,  60, 110],  // 40%  viola medio
        [155,  85, 130],  // 50%  malva rosato
        [190, 115, 130],  // 60%  rosa antico
        [215, 150, 130],  // 70%  salmone caldo
        [235, 185, 145],  // 80%  pesca
        [245, 210, 165],  // 90%  albicocca chiara
        [255, 235, 190],  // 100% giallo crema pastello
    ];

    const steps = palette.length - 1;
    const pos   = luceNorm * steps;
    const i     = Math.min(Math.floor(pos), steps - 1);
    const t     = pos - i;  // valore 0→1 tra un colore e il successivo

    const r = Math.round(palette[i][0] * (1-t) + palette[i+1][0] * t);
    const g = Math.round(palette[i][1] * (1-t) + palette[i+1][1] * t);
    const b = Math.round(palette[i][2] * (1-t) + palette[i+1][2] * t);
   

    document.getElementById("corridoio").style.background = `rgb(${r}, ${g}, ${b})`;
}

/* LETTURA FRAME RGB */


const _canvas = document.createElement("canvas");
_canvas.width  = 50;
_canvas.height = 50;//riduco i pixel a 50 anche se la mia camera ne cattura molti i piu ma a me non serve
const _ctx2d = _canvas.getContext("2d", { willReadFrequently: true });

function leggiFrame(video) {
    _ctx2d.drawImage(video, 0, 0, 50, 50) //disegna il frame sul canvas ridimensionato
    const d = _ctx2d.getImageData(0, 0, 50, 50).data // estrae i pixel e li mette in un array, i vaoli che prende sono R G B A che sarebbe la trasparenza/opacità, ma a noi non serve questo

    let r = 0, g = 0, b = 0
    //a me serve la media dei valori di R G B di tutti i pixel, quindi faccio un loop che va a leggere ogni pixel e somma i valori di R G B in tre variabili separate, alla fine divido per il numero di pixel per avere la media, e poi normalizzo dividendo per 255 così da avere un valore tra 0 e 1 che mi serve per poi gestire la musica
    //memo i valori di RGB vanno da 0  a 255
    
    const n = d.length / 4 //valore di ogni singolo pixel

    for (let i = 0; i < d.length; i += 4) {
        r += d[i] //somma tutti i rossi, tutti i verdi e tutti i blu in tre variabili separate
        g += d[i + 1]
        b += d[i + 2]
    }

    const rn  = r / n / 255 //somma i rossi, f una media, la risccata tra 0 e 1 e così ottengo la percentuale
    const gn  = g / n / 255;
    const bn  = b / n / 255;
    const lum = (rn +  gn +  bn)/3 //così ottengo la luminosità totale, che poi gestisce la melodia principalee i glitch

    return { r: rn, g: gn, b: bn, lum };
}


/*  Funzione per leggere continuamente (loop) la luminosita e RGB, OGNI 50 ms ovvero 20 volte al secondo */


function loopLuce() {
    const video      = document.getElementById("video");
    const lumEl      = document.getElementById("luminosita");
    const rgbEl      = document.getElementById("rgbDisplay");
    const parzialiEl = document.getElementById("parzialiDisplay");

    const LUM_MIN=0.04;//soglia minima di luminosità sotto la quale la musica si ferma, così se è troppo buio non suona niente, e se c'è almeno un po di luce allora parte la musica e si sente
    const LUM_MAX=0.80; //soglia massima di luminosità sopra la quale la musica raggiunge la massima velocità, così se è molto luminoso la musica va molto veloce, se invece è buio allora va più lentamente

    luceInterval = setInterval(() => {
        if (!video || !audioCtx) return //per prima cosa verifico che camera e audio siano attivi

        const { r, g, b, lum } = leggiFrame(video); //usa la funzione leggiFrame per leggere i valori di RGB e luminosità dal video e divide in r,g,b, e lum
//creo il filtro smooth che funziona così: prendo il valore attuale di luminosità e RGB e li avvicino gradualmente al nuovo valore letto dalla camera, in questo modo evito che la musica cambi in modo troppo brusco se c'è un cambiamento improvviso nella luce o nei colori
//valore nuovo= valore vecchio + (valore letto dalla camera - valore vecchio) * SMOOTH
        smoothLuce += (lum - smoothLuce) * SMOOTH;
        smoothR    += (r   - smoothR)    * SMOOTH;
        smoothG    += (g   - smoothG)    * SMOOTH;
        smoothB    += (b   - smoothB)    * SMOOTH;

        const luceNorm=Math.min(1, Math.max(0, (smoothLuce - LUM_MIN) / (LUM_MAX - LUM_MIN))) //normalizzo la luminosità in base alle soglie min e max, così se è sotto la soglia minima allora è 0 e se è sopra la soglia massima allora è 1, e se è in mezzo allora è un valore tra 0 e 1 che dipende da quanto è luminoso

        controllaSoglie(NumEsattoLuce, luceNorm)//così confronto la luminosità vecchia con quella nuova e vedo se ho superato qualche soglia per attivare i glitch
        NumEsattoLuce= luceNorm

//ora vediamo le percentuali
        lumEl.innerText = `${Math.round(luceNorm * 100)}%`;
        rgbEl.innerText =
            `R: ${Math.round(smoothR * 100)}%  ` +
            `G: ${Math.round(smoothG * 100)}%  ` +
            `B: ${Math.round(smoothB * 100)}%`;

//calcolo il numero di parziali attivi per ogni oscillatore in base ai valori di RGB
        const nR = Math.round(smoothR * MaxParziali);
        const nG = Math.round(smoothG * MaxParziali);
        const nB = Math.round(smoothB * MaxParziali);

        parzialiEl.innerText = `Parziali — R:${nR}  G:${nG}  B:${nB}`;

        aggiornaAudio(luceNorm, nR, nG, nB);


//luce che cambia nello sfondo in base alla luminosità, così da avere anche un feedback visivo del cambiamento di luce, più è luminoso più lo sfondo diventa chiaro, se è buio invece è scuro
aggiornasfondo(luceNorm);

    }, 50);//50 millisecondi vuol dire circa 20 volte al secondo, se aumento troppo rischio di sovraccaricare la CPU
}


/*  AGGIORNAMENTO AUDIO    */

function aggiornaAudio(luce, nR, nG, nB) {
    if (!audioCtx) return;//controllo che l'audio funzioni

    const now = audioCtx.currentTime
    const rampa = 0.15 //rampa per il volume

    

    const nPartials = [nR, nG, nB]
//assegniamo ai synth le parziali attive
    synths.forEach((synth, i) => {
        const nAttive = nPartials[i]

        synth.partials.forEach((p, k) => {//p e k sono array di parziali, k è l'indice che va da 0 a 15, p è l'oggetto che contiene osc e gain di ogni parziale
            const indice = k + 1
            //se l'armonica è dentro il numero attivo suona se no viene spenta
            if (indice <= nAttive) {
                const targetGain = (GainDiBase / indice)
                p.gain.gain.setTargetAtTime(targetGain, now, rampa)
            } else {
                p.gain.gain.setTargetAtTime(0, now, rampa)
            }
        });
    });
}

/*  GLITCH SOGLIE  */


const SOGLIE = {
    0.23: 120,
    0.24: 1400,
    0.25: 600,
    0.26: 440,
    0.27: 340,
    0.28: 900,
    0.29: 270,
    0.30: 300,
    0.31: 1030,
    0.32: 700,
    0.33: 1700,
    0.34: 289,
    0.35: 750,
    0.36: 280,
    0.37: 560,
    0.38: 1400,
    0.39: 1000,
    0.40: 520,
    0.41: 620,
    0.42: 306,
    0.43: 710,
    0.44: 1000,
    0.45: 880,
    0.46: 160,
    0.47: 320,
    0.48: 340,
    0.49: 1666,
    0.50: 350,
    0.51: 850,
    0.52: 1100,
    0.53: 1500,
    0.54: 190,
    0.55: 660,
    0.56: 860,
    0.57: 1260,
    0.58: 1800,
    0.59: 269,
    0.60: 440,
    0.62: 240,
    0.65: 920,
    0.68: 1250,
    0.70: 380,
    0.72: 1600,
    0.75: 240,
    0.78: 480,
    0.80: 200
};

//ora verifico se la luminosità ha superato una soglia, se prima era sotto e adesso è sopra allora attivo un glitch alla frequenza associata a quella soglia, così ogni volta che la luminosità supera una di queste soglie si attiva un glitch diverso
function controllaSoglie(prima, dopo) {
    for (let soglia in SOGLIE) {

        const valoreSoglia = Number(soglia)
        const frequenza = SOGLIE[soglia]

        const eraSotto = prima < valoreSoglia
        const oraSopra = dopo >= valoreSoglia

        if (eraSotto && oraSopra) { //memooooo:&& vuol dire AND quindi devono essere vere entrambe le condizioni, se prima era sotto e adesso è sopra allora attivo il glitch
            glitch(frequenza);
        }
    }
}

function glitch(freq) { //creo un osc a onda quadra che suona per un istante solo la freq assegnata
    if (!audioCtx) return
    const osc  = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    const now  = audioCtx.currentTime

    osc.frequency.value = freq
    osc.type = "square"

    gain.gain.setValueAtTime(0.08, now);//volume del glitch
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12)

    osc.connect(gain)        
    gain.connect(masterGain)
    osc.start(now)         
    osc.stop(now + 0.12) //la durata del suono glitch è di 0.12sec    
}

function tornaMenu() {

    // ferma loop luce
    if (melodiaInterval) {
        clearTimeout(melodiaInterval);
        melodiaInterval = null;
    }

    // ferma camera
    const video = document.getElementById("video");
    if (video && video.srcObject) {//era il collegmanto alla camera
        video.srcObject.getTracks().forEach(track => track.stop())//ferma tutti i canali della camera ovvero il collegmaento audio e video
        video.srcObject = null;
    }

    // ferma e disconnetti tutti gli oscillatori (sintesi additiva)
    if (synths && synths.length > 0) {//se synth esiste e non è vuoto
        synths.forEach(synth => {
            synth.partials.forEach(p => {//p vuol dire ogni elemento qui
                try { p.osc.stop(); } catch(e) {}//prova a fermarlo, se è giò farmo evita di bloccare tutto per questo faccio catch così evito l'errore
                try { p.osc.disconnect(); } catch(e) {}
                try { p.gain.disconnect(); } catch(e) {}
            });
        });
        synths = []//elimino e ripulisco tutti i synth 
    }

    // chiudi il contesto audio
    if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
    }

    // reset variabili globali di smoothing
    smoothLuce = 0;
    smoothR = 0;
    smoothG = 0;
    smoothB = 0;

    mostraPagina('menu');
    
}