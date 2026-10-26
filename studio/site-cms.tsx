import { useEffect, useState } from "react";
import type { KamakuraCmsWorkspaceProps } from "./kamakura-cms-workspace.js";

/**
 * Dashboard の「CMS」をコレクション画面で開く。
 * 画面の部品（CollectionWorkspace・TipTap）は Studio の最初の bundle に入れず、CMS を開いたときだけ読む。
 */
type WorkspaceModule = typeof import("./kamakura-cms-workspace.js");
let loaded: WorkspaceModule | null = null;
let pending: Promise<WorkspaceModule> | null = null;

/** 読み込みは 1 回だけ。失敗したら覚えず、次の再試行で読み直す */
function loadWorkspace(): Promise<WorkspaceModule> {
  pending ??= import("./kamakura-cms-workspace.js").then((module) => { loaded = module; return module; }, (error: unknown) => { pending = null; throw error; });
  return pending;
}

type LoadState = { readonly status: "loading" | "error" } | { readonly status: "ready"; readonly module: WorkspaceModule };

export function SiteCmsWorkspace(props: KamakuraCmsWorkspaceProps) {
  const [state, setState] = useState<LoadState>(() => loaded ? { status: "ready", module: loaded } : { status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (loaded) return;
    let active = true;
    setState({ status: "loading" });
    loadWorkspace().then(
      (module) => { if (active) setState({ status: "ready", module }); },
      () => { if (active) setState({ status: "error" }); }
    );
    return () => { active = false; };
  }, [attempt]);

  return <section className="studio-site-cms" aria-label="CMS">
    {state.status === "ready"
      ? <state.module.KamakuraCmsWorkspace {...props} />
      : state.status === "error"
        ? <div className="studio-site-cms-state" role="alert">
            <p>CMS の画面を読み込めませんでした。通信を確かめて、もう一度試してください。直らないときはページを読み込み直してください。</p>
            <button type="button" onClick={() => setAttempt((count) => count + 1)}>再試行</button>
          </div>
        : <div className="studio-site-cms-state" aria-busy="true"><p role="status">CMS の画面を読み込んでいます…</p></div>}
  </section>;
}
