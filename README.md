# Serverless Resume Parser (Supabase)

A Supabase Edge Function that ingests resumes (text or PDF from Supabase Storage), parses them with OpenAI, and stores structured results in a `resumes` table.

## What’s included
- Edge Function: `supabase/functions/parse-resume`
- Schema: `supabase/migrations/0001_create_resumes.sql`
- OpenAI-powered parsing with PDF text extraction (best effort via `pdfjs-dist`)

## Prerequisites
- Supabase CLI: <https://supabase.com/docs/guides/cli>
- Node/Deno (Bundled with Supabase functions runtime)
- OpenAI API key

## Setup
1) Init Supabase (creates `supabase/config.toml` if you don’t have one):
   ```bash
   supabase init
   ```
2) Create an env file for the function (example: `.env.local`):
   ```bash
   SUPABASE_URL=https://<your-project-ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
   OPENAI_API_KEY=<your-openai-api-key>
   ```
3) Apply schema locally (or via SQL editor in the dashboard):
   ```bash
   supabase db push
   ```

## Run locally
Start the local Supabase stack (if you want storage/db locally):
```bash
supabase start
```

Serve the function locally with env vars:
```bash
supabase functions serve parse-resume --env-file .env.local
```
The function will be available at:
```
http://localhost:54321/functions/v1/parse-resume
```

## Deploy to Supabase
Deploy the function:
```bash
supabase functions deploy parse-resume --project-ref <project-ref> --env-file .env.local
```

## Frontend demo (static)
- Location: `web/`
- Configure: edit `web/index.html` and set `window.__APP_CONFIG__` (`supabaseUrl`, `supabaseAnonKey`, `storageBucket`, `functionSlug`).
- Serve locally (pick one):
  - `npx serve web`
  - `python -m http.server 4173 --directory web`
- Open the served URL and submit a PDF/text file or pasted text. Files are uploaded to the configured bucket before calling the Edge Function.
- Ensure the storage bucket exists (default `resumes`) and that your Storage policies allow the client role you use (anon/authenticated) to insert into that bucket.

## Request payload
POST to `/functions/v1/parse-resume`:
```json
{
  "text": "plain resume text here",           // optional if using storage
  "bucket": "resumes",                        // storage bucket
  "filePath": "uploads/jane.pdf",             // storage path
  "candidateName": "Jane Doe",                // optional override
  "jobId": "role-123",                        // optional metadata
  "userId": "<auth-user-id>"                  // optional, for RLS ownership
}
```

Notes:
- If `text` is provided, storage download is skipped.
- PDF extraction is best effort; plain text works fastest.
- Other file types are rejected; convert to PDF or text first.

## Response
```json
{
  "resumeId": "<uuid>",
  "parsed": {
    "name": "...",
    "email": "...",
    "skills": ["..."],
    "experience": [ ... ],
    "education": [ ... ],
    "links": ["..."]
  },
  "parserVersion": "v2026-01-03"
}
```

## Table access control
Row Level Security is enabled on `public.resumes`. Policies allow users to insert and read rows where `created_by` matches `auth.uid()`. The service role key (used by the Edge Function) bypasses RLS, so user ownership must be provided via `userId` when inserting if you want rows readable by that user.

## Testing with curl
Plain text:
```bash
curl -X POST http://localhost:54321/functions/v1/parse-resume \
  -H "Content-Type: application/json" \
  -d '{"text":"Jane Doe ... resume text ...", "userId":"<auth-user-id>"}'
```

PDF from storage (ensure the file exists in the bucket/path):
```bash
curl -X POST http://localhost:54321/functions/v1/parse-resume \
  -H "Content-Type: application/json" \
  -d '{"bucket":"resumes","filePath":"uploads/jane.pdf"}'
```

## Notes and gotchas
- OpenAI input is truncated to ~12k chars to keep latency predictable.
- Raw text stored in DB is truncated to ~50k chars.
- Errors return HTTP 400 with an `error` message payload.

npx supabase functions deploy parse-resume --project-ref ljvoozqquaqaowoakldr