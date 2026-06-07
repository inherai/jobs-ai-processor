import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const BATCH_SIZE = Number(process.env.BATCH_SIZE || 10);
const MAX_JOBS_PER_RUN = Number(process.env.MAX_JOBS_PER_RUN || 100);
const DELAY_MS = Number(process.env.DELAY_MS || 1500);

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
    .limit(BATCH_SIZE);

  if (error) throw error;

  return data || [];
}

async function processJobWithAI(job) {
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

  return JSON.parse(rawContent);
}

async function updateJob(job, content) {
  const htmlContent = buildHtmlContent(content);

  const { error } = await supabase
    .from("open_position")
    .update({
      job_description_html: htmlContent,
      categories: content.categories || []
    })
    .eq("job_id", job.job_id)
    .is("job_description_html", null);

  if (error) throw error;
}

async function main() {
  console.log("🚀 Starting jobs AI processor");

  let totalProcessed = 0;

  while (totalProcessed < MAX_JOBS_PER_RUN) {
    const pendingJobs = await getPendingJobs();

    if (pendingJobs.length === 0) {
      console.log("✅ No pending jobs found");
      break;
    }

    console.log(`📝 Found ${pendingJobs.length} jobs without HTML`);

    for (const job of pendingJobs) {
      try {
        console.log(`🤖 Processing job ${job.job_id}`);

        const content = await processJobWithAI(job);
        await updateJob(job, content);

        totalProcessed += 1;

        console.log(`✅ Job ${job.job_id} updated successfully`);

        await delay(DELAY_MS);
      } catch (err) {
        console.error(`❌ Error processing job ${job.job_id}:`, err.message);
      }
    }
  }

  console.log(`🏁 Finished. Total processed: ${totalProcessed}`);
}

main().catch((err) => {
  console.error("Critical error:", err);
  process.exit(1);
});
