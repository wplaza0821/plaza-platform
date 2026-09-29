// Projects landing: the attention strip, the card grid's sort/filter rules, and
// the project switcher that replaced a bare <select>.
const { test, expect } = require('@playwright/test');
const { bootAs } = require('./helpers');

const cards = (page) => page.locator('#projectGrid .project-card');
const tile = (page, key) => page.locator(`.attn-tile[data-attn="${key}"]`);

test.describe('attention strip', () => {
  test('counts across the portfolio, not the current filter', async ({ page }) => {
    const errors = await bootAs(page, 'owner');
    // p2 alone carries 2 overdue RFIs and 1 critical defect; submittals are
    // p2's 2 + p3's 1 even though p3 is bidding and the grid opens on active.
    await expect(tile(page, 'overdue').locator('.attn-n')).toHaveText('2');
    await expect(tile(page, 'critical').locator('.attn-n')).toHaveText('1');
    await expect(tile(page, 'subs').locator('.attn-n')).toHaveText('3');
    // p1 is active with reports_this_month 0 — the failure nobody gets alerted to
    await expect(tile(page, 'quiet').locator('.attn-n')).toHaveText('1');
    expect(errors).toEqual([]);
  });

  test('a tile narrows the grid to the projects behind its number', async ({ page }) => {
    await bootAs(page, 'owner');
    await tile(page, 'overdue').click();
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toContainText('Bayfront Tower');
  });

  test('clicking the active tile clears it, so the grid is never a dead end', async ({ page }) => {
    await bootAs(page, 'owner');
    await tile(page, 'overdue').click();
    await expect(cards(page)).toHaveCount(1);
    await tile(page, 'overdue').click();
    await expect(tile(page, 'overdue')).toHaveAttribute('aria-pressed', 'false');
    await expect(cards(page)).toHaveCount(2);   // back to the two active projects
  });

  test('switching a tile off restores the chip it overrode', async ({ page }) => {
    await bootAs(page, 'owner');
    await page.locator('#projectFilters .chip[data-filter="bidding"]').click();
    await expect(cards(page)).toHaveCount(1);
    // the tile counts portfolio-wide, so it has to widen the chip to 'all'...
    await tile(page, 'subs').click();
    await expect(page.locator('#projectFilters .chip.active')).toHaveText('All');
    // ...and hand it back, or a tile pressed twice leaves you somewhere third
    await tile(page, 'subs').click();
    await expect(page.locator('#projectFilters .chip.active')).toHaveText('Bidding');
    await expect(cards(page)).toHaveCount(1);
  });

  test('a tile reaches projects the status chip was hiding', async ({ page }) => {
    await bootAs(page, 'owner');
    // 'subs' counts p3, which is bidding and therefore not in the default view.
    // If the chip kept filtering, the tile would promise 3 and show 1.
    await tile(page, 'subs').click();
    await expect(cards(page)).toHaveCount(2);
    await expect(page.locator('#projectGrid')).toContainText('Harbour Bidding');
  });

  test('a zero tile is inert rather than filtering to nothing', async ({ page }) => {
    await bootAs(page, 'owner', { dashboard: [] });
    await expect(tile(page, 'overdue').locator('.attn-n')).toHaveText('0');
    await expect(tile(page, 'overdue')).toHaveAttribute('data-empty', '1');
    await tile(page, 'overdue').click({ force: true });
    await expect(tile(page, 'overdue')).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('project grid', () => {
  test('opens on current work, with archived behind a toggle', async ({ page }) => {
    await bootAs(page, 'owner');
    // 'all' used to be the default, which put a 2025 archived job in front of
    // live work on every load.
    await expect(page.locator('#projectFilters .chip.active')).toHaveText('Active');
    await expect(cards(page)).toHaveCount(2);
    await expect(page.locator('#projectGrid')).not.toContainText('Old Closed Job');
    await expect(page.locator('#archToggle')).toContainText('1 archived project');
  });

  test('archived toggle reveals and hides them', async ({ page }) => {
    await bootAs(page, 'owner');
    await page.locator('#archToggle').click();
    await expect(page.locator('#projectGrid')).toContainText('Old Closed Job');
    await page.locator('#archToggle').click();
    await expect(page.locator('#projectGrid')).not.toContainText('Old Closed Job');
  });

  test('projects needing attention sort above quiet ones', async ({ page }) => {
    await bootAs(page, 'owner');
    // TP-02 sorts before TP-01 despite the code order, because it has overdue
    // RFIs and a critical defect.
    await expect(cards(page).first()).toContainText('Bayfront Tower');
    await expect(cards(page).first()).toHaveClass(/needs/);
    await expect(cards(page).nth(1)).not.toHaveClass(/needs/);
  });

  test('a silent live project says so instead of reporting a bare zero', async ({ page }) => {
    await bootAs(page, 'owner');
    const p1 = cards(page).filter({ hasText: 'Test Project' });
    await expect(p1).toContainText('No report this month');
  });

  test('an empty result explains which filter emptied it', async ({ page }) => {
    await bootAs(page, 'owner');
    await page.locator('#projectFilters .chip[data-filter="closeout"]').click();
    await expect(page.locator('#projectGrid')).toContainText('No closeout projects');
    await page.locator('#projectGrid button', { hasText: 'Show all projects' }).click();
    await expect(cards(page).first()).toBeVisible();
  });

  test('clicking a card selects it', async ({ page }) => {
    await bootAs(page, 'owner');
    await cards(page).filter({ hasText: 'Test Project' }).click();
    await expect(cards(page).filter({ hasText: 'Test Project' })).toHaveClass(/active/);
  });
});

test.describe('project switcher', () => {
  test('opens on Cmd+K, filters as you type, and switches', async ({ page }) => {
    const errors = await bootAs(page, 'owner');
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('#pswPanel')).toHaveClass(/on/);
    await page.locator('#pswSearch').fill('bayfront');
    await expect(page.locator('#pswList .psw-item')).toHaveCount(1);
    await page.locator('#pswList .psw-item').click();
    await expect(page.locator('#pswName')).toHaveText('TP-02 — Bayfront Tower');
    await expect(page.locator('#pswPanel')).not.toHaveClass(/on/);
    expect(errors).toEqual([]);
  });

  test('searches client name, not only project name', async ({ page }) => {
    await bootAs(page, 'owner');
    await page.locator('#pswBtn').click();
    await page.locator('#pswSearch').fill('harbour llc');
    await expect(page.locator('#pswList .psw-item')).toHaveCount(1);
    await expect(page.locator('#pswList .psw-item')).toContainText('Harbour Bidding');
  });

  test('arrow keys and Enter pick without the mouse', async ({ page }) => {
    await bootAs(page, 'owner');
    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('#pswSearch').fill('tp-03');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('#pswName')).toHaveText('TP-03 — Harbour Bidding');
  });

  test('Escape closes it and returns focus to the button', async ({ page }) => {
    await bootAs(page, 'owner');
    await page.locator('#pswBtn').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#pswPanel')).not.toHaveClass(/on/);
    await expect(page.locator('#pswBtn')).toBeFocused();
  });

  test('a search with no match says so rather than showing everything', async ({ page }) => {
    await bootAs(page, 'owner');
    await page.locator('#pswBtn').click();
    await page.locator('#pswSearch').fill('zzzz');
    await expect(page.locator('#pswList')).toContainText('No project matches');
    await expect(page.locator('#pswList .psw-item')).toHaveCount(0);
  });

  test('recently opened projects lead the list, but never over a search', async ({ page }) => {
    await bootAs(page, 'owner');
    await cards(page).filter({ hasText: 'Test Project' }).click();
    await page.locator('#pswBtn').click();
    await expect(page.locator('#pswList .psw-sec').first()).toHaveText('Recent');
    await expect(page.locator('#pswList .psw-item').first()).toContainText('Test Project');
    // once there is a query, a Recent heading on top would hide the answer
    await page.locator('#pswSearch').fill('harbour');
    await expect(page.locator('#pswList .psw-sec')).toHaveCount(0);
  });

  test('contractors never see the switcher', async ({ page }) => {
    const errors = await bootAs(page, 'contractor');
    await expect(page.locator('#pswWrap')).toBeHidden();
    // and the shortcut must not open a hidden panel behind their back
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('#pswPanel')).not.toHaveClass(/on/);
    expect(errors).toEqual([]);
  });
});
