const {app, BrowserWindow, ipcMain, Menu, Tray } = require('electron');
const { networkInterfaces } = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const net = require('net');
WSC = require("./WSC.js");

//let tray //There seem to be problems with the tray discarding. Could you take a look at it?

console = function(old_console) {
    return {
        log: function() {
            var args = Array.prototype.slice.call(arguments);
            old_console.log.apply(old_console, args);
            if (mainWindow) {
                try { // Sending large values may not work... How can we fix this? UPDATE - It isnt because of large variables, it is because the log contains a function
                    mainWindow.webContents.send('console', {args: args, method: 'log'});
                } catch(e) {
                    old_console.error('failed to send log')
                }
            }
        },
        warn: function() {
            var args = Array.prototype.slice.call(arguments);
            old_console.warn.apply(old_console, args);
            if (mainWindow) {
                try {
                    mainWindow.webContents.send('console', {args: args, method: 'warn'});
                } catch(e) {
                    old_console.error('failed to send log')
                }
            }
        },
        error: function() {
            var args = Array.prototype.slice.call(arguments);
            old_console.error.apply(old_console, args);
            if (mainWindow) {
                try {
                    mainWindow.webContents.send('console', {args: args, method: 'error'});
                } catch(e) {
                    old_console.error('failed to send log')
                }
            }
        },
        assert: function() {
            var args = Array.prototype.slice.call(arguments);
            old_console.assert.apply(old_console, args);
            if (mainWindow) {
                try {
                    mainWindow.webContents.send('console', {args: args, method: 'assert'});
                } catch(e) {
                    old_console.error('failed to send log')
                }
            }
        }
    }
} (console);

const quit = function(event) {
    isQuitting = true;
    //if (tray) {
    //    tray.destroy()
    //}
    app.quit()
};

function getIPs() {
    let ifaces = networkInterfaces();
    var ips = [ ]
    for(var k in ifaces) {
        for (var i=0; i<ifaces[k].length; i++) {
            if (! (ifaces[k][i].address.startsWith('fe80:') || ifaces[k][i].address.startsWith('::') || ifaces[k][i].address.startsWith('127.0'))) {
                ips.push(ifaces[k][i].address)
            }
        }
    }
    return ips
}

let mainWindow;
var config = {};

if (!app.requestSingleInstanceLock()) {
    app.quit()
}

app.on('second-instance', function (event, commandLine, workingDirectory) {
    if (mainWindow) {
        mainWindow.show();
    }
})

app.on('ready', function() {
    /**
    tray = new Tray('images/icon.ico')
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Show', click:  function(){ if (mainWindow) {mainWindow.show()} } },
      { label: 'Exit', click:  function(){ quit() } }
    ])
    tray.setToolTip('Simple Web Server')
    tray.setContextMenu(contextMenu)
    tray.on('click', function(e){
        if (mainWindow) {
            mainWindow.show();
        }
    })
    */
    try {
        config = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), "config.json")));
    } catch(error) {
        config = {};
    }
    createWindow();
    startServers();
})

app.on('window-all-closed', function () {
    if (config.background !== true) {
        //if (tray) {
        //    tray.destroy()
        //}
        app.quit()
    } else {
        //Stay running even when all windows closed
        if (process.platform === "darwin") {
            app.dock.hide();
        }
    }
})

var isQuitting = false;

ipcMain.on('quit', quit)

ipcMain.on('saveconfig', function(event, arg1) {
    for (var i=0; i<arg1.servers.length; i++) {
        arg1.servers[i].https = true
        if (arg1.servers[i].https) {
            if (! arg1.servers[i].cert || ! arg1.servers[i].key) {
                var crypto = WSC.createCrypto()  // Create HTTPS crypto
                arg1.servers[i].key = crypto.privateKey
                arg1.servers[i].cert = crypto.cert
            }
        }
    }
    fs.writeFileSync(path.join(app.getPath('userData'), "config.json"), JSON.stringify(arg1, null, 2), "utf8");
    config = arg1;
    startServers();
})

app.on('activate', function () {
    if (mainWindow === null) {
        createWindow()
        if (process.platform === "darwin") {
            app.dock.show();
        }
    }
})

