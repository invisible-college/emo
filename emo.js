
var bus = require('statebus-server')(),
    express = require('express'),
    app = express(),
    fs = require('fs'),
    path = require('path'),
    jsondiffpatch = require('jsondiffpatch'),
    urlParse = require('url')

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

var https = require('https')
// var options = {  host: 'npmcdn.com', path: '/three@0.74.0'}
// var callback = function(response) {
//   var str = '';

//   //another chunk of data has been recieved, so append it to `str`
//   response.on('data', function (chunk) {
//     str += chunk;
//   });

//   //the whole response has been recieved, so we just print it out here
//   response.on('end', function () {
//     console.log(str);
//   });
// }

// var request = https.request(options, callback).end();



function requestCode(url, callback){

    var parsedurl = urlParse.parse(url)
    var options = {'host' : parsedurl.hostname, port: parsedurl.port, path: parsedurl.path}

    var protocol = http;
    if(parsedurl.protocol === 'https:')
        protocol = https;

    var cb = function(response){
          var str = '';

          //another chunk of data has been recieved, so append it to `str`
          response.on('data', function (chunk) {
            str += chunk;
          });

          //the whole response has been recieved, so we just print it out here
          response.on('end', function () {
            callback(str);
          });
    }

    protocol.request(options, cb).end();
}


 



bus.file_store('/*', 'db', 'backups') // Save our cache across server restarts
bus.sockjs_server(server, userbusfunk) // Accept statebus network connections
bus('*').on_save = function (obj) {  bus.pub(obj) } // Everything is shared w/ no security


// ##############
// HTTP routes go here
function send_file (name) {
    return function (req, res) {
    res.sendFile(path.join(__dirname, '.', name)) }
}

if (!String.prototype.endsWith) {
    Object.defineProperty(String.prototype, 'endsWith', {
        enumerable: false,
        configurable: false,
        writable: false,
        value: function (searchString, position) {
            position = position || this.length;
            position = position - searchString.length;
            var lastIndex = this.lastIndexOf(searchString);
            return lastIndex !== -1 && lastIndex === position;
        }
    });
}

app.get('/',                           send_file('emo.html'))
app.get('/emo/:codeUrl',               send_file('emo.html') )
app.get('/jsondiffpatch.js',           send_file('jsondiffpatch.js'))
app.get('/google_diff_match_patch.js', send_file('google_diff_match_patch.js'))
app.get('/textwidget/:codeUrl',        send_file('textwidget.html'))

app.get('/scripts/:subdir?/:filename',          
    function(req, res){ 
        var filename = req.params.filename;
        var subdir = ''
        if (!filename.endsWith('.js'))
            filename += '.js';
        if(req.params.subdir)
            subdir = req.params.subdir + '/'
        return send_file('scripts/' + subdir + filename)(req, res) 

    }
);
app.get('/lib/:filename',          
    function(req, res){ 
        var filename = req.params.filename;
        if (!filename.endsWith('.js'))
            filename += '.js';
        return send_file('scripts/lib/' + filename)(req, res) 

    }
);


bus.diffPatcher = new jsondiffpatch.create({textDiff : {minLength : 1}});


bus('/url/*').on_fetch = function(key){
    key = key.substring('/url/'.length);

    if(key.startsWith('http')){

        var callback = function(str){ bus.pub({key : '/url/' + key, content: str}) }
        requestCode(key, callback);
    }
}


if (!String.prototype.startsWith) {
    String.prototype.startsWith = function(searchString, position){
      position = position || 0;
      return this.substr(position, searchString.length) === searchString;
  };
}

function clone(obj){
    return JSON.parse(JSON.stringify(obj))
}

var clientbuses = {}
function rememberClientForDiffSync(clientid, clientbus, diffsynckey){

    if(clientbuses[diffsynckey] === undefined)
        clientbuses[diffsynckey] = {}

    clientbuses[diffsynckey][clientid] = clientbus;
}

function forgetClientForDiffSync(clientid, diffsynckey){
    delete clientbuses[diffsynckey][clientid];
}




