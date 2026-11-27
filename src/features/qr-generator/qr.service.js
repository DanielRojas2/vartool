import QRCode from 'qrcode';

/**
 * Servicio Generador de QRs Permanentes (ISO/IEC 18004 Estático)
 * Codifica el contenido directamente en la matriz del QR sin URLs intermedias ni redirecciones.
 * Validación estricta de tamaño de entrada (OWASP Input Validation).
 */
export class QrService {
  static MAX_CONTENT_LENGTH = 1500;

  static normalizeOptions(options = {}) {
    const width = Math.min(Math.max(parseInt(options.width, 10) || 520, 200), 1200);
    const margin = Math.min(Math.max(parseInt(options.margin, 10) ?? 2, 1), 6);
    const errorCorrectionLevel = ['L', 'M', 'Q', 'H'].includes(options.errorCorrectionLevel)
      ? options.errorCorrectionLevel
      : 'M';
    const darkColor = /^#[0-9A-Fa-f]{6}$/.test(options.darkColor) ? options.darkColor : '#0f172a';
    const lightColor = /^#[0-9A-Fa-f]{6}$/.test(options.lightColor) ? options.lightColor : '#ffffff';

    return {
      width,
      margin,
      errorCorrectionLevel,
      color: {
        dark: darkColor,
        light: lightColor
      }
    };
  }

  static async generateDataUrl(content, options = {}) {
    if (!content || typeof content !== 'string' || !content.trim()) {
      const err = new Error('Ingresa un enlace o texto para generar el código QR.');
      err.statusCode = 400;
      throw err;
    }

    const cleanContent = content.trim();
    if (cleanContent.length > this.MAX_CONTENT_LENGTH) {
      const err = new Error(`El contenido excede el límite seguro de ${this.MAX_CONTENT_LENGTH} caracteres.`);
      err.statusCode = 400;
      throw err;
    }

    const qrOptions = this.normalizeOptions(options);
    const svgString = await QRCode.toString(cleanContent, {
      ...qrOptions,
      type: 'svg'
    });
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svgString, 'utf8').toString('base64')}`;

    return {
      dataUrl,
      svg: svgString,
      meta: {
        type: 'STATIC_DIRECT_ISO18004',
        expires: false,
        maxScans: 'UNLIMITED',
        encodedLength: cleanContent.length,
        errorCorrectionLevel: qrOptions.errorCorrectionLevel
      }
    };
  }
}
