import { Router } from 'express';
import { QrService } from './qr.service.js';

const router = Router();

/**
 * POST /api/qr/generate
 * Genera un código QR estático permanente en PNG (DataURL) y SVG vectorial.
 */
router.post('/generate', async (req, res, next) => {
  try {
    const { content, width, margin, errorCorrectionLevel, darkColor, lightColor } = req.body;
    const result = await QrService.generateDataUrl(content, {
      width,
      margin,
      errorCorrectionLevel,
      darkColor,
      lightColor
    });

    res.json({
      ok: true,
      ...result
    });
  } catch (error) {
    next(error);
  }
});

export default router;
