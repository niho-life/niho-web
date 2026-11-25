import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { EDITING_OPERATIONS } from "../dist/editing-api.js";
import { OPERATIONS } from "../cli/operations.mjs";

const sourceMapPath = new URL("../docs/ai-edit-source-map.md", import.meta.url);
const adapterSources = [
  { path: new URL("../studio/kamakura-editor.tsx", import.meta.url), name: "createKamakuraAdapter", prefix: "EditorAdapter" },
  { path: new URL("../studio/kamakura-assets.ts", import.meta.url), name: "createKamakuraAssetLibrary", prefix: "PageEditorProps.assets" },
];

const readMethods = [
  "EditorAdapter.breakpointSettings.read",
  "EditorAdapter.discoverPageNodeNames",
  "EditorAdapter.englishPublication.refresh",
  "EditorAdapter.listFormCompletionPages",
  "EditorAdapter.listPages",
  "EditorAdapter.listSites",
  "EditorAdapter.localization.readPage",
  "EditorAdapter.localization.readSite",
  "EditorAdapter.localization.sourceDocumentLocale",
  "EditorAdapter.readDocument",
  "EditorAdapter.releaseSetStatus",
  "PageEditorProps.assets.listAssetUsages",
  "PageEditorProps.assets.listAssets",
  "PageEditorProps.assets.listProviders",
  "PageEditorProps.assets.resolveAssets",
];

const writeOperations = new Map([
  ["EditorAdapter.applyPageChange", ["pages.change-apply"]],
  ["EditorAdapter.breakpointSettings.save", ["site.breakpoints.save"]],
  ["EditorAdapter.englishPublication.retry", ["pages.english-publication-retry"]],
  ["EditorAdapter.localization.command", [
    "translations.editor-adopt-candidate",
    "translations.editor-review-current",
    "translations.editor-set-value",
  ]],
  ["EditorAdapter.preparePageChange", ["pages.change-prepare"]],
  ["EditorAdapter.prepareRelease", ["pages.release-plan"]],
  ["EditorAdapter.prepareReleaseSet", ["pages.release-set-plan"]],
  ["EditorAdapter.release", ["pages.release"]],
  ["EditorAdapter.releaseSet", ["pages.release-set"]],
  ["EditorAdapter.saveDraft", ["pages.save", "translations.editor-save"]],
  ["PageEditorProps.assets.deleteAsset", ["assets.delete"]],
  ["PageEditorProps.assets.updateAsset", ["assets.update"]],
  ["PageEditorProps.assets.uploadAsset", ["assets.upload-intent"]],
]);

function objectBranches(expression) {
  if (ts.isParenthesizedExpression(expression)) return objectBranches(expression.expression);
  if (ts.isConditionalExpression(expression)) return [...objectBranches(expression.whenTrue), ...objectBranches(expression.whenFalse)];
  return ts.isObjectLiteralExpression(expression) ? [expression] : [];
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  throw new Error(`Unsupported adapter property name: ${name.getText()}`);
}

function findFactory(sourceFile, name) {
  let factory;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) factory = node;
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  assert.ok(factory?.body, `Missing adapter factory ${name}`);
  return factory.body;
}

function returnedAdapterMethods({ path, name, prefix }) {
  const text = readFileSync(path, "utf8");
  const sourceFile = ts.createSourceFile(path.pathname, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = findFactory(sourceFile, name);
  const returnedObjects = [];
  function findReturns(node) {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) returnedObjects.push(...objectBranches(node.expression));
    ts.forEachChild(node, findReturns);
  }
  findReturns(body);

  const methods = [];
  function visitObject(object, parentPath) {
    for (const member of object.properties) {
      if (ts.isSpreadAssignment(member)) {
        for (const branch of objectBranches(member.expression)) visitObject(branch, parentPath);
        continue;
      }
      if (ts.isMethodDeclaration(member)) {
        methods.push(`${parentPath}.${propertyName(member.name)}`);
        continue;
      }
      if (!ts.isPropertyAssignment(member)) continue;
      const key = propertyName(member.name);
      if (ts.isObjectLiteralExpression(member.initializer)) {
        visitObject(member.initializer, `${parentPath}.${key}`);
      } else if (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer)) {
        methods.push(`${parentPath}.${key}`);
      }
    }
  }
  for (const object of returnedObjects) visitObject(object, prefix);
  return methods;
}

function sourceMapWriteOperations() {
  const text = readFileSync(sourceMapPath, "utf8");
  const section = text.split("## 鎌倉StudioのGUI書込み経路\n")[1]?.split("\n## ", 1)[0];
  assert.ok(section, "Missing GUI write conformance section in docs/ai-edit-source-map.md");
  const rows = section.split("\n").filter((line) => line.startsWith("| `EditorAdapter.") || line.startsWith("| `PageEditorProps.assets."));
  return new Map(rows.map((line) => {
    const columns = line.split("|").slice(1, -1).map((column) => column.trim());
    const method = /^`([^`]+)`$/u.exec(columns[0] ?? "")?.[1];
    assert.ok(method, `Invalid GUI adapter method row: ${line}`);
    const operations = [...(columns[1] ?? "").matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
    assert.ok(operations.length > 0, `GUI write has no shared operation ID: ${method}`);
    assert.match(columns[2] ?? "", /(?:operations\/|\/editor\/|\/localization\/)/u, `GUI write has no BFF route: ${method}`);
    return [method, operations.sort()];
  }));
}

test("Kamakura GUI adapter writes map to documented shared operations", () => {
  const actualMethods = adapterSources.flatMap(returnedAdapterMethods).sort();
  const expectedMethods = [...new Set([...readMethods, ...writeOperations.keys()])].sort();
  assert.deepEqual(actualMethods, expectedMethods,
    "Adapter method surface changed; classify each method and add a shared operation before enabling a new GUI write");

  const documented = sourceMapWriteOperations();
  assert.deepEqual([...documented.keys()].sort(), [...writeOperations.keys()].sort(),
    "Update the GUI write table when adapter write methods change");
  for (const [method, operations] of writeOperations) {
    assert.deepEqual(documented.get(method), [...operations].sort(), `Documented operation IDs differ for ${method}`);
  }

  const publicOperations = new Set([...EDITING_OPERATIONS, ...OPERATIONS].map((operation) => operation.id));
  for (const [method, operations] of writeOperations) {
    for (const operation of operations) assert.ok(publicOperations.has(operation), `${method} references unknown shared operation ${operation}`);
  }
});
