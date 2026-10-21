import Board from "./pages/Board";
import Settings from "./pages/Settings";

// 只有记分板和设置两个页面，用路径区分即可，不引入路由库。门户“设置”页链接到 /apps/family/settings。
export default function App() {
  return location.pathname.startsWith("/apps/family/settings") ? <Settings /> : <Board />;
}
