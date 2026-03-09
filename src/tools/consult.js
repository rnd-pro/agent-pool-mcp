/**
 * Peer consultation — consult_peer tool for architectural consensus.
 *
 * @module agent-pool/tools/consult
 */

import { runGeminiHeadless } from '../runner/gemini-runner.js';

const PEER_REVIEW_SYSTEM_PROMPT = [
  'You are a senior software architect participating in a peer review session.',
  'Another AI agent (Antigravity/Claude) is proposing a technical approach.',
  'Your role is to critically evaluate the proposal and work toward consensus.',
  '',
  'RESPONSE FORMAT (strict):',
  '## Verdict: [AGREE | SUGGEST_CHANGES | DISAGREE]',
  '',
  '## Reasoning',
  '[Your detailed technical analysis]',
  '',
  '## Concerns (if any)',
  '[List specific technical concerns]',
  '',
  '## Suggested Changes (if verdict is not AGREE)',
  '[Specific actionable modifications]',
  '',
  '## Final Assessment',
  '[1-2 sentence summary of your position]',
  '',
  'RULES:',
  '- Be concise but thorough',
  '- Focus on architecture, performance, maintainability, and correctness',
  '- If the proposal is solid, AGREE and explain why',
  '- If you suggest changes, be specific about what and why',
  '- Consider the project conventions: Node.js, ESM, JSDoc, no TypeScript, modular structure',
  '- Respond in the same language as the proposal (Russian or English)',
].join('\n');

/**
 * Consult a Gemini peer agent for architectural review.
 *
 * @param {object} args
 * @param {string} args.context - Project context
 * @param {string} args.proposal - Technical proposal
 * @param {string} [args.previous_rounds] - Previous discussion
 * @param {string} [args.cwd] - Working directory
 * @param {string} [args.model] - Model ID
 * @param {string} defaultCwd - Default working directory
 * @returns {Promise<{content: Array<{type: string, text: string}>}>}
 */
export async function consultPeer(args, defaultCwd) {
  const parts = [
    PEER_REVIEW_SYSTEM_PROMPT,
    '',
    '--- CONTEXT ---',
    args.context,
    '',
    '--- PROPOSAL ---',
    args.proposal,
  ];

  if (args.previous_rounds) {
    parts.push(
      '',
      '--- PREVIOUS DISCUSSION ---',
      args.previous_rounds,
      '',
      'Based on the previous rounds, evaluate the UPDATED proposal above.',
      'If your concerns have been addressed, respond with AGREE.',
    );
  }

  const result = await runGeminiHeadless({
    prompt: parts.join('\n'),
    cwd: args.cwd ?? defaultCwd,
    model: args.model,
    approvalMode: 'plan',
    timeout: 120,
    taskId: 'peer-consult',
  });

  const response = result.response ?? result;

  return {
    content: [{
      type: 'text',
      text: typeof response === 'string' ? response : JSON.stringify(response, null, 2),
    }],
  };
}
