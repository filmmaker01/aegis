# Media storage in production (S3 / Supabase Storage)

The media worker stores blobs through the `MediaStorage` port. Local disk is the dev fallback;
production uses an S3-compatible bucket. Switching is env-only — **no code change**.

Set `MEDIA_STORAGE=s3` and provide the S3 config (reused from the template's `SPACES_*` vars):

```dotenv
MEDIA_STORAGE=s3
SPACES_REGION=...            # e.g. fra1 (DO), us-east-1 (AWS), or your Supabase region
SPACES_BUCKET=...            # bucket / Space / Supabase bucket name
SPACES_ENDPOINT=...          # S3-compatible endpoint (see below)
SPACES_ACCESS_KEY_ID=...     # keep in .env / secret manager only — never commit
SPACES_SECRET_ACCESS_KEY=...
```

Objects are written **private** (`ACL: private`). The worker reads them back server-side to
re-send on deletion; it never generates or logs public URLs.

## Endpoints

- **Supabase Storage (S3-compatible):**
  `SPACES_ENDPOINT=https://<project-ref>.supabase.co/storage/v1/s3`
  `SPACES_REGION=<your project region>` · create a bucket and S3 access keys in
  Supabase → Storage → S3 Connection. (Supabase Storage exposes an S3 protocol endpoint.)
- **DigitalOcean Spaces:** `SPACES_ENDPOINT=https://<region>.digitaloceanspaces.com` (the
  template's default target).
- **AWS S3:** `SPACES_ENDPOINT=https://s3.<region>.amazonaws.com`.

## Verify (once keys are provided)
1. Put the vars in `backend/.env` (or the deploy secret store).
2. Start the backend; the media factory picks S3 automatically when `MEDIA_STORAGE=s3`.
3. Run a media deletion e2e (same as the local one) — the saved copy should be fetched from
   the bucket and re-sent.

> Do not ask for or commit real keys until an S3/Supabase target is actually being deployed.
> Until then, `MEDIA_STORAGE=local` is the working default for development and the live tests.

## Notes / follow-ups
- Retention/GC: deleting a media row should also delete its bucket object (not yet wired —
  add a storage `delete(key)` call in the retention job).
- Large files: Bot API `getFile` download caps at ~20 MB without a self-hosted Bot API server;
  larger media is marked `failed` (permanent) and the owner gets an honest text note.
