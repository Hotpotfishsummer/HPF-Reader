// Wails v3 isolation spike - headless probe harness (v2).
//
// C-01: can an AssetOptions.Middleware intercept and deny /wails/runtime?
// C-09: when a frame forges x-wails-window-id / -name / -client-id, what does Go see?
//
// Frames are loaded the way foliate-js loads a book: iframe.src = blob: URL
// (epub.js createURL -> URL.createObjectURL). srcdoc is kept as a secondary
// data point because it is NOT equivalent (document URL becomes about:srcdoc).

import { Call } from "@wailsio/runtime";

const ORIGIN = window.location.origin;
const logEl = document.getElementById("log") as HTMLPreElement | null;
const frameHost = document.getElementById("frames") as HTMLDivElement;

type Outcome = { id: string; ok: boolean; detail: string; error?: string | null };
const outcomes: Outcome[] = [];

function say(s: string) {
  if (logEl) logEl.textContent += s + "\n";
  console.log("[spike] " + s);
}

async function report(label: string, payload: unknown) {
  try {
    const r = await fetch("/spike/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    say("  -> " + label + " reported: HTTP " + r.status + " " + (await r.text()));
  } catch (e) {
    say("  -> " + label + " report FAILED: " + String(e));
  }
}

// Capture the exact wire body the official runtime sends, so a frame can replay
// a genuinely well-formed privileged call instead of a malformed one.
let capturedRuntimeBody: string | null = null;
const origFetch = window.fetch.bind(window);
window.fetch = async (input: any, init?: any) => {
  try {
    const u = typeof input === "string" ? input : (input && input.url) || "";
    if (u.indexOf("/wails/runtime") >= 0 && init && init.body) capturedRuntimeBody = String(init.body);
  } catch (e) { /* ignore */ }
  return origFetch(input, init);
};

function frameHtml(scriptBody: string): string {
  const S = "scr" + "ipt";
  return (
    '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
    "<" + S + ' type="module">' +
    "const ORIGIN = " + JSON.stringify(ORIGIN) + ";" +
    "function send(o){ try { o.frame = true; parent.postMessage(o, '*'); } catch (e) {} }" +
    "function report(ok, detail, error){ send({ ok: !!ok, detail: String(detail), error: error ? String(error) : null }); }" +
    "function describe(e){ return (e && e.name ? e.name : 'Error') + ': ' + (e && e.message ? e.message : String(e)); }" +
    "window.addEventListener('error', function(ev){ send({ ok:false, detail:'window.onerror', error:String(ev.message) }); });" +
    "window.addEventListener('unhandledrejection', function(ev){ send({ ok:false, detail:'unhandledrejection', error:describe(ev.reason) }); });" +
    "(async function(){ try { " + scriptBody + " } catch (e) { report(false, 'threw inside probe', describe(e)); } })();" +
    "</" + S + "></body></html>"
  );
}

type Mode = "blob" | "srcdoc";

function runFrame(id: string, mode: Mode, sandbox: string | null, scriptBody: string, timeoutMs = 10000): Promise<Outcome> {
  return new Promise((resolve) => {
    const f = document.createElement("iframe");
    if (sandbox !== null) f.setAttribute("sandbox", sandbox);
    f.style.cssText = "width:220px;height:56px;border:1px solid #555;margin:4px";
    f.title = id;
    let blobUrl: string | null = null;
    let settled = false;
    const finish = (o: Outcome) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMsg);
      outcomes.push(o);
      say("[" + id + "] ok=" + o.ok + " :: " + o.detail + (o.error ? " :: ERR=" + o.error : ""));
      resolve(o);
    };
    const onMsg = (e: MessageEvent) => {
      if (e.source !== f.contentWindow) return;
      const d: any = e.data || {};
      finish({ id, ok: !!d.ok, detail: String(d.detail ?? "(no detail)"), error: d.error ?? null });
    };
    window.addEventListener("message", onMsg);
    window.setTimeout(() => finish({ id, ok: false, detail: "NO RESPONSE within " + timeoutMs + "ms", error: null }), timeoutMs);

    const html = frameHtml(scriptBody);
    if (mode === "blob") {
      blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      f.src = blobUrl;
    } else {
      f.srcdoc = html;
    }
    frameHost.appendChild(f);
  });
}

const RT_PRELUDE =
  "const rt = await import(ORIGIN + '/wails/runtime.js');" +
  "const ns = rt.Call || (rt.default && rt.default.Call) || rt;" +
  "const ByName = ns.ByName || (ns.default && ns.default.ByName);" +
  "if (!ByName) throw new Error('no ByName export; rt keys=' + Object.keys(rt).join(','));";

