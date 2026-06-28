---
name: ai-system-prompt-builder
description: Create, rewrite, audit, or compress high-quality system prompts and agent instructions for external AI assistants, especially Chinese AI models such as Kimi, DeepSeek, Qwen, Doubao, Wenxin, and Zhipu/GLM. Use when the user asks to make a system prompt, agent prompt, custom assistant instruction, behavior spec, safety/style policy, or domestic-model-adapted prompt from scratch or from an existing prompt file.
station: [produce, agent]
kind: instruction
version: 1
---

# AI System Prompt Builder

## Purpose

Create practical system prompts for external AI products. Optimize for prompts that are clear, portable, and useful in real model products rather than long, fragile rule dumps.

## Workflow

1. Identify the target surface: chat UI first message, API `system` field, custom agent/GPT instruction, workflow bot, or model-specific prompt.
2. Identify the target model family when known: Kimi, DeepSeek, Qwen, Doubao, Wenxin, Zhipu/GLM, OpenAI-compatible, Claude-like, or unknown.
3. Choose a length:
   - **compact**: short, pasteable, stable; load `references/compact-cn.md`.
   - **detailed**: stronger guardrails and richer behavior; load `references/detailed-cn.md`.
   - **custom**: combine sections relevant to the user's use case.
4. Produce a prompt with clear sections. Prefer Chinese if the user is working in Chinese.
5. Remove claims about being copied, extracted, or derived from any proprietary system prompt.
6. If adapting an existing prompt, preserve the user's intent, remove redundancy, resolve conflicts, and make model-specific constraints explicit.
7. Include a short usage note for where to put it and what variables/placeholders to fill.

## Design Rules

- Keep the prompt hierarchical but not bureaucratic. Good sections: identity, tone, formatting, knowledge/search policy, safety/refusal boundaries, output/file behavior.
- Prefer rules that change model behavior. Avoid filler such as "be helpful" unless it anchors a specific behavior.
- Distinguish hard constraints from style preferences.
- Make search/current-information rules explicit when the model has tools.
- For Chinese domestic models: use direct language, fewer nested exceptions, concrete examples.
- Include copyright rules when the assistant may summarize or quote web/search materials.
- Include mental-health, child-safety, weapon/harmful-substance, malware, and legal/financial/medical boundaries for general-purpose assistants.

## Output Format

For a new prompt:
```
# System Prompt
...
## Usage Notes
...
```

For an audit/rewrite:
```
## Diagnosis
...
## Revised Prompt
...
## Integration Notes
...
```

## Quality Checklist

- No hidden dependence on the current session.
- Safety boundaries are clear but not longer than the task needs.
- Formatting instructions match the user's desired output style.
- Search/current-info behavior matches the target model's actual tool access.
- Easy to paste into the user's target platform.
