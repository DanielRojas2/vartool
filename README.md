# Vartool (Tus herramientas en un solo lugar)

Aplicación web minimalista, multidispositivo y **sin base de datos (100% stateless)** diseñada bajo una **arquitectura modular orientada a funcionalidad** y protegida con controles de seguridad **OWASP Top 10** e **ISO/IEC 27001**.

## Funcionalidades

1. **Generador de Códigos QR Permanentes (`src/features/qr-generator/`)**:
   - Codifica los datos directamente bajo el estándar **ISO/IEC 18004 Estático** sin redirecciones ni enlaces intermedios.
   - Sin límite de escaneos y sin fecha de expiración.
   - Soporta enlaces web, texto y redes Wi-Fi, con opciones colapsables de color y tamaño, y exportación en PNG y SVG.

2. **Descargador de Videos de Instagram y Facebook (`src/features/video-downloader/`)**:
   - Extracción de videos públicos y Reels de Instagram y Facebook en formato MP4 (HD / SD).
   - Transmisión directa al navegador sin almacenar archivos en disco ni base de datos.

3. **Monetización Discreta con Google AdSense (`src/features/monetization/`)**:
   - Un único espacio publicitario adaptable ubicado en la parte inferior del área de trabajo que no bloquea ni sobrecarga la interfaz.

## Seguridad (OWASP Top 10 e ISO/IEC 27001)

- **Mitigación DDoS y Fuerza Bruta (ISO 27001 A.8.6 / OWASP API4)**:
  - Limitador de tasa por IP (Rate Limiting por ventana deslizante) global y específico por endpoint (`/api/qr`, `/api/video/info`, `/api/video/download`) con limpieza automática de memoria.
  - Limitador de descargas simultáneas por IP (`concurrencyLimiter`).
  - Tiempo máximo de espera por solicitud (`requestTimeout`) contra ataques Slowloris y límite estricto de payload JSON (`16kb`).
- **Prevención de SSRF (OWASP A10:2021)**:
  - Lista blanca estricta de dominios permitidos (`instagram.com`, `cdninstagram.com`, `facebook.com`, `fb.watch`, `fbcdn.net`) exclusivamente sobre HTTPS y bloqueo de rangos de IP privados/locales (`127.0.0.1`, `10.x`, `192.168.x`, `172.16-31.x`, `169.254.x`, `localhost`).
- **Prevención de Inyección (OWASP A03:2021)**:
  - Separador `--` en invocaciones de `execFile` y límites estrictos de longitud de entrada.
- **Cabeceras de Seguridad HTTP (ISO 27001 A.8.26 / OWASP A05)**:
  - `Content-Security-Policy` (CSP), `Strict-Transport-Security` (HSTS), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy` y desactivación de `X-Powered-By`.
