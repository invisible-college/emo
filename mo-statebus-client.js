(function () {

    // ****************
    // Connecting over the Network
    function socketio_client (bus, prefix, url) {
        console.log('socketio to', url)
        var socket = io(url)
        var fetched_keys = new Set()

        bus(prefix).on_fetch = function (key) {
            console.log('fetching', key, 'from', url)
            // Error check
            // if (pending_fetches[key]) {
            //     console.error('Duplicate request for '+key)
            //     return
            // }
            // pending_fetches[key] = true
            fetched_keys.add(key)
            socket.emit('fetch', key)
        }

        var saver = bus(prefix).on_save = function (object) {
            console.log('sending save', object)
            socket.emit('save', object)
        }
        bus(prefix).on_delete = function (key)    { socket.emit('delete', key) }
        bus(prefix).on_forget = function (key) {
            socket.emit('forget', key)
            fetched_keys.del(key)
        }

        // Receive stuff
        socket.on('save', function(message) {
            console.log('socketio_client: received SAVE', message.obj.key)
            var obj = message.obj
            //delete pending_fetches[obj.key]
            save(obj, saver)
        })

        socket.on('delete', del)

        // Reconnect needs to re-establish dependencies
        socket.on('reconnect', function() {
            var keys = fetched_keys.all()
            for (var i=0; i<keys.length; i++)
                socket.emit('fetch', keys[i])
        })
    }

    function sockjs_client(prefix, url) {
        var recent_saves = []
        var sock
        var attempts = 0
        var outbox = []
        var fetched_keys = new bus.Set()
        if (url[url.length-1]=='/') url = url.substr(0,url.length-1)
        function send (o) {
            console.log('sockjs.send:', JSON.stringify(o))
            outbox.push(JSON.stringify(o))
            flush_outbox()
        }
        function flush_outbox() {
            if (sock.readyState === 1)
                while (outbox.length > 0)
                    sock.send(outbox.shift())
            else
                setTimeout(flush_outbox, 400)
        }



        bus(prefix).on_save   = function (obj) { send({method: 'save', obj: obj})
                                                 if (window.ignore_flashbacks)
                                                     recent_saves.push(JSON.stringify(obj))
                                                 if (recent_saves.length > 100) {
                                                     var extra = recent_saves.length - 100
                                                     recent_saves.splice(0, extra)
                                                 }
                                               }



        bus(prefix).on_fetch  = function (key) { send({method: 'fetch', key: key}),
                                                 fetched_keys.add(key) }
        bus(prefix).on_forget = function (key) { send({method: 'forget', key: key}),
                                                 fetched_keys.del(key) }
        bus(prefix).on_delete = function (key) { send({method: 'delete', key: key}) }



        function connect () {
            console.log('[ ] trying to open')
            sock = sock = new SockJS(url + '/statebus')
            sock.onopen = function()  {
                console.log('[*] open', sock.protocol)

                var me = fetch('ls/me')
                console.log('connect: me is', me)
                if (!me.client) {
                    me.client = (Math.random().toString(36).substring(2)
                                 + Math.random().toString(36).substring(2)
                                 + Math.random().toString(36).substring(2))
                    save(me)
                }
                send({method: 'save', obj: {key: '/current_user', client: me.client}})

                if (attempts > 0) {
                    // Then we need to refetch everything, cause it
                    // might have changed
                    recent_saves = []
                    var keys = fetched_keys.all()
                    for (var i=0; i<keys.length; i++)
                        send({method: 'fetch', key: keys[i]})
                }

                attempts = 0
            }
            sock.onclose   = function()  {
                console.log('[*] close')
                setTimeout(connect, attempts++ < 3 ? 1500 : 5000)
            }

            sock.onmessage = function(event) {
                // Todo: Perhaps optimize processing of many messages
                // in batch by putting new messages into a queue, and
                // waiting a little bit for more messages to show up
                // before we try to re-render.  That way we don't
                // re-render 100 times for a function that depends on
                // 100 items from server while they come in.  This
                // probably won't make things render any sooner, but
                // will probably save energy.

                //console.log('[.] message')
                try {
                    var message = JSON.parse(event.data)

                    // We only take pubs from the server for now
                    if (message.method.toLowerCase() !== 'pub') throw 'barf'
                    console.log('sockjs_client received', message.obj)

                    var is_recent_save = false
                    if (window.ignore_flashbacks) {
                        var s = JSON.stringify(message.obj)
                        for (var i=0; i<recent_saves.length; i++)
                            if (s === recent_saves[i]) {
                                is_recent_save = true
                                recent_saves.splice(i, 1)
                            }
                        console.log('Msg', message.obj.key,
                                    is_recent_save?'is':'is NOT', 'a flashback')
                    }

                    if (!is_recent_save)
                        bus.pub(message.obj)
                        //setTimeout(function () {bus.pub(message.obj)}, 1000)
                } catch (err) {
                    console.error('Received bad sockjs message from '
                                  +url+': ', event.data, err)
                }
            }

        }
        connect()
    }

    function localstorage_client (prefix) {
        // This doesn't yet trigger updates across multiple browser windows.
        // We can do that by adding a list of dirty keys and 

        var bus = this
        

        // GET returns the value immediately in a PUT
        // PUTs are queued up, to store values with a delay, in batch
        var saves_are_pending = false
        var pending_saves = {}

        function save_the_pending_saves() {
            console.log('localstore: saving', pending_saves)
            for (var k in pending_saves)
                localStorage.setItem(k, JSON.stringify(pending_saves[k]))
            saves_are_pending = false
        }

        bus(prefix).on_fetch = function (key) {
            var result = localStorage.getItem(key)
            return result ? JSON.parse(result) : {key: key}
        }
        bus(prefix).on_save = function (obj) {
            // Do I need to make this recurse into the object?
            console.log('localStore: on_save:', obj.key)
            pending_saves[obj.key] = obj
            if (!saves_are_pending) {
                setTimeout(save_the_pending_saves, 50)
                saves_are_pending = true
            }
            return obj
        }
        bus(prefix).on_delete = function (key) { localStorage.removeItem(key) }


        // Hm... this update stuff doesn't seem to work on file:/// urls in chrome
        function update (event) {
            console.log('Got a localstorage update', event)
            this.get(event.key.substr('statebus '.length))
        }
        if (window.addEventListener) window.addEventListener("storage", update, false)
        else                         window.attachEvent("onstorage", update)
    }

    function handle_sockjs_urls () {
        function get_domain(key) {
            var m = key.match(/^sockjs\:\/\/(([^:\/?#]*)(?:\:([0-9]+))?)/)
            if (!m) throw Error('Bad url: ', key)
            return m[1]
        }
        bus('sockjs://*').on_fetch = function (key) {
            // First look up the connection
            c = connection_for(key)

            // Now ask the connection for it
            return c.fetch(key)
        }
        bus('sockjs://*').on_save = function (o) {
            connection_for(o.key).save(o)
        }
        bus('sockjs://*').on_forget = function (key) {
            connection_for(key).forget(key)
        }
        var connections = {}
        function connection_for (key) {
            var domain = get_domain(key)
            return connections[domain] = connections[domain] || new sockjs_client(domain)
        }

        if (window.slashcut) {
            // Proxy shortcut defined with:
            bus('/*').to_fetch = function (key) {
                return fetch('state://stateb.us' + key)
            }
            bus('/*').to_save = function (obj) {
                save(copy(obj, 'state://stateb.us' + obj.key))
            }

            bus('/*').proxy = function (key) { return 'state://stateb.us' + key }
            bus('/*').proxy('state://stateb.us/*')
            bus.proxy('/*', 'state://stateb.us/*')
        }
    }

    // Stores state in the query string, as ?key1={obj...}&key2={obj...}
    function url_store (prefix) {
        function get_query_string_value (key) {
            return unescape(window.location.search.replace(
                new RegExp("^(?:.*[&\\?]"
                           + escape(key).replace(/[\.\+\*]/g, "\\$&")
                           + "(?:\\=([^&]*))?)?.*$", "i"),
                "$1"))
        }

        // Initialize data from the URL on load
        
        // Now the regular shit
        var data = get_query_string_value(key)
        data = (data && JSON.parse(data)) || {key : key}
        // Then I would need to:
        //  â€¢ Change the key prefix
        //  â€¢ Save this into the cache

        bus(prefix).on_save = function (obj) {
            window.history.replaceState(
                '',
                '',
                document.location.origin
                    + document.location.pathname
                    + escape('?'+key+'='+JSON.stringify(obj)))
        }
    }


    // ****************
    // Wrapper for React Components

    // XXX Currently assumes there's a statebus named "bus" in global
    // XXX scope.

    var components = {}                  // Indexed by 'component/0', 'component/1', etc.
    var components_count = 0
    var dirty_components = {}
    function React_View(component) {
        function wrap(name, new_func) {
            var old_func = component[name]
            component[name] = function wrapper () { return new_func.bind(this)(old_func) }
        }
        
        // Register the component's basic info
        wrap('componentWillMount', function new_cwm (orig_func) {
            if (component.displayName === undefined)
                throw 'Component needs a displayName'
            this.name = component.displayName.toLowerCase().replace(' ', '_')
            this.key = 'component/' + components_count++
            components[this.key] = this

            function add_shortcut (obj, shortcut_name, to_key) {
                delete obj[shortcut_name]
                Object.defineProperty(obj, shortcut_name, {
                    get: function () { return fetch(to_key) },
                    configurable: true })
            }
            add_shortcut(this, 'local', this.key)

            orig_func && orig_func.apply(this, arguments)

            // Make render reactive
            var orig_render = this.render
            this.render = bus.reactive(function () {

                console.assert(this !== window)
                if (this.render.called_directly) {
                    
                    delete dirty_components[this.key]

                    // Register on any keys passed in objects in props.
                    for (k in this.props)
                        if (this.props.hasOwnProperty(k)
                            && this.props[k] !== null
                            && typeof this.props[k] === 'object'
                            && this.props[k].key)
                            
                            fetch(this.props[k].key)
                    
                    // Call the renderer!
                    return orig_render.apply(this, arguments);
                } else {
                    
                    dirty_components[this.key] = true
                    schedule_re_render()

                }
            })
        })

        wrap('componentWillUnmount', function new_cwu (orig_func) {
            orig_func && orig_func.apply(this, arguments)
            // Clean up
            delete bus.cache[this.key]
            delete components[this.key]
            delete dirty_components[this.key]
        })

        component.shouldComponentUpdate = function new_scu (next_props, next_state) {

            // This component definitely needs to update if it is marked as dirty
            if (dirty_components[this.key] !== undefined) return true

            //   Bug: This JSON comparison won't always work --
            //   functions will all stringify to "undefined" for
            //   instance.

            //   Todo: a better way is probably to mark a comopnent
            //   dirty when it receives new props in the
            //   componentWillReceiveProps React method.

            // Otherwise, we'll check to see if its state or props
            // have changed.  We can do so by simply serializing them
            // and then comparing them.  But ignore React's 'children'
            // prop, because it often has a circular reference.
            next_props = bus.clone(next_props); this_props = bus.clone(this.props)
            delete next_props['children']; delete this_props['children']
            return JSON.stringify([next_state, next_props]) !== JSON.stringify([this.state, this_props])
        }
        

        component.loading = function loading () {
            return this.render.is_loading()
        }

        // Now create the actual React class with this definition, and
        // return it.
        var react_class = React.createClass(component)
        var result = function (props, children) {
            props = props || {}
            return (React.version >= '0.12.'
                    ? React.createElement(react_class, props, children)
                    : react_class(props, children))
        }
        // Give it the same prototype as the original class so that it
        // passes React.isValidClass() inspection
        result.prototype = react_class.prototype
        return result
    }
    window.React_View = React_View


    // *****************
    // Re-rendering react components
    var re_render_scheduled = false
    re_rendering = false
    function schedule_re_render() {
        if (!re_render_scheduled) {
            requestAnimationFrame(function () {
                re_render_scheduled = false

                // Re-renders dirty components
                for (var comp_key in dirty_components) {
                    if (dirty_components[comp_key] // Since another component's update might update this
                        && components[comp_key])   // Since another component might unmount this

                        try {
                            re_rendering = true
                            components[comp_key].forceUpdate()
                        }catch(err){
                            //THIS IS PROBABLY WRONG. What I'm doing is removing an element from the
                            //dom when it throws an error. This happens when you are live editing
                            //and the code is not complete, and thus throws an error in react.
                            var elid = components[comp_key]._rootNodeID + '.0'
                            // var el = document.querySelector('[data-reactid=\"' + elid + '\"]')
                            var els = document.querySelectorAll('[id="include"]');
                            var i = 0;
                            
                            while(els.length > 0 && els[i].parentNode && els[i].parentNode.children.length > 0){
                                els[i].parentNode.removeChild(els[i]);
                                i++;
                            }
                                

                            // if(el && el.children.length > 0)
                            //     el.removeChild(el.children[0])
                                // console.log(el)
                            // if(el && el.parentNode){
                            //     el.parentNode.removeChild(el);

                            // }

                            console.error(err)
                        } finally {
                            re_rendering = false
                        }
                }
            })
            re_render_scheduled = true
        }
    }

    // ##############################################################################
    // ###
    // ###  Full-featured single-file app methods
    // ###

    function make_client_statebus_maker () {
        var extra_stuff = ['socketio_client sockjs_client localstorage_client',
                           'handle_sockjs_urls url_store components'].join(' ').split(' ')
        if (window.statebus) {
            var orig_statebus = statebus
            window.statebus = function make_client_bus () {
                var bus = orig_statebus()
                for (var i=0; i<extra_stuff.length; i++)
                    bus[extra_stuff[i]] = eval(extra_stuff[i])
                return bus
            }
        }
    }

    // Check to see if we wanna do the coffee conversions
    var full_featured = false
    var scripts = document.getElementsByTagName("script")
    for (var i=0; i<scripts.length; i++)
        if (scripts[i].getAttribute('type') === 'statebus') {
            full_featured = true
            break
        }

    if (full_featured) load_full_features()
    else               make_client_statebus_maker()

    function load_full_features() {
        console.log('client: Loading full features')

        var js_urls = {
            react: 'https://cdnjs.cloudflare.com/ajax/libs/react/0.12.2/react.js',
            sockjs: 'https://cdn.jsdelivr.net/sockjs/0.3.4/sockjs.min.js',
            statebus: 'https://dl.dropboxusercontent.com/u/1000932/libs/statebus3.1.js',
            coffeescript: 'https://dl.dropboxusercontent.com/u/1000932/libs/coffee-script.js',
            jsondiffpatch: '/jsondiffpatch.js',
            google_diff_match_patch: '/google_diff_match_patch.js'
            //coffeescript: 'https://cdnjs.cloudflare.com/ajax/libs/coffee-script/1.10.0/coffee-script.min.js'
        }
        for (name in js_urls)
            document.write('<script src="' + js_urls[name] + '" charset="utf-8""></script>')

        document.addEventListener('DOMContentLoaded', scripts_ready, false)
    }

    window.statebus_server = window.statebus_server || 'https://stateb.us:3003'
    function scripts_ready () {
        make_client_statebus_maker()
        window.bus = window.statebus()

        improve_react()
        window.dom = {}
        window.ignore_flashbacks = true
        bus.localstorage_client('ls/*')
        bus.sockjs_client ('/*', statebus_server)
        bus('*').on_save = function (obj) { bus.pub(obj)}
        bus('/new/*').on_save = function (o) {
            if (o.key.split('/').length > 3) return

            var old_key = o.key
            o.key = old_key + '/' + Math.random().toString(36).substring(2,12)
            statebus.cache[o.key] = o
            delete statebus.cache[old_key]
            save(o)
        }




        load_coffee()
        var body = window.Body || window.body || window.BODY
        if (body)
            React.render(body(), document.body)
    }


    function diffsync(key, fieldname){

        if(fieldname === undefined)
            fieldname = 'code'

        //When the server notices changes, apply them.
        bus.reactive(
            function(){
                var syncState = fetch('/' + fieldname + '/' + key);
                saveIncomingEdits(syncState, fieldname);
            }
        )();

        //When the client makes changes, send to the server.
        bus.reactive(

            function(){
                var masterText = fetch(key);
                if(masterText[fieldname] === undefined)
                    masterText[fieldname] = '';
                //comparing checksums to prevent loops
                var prevchecksum = fetch('prevchecksum/' + key);
                if(prevchecksum.checksum === undefined)
                    prevchecksum.checksum = JSON.stringify('').hashCode();

                var currchecksum = JSON.stringify(masterText[fieldname]).hashCode();
                var hasChanged = currchecksum !== prevchecksum.checksum;
                if(hasChanged){
                    saveOutgoingEdits(key, fieldname);
                }
            }

        )();

    }

    function improve_react() {
        function capitalize (s) {return s[0].toUpperCase() + s.slice(1)}
        function camelcase (s) { var a = s.split(/[_-]/)
                                 return a.slice(0,1).concat(a.slice(1).map(capitalize)).join('') }

        var css_props = 'background background-attachment background-color background-image background-position background-repeat border border-collapse border-color border-spacing border-style border-width bottom caption-side clear clip color content counter-increment counter-reset cursor direction display empty-cells float font font-family font-size font-style font-variant font-weight height left letter-spacing line-height list-style list-style-image list-style-position list-style-type margin max-height max-width min-height min-width orphans outline outline-color outline-style outline-width overflow padding page-break-after page-break-before page-break-inside position quotes right table-layout text-align text-decoration text-indent text-transform top unicode-bidi vertical-align visibility white-space widows width word-spacing z-index'.split(' ')
        var is_css_prop = {}
        for (var i=0; i<css_props.length; i++)
            is_css_prop[camelcase(css_props[i])] = true

        function better_element(el) {

            return function () {
                var children = []
                var attrs = {style: {}}
                
                for (var i=0; i<arguments.length; i++) {
                    var arg = arguments[i]
                    
                    // Strings and DOM nodes and undefined become children
                    if (typeof arg === 'string'   // For "foo"
                        || arg instanceof String  // For new String()
                        || arg && arg._isReactElement
                        || arg === undefined)
                        children.push(arg)

                    // Arrays append onto the children
                    else if (arg instanceof Array)
                        Array.prototype.push.apply(children, arg)

                    // Pure objects get merged into object city
                    // Styles get redirected to the style field
                    else if (arg instanceof Object)
                        for (k in arg)
                            if (is_css_prop[k])
                                attrs.style[k] = arg[k]        // Merge styles
                    else
                        if (k === 'style')             // Merge insides of style tags
                            for (k2 in arg[k])
                                attrs.style[k2] = arg[k][k2]
                    else
                        attrs[k] = arg[k]          // Or be normal.
                    // else
                    //     console.log("Couldn't parse param", arg)
                }
                if (children.length === 0) children = undefined
                if (attrs['ref'] === 'input')
                    console.log(attrs, children)
                return el(attrs, children)
            }
        }

        for (var el in React.DOM)
            window[el.toUpperCase()] = better_element(React.DOM[el])

        function make_better_input (name, element) {
            window[name] = React.createFactory(React.createClass({
                getInitialState: function() {
                    return {value: this.props.value}
                },
                componentWillReceiveProps: function(new_props) {
                    this.setState({value: new_props.value})
                },
                onChange: function(e) {
                    this.props.onChange && this.props.onChange(e)
                    if (this.props.value)
                        this.setState({value: e.target.value})
                },
                render: function() {
                    var new_props = {}
                    for (var k in this.props)
                        if (this.props.hasOwnProperty(k))
                            new_props[k] = this.props[k]
                    if (this.state.value) new_props.value = this.state.value
                    new_props.onChange = this.onChange
                    return element(new_props)
                }
            }))
        }

        make_better_input("INPUT", React.DOM.input)
        make_better_input("TEXTAREA", React.DOM.textarea)
    }

    // Load the components
    function make_component(name) {
        // Define the component
        window[name] = window.React_View({
            displayName: name,
            render: function () { return window.dom[name].bind(this)()},
            componentDidMount: function () {
                var refresh = window.dom[name].refresh
                refresh && refresh.bind(this)()
            },
            componentWillUnmount: function () {
                var down = window.dom[name].down
                return down && down.bind(this)()
            },
            componentDidUpdate: function () {
                if (!this.initial_render_complete && !this.loading()) {
                    this.initial_render_complete = true
                    var up = window.dom[name].up
                    up && up.bind(this)()
                }
                var refresh = window.dom[name].refresh
                return refresh && refresh.bind(this)()
            },
            shouldComponentUpdate: function (){
                var shouldup = window.dom[name].shouldup
                return shouldup && shouldup.bind(this)()
            },
            getInitialState: function () { return {} }
        })
    }






    function load_coffee_code (code, filename){
        // Compile coffeescript to javascript
        var compiled
        try {
            compiled = CoffeeScript.compile(code,
                                            {bare: true,
                                             sourceMap: true,
                                             filename: filename})
            var v3SourceMap = JSON.parse(compiled.v3SourceMap)
            v3SourceMap.sourcesContent = code
            v3SourceMap = JSON.stringify(v3SourceMap)

            // Base64 encode it
            var js = compiled.js + '\n'
            js += '//@ sourceMappingURL=data:application/json;base64,'
            js += btoa(v3SourceMap) + '\n'
            js += '//@ sourceURL=' + filename
            compiled = js
        } catch (error) {
            if (error.location)
                console.error('Syntax error in '+ filename + ' on line',
                              error.location.first_line
                              + ', column ' + error.location.first_column + ':',
                              error.message)
            else throw error
        }

        if (compiled) {
            // if(!filename.startsWith('/')){
                eval(compiled)
                window.dom = dom
                for (var view in dom){
                    make_component(view)
                }
            // }
        }


    }


    function include (codeUrl){
        //Including plain ol javascript.
            diffsync(codeUrl);
            bus.reactive(
                function (){
                        codeObj = fetch(codeUrl)
                        //I don't want the code that we run to be reactive unless it's specified
                        //This is a way to make sure that happens
                        setTimeout(
                            function(){
                                //save to this object to cue re-rendering the UI after the code changes.
                                includeobj = fetch('include')
                                try{
                                    if(codeObj.code)
                                        load_coffee_code(codeObj.code, codeObj.key)
                                }catch(err){
                                    console.error(err)
                                }

                                save(includeobj)
                            },
                        0)
                

                }
            )()
        
    }


    function load_coffee () {
        var scripts = document.getElementsByTagName("script")
        var filename = window.location.href.substring(window.location.href.lastIndexOf('/') + 1)

        for (var i=0; i<scripts.length; i++)
            if (scripts[i].getAttribute('type') === 'statebus') {
                // Compile coffeescript to javascript
                var compiled
                var code
                // try {

                    if(scripts[i].src)
                    {
                        srcLoc = scripts[i].src.replace('file://', '')
                        include(srcLoc)
                        // filename = srcLoc
                        // codedata = fetch(srcLoc)

                        // if(!codedata.code){
                        //     codedata.code = 'dom.TEST = ->\n\tDIV null,\n\t\t"test"'
                        // }
                        // code = codedata.code
                    }else{

                        code = scripts[i].text
                        if(scripts[i].id !== 'main')
                            load_coffee_code(code, filename)
                        else
                            load_coffee_code(code, 'main')
                    }
                    
                    
                    // compiled = CoffeeScript.compile(code,
                    //                                 {bare: true,
                    //                                  sourceMap: true,
                    //                                  filename: filename})
                    // var v3SourceMap = JSON.parse(compiled.v3SourceMap)
                    // v3SourceMap.sourcesContent = code
                    // v3SourceMap = JSON.stringify(v3SourceMap)

                    // // Base64 encode it
                    // var js = compiled.js + '\n'
                    // js += '//@ sourceMappingURL=data:application/json;base64,'
                    // js += btoa(v3SourceMap) + '\n'
                    // js += '//@ sourceURL=' + filename
                    // compiled = js
                // } catch (error) {
                //     if (error.location)
                //         console.error('Syntax error in '+ filename + ' on line',
                //                       error.location.first_line
                //                       + ', column ' + error.location.first_column + ':',
                //                       error.message)
                //     else throw error
                // }

                // if (compiled) {
                //     eval(compiled)
                //     window.dom = dom
                //     for (var view in dom)
                //         make_component(view)
                // }
            }
    }


//DIFFERENTIAL SYNC CODE
if (!String.prototype.startsWith) {
    String.prototype.startsWith = function(searchString, position){
      position = position || 0;
      return this.substr(position, searchString.length) === searchString;
  };
}

String.prototype.hashCode = function() {
  var hash = 0, i, chr, len;
  if (this.length === 0) return hash;
  for (i = 0, len = this.length; i < len; i++) {
    chr   = this.charCodeAt(i);
    hash  = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
};



function saveIncomingEdits(message, fieldname){
    
    var key = message.key.substring(fieldname.length + 2);


    // The main doc that is what is edited.
    var masterText = bus.cache[key];

    //The shadow copy for the current client
    var shadow = fetch('shadow/' + key);

    //A log of edits that we send to the client.
    var difflog = fetch('difflog/' + key);
    
    if(masterText[fieldname] === undefined){
        masterText[fieldname] = '';
    }

    //Initialize any of these if they don't exist
    if(shadow[fieldname] === undefined){
        shadow[fieldname] = '';
        shadow.remoteVersion = 0;
        shadow.localVersion = 0;

    }

    if(difflog.edits === undefined){
        difflog.edits = [];
    }


    if(message.difflog === undefined){
        //Just reset everything if we received the whole doc.
        difflog.edits = [];
        masterText[fieldname] = message[fieldname];
        shadow[fieldname] = message[fieldname];
        var version = message.remoteVersion || 0;
        shadow.localVersion = version;
        shadow.remoteVersion = version;
    }


    if(message.difflog){
    //Remember that their local version = our remote version and vice versa.
        
        //Let's check if something wacky happened.
        if(message.remoteVersion < shadow.localVersion){
            //This edit is stale, so we can ignore it...
           return;
        }

        else if(message.remoteVersion > shadow.localVersion){
             //TODO: handle this case...
            throw new Error('The diff sync version numbers dont match: ' + message.remoteVersion + ' , ' + shadow.localVersion );
   
        }
        
            //The client told us what version of our edits they've received, 
            //so let's clear those from our own difflog
            difflog.edits = difflog.edits.filter( function(edit){ return edit.localVersion > message.remoteVersion } );


            //Go through the list of edits and try to apply each one...
            for(var patch in message.difflog){
                patch = message.difflog[patch];

                //If the client sent an older version, we can ignore it.
                if(patch.localVersion === shadow.remoteVersion){

                    //Now we make patches to the shadow
                    //Steps 5a, 5b, and 6 in section 4: https://neil.fraser.name/writing/sync/
                    shadow[fieldname] = jsondiffpatch.patch(shadow[fieldname], patch.diff)
                    shadow.remoteVersion = patch.localVersion + 1;

                    //Finally we apply patches to our master text: steps 8 and 9
                    masterText[fieldname] = jsondiffpatch.patch(masterText[fieldname], patch.diff)
                }
            }

            if(!message.noop){
                save({key: '/clientdiff/' + fieldname + '/' + key, remoteVersion: shadow.remoteVersion, difflog: [], noop: true})
            }
    }       
    

    //save the shadow and difflog
    bus.cache[shadow.key] = shadow;
    bus.cache[difflog.key] = difflog;

    //Compute a checksum on the doc to prevent loops.
    var prevchecksum = fetch('prevchecksum/' + key);
    prevchecksum.checksum = JSON.stringify(masterText[fieldname]).hashCode();
    bus.cache[prevchecksum.key] = prevchecksum;

    console.log(masterText);
    save(masterText);
}


    //Let's compare a shadow for a client with our current version
    //Returns an  object that contains the client text version
    //along with a stack of edits that the server should apply.
    //This also increments the server text version #, saves
    //the stack of edits to state, and updates the shadow to
    //reflect the current server text and it's version #.
    function saveOutgoingEdits(key, fieldname){
        
        var masterText = fetch(key);

        //get the shadow corresponding to this client
        var shadow = fetch('shadow/' + key);

        //Apply the diffs
        var diff = jsondiffpatch.diff(shadow[fieldname], masterText[fieldname]);

        //Add these diffs to the stack we will send
        diff = {diff: diff, localVersion: shadow.localVersion}
        var difflog = fetch('difflog/' + key);


        if(difflog.edits === undefined)
            difflog.edits = [];

        difflog.edits.push( diff );
        

        //Copy the text to the shadow
        shadow[fieldname] = masterText[fieldname];

        //Increment the shadow version number
        shadow.localVersion++;

        //Save everything
        bus.cache[shadow.key] = shadow;
        bus.cache[difflog.key] = difflog;
        var edits = {key: '/clientdiff/' + fieldname + '/' + key};
        edits.remoteVersion = shadow.remoteVersion;
        edits.difflog = difflog.edits;
        save(edits);
    }


})()