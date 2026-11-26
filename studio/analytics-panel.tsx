import { useCallback, useEffect, useMemo, useState } from "react";
import { SiteAnalytics, type SiteAnalyticsAdapter } from "../src/analytics.js";
import type { SiteAnalyticsConnectionAdapter } from "../src/site-analytics.js";
import { SiteApps } from "../src/site-apps.js";
import type { Project } from "../src/projects.js";
import { api, SessionExpiredError } from "./api-client.js";

/**
 * アナリティクスのタブ: 上に GA4 / Search Console の集計、owner には下に接続欄（計測タグと所有権確認は Studio では扱わない）。
 * owner かどうかは owner だけが読める membership API で確かめる。editor には接続欄を出さない。
 */
export function StudioSiteAnalytics({ project, connectable, expire }: { readonly project: Project; readonly connectable: boolean; readonly expire: () => void }) {
  const site = `/api/projects/${encodeURIComponent(project.id)}/sites/${encodeURIComponent(project.site.id)}`, base = `${site}/analytics`;
  const siteOrigin = project.site.domains[0] ?? null;
  const [owner, setOwner] = useState(false);
  const call = useCallback(async (path: string, options: { readonly method?: "GET" | "POST"; readonly body?: Record<string, unknown>; readonly signal?: AbortSignal } = {}) => {
    try { return await api(path, options); }
    catch (error) { if (error instanceof SessionExpiredError) expire(); throw error; }
  }, [expire]);
  useEffect(() => {
    setOwner(false);
    if (!connectable || siteOrigin === null) return;
    const controller = new AbortController();
    void call(`${site}/membership`, { signal: controller.signal }).then(() => { if (!controller.signal.aborted) setOwner(true); }).catch(() => undefined);
    return () => controller.abort();
  }, [call, connectable, site, siteOrigin]);
  const reportAdapter = useMemo<SiteAnalyticsAdapter>(() => ({
    loadAnalytics: (scope, signal) => call(`${base}/report?period=${encodeURIComponent(scope.period)}`, { signal })
  }), [base, call]);
  const connectionAdapter = useMemo<SiteAnalyticsConnectionAdapter>(() => {
    const post = (path: string, body: Record<string, unknown>, signal: AbortSignal) => call(`${base}${path}`, { method: "POST", body, signal });
    return {
      readConnection: (_target, signal) => call(`${base}/connection`, { signal }),
      readReport: ({ period }, signal) => call(`${base}/report?period=${encodeURIComponent(period)}`, { signal }),
      prepareGa4TrackingTag: ({ measurementId }, signal) => post("/ga4/tag/prepare", { measurementId }, signal),
      applyGa4TrackingTag: ({ confirmationToken }, signal) => post("/ga4/tag/apply", { confirmationToken }, signal),
      prepareGa4TrackingTagRemoval: (_target, signal) => post("/ga4/tag/remove/prepare", {}, signal),
      removeGa4TrackingTag: ({ confirmationToken }, signal) => post("/ga4/tag/remove/apply", { confirmationToken }, signal),
      prepareGa4ReportingConnection: ({ propertyId }, signal) => post("/ga4/reporting/prepare", { propertyId }, signal),
      applyGa4ReportingConnection: ({ confirmationToken }, signal) => post("/ga4/reporting/apply", { confirmationToken }, signal),
      verifyGa4Reporting: (_target, signal) => post("/ga4/reporting/verify", {}, signal),
      retryGa4Sync: (_target, signal) => post("/ga4/reporting/retry", {}, signal),
      prepareGa4ReportingDisconnection: (_target, signal) => post("/ga4/reporting/disconnect/prepare", {}, signal),
      disconnectGa4Reporting: ({ confirmationToken }, signal) => post("/ga4/reporting/disconnect/apply", { confirmationToken }, signal),
      prepareSearchConsoleVerification: ({ property, method }, signal) => post("/search-console/ownership/prepare", { property, method }, signal),
      applySearchConsoleVerification: ({ confirmationToken }, signal) => post("/search-console/ownership/apply", { confirmationToken }, signal),
      verifySearchConsoleOwnership: (_target, signal) => post("/search-console/ownership/verify", {}, signal),
      prepareSearchConsoleReportingConnection: ({ property }, signal) => post("/search-console/reporting/prepare", { property }, signal),
      applySearchConsoleReportingConnection: ({ confirmationToken }, signal) => post("/search-console/reporting/apply", { confirmationToken }, signal),
      verifySearchConsoleReporting: (_target, signal) => post("/search-console/reporting/verify", {}, signal),
      retrySearchConsoleSync: (_target, signal) => post("/search-console/reporting/retry", {}, signal),
      prepareSearchConsoleReportingDisconnection: (_target, signal) => post("/search-console/reporting/disconnect/prepare", {}, signal),
      disconnectSearchConsoleReporting: ({ confirmationToken }, signal) => post("/search-console/reporting/disconnect/apply", { confirmationToken }, signal)
    };
  }, [base, call]);
  return <div className="studio-analytics">
    <SiteAnalytics projectId={project.id} siteId={project.site.id} adapter={reportAdapter} />
    {owner && connectable && siteOrigin !== null && <SiteApps target={{ projectId: project.id, siteId: project.site.id, siteOrigin }} adapter={connectionAdapter}
      projectName={project.name} siteName={project.site.name} capabilities={{ trackingTag: false, ownershipVerification: false }} />}
  </div>;
}
