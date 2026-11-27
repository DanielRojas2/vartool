import { showToast } from '/js/utils/toast.js?v=4';
import { i18n } from '/js/i18n.js?v=4';

/**
 * Módulo Frontend: Generador de QRs Permanentes
 * Soporta imagen central en vivo sobre el Canvas (PNG) y dentro del vector SVG.
 */
export class QrGeneratorModule {
  constructor() {
    this.activeType = 'url';
    this.lastResult = null;
    this.logoDataUrl = null;
    this.logoImageElement = null;
    this.debounceTimer = null;
  }

  init() {
    this.bindTypeTabs();
    this.bindInputs();
    this.bindLogoUpload();
    this.bindActions();
    this.generateQr(false);
  }

  bindTypeTabs() {
    const typeButtons = document.querySelectorAll('[data-qr-type]');
    typeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        typeButtons.forEach((b) => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        this.activeType = btn.getAttribute('data-qr-type');

        document.querySelectorAll('[data-qr-panel]').forEach((panel) => {
          const isMatch = panel.getAttribute('data-qr-panel') === this.activeType;
          panel.classList.toggle('hidden', !isMatch);
        });

        this.triggerLiveGenerate();
      });
    });
  }

  bindInputs() {
    const inputs = document.querySelectorAll('.qr-live-input');
    inputs.forEach((input) => {
      input.addEventListener('input', () => {
        this.updateSizeLabel();
        this.triggerLiveGenerate();
      });
      input.addEventListener('change', () => {
        this.updateSizeLabel();
        this.triggerLiveGenerate();
      });
    });
    this.updateSizeLabel();
  }

  updateSizeLabel() {
    const sizeInput = document.getElementById('qr-size');
    const sizeVal = document.getElementById('qr-size-val');
    if (sizeInput && sizeVal) {
      sizeVal.textContent = `${sizeInput.value}px`;
    }
  }

  bindLogoUpload() {
    const logoInput = document.getElementById('qr-logo-input');
    const selectLogoBtn = document.getElementById('btn-select-logo');
    const clearLogoBtn = document.getElementById('qr-logo-clear');
    const thumbPreview = document.getElementById('qr-logo-thumb');

    if (selectLogoBtn && logoInput) {
      selectLogoBtn.addEventListener('click', () => {
        logoInput.click();
      });
    }

    if (logoInput) {
      logoInput.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
          showToast(i18n.t('toastInvalidImg'), 'error');
          logoInput.value = '';
          return;
        }

        if (file.size > 4 * 1024 * 1024) {
          showToast(i18n.t('toastImgTooBig'), 'error');
          logoInput.value = '';
          return;
        }

        const reader = new FileReader();
        reader.onload = async (ev) => {
          const dataUrl = ev.target?.result;
          if (typeof dataUrl !== 'string') return;

          try {
            const loadedImg = await this.loadImage(dataUrl);
            this.logoDataUrl = dataUrl;
            this.logoImageElement = loadedImg;

            if (thumbPreview) {
              thumbPreview.src = dataUrl;
              thumbPreview.classList.remove('hidden');
            }
            if (clearLogoBtn) {
              clearLogoBtn.classList.remove('hidden');
            }

            await this.generateQr(true);
          } catch {
            showToast(i18n.t('toastInvalidImg'), 'error');
          }
        };
        reader.readAsDataURL(file);
      });
    }

    if (clearLogoBtn) {
      clearLogoBtn.addEventListener('click', () => {
        this.logoDataUrl = null;
        this.logoImageElement = null;
        if (logoInput) logoInput.value = '';
        if (thumbPreview) {
          thumbPreview.removeAttribute('src');
          thumbPreview.classList.add('hidden');
        }
        clearLogoBtn.classList.add('hidden');
        this.generateQr(false);
      });
    }
  }

  bindActions() {
    const downloadPngBtn = document.getElementById('btn-download-qr-png');
    if (downloadPngBtn) {
      downloadPngBtn.addEventListener('click', () => this.downloadPng());
    }

    const downloadSvgBtn = document.getElementById('btn-download-qr-svg');
    if (downloadSvgBtn) {
      downloadSvgBtn.addEventListener('click', () => this.downloadSvg());
    }
  }

  triggerLiveGenerate() {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.generateQr(false);
    }, 160);
  }

  buildPayload() {
    switch (this.activeType) {
      case 'url': {
        const val = document.getElementById('qr-input-url')?.value.trim();
        return val || 'https://vartool.app';
      }
      case 'text': {
        const val = document.getElementById('qr-input-text')?.value.trim();
        return val || 'Vartool - Permanent QR Code';
      }
      case 'wifi': {
        const ssid = (document.getElementById('qr-wifi-ssid')?.value || '').trim();
        const pass = (document.getElementById('qr-wifi-pass')?.value || '').trim();
        const enc = document.getElementById('qr-wifi-enc')?.value || 'WPA';
        if (!ssid) return 'WIFI:T:WPA;S:VartoolWiFi;P:12345678;H:false;;';
        const escapeWifi = (str) => str.replace(/([\\;,:])/g, '\\$1');
        return `WIFI:T:${enc};S:${escapeWifi(ssid)};P:${escapeWifi(pass)};H:false;;`;
      }
      default:
        return 'https://vartool.app';
    }
  }

  async generateQr(notify = false) {
    const content = this.buildPayload();
    const width = parseInt(document.getElementById('qr-size')?.value || '520', 10);
    const darkColor = document.getElementById('qr-color-dark')?.value || '#000000';
    const lightColor = document.getElementById('qr-color-light')?.value || '#ffffff';

    try {
      const response = await fetch('/api/qr/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          width,
          margin: 2,
          errorCorrectionLevel: 'H',
          darkColor,
          lightColor
        })
      });

      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Error QR');
      }

      this.lastResult = {
        ...data,
        content,
        width,
        lightColor
      };

      await this.renderToCanvas(data.dataUrl, width, lightColor);

      if (notify) {
        showToast(i18n.t('toastQrUpdated'), 'success');
      }
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async renderToCanvas(dataUrl, size, lightColor) {
    const canvas = document.getElementById('qr-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = size;
    canvas.height = size;

    const qrImg = await this.loadImage(dataUrl);
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(qrImg, 0, 0, size, size);

    if (this.logoDataUrl) {
      try {
        const logoImg = this.logoImageElement || (await this.loadImage(this.logoDataUrl));
        const logoSize = Math.round(size * 0.22);
        const x = Math.round((size - logoSize) / 2);
        const y = Math.round((size - logoSize) / 2);
        const pad = Math.round(size * 0.025);

        ctx.fillStyle = lightColor || '#ffffff';
        this.roundRect(ctx, x - pad, y - pad, logoSize + pad * 2, logoSize + pad * 2, Math.round(size * 0.025));
        ctx.fill();

        ctx.save();
        this.roundRect(ctx, x, y, logoSize, logoSize, Math.round(size * 0.018));
        ctx.clip();
        ctx.drawImage(logoImg, x, y, logoSize, logoSize);
        ctx.restore();
      } catch (err) {
        console.error('Error dibujando logo central:', err);
      }
    }
  }

  roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (!src.startsWith('data:') && !src.startsWith('blob:')) {
        img.crossOrigin = 'anonymous';
      }
      img.onload = () => resolve(img);
      img.onerror = (err) => reject(err);
      img.src = src;
    });
  }

  downloadPng() {
    const canvas = document.getElementById('qr-canvas');
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `vartool-qr-${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    showToast(i18n.t('toastPngSaved'), 'success');
  }

  downloadSvg() {
    if (!this.lastResult?.svg) return;

    let finalSvg = this.lastResult.svg;

    if (this.logoDataUrl) {
      const viewBoxMatch = finalSvg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
      if (viewBoxMatch) {
        const vbSize = parseFloat(viewBoxMatch[1]);
        const logoSize = +(vbSize * 0.22).toFixed(2);
        const pad = +(vbSize * 0.025).toFixed(2);
        const x = +((vbSize - logoSize) / 2).toFixed(2);
        const y = +((vbSize - logoSize) / 2).toFixed(2);
        const bgColor = this.lastResult.lightColor || '#ffffff';

        const overlayGroup =
          `<rect x="${x - pad}" y="${y - pad}" width="${logoSize + pad * 2}" height="${logoSize + pad * 2}" rx="1.2" fill="${bgColor}"/>` +
          `<image href="${this.logoDataUrl}" x="${x}" y="${y}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid slice"/>`;

        finalSvg = finalSvg.replace('</svg>', `${overlayGroup}</svg>`);
      }
    }

    const blob = new Blob([finalSvg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `vartool-qr-${Date.now()}.svg`;
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    showToast(i18n.t('toastSvgSaved'), 'success');
  }
}
