// Reproduction from the user-supplied TUI text. This reference is part of the
// draft, not conversation/project background. Keep it literal in the fixture.
export const screen = ` Preferences
  Focus: Library · 0 frozen snapshots
  Search:
    n Add                           e Edit                          d Delete
  Library 3/17 · 0 selected · s Selected    │ Preview · Enter reads full text
  Prompt rewriting                          │ Prompt Bullet Structure
    [ ] Clarify Prompt Intent       Project │ global · 8d656e43-33ed-4443-b415-d5e45419c87d
    [ ] Neutral Prompt Tone          Global │ Library entry
  › [ ] Prompt Bullet Structure      Global │ Prompt rewriting · manual
    [ ] Prompt Step Structure        Global │ 将需要整理的独立并列要求改为列表；不改变回答格式。
    [ ] Clarify Prompt Intent        Global │
    [ ] Translate Prompt to English  Global │ Prefer a list-based structure when separating
  Task requirements                         │ distinct requirements, questions, constraints, or
    [ ] Answer in Bullet Points     Project │ other points would improve clarity and readability.
  ────────────────────────────────────────────────────────────────────────────────────────────────
  s Selected only · Enter Read
  Esc Back        · Tab / Shift+Tab Focus · / Search `;

export const screenDraft = screen + "右侧的正文部分是不是太靠下了，讨论能否删掉一部分";
export const minimalEditInstruction = `Prompt rewriting instructions (manually selected):
Clarify only references or scope that the supplied draft and context resolve unambiguously. Make the smallest useful edit; keep clear prompts unchanged. Do not add success criteria or repeat background merely to make the prompt standalone. Leave unresolved ambiguity intact and do not add an intent-analysis section.

Prompt rewriting instructions (manually selected):
仅修改 prompt 中妨碍理解的口语表达、含糊措辞和重复内容；清楚的表达保持原样。保留用户语气，不把口语表达一律改成正式文体。`;
