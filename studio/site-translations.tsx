import { useEffect, useState } from "react";
import type { KamakuraLocalizationWorkspaceProps } from "./kamakura-localization-workspace.js";

/**
 * Dashboard の「翻訳」を翻訳の画面で開く（Worker の KAMAKURA_TRANSLATIONS_VIEW が "workspace" のとき）。
 * 画面の部品（LocalizationWorkspace）は Studio の最初の bundle に入れず、翻訳を開いたときだけ読む。
 * 器の見た目は CMS の画面と同じ。旧画面への入口は Dashboard の帯の右側（studio/client.tsx の LegacyLink）。
 */
type WorkspaceModule = typeof import("./kamakura-localization-workspace.js");
let loaded: WorkspaceModule | null = null;
let pending: Promise<WorkspaceModule> | null = null;

/** 読み込みは 1 回だけ。失敗したら覚えず、次の再試行で読み直す */
function loadWorkspace(): Promise<WorkspaceModule> {
  pending ??= import("./kamakura-localization-workspace.js").then((module) => { loaded = module; return module; }, (error: unknown) => { pending = null; throw error; });
  return pending;
}

type LoadState = { readonly status: "loading" | "error" } | { readonly status: "ready"; readonly module: WorkspaceModule };

export function SiteTranslationsWorkspace(props: KamakuraLocalizationWorkspaceProps) {
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

  return <section className="studio-site-cms studio-site-translations" aria-label="翻訳">
    {state.status === "ready"
      ? <state.module.KamakuraLocalizationWorkspace {...props} />
      : state.status === "error"
        ? <div className="studio-site-cms-state" role="alert">
            <p>翻訳の画面を読み込めませんでした。通信を確かめて、もう一度試してください。直らないときはページを読み込み直してください。</p>
            <button type="button" onClick={() => setAttempt((count) => count + 1)}>再試行</button>
          </div>
        : <div className="studio-site-cms-state" aria-busy="true"><p role="status">翻訳の画面を読み込んでいます…</p></div>}
  </section>;
}
