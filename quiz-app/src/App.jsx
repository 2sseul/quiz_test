import { useState, useEffect, useCallback, useMemo } from "react";

const STORAGE_KEY  = "quiz-wrong-v4";
const SETS_KEY     = "quiz-sets-v4";
const VISIT_KEY    = "quiz-visits-v4";
const VISIT_ME_KEY = "quiz-visits-me-v4";

async function loadSt(key)      { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
async function saveSt(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

// ── 프롬프트 빌더 ─────────────────────────────────────────────
function buildPrompt(types, counts) {
  const countDesc = Object.entries(counts)
    .filter(([t]) => types[t] && parseInt(counts[t]) > 0)
    .map(([t, n]) => ({ mcq:`객관식 ${n}문제`, short:`단답형 ${n}문제`, essay:`서술형 ${n}문제` }[t]))
    .join(", ");
  const total = Object.entries(counts).filter(([t]) => types[t]).reduce((s,[,n]) => s+(parseInt(n)||0), 0);
  let p = `아래 형식을 반드시 지켜서 퀴즈 문제를 만들어줘.\n첨부한 강의 자료를 기반으로 총 ${total}문제(${countDesc||"미지정"})를 출제해줘.\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  if (types.mcq)   p += `[객관식]\nQ1. 문제 내용\n① 보기 1\n② 보기 2\n③ 보기 3\n④ 보기 4\n정답: ②\n해설: 정답 이유를 한두 문장으로.\n\n`;
  if (types.short) { const n = types.mcq?(parseInt(counts.mcq)||0)+1:1; p += `[단답형]\nQ${n}. [단답형] 문제 내용\n정답: 단답 정답\n해설: 이유를 한두 문장으로.\n\n`; }
  if (types.essay) { const n=(types.mcq?parseInt(counts.mcq)||0:0)+(types.short?parseInt(counts.short)||0:0)+1; p += `[서술형]\nQ${n}. [서술형] 문제 내용\n모범답안: 서술형 모범 답안.\n해설: 핵심 포인트를 한두 문장으로.\n\n`; }
  p += `━━━━━━━━━━━━━━━━━━━━━━━━\n\n규칙:\n- 모든 문제는 Q번호. 형식으로 시작\n`;
  if (types.mcq)   p += `- 객관식은 반드시 ①②③④ 기호 사용\n`;
  if (types.short) p += `- 단답형은 문제 앞에 [단답형] 표시\n`;
  if (types.essay) p += `- 서술형은 문제 앞에 [서술형] 표시\n`;
  p += `- 정답/해설은 반드시 포함\n- 문제 사이는 빈 줄 하나로 구분`;
  return p;
}

// ── 파서 ─────────────────────────────────────────────────────
function parseQuiz(text) {
  // ━━━ 구분선 제거
  const cleaned = text.replace(/^[━─—-]{3,}.*$/gm, "").replace(/^\s*---+\s*$/gm, "");
  const lines = cleaned.split("\n");
  const starts = [];
  lines.forEach((l, i) => { if (/^Q\d+[\.\)]\s+.+/i.test(l.trim())) starts.push(i); });
  if (!starts.length) {
    return cleaned.split(/\n{2,}/).map((b,i) => parseBlock(b.trim(), i+1)).filter(Boolean);
  }
  return starts.map((s, bi) =>
    parseBlock(lines.slice(s, starts[bi+1] ?? lines.length).join("\n").trim(), bi+1)
  ).filter(Boolean);
}

function parseBlock(block, fallbackNum) {
  if (!block || block.length < 5) return null;
  // 구분선 라인 제거
  const rawLines = block.split("\n")
    .map(l => l.trim())
    .filter(l => l && !/^[━─—\-]{3,}$/.test(l) && !/^\*{3,}$/.test(l));
  if (!rawLines.length) return null;

  const hm = rawLines[0].replace(/\*\*/g,"").match(/^Q?(\d+)[\.\)]\s+(?:\[([^\]]+)\]\s*)?(.+)/i);
  if (!hm) return null;

  const num = parseInt(hm[1]) || fallbackNum;
  let qText = hm[3].trim();
  let type  = "mcq";
  if ((hm[2]||"").includes("단답") || qText.includes("[단답형]")) type = "short";
  else if ((hm[2]||"").includes("서술") || qText.includes("[서술형]")) type = "essay";
  qText = qText.replace(/\[단답형\]|\[서술형\]/g, "").trim();

  const opts = []; let answer=null, explanation=null, modelAnswer=null;
  let cA=false, cE=false, cM=false;

  for (let i = 1; i < rawLines.length; i++) {
    const l = rawLines[i].replace(/\*\*/g,"").trim();

    // 구분선 스킵
    if (/^[━─—\-]{3,}$/.test(l) || /^\*{3,}$/.test(l)) { cA=cE=cM=false; continue; }

    const om = l.match(/^([①②③④⑤]|\d+[\.\)])\s+(.+)/);
    if (om && type==="mcq") {
      const mk=om[1], tx=om[2];
      opts.push({ num:"①②③④⑤".includes(mk)?"①②③④⑤".indexOf(mk)+1:opts.length+1, text:tx });
      cA=cE=cM=false; continue;
    }
    const ansM = l.match(/^정답\s*[:：]?\s*(.+)/);
    if (ansM) {
      const raw = ansM[1].trim();
      if (type==="mcq") {
        const a = raw.replace(/[^①②③④⑤\d]/g,"").charAt(0);
        answer = "①②③④⑤".includes(a) ? "①②③④⑤".indexOf(a)+1 : parseInt(a)||null;
      } else { answer=raw; cA=true; }
      cE=cM=false; continue;
    }
    const maM = l.match(/^모범답안\s*[:：]?\s*(.*)/);
    if (maM) { modelAnswer=maM[1].trim(); cM=true; cA=cE=false; continue; }
    const exM = l.match(/^해설\s*[:：]?\s*(.*)/);
    if (exM) {
      const expText = exM[1].trim();
      // 해설 내용이 구분선이면 무시
      if (expText && !/^[━─—\-]{3,}$/.test(expText)) explanation=expText;
      cE=true; cA=cM=false; continue;
    }
    // 이어지는 내용 (구분선 제외)
    if (cM && modelAnswer!==undefined) { modelAnswer+=" "+l; continue; }
    if (cA && type!=="mcq") { answer=(answer||"")+" "+l; continue; }
    if (cE && !/^[━─—\-]{3,}$/.test(l)) { explanation=(explanation||"")+" "+l; continue; }
  }

  if (type==="mcq" && opts.length < 2) return null;
  return { id:`q-${Math.random().toString(36).slice(2)}`, num, type, question:qText, options:opts, answer, modelAnswer, explanation };
}

// ── 단답 채점 ────────────────────────────────────────────────
function gradeShort(input, correct) {
  if (!correct) return null;
  const n = s => s.toLowerCase().replace(/[\s\(\)\.,\[\]]/g,"");
  const ci = n(correct), ui = n(input);
  if (ui===ci) return true;
  if (ui===n(correct.replace(/\([^)]*\)/g,""))) return true;
  const kws = correct.split(/[\s,\/]+/).map(n).filter(k=>k.length>1);
  return kws.some(k => ui.includes(k));
}

// ── 색상 ─────────────────────────────────────────────────────
const G = {
  bg:"#f5f5f5", card:"#fff", border:"#e8e8e8", borderHov:"#d0d0d0",
  text:"#111", sub:"#777", hint:"#bbb",
  blue:"#2563eb", blueBg:"#eff6ff", blueBdr:"#bfdbfe",
  green:"#166534", greenBg:"#f0fdf4", greenBdr:"#86efac",
  red:"#b91c1c", redBg:"#fef2f2", redBdr:"#fca5a5",
  amber:"#92400e", amberBg:"#fffbeb", amberBdr:"#fcd34d",
  purple:"#5b21b6", purpleBg:"#f5f3ff", purpleBdr:"#c4b5fd",
};

const css = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:${G.bg};color:${G.text}}
.wrap{max-width:680px;margin:0 auto;padding:2rem 1.25rem 5rem}

/* builder */
.builder{background:#fff;border:1px solid ${G.border};border-radius:14px;padding:1.25rem 1.5rem;margin-bottom:1.75rem}
.builder-title{font-size:14px;font-weight:600;margin-bottom:3px}
.builder-desc{font-size:12px;color:${G.sub};margin-bottom:1rem;line-height:1.5}
.type-rows{display:flex;flex-direction:column;gap:8px;margin-bottom:1rem}
.type-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid ${G.border};border-radius:10px;background:${G.bg};transition:border-color .12s,background .12s}
.type-row.on{border-color:${G.blue};background:${G.blueBg}}
.type-row label{display:flex;align-items:center;gap:8px;cursor:pointer;flex:1}
.type-row input[type=checkbox]{width:16px;height:16px;cursor:pointer;accent-color:${G.blue}}
.type-label{font-size:13px;font-weight:500;flex:1}
.type-desc{font-size:12px;color:${G.sub}}
.cnt-wrap{display:flex;align-items:center;gap:6px}
.cnt-wrap span{font-size:12px;color:${G.sub};white-space:nowrap}
.cnt-inp{width:56px;padding:5px 8px;font-size:13px;border:1px solid ${G.border};border-radius:7px;background:#fff;color:${G.text};text-align:center}
.cnt-inp:focus{outline:none;border-color:${G.blue}}
.cnt-inp:disabled{opacity:.4;background:${G.bg}}
.prompt-box{background:${G.bg};border:1px solid ${G.border};border-radius:8px;padding:12px 14px;font-size:11.5px;font-family:monospace;color:${G.sub};line-height:1.7;white-space:pre-wrap;max-height:160px;overflow-y:auto;margin-bottom:10px}
.prompt-box::-webkit-scrollbar{width:4px}
.prompt-box::-webkit-scrollbar-thumb{background:${G.border};border-radius:4px}
.copy-btn{width:100%;padding:9px;font-size:13px;font-weight:500;border-radius:8px;border:none;background:${G.text};color:#fff;cursor:pointer}
.copy-btn:hover{opacity:.85}
.copy-btn.done{background:${G.green}}
.total-pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:20px;background:${G.blueBg};color:${G.blue};font-weight:500;margin-left:6px}

/* visitor */
.visitor-bar{display:flex;gap:10px;margin-bottom:1.5rem}
.visit-card{flex:1;background:#fff;border:1px solid ${G.border};border-radius:10px;padding:10px 14px;text-align:center}
.visit-label{font-size:11px;color:${G.sub};margin-bottom:3px}
.visit-val{font-size:20px;font-weight:600}

/* tabs */
.tab-bar{display:flex;border-bottom:1px solid ${G.border};margin-bottom:2rem}
.tab{padding:10px 18px;font-size:14px;font-weight:500;border:none;background:none;cursor:pointer;color:${G.sub};border-bottom:2px solid transparent;margin-bottom:-1px}
.tab.on{color:${G.text};border-bottom-color:${G.text}}
.tab:disabled{opacity:.35;cursor:default}

/* buttons */
.bp{background:${G.text};color:#fff;border:none;padding:9px 20px;font-size:13px;font-weight:500;border-radius:8px;cursor:pointer}
.bp:hover{opacity:.85}
.bs{background:#fff;color:${G.text};border:1px solid ${G.border};padding:8px 16px;font-size:13px;border-radius:8px;cursor:pointer}
.bs:hover{background:${G.bg}}
.bd{background:${G.redBg};color:${G.red};border:1px solid ${G.redBdr};padding:8px 16px;font-size:13px;border-radius:8px;cursor:pointer}
.btn-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center}

/* inputs */
textarea,input[type=text]{width:100%;padding:12px 14px;font-size:13px;font-family:inherit;border:1px solid ${G.border};border-radius:10px;background:#fff;color:${G.text};resize:vertical;line-height:1.6}
textarea:focus,input[type=text]:focus{outline:none;border-color:${G.borderHov}}

/* quiz card */
.card{background:#fff;border:1px solid ${G.border};border-radius:14px;padding:1.75rem 1.5rem;margin-bottom:16px}
.qnum-row{font-size:12px;color:${G.sub};font-weight:500;margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tbadge{font-size:11px;padding:2px 8px;border-radius:20px;font-weight:500}
.tmcq{background:${G.blueBg};color:${G.blue}}
.tshort{background:${G.amberBg};color:${G.amber}}
.tessay{background:${G.purpleBg};color:${G.purple}}
.qtext{font-size:16px;font-weight:600;line-height:1.6;margin-bottom:20px;white-space:pre-wrap}

/* mcq */
.opts{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.opt{padding:14px 16px;border:1px solid ${G.border};border-radius:10px;font-size:14px;cursor:pointer;background:#fff;color:${G.text};text-align:left;line-height:1.45;transition:border-color .12s,background .12s}
.opt:hover:not(:disabled){border-color:${G.borderHov};background:${G.bg}}
.opt.sel{border-color:${G.blueBdr};background:${G.blueBg};color:${G.blue}}
.opt.hit{border-color:${G.greenBdr};background:${G.greenBg};color:${G.green}}
.opt.miss{border-color:${G.redBdr};background:${G.redBg};color:${G.red}}

/* text answer */
.ans-inp{width:100%;padding:12px 14px;font-size:14px;border:1px solid ${G.border};border-radius:10px;background:#fff;color:${G.text};font-family:inherit;line-height:1.6;resize:vertical}
.ans-inp:focus{outline:none;border-color:${G.borderHov}}
.ans-inp:disabled{background:${G.bg}}
.ans-inp.hit{border-color:${G.greenBdr};background:${G.greenBg}}
.ans-inp.miss{border-color:${G.redBdr};background:${G.redBg}}
.submit-btn{margin-top:10px;padding:8px 20px;font-size:13px;font-weight:500;border-radius:8px;border:none;background:${G.blue};color:#fff;cursor:pointer}
.submit-btn:hover{opacity:.85}
.submit-btn:disabled{opacity:.4;cursor:default}

/* explanation */
.exp{margin-top:14px;padding:14px 16px;border-radius:10px;font-size:13px;line-height:1.65}
.exp.hit{background:${G.greenBg};border-left:3px solid ${G.greenBdr};color:${G.green}}
.exp.miss{background:${G.redBg};border-left:3px solid ${G.redBdr};color:${G.red}}
.exp.info{background:${G.blueBg};border-left:3px solid ${G.blueBdr};color:${G.blue}}
.exp-ttl{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px;opacity:.8}
.exp-ans{font-weight:600;margin-bottom:5px}
.exp-txt{opacity:.85}

/* badges */
.badge{display:inline-block;font-size:11px;padding:2px 9px;border-radius:20px;font-weight:500}
.ok{background:${G.greenBg};color:${G.green}}
.ng{background:${G.redBg};color:${G.red}}

/* stats + score */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:1.25rem}
.stat{background:#fff;border:1px solid ${G.border};border-radius:10px;padding:12px 14px}
.stat-l{font-size:11px;color:${G.sub};margin-bottom:3px}
.stat-v{font-size:22px;font-weight:600}
.score-row{display:flex;align-items:center;gap:20px;padding:1.75rem 0 .5rem;flex-wrap:wrap}
.score-n{font-size:52px;font-weight:700;letter-spacing:-1px;line-height:1}
.score-s{font-size:14px;color:${G.sub};margin-top:4px}

/* one-by-one */
.obo-wrap{display:flex;flex-direction:column}
.obo-pbar-wrap{height:4px;background:${G.border};border-radius:2px;margin-bottom:1.25rem;overflow:hidden}
.obo-pbar{height:100%;background:${G.blue};border-radius:2px;transition:width .3s}
.obo-card{background:#fff;border:1px solid ${G.border};border-radius:14px;padding:1.75rem 1.5rem;margin-bottom:14px}
.obo-nav{display:flex;gap:12px;align-items:center;justify-content:center;margin-top:4px}
.obo-counter{font-size:13px;color:${G.sub};min-width:70px;text-align:center}
.obo-score{display:flex;gap:20px;justify-content:center;margin-top:12px;font-size:13px}

/* mode */
.mode-btns{display:flex;gap:8px;margin-bottom:1.25rem}
.mbtn{padding:7px 18px;font-size:13px;font-weight:500;border-radius:8px;cursor:pointer;border:1px solid ${G.border};background:#fff;color:${G.sub}}
.mbtn.on{background:${G.text};color:#fff;border-color:${G.text}}

/* modal */
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:100;padding:1rem}
.modal{background:#fff;border-radius:16px;padding:1.75rem 1.5rem;max-width:420px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,.15)}
.modal-title{font-size:16px;font-weight:600;margin-bottom:8px}
.modal-desc{font-size:13px;color:${G.sub};line-height:1.6;margin-bottom:1.25rem}
.modal-btns{display:flex;gap:8px;flex-wrap:wrap}

/* misc */
.divider{border-top:1px solid ${G.border};margin:1.75rem 0 1.5rem}
.lbl{font-size:13px;color:${G.sub};margin-bottom:8px}
.set-card{background:#fff;border:1px solid ${G.border};border-radius:12px;padding:1rem 1.25rem;display:flex;align-items:center;gap:12px;margin-bottom:10px}
.set-info{flex:1}
.set-name{font-size:14px;font-weight:500}
.set-meta{font-size:12px;color:${G.sub};margin-top:2px}
.wbanner{background:${G.redBg};border:1px solid ${G.redBdr};border-radius:10px;padding:12px 16px;font-size:13px;color:${G.red};margin-bottom:1.25rem;display:flex;align-items:center;justify-content:space-between}
.empty{text-align:center;padding:4rem 1rem;color:${G.hint};font-size:14px;line-height:2.2}
`;

// ── 해설 박스 ─────────────────────────────────────────────────
function ExpBox({ cls, title, answer, modelAnswer, explanation }) {
  if (!answer && !modelAnswer && !explanation) return null;
  return (
    <div className={`exp ${cls}`}>
      <div className="exp-ttl">{title}</div>
      {answer      && <div className="exp-ans">정답: {answer}</div>}
      {modelAnswer && <div className="exp-ans">모범답안: {modelAnswer}</div>}
      {explanation && <div className="exp-txt">{explanation}</div>}
    </div>
  );
}

// ── 문제 한 개 (시험지 + 한문제씩 공용) ───────────────────────
function QuizItem({ q, qi, submitted, userMcq, userText, onMcq, onText, onSubmit, showAll }) {
  const done = submitted || showAll;
  const typeCls   = q.type==="mcq"?"tmcq":q.type==="short"?"tshort":"tessay";
  const typeLabel = q.type==="mcq"?"객관식":q.type==="short"?"단답형":"서술형";

  let isCorrect = null;
  if (done && q.type==="mcq")   isCorrect = userMcq===q.answer && !!q.answer;
  if (done && q.type==="short") isCorrect = gradeShort(userText||"", q.answer||"");

  let expCls="info", expTitle="정답";
  if (done && isCorrect===true)  { expCls="hit"; expTitle="정답이에요!"; }
  if (done && isCorrect===false) { expCls="miss"; expTitle="틀렸어요"; }
  if (done && q.type==="essay")  { expCls="info"; expTitle="모범답안"; }

  const ansLabel = q.type==="mcq" && q.answer
    ? `${"①②③④⑤"[q.answer-1]} ${q.options[q.answer-1]?.text}`
    : q.type!=="essay" ? q.answer : null;

  return (
    <div>
      <div className="qnum-row">
        {`문제 ${qi+1}`}
        <span className={`tbadge ${typeCls}`}>{typeLabel}</span>
        {done && q.type==="mcq" && userMcq!==undefined &&
          <span className={`badge ${isCorrect?"ok":"ng"}`}>{isCorrect?"정답":"오답"}</span>}
        {done && q.type==="short" &&
          <span className={`badge ${isCorrect?"ok":"ng"}`}>{isCorrect?"정답":"오답"}</span>}
        {done && q.type==="essay" &&
          <span className="badge" style={{background:G.blueBg,color:G.blue}}>채점됨</span>}
      </div>
      <div className="qtext">{q.question}</div>

      {q.type==="mcq" && (
        <div className="opts">
          {q.options.map(opt => {
            let cls="opt";
            if (done) {
              if (opt.num===q.answer)                             cls+=" hit";
              else if (opt.num===userMcq && opt.num!==q.answer)  cls+=" miss";
            } else if (userMcq===opt.num) cls+=" sel";
            return (
              <button key={opt.num} className={cls} disabled={done} onClick={()=>onMcq(opt.num)}>
                {"①②③④⑤"[opt.num-1]} {opt.text}
              </button>
            );
          })}
        </div>
      )}

      {q.type!=="mcq" && (
        <>
          <textarea
            className={`ans-inp${done?(q.type==="short"?(isCorrect?" hit":" miss"):""):""}`}
            style={{minHeight:q.type==="essay"?100:52}}
            placeholder={q.type==="short"?"단답으로 입력하세요":"서술형 답안을 작성하세요"}
            value={userText||""} disabled={done}
            onChange={e=>onText(e.target.value)}
          />
          {!done && (
            <button className="submit-btn" disabled={!(userText||"").trim()} onClick={onSubmit}>제출</button>
          )}
        </>
      )}

      {done && (
        <ExpBox cls={expCls} title={expTitle} answer={ansLabel} modelAnswer={q.modelAnswer} explanation={q.explanation}/>
      )}
    </div>
  );
}

// ── 오답노트 저장 모달 ───────────────────────────────────────
function SaveModal({ wrongCount, onSave, onSkip }) {
  return (
    <div className="modal-bg">
      <div className="modal">
        <div className="modal-title">오답노트에 저장할까요?</div>
        <div className="modal-desc">
          틀린 문제가 <strong>{wrongCount}개</strong> 있어요.<br/>
          오답노트에 저장하면 나중에 틀린 문제만 골라서 다시 풀 수 있어요.
        </div>
        <div className="modal-btns">
          <button className="bp" onClick={onSave}>저장하기</button>
          <button className="bs" onClick={onSkip}>저장 안 함</button>
        </div>
      </div>
    </div>
  );
}

// ── 메인 ─────────────────────────────────────────────────────
export default function App() {
  const [types,  setTypes]  = useState({ mcq:true, short:false, essay:false });
  const [counts, setCounts] = useState({ mcq:"10", short:"5", essay:"3" });
  const [copied, setCopied] = useState(false);

  const [visits,   setVisits]   = useState(0);
  const [myVisits, setMyVisits] = useState(0);

  const [tab,     setTab]     = useState("input");
  const [raw,     setRaw]     = useState("");
  const [setName, setSetName] = useState("");
  const [qs,      setQs]      = useState([]);
  const [mode,    setMode]    = useState("exam");

  // 시험지
  const [mcqAns,    setMcqAns]    = useState({});
  const [textAns,   setTextAns]   = useState({});
  const [subm,      setSubm]      = useState({});
  const [allGraded, setAllGraded] = useState(false);
  const [showAll,   setShowAll]   = useState(false);
  const [saveModal, setSaveModal] = useState(null); // { wrongQs }

  // 한문제씩
  const [oboIdx,   setOboIdx]   = useState(0);
  const [oboMcq,   setOboMcq]   = useState({});
  const [oboText,  setOboText]  = useState({});
  const [oboSubm,  setOboSubm]  = useState({});
  const [oboScore, setOboScore] = useState({ ok:0, ng:0 });

  const [sets, setSets] = useState({});
  const [wb,   setWb]   = useState({});
  const [wrongMode, setWrongMode] = useState(false);

  useEffect(() => {
    (async () => {
      setSets(await loadSt(SETS_KEY)||{});
      setWb(await loadSt(STORAGE_KEY)||{});
      const already = sessionStorage.getItem("quiz-counted");
      const mv = await loadSt(VISIT_ME_KEY)||0;
      const tv = await loadSt(VISIT_KEY)||0;
      if (!already) {
        sessionStorage.setItem("quiz-counted","1");
        await saveSt(VISIT_ME_KEY, mv+1);
        await saveSt(VISIT_KEY, tv+1);
        setMyVisits(mv+1); setVisits(tv+1);
      } else { setMyVisits(mv); setVisits(tv); }
    })();
  }, []);

  const saveSets = useCallback(async d => { setSets(d); await saveSt(SETS_KEY, d); }, []);
  const saveWb   = useCallback(async d => { setWb(d);   await saveSt(STORAGE_KEY, d); }, []);

  const prompt = useMemo(() => buildPrompt(types, counts), [types, counts]);
  const total  = Object.entries(counts).filter(([t])=>types[t]).reduce((s,[,n])=>s+(parseInt(n)||0), 0);

  function toggleType(t) {
    setTypes(prev => {
      const next={...prev,[t]:!prev[t]};
      if (!Object.values(next).some(Boolean)) return prev;
      return next;
    });
  }
  function copyPrompt() {
    navigator.clipboard.writeText(prompt).then(()=>{ setCopied(true); setTimeout(()=>setCopied(false),2000); });
  }

  function resetQuiz(q, wm) {
    setQs(q); setMcqAns({}); setTextAns({}); setSubm({}); setAllGraded(false); setShowAll(false);
    setOboIdx(0); setOboMcq({}); setOboText({}); setOboSubm({}); setOboScore({ok:0,ng:0});
    setWrongMode(wm); setMode("exam"); setSaveModal(null);
  }

  function doParse() {
    const q = parseQuiz(raw);
    if (!q.length) { alert("파싱 실패. 위 프롬프트로 AI에게 요청 후 결과를 붙여넣어보세요."); return; }
    resetQuiz(q, false); setTab("quiz");
  }

  async function doSave() {
    if (!qs.length) return;
    const name = setName.trim()||`세트 ${Object.keys(sets).length+1}`;
    const u={...sets,[Date.now()]:{name,questions:qs,savedAt:new Date().toLocaleDateString("ko-KR")}};
    await saveSets(u); setSetName(""); alert(`"${name}" 저장됐어요!`);
  }

  // 오답 랜덤 섞기
  function shuffle(arr) {
    const a=[...arr];
    for (let i=a.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
    return a;
  }

  async function startWrong() {
    const all = Object.values(wb).flat();
    if (!all.length) { alert("저장된 오답이 없어요!"); return; }
    const uniq = shuffle(Object.values(all.reduce((a,q)=>{ a[q.id]=q; return a; },{})));
    resetQuiz(uniq, true); setTab("quiz");
  }

  // ── 시험지: 개별 제출 ────────────────────────────────────────
  async function submitOne(qi) {
    const q = qs[qi];
    setSubm(p=>({...p,[qi]:true}));
    let wrong=false;
    if (q.type==="mcq")   wrong = mcqAns[qi]!==q.answer && !!q.answer;
    if (q.type==="short") wrong = !gradeShort(textAns[qi]||"", q.answer||"");
    if (wrong) await saveWb({...wb,[Date.now().toString()]:[q]});
  }

  // ── 시험지: 전체 채점 → 모달 ─────────────────────────────────
  function gradeAll() {
    setAllGraded(true);
    const wrongQs = qs.filter((q,qi) =>
      q.type==="mcq" && mcqAns[qi]!==undefined && mcqAns[qi]!==q.answer && q.answer
    );
    if (wrongQs.length > 0) {
      setSaveModal({ wrongQs });
    }
  }

  async function handleSaveWrong() {
    if (!saveModal) return;
    const u={...wb,[Date.now().toString()]:saveModal.wrongQs};
    await saveWb(u);
    setSaveModal(null);
  }

  // ── 한문제씩: 제출 ───────────────────────────────────────────
  async function oboSubmit(qi) {
    const q=qs[qi];
    setOboSubm(p=>({...p,[qi]:true}));
    let correct=null;
    if (q.type==="mcq")   correct = oboMcq[qi]===q.answer && !!q.answer;
    if (q.type==="short") correct = gradeShort(oboText[qi]||"", q.answer||"");
    if (correct===true)  setOboScore(s=>({...s,ok:s.ok+1}));
    if (correct===false) { setOboScore(s=>({...s,ng:s.ng+1})); await saveWb({...wb,[Date.now().toString()]:[q]}); }
  }

  // 통계
  const mcqQs      = qs.filter(q=>q.type==="mcq");
  const gradedMcq  = mcqQs.filter(q=>{ const qi=qs.indexOf(q); return subm[qi]||allGraded; });
  const correctMcq = gradedMcq.filter(q=>{ const qi=qs.indexOf(q); return mcqAns[qi]===q.answer&&q.answer; }).length;
  const uniqWrong  = Object.values(Object.values(wb).flat().reduce((a,q)=>{ a[q.id]=q; return a; },{})).length;

  const mdText = () => {
    const l=["# 퀴즈\n"];
    qs.forEach((q,i)=>{
      const tl=q.type==="short"?"[단답형] ":q.type==="essay"?"[서술형] ":"";
      l.push(`**Q${i+1}. ${tl}${q.question}**\n`);
      if (q.type==="mcq") q.options.forEach(o=>l.push(`${"①②③④⑤"[o.num-1]} ${o.text}`));
      if (q.answer)       l.push(`\n정답: ${q.type==="mcq"?"①②③④⑤"[(q.answer||1)-1]:q.answer}`);
      if (q.modelAnswer)  l.push(`모범답안: ${q.modelAnswer}`);
      if (q.explanation)  l.push(`해설: ${q.explanation}`);
      l.push("");
    });
    return l.join("\n");
  };

  const Tab=({id,label})=>(
    <button className={`tab${tab===id?" on":""}`} disabled={id==="quiz"&&!qs.length} onClick={()=>setTab(id)}>{label}</button>
  );
  const TYPE_CFG=[
    {key:"mcq",   label:"객관식", desc:"①②③④ 4지선다"},
    {key:"short", label:"단답형", desc:"키워드 자동 채점"},
    {key:"essay", label:"서술형", desc:"모범답안 확인"},
  ];

  // ── 시험지 렌더 ───────────────────────────────────────────────
  function renderExam() {
    return (
      <div>
        {qs.map((q,qi)=>{
          const done=subm[qi]||allGraded||showAll;
          return (
            <div className="card" key={q.id}>
              <QuizItem q={q} qi={qi} submitted={done}
                userMcq={mcqAns[qi]} userText={textAns[qi]}
                onMcq={v=>!done&&setMcqAns(p=>({...p,[qi]:v}))}
                onText={v=>!done&&setTextAns(p=>({...p,[qi]:v}))}
                onSubmit={()=>submitOne(qi)} showAll={showAll}/>
            </div>
          );
        })}

        <div className="btn-row">
          {!allGraded && <button className="bp" onClick={gradeAll}>전체 채점하기</button>}
          <button className="bs" onClick={()=>setShowAll(s=>!s)}>{showAll?"정답 숨기기":"정답 전체 보기"}</button>
          <button className="bs" onClick={()=>resetQuiz(qs,wrongMode)}>다시 풀기</button>
        </div>

        {allGraded && mcqQs.length>0 && (
          <div className="score-row">
            <div>
              <div className="score-n">{gradedMcq.length>0?Math.round(correctMcq/gradedMcq.length*100):0}점</div>
              <div className="score-s">
                객관식 {gradedMcq.length}문제 중 {correctMcq}개 정답
              </div>
            </div>
          </div>
        )}

        <div className="divider"/>
        <div className="lbl">세트 저장</div>
        <div style={{display:"flex",gap:8,marginBottom:"1.25rem"}}>
          <input type="text" value={setName} onChange={e=>setSetName(e.target.value)} placeholder="세트 이름 (예: 데이터마이닝 1단원)" style={{flex:1}}/>
          <button className="bs" onClick={doSave}>저장</button>
        </div>
        <div className="lbl">마크다운 내보내기</div>
        <textarea readOnly value={mdText()} style={{height:100,fontSize:12,fontFamily:"monospace"}}/>
        <div className="btn-row">
          <button className="bs" onClick={()=>navigator.clipboard.writeText(mdText()).then(()=>alert("복사됐어요!"))}>클립보드 복사</button>
        </div>
      </div>
    );
  }

  // ── 한 문제씩 렌더 ────────────────────────────────────────────
  function renderObo() {
    const q=qs[oboIdx]; if (!q) return null;
    const qi=oboIdx, done=!!oboSubm[qi], pct=Math.round(oboIdx/qs.length*100);
    return (
      <div className="obo-wrap">
        <div className="obo-pbar-wrap"><div className="obo-pbar" style={{width:pct+"%"}}/></div>
        <div className="obo-card">
          <QuizItem q={q} qi={qi} submitted={done}
            userMcq={oboMcq[qi]} userText={oboText[qi]}
            onMcq={async v=>{
              if (done) return;
              setOboMcq(p=>({...p,[qi]:v}));
              const correct=v===q.answer&&!!q.answer;
              setOboSubm(p=>({...p,[qi]:true}));
              if (correct) setOboScore(s=>({...s,ok:s.ok+1}));
              else { setOboScore(s=>({...s,ng:s.ng+1})); await saveWb({...wb,[Date.now().toString()]:[q]}); }
            }}
            onText={v=>!done&&setOboText(p=>({...p,[qi]:v}))}
            onSubmit={()=>oboSubmit(qi)} showAll={false}/>
          {done && (
            <div style={{marginTop:14}}>
              {oboIdx<qs.length-1
                ? <button className="bp" onClick={()=>setOboIdx(i=>i+1)}>다음 문제 →</button>
                : <div style={{fontSize:14,color:G.sub,fontWeight:500}}>모든 문제를 풀었어요! 🎉</div>
              }
            </div>
          )}
        </div>
        <div className="obo-nav">
          <button className="bs" onClick={()=>setOboIdx(i=>Math.max(0,i-1))}>이전</button>
          <span className="obo-counter">{oboIdx+1} / {qs.length}</span>
          <button className="bs" onClick={()=>setOboIdx(i=>Math.min(qs.length-1,i+1))}>다음</button>
        </div>
        <div className="obo-score">
          <span style={{color:G.green}}>맞음 {oboScore.ok}</span>
          <span style={{color:G.red}}>틀림 {oboScore.ng}</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <style>{css}</style>
      {saveModal && (
        <SaveModal
          wrongCount={saveModal.wrongQs.length}
          onSave={handleSaveWrong}
          onSkip={()=>setSaveModal(null)}
        />
      )}

      <div className="wrap">
        {/* 프롬프트 빌더 */}
        <div className="builder">
          <div className="builder-title">
            AI 퀴즈 생성 프롬프트
            {total>0&&<span className="total-pill">총 {total}문제</span>}
          </div>
          <div className="builder-desc">유형과 수를 설정하고 복사 → GPT / Gemini에 붙여넣고 강의자료 첨부</div>
          <div className="type-rows">
            {TYPE_CFG.map(({key,label,desc})=>(
              <div key={key} className={`type-row${types[key]?" on":""}`}>
                <label>
                  <input type="checkbox" checked={types[key]} onChange={()=>toggleType(key)}/>
                  <span className="type-label">{label}</span>
                  <span className="type-desc">{desc}</span>
                </label>
                <div className="cnt-wrap">
                  <input type="number" min="1" max="50" className="cnt-inp"
                    value={counts[key]} disabled={!types[key]}
                    onChange={e=>setCounts(p=>({...p,[key]:e.target.value}))}/>
                  <span>문제</span>
                </div>
              </div>
            ))}
          </div>
          <div className="prompt-box">{prompt}</div>
          <button className={`copy-btn${copied?" done":""}`} onClick={copyPrompt}>
            {copied?"복사됨 ✓  GPT / Gemini에 붙여넣고 강의자료를 첨부하세요!":"프롬프트 복사하기"}
          </button>
        </div>

        {/* 방문자 */}
        <div className="visitor-bar">
          <div className="visit-card"><div className="visit-label">전체 방문 수</div><div className="visit-val">{visits.toLocaleString()}</div></div>
          <div className="visit-card"><div className="visit-label">내 방문 수</div><div className="visit-val">{myVisits.toLocaleString()}</div></div>
        </div>

        {/* 탭 */}
        <div className="tab-bar">
          <Tab id="input" label="입력"/>
          <Tab id="quiz"  label={`퀴즈${qs.length>0?` (${qs.length})`:""}`}/>
          <Tab id="wrong" label={`오답노트${uniqWrong>0?` (${uniqWrong})`:""}`}/>
          <Tab id="sets"  label={`저장된 세트${Object.keys(sets).length>0?` (${Object.keys(sets).length})`:""}`}/>
        </div>

        {/* 입력 */}
        {tab==="input"&&(
          <div>
            <textarea value={raw} onChange={e=>setRaw(e.target.value)} style={{minHeight:180}}
              placeholder={"AI가 만들어준 퀴즈 텍스트를 붙여넣으세요.\n\n위 프롬프트로 요청하면 객관식·단답형·서술형 모두 자동 파싱됩니다."}/>
            <div className="btn-row">
              <button className="bp" onClick={doParse}>변환하기</button>
              <button className="bs" onClick={()=>setRaw(`Q1. 비즈니스 애널리틱스(Business Analytics)에 대한 설명으로 가장 옳은 것은?\n① 데이터를 수집만 하는 프로세스이다\n② 데이터에서 정보와 지식을 추출하여 비즈니스 통찰력을 얻고 실행으로 전환한다\n③ 기업 IT 부서에서만 수행하는 업무이다\n④ 정성적 추론만을 사용한다\n정답: ②\n해설: 비즈니스 애널리틱스는 데이터 기반으로 비즈니스 통찰력을 얻고 실행으로 전환하는 것을 목표로 한다.\n\nQ2. [단답형] 수치형 데이터를 구간으로 나누어 범주형으로 변환하는 기법은?\n정답: 구간화 (Binning)\n해설: 구간화는 연속형 수치 데이터를 범주형으로 변환하여 노이즈를 줄이고 분석을 용이하게 한다.\n\nQ3. [서술형] 데이터 마트와 데이터 웨어하우스의 차이점을 설명하시오.\n모범답안: 데이터 웨어하우스는 기업 전체의 데이터를 통합 저장하는 대규모 저장소이며, 데이터 마트는 특정 부서나 주제에 초점을 맞춘 소규모 DW의 부분집합이다.\n해설: 데이터 마트는 DW에서 필요한 부분만 추출하여 특정 의사결정 목적에 최적화한 것이다.`)}>예시 불러오기</button>
              <button className="bs" onClick={()=>setRaw("")}>초기화</button>
            </div>
          </div>
        )}

        {/* 퀴즈 */}
        {tab==="quiz"&&qs.length>0&&(
          <div>
            {wrongMode&&(
              <div className="wbanner">
                오답 복습 모드 — {qs.length}문제 (랜덤 순서)
                <button className="bs" style={{fontSize:12,padding:"5px 12px"}} onClick={()=>setWrongMode(false)}>닫기</button>
              </div>
            )}
            <div className="stats">
              {[
                ["총 문제",qs.length,G.text],
                ["객관식",qs.filter(q=>q.type==="mcq").length,G.blue],
                ["단답/서술",qs.filter(q=>q.type!=="mcq").length,G.amber],
                ["정답률",gradedMcq.length>0?Math.round(correctMcq/gradedMcq.length*100)+"%":"-",G.text],
              ].map(([l,v,c])=>(
                <div className="stat" key={l}><div className="stat-l">{l}</div><div className="stat-v" style={{color:c}}>{v}</div></div>
              ))}
            </div>
            <div className="mode-btns">
              <button className={`mbtn${mode==="exam"?" on":""}`} onClick={()=>setMode("exam")}>시험지</button>
              <button className={`mbtn${mode==="obo"?" on":""}`}  onClick={()=>{setMode("obo");setOboIdx(0);}}>한 문제씩</button>
            </div>
            {mode==="exam"?renderExam():renderObo()}
          </div>
        )}

        {/* 오답노트 */}
        {tab==="wrong"&&(
          <div>
            {uniqWrong===0?(
              <div className="empty">아직 저장된 오답이 없어요.<br/>퀴즈를 풀고 채점하면 틀린 문제가 여기 쌓여요.</div>
            ):(
              <>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"1.25rem"}}>
                  <span style={{fontSize:14,color:G.sub}}>총 {uniqWrong}문제</span>
                  <div style={{display:"flex",gap:8}}>
                    <button className="bp" onClick={startWrong}>랜덤으로 다시 풀기</button>
                    <button className="bd" onClick={async()=>{if(!confirm("오답 노트를 전부 지울까요?"))return;await saveWb({});}}>전체 삭제</button>
                  </div>
                </div>
                {Object.entries(wb).map(([sid,wqs])=>(
                  <div key={sid} style={{marginBottom:"1.25rem"}}>
                    <div style={{fontSize:12,color:G.hint,marginBottom:8}}>세션 #{sid.slice(-4)}</div>
                    {wqs.map((q,qi)=>(
                      <div className="card" key={qi} style={{borderLeft:`3px solid ${G.redBdr}`}}>
                        <div className="qnum-row">
                          문제 {q.num||qi+1}
                          <span className={`tbadge ${q.type==="mcq"?"tmcq":q.type==="short"?"tshort":"tessay"}`}>
                            {q.type==="mcq"?"객관식":q.type==="short"?"단답형":"서술형"}
                          </span>
                          <span className="badge ng">오답</span>
                        </div>
                        <div className="qtext" style={{fontSize:15}}>{q.question}</div>
                        <ExpBox cls="miss" title="정답/해설"
                          answer={q.type==="mcq"&&q.answer?`${"①②③④⑤"[q.answer-1]} ${q.options[q.answer-1]?.text}`:q.type!=="essay"?q.answer:null}
                          modelAnswer={q.modelAnswer} explanation={q.explanation}/>
                      </div>
                    ))}
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* 저장된 세트 */}
        {tab==="sets"&&(
          <div>
            {Object.keys(sets).length===0?(
              <div className="empty">저장된 세트가 없어요.<br/>퀴즈 탭 하단에서 세트를 저장하세요.</div>
            ):(
              Object.entries(sets).map(([id,s])=>(
                <div className="set-card" key={id}>
                  <div className="set-info">
                    <div className="set-name">{s.name}</div>
                    <div className="set-meta">{s.questions.length}문제 · {s.savedAt}</div>
                  </div>
                  <button className="bs" onClick={()=>{resetQuiz(s.questions,false);setTab("quiz");}}>불러오기</button>
                  <button className="bd" onClick={async()=>{const u={...sets};delete u[id];await saveSets(u);}}>삭제</button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </>
  );
}