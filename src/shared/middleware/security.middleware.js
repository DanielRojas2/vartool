/**
 * Controles de Seguridad alineados con OWASP Top 10 e ISO/IEC 27001
 * - A.8.6 / OWASP API4: Limitación de tasa (Rate Limiting) y control de concurrencia contra DDoS.
 * - A.8.26 / OWASP A05: Cabeceras de seguridad HTTP estrictas (CSP, HSTS, X-Frame-Options, nosniff).
 * - A.8.28 / OWASP A10: Prevención de SSRF mediante validación de dominios permitidos y bloqueo de IPs privadas.
 * - A.8.15 / OWASP A09: Registro de eventos de seguridad sin almacenar datos personales (Stateless).
 */

const ipBuckets = new Map();
const activeStreamsPerIp = new Map();

// Limpieza periódica de memoria para evitar agotamiento de RAM durante ataques de inundación de IPs
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of ipBuckets.entries()) {
    if (now > bucket.resetAt) {
      ipBuckets.delete(key);
    }
  }
}, 60_000).unref();

export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Middleware de Cabeceras de Seguridad HTTP (OWASP A05 / ISO 27001 A.8.26)
 */
export function securityHeaders(_req, res, next) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' https://pagead2.googlesyndication.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "media-src 'self' https:",
      "frame-src https://googleads.g.doubleclick.net https://tpc.googlesyndication.com",
      "connect-src 'self' https://pagead2.googlesyndication.com",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'"
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

/**
 * Middleware de Tiempo Máximo de Solicitud contra ataques Slowloris
 */
export function requestTimeout(timeoutMs = 25_000) {
  return (req, res, next) => {
    req.setTimeout(timeoutMs, () => {
      if (!res.headersSent) {
        res.status(408).json({
          ok: false,
          error: 'Tiempo de espera agotado para la solicitud.'
        });
      }
    });
    res.setTimeout(timeoutMs, () => {
      if (!res.headersSent) {
        res.status(504).json({
          ok: false,
          error: 'La operación excedió el tiempo límite permitido.'
        });
      }
    });
    next();
  };
}

/**
 * Generador de Rate Limiter por ventana deslizante (Mitigación DDoS / Fuerza Bruta)
 */
export function createRateLimiter({ scope = 'global', windowMs = 60_000, maxRequests = 60 } = {}) {
  return (req, res, next) => {
    const ip = getClientIp(req);
    const key = `${scope}:${ip}`;
    const now = Date.now();

    // Límite defensivo máximo de entradas en memoria
    if (ipBuckets.size > 50_000 && !ipBuckets.has(key)) {
      return res.status(503).json({
        ok: false,
        error: 'Servidor temporalmente ocupado. Intente nuevamente en unos segundos.'
      });
    }

    let bucket = ipBuckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      ipBuckets.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, maxRequests - bucket.count);
    const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);

    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(retryAfterSec));

    if (bucket.count > maxRequests) {
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        ok: false,
        error: 'Demasiadas solicitudes desde esta dirección. Por favor espera unos segundos.'
      });
    }

    next();
  };
}

/**
 * Limitador de descargas simultáneas por IP para evitar saturación de ancho de banda
 */
export function concurrencyLimiter(maxConcurrent = 2) {
  return (req, res, next) => {
    const ip = getClientIp(req);
    const current = activeStreamsPerIp.get(ip) || 0;

    if (current >= maxConcurrent) {
      return res.status(429).json({
        ok: false,
        error: 'Ya tienes descargas activas en curso. Espera a que finalicen.'
      });
    }

    activeStreamsPerIp.set(ip, current + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const count = activeStreamsPerIp.get(ip) || 1;
      if (count <= 1) {
        activeStreamsPerIp.delete(ip);
      } else {
        activeStreamsPerIp.set(ip, count - 1);
      }
    };

    res.on('finish', release);
    res.on('close', release);
    next();
  };
}

/**
 * Prevención de SSRF (OWASP A10:2021)
 * Valida que las URLs externas pertenezcan estrictamente a dominios autorizados de Instagram/Facebook y sus CDNs.
 */
const ALLOWED_MEDIA_DOMAINS = [
  'instagram.com',
  'instagr.am',
  'cdninstagram.com',
  'facebook.com',
  'fb.com',
  'fb.watch',
  'fbcdn.net',
  'fbsbx.com'
];

export function isAllowedExternalUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.length > 2048) {
    return false;
  }

  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:') {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();

    // Bloquear localhost, IPs literales privadas o de bucle invertido
    if (
      hostname === 'localhost' ||
      /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(hostname) ||
      hostname.startsWith('[') ||
      hostname.includes('::')
    ) {
      return false;
    }

    return ALLOWED_MEDIA_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}
