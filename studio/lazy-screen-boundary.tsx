import { Component, type ReactNode } from "react";

export class LazyScreenBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <main className="studio-state" role="alert">
        <h1>画面を読み込めませんでした</h1>
        <p>通信状態を確認して、再読み込みしてください。</p>
        <button type="button" onClick={() => window.location.reload()}>再読み込み</button>
        <p><a href="/">プロジェクト一覧に戻る</a></p>
      </main>;
    }
    return this.props.children;
  }
}
