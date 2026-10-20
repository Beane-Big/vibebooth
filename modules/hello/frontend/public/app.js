// 调用本模块后端的对内接口；登录 Cookie 由浏览器自动带上，网关负责校验。
async function load() {
  const message = document.getElementById("message");
  const time = document.getElementById("time");
  try {
    const res = await fetch("/api/hello/greeting");
    if (res.status === 401) {
      location.href = "/login?next=" + encodeURIComponent(location.pathname);
      return;
    }
    const data = await res.json();
    message.textContent = data.message;
    time.textContent = "服务器时间：" + new Date(data.time).toLocaleString();
  } catch {
    message.textContent = "后端暂时不可用";
  }
}

load();
