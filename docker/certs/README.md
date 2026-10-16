# TLS certificates

`docker-compose.prod.yml` mounts this directory at `/etc/nginx/certs` read-only.
nginx expects exactly two files here and **exits at startup if they are
missing** — it does not fall back to http:

- `fullchain.pem`
- `privkey.pem`

Neither is in version control, and neither should ever be. `.gitignore` covers
them; the directory is kept so the bind mount resolves to a directory you own
rather than one Docker creates as root.

See `docs/DEPLOYMENT.md` for obtaining them with Let's Encrypt, or for pointing
nginx at certificates you already hold.
