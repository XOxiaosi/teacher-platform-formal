import { describe, expect, it } from 'vitest';
import { createInMemoryMessageQueue } from '../../../src/features/wechat/index.js';
import type { NormalizedInboundMessage } from '../../../src/features/wechat/index.js';

function message(id: string): NormalizedInboundMessage {
  return {
    channel: 'wechat',
    externalMessageId: id,
    fromExternalUserId: `wx-${id}`,
    conversationType: 'private',
    messageType: 'text',
    text: `text-${id}`,
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor timeout'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('进程内内存消息队列（QueuePort）', () => {
  it('enqueue 入队；start(worker) 后按序消费；size 归零', async () => {
    const queue = createInMemoryMessageQueue({ maxSize: 10 });
    const received: string[] = [];
    queue.start(async (msg) => {
      received.push(msg.externalMessageId);
    });

    await queue.enqueue(message('m1'));
    await queue.enqueue(message('m2'));
    await queue.enqueue(message('m3'));

    await waitFor(() => received.length === 3);
    expect(received).toEqual(['m1', 'm2', 'm3']);
    expect(queue.size()).toBe(0);
  });

  it('worker 抛错不阻塞队列（继续消费后续消息）', async () => {
    const queue = createInMemoryMessageQueue({ maxSize: 10 });
    const received: string[] = [];
    queue.start(async (msg) => {
      if (msg.externalMessageId === 'bad') throw new Error('worker boom');
      received.push(msg.externalMessageId);
    });

    await queue.enqueue(message('bad'));
    await queue.enqueue(message('ok'));
    await waitFor(() => received.includes('ok'));
    expect(received).toEqual(['ok']);
  });

  it('前一条仍在处理时不并发启动后一条', async () => {
    const queue = createInMemoryMessageQueue({ maxSize: 10 });
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    await queue.start(async (msg) => {
      events.push(`start:${msg.externalMessageId}`);
      if (msg.externalMessageId === 'a') await firstBlocked;
      events.push(`end:${msg.externalMessageId}`);
    });
    await queue.enqueue(message('a'));
    await waitFor(() => events.includes('start:a'));
    await queue.enqueue(message('b'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(['start:a']);
    releaseFirst();
    await waitFor(() => events.includes('end:b'));
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('stop() 后 enqueue 拒绝（返回错误）', async () => {
    const queue = createInMemoryMessageQueue({ maxSize: 10 });
    await queue.start(async () => undefined);
    await queue.stop();
    const result = await queue.enqueue(message('after-stop'));
    expect(result.ok).toBe(false);
  });

  it('队列满：enqueue 返回错误（不吞消息）', async () => {
    const queue = createInMemoryMessageQueue({ maxSize: 2 });
    await queue.enqueue(message('a'));
    await queue.enqueue(message('b'));
    const third = await queue.enqueue(message('c'));
    expect(third.ok).toBe(false);
    expect(queue.size()).toBe(2);
  });

  it('worker 未启动时消息挂起在队列（size 不减少），start 后消费', async () => {
    const queue = createInMemoryMessageQueue({ maxSize: 10 });
    await queue.enqueue(message('pending'));
    expect(queue.size()).toBe(1);

    const received: string[] = [];
    await queue.start(async (msg) => {
      received.push(msg.externalMessageId);
    });
    await waitFor(() => received.length === 1);
    expect(received).toEqual(['pending']);
    expect(queue.size()).toBe(0);
  });
});
