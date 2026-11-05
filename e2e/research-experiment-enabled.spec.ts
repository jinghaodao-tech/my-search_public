import { expect, test } from '@playwright/test';

test('opt-in local lab records synthetic consented events and permits deletion', async ({ page, request }) => {
  const response = await page.goto('/research-lab');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: '実験ラボ（合成課題）' })).toBeVisible();

  const status = await request.get('/api/research-experiments/status');
  expect(status.status()).toBe(200);
  const statusBody = await status.json();
  expect(statusBody).toMatchObject({ enabled: true, localOnly: true, consentRequired: true });
  expect(statusBody.excludedFields).toContain('query');
  expect((await request.delete('/api/research-experiments/events')).status()).toBe(200);

  expect((await request.post('/api/research-experiments/sessions', { data: { consent: false, experiment: 'E0', taskId: 'synthetic-refind-01' } })).status()).toBe(400);
  expect((await request.post('/api/research-experiments/sessions', { data: { consent: true, experiment: 'E0', taskId: 'synthetic-refind-01', note: 'x'.repeat(9000) } })).status()).toBe(413);
  const started = await request.post('/api/research-experiments/sessions', { data: {
    consent: true, experiment: 'E6', taskId: 'synthetic-integrate-01',
    condition: { automation: 'manual', visibility: 'current', timing: 'on_request', workflow: 'separated' },
  } });
  expect(started.status()).toBe(201);
  const { sid } = await started.json();
  expect((await request.post(`/api/research-experiments/sessions/${sid}/events`, { data: { event: 'task_complete', outcome: 'success' } })).status()).toBe(201);
  expect((await request.delete(`/api/research-experiments/sessions/${sid}`)).status()).toBe(200);
  const finalStatus = await (await request.get('/api/research-experiments/status')).json();
  expect(finalStatus).toMatchObject({ sessions: 0 });
  expect((await request.delete('/api/research-experiments/events')).status()).toBe(200);
});
