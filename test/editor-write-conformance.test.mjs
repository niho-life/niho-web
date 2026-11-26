import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { EDITING_OPERATIONS } from "../dist/editing-api.js";
import { OPERATIONS } from "../cli/operations.mjs";

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
  "EditorAdapter.prefetchDocument",
  "EditorAdapter.readDocument",
  "EditorAdapter.releaseSetStatus",
  "PageEditorProps.assets.listAssetUsages",
  "PageEditorProps.assets.listAssets",
  "PageEditorProps.assets.listProviders",
  "PageEditorProps.assets.resolveAssets",
];

const writeOperations = new Map([
  ["EditorAdapter.applyPageChange", ["pages.change-apply"]],
  ["EditorAdapter.applyOperations", ["pages.apply"]],
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

test("Kamakura GUI adapter exposes only classified reads and shared writes", () => {
  const actualMethods = adapterSources.flatMap(returnedAdapterMethods).sort();
  const expectedMethods = [...new Set([...readMethods, ...writeOperations.keys()])].sort();
  assert.deepEqual(actualMethods, expectedMethods,
    "Adapter method surface changed; classify each method and add a shared operation before enabling a new GUI write");

  const publicOperations = new Set([...EDITING_OPERATIONS, ...OPERATIONS].map((operation) => operation.id));
  for (const [method, operations] of writeOperations) {
    for (const operation of operations) assert.ok(publicOperations.has(operation), `${method} references unknown shared operation ${operation}`);
  }
});
