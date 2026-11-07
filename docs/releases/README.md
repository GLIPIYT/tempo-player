# Release importance

GitHub releases use a version tag, rather than arbitrary issue labels. Tempo reads an optional hidden marker in the release body:

```html
<!-- tempo:release-type=average -->
```

Accepted values are `minor` (small update), `average` (feature update), and `major` (major update). The marker is hidden from the changelog in Tempo. Include it in the saved notes and annotated tag body when preparing a release; use `git tag --cleanup=verbatim` to preserve Markdown and comments.

Without a marker, Tempo compares the release with the previous available version: major component change → major update, minor component change → feature update, patch change → small update. This fallback describes the version change; an explicit marker can classify a release differently.
