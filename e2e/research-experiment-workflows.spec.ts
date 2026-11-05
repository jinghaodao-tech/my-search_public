import { expect, test, type Request as PlaywrightRequest } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { analyzeExperimentEvents } from '../quality/e0e6/analysis.mjs';

test('separated and integrated E6 workflows complete the same synthetic task with the same source and calculator', async ({ page, request }) => {
  test.setTimeout(240_000);
  expect((await request.delete('/api/research-experiments/events')).status()).toBe(200);
  const forms = [
    { id: 'synthetic-form-a', sourceId: 'SYS-17', sourceClue: 'blue unit', fact: 'blue unit = 3', math: '3 + 4', answer: '7' },
    { id: 'synthetic-form-b', sourceId: 'SYS-23', sourceClue: 'green unit', fact: 'green unit = 5', math: '5 + 2', answer: '7' },
    { id: 'synthetic-form-c', sourceId: 'SYS-31', sourceClue: 'violet unit', fact: 'violet unit = 4', math: '4 + 2', answer: '6' },
  ];
  const results: Array<{ workflow: string; formId: string; source: string; tool: string; saved: string; events: Array<Record<string, unknown>>; sid: string }> = [];
  for (const form of forms) for (const workflow of ['separated', 'integrated']) {
    await page.goto('/research-lab');
    await page.selectOption('#experiment', 'E6');
    await page.selectOption('#task-form', form.id);
    await page.selectOption('#workflow-condition', workflow);
    await expect(page.locator('#automation')).toBeDisabled();
    await expect(page.locator('#visibility')).toBeDisabled();
    await expect(page.locator('#timing')).toBeDisabled();
    await page.locator('#consent').check();

    const requestEvents: Array<Record<string, unknown>> = [];
    const onRequest = (requestEvent: PlaywrightRequest) => {
      if (requestEvent.url().includes('/research-experiments/sessions/') && requestEvent.url().endsWith('/events') && requestEvent.method() === 'POST') {
        try { requestEvents.push(requestEvent.postDataJSON()); } catch { /* no request body is copied into test output */ }
      }
    };
    page.on('request', onRequest);
    const sessionResponsePromise = page.waitForResponse(response => response.url().endsWith('/research-experiments/sessions') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '同意して開始' }).click();
    const sessionResponse = await sessionResponsePromise;
    expect(sessionResponse.status()).toBe(201);
    const sid = (await sessionResponse.json()).sid as string;
    const sessionRequest = sessionResponse.request().postDataJSON();
    expect(sessionRequest).toMatchObject({ consent: true, experiment: 'E6', taskId: 'synthetic-integrate-01', presentationId: form.id, condition: { workflow, automation: 'manual', visibility: 'current', timing: 'on_request' } });
    expect((await sessionResponse.json()).workflowDefinitionId).toBe(workflow === 'separated' ? 'e6-separated-manual-reentry-v2' : 'e6-integrated-auto-share-v2');

    const source = await page.locator('#source-body').textContent();
    expect(source).toContain(form.sourceClue);
    await page.getByRole('button', { name: `Source ${form.sourceId} を見つける` }).click();
    await page.getByRole('button', { name: '次の段階へ' }).click();
    await page.getByRole('button', { name: '本文を確認した' }).click();
    await page.getByRole('button', { name: '次の段階へ' }).click();
    await page.getByRole('button', { name: `事実をメモ：「${form.fact}」` }).click();
    await page.getByRole('button', { name: '次の段階へ' }).click();

    if (workflow === 'separated') {
      await expect(page.getByRole('button', { name: 'メモを次の作業スペースへ引き継ぐ' })).toBeVisible();
      await expect(page.locator('#note-transfer-input')).toHaveValue('');
      await page.locator('#note-transfer-input').fill(form.fact);
      await page.getByRole('button', { name: 'メモを次の作業スペースへ引き継ぐ' }).click();
      await expect(page.locator('#phase-panel')).toContainText(`手動受領したメモ：${form.fact}`);
    } else {
      await expect(page.getByRole('button', { name: 'メモを次の作業スペースへ引き継ぐ' })).toHaveCount(0);
      await expect(page.locator('#transfer-status')).toContainText('自動共有');
      await expect(page.locator('#phase-panel')).toContainText(`利用できるメモ：${form.fact}`);
    }
    await page.getByRole('button', { name: '確認を開始' }).click();
    await expect(page.getByRole('status')).toContainText('確認時間を計測中です');
    await page.getByRole('button', { name: `${form.math} を計算して確認終了` }).click();
    await expect(page.getByRole('status')).toContainText(`計算結果：${form.answer}`);
    const tool = await page.locator('#phase-panel').textContent();
    expect(tool).toContain(`計算結果：${form.answer}`);
    const comparableTool = (tool ?? '')
      .replace(/手動受領したメモ：.*?(?=確認を開始)/u, '')
      .replace(/利用できるメモ：.*?(?=確認を開始)/u, '');
    await page.getByRole('button', { name: '次の段階へ' }).click();

    if (workflow === 'separated') {
      await expect(page.getByRole('button', { name: '計算結果を保存作業へ引き継ぐ' })).toBeVisible();
      await expect(page.locator('#save-note-input')).toHaveValue('');
      await expect(page.locator('#save-calculation-input')).toHaveValue('');
      await page.locator('#save-note-input').fill(form.fact);
      await page.locator('#save-calculation-input').fill(form.answer);
      await page.getByRole('button', { name: '計算結果を保存作業へ引き継ぐ' }).click();
      await expect(page.locator('#status')).toContainText('メモと計算結果を保存作業へ手動入力しました。');
      await expect(page.locator('#phase-panel')).toContainText(`手動受領した内容：${form.fact}、計算結果 ${form.answer}`);
    } else {
      await expect(page.getByRole('button', { name: '計算結果を保存作業へ引き継ぐ' })).toHaveCount(0);
      await expect(page.locator('#phase-panel')).toContainText(`作業内容：${form.fact}、計算結果 ${form.answer}`);
    }
    await page.getByRole('button', { name: 'このメモを保存' }).click();
    await expect(page.locator('#phase-panel')).toContainText(`保存済み：${form.fact}; ${form.answer}; source ${form.sourceId}`);
    const saved = await page.locator('#phase-panel').textContent();
    const savedRecord = (saved ?? '').split('保存済み：')[1]?.split('保存を取り消す')[0] ?? '';
    expect(savedRecord).toBe(`${form.fact}; ${form.answer}; source ${form.sourceId}`);
    await page.getByRole('button', { name: '次の段階へ' }).click();
    await page.getByRole('button', { name: '保存済みメモを開く' }).click();
    await page.getByRole('button', { name: '次の段階へ' }).click();
    await page.getByRole('button', { name: '再開内容を確認' }).click();
    await page.getByRole('button', { name: 'タスク完了を記録' }).click();
    await expect(page.getByRole('status')).toContainText('成功。総経過時間');
    const completion = [...requestEvents].reverse().find(event => event.event === 'task_complete');
    expect(completion).toMatchObject({ outcome: 'success' });
    expect(requestEvents.filter(event => event.event === 'phase_start').map(event => event.phase)).toEqual(['search', 'read', 'note', 'compare', 'save', 'refind', 'resume']);
    const managementDurations = requestEvents.filter(event => event.event === 'activity_end' && event.category === 'management');
    expect(managementDurations.length).toBe(workflow === 'separated' ? 2 : 0);
    expect(requestEvents.some(event => event.event === 'activity_end' && event.category === 'verification')).toBe(true);
    results.push({ workflow, formId: form.id, source: source ?? '', tool: comparableTool, saved: savedRecord, events: requestEvents, sid });
    page.off('request', onRequest);
  }
  for (const form of forms) {
    const [separated, integrated] = results.filter(result => result.formId === form.id);
    expect(separated?.source).toBe(integrated?.source);
    expect(separated?.tool).toBe(integrated?.tool);
    expect(separated?.saved).toBe(integrated?.saved);
  }

  const journalPath = path.resolve('quality/e0e6/test-local/events.jsonl');
  const journal = fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const metrics = analyzeExperimentEvents(journal);
  expect(metrics.by_condition).toHaveLength(6);
  const separatedRows = metrics.by_condition.filter((row: any) => row.condition.workflow === 'separated');
  const integratedRows = metrics.by_condition.filter((row: any) => row.condition.workflow === 'integrated');
  expect(separatedRows).toHaveLength(3);
  expect(integratedRows).toHaveLength(3);
  expect(separatedRows.every((row: any) => row.completed_count === 1 && row.success_count === 1 && row.management_operation_count >= 2)).toBe(true);
  expect(integratedRows.every((row: any) => row.completed_count === 1 && row.success_count === 1 && row.management_operation_count < separatedRows[0].management_operation_count)).toBe(true);
  expect(metrics.accounting.total_is_terminal_wall_time_only).toBe(true);
  expect(metrics.accounting.subdurations_added_to_total).toBe(false);

  await page.goto('/research-lab');
  await page.selectOption('#experiment', 'E6');
  await page.selectOption('#workflow-condition', 'mvp');
  await page.locator('#consent').check();
  const mvpStart = page.waitForResponse(response => response.url().endsWith('/research-experiments/sessions') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '同意して開始' }).click();
  const mvpResponse = await mvpStart;
  expect(mvpResponse.status()).toBe(201);
  expect(mvpResponse.request().postDataJSON()).toMatchObject({ condition: { workflow: 'mvp' } });
  expect((await mvpResponse.json()).workflowDefinitionId).toBe('e6-mvp-flat-baseline-v1');
  await expect(page.locator('#condition-description')).toContainText('MVP基準条件');
  await expect(page.locator('#transfer-status')).toBeHidden();
  const mvpSid = (await mvpResponse.json()).sid as string;
  await page.getByRole('button', { name: 'Source SYS-17 を見つける' }).click();
  await page.getByRole('button', { name: '次の段階へ' }).click();
  await page.getByRole('button', { name: '本文を確認した' }).click();
  await page.getByRole('button', { name: '次の段階へ' }).click();
  await page.getByRole('button', { name: '事実をメモ：「blue unit = 3」' }).click();
  await page.getByRole('button', { name: '次の段階へ' }).click();
  await page.getByRole('button', { name: '確認を開始' }).click();
  await page.getByRole('button', { name: '3 + 4 を計算して確認終了' }).click();
  await page.getByRole('button', { name: '次の段階へ' }).click();
  await page.getByRole('button', { name: 'このメモを保存' }).click();
  await page.getByRole('button', { name: '次の段階へ' }).click();
  await page.getByRole('button', { name: '保存済みメモを開く' }).click();
  await page.getByRole('button', { name: '次の段階へ' }).click();
  await page.getByRole('button', { name: '再開内容を確認' }).click();
  const mvpComplete = page.waitForResponse(response => response.url().includes(`/sessions/${mvpSid}/events`) && response.request().method() === 'POST' && response.request().postDataJSON().event === 'task_complete');
  await page.getByRole('button', { name: 'タスク完了を記録' }).click();
  expect((await mvpComplete).status()).toBe(201);
  const allMetrics = analyzeExperimentEvents(fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  const mvp = allMetrics.by_condition.find((row: any) => row.experiment === 'E6' && row.condition.workflow === 'mvp');
  expect(mvp).toMatchObject({ workflow_definition_id: 'e6-mvp-flat-baseline-v1', completed_count: 1, success_count: 1 });
  for (const result of results) expect((await request.delete(`/api/research-experiments/sessions/${result.sid}`)).status()).toBe(200);
  expect((await request.delete(`/api/research-experiments/sessions/${mvpSid}`)).status()).toBe(200);
  await request.delete('/api/research-experiments/events');
});

