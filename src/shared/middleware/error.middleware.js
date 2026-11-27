export function errorHandler(err, req, res, _next) {
  const statusCode = err?.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
  const safeMessage =
    statusCode < 500 && typeof err?.message === 'string'
      ? err.message
      : 'No se pudo procesar la solicitud en este momento.';

  console.error(`[Vartool Security/Error] ${req.method} ${req.originalUrl} (${statusCode})`);

  if (res.headersSent) {
    return;
  }

  res.status(statusCode).json({
    ok: false,
    error: safeMessage
  });
}
