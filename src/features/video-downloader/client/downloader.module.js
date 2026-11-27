import { showToast } from '/js/utils/toast.js?v=6';
import { i18n } from '/js/i18n.js?v=6';

/**
 * Módulo Frontend: Descargador de Videos de Instagram y Facebook
 * Muestra la vista previa de la portada del video, el título de la publicación
 * y el selector dinámico de calidades permitidas antes de descargar.
 */
export class VideoDownloaderModule {
  constructor() {
    this.isLoading = false;
    this.currentData = null;
    this.selectedFormatIndex = 0;
  }

  init() {
    this.bindEvents();
    i18n.onChange(() => {
      if (this.currentData) {
        this.renderResult(this.currentData);
      }
    });
  }

  bindEvents() {
    const form = document.getElementById('video-downloader-form');
    const urlInput = document.getElementById('video-url-input');
    const pasteBtn = document.getElementById('btn-paste-url');
    const sampleButtons = document.querySelectorAll('[data-sample-url]');

    if (pasteBtn && urlInput) {
      pasteBtn.addEventListener('click', async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) {
            urlInput.value = text.trim();
            this.handleExtract(urlInput.value);
          }
        } catch {
          urlInput.focus();
          showToast(i18n.t('toastPasteHint'), 'info');
        }
      });
    }

    if (urlInput) {
      urlInput.addEventListener('paste', () => {
        setTimeout(() => {
          const val = urlInput.value.trim();
          if (val.startsWith('https://')) {
            this.handleExtract(val);
          }
        }, 80);
      });
    }

    sampleButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const sample = btn.getAttribute('data-sample-url');
        if (urlInput && sample) {
          urlInput.value = sample;
          this.handleExtract(sample);
        }
      });
    });

    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const url = urlInput?.value.trim() || '';
        this.handleExtract(url);
      });
    }
  }

  async handleExtract(url) {
    if (!url) {
      showToast(i18n.t('toastEnterUrl'), 'error');
      return;
    }

    if (this.isLoading) return;
    this.setLoading(true);

    const resultContainer = document.getElementById('video-result-container');
    if (resultContainer) resultContainer.classList.add('hidden');

    try {
      const response = await fetch('/api/video/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });

      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Error');
      }

      this.currentData = payload.data;
      this.selectedFormatIndex = 0;
      this.renderResult(this.currentData);
      showToast(i18n.t('toastQualitiesLoaded'), 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      this.setLoading(false);
    }
  }

  setLoading(loading) {
    this.isLoading = loading;
    const submitBtn = document.getElementById('btn-extract-video');
    const btnText = document.getElementById('btn-extract-text');

    if (submitBtn) {
      submitBtn.disabled = loading;
      submitBtn.setAttribute('aria-busy', String(loading));
    }
    if (btnText) {
      btnText.textContent = loading ? i18n.t('btnAnalyzing') : i18n.t('btnAnalyze');
    }
  }

  getFallbackCoverSvg(platformLabel) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 320">
      <rect width="480" height="320" fill="#000000"/>
      <rect x="0" y="0" width="480" height="6" fill="#FF3300"/>
      <circle cx="240" cy="145" r="38" fill="#FF3300"/>
      <polygon points="230,126 230,164 262,145" fill="#FFFFFF"/>
      <text x="240" y="225" font-family="Inter, sans-serif" font-size="16" font-weight="700" fill="#FFFFFF" text-anchor="middle">${platformLabel} Video</text>
    </svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  resolveThumbnailSrc(data, platformLabel) {
    if (!data?.thumbnail) {
      return this.getFallbackCoverSvg(platformLabel);
    }
    if (data.thumbnail.startsWith('data:')) {
      return data.thumbnail;
    }
    return `/api/video/thumbnail?url=${encodeURIComponent(data.thumbnail)}`;
  }

  renderResult(data) {
    const container = document.getElementById('video-result-container');
    if (!container) return;

    const platformLabel = data.platform === 'instagram' ? 'Instagram' : 'Facebook';
    const formats = Array.isArray(data.formats) && data.formats.length > 0 ? data.formats : [];
    const activeFormat = formats[this.selectedFormatIndex] || formats[0];
    const downloadHref = this.buildDownloadUrl(activeFormat, data.platform);
    const fallbackCover = this.getFallbackCoverSvg(platformLabel);
    const coverSrc = this.resolveThumbnailSrc(data, platformLabel);

    const qualityChipsHtml = formats
      .map((fmt, idx) => {
        const isActive = idx === this.selectedFormatIndex;
        return `
          <button
            type="button"
            class="quality-option-chip ${isActive ? 'active' : ''}"
            data-quality-idx="${idx}"
            aria-pressed="${isActive}"
          >
            <span class="quality-chip-res">${this.escapeHtml(fmt.quality || 'HD')}</span>
            <span class="quality-chip-tier">${this.escapeHtml(fmt.tier || 'MP4')}</span>
          </button>
        `;
      })
      .join('');

    container.innerHTML = `
      <div class="video-result-box">
        <div class="video-result-grid">
          <!-- Columna Izquierda: Portada / Vista Previa del Video -->
          <div class="video-cover-col">
            <div class="video-cover-frame">
              <img
                id="video-cover-img"
                src="${this.escapeHtml(coverSrc)}"
                alt="${this.escapeHtml(data.title || platformLabel)}"
                class="video-cover-image"
                loading="lazy"
              />
              <div class="video-cover-badge">${platformLabel}</div>
              ${data.duration ? `<div class="video-cover-duration">${this.escapeHtml(data.duration)}</div>` : ''}
            </div>
          </div>

          <!-- Columna Derecha: Nombre del Video/Publicación y Selector Dinámico de Calidad -->
          <div class="video-details-col">
            <div class="video-post-header">
              <div class="video-result-meta">
                <span class="meta-platform">${platformLabel}</span>
                <span class="meta-author">${this.escapeHtml(i18n.t('authorLabel'))}: ${this.escapeHtml(data.author || platformLabel)}</span>
              </div>
              <h3 class="video-result-title">${this.escapeHtml(data.title)}</h3>
            </div>

            <div class="dynamic-quality-panel">
              <p class="form-label">${this.escapeHtml(i18n.t('qualitySelectLabel'))}</p>
              <div class="quality-chips-grid" role="radiogroup" aria-label="${this.escapeHtml(i18n.t('qualitySelectLabel'))}">
                ${qualityChipsHtml}
              </div>
              <div class="download-cta-row">
                <a id="btn-trigger-video-download" href="${downloadHref}" class="btn-primary btn-download-final">
                  ${this.escapeHtml(i18n.t('btnDownloadMp4'))} · ${this.escapeHtml(activeFormat?.quality || 'HD')}
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const coverImg = document.getElementById('video-cover-img');
    if (coverImg) {
      coverImg.addEventListener(
        'error',
        () => {
          coverImg.src = fallbackCover;
        },
        { once: true }
      );
    }

    container.querySelectorAll('[data-quality-idx]').forEach((chip) => {
      chip.addEventListener('click', () => {
        this.selectedFormatIndex = parseInt(chip.getAttribute('data-quality-idx'), 10) || 0;
        this.renderResult(this.currentData);
      });
    });

    container.classList.remove('hidden');
  }

  buildDownloadUrl(format, platform) {
    if (!format) return '#';
    return `/api/video/download?url=${encodeURIComponent(
      format.url
    )}&platform=${encodeURIComponent(platform)}&quality=${encodeURIComponent(format.quality || 'HD')}`;
  }

  escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