test('E0 refind and resume tasks run their declared phase sequences and report completion separately', async ({ page, request }) => {
  expect((await request.delete('/api/research-experiments/events')).status()).toBe(200);
  const cases = [
    { id: 'synthetic-refind-01', phases: ['検索', '再発見'] },
    { id: 'synthetic-resume-01', phases: ['読む', 'メモ', '保存', '再発見', '再開'] },
  ];
  const sids: string[] = [];
  for (const item of cases) {
    await page.goto('/research-lab');
    await page.selectOption('#experiment', 'E0');
    await page.selectOption('#task', item.id);
    await expect(page.locator('#workflow-condition')).toBeDisabled();
    await expect(page.locator('#automation')).toBeDisabled();
    await page.locator('#consent').check();
    const startedPromise = page.waitForResponse(response => response.url().endsWith('/research-experiments/sessions') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '同意して開始' }).click();
    const started = await startedPromise;
    expect(started.status()).toBe(201);
    expect((await started.json()).workflowDefinitionId).toBe('e0-synthetic-workflow-v1');
    sids.push((await started.json()).sid as string);
    expect(await page.locator('#workflow-nav button').allTextContents()).toEqual(item.phases.map((phase, index) => `${index + 1}. ${phase}`));

    if (item.id === 'synthetic-refind-01') {
      await page.getByRole('button', { name: 'Source SYS-17 を見つける' }).click();
      await page.getByRole('button', { name: '次の段階へ' }).click();
      await page.getByRole('button', { name: '保存済みメモを開く' }).click();
    } else {
      await page.getByRole('button', { name: '本文を確認した' }).click();
      await page.getByRole('button', { name: '次の段階へ' }).click();
      await page.getByRole('button', { name: '事実をメモ：「blue unit = 3」' }).click();
      await page.getByRole('button', { name: '次の段階へ' }).click();
      await page.getByRole('button', { name: 'このメモを保存' }).click();
      await page.getByRole('button', { name: '次の段階へ' }).click();
      await page.getByRole('button', { name: '保存済みメモを開く' }).click();
      await page.getByRole('button', { name: '次の段階へ' }).click();
      await page.getByRole('button', { name: '再開内容を確認' }).click();
    }
    const completePromise = page.waitForResponse(response => response.url().includes(`/sessions/${sids.at(-1)}/events`)
      && response.request().method() === 'POST' && response.request().postDataJSON().event === 'task_complete');
    await page.getByRole('button', { name: 'タスク完了を記録' }).click();
    expect((await completePromise).status()).toBe(201);
    await expect(page.locator('#status')).toContainText('成功。総経過時間');
  }
  const journalPath = path.resolve('quality/e0e6/test-local/events.jsonl');
  const metrics = analyzeExperimentEvents(fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  expect(metrics.by_condition).toHaveLength(2);
  expect(metrics.by_condition.every((row: any) => row.experiment === 'E0' && row.workflow_definition_id === 'e0-synthetic-workflow-v1'
    && row.completed_count === 1 && row.success_count === 1)).toBe(true);
  for (const sid of sids) expect((await request.delete(`/api/research-experiments/sessions/${sid}`)).status()).toBe(200);
  await request.delete('/api/research-experiments/events');
});
