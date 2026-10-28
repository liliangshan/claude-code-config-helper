/** @file Selection-safe clipboard controller for the chat Webview. */
(function () {
    'use strict';
    /** Install keyboard, native-copy and context-menu support without touching editable controls. */
    window.installChatClipboard = function (api, root, label) {
        var requests = new Map();
        var deferred = new Map();
        var sequence = 0;
        var menu = null;
        var contextText = '';
        var rightClickText = '';
        /** Snapshot selected message text before a secondary-button press can collapse the DOM selection. */
        function captureRightClick(event) {
            rightClickText = '';
            if (event.button !== 2 || editable(event.target) || !root || !root.contains(event.target)) return;
            rightClickText = selectedText();
            if (rightClickText) event.preventDefault();
        }
        document.addEventListener('pointerdown', captureRightClick, true);
        document.addEventListener('mousedown', captureRightClick, true);
        /** Return only a live selection wholly inside the message list. */
        function selectedText() {
            var selection = window.getSelection();
            if (!selection || selection.isCollapsed || !root || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return '';
            return selection.toString();
        }
        /** Leave text fields and contenteditable native copy/paste behavior intact. */
        function editable(target) {
            return target instanceof Element && !!target.closest('textarea,input,[contenteditable="true"],[contenteditable=""]');
        }
        /** Write through the extension host; resolve only on its actual clipboard acknowledgement. */
        function write(text) {
            return new Promise(function (resolve, reject) {
                var id = 'copy-' + (++sequence);
                var timer = setTimeout(function () { requests.delete(id); reject(new Error('Clipboard acknowledgement timed out')); }, 10000);
                requests.set(id, { resolve: resolve, reject: reject, timer: timer });
                try { api.postMessage({ type: 'clipboard/write', requestId: id, text: String(text) }); }
                catch (error) { clearTimeout(timer); requests.delete(id); reject(error); }
            });
        }
        /** Release deferred DOM work only after the selection is no longer needed. */
        function flush() {
            if (selectedText() || menu) return;
            var actions = Array.from(deferred.values()); deferred.clear();
            actions.forEach(function (action) { action(); });
        }
        /** Close our menu, without moving focus to the chat composer. */
        function closeMenu() {
            if (menu) menu.remove(); menu = null; contextText = ''; flush();
        }
        /** Render copy errors locally without claiming success or logging selected text. */
        function failed() {
            if (menu) { menu.textContent = label('copyBodySourceFailed'); }
            document.dispatchEvent(new CustomEvent('chat-copy-error'));
        }
        window.addEventListener('message', function (event) {
            var message = event.data && event.data.type === 'from-extension' ? event.data.message : event.data;
            if (!message || message.type !== 'clipboard/result') return;
            var request = requests.get(message.requestId); if (!request) return;
            clearTimeout(request.timer); requests.delete(message.requestId);
            if (message.ok) request.resolve(); else request.reject(new Error('Clipboard write failed'));
        });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && menu) { event.preventDefault(); closeMenu(); return; }
            if (event.isComposing || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c' || editable(event.target)) return;
            var text = selectedText(); if (!text) return;
            event.preventDefault(); event.stopPropagation();
            void write(text).catch(failed);
        }, true);
        document.addEventListener('copy', function (event) {
            if (editable(event.target)) return;
            var text = selectedText(); if (!text) return;
            // Also use the host for native context-menu Copy: clipboardData alone can
            // be consumed by the embedded Webview without updating the OS clipboard.
            if (event.clipboardData) event.clipboardData.setData('text/plain', text);
            event.preventDefault(); void write(text).catch(failed);
        }, true);
        document.addEventListener('contextmenu', function (event) {
            if (editable(event.target) || !root || !root.contains(event.target)) return;
            var text = selectedText() || rightClickText; rightClickText = ''; if (!text) return;
            event.preventDefault(); event.stopPropagation(); closeMenu(); contextText = text;
            menu = document.createElement('div'); menu.className = 'chat-copy-menu'; menu.setAttribute('role', 'menu');
            var button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.textContent = label('copy');
            button.addEventListener('mousedown', function (down) { down.preventDefault(); });
            var copyText = text;
            button.addEventListener('click', function () { void write(copyText).then(closeMenu).catch(failed); });
            menu.appendChild(button); document.body.appendChild(menu);
            menu.style.left = Math.max(0, Math.min(event.clientX, window.innerWidth - menu.offsetWidth)) + 'px';
            menu.style.top = Math.max(0, Math.min(event.clientY, window.innerHeight - menu.offsetHeight)) + 'px';
        }, true);
        document.addEventListener('mousedown', function (event) { if (menu && !menu.contains(event.target)) closeMenu(); }, true);
        document.addEventListener('click', function (event) {
            if (menu && !menu.contains(event.target)) closeMenu();
        });
        document.addEventListener('selectionchange', flush);
        window.addEventListener('blur', closeMenu);
        return {
            write: write,
            selectedText: selectedText,
            /** Coalesce redraws by message ID while selection intersects that message. */
            defer: function (key, node, action) {
                var selection = window.getSelection();
                var intersects = false;
                if (selection && !selection.isCollapsed && node) {
                    for (var index = 0; index < selection.rangeCount; index++) {
                        try { if (selection.getRangeAt(index).intersectsNode(node)) intersects = true; } catch (_) { /* Detached ranges cannot block rendering. */ }
                    }
                }
                if (intersects || (menu && deferred.has(key))) { deferred.set(key, action); return true; }
                return false;
            },
            /** Clear pending DOM callbacks when a different conversation replaces history. */
            reset: function () { deferred.clear(); rightClickText = ''; closeMenu(); }
        };
    };
})();
