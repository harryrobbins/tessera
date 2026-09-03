import type { Dataset } from '../../data/columnar';
import { valueAt } from '../../data/columnar';
import type { DetailRenderer } from '../detail';
import { actionsBlock, contextBlock, contextFields, modalHeader } from './template';

/**
 * Customer record for the tax-cases collection: who they are, what the case
 * is, and the journey from first contact to resolution. Everything is read
 * through `valueAt`, so a column that is absent (e.g. no `Customer` names on
 * a 100k collection) simply renders as an empty cell rather than throwing.
 */

// Colour tokens, shared with the card painter's palette (src/core/palette.ts).
const CHIP: Record<string, string> = { High: '#e66767', Standard: '#3987e5', Low: '#86857c' };
const STATUS_OPEN = '#c98500';
const STATUS_RESOLVED = '#199e70';

const GLYPHS: Record<string, string> = {
  Phone: '<path d="M4 2.5h2.5l1.2 3-1.6 1.1a8 8 0 0 0 3.3 3.3l1.1-1.6 3 1.2V12a1 1 0 0 1-1 1A10 10 0 0 1 3 3.5a1 1 0 0 1 1-1z"/>',
  Webchat: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>',
  'Web form': '<path d="M4 2h6l3 3v9H4z"/><path d="M6 8h5M6 10.5h5"/>',
  Post: '<path d="M2 4h12v8H2z"/><path d="M2 4l6 5 6-5"/>',
};

function glyph(channel: string): string {
  const d = GLYPHS[channel];
  if (!d) return '';
  return `<svg class="glyph" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">${d}</svg>`;
}

function num(ds: Dataset, name: string, i: number): number {
  const c = ds.columns[name];
  return c?.kind === 'number' ? c.values[i] : NaN;
}

function stars(v: number): string {
  if (!Number.isFinite(v)) return '';
  const n = Math.max(0, Math.min(5, Math.round(v)));
  return `<span class="stars" aria-label="${n} out of 5">${'★'.repeat(n)}<span class="empty">${'★'.repeat(5 - n)}</span></span>`;
}

function hoursLabel(h: number): string {
  if (!Number.isFinite(h)) return '';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

export const taxCaseDetail: DetailRenderer = (ds, i, ctx) => {
  const { esc } = ctx;
  const v = (name: string) => esc(valueAt(ds, name, i));
  const caseRef = valueAt(ds, 'Case', i);
  const channel = valueAt(ds, 'Channel', i);
  const priority = valueAt(ds, 'Priority', i);
  const status = valueAt(ds, 'Status', i);
  const open = status === 'Open';
  const escalated = valueAt(ds, 'Escalated', i) === 'Yes';
  const contacts = num(ds, 'Contacts', i);
  const hours = num(ds, 'Resolution hours', i);
  const sat = num(ds, 'Satisfaction', i);
  const waiting = num(ds, 'Days waiting', i);
  const handling = num(ds, 'Handling minutes', i);
  const prior = num(ds, 'Prior cases', i);
  const slaState = valueAt(ds, 'Within SLA', i);
  const reopened = valueAt(ds, 'Reopened', i) === 'Yes';

  const field = (label: string, html: string) =>
    `<div class="fld"><dt>${esc(label)}</dt><dd>${html || '—'}</dd></div>`;

  const contactsLabel = Number.isFinite(contacts)
    ? `${contacts.toFixed(0)} contact${contacts === 1 ? '' : 's'}`
    : 'Contacts';
  const resolvedLabel = open
    ? `<b>Still open</b><small>${Number.isFinite(waiting) ? `waiting ${waiting.toFixed(0)} day${waiting === 1 ? '' : 's'}` : escalated ? 'escalated' : 'in progress'}</small>`
    : `<b>Resolved</b><small>${esc(hoursLabel(hours) || valueAt(ds, 'Resolution hours', i))}</small>`;

  const satisfaction = open
    ? '<span class="muted">awaiting resolution</span>'
    : Number.isFinite(sat)
      ? `${stars(sat)} <span class="muted">${v('Satisfaction')}</span>`
      : '<span class="muted">not surveyed</span>';

  return modalHeader(ds, i, ctx) + `
    <div class="body">
    <section>
      <h3>Customer</h3>
      <dl class="kv">
        ${field('Postcode', `<span class="mono">${v('Postcode')}</span>`)}
        ${field('Town', v('Town'))}
        ${field('Region', v('Region'))}
        ${field('Area type', v('Area type'))}
        ${field('Age band', v('Age band'))}
        ${field('Customer type', v('Customer type'))}
        ${field('Language', v('Language'))}
        ${field('Support needs', v('Support needs'))}
        ${field('Earlier cases', Number.isFinite(prior) && prior > 0
          ? `${prior.toFixed(0)} before this one`
          : '<span class="muted">first contact</span>')}
      </dl>
    </section>
    <section>
      <h3>Case <span class="mono ref">${esc(caseRef)}</span></h3>
      <dl class="kv">
        ${field('Subject', v('Subject'))}
        ${field('Topic', v('Topic'))}
        ${field('Reason', v('Reason'))}
        ${field('Team', v('Team'))}
        ${field('Adviser', v('Adviser'))}
        ${field('Channel', `<span class="with-glyph">${glyph(channel)}${esc(channel)}</span>`)}
        ${field('Priority', `<span class="chip" style="--chip:${CHIP[priority] ?? '#86857c'}">${esc(priority)}</span>`)}
        ${field('Status', `<span class="status"><i style="background:${open ? STATUS_OPEN : STATUS_RESOLVED}"></i>${esc(status)}</span>`)}
        ${field('Escalated', escalated ? `<span class="chip" style="--chip:${STATUS_OPEN}">Yes</span>` : 'No')}
        ${field('Reopened', reopened ? `<span class="chip" style="--chip:${STATUS_OPEN}">Yes</span>` : 'No')}
      </dl>
    </section>
    <section>
      <h3>Journey</h3>
      <ol class="timeline${open ? ' open' : ''}">
        <li class="node start"><i></i><b>Opened</b><small>${esc([v('Opened'), v('Hour opened')].filter(Boolean).join(' · '))}</small></li>
        <li class="node mid"><i></i><b>${esc(contactsLabel)}</b><small>${esc(channel)}</small></li>
        <li class="node end"><i></i>${resolvedLabel}</li>
      </ol>
      <dl class="kv">
        ${field('Satisfaction', satisfaction)}
        ${field('Against target', slaState
          ? `<span class="status"><i style="background:${slaState === 'Missed' ? STATUS_OPEN : slaState === 'Met' ? STATUS_RESOLVED : '#86857c'}"></i>${esc(slaState)}</span>`
          : '')}
        ${field('Handling time', Number.isFinite(handling)
          ? `${handling.toFixed(0)} min<small class="muted"> of adviser time</small>`
          : '')}
      </dl>
    </section>
    ${contextBlock(ds, i, ctx, contextFields(ds))}
    ${actionsBlock(ds, esc)}
    </div>`;
};
