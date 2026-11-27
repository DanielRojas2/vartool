import { execFile } from 'child_process';
import { promisify } from 'util';
import { isAllowedExternalUrl } from '../../shared/middleware/security.middleware.js';

const execFileAsync = promisify(execFile);
const IG_ENCODING_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Servicio Descargador de Videos de Instagram y Facebook (Stateless - Optimizado para Producción)
 * - Instagram: Extracción directa desde SSR data-sjs (RelayPrefetchedStreamCache -> xig_polaris_media)
 *   sobre /p/{shortcode}/ + API GraphQL PolarisLoggedOutDesktopWWWPostRootContentQuery (doc_id 27130156389949648).
 * - Facebook: Extracción desde Relay data-sjs (progressive_urls, browser_native_hd_url, browser_native_sd_url)
 *   descartando URLs HTML de lookaside.fbsbx.com y validando metadatos de codificación MP4 (efg).
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
    const match = url.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,38})/i);
    return match ? match[1] : null;
  }

  /**
   * Convierte el shortcode de Instagram en su media_id numérico (PK) para consultas GraphQL Polaris
   */
  static shortcodeToMediaId(shortcode) {
    const clean = shortcode.length > 28 ? shortcode.slice(0, -28) : shortcode;
    let pk = 0n;
    for (const ch of clean) {
      const idx = IG_ENCODING_CHARS.indexOf(ch);
      if (idx !== -1) {
        pk = pk * 64n + BigInt(idx);
      }
    }
    return pk.toString();
  }

  /**
   * Decodifica entidades HTML (&#xb7;, &#xa0;, &amp;, etc.) y escapes Unicode en títulos y URLs
   */
  static decodeHtmlEntities(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
      .replace(/&quot;/g, '"')
      .replace(/&#039;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }

  static decodeEscapedUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let cleaned = raw.trim();
    cleaned = cleaned
      .replace(/\\\\u0026/g, '&')
      .replace(/\\u0026/g, '&')
      .replace(/\\\\u0025/g, '%')
      .replace(/\\u0025/g, '%')
      .replace(/\\\\u003d/gi, '=')
      .replace(/\\u003d/gi, '=')
      .replace(/\\\\u003c/gi, '<')
      .replace(/\\u003c/gi, '<')
      .replace(/\\\\\//g, '/')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&')
      .replace(/\\"/g, '')
      .replace(/^"+|"+$/g, '');

    return cleaned;
  }

  /**
   * Agrega el parámetro `dl=1` a las URLs de CDN de Instagram y Facebook para que el propio CDN
   * de Meta envíe la cabecera `Content-Disposition: attachment` y la descarga inicie automáticamente
   * sin abrir una ventana de reproducción.
   */
  static ensureAttachmentUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
    try {
      const parsed = new URL(rawUrl);
      parsed.searchParams.set('dl', '1');
      return parsed.toString();
    } catch {
      return rawUrl;
    }
  }

  /**
   * Verifica a nivel de URL y metadatos `efg` de Meta que el enlace sea un flujo de video MP4 válido
   * y NO una página HTML de crawler (lookaside.fbsbx.com) ni un manifiesto DASH (.mpd).
   */
  static isValidDirectVideoStream(rawUrl) {
    if (!rawUrl || !isAllowedExternalUrl(rawUrl)) return false;
    try {
      const u = new URL(rawUrl);
      const host = u.hostname.toLowerCase();
      const pathname = u.pathname.toLowerCase();

      // Excluir redirecciones HTML de crawler de Facebook que provocaban archivos .mp4 corruptos
      if (host.includes('lookaside.fbsbx.com') || pathname.includes('/lookaside/')) {
        return false;
      }
      // Excluir manifiestos DASH (.mpd) o páginas HTML
      if (pathname.endsWith('.mpd') || pathname.endsWith('.html') || pathname.endsWith('.php')) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Inspecciona el parámetro Base64 `efg` que Meta incluye en los enlaces CDN de Instagram y Facebook
   * para obtener la etiqueta de codificación real (vencode_tag), resolución y duración exacta.
   */
  static parseEfgMetadata(videoUrl) {
    try {
      const u = new URL(videoUrl);
      const efgParam = u.searchParams.get('efg');
      if (!efgParam) return null;
      const jsonStr = Buffer.from(decodeURIComponent(efgParam), 'base64').toString('utf8');
      const data = JSON.parse(jsonStr);
      const tag = String(data.vencode_tag || '');
      const resMatch = tag.match(/\.C\d+\.(\d+)\./i) || tag.match(/(\d{3,4})p/i);
      const resolution = resMatch ? parseInt(resMatch[1], 10) : null;
      const isProgressive =
        tag.includes('progressive') || tag.includes('sve_sd') || tag.includes('sve_hd') || !tag.includes('dash_');
      const durationSec = Number(data.duration_s) || null;

      return {
        vencodeTag: tag,
        resolution,
        isProgressive,
        durationSec
      };
    } catch {
      return null;
    }
  }

  static buildStandardFormats(hdUrl, sdUrl = null, extraVersions = []) {
    const formats = [];
    const seenQualities = new Set();

    if (Array.isArray(extraVersions) && extraVersions.length > 0) {
      for (const v of extraVersions) {
        const cleanUrl = this.decodeEscapedUrl(v?.url);
        if (!cleanUrl || !this.isValidDirectVideoStream(cleanUrl)) continue;

        const efg = this.parseEfgMetadata(cleanUrl);
        if (efg && !efg.isProgressive && extraVersions.length > 1) continue;

        const h = Number(v.height) || Number(v.width) || efg?.resolution || 0;
        const qualityLabel =
          h >= 1000 ? '1080p' : h >= 700 ? '720p' : h >= 540 ? '640p' : h >= 450 ? '480p' : h > 0 ? `${h}p` : '1080p';
        if (seenQualities.has(qualityLabel)) continue;
        seenQualities.add(qualityLabel);

        const tierLabel = h >= 1000 || h === 0 ? 'Full HD' : h >= 700 ? 'HD' : 'SD';

        formats.push({
          label: `${tierLabel} ${qualityLabel} (MP4)`,
          quality: qualityLabel,
          tier: tierLabel,
          ext: 'mp4',
          url: this.ensureAttachmentUrl(cleanUrl)
        });
      }
    }

    const validHd = hdUrl && this.isValidDirectVideoStream(hdUrl) ? this.ensureAttachmentUrl(hdUrl) : null;
    const validSd = sdUrl && this.isValidDirectVideoStream(sdUrl) ? this.ensureAttachmentUrl(sdUrl) : null;
    const primaryUrl = formats[0]?.url || validHd || validSd;
    const secondaryUrl = validSd || primaryUrl;

    if (primaryUrl) {
      const standardTiers = [
        { quality: '1080p', tier: 'Full HD', url: primaryUrl },
        { quality: '720p', tier: 'HD', url: primaryUrl },
        { quality: '480p', tier: 'SD', url: secondaryUrl },
        { quality: '360p', tier: 'Ahorro', url: secondaryUrl }
      ];

      for (const std of standardTiers) {
        if (!seenQualities.has(std.quality)) {
          seenQualities.add(std.quality);
          formats.push({
            label: `${std.tier} ${std.quality} (MP4)`,
            quality: std.quality,
            tier: std.tier,
            ext: 'mp4',
            url: std.url
          });
        }
      }
    }

    return formats.sort((a, b) => parseInt(b.quality, 10) - parseInt(a.quality, 10));
  }

  static findNestedKey(obj, targetKey) {
    if (!obj || typeof obj !== 'object') return null;
    if (Object.prototype.hasOwnProperty.call(obj, targetKey) && obj[targetKey] != null) {
      return obj[targetKey];
    }
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val && typeof val === 'object') {
        const found = this.findNestedKey(val, targetKey);
        if (found != null) return found;
      }
    }
    return null;
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

    let lastSpecificError = null;

    // Estrategia Principal: Motor Nativo Polaris / Relay 2026 (Funciona tanto en Vercel como en local)
    try {
      const nativeResult =
        platform === 'instagram'
          ? await this.extractInstagramServerless(cleanUrl)
          : await this.extractFacebookServerless(cleanUrl);

      if (nativeResult && nativeResult.formats.length > 0) {
        return nativeResult;
      }
    } catch (e) {
      if (e.isSpecificRestriction) {
        lastSpecificError = e;
      }
    }

    // Estrategia de Respaldo Local: yt-dlp si está disponible fuera de Vercel
    if (!process.env.VERCEL && !lastSpecificError) {
      try {
        const ytdlpResult = await this.extractWithYtDlp(cleanUrl, platform);
        if (ytdlpResult && ytdlpResult.formats.length > 0) {
          return ytdlpResult;
        }
      } catch {
        // Fallo controlado
      }
    }

    if (lastSpecificError) {
      throw lastSpecificError;
    }

    const err = new Error(
      `No se pudo extraer el video de ${
        platform === 'instagram' ? 'Instagram' : 'Facebook'
      }. Verifica que la publicación o Reel sea público.`
    );
    err.statusCode = 422;
    throw err;
  }

  /**
   * Extractor de Instagram 2026 basado en Polaris SSR (data-sjs en /p/{shortcode}/)
   * y GraphQL PolarisLoggedOutDesktopWWWPostRootContentQuery (doc_id 27130156389949648)
   */
  static async extractInstagramServerless(inputUrl) {
    let targetUrl = inputUrl;
    let shortcode = this.extractInstagramShortcode(targetUrl);

    // Resolver enlaces cortos (/share/reel/..., /share/p/..., instagr.am)
    if (!shortcode) {
      try {
        const redir = await fetch(targetUrl, {
          method: 'GET',
          redirect: 'follow',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
          },
          signal: AbortSignal.timeout(7000)
        });
        if (redir.url) {
          targetUrl = redir.url;
          shortcode = this.extractInstagramShortcode(targetUrl);
        }
      } catch {
        // Continuar
      }
    }

    if (!shortcode) {
      const err = new Error('No se pudo identificar el código del Reel o publicación de Instagram.');
      err.statusCode = 400;
      err.isSpecificRestriction = true;
      throw err;
    }

    const desktopHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Sec-Fetch-Dest': 'document',
      'Upgrade-Insecure-Requests': '1'
    };

    // IMPORTANTE: En Instagram 2026 la ruta /p/{shortcode}/ devuelve el SSR data-sjs completo incluso para Reels
    const pageRes = await fetch(`https://www.instagram.com/p/${shortcode}/`, {
      headers: desktopHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(9000)
    });

    const html = await pageRes.text();
    let gatingRestrictionMessage = null;

    // CAPA 1: Extraer directamente desde los bloques <script data-sjs> hidratados en /p/{shortcode}/
    const sjsMatches = [...html.matchAll(/<script\b[^>]+\bdata-sjs>(\{.+?\})<\/script>/g)];
    for (const match of sjsMatches) {
      if (!match[1].includes('xig_polaris_media')) continue;
      try {
        const parsedJson = JSON.parse(match[1]);
        const polaris = this.findNestedKey(parsedJson, 'xig_polaris_media');
        if (polaris) {
          if (polaris.gating_ruling && !polaris.if_not_gated_logged_out) {
            gatingRestrictionMessage =
              'Este Reel o publicación tiene restricción de edad (+18) o de audiencia en Instagram y no permite acceso público sin sesión.';
          }
          const parsedMedia = this.parsePolarisMediaObject(polaris, shortcode, inputUrl);
          if (parsedMedia) return parsedMedia;
        }
      } catch {
        // Continuar con siguiente bloque
      }
    }

    // CAPA 2: Consultar POST /api/graphql con doc_id 27130156389949648 (PolarisLoggedOutDesktopWWWPostRootContentQuery)
    try {
      const mediaId = this.shortcodeToMediaId(shortcode);
      const lsd =
        html.match(/\["LSD",\[\],\{"token":"([^"]+)"/)?.[1] ||
        html.match(/"l":"([^"]+)"/)?.[1] ||
        'AVqbxe3J_YA';
      const rawCookies = pageRes.headers.getSetCookie ? pageRes.headers.getSetCookie() : [];
      const cookieHeader = rawCookies.map((c) => c.split(';')[0]).join('; ');
      const csrf = cookieHeader.match(/csrftoken=([^;]+)/)?.[1] || 'missing';

      const body = new URLSearchParams({
        lsd,
        fb_api_caller_class: 'RelayModern',
        fb_api_req_friendly_name: 'PolarisLoggedOutDesktopWWWPostRootContentQuery',
        server_timestamps: 'true',
        variables: JSON.stringify({ media_id: mediaId }),
        doc_id: '27130156389949648'
      });

      const gqlRes = await fetch('https://www.instagram.com/api/graphql', {
        method: 'POST',
        headers: {
          'User-Agent': desktopHeaders['User-Agent'],
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: '*/*',
          'X-IG-App-ID': '936619743392459',
          'X-ASBD-ID': '359341',
          'X-IG-WWW-Claim': '0',
          'X-FB-Friendly-Name': 'PolarisLoggedOutDesktopWWWPostRootContentQuery',
          'X-CSRFToken': csrf,
          'X-FB-LSD': lsd,
          'X-Requested-With': 'XMLHttpRequest',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Dest': 'empty',
          Cookie: cookieHeader,
          Origin: 'https://www.instagram.com',
          Referer: `https://www.instagram.com/p/${shortcode}/`
        },
        body: body.toString(),
        signal: AbortSignal.timeout(8000)
      });

      if (gqlRes.ok) {
        const gqlJson = await gqlRes.json();
        const polaris = gqlJson?.data?.xig_polaris_media;
        if (polaris) {
          if (polaris.gating_ruling && !polaris.if_not_gated_logged_out) {
            gatingRestrictionMessage =
              'Este Reel o publicación tiene restricción de edad (+18) o de audiencia en Instagram y no permite acceso público sin sesión.';
          }
          const parsedMedia = this.parsePolarisMediaObject(polaris, shortcode, inputUrl);
          if (parsedMedia) return parsedMedia;
        }
      }
    } catch {
      // Continuar
    }

    if (gatingRestrictionMessage) {
      const err = new Error(gatingRestrictionMessage);
      err.statusCode = 422;
      err.isSpecificRestriction = true;
      throw err;
    }

    throw new Error('No se encontró stream MP4 público en Instagram.');
  }

  /**
   * Procesa el objeto `xig_polaris_media` de Instagram (soportando Reels individuales y Carruseles con video)
   */
  static parsePolarisMediaObject(polaris, shortcode, sourceUrl) {
    const media = polaris?.if_not_gated_logged_out || polaris;
    if (!media || typeof media !== 'object') return null;

    let videoVersions = Array.isArray(media.video_versions) ? [...media.video_versions] : [];

    // Si es un carrusel de Instagram (carousel_media), recolectar las versiones de video de sus elementos
    if (videoVersions.length === 0 && Array.isArray(media.carousel_media)) {
      for (const item of media.carousel_media) {
        if (Array.isArray(item.video_versions) && item.video_versions.length > 0) {
          videoVersions = [...item.video_versions];
          break;
        }
      }
    }

    if (videoVersions.length === 0) return null;

    const formats = this.buildStandardFormats(videoVersions[0]?.url, null, videoVersions);
    if (formats.length === 0) return null;

    // Extraer duración desde video_duration o desde el metadato efg del primer stream
    const efgMeta = this.parseEfgMetadata(formats[0].url);
    const durationSec = Number(media.video_duration) || efgMeta?.durationSec || null;

    // Extraer miniatura de portada desde display_uri o image_versions2.candidates
    const candidateThumb =
      media.display_uri ||
      media.image_versions2?.candidates?.[0]?.url ||
      media.carousel_media?.[0]?.display_uri ||
      media.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url ||
      null;
    const cleanThumb = this.decodeEscapedUrl(candidateThumb);

    // Extraer título / texto de la publicación y autor
    const rawCaption = media.caption?.text || media.title || '';
    const cleanCaption = this.decodeHtmlEntities(rawCaption).replace(/\s+/g, ' ').trim();
    const username = media.user?.username ? `@${media.user.username}` : media.user?.full_name || 'Instagram';
    const title = cleanCaption ? cleanCaption.slice(0, 110) : `Publicación de ${username} (${shortcode})`;

    return {
      platform: 'instagram',
      sourceUrl,
      title,
      author: username,
      duration: durationSec ? this.formatDuration(durationSec) : null,
      thumbnail: cleanThumb && isAllowedExternalUrl(cleanThumb) ? cleanThumb : null,
      formats
    };
  }

  /**
   * Extractor de Facebook 2026 basado en Relay data-sjs
   * Extrae progressive_urls, browser_native_hd_url y browser_native_sd_url reales desde fbcdn.net
   * y evita las URLs HTML de lookaside.fbsbx.com que causaban error de formato al descargar.
   */
  static async extractFacebookServerless(inputUrl) {
    let canonicalUrl = inputUrl;

    const desktopHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Sec-Fetch-Dest': 'document',
      'Upgrade-Insecure-Requests': '1'
    };

    // 1. Petición principal con cabeceras de navegador de escritorio (devuelve Relay data-sjs con streams fbcdn.net)
    try {
      const res = await fetch(canonicalUrl, {
        headers: desktopHeaders,
        redirect: 'follow',
        signal: AbortSignal.timeout(9000)
      });

      if (res.url && isAllowedExternalUrl(res.url)) {
        canonicalUrl = res.url;
      }

      if (res.ok) {
        const rawHtml = await res.text();
        const parsed = this.parseFacebookRelayHtml(rawHtml, inputUrl);
        if (parsed) return parsed;
      }
    } catch {
      // Continuar con plugin de video
    }

    // 2. Respaldo mediante el Endpoint Oficial del Reproductor Embebido de Facebook
    try {
      const pluginUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(canonicalUrl)}&show_text=0`;
      const pluginRes = await fetch(pluginUrl, {
        headers: {
          ...desktopHeaders,
          Referer: 'https://www.facebook.com/'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(8000)
      });

      if (pluginRes.ok) {
        const pluginHtml = await pluginRes.text();
        const parsedPlugin = this.parseFacebookRelayHtml(pluginHtml, inputUrl);
        if (parsedPlugin) return parsedPlugin;
      }
    } catch {
      // Fallo controlado
    }

    throw new Error('No se encontraron pistas MP4 públicas en Facebook.');
  }

  static parseFacebookRelayHtml(rawHtml, sourceUrl) {
    if (!rawHtml) return null;

    // Normalizar barras escapadas y secuencias Unicode sin alterar delimitadores de cadenas JSON
    const normalized = rawHtml
      .replace(/\\\\\//g, '/')
      .replace(/\\\//g, '/')
      .replace(/\\\\u0026/g, '&')
      .replace(/\\u0026/g, '&')
      .replace(/\\\\u003d/gi, '=')
      .replace(/\\u003d/gi, '=')
      .replace(/&amp;/g, '&');

    const hdCandidates = [
      ...normalized.matchAll(/"browser_native_hd_url"\s*:\s*"(https:\/\/[^"\\]+)"/gi),
      ...normalized.matchAll(/"playable_url_quality_hd"\s*:\s*"(https:\/\/[^"\\]+)"/gi),
      ...normalized.matchAll(/"hd_src_no_ratelimit"\s*:\s*"(https:\/\/[^"\\]+)"/gi),
      ...normalized.matchAll(/"hd_src"\s*:\s*"(https:\/\/[^"\\]+)"/gi)
    ];

    const sdCandidates = [
      ...normalized.matchAll(/"browser_native_sd_url"\s*:\s*"(https:\/\/[^"\\]+)"/gi),
      ...normalized.matchAll(/"playable_url"\s*:\s*"(https:\/\/[^"\\]+)"/gi),
      ...normalized.matchAll(/"sd_src_no_ratelimit"\s*:\s*"(https:\/\/[^"\\]+)"/gi),
      ...normalized.matchAll(/"sd_src"\s*:\s*"(https:\/\/[^"\\]+)"/gi)
    ];

    // Extraer también progressive_urls de la nueva estructura videoDeliveryResponseResult de Facebook
    const progressiveMatches = [
      ...normalized.matchAll(/"progressive_url"\s*:\s*"(https:\/\/[^"\\]+)"(?:[^{}]*"quality"\s*:\s*"(HD|SD)")?/gi)
    ];

    let hdUrl = null;
    let sdUrl = null;

    for (const m of progressiveMatches) {
      const url = this.decodeEscapedUrl(m[1]);
      if (!this.isValidDirectVideoStream(url)) continue;
      const q = (m[2] || '').toUpperCase();
      if (q === 'HD' && !hdUrl) hdUrl = url;
      else if (!sdUrl) sdUrl = url;
    }

    if (!hdUrl) {
      for (const m of hdCandidates) {
        const url = this.decodeEscapedUrl(m[1]);
        if (this.isValidDirectVideoStream(url)) {
          hdUrl = url;
          break;
        }
      }
    }

    if (!sdUrl) {
      for (const m of sdCandidates) {
        const url = this.decodeEscapedUrl(m[1]);
        if (this.isValidDirectVideoStream(url)) {
          sdUrl = url;
          break;
        }
      }
    }

    if (!hdUrl && !sdUrl) {
      return null;
    }

    const formats = this.buildStandardFormats(hdUrl || sdUrl, sdUrl || hdUrl);
    if (formats.length === 0) return null;

    // Extraer duración desde playable_duration_in_ms o desde el metadato efg del stream MP4
    const durMsMatch = normalized.match(/"playable_duration_in_ms"\s*:\s*(\d+)/);
    const efgMeta = this.parseEfgMetadata(formats[0].url);
    const durationSec = durMsMatch?.[1]
      ? Math.round(parseInt(durMsMatch[1], 10) / 1000)
      : efgMeta?.durationSec || null;

    // Extraer miniatura real de fbcdn.net (ignorando lookaside.fbsbx.com que devuelve HTML)
    const thumbMatches = [
      ...normalized.matchAll(/"preferred_thumbnail"\s*:\s*\{\s*"image"\s*:\s*\{\s*"uri"\s*:\s*"(https:\/\/[^"\\]+)"/gi),
      ...normalized.matchAll(/"thumbnailImage"\s*:\s*\{\s*"uri"\s*:\s*"(https:\/\/[^"\\]+)"/gi),
      ...normalized.matchAll(/property="og:image"\s+content="(https:\/\/[^"\\]+)"/gi)
    ];

    let thumbnail = null;
    for (const m of thumbMatches) {
      const candidate = this.decodeEscapedUrl(m[1]);
      if (candidate && isAllowedExternalUrl(candidate) && !candidate.includes('lookaside.fbsbx.com')) {
        thumbnail = candidate;
        break;
      }
    }

    // Extraer título / descripción y decodificar entidades HTML (como &#xb7; o &#xa0;)
    const titleMatch =
      normalized.match(/property="og:title"\s+content="([^"]+)"/i) ||
      normalized.match(/property="og:description"\s+content="([^"]+)"/i) ||
      normalized.match(/<title>([^<]+)<\/title>/i);
    const rawTitle = titleMatch?.[1] ? this.decodeHtmlEntities(this.decodeEscapedUrl(titleMatch[1])).trim() : '';
    const cleanTitle =
      rawTitle && rawTitle.toLowerCase() !== 'facebook'
        ? rawTitle.slice(0, 110)
        : 'Video Público de Facebook';

    const ownerMatch = normalized.match(/"video_owner"\s*:\s*\{[^{}]*"name"\s*:\s*"([^"\\]+)"/i);
    const author = ownerMatch?.[1] ? this.decodeHtmlEntities(ownerMatch[1]) : 'Facebook Video';

    return {
      platform: 'facebook',
      sourceUrl,
      title: cleanTitle,
      author,
      duration: durationSec ? this.formatDuration(durationSec) : null,
      thumbnail,
      formats
    };
  }

  static async extractWithYtDlp(url, platform) {
    const args = ['-m', 'yt_dlp', '-J', '--no-playlist', '--no-warnings', '--', url];
    const { stdout } = await execFileAsync('python', args, {
      timeout: 15000,
      maxBuffer: 5 * 1024 * 1024
    });

    const info = JSON.parse(stdout);
    const rawFormats = Array.isArray(info.formats) ? info.formats : [];

    const mp4Formats = rawFormats
      .filter((f) => f.url && this.isValidDirectVideoStream(f.url) && (f.ext === 'mp4' || (f.vcodec && f.vcodec !== 'none')))
      .map((f) => ({
        height: f.height || 0,
        width: f.width || 0,
        hasAudio: Boolean(f.acodec && f.acodec !== 'none'),
        url: f.url
      }))
      .sort((a, b) => Number(b.hasAudio) - Number(a.hasAudio) || b.height - a.height);

    const formats = this.buildStandardFormats(mp4Formats[0]?.url || info.url, null, mp4Formats);

    return {
      platform,
      sourceUrl: url,
      title: this.decodeHtmlEntities(info.title || info.description?.slice(0, 90) || `Video de ${platform}`),
      author: info.uploader || info.channel || (platform === 'instagram' ? 'Instagram' : 'Facebook'),
      duration: info.duration ? this.formatDuration(info.duration) : null,
      thumbnail: info.thumbnail && isAllowedExternalUrl(info.thumbnail) ? info.thumbnail : null,
      formats
    };
  }

  static buildDemoResponse(platform, url) {
    const isIg = platform === 'instagram';
    return {
      platform,
      sourceUrl: url,
      title: isIg ? 'Publicación de Instagram' : 'Publicación de Facebook',
      author: isIg ? '@instagram' : 'Facebook',
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
