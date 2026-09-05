/**
 * @file 测试用最小 vscode 模块 stub。
 *
 * 用 `require.cache` 把 `vscode` 注入到 Node `node:test` 运行环境，让仅依赖
 * `vscode.workspace.getConfiguration` / `vscode.window` / `vscode.ConfigurationTarget`
 * 的纯逻辑模块也能在没有 VS Code 真实运行时的情况下被单元测试覆盖。
 *
 * 使用方式：在 `*.test.ts` 顶部、所有真实 import 之前调用 {@link installVscodeStub}
 * 并传入需要 stub 的配置；之后再 `import` 待测模块即可拿到注入后的依赖。
 */

import Module from 'node:module';

/**
 * 调用 {@link installVscodeStub} 时可注入的 inspect 结果。
 */
export interface VscodeInspectResult<T> {
    /** 配置项默认值。 */
    defaultValue?: T;
    /** 全局值（application scope，对应 ConfigurationTarget.Global）。 */
    globalValue?: T;
    /** 工作区值（resource scope，对应 ConfigurationTarget.Workspace）。 */
    workspaceValue?: T;
    /** 工作区文件夹值（resource scope，更精细）。 */
    workspaceFolderValue?: T;
}

/**
 * 待 stub 的 vscode 配置快照。
 */
export interface VscodeStubConfig {
    /** 命名空间 → key → 当前 get() 返回值。 */
    values: Record<string, Record<string, unknown>>;
    /** 命名空间 → key → inspect() 返回值。 */
    inspect?: Record<string, Record<string, VscodeInspectResult<unknown>>>;
    /**
     * vscode.workspace.workspaceFolders 数组中的第一个 folder fsPath；
     * 没有打开工作区时传 undefined。
     */
    workspaceFolderFsPath?: string;
    /** VS Code UI kind；默认模拟 Desktop。 */
    uiKind?: number;
}

/**
 * 把一个最小化 vscode mock 注入到 Node require 缓存。
 *
 * 注入后所有 `import * as vscode from 'vscode'` 都会拿到本 stub。本函数会
 * 立即生效；如需在同一进程中切换配置，调用方可以在 stub 返回值上替换
 * `values` / `inspect` 字段。
 *
 * @param config 初始 stub 配置。
 * @returns 已注入的 stub，调用方可继续读写 `values` / `inspect` 字段以模拟运行时配置变��。
 */
export function installVscodeStub(config: VscodeStubConfig): VscodeStubConfig {
    const stub: VscodeStubConfig = config;

    const ConfigurationTarget = {
        Global: 1,
        Workspace: 2,
        WorkspaceFolder: 3
    } as const;

    const buildWorkspaceConfiguration = (namespace: string) => {
        const values = (): Record<string, unknown> => stub.values[namespace] || {};
        const inspect = (): Record<string, VscodeInspectResult<unknown>> => stub.inspect?.[namespace] || {};
        return {
            get<T>(key: string, defaultValue?: T): T {
                const map = values();
                if (Object.prototype.hasOwnProperty.call(map, key)) {
                    return map[key] as T;
                }
                return defaultValue as T;
            },
            inspect<T>(key: string): VscodeInspectResult<T> | undefined {
                const map = inspect();
                return map[key] as VscodeInspectResult<T> | undefined;
            },
            async update(_key: string, _value: unknown, _target?: number): Promise<void> {
                // tests 不验证写入路径，这里仅 no-op。
            },
            has(key: string): boolean {
                return Object.prototype.hasOwnProperty.call(values(), key);
            }
        };
    };

    class EventEmitter<T> {
        public readonly event = () => ({ dispose() {} });
        public fire(_event?: T): void {}
        public dispose(): void {}
    }

    const fakeVscode = {
        ConfigurationTarget,
        EventEmitter,
        UIKind: {
            Desktop: 1,
            Web: 2
        },
        workspace: {
            getConfiguration(namespace: string) {
                return buildWorkspaceConfiguration(namespace);
            },
            get workspaceFolders() {
                return stub.workspaceFolderFsPath
                    ? [{ uri: { fsPath: stub.workspaceFolderFsPath } }]
                    : undefined;
            },
            getWorkspaceFolder() {
                return undefined;
            },
            /**
             * 文件监听器桩：只返回可用的空实现，测试里不真正触发事件。
             *
             * ConfigManager 构造时会用它监听 Claude settings.json 的创建/删除，
             * 缺少这个方法会让构造函数里的异步初始化抛未捕获异常。
             *
             * @returns 具备 onDidCreate/onDidChange/onDidDelete/dispose 的假 watcher。
             */
            createFileSystemWatcher() {
                const noopDisposable = { dispose() { /* noop */ } };
                return {
                    onDidCreate: () => noopDisposable,
                    onDidChange: () => noopDisposable,
                    onDidDelete: () => noopDisposable,
                    dispose() { /* noop */ }
                };
            }
        },
        window: {
            activeTextEditor: undefined
        },
        env: {
            language: 'en',
            get uiKind() {
                return stub.uiKind ?? 1;
            }
        },
        Uri: {
            file(p: string) { return { fsPath: p }; }
        }
    };

    // Node ESM/CJS 解析下，stub 的 cache key 与原生 require 路径一致即可命中。
    // 这里直接覆盖 builtin 'vscode' 的 require resolve 结果。
    const originalResolve = (Module as unknown as {
        _resolveFilename: (request: string, parent: NodeJS.Module | null, ...rest: unknown[]) => string;
    })._resolveFilename;
    (Module as unknown as {
        _resolveFilename: (request: string, parent: NodeJS.Module | null, ...rest: unknown[]) => string;
    })._resolveFilename = function patched(this: unknown, request: string, parent: NodeJS.Module | null, ...rest: unknown[]): string {
        if (request === 'vscode') return 'vscode';
        return originalResolve.call(this, request, parent, ...rest);
    };

    const stubModule: NodeJS.Module = {
        id: 'vscode',
        filename: 'vscode',
        loaded: true,
        exports: fakeVscode,
        parent: null,
        children: [],
        paths: [],
        require: require as NodeJS.Require,
        path: ''
    } as unknown as NodeJS.Module;
    (require.cache as Record<string, NodeJS.Module | undefined>)['vscode'] = stubModule;

    return stub;
}
