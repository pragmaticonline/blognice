declare module "node:crypto" {
  export function pbkdf2(
    password: ArrayBufferView,
    salt: ArrayBufferView,
    iterations: number,
    keyLength: number,
    digest: string,
    callback: (error: Error | null, derivedKey: Uint8Array) => void,
  ): void;

  export function scrypt(
    password: ArrayBufferView,
    salt: ArrayBufferView,
    keyLength: number,
    options: {
      N: number;
      r: number;
      p: number;
      maxmem: number;
    },
    callback: (error: Error | null, derivedKey: Uint8Array) => void,
  ): void;
}
