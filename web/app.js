import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cfg = window.__APP_CONFIG__ ?? {};
const supabaseUrl = cfg.supabaseUrl ?? "";
const supabaseAnonKey = cfg.supabaseAnonKey ?? "";
const bucket = cfg.storageBucket ?? "resume-parser";
const functionSlug = cfg.functionSlug ?? "parse-resume";

const envUrlEl = document.getElementById("env-url");
const envKeyEl = document.getElementById("env-key");
const envBucketEl = document.getElementById("env-bucket");
const envFunctionEl = document.getElementById("env-function");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const payloadEl = document.getElementById("payload");
const copyPayloadBtn = document.getElementById("copyPayload");
const copyResultBtn = document.getElementById("copyResult");

const parseForm = document.getElementById("parse-form");
const fileInput = document.getElementById("fileInput");
const textInput = document.getElementById("resumeText");
const nameInput = document.getElementById("candidateName");
const jobIdInput = document.getElementById("jobId");
const userIdInput = document.getElementById("userId");
const submitButton = parseForm?.querySelector("button[type=submit]");

envUrlEl.textContent = supabaseUrl || "not set";
envKeyEl.textContent = supabaseAnonKey
  ? `${supabaseAnonKey.slice(0, 6)}...`
  : "not set";
envBucketEl.textContent = bucket;
envFunctionEl.textContent = functionSlug;

const isConfigured =
  supabaseUrl &&
  supabaseAnonKey &&
  supabaseAnonKey !== "YOUR_SUPABASE_ANON_KEY";

if (!isConfigured) {
  setStatus(
    "Update Supabase URL and anon key in window.__APP_CONFIG__ before testing.",
    "error",
  );
  if (submitButton) submitButton.disabled = true;
}

const supabase = isConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

function setStatus(message, tone = "info") {
  statusEl.textContent = message;
  statusEl.className = `status ${tone}`;
}

function formatJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function uploadFile(file) {
  if (!supabase) throw new Error("Supabase client not initialized");
  // Strictly sanitize to ASCII-safe characters to avoid storage InvalidKey errors
  const safeName = file.name
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-");
  const objectPath = `uploads/${crypto.randomUUID()}-${safeName}`;
  const { error } = await supabase.storage.from(bucket).upload(
    objectPath,
    file,
    {
      cacheControl: "3600",
      upsert: false,
      contentType: file.type || "application/octet-stream",
    },
  );

  if (error) throw error;
  return { bucket, filePath: objectPath };
}

async function callFunction(payload) {
  const endpoint = `${supabaseUrl}/functions/v1/${functionSlug}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error || `Request failed with ${res.status}`;
    throw new Error(message);
  }
  return data;
}

function rememberPayload(payload) {
  payloadEl.textContent = formatJson(payload);
}

function showResult(result) {
  resultEl.textContent = formatJson(result);
}

async function handleSubmit(event) {
  event.preventDefault();
  if (!supabase) return;

  const file = fileInput.files?.[0];
  const text = textInput.value.trim();

  if (!file && !text) {
    setStatus("Provide resume text or upload a PDF/text file.", "error");
    return;
  }

  const payload = {
    candidateName: nameInput.value || undefined,
    jobId: jobIdInput.value || undefined,
    userId: userIdInput.value || undefined,
  };

  try {
    submitButton.disabled = true;
    setStatus("Preparing request...", "info");

    if (file) {
      setStatus("Uploading to Supabase Storage...", "info");
      const storageRef = await uploadFile(file);
      payload.bucket = storageRef.bucket;
      payload.filePath = storageRef.filePath;
    } else {
      payload.text = text;
    }

    rememberPayload(payload);
    setStatus("Calling Edge Function...", "info");

    const response = await callFunction(payload);
    showResult(response);
    setStatus("Parsed successfully.", "success");
  } catch (error) {
    console.error(error);
    showResult({ error: error instanceof Error ? error.message : String(error) });
    setStatus("Error: see details below.", "error");
  } finally {
    submitButton.disabled = false;
  }
}

function setupCopy(button, target) {
  button?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(target.textContent || "");
      button.textContent = "Copied!";
      setTimeout(() => (button.textContent = "Copy JSON"), 1200);
    } catch (error) {
      console.error(error);
    }
  });
}

parseForm?.addEventListener("submit", handleSubmit);
setupCopy(copyPayloadBtn, payloadEl);
setupCopy(copyResultBtn, resultEl);

if (resultEl) {
  resultEl.textContent = "Waiting for response...";
}

