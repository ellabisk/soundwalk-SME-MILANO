function creaPianoforte() {
    const pianoforte = document.getElementById("pianoforte");

    pianoforte.innerHTML = `
    <div class="header">
        <p class="sottotitolo">Installazione interattiva</p>
        <h1>Visual Soundwalk</h1>
        <div class="divisore"></div>
        <p class="descrizione">
            SUONAAAAAAAAA.
        </p>
    </div>

    <button id="btnAvvia" class="btn center" onclick="avviaPianoforte()">Avvia</button>

    <button id="btnTorna" class="btn" onclick="mostraPagina('menu')">Torna indietro</button>
    `;
}