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
const structuredGrid = document.getElementById("structuredGrid");
const sName = document.getElementById("s-name");
const sEmail = document.getElementById("s-email");
const sPhone = document.getElementById("s-phone");
const sLocation = document.getElementById("s-location");
const sSummary = document.getElementById("s-summary");
const sSkills = document.getElementById("s-skills");
const sExperience = document.getElementById("s-experience");
const sEducation = document.getElementById("s-education");
const sProjects = document.getElementById("s-projects");
const sCerts = document.getElementById("s-certifications");
const sLinks = document.getElementById("s-links");

const parseForm = document.getElementById("parse-form");
const fileInput = document.getElementById("fileInput");
const textInput = document.getElementById("resumeText");
const nameInput = document.getElementById("candidateName");
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

function extractMarkdown(result) {
  // Handle several shapes:
  // 1) result.parsed.markdown is already markdown string
  // 2) result.parsed.markdown is a JSON string containing { markdown: "..." }
  // 3) result.parsed is a JSON string containing { markdown: "..." }
  const parsedField = result?.parsed;

  // If parsed itself is a JSON string, try to parse it first.
  if (typeof parsedField === "string") {
    try {
      const parsedObj = JSON.parse(parsedField);
      if (parsedObj && typeof parsedObj.markdown === "string") {
        return parsedObj.markdown;
      }
    } catch {
      // ignore
    }
  }

  const maybe = parsedField?.markdown;
  if (typeof maybe === "string") {
    try {
      const parsed = JSON.parse(maybe);
      if (parsed && typeof parsed.markdown === "string") return parsed.markdown;
    } catch {
      // fall through
    }
    return maybe;
  }

  return null;
}

function extractStructured(result) {
  if (!result?.parsed) return null;
  if (result.parsed.structured) return result.parsed.structured;
  if (typeof result.parsed === "string") {
    try {
      const parsed = JSON.parse(result.parsed);
      if (parsed?.structured) return parsed.structured;
    } catch {
      return null;
    }
  }
  return null;
}

