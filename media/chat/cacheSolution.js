/**
 * 缓存命中率解决方案的共享纯计算函数。
 *
 * 浏览器通过全局对象使用，Node 测试通过 module.exports 使用。
 */
(function registerCacheSolution(root) {
    /**
     * 读取有限非负 token；非法值返回 0。
     *
     * @param {unknown} value 原始 token。
     * @returns {number} 可参与计算的 token。
     */
    function readToken(value) {
        return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
    }

    /**
     * 判断原始缓存命中比例是否低于 80%。
     *
     * 分母与界面一致：新输入 + 缓存写 + 缓存读。缺失、非法或总量为 0 时
     * 无法判断，不显示解决方案。阈值使用未取整比例，避免 79.96% 显示成 80%
     * 后错误隐藏链接。
     *
     * @param {unknown} usage usage 对象。
     * @returns {boolean} 是否展示解决方案。
     */
    function shouldShowCacheSolution(usage) {
        if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;
        var input = readToken(usage.inputTokens);
        var cacheWrite = readToken(usage.cacheCreationInputTokens);
        var cacheRead = readToken(usage.cacheReadInputTokens);
        var total = input + cacheWrite + cacheRead;
        return total > 0 && cacheRead / total < 0.8;
    }

    var api = { shouldShowCacheSolution: shouldShowCacheSolution };
    root.LlsCacheSolution = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
