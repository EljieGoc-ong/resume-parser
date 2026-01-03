// @ts-nocheck
/**
 * Supabase Edge Function: parse-resume
 *
 * Accepts either raw resume text or a storage reference to a PDF/text file.
 * Extracts text (best effort for PDFs), sends it to OpenAI for structured
 * parsing, and stores the result in the `resumes` table.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const PARSER_VERSION = "llamaparse-v1";
const MAX_TEXT_STORE = 50000;
const LLAMA_API = "https://api.cloud.llamaindex.ai/api/v1/parsing";
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_MS = 60000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const env = {
  supabaseUrl: Deno.env.get("SUPABASE_URL"),
  supabaseKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  llamaKey: Deno.env.get("LLAMA_PARSE_API_KEY"),
};

if (!env.supabaseUrl || !env.supabaseKey || !env.llamaKey) {
  console.error("Missing required environment variables");
}

const supabase = env.supabaseUrl && env.supabaseKey
  ? createClient(env.supabaseUrl, env.supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
  : null;

type ResumeRequest = {
  text?: string;
  bucket?: string;
  filePath?: string;
  candidateName?: string;
  jobId?: string;
  userId?: string;
};

type ParsedResume = {
  markdown?: string;
  jobId?: string;
  source?: "llamaparse";
};

const respond = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function inferExt(filePath?: string) {
  if (!filePath) return undefined;
  const parts = filePath.split(".");
  return parts.length > 1 ? parts.pop()?.toLowerCase() : undefined;
}

type ResumeInput = {
  buffer: Uint8Array;
  filename: string;
  contentType: string;
};

async function loadResumeInput(body: ResumeRequest): Promise<ResumeInput> {
  if (body.text && body.text.trim().length > 0) {
    const encoder = new TextEncoder();
    return {
      buffer: encoder.encode(body.text),
      filename: "resume.txt",
      contentType: "text/plain",
    };
  }

  if (!supabase) throw new Error("Supabase client not initialized");
  if (!body.bucket || !body.filePath) {
    throw new Error("Provide either `text` or (`bucket` and `filePath`)");
  }

  const { data, error } = await supabase.storage
    .from(body.bucket)
    .download(body.filePath);

  if (error || !data) {
    throw new Error(`Unable to download file: ${error?.message ?? "unknown"}`);
  }

  const buffer = new Uint8Array(await data.arrayBuffer());
  const ext = inferExt(body.filePath) ?? "bin";
  const contentType = data.type || "application/octet-stream";

  return {
    buffer,
    filename: `resume.${ext}`,
    contentType,
  };
}

async function uploadToLlamaParse(input: ResumeInput): Promise<string> {
  if (!env.llamaKey) throw new Error("LLAMA_PARSE_API_KEY is missing");

  const form = new FormData();
  form.append("file", new Blob([input.buffer], { type: input.contentType }), input.filename);
  form.append("tier", "agentic_plus");
  form.append("version", "latest");
  form.append("high_res_ocr", "true");
  form.append("adaptive_long_table", "true");
  form.append("outlined_table_extraction", "true");
  form.append("output_tables_as_HTML", "true");
  form.append("max_pages", "0");
  form.append("precise_bounding_box", "true");

  const res = await fetch(`${LLAMA_API}/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.llamaKey}`,
    },
    body: form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LlamaParse upload failed: ${err}`);
  }

  const json = await res.json();
  return json.id as string;
}

async function pollLlamaParseMarkdown(jobId: string): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < POLL_MAX_MS) {
    const res = await fetch(`${LLAMA_API}/job/${jobId}/result/markdown`, {
      headers: { Authorization: `Bearer ${env.llamaKey}` },
    });

    if (res.ok) {
      const raw = await res.text();
      try {
        const json = JSON.parse(raw);
        if (json && typeof json.markdown === "string") return json.markdown;
      } catch (_) {
        // if response isn't valid JSON, assume raw markdown string
      }
      return raw;
    }

    if (res.status === 400 || res.status === 404) {
      const detail = await res.json().catch(() => ({}));
      const message = typeof detail?.detail === "string"
        ? detail.detail
        : "";
      // LlamaParse returns 400/404 with "Job not completed yet" or "Result ... not found" while processing.
      if (
        message.includes("Job not completed yet")
        || message.includes("Result for Parsing Job")
      ) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }
      throw new Error(
        `LlamaParse job error: ${JSON.stringify(detail ?? "unknown")}`,
      );
    }

    const text = await res.text();
    throw new Error(`LlamaParse poll failed: ${text}`);
  }

  throw new Error("LlamaParse job timed out");
}

async function parseResumeWithLlamaParse(input: ResumeInput): Promise<ParsedResume> {
  const jobId = await uploadToLlamaParse(input);
  const markdown = await pollLlamaParseMarkdown(jobId);
  return { markdown, jobId, source: "llamaparse" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = (await req.json()) as ResumeRequest;

    const resumeInput = await loadResumeInput(body);
    const parsed = await parseResumeWithLlamaParse(resumeInput);

    if (!supabase) throw new Error("Supabase client not initialized");

    const { data, error } = await supabase.from("resumes").insert({
      candidate_name: body.candidateName ?? null,
      job_id: body.jobId ?? null,
      created_by: body.userId ?? null,
      file_bucket: body.bucket ?? null,
      file_path: body.filePath ?? null,
      raw_text:
        resumeInput.buffer.length > MAX_TEXT_STORE
          ? new TextDecoder().decode(
            resumeInput.buffer.slice(0, MAX_TEXT_STORE),
          )
          : new TextDecoder().decode(resumeInput.buffer),
      parsed,
      parser_version: PARSER_VERSION,
      status: "parsed",
    }).select().single();

    if (error) {
      throw new Error(error.message);
    }

    return respond(200, {
      resumeId: data?.id,
      parsed,
      parserVersion: PARSER_VERSION,
    });
  } catch (error) {
    console.error(error);
    return respond(
      400,
      { error: error instanceof Error ? error.message : "Unknown error" },
    );
  }
});