function renderStructured(structured) {
  if (!structured || typeof structured !== "object") return null;
  const lines = [];

  const push = (label, value) => {
    if (value === null || value === undefined || value === "") return;
    lines.push(`${label}: ${value}`);
  };

  push("Name", structured.name);
  push("Email", structured.email);
  push("Phone", structured.phone);
  push("Location", structured.location);
  push("Summary", structured.summary);

  if (Array.isArray(structured.skills) && structured.skills.length) {
    lines.push("");
    lines.push("Skills:");
    lines.push(structured.skills.join(", "));
  }

  if (Array.isArray(structured.experience) && structured.experience.length) {
    lines.push("");
    lines.push("Experience:");
    structured.experience.forEach((exp) => {
      const header = [exp.title, exp.company].filter(Boolean).join(" @ ") || "Role";
      const dates = [exp.start_date, exp.end_date].filter(Boolean).join(" → ");
      lines.push(`- ${header}${dates ? ` (${dates})` : ""}`);
      if (Array.isArray(exp.bullets) && exp.bullets.length) {
        exp.bullets.forEach((b) => lines.push(`  • ${b}`));
      }
    });
  }

  if (Array.isArray(structured.education) && structured.education.length) {
    lines.push("");
    lines.push("Education:");
    structured.education.forEach((ed) => {
      const header = [ed.degree, ed.school].filter(Boolean).join(" @ ") || "Education";
      const dates = [ed.start_date, ed.end_date].filter(Boolean).join(" → ");
      lines.push(`- ${header}${dates ? ` (${dates})` : ""}`);
    });
  }

  if (Array.isArray(structured.projects) && structured.projects.length) {
    lines.push("");
    lines.push("Projects:");
    structured.projects.forEach((p) => {
      const header = p.name || "Project";
      lines.push(`- ${header}`);
      if (p.description) lines.push(`  • ${p.description}`);
      if (Array.isArray(p.tech) && p.tech.length) lines.push(`  • Tech: ${p.tech.join(", ")}`);
      if (Array.isArray(p.links) && p.links.length) lines.push(`  • Links: ${p.links.join(", ")}`);
    });
  }

  if (Array.isArray(structured.certifications) && structured.certifications.length) {
    lines.push("");
    lines.push("Certifications:");
    structured.certifications.forEach((c) => lines.push(`- ${c}`));
  }

  if (Array.isArray(structured.links) && structured.links.length) {
    lines.push("");
    lines.push(`Links: ${structured.links.join(", ")}`);
  }

  return lines.length ? lines.join("\n") : null;
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
  const structured = extractStructured(result);
  const structuredText = structured ? renderStructured(structured) : null;
  if (structuredText && structuredGrid) {
    resultEl.textContent = structuredText;
    structuredGrid.style.display = "grid";
    if (sName) sName.textContent = structured.name ?? "—";
    if (sEmail) sEmail.textContent = structured.email ?? "—";
    if (sPhone) sPhone.textContent = structured.phone ?? "—";
    if (sLocation) sLocation.textContent = structured.location ?? "—";
    if (sSummary) sSummary.textContent = structured.summary ?? "—";

    const setList = (el, values) => {
      if (!el) return;
      el.innerHTML = "";
      if (Array.isArray(values) && values.length) {
        values.forEach((v) => {
          const li = document.createElement("li");
          li.textContent = v;
          el.appendChild(li);
        });
      } else {
        const li = document.createElement("li");
        li.textContent = "—";
        el.appendChild(li);
      }
    };

    setList(sSkills, structured.skills);
    setList(sCerts, structured.certifications);
    setList(sLinks, structured.links);

    const renderBlocks = (el, items, formatter) => {
      if (!el) return;
      el.innerHTML = "";
      if (Array.isArray(items) && items.length) {
        items.forEach((item) => {
          const div = document.createElement("div");
          div.className = "block";
          div.textContent = formatter(item);
          el.appendChild(div);
        });
      } else {
        const div = document.createElement("div");
        div.textContent = "—";
        el.appendChild(div);
      }
    };

    renderBlocks(
      sExperience,
      structured.experience,
      (exp) =>
        `${[exp.title, exp.company].filter(Boolean).join(" @ ") || "Role"}${
          [exp.start_date, exp.end_date].filter(Boolean).join(" → ") ? ` (${[exp.start_date, exp.end_date].filter(Boolean).join(" → ")})` : ""
        }${Array.isArray(exp.bullets) && exp.bullets.length ? ` — ${exp.bullets.join(" · ")}` : ""}`,
    );

    renderBlocks(
      sEducation,
      structured.education,
      (ed) =>
        `${[ed.degree, ed.school].filter(Boolean).join(" @ ") || "Education"}${
          [ed.start_date, ed.end_date].filter(Boolean).join(" → ") ? ` (${[ed.start_date, ed.end_date].filter(Boolean).join(" → ")})` : ""
        }`,
    );

    renderBlocks(
      sProjects,
      structured.projects,
      (p) =>
        `${p.name || "Project"}${p.description ? ` — ${p.description}` : ""}${
          Array.isArray(p.tech) && p.tech.length ? ` (Tech: ${p.tech.join(", ")})` : ""
        }${Array.isArray(p.links) && p.links.length ? ` [${p.links.join(", ")}]` : ""}`,
    );
    return;
  } else if (structuredGrid) {
    structuredGrid.style.display = "none";
  }

  const markdown = extractMarkdown(result);
  if (markdown) {
    resultEl.textContent = markdown;
    return;
  }

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
    // candidateName: nameInput.value || undefined,
  };

  try {
    submitButton.disabled = true;
    setStatus("Preparing request...", "info");

    if (file) {
      setStatus("Procesing data for extraction...", "info");
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

