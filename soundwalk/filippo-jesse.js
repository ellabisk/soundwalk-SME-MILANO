function creaPianoforte() {
    const pianoforte = document.createElement("div")
    pianoforte.id = "pianoforte"
    pianoforte.className = "page"
                                         //scrivo qui così da non sporcare l'html che invece sarà invece a disposizione di tutti 
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



    <button id="btnTorna" class="btn" onclick="tornaMenu()">Torna indietro</button> 
    `

    document.body.appendChild(pianoforte)
}
