/** 0040：密钥进系统钥匙串，不进大脑文件。测试可注入内存实现。 */
export interface SecretStore {
  set: (id: string, value: string) => void;
  get: (id: string) => string;
  remove: (id: string) => void;
}

export function createMemorySecrets(): SecretStore {
  const map = new Map<string, string>();
  return {
    set(id, value) {
      if (value) map.set(id, value);
      else map.delete(id);
    },
    get(id) {
      return map.get(id) ?? '';
    },
    remove(id) {
      map.delete(id);
    },
  };
}

export function createSafeStorageSecrets(safeStorage: {
  isEncryptionAvailable: () => boolean;
  encryptString: (text: string) => Buffer;
  decryptString: (buf: Buffer) => string;
}, files: { read: (id: string) => Buffer | null; write: (id: string, buf: Buffer) => void; remove: (id: string) => void }): SecretStore {
  return {
    set(id, value) {
      if (!value) {
        files.remove(id);
        return;
      }
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('系统密钥库不可用');
      }
      files.write(id, safeStorage.encryptString(value));
    },
    get(id) {
      const buf = files.read(id);
      if (!buf) return '';
      try {
        return safeStorage.decryptString(buf);
      } catch {
        return '';
      }
    },
    remove(id) {
      files.remove(id);
    },
  };
}

export function stripKeys<T extends { apiKey: string }>(providers: T[]): T[] {
  return providers.map((p) => ({ ...p, apiKey: '' }));
}
