import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// 在门户的标签页里打开时页面底色透明，透出门户的背景；单独在浏览器标签页打开时照常用灰底。
if (window.self !== window.top) document.documentElement.classList.add("embedded");
// 应用管理内的构建页由门户负责宽度和滚动；单独打开构建器继续使用原布局。
if (window.frameElement?.getAttribute("data-platform-layout") === "content") {
  document.documentElement.classList.add("platform-managed");
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
