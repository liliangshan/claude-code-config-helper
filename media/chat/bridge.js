/** 
 * 协议桥接脚本：在 React 捆绑包加载前执行，用于接管消息传递。
 * 
 * 参考实现的 React 前端通过 acquireVsCodeApi().postMessage() 发送消息，
 * 并监听 window.addEventListener('message', ...) 且只处理 type === "from-extension" 的消息。
 * 本桥接脚本确保消息格式兼容。
 */
(function () {
    // ---- 1. 接管 acquireVsCodeApi，拦截 Webview->扩展 消息 ----
    const origAcquire = window.acquireVsCodeApi;
    const _vsCodeApi = origAcquire();
    const origPost = _vsCodeApi.postMessage.bind(_vsCodeApi);

    // 保存原始的 postMessage
    _vsCodeApi._origPost = origPost;

    // 重写 postMessage: React 发送的消息原样传递
    // （扩展端 chatViewHost.ts 的 onDidReceiveMessage 会处理未知类型）
    // 不做翻译，让扩展层处理协议差异
    _vsCodeApi.postMessage = function (message) {
        // 记录日志（debug）
        console.log('[Bridge] Webview → Extension:', JSON.stringify(message).slice(0, 500));
        return origPost(message);
    };

    // 绕过 aquireVsCodeApi 返回修改后的 api 对象
    window.acquireVsCodeApi = function () {
        return _vsCodeApi;
    };

    // ---- 2. 监听扩展->Webview 消息，包装为 from-extension 格式 ----
    // React 前端只处理 event.data.type === "from-extension" 的消息
    // 扩展发送的是原始协议消息（如 {type: "session/init", ...}）
    // 这里添加自定义事件监听，在 React 的监听器之前处理
    const origAddEventListener = window.addEventListener;
    window.addEventListener = function (type, listener, options) {
        if (type === 'message') {
            // 包装原始监听器：拦截扩展消息，包装后传给 React
            const wrappedListener = function (event) {
                const msg = event.data;
                // 如果消息不是 from-extension 格式，则包装
                if (msg && msg.type && msg.type !== 'from-extension' && msg.type !== 'vscode-worker-ready') {
                    // 创建包装后的消息事件
                    const wrappedEvent = new MessageEvent('message', {
                        data: {
                            type: 'from-extension',
                            message: msg
                        },
                        origin: event.origin,
                        lastEventId: event.lastEventId,
                        source: event.source,
                        ports: event.ports
                    });
                    listener.call(this, wrappedEvent);
                    return;
                }
                // 已经是 from-extension 格式，直接传递
                listener.call(this, event);
            };
            return origAddEventListener.call(window, type, wrappedListener, options);
        }
        return origAddEventListener.call(window, type, listener, options);
    };

    console.log('[Bridge] 协议桥接已就绪');
})();
