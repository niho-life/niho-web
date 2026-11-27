import type { BlockContract, BlockContracts } from "./types.js";

export const MANAGED_EMBED_REF = /^emb_[0-9a-f]{32}$/u;
export const managedEmbedContract = {
  props: {
    refId: { type: "string", maxLength: 36 },
    background: { type: "enum", values: ["white", "transparent"], required: true },
    initialHeight: { type: "number", min: 240, max: 1600, required: true }
  },
  slots: { frame: { label: "埋め込み枠", style: ["width", "borderRadius"] } }
} satisfies BlockContract;
export const managedBlockContracts = { ManagedEmbed: managedEmbedContract } satisfies BlockContracts;
