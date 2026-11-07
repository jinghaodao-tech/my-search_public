'use strict';
const tabs = document.getElementById('tabs');
const address = document.getElementById('url');
const statusLine = document.getElementById('status');
let current = null;

function render(state) {
  current = state.active ?? null;
  tabs.replaceChildren();
  for (const tab of state.tabs ?? []) {
    const group = document.createElement('span');
    const select = document.createElement('button');
    select.className = 'tab'; select.role = 'tab'; select.setAttribute('aria-current', tab.id === current?.id ? 'page' : 'false');
    select.textContent = tab.title || tab.url || '新しいタブ'; select.title = tab.url || '';
    select.addEventListener('click', () => window.desktopBrowser.selectTab(tab.id));
    const close = document.createElement('button'); close.textContent = '×'; close.title = 'タブを閉じる';
    close.addEventListener('click', () => window.desktopBrowser.closeTab(tab.id));
    group.append(select, close); tabs.append(group);
  }
  address.value = current?.url || '';
  document.getElementById('back').disabled = !current?.canGoBack;
  document.getElementById('forward').disabled = !current?.canGoForward;
}

document.getElementById('navigate').addEventListener('submit', event => {
  event.preventDefault();
  window.desktopBrowser.navigate(address.value.trim()).catch(error => { statusLine.textContent = error.message; });
});
document.getElementById('back').addEventListener('click', () => window.desktopBrowser.back());
document.getElementById('forward').addEventListener('click', () => window.desktopBrowser.forward());
document.getElementById('reload').addEventListener('click', () => window.desktopBrowser.reload());
document.getElementById('new-tab').addEventListener('click', () => window.desktopBrowser.openTab('https://example.com'));
document.getElementById('send-selection').addEventListener('click', async () => {
  try { const result = await window.desktopBrowser.sendSelection(); statusLine.textContent = result?.ok ? '選択文をmy-searchへ送りました（未検証クリップ）。' : result?.reason || '選択文を取得できませんでした。'; }
  catch (error) { statusLine.textContent = error.message; }
});
window.desktopBrowser.onState(render);
window.desktopBrowser.state().then(render).catch(error => { statusLine.textContent = error.message; });
