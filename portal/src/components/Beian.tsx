import { useEffect, useState } from "react";
import { Typography } from "antd";
import { api, type SiteInfo } from "../api";

// 页面底部的备案号：ICP 备案号链接到工信部的备案系统，公安备案号链接到公安备案的查询页，都在新标签页打开。
// 号码在 .env 的 ICP_BEIAN、POLICE_BEIAN 里配置，都没配置（或取不到）时什么也不显示。
// 门户各页面共用一份，只请求一次。
let siteRequest: Promise<SiteInfo | null> | undefined;

function loadSite() {
  siteRequest ??= api.site().catch(() => null);
  return siteRequest;
}

export default function Beian() {
  const [site, setSite] = useState<SiteInfo | null>(null);

  useEffect(() => {
    loadSite().then(setSite);
  }, []);

  if (!site || (!site.icp && !site.police)) return null;
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
