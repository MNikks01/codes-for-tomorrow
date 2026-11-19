import argon2 from 'argon2';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export interface Argon2Options {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

/** OWASP Password Storage Cheat Sheet minimum for Argon2id (19 MiB, t=2, p=1). */
export const OWASP_ARGON2_OPTIONS: Argon2Options = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export class Argon2PasswordHasher implements PasswordHasher {
  constructor(private readonly options: Argon2Options = OWASP_ARGON2_OPTIONS) {}

  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id, ...this.options });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      // A malformed stored hash must never authenticate anyone.
      return false;
    }
  }
}
