import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const BATCH_SIZE = Number(process.env.BATCH_SIZE || 10);
const DELAY_BETWEEN_JOBS_MS = Number(process.env.DELAY_BETWEEN_JOBS_MS || 1500);

const AI_MAX_RETRIES = Number(process.env.AI_MAX_RETRIES || 3);
const AI_RETRY_BASE_DELAY_MS = Number(process.env.AI_RETRY_BASE_DELAY_MS || 5000);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OPENAI_API_KEY) {
  throw new Error("Missing required env vars");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildHtmlContent(content) {
  return `<div dir="ltr">${content.english_html || ""}</div><hr/><div dir="rtl">${content.hebrew_html || ""}</div>`;
}

async function getPendingJobs() {
  const { data, error } = await supabase
    .from("open_position")
    .select("job_id, job_description")
    .is("job_description_html", null)
    .not("job_description", "is", null)
    .neq("job_description", "")
    .limit(BATCH_SIZE);

  if (error) throw error;

  return data || [];
}

async function callOpenAI(job) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `System Role: You are a specialist tech recruiter for "iin", a professional network for the Haredi community. Your goal is to transform raw job descriptions into a respectful, professional, and legally safe format.

Task:
1. Rewrite in English: paraphrase completely, keep a professional tone.
2. Translate to Hebrew: professional translation, culturally appropriate, standard professional male/neutral addressing.
3. Format as HTML: use <h3>, <ul>, <li>, and <p>.
4. Categorize.

You MUST return ONLY categories from this EXACT list:
[Development, QA, Data, Management, Product]

Rules:
- Do NOT invent new categories.
- If no category matches, return [].
- Return valid JSON only.

Output Format:
{
  "english_html": "...",
  "hebrew_html": "...",
  "categories": ["Category1", "Category2"]
}`
      },
      {
        role: "user",
        content: `Job Description:\n${job.job_description}`
      }
    ]
  });

  const rawContent = completion.choices?.[0]?.message?.content;

  if (!rawContent) {
    throw new Error("OpenAI returned empty content");
  }

  const parsed = JSON.parse(rawContent);

  if (!parsed.english_html && !parsed.hebrew_html) {
    throw new Error("OpenAI returned JSON without english_html/hebrew_html");
  }

  if (!Array.isArray(parsed.categories)) {
    parsed.categories = [];
  }

  return parsed;
}

async function processJobWithRetry(job) {
  let lastError;

  for (let attempt = 1; attempt <= AI_MAX_RETRIES; attempt++) {
    try {
      console.log(`🤖 Processing job ${job.job_id}, attempt ${attempt}/${AI_MAX_RETRIES}`);

      return await callOpenAI(job);
    } catch (err) {
      lastError = err;

      console.error(`❌ AI error for job ${job.job_id}, attempt ${attempt}:`, err.message);

      if (attempt < AI_MAX_RETRIES) {
        const waitMs = AI_RETRY_BASE_DELAY_MS * attempt;

        console.log(`⏳ Waiting ${waitMs}ms before retry...`);
        await delay(waitMs);
      }
    }
  }

  throw lastError;
}

async function updateJob(job, content) {
  const htmlContent = buildHtmlContent(content);

  const { data, error } = await supabase
    .from("open_position")
    .update({
      job_description_html: htmlContent,
      categories: content.categories || []
    })
    .eq("job_id", job.job_id)
    .is("job_description_html", null)
    .select("job_id");

  if (error) throw error;

  if (!data || data.length === 0) {
    console.log(`⚠️ Job ${job.job_id} was not updated, probably already processed by another run`);
    return false;
  }

  return true;
}

async function main() {
  console.log("🚀 Starting jobs AI processor");

  let totalProcessed = 0;
  let totalFailed = 0;
  let batchNumber = 0;

  while (true) {
    batchNumber += 1;

    const pendingJobs = await getPendingJobs();

    if (pendingJobs.length === 0) {
      console.log("✅ No pending jobs found. Finished.");
      break;
    }

    console.log(`📦 Batch ${batchNumber}: found ${pendingJobs.length} jobs without HTML`);

    for (const job of pendingJobs) {
      try {
        const content = await processJobWithRetry(job);

        const updated = await updateJob(job, content);

        if (updated) {
          totalProcessed += 1;
          console.log(`✅ Job ${job.job_id} updated successfully`);
        }

        await delay(DELAY_BETWEEN_JOBS_MS);
      } catch (err) {
        totalFailed += 1;
        console.error(`🚨 Job ${job.job_id} failed after all retries:`, err.message);

        /**
         * חשוב:
         * בלי שדה סטטוס/שגיאה, המשרה הזו תישאר job_description_html = null,
         * ולכן בריצה הבאה היא תישלף שוב.
         *
         * זה טוב אם רוצים שהיא תנסה שוב מחר.
         * אבל אם יש משרה שתמיד נכשלת, היא תחזור שוב ושוב בכל ריצה.
         */
      }
    }
  }

  console.log("🏁 Finished AI processing");
  console.log(`✅ Total processed: ${totalProcessed}`);
  console.log(`❌ Total failed: ${totalFailed}`);
}

main().catch((err) => {
  console.error("Critical error:", err);
  process.exit(1);
});
