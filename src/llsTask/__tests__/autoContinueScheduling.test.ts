/**
 * @file AutoContinueScheduler 调度状态与熔断计数单元测试。
 *
 * 覆盖 hasPendingWork 在「无定时器 / 续推定时器在等 / 空闲看门狗观察期」三种
 * 状态下的返回值，以及 resetMissingToolCounter 清零后熔断阈值重新计算——后者
 * 对应「切换任务流模型成功后重置计数」的修复意图。
 */

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { installVscodeStub } from './vscodeStub';

installVscodeStub();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AutoContinueScheduler } = require('../autoContinue') as typeof import('../autoContinue');

import type { LlsTaskService } from '../service';

/** 记录续推调用的假任务流服务，只实现调度器实际用到的方法。 */
class FakeTaskService {
    /** hasActiveWorkflow 的返回值，测试可随时改写。 */
    public active = true;

    /** isWorkflowCompleted 的返回值。 */
    public completed = false;

    public hasActiveWorkflow(): boolean {
        return this.active;
    }

    public isWorkflowCompleted(): boolean {
        return this.completed;
    }

    public getSnapshot(): { workflow: { tasks: [] } } {
        return { workflow: { tasks: [] } };
    }

    public buildContinuePrompt(): string {
        return '继续';
    }

    public getTexts(): { missingToolCircuitBreaker: string } {
        return { missingToolCircuitBreaker: '熔断' };
    }
}

/** 把 FakeTaskService 适配成构造函数形参类型。 */
function makeScheduler(service: FakeTaskService): InstanceType<typeof AutoContinueScheduler> {
    return new AutoContinueScheduler(service as unknown as LlsTaskService);
}

beforeEach(() => {
    // 静态字段是进程级单例，逐个用例前必须复位，避免相互污染。
    const scheduler = makeScheduler(new FakeTaskService());
    scheduler.cancel('测试前复位');
    scheduler.notifyRequestStarted();
    scheduler.resetMissingToolCounter('测试前复位');
});

test('无定时器且无看门狗时 hasPendingWork 为 false', () => {
    assert.equal(AutoContinueScheduler.hasPendingWork(), false);
});

test('续推定时器在等时 hasPendingWork 为 true，取消后回到 false', () => {
    const scheduler = makeScheduler(new FakeTaskService());
    scheduler.scheduleAfterWorkflowTool();
    assert.equal(AutoContinueScheduler.hasPendingWork(), true);
    scheduler.cancel('用例结束');
    assert.equal(AutoContinueScheduler.hasPendingWork(), false);
});

test('任务流不活跃时不会登记定时器，hasPendingWork 保持 false', () => {
    const service = new FakeTaskService();
    service.active = false;
    makeScheduler(service).scheduleAfterWorkflowTool();
    assert.equal(AutoContinueScheduler.hasPendingWork(), false);
});

test('空闲看门狗观察期内 hasPendingWork 为 true，收到新请求后回到 false', () => {
    const scheduler = makeScheduler(new FakeTaskService());
    scheduler.armIdleWatchdog();
    assert.equal(AutoContinueScheduler.hasPendingWork(), true);
    scheduler.notifyRequestStarted();
    assert.equal(AutoContinueScheduler.hasPendingWork(), false);
});

test('重置缺失工具计数后重新累计，不会被此前的次数带进熔断', () => {
    const scheduler = makeScheduler(new FakeTaskService());
    // 连续 3 次缺失工具：尚未越过阈值，仍会登记续推定时器。
    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    assert.equal(AutoContinueScheduler.hasPendingWork(), true);
    // 模拟「任务流模型已切换」清零后，下一次缺失工具仍从第 1 次算起。
    scheduler.resetMissingToolCounter('任务流模型已切换');
    scheduler.schedule();
    assert.equal(AutoContinueScheduler.hasPendingWork(), true);
    scheduler.cancel('用例结束');
});

test('未重置时超过阈值触发熔断，取消定时器且不再续推', () => {
    const scheduler = makeScheduler(new FakeTaskService());
    for (let i = 0; i < 4; i += 1) scheduler.schedule();
    assert.equal(AutoContinueScheduler.hasPendingWork(), false);
});

test('disposeAll 清空看门狗、定时器与熔断计数，下一轮从零开始计数', () => {
    const scheduler = makeScheduler(new FakeTaskService());
    scheduler.armIdleWatchdog();
    // 连续 3 次缺失工具：已经逼近熔断阈值（第 4 次熔断）。
    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    assert.equal(AutoContinueScheduler.hasPendingWork(), true);

    scheduler.disposeAll();
    // 定时器与看门狗都被清掉。
    assert.equal(AutoContinueScheduler.hasPendingWork(), false);

    // 熔断计数已归零：再来 3 次仍能登记定时器，第 4 次才熔断。
    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    assert.equal(AutoContinueScheduler.hasPendingWork(), true);
    scheduler.schedule();
    assert.equal(AutoContinueScheduler.hasPendingWork(), false);
});
