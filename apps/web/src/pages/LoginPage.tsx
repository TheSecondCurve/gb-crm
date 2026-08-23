import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";

import { useAuth } from "../auth/AuthProvider";
import { ApiError } from "../api/client";
import { homePath, NoPagesPlaceholder } from "../components/PageGuard";
import { BRAND_NAME } from "../brand";

export function LoginPage() {
  const { me, isLoading, login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 已登录访问 /login 直接跳落地页（homePath 统一推导）；pages 为空 → 占位兜底（H5 防死循环）
  if (!isLoading && me) {
    const target = homePath(me.pages);
    if (target === null) return <NoPagesPlaceholder />;
    return <Navigate to={target} replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(username, password);
      // 成功后 me 更新，上方按 homePath 自动跳落地页（pages 为空则就地显示占位）
    } catch (err) {
      // 401 与其它失败统一展示服务端中文文案，不暴露失败原因
      setError(err instanceof ApiError ? err.message : "登录失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={(e) => void onSubmit(e)}>
        <h1 className="login-title">{BRAND_NAME}</h1>
        <label className="field">
          用户名
          <input
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="field">
          密码
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}
