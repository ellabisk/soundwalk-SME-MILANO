const https= require('https')
const fs=require('fs')
const path=require('path')
const keys= {
    key:fs.readFileSync('key.pem'),
    cert:fs.readFileSync('cert.pem')
}

const mimeTypes = {
    '.html': 'text/html',
    '.css':  'text/css',
    '.js':   'application/javascript',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.svg':  'image/svg+xml'
}

const server= https.createServer(keys,(req, res)=>{
let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url)
    const ext = path.extname(filePath)
    const contentType = mimeTypes[ext] || 'text/plain'

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404)
            res.end('File non trovato')
            return
        }
        res.writeHead(200, { 'Content-Type': contentType })
        res.end(data)
    })




    //////////////////////////////// ho tolto la parte seguente se no mi prendeva solo i file html, invece così mi prende qualsiasi cosa ci sia nella cartella public, compresi css e js, è giusto??boh
    //if(req.url ==='/'){
    //    const html=fs.readFileSync(path.join(__dirname,'public','index.html')) //gli dico di andare  a prendere proprio quel file
    //    res.writeHead(200,{'Content-Type':'text/html'})
    //    res.end(html)
    //}
})

server.listen(3001,'0.0.0.0',()=>{
    console.log('Server funziona sulla porta 3001')
})