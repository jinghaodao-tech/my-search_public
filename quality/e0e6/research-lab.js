const phaseCatalog = [
  ['search', '検索'], ['read', '読む'], ['note', 'メモ'], ['compare', '検証'],
  ['save', '保存'], ['refind', '再発見'], ['resume', '再開'],
];
let taskPhases = phaseCatalog;
let correctNote = '';
let sharedTask = null;
let sid = null;
let condition = null;
let activePhase = null;
let activeActivity = null;
let phaseIndex = 0;
const task = { found: false, read: false, note: '', compareNote: '', calculation: null, saveNote: '', saveCalculation: null,
  saved: null, refound: false, resumed: false, noteTransferred: false, calculationTransferred: false };
const status = document.querySelector('#status');
const workflow = document.querySelector('#workflow');
const workflowNav = document.querySelector('#workflow-nav');
const phasePanel = document.querySelector('#phase-panel');
const transferStatus = document.querySelector('#transfer-status');
const phaseName = code => phaseCatalog.find(([id]) => id === code)?.[1] ?? code;
const experimentSelect = document.querySelector('#experiment');
const taskSelect = document.querySelector('#task');
const formSelect = document.querySelector('#task-form');
const axisSelects = ['automation', 'visibility', 'timing'].map(key => document.querySelector(`#${key}`));
const hasPhase = id => taskPhases.some(([phase]) => phase === id);
const requiresCalculation = () => hasPhase('compare');
experimentSelect.addEventListener('change', () => {
  const isE6 = experimentSelect.value === 'E6';
  axisSelects.forEach((select, index) => { select.disabled = true; select.value = ['manual', 'current', 'on_request'][index]; });
  document.querySelector('#workflow-condition').disabled = !isE6;
  if (!isE6) document.querySelector('#workflow-condition').value = 'mvp';
  taskSelect.value = isE6 ? 'synthetic-integrate-01' : 'synthetic-refind-01';
});
experimentSelect.dispatchEvent(new Event('change'));
const announce = message => { status.textContent = message; };
async function api(url, options = {}) {
  const response = await fetch(`/api${url}`, { headers: { 'content-type': 'application/json' }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}
async function record(event) {
  if (!sid) throw new Error('先に同意して課題を開始してください');
  return api(`/research-experiments/sessions/${sid}/events`, { method: 'POST', body: JSON.stringify(event) });
}
async function logError(errorCategory = 'task_failure') {
  if (!sid) return;
  try { await record({ event: 'error', error_category: errorCategory }); } catch { /* the failed request is visible to the participant */ }
}
async function endActivity() {
  if (!activeActivity) return;
  await record({ event: 'activity_end', category: activeActivity });
  activeActivity = null;
}
async function endPhase() {
  if (!activePhase) return;
  await endActivity();
  await record({ event: 'phase_end', phase: activePhase });
  activePhase = null;
}
async function goToPhase(id, { viaNav = false } = {}) {
  const index = taskPhases.findIndex(([phase]) => phase === id);
  if (index < 0) return;
  try {
    if (activePhase === id) return;
    await endPhase();
    if (viaNav) await record({ event: 'management_operation', operation: 'navigate' });
    await record({ event: 'phase_start', phase: id });
    activePhase = id;
    phaseIndex = index;
    if (condition.workflow === 'separated' && id === 'compare' && task.note && !task.noteTransferred) {
      await record({ event: 'activity_start', category: 'management' }); activeActivity = 'management';
    }
    if (condition.workflow === 'separated' && id === 'save' && task.calculation !== null && !task.calculationTransferred) {
      await record({ event: 'activity_start', category: 'management' }); activeActivity = 'management';
    }
    renderCurrentPhase();
  } catch (error) { announce(error.message); await logError('state_transition'); }
}
function el(tag, text, attrs = {}) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else if (key === 'onClick') node.addEventListener('click', value);
    else node.setAttribute(key, value);
  }
  return node;
}
function actionButton(text, action, callback) { return el('button', text, { type: 'button', 'data-action': action, onClick: callback }); }
function updateTransferStatus() {
  if (!condition || condition.workflow === 'mvp') { transferStatus.hidden = true; return; }
  transferStatus.hidden = false;
  transferStatus.textContent = condition.workflow === 'integrated'
    ? `統合フロー：メモ${task.noteTransferred ? '引き継ぎ済み' : '未引き継ぎ'}、計算結果${task.calculationTransferred ? '引き継ぎ済み' : '未引き継ぎ'}。完了情報を自動共有します。`
    : `分離フロー：メモ${task.noteTransferred ? '引き継ぎ済み' : '未引き継ぎ'}、計算結果${task.calculationTransferred ? '引き継ぎ済み' : '未引き継ぎ'}。画面間の引き継ぎ操作が必要です。`;
}
function renderWorkflow() {
  workflowNav.replaceChildren();
  for (const [index, [id, label]] of taskPhases.entries()) {
    const button = actionButton(`${index + 1}. ${label}`, 'navigate', () => goToPhase(id, { viaNav: true }));
    button.dataset.phase = id;
    workflowNav.append(button);
  }
  if (experimentSelect.value === 'E0') {
    workflow.dataset.mode = 'e0-baseline';
    document.querySelector('#condition-description').textContent = 'E0ベースライン：選択した合成課題の段階を順に実行します。自動化・表示・介入条件は未実装のため固定しています。';
  } else if (condition?.workflow === 'integrated') {
    workflow.dataset.mode = 'integrated';
    document.querySelector('#condition-description').textContent = '統合条件：1つの連続した作業画面で進み、完了した段階の結果を次へ自動で渡します。';
  } else if (condition?.workflow === 'separated') {
    workflow.dataset.mode = 'separated';
    document.querySelector('#condition-description').textContent = '分離条件：同じ段階と道具を個別の作業画面で使います。必要な結果は「引き継ぐ」を押して次の画面へ渡します。';
  } else {
    workflow.dataset.mode = 'mvp';
    document.querySelector('#condition-description').textContent = 'MVP基準条件：既存MVPを模した平坦な段階一覧です。E6のB/C比較とは別の製品全体ベースラインです。';
  }
  updateTransferStatus();
  renderCurrentPhase();
}
function addManualTransferControls(container, kind) {
  if (condition?.workflow !== 'separated') return;
  if (kind === 'note' && (!task.note || task.noteTransferred)) return;
  if (kind === 'save-context' && (task.calculation === null || task.calculationTransferred)) return;
  const label = kind === 'note' ? 'メモを次の作業スペースへ引き継ぐ' : '計算結果を保存作業へ引き継ぐ';
  const fields = document.createElement('div');
  fields.className = 'manual-transfer-fields';
  if (kind === 'note') {
    const input = el('input', undefined, { id: 'note-transfer-input', type: 'text', autocomplete: 'off', 'aria-label': '比較作業へ手動入力するメモ' });
    fields.append(el('label', '前の作業で作ったメモを入力', { for: 'note-transfer-input' }), input);
  } else {
    const note = el('input', undefined, { id: 'save-note-input', type: 'text', autocomplete: 'off', 'aria-label': '保存作業へ手動入力するメモ' });
    const calculation = el('input', undefined, { id: 'save-calculation-input', type: 'number', autocomplete: 'off', 'aria-label': '保存作業へ手動入力する計算結果' });
    fields.append(el('label', '保存するメモを再入力', { for: 'save-note-input' }), note,
      el('label', '計算結果を再入力', { for: 'save-calculation-input' }), calculation);
  }
  container.append(fields, actionButton(label, 'manual_reentry', async () => {
    try {
      await record({ event: 'management_operation', operation: 'manual_reentry' });
      const noteInput = fields.querySelector(kind === 'note' ? '#note-transfer-input' : '#save-note-input');
      const calculationInput = fields.querySelector('#save-calculation-input');
      const correct = kind === 'note'
        ? noteInput?.value.trim() === task.note
        : noteInput?.value.trim() === task.note && Number(calculationInput?.value) === task.calculation;
      if (!correct) {
        await logError('task_failure');
        if (activeActivity === 'management') { await endActivity(); await record({ event: 'activity_start', category: 'correction' }); activeActivity = 'correction'; }
        announce('入力内容が前の作業結果と一致しません。確認して修正してください。');
        return;
      }
      if (activeActivity === 'management' || activeActivity === 'correction') await endActivity();
      if (kind === 'note') { task.compareNote = noteInput.value.trim(); task.noteTransferred = true; }
      else { task.saveNote = noteInput.value.trim(); task.saveCalculation = Number(calculationInput.value); task.calculationTransferred = true; }
      updateTransferStatus();
      announce(kind === 'note' ? 'メモを比較作業へ手動入力しました。' : 'メモと計算結果を保存作業へ手動入力しました。');
      renderCurrentPhase();
    } catch (error) { announce(error.message); await logError('state_transition'); }
  }));
}
function renderCurrentPhase() {
  if (!condition) return;
  workflowNav.querySelectorAll('button').forEach(button => button.setAttribute('aria-current', button.dataset.phase === activePhase ? 'step' : 'false'));
  phasePanel.replaceChildren();
  const id = taskPhases[phaseIndex][0];
  const heading = el('h2', phaseName(id));
  phasePanel.append(heading);
  if (id === 'search') {
    phasePanel.append(el('p', `共通課題：資料 ${sharedTask.source.id} を見つけ、${correctNote}、計算結果、保存メモを再発見して再開してください。`));
    phasePanel.append(actionButton(`Source ${sharedTask.decoy_source_id} を選ぶ（対象外）`, 'select-decoy', async () => { task.found = false; await logError('task_failure'); announce('対象外の資料です。正しい資料を選び直してください。'); }));
    phasePanel.append(actionButton(`Source ${sharedTask.source.id} を見つける`, 'select-target', async () => { task.found = true; await record({ event: 'management_operation', operation: 'select_result' }); announce('正しい資料を見つけました。次に読む段階へ進めます。'); renderCurrentPhase(); }));
    phasePanel.append(el('p', task.found ? `選択中：Source ${sharedTask.source.id}` : 'まだ正解資料を選んでいません。'));
  } else if (id === 'read') {
    phasePanel.append(el('p', task.found ? `資料本文：${sharedTask.source.text}` : `先に Source ${sharedTask.source.id} を見つけてください。`));
    phasePanel.append(actionButton('本文を確認した', 'read', async () => { if (!task.found) { await logError('task_failure'); announce('資料を先に見つけてください。'); return; } task.read = true; announce('確認を記録しました。'); renderCurrentPhase(); }));
    phasePanel.append(el('p', task.read ? '確認済み' : '未確認'));
  } else if (id === 'note') {
    phasePanel.append(el('p', '資料から正しい事実を選び、作業メモを作ります。'));
    for (const fact of sharedTask.fact_choices) phasePanel.append(actionButton(`事実をメモ：「${fact}」`, 'choose-note', async () => {
      try {
        if (!task.read) { await logError('task_failure'); announce('先に資料を読み、確認してください。'); return; }
        if (fact !== correctNote) {
          task.note = fact;
          if (!activeActivity) { await record({ event: 'activity_start', category: 'correction' }); activeActivity = 'correction'; }
          await logError('task_failure');
          announce('その事実は対象と異なります。正しい事実へ修正してください。');
        } else {
          task.note = fact;
          if (activeActivity === 'correction') await endActivity();
          if (condition.workflow === 'integrated') { task.compareNote = task.note; task.noteTransferred = true; }
          if (condition.workflow === 'mvp') task.compareNote = task.note;
          if (!requiresCalculation()) task.saveNote = task.note;
          announce('メモを作成しました。');
        }
        updateTransferStatus(); renderCurrentPhase();
      } catch (error) { announce(error.message); await logError('state_transition'); }
    }));
    phasePanel.append(el('p', task.note ? `現在のメモ：${task.note}` : 'メモ未作成'));
  } else if (id === 'compare') {
    phasePanel.append(el('p', `固定された安全な計算器で ${sharedTask.tool.left} + ${sharedTask.tool.right} を計算します。任意コードは実行しません。`));
    if (condition.workflow === 'separated' && !task.noteTransferred) phasePanel.append(el('p', 'この作業スペースには前段階の内容は表示されません。メモを手動で入力してください。'));
    if (task.compareNote) phasePanel.append(el('p', condition.workflow === 'separated' ? `手動受領したメモ：${task.compareNote}` : `利用できるメモ：${task.compareNote}`));
    addManualTransferControls(phasePanel, 'note');
    phasePanel.append(actionButton('確認を開始', 'verify-start', async () => {
      try { if (activeActivity) { announce('別の計測区間が進行中です。'); return; } if ((condition.workflow === 'separated' && !task.noteTransferred) || task.compareNote !== correctNote) { announce('先に正しいメモを比較作業へ用意してください。'); return; } await record({ event: 'activity_start', category: 'verification' }); activeActivity = 'verification'; announce('確認時間を計測中です。'); }
      catch (error) { announce(error.message); }
    }));
    phasePanel.append(actionButton(`${sharedTask.tool.left} + ${sharedTask.tool.right} を計算して確認終了`, 'calculate', async () => {
      try {
        if (activeActivity !== 'verification') { await logError('state_transition'); announce('確認開始を押してから実行してください。'); return; }
        task.calculation = sharedTask.tool.left + sharedTask.tool.right;
        await endActivity();
        if (condition.workflow === 'integrated' && task.compareNote === correctNote) {
          task.saveNote = task.compareNote; task.saveCalculation = task.calculation; task.calculationTransferred = true;
        }
        if (condition.workflow === 'mvp') { task.saveNote = task.compareNote; task.saveCalculation = task.calculation; }
        updateTransferStatus(); announce(`計算結果：${task.calculation}`); renderCurrentPhase();
      } catch (error) { announce(error.message); await logError('state_transition'); }
    }));
    phasePanel.append(el('p', task.calculation === null ? '未計算' : `計算結果：${task.calculation}`));
  } else if (id === 'save') {
    phasePanel.append(el('p', !requiresCalculation() ? '作成したメモを保存します。'
      : condition.workflow === 'separated'
        ? '別の保存作業スペースです。手動入力されたメモと計算結果を確認してから保存します。'
        : condition.workflow === 'integrated' ? '前段階から自動共有されたメモと計算結果を確認して保存します。' : 'この基準条件の作業内容を保存します。'));
    if (condition.workflow === 'separated') addManualTransferControls(phasePanel, 'save-context');
    if (task.saveNote) phasePanel.append(el('p', condition.workflow === 'separated'
      ? `手動受領した内容：${task.saveNote}、計算結果 ${task.saveCalculation}`
      : `作業内容：${task.saveNote}、計算結果 ${task.saveCalculation}`));
    phasePanel.append(actionButton('このメモを保存', 'save', async () => {
      try {
        if (task.saveNote !== correctNote || (requiresCalculation() && task.saveCalculation !== sharedTask.tool.expected_result)
          || (condition.workflow === 'separated' && (!task.noteTransferred || !task.calculationTransferred))) { await logError('task_failure'); announce('事実、計算、または分離条件での引き継ぎが未完了です。'); return; }
        task.saved = { note: task.saveNote, calculation: requiresCalculation() ? task.saveCalculation : null, source: sharedTask.source.id };
        await record({ event: 'management_operation', operation: 'save' });
        announce('合成メモを保存しました。'); renderCurrentPhase();
      } catch (error) { announce(error.message); await logError('state_transition'); }
    }));
    phasePanel.append(el('p', task.saved ? `保存済み：${task.saved.note}; ${task.saved.calculation}; source ${task.saved.source}` : '未保存'));
    if (task.saved) phasePanel.append(actionButton('保存を取り消す（合成データのみ）', 'undo-save', async () => {
      try {
        await record({ event: 'undo' });
        await record({ event: 'management_operation', operation: 'undo' });
        task.saved = null; task.refound = false; task.resumed = false;
        announce('合成メモの保存を取り消しました。'); renderCurrentPhase();
      } catch (error) { announce(error.message); }
    }));
  } else if (id === 'refind') {
    phasePanel.append(el('p', '保存した合成メモの一覧から対象を見つけ直します。'));
    phasePanel.append(actionButton('保存済みメモを開く', 'refind', async () => {
      if (!task.saved) { await logError('task_failure'); announce('保存済みメモがありません。'); return; }
      task.refound = true; await record({ event: 'management_operation', operation: 'navigate' }); announce(`再発見：${task.saved.note}`); renderCurrentPhase();
    }));
    phasePanel.append(el('p', task.refound ? '再発見済み' : '未発見'));
  } else {
    phasePanel.append(el('p', task.refound ? `再開した内容：${task.saved?.note}; ${task.saved?.calculation}; source ${task.saved?.source}` : '先に保存済みメモを再発見してください.'));
    phasePanel.append(actionButton('再開内容を確認', 'resume', async () => {
      if (!task.refound || task.saved?.note !== correctNote || (requiresCalculation() && task.saved?.calculation !== sharedTask.tool.expected_result) || task.saved?.source !== sharedTask.expected_saved_source_id) { await logError('task_failure'); announce('保存した正解と出典が復元できていません。'); return; }
      task.resumed = true; await record({ event: 'management_operation', operation: 'navigate' }); announce('正しいメモと出典を再開しました。'); renderCurrentPhase();
    }));
    phasePanel.append(el('p', task.resumed ? '再開確認済み' : '未確認'));
  }
  const next = actionButton(id === 'resume' ? '最初から課題を確認' : '次の段階へ', 'next', async () => {
    const nextId = taskPhases[(phaseIndex + 1) % taskPhases.length][0];
    if (id === 'search' && !task.found) { await logError('task_failure'); announce(`資料 ${sharedTask.source.id} を見つけてください。`); return; }
    if (id === 'read' && !task.read) { await logError('task_failure'); announce('資料を読んだことを確認してください。'); return; }
    if (id === 'note' && task.note !== correctNote) { await logError('task_failure'); announce('正しいメモを作成してください。'); return; }
    if (id === 'note' && condition.workflow === 'separated' && nextId !== 'compare' && !task.noteTransferred) { await logError('task_failure'); announce('比較画面へ移動後、メモを手動で引き継いでください。'); return; }
    if (id === 'compare' && task.calculation !== sharedTask.tool.expected_result) { await logError('task_failure'); announce('計算器の結果を確認してください。'); return; }
    if (id === 'compare' && condition.workflow === 'separated' && nextId !== 'save' && !task.calculationTransferred) { await logError('task_failure'); announce('保存作業スペースへメモと計算結果を手動入力してください。'); return; }
    if (id === 'save' && condition.workflow === 'separated' && !task.calculationTransferred) { await logError('task_failure'); announce('保存作業スペースへメモと計算結果を手動入力してください。'); return; }
    if (id === 'save' && !task.saved) { await logError('task_failure'); announce('先にメモを保存してください。'); return; }
    if (id === 'refind' && !task.refound) { await logError('task_failure'); announce('先に保存済みメモを再発見してください。'); return; }
    if (id === 'resume' && !task.resumed) { await logError('task_failure'); announce('先に再開内容を確認してください。'); return; }
    await goToPhase(nextId, { viaNav: true });
  });
  phasePanel.append(next);
}
document.querySelector('#start').addEventListener('click', async () => {
  try {
    if (!document.querySelector('#consent').checked) throw new Error('同意が必要です');
    const fixtureResponse = await fetch('/research-lab/tasks.json');
    if (!fixtureResponse.ok) throw new Error('合成課題を読み込めません');
    const fixture = await fixtureResponse.json();
    sharedTask = fixture.e6_parallel_forms.find(form => form.form_id === formSelect.value);
    const experimentId = experimentSelect.value;
    const taskId = taskSelect.value;
    const taskDefinition = fixture.tasks.find(item => item.task_id === taskId && item.experiment === experimentId);
    if (!taskDefinition) throw new Error('選択した合成課題が見つかりません');
    if (experimentId === 'E6' && taskId !== fixture.shared_e6_task.task_id) throw new Error('E6は共通比較課題を選んでください');
    taskPhases = taskDefinition.phases.map(phase => phaseCatalog.find(([id]) => id === phase)).filter(Boolean);
    if (taskPhases.length !== taskDefinition.phases.length) throw new Error('合成課題に未対応の段階があります');
    Object.assign(task, { found: false, read: false, note: '', compareNote: '', calculation: null, saveNote: '', saveCalculation: null,
      saved: null, refound: false, resumed: false, noteTransferred: false, calculationTransferred: false });
    if (taskId === 'synthetic-refind-01') {
      task.saved = { note: sharedTask.expected_fact, calculation: sharedTask.tool.expected_result, source: sharedTask.source.id };
    }
    if (taskId === 'synthetic-resume-01') task.found = true;
    correctNote = sharedTask.expected_fact;
    document.querySelector('#source-title').textContent = `共通資料：${sharedTask.source.title}`;
    document.querySelector('#source-body').textContent = sharedTask.source.text;
    condition = Object.fromEntries(['automation', 'visibility', 'timing'].map(key => [key, document.querySelector(`#${key}`).value]));
    condition.workflow = experimentId === 'E6' ? document.querySelector('#workflow-condition').value : 'mvp';
    document.querySelectorAll('select').forEach(select => { select.disabled = true; });
    const result = await api('/research-experiments/sessions', { method: 'POST', body: JSON.stringify({ consent: true,
      experiment: experimentId, taskId, presentationId: formSelect.value, condition }) });
    sid = result.sid;
    workflow.hidden = false;
    renderWorkflow();
    await goToPhase(taskPhases[0][0]);
    announce('開始しました。条件、資料、計算器、実行権限はこの課題中固定です。');
  } catch (error) { announce(error.message); }
});
document.querySelector('#complete').addEventListener('click', async () => {
  try {
    await endPhase();
    const phaseComplete = { search: task.found, read: task.read, note: task.note === correctNote,
      compare: task.compareNote === correctNote && task.calculation === sharedTask.tool.expected_result,
      save: task.saved?.note === correctNote && (!requiresCalculation() || task.saved?.calculation === sharedTask.tool.expected_result),
      refind: task.refound, resume: task.resumed };
    const success = taskPhases.every(([phase]) => phaseComplete[phase]);
    const result = await record({ event: 'task_complete', outcome: success ? 'success' : 'failure' });
    announce(`${success ? '成功' : '未達成'}。総経過時間 ${result.elapsed_total_ms} ms`);
    sid = null;
  } catch (error) { announce(error.message); await logError('state_transition'); }
});
document.querySelector('#abandon').addEventListener('click', async () => {
  try { await endPhase(); await record({ event: 'task_abandon', abandon_reason: 'participant_choice' }); announce('途中離脱を記録しました。'); sid = null; }
  catch (error) { announce(error.message); await logError('state_transition'); }
});
document.querySelector('#withdraw').addEventListener('click', async () => {
  try { await api('/research-experiments/events', { method: 'DELETE' }); sid = null; activePhase = null; activeActivity = null; condition = null; workflow.hidden = true; announce('ローカル実験記録をすべて削除しました'); }
  catch (error) { announce(error.message); }
});