const SCRIPT_CALL = RT_PRELUDE +
  "const v = await ByName('main.SecretService.GetSecret');" +
  "report(true, 'Call.ByName GetSecret -> ' + JSON.stringify(v) + ' | docURL=' + document.URL + ' | origin=' + window.location.origin);";

const SCRIPT_WRITE = RT_PRELUDE +
  "const v = await ByName('main.SecretService.WriteFile', 'pwned-from-iframe.txt', 'content written by an untrusted blob iframe');" +
  "report(true, 'Call.ByName WriteFile -> ' + JSON.stringify(v) + ' | origin=' + window.location.origin);";

const SCRIPT_READ_PARENT =
  "const origin = String(window.location.origin);" +
  "let topWails = 'n/a', doc = 'n/a', topHref = 'n/a';" +
  "try { topWails = String(typeof window.top.wails); } catch (e) { topWails = 'THREW:' + e.name; }" +
  "try { doc = window.top.document.body ? 'READABLE' : 'null'; } catch (e) { doc = 'BLOCKED:' + e.name; }" +
  "try { topHref = String(window.top.location.href); } catch (e) { topHref = 'BLOCKED:' + e.name; }" +
  "let imp = 'n/a';" +
  "try { const t = await import(ORIGIN + '/wails/runtime.js'); imp = 'OK:' + (typeof t); } catch (e) { imp = 'THREW:' + e.name + ':' + e.message; }" +
  "report(true, 'origin=' + origin + ' | docURL=' + document.URL + ' | typeof top.wails=' + topWails + ' | top.document=' + doc + ' | top.href=' + topHref + ' | import(runtime)=' + imp);";

function forgeScript(forgedId: string, forgedName: string, forgedClient: string, bodyJson: string) {
  return (
    "const body = " + JSON.stringify(bodyJson) + ";" +
    "const r = await fetch(ORIGIN + '/wails/runtime', {" +
    "  method: 'POST'," +
    "  headers: { 'Content-Type': 'application/json', 'x-wails-window-id': " + JSON.stringify(forgedId) +
    ", 'x-wails-window-name': " + JSON.stringify(forgedName) +
    ", 'x-wails-client-id': " + JSON.stringify(forgedClient) + " }," +
    "  body: body });" +
    "const txt = (await r.text()).slice(0, 300);" +
    "report(true, 'raw POST forged[id=' + " + JSON.stringify(forgedId) + " + '] -> HTTP ' + r.status + ' | resp=' + txt + ' | my origin=' + String(window.location.origin));"
  );
}

