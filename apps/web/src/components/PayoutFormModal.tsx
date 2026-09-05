import { useEffect, useState } from "react";

import type { DealPayoutDto } from "../api/types";
import { epochMsToDate, dateToEpochMs } from "../columns/common";
import { Modal } from "./Modal";

interface PayoutSlot {
  seq: 1 | 2;
  /** 支付日期（YYYY-MM-DD，UI） */
  date: string;
  /** 比例（0~100，UI 显示） */
  rate: number;
}

interface PayoutFormModalProps {
  title: string;
  /** 已有 payout（可为空） */
  initialPayouts: DealPayoutDto[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (payouts: { seq: 1 | 2; payoutDate: number; rate: number }[]) => Promise<void>;
}

export function PayoutFormModal({
  title,
  initialPayouts,
  busy,
  onClose,
  onSubmit,
}: PayoutFormModalProps) {
  const [slots, setSlots] = useState<PayoutSlot[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const existing = initialPayouts
      .sort((a, b) => a.seq - b.seq)
      .map((p) => ({
        seq: p.seq as 1 | 2,
        date: epochMsToDate(p.payoutDate),
        rate: Math.round(p.rate * 10000) / 100,
      }));
    setSlots(existing);
    setError(null);
  }, [initialPayouts]);

  const setSlot = (seq: 1 | 2, patch: Partial<PayoutSlot>) =>
    setSlots((prev) => prev.map((s) => (s.seq === seq ? { ...s, ...patch } : s)));

  const addSlot = (seq: 1 | 2) => {
    if (slots.some((s) => s.seq === seq)) return;
    setSlots((prev) => [...prev, { seq, date: "", rate: 100 }].sort((a, b) => a.seq - b.seq));
  };

  const removeSlot = (seq: 1 | 2) => setSlots((prev) => prev.filter((s) => s.seq !== seq));

  const submit = async () => {
    const payouts = slots
      .filter((s) => s.date !== "")
      .map((s) => {
        const ms = dateToEpochMs(s.date);
        if (ms === null) {
          setError(`第 ${s.seq} 期支付日期需为 YYYY-MM-DD`);
          return null;
        }
        return { seq: s.seq, payoutDate: ms, rate: s.rate / 100 };
      });
    if (payouts.some((p) => p === null)) return;
    setError(null);
    await onSubmit(payouts as { seq: 1 | 2; payoutDate: number; rate: number }[]);
  };

  return (
    <Modal title={title} wide onClose={onClose}>
      <p style={{ marginTop: 0, fontSize: 13 }}>
        每笔成交最多两个支付期（圈子类产品通常分开始月/结束月各 50%，其他产品交付月 100%）。
        金额按 <strong>分红池 × 比例</strong> 由服务端计算；比例总和≤100%，交付日期为空时无法设置。
      </p>
      <table className="settings-form">
        <thead>
          <tr>
            <th style={{ textAlign: "left", width: 60 }}>期数</th>
            <th style={{ textAlign: "left" }}>支付日期</th>
            <th style={{ textAlign: "left" }}>比例(%)</th>
            <th style={{ width: 48 }} />
          </tr>
        </thead>
        <tbody>
          {slots.map((s) => (
            <tr key={s.seq}>
              <td>第 {s.seq} 期</td>
              <td>
                <input
                  type="date"
                  aria-label={`第 ${s.seq} 期支付日期`}
                  value={s.date}
                  onChange={(e) => setSlot(s.seq, { date: e.target.value })}
                />
              </td>
              <td>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  aria-label={`第 ${s.seq} 期比例`}
                  value={Number.isNaN(s.rate) ? "" : s.rate}
                  onChange={(e) => setSlot(s.seq, { rate: Number(e.target.value) || 0 })}
                />
              </td>
              <td>
                <button type="button" onClick={() => removeSlot(s.seq)} aria-label={`删除第 ${s.seq} 期`}>
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="card-footer" style={{ marginTop: 12 }}>
        <button type="button" onClick={() => addSlot(1)} disabled={slots.some((s) => s.seq === 1)}>
          加第 1 期
        </button>
        <button type="button" onClick={() => addSlot(2)} disabled={slots.some((s) => s.seq === 2)}>
          加第 2 期
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void submit()}>
          保存
        </button>
      </div>
    </Modal>
  );
}
