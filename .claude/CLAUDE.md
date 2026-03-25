# StreamVault Backend

Self-hosted IPTV backend wrapping Xtream Codes provider API.

## Full Context

- Project context: `~/claude-dotfiles/context/streamvault.md`
- Technical gotchas: `~/claude-dotfiles/context/infrastructure.md` (StreamVault/IPTV + CI/CD SSH sections)
- Project index: `~/claude-dotfiles/projects/streamvault/README.md`

## Tech Stack

- Express + TypeScript + vitest
- JWT httpOnly cookies (15min access, 90-day refresh with DB expires_at)
- CSRF protection via double-submit cookie
- Xtream Codes API wrapper with node-cache + exponential backoff
- 13 routers, 5 services, 5 middleware, 229 tests passing
- Provider Abstraction Layer: IStreamProvider + BaseStreamProvider + XtreamProvider + Factory + provider-agnostic types (CatalogItem, CatalogItemDetail, StreamInfo, EPGEntry, AccountInfo) + 8 adapter functions in xtream.adapters.ts

## Key Files

- `src/config.ts` -- Environment config, token lifetimes
- `src/services/` -- Business logic (auth, stream, epg, favorites, history)
- `src/routers/` -- Express route handlers
- `src/providers/` -- Provider abstraction (IStreamProvider, XtreamProvider, factory)
- `docs/adding-a-provider.md` -- Guide for new provider implementations

## Working Rules

- Follow `~/claude-dotfiles/claude/rules/` (git workflow, security, deploy-via-cicd)
- Never hardcode secrets — all config via environment variables
- Use bcryptjs (NOT bcrypt) — bcrypt segfaults on Alpine
- Add User-Agent header for all Xtream Codes requests (Cloudflare blocks missing UA)
- Parameterized SQL only — no string concatenation

## Testing

```bash
npm test          # vitest, 229 tests
npm run build     # TypeScript compilation check
```

## Deploy

- CI/CD: GitHub Actions (`appleboy/ssh-action@v1`) on merge to main
- Docker: `streamvault_api` container, port 3001, 768MB limit
- Manual deploy (if CI fails): `cd ~/ai-orchestration && docker compose up -d --build streamvault_api`

## Security

- NEVER mention StreamVault publicly (IPTV legal sensitivity)
- All provider credentials stored in .env only
- CT logs expose subdomain — access hardening TODO
