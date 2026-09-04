// 资料存储 tab（K57，系统设置页）：S3 兼容对象存储配置（system_configs code='materialsS3'，仅 admin）。
// 保存并启用后，「对象存储」类型资料上传到该桶。secretAccessKey 只回掩码：输入留空 = 不改。
import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "../api/client";
import type { MaterialsS3ConfigDto } from "../api/types";
import { useToast } from "./Toast";

interface StorageForm {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const emptyForm: StorageForm = {
  enabled: false,
  endpoint: "",
  region: "",
  bucket: "",
  prefix: "",
  accessKeyId: "",
  secretAccessKey: "",
};

function formFromDto(cfg: MaterialsS3ConfigDto): StorageForm {
  return {
    enabled: cfg.enabled,
    endpoint: cfg.endpoint ?? "",
    region: cfg.region ?? "",
    bucket: cfg.bucket ?? "",
    prefix: cfg.prefix ?? "",
    accessKeyId: cfg.accessKeyId ?? "",
    secretAccessKey: "",
  };
}

export function MaterialsStorageTab() {
  const showToast = useToast();
  const queryClient = useQueryClient();
  const { data: config } = useQuery({
    queryKey: ["system", "materials-s3-config"],
    queryFn: async () =>
      (await api.get<{ data: MaterialsS3ConfigDto }>("/system/materials-s3-config"))?.data,
  });

  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [form, setForm] = useState<StorageForm>(emptyForm);

  useEffect(() => {
    if (config) setForm(formFromDto(config));
  }, [config]);

  const toastError = (err: unknown, fallback: string) =>
    showToast(err instanceof ApiError ? err.message : fallback);

  const buildBody = (): Record<string, unknown> => {
    const body: Record<string, unknown> = {};
    if (form.enabled !== (config?.enabled ?? false)) body.enabled = form.enabled;
    if (form.endpoint.trim() !== (config?.endpoint ?? ""))
      body.endpoint = form.endpoint.trim() || null;
    if (form.region.trim() !== (config?.region ?? "")) body.region = form.region.trim() || null;
    if (form.bucket.trim() !== (config?.bucket ?? "")) body.bucket = form.bucket.trim() || null;
    if (form.prefix.trim() !== (config?.prefix ?? "")) body.prefix = form.prefix.trim() || null;
    if (form.accessKeyId.trim() !== (config?.accessKeyId ?? ""))
      body.accessKeyId = form.accessKeyId.trim() || null;
    if (form.secretAccessKey.trim() !== "") body.secretAccessKey = form.secretAccessKey.trim();
    return body;
  };

  const saveConfig = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.patch("/system/materials-s3-config", buildBody());
      setForm((f) => ({ ...f, secretAccessKey: "" }));
      await queryClient.invalidateQueries({ queryKey: ["system", "materials-s3-config"] });
      showToast("已保存资料存储配置");
    } catch (err) {
      toastError(err, "保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      const res = await api.post<{ data: { probeKey: string } }>("/system/materials-s3-config/test");
      showToast(`连接成功（探针对象 ${res?.data.probeKey} 已写入并删除）`);
    } catch (err) {
      toastError(err, "连接失败，请检查配置");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="settings-section">
      <div className="card">
        <div className="card-head">
          <h2>资料存储（S3 兼容对象存储）</h2>
        </div>
        <div className="card-body">
          <p style={{ marginTop: 0, fontSize: 13 }}>
            启用后，「对象存储」类型的资料会上传到该桶（与「远程备份」配置互相独立，可填同一服务商不同
            Bucket / 前缀）。图片可在管理端在线预览，其他文件可下载。
          </p>
          <form className="settings-form" onSubmit={(e) => void saveConfig(e)}>
            <label className="inline-field field-span">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
              />
              启用资料对象存储
            </label>
            <label className="field">
              Endpoint
              <input
                autoComplete="off"
                placeholder="如 https://oss-cn-hangzhou.aliyuncs.com（MinIO / OSS / COS / R2 均可）"
                value={form.endpoint}
                onChange={(e) => setForm((f) => ({ ...f, endpoint: e.target.value }))}
              />
            </label>
            <label className="field">
              Region
              <input
                autoComplete="off"
                placeholder="可空，默认 us-east-1；OSS 可填 oss-cn-hangzhou"
                value={form.region}
                onChange={(e) => setForm((f) => ({ ...f, region: e.target.value }))}
              />
            </label>
            <label className="field">
              Bucket
              <input
                autoComplete="off"
                placeholder="如 gb-crm-files"
                value={form.bucket}
                onChange={(e) => setForm((f) => ({ ...f, bucket: e.target.value }))}
              />
            </label>
            <label className="field">
              路径前缀
              <input
                autoComplete="off"
                placeholder="可空；如 materials/（自动归一化结尾斜杠）"
                value={form.prefix}
                onChange={(e) => setForm((f) => ({ ...f, prefix: e.target.value }))}
              />
            </label>
            <label className="field">
              AccessKeyId
              <input
                autoComplete="off"
                value={form.accessKeyId}
                onChange={(e) => setForm((f) => ({ ...f, accessKeyId: e.target.value }))}
              />
            </label>
            <label className="field">
              SecretAccessKey
              <input
                type="password"
                autoComplete="new-password"
                placeholder={
                  config?.secretKeySet ? `已配置（${config.secretKeyMasked}），留空则不改` : "未配置"
                }
                value={form.secretAccessKey}
                onChange={(e) => setForm((f) => ({ ...f, secretAccessKey: e.target.value }))}
              />
            </label>
            <div className="modal-actions field-span">
              <button type="button" onClick={() => void testConnection()} disabled={testing}>
                {testing ? "测试中…" : "测试连接"}
              </button>
              <button
                type="button"
                onClick={() => config && setForm(formFromDto(config))}
                disabled={busy}
              >
                还原
              </button>
              <button type="submit" className="btn-primary" disabled={busy}>
                保存配置
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
