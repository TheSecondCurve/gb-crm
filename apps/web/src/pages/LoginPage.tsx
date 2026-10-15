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
      <section className="login-cover" aria-hidden="true">
        <div className="login-cover-brand">
          <span className="brand-mark" />
          {BRAND_NAME}
        </div>
        <div className="login-cover-main">
          <div className="login-kicker">PRIVATE CLIENT STUDIO</div>
          <p className="login-slogan">
            让每一位客户，
            <br />
            都在同一条脉络里。
          </p>
        </div>
        <div className="login-cover-foot">
          <span>
            <b>01</b>客户档案
          </span>
          <span>
            <b>02</b>交付跟进
          </span>
          <span>
            <b>03</b>经营洞察
          </span>
        </div>
        <span className="login-cover-watermark">女</span>
      </section>
      <main className="login-side">
        <form className="login-card" onSubmit={(e) => void onSubmit(e)}>
          <div className="login-kicker">Workspace access</div>
          <h1 className="login-title">欢迎回来</h1>
          <p className="login-sub">登录，进入今天的客户版面。</p>
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
      </main>
    </div>
  );
}
