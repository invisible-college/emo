
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

var clientbuses = {}
if (!String.prototype.startsWith) {
    String.prototype.startsWith = function(searchString, position){
      position = position || 0;
      return this.substr(position, searchString.length) === searchString;
  };
}

function clone(obj){
    return JSON.parse(JSON.stringify(obj))
}

// we want to create a bus for each client
// this will let us do collaborative edits
// cuz we can keep a shadow for each client
function userbusfunk (clientbus, conn){
    // clientbus.serves_auth(conn, bus)

    clientbus('/serverdiff/*').on_fetch = function (key){

        var strippedKey = key.substring('/serverdiff/'.length)

        if(clientbuses[strippedKey] === undefined)
            clientbuses[strippedKey] = {}

        clientbuses[strippedKey][conn.id] = clientbus;

        setTimeout(
            function(){
                console.log('ON FETCH')
                // The main doc of what is edited.
                var masterText = bus.fetch('/master/' + strippedKey);

                //The shadow copy for the current client
                var shadowkey = 'shadow/' + conn.id + '/' + strippedKey;
                var shadow = bus.fetch(shadowkey);
                
                //The backup copy in case the client loses a packet from us
                var backup = bus.fetch('backup/' + shadowkey);

                //A log of edits that we send to the client.
                var difflog = bus.fetch('difflog/' + shadowkey);

                if(masterText.doc == undefined){
                    masterText.doc = {key : strippedKey};
                }

                shadow.doc = clone(masterText.doc);
                shadow.m = 0;
                shadow.n = 0;
                backup.doc = clone(shadow.doc);
                backup.m = 0;
                difflog.edits = [];

                

                // these cause infinite loops when using save.
                // I think statebus is stripping client ids out of keys.
                bus.cache[difflog.key] = difflog;
                bus.cache[backup.key] = backup;
                bus.cache[shadow.key] = shadow;
                clientbus.pub({key : key, doc: masterText.doc, m: shadow.m, n: shadow.n});
            },
        0);
       
        //return {key : key, code: masterText.code, localVersion: shadow.localVersion, remoteVersion: shadow.remoteVersion};
    }

    clientbus('/clientdiff/*').on_save = function(obj){
        console.log('RECEIVING CLIENT DIFF');
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

        //The backup copy in case the client loses a packet from us
        var backup = bus.fetch('backup/' + shadowkey);

        //A log of edits that we send to the client.
        var difflog = bus.fetch('difflog/' + shadowkey)

        //Initialize any of these if they don't exist
        if(shadow.doc === undefined){
            shadow.doc = {key : strippedKey};
            shadow.n = 0;
            shadow.m = 0;
        }

        if(masterText.doc === undefined){
            masterText.doc = {key : strippedKey};
        }

        if(backup.doc == undefined){
            backup.doc = {key : strippedKey};
            backup.m = 0;
        }

        if(difflog.edits === undefined){
            difflog.edits = [];
        }


        if(message.difflog){

            console.log('DIFFS');

            //Remember that their local version = our remote version and vice versa.
            

            //The client told us what version of our edits they've received, 
            //so let's clear those from our difflog
            difflog.edits = difflog.edits.filter( function(edit){ return edit.m > message.m } );

            //Let's check if something wacky happened.
            //We can see if the client lost the previous response
            //Which we can restore. Otherwise we gotta reset.
            //Step 4 in the diagram in section 4: https://neil.fraser.name/writing/sync/
            if(message.m !== shadow.m){
                if(backup.m == message.m && shadow.n == backup.m){
                    //The client lost the previous response.
                    console.log('RESTORING FROM BACKUP: ' + shadow.m);
                    //We need to clear our edit history.
                    difflog.edits = [];

                    //And restore the doc from the backup.
                    shadow.doc = clone(backup.doc);
                    shadow.m = backup.m;

                    //restore the doc from the backup.
                    clientbus.pub({key: '/serverdiff/' + strippedKey, doc: shadow.doc, m: shadow.m, n: shadow.n});
                }

                //This case means wonky out-of-order stuff happened 
                //and we should just re-send the whole doc
                //and re-initialize.
                else{
                    console.log('Docs were out of sync for : ' + conn.id + '\n' + 'The doc id is : ' + strippedKey );
                    shadow.doc = clone(masterText.doc);
                    shadow.m = 0;
                    shadow.n = 0;
                    backup.doc = clone(shadow.doc);
                    backup.m = shadow.m;
                    difflog.edits = [];
                    bus.cache[backup.key] = backup;
                    bus.cache[shadow.key] = shadow;
                    bus.cache[difflog.key] = difflog;

                    clientbus.pub({key: '/serverdiff/' + strippedKey, doc: shadow.doc, m: shadow.m, n: shadow.n});
                    return;
                }
                
            }

            // //We don't need to do anything in this case - we already received this version number...
            // if(message.remoteVersion < shadow.localVersion)
            //     return;

            //Go through the list of edits and try to apply each one...
            
            for(var patch in message.difflog){

                patch = message.difflog[patch];
                console.log(patch.n + ' , ' + shadow.n);
                //If the client sent an older version, we can ignore it.
                if(patch.n === shadow.n){

                    //Now we make patches to the shadow
                    //Steps 5a, 5b, and 6 in section 4: https://neil.fraser.name/writing/sync/
                    shadow.doc = jsondiffpatch.patch(shadow.doc, patch.diff)
                    shadow.n++;
                    console.log('UPDATING SHADOW VERSION N TO: ' + shadow.n)
                    //Now we update our backup, Step 7
                    backup.doc = clone(shadow.doc);
                    backup.m = shadow.m;

                    //Finally we apply patches to our master text: steps 8 and 9
                    masterText.doc = jsondiffpatch.patch(masterText.doc, patch.diff);
                   
                }
            }
            
            if(!message.noop){
                //Respond to the client...
                clientbus.pub({key: '/serverdiff/' + strippedKey, n: shadow.n, difflog: [], noop: true})


                //Update all the other clients.
                for(var client in clientbuses[strippedKey]){
                    
                    var topub;
                    if(client !== conn.id){
                        console.log('SENDING CHANGES TO CLIENT....' + clientbuses[strippedKey][client])
                        saveOutgoingEdits(client, strippedKey);
                        
                    }
                }
            }
        }


        //Woot, we're done...
        bus.cache[backup.key] = backup;
        bus.cache[shadow.key] = shadow;
        bus.cache[difflog.key] = difflog;
        save(masterText)
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

        var difflog = bus.fetch('difflog/' + shadow.key);

        if(difflog.edits === undefined){
            difflog.edits = [];
        }


        //Apply the diffs
        var diff = jsondiffpatch.diff(shadow.doc, masterText.doc);
        console.log('SENDING DIFFS TO : ' + clientid)

        if(diff){

            //Add these diffs to the stack we will send
            diff = {diff: diff, m: shadow.m}



            difflog.edits.push( diff );

            //Copy the server text to the shadow
            shadow.doc = clone(masterText.doc);

            //Increment the server text version number
            shadow.m++;

            //Save everything
            bus.cache[shadow.key] = shadow;
            bus.cache[difflog.key] = difflog;

            //Return the edits
            var clientbus = clientbuses[strippedKey][clientid];   
        }

        clientbus.pub({key: '/serverdiff/' + strippedKey, n: shadow.n, difflog: difflog.edits})
    }  

}

