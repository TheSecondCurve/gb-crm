import { describe, expect, it, vi } from "vitest";

import {
  createRowPatchQueue,
  mergeKernel,
  type RowPatchQueue,
} from "../src/components/DataGrid/rowPatchQueue";

interface Row {
  id: number;
  updatedAt: number;
  [key: string]: unknown;
}

/** 可手动控制 resolve/reject 的 patchFn */
function makePatchFn() {
  const calls: Record<string, unknown>[] = [];
  const waiters: Array<{ resolve: (row: Row) => void; reject: (err: unknown) => void }> = [];
  const patchFn = vi.fn((body: Record<string, unknown>) => {
    calls.push(body);
    return new Promise<Row>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  });
  return { patchFn, calls, waiters };
}

function makeQueue(patchFn: (body: Record<string, unknown>) => Promise<Row>) {
  const rows: Row[] = [];
  const conflicts: Row[] = [];
  const queue: RowPatchQueue = createRowPatchQueue<Row>({
    updatedAt: 100,
    patchFn,
    onRow: (row) => rows.push(row),
    onConflict: (row) => conflicts.push(row),
  });
  return { queue, rows, conflicts };
}

describe("mergeKernel", () => {
  it("同键后者赢，异键并集", () => {
    expect(mergeKernel({ a: 1, b: 1 }, { b: 2, c: 3 })).toEqual({ a: 1, b: 2, c: 3 });
  });
});

describe("rowPatchQueue", () => {
  it("enqueue 无 inflight 时立即发出，body 带上 updatedAt", async () => {
    const { patchFn, calls, waiters } = makePatchFn();
    const { queue } = makeQueue(patchFn);

    queue.enqueue({ nickname: "新" });
    expect(patchFn).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual({ nickname: "新", updatedAt: 100 });
    expect(queue.getState().inflight).toBe(true);

    waiters[0]!.resolve({ id: 1, updatedAt: 101 });
    await queue.flush();
    expect(queue.getState()).toMatchObject({ inflight: false, updatedAt: 101, pending: {} });
  });

  it("inflight 期间 enqueue 合并进 pending，不并行；200 后用新 updatedAt 续发", async () => {
    const { patchFn, calls, waiters } = makePatchFn();
    const { queue, rows } = makeQueue(patchFn);

    queue.enqueue({ nickname: "a" });
    queue.enqueue({ phone: "1" });
    queue.enqueue({ phone: "2" }); // 同键后者赢
    expect(patchFn).toHaveBeenCalledTimes(1);

    waiters[0]!.resolve({ id: 1, updatedAt: 101 });
    await vi.waitFor(() => expect(patchFn).toHaveBeenCalledTimes(2));
    expect(calls[1]).toEqual({ phone: "2", updatedAt: 101 });

    waiters[1]!.resolve({ id: 1, updatedAt: 102 });
    await queue.flush();
    expect(rows.map((r) => r.updatedAt)).toEqual([101, 102]);
    expect(queue.getState().updatedAt).toBe(102);
  });

  it("409：用响应 data 整行替换、丢弃 pending、触发 onConflict", async () => {
    const { patchFn, waiters } = makePatchFn();
    const { queue, rows, conflicts } = makeQueue(patchFn);

    queue.enqueue({ nickname: "a" });
    queue.enqueue({ phone: "1" }); // 将被丢弃
    waiters[0]!.reject({ status: 409, data: { id: 1, updatedAt: 200, nickname: "别人的" } });
    await queue.flush();

    expect(patchFn).toHaveBeenCalledTimes(1); // pending 不再发
    expect(rows).toEqual([{ id: 1, updatedAt: 200, nickname: "别人的" }]);
    expect(conflicts).toHaveLength(1);
    expect(queue.getState()).toMatchObject({ updatedAt: 200, pending: {}, inflight: false });
  });

  it("409 之后的新 enqueue 使用替换后的 updatedAt", async () => {
    const { patchFn, calls, waiters } = makePatchFn();
    const { queue } = makeQueue(patchFn);

    queue.enqueue({ nickname: "a" });
    waiters[0]!.reject({ status: 409, data: { id: 1, updatedAt: 200 } });
    await queue.flush();

    queue.enqueue({ city: "上海" });
    expect(calls[1]).toEqual({ city: "上海", updatedAt: 200 });
    waiters[1]!.resolve({ id: 1, updatedAt: 201 });
    await queue.flush();
  });

  it("flush 等队列排空：resolve 前不返回", async () => {
    const { patchFn, waiters } = makePatchFn();
    const { queue } = makeQueue(patchFn);

    queue.enqueue({ nickname: "a" });
    queue.enqueue({ phone: "1" });

    let flushed = false;
    const p = queue.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    waiters[0]!.resolve({ id: 1, updatedAt: 101 });
    await vi.waitFor(() => expect(patchFn).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(flushed).toBe(false); // 第二个还没完

    waiters[1]!.resolve({ id: 1, updatedAt: 102 });
    await p;
    expect(flushed).toBe(true);
  });

  it("非 409 错误：丢弃 pending，回调 onError", async () => {
    const { patchFn, waiters } = makePatchFn();
    const onError = vi.fn();
    const queue = createRowPatchQueue<Row>({
      updatedAt: 100,
      patchFn,
      onRow: () => {},
      onError,
    });
    queue.enqueue({ nickname: "a" });
    queue.enqueue({ phone: "1" });
    waiters[0]!.reject(new Error("network"));
    await queue.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(patchFn).toHaveBeenCalledTimes(1);
    expect(queue.getState().pending).toEqual({});
  });
});
