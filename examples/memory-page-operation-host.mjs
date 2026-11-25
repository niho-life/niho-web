// The single in-memory state pointer represents one host transaction. The journal and
// saved document are immutable blobs. A durable host can stage these blobs before CAS.
export function createMemoryPageOperationHost(initial, context = {}) {
  const key = ({ siteId, pageId, locale }) => JSON.stringify([siteId, pageId, locale]);
  let state = {
    pages: new Map(initial.map((page) => [key(page.document), { snapshot: structuredClone(page) }])),
    blobs: new Map(),
    operations: new Map(),
  };
  const readPage = async (_actor, target) => structuredClone(state.pages.get(key(target))?.snapshot ?? null);
  const validationContext = async () => context;
  function advance(target, previous, document, transaction, journal, actorKey) {
    const revision = previous.snapshot.document.revision + 1, version = globalThis.crypto.randomUUID();
    const snapshot = { ...previous.snapshot, version, document: { ...document, revision } };
    const pages = new Map(state.pages), blobs = new Map(state.blobs), operations = new Map(state.operations);
    const journalPointer = transaction ? globalThis.crypto.randomUUID() : previous.journalPointer;
    if (transaction) {
      blobs.set(journalPointer, JSON.stringify({ ...journal, previousJournal: previous.journalPointer ?? null, version, revision }));
      operations.set(actorKey, { hash: transaction.inputHash, journalPointer, snapshot });
    }
    pages.set(key(target), { snapshot, journalPointer });
    state = { pages, blobs, operations };
    return { version, revision, document: structuredClone(snapshot.document) };
  }
  const savePage = async (_actor, target, expectedVersion, document) => {
    const previous = state.pages.get(key(target));
    if (!previous || previous.snapshot.version !== expectedVersion) return { status: "conflict" };
    return { status: "saved", ...advance(target, previous, document) };
  };
  const pageOperations = {
    async transact(actor, target, transaction) {
      const actorKey = JSON.stringify([actor.kind, actor.subject, actor.delegatedBy ?? null, transaction.operationId]);
      const replay = transaction.dryRun ? undefined : state.operations.get(actorKey);
      if (replay) {
        if (replay.hash !== transaction.inputHash) return { status: "duplicate_operation" };
        const { version, document } = replay.snapshot;
        return { status: "applied", version, revision: document.revision, document: structuredClone(document) };
      }
      const page = state.pages.get(key(target));
      if (!page) return { status: "not_found" };
      const result = transaction.prepare(structuredClone(page.snapshot), context);
      if (result.status !== "ready") return result;
      return { status: "applied", ...advance(target, page, result.document, transaction, result.journal, actorKey) };
    },
  };
  return { readPage, savePage, validationContext, pageOperations, readJournal: () => [...state.blobs.values()].map((blob) => JSON.parse(blob)) };
}
