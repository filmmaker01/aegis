# Upstream template & license

`aegis-app` was bootstrapped from the **Vibe Coding Template**.

- Source: https://github.com/di-sukharev/vibe
- License: **Apache-2.0** (see [LICENSE](LICENSE)).
- Copyright: © 2026 Dima Sukharev (original author). See [NOTICE](NOTICE).

The Apache-2.0 license permits use, modification, and distribution provided the license and
NOTICE are retained — both are kept in this package.

## What we changed on bootstrap
- Copied the template's **default branch** into `aegis-app/` **without** the upstream `.git`,
  so there is no foreign `origin`. `aegis-app` is part of the Aegis repository.
- Renamed the **root** `package.json` name to `aegis-app`.
- Security: bumped `hono` `^4.12.19 → 4.12.30` (targeted). Other advisories documented in
  [SECURITY.md](SECURITY.md) rather than blind-updated.
- Removed the template's `Bootstrap-Only Instructions` block from `CLAUDE.md` / `AGENTS.md`
  (as the template instructs after first-run setup).
- Preserved the template's original README at `docs/VIBE_TEMPLATE_README.md`.

## Deferred cleanups (intentional, to keep the diff minimal)
- Workspace package **scopes** (`@web-app-demo/*`) are left unchanged because they are
  referenced by imports; renaming them is a mechanical refactor to do later, not now.
- The `mobile` surface remains a pointer (template default branch); not used by Aegis yet.
