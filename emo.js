var bus = require('statebus-server')(),
    express = require('express'),
    app = express(),
    fs = require('fs'),
    path = require('path'),
    jsondiffpatch = require('jsondiffpatch'),
    dialogo = require('dialogo')

// ##############
// Setup the HTTP server

if (fs.existsSync('certs')) {
    // Load with TLS/SSL
    console. log('Encryption ON')
    var https = require('https')
    var ssl_options = {
        key:  fs.readFileSync('certs/private-key'),
        cert: fs.readFileSync('certs/certificate'),
        ciphers: 'ECDHE-RSA-AES256-SHA:RC4-SHA:RC4:HIGH:!MD5:!aNULL:!EDH:!AESGCM',
        honorCipherOrder: true}
    var server = https.createServer(ssl_options, app)
}
else {
    // Load unencrypted server
    console.log('Encryption off')
    var http = require('http')
    var server = http.createServer(app)
}

server = server.listen(3000, function () {
    var host = server.address().address
    var port = server.address().port
    console.log('Listening at https://%s:%s', host, port)
    
})


bus.file_store('/*', 'db', 'backups') // Save our cache across server restarts
bus.sockjs_server(server, userbusfunk) // Accept statebus network connections
bus('*').on_save = function (obj) {  bus.pub(obj) } // Everything is shared w/ no security


// ##############
// HTTP routes go here
function send_file (name) {
    return function (req, res) {
	res.sendFile(path.join(__dirname, '.', name)) }
}

app.get('/',                      send_file('emo.html'))
app.get('/mo-statebus-client.js', send_file('mo-statebus-client.js'))
app.get('/emo/:codeUrl',          send_file('emo.html') )
app.get('/jsondiffpatch.js',      send_file('jsondiffpatch.js'))
app.get('/google_diff_match_patch.js', send_file('google_diff_match_patch.js'))
app.get('/dialogo.js',            send_file('dialogo.js'))

var peers = {}
var storage = new dialogo.Storage();
if (!String.prototype.startsWith) {
    String.prototype.startsWith = function(searchString, position){
      position = position || 0;
      return this.substr(position, searchString.length) === searchString;
  };
}

function copy(obj){
    return JSON.parse(JSON.stringify(obj));
}

// we want to create a bus for each client
// this will let us do collaborative edits
// cuz we can keep a shadow for each client
function userbusfunk (clientbus, conn){
    // clientbus.serves_auth(conn, bus)

    clientbus('/serverdiffsync/*').on_fetch = function (key){


        if(peers[key] === undefined){
            peers[key] = {}
        }

        if(peers[key][conn.id] === undefined){
            peers[key][conn.id] = new dialogo.Peer('server/' + key);
            var peer = peers[key][conn.id];
            peer.storage = storage;

            peer.on('message', function(message){
                clientbus.pub({key: key, message : message);
            });

            peer.on('change', function(){
                var cpy = peer.document.root.clone();
                cpy.key = '/diffsync/' + cpy.key;
                save(cpy);
            });
        }
    }

    clientbus('/clientdiffsync/*').on_save = function(syncstate){

        var key = '/serverdiffsync/' + syncstate.key.substring('/clientdiffsync/'.length);
        var peer = peers[key][conn.id];
        if(syncstate.message){
            peer.receive(syncstate.message);
        }
    }




 

    
}