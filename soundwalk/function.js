//function vaiMenu() {
   // document.getElementById("home").classList.add("hidden");
   // document.getElementById("menu").classList.remove("hidden");
//}

//function vaiPagina(num) {


  //  document.getElementById("menu").classList.add("hidden");
    
   // if (num===1){///in questo modo facendo la stessa con ===agli altri numri si posso richiamare le pagine create dagli altri
     //   creaPianoforte();
//} else if (num===2){///in questo modo facendo la stessa con ===agli altri numri si posso richiamare le pagine create dagli altri
    //    creaCorridoio();
    //} else if (num===3){
      //  crea129();

//} else{
   // document.getElementById("contenuto").classList.remove("hidden");

//}
//}


function mostraPagina(id) {

    document.querySelectorAll(".page").forEach(p => {
        p.classList.add("hidden");
    });

    const target = document.getElementById(id);
    if (target) {
        target.classList.remove("hidden");
    }

    if (id === "pianoforte" && !target.dataset.creato) {
        creaPianoforte();
        target.dataset.creato = "true";
    }

    if (id === "corridoio") {
        setTimeout(() => {
            if (typeof avviaCorridoioInit === "function") {
                avviaCorridoioInit();
            }
        }, 100);
    }

    if (id === "pianoforte") {
        setTimeout(() => {
            if (typeof avviaPianoforteInit === "function") {
                avviaPianoforteInit();
            }
        }, 100);
    }
}