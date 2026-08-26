export function generateDemoLoginTest(baseUrl: string, startUrl?: string) {
  const url = startUrl ?? new URL("/login?variant=A", baseUrl).toString();

  return `import { test, expect } from '@playwright/test';

test('demo login page has sign in button', async ({ page }) => {
  await test.step('STEP_ID=demo-step-1 | goto login', async () => {
    await page.goto(${JSON.stringify(url)});
  });

  await test.step('STEP_ID=demo-step-2 | expect sign in button', async () => {
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });
});
`;
}