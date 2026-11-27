import { i18n } from '/js/i18n.js?v=6';
import { QrGeneratorModule } from '/features/qr-generator/client/qr.module.js?v=6';
import { VideoDownloaderModule } from '/features/video-downloader/client/downloader.module.js?v=6';
import { AdsModule } from '/features/monetization/client/ads.module.js?v=6';

/**
 * Orquestador Principal de Vartool
 * Gestiona la navegación de herramientas, el selector multilingüe (ES, EN, RU, ZH) y la monetización.
 */
class VartoolApp {
  constructor() {
    this.qrModule = new QrGeneratorModule();
    this.downloaderModule = new VideoDownloaderModule();
    this.adsModule = new AdsModule();
  }

  async init() {
    i18n.applyDomTranslations();
    this.bindLanguageSwitcher();
    this.bindNavigation();
    this.qrModule.init();
    this.downloaderModule.init();
    await this.adsModule.init();
  }

  bindLanguageSwitcher() {
    const langButtons = document.querySelectorAll('[data-lang-switch]');
    langButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const lang = btn.getAttribute('data-lang-switch');
        i18n.setLanguage(lang);
      });
    });
  }

  bindNavigation() {
    const navButtons = document.querySelectorAll('[data-tool-target]');
    const sections = document.querySelectorAll('[data-tool-section]');

    navButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-tool-target');

        navButtons.forEach((b) => {
          const isSelected = b.getAttribute('data-tool-target') === target;
          b.classList.toggle('active', isSelected);
          b.setAttribute('aria-selected', String(isSelected));
        });

        sections.forEach((sec) => {
          const isMatch = sec.getAttribute('data-tool-section') === target;
          sec.classList.toggle('hidden', !isMatch);
        });
      });
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new VartoolApp();
  app.init();
});
