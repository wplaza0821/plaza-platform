# Plazacore Phase 4 — Frontend wiring patch (index.html)

Copy-paste snippets keyed to the CURRENT code (clone @ 2026-06-09). Conventions used:
`sb` (client), `_sbJwt` (current JWT), `SUPABASE_KEY`, `DATA.*` arrays, `STATE.activeProjectId`,
`AUTH`, `isOwner()/isContractor()`, helpers `fmt$`, `escapeHtml`, `statusBadge`, `toast`,
`handleSbError`, `loadAllData`, `render`. All additions are non-breaking.

---

## 0. Function URLs — add next to line ~4322 (after NOTIFY_FN_URL)
```js
const ROUTE_FN_URL    = SUPABASE_URL + '/functions/v1/notify-route';
const FINALIZE_FN_URL = SUPABASE_URL + '/functions/v1/finalize-report';
const QB_FN_URL       = SUPABASE_URL + '/functions/v1/qb-billing';
```

## 1. Generic fire-and-forget caller — add near notifyTaskAssigned (~5422)
Mirrors the existing helper; reused by RFIs/submittals/deficiencies.
```js
// Fire-and-forget routing notification (in-app + SMS). Never blocks UI.
function notifyRoute(refTable, refId, event) {
  try {
    if (!_sbJwt || !refId) return;
    fetch(ROUTE_FN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'apikey': SUPABASE_KEY,
                 'Authorization': 'Bearer ' + _sbJwt },
      body: JSON.stringify({ ref_table: refTable, ref_id: refId, event: event || 'created' }),
    }).catch(e => console.warn('notify-route failed (non-blocking):', e));
  } catch (e) { console.warn('notify-route dispatch error:', e); }
}
```
Then call it where records are created / ball-in-court changes. Examples:
- In `saveRfi`: after a successful insert → `notifyRoute('rfis', newId, 'created');`
  and on a ball_in_court change in update → `notifyRoute('rfis', id, 'ball_in_court_change');`
- In `saveSubmittal`: `notifyRoute('submittals', newId, 'created');`
- In `saveDeficiency`: `notifyRoute('deficiencies', newId, 'created');`

---

## 2. Dashboard rollup — replace the per-card count logic in renderProjects (~1922)
The RPC returns authoritative counts in one call. Load once in `loadAllData`, cache on `DATA`.
In `loadAllData` (where the other `sb.from(...).select()` promises are assembled, ~1715):
```js
const dashP = sb.rpc('plz_dashboard');
// ...add dashP to your Promise.all and then:
DATA.dashboard = (dashRes && !dashRes.error && dashRes.data) ? dashRes.data : [];
```
Then in `renderProjects`, swap the inline `rfiCount/subCount` for the rollup row:
```js
const d = (DATA.dashboard || []).find(x => x.project_id === p.id) || {};
const openItems = (d.open_rfis||0) + (d.pending_submittals||0) + (d.open_deficiencies||0);
const overdue   = (d.overdue_rfis||0);
const crit      = (d.critical_defs||0);
// badge HTML (add under .project-stats):
//   Open ${openItems} · Overdue ${overdue} · Critical ${crit} · Reports MTD ${d.reports_this_month||0}
//   last pay-app: ${escapeHtml(d.last_payapp_status||'—')}
```
Color the overdue/critical badges red when > 0. Data already styled in `.stat-*`.

---

