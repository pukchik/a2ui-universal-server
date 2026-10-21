export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const assert = (
  condition: unknown,
  code: string,
  message = code,
): asserts condition => {
  if (!condition) throw new AppError(422, code, message);
};
