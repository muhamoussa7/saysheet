import { browser } from 'wxt/browser';
import type { RuntimeRequest, RuntimeResult } from './types';

export async function sendRuntimeMessage<T>(request: RuntimeRequest): Promise<T> {
  const result = (await browser.runtime.sendMessage(request)) as RuntimeResult<T>;
  if (!result?.ok) throw new Error(result?.error || 'The extension did not respond.');
  return result.data as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
