/**
 * Fault injection for manual and automated testing. The only supported fault
 * is `failSaves`, armed by opening the app with `?failSaves=1`; without that
 * exact query parameter every fault stays inert and the app behaves normally.
 */

export const faults = { failSaves: false };

/** Arms faults from a location search string, e.g. `?failSaves=1`. */
export function armFaultsFromQuery(search: string): void {
  faults.failSaves = new URLSearchParams(search).get('failSaves') === '1';
}
