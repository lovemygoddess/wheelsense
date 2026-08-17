export type RelayVersionState =
  | 'UPDATE_AVAILABLE'
  | 'UP_TO_DATE'
  | 'DEVICE_NEWER_THAN_SERVER'
  | 'UNKNOWN_CURRENT_VERSION'
  | 'UNKNOWN_LATEST_VERSION';

export interface RelayVersionIdentity {
  versionName: string | null | undefined;
  versionCode: number | null | undefined;
}

/**
 * Compare Relay releases by versionCode only. A missing code is deliberately
 * not treated as zero and can never produce UPDATE_AVAILABLE.
 */
export function compareRelayVersions(
  current: RelayVersionIdentity,
  latest: RelayVersionIdentity,
): RelayVersionState {
  const latestCode = Number.isInteger(latest.versionCode) ? latest.versionCode! : null;
  const currentCode = Number.isInteger(current.versionCode) ? current.versionCode! : null;
  if (latestCode === null) return 'UNKNOWN_LATEST_VERSION';
  if (currentCode === null) return 'UNKNOWN_CURRENT_VERSION';
  if (latestCode > currentCode) return 'UPDATE_AVAILABLE';
  if (latestCode === currentCode) return 'UP_TO_DATE';
  return 'DEVICE_NEWER_THAN_SERVER';
}

export function relayVersionLabel(versionName: string | null | undefined, versionCode: number | null | undefined): string {
  if (!versionName && !Number.isInteger(versionCode)) return '—';
  if (!Number.isInteger(versionCode)) return versionName || '—';
  if (!versionName) return `build ${versionCode}`;
  return `${versionName} / ${versionCode}`;
}
