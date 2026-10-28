/* global acquireVsCodeApi */
/** Left conversation list actions; opening the list never starts or creates a conversation. */
(function bootstrapLeftSessions() {
    const vscode = acquireVsCodeApi();
    let pending = false;
    document.addEventListener('click', event => {
        const button = event.target.closest('button[data-action]');
        if (!button || button.disabled || pending) return;
        const action = button.dataset.action;
        if (!['open', 'create', 'refresh', 'settings'].includes(action)) return;
        if (action === 'open' || action === 'create') {
            pending = true;
            document.querySelectorAll('button').forEach(element => { element.disabled = true; });
            const status = document.getElementById('status');
            status.textContent = status.dataset.working;
        }
        vscode.postMessage({ type: `leftSessions/${action}`, id: button.dataset.id, cwd: button.dataset.cwd });
    });
    window.addEventListener('message', event => {
        if (event.data?.type !== 'leftSessions/error') return;
        pending = false;
        document.querySelectorAll('button').forEach(button => { if (!button.dataset.unavailable) button.disabled = false; });
        document.getElementById('status').textContent = event.data.text;
    });
}());
