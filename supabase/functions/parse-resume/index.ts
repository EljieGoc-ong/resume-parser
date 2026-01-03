// @ts-nocheck
/**
 * Supabase Edge Function: parse-resume
 *
 * Accepts either raw resume text or a storage reference to a PDF/text file.
 * Extracts text (best effort for PDFs), sends it to OpenAI for structured
 * parsing, and stores the result in the `resumes` table.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const PARSER_VERSION = "llamaextract-http-v1";
const MAX_TEXT_STORE = 50000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const env = {
  supabaseUrl: Deno.env.get("SUPABASE_URL"),
  supabaseKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  llamaApiKey: Deno.env.get("LLAMA_CLOUD_API_KEY") ?? Deno.env.get("LLAMA_PARSE_API_KEY"),
  llamaAgentId: Deno.env.get("LLAMA_AGENT_ID"),
};

if (!env.supabaseUrl || !env.supabaseKey || !env.llamaApiKey) {
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
  structured?: unknown;
  jobId?: string;
  source?: "llamaextract";
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

// Define structured schema for extraction
const EXTRACTION_SCHEMA = {
  additionalProperties: false,
  type: "object",
  properties: {
    name: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "The full name of the resume owner. Preserves original casing.",
    },
    email: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "The email address of the resume owner.",
    },
    phone: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description:
        "The phone number of the resume owner. Includes country code if present. Should contain only digits and symbols.",
    },
    location: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "The geographical location of the resume owner (e.g., city, state, country).",
    },
    summary: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "A professional summary or objective statement from the resume.",
    },
    skills: {
      description: "A flat list of skills and keywords mentioned in the resume. Skills should be deduplicated.",
      type: "array",
      items: { type: "string" },
    },
    experience: {
      description: "A list of professional work experiences.",
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          company: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "The name of the company where the experience was gained.",
          },
          title: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "The job title held at the company. Preserves original casing.",
          },
          start_date: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Start date. Format: YYYY, YYYY-MM, or YYYY-MM-DD (ISO-8601).",
          },
          end_date: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "End date. Format: YYYY, YYYY-MM, YYYY-MM-DD (ISO-8601), or 'Present' if ongoing.",
          },
          bullets: {
            description: "Concise responsibilities/achievements.",
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["company", "title", "start_date", "end_date", "bullets"],
      },
    },
    education: {
      description: "A list of educational qualifications.",
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          school: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "The name of the educational institution.",
          },
          degree: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "The degree or qualification obtained.",
          },
          start_date: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Start date. Format: YYYY, YYYY-MM, or YYYY-MM-DD (ISO-8601).",
          },
          end_date: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "End date. Format: YYYY, YYYY-MM, or YYYY-MM-DD (ISO-8601).",
          },
        },
        required: ["school", "degree", "start_date", "end_date"],
      },
    },
    projects: {
      description: "A list of personal or professional projects.",
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "The name of the project.",
          },
          description: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "A brief description of the project.",
          },
          tech: {
            anyOf: [
              { type: "array", items: { type: "string" } },
              { type: "null" },
            ],
            description: "Technologies used.",
          },
          links: {
            anyOf: [
              { type: "array", items: { type: "string" } },
              { type: "null" },
            ],
            description: "URLs related to the project.",
          },
        },
        required: ["name", "description", "tech", "links"],
      },
    },
    certifications: {
      description: "A list of certifications obtained by the resume owner.",
      type: "array",
      items: { type: "string" },
    },
    links: {
      description: "A list of URLs (e.g., portfolio, LinkedIn, GitHub). Deduplicate.",
      type: "array",
      items: { type: "string" },
    },
  },
  required: [
    "name",
    "email",
    "phone",
    "location",
    "summary",
    "skills",
    "experience",
    "education",
    "projects",
    "certifications",
    "links",
  ],
};

const EXTRACTION_CONFIG = {
  priority: null,
  extraction_target: "PER_DOC",
  extraction_mode: "PREMIUM",
  parse_model: "anthropic-haiku-4.5",
  extract_model: "openai-gpt-4-1",
  multimodal_fast_mode: false,
  system_prompt: null,
  use_reasoning: false,
  cite_sources: false,
  citation_bbox: false,
  confidence_scores: false,
  chunk_mode: "PAGE",
  high_resolution_mode: false,
  invalidate_cache: false,
  num_pages_context: null,
  page_range: null,
};

const LLAMA_BASE = "https://api.cloud.llamaindex.ai/api/v1";

async function llamaUploadFile(input: ResumeInput) {
  const form = new FormData();
  form.append("upload_file", new Blob([input.buffer], { type: input.contentType }), input.filename);

  const res = await fetch(`${LLAMA_BASE}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.llamaApiKey}`,
      Accept: "application/json",
    },
    body: form,
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`LlamaExtract upload failed: ${raw.slice(0, 400)}`);
  const json = JSON.parse(raw);
  return json?.id as string;
}

async function llamaCreateJob(agentId: string, fileId: string) {
  const payload = {
    extraction_agent_id: agentId,
    file_id: fileId,
    data_schema: EXTRACTION_SCHEMA,
    config: EXTRACTION_CONFIG,
  };
  const res = await fetch(`${LLAMA_BASE}/extraction/jobs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.llamaApiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`LlamaExtract job create failed: ${raw.slice(0, 400)}`);
  const json = JSON.parse(raw);
  return json?.id as string;
}

async function llamaPollJob(jobId: string) {
  const res = await fetch(`${LLAMA_BASE}/extraction/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${env.llamaApiKey}`, Accept: "application/json" },
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`LlamaExtract job status failed: ${raw.slice(0, 400)}`);
  const json = JSON.parse(raw);
  return json as { status?: string };
}

async function llamaGetResult(jobId: string) {
  const res = await fetch(`${LLAMA_BASE}/extraction/jobs/${jobId}/result`, {
    headers: { Authorization: `Bearer ${env.llamaApiKey}`, Accept: "application/json" },
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`LlamaExtract result failed: ${raw.slice(0, 400)}`);
  const json = JSON.parse(raw);
  return json;
}

async function parseResumeWithLlamaExtract(input: ResumeInput): Promise<ParsedResume> {
  if (!env.llamaApiKey) throw new Error("LLAMA_CLOUD_API_KEY missing");
  if (!env.llamaAgentId) throw new Error("LLAMA_AGENT_ID missing (pre-create an extraction agent)");

  const fileId = await llamaUploadFile(input);
  const jobId = await llamaCreateJob(env.llamaAgentId, fileId);

  // poll for completion
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const status = await llamaPollJob(jobId);
    if (status?.status === "SUCCESS") break;
    if (status?.status === "FAILED") {
      throw new Error(`LlamaExtract job failed: ${JSON.stringify(status)}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  const result = await llamaGetResult(jobId);
  return {
    structured: result?.data ?? null,
    jobId,
    source: "llamaextract",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Robust JSON parsing; on failure return 400 without throwing parse errors
    const rawBody = await req.text();
    let body: ResumeRequest = {};
    try {
      const safeBody = (rawBody || "")
        // replace invalid \uXXXX escapes to avoid "unsupported Unicode escape sequence"
        .replace(/\\u(?![0-9a-fA-F]{4})/g, "\\uFFFD")
        // escape stray backslashes not starting a valid escape
        .replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
      body = JSON.parse(safeBody || "{}") as ResumeRequest;
    } catch {
      return respond(400, { error: "Invalid JSON body (escape sequences/backslashes)" });
    }

    const resumeInput = await loadResumeInput(body);
    const parsed = await parseResumeWithLlamaExtract(resumeInput);
    const rawText = body.text
      ? body.text
      : undefined;

    let resumeId: string | null = null;
    if (supabase) {
      const { data, error } = await supabase.from("resumes").insert({
        candidate_name: body.candidateName ?? (parsed.structured as { name?: string })?.name ?? null,
        job_id: body.jobId ?? null,
        created_by: body.userId ?? null,
        file_bucket: body.bucket ?? null,
        file_path: body.filePath ?? null,
        raw_text:
          rawText && rawText.length > MAX_TEXT_STORE
            ? rawText.slice(0, MAX_TEXT_STORE)
            : rawText ?? null,
        parsed,
        parser_version: PARSER_VERSION,
        status: "parsed",
      }).select("id").single();

      if (error) {
        console.error("Supabase insert error:", error);
      } else {
        resumeId = data?.id ?? null;
      }
    }

    return respond(200, {
      parsed,
      rawText,
      resumeId,
      jobId: parsed.jobId ?? null,
      parserVersion: PARSER_VERSION,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error(msg);
    if (msg.includes("unsupported Unicode escape sequence")) {
      return respond(400, {
        error: "Invalid JSON body (bad escape sequences/backslashes). Remove stray backslashes or ensure valid \\uXXXX.",
      });
    }
    return respond(400, { error: msg });
  }
});