## 3. Inspection checklist — render template into the field-report modal
In `openFieldReportModal` (~5855), after the type/compliance fields, add a template
picker + dynamic checklist container:
```html
<label>Inspection Template
  <select id="fr-template" onchange="renderFrChecklist()">
    <option value="">— none (free text) —</option>
  </select>
</label>
<div id="fr-checklist"></div>
```
Populate options + renderer (add these functions; templates loaded once into DATA):
```js
// load once in loadAllData: DATA.templates = (await sb.from('inspection_templates')
//   .select('*').eq('active', true).order('standard')).data || [];
function fillFrTemplateOptions(selectedId) {
  const sel = document.getElementById('fr-template'); if (!sel) return;
  sel.innerHTML = '<option value="">— none (free text) —</option>' +
    (DATA.templates||[]).map(t =>
      `<option value="${t.id}" ${t.id===selectedId?'selected':''}>${escapeHtml(t.standard||'')} — ${escapeHtml(t.name)}</option>`).join('');
}
function renderFrChecklist(existing) {
  const wrap = document.getElementById('fr-checklist'); if (!wrap) return;
  const tid = document.getElementById('fr-template').value;
  const tpl = (DATA.templates||[]).find(t => t.id === tid);
  if (!tpl) { wrap.innerHTML = ''; return; }
  const filled = existing || [];
  wrap.innerHTML = '<table class="checklist"><tr><th>Item</th><th>Code</th><th>Result</th><th>Note</th></tr>' +
    (tpl.schema||[]).map((it,i) => {
      const cur = filled.find(f => f.key === it.key) || {};
      const opts = it.type === 'numeric'
        ? `<input type="number" step="any" data-k="${it.key}" class="cl-val" value="${cur.value??''}">`
        : it.type === 'text'
        ? `<input type="text" data-k="${it.key}" class="cl-val" value="${escapeHtml(cur.value??'')}">`
        : ['pass','fail','na'].map(o =>
            `<label><input type="radio" name="cl_${i}" data-k="${it.key}" class="cl-res" value="${o}" ${cur.result===o?'checked':''}>${o.toUpperCase()}</label>`).join(' ');
      return `<tr><td>${escapeHtml(it.label)}${it.required?' *':''}</td><td>${escapeHtml(it.code_ref||'')}</td><td>${opts}</td>`+
             `<td><input type="text" data-k="${it.key}" class="cl-note" value="${escapeHtml(cur.note||'')}"></td></tr>`;
    }).join('') + '</table>';
}
function collectFrChecklist() {
  const rows = {};
  document.querySelectorAll('#fr-checklist .cl-res:checked, #fr-checklist .cl-val').forEach(el => {
    const k = el.dataset.k; rows[k] = rows[k]||{key:k};
    if (el.classList.contains('cl-res')) rows[k].result = el.value; else rows[k].value = el.value;
  });
  document.querySelectorAll('#fr-checklist .cl-note').forEach(el => {
    const k = el.dataset.k; if (el.value) { rows[k]=rows[k]||{key:k}; rows[k].note = el.value; }
  });
  return Object.values(rows);
}
window.renderFrChecklist = renderFrChecklist;
```
In `saveFieldReport` (~5936) add to `data`:
```js
template_id: document.getElementById('fr-template').value || null,
checklist: collectFrChecklist(),
```

---

## 4. Finalize / seal button — field report view (~5841 viewFieldReportPDF / actions)
Show only to owner, only when not yet finalized:
```js
async function finalizeReport(id) {
  if (!isOwner()) { toast('Owner only'); return; }
  if (!confirm('Finalize & seal this report? Content locks after sealing.')) return;
  const res = await fetch(FINALIZE_FN_URL, {
    method: 'POST',
    headers: { 'content-type':'application/json', 'apikey': SUPABASE_KEY, 'Authorization':'Bearer '+_sbJwt },
    body: JSON.stringify({ field_report_id: id }),
  });
  const out = await res.json().catch(()=>({}));
  if (!res.ok || !out.ok) { toast('Finalize failed: ' + (out.error||res.status)); return; }
  toast('Report sealed ✓  hash ' + (out.sha256||'').slice(0,10));
  await loadAllData(); render();
}
window.finalizeReport = finalizeReport;
```
In the report view actions row (the one with `window.print()` at ~3072 / FR view),
add next to Print:
```html
<button class="btn" onclick="finalizeReport('${editing.id}')" ${editing.finalized?'disabled':''}>
  ${editing.finalized ? '🔒 Sealed' : '✅ Finalize & Seal'}
</button>
```
Once `finalized`, disable the Edit button and show the seal line
(`Sealed by ${seal_inspector} ${seal_license} · ${finalized_at}`).

---

## 5. (optional P1) QB billing button — owner billing view
```js
async function qbAction(body) {
  const res = await fetch(QB_FN_URL, { method:'POST',
    headers:{'content-type':'application/json','apikey':SUPABASE_KEY,'Authorization':'Bearer '+_sbJwt},
    body: JSON.stringify(body) });
  return res.json();
}
// queue:    qbAction({action:'queue', project_id, period:'2026-06', amount:3000, description:'...'})
// mark_paid:qbAction({action:'mark_paid', id, ar_balance:0})
```

---

## CSS (add to <style>) — checklist + badges
```css
table.checklist{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
table.checklist td,table.checklist th{border:1px solid var(--border,#ddd);padding:4px 6px}
.badge-overdue{background:#c0392b;color:#fff;border-radius:10px;padding:1px 7px;font-size:11px}
.badge-crit{background:#922;color:#fff;border-radius:10px;padding:1px 7px;font-size:11px}
```

## Test checklist (do in a staging Supabase project first)
1. Create a field report with a template → checklist saves to `checklist` jsonb.
2. Owner clicks Finalize → report_seals row created, finalized=true, edit locked, hash shown.
3. Create an RFI with assignee (a profile uuid w/ phone) → SMS + bell fire.
4. Dashboard badges match raw counts.
5. Upload a doc with an existing sheet_number → prior flips to superseded.
6. Try editing a sealed report → DB trigger raises, UI shows error.
```
