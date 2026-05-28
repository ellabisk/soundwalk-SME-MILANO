function crea129() {
    const aula129 = document.createElement("div")
    aula129.id = "aula129"
    aula129.className = "page"

    aula129.innerHTML = `
    <div class="header">
        <p class="sottotitolo">Installazione interattiva</p>
        <h1>Visual Soundwalk</h1>
        <div class="divisore"></div>
        <p class="descrizione">
           Guarda! Una finestra.
        </p>
    </div>

    <button id="btnAvvia129" onclick="avvia129()">Avvia</button>

    <div id="scene">
        <img id="room" src="img/classroom.png">

        <div id="window">
            <video autoplay muted loop>
                <source src="video/seasons.mp4">
            </video>
        </div>

        <button id="startAudio">enter</button>
    </div>

    <button onclick="tornaMenu()">← torna indietro</button>
    `

    document.body.appendChild(aula129)
}