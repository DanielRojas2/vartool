import { execFile } from 'child_process';
import { promisify } from 'util';
import { isAllowedExternalUrl } from '../../shared/middleware/security.middleware.js';

const execFileAsync = promisify(execFile);

/**
 * Servicio Descargador de Videos de Instagram y Facebook (Stateless - Sin Base de Datos)
 * Devuelve todas las calidades MP4 disponibles para que el usuario elija la resolución deseada.
 */
export class DownloaderService {
  static detectPlatform(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string' || !isAllowedExternalUrl(rawUrl)) {
      return null;
    }
    try {
      const parsed = new URL(rawUrl.trim());
      const host = parsed.hostname.toLowerCase();
      if (host.includes('instagram.com') || host.includes('instagr.am')) {
        return 'instagram';
      }
      if (
        host.includes('facebook.com') ||
        host.includes('fb.watch') ||
        host.includes('fb.com')
      ) {
        return 'facebook';
      }
      return null;
    } catch {
      return null;
    }
  }

  static extractInstagramShortcode(url) {
    const match = url.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,32})/i);
    return match ? match[1] : null;
  }

  static decodeEscapedUrl(raw) {
    if (!raw) return null;
    return raw
      .replace(/\\u0026/g, '&')
      .replace(/\\u0025/g, '%')
      .replace(/\\u003d/g, '=')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&');
  }

  static async resolveVideoInfo(rawUrl) {
    const cleanUrl = (rawUrl || '').trim();
    if (cleanUrl.length > 512) {
      const err = new Error('El enlace proporcionado excede la longitud máxima permitida.');
      err.statusCode = 400;
      throw err;
    }

    const platform = this.detectPlatform(cleanUrl);
    if (!platform) {
      const err = new Error('Ingresa un enlace HTTPS válido de Instagram o Facebook.');
      err.statusCode = 400;
      throw err;
    }

    if (cleanUrl.includes('vartool-demo')) {
      return this.buildDemoResponse(platform, cleanUrl);
    }

    try {
      const ytdlpResult = await this.extractWithYtDlp(cleanUrl, platform);
      if (ytdlpResult && ytdlpResult.formats.length > 0) {
        return ytdlpResult;
      }
    } catch {
      // Continuar con extractor nativo
    }

    try {
      const nativeResult =
        platform === 'instagram'
          ? await this.extractInstagramNative(cleanUrl)
          : await this.extractFacebookNative(cleanUrl);

      if (nativeResult && nativeResult.formats.length > 0) {
        return nativeResult;
      }
    } catch {
      // Fallo controlado
    }

    const err = new Error(
      `No se pudo extraer el video de ${
        platform === 'instagram' ? 'Instagram' : 'Facebook'
      }. Verifica que la publicación sea pública y contenga un video.`
    );
    err.statusCode = 422;
    throw err;
  }

  static async extractWithYtDlp(url, platform) {
    const args = ['-m', 'yt_dlp', '-J', '--no-playlist', '--no-warnings', '--', url];
    const { stdout } = await execFileAsync('python', args, {
      timeout: 18000,
      maxBuffer: 5 * 1024 * 1024
    });

    const info = JSON.parse(stdout);
    const rawFormats = Array.isArray(info.formats) ? info.formats : [];

    const mp4Formats = rawFormats
      .filter((f) => f.url && isAllowedExternalUrl(f.url) && (f.ext === 'mp4' || (f.vcodec && f.vcodec !== 'none')))
      .map((f) => ({
        id: f.format_id || 'default',
        height: f.height || 0,
        hasAudio: Boolean(f.acodec && f.acodec !== 'none'),
        url: f.url
      }))
      .sort((a, b) => Number(b.hasAudio) - Number(a.hasAudio) || b.height - a.height);

    const selectedFormats = [];
    const seenHeights = new Set();

    for (const fmt of mp4Formats) {
      const h = fmt.height || 0;
      const key = h > 0 ? `${h}p` : 'original';
      if (seenHeights.has(key)) continue;
      seenHeights.add(key);

      const isHd = h >= 720 || h === 0;
      const tier = isHd ? 'HD' : 'SD';
      const label = h > 0 ? `${tier} ${h}p (MP4)` : 'Alta Calidad Original (MP4)';

      selectedFormats.push({
        label,
        quality: h > 0 ? `${h}p` : 'HD',
        tier,
        ext: 'mp4',
        url: fmt.url
      });
    }

    if (selectedFormats.length === 0 && info.url && isAllowedExternalUrl(info.url)) {
      selectedFormats.push({
        label: 'Alta Calidad Original (MP4)',
        quality: 'HD',
        tier: 'HD',
        ext: 'mp4',
        url: info.url
      });
    }

    return {
      platform,
      sourceUrl: url,
      title: info.title || info.description?.slice(0, 80) || `Video de ${platform}`,
      author: info.uploader || info.channel || (platform === 'instagram' ? 'Instagram' : 'Facebook'),
      duration: info.duration ? this.formatDuration(info.duration) : null,
      thumbnail: info.thumbnail && isAllowedExternalUrl(info.thumbnail) ? info.thumbnail : null,
      formats: selectedFormats
    };
  }

  static async extractInstagramNative(url) {
    const shortcode = this.extractInstagramShortcode(url);
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
    };

    const candidateUrls = [];
    if (shortcode) {
      candidateUrls.push(`https://www.instagram.com/p/${shortcode}/embed/captioned/`);
      candidateUrls.push(`https://www.instagram.com/p/${shortcode}/embed/`);
    }
    candidateUrls.push(url);

    let videoUrl = null;
    let sdVideoUrl = null;
    let thumbnail = null;
    let title = `Publicación de Instagram ${shortcode ? `(${shortcode})` : ''}`;
    let author = 'Instagram';

    for (const targetUrl of candidateUrls) {
      try {
        const res = await fetch(targetUrl, {
          headers,
          redirect: 'follow',
          signal: AbortSignal.timeout(10000)
        });
        if (!res.ok) continue;
        const html = await res.text();

        const videoMatches = [
          ...html.matchAll(/"video_url"\s*:\s*"([^"]+)"/g),
          ...html.matchAll(/\\"video_url\\"\s*:\s*\\"([^\\"]+)\\"/g),
          ...html.matchAll(/property="og:video(?::secure_url)?"\s+content="([^"]+)"/gi)
        ];

        for (const m of videoMatches) {
          const decoded = this.decodeEscapedUrl(m[1]);
          if (isAllowedExternalUrl(decoded)) {
            if (!videoUrl) {
              videoUrl = decoded;
            } else if (decoded !== videoUrl && !sdVideoUrl) {
              sdVideoUrl = decoded;
            }
          }
        }

        const thumbMatch =
          html.match(/"display_url"\s*:\s*"([^"]+)"/) ||
          html.match(/property="og:image"\s+content="([^"]+)"/i);
        if (thumbMatch && thumbMatch[1] && !thumbnail) {
          const decodedThumb = this.decodeEscapedUrl(thumbMatch[1]);
          if (isAllowedExternalUrl(decodedThumb)) {
            thumbnail = decodedThumb;
          }
        }

        const userMatch = html.match(/"username"\s*:\s*"([^"]+)"/);
        if (userMatch && userMatch[1]) {
          author = userMatch[1];
        }

        const titleMatch = html.match(/property="og:title"\s+content="([^"]+)"/i);
        if (titleMatch && titleMatch[1]) {
          title = this.decodeEscapedUrl(titleMatch[1]);
        }

        if (videoUrl) break;
      } catch {
        // Intentar siguiente candidato
      }
    }

    if (!videoUrl) {
      throw new Error('No se encontró stream MP4 público.');
    }

    const formats = [
      {
        label: 'Alta Definición HD (1080p MP4)',
        quality: '1080p',
        tier: 'HD',
        ext: 'mp4',
        url: videoUrl
      },
      {
        label: 'Definición Estándar SD (720p MP4)',
        quality: '720p',
        tier: 'SD',
        ext: 'mp4',
        url: sdVideoUrl || videoUrl
      }
    ];

    return {
      platform: 'instagram',
      sourceUrl: url,
      title,
      author,
      duration: null,
      thumbnail,
      formats
    };
  }

  static async extractFacebookNative(url) {
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
    };

    const res = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const html = await res.text();

    const hdMatch =
      html.match(/"browser_native_hd_url"\s*:\s*"([^"]+)"/) ||
      html.match(/"playable_url_quality_hd"\s*:\s*"([^"]+)"/) ||
      html.match(/hd_src\s*:\s*"([^"]+)"/);

    const sdMatch =
      html.match(/"browser_native_sd_url"\s*:\s*"([^"]+)"/) ||
      html.match(/"playable_url"\s*:\s*"([^"]+)"/) ||
      html.match(/sd_src\s*:\s*"([^"]+)"/) ||
      html.match(/property="og:video(?::secure_url)?"\s+content="([^"]+)"/i);

    const thumbMatch = html.match(/property="og:image"\s+content="([^"]+)"/i);
    const titleMatch = html.match(/property="og:title"\s+content="([^"]+)"/i);

    const formats = [];
    if (hdMatch && hdMatch[1]) {
      const hdUrl = this.decodeEscapedUrl(hdMatch[1]);
      if (isAllowedExternalUrl(hdUrl)) {
        formats.push({
          label: 'Alta Definición HD (1080p MP4)',
          quality: '1080p',
          tier: 'HD',
          ext: 'mp4',
          url: hdUrl
        });
      }
    }
    if (sdMatch && sdMatch[1]) {
      const sdUrl = this.decodeEscapedUrl(sdMatch[1]);
      if (isAllowedExternalUrl(sdUrl)) {
        formats.push({
          label: 'Definición Estándar SD (480p MP4)',
          quality: '480p',
          tier: 'SD',
          ext: 'mp4',
          url: sdUrl
        });
      }
    }

    if (formats.length === 1 && formats[0].tier === 'HD') {
      formats.push({
        label: 'Definición Estándar SD (480p MP4)',
        quality: '480p',
        tier: 'SD',
        ext: 'mp4',
        url: formats[0].url
      });
    }

    if (formats.length === 0) {
      throw new Error('No se encontraron pistas MP4 públicas.');
    }

    const decodedThumb = thumbMatch?.[1] ? this.decodeEscapedUrl(thumbMatch[1]) : null;

    return {
      platform: 'facebook',
      sourceUrl: url,
      title: titleMatch?.[1] ? this.decodeEscapedUrl(titleMatch[1]) : 'Video Público de Facebook',
      author: 'Facebook',
      duration: null,
      thumbnail: decodedThumb && isAllowedExternalUrl(decodedThumb) ? decodedThumb : null,
      formats
    };
  }

  static buildDemoResponse(platform, url) {
    const isIg = platform === 'instagram';
    return {
      platform,
      sourceUrl: url,
      title: isIg ? 'Publicación de Instagram' : 'Publicación de Facebook',
      author: isIg ? 'instagram' : 'facebook',
      duration: '00:15',
      thumbnail: null,
      isDemo: true,
      formats: [
        {
          label: 'Full HD 1080p (MP4)',
          quality: '1080p',
          tier: 'Full HD',
          ext: 'mp4',
          url: 'DEMO_STREAM_HD'
        },
        {
          label: 'HD 720p (MP4)',
          quality: '720p',
          tier: 'HD',
          ext: 'mp4',
          url: 'DEMO_STREAM_HD'
        },
        {
          label: 'SD 480p (MP4)',
          quality: '480p',
          tier: 'SD',
          ext: 'mp4',
          url: 'DEMO_STREAM_SD'
        },
        {
          label: 'Baja 360p (MP4)',
          quality: '360p',
          tier: 'Ahorro',
          ext: 'mp4',
          url: 'DEMO_STREAM_SD'
        }
      ]
    };
  }

  static formatDuration(seconds) {
    const sec = Math.round(Number(seconds) || 0);
    const mins = Math.floor(sec / 60);
    const rem = sec % 60;
    return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }
}
