'use strict';
const { config } = require('../config/env');

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route ${req.method} ${req.path}` } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let status = err.status || err.statusCode || 500;
  let code = err.code && typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR';
  let message = err.message || 'Unexpected error';
  if (err.code === 11000) { status = 409; code = 'DUPLICATE'; message = 'Duplicate business key'; }
  const labels = typeof err.hasErrorLabel === 'function' ? err : null;
  if (['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError', 'MongoTopologyClosedError', 'MongoNotConnectedError', 'MongoPoolClearedError'].includes(err.name)
      || (labels && labels.hasErrorLabel('TransientTransactionError'))) {
    status = 503; code = 'DATABASE_UNAVAILABLE'; message = 'Database temporarily unavailable - your change was not saved; retry';
  } else if (labels && labels.hasErrorLabel('UnknownTransactionCommitResult')) {
    // the commit may or may not have been applied: the client retries with the SAME Idempotency-Key, which replays a committed result
    status = 503; code = 'COMMIT_OUTCOME_UNKNOWN'; message = 'The database did not confirm the save - retry the same action; it will not be applied twice';
  }
  if (err.type === 'entity.too.large') { status = 413; code = 'PAYLOAD_TOO_LARGE'; }
  if (err.type === 'entity.parse.failed') { status = 400; code = 'INVALID_JSON'; }
  if (status >= 500) {
    console.error(`[api] ${req.method} ${req.path} -> ${status} ${code}: ${err.stack || message}`);
    if (config().isProd && code === 'INTERNAL_ERROR') message = 'Unexpected server error';
  }
  res.status(status).json({ error: { code, message, details: err.details } });
}

module.exports = { notFoundHandler, errorHandler };