// we want to create a bus for each client
// this will let us do collaborative edits
// cuz we can keep a shadow for each client
function userbusfunk (clientbus, conn){
    // clientbus.serves_auth(conn, bus)

    clientbus('*').on_fetch = function (key){

        if(key.startsWith('/serverdiff/')){
            var strippedKey = key.substring('/serverdiff/'.length)

            rememberClientForDiffSync(conn.id, clientbus, strippedKey);

            setTimeout(
                function(){
                    
                    // The main doc of what is edited.
                    var shared = bus.fetch('/' + strippedKey);

                    //The shadow copy for the current client
                    var shadowkey = 'shadow/' + conn.id + '/' + strippedKey;
                    var shadow = bus.fetch(shadowkey);
                    


                    if(shared.doc == undefined){
                        shared.doc = {key : strippedKey};
                    }

                    shadow.doc = clone(shared.doc);

                    // these cause infinite loops when using save.
                    // I think statebus is stripping client ids out of keys.
                    bus.cache[shadow.key] = shadow;
                    clientbus.pub({key : key, doc: shared.doc});
                },
            0);
       }else{
            return bus.fetch(key)
        }

    }

    clientbus('*').on_forget = function(key){
        if(key.startsWith('/serverdiff/')){
            var strippedKey = key.substring('/serverdiff/'.length)
            forgetClientForDiffSync(conn.id, strippedKey)
            var shared = fetch('/' + strippedKey);
            console.log(shared)
            if(shared.doc.cursors){
                delete shared.doc.cursors
                save(shared);
            }
        // }
        }else if(key.startsWith('/cursors/')){
            var cursors = fetch(key);
            if(cursors.cursors){
                delete cursors.cursors
                save(cursors);
            }
        }
    }


    clientbus('*').on_save = function(obj){
        if(!obj.key.startsWith('/clientdiff/')){
            bus.save(obj)
        }
    }

    clientbus('/clientdiff/*').on_save = function(obj){
        var strippedKey = obj.key.substring('/clientdiff/'.length);
        if(!clientbuses[strippedKey] || !clientbuses[strippedKey][conn.id])
            return;
        saveIncomingEdits(obj);
    }



    function saveIncomingEdits(message){
        
        var strippedKey = message.key.substring('/clientdiff/'.length);

        // The main doc that is what is edited.
        var shared = bus.fetch('/' + strippedKey);

        var shadowkey = 'shadow/' + conn.id + '/' + strippedKey;

        //The shadow copy for the current client
        var shadow = bus.fetch(shadowkey);


        //Initialize any of these if they don't exist
        if(shadow.doc === undefined){
            shadow.doc = {key : strippedKey};
        }

        if(shared.doc === undefined){
            shared.doc = {key : strippedKey};
            bus.save(shared)
        }


        //If the client sent an older version, we can ignore it.
        if(message.diff){
            shadow.doc = bus.diffPatcher.patch(shadow.doc, message.diff)
            shared.doc = bus.diffPatcher.patch(shared.doc, message.diff)
            bus.save(shared)
        }
        
        
        bus.cache[shadow.key] = shadow;
        
        saveOutgoingEdits(conn.id, strippedKey);
    }


    //Let's compare a shadow for a client with our current version
    //Returns an  object that contains the server text version
    //along with a stack of edits that the client should apply.
    //This also increments the server text version #, saves
    //the stack of edits to state, and updates the shadow to
    //reflect the current server text and it's version #.
    function saveOutgoingEdits(clientid, strippedKey){


        //Get the server text
        var shared = bus.fetch('/' + strippedKey);

        //get the shadow corresponding to this client
        var shadow = bus.fetch('shadow/' + clientid + '/' + strippedKey);

        //Apply the diffs
        var diff = bus.diffPatcher.diff(shadow.doc, shared.doc);
        
        //Return the edits
        var clientbus = clientbuses[strippedKey][clientid];
        var message = {key: '/serverdiff/' + strippedKey}

        if(diff){

            //Add these diffs to the stack we will send
            message.diff = diff;

            //Copy the server text to the shadow
            shadow.doc = clone(shared.doc);

            //Save everything
            bus.cache[shadow.key] = shadow;

        }

        clientbus.pub(message)
    }  

}