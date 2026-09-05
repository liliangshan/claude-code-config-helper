/**
 * @file CliProcess 子进程存活判断与强制终止回归测试。
 *
 * 覆盖 B1：此前 `disposeRunningChild()` 用 `child.killed` 判断进程是否退出，
 * 而 `killed` 只表示信号已发送，导致「SIGTERM 1500ms 未退出则 SIGKILL」的兜底
 * 永远不会触发；忽略 SIGTERM 的 CLI 会永远留在系统里。
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { test } from 'node:test';

import { installVscodeStub } from '../../__tests__/testUtils/vscodeStub';

installVscodeStub({ values: { claudeCodeConfigHelper: {} } });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CliProcess } = require('../cliProcess') as typeof import('../cliProcess');

/**
 * 忽略 SIGTERM 并保持存活的测试子进程脚本。
 *
 * 装好信号处理器后立刻打印 ready，测试必须等到这一行再发信号：
 * Node 启动期（约几十毫秒）还没注册 handler，此时 SIGTERM 会走默认行为直接杀掉进程，
 * 那样就测不到 SIGKILL 兜底了。
 */
const IGNORE_SIGTERM_SCRIPT =
    "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);";

/**
 * 等待子进程 stdout 打印 ready。
 *
 * @param child 目标子进程。
 */
function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise<void>((resolve) => {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (text: string) => {
            if (text.includes('ready')) resolve();
        });
    });
}

/**
 * 把一个真实子进程塞进 CliProcess 实例，跳过需要真实 CLI 路径的 start()。
 *
 * @param instance 目标 CliProcess 实例。
 * @param child    已 spawn 的子进程。
 */
function attachChild(instance: InstanceType<typeof CliProcess>, child: ChildProcessWithoutNullStreams): void {
    const internal = instance as unknown as {
        child: ChildProcessWithoutNullStreams;
        childExited: boolean;
        bindChildEvents: (c: ChildProcessWithoutNullStreams) => void;
    };
    internal.childExited = false;
    internal.child = child;
    internal.bindChildEvents(child);
}

test('stop(): 忽略 SIGTERM 的子进程会在 1.6s 内被 SIGKILL 收掉', async () => {
    const proc = new CliProcess();
    const child = spawn(process.execPath, ['-e', IGNORE_SIGTERM_SCRIPT], { stdio: 'pipe' });
    await waitForReady(child);
    attachChild(proc, child);

    const started = Date.now();
    await proc.stop();
    // 兜底 SIGKILL 在 1500ms 触发，这里给到 1.6s 的判定窗口。
    assert.ok(Date.now() - started < 3000, 'stop() 不应长时间挂起');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.notEqual(child.exitCode === null && child.signalCode === null, true, '子进程应已被强制终止');
    assert.equal(child.signalCode, 'SIGKILL');
});

test('send(): 进程已退出时返回 reject 而非抛未捕获的 EPIPE', async () => {
    const proc = new CliProcess();
    const child = spawn(process.execPath, ['-e', 'process.exit(0);'], { stdio: 'pipe' });
    attachChild(proc, child);
    await new Promise((resolve) => child.once('exit', resolve));

    await assert.rejects(() => proc.send('{"type":"user"}'), /进程未运行/);
});

/**
 * 用 getter/setter 覆写可写标志，白盒模拟「短暂不可写」窗口。
 *
 * 保留 setter 是因为 Node 内部在流销毁/关闭时也会赋值给 `writable`，
 * 普通只读属性会让内部赋值抛 TypeError。
 *
 * @param stdin 目标 stdin 流。
 * @param writable 初始可写值。
 * @returns 恢复原状的方法。
 */
function overrideWritable(stdin: NodeJS.WritableStream & { writable: boolean }, writable: boolean): () => void {
    let flag = writable;
    const descriptor = Object.getOwnPropertyDescriptor(stdin, 'writable');
    Object.defineProperty(stdin, 'writable', {
        get: () => flag,
        set: (value: boolean) => { flag = value; },
        configurable: true
    });
    return () => {
        delete (stdin as { writable?: boolean }).writable;
        if (descriptor) Object.defineProperty(stdin, 'writable', descriptor);
    };
}

test('send(): stdin 短暂不可写时等待恢复后写入成功，不误报「进程未运行」', async () => {
    const proc = new CliProcess();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'pipe' });
    attachChild(proc, child);

    // 短暂置不可写，50ms 后恢复并触发事件，模拟进程启动期的抖动窗口。
    const restore = overrideWritable(child.stdin, false);
    setTimeout(() => {
        overrideWritable(child.stdin, true);
        child.stdin.emit('writable');
    }, 50);

    try {
        await proc.send('{"type":"user"}');
    } finally {
        restore();
        child.kill('SIGKILL');
    }
});

test('send(): stdin 持续不可写时 1 秒后以明确的超时错误拒绝', async () => {
    const proc = new CliProcess();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'pipe' });
    attachChild(proc, child);

    // destroy 之后可写标志保持 false，走超时拒绝路径。
    child.stdin.destroy();
    const started = Date.now();
    await assert.rejects(() => proc.send('{"type":"user"}'), /未就绪/);
    assert.ok(Date.now() - started >= 900, '应等待接近超时窗口才拒绝');
    child.kill('SIGKILL');
});

test('重启后旧进程迟到的退出事件不会污染新进程的存活状态', async () => {
    const proc = new CliProcess();
    const oldChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'pipe' });
    attachChild(proc, oldChild);

    // 杀掉旧进程但不同步等待；随后立刻换成新进程（模拟重启），
    // 旧进程的退出事件晚于新进程 spawn 才到达。
    oldChild.kill('SIGKILL');
    const newChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'pipe' });
    attachChild(proc, newChild);

    // 等旧进程的退出事件派发完，再确认新进程状态未被污染。
    await new Promise((resolve) => oldChild.once('exit', resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const internal = proc as unknown as { childExited: boolean };
    assert.equal(internal.childExited, false, '旧进程的退出事件不应把新进程标记为已退出');
    await proc.send('{"type":"user"}');
    newChild.kill('SIGKILL');
});
