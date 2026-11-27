import { i18n } from '/js/i18n.js?v=4';

/**
 * Módulo de Monetización (Google AdSense — Optimización de RPM y CTR)
 * Gestiona 3 ubicaciones estratégicas de alto rendimiento:
 * 1. topLeaderboard: Alta visibilidad inmediata (Above the Fold).
 * 2. inToolNative: Ubicación nativa bajo el área de acción principal (Máximo CTR).
 * 3. bottomBanner: Cierre de contenido antes del pie de página.
 */
export class AdsModule {
  constructor() {
    this.config = {
      enabled: false,
      clientId: 'ca-pub-0000000000000000',
      slots: {
        topLeaderboard: '1111111111',
        inToolNative: '2222222222',
        bottomBanner: '3333333333'
      }
    };
  }

  async init() {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const data = await res.json();
        if (data.adsense) {
          this.config = data.adsense;
        }
      }
    } catch {
      // Continuar con valores por defecto
    }

    if (this.config.enabled && this.config.clientId && !this.config.clientId.includes('0000000')) {
      this.injectGoogleAdSenseScript();
    }

    this.renderAdContainers();
    i18n.onChange(() => {
      if (!this.config.enabled || this.config.clientId.includes('0000000')) {
        this.renderAdContainers();
      }
    });
  }

  injectGoogleAdSenseScript() {
    if (document.getElementById('google-adsense-sdk')) return;
    const script = document.createElement('script');
    script.id = 'google-adsense-sdk';
    script.async = true;
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(this.config.clientId)}`;
    script.crossOrigin = 'anonymous';
    document.head.appendChild(script);
  }

  getSlotTranslationKey(position) {
    switch (position) {
      case 'topLeaderboard':
        return 'adSlotTop';
      case 'inToolNative':
        return 'adSlotMid';
      case 'bottomBanner':
      default:
        return 'adSlotBottom';
    }
  }

  renderAdContainers() {
    const adNodes = document.querySelectorAll('[data-vartool-ad]');
    adNodes.forEach((node) => {
      const position = node.getAttribute('data-vartool-ad');
      const format = node.getAttribute('data-ad-format') || 'auto';
      const slotId = this.config.slots[position] || '3333333333';

      if (this.config.enabled && !this.config.clientId.includes('0000000')) {
        node.innerHTML = `
          <div class="ad-unit-wrapper">
            <span class="ad-label">${i18n.t('adBadge')}</span>
            <ins class="adsbygoogle"
                 style="display:block"
                 data-ad-client="${this.config.clientId}"
                 data-ad-slot="${slotId}"
                 data-ad-format="${format}"
                 data-full-width-responsive="true"></ins>
          </div>
        `;
        try {
          (window.adsbygoogle = window.adsbygoogle || []).push({});
        } catch {
          // AdSense cargando
        }
      } else {
        const descKey = this.getSlotTranslationKey(position);
        node.innerHTML = `
          <div class="ad-unit-preview ad-slot-${position}" aria-label="Google AdSense">
            <span class="ad-label">${i18n.t('adBadge')}</span>
            <p class="ad-preview-text">${i18n.t(descKey)}</p>
          </div>
        `;
      }
    });
  }
}
