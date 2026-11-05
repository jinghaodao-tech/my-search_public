import { expect, test } from '@playwright/test';

test('research lab and measurement API stay unavailable with the default-off flag', async ({ page, request }) => {
  const pageResponse = await page.goto('/research-lab');
  expect(pageResponse?.status()).toBe(404);
  const apiResponse = await request.get('/api/research-experiments/status');
  expect(apiResponse.status()).toBe(404);
});
