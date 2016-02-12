
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
                        masterText.doc = {key : strippedKey};
                    }

                    shadow.doc = clone(masterText.doc);
                    shadow.versionAcked = 0;
                    shadow.version = 0;

                    

                    // these cause infinite loops when using save.
                    // I think statebus is stripping client ids out of keys.
                    bus.cache[shadow.key] = shadow;
                    clientbus.pub({key : key, doc: masterText.doc, versionAcked: shadow.versionAcked, version: shadow.version});
                },
            0);
       }else{
            return bus.fetch(key);
        }
        //return {key : key, code: masterText.code, localVersioversion: shadow.localVersion, remoteVersioversion: shadow.remoteVersion};
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

    //clientbus.route_defaults_to (bus)

    function saveIncomingEdits(message){
        
        var strippedKey = message.key.substring('/clientdiff/'.length);

        // The main doc that is what is edited.
        var masterText = bus.fetch('/master/' + strippedKey);

        var shadowkey = 'shadow/' + conn.id + '/' + strippedKey;

        //The shadow copy for the current client
        var shadow = bus.fetch(shadowkey);




        //Initialize any of these if they don't exist
        if(shadow.doc === undefined){
            shadow.doc = {key : strippedKey};
            shadow.version = 0;
            shadow.versionAcked = 0;
        }

        if(masterText.doc === undefined){
            masterText.doc = {key : strippedKey};
        }

        var editHistory = bus.fetch('/edits/' + shadowkey);
        if(editHistory.history === undefined)
            editHistory.history = [];

        //If client is trying to provide edits but haven't received an ack.
        //This probably means client and server had edits in flight at the same time.
        if(message.versionAcked < shadow.versionAcked){

            //Rolling back...
            var restored = clone(shadow);
            for(var i = editHistory.history.length - 1; i >= 0; i--){
                
                var edit = editHistory.history[i];
                if(edit.versionAcked >= message.versionAcked)
                    restored = jsondiffpatch.unpatch(restored, edit.diff);
                else
                    break;

            }

            console.log('Restoring from edit history: ' + shadow.versionAcked);
            shadow.doc = restored.doc;
            shadow.versionAcked = message.versionAcked;
        }

            // //This case means wonky out-of-order stuff happened 
            // //and we should just re-send the whole doc and re-initialize.
            // else{
            //     throw new Error('Docs were out of sync for : ' + conn.id + '\n' + 'The doc id is : ' + strippedKey + '\nversionAcked in message : ' + message.versionAcked + ' , ' + 'versionAcked in shadow : ' + shadow.versionAcked  );
            // }
            
        

        //If the client sent an older version, we can ignore it.
        if(message.version === shadow.version){

            //Now we make patches to the shadow
            //Steps 5a, 5b, and 6 in section 4: https://neil.fraser.name/writing/sync/
            shadow.doc = jsondiffpatch.patch(shadow.doc, message.diff)
            shadow.version++;
            //Save our edit history...
            if(message.diff)
                editHistory.history.push({diff: message.diff, versionAcked: message.versionAcked});

            //Finally we apply patches to our master text: steps 8 and 9
            masterText.doc = jsondiffpatch.patch(masterText.doc, message.diff);
           
        }
        
        for(var clientid in clientbuses[strippedKey]){
            saveOutgoingEdits(clientid, strippedKey);
        }
        

    
        //Woot, we're done...
        bus.cache[shadow.key] = shadow;
        bus.save(editHistory)
        bus.save(masterText)
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


        //Apply the diffs
        var diff = jsondiffpatch.diff(shadow.doc, masterText.doc);
        
        if(diff){
            var message = {key: '/serverdiff/' + strippedKey}
            message.versionAcked = shadow.versionAcked;
            message.version = shadow.version;

            //Add these diffs to the stack we will send
            message.diff = diff;

            //Copy the server text to the shadow
            shadow.doc = clone(masterText.doc);

            //Increment the server text version number
            shadow.versionAcked++;

            //Save everything
            bus.cache[shadow.key] = shadow;

            //Return the edits
            var clientbus = clientbuses[strippedKey][clientid];
            
            clientbus.pub(message)
        }
    }  

}
