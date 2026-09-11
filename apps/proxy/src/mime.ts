const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.wasm': 'application/wasm',
};

const IMMUTABLE = /\.[0-9a-f]{8,}\.(js|css|woff2?|png|jpe?g|svg|webp|avif)$/i;

export function contentType(ext: string): string {
  return TYPES[ext.toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Cache policy matching Vercel's defaults: fingerprinted assets are immutable,
 * HTML is always revalidated.
 */
export function cacheControl(pathname: string, ext: string): string {
  if (IMMUTABLE.test(pathname)) return 'public, max-age=31536000, immutable';
  if (pathname.includes('/_next/static/') || pathname.includes('/assets/')) {
    return 'public, max-age=31536000, immutable';
  }
  if (ext === '.html' || ext === '') return 'public, max-age=0, must-revalidate';
  return 'public, max-age=3600';
}
