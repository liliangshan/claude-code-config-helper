/**
 * @file 测试用 `vscode` 模块桩。
 *
 * llsTask 的 store / service 在模块顶层 `import * as vscode`，但单测在纯 Node 环境
 * 运行，没有真实 vscode 运行时。此桩通过劫持 `Module._load`，把对 'vscode' 的 require
 * 重定向到一个最小实现：仅覆盖 store/service 实际用到的 `workspace.workspaceFolders`
 * 与 `EventEmitter`。
 */

import Module from 'node:module';

/** 测试可写的工作区根目录列表；为空数组时 store 回退到 os.homedir()。 */
export const workspaceFolders: Array<{ uri: { fsPath: string } }> = [];

/** 最小事件发射器，模拟 vscode.EventEmitter 的 event/fire/dispose 三件套。 */
class EventEmitter<T> {
    private listeners: Array<(value: T) => void> = [];

    /** 订阅事件，返回可销毁的 disposable。 */
    public readonly event = (listener: (value: T) => void): { dispose: () => void } => {
        this.listeners.push(listener);
        return {
            dispose: () => {
                this.listeners = this.listeners.filter((item) => item !== listener);
            }
        };
    };

    /** 触发事件，依次回调所有监听器。 */
    public fire(value: T): void {
        for (const listener of this.listeners.slice()) listener(value);
    }

    /** 清空监听器。 */
    public dispose(): void {
        this.listeners = [];
    }
}

/** 桩 vscode 模块对象。 */
const vscodeStub = {
    workspace: {
        get workspaceFolders() {
            return workspaceFolders.length > 0 ? workspaceFolders : undefined;
        }
    },
    EventEmitter
};

/**
 * 安装 vscode 模块桩：劫持 Module._load，使 require('vscode') 返回桩对象。
 *
 * 必须在 require store/service 之前调用。重复调用安全（幂等）。
 */
export function installVscodeStub(): void {
    const moduleAny = Module as unknown as {
        _load: (request: string, parent: unknown, isMain: boolean) => unknown;
        __vscodeStubInstalled?: boolean;
    };
    if (moduleAny.__vscodeStubInstalled) return;
    const originalLoad = moduleAny._load;
    moduleAny._load = function patchedLoad(request: string, parent: unknown, isMain: boolean): unknown {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.call(this, request, parent, isMain);
    };
    moduleAny.__vscodeStubInstalled = true;
}
