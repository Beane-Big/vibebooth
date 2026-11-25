import { Typography } from "antd";
import { useSiteInfo } from "../site";

// 页面底部的备案号：ICP 备案号链接到工信部的备案系统，公安备案号链接到公安备案的查询页，都在新标签页打开。
// 优先使用管理员在“设置”里配置的值，未配置时回落到 .env 的 ICP_BEIAN、POLICE_BEIAN。
export default function Beian() {
  const site = useSiteInfo();

  if (!site.icp && !site.police) return null;
  return (
    <footer className="beian">
      {site.icp && (
        <Typography.Link type="secondary" href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">
          {site.icp}
        </Typography.Link>
      )}
      {site.police && (
        <Typography.Link
          type="secondary"
          href={`https://beian.mps.gov.cn/#/query/webSearch?code=${site.policeCode}`}
          target="_blank"
          rel="noreferrer"
        >
          {site.police}
        </Typography.Link>
      )}
    </footer>
  );
}
