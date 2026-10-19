import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';

const SALT_BYTES = 16;
const DERIVED_KEY_BYTES = 64;

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, DERIVED_KEY_BYTES, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/** Store only a salted, memory-hard password hash. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derivedKey = await scrypt(password, salt);
  return `scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const parts = encodedHash.split('$');
  const algorithm = parts[0];
  const saltHex = parts[1];
  const derivedKeyHex = parts[2];
  if (parts.length !== 3 || algorithm !== 'scrypt' || !saltHex || !derivedKeyHex) return false;
  if (!/^[0-9a-f]{32}$/i.test(saltHex) || !/^[0-9a-f]{128}$/i.test(derivedKeyHex)) return false;

  const expected = Buffer.from(derivedKeyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
