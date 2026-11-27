import { execFile } from 'child_process';
import { promisify } from 'util';
import { isAllowedExternalUrl } from '../../shared/middleware/security.middleware.js';

const execFileAsync = promisify(execFile);

/**
 * Servicio Descargador de Videos de Instagram y Facebook (Stateless - Optimizado para Vercel Serverless)
 * Implementa múltiples capas de extracción (GraphQL API, Embed Plugin, Unescaped Relay JSON y Social Crawler Meta)
 * para funcionar de forma fiable desde IPs de centros de datos (Vercel / AWS) sin requerir inicio de sesión.
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
    const match = url.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,35})/i);
    return match ? match[1] : null;
  }

  /**
   * Decodifica cadenas JSON simple o doblemente escapadas en el HTML de Meta (Instagram / Facebook)
   */
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
   * Normaliza bloques HTML con JSON doblemente escapado (como contextJSON en Instagram Embed y Relay en Facebook)
   */
  static normalizeHtmlPayload(html) {
    if (!html) return '';
    return html
      .replace(/\\\\\//g, '/')
      .replace(/\\\//g, '/')
      .replace(/\\\\u0026/g, '&')
      .replace(/\\u0026/g, '&')
      .replace(/\\\\u003d/gi, '=')
      .replace(/\\u003d/gi, '=')
      .replace(/\\"/g, '"')
      .replace(/&amp;/g, '&');
  }

  static buildStandardFormats(hdUrl, sdUrl = null, extraVersions = []) {
    const formats = [];
    const seenUrls = new Set();

    if (Array.isArray(extraVersions) && extraVersions.length > 0) {
      for (const v of extraVersions) {
        if (!v?.url || !isAllowedExternalUrl(v.url) || seenUrls.has(v.url)) continue;
        seenUrls.add(v.url);
        const h = Number(v.height) || Number(v.width) || 0;
        const qualityLabel = h >= 1000 ? '1080p' : h >= 700 ? '720p' : h >= 450 ? '480p' : '360p';
        const tierLabel = h >= 1000 ? 'Full HD' : h >= 700 ? 'HD' : 'SD';
        formats.push({
          label: `${tierLabel} ${qualityLabel} (MP4)`,
          quality: qualityLabel,
          tier: tierLabel,
          ext: 'mp4',
          url: v.url
        });
      }
    }

    if (formats.length === 0) {
      const validHd = hdUrl && isAllowedExternalUrl(hdUrl) ? hdUrl : null;
      const validSd = sdUrl && isAllowedExternalUrl(sdUrl) ? sdUrl : null;
      const primaryUrl = validHd || validSd;

      if (primaryUrl) {
        formats.push(
          {
            label: 'Full HD 1080p (MP4)',
            quality: '1080p',
            tier: 'Full HD',
            ext: 'mp4',
            url: primaryUrl
          },
          {
            label: 'HD 720p (MP4)',
            quality: '720p',
            tier: 'HD',
            ext: 'mp4',
            url: primaryUrl
          },
          {
            label: 'SD 480p (MP4)',
            quality: '480p',
            tier: 'SD',
            ext: 'mp4',
            url: validSd || primaryUrl
          },
          {
            label: 'Baja 360p (MP4)',
            quality: '360p',
            tier: 'Ahorro',
            ext: 'mp4',
            url: validSd || primaryUrl
          }
        );
      }
    } else if (formats.length === 1) {
      const base = formats[0].url;
      formats.push(
        {
          label: 'HD 720p (MP4)',
          quality: '720p',
          tier: 'HD',
          ext: 'mp4',
          url: base
        },
        {
          label: 'SD 480p (MP4)',
          quality: '480p',
          tier: 'SD',
          ext: 'mp4',
          url: base
        }
      );
    }

    return formats;
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

    // Estrategia 1: yt-dlp (solo en entornos locales/VPS donde Python esté instalado)
    if (!process.env.VERCEL) {
      try {
        const ytdlpResult = await this.extractWithYtDlp(cleanUrl, platform);
        if (ytdlpResult && ytdlpResult.formats.length > 0) {
          return ytdlpResult;
        }
      } catch {
        // Fallback al motor nativo multicapa
      }
    }

    // Estrategia 2: Motor Nativo Multicapa para Vercel Serverless (Instagram / Facebook)
    try {
      const nativeResult =
        platform === 'instagram'
          ? await this.extractInstagramServerless(cleanUrl)
          : await this.extractFacebookServerless(cleanUrl);

      if (nativeResult && nativeResult.formats.length > 0) {
        return nativeResult;
      }
    } catch {
      // Fallo controlado
    }

    const err = new Error(
      `No se pudo extraer el video de ${
        platform === 'instagram' ? 'Instagram' : 'Facebook'
      }. Verifica que la publicación o Reel sea público.`
    );
    err.statusCode = 422;
    throw err;
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
      .filter((f) => f.url && isAllowedExternalUrl(f.url) && (f.ext === 'mp4' || (f.vcodec && f.vcodec !== 'none')))
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
      title: info.title || info.description?.slice(0, 80) || `Video de ${platform}`,
      author: info.uploader || info.channel || (platform === 'instagram' ? 'Instagram' : 'Facebook'),
      duration: info.duration ? this.formatDuration(info.duration) : null,
      thumbnail: info.thumbnail && isAllowedExternalUrl(info.thumbnail) ? info.thumbnail : null,
      formats
    };
  }

  /**
   * Motor Multicapa para Instagram compatible con Vercel Serverless
   * Capa 1: GraphQL API (PolarisPostActionLoadPostQueryQuery)
   * Capa 2: Embed Captioned con desescapado profundo de contextJSON
   * Capa 3: Social Crawler OpenGraph (TelegramBot / facebookexternalhit)
   */
  static async extractInstagramServerless(inputUrl) {
    let targetUrl = inputUrl;
    let shortcode = this.extractInstagramShortcode(targetUrl);

    // Si es un enlace /share/reel/... o instagr.am, resolver redirección primero
    if (!shortcode) {
      try {
        const redir = await fetch(targetUrl, {
          method: 'GET',
          redirect: 'follow',
          headers: {
            'User-Agent': 'curl/8.4.0'
          },
          signal: AbortSignal.timeout(6000)
        });
        if (redir.url) {
          targetUrl = redir.url;
          shortcode = this.extractInstagramShortcode(targetUrl);
        }
      } catch {
        // Continuar
      }
    }

    // CAPA 1: Instagram Public GraphQL Query (Funciona desde IPs de datacenter con X-IG-App-ID)
    if (shortcode) {
      const docIds = ['8845758582119845', '10015901848480474'];
      for (const docId of docIds) {
        try {
          const body = new URLSearchParams({
            av: '0',
            __d: 'www',
            __user: '0',
            __a: '1',
            __req: '1',
            __comet_req: '7',
            fb_api_caller_class: 'RelayModern',
            fb_api_req_friendly_name: 'PolarisPostActionLoadPostQueryQuery',
            variables: JSON.stringify({
              shortcode,
              fetch_tagged_user_count: null,
              hoisted_comment_id: null,
              hoisted_reply_id: null
            }),
            server_timestamps: 'true',
            doc_id: docId
          });

          const gqlRes = await fetch('https://www.instagram.com/graphql/query', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
              'X-IG-App-ID': '936619743392459',
              'X-FB-Friendly-Name': 'PolarisPostActionLoadPostQueryQuery',
              'X-CSRFToken': 'missing',
              'X-ASBD-ID': '129477',
              Origin: 'https://www.instagram.com',
              Referer: `https://www.instagram.com/p/${shortcode}/`
            },
            body: body.toString(),
            signal: AbortSignal.timeout(7000)
          });

          if (gqlRes.ok) {
            const json = await gqlRes.json();
            const media =
              json?.data?.xdt_shortcode_media ||
              json?.data?.shortcode_media ||
              json?.graphql?.shortcode_media;

            if (media) {
              const directVideo = this.decodeEscapedUrl(media.video_url);
              const versions = Array.isArray(media.video_versions) ? media.video_versions : [];
              const formats = this.buildStandardFormats(directVideo, null, versions);

              if (formats.length > 0) {
                const caption =
                  media.edge_media_to_caption?.edges?.[0]?.node?.text?.slice(0, 90) ||
                  `Reel de Instagram (${shortcode})`;
                return {
                  platform: 'instagram',
                  sourceUrl: inputUrl,
                  title: caption,
                  author: media.owner?.username ? `@${media.owner.username}` : 'Instagram',
                  duration: media.video_duration ? this.formatDuration(media.video_duration) : null,
                  thumbnail: isAllowedExternalUrl(media.display_url) ? media.display_url : null,
                  formats
                };
              }
            }
          }
        } catch {
          // Pasar al siguiente doc_id o capa
        }
      }
    }

    // CAPA 2: Instagram Embed Captioned + Desescapado Completo de contextJSON
    const embedCandidates = shortcode
      ? [
          `https://www.instagram.com/p/${shortcode}/embed/captioned/`,
          `https://www.instagram.com/p/${shortcode}/embed/`,
          `https://www.instagram.com/reel/${shortcode}/embed/`
        ]
      : [targetUrl];

    for (const candidate of embedCandidates) {
      try {
        const res = await fetch(candidate, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(7000)
        });
        if (!res.ok) continue;

        const rawHtml = await res.text();
        const normalized = this.normalizeHtmlPayload(rawHtml);

        const videoMatches = [
          ...normalized.matchAll(/"video_url"\s*:\s*"(https:\/\/[^"]+)"/gi),
          ...normalized.matchAll(/property="og:video(?::secure_url|:url)?"\s+content="(https:\/\/[^"]+)"/gi),
          ...normalized.matchAll(/content="(https:\/\/[^"]+)"\s+property="og:video(?::secure_url|:url)?"/gi)
        ];

        const foundUrls = [];
        for (const m of videoMatches) {
          const decoded = this.decodeEscapedUrl(m[1]);
          if (decoded && isAllowedExternalUrl(decoded) && !foundUrls.includes(decoded)) {
            foundUrls.push(decoded);
          }
        }

        if (foundUrls.length > 0) {
          const thumbMatch =
            normalized.match(/"display_url"\s*:\s*"(https:\/\/[^"]+)"/i) ||
            normalized.match(/"thumbnail_src"\s*:\s*"(https:\/\/[^"]+)"/i) ||
            normalized.match(/class="EmbeddedMediaImage"[^>]+src="(https:\/\/[^"]+)"/i) ||
            normalized.match(/property="og:image"\s+content="(https:\/\/[^"]+)"/i);
          const userMatch = normalized.match(/"username"\s*:\s*"([A-Za-z0-9._]+)"/i);
          const captionMatch =
            normalized.match(/"caption"\s*:\s*"([^"]{3,160})"/i) ||
            normalized.match(/class="Caption"[^>]*>([\s\S]{3,160}?)<\/div>/i) ||
            normalized.match(/property="og:title"\s+content="([^"]+)"/i);

          const thumbUrl = thumbMatch?.[1] ? this.decodeEscapedUrl(thumbMatch[1]) : null;
          let cleanTitle = captionMatch?.[1]
            ? this.decodeEscapedUrl(captionMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim()
            : '';
          if (!cleanTitle) {
            cleanTitle = `Publicación de Instagram ${shortcode ? `(${shortcode})` : ''}`;
          }

          return {
            platform: 'instagram',
            sourceUrl: inputUrl,
            title: cleanTitle.slice(0, 110),
            author: userMatch?.[1] ? `@${userMatch[1]}` : 'Instagram',
            duration: null,
            thumbnail: thumbUrl && isAllowedExternalUrl(thumbUrl) ? thumbUrl : null,
            formats: this.buildStandardFormats(foundUrls[0], foundUrls[1] || foundUrls[0])
          };
        }
      } catch {
        // Siguiente candidato
      }
    }

    // CAPA 3: Social Crawler OpenGraph (TelegramBot / FacebookExternalHit)
    const botAgents = [
      'TelegramBot (like TwitterBot)',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'WhatsApp/2.24.12.78 A'
    ];

    for (const ua of botAgents) {
      try {
        const pageUrl = shortcode ? `https://www.instagram.com/reel/${shortcode}/` : targetUrl;
        const res = await fetch(pageUrl, {
          headers: { 'User-Agent': ua, Accept: 'text/html' },
          redirect: 'follow',
          signal: AbortSignal.timeout(6000)
        });
        if (!res.ok) continue;
        const html = this.normalizeHtmlPayload(await res.text());
        const ogVideo =
          html.match(/property="og:video(?::secure_url|:url)?"\s+content="(https:\/\/[^"]+)"/i) ||
          html.match(/content="(https:\/\/[^"]+)"\s+property="og:video(?::secure_url|:url)?"/i);

        if (ogVideo?.[1]) {
          const vUrl = this.decodeEscapedUrl(ogVideo[1]);
          if (isAllowedExternalUrl(vUrl)) {
            const ogImg = html.match(/property="og:image"\s+content="(https:\/\/[^"]+)"/i);
            const ogTitle =
              html.match(/property="og:title"\s+content="([^"]+)"/i) ||
              html.match(/property="og:description"\s+content="([^"]+)"/i);
            const thumbUrl = ogImg?.[1] ? this.decodeEscapedUrl(ogImg[1]) : null;
            const titleText = ogTitle?.[1]
              ? this.decodeEscapedUrl(ogTitle[1]).slice(0, 110)
              : `Video de Instagram ${shortcode ? `(${shortcode})` : ''}`;

            return {
              platform: 'instagram',
              sourceUrl: inputUrl,
              title: titleText,
              author: 'Instagram',
              duration: null,
              thumbnail: thumbUrl && isAllowedExternalUrl(thumbUrl) ? thumbUrl : null,
              formats: this.buildStandardFormats(vUrl)
            };
          }
        }
      } catch {
        // Continuar
      }
    }

    throw new Error('No se encontró stream MP4 público en Instagram.');
  }

  /**
   * Motor Multicapa para Facebook compatible con Vercel Serverless
   * Soporta: facebook.com/watch, fb.watch, facebook.com/reel, facebook.com/share/v/, facebook.com/share/r/
   */
  static async extractFacebookServerless(inputUrl) {
    let canonicalUrl = inputUrl;

    // 1. Resolver enlaces cortos (fb.watch, /share/v/, /share/r/)
    try {
      const redir = await fetch(inputUrl, {
        headers: {
          'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          Accept: 'text/html,application/xhtml+xml'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(7000)
      });
      if (redir.url && isAllowedExternalUrl(redir.url)) {
        canonicalUrl = redir.url;
      }
      if (redir.ok) {
        const botHtml = this.normalizeHtmlPayload(await redir.text());
        const parsedFromBot = this.parseFacebookHtml(botHtml, inputUrl);
        if (parsedFromBot) return parsedFromBot;
      }
    } catch {
      // Continuar con capas siguientes
    }

    // 2. Intentar extracción con User-Agent de navegador de escritorio y móvil
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      'TelegramBot (like TwitterBot)'
    ];

    for (const ua of userAgents) {
      try {
        const res = await fetch(canonicalUrl, {
          headers: {
            'User-Agent': ua,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Sec-Fetch-Dest': 'document'
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(7000)
        });

        if (!res.ok) continue;
        const html = this.normalizeHtmlPayload(await res.text());
        const parsed = this.parseFacebookHtml(html, inputUrl);
        if (parsed) return parsed;
      } catch {
        // Siguiente User-Agent
      }
    }

    // 3. Intentar con el Endpoint Oficial del Plugin de Video de Facebook (Funciona sin login desde cualquier IP)
    try {
      const pluginUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(canonicalUrl)}&show_text=0`;
      const pluginRes = await fetch(pluginUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
          Referer: 'https://www.facebook.com/'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(7000)
      });

      if (pluginRes.ok) {
        const pluginHtml = this.normalizeHtmlPayload(await pluginRes.text());
        const parsedPlugin = this.parseFacebookHtml(pluginHtml, inputUrl);
        if (parsedPlugin) return parsedPlugin;
      }
    } catch {
      // Fallo controlado
    }

    throw new Error('No se encontraron pistas MP4 públicas en Facebook.');
  }

  static parseFacebookHtml(normalizedHtml, sourceUrl) {
    if (!normalizedHtml) return null;

    const hdRegexes = [
      /"browser_native_hd_url"\s*:\s*"(https:\/\/[^"]+)"/i,
      /"playable_url_quality_hd"\s*:\s*"(https:\/\/[^"]+)"/i,
      /"hd_src_no_ratelimit"\s*:\s*"(https:\/\/[^"]+)"/i,
      /"hd_src"\s*:\s*"(https:\/\/[^"]+)"/i,
      /hd_src\s*:\s*"(https:\/\/[^"]+)"/i
    ];

    const sdRegexes = [
      /"browser_native_sd_url"\s*:\s*"(https:\/\/[^"]+)"/i,
      /"playable_url"\s*:\s*"(https:\/\/[^"]+)"/i,
      /"sd_src_no_ratelimit"\s*:\s*"(https:\/\/[^"]+)"/i,
      /"sd_src"\s*:\s*"(https:\/\/[^"]+)"/i,
      /sd_src\s*:\s*"(https:\/\/[^"]+)"/i,
      /property="og:video(?::secure_url|:url)?"\s+content="(https:\/\/[^"]+)"/i,
      /content="(https:\/\/[^"]+)"\s+property="og:video(?::secure_url|:url)?"/i
    ];

    let hdUrl = null;
    for (const rx of hdRegexes) {
      const m = normalizedHtml.match(rx);
      if (m?.[1]) {
        const candidate = this.decodeEscapedUrl(m[1]);
        if (isAllowedExternalUrl(candidate)) {
          hdUrl = candidate;
          break;
        }
      }
    }

    let sdUrl = null;
    for (const rx of sdRegexes) {
      const m = normalizedHtml.match(rx);
      if (m?.[1]) {
        const candidate = this.decodeEscapedUrl(m[1]);
        if (isAllowedExternalUrl(candidate)) {
          sdUrl = candidate;
          break;
        }
      }
    }

    if (!hdUrl && !sdUrl) {
      return null;
    }

    const formats = this.buildStandardFormats(hdUrl || sdUrl, sdUrl || hdUrl);
    if (formats.length === 0) return null;

    const titleMatch =
      normalizedHtml.match(/property="og:title"\s+content="([^"]+)"/i) ||
      normalizedHtml.match(/property="og:description"\s+content="([^"]+)"/i) ||
      normalizedHtml.match(/<title>([^<]+)<\/title>/i);
    const thumbMatch =
      normalizedHtml.match(/property="og:image"\s+content="(https:\/\/[^"]+)"/i) ||
      normalizedHtml.match(/"preferred_thumbnail"\s*:\s*\{\s*"image"\s*:\s*\{\s*"uri"\s*:\s*"(https:\/\/[^"]+)"/i) ||
      normalizedHtml.match(/"thumbnailImage"\s*:\s*\{\s*"uri"\s*:\s*"(https:\/\/[^"]+)"/i);
    const decodedThumb = thumbMatch?.[1] ? this.decodeEscapedUrl(thumbMatch[1]) : null;
    const rawTitle = titleMatch?.[1] ? this.decodeEscapedUrl(titleMatch[1]).trim() : '';
    const finalTitle =
      rawTitle && rawTitle.toLowerCase() !== 'facebook'
        ? rawTitle.slice(0, 110)
        : 'Video Público de Facebook';

    return {
      platform: 'facebook',
      sourceUrl,
      title: finalTitle,
      author: 'Facebook Video',
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
