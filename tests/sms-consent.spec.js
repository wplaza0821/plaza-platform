// The SMS opt-in is a compliance surface, not just a form: A2P 10DLC campaign
// review and any TCPA dispute turn on whether the consumer could see which
// number they were authorising, and on what disclosure was stored as evidence.
// These tests pin that behaviour.
const { test, expect } = require('@playwright/test');
const { stubCdn, stubSupabase } = require('./helpers');

// Opens the public request-access panel with no session, capturing whatever
// the page tries to insert into access_requests.
async function openRequestAccess(page) {
  const inserts = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await stubCdn(page);
  await stubSupabase(page);
  await page.route('**/*.supabase.co/rest/v1/access_requests*', (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      try { inserts.push(JSON.parse(req.postData() || '{}')); } catch (e) {}
      return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto('/index.html');
  await page.locator('#requestAccessLink').click();
  await expect(page.locator('#requestAccessPanel')).toBeVisible();
  return { inserts, errors };
}

test('the mobile number sits with the consent checkbox, not elsewhere on the form', async ({ page }) => {
  const { errors } = await openRequestAccess(page);
  const block = page.locator('#raSmsBlock');
  await expect(block).toBeVisible();
  // both the input and the checkbox live inside the same grouped block
  await expect(block.locator('#raPhone')).toHaveCount(1);
  await expect(block.locator('#raSmsConsent')).toHaveCount(1);
  // the message textarea must NOT sit between them any more
  await expect(block.locator('#raMessage')).toHaveCount(0);
  // consent is opt-in: never pre-checked
  await expect(page.locator('#raSmsConsent')).not.toBeChecked();
  expect(errors).toEqual([]);
});

test('the disclosure names the number the consumer typed', async ({ page }) => {
  await openRequestAccess(page);
  const text = page.locator('#raSmsConsentText');
  await expect(text).toContainText('at the mobile number I entered above');
  // nothing echoed until a plausible number exists
  await expect(page.locator('#raSmsNumberEcho')).toHaveText('');
  await page.locator('#raPhone').fill('305');
  await expect(page.locator('#raSmsNumberEcho')).toHaveText('');
  await page.locator('#raPhone').fill('(305) 555-0123');
  await expect(page.locator('#raSmsNumberEcho')).toHaveText(', (305) 555-0123,');
  await expect(text).toContainText('(305) 555-0123');
});

test('consent stores the disclosure verbatim, including the number', async ({ page }) => {
  const { inserts } = await openRequestAccess(page);
  await page.locator('#raName').fill('Dana Board');
  await page.locator('#raEmail').fill('board@example.test');
  await page.locator('#raPhone').fill('(305) 555-0123');
  await page.locator('#raSmsConsent').check();
  await page.locator('#raSubmitBtn').click();
  await expect(page.locator('#raSuccess')).toBeVisible();
  expect(inserts).toHaveLength(1);
  const row = inserts[0];
  expect(row.sms_consent).toBe(true);
  expect(row.phone).toBe('(305) 555-0123');
  expect(row.sms_consent_at).toBeTruthy();
  // the evidence must record WHICH number consented
  expect(row.sms_consent_text).toContain('(305) 555-0123');
  expect(row.sms_consent_text).toContain('Reply STOP to opt out');
  expect(row.sms_consent_text).toContain('Consent is not a condition');
});

test('checking consent without a number is refused and focuses the field', async ({ page }) => {
  const { inserts } = await openRequestAccess(page);
  await page.locator('#raName').fill('Dana Board');
  await page.locator('#raEmail').fill('board@example.test');
  await page.locator('#raSmsConsent').check();
  await page.locator('#raSubmitBtn').click();
  await expect(page.locator('#raError')).toContainText('mobile number');
  await expect(page.locator('#raPhone')).toBeFocused();
  expect(inserts).toHaveLength(0);   // nothing written
});

test('declining SMS still submits, and stores no consent', async ({ page }) => {
  const { inserts } = await openRequestAccess(page);
  await page.locator('#raName').fill('Pat Manager');
  await page.locator('#raEmail').fill('pm@example.test');
  await page.locator('#raSubmitBtn').click();
  await expect(page.locator('#raSuccess')).toBeVisible();
  expect(inserts).toHaveLength(1);
  expect(inserts[0].sms_consent).toBe(false);
  expect(inserts[0].sms_consent_at).toBeNull();
  expect(inserts[0].sms_consent_text).toBeNull();
});
