/**
 * 领域错误：结构化拒绝原因。
 * CLI/API 捕获后可直接输出稳定 JSON（机器模式，docs/06），
 * 拒绝不再是一句无法分类的 Error 消息。
 */
export class DomainError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: string; message: string; details?: Record<string, unknown> } {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}
