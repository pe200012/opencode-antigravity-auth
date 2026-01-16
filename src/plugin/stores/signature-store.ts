import type { SignatureStore, SignedThinking, ThoughtBuffer } from '../core/streaming/types';

export function createSignatureStore(): SignatureStore {
  const store = new Map<string, SignedThinking>();

  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: SignedThinking) => {
      store.set(key, value);
    },
    has: (key: string) => store.has(key),
    delete: (key: string) => {
      store.delete(key);
    },
  };
}

export function createThoughtBuffer(): ThoughtBuffer {
  const buffer = new Map<number, string>();

  return {
    get: (index: number) => buffer.get(index),
    set: (index: number, text: string) => {
      buffer.set(index, text);
    },
    clear: () => buffer.clear(),
  };
}


/**
 * Store for associating tool_use IDs with thoughtSignatures.
 * When Gemini 3 returns a functionCall after a thinking block,
 * the signature must be preserved and sent back with subsequent requests.
 */
export interface ToolUseSignatureStore {
  get: (sessionKey: string, toolId: string) => string | undefined;
  set: (sessionKey: string, toolId: string, signature: string) => void;
  delete: (sessionKey: string, toolId: string) => void;
  clearForSession: (sessionKey: string) => void;
}

export function createToolUseSignatureStore(): ToolUseSignatureStore {
  const store = new Map<string, string>();

  const makeKey = (sessionKey: string, toolId: string) => `${sessionKey}:${toolId}`;

  return {
    get: (sessionKey: string, toolId: string) => store.get(makeKey(sessionKey, toolId)),
    set: (sessionKey: string, toolId: string, signature: string) => {
      store.set(makeKey(sessionKey, toolId), signature);
    },
    delete: (sessionKey: string, toolId: string) => {
      store.delete(makeKey(sessionKey, toolId));
    },
    clearForSession: (sessionKey: string) => {
      for (const key of store.keys()) {
        if (key.startsWith(`${sessionKey}:`)) {
          store.delete(key);
        }
      }
    },
  };
}

export const toolUseSignatureStore = createToolUseSignatureStore();

export const defaultSignatureStore = createSignatureStore();
