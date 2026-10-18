// Tidying tags (sidebar) and suggesting existing tags while typing, so near-duplicates are not created.
// Nothing is merged or removed without the person pressing the button after seeing what will change.

function tagKeyClient(tag) {
  return String(tag).normalize('NFKC').toLowerCase().replace(/[\s_\-・／/]+/g, '');
}

async function toggleTagTidy() {
  const host = document.getElementById('tag-tidy');
  if (!host) return;
  if (!host.hidden) { host.hidden = true; return; }
  host.hidden = false;
  host.textContent = '読み込み中…';
  let data;
  try { data = await api.get('/api/tags/tidy'); } catch (error) { host.textContent = `読み込めませんでした: ${formatApiError(error)}`; return; }
  host.textContent = '';
  const title = document.createElement('p');
  title.className = 'tag-tidy-title';
  title.textContent = data.variants.length ? '表記だけが違うタグ（統合できます）' : '表記だけが違うタグはありません';
  host.append(title);
  for (const group of data.variants) host.append(renderTagVariant(group));
  if (data.usedOnce.length) {
    const once = document.createElement('details');
    once.className = 'tag-tidy-once';
    const summary = document.createElement('summary');
    summary.textContent = `1枚にしか付いていないタグ（${data.usedOnce.length}）`;
    once.append(summary);
    const note = document.createElement('p');
    note.className = 'reader-note';
    note.textContent = '整理の候補です。押すとそのカードを表示します（自動では消しません）。';
    once.append(note);
    for (const tag of data.usedOnce.slice(0, 80)) {
      const pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.textContent = tag;
      pill.onclick = () => filterTag(tag);
      once.append(pill);
    }
    host.append(once);
  }
}

function renderTagVariant(group) {
  const row = document.createElement('div');
  row.className = 'tag-tidy-row';
  const names = document.createElement('span');
  names.textContent = group.tags.map(item => `${item.tag}（${item.count}）`).join(' / ');
  const select = document.createElement('select');
  for (const item of group.tags) {
    const option = document.createElement('option');
    option.value = item.tag;
    option.textContent = `「${item.tag}」にまとめる`;
    option.selected = item.tag === group.suggested;
    select.append(option);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-secondary btn-sm';
  button.textContent = '変わるカードを確認';
  const result = document.createElement('span');
  result.className = 'reader-note';
  let confirmed = null;
  button.onclick = async () => {
    const to = select.value;
    const from = group.tags.map(item => item.tag).filter(tag => tag !== to);
    try {
      if (confirmed !== to) {
        const preview = await api.post('/api/tags/merge', { from, to, dryRun: true });
        confirmed = to;
        button.textContent = `統合する（${preview.cards}枚）`;
        result.textContent = preview.titles.length ? `例: ${preview.titles.slice(0, 3).join('、')}` : '';
        return;
      }
      button.disabled = true;
      const done = await api.post('/api/tags/merge', { from, to });
      result.textContent = `${done.changed}枚のカードを「${done.to}」にまとめました`;
      button.textContent = '統合しました';
      if (typeof loadTags === 'function') await loadTags();
      if (typeof loadCards === 'function') loadCards();
    } catch (error) {
      result.textContent = `統合できませんでした: ${formatApiError(error)}`;
      button.disabled = false;
    }
  };
  select.onchange = () => { confirmed = null; button.textContent = '変わるカードを確認'; result.textContent = ''; };
  row.append(names, select, button, result);
  return row;
}

// ─── suggestions while typing tags (space separated inputs) ─────────
function attachTagSuggest(input) {
  if (!input || input.dataset.tagSuggest) return;
  input.dataset.tagSuggest = '1';
  input.setAttribute('autocomplete', 'off');
  const list = document.createElement('div');
  list.className = 'tag-suggest';
  list.hidden = true;
  input.after(list);
  const close = () => { list.hidden = true; };
  input.addEventListener('input', () => {
    const words = input.value.split(/\s+/);
    const last = words[words.length - 1] || '';
    list.textContent = '';
    if (!last || typeof allTags === 'undefined') { close(); return; }
    const key = tagKeyClient(last);
    const typed = new Set(words.slice(0, -1).map(tagKeyClient));
    const hits = allTags.filter(item => tagKeyClient(item.tag).includes(key) && !typed.has(tagKeyClient(item.tag))).slice(0, 8);
    if (!hits.length || (hits.length === 1 && hits[0].tag === last)) { close(); return; }
    for (const item of hits) {
      const option = document.createElement('button');
      option.type = 'button';
      option.textContent = `${item.tag}（${item.count}）`;
      option.onmousedown = event => {
        event.preventDefault();
        words[words.length - 1] = item.tag;
        input.value = `${words.join(' ')} `;
        close();
        input.focus();
      };
      list.append(option);
    }
    list.hidden = false;
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
}

document.addEventListener('DOMContentLoaded', () => {
  for (const id of ['reader-tags', 'new-tags', 'edit-tags']) attachTagSuggest(document.getElementById(id));
});
