/**
 * 对外公开编码：固定 20 位、无实体前缀、大小写敏感的 Crockford Base32。
 *
 * 数据库内部使用 bigint identity 主键；该编码只用于 URL、API、CLI 和界面展示。
 * 20 个 Base32 字符提供 100 bit 随机空间。
 */
export const PUBLIC_CODE_LENGTH = 20;
export const PUBLIC_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PUBLIC_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{20}$/;
export const PUBLIC_CODE_BYTE_LENGTH = 13;

export function isPublicCode(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_CODE_PATTERN.test(value);
}

/**
 * 将至少 100 bit 的随机字节编码为公开编码。随机源由调用方提供，避免共享契约包绑定 Node API。
 */
export function publicCodeFromBytes(bytes: Uint8Array): string {
  if (bytes.length < PUBLIC_CODE_BYTE_LENGTH) {
    throw new RangeError(`公开编码至少需要 ${PUBLIC_CODE_BYTE_LENGTH} 个随机字节`);
  }

  let buffer = 0;
  let bits = 0;
  let result = '';

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;

    while (bits >= 5 && result.length < PUBLIC_CODE_LENGTH) {
      bits -= 5;
      result += PUBLIC_CODE_ALPHABET[(buffer >>> bits) & 31];
      buffer &= (1 << bits) - 1;
    }

    if (result.length === PUBLIC_CODE_LENGTH) return result;
  }

  throw new RangeError('随机字节不足以生成公开编码');
}
