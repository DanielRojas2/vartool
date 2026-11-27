import { Router } from 'express';
import { DownloaderService } from './downloader.service.js';
import { appConfig } from '../../config/app.config.js';
import {
  createRateLimiter,
  concurrencyLimiter,
  isAllowedExternalUrl
} from '../../shared/middleware/security.middleware.js';

const router = Router();
const MAX_STREAM_BYTES = 150 * 1024 * 1024; // Límite defensivo de 150 MB por stream

/**
 * POST /api/video/info
 * Analiza un enlace de Instagram o Facebook con Rate Limiting específico (Anti-DDoS).
 */
router.post(
  '/info',
  createRateLimiter({
    scope: 'video-info',
    windowMs: 60_000,
    maxRequests: appConfig.security.rateLimits.videoInfoPerMin
  }),
  async (req, res, next) => {
    try {
      const { url } = req.body;
      const videoInfo = await DownloaderService.resolveVideoInfo(url);
      res.json({
        ok: true,
        data: videoInfo
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/video/download
 * Proxy de transmisión directa con prevención de SSRF, límite de concurrencia por IP y corte por tamaño máximo.
 */
router.get(
  '/download',
  createRateLimiter({
    scope: 'video-download',
    windowMs: 60_000,
    maxRequests: appConfig.security.rateLimits.videoDownloadPerMin
  }),
  concurrencyLimiter(2),
  async (req, res, next) => {
    try {
      const { url, platform = 'video', quality = 'HD' } = req.query;
      if (!url || typeof url !== 'string') {
        const err = new Error('URL de transmisión no especificada.');
        err.statusCode = 400;
        throw err;
      }

      const safePlatform = String(platform).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'video';
      const safeQuality = String(quality).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'HD';
      const safeFilename = `vartool-${safePlatform}-${safeQuality}-${Date.now()}.mp4`;

      if (url === 'DEMO_STREAM_HD' || url === 'DEMO_STREAM_SD') {
        const demoMp4Hex =
          '00000018667479706d703432000000006d70343269736f6d000000086d646174';
        const buffer = Buffer.from(demoMp4Hex, 'hex');
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
        res.setHeader('Content-Length', String(buffer.length));
        return res.end(buffer);
      }

      // Validación estricta Anti-SSRF (solo dominios oficiales de Instagram/Facebook CDN sobre HTTPS)
      if (!isAllowedExternalUrl(url)) {
        const err = new Error('Dominio de origen no autorizado por políticas de seguridad.');
        err.statusCode = 403;
        throw err;
      }

      const upstream = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'video/mp4,video/*;q=0.9,*/*;q=0.8',
          Referer: url.includes('fbcdn') ? 'https://www.facebook.com/' : 'https://www.instagram.com/'
        },
        signal: AbortSignal.timeout(20000)
      });

      if (!upstream.ok || !upstream.body) {
        const err = new Error('No se pudo obtener el flujo de video desde el servidor de origen.');
        err.statusCode = 502;
        throw err;
      }

      const contentLength = Number(upstream.headers.get('content-length') || 0);
      if (contentLength > MAX_STREAM_BYTES) {
        const err = new Error('El archivo excede el tamaño máximo permitido.');
        err.statusCode = 413;
        throw err;
      }

      // En Vercel Serverless el límite de respuesta por función es 4.5 MB; si el video supera 4 MB redirigimos directo al CDN oficial validado
      if (process.env.VERCEL && contentLength > 4 * 1024 * 1024) {
        upstream.body.cancel().catch(() => {});
        return res.redirect(302, url);
      }

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
      if (contentLength > 0) {
        res.setHeader('Content-Length', String(contentLength));
      }

      const reader = upstream.body.getReader();
      let transferredBytes = 0;

      req.on('close', () => {
        reader.cancel().catch(() => {});
      });

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          break;
        }
        transferredBytes += value.byteLength;
        if (transferredBytes > MAX_STREAM_BYTES) {
          await reader.cancel();
          res.destroy();
          break;
        }
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
    } catch (error) {
      next(error);
    }
  }
);

export default router;
