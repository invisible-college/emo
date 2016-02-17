
var bus = require('statebus-server')(),
    express = require('express'),
    app = express(),
    fs = require('fs'),
    path = require('path'),
    jsondiffpatch = require('jsondiffpatch')

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
                    var masterText = bus.fetch('/master/' + strippedKey);

                    //The shadow copy for the current client
                    var shadowkey = 'shadow/' + conn.id + '/' + strippedKey;
                    var shadow = bus.fetch(shadowkey);

                    if(masterText.doc == undefined){
                        masterText.doc = {};
                        bus.cache[masterText.key] = masterText;
                    }

                    shadow.doc = clone(masterText.doc);
                    shadow.serverVersion = 0;
                    shadow.clientVersion = 0;


                    

                    // these cause infinite loops when using save.
                    // I think statebus is stripping client ids out of keys.
                    bus.cache[shadow.key] = shadow;
                    clientbus.pub({key : key, doc: masterText.doc, serverVersion: shadow.serverVersion, clientVersion: shadow.clientVersion});
                },
            0);
       }else
            return bus.fetch(key);
       
    }

    clientbus('*').on_forget = function(key){
        if(key.startsWith('/serverdiff/')){
            forgetClientForDiffSync(conn.id, key.substring('/serverdiff/'.length))
        }
    }

    clientbus('/clientdiff/*').on_save = function(obj){
        var strippedKey = obj.key.substring('/clientdiff/'.length);
        if(!clientbuses[strippedKey] || !clientbuses[strippedKey][conn.id])
            return;


        saveIncomingEdits(obj);
        
    }

    clientbus('/master/*').on_save = function(obj){
        console.log('WTF');
        bus.save(obj);
    }

    //clientbus.route_defaults_to (bus)

    function saveIncomingEdits(message){
        
        var strippedKey = message.key.substring('/clientdiff/'.length);

        // The main doc that is what is edited.
        var masterText = bus.fetch('/master/' + strippedKey);

        console.log('BEFORE')
        console.log(masterText.doc)

        var shadowkey = 'shadow/' + conn.id + '/' + strippedKey;

        //The shadow copy for the current client
        var shadow = bus.fetch(shadowkey);


        //Initialize any of these if they don't exist
        if(shadow.doc === undefined){
            shadow.doc = {};
            shadow.clientVersion = 0;
            shadow.serverVersion = 0;
        }

        if(masterText.doc === undefined){
            masterText.doc = {};
        }

        var editHistory = bus.fetch('edits/' + shadowkey);
        if(editHistory.history === undefined)
            editHistory.history = [];

        //If client is trying to provide edits but haven't received an ack.
        //This probably means client and server had edits in flight at the same time.
        if(message.serverVersion < shadow.serverVersion){
            

            //Rolling back...
            var restored = clone(shadow);
            var couldRestore = false;

            var history = editHistory.history;

            //There should always be history??
            while(history.length > 0 && history[history.length - 1].serverVersion >= message.serverVersion){

                var edit = history.pop()
                restored.doc = jsondiffpatch.unpatch(restored.doc, edit.diff);
                couldRestore = true;
            }
            

            if(!couldRestore){
                console.log(message.serverVersion + ' , ' + shadow.serverVersion);
                console.log(message.clientVersion + ' , ' + shadow.clientVersion)
                console.log(history[history.length - 1].serverVersion)
                throw new Error('COULD NOT RESTORE')
            }
            
            shadow.doc = restored.doc;
            shadow.serverVersion = message.serverVersion;
            shadow.clientVersion = message.clientVersion;

            bus.cache[shadow.key] = shadow;
            bus.cache[editHistory.key] = editHistory;
        }

        

        
        if(message.clientVersion === shadow.clientVersion){

            //Now we make patches to the shadow
            shadow.doc = jsondiffpatch.patch(shadow.doc, message.diff)
            shadow.clientVersion++;

            //Finally we apply patches to our master text: steps 8 and 9
            console.log('BEFORE')
            console.log(masterText.doc)
            masterText.doc = jsondiffpatch.patch(masterText.doc, message.diff);
            console.log('AFTER')
            console.log(masterText.doc)
            bus.cache[shadow.key] = shadow;
            bus.cache[masterText.key] = masterText;
        }
        
        for(var clientid in clientbuses[strippedKey]){
            saveOutgoingEdits(clientid, strippedKey);
        }

    }


    //Let's compare a shadow for a client with our current version
    //Returns an  object that contains the server text version
    //along with a stack of edits that the client should apply.
    //This also increments the server text version #, saves
    //the stack of edits to state, and updates the shadow to
    //reflect the current server text and it's version #.
    function saveOutgoingEdits(clientid, strippedKey){


        //Get the server text
        var masterText = bus.fetch('/master/' + strippedKey);


        //get the shadow corresponding to this client
        var shadow = bus.fetch('shadow/' + clientid + '/' + strippedKey);

        //get the edits that we make in case we need to roll back.
        var editHistory = bus.fetch('edits/' + shadow.key);
        if(editHistory.history === undefined)
            editHistory.history = [];
            

        //Apply the diffs
        var diff = jsondiffpatch.diff(shadow.doc, masterText.doc);
        
        if(diff){
            var message = {key: '/serverdiff/' + strippedKey}
            message.serverVersion = shadow.serverVersion;
            message.clientVersion = shadow.clientVersion;

            //Update the edit history
            editHistory.history.push({diff: message.diff, serverVersion: message.serverVersion});

            //Increment the server text version number
            shadow.serverVersion++;

            //Add these diffs to the stack we will send
            message.diff = diff;

            //Copy the server text to the shadow
            shadow.doc = clone(masterText.doc);

            //Save everything
            bus.cache[shadow.key] = shadow;
            bus.cache[editHistory.key] = editHistory;
            //Return the edits
            var clientbus = clientbuses[strippedKey][clientid];

            clientbus.pub(message)
        }
    }  

}