function createWindow() {

    mainWindow = new BrowserWindow({
        width: 420,
        height: 700,
        frame: true,
        //skipTaskbar: true,
        title: "Simple Web Server",
        icon: "images/icon.ico",
        webPreferences: {
            //webSecurity: false,
            scrollBounce: true,
            nodeIntegration: false,
            contextIsolation: true,
            enableRemoteModule: true,
            preload: path.join(__dirname, "preload.js")
        }
    });
    mainWindow.setMenuBarVisibility(false);

    mainWindow.loadFile('index.html');

    //mainWindow.webContents.openDevTools();
    
    mainWindow.webContents.on('did-finish-load', function() {
        mainWindow.webContents.send('message', {"config": config, ip: getIPs()});
    });

    mainWindow.on('close', function (event) {
        if (config.background && process.platform == "win32" && !isQuitting) {
            mainWindow.hide();
            event.preventDefault();
        }
    });

    mainWindow.on('closed', function () {
        mainWindow = null
    });

}

var servers = [];

function startServers() {

    if (servers.length > 0) {
    var closed_servers = 0;
    for (var i = 0; i < servers.length; i++) {
        servers[i].close(function(err) {
            checkServersClosed()
        });
        servers[i].destroy();
    }
    function checkServersClosed() {
        closed_servers++;
        if (closed_servers == servers.length) {
            servers = [];
            createServers()
        }
    }
    } else {
        createServers()
    }

    function createServers() {
        for (var i = 0; i < (config.servers || []).length; i++) {
            createServer(config.servers[i]);
        }
        function createServer(serverconfig) {
            if (serverconfig.enabled) {
                var hostname = serverconfig.localnetwork ? '0.0.0.0' : '127.0.0.1';
                if (serverconfig.https) {
                    if (! serverconfig.key || ! serverconfig.cert) {
                        try {
                            var config = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), "config.json")))
                            console.log(config)
                            for (var i=0; i<config.servers.length; i++) {
                                if (config.servers[i].https) {
                                    if (! config.servers[i].cert || ! config.servers[i].key) {
                                        var crypto = WSC.createCrypto()  // Create HTTPS crypto
                                        config.servers[i].key = crypto.privateKey
                                        config.servers[i].cert = crypto.cert
                                    }
                                }
                            }
                            fs.writeFileSync(path.join(app.getPath('userData'), "config.json"), JSON.stringify(config, null, 2), "utf8");
                        } catch(e) { console.log(e)}
                        if (! crypto) {
                            var crypto = WSC.createCrypto() // Temp Crypto
                        }
                        serverconfig.key = crypto.privateKey
                        serverconfig.cert = crypto.cert
                    }
                    var server = https.createServer({key: serverconfig.key, cert: serverconfig.cert}, function(req, res) {
                        WSC.onRequest(serverconfig, req, res)
                    });
                } else {
                    var server = http.createServer(function(req, res) {
                        WSC.onRequest(serverconfig, req, res)
                    });
                }
                /**
                if (serverconfig.proxy) {
                    server.on('connect', (req, clientSocket, head) => {
                        console.log(req.socket.remoteAddress + ':', 'Request',req.method, req.url)
                        const { port, hostname } = new URL(`http://${req.url}`)
                        const serverSocket = net.connect(port || 443, hostname, () => {
                            clientSocket.write('HTTP/1.1 200 Connection Established\r\n' +
                                               'Proxy-agent: Simple-Web-Server-Proxy\r\n' +
                                               '\r\n')
                            serverSocket.write(head)
                            serverSocket.pipe(clientSocket)
                            clientSocket.pipe(serverSocket)
                        })
                    })
                }
                */
                server.on('clientError', (err, socket) => {
                    if (err.code === 'ECONNRESET' || !socket.writable) {
                        return;
                    }
                    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
                });
                server.on('error', function(err) {
                    if (err.code == 'EADDRINUSE') {
                        console.error(err)
                        // This is where listen errors will occur
                        // handle listen error/UI change
                    } else {
                        console.error(err);
                    }
                });
                server.listen(serverconfig.port, hostname);
                var prot = serverconfig.https ? 'https' : 'http'
                console.log('Listening on ' + prot + '://' + hostname + ':' + serverconfig.port)

                var connections = {}

                server.on('connection', function(conn) {
                  var key = conn.remoteAddress + ':' + conn.remotePort;
                  connections[key] = conn;
                  conn.on('close', function() {
                    delete connections[key];
                  });
                });
              
                server.destroy = function(cb) {
                  server.close(cb);
                  for (var key in connections)
                    connections[key].destroy();
                };

                servers.push(server);
            }
        }
    }
}