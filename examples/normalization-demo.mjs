import { analyzeNormalization, planNormalization, selectNormalizationOperations } from "@niho/web/normalize";

const document = {
  schemaVersion: 1, siteId: "demo", pageId: "home", locale: "ja-JP", revision: 1,
  title: "home", tokens: {},
  body: ["main-heading", "sub-heading"].map((id) => ({
    type: "element", id, tag: "h2", style: { base: { color: "#195640", fontSize: 28, fontWeight: 700 } }, children: []
  }))
};
const input = { documents: [{ document, version: "home-v1" }], siteStyles: {} };

const analysis = analyzeNormalization(input);
const plan = planNormalization(input);
const color = plan.proposals.find(({ kind }) => kind === "color-token");
const batches = selectNormalizationOperations(plan, {
  approvedProposalIds: color ? [color.id] : []
});
console.log(JSON.stringify({ analysis, proposals: plan.proposals, batches }, null, 2));
