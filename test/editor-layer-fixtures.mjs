/** レイヤーの枝は初期状態で閉じている。対象を見つけるまでフィクスチャの枝を開く。 */
export async function findLayer(lookup, click, scope = document) {
  const visited = new Set();
  while (true) {
    const row = lookup();
    if (row) return row;
    const toggle = [...scope.querySelectorAll(".e-layer-toggle:enabled")].find((button) =>
      !visited.has(button) && button.parentElement.querySelector('button.e-layer[aria-expanded="false"]'));
    if (!toggle) return undefined;
    visited.add(toggle);
    await click(toggle);
  }
}