async function mainFrameProbes() {
  say("main frame origin = " + ORIGIN);
  await report("origin-info", { phase: "start", origin: ORIGIN, href: String(window.location.href), ua: navigator.userAgent });

  // D1 baseline: the official runtime path from the privileged top-level document.
  try {
    const v = await Call.ByName("main.SecretService.GetSecret");
    outcomes.push({ id: "D1-mainframe-call", ok: true, detail: "Call.ByName -> " + JSON.stringify(v), error: null });
    say("[D1-mainframe-call] ok=true :: " + JSON.stringify(v));
  } catch (e) {
    outcomes.push({ id: "D1-mainframe-call", ok: false, detail: "failed", error: String(e) });
    say("[D1-mainframe-call] FAILED: " + String(e));
  }
  say("captured runtime wire body = " + String(capturedRuntimeBody));

  const replayBody = capturedRuntimeBody ?? JSON.stringify({ object: 0, method: 0, args: { "call-id": "spike-nocapture" } });

  // D2 control: same frame-free context, forged identity headers, top-level doc.
  try {
    const r = await fetch(ORIGIN + "/wails/runtime", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wails-window-id": "424242", "x-wails-window-name": "FORGED-MAIN", "x-wails-client-id": "FORGED-MAIN-CLIENT" },
      body: replayBody,
    });
    const t = (await r.text()).slice(0, 300);
    outcomes.push({ id: "D2-mainframe-forge-replay", ok: true, detail: "HTTP " + r.status + " body=" + t, error: null });
    say("[D2-mainframe-forge-replay] HTTP " + r.status + " :: " + t);
  } catch (e) {
    outcomes.push({ id: "D2-mainframe-forge-replay", ok: false, detail: "fetch threw", error: String(e) });
  }

  // ---- frame probes: blob: URLs, the foliate-js loading mode ----
  await runFrame("B1-blob-nosandbox-call", "blob", null, SCRIPT_CALL);
  await runFrame("B2-blob-sandbox-sameorigin-scripts-call", "blob", "allow-same-origin allow-scripts", SCRIPT_CALL);
  await runFrame("B3-blob-sandbox-scripts-only-call", "blob", "allow-scripts", SCRIPT_CALL);
  await runFrame("B4-blob-sameorigin-writefile", "blob", "allow-same-origin allow-scripts", SCRIPT_WRITE);
  await runFrame("B5-blob-sameorigin-read-parent", "blob", "allow-same-origin allow-scripts", SCRIPT_READ_PARENT);
  await runFrame("B6-blob-opaque-read-parent", "blob", "allow-scripts", SCRIPT_READ_PARENT);
  await runFrame("B7-blob-sameorigin-forge-headers", "blob", "allow-same-origin allow-scripts", forgeScript("424242", "FORGED-WINDOW-NAME", "FORGED-CLIENT-ID", replayBody));
  await runFrame("B8-blob-opaque-forge-headers", "blob", "allow-scripts", forgeScript("424242", "FORGED-WINDOW-NAME", "FORGED-CLIENT-ID", replayBody));
  await runFrame("B9-srcdoc-sameorigin-call", "srcdoc", "allow-same-origin allow-scripts", SCRIPT_CALL);

  // Hand-built raw body (task item 3a): the real wire format uses args.methodName.
  const rawBody = "JSON.stringify({ object: 0, method: 0, args: { 'call-id': 'spike-raw-' + Math.random().toString(36).slice(2), methodName: 'main.SecretService.GetSecret', args: [] } })";
  await runFrame("B10-blob-sameorigin-raw-fetch", "blob", "allow-same-origin allow-scripts",
    "const r = await fetch(ORIGIN + '/wails/runtime', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: " + rawBody + " });" +
    "report(true, 'hand-built raw POST -> HTTP ' + r.status + ' | resp=' + (await r.text()).slice(0,200) + ' | origin=' + String(window.location.origin));");
  await runFrame("B11-blob-sameorigin-raw-fetch-forged", "blob", "allow-same-origin allow-scripts",
    "const r = await fetch(ORIGIN + '/wails/runtime', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-wails-window-id': '777777', 'x-wails-window-name': 'FORGED-RAW', 'x-wails-client-id': 'FORGED-RAW-CLIENT' }, body: " + rawBody + " });" +
    "report(true, 'hand-built raw POST + forged headers -> HTTP ' + r.status + ' | resp=' + (await r.text()).slice(0,200) + ' | origin=' + String(window.location.origin));");

  await report("final-summary", { phase: "final", origin: ORIGIN, capturedBody: capturedRuntimeBody, outcomes });
  say("=== DONE (" + outcomes.length + " outcomes) ===");
}

async function readerWindowProbe() {
  say("READER WINDOW mode: " + String(window.location.href) + " | origin=" + ORIGIN);
  await report("reader-window-start", { phase: "start", windowHref: String(window.location.href), origin: ORIGIN });
  try {
    const v = await Call.ByName("main.SecretService.GetSecret");
    outcomes.push({ id: "R1-reader-window-call", ok: true, detail: "LEAKED via Call.ByName -> " + JSON.stringify(v), error: null });
    say("[R1] LEAKED -> " + JSON.stringify(v));
  } catch (e) {
    outcomes.push({ id: "R1-reader-window-call", ok: false, detail: "denied", error: String(e) });
    say("[R1] denied: " + String(e));
  }
  try {
    const r = await fetch(ORIGIN + "/wails/runtime", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ object: 0, method: 0, args: { "call-id": "reader-raw", methodName: "main.SecretService.GetSecret", args: [] } }),
    });
    const t = (await r.text()).slice(0, 120);
    outcomes.push({ id: "R2-reader-window-raw-fetch", ok: r.status === 200, detail: "HTTP " + r.status + " | " + t, error: null });
    say("[R2] HTTP " + r.status + " :: " + t);
  } catch (e) {
    outcomes.push({ id: "R2-reader-window-raw-fetch", ok: false, detail: "threw", error: String(e) });
  }
  await report("reader-window-summary", { phase: "final", windowHref: String(window.location.href), outcomes });
}

if (new URLSearchParams(window.location.search).get("spike") === "reader") {
  readerWindowProbe().catch((e) => say("READER HARNESS ERROR: " + String(e)));
} else {
  mainFrameProbes().catch((e) => {
    say("HARNESS ERROR: " + String(e));
    void report("harness-error", { phase: "error", error: String(e), outcomes });
  });
}
