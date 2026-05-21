/**
 * @file 统一日志输出封装。
 *
 * 使用 VS Code OutputChannel 作为日志后端，所有模块通过 {@link Logger} 单例输出，
 * 方便用户在"输出"面板中按通道筛选查看。
 */

import * as vscode from 'vscode';

import { OUTPUT_CHANNEL_NAME } from './constants';

/**
 * 日志级别。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 简单的日志封装类。
 *
 * 单例模式：扩展激活时调用 {@link Logger.init} 注入 OutputChannel，
 * 其它模块直接通过 {@link Logger.info} 等静态方法输出日志。
 */
export class Logger {
    /** 内部持有的 OutputChannel 实例（init 之后才会有值） */
    private static channel: vscode.OutputChannel | undefined;

    /**
     * 初始化日志通道。应在扩展 activate 入口尽早调用一次。
     *
     * @param context 扩展上下文，用于把 OutputChannel 加入 subscriptions 以便随扩展销毁。
     */
    public static init(context: vscode.ExtensionContext): void {
        if (Logger.channel) {
            return;
        }
        Logger.channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
        context.subscriptions.push(Logger.channel);
    }

    /**
     * 输出一条 debug 级别日志。
     * @param message 主消息文本
     * @param meta 可选的附加结构化数据，将以 JSON 形式追加输出
     */
    public static debug(message: string, meta?: unknown): void {
        Logger.write('debug', message, meta);
    }

    /**
     * 输出一条 info 级别日志。
     */
    public static info(message: string, meta?: unknown): void {
        Logger.write('info', message, meta);
    }

    /**
     * 输出一条 warn 级别日志。
     */
    public static warn(message: string, meta?: unknown): void {
        Logger.write('warn', message, meta);
    }

    /**
     * 输出一条 error 级别日志。
     *
     * 如果 meta 是 Error，会自动展开 message 与 stack。
     */
    public static error(message: string, meta?: unknown): void {
        if (meta instanceof Error) {
            Logger.write('error', `${message} :: ${meta.message}`, meta.stack);
        } else {
            Logger.write('error', message, meta);
        }
    }

    /**
     * 强制显示输出面板（用于关键错误场景，可选调用）。
     */
    public static show(): void {
        Logger.channel?.show(true);
    }

    /**
     * 内部统一格式化并写入 OutputChannel。
     */
    private static write(level: LogLevel, message: string, meta?: unknown): void {
        if (!Logger.channel) {
            // 未初始化时降级到 console，避免完全静默
            // eslint-disable-next-line no-console
            console.log(`[claude-router][${level}] ${message}`, meta ?? '');
            return;
        }
        const ts = new Date().toISOString();
        let line = `[${ts}] [${level.toUpperCase()}] ${message}`;
        if (meta !== undefined) {
            try {
                const text =
                    typeof meta === 'string' ? meta : JSON.stringify(meta, null, 2);
                line += `\n${text}`;
            } catch {
                line += `\n[unserializable meta]`;
            }
        }
        Logger.channel.appendLine(line);
    }
}
