function vaiMenu() {
    document.getElementById("home").classList.add("hidden");
    document.getElementById("menu").classList.remove("hidden");
}

function vaiPagina(num) {


    document.getElementById("menu").classList.add("hidden");
    
    if (num===1){///in questo modo facendo la stessa con ===agli altri numri si posso richiamare le pagine create dagli altri
        creaPianoforte();
} else{
    document.getElementById("contenuto").classList.remove("hidden");

    document.getElementById("titolo").innerText = "Pagina bottone " + num;
}


    if (num===3){
        crea129()
} else{
    document.getElementById("contenuto").classList.remove("hidden");

    //document.getElementById("titolo").innerText = "Pagina bottone " + num;
}

    if (num===5){///in questo modo facendo la stessa con ===agli altri numri si posso richiamare le pagine create dagli altri
        creaCorridoio();
} else{
    document.getElementById("contenuto").classList.remove("hidden");

    document.getElementById("titolo").innerText = "Pagina bottone " + num;
}
}





