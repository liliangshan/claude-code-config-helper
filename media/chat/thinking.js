/** @file Theme-independent disclosure controller for already-visible model thinking; no model or host calls. */
(function () {
    'use strict';
    const labels = {
        en: ['Thinking', 'Thinking…', 'Visible model thinking'],
        'zh-cn': ['思考过程', '正在思考…', '模型返回的可见思考'],
        'zh-tw': ['思考過程', '正在思考…', '模型傳回的可見思考'],
        ja: ['思考過程', '思考中…', 'モデルが返した可視の思考'],
        ko: ['사고 과정', '생각 중…', '모델이 반환한 공개 사고'],
        fr: ['Raisonnement', 'Réflexion…', 'Raisonnement visible fourni par le modèle'],
        de: ['Gedankengang', 'Denkt nach…', 'Sichtbarer Gedankengang des Modells']
    };

    /** Create one Webview-local disclosure registry; it never persists model text or changes conversation context. */
    window.createThinkingUi = function (language) {
        const choices = new Map();
        const groups = new WeakMap();
        const entries = new WeakMap();
        let activeLanguage = language || 'en';

        /** Read structured visible text, or the exact legacy thinking prefix, never ordinary blockquotes or tool output. */
        function visible(segment) {
            if (!segment || (segment.kind !== 'markdown' && segment.kind !== 'text')) return null;
            if (segment.thinking && typeof segment.thinking.text === 'string') {
                return segment.thinking.text.trim() ? { text: segment.thinking.text, complete: segment.thinking.complete === true } : null;
            }
            const text = String(segment.text || segment.sourceText || '');
            if (!/^> 💭 /.test(text) || !text.split(/\r?\n/).every(line => !line.trim() || /^>/.test(line))) return null;
            const unquoted = text.replace(/^> 💭 /, '').replace(/\r?\n>[ ]?/g, '\n');
            return unquoted.trim() ? { text: unquoted, complete: false } : null;
        }

        /** Create one disclosure per assistant reply; anchors keep each request's usage at its original position. */
        function createGroup(container, key) {
            let registry = groups.get(container);
            if (!registry) { registry = new Map(); groups.set(container, registry); }
            if (registry.has(key)) return registry.get(key);
            const root = document.createElement('div'); root.className = 'thinking-disclosure';
            root.dataset.thinkingKey = key;
            const panel = document.createElement('details'); panel.className = 'thinking-disclosure__panel';
            const summary = document.createElement('summary');
            const chevron = document.createElement('span');
            chevron.className = 'thinking-disclosure__chevron'; chevron.textContent = '›'; chevron.setAttribute('aria-hidden', 'true');
            const caption = document.createElement('span'); caption.className = 'thinking-disclosure__title';
            summary.append(chevron, caption);
            const body = document.createElement('div'); body.className = 'thinking-disclosure__body';
            panel.append(summary, body); root.appendChild(panel);
            const group = { root, panel, body, caption, members: new Map(), sequence: 0 };
            // Only user input claims a preference; native toggles from automatic updates do not.
            summary.addEventListener('click', () => { choices.set(key, !panel.open); });
            registry.set(key, group);
            return group;
        }

        /** Render exact visible text in ordered blocks, reusing a request/segment member instead of duplicating it. */
        function render(container, segment, key) {
            const value = visible(segment);
            if (!value) return null;
            const group = createGroup(container, key);
            const memberKey = JSON.stringify([segment.requestId || '', segment.id || 'legacy-' + (++group.sequence)]);
            const known = group.members.get(memberKey);
            if (known) { update(known.anchor, segment, false); return known.anchor; }
            const anchor = document.createElement('div'); anchor.className = 'thinking-disclosure__anchor';
            if (segment.id) anchor.dataset.segmentId = segment.id;
            if (group.members.size === 0) anchor.appendChild(group.root);
            const block = document.createElement('div'); block.className = 'thinking-disclosure__block';
            group.body.appendChild(block);
            const entry = { anchor, block, group, complete: value.complete };
            group.members.set(memberKey, entry); entries.set(anchor, entry);
            container.appendChild(anchor);
            update(anchor, segment, false);
            return anchor;
        }

        /** Refresh one reply's aggregate state without inventing summaries, durations or cross-request usage. */
        function refresh(group, pending) {
            const complete = Array.from(group.members.values()).every(entry => entry.complete);
            const active = !!pending && !complete;
            const translation = labels[activeLanguage] || labels.en;
            group.root.dataset.complete = String(complete);
            group.root.dataset.pending = String(active);
            const caption = active ? translation[1] : translation[0];
            if (group.caption.textContent !== caption) group.caption.textContent = caption;
            group.body.setAttribute('aria-label', translation[2]);
            group.panel.open = choices.has(group.root.dataset.thinkingKey) ? choices.get(group.root.dataset.thinkingKey) : active;
        }

        /** Update only the changed block; keep sibling text, selected nodes, focus and the reply's manual open choice. */
        function update(anchor, segment, pending) {
            const value = visible(segment);
            const entry = entries.get(anchor);
            if (!value || !entry) return;
            if (entry.block.textContent !== value.text) entry.block.textContent = value.text;
            entry.complete = value.complete;
            anchor.dataset.complete = String(value.complete);
            refresh(entry.group, pending);
        }

        /** Settle complete replies or all pending blocks after a turn ends, preserving manual disclosure choices. */
        function settle(container, pending) {
            const seen = new Set();
            container.querySelectorAll('.thinking-disclosure__anchor').forEach(anchor => {
                const entry = entries.get(anchor);
                if (entry && !seen.has(entry.group)) {
                    seen.add(entry.group);
                    refresh(entry.group, pending);
                }
            });
        }

        return {
            visible, render, update, settle,
            /** Reuse existing nodes and manual choices on locale switches. */
            language(value) { activeLanguage = labels[value] ? value : 'en'; },
            /** Clear only presentation preferences when actual conversation identity changes. */
            reset() { choices.clear(); }
        };
    };
}());
