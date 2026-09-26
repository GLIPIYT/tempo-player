# Repository guidance

## UI text

- Keep interface copy short and useful. Every heading, label, hint, and empty state must help the user understand a control or make a decision.
- Avoid decorative or generic descriptions, repeated information, and placeholder marketing phrases. Prefer the control and its value when they explain themselves.
- In previews and finished screens alike, use real product labels and minimal sample content. Review new text and remove anything that does not improve clarity.

## Task planning

- Before starting any task, including a microtask, bug fix, or documentation change, add it to `.task-plans/DD.MM.YY plan.md` using the local date and filename format (for example, `26.09.26 plan.md`).
- Keep one plan file per local calendar date and append every new task below the previous entries in that file. Do not replace or delete earlier task entries.
- Give each task its own clearly named topic and local start time (`Asia/Yekaterinburg`). Record its goal, relevant files or actions, verification approach, and final result including commit/push status.
- Keep `.task-plans/` ignored by Git; daily plans are local working notes and must not be committed.

## Development preview

- After code changes, keep the Tauri development player running so the user can review the result. Reuse the current `npm run tauri dev` session and its hot reload when it is already active; start it from the project root if it is not. Confirm that both the Vite dev server and the `target/debug/tempo.exe` process are running. Leave them open unless the user asks to stop them.

## Release notes

- Keep the release notes in English first and Russian second. Finish the complete English section before starting the Russian one.
- For every release, compare the previous published tag with the new tag. Review the commits and relevant diffs, then cover every user-visible feature, improvement, fix, and important documentation or packaging change. Group related changes, but do not reduce the release to only its headline features.
- Give enough detail for a user to understand what changed, where it appears, and any verified limitation or prerequisite. Avoid implementation details that do not affect users. Never claim an unverified feature, fix, test result, or compatibility guarantee.
- Keep the English and Russian sections structurally parallel and factually complete. Translate naturally; do not shorten the Russian section.
- Use only verified version numbers, asset names, and download links. Include known issues only when they have been confirmed.
- Save a copy of each published release note as `docs/releases/v<VERSION>.md` so the repository keeps its release history.
- The release workflow creates the GitHub release body from the annotated tag message. For a new release, put the finished bilingual notes in the tag annotation. To correct an already published release, update it with `gh release edit <TAG> --notes-file docs/releases/v<VERSION>.md`, then read the release back and confirm its body.

### Release notes template

Replace the bracketed prompts, include every section that has confirmed content, and keep the same sections and level of detail in both languages.

```markdown
# Tempo v<VERSION>

## English

### Release overview

[Summarize the release in a short, informative paragraph.]

### New features

#### [Feature name]

- **[What was added].** [Explain what users can do and where to find it.]
- **[Related behavior or option].** [Describe the important details, requirements, and limits.]

### Improvements

- **[Area improved].** [Describe the previous behavior and the user-visible improvement.]

### Fixes and reliability

- **[Problem fixed].** [Describe when it happened and the corrected behavior.]

### Documentation and packaging

- [List meaningful documentation, setup, or release-package changes.]

### Known issues

- [Include only confirmed issues that affect this release; omit this section if there are none to report.]

### Download

- **[Platform and architecture]:** [link to the verified release asset]

## Русский

### О релизе

[Кратко и содержательно опишите релиз.]

### Новые возможности

#### [Название функции]

- **[Что добавлено].** [Объясните, что теперь доступно пользователю и где это найти.]
- **[Связанное поведение или настройка].** [Опишите важные детали, требования и ограничения.]

### Улучшения

- **[Что улучшено].** [Опишите прежнее поведение и заметное для пользователя изменение.]

### Исправления и стабильность

- **[Что исправлено].** [Уточните, при каких условиях возникала проблема и как теперь ведёт себя приложение.]

### Документация и сборка

- [Перечислите важные изменения документации, установки или пакета релиза.]

### Известные проблемы

- [Укажите только подтверждённые проблемы этого релиза; если сообщать нечего, раздел не добавляйте.]

### Скачать

- **[Платформа и архитектура]:** [ссылка на проверенный файл релиза]
```
