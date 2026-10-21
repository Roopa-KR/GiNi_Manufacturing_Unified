'use strict';
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}
const bad = (code, msg, details) => new AppError(400, code, msg, details);
const unauthorized = (msg = 'Not signed in') => new AppError(401, 'UNAUTHENTICATED', msg);
const forbidden = (msg = 'Not permitted', details) => new AppError(403, 'FORBIDDEN', msg, details);
const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
const conflict = (code, msg, details) => new AppError(409, code, msg, details);
const unprocessable = (code, msg, details) => new AppError(422, code, msg, details);
const unavailable = (code, msg, details) => new AppError(503, code, msg, details);

const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { AppError, bad, unauthorized, forbidden, notFound, conflict, unprocessable, unavailable, asyncH };
