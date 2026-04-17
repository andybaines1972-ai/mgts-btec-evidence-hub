import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mammoth from "mammoth";
import pdf from "pdf-parse";
import JSZip from "jszip";
import Tesseract from "tesseract.js";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "120mb" }));

const PORT = process.env.PORT || 3000;

/* =========================
   ENV
========================= */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* =========================
   AUTH MIDDLEWARE
========================= */

async function requireAuth(req, res, next) {
  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "No token" });

    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: "Invalid token" });

    req.user = data.user;
    next();
  } catch {
    res.status(401).json({ error: "Auth failed" });
  }
}

/* =========================
   HELPERS
========================= */

const clean = (t="") => String(t).replace(/\s+/g," ").trim();

function tokenize(t="") {
  return clean(t)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g,"")
    .split(" ")
    .filter(x=>x.length>2);
}

function scoreChunk(chunk, criterion) {
  const a = tokenize(chunk);
  const b = tokenize(criterion);

  const overlap = b.filter(x=>a.includes(x)).length;
  return Math.round((overlap / (b.length || 1)) * 100);
}

/* =========================
   EXTRACTION
========================= */

async function extractDocx(buffer){
  const r = await mammoth.extractRawText({ buffer });
  return clean(r.value);
}

async function extractPdf(buffer){
  const r = await pdf(buffer);
  return clean(r.text);
}

async function extractPptx(buffer){
  const zip = await JSZip.loadAsync(buffer);
  let text = "";

  for (const f of Object.keys(zip.files)){
    if(f.includes("slide")){
      const xml = await zip.files[f].async("text");
      text += xml.replace(/<[^>]+>/g," ") + " ";
    }
  }
  return clean(text);
}

async function extractImage(buffer){
  const r = await Tesseract.recognize(buffer, "eng");
  return clean(r.data.text);
}

async function extract(file){
  const buffer = Buffer.from(file.fileBase64, "base64");
  const name = file.filename.toLowerCase();

  try{
    if(name.endsWith(".docx")) return await extractDocx(buffer);
    if(name.endsWith(".pdf")) return await extractPdf(buffer);
    if(name.endsWith(".pptx")) return await extractPptx(buffer);
    if(/\.(png|jpg|jpeg)$/.test(name)) return await extractImage(buffer);
  }catch{}

  return "";
}

/* =========================
   CRITERIA PARSER (FIXED)
========================= */

function parseCriteria(text=""){
  const lines = text.split("\n");
  const out = [];
  const seen = new Set();

  for(const l of lines){
    const m = l.match(/^([PMD]\d+)\s+(.+)/i);
    if(!m) continue;

    const code = m[1].toUpperCase();
    const req = m[2].trim();

    if(req.length > 200) continue;
    if(seen.has(code)) continue;

    seen.add(code);
    out.push({ code, requirement:req });
  }
  return out;
}

/* =========================
   AI GRADING
========================= */

async function gradeAI(criterion, evidence){

  if(!OPENAI_API_KEY){
    return null;
  }

  const prompt = `
You are a BTEC assessor.

Return JSON only:

{
 "status":"Achieved | Review Required | Not Yet Achieved",
 "confidenceScore":0-100,
 "evidenceAndDepth":"...",
 "rationale":"...",
 "action":"..."
}

Be strict and evidence-based.
`;

  const ev = evidence.map((e,i)=>`
Evidence ${i+1}:
${e}
`).join("\n");

  const res = await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "Authorization":`Bearer ${OPENAI_API_KEY}`
    },
    body:JSON.stringify({
      model:"gpt-4o-mini",
      response_format:{ type:"json_object" },
      messages:[
        { role:"system", content:prompt },
        { role:"user", content:`Criterion: ${criterion}\n\nEvidence:\n${ev}` }
      ]
    })
  });

  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

/* =========================
   GRADE ENGINE
========================= */

async function grade(criteria, text){

  const audit = [];

  for(const c of criteria){

    const chunks = text.split(/[.]/).slice(0,50);

    const scored = chunks
      .map(x=>({ t:x, s:scoreChunk(x, c.requirement) }))
      .sort((a,b)=>b.s-a.s)
      .slice(0,3);

    let result = {
      status:"Review Required",
      confidenceScore: scored[0]?.s || 0,
      evidenceAndDepth:"",
      rationale:"",
      action:""
    };

    const ai = await gradeAI(c.requirement, scored.map(x=>x.t));

    if(ai){
      result = ai;
    }

    audit.push({
      id:c.code,
      requirement:c.requirement,
      ...result,
      evidencePage:"Auto-detected"
    });
  }

  return audit;
}

/* =========================
   RECORD STORAGE
========================= */

async function saveRecord(userId, result){
  const { data } = await supabaseAdmin
    .from("feedback_records")
    .insert([{
      user_id:userId,
      learner_name: result.fullName,
      grade: result.grade,
      data_json: result
    }])
    .select()
    .single();

  return data.id;
}

/* =========================
   ROUTES
========================= */

app.post("/api/brief/scan-file", requireAuth, async (req,res)=>{
  const text = await extract(req.body);
  res.json({ result:{ criteria: parseCriteria(text) } });
});

app.post("/api/grade/submission-multi", requireAuth, async (req,res)=>{

  const { files, criteria } = req.body;

  let text = "";

  for(const f of files){
    text += await extract(f) + "\n";
  }

  const audit = await grade(criteria, text);

  const result = {
    fullName:"Submission",
    audit,
    grade:"Generated",
    recordControl:{ recordStatus:"Draft" }
  };

  const id = await saveRecord(req.user.id, result);
  result.dbId = id;

  res.json({ result });
});

app.listen(PORT, ()=>console.log("Server running on "+PORT));
