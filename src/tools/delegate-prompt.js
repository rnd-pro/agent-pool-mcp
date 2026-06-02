/**
 * Build the final delegated-agent prompt in the required orchestration order.
 * @param {object} input
 * @returns {string}
 */
export function buildDelegatePrompt(input = {}) {
  let {
    resolvedMode,
    modeNotice,
    scopeNotice,
    resolvedContextPackage,
    agentContext,
    prompt,
  } = input;

  let promptParts = [`[Agent Mode: ${String(resolvedMode || '').toUpperCase()}] ${modeNotice || ''}`];
  if (scopeNotice) promptParts.push(scopeNotice);
  if (resolvedContextPackage) promptParts.push(resolvedContextPackage);
  if (agentContext) {
    let contextPrecedence = resolvedContextPackage
      ? 'Context routing note: role instructions in this section do not override [Resolved Context Package] metadata, focus files, or context-loading policy.'
      : '';
    promptParts.push(`[Agent Context]\n${[contextPrecedence, agentContext].filter(Boolean).join('\n\n')}\n[/Agent Context]`);
  }
  promptParts.push(prompt || '');
  return promptParts.join('\n\n');
}
