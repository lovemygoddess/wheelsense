/** Development-only audit signal for future pages/hooks. Keep this data
 * separate from UI so production screens never need to render it. */
export const DEMO_DATA_SOURCE = Object.freeze({
  vehicle: 'demo', battery: 'demo', trip: 'demo', relay: 'demo',
  monitor: 'demo', widget: 'demo',
} as const);

export function getDemoDataSourceDebug(): typeof DEMO_DATA_SOURCE {
  return DEMO_DATA_SOURCE;
}
