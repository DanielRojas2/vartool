export const appConfig = {
  appName: 'Vartool',
  appTagline: 'Tus herramientas en un solo lugar',
  siteUrl: process.env.SITE_URL || 'https://vartool.app',
  port: process.env.PORT || 3000,
  security: {
    jsonLimit: '16kb',
    requestTimeoutMs: 25000,
    rateLimits: {
      globalPerMin: 120,
      qrPerMin: 50,
      videoInfoPerMin: 15,
      videoDownloadPerMin: 12
    }
  },
  adsense: {
    enabled: process.env.ADSENSE_ENABLED === 'true' || false,
    clientId: process.env.ADSENSE_CLIENT_ID || 'ca-pub-0000000000000000',
    slots: {
      topLeaderboard: process.env.ADSENSE_SLOT_TOP || '1111111111',
      inToolNative: process.env.ADSENSE_SLOT_INTOOL || '2222222222',
      bottomBanner: process.env.ADSENSE_SLOT_BOTTOM || '3333333333'
    }
  }
};
