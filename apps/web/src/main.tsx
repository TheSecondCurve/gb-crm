import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// PR 1 骨架占位：Router / QueryClientProvider / 页面在 PR 8 起落地（K26）。
function App() {
  return <div>闪光 · 客户运营</div>;
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
