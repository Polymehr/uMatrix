/*******************************************************************************

    µMatrix - a Chromium browser extension to black/white list requests.
    Copyright (C) 2014-2105 Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uMatrix
*/

/* global vAPI */
/* jshint multistr: true, boss: true */

/******************************************************************************/
/******************************************************************************/

// Injected into content pages

(function() {

'use strict';

/******************************************************************************/

// https://github.com/chrisaljoudi/uBlock/issues/464
if ( document instanceof HTMLDocument === false ) {
    //console.debug('contentscript-end.js > not a HTLMDocument');
    return false;
}

// This can happen
if ( !vAPI ) {
    //console.debug('contentscript-end.js > vAPI not found');
    return;
}

// https://github.com/chrisaljoudi/uBlock/issues/587
// Pointless to execute without the start script having done its job.
if ( !vAPI.contentscriptStartInjected ) {
    return;
}

// https://github.com/chrisaljoudi/uBlock/issues/456
// Already injected?
if ( vAPI.contentscriptEndInjected ) {
    //console.debug('contentscript-end.js > content script already injected');
    return;
}
vAPI.contentscriptEndInjected = true;

/******************************************************************************/

var localMessager = vAPI.messaging.channel('contentscript-end.js');

vAPI.shutdown.add(function() {
    localMessager.close();
});

/******************************************************************************/
/******************************************************************************/

// Unrendered noscript (because CSP) workaround

// Executed once.

(function() {
    var checkScriptBlacklistedHandler = function(response) {
        if ( !response.scriptBlacklisted ) {
            return;
        }
        var scripts = document.querySelectorAll('noscript');
        var i = scripts.length;
        var realNoscript, fakeNoscript;
        while ( i-- ) {
            realNoscript = scripts[i];
            fakeNoscript = document.createElement('div');
            fakeNoscript.innerHTML = '<!-- uMatrix NOSCRIPT tag replacement: see <https://github.com/gorhill/httpswitchboard/issues/177> -->\n' + realNoscript.textContent;
            realNoscript.parentNode.replaceChild(fakeNoscript, realNoscript);
        }
    };

    localMessager.send({
            what: 'checkScriptBlacklisted',
            url: window.location.href
    }, checkScriptBlacklistedHandler);
})();

/******************************************************************************/
/******************************************************************************/

// Executed only once.

(function() {
    var localStorageHandler = function(mustRemove) {
        if ( mustRemove ) {
            window.localStorage.clear();
            window.sessionStorage.clear();
            // console.debug('HTTP Switchboard > found and removed non-empty localStorage');
        }
    };

    // Check with extension whether local storage must be emptied
    // rhill 2014-03-28: we need an exception handler in case 3rd-party access
    // to site data is disabled.
    // https://github.com/gorhill/httpswitchboard/issues/215
    try {
        var hasLocalStorage = window.localStorage && window.localStorage.length;
        var hasSessionStorage = window.sessionStorage && window.sessionStorage.length;
        if ( hasLocalStorage || hasSessionStorage ) {
            localMessager.send({
                    what: 'contentScriptHasLocalStorage',
                    url: window.location.href
            }, localStorageHandler);
        }

        // TODO: indexedDB
        if ( window.indexedDB && !!window.indexedDB.webkitGetDatabaseNames ) {
            // var db = window.indexedDB.webkitGetDatabaseNames().onsuccess = function(sender) {
            //    console.debug('webkitGetDatabaseNames(): result=%o', sender.target.result);
            // };
        }

        // TODO: Web SQL
        if ( window.openDatabase ) {
            // Sad:
            // "There is no way to enumerate or delete the databases available for an origin from this API."
            // Ref.: http://www.w3.org/TR/webdatabase/#databases
        }
    }
    catch (e) {
    }
})();

/******************************************************************************/
/******************************************************************************/

// https://github.com/gorhill/uMatrix/issues/45

var collapser = (function() {
    var timer = null;
    var requestId = 1;
    var newRequests = [];
    var pendingRequests = {};
    var pendingRequestCount = 0;
    var backgroundImage = [
        'linear-gradient(',
            '0deg,',
            'rgba(0,0,0,0.02) 25%,',
            'rgba(0,0,0,0.05) 25%,',
            'rgba(0,0,0,0.05) 75%,',
            'rgba(0,0,0,0.02) 75%,',
            'rgba(0,0,0,0.02)',
        ') center center / 10px 10px repeat scroll,',
        'linear-gradient(',
            '90deg,',
            'rgba(0,0,0,0.02) 25%,',
            'rgba(0,0,0,0.05) 25%,',
            'rgba(0,0,0,0.05) 75%,',
            'rgba(0,0,0,0.02) 75%,',
            'rgba(0,0,0,0.02)',
        ') center center / 10px 10px repeat scroll'
    ].join('');
    var srcProps = {
        'iframe': 'src',
        'img': 'src'
    };
    var srcValues = {
        'iframe': 'about:blank',
        'img': 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    };

    var PendingRequest = function(target) {
        this.id = requestId++;
        this.target = target;
        pendingRequests[this.id] = this;
        pendingRequestCount += 1;
    };

    // Because a while ago I have observed constructors are faster than
    // literal object instanciations.
    var BouncingRequest = function(id, tagName, url) {
        this.id = id;
        this.tagName = tagName;
        this.url = url;
        this.blocked = false;
    };

    var onProcessed = function(response) {
        if ( !response ) {
            return;
        }
        var requests = response.requests;
        if ( requests === null || Array.isArray(requests) === false ) {
            return;
        }
        var collapse = response.collapse;
        var bgImg = backgroundImage;
        var i = requests.length;
        var request, entry, target, tagName;
        while ( i-- ) {
            request = requests[i];
            if ( pendingRequests.hasOwnProperty(request.id) === false ) {
                continue;
            }
            entry = pendingRequests[request.id];
            delete pendingRequests[request.id];
            pendingRequestCount -= 1;
            if ( !request.blocked ) {
                continue;
            }
            target = entry.target;
            if ( collapse ) {
                target.style.setProperty('display', 'none', 'important');
            } else {
                tagName = target.localName;
                target.setAttribute(srcProps[tagName], srcValues[tagName]);
                target.style.setProperty('border', '1px solid rgba(0,0,0,0.05)', 'important');
                target.style.setProperty('background', bgImg, 'important');
            }
        }

        // Renew map: I believe that even if all properties are deleted, an
        // object will still use more memory than a brand new one.
        if ( pendingRequestCount === 0 ) {
            pendingRequests = {};
        }
    };

    var send = function() {
        timer = null;
        localMessager.send({
            what: 'evaluateURLs',
            requests: newRequests
        }, onProcessed);
        newRequests = [];
    };

    var process = function(delay) {
        if ( newRequests.length === 0 ) {
            return;
        }
        if ( delay === 0 ) {
            clearTimeout(timer);
            send();
        } else if ( timer === null ) {
            timer = setTimeout(send, delay || 50);
        }
    };

    var addNode = function(target) {
        var tagName = target.localName;
        var prop = srcProps[tagName];
        if ( prop === undefined ) {
            return;
        }

        // https://github.com/chrisaljoudi/uBlock/issues/174
        // Do not remove fragment from src URL
        var src = target[prop];
        if ( typeof src !== 'string' || src === '' ) {
            return;
        }
        if ( src.lastIndexOf('http', 0) !== 0 ) {
            return;
        }
        var req = new PendingRequest(target);
        newRequests.push(new BouncingRequest(req.id, tagName, src));
    };

    var addNodes = function(nodes) {
        var node;
        var i = nodes.length;
        while ( i-- ) {
            node = nodes[i];
            if ( node.nodeType === 1 ) {
                addNode(node);
            }
        }
    };

    var addBranches = function(branches) {
        var root;
        var i = branches.length;
        while ( i-- ) {
            root = branches[i];
            if ( root.nodeType === 1 ) {
                addNode(root);
                // blocked images will be reported by onResourceFailed
                addNodes(root.querySelectorAll('iframe'));
            }
        }
    };

    // Listener to collapse blocked resources.
    // - Future requests not blocked yet
    // - Elements dynamically added to the page
    // - Elements which resource URL changes
    var onResourceFailed = function(ev) {
        addNode(ev.target);
        process();
    };
    document.addEventListener('error', onResourceFailed, true);

    vAPI.shutdown.add(function() {
        if ( timer !== null ) {
            clearTimeout(timer);
            timer = null;
        }
        document.removeEventListener('error', onResourceFailed, true);
        newRequests = [];
        pendingRequests = {};
        pendingRequestCount = 0;
    });

    return {
        addNodes: addNodes,
        addBranches: addBranches,
        process: process
    };
})();

/******************************************************************************/
/******************************************************************************/

var nodesAddedHandler = function(nodeList, summary) {
    var i = 0;
    var node, src, text;
    while ( node = nodeList.item(i++) ) {
        if ( node.nodeType !== 1 ) {
            continue;
        }
        if ( typeof node.localName !== 'string' ) {
            continue;
        }

        switch ( node.localName ) {

        case 'script':
            // https://github.com/gorhill/httpswitchboard/issues/252
            // Do not count µMatrix's own script tags, they are not required
            // to "unbreak" a web page
            if ( typeof node.id === 'string' && node.id.lastIndexOf('uMatrix-', 0) === 0 ) {
                break;
            }
            text = node.textContent.trim();
            if ( text !== '' ) {
                summary.scriptSources['{inline_script}'] = true;
                summary.mustReport = true;
            }
            src = (node.src || '').trim();
            if ( src !== '' ) {
                summary.scriptSources[src] = true;
                summary.mustReport = true;
            }
            break;

        case 'a':
            if ( node.href.lastIndexOf('javascript', 0) === 0 ) {
                summary.scriptSources['{inline_script}'] = true;
                summary.mustReport = true;
            }
            break;

        case 'object':
            src = (node.data || '').trim();
            if ( src !== '' ) {
                summary.pluginSources[src] = true;
                summary.mustReport = true;
            }
            break;

        case 'embed':
            src = (node.src || '').trim();
            if ( src !== '' ) {
                summary.pluginSources[src] = true;
                summary.mustReport = true;
            }
            break;
        }
    }
};

/******************************************************************************/

var nodeListsAddedHandler = function(nodeLists) {
    var i = nodeLists.length;
    if ( i === 0 ) {
        return;
    }
    var summary = {
        what: 'contentScriptSummary',
        locationURL: window.location.href,
        scriptSources: {}, // to avoid duplicates
        pluginSources: {}, // to avoid duplicates
        mustReport: false
    };
    while ( i-- ) {
        nodesAddedHandler(nodeLists[i], summary);
        collapser.addBranches(nodeLists[i]);
    }
    if ( summary.mustReport ) {
        localMessager.send(summary);
    }
    collapser.process();
};

/******************************************************************************/
/******************************************************************************/

// Executed only once.

(function() {
    var summary = {
        what: 'contentScriptSummary',
        locationURL: window.location.href,
        scriptSources: {}, // to avoid duplicates
        pluginSources: {}, // to avoid duplicates
        mustReport: true
    };
    // https://github.com/gorhill/httpswitchboard/issues/25
    // &
    // Looks for inline javascript also in at least one a[href] element.
    // https://github.com/gorhill/httpswitchboard/issues/131
    nodesAddedHandler(document.querySelectorAll('a[href^="javascript:"],embed,object,script'), summary);

    //console.debug('contentscript-end.js > firstObservationHandler(): found %d script tags in "%s"', Object.keys(summary.scriptSources).length, window.location.href);

    localMessager.send(summary);

    collapser.addNodes(document.querySelectorAll('iframe,img'));
    collapser.process();
})();

/******************************************************************************/
/******************************************************************************/

// Observe changes in the DOM

// Added node lists will be cumulated here before being processed

(function() {
    var addedNodeLists = [];
    var addedNodeListsTimer = null;

    var treeMutationObservedHandler = function() {
        nodeListsAddedHandler(addedNodeLists);
        addedNodeListsTimer = null;
        addedNodeLists = [];
    };

    // https://github.com/gorhill/uBlock/issues/205
    // Do not handle added node directly from within mutation observer.
    var treeMutationObservedHandlerAsync = function(mutations) {
        var iMutation = mutations.length;
        var nodeList;
        while ( iMutation-- ) {
            nodeList = mutations[iMutation].addedNodes;
            if ( nodeList.length !== 0 ) {
                addedNodeLists.push(nodeList);
            }
        }
        // I arbitrarily chose 250 ms for now:
        // I have to compromise between the overhead of processing too few 
        // nodes too often and the delay of many nodes less often. There is nothing
        // time critical here.
        if ( addedNodeListsTimer === null ) {
            addedNodeListsTimer = setTimeout(treeMutationObservedHandler, 250);
        }
    };

    // This fixes http://acid3.acidtests.org/
    if ( document.body ) {
        return;
    }

    // https://github.com/gorhill/httpswitchboard/issues/176
    var treeObserver = new MutationObserver(treeMutationObservedHandlerAsync);
    treeObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

    vAPI.shutdown.add(function() {
        if ( addedNodeListsTimer !== null ) {
            clearTimeout(addedNodeListsTimer);
            addedNodeListsTimer = null;
        }
        if ( treeObserver !== null ) {
            treeObserver.disconnect();
            treeObserver = null;
        }
        addedNodeLists = [];
    });
})();

/******************************************************************************/
/******************************************************************************/

localMessager.send({ what: 'shutdown?' }, function(response) {
    if ( response === true ) {
        vAPI.shutdown.exec();
    }
});

/******************************************************************************/
/******************************************************************************/

})();
