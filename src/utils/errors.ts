// Every error surfaces as { error: { code, message } } per docs/03 conventions.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (code: string, message: string): ApiError =>
  new ApiError(400, code, message);

export const notFound = (code: string, message: string): ApiError =>
  new ApiError(404, code, message);

export const playerNotFound = (id: string): ApiError =>
  notFound("PLAYER_NOT_FOUND", `No player with id "${id}"`);

export const teamNotFound = (id: string): ApiError =>
  notFound("TEAM_NOT_FOUND", `No team with id "${id}"`);
