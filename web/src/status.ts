/**
 * Save-status presentation, kept free of DOM access so tests can assert that
 * saving, saved and failed-to-save are each visibly distinct — different
 * words, different icon and a different tone class, never colour alone.
 */

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';

export interface SavePresentation {
  /** Text shown next to the icon; also announced politely to screen readers. */
  label: string;
  /** Decorative glyph rendered beside the label. */
  icon: string;
  /** Style hook: pill-neutral | pill-pending | pill-ok | pill-danger. */
  tone: 'neutral' | 'pending' | 'ok' | 'danger';
}

export function savePresentation(status: SaveStatus, detail = ''): SavePresentation {
  switch (status) {
    case 'saving':
      return { label: 'Saving…', icon: '⟳', tone: 'pending' };
    case 'saved':
      return { label: 'Saved', icon: '✓', tone: 'ok' };
    case 'failed':
      return { label: detail || 'Failed to save — your draft is kept on this device', icon: '⚠', tone: 'danger' };
    default:
      return { label: 'No unsaved changes', icon: '·', tone: 'neutral' };
  }
}
