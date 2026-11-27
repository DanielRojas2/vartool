import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { appConfig } from './config/app.config.js';
import { errorHandler } from './shared/middleware/error.middleware.js';
import {
  securityHeaders,
  requestTimeout,
  createRateLimiter
} from './shared/middleware/security.middleware.js';
import qrRoutes from './features/qr-generator/qr.routes.js';
import downloaderRoutes from './features/video-downloader/downloader.routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Ocultar firma del servidor (OWASP A05 Security Misconfiguration)
app.disable('x-powered-by');

// Cabeceras HTTP de seguridad (ISO 27001 A.8.26 / OWASP)
app.use(securityHeaders);

// Tiempo límite de solicitud contra ataques Slowloris
app.use(requestTimeout(appConfig.security.requestTimeoutMs));

// Limitador global de solicitudes por IP (Anti-DDoS)
app.use(
  createRateLimiter({
    scope: 'global',
    windowMs: 60_000,
    maxRequests: appConfig.security.rateLimits.globalPerMin
  })
);

// Límite estricto de tamaño de payload JSON (16 KB)
app.use(express.json({ limit: appConfig.security.jsonLimit, strict: true }));
app.use(express.urlencoded({ extended: false, limit: appConfig.security.jsonLimit }));

// Endpoint de configuración pública
app.get('/api/config', (_req, res) => {
  res.json({
    ok: true,
    appName: appConfig.appName,
    adsense: appConfig.adsense
  });
});

// Favicon SVG oficial con la paleta McLaren (#FF3300 y #FFFFFF) para evitar 404 en /favicon.ico y /favicon.svg
const VARTOOL_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#FF3300"/>
  <path d="M18 16h9.2L32 36.8 36.8 16H46L36.2 48h-8.4L18 16z" fill="#FFFFFF"/>
</svg>`;

app.get(['/favicon.ico', '/favicon.svg'], (_req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(VARTOOL_FAVICON_SVG);
});

// Endpoints SEO Técnicos: robots.txt, sitemap.xml multilingüe (ES, EN, RU, ZH) y ads.txt para Google AdSense
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain');
  res.send(
    [
      'User-agent: *',
      'Allow: /',
      'Disallow: /api/',
      '',
      'User-agent: Mediapartners-Google',
      'Allow: /',
      '',
      `Sitemap: ${appConfig.siteUrl}/sitemap.xml`
    ].join('\n')
  );
});

app.get('/ads.txt', (_req, res) => {
  const pubId = appConfig.adsense.clientId.replace(/^ca-/, '');
  res.type('text/plain');
  res.send(`google.com, ${pubId}, DIRECT, f08c47fec0942fa0\n`);
});

app.get('/sitemap.xml', (_req, res) => {
  const base = appConfig.siteUrl;
  const langs = ['es', 'en', 'ru', 'zh'];
  const today = new Date().toISOString().split('T')[0];

  const alternateLinks = langs
    .map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${base}/?lang=${l}"/>`)
    .concat(`    <xhtml:link rel="alternate" hreflang="x-default" href="${base}/"/>`)
    .join('\n');

  const urls = langs
    .map(
      (l) => `  <url>
    <loc>${base}/?lang=${l}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
${alternateLinks}
  </url>`
    )
    .join('\n');

  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>`);
});

// Rutas modulares orientadas a funcionalidad
app.use(
  '/api/qr',
  createRateLimiter({
    scope: 'qr',
    windowMs: 60_000,
    maxRequests: appConfig.security.rateLimits.qrPerMin
  }),
  qrRoutes
);

app.use('/api/video', downloaderRoutes);

// Opciones de archivos estáticos con validación fresca para evitar caché obsoleta
const staticOptions = {
  etag: true,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
};

app.use(
  '/features/qr-generator/client',
  express.static(path.join(__dirname, 'features/qr-generator/client'), staticOptions)
);
app.use(
  '/features/video-downloader/client',
  express.static(path.join(__dirname, 'features/video-downloader/client'), staticOptions)
);
app.use(
  '/features/monetization/client',
  express.static(path.join(__dirname, 'features/monetization/client'), staticOptions)
);

app.use(express.static(path.join(__dirname, 'shared/public'), staticOptions));

// Fallback SPA (evitando devolver HTML cuando se solicita un archivo estático .css o .js)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || /\.(css|js|png|jpg|jpeg|svg|ico|webp|woff2?)$/i.test(req.path)) {
    return res.status(404).json({ ok: false, error: 'Recurso no encontrado.' });
  }
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'shared/public/index.html'));
});

app.use(errorHandler);

if (!process.env.VERCEL) {
  app.listen(appConfig.port, () => {
    console.log(`[Vartool] Servidor activo en http://localhost:${appConfig.port}`);
    console.log(`[Vartool] SEO Multilingue (ES, EN, RU, ZH) + 3 Slots AdSense + Seguridad OWASP/ISO 27001`);
  });
}

export default app;
