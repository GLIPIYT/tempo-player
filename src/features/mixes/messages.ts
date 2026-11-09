export function mixMessage(
  t: (key: string) => string,
  message: string,
): string {
  const count =
    /^Only (\d+) (?:track matches|tracks match) these rules; (\d+) requested\.$/u.exec(
      message,
    )
  if (count)
    return t('Matching tracks: {count} of {total}.')
      .replace('{count}', count[1])
      .replace('{total}', count[2])
  const genres =
    /^Online search covered (\d+) of (\d+) selected genres\.$/u.exec(message)
  if (genres)
    return t('Genres searched online: {count} of {total}.')
      .replace('{count}', genres[1])
      .replace('{total}', genres[2])
  return t(message)
}
