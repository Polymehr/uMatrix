/*******************************************************************************

    uMatrix - a browser extension to block requests.
    Copyright (C) 2014-2018 Raymond Hill

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

/* global diff_match_patch, CodeMirror, uDom */

'use strict';

/******************************************************************************/

(function() {

/******************************************************************************/

// Move to dashboard-common.js if needed

(function() {
    let timer;
    let resize = function() {
        timer = undefined;
        let child = document.querySelector('.vfill-available');
        if ( child === null ) { return; }
        let prect = document.documentElement.getBoundingClientRect();
        let crect = child.getBoundingClientRect();
        let cssHeight = Math.max(prect.bottom - crect.top, 80) + 'px';
        if ( child.style.height !== cssHeight ) {
            child.style.height = cssHeight;
            if ( typeof mergeView !== 'undefined' ) {
                mergeView.leftOriginal().refresh();
                mergeView.editor().refresh();
            }
        }
    };
    let resizeAsync = function(delay) {
        if ( timer === undefined ) {
            timer = vAPI.setTimeout(
                resize,
                typeof delay === 'number' ? delay : 66
            );
        }
    };
    window.addEventListener('resize', resizeAsync);
    var observer = new MutationObserver(resizeAsync);
    observer.observe(document.querySelector('.body'), {
        childList: true,
        subtree: true
    });
    resizeAsync(1);
})();

/******************************************************************************/

var mergeView = new CodeMirror.MergeView(
    document.querySelector('.codeMirrorMergeContainer'),
    {
        allowEditingOriginals: true,
        connect: 'align',
        inputStyle: 'contenteditable',
        lineNumbers: true,
        lineWrapping: false,
        origLeft: '',
        revertButtons: true,
        value: ''
    }
);
mergeView.editor().setOption('styleActiveLine', true);
mergeView.editor().setOption('lineNumbers', false);
mergeView.leftOriginal().setOption('readOnly', 'nocursor');

var unfilteredRules = {
    orig: { doc: mergeView.leftOriginal(), rules: [] },
    edit: { doc: mergeView.editor(), rules: [] }
};

var cleanEditToken = 0;
var cleanEditText = '';

var differ;

/******************************************************************************/
// This segment is an almost direct copy of code from uBlockOrigin.
// Introducing commit: https://github.com/gorhill/uBlock/commit/f3773ef6ebc05e0a25c7a1a1196c51769e7f37a0

// The following code is to take care of properly internationalizing
// the tooltips of the arrows used by the CodeMirror merge view. These
// are hard-coded by CodeMirror ("Push to left", "Push to right"). An
// observer is necessary because there is no hook for uBO to overwrite
// reliably the default title attribute assigned by CodeMirror.

(function() {
    const i18nCommitStr = vAPI.i18n('userRulesCommit');
    const i18nRevertStr = vAPI.i18n('userRulesRevert');
    const commitArrowSelector = '.CodeMirror-merge-copybuttons-left .CodeMirror-merge-copy-reverse:not([title="' + i18nCommitStr + '"])';
    const revertArrowSelector = '.CodeMirror-merge-copybuttons-left .CodeMirror-merge-copy:not([title="' + i18nRevertStr + '"])';

    uDom.nodeFromSelector('.CodeMirror-merge-scrolllock')
        .setAttribute('title', vAPI.i18n('genericMergeViewScrollLock'));

    const translate = function() {
        let elems = document.querySelectorAll(commitArrowSelector);
        for ( const elem of elems ) {
            elem.setAttribute('title', i18nCommitStr);
        }
        elems = document.querySelectorAll(revertArrowSelector);
        for ( const elem of elems ) {
            elem.setAttribute('title', i18nRevertStr);
        }
    };

    const mergeGapObserver = new MutationObserver(translate);

    mergeGapObserver.observe(
        uDom.nodeFromSelector('.CodeMirror-merge-copybuttons-left'),
        { attributes: true, attributeFilter: [ 'title' ], subtree: true }
    );

})();

/******************************************************************************/

// Borrowed from...
// https://github.com/codemirror/CodeMirror/blob/3e1bb5fff682f8f6cbfaef0e56c61d62403d4798/addon/search/search.js#L22
// ... and modified as needed.

var updateOverlay = (function() {
    var reFilter;
    var mode = {
        token: function(stream) {
            if ( reFilter !== undefined ) {
                reFilter.lastIndex = stream.pos;
                var match = reFilter.exec(stream.string);
                if ( match !== null ) {
                    if ( match.index === stream.pos ) {
                        stream.pos += match[0].length || 1;
                        return 'searching';
                    }
                    stream.pos = match.index;
                    return;
                }
            }
            stream.skipToEnd();
        }
    };
    return function(filter) {
        reFilter = typeof filter === 'string' && filter !== '' ?
            new RegExp(filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') :
            undefined;
        return mode;
    };
})();

/******************************************************************************/

// Incrementally update text in a CodeMirror editor for best user experience:
// - Scroll position preserved
// - Minimum amount of text updated

var rulesToDoc = function(clearHistory) {
    for ( var key in unfilteredRules ) {
        if ( unfilteredRules.hasOwnProperty(key) === false ) { continue; }
        var doc = unfilteredRules[key].doc;
        var rules = filterRules(key);
        if ( doc.lineCount() === 1 && doc.getValue() === '' || rules.length === 0 ) {
            doc.setValue(rules.length !== 0 ? rules.join('\n') : '');
            continue;
        }
        if ( differ === undefined ) { differ = new diff_match_patch(); }
        var beforeText = doc.getValue();
        var afterText = rules.join('\n');
        var diffs = differ.diff_main(beforeText, afterText);
        doc.startOperation();
        var i = diffs.length,
            iedit = beforeText.length;
        while ( i-- ) {
            var diff = diffs[i];
            if ( diff[0] === 0 ) {
                iedit -= diff[1].length;
                continue;
            }
            var end = doc.posFromIndex(iedit);
            if ( diff[0] === 1 ) {
                doc.replaceRange(diff[1], end, end);
                continue;
            }
            /* diff[0] === -1 */
            iedit -= diff[1].length;
            var beg = doc.posFromIndex(iedit);
            doc.replaceRange('', beg, end);
        }
        doc.endOperation();
    }
    cleanEditText = mergeView.editor().getValue().trim();
    cleanEditToken = mergeView.editor().changeGeneration();
    if ( clearHistory ) {
        mergeView.editor().clearHistory();
    }
};

/******************************************************************************/

var filterRules = function(key) {
    var rules = unfilteredRules[key].rules;
    var filter = uDom('#ruleFilter input').val();
    if ( filter !== '' ) {
        rules = rules.slice();
        var i = rules.length;
        while ( i-- ) {
            if ( rules[i].indexOf(filter) === -1 ) {
                rules.splice(i, 1);
            }
        }
    }
    return rules;
};

/******************************************************************************/

var renderRules = (function() {
    var firstVisit = true;

    return function(details) {
        unfilteredRules.orig.rules = details.permanentRules.sort(directiveSort);
        unfilteredRules.edit.rules = details.temporaryRules.sort(directiveSort);
        rulesToDoc(firstVisit);
        if ( firstVisit ) {
            firstVisit = false;
            mergeView.editor().execCommand('goNextDiff');
        }
        onTextChanged(true);
    };
})();

// Switches before, rules after
var directiveSort = function(a, b) {
    var aIsSwitch = a.indexOf(': ') !== -1;
    var bIsSwitch = b.indexOf(': ') !== -1;
    if ( aIsSwitch === bIsSwitch ) {
        return a.localeCompare(b);
    }
    return aIsSwitch ? -1 : 1;
};

/******************************************************************************/

var applyDiff = function(permanent, toAdd, toRemove) {
    vAPI.messaging.send(
        'user-rules.js',
        {
            what: 'modifyRuleset',
            permanent: permanent,
            toAdd: toAdd,
            toRemove: toRemove
        },
        renderRules
    );
};

/******************************************************************************/

// CodeMirror quirk: sometimes fromStart.ch and/or toStart.ch is undefined.
// When this happens, use 0.

mergeView.options.revertChunk = function(
    mv,
    from, fromStart, fromEnd,
    to, toStart, toEnd
) {
    // https://github.com/gorhill/uBlock/issues/3611
    if ( document.body.getAttribute('dir') === 'rtl' ) {
        var tmp;
        tmp = from; from = to; to = tmp;
        tmp = fromStart; fromStart = toStart; toStart = tmp;
        tmp = fromEnd; fromEnd = toEnd; toEnd = tmp;
    }
    if ( typeof fromStart.ch !== 'number' ) { fromStart.ch = 0; }
    if ( fromEnd.ch !== 0 ) { fromEnd.line += 1; }
    var toAdd = from.getRange(
        { line: fromStart.line, ch: 0 },
        { line: fromEnd.line, ch: 0 }
    );
    if ( typeof toStart.ch !== 'number' ) { toStart.ch = 0; }
    if ( toEnd.ch !== 0 ) { toEnd.line += 1; }
    var toRemove = to.getRange(
        { line: toStart.line, ch: 0 },
        { line: toEnd.line, ch: 0 }
    );
    applyDiff(from === mv.editor(), toAdd, toRemove);
};

/******************************************************************************/

// https://github.com/chrisaljoudi/uBlock/issues/757
// Support RequestPolicy rule syntax

var fromRequestPolicy = function(content) {
    var matches = /\[origins-to-destinations\]([^\[]+)/.exec(content);
    if ( matches === null || matches.length !== 2 ) { return; }
    return matches[1].trim()
                     .replace(/\|/g, ' ')
                     .replace(/\n/g, ' * allow\n');
};

/******************************************************************************/

// https://github.com/gorhill/uMatrix/issues/270

var fromNoScript = function(content) {
    var noscript = null;
    try {
        noscript = JSON.parse(content);
    } catch (e) {
    }
    if (
        noscript === null ||
        typeof noscript !== 'object' ||
        typeof noscript.prefs !== 'object' ||
        typeof noscript.prefs.clearClick === 'undefined' ||
        typeof noscript.whitelist !== 'string' ||
        typeof noscript.V !== 'string'
    ) {
        return;
    }
    var out = new Set();
    var reBad = /[a-z]+:\w*$/;
    var reURL = /[a-z]+:\/\/([0-9a-z.-]+)/;
    var directives = noscript.whitelist.split(/\s+/);
    var i = directives.length;
    var directive, matches;
    while ( i-- ) {
        directive = directives[i].trim();
        if ( directive === '' ) { continue; }
        if ( reBad.test(directive) ) { continue; }
        matches = reURL.exec(directive);
        if ( matches !== null ) {
            directive = matches[1];
        }
        out.add('* ' + directive + ' * allow');
        out.add('* ' + directive + ' script allow');
        out.add('* ' + directive + ' frame allow');
    }
    return Array.from(out).join('\n');
};

/******************************************************************************/

var handleImportFilePicker = function() {
    var fileReaderOnLoadHandler = function() {
        if ( typeof this.result !== 'string' || this.result === '' ) {
            return;
        }
        var result = fromRequestPolicy(this.result);
        if ( result === undefined ) {
            result = fromNoScript(this.result);
            if ( result === undefined ) {
                result = this.result;
            }
        }
        if ( this.result === '' ) { return; }
        applyDiff(false, result, '');
    };
    var file = this.files[0];
    if ( file === undefined || file.name === '' ) { return; }
    if ( file.type.indexOf('text') !== 0 && file.type !== 'application/json') {
        return;
    }
    var fr = new FileReader();
    fr.onload = fileReaderOnLoadHandler;
    fr.readAsText(file);
};

/******************************************************************************/

var startImportFilePicker = function() {
    var input = document.getElementById('importFilePicker');
    // Reset to empty string, this will ensure an change event is properly
    // triggered if the user pick a file, even if it is the same as the last
    // one picked.
    input.value = '';
    input.click();
};

/******************************************************************************/

function exportUserRulesToFile() {
    vAPI.download({
        url: 'data:text/plain,' + encodeURIComponent(
            mergeView.leftOriginal().getValue().trim() + '\n'
        ),
        filename: uDom('[data-i18n="userRulesDefaultFileName"]').text()
    });
}

/******************************************************************************/

var onFilterChanged = (function() {
    var timer,
        overlay = null,
        last = '';

    var process = function() {
        timer = undefined;
        if ( mergeView.editor().isClean(cleanEditToken) === false ) { return; }
        var filter = uDom('#ruleFilter input').val();
        if ( filter === last ) { return; }
        last = filter;
        if ( overlay !== null ) {
            mergeView.leftOriginal().removeOverlay(overlay);
            mergeView.editor().removeOverlay(overlay);
            overlay = null;
        }
        if ( filter !== '' ) {
            overlay = updateOverlay(filter);
            mergeView.leftOriginal().addOverlay(overlay);
            mergeView.editor().addOverlay(overlay);
        }
        rulesToDoc(true);
    };

    return function() {
        if ( timer !== undefined ) { clearTimeout(timer); }
        timer = vAPI.setTimeout(process, 773);
    };
})();

/******************************************************************************/

var onTextChanged = (function() {
    var timer;

    var process = function(now) {
        timer = undefined;
        var isClean = mergeView.editor().isClean(cleanEditToken);
        var diff = document.getElementById('diff');
        if (
            now &&
            isClean === false &&
            mergeView.editor().getValue().trim() === cleanEditText
        ) {
            cleanEditToken = mergeView.editor().changeGeneration();
            isClean = true;
        }
        diff.classList.toggle('editing', isClean === false);
        diff.classList.toggle('dirty', mergeView.leftChunks().length !== 0);
        var input = document.querySelector('#ruleFilter input');
        if ( isClean ) {
            input.removeAttribute('disabled');
            CodeMirror.commands.save = undefined;
        } else {
            input.setAttribute('disabled', '');
            CodeMirror.commands.save = editSaveHandler;
        }
    };

    return function(now) {
        if ( timer !== undefined ) { clearTimeout(timer); }
        timer = now ? process(now) : vAPI.setTimeout(process, 57);
    };
})();

/******************************************************************************/

var revertAllHandler = function() {
    var toAdd = [], toRemove = [];
    var left = mergeView.leftOriginal(),
        edit = mergeView.editor();
    for ( var chunk of mergeView.leftChunks() ) {
        var addedLines = left.getRange(
            { line: chunk.origFrom, ch: 0 },
            { line: chunk.origTo, ch: 0 }
        );
        var removedLines = edit.getRange(
            { line: chunk.editFrom, ch: 0 },
            { line: chunk.editTo, ch: 0 }
        );
        toAdd.push(addedLines.trim());
        toRemove.push(removedLines.trim());
    }
    applyDiff(false, toAdd.join('\n'), toRemove.join('\n'));
};

/******************************************************************************/

var commitAllHandler = function() {
    var toAdd = [], toRemove = [];
    var left = mergeView.leftOriginal(),
        edit = mergeView.editor();
    for ( var chunk of mergeView.leftChunks() ) {
        var addedLines = edit.getRange(
            { line: chunk.editFrom, ch: 0 },
            { line: chunk.editTo, ch: 0 }
        );
        var removedLines = left.getRange(
            { line: chunk.origFrom, ch: 0 },
            { line: chunk.origTo, ch: 0 }
        );
        toAdd.push(addedLines.trim());
        toRemove.push(removedLines.trim());
    }
    applyDiff(true, toAdd.join('\n'), toRemove.join('\n'));
};

/******************************************************************************/

var editSaveHandler = function() {
    var editor = mergeView.editor();
    var editText = editor.getValue().trim();
    if ( editText === cleanEditText ) {
        onTextChanged(true);
        return;
    }
    if ( differ === undefined ) { differ = new diff_match_patch(); }
    var toAdd = [], toRemove = [];
    var diffs = differ.diff_main(cleanEditText, editText);
    for ( var diff of diffs ) {
        if ( diff[0] === 1 ) {
            toAdd.push(diff[1]);
        } else if ( diff[0] === -1 ) {
            toRemove.push(diff[1]);
        }
    }
    applyDiff(false, toAdd.join(''), toRemove.join(''));
};

/******************************************************************************/

self.cloud.onPush = function() {
    return mergeView.leftOriginal().getValue().trim();
};

self.cloud.onPull = function(data, append) {
    if ( typeof data !== 'string' ) { return; }
    applyDiff(
        false,
        data,
        append ? '' : mergeView.editor().getValue().trim()
    );
};

/******************************************************************************/

// Handle user interaction
uDom('#exportButton').on('click', exportUserRulesToFile);
uDom('#revertButton').on('click', revertAllHandler);
uDom('#commitButton').on('click', commitAllHandler);
uDom('#importButton').on('click', startImportFilePicker);
uDom('#importFilePicker').on('change', handleImportFilePicker);
uDom('#editSaveButton').on('click', editSaveHandler);
uDom('#ruleFilter input').on('input', onFilterChanged);

// https://groups.google.com/forum/#!topic/codemirror/UQkTrt078Vs
mergeView.editor().on('updateDiff', function() { onTextChanged(); });

vAPI.messaging.send('user-rules.js', { what: 'getRuleset' }, renderRules);

/******************************************************************************/

})();

