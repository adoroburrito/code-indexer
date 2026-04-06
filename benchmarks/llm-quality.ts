#!/usr/bin/env bun
/**
 * LLM quality benchmark
 *
 * Compares LLM answer quality when context is retrieved via:
 *   A) Full file  — model sees the entire file containing the target symbol
 *   B) code-indexer — model sees only the symbol's source (via `context`)
 *
 * Corpus: colinhacks/zod — uses a fixed set of 20 comprehension tasks
 *
 * Each task: the model is given context + a question about a specific symbol,
 * and must answer accurately. Answers are scored 0–4 by a judge model.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... bun benchmarks/llm-quality.ts [--corpus <path>] [--db <path>]
 *
 * Models:
 *   Subject: claude-haiku-4-5-20251001 (the model being evaluated)
 *   Judge:   claude-sonnet-4-6         (scores the answers)
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { openDb, querySymbols, listSymbols } from '../src/db.js';
import { indexDirectory } from '../src/indexer.js';

// ── Config ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name: string, def: string): string {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
}

const corpusPath = resolve(flag('corpus', 'benchmarks/zod-corpus'));
const dbPath = resolve(flag('db', 'benchmarks/zod.db'));
const SUBJECT_MODEL = 'claude-haiku-4-5-20251001';
const JUDGE_MODEL = 'claude-sonnet-4-6';

// ── Fixed task set ────────────────────────────────────────────────────────────
// Each task: a symbol name + a question about it that requires reading its source.
// Questions are designed so the answer is only correct if the model read the right code.

const TASKS: Array<{ symbol: string; question: string }> = [
  { symbol: 'ZodString', question: 'What validation methods does ZodString expose for URL validation? List them exactly as they appear in the source.' },
  { symbol: 'ZodNumber', question: 'What internal checks does ZodNumber run during parsing? List each check type that appears in the source.' },
  { symbol: 'ZodObject', question: 'What does the `strip` method on ZodObject do, and what does it return?' },
  { symbol: 'ZodArray', question: 'What is the parameter type accepted by ZodArray\'s `min` method?' },
  { symbol: 'ZodUnion', question: 'How does ZodUnion attempt each option during parsing — does it short-circuit on first success or try all?' },
  { symbol: 'ZodEnum', question: 'How does ZodEnum store its values internally? What property holds them?' },
  { symbol: 'ZodOptional', question: 'What does ZodOptional return when the input is undefined — the unwrapped value, undefined, or something else?' },
  { symbol: 'ZodNullable', question: 'What is the difference between ZodNullable and ZodOptional in terms of what inputs they accept?' },
  { symbol: 'ZodDefault', question: 'When does ZodDefault apply its default value — before or after parsing the inner type?' },
  { symbol: 'ZodTuple', question: 'Does ZodTuple support rest elements? If so, how?' },
  { symbol: 'ZodRecord', question: 'What are the two type parameters ZodRecord accepts, and what do they represent?' },
  { symbol: 'ZodEffects', question: 'What are the three kinds of effects ZodEffects supports? Name them as they appear in the source.' },
  { symbol: 'ZodBranded', question: 'What does ZodBranded add to the output type compared to its inner schema?' },
  { symbol: 'ZodPipeline', question: 'What two schemas does ZodPipeline compose, and in what order does it apply them?' },
  { symbol: 'ZodCatch', question: 'When does ZodCatch invoke its catch handler — on any error or only specific ones?' },
  { symbol: 'ZodIntersection', question: 'How does ZodIntersection merge two successful parse results?' },
  { symbol: 'ZodDiscriminatedUnion', question: 'What field does ZodDiscriminatedUnion use to select the correct schema variant?' },
  { symbol: 'ZodSet', question: 'What does ZodSet\'s `size` method do, and what does it return?' },
  { symbol: 'ZodMap', question: 'What are the key and value type parameters in ZodMap, and how are they used during parsing?' },
  { symbol: 'ZodLiteral', question: 'How does ZodLiteral check equality — strict equality, loose equality, or something else?' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function readSymbolSource(db: ReturnType<typeof openDb>, corpusDir: string, symbolName: string): string | null {
  const rows = querySymbols(db, symbolName);
  if (rows.length === 0) return null;
  const row = rows[0];
  try {
    const content = readFileSync(row.abs_path, 'utf-8');
    const lines = content.split('\n');
    return lines.slice(row.start_line - 1, row.end_line).join('\n');
  } catch {
    return null;
  }
}

function readFullFile(db: ReturnType<typeof openDb>, corpusDir: string, symbolName: string): string | null {
  const rows = querySymbols(db, symbolName);
  if (rows.length === 0) return null;
  const row = rows[0];
  try {
    return readFileSync(row.abs_path, 'utf-8');
  } catch {
    return null;
  }
}

async function askSubject(client: Anthropic, context: string, question: string): Promise<string> {
  const msg = await client.messages.create({
    model: SUBJECT_MODEL,
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `Here is some source code:\n\n\`\`\`typescript\n${context}\n\`\`\`\n\nQuestion: ${question}\n\nAnswer concisely and precisely based only on the source code above.`,
    }],
  });
  return msg.content.map(b => b.type === 'text' ? b.text : '').join('');
}

async function judgeAnswer(client: Anthropic, question: string, groundTruth: string, answer: string): Promise<number> {
  const msg = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `You are grading an answer to a source code comprehension question.

Question: ${question}

Reference answer (from reading the actual source): ${groundTruth}

Student answer: ${answer}

Score the student answer 0–4:
  4 = completely correct and precise
  3 = mostly correct, minor omissions or imprecision
  2 = partially correct, significant gaps or errors
  1 = minimal correct content
  0 = wrong or irrelevant

Reply with ONLY a single digit (0, 1, 2, 3, or 4).`,
    }],
  });
  const text = msg.content.map(b => b.type === 'text' ? b.text : '').join('').trim();
  return parseInt(text[0] ?? '0', 10);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Set ANTHROPIC_API_KEY to run this benchmark.');
    process.exit(1);
  }

  if (!existsSync(corpusPath)) {
    console.error(`Corpus not found: ${corpusPath}`);
    console.error('Run: git clone --depth=1 https://github.com/colinhacks/zod benchmarks/zod-corpus');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  // Index (or reuse existing db)
  process.stderr.write('Indexing corpus...\n');
  const db = openDb(dbPath);
  await indexDirectory(db, corpusPath, corpusPath, {
    onStatusUpdate: (msg) => process.stderr.write(msg + '\r'),
  });
  process.stderr.write('\n');

  // Ground truth: get answers from reading just the symbol source (gold standard)
  process.stderr.write('Generating ground truth from symbol source...\n');
  const groundTruths: Map<string, string> = new Map();
  for (const task of TASKS) {
    const source = readSymbolSource(db, corpusPath, task.symbol);
    if (!source) {
      process.stderr.write(`  warning: symbol ${task.symbol} not found, skipping\n`);
      continue;
    }
    groundTruths.set(task.symbol, await askSubject(client, source, task.question));
    process.stderr.write(`  ground truth: ${task.symbol}\n`);
  }

  // Evaluate full-file approach
  process.stderr.write('\nEvaluating full-file approach...\n');
  const fullFileScores: number[] = [];
  for (const task of TASKS) {
    if (!groundTruths.has(task.symbol)) continue;
    const fullFile = readFullFile(db, corpusPath, task.symbol);
    if (!fullFile) continue;
    const answer = await askSubject(client, fullFile, task.question);
    const gt = groundTruths.get(task.symbol)!;
    const score = await judgeAnswer(client, task.question, gt, answer);
    fullFileScores.push(score);
    process.stderr.write(`  ${task.symbol}: ${score}/4\n`);
  }

  // Evaluate code-indexer approach
  process.stderr.write('\nEvaluating code-indexer approach...\n');
  const indexerScores: number[] = [];
  for (const task of TASKS) {
    if (!groundTruths.has(task.symbol)) continue;
    const source = readSymbolSource(db, corpusPath, task.symbol);
    if (!source) continue;
    const answer = await askSubject(client, source, task.question);
    const gt = groundTruths.get(task.symbol)!;
    const score = await judgeAnswer(client, task.question, gt, answer);
    indexerScores.push(score);
    process.stderr.write(`  ${task.symbol}: ${score}/4\n`);
  }

  db.close();

  const avg = (nums: number[]) => nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length) : 0;

  const fullFileAvg = avg(fullFileScores);
  const indexerAvg = avg(indexerScores);

  console.log('');
  console.log(`Subject model: ${SUBJECT_MODEL}`);
  console.log(`Judge model:   ${JUDGE_MODEL}`);
  console.log(`Tasks:         ${fullFileScores.length}`);
  console.log(`Scoring:       0–4 per task (judged by ${JUDGE_MODEL})`);
  console.log('');
  console.log('Approach          Score    Tasks');
  console.log('────────────────  ──────   ─────');
  console.log(`Full file         ${fullFileAvg.toFixed(2)}/4   ${fullFileScores.length}`);
  console.log(`code-indexer      ${indexerAvg.toFixed(2)}/4   ${indexerScores.length}`);
  console.log('');
  console.log(`Δ = ${(indexerAvg - fullFileAvg).toFixed(2)} (code-indexer vs full-file)`);
}

main().catch(e => { console.error(e); process.exit(1); });
