import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import type { CommissionItemDto, UserDto } from "../api/types";
import { Modal } from "./Modal";

interface MemberOption {
  id: number;
  nickname: string;
}

interface Row {
  userId: number;
  /** 百分比（0~100，UI 显示）；提交时转为 0~1 */
  percent: number;
}

interface CommissionFormModalProps {
  title: string;
  initialItems: CommissionItemDto[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (items: { userId: number; percentage: number }[]) => Promise<void>;
}

/** 空行占位（select 用） */
const EMPTY_USER = -1;

export function CommissionFormModal({
  title,
  initialItems,
  busy,
  onClose,
  onSubmit,
}: CommissionFormModalProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 成交人候选：全量成员（admin/operator 可读 users 列表）
  const { data: members } = useQuery({
    queryKey: ["users", "select", "all"],
    queryFn: async () =>
      (
        await api.get<{ data: UserDto[] }>(
          "/users?page=1&pageSize=100&jobTitle=&employmentStatus=&accountStatus=",
        )
      )?.data ?? [],
  });
  const memberOptions: MemberOption[] = (members ?? [])
    .filter((u) => u.accountStatus === "enabled")
    .map((u) => ({ id: u.id, nickname: u.nickname }));

  useEffect(() => {
    setRows(
      initialItems.map((it) => ({
        userId: it.userId,
        percent: Math.round(it.percentage * 10000) / 100,
      })),
    );
    setError(null);
  }, [initialItems]);

  const setRow = (index: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const updatePercent = (index: number, raw: string) => {
    const value = Number(raw);
    setRow(index, { percent: Number.isFinite(value) ? value : 0 });
  };

  const addRow = () => setRows((prev) => [...prev, { userId: EMPTY_USER, percent: 0 }]);

  const removeRow = (index: number) =>
    setRows((prev) => prev.filter((_, i) => i !== index));

  const submit = async () => {
    const items = rows
      .filter((r) => r.userId !== EMPTY_USER)
      .map((r) => ({ userId: r.userId, percentage: r.percent / 100 }));
    const sum = items.reduce((s, it) => s + it.percentage, 0);
    if (sum > 1) {
      setError("分成比例总和不能超过 100%");
      return;
    }
    setError(null);
    await onSubmit(items);
  };

  return (
    <Modal title={title} wide onClose={onClose}>
      <p style={{ marginTop: 0, fontSize: 13 }}>
        每个成交人配置占成交金额的比例(0~100,百分比)。比例以 <strong>税后金额</strong> 为基数计算,总和不能超过 100%。成交后即可还原为默认方案。
      </p>
      <table className="settings-form">
        <thead>
          <tr>
            <th style={{ textAlign: "left", width: "40%" }}>成交人</th>
            <th style={{ textAlign: "left" }}>比例(%)</th>
            <th style={{ width: 48 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td>
                <select
                  autoComplete="off"
                  aria-label="成交人"
                  value={row.userId === EMPTY_USER ? "" : row.userId}
                  onChange={(e) =>
                    setRow(i, { userId: Number(e.target.value) || EMPTY_USER })
                  }
                >
                  <option value="">请选择成员…</option>
                  {memberOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.nickname}(#{m.id})
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={Number.isNaN(row.percent) ? "" : row.percent}
                  onChange={(e) => updatePercent(i, e.target.value)}
                />
              </td>
              <td>
                <button type="button" onClick={() => removeRow(i)} aria-label="删除该行">
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && (
        <p style={{ fontSize: 13, color: "#666" }}>尚未配置成交人,保存将还原为默认方案。</p>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" onClick={addRow}>
          加一行
        </button>
        <button type="button" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={() => void submit()}
        >
          保存
        </button>
      </div>
    </Modal>
  );
}
