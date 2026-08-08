class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function badRequest(code, message, details) {
  return new AppError(400, code, message, details);
}

function notFound(message = 'Resource not found.') {
  return new AppError(404, 'RESOURCE_NOT_FOUND', message);
}

module.exports = { AppError, badRequest, notFound };
