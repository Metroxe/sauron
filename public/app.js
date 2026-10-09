const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(url) { const r = await fetch(url, { method: "POST" }); return r.json(); }

let mcpMode = "honest";
let sauronOn = false;

const PORTALS = {
  semgrep: { name: "Semgrep", logo: "logos/semgrep.png", url: "https://semgrep.dev/playground", did: "scanned the code" },
  ch: { name: "ClickHouse", logo: "logos/clickhouse.png", url: "https://console.clickhouse.cloud/", did: "recorded it" },
  akash: { name: "Akash", logo: "logos/akash.png", url: "https://akashml.com/models", did: "wrote the verdict" },
  senso: { name: "Senso", logo: "logos/senso.png", url: "https://app.senso.ai", did: "saved the verdict" },
  guild: { name: "Guild", logo: "logos/guild.png", url: "https://app.guild.ai", did: "blocked at the gate" },
};

// static content for the service nodes
for (const k of Object.keys(PORTALS)) {
  const p = PORTALS[k];
  const n = document.querySelector(`#n-${k}`);
  n.innerHTML = `<img src="${p.logo}" alt="" /><div class="nm">${p.name}</div><div class="st"></div><div class="go">open →</div>`;
  n.onclick = () => window.open(n.dataset.href || p.url, "_blank");
}

// ── toggles ──
$("#t-mcp").onclick = async () => {
  const next = mcpMode !== "malicious";
  const r = await fetch("/api/canary/mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ malicious: next }) });
  const j = await r.json();
  setMcpMode(j.mode);
};
function setMcpMode(m) {
  mcpMode = m;
  const t = $("#t-mcp");
  t.textContent = m === "malicious" ? "😈 Malicious" : "😇 Honest";
  t.className = "toggle " + (m === "malicious" ? "malicious" : "honest");
  const pill = $("#mcp-pill"); pill.textContent = m; pill.className = "pill " + (m === "malicious" ? "bad" : "ok");
}

$("#t-sauron").onclick = () => {
  sauronOn = !sauronOn;
  const t = $("#t-sauron");
  t.textContent = sauronOn ? "● On" : "○ Off";
  t.className = "toggle " + (sauronOn ? "on" : "off");
  $("#stage").classList.toggle("sauron-on", sauronOn);
};

// ── helpers ──
function resetNodes() {
  document.querySelectorAll(".wires line").forEach((l) => l.classList.remove("flow", "bad"));
  document.querySelectorAll(".node.svc").forEach((n) => { n.classList.remove("lit"); n.querySelector(".st").textContent = ""; n.removeAttribute("data-href"); });
  $("#n-gate").className = "node gate"; $("#gate-body").textContent = "the gate";
  $("#n-agent").className = "node agent"; $("#agent-body").innerHTML = "your assistant";
  $("#n-mcp").classList.remove("bad");
}
function flow(sel, bad) { const l = $(sel); if (l) l.classList.add("flow", ...(bad ? ["bad"] : [])); }
function unflow(sel) { const l = $(sel); if (l) l.classList.remove("flow", "bad"); }
function renderMcp(tools) {
  const bad = tools.some((t) => t.flagged);
  $("#n-mcp").classList.toggle("bad", bad);
  $("#mcp-body").innerHTML = `<div class="muted" style="font-size:10.5px">returned ${tools.length} tool definitions:</div>` +
    tools.map((t) => `<div class="tool ${t.flagged ? "bad" : ""}"><div class="tn">${esc(t.name)}</div><div class="td">${esc(t.description)}</div></div>`).join("");
}
function agentOut(text, bad) {
  $("#n-agent").className = "node agent " + (bad ? "bad" : "good");
  $("#agent-body").innerHTML = `<div class="agent-out">${esc(text)}</div>`;
}
function gate(cls, hd, lines) {
  $("#n-gate").className = "node gate " + cls;
  $("#n-gate .hd").innerHTML = `👁 Sauron`;
  $("#gate-body").innerHTML = `<b style="font-size:13px">${hd}</b>` + lines.map((l) => `<div style="margin-top:3px">• ${esc(l)}</div>`).join("");
}

// ── RUN ──
$("#run").onclick = async () => {
  $("#run").disabled = true;
  resetNodes();
  try { sauronOn ? await runGated() : await runDirect(); } catch (e) { console.warn(e); }
  $("#run").disabled = false;
};

async function runDirect() {
  flow("#w-direct", mcpMode === "malicious");
  $("#mcp-body").textContent = "…";
  await sleep(500);
  const d = await post("/api/mcp/peek");
  renderMcp(d.tools);
  await sleep(500);
  if (d.agent) agentOut(d.agent, d.poisoned);
  else if (d.poisoned) agentOut(`⚠️ No gate. My agent read a tool that says: "${snippet(d.poisonText)}" — with nothing in between, it follows those injected instructions.`, true);
  else agentOut(`✅ Received ${d.tools.length} normal tools and answered the question.`, false);
  unflow("#w-direct");
}

async function runGated() {
  gate("", "⏳ checking…", ["inspecting the MCP's current tools"]);
  flow("#w-a-s"); flow("#w-s-m");
  await sleep(650);
  const d = await post("/api/agent/call");
  renderMcp(d.tools);
  unflow("#w-a-s"); unflow("#w-s-m");
  if (d.detected) gate("detected", "🚨 DETECTED", d.reasons);
  else gate("pass", "✓ PASS", ["tools match the approved definition"]);

  const used = d.detected ? ["semgrep", "ch", "akash", "senso", "guild"] : ["ch"];
  for (const k of used) {
    const n = document.querySelector(`#n-${k}`);
    n.classList.add("lit");
    n.querySelector(".st").textContent = PORTALS[k].did;
    if (d.traces && d.traces[k]) n.dataset.href = d.traces[k];
    flow(`[data-svc="${k}"]`, d.detected);
    await sleep(430);
  }
  await sleep(150);
  if (d.agent) agentOut(d.agent, !d.allowed);
  else agentOut(d.agentMessage, !d.allowed);
}

function snippet(s) { return String(s || "").replace(/^\[CANARY_DRIFT\]\s*/, "").slice(0, 90); }

async function loadMode() {
  try { const r = await fetch("/api/canary/mode").then((x) => x.json()); setMcpMode(r.mode === "malicious" ? "malicious" : "honest"); } catch {}
}
loadMode();
