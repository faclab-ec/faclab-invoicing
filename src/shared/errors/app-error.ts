export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    // Required for correct instanceof checks when targeting CommonJS
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND';
}

export class BadRequestError extends AppError {
  readonly statusCode = 400;
  readonly code = 'BAD_REQUEST';
}

export class ValidationError extends AppError {
  readonly statusCode = 422;
  readonly code = 'VALIDATION_ERROR';
}

export class InternalError extends AppError {
  readonly statusCode = 500;
  readonly code = 'INTERNAL_ERROR';
}

export class ConflictError extends AppError {
  readonly statusCode = 409;

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Well-formed but not acceptable, with a code of its own (e.g. a certificate of another RUC) */
export class UnprocessableError extends AppError {
  readonly statusCode = 422;

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
