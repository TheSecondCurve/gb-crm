/**
 * 行内 PATCH 队列（design.md §7.6 / §8 / K8 / K24）。
 *
 * 与框架无关的纯 TS：DataGrid 之外也可单测。核心约束：
 * - 每行一条队列，禁止对同一行并行 PATCH；
 * - enqueue 时 pending 按 mergeKernel 合并（同键后者赢）；
 * - 每次 PATCH 带上一次 200 的 updatedAt（行级 OCC）；
 * - 409 → 用响应 data 整行替换、丢弃 pending（本地编辑作废，以服务端为准）。
 */

/** 同键后者赢。 */
export function mergeKernel(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...base, ...patch };
}

export interface RowPatchQueueState {
  /** 是否正有一个 PATCH 在途 */
  inflight: boolean;
  /** 已合并、尚未发出的 patch */
  pending: Record<string, unknown>;
  /** 最近一次 200（或 409 整行替换）后的行版本 */
  updatedAt: number;
}

/** patchFn 抛出的 409 需满足此形状（ApiError 天然满足：status + data）。 */
interface ConflictLike<Row> {
  status: number;
  data: Row;
}

function isConflict<Row>(err: unknown): err is ConflictLike<Row> {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { status?: unknown }).status === 409 &&
    (err as { data?: unknown }).data !== undefined
  );
}

export interface RowPatchQueueOptions<Row extends { updatedAt: number }> {
  /** 初始 updatedAt（来自当前行缓存） */
  updatedAt: number;
  /** 真正发请求；body 由队列补上 updatedAt。resolve 完整行（200）。409 时 reject 带 status/data 的错误。 */
  patchFn: (body: Record<string, unknown>) => Promise<Row>;
  /** 200 合并 / 409 整行替换，都会回调（调用方写 react-query cache） */
  onRow: (row: Row) => void;
  /** 409 额外回调（调用方弹 Toast「该行已被他人更新」） */
  onConflict?: (row: Row) => void;
  /** 非 409 错误回调；pending 同样丢弃（不静默重试，避免写偏） */
  onError?: (err: unknown) => void;
}

export interface RowPatchQueue {
  /** 合并进 pending；无 inflight 则立即开始 drain */
  enqueue: (patch: Record<string, unknown>) => void;
  /** 等队列排空（debounce 的取消与入队由调用方先做）。resolve 时所有已入队 PATCH 已完结 */
  flush: () => Promise<void>;
  /** 外部刷新了行（如 GET refetch）且队列空闲时，对齐版本号 */
  syncUpdatedAt: (updatedAt: number) => void;
  getState: () => RowPatchQueueState;
}

export function createRowPatchQueue<Row extends { updatedAt: number }>(
  opts: RowPatchQueueOptions<Row>,
): RowPatchQueue {
  const state: RowPatchQueueState = {
    inflight: false,
    pending: {},
    updatedAt: opts.updatedAt,
  };
  /** 当前这一轮 drain 的 promise；flush 等它 */
  let current: Promise<void> | null = null;

  async function drain(): Promise<void> {
    state.inflight = true;
    try {
      while (Object.keys(state.pending).length > 0) {
        const patch = state.pending;
        state.pending = {};
        try {
          const row = await opts.patchFn({ ...patch, updatedAt: state.updatedAt });
          state.updatedAt = row.updatedAt;
          opts.onRow(row);
        } catch (err) {
          if (isConflict<Row>(err)) {
            const row = err.data;
            state.updatedAt = row.updatedAt;
            state.pending = {};
            opts.onRow(row);
            opts.onConflict?.(row);
          } else {
            state.pending = {};
            opts.onError?.(err);
          }
          return;
        }
      }
    } finally {
      state.inflight = false;
    }
  }

  return {
    enqueue(patch) {
      state.pending = mergeKernel(state.pending, patch);
      if (!state.inflight) {
        // drain 内 await 期间新 enqueue 的 patch 会被 while 循环吃掉，不会并行
        current = drain();
      }
    },
    async flush() {
      // enqueue 与 drain 启动在同一同步段内完成，current 必已就位
      if (current) await current;
    },
    syncUpdatedAt(updatedAt) {
      if (!state.inflight && Object.keys(state.pending).length === 0) {
        state.updatedAt = updatedAt;
      }
    },
    getState: () => ({ ...state, pending: { ...state.pending } }),
  };
}
