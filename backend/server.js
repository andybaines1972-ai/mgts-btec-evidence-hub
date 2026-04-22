const express = require("express");
const cors = require("cors");
const mammoth = require("mammoth");
const JSZip = require("jszip");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

/* =========================
   ENV
========================= */
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* =========================
   HELPERS
========================= */
function safeParse(text = "") {
  try { return JSON.parse(text); } catch {}
  return {};
}

function normaliseStatus(s = "") {
  const v = String(s).toLowerCase();
  if (v.includes("achieved")) return "Achieved";
  if (v.includes("not")) return "Not Achieved";
  return "Review Required";
}

function calculateGrade(audit = []) {
  if (audit.some(a => a.finalStatus === "Not Achieved")) return "Not Achieved";
  if (audit.some(a => a.finalStatus === "Review Required")) return "Review Required";
  return "Achieved";
}

function buildBandSummary(audit = []) {
  const out = { P:{a:0,r:0,n:0,t:0}, M:{a:0,r:0,n:0,t:0}, D:{a:0,r:0,n:0,t:0} };

  audit.forEach(i=>{
    const band = i.id?.[0];
    if(!out[band]) return;
    out[band].t++;
    if(i.finalStatus==="Achieved") out[band].a++;
    else if(i.finalStatus==="Not Achieved") out[band].n++;
    else out[band].r++;
  });

  return out;
}

function ensureRecordControl(r = {}) {
  r.recordControl = {
    recordStatus: "Draft",
    ivRequired: false,
    ...(r.recordControl || {})
  };
  return r;
}

/* =========================
   FILE EXTRACTION
========================= */
async function extractDocx(base64){
  const buffer = Buffer.from(base64,"base64");
  const res = await mammoth.extractRawText({buffer});
  return res.value || "";
}

async function extractPptx(base64){
  const buffer = Buffer.from(base64,"base64");
  const zip = await JSZip.loadAsync(buffer);

  const slides = Object.keys(zip.files)
    .filter(f => f.includes("slides/slide"))
    .sort();

  let text = "";

  for(const s of slides){
    const xml = await zip.files[s].async("string");
    const matches = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)];
    text += matches.map(m=>m[1]).join(" ") + "\n";
  }

  return text;
}

/* =========================
   HEALTH
========================= */
app.get("/health", (req,res)=>res.json({ok:true}));

/* =========================
   BRIEF SCAN
========================= */
app.post("/api/brief/scan-file", async (req,res)=>{
  try{
    const { filename, fileBase64 } = req.body;

    let text = "";

    if(filename.endsWith(".docx")){
      text = await extractDocx(fileBase64);
    }

    const prompt = `
Extract BTEC criteria.

Return JSON:
{
 "criteria":[
   {"code":"P1","requirement":""}
 ]
}

Text:
${text}
`;

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({contents:[{parts:[{text:prompt}]}]})
    });

    const data = await r.json();
    const parsed = safeParse(data?.candidates?.[0]?.content?.parts?.[0]?.text);

    res.json({result:{
      criteria: parsed.criteria || []
    }});

  }catch(e){
    res.status(500).json({error:e.message});
  }
});

/* =========================
   GRADING (FIXED)
========================= */
app.post("/api/grade/submission-multi", async (req,res)=>{
  try{
    const { files, criteria=[] } = req.body;

    if(!files?.length) return res.status(400).json({error:"No files"});
    if(!criteria.length) return res.status(400).json({error:"No criteria"});

    let fileText = "";

    for(const f of files){
      if(f.filename.endsWith(".docx")){
        fileText += await extractDocx(f.fileBase64);
      } else if(f.filename.endsWith(".pptx")){
        fileText += await extractPptx(f.fileBase64);
      }
    }

    const criteriaText = criteria.map(c=>`${c.code}: ${c.requirement}`).join("\n");

    const prompt = `
Assess learner.

Return JSON:
{
 "audit":[
  {
   "id":"P1",
   "status":"Achieved",
   "finalStatus":"Achieved",
   "rationale":"...",
   "action":"...",
   "confidenceScore":70
  }
 ],
 "developmentalSummary":"..."
}

RULES:
- MUST return ALL criteria
- NEVER leave rationale empty
- NEVER leave action empty

Criteria:
${criteriaText}

Evidence:
${fileText}
`;

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({contents:[{parts:[{text:prompt}]}]})
    });

    const data = await r.json();
    const parsed = safeParse(data?.candidates?.[0]?.content?.parts?.[0]?.text);

    const incoming = parsed.audit || [];

    const audit = criteria.map(c=>{
      const found = incoming.find(a=>a.id?.toUpperCase().includes(c.code)) || {};

      return {
        id:c.code,
        requirement:c.requirement,
        status:normaliseStatus(found.status),
        finalStatus:normaliseStatus(found.finalStatus),
        rationale:found.rationale || "Evidence not clearly demonstrated.",
        action:found.action || "Further development required.",
        confidenceScore:found.confidenceScore || 40
      };
    });

    const result = ensureRecordControl({
      fullName:"Learner Submission",
      audit,
      grade:calculateGrade(audit),
      overallBandSummary:buildBandSummary(audit),
      developmentalSummary:parsed.developmentalSummary || ""
    });

    res.json({result});

  }catch(e){
    console.error(e);
    res.status(500).json({error:e.message});
  }
});

/* =========================
   RECORDS
========================= */
app.post("/api/records/save", async (req,res)=>{
  const { result } = req.body;

  const { data } = await supabase
    .from("feedback_records")
    .insert([{data:result}])
    .select("id")
    .single();

  res.json({id:data.id});
});

app.get("/api/records/list", async (req,res)=>{
  const { data } = await supabase
    .from("feedback_records")
    .select("*")
    .order("created_at",{ascending:false});

  res.json({records:data});
});

app.post("/api/records/action", async (req,res)=>{
  const { record, action } = req.body;

  if(!record) return res.status(400).json({error:"No record"});

  const rc = record.recordControl || {};

  if(action==="review") rc.recordStatus="Reviewed";
  if(action==="signoff") rc.recordStatus="Signed Off";
  if(action==="iv") rc.recordStatus="IV Required";
  if(action==="release") rc.recordStatus="Released";

  record.recordControl = rc;

  res.json({record});
});

/* =========================
   EXPORT
========================= */
app.post("/api/export/feedback-docx", (req,res)=>{
  res.send("docx export placeholder");
});

app.listen(PORT, ()=>console.log("Server running",PORT));
