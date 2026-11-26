import { analyzeNormalization, planNormalization } from "@niho/web/normalize";

const page = (pageId, nodeId) => ({
  kind: "page",
  version: `${pageId}-v1`,
  document: {
    schemaVersion: 1,
    siteId: "demo",
    pageId,
    locale: "ja-JP",
    revision: 1,
    title: pageId,
    tokens: {},
    body: [{ type: "element", id: nodeId, tag: "h2", style: { base: { color: "#195640", fontSize: 28, fontWeight: 700 } }, children: [] }]
  }
});

const input = {
  siteId: "demo",
  siteStyles: { version: "styles-v1", styles: {} },
  breakpoints: {
    version: "breakpoints-v1",
    settings: {
      base: { name: "Mobile", previewWidth: 375 },
      breakpoints: [{ name: "Tablet", minWidth: 768, previewWidth: 840 }, { name: "PC", minWidth: 1280, previewWidth: 1280 }]
    }
  },
  documents: [page("home", "home-heading"), page("about", "about-heading")]
};

const analysis = analyzeNormalization(input);
const color = analysis.proposals.find(({ kind }) => kind === "color-token");
const plan = color ? planNormalization(input, [color.id]) : planNormalization(input);
console.log(JSON.stringify({ proposals: analysis.proposals, acceptedProposalIds: plan.acceptedProposalIds, pages: plan.pages }, null, 2));
