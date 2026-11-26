import { lintDocuments } from "../dist/normalize.js";

const timeout = () => AbortSignal.timeout(30_000);

export async function runLintCli(pageId, locale, { client, siteId, apiCall }) {
  const styles = await apiCall(() => client.readSiteStyles(timeout()));
  const breakpointSettings = await apiCall(() => client.readBreakpointSettings(timeout()));
  const pages = pageId === "all"
    ? (await apiCall(() => client.readPageCatalog(timeout()))).pages
    : [{ siteId, pageId, locale }];
  const documents = [];
  for (let start = 0; start < pages.length; start += 8) {
    const snapshots = await Promise.all(pages.slice(start, start + 8).map((page) =>
      apiCall(() => client.read({ siteId, pageId: page.pageId, locale: page.locale }, timeout()))));
    documents.push(...snapshots.map(({ document }) => document));
  }
  const findings = lintDocuments(documents, { ...styles.draft.styles, breakpointSettings });
  return { status: findings.length ? "issues" : "clean", pagesChecked: documents.length, findings };
}
