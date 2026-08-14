import * as SecureStore from 'expo-secure-store';

const CREDENTIAL_KEY = 'ninebotAutoLoginCredentialV1';
const ENABLED_KEY = 'ninebotAutoLoginEnabledV1';

type StoredCredential = {
  account: string;
  password: string;
  enabled: boolean;
  blocked: boolean;
};

export type NinebotAutoLoginStatus = {
  enabled: boolean;
  ready: boolean;
  blocked: boolean;
  account: string | null;
};

async function read(): Promise<StoredCredential | null> {
  try {
    const raw = await SecureStore.getItemAsync(CREDENTIAL_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredCredential>;
    if (typeof value.account !== 'string' || typeof value.password !== 'string') return null;
    return {
      account: value.account,
      password: value.password,
      enabled: value.enabled === true,
      blocked: value.blocked === true,
    };
  } catch {
    return null;
  }
}

async function write(value: StoredCredential): Promise<void> {
  await SecureStore.setItemAsync(CREDENTIAL_KEY, JSON.stringify(value));
}

export async function getNinebotAutoLoginStatus(): Promise<NinebotAutoLoginStatus> {
  const value = await read();
  const enabled = await SecureStore.getItemAsync(ENABLED_KEY).catch(() => null) === '1';
  return {
    enabled,
    ready: !!value?.account && !!value?.password,
    blocked: value?.blocked === true,
    account: value?.account || null,
  };
}

/** Called only after a successful manual password login. */
export async function saveNinebotAutoLoginCredential(account: string, password: string): Promise<void> {
  await SecureStore.setItemAsync(ENABLED_KEY, '1');
  await write({ account, password, enabled: true, blocked: false });
}

export async function setNinebotAutoLoginEnabled(enabled: boolean): Promise<void> {
  const value = await read();
  if (!enabled) {
    // Turning the feature off removes the password, not merely the switch.
    await SecureStore.deleteItemAsync(CREDENTIAL_KEY);
    await SecureStore.deleteItemAsync(ENABLED_KEY);
    return;
  }
  await SecureStore.setItemAsync(ENABLED_KEY, '1');
  if (value) await write({ ...value, enabled: true, blocked: false });
}

export async function getNinebotAutoLoginCredential(): Promise<{ account: string; password: string } | null> {
  const value = await read();
  const enabled = await SecureStore.getItemAsync(ENABLED_KEY).catch(() => null) === '1';
  if (!enabled || !value?.enabled || value.blocked || !value.account || !value.password) return null;
  return { account: value.account, password: value.password };
}

/** Persistently stop retries after one failed automatic attempt. */
export async function blockNinebotAutoLogin(): Promise<void> {
  const value = await read();
  if (value) await write({ ...value, blocked: true });
}
