import "@ant-design/v5-patch-for-react-19";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { EMBEDDED_EVENT, type EmbeddedDetail } from "./components/AppTabs";
import { ThemeProvider } from "./theme";
import "./styles.css";

// 门户被加载进了自己的应用标签页（应用里点了指向门户的链接，或者登录过期跳到了登录页），不在内嵌页里再套一层门户，
// 交给外层门户处理；外层不是门户时（例如被别的网页嵌入），整个窗口跳到这个网址。
function embedded() {
  if (window.top === window.self) return false;
  const url = location.pathname + location.search;
  try {
    const detail: EmbeddedDetail = { frame: window.frameElement, url };
    const handled = !window.parent.dispatchEvent(new CustomEvent(EMBEDDED_EVENT, { detail, cancelable: true }));
    if (!handled) window.top!.location.href = url;
  } catch {
    window.top!.location.href = url;
  }
  return true;
}

if (!embedded()) {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </StrictMode>,
  );
}
