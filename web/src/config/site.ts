export const site = {
  name: 'procman',
  domain: 'procman.kr',
  tagline: 'Local Mission Control for macOS',
  description:
    'Manage every dev server, Docker container, and Cloudflare tunnel from one window.',
  version: '0.2.0',
  downloadUrl:
    'https://github.com/jkeloper/procman/releases/latest/download/procman_0.2.0_aarch64.dmg',
  latestReleaseUrl: 'https://github.com/jkeloper/procman/releases/latest',
  githubUrl: 'https://github.com/jkeloper/procman',
  installScriptUrl:
    'https://raw.githubusercontent.com/jkeloper/procman/main/scripts/install.sh',
  author: {
    name: 'jkeloper',
    url: 'https://github.com/jkeloper',
  },
  license: 'MIT',
  year: 2026,
  minMacOS: '14',
};

export type SiteConfig = typeof site;
