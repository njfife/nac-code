#!/usr/bin/env node
// =============================================================================
// Tracer-bullet spike: CROSS-PROVIDER CONTEXT PORTABILITY
// =============================================================================
// Proves the super-hard requirement end to end:
//   1. capture real turns from an AGENTIC provider (Claude CLI, which holds its
//      own native session) into a PROVIDER-NEUTRAL transcript;
//   2. replay that transcript into a STATELESS local model (LM Studio) via the
//      universal buildContext() path;
//   3. confirm the local model recalls FIRST-MESSAGE content ACROSS the switch.
//
// It also runs a NEGATIVE CONTROL that reproduces the t3code bug: ask the local
// model the same recall question WITHOUT replaying the transcript. That must
// FAIL to recall — proving the pass is due to our transcript replay, not luck.
//
// Throwaway. Zero dependencies (Node 18+ global fetch). Not the architecture —
// just enough to validate the core idea before we spec M0-1/M0-8.
//
//   node spike.mjs              # full run: capture from Claude, replay into LM Studio
//   node spike.mjs --synthetic  # skip Claude; use a canned transcript (tests the LM Studio half only)
//
// Env overrides:
//   LMSTUDIO_URL   (default http://localhost:1234/v1)
//   LMSTUDIO_MODEL (default: first model reported by /v1/models)
//   CLAUDE_BIN     (default: claude)
// =============================================================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

const CODEWORD = 'BANANAPHONE-7731'; // unique token → recall can't be coincidence
const LMSTUDIO_URL = (process.env.LMSTUDIO_URL || 'http://localhost:1234/v1').replace(/\/$/, '');
const LMSTUDIO_MODEL = process.env.LMSTUDIO_MODEL || null;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const SYNTHETIC = process.argv.includes('--synthetic');
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 1024); // reasoning models (Qwen3) need room to finish thinking AND answer

const FIRST_MSG = `Remember this codeword for later: ${CODEWORD}. Reply with only: ok`;
const FILLER_MSG = 'What is 2+2? Reply with only the number.';
const RECALL = 'What was the exact codeword I gave you in my very first message? Reply with only the codeword.';

// ---------------------------------------------------------------------------
// PROVIDER-NEUTRAL TRANSCRIPT — the architecture's single source of truth.
// Minimal here (text turns only). Real impl also carries tool calls/results in
// a portable form; flattening those into context is the next thing to validate.
// @typedef {{ role: 'user'|'assistant', content: string }} Turn
// ---------------------------------------------------------------------------

// buildContext: the UNIVERSAL replay path (the method that survives a switch).
// For an OpenAI-compatible stateless provider, "context" = the messages[] array.
function buildContextOpenAI(/** @type {Turn[]} */ transcript, systemPrompt) {
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  for (const t of transcript) msgs.push({ role: t.role, content: t.content });
  return msgs;
}

// ---------------------------------------------------------------------------
// PROVIDER A (agentic): drive Claude CLI for 2 turns, capture into a transcript.
// Claude keeps its OWN context across the two turns via --resume <session_id>;
// we capture the text turns into the neutral transcript (NOT Claude's session).
// ---------------------------------------------------------------------------
async function claudeTurn(prompt, sessionId) {
  const args = ['-p', prompt, '--output-format', 'json'];
  if (sessionId) args.push('--resume', sessionId);
  const { stdout } = await execFileP(CLAUDE_BIN, args, { maxBuffer: 16 * 1024 * 1024 });
  const json = JSON.parse(stdout); // claude -p --output-format json → { result, session_id, ... }
  return { text: String(json.result ?? '').trim(), sessionId: json.session_id ?? sessionId };
}

async function captureFromClaude() {
  console.log('\n[A] Capturing turns from Claude (agentic provider; native session)…');
  const t1 = await claudeTurn(FIRST_MSG);
  console.log(`    turn 1  claude: "${t1.text}"   (session ${t1.sessionId})`);
  const t2 = await claudeTurn(FILLER_MSG, t1.sessionId);
  console.log(`    turn 2  claude: "${t2.text}"`);
  return [
    { role: 'user', content: FIRST_MSG },
    { role: 'assistant', content: t1.text },
    { role: 'user', content: FILLER_MSG },
    { role: 'assistant', content: t2.text },
  ];
}

