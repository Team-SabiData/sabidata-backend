// Erreurs HTTP métier (mappées en codes statut par les routes).
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(code);
  }
}
export const notFound = (code: string) => new HttpError(404, code);
export const conflict = (code: string) => new HttpError(409, code);
export const badRequest = (code: string) => new HttpError(400, code);
export const forbidden = (code: string) => new HttpError(403, code);
