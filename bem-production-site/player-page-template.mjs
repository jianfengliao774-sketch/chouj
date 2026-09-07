/** Both public routes use the same wallet, pool navigation and content shell. */
export function playerPageHtml(index, burns, isBurnPage = false) {
  const panel = burns.match(/<!-- burn-panel:start -->([\s\S]*?)<!-- burn-panel:end -->/)?.[1];
  if (!panel || !index.includes('<!-- burn-panel -->')) throw new Error('Missing shared burn panel');
  let html = index.replace('<!-- burn-panel -->', panel);
  if (isBurnPage) {
    html = html.replace('<body class="player-page">', '<body class="player-page" data-initial-tab="burns">')
      .replace('<title>芯火夺宝 · BNB 主网</title>', '<title>销毁记录 · 芯火夺宝</title>')
      .replace('id="panel-draw" role="tabpanel"', 'id="panel-draw" hidden role="tabpanel"')
      .replace('id="panel-burns" hidden', 'id="panel-burns"');
    html = html.replace('id="tab-draw" aria-controls="panel-draw" aria-selected="true"', 'id="tab-draw" aria-controls="panel-draw" aria-selected="false"')
      .replace('id="tab-burns" href="/burns.html" aria-controls="panel-burns" aria-selected="false"', 'id="tab-burns" href="/burns.html" aria-controls="panel-burns" aria-selected="true"');
  }
  return html;
}
