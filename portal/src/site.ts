import { useEffect, useState } from "react";
import { api, type SiteInfo } from "./api";

const defaultSite: SiteInfo = {
  name: "Vibebooth",
  hasLogo: false,
  logoUrl: "",
  icp: "",
  police: "",
  policeCode: "",
  allowRegistration: true,
  terms: "",
  privacy: "",
};

let currentSite: SiteInfo = defaultSite;
let fetched = false;
const listeners = new Set<(info: SiteInfo) => void>();

function applyDocumentBranding(info: SiteInfo) {
  document.title = info.name || defaultSite.name;
  const iconHref = info.hasLogo && info.logoUrl ? info.logoUrl : "/favicon.ico";
  const appleHref = info.hasLogo && info.logoUrl ? info.logoUrl : "/apple-touch-icon.png";
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (icon && icon.getAttribute("href") !== iconHref) {
    icon.setAttribute("href", iconHref);
  }
  const apple = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
  if (apple && apple.getAttribute("href") !== appleHref) {
    apple.setAttribute("href", appleHref);
  }
}

export function setSiteInfo(info: SiteInfo) {
  currentSite = info;
  fetched = true;
  applyDocumentBranding(info);
  for (const fn of listeners) fn(info);
}

export function loadSiteInfo() {
  if (!fetched) {
    fetched = true;
    api
      .site()
      .then((info) => {
        currentSite = info;
        applyDocumentBranding(info);
        for (const fn of listeners) fn(info);
      })
      .catch(() => {});
  }
  return currentSite;
}

export function useSiteInfo(): SiteInfo {
  const [site, setSite] = useState<SiteInfo>(() => loadSiteInfo());
  useEffect(() => {
    listeners.add(setSite);
    if (currentSite !== site) setSite(currentSite);
    return () => {
      listeners.delete(setSite);
    };
  }, []);
  return site;
}
