// Access-matrix + navigation functionality suite.
// Guards the role/permission gating (owner/staff/member/contractor +
// no_financials lockout) across the Procore-style grouped rail, and checks
// every reachable page actually renders without uncaught JS errors.
const { test, expect } = require('@playwright/test');
const { bootAs, tabVisible } = require('./helpers');

const ALL_TABS = [
  'projects', 'tasks', 'rfis', 'submittals', 'milestones', 'daily',
  'field_reports', 'deficiencies', 'photos', 'quantities',
  'sov', 'cos', 'docs', 'users', 'profile',
];

// Expected VISIBLE tabs per role. All seeded sessions are legacy (non-native),
// so Profile is hidden for every role by design (body.auth-legacy rule).
const MATRIX = {
  owner: ALL_TABS.filter((t) => t !== 'profile'),
  staff: ALL_TABS.filter((t) => !['users', 'profile'].includes(t)),
  member: ALL_TABS.filter((t) => !['users', 'profile'].includes(t)),
  member_nofin: ALL_TABS.filter((t) => !['users', 'profile', 'sov', 'cos'].includes(t)),
  contractor: ALL_TABS.filter((t) => !['users', 'profile'].includes(t)),
  contractor_limited: ALL_TABS.filter(
    (t) => !['users', 'profile', 'submittals', 'sov', 'cos', 'docs'].includes(t)
  ),
};

for (const [role, visibleTabs] of Object.entries(MATRIX)) {
  test.describe(`role: ${role}`, () => {
    test('boots with correct role class and tab visibility matrix', async ({ page }) => {
      const errors = await bootAs(page, role);
      const baseRole = role.startsWith('member') ? 'member'
        : role.startsWith('contractor') ? 'contractor' : role;
      await expect(page.locator('body')).toHaveClass(new RegExp(`\\brole-${baseRole}\\b`));
      for (const tab of ALL_TABS) {
        const want = visibleTabs.includes(tab);
        expect(await tabVisible(page, tab), `${role}: tab "${tab}" visible should be ${want}`).toBe(want);
      }
      expect(errors, `${role}: uncaught page errors`).toEqual([]);
    });

    test('every visible tab renders its page without errors', async ({ page }) => {
      const errors = await bootAs(page, role);
      for (const tab of visibleTabs) {
        await page.locator(`#tabs .tab[data-tab="${tab}"]`).click();
        const pageId = `#page-${tab}`;
        await expect(page.locator(pageId), `${role}: ${pageId} active after click`)
          .toHaveClass(/\bactive\b/);
        await expect(page.locator(pageId)).toBeVisible();
      }
      expect(errors, `${role}: uncaught page errors while paging`).toEqual([]);
    });
  });
}

test.describe('access guards', () => {
  test('staff forcing switchTab("users") is redirected to projects', async ({ page }) => {
    await bootAs(page, 'staff');
    await page.evaluate(() => window.switchTab('users'));
    await expect(page.locator('#page-projects')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#page-users')).not.toHaveClass(/\bactive\b/);
  });

  test('contractor without payapps perm forcing switchTab("sov") is redirected', async ({ page }) => {
    await bootAs(page, 'contractor_limited');
    await page.evaluate(() => window.switchTab('sov'));
    await expect(page.locator('#page-projects')).toHaveClass(/\bactive\b/);
  });

  test('member cannot see New Project button; owner can', async ({ page }) => {
    await bootAs(page, 'member');
    await expect(page.locator('#page-projects .perm-edit-projects').first()).toBeHidden();
  });

  test('owner sees New Project button', async ({ page }) => {
    await bootAs(page, 'owner');
    await expect(page.locator('#page-projects .perm-edit-projects').first()).toBeVisible();
  });

  test('financials nav group disappears entirely for no_financials member', async ({ page }) => {
    await bootAs(page, 'member_nofin');
    await expect(page.locator('#tabs .nav-group[data-group="financials"]')).toBeHidden();
  });

  test('financials nav group disappears for permission-limited contractor', async ({ page }) => {
    await bootAs(page, 'contractor_limited');
    await expect(page.locator('#tabs .nav-group[data-group="financials"]')).toBeHidden();
  });

  test('financials nav group visible for owner', async ({ page }) => {
    await bootAs(page, 'owner');
    await expect(page.locator('#tabs .nav-group[data-group="financials"]')).toBeVisible();
  });
});

test.describe('rail behavior', () => {
  test('collapse toggle shrinks rail, hides labels, persists across reload', async ({ page }) => {
    await bootAs(page, 'owner');
    const label = page.locator('#tabs .tab[data-tab="projects"] .tab-label');
    await expect(label).toBeVisible();
    await page.locator('#railToggle').click();
    await expect(page.locator('body')).toHaveClass(/\brail-collapsed\b/);
    await expect(label).toBeHidden();
    // icon-only tabs must still navigate
    await page.locator('#tabs .tab[data-tab="tasks"]').click();
    await expect(page.locator('#page-tasks')).toHaveClass(/\bactive\b/);
    await page.reload();
    await page.waitForSelector('#appShell', { state: 'visible' });
    await expect(page.locator('body')).toHaveClass(/\brail-collapsed\b/);
    await page.locator('#railToggle').click();
    await expect(page.locator('body')).not.toHaveClass(/\brail-collapsed\b/);
  });

  test('mobile viewport flattens groups into horizontal strip', async ({ page }) => {
    await bootAs(page, 'owner', { viewport: { width: 375, height: 700 } });
    const dir = await page.locator('#tabs').evaluate((el) => getComputedStyle(el).flexDirection);
    expect(dir).toBe('row');
    await expect(page.locator('#railToggle')).toBeHidden();
    await expect(page.locator('#tabs .nav-group-label').first()).toBeHidden();
    await page.locator('#tabs .tab[data-tab="tasks"]').click();
    await expect(page.locator('#page-tasks')).toHaveClass(/\bactive\b/);
  });
});
