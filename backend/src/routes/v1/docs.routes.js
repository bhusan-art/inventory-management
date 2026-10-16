import { Router } from 'express';
import { buildOpenApiDocument } from '../../services/docs/openApiService.js';
import env from '../../config/env.js';

/**
 * API documentation.
 *
 * Unauthenticated in development so it is usable while building, and OFF by
 * default in production: a complete map of every endpoint and the permission
 * guarding it is a reconnaissance gift. Set DOCS_ENABLED=true to serve it
 * there, deliberately, behind whatever the deployment puts in front.
 *
 * The viewer is a single self-contained page with no CDN. A docs page that
 * fetches a script from the internet does not work on an air-gapped deployment,
 * and this system is built for firms that have those.
 */
export const docsRouter = Router();

const enabled = () => !env.isProduction || env.DOCS_ENABLED === 'true';

docsRouter.use((req, res, next) => {
  if (!enabled()) {
    return res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Not found' });
  }
  return next();
});

// The spec itself, for tooling: Postman, client generators, contract tests.
docsRouter.get('/openapi.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // `req.app` is the running app: no second instance, no extra rate limiter.
  return res.json(buildOpenApiDocument({ app: req.app, version: process.env.npm_package_version ?? '0.1.0' }));
});

docsRouter.get('/', (req, res) => {
  const doc = buildOpenApiDocument({ app: req.app, version: process.env.npm_package_version ?? '0.1.0' });

  const byTag = new Map();
  for (const [path, operations] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      const tag = operation.tags[0];
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push({ method: method.toUpperCase(), path, operation });
    }
  }

  const METHOD_COLOUR = {
    GET: '#2a78d6', POST: '#1baf7a', PUT: '#eda100', PATCH: '#eb6834', DELETE: '#d03b3b',
  };

  const sections = [...byTag.entries()].sort().map(([tag, rows]) => `
    <section>
      <h2 id="${esc(tag)}">${esc(tag)} <span class="count">${rows.length}</span></h2>
      <table>
        <tbody>
          ${rows.sort((a, b) => a.path.localeCompare(b.path)).map((r) => `
            <tr>
              <td><code class="m" style="background:${METHOD_COLOUR[r.method] ?? '#64748b'}">${r.method}</code></td>
              <td><code>${esc(r.path)}</code></td>
              <td>${(r.operation['x-required-permissions'] ?? [])
                .map((p) => `<span class="perm">${esc(p)}</span>`).join(' ')
                || '<span class="auth">authenticated</span>'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </section>`).join('');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");

  return res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(doc.info.title)}</title>
<style>
  :root { color-scheme: light }
  body { font: 14px/1.55 ui-sans-serif,system-ui,sans-serif; margin: 0; background:#f8fafc; color:#0f172a }
  .wrap { max-width: 980px; margin: 0 auto; padding: 32px 20px 64px }
  h1 { font-size: 20px; margin: 0 0 4px }
  .lede { color:#475569; white-space: pre-line; margin: 0 0 24px; font-size: 13px }
  nav { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:28px }
  nav a { font-size:12px; text-decoration:none; color:#334155; border:1px solid #cbd5e1;
          border-radius:999px; padding:2px 10px; background:#fff }
  section { background:#fff; border:1px solid #e2e8f0; border-radius:8px; margin-bottom:16px; overflow:hidden }
  h2 { font-size:14px; margin:0; padding:10px 16px; border-bottom:1px solid #e2e8f0; background:#f8fafc }
  .count { color:#64748b; font-weight:400; font-size:12px }
  table { width:100%; border-collapse:collapse }
  td { padding:6px 16px; border-bottom:1px solid #f1f5f9; vertical-align:top }
  tr:last-child td { border-bottom:0 }
  code { font: 12px ui-monospace,SFMono-Regular,Menlo,monospace }
  code.m { color:#fff; padding:1px 6px; border-radius:4px; font-size:11px; font-weight:600 }
  td:first-child { width:70px }
  .perm { font: 11px ui-monospace,monospace; background:#f1f5f9; border:1px solid #e2e8f0;
          border-radius:4px; padding:1px 5px; color:#334155; white-space:nowrap }
  .auth { font-size:11px; color:#94a3b8 }
  footer { color:#64748b; font-size:12px; margin-top:24px }
</style></head>
<body><div class="wrap">
  <h1>${esc(doc.info.title)} <code>v${esc(doc.info.version)}</code></h1>
  <p class="lede">${esc(doc.info.description)}</p>
  <nav>${[...byTag.keys()].sort().map((t) => `<a href="#${esc(t)}">${esc(t)}</a>`).join('')}</nav>
  ${sections}
  <footer>
    ${Object.keys(doc.paths).length} paths ·
    <a href="openapi.json">openapi.json</a> for Postman or a client generator.
  </footer>
</div></body></html>`);
});

/** HTML-escapes a value. Everything here is ours, but a doc page that renders
 *  route strings unescaped is one odd route away from being an XSS sink. */
function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export default docsRouter;