function syntheticTranscript() {
  console.log('\n[A] --synthetic: using a canned transcript (skipping Claude capture).');
  return [
    { role: 'user', content: FIRST_MSG },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: FILLER_MSG },
    { role: 'assistant', content: '4' },
  ];
}

// ---------------------------------------------------------------------------
// PROVIDER B (stateless local): LM Studio, OpenAI-compatible. We own messages[].
// ---------------------------------------------------------------------------
async function lmStudioModel() {
  if (LMSTUDIO_MODEL) return LMSTUDIO_MODEL;
  const r = await fetch(`${LMSTUDIO_URL}/models`);
  if (!r.ok) throw new Error(`LM Studio GET /models → ${r.status}. Is the LM Studio server running?`);
  const j = await r.json();
  const id = j.data?.[0]?.id;
  if (!id) throw new Error('LM Studio has no model loaded. Load one and start the server.');
  return id;
}

async function lmStudioChat(messages, model) {
  const r = await fetch(`${LMSTUDIO_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens: MAX_TOKENS, stream: false }),
  });
  if (!r.ok) throw new Error(`LM Studio POST /chat/completions → ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const choice = j.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  // Reasoning models (Qwen3) may emit <think> tokens and/or split the answer into
  // a separate reasoning_content field. For "did the context reach the model?", check the FULL output.
  let text = String(msg.content ?? '').trim();
  if (!text && msg.reasoning_content) text = String(msg.reasoning_content).trim();
  if (!text) console.log(`    [debug] empty output; finish_reason=${choice.finish_reason}; message keys=${Object.keys(msg).join(',')}`);
  return text;
}

const recalls = (s) => s.toUpperCase().includes(CODEWORD);

async function main() {
  console.log('=== Cross-provider context portability spike ===');
  console.log(`codeword=${CODEWORD}   lmstudio=${LMSTUDIO_URL}`);

  // 1) capture from agentic provider (or synthetic)
  const transcript = SYNTHETIC ? syntheticTranscript() : await captureFromClaude();

  // 2) pick the local model
  const model = await lmStudioModel();
  console.log(`\n[B] LM Studio model: ${model}`);

  // 3) CONTROL — the t3code bug: recall WITHOUT replaying the transcript
  const controlAns = await lmStudioChat(
    buildContextOpenAI([], null).concat({ role: 'user', content: RECALL }),
    model,
  );
  const controlKnows = recalls(controlAns);
  console.log(`\n[control: no replay]  LM Studio: "${controlAns.slice(0, 300)}"`);
  console.log(`                      recalls codeword? ${controlKnows}   (expected: false — the bug)`);

  // 4) TEST — our fix: replay the neutral transcript across the provider switch, then recall
  const testAns = await lmStudioChat(
    buildContextOpenAI(transcript, null).concat({ role: 'user', content: RECALL }),
    model,
  );
  const testKnows = recalls(testAns);
  console.log(`\n[test: Claude→LM Studio replay]  LM Studio: "${testAns.slice(0, 300)}"`);
  console.log(`                      recalls codeword? ${testKnows}   (expected: true — context crossed providers)`);

  // 5) verdict
  const pass = testKnows && !controlKnows;
  console.log(`\n=== ${pass ? 'PASS ✅' : 'FAIL ❌'} ===`);
  console.log(
    pass
      ? 'Context survived a Claude → LM Studio switch via the provider-neutral transcript, and does NOT\n'
        + 'survive without it. The core of M0-8 (transcript-as-source-of-truth + buildContext replay) holds.'
      : `knows(test)=${testKnows} knows(control)=${controlKnows}. If test=false: model may be too small to\n`
        + 'follow the codeword, or LM Studio prompt formatting differs — try a bigger model or inspect the\n'
        + 'messages. If control=true: contamination — pick a more unique codeword.',
  );
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nspike error: ${e.message}`);
  if (!SYNTHETIC && /claude|ENOENT|session|resume|JSON/i.test(e.message)) {
    console.error('Hint: Claude capture failed. Verify `claude` is installed + authed and supports');
    console.error('      `claude -p "…" --output-format json` / `--resume <id>`. Or run with --synthetic');
    console.error('      to validate the LM Studio replay half independently.');
  }
  process.exit(2);
});
